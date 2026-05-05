# SYNC_BACKEND_PLAN — синхронизация Web-Планшет → UPSELLER

> Цель: заменить путь «подборщик → Sheets-Планшет → `runFullUpdate` (KorobyService_2) → UPSELLER» на «подборщик → web-планшет (`/podbor/`) → backend → UPSELLER напрямую». Лист `ПОДБОР` Планшета как промежуточный носитель данных уходит из контура. GAS-сценарий `runFullUpdate` повторяется в node-/Netlify-функциях.

## 1. Резюме

В `Podbor/local-dev/server.js` уже есть атомы (`box.set_layout`, `ship.create`, `ship.delete`, `box.inventory_correction`), но они пишут только в **mock in-memory**. Финализации заявки нет вовсе. Цель — добавить **writer-слой к UPSELLER + ПОДБОРЫ + НАЧИСЛЕНИЯ**, повторяющий 4-шаговую транзакцию `runFullUpdate` (КОРОБЫ + ОТГ + НАЧ + БД), и эндпоинт `finalize`, который её запускает. Минимально-работающий результат — нажатие «Завершить заявку» в web-планшете приводит к ровно тем же изменениям в Sheets, что и текущая работа на Sheets-Планшете.

## 2. Текущее состояние

### 2.1 Что хранится в memory (server.js)

```
boxLayoutStore: Map<boxId, {
  barcodes: { [barcode]: { kolPodb, kudaPodb, kolPerem, kudaPerem } },
  updatedAt, by
}>

shipBoxStore: Map<zayavkaId, {
  boxes: [{ number: 'S1294-001', short: 1, taraType: 'К_1.0',
            status: 'open', createdAt, createdBy }],
  nextSeq
}>

inventoryOverrides: Map<'boxId|barcode', newQty>     // микро-инвент
inventoryAuditLog:  [{ boxId, barcode, oldQty, newQty, reason, by, ts }]
shipBoxQRCache:     Map<number, dataUrl>              // QR кэш этикеток
```

Все эти данные живут только в процессе ноды и теряются при рестарте. Кэш `clientBoxesCache` (60 с) — read-side от UPSELLER.

### 2.2 Что делает GAS `KorobyService_2` (прозой)

Триггер: чекбокс `ЗАЯВКА!H1` на Планшете → `runFullUpdate`. Источник правды для расчёта — лист `РАСЧЁТ` Планшета (формулы из `ПОДБОР`-полотна выдают 9 нарезанных блоков: `IZYATIE_KOROB`, `NOV_QTY`, `NOV_ADRES`, `PEREM_V_YACH`, `SOZD_YACH`, `KOROBA_OTGRUZ`, `NACHISL`, `LOG_VR`, `DATA_OTG`).

Жизненный цикл `runFullUpdate`:
1. Читает `РАСЧЁТ` + `ЗАЯВКА!C2/K3/K4`.
2. Валидации (`zayavkaId` не пуст, `qty>0`, для S-заявок строка в `🚚 ОТГ.L` существует и `🚚 ОТГ.BC` непустой).
3. Считает в памяти `updates`/`newRows` против `🍬 КОРОБЫ` (ключ `D|U` = `номер_короба|баркод`).
4. Snapshot старых значений ⇒ rollback при провале.
5. **4 шага транзакции в фиксированном порядке**:
   - `🍬 КОРОБЫ`: batch `setValues` для updates + `setValues` append для newRows.
   - `🚚 ОТГ`: правка одной строки (`O..T` + `BC`). Логика повторного подбора по `BC=='СОЗДАНО'`.
   - `НАЧИСЛЕНИЯ.НАЧ`: append массива из `NACHISL`.
   - `ПОДБОРЫ.БД`: правка `G/O/U/V` строки заявки (`F` = ключ).
6. После успеха — sort `🍬 КОРОБЫ` по T (пустые вниз).
7. Пишет в `ПОДБОРЫ.ВР` строку отчёта (insert before row 4, новейшее сверху) с чек-листом ✅/❌/🔄/➖.

R-заявки (перемаркировка) — без шага `🚚 ОТГ`. R-поток в `KorobyService_2` существует, но реальная перемаркировка делается отдельным GAS-проектом `ПЕРЕМ` через таблицу ПЕРЕМАРКИРОВКА (см. CONST/03 § 6 «ПЕРЕМ»). Для web-Подборов нас интересуют **только S-заявки** на первом этапе.

`dailyCorobyArchiv()` (триггер ежедневно, отдельная история) переносит коробы со статусами `ИЗЪЯТО/СПИСАНО/ОТГРУЖЕНО` → таблица `АРХИВ КОРОБОВ.2026`. Не трогаем — продолжает работать в GAS.

### 2.3 Что НЕ делает наш web-app

- Не пишет ничего в `🍬 КОРОБЫ` (статусы, qty, адреса, новые строки).
- Не пишет в `🚚 ОТГ` (O/P/Q/R/S/T/BC).
- Не создаёт строки в `НАЧИСЛЕНИЯ.НАЧ`.
- Не правит `ПОДБОРЫ.БД` (`G/O/U/V`) — заявка не закрывается.
- Не пишет отчёт в `ПОДБОРЫ.ВР`.
- Создаёт коробы отгрузки **только в memory**, в `🍬 КОРОБЫ` они не появляются.
- Не реализует rollback / атомарность.
- Не имеет идемпотентности при повторных запросах.

---

## 3. Сценарии «действие пользователя → запись в UPSELLER»

Общая модель источника данных (важно): в отличие от GAS, у web нет промежуточного `РАСЧЁТ`. Backend **сам собирает 4 структуры** по той же логике, что GAS-формулы, но из:
- `boxLayoutStore` (что-куда подборщик разложил),
- `shipBoxStore` (созданные коробы отгрузки),
- `inventoryOverrides` + `inventoryAuditLog` (микро-инвент),
- активной заявки (получаем из `БД_ЭКСП.A:P` и парсим `J`/`K3` лог).

**Ключ строки в `🍬 КОРОБЫ`** для апдейтов: `D + "_" + U` (`номер_короба` + `баркод`). Backend строит индекс при чтении.

### 3.1 «Разложить N штук на отгрузку» (`КОЛ ПОДБ + КУДА ПОДБ`)

**Триггер**: пользователь нажимает «Сохранить» в `BoxModal` → клиент шлёт `box.set_layout`.

**Payload**:
```json
{
  "type": "box.set_layout",
  "zayavkaId": "S1294-Видинеева",
  "boxId": "K10234",
  "barcodes": {
    "4607123456789": { "kolPodb": 5, "kudaPodb": "S1294-001", "kolPerem": 0, "kudaPerem": "" }
  }
}
```

**Действие на этапе атома**: только обновить mem-store (как сейчас) + поставить флаг `dirty=true` для заявки. **Запись в UPSELLER не происходит атомом — она происходит только при `finalize` заявки** (см. § 3.7). Это намеренная упрощённая модель: в GAS тоже все правки накапливаются в полотне `ПОДБОР` и попадают в Sheets только при `runFullUpdate`.

**Что произойдёт при finalize** (для строк, у которых `kolPodb > 0`):
- В `🍬 КОРОБЫ` найти строку по ключу `boxId|barcode`.
- Если `kolPodb < qty` (изъятие части): создать **новую строку** для изъятой части — копия исходной, в которой:
  - `D` ← `kudaPodb` (короб отгрузки `S<NNNN>-XXX`),
  - `E` ← `СОБРАНО`,
  - `F` ← `zayavkaId`,
  - `I` ← `kolPodb`,
  - `J` ← (адрес целевой — пустой / адрес склада упаковки, см. § 5),
  - `M/N` ← переносятся (опционально, как у GAS),
  - `B` ← тара короба-получателя (берём из `shipBoxStore[zayavkaId]`),
  - остальные колонки (тип/SKU/MP/клиент/баркод) — копируются из источника.
- В исходной строке `I` ← `qty - kolPodb - kolPerem` (или 0).
- Если новый остаток в источнике = 0 → очистить всю строку `B:U` исходника (qty=0 = удаление).

**Проверки перед записью**:
- `kolPodb + kolPerem ≤ qty` (или `НОВ КОЛ`, если был микро-инвент).
- `kudaPodb` существует в `shipBoxStore[zayavkaId]`.
- Сумма `kolPodb` по всем строкам с этим `barcode` ≤ `available_for_picking(barcode, client)` И ≤ `requested(barcode)` из `БД_ЭКСП.J`.

**Конфликт**: если строка `boxId|barcode` в `🍬 КОРОБЫ` пропала / qty изменилось vs ожидаемого → throw `ROW_DRIFT`, finalize не идёт, ВР пишет `❌ ROW_DRIFT: ...`. Лечится force-reload `/api/load`.

### 3.2 «Разложить N штук на перемещение в ячейку» (`КОЛ ПЕРЕМ + КУДА ПЕРЕМ`)

**Триггер**: тот же `box.set_layout`, поле `kolPerem > 0`, `kudaPerem` = код ячейки (тара `ЯЧ`).

**При finalize** (для строк с `kolPerem > 0`):
- Сценарий A — целевая ячейка существует в `🍬 КОРОБЫ` с парой `(kudaPerem, barcode)`:
  - В целевой строке `I` ← `I + kolPerem`.
  - В исходной строке `I` ← остаток (или очистка при 0).
- Сценарий B — целевая ячейка существует, но **другой баркод**:
  - Создать новую строку (`SOZD_YACH` логика):
    - `D` ← `kudaPerem`, `B` ← `ЯЧ`, `E` ← статус ячейки (как у соседних строк ячейки), `T` ← клиент, `U` ← баркод, `I` ← `kolPerem`, остальное — копия источника (тип/SKU/MP/баркод).
- Сценарий C — целевая ячейка не существует (`SOZD_YACH` для новой ячейки): аналогично B, но строка с типом `ЯЧ` в новый виртуальный код.

**Проверки**:
- `kudaPerem` валиден (формат кода ячейки — определяется регуляркой / справочником).
- `kolPodb + kolPerem ≤ qty`.

**Не пишется в `🚚 ОТГ`** — внутреннее перемещение не идёт на отгрузку.

### 3.3 «Полный короб на отгрузку» (`ПОЛН КОРОБ`)

**Триггер**: в `BoxModal` нажат `📦 Весь короб → отгрузка`, выбран `kudaPodb` (один на весь короб). Клиент шлёт `box.set_layout` где для **всех** строк короба: `kolPodb = qty`, `kolPerem = 0`, общий `kudaPodb`.

**Доступность**: фронт уже валидирует через `fullBoxAvailable()` (`requested ≥ qty` для каждого баркода в коробе). Backend дублирует.

**При finalize** для каждой строки этого короба:
- Это spec-случай § 3.1, где `kolPodb == qty`. Эффект:
  - Исходная строка целиком переходит на отгрузку: `D` ← `kudaPodb`, `E` ← `СОБРАНО`, `F` ← `zayavkaId`, `I` ← `qty` остаётся, `B` ← `тара короба отгрузки`. Это **то же самое**, что GAS `IZYATIE_KOROB`: правка той же строки, без создания новой.
- Источника как «отдельной строки» не остаётся — вся строка ушла в отгрузку.

**Проверки**:
- Все строки короба `(kolPodb == qty) AND (общий kudaPodb)`.
- Для каждого баркода: `qty ≤ requested - already_picked_in_other_boxes`.

### 3.4 «Микро-инвент» (`НОВ КОЛ`, `НОВ АДР`)

**Триггер**: `box.inventory_correction` в `BoxModal → MicroInventModal`.

**Payload**: `{ type, boxId, barcode, novKol, oldKol, reason, novAdr? }`.

**Поведение атома (немедленно, до finalize)**: пишет в `inventoryOverrides` + `inventoryAuditLog`, клэмпит существующую раскладку. **В UPSELLER при атоме НЕ пишем** — изменения применятся при finalize вместе с раскладкой. Альтернатива (оптимизация для будущего): применять микро-инвент сразу в Sheets, чтобы синхронизировать видимость для других сессий — но это усложняет rollback, на первом этапе оставляем «пакетно при finalize».

**При finalize** для каждого override:
- `NOV_QTY` сценарий: в строке `boxId|barcode` колонка `I` ← `novKol`. Если `novKol == 0` — очистка всей строки `B:U`.
- `NOV_ADRES` (опционально, если расширим UI на правку адреса): колонка `J` ← `novAdr`.

**Проверки**:
- `novKol >= 0`, целое.
- `reason` рекомендуется (warning если пусто).
- Если на момент finalize в раскладке `kolPodb + kolPerem > novKol` — отклонение (фронт уже клэмпит, но сервер должен снова проверить).

### 3.5 «Создать N коробов отгрузки» (`ship.create`)

**Триггер**: `CreateBoxesModal` → `ship.create`.

**Payload**: `{ type, zayavkaId, count, taraType }` (count 1..200, taraType `К_0.5|К_1.0|ПАЛ`).

**Поведение атома (сейчас)**: добавить в `shipBoxStore[zayavkaId]`, генерировать QR в фоне.

**Опция X (рекомендуется на этапе 4)** — записать **сразу в UPSELLER `🍬 КОРОБЫ`** новые строки с минимальным набором:
- `B` (тара) ← `taraType`, `C` (коэф) ← `0.5/1.0/...`,
- `D` (короб) ← `S<NNNN>-XXX`, `E` (статус) ← `В УПАКОВКЕ` (или `В РЕЗЕРВЕ`),
- `F` (заявка) ← `zayavkaId`,
- `T` (клиент) ← заполняется из заявки,
- `U` — **пусто** (короб ещё пустой; составной ключ `D|U` пока работает как `D|''`).

Преимущество: коробы отгрузки видимы во всех Sheets-инструментах сразу. Минус: в `🍬 КОРОБЫ` уже сейчас GAS-`runFullUpdate` создаёт эти строки через `KOROBA_OTGRUZ` блок только при finalize. Чтобы избежать двойного создания, на первом этапе оставляем коробы только в memory и **создаём строки в `🍬 КОРОБЫ` только при finalize** (как GAS).

**Решение для этапа MVP (этап 4 ниже)**: при finalize по каждому коробу из `shipBoxStore` создать новую строку в `🍬 КОРОБЫ` если по нему есть хотя бы один `kolPodb > 0`. Это `KOROBA_OTGRUZ` логика. Структура строки — см. § 5.4.

**Проверки**:
- `zayavkaId` существует в `БД_ЭКСП`.
- `count` 1..200.
- `taraType ∈ {К_0.5, К_1.0, ПАЛ}` (`ЯЧ` сюда не годится — это для перемещений).

### 3.6 «Удалить пустой короб отгрузки» (`ship.delete`)

**Сейчас**: удаляет из memory если не используется ни в одной раскладке. Никаких записей в Sheets.

**При finalize**: коробы, существующие в `shipBoxStore` но **не используемые** (нет ни одной строки с `kudaPodb == number`), **в `🍬 КОРОБЫ` не создаются** — игнорируются. Это эквивалентно удалению.

### 3.7 «Печать этикеток»

`/api/podbor/ship-labels` — рендер HTML для термопринтера. Никаких записей в Sheets / БД. Оставляем как есть.

### 3.8 «Завершение подбора заявки» (`finalize`) — главное

**Триггер**: новая кнопка в UI «Завершить заявку» (frontend-ёрь не делает; добавить кнопку — отдельная сабтаска фронта). Клиент шлёт:

```json
{
  "type": "podbor.finalize",
  "zayavkaId": "S1294-Видинеева",
  "statusFinal": "СОБРАНО"
}
```

**Логика (повторяет `runFullUpdate`)**:

1. **Acquire lock** — Netlify-blob `podbor-locks/<zayavkaId>` ставится в `LOCKED` с TTL 120 c. Если уже LOCKED — отказ `409 LOCKED_BY_OTHER`.

2. **Чтение источников**:
   - `boxLayoutStore` для всех боксов клиента активной заявки + `inventoryOverrides` + `shipBoxStore[zayavkaId]`.
   - Snapshot `🍬 КОРОБЫ` (`B8:U`) одним `values.get` (UNFORMATTED).
   - Строка заявки в `🚚 ОТГ` (по `L = zayavkaId`).
   - Строка заявки в `ПОДБОРЫ.БД` (по `F`).
   - Строка `БД_ЭКСП` для парсинга `ЛОГ ЗАЯВКИ` и подсчёта uniqueSku.
   - Лист `НАЧ` — только `lastRow` (для append).

3. **Валидация (== § 7 CONST)**:
   - 2.1 `zayavkaId` непустой и есть хоть одна правка (`workCount > 0`).
   - 2.2 `qty > 0` (сумма `kolPodb` по всей раскладке) — нельзя финализировать с нулём собранного.
   - 2.3 `🚚 ОТГ.L` нашлось.
   - 2.4 `🚚 ОТГ.BC` непустое.
   - **Доп. backend-валидации** (которых в GAS нет, но они нужны без формул):
     - все `kudaPodb` соответствуют коробам из `shipBoxStore[zayavkaId]`,
     - для каждого `barcode` Σ `kolPodb` ≤ `min(requested, available)`,
     - все ключи `boxId|barcode` существуют в snapshot.

4. **Расчёт планов записи в памяти** (порты GAS-функции `calculateUpdates`):
   - `updatesKoroby` — точечные `setValues` ячеек.
   - `newRowsKoroby` — append-строки (новые ячейки + новые коробы отгрузки).
   - `otgUpdate` — `O..T + BC` строки `🚚 ОТГ`.
   - `nachAppend` — массив для `НАЧИСЛЕНИЯ.НАЧ` (см. § 5.7).
   - `bdUpdate` — `G/O/U/V` строки в `ПОДБОРЫ.БД` (timestamp + статус).
   - `vrRow` — заготовка для `ПОДБОРЫ.ВР` (см. § 5.6).

5. **Snapshot** старых значений всех затрагиваемых ячеек/строк (для rollback).

6. **Применение** — 4 шага:
   1. `🍬 КОРОБЫ`: один `spreadsheets.values.batchUpdate({valueInputOption:'USER_ENTERED', data: updatesKoroby})` + один `spreadsheets.values.append` для `newRowsKoroby` (или `setValues` после `getLastRow + 1`).
   2. `🚚 ОТГ`: одна `values.batchUpdate` (`O:T` + `BC` строки).
   3. `НАЧИСЛЕНИЯ.НАЧ`: append.
   4. `ПОДБОРЫ.БД`: точечный `values.batchUpdate` для `G/O/U/V` (или `setValues`).
   - При успехе всех 4 — `🍬 КОРОБЫ` сортировка по T desc (на этапе MVP можно пропустить — не критично, но dailyArchiv опирается на сортировку).

7. **При фейле любого шага** — rollback в обратном порядке (БД ← НАЧ ← ОТГ ← КОРОБЫ). Алгоритм идентичен GAS `rollbackChanges` (см. `+ПОДБОРЫ.js:329-381`):
   - БД ← `setValues` старых значений.
   - НАЧ ← удалить append'нутые строки.
   - ОТГ ← `setValues` старых значений.
   - КОРОБЫ ← удалить newRows + `batchUpdate` oldVal для updates.
   - Если rollback сам упал → `🆘 РАССИНХРОН`, статус заявки в БД помечается `🆘`, finalize отклоняется, требуется ручной разбор.

8. **Запись `ПОДБОРЫ.ВР`** (`insertRowsBefore(4, 1)` + `setValues`) с чек-листом (см. § 5.6).

9. **Очистка mem-store** для этой заявки: `boxLayoutStore` очищается для боксов этой заявки, `shipBoxStore[zayavkaId]` удаляется, `inventoryOverrides`/audit для этой заявки — переезжает в перманентный лог (см. § 5.8).

10. **Release lock**.

11. **Ответ клиенту**: `{ ok: true, checklist: { koroby:'✅', otg:'✅', nach:'✅', bd:'✅' }, vrRowNumber: 4, durationMs }`.

---

## 4. API-эндпоинты

Все обёрнуты в `requireUser()` (`web/netlify/functions/_lib/auth.js`). Все принимают только POST (кроме `GET /api/podbor/inventory-log` для отладки).

| Метод | Путь | Назначение | Файл |
|-------|------|-----------|------|
| POST | `/api/podbor/sync` | Универсальный диспетчер атомов (как сейчас). Дополнить новыми типами атомов. | `web/netlify/functions/podbor-sync.js` |
| POST | `/api/podbor/finalize` | Главный — запуск 4-шаговой транзакции для конкретной заявки. | **NEW** `web/netlify/functions/podbor-finalize.js` |
| GET  | `/api/podbor/inventory-log?zayavka=...` | Возвращает аудит микро-инвентов по заявке (для диагностики). | **NEW** `web/netlify/functions/podbor-invent-log.js` |
| GET  | `/api/podbor/preview?zayavka=...` | (опц.) Возвращает «что будет записано» — для шага 1 ниже. | **NEW** опц. |

В `local-dev/server.js` те же пути дублируются. Финализатор и логгер тоже добавляем в server.js.

### 4.1 `POST /api/podbor/sync` — расширение

Атомы остаются как сейчас. Никакие из них **не пишут в UPSELLER в одиночку** до этапа 4 / 5. Список:
- `box.set_layout` — записать раскладку.
- `box.inventory_correction` — микро-инвент.
- `ship.create` — создать коробы отгрузки.
- `ship.delete` — удалить пустой короб.

Авторизация: `requireUser(request)`. Ответ: `{ ok, count, results: [...] }`. Несколько атомов в `updates: [...]` обрабатываются последовательно, ошибка одного не отменяет остальные (multi-status 207).

### 4.2 `POST /api/podbor/finalize` — НОВЫЙ

Payload:
```json
{
  "zayavkaId": "S1294-Видинеева",
  "statusFinal": "СОБРАНО",
  "expectedQty": 247,
  "comment": "..."
}
```

Response success (200):
```json
{
  "ok": true,
  "zayavkaId": "S1294-Видинеева",
  "checklist": { "koroby": "✅", "otg": "✅", "nach": "✅", "bd": "✅" },
  "writes": { "korobyUpdates": 35, "korobyNewRows": 12, "nachRows": 4 },
  "vrRowNumber": 4,
  "durationMs": 2150
}
```

Response error варианты:
- `400 VALIDATION { code, message }` — провал § 3.8.3.
- `409 LOCKED_BY_OTHER { holder, since }` — параллельная сессия.
- `409 ROW_DRIFT { boxId, barcode, expectedQty, actualQty }` — Sheets изменился под нами.
- `500 ROLLBACK_OK { reason, originalError }` — упал шаг, откат успешен.
- `500 DESYNC { reason, errors[] }` — 🆘 рассинхрон отката.

### 4.3 Idempotency

Каждый finalize-запрос несёт `Idempotency-Key` header (UUID на клиенте). Сервер хранит карту `idempotency_key → response` 24 часа в `@netlify/blobs.podbor-idempotency`. Повторный запрос с тем же ключом → возвращаем кэш.

### 4.4 Auth

Все ручки за `requireUser`. В `local-dev/server.js` AUTH_DISABLED оставляем — dev-mode.

---

## 5. Слой записи в Sheets (writer)

### 5.1 OAuth

Используем существующий `web/netlify/functions/_lib/google.js`:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (от `psgl2007@gmail.com`, владельца таблиц).
- Scope нужен `https://www.googleapis.com/auth/spreadsheets` (read-write). **На сейчас** в `local-dev/lib/sheets.js` SA-ключ имеет только `spreadsheets.readonly` — для writer-функций нельзя его использовать. Решение: writer-слой **только через OAuth** (`google.js`) даже в local-dev. Local-dev тогда тоже импортирует `googleapis` через тот же refresh-token (положить `GOOGLE_*` в `Podbor/local-dev/.env`).

### 5.2 Идентификация строки в `🍬 КОРОБЫ`

Snapshot: `spreadsheets.values.get(UPSELLER, "'🍬 КОРОБЫ'!B8:U", UNFORMATTED)`. Индекс `Map<key, rowIndex>` где `key = D + '_' + U`. `rowIndex` — 0-based от строки 8.

Запись через `values.batchUpdate`:
```js
data: [
  { range: "'🍬 КОРОБЫ'!E147", values: [["СОБРАНО"]] },
  { range: "'🍬 КОРОБЫ'!I147", values: [[42]] },
  ...
]
valueInputOption: 'USER_ENTERED'
```

Append (newRows): `values.append` или `values.batchUpdate` с явным `lastRow + 1` диапазоном.

### 5.3 Батчинг

Один `finalize` = **4 отдельных API-вызова** (по числу таблиц/листов):
1. `🍬 КОРОБЫ`: один `batchUpdate` для updates + один `append` для newRows = **2 вызова на лист**.
2. `🚚 ОТГ`: один `batchUpdate`.
3. `НАЧИСЛЕНИЯ.НАЧ`: один `append`.
4. `ПОДБОРЫ.БД`: один `batchUpdate`.

Итого 5 вызовов записи в худшем случае. Read-side: 1 для `🍬 КОРОБЫ`, 1 для `🚚 ОТГ`, 1 для `БД`, 1 для `БД_ЭКСП`, 1 для `НАЧ.lastRow` = 5 чтений. Уложимся в 10 запросов на finalize.

### 5.4 Структура `KOROBA_OTGRUZ` (новая строка короба отгрузки)

При finalize для каждого `S<NNNN>-XXX` короба, который **используется** в раскладке:
```
B (тара)     ← taraType из shipBoxStore
C (коэф)     ← {К_0.5: 0.5, К_1.0: 1.0, ПАЛ: '', ЯЧ: ''}
D (короб)    ← number ('S1294-001')
E (статус)   ← 'В УПАКОВКЕ'
F (заявка)   ← zayavkaId
G (тип)      ← 'УТ ГОТОВ'
H..R         ← '' (агрегат заполнится позже)
S (МП)       ← из заявки (mp)
T (клиент)   ← из заявки (client)
U (баркод)   ← '' (короб как контейнер не имеет одного баркода)
```

**Особенность**: при разложении строки источника частично на отгрузку (`kolPodb < qty`) — мы создаём не «новый короб отгрузки», а «новую строку с тем же баркодом, но другим коробом-получателем». Это `IZYATIE_KOROB` логика.

- `KOROBA_OTGRUZ` (новая строка короба-контейнера, 1 раз на коробку отгрузки `S1294-001`): пустой `U`, статус `В УПАКОВКЕ`.
- `IZYATIE_KOROB` (новая строка изъятого товара): `D = S1294-001`, `U = баркод`, `I = kolPodb`, статус `СОБРАНО`. Это «груз внутри контейнера».

GAS пишет обе. Web должен делать так же.

### 5.5 Логика `🚚 ОТГ` (повтор `updateOtgruzka`)

Читаем `O..S` + `BC`. `isFirstPodbor = (BC == 'СОЗДАНО')`.
- `O` ← `Set(existingO ∪ newBoxesList).sort().join('\n')`.
- `P` ← isFirstPodbor ? `newQty` : `existingP + newQty`.
- `Q` ← `existingQ + newBoxesList.length`.
- `R` ← число строк в `ЛОГ ЗАЯВКИ`. Можно посчитать из `БД_ЭКСП.J` через `parseLogZayavki()`.
- `S` (FF-короба) ← `existingS + countFF`. На MVP `countFF = newBoxesList.length`.
- `T` ← новая запись `ЛОГ ЗАЯВКИ` (что собрано / план / факт по баркодам).
- `BC` ← `statusFinal` (`СОБРАНО` / `ЧАСТИЧНО`).

`newBoxesList` — массив `S1294-001, S1294-002, ...`, использованных в раскладке.

### 5.6 Запись в `ПОДБОРЫ.ВР`

`writeLogToVR` — `insertRowsBefore(4, 1)`, новая строка содержит:
- A: id (max+1).
- B-Y: метаданные заявки (клиент, номер, тайминг, метрики). Часть берётся из `БД_ЭКСП` строки заявки, часть считается на лету (`СОБР = sum(kolPodb)`, `ВСЕГО 📦 = newBoxesList.length`).
- S (status): `statusFinal` или `❌ <ошибка>`.
- Z (лог скрипта): чек-лист 4 процессов + детали в формате
  ```
  ЧЕК-ЛИСТ - ✅ КОРОБЫ - ✅ ОТГРУЖКА - ✅ НАЧИСЛЕНИЯ - ✅ БД
  ---
  ИЗЪЯТИЕ - K10234 - 4607123 - 147 - -> S1294-001
  СОЗДАНИЕ - S1294-001 - - - NEW - ДОБАВЛЕНО
  ...
  ```

Формат идентичен GAS (см. `writeLogToVR` в `+ПОДБОРЫ.js:658`).

### 5.7 Запись в `НАЧИСЛЕНИЯ.НАЧ`

GAS читает блок `NACHISL` из `РАСЧЕТ.EI:ET` (14 кол.) — формулы. Web должен **повторить эту формулу в коде**:

Каждая строка `НАЧ` (1 строка на каждого подборщика-операцию):
```
A: дата (DD.MM.YYYY)
B: смена (определяется по времени? или константа? — нужно уточнить, см. § 8 Открытые вопросы)
C: ФИО подборщика (берём из user)
D: id-заявки
E: клиент
F: «ПОДБОР»
G: кол-во операций
H: расценка за единицу (КС × базовая)
I: итог
J-N: служебно (MP, склад, дата отгр, КС, комментарий)
```

**Рекомендация для MVP (Variant B)**: записать одну агрегатную строку «ПОДБОР заявки X» с count = ΣkolPodb, а детальную раскрытие — позже.

### 5.8 Аудит / лог

В `@netlify/blobs.podbor-audit` пишем по ключу `<zayavkaId>/<finalize-iso-ts>`:
```json
{
  "zayavkaId": "S1294-...",
  "user": "kam2@...",
  "atoms": [...],
  "writes": {
    "korobyUpdates": [...], "korobyNewRows": [...],
    "otgUpdate": {...}, "nachAppend": [...], "bdUpdate": {...},
    "vrRow": [...]
  },
  "checklist": { "koroby": "✅", "otg": "✅", "nach": "✅", "bd": "✅" },
  "duration": 2150,
  "ok": true
}
```

### 5.9 Идемпотентность

- `Idempotency-Key` UUID от клиента → blob-кэш ответа 24 часа.
- На стороне finalize: до начала записи проверяем «уже выполнялось?» — если в `БД_ЭКСП.O` статус заявки = `СОБРАНО` или заявка уже не в `БД_ЭКСП` (закрыта) → отказ `ALREADY_FINALIZED`.
- Lock `podbor-locks/<zayavkaId>` 120 c — защита от параллельных сессий.

---

## 6. Расхождение с GAS

### Что копируем 1-в-1
- 4-шаговая транзакция, порядок шагов, snapshot+rollback.
- Логика `IZYATIE_KOROB`, `NOV_QTY`, `NOV_ADRES`, `PEREM_V_YACH`, `SOZD_YACH`, `KOROBA_OTGRUZ`.
- Ключ `D|U`, qty=0 = удаление, сортировка по T (опц.).
- Логика `🚚 ОТГ` (`isFirstPodbor`).
- Запись в `ВР` с чек-листом.
- Валидации 2.1-2.4.

### Что НЕ копируем (GAS-only)
- **Лист `РАСЧЁТ`** как источник: у нас этот расчёт делается в node-коде.
- **`onEdit` триггеры**, кнопочки `H1` чекбокс на Планшете — в web нет.
- **`LoadClientData`** — у нас уже есть аналог `loadClientBoxes` в `boxes.js`.
- **`ClearForms`** — нечего чистить, web-стейт хранится в memory + blob.
- **Лист `ПОДБОР` Планшета** — обходится полностью.
- **`R-заявки` (перемаркировка)** — в web на этапе MVP не поддерживаем.

### Что есть в GAS, чего нет во фронте → требуется фронт-фича
- **Кнопка «Завершить заявку»** — нужно: новая кнопка в `zayavkaBar` или отдельный экран «Сводка заявки».
- **Indicator статуса заявки** — фронт не показывает, что заявка взята «в работу» нашей сессией. Желательно: при первом `box.set_layout` поднимать `БД_ЭКСП.O` в `В РАБОТЕ`.
- **Индикация ошибок rollback / 🆘** — фронт должен корректно показать `DESYNC` через toast.

---

## 7. Порядок реализации

### Этап 1. Read-only обвязка (~2-4 ч)
**Цель**: backend умеет прочитать всё что нужно для finalize, но **ничего не пишет** в Sheets. Логирует `would-write` payload в console + blob-store.

Что сделать:
- `web/netlify/functions/_lib/podbor/upseller-writer.js` (skeleton) с функциями `readKorobyIndex()`, `readOtgRow(zid)`, `readBdRow(zid)`, `readBdEksp()`.
- `web/netlify/functions/_lib/podbor/calc-updates.js` — порт `calculateUpdates`.
- `POST /api/podbor/preview?zayavka=...` — возвращает результат расчёта, БЕЗ записи.
- В `local-dev/server.js` дублировать тот же endpoint.

**Что проверить**: для тестовой заявки preview возвращает ожидаемые updates/newRows.

**Риск**: scope OAuth. Проверить, что текущий refresh-token работает на write.

### Этап 2. Один сценарий end-to-end: «частичное изъятие на отгрузку» (~4-6 ч)
**Цель**: написать только `🍬 КОРОБЫ` step.

- `upseller-writer.writeKorobyStep(updates, newRows)` — реальный `values.batchUpdate` + `values.append`.
- `POST /api/podbor/finalize` — начало транзакции: lock → preview → writeKorobyStep → blob-аудит.
- Фронт: добавить кнопку «Завершить заявку».

**Что проверить**: исходная строка получила `I = qty - kolPodb`, новая строка появилась с правильными значениями.

### Этап 3. Остальные сценарии в `🍬 КОРОБЫ` (~3-4 ч)
- `box.set_layout` с `kolPerem > 0` → `PEREM_V_YACH` либо `SOZD_YACH`.
- `box.inventory_correction` → `NOV_QTY`.
- `ship.create` → `KOROBA_OTGRUZ`.

### Этап 4. ОТГ + БД + ВР (~2-3 ч)
- `writeOtgStep(otgUpdate)`, `writeBdStep(bdUpdate)`, `writeVrStep(vrRow)`.

### Этап 5. НАЧИСЛЕНИЯ + Idempotency + Audit (~2-3 ч)
- `writeNachStep` — append одной агрегатной строки (Variant B).
- `Idempotency-Key`, `podbor-audit/`, lock-blob.

### Этап 6. Rollback + конфликты + 🆘-обработка (~3-4 ч)
- `takeSnapshot`, `rollbackChanges` (порт GAS).
- Тесты отказов / DESYNC.

### Этап 7. Отказ от mem-store, переход на blob (опционально, ~3 ч)

---

## 8. Риски и открытые вопросы

1. **OAuth scope для записи**. Проверить через test-call. Если нет — `scripts/regenerate-refresh-token.mjs`.
2. **Lock-host в Netlify functions**. Netlify-blobs `consistency: 'strong'` нужен для lock.
3. **Sort `🍬 КОРОБЫ` после finalize** — на MVP можно не сортировать.
4. **Формат `НАЧ` (14 колонок)** — точная семантика B (смена), G (количество ед.), H (расценка) в GAS-формуле `РАСЧЁТ.EI:ET`. Извлечь формулу или MVP-аппроксимация.
5. **Параллельные сессии**. Lock на уровне заявки + UI-индикатор «Заявка занята».
6. **`🚚 ОТГ.S` (FF-короба)**. Что отделяет FF от обычного короба? На MVP `newQtyFF = 0`.
7. **`statusFinal` определение**. «Если ΣkolPodb ≥ Σrequested → СОБРАНО, иначе ЧАСТИЧНО».
8. **Работа без `🚚 ОТГ`-строки**. Чёткое сообщение «обратитесь к логисту».
9. **R-заявки**. Если заявка R — finalize должен **отказать**.
10. **Sheets-rate limit**. Lock на заявку решает race; на client-rate-limit — ретраи с экспон. бэкоффом.

---

## 9. Файлы, которые надо тронуть

### Read-write (модифицировать)
- `web/netlify/functions/podbor-sync.js` — расширить atom-handler.
- `Podbor/local-dev/server.js` — те же атомы + `/api/finalize` + `/api/preview`.
- `Podbor/local-dev/public/podbor/app.js` — кнопка «Завершить заявку», UI для finalize.

### Новые файлы (read-write)
- `web/netlify/functions/podbor-finalize.js` — главный endpoint.
- `web/netlify/functions/podbor-preview.js` — превью (опц).
- `web/netlify/functions/_lib/podbor/upseller-writer.js` — Sheets-writer слой.
- `web/netlify/functions/_lib/podbor/calc-updates.js` — порт `calculateUpdates`.
- `web/netlify/functions/_lib/podbor/otg-writer.js` — `🚚 ОТГ` логика.
- `web/netlify/functions/_lib/podbor/bd-writer.js` — `ПОДБОРЫ.БД` логика.
- `web/netlify/functions/_lib/podbor/vr-writer.js` — `ПОДБОРЫ.ВР` логика.
- `web/netlify/functions/_lib/podbor/nach-writer.js` — `НАЧИСЛЕНИЯ.НАЧ` append.
- `web/netlify/functions/_lib/podbor/lock.js` — blob-lock per-zayavka.
- `web/netlify/functions/_lib/podbor/idempotency.js` — blob-idempotency.

### Read-only (изучить как референс)
- `3_gas/KorobyService_2/+ПОДБОРЫ.js` — главный референс. Особенно `runFullUpdate`, `calculateUpdates`, `takeSnapshot`, `rollbackChanges`, `updateOtgruzka`, `writeLogToVR`.
- `1_CONST/03_CURRENT_GAS_SYSTEM.md` § 2-12 — реестр листов и статусов.
- `web/netlify/functions/_lib/podbor/boxes.js` — индексы `SRC_IDX/DEST_IDX`.
- `web/netlify/functions/_lib/google.js` — OAuth-клиент.

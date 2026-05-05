---
file: 2_web/Netlify/Sobitiya/CONTEXT.md
purpose: Архитектура и контракт модуля «Журнал событий». Схема события, emission-контракт для модулей-источников, стратегия хранения, scenarios восстановления состояния.
last_updated: 2026-05-04
status: ⏳ дизайн на согласовании, реализация после SYNC_BACKEND_PLAN
---

# Журнал событий — архитектура и контракт

## 1. Зачем модуль существует

В нормальном WMS «состояние склада» не хранится как редактируемая ячейка — оно **выводится** из ленты неизменяемых фактов: «такого-то числа Иванов положил 5 шт товара X в короб Y». Это даёт три гарантии:

1. **Аудит**: на любой вопрос «кто, когда, что» — есть точный ответ.
2. **Восстановимость**: состояние любого объекта на любой момент времени строится воспроизводимо.
3. **Доверие**: расхождение между «что я вижу сейчас» и «что было записано» — невозможно: одно следует из другого.

Сейчас (на май 2026) у нас есть локальные журналы (`ПОДБОРЫ.ВР`, `НАЧИСЛЕНИЯ.НАЧ`, `АРХИВ КОРОБОВ`) — но они **разрозненны**, у каждого своя структура, нельзя ответить на кросс-модульный вопрос «что произошло с коробом за последние сутки» одним запросом. Этот модуль централизует событийный поток.

## 2. Что считается событием

**Событие** = один атомарный, завершённый, объектно-привязанный факт изменения состояния. Признаки:

- **Атомарный**: «короб создан», а не «короб начал создаваться + закончил».
- **Завершённый**: фиксируется только после успешной записи в первичную систему (UPSELLER, БД и т.д.). Падение записи — не событие, отказ.
- **Объектно-привязанный**: каждое событие имеет ≥1 «целевой объект» (короб, баркод, заявка, пользователь, товар, начисление). Без этого нельзя ответить «история объекта X».
- **Необратимый в журнале**: событие, единожды записанное, не редактируется и не удаляется. Откат / исправление = **новое** событие типа `correction.<original_type>`.

**Что НЕ событие**:

- Чтение / просмотр данных.
- Промежуточное состояние UI (раскладка короба в памяти браузера до сохранения).
- Сетевые ретраи без изменения данных.
- Системные housekeeping-операции, не меняющие пользовательских данных (cache rebuild, GC).

## 3. Схема события

### 3.1. Базовый JSON-формат

```json
{
  "id": "evt_2026-05-04T14:23:01.234Z_a1b2c3d4",
  "ts": "2026-05-04T14:23:01.234Z",
  "actor": {
    "type": "user",
    "id": "kam2@upseller.local",
    "displayName": "Артём Файзулов",
    "device": "tsd|tablet|desktop|api|system"
  },
  "module": "podbor",
  "type": "box.set_layout",
  "version": 1,
  "subject": {
    "primary": { "kind": "box", "id": "K10234" },
    "related": [
      { "kind": "zayavka", "id": "S1294-Видинеева" },
      { "kind": "barcode", "id": "4607123456789" }
    ]
  },
  "payload": {
    "barcodes": {
      "4607123456789": { "kolPodb": 5, "kudaPodb": "S1294-001", "kolPerem": 0, "kudaPerem": "" }
    }
  },
  "before": { "...": "snapshot релевантных полей до изменения, опционально" },
  "after":  { "...": "snapshot релевантных полей после, опционально" },
  "context": {
    "clientOpId": "uuid-from-client",
    "correlationId": "uuid-of-parent-flow",
    "ip": "192.168.0.165",
    "userAgent": "Mozilla/...",
    "sessionId": "...",
    "comment": "опционально, для ручных правок с причиной"
  },
  "result": "ok|error",
  "error": null
}
```

### 3.2. Поля — обязательные / опциональные

| Поле | Обяз. | Описание |
| --- | --- | --- |
| `id` | да | `evt_<ts>_<random8>`, монотонный по времени, уникальный |
| `ts` | да | ISO-8601 UTC, миллисекунды |
| `actor.type` | да | `user` / `system` / `external` |
| `actor.id` | да | email / системное имя / id внешнего вызова |
| `actor.device` | да | где произошло — `tsd` / `tablet` / `desktop` / `api` / `system` |
| `module` | да | `podbor` / `invent` / `auth` / `priemka` / `perem` / `finance` / ... |
| `type` | да | dotted-name события, see § 4 |
| `version` | да | целое; bump при изменении схемы payload |
| `subject.primary` | да | главный объект события (для индекса) |
| `subject.related` | нет | дополнительные связанные объекты (для cross-search) |
| `payload` | да | данные события, схема зависит от `type` |
| `before` / `after` | нет | snapshot для facilitate replay; не хранится для всех типов |
| `context.clientOpId` | да | UUID, генерируемый клиентом при намерении выполнить операцию. Дедуплицирует ретраи |
| `context.correlationId` | нет | связывает несколько событий одной бизнес-операции (например, finalize заявки = много событий с одним correlationId) |
| `result` | да | `ok` / `error` |
| `error` | условно | заполняется если `result == error` |

### 3.3. Идентификаторы объектов (`subject.kind`)

| Kind | Формат id | Где живёт первично |
| --- | --- | --- |
| `box` | `K<n>` (короб клиента) или `S<n>-<m>` / `R<n>-<m>` (короб отгрузки) | `🍬 КОРОБЫ` UPSELLER |
| `barcode` | EAN-13 / Code-128 строка | глобально |
| `zayavka` | `S<n>-<client>` / `R<n>-<client>` | `БД_ЭКСП` ПОДБОРЫ |
| `cell` | код ячейки (тара `ЯЧ`) | `🍬 КОРОБЫ` (где `B='ЯЧ'`) |
| `user` | email | whitelist `users` |
| `product` | SKU | `👗 ТОВАРЫ` UPSELLER |
| `client` | имя клиента | `БД_ЭКСП.A` |
| `accrual` | `nach_<id>` | `НАЧИСЛЕНИЯ.НАЧ` |
| `shipment` | то же что zayavka, но в `🚚 ОТГ` | `🚚 ОТГ` |

## 4. Реестр типов событий (event_type_code)

Полная taxonomy уже формализована в БД-схеме — таблица `event_types` (см. § 6). Тут — обзор, как event_types сгруппированы по бизнес-доменам. **Все коды — на уровне таблицы, в нижнем регистре snake_case**, а UI показывает `name` на русском.

Источник истины:
- DDL — [`db/init/001_schema.sql`](db/init/001_schema.sql) (таблица `event_types`).
- Seed — [`db/init/002_seed.sql`](db/init/002_seed.sql) (47 базовых типов из дизайн-референса).
- Расширение под Подбор — [`db/init/003_picking.sql`](db/init/003_picking.sql) (8 новых типов: `picking_zayavka_started/unlocked/finalized/partial_close`, `picking_layout_saved`, `picking_full_box_taken`, `shipping_box_deleted`, `accounting_accrual_created`).

### 4.1. Группировка по доменам

| Домен | event_type_code | Покрытие |
| --- | --- | --- |
| **Поставка** | `supply_request_created`, `supply_arrived`, `cargo_unloaded`, `cargo_opened` | прибытие и физический разбор грузомест |
| **Приёмка** | `item_received`, `receiving_surplus`, `receiving_shortage`, `receiving_defect`, `internal_label_applied` | поштучный приём, излишек/недостача/брак |
| **Короба и хранение** | `box_created`, `box_opened`, `box_closed`, `box_moved`, `box_stored`, `box_split`, `boxes_merged`, `box_compacted` | жизненный цикл коробов |
| **Состав короба** | `item_put_into_box`, `item_taken_from_box`, `item_stored`, `item_removed_from_storage` | движения товара между коробами и хранением |
| **Упаковка** | `packing_started`, `item_packed`, `label_applied`, `packing_defect` | переход в упакованное состояние |
| **Перемаркировка** | `barcode_removed`, `barcode_applied`, `item_relabelled` | смена баркода (R-заявки) |
| **Подбор** ⭐ | `picking_zayavka_started`, `picking_zayavka_unlocked`, `picking_zayavka_finalized`, `picking_zayavka_partial_close`, `picking_started`, `item_reserved`, `picking_layout_saved`, `picking_full_box_taken`, `shipping_box_created`, `shipping_box_deleted`, `item_put_into_shipping_box`, `picking_finished`, `box_ready_to_ship` | полный цикл от взятия заявки в работу до финализации |
| **Отгрузка** | `box_shipped`, `item_shipped`, `shipment_cancelled` | физический выезд со склада |
| **Брак** | `item_marked_defect`, `defect_returned`, `defect_disposed` | списание / возврат / утилизация |
| **Инвентаризация** | `inventory_started`, `inventory_counted`, `inventory_gap_found`, `shortage_written_off`, `surplus_posted` | плановые пересчёты |
| **Корректировки** | `manual_qty_fix`, `manual_status_fix`, `accounting_error_fix` | ручные правки и исправления ошибок учёта |
| **Финансы** | `accounting_accrual_created` | начисления сотрудникам за подбор / упаковку / прочие операции |

### 4.2. Свойства event_type (как описаны в БД)

Каждый `event_types`-row несёт булевы атрибуты, по которым можно фильтровать журнал:

- `affects_inventory` — меняет ли количественный остаток баркода.
- `affects_box_state` — меняет ли состояние короба (открыт/закрыт/адрес).
- `affects_box_content` — меняет ли набор товаров в коробе.
- `affects_item_status` — меняет ли статус товара (например, `storage` → `ready_to_ship`).
- `affects_box_status` — меняет ли статус короба (например, `created` → `ready_to_ship`).
- `default_effect_type_code` — главный экономический эффект (`plus`, `minus`, `no_effect`, `status_transfer`, `box_transfer`).
- `is_report_level` — отчётный ли это тип (виден в основной ленте) или техно-вспомогательный (свернут).

### 4.3. Как Подбор использует журнал

См. отдельный документ [`PODBOR_EVENTS_MAPPING.md`](PODBOR_EVENTS_MAPPING.md) — для каждого UI-действия подборщика и для каждого шага финализации указано, какие события эмитятся, в каком порядке, с какими полями.

## 5. Контракт эмиссии (что обязаны делать модули-источники)

### 5.1. Где эмитить

В каждом state-changing endpoint backend'а (`POST` / `PUT` / `DELETE`) — **после** успешной записи в первичное хранилище (UPSELLER / БД), **до** возврата ответа клиенту:

```js
async function handleBoxSetLayout(req) {
  const user = await requireUser(req);
  const { boxId, barcodes, clientOpId } = await req.json();

  // 1. Применить изменение в первичное хранилище.
  await applyLayout(boxId, barcodes);

  // 2. Эмитить событие.
  await emitEvent({
    actor: { type: 'user', id: user.email, device: req.headers.get('x-device') || 'tablet' },
    module: 'podbor',
    type: 'podbor.box.set_layout',
    subject: { primary: { kind: 'box', id: boxId }, related: [{ kind: 'zayavka', id: zayavkaId }] },
    payload: { barcodes },
    context: { clientOpId, ip: req.headers.get('x-forwarded-for'), ... },
    result: 'ok'
  });

  return Response.json({ ok: true });
}
```

### 5.2. Идемпотентность

`emitEvent({ context.clientOpId })` — если событие с этим `clientOpId` уже есть в журнале за последние 24 часа, новое **не пишется** (возвращается ссылка на существующее). Это защищает от двойного клика, ретраев SyncQueue.

### 5.3. Транзакционность с первичным хранилищем

Идеал — эмиссия события в той же транзакции что и запись данных. На Sheets это невозможно (нет транзакций между листами). Компромисс:

1. **Сначала** запись в первичное хранилище. Если упало → ничего не пишем в журнал, возвращаем ошибку.
2. **Потом** запись события. Если упало (журнал недоступен) → **логируем** ошибку эмиссии в системный лог + ставим запись в `outbox` для повторной попытки фоном. Не падать на пользователе.

Свойство: журнал может **отстать** от первичного хранилища (eventual consistency), но **не противоречить** ему. Если в журнале события нет, но в UPSELLER изменение есть — это известная задержка, не ошибка.

### 5.4. Что эмитят клиенты (фронт)?

Только **клиентский half** через atom-API. Клиент посылает `{ type, payload, clientOpId }` на backend, backend дополняет actor / ts / context / before / after и пишет в журнал. Прямой write от фронта в журнал **запрещён** (нет authority над `actor.id`).

### 5.5. Системные события (cron, миграции)

Actor типа `system`, `actor.id` = имя системного процесса (`'cron.dailyCorobyArchiv'`, `'migration.20260504_addPickMode'`). Контекст по возможности должен ссылаться на запускающий хук.

## 5a. База данных (Postgres-схема)

DDL и seed уже подготовлены и лежат в [`db/init/`](db/init/). Файлы идемпотентны (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) и выполняются по порядку:

| # | Файл | Назначение |
| --- | --- | --- |
| 1 | [`001_schema.sql`](db/init/001_schema.sql) | Базовая схема: 16 reference-таблиц (`clients`, `employees`, `locations`, `supplies`, `cargo_places`, `products`, `barcodes`, `boxes`, `box_types`, `item_statuses`, `box_statuses`, `object_types`, `effect_types`, `correction_reasons`, `event_types`, `documents`), главный `event_log`, `event_validation_errors`, 3 view (`vw_event_log_human`, `vw_barcode_balances`, `vw_box_contents_current`). Перенесён 1-в-1 из дизайн-референса [`2_web/SOBITIYA/db/init/`](../../SOBITIYA/db/init/). |
| 2 | [`002_seed.sql`](db/init/002_seed.sql) | Справочники: 47 базовых event_type'ов на русском, 14 item_statuses, 12 box_statuses, 7 box_types, 7 object_types, 5 effect_types, 10 correction_reasons + минимальные тестовые сущности (1 клиент, 3 сотрудника, 5 локаций). |
| 3 | [`003_picking.sql`](db/init/003_picking.sql) | **Расширение под модуль «Подборы»** *(добавлено 2026-05-04)*: новая таблица `picking_requests`, ALTER `event_log` (колонка `picking_request_id`), 8 новых event_types (`picking_zayavka_started/unlocked/finalized/partial_close`, `picking_layout_saved`, `picking_full_box_taken`, `shipping_box_deleted`, `accounting_accrual_created`), новый object_type `picking_request`, новый item_status `partial_picked`, view `vw_picking_request_history`, функция `fn_picking_request_progress(request_code)`. |

**Развёртывание** (когда дойдём до P1-реализации):

```bash
# В контейнере Postgres:
psql -U wms -d wms -f /docker-entrypoint-initdb.d/001_schema.sql
psql -U wms -d wms -f /docker-entrypoint-initdb.d/002_seed.sql
psql -U wms -d wms -f /docker-entrypoint-initdb.d/003_picking.sql
```

`docker-compose.yml` для локального запуска есть в дизайн-референсе [`2_web/SOBITIYA/docker-compose.yml`](../../SOBITIYA/docker-compose.yml) — копируем при первом физическом разворачивании.

### Как читать историю одной заявки

```sql
-- 1. Последний прогресс заявки:
SELECT * FROM fn_picking_request_progress('S1294-Видинеева');

-- 2. Все события заявки в хронологическом порядке:
SELECT * FROM vw_picking_request_history WHERE request_code = 'S1294-Видинеева';

-- 3. Состав конкретного S-короба сейчас:
SELECT * FROM vw_box_contents_current WHERE box_code = 'S1294-001';

-- 4. Остаток баркода:
SELECT * FROM vw_barcode_balances WHERE barcode = '4607123456789';
```

### Адаптация под новые модули

Если новый event_type нужен — добавляем INSERT в новый файл `004_<module>.sql` (или append к 003 если это про подбор). **Не редактируем 001/002** — это копия из референса, чтобы её было легко обновлять.

Если в `event_log` нужно новое индексируемое поле (а не только в `payload_json`) — `ALTER TABLE event_log ADD COLUMN ... IF NOT EXISTS`. Документировать в comment'ах SQL и в этом файле.

> **Принцип**: схема НЕ заморожена. Журнал — живой инструмент, добавляется под реальные нужды модулей. Если Подбор / Инвент / будущий модуль приходит с операцией, не покрытой текущим набором event_types — заводим новый, не пытаемся уложить в неподходящий существующий.

## 6. Хранилище

**Решение (на 2026-05-04)**: первичное хранилище — **Postgres** на VPS, схема готова в [`db/init/`](db/init/). Никакого промежуточного JSONL+SQLite-этапа не делаем — схема уже есть, разворачиваем сразу.

### 6.1. Где живёт Postgres

- На том же VPS, что и web-приложение (`82-97-249-207.sslip.io`), отдельным docker-compose-контейнером.
- Том на хосте: `/var/lib/upseller/postgres/`.
- БД: `wms`, schema: `wms`, владелец: `wms_user`.
- `docker-compose.yml` — берём за основу из [`2_web/SOBITIYA/docker-compose.yml`](../../SOBITIYA/docker-compose.yml).
- Запуск init-скриптов через стандартный механизм Postgres `/docker-entrypoint-initdb.d/`.

### 6.2. Cold-store / архивы

- Postgres хранит **всё бессрочно**. Оценка размера: ~50 событий на смену × 8 подборщиков × 22 рабочих дня = ~9к событий/мес, ~110к/год. С учётом приёмки и инвента — оценка ×3-5 = ~500к/год. На jsonb-payload ~50-100 МБ/год — копейки.
- Дополнительно — ежесуточный **bypass-экспорт в Google-таблицу `СОБЫТИЯ`** для просмотра не-разработчиками (старшие смены, бухгалтерия). Скрипт-cron, ~1 раз в сутки, append-режим.

### 6.3. Резервное копирование

Стандартное `pg_dump` ежесуточно в `/var/backups/upseller/postgres/<date>.dump`. Retention 30 дней. Off-site — отдельный шаг (S3-совместимый объектный сторадж).

## 7. UI журнала (P1)

Минимальный набор экранов:

1. **Лента событий** — обратнохронологический список, по умолчанию последние 7 дней. Колонки: время, актор, модуль, тип, объект, краткая сводка.
2. **Фильтры**: диапазон дат, актор (multi-select), модуль (multi-select), тип события (multi-select с group-by модулям), субъект (поиск по id с поддержкой K/S/R-префиксов и баркодов).
3. **Карточка события** — full JSON + readable rendering (для known types) + ссылки на связанные объекты («открыть короб K10234 в Подборах»).
4. **«История объекта X»** — фильтр-шорткат: все события где `subject.primary` или `subject.related[]` содержит X. Открывается из любой точки приложения по ссылке.
5. **«Что делал актор Y за период»** — фильтр-шорткат для отчётов смены.

UI на ТСД на P1 не делаем — журнал смотрят на десктопе/планшете старшие смены и админ.

## 8. Replay (восстановление состояния)

Чтобы построить состояние короба `K10234` на момент `T`:

1. Запросить все события `subject.primary.kind=box AND subject.primary.id='K10234' AND ts <= T`, ORDER BY ts ASC.
2. Применить fold: для каждого события — обновить snapshot короба.
3. Результат — короб в состоянии «как было на T».

Replay-функции — отдельные на каждый kind объекта, реализуются по мере необходимости. Не обязательны для P1 (главное — что данные **есть** и можно вручную пройтись).

## 9. Не-цели (что journal модуль НЕ делает)

- **Не заменяет** первичные хранилища (UPSELLER, БД). Это вспомогательная лента, не источник истины для оперативной работы.
- **Не блокирует** запись в случае недоступности журнала — события могут быть emit-нуты с задержкой через outbox.
- **Не предоставляет** транзакционные гарантии «всё или ничего» — для этого есть rollback в `SYNC_BACKEND_PLAN.md` § 3.8.7.
- **Не делает** real-time push в UI клиентов (нет WebSocket'ов в MVP). Лента в UI обновляется по polling раз в N секунд.

## 10. Открытые вопросы (перед стартом реализации)

1. ID нового Google-листа `СОБЫТИЯ` — создать новую таблицу или добавить лист в ПОДБОРЫ?
2. Какие из существующих логов мигрировать в журнал (например, `ПОДБОРЫ.ВР`)? — рекомендация: **не мигрировать** старые, начать с чистого листа от первой эмиссии. Старые остаются как есть.
3. Сколько хранить в hot JSONL до перехода в cold? 30 дней — достаточно?
4. Кто видит журнал — все авторизованные или только админ-роль?
5. Нужно ли ретенировать события удалённых пользователей при GDPR-подобной чистке? — пока в РФ это не критично, но имя в `actor.displayName` лучше пиннить на момент события (чтобы переименование не ломало историю).

---

## 11. Связанные документы

- [`README.md`](README.md) — высокоуровневое описание модуля.
- [`PODBOR_EVENTS_MAPPING.md`](PODBOR_EVENTS_MAPPING.md) — детальный mapping действий подборщика → событий журнала.
- [`db/init/001_schema.sql`](db/init/001_schema.sql), [`db/init/002_seed.sql`](db/init/002_seed.sql), [`db/init/003_picking.sql`](db/init/003_picking.sql) — рабочая Postgres-схема.
- [`1_CONST/02_BUSINESS_PROCESSES.md`](../../../1_CONST/02_BUSINESS_PROCESSES.md) § «Журнал событий — обязательная политика» — общесистемный инвариант.
- [`1_CONST/04_TARGET_WEB_SYSTEM.md`](../../../1_CONST/04_TARGET_WEB_SYSTEM.md) § Аудит — целевая БД-архитектура.
- [`Podbor/SYNC_BACKEND_PLAN.md`](../Podbor/SYNC_BACKEND_PLAN.md) — Подбор будет первым консумером. Эмиссия событий из atoms добавится отдельным этапом после реализации finalize.
- [`2_web/SOBITIYA/wms_event_journal_codex_task.md`](../../SOBITIYA/wms_event_journal_codex_task.md), [`2_web/SOBITIYA/warehouse_operations_for_event_journal.md`](../../SOBITIYA/warehouse_operations_for_event_journal.md) — оригинальный дизайн-референс (март 2026): taxonomy всех 47 базовых событий + 41 операция склада. **Источник** для расширений схемы при появлении новых модулей.

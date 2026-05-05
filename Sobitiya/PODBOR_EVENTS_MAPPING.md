---
file: 2_web/Netlify/Sobitiya/PODBOR_EVENTS_MAPPING.md
purpose: Бизнес-логика — какие события эмитит модуль Подборы, в каком порядке, с какими полями. Source-of-truth для реализации emitEvent() в Podbor backend.
last_updated: 2026-05-04
status: ⏳ дизайн на согласовании
---

# Mapping: действия подборщика → события журнала

> Этот документ описывает **бизнес-процесс эмиссии событий** для модуля «Подбор». Какое действие подборщика → какие записи появляются в `event_log`. Реализуется на этапах S2-S3 roadmap'а Sobitiya, после `Podbor/SYNC_BACKEND_PLAN`.
>
> Базовая схема БД: [`db/init/001_schema.sql`](db/init/001_schema.sql) + [`db/init/002_seed.sql`](db/init/002_seed.sql) + [`db/init/003_picking.sql`](db/init/003_picking.sql) (расширение под подбор).

## 1. Принципы

1. **Атомы UI-действий ≠ события журнала**. Один клик подборщика может породить N событий (например, ПОЛН КОРОБ короба с 5 баркодами = 5 строк `item_put_into_shipping_box`). Один клик «Завершить заявку» = десятки событий + одно сводное `picking_zayavka_finalized`.

2. **Эмиссия — после успешной записи в первичные хранилища** (`🍬 КОРОБЫ`, `🚚 ОТГ`, `НАЧИСЛЕНИЯ.НАЧ`, `ПОДБОРЫ.БД`). Если запись упала — событие не эмитится. Из этого следует: журнал не противоречит первичным таблицам, но может отставать на rollback-сценариях.

3. **`correlation_id` (в payload_json) связывает все события одной бизнес-операции**: например, finalize заявки = десятки событий с одним и тем же `correlation_id` равным `idempotency_key` финализации. Это позволяет «отмотать всё, что произошло в результате этого клика».

4. **Событие несёт `picking_request_id`** (foreign key из `event_log` в `picking_requests`) — для всех событий, относящихся к подбору. Чтение истории одной заявки → один index-skan.

5. **`payload_json` хранит** дополнительные поля, которые не вытаскиваем в колонки: `pick_mode`, `request_type`, `clientOpId`, snapshot before/after, причина (для микро-инвента и partial-close).

---

## 2. Атомы UI и их эмиссия

### 2.1. Подборщик нажимает «Начать» на карточке заявки

**Атом**: (фронт) → `POST /api/podbor/zayavka.start { zayavkaId }` (через SyncQueue).

**Backend действия**:
1. Проверить, что заявка не залочена другим (поле `picking_requests.locked_by_id`).
2. Выставить `locked_by_id = current_user`, `locked_at = NOW()`, `status_code = 'in_progress'`.
3. В UPSELLER `🚚 ОТГ.BC` (если первый подбор) обновить статус (опционально, может быть только при finalize).

**Эмитим 1 событие**:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `picking_zayavka_started` |
| `object_type_code` | `picking_request` |
| `picking_request_id` | id заявки |
| `client_id` | id клиента |
| `employee_id` | id подборщика |
| `effect_type_code` | `no_effect` |
| `payload_json` | `{ pick_mode, request_type, clientOpId, correlation_id }` |

---

### 2.2. Подборщик отказался от заявки без сохранения

**Атом**: (фронт) → `POST /api/podbor/zayavka.unlock`.

**Backend**:
1. Сбросить `locked_by_id = NULL`, `locked_at = NULL`.
2. Если в `boxLayoutStore` для этой заявки нет ни одного non-empty draft → `status_code = 'created'`. Иначе → оставить `in_progress` (lock снят, но черновик есть, кто-то другой может продолжить, но не должен из-за UX).

**Эмитим**:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `picking_zayavka_unlocked` |
| `payload_json` | `{ had_draft: bool, draft_boxes_count: N, correlation_id }` |

---

### 2.3. Подборщик сохраняет раскладку одного короба-источника (`box.set_layout`)

**Атом**: фронт BoxModal → `POST /api/podbor/sync` с `{ type: 'box.set_layout', boxId, barcodes: { [bc]: { kolPodb, kudaPodb, kolPerem, kudaPerem } } }`.

**Backend действия (на этапе MVP)**:
1. Сохранить в memory-store `boxLayoutStore[boxId]`. **В UPSELLER физически не пишем**, как в GAS — всё накапливается до finalize.
2. Эмитим **draft-событие** `picking_layout_saved`. Это снимок намерения, не материализованного факта.

**Эмитим 1 событие** (один на сохранение, не на каждый баркод):

| Поле | Значение |
| --- | --- |
| `event_type_code` | `picking_layout_saved` |
| `object_type_code` | `item_box` |
| `picking_request_id` | id заявки |
| `box_id` | id короба-источника |
| `client_id` | id клиента |
| `employee_id` | id подборщика |
| `effect_type_code` | `no_effect` (это не материализация, а намерение) |
| `payload_json` | `{ barcodes: {...полный draft...}, pick_mode, fullBoxMode: bool, fullBoxTarget: 'S1294-001' or '__AUTO_KOR__', clientOpId, correlation_id }` |

> **Важно**: `picking_layout_saved` — лог намерения. Реальные движения товара (`item_taken_from_box`, `item_put_into_shipping_box`) появляются **только при finalize**. Это позволяет аудиту видеть «черновик правился N раз», даже если сохранили только последний.

**Особый случай — ПОЛН КОРОБ**: если в draft каждая строка имеет `kolPodb = qty` и общий `kudaPodb` (или `__AUTO_KOR__` в КОР) — эмитим **дополнительно** `picking_full_box_taken`:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `picking_full_box_taken` |
| `box_id_from` | id источника |
| `box_id_to` | id ship-короба (для КОР пишем `NULL` + `payload_json.kuda = '__AUTO_KOR__'` — резолвится при finalize) |
| `qty` | сумма по всем баркодам в коробе |
| `effect_type_code` | `box_transfer` |

---

### 2.4. Подборщик создаёт N коробов отгрузки (`ship.create`)

**Атом**: (фронт) → `POST /api/podbor/sync` с `{ type: 'ship.create', zayavkaId, count, taraType }`.

**Backend действия**:
1. Сгенерировать N номеров `S<NNNN>-<MMM>` (или `R...` для R-заявок).
2. Создать N строк в таблице `boxes` с `box_type_code='shipping_box'`, `current_status_code='created'`, `client_id` из заявки.
3. (На P1 не пишем сразу в `🍬 КОРОБЫ` — пишем при finalize.)

**Эмитим N событий** — по одному на каждый созданный короб:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `shipping_box_created` |
| `object_type_code` | `box` |
| `picking_request_id` | id заявки |
| `box_id` | id нового короба |
| `box_type_code` | `shipping_box` |
| `box_status_after_code` | `created` |
| `client_id` | id клиента |
| `employee_id` | id подборщика |
| `effect_type_code` | `no_effect` |
| `payload_json` | `{ tara_type: 'К_1.0', batch_index: 1..N, batch_total: N, clientOpId, correlation_id }` |

> Все N событий шарят один `correlation_id` — это «один батч».

---

### 2.5. Подборщик удаляет неиспользованный короб отгрузки (`ship.delete`)

**Атом**: `POST /api/podbor/sync` `{ type: 'ship.delete', zayavkaId, number }`.

**Backend**: проверить что короб не используется в раскладке; пометить `boxes.archived_at = NOW()` или удалить (зависит от политики). Эмитим:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `shipping_box_deleted` |
| `object_type_code` | `box` |
| `box_id` | id удаляемого короба |
| `box_status_before_code` | `created` |
| `box_status_after_code` | `archived` |
| `effect_type_code` | `no_effect` |
| `payload_json` | `{ correlation_id, clientOpId }` |

---

### 2.6. Микро-инвент (`box.inventory_correction`)

**Атом**: `POST /api/podbor/sync` `{ type: 'box.inventory_correction', boxId, barcode, novKol, oldKol, reason }`.

**Backend**:
1. Сохранить в memory-store `inventoryOverrides[boxId|barcode] = novKol`.
2. **На P1 в UPSELLER пока НЕ пишем** — изменение применяется при finalize вместе с раскладкой.
3. Альтернатива (P2): применять микро-инвент сразу в `🍬 КОРОБЫ.I` для синхронизации между сессиями. Тогда событие материализованное.

**Эмитим**:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `manual_qty_fix` |
| `object_type_code` | `item` |
| `picking_request_id` | id заявки (если в контексте заявки) или NULL (если внеплановый микро-инвент случайного короба) |
| `box_id` | id короба |
| `barcode_id` | id баркода |
| `qty` | `ABS(novKol - oldKol)` |
| `effect_type_code` | `plus` если `novKol > oldKol`, `minus` иначе, `no_effect` если 0=0 (но тогда не эмитим) |
| `correction_reason_code` | `manual` (или маппинг из UI: «брак» → `defect`, «излишек» → ...) |
| `comment` | текст причины от подборщика |
| `payload_json` | `{ old_qty, new_qty, clientOpId, correlation_id }` |

> Микро-инвент — единственный атом, который **на P1 материализуется отдельно от finalize** в P2-режиме. На P1 живёт в памяти и эмитится при finalize.

---

### 2.7. Финализация заявки (`finalize`)

**Атом**: `POST /api/podbor/finalize { zayavkaId, statusFinal }`.

**Backend**: 4-шаговая транзакция (`КОРОБЫ → ОТГ → НАЧ → БД`), см. [`Podbor/SYNC_BACKEND_PLAN.md`](../Podbor/SYNC_BACKEND_PLAN.md) § 3.8.

**Эмиссия — это сценарий-кульминация. Эмитим много событий с одним `correlation_id` = idempotency-key финализации**.

#### 2.7.1. По каждой строке раскладки

Для каждой `(boxId, barcode)` где `kolPodb > 0`:

**Событие A**: списание из источника:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `item_taken_from_box` |
| `object_type_code` | `item_box` |
| `picking_request_id` | id заявки |
| `box_id_from` | id источника |
| `barcode_id` | id баркода |
| `qty` | `kolPodb` |
| `item_status_before_code` | текущий статус источника (например `storage`) |
| `effect_type_code` | `box_transfer` |
| `payload_json` | `{ source_qty_before: <I_before>, source_qty_after: <I_after>, correlation_id, clientOpId }` |

**Событие B**: помещение в ship-короб:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `item_put_into_shipping_box` |
| `box_id_to` | id ship-короба (для КОР резолвится здесь же из `__AUTO_KOR__`) |
| `barcode_id` | id баркода |
| `qty` | `kolPodb` |
| `item_status_before_code` | `storage` |
| `item_status_after_code` | `ready_to_ship` |
| `effect_type_code` | `box_transfer` |
| `payload_json` | `{ correlation_id, clientOpId }` |

**Если `kolPerem > 0`** (только в СВОБ — в КОР/КОР+ запрещено):

| Поле | Значение |
| --- | --- |
| `event_type_code` | `box_moved` или `item_taken_from_box` + `item_put_into_box` (в ячейку) |
| `box_id_from` | id источника |
| `box_id_to` | id ячейки (`box_type_code='picking_box'` или `mix_box`) |
| `qty` | `kolPerem` |

#### 2.7.2. По каждому S-коробу, использованному в раскладке

Если короб новый (создан атомом `ship.create` и теперь физически появляется в `🍬 КОРОБЫ`):

| Поле | Значение |
| --- | --- |
| `event_type_code` | `box_ready_to_ship` |
| `box_id` | id ship-короба |
| `box_status_before_code` | `created` |
| `box_status_after_code` | `ready_to_ship` |

#### 2.7.3. Начисления

Для каждой строки в `НАЧИСЛЕНИЯ.НАЧ` (на P1 — одна агрегатная):

| Поле | Значение |
| --- | --- |
| `event_type_code` | `accounting_accrual_created` |
| `object_type_code` | `system` |
| `picking_request_id` | id заявки |
| `employee_id` | подборщик, кому начисление |
| `payload_json` | `{ amount, ks, base, correlation_id }` |

#### 2.7.4. Сводное событие

**В конце** транзакции:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `picking_zayavka_finalized` (или `picking_zayavka_partial_close` если статус ЧАСТИЧНО) |
| `object_type_code` | `picking_request` |
| `picking_request_id` | id заявки |
| `payload_json` | `{ checklist: { koroby:'✅', otg:'✅', nach:'✅', bd:'✅' }, units_picked: N, boxes_used: M, status_final: 'СОБРАНО', duration_ms, correlation_id, clientOpId }` |

> Один `picking_zayavka_finalized` = «зонтик» над всеми событиями finalize. UI журнала показывает его как одну строку «заявка завершена», по разворачиванию — список деталей с тем же `correlation_id`.

---

### 2.8. Rollback при сбое

Если на любом из 4 шагов finalize падение → backend выполняет rollback (см. SYNC_BACKEND_PLAN § 3.8.7). После rollback'а:

- **Не эмитим** события про успешные шаги — мы их откатили.
- **Эмитим** одно событие `accounting_error_fix` (или новый `picking_zayavka_rollback`) с описанием причины:

| Поле | Значение |
| --- | --- |
| `event_type_code` | `accounting_error_fix` (existing, в пейлоаде причина) |
| `object_type_code` | `system` |
| `picking_request_id` | id заявки |
| `payload_json` | `{ failed_step: 'koroby'/'otg'/'nach'/'bd', error: '...', rollback_status: 'ok'/'desync', correlation_id }` |
| `comment` | человекочитаемое описание |

Это даёт аудит «была попытка финализации, упала, откатилась успешно/не успешно».

---

## 3. Сводка маппинга

| UI-действие подборщика | Событий | Главные `event_type_code` |
| --- | --- | --- |
| Открыл заявку «Начать» | 1 | `picking_zayavka_started` |
| Сохранил раскладку короба | 1 (+1 если ПОЛН) | `picking_layout_saved` (+ `picking_full_box_taken`) |
| Создал N коробов отгрузки | N | `shipping_box_created` ×N |
| Удалил пустой короб отгрузки | 1 | `shipping_box_deleted` |
| Микро-инвент | 1 | `manual_qty_fix` |
| Закрыл без сохранения (отказ) | 1 | `picking_zayavka_unlocked` |
| Завершил заявку (успех) | много (см. § 2.7) | `item_taken_from_box`, `item_put_into_shipping_box`, `box_ready_to_ship`, `accounting_accrual_created`, `picking_zayavka_finalized` |
| Завершил частично (с причиной) | то же + `picking_zayavka_partial_close` вместо `picking_zayavka_finalized` | |
| Финализация упала с откатом | мало (см. § 2.8) | `accounting_error_fix` |

---

## 4. Чего ещё нет в схеме (потенциальные расширения)

Что может потребоваться добавить, когда дойдём до реализации:

1. **Журнал начислений (НАЧИСЛЕНИЯ)** как отдельная таблица `accruals`, не только событие. Сейчас `accounting_accrual_created` — событие. Достаточно ли его?
   - Pros: единый event_log проще, не плодим таблицы.
   - Cons: `НАЧИСЛЕНИЯ.НАЧ` имеет специфические поля (смена, расценка, формула), которые лучше типизировать. Решение отложить до реализации.
2. **`pick_mode_changed`** — событие смены режима сборки (если кто-то правит `БД_ЭКСП.Q` в Sheets вручную). Сейчас не эмитится — оперативное изменение.
3. **`picking_zayavka_partial_close` payload-расширение** — нужно поле `missing_barcodes: [{ barcode, requested, picked, available }]` для отчётности «что не собрали и почему».
4. **R-заявки (перемаркировка)** — отдельный набор событий или используем существующие `barcode_removed` / `barcode_applied` / `item_relabelled`? На P1 R-заявки финализируются через GAS `ПЕРЕМ`, а не web. Когда мигрируем — добавим mapping.
5. **«Кто сейчас работает с заявкой»** в реальном времени — это запрос к `picking_requests.locked_by_id`, а не журнал. Журнал отвечает на «кто работал», не «кто работает».

---

## 5. Связь с другими документами

- [`README.md`](README.md) / [`CONTEXT.md`](CONTEXT.md) — общая архитектура журнала.
- [`db/init/`](db/init/) — рабочие SQL-файлы (1, 2 — копия из `2_web/SOBITIYA/`; 3 — расширение под подбор).
- [`Podbor/SYNC_BACKEND_PLAN.md`](../Podbor/SYNC_BACKEND_PLAN.md) — что физически делает finalize в первичных таблицах.
- [`1_CONST/02_BUSINESS_PROCESSES.md`](../../../1_CONST/02_BUSINESS_PROCESSES.md) — общесистемный инвариант «каждое изменение → событие».
- [`2_web/SOBITIYA/wms_event_journal_codex_task.md`](../../SOBITIYA/wms_event_journal_codex_task.md) — оригинальный дизайн-референс, taxonomy всех 47 событий.

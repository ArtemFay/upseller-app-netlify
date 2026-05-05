---
file: archive/SKLAD_MODULE_PLAN_2026-04_DRAFT.md
purpose: Драфт плана отдельного модуля «Склад» (event sourcing с аудитом транзакций). НЕ реализован, не текущая задача. Сохранён как референс для будущего обсуждения.
status: DRAFT — не запущено в работу. Решение, делать ли это, не принято.
last_updated: 2026-04-28 (момент извлечения из старого MIGRATION_PLAN.md)
---

# Модуль 2 (DRAFT): Складской учёт с аудитом транзакций

> **Контекст**: этот документ — извлечённая часть старого `MIGRATION_PLAN.md` (модуль 2, написан в апреле 2026). Описывает план **отдельного модуля «Склад»** — иммутабельный журнал движений товара с обязательным reason для любых правок.
>
> **Статус**: НЕ реализован. К текущей разработке (Календарь / Инвент / Подборы) отношения не имеет. Сохранён как референс на случай возвращения к идее в будущем.
>
> **Если когда-то возьмёмся**: этот план потребует пересмотра под текущие реалии (могут измениться доступные сервисы, ограничения тарифов, актуальная архитектура других модулей).

---

## Context

**Зачем это делается.** Fulfillment-склад 1000 м² с товарами разных клиентов страдает от накопления расхождений между физическими остатками и учётом. Главный источник истины — лист `🍬 КОРОБЫ`, но он хранит только текущее состояние без истории. Операторы подбора, КРО, менеджеры вносят ручные правки без фиксации причины → "тихие" инвентаризации ломают баланс. Нет возможности ответить на вопрос "куда делось 15 штук товара X?"

**Что получаем.** Иммутабельный журнал всех движений на складе с обязательным указанием причины для любой правки. Прозрачная хронология по каждому barcode. Сверка расчётного vs физического остатка (reconciliation). Невозможность изменить остаток иначе как через транзакцию. На этапе 7 — **полный запрет ручных правок в Sheets**, всё через веб-сайт с reason и ролью admin.

**Принципы (best practice из WMS/ERP мира):**

1. **Event Sourcing + double-entry movements** — стандарт в Odoo `stock.move`, SAP EWM. Каждое движение — дебет+кредит по (client × barcode × статус × короб).
2. **Append-only log** — никаких UPDATE/DELETE на событиях, ошибки компенсируются REVERSAL.
3. **Projection first, enforcement later** — сначала наблюдаем, потом запрещаем.
4. **Transactional outbox** — Apps Script складывает события в `__outbox`, cron-функция шлёт их на webhook с ретраями.
5. **Idempotency** — каждое событие имеет `external_id`, дубли отбрасываются.

## Решения пользователя (на момент апреля 2026)

1. **Точка отсчёта — снимок на день запуска.** Историю "до" не восстанавливаем. Первая транзакция в журнале = INVENTORY_COUNT на все коробы на дату bootstrap.
2. **Жёсткое enforcement на этапе 7.** Ручные правки в `🍬 КОРОБЫ` запрещены через Apps Script + range protection. Изменения идут только через сайт, только админ, обязательно с причиной.
3. **Миграция на service account.** Переходим с личного OAuth refresh token на `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com`.
4. **Уведомления — email через Resend** (free tier, ≤100 писем/день).

## Tech stack (предлагался)

| Слой | Технология | Обоснование |
|---|---|---|
| БД | **Neon Postgres** (serverless, free 0.5 GB) | HTTP-подключение без connection pool → идеально для Netlify Functions. Запас на 3+ года событий. |
| Драйвер | `@neondatabase/serverless` | Native HTTP-режим |
| Миграции | `drizzle-kit` + `drizzle-orm` | Типизация схемы + типобезопасные query |
| Backend | Netlify Functions, новые `/api/stock/*` | Переиспользуем `_lib/auth.js`, `_lib/google.js` |
| Доступ к Sheets | Google service account | Не зависит от личного Google пользователя |
| Sheets → БД | Apps Script `onEdit`/`onChange` → лист `__outbox` → cron flush раз в минуту → webhook `/api/stock/ingest` | Стандартный outbox pattern |
| БД → Sheets | Netlify scheduled function раз в сутки: пересчёт проекции → обновление `🆗 ОСТАТКИ` | Reflection, не источник |
| Email алерты | Resend (free 100/день) | `RESEND_API_KEY` в env |
| Frontend | Ванильный HTML+JS с Chart.js | Консистентно с другими модулями |

## Схема БД (PostgreSQL)

**Справочники:**

- `clients (id, code, name, is_active)` — клиенты fulfillment
- `products (id, client_id, barcode UNIQUE, sku, unit, expires_tracked, attributes jsonb)` — товары

**Физический короб (агрегат-проекция):**

- `boxes (id, box_code UNIQUE, client_id, product_id, qty, status, intake_doc, shipment_doc, sheet_row, version)`
- `box_status` ENUM: RECEIVING, READY, STORAGE, PICKED, AWAITING_SHIPMENT, SHIPPED, DEFECT, DELETED

**Ядро — append-only журнал:**

- `stock_events (id uuid PK, type movement_type, occurred_at, recorded_at, actor_email, source, external_id UNIQUE, reason_code, reason_text, reference jsonb, reverses_event uuid FK)`
- `stock_movements (id, event_id uuid FK, box_id, client_id, product_id, from_status, to_status, signed_qty, lot_id, expires_at, note)`
- **Триггер БД** запрещает UPDATE/DELETE на этих таблицах.
- **Инвариант check-функцией:** для RECLASS/REMARK/внутренних перемещений сумма `signed_qty` по event_id = 0.

**Типы транзакций (movement_type ENUM):**

- `RECEIPT` — приёмка (+qty, null → RECEIVING)
- `PUTAWAY` — размещение на хранение (RECEIVING → STORAGE)
- `PICK` — подбор под отгрузку (STORAGE → PICKED)
- `STAGE` — в зону ожидания (PICKED → AWAITING_SHIPMENT)
- `SHIPMENT` — отгрузка на МП (AWAITING_SHIPMENT → null, -qty)
- `RETURN_FROM_MP` — возврат с маркетплейса (+qty)
- `RETURN_TO_CLIENT` — отдали клиенту (-qty)
- `RECLASSIFICATION` — годное → брак (STORAGE -qty, DEFECT +qty)
- `REMARK` — смена barcode (product_A -qty, product_B +qty)
- `ADJUSTMENT` — ручная правка (reason обязателен)
- `INVENTORY_COUNT` — факт инвентаризации (может породить ADJUSTMENT)
- `WRITE_OFF` — списание (DEFECT -qty)
- `REVERSAL` — компенсация ошибочного события

**reason_code ENUM:** PHYSICAL_RECOUNT, DAMAGE_IN_TRANSIT, DAMAGE_ON_SHELF, DAMAGE_ON_PACKING, WRONG_BARCODE, WRONG_COUNT_AT_RECEIPT, MARKETPLACE_REFUND, MARKETPLACE_LOST, OPERATOR_ERROR, MANAGER_DECISION, CLIENT_REQUEST, CYCLE_COUNT, OTHER.

**Проекции:**

- `stock_balance_live` — VIEW (on-demand)
- `stock_balance` — MATERIALIZED VIEW (обновляется ночью)

**Инвентаризация и сверка:**

- `inventory_sessions (id, started_at, finished_at, scope jsonb, status, started_by)`
- `inventory_counts (id, session_id, product_id, box_id, counted_qty, expected_qty, delta GENERATED, adjustment_event_id)`
- `reconciliation_findings (id, detected_at, client_id, product_id, box_id, kind, severity, payload jsonb, resolved_at, resolved_by)`

**Идемпотентность:**

- `ingest_log (external_id PK, received_at, source_sheet, raw_payload, accepted, event_id)`
- `ingest_failures (id, received_at, payload, error, resolved_at)`

## Интеграция с Google Sheets

### Поток (этапы 3-6): Sheets → БД

```text
Оператор правит 🍬 КОРОБЫ
     ↓
onEdit trigger (GAS) → строка в листе __outbox (uuid, payload, status=pending)
     ↓
Cron trigger GAS каждую минуту:
     POST /api/stock/ingest с Bearer <INGEST_TOKEN>
     Body: { events: [...] }
     ↓
Netlify Function /api/stock/ingest:
     1. Проверяет токен (ENV: INGEST_TOKEN)
     2. UPSERT в ingest_log по external_id (идемпотентность)
     3. Маппит payload → stock_events + stock_movements в одной транзакции
     4. Возвращает { accepted, rejected }
     ↓
GAS помечает строки outbox как sent/failed по ответу
```

### Поток (этап 7+): БД → Sheets (reflection)

Apps Script на КОРОБЫ становится **read-only perspective**: range protection + скрипт откатывает любое изменение кроме service account. Scheduled function раз в сутки пересобирает `🆗 ОСТАТКИ` из проекции БД.

### Маппинг Sheets → события

| Изменение в `🍬 КОРОБЫ` | Тип события |
|---|---|
| Новая строка со статусом "В ПРИЕМКЕ" | RECEIPT |
| Смена статуса "ГОТОВО"/"ХРАНЕНИЕ" | PUTAWAY |
| Смена статуса "СОБРАНО", заполнен `№ОТГ` | PICK |
| Смена статуса "ЖДЕТ ОТГРУЗКУ" | STAGE |
| Смена статуса "ОТГРУЖЕНО" + `ДАТА ОТГ` | SHIPMENT |
| Смена `КОЛ` без смены статуса | ADJUSTMENT + flag для разбора |
| Смена `БАРКОД` | REMARK (reason=WRONG_BARCODE) |
| Смена на "БРАК" из STORAGE | RECLASSIFICATION |
| Статус "УДАЛЕНО" | WRITE_OFF (или REVERSAL если недавно) |

## UI-модули (`/sklad/`)

На главной `/` включаем тайл "Склад" (сейчас disabled). Подразделы:

1. **Дашборд остатков** — `stock_balance_live` с фильтрами
2. **Карточка barcode** `/sklad/product/:barcode` — разбивка по статусам, Timeline движений, Chart.js график по дням
3. **Карточка короба** `/sklad/box/:code` — жизненный цикл короба
4. **Журнал событий** `/sklad/events` — лента stock_events с фильтрами
5. **Reconciliation** `/sklad/recon` — расхождения + кнопки "разобрать"
6. **ADJUSTMENT** `/sklad/adjust` — форма с обязательным reason_code + text
7. **Инвентаризация** `/sklad/inventory` — сессии, экспорт ведомостей, ввод counts
8. **Перемаркировка** `/sklad/remark` и **переклассификация** `/sklad/reclass` — узкоспец. формы

Все формы записи требуют `requireUser`. `WRITE_OFF`, `REVERSAL`, закрытие инвентаризации — только admin.

## Roadmap (7 этапов)

### Этап S1 — Фундамент (read-only скелет) [4-6 ч]

**Ассистент:**

- Завести Neon-проект, DATABASE_URL в Netlify env
- Drizzle миграции всех таблиц
- `_lib/db.js` (Neon HTTP клиент), `_lib/stock.js` (CRUD-хелперы)
- Роуты `/api/stock/products`, `/api/stock/balance` — пустые массивы
- `/sklad/` — скелет, переиспользует auth из `/calend-otg/`
- Активация тайла "Склад" на главной

**Пользователь:** регистрация Neon через GitHub.

**Критерий:** открывается `/sklad/`, видно "данные появятся после этапа 2".

### Этап S2 — Bootstrap снимок + миграция на service account [4-5 ч]

**Ассистент:**

- Сгенерировать ключ service account `sheets-bot@sheet-ai-491412`, в Netlify env
- Переключить `_lib/google.js` с OAuth refresh token на service account auth
- Скрипт `/api/stock/bootstrap` (admin-only, за feature flag): читает `🍬 КОРОБЫ` целиком, создаёт `clients`, `products`, `boxes`, событие `INVENTORY_COUNT` с `external_id='bootstrap-YYYY-MM-DD'`
- Сверка с `🆗 ОСТАТКИ` — расхождения идут в `reconciliation_findings`

**Пользователь:** расшарить таблицу `1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q` на `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` с правом "Редактор".

**Критерий:** `/sklad/` показывает текущие остатки клиент × barcode × статус; они совпадают с `🆗 ОСТАТКИ`.

### Этап S3 — Живой захват отгрузок [3-4 ч]

**Ассистент:**

- Apps Script: создаёт лист `__outbox` в таблице, пишет installable `onEdit` триггер на КОРОБЫ
- Скрипт `flushOutbox` на cron 1 мин: шлёт события на `/api/stock/ingest`
- `/api/stock/ingest` принимает SHIPMENT и STAGE события
- UI: на карточке barcode видно последние отгрузки

**Критерий:** меняю статус короба на "ОТГРУЖЕНО" → через ≤90 сек событие SHIPMENT в БД.

### Этап S4 — UI-история (read-only) [4-5 ч]

- Timeline barcode, карточка короба
- Журнал событий `/sklad/events`
- Chart.js графики (stacked area по статусам)
- Экспорт CSV

### Этап S5 — Приёмки и внутренние переводы [4-5 ч]

- Расширение `/api/stock/ingest` для типов RECEIPT, PUTAWAY, PICK
- Маппинг из `📋 ПОСТАВКИ` → RECEIPT с reference на `№ПОС`
- Связка с `РЕД ПОСТ` — правки идут как ADJUSTMENT с reason=WRONG_COUNT_AT_RECEIPT

### Этап S6 — Reconciliation dashboard + email алерты [3-4 ч]

- Netlify scheduled function ежедневно 03:00 МСК: REFRESH MATERIALIZED VIEW, поиск негативных балансов, сверка
- Email через Resend если severity=critical
- UI `/sklad/recon` с кнопкой "разобрать" → предзаполненная форма ADJUSTMENT

### Этап S7 — Enforcement: запрет ручных правок [4-5 ч]

- Apps Script: range protection на `🍬 КОРОБЫ` (editors = только sheets-bot@ и owner)
- Скрипт `onEdit` откатывает любое изменение кроме service account
- UI `/sklad/adjust` для admin-a — форма с обязательным reason_code + reason_text
- Scheduled reflection: раз в сутки переписать `🆗 ОСТАТКИ` из БД

**Критерий:** попытка правки КОРОБЫ оператором автоматически откатывается; все изменения происходят через сайт с reason.

### Сводка (исходная оценка)

| # | Этап | Ассистент | Пользователь | Результат |
|---|---|---|---|---|
| S1 | Neon + скелет | 4-6 | 15 мин | `/sklad/` открывается |
| S2 | Bootstrap + service account | 4-5 | 5 мин | Остатки в БД = остатки в Sheets |
| S3 | Захват отгрузок | 3-4 | 10 мин | SHIPMENT события живые |
| S4 | UI-история | 4-5 | — | Timeline по barcode |
| S5 | Приёмки и переводы | 4-5 | — | Весь жизненный цикл короба |
| S6 | Reconciliation + email | 3-4 | 5 мин | Дашборд и алерты |
| S7 | Enforcement | 4-5 | объявление сотрудникам | Ручные правки невозможны |
| **Итого** | | **~30 ч** | **~35 мин + политика** | Полный аудит + дисциплина |

## Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| Apps Script trigger падает | Средняя | Outbox + ретраи + ночная scheduled-сверка |
| Neon free tier 0.5 GB | Низкая | 180k событий/3года × 500 байт ≈ 180 MB. 3-кратный запас. |
| Сопротивление сотрудников enforcement'у | Высокая | Объявление за 2 недели, обучение, логи кто что пытался править |
| Дрейф между БД и Sheets | Средняя | Ночная reconciliation + авто-алерт email |
| Негативные остатки в проекции | Средняя | Check в scheduled function, finding severity=critical |
| Утечка service account key | Критическая при утечке | Только в Netlify env, .gitignore, rotate раз в полгода |

## Метрики успеха

- Покрытие журнала: ≥99.5% изменений в КОРОБЫ имеют соответствующее stock_event
- Нулевое расхождение: `reconciliation_findings` kind='SHEET_DRIFT' severity='critical' = 0 за 14 дней подряд
- Все ADJUSTMENT с причиной: 100%
- MTTR расхождений: <24 часа от detection до resolution
- P95 отставания Sheets→БД: <2 мин, P99 <10 мин

## Что нужно проверить, если возьмёмся

- Актуальны ли тарифы Neon Postgres / Resend (могли измениться).
- Поменялась ли архитектура других модулей (auth, google access) — план писался под старые `_lib/auth.js` / `_lib/google.js`.
- Не реализовал ли Подбор-модуль уже часть атомов (`box.set_layout` и т.п.) — там тоже похожая логика «event with reason».
- Готов ли пользователь к политическим затратам на этап S7 (объявление сотрудникам, обучение).

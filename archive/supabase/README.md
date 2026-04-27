# Supabase — журнал событий Upseller

База данных PostgreSQL на Supabase для хранения журнала событий товароучётной системы.

## Что нужно сделать один раз — создание проекта в Supabase

### 1. Регистрация / вход

1. Открой https://supabase.com/
2. Нажми «Start your project» → войди через Google, используя **`psgl2007@gmail.com`**.

### 2. Создание проекта

1. На Dashboard нажми **New project**.
2. Параметры:
   - **Name**: `upseller-journal`
   - **Database password**: нажми **Generate a password** → **сохрани пароль** (он больше нигде не покажется; если потеряешь — можно сбросить, но с ним придётся переподключать всё).
   - **Region**: выбери ближайший (Frankfurt или Stockholm).
   - **Pricing Plan**: Free.
3. Нажми **Create new project**. Создание занимает ~2 минуты.

### 3. Применение миграции (создание таблиц)

1. В левой панели Supabase открой **SQL Editor**.
2. Нажми **+ New query**.
3. Открой файл `web/supabase/migrations/0001_init.sql` из этого репозитория, скопируй весь его текст.
4. Вставь в SQL Editor → нажми **Run** (или Ctrl+Enter).
5. Должно появиться сообщение «Success. No rows returned».
6. Перейди в **Table Editor** в левой панели — должны появиться таблицы:
   - `events`, `stock_movements`, `boxes`, `box_contents`, `charges`
   - `clients`, `products`, `employees`
   - `clients_history`, `products_history`, `employees_history`

### 4. Получение ключей для приложения

В левой панели → **Project Settings** (шестерёнка) → **API**:

- **Project URL** — скопируй, пример: `https://abcdefgh.supabase.co`
- **Project API keys** → `service_role` key — скопируй (нажми «Reveal»). **Это секретный ключ, не выкладывать в публичный репозиторий.**

Эти два значения надо будет записать в Netlify в Environment Variables (сделаем на следующем шаге, не сейчас):
- `SUPABASE_URL` = Project URL
- `SUPABASE_SERVICE_KEY` = service_role key

Пока просто пришли их мне в чат — я добавлю в Netlify.

## Архитектура

### Таблицы-журналы (append-only, только INSERT)

Триггеры в БД **физически блокируют** UPDATE/DELETE на этих таблицах:

| Таблица | Соответствие | Содержание |
|---|---|---|
| `events` | БД_СОБЫТИЕ | Мастер-журнал: 1 строка = 1 операция (отчёт, правка, начисление) |
| `stock_movements` | БД_ОСТАТОК | Движения по остаткам (+/- количество по баркодам) |
| `boxes` | БД_КОРОБЫ | События по коробам (создание, смена статуса, перемещение) |
| `box_contents` | БД_СОД_КОРОБОВ | Содержимое коробов (какие баркоды в каком коробе) |
| `charges` | БД_НАЧИСЛЕНИЯ | Финансовые начисления (авто и ручные) |

Журналы-детали (кроме `events`) связаны с событием через `event_id` FK.

### Справочники (editable + автоистория)

| Таблица | Что хранит | История |
|---|---|---|
| `clients` | Клиентов (имя, ИНН, контакты, ...) | `clients_history` (авто через триггер) |
| `products` | Товары (баркод, SKU, название, ...) | `products_history` |
| `employees` | Сотрудников (имя, email, роль) | `employees_history` |

Справочники **пополняются автоматически** при записи события: функции `ensure_client(name)`, `ensure_product(barcode, client_name)`, `ensure_employee(name)` создают запись, если её нет, и возвращают UUID. Никакого ручного импорта.

### Views для «текущего состояния»

- `v_current_stock` — остатки по клиенту+баркоду (сумма всех движений)
- `v_current_boxes` — текущее состояние каждого короба (последнее событие)

## operation_type — список типов событий

Это строковый тип в `events.operation_type`. Используем единые коды:

| Код | Что значит | Источник |
|---|---|---|
| `RECEPTION_REPORT` | Отчёт приёмки | GAS |
| `PACKING_REPORT` | Отчёт упаковки | GAS |
| `RELABEL_REPORT` | Отчёт перемаркировки | GAS |
| `PICKING_REPORT` | Отчёт подбора | GAS |
| `SHIPMENT_REPORT` | Отчёт отгрузки | GAS |
| `STOCK_ADJUSTMENT` | Ручная корректировка остатка | WEB_APP (форма) |
| `BOX_ADJUSTMENT` | Ручная корректировка короба | WEB_APP |
| `CLIENT_EDIT` | Создание/правка клиента | WEB_APP |
| `PRODUCT_EDIT` | Создание/правка товара | WEB_APP |
| `EMPLOYEE_EDIT` | Создание/правка сотрудника | WEB_APP |
| `CHARGE_MANUAL` | Ручное начисление/списание | WEB_APP |

`source` — откуда пришло событие: `GAS`, `WEB_APP`, `MANUAL`.

## Как записывается событие

Пример «Отчёт приёмки»: 1 клиент, 3 баркода, 2 короба.

1. Бэкенд получает payload от GAS.
2. `INSERT INTO events (operation_type='RECEPTION_REPORT', client_name='Еремин', request='0001-Еремин', ...)` → получили `event_id`.
3. Для клиента: `client_id = ensure_client('Еремин')` → подставляется в event.
4. По каждому баркоду: `INSERT INTO stock_movements (event_id, barcode, qty, ...)`. Параллельно `product_id = ensure_product(barcode, 'Еремин')`.
5. По каждому коробу: `INSERT INTO boxes (event_id, box_number, ...)` и `INSERT INTO box_contents (event_id, box_number, barcode, qty, ...)` для его содержимого.
6. Если операция создаёт начисление: `INSERT INTO charges (event_id, article, sum, ...)`.

Всё в одной транзакции — либо всё записалось, либо ничего.

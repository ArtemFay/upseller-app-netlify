# План миграции CalendOTG: Google Apps Script → Web App

> Утверждено 17 апреля 2026. Исходный GAS-проект сохранён в папке [GAS/](./GAS/) как бэкап и доступен для продолжения разработки при необходимости.

---

## Context

**Зачем это делается.** Текущий CalendOTG живёт как Google Apps Script проект (`Main.gs` + `Index.html` + лист `ОТГ_FILT`). Он работает, но:

- медленный (`google.script.run` даёт 2-3 сек задержки, 3-9 Sheets API вызовов за каждый редакт);
- не масштабируется — всё завязано на ограничениях GAS runtime и квотах Sheets API;
- нет нормальной авторизации (`access: ANYONE`), нет ролей, нет аудита изменений;
- невозможно добавить другие модули (склад, финансы) без того чтобы превратить один `Main.gs` в кашу.

**Что получаем.** Настоящее веб-приложение, открываемое по URL в браузере:

- главная страница = hub с карточками модулей (Календарь, Склад, Финансы — последние два пока disabled);
- модуль "Календарь отгрузок" с тем же функционалом что сейчас, но быстрее и с аудитом;
- вход через Google OAuth (только одобренные пользователи);
- **двусторонняя синхронизация** с исходной Google-таблицей — она остаётся как привычный инструмент;
- хостинг — бесплатные тарифы (Vercel Hobby + Supabase Free).

**Роли в работе.** Пользователь — не веб-разработчик, специалист по GAS. Ассистент пишет код, настраивает инфраструктуру, запускает деплои. Пользователь делает только то, где нужен его Google-аккаунт или физический клик: регистрация на сервисах, ввод паролей, одобрение OAuth, подтверждение алертов.

---

## Tech Stack (принято)

| Слой | Технология | Почему |
|---|---|---|
| Фронтенд | **Next.js 15 (App Router) + React 19 + TypeScript** | Full-stack, родной для Vercel, Server Actions = ментально близко к `google.script.run`, максимум готовых примеров для ассистента |
| Стили | **Tailwind CSS v4 + shadcn/ui** | Компоненты копируются в репо (можно править), быстро, ассистент знает идиомы |
| Таблица | **TanStack Table v8 + @tanstack/react-virtual** | Нативная React-таблица, легко расширять новыми типами ячеек, типобезопасная |
| Формы | react-hook-form + zod | Стандарт индустрии, zod-валидация расшаривается с API |
| Серверные данные | Server Actions + Supabase SSR SDK | Нет отдельного API-слоя; RLS = безопасность на уровне БД |
| Клиентский кеш | TanStack Query (React Query) | Кеш серверных данных + инвалидация |
| БД | **Supabase (PostgreSQL 15)** | Postgres + Auth + Realtime + Storage в одном пакете, free tier |
| Auth | Supabase Auth, провайдер Google OAuth | Одна галочка для включения, роли через `profiles.role` |
| Realtime | Supabase Realtime (Postgres CDC) — **включаем с первого дня** | Два+ пользователя видят правки друг друга без F5 |
| Sheets sync | `googleapis` (npm) + сервисный аккаунт `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` | Серверный доступ к Sheets, Edge Function каждую минуту |
| Sheets webhook | GAS installable `onEdit` trigger → POST в Next.js API route | Почти мгновенная синхра Sheets → сайт |
| Хостинг | **Vercel Hobby** | One-click deploy из GitHub, бесплатно |
| Git | GitHub (приватный репо) | |
| Dev tools | pnpm, ESLint, Prettier, Supabase CLI | |
| Мониторинг | Sentry (free) + UptimeRobot (free) | |
| Бэкапы | `pg_dump` через GitHub Actions → Supabase Storage | |

**Миграция данных:** импортируем **всю таблицу** `ОТГ_FILT` целиком в `shipments` на старте.

---

## Схема БД (ключевые таблицы)

Принцип: явные колонки для ~20 полей из `FIELD_DEFINITIONS` (которые редактируются/фильтруются в UI), остальное — в `extra JSONB`.

```sql
profiles(id uuid PK ← auth.users, email, full_name, role, ...)
    role: 'admin' | 'editor' | 'viewer'

shipment_statuses(code PK, label_ru, tone_class, sort_order, is_active)
drivers(id uuid PK, full_name UNIQUE, phone, is_active)
vehicles(id uuid PK, plate UNIQUE, description, is_active)
marketplaces(code PK, label_ru, tone_class)

shipments(
  id uuid PK,
  shipment_key text UNIQUE,             -- col L из Sheets
  shipment_id_display text,             -- col F
  source_row_number int, write_row_number int,
  shipment_date date,                   -- col AH
  status_code text FK→shipment_statuses,
  shipment_cost numeric(12,2),          -- col AR
  balance numeric(12,2),                -- col H
  volume int, rate text, shipment_type text, tare_type text,
  marketplace_code text FK, carrier text,
  destination_warehouse text, final_warehouse text, time_slot text,
  driver_id uuid FK, vehicle_id uuid FK,
  quality_control text, data_transferred text, barcode_applied text,
  comment text,
  extra jsonb DEFAULT '{}',             -- "хвост" из 40+ редко используемых столбцов
  source_updated_at timestamptz,        -- optimistic lock
  sheets_synced_at timestamptz,
  origin text DEFAULT 'sheets',         -- 'sheets' | 'web' — anti-loop
  is_deleted boolean DEFAULT false,
  created_at, updated_at
)

shipment_audit_log(
  id bigserial, shipment_id, shipment_key, actor_id,
  actor_source: 'web'|'sheets'|'system',
  operation: 'insert'|'update'|'delete',
  changes jsonb, occurred_at
)

sync_queue(
  id, shipment_id, shipment_key, operation, payload,
  attempts, last_error,
  status: 'pending'|'in_progress'|'done'|'failed',
  created_at, processed_at
)

sync_state(resource PK, last_polled_at, last_webhook_at, last_processed_row, notes)
```

**Индексы:**

- `shipments(shipment_date)`, `shipments(status_code)`, `shipments(driver_id)`, `shipments(vehicle_id)`, `shipments(shipment_key)`
- Partial: `shipments(shipment_date) WHERE is_deleted=false`
- FTS: `GIN tsvector('russian', ...)` по `shipment_id_display + destination_warehouse + final_warehouse + comment`
- `audit_log(shipment_id, occurred_at DESC)`
- `sync_queue(status, created_at) WHERE status IN ('pending','in_progress')`

**RLS (Row Level Security):**

- SELECT — все authenticated пользователи
- UPDATE — только роли `editor` и `admin`
- INSERT — только `admin`

---

## Двусторонняя синхронизация с Sheets

### Web → Sheets

```
UI edit → Server Action →
  1. UPDATE shipments (origin='web')
  2. INSERT shipment_audit_log
  3. INSERT sync_queue (pending)
  4. return OK (пользователь ждёт ≤100 мс)

pg_cron каждую минуту → Supabase Edge Function 'sheets-sync-worker':
  SELECT FROM sync_queue WHERE status='pending' LIMIT 50
  → batchUpdate через Sheets API
  → UPDATE sync_queue SET status='done', shipments.sheets_synced_at=now()
  (при ошибке: attempts++, если ≥5 → status='failed' + алерт)
```

### Sheets → Web

GAS installable `onEditInstalled` trigger на листе `🚚 ОТГ`:

- фильтрует: `sheet.getName() === '🚚 ОТГ'`, `row >= 13`
- **anti-loop слой 1:** если `e.user.getEmail() === 'sheets-bot@sheet-ai-491412.iam.gserviceaccount.com'` — пропускает
- иначе POST на `https://<domain>/api/sheets-webhook` с заголовком `X-Sheets-Secret`

На стороне Next.js `POST /api/sheets-webhook`:

- проверка секрета
- **anti-loop слой 2:** если `sheets_synced_at > now() - 10 сек` — это эхо нашего же write, игнорируем
- перечитывает строку через Sheets API (через `sheets-bot@`)
- upsert в `shipments` с `origin='sheets'`

**Fallback:** Edge Function `sheets-poll` раз в 5 минут — diff Sheets vs Supabase, резолв расхождений (для случая когда webhook упал).

**Конфликты:** last-write-wins + optimistic lock по `source_updated_at`. При `409 Conflict` — UI диалог "ваше / их / отменить". Для MVP можно упростить до простого overwrite, но audit_log ведём с первого дня.

---

## Roadmap (9 этапов, ~35 ч ассистента + ~4 ч пользователя)

### Этап 0 — Подготовка аккаунтов (0 ч / 1 ч)

**Пользователь:** GitHub (под `psgl2007@gmail.com`), Vercel (через GitHub), Supabase (через GitHub), установка Node.js 20+ и pnpm, создание приватного репо `calendotg-web`.

**Критерий:** `node --version` ≥ 20, дашборды Vercel и Supabase открываются.

### Этап 1 — Скелет Next.js + первый деплой (3-4 ч / 15 мин)

**Ассистент:**

- `create-next-app --ts --tailwind --app --src-dir`
- shadcn/ui init, базовые компоненты (Button, Card, Toast)
- Структура: `src/app/(hub)`, `src/app/(modules)/calendar`, `src/components/ui`, `src/lib`, `src/db`
- Палитра CSS-переменных из `Index.html` → Tailwind theme
- Пустой hub: "CalendOTG" + 3 карточки (Календарь / Склад / Финансы, последние две disabled)
- Push в GitHub

**Пользователь:** Vercel → Import Project → Deploy (5 кликов). Получает URL `calendotg-web.vercel.app`.

**Критерий:** URL открывается, hub виден, light/dark переключается.

### Этап 2 — Supabase + схема БД + полный импорт (4-5 ч / 30 мин)

**Ассистент:**

- SQL-миграции в `supabase/migrations/` (все таблицы + индексы + RLS)
- `scripts/import-from-sheets.ts`: читает `ОТГ_FILT!A2:BK` целиком через `sheets-bot@`, маппит столбцы, извлекает справочники (водители/авто/статусы), вставляет в `shipments` с `origin='sheets'`
- `@supabase/ssr` клиенты (server + client)
- Тестовая страница `/debug/shipments` (простая таблица из БД)

**Пользователь:**

- Supabase: Create Project (регион Frankfurt), сохранить DB password
- Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY` (JSON ключ сервис-аккаунта)

**Критерий:** в Supabase Table Editor виден `shipments` с полным объёмом данных, `/debug/shipments` показывает их.

### Этап 3 — Google OAuth авторизация (2-3 ч / 20 мин)

**Ассистент:**

- `/login` со Sign in with Google
- `middleware.ts` для защиты приватных маршрутов
- Хук `useUser()`, компонент `UserMenu`
- SQL-триггер `on_auth_user_created` — автосоздание `profiles.role='viewer'`

**Пользователь:**

- GCP (проект `sheet-ai-491412`): Credentials → Create OAuth 2.0 Client ID (Web), redirect URI = `https://<supabase>.supabase.co/auth/v1/callback`
- Supabase: Auth → Providers → Google → вставить Client ID/Secret
- Войти на сайте, ассистент поднимет роль до `admin` через SQL

**Критерий:** вход работает, имя в шапке, неавторизованный редирект на `/login`.

### Этап 4 — Календарь отгрузок: UI (read-only) (6-8 ч / 30 мин)

**Ассистент:**

- Страница `/modules/calendar` с layout: toolbar + вкладки по датам + таблица
- Server Component читает `shipments` за ±7 дней, группирует по датам
- **TanStack Table v8** + virtualization: колонки из `FIELD_DEFINITIONS`, tone-классы из `Index.html` как Tailwind-utility
- Вкладки дат (URL `?date=2026-04-17`)
- Глобальный поиск (client-side фильтр)
- Чекбокс "показать отгруженные" (`?includeShipped=1`)
- Loading / error states, Sonner toast
- Базовый responsive (скролл таблицы на телефоне)

**Критерий:** таблица эквивалентна текущему GAS-приложению, вкладки/поиск/фильтр работают. Редактирование ещё read-only.

### Этап 5 — Календарь: редактирование + Realtime (4-5 ч)

**Ассистент:**

- Server Action `updateShipment(id, changes)`: UPDATE + audit_log + sync_queue
- `useOptimistic` из React 19 для мгновенного UI-отклика
- Edit-in-place ячейки:
  - `status` → Select (из `shipment_statuses`)
  - `driver`, `vehicle` → Combobox с autocomplete из справочников
  - `comment` → Textarea в Popover
  - `quality_control` / `data_transferred` / `barcode_applied` → Select
  - `volume` → number input
- Индикатор "сохраняется/сохранено/ошибка" (dot + toast)
- **Realtime подписка** на `shipments` — при CDC-событии инвалидируем React Query кеш

**Критерий:** любое редактируемое поле сохраняется в БД, в `shipment_audit_log` пишется история, в `sync_queue` накапливаются pending. Две вкладки/два пользователя видят правки друг друга без F5.

### Этап 6 — Двусторонняя синхронизация с Sheets (6-8 ч / 30 мин)

**6a. Web → Sheets:**

- Edge Function `sheets-sync-worker` (Deno): читает `sync_queue`, batchUpdate в Sheets API
- `pg_cron` каждую минуту
- Тестирование: правка в UI → ≤60 сек → в таблице

**6b. Sheets → Web:**

- Код `onEditInstalled` для GAS (отдельный скрипт привязанный к таблице)
- `POST /api/sheets-webhook` с проверкой `X-Sheets-Secret`
- Fallback `sheets-poll` каждые 5 минут

**Пользователь:** в GAS-редакторе таблицы создать файл с кодом триггера, установить installable trigger, добавить `WEBHOOK_SECRET` в Script Properties.

**Критерий:** правка на сайте → видна в таблице; правка в таблице → видна на сайте; нет бесконечных циклов (проверка через audit_log).

### Этап 7 — Hub, настройки, справочники (2-3 ч)

**Ассистент:**

- Главная `/` — 3 карточки + последние события из audit_log + ссылка на Sheets
- `/settings/users` (для admin) — управление ролями
- `/settings/drivers`, `/settings/vehicles` — CRUD справочников
- Sidebar-навигация (shadcn/ui Sheet), breadcrumbs
- 404 / Error boundaries

**Критерий:** можно добавить водителя прямо на сайте, увидеть список пользователей.

### Этап 8 — Production hardening (3-4 ч / 30 мин)

**Ассистент:**

- **Бэкапы:** GitHub Action раз в сутки, `pg_dump` → Supabase Storage (приватный бакет), retention 30 дней
- **Мониторинг:** Sentry для Next.js и Edge Functions, UptimeRobot на `/api/health`
- **Алерты:** Edge Function раз в час — если `sync_queue.pending > 100` или `failed > 5` → Telegram / email (Resend free)
- **Оптимизация:** Lighthouse, Cache-Control, EXPLAIN топ-запросов
- `README.md`, `docs/runbook.md`

**Пользователь:** Sentry/UptimeRobot аккаунты, выбор куда слать алерты.

**Критерий:** тестовый алерт пришёл, последний дамп БД доступен, `/api/health` OK.

### Сводная таблица

| # | Этап | Ассистент | Пользователь | Результат |
|---|---|---|---|---|
| 0 | Аккаунты | 0 | 1 ч | Регистрация |
| 1 | Скелет + deploy | 3-4 | 15 мин | URL работает |
| 2 | БД + импорт | 4-5 | 30 мин | Данные в Supabase |
| 3 | Google OAuth | 2-3 | 20 мин | Вход через Google |
| 4 | Календарь UI | 6-8 | 30 мин | Таблица read-only |
| 5 | Edit + Realtime | 4-5 | 15 мин | Правки сохраняются, видны другим |
| 6 | Sheets sync | 6-8 | 30 мин | Двусторонняя синхра |
| 7 | Hub + настройки | 2-3 | 0 | Навигация, CRUD справочников |
| 8 | Production | 3-4 | 30 мин | Бэкапы, алерты |
| **Итого** | | **~35 ч** | **~4 ч** | Рабочий продукт в проде |

---

## Критичные файлы-источники (из GAS-бэкапа)

- [GAS/Main.gs](./GAS/Main.gs) — эталонный бэкенд: маппинг столбцов (`FIELD_DEFINITIONS`), нормализация дат (`normalizeSheetDate_`), форматирование (`formatFieldDisplayValue_`), resolve write-row (`resolveCurrentWriteRowNumber_`), Sheets API calls (`batchGetSheetValues_`). Всю бизнес-логику переносим 1-в-1.
- [GAS/Index.html](./GAS/Index.html) — эталонный UI: палитра CSS-переменных, tone-классы, структура toolbar/tabs/table, оптимистичные апдейты, индикатор статуса.
- [GAS/Соответствие столбцов Отгрузки - Календарь.csv](./GAS/Соответствие%20столбцов%20Отгрузки%20-%20Календарь.csv) — маппинг колонок между листами. Нужен для разбиения "явные колонки vs `extra JSONB`".
- [GAS/appsscript.json](./GAS/appsscript.json) — OAuth scopes (`spreadsheets`, `script.external_request`) — те же нужны для `sheets-bot@`.
- [GAS/Пример листа 🗓️ КЛД.csv](./GAS/Пример%20листа%20🗓️%20КЛД.csv) — понимание какие поля только отображаемые vs редактируемые.

---

## Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| Лимиты Sheets API (300 read/мин, 60 write/мин) | Средняя | Батчевые запросы, dedup в sync_queue, backoff. Объём ~500-800 отгрузок влезает в один batch. |
| Supabase free tier 500 MB | Низкая | 69 полей × полный объём ≈ 30-50 MB, с аудитом за год ≈ 300 MB. Алерт на 400 MB, ротация старого audit_log. |
| Supabase засыпает после 7 дней неактивности | Низкая | UptimeRobot health-check каждый час = проект всегда активен. |
| GAS onEdit trigger падает тихо | Средняя | Fallback polling каждые 5 минут + алерт при расхождении. |
| Race condition (одновременный edit в Sheets и на сайте) | Низкая | Optimistic lock по `source_updated_at` + полный audit_log. |
| OAuth consent в "Testing" — до 100 пользователей | Для внутреннего круга ок | Если внешние — заложить 2-6 недель на Google verification. |
| Утечка секретов (service account JSON, webhook secret) | Высокая при утечке | Только в Vercel env + Supabase secrets, не коммитим, rotate раз в полгода. |

---

## Verification (как проверить что работает end-to-end)

После этапа 6 прогоняем полный сценарий:

1. **Регистрация нового пользователя:** зайти с другого Google-аккаунта → проверить что `profiles.role='viewer'` → попробовать отредактировать → получить отказ (RLS).
2. **Повышение до editor:** SQL `UPDATE profiles SET role='editor' WHERE email=...` → обновить страницу → редактирование работает.
3. **Web → Sheets:** на сайте изменить статус отгрузки → через ≤60 сек открыть Sheets → увидеть новое значение в колонке BC.
4. **Sheets → Web:** в Sheets изменить комментарий в колонке BD → обновить сайт (или дождаться realtime) → увидеть новый комментарий.
5. **Anti-loop:** изменить статус на сайте → проверить что через 60 сек в таблице появилось → проверить что НЕ возникло второго события в `shipment_audit_log` с `actor_source='sheets'` (не зациклилось).
6. **Realtime:** открыть сайт в двух браузерах под разными пользователями → в одном изменить статус → во втором увидеть изменение без F5.
7. **Audit:** в `shipment_audit_log` должны лежать две записи: первая `actor_source='web'`, дальше никаких эхо-записей.
8. **Conflict:** в Sheets и на сайте одновременно изменить одну и ту же ячейку → UI показывает диалог / сохраняет last-write, audit фиксирует обе попытки.
9. **Поиск/фильтр:** глобальный поиск по фрагменту, чекбокс "показывать отгруженные" — работают как в текущем GAS.
10. **Health:** `GET /api/health` возвращает `{status:'ok', db:'ok', sheets:'ok'}`.

---

## Как объяснить стек специалисту по GAS

Ваш текущий CalendOTG — это три слоя, упакованные GAS в один:

| Слой | Что делает | В GAS | В новом приложении |
|---|---|---|---|
| **Фронтенд** | Всё что видно в браузере | `Index.html` + `<script>` | Next.js + React + Tailwind на Vercel |
| **Бэкенд** | Логика на доверенной стороне: работа с БД, проверка прав | Функции в `Main.gs` + `doGet()` | Server Actions + API routes в Next.js, исполняются на Vercel |
| **База данных** | Где хранятся данные | Лист `ОТГ_FILT` | PostgreSQL в Supabase |

Два связующих:

- **Git (GitHub)** = `clasp`, только для всего кода. Каждый коммит = чекпойнт, можно откатиться.
- **Хостинг (Vercel)** = "GAS Deploy as Web App". Слушает GitHub: коммит → автоматический пересбор и деплой за 30-60 сек.

**Что меняется vs GAS:**

1. Секреты строго на сервере (service account JSON, DB password) — в браузер не попадают.
2. Типы данных строже: `NULL`, `0`, `''` — это три разных состояния (в Sheets всё одно).
3. Нет "автосохранения" как в Sheets — каждое изменение это явный серверный вызов с возможностью фейла и retry.
4. Схема БД — отдельная сущность, меняется миграциями. Если забыть — старый код сломается.

**Что НЕ меняется:**

- Ваш лист `ОТГ_FILT` остаётся источником правды. Сайт — быстрое окно + аудит.
- Можно продолжать работать в Sheets напрямую — правки синхронизируются.
- Открыли Sheets — увидели актуальное состояние.

**Что улучшается:**

- Скорость (нет 3-сек `google.script.run`).
- Права доступа (RLS, роли).
- История изменений (audit_log).
- Расширяемость (склад/финансы — отдельные модули в том же hub).
- Одновременная работа нескольких пользователей без конфликтов.

---

## Следующий шаг

После утверждения плана — начинаем с **Этапа 0** (ваши аккаунты) и сразу же **Этапа 1** (скелет + первый деплой). К концу первой сессии у вас будет URL `calendotg-web.vercel.app` с пустым hub — тактильное ощущение "мы это делаем".

На каждом этапе я останавливаюсь перед действием которое требует вашего Google-аккаунта, даю пошаговую инструкцию (со скриншотами и точными названиями кнопок) и жду результата.

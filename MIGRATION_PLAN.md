# План миграции CalendOTG: Google Apps Script → Web App

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

**RLS:**
- SELECT — все authenticated
- UPDATE — только `editor` / `admin`
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
**Пользователь:** GitHub (under `psgl2007@gmail.com`), Vercel (через GitHub), Supabase (через GitHub), установка Node.js 20+ и pnpm, создание приватного репо `calendotg-web`.
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

## Критичные файлы-источники (из текущего GAS-проекта)

- [Main.gs](../../../../ai-projects/CalendOTG_CODEX/Main.gs) — эталонный бэкенд: маппинг столбцов (`FIELD_DEFINITIONS`), нормализация дат (`normalizeSheetDate_`), форматирование (`formatFieldDisplayValue_`), resolve write-row (`resolveCurrentWriteRowNumber_`), Sheets API calls (`batchGetSheetValues_`). Всю бизнес-логику переносим 1-в-1.
- [Index.html](../../../../ai-projects/CalendOTG_CODEX/Index.html) — эталонный UI: палитра CSS-переменных, tone-классы, структура toolbar/tabs/table, оптимистичные апдейты (л. 1742-1794), индикатор статуса (л. 874-936).
- [Соответствие столбцов Отгрузки - Календарь.csv](../../../../ai-projects/CalendOTG_CODEX/Соответствие%20столбцов%20Отгрузки%20-%20Календарь.csv) — маппинг колонок между листами. Нужен для разбиения явные колонки vs `extra JSONB`.
- [appsscript.json](../../../../ai-projects/CalendOTG_CODEX/appsscript.json) — OAuth scopes (`spreadsheets`, `script.external_request`) — те же нужны для `sheets-bot@`.
- [Пример листа 🗓️ КЛД.csv](../../../../ai-projects/CalendOTG_CODEX/Пример%20листа%20🗓️%20КЛД.csv) — понимание какие поля только отображаемые vs редактируемые.

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

---

> **Примечание 2026-04-17.** Первоначальный стек (Next.js + Supabase + Vercel) был пересмотрен. Фактически запущено: Netlify + Netlify Functions (ESM), auth через Google Identity Services + JWT в cookie, whitelist в Netlify Blobs, доступ к Sheets через OAuth refresh token. Сайт работает на `https://upseller-app.netlify.app`, модуль `/calend-otg/` уже в проде. Ниже — план второго модуля.

---

# Модуль 2: Складской учёт с аудитом транзакций

## Context

**Зачем это делается.** Fulfillment-склад 1000 м² с товарами разных клиентов страдает от накопления расхождений между физическими остатками и учётом. Главный источник истины — лист `🍬 КОРОБЫ`, но он хранит только текущее состояние без истории. Операторы подбора, КРО, менеджеры вносят ручные правки без фиксации причины → "тихие" инвентаризации ломают баланс. Нет возможности ответить на вопрос "куда делось 15 штук товара X?"

**Что получаем.** Иммутабельный журнал всех движений на складе с обязательным указанием причины для любой правки. Прозрачная хронология по каждому barcode. Сверка расчётного vs физического остатка (reconciliation). Невозможность изменить остаток иначе как через транзакцию. На этапе 7 — **полный запрет ручных правок в Sheets**, всё через веб-сайт с reason и ролью admin.

**Принципы (best practice из WMS/ERP мира):**
1. **Event Sourcing + double-entry movements** — стандарт в Odoo `stock.move`, SAP EWM. Каждое движение — дебет+кредит по (client × barcode × статус × короб).
2. **Append-only log** — никаких UPDATE/DELETE на событиях, ошибки компенсируются REVERSAL.
3. **Projection first, enforcement later** — сначала наблюдаем, потом запрещаем.
4. **Transactional outbox** — Apps Script складывает события в `__outbox`, cron-функция шлёт их на webhook с ретраями.
5. **Idempotency** — каждое событие имеет `external_id`, дубли отбрасываются.

## Решения пользователя

1. **Точка отсчёта — снимок на день запуска.** Историю "до" не восстанавливаем. Первая транзакция в журнале = INVENTORY_COUNT на все коробы на дату bootstrap.
2. **Жёсткое enforcement на этапе 7.** Ручные правки в `🍬 КОРОБЫ` запрещены через Apps Script + range protection. Изменения идут только через сайт, только админ, обязательно с причиной.
3. **Миграция на service account.** Переходим с личного OAuth refresh token на `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com`. Я настрою, пользователь расшарит таблицу на email сервис-аккаунта.
4. **Уведомления — email через Resend** (free tier, ≤100 писем/день).

## Tech stack (принято)

| Слой | Технология | Обоснование |
|---|---|---|
| БД | **Neon Postgres** (serverless, free 0.5 GB) | HTTP-подключение без connection pool → идеально для Netlify Functions. Запас на 3+ года событий. |
| Драйвер | `@neondatabase/serverless` | Native HTTP-режим |
| Миграции | `drizzle-kit` + `drizzle-orm` | Типизация схемы + типобезопасные query |
| Backend | Netlify Functions (уже есть), новые `/api/stock/*` | Переиспользуем `_lib/auth.js`, `_lib/google.js` |
| Доступ к Sheets | Google service account (новый секрет `GOOGLE_SERVICE_ACCOUNT_KEY`) | Не зависит от личного Google пользователя |
| Sheets → БД | Apps Script `onEdit` + `onChange` → лист `__outbox` → cron flush раз в минуту → webhook `/api/stock/ingest` | Стандартный outbox pattern |
| БД → Sheets | Netlify scheduled function раз в сутки: пересчёт проекции → обновление `🆗 ОСТАТКИ` (этап 6+) | Reflection, не источник |
| Email алерты | Resend (free 100/день) | `RESEND_API_KEY` в env |
| Frontend | Ванильный HTML+JS с Chart.js (как в `/calend-otg/`) | Консистентно, без нового фреймворка |

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

```
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
- Завести Neon-проект (я через CLI, пользователь даст approval в Neon console)
- DATABASE_URL в Netlify env
- Drizzle миграции всех таблиц раздела "Схема БД"
- `_lib/db.js` (Neon HTTP клиент)
- `_lib/stock.js` (CRUD-хелперы)
- Роуты `/api/stock/products`, `/api/stock/balance` — пустые массивы
- `/sklad/` — скелет, переиспользует auth из `/calend-otg/`
- Активация тайла "Склад" на главной

**Пользователь:** регистрация Neon через GitHub, разрешить создание проекта (1-2 клика).
**Критерий:** открывается `/sklad/`, видно "данные появятся после этапа 2".

### Этап S2 — Bootstrap снимок + миграция на service account [4-5 ч]
**Ассистент:**
- Сгенерировать ключ service account `sheets-bot@sheet-ai-491412`, положить в Netlify env как `GOOGLE_SERVICE_ACCOUNT_KEY`
- Переключить `_lib/google.js` с OAuth refresh token на service account auth (fallback: OAuth пока)
- Скрипт `/api/stock/bootstrap` (admin-only, за feature flag): читает `🍬 КОРОБЫ` целиком, создаёт `clients`, `products`, `boxes`, одно событие `INVENTORY_COUNT` с `external_id='bootstrap-YYYY-MM-DD'`, ADJUSTMENT на полный qty каждого короба
- Сверка с `🆗 ОСТАТКИ` — расхождения идут в `reconciliation_findings`

**Пользователь:** расшарить таблицу `1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q` на `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` с правом "Редактор" (один клик).
**Критерий:** `/sklad/` показывает текущие остатки клиент × barcode × статус; они совпадают с `🆗 ОСТАТКИ`.

### Этап S3 — Живой захват отгрузок [3-4 ч]
**Ассистент:**
- Apps Script: создаёт лист `__outbox` в таблице, пишет installable `onEdit` триггер на КОРОБЫ
- Скрипт `flushOutbox` на cron 1 мин: шлёт события на `/api/stock/ingest`
- `/api/stock/ingest` принимает SHIPMENT и STAGE события
- UI: на карточке barcode видно последние отгрузки

**Пользователь:** в Apps Script редакторе вставить код, установить installable trigger. Добавить `INGEST_TOKEN` в Script Properties.
**Критерий:** меняю статус короба на "ОТГРУЖЕНО" → через ≤90 сек событие SHIPMENT в БД.

### Этап S4 — UI-история (read-only) [4-5 ч]
**Ассистент:**
- Timeline barcode, карточка короба
- Журнал событий `/sklad/events`
- Chart.js графики (stacked area по статусам)
- Экспорт CSV

**Критерий:** на карточке barcode с известной историей движений видна полная хронология.

### Этап S5 — Приёмки и внутренние переводы [4-5 ч]
**Ассистент:**
- Расширение `/api/stock/ingest` для типов RECEIPT, PUTAWAY, PICK
- Маппинг из `📋 ПОСТАВКИ` → RECEIPT с reference на `№ПОС`
- Связка с `РЕД ПОСТ` — правки идут как ADJUSTMENT с reason=WRONG_COUNT_AT_RECEIPT
- Apps Script триггеры на ПОСТАВКИ и РЕД ПОСТ

**Критерий:** создание новой поставки в Sheets → в БД появляется цепочка RECEIPT → PUTAWAY.

### Этап S6 — Reconciliation dashboard + email алерты [3-4 ч]
**Ассистент:**
- Netlify scheduled function ежедневно 03:00 МСК: REFRESH MATERIALIZED VIEW, поиск негативных балансов, сверка суммы КОРОБЫ с `stock_balance_live` → `reconciliation_findings`
- Email через Resend (ENV: `RESEND_API_KEY`) если severity=critical
- UI `/sklad/recon` с кнопкой "разобрать" → предзаполненная форма ADJUSTMENT

**Пользователь:** регистрация Resend (2 мин), API key в Netlify env.
**Критерий:** за неделю наблюдения приходит email при расхождении, в UI виден список findings.

### Этап S7 — Enforcement: запрет ручных правок [4-5 ч]
**Ассистент:**
- Apps Script: range protection на `🍬 КОРОБЫ` (editors = только sheets-bot@ и owner)
- Скрипт `onEdit` откатывает любое изменение кроме service account
- UI `/sklad/adjust` для admin-a — форма с обязательным reason_code + reason_text, создаёт ADJUSTMENT событие, затем service account пишет результат обратно в КОРОБЫ
- Scheduled reflection: раз в сутки переписать `🆗 ОСТАТКИ` из БД
- Все спецоперации (REMARK, RECLASS, WRITE_OFF) — только через сайт

**Пользователь:** объявить сотрудникам склада за 2 недели. В час X — переключение.
**Критерий:** попытка правки КОРОБЫ оператором автоматически откатывается; все изменения происходят через сайт с reason.

### Сводка

| # | Этап | Ассистент | Пользователь | Результат |
|---|---|---|---|---|
| S1 | Neon + скелет | 4-6 | 15 мин | `/sklad/` открывается |
| S2 | Bootstrap + service account | 4-5 | 5 мин | Остатки в БД = остатки в Sheets |
| S3 | Захват отгрузок | 3-4 | 10 мин | SHIPMENT события живые |
| S4 | UI-история | 4-5 | — | Timeline по barcode |
| S5 | Приёмки и переводы | 4-5 | — | Весь жизненный цикл короба |
| S6 | Reconciliation + email | 3-4 | 5 мин (Resend) | Дашборд и алерты |
| S7 | Enforcement | 4-5 | объявление сотрудникам | Ручные правки невозможны |
| **Итого** | | **~30 ч** | **~35 мин + политика** | Полный аудит + дисциплина |

## Критичные файлы

- [web/netlify/functions/_lib/google.js](../../ai-projects/CalendOTG_CODEX/web/netlify/functions/_lib/google.js) — существующий Sheets-клиент (переведём на service account в S2)
- [web/netlify/functions/_lib/auth.js](../../ai-projects/CalendOTG_CODEX/web/netlify/functions/_lib/auth.js) — `requireUser`/`requireAdmin`
- [web/netlify.toml](../../ai-projects/CalendOTG_CODEX/web/netlify.toml) — новые редиректы `/api/stock/*` и scheduled function
- [web/index.html](../../ai-projects/CalendOTG_CODEX/web/index.html) — тайл "Склад" (сейчас disabled) — оживляем в S1
- [web/netlify/functions/package.json](../../ai-projects/CalendOTG_CODEX/web/netlify/functions/package.json) — добавляются `@neondatabase/serverless`, `drizzle-orm`, `resend`
- [GAS/Main.gs](../../ai-projects/CalendOTG_CODEX/GAS/Main.gs) — образец Apps Script, на нём строим outbox для КОРОБЫ

## Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| Apps Script trigger падает | Средняя | Outbox + ретраи + ночная scheduled-сверка дописывает пропущенные события |
| Neon free tier 0.5 GB | Низкая | Оценка объёма: 180k событий/3года × 500 байт ≈ 180 MB. 3-кратный запас. |
| Сопротивление сотрудников enforcement'у | Высокая | Объявление за 2 недели, обучение, логи кто что пытался править |
| Дрейф между БД и Sheets | Средняя | Ночная reconciliation + авто-алерт email |
| Негативные остатки в проекции | Средняя | Check в scheduled function, автоматически заводит finding severity=critical |
| Утечка service account key | Критическая при утечке | Только в Netlify env, .gitignore, rotate раз в полгода |

## Verification (как проверить end-to-end после S6)

1. **Целостность bootstrap:** `SELECT COUNT(*) FROM stock_events WHERE type='INVENTORY_COUNT' AND external_id LIKE 'bootstrap-%';` = 1 событие на каждый непустой короб.
2. **Совпадение остатков:** `SELECT * FROM stock_balance_live WHERE (client_id, product_id, status) NOT IN (SELECT ... FROM 🍬 КОРОБЫ via Sheets API);` = 0.
3. **Захват отгрузки:** меняю статус короба → "ОТГРУЖЕНО" в Sheets → через ≤90 сек `/sklad/product/<barcode>` показывает новое SHIPMENT событие.
4. **Правка КОЛ без reason:** меняю `КОЛ` в коробе с 30 на 25 → в течение 5 мин приходит email "обнаружено ADJUSTMENT без reason, короб Б3403-001, -5 шт, оператор X".
5. **Инвентаризация:** создаю сессию для клиента Y, ввожу counts, закрываю → для каждой delta≠0 создан ADJUSTMENT с reason=PHYSICAL_RECOUNT, остатки обновились.
6. **Reconciliation:** намеренно правлю ячейку `КОЛ` в КОРОБЫ → ночью находится расхождение, в `/sklad/recon` появляется finding severity=critical, приходит email.
7. **Запрет правок (после S7):** оператор правит ячейку → Apps Script откатывает через 2 сек, оператор получает popup "используйте сайт".
8. **Полная история:** открываю `/sklad/product/<известный barcode>`, вижу RECEIPT → PUTAWAY → PICK → STAGE → SHIPMENT в timeline.

## Метрики успеха

- Покрытие журнала: ≥99.5% изменений в КОРОБЫ имеют соответствующее stock_event (измерение через ночную сверку)
- Нулевое расхождение: `reconciliation_findings` kind='SHEET_DRIFT' severity='critical' = 0 за 14 дней подряд
- Все ADJUSTMENT с причиной: 100%
- MTTR расхождений: <24 часа от detection до resolution
- P95 отставания Sheets→БД: <2 мин, P99 <10 мин

## Следующий шаг

После утверждения плана начинаем с **этапа S1** (Neon + скелет). Нужна ваша регистрация на Neon через GitHub (2-3 мин), дальше я настраиваю всё сам. Ключевое событие: **этап S2** — вы один раз расшариваете таблицу на `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com`. С этого момента весь учёт не зависит от вашего личного Google-аккаунта.

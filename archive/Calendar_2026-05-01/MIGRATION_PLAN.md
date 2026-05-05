---
file: Calendar/MIGRATION_PLAN.md
purpose: Миграция модуля «Календарь отгрузок» с Google Apps Script на web. Что было запланировано, что фактически реализовано, что осталось сделать.
last_updated: 2026-04-28
---

# Migration Plan — Календарь отгрузок

История и текущее состояние миграции CalendOTG: с Google Apps Script-приложения на web-модуль на Netlify.

## 1. Контекст

### Что мигрируем

Исходный CalendOTG — Google Apps Script-проект:

- `Main.gs` + `Index.html` + лист `🚚 ОТГ` (через витрину `ОТГ_FILT`).
- `doGet()` отдаёт `Index.html`, `google.script.run` — серверные вызовы.
- Доступ `ANYONE` (без авторизации, без ролей).

См. legacy-проект: [`3_gas/CalendOTG_CODEX/`](../../../3_gas/CalendOTG_CODEX/) (источник истины при сверке поведения).

### Зачем мигрировали

- **Скорость**: `google.script.run` даёт 2–3 сек задержки, 3–9 Sheets API вызовов на каждый редакт.
- **Авторизация**: GAS-приложение публично, нет ролей, нет аудита изменений.
- **Расширяемость**: невозможно добавить другие модули (Инвент, Подборы, Финансы) без превращения `Main.gs` в кашу.
- **Единая точка входа**: один сайт `upseller-app.netlify.app` на всю компанию вместо россыпи GAS-веб-приложений.

### Что получили

Web-приложение на `https://upseller-app.netlify.app/calend-otg/` с тем же функционалом, но быстрее и с авторизацией. Источник данных — та же Sheets-таблица `🚚 ОТГ` (read+write), таблица остаётся привычным инструментом.

## 2. История стека

### Запланированный стек (апрель 2026)

Изначально планировался полноценный SaaS-стек:

- **Frontend**: Next.js 15 + React 19 + Tailwind + shadcn/ui.
- **БД**: Supabase PostgreSQL с Realtime, RLS, Auth.
- **Хостинг**: Vercel Hobby.
- **Sheets sync**: двусторонняя через Edge Functions + GAS webhook.
- **Дополнительно**: TanStack Table, audit log, materialized views, бэкапы через `pg_dump`, Sentry, UptimeRobot.

Полный исходный план — в [`../archive/MIGRATION_PLAN.md`](../archive/MIGRATION_PLAN.md) (исторический референс).

### Фактический стек (на 2026-04-28)

В апреле 2026 план пересмотрен в сторону минимизации:

- **Frontend**: статический HTML+JS+CSS, без фреймворка ([`web/calend-otg/`](../web/calend-otg/)).
- **Backend**: Netlify Functions (ESM, Node 20). Главные функции: [`calendar.js`](../web/netlify/functions/calendar.js), [`update-shipment.js`](../web/netlify/functions/update-shipment.js), [`bootstrap.js`](../web/netlify/functions/bootstrap.js).
- **БД**: НЕТ (источник правды — Sheets `🚚 ОТГ`). Чтение/запись напрямую через Sheets API.
- **Sheets-доступ**: OAuth refresh-token владельца (`psgl2007@gmail.com`) через [`_lib/google.js`](../web/netlify/functions/_lib/google.js).
- **Auth**: Google Identity Services (web client) + JWT в cookie + whitelist в `@netlify/blobs.users`. Управление whitelist — [`users.js`](../web/netlify/functions/users.js) и страница `/admin/`.
- **Хостинг**: Netlify (Free tier). Деплой: GitHub-push в `ArtemFay/CalendOTG_CODEX` → автосборка.

### Почему отказались от Supabase/Vercel/Next.js

1. **БД оказалась преждевременной**: `🚚 ОТГ` — это уже работающая модель данных, переносить её в Postgres = переписывать всю логику без выгоды на старте.
2. **Vercel и Supabase free tier** требуют оплаты картой (РФ-проблема). **Netlify Free** работает без карты.
3. **Next.js + React** избыточны для приложения с одной таблицей и фиксированным набором действий. Ванильный JS + динамическая разметка читается всеми (включая GAS-инженера).
4. **Realtime между сессиями** оказался ненужным: 1–2 пользователя одновременно, конфликтов почти нет, last-write-wins на уровне Sheets.

## 3. Текущее состояние (что работает)

| Подсистема | Статус | Где живёт |
|---|---|---|
| Чтение `🚚 ОТГ` (~600 строк, 69 колонок) | ✅ работает | [`calendar.js`](../web/netlify/functions/calendar.js) → `_lib/shipments.js`. Колонки маппятся в JSON; редко используемые остаются в `extra`. |
| Редактирование ячеек (статус, водитель, авто, ОТК, комментарий) | ✅ работает | [`update-shipment.js`](../web/netlify/functions/update-shipment.js). Optimistic UI на фронте, write идёт в Sheets API. |
| Группировка по датам, табы дат, поиск, фильтр «показывать отгруженные» | ✅ работает | [`web/calend-otg/`](../web/calend-otg/) — статический фронт. |
| Google OAuth + whitelist | ✅ работает | [`auth-login.js`](../web/netlify/functions/auth-login.js), [`auth-me.js`](../web/netlify/functions/auth-me.js), [`users.js`](../web/netlify/functions/users.js). Сессия — JWT в cookie `upseller_session`. |
| Bootstrap (первичная загрузка справочников: статусы, водители, авто, МП) | ✅ работает | [`bootstrap.js`](../web/netlify/functions/bootstrap.js) — отдаёт фронту constants одним запросом. |

## 4. Что НЕ сделано из исходного плана

| Что | Был план | Нужно ли |
|---|---|---|
| **Двусторонняя синхра Sheets ↔ БД** | Edge Function каждую минуту + `onEdit` webhook | ❌ не нужно — БД нет, источник один (Sheets) |
| **Audit log** изменений | `shipment_audit_log` в Postgres | ⚠️ нет; полезно бы иметь — кто что менял. Можно реализовать как append-only лист `🚚 ОТГ_AUDIT` в той же Sheets, без БД. |
| **Realtime между сессиями** | Supabase Realtime CDC | ❌ не нужно при текущих 1–2 одновременных пользователях |
| **RLS / роли** | `profiles.role` в Postgres + RLS | ⚠️ частично: whitelist есть, но роли (admin/editor/viewer) пока не дифференцируются — всякий, кто прошёл whitelist, может всё. |
| **Бэкапы** | `pg_dump` через GitHub Actions | ❌ не нужно — Sheets сама себе бэкап (Google version history) |
| **Мониторинг** Sentry / UptimeRobot | Бесплатные тарифы | ⚠️ нет; стоит подключить хотя бы UptimeRobot на `/api/health`, чтобы знать о падениях |
| **Optimistic lock** при concurrent edits | `source_updated_at` в Postgres | ❌ практически не нужно при 1–2 пользователях. Last-write-wins достаточно. |

## 5. Roadmap дальнейшей миграции

Если/когда понадобится:

### Этап C+1: Audit log (1–2 ч)

Добавить append-only лист `🚚 ОТГ_AUDIT` в той же таблице UPSELLER. Каждый `update-shipment` пишет одну строку: `[ts, user, shipment_key, field, old_value, new_value]`. Всё, БД не требуется.

### Этап C+2: Дифференциация ролей (2–3 ч)

В whitelist (`@netlify/blobs.users`) добавить поле `role: 'admin' | 'editor' | 'viewer'`. В функциях `update-shipment` / `users` — middleware, проверяющий роль.

### Этап C+3: Health-monitoring (15 минут)

`GET /api/health` уже есть (или добавить). Зарегистрировать в UptimeRobot бесплатно (10 минут), пинговать раз в 5 минут.

### Этап C+4: Миграция в БД (3–5 дней работы — большая задача)

Имеет смысл **только** если потребуется:

- Сложная аналитика по отгрузкам (графики, прогнозы).
- Realtime обновления при 5+ одновременных пользователях.
- Длинная история изменений с быстрым поиском (audit-лист в Sheets перестал помещаться в 50k строк).

Целевой стек по новым реалиям 2026:

- БД: **Neon Postgres** (free 0.5 GB, HTTP-режим — отлично подходит для Netlify Functions).
- ORM: `drizzle-orm` + `drizzle-kit` (type-safe миграции).
- Sheets → БД: append-only outbox в Sheets + cron в Netlify Scheduled Functions.
- БД → Sheets: scheduled reflection раз в сутки (если Sheets всё ещё используется как UI).

Это **не приоритет**. Решение принимать только при появлении реальной потребности.

## 6. Ссылки

- [`Calendar/README.md`](README.md) — карта модуля (где статика, функции, либы).
- [`../CONTEXT.md`](../CONTEXT.md) — структура всего Netlify-сайта.
- [`../archive/MIGRATION_PLAN.md`](../archive/MIGRATION_PLAN.md) — исторический оригинал (Next.js + Supabase + Vercel-план, не реализован).
- [`../../../3_gas/CalendOTG_CODEX/`](../../../3_gas/CalendOTG_CODEX/) — исходный GAS-проект как референс.
- [`../../../1_CONST/03_CURRENT_GAS_SYSTEM.md`](../../../1_CONST/03_CURRENT_GAS_SYSTEM.md) §6 — описание GAS-проекта `CalendOTG_CODEX`.
- [`../../../1_CONST/04_TARGET_WEB_SYSTEM.md`](../../../1_CONST/04_TARGET_WEB_SYSTEM.md) — целевая web-архитектура (общая для всех модулей).

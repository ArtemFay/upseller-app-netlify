# Podbor — модуль «Подбор»

Web-приложение подборщика для планшета / телефона / ТСД. Заменяет ручную работу в Sheets-таблицах «Планшет N».

URL на проде: `https://82-97-249-207.sslip.io/podbor/`

## Где что лежит

> **Источник правды для кода — `web/`**. Эта папка (`Podbor/`) содержит только документацию.

| Что | Где |
| --- | --- |
| **Бизнес-логика, инварианты, UX** | [`CONTEXT.md`](CONTEXT.md) ← **главный источник истины** для модуля |
| **Бизнес-правила режимов сборки** (СВОБ / КОР / КОР+) и типов заявок (ОТГ / ПЕР) | [`1_CONST/02_BUSINESS_PROCESSES.md`](../../../1_CONST/02_BUSINESS_PROCESSES.md) § «Подбор и отгрузка» |
| **План синхронизации Web → UPSELLER** | [`SYNC_BACKEND_PLAN.md`](SYNC_BACKEND_PLAN.md) + [`SYNC_BACKEND_PLAN_REVIEW.md`](SYNC_BACKEND_PLAN_REVIEW.md) |
| **Стандарт работы на ТСД** (Urovo DT40) | [`TSD_STANDARD.md`](TSD_STANDARD.md) |
| **Прод-фронт (статика)** | [`../web/podbor/`](../web/podbor/) |
| **Прод-бэкенд** | [`../web/api/podbor-*.js`](../web/api/) |
| **Общая логика подбора** (ESM) | [`../web/api/_lib/podbor/`](../web/api/_lib/podbor/) |
| **Сервер сайта** | [`../server/server.js`](../server/server.js) — единый Express для всех модулей |

## Контракт API

| URL | Что |
| --- | --- |
| `GET /api/podbor/zayavki-list` | Все активные заявки + клиенты |
| `GET /api/podbor/load?client=…` | Коробы клиента + availability |
| `POST /api/podbor/sync` | Mock-sync verified-флагов (TODO: полный sync по `SYNC_BACKEND_PLAN`) |

Все production-эндпоинты обёрнуты в `requireUser(request)` → 401 без авторизации. Локально с `AUTH_DISABLED=true` все запросы проходят как `dev@local`.

## Локальный запуск

После унификации Google-доступа на сервис-аккаунт локальная разработка идёт **через единый сервер сайта**:

```bash
cd ../server
npm install
npm run dev
```

Открыть `http://localhost:3010/podbor/` — Подбор работает в полном функционале (чтение и запись Sheets через сервис-аккаунт `sheets-bot@`), плюс бок о бок с Инвентом, Приемкой и страницами авторизации. Это ровно то, что развёрнуто на VPS — проверка функционала локальная = проверка прод-флоу.

## Legacy: `local-dev/` (удалена)

Бывшая папка `local-dev/` — автономный Node-сервер только под Подбор (CommonJS, порт 3001, собственная auth-stub). Удалена 2026-05-05 после унификации модулей под единый сервер `server/server.js` и единый сервис-аккаунт. Бизнес-логика подбора теперь в [`../web/api/_lib/podbor/`](../web/api/_lib/podbor/) (ESM); бизнес-документация перенесена в [`CONTEXT.md`](CONTEXT.md) этого модуля.

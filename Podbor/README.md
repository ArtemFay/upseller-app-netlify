# Podbor — модуль «Подборы»

Web-приложение подборщика для планшета / телефона / ТСД. Заменяет ручную работу в Sheets-таблицах «Планшет N».

URL на проде: <https://upseller-app.netlify.app/podbor/>

## Где что лежит

| Что | Где |
|---|---|
| **Бизнес-логика, инварианты, UX** | [`local-dev/CONTEXT.md`](local-dev/CONTEXT.md) ← **главный источник истины** |
| **Локальный dev-сервер** | [`local-dev/`](local-dev/) → `npm run dev` → `http://localhost:3001` |
| **Прод-фронт (статика)** | [`../web/podbor/`](../web/podbor/) |
| **Прод-бэкенд** (Netlify Functions) | [`../web/netlify/functions/podbor-*.js`](../web/netlify/functions/) |
| **Общая логика подбора** (ESM) | [`../web/netlify/functions/_lib/podbor/`](../web/netlify/functions/_lib/podbor/) |

## Контракт API

| URL (прод) | URL (local-dev) | Что |
|---|---|---|
| `GET /api/podbor/zayavki-list` | `GET /api/zayavki-list` | Все активные заявки + клиенты |
| `GET /api/podbor/load?client=…` | `GET /api/load?client=…` | Коробы клиента + availability |
| `POST /api/podbor/sync` | `POST /api/sync` | Mock-sync verified-флагов |

Все production-эндпоинты обёрнуты в `requireUser(request)` → 401 без авторизации.

## Цикл разработки

1. Правишь в [`local-dev/`](local-dev/) (фронт `public/*` или CommonJS-логика `lib/*`) — мгновенный live-reload через browser-sync.
2. Стабилизировав изменения — синхронизируешь с прод-кодом:
   - `local-dev/public/*` → `../web/podbor/*`
   - `local-dev/lib/active-zayavki.js` → `../web/netlify/functions/_lib/podbor/zayavki.js` (CommonJS → ESM, см. README в `local-dev/`)
   - `local-dev/lib/podbory-load.js` → `../web/netlify/functions/_lib/podbor/boxes.js`
3. Коммит из корня `Netlify/`, push → Netlify автоматически деплоит.

В перспективе автоматизируем синхронизацию (общий npm-workspace или build-step).

---
file: 2_web/Netlify/CONTEXT.md
purpose: Корневая папка единого Netlify-сайта Upseller. Содержит фронтенд агрегатора, общий backend (Netlify Functions), модули Calendar/Invent/Podbor и локальные dev-сервера.
last_updated: 2026-04-27
---

# Upseller — Netlify-сайт (`upseller-app.netlify.app`)

Корневая папка **единого Netlify-сайта**, на котором живут все web-инструменты UpSeller с общей авторизацией Google OAuth.

- **Деплой**: GitHub-push в `ArtemFay/CalendOTG_CODEX` (ветка `main`) → Netlify build → publish `web/`.
- **Прод-URL**: <https://upseller-app.netlify.app/>.
- **Auth**: Google OAuth + JWT-cookie (`upseller_session`); whitelist пользователей в `@netlify/blobs.users`.
- **GitHub-репозиторий называется `CalendOTG_CODEX`** — историческое имя, можно переименовать на GitHub UI (Settings → Rename) без потери Netlify-привязки.

## Структура

```
Netlify/                                ← корень сайта (одно git-репо, один деплой)
├── README.md  CONTEXT.md               ← общая документация
├── MIGRATION_PLAN.md                   ← старый план миграции CalendOTG (исторический)
├── archive/                            ← исторические артефакты
├── scripts/
│   └── regenerate-refresh-token.mjs    ← починка invalid_grant Google OAuth
│
├── Calendar/                           ← рабочее пространство модуля «Календарь»
│   └── README.md                       ← карта модуля (где статика, функции, либы)
├── Invent/                             ← рабочее пространство модуля «Инвент»
│   └── README.md
├── Podbor/                             ← рабочее пространство модуля «Подборы»
│   ├── README.md
│   └── local-dev/                      ← локальный Node.js dev-сервер
│       ├── server.js  package.json
│       ├── lib/                        # CommonJS-логика
│       ├── public/                     # фронт
│       ├── .env                        # SA-ключ + IDs (gitignored)
│       └── CONTEXT.md                  # ← БИЗНЕС-ЛОГИКА Подборов (главный источник)
│
└── web/                                ← publish-каталог Netlify (НЕ переименовывать)
    ├── index.html                      ← главная (плитки модулей)
    ├── netlify.toml                    ← redirects + bundling
    ├── favicon.svg
    ├── login/  admin/                  ← общие auth-страницы
    ├── calend-otg/                     ← статика Календаря
    ├── invent-tablet/                  ← (рендерится SSR из invent-view.js)
    ├── podbor/                         ← статика Подборов
    ├── supabase/                       ← SQL-миграции (если связаны)
    └── netlify/
        └── functions/                  ← все backend-функции
            ├── auth-login.js  auth-me.js  auth-logout.js
            ├── calendar.js  update-shipment.js  bootstrap.js
            ├── invent-view.js  invent-run.js
            ├── podbor-zayavki-list.js  podbor-load.js  podbor-sync.js
            ├── users.js                # admin: whitelist
            ├── package.json            # deps функций (ESM)
            └── _lib/
                ├── auth.js  google.js  users.js  shipments.js   # общие
                ├── invent/             # либы инвент-модуля
                └── podbor/             # либы подбор-модуля
```

### Почему `web/` остаётся отдельной папкой, а не «сливается» с модулями

`web/` — это **publish-каталог Netlify** (`publish = "."` относительно `web/` в Netlify Build settings). Это требование Netlify: всё что хостится — должно быть в одной папке, которую Netlify собирает и заливает на CDN. Менять её имя/структуру нельзя без пересоздания Netlify-сайта.

Папки модулей (`Calendar/`, `Invent/`, `Podbor/`) — это **рабочие пространства разработчика**: документация, локальный dev, ссылки на части в `web/`. Когда работаешь в `Podbor/`, ты концептуально в одном месте, и `Podbor/README.md` ведёт по всем физическим артефактам модуля (`web/podbor/` для прод-фронта, `web/netlify/functions/podbor-*.js` для прод-бэка, `Podbor/local-dev/` для итераций).

Если в будущем захочется «всё-в-одной-папке» — нужен build-step (например, `Calendar/web/*` копируется в `web/calend-otg/*` перед деплоем). Это значимое усложнение, пока не нужно.

## Модули — точки входа

| Модуль | Прод-URL | Документация |
|---|---|---|
| Главная | `/` | этот файл |
| Календарь | `/calend-otg/` | [`Calendar/README.md`](Calendar/README.md) |
| Инвент-Планшет | `/invent-tablet/` | [`Invent/README.md`](Invent/README.md) |
| Подборы | `/podbor/` | [`Podbor/README.md`](Podbor/README.md) + [`Podbor/local-dev/CONTEXT.md`](Podbor/local-dev/CONTEXT.md) |

## Env-переменные Netlify (Site settings → Environment variables)

| Имя | Зачем | Откуда взять |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client (server-side доступ к Sheets) | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | то же | Google Cloud Console |
| `GOOGLE_REFRESH_TOKEN` | refresh_token аккаунта `psgl2007@gmail.com` | `scripts/regenerate-refresh-token.mjs` |
| `GOOGLE_WEB_CLIENT_ID` | OAuth client для авторизации web-юзеров | Google Cloud Console |
| `SESSION_SECRET` | подпись JWT-cookie (≥ 32 символа) | сгенерировать (random) |
| `ADMIN_EMAIL` | первый админ whitelist | `psgl2007@gmail.com` |
| `SPREADSHEET_ID` | UPSELLER (legacy default) | `1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q` |
| `UPSELLER_ID` | то же для подборов | то же |
| `PODBORY_ID` | таблица ПОДБОРЫ АПСЕЛЛЕР | `1mTVGXZgLh93O4lTTSXVr0cZ9Eu34urDm3jFJioorciM` |

## Локальная разработка

### Подборы

```bash
cd Podbor/local-dev
npm install         # 1 раз
npm run dev         # → http://localhost:3001
```

SA-ключ `sheets-bot@sheet-ai-491412` (путь в `.env`). Без авторизации — итерации без OAuth-флоу. Синхронизация с прод — вручную, см. [`Podbor/README.md`](Podbor/README.md).

### Календарь / Инвент

`netlify dev` из корня `web/` (требует `netlify CLI` и `netlify login`).

## Старые папки

- `Fulfillment/2_web/WEB_PODBOR/INVENT_WEB/` — **удалена** (был дубль без git).
- `Fulfillment/2_web/WEB_PODBOR/app/` — содержит `_DEPRECATED.md`, удалить вручную после остановки локального dev-сервера. Команда: `rm -rf Fulfillment/2_web/WEB_PODBOR/app`.
- `Fulfillment/3_gas/INVENT/` — **legacy GAS-проект** (clasp), **не Netlify**. Не трогать.

## Известные проблемы

- **`invalid_grant`** в календаре (на момент 2026-04-27): отозван `GOOGLE_REFRESH_TOKEN`. Чинится скриптом [`scripts/regenerate-refresh-token.mjs`](scripts/regenerate-refresh-token.mjs). Долгосрочно — перевести OAuth Consent Screen в **Production**-режим (Submit for verification), чтобы токены не истекали через 7 дней.

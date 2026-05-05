---
file: 2_web/1_UPSELLER_web/CONTEXT.md
purpose: Корневая папка единого web-сайта Upseller. Структура проекта, общая инфраструктура, точки входа модулей. Детали бизнес-логики каждого модуля — в его подпапке.
last_updated: 2026-05-05
---

# Upseller — единый сайт (`82-97-249-207.sslip.io`, Timeweb VPS)

Корневая папка **единого web-сайта**, на котором живут инструменты UpSeller с общей авторизацией Google OAuth: **Инвент** (инвент-планшет), **Подбор** (подборы), **Приемка**, **События** (журнал, в проектировании).

- **Прод-URL**: <https://82-97-249-207.sslip.io/>
- **Хостинг**: собственный VPS на Timeweb (Ubuntu 22.04, Node 20, nginx, pm2). С Netlify ушли в мае 2026 — нужны российский хостинг и контроль инфры.
- **Деплой**: GitHub-push в `ArtemFay/CalendOTG_CODEX` (`main`) → SSH на VPS → `bash server/setup.sh` (rsync + npm ci + pm2 restart).
- **Auth**: Google OAuth + JWT-cookie (`upseller_session`); whitelist пользователей в `/var/lib/upseller/users.json` (file-based, отдельный volume — пересборка кода whitelist не трогает).
- **GitHub-репо называется `CalendOTG_CODEX`** — историческое имя, можно переименовать на GitHub UI без потери Timeweb-привязки.

## Структура папок

```text
1_UPSELLER_web/
├── README.md  CONTEXT.md               ← общая документация (этот файл = подробности; README = краткий обзор)
├── archive/                            ← исторические артефакты, нереализованные планы
├── scripts/
│   └── regenerate-refresh-token.mjs    ← починка invalid_grant Google OAuth
│
├── package.json  package-lock.json     ← deps всего проекта (express, googleapis, jose, …)
├── node_modules/                        ← в корне, чтобы ESM-резолвер видел из любой папки (gitignored)
├── .env                                 ← локальные секреты в корне (gitignored), AUTH_DISABLED=true
├── .env.example                         ← шаблон env
├── data/                                ← локальная копия users.json (gitignored, для dev)
│
├── server/                             ← код Express-сервера всего сайта
│   ├── server.js                       ← импортирует ../web/api/*, отдаёт ../web/ как статику
│   └── setup.sh                        ← деплой на VPS (rsync + npm ci + pm2 restart)
│
├── web/                                ← статика + API всего сайта (источник правды)
│   ├── index.html                      ← главная (4 плитки модулей)
│   ├── favicon.svg
│   ├── ui/wms.css                      ← общий WMS UI-стандарт сайта
│   ├── login/  admin/                  ← общие auth-страницы
│   ├── invent-tablet/                  ← (рендерится SSR из api/invent-view.js)
│   ├── podbor/                         ← статика Подбора
│   ├── PRIEMKA/                        ← статика Приемки
│   ├── sobitiya/                       ← (TBD) статика Событий
│   └── api/                            ← все backend-функции (ESM, Node 20)
│       ├── auth-login.js  auth-me.js  auth-logout.js
│       ├── users.js                    ← admin: whitelist
│       ├── invent-view.js  invent-run.js
│       ├── podbor-*.js                 ← хендлеры Подбора (zayavki-list, load, sync, ship-*, box-layouts)
│       └── _lib/
│           ├── auth.js  google.js  users.js   ← общие
│           ├── invent/                 ← либы Инвента
│           └── podbor/                 ← либы Подбора
│
├── Invent/  Podbor/  Priemka/  Sobitiya/   ← рабочие пространства модулей (доки, не код)
└── _docs/                              ← (если будет) общая документация
```

### Источник правды — строгое разделение `web/` ↔ `Invent|Podbor|Priemka|Sobitiya/`

**Единственный источник правды для кода** — `web/`. Это то, что отдаёт Express-сервер локально и rsync'ом копируется на VPS в `/opt/upseller/web/`. Менять имя/структуру `web/` нельзя без правки `server/setup.sh` и `server/server.js`.

| Что | Где живёт код | Где живёт документация |
| --- | --- | --- |
| Главная страница | `web/index.html` | — |
| Общие auth-страницы | `web/login/`, `web/admin/` | — |
| Общий UI-стандарт | `web/ui/wms.css` | `1_CONST/05_UI_DESIGN_STANDARD.md` |
| Инвент | `web/api/_lib/invent/` (SSR-шаблоны) + `web/api/invent-*.js` (API) | [`Invent/README.md`](Invent/README.md) |
| Подбор | `web/podbor/` (статика) + `web/api/podbor-*.js` + `web/api/_lib/podbor/` | [`Podbor/README.md`](Podbor/README.md), [`Podbor/CONTEXT.md`](Podbor/CONTEXT.md) |
| Приемка | `web/PRIEMKA/` (статика) | [`Priemka/README.md`](Priemka/README.md), [`Priemka/CONTEXT.md`](Priemka/CONTEXT.md), [`Priemka/docs/`](Priemka/docs/) |
| События | (нет кода — модуль в проектировании) | [`Sobitiya/README.md`](Sobitiya/README.md), [`Sobitiya/CONTEXT.md`](Sobitiya/CONTEXT.md) |

**Папки модулей (`Invent/`, `Podbor/`, `Priemka/`, `Sobitiya/`) содержат ТОЛЬКО документацию и планы.** Никакого исполняемого кода в них быть не должно. README/CONTEXT модуля ведут ссылками на физические артефакты в `web/`.

**Правило при работе:**

- Любой код — править в `web/`. Никогда не дублировать его в модульную папку.
- Бизнес-логику, UX-решения, инварианты, регламенты — фиксировать в `<Module>/CONTEXT.md` или `1_CONST/`.
- Если ловишь себя на копировании файла из `web/` в модульную папку «как референс» — стоп: используй git-ссылки/постоянные ссылки, не дубль.

**Удалённые legacy-папки (2026-05-05):**

- `Invent/vps/` → перенесено в корневой `server/`.
- `Podbor/local-dev/` → удалена; роль выполняет корневой `server/server.js` + единый сервис-аккаунт; бизнес-документация перенесена в [`Podbor/CONTEXT.md`](Podbor/CONTEXT.md).
- `Priemka/web/` → удалена; источник правды единственный — [`web/PRIEMKA/`](web/PRIEMKA/).

## Активные модули

| Модуль | Статус | Прод-URL | Документация |
| --- | --- | --- | --- |
| Главная (hub) | активно | `/` | этот файл |
| **Инвент** (Инвент-Планшет) | активно | `/invent-tablet/` | [`Invent/README.md`](Invent/README.md) |
| **Подбор** | активно | `/podbor/` | [`Podbor/README.md`](Podbor/README.md), [`Podbor/local-dev/CONTEXT.md`](Podbor/local-dev/CONTEXT.md) (бизнес-логика) |
| **Приемка** | активно | `/PRIEMKA/` | [`Priemka/README.md`](Priemka/README.md), [`Priemka/CONTEXT.md`](Priemka/CONTEXT.md) |
| **События** (Sobitiya) | скоро (проектирование) | `/sobitiya/` *(TBD)* | [`Sobitiya/README.md`](Sobitiya/README.md), [`Sobitiya/CONTEXT.md`](Sobitiya/CONTEXT.md). Реализация после `Podbor/SYNC_BACKEND_PLAN`. Принимает события от всех модулей системы. |

> **Терминология**: в текстах и UI используется русское «Инвент», «Подбор», «Приемка», «События». В коде/путях/URL — английское `invent`, `podbor`, `priemka`, `sobitiya`.

### Архивированный модуль: Календарь (2026-05-01)

Функционал календаря отгрузок переведён в другую систему, развитие которой ведёт другой сотрудник.

- Workspace перенесён в [`archive/Calendar_2026-05-01/`](archive/Calendar_2026-05-01/) — без изменений, на случай возврата.
- Прод-артефакты Календаря (статика + ESM-хендлеры `calendar.js`, `update-shipment.js`, `bootstrap.js`, `_lib/shipments.js`) **полностью изъяты из `web/`** 2026-05-06 и перенесены в [`archive/calend-otg-2026-05-06/`](archive/calend-otg-2026-05-06/). В `server/server.js` Календарь никогда не подключался.

## Общая инфраструктура

### UI-стандарт

Единый визуальный язык сайта находится в [`web/ui/wms.css`](web/ui/wms.css): токены цвета, типографика, панели, кнопки, таблицы, бейджи и базовые адаптивные правила. Подробные правила зафиксированы в [`../../1_CONST/05_UI_DESIGN_STANDARD.md`](../../1_CONST/05_UI_DESIGN_STANDARD.md).

Визуальный ориентир — модуль **Подбор**: лаконичный WMS-интерфейс, рабочая плотность, белые панели, тонкие границы, синий primary action, статусы через бейджи. Новые модули и переработки существующих страниц должны подключать `/ui/wms.css`; модульные CSS-файлы добавляют только процессную специфику.

### Auth — корневой переключатель `AUTH_DISABLED`

Один сетап для всех модулей:

- **Прод**: Google Identity Services (web client) → JWT в cookie `upseller_session`. Whitelist разрешённых email — в `/var/lib/upseller/users.json`. Управляется страницей `/admin/`, эндпоинтом `/api/users`. Любая защищённая Netlify-функция вызывает `requireUser(request)` из `_lib/auth.js`.
- **Локально**: `AUTH_DISABLED=true` в `server/.env` → авторизация полностью отключена, все запросы идут как `dev@local` (admin). Это **корневая настройка** — действует для всех модулей сразу. На VPS переменную не выставлять (или `AUTH_DISABLED=false`).

Логика переключателя — в [`web/api/_lib/auth.js`](web/api/_lib/auth.js), функция `getUserFromRequest`. Login-страница [`web/login/index.html`](web/login/index.html) автоматически детектит `devMode` через `/api/auth/me` и не показывает Google-кнопку.

### Whitelist persistence — отдельный volume на VPS

Whitelist пользователей хранится в **`/var/lib/upseller/users.json`** на VPS — это отдельный volume, **код приложения** живёт в `/opt/upseller/`. `server/setup.sh` при редеплое:

- перезаписывает `/opt/upseller/server/*` и `/opt/upseller/web/*` свежим кодом,
- НЕ трогает `/var/lib/upseller/users.json` — только `mkdir -p` (идемпотентно).

Поэтому при пересборке/редеплое список из ~20 разрешённых email сохраняется автоматически. Backup: периодически `scp user@vps:/var/lib/upseller/users.json ./backup/`.

### Sheets — единый сервис-аккаунт

Все модули читают/пишут одну экосистему Google-таблиц UpSeller (см. [`1_CONST/03_CURRENT_GAS_SYSTEM.md`](../../1_CONST/03_CURRENT_GAS_SYSTEM.md)). Доступ — через **сервис-аккаунт** `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` (один механизм и локально, и в проде). Реализация в [`web/api/_lib/google.js`](web/api/_lib/google.js): JWT-auth по приватному ключу SA, без OAuth refresh-token'ов и проблемы `invalid_grant`.

Сервис-аккаунт уже расшарен на UPSELLER, ПОДБОРЫ АПСЕЛЛЕР, Планшет подборщика, ИНВЕНТ (см. `ai-projects/Fulfillment/CLAUDE.md` — таблица «Основные таблицы системы»).

**Где лежит ключ:**

- Локально: `C:\Users\Psgl2\.claude\sheets-bot-sa.json` (путь в `server/.env` → `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`).
- На VPS: `/etc/upseller/sheets-bot-sa.json` (chmod 600, тот же путь в проде-`.env`).

**Audit trail.** При write-операциях правка в таблице помечается как сделанная сервис-аккаунтом, а не реальным пользователем. Если нужен per-user audit (кто изменил какую строку) — модуль пишет email из JWT-сессии в отдельную колонку «modified_by» прямо в таблицу.

### Env-переменные сервера

Файл `server/.env` (локально) и `/opt/upseller/server/.env` (прод):

| Имя | Зачем | Откуда взять |
| --- | --- | --- |
| `PORT`, `HOST` | где слушает Express | произвольно (локально 3010, прод 3000) |
| `DATA_DIR` | где хранится `users.json` | локально `./data`, прод `/var/lib/upseller` |
| `COOKIE_SECURE` | флаг Secure для cookie | локально `false` (http), прод не задавать (https) |
| `AUTH_DISABLED` | пропустить Google-логин и подставить `dev@local` (admin) | локально `true`, прод не задавать |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | путь к JSON-ключу SA для доступа к Sheets | локально `C:\Users\Psgl2\.claude\sheets-bot-sa.json`, прод `/etc/upseller/sheets-bot-sa.json` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | (альтернатива) полное содержимое JSON одной переменной | для платформ без FS-доступа |
| `GOOGLE_WEB_CLIENT_ID` | OAuth client для логина web-юзеров (popup) — НЕ для Sheets | Google Cloud Console |
| `SESSION_SECRET` | подпись JWT-cookie (≥ 32 символа) | `openssl rand -hex 32` |
| `ADMIN_EMAIL` | первый админ whitelist | `psgl2007@gmail.com` |
| `SPREADSHEET_ID` | UPSELLER (legacy default) | `1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q` |
| `UPSELLER_ID` | то же для Подбора | то же |
| `PODBORY_ID` | таблица «ПОДБОРЫ АПСЕЛЛЕР» | `1mTVGXZgLh93O4lTTSXVr0cZ9Eu34urDm3jFJioorciM` |
| `INVENT_SPREADSHEET_ID` | таблица «ИНВЕНТ» (legacy) | `1xHs4IWslef6agbB_QM6fPuwqR66kEHdBni83R_K3gmM` |

### Локальная разработка

**Один корневой запуск всего сайта:**

```bash
cd server
npm install
npm run dev   # порт 3010, AUTH_DISABLED=true
```

Открыть `http://localhost:3010/` → главная с 4 плитками → клик в любой модуль. Все защищённые роуты пускают как `dev@local` (admin), Google-логин не нужен. Sheets API работает через тот же сервис-аккаунт, что и в проде, поэтому **локально доступен полный функционал всех модулей** — чтение и запись таблиц UpSeller идентичны прод-флоу.

**Альтернативная точка входа** (только для случаев, когда нужно изолировать модуль):

- **Приемка**: статический прототип из `Priemka/web/`, копия в `web/PRIEMKA/`. Для теста на планшете в локальной сети: `python -m http.server 8092 --bind 0.0.0.0` из папки `web/`, затем открыть `/PRIEMKA/`.

> `Podbor/local-dev/` — **deprecated** после унификации на сервис-аккаунт. Его роль (локальный Подбор без Netlify-окружения) теперь выполняет корневой `server/`. Папка пока сохраняется как референс.

### Правила обновления контекста

- Модульные решения фиксируются в README/CONTEXT конкретного модуля.
- Общесистемные решения фиксируются в [`../../1_CONST/`](../../1_CONST/): бизнес-процессы, роли, статусы, источники данных, таблицы, интеграции, инварианты.
- Для `Priemka` перед изменениями сверяться с [`Priemka/docs/development-rules.md`](Priemka/docs/development-rules.md) (если файл есть).
- `Invent` и `Podbor` не менять при задачах по `Priemka`, кроме явно согласованной интеграции.

## Старые папки и legacy

- `Invent/vps/` — **удалена** (была временная VPS-папка под только Инвент; код переехал в корневой `server/`, который обслуживает весь сайт).
- `web/netlify/` — **удалена** (Netlify ушёл, всё на VPS).
- `Fulfillment/2_web/WEB_PODBOR/INVENT_WEB/` — **удалена** (был дубль без git).
- `Fulfillment/2_web/WEB_PODBOR/app/` — содержит `_DEPRECATED.md`, удалить вручную после остановки локального dev-сервера.
- `Fulfillment/3_gas/INVENT/` — **legacy GAS-проект** Инвента (заморожен). Не трогать.
- `Fulfillment/3_gas/CalendOTG_CODEX/` — **legacy GAS-проект** Календаря (всё ещё доступен как fallback).

## Известные проблемы

- **`invalid_grant`** в Google OAuth — больше не актуально для Sheets-доступа (после перехода на сервис-аккаунт SA-токены не истекают). Может всё ещё возникать в `GOOGLE_WEB_CLIENT_ID`-флоу логина пользователей; чинится переводом OAuth Consent Screen в Production-режим (Submit for verification). Скрипт [`scripts/regenerate-refresh-token.mjs`](scripts/regenerate-refresh-token.mjs) сохранён для исторических случаев, но для основного функционала больше не нужен.

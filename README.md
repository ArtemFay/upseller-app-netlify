# Upseller — web-приложение

Web-сайт UpSeller с инструментами для склада и логистики. Один сервер, одна авторизация, четыре модуля.

**Прод**: [https://82-97-249-207.sslip.io/](https://82-97-249-207.sslip.io/) — Timeweb VPS (Ubuntu + nginx + pm2 + Node 20).
**Репозиторий**: [https://github.com/ArtemFay/CalendOTG_CODEX](https://github.com/ArtemFay/CalendOTG_CODEX) (историческое имя).

## Модули сайта

| Модуль | Статус | URL |
| --- | --- | --- |
| **Инвент** (инвентаризация) | активно, MVP на складе | `/invent-tablet/` |
| **Подбор** | активно, в разработке | `/podbor/` |
| **Приемка** | активно, web-прототип | `/PRIEMKA/` |
| **События** (журнал) | скоро, проектирование | `/sobitiya/` (TBD) |

Все модули обслуживаются единым Express-сервером ([`server/server.js`](server/server.js)). Авторизация пользователей — Google OAuth (popup) с whitelist'ом разрешённых email'ов (управляется страницей `/admin/`). Доступ к Google Sheets — через единый сервис-аккаунт `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` (один механизм и в проде, и локально).

> **Календарь** перенесён в архив 2026-05-01 — функционал замещён в другой системе. См. [`archive/Calendar_2026-05-01/`](archive/Calendar_2026-05-01/).

## Структура проекта

```text
1_UPSELLER_web/
├── server/                ← Express-сервер всего сайта (импорты из ../web/api/)
├── web/                   ← статика и API всего сайта (единый источник правды)
│   ├── index.html         ← главная (плитки модулей)
│   ├── login/  admin/     ← общие страницы авторизации
│   ├── invent-tablet/     ← (рендерится SSR из api/invent-view.js)
│   ├── podbor/            ← статика Подбора
│   ├── PRIEMKA/           ← статика Приемки
│   ├── sobitiya/          ← (TBD) статика Событий
│   └── api/               ← все backend-хендлеры (auth, invent, podbor, ...)
│       ├── _lib/          ← shared библиотеки (auth, google, users, invent/, podbor/)
│       ├── auth-*.js      ← общая авторизация
│       ├── invent-*.js    ← инвент
│       └── podbor-*.js    ← подбор
├── Invent/  Podbor/  Priemka/  Sobitiya/   ← рабочие пространства модулей (доки)
├── archive/  scripts/
└── README.md  CONTEXT.md
```

Подробности структуры и инфраструктуры — в [`CONTEXT.md`](CONTEXT.md).

## Локальный запуск (весь сайт сразу)

```bash
cd server
npm install            # один раз
npm run dev            # читает .env с AUTH_DISABLED=true
```

Открыть `http://localhost:3010/` — главная с 4 плитками. Авторизация пользователя в dev-режиме выключена: все запросы идут как `dev@local` (admin), Google-логин не нужен. **При этом Sheets API работает через тот же сервис-аккаунт, что и на проде** — в локалке доступен полный функционал всех модулей (чтение и запись таблиц UpSeller). Тестирование локально = тестирование прод-флоу.

Требования для локального запуска:

- Файл сервис-аккаунта `C:\Users\Psgl2\.claude\sheets-bot-sa.json` (уже на машине пользователя). Путь указан в `server/.env` → `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`.
- Node 20+, `cd server && npm install`.

Чтобы протестировать прод-флоу с реальной Google-авторизацией пользователей (popup): в `server/.env` поставить `AUTH_DISABLED=false`, заполнить `GOOGLE_WEB_CLIENT_ID` и `SESSION_SECRET`.

## Деплой на VPS

Push в `main` → SSH на VPS → `cd /opt/upseller-src && bash server/setup.sh`. Скрипт:

- pull'ает свежий код в `/opt/upseller-src`,
- копирует `server/*` в `/opt/upseller/server/`, `web/*` в `/opt/upseller/web/` (rsync с `--delete`),
- ставит `npm ci --omit=dev` в `/opt/upseller/server/`,
- рестартует pm2-процесс `upseller`,
- НЕ трогает `/var/lib/upseller/users.json` — whitelist сохраняется между деплоями.

Подробнее — в [`server/setup.sh`](server/setup.sh) и [`CONTEXT.md`](CONTEXT.md).

## Документация модулей

- [`Invent/README.md`](Invent/README.md) — Инвент Планшет.
- [`Podbor/README.md`](Podbor/README.md) + [`Podbor/local-dev/CONTEXT.md`](Podbor/local-dev/CONTEXT.md) — Подбор, бизнес-логика и UX.
- [`Priemka/README.md`](Priemka/README.md) + [`Priemka/CONTEXT.md`](Priemka/CONTEXT.md) — Приемка.
- [`Sobitiya/README.md`](Sobitiya/README.md) + [`Sobitiya/CONTEXT.md`](Sobitiya/CONTEXT.md) — События (проектирование).

Глобальный бизнес-контекст — в [`../../1_CONST/`](../../1_CONST/).

## UI-стандарт

Все рабочие интерфейсы Upseller Web строятся на едином WMS-стиле: светлый фон, белые панели, компактные кнопки, читаемые таблицы и цвет только как смысловой статус. Источник CSS-токенов и общих компонентов — [`web/ui/wms.css`](web/ui/wms.css). Правила дизайна зафиксированы в [`../../1_CONST/05_UI_DESIGN_STANDARD.md`](../../1_CONST/05_UI_DESIGN_STANDARD.md).

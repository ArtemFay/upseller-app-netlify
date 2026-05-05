# Инвент — модуль «Инвент Планшет»

Web-приложение для проведения инвентаризации внутри Upseller — заменяет legacy GAS-таблицу `ИНВЕНТ` (`3_gas/INVENT/`, заморожена).

URL на проде: `https://82-97-249-207.sslip.io/invent-tablet/`

## Где что лежит

| Что | Где |
|---|---|
| **Прод-рендер (SSR)** | [`../web/api/invent-view.js`](../web/api/invent-view.js) — рендерит HTML на сервере. |
| **Применение операций** | [`../web/api/invent-run.js`](../web/api/invent-run.js) |
| **HTML-шаблоны** | [`../web/api/_lib/invent/templates/`](../web/api/_lib/invent/templates/) |
| **Общая логика инвента** | [`../web/api/_lib/invent/`](../web/api/_lib/invent/) — sheets-client, workflow и т.д. |
| **Сервер** | [`../server/server.js`](../server/server.js) — Express-сервер всего сайта, инвент — один из модулей. |

## Источник данных

Sheets `UPSELLER!🍬 КОРОБЫ` + `🚚 ОТГ` через OAuth refresh-token.

## Особенность

В отличие от Подбора и Приемки, фронт инвента **не статика** — функция `invent-view.js` рендерит HTML на сервере с инлайн JS / CSS. Шаблоны — в `_lib/invent/templates/`.

## Локальный запуск

Вместе со всем сайтом из корня:

```bash
cd ../server
npm install
npm run dev
```

Открыть `http://localhost:3010/invent-tablet/`. Авторизация в dev-режиме отключена (`AUTH_DISABLED=true` в `server/.env`), все запросы проходят как `dev@local` (admin).

## Legacy

Оригинальный GAS-проект — `Fulfillment/3_gas/INVENT/` (заморожен). Не трогать.

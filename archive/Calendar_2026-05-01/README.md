# Calendar — модуль «Календарь отгрузок»

Web-инструмент для просмотра и редактирования отгрузок: даты, статусы, водители, авто, ОТК.

URL на проде: <https://upseller-app.netlify.app/calend-otg/>

## Где что лежит

| Что | Где |
|---|---|
| **Прод-фронт (статика)** | [`../web/calend-otg/`](../web/calend-otg/) |
| **Прод-бэкенд** | [`../web/netlify/functions/calendar.js`](../web/netlify/functions/calendar.js), [`update-shipment.js`](../web/netlify/functions/update-shipment.js), [`bootstrap.js`](../web/netlify/functions/bootstrap.js) |
| **Общая логика** | [`../web/netlify/functions/_lib/shipments.js`](../web/netlify/functions/_lib/shipments.js) |

## Источник данных

Sheets `UPSELLER!🚚 ОТГ` через OAuth refresh-token (`_lib/google.js`).

Целевая БД — пока **не используется**, источник правды — Sheets. История миграции с GAS на web и план дальнейшего развития (если понадобится БД) — в [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md).

## Известная проблема

`invalid_grant` — refresh-token Google истёк. Чинится скриптом [`../scripts/regenerate-refresh-token.mjs`](../scripts/regenerate-refresh-token.mjs).

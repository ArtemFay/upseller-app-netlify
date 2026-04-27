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

Целевая БД — Supabase (см. CONST/04 «Контур C»). Идёт миграция (план — `archive/MIGRATION_PLAN.md` в корне `Netlify/`).

## Известная проблема

`invalid_grant` — refresh-token Google истёк. Чинится скриптом [`../scripts/regenerate-refresh-token.mjs`](../scripts/regenerate-refresh-token.mjs).

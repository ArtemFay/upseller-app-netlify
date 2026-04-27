# Invent — модуль «Инвент Планшет»

Web-приложение для проведения инвентаризации внутри Upseller — заменяет legacy GAS-таблицу `ИНВЕНТ` (`3_gas/INVENT/`, заморожена).

URL на проде: <https://upseller-app.netlify.app/invent-tablet/>

## Где что лежит

| Что | Где |
|---|---|
| **Прод-рендер (SSR)** | [`../web/netlify/functions/invent-view.js`](../web/netlify/functions/invent-view.js) — рендерит HTML на сервере. |
| **Применение операций** | [`../web/netlify/functions/invent-run.js`](../web/netlify/functions/invent-run.js) |
| **HTML-шаблоны** | [`../web/netlify/functions/_lib/invent/templates/`](../web/netlify/functions/_lib/invent/templates/) |
| **Общая логика инвента** | [`../web/netlify/functions/_lib/invent/`](../web/netlify/functions/_lib/invent/) — sheets-client, workflow, и т.д. |

## Источник данных

Sheets `UPSELLER!🍬 КОРОБЫ` + `🚚 ОТГ` через OAuth refresh-token.

## Особенность

В отличие от Подборов и Календаря, фронт инвента **не статика** — функция `invent-view.js` рендерит HTML на сервере с инлайн JS / CSS. Шаблоны — в `_lib/invent/templates/`.

## Legacy

Оригинальный GAS-проект — `Fulfillment/3_gas/INVENT/` (заморожен). Не трогать.

# local-dev / podbor

Локальный Node.js HTTP-сервер для итеративной разработки модуля **Подборы** без необходимости поднимать `netlify dev` со всем сайтом.

## Запуск

```bash
npm install        # один раз (если node_modules не установлены)
npm run dev        # → http://localhost:3001
```

`npm run dev` поднимает:
- `nodemon` на `server.js` (рестарт при правках `lib/*.js`, `.env`),
- `browser-sync` на `:3001`, проксирующий `:3000`, с авто-reload `public/*` и `lib/*`.

**Только** `:3001` имеет live-reload. На `:3000` нет.

## Зависит от

- `.env` (gitignored): `SA_KEY_PATH`, `UPSELLER_ID`, `PODBORY_ID`, `PORT`. Сервис-аккаунт `sheets-bot@sheet-ai-491412` уже расшарен на обе таблицы.

## Связь с production-кодом

Этот сервер — **CommonJS-зеркало** Netlify-функций модуля Подборы. Контракт API одинаковый, отличаются только префиксы:

| Локально (этот сервер) | На проде (Netlify) |
|---|---|
| `GET /api/zayavki-list` | `GET /api/podbor/zayavki-list` |
| `GET /api/load?client=…` | `GET /api/podbor/load?client=…` |
| `POST /api/sync` | `POST /api/podbor/sync` |

При синхронизации изменений с прод-кодом:
- `public/*` → `../../web/podbor/*` (статика)
- `lib/active-zayavki.js` → `../../web/netlify/functions/_lib/podbor/zayavki.js` (CommonJS → ESM, заменить `require/module.exports` на `import/export`, заменить `readRange` на `getSheets()` из `../google.js`)
- `lib/podbory-load.js` → `../../web/netlify/functions/_lib/podbor/boxes.js` (то же)

В перспективе автоматизируем синхронизацию (общий пакет / build-step / monorepo workspaces).

## Документация модуля

См. [CONTEXT.md](CONTEXT.md) — бизнес-логика, инварианты подбора, UX-договорённости, открытые вопросы. Это основной справочник для работы над фичами Подборов.

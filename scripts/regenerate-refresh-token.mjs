#!/usr/bin/env node
/**
 * Перевыпуск GOOGLE_REFRESH_TOKEN при ошибке `invalid_grant`.
 *
 * Когда нужен:
 *   - Прод-функции (calendar, invent-*, podbor-*) валятся с `invalid_grant`.
 *   - Это значит, что refresh_token отозван Google. Причины:
 *     1. OAuth Consent Screen в режиме Testing → токены живут 7 дней.
 *     2. Сменён пароль аккаунта `psgl2007@gmail.com`.
 *     3. Пользователь явно отозвал доступ через https://myaccount.google.com/permissions.
 *     4. Учётка временно заблокирована.
 *
 * Решение — выпустить новый refresh_token и обновить env-переменную в Netlify.
 *
 * Шаги:
 *   1. Открыть https://console.cloud.google.com/apis/credentials
 *      → проект Google, в котором созданы OAuth Client ID для Sheets API.
 *      → найти client (Desktop или Web), записать `client_id` и `client_secret`.
 *      → если OAuth Consent Screen в Testing — рекомендуется перевести в Production
 *        (Submit for verification), чтобы токены жили постоянно.
 *
 *   2. Запустить этот скрипт:
 *        export GOOGLE_CLIENT_ID="..."
 *        export GOOGLE_CLIENT_SECRET="..."
 *        node scripts/regenerate-refresh-token.mjs
 *
 *   3. В консоли появится URL для авторизации. Открыть в браузере под
 *      `psgl2007@gmail.com` (владелец таблиц), разрешить scope.
 *
 *   4. Google редиректнет на `http://localhost:8765/callback?code=...`.
 *      Скрипт перехватит код, обменяет на refresh_token и распечатает его.
 *
 *   5. Обновить переменные на Netlify:
 *        Site settings → Environment variables → GOOGLE_REFRESH_TOKEN = (новый)
 *      После сохранения — Trigger deploy → Clear cache and deploy site.
 *
 *   6. Проверить https://upseller-app.netlify.app/calend-otg/ — ошибка должна пропасть.
 */

import http from 'node:http';
import { URL } from 'node:url';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Установите GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в окружении.');
  console.error('   export GOOGLE_CLIENT_ID="..."');
  console.error('   export GOOGLE_CLIENT_SECRET="..."');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('scope', SCOPES.join(' '));

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('1. Открой эту ссылку в браузере под аккаунтом psgl2007@gmail.com:');
console.log('');
console.log('   ' + authUrl.toString());
console.log('');
console.log('2. Разреши доступ. Google редиректнет обратно на http://localhost:8765/callback');
console.log('   — этот скрипт перехватит код и обменяет на refresh_token.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
       .end(`<h1>Ошибка авторизации: ${error}</h1>`);
    console.error('❌ ' + error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400).end('No code');
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
         .end('<h1>Не получили refresh_token. Возможно, scope уже выдан этому клиенту — отзови доступ на https://myaccount.google.com/permissions и попробуй снова.</h1>');
      console.error('❌ В ответе Google нет refresh_token:');
      console.error(JSON.stringify(tokens, null, 2));
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
       .end('<h1>✅ Готово!</h1><p>Refresh-token получен. Скопируй его из терминала и вставь в Netlify env-переменную GOOGLE_REFRESH_TOKEN.</p>');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ GOOGLE_REFRESH_TOKEN получен:');
    console.log('');
    console.log('   ' + tokens.refresh_token);
    console.log('');
    console.log('Дальше:');
    console.log('  1. Скопируй значение выше.');
    console.log('  2. Открой https://app.netlify.com/sites/upseller-app/settings/env');
    console.log('  3. Обнови переменную GOOGLE_REFRESH_TOKEN.');
    console.log('  4. Site overview → Trigger deploy → Clear cache and deploy site.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end('Server error');
    console.error('❌ ' + e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  // ready
});

// Google Sheets API — единый сервис-аккаунт-доступ для всех модулей сайта.
//
// Сервис-аккаунт `sheets-bot@sheet-ai-491412.iam.gserviceaccount.com` уже
// расшарен на UPSELLER, ПОДБОРЫ АПСЕЛЛЕР, Планшет подборщика, ИНВЕНТ
// (см. ai-projects/Fulfillment/CLAUDE.md). Один auth-механизм — и локально,
// и в проде. Никаких OAuth refresh-token'ов, никаких invalid_grant.
//
// Конфиг через env:
//   GOOGLE_SERVICE_ACCOUNT_KEY_PATH — путь к JSON-ключу SA (предпочтительно).
//   GOOGLE_SERVICE_ACCOUNT_KEY      — ИЛИ полное содержимое JSON в env-переменной
//                                      (для платформ, где FS-доступ неудобен).
// Хотя бы одна из них должна быть задана.

import { google } from 'googleapis';
import fs from 'fs';

let _auth = null;
let _sheets = null;

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function loadCredentials() {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY содержит невалидный JSON: ' + e.message);
    }
  }
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY_PATH указывает на несуществующий файл: ${keyPath}`);
    }
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }
  throw new Error(
    'Не задан сервис-аккаунт. Укажите GOOGLE_SERVICE_ACCOUNT_KEY_PATH (путь к JSON) ' +
    'или GOOGLE_SERVICE_ACCOUNT_KEY (содержимое JSON) в окружении.'
  );
}

export function getAuth() {
  if (_auth) return _auth;
  const credentials = loadCredentials();
  _auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });
  return _auth;
}

export function getSheets() {
  if (_sheets) return _sheets;
  _sheets = google.sheets({ version: 'v4', auth: getAuth() });
  return _sheets;
}

export function getSpreadsheetId() {
  return process.env.SPREADSHEET_ID || '1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q';
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(error, status = 500) {
  const message = error && error.message ? error.message : String(error);
  return jsonResponse({ error: message }, status);
}

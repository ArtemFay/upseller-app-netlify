import { google } from 'googleapis';

let _auth = null;
let _sheets = null;

export function getAuth() {
  if (_auth) return _auth;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Отсутствуют Google OAuth credentials в переменных окружения Netlify.');
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  _auth = auth;
  return auth;
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

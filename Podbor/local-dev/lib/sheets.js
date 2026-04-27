const { google } = require('googleapis');
const fs = require('fs');

let cachedClient;

function getSheetsClient() {
  if (cachedClient) return cachedClient;
  const keyPath = process.env.SA_KEY_PATH;
  if (!keyPath) throw new Error('SA_KEY_PATH не задан в .env');
  if (!fs.existsSync(keyPath)) throw new Error(`Ключ SA не найден: ${keyPath}`);

  const credentials = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

async function readRange(spreadsheetId, range, { formatted = false } = {}) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: formatted ? 'FORMATTED_VALUE' : 'UNFORMATTED_VALUE'
  });
  return res.data.values || [];
}

module.exports = { getSheetsClient, readRange };

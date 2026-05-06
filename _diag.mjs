import { google } from 'googleapis';
import fs from 'fs';

const credentials = JSON.parse(fs.readFileSync('C:/Users/Psgl2/.claude/sheets-bot-sa.json', 'utf8'));
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET = '1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q';
const TOVARY_SHEET = '👗 ТОВАРЫ';
const TOVARY_START_ROW = 3;

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET,
  range: `'${TOVARY_SHEET}'!B${TOVARY_START_ROW}:D`,
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = res.data.values || [];
console.log('total rows from Sheets API:', rows.length);

// Поиск Позоян + 2040595711675
const target = '2040595711675';
const want = 'Позоян А.Р.';
let matches = 0;
let pozoyanRows = 0;
let targetFound = null;
for (const r of rows) {
  const client = String(r[0] ?? '').trim();
  const barcode = String(r[2] ?? '').trim();
  if (client === want) pozoyanRows++;
  if (barcode === target) {
    targetFound = { client, sku: String(r[1] ?? ''), barcode, clientCharCodes: [...client].map(c => c.charCodeAt(0)) };
    console.log('row with target barcode:', JSON.stringify(targetFound));
  }
  if (client === want && barcode === target) matches++;
}
console.log('rows with client === "Позоян А.Р.":', pozoyanRows);
console.log('matches (both client + target barcode):', matches);

// Сравнение строк байт-в-байт
const wantCodes = [...want].map(c => c.charCodeAt(0));
console.log('want codes:', wantCodes);

if (targetFound) {
  console.log('client codes from row:', targetFound.clientCharCodes);
  console.log('lengths: want=', want.length, 'row=', targetFound.client.length);
  console.log('strict equal:', targetFound.client === want);
}

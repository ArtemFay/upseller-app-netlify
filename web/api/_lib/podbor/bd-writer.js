// Запись в лист БД (тест-таблица или ПОДБОРЫ боевая, в зависимости от TEST_MODE).
//
// Структура БД (row 2 = headers, data start row 4):
//   A=ID, B=КЛИЕНТ, C=РЕЙТ, D=КС, E=ТИП, F=№ ПОДБОРА, G=СБОРЩИК,
//   H=ДАТА ЗАЙ, I=ДАТА ВНЕС, J=ДАТА ОТГР, K=МП, L=СКЛАД, M=КОНЕЧНЫЙ СКЛАД,
//   N=КОММЕНТ, O=ЛОГ ЗАЯВКИ, P=СБОРКА, Q=ТИП ОТГ, R=ОПЕР, S=КОЛ СКЮ, T=КОЛ ЕД,
//   U=СТАТУС, V=ДАТА ИЗМ СТАТУСА, W=КОЛ КОР, X=КОЛ ПАЛ, Y=СПИС КОР
//
// Используется для отметок жизненного цикла заявки:
//   start    → G=сборщик, U=В РАБОТЕ,           V=сейчас
//   finish   → U=СОБРАНО,                       V=сейчас
//   partial  → U=ЧАСТИЧНО СОБРАНА,              V=сейчас
//   close    → G=пусто, U=СОЗДАНО,              V=сейчас (откат)
//
// Запись делается **немедленно** (forced flush, в обход 2-минутной очереди КОРОБЫ),
// чтобы статус заявки сразу был виден всем.

import { getSheets } from '../google.js';
import { getPodborySpreadsheetId } from './spreadsheet-id.js';
import { logEvent } from './sync-log.js';

const SHEET_NAME = 'БД';
const SEARCH_COL = 'F'; // № ПОДБОРА
const SEARCH_RANGE = `'${SHEET_NAME}'!F:F`;
const FIRST_DATA_ROW = 4;

function nowDDMMYY_HHMM() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(-2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function findRowByZayavkaNumber(zayavkaNumber) {
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: SEARCH_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = r.data.values || [];
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || '').trim();
    if (v === zayavkaNumber) return i + 1; // 1-based row number
  }
  return null;
}

// Прочитать G, U, AH конкретной строки (для merge сборщиков, проверки статуса
// и идемпотентного выставления НАЧАЛО — пишем AH только если пусто, чтобы
// первый старт не перезаписывался последующими).
async function readPickerStatusStarted(rowNumber) {
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${SHEET_NAME}'!G${rowNumber}:AH${rowNumber}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const v = (r.data.values && r.data.values[0]) || [];
  // G=0(СБОРЩИК), U=14(СТАТУС), AH=27(НАЧАЛО).
  return {
    picker: String(v[0] || '').trim(),
    status: String(v[14] || '').trim(),
    startedAt: String(v[27] || '').trim(),
  };
}

// Список сборщиков из ячейки G (через запятую). Без дублей, trim'ed.
function parsePickerList(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}
function mergePicker(existing, addPicker) {
  const list = parsePickerList(existing);
  if (!list.includes(addPicker)) list.push(addPicker);
  return list.join(', ');
}

async function batchUpdateBD(rowNumber, fields) {
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const data = [];
  for (const [col, value] of Object.entries(fields)) {
    data.push({
      range: `'${SHEET_NAME}'!${col}${rowNumber}`,
      values: [[value]],
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: id,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// === Public API ===

// Отметить заявку как «В РАБОТЕ» и добавить сборщика в список (через запятую).
// Если сборщик уже в списке — не дублируем, статус всё равно подтверждаем.
// Несколько сотрудников могут работать над одной заявкой одновременно.
export async function markInProgress(zayavkaNumber, picker) {
  if (!zayavkaNumber || !picker) {
    throw new Error('markInProgress: zayavkaNumber и picker обязательны');
  }
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) {
    logEvent('warn', 'sheet', `БД: заявка ${zayavkaNumber} не найдена в столбце F`, null);
    return { ok: false, reason: 'not_found', zayavkaNumber };
  }
  const cur = await readPickerStatusStarted(row);
  const newPickerList = mergePicker(cur.picker, picker);
  const updates = { G: newPickerList };
  // Статус ставим в «В РАБОТЕ» только если он ещё не такой — иначе не трогаем V.
  if (cur.status !== 'В РАБОТЕ') {
    updates.U = 'В РАБОТЕ';
    updates.V = nowDDMMYY_HHMM();
  }
  // AH=НАЧАЛО пишем только при первом старте (idempotent): если уже заполнено
  // — не трогаем, иначе вторая сессия после partial_close перезатрёт первое
  // время. Юзер видит дату начала подбора сразу после клика «Начать».
  if (!cur.startedAt) {
    updates.AH = nowDDMMYY_HHMM();
  }
  await batchUpdateBD(row, updates);
  const action = cur.status !== 'В РАБОТЕ' ? '→ В РАБОТЕ' : '(подтверждение)';
  logEvent('info', 'sheet', `БД: ${zayavkaNumber} ${action} (сборщики: ${newPickerList})`, {
    row, picker, mergedFrom: cur.picker, status: cur.status, startedAtPrev: cur.startedAt,
  });
  return { ok: true, row, status: 'В РАБОТЕ', picker: newPickerList, addedPicker: picker, startedAt: cur.startedAt || updates.AH };
}

export async function markFinished(zayavkaNumber) {
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) return { ok: false, reason: 'not_found', zayavkaNumber };
  const ts = nowDDMMYY_HHMM();
  await batchUpdateBD(row, { U: 'СОБРАНО', V: ts });
  logEvent('info', 'sheet', `БД: ${zayavkaNumber} → СОБРАНО`, { row, ts });
  return { ok: true, row, status: 'СОБРАНО', ts };
}

export async function markPartial(zayavkaNumber) {
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) return { ok: false, reason: 'not_found', zayavkaNumber };
  const ts = nowDDMMYY_HHMM();
  await batchUpdateBD(row, { U: 'ЧАСТ.СОБР', V: ts });
  logEvent('info', 'sheet', `БД: ${zayavkaNumber} → ЧАСТ.СОБР`, { row, ts });
  return { ok: true, row, status: 'ЧАСТ.СОБР', ts };
}

// markClosed — раньше возвращал заявку в СОЗДАНО и стирал сборщика.
// СЕЙЧАС: «закрыть» = просто выйти со своего планшета, оставляя статус В РАБОТЕ
// и список сборщиков как есть. Другой сборщик может подключиться и продолжить.
// Возврат к СОЗДАНО исключаем — он терял многоsession-контекст (CONST/02 § 5).
export async function markClosed(zayavkaNumber) {
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) return { ok: false, reason: 'not_found', zayavkaNumber };
  logEvent('info', 'sheet', `БД: ${zayavkaNumber} close (no-op в БД, статус и сборщик сохранены)`, { row });
  return { ok: true, row, status: 'kept', note: 'no-op: status/picker preserved' };
}

export async function readZayavkaStatus(zayavkaNumber) {
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) return null;
  // FORMATTED_VALUE: V колонка — это datetime; Sheets хранит её как
  // serial-number (например 46156.139... = 14.05.26 03:21). UNFORMATTED
  // отдавал бы это число фронту, который потом показывал «Финиш: 46156.14».
  // FORMATTED_VALUE отдаёт ту строку которую видит пользователь в Sheets.
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${SHEET_NAME}'!G${row}:V${row}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const v = (r.data.values && r.data.values[0]) || [];
  // G=0(СБОРЩИК), U=14(СТАТУС), V=15(ДАТА ИЗМ)
  return {
    row,
    picker: v[0] || '',
    status: v[14] || 'СОЗДАНО',
    statusChangedAt: v[15] || '',
  };
}

/**
 * Google Sheets API wrapper for the INVENT module.
 * Supports service-account JSON, a local fallback file for development,
 * and the existing OAuth refresh-token flow used by the main app.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = process.env.INVENT_SPREADSHEET_ID || '1xHs4IWslef6agbB_QM6fPuwqR66kEHdBni83R_K3gmM';
const LOCAL_SERVICE_ACCOUNT_PATHS = [
  path.resolve(process.cwd(), '.claude', 'service-account.json'),
  path.resolve(process.cwd(), '..', 'INVENT', '.claude', 'service-account.json'),
  path.resolve(process.cwd(), '..', 'INVENT', '.claude', 'sheet-ai-491412-cbac46157612.json')
];

const CFG = {
  sheetName: 'ИНВЕНТ',
  startRow: 5,
  headerRow: 3,
  editCol: 2,
  boxCol: 8,
  taraCol: 6,
  statusCol: 7,
  skuCountCol: 9,
  totalQtyCol: 10,
  barcodeCol: 11,
  qtyCol: 12,
  verifiedCol: 13,
  newQtyCol: 14,
  newAddressCol: 15,
  newStatusCol: 16,
  newTypeCol: 17,
  newTaraCol: 18,
  noteCol: 19,
  rowWidth: 19
};

let sheetsApi = null;

async function getSheets() {
  if (sheetsApi) return sheetsApi;

  let auth = null;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountJson) {
    const credentials = JSON.parse(serviceAccountJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    const localKeyFile = LOCAL_SERVICE_ACCOUNT_PATHS.find(file => fs.existsSync(file));
    if (localKeyFile) {
      auth = new google.auth.GoogleAuth({
        keyFile: localKeyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
    }
  }

  if (!auth) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
      throw new Error('Для INVENT не найдены Google credentials: нужен GOOGLE_SERVICE_ACCOUNT_KEY или OAuth credentials.');
    }
    auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  }

  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}

function norm(v) { return String(v == null ? '' : v).trim(); }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function cellStr(v) { return (v === '' || v == null) ? '' : String(v).trim(); }
function eff(row, newCol, baseCol) {
  const nv = norm(row[newCol - 1]);
  return nv !== '' ? nv : norm(row[baseCol - 1]);
}
function effQty(row) {
  const nr = row[CFG.newQtyCol - 1];
  if (nr !== '' && nr != null) return toNum(nr);
  return toNum(row[CFG.qtyCol - 1]);
}

// ---- Upseller table (READ-ONLY) ----
const UPSELLER_SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q';
const TOVARY_SHEET = '👗 ТОВАРЫ';
const TOVARY_START_ROW = 3;

// ---- Canonical dropdown options ----
const CANONICAL_STATUSES = [
  'ГОТОВО', 'В ПРИЕМКЕ', 'В УПАКОВКЕ', 'В РЕЗЕРВЕ', 'ХРАНЕНИЕ',
  'СОБРАНО', 'ОТГРУЖЕНО', 'СПИСАНО', 'БРАК', 'ИЗЪЯТО',
  'ОБЕЗЛИЧКА', 'ПЕРЕМАРК', 'ДЛИТ.ХРАН'
];
const CANONICAL_TYPES = [
  'ПТ НА УП', 'ПТ без ЧЗ', 'УТ без ЧЗ', 'УТ не ГОТ',
  'БРАК', 'ПТ ГОТОВ', 'УТ ГОТОВ'
];
const CANONICAL_TARA = [
  'ПАЛ', 'ЯЧ',
  'К_0,1', 'К_0,2', 'К_0,3', 'К_0,4', 'К_0,5',
  'К_0,6', 'К_0,7', 'К_0,8', 'К_0,9', 'К_1,0',
  'К_1,1', 'К_1,2', 'К_1,3', 'К_1,4', 'К_1,5',
  'К_1,6', 'К_1,7', 'К_1,8', 'К_1,9', 'К_2,0'
];

function mergeOptions(dynamicSet, canonical) {
  const merged = new Set(canonical);
  dynamicSet.forEach(v => { if (v) merged.add(v); });
  return [...merged].sort((a, b) => {
    const ai = canonical.indexOf(a);
    const bi = canonical.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b, 'ru');
  });
}

/**
 * Reads ИНВЕНТ sheet and returns payload identical to getInventWebListData_().
 */
async function getInventWebListData() {
  const sheets = await getSheets();

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CFG.sheetName}!A${CFG.headerRow}:S${CFG.headerRow}`
  });
  const headers = (headerRes.data.values || [[]])[0];

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CFG.sheetName}!A${CFG.startRow}:S`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const values = dataRes.data.values || [];

  const rows = [];
  let previousBox = '';

  values.forEach((raw, index) => {
    // pad row to rowWidth
    const row = Array.from({ length: CFG.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const boxNumber = norm(row[CFG.boxCol - 1]);
    if (!boxNumber) return;

    const rowNumber = CFG.startRow + index;
    const baseAddress = norm(row[2]);
    const newAddress = norm(row[CFG.newAddressCol - 1]);
    const baseType = norm(row[3]);
    const newType = norm(row[CFG.newTypeCol - 1]);
    const baseTara = norm(row[CFG.taraCol - 1]);
    const newTara = norm(row[CFG.newTaraCol - 1]);
    const baseStatus = norm(row[CFG.statusCol - 1]);
    const newStatus = norm(row[CFG.newStatusCol - 1]);
    const baseQty = toNum(row[CFG.qtyCol - 1]);
    const hasNewValues = newAddress !== '' || newType !== '' || newTara !== '' || newStatus !== '' || cellStr(row[CFG.newQtyCol - 1]) !== '';

    const changeFlags = {
      qty: cellStr(row[CFG.newQtyCol - 1]) !== '',
      address: newAddress !== '',
      status: newStatus !== '',
      type: newType !== '',
      tara: newTara !== ''
    };

    rows.push({
      rowNumber,
      err: String(row[0] || ''),
      address: eff(row, CFG.newAddressCol, 3),
      type: eff(row, CFG.newTypeCol, 4),
      sku: String(row[4] || ''),
      tara: eff(row, CFG.newTaraCol, CFG.taraCol),
      status: eff(row, CFG.newStatusCol, CFG.statusCol),
      box: boxNumber,
      skuCount: Number(row[CFG.skuCountCol - 1] || 0),
      totalQty: Number(row[CFG.totalQtyCol - 1] || 0),
      barcode: String(row[CFG.barcodeCol - 1] || ''),
      qty: effQty(row),
      verified: row[CFG.verifiedCol - 1] === true,
      note: String(row[CFG.noteCol - 1] || ''),
      baseAddress, newAddress,
      baseType, newType,
      baseTara, newTara,
      baseStatus, newStatus,
      baseQty,
      newQty: cellStr(row[CFG.newQtyCol - 1]) === '' ? null : toNum(row[CFG.newQtyCol - 1]),
      isNewDraft: baseAddress === 'NEW' || baseType === 'NEW' || baseStatus === 'NEW' || (hasNewValues && previousBox !== boxNumber && baseQty === 0),
      hasChanges: Object.values(changeFlags).some(Boolean),
      changeFlags,
      isNewBoxStart: previousBox !== boxNumber
    });

    previousBox = boxNumber;
  });

  return {
    headers,
    rows,
    syncRevision: '0',
    stats: {
      rows: rows.length,
      boxes: new Set(rows.map(r => r.box)).size,
      verifiedRows: rows.filter(r => r.verified).length,
      errors: rows.filter(r => r.err && r.err !== 'OK').length
    }
  };
}

/**
 * Reads a single box for the editor payload (simplified).
 */
async function getBoxEditorPayload(rowNumber) {
  const sheets = await getSheets();
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CFG.sheetName}!A${CFG.startRow}:S`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const allRows = dataRes.data.values || [];

  // Find the target row and all rows with the same box number
  const targetIdx = rowNumber - CFG.startRow;
  if (targetIdx < 0 || targetIdx >= allRows.length) {
    throw new Error('Row not found');
  }
  const raw = allRows[targetIdx];
  const row = Array.from({ length: CFG.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
  const boxNumber = norm(row[CFG.boxCol - 1]);

  // Collect all rows of this box
  const items = [];
  const barcodeSet = new Set();
  const statusSet = new Set();
  const typeSet = new Set();

  allRows.forEach((r, idx) => {
    const padded = Array.from({ length: CFG.rowWidth }, (_, i) => r[i] !== undefined ? r[i] : '');
    const bn = norm(padded[CFG.boxCol - 1]);
    statusSet.add(norm(padded[CFG.statusCol - 1]));
    typeSet.add(norm(padded[3]));
    const bc = norm(padded[CFG.barcodeCol - 1]);
    if (bc) barcodeSet.add(bc);

    if (bn === boxNumber) {
      items.push({
        rowNumber: CFG.startRow + idx,
        barcode: bc,
        qty: toNum(padded[CFG.qtyCol - 1]),
        sku: String(padded[4] || ''),
        newQty: cellStr(padded[CFG.newQtyCol - 1]) === '' ? null : toNum(padded[CFG.newQtyCol - 1])
      });
    }
  });

  return {
    box: {
      boxNumber,
      type: eff(row, CFG.newTypeCol, 4),
      status: eff(row, CFG.newStatusCol, CFG.statusCol),
      tara: eff(row, CFG.newTaraCol, CFG.taraCol),
      address: eff(row, CFG.newAddressCol, 3),
      skuCount: Number(row[CFG.skuCountCol - 1] || 0),
      totalQty: Number(row[CFG.totalQtyCol - 1] || 0),
      note: String(row[CFG.noteCol - 1] || '')
    },
    items,
    barcodeOptions: [...barcodeSet].sort(),
    statusOptions: mergeOptions(statusSet, CANONICAL_STATUSES),
    typeOptions: mergeOptions(typeSet, CANONICAL_TYPES),
    taraOptions: CANONICAL_TARA
  };
}

/**
 * New box editor payload (simplified).
 */
async function getNewBoxEditorPayload() {
  const sheets = await getSheets();
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CFG.sheetName}!A${CFG.startRow}:S`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const allRows = dataRes.data.values || [];
  const barcodeSet = new Set();
  const statusSet = new Set();
  const typeSet = new Set();
  const boxNumbers = new Set();

  allRows.forEach(r => {
    const padded = Array.from({ length: CFG.rowWidth }, (_, i) => r[i] !== undefined ? r[i] : '');
    const bn = norm(padded[CFG.boxCol - 1]);
    if (bn) boxNumbers.add(bn);
    statusSet.add(norm(padded[CFG.statusCol - 1]));
    typeSet.add(norm(padded[3]));
    const bc = norm(padded[CFG.barcodeCol - 1]);
    if (bc) barcodeSet.add(bc);
  });

  return {
    box: {
      boxNumber: '',
      type: '',
      status: '',
      tara: 'K_1,00',
      address: '',
      skuCount: 0,
      totalQty: 0,
      note: ''
    },
    items: [],
    barcodeOptions: [...barcodeSet].sort(),
    statusOptions: mergeOptions(statusSet, CANONICAL_STATUSES),
    typeOptions: mergeOptions(typeSet, CANONICAL_TYPES),
    taraOptions: CANONICAL_TARA,
    existingBoxNumbers: [...boxNumbers]
  };
}

/**
 * Check if box number exists.
 */
async function checkBoxNumberExists(formatted) {
  const sheets = await getSheets();
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CFG.sheetName}!H${CFG.startRow}:H`
  });
  const values = (dataRes.data.values || []).flat();
  return values.some(v => norm(v) === norm(formatted));
}

// ---- ЧЕРНОВИК sheet config (mirrors CHERN_CFG from 0 конфиг.js) ----
// Template sheet is "0000", per-inventory sheets are named by code (VC007, VC008...)

const CHERN = {
  sheetName: '0000',  // template sheet name (fallback)
  headerRow: 1,
  startRow: 3,
  reportIdCol: 1, rowNumCol: 2, addressCol: 3, typeCol: 4, skuCol: 5,
  taraCol: 6, statusCol: 7, boxCol: 8, skuCountCol: 9, totalQtyCol: 10,
  barcodeCol: 11, qtyCol: 12, verifiedCol: 13, dateTimeCol: 14,
  newQtyCol: 15, newAddressCol: 16, newStatusCol: 17, newTypeCol: 18,
  newTaraCol: 19, noteCol: 20,
  rowWidth: 20
};

// ---- ЗАЯВКИ sheet config ----

const ZAYAVKI = {
  sheetName: 'ЗАЯВКИ',
  startRow: 5,
  clientCol: 1, idCol: 2, priorityCol: 3, createdCol: 4,
  statusCol: 5, typeCol: 6, codeCol: 7, deadlineCol: 10,
  rowWidth: 26
};

// ---- ОТЧЕТЫ sheet config ----

const OTCHETY = {
  sheetName: 'ОТЧЕТЫ',
  startRow: 5,
  clientNameCol: 1, reportIdCol: 2, requestIdCol: 3, startTimeCol: 4,
  verifiedTimeCol: 5, durationCol: 6,
  clientCol: 7, typeCol: 8, executorCol: 9,
  boxCountCol: 10, rowCountCol: 11, verifiedCountCol: 12,
  remainingCol: 13, changesCol: 14,
  statusCol: 15, commentCol: 16, techInfoCol: 17,
  rowWidth: 17
};

// ---- КОРОБЫ sheet config ----

const KOROBY = {
  sheetName: '🍬 КОРОБЫ',
  startRow: 8,
  taraCol: 3, boxCol: 4, statusCol: 5, requestCol: 6, typeCol: 7,
  skuNameCol: 8, qtyCol: 9, addressCol: 10,
  commentCol: 18, clientCol: 20, barcodeCol: 21,
  rowWidth: 21
};

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function fmtDate(v) {
  if (!v) return '';
  if (typeof v === 'number') {
    // Google Sheets serial date → JS date (rough conversion)
    const d = new Date((v - 25569) * 86400000);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }
  return String(v).trim();
}

/**
 * Returns active sessions (reports with status В РАБОТЕ).
 */
async function getActiveSessions() {
  const sheets = await getSheets();
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${OTCHETY.sheetName}!A${OTCHETY.startRow}:Q`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const values = dataRes.data.values || [];
  const result = [];

  values.forEach(raw => {
    const row = Array.from({ length: OTCHETY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const status = norm(row[OTCHETY.statusCol - 1]);
    if (status !== 'В РАБОТЕ') return;

    const reportId = norm(row[OTCHETY.reportIdCol - 1]);
    if (!reportId) return;

    result.push({
      reportId,
      requestId: norm(row[OTCHETY.requestIdCol - 1]),
      client: norm(row[OTCHETY.clientCol - 1]),
      type: norm(row[OTCHETY.typeCol - 1]),
      executor: norm(row[OTCHETY.executorCol - 1]),
      startTime: fmtDate(row[OTCHETY.startTimeCol - 1]),
      status
    });
  });

  return result;
}

/**
 * Returns заявки with status СОЗДАНО.
 */
async function getAvailableZayavki() {
  const sheets = await getSheets();
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ZAYAVKI.sheetName}!A${ZAYAVKI.startRow}:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const values = dataRes.data.values || [];
  const result = [];

  values.forEach((raw, index) => {
    const row = Array.from({ length: ZAYAVKI.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const status = norm(row[ZAYAVKI.statusCol - 1]);
    if (status !== 'СОЗДАНО') return;

    const id = norm(row[ZAYAVKI.idCol - 1]);
    if (!id) return;

    result.push({
      id,
      client: norm(row[ZAYAVKI.clientCol - 1]),
      type: norm(row[ZAYAVKI.typeCol - 1]),
      code: norm(row[ZAYAVKI.codeCol - 1]),
      priority: norm(row[ZAYAVKI.priorityCol - 1]),
      deadline: fmtDate(row[ZAYAVKI.deadlineCol - 1]),
      rowNumber: ZAYAVKI.startRow + index
    });
  });

  return result;
}

/**
 * Reads ЧЕРНОВИК rows by reportId — mirrors getChernWebListData_() from черновик.js.
 * @param {string} reportId
 * @param {string} [chernSheetName] — unique sheet name (e.g. VC007)
 */
async function getChernWebListData(reportId, chernSheetName) {
  const sheets = await getSheets();
  const targetSheet = chernSheetName || CHERN.sheetName;

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${targetSheet}'!A${CHERN.headerRow}:T${CHERN.headerRow}`
  });
  const headers = (headerRes.data.values || [[]])[0];

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${targetSheet}'!A${CHERN.startRow}:T`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const values = dataRes.data.values || [];

  if (values.length === 0) {
    return { headers: [], rows: [], syncRevision: '0', stats: { rows: 0, boxes: 0, verifiedRows: 0, errors: 0 } };
  }

  const rows = [];
  let previousBox = '';

  values.forEach((raw, index) => {
    const row = Array.from({ length: CHERN.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const rid = norm(row[CHERN.reportIdCol - 1]);
    if (rid !== reportId) return;

    const boxNumber = norm(row[CHERN.boxCol - 1]);
    if (!boxNumber) return;

    const rowNumber = CHERN.startRow + index;
    const baseAddress = norm(row[CHERN.addressCol - 1]);
    const newAddress = norm(row[CHERN.newAddressCol - 1]);
    const baseType = norm(row[CHERN.typeCol - 1]);
    const newType = norm(row[CHERN.newTypeCol - 1]);
    const baseTara = norm(row[CHERN.taraCol - 1]);
    const newTara = norm(row[CHERN.newTaraCol - 1]);
    const baseStatus = norm(row[CHERN.statusCol - 1]);
    const newStatus = norm(row[CHERN.newStatusCol - 1]);
    const baseQty = toNum(row[CHERN.qtyCol - 1]);
    const newQtyRaw = row[CHERN.newQtyCol - 1];
    const newQtyStr = (newQtyRaw === '' || newQtyRaw == null) ? '' : String(newQtyRaw).trim();

    const changeFlags = {
      qty: newQtyStr !== '',
      address: newAddress !== '',
      status: newStatus !== '',
      type: newType !== '',
      tara: newTara !== ''
    };

    rows.push({
      rowNumber,
      chernRow: rowNumber,
      err: '',
      address: newAddress || baseAddress,
      type: newType || baseType,
      sku: String(row[CHERN.skuCol - 1] || ''),
      tara: newTara || baseTara,
      status: newStatus || baseStatus,
      box: boxNumber,
      skuCount: Number(row[CHERN.skuCountCol - 1] || 0),
      totalQty: Number(row[CHERN.totalQtyCol - 1] || 0),
      barcode: String(row[CHERN.barcodeCol - 1] || ''),
      qty: newQtyStr !== '' ? (Number(newQtyRaw) || 0) : baseQty,
      verified: row[CHERN.verifiedCol - 1] === true,
      note: String(row[CHERN.noteCol - 1] || ''),
      baseAddress, newAddress,
      baseType, newType,
      baseTara, newTara,
      baseStatus, newStatus,
      baseQty,
      newQty: newQtyStr === '' ? null : (Number(newQtyRaw) || 0),
      isNewDraft: false,
      hasChanges: Object.values(changeFlags).some(Boolean),
      changeFlags,
      isNewBoxStart: previousBox !== boxNumber,
      syncStatus: 'connected'
    });

    previousBox = boxNumber;
  });

  return {
    headers,
    rows,
    syncRevision: String(Date.now()),
    stats: {
      rows: rows.length,
      boxes: new Set(rows.map(r => r.box)).size,
      verifiedRows: rows.filter(r => r.verified).length,
      errors: 0
    }
  };
}

/**
 * Start inventory session (dev mode — creates report row, loads boxes to ЧЕРНОВИК).
 */
async function startInventSession(zayavkaId, employeeName) {
  const sheets = await getSheets();

  // 1. Find заявка
  const zayavkiRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ZAYAVKI.sheetName}!A${ZAYAVKI.startRow}:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const zayavkiRows = zayavkiRes.data.values || [];
  let zayavka = null;
  let zayavkaRowIdx = -1;

  for (let i = 0; i < zayavkiRows.length; i++) {
    const raw = zayavkiRows[i];
    const row = Array.from({ length: ZAYAVKI.rowWidth }, (_, j) => raw[j] !== undefined ? raw[j] : '');
    if (norm(row[ZAYAVKI.idCol - 1]) === zayavkaId) {
      zayavka = {
        id: norm(row[ZAYAVKI.idCol - 1]),
        client: norm(row[ZAYAVKI.clientCol - 1]),
        type: norm(row[ZAYAVKI.typeCol - 1]),
        code: norm(row[ZAYAVKI.codeCol - 1]),
        status: norm(row[ZAYAVKI.statusCol - 1])
      };
      zayavkaRowIdx = ZAYAVKI.startRow + i;
      break;
    }
  }

  if (!zayavka) throw new Error('Заявка "' + zayavkaId + '" не найдена.');
  if (zayavka.status !== 'СОЗДАНО') throw new Error('Заявка уже в статусе "' + zayavka.status + '".');

  // 2. Generate reportId
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${String(now.getFullYear()).slice(2)}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const reportId = `${zayavkaId}_${dateStr}_${timeStr}`;

  // 3. Create report row in ОТЧЕТЫ
  const reportRow = new Array(OTCHETY.rowWidth).fill('');
  reportRow[OTCHETY.clientNameCol - 1] = zayavka.client;
  reportRow[OTCHETY.reportIdCol - 1] = reportId;
  reportRow[OTCHETY.requestIdCol - 1] = zayavkaId;
  reportRow[OTCHETY.startTimeCol - 1] = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  reportRow[OTCHETY.clientCol - 1] = zayavka.client;
  reportRow[OTCHETY.typeCol - 1] = zayavka.type;
  reportRow[OTCHETY.executorCol - 1] = employeeName;
  reportRow[OTCHETY.statusCol - 1] = 'В РАБОТЕ';
  reportRow[OTCHETY.techInfoCol - 1] = 'v040-dev, session_' + Date.now();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${OTCHETY.sheetName}!A${OTCHETY.startRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [reportRow] }
  });

  // 4. Extract shortCode and create unique sheet (copy from template "0000")
  const shortMatch = zayavkaId.match(/^([A-Z]{2}\d{3})/);
  const shortCode = shortMatch ? shortMatch[1] : zayavkaId.replace(/-.*/, '');
  const chernSheetName = shortCode; // e.g. "VC007"

  // Check if sheet already exists
  const ssRes = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties(title,sheetId)'
  });
  const existingSheets = ssRes.data.sheets.map(s => s.properties.title);

  if (!existingSheets.includes(chernSheetName)) {
    // Find template "0000" sheet
    const templateSheet = ssRes.data.sheets.find(s => s.properties.title === '0000');
    if (templateSheet) {
      // Duplicate template — preserves formatting, headers, column widths
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            duplicateSheet: {
              sourceSheetId: templateSheet.properties.sheetId,
              newSheetName: chernSheetName
            }
          }]
        }
      });
    } else {
      // Fallback: create from scratch + copy headers from ЧЕРНОВИК
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: chernSheetName } } }]
        }
      });
      const templateHeaders = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${CHERN.sheetName}'!A${CHERN.headerRow}:T${CHERN.headerRow}`
      });
      if (templateHeaders.data.values) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${chernSheetName}'!A${CHERN.headerRow}:T${CHERN.headerRow}`,
          valueInputOption: 'RAW',
          requestBody: { values: templateHeaders.data.values }
        });
      }
    }
  }

  // 5. Load boxes from КОРОБЫ → unique ЧЕРНОВИК sheet
  const korobyRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${KOROBY.sheetName}'!A${KOROBY.startRow}:U`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const korobyRows = korobyRes.data.values || [];

  const filtered = korobyRows.filter(raw => {
    const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    return norm(row[KOROBY.clientCol - 1]) === zayavka.client;
  });

  let rowCount = 0;
  let skuCountBefore = 0;
  let totalQtyBefore = 0;
  const boxSet = new Set();

  if (filtered.length > 0) {
    const boxAgg = {};
    filtered.forEach(raw => {
      const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
      const box = norm(row[KOROBY.boxCol - 1]);
      if (!box) return;
      if (!boxAgg[box]) boxAgg[box] = { skuSet: {}, totalQty: 0 };
      const barcode = norm(row[KOROBY.barcodeCol - 1]);
      const qty = Number(row[KOROBY.qtyCol - 1]) || 0;
      if (barcode) boxAgg[box].skuSet[barcode] = true;
      boxAgg[box].totalQty += qty;
    });

    const chernRows = [];
    let counter = 1;

    filtered.forEach(raw => {
      const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
      const box = norm(row[KOROBY.boxCol - 1]);
      if (!box) return;
      const agg = boxAgg[box] || { skuSet: {}, totalQty: 0 };

      const chernRow = new Array(CHERN.rowWidth).fill('');
      chernRow[CHERN.reportIdCol - 1] = reportId;
      chernRow[CHERN.rowNumCol - 1] = counter;
      chernRow[CHERN.addressCol - 1] = norm(row[KOROBY.addressCol - 1]);
      chernRow[CHERN.typeCol - 1] = norm(row[KOROBY.typeCol - 1]);
      chernRow[CHERN.skuCol - 1] = norm(row[KOROBY.skuNameCol - 1]);
      chernRow[CHERN.taraCol - 1] = norm(row[KOROBY.taraCol - 1]);
      chernRow[CHERN.statusCol - 1] = norm(row[KOROBY.statusCol - 1]);
      chernRow[CHERN.boxCol - 1] = box;
      chernRow[CHERN.skuCountCol - 1] = Object.keys(agg.skuSet).length;
      chernRow[CHERN.totalQtyCol - 1] = agg.totalQty;
      chernRow[CHERN.barcodeCol - 1] = norm(row[KOROBY.barcodeCol - 1]);
      chernRow[CHERN.qtyCol - 1] = Number(row[KOROBY.qtyCol - 1]) || 0;
      chernRow[CHERN.verifiedCol - 1] = false;

      chernRows.push(chernRow);
      boxSet.add(box);
      counter++;
    });

    // Write to unique ЧЕРНОВИК sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${chernSheetName}'!A${CHERN.startRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: chernRows }
    });

    rowCount = chernRows.length;

    // Calculate aggregate SKU count and total qty for "before" columns
    const barcodeSetAll = new Set();
    let totalQtyAll = 0;
    chernRows.forEach(cr => {
      const bc = String(cr[CHERN.barcodeCol - 1] || '').trim();
      if (bc) barcodeSetAll.add(bc);
      totalQtyAll += Number(cr[CHERN.qtyCol - 1]) || 0;
    });
    skuCountBefore = barcodeSetAll.size;
    totalQtyBefore = totalQtyAll;
  }

  // 6. Update заявка: status + start time + static values + formulas
  const boxCount = boxSet.size;
  const startTimeFmt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const sr = CHERN.startRow; // 3

  // Read ЗАЯВКИ headers to find columns by name
  const zHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ZAYAVKI.sheetName}'!A3:AZ3`
  });
  const zHeaders = (zHeaderRes.data.values || [[]])[0];
  const zHeaderMap = {};
  zHeaders.forEach((h, i) => { if (h) zHeaderMap[String(h).trim()] = i + 1; });

  const zayBatch = [];
  const zaySet = (headerName, value) => {
    const col = zHeaderMap[headerName];
    if (col) zayBatch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(col)}${zayavkaRowIdx}`, values: [[value]] });
  };
  zaySet('СТАТУС', 'В РАБОТЕ');
  zaySet('СТАРТ ИНВ', startTimeFmt);
  zaySet('КОЛ КОР', boxCount);
  zaySet('КОЛ СТР', rowCount);
  zaySet('КОР ДО', boxCount);
  zaySet('СКЮ ДО', skuCountBefore);
  zaySet('ЕД ДО', totalQtyBefore);
  // Формулы для живых счётчиков (USER_ENTERED интерпретирует строки с = как формулы)
  zaySet('ПРОВ СТР', `=COUNTIF('${chernSheetName}'!M${sr}:M;TRUE)`);
  const kolStrCol = zHeaderMap['КОЛ СТР'];
  const provStrCol = zHeaderMap['ПРОВ СТР'];
  if (kolStrCol && provStrCol) {
    zaySet('ОСТ СТР', `=${colLetter(kolStrCol)}${zayavkaRowIdx}-${colLetter(provStrCol)}${zayavkaRowIdx}`);
  }
  zaySet('ИЗМ СТР',
    `=SUMPRODUCT((('${chernSheetName}'!O${sr}:O<>"")` +
    `+('${chernSheetName}'!P${sr}:P<>"")` +
    `+('${chernSheetName}'!Q${sr}:Q<>"")` +
    `+('${chernSheetName}'!R${sr}:R<>"")` +
    `+('${chernSheetName}'!S${sr}:S<>"")>0)*1)`
  );

  // 7. Update ОТЧЕТЫ: J-N static + formulas
  const oRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.reportIdCol)}${OTCHETY.startRow}:${colLetter(OTCHETY.reportIdCol)}`,
  });
  const oIds = (oRes.data.values || []).flat();
  let oRow = -1;
  for (let i = 0; i < oIds.length; i++) {
    if (String(oIds[i]).trim() === reportId) { oRow = OTCHETY.startRow + i; break; }
  }

  if (oRow > 0) {
    const kL = colLetter(OTCHETY.rowCountCol);   // K
    const lL = colLetter(OTCHETY.verifiedCountCol); // L
    zayBatch.push({ range: `'${OTCHETY.sheetName}'!J${oRow}`, values: [[boxCount]] });
    zayBatch.push({ range: `'${OTCHETY.sheetName}'!K${oRow}`, values: [[rowCount]] });
    zayBatch.push({ range: `'${OTCHETY.sheetName}'!L${oRow}`, values: [[`=COUNTIF('${chernSheetName}'!M${sr}:M;TRUE)`]] });
    zayBatch.push({ range: `'${OTCHETY.sheetName}'!M${oRow}`, values: [[`=${kL}${oRow}-${lL}${oRow}`]] });
    zayBatch.push({ range: `'${OTCHETY.sheetName}'!N${oRow}`, values: [[
      `=SUMPRODUCT((('${chernSheetName}'!O${sr}:O<>"")` +
      `+('${chernSheetName}'!P${sr}:P<>"")` +
      `+('${chernSheetName}'!Q${sr}:Q<>"")` +
      `+('${chernSheetName}'!R${sr}:R<>"")` +
      `+('${chernSheetName}'!S${sr}:S<>"")>0)*1)`
    ]] });
  }

  if (zayBatch.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: zayBatch }
    });
  }

  return {
    reportId,
    rowCount,
    boxCount,
    chernSheetName
  };
}

/**
 * Batch update ЧЕРНОВИК rows (verified, qty, note, dateTime).
 * @param {Array} updates
 * @param {string} [chernSheetName] — unique sheet name (e.g. VC007)
 */
async function updateChernRowBatch(updates, chernSheetName) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: true, synced: 0 };
  }

  const sheets = await getSheets();
  const targetSheet = chernSheetName || CHERN.sheetName;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateTimeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const data = [];

  updates.forEach(update => {
    const row = Number(update.chernRow);
    if (!Number.isFinite(row) || row < CHERN.startRow) return;
    const u = update.updates || {};

    if (u.verified !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.verifiedCol)}${row}`,
        values: [[u.verified === true || u.verified === 'true']]
      });
    }

    if (u.qty !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.newQtyCol)}${row}`,
        values: [[Number(u.qty) || 0]]
      });
    }

    if (u.note !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.noteCol)}${row}`,
        values: [[String(u.note)]]
      });
    }

    if (u.newAddress !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.newAddressCol)}${row}`,
        values: [[String(u.newAddress)]]
      });
    }

    if (u.newStatus !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.newStatusCol)}${row}`,
        values: [[String(u.newStatus)]]
      });
    }

    if (u.newType !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.newTypeCol)}${row}`,
        values: [[String(u.newType)]]
      });
    }

    if (u.newTara !== undefined) {
      data.push({
        range: `'${targetSheet}'!${colLetter(CHERN.newTaraCol)}${row}`,
        values: [[String(u.newTara)]]
      });
    }

    // Always update dateTime
    data.push({
      range: `'${targetSheet}'!${colLetter(CHERN.dateTimeCol)}${row}`,
      values: [[dateTimeStr]]
    });
  });

  if (data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data
      }
    });
  }

  return { ok: true, synced: updates.length };
}

/**
 * Preview boxes from КОРОБЫ for a given zayavkaId (read-only, no ЧЕРНОВИК write).
 */
async function getPreviewBoxes(zayavkaId) {
  const sheets = await getSheets();

  // Find заявка to get client name
  const zRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ZAYAVKI.sheetName}!A${ZAYAVKI.startRow}:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  let client = null;
  for (const raw of (zRes.data.values || [])) {
    const row = Array.from({ length: ZAYAVKI.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    if (norm(row[ZAYAVKI.idCol - 1]) === zayavkaId) {
      client = norm(row[ZAYAVKI.clientCol - 1]);
      break;
    }
  }
  if (!client) throw new Error('Заявка "' + zayavkaId + '" не найдена.');

  // Read КОРОБЫ
  const kRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${KOROBY.sheetName}!A${KOROBY.startRow}:U`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const allRows = kRes.data.values || [];
  const filtered = allRows.filter(raw => {
    const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    return norm(row[KOROBY.clientCol - 1]) === client;
  });

  if (filtered.length === 0) {
    return { headers: [], rows: [], syncRevision: '0', stats: { rows: 0, boxes: 0, verifiedRows: 0, errors: 0 } };
  }

  // Aggregates per box
  const boxAgg = {};
  filtered.forEach(raw => {
    const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const box = norm(row[KOROBY.boxCol - 1]);
    if (!box) return;
    if (!boxAgg[box]) boxAgg[box] = { skuSet: {}, totalQty: 0 };
    const barcode = norm(row[KOROBY.barcodeCol - 1]);
    const qty = Number(row[KOROBY.qtyCol - 1]) || 0;
    if (barcode) boxAgg[box].skuSet[barcode] = true;
    boxAgg[box].totalQty += qty;
  });

  const rows = [];
  let previousBox = '';

  filtered.forEach((raw, index) => {
    const row = Array.from({ length: KOROBY.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
    const box = norm(row[KOROBY.boxCol - 1]);
    if (!box) return;
    const agg = boxAgg[box] || { skuSet: {}, totalQty: 0 };
    const address = norm(row[KOROBY.addressCol - 1]);
    const type = norm(row[KOROBY.typeCol - 1]);
    const tara = norm(row[KOROBY.taraCol - 1]);
    const status = norm(row[KOROBY.statusCol - 1]);
    const barcode = norm(row[KOROBY.barcodeCol - 1]);
    const qty = Number(row[KOROBY.qtyCol - 1]) || 0;
    const sku = norm(row[KOROBY.skuNameCol - 1]);

    rows.push({
      rowNumber: index + 1, chernRow: null, err: '',
      address, type, sku, tara, status, box,
      skuCount: Object.keys(agg.skuSet).length,
      totalQty: agg.totalQty,
      barcode, qty,
      verified: false, note: '',
      baseAddress: address, newAddress: '',
      baseType: type, newType: '',
      baseTara: tara, newTara: '',
      baseStatus: status, newStatus: '',
      baseQty: qty, newQty: null,
      isNewDraft: false, hasChanges: false,
      changeFlags: { qty: false, address: false, status: false, type: false, tara: false },
      isNewBoxStart: previousBox !== box,
      syncStatus: ''
    });
    previousBox = box;
  });

  return {
    headers: [],
    rows,
    syncRevision: '0',
    stats: {
      rows: rows.length,
      boxes: new Set(rows.map(r => r.box)).size,
      verifiedRows: 0,
      errors: 0
    }
  };
}

/**
 * Append new rows to ЧЕРНОВИК sheet (new barcodes / new boxes from modal).
 */
async function appendChernRows(newRows, reportId, chernSheetName) {
  if (!Array.isArray(newRows) || newRows.length === 0) {
    return { ok: true, appended: 0, startRow: -1 };
  }

  const sheets = await getSheets();
  const targetSheet = chernSheetName || CHERN.sheetName;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateTimeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // Find next row number (col B) for sequential numbering
  let nextRowNum = 1;
  try {
    const existingRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${targetSheet}'!B${CHERN.startRow}:B`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const existing = (existingRes.data.values || []).flat();
    existing.forEach(v => {
      const n = Number(v);
      if (n >= nextRowNum) nextRowNum = n + 1;
    });
  } catch (e) { /* empty sheet */ }

  const sheetRows = newRows.map(nr => {
    const row = new Array(CHERN.rowWidth).fill('');
    row[CHERN.reportIdCol - 1]   = reportId;
    row[CHERN.rowNumCol - 1]     = nextRowNum++;
    row[CHERN.addressCol - 1]    = norm(nr.address);
    row[CHERN.typeCol - 1]       = norm(nr.type);
    row[CHERN.skuCol - 1]        = norm(nr.sku);
    row[CHERN.taraCol - 1]       = norm(nr.tara);
    row[CHERN.statusCol - 1]     = norm(nr.status);
    row[CHERN.boxCol - 1]        = norm(nr.box);
    row[CHERN.skuCountCol - 1]   = Number(nr.skuCount) || 0;
    row[CHERN.totalQtyCol - 1]   = Number(nr.totalQty) || 0;
    row[CHERN.barcodeCol - 1]    = norm(nr.barcode);
    row[CHERN.qtyCol - 1]        = Number(nr.qty) || 0;
    row[CHERN.verifiedCol - 1]   = nr.verified === true;
    row[CHERN.dateTimeCol - 1]   = dateTimeStr;
    row[CHERN.noteCol - 1]       = norm(nr.note);
    if (nr.newQty !== undefined && nr.newQty !== null) row[CHERN.newQtyCol - 1] = Number(nr.newQty) || 0;
    if (nr.newAddress) row[CHERN.newAddressCol - 1] = String(nr.newAddress);
    if (nr.newStatus) row[CHERN.newStatusCol - 1] = String(nr.newStatus);
    if (nr.newType) row[CHERN.newTypeCol - 1] = String(nr.newType);
    if (nr.newTara) row[CHERN.newTaraCol - 1] = String(nr.newTara);
    return row;
  });

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${targetSheet}'!A${CHERN.startRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: sheetRows }
  });

  // Parse the actual row range from the response
  const updatedRange = result.data.updates && result.data.updates.updatedRange || '';
  const rangeMatch = updatedRange.match(/!A(\d+):/);
  const startRow = rangeMatch ? Number(rangeMatch[1]) : -1;

  return { ok: true, appended: sheetRows.length, startRow };
}

/**
 * Finalize report: formulas → static values, set status ЗАВЕРШЁН, hide sheet.
 */
async function finalizeReport(reportId) {
  const sheets = await getSheets();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const endTimeFmt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // 1. Find report row in ОТЧЕТЫ
  const oRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.reportIdCol)}${OTCHETY.startRow}:${colLetter(OTCHETY.reportIdCol)}`
  });
  const oIds = (oRes.data.values || []).flat();
  let oRow = -1;
  for (let i = 0; i < oIds.length; i++) {
    if (String(oIds[i]).trim() === reportId) { oRow = OTCHETY.startRow + i; break; }
  }
  if (oRow < 0) throw new Error('Отчёт "' + reportId + '" не найден в ОТЧЕТЫ.');

  // 2. Read current formula display values from ОТЧЕТЫ (L, M, N)
  const oFormulas = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.verifiedCountCol)}${oRow}:${colLetter(OTCHETY.changesCol)}${oRow}`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const oVals = (oFormulas.data.values || [[]])[0];
  const provVal = Number(oVals[0]) || 0;
  const ostVal = Number(oVals[1]) || 0;
  const izmVal = Number(oVals[2]) || 0;

  // 3. Read start time for duration calc
  const startRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.startTimeCol)}${oRow}`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const startStr = ((startRes.data.values || [[]])[0] || [''])[0];
  let durationMin = 0;
  if (startStr) {
    const m = String(startStr).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const startDate = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
      durationMin = Math.round((now - startDate) / 60000);
      if (durationMin < 0) durationMin = 0;
    }
  }

  // 4. Read requestId from ОТЧЕТЫ
  const reqRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.requestIdCol)}${oRow}`
  });
  const requestId = String(((reqRes.data.values || [[]])[0] || [''])[0]).trim();

  // 5. Build batch update — ОТЧЕТЫ: replace formulas with values + set end time, duration, status
  const batch = [
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.verifiedCountCol)}${oRow}`, values: [[provVal]] },
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.remainingCol)}${oRow}`, values: [[ostVal]] },
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.changesCol)}${oRow}`, values: [[izmVal]] },
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.verifiedTimeCol)}${oRow}`, values: [[endTimeFmt]] },
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.durationCol)}${oRow}`, values: [[durationMin]] },
    { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.statusCol)}${oRow}`, values: [['ЗАВЕРШЁН']] }
  ];

  // 6. Update ЗАЯВКИ — replace formulas with values + set status + end time
  let zRow = -1;
  let zHeaderMap = {};
  if (requestId) {
    const zHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ZAYAVKI.sheetName}'!A3:AZ3`
    });
    const zHeaders = (zHeaderRes.data.values || [[]])[0];
    zHeaders.forEach((h, i) => { if (h) zHeaderMap[String(h).trim()] = i + 1; });

    // Find zayvka row
    const zIdCol = zHeaderMap['ID_ЗАЯВКИ'] || ZAYAVKI.idCol;
    const zIdRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ZAYAVKI.sheetName}'!${colLetter(zIdCol)}${ZAYAVKI.startRow}:${colLetter(zIdCol)}`
    });
    const zIds = (zIdRes.data.values || []).flat();
    for (let i = 0; i < zIds.length; i++) {
      if (String(zIds[i]).trim() === requestId) { zRow = ZAYAVKI.startRow + i; break; }
    }

    if (zRow > 0) {
      // Read formula display values from ЗАЯВКИ
      const provCol = zHeaderMap['ПРОВ СТР'];
      const ostCol = zHeaderMap['ОСТ СТР'];
      const izmCol = zHeaderMap['ИЗМ СТР'];

      if (provCol) {
        const r = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${ZAYAVKI.sheetName}'!${colLetter(provCol)}${zRow}:${colLetter(izmCol || provCol)}${zRow}`,
          valueRenderOption: 'FORMATTED_VALUE'
        });
        const vals = (r.data.values || [[]])[0];
        if (provCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(provCol)}${zRow}`, values: [[Number(vals[0]) || 0]] });
        if (ostCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(ostCol)}${zRow}`, values: [[Number(vals[1]) || 0]] });
        if (izmCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(izmCol)}${zRow}`, values: [[Number(vals[2]) || 0]] });
      }

      // Status + end time
      const statusCol = zHeaderMap['СТАТУС'];
      const endCol = zHeaderMap['ЗАВ ИНВ'];
      if (statusCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(statusCol)}${zRow}`, values: [['ЗАВЕРШЕНО']] });
      if (endCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(endCol)}${zRow}`, values: [[endTimeFmt]] });

      // Read "before" values from ЗАЯВКИ
      const korDoCol = zHeaderMap['КОР ДО'];
      const skuDoCol = zHeaderMap['СКЮ ДО'];
      const edDoCol = zHeaderMap['ЕД ДО'];
      let korDo = 0, skuDo = 0, edDo = 0;
      if (korDoCol || skuDoCol || edDoCol) {
        const beforeRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${ZAYAVKI.sheetName}'!A${zRow}:AZ${zRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE'
        });
        const zRowData = (beforeRes.data.values || [[]])[0];
        if (korDoCol) korDo = Number(zRowData[korDoCol - 1]) || 0;
        if (skuDoCol) skuDo = Number(zRowData[skuDoCol - 1]) || 0;
        if (edDoCol) edDo = Number(zRowData[edDoCol - 1]) || 0;
      }

      // Read ЧЕРНОВИК data to calculate "after" values
      const shortMatch2 = reportId.match(/^([A-Z]{2}\d{3})/);
      const shortCode2 = shortMatch2 ? shortMatch2[1] : '';
      if (shortCode2) {
        const chernRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${shortCode2}'!A${CHERN.startRow}:T`,
          valueRenderOption: 'UNFORMATTED_VALUE'
        });
        const chernData = chernRes.data.values || [];

        // Aggregate: boxes, barcodes, qty (using effective qty = newQty if set, else base qty)
        const boxesAfter = new Set();
        const barcodeQtyBefore = {}; // barcode → sum of base qty
        const barcodeQtyAfter = {};  // barcode → sum of effective qty
        let totalQtyAfter = 0;

        chernData.forEach(raw => {
          const row = Array.from({ length: CHERN.rowWidth }, (_, i) => raw[i] !== undefined ? raw[i] : '');
          const box = String(row[CHERN.boxCol - 1] || '').trim();
          const barcode = String(row[CHERN.barcodeCol - 1] || '').trim();
          const baseQty = Number(row[CHERN.qtyCol - 1]) || 0;
          const newQtyRaw = row[CHERN.newQtyCol - 1];
          const newQtyStr = String(newQtyRaw === undefined || newQtyRaw === null ? '' : newQtyRaw).trim();
          const effQty = newQtyStr !== '' ? (Number(newQtyRaw) || 0) : baseQty;

          if (box) boxesAfter.add(box);
          if (barcode) {
            barcodeQtyBefore[barcode] = (barcodeQtyBefore[barcode] || 0) + baseQty;
            barcodeQtyAfter[barcode] = (barcodeQtyAfter[barcode] || 0) + effQty;
          }
          totalQtyAfter += effQty;
        });

        const korPosl = boxesAfter.size;
        // СКЮ ПОСЛ = barcodes with total effective qty > 0
        const skuPosl = Object.keys(barcodeQtyAfter).filter(bc => barcodeQtyAfter[bc] > 0).length;
        const edPosl = totalQtyAfter;

        // Diffs
        const rasxKor = korPosl - korDo;
        const rasxSku = skuPosl - skuDo;
        const rasxEd = edPosl - edDo;

        // ИЗМ ПО БАР — detail of changed barcodes
        const changedBarcodes = [];
        const allBarcodes = new Set([...Object.keys(barcodeQtyBefore), ...Object.keys(barcodeQtyAfter)]);
        allBarcodes.forEach(bc => {
          const before = barcodeQtyBefore[bc] || 0;
          const after = barcodeQtyAfter[bc] || 0;
          if (before !== after) {
            changedBarcodes.push(`${bc}  ${before}\u2192${after}`);
          }
        });
        const izmPoBarText = changedBarcodes.join('\n');

        // Write "after" columns
        const zSet = (name, val) => {
          const col = zHeaderMap[name];
          if (col) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(col)}${zRow}`, values: [[val]] });
        };
        zSet('КОР ПОСЛ', korPosl);
        zSet('РАСХ КОР', rasxKor);
        zSet('СКЮ ПОСЛ', skuPosl);
        zSet('РАСХ СКЮ', rasxSku);
        zSet('ЕД ПОСЛ', edPosl);
        zSet('РАСХ ЕД', rasxEd);
        zSet('ИЗМ ПО БАР', izmPoBarText);
      }
    }
  }

  // 7. Execute batch update (ОТЧЕТЫ + ЗАЯВКИ)
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: batch }
  });

  // 7.5. Sync to production КОРОБЫ in Upseller
  let syncResult = null;
  try {
    // Read clientName from ОТЧЕТЫ
    const clientRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.clientCol)}${oRow}`
    });
    const clientName = norm(((clientRes.data.values || [[]])[0] || [''])[0]);
    syncResult = await syncToKoroby(reportId, clientName, requestId);
  } catch (syncErr) {
    // Set error status in ОТЧЕТЫ and ЗАЯВКИ
    const errorBatch = [
      { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.statusCol)}${oRow}`, values: [['ОШИБКА']] },
      { range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.techInfoCol)}${oRow}`, values: [['Ошибка синхронизации КОРОБЫ: ' + (syncErr.message || syncErr)]] }
    ];
    if (zRow > 0) {
      const statusCol2 = zHeaderMap && zHeaderMap['СТАТУС'];
      if (statusCol2) errorBatch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(statusCol2)}${zRow}`, values: [['ОШИБКА']] });
    }
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: errorBatch }
    });
    return { ok: false, message: 'Синхронизация КОРОБЫ не удалась: ' + (syncErr.message || syncErr) };
  }

  // 8. Hide the sheet
  const shortMatch = reportId.match(/^([A-Z]{2}\d{3})/);
  const shortCode = shortMatch ? shortMatch[1] : '';
  if (shortCode) {
    const metaRes = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties(title,sheetId)'
    });
    const chernSheet = metaRes.data.sheets.find(s => s.properties.title === shortCode);
    if (chernSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: chernSheet.properties.sheetId, hidden: true },
              fields: 'hidden'
            }
          }]
        }
      });
    }
  }

  const syncMsg = syncResult ? ` Обновлено: ${syncResult.updatedRows}, новых: ${syncResult.newRows}` : '';
  return { ok: true, message: 'Отчёт завершён: ' + reportId + '.' + syncMsg, durationMin };
}

/**
 * Sync inventory results from draft sheet (VCXXX) to production КОРОБЫ in Upseller.
 * Called from finalizeReport() after all other steps.
 */
async function syncToKoroby(reportId, clientName, requestId) {
  const sheets = await getSheets();

  // 1. Read ALL rows from КОРОБЫ (Upseller)
  const kRes = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELLER_SPREADSHEET_ID,
    range: `'${KOROBY.sheetName}'!A${KOROBY.startRow}:U`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const kAllRows = kRes.data.values || [];

  // 2. Index КОРОБЫ by client: key "box|barcode" → { absRow, data }
  const korobyIndex = new Map();
  kAllRows.forEach((raw, i) => {
    const row = Array.from({ length: KOROBY.rowWidth }, (_, j) => raw[j] !== undefined ? raw[j] : '');
    if (norm(row[KOROBY.clientCol - 1]) !== clientName) return;
    const box = norm(row[KOROBY.boxCol - 1]);
    const barcode = norm(row[KOROBY.barcodeCol - 1]);
    if (!box || !barcode) return;
    korobyIndex.set(box + '|' + barcode, { absRow: KOROBY.startRow + i, data: row });
  });

  // 3. Read draft sheet
  const shortMatch = reportId.match(/^([A-Z]{2}\d{3})/);
  const shortCode = shortMatch ? shortMatch[1] : '';
  if (!shortCode) throw new Error('Cannot extract shortCode from reportId: ' + reportId);

  const cRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${shortCode}'!A${CHERN.startRow}:T`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const cAllRows = cRes.data.values || [];

  // 4. Index draft: key "box|barcode" → row data
  const draftIndex = new Map();
  cAllRows.forEach(raw => {
    const row = Array.from({ length: CHERN.rowWidth }, (_, j) => raw[j] !== undefined ? raw[j] : '');
    if (norm(row[CHERN.reportIdCol - 1]) !== reportId) return;
    const box = norm(row[CHERN.boxCol - 1]);
    const barcode = norm(row[CHERN.barcodeCol - 1]);
    if (!box || !barcode) return;
    draftIndex.set(box + '|' + barcode, row);
  });

  // 5. SAFETY CHECK: all КОРОБЫ keys must exist in draft
  const missingKeys = [];
  for (const [key] of korobyIndex) {
    if (!draftIndex.has(key)) missingKeys.push(key);
  }
  if (missingKeys.length > 0) {
    throw new Error('Обнаружены коробы в КОРОБЫ (' + missingKeys.length + ' шт.), отсутствующие в черновике. ' +
      'Необходима дополнительная инвентаризация. Примеры: ' + missingKeys.slice(0, 3).join(', '));
  }

  // 6. Build updates for matched rows and collect new rows
  const batch = [];
  const newRows = [];
  let updatedCount = 0;
  const K = KOROBY;
  const C = CHERN;
  const sn = K.sheetName;

  for (const [key, draftRow] of draftIndex) {
    if (korobyIndex.has(key)) {
      // MATCHED — update in place
      const { absRow, data: oldRow } = korobyIndex.get(key);
      const commentParts = [];

      const oldRequest = norm(oldRow[K.requestCol - 1]);
      if (oldRequest && oldRequest !== requestId) commentParts.push('ЗАЯВКА=' + oldRequest);
      batch.push({ range: `'${sn}'!${colLetter(K.requestCol)}${absRow}`, values: [[requestId]] });

      const newQtyRaw = draftRow[C.newQtyCol - 1];
      const newQtyStr = (newQtyRaw === '' || newQtyRaw == null) ? '' : String(newQtyRaw).trim();
      if (newQtyStr !== '') {
        const newQtyNum = Number(newQtyRaw) || 0;
        commentParts.push('КОЛ=' + oldRow[K.qtyCol - 1] + '→' + newQtyStr);
        batch.push({ range: `'${sn}'!${colLetter(K.qtyCol)}${absRow}`, values: [[newQtyNum]] });
        // Если новое количество = 0, ставим статус СПИСАНО
        if (newQtyNum === 0) {
          const oldStatusForWrite = norm(oldRow[K.statusCol - 1]);
          if (oldStatusForWrite !== 'СПИСАНО') {
            commentParts.push('СТАТУС=' + oldStatusForWrite + '→СПИСАНО');
            batch.push({ range: `'${sn}'!${colLetter(K.statusCol)}${absRow}`, values: [['СПИСАНО']] });
          }
        }
      }

      const newStatus = norm(draftRow[C.newStatusCol - 1]);
      if (newStatus) {
        commentParts.push('СТАТУС=' + norm(oldRow[K.statusCol - 1]) + '→' + newStatus);
        batch.push({ range: `'${sn}'!${colLetter(K.statusCol)}${absRow}`, values: [[newStatus]] });
      }

      const newType = norm(draftRow[C.newTypeCol - 1]);
      if (newType) {
        commentParts.push('ТИП=' + norm(oldRow[K.typeCol - 1]) + '→' + newType);
        batch.push({ range: `'${sn}'!${colLetter(K.typeCol)}${absRow}`, values: [[newType]] });
      }

      const newTara = norm(draftRow[C.newTaraCol - 1]);
      if (newTara) {
        commentParts.push('ТАРА=' + norm(oldRow[K.taraCol - 1]) + '→' + newTara);
        batch.push({ range: `'${sn}'!${colLetter(K.taraCol)}${absRow}`, values: [[newTara]] });
      }

      const newAddress = norm(draftRow[C.newAddressCol - 1]);
      if (newAddress) {
        commentParts.push('АДР=' + norm(oldRow[K.addressCol - 1]) + '→' + newAddress);
        batch.push({ range: `'${sn}'!${colLetter(K.addressCol)}${absRow}`, values: [[newAddress]] });
      }

      const draftNote = norm(draftRow[C.noteCol - 1]);
      if (draftNote) commentParts.push('ПРИМ: ' + draftNote);

      const oldComment = norm(oldRow[K.commentCol - 1]);
      let newComment = 'ИНВ ' + requestId;
      if (commentParts.length > 0) newComment += ': ' + commentParts.join(', ');
      if (oldComment) newComment += ' | ' + oldComment;
      batch.push({ range: `'${sn}'!${colLetter(K.commentCol)}${absRow}`, values: [[newComment]] });

      updatedCount++;

    } else {
      // NEW BOX — append
      const nr = Array(K.rowWidth).fill('');
      const effTara = norm(draftRow[C.newTaraCol - 1]) || norm(draftRow[C.taraCol - 1]);
      const effStatus = norm(draftRow[C.newStatusCol - 1]) || norm(draftRow[C.statusCol - 1]);
      const effType = norm(draftRow[C.newTypeCol - 1]) || norm(draftRow[C.typeCol - 1]);
      const effAddr = norm(draftRow[C.newAddressCol - 1]) || norm(draftRow[C.addressCol - 1]);
      const effQtyRaw = draftRow[C.newQtyCol - 1];
      const effQty = (effQtyRaw !== '' && effQtyRaw != null) ? (Number(effQtyRaw) || 0) : (Number(draftRow[C.qtyCol - 1]) || 0);
      const barcode = norm(draftRow[C.barcodeCol - 1]);
      const noteForNew = norm(draftRow[C.noteCol - 1]);

      // A: пустой (заполняется формулой на листе)
      const today = new Date();
      nr[1] = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`; // B: date
      nr[K.taraCol - 1] = effTara;
      nr[K.boxCol - 1] = norm(draftRow[C.boxCol - 1]);
      nr[K.statusCol - 1] = effStatus;
      nr[K.requestCol - 1] = requestId;
      nr[K.typeCol - 1] = effType;
      nr[K.skuNameCol - 1] = norm(draftRow[C.skuCol - 1]);
      nr[K.qtyCol - 1] = effQty;
      nr[K.addressCol - 1] = effAddr;
      nr[K.commentCol - 1] = 'НОВЫЙ: ИНВ ' + requestId + (noteForNew ? '; ' + noteForNew : '');
      nr[K.clientCol - 1] = clientName;
      nr[K.barcodeCol - 1] = barcode;

      newRows.push(nr);
    }
  }

  // 7. Write batch updates (matched rows)
  if (batch.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: UPSELLER_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: batch }
    });
  }

  // 8. Append new rows
  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: UPSELLER_SPREADSHEET_ID,
      range: `'${K.sheetName}'!A${K.startRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newRows }
    });
  }

  return { updatedRows: updatedCount, newRows: newRows.length };
}


/**
 * Reset inventory: delete VCXXX sheet, delete ОТЧЕТЫ row, reset ЗАЯВКИ.
 */
async function resetInvent(reportId) {
  const sheets = await getSheets();

  // 1. Delete VCXXX sheet
  const shortMatch = reportId.match(/^([A-Z]{2}\d{3})/);
  const shortCode = shortMatch ? shortMatch[1] : '';
  if (shortCode) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties(title,sheetId)'
    });
    const chernSheet = meta.data.sheets.find(s => s.properties.title === shortCode);
    if (chernSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ deleteSheet: { sheetId: chernSheet.properties.sheetId } }] }
      });
    }
  }

  // 2. Find and delete ОТЧЕТЫ row
  const oRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.reportIdCol)}${OTCHETY.startRow}:${colLetter(OTCHETY.reportIdCol)}`
  });
  const oIds = (oRes.data.values || []).flat();
  let oRow = -1;
  for (let i = 0; i < oIds.length; i++) {
    if (String(oIds[i]).trim() === reportId) { oRow = OTCHETY.startRow + i; break; }
  }
  if (oRow > 0) {
    // Clear the row (can't delete via values API, so overwrite with empty)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${OTCHETY.sheetName}'!A${oRow}:${colLetter(OTCHETY.rowWidth)}${oRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [Array(OTCHETY.rowWidth).fill('')] }
    });
  }

  // 3. Reset ЗАЯВКИ
  const requestId = reportId.replace(/_\d{2}\.\d{2}\.\d{2}_\d{4}$/, '');
  if (requestId) {
    const zHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ZAYAVKI.sheetName}'!A3:AZ3`
    });
    const zHeaders = (zHeaderRes.data.values || [[]])[0];
    const zHeaderMap = {};
    zHeaders.forEach((h, i) => { if (h) zHeaderMap[String(h).trim()] = i + 1; });

    const zIdCol = zHeaderMap['ID_ЗАЯВКИ'] || ZAYAVKI.idCol;
    const zIdRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ZAYAVKI.sheetName}'!${colLetter(zIdCol)}${ZAYAVKI.startRow}:${colLetter(zIdCol)}`
    });
    const zIds = (zIdRes.data.values || []).flat();
    let zRow = -1;
    for (let i = 0; i < zIds.length; i++) {
      if (String(zIds[i]).trim() === requestId) { zRow = ZAYAVKI.startRow + i; break; }
    }

    if (zRow > 0) {
      const batch = [];
      const statusCol = zHeaderMap['СТАТУС'];
      if (statusCol) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(statusCol)}${zRow}`, values: [['СОЗДАНО']] });
      ['СТАРТ ИНВ', 'ЗАВ ИНВ', 'КОЛ СТР', 'ПРОВ СТР', 'ОСТ СТР', 'ИЗМ СТР',
        'КОР ДО', 'КОР ПОСЛ', 'РАСХ КОР', 'СКЮ ДО', 'СКЮ ПОСЛ', 'РАСХ СКЮ',
        'ЕД ДО', 'ЕД ПОСЛ', 'РАСХ ЕД', 'ИЗМ ПО БАР'].forEach(name => {
        const col = zHeaderMap[name];
        if (col) batch.push({ range: `'${ZAYAVKI.sheetName}'!${colLetter(col)}${zRow}`, values: [['']] });
      });
      if (batch.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: batch }
        });
      }
    }
  }

  return { ok: true, message: 'Инвент сброшен: ' + reportId };
}

/**
 * Get client name from reportId by looking up ОТЧЕТЫ → ID_ЗАЯВКИ → ЗАЯВКИ → КЛИЕНТ.
 */
async function getClientNameByReportId(reportId) {
  const sheets = await getSheets();

  // Find requestId in ОТЧЕТЫ
  const oRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${OTCHETY.sheetName}'!${colLetter(OTCHETY.reportIdCol)}${OTCHETY.startRow}:${colLetter(OTCHETY.requestIdCol)}`
  });
  const oRows = oRes.data.values || [];
  let requestId = '';
  for (const row of oRows) {
    const rid = norm(row[0]);
    if (rid === reportId || rid.startsWith(reportId)) { requestId = norm(row[1]); break; }
  }
  if (!requestId) return '';

  // Find client in ЗАЯВКИ
  const zRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ZAYAVKI.sheetName}'!A${ZAYAVKI.startRow}:B`
  });
  const zRows = zRes.data.values || [];
  for (const row of zRows) {
    if (norm(row[1]) === requestId) return norm(row[0]);
  }
  return '';
}

/**
 * Get all barcodes for a given client from 👗 ТОВАРЫ sheet in Upseller table.
 * Returns: [{ barcode, sku }]
 * READ-ONLY — never writes to the Upseller table.
 */
async function getClientBarcodes(clientName) {
  if (!clientName) return [];
  const sheets = await getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELLER_SPREADSHEET_ID,
    range: `'${TOVARY_SHEET}'!B${TOVARY_START_ROW}:D`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const allRows = res.data.values || [];
  const result = [];
  const seen = new Set();

  allRows.forEach(row => {
    const client = norm(row[0]);
    const sku = norm(row[1]);
    const barcode = norm(row[2]);
    if (client === clientName && barcode && !seen.has(barcode)) {
      seen.add(barcode);
      result.push({ barcode, sku });
    }
  });

  return result.sort((a, b) => a.barcode.localeCompare(b.barcode));
}

module.exports = {
  getInventWebListData,
  getBoxEditorPayload,
  getNewBoxEditorPayload,
  checkBoxNumberExists,
  getActiveSessions,
  getAvailableZayavki,
  getChernWebListData,
  startInventSession,
  updateChernRowBatch,
  appendChernRows,
  getPreviewBoxes,
  finalizeReport,
  syncToKoroby,
  resetInvent,
  getClientNameByReportId,
  getClientBarcodes,
  SPREADSHEET_ID,
  CFG
};

import { getSheets } from '../google.js';
import { FORM_OPTIONS } from './mock.js';

const DEFAULT_SPREADSHEET_ID = '1wlz94rEXUEwkRLshk3l6YWXqMBBTSuClTWRU-Zbuvx8';
const DEFAULT_SHEET_NAME = 'ПР';
function spreadsheetId() {
  return process.env.RECEIVING_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
}

function sheetName() {
  return process.env.RECEIVING_SHEET_NAME || DEFAULT_SHEET_NAME;
}

function q(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function cell(rowValues, oneBasedIndex) {
  return String((rowValues[oneBasedIndex - 1] || [])[0] || '').trim();
}

function parseSupplyLabel(value) {
  const raw = String(value || '').trim();
  const [code, ...rest] = raw.split(/\s*[-–—]\s*/);
  return {
    id: code || raw,
    code: code || raw,
    label: raw,
    client: rest.join(' - ') || '',
  };
}

function parseNumber(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptions(values) {
  return Array.from(new Set((values || []).flat().map((value) => String(value || '').trim()).filter(Boolean)));
}

function gridValidation(sheet, a1) {
  const data = sheet?.data || [];
  const rowData = data[0]?.rowData || [];
  const values = rowData[0]?.values || [];
  const cellData = values[0] || {};
  return cellData.dataValidation || null;
}

function conditionValues(validation) {
  return (validation?.condition?.values || [])
    .map((item) => String(item.userEnteredValue || '').trim())
    .filter(Boolean);
}

async function readRangeOptions(sheets, formula) {
  const range = String(formula || '').replace(/^=/, '').trim();
  if (!range || !range.includes('!')) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return normalizeOptions(res.data.values || []);
  } catch {
    return [];
  }
}

async function readValidationOptions(sheets, a1) {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId(),
      ranges: [`${q(sheetName())}!${a1}`],
      includeGridData: true,
    });
    const validation = gridValidation(meta.data.sheets?.[0], a1);
    const type = validation?.condition?.type || '';
    const values = conditionValues(validation);
    if (type === 'ONE_OF_LIST') return values;
    if (type === 'ONE_OF_RANGE') return readRangeOptions(sheets, values[0]);
  } catch {}
  return [];
}

async function readSupplyOptions(sheets) {
  const fromValidation = await readValidationOptions(sheets, 'C4');
  let values = fromValidation;
  if (!values.length) {
    try {
      const fallback = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId(),
        range: "'🔨'!A2:A",
        valueRenderOption: 'FORMATTED_VALUE',
      });
      values = normalizeOptions(fallback.data.values || []);
    } catch {
      values = [];
    }
  }
  return values.map((value) => {
    const parsed = parseSupplyLabel(value);
    return { ...parsed, status: '', skuCount: 0, unitsTotal: 0 };
  });
}

async function readCurrentSupplyLabel(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `${q(sheetName())}!C4`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return String(res.data.values?.[0]?.[0] || '').trim();
  } catch {
    return '';
  }
}

function parseItems(rows) {
  return (rows || [])
    .map((row, index) => {
      const sku = String(row[0] || '').trim();
      const barcode = String(row[1] || '').trim();
      const plan = parseNumber(row[9]);
      if (!sku || !barcode || !plan) return null;
      return {
        id: `sheet-${index + 3}`,
        sku,
        barcode,
        plan,
        dims: {
          w: parseNumber(row[3]),
          d: parseNumber(row[4]),
          h: parseNumber(row[5]),
        },
        weight: parseNumber(row[7]),
        shelfLife: String(row[10] || '').trim(),
      };
    })
    .filter((item) => item && item.barcode);
}

async function readCurrentItems(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${q(sheetName())}!D3:AQ`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return parseItems(res.data.values || []);
}

export async function listSheetSupplyOptions({ includeCounts = false } = {}) {
  const sheets = getSheets();
  const options = await readSupplyOptions(sheets);
  if (!includeCounts || !options.length) return options;

  const originalLabel = await readCurrentSupplyLabel(sheets);
  const enriched = [];
  for (const option of options) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId(),
        range: `${q(sheetName())}!C4`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[option.label]] },
      });
      await sleep(650);
      const items = await readCurrentItems(sheets);
      enriched.push({
        ...option,
        skuCount: items.length,
        unitsTotal: items.reduce((sum, item) => sum + item.plan, 0),
      });
    } catch {
      enriched.push(option);
    }
  }

  if (originalLabel) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId(),
        range: `${q(sheetName())}!C4`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[originalLabel]] },
      });
    } catch {}
  }
  return enriched;
}

export async function loadSheetBootstrap(supplyId = '') {
  const sheets = getSheets();
  const id = spreadsheetId();
  const name = sheetName();
  const supplyOptions = await readSupplyOptions(sheets);

  if (supplyId) {
    const selected = supplyOptions.find((option) => (
      option.label === supplyId || option.code === supplyId || option.id === supplyId
    ));
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${q(name)}!C4`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[selected?.label || supplyId]] },
    });
    await sleep(900);
  }

  const [headerRes, items, receivers, productTypes, tareOwners] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${q(name)}!C3:C14`, valueRenderOption: 'FORMATTED_VALUE' }),
    readCurrentItems(sheets),
    readValidationOptions(sheets, 'C8'),
    readValidationOptions(sheets, 'C9'),
    readValidationOptions(sheets, 'C11'),
  ]);

  const header = headerRes.data.values || [];
  const selectedSupply = parseSupplyLabel(cell(header, 2) || supplyId || supplyOptions[0]?.label || '');
  const enrichedSupplyOptions = supplyOptions.map((option) => (
    option.code === selectedSupply.code
      ? { ...option, skuCount: items.length, unitsTotal: items.reduce((sum, item) => sum + item.plan, 0) }
      : option
  ));

  const form = {
    date: cell(header, 1),
    receiver: cell(header, 6),
    operator: '',
    shift: '',
    productType: cell(header, 7),
    tareOwner: cell(header, 9),
    pallets: cell(header, 10),
    extraCharge: cell(header, 11),
    comment: cell(header, 12),
  };

  return {
    context: { source: 'google-sheets', spreadsheetId: id, sheetName: name },
    meta: { loadedAt: new Date().toISOString(), version: 'receiving-sheets-v1' },
    supply: {
      ...selectedSupply,
      date: form.date,
      status: 'В приемке',
      ...form,
    },
    form,
    formOptions: {
      ...FORM_OPTIONS,
      receivers: receivers.length ? receivers : FORM_OPTIONS.receivers,
      productTypes: productTypes.length ? productTypes : FORM_OPTIONS.productTypes,
      tareOwners: tareOwners.length ? tareOwners : FORM_OPTIONS.tareOwners,
    },
    items,
    clientCatalog: items.map(({ sku, barcode, dims, weight }) => ({ sku, barcode, dims, weight })),
    defaults: { boxDims: { w: 60, d: 40, h: 40 }, initialBoxCount: 9 },
    supplyOptions: enrichedSupplyOptions,
  };
}

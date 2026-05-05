import { getSheets, getSpreadsheetId, jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import {
  APP_VERSION,
  APP_RELEASE_NOTES,
  APP_CONFIG,
  FIELD_DEFINITIONS,
  formatDateMoscow,
} from './_lib/shipments.js';

const FALLBACK_STATUS = ['СОЗДАНО', 'СОБРАНО', 'ОТГРУЖ', 'ОТМЕНА'];
const FALLBACK_YES_NO = ['ДА', 'НЕТ'];
const VALIDATION_COLUMNS = ['BC', 'U', 'V', 'W'];

export default async function handler(request) {
  try {
    await requireUser(request);
    const sheets = getSheets();
    const spreadsheetId = getSpreadsheetId();

    const validations = await fetchValidationOptions(sheets, spreadsheetId, VALIDATION_COLUMNS);

    return jsonResponse({
      version: APP_VERSION,
      releaseNotes: APP_RELEASE_NOTES,
      defaultDate: formatDateMoscow(new Date()),
      fields: FIELD_DEFINITIONS,
      statusOptions: validations.BC.length ? validations.BC : FALLBACK_STATUS,
      qualityControlOptions: validations.U.length ? validations.U : FALLBACK_YES_NO,
      dataTransferredOptions: validations.V.length ? validations.V : FALLBACK_YES_NO,
      barcodeAppliedOptions: validations.W.length ? validations.W : FALLBACK_YES_NO,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

async function fetchValidationOptions(sheets, spreadsheetId, columns) {
  const startRow = APP_CONFIG.writeStartRow;
  const endRow = startRow + APP_CONFIG.validationSampleRows - 1;
  const ranges = columns.map(col => `'${APP_CONFIG.writeSheetName}'!${col}${startRow}:${col}${endRow}`);

  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges,
    includeGridData: true,
    fields: 'sheets(data(rowData(values(dataValidation))))',
  });

  const result = {};
  columns.forEach(col => { result[col] = []; });

  const sheetBlock = (res.data.sheets || [])[0];
  if (!sheetBlock || !Array.isArray(sheetBlock.data)) return result;

  sheetBlock.data.forEach((dataBlock, idx) => {
    const col = columns[idx];
    const rowData = dataBlock.rowData || [];
    for (const row of rowData) {
      const values = row.values || [];
      const cell = values[0];
      if (!cell || !cell.dataValidation) continue;
      const condition = cell.dataValidation.condition;
      if (condition && condition.type === 'ONE_OF_LIST') {
        result[col] = (condition.values || []).map(v => v.userEnteredValue).filter(Boolean);
        if (result[col].length) break;
      }
    }
  });

  return result;
}

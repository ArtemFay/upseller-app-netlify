import { getSheets, getSpreadsheetId, jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import {
  APP_CONFIG,
  FIELD_DEFINITIONS,
  columnLetterToNumber,
  cleanString,
  normalizeNumber,
  normalizeSheetDate,
  formatFieldDisplayValue,
  formatIsoDate,
  formatDateTimeMoscow,
  trimTrailingEmptyRows,
} from './_lib/shipments.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const sheets = getSheets();
    const spreadsheetId = getSpreadsheetId();

    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [APP_CONFIG.sourceHeaderRange, APP_CONFIG.sourceDataRange, APP_CONFIG.sourceWriteMapRange],
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });

    const valueRanges = res.data.valueRanges || [];
    const headers = (valueRanges[0]?.values || [[]])[0] || [];
    const rawRows = trimTrailingEmptyRows(valueRanges[1]?.values || [])
      .filter(row => cleanString(row[APP_CONFIG.shipmentKeyColumn - 1]) !== '');
    const writeMapRows = valueRanges[2]?.values || [];

    const writeRowByKey = {};
    for (const row of writeMapRows) {
      const rowNumber = normalizeNumber(row[0]);
      const key = cleanString(row[1]);
      if (key && !writeRowByKey[key]) {
        writeRowByKey[key] = rowNumber || 0;
      }
    }

    const rows = rawRows.map((rawRow, index) => {
      const shipmentKey = cleanString(rawRow[APP_CONFIG.shipmentKeyColumn - 1]);
      const shipDate = normalizeSheetDate(rawRow[APP_CONFIG.dateColumn - 1]);
      const record = {
        rowNumber: writeRowByKey[shipmentKey] || 0,
        sourceRowNumber: APP_CONFIG.sourceStartRow + index,
        shipDate,
        shipmentKey,
        status: cleanString(rawRow[APP_CONFIG.statusColumn - 1]),
        balanceNumeric: normalizeNumber(rawRow[columnLetterToNumber('H') - 1]),
        shipmentCostNumeric: normalizeNumber(rawRow[columnLetterToNumber('AR') - 1]),
      };

      for (const field of FIELD_DEFINITIONS) {
        const idx = columnLetterToNumber(field.sourceColumn) - 1;
        record[field.key] = formatFieldDisplayValue(field, rawRow[idx]);
      }

      return record;
    });

    const grouped = {};
    for (const row of rows) {
      if (!row.shipDate || !row.shipmentKey) continue;
      if (!grouped[row.shipDate]) grouped[row.shipDate] = [];
      grouped[row.shipDate].push(row);
    }

    const days = Object.keys(grouped).sort().map(isoDate => ({
      isoDate,
      displayDate: formatIsoDate(isoDate),
      title: formatIsoDate(isoDate),
      count: grouped[isoDate].length,
      rows: grouped[isoDate],
    }));

    return jsonResponse({
      headers,
      days,
      fetchedAt: formatDateTimeMoscow(new Date()),
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

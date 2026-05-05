import { getSheets, getSpreadsheetId, jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import {
  APP_CONFIG,
  FIELD_MAP,
  cleanString,
  normalizeNumber,
  formatDateTimeMoscow,
} from './_lib/shipments.js';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return errorResponse(new Error('Method not allowed'), 405);
  }

  try {
    await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const { rowNumber, changes, shipmentKey } = body || {};

    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) {
      throw new Error('Не переданы изменения для сохранения.');
    }

    const sheets = getSheets();
    const spreadsheetId = getSpreadsheetId();

    const actualRow = await resolveCurrentWriteRow(sheets, spreadsheetId, shipmentKey, rowNumber);
    if (!actualRow) {
      throw new Error('Не удалось определить актуальную строку для сохранения.');
    }

    const updates = Object.keys(changes).map(fieldKey => {
      const field = FIELD_MAP[fieldKey];
      if (!field || !field.editable) {
        throw new Error(`Поле ${fieldKey} не поддерживает запись.`);
      }
      const value = String(changes[fieldKey] == null ? '' : changes[fieldKey]).trim();
      return {
        range: `'${APP_CONFIG.writeSheetName}'!${field.sourceColumn}${actualRow}`,
        values: [[value]],
      };
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    });

    return jsonResponse({
      rowNumber: actualRow,
      updatedFields: Object.keys(changes),
      savedAt: formatDateTimeMoscow(new Date()),
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

async function resolveCurrentWriteRow(sheets, spreadsheetId, shipmentKey, fallbackRow) {
  const key = cleanString(shipmentKey);
  if (!key) return Number(fallbackRow) || 0;

  // 1) helper-диапазон ОТГ_FILT!BL2:BM — пара (writeRow, shipmentKey)
  try {
    const helperRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: APP_CONFIG.sourceWriteMapRange,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const helperRows = helperRes.data.values || [];
    for (const row of helperRows) {
      const rowNum = normalizeNumber(row[0]);
      const helperKey = cleanString(row[1]);
      if (!rowNum || !helperKey) continue;
      if (helperKey === key) return rowNum;
    }
  } catch (_) {
    /* идём дальше на fallback */
  }

  // 2) live-lookup по колонке L листа '🚚 ОТГ'
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: APP_CONFIG.writeLookupRange,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const liveRows = liveRes.data.values || [];
    for (let i = 0; i < liveRows.length; i += 1) {
      if (cleanString((liveRows[i] || [])[0]) === key) {
        return APP_CONFIG.writeStartRow + i;
      }
    }
  } catch (_) {
    /* идём на fallback */
  }

  return Number(fallbackRow) || 0;
}

// Запись начислений в лист `НАЧ` (тест-таблица или ПОДБОРЫ боевая).
//
// Вызывается при zayavka.finish mode='full'. Source — computed.nach из
// event-store на бэке. Лист — append-only.
//
// Структура `НАЧ` (15 заполняемых колонок A:O, остальные служебные):
//   A=ДАТА, B=КЛИЕНТ, C=ЗАЯВКА, D=СТАТЬЯ, E=НАЗНАЧЕНИЕ, F=КОРОБ,
//   G=SKU, H=КОЛ, I=ЦЕНА ЗА ЕД, J=БАРКОД, K=ПОПОЛНЕНИЕ, L=СПИСАНИЕ,
//   M=x (служебная), N=МП, O=x (служебная)
//
// Для подбора заполняем: A, B, C, D="ПОДБОР", G, H, I=10*КС, J, L=H*I, N=МП.
// E, F, K, M, O — пусто.

import { getSheets } from '../google.js';
import { getNachislenyaSpreadsheetId } from './spreadsheet-id.js';
import { readState } from './zayavka-store.js';
import { logEvent } from './sync-log.js';

function pad(n) { return String(n).padStart(2, '0'); }
function todayDDMMYY() {
  const d = new Date();
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

export async function writeNachToSheet(zayavkaId) {
  const state = await readState(zayavkaId);
  if (!state) {
    throw new Error(`writeNachToSheet: state-файл не найден для ${zayavkaId}`);
  }
  const nach = state.computed && state.computed.nach;
  const paidByBarcode = (nach && nach.paidByBarcode) || {};
  const barcodes = Object.keys(paidByBarcode);
  if (barcodes.length === 0) {
    logEvent('info', 'sheet', `НАЧ: ${zayavkaId} — нет paid-баркодов (всё бесплатно), пропускаем запись`, null);
    return { written: 0, skipped: true, reason: 'all_free' };
  }
  // ИДЕМПОТЕНТНОСТЬ: проверяем что строк с этим zayavkaId на листе НАЧ ещё
  // нет. Без этой проверки повторный finish (после ошибки в writeFinishSummary
  // или после рестарта) дублирует начисления — пользователь получает
  // двойную выплату. Лист НАЧ append-only, удалить дубль автоматически нельзя.
  const sheetsCli = getSheets();
  const spreadsheetId = getNachislenyaSpreadsheetId();
  const existing = await sheetsCli.spreadsheets.values.get({
    spreadsheetId,
    range: "'НАЧ'!C:C",
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = (existing.data.values || []).filter(r => String(r[0] || '').trim() === zayavkaId);
  if (existingRows.length > 0) {
    logEvent('warn', 'sheet', `НАЧ: ${zayavkaId} уже записан (${existingRows.length} строк) — пропускаем дубль`, null);
    return {
      written: 0,
      skipped: true,
      reason: 'already_written',
      existingRows: existingRows.length,
      totalCharge: nach.totalCharge,
      paidUnits: nach.totalPaidUnits,
    };
  }
  const date = todayDDMMYY();
  const client = state.meta.client || '';
  const mp = state.meta.mp || '';
  const price = (nach && nach.ratePerUnit) || 10;
  // SKU fallback: если в paidByBarcode пусто (события set_layout не несут sku),
  // достаём из request.items по баркоду.
  const skuFromRequest = {};
  for (const it of (state.request && state.request.items) || []) {
    if (it.barcode && it.sku) skuFromRequest[it.barcode] = it.sku;
  }
  const rows = [];
  for (const barcode of barcodes) {
    const info = paidByBarcode[barcode];
    const qty = Number(info.qty) || 0;
    const charge = Number(info.charge) || 0;
    const sku = info.sku || skuFromRequest[barcode] || '';
    rows.push([
      date, client, zayavkaId, 'ПОДБОР', '', '',
      sku, qty, price, barcode, '', charge, '', mp, '',
    ]);
  }
  await sheetsCli.spreadsheets.values.append({
    spreadsheetId,
    range: "'НАЧ'!A:O",
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  logEvent('info', 'sheet', `НАЧ: записано ${rows.length} строк (заявка ${zayavkaId}, итого ${nach.totalCharge}₽)`, {
    zayavkaId, written: rows.length, charge: nach.totalCharge, paidUnits: nach.totalPaidUnits,
  });
  return { written: rows.length, totalCharge: nach.totalCharge, paidUnits: nach.totalPaidUnits };
}

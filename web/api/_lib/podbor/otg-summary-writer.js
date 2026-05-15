// Запись сводной информации о заявке в лист `🚚 ОТГ` главной таблицы UPSELLER.
//
// Вызывается при zayavka.finish mode='full' параллельно с другими шагами
// (КОРОБЫ → СОБРАНО, НАЧ append, БД summary). Лист 🚚 ОТГ — производственный
// журнал отгрузок: сюда сборщики и логистика смотрят финальные цифры заявки.
//
// Колонки (заголовки в строке 4):
//   D = № (короткий, S1654)              — НЕ трогаем (создаётся при заведении заявки)
//   L = №M (полный, S1654-ВИДИНЕЕВА)     — primary key для поиска строки
//   O = СОБР. КОРОБЫ                      — список номеров через \n
//   P = КОЛ ШТ                            — фактически собрано (totalUnits)
//   Q = КОЛ КОР                           — всего коробов отгрузки
//   R = КОЛ СКЮ                           — собранных уникальных SKU
//   S = КОЛ КОР ФФ                        — коробов с owner='ФФ' (фулфилмент)
//   T = ЛОГ ЗАЯВКИ                        — picklog: barcode⁠ - ⁠need⁠ - ⁠picked
//   BC = СТАТУС                           — 'СОБРАНО' при finish (как в БД ПОДБОРЫ.U)
//
// Идемпотентность: одной batchUpdate перезаписываем O,P,Q,R,S,T,BC теми же
// значениями при повторном finish — safe, числа стабильны (computed.* derived
// из event-store), список коробов и picklog тоже воспроизводимы, статус const.

import { getSheets } from '../google.js';
import { getKorobySpreadsheetId } from './spreadsheet-id.js';
import { logEvent } from './sync-log.js';

const SHEET_NAME = '🚚 ОТГ';
// Колонка L = №M (полное имя заявки). На скриншоте видно что именно тут лежит
// "S1654-ВИДИНЕЕВА" — то же значение, которое у нас приходит как zayavkaNumber.
const KEY_COL = 'L';

export async function findRowOnOtg(zayavkaNumber) {
  const sheets = getSheets();
  const id = getKorobySpreadsheetId();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${SHEET_NAME}'!${KEY_COL}:${KEY_COL}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = r.data.values || [];
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || '').trim();
    if (v === zayavkaNumber) return i + 1;
  }
  return null;
}

export async function writeOtgSummary(zayavkaNumber, summary) {
  const row = await findRowOnOtg(zayavkaNumber);
  if (!row) {
    logEvent('warn', 'sheet', `ОТГ: заявка ${zayavkaNumber} не найдена в листе 🚚 ОТГ (колонка ${KEY_COL})`, null);
    return {
      ok: false,
      reason: 'not_found',
      error: `Заявка ${zayavkaNumber} не найдена в UPSELLER → 🚚 ОТГ. Возможно ещё не заведена менеджером.`,
    };
  }
  const sheets = getSheets();
  const id = getKorobySpreadsheetId();
  const fields = {
    O: summary.shipBoxNumbersStr,  // список номеров через \n
    P: summary.totalUnits,          // КОЛ ШТ — фактически собрано
    Q: summary.shipBoxCount,        // КОЛ КОР — всего коробов отгрузки
    R: summary.uniqueSku,           // КОЛ СКЮ — уникальных SKU собрано
    S: summary.ffBoxCount,          // КОЛ КОР ФФ — фулфилмент-коробов
    T: summary.picklog,             // ЛОГ ЗАЯВКИ — 3-колоночный текст
    BC: 'СОБРАНО',                  // СТАТУС — финальный статус заявки на ОТГ
  };
  const data = [];
  for (const [col, value] of Object.entries(fields)) {
    data.push({ range: `'${SHEET_NAME}'!${col}${row}`, values: [[value]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: id,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  logEvent('info', 'sheet', `ОТГ: ${zayavkaNumber} summary записан в O,P,Q,R,S,T,BC=СОБРАНО (row ${row})`, {
    row, totalUnits: summary.totalUnits, shipBoxCount: summary.shipBoxCount,
    uniqueSku: summary.uniqueSku, ffBoxCount: summary.ffBoxCount,
  });
  return { ok: true, row };
}

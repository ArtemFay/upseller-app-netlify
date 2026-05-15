// Сборка текста "ЛОГ ЗАЯВКИ" для записи в Sheets.
//
// Формат (принят системой, виден в реальных данных UPSELLER.ОТГ.T и ПОДБОРЫ.БД.O):
//   <barcode>⁠ - ⁠<need>⁠ - ⁠<picked>⁠
//   <barcode>⁠ - ⁠<need>⁠ - ⁠<picked>⁠
//   ...
//
// Где '⁠' = U+2060 (WORD JOINER) — невидимый символ, не даёт Sheets интерпретировать
// баркод как число / разорвать строку при wrap. Между значениями: ⁠ - ⁠ (WJ + space + dash + space + WJ).
//
// До 2026-05-15 в ПОДБОРЫ.БД.O писали 2 колонки (barcode + need, без picked).
// Теперь — 3 колонки, picked добавляется при finish, перезаписывая старое
// 2-колоночное значение.
//
// Источник:
//   need — из state.request.items[].qty (изначально заявленное)
//   picked — из state.computed.pickedByBarcode[barcode] (фактически собрано)

export const WORD_JOINER = '⁠';
const SEP = `${WORD_JOINER} - ${WORD_JOINER}`;

// Собирает 3-колоночный лог. Включает ВСЕ баркоды из request.items
// (включая picked=0) — соответствует формату на листе.
export function buildZayavkaLog(state) {
  const items = (state && state.request && state.request.items) || [];
  const picked = (state && state.computed && state.computed.pickedByBarcode) || {};
  const lines = [];
  for (const it of items) {
    const barcode = String(it.barcode || '').trim();
    if (!barcode) continue;
    const need = Number(it.qty) || 0;
    const got = Number(picked[barcode]) || 0;
    lines.push(`${barcode}${SEP}${need}${SEP}${got}${WORD_JOINER}`);
  }
  return lines.join('\n');
}

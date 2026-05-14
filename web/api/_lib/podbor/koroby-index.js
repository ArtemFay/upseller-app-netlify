// Snapshot и индексация листа "🍬 КОРОБЫ" для sync engine.
//
// Range: '🍬 КОРОБЫ'!A7:U — 21 колонка от A до U:
//   0=БАР_5  (служебная: последние 5 цифр баркода — для сортировки)
//   1=ДАТА_СОЗ (дата создания/изменения строки, DD.MM.YY)
//   2=ТАРА, 3=📦(КОРОБ), 4=СТАТУС, 5=ЗАЯВКА, 6=ТИП, 7=SKU, 8=КОЛ,
//   9=АДР, 10=КОЛ_СКЮ, 11=ГОДЕН, 12=СКЛАД_НАЗН, 13=СЛОТ, 14=ВЕС,
//   15=ПРОЦ_ЗАП, 16=V_Л, 17=КОММЕНТ, 18=МП, 19=КЛИЕНТ, 20=БАРКОД
//
// Колонки A (БАР_5) и B (ДАТА_СОЗ) обязательны при append'е — иначе формулы
// сортировки/индексации в листе ломаются и значения уезжают в неправильные
// клетки (баг 2026-05: К_1.0 уезжал в столбец A).

import { getSheets } from '../google.js';
import { getKorobySpreadsheetId } from './spreadsheet-id.js';

const RANGE_DATA = "'🍬 КОРОБЫ'!A7:U";
const FIRST_DATA_ROW = 7;

export const COL = Object.freeze({
  BAR5: 0, DATA_SOZ: 1, TARA: 2, KOROB: 3, STATUS: 4, ZAYAVKA: 5, TIP: 6, SKU: 7,
  QTY: 8, ADR: 9, KOL_SKU: 10, GODEN: 11, SKLAD_NAZN: 12, SLOT: 13, VES: 14,
  PROC_ZAP: 15, V_L: 16, COMMENT: 17, MP: 18, CLIENT: 19, BARCODE: 20,
  // Колонки за пределами read range A:U — только для записи (через colLetter):
  NO_OTG: 23, // X — № отгрузки
});

// A1-буква колонки sheet'а. Индекс 0 = 'A', 8 = 'I' (КОЛ), 20 = 'U' (БАРКОД).
export function colLetter(idx) {
  return String.fromCharCode('A'.charCodeAt(0) + idx);
}

function todayDDMMYY() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(-2)}`;
}

// Ключ строки в индексе. Используем (korob, barcode) — короб уникален в рамках
// всего листа, баркод в коробе встречается максимум один раз. Клиент в ключ
// не входим: в некоторых таблицах колонка КЛИЕНТ пустая (заполняется формулой
// или вообще не заполняется в тестовых копиях), тогда как ЗАЯВКА = `<пдб>-<клиент>`
// всегда есть. Поиск по korob/barcode — стабильный.
function keyOf(_client, korob, barcode) {
  return `${String(korob || '').trim()}|${String(barcode || '').trim()}`;
}

export class KorobyIndex {
  constructor() {
    this.rows = []; // raw rows из листа
    this.byKey = new Map(); // key → { row, qty, status, raw }
    this.byKorob = new Map(); // korob → [keys]
    this.lastReadAt = 0;
    this.spreadsheetId = null;
  }

  // Полный read листа. Это дорого (1-2 сек), вызываем по тику или forced flush.
  async refresh() {
    const id = getKorobySpreadsheetId();
    this.spreadsheetId = id;
    const sheets = getSheets();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: RANGE_DATA,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    this.rows = r.data.values || [];
    this._rebuildIndex();
    this.lastReadAt = Date.now();
    return this;
  }

  _rebuildIndex() {
    this.byKey.clear();
    this.byKorob.clear();
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const client = row[COL.CLIENT];
      const korob = row[COL.KOROB];
      const barcode = row[COL.BARCODE];
      if (!korob) continue;
      const k = keyOf(client, korob, barcode);
      const rowNumber = FIRST_DATA_ROW + i;
      const entry = {
        rowNumber,
        qty: Number(row[COL.QTY]) || 0,
        status: String(row[COL.STATUS] || '').trim(),
        tara: String(row[COL.TARA] || '').trim(),
        tip: String(row[COL.TIP] || '').trim(),
        sku: String(row[COL.SKU] || ''),
        adr: String(row[COL.ADR] || ''),
        mp: String(row[COL.MP] || ''),
        client: String(row[COL.CLIENT] || ''),
        korob: String(row[COL.KOROB] || ''),
        barcode: String(row[COL.BARCODE] || ''),
        zayavka: String(row[COL.ZAYAVKA] || ''),
        raw: row,
      };
      this.byKey.set(k, entry);
      const korobKey = String(korob);
      if (!this.byKorob.has(korobKey)) this.byKorob.set(korobKey, []);
      this.byKorob.get(korobKey).push(k);
    }
  }

  // Поиск строки по ключу — возвращает entry или null.
  find(client, korob, barcode) {
    return this.byKey.get(keyOf(client, korob, barcode)) || null;
  }

  // Все строки для одного короба (нужно для расчёта VSEGO_V_KOR и пр.).
  byKorobName(korob) {
    const keys = this.byKorob.get(String(korob)) || [];
    return keys.map(k => this.byKey.get(k)).filter(Boolean);
  }

  // Следующий свободный rowNumber для append (для предсказуемости логики;
  // фактический append через values.append API сам выберет позицию).
  nextRowNumber() {
    return FIRST_DATA_ROW + this.rows.length;
  }
}

// Построение values-массива (21 ячейка, A:U) для append новой строки.
// Колонка A (БАР_5) — служебная формула, не трогаем.
// Колонка X (NO_OTG) — за пределами range A:U, пишется отдельным update'ом.
export function buildShipBoxRow({
  taraType, korobNumber, status, zayavkaId, tipTovara, sku, qty,
  mp, client, barcode,
  sklad,    // M (СКЛАД НАЗН) — "склад ▹ финальный_склад"
  dateOtgr, // N (СЛОТ — пишем дату отгрузки в формате DD.MM.YY)
  comment,  // R (КОММЕНТ) — multiline: "Ш×В×Г\nКЛ|ФФ"
}) {
  const row = new Array(21).fill('');
  row[COL.DATA_SOZ] = todayDDMMYY();
  row[COL.TARA] = taraType || 'К_1.0';
  row[COL.KOROB] = korobNumber;
  row[COL.STATUS] = status || 'В СБОРКЕ';
  row[COL.ZAYAVKA] = zayavkaId || '';
  row[COL.TIP] = tipTovara || 'УТ ГОТОВ';
  row[COL.SKU] = sku || '';
  row[COL.QTY] = Number(qty) || 0;
  row[COL.SKLAD_NAZN] = sklad || '';
  row[COL.SLOT] = dateOtgr || '';
  row[COL.COMMENT] = comment || '';
  row[COL.MP] = mp || '';
  row[COL.CLIENT] = client || '';
  row[COL.BARCODE] = String(barcode || '');
  return row;
}

// Helper: формирование строки для М (склад) и R (комментарий).
export function buildSkladString(warehouse, finalWarehouse) {
  return [warehouse, finalWarehouse].filter(s => s && String(s).trim()).map(s => String(s).trim()).join(' ▹ ');
}

export function buildOwnerComment(dimensions, owner, existing) {
  const lines = [];
  if (dimensions && dimensions.w && dimensions.h && dimensions.d) {
    lines.push(`${dimensions.w}×${dimensions.h}×${dimensions.d}`);
  }
  if (owner) lines.push(String(owner).trim());
  // Если существует существующий R — добавляем новый owner если его нет.
  if (existing) {
    const existingLines = String(existing).split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of existingLines) {
      if (!lines.includes(line)) lines.unshift(line); // существующие сверху
    }
  }
  return lines.join('\n');
}

export const RANGES = Object.freeze({
  DATA: RANGE_DATA,
  SHEET: '🍬 КОРОБЫ',
  FIRST_DATA_ROW,
});

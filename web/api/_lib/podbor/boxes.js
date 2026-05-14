// _lib/podbor/boxes.js
// Загрузка коробов клиента + расчёт availability per barcode.
// Логика портирована из WEB_PODBOR/app/lib/podbory-load.js (CommonJS → ESM).
// Контракт документирован в 1_CONST/03_CURRENT_GAS_SYSTEM.md § 2 / § 3.

import { getSheets } from '../google.js';
import { getKorobySpreadsheetId } from './spreadsheet-id.js';
import { readState } from './zayavka-store.js';

// Индексы в исходной строке `🍬 КОРОБЫ!C7:U` (от C, 0-indexed).
const SRC_IDX = {
  TARA: 0, KOROB_NUM: 1, STATUS: 2, ZAYAVKA: 3, TIP: 4, SKU: 5,
  QTY: 6, ADR: 7, MP: 16, CLIENT: 17, BARCODE: 18,
};

// Статусы коробов, которые НЕ показываем в полотне:
// - ИЗЪЯТО — короб опустошён, в нём ничего нет.
// - В СБОРКЕ — короб уже взят/собран в рамках текущего подбора (показываем
//   как progress отдельно, не в списке доступных к подбору).
const HIDDEN_STATUSES = new Set(['ИЗЪЯТО', 'В СБОРКЕ', 'СОБРАНО', 'ОТГРУЖЕНО']);

const DEST_IDX = {
  TIP: 0, SKU: 1, MP: 2, CLIENT: 3,
  VSEGO_V_KOR: 4, SPIS_YACH: 5, TARA: 6, STATUS: 7,
  KOROB: 8, KOL_SKU: 9, BARCODE: 10, BAR5: 11,
  ADR: 12, NEW_ADR: 13, QTY: 14, NEW_QTY: 15,
};

const MAPPING_RULES = [
  SRC_IDX.TIP, SRC_IDX.SKU, SRC_IDX.MP, SRC_IDX.CLIENT,
  null, null, SRC_IDX.TARA, SRC_IDX.STATUS,
  SRC_IDX.KOROB_NUM, null, SRC_IDX.BARCODE, 'BAR5',
  SRC_IDX.ADR, null, SRC_IDX.QTY, null,
];

const STATUS_RANK = {
  'ХРАНЕНИЕ': 1, 'ГОТОВО': 1,
  'СОБРАНО': 2, 'В РЕЗЕРВЕ': 2,
  'В ПРИЕМКЕ': 3, 'В УПАКОВКЕ': 3,
  'БРАК': 4, 'ОТГРУЖЕНО': 5,
  'СПИСАНО': 6, 'ИЗЪЯТО': 6, 'ОБЕЗЛИЧКА': 6,
};

export const PALETTE = [
  '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3',
  '#d0e0e3', '#cfe2f3', '#d9d2e9',
];

const VAL_YACH = 'ЯЧ';
const VAL_BRAK = 'БРАК';
const PICKABLE_STATUSES = new Set(['ГОТОВО', 'ХРАНЕНИЕ']);

function _calculateAvailability(sourceData, client) {
  const target = String(client).trim().toLowerCase();
  const avail = {};
  for (const row of sourceData) {
    const c = String(row[SRC_IDX.CLIENT] || '').trim().toLowerCase();
    if (c !== target) continue;
    const status = String(row[SRC_IDX.STATUS] || '').trim().toUpperCase();
    if (!PICKABLE_STATUSES.has(status)) continue;
    const tip = String(row[SRC_IDX.TIP] || '').trim().toUpperCase();
    if (tip === VAL_BRAK) continue;
    const qty = Number(row[SRC_IDX.QTY]) || 0;
    if (qty <= 0) continue;
    const bar = String(row[SRC_IDX.BARCODE] || '').trim();
    if (!bar) continue;
    avail[bar] = (avail[bar] || 0) + qty;
  }
  return avail;
}

// КОЛ_СКЮ = количество УНИКАЛЬНЫХ БАРКОДОВ в коробе (qty>0).
// Раньше считалось по SKU (артикул) — давало 1 для разных размеров одного
// артикула, что не совпадает с реальностью (баркод у каждого размера свой).
// Также игнорируем строки с qty=0 — короб мог иметь занулённую строку
// после изъятий, она не должна добавлять "+1 баркод" к статистике.
function _calculateBoxStats(rows) {
  const stats = {};
  for (const row of rows) {
    const box = String(row[SRC_IDX.KOROB_NUM] || '');
    const qty = Number(row[SRC_IDX.QTY]) || 0;
    if (qty <= 0) continue;
    const barcode = row[SRC_IDX.BARCODE];
    if (!stats[box]) stats[box] = { totalQty: 0, barcodes: new Set() };
    stats[box].totalQty += qty;
    if (barcode) stats[box].barcodes.add(String(barcode));
  }
  // Возвращаем shape совместимый с _mapRow — используем `.skus` имя для
  // обратной совместимости (set теперь с баркодами).
  for (const k of Object.keys(stats)) stats[k].skus = stats[k].barcodes;
  return stats;
}

function _mapRow(srcRow, boxStats) {
  const box = String(srcRow[SRC_IDX.KOROB_NUM] || '');
  const stat = boxStats[box] || { totalQty: 0, skus: new Set() };
  return MAPPING_RULES.map((rule, i) => {
    if (i === DEST_IDX.VSEGO_V_KOR) return stat.totalQty;
    if (i === DEST_IDX.SPIS_YACH) return '';
    if (i === DEST_IDX.KOL_SKU) return stat.skus.size;
    if (typeof rule === 'number') return srcRow[rule] !== undefined ? srcRow[rule] : '';
    if (rule === 'BAR5') {
      const b = String(srcRow[SRC_IDX.BARCODE] || '');
      return b.length > 5 ? b.slice(-5) : b;
    }
    return '';
  });
}

function _fillCellLists(rows) {
  const barToCells = {};
  for (const row of rows) {
    const tara = String(row[DEST_IDX.TARA] || '').trim().toUpperCase();
    const bar = String(row[DEST_IDX.BARCODE] || '').trim();
    const box = String(row[DEST_IDX.KOROB] || '').trim();
    if (tara === VAL_YACH && bar && box) {
      if (!barToCells[bar]) barToCells[bar] = [];
      if (!barToCells[bar].includes(box)) barToCells[bar].push(box);
    }
  }
  return rows.map(row => {
    const newRow = [...row];
    const tara = String(newRow[DEST_IDX.TARA] || '').trim().toUpperCase();
    const bar = String(newRow[DEST_IDX.BARCODE] || '').trim();
    const box = String(newRow[DEST_IDX.KOROB] || '').trim();
    if (barToCells[bar]) {
      let list = [...barToCells[bar]];
      if (tara === VAL_YACH) list = list.filter(k => k !== box);
      newRow[DEST_IDX.SPIS_YACH] = list.sort().join('\n');
    }
    return newRow;
  });
}

function _safeCompareBoxes(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function _rowToObject(row) {
  // ВАЖНО: barcode и korob приводим к String. Sheets возвращает большие
  // числовые штрихкоды как Number (UNFORMATTED_VALUE), а frontend использует
  // их как ключи (data-bar dataset, sравнения в onStepClick). Если row.barcode
  // окажется number, а dataset.bar — string, `===` даст false → +/- кнопки
  // не работают (max=0 → newVal=0). Принудительная string-нормализация.
  return {
    tip: String(row[DEST_IDX.TIP] || ''),
    sku: String(row[DEST_IDX.SKU] || ''),
    mp: String(row[DEST_IDX.MP] || ''),
    client: String(row[DEST_IDX.CLIENT] || ''),
    vsegoVKor: Number(row[DEST_IDX.VSEGO_V_KOR]) || 0,
    spisYach: String(row[DEST_IDX.SPIS_YACH] || ''),
    tara: String(row[DEST_IDX.TARA] || ''),
    status: String(row[DEST_IDX.STATUS] || ''),
    korob: String(row[DEST_IDX.KOROB] || ''),
    kolSku: Number(row[DEST_IDX.KOL_SKU]) || 0,
    barcode: String(row[DEST_IDX.BARCODE] || ''),
    bar5: String(row[DEST_IDX.BAR5] || ''),
    adr: String(row[DEST_IDX.ADR] || ''),
    qty: Number(row[DEST_IDX.QTY]) || 0,
  };
}

async function readUpsellerKoroby() {
  const upsellerId = getKorobySpreadsheetId();
  const sheets = getSheets();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: upsellerId,
    range: "'🍬 КОРОБЫ'!C7:U",
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return r.data.values || [];
}

export async function loadClientBoxes(clientName, zayavkaNumber) {
  const sourceData = await readUpsellerKoroby();
  const emptyMeta = { boxes: 0, uniqueSku: 0, totalQty: 0, lines: 0 };

  if (!sourceData.length) {
    return { client: clientName, groups: [], meta: emptyMeta, availability: {}, pickedByBarcode: {} };
  }

  const availability = _calculateAvailability(sourceData, clientName);
  const target = String(clientName).trim().toLowerCase();

  // Прогресс по заявке: source of truth — event-store (data/podbor/zayavki/
  // <id>.json). На лист "В СБОРКЕ" мы пишем для совместимости, но
  // pickedByBarcode берём из computed JSON. Если state-файл ещё не создан
  // (заявка не начата) — fallback на лист (исторические данные).
  // ShipRows (содержимое коробов отгрузки для миксования) — пока с листа,
  // так как в нём актуальные qty после flush sync engine.
  let pickedByBarcode = {};
  if (zayavkaNumber) {
    const eventState = await readState(zayavkaNumber);
    if (eventState && eventState.computed && eventState.computed.pickedByBarcode) {
      pickedByBarcode = { ...eventState.computed.pickedByBarcode };
    }
  }
  const shipRows = {}; // korobNumber → [ {barcode, qty, sku, ...} ]
  if (zayavkaNumber) {
    const targetZay = String(zayavkaNumber).trim();
    for (const row of sourceData) {
      const status = String(row[SRC_IDX.STATUS] || '').trim().toUpperCase();
      if (status !== 'В СБОРКЕ') continue;
      const zay = String(row[SRC_IDX.ZAYAVKA] || '').trim();
      if (zay !== targetZay) continue;
      const bar = String(row[SRC_IDX.BARCODE] || '').trim();
      const qty = Number(row[SRC_IDX.QTY]) || 0;
      if (qty <= 0) continue;
      // Fallback: если event-store пуст по этому баркоду (например, заявка
      // была начата в legacy-системе до перехода на JSON) — добавим в picked.
      if (bar && !pickedByBarcode[bar]) pickedByBarcode[bar] = (pickedByBarcode[bar] || 0) + qty;
      const box = String(row[SRC_IDX.KOROB_NUM] || '').trim();
      if (!box) continue;
      if (!shipRows[box]) shipRows[box] = [];
      shipRows[box].push({
        tip: String(row[SRC_IDX.TIP] || ''),
        sku: String(row[SRC_IDX.SKU] || ''),
        mp: String(row[SRC_IDX.MP] || ''),
        client: String(row[SRC_IDX.CLIENT] || ''),
        vsegoVKor: 0, spisYach: '',
        tara: String(row[SRC_IDX.TARA] || ''),
        status,
        korob: box, // уже string
        kolSku: 0,
        barcode: bar, // уже string
        bar5: bar.length > 5 ? bar.slice(-5) : bar,
        adr: String(row[SRC_IDX.ADR] || ''),
        qty,
      });
    }
    // Заполняем vsegoVKor / kolSku для каждой строки внутри ship-box.
    for (const box of Object.keys(shipRows)) {
      const rows = shipRows[box];
      const totalQty = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
      const uniqueBarcodes = new Set(rows.map(r => r.barcode).filter(Boolean));
      for (const r of rows) {
        r.vsegoVKor = totalQty;
        r.kolSku = uniqueBarcodes.size;
      }
    }
  }

  // SKU-нормализация: один баркод = один SKU. На листе для одного баркода
  // могут быть разные SKU (история переименований). Берём ПЕРВОЕ непустое
  // значение per баркод и применяем его ко ВСЕМ строкам этого баркода
  // (полотно, ship-rows, начисления). Долгосрочно SKU будет подтягиваться
  // из справочника номенклатуры по баркоду.
  const skuByBarcode = {};
  for (const row of sourceData) {
    const bar = String(row[SRC_IDX.BARCODE] || '').trim();
    const sku = String(row[SRC_IDX.SKU] || '').trim();
    if (bar && sku && !skuByBarcode[bar]) skuByBarcode[bar] = sku;
  }
  // Применяем normalized SKU к shipRows.
  for (const rows of Object.values(shipRows)) {
    for (const r of rows) {
      if (r.barcode && skuByBarcode[r.barcode]) r.sku = skuByBarcode[r.barcode];
    }
  }

  const clientData = sourceData.filter(row => {
    const c = String(row[SRC_IDX.CLIENT] || '').trim().toLowerCase();
    const q = Number(row[SRC_IDX.QTY]) || 0;
    if (c !== target || q <= 0) return false;
    // Не показываем уже собранные / изъятые / отгруженные — это завершённые
    // строки. Они есть в snapshot, но не относятся к текущей работе.
    const status = String(row[SRC_IDX.STATUS] || '').trim().toUpperCase();
    if (HIDDEN_STATUSES.has(status)) return false;
    return true;
  });

  if (!clientData.length) return { client: clientName, groups: [], meta: emptyMeta, availability, pickedByBarcode, shipRows };

  const boxStats = _calculateBoxStats(clientData);
  let mapped = clientData.map(r => _mapRow(r, boxStats));
  mapped = _fillCellLists(mapped);

  mapped.sort((a, b) => {
    const barA = String(a[DEST_IDX.BAR5] || '');
    const barB = String(b[DEST_IDX.BAR5] || '');
    if (barA < barB) return -1;
    if (barA > barB) return 1;

    const statA = String(a[DEST_IDX.STATUS] || '').trim().toUpperCase();
    const statB = String(b[DEST_IDX.STATUS] || '').trim().toUpperCase();
    const rankA = STATUS_RANK[statA] || 99;
    const rankB = STATUS_RANK[statB] || 99;
    if (rankA !== rankB) return rankA - rankB;

    if (statA === 'ГОТОВО' || statA === 'ХРАНЕНИЕ') {
      const isCellA = String(a[DEST_IDX.TARA] || '').toUpperCase() === VAL_YACH;
      const isCellB = String(b[DEST_IDX.TARA] || '').toUpperCase() === VAL_YACH;
      if (isCellA !== isCellB) return isCellA ? -1 : 1;
      const qA = Number(a[DEST_IDX.QTY]) || 0;
      const qB = Number(b[DEST_IDX.QTY]) || 0;
      if (qA !== qB) return qA - qB;
    }
    return _safeCompareBoxes(a[DEST_IDX.KOROB], b[DEST_IDX.KOROB]);
  });

  const groups = [];
  let colorIdx = 0;
  let prevBar = null;
  let current = null;
  for (const row of mapped) {
    const bar = String(row[DEST_IDX.BAR5] || '');
    if (bar !== prevBar) {
      if (prevBar !== null) colorIdx = (colorIdx + 1) % PALETTE.length;
      current = { bar5: bar, color: PALETTE[colorIdx], rows: [] };
      groups.push(current);
      prevBar = bar;
    }
    const rowObj = _rowToObject(row);
    // Normalize SKU: один баркод = один SKU (см. выше).
    if (rowObj.barcode && skuByBarcode[rowObj.barcode]) rowObj.sku = skuByBarcode[rowObj.barcode];
    current.rows.push(rowObj);
  }

  const uniqueBoxes = new Set();
  const uniqueSkus = new Set();
  let totalQty = 0;
  for (const row of mapped) {
    uniqueBoxes.add(String(row[DEST_IDX.KOROB]));
    if (row[DEST_IDX.SKU]) uniqueSkus.add(row[DEST_IDX.SKU]);
    totalQty += Number(row[DEST_IDX.QTY]) || 0;
  }

  return {
    client: clientName,
    groups,
    availability,
    pickedByBarcode,
    shipRows,
    skuByBarcode, // нормализованный (первое непустое) SKU per баркод
    meta: {
      boxes: uniqueBoxes.size,
      uniqueSku: uniqueSkus.size,
      totalQty,
      lines: mapped.length,
    },
  };
}

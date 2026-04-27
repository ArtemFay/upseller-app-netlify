const { readRange } = require('./sheets');

const SRC_IDX = {
  TARA: 0, KOROB_NUM: 1, STATUS: 2, TIP: 4, SKU: 5,
  QTY: 6, ADR: 7, MP: 16, CLIENT: 17, BARCODE: 18
};

const DEST_IDX = {
  TIP: 0, SKU: 1, MP: 2, CLIENT: 3,
  VSEGO_V_KOR: 4, SPIS_YACH: 5, TARA: 6, STATUS: 7,
  KOROB: 8, KOL_SKU: 9, BARCODE: 10, BAR5: 11,
  ADR: 12, NEW_ADR: 13, QTY: 14, NEW_QTY: 15
};

const MAPPING_RULES = [
  SRC_IDX.TIP, SRC_IDX.SKU, SRC_IDX.MP, SRC_IDX.CLIENT,
  null, null, SRC_IDX.TARA, SRC_IDX.STATUS,
  SRC_IDX.KOROB_NUM, null, SRC_IDX.BARCODE, 'BAR5',
  SRC_IDX.ADR, null, SRC_IDX.QTY, null
];

const STATUS_RANK = {
  'ХРАНЕНИЕ': 1, 'ГОТОВО': 1,
  'СОБРАНО': 2, 'В РЕЗЕРВЕ': 2,
  'В ПРИЕМКЕ': 3, 'В УПАКОВКЕ': 3,
  'БРАК': 4, 'ОТГРУЖЕНО': 5,
  'СПИСАНО': 6, 'ИЗЪЯТО': 6, 'ОБЕЗЛИЧКА': 6
};

const PALETTE = [
  '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3',
  '#d0e0e3', '#cfe2f3', '#d9d2e9'
];

const VAL_YACH = 'ЯЧ';
const VAL_BRAK = 'БРАК';
// Statuses that count as "available for picking" — see CONST/03 § 3.
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

function _calculateBoxStats(rows) {
  const stats = {};
  for (const row of rows) {
    const box = String(row[SRC_IDX.KOROB_NUM] || '');
    const qty = Number(row[SRC_IDX.QTY]) || 0;
    const sku = row[SRC_IDX.SKU];
    if (!stats[box]) stats[box] = { totalQty: 0, skus: new Set() };
    stats[box].totalQty += qty;
    if (sku) stats[box].skus.add(sku);
  }
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
  return {
    tip: row[DEST_IDX.TIP] || '',
    sku: row[DEST_IDX.SKU] || '',
    mp: row[DEST_IDX.MP] || '',
    client: row[DEST_IDX.CLIENT] || '',
    vsegoVKor: row[DEST_IDX.VSEGO_V_KOR] || 0,
    spisYach: row[DEST_IDX.SPIS_YACH] || '',
    tara: row[DEST_IDX.TARA] || '',
    status: row[DEST_IDX.STATUS] || '',
    korob: row[DEST_IDX.KOROB] || '',
    kolSku: row[DEST_IDX.KOL_SKU] || 0,
    barcode: row[DEST_IDX.BARCODE] || '',
    bar5: row[DEST_IDX.BAR5] || '',
    adr: row[DEST_IDX.ADR] || '',
    qty: Number(row[DEST_IDX.QTY]) || 0
  };
}

async function loadClientBoxes(clientName) {
  const upsellerId = process.env.UPSELLER_ID;
  const sourceData = await readRange(upsellerId, "'🍬 КОРОБЫ'!C7:U");
  const emptyMeta = { boxes: 0, uniqueSku: 0, totalQty: 0, lines: 0 };

  if (!sourceData.length) return { client: clientName, groups: [], meta: emptyMeta, availability: {} };

  const availability = _calculateAvailability(sourceData, clientName);
  const target = String(clientName).trim().toLowerCase();
  const clientData = sourceData.filter(row => {
    const c = String(row[SRC_IDX.CLIENT] || '').trim().toLowerCase();
    const q = Number(row[SRC_IDX.QTY]) || 0;
    return c === target && q > 0;
  });

  if (!clientData.length) return { client: clientName, groups: [], meta: emptyMeta, availability };

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
    current.rows.push(_rowToObject(row));
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
    meta: {
      boxes: uniqueBoxes.size,
      uniqueSku: uniqueSkus.size,
      totalQty,
      lines: mapped.length
    }
  };
}

module.exports = { loadClientBoxes, PALETTE };

const { readRange } = require('./sheets');

// Parse 'ЛОГ ЗАЯВКИ' (J column of БД_ЭКСП).
// Format: "<barcode>⁠ - ⁠<qty>⁠\n<barcode>⁠ - ⁠<qty>⁠\n..."
// Robust to invisible separators (U+2060 WORD JOINER) — extract two numeric tokens per line.
function parseLogZayavki(j) {
  return String(j || '')
    .split('\n')
    .map(line => line.match(/\d+/g))
    .filter(m => m && m.length >= 2)
    .map(([barcode, qty]) => ({ barcode: String(barcode), qty: Number(qty) }));
}

// КС (column B) is RU-locale decimal: '1', '0,6', '2'. Default 1.
function parseKs(b) {
  if (b === '' || b == null) return 1;
  const n = Number(String(b).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Build the unified key (label format from CONTEXT.md § 3.3): C_client5_E_F2_H5
function buildUnifiedKey({ number, client, dateOtgr, mp, finalWarehouse }) {
  const c5 = String(client).replace(/[\s.]+/g, '').slice(0, 5);
  const f2 = String(mp || '').toUpperCase() === 'НЕТ' ? 'НЕ' : String(mp || '').slice(0, 2);
  const h5 = String(finalWarehouse || '').slice(0, 5);
  return `${number}_${c5}_${dateOtgr}_${f2}_${h5}`;
}

async function loadActiveZayavki() {
  const id = process.env.PODBORY_ID;
  const rows = await readRange(id, "'БД_ЭКСП'!A2:P1000", { formatted: true });
  return rows
    .filter(r => r[0] && r[2])
    .map(r => {
      const z = {
        client: String(r[0] || '').trim(),
        ks: parseKs(r[1]),
        number: String(r[2] || '').trim(),
        dateZay: String(r[3] || ''),
        dateOtgr: String(r[4] || ''),
        mp: String(r[5] || '').trim(),
        warehouse: String(r[6] || '').trim(),
        finalWarehouse: String(r[7] || '').trim(),
        comment: String(r[8] || ''),
        items: parseLogZayavki(r[9]),
        skuCount: Number(r[12]) || 0,
        unitsTotal: Number(r[13]) || 0,
        status: String(r[14] || 'СОЗДАНО').trim() || 'СОЗДАНО',
        // P (СПИС БАР) is not lock info today — lock columns are TBD on the sheet.
        // Once added, populate lockedBy / lockedAt here.
        lockedBy: undefined,
        lockedAt: undefined
      };
      z.unifiedKey = buildUnifiedKey(z);
      return z;
    });
}

function getUniqueClients(zayavki) {
  const counts = new Map();
  for (const z of zayavki) counts.set(z.client, (counts.get(z.client) || 0) + 1);
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getZayavkiByClient(zayavki, client) {
  const target = String(client).trim().toLowerCase();
  return zayavki.filter(z => z.client.toLowerCase() === target);
}

module.exports = { loadActiveZayavki, getUniqueClients, getZayavkiByClient, parseLogZayavki };

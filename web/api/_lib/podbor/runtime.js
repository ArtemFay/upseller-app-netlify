import QRCode from 'qrcode';

const boxLayoutStore = new Map();
const shipBoxStore = new Map();
const inventoryAuditLog = [];
const inventoryOverrides = new Map();
const shipBoxQRCache = new Map();

function shipPrefix(zayavkaId) {
  const m = String(zayavkaId || '').match(/^([SR]\d+)/);
  return m ? m[1] : String(zayavkaId || '').slice(0, 5);
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function inventoryKey(boxId, barcode) {
  return `${boxId}|${barcode}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

export function applyInventoryOverrides(data) {
  if (!data?.groups || inventoryOverrides.size === 0) return data;
  for (const group of data.groups) {
    for (const row of group.rows || []) {
      const key = inventoryKey(row.korob, row.barcode);
      if (inventoryOverrides.has(key)) {
        row.qty = inventoryOverrides.get(key);
        row._inventoryCorrected = true;
      }
    }
  }
  return data;
}

export function getShipBoxes(zayavkaId) {
  const entry = shipBoxStore.get(zayavkaId) || { boxes: [], nextSeq: 1 };
  return { zayavkaId, boxes: entry.boxes };
}

export function getBoxLayouts() {
  const layouts = {};
  for (const [boxId, value] of boxLayoutStore.entries()) {
    layouts[boxId] = value;
  }
  return layouts;
}

async function generateQRForBox(box) {
  const dataUrl = await QRCode.toDataURL(box.number, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });
  shipBoxQRCache.set(box.number, dataUrl);
  return dataUrl;
}

function generateQRsInBackground(boxes) {
  setImmediate(async () => {
    for (const box of boxes) {
      try {
        await generateQRForBox(box);
      } catch (error) {
        console.error('[podbor:qr]', box.number, error.message);
      }
    }
  });
}

export async function getShipBoxQrPng(number) {
  let dataUrl = shipBoxQRCache.get(number);
  if (!dataUrl) {
    dataUrl = await generateQRForBox({ number });
  }
  const match = dataUrl.match(/^data:image\/png;base64,(.*)$/);
  if (!match) throw new Error('bad QR data');
  return Buffer.from(match[1], 'base64');
}

export async function renderShipLabelsHtml({ boxes, client, dateOtgr, mp, zayavkaId }) {
  for (const box of boxes) {
    if (!shipBoxQRCache.has(box.number)) await generateQRForBox(box);
  }
  const labels = boxes.map(box => {
    const qrData = shipBoxQRCache.get(box.number) || '';
    return `
      <div class="label">
        <div class="left">
          ${qrData ? `<img class="qr" src="${qrData}" alt="${escapeHtml(box.number)}">` : '<div class="qr-placeholder">QR...</div>'}
        </div>
        <div class="right">
          <div class="big-num">N ${escapeHtml(box.short)}</div>
          <div class="full-num">${escapeHtml(box.number)}</div>
          <div class="meta">
            <div class="client">${escapeHtml(client)}</div>
            <div class="date-mp">${escapeHtml(dateOtgr)} · ${escapeHtml(mp)}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Этикетки коробов · ${escapeHtml(zayavkaId)}</title>
<style>
  @page { size: 58mm 40mm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: Arial, sans-serif; }
  body { background: #ddd; padding: 12px; }
  .toolbar { position: fixed; top: 8px; left: 8px; right: 8px; display: flex; gap: 8px; padding: 8px; background: #fff; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.15); z-index: 10; }
  .toolbar button { padding: 8px 14px; border: 1px solid #1e4a8a; background: #1e4a8a; color: #fff; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 14px; }
  .toolbar .info { margin-left: 12px; line-height: 1.5; font-size: 13px; color: #333; }
  .label { width: 58mm; height: 40mm; background: #fff; color: #000; display: flex; flex-direction: row; padding: 2mm; page-break-after: always; margin: 0 auto 8px; border: 1px dashed #999; overflow: hidden; }
  .label:last-child { page-break-after: auto; }
  .left { width: 35mm; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .qr { width: 34mm; height: 34mm; }
  .qr-placeholder { width: 34mm; height: 34mm; background: #eee; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #999; }
  .right { flex: 1; display: flex; flex-direction: column; justify-content: space-between; padding-left: 2mm; }
  .big-num { font-size: 26pt; font-weight: 900; line-height: 1; letter-spacing: 0; }
  .full-num { font-size: 9pt; font-family: "Courier New", monospace; letter-spacing: 0; margin-top: 1mm; }
  .meta { font-size: 7pt; line-height: 1.2; }
  .client { font-weight: 700; max-width: 19mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .date-mp { color: #444; }
  @media print { body { background: #fff; padding: 0; } .toolbar { display: none; } .label { border: none; margin: 0; } }
</style>
</head><body>
  <div class="toolbar">
    <button onclick="window.print()">Печать ленты (${boxes.length})</button>
    <button onclick="window.close()">Закрыть</button>
    <div class="info">
      <div><b>${escapeHtml(zayavkaId)}</b> · ${escapeHtml(client)}</div>
      <div>Формат: 58x40 мм · ${boxes.length} этикеток</div>
    </div>
  </div>
  <div style="height: 80px;"></div>
  ${labels || '<div style="text-align:center; padding: 40px; color: #888;">Нет коробов для печати</div>'}
</body></html>`;
}

export function applyPodborAtom(atom, ctx) {
  if (!atom || !atom.type) {
    if (atom?.korob) {
      const key = `${atom.korob}|${atom.barcode || ''}`;
      boxLayoutStore.set(key, { verified: !!atom.verified, updatedAt: Date.now(), by: ctx.user });
      return { ok: true, type: 'legacy.verified', key };
    }
    return { ok: false, error: 'missing type' };
  }

  switch (atom.type) {
    case 'box.set_layout': {
      const { boxId, barcodes } = atom;
      if (!boxId || !barcodes || typeof barcodes !== 'object') {
        return { ok: false, error: 'box.set_layout requires { boxId, barcodes }' };
      }
      const prev = boxLayoutStore.get(boxId) || { barcodes: {} };
      const merged = { ...prev.barcodes };
      for (const [barcode, slots] of Object.entries(barcodes)) {
        merged[barcode] = {
          kolPodb: Number(slots.kolPodb) || 0,
          kudaPodb: String(slots.kudaPodb || ''),
          kolPerem: Number(slots.kolPerem) || 0,
          kudaPerem: String(slots.kudaPerem || ''),
        };
      }
      boxLayoutStore.set(boxId, { barcodes: merged, updatedAt: Date.now(), by: ctx.user });
      return { ok: true, type: atom.type, boxId };
    }
    case 'ship.create': {
      const { zayavkaId, count, taraType } = atom;
      const n = Number(count);
      if (!zayavkaId || !Number.isFinite(n) || n < 1 || n > 200) {
        return { ok: false, error: 'ship.create requires { zayavkaId, count(1..200), taraType }' };
      }
      const prefix = shipPrefix(zayavkaId);
      let entry = shipBoxStore.get(zayavkaId);
      if (!entry) entry = { boxes: [], nextSeq: 1 };
      const created = [];
      for (let i = 0; i < n; i++) {
        const seq = entry.nextSeq++;
        created.push({
          number: `${prefix}-${pad3(seq)}`,
          short: seq,
          taraType: String(taraType || 'К_1.0'),
          status: 'open',
          createdAt: Date.now(),
          createdBy: ctx.user,
        });
      }
      entry.boxes.push(...created);
      shipBoxStore.set(zayavkaId, entry);
      generateQRsInBackground(created);
      return { ok: true, type: atom.type, zayavkaId, created };
    }
    case 'ship.delete': {
      const { zayavkaId, number } = atom;
      if (!zayavkaId || !number) {
        return { ok: false, error: 'ship.delete requires { zayavkaId, number }' };
      }
      for (const layout of boxLayoutStore.values()) {
        for (const slot of Object.values(layout.barcodes || {})) {
          if (slot.kudaPodb === number) {
            return { ok: false, error: `Короб ${number} уже используется в раскладке.` };
          }
        }
      }
      const entry = shipBoxStore.get(zayavkaId);
      if (!entry) return { ok: false, error: 'заявка не найдена' };
      const idx = entry.boxes.findIndex(box => box.number === number);
      if (idx < 0) return { ok: false, error: 'короб не найден' };
      entry.boxes.splice(idx, 1);
      return { ok: true, type: atom.type, zayavkaId, deleted: number };
    }
    case 'box.inventory_correction': {
      const { boxId, barcode, novKol, oldKol, reason } = atom;
      const newQty = Number(novKol);
      if (!boxId || !barcode || !Number.isFinite(newQty) || newQty < 0) {
        return { ok: false, error: 'box.inventory_correction requires { boxId, barcode, novKol(>=0) }' };
      }
      inventoryOverrides.set(inventoryKey(boxId, barcode), newQty);
      inventoryAuditLog.push({
        boxId,
        barcode,
        oldQty: Number(oldKol) || null,
        newQty,
        reason: String(reason || '').trim(),
        by: ctx.user,
        ts: Date.now(),
      });
      const layout = boxLayoutStore.get(boxId);
      const slot = layout?.barcodes?.[barcode];
      if (slot && slot.kolPodb + slot.kolPerem > newQty) {
        if (slot.kolPodb > newQty) {
          slot.kolPodb = newQty;
          slot.kolPerem = 0;
        } else {
          slot.kolPerem = newQty - slot.kolPodb;
        }
        layout.updatedAt = Date.now();
      }
      return { ok: true, type: atom.type, boxId, barcode, newQty };
    }
    default:
      return { ok: false, error: 'unknown atom: ' + atom.type };
  }
}

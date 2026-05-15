import QRCode from 'qrcode';
import { addOp as syncAddOp, finishZayavkaFull, forwardRefresh } from './sync-engine.js';
import { KorobyIndex } from './koroby-index.js';
import { markInProgress, markFinished, markPartial, markClosed, readZayavkaStatus } from './bd-writer.js';
import { appendEvent, updateMeta } from './events.js';
import { loadActiveZayavki } from './zayavki.js';
import { writeNachToSheet } from './nach-writer.js';
import { buildFinishSummary, writeFinishSummary, findRowByZayavkaNumber } from './bd-summary-writer.js';
import { writeOtgSummary, findRowOnOtg } from './otg-summary-writer.js';
import { readState, archive, transact } from './zayavka-store.js';
import { getKorobySpreadsheetId, getPodborySpreadsheetId, getNachislenyaSpreadsheetId } from './spreadsheet-id.js';
import { logEvent } from './sync-log.js';

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

// Источник правды для ship-boxes = state-файл (event-store применяет
// ship.create/ship.delete через applySideEffects в events.js). In-memory
// shipBoxStore оставляем для legacy совместимости со старыми атомами, но
// при чтении приоритет — state. Это переживает рестарт сервера и одинаково
// видно всем планшетам (мульти-tablet sync).
export async function getShipBoxes(zayavkaId) {
  try {
    const state = await readState(zayavkaId);
    if (state && Array.isArray(state.shipBoxes)) {
      return { zayavkaId, boxes: state.shipBoxes };
    }
  } catch (e) {
    console.error('[podbor:getShipBoxes] readState failed:', e.message);
  }
  // Fallback: legacy in-memory cache (заявки которые не запускали zayavka.start).
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

// Async dispatcher to sync engine (запись в "🍬 КОРОБЫ" через очередь).
// Не блокирует основной apply — fire-and-log. Если ctx без zayavkaId/client,
// пропускаем (например, legacy verified-атом без контекста).
// Контекст заявки для записи в КОРОБЫ: M (склад), N (дата), и т.п.
// Передаётся в payload каждого атома.
function buildZayavkaContext(ctx) {
  return {
    warehouse: ctx.warehouse || '',
    finalWarehouse: ctx.finalWarehouse || '',
    dateOtgr: ctx.dateOtgr || '',
    mp: ctx.mp || '',
  };
}

// === EVENT STORE dispatching ===
// Каждый атом превращается в событие в zayavki/<id>.json (primary store).
// Параллельно — старый dispatchToSyncEngine (write-through к листу "🍬 КОРОБЫ").
// Если эта функция упадёт — атом теряется НЕ полностью (sync engine продолжит
// писать на лист), но JSON-state расходится. Логируем и не блокируем.

// Кэш snapshot короба для full_to_ship (избегаем повторных read).
let _korobySnapshot = null;
let _korobySnapshotAt = 0;
const SNAPSHOT_TTL_MS = 30000;

async function getKorobySnapshot() {
  const now = Date.now();
  if (_korobySnapshot && (now - _korobySnapshotAt) < SNAPSHOT_TTL_MS) {
    return _korobySnapshot;
  }
  _korobySnapshot = new KorobyIndex();
  await _korobySnapshot.refresh();
  _korobySnapshotAt = now;
  return _korobySnapshot;
}

// Загрузить request items + ks/mp/warehouse + skuByBarcode при первом обращении.
// SKU нормализуется через loadClientBoxes (первое непустое значение per баркод).
async function loadZayavkaMeta(zayavkaId) {
  try {
    const all = await loadActiveZayavki();
    const z = all.find(x => x.number === zayavkaId);
    if (!z) return null;
    // Подтянем SKU через loadClientBoxes (там есть normalized skuByBarcode).
    let skuMap = {};
    try {
      const { loadClientBoxes } = await import('./boxes.js');
      const data = await loadClientBoxes(z.client, null); // без zayavka, чтобы быстро
      skuMap = data.skuByBarcode || {};
    } catch (e) { /* не критично */ }
    return {
      client: z.client,
      mp: z.mp,
      ks: z.ks,
      warehouse: z.warehouse,
      finalWarehouse: z.finalWarehouse,
      dateOtgr: z.dateOtgr,
      requestItems: z.items.map(it => ({
        barcode: it.barcode,
        qty: it.qty,
        sku: skuMap[it.barcode] || '',
      })),
    };
  } catch (e) {
    console.error('[podbor:event-store] loadZayavkaMeta failed:', e.message);
    return null;
  }
}

async function dispatchAtomToEventStore(atom, ctx) {
  const { zayavkaId, client, user } = ctx;
  if (!zayavkaId) return;
  // Передаём фронт-контекст в updateMeta — он заполнит только пустые поля.
  await updateMeta(zayavkaId, {
    client: client || undefined,
    mp: ctx.mp || undefined,
    warehouse: ctx.warehouse || undefined,
    finalWarehouse: ctx.finalWarehouse || undefined,
    dateOtgr: ctx.dateOtgr || undefined,
  });
  try {
    if (atom.type === 'box.set_layout') {
      const items = [];
      for (const [barcode, slots] of Object.entries(atom.barcodes || {})) {
        items.push({
          barcode,
          kolPodb: Number(slots.kolPodb) || 0,
          kudaPodb: String(slots.kudaPodb || ''),
          kolPerem: Number(slots.kolPerem) || 0,
          kudaPerem: String(slots.kudaPerem || ''),
        });
      }
      await appendEvent(zayavkaId, {
        type: 'set_layout', by: user,
        payload: { source: atom.boxId, items },
      });
    } else if (atom.type === 'box.full_to_ship') {
      // Snapshot короба-источника — нужен items[] для computed (free/paid).
      const snap = await getKorobySnapshot();
      const entries = snap.byKorobName(atom.boxId);
      const items = entries
        .filter(e => Number(e.qty) > 0)
        .map(e => ({ barcode: e.barcode, qty: Number(e.qty), sku: e.sku }));
      const newKorob = entries.length > 0
        ? (entries[0].korob && entries[0].korob[0] && entries[0].korob[0] !== 'S' && entries[0].korob[0] !== 's'
            ? 'S' + entries[0].korob.slice(1)
            : entries[0].korob)
        : atom.boxId;
      await appendEvent(zayavkaId, {
        type: 'full_to_ship', by: user,
        payload: { source: atom.boxId, newKorob, owner: atom.owner || '', items },
      });
    } else if (atom.type === 'box.inventory_correction') {
      await appendEvent(zayavkaId, {
        type: 'inventory_correction', by: user,
        payload: {
          korob: atom.boxId,
          barcode: atom.barcode,
          old: Number(atom.oldKol) || 0,
          new: Number(atom.novKol) || 0,
          reason: atom.reason || '',
        },
      });
    }
  } catch (e) {
    console.error('[podbor:event-store]', atom.type, e.message);
  }
}

async function dispatchToSyncEngine(atom, ctx) {
  const { zayavkaId, client, user } = ctx;
  if (!zayavkaId || !client) return;
  const zayavkaContext = buildZayavkaContext(ctx);
  try {
    if (atom.type === 'box.set_layout') {
      const items = [];
      for (const [barcode, slots] of Object.entries(atom.barcodes || {})) {
        items.push({
          barcode,
          kolPodb: Number(slots.kolPodb) || 0,
          kudaPodb: String(slots.kudaPodb || ''),
          kolPerem: Number(slots.kolPerem) || 0,
          kudaPerem: String(slots.kudaPerem || ''),
        });
      }
      await syncAddOp(zayavkaId, {
        type: 'set_layout',
        user,
        payload: { client, source_korob: atom.boxId, items, zayavkaContext },
      });
    } else if (atom.type === 'box.inventory_correction') {
      await syncAddOp(zayavkaId, {
        type: 'inventory_correction',
        user,
        payload: {
          client,
          korob: atom.boxId,
          barcode: atom.barcode,
          novKol: Number(atom.novKol) || 0,
          reason: atom.reason || '',
        },
      });
    } else if (atom.type === 'box.full_to_ship') {
      await syncAddOp(zayavkaId, {
        type: 'full_to_ship',
        user,
        payload: {
          client,
          source_korob: atom.boxId,
          owner: atom.owner || '',
          zayavkaContext,
        },
      });
    }
  } catch (e) {
    console.error('[podbor:sync-dispatch]', atom.type, e.message);
  }
}

export async function applyPodborAtom(atom, ctx) {
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
      await dispatchAtomToEventStore(atom, ctx);
      await dispatchToSyncEngine(atom, ctx);
      return { ok: true, type: atom.type, boxId };
    }
    case 'ship.create': {
      const { zayavkaId, count, taraType, dimensions, owner } = atom;
      const n = Number(count);
      if (!zayavkaId || !Number.isFinite(n) || n < 1 || n > 200) {
        return { ok: false, error: 'ship.create requires { zayavkaId, count(1..200), taraType }' };
      }
      const prefix = shipPrefix(zayavkaId);
      // Нумерация из state-файла (source of truth, переживает рестарт + видна
      // всем планшетам). Cache shipBoxStore — secondary, на случай если state
      // ещё не инициализирован.
      const existingState = await readState(zayavkaId);
      const stateBoxes = (existingState && existingState.shipBoxes) || [];
      let entry = shipBoxStore.get(zayavkaId);
      if (!entry) entry = { boxes: [] };
      let baseMax = 0;
      for (const b of stateBoxes) {
        if (typeof b.short === 'number' && b.short > baseMax) baseMax = b.short;
      }
      for (const b of entry.boxes) {
        if (typeof b.short === 'number' && b.short > baseMax) baseMax = b.short;
      }
      const created = [];
      for (let i = 0; i < n; i++) {
        const seq = baseMax + 1 + i;
        created.push({
          number: `${prefix}-${pad3(seq)}`,
          short: seq,
          taraType: String(taraType || 'К_1.0'),
          dimensions: dimensions || { w: 60, h: 40, d: 40 },
          owner: owner || 'ФФ',
          status: 'open',
          createdAt: Date.now(),
          createdBy: ctx.user,
        });
      }
      entry.boxes.push(...created);
      shipBoxStore.set(zayavkaId, entry);
      generateQRsInBackground(created);
      for (const box of created) {
        try {
          await syncAddOp(zayavkaId, {
            type: 'ship_create',
            user: ctx.user,
            payload: {
              number: box.number,
              taraType: box.taraType,
              dimensions: box.dimensions,
              owner: box.owner,
            },
          });
        } catch (e) { console.error('[podbor:sync-dispatch] ship_create', e.message); }
        // EVENT STORE: append событие в primary state.
        try {
          await appendEvent(zayavkaId, {
            type: 'ship.create', by: ctx.user,
            payload: {
              number: box.number, short: box.short,
              taraType: box.taraType, dimensions: box.dimensions, owner: box.owner,
            },
          });
        } catch (e) { console.error('[podbor:event-store] ship.create', e.message); }
      }
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
      // Проверка существования: state — source of truth.
      const stateForDel = await readState(zayavkaId);
      const stateBoxesForDel = (stateForDel && stateForDel.shipBoxes) || [];
      const cacheEntry = shipBoxStore.get(zayavkaId);
      const cacheBoxes = (cacheEntry && cacheEntry.boxes) || [];
      const existsInState = stateBoxesForDel.some(b => b.number === number);
      const cacheIdx = cacheBoxes.findIndex(b => b.number === number);
      if (!existsInState && cacheIdx < 0) {
        return { ok: false, error: 'короб не найден' };
      }
      if (cacheIdx >= 0) cacheBoxes.splice(cacheIdx, 1);
      // State.shipBoxes удалится через applySideEffects при appendEvent ship.delete.
      try {
        await syncAddOp(zayavkaId, {
          type: 'ship_delete',
          user: ctx.user,
          payload: { number },
        });
      } catch (e) { console.error('[podbor:sync-dispatch] ship_delete', e.message); }
      try {
        await appendEvent(zayavkaId, {
          type: 'ship.delete', by: ctx.user, payload: { number },
        });
      } catch (e) { console.error('[podbor:event-store] ship.delete', e.message); }
      return { ok: true, type: atom.type, zayavkaId, deleted: number };
    }
    case 'box.full_to_ship': {
      // Сценарий B: трансформация исходных строк короба в строки отгрузки.
      // НЕ создаёт нового короба отгрузки. Все строки исходного короба
      // получают новый E (В СБОРКЕ), F+X (заявка), M (склад), N (дата),
      // R (комментарий с КЛ/ФФ через перенос).
      const { boxId, owner } = atom;
      if (!boxId) return { ok: false, error: 'box.full_to_ship requires { boxId }' };
      if (!ctx.zayavkaId || !ctx.client) {
        return { ok: false, error: 'box.full_to_ship requires { zayavkaId, client } in body' };
      }
      await dispatchAtomToEventStore(atom, ctx);
      await dispatchToSyncEngine(atom, ctx);
      return { ok: true, type: atom.type, boxId, owner: owner || '' };
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
      await dispatchAtomToEventStore(atom, ctx);
      await dispatchToSyncEngine(atom, ctx);
      return { ok: true, type: atom.type, boxId, barcode, newQty };
    }
    case 'zayavka.start': {
      const { zayavkaNumber, picker } = atom;
      if (!zayavkaNumber || !picker) {
        return { ok: false, error: 'zayavka.start requires { zayavkaNumber, picker }' };
      }
      try {
        // Загружаем мета-инфо заявки (request items, ks, mp, склады, дата отгр)
        // в event-store при первом старте — это primary source of truth.
        const meta = await loadZayavkaMeta(zayavkaNumber);
        if (meta) await updateMeta(zayavkaNumber, meta);
        await appendEvent(zayavkaNumber, {
          type: 'zayavka.start', by: picker, payload: { picker },
        });
        // Snapshot sourceOriginals при ПЕРВОМ старте (idempotent — последующие
        // start'ы при partial_close → продолжении НЕ перезаписывают). Нужен для
        // computed.js: free-классификация источника по ИСХОДУ (опустошён ли),
        // а не по методу события (см. computed.js).
        if (meta && meta.client) {
          try {
            await transact(zayavkaNumber, async state => {
              if (state.sourceOriginals && Object.keys(state.sourceOriginals).length > 0) return;
              const snap = await getKorobySnapshot();
              const originals = {};
              for (const entry of snap.byKey.values()) {
                if (entry.client !== meta.client) continue;
                if (!entry.korob || !entry.barcode) continue;
                const qty = Number(entry.qty) || 0;
                if (qty <= 0) continue;
                // Не снэпшотим уже отгруженные/изъятые/собранные — это
                // финальные статусы, источниками подбора служить не могут.
                const st = String(entry.status || '').toUpperCase();
                if (['В СБОРКЕ', 'СОБРАНО', 'ОТГРУЖЕНО', 'ИЗЪЯТО'].includes(st)) continue;
                // Ячейки (tara='ЯЧ') ВКЛЮЧАЕМ в snapshot для live boxesView —
                // подборщик должен видеть актуальный остаток в ячейке после
                // перекладывания. Free-правило к ячейкам не применяем — см.
                // computed.js classifier который игнорирует orig.tara=='ЯЧ'.
                const k = String(entry.korob);
                if (!originals[k]) originals[k] = { tara: entry.tara, items: {} };
                const b = String(entry.barcode);
                originals[k].items[b] = (originals[k].items[b] || 0) + qty;
              }
              state.sourceOriginals = originals;
            });
          } catch (e) {
            console.error('[podbor:event-store] sourceOriginals snapshot failed:', e.message);
          }
        }
        const r = await markInProgress(zayavkaNumber, picker);
        return { ok: r.ok, type: atom.type, ...r };
      } catch (e) {
        return { ok: false, type: atom.type, error: e.message };
      }
    }
    case 'zayavka.finish': {
      const { zayavkaNumber, mode } = atom;
      if (!zayavkaNumber) return { ok: false, error: 'zayavka.finish requires { zayavkaNumber }' };
      const finishMode = mode === 'partial' ? 'partial' : 'full';
      // Короткий trace-id привязывает все логи одной попытки finish — `grep <id>` в pm2.
      const traceId = Math.random().toString(36).slice(2, 8);
      const tag = `[finish:${traceId}] ${zayavkaNumber}`;
      try {
        if (finishMode === 'partial') {
          await appendEvent(zayavkaNumber, {
            type: 'zayavka.finish', by: ctx.user, payload: { mode: 'partial' },
          });
          const r = await markPartial(zayavkaNumber);
          return { ok: r.ok, type: atom.type, mode: 'partial', ...r };
        }
        // mode='full' — атомарный финиш:
        //   0. PRE-FLIGHT: ENV-резолверы + state-файл + строка в БД ДО записей.
        //      Ловит ~95% реальных причин падения (забытый ENV, нет строки в БД,
        //      auth-проблема Sheets) ДО первой записи. Оставшиеся 5% (квота
        //      посреди batch'а, сетевой обрыв) закрываются идемпотентностью
        //      повторного finish: КОРОБЫ — фильтр по 'В СБОРКЕ' (no-op после
        //      успеха), НАЧ — guard `already_written` по zayavkaId, summary —
        //      перезапись теми же значениями.
        //   1. mass transition В СБОРКЕ → СОБРАНО на листе КОРОБЫ.
        //   2. append строк начислений в лист НАЧ (из event-store).
        //   3. writeOtgSummary в UPSELLER → 🚚 ОТГ (O,P,Q,R,S,T,BC).
        //   4. writeFinishSummary в ПОДБОРЫ → БД (U,V,O,W:AJ) — финал.
        //   5. archive state-файла в _done/.
        // Порядок: ОТГ ДО БД ПОДБОРЫ. БД-подборы — финальная отметка СОБРАНО,
        // пишется последней. Если ОТГ упал — БД не пишем, archive не делаем,
        // повторный finish дочистит. Все шаги идемпотентны (см. комменты в writers).
        // На каждом Sheets-вызове встроен retry на 429/QUOTA (sheets-retry.js).

        // === STEP 0: pre-flight ===
        logEvent('info', 'finish', `${tag} STEP=preflight START (mode=full, by=${ctx.user || '-'})`, { traceId, zayavkaNumber });
        const preflight = {};
        try {
          preflight.korobyId = getKorobySpreadsheetId();
          preflight.podboryId = getPodborySpreadsheetId();
          preflight.nachId = getNachislenyaSpreadsheetId();
          preflight.state = await readState(zayavkaNumber);
          if (!preflight.state) throw new Error(`state-файл не найден для ${zayavkaNumber} (zayavki/<id>.json)`);
          preflight.bdRow = await findRowByZayavkaNumber(zayavkaNumber);
          if (!preflight.bdRow) throw new Error(`заявка ${zayavkaNumber} не найдена в листе ПОДБОРЫ.БД (колонка F)`);
        } catch (e) {
          logEvent('error', 'finish', `${tag} STEP=preflight FAIL: ${e.message}`, { traceId, zayavkaNumber, error: e.message });
          console.error(`${tag} preflight stack:`, e.stack);
          return { ok: false, type: atom.type, mode: 'full', step: 'preflight', error: e.message, traceId };
        }
        logEvent('info', 'finish', `${tag} STEP=preflight OK (bdRow=${preflight.bdRow}, state=loaded)`, { traceId });

        // appendEvent ПОСЛЕ preflight: если pre-flight упал — не плодим дубли в event-store.
        await appendEvent(zayavkaNumber, {
          type: 'zayavka.finish', by: ctx.user, payload: { mode: 'full', traceId },
        });

        const scriptStartedAt = Date.now();
        const t0 = Date.now();
        // === STEPS 1-2-3 параллельно (3 разных spreadsheets) ===
        // Каждый .then логирует STEP=N OK / .catch ловит indiv. ошибку для шагового
        // лога — но Promise.all всё равно бросит на первый rejection (это ок:
        // другие шаги уже либо выполнены, либо в полёте, идемпотентны при retry).
        logEvent('info', 'finish', `${tag} STEP=parallel START (koroby + nach + readState)`, { traceId });
        let t, nachRes, finalState;
        try {
          [t, nachRes, finalState] = await Promise.all([
            finishZayavkaFull(zayavkaNumber).then(r => {
              logEvent('info', 'finish', `${tag} STEP=koroby OK transitioned=${r.transitioned} (${Date.now() - t0}ms)`, { traceId });
              return r;
            }, e => {
              logEvent('error', 'finish', `${tag} STEP=koroby FAIL: ${e.message}`, { traceId, error: e.message });
              throw Object.assign(e, { step: 'koroby' });
            }),
            writeNachToSheet(zayavkaNumber).then(r => {
              const skipNote = r.skipped ? ` skipped=${r.reason}` : '';
              logEvent('info', 'finish', `${tag} STEP=nach OK written=${r.written}${skipNote} (${Date.now() - t0}ms)`, { traceId });
              return r;
            }, e => {
              logEvent('error', 'finish', `${tag} STEP=nach FAIL: ${e.message}`, { traceId, error: e.message });
              throw Object.assign(e, { step: 'nach' });
            }),
            readState(zayavkaNumber).then(r => r, e => {
              logEvent('error', 'finish', `${tag} STEP=readState FAIL: ${e.message}`, { traceId, error: e.message });
              throw Object.assign(e, { step: 'readState' });
            }),
          ]);
        } catch (e) {
          console.error(`${tag} parallel stack:`, e.stack);
          return { ok: false, type: atom.type, mode: 'full', step: e.step || 'parallel', error: e.message, traceId };
        }

        // === Подготовка summary (in-memory, без Sheets-запросов) ===
        const summary = buildFinishSummary(finalState, {
          transitioned: t.transitioned,
          nachWritten: nachRes.written,
          scriptStartedAt,
        });

        // === STEP 4: writeOtgSummary (UPSELLER.🚚 ОТГ — проброс в главную таблицу) ===
        // ОТГ ДО БД-ПОДБОРЫ (по бизнес-правилу: БД-подборы — финал, ставится
        // последней). ОТГ обязателен: если упало — БД не пишем, archive не делаем.
        // Идемпотентна: повторный finish перезапишет O,P,Q,R,S,T,BC теми же
        // значениями. retry на 429 встроен в writer (см. sheets-retry.js).
        const t4 = Date.now();
        let otg;
        try {
          otg = await writeOtgSummary(zayavkaNumber, summary);
          if (otg.ok) {
            logEvent('info', 'finish', `${tag} STEP=otg OK row=${otg.row} (${Date.now() - t4}ms)`, { traceId });
          } else {
            // not_found: строки на ОТГ нет (менеджер не завёл заявку) — fail-fast,
            // не пишем БД, не архивируем. Пользователь увидит понятную ошибку
            // и попросит менеджера завести заявку на ОТГ.
            logEvent('error', 'finish', `${tag} STEP=otg FAIL reason=${otg.reason}: ${otg.error}`, { traceId });
            return { ok: false, type: atom.type, mode: 'full', step: 'otg', error: otg.error, reason: otg.reason, traceId };
          }
        } catch (e) {
          logEvent('error', 'finish', `${tag} STEP=otg FAIL: ${e.message}`, { traceId, error: e.message });
          console.error(`${tag} otg stack:`, e.stack);
          return { ok: false, type: atom.type, mode: 'full', step: 'otg', error: e.message, traceId };
        }

        // === STEP 5: writeFinishSummary (БД ПОДБОРЫ — финальная отметка СОБРАНО) ===
        // Делается ПОСЛЕДНЕЙ из Sheets-операций: U/V становятся 'СОБРАНО'+ts
        // одной batch-записью с W:AJ. После успеха фронт по readZayavkaStatus
        // увидит СОБРАНО и заблокирует UI. Все предыдущие шаги уже идемпотентны.
        const t5 = Date.now();
        let r;
        try {
          r = await writeFinishSummary(zayavkaNumber, summary);
          logEvent('info', 'finish', `${tag} STEP=summary OK ok=${r.ok} reason=${r.reason || '-'} (${Date.now() - t5}ms)`, { traceId });
        } catch (e) {
          logEvent('error', 'finish', `${tag} STEP=summary FAIL: ${e.message}`, { traceId, error: e.message });
          console.error(`${tag} summary stack:`, e.stack);
          return { ok: false, type: atom.type, mode: 'full', step: 'summary', error: e.message, traceId };
        }

        // === STEP 6: archive (только при полном успехе summary) ===
        if (r.ok) {
          try {
            if (finalState) await archive(zayavkaNumber, finalState);
            logEvent('info', 'finish', `${tag} STEP=archive OK`, { traceId });
          } catch (e) {
            logEvent('warn', 'finish', `${tag} STEP=archive FAIL (non-fatal): ${e.message}`, { traceId, error: e.message });
            console.error(`${tag} archive stack:`, e.stack);
          }
        }
        logEvent('info', 'finish', `${tag} TOTAL ${Date.now() - t0}ms ok=${r.ok}`, { traceId });
        return {
          ok: r.ok, type: atom.type, mode: 'full', traceId,
          transitioned: t.transitioned,
          nachWritten: nachRes.written,
          totalCharge: nachRes.totalCharge,
          summary: {
            shipBoxCount: summary.shipBoxCount,
            totalUnits: summary.totalUnits,
            freeUnits: summary.freeUnits,
            paidUnits: summary.paidUnits,
            durationHM: summary.durationHM,
          },
          ...r,
        };
      } catch (e) {
        // Outer safety net: всё что не поймали step-локальные catch'и.
        logEvent('error', 'finish', `${tag} UNHANDLED: ${e.message}`, { traceId, zayavkaNumber, error: e.message });
        console.error(`${tag} unhandled stack:`, e.stack);
        return { ok: false, type: atom.type, error: e.message, traceId };
      }
    }
    case 'zayavka.partial_close': {
      const { zayavkaNumber } = atom;
      if (!zayavkaNumber) return { ok: false, error: 'zayavka.partial_close requires { zayavkaNumber }' };
      try {
        await appendEvent(zayavkaNumber, {
          type: 'zayavka.partial_close', by: ctx.user, payload: {},
        });
        const r = await markPartial(zayavkaNumber);
        return { ok: r.ok, type: atom.type, ...r };
      } catch (e) {
        return { ok: false, type: atom.type, error: e.message };
      }
    }
    case 'zayavka.close': {
      const { zayavkaNumber } = atom;
      if (!zayavkaNumber) return { ok: false, error: 'zayavka.close requires { zayavkaNumber }' };
      try {
        await appendEvent(zayavkaNumber, {
          type: 'zayavka.close', by: ctx.user, payload: {},
        });
        const r = await markClosed(zayavkaNumber);
        return { ok: r.ok, type: atom.type, ...r };
      } catch (e) {
        return { ok: false, type: atom.type, error: e.message };
      }
    }
    default:
      return { ok: false, error: 'unknown atom: ' + atom.type };
  }
}

// Чтение статуса заявки из БД (для отображения на фронте при заходе в заявку).
export async function readBDStatus(zayavkaNumber) {
  return readZayavkaStatus(zayavkaNumber);
}

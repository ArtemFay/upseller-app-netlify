// GET /api/podbor/archive-list?from=YYYY-MM-DD&to=YYYY-MM-DD&client=<substr>&limit=200
//
// Лёгкий список завершённых заявок (read-only архив) для страницы «История заявок».
// Источник: <PODBOR_DATA_DIR>/_done/*.json — снэпшоты, которые пишет zayavka-store.archive()
// при успешном zayavka.finish mode=full.
//
// Возвращает только агрегированную мета (без events, request, computed) — для быстрой
// загрузки таблицы списка. Детали — через /api/podbor/archive-detail.

import fs from 'fs/promises';
import path from 'path';
import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getDataRoot } from './_lib/podbor/zayavka-store.js';

function parseDateBound(s, endOfDay = false) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return d.getTime();
}

function summarize(state, filename) {
  const meta = state.meta || {};
  const nach = (state.computed && state.computed.nach) || {};
  const freeByBarcode = nach.freeByBarcode || {};
  const freeUnits = Object.values(freeByBarcode).reduce((a, b) => a + (b.qty || 0), 0);
  const pickers = Array.isArray(meta.pickers) ? meta.pickers : [];
  const startedAt = meta.startedAt || null;
  const finishedAt = meta.finishedAt || null;
  const durationMs = (startedAt && finishedAt) ? (finishedAt - startedAt) : null;
  return {
    zayavkaId: state.zayavkaId || '',
    client: meta.client || '',
    mp: meta.mp || '',
    ks: meta.ks || 1,
    status: meta.status || '',
    finishedAt,
    startedAt,
    durationMs,
    totalCharge: nach.totalCharge || 0,
    paidUnits: nach.totalPaidUnits || 0,
    freeUnits,
    shipBoxCount: Array.isArray(state.shipBoxes) ? state.shipBoxes.length : 0,
    picker: pickers.join(', '),
    _filename: filename,
  };
}

export default async function handler(request) {
  try {
    await requireUser(request);
    if (request.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);
    const url = new URL(request.url);
    const from = parseDateBound(url.searchParams.get('from'), false);
    const to = parseDateBound(url.searchParams.get('to'), true);
    const clientSubstr = (url.searchParams.get('client') || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));

    const doneDir = path.join(getDataRoot(), '_done');
    let files = [];
    try {
      files = await fs.readdir(doneDir);
    } catch (e) {
      if (e.code === 'ENOENT') return jsonResponse({ items: [] });
      throw e;
    }
    files = files.filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));

    const items = [];
    for (const f of files) {
      const fp = path.join(doneDir, f);
      try {
        const raw = await fs.readFile(fp, 'utf8');
        const state = JSON.parse(raw);
        const item = summarize(state, f);
        if (from != null && (item.finishedAt == null || item.finishedAt < from)) continue;
        if (to != null && (item.finishedAt == null || item.finishedAt > to)) continue;
        if (clientSubstr && !String(item.client).toLowerCase().includes(clientSubstr)) continue;
        items.push(item);
      } catch (err) {
        // Битый JSON-файл архива не должен ронять весь список. Пропускаем.
        items.push({
          zayavkaId: '', client: '', mp: '', ks: 1, status: 'ERROR',
          finishedAt: null, startedAt: null, durationMs: null,
          totalCharge: 0, paidUnits: 0, freeUnits: 0, shipBoxCount: 0,
          picker: `(не удалось прочитать: ${err.message})`,
          _filename: f,
        });
      }
    }

    items.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const total = items.length;
    const sliced = items.slice(0, limit);

    return jsonResponse({ items: sliced, total, limit });
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

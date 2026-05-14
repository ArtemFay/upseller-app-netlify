// GET /api/podbor/nach?zayavkaId=...
//   Возвращает детальный отчёт по начислениям заявки (paid + free).
//   Source of truth — JSON-state на бэке, не лист.

import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { readState } from './_lib/podbor/zayavka-store.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    if (request.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);
    const url = new URL(request.url);
    const zayavkaId = url.searchParams.get('zayavkaId');
    if (!zayavkaId) return jsonResponse({ error: 'zayavkaId required' }, 400);
    const state = await readState(zayavkaId);
    if (!state) {
      return jsonResponse({
        zayavkaId, exists: false,
        message: 'Заявка ещё не была начата. Нажмите «Начать» в шапке заявки.',
      });
    }
    const nach = state.computed.nach || {};
    // Список paid-баркодов в удобном для UI формате (array, sorted by charge desc).
    const paidItems = Object.entries(nach.paidByBarcode || {})
      .map(([barcode, info]) => ({
        barcode,
        sku: info.sku || '',
        qty: info.qty || 0,
        charge: info.charge || 0,
      }))
      .sort((a, b) => b.charge - a.charge);
    const freeItems = Object.entries(nach.freeByBarcode || {})
      .map(([barcode, info]) => ({
        barcode,
        sku: info.sku || '',
        qty: info.qty || 0,
      }))
      .sort((a, b) => b.qty - a.qty);
    return jsonResponse({
      zayavkaId, exists: true,
      meta: {
        client: state.meta.client,
        mp: state.meta.mp,
        ks: state.meta.ks,
        status: state.meta.status,
      },
      ratePerUnit: nach.ratePerUnit || 10,
      ks: nach.ks || state.meta.ks || 1,
      paidItems,
      freeItems,
      totals: {
        paidUnits: nach.totalPaidUnits || 0,
        paidBarcodes: paidItems.length,
        totalCharge: nach.totalCharge || 0,
        freeUnits: freeItems.reduce((a, b) => a + b.qty, 0),
        freeBarcodes: freeItems.length,
      },
      lastComputedAt: state.computed.lastComputedAt || 0,
    });
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

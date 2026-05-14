// GET  /api/podbor/state?zayavkaId=...
//   Возвращает состояние заявки с точки зрения sync engine: pending-операции,
//   виртуальные коробы отгрузки, время последнего flush'а, возраст snapshot.
//
// POST /api/podbor/state/flush
//   Body: { zayavkaId, reason?: 'partial_close' | 'finish' | 'manual' }
//   Forced flush очереди заявки до tick'а (для partial_close / finish).

import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getZayavkaState, flushZayavka, forwardRefresh } from './_lib/podbor/sync-engine.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const zayavkaId = url.searchParams.get('zayavkaId');
      if (!zayavkaId) return jsonResponse({ error: 'zayavkaId required' }, 400);
      const state = await getZayavkaState(zayavkaId);
      return jsonResponse(state);
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const action = url.searchParams.get('action') || body.action || 'flush';
      if (action === 'flush') {
        if (!body.zayavkaId) return jsonResponse({ error: 'zayavkaId required' }, 400);
        const result = await flushZayavka(body.zayavkaId, { reason: body.reason || 'manual' });
        return jsonResponse(result);
      }
      if (action === 'refresh') {
        const result = await forwardRefresh();
        return jsonResponse(result);
      }
      return jsonResponse({ error: 'unknown action: ' + action }, 400);
    }

    return jsonResponse({ error: 'method not allowed' }, 405);
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

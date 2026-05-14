// GET /api/podbor/picklog?zayavkaId=...&limit=N
//   Возвращает события заявки (timeline) — что когда сделано и кем.
//   Используется для модалки 📋 ЛОГ на фронте.

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
    const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 500);
    const state = await readState(zayavkaId);
    if (!state) {
      return jsonResponse({
        zayavkaId, exists: false, events: [],
        message: 'Заявка ещё не была начата.',
      });
    }
    // Возвращаем последние limit событий, свежие первыми (для UI).
    const events = (state.events || []).slice(-limit).reverse();
    return jsonResponse({
      zayavkaId, exists: true,
      meta: {
        client: state.meta.client,
        status: state.meta.status,
        pickers: state.meta.pickers || [],
        startedAt: state.meta.startedAt,
        finishedAt: state.meta.finishedAt,
      },
      eventsCount: (state.events || []).length,
      events,
    });
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

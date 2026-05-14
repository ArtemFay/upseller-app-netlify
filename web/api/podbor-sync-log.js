// GET /api/podbor/sync-log?since=<ts>&limit=<n>
// Возвращает последние события sync engine (queue / flush / sheet / cas / tick).

import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getEvents } from './_lib/podbor/sync-log.js';
import { isTestMode } from './_lib/podbor/spreadsheet-id.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'GET required' }, 405);
    }
    const url = new URL(request.url);
    const since = Number(url.searchParams.get('since')) || 0;
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
    return jsonResponse({
      testMode: isTestMode(),
      now: Date.now(),
      events: getEvents({ since, limit }),
    });
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

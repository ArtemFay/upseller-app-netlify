// MOCK sync endpoint. Stores verified state in @netlify/blobs by composite key.
// Заменим на реальную БД, когда будет принято решение по persistence-слою.
// Контракт см. CONTEXT.md § 5.5 и § 6.1 (атом box.set_layout / .verified пока упрощён).

import { getStore } from '@netlify/blobs';
import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';

function store() {
  return getStore({ name: 'podbor-verified', consistency: 'eventual' });
}

export default async function handler(request) {
  try {
    await requireUser(request);
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST required' }, 405);
    }
    const body = await request.json().catch(() => ({}));
    const updates = Array.isArray(body.updates) ? body.updates : [];

    let count = 0;
    for (const u of updates) {
      if (!u || !u.korob) continue;
      const key = `${u.korob}|${u.barcode || ''}`;
      await store().setJSON(key, { verified: !!u.verified, ts: Date.now() });
      count++;
    }
    return jsonResponse({ ok: true, count });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

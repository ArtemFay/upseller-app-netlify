import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { applyPodborAtom } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    const user = await requireUser(request);
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST required' }, 405);
    }
    const body = await request.json().catch(() => ({}));
    const updates = Array.isArray(body.updates) ? body.updates : [];
    const ctx = { user: user.email || user.name || 'unknown' };
    const results = updates.map(atom => applyPodborAtom(atom, ctx));
    const ok = results.every(r => r.ok);
    return jsonResponse({ ok, count: updates.length, results }, ok ? 200 : 207);
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

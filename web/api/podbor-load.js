import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { loadClientBoxes } from './_lib/podbor/boxes.js';
import { applyInventoryOverrides } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const client = url.searchParams.get('client');
    const zayavka = url.searchParams.get('zayavka') || null;
    if (!client) {
      return jsonResponse({ error: 'client param required' }, 400);
    }
    const t0 = Date.now();
    const data = await loadClientBoxes(client, zayavka);
    applyInventoryOverrides(data);
    data.meta.loadMs = Date.now() - t0;
    return jsonResponse(data);
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

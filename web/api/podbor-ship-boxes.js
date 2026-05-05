import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getShipBoxes } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const zayavkaId = url.searchParams.get('zayavka');
    if (!zayavkaId) return jsonResponse({ error: 'zayavka param required' }, 400);
    return jsonResponse(getShipBoxes(zayavkaId));
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

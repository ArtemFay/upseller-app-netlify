import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { loadActiveZayavki, getUniqueClients } from './_lib/podbor/zayavki.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const t0 = Date.now();
    const zayavki = await loadActiveZayavki();
    const clients = getUniqueClients(zayavki);
    return jsonResponse({ zayavki, clients, loadMs: Date.now() - t0 });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

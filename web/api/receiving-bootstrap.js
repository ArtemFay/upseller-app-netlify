import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getSupplyBootstrap } from './_lib/receiving/mock.js';
import { loadSheetBootstrap } from './_lib/receiving/sheets.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const supplyId = url.searchParams.get('supply') || url.searchParams.get('supplyCode') || '';
    if (process.env.RECEIVING_SOURCE !== 'mock') {
      try {
        return jsonResponse(await loadSheetBootstrap(supplyId));
      } catch (error) {
        console.warn('[receiving-bootstrap] sheets fallback:', error.message);
      }
    }
    return jsonResponse(getSupplyBootstrap(supplyId));
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

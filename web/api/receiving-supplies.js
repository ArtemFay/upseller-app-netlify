import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { listSupplyOptions } from './_lib/receiving/mock.js';
import { listSheetSupplyOptions } from './_lib/receiving/sheets.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const includeCounts = url.searchParams.get('includeCounts') === '1';
    if (process.env.RECEIVING_SOURCE !== 'mock') {
      try {
        const supplies = await listSheetSupplyOptions({ includeCounts });
        if (supplies.length) {
          return jsonResponse({ supplies, source: 'google-sheets' });
        }
      } catch (error) {
        console.warn('[receiving-supplies] sheets fallback:', error.message);
      }
    }
    return jsonResponse({
      supplies: listSupplyOptions(),
      source: 'mock-gas-v06',
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

import { errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getShipBoxQrPng } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const number = url.searchParams.get('number');
    if (!number) {
      return new Response(JSON.stringify({ error: 'number param required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const png = await getShipBoxQrPng(number);
    return new Response(png, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

import { errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { loadActiveZayavki } from './_lib/podbor/zayavki.js';
import { getShipBoxes, renderShipLabelsHtml } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const zayavkaId = url.searchParams.get('zayavka');
    if (!zayavkaId) {
      return new Response(JSON.stringify({ error: 'zayavka param required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const entry = getShipBoxes(zayavkaId);
    let boxes = entry.boxes;
    const numbersFilter = url.searchParams.get('numbers');
    if (numbersFilter) {
      const wanted = new Set(numbersFilter.split(',').map(s => s.trim()).filter(Boolean));
      boxes = boxes.filter(box => wanted.has(box.number));
    }

    const zayavki = await loadActiveZayavki();
    const z = zayavki.find(item => item.number === zayavkaId);
    const html = await renderShipLabelsHtml({
      boxes,
      client: z?.client || '-',
      dateOtgr: z?.dateOtgr || '-',
      mp: z?.mp || 'НЕТ',
      zayavkaId,
    });
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

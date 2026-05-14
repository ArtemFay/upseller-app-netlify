import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { applyPodborAtom, readBDStatus } from './_lib/podbor/runtime.js';

// Атомы, изменяющие данные. Если заявка уже СОБРАНО — отклоняем 409.
// zayavka.start/finish/close/partial_close проходят всегда (для re-open / повторного финиша).
const MUTATING_TYPES = new Set([
  'box.set_layout',
  'box.full_to_ship',
  'box.inventory_correction',
  'box.change_address',
  'ship.create',
  'ship.delete',
]);
// box.full_to_ship уже в списке выше.

export default async function handler(request) {
  try {
    const user = await requireUser(request);
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST required' }, 405);
    }
    const body = await request.json().catch(() => ({}));
    const updates = Array.isArray(body.updates) ? body.updates : [];
    const ctx = {
      user: user.email || user.name || 'unknown',
      zayavkaId: body.zayavkaId || null,
      client: body.client || null,
      // Контекст активной заявки — нужен для записи M (склад), N (дата) при
      // создании новых строк коробов отгрузки (D-сценарий) и при трансформации
      // (B-сценарий, full_to_ship).
      warehouse: body.warehouse || null,
      finalWarehouse: body.finalWarehouse || null,
      dateOtgr: body.dateOtgr || null,
      mp: body.mp || null,
    };

    // Status guard: если в батче есть мутирующий атом и заявка уже СОБРАНО,
    // блокируем все правки — другой планшет уже финализировал.
    const hasMutating = updates.some(u => MUTATING_TYPES.has(u.type));
    if (hasMutating && ctx.zayavkaId) {
      try {
        const bd = await readBDStatus(ctx.zayavkaId);
        if (bd && bd.status === 'СОБРАНО') {
          return jsonResponse({
            ok: false,
            error: 'zayavka_completed',
            message: `Заявка ${ctx.zayavkaId} завершена (${bd.statusChangedAt}). Правки заблокированы. Откройте список и обновите страницу.`,
            results: updates.map(u => ({
              ok: false,
              type: u.type,
              error: 'zayavka_completed',
              status: 'СОБРАНО',
              statusChangedAt: bd.statusChangedAt,
            })),
          }, 409);
        }
      } catch (e) {
        // Если не смогли прочитать БД — не блокируем, продолжаем (graceful degradation).
        console.warn('[podbor-sync] guard: readBDStatus failed:', e.message);
      }
    }

    const results = [];
    for (const atom of updates) {
      results.push(await applyPodborAtom(atom, ctx));
    }
    const ok = results.every(r => r.ok);
    return jsonResponse({ ok, count: updates.length, results }, ok ? 200 : 207);
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

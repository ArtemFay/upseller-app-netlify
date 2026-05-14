// Append-only журнал событий заявки + автоматический recompute.
//
// Любой атом (set_layout / full_to_ship / inventory_correction / ship.create /
// ship.delete / zayavka.start|finish|partial_close|close) проходит через
// appendEvent — событие добавляется в events[], computed пересчитывается.
//
// Этот модуль — точка входа из runtime.js. Sheets-операции по-прежнему идут
// параллельно через sync-engine (write-through к листу "🍬 КОРОБЫ"), но source
// of truth = JSON-state.

import { transact, getOrInit } from './zayavka-store.js';
import { recompute } from './computed.js';
import { randomUUID } from 'crypto';

// Добавить событие в state.events[] + пересчитать computed под mutex.
// Возвращает обновлённый state (для удобства).
export async function appendEvent(zayavkaId, event, partialMeta = {}) {
  if (!zayavkaId) throw new Error('appendEvent: zayavkaId обязателен');
  if (!event || !event.type) throw new Error('appendEvent: event.type обязателен');
  // Гарантируем что state-файл существует.
  await getOrInit(zayavkaId, partialMeta);
  return transact(zayavkaId, state => {
    const ev = {
      id: event.id || randomUUID(),
      ts: event.ts || Date.now(),
      type: event.type,
      by: event.by || 'unknown',
      ...event.payload,
    };
    // Удаляем дубликаты служебных полей (если попали через ...payload).
    delete ev.payload;
    state.events.push(ev);

    // Особая обработка для нескольких типов: обновляем кэшируемые поля state
    // помимо events (для удобства чтения без полного пересчёта).
    applySideEffects(state, ev);

    // Полный пересчёт derived.
    state.computed = recompute(state);
    return state;
  });
}

// Боковые эффекты — обновление кэша shipBoxes/pickers/status в state, без
// необходимости полного reparse'а events.
function applySideEffects(state, ev) {
  switch (ev.type) {
    case 'zayavka.start': {
      if (ev.picker && !state.meta.pickers.includes(ev.picker)) {
        state.meta.pickers.push(ev.picker);
      }
      if (state.meta.status === 'СОЗДАНО' || !state.meta.status) {
        state.meta.status = 'В РАБОТЕ';
        state.meta.startedAt = state.meta.startedAt || ev.ts;
      } else if (state.meta.status === 'ЧАСТ.СОБР') {
        // продолжение после частичного отчёта — возвращаемся в работу
        state.meta.status = 'В РАБОТЕ';
      }
      break;
    }
    case 'zayavka.finish': {
      const mode = ev.mode || 'full';
      state.meta.status = mode === 'partial' ? 'ЧАСТ.СОБР' : 'СОБРАНО';
      if (mode === 'full') state.meta.finishedAt = ev.ts;
      break;
    }
    case 'zayavka.partial_close': {
      state.meta.status = 'ЧАСТ.СОБР';
      break;
    }
    case 'zayavka.close': {
      // close = «выйти со своего планшета», статус В РАБОТЕ остаётся,
      // список сборщиков сохраняется. Другой сборщик может продолжить.
      // Логируем как событие, но meta не меняем.
      break;
    }
    case 'ship.create': {
      const exists = state.shipBoxes.some(b => b.number === ev.number);
      if (!exists) {
        state.shipBoxes.push({
          number: ev.number,
          short: ev.short || null,
          tara: ev.taraType || 'К_1.0',
          dimensions: ev.dimensions || null,
          owner: ev.owner || 'ФФ',
          createdAt: ev.ts,
          createdBy: ev.by,
        });
      }
      break;
    }
    case 'ship.delete': {
      state.shipBoxes = state.shipBoxes.filter(b => b.number !== ev.number);
      break;
    }
  }
}

// Обновить мета-поля заявки (warehouse, finalWarehouse, dateOtgr, ks, mp, client,
// request items) — вызывается с фронт-сайд контекстом при первой записи атома.
export async function updateMeta(zayavkaId, metaPatch = {}) {
  if (!zayavkaId) return;
  await getOrInit(zayavkaId, {});
  return transact(zayavkaId, state => {
    for (const key of ['client', 'mp', 'ks', 'warehouse', 'finalWarehouse', 'dateOtgr']) {
      if (metaPatch[key] !== undefined && metaPatch[key] !== null && metaPatch[key] !== '') {
        state.meta[key] = metaPatch[key];
      }
    }
    if (Array.isArray(metaPatch.requestItems) && state.request.items.length === 0) {
      state.request.items = metaPatch.requestItems;
    }
  });
}

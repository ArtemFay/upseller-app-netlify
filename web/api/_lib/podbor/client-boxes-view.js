// Live-derive актуального содержимого коробов/ячеек заявки.
//
// Источник: state.sourceOriginals (snapshot при zayavka.start) + цепочка
// событий (set_layout, full_to_ship, inventory_correction). На выходе —
// карта { korob: { barcode: actualQty, ... } } которая отражает «что сейчас
// физически лежит в источниках» с точки зрения этой заявки, ДО того как
// sync engine успел перенести изменения на лист КОРОБЫ.
//
// Использование:
//   - Фронт показывает в полотне эту актуальную картину, а не сырое из Sheets.
//   - При операциях (kolPodb/kolPerem) фронт видит обновлённый qty мгновенно
//     после force-poll (т.е. за 200-400мс), без ожидания 2-мин синка с Sheets.
//   - Параллельные планшеты на одной заявке видят одну и ту же картину
//     (state — общий источник правды).
//
// Ограничение MVP: применяются события ТОЛЬКО ЭТОЙ заявки. Если две разные
// заявки клиента работают с одной ячейкой, кросс-эффекты появятся только
// после flush в Sheets (через 2 мин). Это приемлемо для текущего workflow:
// одну заявку обычно ведёт один-два сборщика.

export function buildClientBoxesView(state) {
  if (!state) return { koroby: {}, computedAt: Date.now() };

  const koroby = {}; // korob → { barcode: qty }

  // 1) Baseline = state.sourceOriginals (snapshot при первом zayavka.start).
  const sourceOriginals = state.sourceOriginals || {};
  for (const [korob, info] of Object.entries(sourceOriginals)) {
    const items = (info && info.items) || {};
    if (!koroby[korob]) koroby[korob] = {};
    for (const [bar, qty] of Object.entries(items)) {
      koroby[korob][bar] = Number(qty) || 0;
    }
  }

  // 2) Применяем inventory_correction overrides — meняем "оригинал" для (korob, bar).
  for (const ev of (state.events || [])) {
    if (ev.type === 'inventory_correction' && ev.korob && ev.barcode) {
      const k = String(ev.korob);
      const b = String(ev.barcode);
      if (!koroby[k]) koroby[k] = {};
      koroby[k][b] = Number(ev.new) || 0;
    }
  }

  // 3) Применяем set_layout (per source, latest absolute value):
  //    Каждый источник: вычитаем kolPodb (ушло на отгрузку) и kolPerem
  //    (ушло в ячейку). Поскольку set_layout перезаписывает (см. computed.js),
  //    берём ПОСЛЕДНЕЕ значение per (source, barcode).
  const setLayoutLast = {}; // src → bar → { podb, perem, kudaPerem }
  for (const ev of (state.events || [])) {
    if (ev.type !== 'set_layout' || !ev.source || !Array.isArray(ev.items)) continue;
    const src = String(ev.source);
    if (!setLayoutLast[src]) setLayoutLast[src] = {};
    for (const item of ev.items) {
      const bar = String(item.barcode || '').trim();
      if (!bar) continue;
      setLayoutLast[src][bar] = {
        podb: Number(item.kolPodb) || 0,
        perem: Number(item.kolPerem) || 0,
        kudaPerem: String(item.kudaPerem || '').trim(),
      };
    }
  }
  // Также собираем kudaPodb для прибавки в ship-короба.
  const setLayoutKudaPodb = {}; // src → bar → kudaPodb
  for (const ev of (state.events || [])) {
    if (ev.type !== 'set_layout' || !ev.source || !Array.isArray(ev.items)) continue;
    const src = String(ev.source);
    if (!setLayoutKudaPodb[src]) setLayoutKudaPodb[src] = {};
    for (const item of ev.items) {
      const bar = String(item.barcode || '').trim();
      if (!bar) continue;
      setLayoutKudaPodb[src][bar] = String(item.kudaPodb || '').trim();
    }
  }
  for (const [src, bars] of Object.entries(setLayoutLast)) {
    if (!koroby[src]) koroby[src] = {};
    for (const [bar, slot] of Object.entries(bars)) {
      const consumed = slot.podb + slot.perem;
      // Вычитаем из источника. Floor у 0 — никогда не уходим в минус,
      // даже если событие "переусердствовало" (inventory mismatch).
      koroby[src][bar] = Math.max(0, (koroby[src][bar] || 0) - consumed);
      // Если kolPerem > 0 и есть kudaPerem — товар "прибавляется" в ячейку.
      if (slot.perem > 0 && slot.kudaPerem) {
        const dst = slot.kudaPerem;
        if (!koroby[dst]) koroby[dst] = {};
        koroby[dst][bar] = (koroby[dst][bar] || 0) + slot.perem;
      }
      // Если kolPodb > 0 и есть kudaPodb — товар прибавляется в короб отгрузки.
      if (slot.podb > 0) {
        const dstPodb = (setLayoutKudaPodb[src] && setLayoutKudaPodb[src][bar]) || '';
        if (dstPodb) {
          if (!koroby[dstPodb]) koroby[dstPodb] = {};
          koroby[dstPodb][bar] = (koroby[dstPodb][bar] || 0) + slot.podb;
        }
      }
    }
  }

  // 4) full_to_ship — источник полностью обнулён, новый ship-короб получает qty.
  for (const ev of (state.events || [])) {
    if (ev.type !== 'full_to_ship' || !ev.source) continue;
    const src = String(ev.source);
    if (!koroby[src]) koroby[src] = {};
    // Источник обнуляется (все его баркоды → 0).
    for (const b of Object.keys(koroby[src])) {
      koroby[src][b] = 0;
    }
    // Новый ship-короб получает items.
    const dst = String(ev.newKorob || src);
    if (!koroby[dst]) koroby[dst] = {};
    for (const item of (ev.items || [])) {
      const bar = String(item.barcode || '').trim();
      if (!bar) continue;
      const qty = Number(item.qty) || 0;
      koroby[dst][bar] = (koroby[dst][bar] || 0) + qty;
    }
  }

  return { koroby, computedAt: Date.now() };
}

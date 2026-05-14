// Pure recompute: events[] → derived state.
//
// Никаких побочных эффектов, ничего не пишет на диск — чистая функция.
// При сомнении в derived можно перезапустить пересчёт из любой точки.
//
// Из events извлекаем три ключевых блока:
//   1. pickedByBarcode — сколько единиц каждого баркода УЖЕ ушло на отгрузку
//      (suma kolPodb в set_layout + qty из full_to_ship). Это «прогресс»
//      по заявке для UI и pre-check на финише.
//   2. sourceBoxes — для каждого короба-источника, из которого мы что-то брали,
//      классификация free/paid (см. CONST/02 § 5) + items shipped/toCell.
//   3. nach — сумма начислений для записи в лист НАЧ при финише.
//      Платно списываются ТОЛЬКО paid-короба, по `kolPodb × 10 × КС`.

// Free/Paid правило (CONST/02 § 5):
//  free: источник опустошён ПОЛНОСТЬЮ на отгрузку, без перекладывания в ячейки.
//        Метод (одиночный full_to_ship vs набор set_layout) РОЛИ НЕ ИГРАЕТ.
//        Принципиальный факт: shipped == original && toCell == 0.
//  paid: любое разделение потоков (toCell > 0 ИЛИ остаток > 0), либо штучный
//        подбор без полного опустошения.
// Для применения правила нужен оригинальный qty per (source, barcode) — берётся
// из state.sourceOriginals (snapshot при zayavka.start). Если snapshot'а нет
// (например, источник = ячейка, или старая заявка без snapshot) — fallback
// на старое правило по событиям (см. ниже).

export function recompute(state) {
  const sourceBoxes = {}; // korob → { kind, reason, shipped: {bar:qty}, toCell: {bar:qty} }
  // setLayoutLast: для set_layout храним ПОСЛЕДНЕЕ значение per (source, bar) —
  // это absolute slot value, не дельта. Иначе при многократном редактировании
  // одного и того же слота (kolPodb 5 → 8) computed выходит 13 а не 8.
  const setLayoutLast = {}; // src → bar → { podb, perem, kudaPodb }
  // fullToShipCum: для full_to_ship — кумулятивный qty per (source, bar), т.к.
  // это «целиком всё что осталось», и может теоретически фиксироваться повторно.
  const fullToShipCum = {}; // src → bar → qty
  const fullToShipDst = {}; // src → newKorob

  function getSource(src) {
    if (!sourceBoxes[src]) {
      sourceBoxes[src] = {
        kind: 'free', reason: '',
        shipped: {}, toCell: {},
        fullToShipSeen: false,
        setLayoutSeen: false,
      };
    }
    return sourceBoxes[src];
  }

  for (const ev of (state.events || [])) {
    switch (ev.type) {
      case 'set_layout': {
        const src = String(ev.source || '').trim();
        if (!src || !Array.isArray(ev.items)) break;
        const srcInfo = getSource(src);
        srcInfo.setLayoutSeen = true;
        if (!setLayoutLast[src]) setLayoutLast[src] = {};
        for (const item of ev.items) {
          const barcode = String(item.barcode || '').trim();
          if (!barcode) continue;
          // ABSOLUTE: каждый set_layout перезаписывает значение слота, не суммирует.
          // Фронт всегда шлёт полный draft (см. app.js:saveBoxModal).
          setLayoutLast[src][barcode] = {
            podb: Number(item.kolPodb) || 0,
            perem: Number(item.kolPerem) || 0,
            kudaPodb: String(item.kudaPodb || '').trim(),
          };
        }
        break;
      }
      case 'full_to_ship': {
        const src = String(ev.source || '').trim();
        if (!src || !Array.isArray(ev.items)) break;
        const srcInfo = getSource(src);
        srcInfo.fullToShipSeen = true;
        const newKorob = String(ev.newKorob || src);
        fullToShipDst[src] = newKorob;
        if (!fullToShipCum[src]) fullToShipCum[src] = {};
        for (const item of ev.items) {
          const barcode = String(item.barcode || '').trim();
          if (!barcode) continue;
          const qty = Number(item.qty) || 0;
          if (qty > 0) {
            fullToShipCum[src][barcode] = (fullToShipCum[src][barcode] || 0) + qty;
          }
        }
        break;
      }
      // inventory_correction — не влияет на pickedByBarcode и nach (CONST/02 § 5).
      // ship.create / ship.delete — не влияет (виртуальные коробы без материала).
      // zayavka.start / partial_close / close / finish — мета-события.
    }
  }

  // Aggregation: материализуем sourceBoxes.shipped/.toCell из latest-state.
  const pickedByBarcode = {};
  const shipBoxesContents = {}; // korob_otgr → { bar: qty }
  for (const src of Object.keys(sourceBoxes)) {
    const info = sourceBoxes[src];
    // 1) set_layout — absolute последние значения.
    const last = setLayoutLast[src] || {};
    for (const [bar, slot] of Object.entries(last)) {
      if (slot.podb > 0) {
        info.shipped[bar] = (info.shipped[bar] || 0) + slot.podb;
        pickedByBarcode[bar] = (pickedByBarcode[bar] || 0) + slot.podb;
        if (slot.kudaPodb) {
          if (!shipBoxesContents[slot.kudaPodb]) shipBoxesContents[slot.kudaPodb] = {};
          shipBoxesContents[slot.kudaPodb][bar] = (shipBoxesContents[slot.kudaPodb][bar] || 0) + slot.podb;
        }
      }
      if (slot.perem > 0) info.toCell[bar] = (info.toCell[bar] || 0) + slot.perem;
    }
    // 2) full_to_ship — кумулятивный qty (теоретически может фиксироваться повторно;
    //    обычно один раз per source).
    const cum = fullToShipCum[src] || {};
    const dst = fullToShipDst[src] || src;
    for (const [bar, qty] of Object.entries(cum)) {
      if (qty > 0) {
        info.shipped[bar] = (info.shipped[bar] || 0) + qty;
        pickedByBarcode[bar] = (pickedByBarcode[bar] || 0) + qty;
        if (!shipBoxesContents[dst]) shipBoxesContents[dst] = {};
        shipBoxesContents[dst][bar] = (shipBoxesContents[dst][bar] || 0) + qty;
      }
    }
  }

  // Применяем inventory_correction overrides на effective-original per (korob, bar):
  // оригинальный qty в источнике может быть скорректирован микро-инвентом.
  const invCorr = {}; // korob → bar → newQty
  for (const ev of (state.events || [])) {
    if (ev.type === 'inventory_correction' && ev.korob && ev.barcode) {
      const k = String(ev.korob);
      const b = String(ev.barcode);
      if (!invCorr[k]) invCorr[k] = {};
      invCorr[k][b] = Number(ev.new) || 0;
    }
  }

  // Финальная классификация free/paid каждого источника.
  const sourceOriginals = state.sourceOriginals || {};
  for (const [src, info] of Object.entries(sourceBoxes)) {
    const toCellTotal = Object.values(info.toCell).reduce((a, b) => a + b, 0);
    const shippedTotal = Object.values(info.shipped).reduce((a, b) => a + b, 0);
    const orig = sourceOriginals[src];

    // Ячейки (tara='ЯЧ') не классифицируем по новому правилу — забор из ячейки
    // = paid service независимо от исхода. Используем fallback (старая логика).
    if (orig && orig.items && orig.tara !== 'ЯЧ') {
      // Новая логика: classification по ИСХОДУ.
      // Эффективный оригинал = snapshot + inventory_correction overrides.
      let originalTotal = 0;
      for (const [bar, qty] of Object.entries(orig.items)) {
        const corrected = invCorr[src] && (bar in invCorr[src]) ? invCorr[src][bar] : qty;
        originalTotal += Number(corrected) || 0;
      }
      if (toCellTotal === 0 && shippedTotal > 0 && shippedTotal >= originalTotal) {
        info.kind = 'free';
        info.reason = `Источник опустошён на отгрузку полностью (${shippedTotal}/${originalTotal})`;
      } else {
        info.kind = 'paid';
        if (toCellTotal > 0) info.reason = `Часть в ячейку (${toCellTotal}/${originalTotal})`;
        else if (shippedTotal < originalTotal) info.reason = `Остаток в источнике (${originalTotal - shippedTotal}/${originalTotal})`;
        else info.reason = 'Штучный подбор';
      }
    } else {
      // Fallback: нет snapshot (старая заявка без sourceOriginals или источник =
      // ячейка, см. runtime.js zayavka.start). Старая эвристика по событиям.
      if (info.fullToShipSeen && !info.setLayoutSeen && toCellTotal === 0) {
        info.kind = 'free';
        info.reason = 'Изъят целиком (full_to_ship, без snapshot)';
      } else if (info.fullToShipSeen && info.setLayoutSeen) {
        info.kind = 'paid';
        info.reason = 'Раскладка + full_to_ship';
      } else if (toCellTotal > 0) {
        info.kind = 'paid';
        info.reason = 'Часть в ячейку';
      } else if (info.setLayoutSeen) {
        info.kind = 'paid';
        info.reason = 'Штучный подбор (без snapshot)';
      } else {
        info.kind = 'free';
        info.reason = '';
      }
    }
  }

  // SKU lookup: ищем по баркоду в events (set_layout не несёт sku, но
  // full_to_ship — несёт; и в state.request.items может быть). Берём первый
  // непустой match. В UI это используется для отображения в строке начисления.
  const skuByBarcode = {};
  const tryAddSku = (bar, sku) => {
    const b = String(bar || '').trim();
    const s = String(sku || '').trim();
    if (!b || !s) return;
    if (!skuByBarcode[b]) skuByBarcode[b] = s;
  };
  for (const ev of (state.events || [])) {
    if (ev.type === 'full_to_ship' && Array.isArray(ev.items)) {
      for (const it of ev.items) tryAddSku(it.barcode, it.sku);
    }
  }
  for (const it of ((state.request && state.request.items) || [])) {
    tryAddSku(it.barcode, it.sku);
  }

  // Начисления: только paid sourceBoxes, по баркоду × тариф.
  const ks = (state.meta && Number(state.meta.ks)) > 0 ? Number(state.meta.ks) : 1;
  const RATE_PER_UNIT = 10;
  const price = RATE_PER_UNIT * ks;
  const paidByBarcode = {};
  let totalPaidUnits = 0;
  let totalCharge = 0;
  for (const info of Object.values(sourceBoxes)) {
    if (info.kind !== 'paid') continue;
    for (const [barcode, qty] of Object.entries(info.shipped)) {
      if (!paidByBarcode[barcode]) paidByBarcode[barcode] = { qty: 0, charge: 0, sku: skuByBarcode[barcode] || '' };
      paidByBarcode[barcode].qty += qty;
      paidByBarcode[barcode].charge += qty * price;
      totalPaidUnits += qty;
      totalCharge += qty * price;
    }
  }
  // Free-баркоды отдельной секцией для UI (показываем что было изъято бесплатно).
  const freeByBarcode = {};
  for (const info of Object.values(sourceBoxes)) {
    if (info.kind !== 'free') continue;
    for (const [barcode, qty] of Object.entries(info.shipped)) {
      if (!freeByBarcode[barcode]) freeByBarcode[barcode] = { qty: 0, sku: skuByBarcode[barcode] || '' };
      freeByBarcode[barcode].qty += qty;
    }
  }
  // Округление до копеек (избегаем float-артефактов вроде 50.00000001).
  totalCharge = Math.round(totalCharge * 100) / 100;
  for (const e of Object.values(paidByBarcode)) {
    e.charge = Math.round(e.charge * 100) / 100;
  }

  return {
    pickedByBarcode,
    sourceBoxes,
    shipBoxesContents,
    nach: { paidByBarcode, freeByBarcode, totalPaidUnits, totalCharge, ratePerUnit: price, ks },
    lastComputedAt: Date.now(),
  };
}

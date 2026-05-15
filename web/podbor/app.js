/* eslint-disable no-undef */
'use strict';
const $ = (id) => document.getElementById(id);

// ========== Global state ==========
const __u = (typeof window !== 'undefined' && window.__USER__) || {};
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return { name: parts[0] || '', surname: parts.slice(1).join(' ') || '' };
}
const __split = splitName(__u.name);

// ===== Status filter constants (нужны до создания state) =====
const ALL_STATUSES = [
  'ХРАНЕНИЕ', 'ГОТОВО', 'В РЕЗЕРВЕ', 'В УПАКОВКЕ',
  'СОБРАНО', 'ОТГРУЖЕНО', 'В ПРИЕМКЕ',
  'БРАК', 'СПИСАНО', 'ИЗЪЯТО', 'ОБЕЗЛИЧКА'
];
const DEFAULT_HIDDEN_STATUSES = ['БРАК', 'СОБРАНО', 'ОТГРУЖЕНО', 'СПИСАНО', 'В ПРИЕМКЕ'];

function loadHiddenStatuses() {
  try {
    const raw = localStorage.getItem('podbor:hiddenStatuses');
    if (raw == null) return new Set(DEFAULT_HIDDEN_STATUSES);
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(s => String(s).toUpperCase()) : DEFAULT_HIDDEN_STATUSES);
  } catch {
    return new Set(DEFAULT_HIDDEN_STATUSES);
  }
}
function saveHiddenStatuses(set) {
  try { localStorage.setItem('podbor:hiddenStatuses', JSON.stringify([...set])); } catch {}
}

const state = {
  view: 'start',
  user: {
    email: __u.email || '',
    name: __split.name,
    surname: __split.surname,
    picture: __u.picture || '',
    role: __u.role || 'user'
  },
  zayavki: [],
  clients: [],
  clientFilter: '',
  // Быстрый фильтр в шапке: 'all' | 'urgent' (сегодня+завтра).
  quickFilter: 'all',
  activeZayavka: null,
  requestByBar5: {},
  requestByBarcode: {},
  // Groups
  allGroups: [],
  visibleGroups: [],
  allRowsFlat: [],
  visibleRowsFlat: [],
  availability: {},
  // Pagination
  pages: [],
  currentPage: 0,
  loadMs: null,
  // Раскладка коробов: boxId → { barcode → {kolPodb, kudaPodb, kolPerem, kudaPerem} }
  boxLayouts: {},
  // Коробы отгрузки активной заявки: [{ number, short, taraType, status }]
  shipBoxes: [],
  // BoxModal: { boxId, rows, draft, fullBoxMode, fullBoxTarget }
  modalBox: null,
  // CreateBoxesModal: { count, taraType }
  modalCreateBoxes: null,
  // MicroInventModal: { boxId, barcode, oldQty, newQty, reason }
  modalMicroInvent: null,
  // UI: набор скрытых статусов коробов в полотне (Set из строк ВЕРХНЕМ регистре).
  hiddenStatuses: loadHiddenStatuses(),
  // Прогресс заявки, синхронизированный с листом (sum qty где F=zay AND E=В СБОРКЕ):
  committedPicked: {}, // { barcode → qty }
  // Подбор стартован в этой сессии: имя сборщика введено + zayavka.start отправлен.
  // До нажатия «▶ Начать/Продолжить» все правки заблокированы.
  workStarted: false,
  // Live-сводка из event-store (обновляется на каждом polling /api/podbor/state):
  //   { totalCharge, paidBarcodeCount, totalPaidUnits, eventsCount }
  nachSummary: { totalCharge: 0, paidBarcodeCount: 0, totalPaidUnits: 0, eventsCount: 0 },
};

// ========== Constants ==========
const STATUS_CLASS = {
  'ГОТОВО': 'badge-gotovo', 'ХРАНЕНИЕ': 'badge-hranenie',
  'СОБРАНО': 'badge-sobrano', 'В РЕЗЕРВЕ': 'badge-rezerve',
  'В ПРИЕМКЕ': 'badge-priemke', 'В УПАКОВКЕ': 'badge-upakovke',
  'БРАК': 'badge-brak', 'ОТГРУЖЕНО': 'badge-otgr',
  'СПИСАНО': 'badge-spis', 'ИЗЪЯТО': 'badge-izyato', 'ОБЕЗЛИЧКА': 'badge-obez'
};
const Z_STATUS_CLASS = {
  'СОЗДАНО': 'zb-created',
  'В РАБОТЕ': 'zb-progress',
  'ЧАСТИЧНО СОБРАНА': 'zb-partial'
};
const Z_STATUS_RANK = { 'ЧАСТИЧНО СОБРАНА': 1, 'СОЗДАНО': 2, 'В РАБОТЕ': 3 };

// Тип заявки (БД_ЭКСП колонка P): ОТГ — отгрузка, ПЕР — перемаркировка.
const TYPE_META = {
  'ОТГ': { label: 'Отгрузка',     short: 'ОТГ', cls: 'zt-otg', title: 'Заявка на отгрузку' },
  'ПЕР': { label: 'Перемаркировка', short: 'ПЕР', cls: 'zt-per', title: 'Заявка на перемаркировку' }
};
function typeMeta(t) { return TYPE_META[t] || TYPE_META['ОТГ']; }

// Режим сборки (БД_ЭКСП колонка Q): СВОБ / КОР / КОР+.
// СВОБ  — свободно, можно дербанить любые короба, создавать новые на отгрузку.
// КОР   — только готовые короба целиком; нельзя дербанить, нельзя миксовать.
// КОР+  — приоритет полные короба; раздербанить разрешено только ОДИН на остаток.
const PICK_MODE_META = {
  'СВОБ': { label: 'Свободный',         short: 'СВОБ', cls: 'zm-svob', title: 'Свободный подбор: можно собирать поштучно из любых коробов' },
  'КОР':  { label: 'По коробам',        short: 'КОР',  cls: 'zm-kor',  title: 'Только полные короба: нельзя дербанить, нельзя создавать миксы. Микро-инвент разрешён.' },
  'КОР+': { label: 'По коробам + остаток', short: 'КОР+', cls: 'zm-kor-plus', title: 'Приоритетно — полные короба; раздербанить разрешено только ОДИН для остатка' }
};
function pickModeMeta(m) { return PICK_MODE_META[m] || PICK_MODE_META['СВОБ']; }

// Активная заявка в строгом режиме «по коробам» — все правки кроме ПОЛН КОРОБ запрещены.
function isKorMode() {
  return state.activeZayavka && state.activeZayavka.pickMode === 'КОР';
}

// Активная заявка в режиме «приоритет коробам, остаток поштучно».
function isKorPlusMode() {
  return state.activeZayavka && state.activeZayavka.pickMode === 'КОР+';
}

// Любой из режимов где КОЛ ПЕРЕМ запрещён.
function noPeremMode() {
  return isKorMode() || isKorPlusMode();
}

// Sentinel: в КОР-режиме у нас нет UI-выбора ship-короба, целевой номер
// (`S<NNNN>-<MMM>`) backend сгенерирует на этапе finalize по правилу
// «один короб клиента → один короб отгрузки». Этот placeholder сохраняется
// в draft.kudaPodb всех строк короба чтобы модалка считала их разложенными.
const AUTO_KOR_TARGET = '__AUTO_KOR__';

function korBlockToast() {
  toast('Режим КОР: можно только взять короб целиком. Используйте «📦 Весь короб → отгрузка».', true);
}

// Правило КОР+ для частичного подбора (`0 < kolPodb < qty`):
// 1. Если в наличии есть ХОТЯ БЫ один не-дербаненный короб с этим баркодом
//    и `qty ≤ stillNeeded` (помещается целиком в остаток) — частичный подбор
//    запрещён, нужно сперва взять полные короба.
// 2. Если такие короба закончились (все оставшиеся > stillNeeded) — частичный
//    разрешён, но только ОДИН раздербаненный короб на баркод.
function korPlusCanPartial(row) {
  if (!isKorPlusMode()) return { ok: true };
  const { barcode, korob, qty } = row;
  const requested = requestedFor(barcode);
  const pickedOther = pickedByBarcode(barcode) - Number(state.boxLayouts[korob]?.[barcode]?.kolPodb || 0);
  const stillNeeded = Math.max(0, requested - pickedOther);

  if (stillNeeded === 0) {
    return { ok: false, reason: 'Этот баркод уже полностью собран — частичный подбор не нужен.' };
  }

  // Сама строка помещается в остаток — обязана идти полным коробом.
  if (qty <= stillNeeded) {
    return { ok: false, reason: `Короб ${korob} помещается целиком (${qty} ≤ ${stillNeeded}). Используйте «📦 Весь короб → отгрузка».` };
  }

  // Есть другой не-дербаненный короб с qty ≤ stillNeeded — он в приоритете.
  // «Не дербаненный» = в текущей раскладке kolPodb=0 (или короб не открывался).
  const fittingOther = state.allRowsFlat.find(r => {
    if (r.barcode !== barcode || r.korob === korob) return false;
    const slot = state.boxLayouts[r.korob]?.[barcode];
    const kp = Number(slot?.kolPodb || 0);
    if (kp > 0) return false; // уже что-то взято из этого короба — не считаем «свежим полным»
    return r.qty <= stillNeeded;
  });
  if (fittingOther) {
    return { ok: false, reason: `Сначала возьмите целиком короб ${fittingOther.korob} (${fittingOther.qty} шт ≤ нужно ${stillNeeded}). КОР+: дербанить можно только когда все полные короба разобраны.` };
  }

  // Уже есть раздербаненный короб этого баркода (другой) — больше одного нельзя.
  const alreadyPartial = state.allRowsFlat.find(r => {
    if (r.barcode !== barcode || r.korob === korob) return false;
    const slot = state.boxLayouts[r.korob]?.[barcode];
    const kp = Number(slot?.kolPodb || 0);
    return kp > 0 && kp < r.qty;
  });
  if (alreadyPartial) {
    return { ok: false, reason: `КОР+: уже раздербанен короб ${alreadyPartial.korob}. Только один раздербаненный короб на баркод.` };
  }

  return { ok: true };
}

// ========== Helpers ==========
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pluralStrok(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'строка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'строки';
  return 'строк';
}
function pluralZayavok(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'заявка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'заявки';
  return 'заявок';
}
function pluralKorobov(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'короб';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'короба';
  return 'коробов';
}

function buildRequestByBar5(items) {
  const m = {};
  for (const it of items || []) {
    const b5 = String(it.barcode).slice(-5);
    m[b5] = (m[b5] || 0) + Number(it.qty || 0);
  }
  return m;
}

// normBar — нормализованный ключ баркода (только цифры). Нужен, потому что
// на листе КОРОБЫ Озон-товары могут иметь префикс `OZN` (например
// `OZN3492817446`), а в заявке тот же товар фигурирует как `3492817446`.
// Сравнение строк-как-есть не находит совпадение → «Не в заявке», кнопка
// «Изъять целиком» гасится. Нормализация до цифр снимает проблему.
function normBar(s) {
  return String(s || '').replace(/\D/g, '');
}

function buildRequestByBarcode(items) {
  const m = {};
  for (const it of items || []) {
    const b = String(it.barcode);
    const qty = Number(it.qty || 0);
    m[b] = (m[b] || 0) + qty;
    // Алиас по нормализованной форме — позволяет искать и по `OZN3492817446`,
    // и по `3492817446`. Если ключи уже совпадают (нет префикса) — повторное
    // суммирование не делаем (alias === original).
    const nb = normBar(b);
    if (nb && nb !== b) m[nb] = (m[nb] || 0) + qty;
  }
  return m;
}

// Универсальный lookup: пробует exact, потом normBar. Используется везде где
// смотрим «сколько нужно по этому баркоду».
function requestedFor(barcode) {
  const exact = Number(state.requestByBarcode[barcode] || 0);
  if (exact) return exact;
  return Number(state.requestByBarcode[normBar(barcode)] || 0);
}

function availForGroup(group, availability) {
  const seen = new Set();
  let total = 0;
  for (const r of group.rows) {
    const b = String(r.barcode || '');
    if (b && !seen.has(b)) {
      seen.add(b);
      total += Number(availability[b] || 0);
    }
  }
  return total;
}

function pickedByBarcode(barcode) {
  // Сравнение баркодов через normBar — на коробе может быть OZN-префикс,
  // а в заявке тот же товар без префикса. Без нормализации pickedByBarcode
  // не находит сборку для заявленного баркода → checkFinishMatch ложно
  // показывает mismatch на каждом Озон-баркоде.
  const target = normBar(barcode);
  let total = 0;
  for (const [bar, qty] of Object.entries(state.committedPicked || {})) {
    if (normBar(bar) === target) total += Number(qty) || 0;
  }
  for (const bars of Object.values(state.boxLayouts)) {
    for (const [bar, slot] of Object.entries(bars)) {
      if (normBar(bar) === target) total += Number(slot.kolPodb) || 0;
    }
  }
  return total;
}

function pickedByBar5(bar5) {
  let total = 0;
  // 1) Уже синхронизированное (с бэк event-store) — committedPicked хранит
  //    суммы по ПОЛНЫМ баркодам, мы матчим по последним 5 цифрам.
  for (const [bar, qty] of Object.entries(state.committedPicked || {})) {
    if (String(bar).slice(-5) === bar5) total += Number(qty) || 0;
  }
  // 2) + локальные draft в boxLayouts (ещё не улетели на бэк).
  for (const bars of Object.values(state.boxLayouts)) {
    for (const [bar, slot] of Object.entries(bars)) {
      if (String(bar).slice(-5) === bar5) total += Number(slot.kolPodb) || 0;
    }
  }
  return total;
}

// Pre-check для finish: сравниваем НУЖН (заявка) и СОБР (раскладка по баркодам).
// Возвращает { matched: true } если всё совпадает по каждому баркоду,
// иначе { matched: false, mismatches: [{barcode, requested, picked}] }.
function checkFinishMatch() {
  const mismatches = [];
  for (const [bar, qty] of Object.entries(state.requestByBarcode)) {
    const requested = Number(qty) || 0;
    const picked = pickedByBarcode(bar);
    if (picked !== requested) mismatches.push({ barcode: bar, requested, picked });
  }
  return { matched: mismatches.length === 0, mismatches };
}

function computeProgress() {
  let req = 0, pick = 0;
  for (const [bar, qty] of Object.entries(state.requestByBarcode)) {
    req += Number(qty) || 0;
    pick += pickedByBarcode(bar);
  }
  return { req, pick };
}

// ========== User identity ==========
function renderUser() {
  const u = state.user;
  const short = u.surname ? `${u.name} ${u.surname[0]}.` : (u.name || u.email || '—');
  const avatarEl = $('userAvatar');
  if (u.picture) {
    avatarEl.style.backgroundImage = `url(${u.picture})`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
    avatarEl.textContent = '';
  } else {
    avatarEl.textContent = ((u.name || u.email || '?')[0] || '?').toUpperCase();
  }
  $('userName').textContent = short;
}

// ========== Start screen ==========
async function loadZayavkiList() {
  try {
    const res = await fetch('/api/podbor/zayavki-list');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.zayavki = data.zayavki || [];
    state.clients = data.clients || [];
    fillClientFilter();
    renderStartScreen();
    toast(`Загружено ${state.zayavki.length} ${pluralZayavok(state.zayavki.length)} за ${data.loadMs} мс`);
  } catch (e) {
    toast('Ошибка загрузки заявок: ' + e.message, true);
    $('zayavkiGrid').innerHTML = `<div class="placeholder">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function fillClientFilter() {
  const sel = $('clientFilter');
  sel.innerHTML = '<option value="">— все клиенты —</option>' +
    state.clients.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count})</option>`).join('');
  sel.disabled = false;
}

// ===== Urgency helpers: today / tomorrow / later по dateOtgr ("DD.MM") =====
// Источник: БД_ЭКСП!E (FORMATTED_VALUE из Sheets) — обычно "ДД.ММ", но
// безопасно парсим и более полные форматы "ДД.ММ.ГГ"/"ДД.ММ.ГГГГ".
function parseDateOtgrDM(s) {
  const m = String(s || '').match(/^\s*(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  return { day: +m[1], month: +m[2] };
}
function urgencyOf(dateOtgr) {
  const dm = parseDateOtgrDM(dateOtgr);
  if (!dm) return 'later';
  const today = new Date();
  const tom = new Date(today);
  tom.setDate(today.getDate() + 1);
  if (dm.day === today.getDate() && dm.month === today.getMonth() + 1) return 'today';
  if (dm.day === tom.getDate()   && dm.month === tom.getMonth() + 1)   return 'tomorrow';
  return 'later';
}

function renderStartScreen() {
  let filtered = state.clientFilter
    ? state.zayavki.filter(z => z.client === state.clientFilter)
    : state.zayavki.slice();
  if (state.quickFilter === 'urgent') {
    filtered = filtered.filter(z => {
      const u = urgencyOf(z.dateOtgr);
      return u === 'today' || u === 'tomorrow';
    });
  }
  const sortFn = (a, b) => {
    const ra = Z_STATUS_RANK[a.status] || 99;
    const rb = Z_STATUS_RANK[b.status] || 99;
    if (ra !== rb) return ra - rb;
    return String(a.dateOtgr).localeCompare(String(b.dateOtgr));
  };
  filtered.sort(sortFn);

  $('startStats').textContent = `${filtered.length} ${pluralZayavok(filtered.length)}`;
  const grid = $('zayavkiGrid');
  if (!filtered.length) {
    grid.className = 'zayavki-grid';
    const reason = state.quickFilter === 'urgent' ? ' под срочный фильтр'
                 : state.clientFilter ? ' для выбранного клиента' : '';
    grid.innerHTML = `<div class="placeholder">Нет активных заявок${reason}.</div>`;
    return;
  }

  // Группировка: 🔥 СРОЧНО (today + tomorrow) сверху, отдельной секцией.
  const urgent = filtered.filter(z => {
    const u = urgencyOf(z.dateOtgr);
    return u === 'today' || u === 'tomorrow';
  });
  const later = filtered.filter(z => urgencyOf(z.dateOtgr) === 'later');

  const parts = [];
  if (urgent.length) {
    parts.push(`<h2 class="zg-header zg-urgent">🔥 Срочно — сегодня и завтра <span class="zg-count">${urgent.length}</span></h2>`);
    parts.push(`<div class="zayavki-grid">${urgent.map(renderZayavkaCard).join('')}</div>`);
  }
  if (later.length) {
    if (urgent.length) {
      parts.push(`<h2 class="zg-header zg-later">Остальные <span class="zg-count">${later.length}</span></h2>`);
    }
    parts.push(`<div class="zayavki-grid">${later.map(renderZayavkaCard).join('')}</div>`);
  }
  grid.className = 'zayavki-groups';
  grid.innerHTML = parts.join('');

  grid.querySelectorAll('button[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const num = e.currentTarget.dataset.num;
      const z = state.zayavki.find(x => x.number === num);
      if (!z) return;
      // Свободный заход в заявку — без модалки имени, без записи в БД.
      // Имя сборщика и status="В РАБОТЕ" фиксируются только при первой правке
      // (см. ensurePicker в submitBoxModal / applyMicroInvent / submitCreateBoxes).
      startZayavka(z);
    });
  });
}

// Стилизованная модалка: ввод имени сборщика. Возвращает Promise<string|null>.
function showPickerModal(defaultName) {
  return new Promise(resolve => {
    let modal = document.getElementById('appPickerModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'appPickerModal';
      modal.className = 'app-modal-overlay';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true">
        <div class="am-head">
          <h3>Кто производит подбор?</h3>
          <p class="am-sub">Имя фиксируется в БД.G при первой правке. Можно дополнить позже через запятую.</p>
        </div>
        <div class="am-body">
          <input type="text" class="am-input" id="amPickerInput" value="${escapeHtml(defaultName)}" placeholder="Иванов И.И." autocomplete="off">
        </div>
        <div class="am-footer">
          <button type="button" class="btn btn-secondary" id="amPickerCancel">Отмена</button>
          <button type="button" class="btn btn-primary" id="amPickerOk">Подтвердить</button>
        </div>
      </div>`;
    modal.classList.remove('hidden');
    const input = document.getElementById('amPickerInput');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const close = (val) => { modal.classList.add('hidden'); resolve(val); };
    document.getElementById('amPickerOk').onclick = () => close((input.value || '').trim() || null);
    document.getElementById('amPickerCancel').onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') close((input.value || '').trim() || null);
      if (e.key === 'Escape') close(null);
    };
  });
}

// Стилизованная модалка: выбор владельца тары (КЛ/ФФ). Resolve string|null.
function showOwnerModal({ title, message } = {}) {
  return new Promise(resolve => {
    let modal = document.getElementById('appOwnerModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'appOwnerModal';
      modal.className = 'app-modal-overlay';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true">
        <div class="am-head">
          <h3>${escapeHtml(title || 'Чей короб?')}</h3>
          ${message ? `<p class="am-sub">${escapeHtml(message)}</p>` : ''}
        </div>
        <div class="am-body am-owner-grid">
          <button type="button" class="am-owner-choice" data-owner="ФФ">
            <div class="am-owner-code">ФФ</div>
            <div class="am-owner-label">Фулфилмента</div>
          </button>
          <button type="button" class="am-owner-choice" data-owner="КЛ">
            <div class="am-owner-code">КЛ</div>
            <div class="am-owner-label">Клиента</div>
          </button>
        </div>
        <div class="am-footer">
          <button type="button" class="btn btn-secondary" id="amOwnerCancel">Отмена</button>
        </div>
      </div>`;
    modal.classList.remove('hidden');
    const close = (val) => { modal.classList.add('hidden'); resolve(val); };
    modal.querySelectorAll('.am-owner-choice').forEach(b => {
      b.onclick = () => close(b.dataset.owner);
    });
    document.getElementById('amOwnerCancel').onclick = () => close(null);
  });
}

// Guard: правки запрещены пока подборщик не нажал «▶ Начать/Продолжить»
// и не указал имя. Возвращает true если можно работать.
function ensureWorkStarted() {
  if (state.workStarted) return true;
  toast('Сначала нажмите «▶ Начать» в шапке заявки и укажите сборщика.', true);
  return false;
}

// Имя сборщика для текущей сессии: запрашивается ОДИН РАЗ при первой попытке
// внести правку в заявку, после чего zayavka.start атом фиксирует сборщика
// в БД.G (через запятую к существующим). Возвращает picker или null если отказ.
async function ensurePicker() {
  if (state.pickerName) return state.pickerName;
  const z = state.activeZayavka;
  if (!z) return null;
  const defaultName = (state.user.name + ' ' + state.user.surname).trim() || state.user.email || '';
  const picker = await showPickerModal(defaultName);
  if (!picker) return null;
  state.pickerName = picker;
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSyncBody(
        [{ type: 'zayavka.start', zayavkaNumber: z.number, picker }],
        z
      )),
    });
    const data = await res.json();
    const r = (data.results && data.results[0]) || {};
    if (!r.ok) {
      toast('Не удалось зафиксировать сборщика: ' + (r.error || r.reason || 'unknown'), true);
    } else {
      z.status = 'В РАБОТЕ';
      toast(`Сборщик: ${picker} → БД`);
    }
  } catch (e) {
    toast('Ошибка фиксации сборщика: ' + e.message, true);
  }
  return picker;
}

function renderZayavkaCard(z) {
  const cls = Z_STATUS_CLASS[z.status] || 'zb-other';
  const status = String(z.status || '').toUpperCase();
  const isCompleted = status === 'СОБРАНО' || status === 'ОТГРУЖЕНО';
  const isContinuable = status === 'В РАБОТЕ' || status === 'ЧАСТ.СОБР' || status === 'ЧАСТИЧНО СОБРАНА';
  const isNew = status === 'СОЗДАНО' || (!isCompleted && !isContinuable);
  // Карточка получает класс по статусу: zc-status-progress (жёлтый) для
  // «В РАБОТЕ»/«ЧАСТ.СОБР», zc-status-new (серый) для «СОЗДАНО»,
  // zc-status-done для завершённых.
  const cardStatusCls = isCompleted ? 'zc-status-done'
                       : isContinuable ? 'zc-status-progress'
                       : 'zc-status-new';
  const ksLabel = z.ks !== 1 ? `<span class="ks-label" title="Коэффициент сложности">×${z.ks}</span>` : '';
  // Дата отгрузки — главный критерий приоритета; выносим в шапку, из direction убираем.
  const direction = [z.mp || 'НЕТ', z.warehouse, z.finalWarehouse].filter(Boolean).join(' · ');
  const urgency = urgencyOf(z.dateOtgr);
  const urgencyCls = urgency === 'today' ? 'zc-urgency-today'
                   : urgency === 'tomorrow' ? 'zc-urgency-tomorrow'
                   : '';
  const urgencyBadge = urgency === 'today'
    ? '<span class="zc-urgent-badge zc-urgent-today">🔥 СЕГОДНЯ</span>'
    : urgency === 'tomorrow'
    ? '<span class="zc-urgent-badge zc-urgent-tomorrow">⚡ ЗАВТРА</span>'
    : '';
  const dateHtml = z.dateOtgr ? `<span class="zc-date" title="Дата отгрузки">${escapeHtml(String(z.dateOtgr))}</span>` : '';
  const tm = typeMeta(z.type);
  const pm = pickModeMeta(z.pickMode);
  // Кнопка: «Начать» для СОЗДАНО, «Продолжить» для В РАБОТЕ, lock для завершённых.
  let buttonHtml;
  if (isCompleted) {
    buttonHtml = `<button class="zayavka-btn disabled" disabled title="Заявка завершена">🔒 ${escapeHtml(z.status)}</button>`;
  } else if (isContinuable) {
    const subtitle = z.lockedBy ? ` (сб: ${escapeHtml(z.lockedBy)})` : '';
    buttonHtml = `<button class="zayavka-btn primary" data-action="start" data-num="${escapeHtml(z.number)}">Продолжить →${subtitle}</button>`;
  } else {
    buttonHtml = `<button class="zayavka-btn primary" data-action="start" data-num="${escapeHtml(z.number)}">Начать →</button>`;
  }
  return `
    <article class="zayavka-card ${pm.cls}-edge ${cardStatusCls} ${urgencyCls}">
      <div class="zc-head">
        <h3 class="zc-num">${escapeHtml(z.number)}</h3>
        ${dateHtml}
        ${urgencyBadge}
        <span class="zc-status ${cls}">${escapeHtml(z.status)}</span>
      </div>
      <div class="zc-tags">
        <span class="zc-type ${tm.cls}" title="${escapeHtml(tm.title)}">${escapeHtml(tm.short)}</span>
        <span class="zc-mode ${pm.cls}" title="${escapeHtml(pm.title)}">${escapeHtml(pm.short)}</span>
      </div>
      <div class="zc-client">${escapeHtml(z.client)} ${ksLabel}</div>
      <div class="zc-direction">${escapeHtml(direction)}</div>
      <div class="zc-stats">
        <span><b>${z.skuCount}</b> SKU</span>
        <span><b>${z.unitsTotal}</b> ед.</span>
      </div>
      <div class="zc-actions">${buttonHtml}</div>
    </article>`;
}

// ========== Polotno screen ==========
async function startZayavka(z) {
  state.activeZayavka = z;
  state.requestByBar5 = buildRequestByBar5(z.items);
  state.requestByBarcode = buildRequestByBarcode(z.items);
  switchView('polotno');
  $('canvas').innerHTML = '<div class="placeholder">Загрузка коробов клиента…</div>';
  renderZayavkaBar();

  try {
    const t0 = Date.now();
    const [loadRes, shipRes] = await Promise.all([
      fetch('/api/podbor/load?client=' + encodeURIComponent(z.client) + '&zayavka=' + encodeURIComponent(z.number)),
      fetch('/api/podbor/ship-boxes?zayavka=' + encodeURIComponent(z.number))
    ]);
    if (!loadRes.ok) throw new Error('load: ' + await loadRes.text());
    const data = await loadRes.json();
    const shipData = shipRes.ok ? await shipRes.json() : { boxes: [] };
    state.loadMs = Date.now() - t0;

    state.allGroups = data.groups || [];
    state.availability = data.availability || {};
    state.committedPicked = data.pickedByBarcode || {};
    state.shipRowsByBox = data.shipRows || {}; // { korobNumber → [rows] } для миксования
    state.visibleGroups = state.allGroups.filter(g => (state.requestByBar5[g.bar5] || 0) > 0);
    state.shipBoxes = shipData.boxes || [];

    state.allRowsFlat = [];
    state.allGroups.forEach(g => {
      g.rows.forEach(r => state.allRowsFlat.push({ ...r, bar5: g.bar5, color: g.color }));
    });
    // Добавляем строки коробов отгрузки в allRowsFlat — нужны для openBoxModal
    // (миксование). В visible полотно эти строки не попадут (фильтр по статусу
    // 'В СБОРКЕ' исключает их из allGroups).
    for (const [box, rows] of Object.entries(state.shipRowsByBox)) {
      for (const r of rows) {
        state.allRowsFlat.push({ ...r, isShip: true });
      }
    }

    rebuildVisibleRowsFlat();

    setMeta({
      client: z.client,
      boxes: countUniqueBoxes(),
      uniqueSku: z.skuCount,
      totalQty: z.unitsTotal,
      lines: state.visibleRowsFlat.length,
      loadMs: state.loadMs
    });

    state.pages = paginateGroups(state.visibleGroups);
    state.currentPage = 0;
    renderCurrentPage();
    updateProgress();
    const cacheNote = data.meta && data.meta.fromCache ? ' (из кэша)' : '';
    toast(`Полотно: ${state.visibleGroups.length} баркодов · ${state.visibleRowsFlat.length} строк · ${state.loadMs}мс${cacheNote}`);
    // Старт polling'а sync-state — обновит sync-точки каждые 10 сек.
    startStatePolling();
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, true);
    $('canvas').innerHTML = `<div class="placeholder">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function countUniqueBoxes() {
  const set = new Set();
  for (const r of state.visibleRowsFlat) if (r.korob) set.add(r.korob);
  return set.size;
}

function setMeta({ client = '—', boxes = 0, uniqueSku = 0, totalQty = 0, lines = 0, loadMs }) {
  $('m-client').textContent = client;
  $('m-boxes').textContent = boxes;
  $('m-sku').textContent = uniqueSku;
  $('m-qty').textContent = totalQty;
  $('m-lines').textContent = lines;
  $('m-ms').textContent = loadMs !== undefined ? `${loadMs} мс` : '—';
}

function updateProgress() {
  const { req, pick } = computeProgress();
  const el = $('m-verified');
  if (el) el.textContent = `${pick} / ${req}`;
  renderZayavkaBar();
}

function renderZayavkaBar() {
  const z = state.activeZayavka;
  if (!z) { $('zayavkaBar').innerHTML = ''; updateTopbarStartBtn(); return; }
  const cls = Z_STATUS_CLASS[z.status] || 'zb-other';
  const ks = z.ks !== 1 ? `<span class="zb-ks">×${z.ks}</span>` : '';
  const dir = [z.dateOtgr, z.mp || 'НЕТ', z.warehouse, z.finalWarehouse].filter(Boolean).join(' · ');
  const { req, pick } = computeProgress();
  const pct = req > 0 ? Math.round(100 * pick / req) : 0;
  const shipCount = state.shipBoxes.length;
  const tm = typeMeta(z.type);
  const pm = pickModeMeta(z.pickMode);
  // В режиме КОР подборщик не создаёт коробы отгрузки вручную — каждый
  // короб клиента превращается в короб отгрузки 1-к-1 на этапе finalize.
  const createBoxesBtnHtml = isKorMode()
    ? `<span class="zb-auto" title="В режиме КОР коробы отгрузки создаются автоматически на финализации заявки">📦 Авто</span>`
    : `<button type="button" class="zb-btn" id="btnCreateBoxes" title="Создать коробы отгрузки">+ Коробы (${shipCount})</button>`;
  $('zayavkaBar').innerHTML = `
    <div class="zb-main">
      <span class="zb-type ${tm.cls}" title="${escapeHtml(tm.title)}">${escapeHtml(tm.short)}</span>
      <span class="zb-mode ${pm.cls}" title="${escapeHtml(pm.title)}">${escapeHtml(pm.short)}</span>
      <span class="zb-num">${escapeHtml(z.number)}</span>
      <span class="zc-status ${cls}">${escapeHtml(z.status)}</span>
      ${ks}
      <span class="zb-client">${escapeHtml(z.client)}</span>
      <span class="zb-dir">${escapeHtml(dir)}</span>
    </div>
    <div class="zb-stats">
      <span class="zb-progress-text">Собрано: <b>${pick}</b> / ${req}${req > 0 ? ` <span class="zb-pct${pct >= 100 ? ' zb-pct-done' : ''}">· ${pct}%</span>` : ''}</span>
      ${state.workStarted ? `
        ${createBoxesBtnHtml}
        <button type="button" class="zb-btn zb-btn-nach" id="btnNach" title="Накопленные начисления по заявке (live)">💰 НАЧ · ${formatCharge(state.nachSummary.totalCharge)}</button>
        <button type="button" class="zb-btn zb-btn-log" id="btnPicklog" title="Журнал действий по заявке (live)">📋 ЛОГ · ${state.nachSummary.eventsCount || 0}</button>
        <button type="button" class="zb-btn zb-btn-close" id="btnCloseZayavka" title="Закрыть без сборки (откат заявки)">✕ Закрыть</button>
        <button type="button" class="zb-btn zb-btn-finish" id="btnFinishZayavka" title="Завершить заявку (Полное / Частичное)">✓ Завершить</button>
      ` : `
        <span class="zb-readonly-hint">📖 Просмотр — нажмите «${z.status === 'СОЗДАНО' ? 'Начать' : 'Продолжить'}» в шапке, чтобы редактировать.</span>
      `}
    </div>
  `;
  const btn = $('btnCreateBoxes');
  if (btn) btn.addEventListener('click', openCreateBoxesModal);
  const finishBtn = $('btnFinishZayavka');
  if (finishBtn) finishBtn.addEventListener('click', attemptFinish);
  const closeBtn = $('btnCloseZayavka');
  if (closeBtn) closeBtn.addEventListener('click', attemptClose);
  // Управление topbar CTA «Начать/Продолжить»: показываем на polotno если
  // workStarted=false, прячем после старта или при возврате на список.
  updateTopbarStartBtn();
  const nachBtn = $('btnNach');
  if (nachBtn) nachBtn.addEventListener('click', openNachModal);
  const logBtn = $('btnPicklog');
  if (logBtn) logBtn.addEventListener('click', openPicklogModal);
}

// Управление CTA в topbar (см. index.html: #topbarStartBtn). Показываем
// только на polotno screen с active заявкой и workStarted=false. Текст =
// «Начать» для статуса СОЗДАНО, «Продолжить» для В РАБОТЕ/ЧАСТ.СОБР.
function updateTopbarStartBtn() {
  const btn = document.getElementById('topbarStartBtn');
  if (!btn) return;
  const z = state.activeZayavka;
  const onPolotno = state.view === 'polotno';
  if (!onPolotno || !z || state.workStarted) {
    btn.classList.add('hidden');
    return;
  }
  const isResume = z.status === 'В РАБОТЕ' || z.status === 'ЧАСТ.СОБР' || z.status === 'ЧАСТИЧНО СОБРАНА';
  btn.textContent = isResume ? '▶ Продолжить' : '▶ Начать';
  btn.classList.toggle('tsb-resume', isResume);
  btn.classList.remove('hidden');
}

function formatCharge(n) {
  const x = Number(n) || 0;
  if (x === 0) return '0₽';
  return x.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '₽';
}

// Запуск редактирования заявки: ввод имени сборщика + zayavka.start.
async function startWorkflow() {
  const z = state.activeZayavka;
  if (!z) return;
  const picker = await ensurePicker();
  if (!picker) return;
  state.workStarted = true;
  renderZayavkaBar();
}

// ========== Pagination by bar5 group ==========
// Одна страница = одна BAR5-группа. Заявки обычно содержат ≤ 10 уникальных
// баркодов, поэтому подобный «один-баркод-в-фокусе» режим работает на
// планшете, телефоне и ТСД одинаково. Свайп влево/вправо — следующая группа.
function paginateGroups(groups) {
  return groups.map(g => ({ groups: [g], rowsCount: g.rows.length }));
}

// Перестраивает visibleRowsFlat + _startIdx по текущему состоянию visibleGroups.
// Вызывается при первой загрузке полотна И после live-инжекции виртуальных rows
// (через poll-handler boxesView), чтобы renderCanvas корректно срезал rows
// по _startIdx + g.rows.length. Без этого — group.rows растёт, visibleRowsFlat
// не обновляется, slice залезает в следующую группу → row "другого баркода"
// появляется в чужой группе.
function rebuildVisibleRowsFlat() {
  state.visibleGroups = (state.allGroups || []).filter(g => (state.requestByBar5[g.bar5] || 0) > 0);
  state.visibleRowsFlat = [];
  state.visibleGroups.forEach((g, gi) => {
    g._startIdx = state.visibleRowsFlat.length;
    g.rows.forEach(r => {
      state.visibleRowsFlat.push({ ...r, groupIndex: gi, bar5: g.bar5, color: g.color });
    });
  });
  // Также пересобираем pages (paginateGroups может выдать другое разбиение
  // если у одной группы выросло число rows и она перестала помещаться).
  if (typeof paginateGroups === 'function') {
    const newPages = paginateGroups(state.visibleGroups);
    // Сохраняем currentPage если индекс ещё валиден.
    if (state.currentPage >= newPages.length) state.currentPage = Math.max(0, newPages.length - 1);
    state.pages = newPages;
  }
}

function renderCurrentPage() {
  if (!state.pages.length) {
    $('canvas').innerHTML = '<div class="placeholder">Нет данных по этой заявке.</div>';
    renderPager();
    return;
  }
  if (state.currentPage < 0) state.currentPage = 0;
  if (state.currentPage >= state.pages.length) state.currentPage = state.pages.length - 1;
  const page = state.pages[state.currentPage];
  renderCanvas(page.groups);
  renderPager();
}

function renderPager() {
  let bar = document.getElementById('pager');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pager';
    bar.className = 'pager';
    $('canvas').parentNode.insertBefore(bar, $('canvas'));
  }
  if (state.pages.length <= 1) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
  const tiles = state.pages.map((p, i) => {
    const g = p.groups[0]; // одна BAR5-группа на страницу
    const bar5 = g.bar5 || '—';
    const requested = state.requestByBar5[bar5] || 0;
    const picked = pickedByBar5(bar5);
    const done = requested > 0 && picked >= requested;
    const inProgress = picked > 0 && !done;
    const active = i === state.currentPage;
    const cls = ['pager-tile',
      active ? 'is-active' : '',
      done ? 'is-done' : '',
      inProgress ? 'is-progress' : ''].filter(Boolean).join(' ');
    return `
      <button class="${cls}" data-page="${i}" title="Баркод ...${escapeHtml(bar5)} · ${picked}/${requested}">
        <span class="pt-bar5">${escapeHtml(bar5)}</span>
        <span class="pt-progress">${picked}<span class="pt-sep">/</span>${requested}</span>
      </button>`;
  }).join('');
  // Стрелки ← → удалены: все плитки видны сразу, навигация — тап по плитке.
  bar.innerHTML = `<div class="pager-tiles">${tiles}</div>`;
  bar.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.step) state.currentPage += Number(t.dataset.step);
    else if (t.dataset.page !== undefined) state.currentPage = Number(t.dataset.page);
    renderCurrentPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

// ========== Polotno table ==========
function isStatusHidden(status) {
  return state.hiddenStatuses.has(String(status || '').trim().toUpperCase());
}

function renderCanvas(groups) {
  if (!groups || !groups.length) {
    $('canvas').innerHTML = '<div class="placeholder">Нет данных для отображения.</div>';
    return;
  }
  const colgroup = `
    <colgroup>
      <col class="col-sync"><col class="col-addr"><col class="col-box">
      <col class="col-tara"><col class="col-status"><col class="col-tip">
      <col class="col-mp"><col class="col-qty"><col class="col-vsego"><col class="col-kolsku">
      <col class="col-layout">
    </colgroup>`;
  const head = `
    <thead>
      <tr>
        <th class="col-sync-th" title="Статус синхронизации">●</th>
        <th>Адрес</th><th>Короб</th><th>Тара</th><th>Статус</th>
        <th class="col-tip-th">Тип</th><th class="col-mp-th">МП</th>
        <th>Кол</th><th class="col-vsego-th">Все</th><th class="col-kolsku-th">Sku</th><th class="cell-right">Раскладка</th>
      </tr>
    </thead>`;

  let html = '';
  let totalHidden = 0;
  groups.forEach((g) => {
    const start = g._startIdx ?? 0;
    const groupRowsInStore = state.visibleRowsFlat.slice(start, start + g.rows.length);
    const visibleRows = groupRowsInStore.filter(r => !isStatusHidden(r.status));
    const hiddenCount = groupRowsInStore.length - visibleRows.length;
    totalHidden += hiddenCount;

    const requested = state.requestByBar5[g.bar5] || 0;
    const available = availForGroup(g, state.availability);
    const picked = pickedByBar5(g.bar5);
    const stillNeeded = Math.max(0, Math.min(requested, available) - picked);
    const fullBarcode = String((g.rows[0] && g.rows[0].barcode) || g.bar5 || '');
    const tail = fullBarcode.slice(-5);
    const prefix = fullBarcode.length > 5 ? fullBarcode.slice(0, -5) : '';
    // SKU баркода — берём из первой строки группы (skuByBarcode уже нормализован
    // на бэке, см. boxes.js → один SKU для одного баркода во всех строках).
    const groupSku = (g.rows[0] && g.rows[0].sku) || '';
    const counters = `
      <span class="grp-cnt zayav"><span class="grp-cnt-lbl">Заявка</span> <b>${requested}</b></span>
      <span class="grp-cnt avail${available < requested ? ' warn' : ''}${available === 0 ? ' bad' : ''}"><span class="grp-cnt-lbl">Доступно</span> <b>${available}</b></span>
      <span class="grp-cnt picked${picked > 0 ? ' active' : ''}"><span class="grp-cnt-lbl">Собрано</span> <b>${picked}</b></span>
      <span class="grp-cnt still${stillNeeded === 0 ? ' done' : ''}"><span class="grp-cnt-lbl">Ещё</span> <b>${stillNeeded}</b></span>`;
    const summary = `
      <div class="group-summary" style="background: ${g.color};">
        <div class="grp-summary-left">
          <span class="grp-rowcount">${visibleRows.length} ${pluralStrok(visibleRows.length)}${hiddenCount ? ` <span class="grp-rowcount-hidden">+ ${hiddenCount} скрыто</span>` : ''}</span>
          <span class="grp-barcode" title="Баркод ${escapeHtml(fullBarcode)}">${prefix ? `<span class="bc-prefix">${escapeHtml(prefix)}</span>` : ''}<span class="bc-tail">${escapeHtml(tail)}</span></span>
          ${groupSku ? `<span class="grp-sku" title="${escapeHtml(groupSku)}">${escapeHtml(groupSku)}</span>` : ''}
        </div>
        <div class="grp-counters">${counters}</div>
      </div>`;
    // Ship-rows для этого баркода (только короба отгрузки содержащие этот bar).
    // Появляются СВЕРХУ таблицы группы, с разделителем перед источниками.
    const shipRowsHtml = buildShipBoxesRowsForBar(g.bar5);
    const separator = shipRowsHtml
      ? `<tr class="ship-source-divider"><td colspan="11"><span>↓ Источники изъятия</span></td></tr>`
      : '';
    const dataRows = visibleRows.map(renderRow).join('');
    html += summary + `<table class="boxes-table">${colgroup}${head}<tbody>${shipRowsHtml}${separator}${dataRows}</tbody></table>`;
  });

  $('canvas').innerHTML = html;
  $('canvas').querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => {
      const boxId = tr.dataset.korob;
      if (boxId) tryOpenBoxModal(boxId);
    });
  });
}

// Wrapper для openBoxModal: если работа над заявкой ещё не начата (нет picker'a),
// сразу показываем диалог сборщика. После confirm → state.workStarted=true →
// открываем box modal. Это предотвращает «открыл короб → попытался изменить →
// тост Начните сначала» с потерей контекста. CTA «Начать/Продолжить» в topbar
// делает то же, но при клике по коробу — единый flow.
async function tryOpenBoxModal(boxId) {
  if (!boxId) return;
  if (!state.workStarted) {
    const picker = await ensurePicker();
    if (!picker) return; // user cancelled
    state.workStarted = true;
    renderZayavkaBar();
  }
  openBoxModal(boxId);
}

// Возвращает HTML-rows коробов отгрузки которые содержат указанный bar5.
// Embedded в ту же таблицу что и source rows (один общий заголовок).
// Источники: state.shipBoxes (создано через ship.create) + state.shipRowsByBox
// (из Sheets, для уже синхронизированных боксов).
function buildShipBoxesRowsForBar(activeBar5) {
  if (!activeBar5) return '';
  const fullRendered = renderShipBoxesSection(null, null, activeBar5, /* rowsOnly */ true);
  return fullRendered;
}

function renderShipBoxesSection(colgroup, head, activeBar5, rowsOnly) {
  const shipMap = new Map(); // number → { number, tara, owner, dimensions, tip, status, contents: { bar: qty } }
  for (const sb of (state.shipBoxes || [])) {
    shipMap.set(sb.number, {
      number: sb.number,
      tara: sb.tara || sb.taraType || 'К_1.0',
      owner: sb.owner || 'ФФ',
      dimensions: sb.dimensions || null,
      tip: '',
      status: 'В СБОРКЕ',
      contents: {},
    });
  }
  // Подтягиваем содержимое из shipRowsByBox (loaded from Sheets) + state.allRowsFlat
  // (где r.isShip=true для miкс-боксов в полотне).
  for (const [boxNum, rows] of Object.entries(state.shipRowsByBox || {})) {
    if (!shipMap.has(boxNum)) {
      shipMap.set(boxNum, {
        number: boxNum,
        tara: (rows[0] && rows[0].tara) || 'К_1.0',
        owner: '',
        dimensions: null,
        tip: '',
        status: '',
        contents: {},
      });
    }
    const entry = shipMap.get(boxNum);
    for (const r of rows) {
      const b = String(r.barcode || '');
      if (!b) continue;
      entry.contents[b] = (entry.contents[b] || 0) + (Number(r.qty) || 0);
      // Подтягиваем тип товара и статус из первой строки с непустым значением.
      // Колонка ТИП на листе КОРОБЫ одинакова для всех строк одного короба,
      // но в shipRows.r.tip может быть пусто, если короб пустой optimistic.
      if (!entry.tip && r.tip) entry.tip = r.tip;
      if (!entry.status && r.status) entry.status = r.status;
    }
  }
  if (shipMap.size === 0) return '';
  // Фильтр по activeBar5: оставляем только ship-короба содержащие баркод
  // текущего tile'а. Это убирает шум из других баркодов в полотне группы.
  // Если activeBar5 не передан — показываем все.
  if (activeBar5) {
    for (const [boxNum, info] of shipMap.entries()) {
      const hasMatchingBar = Object.entries(info.contents)
        .some(([bar, q]) => (Number(q) || 0) > 0 && String(bar).slice(-5) === activeBar5);
      if (!hasMatchingBar) shipMap.delete(boxNum);
    }
    if (shipMap.size === 0) return '';
  }
  let bodyRows = '';
  let totalUnits = 0;
  for (const [boxNum, info] of shipMap.entries()) {
    const totalQty = Object.values(info.contents).reduce((s, q) => s + q, 0);
    const skuCount = Object.keys(info.contents).filter(b => (info.contents[b] || 0) > 0).length;
    totalUnits += totalQty;
    const dimsStr = info.dimensions && info.dimensions.w
      ? `${info.dimensions.w}×${info.dimensions.h}×${info.dimensions.d}` : '';
    const ownerStr = info.owner || 'ФФ';
    const tipStr = info.tip || '';
    const statusStr = info.status || 'В СБОРКЕ';
    const statusKey = String(statusStr).trim().toUpperCase();
    const statusCls = STATUS_CLASS[statusKey] || 'badge-progress';
    const entries = Object.entries(info.contents).filter(([bar, q]) => {
      if ((Number(q) || 0) <= 0) return false;
      if (activeBar5 && String(bar).slice(-5) !== activeBar5) return false;
      return true;
    });
    if (entries.length === 0) {
      // Пустой ship-короб (только создан, ничего не положено).
      bodyRows += `
        <tr class="row ship-row" data-korob="${escapeHtml(boxNum)}" data-barcode="" title="Редактировать короб отгрузки">
          <td class="cell-center col-sync-td"><span class="sync-dot sd-green"></span></td>
          <td class="cell-center col-addr-td">${escapeHtml(ownerStr)}</td>
          <td class="cell-center cell-korob"><b>${escapeHtml(boxNum)}</b></td>
          <td class="cell-center col-tara-td">${escapeHtml(info.tara)}</td>
          <td class="cell-center col-status-td"><span class="badge ${statusCls}">${escapeHtml(statusStr)}</span></td>
          <td class="col-tip-td cell-center">${escapeHtml(tipStr)}</td>
          <td class="col-mp-td cell-center">${escapeHtml(ownerStr)}</td>
          <td class="cell-num">0</td>
          <td class="cell-num col-vsego-td">0</td>
          <td class="cell-num col-kolsku-td">0</td>
          <td class="cell-right col-layout-td"><span class="layout-badge layout-empty" title="${escapeHtml(dimsStr)}">пусто</span></td>
        </tr>`;
      continue;
    }
    for (const [barcode, qty] of entries) {
      const bar5 = String(barcode).slice(-5);
      // Обратная раскладка: ← откуда положено в этот ship-короб.
      // Сейчас знаем только из локальных drafts (state.boxLayouts с
      // kudaPodb === boxNum). После absorbtion source info не сохраняется —
      // показываем bar5 как fallback маркер.
      const sources = [];
      for (const [srcKorob, layout] of Object.entries(state.boxLayouts || {})) {
        const slot = layout && layout[barcode];
        if (slot && slot.kudaPodb === boxNum && (Number(slot.kolPodb) || 0) > 0) {
          sources.push(`${srcKorob} (${slot.kolPodb})`);
        }
      }
      const layoutCell = sources.length > 0
        ? `<span class="layout-badge layout-podb" title="Положено из: ${escapeHtml(sources.join(', '))}">← ${escapeHtml(sources[0])}${sources.length > 1 ? ` +${sources.length - 1}` : ''}</span>`
        : `<span class="layout-badge layout-empty" title="Баркод ...${escapeHtml(bar5)}">${escapeHtml(bar5)}</span>`;
      bodyRows += `
        <tr class="row ship-row" data-korob="${escapeHtml(boxNum)}" data-barcode="${escapeHtml(barcode)}" title="Редактировать короб отгрузки">
          <td class="cell-center col-sync-td"><span class="sync-dot sd-green"></span></td>
          <td class="cell-center col-addr-td">${escapeHtml(ownerStr)}</td>
          <td class="cell-center cell-korob"><b>${escapeHtml(boxNum)}</b></td>
          <td class="cell-center col-tara-td">${escapeHtml(info.tara)}</td>
          <td class="cell-center col-status-td"><span class="badge ${statusCls}">${escapeHtml(statusStr)}</span></td>
          <td class="col-tip-td cell-center">${escapeHtml(tipStr)}</td>
          <td class="col-mp-td cell-center">${escapeHtml(ownerStr)}</td>
          <td class="cell-num">${qty}</td>
          <td class="cell-num col-vsego-td">${totalQty}</td>
          <td class="cell-num col-kolsku-td">${skuCount}</td>
          <td class="cell-right col-layout-td">${layoutCell}</td>
        </tr>`;
    }
  }
  if (rowsOnly) return bodyRows;
  const summary = `
    <div class="group-summary ship-section-summary" style="background: linear-gradient(90deg, #d4edda 0%, #e8f5ea 100%);">
      <div class="grp-summary-left">
        <span class="grp-rowcount">📦 ${shipMap.size} ${shipMap.size === 1 ? 'короб' : 'коробов'} собрано · ${totalUnits} ед.</span>
        <span class="grp-barcode" style="color: #155724;">На отгрузку</span>
      </div>
    </div>`;
  return summary + `<table class="boxes-table">${colgroup}${head}<tbody>${bodyRows}</tbody></table>`;
}

function renderRow(r) {
  const statusKey = String(r.status || '').trim().toUpperCase();
  const cls = STATUS_CLASS[statusKey] || 'badge-other';
  const layoutBadge = renderLayoutBadge(r.korob, r.barcode, r.qty);
  const syncDot = renderSyncDot(r.korob, r.barcode);
  // Живой derive «Все» и «SKU» для этого короба/ячейки. r.vsegoVKor/r.kolSku
  // из Sheets — устаревают после optimistic update. computeBoxTotals считает
  // sum(r.qty) + count(unique bars with qty>0) по всем rows ЭТОГО короба.
  const t = computeBoxTotals(r.korob);
  return `
    <tr class="row" data-korob="${escapeHtml(r.korob)}" data-barcode="${escapeHtml(r.barcode)}" title="Открыть короб">
      <td class="cell-center col-sync-td">${syncDot}</td>
      <td class="cell-center col-addr-td">${escapeHtml(r.adr)}</td>
      <td class="cell-center cell-korob">${escapeHtml(r.korob)}</td>
      <td class="cell-center col-tara-td">${escapeHtml(r.tara)}</td>
      <td class="cell-center col-status-td">${r.status ? `<span class="badge ${cls}">${escapeHtml(r.status)}</span>` : ''}</td>
      <td class="col-tip-td cell-center">${escapeHtml(r.tip)}</td>
      <td class="col-mp-td cell-center">${escapeHtml(r.mp)}</td>
      <td class="cell-num">${Number.isFinite(Number(r.qty)) ? Number(r.qty) : ''}</td>
      <td class="cell-num col-vsego-td">${Number.isFinite(Number(t.totalQty)) ? Number(t.totalQty) : ''}</td>
      <td class="cell-num col-kolsku-td">${Number.isFinite(Number(t.skuCount)) ? Number(t.skuCount) : ''}</td>
      <td class="cell-right col-layout-td">${layoutBadge}</td>
    </tr>`;
}

// Подсчёт «Все ед.» и «SKU» (уникальных баркодов) для конкретного короба/ячейки.
// Сканирует state.allGroups + state.shipRowsByBox + state.boxesViewKoroby —
// учитывает live updates после optimistic + после force-poll.
function computeBoxTotals(korob) {
  let totalQty = 0;
  const bars = new Set();
  // Источник правды: state.allGroups (где обновляются r.qty в optimistic).
  for (const g of (state.allGroups || [])) {
    for (const r of (g.rows || [])) {
      if (r.korob !== korob) continue;
      const q = Number(r.qty) || 0;
      totalQty += q;
      if (q > 0) bars.add(String(r.barcode));
    }
  }
  // Если короб не в allGroups (например ship-короб), пробуем shipRowsByBox.
  if (totalQty === 0 && bars.size === 0) {
    const shipRows = state.shipRowsByBox && state.shipRowsByBox[korob];
    if (Array.isArray(shipRows)) {
      for (const r of shipRows) {
        const q = Number(r.qty) || 0;
        totalQty += q;
        if (q > 0) bars.add(String(r.barcode));
      }
    }
  }
  return { totalQty, skuCount: bars.size };
}

function renderBarcode(barcode) {
  const s = String(barcode || '');
  if (!s) return '';
  if (s.length <= 5) return `<span class="barcode-tail">${escapeHtml(s)}</span>`;
  return `<span class="barcode-prefix">${escapeHtml(s.slice(0, -5))}</span><span class="barcode-tail">${escapeHtml(s.slice(-5))}</span>`;
}

// Sync state per (korob, barcode):
//   undefined / 'green' — синхронизировано с листом КОРОБЫ
//   'yellow'            — атом отправлен, ещё в очереди / flush
//   'red'               — конфликт CAS, требуется повтор
const SYNC_DOT_CLASS = { green: 'sd-green', yellow: 'sd-yellow', red: 'sd-red' };
const SYNC_DOT_TITLE = {
  green: 'Синхронизировано',
  yellow: 'Синхронизация в процессе',
  red: 'Ошибка / конфликт — повторите ввод',
};
function syncKey(korob, barcode) { return `${korob}|${barcode}`; }
function renderSyncDot(korob, barcode) {
  const status = (state.rowSync && state.rowSync[syncKey(korob, barcode)]) || 'green';
  const cls = SYNC_DOT_CLASS[status] || SYNC_DOT_CLASS.green;
  const title = SYNC_DOT_TITLE[status] || SYNC_DOT_TITLE.green;
  return `<span class="sync-dot ${cls}" title="${title}"></span>`;
}
function markRowSync(korob, barcode, status) {
  if (!state.rowSync) state.rowSync = {};
  state.rowSync[syncKey(korob, barcode)] = status;
}
function markBoxSync(korob, status) {
  if (!state.allRowsFlat) return;
  for (const r of state.allRowsFlat) {
    if (r.korob === korob) markRowSync(r.korob, r.barcode, status);
  }
}

// Polling /api/podbor/state каждые 10 сек — обновляет sync-точки на основе
// pendingOps (всё что ещё в очереди → yellow) и lastFlushResult (conflicts → red).
let _statePollTimer = null;
async function pollSyncState() {
  const z = state.activeZayavka;
  if (!z) return;
  try {
    const r = await fetch('/api/podbor/state?zayavkaId=' + encodeURIComponent(z.number));
    if (!r.ok) return;
    const data = await r.json();
    const pendingByKorob = new Set();
    for (const op of (data.pendingOps || [])) {
      if (op.payload?.source_korob) pendingByKorob.add(op.payload.source_korob);
      if (op.payload?.korob) pendingByKorob.add(op.payload.korob);
    }
    if (!state.rowSync) state.rowSync = {};
    for (const r of (state.allRowsFlat || [])) {
      const k = syncKey(r.korob, r.barcode);
      if (pendingByKorob.has(r.korob)) state.rowSync[k] = 'yellow';
      else if (state.rowSync[k] === 'yellow') state.rowSync[k] = 'green';
    }
    const lfr = data.lastFlushResult;
    // Показываем toast о конфликте ОДИН РАЗ за новый flush, а не на каждый poll.
    // data.lastFlushAt — backend timestamp последнего flush'а. Сравниваем с
    // последним который мы УЖЕ видели. Без этого dedup — alert в цикле.
    if (lfr && Array.isArray(lfr.conflicts) && lfr.conflicts.length > 0
        && data.lastFlushAt && data.lastFlushAt > (state.lastSeenFlushAt || 0)) {
      const reasons = lfr.conflicts.slice(0, 3).map(c => c.reason || 'unknown').join('; ');
      toast(`⚠ Конфликт синхронизации (${lfr.conflicts.length}): ${reasons}. Полотно перезагружено.`, true);
      // ROLLBACK: перезагружаем полотно через /api/podbor/load — это
      // восстанавливает actual state (без optimistic'а который не прошёл
      // backend validation). Локальные boxLayouts для conflicted боксов
      // тоже чистим.
      state.boxLayouts = {};
      const z = state.activeZayavka;
      if (z) {
        try {
          const t0 = Date.now();
          const loadRes = await fetch('/api/podbor/load?client=' + encodeURIComponent(z.client) + '&zayavka=' + encodeURIComponent(z.number));
          if (loadRes.ok) {
            const reloadData = await loadRes.json();
            state.allGroups = reloadData.groups || [];
            state.availability = reloadData.availability || {};
            state.shipRowsByBox = reloadData.shipRows || {};
            state.allRowsFlat = [];
            state.allGroups.forEach(g => {
              g.rows.forEach(r => state.allRowsFlat.push({ ...r, bar5: g.bar5, color: g.color }));
            });
            for (const [box, rows] of Object.entries(state.shipRowsByBox)) {
              for (const r of rows) state.allRowsFlat.push({ ...r, isShip: true });
            }
            rebuildVisibleRowsFlat();
            renderCurrentPage();
            updateProgress();
          }
        } catch (e) { console.error('Rollback reload failed:', e); }
      }
    }
    if (data.lastFlushAt) state.lastSeenFlushAt = data.lastFlushAt;
    // Блокировка UI: если БД-статус СОБРАНО (другой планшет финализировал
    // заявку) — показываем баннер и отключаем правки.
    // НО: если сейчас идёт ИЛИ только что завершилась наша же попытка finish
    // (показана error-модалка по timeout), bdStatus-баннер НЕ должен лезть
    // поверх неё. Иначе юзер видит 2 окна одновременно — путаница.
    const bdStat = data.bdStatus && data.bdStatus.status;
    const progressModal = document.getElementById('progressModal');
    const finishModal = document.getElementById('finishModal');
    const hasOwnFinishModal =
      (progressModal && !progressModal.classList.contains('hidden')) ||
      (finishModal && !finishModal.classList.contains('hidden'));
    if (bdStat === 'СОБРАНО' && !state.zayavkaLocked && !hasOwnFinishModal) {
      state.zayavkaLocked = true;
      showZayavkaLockedBanner(data.bdStatus);
    }
    // Event-store summary → кнопки НАЧ и ЛОГ обновляют значения live.
    // А также committedPicked — для синхронизации тайлов прогресса между
    // несколькими планшетами, работающими над одной заявкой (multi-picker).
    let pickedChanged = false;
    if (data.eventStore) {
      const newSummary = {
        totalCharge: data.eventStore.nach.totalCharge || 0,
        paidBarcodeCount: data.eventStore.nach.paidBarcodeCount || 0,
        totalPaidUnits: data.eventStore.nach.totalPaidUnits || 0,
        eventsCount: data.eventStore.eventsCount || 0,
      };
      const oldSummary = state.nachSummary;
      const changed = oldSummary.totalCharge !== newSummary.totalCharge
        || oldSummary.eventsCount !== newSummary.eventsCount;
      state.nachSummary = newSummary;
      // Если bar уже рендерится — нужно обновить цифры на кнопках без полного rerender.
      if (changed && state.workStarted) {
        const nachBtn = $('btnNach');
        if (nachBtn) nachBtn.innerHTML = `💰 НАЧ · ${formatCharge(newSummary.totalCharge)}`;
        const logBtn = $('btnPicklog');
        if (logBtn) logBtn.innerHTML = `📋 ЛОГ · ${newSummary.eventsCount}`;
      }
      // Multi-tablet sync: committedPicked = max(initial-load-baseline, event-store).
      // ВАЖНО: event-store покрывает только события ЭТОЙ JSON-эры; sheet-baseline
      // (из /api/podbor/load) может содержать историческое значение больше. Поэтому
      // merge через max — никогда не уменьшаем, только растим.
      //
      // АБСОРБЦИЯ: когда committed вырос на Δ для баркода, вычитаем Δ из локального
      // boxLayouts[*][bar].kolPodb. Это убирает dual-count в pickedByBar5
      // (committed + boxLayouts) — иначе свежий pick считается дважды до тех пор
      // пока юзер не перезайдёт в заявку.
      const evPicked = data.eventStore.pickedByBarcode || {};
      const oldPicked = state.committedPicked || {};
      const merged = { ...oldPicked };
      const deltas = {}; // bar → сколько прибавилось к committed
      for (const [bar, qty] of Object.entries(evPicked)) {
        const q = Number(qty) || 0;
        const cur = Number(merged[bar]) || 0;
        if (q > cur) {
          deltas[bar] = q - cur;
          merged[bar] = q;
          pickedChanged = true;
        }
      }
      if (pickedChanged) {
        state.committedPicked = merged;
        // Absorbtion: для каждого баркода с delta>0 пройти по boxLayouts и
        // обнулить локальные kolPodb до полного покрытия delta. Локальный
        // draft, который уже улетел в event-store, не должен считаться повторно.
        for (const [bar, delta0] of Object.entries(deltas)) {
          let remaining = delta0;
          for (const [boxId, layout] of Object.entries(state.boxLayouts || {})) {
            if (remaining <= 0) break;
            const slot = layout && layout[bar];
            if (!slot) continue;
            const podb = Number(slot.kolPodb) || 0;
            if (podb <= 0) continue;
            const consume = Math.min(podb, remaining);
            slot.kolPodb = podb - consume;
            remaining -= consume;
          }
        }
      }
    }
    // Live boxesView: применяем актуальное содержимое коробов/ячеек к state.
    // backend derive из state.sourceOriginals + событий — учитывает kolPodb/kolPerem
    // СВОИХ операций (видно мгновенно после force-poll) и операций соседних планшетов
    // (через 10-сек polling). Sheet-flush — отдельная очередь на 2 мин.
    if (data.boxesView && data.boxesView.koroby) {
      const view = data.boxesView.koroby;
      let qtyChanged = false;
      const applyNewQty = (r) => {
        const k = String(r.korob || '');
        const b = String(r.barcode || '');
        if (!k || !b) return;
        // Защита от race: если у этого источника есть локальный uncommitted
        // draft (boxLayouts[k][b] с kolPodb/kolPerem>0), это значит POST в
        // SyncQueue ещё не закоммитил событие на backend. boxesView вернёт
        // baseline без вычета → applyNewQty перетрёт optimistic qty.
        // Skip — дождёмся next poll после backend confirm и absorbtion.
        const layout = state.boxLayouts[k];
        const slot = layout && layout[b];
        if (slot && ((Number(slot.kolPodb) || 0) > 0 || (Number(slot.kolPerem) || 0) > 0)) return;
        const newQty = view[k] && (b in view[k]) ? Number(view[k][b]) || 0 : null;
        if (newQty === null) return;
        if (Number(r.qty) !== newQty) {
          r.qty = newQty;
          qtyChanged = true;
        }
      };
      // Шаг 1: инжектируем виртуальные rows для (korob, bar) пар которые
      // появились в boxesView, но отсутствуют в полотне. Сценарий — user
      // переложил товар в НОВУЮ ячейку (которой ещё нет в Sheets-листе).
      // Без injection ячейка появилась бы только после Sheets-flush (~2 мин).
      // Ship-короба (S/R-префикс) НЕ инжектируем в полотно баркодов —
      // у них собственная секция (shipBoxes + shipRowsByBox), показ
      // в группе баркода запутывает (короб отгрузки ≠ источник).
      const knownRows = new Set();
      for (const g of (state.allGroups || [])) {
        for (const r of (g.rows || [])) knownRows.add(`${r.korob}|${r.barcode}`);
      }
      const skuByBar = {};
      for (const it of ((state.activeZayavka && state.activeZayavka.items) || [])) {
        if (it.barcode) skuByBar[it.barcode] = it.sku || '';
      }
      let injectedCount = 0;
      for (const [korob, bars] of Object.entries(view)) {
        // Ship-короба отгрузки (S5105-001 etc) НЕ показываем в полотне баркодов.
        if (/^[SR]\d+-\d/.test(korob)) continue;
        for (const [barcode, qty] of Object.entries(bars)) {
          if (Number(qty) <= 0) continue;
          if (knownRows.has(`${korob}|${barcode}`)) continue;
          const bar5 = String(barcode).slice(-5);
          // Группа баркода = только если он в запросе заявки.
          const group = (state.allGroups || []).find(g => g.bar5 === bar5);
          if (!group) continue;
          const isCell = /^\d+_\d/.test(korob);
          const newRow = {
            korob: String(korob),
            barcode: String(barcode),
            qty: Number(qty) || 0,
            tara: isCell ? 'ЯЧ' : 'К_1,0',
            status: isCell ? 'ХРАНЕНИЕ' : 'ГОТОВО',
            adr: '',
            sku: skuByBar[barcode] || '',
            vsegoVKor: Number(qty) || 0,
            kolSku: 1,
            spisYach: '',
            client: (state.activeZayavka && state.activeZayavka.client) || '',
            _injectedFromBoxesView: true,
          };
          group.rows.push(newRow);
          state.allRowsFlat.push({ ...newRow, bar5, color: group.color });
          knownRows.add(`${korob}|${barcode}`);
          qtyChanged = true;
          injectedCount++;
        }
      }
      // Шаг 2: обновляем r.qty в существующих rows.
      // allGroups — источник правды для renderCurrentPage.
      for (const g of (state.allGroups || [])) {
        for (const r of (g.rows || [])) applyNewQty(r);
      }
      // allRowsFlat — копии (spread в startZayavka), используются в scan/модалке.
      for (const r of (state.allRowsFlat || [])) applyNewQty(r);
      // shipRowsByBox — копии содержимого ship-коробов (для миксования в модалке).
      for (const rows of Object.values(state.shipRowsByBox || {})) {
        for (const r of rows) applyNewQty(r);
      }
      // visibleRowsFlat — это {...r} копии, сделанные при startZayavka. Они
      // НЕ обновляются автоматически при изменении r.qty в allGroups.
      // renderCanvas читает именно visibleRowsFlat → без rebuild на UI
      // останется старое qty (даже при правильном backend boxesView).
      if (qtyChanged || injectedCount > 0) {
        rebuildVisibleRowsFlat();
        pickedChanged = true; // триггер updateProgress ниже
      }
    }
    // renderCurrentPage → renderPager → pickedByBar5 пересчитается из обновлённого
    // committedPicked → тайлы соседних планшетов окрашиваются. Box-modal (если
    // открыт) остаётся со своим draft — не сбивается, т.к. modal не зависит от
    // renderCurrentPage. cell-num в карточках («СОБРАНО: N») обновляются.
    renderCurrentPage();
    if (pickedChanged) { try { updateProgress(); } catch {} }
  } catch (e) { /* silent */ }
}

function showZayavkaLockedBanner(bdStatus) {
  let banner = document.getElementById('zayavkaLockedBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'zayavkaLockedBanner';
    banner.className = 'locked-banner';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `
    <div class="lb-content">
      <div class="lb-icon">🔒</div>
      <div class="lb-text">
        <b>Заявка завершена</b><br>
        Сборщик: ${escapeHtml(bdStatus.picker || '—')}<br>
        Финиш: ${escapeHtml(bdStatus.statusChangedAt || '—')}<br>
        Правки заблокированы. Вернитесь к списку.
      </div>
      <button type="button" class="btn btn-primary" id="lbBack">К списку</button>
    </div>`;
  banner.classList.remove('hidden');
  document.getElementById('lbBack').onclick = () => { banner.classList.add('hidden'); backToStart(); };
  // Дисейблим основные кнопки на полотне.
  document.querySelectorAll('#zayavkaBar .zb-btn, .row, .modal-overlay button').forEach(el => {
    el.setAttribute('disabled', 'true');
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.4';
  });
}
function startStatePolling() {
  if (_statePollTimer) clearInterval(_statePollTimer);
  _statePollTimer = setInterval(pollSyncState, 10000);
  pollSyncState();
}
function stopStatePolling() {
  if (_statePollTimer) clearInterval(_statePollTimer);
  _statePollTimer = null;
}

// Раскладка для строки источника: показывает ДЕЙСТВИЕ — куда уехал товар.
//   • kolPodb > 0 + kudaPodb → "📦 N → S1547-001" (на отгрузку, имя ship-короба)
//   • kolPerem > 0 + kudaPerem → "🗄️ N → 99_TEST" (в ячейку/перекладка)
//   • если оба заполнены — через "·"
//   • если slot пуст / нет операции → "—"
// title (hover) — расширенная подсказка с остатком.
function renderLayoutBadge(boxId, barcode, qty) {
  const slot = (state.boxLayouts[boxId] || {})[barcode];
  if (!slot) return '<span class="layout-badge layout-empty" title="Действий по строке нет">—</span>';
  // Полное изъятие — проверяем ДО early-return по kolPodb<=0.
  // После absorbtion (committedPicked merge) slot.kolPodb обнуляется,
  // но пометка «изъят целиком» должна остаться видимой — это семантика
  // действия, а не остаток к выгрузке.
  if (slot._fullTake) {
    const target = escapeHtml(String(slot.kudaPodb || '?'));
    return `<span class="layout-badge layout-fulltake" title="Полное изъятие короба → ${target}">⇨ ${target}</span>`;
  }
  const podb = Number(slot.kolPodb) || 0;
  const perem = Number(slot.kolPerem) || 0;
  if (podb <= 0 && perem <= 0) return '<span class="layout-badge layout-empty" title="Действий нет">—</span>';
  const ost = Math.max(0, (Number(qty) || 0) - podb - perem);
  const parts = [];
  if (podb > 0) parts.push(`📦${podb}→${escapeHtml(String(slot.kudaPodb || '?'))}`);
  if (perem > 0) parts.push(`🗄️${perem}→${escapeHtml(String(slot.kudaPerem || '?'))}`);
  const cls = podb > 0 && perem > 0 ? 'layout-mixed'
            : podb > 0 ? 'layout-podb' : 'layout-perem';
  const title = `${podb > 0 ? `${podb} ед. на отгрузку → ${slot.kudaPodb}` : ''}${podb > 0 && perem > 0 ? ' · ' : ''}${perem > 0 ? `${perem} ед. в ячейку → ${slot.kudaPerem}` : ''}${ost > 0 ? ` · остаток ${ost}` : ''}`;
  return `<span class="layout-badge ${cls}" title="${escapeHtml(title)}">${parts.join(' · ')}</span>`;
}

// ========================================================================
// BoxModal — главная сущность UX подбора. Event-delegation pattern.
// ========================================================================
function ensureBoxModalElement() {
  let modal = $('boxModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'boxModal';
  modal.className = 'box-modal-overlay hidden';
  modal.innerHTML = '<div class="box-modal" role="dialog" aria-modal="true"></div>';
  modal.addEventListener('click', handleBoxModalClick);
  modal.addEventListener('input', handleBoxModalInput);
  document.body.appendChild(modal);
  return modal;
}

function handleBoxModalClick(e) {
  // Close on overlay (click on the overlay itself, not children).
  if (e.target.id === 'boxModal') { closeBoxModal(); return; }
  const t = e.target;
  if (t.closest('#bmClose, #bmCancel')) { closeBoxModal(); return; }
  if (t.closest('#bmSave')) { saveBoxModal(); return; }
  if (t.closest('#bmReset')) { onResetAll(); return; }
  const resetBtn = t.closest('button.bc-reset');
  if (resetBtn) { onResetBarcode(resetBtn.dataset.bar); return; }
  const stepBtn = t.closest('button[data-step]');
  if (stepBtn) { onStepClick(stepBtn); return; }
  const suggestBtn = t.closest('button.suggest');
  if (suggestBtn) { onSuggestClick(suggestBtn); return; }
  const tile = t.closest('button.ship-tile');
  if (tile) { onShipTileClick(tile); return; }
  const cellPill = t.closest('button.cs-pill');
  if (cellPill) { onCellPillClick(cellPill); return; }
  const restBtn = t.closest('button[data-action="micro-invent"]');
  if (restBtn) { openMicroInventModal(restBtn.dataset.bar); return; }
  const fullBoxBtn = t.closest('#bmFullBox');
  if (fullBoxBtn) { onFullBoxToggle(); return; }
  const fullBoxTransformBtn = t.closest('#bmFullBoxTransform');
  if (fullBoxTransformBtn) { onFullBoxTransform(); return; }
  if (t.closest('.create-ship-link')) { openCreateBoxesModal(); return; }
}

function onCellPillClick(btn) {
  if (isKorMode()) { korBlockToast(); return; }
  if (isKorPlusMode()) { toast('Перемещение в ячейку запрещено в КОР+.', true); return; }
  const bar = btn.dataset.bar;
  const cell = btn.dataset.cell;
  if (!bar || !cell) return;
  const d = ensureDraftSlot(bar);
  if (!d) return;
  d.kudaPerem = (d.kudaPerem === cell) ? '' : cell;
  renderBoxModal();
}

function handleBoxModalInput(e) {
  const inp = e.target.closest('input[data-slot]');
  if (inp) onSlotInput(inp);
}

function openBoxModal(boxId) {
  const rows = state.allRowsFlat.filter(r => r.korob === boxId);
  if (!rows.length) { toast('Короб не найден', true); return; }
  // Закрепляем initial r.qty в модалке (snapshotQty). Live polling может обновить
  // r.qty в state.allRowsFlat (через boxesView), что приведёт к max=0 для slot
  // inputs/buttons если user уже взял максимум в этой сессии. Modal работает
  // со своим зафиксированным qty — пользователь видит исходное доступное кол-во
  // и может ввести любое значение в его пределах.
  for (const r of rows) {
    if (typeof r._modalSnapshotQty !== 'number') r._modalSnapshotQty = Number(r.qty) || 0;
    else r._modalSnapshotQty = Math.max(r._modalSnapshotQty, Number(r.qty) || 0);
  }
  const saved = state.boxLayouts[boxId] || {};
  const draft = {};
  for (const r of rows) {
    draft[r.barcode] = saved[r.barcode]
      ? { ...saved[r.barcode] }
      : { kolPodb: 0, kudaPodb: '', kolPerem: 0, kudaPerem: '' };
  }
  state.modalBox = { boxId, rows, draft };
  // Обновляем datalist autocomplete (короба + ячейки текущего клиента).
  renderKorobAutocompleteDatalist();

  // В режиме КОР единственное допустимое действие — взять короб целиком.
  // Если короб подходит (все баркоды требуются заявкой и в нужном кол-ве) —
  // автоматически включаем ПОЛН КОРОБ с auto-target. Иначе модалка покажет
  // причину недоступности и ручные правки тоже будут заблокированы.
  if (isKorMode() && !saved.__korApplied) {
    const check = fullBoxAvailable();
    if (check.ok) {
      state.modalBox.fullBoxMode = true;
      state.modalBox.fullBoxTarget = AUTO_KOR_TARGET;
      for (const r of rows) {
        draft[r.barcode].kolPodb = r.qty;
        draft[r.barcode].kolPerem = 0;
        draft[r.barcode].kudaPodb = AUTO_KOR_TARGET;
      }
    }
  }

  renderBoxModal();
  document.body.classList.add('modal-open');
}

function closeBoxModal() {
  // Сбрасываем _modalSnapshotQty в rows этого короба — следующее открытие
  // получит свежий snapshot из текущего state (с учётом live boxesView).
  if (state.modalBox && Array.isArray(state.modalBox.rows)) {
    for (const r of state.modalBox.rows) delete r._modalSnapshotQty;
  }
  state.modalBox = null;
  const m = $('boxModal');
  if (m) m.classList.add('hidden');
  if (!state.modalCreateBoxes) document.body.classList.remove('modal-open');
}

function renderBoxModal() {
  const m = state.modalBox;
  if (!m) return;
  const { boxId, rows, draft } = m;
  const head = rows[0];
  const tariff = computeBoxTariff(rows, draft);
  const totals = computeTotals(rows, draft);
  const violations = checkInvariants(rows, draft);
  const canSave = violations.length === 0;
  const fullBoxCheck = fullBoxAvailable();
  const korBlocked = isKorMode() && !fullBoxCheck.ok;

  let cardsHtml;
  if (korBlocked) {
    // Короб не подходит для КОР: не все баркоды нужны заявке или не хватает кол-ва.
    cardsHtml = `
      <div class="kor-blocked">
        <div class="kor-blocked-title">⛔ Короб не подходит для режима «По коробам»</div>
        <div class="kor-blocked-reason">${escapeHtml(fullBoxCheck.reason)}</div>
        <div class="kor-blocked-hint">Закройте модалку и выберите другой короб. В режиме <b>КОР</b> можно брать только полные короба, чьи баркоды полностью требуются заявкой.</div>
      </div>`;
  } else if (m.fullBoxMode) {
    cardsHtml = renderFullBoxBody(rows, draft);
  } else {
    cardsHtml = rows.map(r => renderBarcodeCard(r, draft[r.barcode])).join('');
  }

  const tariffHtml = tariff.kind === 'free'
    ? '<span class="bm-tariff bm-free">🆓 Бесплатный</span>'
    : tariff.kind === 'paid'
      ? `<span class="bm-tariff bm-paid">💰 Штучный · ${tariff.charge}₽</span>`
      : '<span class="bm-tariff bm-idle">— Не разложен</span>';

  // Кнопка «Изъять короб целиком» — трансформация исходных строк в коробы
  // отгрузки прямо на месте, без создания нового короба отгрузки.
  // (Сценарий B в SCENARIOS.md.)
  const fullBoxBtnHtml = `<button type="button" id="bmFullBoxTransform"
        class="bm-fullbox-btn${fullBoxCheck.ok ? '' : ' disabled'}"
        ${fullBoxCheck.ok ? '' : `disabled title="${escapeHtml(fullBoxCheck.reason)}"`}>
        🔄 Изъять короб целиком
      </button>`;

  const html = `
    <div class="box-modal-header">
      <div class="bm-title">
        <span class="bm-korob">📦 ${escapeHtml(boxId)}</span>
        <span class="badge ${STATUS_CLASS[String(head.status).trim().toUpperCase()] || 'badge-other'}">${escapeHtml(head.status)}</span>
        <span class="bm-meta">Тара: <b>${escapeHtml(head.tara)}</b></span>
        <span class="bm-meta">Адрес: <b>${escapeHtml(head.adr || '—')}</b></span>
      </div>
      <div class="bm-tariff-wrap">${tariffHtml}${fullBoxBtnHtml}</div>
      <button type="button" class="bm-close" id="bmClose" title="Закрыть (Esc)">✕</button>
    </div>
    <div class="box-modal-body">${cardsHtml}</div>
    <div class="box-modal-footer">
      <div class="bm-totals">
        <span class="bm-tot bm-tot-ship">📦 На отгрузку: <b>${totals.toShip}</b></span>
        <span class="bm-tot bm-tot-cell">🗄️ В ячейки: <b>${totals.toCell}</b></span>
        <span class="bm-tot bm-tot-rest">Остаток: <b>${totals.remaining}</b></span>
      </div>
      ${violations.length ? `<div class="bm-violations">${violations.map(v => `<div>⚠ ${escapeHtml(v)}</div>`).join('')}</div>` : ''}
      <div class="bm-actions">
        <button type="button" class="btn btn-ghost" id="bmReset" ${anyLayout(rows, draft, m) ? '' : 'disabled'}
                title="Сбросить раскладку всего короба">↺ Сбросить короб</button>
        <div class="bm-actions-right">
          <button type="button" class="btn btn-secondary" id="bmCancel">Отмена</button>
          <button type="button" class="btn btn-primary" id="bmSave" ${canSave ? '' : 'disabled'}>Сохранить</button>
        </div>
      </div>
    </div>
  `;

  const modal = ensureBoxModalElement();
  modal.classList.remove('hidden');
  modal.querySelector('.box-modal').innerHTML = html;
}

function renderFullBoxBody(rows, draft) {
  const summaryRows = rows.map(r => {
    const requested = requestedFor(r.barcode);
    return `<tr>
      <td><b>${escapeHtml(String(r.barcode).slice(-5))}</b></td>
      <td>${escapeHtml(r.sku || '')}</td>
      <td class="num">${r.qty}</td>
      <td class="num">${requested}</td>
    </tr>`;
  }).join('');
  // В КОР целевой короб назначается автоматически при finalize (один-к-одному
  // от исходного K-короба). В СВОБ полный короб уезжает на отгрузку «как есть»
  // — номер исходного короба сохраняется, отдельный S-короб не выбирается.
  const targetBlock = isKorMode()
    ? `<div class="full-box-target full-box-auto">
        <span class="kor-auto-icon">🤖</span>
        <span class="kor-auto-text">Короб отгрузки назначается автоматически при завершении заявки</span>
      </div>`
    : `<div class="full-box-target full-box-keep">
        <span class="kor-auto-icon">📦</span>
        <span class="kor-auto-text">Короб <b>${escapeHtml(state.modalBox.boxId)}</b> уходит на отгрузку целиком — номер сохраняется</span>
      </div>`;
  return `
    <div class="full-box-info">
      <div class="full-box-explain">
        Весь короб (${rows.length} ${pluralStrok(rows.length)}, всего <b>${rows.reduce((s, r) => s + r.qty, 0)} шт</b>)
        отгружается целиком.
      </div>
      <table class="full-box-summary">
        <thead><tr><th>BAR5</th><th>SKU</th><th class="num">КОЛ</th><th class="num">Заявка</th></tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      ${targetBlock}
    </div>`;
}

function renderBarcodeCard(r, slot) {
  const requested = requestedFor(r.barcode);
  const picked = pickedByBarcode(r.barcode);
  const still = Math.max(0, requested - picked);
  // qtyForModal = snapshot qty при открытии модалки (см. openBoxModal).
  // Live polling не должен уменьшать max в модалке — пользователь работает
  // с тем что увидел при открытии.
  const qtyForModal = r._modalSnapshotQty ?? r.qty;
  const ost = Math.max(0, qtyForModal - (Number(slot.kolPodb) || 0) - (Number(slot.kolPerem) || 0));
  const reqHtml = requested > 0
    ? `<span class="bc-req">Заявка: Н <b>${requested}</b> · С <b>${picked}</b> · Ещё <b>${still}</b></span>`
    : '<span class="bc-req bc-no-req">Не в заявке</span>';
  const hasAny = (Number(slot.kolPodb) || 0) > 0
    || (Number(slot.kolPerem) || 0) > 0
    || !!slot.kudaPodb || !!slot.kudaPerem;
  const resetBtn = hasAny
    ? `<button type="button" class="bc-reset" data-bar="${escapeHtml(r.barcode)}" title="Сбросить раскладку этого баркода">✕</button>`
    : '';
  return `
    <article class="barcode-card${requested > 0 ? ' is-requested' : ''}" data-barcode="${escapeHtml(r.barcode)}">
      ${resetBtn}
      <header class="bc-head">
        <div class="bc-bar">
          <span class="bc-bar5">${escapeHtml(String(r.barcode).slice(-5))}</span>
          <span class="bc-bar-full">${escapeHtml(r.barcode)}</span>
        </div>
        <div class="bc-sku">${escapeHtml(r.sku || '')}</div>
        <div class="bc-qty">КОЛ: <b>${qtyForModal}</b></div>
        ${reqHtml}
      </header>
      <div class="bc-slots">
        ${renderSlotPodb(r.barcode, slot, qtyForModal, requested, picked)}
        ${renderSlotPerem(r.barcode, slot, qtyForModal, r.spisYach)}
        <button type="button" class="bc-slot bc-slot-rest" data-bar="${escapeHtml(r.barcode)}" data-action="micro-invent" title="Уточнить КОЛ (микро-инвент)">
          <label>Остаток</label>
          <div class="rest-value">${ost}</div>
          <div class="rest-hint">✏ уточнить</div>
        </button>
      </div>
    </article>`;
}

function renderSlotPodb(barcode, slot, max, requested, picked) {
  const kol = Number(slot.kolPodb) || 0;
  const kuda = String(slot.kudaPodb || '');
  const suggestion = (requested > 0) ? Math.min(max, Math.max(0, requested - picked)) : 0;
  const suggestionBtn = suggestion > 0
    ? `<button type="button" class="suggest" data-bar="${escapeHtml(barcode)}" data-slot="podb" data-amount="${suggestion}" title="Заполнить нужное">${suggestion}</button>`
    : '';
  return `
    <div class="bc-slot bc-slot-podb">
      <label>📦 На отгрузку</label>
      <div class="slot-body">
        <div class="num-row">
          <button type="button" class="num-btn" data-step="-1" data-bar="${escapeHtml(barcode)}" data-slot="podb" aria-label="−1">−</button>
          <input type="number" min="0" max="${max}" step="1" value="${kol}"
                 data-bar="${escapeHtml(barcode)}" data-slot="podb" inputmode="numeric">
          <button type="button" class="num-btn" data-step="1" data-bar="${escapeHtml(barcode)}" data-slot="podb" aria-label="+1">+</button>
          ${suggestionBtn}
        </div>
        ${renderShipTiles(barcode, kuda)}
      </div>
    </div>`;
}

function renderSlotPerem(barcode, slot, max, spisYach) {
  const kol = Number(slot.kolPerem) || 0;
  const kuda = String(slot.kudaPerem || '');
  // Подсказка: ячейки клиента, где этот баркод уже лежит. Tap → подставить.
  const cells = String(spisYach || '').split('\n').map(s => s.trim()).filter(Boolean);
  const cellsHtml = cells.length
    ? `<div class="cell-suggest"><span class="cs-label">Уже лежит в:</span>${
        cells.map(c =>
          `<button type="button" class="cs-pill${c === kuda ? ' selected' : ''}"
            data-bar="${escapeHtml(barcode)}" data-cell="${escapeHtml(c)}">${escapeHtml(c)}</button>`
        ).join('')
      }</div>`
    : '';
  return `
    <div class="bc-slot bc-slot-perem">
      <label>📤 Переместить (ячейка/короб)</label>
      <div class="slot-body">
        <div class="num-row">
          <button type="button" class="num-btn" data-step="-1" data-bar="${escapeHtml(barcode)}" data-slot="perem" aria-label="−1">−</button>
          <input type="number" min="0" max="${max}" step="1" value="${kol}"
                 data-bar="${escapeHtml(barcode)}" data-slot="perem" inputmode="numeric">
          <button type="button" class="num-btn" data-step="1" data-bar="${escapeHtml(barcode)}" data-slot="perem" aria-label="+1">+</button>
        </div>
        <input type="text" class="slot-target" placeholder="код ячейки/короба или скан QR"
               value="${escapeHtml(kuda)}"
               list="korobAutocomplete"
               autocomplete="off"
               data-bar="${escapeHtml(barcode)}" data-slot="perem-kuda">
        ${cellsHtml}
      </div>
    </div>`;
}

// Общий datalist для autocomplete поля «куда переложить» — собирает уникальные
// номера ячеек и коробов клиента из state.allRowsFlat (исключая уже завершённые
// по статусу). Datalist встраивается в DOM один раз и обновляется при каждом
// открытии box modal.
function renderKorobAutocompleteDatalist() {
  let dl = document.getElementById('korobAutocomplete');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'korobAutocomplete';
    document.body.appendChild(dl);
  }
  const seen = new Map(); // korob → { tara, qty, barcode }
  for (const r of (state.allRowsFlat || [])) {
    if (!r.korob) continue;
    const status = String(r.status || '').toUpperCase();
    if (['СОБРАНО', 'ОТГРУЖЕНО', 'ИЗЪЯТО'].includes(status)) continue;
    if (!seen.has(r.korob)) seen.set(r.korob, { tara: r.tara || '', qty: r.qty || 0, barcode: r.barcode || '' });
  }
  // Также добавим виртуальные ship-box (созданные но ещё пустые).
  for (const sb of (state.shipBoxes || [])) {
    if (sb.number && !seen.has(sb.number)) seen.set(sb.number, { tara: sb.taraType || '', qty: 0, barcode: '' });
  }
  const sorted = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  dl.innerHTML = sorted.map(([korob, info]) => {
    const taraLabel = info.tara === 'ЯЧ' ? '🗄️ ячейка' : '📦 короб';
    const qtyLabel = info.qty > 0 ? `, ${info.qty} ед.` : '';
    return `<option value="${korob.replace(/"/g, '&quot;')}">${taraLabel}${qtyLabel}</option>`;
  }).join('');
}

function renderShipTiles(barcode, selectedNumber) {
  // Кнопка «+» — быстрое создание короба отгрузки прямо из карточки баркода.
  // С дефолтами 60×40×40 ФФ. После создания тайл сразу появится в ряду.
  const plusTile = `<button type="button" class="ship-tile ship-tile-plus" data-bar="${escapeHtml(barcode)}" data-ship-plus="1" title="Быстро создать ещё короб (60×40×40, ФФ)">
    <span class="st-num">+</span>
  </button>`;
  if (state.shipBoxes.length === 0) {
    return `<div class="ship-tiles">${plusTile}</div>
      <div class="ship-hint">Нажмите + чтобы создать первый короб отгрузки.</div>`;
  }
  const tiles = state.shipBoxes.map(b => {
    const isSel = b.number === selectedNumber;
    return `<button type="button" class="ship-tile${isSel ? ' selected' : ''}"
      data-bar="${escapeHtml(barcode)}" data-ship-number="${escapeHtml(b.number)}"
      title="${escapeHtml(b.number)} · ${escapeHtml(b.taraType)}">
      <span class="st-num">${b.short}</span>
    </button>`;
  }).join('');
  const fullName = selectedNumber ? `<div class="ship-selected-name">→ <b>${escapeHtml(selectedNumber)}</b></div>` : '';
  return `<div class="ship-tiles">${tiles}${plusTile}</div>${fullName}`;
}

function computeTotals(rows, draft) {
  let toShip = 0, toCell = 0, remaining = 0;
  for (const r of rows) {
    const s = draft[r.barcode] || {};
    const podb = Number(s.kolPodb) || 0;
    const perem = Number(s.kolPerem) || 0;
    toShip += podb;
    toCell += perem;
    remaining += Math.max(0, r.qty - podb - perem);
  }
  return { toShip, toCell, remaining };
}

function computeBoxTariff(rows, draft) {
  const t = computeTotals(rows, draft);
  if (t.toShip === 0 && t.toCell === 0 && t.remaining === 0) return { kind: 'idle' };
  if (t.toCell === 0 && t.remaining === 0 && t.toShip > 0) return { kind: 'free' };
  return { kind: 'paid', charge: t.toShip * 10 };
}

function checkInvariants(rows, draft) {
  const errors = [];
  for (const r of rows) {
    const s = draft[r.barcode] || {};
    const podb = Number(s.kolPodb) || 0;
    const perem = Number(s.kolPerem) || 0;
    if (podb + perem > r.qty) {
      errors.push(`${String(r.barcode).slice(-5)}: ${podb}+${perem} > ${r.qty} (превышение, нужен микро-инвент)`);
    }
    if (podb > 0 && !s.kudaPodb) {
      errors.push(`${String(r.barcode).slice(-5)}: указано ${podb} на отгрузку, но не выбран короб`);
    }
    if (perem > 0 && !s.kudaPerem) {
      errors.push(`${String(r.barcode).slice(-5)}: указано ${perem} в ячейку, но не выбрана ячейка`);
    }
  }
  return errors;
}

function ensureDraftSlot(bar) {
  if (!state.modalBox) return null;
  const draft = state.modalBox.draft;
  if (!draft[bar]) draft[bar] = { kolPodb: 0, kudaPodb: '', kolPerem: 0, kudaPerem: '' };
  return draft[bar];
}

// Rerender modal, восстанавливая фокус + позицию курсора в активном input.
// Используется в onSlotInput для всех типов slot (включая podb-kuda/perem-kuda),
// чтобы:
//   - save button enable/disable обновлялся при изменении draft (баг "ввёл
//     ячейку — кнопка осталась disabled, не могу сохранить").
//   - totals/бэйджи обновлялись live.
//   - При этом курсор не сбивался при печати в input (баг "набрал 2 → хотел
//     20, клавиатура сбросилась").
function renderBoxModalPreservingFocus() {
  const focused = document.activeElement;
  let focusInfo = null;
  if (focused && focused.tagName === 'INPUT' && focused.dataset && focused.dataset.bar) {
    try {
      focusInfo = {
        bar: focused.dataset.bar,
        slot: focused.dataset.slot,
        start: focused.selectionStart,
        end: focused.selectionEnd,
      };
    } catch { focusInfo = null; }
  }
  renderBoxModal();
  if (focusInfo) {
    const modalEl = document.getElementById('boxModal');
    if (!modalEl) return;
    const sel = `input[data-bar="${CSS.escape(focusInfo.bar)}"][data-slot="${CSS.escape(focusInfo.slot)}"]`;
    const newInput = modalEl.querySelector(sel);
    if (newInput) {
      newInput.focus();
      // setSelectionRange работает только для text/search/tel/url/password.
      // Number input — НЕ поддерживает; пытаемся, при ошибке игнорируем.
      try {
        if (typeof newInput.setSelectionRange === 'function'
            && newInput.type !== 'number'
            && focusInfo.start != null) {
          newInput.setSelectionRange(focusInfo.start, focusInfo.end);
        }
      } catch {}
    }
  }
}

function onSlotInput(inp) {
  if (isKorMode()) { korBlockToast(); renderBoxModalPreservingFocus(); return; }
  const bar = inp.dataset.bar;
  const slot = inp.dataset.slot;
  if (!bar || !slot) return;
  if (noPeremMode() && (slot === 'perem' || slot === 'perem-kuda')) {
    toast('Перемещение в ячейку запрещено в этом режиме сборки (КОР / КОР+).', true);
    renderBoxModalPreservingFocus();
    return;
  }
  const d = ensureDraftSlot(bar);
  if (!d) return;
  if (slot === 'podb-kuda') { d.kudaPodb = String(inp.value || ''); renderBoxModalPreservingFocus(); return; }
  if (slot === 'perem-kuda') { d.kudaPerem = String(inp.value || ''); renderBoxModalPreservingFocus(); return; }
  if (slot === 'podb') {
    const newVal = clampQty(Number(inp.value), bar);
    const row = state.modalBox.rows.find(r => r.barcode === bar);
    if (row && newVal > 0 && newVal < row.qty) {
      const check = korPlusCanPartial(row);
      if (!check.ok) { toast(check.reason, true); renderBoxModalPreservingFocus(); return; }
    }
    d.kolPodb = newVal;
  }
  else if (slot === 'perem') d.kolPerem = clampQty(Number(inp.value), bar);
  renderBoxModalPreservingFocus();
}

function clampQty(n, bar) {
  if (!Number.isFinite(n) || n < 0) return 0;
  const row = state.modalBox && state.modalBox.rows.find(r => r.barcode === bar);
  // Используем snapshot момента открытия модалки — это исходное qty в коробе
  // ДО локальных операций пользователя. Live polling может уменьшить r.qty,
  // но пользователь работает с тем что он видел при открытии.
  const max = row ? (row._modalSnapshotQty ?? row.qty) : 0;
  return Math.min(max, n);
}

function onStepClick(btn) {
  if (isKorMode()) { korBlockToast(); return; }
  const bar = btn.dataset.bar;
  const slot = btn.dataset.slot;
  const step = Number(btn.dataset.step) || 0;
  if (!bar || !slot || !step) return;
  if (noPeremMode() && slot === 'perem') {
    toast('Перемещение в ячейку запрещено в этом режиме сборки.', true);
    return;
  }
  const d = ensureDraftSlot(bar);
  if (!d) return;
  const row = state.modalBox.rows.find(r => r.barcode === bar);
  // Используем snapshot — см. clampQty.
  const max = row ? (row._modalSnapshotQty ?? row.qty) : 0;
  if (slot === 'podb') {
    const newVal = Math.max(0, Math.min(max, (d.kolPodb || 0) + step));
    if (row && newVal > 0 && newVal < row.qty) {
      const check = korPlusCanPartial(row);
      if (!check.ok) { toast(check.reason, true); return; }
    }
    d.kolPodb = newVal;
  }
  else if (slot === 'perem') d.kolPerem = Math.max(0, Math.min(max, (d.kolPerem || 0) + step));
  renderBoxModal();
}

function onSuggestClick(btn) {
  if (isKorMode()) { korBlockToast(); return; }
  const bar = btn.dataset.bar;
  const slot = btn.dataset.slot;
  const amount = Number(btn.dataset.amount) || 0;
  if (noPeremMode() && slot === 'perem') {
    toast('Перемещение в ячейку запрещено в этом режиме сборки.', true);
    return;
  }
  const d = ensureDraftSlot(bar);
  if (!d) return;
  if (slot === 'podb') {
    const row = state.modalBox.rows.find(r => r.barcode === bar);
    if (row && amount > 0 && amount < row.qty) {
      const check = korPlusCanPartial(row);
      if (!check.ok) { toast(check.reason, true); return; }
    }
    d.kolPodb = amount;
  }
  else if (slot === 'perem') d.kolPerem = amount;
  renderBoxModal();
}

function onShipTileClick(btn) {
  // Кнопка «+» — открывает стандартную модалку создания короба
  // (с параметрами тары/габаритов/владельца). НЕ быстрое создание.
  if (btn.dataset.shipPlus === '1') {
    openCreateBoxesModal();
    return;
  }
  if (isKorMode()) { korBlockToast(); return; }
  const bar = btn.dataset.bar;
  const number = btn.dataset.shipNumber;
  if (!bar || !number) return;
  const d = ensureDraftSlot(bar);
  if (!d) return;
  if (d.kudaPodb === number) d.kudaPodb = '';
  else d.kudaPodb = number;
  renderBoxModal();
}

// Трансформация исходного короба → строки отгрузки (сценарий B).
// Не создаёт новых строк, не меняет КОЛ. Меняет E/F/M/N/R/X.
async function onFullBoxTransform() {
  const m = state.modalBox;
  if (!m) return;
  const z = state.activeZayavka;
  if (!z) return;
  // Защита: если есть текущий draft с правками — предупредить через нашу модалку.
  let hasDraft = false;
  for (const slot of Object.values(m.draft || {})) {
    if ((Number(slot.kolPodb) || 0) > 0 || (Number(slot.kolPerem) || 0) > 0) { hasDraft = true; break; }
  }
  if (!ensureWorkStarted()) return;
  if (hasDraft) {
    const ok = await showOwnerModal({
      title: 'В коробе есть незавершённая раскладка',
      message: 'Изъять короб целиком? Текущая раскладка будет проигнорирована. Выберите владельца тары:',
    });
    if (!ok) return;
    return doFullBoxTransform(m, ok);
  }
  const owner = await showOwnerModal({
    title: `Изъять короб целиком: ${m.boxId}`,
    message: 'Чья тара? Это записывается в КОММЕНТАРИЙ короба.',
  });
  if (!owner) return;
  return doFullBoxTransform(m, owner);
}

// Замена первой буквы префикса короба на 'S' — то же что и backend
// (sync-engine.js renameToShipPrefix). Используется при full_to_ship для
// optimistic-имени нового ship-короба.
function renameToShipPrefix(korobName) {
  const s = String(korobName || '');
  if (!s || /^[Ss]/.test(s)) return s;
  if (!/^[A-Za-zА-Яа-я]/.test(s)) return s;
  return 'S' + s.slice(1);
}

function doFullBoxTransform(m, owner) {
  const sourceBox = m.boxId;
  const shipBox = renameToShipPrefix(sourceBox);

  // ВАЖНО: m.rows — это refs на объекты из state.allRowsFlat (см. openBoxModal
  // line 1481: state.allRowsFlat.filter(...) возвращает refs, не copies).
  // Поэтому СПЕРВА фиксируем qty в локальном snapshot ДО обнуления — иначе
  // после обнуления state.allRowsFlat все qty в m.rows тоже станут 0,
  // и newShipRows получится пустым.
  const rowsSnapshot = (m.rows || []).map(r => ({
    barcode: String(r.barcode || ''),
    qty: Number(r.qty) || 0,
    tip: r.tip || 'ПТ ГОТОВ',
    sku: r.sku || '',
    mp: r.mp || '',
    client: r.client || '',
    tara: r.tara || 'К_1.0',
  }));

  // Локально отметим, что весь короб «изъят целиком» → в ship-короб.
  // kudaPodb = shipBox (а НЕ sourceBox) — это правильный таргет, нужен
  // и для renderLayoutBadge, и для reverse-lookup в renderShipBoxesSection
  // (поиск sources по kudaPodb === boxNum).
  const localLayout = {};
  for (const r of rowsSnapshot) {
    localLayout[r.barcode] = {
      kolPodb: r.qty,
      kudaPodb: shipBox,
      kolPerem: 0,
      kudaPerem: '',
      _fullTake: true, // флаг для renderLayoutBadge → метка «полное изъятие»
    };
  }
  state.boxLayouts[sourceBox] = localLayout;

  // Optimistic update: обнулить qty всех source-строк короба в state.allGroups
  // и state.allRowsFlat (как saveBoxModal). Без этого в колонках КОЛ/ВСЕ/SKU
  // полотна отображается пусто/stale значение.
  for (const g of (state.allGroups || [])) {
    for (const gr of (g.rows || [])) {
      if (gr.korob === sourceBox) gr.qty = 0;
    }
  }
  for (const r of (state.allRowsFlat || [])) {
    if (r.korob === sourceBox && !r.isShip) r.qty = 0;
  }

  // Optimistic: добавить новый ship-короб в shipRowsByBox (нижний/верхний
  // блок будут видеть его сразу до подтверждения backend'ом).
  if (!state.shipRowsByBox) state.shipRowsByBox = {};
  const newShipRows = rowsSnapshot
    .filter(r => r.qty > 0)
    .map(r => ({
      tip: r.tip,
      sku: r.sku,
      mp: r.mp,
      client: r.client,
      vsegoVKor: 0,
      spisYach: '',
      tara: r.tara,
      status: 'В СБОРКЕ',
      korob: shipBox,
      kolSku: 0,
      barcode: r.barcode,
      bar5: r.barcode.slice(-5),
      adr: '',
      qty: r.qty,
      _optimistic: true,
    }));
  if (newShipRows.length > 0) {
    const totalQty = newShipRows.reduce((s, r) => s + r.qty, 0);
    const uniqueBars = new Set(newShipRows.map(r => r.barcode));
    for (const r of newShipRows) {
      r.vsegoVKor = totalQty;
      r.kolSku = uniqueBars.size;
    }
    state.shipRowsByBox[shipBox] = newShipRows;
    // Добавим строки и в allRowsFlat (помечены isShip=true) — для
    // computeBoxTotals и openBoxModal (миксование в новый ship-короб).
    for (const r of newShipRows) {
      state.allRowsFlat.push({ ...r, isShip: true });
    }
  }

  markBoxSync(sourceBox, 'yellow');
  SyncQueue.push({
    type: 'box.full_to_ship',
    boxId: sourceBox,
    owner,
  });

  if (typeof rebuildVisibleRowsFlat === 'function') rebuildVisibleRowsFlat();
  toast(`Короб ${sourceBox} → ${shipBox} (${owner}). Изменения уйдут на лист в течение 2 мин.`);
  closeBoxModal();
  renderCurrentPage();
  updateProgress();
}

async function saveBoxModal() {
  if (!state.modalBox) return;
  const { boxId, draft } = state.modalBox;
  // Если в draft нет ни одного ненулевого значения — ничего не отправляем,
  // просто закрываем модалку. Иначе бесполезный атом улетает в очередь.
  let hasChanges = false;
  for (const slot of Object.values(draft || {})) {
    if ((Number(slot.kolPodb) || 0) > 0 || (Number(slot.kolPerem) || 0) > 0) {
      hasChanges = true;
      break;
    }
  }
  if (!hasChanges) {
    closeBoxModal();
    return;
  }
  if (!ensureWorkStarted()) return;
  state.boxLayouts[boxId] = JSON.parse(JSON.stringify(draft));
  markBoxSync(boxId, 'yellow');
  // Optimistic update: мгновенно вычесть kolPodb+kolPerem из source row.
  // ВАЖНО: state.modalBox.rows — это копии из state.allRowsFlat (которые
  // сами копии при startZayavka), НЕ ссылки на state.allGroups.rows.
  // rebuildVisibleRowsFlat читает из state.allGroups, поэтому обновлять
  // нужно ТАМ. Иначе render продолжит показывать stale qty (баг "6 как
  // было, так и осталось" после save).
  const m = state.modalBox;
  if (m && Array.isArray(m.rows)) {
    for (const r of m.rows) {
      const slot = draft[r.barcode];
      if (!slot) continue;
      const consumed = (Number(slot.kolPodb) || 0) + (Number(slot.kolPerem) || 0);
      const baseline = (typeof r._modalSnapshotQty === 'number') ? r._modalSnapshotQty : Number(r.qty) || 0;
      const newQty = Math.max(0, baseline - consumed);
      r.qty = newQty;
      // Также обновляем соответствующий row в state.allGroups (источник
      // правды для rebuildVisibleRowsFlat → renderCanvas).
      const targetKorob = r.korob;
      const targetBarcode = String(r.barcode);
      for (const g of (state.allGroups || [])) {
        for (const gr of (g.rows || [])) {
          if (gr.korob === targetKorob && String(gr.barcode) === targetBarcode) {
            gr.qty = newQty;
          }
        }
      }
    }
  }
  // Optimistic: добавить kolPodb→kudaPodb в shipRowsByBox чтобы новый ship-короб
  // мгновенно отобразился в верхнем блоке «📦 короба отгрузки» (Bug A). Если
  // kudaPodb — адрес ячейки (XX_XX), это НЕ ship-короб — не трогаем.
  // kudaPerem всегда направлено в ячейку, поэтому shipRowsByBox не касается.
  if (!state.shipRowsByBox) state.shipRowsByBox = {};
  if (m && Array.isArray(m.rows)) {
    for (const r of m.rows) {
      const slot = draft[r.barcode];
      if (!slot) continue;
      const kolPodb = Number(slot.kolPodb) || 0;
      const kudaPodb = String(slot.kudaPodb || '');
      if (kolPodb <= 0 || !kudaPodb) continue;
      // Пропускаем адреса ячеек XX_XX — это не ship-короб.
      if (/^\d{2}_\d{2}$/.test(kudaPodb)) continue;
      // Уже существующий ship-короб (создан через ship.create или загружен из листа)?
      // Если есть запись для kudaPodb — прибавим qty к строке с тем же barcode
      // (или вставим новую). Иначе создадим новый массив.
      const existingRows = state.shipRowsByBox[kudaPodb];
      // Определяем дефолтную tara из state.shipBoxes (если короб был создан явно).
      let defaultTara = 'К_1.0';
      const sb = (state.shipBoxes || []).find(x => x.number === kudaPodb);
      if (sb) defaultTara = sb.tara || sb.taraType || 'К_1.0';
      else if (existingRows && existingRows[0] && existingRows[0].tara) defaultTara = existingRows[0].tara;
      const newRowTemplate = {
        tip: r.tip || 'ПТ ГОТОВ',
        sku: r.sku || '',
        mp: r.mp || '',
        client: r.client || '',
        vsegoVKor: 0, // пересчитаем ниже
        spisYach: '',
        tara: defaultTara,
        status: 'В СБОРКЕ',
        korob: kudaPodb,
        kolSku: 0,
        barcode: r.barcode,
        bar5: String(r.barcode).slice(-5),
        adr: '',
        qty: kolPodb,
        _optimistic: true,
      };
      if (Array.isArray(existingRows)) {
        const sameBarRow = existingRows.find(x => String(x.barcode) === String(r.barcode));
        if (sameBarRow) {
          sameBarRow.qty = (Number(sameBarRow.qty) || 0) + kolPodb;
          if (!sameBarRow.tip && r.tip) sameBarRow.tip = r.tip;
        } else {
          existingRows.push(newRowTemplate);
        }
      } else {
        state.shipRowsByBox[kudaPodb] = [newRowTemplate];
      }
      // Пересчитаем vsegoVKor / kolSku для всего короба.
      const allRows = state.shipRowsByBox[kudaPodb];
      const totalQ = allRows.reduce((s, x) => s + (Number(x.qty) || 0), 0);
      const uniqBars = new Set(allRows.filter(x => (Number(x.qty) || 0) > 0).map(x => String(x.barcode)));
      for (const x of allRows) {
        x.vsegoVKor = totalQ;
        x.kolSku = uniqBars.size;
      }
      // Зеркалим в allRowsFlat (isShip=true) — для миксования в новый ship-короб
      // и computeBoxTotals. Если строки с тем же korob+barcode уже нет — пушим.
      const existsInFlat = (state.allRowsFlat || []).find(x => x.isShip && x.korob === kudaPodb && String(x.barcode) === String(r.barcode));
      if (existsInFlat) {
        existsInFlat.qty = (Number(existsInFlat.qty) || 0) + kolPodb;
      } else {
        state.allRowsFlat.push({ ...newRowTemplate, isShip: true });
      }
    }
  }
  // rebuildVisibleRowsFlat: пересобирает visibleRowsFlat из allGroups
  // с обновлёнными qty. renderCurrentPage потом покажет новые значения.
  if (typeof rebuildVisibleRowsFlat === 'function') rebuildVisibleRowsFlat();
  SyncQueue.push({ type: 'box.set_layout', boxId, barcodes: draft });
  toast(`Короб ${boxId} — раскладка сохранена`);
  closeBoxModal();
  renderCurrentPage();
  updateProgress();
}

// ========================================================================
// CreateBoxesModal — создание коробов отгрузки батчем
// ========================================================================
function ensureCreateBoxesElement() {
  let modal = $('createBoxesModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'createBoxesModal';
  modal.className = 'cbm-overlay hidden';
  modal.innerHTML = '<div class="cbm-dialog" role="dialog" aria-modal="true"></div>';
  modal.addEventListener('click', handleCreateBoxesClick);
  modal.addEventListener('input', handleCreateBoxesInput);
  document.body.appendChild(modal);
  return modal;
}

function handleCreateBoxesClick(e) {
  if (e.target.id === 'createBoxesModal') { closeCreateBoxesModal(); return; }
  const t = e.target;
  if (t.closest('#cbmClose, #cbmCancel')) { closeCreateBoxesModal(); return; }
  if (t.closest('#cbmSubmit')) { submitCreateBoxes(); return; }
  if (t.closest('#cbmPrint')) { printShipLabels(); return; }
  const delBtn = t.closest('button.cbm-del');
  if (delBtn) { deleteShipBox(delBtn.dataset.cbmDel); return; }
  const btnCnt = t.closest('button[data-cbm-count]');
  if (btnCnt) {
    const n = Number(btnCnt.dataset.cbmCount);
    if (state.modalCreateBoxes) state.modalCreateBoxes.count = n;
    renderCreateBoxesModal();
    return;
  }
  const btnQuickAdd = t.closest('button[data-cbm-quick-add]');
  if (btnQuickAdd) { quickAddShipBox(); return; }
  // Клик на строку короба отгрузки → открыть box modal (миксование).
  // Не реагируем если кликнули по 🗑-кнопке удаления.
  const rowOpen = t.closest('[data-cbm-open]');
  if (rowOpen && !t.closest('.cbm-del')) {
    const num = rowOpen.dataset.cbmOpen;
    const inBox = (state.shipRowsByBox && state.shipRowsByBox[num]) || [];
    if (inBox.length === 0) {
      toast(`Короб ${num} ещё пустой — нечего перепаковывать`, false);
      return;
    }
    closeCreateBoxesModal();
    openBoxModal(num);
    return;
  }
  const btnSize = t.closest('button[data-cbm-size]');
  if (btnSize) {
    if (state.modalCreateBoxes) state.modalCreateBoxes.sizeMode = btnSize.dataset.cbmSize;
    renderCreateBoxesModal();
    return;
  }
  const btnOwner = t.closest('button[data-cbm-owner]');
  if (btnOwner) {
    if (state.modalCreateBoxes) state.modalCreateBoxes.owner = btnOwner.dataset.cbmOwner;
    renderCreateBoxesModal();
    return;
  }
  const btnStep = t.closest('button[data-cbm-step]');
  if (btnStep) {
    const step = Number(btnStep.dataset.cbmStep) || 0;
    if (state.modalCreateBoxes) {
      state.modalCreateBoxes.count = Math.max(1, Math.min(200, (state.modalCreateBoxes.count || 1) + step));
    }
    renderCreateBoxesModal();
    return;
  }
}

// Какие коробы отгрузки уже использованы в раскладках (kudaPodb).
function shipBoxUsedSet() {
  const used = new Set();
  for (const layout of Object.values(state.boxLayouts)) {
    for (const slot of Object.values(layout)) {
      if (slot.kudaPodb) used.add(slot.kudaPodb);
    }
  }
  return used;
}

function printShipLabels() {
  const z = state.activeZayavka;
  if (!z) return;
  const url = '/api/podbor/ship-labels?zayavka=' + encodeURIComponent(z.number);
  const win = window.open(url, '_blank', 'width=720,height=900');
  if (!win) toast('Браузер блокирует открытие окна — разрешите popup для печати', true);
}

// Optimistic delete: убираем из стейта мгновенно, fetch в фоне.
// Несколько кликов подряд складываются в очередь без блокировки UI.
function deleteShipBox(number) {
  if (!number || !state.activeZayavka) return;
  const used = shipBoxUsedSet();
  if (used.has(number)) {
    toast(`Короб ${number} уже используется в раскладке — удалить нельзя`, true);
    return;
  }
  if (!ensureWorkStarted()) return;
  // Снапшот для отката при сбое.
  const prev = state.shipBoxes.slice();
  state.shipBoxes = state.shipBoxes.filter(b => b.number !== number);
  renderCreateBoxesModal();
  renderZayavkaBar();
  if (state.modalBox) renderBoxModal();
  // Fire-and-forget POST. Очередь сериализуется на бэке через единый mutex.
  fetch('/api/podbor/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSyncBody(
      [{ type: 'ship.delete', zayavkaId: state.activeZayavka.number, number }],
      state.activeZayavka
    ))
  }).then(async res => {
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const result = (data.results && data.results[0]) || {};
    if (!result.ok) throw new Error(result.error || 'unknown');
  }).catch(e => {
    state.shipBoxes = prev;
    renderCreateBoxesModal();
    renderZayavkaBar();
    toast(`Не удалось удалить ${number}: ${e.message}`, true);
  });
}

function handleCreateBoxesInput(e) {
  if (!state.modalCreateBoxes) return;
  const inp = e.target.closest('input[data-cbm-count]');
  if (inp) {
    state.modalCreateBoxes.count = Math.max(1, Math.min(200, Number(inp.value) || 1));
    // Не вызываем renderCreateBoxesModal — иначе курсор прыгает.
    return;
  }
  const dim = e.target.closest('input[data-cbm-dim]');
  if (dim) {
    const key = dim.dataset.cbmDim;
    const v = Math.max(1, Math.min(200, Number(dim.value) || 1));
    state.modalCreateBoxes.custom[key] = v;
    // Перерасчёт коэф — обновим только preview-блок без полного rerender, иначе курсор прыгает.
    const coef = calcTaraCoef(state.modalCreateBoxes.custom.w, state.modalCreateBoxes.custom.h, state.modalCreateBoxes.custom.d);
    state.modalCreateBoxes.taraType = taraCodeFromCoef(coef);
    const coefEl = document.querySelector('.cbm-coef b');
    if (coefEl) coefEl.textContent = state.modalCreateBoxes.taraType;
  }
}

function openCreateBoxesModal() {
  if (!state.activeZayavka) { toast('Сначала откройте заявку', true); return; }
  if (isKorMode()) { korBlockToast(); return; }
  state.modalCreateBoxes = {
    count: 1,
    taraType: 'К_1.0',
    sizeMode: 'standard', // 'standard' = 60×40×40 (К_1.0); 'custom' = пользователь задаёт Ш×В×Г
    custom: { w: 60, h: 40, d: 40 },
    owner: 'ФФ', // 'КЛ' (клиента) или 'ФФ' (фулфилмента)
  };
  renderCreateBoxesModal();
  document.body.classList.add('modal-open');
}

// Коэф тары из объёма короба относительно стандарта 60×40×40 (96000 см³).
// Округление до 2 значимых цифр (К_0.5, К_1.0, К_1.25, ...).
function calcTaraCoef(w, h, d) {
  const STANDARD_VOLUME = 60 * 40 * 40; // 96000
  const v = Number(w) * Number(h) * Number(d);
  if (!isFinite(v) || v <= 0) return 1.0;
  const raw = v / STANDARD_VOLUME;
  // 2 значимые цифры: round(raw * 100) / 100 — даёт 2 знака после точки
  return Math.round(raw * 100) / 100;
}

function taraCodeFromCoef(coef) { return `К_${coef}`; }

function closeCreateBoxesModal() {
  state.modalCreateBoxes = null;
  const m = $('createBoxesModal');
  if (m) m.classList.add('hidden');
  if (!state.modalBox) document.body.classList.remove('modal-open');
}

function renderCreateBoxesModal() {
  const m = state.modalCreateBoxes;
  if (!m) return;
  const z = state.activeZayavka;
  const QUICK = [1, 3, 5, 10, 20, 30];
  const existingCount = state.shipBoxes.length;
  const prefix = (z.number.match(/^([SR]\d+)/) || [null, z.number.slice(0, 5)])[1];
  const previewStart = existingCount + 1;
  const previewEnd = existingCount + m.count;
  const used = shipBoxUsedSet();
  // Текущая тара из режима размера
  const coef = m.sizeMode === 'custom'
    ? calcTaraCoef(m.custom.w, m.custom.h, m.custom.d)
    : 1.0;
  m.taraType = taraCodeFromCoef(coef);

  // Список существующих коробов с возможностью удалить (если не использован).
  // В конце списка — inline-кнопка "+ Создать ещё короб" (быстрое создание
  // одного с дефолтными параметрами 60×40×40 ФФ).
  const plusBtnHtml = `
    <button type="button" class="cbm-row cbm-row-plus" data-cbm-quick-add="1" title="Быстро добавить ещё короб (60×40×40, ФФ)">
      <span class="cbm-row-short cbm-plus">+</span>
      <span class="cbm-row-number cbm-row-quickadd">Добавить короб</span>
      <span class="cbm-row-tara cbm-row-tara-default">К_1.0 · ФФ</span>
      <span class="cbm-row-spacer"></span>
      <span class="cbm-row-spacer"></span>
    </button>`;
  const listHtml = state.shipBoxes.length === 0
    ? `<div class="cbm-list cbm-list-empty">${plusBtnHtml}</div>`
    : `<div class="cbm-list">${
        state.shipBoxes.map(b => {
          const isUsed = used.has(b.number);
          // Содержимое: сколько собрано (из state.shipRowsByBox после загрузки).
          const inBox = (state.shipRowsByBox && state.shipRowsByBox[b.number]) || [];
          const totalQty = inBox.reduce((a, r) => a + (Number(r.qty) || 0), 0);
          const uniqBars = new Set(inBox.map(r => r.barcode).filter(Boolean)).size;
          const delAttr = isUsed ? 'disabled title="Используется в раскладке"' : `data-cbm-del="${escapeHtml(b.number)}" title="Удалить ${escapeHtml(b.number)}"`;
          const fillBadge = totalQty > 0
            ? `<span class="cbm-row-fill">${uniqBars} баркод${uniqBars === 1 ? '' : 'а'}, ${totalQty} ед.</span>`
            : '<span class="cbm-row-fill empty">пусто</span>';
          return `
            <div class="cbm-row${isUsed ? ' is-used' : ''}" data-cbm-open="${escapeHtml(b.number)}" title="Открыть для перепаковки">
              <span class="cbm-row-short">${b.short}</span>
              <span class="cbm-row-number">${escapeHtml(b.number)}</span>
              <span class="cbm-row-tara">${escapeHtml(b.taraType)}</span>
              ${fillBadge}
              <button type="button" class="cbm-del" ${delAttr}>🗑</button>
            </div>`;
        }).join('') + plusBtnHtml
      }</div>`;

  const quickBtns = QUICK.map(n =>
    `<button type="button" class="cbm-quick${n === m.count ? ' active' : ''}" data-cbm-count="${n}">${n}</button>`
  ).join('');
  // Размер: стандартный 60×40×40 (быстрый путь) или custom Ш×В×Г.
  const sizeRow = `
    <div class="cbm-size-mode">
      <button type="button" class="cbm-size-btn${m.sizeMode === 'standard' ? ' active' : ''}" data-cbm-size="standard">Стандарт 60×40×40 (К_1.0)</button>
      <button type="button" class="cbm-size-btn${m.sizeMode === 'custom' ? ' active' : ''}" data-cbm-size="custom">Свои габариты</button>
    </div>
    ${m.sizeMode === 'custom' ? `
      <div class="cbm-dim-row">
        <label>Ш<input type="number" min="1" max="200" data-cbm-dim="w" value="${m.custom.w}" inputmode="numeric"></label>
        <label>В<input type="number" min="1" max="200" data-cbm-dim="h" value="${m.custom.h}" inputmode="numeric"></label>
        <label>Г<input type="number" min="1" max="200" data-cbm-dim="d" value="${m.custom.d}" inputmode="numeric"></label>
        <span class="cbm-coef">→ <b>${escapeHtml(m.taraType)}</b></span>
      </div>
    ` : ''}
  `;
  // Владелец тары (КЛ/ФФ).
  const ownerRow = `
    <div class="cbm-owner-row">
      <span class="cbm-section-label" style="margin-right: 12px;">Тара:</span>
      <button type="button" class="cbm-owner-btn${m.owner === 'ФФ' ? ' active' : ''}" data-cbm-owner="ФФ" title="Фулфилмента">ФФ</button>
      <button type="button" class="cbm-owner-btn${m.owner === 'КЛ' ? ' active' : ''}" data-cbm-owner="КЛ" title="Клиента">КЛ</button>
    </div>
  `;

  const html = `
    <div class="cbm-header">
      <h3>📦 Коробы отгрузки</h3>
      <div class="cbm-zay">${escapeHtml(z.number)} · ${escapeHtml(z.client)}</div>
      <button type="button" class="bm-close" id="cbmClose" title="Закрыть">✕</button>
    </div>
    <div class="cbm-body">
      <div class="cbm-section">
        <label class="cbm-section-label">Созданные (${existingCount})</label>
        ${listHtml}
      </div>
      <div class="cbm-section cbm-create">
        <label class="cbm-section-label">Создать ещё</label>
        <div class="cbm-field">
          <div class="cbm-quick-row">${quickBtns}</div>
          <div class="num-row cbm-num-row">
            <button type="button" class="num-btn" data-cbm-step="-1">−</button>
            <input type="number" min="1" max="200" step="1" value="${m.count}" data-cbm-count inputmode="numeric">
            <button type="button" class="num-btn" data-cbm-step="1">+</button>
          </div>
        </div>
        <div class="cbm-field">${sizeRow}</div>
        <div class="cbm-field">${ownerRow}</div>
        <div class="cbm-preview">
          Будут созданы:
          <b>${prefix}-${String(previewStart).padStart(3, '0')}</b>
          ${m.count > 1 ? ` … <b>${prefix}-${String(previewEnd).padStart(3, '0')}</b>` : ''}
          · тара <b>${escapeHtml(m.taraType)}</b> · ${m.owner}
        </div>
      </div>
      <div class="cbm-print-note">
        🖨️ Печать ленты этикеток с QR — будет добавлена позднее.
      </div>
    </div>
    <div class="cbm-footer">
      <button type="button" class="btn btn-secondary" id="cbmCancel">Закрыть</button>
      ${state.shipBoxes.length > 0
        ? `<button type="button" class="btn btn-secondary" id="cbmPrint">🖨️ Печать ленты (${state.shipBoxes.length})</button>`
        : ''}
      <button type="button" class="btn btn-primary" id="cbmSubmit">Создать ${m.count} ${pluralKorobov(m.count)}</button>
    </div>
  `;

  const modal = ensureCreateBoxesElement();
  modal.classList.remove('hidden');
  modal.querySelector('.cbm-dialog').innerHTML = html;
  // Восстанавливаем скролл-позицию + автоматически прокручиваем к последнему
  // существующему коробу при первом открытии (чтобы видеть «куда складывать»).
  const list = modal.querySelector('.cbm-list');
  if (list) {
    if (typeof state.cbmScrollTop === 'number' && state.cbmScrollTop > 0) {
      list.scrollTop = state.cbmScrollTop;
    } else {
      // Прокрутка к концу — там видна последняя созданная коробка + кнопка "+".
      list.scrollTop = list.scrollHeight;
      state.cbmScrollTop = list.scrollTop;
    }
    list.addEventListener('scroll', () => { state.cbmScrollTop = list.scrollTop; });
  }
}

// Быстрое добавление одного короба: с дефолтными параметрами (60×40×40, ФФ),
// без модалки настройки. Optimistic — fire and forget.
async function quickAddShipBox() {
  const z = state.activeZayavka;
  if (!z) return;
  if (!ensureWorkStarted()) return;
  fetch('/api/podbor/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSyncBody(
      [{
        type: 'ship.create', zayavkaId: z.number, count: 1, taraType: 'К_1.0',
        dimensions: { w: 60, h: 40, d: 40 }, owner: 'ФФ',
      }],
      z
    )),
  }).then(async res => {
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const r = (data.results && data.results[0]) || {};
    if (!r.ok) throw new Error(r.error || 'unknown');
    state.shipBoxes.push(...(r.created || []));
    state.cbmScrollTop = -1; // авто-проктулка к концу при следующем render'е
    renderCreateBoxesModal();
    renderZayavkaBar();
    if (state.modalBox) renderBoxModal();
  }).catch(e => toast('Ошибка добавления: ' + e.message, true));
}

async function submitCreateBoxes() {
  const m = state.modalCreateBoxes;
  const z = state.activeZayavka;
  if (!m || !z) return;
  if (!ensureWorkStarted()) return;
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSyncBody(
        [{
          type: 'ship.create',
          zayavkaId: z.number,
          count: m.count,
          taraType: m.taraType,
          dimensions: m.sizeMode === 'custom' ? m.custom : { w: 60, h: 40, d: 40 },
          owner: m.owner,
        }],
        z
      ))
    });
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const result = (data.results && data.results[0]) || {};
    if (!result.ok) throw new Error(result.error || 'unknown');
    state.shipBoxes.push(...(result.created || []));
    toast(`Создано ${result.created.length} ${pluralKorobov(result.created.length)}: ${result.created[0].number} … ${result.created[result.created.length - 1].number}`);
    closeCreateBoxesModal();
    renderZayavkaBar();
    // Если открыта BoxModal — перерендерить (теперь tiles появятся).
    if (state.modalBox) renderBoxModal();
  } catch (e) {
    toast('Ошибка создания коробов: ' + e.message, true);
  }
}

// Унифицированное body для /api/podbor/sync — везде шлём контекст заявки
// (warehouse, finalWarehouse, dateOtgr, mp) для записи в КОРОБЫ.M/N/X/R.
function buildSyncBody(updates, z) {
  return {
    updates,
    zayavkaId: z?.number || null,
    client: z?.client || null,
    warehouse: z?.warehouse || null,
    finalWarehouse: z?.finalWarehouse || null,
    dateOtgr: z?.dateOtgr || null,
    mp: z?.mp || null,
  };
}

// ========================================================================
// SyncQueue (atom-based)
// ========================================================================
const SyncQueue = {
  pending: [], inflight: null, debounceTimer: null,
  push(atom) {
    this.pending.push(atom);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), 400);
  },
  async flush() {
    if (this.inflight || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    this.inflight = batch;
    setSyncIndicator('syncing');
    try {
      const z = state.activeZayavka;
      const res = await fetch('/api/podbor/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSyncBody(batch, z))
      });
      // 409 = заявка завершена другим планшетом → блокируем UI.
      if (res.status === 409) {
        const data409 = await res.json().catch(() => ({}));
        if (!state.zayavkaLocked) {
          state.zayavkaLocked = true;
          const fakeStatus = (data409.results && data409.results[0]) || {};
          showZayavkaLockedBanner({
            status: 'СОБРАНО',
            picker: fakeStatus.picker || '—',
            statusChangedAt: fakeStatus.statusChangedAt || '',
          });
        }
        setSyncIndicator('error');
        // НЕ возвращаем атомы в pending — заявка завершена, retry бесполезен.
        return;
      }
      if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.some(r => !r.ok)) {
        const firstFail = data.results.find(r => !r.ok);
        throw new Error(firstFail.error || 'partial sync failure');
      }
      setSyncIndicator('synced');
      // Force-poll сразу после успешного flush — committedPicked обновится
      // из event-store, absorbtion вычистит локальный boxLayouts, плитки
      // придут к корректному значению за 200-400мс вместо 10с polling-цикла.
      if (typeof pollSyncState === 'function') {
        try { await pollSyncState(); } catch {}
      }
    } catch (err) {
      console.error('Sync error:', err);
      setSyncIndicator('error');
      this.pending.unshift(...batch);
      setTimeout(() => this.flush(), 3000);
    } finally {
      this.inflight = null;
      if (this.pending.length > 0) this.flush();
    }
  }
};

function setSyncIndicator(status) {
  const el = $('syncStatus');
  if (!el) return;
  el.dataset.status = status;
  const labels = {
    idle: '',
    syncing: '⟳ Синхронизация…',
    synced: '✓ Синхронизировано',
    error: '✗ Ошибка sync'
  };
  el.textContent = labels[status] || '';
}

// ========================================================================
// View management
// ========================================================================
function switchView(view) {
  state.view = view;
  if (view === 'start') {
    $('startScreen').classList.remove('hidden');
    $('polotnoScreen').classList.add('hidden');
    $('backBtn').classList.add('hidden');
    document.body.classList.remove('view-polotno');
    document.body.classList.add('view-start');
  } else {
    $('startScreen').classList.add('hidden');
    $('polotnoScreen').classList.remove('hidden');
    $('backBtn').classList.remove('hidden');
    document.body.classList.remove('view-start');
    document.body.classList.add('view-polotno');
  }
  if (typeof updateTopbarStartBtn === 'function') updateTopbarStartBtn();
}

function backToStart() {
  state.activeZayavka = null;
  state.pickerName = null;
  state.workStarted = false;
  state.allGroups = [];
  state.visibleGroups = [];
  state.allRowsFlat = [];
  state.visibleRowsFlat = [];
  state.pages = [];
  state.boxLayouts = {};
  state.shipBoxes = [];
  state.committedPicked = {};
  state.requestByBar5 = {};
  state.requestByBarcode = {};
  state.zayavkaLocked = false;
  stopStatePolling();
  switchView('start');
}

// ========================================================================
// Завершение заявки: pre-check + модалка full/partial + атом zayavka.finish
// ========================================================================
// ========================================================================
// NachModal — таблица начислений (paid + free), live из event-store.
// ========================================================================
async function openNachModal() {
  const z = state.activeZayavka;
  if (!z) return;
  let modal = document.getElementById('nachModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'nachModal';
    modal.className = 'app-modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="app-modal nach-modal">
    <div class="am-head"><h3>💰 Начисления по заявке</h3>
      <p class="am-sub">Загружаем...</p></div></div>`;
  modal.classList.remove('hidden');
  try {
    const res = await fetch('/api/podbor/nach?zayavkaId=' + encodeURIComponent(z.number));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderNachModal(modal, data, z);
  } catch (e) {
    modal.querySelector('.am-sub').textContent = 'Ошибка: ' + e.message;
  }
}

function renderNachModal(modal, data, z) {
  if (!data.exists) {
    modal.innerHTML = `<div class="app-modal nach-modal">
      <div class="am-head"><h3>💰 Начисления</h3>
        <p class="am-sub">${escapeHtml(data.message || 'Заявка не начата.')}</p></div>
      <div class="am-footer"><button type="button" class="btn btn-primary" data-close>Закрыть</button></div>
    </div>`;
    modal.querySelector('[data-close]').onclick = () => modal.classList.add('hidden');
    return;
  }
  const paidRows = data.paidItems.map(it => `<tr>
    <td><b>${escapeHtml(String(it.barcode).slice(-5))}</b><span class="nm-full">${escapeHtml(it.barcode)}</span></td>
    <td>${escapeHtml(it.sku || '')}</td>
    <td class="num">${it.qty}</td>
    <td class="num">${data.ratePerUnit.toLocaleString('ru-RU')}</td>
    <td class="num"><b>${it.charge.toLocaleString('ru-RU')}</b></td>
  </tr>`).join('');
  const freeRows = data.freeItems.map(it => `<tr class="nm-free">
    <td><b>${escapeHtml(String(it.barcode).slice(-5))}</b><span class="nm-full">${escapeHtml(it.barcode)}</span></td>
    <td>${escapeHtml(it.sku || '')}</td>
    <td class="num">${it.qty}</td>
    <td class="num">—</td><td class="num">бесплатно</td>
  </tr>`).join('');
  modal.innerHTML = `<div class="app-modal nach-modal">
    <div class="am-head">
      <h3>💰 Начисления · ${escapeHtml(z.number)}</h3>
      <p class="am-sub">КС=${data.ks}, тариф ${data.ratePerUnit}₽/шт. Итого к списанию: <b>${data.totals.totalCharge.toLocaleString('ru-RU')}₽</b> (${data.totals.paidUnits} шт, ${data.totals.paidBarcodes} баркод.).</p>
    </div>
    <div class="am-body nm-body">
      ${paidRows ? `<h4 class="nm-section">Платно (штучный подбор)</h4>
        <table class="nm-table"><thead>
          <tr><th>Баркод</th><th>SKU</th><th>КОЛ</th><th>Цена</th><th>Списание</th></tr>
        </thead><tbody>${paidRows}</tbody></table>` : '<p class="nm-empty">Нет платных позиций. Все коробы изъяты целиком.</p>'}
      ${freeRows ? `<h4 class="nm-section nm-section-free">Бесплатно (полное изъятие)</h4>
        <table class="nm-table"><thead>
          <tr><th>Баркод</th><th>SKU</th><th>КОЛ</th><th>Цена</th><th></th></tr>
        </thead><tbody>${freeRows}</tbody></table>` : ''}
    </div>
    <div class="am-footer"><button type="button" class="btn btn-primary" data-close>Закрыть</button></div>
  </div>`;
  modal.querySelector('[data-close]').onclick = () => modal.classList.add('hidden');
}

// ========================================================================
// PicklogModal — timeline событий (последние сверху).
// ========================================================================
async function openPicklogModal() {
  const z = state.activeZayavka;
  if (!z) return;
  let modal = document.getElementById('picklogModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'picklogModal';
    modal.className = 'app-modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="app-modal picklog-modal">
    <div class="am-head"><h3>📋 Журнал действий</h3>
      <p class="am-sub">Загружаем...</p></div></div>`;
  modal.classList.remove('hidden');
  try {
    const res = await fetch('/api/podbor/picklog?zayavkaId=' + encodeURIComponent(z.number));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderPicklogModal(modal, data, z);
  } catch (e) {
    modal.querySelector('.am-sub').textContent = 'Ошибка: ' + e.message;
  }
}

function renderPicklogModal(modal, data, z) {
  if (!data.exists || !data.events || data.events.length === 0) {
    modal.innerHTML = `<div class="app-modal picklog-modal">
      <div class="am-head"><h3>📋 Журнал</h3>
        <p class="am-sub">${escapeHtml(data.message || 'События отсутствуют.')}</p></div>
      <div class="am-footer"><button type="button" class="btn btn-primary" data-close>Закрыть</button></div>
    </div>`;
    modal.querySelector('[data-close]').onclick = () => modal.classList.add('hidden');
    return;
  }
  const rows = data.events.map(ev => {
    const dt = new Date(ev.ts);
    const time = dt.toLocaleString('ru-RU', { hour12: false });
    let summary;
    switch (ev.type) {
      case 'zayavka.start':
        summary = `▶ Начато (${escapeHtml(ev.picker || ev.by)})`; break;
      case 'zayavka.finish':
        summary = `✓ Завершено (${ev.mode || 'full'})`; break;
      case 'zayavka.partial_close':
        summary = `⏸ Частично закрыто`; break;
      case 'zayavka.close':
        summary = `✕ Закрыто без сборки`; break;
      case 'ship.create':
        summary = `📦 Создан короб <b>${escapeHtml(ev.number)}</b> · ${escapeHtml(ev.taraType || '')} · ${escapeHtml(ev.owner || '')}`; break;
      case 'ship.delete':
        summary = `🗑 Удалён короб <b>${escapeHtml(ev.number)}</b>`; break;
      case 'set_layout': {
        const items = (ev.items || []).map(it => {
          const parts = [];
          if (it.kolPodb > 0) parts.push(`${it.kolPodb}→${escapeHtml(it.kudaPodb || '?')}`);
          if (it.kolPerem > 0) parts.push(`${it.kolPerem}→${escapeHtml(it.kudaPerem || 'ячейка')}`);
          return `${escapeHtml(String(it.barcode).slice(-5))}: ${parts.join(', ')}`;
        }).join('; ');
        summary = `📦→ Раскладка <b>${escapeHtml(ev.source)}</b> · ${items}`; break;
      }
      case 'full_to_ship':
        summary = `🔄 Изъят целиком <b>${escapeHtml(ev.source)}</b> → ${escapeHtml(ev.newKorob || '')} · ${escapeHtml(ev.owner || '')}`; break;
      case 'inventory_correction':
        summary = `✏ Микро-инвент <b>${escapeHtml(ev.korob)}</b>/${escapeHtml(String(ev.barcode).slice(-5))} · ${ev.old} → ${ev.new}`; break;
      default:
        summary = escapeHtml(ev.type);
    }
    return `<tr>
      <td class="plm-time">${escapeHtml(time)}</td>
      <td class="plm-by">${escapeHtml(ev.by || '')}</td>
      <td class="plm-summary">${summary}</td>
    </tr>`;
  }).join('');
  modal.innerHTML = `<div class="app-modal picklog-modal">
    <div class="am-head">
      <h3>📋 Журнал · ${escapeHtml(z.number)}</h3>
      <p class="am-sub">Всего событий: <b>${data.eventsCount}</b>. Сборщики: ${(data.meta.pickers || []).map(escapeHtml).join(', ') || '—'}.</p>
    </div>
    <div class="am-body plm-body">
      <table class="plm-table"><thead>
        <tr><th>Время</th><th>Кто</th><th>Действие</th></tr>
      </thead><tbody>${rows}</tbody></table>
    </div>
    <div class="am-footer"><button type="button" class="btn btn-primary" data-close>Закрыть</button></div>
  </div>`;
  modal.querySelector('[data-close]').onclick = () => modal.classList.add('hidden');
}

async function attemptFinish() {
  const z = state.activeZayavka;
  if (!z) return;
  const { matched, mismatches } = checkFinishMatch();
  if (matched) {
    // Всё собрано в точности как в заявке — открываем standalone progress-modal
    // и вызываем finalize с ним.
    const overlay = showProgressModal('Завершаем заявку…');
    return finalizeZayavka('full', `Собрано в точности (${Object.keys(state.requestByBarcode).length} баркодов).`, overlay);
  }
  // Несоответствие — показываем модалку выбора full/partial.
  showFinishConflictModal(mismatches);
}

function showFinishConflictModal(mismatches) {
  let modal = document.getElementById('finishModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'finishModal';
    modal.className = 'finish-modal-overlay';
    document.body.appendChild(modal);
  }
  const rows = mismatches.map(m => {
    const diff = m.picked - m.requested;
    const diffLabel = diff > 0 ? `+${diff} (больше)` : `${diff} (меньше)`;
    const diffCls = diff > 0 ? 'fm-over' : 'fm-under';
    return `<tr>
      <td><span class="fm-bar">${escapeHtml(String(m.barcode).slice(-5))}</span><span class="fm-bar-full">${escapeHtml(m.barcode)}</span></td>
      <td class="num">${m.requested}</td>
      <td class="num"><b>${m.picked}</b></td>
      <td class="num ${diffCls}">${diffLabel}</td>
    </tr>`;
  }).join('');
  modal.innerHTML = `
    <div class="finish-modal" role="dialog" aria-modal="true">
      <div class="fm-head">
        <h3>Несоответствие при завершении</h3>
        <p>Собрано отличается от заявленного по ${mismatches.length} баркод${mismatches.length === 1 ? 'у' : (mismatches.length < 5 ? 'ам' : 'ов')}:</p>
      </div>
      <div class="fm-body">
        <table class="fm-table">
          <thead><tr><th>Баркод</th><th>Нужно</th><th>Собрано</th><th>Δ</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="fm-footer">
        <button type="button" class="btn btn-secondary" id="fmCancel">Отмена</button>
        <button type="button" class="btn btn-warning" id="fmPartial">Частично собрано</button>
        <button type="button" class="btn btn-primary" id="fmFull">Полное завершение</button>
      </div>
    </div>
  `;
  modal.classList.remove('hidden');
  document.getElementById('fmCancel').onclick = () => modal.classList.add('hidden');
  document.getElementById('fmFull').onclick = () => {
    // Не скрываем модалку — перерисовываем в processing-state и вызываем finalize.
    renderFinishModalProcessing(modal, 'Завершаем заявку…');
    finalizeZayavka('full', 'Полное завершение (с расхождением).', modal);
  };
  document.getElementById('fmPartial').onclick = () => {
    renderFinishModalProcessing(modal, 'Сохраняем частичное завершение…');
    finalizeZayavka('partial', 'Частичное завершение, можно продолжить позже.', modal);
  };
}

// Перерисовывает указанный overlay-узел в state «обработка»: спиннер + текст.
// Используется для finishModal (с расхождениями) и для standalone progress-modal.
// Stop pending step-timers on the overlay (idempotent, safe on null).
function clearProgressTimers(overlay) {
  if (!overlay) return;
  if (overlay._progressTimers) {
    for (const id of overlay._progressTimers) clearTimeout(id);
  }
  overlay._progressTimers = [];
}

function renderFinishModalProcessing(overlay, message) {
  // Pipeline на бэке: parallel(КОРОБЫ + НАЧ + readState) → ОТГ → БД ПОДБОРЫ →
  // archive. Общий TTL обычно 5-10 сек, до 30 сек на лимитах квоты Sheets
  // (ретраи 1s/2s/4s/8s). Чек-лист показывает «активный» этап чтобы юзер
  // видел движение, а не один безликий спиннер.
  const steps = [
    { delay: 0,    text: '🔍 Проверка состояния заявки…' },
    { delay: 1500, text: '📦 Перевод коробов В СБОРКЕ → СОБРАНО (лист 🍬 КОРОБЫ)' },
    { delay: 3000, text: '💰 Запись начислений (лист НАЧ)' },
    { delay: 5000, text: '🚚 Запись в лист 🚚 ОТГ (UPSELLER)' },
    { delay: 7000, text: '📑 Финализация в ПОДБОРЫ.БД' },
    { delay: 9000, text: '⏳ Дожидаемся подтверждения от Sheets…' },
  ];
  const stepsHtml = steps.map((s, i) =>
    `<li class="pm-step pm-step-pending" data-idx="${i}">
      <span class="pm-step-icon">○</span>
      <span class="pm-step-text">${escapeHtml(s.text)}</span>
    </li>`
  ).join('');
  overlay.innerHTML = `
    <div class="finish-modal pm-state-processing" role="dialog" aria-modal="true">
      <div class="pm-body">
        <div class="pm-spinner" aria-hidden="true"></div>
        <div class="pm-message">${escapeHtml(message)}</div>
        <ul class="pm-steps">${stepsHtml}</ul>
      </div>
    </div>`;
  overlay.classList.remove('hidden');

  // Активируем шаги по таймеру. На каждом шаге: предыдущие — done (✓),
  // текущий — active (●). Этот синтетический прогресс совпадает с реальным
  // parallel pipeline в пределах ±1 сек на dev-серверe; user видит движение.
  clearProgressTimers(overlay);
  for (const [idx, s] of steps.entries()) {
    const id = setTimeout(() => {
      const items = overlay.querySelectorAll('.pm-step');
      items.forEach((li, i) => {
        if (i < idx) {
          li.className = 'pm-step pm-step-done';
          li.querySelector('.pm-step-icon').textContent = '✓';
        } else if (i === idx) {
          li.className = 'pm-step pm-step-active';
          li.querySelector('.pm-step-icon').textContent = '●';
        }
      });
    }, s.delay);
    overlay._progressTimers.push(id);
  }
}

function renderFinishModalResult(overlay, { ok, message, onClose }) {
  clearProgressTimers(overlay);
  const iconCls = ok ? 'pm-success' : 'pm-error';
  const icon = ok
    ? '<svg viewBox="0 0 52 52" class="pm-icon" aria-hidden="true"><circle cx="26" cy="26" r="25" fill="none" stroke="#28a745" stroke-width="2"/><path fill="none" stroke="#28a745" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M14 27 l9 9 l16 -18"/></svg>'
    : '<svg viewBox="0 0 52 52" class="pm-icon" aria-hidden="true"><circle cx="26" cy="26" r="25" fill="none" stroke="#dc3545" stroke-width="2"/><path fill="none" stroke="#dc3545" stroke-width="4" stroke-linecap="round" d="M17 17 L35 35 M35 17 L17 35"/></svg>';
  overlay.innerHTML = `
    <div class="finish-modal pm-state-result ${iconCls}" role="dialog" aria-modal="true">
      <div class="pm-body">
        ${icon}
        <div class="pm-message">${escapeHtml(message)}</div>
      </div>
      <div class="pm-footer">
        <button type="button" class="btn ${ok ? 'btn-primary' : 'btn-secondary'} pm-close-btn">Закрыть</button>
      </div>
    </div>`;
  const closeBtn = overlay.querySelector('.pm-close-btn');
  closeBtn.onclick = () => {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    if (typeof onClose === 'function') onClose();
  };
}

// Standalone progress modal: используется когда finishModal расхождений не было
// (matched-кейс прямо в attemptFinish), а также для attemptClose.
function ensureProgressModal() {
  let modal = document.getElementById('progressModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'progressModal';
    modal.className = 'finish-modal-overlay hidden';
    document.body.appendChild(modal);
  }
  return modal;
}

function showProgressModal(message) {
  const modal = ensureProgressModal();
  renderFinishModalProcessing(modal, message);
  return modal;
}

function showResultModal({ ok, message, onClose }) {
  const modal = ensureProgressModal();
  renderFinishModalResult(modal, { ok, message, onClose });
  return modal;
}

// Promise.race с таймаутом — для защиты от зависшего fetch.
function withTimeout(promise, ms, timeoutMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMsg || 'Сервер не отвечает.')), ms)),
  ]);
}

// G: «Закрыть» — выход со своего планшета. Статус В РАБОТЕ сохраняется,
// сборщики не стираются. Другой сотрудник может продолжить или мы вернёмся
// позже. Физические правки на листе КОРОБЫ остаются.
async function attemptClose() {
  const z = state.activeZayavka;
  if (!z) return;
  if (!confirm(`Выйти из заявки ${z.number}?\n\nСтатус «В РАБОТЕ» сохранится, сборщики не стираются. Другой сотрудник может подключиться и продолжить, или вы вернётесь позже.`)) return;
  const overlay = showProgressModal('Выходим из заявки…');
  try {
    const fetchPromise = fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSyncBody(
        [{ type: 'zayavka.close', zayavkaNumber: z.number }],
        z
      )),
    });
    const res = await withTimeout(fetchPromise, 60000, 'Сервер не отвечает. Проверьте сеть или повторите попытку.');
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const r = (data.results && data.results[0]) || {};
    if (!r.ok) throw new Error(r.error || r.reason || 'unknown');
    showResultModal({
      ok: true,
      message: `Вышли из заявки ${z.number}. Статус «В РАБОТЕ» сохранён.`,
      onClose: backToStart,
    });
  } catch (e) {
    showResultModal({
      ok: false,
      message: `Не удалось выйти из заявки: ${e.message}`,
    });
  }
}

// finalizeZayavka — завершает заявку с full/partial. overlay — узел, в котором
// нужно показать состояние (processing → success/error). Если не передан, ищет
// стандартный progress-modal (matched-кейс) или создаёт его.
async function finalizeZayavka(mode, note, overlay) {
  const z = state.activeZayavka;
  if (!z) return;
  if (!overlay) overlay = ensureProgressModal();
  if (overlay.classList.contains('hidden') || !overlay.querySelector('.pm-spinner')) {
    renderFinishModalProcessing(overlay, 'Завершаем заявку…');
  }
  // Если еще не указан picker — спросим (бэк всё равно потребует сборщика).
  // ВАЖНО: ensurePicker откроет свою модалку поверх progress — это нормально,
  // юзер увидит picker prompt, потом продолжится processing.
  const picker = await ensurePicker();
  if (!picker) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    return;
  }
  try {
    const fetchPromise = fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSyncBody(
        [{ type: 'zayavka.finish', zayavkaNumber: z.number, mode }],
        z
      )),
    });
    // 60 сек: legitimный finish с 4 sequential Sheets-calls (mass transition,
    // NACH append, finish-summary batchUpdate, archive) может реально занимать
    // 15-30 сек. 20 сек слишком жёстко. Backend mutex теперь сам ловит deadlock
    // через 30с (zayavka-store.js: LOCK_TIMEOUT_MS).
    const res = await withTimeout(fetchPromise, 60000, 'Сервер не отвечает. Проверьте сеть или повторите попытку.');
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const r = (data.results && data.results[0]) || {};
    if (!r.ok) throw new Error(r.error || r.reason || 'unknown');
    const message = mode === 'full'
      ? `Заявка ${z.number} → СОБРАНО (переведено строк: ${r.transitioned || 0}). ${note}`
      : `Заявка ${z.number} → ЧАСТ.СОБР. ${note}`;
    renderFinishModalResult(overlay, {
      ok: true,
      message,
      onClose: backToStart,
    });
  } catch (e) {
    renderFinishModalResult(overlay, {
      ok: false,
      message: `Ошибка завершения: ${e.message}`,
    });
  }
}

// ========================================================================
// MicroInventModal — точечная корректировка КОЛ строки короба.
// Открывается тапом на блок «Остаток» в карточке баркода.
// Бэкенд-атом: box.inventory_correction { boxId, barcode, novKol, oldKol, reason }.
// После применения сервер обновляет qty этой строки и при необходимости клэмпит
// существующую раскладку.
// ========================================================================
function ensureMicroInventElement() {
  let modal = $('microInventModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'microInventModal';
  modal.className = 'mim-overlay hidden';
  modal.innerHTML = '<div class="mim-dialog" role="dialog" aria-modal="true"></div>';
  modal.addEventListener('click', handleMicroInventClick);
  modal.addEventListener('input', handleMicroInventInput);
  document.body.appendChild(modal);
  return modal;
}

function handleMicroInventClick(e) {
  if (e.target.id === 'microInventModal') { closeMicroInventModal(); return; }
  const t = e.target;
  if (t.closest('#mimClose, #mimCancel')) { closeMicroInventModal(); return; }
  if (t.closest('#mimApply')) { applyMicroInvent(); return; }
  const stepBtn = t.closest('button[data-mim-step]');
  if (stepBtn) {
    const step = Number(stepBtn.dataset.mimStep) || 0;
    state.modalMicroInvent.newQty = Math.max(0, state.modalMicroInvent.newQty + step);
    renderMicroInventModal();
    return;
  }
  const quickBtn = t.closest('button[data-mim-set]');
  if (quickBtn) {
    state.modalMicroInvent.newQty = Math.max(0, Number(quickBtn.dataset.mimSet) || 0);
    renderMicroInventModal();
    return;
  }
}

function handleMicroInventInput(e) {
  const inp = e.target;
  if (inp.id === 'mimQtyInput') {
    state.modalMicroInvent.newQty = Math.max(0, Number(inp.value) || 0);
  } else if (inp.id === 'mimReason') {
    state.modalMicroInvent.reason = String(inp.value || '');
  }
}

function openMicroInventModal(barcode) {
  if (!state.modalBox) return;
  const row = state.modalBox.rows.find(r => r.barcode === barcode);
  if (!row) return;
  state.modalMicroInvent = {
    boxId: state.modalBox.boxId,
    barcode,
    oldQty: row.qty,
    newQty: row.qty,
    reason: ''
  };
  renderMicroInventModal();
}

function closeMicroInventModal() {
  state.modalMicroInvent = null;
  const m = $('microInventModal');
  if (m) m.classList.add('hidden');
}

function renderMicroInventModal() {
  const m = state.modalMicroInvent;
  if (!m) return;
  const delta = m.newQty - m.oldQty;
  const deltaClass = delta > 0 ? 'mim-delta-up' : (delta < 0 ? 'mim-delta-down' : 'mim-delta-zero');
  const deltaText = delta === 0 ? 'без изменений' : (delta > 0 ? `+${delta}` : `${delta}`);
  const canApply = m.newQty !== m.oldQty;
  // Быстрые кнопки: 0, oldQty±1, oldQty±5
  const QUICK = [0, m.oldQty - 1, m.oldQty + 1, m.oldQty - 5, m.oldQty + 5].filter(n => n >= 0 && n !== m.oldQty);
  const quickBtns = QUICK.map(n =>
    `<button type="button" class="mim-quick" data-mim-set="${n}">${n}</button>`
  ).join('');

  const html = `
    <div class="mim-header">
      <h3>✏ Микро-инвент</h3>
      <div class="mim-sub">Короб <b>${escapeHtml(m.boxId)}</b> · баркод <b>${escapeHtml(String(m.barcode).slice(-5))}</b></div>
      <button type="button" class="bm-close" id="mimClose" title="Закрыть">✕</button>
    </div>
    <div class="mim-body">
      <div class="mim-old">
        <span>Системное КОЛ:</span>
        <b>${m.oldQty}</b>
      </div>
      <div class="mim-section">
        <label>Фактическое количество</label>
        <div class="num-row mim-num-row">
          <button type="button" class="num-btn" data-mim-step="-5">−5</button>
          <button type="button" class="num-btn" data-mim-step="-1">−1</button>
          <input type="number" id="mimQtyInput" min="0" step="1" value="${m.newQty}" inputmode="numeric">
          <button type="button" class="num-btn" data-mim-step="1">+1</button>
          <button type="button" class="num-btn" data-mim-step="5">+5</button>
        </div>
        ${quickBtns ? `<div class="mim-quick-row">${quickBtns}</div>` : ''}
        <div class="mim-delta ${deltaClass}">Изменение: ${deltaText}</div>
      </div>
      <div class="mim-section">
        <label>Причина (рекомендуется)</label>
        <textarea id="mimReason" rows="2" placeholder="например: пересчитал — 35 вместо 37, нашёл 2 единицы вне короба">${escapeHtml(m.reason)}</textarea>
      </div>
      <div class="mim-warning">
        Изменение зафиксируется в журнале аудита. Если в раскладке уже указано
        больше штук, чем новое количество — раскладка автоматически уменьшится.
      </div>
    </div>
    <div class="mim-footer">
      <button type="button" class="btn btn-secondary" id="mimCancel">Отмена</button>
      <button type="button" class="btn btn-primary" id="mimApply" ${canApply ? '' : 'disabled'}>Применить</button>
    </div>
  `;
  const modal = ensureMicroInventElement();
  modal.classList.remove('hidden');
  modal.querySelector('.mim-dialog').innerHTML = html;
}

async function applyMicroInvent() {
  const m = state.modalMicroInvent;
  if (!m || m.newQty === m.oldQty) return;
  if (!ensureWorkStarted()) return;
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSyncBody(
        [{
          type: 'box.inventory_correction',
          boxId: m.boxId, barcode: m.barcode,
          novKol: m.newQty, oldKol: m.oldQty, reason: m.reason
        }],
        state.activeZayavka
      ))
    });
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const result = (data.results && data.results[0]) || {};
    if (!result.ok) throw new Error(result.error || 'unknown');
    // Локально обновляем qty строки в allRowsFlat и в open BoxModal.
    for (const r of state.allRowsFlat) {
      if (r.korob === m.boxId && r.barcode === m.barcode) r.qty = m.newQty;
    }
    if (state.modalBox && state.modalBox.boxId === m.boxId) {
      for (const r of state.modalBox.rows) {
        if (r.barcode === m.barcode) r.qty = m.newQty;
      }
      // Если раскладка превышает новое qty — клэмпим.
      const draftSlot = state.modalBox.draft[m.barcode];
      if (draftSlot) {
        if (draftSlot.kolPodb + draftSlot.kolPerem > m.newQty) {
          if (draftSlot.kolPodb > m.newQty) {
            draftSlot.kolPodb = m.newQty;
            draftSlot.kolPerem = 0;
          } else {
            draftSlot.kolPerem = m.newQty - draftSlot.kolPodb;
          }
        }
      }
    }
    toast(`Микро-инвент: ${m.oldQty} → ${m.newQty}`);
    closeMicroInventModal();
    if (state.modalBox) renderBoxModal();
    renderCurrentPage();
    updateProgress();
  } catch (e) {
    toast('Ошибка микро-инвента: ' + e.message, true);
  }
}

// ========================================================================
// ПОЛН КОРОБ — «весь короб целиком на отгрузку».
// Доступен только если для каждого баркода в коробе активная заявка
// требует ≥ КОЛ штук. Включение задаёт kolPodb=qty, kolPerem=0 для всех
// баркодов и единый kudaPodb (выбирается через tile-row в шапке модалки).
// ========================================================================
// Полное изъятие короба возможно только если:
//   - тара не ЯЧ (ячейки не изыматься целиком).
//   - в draft нет перекладок в ячейку (если что-то уже идёт в kudaPerem,
//     это «штучный» подбор → короб открыт → платно, а не free full-box).
//   - все баркоды короба покрываются потребностью заявки в полном qty.
function fullBoxAvailable() {
  if (!state.modalBox) return { ok: false, reason: 'нет короба' };
  // Запрет 1: тара ЯЧ — это ячейка, её нельзя изъять «целиком».
  const headTara = String(state.modalBox.rows?.[0]?.tara || '').trim().toUpperCase();
  if (headTara === 'ЯЧ') {
    return { ok: false, reason: 'ячейку нельзя изъять целиком' };
  }
  // Запрет 2: уже есть перекладка в ячейку — короб «открыт».
  for (const slot of Object.values(state.modalBox.draft || {})) {
    if ((Number(slot.kolPerem) || 0) > 0) {
      return { ok: false, reason: 'в коробе уже есть переклад в ячейку — это штучный подбор' };
    }
  }
  // Запрет 3: каждый баркод должен полностью «вмещаться» в потребность.
  for (const r of state.modalBox.rows) {
    const need = requestedFor(r.barcode);
    const alreadyPicked = pickedByBarcode(r.barcode) - (state.modalBox.draft[r.barcode]?.kolPodb || 0);
    const available = Math.max(0, need - alreadyPicked);
    if (available < r.qty) {
      return {
        ok: false,
        reason: need === 0
          ? `баркод ${String(r.barcode).slice(-5)} не в заявке`
          : `${String(r.barcode).slice(-5)}: нужно ${available}, в коробе ${r.qty}`
      };
    }
  }
  return { ok: true };
}

function onFullBoxToggle() {
  if (!state.modalBox) return;
  const wasOn = !!state.modalBox.fullBoxMode;
  if (wasOn) {
    // В КОР выключить нельзя — короб берётся только целиком, единственное действие.
    if (isKorMode()) { korBlockToast(); return; }
    state.modalBox.fullBoxMode = false;
    for (const r of state.modalBox.rows) {
      const d = state.modalBox.draft[r.barcode];
      if (d) {
        d.kolPodb = 0;
        d.kolPerem = 0;
        d.kudaPodb = '';
      }
    }
  } else {
    const check = fullBoxAvailable();
    if (!check.ok) {
      toast('ПОЛН КОРОБ недоступен: ' + check.reason, true);
      return;
    }
    state.modalBox.fullBoxMode = true;
    // КОР: backend сам назначает S-номер при finalize → AUTO_KOR_TARGET.
    // СВОБ: короб уходит «как есть», номер исходного K-короба сохраняется.
    state.modalBox.fullBoxTarget = isKorMode() ? AUTO_KOR_TARGET : state.modalBox.boxId;
    for (const r of state.modalBox.rows) {
      const d = state.modalBox.draft[r.barcode];
      if (!d) continue;
      d.kolPodb = r.qty;
      d.kolPerem = 0;
      d.kudaPodb = state.modalBox.fullBoxTarget;
    }
  }
  renderBoxModal();
}

function anyLayout(rows, draft, modal) {
  if (modal && modal.fullBoxMode) return true;
  for (const r of rows) {
    const d = draft[r.barcode];
    if (!d) continue;
    if ((Number(d.kolPodb) || 0) > 0) return true;
    if ((Number(d.kolPerem) || 0) > 0) return true;
    if (d.kudaPodb || d.kudaPerem) return true;
  }
  return false;
}

function onResetBarcode(bar) {
  if (!state.modalBox || !bar) return;
  if (isKorMode()) { korBlockToast(); return; }
  const d = state.modalBox.draft[bar];
  if (!d) return;
  d.kolPodb = 0;
  d.kudaPodb = '';
  d.kolPerem = 0;
  d.kudaPerem = '';
  // Если был ПОЛН КОРОБ — частичный сброс отдельной строки выводит из этого режима.
  if (state.modalBox.fullBoxMode) {
    state.modalBox.fullBoxMode = false;
    state.modalBox.fullBoxTarget = '';
  }
  renderBoxModal();
}

function onResetAll() {
  if (!state.modalBox) return;
  if (isKorMode()) { korBlockToast(); return; }
  for (const r of state.modalBox.rows) {
    const d = state.modalBox.draft[r.barcode];
    if (!d) continue;
    d.kolPodb = 0;
    d.kudaPodb = '';
    d.kolPerem = 0;
    d.kudaPerem = '';
  }
  state.modalBox.fullBoxMode = false;
  state.modalBox.fullBoxTarget = '';
  renderBoxModal();
}

// ========================================================================
// Settings menu (☰) — выпадающее меню в правом углу шапки.
// ========================================================================
function ensureSettingsMenuElement() {
  let menu = $('settingsMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'settingsMenu';
  menu.className = 'settings-menu hidden';
  document.body.appendChild(menu);
  // Закрываем по клику вне меню.
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('#settingsMenu, #settingsBtn')) return;
    menu.classList.add('hidden');
  });
  menu.addEventListener('click', (e) => {
    // Чекбоксы статусов: переключают, не закрывают меню.
    const stCb = e.target.closest('input[type="checkbox"][data-status]');
    if (stCb) {
      const s = stCb.dataset.status;
      if (stCb.checked) state.hiddenStatuses.delete(s); else state.hiddenStatuses.add(s);
      saveHiddenStatuses(state.hiddenStatuses);
      renderCurrentPage();
      return;
    }
    const item = e.target.closest('button[data-action]');
    if (!item) return;
    menu.classList.add('hidden');
    handleSettingsAction(item.dataset.action);
  });
  return menu;
}

function toggleSettingsMenu() {
  const menu = ensureSettingsMenuElement();
  const btn = $('settingsBtn');
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  menu.innerHTML = renderSettingsMenu();
  menu.classList.toggle('hidden');
}

function renderSettingsMenu() {
  const inZayavka = !!state.activeZayavka;
  const statusItems = ALL_STATUSES.map(s => {
    const cls = STATUS_CLASS[s] || 'badge-other';
    const checked = !state.hiddenStatuses.has(s);
    return `
      <label class="sm-checkbox">
        <input type="checkbox" data-status="${escapeHtml(s)}" ${checked ? 'checked' : ''}>
        <span class="badge ${cls}">${escapeHtml(s)}</span>
      </label>`;
  }).join('');
  return `
    <div class="sm-section">
      <div class="sm-title">Заявка</div>
      <button class="sm-item" data-action="create-boxes" ${inZayavka ? '' : 'disabled'}>
        <span class="sm-icon">📦</span>
        <span class="sm-label">Коробы отгрузки</span>
        ${inZayavka ? `<span class="sm-hint">${state.shipBoxes.length}</span>` : ''}
      </button>
      <button class="sm-item" data-action="print-labels" ${inZayavka && state.shipBoxes.length ? '' : 'disabled'}>
        <span class="sm-icon">🖨️</span>
        <span class="sm-label">Печать этикеток</span>
      </button>
    </div>
    <div class="sm-section">
      <div class="sm-title">Архив</div>
      <button class="sm-item" data-action="archive-open">
        <span class="sm-icon">📜</span>
        <span class="sm-label">История заявок</span>
      </button>
    </div>
    <div class="sm-section">
      <div class="sm-title">Отображение</div>
      <div class="sm-hint-row">Видимые статусы коробов в полотне</div>
      <div class="sm-statuses">${statusItems}</div>
    </div>
    <div class="sm-section">
      <div class="sm-title">Аккаунт</div>
      <button class="sm-item" data-action="logout">
        <span class="sm-icon">⎋</span>
        <span class="sm-label">Выйти</span>
      </button>
    </div>
  `;
}

function handleSettingsAction(action) {
  switch (action) {
    case 'create-boxes': openCreateBoxesModal(); break;
    case 'print-labels': printShipLabels(); break;
    case 'archive-open': location.href = '/podbor/archive.html'; break;
    case 'logout':
      fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
        location.href = '/login/';
      });
      break;
  }
}

// ========================================================================
// Wire up
// ========================================================================
$('clientFilter').addEventListener('change', (e) => {
  state.clientFilter = e.target.value;
  renderStartScreen();
});

// Chip-фильтры в шапке списка заявок: 'all' / 'urgent'.
// Одно активное значение, переключается по клику.
const chipBar = document.getElementById('chipFilters');
if (chipBar) {
  chipBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-filter');
    if (!btn) return;
    const v = btn.dataset.chip || 'all';
    if (state.quickFilter === v) return;
    state.quickFilter = v;
    chipBar.querySelectorAll('.chip-filter').forEach(b => {
      b.classList.toggle('is-active', b.dataset.chip === v);
    });
    renderStartScreen();
  });
}

$('backBtn').addEventListener('click', backToStart);
// CTA «Начать/Продолжить» в topbar — единый flow со click'ом по коробу.
const topbarStartBtn = document.getElementById('topbarStartBtn');
if (topbarStartBtn) topbarStartBtn.addEventListener('click', startWorkflow);

const sBtn = $('settingsBtn');
if (sBtn) sBtn.addEventListener('click', toggleSettingsMenu);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.modalMicroInvent) closeMicroInventModal();
    else if (state.modalCreateBoxes) closeCreateBoxesModal();
    else if (state.modalBox) closeBoxModal();
  }
});

renderUser();
switchView('start');
loadZayavkiList();

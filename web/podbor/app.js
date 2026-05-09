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
  hiddenStatuses: loadHiddenStatuses()
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
  const requested = Number(state.requestByBarcode[barcode] || 0);
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

function buildRequestByBarcode(items) {
  const m = {};
  for (const it of items || []) {
    const b = String(it.barcode);
    m[b] = (m[b] || 0) + Number(it.qty || 0);
  }
  return m;
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
  let total = 0;
  for (const bars of Object.values(state.boxLayouts)) {
    const slot = bars[barcode];
    if (slot) total += Number(slot.kolPodb) || 0;
  }
  return total;
}

function pickedByBar5(bar5) {
  let total = 0;
  for (const bars of Object.values(state.boxLayouts)) {
    for (const [bar, slot] of Object.entries(bars)) {
      if (String(bar).slice(-5) === bar5) total += Number(slot.kolPodb) || 0;
    }
  }
  return total;
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

function renderStartScreen() {
  const filtered = state.clientFilter
    ? state.zayavki.filter(z => z.client === state.clientFilter)
    : state.zayavki.slice();
  filtered.sort((a, b) => {
    const ra = Z_STATUS_RANK[a.status] || 99;
    const rb = Z_STATUS_RANK[b.status] || 99;
    if (ra !== rb) return ra - rb;
    return String(a.dateOtgr).localeCompare(String(b.dateOtgr));
  });
  $('startStats').textContent = `${filtered.length} ${pluralZayavok(filtered.length)}`;
  const grid = $('zayavkiGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="placeholder">Нет активных заявок' + (state.clientFilter ? ' для выбранного клиента' : '') + '.</div>';
    return;
  }
  grid.innerHTML = filtered.map(renderZayavkaCard).join('');
  grid.querySelectorAll('button[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const num = e.currentTarget.dataset.num;
      const z = state.zayavki.find(x => x.number === num);
      if (z) startZayavka(z);
    });
  });
}

function renderZayavkaCard(z) {
  const cls = Z_STATUS_CLASS[z.status] || 'zb-other';
  const inWork = z.status === 'В РАБОТЕ';
  const ksLabel = z.ks !== 1 ? `<span class="ks-label" title="Коэффициент сложности">×${z.ks}</span>` : '';
  const direction = [z.dateOtgr, z.mp || 'НЕТ', z.warehouse, z.finalWarehouse].filter(Boolean).join(' · ');
  const tm = typeMeta(z.type);
  const pm = pickModeMeta(z.pickMode);
  const buttonHtml = inWork
    ? `<button class="zayavka-btn disabled" disabled>Занято${z.lockedBy ? ` (${escapeHtml(z.lockedBy)})` : ''}</button>`
    : `<button class="zayavka-btn primary" data-action="start" data-num="${escapeHtml(z.number)}">Начать →</button>`;
  return `
    <article class="zayavka-card ${pm.cls}-edge${inWork ? ' is-locked' : ''}">
      <div class="zc-head">
        <h3 class="zc-num">${escapeHtml(z.number)}</h3>
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
      fetch('/api/podbor/load?client=' + encodeURIComponent(z.client)),
      fetch('/api/podbor/ship-boxes?zayavka=' + encodeURIComponent(z.number))
    ]);
    if (!loadRes.ok) throw new Error('load: ' + await loadRes.text());
    const data = await loadRes.json();
    const shipData = shipRes.ok ? await shipRes.json() : { boxes: [] };
    state.loadMs = Date.now() - t0;

    state.allGroups = data.groups || [];
    state.availability = data.availability || {};
    state.visibleGroups = state.allGroups.filter(g => (state.requestByBar5[g.bar5] || 0) > 0);
    state.shipBoxes = shipData.boxes || [];

    state.allRowsFlat = [];
    state.allGroups.forEach(g => {
      g.rows.forEach(r => state.allRowsFlat.push({ ...r, bar5: g.bar5, color: g.color }));
    });

    state.visibleRowsFlat = [];
    state.visibleGroups.forEach((g, gi) => {
      g._startIdx = state.visibleRowsFlat.length;
      g.rows.forEach(r => {
        state.visibleRowsFlat.push({ ...r, groupIndex: gi, bar5: g.bar5, color: g.color });
      });
    });

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
  if (!z) { $('zayavkaBar').innerHTML = ''; return; }
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
      ${createBoxesBtnHtml}
    </div>
  `;
  const btn = $('btnCreateBoxes');
  if (btn) btn.addEventListener('click', openCreateBoxesModal);
}

// ========== Pagination by bar5 group ==========
// Одна страница = одна BAR5-группа. Заявки обычно содержат ≤ 10 уникальных
// баркодов, поэтому подобный «один-баркод-в-фокусе» режим работает на
// планшете, телефоне и ТСД одинаково. Свайп влево/вправо — следующая группа.
function paginateGroups(groups) {
  return groups.map(g => ({ groups: [g], rowsCount: g.rows.length }));
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
  bar.innerHTML = `
    <button class="pager-nav" data-step="-1" ${state.currentPage===0 ? 'disabled' : ''} title="Предыдущий баркод">←</button>
    <div class="pager-tiles">${tiles}</div>
    <button class="pager-nav" data-step="1" ${state.currentPage>=state.pages.length-1 ? 'disabled' : ''} title="Следующий баркод">→</button>
  `;
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
      <col class="col-addr"><col class="col-box">
      <col class="col-tara"><col class="col-status"><col class="col-sku"><col class="col-tip">
      <col class="col-mp"><col class="col-qty"><col class="col-vsego"><col class="col-kolsku">
      <col class="col-layout">
    </colgroup>`;
  const head = `
    <thead>
      <tr>
        <th>Адрес</th><th>Короб</th><th>Тара</th><th>Статус</th>
        <th class="col-sku-th">SKU</th><th class="col-tip-th">Тип</th><th class="col-mp-th">МП</th>
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
        </div>
        <div class="grp-counters">${counters}</div>
      </div>`;
    const dataRows = visibleRows.map(renderRow).join('');
    html += summary + `<table class="boxes-table">${colgroup}${head}<tbody>${dataRows}</tbody></table>`;
  });

  $('canvas').innerHTML = html;
  $('canvas').querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => {
      const boxId = tr.dataset.korob;
      if (boxId) openBoxModal(boxId);
    });
  });
}

function renderRow(r) {
  const statusKey = String(r.status || '').trim().toUpperCase();
  const cls = STATUS_CLASS[statusKey] || 'badge-other';
  const layoutBadge = renderLayoutBadge(r.korob, r.barcode, r.qty);
  return `
    <tr class="row" data-korob="${escapeHtml(r.korob)}" data-barcode="${escapeHtml(r.barcode)}" title="Открыть короб">
      <td class="cell-center col-addr-td">${escapeHtml(r.adr)}</td>
      <td class="cell-center cell-korob">${escapeHtml(r.korob)}</td>
      <td class="cell-center col-tara-td">${escapeHtml(r.tara)}</td>
      <td class="cell-center col-status-td">${r.status ? `<span class="badge ${cls}">${escapeHtml(r.status)}</span>` : ''}</td>
      <td class="col-sku-td">${escapeHtml(r.sku)}</td>
      <td class="col-tip-td cell-center">${escapeHtml(r.tip)}</td>
      <td class="col-mp-td cell-center">${escapeHtml(r.mp)}</td>
      <td class="cell-num">${r.qty || ''}</td>
      <td class="cell-num col-vsego-td">${r.vsegoVKor || ''}</td>
      <td class="cell-num col-kolsku-td">${r.kolSku || ''}</td>
      <td class="cell-right col-layout-td">${layoutBadge}</td>
    </tr>`;
}

function renderBarcode(barcode) {
  const s = String(barcode || '');
  if (!s) return '';
  if (s.length <= 5) return `<span class="barcode-tail">${escapeHtml(s)}</span>`;
  return `<span class="barcode-prefix">${escapeHtml(s.slice(0, -5))}</span><span class="barcode-tail">${escapeHtml(s.slice(-5))}</span>`;
}

function renderLayoutBadge(boxId, barcode, qty) {
  const slot = (state.boxLayouts[boxId] || {})[barcode];
  if (!slot) return '<span class="layout-badge layout-empty" title="Не разложено">—</span>';
  const podb = Number(slot.kolPodb) || 0;
  const perem = Number(slot.kolPerem) || 0;
  const ost = Math.max(0, qty - podb - perem);
  if (podb === qty && perem === 0) return `<span class="layout-badge layout-full" title="Весь баркод на отгрузку">📦${podb}</span>`;
  if (podb > 0 && perem > 0) return `<span class="layout-badge layout-mixed" title="${podb}→📦 ${perem}→🗄️ ${ost}→ост">${podb}/${perem}/${ost}</span>`;
  if (podb > 0) return `<span class="layout-badge layout-podb" title="${podb}→📦 ${ost}→ост">${podb}→📦</span>`;
  if (perem > 0) return `<span class="layout-badge layout-perem" title="${perem}→🗄️ ${ost}→ост">${perem}→🗄️</span>`;
  return '<span class="layout-badge layout-empty">—</span>';
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
  const saved = state.boxLayouts[boxId] || {};
  const draft = {};
  for (const r of rows) {
    draft[r.barcode] = saved[r.barcode]
      ? { ...saved[r.barcode] }
      : { kolPodb: 0, kudaPodb: '', kolPerem: 0, kudaPerem: '' };
  }
  state.modalBox = { boxId, rows, draft };

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

  // В КОР кнопка ПОЛН КОРОБ всегда видна (это единственное действие). В других
  // режимах — обычная логика. Если в КОР короб уже выбран целиком — кнопку
  // делаем informational, без возможности «снять».
  const fullBoxBtnHtml = isKorMode()
    ? (m.fullBoxMode
        ? `<span class="bm-fullbox-btn active is-fixed" title="В режиме КОР короб берётся только целиком">✓ ПОЛН КОРОБ</span>`
        : `<button type="button" id="bmFullBox"
            class="bm-fullbox-btn${fullBoxCheck.ok ? '' : ' disabled'}"
            ${fullBoxCheck.ok ? '' : `disabled title="${escapeHtml(fullBoxCheck.reason)}"`}>
            📦 Взять короб целиком
          </button>`)
    : `<button type="button" id="bmFullBox"
        class="bm-fullbox-btn${m.fullBoxMode ? ' active' : ''}${fullBoxCheck.ok ? '' : ' disabled'}"
        ${fullBoxCheck.ok ? '' : `disabled title="${escapeHtml(fullBoxCheck.reason)}"`}>
        ${m.fullBoxMode ? '✓ ПОЛН КОРОБ → отгрузка' : '📦 Весь короб → отгрузка'}
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
    const requested = Number(state.requestByBarcode[r.barcode] || 0);
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
  const requested = Number(state.requestByBarcode[r.barcode] || 0);
  const picked = pickedByBarcode(r.barcode);
  const still = Math.max(0, requested - picked);
  const ost = Math.max(0, r.qty - (Number(slot.kolPodb) || 0) - (Number(slot.kolPerem) || 0));
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
        <div class="bc-qty">КОЛ: <b>${r.qty}</b></div>
        ${reqHtml}
      </header>
      <div class="bc-slots">
        ${renderSlotPodb(r.barcode, slot, r.qty, requested, picked)}
        ${renderSlotPerem(r.barcode, slot, r.qty, r.spisYach)}
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
      <label>🗄️ В ячейку</label>
      <div class="slot-body">
        <div class="num-row">
          <button type="button" class="num-btn" data-step="-1" data-bar="${escapeHtml(barcode)}" data-slot="perem" aria-label="−1">−</button>
          <input type="number" min="0" max="${max}" step="1" value="${kol}"
                 data-bar="${escapeHtml(barcode)}" data-slot="perem" inputmode="numeric">
          <button type="button" class="num-btn" data-step="1" data-bar="${escapeHtml(barcode)}" data-slot="perem" aria-label="+1">+</button>
        </div>
        <input type="text" class="slot-target" placeholder="код ячейки или скан QR"
               value="${escapeHtml(kuda)}"
               data-bar="${escapeHtml(barcode)}" data-slot="perem-kuda">
        ${cellsHtml}
      </div>
    </div>`;
}

function renderShipTiles(barcode, selectedNumber) {
  if (state.shipBoxes.length === 0) {
    return `<div class="ship-empty">
      Коробов нет.
      <button type="button" class="create-ship-link">Создать →</button>
    </div>`;
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
  return `<div class="ship-tiles">${tiles}</div>${fullName}`;
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

function onSlotInput(inp) {
  if (isKorMode()) { korBlockToast(); renderBoxModal(); return; }
  const bar = inp.dataset.bar;
  const slot = inp.dataset.slot;
  if (!bar || !slot) return;
  if (noPeremMode() && (slot === 'perem' || slot === 'perem-kuda')) {
    toast('Перемещение в ячейку запрещено в этом режиме сборки (КОР / КОР+).', true);
    renderBoxModal();
    return;
  }
  const d = ensureDraftSlot(bar);
  if (!d) return;
  if (slot === 'podb') {
    const newVal = clampQty(Number(inp.value), bar);
    const row = state.modalBox.rows.find(r => r.barcode === bar);
    if (row && newVal > 0 && newVal < row.qty) {
      const check = korPlusCanPartial(row);
      if (!check.ok) { toast(check.reason, true); renderBoxModal(); return; }
    }
    d.kolPodb = newVal;
  }
  else if (slot === 'perem') d.kolPerem = clampQty(Number(inp.value), bar);
  else if (slot === 'podb-kuda') d.kudaPodb = String(inp.value || '');
  else if (slot === 'perem-kuda') d.kudaPerem = String(inp.value || '');
  renderBoxModal();
}

function clampQty(n, bar) {
  if (!Number.isFinite(n) || n < 0) return 0;
  const row = state.modalBox && state.modalBox.rows.find(r => r.barcode === bar);
  const max = row ? row.qty : 0;
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
  const max = row ? row.qty : 0;
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
  if (isKorMode()) { korBlockToast(); return; }
  const bar = btn.dataset.bar;
  const number = btn.dataset.shipNumber;
  if (!bar || !number) return;
  const d = ensureDraftSlot(bar);
  if (!d) return;
  // Toggle: если уже выбран — снимаем; иначе — устанавливаем.
  if (d.kudaPodb === number) d.kudaPodb = '';
  else d.kudaPodb = number;
  renderBoxModal();
}

async function saveBoxModal() {
  if (!state.modalBox) return;
  const { boxId, draft } = state.modalBox;
  state.boxLayouts[boxId] = JSON.parse(JSON.stringify(draft));
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
  const btnTara = t.closest('button[data-cbm-tara]');
  if (btnTara) {
    if (state.modalCreateBoxes) state.modalCreateBoxes.taraType = btnTara.dataset.cbmTara;
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

async function deleteShipBox(number) {
  if (!number || !state.activeZayavka) return;
  const used = shipBoxUsedSet();
  if (used.has(number)) {
    toast(`Короб ${number} уже используется в раскладке — удалить нельзя`, true);
    return;
  }
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{ type: 'ship.delete', zayavkaId: state.activeZayavka.number, number }]
      })
    });
    if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const result = (data.results && data.results[0]) || {};
    if (!result.ok) throw new Error(result.error || 'unknown');
    state.shipBoxes = state.shipBoxes.filter(b => b.number !== number);
    toast(`Короб ${number} удалён`);
    renderCreateBoxesModal();
    renderZayavkaBar();
    if (state.modalBox) renderBoxModal();
  } catch (e) {
    toast('Ошибка удаления: ' + e.message, true);
  }
}

function handleCreateBoxesInput(e) {
  const inp = e.target.closest('input[data-cbm-count]');
  if (inp && state.modalCreateBoxes) {
    state.modalCreateBoxes.count = Math.max(1, Math.min(200, Number(inp.value) || 1));
    // Не вызываем renderCreateBoxesModal — иначе курсор прыгает; обновляется при step/quick-buttons.
  }
}

function openCreateBoxesModal() {
  if (!state.activeZayavka) { toast('Сначала откройте заявку', true); return; }
  if (isKorMode()) { korBlockToast(); return; }
  state.modalCreateBoxes = { count: 5, taraType: 'К_1.0' };
  renderCreateBoxesModal();
  document.body.classList.add('modal-open');
}

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
  const TARAS = ['К_0.5', 'К_1.0', 'ПАЛ'];
  const existingCount = state.shipBoxes.length;
  const prefix = (z.number.match(/^([SR]\d+)/) || [null, z.number.slice(0, 5)])[1];
  const previewStart = existingCount + 1;
  const previewEnd = existingCount + m.count;
  const used = shipBoxUsedSet();

  // Список существующих коробов с возможностью удалить (если не использован).
  const listHtml = state.shipBoxes.length === 0
    ? '<div class="cbm-empty">Коробов ещё нет. Создайте первые.</div>'
    : `<div class="cbm-list">${
        state.shipBoxes.map(b => {
          const isUsed = used.has(b.number);
          const delAttr = isUsed ? 'disabled title="Используется в раскладке"' : `data-cbm-del="${escapeHtml(b.number)}" title="Удалить ${escapeHtml(b.number)}"`;
          return `
            <div class="cbm-row${isUsed ? ' is-used' : ''}">
              <span class="cbm-row-short">${b.short}</span>
              <span class="cbm-row-number">${escapeHtml(b.number)}</span>
              <span class="cbm-row-tara">${escapeHtml(b.taraType)}</span>
              ${isUsed ? '<span class="cbm-row-used">в раскладке</span>' : '<span class="cbm-row-spacer"></span>'}
              <button type="button" class="cbm-del" ${delAttr}>🗑</button>
            </div>`;
        }).join('')
      }</div>`;

  const quickBtns = QUICK.map(n =>
    `<button type="button" class="cbm-quick${n === m.count ? ' active' : ''}" data-cbm-count="${n}">${n}</button>`
  ).join('');
  const taraBtns = TARAS.map(t =>
    `<button type="button" class="cbm-tara${t === m.taraType ? ' active' : ''}" data-cbm-tara="${escapeHtml(t)}">${escapeHtml(t)}</button>`
  ).join('');

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
        <div class="cbm-field">
          <div class="cbm-tara-row">${taraBtns}</div>
        </div>
        <div class="cbm-preview">
          Будут созданы:
          <b>${prefix}-${String(previewStart).padStart(3, '0')}</b>
          ${m.count > 1 ? ` … <b>${prefix}-${String(previewEnd).padStart(3, '0')}</b>` : ''}
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
}

async function submitCreateBoxes() {
  const m = state.modalCreateBoxes;
  const z = state.activeZayavka;
  if (!m || !z) return;
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{ type: 'ship.create', zayavkaId: z.number, count: m.count, taraType: m.taraType }]
      })
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
      const res = await fetch('/api/podbor/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: batch })
      });
      if (!res.ok && res.status !== 207) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.some(r => !r.ok)) {
        const firstFail = data.results.find(r => !r.ok);
        throw new Error(firstFail.error || 'partial sync failure');
      }
      setSyncIndicator('synced');
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
}

function backToStart() {
  state.activeZayavka = null;
  state.allGroups = [];
  state.visibleGroups = [];
  state.allRowsFlat = [];
  state.visibleRowsFlat = [];
  state.pages = [];
  state.boxLayouts = {};
  state.shipBoxes = [];
  state.requestByBar5 = {};
  state.requestByBarcode = {};
  switchView('start');
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
  try {
    const res = await fetch('/api/podbor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{
          type: 'box.inventory_correction',
          boxId: m.boxId, barcode: m.barcode,
          novKol: m.newQty, oldKol: m.oldQty, reason: m.reason
        }]
      })
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
function fullBoxAvailable() {
  if (!state.modalBox) return { ok: false, reason: 'нет короба' };
  for (const r of state.modalBox.rows) {
    const need = Number(state.requestByBarcode[r.barcode] || 0);
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

$('backBtn').addEventListener('click', backToStart);

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

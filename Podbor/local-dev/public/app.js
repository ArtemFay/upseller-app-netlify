/* eslint-disable no-undef */
const $ = (id) => document.getElementById(id);

// ========== Global state ==========
const state = {
  view: 'start',           // 'start' | 'polotno'
  user: { email: 'dev@local', name: 'Артём', surname: 'Файзулов', role: 'picker' }, // mock until auth
  zayavki: [],             // all active заявки from /api/zayavki-list
  clients: [],             // [{name, count}]
  clientFilter: '',
  activeZayavka: null,     // when in polotno
  requestByBar5: {},       // bar5 -> requested qty (for active заявка)
  // polotno data
  allRows: [],
  allGroups: [],           // raw from /api/load
  visibleGroups: [],       // post-filter (only those in active zayavka)
  availability: {},        // barcode -> available count
  pages: [],
  currentPage: 0,
  loadMs: null
};

// ========== Status badges ==========
const STATUS_CLASS = {
  'ГОТОВО': 'badge-gotovo',
  'ХРАНЕНИЕ': 'badge-hranenie',
  'СОБРАНО': 'badge-sobrano',
  'В РЕЗЕРВЕ': 'badge-rezerve',
  'В ПРИЕМКЕ': 'badge-priemke',
  'В УПАКОВКЕ': 'badge-upakovke',
  'БРАК': 'badge-brak',
  'ОТГРУЖЕНО': 'badge-otgr',
  'СПИСАНО': 'badge-spis',
  'ИЗЪЯТО': 'badge-izyato',
  'ОБЕЗЛИЧКА': 'badge-obez'
};

// заявка-status badges
const Z_STATUS_CLASS = {
  'СОЗДАНО': 'zb-created',
  'В РАБОТЕ': 'zb-progress',
  'ЧАСТИЧНО СОБРАНА': 'zb-partial'
};
const Z_STATUS_RANK = {
  'ЧАСТИЧНО СОБРАНА': 1,
  'СОЗДАНО': 2,
  'В РАБОТЕ': 3
};

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
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pluralStrok(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки';
  return 'строк';
}

function pluralZayavok(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'заявка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'заявки';
  return 'заявок';
}

function buildRequestByBar5(items) {
  const m = {};
  for (const it of items || []) {
    const b5 = String(it.barcode).slice(-5);
    m[b5] = (m[b5] || 0) + Number(it.qty || 0);
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

// ========== User identity ==========
function renderUser() {
  const u = state.user;
  const initials = ((u.name || '?')[0] || '?') + (u.surname ? '' : '');
  const short = u.surname ? `${u.name} ${u.surname[0]}.` : u.name;
  $('userAvatar').textContent = (u.name?.[0] || '?').toUpperCase();
  $('userName').textContent = short;
}

// ========== Start screen ==========

async function loadZayavkiList() {
  try {
    const res = await fetch('/api/zayavki-list');
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
    // within same status — by date отгрузки ascending
    return String(a.dateOtgr).localeCompare(String(b.dateOtgr));
  });

  $('startStats').textContent = `${filtered.length} ${pluralZayavok(filtered.length)}`;

  const grid = $('zayavkiGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="placeholder">Нет активных заявок' + (state.clientFilter ? ' для выбранного клиента' : '') + '.</div>';
    return;
  }

  grid.innerHTML = filtered.map(z => renderZayavkaCard(z)).join('');
  // bind click handlers
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
  const direction = [z.dateOtgr, z.mp || 'НЕТ', z.warehouse, z.finalWarehouse]
    .filter(Boolean).join(' · ');
  const buttonHtml = inWork
    ? `<button class="zayavka-btn disabled" disabled>Занято${z.lockedBy ? ` (${escapeHtml(z.lockedBy)})` : ''}</button>`
    : `<button class="zayavka-btn primary" data-action="start" data-num="${escapeHtml(z.number)}">Начать →</button>`;

  return `
    <article class="zayavka-card${inWork ? ' is-locked' : ''}">
      <div class="zc-head">
        <h3 class="zc-num">${escapeHtml(z.number)}</h3>
        <span class="zc-status ${cls}">${escapeHtml(z.status)}</span>
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
  switchView('polotno');
  $('canvas').innerHTML = '<div class="placeholder">Загрузка коробов клиента…</div>';
  renderZayavkaBar();

  try {
    const t0 = Date.now();
    const res = await fetch('/api/load?client=' + encodeURIComponent(z.client));
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.loadMs = Date.now() - t0;

    state.allGroups = data.groups || [];
    state.availability = data.availability || {};

    // Filter groups: keep only those whose bar5 is in the request
    state.visibleGroups = state.allGroups.filter(g => (state.requestByBar5[g.bar5] || 0) > 0);

    // Flatten allRows for visible groups (preserving _startIdx within visibleGroups frame)
    state.allRows = [];
    state.visibleGroups.forEach((g, gi) => {
      g._startIdx = state.allRows.length;
      g.rows.forEach(r => {
        state.allRows.push({
          ...r,
          rowId: state.allRows.length + 1,
          groupIndex: gi,
          bar5: g.bar5,
          color: g.color,
          verified: false,
          syncStatus: 'connected',
          dirty: false
        });
      });
    });

    setMeta({
      client: z.client,
      boxes: countUniqueBoxes(),
      uniqueSku: z.skuCount,
      totalQty: z.unitsTotal,
      lines: state.allRows.length,
      loadMs: state.loadMs
    });

    state.pages = paginateGroups(state.visibleGroups);
    state.currentPage = 0;
    renderCurrentPage();
    toast(`Полотно: ${state.visibleGroups.length} баркодов · ${state.allRows.length} строк`);
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, true);
    $('canvas').innerHTML = `<div class="placeholder">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function countUniqueBoxes() {
  const set = new Set();
  for (const r of state.allRows) if (r.korob) set.add(r.korob);
  return set.size;
}

function setMeta({ client = '—', boxes = 0, uniqueSku = 0, totalQty = 0, lines = 0, loadMs }) {
  $('m-client').textContent = client;
  $('m-boxes').textContent = boxes;
  $('m-sku').textContent = uniqueSku;
  $('m-qty').textContent = totalQty;
  $('m-lines').textContent = lines;
  $('m-ms').textContent = loadMs !== undefined ? `${loadMs} мс` : '—';
  updateVerifiedCount();
}

function updateVerifiedCount() {
  const v = state.allRows.filter(r => r.verified).length;
  $('m-verified').textContent = `${v} / ${state.allRows.length}`;
}

function renderZayavkaBar() {
  const z = state.activeZayavka;
  if (!z) { $('zayavkaBar').innerHTML = ''; return; }
  const cls = Z_STATUS_CLASS[z.status] || 'zb-other';
  const ks = z.ks !== 1 ? `<span class="zb-ks">×${z.ks}</span>` : '';
  const dir = [z.dateOtgr, z.mp || 'НЕТ', z.warehouse, z.finalWarehouse].filter(Boolean).join(' · ');
  $('zayavkaBar').innerHTML = `
    <div class="zb-main">
      <span class="zb-num">${escapeHtml(z.number)}</span>
      <span class="zc-status ${cls}">${escapeHtml(z.status)}</span>
      ${ks}
      <span class="zb-client">${escapeHtml(z.client)}</span>
      <span class="zb-dir">${escapeHtml(dir)}</span>
    </div>
    <div class="zb-stats">
      СКЮ: <b>${z.skuCount}</b> · Ед: <b>${z.unitsTotal}</b>
    </div>
  `;
}

// ========== Smart pagination (unchanged) ==========
const PAGE_TARGET = 50, PAGE_MIN = 35, PAGE_MAX = 65;

function paginateGroups(groups) {
  const out = [];
  let cur = { groups: [], rowsCount: 0 };
  for (const g of groups) {
    const gSize = g.rows.length;
    if (gSize >= PAGE_MAX) {
      if (cur.groups.length) out.push(cur);
      out.push({ groups: [g], rowsCount: gSize });
      cur = { groups: [], rowsCount: 0 };
      continue;
    }
    if (!cur.groups.length) { cur.groups.push(g); cur.rowsCount = gSize; continue; }
    const ifAdded = cur.rowsCount + gSize;
    if (ifAdded <= PAGE_MAX) {
      if (cur.rowsCount < PAGE_MIN) {
        cur.groups.push(g); cur.rowsCount = ifAdded;
      } else {
        const distNow = Math.abs(cur.rowsCount - PAGE_TARGET);
        const distAfter = Math.abs(ifAdded - PAGE_TARGET);
        if (distAfter <= distNow) { cur.groups.push(g); cur.rowsCount = ifAdded; }
        else { out.push(cur); cur = { groups: [g], rowsCount: gSize }; }
      }
    } else {
      out.push(cur); cur = { groups: [g], rowsCount: gSize };
    }
  }
  if (cur.groups.length) out.push(cur);
  return out;
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
  const page = state.pages[state.currentPage];
  const buttons = state.pages.map((p, i) => {
    const cls = 'pager-btn' + (i === state.currentPage ? ' active' : '');
    const label = p.groups.length === 1 ? p.groups[0].bar5 : `${p.groups[0].bar5}…${p.groups[p.groups.length-1].bar5}`;
    return `<button class="${cls}" data-page="${i}" title="${escapeHtml(label)} · ${p.rowsCount} строк">${i+1}</button>`;
  }).join('');
  bar.innerHTML = `
    <button class="pager-nav" data-step="-1" ${state.currentPage===0 ? 'disabled' : ''}>← Пред.</button>
    <span class="pager-info">Стр. ${state.currentPage + 1} / ${state.pages.length} · ${page.rowsCount} строк · ${page.groups.length} баркод(ов)</span>
    <span class="pager-buttons">${buttons}</span>
    <button class="pager-nav" data-step="1" ${state.currentPage>=state.pages.length-1 ? 'disabled' : ''}>След. →</button>
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

function renderCanvas(groups) {
  if (!groups || !groups.length) {
    $('canvas').innerHTML = '<div class="placeholder">Нет данных для отображения.</div>';
    return;
  }
  const colgroup = `
    <colgroup>
      <col class="col-sync"><col class="col-addr"><col class="col-cells"><col class="col-box">
      <col class="col-tara"><col class="col-status"><col class="col-sku"><col class="col-tip">
      <col class="col-mp"><col class="col-qty"><col class="col-vsego"><col class="col-kolsku">
      <col class="col-barcode"><col class="col-check">
    </colgroup>`;
  const head = `
    <thead>
      <tr>
        <th class="cell-center" title="Синхронизация">⇅</th>
        <th>Адрес</th><th>Другие ячейки</th><th>Короб</th><th>Тара</th><th>Статус</th>
        <th class="col-sku-th">SKU</th><th class="col-tip-th">Тип</th><th class="col-mp-th">МП</th>
        <th>Кол</th><th>Все</th><th>Sku</th><th>Баркод</th><th class="cell-center">✓</th>
      </tr>
    </thead>`;
  let tbodies = '';
  groups.forEach((g) => {
    const start = g._startIdx ?? 0;
    const groupRowsInStore = state.allRows.slice(start, start + g.rows.length);
    const requested = state.requestByBar5[g.bar5] || 0;
    const available = availForGroup(g, state.availability);
    const picked = 0; // TODO: when layout is implemented, sum КОЛ ПОДБ here
    const stillNeeded = Math.max(0, Math.min(requested, available) - picked);
    const counters = `
      <span class="grp-cnt zayav">З: <b>${requested}</b></span>
      <span class="grp-cnt avail${available < requested ? ' warn' : ''}${available === 0 ? ' bad' : ''}">Д: <b>${available}</b></span>
      <span class="grp-cnt picked">С: <b>${picked}</b></span>
      <span class="grp-cnt still${stillNeeded === 0 ? ' done' : ''}">Ещё: <b>${stillNeeded}</b></span>`;
    const headerRow = `
      <tr class="group-row" style="background: ${g.color};">
        <td colspan="14">
          <span class="bar5">🏷️ BAR5: ${escapeHtml(g.bar5 || '—')}</span>
          <span class="counts">${g.rows.length} ${pluralStrok(g.rows.length)}</span>
          <span class="grp-counters">${counters}</span>
        </td>
      </tr>`;
    const dataRows = groupRowsInStore.map(renderRow).join('');
    tbodies += `<tbody>${headerRow}${dataRows}</tbody>`;
  });
  $('canvas').innerHTML = `<table class="boxes-table">${colgroup}${head}${tbodies}</table>`;
}

function renderRow(r) {
  const statusKey = String(r.status || '').trim().toUpperCase();
  const cls = STATUS_CLASS[statusKey] || 'badge-other';
  const cellsHtml = r.spisYach ? r.spisYach.split('\n').map(c => `<span class="k">${escapeHtml(c)}</span>`).join('<br>') : '';
  return `
    <tr class="row" data-row-id="${r.rowId}">
      <td class="cell-center">${renderSyncCell(r)}</td>
      <td class="cell-center">${escapeHtml(r.adr)}</td>
      <td class="cell-cells">${cellsHtml}</td>
      <td class="cell-center" style="font-weight:700;">${escapeHtml(r.korob)}</td>
      <td class="cell-center">${escapeHtml(r.tara)}</td>
      <td class="cell-center">${r.status ? `<span class="badge ${cls}">${escapeHtml(r.status)}</span>` : ''}</td>
      <td class="col-sku-td">${escapeHtml(r.sku)}</td>
      <td class="col-tip-td cell-center">${escapeHtml(r.tip)}</td>
      <td class="col-mp-td cell-center">${escapeHtml(r.mp)}</td>
      <td class="cell-num">${r.qty || ''}</td>
      <td class="cell-num">${r.vsegoVKor || ''}</td>
      <td class="cell-num">${r.kolSku || ''}</td>
      <td class="cell-code cell-center">${renderBarcode(r.barcode)}</td>
      <td class="cell-center">
        <input class="checkbox" type="checkbox" ${r.verified ? 'checked' : ''} onchange="toggleVerified(${r.rowId}, this.checked)">
      </td>
    </tr>`;
}

function renderBarcode(barcode) {
  const s = String(barcode || '');
  if (!s) return '';
  if (s.length <= 5) return `<span class="barcode-tail">${escapeHtml(s)}</span>`;
  return `<span class="barcode-prefix">${escapeHtml(s.slice(0, -5))}</span><span class="barcode-tail">${escapeHtml(s.slice(-5))}</span>`;
}

function renderSyncCell(r) {
  if (r.syncStatus === 'synced' && r.dirty === 'committed') {
    return `<span class="sync-changed" title="Синхронизировано (с изменениями)"></span>`;
  }
  const labels = { idle: 'Не синхронизировано', connected: 'Связано', syncing: 'Синхронизация…', synced: 'Синхронизировано', error: 'Ошибка' };
  const status = r.syncStatus || 'connected';
  return `<span class="sync-dot sync-${status}" title="${labels[status] || ''}"></span>`;
}

function setSyncStatus(rowId, status) {
  const row = state.allRows.find(r => r.rowId === rowId);
  if (!row) return;
  row.syncStatus = status;
  const td = document.querySelector(`tr[data-row-id="${rowId}"] td:first-child`);
  if (td) td.innerHTML = renderSyncCell(row);
}

// ========== SyncQueue (unchanged) ==========
const SyncQueue = {
  pending: [], inflight: null, debounceTimer: null,
  push(u) { this.pending.push(u); clearTimeout(this.debounceTimer); this.debounceTimer = setTimeout(() => this.flush(), 400); },
  async flush() {
    if (this.inflight || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    this.inflight = batch;
    batch.forEach(u => setSyncStatus(u.rowId, 'syncing'));
    try {
      const res = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates: batch }) });
      if (!res.ok) throw new Error(await res.text());
      batch.forEach(u => {
        const row = state.allRows.find(r => r.rowId === u.rowId);
        if (row) row.dirty = 'committed';
        setSyncStatus(u.rowId, 'synced');
      });
    } catch (err) {
      console.error('Sync error:', err);
      batch.forEach(u => setSyncStatus(u.rowId, 'error'));
      this.pending.unshift(...batch);
      setTimeout(() => this.flush(), 3000);
    } finally {
      this.inflight = null;
      if (this.pending.length > 0) this.flush();
    }
  }
};

window.toggleVerified = function(rowId, checked) {
  const row = state.allRows.find(r => r.rowId === rowId);
  if (!row) return;
  row.verified = Boolean(checked);
  row.dirty = true;
  updateVerifiedCount();
  SyncQueue.push({ rowId: row.rowId, korob: row.korob, barcode: row.barcode, verified: row.verified });
};

// ========== View management ==========
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
  state.allRows = [];
  state.allGroups = [];
  state.visibleGroups = [];
  state.pages = [];
  switchView('start');
}

// ========== Wire up ==========
$('clientFilter').addEventListener('change', (e) => {
  state.clientFilter = e.target.value;
  renderStartScreen();
});

$('backBtn').addEventListener('click', backToStart);

renderUser();
switchView('start');
loadZayavkiList();

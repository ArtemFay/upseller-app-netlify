/* eslint-disable no-undef */
'use strict';
// Detail-вью одной завершённой заявки. Read-only.
//
// URL: /podbor/archive-detail.html?file=<filename> | ?zayavka=<id>
// Backend: GET /api/podbor/archive-detail → { state, _filename }

const $ = (id) => document.getElementById(id);
const __u = (typeof window !== 'undefined' && window.__USER__) || {};

function renderUser() {
  $('userName').textContent = __u.name || __u.email || '—';
  const av = $('userAvatar');
  if (__u.picture) {
    av.innerHTML = '';
    const img = document.createElement('img');
    img.src = __u.picture; img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = (__u.name || __u.email || '?').slice(0, 1).toUpperCase();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м ${sec}с`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString('ru-RU');
}

const EVENT_META = {
  'zayavka.start':         { icon: '▶',  label: 'Старт заявки',   cls: 'ev-start' },
  'zayavka.finish':        { icon: '✓',  label: 'Финиш заявки',   cls: 'ev-finish' },
  'zayavka.close':         { icon: '⛔', label: 'Закрытие',       cls: 'ev-close' },
  'zayavka.partial_close': { icon: '⚠',  label: 'Частичное закрытие', cls: 'ev-close' },
  'set_layout':            { icon: '📦', label: 'Раскладка',      cls: 'ev-layout' },
  'full_to_ship':          { icon: '🔄', label: 'Полное изъятие', cls: 'ev-full' },
  'ship.create':           { icon: '📥', label: 'Создан короб',   cls: 'ev-ship' },
  'ship.delete':           { icon: '🗑', label: 'Удалён короб',   cls: 'ev-ship-del' },
  'inventory_correction':  { icon: '⚠',  label: 'Инвент-коррекция', cls: 'ev-inv' },
};

function describeEvent(ev) {
  switch (ev.type) {
    case 'zayavka.start':
      return `Сборщик: <b>${escapeHtml(ev.picker || ev.by || '—')}</b>`;
    case 'zayavka.finish':
      return `Режим: ${escapeHtml(ev.mode || '—')}`;
    case 'zayavka.close':
      return ev.reason ? `Причина: ${escapeHtml(ev.reason)}` : '';
    case 'zayavka.partial_close':
      return ev.reason ? `Причина: ${escapeHtml(ev.reason)}` : '';
    case 'set_layout': {
      const items = Array.isArray(ev.items) ? ev.items : [];
      const parts = items.map(i => {
        const where = i.kudaPodb ? ` → <b>${escapeHtml(i.kudaPodb)}</b>` : '';
        const moved = i.kudaPerem ? ` · перем → ${escapeHtml(i.kudaPerem)} (${i.kolPerem || 0})` : '';
        return `<code>${escapeHtml(i.barcode || '')}</code>${where} (${i.kolPodb || 0} шт)${moved}`;
      }).join('; ');
      return `Из <code>${escapeHtml(ev.source || '—')}</code>: ${parts || '—'}`;
    }
    case 'full_to_ship': {
      const items = Array.isArray(ev.items) ? ev.items : [];
      const total = items.reduce((a, b) => a + (b.qty || 0), 0);
      return `<code>${escapeHtml(ev.source || '—')}</code> → <b>${escapeHtml(ev.newKorob || '—')}</b> (${total} шт, ${items.length} SKU)`;
    }
    case 'ship.create':
      return `<b>${escapeHtml(ev.number || '')}</b> · ${escapeHtml(ev.taraType || '')}` +
        (ev.dimensions ? ` · ${ev.dimensions.w}×${ev.dimensions.h}×${ev.dimensions.d}` : '') +
        (ev.owner ? ` · ${escapeHtml(ev.owner)}` : '');
    case 'ship.delete':
      return `<b>${escapeHtml(ev.number || '')}</b>`;
    case 'inventory_correction':
      return `<code>${escapeHtml(ev.korob || '—')}/${escapeHtml(ev.barcode || '—')}</code>: ${ev.oldQty}→${ev.newQty}` +
        (ev.reason ? ` (${escapeHtml(ev.reason)})` : '');
    default:
      try { return `<pre class="ev-raw">${escapeHtml(JSON.stringify(ev))}</pre>`; }
      catch { return ''; }
  }
}

function renderHeader(state) {
  const m = state.meta || {};
  const durationMs = (m.startedAt && m.finishedAt) ? (m.finishedAt - m.startedAt) : null;
  return `
    <section class="arch-head">
      <div class="arch-head-top">
        <h1>${escapeHtml(state.zayavkaId || '—')}</h1>
        <span class="arch-badge arch-badge-status">${escapeHtml(m.status || '—')}</span>
      </div>
      <div class="arch-head-grid">
        <div><span class="arch-k">Клиент</span><span class="arch-v">${escapeHtml(m.client || '—')}</span></div>
        <div><span class="arch-k">МП</span><span class="arch-v">${escapeHtml(m.mp || '—')}</span></div>
        <div><span class="arch-k">КС</span><span class="arch-v">${escapeHtml(m.ks || 1)}</span></div>
        <div><span class="arch-k">Дата отгр.</span><span class="arch-v">${escapeHtml(m.dateOtgr || '—')}</span></div>
        <div><span class="arch-k">Склад</span><span class="arch-v">${escapeHtml(m.warehouse || '—')}</span></div>
        <div><span class="arch-k">Финальный</span><span class="arch-v">${escapeHtml(m.finalWarehouse || '—')}</span></div>
        <div><span class="arch-k">Сборщик(и)</span><span class="arch-v">${escapeHtml((m.pickers || []).join(', ') || '—')}</span></div>
        <div><span class="arch-k">Создано</span><span class="arch-v">${escapeHtml(fmtDateTime(m.createdAt))}</span></div>
        <div><span class="arch-k">Начато</span><span class="arch-v">${escapeHtml(fmtDateTime(m.startedAt))}</span></div>
        <div><span class="arch-k">Финиш</span><span class="arch-v">${escapeHtml(fmtDateTime(m.finishedAt))}</span></div>
        <div><span class="arch-k">Длит.</span><span class="arch-v">${escapeHtml(fmtDuration(durationMs))}</span></div>
      </div>
    </section>`;
}

function renderRequest(state) {
  const items = (state.request && state.request.items) || [];
  if (!items.length) return '';
  const rows = items.map(it => `
    <tr>
      <td><code>${escapeHtml(it.barcode || '')}</code></td>
      <td class="arch-num">${it.qty || 0}</td>
      <td>${escapeHtml(it.sku || '')}</td>
    </tr>`).join('');
  return `
    <section class="arch-section">
      <h2>Запрос</h2>
      <table class="arch-table arch-table-compact">
        <thead><tr><th>Баркод</th><th class="arch-num">Кол-во</th><th>SKU</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderTimeline(state) {
  const events = Array.isArray(state.events) ? state.events.slice() : [];
  if (!events.length) {
    return `<section class="arch-section"><h2>Лента событий</h2><div class="arch-placeholder">Событий нет.</div></section>`;
  }
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const rows = events.map(ev => {
    const meta = EVENT_META[ev.type] || { icon: '•', label: ev.type, cls: 'ev-other' };
    return `
      <li class="ev-row ${meta.cls}">
        <span class="ev-icon">${meta.icon}</span>
        <span class="ev-ts" title="${escapeHtml(fmtDateTime(ev.ts))}">${escapeHtml(fmtTime(ev.ts))}</span>
        <span class="ev-type">${escapeHtml(meta.label)}</span>
        <span class="ev-by">${escapeHtml(ev.by || '—')}</span>
        <span class="ev-desc">${describeEvent(ev)}</span>
      </li>`;
  }).join('');
  return `
    <section class="arch-section">
      <h2>Лента событий <span class="arch-stats">(${events.length})</span></h2>
      <ul class="arch-timeline">${rows}</ul>
    </section>`;
}

function renderNach(state) {
  const nach = (state.computed && state.computed.nach) || {};
  const paid = Object.entries(nach.paidByBarcode || {})
    .map(([barcode, info]) => ({ barcode, ...info }))
    .sort((a, b) => (b.charge || 0) - (a.charge || 0));
  const free = Object.entries(nach.freeByBarcode || {})
    .map(([barcode, info]) => ({ barcode, ...info }))
    .sort((a, b) => (b.qty || 0) - (a.qty || 0));
  const freeUnits = free.reduce((a, b) => a + (b.qty || 0), 0);

  const paidRows = paid.length
    ? paid.map(p => `<tr><td><code>${escapeHtml(p.barcode)}</code></td><td>${escapeHtml(p.sku || '')}</td><td class="arch-num">${p.qty || 0}</td><td class="arch-num">${fmtMoney(p.charge)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="arch-placeholder">Платных позиций нет.</td></tr>`;
  const freeRows = free.length
    ? free.map(p => `<tr><td><code>${escapeHtml(p.barcode)}</code></td><td>${escapeHtml(p.sku || '')}</td><td class="arch-num">${p.qty || 0}</td></tr>`).join('')
    : `<tr><td colspan="3" class="arch-placeholder">Бесплатных позиций нет.</td></tr>`;
  return `
    <section class="arch-section">
      <h2>Начисления</h2>
      <div class="arch-nach-summary">
        <div><span class="arch-k">Итого ₽</span><span class="arch-v arch-money">${fmtMoney(nach.totalCharge)}</span></div>
        <div><span class="arch-k">Ставка</span><span class="arch-v">${fmtMoney(nach.ratePerUnit || 0)} ₽/ед</span></div>
        <div><span class="arch-k">КС</span><span class="arch-v">${escapeHtml(nach.ks || state.meta.ks || 1)}</span></div>
        <div><span class="arch-k">Платных ед</span><span class="arch-v">${nach.totalPaidUnits || 0}</span></div>
        <div><span class="arch-k">Бесплатных ед</span><span class="arch-v">${freeUnits}</span></div>
      </div>
      <h3>Платные позиции</h3>
      <table class="arch-table arch-table-compact">
        <thead><tr><th>Баркод</th><th>SKU</th><th class="arch-num">Кол-во</th><th class="arch-num">Сбор, ₽</th></tr></thead>
        <tbody>${paidRows}</tbody>
      </table>
      <h3>Бесплатные позиции</h3>
      <table class="arch-table arch-table-compact">
        <thead><tr><th>Баркод</th><th>SKU</th><th class="arch-num">Кол-во</th></tr></thead>
        <tbody>${freeRows}</tbody>
      </table>
    </section>`;
}

function renderShipBoxes(state) {
  const boxes = Array.isArray(state.shipBoxes) ? state.shipBoxes : [];
  if (!boxes.length) {
    return `<section class="arch-section"><h2>Коробы отгрузки</h2><div class="arch-placeholder">Коробов отгрузки нет.</div></section>`;
  }
  const rows = boxes.map(b => {
    const dims = b.dimensions ? `${b.dimensions.w}×${b.dimensions.h}×${b.dimensions.d}` : '—';
    return `<tr>
      <td><b>${escapeHtml(b.number || '')}</b></td>
      <td>${escapeHtml(b.tara || b.taraType || '—')}</td>
      <td>${escapeHtml(dims)}</td>
      <td>${escapeHtml(b.owner || '—')}</td>
      <td>${escapeHtml(fmtDateTime(b.createdAt))}</td>
      <td>${escapeHtml(b.createdBy || '—')}</td>
    </tr>`;
  }).join('');
  return `
    <section class="arch-section">
      <h2>Коробы отгрузки <span class="arch-stats">(${boxes.length})</span></h2>
      <table class="arch-table arch-table-compact">
        <thead><tr><th>Номер</th><th>Тара</th><th>Габариты</th><th>Владелец</th><th>Создан</th><th>Кем</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderSources(state) {
  const src = state.sourceOriginals || {};
  const keys = Object.keys(src);
  if (!keys.length) {
    return `<section class="arch-section"><h2>Источники (коробы-доноры)</h2><div class="arch-placeholder">Снэпшота источников нет.</div></section>`;
  }
  keys.sort();
  const rows = keys.map(k => {
    const o = src[k] || {};
    const items = o.items || {};
    const inner = Object.entries(items).map(([bc, qty]) => `<code>${escapeHtml(bc)}</code> × ${qty}`).join(', ');
    const total = Object.values(items).reduce((a, b) => a + (Number(b) || 0), 0);
    return `<tr>
      <td><b>${escapeHtml(k)}</b></td>
      <td>${escapeHtml(o.tara || '—')}</td>
      <td class="arch-num">${total}</td>
      <td>${inner || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <section class="arch-section">
      <h2>Источники (коробы-доноры) <span class="arch-stats">(${keys.length})</span></h2>
      <table class="arch-table arch-table-compact">
        <thead><tr><th>Короб</th><th>Тара</th><th class="arch-num">Всего</th><th>Содержимое</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

async function load() {
  const main = $('archDetail');
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  const zayavka = params.get('zayavka');
  if (!file && !zayavka) {
    main.innerHTML = `<div class="arch-placeholder arch-err">Не указан параметр file/zayavka в URL.</div>`;
    return;
  }
  const qs = new URLSearchParams();
  if (file) qs.set('file', file);
  else qs.set('zayavka', zayavka);

  try {
    const res = await fetch('/api/podbor/archive-detail?' + qs.toString());
    if (res.status === 404) {
      main.innerHTML = `<div class="arch-placeholder arch-err">Заявка не найдена в архиве.</div>`;
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const state = data.state;
    if (!state) throw new Error('пустой state');
    main.innerHTML =
      renderHeader(state) +
      renderRequest(state) +
      renderTimeline(state) +
      renderNach(state) +
      renderShipBoxes(state) +
      renderSources(state);
  } catch (e) {
    main.innerHTML = `<div class="arch-placeholder arch-err">Ошибка загрузки: ${escapeHtml(e.message)}</div>`;
  }
}

renderUser();
load();

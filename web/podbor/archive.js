/* eslint-disable no-undef */
'use strict';
// Архив завершённых заявок Подбора (read-only).
//
// GET /api/podbor/archive-list — лёгкий список (агрегированные мета).
// Клик по строке → /podbor/archive-detail.html?file=...

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

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function fmtMoney(n) {
  if (!n) return '0';
  return Number(n).toLocaleString('ru-RU');
}

function statusBadge(status) {
  const map = {
    'СОБРАНО':  { cls: 'badge-sobrano',  label: 'СОБРАНО' },
    'ЧАСТИЧНО СОБРАНА': { cls: 'badge-partial', label: 'ЧАСТИЧНО' },
    'ЗАКРЫТА':  { cls: 'badge-closed',   label: 'ЗАКРЫТА' },
    'ERROR':    { cls: 'badge-brak',     label: 'ОШИБКА ФАЙЛА' },
  };
  const m = map[status] || { cls: 'badge-other', label: status || '—' };
  return `<span class="arch-badge ${m.cls}">${escapeHtml(m.label)}</span>`;
}

async function loadList() {
  const params = new URLSearchParams();
  const client = $('fClient').value.trim();
  const from = $('fFrom').value;
  const to = $('fTo').value;
  if (client) params.set('client', client);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limit', '500');

  const tb = $('archTBody');
  tb.innerHTML = `<tr><td colspan="10" class="arch-placeholder">Загружаем…</td></tr>`;
  try {
    const res = await fetch('/api/podbor/archive-list?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const items = data.items || [];
    $('archStats').textContent = items.length
      ? `Найдено: ${items.length}${data.total > items.length ? ` из ${data.total}` : ''}`
      : 'Нет записей';
    if (!items.length) {
      tb.innerHTML = `<tr><td colspan="10" class="arch-placeholder">Архив пуст под текущие фильтры.</td></tr>`;
      return;
    }
    tb.innerHTML = items.map(it => {
      const href = `/podbor/archive-detail.html?file=${encodeURIComponent(it._filename)}`;
      return `
        <tr class="arch-row" data-href="${href}">
          <td>${escapeHtml(fmtDateTime(it.finishedAt))}</td>
          <td>
            <span class="arch-zid">${escapeHtml(it.zayavkaId || '—')}</span>
            ${statusBadge(it.status)}
          </td>
          <td>${escapeHtml(it.client || '—')}</td>
          <td>${escapeHtml(it.picker || '—')}</td>
          <td>${escapeHtml(it.mp || '—')}</td>
          <td class="arch-num">${escapeHtml(fmtDuration(it.durationMs))}</td>
          <td class="arch-num">${escapeHtml(fmtMoney(it.totalCharge))}</td>
          <td class="arch-num">${it.paidUnits || 0}</td>
          <td class="arch-num">${it.freeUnits || 0}</td>
          <td class="arch-num">${it.shipBoxCount || 0}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="10" class="arch-placeholder arch-err">Ошибка загрузки: ${escapeHtml(e.message)}</td></tr>`;
    $('archStats').textContent = '—';
  }
}

$('btnApply').addEventListener('click', loadList);
$('btnReset').addEventListener('click', () => {
  $('fClient').value = '';
  $('fFrom').value = '';
  $('fTo').value = '';
  loadList();
});
$('archTBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.arch-row');
  if (!tr) return;
  const href = tr.dataset.href;
  if (href) location.href = href;
});
['fClient', 'fFrom', 'fTo'].forEach(id => {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(); });
});

renderUser();
loadList();

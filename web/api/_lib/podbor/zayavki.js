// _lib/podbor/zayavki.js
// Загрузка и парсинг активных заявок из ПОДБОРЫ.БД_ЭКСП.
// Контракт документирован в 1_CONST/03_CURRENT_GAS_SYSTEM.md § 5.

import { getSheets } from '../google.js';
import { getPodborySpreadsheetId } from './spreadsheet-id.js';

// Парсер 'ЛОГ ЗАЯВКИ' (колонка J БД_ЭКСП).
// Формат: "<barcode>⁠ - ⁠<qty>⁠\n<barcode>⁠ - ⁠<qty>⁠\n..."
// Между токенами — невидимые символы U+2060 (WORD JOINER).
// Устойчивый парсер: сплит по \n, затем regex /\d+/g — берём первые два числа в строке.
export function parseLogZayavki(j) {
  return String(j || '')
    .split('\n')
    .map(line => line.match(/\d+/g))
    .filter(m => m && m.length >= 2)
    .map(([barcode, qty]) => ({ barcode: String(barcode), qty: Number(qty) }));
}

// КС (B) — RU-локаль десятичная (`1`, `0,6`). Default 1, отрицательные/0 → 1.
export function parseKs(b) {
  if (b === '' || b == null) return 1;
  const n = Number(String(b).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Унифицированный ключ заявки (CONTEXT.md § 3.3) — сейчас не используется в UI как
// основная навигация (карточки), но остаётся как label-формат для логов / ТСД-режима.
export function buildUnifiedKey({ number, client, dateOtgr, mp, finalWarehouse }) {
  const c5 = String(client || '').replace(/[\s.]+/g, '').slice(0, 5);
  const f2 = String(mp || '').toUpperCase() === 'НЕТ' ? 'НЕ' : String(mp || '').slice(0, 2);
  const h5 = String(finalWarehouse || '').slice(0, 5);
  return `${number}_${c5}_${dateOtgr}_${f2}_${h5}`;
}

// Тип заявки (P): ОТГ — отгрузка, ПЕР — перемаркировка. Default ОТГ.
export function normalizeType(p) {
  const v = String(p || '').trim().toUpperCase();
  if (v === 'ПЕР' || v === 'PER') return 'ПЕР';
  return 'ОТГ';
}

// Режим сборки (Q): СВОБ / КОР / КОР+. Default СВОБ.
export function normalizePickMode(q) {
  const v = String(q || '').trim().toUpperCase();
  if (v === 'КОР+' || v === 'KOR+') return 'КОР+';
  if (v === 'КОР'  || v === 'KOR')  return 'КОР';
  return 'СВОБ';
}

export async function loadActiveZayavki() {
  const id = getPodborySpreadsheetId();
  const sheets = getSheets();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: "'БД_ЭКСП'!A2:Q1000",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = r.data.values || [];
  return rows
    .filter(row => row[0] && row[2])
    .map(row => {
      const z = {
        client: String(row[0] || '').trim(),
        ks: parseKs(row[1]),
        number: String(row[2] || '').trim(),
        dateZay: String(row[3] || ''),
        dateOtgr: String(row[4] || ''),
        mp: String(row[5] || '').trim(),
        warehouse: String(row[6] || '').trim(),
        finalWarehouse: String(row[7] || '').trim(),
        comment: String(row[8] || ''),
        items: parseLogZayavki(row[9]),
        skuCount: Number(row[12]) || 0,
        unitsTotal: Number(row[13]) || 0,
        status: String(row[14] || 'СОЗДАНО').trim() || 'СОЗДАНО',
        type: normalizeType(row[15]),       // P — ОТГ / ПЕР
        pickMode: normalizePickMode(row[16]), // Q — СВОБ / КОР / КОР+
        lockedBy: undefined,
        lockedAt: undefined,
      };
      z.unifiedKey = buildUnifiedKey(z);
      return z;
    });
}

export function getUniqueClients(zayavki) {
  const counts = new Map();
  for (const z of zayavki) counts.set(z.client, (counts.get(z.client) || 0) + 1);
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

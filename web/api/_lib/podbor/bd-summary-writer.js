// Запись сводной информации о заявке в лист БД, колонки O + W:AJ.
//
// Вызывается при zayavka.finish mode='full' ОДИН раз после всех успешных
// записей (КОРОБЫ → СОБРАНО, НАЧ append, state archive). Заменяет вторую
// часть markFinished — теперь одной batch-записью обновляются U, V, O и W:AJ.
//
// Колонка O = ЛОГ ЗАЯВКИ (3-столбчатый текст picklog, см. picklog в summary).
//
// Структура BD заявки (см. bd-writer.js для A:V и комментарий ниже):
//   W=СОБР СКЮ — кол. уникальных собранных баркодов (picked > 0)
//   X=СОБР ЕД — общее кол. собранных единиц
//   Y=СОБР ПО КОР — собрано бесплатно (free sourceBoxes shipped)
//   Z=СОБР ПОДБ — собрано платно (paid sourceBoxes shipped = nach.totalPaidUnits)
//   AA=ПЕРЕМ В ЯЧ — перемещено в ячейки (сумма toCell across sources)
//   AB=КОЛ КОР — кол. коробов отгрузки (созданные ship.create + full_to_ship sources)
//   AC=СПИС КОР — список коробов в формате "номер | владелец | габариты | qty",
//      разделитель строк = \n, разделитель колонок = " | "
//   AD=НАЧ — сумма начислений (₽)
//   AE=ЛОГ ВЫПОЛН — человекочитаемый таймлайн событий заявки
//   AF=ЛОГ ИЗМ — чек-лист модификаций листов / БД / state при финише
//   AG=ДЛИТ СКРИПТА — длительность финиш-операции (sec/min)
//   AH=НАЧАЛО — startedAt (DD.MM.YY HH:MM)
//   AI=ЗАВЕРШЕНИЕ — finishedAt (DD.MM.YY HH:MM)
//   AJ=ДЛИТ,ч — длительность заявки от старта до финиша

import { getSheets } from '../google.js';
import { getPodborySpreadsheetId } from './spreadsheet-id.js';
import { logEvent } from './sync-log.js';
import { buildZayavkaLog } from './zayavka-log.js';
import { withRetry } from './sheets-retry.js';

const SHEET_NAME = 'БД';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}мин`;
  return `${h}ч ${pad(m)}мин`;
}
function fmtScriptDuration(ms) {
  if (ms < 1000) return `${ms}мс`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}сек`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}мин ${pad(s)}сек`;
}

// Найти строку заявки в БД (та же логика что bd-writer.findRowByZayavkaNumber).
// Экспортируется для pre-flight проверки в runtime.js — поймать «нет строки в БД»
// до записи КОРОБ/НАЧ, чтобы повторный finish не падал на середине пайплайна.
export async function findRowByZayavkaNumber(zayavkaNumber) {
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const r = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${SHEET_NAME}'!F:F`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }), { label: `bd.findRow(${zayavkaNumber})` });
  const values = r.data.values || [];
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || '').trim();
    if (v === zayavkaNumber) return i + 1;
  }
  return null;
}

// === Builder ===

// Собирает сводку из state.computed + state.meta + state.shipBoxes + events.
// ctx: { transitioned, nachWritten, scriptStartedAt }
export function buildFinishSummary(state, ctx = {}) {
  const computed = state.computed || {};
  const meta = state.meta || {};
  const sourceBoxes = computed.sourceBoxes || {};
  const nach = computed.nach || {};
  const pickedByBarcode = computed.pickedByBarcode || {};
  const shipBoxesContents = computed.shipBoxesContents || {};

  // СОБР СКЮ / СОБР ЕД
  let uniqueSku = 0, totalUnits = 0;
  for (const qty of Object.values(pickedByBarcode)) {
    const q = Number(qty) || 0;
    if (q > 0) { uniqueSku++; totalUnits += q; }
  }

  // СОБР ПО КОР / СОБР ПОДБ / ПЕРЕМ В ЯЧ
  let freeUnits = 0, paidUnits = 0, toCellUnits = 0;
  for (const info of Object.values(sourceBoxes)) {
    const shipped = Object.values(info.shipped || {}).reduce((a, b) => a + b, 0);
    const toCell = Object.values(info.toCell || {}).reduce((a, b) => a + b, 0);
    toCellUnits += toCell;
    if (info.kind === 'free') freeUnits += shipped;
    else paidUnits += shipped;
  }

  // Список коробов: ship.create + full_to_ship (free-источники, ставшие S-коробами).
  const shipBoxList = [];
  // 1. Созданные ship.create.
  for (const sb of (state.shipBoxes || [])) {
    const dims = sb.dimensions && sb.dimensions.w
      ? `${sb.dimensions.w}x${sb.dimensions.h}x${sb.dimensions.d}` : '';
    const contents = shipBoxesContents[sb.number] || {};
    const qty = Object.values(contents).reduce((a, b) => a + b, 0);
    shipBoxList.push([sb.number, sb.owner || 'ФФ', dims, qty]);
  }
  // 2. full_to_ship → новые S-коробы (полностью изъятые источники).
  for (const ev of (state.events || [])) {
    if (ev.type !== 'full_to_ship') continue;
    const newKorob = ev.newKorob || ev.source;
    if (!newKorob) continue;
    if (shipBoxList.some(r => r[0] === newKorob)) continue; // не дублируем если уже есть
    const items = ev.items || [];
    const qty = items.reduce((a, it) => a + (Number(it.qty) || 0), 0);
    shipBoxList.push([newKorob, ev.owner || 'ФФ', '', qty]);
  }
  const shipBoxListStr = shipBoxList.map(r => r.join(' | ')).join('\n');

  // ЛОГ ЗАЯВКИ — 3-колоночный текст (см. zayavka-log.js).
  // Используется в БД.O и ОТГ.T одновременно — общий формат, общий билдер.
  const picklog = buildZayavkaLog(state);

  // === Список коробов для ОТГ.O — только номера, по одному в строке ===
  // На листе ОТГ нужна упрощённая версия (без owner/dims/qty), пример:
  //   S1610-001
  //   S3317-038
  //   S4560-165
  // shipBoxNumbers: уникальные номера в том же порядке, что в shipBoxList.
  const seenBoxNumbers = new Set();
  const shipBoxNumbers = [];
  for (const r of shipBoxList) {
    if (!seenBoxNumbers.has(r[0])) {
      seenBoxNumbers.add(r[0]);
      shipBoxNumbers.push(r[0]);
    }
  }
  const shipBoxNumbersStr = shipBoxNumbers.join('\n');

  // === КОЛ КОР ФФ — коробов с owner='ФФ' (фулфилмент) ===
  // shipBoxList: [number, owner, dims, qty]. Считаем уникальные номера, чьи
  // owner === 'ФФ'. Дефолт owner='ФФ' стоит выше при пустом — это совпадает
  // с историческим поведением: если короб не маркирован — он фулфилмента.
  const ffBoxNumbers = new Set();
  for (const r of shipBoxList) {
    if (String(r[1] || 'ФФ') === 'ФФ') ffBoxNumbers.add(r[0]);
  }
  const ffBoxCount = ffBoxNumbers.size;

  // ЛОГ ВЫПОЛН — человекочитаемый таймлайн.
  const execLog = (state.events || []).map(ev => {
    const t = fmtDateTime(ev.ts).slice(-5); // HH:MM
    const by = (ev.by || '').slice(0, 12);
    let action = '';
    switch (ev.type) {
      case 'zayavka.start': action = `старт подбора (${ev.picker || by})`; break;
      case 'zayavka.finish': action = `финиш (${ev.mode || 'full'})`; break;
      case 'zayavka.partial_close': action = 'частичное закрытие'; break;
      case 'zayavka.close': action = 'закрытие/откат'; break;
      case 'set_layout': {
        const items = (ev.items || []).map(i => {
          const parts = [];
          if (i.kolPodb) parts.push(`${i.barcode}: ${i.kolPodb}→${i.kudaPodb || '?'}`);
          if (i.kolPerem) parts.push(`${i.barcode}: ${i.kolPerem}→${i.kudaPerem || 'ЯЧ'}`);
          return parts.join(', ');
        }).join('; ');
        action = `раскладка ${ev.source}: ${items}`;
        break;
      }
      case 'full_to_ship': {
        const total = (ev.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
        action = `${ev.source} → ${ev.newKorob} (целиком, ${total}шт, ${ev.owner || 'ФФ'})`;
        break;
      }
      case 'ship.create': action = `создан ${ev.number} (${ev.taraType}, ${ev.dimensions ? `${ev.dimensions.w}x${ev.dimensions.h}x${ev.dimensions.d}` : '?'}, ${ev.owner || 'ФФ'})`; break;
      case 'ship.delete': action = `удалён ${ev.number}`; break;
      case 'inventory_correction': action = `микро-инвент ${ev.korob}/${ev.barcode}: ${ev.old}→${ev.new}${ev.reason ? ' ('+ev.reason+')' : ''}`; break;
      default: action = ev.type;
    }
    return `${t} ${by} — ${action}`;
  }).join('\n');

  // ЛОГ ИЗМ — чек-лист модификаций.
  const checklistOps = [];
  if (ctx.transitioned !== undefined) checklistOps.push(`КОРОБЫ: ${ctx.transitioned} строк В СБОРКЕ → СОБРАНО`);
  if (ctx.nachWritten !== undefined && ctx.nachWritten > 0) checklistOps.push(`НАЧ: добавлено ${ctx.nachWritten} строк (итого ${nach.totalCharge || 0}₽)`);
  else if (ctx.nachWritten === 0) checklistOps.push(`НАЧ: пропущено (всё бесплатно)`);
  checklistOps.push(`БД: row обновлён W:AJ (СТАТУС=СОБРАНО)`);
  checklistOps.push(`STATE: state-файл архивирован в _done/`);
  const changesReport = [
    'ЧЕК-ЛИСТ - ✅ КОРОБЫ - ✅ НАЧ - ✅ БД - ✅ STATE',
    '---',
    ...checklistOps,
  ].join('\n');

  // Длительности.
  const now = Date.now();
  const startedAt = meta.startedAt || 0;
  const finishedAt = meta.finishedAt || now;
  const scriptDuration = ctx.scriptStartedAt ? (now - ctx.scriptStartedAt) : 0;

  return {
    uniqueSku, totalUnits, freeUnits, paidUnits, toCellUnits,
    shipBoxCount: shipBoxList.length,
    shipBoxListStr,
    shipBoxNumbersStr,   // для ОТГ.O — только номера через \n
    ffBoxCount,          // для ОТГ.S — кол-во ФФ-коробов
    picklog,             // для БД.O и ОТГ.T — 3-колоночный текст (barcode/need/picked)
    totalCharge: nach.totalCharge || 0,
    execLog,
    changesReport,
    scriptDuration: fmtScriptDuration(scriptDuration),
    startedAtFmt: fmtDateTime(startedAt),
    finishedAtFmt: fmtDateTime(finishedAt),
    durationHM: fmtDuration(finishedAt - startedAt),
  };
}

// === Writer ===

// Пишет U,V (статус+ts) + W:AJ (summary) в одном batch'е. Заменяет markFinished.
export async function writeFinishSummary(zayavkaNumber, summary) {
  const row = await findRowByZayavkaNumber(zayavkaNumber);
  if (!row) {
    logEvent('warn', 'sheet', `БД: заявка ${zayavkaNumber} не найдена для записи finish-summary`, null);
    return {
      ok: false,
      reason: 'not_found',
      error: `Заявка ${zayavkaNumber} не найдена в листе ПОДБОРЫ.БД. В тестовом режиме это нормально (тестовая таблица — упрощённая копия). На проде такого не будет.`,
    };
  }
  const sheets = getSheets();
  const id = getPodborySpreadsheetId();
  const d = new Date();
  const ts = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fields = {
    O: summary.picklog,  // ЛОГ ЗАЯВКИ: barcode⁠ - ⁠need⁠ - ⁠picked через \n
    U: 'СОБРАНО', V: ts,
    W: summary.uniqueSku, X: summary.totalUnits,
    Y: summary.freeUnits, Z: summary.paidUnits, AA: summary.toCellUnits,
    AB: summary.shipBoxCount, AC: summary.shipBoxListStr,
    AD: summary.totalCharge,
    AE: summary.execLog, AF: summary.changesReport,
    AG: summary.scriptDuration,
    AH: summary.startedAtFmt, AI: summary.finishedAtFmt, AJ: summary.durationHM,
  };
  const data = [];
  for (const [col, value] of Object.entries(fields)) {
    data.push({ range: `'${SHEET_NAME}'!${col}${row}`, values: [[value]] });
  }
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: id,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  }), { label: `bd.batchUpdate(${zayavkaNumber})` });
  logEvent('info', 'sheet', `БД: ${zayavkaNumber} finish-summary записан в W:AJ`, {
    row, totalUnits: summary.totalUnits, freeUnits: summary.freeUnits,
    paidUnits: summary.paidUnits, totalCharge: summary.totalCharge,
    shipBoxCount: summary.shipBoxCount, duration: summary.durationHM,
  });
  return { ok: true, row, status: 'СОБРАНО', ts };
}

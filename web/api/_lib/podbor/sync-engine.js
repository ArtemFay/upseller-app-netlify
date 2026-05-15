// Sync engine для Подбора.
//
// Принципы (см. Podbor/CONTEXT.md и обсуждение):
//   - Источник правды по балансу клиента — лист "🍬 КОРОБЫ".
//   - Backend-driven таймеры: backend сам решает, когда flush'ить, фронт только
//     отдаёт операции и читает состояние.
//   - Один глобальный mutex на все Sheets-вызовы — никаких race'ов между
//     планшетами в пределах одной Node-инстанции.
//   - Очередь pending-операций per заявка хранится в JSON-файле (storage.js).
//   - Все атомы — через очередь. Forced flush только на partial_close/finish.
//   - CAS-проверка: атом несёт expectedQty по затронутым ключам — если на листе
//     цифра другая, атом помечается conflict и не применяется.
//
// Тики (запускаются startScheduler()), настраиваются через env:
//   - PODBOR_BATCH_TICK_MS   — flush всех активных заявок (default 10s).
//   - PODBOR_REFRESH_TICK_MS — hard re-read "🍬 КОРОБЫ" для forward sync (default 60s).
//
// ⚠️ TODO (deploy to VPS): перед публикацией убедиться, что в проде стоят
//   PODBOR_BATCH_TICK_MS=10000 и PODBOR_REFRESH_TICK_MS=60000 (или больше).
//   В .env dev-машины сейчас 2000 / 30000 — это удобно для тестирования,
//   но на проде нагружает Sheets API и квоты сервис-аккаунта.

import { getSheets } from '../google.js';
import { withRetry } from './sheets-retry.js';
import { KorobyIndex, COL, colLetter, buildShipBoxRow, buildSkladString, buildOwnerComment, RANGES } from './koroby-index.js';
import { readQueue, writeQueue, deleteQueue, listActiveZayavki } from './storage.js';
import { logEvent } from './sync-log.js';
import { randomUUID } from 'crypto';

const BATCH_TICK_MS = Number(process.env.PODBOR_BATCH_TICK_MS ?? 10_000);
const REFRESH_TICK_MS = Number(process.env.PODBOR_REFRESH_TICK_MS ?? 60_000);

// === AsyncMutex: цепочка промисов, гарантия sequential execution ===
class AsyncMutex {
  constructor() { this._chain = Promise.resolve(); }
  run(fn) {
    const next = this._chain.then(() => fn()).catch(err => { throw err; });
    // Цепочка не должна обрываться на ошибке — фолбэк на resolved promise:
    this._chain = next.catch(() => {});
    return next;
  }
}

const sheetsMutex = new AsyncMutex();

// Короткий ID для логов: префикс `S\d+` или `R\d+`, иначе первые 5 символов.
function shortZayavkaId(id) {
  const s = String(id || '');
  const m = s.match(/^([SR]\d+)/);
  return m ? m[1] : s.slice(0, 5);
}

// Замена первой буквы префикса на 'S' (короб отгрузки).
// "П4116-08" → "S4116-08", "Б3403-001" → "S3403-001".
// Если уже начинается с 'S'/'s' — не меняется. Если пустой/числовой — не меняется.
function renameToShipPrefix(korobName) {
  const s = String(korobName || '');
  if (!s || /^[Ss]/.test(s)) return s;
  if (!/^[A-Za-zА-Яа-я]/.test(s)) return s;
  return 'S' + s.slice(1);
}

// === Snapshot листа "🍬 КОРОБЫ" в памяти процесса ===
let _snapshot = null;

async function ensureSnapshot() {
  if (!_snapshot) {
    _snapshot = new KorobyIndex();
    await _snapshot.refresh();
  }
  return _snapshot;
}

export async function forwardRefresh() {
  return sheetsMutex.run(async () => {
    if (!_snapshot) _snapshot = new KorobyIndex();
    await _snapshot.refresh();
    return { rowsCount: _snapshot.rows.length, at: _snapshot.lastReadAt };
  });
}

export function getCachedSnapshot() { return _snapshot; }

// === Добавление атома в очередь ===
//
// Атомы внутреннего формата:
//   { id, type, ts, user, zayavkaId, payload, expected }
//
// Поддерживаемые типы (mvp):
//   'set_layout'           — раскладка одного короба-источника
//   'inventory_correction' — точечная правка КОЛ конкретной строки
//   'ship_create'          — создание пустого короба отгрузки (только в state, без sheet write)
//   'ship_delete'          — удаление пустого короба отгрузки
//   'change_address'       — смена адреса физического короба (TODO заход 2+)
//
// Идемпотентность:
//   - 'set_layout' с тем же source_korob заменяет предыдущий unflushed.
//   - остальные просто append'ятся.

export async function addOp(zayavkaId, op) {
  if (!zayavkaId) throw new Error('addOp: zayavkaId обязателен');
  if (!op?.type) throw new Error('addOp: op.type обязателен');
  const queue = await readQueue(zayavkaId);

  const fullOp = {
    id: op.id || randomUUID(),
    type: op.type,
    ts: Date.now(),
    user: op.user || 'unknown',
    zayavkaId,
    payload: op.payload || {},
    expected: Array.isArray(op.expected) ? op.expected : [],
  };

  if (op.type === 'set_layout') {
    const src = fullOp.payload.source_korob;
    if (src) {
      const idx = queue.ops.findIndex(o => o.type === 'set_layout' && o.payload?.source_korob === src);
      if (idx >= 0) {
        queue.ops.splice(idx, 1);
        logEvent('info', 'queue', `set_layout заменил предыдущий unflushed для ${src}`, { zayavkaId });
      }
    }
  } else if (op.type === 'ship_create') {
    if (!queue.shipBoxes) queue.shipBoxes = [];
    // Сохраняем все meta (taraType, dimensions, owner) — нужны при materialization
    // строки в КОРОБЫ для R (комментарий с КЛ/ФФ) и C (тара коэф).
    queue.shipBoxes.push({
      number: fullOp.payload.number,
      taraType: fullOp.payload.taraType,
      dimensions: fullOp.payload.dimensions || null,
      owner: fullOp.payload.owner || null,
      createdAt: fullOp.ts,
    });
    await writeQueue(zayavkaId, queue);
    logEvent('info', 'queue', `ship_create виртуально: ${fullOp.payload.number}`, { zayavkaId: shortZayavkaId(zayavkaId), user: fullOp.user });
    return { ok: true, op: fullOp, virtual: true };
  } else if (op.type === 'ship_delete') {
    if (queue.shipBoxes) {
      queue.shipBoxes = queue.shipBoxes.filter(b => b.number !== fullOp.payload.number);
    }
    await writeQueue(zayavkaId, queue);
    logEvent('info', 'queue', `ship_delete виртуально: ${fullOp.payload.number}`, { zayavkaId });
    return { ok: true, op: fullOp, virtual: true };
  }

  queue.ops.push(fullOp);
  await writeQueue(zayavkaId, queue);
  logEvent('info', 'queue', `op queued: ${op.type}`, {
    zayavkaId: shortZayavkaId(zayavkaId), user: fullOp.user, payload: fullOp.payload,
  });
  return { ok: true, op: fullOp };
}

// === Flush одной заявки ===
export async function flushZayavka(zayavkaId, { reason = 'tick' } = {}) {
  return sheetsMutex.run(() => _flushUnderLock(zayavkaId, reason));
}

async function _flushUnderLock(zayavkaId, reason) {
  const tStart = Date.now();
  const snap = await ensureSnapshot();
  await snap.refresh();

  const queue = await readQueue(zayavkaId);
  // Используем zayavkaId из ТЕЛА очереди (UTF-8 сохранён), а не из имени файла
  // (там кириллица заменена на _ через safeFileName). В логах показываем
  // короткий префикс (`S1530`) вместо полного `S1530-Ерёмин`.
  const realZayavkaId = queue.zayavkaId || zayavkaId;
  const shortId = shortZayavkaId(realZayavkaId);
  if (!queue.ops || queue.ops.length === 0) {
    queue.lastFlushAt = Date.now();
    queue.lastFlushResult = { ok: true, reason, processed: 0 };
    await writeQueue(zayavkaId, queue);
    logEvent('info', 'flush', `пустая очередь (${reason})`, { zayavkaId: shortId });
    return { ok: true, processed: 0, reason };
  }

  logEvent('info', 'flush', `start (${reason}): ${queue.ops.length} op(s)`, { zayavkaId: shortId });

  const result = projectOps(snap, queue.ops, realZayavkaId, queue);

  for (const c of result.conflicts) {
    logEvent('warn', 'cas', `conflict: ${c.reason}`, { zayavkaId: shortId, opId: c.opId });
  }

  try {
    // Append через batchUpdate с явными координатами — values.append иногда
    // некорректно определяет границу таблицы и сдвигает столбцы (баг 2026-05).
    // Мы знаем nextRow из snapshot, идём через update.
    const allUpdates = [...result.updates];
    if (result.appendRows.length > 0) {
      let nextRow = snap.nextRowNumber();
      for (let i = 0; i < result.appendRows.length; i++) {
        const row = result.appendRows[i];
        // Диапазон B:U (не A — A это формула БАР_5).
        allUpdates.push({
          range: `'${RANGES.SHEET}'!B${nextRow}:U${nextRow}`,
          values: [row.slice(1, 21)],
        });
        // Колонка X (NO_OTG) — отдельным update'ом, она вне range A:U.
        const xVal = result.appendXValues && result.appendXValues[i];
        if (xVal) {
          allUpdates.push({
            range: `'${RANGES.SHEET}'!${colLetter(COL.NO_OTG)}${nextRow}`,
            values: [[xVal]],
          });
        }
        nextRow++;
      }
      logEvent('info', 'sheet', `append ${result.appendRows.length} row(s) starting at row ${snap.nextRowNumber()}`, {
        zayavkaId: shortId,
        sheet: '🍬 КОРОБЫ',
        preview: result.appendRows.map(r => `[${r[3]}/${r[20]}=${r[8]} ${r[4]}]`),
      });
    }
    if (allUpdates.length > 0) {
      logEvent('info', 'sheet', `batchUpdate ${allUpdates.length} range(s) (${result.updates.length} updates + ${result.appendRows.length} appends)`, {
        zayavkaId: shortId,
        ranges: allUpdates.slice(0, 10).map(u => `${u.range}=${JSON.stringify(u.values[0]).slice(0, 60)}`),
      });
      await batchUpdateValues(snap.spreadsheetId, allUpdates);
    }
  } catch (e) {
    logEvent('error', 'sheet', `Sheets API error: ${e.message}`, { zayavkaId: shortId });
    queue.lastFlushAt = Date.now();
    queue.lastFlushResult = { ok: false, reason, error: e.message };
    await writeQueue(zayavkaId, queue);
    throw e;
  }

  await snap.refresh();

  const appliedIds = new Set(result.applied || []);
  const conflictedIds = new Set(result.conflicts.map(c => c.opId));
  // Удаляем И applied, И conflicted из очереди. Иначе conflicted retried
  // бесконечно (frontend получает toast на каждый poll). Пользователь
  // получит уведомление об ошибке один раз через lastFlushResult.conflicts;
  // фронт сделает rollback через reload полотна.
  queue.ops = queue.ops.filter(o => !appliedIds.has(o.id) && !conflictedIds.has(o.id));
  queue.lastFlushAt = Date.now();
  queue.lastFlushResult = {
    ok: conflictedIds.size === 0,
    reason,
    processed: result.applied.length,
    conflicts: result.conflicts,
    appended: result.appendRows.length,
    updated: result.updates.length,
    durationMs: Date.now() - tStart,
  };
  await writeQueue(zayavkaId, queue);
  logEvent('info', 'flush', `done (${reason}): applied=${result.applied.length} conflicts=${result.conflicts.length} append=${result.appendRows.length} update=${result.updates.length} ${queue.lastFlushResult.durationMs}ms`, { zayavkaId: shortId });

  return queue.lastFlushResult;
}

// === Проекция атомов на snapshot ===
//
// Возвращает: { applied: [opId], conflicts: [{opId, reason}], updates, appendRows }
// updates: [{ range: "'🍬 КОРОБЫ'!I1234", values: [[42]] }]
// appendRows: [[...19 cells...]]

function projectOps(snap, ops, zayavkaId, queue) {
  const applied = [];
  const conflicts = [];
  const projected = new Map();
  const newDest = new Map();
  // Direct updates — для full_to_ship атома, который не вписывается в projected
  // (мы меняем сразу несколько полей одной строки, не только qty).
  const directUpdates = [];
  // Унифицированный buffer добавлений к R (КОММЕНТАРИЙ) для каждой строки.
  // В финале формируем единый update: existingComment + '\n' + lines.join('\n').
  // Это даёт «лог» истории изъятий/наполнений для каждой пары (короб, баркод).
  const commentAppends = new Map(); // rowNumber → string[]
  function addCommentLog(rn, line) {
    if (!rn || !line) return;
    if (!commentAppends.has(rn)) commentAppends.set(rn, []);
    commentAppends.get(rn).push(line);
  }
  function todayDDMMYY() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(-2)}`;
  }
  // Метаданные виртуальных коробов отгрузки (из ship.create) — для R комментария
  // и тары при materialization новых строк.
  const shipMeta = {};
  if (queue && Array.isArray(queue.shipBoxes)) {
    for (const sb of queue.shipBoxes) {
      if (sb.number) shipMeta[sb.number] = sb;
    }
  }

  // Ключ согласован с koroby-index.js: (korob, barcode), без клиента —
  // колонка КЛИЕНТ может быть пустой в тестовых копиях.
  function keyOf(_client, korob, barcode) {
    return `${String(korob || '').trim()}|${String(barcode || '').trim()}`;
  }

  function getEntry(client, korob, barcode) {
    const k = keyOf(client, korob, barcode);
    if (projected.has(k)) return projected.get(k);
    const e = snap.find(client, korob, barcode);
    if (e) {
      const copy = { ...e };
      projected.set(k, copy);
      return copy;
    }
    if (newDest.has(k)) return newDest.get(k);
    return null;
  }

  for (const op of ops) {
    try {
      if (op.type === 'inventory_correction') {
        const { client, korob, barcode, novKol } = op.payload;
        const entry = getEntry(client, korob, barcode);
        if (!entry) {
          conflicts.push({ opId: op.id, reason: `строка не найдена: ${client}/${korob}/${barcode}` });
          continue;
        }
        const conflict = checkExpected(op.expected, getEntry);
        if (conflict) { conflicts.push({ opId: op.id, reason: conflict }); continue; }
        const oldQty = Number(entry.qty) || 0;
        const newQty = Number(novKol) || 0;
        entry.qty = newQty;
        // R-лог: дата + было/стало + заявка (для аудита кто/когда/зачем менял).
        if (oldQty !== newQty && entry.rowNumber) {
          const today = todayDDMMYY();
          addCommentLog(entry.rowNumber,
            `${today} микро-инвент: ${oldQty} → ${newQty} (${zayavkaId || 'заявку'})`);
        }
        applied.push(op.id);
      } else if (op.type === 'set_layout') {
        const { client, source_korob, items, zayavkaContext } = op.payload;
        if (!client || !source_korob || !Array.isArray(items)) {
          conflicts.push({ opId: op.id, reason: 'set_layout: неверный payload' });
          continue;
        }
        const ctxZ = zayavkaContext || {};
        const sklad = buildSkladString(ctxZ.warehouse, ctxZ.finalWarehouse);
        const dateOtgr = ctxZ.dateOtgr || '';
        const conflict = checkExpected(op.expected, getEntry);
        if (conflict) { conflicts.push({ opId: op.id, reason: conflict }); continue; }
        // Применяем все items одним атомом — либо всё, либо ничего.
        const stagedMutations = [];
        let abortReason = null;
        for (const item of items) {
          const { barcode, kolPodb, kudaPodb, kolPerem, kudaPerem, sku, mp, taraType } = item;
          const podb = Number(kolPodb) || 0;
          const perem = Number(kolPerem) || 0;
          const totalOut = podb + perem;
          const sourceEntry = getEntry(client, source_korob, barcode);
          if (!sourceEntry) {
            abortReason = `источник не найден: ${client}/${source_korob}/${barcode}`;
            break;
          }
          if (sourceEntry.qty < totalOut) {
            abortReason = `недостаточно остатка ${barcode} в ${source_korob}: есть ${sourceEntry.qty}, нужно ${totalOut}`;
            break;
          }
          stagedMutations.push({ kind: 'src_decr', entry: sourceEntry, qty: totalOut });
          // Пропагация атрибутов из источника: фронт не знает sku/mp/тары,
          // берём их из строки-источника в snapshot.
          const propSku = sku || sourceEntry.sku || '';
          const propMp = mp || sourceEntry.mp || '';
          const propClient = sourceEntry.client || client || '';
          const propTip = sourceEntry.tip || ''; // тип товара копируется из источника
          if (podb > 0 && kudaPodb) {
            stagedMutations.push({
              kind: 'dest_incr', client: propClient, korob: kudaPodb, barcode, qty: podb,
              destKind: 'ship', sku: propSku, mp: propMp, tip: propTip, taraType: taraType || 'К_1.0',
            });
          }
          if (perem > 0 && kudaPerem) {
            // Правило (CONST/02 § 5b — обновлено): в одной ячейке могут
            // лежать РАЗНЫЕ баркоды, ЕСЛИ они принадлежат одному клиенту.
            // Запрещаем только когда ячейка уже занята товаром ДРУГОГО клиента
            // (или если destKind — короб другого клиента).
            const existingCellRows = snap.byKorobName(kudaPerem);
            for (const cellRow of existingCellRows) {
              if (Number(cellRow.qty) <= 0) continue;
              const existingClient = String(cellRow.client || '').trim();
              if (existingClient && existingClient !== propClient) {
                abortReason = `${kudaPerem} занят товаром клиента «${existingClient}». Положить товар клиента «${propClient}» нельзя.`;
                break;
              }
            }
            if (abortReason) break;
            stagedMutations.push({
              kind: 'dest_incr', client: propClient, korob: kudaPerem, barcode, qty: perem,
              destKind: 'cell', sku: propSku, mp: propMp, tip: propTip,
            });
          }
        }
        if (abortReason) { conflicts.push({ opId: op.id, reason: abortReason }); continue; }
        // Применяем staged mutations.
        for (const m of stagedMutations) {
          if (m.kind === 'src_decr') {
            m.entry.qty = (m.entry.qty || 0) - m.qty;
          } else if (m.kind === 'dest_incr') {
            const k = keyOf(m.client, m.korob, m.barcode);
            let dest = projected.get(k);
            if (!dest) dest = newDest.get(k);
            if (!dest) {
              const existing = snap.find(m.client, m.korob, m.barcode);
              if (existing) {
                dest = { ...existing };
                projected.set(k, dest);
              } else {
                // Для коробов отгрузки — берём метаданные из virtual queue.shipBoxes
                // (габариты + owner). Для ячеек — пусто.
                const meta = m.destKind === 'ship' ? (shipMeta[m.korob] || {}) : null;
                const taraFromMeta = meta && meta.taraType ? meta.taraType : (m.taraType || 'К_1.0');
                const commentR = m.destKind === 'ship'
                  ? buildOwnerComment(meta?.dimensions, meta?.owner, '')
                  : '';
                // ЗАЯВКА, СКЛАД, ДАТА_ОТГР, ТИП проставляем в новую строку (cell
                // или ship) единообразно — пользователь знает контекст заявки,
                // и новая ячейка/короб создаётся именно ДЛЯ ЭТОЙ заявки. Без
                // этого ячейка вылетала с пустой ЗАЯВКА на листе.
                dest = {
                  rowNumber: null, // append
                  qty: 0,
                  status: m.destKind === 'ship' ? 'В СБОРКЕ' : 'ХРАНЕНИЕ',
                  tara: m.destKind === 'ship' ? taraFromMeta : 'ЯЧ',
                  tip: m.tip || (m.destKind === 'ship' ? 'УТ ГОТОВ' : ''),
                  sku: m.sku || '',
                  mp: m.mp || '',
                  client: m.client,
                  korob: m.korob,
                  barcode: m.barcode,
                  zayavka: zayavkaId, // ВСЕГДА фиксируем заявку (и для ячеек тоже)
                  sklad: sklad || '',
                  dateOtgr: dateOtgr || '',
                  comment: commentR,
                  isNew: true,
                };
                newDest.set(k, dest);
              }
            }
            dest.qty = (dest.qty || 0) + m.qty;
          }
        }
        // R-лог изъятий и пополнений per строка (история движения товара).
        const today = todayDDMMYY();
        for (const item of items) {
          const { barcode, kolPodb, kudaPodb, kolPerem, kudaPerem } = item;
          const podb = Number(kolPodb) || 0;
          const perem = Number(kolPerem) || 0;
          const totalOut = podb + perem;
          if (totalOut <= 0) continue;
          const sourceEntry = projected.get(keyOf(client, source_korob, barcode));
          if (!sourceEntry || !sourceEntry.rowNumber) continue;
          const destStr = [
            podb > 0 && kudaPodb ? `${podb}шт→${kudaPodb}` : null,
            perem > 0 && kudaPerem ? `${perem}шт→${kudaPerem}` : null,
          ].filter(Boolean).join(', ');
          // Лог для источника
          addCommentLog(sourceEntry.rowNumber, `${today} -${totalOut}шт (${destStr}) ${zayavkaId || ''}`.trim());
          // Лог для destination — ship: existing или новой строки
          if (podb > 0 && kudaPodb) {
            const destKey = keyOf(client, kudaPodb, barcode);
            const projDest = projected.get(destKey);
            if (projDest && projDest.rowNumber) {
              addCommentLog(projDest.rowNumber, `${today} +${podb}шт ← ${source_korob} ${zayavkaId || ''}`.trim());
            } else {
              const newDestEntry = newDest.get(destKey);
              if (newDestEntry) {
                const logLine = `${today} +${podb}шт ← ${source_korob} ${zayavkaId || ''}`.trim();
                newDestEntry.comment = (newDestEntry.comment ? newDestEntry.comment + '\n' : '') + logLine;
              }
            }
          }
          // Лог для destination — cell
          if (perem > 0 && kudaPerem) {
            const destKey = keyOf(client, kudaPerem, barcode);
            const projDest = projected.get(destKey);
            if (projDest && projDest.rowNumber) {
              addCommentLog(projDest.rowNumber, `${today} +${perem}шт ← ${source_korob} ${zayavkaId || ''}`.trim());
            } else {
              const newDestEntry = newDest.get(destKey);
              if (newDestEntry) {
                const logLine = `${today} +${perem}шт ← ${source_korob} ${zayavkaId || ''}`.trim();
                newDestEntry.comment = (newDestEntry.comment ? newDestEntry.comment + '\n' : '') + logLine;
              }
            }
          }
        }
        applied.push(op.id);
      } else if (op.type === 'full_to_ship') {
        // Сценарий B: трансформация исходных строк короба в строки отгрузки.
        // Не создаём новых строк, не двигаем КОЛ. Меняем только:
        //   E (статус) → В СБОРКЕ
        //   F (заявка) → zayavkaId
        //   M (склад)  → warehouse ▹ finalWarehouse
        //   N (дата)   → dateOtgr
        //   R (коммент) → append "{owner}" (с переносом)
        //   X (№ отгр) → zayavkaId
        const { source_korob, owner, zayavkaContext } = op.payload;
        if (!source_korob) {
          conflicts.push({ opId: op.id, reason: 'full_to_ship: source_korob обязателен' });
          continue;
        }
        const srcEntries = snap.byKorobName(source_korob);
        if (srcEntries.length === 0) {
          conflicts.push({ opId: op.id, reason: `full_to_ship: короб ${source_korob} не найден` });
          continue;
        }
        const ctxZ2 = zayavkaContext || {};
        const skladStr = buildSkladString(ctxZ2.warehouse, ctxZ2.finalWarehouse);
        const dateOtgrStr = ctxZ2.dateOtgr || '';
        const ownerStr = String(owner || '').trim();
        for (const entry of srcEntries) {
          const rn = entry.rowNumber;
          // E
          directUpdates.push({
            range: `'${RANGES.SHEET}'!${colLetter(COL.STATUS)}${rn}`,
            values: [['В СБОРКЕ']],
          });
          // F и X
          if (zayavkaId) {
            directUpdates.push({
              range: `'${RANGES.SHEET}'!${colLetter(COL.ZAYAVKA)}${rn}`,
              values: [[zayavkaId]],
            });
            directUpdates.push({
              range: `'${RANGES.SHEET}'!${colLetter(COL.NO_OTG)}${rn}`,
              values: [[zayavkaId]],
            });
          }
          // M
          if (skladStr) {
            directUpdates.push({
              range: `'${RANGES.SHEET}'!${colLetter(COL.SKLAD_NAZN)}${rn}`,
              values: [[skladStr]],
            });
          }
          // N
          if (dateOtgrStr) {
            directUpdates.push({
              range: `'${RANGES.SHEET}'!${colLetter(COL.SLOT)}${rn}`,
              values: [[dateOtgrStr]],
            });
          }
          // R-лог: владелец + переименование (через единый commentAppends).
          const oldKorobName = entry.korob;
          const newKorobName = renameToShipPrefix(oldKorobName);
          const today = todayDDMMYY();
          if (ownerStr) addCommentLog(rn, `${today} тара: ${ownerStr}`);
          if (oldKorobName !== newKorobName) {
            addCommentLog(rn, `${today} изъят целиком ${oldKorobName}→${newKorobName} в ${zayavkaId || ''}`.trim());
            directUpdates.push({
              range: `'${RANGES.SHEET}'!${colLetter(COL.KOROB)}${rn}`,
              values: [[newKorobName]],
            });
          } else if (ownerStr) {
            // короб уже с S-префиксом — лог только про owner добавлен выше.
          }
        }
        applied.push(op.id);
      }
      // Другие типы — TODO: change_address.
    } catch (e) {
      conflicts.push({ opId: op.id, reason: e.message });
    }
  }

  // Превращаем projected + newDest в updates / appendRows.
  const updates = [...directUpdates];
  // Группируем строки источников по korob — чтобы пометить ИЗЪЯТО только когда
  // ВСЕ строки этого короба обнулены (то есть короб опустошён целиком).
  const exhaustedBoxes = new Map(); // korob → true|false (все строки этого короба qty=0?)
  for (const [, entry] of projected) {
    if (entry.rowNumber) {
      const idx = entry.rowNumber - RANGES.FIRST_DATA_ROW;
      const original = snap.rows[idx] || [];
      const origQty = Number(original[COL.QTY]) || 0;
      if (origQty !== entry.qty) {
        updates.push({
          range: `'${RANGES.SHEET}'!${colLetter(COL.QTY)}${entry.rowNumber}`,
          values: [[entry.qty]],
        });
      }
      // Накопим состояние "exhausted" по каждому коробу.
      if (entry.korob) {
        const cur = exhaustedBoxes.get(entry.korob);
        const isZero = entry.qty <= 0;
        if (cur === undefined) exhaustedBoxes.set(entry.korob, isZero);
        else if (!isZero) exhaustedBoxes.set(entry.korob, false);
      }
    }
  }
  // Полный exhaust: проверим что ВСЕ строки этого короба в snapshot теперь qty=0.
  // Если в projected была только часть — досмотрим остальные через snap.byKorobName.
  for (const [korobName, anyZero] of exhaustedBoxes) {
    if (!anyZero) continue;
    const allEntries = snap.byKorobName(korobName);
    let allZero = true;
    for (const e of allEntries) {
      const proj = projected.get(`${e.korob}|${e.barcode}`);
      const q = proj ? proj.qty : e.qty;
      if (q > 0) { allZero = false; break; }
    }
    if (!allZero) continue;
    // Помечаем все строки этого короба как ИЗЪЯТО + R-лог.
    for (const e of allEntries) {
      const rn = e.rowNumber;
      const existingStatus = String(e.status || '').toUpperCase();
      if (existingStatus === 'ИЗЪЯТО') continue;
      const origQty = Number(e.qty) || 0;
      updates.push({
        range: `'${RANGES.SHEET}'!${colLetter(COL.STATUS)}${rn}`,
        values: [['ИЗЪЯТО']],
      });
      // Лог через единый commentAppends — дополнит R-лог изъятий из set_layout.
      addCommentLog(rn, `${todayDDMMYY()} ИЗЪЯТО (было ${origQty}, стало 0) в ${zayavkaId || 'заявку'}`);
    }
    logEvent('info', 'sheet', `короб ${korobName} опустошён целиком → ИЗЪЯТО (${allEntries.length} строк)`, {
      zayavkaId: shortZayavkaId(zayavkaId),
    });
  }

  // Финальная сборка R updates из commentAppends: existingComment + lines.
  for (const [rn, lines] of commentAppends) {
    if (!lines || lines.length === 0) continue;
    const idx = rn - RANGES.FIRST_DATA_ROW;
    const original = (idx >= 0 && idx < snap.rows.length) ? snap.rows[idx] : [];
    const existingComment = String(original[COL.COMMENT] || '');
    const newLines = lines.join('\n');
    const merged = existingComment ? `${existingComment}\n${newLines}` : newLines;
    updates.push({
      range: `'${RANGES.SHEET}'!${colLetter(COL.COMMENT)}${rn}`,
      values: [[merged]],
    });
  }

  const appendRows = [];
  const appendXValues = [];
  for (const [, entry] of newDest) {
    if (entry.qty <= 0) continue;
    appendRows.push(buildShipBoxRow({
      taraType: entry.tara,
      korobNumber: entry.korob,
      status: entry.status,
      zayavkaId: entry.zayavka,
      tipTovara: entry.tip,
      sku: entry.sku,
      qty: entry.qty,
      mp: entry.mp,
      client: entry.client,
      barcode: entry.barcode,
      sklad: entry.sklad,
      dateOtgr: entry.dateOtgr,
      comment: entry.comment,
    }));
    appendXValues.push(entry.zayavka || '');
  }

  return { applied, conflicts, updates, appendRows, appendXValues };
}

function checkExpected(expected, getEntry) {
  if (!expected || expected.length === 0) return null;
  for (const exp of expected) {
    const entry = getEntry(exp.client, exp.korob, exp.barcode);
    const actualQty = entry ? entry.qty : 0;
    if (Number(exp.qty) !== actualQty) {
      return `CAS conflict: ${exp.client}/${exp.korob}/${exp.barcode} expected=${exp.qty} actual=${actualQty}`;
    }
  }
  return null;
}

// === Sheets API helpers ===

async function appendKorobyRows(spreadsheetId, rows) {
  if (!rows.length) return;
  const sheets = getSheets();
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId,
    range: RANGES.DATA,
    // USER_ENTERED — Sheets auto-detect: "20.05.26" → дата (serial), числа → числа,
    // текст с кириллицей и переносами строк остаётся как text. Колонки-даты в листе
    // должны быть форматированы как DD.MM.YY чтобы пользователь видел дату корректно.
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  }), { label: `koroby.append(${rows.length})` });
}

async function batchUpdateValues(spreadsheetId, updates) {
  if (!updates.length) return;
  const sheets = getSheets();
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  }), { label: `koroby.batchUpdate(${updates.length})` });
}

// === Tick scheduler ===

let _schedulerStarted = false;
let _batchTimer = null;
let _refreshTimer = null;

export function startScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;
  _batchTimer = setInterval(() => batchTick().catch(e => console.error('[podbor:batch-tick]', e)), BATCH_TICK_MS);
  _refreshTimer = setInterval(() => refreshTick().catch(e => console.error('[podbor:refresh-tick]', e)), REFRESH_TICK_MS);
  console.log(`[podbor:sync] scheduler started (batch=${BATCH_TICK_MS / 1000}s, refresh=${REFRESH_TICK_MS / 1000}s)`);
}

export function stopScheduler() {
  if (_batchTimer) clearInterval(_batchTimer);
  if (_refreshTimer) clearInterval(_refreshTimer);
  _batchTimer = _refreshTimer = null;
  _schedulerStarted = false;
}

async function batchTick() {
  const ids = await listActiveZayavki();
  if (ids.length === 0) {
    logEvent('info', 'tick', 'batch-tick: активных заявок нет', null);
    return;
  }
  logEvent('info', 'tick', `batch-tick: ${ids.length} заявок`, { ids: ids.map(shortZayavkaId) });
  for (const id of ids) {
    try {
      await flushZayavka(id, { reason: 'batch-tick' });
    } catch (e) {
      logEvent('error', 'tick', `flush failed для ${shortZayavkaId(id)}: ${e.message}`, null);
    }
  }
}

async function refreshTick() {
  try {
    const r = await forwardRefresh();
    logEvent('info', 'tick', `refresh-tick: ${r.rowsCount} строк прочитано`, null);
  } catch (e) {
    logEvent('error', 'tick', `refresh-tick failed: ${e.message}`, null);
  }
}

// === Финал заявки: массовый перевод "В СБОРКЕ" → "СОБРАНО" / "ХРАНЕНИЕ" (для ЯЧ) ===
//
// Используется при zayavka.finish mode='full'. Идёт через тот же mutex,
// что и обычный flush — никаких race'ов с подбором.

export async function finishZayavkaFull(zayavkaNumber) {
  return sheetsMutex.run(async () => {
    const snap = await ensureSnapshot();
    await snap.refresh();
    const updates = [];
    for (let i = 0; i < snap.rows.length; i++) {
      const row = snap.rows[i];
      const zay = String(row[COL.ZAYAVKA] || '').trim();
      if (zay !== zayavkaNumber) continue;
      const status = String(row[COL.STATUS] || '').trim().toUpperCase();
      if (status !== 'В СБОРКЕ') continue;
      const tara = String(row[COL.TARA] || '').trim().toUpperCase();
      const newStatus = tara === 'ЯЧ' ? 'ХРАНЕНИЕ' : 'СОБРАНО';
      const rowNumber = RANGES.FIRST_DATA_ROW + i;
      updates.push({
        range: `'${RANGES.SHEET}'!${colLetter(COL.STATUS)}${rowNumber}`,
        values: [[newStatus]],
      });
    }
    if (updates.length > 0) {
      logEvent('info', 'sheet', `finish: перевод ${updates.length} строк В СБОРКЕ→СОБРАНО/ХРАНЕНИЕ`, {
        zayavkaId: shortZayavkaId(zayavkaNumber),
        rowCount: updates.length,
      });
      await batchUpdateValues(snap.spreadsheetId, updates);
      await snap.refresh();
    } else {
      logEvent('info', 'sheet', `finish: 0 строк В СБОРКЕ для ${shortZayavkaId(zayavkaNumber)} (уже завершено?)`, null);
    }
    return { transitioned: updates.length };
  });
}

// === Public API ===

export async function getZayavkaState(zayavkaId) {
  const queue = await readQueue(zayavkaId);
  // БД-статус читаем здесь же — фронт по нему блокирует UI при СОБРАНО.
  let bdStatus = null;
  try {
    const { readZayavkaStatus } = await import('./bd-writer.js');
    bdStatus = await readZayavkaStatus(zayavkaId);
  } catch (e) {
    // не критично — вернём null
  }
  // Event-store state: pickedByBarcode, nach summary, events count, status —
  // primary source of truth для фронта.
  let eventStore = null;
  let boxesView = null;
  try {
    const { readState } = await import('./zayavka-store.js');
    const { buildClientBoxesView } = await import('./client-boxes-view.js');
    const s = await readState(zayavkaId);
    if (s) {
      eventStore = {
        meta: s.meta,
        shipBoxes: s.shipBoxes,
        eventsCount: (s.events || []).length,
        pickedByBarcode: s.computed.pickedByBarcode || {},
        nach: {
          totalPaidUnits: s.computed.nach?.totalPaidUnits || 0,
          totalCharge: s.computed.nach?.totalCharge || 0,
          ratePerUnit: s.computed.nach?.ratePerUnit || 10,
          ks: s.computed.nach?.ks || 1,
          paidBarcodeCount: Object.keys(s.computed.nach?.paidByBarcode || {}).length,
        },
      };
      // boxesView: derive актуального содержимого источников (sourceOriginals
      // + applied events). Фронт использует чтобы перерисовать r.qty в полотне.
      boxesView = buildClientBoxesView(s);
    }
  } catch (e) {
    // не критично
  }
  return {
    zayavkaId,
    pendingOps: queue.ops || [],
    shipBoxes: queue.shipBoxes || [],
    lastFlushAt: queue.lastFlushAt || 0,
    lastFlushResult: queue.lastFlushResult || null,
    snapshotAge: _snapshot ? Date.now() - _snapshot.lastReadAt : null,
    bdStatus,
    eventStore, // null если state-файл ещё не создан (заявка не была начата)
    boxesView,  // null если state-файл ещё не создан; иначе { koroby: {korob: {bar: qty}}, computedAt }
  };
}

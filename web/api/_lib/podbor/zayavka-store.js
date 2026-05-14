// Единый JSON-state на заявку — source of truth для всего модуля Подбор.
//
// Принципы:
// 1. Файл `<PODBOR_DATA_DIR>/zayavki/<safe_id>.json` — primary store.
//    Лист "🍬 КОРОБЫ" — write-through cache для downstream-систем (legacy GAS,
//    дашборды). При расхождении JSON ↔ лист — JSON прав.
// 2. Atomic write: tmp-файл + rename. Не теряем данные на rare-падении.
// 3. Per-zayavka async mutex — параллельные подборщики сериализуются на бэке,
//    JSON всегда консистентен (никаких lost updates).
// 4. Бесконечный append-only `events[]` журнал + derived `computed` секция.
//    Derived всегда можно пересчитать из events (см. computed.js).
// 5. Архивирование: после финиша/закрытия — переезд в _done/.
//
// Структура файла:
// {
//   "zayavkaId", "schemaVersion": 1,
//   "meta": { client, mp, ks, warehouse, finalWarehouse, dateOtgr, status,
//             pickers: [], createdAt, startedAt, finishedAt, updatedAt },
//   "request": { items: [{barcode, qty, sku}] },
//   "shipBoxes": [{ number, short, tara, dimensions, owner, createdAt, createdBy }],
//   "events": [{ ts, type, by, ...payload }],
//   "computed": { pickedByBarcode, sourceBoxes, nach, lastComputedAt }
// }

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SCHEMA_VERSION = 1;

// Корневая папка state-файлов Подбора.
// На production ОБЯЗАТЕЛЬНО абсолютный путь ВНЕ директории релиза.
function podborDataRoot() {
  const explicit = process.env.PODBOR_DATA_DIR;
  if (explicit && explicit.trim()) {
    return path.resolve(PROJECT_ROOT, explicit.trim());
  }
  const dataDir = process.env.DATA_DIR || './data';
  return path.resolve(PROJECT_ROOT, dataDir, 'podbor');
}

const ZAYAVKI_DIR = () => path.join(podborDataRoot(), 'zayavki');
const DONE_DIR = () => path.join(podborDataRoot(), '_done');

let _ensured = false;
async function ensureDirs() {
  if (_ensured) return;
  await fs.mkdir(ZAYAVKI_DIR(), { recursive: true });
  await fs.mkdir(DONE_DIR(), { recursive: true });
  _ensured = true;
}

function safeFileName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function zayavkaPath(zayavkaId) {
  return path.join(ZAYAVKI_DIR(), safeFileName(zayavkaId) + '.json');
}

// === Per-zayavka async mutex (chain of promises) ===
// Несколько подборщиков → events последовательно, никаких lost writes.
//
// ⚠️ Timeout 30с (LOCK_TIMEOUT_MS) на каждый fn() обязателен. Без него одна
// упавшая/зависшая операция (network call без таймаута, file-lock contention)
// порождала бы deadlock: следующая операция ждёт `prev.then(...)`, который
// никогда не resolves. Симптом — `zayavka.finish` (или любой другой атом)
// не возвращает ответа, рестарт сервера лечит. См. memory/project_mutex_deadlock_zayavka_store.md.
const _mutexChains = new Map();
const LOCK_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`zayavka-store lock timeout ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function withLock(zayavkaId, fn) {
  const prev = _mutexChains.get(zayavkaId) || Promise.resolve();
  // Каждый fn() обёрнут в Promise.race с timeout — если зависнет, chain
  // сдвинется через 30с с rejected promise, а не зависнет forever.
  const next = prev.then(() => withTimeout(Promise.resolve().then(fn), LOCK_TIMEOUT_MS, zayavkaId))
    .catch(err => { throw err; });
  // Цепочка swallow'ит ошибки, чтобы следующая операция не унаследовала reject.
  _mutexChains.set(zayavkaId, next.catch(() => {}));
  return next;
}

// === Atomic read/write ===
async function readJsonOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// === Public API ===

// Создать пустой state-файл для заявки (если ещё нет), с минимальной мета-инфой.
// meta может быть пустой — потом дополнится при первом zayavka.start событии.
function emptyState(zayavkaId, partialMeta = {}) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    zayavkaId,
    meta: {
      client: partialMeta.client || '',
      mp: partialMeta.mp || '',
      ks: typeof partialMeta.ks === 'number' && partialMeta.ks > 0 ? partialMeta.ks : 1,
      warehouse: partialMeta.warehouse || '',
      finalWarehouse: partialMeta.finalWarehouse || '',
      dateOtgr: partialMeta.dateOtgr || '',
      status: 'СОЗДАНО',
      pickers: [],
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    },
    request: { items: partialMeta.requestItems || [] },
    // sourceOriginals: snapshot содержимого коробов-источников клиента в момент
    // первого zayavka.start. Используется computed.js для определения free/paid
    // источника по ИСХОДУ (источник опустошён в отгрузку без ячеек), а не по
    // методу события (set_layout vs full_to_ship). См. computed.js classification.
    // Структура: { korob: { tara: 'К_1.0'|..., items: { barcode: origQty } } }.
    // Ячейки (tara='ЯЧ') не снэпшотим — для них правила free не применимы.
    sourceOriginals: {},
    shipBoxes: [],
    events: [],
    computed: {
      pickedByBarcode: {},
      sourceBoxes: {},
      nach: { paidByBarcode: {}, totalPaidUnits: 0, totalCharge: 0 },
      lastComputedAt: 0,
    },
  };
}

export async function readState(zayavkaId) {
  await ensureDirs();
  const state = await readJsonOrNull(zayavkaPath(zayavkaId));
  return state;
}

// Загрузить state или создать новый. Используется при первом обращении к заявке.
// partialMeta используется ТОЛЬКО при первой инициализации; если файл уже есть —
// игнорируется (state не перезаписываем мета-данными).
export async function getOrInit(zayavkaId, partialMeta = {}) {
  return withLock(zayavkaId, async () => {
    await ensureDirs();
    const existing = await readJsonOrNull(zayavkaPath(zayavkaId));
    if (existing) return existing;
    const fresh = emptyState(zayavkaId, partialMeta);
    await atomicWriteJson(zayavkaPath(zayavkaId), fresh);
    return fresh;
  });
}

// Низкоуровневая транзакция: read → mutate → write. Под mutex. Используется
// для events.appendEvent и для обновления мета-инфы.
export async function transact(zayavkaId, mutator) {
  return withLock(zayavkaId, async () => {
    await ensureDirs();
    let state = await readJsonOrNull(zayavkaPath(zayavkaId));
    if (!state) state = emptyState(zayavkaId);
    const result = await mutator(state);
    state.meta.updatedAt = Date.now();
    await atomicWriteJson(zayavkaPath(zayavkaId), state);
    return result === undefined ? state : result;
  });
}

// Список zayavkaId всех активных заявок (state-файл существует).
export async function listActive() {
  await ensureDirs();
  const files = await fs.readdir(ZAYAVKI_DIR()).catch(() => []);
  return files.filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).map(f => f.slice(0, -5));
}

// Архивирование: переезд state-файла в _done с таймстампом.
// Не атомарно с обновлением листа — вызывается после успешной записи в "🍬 КОРОБЫ".
export async function archive(zayavkaId, finalState) {
  return withLock(zayavkaId, async () => {
    await ensureDirs();
    const src = zayavkaPath(zayavkaId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(DONE_DIR(), safeFileName(zayavkaId) + '-' + ts + '.json');
    if (finalState) {
      finalState.meta.finishedAt = Date.now();
      await atomicWriteJson(dst, finalState);
      try { await fs.unlink(src); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else {
      try { await fs.rename(src, dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  });
}

// Для диагностики: возвращаем путь к файлу (отображается в логах sync-engine).
export function pathFor(zayavkaId) {
  return zayavkaPath(zayavkaId);
}

export function getDataRoot() { return podborDataRoot(); }

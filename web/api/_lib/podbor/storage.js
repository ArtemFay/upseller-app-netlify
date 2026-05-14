// Persistent storage for Подбор sync engine.
//
// Каталоги под data/podbor/:
//   queues/<zayavkaId>.json — буфер pending-операций активной заявки
//   locks/<zayavkaId>.json  — lock-state (кто держит заявку)
//   _done/<zayavkaId>.json  — архив после финиша/закрытия (для аудита)
//
// Atomic write: пишем во временный файл рядом + rename. На Windows и Linux
// rename — atomic в пределах одной FS, что нам и нужно.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// DATA_DIR из .env, дефолт ./data рядом с server/
function dataRoot() {
  const env = process.env.DATA_DIR;
  if (env) return path.resolve(PROJECT_ROOT, env);
  return path.resolve(PROJECT_ROOT, 'data');
}

const PODBOR_ROOT = () => path.join(dataRoot(), 'podbor');
const QUEUES_DIR = () => path.join(PODBOR_ROOT(), 'queues');
const LOCKS_DIR = () => path.join(PODBOR_ROOT(), 'locks');
const DONE_DIR = () => path.join(PODBOR_ROOT(), '_done');

let _ensured = false;
async function ensureDirs() {
  if (_ensured) return;
  await fs.mkdir(QUEUES_DIR(), { recursive: true });
  await fs.mkdir(LOCKS_DIR(), { recursive: true });
  await fs.mkdir(DONE_DIR(), { recursive: true });
  _ensured = true;
}

function safeFileName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function readJsonOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// === Queues (буфер pending-операций) ===

export async function readQueue(zayavkaId) {
  await ensureDirs();
  const p = path.join(QUEUES_DIR(), safeFileName(zayavkaId) + '.json');
  return (await readJsonOrNull(p)) || { zayavkaId, ops: [], updatedAt: 0 };
}

export async function writeQueue(zayavkaId, queue) {
  await ensureDirs();
  const p = path.join(QUEUES_DIR(), safeFileName(zayavkaId) + '.json');
  queue.updatedAt = Date.now();
  await atomicWriteJson(p, queue);
}

export async function deleteQueue(zayavkaId) {
  await ensureDirs();
  const p = path.join(QUEUES_DIR(), safeFileName(zayavkaId) + '.json');
  try { await fs.unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export async function listActiveZayavki() {
  await ensureDirs();
  const files = await fs.readdir(QUEUES_DIR()).catch(() => []);
  return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

// === Locks ===

export async function readLock(zayavkaId) {
  await ensureDirs();
  const p = path.join(LOCKS_DIR(), safeFileName(zayavkaId) + '.json');
  return await readJsonOrNull(p);
}

export async function writeLock(zayavkaId, lock) {
  await ensureDirs();
  const p = path.join(LOCKS_DIR(), safeFileName(zayavkaId) + '.json');
  await atomicWriteJson(p, lock);
}

export async function deleteLock(zayavkaId) {
  await ensureDirs();
  const p = path.join(LOCKS_DIR(), safeFileName(zayavkaId) + '.json');
  try { await fs.unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// === Archive (после финиша / close) ===

export async function archiveZayavka(zayavkaId, payload) {
  await ensureDirs();
  const fname = safeFileName(zayavkaId) + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  const p = path.join(DONE_DIR(), fname);
  await atomicWriteJson(p, payload);
  await deleteQueue(zayavkaId);
  await deleteLock(zayavkaId);
}

import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '/var/lib/upseller';
const FILE = path.join(DATA_DIR, 'users.json');

let _cache = null;
let _writeLock = Promise.resolve();

async function load() {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    _cache = JSON.parse(raw) || {};
  } catch {
    _cache = {};
  }
  return _cache;
}

async function save(obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, FILE);
  _cache = obj;
}

function withWriteLock(fn) {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.catch(() => {});
  return next;
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

export async function getUser(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const all = await load();
  return all[key] || null;
}

export async function listUsers() {
  const all = await load();
  return Object.values(all).sort((a, b) => {
    if (a.role === 'admin' && b.role !== 'admin') return -1;
    if (b.role === 'admin' && a.role !== 'admin') return 1;
    return a.email.localeCompare(b.email);
  });
}

export async function upsertUser({ email, role, createdBy }) {
  const key = normalizeEmail(email);
  if (!key) throw new Error('Email обязателен.');
  return await withWriteLock(async () => {
    const all = await load();
    const existing = all[key];
    const record = {
      email: key,
      role: role === 'admin' ? 'admin' : 'user',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: existing?.createdBy || createdBy || null,
    };
    all[key] = record;
    await save(all);
    return record;
  });
}

export async function removeUser(email) {
  const key = normalizeEmail(email);
  if (!key) return;
  await withWriteLock(async () => {
    const all = await load();
    delete all[key];
    await save(all);
  });
}

let _adminSeeded = false;
export async function ensureAdminSeeded() {
  if (_adminSeeded) return;
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!adminEmail) { _adminSeeded = true; return; }
  const existing = await getUser(adminEmail);
  if (!existing || existing.role !== 'admin') {
    await upsertUser({ email: adminEmail, role: 'admin', createdBy: 'seed' });
  }
  _adminSeeded = true;
}

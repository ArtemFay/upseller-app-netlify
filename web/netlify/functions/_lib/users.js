import { getStore } from '@netlify/blobs';

function store() {
  return getStore({ name: 'users', consistency: 'strong' });
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

export async function getUser(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  return await store().get(key, { type: 'json' });
}

export async function listUsers() {
  const result = await store().list();
  const blobs = result.blobs || [];
  const users = await Promise.all(blobs.map(b => store().get(b.key, { type: 'json' })));
  return users
    .filter(Boolean)
    .sort((a, b) => {
      if (a.role === 'admin' && b.role !== 'admin') return -1;
      if (b.role === 'admin' && a.role !== 'admin') return 1;
      return a.email.localeCompare(b.email);
    });
}

export async function upsertUser({ email, role, createdBy }) {
  const key = normalizeEmail(email);
  if (!key) throw new Error('Email обязателен.');
  const existing = await getUser(key);
  const record = {
    email: key,
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: existing?.createdBy || createdBy || null,
  };
  await store().setJSON(key, record);
  return record;
}

export async function removeUser(email) {
  const key = normalizeEmail(email);
  if (!key) return;
  await store().delete(key);
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

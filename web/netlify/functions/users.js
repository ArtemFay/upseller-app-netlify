import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireAdmin } from './_lib/auth.js';
import { listUsers, upsertUser, removeUser } from './_lib/users.js';

export default async function handler(request) {
  try {
    const admin = await requireAdmin(request);

    if (request.method === 'GET') {
      const users = await listUsers();
      return jsonResponse({ users });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { email, role } = body || {};
      if (!email) throw Object.assign(new Error('email обязателен'), { status: 400 });
      const record = await upsertUser({ email, role, createdBy: admin.email });
      return jsonResponse({ user: record });
    }

    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const { email } = body || {};
      if (!email) throw Object.assign(new Error('email обязателен'), { status: 400 });
      if (String(email).toLowerCase() === admin.email) {
        throw Object.assign(new Error('Нельзя удалить самого себя.'), { status: 400 });
      }
      await removeUser(email);
      return jsonResponse({ ok: true });
    }

    return errorResponse(new Error('Method not allowed'), 405);
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

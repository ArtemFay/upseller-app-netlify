import { jsonResponse, errorResponse } from './_lib/google.js';
import {
  verifyGoogleIdToken,
  createSessionJwt,
  buildSessionCookie,
} from './_lib/auth.js';
import { getUser, ensureAdminSeeded } from './_lib/users.js';

export default async function handler(request) {
  if (request.method !== 'POST') return errorResponse(new Error('Method not allowed'), 405);
  try {
    await ensureAdminSeeded();
    const body = await request.json().catch(() => ({}));
    const idToken = body?.idToken;
    if (!idToken) throw Object.assign(new Error('idToken не передан.'), { status: 400 });

    const googleUser = await verifyGoogleIdToken(idToken);

    const whitelisted = await getUser(googleUser.email);
    if (!whitelisted) {
      const err = new Error(`Email ${googleUser.email} не в списке разрешённых. Обратитесь к администратору.`);
      err.status = 403;
      throw err;
    }

    const jwt = await createSessionJwt({ email: whitelisted.email, role: whitelisted.role });

    return new Response(JSON.stringify({
      user: {
        email: whitelisted.email,
        role: whitelisted.role,
        name: googleUser.name,
        picture: googleUser.picture,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': buildSessionCookie(jwt),
      },
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

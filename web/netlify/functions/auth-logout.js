import { clearSessionCookie } from './_lib/auth.js';

export default async function handler() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}

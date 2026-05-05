import { OAuth2Client } from 'google-auth-library';
import * as jose from 'jose';
import { getUser, ensureAdminSeeded } from './users.js';

export const SESSION_COOKIE = 'upseller_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 дней

// AUTH_DISABLED=true — корневой переключатель локального запуска без Google.
// Активируется через .env. На VPS-проде переменная не выставлена → авторизация работает штатно.
// Подставляет фиктивного администратора `dev@local`, чтобы все модули открывались без OAuth.
export const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';
export const DEV_USER = Object.freeze({
  email: 'dev@local',
  role: 'admin',
  name: 'Local Dev',
  picture: '',
});

function getJwtSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET не установлен или слишком короткий (нужно ≥32 символа).');
  }
  return new TextEncoder().encode(secret);
}

export async function verifyGoogleIdToken(idToken) {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_WEB_CLIENT_ID не установлен в окружении Netlify.');
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) throw new Error('Некорректный Google ID token.');
  if (!payload.email_verified) throw new Error('Google-аккаунт без подтверждённого email.');
  return {
    email: String(payload.email).toLowerCase(),
    name: payload.name || '',
    picture: payload.picture || '',
  };
}

export async function createSessionJwt({ email, role }) {
  return await new jose.SignJWT({ email, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(getJwtSecret());
}

export async function verifySessionJwt(token) {
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    return { email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

function cookieSecureFlag() {
  // Disable Secure flag only when COOKIE_SECURE=false (for local http dev).
  // Production over https on VPS leaves it on.
  return process.env.COOKIE_SECURE === 'false' ? '' : 'Secure; ';
}

export function buildSessionCookie(jwt) {
  return `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; ${cookieSecureFlag()}SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieSecureFlag()}SameSite=Lax; Max-Age=0`;
}

export function getSessionTokenFromRequest(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function getUserFromRequest(request) {
  if (AUTH_DISABLED) return DEV_USER;
  await ensureAdminSeeded();
  const token = getSessionTokenFromRequest(request);
  const session = await verifySessionJwt(token);
  if (!session?.email) return null;
  // После удаления из whitelist — сессия становится недействительной
  const dbUser = await getUser(session.email);
  if (!dbUser) return null;
  return dbUser;
}

export async function requireUser(request) {
  const user = await getUserFromRequest(request);
  if (!user) {
    const err = new Error('Требуется вход в систему.');
    err.status = 401;
    throw err;
  }
  return user;
}

export async function requireAdmin(request) {
  const user = await requireUser(request);
  if (user.role !== 'admin') {
    const err = new Error('Доступ только для администратора.');
    err.status = 403;
    throw err;
  }
  return user;
}

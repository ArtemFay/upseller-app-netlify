import { jsonResponse, errorResponse } from './_lib/google.js';
import { AUTH_DISABLED, getUserFromRequest } from './_lib/auth.js';

export default async function handler(request) {
  try {
    const user = await getUserFromRequest(request);
    return jsonResponse({
      user,
      googleClientId: AUTH_DISABLED ? null : (process.env.GOOGLE_WEB_CLIENT_ID || null),
      devMode: AUTH_DISABLED,
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

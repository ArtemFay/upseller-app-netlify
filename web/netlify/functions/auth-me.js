import { jsonResponse, errorResponse } from './_lib/google.js';
import { getUserFromRequest } from './_lib/auth.js';

export default async function handler(request) {
  try {
    const user = await getUserFromRequest(request);
    return jsonResponse({
      user,
      googleClientId: process.env.GOOGLE_WEB_CLIENT_ID || null,
    });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

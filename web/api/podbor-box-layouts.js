import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getBoxLayouts } from './_lib/podbor/runtime.js';

export default async function handler(request) {
  try {
    await requireUser(request);
    return jsonResponse({ layouts: getBoxLayouts() });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}

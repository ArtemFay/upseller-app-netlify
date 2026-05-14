// GET /api/podbor/archive-detail?file=<filename.json>
//   ИЛИ
// GET /api/podbor/archive-detail?zayavka=<zayavkaId>
//
// Возвращает полный state-снэпшот завершённой заявки из _done/.
// Read-only — используется страницей «История заявок» для detail-вью.
//
// Безопасность:
//   • `file` валидируется regex'ом — only `[A-Za-z0-9._-]+\.json`, никаких `../`.
//   • Финальный path проверяется на нахождение строго внутри _done/.

import fs from 'fs/promises';
import path from 'path';
import { jsonResponse, errorResponse } from './_lib/google.js';
import { requireUser } from './_lib/auth.js';
import { getDataRoot } from './_lib/podbor/zayavka-store.js';

const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+\.json$/;

async function findByZayavkaId(doneDir, zayavkaId) {
  // safeFileName в zayavka-store заменяет всё не [A-Za-z0-9._-] на '_'.
  // Имя архивного файла: <safe_id>-<ISO_ts>.json. Может быть несколько (если
  // заявка финишировалась несколько раз) — берём свежий по mtime.
  const files = await fs.readdir(doneDir).catch(() => []);
  const safe = String(zayavkaId).replace(/[^A-Za-z0-9._-]/g, '_');
  const candidates = files.filter(f => f.startsWith(safe + '-') && f.endsWith('.json') && !f.endsWith('.tmp'));
  if (!candidates.length) return null;
  // По имени файла: ISO timestamp в конце — лексикографическая сортировка == хронологическая.
  candidates.sort();
  return candidates[candidates.length - 1];
}

export default async function handler(request) {
  try {
    await requireUser(request);
    if (request.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);
    const url = new URL(request.url);
    const fileParam = (url.searchParams.get('file') || '').trim();
    const zayavkaParam = (url.searchParams.get('zayavka') || '').trim();

    const doneDir = path.join(getDataRoot(), '_done');
    let filename = null;

    if (fileParam) {
      if (!SAFE_FILENAME_RE.test(fileParam)) {
        return jsonResponse({ error: 'invalid file parameter' }, 400);
      }
      filename = fileParam;
    } else if (zayavkaParam) {
      filename = await findByZayavkaId(doneDir, zayavkaParam);
      if (!filename) return jsonResponse({ error: 'not_found' }, 404);
    } else {
      return jsonResponse({ error: 'file or zayavka required' }, 400);
    }

    const fullPath = path.join(doneDir, filename);
    // Дополнительный sanity-check: путь должен оставаться внутри doneDir.
    const resolved = path.resolve(fullPath);
    const resolvedDir = path.resolve(doneDir);
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      return jsonResponse({ error: 'path traversal blocked' }, 400);
    }

    let raw;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return jsonResponse({ error: 'not_found' }, 404);
      throw e;
    }
    let state;
    try { state = JSON.parse(raw); }
    catch (e) { return jsonResponse({ error: 'corrupt_state: ' + e.message }, 500); }

    return jsonResponse({ state, _filename: filename });
  } catch (e) {
    return errorResponse(e, e.status || 500);
  }
}

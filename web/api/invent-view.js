import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireUser } from './_lib/auth.js';
import templateEngine from './_lib/invent/template-engine.cjs';
import gasMock from './_lib/invent/gas-mock.cjs';
import sheetsClient from './_lib/invent/sheets-client.js';

const { processTemplate } = templateEngine;
const { getGasMockScript } = gasMock;

const functionFilePath = fileURLToPath(import.meta.url);
const functionDir = path.dirname(functionFilePath);

const INVENT_WEB_CFG = {
  title: 'Invent Web',
  appVersion: 'v041.03',
  releaseNotes: 'INVENT встроен в Upseller через Netlify route',
  baseUrl: '/invent-tablet/',
};

function buildStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function readTemplate(name) {
  return readFileSync(path.join(functionDir, '_lib', 'invent', 'templates', name), 'utf-8');
}

function injectGasMock(html) {
  const script = getGasMockScript('/api/invent-run');
  const firstScript = html.indexOf('<script>');
  if (firstScript !== -1) {
    return html.slice(0, firstScript) + script + '\n' + html.slice(firstScript);
  }
  return html.replace('</body>', script + '\n</body>');
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function renderTemplate(name, payload, context) {
  const html = processTemplate(readTemplate(name), { payload, context });
  return injectGasMock(html);
}

function buildBaseContext(extra = {}) {
  return {
    title: INVENT_WEB_CFG.title,
    baseUrl: INVENT_WEB_CFG.baseUrl,
    returnUrl: INVENT_WEB_CFG.baseUrl,
    appVersion: INVENT_WEB_CFG.appVersion,
    buildStamp: buildStamp(),
    releaseNotes: INVENT_WEB_CFG.releaseNotes,
    ...extra,
  };
}

async function renderStart() {
  const payload = {
    headers: [],
    rows: [],
    syncRevision: '0',
    stats: { rows: 0, boxes: 0, verifiedRows: 0, errors: 0 },
  };
  const activeSessions = await sheetsClient.getActiveSessions();
  return htmlResponse(renderTemplate('invent web app.html', payload, buildBaseContext({
    viewMode: 'start',
    activeSessions,
  })));
}

async function renderWork(reportId) {
  const shortMatch = String(reportId || '').match(/^([A-Z]{2}\d{3})/);
  const chernSheetName = shortMatch ? shortMatch[1] : '';

  const [payload, clientName] = await Promise.all([
    sheetsClient.getChernWebListData(reportId, chernSheetName),
    sheetsClient.getClientNameByReportId(reportId),
  ]);

  return htmlResponse(renderTemplate('invent web app.html', payload, buildBaseContext({
    viewMode: 'work',
    reportId,
    chernSheetName,
    clientName,
  })));
}

async function renderList() {
  const payload = await sheetsClient.getInventWebListData();
  return htmlResponse(renderTemplate('invent web app.html', payload, buildBaseContext({
    viewMode: 'legacy',
  })));
}

async function renderEdit(rowNumber) {
  const payload = await sheetsClient.getBoxEditorPayload(Number(rowNumber));
  return htmlResponse(renderTemplate('редактор короба форма.html', payload, buildBaseContext({
    isWebApp: true,
  })));
}

async function renderCreate() {
  const payload = await sheetsClient.getNewBoxEditorPayload();
  return htmlResponse(renderTemplate('редактор короба форма.html', payload, buildBaseContext({
    isWebApp: true,
  })));
}

async function renderLog() {
  return htmlResponse(renderTemplate('log заглушка.html', {}, buildBaseContext({
    title: 'LOG',
  })));
}

function loginRedirect(request) {
  const next = '/invent-tablet/' + new URL(request.url).search;
  return Response.redirect(new URL(`/login/?next=${encodeURIComponent(next)}`, request.url), 302);
}

export default async function handler(request) {
  try {
    await requireUser(request);

    const url = new URL(request.url);
    const view = String(url.searchParams.get('view') || '').trim();
    const reportId = String(url.searchParams.get('report') || '').trim();

    if (view === 'edit') return await renderEdit(url.searchParams.get('row'));
    if (view === 'create') return await renderCreate();
    if (view === 'log') return await renderLog();
    if (view === 'list') return await renderList();
    if (reportId) return await renderWork(reportId);
    return await renderStart();
  } catch (error) {
    if (error?.status === 401) return loginRedirect(request);
    const message = error && error.message ? error.message : String(error);
    return htmlResponse(`<h3>Ошибка INVENT</h3><pre>${message}</pre>`, error?.status || 500);
  }
}

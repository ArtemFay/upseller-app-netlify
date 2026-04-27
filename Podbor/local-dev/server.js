require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { loadActiveZayavki, getUniqueClients, getZayavkiByClient } = require('./lib/active-zayavki');
const { loadClientBoxes } = require('./lib/podbory-load');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

let zayavkiCache = null;
let zayavkiCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000;

// Mock in-memory store of verification state. Keyed by `${client}|${korob}|${barcode}`.
// Replaced later with a real DB.
const verifiedStore = new Map();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 1e6) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function getZayavki() {
  const now = Date.now();
  if (!zayavkiCache || now - zayavkiCacheTime > CACHE_TTL_MS) {
    zayavkiCache = await loadActiveZayavki();
    zayavkiCacheTime = now;
  }
  return zayavkiCache;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let rel = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not Found'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/clients') {
      const zayavki = await getZayavki();
      return sendJson(res, 200, getUniqueClients(zayavki));
    }
    if (url.pathname === '/api/zayavki') {
      const client = url.searchParams.get('client');
      if (!client) return sendJson(res, 400, { error: 'client param required' });
      const zayavki = await getZayavki();
      return sendJson(res, 200, getZayavkiByClient(zayavki, client));
    }
    if (url.pathname === '/api/zayavki-list') {
      const t0 = Date.now();
      const zayavki = await getZayavki();
      const clients = getUniqueClients(zayavki);
      return sendJson(res, 200, { zayavki, clients, loadMs: Date.now() - t0 });
    }
    if (url.pathname === '/api/load') {
      const client = url.searchParams.get('client');
      if (!client) return sendJson(res, 400, { error: 'client param required' });
      const t0 = Date.now();
      const data = await loadClientBoxes(client);
      data.meta.loadMs = Date.now() - t0;
      return sendJson(res, 200, data);
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const updates = Array.isArray(body.updates) ? body.updates : [];
      for (const u of updates) {
        if (!u || !u.korob) continue;
        const key = `${u.korob}|${u.barcode || ''}`;
        verifiedStore.set(key, { verified: !!u.verified, ts: Date.now() });
      }
      // Имитируем небольшую задержку реальной БД (50–150 мс).
      await new Promise(r => setTimeout(r, 80));
      return sendJson(res, 200, { ok: true, count: updates.length });
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('[api-error]', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[web-podbor] http://localhost:${PORT}`);
  console.log(`[web-podbor] UPSELLER: ${process.env.UPSELLER_ID ? 'OK' : 'MISSING'}`);
  console.log(`[web-podbor] PODBORY:  ${process.env.PODBORY_ID ? 'OK' : 'MISSING'}`);
  console.log(`[web-podbor] SA_KEY:   ${process.env.SA_KEY_PATH ? 'OK' : 'MISSING'}`);
});

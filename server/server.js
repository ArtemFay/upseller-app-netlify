// Upseller — единый Express-сервер всего сайта.
// Обслуживает: главную (плитки модулей), общий auth, статику и API всех модулей.
// Источник правды: ../web/ (статика) + ../web/api/ (хендлеры).
// Локально: npm run dev (с AUTH_DISABLED=true в .env)
// VPS: см. ./setup.sh

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const API_ROOT = path.resolve(WEB_ROOT, 'api');

// API-хендлеры (импортируем из web/api/ — единого источника правды).
import authLogin from '../web/api/auth-login.js';
import authMe from '../web/api/auth-me.js';
import authLogout from '../web/api/auth-logout.js';
import users from '../web/api/users.js';
import inventView from '../web/api/invent-view.js';
import inventRun from '../web/api/invent-run.js';
import podborZayavkiList from '../web/api/podbor-zayavki-list.js';
import podborLoad from '../web/api/podbor-load.js';
import podborSync from '../web/api/podbor-sync.js';
import podborShipBoxes from '../web/api/podbor-ship-boxes.js';
import podborShipLabels from '../web/api/podbor-ship-labels.js';
import podborShipLabelQr from '../web/api/podbor-ship-label-qr.js';
import podborBoxLayouts from '../web/api/podbor-box-layouts.js';
import receivingSupplies from '../web/api/receiving-supplies.js';
import receivingBootstrap from '../web/api/receiving-bootstrap.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.raw({ type: '*/*', limit: '5mb' }));

function expressToWebRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, String(x)));
    else if (v !== undefined) headers.set(k, String(v));
  }
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    if (req.body && req.body.length) {
      // Декодируем Node Buffer как UTF-8 строку — иначе Web Request.json()
      // некорректно декодирует кириллицу (получается U+FFFD replacement character).
      init.body = req.body.toString('utf8');
    }
  }
  return new Request(url, init);
}

async function sendWebResponse(res, webRes) {
  res.status(webRes.status);
  const setCookies = typeof webRes.headers.getSetCookie === 'function'
    ? webRes.headers.getSetCookie()
    : [];
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

function adapt(handler) {
  return async (req, res) => {
    try {
      const webRes = await handler(expressToWebRequest(req));
      if (!webRes || typeof webRes.status !== 'number') {
        res.status(500).type('text/plain').send('handler returned invalid response');
        return;
      }
      await sendWebResponse(res, webRes);
    } catch (err) {
      console.error('[adapter]', req.method, req.originalUrl, err);
      res.status(err?.status || 500)
        .type('text/plain')
        .send(`server error: ${err?.message || String(err)}`);
    }
  };
}

// Auth
app.post('/api/auth/login', adapt(authLogin));
app.get('/api/auth/me', adapt(authMe));
app.post('/api/auth/logout', adapt(authLogout));

// Whitelist (admin)
app.get(['/api/users', '/api/users/'], adapt(users));
app.post(['/api/users', '/api/users/'], adapt(users));
app.delete(['/api/users', '/api/users/'], adapt(users));

// Инвент
app.post('/api/invent-run', adapt(inventRun));
app.get(['/invent-tablet', '/invent-tablet/'], adapt(inventView));

// Подбор
app.get('/api/podbor/zayavki-list', adapt(podborZayavkiList));
app.get('/api/podbor/load', adapt(podborLoad));
app.post('/api/podbor/sync', adapt(podborSync));
app.get('/api/podbor/ship-boxes', adapt(podborShipBoxes));
app.get('/api/podbor/ship-labels', adapt(podborShipLabels));
app.get('/api/podbor/ship-label-qr', adapt(podborShipLabelQr));
app.get('/api/podbor/box-layouts', adapt(podborBoxLayouts));

// Приемка
app.get('/api/receiving/supplies', adapt(receivingSupplies));
app.get('/api/receiving/bootstrap', adapt(receivingBootstrap));

// События — в стадии проектирования (плитка disabled на главной).

// Static — единый publish-каталог для всех модулей.
app.use(express.static(WEB_ROOT, {
  extensions: ['html'],
  fallthrough: true,
}));

app.use((req, res) => {
  res.status(404).type('text/plain').send('not found');
});

app.listen(PORT, HOST, () => {
  console.log(`[upseller] listening on ${HOST}:${PORT}`);
  console.log(`[upseller] WEB_ROOT:      ${WEB_ROOT}`);
  console.log(`[upseller] AUTH_DISABLED: ${AUTH_DISABLED ? 'YES (dev stub, no Google)' : 'NO (Google OAuth required)'}`);
});

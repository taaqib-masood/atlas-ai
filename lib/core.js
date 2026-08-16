'use strict';
/**
 * Request pipeline: parse → session load → CSRF check → route → respond.
 * Pure function (request object in, response object out) so the same core
 * serves both the local HTTP server (server.js) and the Function Compute
 * handler (index.js).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { hashToken, csrfForToken, SESSION_TTL_MS } = require('./auth');
const handlers = require('./handlers');
const { HttpError } = require('./errors');
const ext = require('./extensions');
const rf = require('./report-features');
const cp = require('./critical-pending');
const mp = require('./more-pending');
const pdfx = require('./pdf-export');
const l10n = require('./locales');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* Routes: [method, pattern, handlerKey] — pattern may contain :params */
const ROUTES = [
  ['GET', '/', 'home'],
  ['GET', '/browse', 'browse'],
  ['GET', '/categories', 'categoriesPage'],
  ['GET', '/category/:slug', 'categoryPage'],
  ['GET', '/tool/:slug', 'toolDetail'],
  ['GET', '/compare', 'comparePage'],
  ['GET', '/login', 'loginGet'],
  ['POST', '/login', 'loginPost'],
  ['GET', '/register', 'registerGet'],
  ['POST', '/register', 'registerPost'],
  ['POST', '/logout', 'logoutPost'],
  ['GET', '/dashboard', 'dashboard'],
  ['GET', '/admin', 'adminOverview'],
  ['GET', '/admin/tools', 'adminTools'],
  ['GET', '/admin/tools/new', 'adminToolNew'],
  ['POST', '/admin/tools/new', 'adminToolNewPost'],
  ['GET', '/admin/tools/:id/edit', 'adminToolEdit'],
  ['POST', '/admin/tools/:id/edit', 'adminToolEditPost'],
  ['POST', '/admin/tools/:id/action', 'adminToolAction'],
  ['GET', '/admin/history', 'adminHistory'],
  ['POST', '/api/favorites/toggle', 'apiFavoriteToggle'],
  ['POST', '/api/events/view', 'apiEventView'],
  ['GET', '/api/tools', 'apiTools'],
  ['GET', '/api/random', 'randomTool'],
  ['GET', '/healthz', 'healthz'],
  ['GET', '/sitemap.xml', 'sitemap'],
  ['GET', '/robots.txt', 'robots'],
  ...ext.routes,
  ...rf.routes,
  ...cp.routes,
  ...mp.routes,
  // T7: PDF export
  ['GET', '/compare/pdf', 'pdfExport'],
  // T13: Locale init endpoint
  ['GET', '/locales/:lang.json', 'localeFile'],
  // T16: Maker pricing page (already in mp routes)
];

/* Merge extension handlers into the handler lookup */
const ALL_HANDLERS = { ...handlers, ...ext.handlers, ...rf.handlers, ...cp.handlers, ...mp.handlers, pdfExport, localeFile };

function matchRoute(method, pathname) {
  for (const [m, pattern, key] of ROUTES) {
    if (m !== method) continue;
    const segs = pattern.split('/').filter(Boolean);
    const parts = pathname.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (segs[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { key, params };
  }
  return null;
}

async function handleRequest(store, req) {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = req.path || '/';
  const cookies = parseCookies(req.headers && req.headers.cookie);

  /* Session */
  let user = null;
  let sid = null;
  const sidCookie = cookies.sid;
  if (sidCookie) {
    const s = store.getSession(hashToken(sidCookie));
    if (s && s.expires_at > new Date().toISOString()) {
      sid = sidCookie;
      user = store.getUserById(s.user_id);
    } else if (s) {
      store.deleteSession(hashToken(sidCookie));
    }
  }
  if (user) store.cleanupSessions();

  const ctx = {
    store, method, path: pathname, query: req.query || {}, headers: req.headers || {},
    ip: req.ip || '', cookies, user, sid,
    csrf: sid ? csrfForToken(sid) : '',
    anonCsrf: cookies.csrf || '',
  };

  /* Body */
  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && req.bodyRaw) {
    const ct = String(ctx.headers['content-type'] || '');
    if (ct.includes('application/json')) {
      try { body = JSON.parse(req.bodyRaw); } catch { body = {}; }
    } else {
      try { body = Object.fromEntries(new URLSearchParams(req.bodyRaw)); } catch { body = {}; }
    }
  }
  ctx.body = body;

  /* CSRF for state-changing requests — skip for API endpoints using Bearer auth or JSON body */
  const isApiBearer = method === 'POST' && String(ctx.headers.authorization || '').startsWith('Bearer ');
  const isJsonApi = method === 'POST' && String(ctx.headers['content-type'] || '').includes('application/json');
  if (method === 'POST' && !isApiBearer && !isJsonApi) {
    const token = body._csrf || '';
    const valid = user ? (token === ctx.csrf) : (token && token === ctx.anonCsrf);
    if (!valid) return respond(ctx, { status: 403, body: 'Forbidden: invalid CSRF token.' });
  }

  /* Static assets */
  if (method === 'GET' && pathname.startsWith('/assets/')) {
    return serveAsset(ctx, pathname);
  }

  const route = matchRoute(method, pathname);
  if (!route) return respond(ctx, { status: 404, body: 'Not found' });

  ctx.params = route.params;
  try {
    const result = await ALL_HANDLERS[route.key](ctx);
    return respond(ctx, result);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 404) return respond(ctx, { status: 404, body: 'Not found' });
      return respond(ctx, { status: err.status, body: err.message });
    }
    console.error(`[${new Date().toISOString()}] ${method} ${pathname} →`, err);
    return respond(ctx, { status: 500, body: 'Internal server error' });
  }
}

function respond(ctx, result) {
  let status = 200;
  let headers = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' };
  let body = '';

  if (result && result.contentType) {
    status = result.status || 200;
    headers['content-type'] = result.contentType;
    body = result.html || result.body || '';
  } else if (result instanceof HttpError || (result && result.status && typeof result.body === 'string' && !result.html && !result.redirect && !result.json)) {
    status = result.status;
    body = result.body;
    headers['content-type'] = 'text/plain; charset=utf-8';
  } else if (result && result.html !== undefined) {
    headers['content-type'] = 'text/html; charset=utf-8';
    body = result.html;
  } else if (result && result.redirect) {
    status = 303;
    headers.location = result.redirect;
    body = '';
  } else if (result && result.json !== undefined) {
    status = result.status || 200;
    headers['content-type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(result.json);
  } else if (result && result.status) {
    status = result.status;
    headers['content-type'] = 'text/plain; charset=utf-8';
    body = result.body || '';
  } else {
    status = 500;
    headers['content-type'] = 'text/plain; charset=utf-8';
    body = 'Internal server error';
  }

  if (result && result.cookies) {
    headers['set-cookie'] = result.cookies.map((c) => {
      const parts = [`${c.name}=${encodeURIComponent(c.value)}`, 'Path=/', 'SameSite=Lax'];
      if (c.httpOnly) parts.push('HttpOnly');
      if (c.secure) parts.push('Secure');
      if (c.maxAge) parts.push(`Max-Age=${c.maxAge}`);
      return parts.join('; ');
    });
  }

  /* gzip HTML/JSON/text over 1KB */
  const accept = String(ctx.headers['accept-encoding'] || '');
  if (body.length > 1024 && accept.includes('gzip') && headers['content-type'] && (headers['content-type'].startsWith('text/') || headers['content-type'].includes('json'))) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
    body = zlib.gzipSync(Buffer.from(body));
  }

  return { status, headers, body };
}

function serveAsset(ctx, pathname) {
  const name = pathname.replace('/assets/', '');
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
  const publicDir = path.join(__dirname, '..', 'public');
  const file = path.resolve(publicDir, name);
  if (!file.startsWith(publicDir + path.sep)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
  if (!fs.existsSync(file)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
  const ext = path.extname(file).toLowerCase();
  return {
    status: 200,
    headers: {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
      'content-length': String(fs.statSync(file).size),
    },
    body: fs.readFileSync(file),
  };
}

function pdfExport(ctx) { return pdfx.pdfExportPage(ctx); }

function localeFile(ctx) {
  const lang = (ctx.params.lang || 'en').replace(/[^a-z-]/g, '');
  const file = path.join(__dirname, '..', 'locales', lang + '.json');
  if (!fs.existsSync(file)) {
    // Fallback to English
    const enFile = path.join(__dirname, '..', 'locales', 'en.json');
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' }, body: fs.readFileSync(enFile) };
  }
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' }, body: fs.readFileSync(file) };
}

module.exports = { handleRequest, HttpError };

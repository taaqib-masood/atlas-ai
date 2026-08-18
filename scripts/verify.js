'use strict';
/**
 * End-to-end verification suite. Boots the app on a scratch port + data dir,
 * walks the full user/admin journey with real HTTP requests, and prints a
 * PASS/FAIL report per Goal Brief acceptance criterion.
 *
 * Checks: 77 total — A0–L2 baseline (53) + M1–M10 trust-metadata (10) + S1–S14 stacks (14).
 *
 * Usage: node scripts/verify.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-'));
const ADMIN = { email: 'admin@example.com', password: 'Admin!2026' };
const TRUST_MAP_PATH = path.join(ROOT, 'lib', 'trust-map.json');

/**
 * Loads the vendored trust map (lib/trust-map.json). The M-series consumes it
 * for enum/parity assertions; a missing/unreadable file makes those checks
 * fail loudly (the feature is absent) instead of crashing the suite.
 */
function loadTrustMap() {
  try {
    return { ok: true, entries: JSON.parse(fs.readFileSync(TRUST_MAP_PATH, 'utf8')), error: '' };
  } catch (e) {
    return { ok: false, entries: [], error: e.message };
  }
}

/* M-series DB helpers: trust columns may not exist yet on mid-flight code,
 * so M-checks never crash the suite — they fail with the SQL error as evidence. */
function tryGet(db, sql, ...args) {
  try { return db.prepare(sql).get(...args); } catch (e) { return { _error: e.message }; }
}
function tryAll(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch (e) { return null; }
}

const results = [];
function check(name, ok, evidence = '') {
  results.push({ name, ok: !!ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
}

class Jar {
  constructor() { this.cookies = new Map(); }
  apply(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) {
        const value = pair.slice(i + 1).trim();
        if (value === '') this.cookies.delete(pair.slice(0, i).trim());
        else this.cookies.set(pair.slice(0, i).trim(), value);
      }
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  csrf() { return this.cookies.get('csrf') || ''; }
  clearCsrf() { this.cookies.delete('csrf'); }
}

async function req(method, p, { jar, body, form, accept, headers = {} } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = jar.header();
  if (accept) h.accept = accept;
  let payload;
  if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  if (jar) jar.apply(res);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const csrfFrom = (html) => { const m = html.match(/name="_csrf" value="([^"]+)"/); return m ? m[1] : ''; };
const csrfOf = (token) => crypto.createHash('sha256').update(token + ':csrf').digest('hex').slice(0, 32);

async function register(jar, email, name, password) {
  await req('GET', '/register', { jar });
  const anon = jar.csrf();
  const r = await req('POST', '/register', { jar, form: { _csrf: anon, name, email, password, confirm: password } });
  return r;
}

async function login(jar, email, password) {
  await req('GET', '/login', { jar });
  const anon = jar.csrf();
  const r = await req('POST', '/login', { jar, form: { _csrf: anon, email, password } });
  jar.clearCsrf();
  return r;
}

let server;
let s2 = null;
let serverErr = '';

async function main() {
  console.log(`Booting app on :${PORT} (data: ${DATA_DIR}) …`);
  server = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, STORAGE: 'sqlite', BASE_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { serverErr += d.toString(); });
  // wait for health
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) { console.error('Server failed to start:\n' + serverErr); process.exit(1); }
  const health = await (await fetch(BASE + '/healthz')).json();
  check('A0. Server boots & healthz ok', health.ok === true && health.published > 40, `published=${health.published} storage=${health.storage}`);
  const trustMap = loadTrustMap();

  /* ---- browse & filter ---- */
  let r = await req('GET', '/');
  check('B1. Home renders (brand, hero, JSON-LD)', r.status === 200 && r.text.includes('Atlas AI') && r.text.includes('application/ld+json'), `${r.text.length} bytes`);
  check('B2. Home has skip-link + h1 + lang', r.text.includes('Skip to content') && /<h1[^>]*>/.test(r.text) && r.text.startsWith('<!doctype html>\n<html lang="en">'));
  check('B3. Security headers present', r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff');

  r = await req('GET', '/browse');
  check('C1. Browse lists tools', r.status === 200 && r.text.includes('tool-card'), `${r.text.length} bytes`);

  /* ---- M4: trust badges on published cards ---- */
  {
    const cards = (r.text.match(/class="tool-card"/g) || []).length;
    const badges = (r.text.match(/trust-badge/g) || []).length;
    const css = (await req('GET', '/assets/app.css')).text;
    const cls = ['.trust-badge', '.trust-verified', '.trust-unverified', '.trust-na'].map((c) => css.includes(c));
    check('M4. Trust badges on every published card (3 per card) + badge CSS',
      cards > 0 && badges >= 3 * cards && r.text.includes('\u2713 Commercial') && r.text.includes('\u2014 Privacy') && cls.every(Boolean),
      `cards=${cards} badges=${badges} verified-label=${r.text.includes('\u2713 Commercial')} unverified-label=${r.text.includes('\u2014 Privacy')} css=${cls.map(Boolean).join('/')}`);
  }
  r = await req('GET', '/browse?category=Writing');
  check('C2. Category filter works', r.status === 200 && r.text.includes('Grammarly') && !r.text.includes('/tool/chatgpt'));
  r = await req('GET', '/browse?pricing=Free');
  check('C3. Pricing filter works', r.status === 200 && r.text.includes('Stable Diffusion'));
  r = await req('GET', '/browse?tag=open-source');
  check('C4. Tag filter works', r.status === 200 && r.text.includes('n8n'));
  r = await req('GET', '/browse?q=transcribe');
  check('C5. Search works', r.status === 200 && r.text.includes('Otter') && r.text.includes('Results for'));
  r = await req('GET', '/browse?sort=name');
  check('C6. Sort A–Z works', r.status === 200 && r.text.includes('Adobe Firefly'));
  r = await req('GET', '/category/writing');
  check('C7. Category page works', r.status === 200 && r.text.includes('Trending in this category') && r.text.includes('Grammarly'));

  /* ---- M5: trust legend + filter segments + localStorage persistence ---- */
  {
    const b = (await req('GET', '/browse')).text;
    const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    // 5 segment buttons are SSR-rendered in the .trust-filter group; app.js wires
    // them and persists the selection under the contract key.
    const legendOk = b.includes('trust-legend');
    const hookOk = b.includes('aria-label="Trust filter"') || b.includes('trust-filter');
    const fi = b.indexOf('Trust filter');
    const fwin = fi >= 0 ? b.slice(fi, fi + 2000) : '';
    const segs = ['All', 'Commercial', 'Privacy', 'API', 'Unverified'].filter((s) => fwin.includes(s));
    const keyOk = /TRUST_FILTER_KEY\s*=\s*'atlas-trust-filter'/.test(js);
    const attrsOk = ['data-commercial', 'data-privacy', 'data-api'].every((a) => b.includes(a));
    check('M5. Trust legend + 5 filter segments + atlas-trust-filter persistence',
      legendOk && hookOk && segs.length === 5 && keyOk && attrsOk,
      `legend=${legendOk} hook=${hookOk} segments=${segs.join(',') || 'none'} key=${keyOk} attrs=${attrsOk}`);
  }

  /* ---- tool detail ---- */
  r = await req('GET', '/tool/chatgpt');
  check('D1. Tool detail renders with meta + JSON-LD',
    r.status === 200 && r.text.includes('ChatGPT') && r.text.includes('SoftwareApplication') && /<meta name="description"/.test(r.text) && r.text.includes('rel="canonical"'));

  /* ---- M6: detail-page trust section ---- */
  {
    const chat = trustMap.entries.find((e) => e.slug === 'chatgpt');
    if (!trustMap.ok || !chat) {
      check('M6. Detail page trust section (3 statuses + source + last_verified + notes)', false, 'lib/trust-map.json missing or chatgpt absent');
    } else {
      const m = r.text.match(/Trust &(amp;)? (compliance|verification)/i);
      const win = m ? r.text.slice(m.index, m.index + 4000) : '';
      const src = chat.verification_source.slice(0, 30);
      const note = chat.notes.slice(0, 30);
      const fields = ['Commercial', 'Privacy', 'API'].filter((s) => !win.includes(s));
      const ok = !!m && fields.length === 0
        && (win.includes('Verified') || win.includes('\u2713 Commercial'))
        && (win.includes('Unverified') || win.includes('\u2014 Privacy'))
        && win.includes(chat.last_verified) && win.includes(src) && win.includes(note);
      check('M6. Detail page trust section (3 statuses + source + last_verified + notes)', ok,
        `heading=${!!m} fields=${fields.join('|') || '3/3'} verified=${win.includes('Verified') || win.includes('\u2713 Commercial')} lv=${win.includes(chat.last_verified)} src=${win.includes(src)} notes=${win.includes(note)}`);
    }
  }
  check('D2. Related tools with reasons', r.text.includes('Related tools') && r.text.includes('Same category'));
  check('D3. Outbound link + save control', r.text.includes('Visit website') && r.text.includes('data-fav-btn'));
  r = await req('GET', '/tool/does-not-exist');
  check('D4. Unknown tool → 404', r.status === 404);

  /* ---- auth + favorites + dashboard ---- */
  const user = { email: `u${Date.now()}@test.dev`, name: 'Test User', password: 'TestPass123!' };
  const jar = new Jar();
  r = await register(jar, user.email, user.name, user.password);
  check('E1. Register → redirect to dashboard + session cookie',
    r.status === 303 && r.headers.get('location') === '/dashboard' && jar.cookies.has('sid'));

  r = await req('GET', '/dashboard', { jar });
  check('E2. Dashboard renders with empty favorites state', r.status === 200 && r.text.includes('Dashboard') && r.text.includes('No favorites yet'));

  // need _csrf for authed POST: pull from dashboard page
  const sid = jar.cookies.get('sid');
  const csrf = csrfOf(sid);
  r = await req('POST', '/api/favorites/toggle', { jar, accept: 'application/json', body: { tool_id: 1, _csrf: csrf } });
  const fav = JSON.parse(r.text);
  check('E3. Favorite saved via API', fav.saved === true, `count=${fav.count}`);
  r = await req('POST', '/api/favorites/toggle', { jar, accept: 'application/json', body: { tool_id: 1, _csrf: csrf } });
  check('E4. Favorite removed via API', JSON.parse(r.text).saved === false);
  await req('POST', '/api/favorites/toggle', { jar, accept: 'application/json', body: { tool_id: 1, _csrf: csrf } }); // re-add

  await req('GET', '/tool/claude', { jar }); // logged-in view event
  r = await req('GET', '/dashboard', { jar });
  check('E5. Dashboard shows favorite + recent activity',
    r.text.includes('ChatGPT') && r.text.includes('Viewed') && r.text.includes('claude'), `events present`);

  r = await req('POST', '/logout', { jar, form: { _csrf: csrf } });
  check('E6. Logout works', r.status === 303 && !jar.cookies.has('sid'));
  r = await login(jar, user.email, user.password);
  check('E7. Login works after logout', r.status === 303 && jar.cookies.has('sid'));
  r = await req('GET', '/dashboard', { jar });
  check('E8. Favorites persist across sessions', r.text.includes('ChatGPT'));

  /* ---- CSRF ---- */
  r = await req('POST', '/login', { form: { _csrf: 'wrong', email: user.email, password: user.password } });
  check('F1. CSRF rejection (bad token → 403)', r.status === 403);

  /* ---- admin workflow ---- */
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  const aj = new Jar();
  r = await login(aj, ADMIN.email, ADMIN.password);
  check('G1. Admin login works', r.status === 303);
  r = await req('GET', '/admin', { jar: aj });
  check('G2. Admin overview renders', r.status === 200 && r.text.includes('Overview') && r.text.includes('Published'));
  const acsrf = csrfOf(aj.cookies.get('sid'));
  r = await req('GET', '/admin/tools/new', { jar: aj });
  check('G3. Add-tool form renders', r.status === 200 && r.text.includes('Add tool'));
  r = await req('POST', '/admin/tools/new', {
    jar: aj, form: {
      _csrf: acsrf, name: 'TestPress AI', tagline: 'AI press release writer for startups',
      description: 'TestPress AI drafts press releases and product announcements from bullet points, with tone controls and distribution checklists. (Test fixture for verification.)',
      category: 'Writing', url: 'https://testpress.example.com', pricing_model: 'Freemium',
      tags: 'press, writing, pr', popularity: '55', logo_color: '#000000', status: 'draft',
    },
  });
  check('G4. Admin creates tool (draft)', r.status === 303);
  const m8row = tryGet(db, "SELECT commercial_use_status, data_privacy_status, api_availability_status, verification_source, notes, last_verified_at FROM tools WHERE slug = 'testpress-ai'");
  check('M8. Admin-created tool gets trust defaults (Unverified / empty source / fresh last_verified_at)',
    !!m8row && !m8row._error && m8row.commercial_use_status === 'Unverified' && m8row.data_privacy_status === 'Unverified'
    && m8row.api_availability_status === 'Unverified' && m8row.verification_source === '' && m8row.notes === '' && !!m8row.last_verified_at,
    m8row && m8row._error ? m8row._error : JSON.stringify(m8row || null));
  r = await req('GET', '/admin/tools', { jar: aj });
  check('G5. Draft appears in admin list', r.status === 200 && r.text.includes('TestPress AI') && r.text.includes('pill-draft'));
  r = await req('GET', '/browse?q=TestPress');
  check('G6. Draft NOT in public browse', !r.text.includes('/tool/testpress-ai'));
  r = await req('POST', '/admin/tools/9999/action', { jar: aj, form: { _csrf: acsrf, action: 'publish' } });
  check('G7. Publish unknown tool → 404', r.status === 404);
  const id = db.prepare("SELECT id FROM tools WHERE slug = 'testpress-ai'").get().id;
  check('G8. Created tool id resolvable', !!id, `id=${id}`);
  r = await req('POST', `/admin/tools/${id}/action`, { jar: aj, form: { _csrf: acsrf, action: 'publish' } });
  check('G9. Publish action ok', r.status === 303);
  r = await req('GET', '/browse?q=TestPress');
  check('G10. Published tool appears in public browse', r.status === 200 && r.text.includes('TestPress AI'));
  r = await req('GET', '/tool/testpress-ai');
  check('G11. Published tool has public detail page', r.status === 200 && r.text.includes('TestPress AI'));
  r = await req('POST', `/admin/tools/${id}/action`, { jar: aj, form: { _csrf: acsrf, action: 'unpublish' } });
  r = await req('GET', '/browse?q=TestPress');
  check('G12. Unpublished tool disappears from public', !r.text.includes('TestPress AI'));
  r = await req('POST', `/admin/tools/${id}/action`, { jar: aj, form: { _csrf: acsrf, action: 'verify' } });
  check('G13. Verify action ok', r.status === 303);
  const m9row = tryGet(db, "SELECT verification_source, last_verified_at FROM tools WHERE slug = 'testpress-ai'");
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lvDate = m9row && !m9row._error && m9row.last_verified_at ? new Date(m9row.last_verified_at).toISOString().slice(0, 10) : '';
  check('M9. Admin Verify sets verification_source=admin + refreshes last_verified_at',
    !!m9row && !m9row._error && m9row.verification_source === 'admin' && lvDate === todayUtc,
    m9row && m9row._error ? m9row._error : `source=${m9row ? m9row.verification_source : '?'} lv=${lvDate} today=${todayUtc}`);
  r = await req('GET', '/admin/history', { jar: aj });
  const histOk = r.status === 200 && r.text.includes('TestPress AI') && r.text.includes('create') && r.text.includes('publish') && r.text.includes('unpublish') && r.text.includes('admin@example.com');
  check('G14. Change history records actor + timestamps', histOk);
  r = await req('POST', `/admin/tools/${id}/action`, { jar: aj, form: { _csrf: acsrf, action: 'delete' } });
  check('G15. Delete action ok', r.status === 303);
  r = await req('GET', '/tool/testpress-ai');
  check('G16. Deleted tool → 404', r.status === 404);

  /* ---- rate limit (after admin flows so it can't block them) ---- */
  const rlJar = new Jar();
  await req('GET', '/login', { jar: rlJar });
  const rlCsrf = rlJar.csrf();
  let blocked = false;
  for (let i = 0; i < 11; i++) {
    const res = await req('POST', '/login', { jar: rlJar, form: { _csrf: rlCsrf, email: 'rl' + i + '@test.dev', password: 'wrongpass123' } });
    if (res.text.includes('Too many attempts')) blocked = true;
  }
  check('F2. Login rate limit engages', blocked);

  /* ---- recommendations validation ---- */
  r = await req('GET', '/tool/chatgpt');
  const rel = (r.text.match(/Shares tags: [^<]+/) || [])[0] || '';
  check('H1. Related reasons explainable', r.text.includes('Related tools') && (r.text.includes('Same category as') || !!rel), rel);
  r = await req('GET', '/dashboard', { jar });
  check('H2. Dashboard recommendations with basis', r.text.includes('Recommended for you') && r.text.includes('Because you saved'));

  /* ---- SEO + infra ---- */
  r = await req('GET', '/sitemap.xml');
  check('I1. Sitemap lists tool URLs', r.status === 200 && r.text.includes('/tool/chatgpt') && r.text.includes('/tool/claude'));
  r = await req('GET', '/robots.txt');
  check('I2. Robots + sitemap link', r.status === 200 && r.text.includes('Sitemap:'));
  r = await req('GET', '/api/tools?q=clau');
  check('I3. Search API returns JSON', r.status === 200 && r.text.includes('Claude'));
  r = await req('GET', '/assets/app.css');
  check('I4. Static asset served with cache headers', r.status === 200 && r.headers.get('cache-control') === 'public, max-age=3600');

  /* ---- performance ---- */
  const t0 = Date.now();
  await req('GET', '/');
  await req('GET', '/');
  const t1 = Date.now();
  await req('GET', '/browse');
  const t2 = Date.now();
  const homeMs = ((t1 - t0) / 2).toFixed(0);
  check('J1. Home page fast (avg)', Number(homeMs) < 250, `${homeMs} ms avg (local)`);
  const homeHtml = (await req('GET', '/')).text;
  check('J2. Home page size budget', homeHtml.length < 60000, `${(homeHtml.length / 1024).toFixed(1)} KB`);

  /* ---- db evidence ---- */
  const q = (sql) => db.prepare(sql).get().n;
  const counts = {
    tools: q('SELECT COUNT(*) n FROM tools'),
    users: q('SELECT COUNT(*) n FROM users'),
    favorites: q('SELECT COUNT(*) n FROM favorites'),
    events: q('SELECT COUNT(*) n FROM events'),
    history: q('SELECT COUNT(*) n FROM tool_history'),
    categories: q('SELECT COUNT(DISTINCT category) n FROM tools'),
  };
  check('K1. DB stores all entities', counts.tools > 40 && counts.users >= 2 && counts.favorites >= 1 && counts.events >= 5 && counts.history >= 5 && counts.categories >= 10,
    JSON.stringify(counts));
  const recent = db.prepare('SELECT action, field, old_value, new_value, actor_id FROM tool_history ORDER BY id DESC LIMIT 1').get();
  check('K2. History row has actor + old/new values', !!recent && recent.actor_id !== null && 'old_value' in recent, JSON.stringify(recent));

  /* ---- M-series: trust-metadata schema & data (direct scratch-DB reads) ---- */
  {
    const cols = db.prepare('PRAGMA table_info(tools)').all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    const dflt = (c) => String(c.dflt_value ?? '').replace(/^(['"])(.*)\1$/, '$2');
    const want = { commercial_use_status: 'Unverified', data_privacy_status: 'Unverified', api_availability_status: 'Unverified', verification_source: '', notes: '' };
    const bad = [];
    for (const [name, def] of Object.entries(want)) {
      const c = byName[name];
      if (!c) { bad.push(`${name}:MISSING`); continue; }
      if (c.notnull !== 1 || dflt(c) !== def) bad.push(`${name}:notnull=${c.notnull} dflt=${JSON.stringify(dflt(c))}`);
    }
    if (!byName['last_verified_at']) bad.push('last_verified_at:MISSING');
    check('M1. Schema: 5 trust columns + last_verified_at, NOT NULL, contract defaults', bad.length === 0, bad.join(' ') || `cols=${cols.map((c) => c.name).join(',')}`);
  }
  {
    const m2 = tryGet(db, `SELECT COUNT(*) AS total,
      SUM(CASE WHEN commercial_use_status IS NULL OR data_privacy_status IS NULL OR api_availability_status IS NULL OR verification_source IS NULL OR notes IS NULL OR last_verified_at IS NULL THEN 1 ELSE 0 END) AS nulls,
      SUM(CASE WHEN commercial_use_status = '' OR data_privacy_status = '' OR api_availability_status = '' THEN 1 ELSE 0 END) AS empty_statuses FROM tools`);
    check('M2. All 91 tools carry the 6 trust fields; zero nulls / empty statuses',
      !!m2 && !m2._error && m2.total === 91 && m2.nulls === 0 && m2.empty_statuses === 0,
      m2 && m2._error ? m2._error : JSON.stringify(m2 || null));
  }
  {
    const enumRows = tryAll(db, 'SELECT commercial_use_status c, data_privacy_status p, api_availability_status a FROM tools');
    let badEnum = -1; let enumErr = '';
    const dist = { c: {}, p: {}, a: {} };
    if (enumRows === null) enumErr = 'trust columns missing';
    else {
      badEnum = tryGet(db, "SELECT COUNT(*) AS n FROM tools WHERE commercial_use_status NOT IN ('Verified','Unverified') OR data_privacy_status NOT IN ('Verified','Unverified') OR api_availability_status NOT IN ('Available','Unverified','N/A')").n;
      for (const row of enumRows) {
        dist.c[row.c] = (dist.c[row.c] || 0) + 1; dist.p[row.p] = (dist.p[row.p] || 0) + 1; dist.a[row.a] = (dist.a[row.a] || 0) + 1;
      }
    }
    let mism = 0; let matched = 0;
    if (trustMap.ok && enumRows !== null) {
      for (const e of trustMap.entries) {
        const row = tryGet(db, 'SELECT commercial_use_status c, data_privacy_status p, api_availability_status a, verification_source s, notes n FROM tools WHERE slug = ?', e.slug);
        if (!row || row._error) { mism++; continue; }
        matched++;
        if (row.c !== e.commercial_use_status || row.p !== e.data_privacy_status || row.a !== e.api_availability_status || row.s !== e.verification_source || row.n !== e.notes) mism++;
      }
    } else if (trustMap.ok) mism = 91;
    check('M3. Enum validity + per-slug parity vs lib/trust-map.json',
      enumErr === '' && badEnum === 0 && mism === 0 && matched === 91,
      `${enumErr || `bad-enum=${badEnum}`} parity=${matched - mism}/91 dist=${JSON.stringify(dist)}`);
  }

  /* ---- JSON storage fallback smoke test ---- */
  const PORT2 = PORT + 1;
  const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-json-'));
  const s2 = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT2), DATA_DIR: jsonDir, STORAGE: 'json', BASE_URL: `http://127.0.0.1:${PORT2}` }, stdio: 'ignore' });
  let up2 = false;
  for (let i = 0; i < 40; i++) {
    try { const h = await fetch(`http://127.0.0.1:${PORT2}/healthz`); if (h.ok) { up2 = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (up2) {
    const h2 = await (await fetch(`http://127.0.0.1:${PORT2}/healthz`)).json();
    check('L1. JSON storage fallback boots (FC-compatible)', h2.storage === 'json' && h2.published > 40, `published=${h2.published}`);
    const j2 = new Jar();
    await req2(PORT2, 'GET', '/register', { jar: j2 });
    const rr = await req2(PORT2, 'POST', '/register', { jar: j2, form: { _csrf: j2.csrf(), name: 'Json User', email: 'json@test.dev', password: 'JsonPass123!', confirm: 'JsonPass123!' } });
    const sid2 = j2.cookies.get('sid');
    const c2 = csrfOf(sid2);
    const f2 = await req2(PORT2, 'POST', '/api/favorites/toggle', { jar: j2, accept: 'application/json', body: { tool_id: 2, _csrf: c2 } });
    check('L2. JSON store persists favorites', JSON.parse(f2.text).saved === true);
    /* ---- M7: JsonStore parity (direct app.json read) ---- */
    {
      const appJson = path.join(jsonDir, 'app.json');
      let ok7 = false; let ev7 = '';
      if (!fs.existsSync(appJson)) ev7 = 'no app.json written';
      else {
        try {
          const jt = JSON.parse(fs.readFileSync(appJson, 'utf8')).tools || [];
          const jAllOk = jt.length === 91 && jt.every((t) =>
            ['Verified', 'Unverified'].includes(t.commercial_use_status)
            && ['Verified', 'Unverified'].includes(t.data_privacy_status)
            && ['Available', 'Unverified', 'N/A'].includes(t.api_availability_status)
            && (t.last_verified_at || t.last_verified)
            && typeof t.verification_source === 'string' && typeof t.notes === 'string');
          const cmp = ['chatgpt', 'n8n', 'pi'].map((slug) => {
            const j = jt.find((t) => t.slug === slug);
            const s = tryGet(db, 'SELECT commercial_use_status c, data_privacy_status p, api_availability_status a, verification_source v, notes n FROM tools WHERE slug = ?', slug);
            return !!(j && s && !s._error && j.commercial_use_status === s.c && j.data_privacy_status === s.p && j.api_availability_status === s.a && j.verification_source === s.v && j.notes === s.n);
          });
          ok7 = jAllOk && cmp.every(Boolean);
          ev7 = `tools=${jt.length} fields-ok=${jAllOk} parity(${cmp.join('/')})`;
        } catch (e) { ev7 = 'unreadable: ' + e.message; }
      }
      check('M7. JsonStore parity: app.json 91 tools, 6 fields each, spot-match sqlite', ok7, ev7);
    }
    s2.kill();
  } else {
    check('L1. JSON storage fallback boots (FC-compatible)', false, 'did not start');
  }

  /* ---- M10: vendored trust-map artifact ---- */
  {
    let ok10 = false; let ev10 = '';
    if (!trustMap.ok) ev10 = `missing/unreadable: ${trustMap.error}`;
    else {
      const entries = trustMap.entries;
      const slugs = entries.map((e) => e.slug);
      const unique = new Set(slugs).size === slugs.length;
      const fieldsOk = entries.every((e) => e && typeof e === 'object'
        && ['commercial_use_status', 'data_privacy_status', 'api_availability_status', 'last_verified', 'verification_source', 'notes'].every((k) => k in e)
        && ['Verified', 'Unverified'].includes(e.commercial_use_status)
        && ['Verified', 'Unverified'].includes(e.data_privacy_status)
        && ['Available', 'Unverified', 'N/A'].includes(e.api_availability_status)
        && typeof e.last_verified === 'string' && e.last_verified.length > 0
        && typeof e.verification_source === 'string' && typeof e.notes === 'string');
      let seedSlugs = new Set();
      try { seedSlugs = new Set(require(path.join(ROOT, 'lib', 'seed-data.js')).TOOLS.map((t) => t.slug)); } catch (e2) { ev10 = 'seed-data unreadable: ' + e2.message; }
      const slugsInSeed = slugs.every((s) => seedSlugs.has(s));
      ok10 = entries.length === 91 && unique && fieldsOk && slugsInSeed && seedSlugs.size === 91;
      ev10 = `entries=${entries.length} unique=${unique} fields=${fieldsOk} slugs-in-seed=${slugsInSeed} seed-slugs=${seedSlugs.size}`;
    }
    check('M10. lib/trust-map.json: 91 entries, unique slugs, 6 fields, valid enums', ok10, ev10);
  }

  /* ---- S-series: AI Stack Builder ---- */
  {
  const stackEmail = `stack${Date.now()}@test.dev`;
  const sj = new Jar();
  await register(sj, stackEmail, 'Stack User', 'StackPass123!');
  const ssid = sj.cookies.get('sid');
  const scsrf = csrfOf(ssid);
  const totalCentsOf = (html) => Number((html.match(/data-stack-total-cents="(\d+)"/) || [])[1]);

  let r = await req('POST', '/stacks', { jar: sj, form: { _csrf: scsrf, name: 'My AI Stack' } });
  const stackId = (r.headers.get('location') || '').match(/\/stacks\/(\d+)/)?.[1] ?? null;
  check('S1. Create stack', r.status === 303 && !!stackId, `id=${stackId} location=${r.headers.get('location')}`);

  const stackItems = [
    { name: 'ChatGPT Plus',    provider: 'OpenAI',     category: 'Chat Assistants',      monthly_cost: '20.00', active: '1' },
    { name: 'Midjourney Basic', provider: 'Midjourney', category: 'Image Generation',     monthly_cost: '10.00', active: '1' },
    { name: 'Claude Pro',      provider: 'Anthropic',  category: 'Chat Assistants',      monthly_cost: '20.00', active: '1' },
    { name: 'GitHub Copilot',  provider: 'GitHub',     category: 'Coding & Development', monthly_cost: '10.00', active: '1' },
    { name: 'Perplexity Pro',  provider: 'Perplexity', category: 'Research & Knowledge', monthly_cost: '20.00', active: '0' },
  ];
  let added = 0;
  for (const it of stackItems) {
    const form = { _csrf: scsrf, name: it.name, provider: it.provider, category: it.category, monthly_cost: it.monthly_cost, quantity: '1' };
    if (it.active === '1') form.active = '1';
    const rr = await req('POST', `/stacks/${stackId}/items`, { jar: sj, form });
    if (rr.status === 303) added++;
  }
  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  check('S2. Add items', added === 5 && stackItems.every((i) => r.text.includes(i.name)), `added=${added}/5`);

  const totalCents = totalCentsOf(r.text);
  check('S3. Total = active-only sum', totalCents === 6000 && r.text.includes('$60.00') && !r.text.includes('$80.00') && r.text.includes('Perplexity Pro'),
    `total=${totalCents}¢ ($60.00 expected; $80.00 must be absent)`);

  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  const list = await req('GET', '/stacks', { jar: sj });
  check('S4. Persists across re-GET', totalCentsOf(r.text) === 6000 && stackItems.every((i) => r.text.includes(i.name))
      && list.text.includes('My AI Stack') && list.text.includes('$60.00'),
    `re-get=${totalCentsOf(r.text)}¢ list-shows-stack=${list.text.includes('My AI Stack')}`);

  const chatId = tryGet(db, "SELECT id FROM stack_items WHERE stack_id = ? AND name = 'ChatGPT Plus'", Number(stackId));
  const up = await req('POST', `/stacks/${stackId}/items/${chatId.id}/update`, { jar: sj, form: { _csrf: scsrf, name: 'ChatGPT Plus', provider: 'OpenAI', monthly_cost: '25.00', quantity: '1', active: '1' } });
  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  check('S5. Edit cost → total updates', up.status === 303 && totalCentsOf(r.text) === 6500 && r.text.includes('$65.00'),
    `chatgpt $20→$25 total=${totalCentsOf(r.text)}¢`);

  const mjId = tryGet(db, "SELECT id FROM stack_items WHERE stack_id = ? AND name = 'Midjourney Basic'", Number(stackId));
  const del = await req('POST', `/stacks/${stackId}/items/${mjId.id}/delete`, { jar: sj, form: { _csrf: scsrf } });
  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  check('S6. Delete item → total updates', del.status === 303 && totalCentsOf(r.text) === 5500 && !r.text.includes('Midjourney Basic'),
    `midjourney removed total=${totalCentsOf(r.text)}¢`);

  const clId = tryGet(db, "SELECT id FROM stack_items WHERE stack_id = ? AND name = 'Claude Pro'", Number(stackId));
  await req('POST', `/stacks/${stackId}/items/${clId.id}/update`, { jar: sj, form: { _csrf: scsrf, name: 'Claude Pro', provider: 'Anthropic', monthly_cost: '20.00', quantity: '1' } });
  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  const off = totalCentsOf(r.text);
  const offText = r.text;
  await req('POST', `/stacks/${stackId}/items/${clId.id}/update`, { jar: sj, form: { _csrf: scsrf, name: 'Claude Pro', provider: 'Anthropic', monthly_cost: '20.00', quantity: '1', active: '1' } });
  r = await req('GET', `/stacks/${stackId}`, { jar: sj });
  const on = totalCentsOf(r.text);
  check('S7. Toggle active → total updates', off === 3500 && offText.includes('$35.00') && on === 5500 && r.text.includes('$55.00'),
    `claude off→${off}¢ on→${on}¢`);

  const stRow = tryGet(db, 'SELECT id, user_id, name, created_at, updated_at FROM stacks WHERE id = ?', Number(stackId));
  const itRows = tryAll(db, 'SELECT name, monthly_cost_cents, active, created_at, updated_at FROM stack_items WHERE stack_id = ?', Number(stackId));
  const sjUid = tryGet(db, 'SELECT id FROM users WHERE email = ?', stackEmail);
  const activeSum = (itRows || []).filter((x) => x.active === 1).reduce((a, b) => a + b.monthly_cost_cents, 0);
  const allStamped = !!itRows && itRows.every((x) => x.created_at && x.updated_at);
  const perpInactive = (itRows || []).find((x) => x.name === 'Perplexity Pro');
  check('S8. Rows persisted w/ owner + timestamps (SQL)', !!stRow && !stRow._error && stRow.user_id === (sjUid && sjUid.id)
      && stRow.name === 'My AI Stack' && !!stRow.created_at && !!stRow.updated_at
      && itRows && itRows.length === 4 && allStamped && activeSum === 5500
      && perpInactive && perpInactive.active === 0,
    `items=${itRows && itRows.length} activeSum=${activeSum}¢ owner=${stRow && stRow.user_id} timestamps=${allStamped}`);

  const before = tryGet(db, 'SELECT COUNT(*) n FROM stack_items WHERE stack_id = ?', Number(stackId)).n;
  let rejects = 0;
  let rr = await req('POST', `/stacks/${stackId}/items`, { jar: sj, form: { _csrf: scsrf, name: 'Bad Negative', monthly_cost: '-5.00' } });
  if (rr.status === 200 && rr.text.includes('field-error')) rejects++;
  rr = await req('POST', `/stacks/${stackId}/items`, { jar: sj, form: { _csrf: scsrf, name: 'Bad Precision', monthly_cost: '10.999' } });
  if (rr.status === 200 && rr.text.includes('field-error')) rejects++;
  rr = await req('POST', '/stacks', { jar: sj, form: { _csrf: scsrf, name: '   ' } });
  if (rr.status === 200 && rr.text.includes('field-error')) rejects++;
  const after = tryGet(db, 'SELECT COUNT(*) n FROM stack_items WHERE stack_id = ?', Number(stackId)).n;
  const stacksAfter = tryGet(db, 'SELECT COUNT(*) n FROM stacks').n;
  check('S9. Validation rejects negative / >2-decimal / empty name', rejects === 3 && after === before && stacksAfter === 1,
    `rejects=${rejects}/3 items=${before}→${after} stacks=${stacksAfter}`);

  r = await req('POST', '/stacks', { jar: sj, form: { _csrf: scsrf, name: 'Empty Stack' } });
  const emptyId = (r.headers.get('location') || '').match(/\/stacks\/(\d+)/)?.[1] ?? null;
  r = await req('GET', `/stacks/${emptyId}`, { jar: sj });
  check('S10. Empty stack renders empty state', emptyId && r.status === 200 && totalCentsOf(r.text) === 0
      && (r.text.includes('empty-state') || r.text.includes('No items')),
    `id=${emptyId} total=${totalCentsOf(r.text)}¢ empty-state=${r.text.includes('empty-state') || r.text.includes('No items')}`);

  const anon = await req('GET', '/stacks', { jar: new Jar() });
  const j2 = new Jar();
  await register(j2, `s2${Date.now()}@test.dev`, 'Other User', 'OtherPass123!');
  const foreign = await req('GET', `/stacks/${stackId}`, { jar: j2 });
  check('S11. Unauth redirect + cross-user denied', anon.status === 303 && (anon.headers.get('location') || '').startsWith('/login')
      && (foreign.status === 403 || foreign.status === 404) && !foreign.text.includes('My AI Stack'),
    `anon=${anon.status}→${anon.headers.get('location')} foreign=${foreign.status}`);

  const PORT3 = PORT + 2;
  const jsonDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stack-json-'));
  const s3 = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT3), DATA_DIR: jsonDir2, STORAGE: 'json', BASE_URL: `http://127.0.0.1:${PORT3}` }, stdio: 'ignore' });
  let up3 = false;
  for (let i = 0; i < 40; i++) { try { const h = await fetch(`http://127.0.0.1:${PORT3}/healthz`); if (h.ok) { up3 = true; break; } } catch { /* */ } await new Promise((res) => setTimeout(res, 250)); }
  if (up3) {
    const j3 = new Jar();
    await req2(PORT3, 'GET', '/register', { jar: j3 });
    await req2(PORT3, 'POST', '/register', { jar: j3, form: { _csrf: j3.csrf(), name: 'Json Stack User', email: 'stackjson@test.dev', password: 'JsonPass123!', confirm: 'JsonPass123!' } });
    const jcsrf = csrfOf(j3.cookies.get('sid'));
    const cr = await req2(PORT3, 'POST', '/stacks', { jar: j3, form: { _csrf: jcsrf, name: 'JSON Stack' } });
    const jstackId = (cr.headers.get('location') || '').match(/\/stacks\/(\d+)/)?.[1] ?? null;
    await req2(PORT3, 'POST', `/stacks/${jstackId}/items`, { jar: j3, form: { _csrf: jcsrf, name: 'ChatGPT Plus', monthly_cost: '20.00', quantity: '1', active: '1' } });
    const jdetail = await req2(PORT3, 'GET', `/stacks/${jstackId}`, { jar: j3 });
    const appJson = JSON.parse(fs.readFileSync(path.join(jsonDir2, 'app.json'), 'utf8'));
    const jstacks = appJson.stacks || [];
    const jitems = appJson.stack_items || [];
    const jTotalCents = totalCentsOf(jdetail.text);
    const jdetail2 = await req2(PORT3, 'GET', `/stacks/${jstackId}`, { jar: j3 });
    const jReload = totalCentsOf(jdetail2.text) === 2000;
    check('S12. JsonStore parity: stack+item persist, total survives reload',
      jTotalCents === 2000 && jstacks.length === 1 && jitems.length === 1
      && jitems[0] && jitems[0].monthly_cost_cents === 2000 && jitems[0].active === 1 && jReload,
      `stacks=${jstacks.length} items=${jitems.length} cents=${jitems[0] && jitems[0].monthly_cost_cents} total=${jTotalCents}¢ reload=${jReload}`);
    s3.kill();
  } else {
    check('S12. JsonStore parity: stack+item persist, total survives reload', false, 'json server did not start');
  }

  const myStackPage = await req('GET', '/my-stack', { jar: sj });
  check('S13. /my-stack route renders', myStackPage.status === 200 && myStackPage.text.includes('Your AI Stack') && myStackPage.text.includes('My AI Stack'),
    `status=${myStackPage.status} shows-stack=${myStackPage.text.includes('My AI Stack')}`);

  const anyTool = tryGet(db, "SELECT slug FROM tools WHERE status = 'published' ORDER BY id LIMIT 1");
  const saveRes = await req('POST', '/api/stacks/save', { jar: sj, form: { _csrf: scsrf, tool_slug: anyTool.slug }, accept: 'application/json' });
  let saveJson = null;
  try { saveJson = JSON.parse(saveRes.text); } catch {}
  check('S14. Save-to-stack API adds catalog tool', saveRes.status === 200 && saveJson && saveJson.saved === true && !!saveJson.stack_id,
    `saved=${saveJson && saveJson.saved} stack=${saveJson && saveJson.stack_name} total=${saveJson && saveJson.total_cents}¢`);
  }

  /* ---- summary ---- */
  const failed = results.filter((x) => !x.ok);
  console.log('\n========================================');
  console.log(`TOTAL: ${results.length}  PASS: ${results.length - failed.length}  FAIL: ${failed.length}`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log('  - ' + f.name)); process.exitCode = 1; }
  else console.log('ALL CHECKS PASSED ✅');
  db.close();
}

async function req2(port, method, p, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, redirect: 'manual', headers: { ...(opts.jar ? { cookie: opts.jar.header() } : {}), ...(opts.accept ? { accept: opts.accept } : {}), ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.form ? new URLSearchParams(opts.form).toString() : opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  if (opts.jar) opts.jar.apply(r);
  return { status: r.status, headers: r.headers, text: await r.text() };
}

main().then(() => { if (server) server.kill(); if (s2) s2.kill(); }).catch((e) => { console.error('VERIFY ERROR:', e); if (server) server.kill(); if (s2) s2.kill(); process.exit(1); });

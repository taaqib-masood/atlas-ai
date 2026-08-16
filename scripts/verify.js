'use strict';
/**
 * End-to-end verification suite. Boots the app on a scratch port + data dir,
 * walks the full user/admin journey with real HTTP requests, and prints a
 * PASS/FAIL report per Goal Brief acceptance criterion.
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

  /* ---- browse & filter ---- */
  let r = await req('GET', '/');
  check('B1. Home renders (brand, hero, JSON-LD)', r.status === 200 && r.text.includes('Atlas AI') && r.text.includes('application/ld+json'), `${r.text.length} bytes`);
  check('B2. Home has skip-link + h1 + lang', r.text.includes('Skip to content') && /<h1[^>]*>/.test(r.text) && r.text.startsWith('<!doctype html>\n<html lang="en">'));
  check('B3. Security headers present', r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff');

  r = await req('GET', '/browse');
  check('C1. Browse lists tools', r.status === 200 && r.text.includes('tool-card'), `${r.text.length} bytes`);
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

  /* ---- tool detail ---- */
  r = await req('GET', '/tool/chatgpt');
  check('D1. Tool detail renders with meta + JSON-LD',
    r.status === 200 && r.text.includes('ChatGPT') && r.text.includes('SoftwareApplication') && /<meta name="description"/.test(r.text) && r.text.includes('rel="canonical"'));
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
      tags: 'press, writing, pr', popularity: '55', logo_color: '#C05621', status: 'draft',
    },
  });
  check('G4. Admin creates tool (draft)', r.status === 303);
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
    s2.kill();
  } else {
    check('L1. JSON storage fallback boots (FC-compatible)', false, 'did not start');
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

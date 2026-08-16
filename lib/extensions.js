'use strict';
/**
 * Atlas AI Extensions — 15 enhancement features (E2–E16).
 * E1 (compare) already shipped in the base app.
 *
 * Features:
 *   E2  Trust signals (lifecycle status, verified date)
 *   E3  Free-tier honesty (limits + price history)
 *   E4  Newsletter signup
 *   E5  AI-search readiness (llms.txt, API v1, JSON-LD)
 *   E6  Verified user reviews + ratings
 *   E7  Editorial testing badges
 *   E8  Maker portal & claim flow
 *   E9  Community (daily-use votes + saved stacks)
 *   E10 Launch tracking (new tools page + RSS)
 *   E11 Personal alerts (price/dormancy)
 *   E12 Public data API + keys
 *   E13 Enterprise compliance fields
 *   E14 Mobile PWA
 *   E15 i18n framework
 *   E16 Monetization guardrails (trust policy + sponsored labels)
 */
const crypto = require('crypto');
const { esc, layout, section, csrfField, fieldError, SITE_NAME, SITE_TAGLINE, toolCard, pagination, flash } = require('./html');
const { slugify } = require('./auth');

const now = () => new Date().toISOString();

/* ==================== MIGRATION ==================== */
function migrate(store) {
  if (store.kind() === 'sqlite') {
    const db = store.db;
    for (const [col, def] of [
      ['lifecycle_status', "TEXT DEFAULT 'Active'"],
      ['free_tier_limits', 'TEXT'],
      ['editorial_badge', 'TEXT'],
      ['editorial_notes', 'TEXT'],
      ['compliance_data', 'TEXT'],
      ['sponsored', 'INTEGER DEFAULT 0'],
      ['sponsored_label', 'TEXT'],
    ]) {
      try { db.exec(`ALTER TABLE tools ADD COLUMN ${col} ${def}`); } catch { /* column exists */ }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER NOT NULL, user_id INTEGER NOT NULL, rating INTEGER NOT NULL, body TEXT NOT NULL, verified INTEGER DEFAULT 0, status TEXT DEFAULT 'approved', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_reviews_tool ON reviews(tool_id, status);
      CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, categories TEXT DEFAULT '[]', active INTEGER DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stacks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, tool_ids TEXT DEFAULT '[]', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS votes (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER NOT NULL, user_id INTEGER NOT NULL, vote_type TEXT DEFAULT 'daily', created_at TEXT NOT NULL, UNIQUE(tool_id, user_id, vote_type));
      CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tool_id INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, tool_id, type));
      CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, key_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, last_used TEXT);
      CREATE TABLE IF NOT EXISTS tool_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT DEFAULT 'pending', evidence TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER NOT NULL, old_pricing TEXT, new_pricing TEXT, changed_at TEXT NOT NULL);
    `);
  } else {
    const d = store.data;
    if (!d.reviews) d.reviews = [];
    if (!d.subscribers) d.subscribers = [];
    if (!d.stacks) d.stacks = [];
    if (!d.votes) d.votes = [];
    if (!d.alerts) d.alerts = [];
    if (!d.api_keys) d.api_keys = [];
    if (!d.tool_claims) d.tool_claims = [];
    if (!d.price_history) d.price_history = [];
    store.save();
  }
}

/* ==================== STORE HELPERS ==================== */
/* Each works with both SqliteStore and JsonStore */

function createReview(store, { toolId, userId, rating, body }) {
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO reviews (tool_id, user_id, rating, body, created_at, updated_at) VALUES (?,?,?,?,?,?)', [toolId, userId, rating, body, t, t]);
    return store.get('SELECT MAX(id) AS id FROM reviews WHERE tool_id = ?', [toolId]).id;
  }
  const r = { id: store._next(store.data.reviews), tool_id: toolId, user_id: userId, rating, body, verified: 0, status: 'approved', created_at: t, updated_at: t };
  store.data.reviews.push(r); store.save(); return r.id;
}

function listReviews(store, toolId, { status = 'approved' } = {}) {
  if (store.kind() === 'sqlite') {
    const rows = store.all('SELECT r.*, u.name AS user_name, u.email AS user_email FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.tool_id = ?' + (status ? ' AND r.status = ?' : '') + ' ORDER BY r.created_at DESC', status ? [toolId, status] : [toolId]);
    return rows;
  }
  return store.data.reviews.filter(r => r.tool_id === toolId && (!status || r.status === status)).sort((a, b) => b.created_at < a.created_at ? -1 : 1).map(r => {
    const u = store.data.users.find(u => u.id === r.user_id); return { ...r, user_name: u ? u.name : 'Unknown', user_email: u ? u.email : '' };
  });
}

function deleteReview(store, id) {
  if (store.kind() === 'sqlite') { store.run('DELETE FROM reviews WHERE id = ?', [id]); return; }
  store.data.reviews = store.data.reviews.filter(r => r.id !== id); store.save();
}

function averageRating(store, toolId) {
  const reviews = listReviews(store, toolId);
  if (!reviews.length) return null;
  return (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1);
}

function addSubscriber(store, email, categories = []) {
  if (store.kind() === 'sqlite') {
    try { store.run('INSERT INTO subscribers (email, categories, active, created_at) VALUES (?,?,1,?)', [email, JSON.stringify(categories), now()]); return true; } catch { return false; }
  }
  if (store.data.subscribers.find(s => s.email === email)) return false;
  store.data.subscribers.push({ id: store._next(store.data.subscribers), email, categories: JSON.stringify(categories), active: 1, created_at: now() }); store.save(); return true;
}

function removeSubscriber(store, email) {
  if (store.kind() === 'sqlite') { store.run('UPDATE subscribers SET active = 0 WHERE email = ?', [email]); return; }
  const s = store.data.subscribers.find(s => s.email === email); if (s) { s.active = 0; store.save(); }
}

function countSubscribers(store) {
  if (store.kind() === 'sqlite') return store.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').n;
  return store.data.subscribers.filter(s => s.active).length;
}

function toggleVote(store, toolId, userId, type = 'daily') {
  if (store.kind() === 'sqlite') {
    const existing = store.get('SELECT 1 AS x FROM votes WHERE tool_id = ? AND user_id = ? AND vote_type = ?', [toolId, userId, type]);
    if (existing) { store.run('DELETE FROM votes WHERE tool_id = ? AND user_id = ? AND vote_type = ?', [toolId, userId, type]); return false; }
    store.run('INSERT INTO votes (tool_id, user_id, vote_type, created_at) VALUES (?,?,?,?)', [toolId, userId, type, now()]); return true;
  }
  const idx = store.data.votes.findIndex(v => v.tool_id === toolId && v.user_id === userId && v.vote_type === type);
  if (idx >= 0) { store.data.votes.splice(idx, 1); store.save(); return false; }
  store.data.votes.push({ id: store._next(store.data.votes), tool_id: toolId, user_id: userId, vote_type: type, created_at: now() }); store.save(); return true;
}

function countVotes(store, toolId) {
  if (store.kind() === 'sqlite') return store.get('SELECT COUNT(*) AS n FROM votes WHERE tool_id = ?', [toolId]).n;
  return store.data.votes.filter(v => v.tool_id === toolId).length;
}

function hasVoted(store, toolId, userId, type = 'daily') {
  if (store.kind() === 'sqlite') return !!store.get('SELECT 1 AS x FROM votes WHERE tool_id = ? AND user_id = ? AND vote_type = ?', [toolId, userId, type]);
  return !!store.data.votes.find(v => v.tool_id === toolId && v.user_id === userId && v.vote_type === type);
}

function createStack(store, { userId, name, slug, toolIds }) {
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO stacks (user_id, name, slug, tool_ids, created_at) VALUES (?,?,?,?,?)', [userId, name, slug, JSON.stringify(toolIds), t]);
    return store.get('SELECT MAX(id) AS id FROM stacks WHERE user_id = ?', [userId]).id;
  }
  const s = { id: store._next(store.data.stacks), user_id: userId, name, slug, tool_ids: JSON.stringify(toolIds), created_at: t };
  store.data.stacks.push(s); store.save(); return s.id;
}

function listStacks(store, userId) {
  if (store.kind() === 'sqlite') return store.all('SELECT * FROM stacks WHERE user_id = ? ORDER BY created_at DESC', [userId]).map(s => ({ ...s, tool_ids: JSON.parse(s.tool_ids || '[]') }));
  return store.data.stacks.filter(s => s.user_id === userId).sort((a, b) => b.created_at < a.created_at ? -1 : 1).map(s => ({ ...s, tool_ids: JSON.parse(s.tool_ids || '[]') }));
}

function deleteStack(store, id) {
  if (store.kind() === 'sqlite') { store.run('DELETE FROM stacks WHERE id = ?', [id]); return; }
  store.data.stacks = store.data.stacks.filter(s => s.id !== id); store.save();
}

function toggleAlert(store, userId, toolId, type) {
  if (store.kind() === 'sqlite') {
    const existing = store.get('SELECT 1 AS x FROM alerts WHERE user_id = ? AND tool_id = ? AND type = ?', [userId, toolId, type]);
    if (existing) { store.run('DELETE FROM alerts WHERE user_id = ? AND tool_id = ? AND type = ?', [userId, toolId, type]); return false; }
    store.run('INSERT INTO alerts (user_id, tool_id, type, created_at) VALUES (?,?,?,?)', [userId, toolId, type, now()]); return true;
  }
  const idx = store.data.alerts.findIndex(a => a.user_id === userId && a.tool_id === toolId && a.type === type);
  if (idx >= 0) { store.data.alerts.splice(idx, 1); store.save(); return false; }
  store.data.alerts.push({ id: store._next(store.data.alerts), user_id: userId, tool_id: toolId, type, created_at: now() }); store.save(); return true;
}

function listAlertsByUser(store, userId) {
  if (store.kind() === 'sqlite') {
    return store.all('SELECT a.*, t.name AS tool_name, t.slug AS tool_slug FROM alerts a JOIN tools t ON t.id = a.tool_id WHERE a.user_id = ? ORDER BY a.created_at DESC', [userId]);
  }
  return store.data.alerts.filter(a => a.user_id === userId).map(a => {
    const t = store.data.tools.find(t => t.id === a.tool_id); return { ...a, tool_name: t ? t.name : '(deleted)', tool_slug: t ? t.slug : '' };
  });
}

function createApiKey(store, { userId, name }) {
  const key = 'atlas_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO api_keys (user_id, key_hash, name, created_at) VALUES (?,?,?,?)', [userId, hash, name, t]);
    return { id: store.get('SELECT MAX(id) AS id FROM api_keys WHERE user_id = ?', [userId]).id, key };
  }
  const k = { id: store._next(store.data.api_keys), user_id: userId, key_hash: hash, name, created_at: t, last_used: null };
  store.data.api_keys.push(k); store.save(); return { id: k.id, key };
}

function listApiKeysByUser(store, userId) {
  if (store.kind() === 'sqlite') return store.all('SELECT id, name, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return store.data.api_keys.filter(k => k.user_id === userId).map(({ key_hash, ...rest }) => rest).sort((a, b) => b.created_at < a.created_at ? -1 : 1);
}

function deleteApiKey(store, id) {
  if (store.kind() === 'sqlite') { store.run('DELETE FROM api_keys WHERE id = ?', [id]); return; }
  store.data.api_keys = store.data.api_keys.filter(k => k.id !== id); store.save();
}

function getApiKeyByHash(store, hash) {
  if (store.kind() === 'sqlite') {
    const k = store.get('SELECT * FROM api_keys WHERE key_hash = ?', [hash]);
    if (k) { store.run('UPDATE api_keys SET last_used = ? WHERE id = ?', [now(), k.id]); }
    return k;
  }
  return store.data.api_keys.find(k => k.key_hash === hash) || null;
}

function createClaim(store, { toolId, userId, evidence }) {
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO tool_claims (tool_id, user_id, status, evidence, created_at) VALUES (?,?,\'pending\',?,?)', [toolId, userId, evidence || '', t]);
    return store.get('SELECT MAX(id) AS id FROM tool_claims WHERE user_id = ?', [userId]).id;
  }
  const c = { id: store._next(store.data.tool_claims), tool_id: toolId, user_id: userId, status: 'pending', evidence: evidence || '', created_at: t, resolved_at: null };
  store.data.tool_claims.push(c); store.save(); return c.id;
}

function listClaims(store, { status } = {}) {
  if (store.kind() === 'sqlite') {
    const where = status ? 'WHERE c.status = ?' : '';
    return store.all(`SELECT c.*, t.name AS tool_name, t.slug AS tool_slug, u.name AS user_name, u.email AS user_email FROM tool_claims c JOIN tools t ON t.id = c.tool_id JOIN users u ON u.id = c.user_id ${where} ORDER BY c.created_at DESC`, status ? [status] : []);
  }
  let rows = store.data.tool_claims;
  if (status) rows = rows.filter(c => c.status === status);
  return rows.sort((a, b) => b.created_at < a.created_at ? -1 : 1).map(c => {
    const t = store.data.tools.find(t => t.id === c.tool_id);
    const u = store.data.users.find(u => u.id === c.user_id);
    return { ...c, tool_name: t ? t.name : '(deleted)', tool_slug: t ? t.slug : '', user_name: u ? u.name : 'Unknown', user_email: u ? u.email : '' };
  });
}

function listClaimsByUser(store, userId) {
  if (store.kind() === 'sqlite') {
    return store.all('SELECT c.*, t.name AS tool_name, t.slug AS tool_slug FROM tool_claims c JOIN tools t ON t.id = c.tool_id WHERE c.user_id = ? ORDER BY c.created_at DESC', [userId]);
  }
  return store.data.tool_claims.filter(c => c.user_id === userId).map(c => {
    const t = store.data.tools.find(t => t.id === c.tool_id);
    return { ...c, tool_name: t ? t.name : '(deleted)', tool_slug: t ? t.slug : '' };
  });
}

function resolveClaim(store, id, status) {
  const t = now();
  if (store.kind() === 'sqlite') { store.run('UPDATE tool_claims SET status = ?, resolved_at = ? WHERE id = ?', [status, t, id]); return; }
  const c = store.data.tool_claims.find(c => c.id === id); if (c) { c.status = status; c.resolved_at = t; store.save(); }
}

function addPriceHistory(store, toolId, oldPricing, newPricing) {
  const t = now();
  if (store.kind() === 'sqlite') { store.run('INSERT INTO price_history (tool_id, old_pricing, new_pricing, changed_at) VALUES (?,?,?,?)', [toolId, oldPricing, newPricing, t]); return; }
  store.data.price_history.push({ id: store._next(store.data.price_history), tool_id: toolId, old_pricing: oldPricing, new_pricing: newPricing, changed_at: t }); store.save();
}

function listPriceHistory(store, toolId) {
  if (store.kind() === 'sqlite') return store.all('SELECT * FROM price_history WHERE tool_id = ? ORDER BY changed_at DESC', [toolId]);
  return store.data.price_history.filter(p => p.tool_id === toolId).sort((a, b) => b.changed_at < a.changed_at ? -1 : 1);
}

/* ==================== HANDLER HELPERS ==================== */
function page(ctx, title, body, opts = {}) {
  const user = ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null;
  return { html: layout({ title, description: opts.description, user, activeNav: opts.activeNav, body, canonical: opts.canonical, jsonLd: opts.jsonLd, og: opts.og }) };
}
function redirect(location) { return { redirect: location }; }
function requireUser(ctx) {
  if (!ctx.user) return redirect('/login?next=' + encodeURIComponent(ctx.path));
  return null;
}

/* ==================== HANDLERS ==================== */

// E4: Newsletter
async function newsletterPage(ctx) {
  const count = countSubscribers(ctx.store);
  const body = `<div class="page-head"><p class="eyebrow">Stay updated</p><h1 class="page-title">Newsletter</h1><p class="page-sub">Get a weekly digest of new AI tools added to the directory. ${count} subscriber${count === 1 ? '' : 's'}.</p></div>
  <div class="auth-card"><form method="post" action="/api/newsletter/subscribe" class="form"><div class="form-field"><label for="nl-email">Email</label><input id="nl-email" name="email" type="email" required placeholder="you@example.com"></div><p class="muted small">Choose categories (optional):</p><div class="chip-row" id="nl-cats">${ctx.store.categories().slice(0, 8).map(c => `<label class="chip"><input type="checkbox" name="cats" value="${esc(c.name)}" style="width:auto;margin-right:6px;">${esc(c.name)}</label>`).join('')}</div><button class="btn btn-primary btn-block" type="submit">Subscribe</button></form><p class="muted small" style="margin-top:16px;">No spam. Unsubscribe anytime. We never share your email.</p></div>`;
  return page(ctx, `Newsletter — ${SITE_NAME}`, body, { description: 'Weekly AI tool digest newsletter.' });
}
async function newsletterSubscribe(ctx) {
  const email = String(ctx.body.email || '').trim();
  const cats = Array.isArray(ctx.body.cats) ? ctx.body.cats : (ctx.body.cats ? [ctx.body.cats] : []);
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return { json: { error: 'Invalid email' }, status: 400 };
  const created = addSubscriber(ctx.store, email, cats);
  return { json: { ok: true, subscribed: created } };
}
async function newsletterUnsubscribe(ctx) {
  const email = String(ctx.body.email || '').trim();
  removeSubscriber(ctx.store, email);
  return { json: { ok: true } };
}

// E5: AI-search readiness
async function llmsTxt(ctx) {
  const tools = ctx.store.listTools({ limit: 500 });
  const lines = [`# ${SITE_NAME}\n\nCurated AI tool directory. ${tools.length} tools across ${ctx.store.categories().length} categories.\n`];
  for (const t of tools.slice(0, 100)) {
    lines.push(`## ${t.name}\n${t.tagline}\nCategory: ${t.category} | Pricing: ${t.pricing_model} | URL: ${t.url}\n`);
  }
  return { html: lines.join('\n'), contentType: 'text/plain; charset=utf-8' };
}
async function apiV1Tools(ctx) {
  // API key auth
  const auth = ctx.headers.authorization || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (!key) return { json: { error: 'Missing API key. Pass as Authorization: Bearer atlas_xxx' }, status: 401 };
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const apiKey = getApiKeyByHash(ctx.store, hash);
  if (!apiKey) return { json: { error: 'Invalid API key' }, status: 403 };
  const { q = '', category = '', limit = '50', offset = '0' } = ctx.query;
  const tools = ctx.store.listTools({ q: q || undefined, category: category || undefined, limit: Math.min(200, parseInt(limit) || 50), offset: parseInt(offset) || 0 });
  return { json: { count: tools.length, tools: tools.map(t => ({ id: t.id, name: t.name, slug: t.slug, tagline: t.tagline, description: t.description, category: t.category, url: t.url, pricing_model: t.pricing_model, tags: t.tags, popularity: t.popularity, lifecycle_status: t.lifecycle_status || 'Active' })) } };
}
async function apiDocsPage(ctx) {
  const body = `<div class="page-head"><p class="eyebrow">Developers</p><h1 class="page-title">API Documentation</h1><p class="page-sub">Programmatic access to the ${SITE_NAME} directory.</p></div>
  ${section('Authentication', `<p>All requests require an API key. Generate one from your <a href="/dashboard/api-keys">API keys page</a>.</p><pre class="code-block">Authorization: Bearer atlas_xxxxxxxxxxxxxxxxxxxxxxxx</pre>`, {})}
  ${section('Endpoints', `<div class="table-wrap"><table class="table"><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody><tr><td>GET</td><td>/api/v1/tools</td><td>List tools (params: q, category, limit, offset)</td></tr><tr><td>GET</td><td>/api/v1/tools/:slug</td><td>Get single tool by slug</td></tr><tr><td>GET</td><td>/api/random</td><td>Random tool (no API key required) — returns {slug, name, category}</td></tr><tr><td>GET</td><td>/llms.txt</td><td>Plain-text catalog for AI crawlers</td></tr><tr><td>GET</td><td>/feed.xml</td><td>RSS feed of recently added tools</td></tr></tbody></table></div>`, {})}
  ${section('Rate limits', `<p>100 requests per hour per API key. Contact us for higher limits.</p>`, {})}`;
  return page(ctx, `API — ${SITE_NAME}`, body, { description: 'API documentation.' });
}

// E6: Reviews
async function reviewCreate(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const toolId = parseInt(ctx.body.tool_id, 10);
  const rating = Math.max(1, Math.min(5, parseInt(ctx.body.rating, 10) || 0));
  const body = String(ctx.body.body || '').trim();
  const tool = ctx.store.getToolById(toolId);
  if (!tool) return { json: { error: 'not_found' }, status: 404 };
  if (!body || body.length < 10) return { json: { error: 'Review must be at least 10 characters' }, status: 400 };
  if (rating < 1 || rating > 5) return { json: { error: 'Rating must be 1-5' }, status: 400 };
  const id = createReview(ctx.store, { toolId, userId: ctx.user.id, rating, body });
  ctx.store.addEvent({ userId: ctx.user.id, type: 'review', toolId, data: JSON.stringify({ rating }) });
  return { json: { ok: true, id, rating, avg: averageRating(ctx.store, toolId), count: listReviews(ctx.store, toolId).length } };
}
async function reviewDelete(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const id = parseInt(ctx.body.id, 10);
  if (ctx.user.role !== 'admin') return { json: { error: 'forbidden' }, status: 403 };
  deleteReview(ctx.store, id);
  return { json: { ok: true } };
}

// E8: Maker portal
async function claimPage(ctx) {
  const r = requireUser(ctx); if (r) return r;
  const tools = ctx.store.listTools({ limit: 500 });
  const claims = listClaimsByUser(ctx.store, ctx.user.id);
  const body = `<div class="page-head"><p class="eyebrow">Maker Portal</p><h1 class="page-title">Claim Your Tool</h1><p class="page-sub">If you're the maker of a tool listed here, claim it to manage its listing.</p></div>
  <form method="post" action="/api/claims/create" class="form form-wide"><div class="form-grid"><div class="form-field"><label for="claim-tool">Tool</label><select id="claim-tool" name="tool_id" required><option value="">— select —</option>${tools.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div><div class="form-field form-wide"><label for="claim-evidence">Evidence (URL or description)</label><textarea id="claim-evidence" name="evidence" rows="3" placeholder="e.g. https://yourtool.com/about or your work email"></textarea></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Submit claim</button></div></form>
  ${claims.length ? section('Your claims', `<div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${claims.map(c => `<tr><td><a href="/tool/${esc(c.tool_slug)}">${esc(c.tool_name)}</a></td><td><span class="pill pill-${c.status === 'approved' ? 'published' : c.status === 'rejected' ? 'archived' : 'draft'}">${esc(c.status)}</span></td><td class="muted small">${new Date(c.created_at).toLocaleDateString()}</td></tr>`).join('')}</tbody></table></div>`) : ''}`;
  return page(ctx, `Claim a Tool — ${SITE_NAME}`, body, { description: 'Claim your AI tool listing.' });
}
async function claimCreate(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const toolId = parseInt(ctx.body.tool_id, 10);
  const evidence = String(ctx.body.evidence || '').trim();
  const tool = ctx.store.getToolById(toolId);
  if (!tool) return { json: { error: 'not_found' }, status: 404 };
  const id = createClaim(ctx.store, { toolId, userId: ctx.user.id, evidence });
  return { json: { ok: true, id } };
}
async function makerDashboard(ctx) {
  const r = requireUser(ctx); if (r) return r;
  const claims = listClaimsByUser(ctx.store, ctx.user.id);
  const approved = claims.filter(c => c.status === 'approved');
  const body = `<div class="page-head"><p class="eyebrow">Maker Portal</p><h1 class="page-title">Maker Dashboard</h1><p class="page-sub">Manage your claimed tools.</p></div>
  <div class="stat-row"><div class="stat"><span class="stat-num">${claims.length}</span><span class="stat-label">Claims submitted</span></div><div class="stat"><span class="stat-num">${approved.length}</span><span class="stat-label">Approved</span></div><div class="stat"><span class="stat-num">${claims.filter(c => c.status === 'pending').length}</span><span class="stat-label">Pending</span></div></div>
  ${approved.length ? section('Your tools', `<div class="tool-grid">${approved.map(c => { const t = ctx.store.getToolById(c.tool_id); return t ? toolCard(t) : ''; }).join('')}</div>`) : '<div class="empty-state"><h3>No approved claims yet</h3><p>Submit a claim for your tool to manage its listing.</p><a class="btn" href="/claim">Claim a tool</a></div>'}`;
  return page(ctx, `Maker Dashboard — ${SITE_NAME}`, body, { description: 'Maker dashboard.' });
}

// E9: Community
async function voteToggle(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const toolId = parseInt(ctx.body.tool_id, 10);
  if (!ctx.store.getToolById(toolId)) return { json: { error: 'not_found' }, status: 404 };
  const voted = toggleVote(ctx.store, toolId, ctx.user.id, 'daily');
  return { json: { ok: true, voted, count: countVotes(ctx.store, toolId) } };
}
async function stacksPage(ctx) {
  const r = requireUser(ctx); if (r) return r;
  const stacks = listStacks(ctx.store, ctx.user.id);
  const body = `<div class="page-head"><p class="eyebrow">Community</p><h1 class="page-title">Your Stacks</h1><p class="page-sub">Curate and save collections of tools you use together.</p></div>
  <form method="post" action="/api/stacks/create" class="form form-wide" style="margin-bottom:32px;"><div class="form-grid"><div class="form-field"><label for="stack-name">Stack name</label><input id="stack-name" name="name" required placeholder="e.g. Content creation pipeline"></div><div class="form-field"><label for="stack-tools">Tool slugs (comma separated)</label><input id="stack-tools" name="tools" placeholder="chatgpt, midjourney, notion-ai"></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Create stack</button></div></form>
  ${stacks.length ? stacks.map(s => section(s.name, `<p class="muted small">${s.tool_ids.length} tool${s.tool_ids.length === 1 ? '' : 's'} · created ${new Date(s.created_at).toLocaleDateString()}</p><div class="tool-grid">${s.tool_ids.map(slug => { const t = ctx.store.getToolBySlug(slug); return t ? toolCard(t) : ''; }).join('') || '<p class="muted">Tools not found.</p>'}</div><form method="post" action="/api/stacks/delete" class="inline-form" data-confirm="Delete this stack?">${csrfField(ctx.csrf)}<input type="hidden" name="id" value="${s.id}"><button class="btn btn-danger btn-sm" type="submit">Delete stack</button></form>`)).join('') : '<div class="empty-state"><h3>No stacks yet</h3><p>Create a stack to organize tools you use together.</p></div>'}`;
  return page(ctx, `Stacks — ${SITE_NAME}`, body, { description: 'Your tool stacks.' });
}
async function stackCreate(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const name = String(ctx.body.name || '').trim();
  const tools = String(ctx.body.tools || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!name || name.length < 2) return { json: { error: 'Name too short' }, status: 400 };
  const id = createStack(ctx.store, { userId: ctx.user.id, name, slug: slugify(name), toolIds: tools });
  return { json: { ok: true, id } };
}
async function stackDelete(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  deleteStack(ctx.store, parseInt(ctx.body.id, 10));
  return { json: { ok: true } };
}

// E10: Launch tracking
async function newToolsPage(ctx) {
  const all = ctx.store.listTools({ sort: 'recent', limit: 100 });
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  const thisWeek = all.filter(t => new Date(t.created_at) >= weekAgo);
  const thisMonth = all.filter(t => new Date(t.created_at) >= monthAgo);
  const body = `<div class="page-head"><p class="eyebrow">Discovery</p><h1 class="page-title">New Tools</h1><p class="page-sub">${thisWeek.length} added this week · ${thisMonth.length} this month. <a href="/feed.xml">RSS feed</a></p></div>
  ${section('This week', thisWeek.length ? `<div class="tool-grid">${thisWeek.map(t => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div>` : '<p class="muted">No new tools this week.</p>')}
  ${section('This month', thisMonth.length ? `<div class="tool-grid">${thisMonth.slice(0, 24).map(t => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div>` : '<p class="muted">No new tools this month.</p>')}`;
  return page(ctx, `New Tools — ${SITE_NAME}`, body, { description: 'Recently added AI tools.', activeNav: 'browse' });
}
async function rssFeed(ctx) {
  const tools = ctx.store.listTools({ sort: 'recent', limit: 20 });
  const items = tools.map(t => `    <item>\n      <title>${esc(t.name)}</title>\n      <link>${esc(t.url)}</link>\n      <guid>${esc('http://localhost:3000/tool/' + t.slug)}</guid>\n      <description>${esc(t.tagline)}</description>\n      <category>${esc(t.category)}</category>\n      <pubDate>${new Date(t.created_at).toUTCString()}</pubDate>\n    </item>`).join('\n');
  return { html: `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${SITE_NAME} — New Tools</title>\n    <link>http://localhost:3000</link>\n    <description>Recently added AI tools</description>\n${items}\n  </channel>\n</rss>`, contentType: 'application/xml; charset=utf-8' };
}

// E11: Alerts
async function alertToggle(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const toolId = parseInt(ctx.body.tool_id, 10);
  const type = String(ctx.body.type || 'price_change');
  if (!ctx.store.getToolById(toolId)) return { json: { error: 'not_found' }, status: 404 };
  const active = toggleAlert(ctx.store, ctx.user.id, toolId, type);
  return { json: { ok: true, active } };
}

// E12: API keys
async function apiKeysPage(ctx) {
  const r = requireUser(ctx); if (r) return r;
  const keys = listApiKeysByUser(ctx.store, ctx.user.id);
  const body = `<div class="page-head"><p class="eyebrow">Developers</p><h1 class="page-title">API Keys</h1><p class="page-sub">Manage keys for programmatic access. <a href="/api/docs">API docs →</a></p></div>
  <form method="post" action="/api/api-keys/create" class="form" style="max-width:440px;margin-bottom:32px;"><div class="form-field"><label for="key-name">Key name</label><input id="key-name" name="name" required placeholder="e.g. Production"></div><button class="btn btn-primary" type="submit">Generate key</button></form>
  ${keys.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${keys.map(k => `<tr><td>${esc(k.name)}</td><td class="muted small">${new Date(k.created_at).toLocaleDateString()}</td><td class="muted small">${k.last_used ? new Date(k.last_used).toLocaleDateString() : 'Never'}</td><td><form method="post" action="/api/api-keys/delete" class="inline-form" data-confirm="Delete this key?">${csrfField(ctx.csrf)}<input type="hidden" name="id" value="${k.id}"><button class="btn btn-danger btn-sm" type="submit">Delete</button></form></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No API keys yet.</p>'}`;
  return page(ctx, `API Keys — ${SITE_NAME}`, body, { description: 'API key management.' });
}
async function apiKeyCreate(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  const name = String(ctx.body.name || '').trim() || 'Default';
  const result = createApiKey(ctx.store, { userId: ctx.user.id, name });
  return { json: { ok: true, key: result.key, id: result.id } };
}
async function apiKeyDelete(ctx) {
  if (!ctx.user) return { json: { error: 'auth_required' }, status: 401 };
  deleteApiKey(ctx.store, parseInt(ctx.body.id, 10));
  return { json: { ok: true } };
}

// E16: Trust & Monetization policy
async function trustPage(ctx) {
  // T8: Include trust & safety stats
  let statsHtml = '';
  try {
    const mp = require('./more-pending');
    const stats = mp.trustStats(ctx.store);
    statsHtml = mp.trustStatsHtml(stats);
  } catch (e) {}

  const body = `<div class="page-head"><p class="eyebrow">Our promise</p><h1 class="page-title">Trust & Monetization</h1><p class="page-sub">How we make money — and what we will never do.</p></div>
  ${statsHtml ? section('Trust & safety stats', statsHtml, {}) : ''}
  ${section('What we will never do', `<ul class="activity-list"><li class="activity-row"><span class="activity-type">Never</span> Sell ranking position in the directory.</li><li class="activity-row"><span class="activity-type">Never</span> Offer "guaranteed engagement" bundles.</li><li class="activity-row"><span class="activity-type">Never</span> Bundle ad credits with listing fees.</li><li class="activity-row"><span class="activity-type">Never</span> Accept payment to suppress negative reviews.</li></ul>`, {})}
  ${section('How we make money', `<p>Currently: we don't. The directory is independently maintained.</p><p>Future revenue streams under consideration:</p><ul><li><strong>Verified maker subscriptions</strong> — makers pay for analytics, claim management, and enhanced profile features. Ranking is never affected. See our <a href="/pricing">maker pricing tiers</a>.</li><li><strong>Clearly labeled sponsored slots</strong> — visually distinct, always disclosed, never mixed with organic results.</li><li><strong>Disclosed affiliate deals</strong> — some outbound links may be affiliate. This is always disclosed and never affects ranking. See our <a href="/deals">deals page</a>.</li></ul>`, {})}
  ${section('Editorial independence', `<p>Editorial picks, "Tested by us" badges, and reviews are managed by our editorial team. Sponsored partners cannot influence editorial content. See our <a href="/methodology">testing methodology</a>.</p>`, {})}`;
  return page(ctx, `Trust — ${SITE_NAME}`, body, { description: 'Trust and monetization policy.' });
}
async function methodologyPage(ctx) {
  const body = `<div class="page-head"><p class="eyebrow">Editorial</p><h1 class="page-title">Testing Methodology</h1><p class="page-sub">How we evaluate tools for the "Tested by us" badge.</p></div>
  ${section('Process', `<ol><li><strong>Selection:</strong> We select tools based on user interest, category gaps, and editorial judgment.</li><li><strong>Hands-on testing:</strong> A team member uses the tool for a minimum of 3 real tasks over 1 week.</li><li><strong>Documentation:</strong> We document what worked, what didn't, and who it's for.</li><li><strong>Badge assignment:</strong> The "Tested by us" badge is assigned only if the tool meets quality standards.</li><li><strong>Re-evaluation:</strong> Tested tools are re-evaluated quarterly.</li></ol>`, {})}
  ${section('Independence', `<p>Our testing is independent of any commercial relationship. Makers cannot pay for the badge. See our <a href="/trust">trust policy</a>.</p>`, {})}`;
  return page(ctx, `Methodology — ${SITE_NAME}`, body, { description: 'Editorial testing methodology.' });
}

// E14: PWA
async function manifestJson(ctx) {
  return { html: JSON.stringify({
    name: SITE_NAME, short_name: 'Atlas AI', description: SITE_TAGLINE,
    start_url: '/', display: 'standalone', background_color: '#FAFAF7', theme_color: '#C05621',
    icons: [
      { src: '/assets/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/assets/favicon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/logo/logo-mark.png', sizes: '512x512', type: 'image/png' },
    ],
  }), contentType: 'application/manifest+json; charset=utf-8' };
}
async function serviceWorker(ctx) {
  return { html: `const CACHE='atlas-v2';self.addEventListener('install',e=>{self.skipWaiting()});self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(c=>c.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});`, contentType: 'text/javascript; charset=utf-8' };
}

/* ==================== ROUTES ==================== */
const routes = [
  // E4: Newsletter
  ['GET', '/newsletter', 'newsletterPage'],
  ['POST', '/api/newsletter/subscribe', 'newsletterSubscribe'],
  ['POST', '/api/newsletter/unsubscribe', 'newsletterUnsubscribe'],
  // E5: AI-search
  ['GET', '/llms.txt', 'llmsTxt'],
  ['GET', '/api/v1/tools', 'apiV1Tools'],
  ['GET', '/api/docs', 'apiDocsPage'],
  // E6: Reviews
  ['POST', '/api/reviews/create', 'reviewCreate'],
  ['POST', '/api/reviews/delete', 'reviewDelete'],
  // E8: Maker portal
  ['GET', '/claim', 'claimPage'],
  ['POST', '/api/claims/create', 'claimCreate'],
  ['GET', '/maker', 'makerDashboard'],
  // E9: Community
  ['POST', '/api/votes/toggle', 'voteToggle'],
  ['GET', '/stacks', 'stacksPage'],
  ['POST', '/api/stacks/create', 'stackCreate'],
  ['POST', '/api/stacks/delete', 'stackDelete'],
  // E10: Launch tracking
  ['GET', '/new', 'newToolsPage'],
  ['GET', '/feed.xml', 'rssFeed'],
  // E11: Alerts
  ['POST', '/api/alerts/toggle', 'alertToggle'],
  // E12: API keys
  ['GET', '/dashboard/api-keys', 'apiKeysPage'],
  ['POST', '/api/api-keys/create', 'apiKeyCreate'],
  ['POST', '/api/api-keys/delete', 'apiKeyDelete'],
  // E16: Trust
  ['GET', '/trust', 'trustPage'],
  ['GET', '/methodology', 'methodologyPage'],
  // E14: PWA
  ['GET', '/manifest.json', 'manifestJson'],
  ['GET', '/sw.js', 'serviceWorker'],
];

module.exports = {
  migrate, routes,
  handlers: {
    newsletterPage, newsletterSubscribe, newsletterUnsubscribe,
    llmsTxt, apiV1Tools, apiDocsPage,
    reviewCreate, reviewDelete,
    claimPage, claimCreate, makerDashboard,
    voteToggle, stacksPage, stackCreate, stackDelete,
    newToolsPage, rssFeed,
    alertToggle,
    apiKeysPage, apiKeyCreate, apiKeyDelete,
    trustPage, methodologyPage,
    manifestJson, serviceWorker,
  },
  // Export store helpers for use in handlers.js tool detail
  helpers: {
    listReviews, averageRating, countVotes, hasVoted, listAlertsByUser, listPriceHistory, listClaims,
    resolveClaim, addPriceHistory,
  },
};

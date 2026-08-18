'use strict';
/**
 * Storage layer — unified DAO interface with two adapters:
 *   - "sqlite": node:sqlite (built-in, Node >= 22.5). Primary backend.
 *   - "json":   atomic JSON-file store. Fallback for runtimes without
 *               node:sqlite (e.g. Aliyun FC nodejs20). Same DAO surface.
 * Select with STORAGE=sqlite|json|auto (default auto).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const now = () => new Date().toISOString();
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/* ------------------------------------------------------------------ */
/* Trust metadata (Core MVP)                                           */
/*                                                                     */
/* Single source of truth for the trust/compliance fields, shared by   */
/* both adapters. The audited mapping lives at lib/trust-map.json      */
/* (byte-copy of .cluster/atlas-trust-metadata/tool-trust-map.json).   */
/*                                                                     */
/* Enum is enforced at the app layer only (SQLite ALTER ADD COLUMN     */
/* cannot express CHECK constraints):                                  */
/*   commercial_use_status ∈ {Verified, Unverified}                    */
/*   data_privacy_status   ∈ {Verified, Unverified}                    */
/*   api_availability_status ∈ {Available, Unverified, N/A}            */
/* The mapping token 'N/A' is tolerated as-is (never mangled).         */
/* Mapping key `last_verified` maps to column `last_verified_at` on    */
/* write; parsed tool objects expose a `last_verified` alias on read.  */
/* ------------------------------------------------------------------ */

let TRUST_MAP = [];
try { TRUST_MAP = require('./trust-map.json'); } catch { /* boot must not crash when the map is absent */ }
const TRUST_MAP_BY_SLUG = new Map((Array.isArray(TRUST_MAP) ? TRUST_MAP : []).map((e) => [e.slug, e]));

const TRUST_DEFAULTS = {
  commercial_use_status: 'Unverified',
  data_privacy_status: 'Unverified',
  api_availability_status: 'Unverified',
  verification_source: '',
  notes: '',
  last_verified_at: '',
};
const TRUST_STATUS_FIELDS = ['commercial_use_status', 'data_privacy_status', 'api_availability_status'];
const TRUST_TEXT_FIELDS = ['verification_source', 'notes'];
const TRUST_ALLOWED = {
  commercial_use_status: new Set(['Verified', 'Unverified']),
  data_privacy_status: new Set(['Verified', 'Unverified']),
  api_availability_status: new Set(['Available', 'Unverified', 'N/A']),
};

/** App-layer enum guard: invalid/missing status collapses to 'Unverified'. */
function sanitizeTrustStatus(field, value) {
  const v = value === null || value === undefined ? '' : String(value).trim();
  if (TRUST_ALLOWED[field] && TRUST_ALLOWED[field].has(v)) return v;
  return 'Unverified';
}

/**
 * Merge the mapping entry (if any) for a slug onto the defaults.
 * Returns the 5 trust fields + last_verified_at (mapping key `last_verified`
 * → column `last_verified_at`). Missing slugs get pure defaults.
 */
function trustFor(slug) {
  const e = TRUST_MAP_BY_SLUG.get(slug) || {};
  return {
    commercial_use_status: sanitizeTrustStatus('commercial_use_status', e.commercial_use_status),
    data_privacy_status: sanitizeTrustStatus('data_privacy_status', e.data_privacy_status),
    api_availability_status: sanitizeTrustStatus('api_availability_status', e.api_availability_status),
    verification_source: String(e.verification_source || ''),
    notes: String(e.notes || ''),
    last_verified_at: String(e.last_verified || ''),
  };
}

/**
 * Idempotent, every-boot backfill. Merges lib/trust-map.json by slug into
 * existing rows: UPDATE only, never touches rows not in the map, and never
 * overwrites a non-default value a user may have set (a field is applied
 * only while it still holds its DEFAULT or is empty — for the nullable
 * pre-existing last_verified_at column, the DEFAULT is NULL/empty).
 * Returns the number of rows updated (0 = already in sync).
 */
function backfillTrustMetadata(store) {
  if (!TRUST_MAP_BY_SLUG.size) return 0;
  const rows = store.listTools({ status: null, limit: 100000 });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const updates = [];
  for (const [slug] of TRUST_MAP_BY_SLUG) {
    const row = bySlug.get(slug);
    if (!row) continue; // never touch rows not in the map
    const merged = trustFor(slug);
    const changes = {};
    for (const k of TRUST_STATUS_FIELDS) {
      const cur = row[k];
      if ((cur == null || cur === '' || cur === 'Unverified') && merged[k] && merged[k] !== cur) changes[k] = merged[k];
    }
    for (const k of TRUST_TEXT_FIELDS) {
      const cur = row[k];
      if ((cur == null || cur === '') && merged[k]) changes[k] = merged[k];
    }
    if ((row.last_verified_at == null || row.last_verified_at === '' || row.verification_source == null || row.verification_source === '') && merged.last_verified_at) {
      changes.last_verified_at = merged.last_verified_at;
    }
    if (Object.keys(changes).length) updates.push([row.id, changes]);
  }
  if (!updates.length) return 0;
  const apply = () => { for (const [id, ch] of updates) store.updateTool(id, ch); };
  if (typeof store.tx === 'function') store.tx(apply); else apply();
  return updates.length;
}

/* ------------------------------------------------------------------ */
/* SQLite adapter                                                      */
/* ------------------------------------------------------------------ */
class SqliteStore {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        url TEXT NOT NULL,
        pricing_model TEXT NOT NULL DEFAULT 'Freemium',
        tags TEXT NOT NULL DEFAULT '[]',
        logo_color TEXT NOT NULL DEFAULT '#C05621',
        popularity INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tools_status_category ON tools(status, category);
      CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
    `);
    /* Trust metadata columns — append-only ALTER ADD COLUMN, idempotent.
       PRAGMA table_info guard + try/catch backstop (two processes may race
       the ALTER on a shared data dir; the loser's duplicate-column error is
       swallowed). NOT NULL DEFAULT is required by SQLite for ADD COLUMN and
       guarantees the no-nulls invariant on every read path. */
    const existing = new Set(this.db.prepare('PRAGMA table_info(tools)').all().map((c) => c.name));
    for (const [col, def] of [
      ['commercial_use_status', "TEXT NOT NULL DEFAULT 'Unverified'"],
      ['data_privacy_status', "TEXT NOT NULL DEFAULT 'Unverified'"],
      ['api_availability_status', "TEXT NOT NULL DEFAULT 'Unverified'"],
      ['verification_source', "TEXT NOT NULL DEFAULT ''"],
      ['notes', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (existing.has(col)) continue;
      try { this.db.exec(`ALTER TABLE tools ADD COLUMN ${col} ${def}`); }
      catch { /* column added by a concurrent process */ }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS favorites (
        user_id INTEGER NOT NULL,
        tool_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, tool_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT NOT NULL,
        tool_id INTEGER,
        data TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
      CREATE TABLE IF NOT EXISTS tool_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        actor_id INTEGER,
        action TEXT NOT NULL,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_tool ON tool_history(tool_id, created_at);
    `);
  }

  kind() { return 'sqlite'; }
  close() { this.db.close(); }

  run(sql, params = []) { return this.db.prepare(sql).run(...params); }
  get(sql, params = []) { return this.db.prepare(sql).get(...params) || null; }
  all(sql, params = []) { return this.db.prepare(sql).all(...params); }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /* users */
  createUser({ email, name, passwordHash, salt, role = 'user' }) {
    const t = now();
    const info = this.run('INSERT INTO users (email, name, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)',
      [email, name, passwordHash, salt, role, t]);
    return this.get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)]);
  }
  getUserByEmail(email) { return this.get('SELECT * FROM users WHERE lower(email) = lower(?)', [email]); }
  getUserById(id) { return this.get('SELECT * FROM users WHERE id = ?', [id]); }
  countUsers() { return this.get('SELECT COUNT(*) AS n FROM users').n; }

  /* sessions */
  createSession(userId, ttlMs) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const t = now();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', [hash, userId, t, expires]);
    return token;
  }
  getSession(tokenHash) { return this.get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]); }
  deleteSession(tokenHash) { this.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]); }
  cleanupSessions() { this.run('DELETE FROM sessions WHERE expires_at < ?', [now()]); }

  /* tools */
  listTools({ status = 'published', category, tag, pricing, q, sort = 'popular', limit = 1000, offset = 0 } = {}) {
    const where = []; const p = [];
    if (status) { where.push('status = ?'); p.push(status); }
    if (category) { where.push('category = ?'); p.push(category); }
    if (pricing) { where.push('pricing_model = ?'); p.push(pricing); }
    if (tag) { where.push('tags LIKE ?'); p.push(`%"${tag}"%`); }
    if (q) { where.push('(name LIKE ? OR tagline LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)');
      const like = `%${q}%`; p.push(like, like, like, like, like); }
    const order = sort === 'recent' ? 'created_at DESC' : sort === 'updated' ? 'updated_at DESC' : sort === 'name' ? 'name ASC' : 'popularity DESC, created_at DESC';
    p.push(limit, offset);
    const rows = this.all(`SELECT * FROM tools ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, p);
    return rows.map(parseTool);
  }
  countTools({ status, category, tag, pricing, q } = {}) {
    const where = []; const p = [];
    if (status) { where.push('status = ?'); p.push(status); }
    if (category) { where.push('category = ?'); p.push(category); }
    if (pricing) { where.push('pricing_model = ?'); p.push(pricing); }
    if (tag) { where.push('tags LIKE ?'); p.push(`%"${tag}"%`); }
    if (q) { where.push('(name LIKE ? OR tagline LIKE ? OR description LIKE ?)'); const like = `%${q}%`; p.push(like, like, like); }
    return this.get(`SELECT COUNT(*) AS n FROM tools WHERE ${where.length ? where.join(' AND ') : '1=1'}`, p).n;
  }
  getToolBySlug(slug) { const t = this.get('SELECT * FROM tools WHERE slug = ?', [slug]); return t ? parseTool(t) : null; }
  getToolById(id) { const t = this.get('SELECT * FROM tools WHERE id = ?', [id]); return t ? parseTool(t) : null; }
  createTool(data) {
    const t = now();
    const info = this.run(
      `INSERT INTO tools (slug, name, tagline, description, category, url, pricing_model, tags, logo_color, popularity, status, created_at, updated_at, last_verified_at, commercial_use_status, data_privacy_status, api_availability_status, verification_source, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.slug, data.name, data.tagline, data.description, data.category, data.url, data.pricing_model,
        JSON.stringify(data.tags || []), data.logo_color, data.popularity || 0, data.status || 'draft', t, t,
        data.last_verified_at || data.last_verified || t,
        sanitizeTrustStatus('commercial_use_status', data.commercial_use_status),
        sanitizeTrustStatus('data_privacy_status', data.data_privacy_status),
        sanitizeTrustStatus('api_availability_status', data.api_availability_status),
        data.verification_source || '',
        data.notes || '']);
    return Number(info.lastInsertRowid);
  }
  updateTool(id, fields) {
    const f = { ...fields };
    // mapping key `last_verified` → column `last_verified_at` on write
    if (f.last_verified !== undefined && f.last_verified_at === undefined) { f.last_verified_at = f.last_verified; delete f.last_verified; }
    for (const k of TRUST_STATUS_FIELDS) if (f[k] !== undefined) f[k] = sanitizeTrustStatus(k, f[k]);
    for (const k of TRUST_TEXT_FIELDS) if (f[k] !== undefined) f[k] = f[k] || '';
    const sets = []; const p = [];
    for (const [k, v] of Object.entries(f)) { sets.push(`${k} = ?`); p.push(v); }
    if (!sets.length) return;
    p.push(now(), id);
    this.run(`UPDATE tools SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, p);
  }
  setToolStatus(id, status) { this.run('UPDATE tools SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id]); }
  deleteTool(id) { this.run('DELETE FROM tools WHERE id = ?', [id]); }
  categories() {
    return this.all(`SELECT category, COUNT(*) AS n FROM tools WHERE status = 'published' GROUP BY category ORDER BY n DESC`)
      .map((r) => ({ name: r.category, count: r.n }));
  }
  tags() {
    const rows = this.all(`SELECT tags FROM tools WHERE status = 'published'`);
    const m = new Map();
    for (const r of rows) for (const t of JSON.parse(r.tags || '[]')) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  /* favorites */
  addFavorite(userId, toolId) { this.run('INSERT OR IGNORE INTO favorites (user_id, tool_id, created_at) VALUES (?,?,?)', [userId, toolId, now()]); }
  removeFavorite(userId, toolId) { this.run('DELETE FROM favorites WHERE user_id = ? AND tool_id = ?', [userId, toolId]); }
  isFavorite(userId, toolId) { return !!this.get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND tool_id = ?', [userId, toolId]); }
  listFavorites(userId) {
    return this.all(`SELECT t.* FROM favorites f JOIN tools t ON t.id = f.tool_id WHERE f.user_id = ? ORDER BY f.created_at DESC`, [userId]).map(parseTool);
  }
  countFavorites(userId) { return this.get('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', [userId]).n; }

  /* events */
  addEvent({ userId = null, type, toolId = null, data = null }) {
    this.run('INSERT INTO events (user_id, type, tool_id, data, created_at) VALUES (?,?,?,?,?)',
      [userId, type, toolId, data ? JSON.stringify(data) : null, now()]);
  }
  listEventsByUser(userId, limit = 20) {
    return this.all(`SELECT e.*, t.name AS tool_name, t.slug AS tool_slug FROM events e LEFT JOIN tools t ON t.id = e.tool_id
      WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT ?`, [userId, limit]);
  }
  recentViews(userId, limit = 6) {
    return this.all(`SELECT t.*, MAX(e.created_at) AS viewed_at FROM events e JOIN tools t ON t.id = e.tool_id
      WHERE e.user_id = ? AND e.type = 'view' GROUP BY t.id ORDER BY viewed_at DESC LIMIT ?`, [userId, limit]).map(parseTool);
  }

  /* history */
  addHistory({ toolId, actorId, action, field = null, oldValue = null, newValue = null }) {
    this.run('INSERT INTO tool_history (tool_id, actor_id, action, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?,?)',
      [toolId, actorId, action, field, oldValue, newValue, now()]);
  }
  listHistory(limit = 200, { toolId, actorId, action } = {}) {
    const where = []; const p = [];
    if (toolId) { where.push('h.tool_id = ?'); p.push(toolId); }
    if (actorId) { where.push('h.actor_id = ?'); p.push(actorId); }
    if (action) { where.push('h.action = ?'); p.push(action); }
    p.push(limit);
    return this.all(`SELECT h.*, t.name AS tool_name, u.email AS actor_email
      FROM tool_history h LEFT JOIN tools t ON t.id = h.tool_id LEFT JOIN users u ON u.id = h.actor_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY h.created_at DESC LIMIT ?`, p);
  }
  historyForTool(toolId, limit = 100) { return this.listHistory(limit, { toolId }); }
  stats() {
    return {
      users: this.countUsers(),
      tools: this.get('SELECT COUNT(*) AS n FROM tools').n,
      published: this.get(`SELECT COUNT(*) AS n FROM tools WHERE status='published'`).n,
      drafts: this.get(`SELECT COUNT(*) AS n FROM tools WHERE status='draft'`).n,
      archived: this.get(`SELECT COUNT(*) AS n FROM tools WHERE status='archived'`).n,
      favorites: this.get('SELECT COUNT(*) AS n FROM favorites').n,
      events: this.get('SELECT COUNT(*) AS n FROM events').n,
      history: this.get('SELECT COUNT(*) AS n FROM tool_history').n,
    };
  }
}

function parseTool(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    commercial_use_status: row.commercial_use_status || 'Unverified',
    data_privacy_status: row.data_privacy_status || 'Unverified',
    api_availability_status: row.api_availability_status || 'Unverified',
    verification_source: row.verification_source || '',
    notes: row.notes || '',
    last_verified: row.last_verified_at || '',
  };
}

/* ------------------------------------------------------------------ */
/* JSON-file adapter (fallback, same DAO)                              */
/* ------------------------------------------------------------------ */
class JsonStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = { users: [], sessions: [], tools: [], favorites: [], events: [], history: [] };
    if (fs.existsSync(file)) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* start fresh on corrupt file */ }
    }
    this._normalizeTrust();
    this.save();
  }
  kind() { return 'json'; }
  close() {}
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file); // atomic on same filesystem
  }
  /** JSON-store "migration": merge trust fields from lib/trust-map.json into
   *  every stored tool (only where the field still holds its default/empty
   *  value, never clobbering user-set values). Runs once per boot; the
   *  constructor saves afterwards. */
  _normalizeTrust() {
    let changed = false;
    for (const t of this.data.tools || []) {
      const merged = trustFor(t.slug);
      for (const k of TRUST_STATUS_FIELDS) {
        if ((t[k] == null || t[k] === '' || t[k] === 'Unverified') && merged[k] && merged[k] !== t[k]) { t[k] = merged[k]; changed = true; }
      }
      for (const k of TRUST_TEXT_FIELDS) {
        if ((t[k] == null || t[k] === '') && merged[k]) { t[k] = merged[k]; changed = true; }
      }
      if ((t.last_verified_at == null || t.last_verified_at === '' || t.verification_source == null || t.verification_source === '') && merged.last_verified_at) { t.last_verified_at = merged.last_verified_at; changed = true; }
    }
    return changed;
  }
  _next(arr) { return arr.length ? Math.max(...arr.map((x) => x.id)) + 1 : 1; }
  _toolRow(t) { return { ...t, tags: JSON.parse(t.tags || '[]'),
    commercial_use_status: t.commercial_use_status || 'Unverified',
    data_privacy_status: t.data_privacy_status || 'Unverified',
    api_availability_status: t.api_availability_status || 'Unverified',
    verification_source: t.verification_source || '',
    notes: t.notes || '',
    last_verified: t.last_verified_at || '' }; }

  createUser({ email, name, passwordHash, salt, role = 'user' }) {
    const u = { id: this._next(this.data.users), email, name, password_hash: passwordHash, salt, role, created_at: now() };
    this.data.users.push(u); this.save(); return u;
  }
  getUserByEmail(email) { return this.data.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null; }
  getUserById(id) { return this.data.users.find((u) => u.id === id) || null; }
  countUsers() { return this.data.users.length; }

  createSession(userId, ttlMs) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    this.data.sessions.push({ token_hash: hash, user_id: userId, created_at: now(), expires_at: new Date(Date.now() + ttlMs).toISOString() });
    this.save(); return token;
  }
  getSession(tokenHash) { return this.data.sessions.find((s) => s.token_hash === tokenHash) || null; }
  deleteSession(tokenHash) {
    this.data.sessions = this.data.sessions.filter((s) => s.token_hash !== tokenHash); this.save();
  }
  cleanupSessions() {
    const t = now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.expires_at >= t);
    if (this.data.sessions.length !== before) this.save();
  }

  listTools({ status = 'published', category, tag, pricing, q, sort = 'popular', limit = 1000, offset = 0 } = {}) {
    let rows = this.data.tools.map(this._toolRow).filter((t) => (status ? t.status === status : true));
    if (category) rows = rows.filter((t) => t.category === category);
    if (pricing) rows = rows.filter((t) => t.pricing_model === pricing);
    if (tag) rows = rows.filter((t) => t.tags.includes(tag));
    if (q) {
      const like = q.toLowerCase();
      rows = rows.filter((t) => [t.name, t.tagline, t.description, t.category, t.tags.join(' ')].join(' ').toLowerCase().includes(like));
    }
    rows.sort((a, b) => sort === 'recent' ? (b.created_at < a.created_at ? -1 : 1)
      : sort === 'updated' ? (b.updated_at < a.updated_at ? -1 : 1)
      : sort === 'name' ? a.name.localeCompare(b.name) : b.popularity - a.popularity || (b.created_at < a.created_at ? -1 : 1));
    return rows.slice(offset, offset + limit);
  }
  countTools({ status, category, tag, pricing, q } = {}) {
    return this.listTools({ status: status || undefined, category, tag, pricing, q, limit: 100000 }).length;
  }
  getToolBySlug(slug) { const t = this.data.tools.find((x) => x.slug === slug); return t ? this._toolRow(t) : null; }
  getToolById(id) { const t = this.data.tools.find((x) => x.id === id); return t ? this._toolRow(t) : null; }
  createTool(data) {
    const t = now();
    const tool = { id: this._next(this.data.tools), slug: data.slug, name: data.name, tagline: data.tagline, description: data.description,
      category: data.category, url: data.url, pricing_model: data.pricing_model, tags: JSON.stringify(data.tags || []),
      logo_color: data.logo_color, popularity: data.popularity || 0, status: data.status || 'draft',
      created_at: t, updated_at: t,
      last_verified_at: data.last_verified_at || data.last_verified || t,
      commercial_use_status: sanitizeTrustStatus('commercial_use_status', data.commercial_use_status),
      data_privacy_status: sanitizeTrustStatus('data_privacy_status', data.data_privacy_status),
      api_availability_status: sanitizeTrustStatus('api_availability_status', data.api_availability_status),
      verification_source: data.verification_source || '',
      notes: data.notes || '' };
    this.data.tools.push(tool); this.save(); return tool.id;
  }
  updateTool(id, fields) {
    const t = this.data.tools.find((x) => x.id === id);
    if (!t) return;
    const f = { ...fields };
    // mapping key `last_verified` → column `last_verified_at` on write
    if (f.last_verified !== undefined && f.last_verified_at === undefined) { f.last_verified_at = f.last_verified; delete f.last_verified; }
    for (const k of TRUST_STATUS_FIELDS) if (f[k] !== undefined) f[k] = sanitizeTrustStatus(k, f[k]);
    for (const k of TRUST_TEXT_FIELDS) if (f[k] !== undefined) f[k] = f[k] || '';
    for (const [k, v] of Object.entries(f)) if (v !== undefined) t[k] = v;
    t.updated_at = now(); this.save();
  }
  setToolStatus(id, status) { const t = this.data.tools.find((x) => x.id === id); if (!t) return; t.status = status; t.updated_at = now(); this.save(); }
  deleteTool(id) { this.data.tools = this.data.tools.filter((x) => x.id !== id); this.save(); }
  categories() {
    const m = new Map();
    for (const t of this.data.tools.filter((x) => x.status === 'published')) m.set(t.category, (m.get(t.category) || 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }
  tags() {
    const m = new Map();
    for (const t of this.data.tools.filter((x) => x.status === 'published')) for (const tag of this._toolRow(t).tags) m.set(tag, (m.get(tag) || 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  addFavorite(userId, toolId) {
    if (!this.data.favorites.find((f) => f.user_id === userId && f.tool_id === toolId)) {
      this.data.favorites.push({ user_id: userId, tool_id: toolId, created_at: now() }); this.save();
    }
  }
  removeFavorite(userId, toolId) {
    const before = this.data.favorites.length;
    this.data.favorites = this.data.favorites.filter((f) => !(f.user_id === userId && f.tool_id === toolId));
    if (this.data.favorites.length !== before) this.save();
  }
  isFavorite(userId, toolId) { return !!this.data.favorites.find((f) => f.user_id === userId && f.tool_id === toolId); }
  listFavorites(userId) {
    return this.data.favorites.filter((f) => f.user_id === userId)
      .sort((a, b) => (b.created_at < a.created_at ? -1 : 1))
      .map((f) => this.data.tools.find((t) => t.id === f.tool_id)).filter(Boolean).map(this._toolRow);
  }
  countFavorites(userId) { return this.data.favorites.filter((f) => f.user_id === userId).length; }

  addEvent({ userId = null, type, toolId = null, data = null }) {
    this.data.events.push({ id: this._next(this.data.events), user_id: userId, type, tool_id: toolId, data: data ? JSON.stringify(data) : null, created_at: now() });
    this.save();
  }
  listEventsByUser(userId, limit = 20) {
    return this.data.events.filter((e) => e.user_id === userId).sort((a, b) => (b.created_at < a.created_at ? -1 : 1)).slice(0, limit)
      .map((e) => { const t = this.data.tools.find((x) => x.id === e.tool_id); return { ...e, tool_name: t ? t.name : null, tool_slug: t ? t.slug : null }; });
  }
  recentViews(userId, limit = 6) {
    const seen = new Map();
    for (const e of this.data.events.filter((x) => x.user_id === userId && x.type === 'view').sort((a, b) => (b.created_at < a.created_at ? -1 : 1))) {
      if (!seen.has(e.tool_id)) seen.set(e.tool_id, this.data.tools.find((t) => t.id === e.tool_id));
    }
    return [...seen.values()].filter(Boolean).slice(0, limit).map(this._toolRow);
  }

  addHistory({ toolId, actorId, action, field = null, oldValue = null, newValue = null }) {
    this.data.history.push({ id: this._next(this.data.history), tool_id: toolId, actor_id: actorId, action, field, old_value: oldValue, new_value: newValue, created_at: now() });
    this.save();
  }
  listHistory(limit = 200, { toolId, actorId, action } = {}) {
    let rows = this.data.history;
    if (toolId) rows = rows.filter((h) => h.tool_id === toolId);
    if (actorId) rows = rows.filter((h) => h.actor_id === actorId);
    if (action) rows = rows.filter((h) => h.action === action);
    return rows.sort((a, b) => (b.created_at < a.created_at ? -1 : 1)).slice(0, limit)
      .map((h) => { const t = this.data.tools.find((x) => x.id === h.tool_id); const u = this.data.users.find((x) => x.id === h.actor_id);
        return { ...h, tool_name: t ? t.name : '(deleted)', actor_email: u ? u.email : null }; });
  }
  historyForTool(toolId, limit = 100) { return this.listHistory(limit, { toolId }); }
  stats() {
    return {
      users: this.data.users.length,
      tools: this.data.tools.length,
      published: this.data.tools.filter((t) => t.status === 'published').length,
      drafts: this.data.tools.filter((t) => t.status === 'draft').length,
      archived: this.data.tools.filter((t) => t.status === 'archived').length,
      favorites: this.data.favorites.length,
      events: this.data.events.length,
      history: this.data.history.length,
    };
  }
}

/* ------------------------------------------------------------------ */
function openStore(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const mode = opts.storage || process.env.STORAGE || 'auto';
  if (mode === 'json') return new JsonStore(path.join(dataDir, 'app.json'));
  if (mode === 'sqlite') return new SqliteStore(path.join(dataDir, 'app.db'));
  // auto: sqlite when available
  try { require('node:sqlite'); return new SqliteStore(path.join(dataDir, 'app.db')); }
  catch { return new JsonStore(path.join(dataDir, 'app.json')); }
}

module.exports = { openStore, SqliteStore, JsonStore, trustFor, backfillTrustMetadata, TRUST_DEFAULTS };

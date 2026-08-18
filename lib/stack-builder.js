'use strict';
/**
 * AI Stack Builder — persistent, user-owned stacks of AI tools with monthly
 * spend calculation. Supersedes the E9 "Community stacks" feature (same
 * `stacks` table, now extended) and adds a `stack_items` child table so each
 * line item can carry its own monthly cost + quantity + active flag.
 *
 * Security invariants (see .cluster/atlas-stack-builder/subagent_03_security.md):
 *   - Every stack/item read/write is scoped to ctx.user.id (IDOR-safe).
 *   - State-changing routes are form POST (CSRF-protected), never JSON POST.
 *   - Money is integer cents; floats never enter persistence.
 *   - All user strings are escaped with esc() on render.
 */
const { esc, layout, section, csrfField, fieldError, SITE_NAME } = require('./html');
const { slugify } = require('./auth');

const now = () => new Date().toISOString();
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };

/* ------------------------------------------------------------------ */
/* Validation & formatting (integer cents)                             */
/* ------------------------------------------------------------------ */

function parseCents(input) {
  if (input === null || input === undefined || input === '') return { ok: false, reason: 'missing' };
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, reason: 'invalid' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, reason: 'invalid' };
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'overflow' };
  return { ok: true, cents };
}

function parseQuantity(input) {
  if (input === null || input === undefined || input === '') return { ok: false, reason: 'missing' };
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return { ok: false, reason: 'invalid' };
  return { ok: true, value: n };
}

/* checkbox semantics: present/1/true/on → active(1); absent → inactive(0) */
function parseActive(input) {
  if (input === undefined || input === null || input === '') return 0;
  if (input === true || input === 1 || input === '1' || input === 'true' || input === 'on') return 1;
  return 0;
}

function formatCents(cents, currency = 'USD') {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const sym = CURRENCY_SYMBOLS[currency] || (currency ? currency + ' ' : '');
  return `${sign}${sym}${whole}.${frac}`;
}

/* ------------------------------------------------------------------ */
/* Migration (idempotent, sqlite + json parity)                        */
/* ------------------------------------------------------------------ */

function migrate(store) {
  if (store.kind() === 'sqlite') {
    const db = store.db;
    // Self-sufficient parent schema (matches the legacy E9 table + new cols).
    db.exec(`
      CREATE TABLE IF NOT EXISTS stacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL DEFAULT '',
        tool_ids TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_stacks_user ON stacks(user_id, created_at);
      CREATE TABLE IF NOT EXISTS stack_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        tool_id INTEGER,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        monthly_cost_cents INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stack_items_stack ON stack_items(stack_id);
    `);
    // Extend a pre-existing legacy E9 `stacks` table (6 cols) idempotently.
    const cols = new Set(db.prepare('PRAGMA table_info(stacks)').all().map((c) => c.name));
    for (const [col, def] of [
      ['description', "TEXT NOT NULL DEFAULT ''"],
      ['currency', "TEXT NOT NULL DEFAULT 'USD'"],
      ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (cols.has(col)) continue;
      try { db.exec(`ALTER TABLE stacks ADD COLUMN ${col} ${def}`); } catch { /* concurrent ALTER */ }
    }
  } else {
    if (!store.data.stacks) store.data.stacks = [];
    if (!store.data.stack_items) store.data.stack_items = [];
    store.save();
  }
}

/* ------------------------------------------------------------------ */
/* Store-agnostic CRUD (ownership-scoped)                              */
/* ------------------------------------------------------------------ */

function createStack(store, { userId, name, description = '', currency = 'USD' }) {
  const t = now();
  const slug = slugify(name);
  if (store.kind() === 'sqlite') {
    const res = store.run(
      'INSERT INTO stacks (user_id, name, slug, description, currency, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [userId, name, slug, description, currency, t, t]
    );
    return Number(res.lastInsertRowid);
  }
  const s = { id: store._next(store.data.stacks), user_id: userId, name, slug, tool_ids: '[]', description, currency, created_at: t, updated_at: t };
  store.data.stacks.push(s);
  store.save();
  return s.id;
}

function listStacks(store, userId) {
  if (store.kind() === 'sqlite') return store.all('SELECT * FROM stacks WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return store.data.stacks.filter((s) => s.user_id === userId).sort((a, b) => (b.created_at < a.created_at ? -1 : 1));
}

function getStack(store, id, userId) {
  if (store.kind() === 'sqlite') return store.get('SELECT * FROM stacks WHERE id = ? AND user_id = ?', [id, userId]);
  return store.data.stacks.find((s) => s.id === id && s.user_id === userId) || null;
}

function renameStack(store, id, userId, name) {
  const t = now();
  const slug = slugify(name);
  if (store.kind() === 'sqlite') {
    store.run('UPDATE stacks SET name = ?, slug = ?, updated_at = ? WHERE id = ? AND user_id = ?', [name, slug, t, id, userId]);
    return;
  }
  const s = store.data.stacks.find((x) => x.id === id && x.user_id === userId);
  if (!s) return;
  s.name = name; s.slug = slug; s.updated_at = t;
  store.save();
}

function deleteStack(store, id, userId) {
  if (store.kind() === 'sqlite') {
    store.run('DELETE FROM stacks WHERE id = ? AND user_id = ?', [id, userId]);
    return;
  }
  store.data.stacks = store.data.stacks.filter((s) => !(s.id === id && s.user_id === userId));
  store.data.stack_items = store.data.stack_items.filter((i) => i.stack_id !== id);
  store.save();
}

function ownsStack(store, stackId, userId) {
  return !!getStack(store, stackId, userId);
}

function addStackItem(store, { stackId, userId, name, provider = '', category = '', monthlyCostCents = 0, quantity = 1, active = 1, notes = '' }) {
  if (!ownsStack(store, stackId, userId)) return null;
  const t = now();
  if (store.kind() === 'sqlite') {
    const res = store.run(
      'INSERT INTO stack_items (stack_id, name, provider, category, monthly_cost_cents, quantity, active, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [stackId, name, provider, category, monthlyCostCents, quantity, active, notes, t, t]
    );
    return Number(res.lastInsertRowid);
  }
  const item = { id: store._next(store.data.stack_items), stack_id: stackId, tool_id: null, name, provider, category, monthly_cost_cents: monthlyCostCents, quantity, active, notes, created_at: t, updated_at: t };
  store.data.stack_items.push(item);
  store.save();
  return item.id;
}

function listStackItems(store, stackId, userId) {
  if (!ownsStack(store, stackId, userId)) return [];
  if (store.kind() === 'sqlite') return store.all('SELECT * FROM stack_items WHERE stack_id = ? ORDER BY id ASC', [stackId]);
  return store.data.stack_items.filter((i) => i.stack_id === stackId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function getStackItem(store, stackId, itemId, userId) {
  if (!ownsStack(store, stackId, userId)) return null;
  if (store.kind() === 'sqlite') return store.get('SELECT * FROM stack_items WHERE id = ? AND stack_id = ?', [itemId, stackId]);
  return store.data.stack_items.find((i) => i.id === itemId && i.stack_id === stackId) || null;
}

function updateStackItem(store, stackId, itemId, userId, fields) {
  if (!ownsStack(store, stackId, userId)) return false;
  const t = now();
  const f = {
    name: fields.name,
    provider: fields.provider ?? '',
    category: fields.category ?? '',
    monthly_cost_cents: fields.monthlyCostCents ?? 0,
    quantity: fields.quantity ?? 1,
    active: fields.active ?? 1,
    notes: fields.notes ?? '',
  };
  if (store.kind() === 'sqlite') {
    store.run(
      'UPDATE stack_items SET name = ?, provider = ?, category = ?, monthly_cost_cents = ?, quantity = ?, active = ?, notes = ?, updated_at = ? WHERE id = ? AND stack_id = ?',
      [f.name, f.provider, f.category, f.monthly_cost_cents, f.quantity, f.active, f.notes, t, itemId, stackId]
    );
    return true;
  }
  const item = store.data.stack_items.find((i) => i.id === itemId && i.stack_id === stackId);
  if (!item) return false;
  Object.assign(item, { name: f.name, provider: f.provider, category: f.category, monthly_cost_cents: f.monthly_cost_cents, quantity: f.quantity, active: f.active, notes: f.notes, updated_at: t });
  store.save();
  return true;
}

function deleteStackItem(store, stackId, itemId, userId) {
  if (!ownsStack(store, stackId, userId)) return;
  if (store.kind() === 'sqlite') {
    store.run('DELETE FROM stack_items WHERE id = ? AND stack_id = ?', [itemId, stackId]);
    return;
  }
  store.data.stack_items = store.data.stack_items.filter((i) => !(i.id === itemId && i.stack_id === stackId));
  store.save();
}

function stackTotal(store, stackId, userId) {
  if (!ownsStack(store, stackId, userId)) return 0;
  if (store.kind() === 'sqlite') {
    const row = store.get('SELECT COALESCE(SUM(monthly_cost_cents * quantity), 0) AS t FROM stack_items WHERE stack_id = ? AND active = 1', [stackId]);
    return Number(row ? row.t : 0);
  }
  return store.data.stack_items.filter((i) => i.stack_id === stackId && i.active === 1).reduce((s, i) => s + i.monthly_cost_cents * i.quantity, 0);
}

/* ------------------------------------------------------------------ */
/* Auth guard (JSON-aware, mirrors handlers.apiFavoriteToggle)         */
/* ------------------------------------------------------------------ */

function requireUserApi(ctx) {
  if (ctx.user) return null;
  if (String(ctx.headers.accept || '').includes('application/json') || String(ctx.headers['content-type'] || '').includes('application/json')) {
    return { json: { error: 'auth_required' }, status: 401 };
  }
  return { redirect: '/login?next=' + encodeURIComponent(ctx.path) };
}

/* ------------------------------------------------------------------ */
/* Render helpers                                                      */
/* ------------------------------------------------------------------ */

function pageFor(ctx, title, body, description) {
  return { html: layout({ title, description, user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, activeNav: 'stacks', body }) };
}

function catalogDatalist(store) {
  try {
    const tools = store.listTools({ limit: 1000 });
    return `<datalist id="catalog-tools">${tools.map((t) => `<option value="${esc(t.name)}"></option>`).join('')}</datalist>`;
  } catch { return ''; }
}

function itemFormHtml(ctx, stackId, { values = {}, errors = {} } = {}) {
  const v = (k) => esc(values[k] ?? '');
  const active = values.active === undefined ? true : !!values.active;
  return `<form method="post" action="/stacks/${stackId}/items" class="form form-wide">
    ${csrfField(ctx.csrf)}
    <div class="form-grid">
      <div class="form-field"><label for="si-name">Tool name *</label><input id="si-name" name="name" required list="catalog-tools" autocomplete="off" placeholder="e.g. ChatGPT Plus" value="${v('name')}">${fieldError(errors, 'name')}</div>
      <div class="form-field"><label for="si-provider">Provider</label><input id="si-provider" name="provider" placeholder="e.g. OpenAI" value="${v('provider')}"></div>
      <div class="form-field"><label for="si-category">Category</label><input id="si-category" name="category" placeholder="e.g. Chat Assistants" value="${v('category')}"></div>
      <div class="form-field"><label for="si-cost">Monthly cost *</label><input id="si-cost" name="monthly_cost" type="text" inputmode="decimal" required placeholder="19.99" value="${v('monthly_cost')}">${fieldError(errors, 'monthly_cost')}</div>
      <div class="form-field"><label for="si-qty">Seats</label><input id="si-qty" name="quantity" type="number" min="1" max="10000" step="1" value="${v('quantity') || '1'}">${fieldError(errors, 'quantity')}</div>
      <div class="form-field form-wide"><label for="si-notes">Notes (optional)</label><input id="si-notes" name="notes" placeholder="Plan, seat, annual discount…" value="${v('notes')}"></div>
    </div>
    <label class="check-row"><input type="checkbox" name="active" value="1"${active ? ' checked' : ''}> Include in monthly total</label>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Add to stack</button></div>
  </form>`;
}

function renderStackDetail(ctx, stack, { errors = {}, values = {} } = {}) {
  const items = listStackItems(ctx.store, stack.id, ctx.user.id);
  const totalCents = stackTotal(ctx.store, stack.id, ctx.user.id);
  const activeCount = items.filter((i) => i.active === 1).length;
  const currency = stack.currency || 'USD';

  const rows = items.map((i) => {
    const active = i.active === 1;
    return `<tr>
      <td>
        <strong>${esc(i.name)}</strong>
        ${i.provider ? `<div class="muted small">${esc(i.provider)}</div>` : ''}
        ${i.category ? `<div class="muted small">${esc(i.category)}</div>` : ''}
        ${i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}
      </td>
      <td class="num">${formatCents(i.monthly_cost_cents, currency)}</td>
      <td class="num">${i.quantity}</td>
      <td><span class="pill ${active ? 'pill-active' : 'pill-dormant'}">${active ? 'Active' : 'Paused'}</span></td>
      <td>
        <details class="row-edit"><summary>Edit</summary>
          <form method="post" action="/stacks/${stack.id}/items/${i.id}/update" class="form form-compact">
            ${csrfField(ctx.csrf)}
            <div class="form-grid">
              <div class="form-field"><label>Tool name</label><input name="name" required value="${esc(i.name)}"></div>
              <div class="form-field"><label>Provider</label><input name="provider" value="${esc(i.provider || '')}"></div>
              <div class="form-field"><label>Category</label><input name="category" value="${esc(i.category || '')}"></div>
              <div class="form-field"><label>Monthly cost</label><input name="monthly_cost" type="text" inputmode="decimal" required value="${esc((i.monthly_cost_cents / 100).toFixed(2))}"></div>
              <div class="form-field"><label>Seats</label><input name="quantity" type="number" min="1" max="10000" step="1" value="${i.quantity}"></div>
              <div class="form-field form-wide"><label>Notes</label><input name="notes" value="${esc(i.notes || '')}"></div>
            </div>
            <label class="check-row"><input type="checkbox" name="active" value="1"${active ? ' checked' : ''}> Include in monthly total</label>
            <div class="form-actions"><button class="btn btn-ghost btn-sm" type="submit">Save changes</button></div>
          </form>
        </details>
        <form method="post" action="/stacks/${stack.id}/items/${i.id}/delete" class="inline-form" data-confirm="Remove ${esc(i.name)} from this stack?">${csrfField(ctx.csrf)}<button class="btn btn-danger btn-sm" type="submit">Remove</button></form>
      </td>
    </tr>`;
  }).join('');

  const table = items.length
    ? `<div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th class="num">Monthly</th><th class="num">Seats</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty-state"><h3>No items yet</h3><p>Add the AI tools you pay for and Atlas will sum your monthly spend.</p></div>`;

  const body = `
  <div class="page-head">
    <p class="eyebrow">Your space</p>
    <h1 class="page-title">${esc(stack.name)}</h1>
    <p class="page-sub">Track your monthly AI spend at a glance.</p>
  </div>
  ${Object.keys(errors).length ? `<p class="flash flash-error" role="alert">Please fix the issues below.</p>` : ''}
  <div class="stat-row">
    <div class="stat"><span class="stat-num" data-stack-total-cents="${totalCents}">${formatCents(totalCents, currency)}</span><span class="stat-label">Monthly total</span></div>
    <div class="stat"><span class="stat-num">${items.length}</span><span class="stat-label">Tools</span></div>
    <div class="stat"><span class="stat-num">${activeCount}</span><span class="stat-label">Active</span></div>
  </div>
  <div class="admin-nav">
    <form method="post" action="/stacks/${stack.id}/rename" class="inline-form">${csrfField(ctx.csrf)}<input name="name" value="${esc(stack.name)}" aria-label="Stack name"><button class="btn btn-ghost btn-sm" type="submit">Rename</button></form>
    <form method="post" action="/stacks/${stack.id}/delete" class="inline-form" data-confirm="Delete this stack and all its items?">${csrfField(ctx.csrf)}<button class="btn btn-danger btn-sm" type="submit">Delete stack</button></form>
    <a class="btn btn-ghost btn-sm" href="/stacks">← All stacks</a>
  </div>
  ${catalogDatalist(ctx.store)}
  ${section('Add a tool', itemFormHtml(ctx, stack.id, { values, errors }))}
  ${section('Your stack', table)}
  `;
  return pageFor(ctx, `${stack.name} — ${SITE_NAME}`, body, 'Your AI stack and monthly spend.');
}

function renderStacksPage(ctx, { errors = {}, values = {} } = {}) {
  const stacks = listStacks(ctx.store, ctx.user.id);
  const cards = stacks.map((s) => {
    const totalCents = stackTotal(ctx.store, s.id, ctx.user.id);
    const items = listStackItems(ctx.store, s.id, ctx.user.id);
    return `<a class="category-card" href="/stacks/${s.id}">
      <span class="category-name">${esc(s.name)}</span>
      <span class="muted small">${items.length} tool${items.length === 1 ? '' : 's'} · ${formatCents(totalCents, s.currency || 'USD')}/mo</span>
    </a>`;
  }).join('');

  const body = `
  <div class="page-head">
    <p class="eyebrow">Your space</p>
    <h1 class="page-title">Your AI Stack</h1>
    <p class="page-sub">Assemble the tools you actually pay for, and see your total monthly AI spend in one place.</p>
  </div>
  ${Object.keys(errors).length ? `<p class="flash flash-error" role="alert">Please fix the issues below.</p>` : ''}
  <form method="post" action="/stacks" class="form form-wide">
    ${csrfField(ctx.csrf)}
    <div class="form-field"><label for="stack-name">Stack name *</label><input id="stack-name" name="name" required placeholder="e.g. Marketing stack" value="${esc(values.name ?? '')}">${fieldError(errors, 'name')}</div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Create stack</button></div>
  </form>
  ${stacks.length ? section('Saved stacks', `<div class="category-grid">${cards}</div>`) : `<div class="empty-state"><h3>No stacks yet</h3><p>Create a stack to start tracking your monthly AI spend.</p></div>`}
  `;
  return pageFor(ctx, `Stacks — ${SITE_NAME}`, body, 'Build and save your custom AI stack with monthly spend totals.');
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function stacksPage(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  return renderStacksPage(ctx);
}

async function stacksCreatePost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const name = String(ctx.body.name || '').trim();
  const errors = {};
  if (!name) errors.name = 'Enter a stack name.';
  if (Object.keys(errors).length) return renderStacksPage(ctx, { errors, values: { name } });
  const id = createStack(ctx.store, { userId: ctx.user.id, name });
  return { redirect: '/stacks/' + id };
}

async function stackDetail(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  const stack = getStack(ctx.store, id, ctx.user.id);
  if (!stack) return { status: 404, body: 'Not found' };
  return renderStackDetail(ctx, stack);
}

async function stackRenamePost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  const stack = getStack(ctx.store, id, ctx.user.id);
  if (!stack) return { status: 404, body: 'Not found' };
  const name = String(ctx.body.name || '').trim();
  if (name) renameStack(ctx.store, id, ctx.user.id, name);
  return { redirect: '/stacks/' + id };
}

async function stackDeletePost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  deleteStack(ctx.store, id, ctx.user.id);
  return { redirect: '/stacks' };
}

function validateItemBody(body) {
  const errors = {};
  const values = {
    name: String(body.name || '').trim(),
    provider: String(body.provider || '').trim(),
    category: String(body.category || '').trim(),
    notes: String(body.notes || '').trim(),
    monthly_cost: String(body.monthly_cost ?? '').trim(),
    quantity: String(body.quantity ?? ''),
    active: parseActive(body.active),
  };
  const costRes = parseCents(body.monthly_cost);
  const qtyRes = parseQuantity(body.quantity === '' || body.quantity === undefined || body.quantity === null ? '1' : body.quantity);
  if (!values.name) errors.name = 'Enter a tool name.';
  if (!costRes.ok) errors.monthly_cost = costRes.reason === 'missing' ? 'Enter a monthly cost.' : 'Enter a valid monthly cost (e.g. 19.99).';
  if (!qtyRes.ok) errors.quantity = 'Seats must be a whole number from 1 to 10000.';
  return { errors, values, costRes, qtyRes };
}

async function stackItemAddPost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  const stack = getStack(ctx.store, id, ctx.user.id);
  if (!stack) return { status: 404, body: 'Not found' };
  const { errors, values, costRes, qtyRes } = validateItemBody(ctx.body);
  if (Object.keys(errors).length) return renderStackDetail(ctx, stack, { errors, values });
  addStackItem(ctx.store, {
    stackId: id, userId: ctx.user.id,
    name: values.name, provider: values.provider, category: values.category,
    monthlyCostCents: costRes.cents, quantity: qtyRes.value, active: values.active, notes: values.notes,
  });
  return { redirect: '/stacks/' + id };
}

async function stackItemUpdatePost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  const itemId = parseInt(ctx.params.itemId, 10);
  const stack = getStack(ctx.store, id, ctx.user.id);
  if (!stack) return { status: 404, body: 'Not found' };
  const item = getStackItem(ctx.store, id, itemId, ctx.user.id);
  if (!item) return { status: 404, body: 'Not found' };
  const { errors, values, costRes, qtyRes } = validateItemBody(ctx.body);
  if (Object.keys(errors).length) return renderStackDetail(ctx, stack, { errors, values });
  updateStackItem(ctx.store, id, itemId, ctx.user.id, {
    name: values.name, provider: values.provider, category: values.category,
    monthlyCostCents: costRes.cents, quantity: qtyRes.value, active: values.active, notes: values.notes,
  });
  return { redirect: '/stacks/' + id };
}

async function stackItemDeletePost(ctx) {
  const r = requireUserApi(ctx); if (r) return r;
  const id = parseInt(ctx.params.id, 10);
  const itemId = parseInt(ctx.params.itemId, 10);
  deleteStackItem(ctx.store, id, itemId, ctx.user.id);
  return { redirect: '/stacks/' + id };
}

/* ------------------------------------------------------------------ */
/* Routes + exports                                                    */
/* ------------------------------------------------------------------ */

const routes = [
  ['GET', '/stacks', 'stacksPage'],
  ['POST', '/stacks', 'stacksCreatePost'],
  ['GET', '/stacks/:id', 'stackDetail'],
  ['POST', '/stacks/:id/rename', 'stackRenamePost'],
  ['POST', '/stacks/:id/delete', 'stackDeletePost'],
  ['POST', '/stacks/:id/items', 'stackItemAddPost'],
  ['POST', '/stacks/:id/items/:itemId/update', 'stackItemUpdatePost'],
  ['POST', '/stacks/:id/items/:itemId/delete', 'stackItemDeletePost'],
];

const handlers = {
  stacksPage, stacksCreatePost, stackDetail, stackRenamePost, stackDeletePost,
  stackItemAddPost, stackItemUpdatePost, stackItemDeletePost,
};

module.exports = {
  migrate, routes, handlers,
  helpers: {
    createStack, listStacks, getStack, renameStack, deleteStack,
    addStackItem, updateStackItem, deleteStackItem, listStackItems, stackTotal,
    parseCents, parseQuantity, parseActive, formatCents,
  },
};

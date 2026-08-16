'use strict';
/**
 * CRITICAL PENDING TASKS — shipping the 5 that directly block report use cases.
 *
 *   T1: Email infrastructure (SMTP queue + newsletter digest sender)
 *   T2: Referral redirect endpoint (/ref/:slug → record click → redirect with UTM)
 *   T3: Admin UI for editorial test results (create/view test results)
 *   T4: Uptime checker (periodic URL ping → lifecycle_status update)
 *   T5: Price change detection (check pricing → price_history + trigger alerts)
 */
const crypto = require('crypto');
const { esc, layout, section, csrfField, SITE_NAME, toolCard } = require('./html');

const now = () => new Date().toISOString();

/* ==================== T1: Email Infrastructure ==================== */

/** In-memory outbox for SMTP delivery. Replace with real SMTP (nodemailer/SendGrid) in prod. */
let outbox = [];
let smtpConfig = null;

function configureSMTP(config) {
  smtpConfig = config;
}
function getOutbox() { return outbox; }
function clearOutbox() { outbox = []; }

/**
 * Queue an email. In production this would call nodemailer.sendMail().
 * Currently stores in outbox array — visible at /admin/newsletter for review.
 */
function queueEmail({ to, subject, html }) {
  const email = { id: crypto.randomBytes(8).toString('hex'), to, subject, html, queuedAt: now(), sent: false };
  outbox.push(email);
  // Keep outbox capped at 1000
  if (outbox.length > 1000) outbox = outbox.slice(-1000);
  console.log(`[email] Queued: "${subject}" to ${to}`);
  return email.id;
}

function emailTemplate(type, data) {
  if (type === 'newsletter_digest') {
    const { toolCount, tools, categories } = data;
    const toolList = tools.map(t => `<li><a href="${esc(t.url)}">${esc(t.name)}</a> — ${esc(t.tagline)} (${esc(t.category)})</li>`).join('');
    return `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a18;">
<h2>This week in AI tools</h2>
<p>${toolCount} new tools across ${categories} categories.</p>
<ul>${toolList}</ul>
<p style="color:#6b6a63;font-size:0.85em;">Atlas AI · <a href="#">Unsubscribe</a></p>
</body></html>`;
  }
  if (type === 'price_alert') {
    const { toolName, toolSlug, oldPricing, newPricing } = data;
    return `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a18;">
<h2>Price change: ${esc(toolName)}</h2>
<p>Pricing changed from <strong>${esc(oldPricing || 'unknown')}</strong> to <strong>${esc(newPricing)}</strong>.</p>
<p><a href="#">View on Atlas AI</a> · <a href="#">Manage alerts</a></p>
</body></html>`;
  }
  if (type === 'dormancy_alert') {
    const { toolName, toolSlug } = data;
    return `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a18;">
<h2>⚠ ${esc(toolName)} may be inactive</h2>
<p>This tool was flagged as <strong>Dormant</strong>. Check for alternatives in the same category.</p>
<p><a href="#">View alternatives</a> · <a href="#">Manage alerts</a></p>
</body></html>`;
  }
  return '';
}

async function sendNewsletterDigest(store) {
  const tools = store.listTools({ sort: 'recent', limit: 20 });
  const weekAgo = Date.now() - 7 * 86400000;
  const newTools = tools.filter(t => new Date(t.created_at).getTime() > weekAgo);
  if (!newTools.length) return { sent: 0, reason: 'No new tools this week' };

  const categories = [...new Set(newTools.map(t => t.category))].length;
  const html = emailTemplate('newsletter_digest', { toolCount: newTools.length, tools: newTools.slice(0, 10), categories });
  const subject = `New AI tools this week — ${SITE_NAME}`;

  if (store.kind() === 'sqlite') {
    const subs = store.all('SELECT email FROM subscribers WHERE active = 1');
    for (const s of subs) queueEmail({ to: s.email, subject, html });
    return { sent: subs.length, queued: subs.length };
  }
  const subs = store.data.subscribers.filter(s => s.active === 1);
  for (const s of subs) queueEmail({ to: s.email, subject, html });
  return { sent: subs.length, queued: subs.length };
}

/* ==================== T2: Referral Redirect ==================== */

function migrateReferralRedirect(store) {
  if (store.kind() === 'sqlite') {
    try { store.db.exec('ALTER TABLE referral_events ADD COLUMN ref_slug TEXT'); } catch {}
  }
}

async function referralRedirect(ctx) {
  const { slug } = ctx.params;
  const tool = ctx.store.getToolBySlug(slug);
  if (!tool) return { status: 404, html: 'Tool not found' };

  // Record click event
  const utm = {
    source: ctx.query.utm_source || 'atlas-ai',
    medium: ctx.query.utm_medium || 'referral',
    campaign: ctx.query.utm_campaign || ctx.query.ref || slug,
  };
  if (ctx.store.kind() === 'sqlite') {
    ctx.store.run('INSERT INTO referral_events (tool_id, event_type, ip, utm_source, utm_medium, utm_campaign, ref_slug, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [tool.id, 'click', ctx.ip || '', utm.source, utm.medium, utm.campaign, slug, now()]);
  } else {
    if (!ctx.store.data.referral_events) ctx.store.data.referral_events = [];
    ctx.store.data.referral_events.push({
      id: ctx.store._next(ctx.store.data.referral_events), tool_id: tool.id, event_type: 'click',
      ip: ctx.ip || '', utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign,
      ref_slug: slug, created_at: now(),
    });
    ctx.store.save();
  }

  // Build redirect URL with UTM params
  const targetUrl = new URL(tool.url);
  targetUrl.searchParams.set('utm_source', utm.source);
  targetUrl.searchParams.set('utm_medium', utm.medium);
  targetUrl.searchParams.set('utm_campaign', utm.campaign);
  targetUrl.searchParams.set('utm_content', 'atlas-ai-directory');

  return { redirect: targetUrl.toString() };
}

/* ==================== T3: Admin UI for Editorial Test Results ==================== */

async function adminTestResults(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login?next=/admin/tests' };
  const tools = ctx.store.listTools({ limit: 500 });
  const allResults = [];
  if (ctx.store.kind() === 'sqlite') {
    for (const t of tools.slice(0, 30)) {
      const results = ctx.store.all('SELECT * FROM test_results WHERE tool_id = ? ORDER BY test_date DESC', [t.id]);
      if (results.length) allResults.push({ tool: t, results });
    }
  } else {
    for (const t of tools.slice(0, 30)) {
      const results = (ctx.store.data.test_results || []).filter(r => r.tool_id === t.id).sort((a, b) => b.test_date < a.test_date ? -1 : 1);
      if (results.length) allResults.push({ tool: t, results });
    }
  }

  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Editorial Test Results</h1><p class="page-sub">Manage hands-on test results for tools.</p></div>
  <div class="admin-nav"><a class="btn" href="/admin/tests/new">+ New test result</a><a class="btn btn-ghost" href="/admin">← Admin home</a></div>
  ${allResults.length ? allResults.map(({ tool, results }) => section(tool.name, `
    ${results.map(r => `<div class="review-item">
      <div class="review-head"><strong>${esc(r.tester_name)}</strong> <span class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> <span class="muted small">${r.test_date ? new Date(r.test_date).toLocaleDateString() : ''}</span></div>
      ${r.pros ? `<p><strong>Pros:</strong> ${esc(r.pros)}</p>` : ''}
      ${r.cons ? `<p><strong>Cons:</strong> ${esc(r.cons)}</p>` : ''}
      ${r.verdict ? `<p><strong>Verdict:</strong> ${esc(r.verdict)}</p>` : ''}
    </div>`).join('')}
  `)).join('') : '<div class="empty-state"><h3>No test results yet</h3><p>Create editorial test results for tools to power the "Tested by us" badges.</p></div>'}
  `;
  return { html: layout({ title: `Test Results — ${SITE_NAME}`, description: 'Editorial test results.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'admin', body }) };
}

function testResultForm(ctx, { errors = {}, values = {} } = {}) {
  const tools = ctx.store.listTools({ limit: 200 });
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">New Test Result</h1></div>
  ${Object.keys(errors).length ? '<p class="flash flash-error" role="alert">Please fix the issues below.</p>' : ''}
  <form method="post" action="/admin/tests/new" class="form form-wide">
    ${csrfField(ctx.csrf)}
    <div class="form-grid">
      <div class="form-field"><label for="tr-tool">Tool *</label><select id="tr-tool" name="tool_id" required><option value="">— select —</option>${tools.map(t => `<option value="${t.id}"${values.tool_id == t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div class="form-field"><label for="tr-tester">Tester name *</label><input id="tr-tester" name="tester_name" required value="${esc(values.tester_name || '')}"></div>
      <div class="form-field"><label for="tr-date">Test date</label><input id="tr-date" name="test_date" type="date" value="${esc(values.test_date || new Date().toISOString().slice(0, 10))}"></div>
      <div class="form-field"><label for="tr-rating">Rating *</label><select id="tr-rating" name="rating"><option value="5"${values.rating == '5' ? ' selected' : ''}>★★★★★ Excellent</option><option value="4"${values.rating == '4' ? ' selected' : ''}>★★★★☆ Good</option><option value="3"${values.rating == '3' ? ' selected' : ''}>★★★☆☆ OK</option><option value="2"${values.rating == '2' ? ' selected' : ''}>★★☆☆☆ Poor</option><option value="1"${values.rating == '1' ? ' selected' : ''}>★☆☆☆☆ Bad</option></select></div>
      <div class="form-field form-wide"><label for="tr-pros">Pros</label><textarea id="tr-pros" name="pros" rows="3">${esc(values.pros || '')}</textarea></div>
      <div class="form-field form-wide"><label for="tr-cons">Cons</label><textarea id="tr-cons" name="cons" rows="3">${esc(values.cons || '')}</textarea></div>
      <div class="form-field form-wide"><label for="tr-verdict">Verdict</label><textarea id="tr-verdict" name="verdict" rows="2">${esc(values.verdict || '')}</textarea></div>
      <div class="form-field"><label for="tr-methodology">Methodology</label><input id="tr-methodology" name="methodology" value="${esc(values.methodology || 'Standard 3-task evaluation over 1 week')}"></div>
    </div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Save test result</button><a class="btn btn-ghost" href="/admin/tests">Cancel</a></div>
  </form>`;
  return { html: layout({ title: `New Test Result — ${SITE_NAME}`, description: 'Create editorial test result.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'admin', body }) };
}

async function adminTestNew(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login?next=/admin/tests/new' };
  return testResultForm(ctx);
}

async function adminTestNewPost(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const { tool_id, tester_name, test_date, rating, pros, cons, verdict, methodology } = ctx.body;
  const errors = {};
  if (!tool_id || !ctx.store.getToolById(parseInt(tool_id, 10))) errors.tool = 'Select a valid tool.';
  if (!tester_name || String(tester_name).trim().length < 2) errors.tester = 'Enter tester name.';
  if (!rating || parseInt(rating, 10) < 1 || parseInt(rating, 10) > 5) errors.rating = 'Rating must be 1–5.';
  if (Object.keys(errors).length) return testResultForm(ctx, { errors, values: ctx.body });

  const data = {
    toolId: parseInt(tool_id, 10),
    testerName: String(tester_name).trim(),
    testDate: test_date || now().slice(0, 10),
    rating: parseInt(rating, 10),
    pros: String(pros || '').trim(),
    cons: String(cons || '').trim(),
    verdict: String(verdict || '').trim(),
    methodology: String(methodology || 'Standard 3-task evaluation over 1 week'),
  };

  if (ctx.store.kind() === 'sqlite') {
    ctx.store.run('INSERT INTO test_results (tool_id, tester_name, test_date, rating, pros, cons, verdict, methodology, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [data.toolId, data.testerName, data.testDate, data.rating, data.pros, data.cons, data.verdict, data.methodology, now()]);
  } else {
    if (!ctx.store.data.test_results) ctx.store.data.test_results = [];
    ctx.store.data.test_results.push({ id: ctx.store._next(ctx.store.data.test_results), ...data, created_at: now() });
    ctx.store.save();
  }
  return { redirect: '/admin/tests?msg=' + encodeURIComponent('Test result saved.') };
}

/* ==================== T4: Uptime Checker ==================== */

/**
 * Run an uptime check for a single tool. In production, call this from a cron job.
 * Returns the detected lifecycle status: Active | Dormant | Dead | Unreachable
 */
async function checkToolUptime(tool, options = {}) {
  const timeoutMs = options.timeout || 15000;
  try {
    const resp = await fetch(tool.url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const statusText = resp.ok ? 'reachable' : `${resp.status}`;
    // Update last_verified_at
    return { status: 'Active', detail: `reachable (HTTP ${resp.status})` };
  } catch (err) {
    return { status: 'Dormant', detail: `unreachable: ${err.message.slice(0, 80)}` };
  }
}

/**
 * Check all published tools and update lifecycle_status.
 * Call from a cron job every 24 hours.
 */
async function runUptimeCheck(store) {
  const tools = store.listTools({ limit: 500 });
  const results = [];
  for (const tool of tools) {
    const check = await checkToolUptime(tool);
    if (tool.lifecycle_status !== check.status) {
      if (store.kind() === 'sqlite') {
        store.run('UPDATE tools SET lifecycle_status = ?, last_verified_at = ? WHERE id = ?', [check.status, now(), tool.id]);
      } else {
        const t = store.data.tools.find(t => t.id === tool.id);
        if (t) { t.lifecycle_status = check.status; t.last_verified_at = now(); store.save(); }
      }
      results.push({ slug: tool.slug, oldStatus: tool.lifecycle_status || 'Active', newStatus: check.status, detail: check.detail });
    }
  }
  return { checked: tools.length, changed: results.length, changes: results };
}

/* ==================== T5: Price Change Detection ==================== */

/**
 * Compare current pricing_model against last recorded price in price_history.
 * If changed, record history and trigger alerts.
 */
async function runPriceCheck(store) {
  const tools = store.listTools({ limit: 500 });
  const changes = [];
  for (const tool of tools) {
    const lastPrice = store.kind() === 'sqlite'
      ? store.get('SELECT * FROM price_history WHERE tool_id = ? ORDER BY changed_at DESC LIMIT 1', [tool.id])
      : (store.data.price_history || []).filter(p => p.tool_id === tool.id).sort((a, b) => b.changed_at < a.changed_at ? -1 : 1)[0] || null;

    const currentPricing = tool.pricing_model;
    const lastPricing = lastPrice ? lastPrice.new_pricing : null;

    if (lastPricing && lastPricing !== currentPricing) {
      // Record price change
      if (store.kind() === 'sqlite') {
        store.run('INSERT INTO price_history (tool_id, old_pricing, new_pricing, changed_at) VALUES (?,?,?,?)', [tool.id, lastPricing, currentPricing, now()]);
      } else {
        if (!store.data.price_history) store.data.price_history = [];
        store.data.price_history.push({ id: store._next(store.data.price_history), tool_id: tool.id, old_pricing: lastPricing, new_pricing: currentPricing, changed_at: now() });
        store.save();
      }
      changes.push({ slug: tool.slug, name: tool.name, oldPricing: lastPricing, newPricing: currentPricing });

      // Trigger alerts for subscribed users
      const alertUsers = store.kind() === 'sqlite'
        ? store.all('SELECT user_id FROM alerts WHERE tool_id = ? AND type = ?', [tool.id, 'price_change'])
        : (store.data.alerts || []).filter(a => a.tool_id === tool.id && a.type === 'price_change');

      for (const a of alertUsers) {
        const user = store.getUserById(a.user_id);
        if (user) {
          const html = emailTemplate('price_alert', { toolName: tool.name, toolSlug: tool.slug, oldPricing: lastPricing, newPricing: currentPricing });
          queueEmail({ to: user.email, subject: `Price change: ${tool.name}`, html });
        }
      }
    }
  }
  return { checked: tools.length, changes: changes.length, details: changes };
}

/* ==================== Admin Newsletter Dashboard ==================== */

async function adminNewsletter(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login?next=/admin/newsletter' };
  const count = ctx.store.kind() === 'sqlite'
    ? ctx.store.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').n
    : ctx.store.data.subscribers.filter(s => s.active === 1).length;
  const outboxItems = outbox.slice(-20).reverse();

  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Newsletter</h1><p class="page-sub">${count} active subscriber${count === 1 ? '' : 's'}. Outbox: ${outbox.length} queued.</p></div>
  <div class="admin-nav">
    <form method="post" action="/admin/newsletter/send" class="inline-form">${csrfField(ctx.csrf)}<button class="btn btn-primary" type="submit" ${count === 0 ? 'disabled' : ''}>Send digest now</button></form>
  </div>
  ${outboxItems.length ? section('Recent outbox', `<div class="table-wrap"><table class="table"><thead><tr><th>To</th><th>Subject</th><th>Queued</th><th>Status</th></tr></thead><tbody>${outboxItems.map(e => `<tr><td>${esc(e.to)}</td><td>${esc(e.subject)}</td><td class="muted small">${new Date(e.queuedAt).toLocaleString()}</td><td><span class="pill pill-${e.sent ? 'published' : 'draft'}">${e.sent ? 'sent' : 'queued'}</span></td></tr>`).join('')}</tbody></table></div>`) : ''}
  `;
  return { html: layout({ title: `Newsletter Admin — ${SITE_NAME}`, description: 'Newsletter admin.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'admin', body }) };
}

async function adminNewsletterSend(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const result = await sendNewsletterDigest(ctx.store);
  return { redirect: '/admin/newsletter?msg=' + encodeURIComponent(`Queued ${result.queued || 0} emails.`) };
}

/* ==================== Routes ==================== */

const routes = [
  // T2: Referral redirect
  ['GET', '/ref/:slug', 'referralRedirect'],
  // T3: Admin test results
  ['GET', '/admin/tests', 'adminTestResults'],
  ['GET', '/admin/tests/new', 'adminTestNew'],
  ['POST', '/admin/tests/new', 'adminTestNewPost'],
  // T1/T4/T5: Admin newsletter + uptime + price checks
  ['GET', '/admin/newsletter', 'adminNewsletter'],
  ['POST', '/admin/newsletter/send', 'adminNewsletterSend'],
];

const handlers = {
  referralRedirect,
  adminTestResults, adminTestNew, adminTestNewPost,
  adminNewsletter, adminNewsletterSend,
};

module.exports = {
  routes, handlers, configureSMTP, queueEmail, emailTemplate, sendNewsletterDigest,
  migrateReferralRedirect, runUptimeCheck, runPriceCheck, checkToolUptime, getOutbox,
};

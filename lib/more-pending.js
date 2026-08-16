'use strict';
/**
 * T6-T16 REMAINING PENDING TASKS — shipping the full backlog.
 *
 *   T6:  Review identity verification framework
 *   T8:  Trust & safety quarterly stats
 *   T9:  Maker analytics category benchmarks
 *   T10: Last-verified auto-degradation
 *   T11: CSV import for bulk tool creation
 *   T14: Deals page + affiliate system
 *   T15: Enterprise compliance data admin UI
 *   T16: Maker subscription tier framework
 *
 *   T7:  Comparison PDF export → lib/pdf-export.js (separate module)
 *   T12: Embeddable widget JS → public/widget.js (standalone)
 *   T13: Multi-language locale system → locales/en.json + lib/locales.js
 */
const crypto = require('crypto');
const { esc, layout, section, csrfField, SITE_NAME } = require('./html');

const now = () => new Date().toISOString();

/* ==================== T6: Review Identity Verification ==================== */

function migrateReviewVerification(store) {
  if (store.kind() === 'sqlite') {
    try { store.db.exec('ALTER TABLE reviews ADD COLUMN verified INTEGER DEFAULT 0'); } catch {}
    try { store.db.exec('ALTER TABLE reviews ADD COLUMN verification_method TEXT'); } catch {}
    try { store.db.exec('ALTER TABLE reviews ADD COLUMN reviewed_by_admin INTEGER DEFAULT 0'); } catch {}
  }
}

async function verifyReview(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const reviewId = parseInt(ctx.params.id, 10);
  if (!reviewId) return { redirect: '/admin' };

  if (ctx.store.kind() === 'sqlite') {
    ctx.store.run('UPDATE reviews SET verified = 1, reviewed_by_admin = 1, verification_method = ? WHERE id = ?', ['admin_manual', reviewId]);
  } else {
    const r = ctx.store.data.reviews.find(r => r.id === reviewId);
    if (r) { r.verified = 1; r.verification_method = 'admin_manual'; r.reviewed_by_admin = 1; ctx.store.save(); }
  }

  const toolSlug = ctx.params.toolSlug || '';
  return { redirect: '/admin?msg=' + encodeURIComponent('Review verified.') };
}

async function rejectReview(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const reviewId = parseInt(ctx.params.id, 10);
  if (!reviewId) return { redirect: '/admin' };

  if (ctx.store.kind() === 'sqlite') {
    ctx.store.run('DELETE FROM reviews WHERE id = ?', [reviewId]);
  } else {
    ctx.store.data.reviews = (ctx.store.data.reviews || []).filter(r => r.id !== reviewId);
    ctx.store.save();
  }

  return { redirect: '/admin?msg=' + encodeURIComponent('Review removed.') };
}

/* ==================== T8: Trust & Safety Stats ==================== */

function trustStats(store) {
  const reviews = store.kind() === 'sqlite'
    ? store.all('SELECT COUNT(*) as n FROM reviews').n
    : (store.data.reviews || []).length;
  const verified = store.kind() === 'sqlite'
    ? store.get('SELECT COUNT(*) as n FROM reviews WHERE verified = 1').n
    : (store.data.reviews || []).filter(r => r.verified).length;

  const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0, 0, 0, 0);
  const thisMonthReviews = store.kind() === 'sqlite'
    ? store.get('SELECT COUNT(*) as n FROM reviews WHERE created_at >= ?', [thisMonth.toISOString()]).n
    : (store.data.reviews || []).filter(r => new Date(r.created_at) >= thisMonth).length;

  const tests = store.kind() === 'sqlite'
    ? store.all('SELECT COUNT(*) as n FROM test_results').n
    : (store.data.test_results || []).length;

  const tools = store.listTools({ limit: 9999 });
  const dormant = tools.filter(t => t.lifecycle_status === 'Dormant').length;
  const dead = tools.filter(t => t.lifecycle_status === 'Dead').length;
  const verifiedTools = tools.filter(t => t.lifecycle_status === 'Verified').length;

  // Calculate fake review removal rate (simulated for now — would be automated in prod)
  const fakeRemovalRate = reviews > 0 ? ((reviews - verified) / reviews * 100).toFixed(1) : '0.0';

  return {
    totalReviews: reviews || 0,
    verifiedReviews: verified || 0,
    monthlyReviews: thisMonthReviews || 0,
    editorialTests: tests || 0,
    totalTools: tools.length,
    verifiedTools,
    dormantTools: dormant,
    deadTools: dead,
    removalRate: fakeRemovalRate + '%',
    lastUpdated: now(),
  };
}

function trustStatsHtml(stats) {
  return `<div class="stats-grid trust-stats">
    <div class="stat-card"><span class="stat-number">${stats.totalReviews}</span><span class="stat-label">Total reviews</span></div>
    <div class="stat-card"><span class="stat-number">${stats.verifiedReviews}</span><span class="stat-label">Verified reviews</span></div>
    <div class="stat-card"><span class="stat-number">${stats.monthlyReviews}</span><span class="stat-label">Reviews this month</span></div>
    <div class="stat-card"><span class="stat-number">${stats.removalRate}</span><span class="stat-label">Unverified rate</span></div>
    <div class="stat-card"><span class="stat-number">${stats.editorialTests}</span><span class="stat-label">Hands-on tests</span></div>
    <div class="stat-card"><span class="stat-number">${stats.totalTools}</span><span class="stat-label">Listed tools</span></div>
    <div class="stat-card"><span class="stat-number">${stats.verifiedTools}</span><span class="stat-label">Verified tools</span></div>
    <div class="stat-card stat-warn"><span class="stat-number">${stats.dormantTools + stats.deadTools}</span><span class="stat-label">Dormant/dead (auto-flagged)</span></div>
  </div>`;
}

/* ==================== T9: Maker Analytics Benchmarks ==================== */

function makerCategoryBenchmarks(store, toolIds) {
  if (!toolIds || !toolIds.length) return [];

  const tools = toolIds.map(id => store.getToolById(Number(id))).filter(Boolean);
  const allTools = store.listTools({ limit: 9999 });
  const categories = [...new Set(allTools.map(t => t.category).filter(Boolean))];

  return categories.map(cat => {
    const catTools = allTools.filter(t => t.category === cat);
    const myCatTools = tools.filter(t => t.category === cat);
    const catSlugs = catTools.map(t => t.slug);

    let avgViews = 0, avgClicks = 0, avgSignups = 0;
    if (store.kind() === 'sqlite' && catSlugs.length) {
      const ph = catSlugs.map(() => '?').join(',');
      const clicks = store.get('SELECT COUNT(*) as n FROM referral_events WHERE ref_slug IN (' + ph + ') AND event_type = ?', [...catSlugs, 'click']);
      avgClicks = Math.round((clicks ? clicks.n : 0) / catSlugs.length);
      avgViews = Math.round(avgClicks * 3.4); // Estimated click-through ratio
      avgSignups = Math.round(avgClicks * 0.12); // Estimated signup ratio
    } else if (store.data.referral_events) {
      const clicks = store.data.referral_events.filter(e => catSlugs.includes(e.ref_slug) && e.event_type === 'click').length;
      avgClicks = Math.round(clicks / catSlugs.length);
      avgViews = Math.round(avgClicks * 3.4);
      avgSignups = Math.round(avgClicks * 0.12);
    }

    const myClicks = store.kind() === 'sqlite'
      ? (myCatTools.length ? store.get('SELECT COUNT(*) as n FROM referral_events WHERE tool_id IN (' + myCatTools.map(() => '?').join(',') + ') AND event_type = ?', [...myCatTools.map(t => t.id), 'click']) : { n: 0 }).n
      : (store.data.referral_events || []).filter(e => myCatTools.some(t => t.id === e.tool_id) && e.event_type === 'click').length;

    return {
      category: cat,
      totalTools: catTools.length,
      myTools: myCatTools.length,
      avgClicksPerTool: avgClicks,
      avgViewsPerTool: avgViews,
      avgSignupsPerTool: avgSignups,
      myClicks: myClicks,
      benchmark: avgClicks > 0 ? Math.round((myClicks / avgClicks) * 100) : 100,
    };
  });
}

/* ==================== T10: Last-Verified Auto-Degradation ==================== */

async function runVerifiedDegradation(store) {
  const now_ = Date.now();
  const DAYS_30 = 30 * 86400000;
  const DAYS_90 = 90 * 86400000;
  const results = [];

  const tools = store.listTools({ limit: 9999 });
  for (const tool of tools) {
    const lastVerified = tool.last_verified_at ? new Date(tool.last_verified_at).getTime() : (tool.created_at ? new Date(tool.created_at).getTime() : now_);
    const age = now_ - lastVerified;
    let newStatus = tool.lifecycle_status;

    if (age > DAYS_90 && tool.lifecycle_status !== 'Dead') {
      newStatus = 'Unverified';
    } else if (age > DAYS_30 && newStatus === 'Verified') {
      newStatus = 'Unverified';
    }

    if (newStatus !== tool.lifecycle_status) {
      if (store.kind() === 'sqlite') {
        store.run('UPDATE tools SET lifecycle_status = ? WHERE id = ?', [newStatus, tool.id]);
      } else {
        const t = store.data.tools.find(t => t.id === tool.id);
        if (t) { t.lifecycle_status = newStatus; }
      }
      results.push({ slug: tool.slug, oldStatus: tool.lifecycle_status, newStatus, daysAgo: Math.round(age / 86400000) });
    }
  }
  if (store.kind() !== 'sqlite') store.save();
  return { checked: tools.length, degraded: results.length, changes: results };
}

/* ==================== T11: CSV Import ==================== */

function parseCSVImport(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [], errors: ['CSV must have a header row and at least one data row'] };

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const required = ['name', 'url', 'category'];
  const missing = required.filter(r => !headers.includes(r));
  if (missing.length) return { headers, rows: [], errors: [`Missing required columns: ${missing.join(', ')}`] };

  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) {
      errors.push(`Row ${i}: expected ${headers.length} columns, got ${values.length}`);
      continue;
    }
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j].trim(); });
    if (!row.name || !row.url || !row.category) {
      errors.push(`Row ${i}: missing required field (name/url/category)`);
      continue;
    }
    if (!row.url.startsWith('http')) row.url = 'https://' + row.url;
    rows.push(row);
  }
  return { headers, rows, errors };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

async function csvImportPage(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login?next=/admin/import' };
  const msg = ctx.query.msg || '';
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Bulk Import Tools</h1><p class="page-sub">Upload a CSV file to create multiple tool drafts at once.</p></div>
  ${msg ? `<p class="flash flash-success">${esc(msg)}</p>` : ''}
  <div class="admin-nav"><a class="btn btn-ghost" href="/admin">← Admin home</a></div>
  <div class="card">
    <h3>CSV Format</h3>
    <p>Required columns: <code>name, url, category</code></p>
    <p>Optional columns: <code>tagline, description, pricing_model, tags, image_url, free_tier_limits</code></p>
    <p>Tags should be pipe-separated: <code>tag1|tag2|tag3</code></p>
    <pre class="code-block">name,url,category,tagline,description,pricing_model,tags
"My Cool Tool",https://example.com,Writing,"Write better with AI","Full description here",Freemium,"writing|editing|grammar"</pre>
  </div>
  <form method="post" action="/admin/import" enctype="multipart/form-data" class="form card">
    ${csrfField(ctx.csrf)}
    <div class="form-field form-wide">
      <label for="csv-file">CSV File</label>
      <input id="csv-file" type="file" name="csv" accept=".csv,text/csv" required>
    </div>
    <div class="form-field form-wide">
      <label for="csv-status">Import as</label>
      <select id="csv-status" name="status">
        <option value="draft" selected>Draft (review before publishing)</option>
        <option value="published">Published (immediately live)</option>
      </select>
    </div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Import tools</button></div>
  </form>`;
  return { html: layout({ title: `Import Tools — ${SITE_NAME}`, description: 'Bulk import AI tools.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'admin', body }) };
}

function handleCSVUpload(rawBody, boundary) {
  // Simple multipart parser — extract CSV text from multipart/form-data
  const parts = rawBody.toString().split('--' + boundary);
  let csvText = null;
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    if (headers.includes('name="csv"')) {
      csvText = part.slice(headerEnd + 4).replace(/\r\n--$/, '').replace(/--$/, '').trim();
      break;
    }
  }
  return csvText;
}

async function csvImportPost(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const contentType = ctx.headers ? (ctx.headers['content-type'] || '') : '';

  let csvText = '';
  if (contentType.includes('multipart/form-data')) {
    const boundary = contentType.split('boundary=')[1];
    if (boundary && ctx.rawBody) {
      csvText = handleCSVUpload(ctx.rawBody, boundary);
    }
  } else {
    csvText = ctx.body.csv || '';
  }

  if (!csvText) return { redirect: '/admin/import?msg=' + encodeURIComponent('No CSV data received.') };

  const parsed = parseCSVImport(csvText);
  if (parsed.errors.length && !parsed.rows.length) {
    return { redirect: '/admin/import?msg=' + encodeURIComponent('Errors: ' + parsed.errors.join('; ')) };
  }

  let imported = 0;
  for (const row of parsed.rows) {
    const tool = {
      name: row.name,
      url: row.url,
      category: row.category,
      tagline: row.tagline || '',
      description: row.description || '',
      pricing_model: row.pricing_model || 'Free',
      tags: (row.tags || '').split('|').map(t => t.trim()).filter(Boolean),
      image_url: row.image_url || '',
      free_tier_limits: row.free_tier_limits || '',
      lifecycle_status: ctx.body.status === 'published' ? 'Active' : 'Draft',
      editorial_badge: null,
      editorial_notes: null,
      compliance_data: null,
      sponsored: 0,
      created_at: now(),
      updated_at: now(),
    };
    ctx.store.createTool(tool, ctx.user.id);
    imported++;
  }

  const msg = imported > 0
    ? `Imported ${imported} tool${imported !== 1 ? 's' : ''} as ${ctx.body.status || 'draft'}. ${parsed.errors.length ? parsed.errors.length + ' row(s) skipped: ' + parsed.errors.join('; ') : ''}`
    : 'No tools imported. ' + parsed.errors.join('; ');

  return { redirect: '/admin/import?msg=' + encodeURIComponent(msg) };
}

/* ==================== T14: Deals Page + Affiliate System ==================== */

function migrateDeals(store) {
  if (store.kind() === 'sqlite') {
    try { store.db.exec('ALTER TABLE tools ADD COLUMN has_deal INTEGER DEFAULT 0'); } catch {}
    try { store.db.exec('ALTER TABLE tools ADD COLUMN deal_description TEXT'); } catch {}
    try { store.db.exec('ALTER TABLE tools ADD COLUMN deal_code TEXT'); } catch {}
    try { store.db.exec('ALTER TABLE tools ADD COLUMN deal_url TEXT'); } catch {}
    try { store.db.exec('ALTER TABLE tools ADD COLUMN deal_expires TEXT'); } catch {}
    try { store.db.exec('ALTER TABLE tools ADD COLUMN affiliate_disclosure TEXT'); } catch {}
  }
}

function dealsPage(ctx) {
  const allTools = ctx.store.listTools({ limit: 9999 });
  const deals = [];
  if (ctx.store.kind() === 'sqlite') {
    const rows = ctx.store.all('SELECT * FROM tools WHERE has_deal = 1 AND (deal_expires > ? OR deal_expires IS NULL) ORDER BY deal_expires ASC', [now().slice(0, 10)]);
    deals.push(...rows);
  } else {
    deals.push(...allTools.filter(t => t.has_deal));
  }

  const body = `
  <div class="page-head">
    <p class="eyebrow">Exclusive offers</p>
    <h1 class="page-title">AI Tool Deals &amp; Discounts</h1>
    <p class="page-sub">Special pricing, promo codes, and affiliate offers for the community. Deals are verified by the Atlas AI team. ${deals.length ? deals.length + ' active deal' + (deals.length !== 1 ? 's' : '') : 'No active deals right now.'}</p>
  </div>
  ${deals.length ? `<div class="tool-grid">${deals.map(t => `
    <div class="deal-card">
      <div class="deal-badge">DEAL</div>
      <h3><a href="${esc(t.deal_url || '/ref/' + t.slug)}">${esc(t.name)}</a></h3>
      <p class="muted small">${esc(t.deal_description || 'Special offer')}</p>
      ${t.deal_code ? `<div class="deal-code"><code>${esc(t.deal_code)}</code><button class="btn btn-sm copy-code" data-code="${esc(t.deal_code)}">Copy</button></div>` : ''}
      <div class="deal-meta">
        <span class="pill pill-${(t.lifecycle_status || 'Active').toLowerCase()}">${esc(t.lifecycle_status || 'Active')}</span>
        ${t.deal_expires ? `<span class="muted tiny">Expires: ${new Date(t.deal_expires).toLocaleDateString()}</span>` : ''}
      </div>
      ${t.affiliate_disclosure ? `<p class="affiliate-note">${esc(t.affiliate_disclosure)}</p>` : ''}
    </div>
  `).join('')}</div>` : `<div class="empty-state"><h3>No active deals</h3><p>Check back soon or subscribe to the newsletter for deal alerts.</p><a class="btn btn-primary" href="/newsletter">Subscribe to newsletter</a></div>`}
  `;

  return { html: layout({ title: `AI Tool Deals — ${SITE_NAME}`, description: 'Exclusive AI tool deals, discounts, and promo codes.', user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, activeNav: 'deals', body }) };
}

/* ==================== T15: Enterprise Compliance Admin UI ==================== */

function adminCompliancePage(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login?next=/admin/compliance' };

  const allTools = ctx.store.listTools({ limit: 9999 });
  const withCompliance = allTools.filter(t => t.compliance_data);
  const withoutCompliance = allTools.filter(t => !t.compliance_data);

  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Enterprise Compliance</h1><p class="page-sub">${withCompliance.length}/${allTools.length} tools have compliance data.</p></div>
  <div class="admin-nav"><a class="btn btn-ghost" href="/admin">← Admin home</a></div>
  <div class="card">
    <h3>Quick-set compliance for multiple tools</h3>
    <form method="post" action="/admin/compliance/batch" class="form">
      ${csrfField(ctx.csrf)}
      <div class="form-grid">
        <div class="form-field form-wide"><label for="comp-tools">Select tools</label><select id="comp-tools" name="tool_ids" multiple style="height:120px">${allTools.map(t => `<option value="${t.id}">${esc(t.name)} ${t.compliance_data ? '✓' : ''}</option>`).join('')}</select></div>
        <div class="form-field form-wide"><label for="comp-data">Compliance data (JSON)</label><textarea id="comp-data" name="compliance_data" rows="4" placeholder='{"soc2": true, "gdpr": true, "hipaa": false, "iso27001": true, "certifications": ["SOC 2 Type II"], "dpa_available": true, "data_processing_location": "US/EU"}'></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Apply to selected tools</button></div>
    </form>
  </div>
  ${withCompliance.length ? section('Tools with compliance data', `<div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th>SOC 2</th><th>GDPR</th><th>HIPAA</th><th>ISO 27001</th><th>DPA</th></tr></thead><tbody>${withCompliance.map(t => {
    let cd = t.compliance_data;
    if (typeof cd === 'string') try { cd = JSON.parse(cd); } catch { cd = {}; }
    return `<tr><td><strong>${esc(t.name)}</strong></td><td>${cd.soc2 ? '✅' : '—'}</td><td>${cd.gdpr ? '✅' : '—'}</td><td>${cd.hipaa ? '✅' : '—'}</td><td>${cd.iso27001 ? '✅' : '—'}</td><td>${cd.dpa_available ? '✅' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div>`) : ''}
  `;
  return { html: layout({ title: `Compliance Admin — ${SITE_NAME}`, description: 'Enterprise compliance management.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'admin', body }) };
}

async function adminComplianceBatch(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') return { redirect: '/login' };
  const { tool_ids, compliance_data } = ctx.body;
  if (!tool_ids || !compliance_data) return { redirect: '/admin/compliance?msg=' + encodeURIComponent('Select tools and provide compliance data.') };

  // Validate JSON
  try { JSON.parse(compliance_data); } catch (e) { return { redirect: '/admin/compliance?msg=' + encodeURIComponent('Invalid JSON.') }; }

  const ids = Array.isArray(tool_ids) ? tool_ids : [tool_ids];
  for (const id of ids) {
    if (ctx.store.kind() === 'sqlite') {
      ctx.store.run('UPDATE tools SET compliance_data = ? WHERE id = ?', [compliance_data, parseInt(id, 10)]);
    } else {
      const t = ctx.store.data.tools.find(t => t.id === parseInt(id, 10));
      if (t) { t.compliance_data = compliance_data; ctx.store.save(); }
    }
  }
  return { redirect: '/admin/compliance?msg=' + encodeURIComponent(`Updated ${ids.length} tool(s).`) };
}

/* ==================== T16: Maker Subscription Tier Framework ==================== */

const MAKER_TIERS = {
  free: { name: 'Free', price: 0, features: ['Basic listing', 'View analytics (basic)', 'Claim one tool', 'Standard support'], limits: { tools: 1, categories: 3 } },
  pro: { name: 'Pro', price: 29, period: 'month', features: ['Priority listing', 'Full analytics + benchmarks', 'Claim unlimited tools', 'Referral tracking', 'Priority support', 'Custom tool page'], limits: { tools: 50, categories: 99 } },
  enterprise: { name: 'Enterprise', price: 199, period: 'month', features: ['Everything in Pro', 'API access', 'Dedicated account manager', 'Custom integrations', 'White-label embedding', 'SLA guarantee'], limits: { tools: 9999, categories: 99 } },
};

function migrateMakerTiers(store) {
  if (store.kind() === 'sqlite') {
    try { store.db.exec("ALTER TABLE users ADD COLUMN maker_tier TEXT DEFAULT 'free'"); } catch {}
    try { store.db.exec('ALTER TABLE users ADD COLUMN maker_subscription_id TEXT DEFAULT NULL'); } catch {}
    try { store.db.exec('ALTER TABLE users ADD COLUMN maker_subscription_status TEXT DEFAULT NULL'); } catch {}
  }
}

function pricingPage(ctx) {
  const body = `
  <div class="page-head">
    <p class="eyebrow">For makers</p>
    <h1 class="page-title">Maker Pricing</h1>
    <p class="page-sub">Claim your tools, track performance, and grow your reach. Transparent pricing, no ranking-for-payment.</p>
  </div>
  <div class="pricing-grid">
    ${Object.entries(MAKER_TIERS).map(([key, tier]) => `
      <div class="pricing-card ${key === 'pro' ? 'pricing-featured' : ''}">
        ${key === 'pro' ? '<div class="pricing-ribbon">Most popular</div>' : ''}
        <h3>${tier.name}</h3>
        <div class="pricing-amount">${tier.price === 0 ? 'Free' : '$' + tier.price + (tier.period ? '<span class="pricing-period">/' + tier.period + '</span>' : '')}</div>
        <ul class="pricing-features">
          ${tier.features.map(f => `<li>${f}</li>`).join('')}
        </ul>
        <p class="muted small">Up to ${tier.limits.tools === 9999 ? 'unlimited' : tier.limits.tools} tools</p>
        <a class="btn ${key === 'free' ? 'btn-ghost' : 'btn-primary'} btn-block" href="${key === 'free' ? '/claim' : '#'}">${key === 'free' ? 'Get started' : 'Coming soon'}</a>
        ${key !== 'free' ? '<p class="muted tiny" style="text-align:center;margin-top:8px;">Stripe integration pending — contact team for early access</p>' : ''}
      </div>
    `).join('')}
  </div>
  <div class="card trust-notice" style="text-align:center;margin-top:32px;">
    <strong>Our commitment:</strong> Pricing only affects tool promotion and feature access. Rankings are never for sale. <a href="/trust">Read our trust policy →</a>
  </div>
  <style>
  .pricing-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:24px; margin-top:24px; }
  .pricing-card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:28px 24px; position:relative; }
  .pricing-featured { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent), 0 4px 24px var(--shadow-color); }
  .pricing-ribbon { position:absolute; top:-12px; left:50%; transform:translateX(-50%); background:var(--accent); color:var(--bg); padding:4px 16px; border-radius:999px; font-size:0.75rem; font-weight:600; }
  .pricing-amount { font-size:2.5rem; font-weight:700; margin:12px 0 4px; }
  .pricing-period { font-size:1rem; font-weight:400; color:var(--text-muted); }
  .pricing-features { list-style:none; padding:0; margin:16px 0; }
  .pricing-features li { padding:6px 0; padding-left:20px; position:relative; }
  .pricing-features li::before { content:'✓'; position:absolute; left:0; color:var(--accent); }
  .pricing-card .btn-block { display:block; width:100%; text-align:center; }
  </style>`;

  return { html: layout({ title: `Maker Pricing — ${SITE_NAME}`, description: 'Transparent pricing for AI tool makers. No ranking-for-payment.', user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, activeNav: 'pricing', body }) };
}

/* ==================== Routes ==================== */

const routes = [
  // T6: Review verification
  ['POST', '/admin/reviews/:id/verify', 'verifyReview'],
  ['POST', '/admin/reviews/:id/reject', 'rejectReview'],
  // T11: CSV import
  ['GET', '/admin/import', 'csvImportPage'],
  ['POST', '/admin/import', 'csvImportPost'],
  // T14: Deals page
  ['GET', '/deals', 'dealsPage'],
  // T15: Enterprise compliance
  ['GET', '/admin/compliance', 'adminCompliancePage'],
  ['POST', '/admin/compliance/batch', 'adminComplianceBatch'],
  // T16: Maker pricing
  ['GET', '/pricing', 'pricingPage'],
];

const handlers = {
  verifyReview, rejectReview,
  csvImportPage, csvImportPost,
  dealsPage,
  adminCompliancePage, adminComplianceBatch,
  pricingPage,
};

module.exports = {
  routes, handlers, MAKER_TIERS, trustStats, trustStatsHtml, makerCategoryBenchmarks,
  migrateReviewVerification, migrateDeals, migrateMakerTiers, runVerifiedDegradation,
  parseCSVImport,
};

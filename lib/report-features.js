'use strict';
/**
 * Report-driven features (F-1, F-2, F-4, F-6, F-9, F-10, F-13).
 * Builds on the existing extensions.js to fulfill report recommendations.
 */
const { esc, layout, section, csrfField, SITE_NAME, toolCard } = require('./html');
const { slugify } = require('./auth');

const now = () => new Date().toISOString();

/* ==================== F-1: Task-First Search ==================== */
/**
 * Natural-language task search: "write cold emails" → matching tools.
 * Uses a task taxonomy mapping common jobs to categories and tags.
 */
const TASK_TAXONOMY = [
  { task: 'write cold emails', cats: ['Marketing', 'Productivity'], tags: ['email', 'outreach', 'sales'] },
  { task: 'transcribe meetings', cats: ['Productivity', 'Audio & Music'], tags: ['transcription', 'meetings', 'notes'] },
  { task: 'generate images', cats: ['Image Generation'], tags: ['text-to-image', 'art', 'design'] },
  { task: 'write code', cats: ['Coding & Development'], tags: ['coding', 'programming', 'api'] },
  { task: 'edit videos', cats: ['Video & Animation'], tags: ['video', 'editing', 'animation'] },
  { task: 'create music', cats: ['Audio & Music'], tags: ['music', 'audio', 'composition'] },
  { task: 'analyze data', cats: ['Data & Analytics'], tags: ['data', 'analytics', 'spreadsheets'] },
  { task: 'design presentations', cats: ['Design', 'Productivity'], tags: ['presentations', 'slides', 'design'] },
  { task: 'research papers', cats: ['Research & Knowledge'], tags: ['research', 'papers', 'search'] },
  { task: 'automate workflows', cats: ['Agents & Automation'], tags: ['automation', 'workflow', 'agents'] },
  { task: 'generate voice', cats: ['Voice & Speech'], tags: ['tts', 'voice', 'speech'] },
  { task: 'chat assistant', cats: ['Chat Assistants'], tags: ['chat', 'assistant', 'qa'] },
  { task: 'write content', cats: ['Writing'], tags: ['writing', 'content', 'blog'] },
  { task: 'marketing seo', cats: ['Marketing'], tags: ['seo', 'marketing', 'ads'] },
  { task: 'design graphics', cats: ['Design'], tags: ['design', 'graphics', 'branding'] },
];

function taskSearch(store, query) {
  const q = query.toLowerCase().trim();
  // Score-based matching: exact > full-phrase > tag > first-word (last resort)
  const scored = TASK_TAXONOMY.map(t => {
    let score = 0;
    const taskLower = t.task.toLowerCase();
    if (q === taskLower) score += 100;
    else if (taskLower.includes(q) || q.includes(taskLower)) score += 80;
    if (t.tags.some(tag => q.includes(tag))) score += 40;
    if (q.split(/\s+/).length === 1 && taskLower.split(' ')[0] === q) score += 10; // single-word first-word match only
    return { t, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  const matched = scored.map(x => x.t);
  if (!matched.length) {
    // Fall back to regular search
    return { tools: store.listTools({ q: query, limit: 12 }), taskMatch: null };
  }
  const task = matched[0];
  // Get tools matching the task's categories or tags
  let tools = [];
  for (const cat of task.cats) {
    tools = tools.concat(store.listTools({ category: cat, limit: 50 }));
  }
  // Also search by tags
  for (const tag of task.tags) {
    tools = tools.concat(store.listTools({ tag, limit: 20 }));
  }
  // Deduplicate by id
  const seen = new Set();
  tools = tools.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
  // Sort by popularity
  tools.sort((a, b) => b.popularity - a.popularity);
  return { tools: tools.slice(0, 12), taskMatch: task };
}

async function taskSearchPage(ctx) {
  const q = String(ctx.query.q || '').trim();
  const result = q ? taskSearch(ctx.store, q) : null;
  const taskExamples = TASK_TAXONOMY.slice(0, 8).map(t => esc(t.task));
  const body = `
  <div class="page-head">
    <p class="eyebrow">Task-first search</p>
    <h1 class="page-title">What do you want to get done?</h1>
    <p class="page-sub">Describe your task in plain language. We'll match you to the right AI tools.</p>
  </div>
  <form class="hero-search" action="/tasks" method="get" role="search" style="max-width:620px;margin-bottom:32px;">
    <label class="visually-hidden" for="task-q">Describe your task</label>
    <input id="task-q" type="search" name="q" value="${esc(q)}" placeholder="e.g. write personalized cold emails at scale" autocomplete="off">
    <button class="btn btn-primary" type="submit">Find tools</button>
  </form>
  ${!q ? `<div class="chip-row"><p class="muted small" style="width:100%;margin-bottom:8px;">Try:</p>${taskExamples.map(t => `<a class="chip" href="/tasks?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
  ${result ? (result.taskMatch ? `<p class="flash">Matched task: <strong>${esc(result.taskMatch.task)}</strong> — ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} found.</p>` : '') : ''}
  ${result && result.tools.length ? `<div class="tool-grid">${result.tools.map(t => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div>` : (q ? '<div class="empty-state"><h3>No tools found</h3><p>Try a different task description.</p></div>' : '')}
  `;
  return { html: layout({ title: `Task Search — ${SITE_NAME}`, description: 'Find AI tools by the job you want to get done.', user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, activeNav: 'browse', body }) };
}

/* ==================== F-4: Pricing Calculator ==================== */
function pricingCalculator(tool) {
  // Returns HTML for a usage-based cost estimator
  if (!tool) return '';
  const tiers = {
    'Free': { monthly: 0, description: 'No cost' },
    'Freemium': { monthly: 20, description: 'Free tier + paid plans from ~$20/mo' },
    'Paid': { monthly: 30, description: 'Paid plans from ~$30/mo' },
  };
  const tier = tiers[tool.pricing_model] || tiers['Freemium'];
  return `
  <div class="pricing-calc" id="pricing-calc">
    <h3 class="section-title" style="font-size:1.2rem;margin-bottom:12px;">Cost estimator</h3>
    <p class="muted small" style="margin-bottom:14px;">${esc(tier.description)}</p>
    <div class="form-field" style="max-width:340px;">
      <label for="usage-slider">Estimated monthly uses <span class="usage-value" id="usage-value">100</span></label>
      <input type="range" id="usage-slider" min="0" max="2000" value="100" step="10" style="width:100%;" data-base="${tier.monthly}" data-model="${esc(tool.pricing_model)}" aria-describedby="est-cost">
      <p class="muted small" style="margin-top:8px;">Estimated cost: <span class="cost-output" id="est-cost">$${tier.monthly}</span><span class="tier-badge" id="est-tier">${esc(tool.pricing_model)}</span>/mo</p>
      <p class="cost-breakdown" id="cost-breakdown">${esc(tier.description)}</p>
    </div>
    ${tool.free_tier_limits ? `<p class="muted small">Free tier limits: ${esc(tool.free_tier_limits)}</p>` : ''}
  </div>`;
}

/* ==================== F-6: Maker Referral Analytics ==================== */
function migrateAnalytics(store) {
  if (store.kind() === 'sqlite') {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS referral_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        ip TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_referral_tool ON referral_events(tool_id, created_at);
    `);
  } else {
    if (!store.data.referral_events) { store.data.referral_events = []; store.save(); }
  }
}

function recordReferralEvent(store, { toolId, type, ip, utm }) {
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO referral_events (tool_id, event_type, ip, utm_source, utm_medium, utm_campaign, created_at) VALUES (?,?,?,?,?,?,?)',
      [toolId, type, ip || '', utm?.source || '', utm?.medium || '', utm?.campaign || '', t]);
  } else {
    store.data.referral_events.push({ id: store._next(store.data.referral_events), tool_id: toolId, event_type: type, ip: ip || '', utm_source: utm?.source || '', utm_medium: utm?.medium || '', utm_campaign: utm?.campaign || '', created_at: t });
    store.save();
  }
}

function getReferralStats(store, toolId) {
  if (store.kind() === 'sqlite') {
    const views = store.get('SELECT COUNT(*) AS n FROM referral_events WHERE tool_id = ? AND event_type = ?', [toolId, 'view'])?.n || 0;
    const clicks = store.get('SELECT COUNT(*) AS n FROM referral_events WHERE tool_id = ? AND event_type = ?', [toolId, 'click'])?.n || 0;
    const signups = store.get('SELECT COUNT(*) AS n FROM referral_events WHERE tool_id = ? AND event_type = ?', [toolId, 'signup'])?.n || 0;
    return { views, clicks, signups };
  }
  const events = store.data.referral_events.filter(e => e.tool_id === toolId);
  return {
    views: events.filter(e => e.event_type === 'view').length,
    clicks: events.filter(e => e.event_type === 'click').length,
    signups: events.filter(e => e.event_type === 'signup').length,
  };
}

async function makerAnalyticsPage(ctx) {
  if (!ctx.user) return { redirect: '/login?next=/maker/analytics' };
  // Get claimed tools by this user
  const extHelpers = require('./extensions').helpers;
  const claims = require('./extensions').helpers;
  // Use listClaimsByUser from extensions
  const ext = require('./extensions');
  const userClaims = ext.helpers.listClaimsByUser ? null : null; // already imported
  // Direct query
  let claimedTools = [];
  if (ctx.store.kind() === 'sqlite') {
    const claimRows = ctx.store.all('SELECT tool_id FROM tool_claims WHERE user_id = ? AND status = ?', [ctx.user.id, 'approved']);
    claimedTools = claimRows.map(c => ctx.store.getToolById(c.tool_id)).filter(Boolean);
  } else {
    claimedTools = ctx.store.data.tool_claims.filter(c => c.user_id === ctx.user.id && c.status === 'approved')
      .map(c => ctx.store.getToolById(c.tool_id)).filter(Boolean);
  }

  const toolStats = claimedTools.map(t => {
    const stats = getReferralStats(ctx.store, t.id);
    const ctr = stats.views > 0 ? ((stats.clicks / stats.views) * 100).toFixed(1) : '0.0';
    const conv = stats.clicks > 0 ? ((stats.signups / stats.clicks) * 100).toFixed(1) : '0.0';
    return { tool: t, ...stats, ctr, conv };
  });

  const body = `
  <div class="page-head">
    <p class="eyebrow">Maker Portal</p>
    <h1 class="page-title">Referral Analytics</h1>
    <p class="page-sub">Views → clicks → signups for your claimed tools. Auto-UTM tracking included.</p>
  </div>
  ${toolStats.length ? `
    <div class="stat-row">
      <div class="stat"><span class="stat-num" data-count="${toolStats.reduce((s,t) => s + t.views, 0)}">${toolStats.reduce((s,t) => s + t.views, 0)}</span><span class="stat-label">Total views</span></div>
      <div class="stat"><span class="stat-num" data-count="${toolStats.reduce((s,t) => s + t.clicks, 0)}">${toolStats.reduce((s,t) => s + t.clicks, 0)}</span><span class="stat-label">Total clicks</span></div>
      <div class="stat"><span class="stat-num" data-count="${toolStats.reduce((s,t) => s + t.signups, 0)}">${toolStats.reduce((s,t) => s + t.signups, 0)}</span><span class="stat-label">Signups tracked</span></div>
    </div>
    ${(() => {
      // T9: Category benchmarks
      try {
        const mp = require('./more-pending');
        const benchmarks = mp.makerCategoryBenchmarks(ctx.store, claimedTools.map(t => t.id));
        if (!benchmarks.length) return '';
        const benchRows = benchmarks.filter(b => b.myTools > 0).map(b => `
          <tr>
            <td>${esc(b.category)}</td>
            <td>${b.myTools}</td>
            <td>${b.totalTools}</td>
            <td>${b.myClicks}</td>
            <td>${b.avgClicksPerTool}</td>
            <td>${b.benchmark}%</td>
          </tr>`).join('');
        if (!benchRows) return '';
        return section('Category benchmarks', `<p class="muted small">How your tools compare to the category average.</p><div class="table-wrap"><table class="table"><thead><tr><th>Category</th><th>Your tools</th><th>Total in category</th><th>Your clicks</th><th>Avg clicks/tool</th><th>Performance</th></tr></thead><tbody>${benchRows}</tbody></table></div>`, {});
      } catch (e) { return ''; }
    })()}
    ${toolStats.map(s => section(s.tool.name, `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Views</td><td>${s.views}</td></tr>
          <tr><td>Clicks (CTR)</td><td>${s.clicks} (${s.ctr}%)</td></tr>
          <tr><td>Signups (Conversion)</td><td>${s.signups} (${s.conv}%)</td></tr>
          <tr><td>Referral link</td><td><code class="code-block" style="display:inline;">${'/?ref=' + esc(s.tool.slug)}</code></td></tr>
        </tbody>
      </table></div>
      <p class="muted small">Share your referral link with auto-UTM: <code>?ref=${esc(s.tool.slug)}&utm_source=maker&utm_medium=referral</code></p>
    `)).join('')}
  ` : '<div class="empty-state"><h3>No claimed tools yet</h3><p>Claim a tool to see referral analytics.</p><a class="btn" href="/claim">Claim a tool</a></div>'}
  `;
  return { html: layout({ title: `Analytics — ${SITE_NAME}`, description: 'Maker referral analytics.', user: { ...ctx.user, csrf: ctx.csrf }, activeNav: 'dashboard', body }) };
}

/* ==================== F-9: Hands-on Test Results ==================== */
function migrateTestResults(store) {
  if (store.kind() === 'sqlite') {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        tester_name TEXT NOT NULL,
        test_date TEXT NOT NULL,
        rating INTEGER NOT NULL,
        pros TEXT,
        cons TEXT,
        verdict TEXT,
        methodology TEXT DEFAULT 'Standard 3-task evaluation over 1 week',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_test_results_tool ON test_results(tool_id);
    `);
  } else {
    if (!store.data.test_results) { store.data.test_results = []; store.save(); }
  }
}

function createTestResult(store, data) {
  const t = now();
  if (store.kind() === 'sqlite') {
    store.run('INSERT INTO test_results (tool_id, tester_name, test_date, rating, pros, cons, verdict, methodology, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [data.toolId, data.testerName, data.testDate, data.rating, data.pros || '', data.cons || '', data.verdict || '', data.methodology || 'Standard 3-task evaluation over 1 week', t]);
    return store.get('SELECT MAX(id) AS id FROM test_results WHERE tool_id = ?', [data.toolId]).id;
  }
  const r = { id: store._next(store.data.test_results), ...data, created_at: t };
  store.data.test_results.push(r); store.save(); return r.id;
}

function listTestResults(store, toolId) {
  if (store.kind() === 'sqlite') {
    return store.all('SELECT * FROM test_results WHERE tool_id = ? ORDER BY test_date DESC', [toolId]);
  }
  return store.data.test_results.filter(t => t.tool_id === toolId).sort((a, b) => b.test_date < a.test_date ? -1 : 1);
}

/* ==================== F-10: Merit-based Ranking ==================== */
/**
 * Transparent ranking formula:
 * score = (popularity * 0.3) + (freshness * 0.25) + (verified * 0.2) + (reviews * 0.15) + (votes * 0.1)
 * Freshness boost: tools verified within 30 days get +20; 60 days +10; 90+ days +0
 */
function meritScore(tool, opts = {}) {
  const popularity = (tool.popularity || 0) / 100; // 0-1
  const daysSinceVerified = tool.last_verified_at ? Math.floor((Date.now() - new Date(tool.last_verified_at).getTime()) / 86400000) : 999;
  const freshness = daysSinceVerified < 30 ? 1.0 : daysSinceVerified < 60 ? 0.7 : daysSinceVerified < 90 ? 0.4 : 0.1;
  const verified = tool.last_verified_at ? 1.0 : 0.3;
  const reviewScore = opts.reviewCount ? Math.min(1.0, opts.reviewCount / 10) : 0;
  const voteScore = opts.voteCount ? Math.min(1.0, opts.voteCount / 50) : 0;
  const score = (popularity * 0.30) + (freshness * 0.25) + (verified * 0.20) + (reviewScore * 0.15) + (voteScore * 0.10);
  return Math.round(score * 100);
}

/* ==================== F-13: Student/Integrity Hub ==================== */
async function studentHubPage(ctx) {
  const freeTools = ctx.store.listTools({ pricing: 'Free', limit: 12 });
  const freemiumTools = ctx.store.listTools({ pricing: 'Freemium', limit: 12 });
  const body = `
  <div class="page-head">
    <p class="eyebrow">For students & researchers</p>
    <h1 class="page-title">Student AI Tool Hub</h1>
    <p class="page-sub">Free and affordable AI tools for academic work — with integrity guidance and privacy information.</p>
  </div>
  ${section('Academic integrity guidance', `
    <div class="flash" style="margin-bottom:16px;">
      <strong>Use AI as a learning aid, not a replacement for your own thinking.</strong>
    </div>
    <ul class="activity-list">
      <li class="activity-row"><span class="activity-type">Do</span> Use AI for brainstorming, outlining, and understanding concepts.</li>
      <li class="activity-row"><span class="activity-type">Do</span> Cite AI assistance in your work when your institution requires it.</li>
      <li class="activity-row"><span class="activity-type">Don't</span> Submit AI-generated text as your own original work.</li>
      <li class="activity-row"><span class="activity-type">Don't</span> Use AI for exams unless explicitly permitted.</li>
      <li class="activity-row"><span class="activity-type">Check</span> Your institution's AI policy — most have published guidelines.</li>
    </ul>
  `, {})}
  ${section('Privacy & your data', `
    <p>When using AI tools for research:</p>
    <ul>
      <li><strong>Check data retention policies</strong> — some tools train on your inputs by default.</li>
      <li><strong>Opt out of training</strong> where possible (most tools offer this in settings).</li>
      <li><strong>Don't upload unpublished research</strong> to tools that train on inputs.</li>
      <li><strong>Use API access</strong> when available — APIs typically don't train on your data.</li>
    </ul>
  `, {})}
  ${section('Completely free tools', `<div class="tool-grid">${freeTools.map(t => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div>`, { id: 'free' })}
  ${section('Freemium tools (free tier available)', `<div class="tool-grid">${freemiumTools.map(t => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div><p class="muted small">Always check the free-tier limits before relying on a tool for coursework.</p>`, { id: 'freemium' })}
  `;
  return { html: layout({ title: `Student Hub — ${SITE_NAME}`, description: 'Free AI tools and academic integrity guidance for students.', user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, activeNav: 'browse', body }) };
}

/* ==================== Ranking formula page ==================== */
async function rankingFormulaPage(ctx) {
  const body = `
  <div class="page-head">
    <p class="eyebrow">Transparency</p>
    <h1 class="page-title">How We Rank Tools</h1>
    <p class="page-sub">Our ranking formula is public. Payment never affects it.</p>
  </div>
  ${section('The formula', `
    <p>Each tool's merit score (0–100) is calculated as:</p>
    <div class="code-block">score = (popularity × 0.30) + (freshness × 0.25) + (verification × 0.20) + (reviews × 0.15) + (community votes × 0.10)</div>
    <table class="table" style="margin-top:20px;">
      <thead><tr><th>Signal</th><th>Weight</th><th>What it means</th></tr></thead>
      <tbody>
        <tr><td>Popularity</td><td>30%</td><td>Editor-assigned popularity score (0–100) based on market presence</td></tr>
        <tr><td>Freshness</td><td>25%</td><td>How recently the listing was verified: <30 days = full score, <60 = 70%, <90 = 40%, 90+ = 10%</td></tr>
        <tr><td>Verification</td><td>20%</td><td>Whether the listing has been verified by an editor or maker (verified = full, unverified = 30%)</td></tr>
        <tr><td>Reviews</td><td>15%</td><td>Number of verified reviews (capped at 10 for full score)</td></tr>
        <tr><td>Community votes</td><td>10%</td><td>"I use this daily" votes (capped at 50 for full score)</td></tr>
      </tbody>
    </table>
  `, {})}
  ${section('What we never do', `
    <ul class="activity-list">
      <li class="activity-row"><span class="activity-type">Never</span> Accept payment for ranking position</li>
      <li class="activity-row"><span class="activity-type">Never</span> Give "freshness boost" to paid listings</li>
      <li class="activity-row"><span class="activity-type">Never</span> Allow sponsored content in organic results</li>
      <li class="activity-row"><span class="activity-type">Never</span> Sell "guaranteed engagement" bundles</li>
    </ul>
    <p class="muted small">See our <a href="/trust">trust policy</a> for the full "never" list.</p>
  `, {})}
  ${section('New tool boost', `
    <p>Tools added within the last 7 days get a small temporary visibility boost in "New" and category pages. This helps new tools get discovered — it does not affect the merit score itself.</p>
  `, {})}
  `;
  return { html: layout({ title: `Ranking Formula — ${SITE_NAME}`, description: 'Transparent, merit-based ranking formula.', user: ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null, body }) };
}

/* ==================== Routes ==================== */
const routes = [
  ['GET', '/tasks', 'taskSearchPage'],
  ['GET', '/maker/analytics', 'makerAnalyticsPage'],
  ['GET', '/student', 'studentHubPage'],
  ['GET', '/ranking', 'rankingFormulaPage'],
];

const handlers = {
  taskSearchPage,
  makerAnalyticsPage,
  studentHubPage,
  rankingFormulaPage,
};

module.exports = {
  routes, handlers,
  migrateAnalytics, migrateTestResults,
  pricingCalculator,
  meritScore,
  recordReferralEvent, getReferralStats,
  createTestResult, listTestResults,
  taskSearch,
  TASK_TAXONOMY,
};

'use strict';
/**
 * Page & API handlers. Each receives ctx (see core.js) and returns one of:
 *   { html } | { redirect } | { json } | { status, body }
 */
const crypto = require('crypto');
const { esc, layout, toolCard, categoryGrid, reasonChips, section, pagination, flash, csrfField, fieldError, SITE_NAME } = require('./html');
const { related, forUser, categoryHighlights } = require('./recommender');
const { hashPassword, makeSalt, verifyPassword, rateLimit, validateEmail, validatePassword, slugify, SESSION_TTL_MS } = require('./auth');
const { HttpError } = require('./errors');

let BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
function configure(opts = {}) { if (opts.baseUrl) BASE_URL = opts.baseUrl; }

const CATEGORY_DESC = {
  'Chat Assistants': 'General-purpose assistants and AI search.',
  'Writing': 'Drafting, editing, and content tools.',
  'Image Generation': 'Text-to-image and image editing.',
  'Video & Animation': 'AI video generation and editing.',
  'Audio & Music': 'Music and audio generation.',
  'Voice & Speech': 'Text-to-speech and speech-to-text.',
  'Coding & Development': 'AI assistants for developers.',
  'Productivity': 'Meetings, notes, and calendar AI.',
  'Design': 'UI, branding, and creative tools.',
  'Research & Knowledge': 'Paper search and research assistants.',
  'Marketing': 'SEO, ads, and content marketing.',
  'Data & Analytics': 'Spreadsheets, BI, and data chat.',
  'Agents & Automation': 'Workflow automation and AI agents.',
};
const PRICING = ['Free', 'Freemium', 'Paid'];

const catSlug = (name) => slugify(name);

/* ---------------- helpers ---------------- */
function page(ctx, title, body, opts = {}) {
  const user = ctx.user ? { ...ctx.user, csrf: ctx.csrf } : null;
  return { html: layout({ title, description: opts.description, user, activeNav: opts.activeNav, body, canonical: opts.canonical, jsonLd: opts.jsonLd, og: opts.og, extraHead: opts.extraHead }) };
}
function redirect(location) { return { redirect: location }; }
function requireUser(ctx) {
  if (!ctx.user) return redirect('/login?next=' + encodeURIComponent(ctx.path));
  return null;
}
function requireAdmin(ctx) {
  const r = requireUser(ctx);
  if (r) return r;
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Forbidden: admin access required');
  return null;
}
function anonCsrfCookies(ctx) {
  if (ctx.anonCsrf) return { cookies: [] };
  return { cookies: [{ name: 'csrf', value: crypto.randomBytes(16).toString('hex'), maxAge: 86400 }] };
}
function resolveCategory(ctx, value) {
  if (!value) return null;
  const all = ctx.store.categories();
  const direct = all.find((c) => c.name === value);
  if (direct) return value;
  const bySlug = all.find((c) => catSlug(c.name) === value);
  return bySlug ? bySlug.name : null;
}
function recordEvent(ctx, type, toolId = null, data = null) {
  try { ctx.store.addEvent({ userId: ctx.user ? ctx.user.id : null, type, toolId, data }); } catch { /* non-fatal */ }
}
function toolJsonLd(tool) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: tool.name,
    description: `${tool.tagline} ${tool.description}`.trim(),
    url: `${BASE_URL}/tool/${tool.slug}`,
    applicationCategory: tool.category,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: `${tool.pricing_model} plan` },
    aggregateRating: undefined,
  };
}

/* ---------------- public ---------------- */
async function home(ctx) {
  const cats = ctx.store.categories();
  const popular = ctx.store.listTools({ sort: 'popular', limit: 8 });
  const recent = ctx.store.listTools({ sort: 'recent', limit: 8 });
  let recs = null;
  if (ctx.user) {
    const favs = ctx.store.listFavorites(ctx.user.id);
    const views = ctx.store.recentViews(ctx.user.id, 6);
    recs = forUser(favs, views, ctx.store.listTools({ limit: 1000 }), 6);
  }
  const body = `
  <section class="hero">
    <div class="hero-mesh" aria-hidden="true"></div>
    <div class="container">
    <p class="eyebrow">Curated directory · ${cats.length} categories · ${ctx.store.stats().published} tools</p>
    <h1 class="hero-title">The AI tools you need,<br>without the noise.</h1>
    <p class="hero-sub">Search, compare, and save the best AI tools — organized by the job you actually want to do.</p>
    <form class="hero-search" action="/browse" method="get" role="search">
      <label class="visually-hidden" for="q-hero">Search tools</label>
      <input id="q-hero" type="search" name="q" placeholder="e.g. write cold emails, transcribe meetings…" autocomplete="off" data-typeahead>
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <div class="hero-actions" style="display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap;">
      <button class="btn btn-ghost btn-surprise" id="surprise-btn" type="button"><span class="dice" aria-hidden="true">🎲</span>&nbsp; Surprise me</button>
      <a class="btn btn-ghost" href="/compare">Compare tools</a>
    </div>
    <div class="typeahead" data-typeahead-results hidden></div>
    </div>
  </section>
  ${recs ? section('Recommended for you', `<div class="tool-grid">${recs.items.map((r) => toolCard(r.tool, { fav: ctx.store.isFavorite(ctx.user.id, r.tool.id) })).join('')}</div><p class="section-sub">${esc(recs.basis)}</p>`) : ''}
  ${section('Browse by category', categoryGrid(cats), { id: 'categories' })}
  ${section('Popular this month', `<div class="tool-grid">${popular.map((t) => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div><p class="section-more"><a href="/browse?sort=popular">View all →</a></p>`)}
  ${section('Recently added', `<div class="tool-grid">${recent.map((t) => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div><p class="section-more"><a href="/browse?sort=recent">View all →</a></p>`)}
  `;
  return page(ctx, `${SITE_NAME} — Curated AI Tool Directory`, body, {
    description: 'Browse and discover the best AI tools by category: chat, writing, image, video, coding, design, research, marketing, and more. Save favorites and get personalized recommendations.',
    activeNav: 'browse',
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: BASE_URL,
      potentialAction: { '@type': 'SearchAction', target: `${BASE_URL}/browse?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
    },
  });
}

async function browse(ctx) {
  const { q = '', category = '', tag = '', pricing = '', sort = 'popular', pg = '1' } = ctx.query;
  const cat = resolveCategory(ctx, category) || '';
  const pageNum = Math.max(1, parseInt(pg, 10) || 1);
  const limit = 24;
  const opts = { status: 'published', q: q.trim(), category: cat || undefined, tag: tag || undefined, pricing: pricing || undefined, sort, limit, offset: (pageNum - 1) * limit };
  const tools = ctx.store.listTools(opts);
  const total = ctx.store.countTools({ status: 'published', q: q.trim(), category: cat || undefined, tag: tag || undefined, pricing: pricing || undefined });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const cats = ctx.store.categories();
  const allTags = ctx.store.tags().slice(0, 24);

  const filterLink = (extra) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (cat) p.set('category', cat);
    if (tag) p.set('tag', tag);
    if (pricing) p.set('pricing', pricing);
    if (sort !== 'popular') p.set('sort', sort);
    for (const [k, v] of Object.entries(extra)) { if (v) p.set(k, v); else p.delete(k); }
    const s = p.toString();
    return s ? `/browse?${s}` : '/browse';
  };
  const active = (k, v) => (k === 'category' ? cat === v : k === 'tag' ? tag === v : k === 'pricing' ? pricing === v : false);

  const facet = (label, items, key) => {
    if (!items.length) return '';
    return `<div class="facet"><h3 class="facet-title">${label}</h3>${items.map((it) => {
      const val = it.name; const isActive = active(key, val);
      return `<a class="facet-link${isActive ? ' active' : ''}" href="${esc(filterLink({ [key]: isActive ? '' : val }))}">${esc(it.name)}<span class="facet-count">${it.count}</span></a>`;
    }).join('')}</div>`;
  };

  const sortLink = (s) => filterLink({ sort: s });
  const title = cat ? `${cat} AI Tools — ${SITE_NAME}` : (q.trim() ? `Search: ${q.trim()} — ${SITE_NAME}` : `All AI Tools — ${SITE_NAME}`);
  const desc = cat ? `Browse ${cat} AI tools: ${CATEGORY_DESC[cat] || 'curated tools in this category.'}` : 'Browse every curated AI tool, filtered by category, tags, and pricing.';

  const body = `
  <div class="page-head">
    <p class="eyebrow">Directory</p>
    <h1 class="page-title">${cat ? esc(cat) : q.trim() ? `Results for “${esc(q.trim())}”` : 'All tools'}</h1>
    <p class="page-sub">${total} tool${total === 1 ? '' : 's'}${cat ? ` in ${esc(cat)}` : ''}${pricing ? ` · ${esc(pricing)}` : ''}${tag ? ` · tagged “${esc(tag)}”` : ''}</p>
  </div>
  <form class="browse-search" action="/browse" method="get" role="search">
    <label class="visually-hidden" for="q-browse">Search tools</label>
    <input id="q-browse" type="search" name="q" value="${esc(q)}" placeholder="Search tools…" data-typeahead>
    ${cat ? `<input type="hidden" name="category" value="${esc(cat)}">` : ''}
    <button class="btn" type="submit">Search</button>
  </form>
  <div class="browse-layout">
    <aside class="facets" aria-label="Filters">
      ${facet('Category', cats, 'category')}
      ${facet('Pricing', PRICING.map((p) => ({ name: p, count: ctx.store.countTools({ status: 'published', category: cat || undefined, pricing: p }) })), 'pricing')}
      ${facet('Tags', allTags, 'tag')}
      ${(cat || tag || pricing || q.trim()) ? `<a class="facet-clear" href="/browse">Clear all filters</a>` : ''}
    </aside>
    <div class="browse-main">
      <div class="sort-row" role="group" aria-label="Sort">
        <a class="sort-link${sort === 'popular' ? ' active' : ''}" href="${esc(sortLink('popular'))}">Popular</a>
        <a class="sort-link${sort === 'recent' ? ' active' : ''}" href="${esc(sortLink('recent'))}">Newest</a>
        <a class="sort-link${sort === 'name' ? ' active' : ''}" href="${esc(sortLink('name'))}">A–Z</a>
      </div>
      ${flash(ctx.query.msg)}
      ${tools.length ? `<div class="tool-grid">${tools.map((t) => toolCard(t, { fav: ctx.user ? ctx.store.isFavorite(ctx.user.id, t.id) : false })).join('')}</div>` : '<div class="empty-state"><h3>No tools found</h3><p>Try a different search term or clear some filters.</p><a class="btn" href="/browse">Clear filters</a></div>'}
      ${pagination(pageNum, totalPages, `/browse?${new URLSearchParams({ q, category: cat, tag, pricing, sort }).toString()}`)}
    </div>
  </div>`;

  return page(ctx, title, body, {
    description: desc, activeNav: 'browse',
    jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: `${BASE_URL}/browse` },
  });
}

async function categoriesPage(ctx) {
  const cats = ctx.store.categories();
  const body = `<div class="page-head"><p class="eyebrow">Directory</p><h1 class="page-title">Categories</h1><p class="page-sub">${cats.length} categories, every tool editor-curated.</p></div>${categoryGrid(cats)}`;
  return page(ctx, `Categories — ${SITE_NAME}`, body, { description: 'Browse AI tools by category.', activeNav: 'categories' });
}

async function categoryPage(ctx) {
  const slug = ctx.params.slug;
  const cats = ctx.store.categories();
  const cat = cats.find((c) => catSlug(c.name) === slug);
  if (!cat) throw new HttpError(404, 'Category not found');
  const tools = ctx.store.listTools({ category: cat.name, limit: 1000 });
  const { trending, newest } = categoryHighlights(tools);
  const body = `
  <div class="page-head">
    <p class="eyebrow">Category</p>
    <h1 class="page-title">${esc(cat.name)}</h1>
    <p class="page-sub">${esc(CATEGORY_DESC[cat.name] || '')} ${cat.count} tools.</p>
    <a class="btn" href="/browse?category=${esc(cat.name)}">Filter all tools →</a>
  </div>
  ${section('Trending in this category', `<div class="tool-grid">${trending.map((t) => toolCard(t)).join('')}</div>`, { sub: 'Most popular in ' + cat.name })}
  ${section('New in this category', `<div class="tool-grid">${newest.map((t) => toolCard(t)).join('')}</div>`, { sub: 'Recently added' })}
  `;
  return page(ctx, `${cat.name} AI Tools — ${SITE_NAME}`, body, {
    description: `Discover ${cat.name} AI tools: ${CATEGORY_DESC[cat.name] || ''}`,
    activeNav: 'browse',
    jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${cat.name} AI tools`, url: `${BASE_URL}/category/${slug}` },
  });
}

async function toolDetail(ctx) {
  const tool = ctx.store.getToolBySlug(ctx.params.slug);
  if (!tool || tool.status !== 'published') throw new HttpError(404, 'Tool not found');
  if (ctx.user) recordEvent(ctx, 'view', tool.id);
  const all = ctx.store.listTools({ limit: 1000 });
  const recs = related(tool, all, 4);
  const sameCat = all.filter((t) => t.category === tool.category && t.id !== tool.id).slice(0, 4);
  const fav = ctx.user ? ctx.store.isFavorite(ctx.user.id, tool.id) : false;
  const extHelpers = require('./extensions').helpers;
  const reviews = extHelpers.listReviews(ctx.store, tool.id);
  const avgRating = extHelpers.averageRating(ctx.store, tool.id);
  const voteCount = extHelpers.countVotes(ctx.store, tool.id);
  const hasVoted = ctx.user ? extHelpers.hasVoted(ctx.store, tool.id, ctx.user.id) : false;
  const userAlerts = ctx.user ? extHelpers.listAlertsByUser(ctx.store, ctx.user.id).filter(a => a.tool_id === tool.id).map(a => a.type) : [];

  const stars = (n) => '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  const reviewsHtml = reviews.length
    ? '<div class="review-list">' + reviews.map(function(r) { return '<div class="review-item"><div class="review-head"><strong>' + esc(r.user_name) + '</strong> <span class="review-stars">' + stars(r.rating) + '</span> <span class="muted small">' + new Date(r.created_at).toLocaleDateString() + '</span></div><p>' + esc(r.body) + '</p></div>'; }).join('') + '</div>'
    : '<p class="muted">No reviews yet. Be the first!</p>';
  const reviewForm = ctx.user
    ? '<form id="review-form" class="form" style="max-width:520px;margin-top:20px;"><input type="hidden" name="tool_id" value="' + tool.id + '"><input type="hidden" name="_csrf" value="' + ctx.csrf + '"><div class="form-field"><label for="review-rating">Rating</label><input type="hidden" name="rating" id="review-rating" value="5"><div class="star-rating" id="star-widget" data-value="5" role="radiogroup" aria-label="Rating"><button type="button" value="5" aria-label="5 stars" aria-checked="true" role="radio">\u2605</button><button type="button" value="4" aria-label="4 stars" aria-checked="false" role="radio">\u2605</button><button type="button" value="3" aria-label="3 stars" aria-checked="false" role="radio">\u2605</button><button type="button" value="2" aria-label="2 stars" aria-checked="false" role="radio">\u2605</button><button type="button" value="1" aria-label="1 star" aria-checked="false" role="radio">\u2605</button></div><p class="star-hint" id="star-hint">Excellent</p></div><div class="form-field"><label for="review-body">Your review</label><textarea id="review-body" name="body" rows="3" minlength="10" required placeholder="What did you use it for? How was it?"></textarea></div><button class="btn btn-primary" type="submit">Post review</button></form>'
    : '<p class="muted small"><a href="/login">Sign in</a> to write a review.</p>';
  const reviewsSection = (reviews.length || ctx.user)
    ? section('Reviews', reviewsHtml + reviewForm, { id: 'reviews', sub: avgRating ? 'Average: ' + avgRating + '/5 from ' + reviews.length + ' review' + (reviews.length === 1 ? '' : 's') : 'Help others by sharing your experience' })
    : '';

  const body = `
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="/">Home</a> <span aria-hidden="true">/</span>
    <a href="/browse?category=${esc(tool.category)}">${esc(tool.category)}</a> <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(tool.name)}</span>
  </nav>
  <article class="tool-detail">
    <header class="tool-detail-head">
      <div class="tool-detail-id">
        <span class="monogram mono-lg" style="--mc:${esc(tool.logo_color)}" aria-hidden="true">${esc(tool.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>
        <div>
          <h1 class="detail-title">${esc(tool.name)}</h1>
          <p class="detail-tagline">${esc(tool.tagline)}</p>
        </div>
      </div>
      <div class="detail-actions">
        <form class="fav-form" method="post" action="/api/favorites/toggle">
          ${csrfField(ctx.csrf)}
          <input type="hidden" name="tool_id" value="${tool.id}">
          <input type="hidden" name="next" value="/tool/${esc(tool.slug)}">
          <button type="submit" class="btn ${fav ? 'btn-fav' : 'btn-ghost'}" data-fav-btn aria-pressed="${fav ? 'true' : 'false'}">${fav ? '★ Saved' : '☆ Save'}</button>
        </form>
        <a class="btn btn-primary" href="${esc(tool.url)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>
      </div>
    </header>
    <div class="detail-meta">
      <span class="pill">${esc(tool.pricing_model)}</span>
      <span class="pill pill-muted">${esc(tool.category)}</span>
      <span class="muted small">Popularity ${tool.popularity}/100</span>
      <span class="muted small">Last verified ${tool.last_verified_at ? new Date(tool.last_verified_at).toISOString().slice(0, 10) : '—'}</span>
    </div>
    ${section('About', `<p class="detail-desc">${esc(tool.description)}</p>${tool.tags.length ? `<div class="tag-row">${tool.tags.map((t) => `<a class="tag" href="/browse?tag=${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}`, { id: 'about' })}
    ${require('./report-features').pricingCalculator(tool)}
    ${tool.lifecycle_status && tool.lifecycle_status !== 'Active' ? `<p class="flash" style="border-color:var(--danger);background:var(--accent-soft);color:var(--danger);">⚠ This tool is marked as <strong>${esc(tool.lifecycle_status)}</strong>.</p>` : ''}
    ${tool.free_tier_limits ? section('Free tier limits', `<p class="detail-desc">${esc(tool.free_tier_limits)}</p>`, { id: 'free-tier' }) : ''}
    ${tool.editorial_badge ? section('Tested by us', `<p><span class="pill pill-published">✓ Tested</span> ${esc(tool.editorial_badge)}</p>${tool.editorial_notes ? `<p class="muted">${esc(tool.editorial_notes)}</p>` : ''}<p class="muted small">See our <a href="/methodology">testing methodology</a>.</p>`, { id: 'editorial' }) : ''}
    ${reviewsSection}
    ${section('Community', '<div class="community-row"><button class="btn ' + (hasVoted ? 'btn-fav' : 'btn-ghost') + '" id="vote-btn" data-tool-id="' + tool.id + '" data-csrf="' + (ctx.csrf || '') + '">' + (hasVoted ? '\u2713 I use this daily' : 'I use this daily') + ' (' + voteCount + ')</button>' + (ctx.user ? '<button class="btn btn-ghost" id="alert-btn" data-tool-id="' + tool.id + '" data-csrf="' + ctx.csrf + '">' + (userAlerts.includes('price_change') ? '\u2713 Alerting' : '\u2606 Alert on price change') + '</button>' : '') + '</div>', { id: 'community' })}
    ${section('Related tools', recs.length ? `<div class="tool-grid">${recs.map((r) => toolCard(r.tool)).join('')}</div>${recs.map((r) => reasonChips(r.reasons)).join('')}` : '<p class="muted">No related tools yet.</p>', { sub: 'Recommended by category, tags, popularity, and recency' })}
    ${sameCat.length ? section(`More in ${esc(tool.category)}`, `<div class="tool-grid">${sameCat.map((t) => toolCard(t)).join('')}</div>`) : ''}
  </article>`;

  return page(ctx, `${tool.name} — ${tool.tagline}`, body, {
    description: tool.tagline + ' ' + tool.description.slice(0, 140),
    canonical: `${BASE_URL}/tool/${tool.slug}`,
    jsonLd: toolJsonLd(tool),
    og: { type: 'website' },
  });
}

/* ---------------- auth ---------------- */
function loginForm(ctx, error = '', values = {}) {
  const c = anonCsrfCookies(ctx);
  const body = `
  <div class="auth-card">
    <h1 class="page-title">Sign in</h1>
    <p class="page-sub">Access your dashboard and favorites.</p>
    ${error ? `<p class="flash flash-error" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/login" class="form">
      ${csrfField(ctx.anonCsrf || c.cookies[0].value)}
      <div class="form-field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="${esc(values.email || '')}"></div>
      <div class="form-field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" minlength="8"></div>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <p class="muted small">New here? <a href="/register">Create an account</a></p>
  </div>`;
  return { ...page(ctx, `Sign in — ${SITE_NAME}`, body, { description: 'Sign in to your account.' }), cookies: c.cookies };
}

async function loginGet(ctx) {
  if (ctx.user) return redirect('/dashboard');
  return loginForm(ctx);
}

async function loginPost(ctx) {
  const email = String(ctx.body.email || '').trim();
  const password = String(ctx.body.password || '');
  const next = typeof ctx.body.next === 'string' && ctx.body.next.startsWith('/') ? ctx.body.next : '/dashboard';
  const ipLimit = rateLimit('login:' + ctx.ip, 10, 15 * 60 * 1000);
  if (!ipLimit.ok) return loginForm(ctx, 'Too many attempts. Please wait a few minutes.', { email });
  const emailLimit = rateLimit('login-email:' + email.toLowerCase(), 10, 15 * 60 * 1000);
  if (!emailLimit.ok) return loginForm(ctx, 'Too many attempts for this account. Try again later.', { email });

  const user = ctx.store.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return loginForm(ctx, 'Invalid email or password.', { email });
  }
  const token = ctx.store.createSession(user.id, SESSION_TTL_MS);
  recordEvent(ctx, 'login');
  return {
    redirect: next,
    cookies: [
      { name: 'sid', value: token, httpOnly: true, maxAge: Math.floor(SESSION_TTL_MS / 1000) },
      { name: 'csrf', value: '', maxAge: 0 },
    ],
  };
}

function registerForm(ctx, error = '', values = {}, errors = {}) {
  const c = anonCsrfCookies(ctx);
  const body = `
  <div class="auth-card">
    <h1 class="page-title">Create account</h1>
    <p class="page-sub">Save favorites and get personalized recommendations.</p>
    ${error ? `<p class="flash flash-error" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/register" class="form" novalidate>
      ${csrfField(ctx.anonCsrf || c.cookies[0].value)}
      <div class="form-field"><label for="name">Name</label><input id="name" name="name" type="text" required autocomplete="name" value="${esc(values.name || '')}">${fieldError(errors, 'name')}</div>
      <div class="form-field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="${esc(values.email || '')}">${fieldError(errors, 'email')}</div>
      <div class="form-field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="new-password" minlength="8" aria-describedby="pw-hint"><p id="pw-hint" class="muted small">At least 8 characters.</p>${fieldError(errors, 'password')}</div>
      <div class="form-field"><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required autocomplete="new-password">${fieldError(errors, 'confirm')}</div>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
    <p class="muted small">Already have an account? <a href="/login">Sign in</a></p>
  </div>`;
  return { ...page(ctx, `Create account — ${SITE_NAME}`, body, { description: 'Join the directory to save tools.' }), cookies: c.cookies };
}

async function registerGet(ctx) {
  if (ctx.user) return redirect('/dashboard');
  return registerForm(ctx);
}

async function registerPost(ctx) {
  const values = { name: String(ctx.body.name || '').trim(), email: String(ctx.body.email || '').trim() };
  const errors = {};
  const ipLimit = rateLimit('reg:' + ctx.ip, 5, 60 * 60 * 1000);
  if (!ipLimit.ok) return registerForm(ctx, 'Too many sign-ups from this address. Try again later.', values);
  if (!values.name || values.name.length < 2) errors.name = 'Please enter your name.';
  if (!validateEmail(values.email)) errors.email = 'Enter a valid email address.';
  if (ctx.store.getUserByEmail(values.email)) errors.email = 'An account with this email already exists.';
  if (!validatePassword(String(ctx.body.password || ''))) errors.password = 'Password must be at least 8 characters.';
  if (ctx.body.password !== ctx.body.confirm) errors.confirm = 'Passwords do not match.';
  if (Object.keys(errors).length) return registerForm(ctx, 'Please fix the issues below.', values, errors);

  const salt = makeSalt();
  const user = ctx.store.createUser({
    email: values.email, name: values.name,
    passwordHash: hashPassword(ctx.body.password, salt), salt,
  });
  const token = ctx.store.createSession(user.id, SESSION_TTL_MS);
  recordEvent(ctx, 'register');
  return {
    redirect: '/dashboard',
    cookies: [
      { name: 'sid', value: token, httpOnly: true, maxAge: Math.floor(SESSION_TTL_MS / 1000) },
      { name: 'csrf', value: '', maxAge: 0 },
    ],
  };
}

async function logoutPost(ctx) {
  if (ctx.sid) ctx.store.deleteSession(require('./auth').hashToken(ctx.sid));
  recordEvent(ctx, 'logout');
  return { redirect: '/', cookies: [{ name: 'sid', value: '', maxAge: 0 }] };
}

/* ---------------- dashboard ---------------- */
async function dashboard(ctx) {
  const r = requireUser(ctx); if (r) return r;
  const favs = ctx.store.listFavorites(ctx.user.id);
  const views = ctx.store.recentViews(ctx.user.id, 6);
  const events = ctx.store.listEventsByUser(ctx.user.id, 15);
  const all = ctx.store.listTools({ limit: 1000 });
  const recs = forUser(favs, views, all, 6);
  const viewCount = events.filter((e) => e.type === 'view').length;
  const topCats = new Map();
  for (const f of favs) topCats.set(f.category, (topCats.get(f.category) || 0) + 1);
  const topCatsArr = [...topCats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const activityRows = events.length ? events.map((e) => {
    const label = e.type === 'save' ? 'Saved' : e.type === 'unsave' ? 'Removed' : e.type === 'view' ? 'Viewed' : e.type === 'register' ? 'Joined' : e.type === 'login' ? 'Signed in' : e.type === 'logout' ? 'Signed out' : e.type;
    const what = e.tool_slug ? `<a href="/tool/${esc(e.tool_slug)}">${esc(e.tool_name)}</a>` : '';
    return `<li class="activity-row"><span class="activity-type">${label}</span> ${what}<span class="muted small">${new Date(e.created_at).toLocaleString()}</span></li>`;
  }).join('') : '<li class="muted">No activity yet — browse a few tools to get started.</li>';

  const body = `
  <div class="page-head">
    <p class="eyebrow">Your space</p>
    <h1 class="page-title">Dashboard</h1>
    <p class="page-sub">Welcome back, ${esc(ctx.user.name)}.</p>
  </div>
  <div class="stat-row">
    <div class="stat"><span class="stat-num" data-count="${favs.length}">${favs.length}</span><span class="stat-label">Saved tools</span></div>
    <div class="stat"><span class="stat-num" data-count="${viewCount}">${viewCount}</span><span class="stat-label">Tools viewed</span></div>
    <div class="stat"><span class="stat-num" data-count="${topCatsArr.length}">${topCatsArr.length}</span><span class="stat-label">Categories explored</span></div>
    <div class="stat"><span class="stat-num">${new Date(ctx.user.created_at).toLocaleDateString()}</span><span class="stat-label">Member since</span></div>
  </div>
  ${section('Recommended for you', `<div class="tool-grid">${recs.items.map((t) => toolCard(t.tool, { fav: ctx.store.isFavorite(ctx.user.id, t.tool.id) })).join('')}</div><p class="section-sub">${esc(recs.basis)}</p>`, { id: 'recommended' })}
  ${section('Your favorites', favs.length ? `<div class="tool-grid">${favs.map((t) => toolCard(t, { fav: true })).join('')}</div>` : '<div class="empty-state"><h3>No favorites yet</h3><p>Tap the save button on any tool to keep it here.</p><a class="btn" href="/browse">Browse tools</a></div>', { id: 'favorites' })}
  ${topCatsArr.length ? section('Your top categories', `<div class="mini-chart-wrap"><div data-mini-chart class="mini-chart">${topCatsArr.map(([c, n]) => `<div class="mini-bar" data-value="${n}"><span class="mini-tip">${esc(c)}: ${n} tools</span><div class="mini-bar-fill" data-height="${Math.min(100, n * 25)}"></div><span class="mini-bar-label">${esc(c)}</span></div>`).join('')}</div></div><div class="chip-row">${topCatsArr.map(([c, n]) => `<a class="chip" href="/browse?category=${esc(c)}">${esc(c)} · ${n}</a>`).join('')}</div>`) : ''}
  ${section('Recent activity', `<ul class="activity-list">${activityRows}</ul>`, { id: 'activity' })}
  `;
  return page(ctx, `Dashboard — ${SITE_NAME}`, body, { description: 'Your saved tools and activity.', activeNav: 'dashboard' });
}

/* ---------------- admin ---------------- */
async function adminOverview(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const s = ctx.store.stats();
  const recent = ctx.store.listHistory(10);
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Overview</h1></div>
  <div class="stat-row">
    <div class="stat"><span class="stat-num">${s.published}</span><span class="stat-label">Published</span></div>
    <div class="stat"><span class="stat-num">${s.drafts}</span><span class="stat-label">Drafts</span></div>
    <div class="stat"><span class="stat-num">${s.archived}</span><span class="stat-label">Archived</span></div>
    <div class="stat"><span class="stat-num">${s.users}</span><span class="stat-label">Users</span></div>
    <div class="stat"><span class="stat-num">${s.favorites}</span><span class="stat-label">Favorites</span></div>
    <div class="stat"><span class="stat-num">${s.events}</span><span class="stat-label">Events</span></div>
  </div>
  <div class="admin-nav"><a class="btn" href="/admin/tools">Manage tools</a><a class="btn btn-ghost" href="/admin/tools/new">+ Add tool</a><a class="btn btn-ghost" href="/admin/import">CSV import</a><a class="btn btn-ghost" href="/admin/tests">Test results</a><a class="btn btn-ghost" href="/admin/compliance">Compliance</a><a class="btn btn-ghost" href="/admin/newsletter">Newsletter</a><a class="btn btn-ghost" href="/admin/history">Change history</a></div>
  ${section('Latest changes', `<ul class="activity-list">${recent.map((h) => `<li class="activity-row"><span class="activity-type">${esc(h.action)}</span> ${esc(h.tool_name || '(deleted)')} <span class="muted small">by ${esc(h.actor_email || 'system')} · ${new Date(h.created_at).toLocaleString()}</span></li>`).join('')}</ul>`)}
  `;
  return page(ctx, `Admin — ${SITE_NAME}`, body, { description: 'Admin overview.', activeNav: 'admin' });
}

const TOOL_FIELDS = ['name', 'tagline', 'description', 'category', 'url', 'pricing_model', 'tags', 'popularity', 'logo_color', 'status'];

function toolForm(ctx, tool, { errors = {}, isNew = true } = {}) {
  const cats = [...new Set([...(ctx.store.categories().map((c) => c.name)), ...Object.keys(CATEGORY_DESC)])].sort();
  const v = (k) => tool ? (k === 'tags' ? (tool.tags || []).join(', ') : tool[k] ?? '') : (k === 'status' ? 'draft' : '');
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">${isNew ? 'Add tool' : `Edit: ${esc(tool.name)}`}</h1></div>
  ${Object.keys(errors).length ? `<p class="flash flash-error" role="alert">Please fix the issues below.</p>` : ''}
  <form method="post" action="${isNew ? '/admin/tools/new' : `/admin/tools/${tool.id}/edit`}" class="form form-wide">
    ${csrfField(ctx.csrf)}
    <div class="form-grid">
      <div class="form-field"><label for="name">Name *</label><input id="name" name="name" required value="${esc(v('name'))}">${fieldError(errors, 'name')}</div>
      <div class="form-field"><label for="category">Category *</label><select id="category" name="category" required><option value="">— choose —</option>${cats.map((c) => `<option${tool && tool.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>${fieldError(errors, 'category')}</div>
      <div class="form-field"><label for="url">Website URL *</label><input id="url" name="url" type="url" required placeholder="https://" value="${esc(v('url'))}">${fieldError(errors, 'url')}</div>
      <div class="form-field"><label for="pricing_model">Pricing</label><select id="pricing_model" name="pricing_model">${PRICING.map((p) => `<option${tool && tool.pricing_model === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="form-field form-wide"><label for="tagline">Tagline *</label><input id="tagline" name="tagline" required maxlength="120" value="${esc(v('tagline'))}">${fieldError(errors, 'tagline')}</div>
      <div class="form-field form-wide"><label for="description">Description *</label><textarea id="description" name="description" required rows="5">${esc(v('description'))}</textarea>${fieldError(errors, 'description')}</div>
      <div class="form-field"><label for="tags">Tags (comma separated)</label><input id="tags" name="tags" placeholder="chat, writing, api" value="${esc(v('tags'))}"></div>
      <div class="form-field"><label for="popularity">Popularity (0–100)</label><input id="popularity" name="popularity" type="number" min="0" max="100" value="${esc(v('popularity'))}"></div>
      <div class="form-field"><label for="logo_color">Mark color</label><input id="logo_color" name="logo_color" type="color" value="${esc(v('logo_color') || '#C05621')}"></div>
      <div class="form-field"><label for="status">Status</label><select id="status" name="status">${['draft', 'published', 'archived'].map((s) => `<option${tool && tool.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">${isNew ? 'Create tool' : 'Save changes'}</button><a class="btn btn-ghost" href="/admin/tools">Cancel</a></div>
  </form>`;
  return page(ctx, `${isNew ? 'Add tool' : 'Edit tool'} — ${SITE_NAME}`, body, { description: 'Admin tool editor.', activeNav: 'admin' });
}

function parseToolForm(ctx, errors) {
  const data = {
    name: String(ctx.body.name || '').trim(),
    tagline: String(ctx.body.tagline || '').trim(),
    description: String(ctx.body.description || '').trim(),
    category: String(ctx.body.category || '').trim(),
    url: String(ctx.body.url || '').trim(),
    pricing_model: String(ctx.body.pricing_model || 'Freemium'),
    tags: String(ctx.body.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10),
    popularity: Math.max(0, Math.min(100, parseInt(ctx.body.popularity, 10) || 0)),
    logo_color: /^#[0-9a-fA-F]{6}$/.test(ctx.body.logo_color || '') ? ctx.body.logo_color : '#C05621',
    status: ['draft', 'published', 'archived'].includes(ctx.body.status) ? ctx.body.status : 'draft',
  };
  if (!data.name) errors.name = 'Name is required.';
  if (!data.tagline) errors.tagline = 'Tagline is required.';
  if (data.description.length < 20) errors.description = 'Description must be at least 20 characters.';
  if (!data.category) errors.category = 'Category is required.';
  try { const u = new URL(data.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { errors.url = 'Enter a valid http(s) URL.'; }
  return data;
}

async function adminTools(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const tools = ctx.store.listTools({ status: null, sort: 'updated', limit: 500 });
  const rows = tools.map((t) => `<tr>
    <td><a href="/tool/${esc(t.slug)}">${esc(t.name)}</a></td>
    <td>${esc(t.category)}</td>
    <td><span class="pill pill-${esc(t.status)}">${esc(t.status)}</span></td>
    <td class="muted">${t.last_verified_at ? new Date(t.last_verified_at).toISOString().slice(0, 10) : '—'}</td>
    <td class="table-actions">
      <a class="btn btn-ghost btn-sm" href="/admin/tools/${t.id}/edit">Edit</a>
      <form method="post" action="/admin/tools/${t.id}/action" class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="${t.status === 'published' ? 'unpublish' : 'publish'}"><button class="btn btn-ghost btn-sm" type="submit">${t.status === 'published' ? 'Unpublish' : 'Publish'}</button></form>
      <form method="post" action="/admin/tools/${t.id}/action" class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="verify"><button class="btn btn-ghost btn-sm" type="submit">Verify</button></form>
      <form method="post" action="/admin/tools/${t.id}/action" class="inline-form" data-confirm="Delete ${esc(t.name)}? This cannot be undone.">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="delete"><button class="btn btn-danger btn-sm" type="submit">Delete</button></form>
    </td>
  </tr>`).join('');
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Tools</h1><p class="page-sub">${tools.length} listings.</p></div>
  ${flash(ctx.query.msg)}
  <div class="admin-nav"><a class="btn" href="/admin/tools/new">+ Add tool</a><a class="btn btn-ghost" href="/admin/history">Change history</a></div>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Tool</th><th>Category</th><th>Status</th><th>Last verified</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  return page(ctx, `Manage tools — ${SITE_NAME}`, body, { description: 'Admin tool management.', activeNav: 'admin' });
}

async function adminToolNew(ctx) { const r = requireAdmin(ctx); if (r) return r; return toolForm(ctx, null, {}); }

async function adminToolNewPost(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const errors = {};
  const data = parseToolForm(ctx, errors);
  if (Object.keys(errors).length) return toolForm(ctx, { ...data, tags: data.tags }, { errors, isNew: true });
  let slug = slugify(data.name);
  let n = 1;
  while (ctx.store.getToolBySlug(slug)) slug = `${slugify(data.name)}-${++n}`;
  data.slug = slug;
  const id = ctx.store.createTool(data);
  ctx.store.addHistory({ toolId: id, actorId: ctx.user.id, action: 'create', newValue: data.name });
  return redirect('/admin/tools?msg=' + encodeURIComponent(`Created “${data.name}” as ${data.status}.`));
}

async function adminToolEdit(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const tool = ctx.store.getToolById(parseInt(ctx.params.id, 10));
  if (!tool) throw new HttpError(404, 'Tool not found');
  return toolForm(ctx, tool, { isNew: false });
}

async function adminToolEditPost(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const tool = ctx.store.getToolById(parseInt(ctx.params.id, 10));
  if (!tool) throw new HttpError(404, 'Tool not found');
  const errors = {};
  const data = parseToolForm(ctx, errors);
  if (Object.keys(errors).length) return toolForm(ctx, { ...tool, ...data }, { errors, isNew: false });

  const changes = {};
  if (data.name !== tool.name) changes.name = data.name;
  if (data.tagline !== tool.tagline) changes.tagline = data.tagline;
  if (data.description !== tool.description) changes.description = data.description;
  if (data.category !== tool.category) changes.category = data.category;
  if (data.url !== tool.url) changes.url = data.url;
  if (data.pricing_model !== tool.pricing_model) changes.pricing_model = data.pricing_model;
  if (JSON.stringify(data.tags) !== JSON.stringify(tool.tags)) changes.tags = JSON.stringify(data.tags);
  if (data.popularity !== tool.popularity) changes.popularity = data.popularity;
  if (data.logo_color !== tool.logo_color) changes.logo_color = data.logo_color;
  if (data.status !== tool.status) changes.status = data.status;

  if (Object.keys(changes).length) {
    ctx.store.updateTool(tool.id, changes);
    for (const [field, newValue] of Object.entries(changes)) {
      ctx.store.addHistory({ toolId: tool.id, actorId: ctx.user.id, action: 'update', field, oldValue: String(tool[field] ?? ''), newValue: String(newValue) });
    }
  }
  return redirect('/admin/tools?msg=' + encodeURIComponent(`Saved ${Object.keys(changes).length} change(s) to “${data.name}”.`));
}

async function adminToolAction(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const tool = ctx.store.getToolById(parseInt(ctx.params.id, 10));
  if (!tool) throw new HttpError(404, 'Tool not found');
  const action = ctx.body.action;
  if (action === 'publish') { ctx.store.setToolStatus(tool.id, 'published'); ctx.store.addHistory({ toolId: tool.id, actorId: ctx.user.id, action: 'publish', oldValue: tool.status, newValue: 'published' }); }
  else if (action === 'unpublish') { ctx.store.setToolStatus(tool.id, 'draft'); ctx.store.addHistory({ toolId: tool.id, actorId: ctx.user.id, action: 'unpublish', oldValue: tool.status, newValue: 'draft' }); }
  else if (action === 'verify') { ctx.store.updateTool(tool.id, { last_verified_at: new Date().toISOString() }); ctx.store.addHistory({ toolId: tool.id, actorId: ctx.user.id, action: 'verify', newValue: 'verified' }); }
  else if (action === 'delete') { ctx.store.deleteTool(tool.id); ctx.store.addHistory({ toolId: tool.id, actorId: ctx.user.id, action: 'delete', oldValue: tool.name }); }
  else throw new HttpError(400, 'Unknown action');
  return redirect('/admin/tools?msg=' + encodeURIComponent(`${action} “${tool.name}”.`));
}

async function adminHistory(ctx) {
  const r = requireAdmin(ctx); if (r) return r;
  const rows = ctx.store.listHistory(300);
  const body = `
  <div class="page-head"><p class="eyebrow">Admin</p><h1 class="page-title">Change history</h1><p class="page-sub">Every listing change, with actor and timestamp.</p></div>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Tool</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
    <tbody>${rows.map((h) => `<tr><td class="muted">${new Date(h.created_at).toLocaleString()}</td><td>${esc(h.actor_email || 'system')}</td><td><span class="pill pill-${esc(h.action)}">${esc(h.action)}</span></td><td>${esc(h.tool_name || '(deleted)')}</td><td class="muted">${esc(h.field || '—')}</td><td class="muted small">${esc(String(h.old_value || '—').slice(0, 60))}</td><td class="muted small">${esc(String(h.new_value || '—').slice(0, 60))}</td></tr>`).join('')}</tbody>
  </table></div>`;
  return page(ctx, `Change history — ${SITE_NAME}`, body, { description: 'Admin change history.', activeNav: 'admin' });
}

/* ---------------- API ---------------- */
async function apiFavoriteToggle(ctx) {
  if (!ctx.user) {
    if (String(ctx.headers.accept || '').includes('application/json')) return { json: { error: 'auth_required' }, status: 401 };
    return redirect('/login?next=' + encodeURIComponent(ctx.body.next || '/'));
  }
  const toolId = parseInt(ctx.body.tool_id, 10);
  const tool = ctx.store.getToolById(toolId);
  if (!tool) return { json: { error: 'not_found' }, status: 404 };
  const wasFav = ctx.store.isFavorite(ctx.user.id, toolId);
  if (wasFav) { ctx.store.removeFavorite(ctx.user.id, toolId); recordEvent(ctx, 'unsave', toolId); }
  else { ctx.store.addFavorite(ctx.user.id, toolId); recordEvent(ctx, 'save', toolId); }
  const saved = !wasFav;
  if (String(ctx.headers.accept || '').includes('application/json')) {
    return { json: { saved, count: ctx.store.countFavorites(ctx.user.id) } };
  }
  return redirect(ctx.body.next || '/dashboard');
}

async function apiEventView(ctx) {
  const toolId = parseInt(ctx.body.tool_id, 10);
  if (ctx.user && ctx.store.getToolById(toolId)) recordEvent(ctx, 'view', toolId);
  return { json: { ok: true } };
}

async function apiTools(ctx) {
  const q = String(ctx.query.q || '').trim();
  if (!q) return { json: [] };
  const tools = ctx.store.listTools({ q, limit: 10 });
  return { json: tools.map((t) => ({ slug: t.slug, name: t.name, tagline: t.tagline, category: t.category, pricing_model: t.pricing_model })) };
}

/* ---------------- random tool ---------------- */
async function randomTool(ctx) {
  const tools = ctx.store.listTools({ limit: 1000 });
  if (!tools.length) return { json: { error: 'No tools' } };
  const pick = tools[Math.floor(Math.random() * tools.length)];
  return { json: { slug: pick.slug, name: pick.name, category: pick.category } };
}

/* ---------------- compare ---------------- */

/* ---------------- compare ---------------- */
async function comparePage(ctx) {
  // Read selected slugs from query params (?slugs=slug1,slug2,...) or from cookie/localStorage via query
  const slugsParam = String(ctx.query.slugs || '');
  const slugs = slugsParam ? slugsParam.split(',').filter(Boolean) : [];
  const tools = slugs.map(s => ctx.store.getToolBySlug(s)).filter(Boolean);
  const allTools = ctx.store.listTools({ limit: 1000 });

  let body;
  if (tools.length < 2) {
    body = `
    <div class="page-head">
      <p class="eyebrow">Compare</p>
      <h1 class="page-title">Compare AI Tools</h1>
      <p class="page-sub">Select 2–5 tools from anywhere on the site, then come here to compare them side by side.</p>
    </div>
    <div class="compare-empty">
      <h3 style="font-family:var(--serif);font-size:1.3rem;margin-bottom:8px;">No tools selected yet</h3>
      <p class="muted" style="margin-bottom:20px;">Use the “Compare” checkbox on any tool card to add it here.</p>
      <a class="btn btn-primary" href="/browse">Browse tools →</a>
    </div>`;
  } else {
    const rows = [
      ['Category', 'category'],
      ['Pricing', 'pricing_model'],
      ['Tags', 'tags'],
      ['Popularity', 'popularity'],
      ['Last verified', 'last_verified_at'],
    ];
    body = `
    <div class="page-head">
      <p class="eyebrow">Compare</p>
      <h1 class="page-title">Side-by-side comparison</h1>
      <p class="page-sub">${tools.length} tool${tools.length === 1 ? '' : 's'} selected.</p>
    </div>
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th>Tool</th>
            ${tools.map(t => `<th class="compare-tool-name"><a href="/tool/${esc(t.slug)}">${esc(t.name)}</a><br><button class="compare-remove" data-slug="${esc(t.slug)}">Remove</button></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr><th>Tagline</th>${tools.map(t => `<td>${esc(t.tagline)}</td>`).join('')}</tr>
          ${rows.map(([label, field]) => `<tr><th>${esc(label)}</th>${tools.map(t => {
            let val = t[field];
            if (field === 'tags') val = (t.tags || []).join(', ') || '—';
            if (field === 'last_verified_at') val = t.last_verified_at ? new Date(t.last_verified_at).toISOString().slice(0,10) : '—';
            if (field === 'popularity') val = t.popularity + '/100';
            return `<td>${esc(String(val))}</td>`;
          }).join('')}</tr>`).join('')}
          <tr><th>Website</th>${tools.map(t => `<td><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Visit ↗</a></td>`).join('')}</tr>
        </tbody>
      </table>
    </div>
    </div>
    <div class="compare-actions" style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap;">
      <a class="btn" href="/browse">← Back to browse</a>
      <a class="btn btn-primary" href="/compare/pdf?ids=${tools.map(t => t.id).join(',')}" target="_blank" rel="noopener">📄 Export as PDF</a>
    </div>`;
  }
  return page(ctx, `Compare — ${SITE_NAME}`, body, { description: 'Compare AI tools side by side.', activeNav: 'compare' });
}

/* ---------------- infra ---------------- */
async function healthz(ctx) {
  return { json: { ok: true, storage: ctx.store.kind(), published: ctx.store.stats().published, time: new Date().toISOString() } };
}

async function sitemap(ctx) {
  const tools = ctx.store.listTools({ limit: 10000 });
  const urls = ['', '/browse', '/categories', '/dashboard', '/login', '/register'].map((p) => `${BASE_URL}${p}`);
  for (const t of tools) urls.push(`${BASE_URL}/tool/${t.slug}`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>`;
  return { html: body, contentType: 'application/xml' };
}

async function robots(ctx) {
  return { html: `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n` };
}

module.exports = {
  configure, home, browse, categoriesPage, categoryPage, toolDetail,
  loginGet, loginPost, registerGet, registerPost, logoutPost, dashboard,
  adminOverview, adminTools, adminToolNew, adminToolNewPost, adminToolEdit, adminToolEditPost, adminToolAction, adminHistory,
  apiFavoriteToggle, apiEventView, apiTools, randomTool, healthz, sitemap, robots,
  comparePage,
};

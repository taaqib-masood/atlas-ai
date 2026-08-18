'use strict';
/**
 * SSR helpers: escaping, document layout (11 Build luxury minimalism — Enhanced),
 * and reusable UI components. Now includes theme toggle, command palette hint,
 * hero mesh, and compare nav.
 */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SITE_NAME = 'Atlas AI';
const SITE_TAGLINE = 'The AI tools you need, curated.';

function monogram(name, color) {
  const letters = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return `<span class="monogram" style="--mc:${esc(color)}" aria-hidden="true">${esc(letters)}</span>`;
}

function layout({ title, description, user, activeNav, body, canonical, jsonLd, extraHead = '', og = {} }) {
  const nav = [
    ['/', 'Browse', 'browse'],
    ['/categories', 'Categories', 'categories'],
    ['/deals', 'Deals', 'deals'],
    ['/compare', 'Compare', 'compare'],
    ['/pricing', 'Pricing', 'pricing'],
    ['/dashboard', 'Dashboard', 'dashboard'],
    ['/stacks', 'Stacks', 'stacks'],
  ];
  const isAdmin = user && user.role === 'admin';
  const navHtml = nav.map(([href, label, key]) =>
    `<a href="${href}"${activeNav === key ? ' class="nav-link active" aria-current="page"' : ' class="nav-link"'}>${label}</a>`).join('');
  const adminLink = isAdmin ? `<a href="/admin" class="nav-link${activeNav === 'admin' ? ' active' : ''}">Admin</a>` : '';
  const themeToggle = `<button class="theme-toggle" aria-label="Toggle dark mode" type="button"><svg class="moon-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><svg class="sun-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>`;
  const cmdkHint = `<span class="cmdk-hint" role="button" tabindex="0" aria-label="Open command palette"><kbd>⌘K</kbd></span>`;
  const authArea = user
    ? `<span class="nav-user">${esc(user.name)}</span>${cmdkHint}${themeToggle}<a href="/dashboard" class="btn btn-ghost btn-sm">Dashboard</a><form method="post" action="/logout" class="inline-form">${csrfField(user.csrf)}<button type="submit" class="btn btn-ghost btn-sm">Sign out</button></form>`
    : `${cmdkHint}${themeToggle}<a href="/login" class="btn btn-ghost btn-sm">Sign in</a><a href="/register" class="btn btn-primary btn-sm">Join</a>`;

  const metaDesc = description || SITE_TAGLINE;
  const canonicalHref = canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '';
  const ogTags = og.image ? `<meta property="og:image" content="${esc(og.image)}">` : '';
  const json = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:type" content="${og.type || 'website'}">
<meta name="theme-color" content="#000000">
${user ? `<meta name="csrf-token" content="${esc(user.csrf)}">` : ''}
${ogTags}
${canonicalHref}
<meta name="robots" content="index,follow">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/favicon-180.png">
<link rel="manifest" href="/manifest.json">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/assets/app.css?v=20260817b">
<script>try{const t=localStorage.getItem('atlas-theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-theme','dark');}catch(e){}</script>
${extraHead}
${json}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="/" aria-label="${SITE_NAME} — home">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">${SITE_NAME}</span>
    </a>
    <nav class="nav" aria-label="Primary">
      ${navHtml}${adminLink}
    </nav>
    <div class="nav-auth">${authArea}</div>
  </div>
</header>
<main id="main" class="container">${body}</main>
<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <p>${SITE_NAME} — ${SITE_TAGLINE}</p>
      <p class="muted small">Catalog is editor-curated. Listings are informational; always verify on the official site.</p>
    </div>
    <nav class="footer-nav" aria-label="Footer">
      <a href="/tasks">Task search</a> · <a href="/deals">Deals</a> · <a href="/new">New tools</a> · <a href="/student">Student hub</a> · <a href="/ranking">Ranking formula</a> · <a href="/newsletter">Newsletter</a> · <a href="/pricing">Pricing</a> · <a href="/api/docs">API</a> · <a href="/trust">Trust</a> · <a href="/methodology">Methodology</a> · <a href="/maker">Maker portal</a> · <a href="/stacks">Stacks</a> · <a href="/widget.js">Embed widget</a>
    </nav>
  </div>
</footer>
<script src="/assets/app.js?v=20260817b" defer></script>
<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})});}</script>
</body>
</html>`;
}

/* Trust metadata — badge state class per status token (monochrome only). */
function trustStatusToken(value) {
  const s = String(value || 'Unverified');
  if (s === 'Verified' || s === 'Available') return 'verified';
  if (s === 'N/A' || s === 'N-A') return 'na';
  return 'unverified';
}

function trustBadge(status, label) {
  const cls = trustStatusToken(status);
  const word = cls === 'verified' ? 'Verified' : cls === 'na' ? 'N/A' : 'Unverified';
  const title = `${label}: ${word}`;
  const glyph = cls === 'verified' ? '✓' : cls === 'na' ? 'N/A' : '—';
  return `<span class="trust-badge trust-${cls}" title="${title}" aria-label="${title}">${glyph} ${label}</span>`;
}

function trustBadges(tool) {
  return [
    ['commercial_use_status', 'Commercial'],
    ['data_privacy_status', 'Privacy'],
    ['api_availability_status', 'API'],
  ].map(([key, label]) => trustBadge(tool[key], label)).join('');
}

/* Detail-page trust section (published tools only). Mirrors the "Tested by
   us" editorial pattern: statuses + source + last verified + notes. */
function trustDetailHtml(tool) {
  const fmtDate = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? esc(String(v)) : d.toISOString().slice(0, 10);
  };
  const statusWord = (v) => {
    const cls = trustStatusToken(v);
    return cls === 'verified' ? 'Verified' : cls === 'na' ? 'N/A' : 'Unverified';
  };
  const source = String(tool.verification_source || '');
  const sourceHtml = /^https?:\/\//.test(source)
    ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a>`
    : (source ? esc(source) : '—');
  const notes = String(tool.notes || '');
  const rows = [
    ['Commercial use', statusWord(tool.commercial_use_status)],
    ['Data privacy', statusWord(tool.data_privacy_status)],
    ['API availability', statusWord(tool.api_availability_status)],
    ['Verification source', sourceHtml],
    ['Last verified', fmtDate(tool.last_verified_at || tool.last_verified)],
  ];
  if (notes) rows.push(['Notes', esc(notes)]);
  return `<div class="trust-detail">${rows.map(([dt, dd]) => `<div class="trust-detail-row"><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`).join('')}</div>`;
}

function toolCard(tool, { showMeta = true, fav = false } = {}) {
  return `<article class="tool-card" data-category="${esc(tool.category)}" data-name="${esc(tool.name.toLowerCase())}" data-tags="${esc((tool.tags || []).join(' ').toLowerCase())}" data-commercial="${trustStatusToken(tool.commercial_use_status)}" data-privacy="${trustStatusToken(tool.data_privacy_status)}" data-api="${trustStatusToken(tool.api_availability_status)}">
  <a class="tool-card-link" href="/tool/${esc(tool.slug)}">
    ${monogram(tool.name, tool.logo_color)}
    <div class="tool-card-body">
      <h3 class="tool-card-name">${esc(tool.name)}</h3>
      <p class="tool-card-tagline">${esc(tool.tagline)}</p>
      ${showMeta ? `<div class="tool-card-meta">
        <span class="pill">${esc(tool.pricing_model)}</span>
        <span class="muted small">${esc(tool.category)}</span>
      </div>
      <div class="tool-card-trust" aria-label="Trust metadata">${trustBadges(tool)}</div>` : ''}
    </div>
  </a>
  <button type="button" class="fav-btn${fav ? ' is-fav' : ''}" data-fav data-tool-id="${tool.id}" data-slug="${esc(tool.slug)}"
    aria-pressed="${fav ? 'true' : 'false'}" aria-label="${fav ? 'Remove' : 'Save'} ${esc(tool.name)} from favorites">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.6 2.6 5 6 5c2 0 3.4 1.1 4 2.4h4c.6-1.3 2-2.4 4-2.4 3.4 0 5.6 3.6 4 6.7C19.5 16.4 12 21 12 21z"/></svg>
  </button>
</article>`;
}

function categoryGrid(categories) {
  if (!categories.length) return '<p class="muted">No categories yet.</p>';
  return `<div class="category-grid">${categories.map((c) => `
    <a class="category-card" href="/category/${esc(c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))}">
      <span class="category-name">${esc(c.name)}</span>
      <span class="muted small">${c.count} tool${c.count === 1 ? '' : 's'}</span>
    </a>`).join('')}</div>`;
}

function reasonChips(reasons) {
  if (!reasons || !reasons.length) return '';
  return `<div class="reason-chips"><span class="reason-label">Why:</span>${reasons.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>`;
}

function section(title, content, { sub, id } = {}) {
  return `<section class="section"${id ? ` id="${esc(id)}"` : ''}>
    <div class="section-head">
      <h2 class="section-title">${esc(title)}</h2>
      ${sub ? `<p class="section-sub">${esc(sub)}</p>` : ''}
    </div>
    ${content}
  </section>`;
}

function pagination(page, totalPages, base) {
  if (totalPages <= 1) return '';
  const links = [];
  for (let p = 1; p <= totalPages; p++) {
    if (totalPages > 9 && p > 2 && p < totalPages - 1 && Math.abs(p - page) > 1) {
      if (links[links.length - 1] !== '…') links.push('…');
      continue;
    }
    const sep = base.includes('?') ? '&' : '?';
    links.push(`<a class="page-link${p === page ? ' active' : ''}" href="${esc(base)}${sep}page=${p}">${p}</a>`);
  }
  return `<nav class="pagination" aria-label="Pagination">${links.join('')}</nav>`;
}

function flash(msg) { return msg ? `<p class="flash" role="status">${esc(msg)}</p>` : ''; }

function csrfField(token) { return `<input type="hidden" name="_csrf" value="${esc(token)}">`; }

function fieldError(errors, key) {
  return errors && errors[key] ? `<p class="field-error" role="alert">${esc(errors[key])}</p>` : '';
}

module.exports = {
  esc, SITE_NAME, SITE_TAGLINE, layout, toolCard, categoryGrid, reasonChips,
  section, pagination, flash, csrfField, fieldError, monogram,
  trustBadges, trustDetailHtml,
};

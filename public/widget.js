/**
 * Atlas AI Embeddable Widget v1.0
 * 
 * Add AI tool recommendations to any website with a single <script> tag.
 * No dependencies, no iframes, fully customizable via data attributes.
 *
 * Usage:
 *   <div class="atlas-widget" data-category="Writing" data-limit="5" data-theme="light"></div>
 *   <script async src="https://your-domain.com/widget.js"></script>
 *
 * Data attributes (all optional):
 *   data-category   — Filter by category (default: show all)
 *   data-tag         — Filter by tag
 *   data-limit       — Max tools to show (default: 6, max: 12)
 *   data-theme       — "light" | "dark" (default: auto from prefers-color-scheme)
 *   data-show-ratings — "true" | "false" (default: true)
 *   data-api-origin   — Custom API origin (default: current domain)
 *   data-header-text  — Custom heading text
 *   data-empty-text   — Custom empty state text
 */
(function () {
  'use strict';

  const CONTAINER_CLASS = 'atlas-widget';
  const API_BASE = document.currentScript ? (document.currentScript.dataset.apiOrigin || '') : '';

  // -- Styles (self-contained) --
  const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
.atlas-widget-container { font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width:100%; }
.atlas-widget-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:12px; }
.atlas-widget-card { background:var(--aw-bg,#fff); border:1px solid var(--aw-border,#e0e0d8); border-radius:10px; padding:16px; transition:box-shadow 0.2s, transform 0.2s; }
.atlas-widget-card:hover { box-shadow:0 4px 16px var(--aw-shadow, rgba(0,0,0,.08)); transform:translateY(-2px); }
.atlas-widget-card h4 { margin:0 0 4px; font-size:0.95rem; font-weight:600; }
.atlas-widget-card h4 a { color:var(--aw-text,#1a1a18); text-decoration:none; }
.atlas-widget-card h4 a:hover { color:var(--aw-accent,#2d7d46); }
.atlas-widget-card .aw-tagline { font-size:0.8rem; color:var(--aw-muted,#6b6a63); margin:0 0 8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.atlas-widget-card .aw-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:0.75rem; }
.atlas-widget-pill { padding:2px 8px; border-radius:999px; font-size:0.7rem; font-weight:500; }
.aw-pill-free { background:#e8f5e9; color:#2d7d46; }
.aw-pill-paid { background:#fff3e0; color:#e65100; }
.aw-pill-category { background:var(--aw-surface,#f5f5f0); color:var(--aw-muted,#6b6a63); }
.atlas-widget-rating { color:var(--aw-accent,#d4a72c); font-size:0.75rem; }
.atlas-widget-header { margin-bottom:16px; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.atlas-widget-header h3 { margin:0; font-size:1.05rem; font-weight:700; }
.atlas-widget-powered { font-size:0.65rem; color:var(--aw-muted,#6b6a63); }
.atlas-widget-empty { text-align:center; padding:32px 16px; color:var(--aw-muted,#6b6a63); }
.atlas-widget-error { text-align:center; padding:32px 16px; color:var(--aw-error,#c62828); }
.atlas-widget-skeleton { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:12px; }
.atlas-widget-skel { background:var(--aw-surface,#f0f0ea); border-radius:10px; height:100px; animation:aw-pulse 1.5s infinite; }
@keyframes aw-pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
.atlas-widget-dark { --aw-bg:#1e1e1a; --aw-text:#f0f0ea; --aw-muted:#9e9e94; --aw-border:#3a3a35; --aw-surface:#2a2a25; --aw-shadow:rgba(0,0,0,.3); --aw-accent:#66bb6a; }
`;

  function injectStyles() {
    if (document.getElementById('atlas-widget-styles')) return;
    const s = document.createElement('style');
    s.id = 'atlas-widget-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  function buildCard(tool, showRatings) {
    const ratingHtml = showRatings && tool.avg_rating
      ? `<span class="atlas-widget-rating">★ ${Number(tool.avg_rating).toFixed(1)}</span>`
      : '';
    const pricingClass = (tool.pricing_model || '').toLowerCase().includes('free') ? 'aw-pill-free' : 'aw-pill-paid';
    return `<div class="atlas-widget-card">
      <h4><a href="${esc(tool.url)}" target="_blank" rel="noopener">${esc(tool.name)}</a></h4>
      <p class="aw-tagline">${esc(tool.tagline || tool.description || '')}</p>
      <div class="aw-meta">
        <span class="atlas-widget-pill aw-pill-category">${esc(tool.category || '')}</span>
        <span class="atlas-widget-pill ${pricingClass}">${esc(tool.pricing_model || '')}</span>
        ${ratingHtml}
      </div>
    </div>`;
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  async function fetchTools(config) {
    const url = new URL('/api/v1/tools', config.apiOrigin || window.location.origin);
    if (config.category) url.searchParams.set('category', config.category);
    if (config.tag) url.searchParams.set('tag', config.tag);
    url.searchParams.set('limit', String(config.limit || 6));
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error('API error: ' + resp.status);
    const data = await resp.json();
    return data.tools || data || [];
  }

  function renderSkeleton(container, limit) {
    let html = '<div class="atlas-widget-skeleton">';
    for (let i = 0; i < Math.min(limit, 6); i++) html += '<div class="atlas-widget-skel"></div>';
    html += '</div>';
    container.innerHTML = html;
  }

  function renderWidget(container, config) {
    const showRatings = config.showRatings !== 'false';
    renderSkeleton(container, config.limit || 6);

    fetchTools(config).then(tools => {
      const headerText = config.headerText || `AI Tools`;
      const emptyText = config.emptyText || 'No tools found for these filters.';

      let html = `<div class="atlas-widget-container"><div class="atlas-widget-header"><h3>${esc(headerText)}</h3><span class="atlas-widget-powered">by Atlas AI</span></div>`;

      if (!tools.length) {
        html += `<div class="atlas-widget-empty">${esc(emptyText)}</div>`;
      } else {
        html += `<div class="atlas-widget-grid">${tools.slice(0, config.limit || 6).map(t => buildCard(t, showRatings)).join('')}</div>`;
      }

      html += '</div>';
      container.innerHTML = html;
    }).catch(err => {
      container.innerHTML = `<div class="atlas-widget-container"><div class="atlas-widget-error">Could not load tools — ${esc(err.message)}</div></div>`;
    });
  }

  // Init
  injectStyles();

  const containers = document.querySelectorAll('.' + CONTAINER_CLASS);
  containers.forEach(el => {
    const config = {
      category: el.dataset.category || '',
      tag: el.dataset.tag || '',
      limit: Math.min(parseInt(el.dataset.limit, 10) || 6, 12),
      theme: el.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      showRatings: el.dataset.showRatings || 'true',
      apiOrigin: el.dataset.apiOrigin || '',
      headerText: el.dataset.headerText || '',
      emptyText: el.dataset.emptyText || '',
    };

    const wrapper = document.createElement('div');
    wrapper.className = 'atlas-widget-container' + (config.theme === 'dark' ? ' atlas-widget-dark' : '');
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    el.classList.remove(CONTAINER_CLASS);

    renderWidget(wrapper, config);
  });
})();

'use strict';
/* Atlas AI — Enhanced Interactive Edition
   Features: dark mode, command palette, compare tray, toasts, scroll reveals,
   animated counters, page transitions, back-to-top, typeahead, favorites. */
(function () {
  'use strict';

  /* Client-side HTML escaper (mirror of lib/html.js esc). Data from /api/tools,
     dataset attributes, and localStorage is raw text — never safe for innerHTML. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ==================== Theme Manager ==================== */
  const ThemeManager = {
    init() {
      const saved = localStorage.getItem('atlas-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      this.apply(theme);
      const toggle = document.querySelector('.theme-toggle');
      if (toggle) toggle.addEventListener('click', () => this.toggle());
    },
    apply(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('atlas-theme', theme);
    },
    toggle() {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      this.apply(current === 'dark' ? 'light' : 'dark');
    },
  };

  /* ==================== Toast Manager ==================== */
  const ToastManager = {
    container: null,
    init() {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      // role=status + polite: non-critical notifications; errors get role=alert on the toast itself
      this.container.setAttribute('role', 'status');
      this.container.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.container);
    },
    show(message, type = 'info', duration = 3000, action = null) {
      if (!this.container) this.init();
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      const span = document.createElement('span');
      span.textContent = message;
      toast.appendChild(span);
      if (action && action.label) {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', function () {
          clearTimeout(toast._timer);
          toast.classList.add('removing');
          setTimeout(function () { toast.remove(); }, 200);
          if (action.onClick) action.onClick();
        });
        toast.appendChild(btn);
      }
      this.container.appendChild(toast);
      toast._timer = setTimeout(function () {
        toast.classList.add('removing');
        setTimeout(function () { toast.remove(); }, 200);
      }, duration);
      // slide-in stagger: slight scale pop per toast
      toast.style.animation = 'toast-in 0.3s var(--ease-bounce)';
    },
  };

  /* ==================== Scroll Reveal ==================== */
  const ScrollReveal = {
    observer: null,
    init() {
      if (!('IntersectionObserver' in window)) return;
      this.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            entry.target.classList.add('reveal');
            ScrollReveal.observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
      // Tag sections and grids for reveal
      document.querySelectorAll('.section, .tool-card, .category-card, .stat, .hero > .container').forEach(function (el) {
        el.classList.add('reveal');
        ScrollReveal.observer.observe(el);
      });
    },
    refresh() {
      if (!this.observer) return;
      document.querySelectorAll('.tool-card, .category-card:not(.reveal)').forEach(function (el) {
        el.classList.add('reveal');
        ScrollReveal.observer.observe(el);
      });
    },
  };

  /* ==================== Animated Counters ==================== */
  const Counters = {
    init() {
      const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const nums = document.querySelectorAll('.stat-num[data-count]');
      if (!nums.length || !('IntersectionObserver' in window)) return;
      const obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const target = parseInt(el.dataset.count, 10);
          if (isNaN(target)) { obs.unobserve(el); return; }
          if (reducedMotion) { el.textContent = target; obs.unobserve(el); return; }
          let current = 0;
          const step = Math.max(1, Math.ceil(target / 30));
          const tick = function () {
            current += step;
            if (current >= target) { el.textContent = target; return; }
            el.textContent = current;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          obs.unobserve(el);
        });
      }, { threshold: 0.5 });
      nums.forEach(function (n) { obs.observe(n); });
    },
  };

  /* ==================== Back to Top ==================== */
  const BackToTop = {
    init() {
      const btn = document.createElement('button');
      btn.className = 'back-to-top';
      btn.setAttribute('aria-label', 'Back to top');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      document.body.appendChild(btn);
      const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.addEventListener('scroll', function () {
        btn.classList.toggle('visible', window.scrollY > 400);
      }, { passive: true });
      btn.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      });
    },
  };

  /* ==================== Command Palette ==================== */
  const CommandPalette = {
    overlay: null, input: null, results: null, items: [], activeIdx: -1, allTools: [],

    init() {
      this.overlay = document.createElement('div');
      this.overlay.className = 'cmdk-overlay';
      this.overlay.innerHTML = `
        <div class="cmdk-box" role="dialog" aria-label="Command palette">
          <input class="cmdk-input" type="search" placeholder="Search tools, pages…" autocomplete="off" aria-label="Search">
          <div class="cmdk-results"></div>
          <div class="cmdk-footer">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> select</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>`;
      document.body.appendChild(this.overlay);
      this.input = this.overlay.querySelector('.cmdk-input');
      this.results = this.overlay.querySelector('.cmdk-results');

      this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
      this.input.addEventListener('input', () => this.search());
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.open(); }
        if (e.key === 'Escape' && this.overlay.classList.contains('active')) this.close();
      });

      // Hint button — keyboard-activatable (Enter/Space)
      const hint = document.querySelector('.cmdk-hint');
      if (hint) {
        hint.addEventListener('click', () => this.open());
        hint.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(); }
        });
      }
    },

    open() {
      this.overlay.classList.add('active');
      this.input.value = '';
      this.results.innerHTML = '';
      this.activeIdx = -1;
      setTimeout(() => this.input.focus(), 50);
      this.loadTools();
    },

    close() {
      this.overlay.classList.remove('active');
      this.input.blur();
    },

    loadTools() {
      if (this.allTools.length) { this.search(); return; }
      fetch('/api/tools?q=a', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(items => { this.allTools = items || []; this.search(); })
        .catch(() => {});
    },

    search() {
      const q = this.input.value.trim().toLowerCase();
      const pages = [
        { type: 'page', title: 'Browse all tools', sub: 'Directory', href: '/browse', icon: 'search' },
        { type: 'page', title: 'Categories', sub: 'Overview', href: '/categories', icon: 'grid' },
        { type: 'page', title: 'Dashboard', sub: 'Your space', href: '/dashboard', icon: 'user' },
        { type: 'page', title: 'Sign in', sub: 'Account', href: '/login', icon: 'user' },
        { type: 'page', title: 'Create account', sub: 'Join', href: '/register', icon: 'user' },
        { type: 'page', title: 'Compare tools', sub: 'Side-by-side', href: '/compare', icon: 'compare' },
      ];
      const tools = this.allTools.filter(t =>
        !q || t.name.toLowerCase().includes(q) || (t.tagline && t.tagline.toLowerCase().includes(q)) || (t.category && t.category.toLowerCase().includes(q))
      ).slice(0, 8);
      const matchedPages = pages.filter(p => !q || p.title.toLowerCase().includes(q)).slice(0, 4);

      let html = '';
      if (matchedPages.length) {
        html += '<div class="cmdk-group">Pages</div>';
        matchedPages.forEach((p, i) => {
          html += `<button class="cmdk-item" data-href="${p.href}"><span class="cmdk-title">${p.title}</span><span class="cmdk-sub">${p.sub}</span></button>`;
        });
      }
      if (tools.length) {
        html += '<div class="cmdk-group">Tools</div>';
        tools.forEach(t => {
          html += `<button class="cmdk-item" data-href="/tool/${encodeURIComponent(t.slug)}"><span class="cmdk-title">${esc(t.name)}</span><span class="cmdk-sub">${esc(t.category)} · ${esc(t.pricing_model)}</span></button>`;
        });
      }
      if (!html) html = '<div class="cmdk-empty">No results. Try a different search.</div>';
      this.results.innerHTML = html;
      this.items = Array.from(this.results.querySelectorAll('.cmdk-item'));
      this.activeIdx = -1;
      this.items.forEach(item => {
        item.addEventListener('click', () => { window.location = item.dataset.href; });
      });
    },

    onKey(e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.activeIdx = Math.min(this.activeIdx + 1, this.items.length - 1);
        this.updateActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.activeIdx = Math.max(this.activeIdx - 1, -1);
        this.updateActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.activeIdx >= 0 && this.items[this.activeIdx]) {
          window.location = this.items[this.activeIdx].dataset.href;
        }
      }
    },

    updateActive() {
      this.items.forEach((item, i) => item.classList.toggle('active', i === this.activeIdx));
      if (this.activeIdx >= 0) this.items[this.activeIdx].scrollIntoView({ block: 'nearest' });
    },
  };

  /* ==================== Compare Tray ==================== */
  const CompareTray = {
    tray: null, selected: new Set(), max: 5,

    init() {
      this.tray = document.createElement('div');
      this.tray.className = 'compare-tray';
      this.tray.innerHTML = `
        <div class="compare-tray-inner">
          <span class="compare-tray-label">Compare (${this.selected.size}/${this.max})</span>
          <div class="compare-tray-items" style="display:flex;gap:6px;flex-wrap:wrap;max-width:400px;overflow:hidden;"></div>
          <div class="compare-tray-actions">
            <button class="compare-tray-clear">Clear all</button>
            <a class="btn btn-primary btn-sm" href="/compare">Compare selected →</a>
          </div>
        </div>`;
      document.body.appendChild(this.tray);
      this.itemsContainer = this.tray.querySelector('.compare-tray-items');
      this.label = this.tray.querySelector('.compare-tray-label');

      this.tray.querySelector('.compare-tray-clear').addEventListener('click', () => this.clear());

      // Load from storage
      try { const saved = JSON.parse(localStorage.getItem('atlas-compare') || '[]'); saved.forEach(id => this.selected.add(id)); } catch {}
      this.render();

      // Add compare checkboxes to tool cards
      this.addCheckboxesToCards();
    },

    addCheckboxesToCards() {
      document.querySelectorAll('.tool-card').forEach(card => {
        if (card.querySelector('.compare-check')) return;
        const link = card.querySelector('.tool-card-link');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        const slugMatch = href.match(/\/tool\/(.+)/);
        if (!slugMatch) return;
        const slug = slugMatch[1];

        const check = document.createElement('label');
        check.className = 'compare-check';
        check.innerHTML = `<input type="checkbox" data-slug="${slug}" ${this.selected.has(slug) ? 'checked' : ''}> Compare`;
        check.addEventListener('click', e => e.preventDefault());
        check.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) this.add(slug);
          else this.remove(slug);
        });
        card.appendChild(check);
      });
    },

    add(slug) {
      if (this.selected.size >= this.max) {
        ToastManager.show(`You can compare up to ${this.max} tools at once.`, 'error');
        const cb = document.querySelector(`.compare-check input[data-slug="${slug}"]`);
        if (cb) cb.checked = false;
        return;
      }
      this.selected.add(slug);
      this.persist();
      this.render();
      ToastManager.show('Added to compare.', 'success', 2000);
    },

    remove(slug) {
      this.selected.delete(slug);
      this.persist();
      this.render();
    },

    clear() {
      this.selected.clear();
      this.persist();
      this.render();
      document.querySelectorAll('.compare-check input').forEach(cb => cb.checked = false);
    },

    persist() {
      localStorage.setItem('atlas-compare', JSON.stringify([...this.selected]));
    },

    render() {
      this.label.textContent = `Compare (${this.selected.size}/${this.max})`;
      this.tray.classList.toggle('active', this.selected.size > 0);
      this.itemsContainer.innerHTML = '';
      // Update the compare link with selected slugs
      const compareLink = this.tray.querySelector('.compare-tray-actions a');
      if (compareLink) {
        const slugs = encodeURIComponent([...this.selected].join(','));
        compareLink.href = '/compare?slugs=' + slugs;
      }
      this.selected.forEach(slug => {
        const chip = document.createElement('span');
        chip.className = 'compare-chip';
        const title = document.createElement('span');
        title.textContent = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const removeBtn = document.createElement('button');
        removeBtn.setAttribute('aria-label', 'Remove ' + title.textContent);
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          this.remove(slug);
          const cb = document.querySelector(`.compare-check input[data-slug="${slug}"]`);
          if (cb) cb.checked = false;
        });
        chip.appendChild(title);
        chip.appendChild(removeBtn);
        this.itemsContainer.appendChild(chip);
      });
      // Update all checkboxes
      document.querySelectorAll('.compare-check input').forEach(cb => {
        cb.checked = this.selected.has(cb.dataset.slug);
      });
    },
  };

  /* ==================== Favorites (enhanced with toasts + undo) ==================== */
  function postForm(form, onSuccess) {
    const data = new URLSearchParams(new FormData(form));
    return fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: data.toString(),
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (res.status === 401) { window.location = '/login?next=' + encodeURIComponent(window.location.pathname); return null; }
        if (res.status === 403) { ToastManager.show('Session expired — please sign in again.', 'error'); setTimeout(() => { window.location = '/login'; }, 1000); return null; }
        if (!res.ok) throw new Error('Request failed');
        return res.json();
      })
      .then(function (json) { if (json) onSuccess(json); })
      .catch(function (err) { console.error(err); ToastManager.show('Something went wrong.', 'error'); });
  }

  function favToggle(btn, json) {
    btn.classList.toggle('is-fav', json.saved);
    btn.setAttribute('aria-pressed', String(json.saved));
    btn.setAttribute('aria-label', (json.saved ? 'Remove ' : 'Save ') + (btn.dataset.slug || 'tool') + ' from favorites');
    if (json.saved) {
      ToastManager.show('★ Saved to favorites', 'success', 2000);
    } else {
      ToastManager.show('☆ Removed from favorites', 'info', 3500, {
        label: 'Undo',
        onClick: function () {
          const form = document.createElement('form');
          form.method = 'post';
          form.action = '/api/favorites/toggle';
          form.innerHTML = '<input name="tool_id" value="' + btn.dataset.toolId + '"><input name="_csrf" value="' + (window.__CSRF || '') + '">';
          postForm(form, function (json2) { favToggle(btn, json2); });
        },
      });
    }
  }

  function initFavorites() {
    document.querySelectorAll('.fav-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!btn.dataset.toolId) return;
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/api/favorites/toggle';
        form.innerHTML = '<input name="tool_id" value="' + btn.dataset.toolId + '"><input name="_csrf" value="' + (window.__CSRF || '') + '">';
        postForm(form, function (json) { favToggle(btn, json); });
      });
    });

    document.querySelectorAll('.fav-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (form.dataset.nojs) return;
        e.preventDefault();
        const btn = form.querySelector('[data-fav-btn]');
        postForm(form, function (json) {
          const fav = json.saved;
          if (btn) {
            btn.textContent = fav ? '\u2605 Saved' : '\u2606 Save';
            btn.classList.toggle('btn-fav', fav);
            btn.classList.toggle('btn-ghost', !fav);
            btn.setAttribute('aria-pressed', String(fav));
          }
          ToastManager.show(fav ? '★ Saved to favorites' : '☆ Removed from favorites', fav ? 'success' : 'info', 2000);
        });
      });
    });
  }

  /* ==================== Typeahead (enhanced) ==================== */
  function initStackSave() {
    document.querySelectorAll('.stack-save-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!btn.dataset.toolSlug) return;
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/api/stacks/save';
        form.innerHTML = '<input name="tool_slug" value="' + btn.dataset.toolSlug + '"><input name="_csrf" value="' + (window.__CSRF || '') + '">';
        postForm(form, function (json) {
          if (json && json.error) { ToastManager.show(json.error, 'error'); return; }
          if (json && json.saved) {
            btn.classList.add('is-stacked');
            btn.setAttribute('aria-label', 'Saved to ' + (json.stack_name || 'your stack'));
            ToastManager.show('✓ Saved to ' + (json.stack_name || 'your stack'), 'success', 2200);
          }
        });
      });
    });
  }

  function initTypeahead() {
    const input = document.querySelector('input[data-typeahead]');
    const box = document.querySelector('[data-typeahead-results]');
    if (!input || !box) return;
    let timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(function () {
        fetch('/api/tools?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (items) {
            if (!items.length) {
              box.innerHTML = '<a class="ta-sub" href="/browse?q=' + encodeURIComponent(q) + '">No matches — browse all results</a>';
              box.hidden = false; return;
            }
            box.innerHTML = items.map(function (t) {
              return '<a href="/tool/' + encodeURIComponent(t.slug) + '"><span class="ta-name">' + esc(t.name) + '</span> <span class="ta-sub">' + esc(t.tagline) + '</span></a>';
            }).join('') + '<a href="/browse?q=' + encodeURIComponent(q) + '" class="ta-sub">All results for "' + esc(q) + '" →</a>';
            box.hidden = false;
          })
          .catch(function () { box.hidden = true; });
      }, 200);
    });
    document.addEventListener('click', function (e) {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') box.hidden = true; });
  }

  /* ==================== Admin Confirms (enhanced) ==================== */
  function initAdminConfirms() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.dataset.confirm)) e.preventDefault();
      });
    });
  }

  /* ==================== Page Transitions ==================== */
  function initPageTransitions() {
    const overlay = document.createElement('div');
    overlay.className = 'page-transition';
    document.body.appendChild(overlay);

    function removeOverlay() { overlay.classList.remove('active'); }

    document.addEventListener('click', function (e) {
      const link = e.target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:') ||
          link.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      // Same-page navigation (path+search identical, hash-only difference) → no full navigation, skip overlay
      const base = href.split('#')[0];
      if (base === window.location.pathname + window.location.search) return;
      if (href === window.location.pathname + window.location.search) return;
      overlay.classList.add('active');
    });
    // bfcache "Back" can restore the overlay in .active state — always clear on show/hash change
    window.addEventListener('pageshow', removeOverlay);
    window.addEventListener('hashchange', removeOverlay);
  }

  /* ==================== Dashboard Mini Chart ==================== */
  function initMiniChart() {
    const chart = document.querySelector('[data-mini-chart]');
    if (!chart) return;
    const bars = chart.querySelectorAll('.mini-bar-fill');
    bars.forEach(function (bar, i) {
      const targetHeight = bar.dataset.height;
      bar.style.height = '0%';
      setTimeout(function () { bar.style.height = targetHeight + '%'; }, 100 + i * 80);
    });
  }

  /* ==================== CSRF exposure ==================== */
  function exposeCSRF() {
    // Prefer an explicit meta tag (present on every page via layout); fall back to any form input.
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) { window.__CSRF = meta.content; return; }
    const anyForm = document.querySelector('form input[name="_csrf"]');
    if (anyForm) window.__CSRF = anyForm.value;
  }

  /* ==================== Reviews ==================== */
  function initReviews() {
    const form = document.getElementById('review-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const data = new URLSearchParams(new FormData(form));
      fetch('/api/reviews/create', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: data.toString(), credentials: 'same-origin',
      })
        .then(r => r.json())
        .then(json => {
          if (json.error) { ToastManager.show(json.error, 'error'); return; }
          ToastManager.show('Review posted!', 'success');
          setTimeout(() => window.location.reload(), 800);
        })
        .catch(() => ToastManager.show('Failed to post review.', 'error'));
    });
  }

  /* ==================== Community (votes + alerts) ==================== */
  function initCommunity() {
    const voteBtn = document.getElementById('vote-btn');
    if (voteBtn) {
      voteBtn.addEventListener('click', function () {
        const data = new URLSearchParams();
        data.set('tool_id', voteBtn.dataset.toolId);
        data.set('_csrf', voteBtn.dataset.csrf || window.__CSRF || '');
        fetch('/api/votes/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: data.toString(), credentials: 'same-origin',
        })
          .then(r => r.json())
          .then(json => {
            if (json.error) { ToastManager.show(json.error, 'error'); return; }
            voteBtn.classList.toggle('btn-fav', json.voted);
            voteBtn.classList.toggle('btn-ghost', !json.voted);
            voteBtn.textContent = (json.voted ? '✓ I use this daily' : 'I use this daily') + ' (' + json.count + ')';
          })
          .catch(() => ToastManager.show('Failed to vote.', 'error'));
      });
    }
    const alertBtn = document.getElementById('alert-btn');
    if (alertBtn) {
      alertBtn.addEventListener('click', function () {
        const data = new URLSearchParams();
        data.set('tool_id', alertBtn.dataset.toolId);
        data.set('type', 'price_change');
        data.set('_csrf', alertBtn.dataset.csrf || window.__CSRF || '');
        fetch('/api/alerts/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: data.toString(), credentials: 'same-origin',
        })
          .then(r => r.json())
          .then(json => {
            if (json.error) { ToastManager.show(json.error, 'error'); return; }
            alertBtn.textContent = json.active ? '✓ Alerting' : '☆ Alert on price change';
            ToastManager.show(json.active ? 'Alert set' : 'Alert removed', json.active ? 'success' : 'info');
          })
          .catch(() => ToastManager.show('Failed to toggle alert.', 'error'));
      });
    }
  }

  /* ==================== Star Rating Widget (review form) ==================== */
  function initStarRating() {
    const widget = document.getElementById('star-widget');
    if (!widget) return;
    const hidden = document.getElementById('review-rating');
    const hint = document.getElementById('star-hint');
    const labels = ['', 'Bad', 'Poor', 'OK', 'Good', 'Excellent'];
    const btns = Array.from(widget.querySelectorAll('button'));
    function setValue(v, announce) {
      widget.dataset.value = String(v);
      if (hidden) hidden.value = String(v);
      btns.forEach(function (b) {
        const active = parseInt(b.value, 10) <= v;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', String(active));
        // Roving tabindex: only the currently checked star is a tab stop
        b.setAttribute('tabindex', parseInt(b.value, 10) === v ? '0' : '-1');
      });
      if (hint) hint.textContent = labels[v] || '';
      if (announce) ToastManager.show('Rating: ' + (labels[v] || v) + ' (' + v + '/5)', 'info', 1500);
    }
    btns.forEach(function (b) {
      b.addEventListener('click', function () { setValue(parseInt(b.value, 10), false); });
      b.addEventListener('mouseenter', function () {
        // preview on hover (visual only)
        btns.forEach(function (x) {
          x.classList.toggle('active', parseInt(x.value, 10) <= parseInt(b.value, 10));
        });
        if (hint) hint.textContent = labels[parseInt(b.value, 10)] || '';
      });
      b.addEventListener('mouseleave', function () { setValue(parseInt(widget.dataset.value, 10) || 5, false); });
      b.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const cur = parseInt(widget.dataset.value, 10) || 5;
          const next = e.key === 'ArrowRight' ? Math.min(5, cur + 1) : Math.max(1, cur - 1);
          setValue(next, true);
          btns[5 - next].focus();
        } else if (e.key === 'Home') {
          e.preventDefault(); setValue(1, true); btns[4].focus();
        } else if (e.key === 'End') {
          e.preventDefault(); setValue(5, true); btns[0].focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setValue(parseInt(b.value, 10), true);
        }
      });
    });
    setValue(5, false);
  }

  /* ==================== Surprise Me (random tool) ==================== */
  function initSurprise() {
    const btn = document.getElementById('surprise-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.classList.add('spinning');
      btn.setAttribute('aria-busy', 'true');
      fetch('/api/random', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          if (!json || !json.slug) { ToastManager.show('No tools found.', 'error'); return; }
          ToastManager.show('Rolling the dice… ' + json.name, 'info', 1800);
          setTimeout(function () { window.location = '/tool/' + encodeURIComponent(json.slug); }, 650);
        })
        .catch(function () { ToastManager.show('Could not load tools.', 'error'); })
        .finally(function () { setTimeout(function () { btn.classList.remove('spinning'); btn.setAttribute('aria-busy', 'false'); }, 700); });
    });
  }

  /* ==================== Live Pricing Calculator ==================== */
  function initPricingCalc() {
    const slider = document.getElementById('usage-slider');
    if (!slider) return;
    const costEl = document.getElementById('est-cost');
    const tierEl = document.getElementById('est-tier');
    const usageEl = document.getElementById('usage-value');
    const breakdownEl = document.getElementById('cost-breakdown');
    const base = parseFloat(slider.dataset.base || '20');
    const model = (slider.dataset.model || 'Freemium').toLowerCase();
    function compute(uses) {
      // Simple transparent model: base fee + per-100-uses step, capped for free tools
      let monthly = base;
      let tier = slider.dataset.model;
      if (model === 'free') {
        monthly = 0; tier = 'Free';
      } else if (uses > 100 && uses <= 500) {
        monthly = base + Math.round((uses - 100) / 100) * 10; tier = slider.dataset.model + ' · Mid';
      } else if (uses > 500) {
        monthly = base + 40 + Math.round((uses - 500) / 100) * 6; tier = slider.dataset.model + ' · Scale';
      }
      return { monthly: Math.round(monthly), tier };
    }
    function render() {
      const uses = parseInt(slider.value, 10);
      const { monthly, tier } = compute(uses);
      if (usageEl) usageEl.textContent = uses.toLocaleString();
      if (costEl) {
        costEl.textContent = monthly === 0 ? '$0' : '$' + monthly;
        costEl.classList.remove('pop'); void costEl.offsetWidth; costEl.classList.add('pop');
      }
      if (tierEl) tierEl.textContent = tier;
      if (breakdownEl) {
        if (model === 'free') breakdownEl.textContent = 'Free plan — no cost at any usage level.';
        else if (uses <= 100) breakdownEl.textContent = 'Base plan covers ~' + (base ? 100 : 0) + ' uses/mo.';
        else if (uses <= 500) breakdownEl.textContent = 'Base + $10 per additional 100 uses.';
        else breakdownEl.textContent = 'Scale pricing: base + $40 + $6 per 100 uses.';
      }
    }
    slider.addEventListener('input', render);
    render();
  }

  /* ==================== Scroll Progress Bar ==================== */
  function initScrollProgress() {
    const bar = document.createElement('div');
    bar.className = 'scroll-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    let ticking = false;
    function update() {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ==================== Keyboard Navigation (tool cards) ==================== */
  function initCardKeyboardNav() {
    const grids = Array.from(document.querySelectorAll('.tool-grid'));
    if (!grids.length) return;
    grids.forEach(function (grid) {
      const allCards = Array.from(grid.querySelectorAll('.tool-card'));
      if (allCards.length < 2) return;
      let idx = -1;
      // Only cards currently visible in the layout (offsetParent !== null skips display:none)
      function visibleCards() { return allCards.filter(function (c) { return c.offsetParent !== null; }); }
      function clear() { allCards.forEach(function (c) { c.classList.remove('kb-focus'); }); }
      function focusCard(i) {
        const vis = visibleCards();
        if (!vis.length) return;
        clear();
        idx = (i + vis.length) % vis.length;
        vis[idx].classList.add('kb-focus');
        vis[idx].scrollIntoView({ block: 'nearest' });
      }
      grid.setAttribute('tabindex', '0');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Tool list (use arrow keys to navigate, Enter to open)');
      grid.addEventListener('keydown', function (e) {
        const vis = visibleCards();
        if (!vis.length) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusCard(idx < 0 ? 0 : idx + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusCard(idx < 0 ? 0 : idx - 1); }
        else if (e.key === 'Enter' && idx >= 0) {
          const link = vis[idx].querySelector('a');
          if (link) window.location = link.href;
        }
      });
      grid.addEventListener('focusout', function (e) {
        if (!grid.contains(e.relatedTarget)) { clear(); idx = -1; }
      });
    });
  }

  /* ==================== Live Filter Chips (browse grid, client-side) ==================== */
  /* Trust-filter state shared by the category chips (initLiveFilters) and the
     trust segments (initTrustFilters): both compute combined visibility and
     update the same live-status line. Persisted under 'atlas-trust-filter'. */
  const TRUST_FILTER_KEY = 'atlas-trust-filter';
  let trustFilterState = 'all';

  /* Card-level trust match. Segments: all | commercial | privacy | api |
     unverified (gap view: any field unverified; N/A is not a gap). */
  function trustMatchCard(card, seg) {
    if (seg === 'all') return true;
    if (seg === 'commercial') return card.dataset.commercial === 'verified';
    if (seg === 'privacy') return card.dataset.privacy === 'verified';
    if (seg === 'api') return card.dataset.api === 'verified';
    if (seg === 'unverified') {
      return card.dataset.commercial === 'unverified' || card.dataset.privacy === 'unverified' || card.dataset.api === 'unverified';
    }
    return true;
  }

  function initLiveFilters() {
    const grid = document.querySelector('.tool-grid');
    const facets = document.querySelector('.facets');
    if (!grid || !facets) return;
    const cards = Array.from(grid.querySelectorAll('.tool-card'));
    if (!cards.length) return;
    // Build chips from categories present on the page
    const cats = {};
    cards.forEach(function (c) {
      const cat = c.dataset.category || 'Other';
      cats[cat] = (cats[cat] || 0) + 1;
    });
    const chipRow = document.createElement('div');
    chipRow.className = 'live-chips';
    const status = document.createElement('p');
    status.className = 'live-status';
    status.setAttribute('aria-live', 'polite');
    const keys = ['All'].concat(Object.keys(cats).sort());
    const chips = {};
    // Per-card hide timers — cancelled when a card is shown again (fixes the filter race)
    const hideTimers = {};
    keys.forEach(function (k) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'live-chip' + (k === 'All' ? ' active' : '');
      chip.setAttribute('aria-pressed', k === 'All' ? 'true' : 'false');
      // textContent construction (category names can be arbitrary via CSV import)
      chip.textContent = k === 'All' ? k : (k + ' ');
      if (k !== 'All') {
        const count = document.createElement('span');
        count.className = 'chip-count';
        count.textContent = cats[k];
        chip.appendChild(count);
      }
      chip.dataset.cat = k;
      chip.addEventListener('click', function () {
        Object.keys(chips).forEach(function (kk) {
          chips[kk].classList.remove('active');
          chips[kk].setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        chip.classList.add('pulsing');
        setTimeout(function () { chip.classList.remove('pulsing'); }, 450);
        let visible = 0;
        cards.forEach(function (c) {
          const match = (k === 'All' || (c.dataset.category || 'Other') === k) && trustMatchCard(c, trustFilterState);
          if (hideTimers[c]) { clearTimeout(hideTimers[c]); delete hideTimers[c]; }
          if (match) {
            c.classList.remove('hide-card');
            c.classList.remove('enter');
            c.style.display = '';
            // Re-play entrance for freshly revealed cards
            void c.offsetWidth;
            c.classList.add('enter');
            visible++;
          } else {
            c.classList.remove('enter');
            c.classList.add('hide-card');
            hideTimers[c] = setTimeout(function () { c.style.display = 'none'; }, 200);
          }
        });
        status.textContent = visible + ' of ' + cards.length + ' tools shown';
        status.classList.remove('flash'); void status.offsetWidth; status.classList.add('flash');
      });
      chips[k] = chip;
      chipRow.appendChild(chip);
    });
    grid.parentNode.insertBefore(chipRow, grid);
    grid.parentNode.insertBefore(status, grid);
    status.textContent = cards.length + ' tools on this page';
  }

  /* ==================== Trust filter segments (browse, client-side) ====================
     SSR buttons (.trust-filter) are wired here: single-select, aria-pressed,
     persisted in localStorage, applied without a page reload, and composed
     with the category chips (initLiveFilters) + server-side search/sort. */
  function initTrustFilters() {
    const grid = document.querySelector('.tool-grid');
    const row = document.querySelector('.trust-filter');
    if (!grid || !row) return;
    const cards = Array.from(grid.querySelectorAll('.tool-card'));
    if (!cards.length) return;
    const chips = Array.from(row.querySelectorAll('[data-trust]'));
    const status = document.querySelector('.live-status');

    // Restore persisted selection (single-select token).
    try {
      const saved = localStorage.getItem(TRUST_FILTER_KEY);
      if (saved && chips.some(function (c) { return c.dataset.trust === saved; })) trustFilterState = saved;
    } catch (e) { /* storage unavailable */ }

    const catActive = function () {
      const c = document.querySelector('.live-chip.active[data-cat]');
      return c ? c.dataset.cat : 'All';
    };

    const apply = function (seg, announce) {
      trustFilterState = seg;
      try { localStorage.setItem(TRUST_FILTER_KEY, seg); } catch (e) { /* ignore */ }
      chips.forEach(function (c) {
        const on = c.dataset.trust === seg;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const cat = catActive();
      let visible = 0;
      cards.forEach(function (c) {
        const match = trustMatchCard(c, seg) && (cat === 'All' || (c.dataset.category || 'Other') === cat);
        if (match) {
          c.classList.remove('hide-card');
          c.style.display = '';
          visible++;
        } else {
          c.classList.add('hide-card');
          c.style.display = 'none';
        }
      });
      if (status) {
        status.textContent = visible + ' of ' + cards.length + ' tools shown';
        if (announce) { status.classList.remove('flash'); void status.offsetWidth; status.classList.add('flash'); }
      }
    };

    chips.forEach(function (c) {
      c.addEventListener('click', function () { apply(c.dataset.trust, true); });
    });
    apply(trustFilterState, false);
  }

  /* ==================== Staggered card entrance ==================== */
  function initCardEntrance() {
    const cards = document.querySelectorAll('.tool-grid .tool-card');
    if (!cards.length || !('IntersectionObserver' in window)) return;
    const obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const i = Array.from(cards).indexOf(el);
        el.style.animationDelay = (i % 8) * 45 + 'ms';
        el.classList.add('enter');
        obs.unobserve(el);
      });
    }, { threshold: 0.05 });
    cards.forEach(function (c) { obs.observe(c); });
  }

  /* ==================== Compare page: Remove buttons ==================== */
  function initCompareRemove() {
    document.querySelectorAll('.compare-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const slug = btn.dataset.slug;
        if (!slug) return;
        try {
          const saved = JSON.parse(localStorage.getItem('atlas-compare') || '[]');
          localStorage.setItem('atlas-compare', JSON.stringify(saved.filter(function (s) { return s !== slug; })));
        } catch (e) { /* ignore storage errors */ }
        // Reload without the removed slug
        const params = new URLSearchParams(window.location.search);
        const slugs = (params.get('slugs') || '').split(',').filter(function (s) { return s && s !== slug; });
        if (slugs.length) params.set('slugs', slugs.join(','));
        else params.delete('slugs');
        const qs = params.toString();
        window.location = '/compare' + (qs ? '?' + qs : '');
      });
    });
  }

  /* ==================== Boot ==================== */
  function boot() {
    ThemeManager.init();
    ToastManager.init();
    ScrollReveal.init();
    Counters.init();
    BackToTop.init();
    CommandPalette.init();
    CompareTray.init();
    exposeCSRF();
    initFavorites();
    initStackSave();
    initTypeahead();
    initAdminConfirms();
    initPageTransitions();
    initMiniChart();
    initReviews();
    initCommunity();
    initStarRating();
    initSurprise();
    initPricingCalc();
    initScrollProgress();
    initCardKeyboardNav();
    initLiveFilters();
    initTrustFilters();
    initCardEntrance();
    initCompareRemove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

# Atlas AI — AI Tool Directory

A production-ready AI tool directory: categorized browsing, search and filtering, explainable tool recommendations, persistent user favorites, a personal dashboard, and an admin content workflow with a full change-history ledger.

- **Stack:** Node.js (≥ 22.5), zero runtime dependencies, server-side rendered HTML, SQLite (`node:sqlite`, built-in) with an automatic JSON-file fallback (`STORAGE=json`) for runtimes without `node:sqlite` (e.g. Aliyun FC nodejs20).
- **Design:** luxury minimalism (70%+ whitespace, serif display + system sans, single burnt-orange accent) — no external fonts, no remote images, no build step.
- **Language:** English (all user-visible content).

---

## Quick start

```bash
node server.js                 # boots on http://localhost:3000 (seeds catalog + admin on first run)
```

Then open <http://localhost:3000>.

| URL | Purpose |
|---|---|
| `/` | Home: search, categories, popular, new arrivals, personalized picks (when signed in) |
| `/browse` | All tools with filters (category, tag, pricing, search) and sort (popular / newest / A–Z) |
| `/category/<slug>` | Category pages with trending + new-arrival sections |
| `/tool/<slug>` | Tool detail: metadata, pricing, tags, website link, related tools with reasons |
| `/register` `/login` | Accounts (email + password, scrypt-hashed, rate-limited) |
| `/dashboard` | Saved tools, recent activity, stats, recommendations |
| `/admin` | Admin: overview, manage tools, add/edit, publish/unpublish, verify, delete, change history |

### Default accounts

| Role | Email | Password |
|---|---|---|
| Admin | `admin@example.com` | `Admin!2026` — **change after first login** (set `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars to override) |

## Configuration (environment variables)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where `app.db` (or `app.json`) lives |
| `STORAGE` | `auto` | `auto` \| `sqlite` \| `json` — auto prefers SQLite when `node:sqlite` exists |
| `BASE_URL` | `http://localhost:3000` | Used for canonical URLs and sitemap |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | seeded defaults | First-run admin credentials |

## Project structure

```
server.js            Local HTTP entry (node server.js)
index.js             Function Compute (nodejs20) handler adapter — same core
lib/
  core.js            Request pipeline: routing, sessions, CSRF, gzip, static
  handlers.js        All page + API handlers
  storage.js         DAO layer — SQLite + JSON adapters (same interface)
  auth.js            scrypt hashing, sessions, CSRF derivation, rate limits
  recommender.js     Explainable rule-based recommendations
  seed.js            Idempotent seeding (catalog + admin)
  seed-data.js       91 curated tools across 13 categories
  html.js            SSR layout + components
public/              app.css (design system), app.js (enhancements), favicon
scripts/
  verify.js          63-check end-to-end verification suite (node scripts/verify.js)
  backup.sh / restore.sh / rollback.sh / package-fc.sh
docs/                RUNBOOK.md (deploy/backup/monitoring/rollback), FEATURE-ENHANCEMENTS.md
data/                Runtime database (created on first boot, git-ignored)
```

## How the pieces work

- **Auth:** scrypt password hashes with per-user salt; session tokens stored hashed (sha256) in the DB, delivered as `HttpOnly; SameSite=Lax` cookies; CSRF via double-submit token (derived from the session token); login rate-limited per IP and per email; registration rate-limited per IP.
- **Recommendations (explainable):** related tools on detail pages score same-category (+5), shared tags (+3 each), normalized popularity (+2), recency (+1); the dashboard and home use the same engine seeded by your saved/viewed tools; every suggestion shows its reasons ("Same category as X", "Shares tags: …", "Popular right now").
- **Admin workflow:** create → draft → publish → public; unpublish, archive, verify, delete; every change writes a `tool_history` row with actor, field, old/new values, and timestamp (see `/admin/history`).
- **SEO:** per-page titles/descriptions, canonical URLs, JSON-LD (`WebSite`, `CollectionPage`, `SoftwareApplication`), `sitemap.xml`, `robots.txt`, semantic HTML, readable URLs.
- **Storage:** SQLite (WAL) via `node:sqlite`; the JSON adapter mirrors the same DAO and writes atomically (tmp + rename), so the app runs anywhere Node runs — including FC nodejs20 (set `STORAGE=json`, `DATA_DIR=/tmp/atlas`).

## Brand assets (logo)

The Atlas AI logo lives in `public/logo/` and `public/favicon.*` (served at `/assets/...`):

| File | Use |
|---|---|
| `public/logo/logo-mark.svg` / `.png` | Globe+pin mark, black on transparent — light surfaces |
| `public/logo/logo-mark-white.svg` | Same mark, white — dark surfaces (used by the app header in dark mode) |
| `public/logo/logo-mark-mono.svg` / `.png` | Strict monochrome version (no accent) — small-size / one-color use |
| `public/logo/logo.svg` / `.png` | Full lockup (mark + **ATLAS AI** wordmark) — light surfaces |
| `public/logo/logo-white.svg` / `.png` | Full lockup — dark surfaces |
| `public/favicon.svg` + `favicon-32/64/180/192.png` | Browser tab / apple-touch-icon / PWA icon |

**Design system (Swiss minimal):** pure black `#000000`, paper `#FAFAF7`, one accent `#C05621`. The mark is a globe (circle) with an equator band and a location square — three flat geometric shapes, no gradients, no fine lines, legible at 16 px.

**How to update:** replace the SVG sources in `public/logo/` (they are the single source of truth), then regenerate PNGs from the SVGs (e.g. `qlmanage -t -s 512 -o . <file>.svg`, resize with `sips`). The app header reads `logo-mark.svg` / `logo-mark-white.svg` via `.brand-mark` in `public/app.css`; the favicon is `public/favicon.svg` referenced in `lib/html.js`; the PWA manifest icons are in `lib/extensions.js`. Bump the `?v=` query on the stylesheet link in `lib/html.js` after CSS changes so browsers refetch.

## Verification

```bash
node scripts/verify.js   # boots the app on a scratch port + data dir and runs 63 checks
```

Coverage: boot & health, home/browse/category/detail rendering, every filter + sort, search API, register/login/logout, favorite save/remove, **favorites persist across sessions**, dashboard (favorites, activity, stats, recommendations), CSRF rejection, login rate limiting, full admin lifecycle (create → publish → public → unpublish → delete) with change-history assertions, recommendation explainability, sitemap/robots, security headers, performance budget (home < 60 KB, < 250 ms local), DB entity counts, and the JSON-store fallback path.

## Deployment & operations

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — covers VPS/PaaS deployment (systemd + nginx example), Function Compute packaging, backup/restore/rollback runbooks, monitoring, security hardening, and troubleshooting.

## Feature roadmap

See **[docs/FEATURE-ENHANCEMENTS.md](docs/FEATURE-ENHANCEMENTS.md)** — a prioritized enhancement report (reviews, comparison tool, editorial testing, AI-search readiness, community, API, alerts, i18n, enterprise security layer) with rationale, effort/impact, and sequencing.

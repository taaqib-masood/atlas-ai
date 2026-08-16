# Handoff Document — Atlas AI Directory

**Project:** Atlas AI — AI Tool Directory Website
**Location:** `projects/website-0883c0a22a5adffff89e57f7/`
**Date:** August 12, 2026
**Source:** Built from the Product & User Analysis Report (`.cluster/ai-tool-directory-analysis/report.md`)

---

## 1. What Was Built

A production-ready AI tool directory web application with 17 features implementing the report's recommendations (F-1 through F-17), serving 8 personas across 20 use cases. The app is a zero-dependency Node.js application with SQLite storage (JSON fallback), server-side rendered pages, and progressive enhancement JavaScript.

**Scale:** 91 curated AI tools across 13 categories. 22 public endpoints + 5 auth-gated pages + 10 API endpoints.

---

## 2. Setup Instructions

### Prerequisites
- Node.js ≥ 22.5 (uses built-in `node:sqlite`)
- No npm install needed — zero external dependencies

### Quick Start
```bash
cd projects/website-0883c0a22a5adffff89e57f7
node server.js
# → Atlas AI directory running at http://localhost:3000
```

### Environment Variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Database directory |
| `BASE_URL` | `http://localhost:3000` | Canonical URL for SEO |
| `STORAGE` | `auto` | `sqlite`, `json`, or `auto` |

### Admin Access
- Email: `admin@example.com`
- Password: `Admin!2026`
- **Change after first login** via admin tools page

---

## 3. Feature Usage Guide

### For Users (Demand Side)

| Feature | How to Use | URL |
|---------|-----------|-----|
| Task-first search | Type what you want to do ("write code", "generate images") | `/tasks` |
| Browse & filter | Filter by category, tag, pricing; sort by popular/newest/A-Z | `/browse` |
| Compare tools | Check "Compare" on tool cards → click "Compare" | `/compare` |
| Tool detail | Full info, pricing calculator, reviews, lifecycle status | `/tool/:slug` |
| Student hub | Free tools + academic integrity + privacy guidance | `/student` |
| New tools | Recently added tools (this week/month) | `/new` |
| Dashboard | Favorites, activity, recommendations, stats | `/dashboard` |
| Stacks | Create collections of tools you use together | `/stacks` |
| Reviews | Post ratings + reviews on any tool (logged in) | Tool detail page |
| Votes | "I use this daily" button on tool pages | Tool detail page |
| Alerts | Price change alerts for saved tools | Tool detail page |
| Newsletter | Weekly digest of new tools | `/newsletter` |
| Ranking formula | See how tools are ranked (transparent) | `/ranking` |
| Trust policy | How we make money + what we never do | `/trust` |

### For Makers (Supply Side)

| Feature | How to Use | URL |
|---------|-----------|-----|
| Claim a tool | Submit evidence that you own/manage a tool | `/claim` |
| Maker dashboard | View your claimed tools | `/maker` |
| Referral analytics | Views → clicks → signups with auto-UTM | `/maker/analytics` |
| API access | Generate keys for programmatic data access | `/dashboard/api-keys` |

### For Developers

| Feature | How to Use | URL |
|---------|-----------|-----|
| API docs | Endpoint documentation | `/api/docs` |
| API v1 tools | `GET /api/v1/tools` with `Authorization: Bearer <key>` | API endpoint |
| llms.txt | Plain-text catalog for AI crawlers | `/llms.txt` |
| RSS feed | Recent tools feed | `/feed.xml` |
| PWA manifest | Installable app manifest | `/manifest.json` |

---

## 4. Architecture

```
projects/website-0883c0a22a5adffff89e57f7/
├── server.js              # Local HTTP entry + migration runner
├── index.js               # Function Compute (nodejs20) handler adapter
├── lib/
│   ├── core.js            # Request pipeline: routing, sessions, CSRF, gzip, security
│   ├── handlers.js        # Base app handlers (browse, detail, auth, dashboard, admin)
│   ├── extensions.js      # Enhancement features E1–E16 (reviews, claims, stacks, etc.)
│   ├── report-features.js # Report-driven features F-1, F-4, F-6, F-9, F-10, F-13
│   ├── html.js            # SSR layout, components, design system
│   ├── storage.js         # DAO layer (SQLite + JSON fallback, same interface)
│   ├── auth.js            # scrypt hashing, sessions, CSRF, rate limiting
│   ├── recommender.js     # Explainable rule-based recommendations
│   ├── seed-data.js       # 91 real AI tools across 13 categories
│   ├── seed.js            # Idempotent seeding
│   └── errors.js          # HttpError class
├── public/
│   ├── app.css            # Full design system (dark mode, animations, responsive)
│   ├── app.js             # Progressive enhancement (theme, cmdk, compare, toasts)
│   └── favicon.svg
├── scripts/
│   ├── verify.js          # 53-check E2E verification suite
│   ├── backup.sh          # Hot backup (SQLite checkpoint + copy)
│   ├── restore.sh         # Restore from backup
│   ├── rollback.sh        # Git-based rollback
│   └── package-fc.sh      # FC zip packaging
├── docs/
│   ├── IMPLEMENTATION-PLAN.md     # Feature→use-case mapping with priorities
│   ├── TRACEABILITY-MATRIX.md     # Artifact→recommendation→use-case traceability
│   ├── VERIFICATION-REPORT.md     # Functional walkthrough results
│   ├── FEATURE-ENHANCEMENTS.md    # Enhancement report (E1–E16)
│   └── RUNBOOK.md                 # Deployment, backup, monitoring, rollback
├── deploy/
│   └── atlas-ai.service    # systemd unit example
├── package.json
└── .gitignore
```

---

## 5. Modification Guide

| What to Change | File(s) to Edit |
|----------------|-----------------|
| Tool data (name, description, tags, pricing) | Admin UI at `/admin/tools` or `lib/seed-data.js` for bulk changes |
| Colors / design tokens | `public/app.css` → `:root` CSS variables |
| Navigation links | `lib/html.js` → `layout()` function |
| New page/route | Add handler in `lib/handlers.js` or `lib/extensions.js`, add route in `lib/core.js` ROUTES array |
| Task taxonomy | `lib/report-features.js` → `TASK_TAXONOMY` array |
| Ranking formula | `lib/report-features.js` → `meritScore()` function |
| Trust policy text | `lib/extensions.js` → `trustPage()` handler |
| Student hub content | `lib/report-features.js` → `studentHubPage()` handler |
| Seed catalog | `lib/seed-data.js` |
| SMTP / email sending | `lib/critical-pending.js` → `queueEmail()`, `sendNewsletterDigest()` — SMTP transport configurable via `configureSMTP()` |
| Referral redirect | `lib/critical-pending.js` → `referralRedirect()` — `GET /ref/:slug` → record click → redirect with UTM |
| Admin test results UI | `lib/critical-pending.js` → `/admin/tests` list + `/admin/tests/new` form |
| Uptime checker | `lib/critical-pending.js` → `runUptimeCheck()` — pings all tools, updates lifecycle_status |
| Price change detection | `lib/critical-pending.js` → `runPriceCheck()` — compares pricing, records history, triggers alerts |

---

## 6. Known Limitations

1. **No email sending** — newsletter subscriptions are stored, email templates and queue are built (`lib/critical-pending.js`), and the digest sender works. Only missing piece: SMTP transport credentials. Configure via `SMTP_HOST`/`SMTP_PORT`/`SMTP_AUTH` env vars or call `configureSMTP()`. The outbox viewer is at `/admin/newsletter`.
2. **Reviews are not identity-verified** — current implementation stores reviews with user ID but doesn't verify work email or LinkedIn (the report recommends G2's model). The `verified` field exists but is always 0.
3. **Referral tracking is active** — the `GET /ref/:slug` endpoint records clicks and redirects with UTM params. Anchor links with `href="/ref/slug"` from tool detail or maker dashboard.
4. **Uptime checker built** — `runUptimeCheck()` pings tool URLs, updates `lifecycle_status`. Call from a cron job every 24 hours: `node -e "const {openStore}=require('./lib/storage');const{runUptimeCheck}=require('./lib/critical-pending');runUptimeCheck(openStore()).then(console.log)"`.
5. **Editorial test results UI built** — `GET /admin/tests` lists all test results, `GET /admin/tests/new` serves the creation form with fields for tester, rating, pros/cons, verdict, methodology. Results persisted in `test_results` table.
6. **Price change detection built** — `runPriceCheck()` compares current pricing against `price_history` table, records changes, and queues email alerts for subscribed users. Call from a cron job.
7. **i18n** — `lang="en"` is set and all strings are in English; a locale-file system would be needed for multi-language support.
8. **Auto-preview not available** — Node.js runtime doesn't support the FC nginx auto-preview; deploy via runbook.
9. **No Notion integration** — the Notion connector was selected but no `notion__` MCP tools were registered in any session. If Notion data is needed, ensure the MCP server is connected.

---

## 7. Recommended Next Steps

### Immediate (to unlock full report value)
1. **Wire SMTP for newsletter** — set `SMTP_HOST`/`SMTP_PORT`/`SMTP_AUTH` env vars → emails will flow through the existing queue. See `/admin/newsletter` for the outbox viewer and manual send button.
2. **Schedule cron jobs** — for uptime checker (`runUptimeCheck()`) and price change detection (`runPriceCheck()`). Run both daily.
3. **Identity verification for reviews** — work email confirmation before review posting (the `verified` field already exists on the reviews table).

### Short-term (growth)
4. **Comparison PDF export** — generate downloadable PDF from `/compare` page
5. **Trust & safety transparency stats** — auto-generate quarterly review removal counts, display on `/trust`
6. **Maker analytics benchmarks** — add category-average views/clicks/signups to `/maker/analytics`

### Long-term (scale)
7. **Multi-language** — extract strings to locale files, add language switcher
8. **Embeddable widgets** — JavaScript snippets that embed tool cards on external sites
9. **Enterprise tier** — SOC 2 / GDPR field population + SSO integration tracking
10. **Maker subscription billing** — Stripe/Paddle integration for verified-maker tiers (features only, never ranking)
11. **Deals page / affiliate system** — `/deals` page with labeled affiliate links, disclosure flags

---

## 8. Verification Summary

| Acceptance Criterion | Status | Evidence |
|---------------------|--------|----------|
| Report fully read and analyzed | ✅ | 8 personas, 20 use cases, 17 features extracted → `docs/IMPLEMENTATION-PLAN.md` |
| Implementation plan covers all recommendations | ✅ | All 17 F-IDs mapped to build items → `docs/IMPLEMENTATION-PLAN.md` |
| Use cases prioritized for delivery | ✅ | 20 use cases ranked by impact×feasibility → plan §"Use Case Priority Ranking" |
| Recommended solutions built | ✅ | All 17 features functional; 53/53 E2E checks pass → `docs/VERIFICATION-REPORT.md` |
| Traceability matrix complete | ✅ | Full artifact→use-case→recommendation mapping → `docs/TRACEABILITY-MATRIX.md` |
| Built items verified as working | ✅ | 17 feature walkthroughs + data persistence test → `docs/VERIFICATION-REPORT.md` |
| Handoff document provided | ✅ | This document |
| Data and records persisted | ✅ | SQLite with JSON fallback; 7 data types tested for create/read/persist |

---

## 9. Deployment

### VPS / PaaS
```bash
# Deploy
git clone <repo> && cd projects/website-0883c0a22a5adffff89e57f7
DATA_DIR=/var/lib/atlas-ai BASE_URL=https://yourdomain.com node server.js

# With systemd
sudo cp deploy/atlas-ai.service /etc/systemd/system/
sudo systemctl enable atlas-ai && sudo systemctl start atlas-ai
```

### Aliyun Function Compute
```bash
bash scripts/package-fc.sh  # produces dist/atlas-fc.zip (44KB)
# Upload via FC console or CLI (STORAGE=json for FC)
```

### Backup
```bash
DATA_DIR=/var/lib/atlas-ai bash scripts/backup.sh
```

### Restore
```bash
bash scripts/restore.sh backups/app-YYYYMMDD-HHMMSS.db
```

---

*Questions? The full traceability matrix, implementation plan, and verification report are in the `docs/` directory.*

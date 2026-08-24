# Atlas AI — Project Status

**Last updated:** 2026-08-24
**Repo:** github.com/taaqib-masood/atlas-ai · **Branch:** `main`
**Stack:** Node.js ≥ 22.5 · zero runtime dependencies · server-rendered HTML · SQLite (`node:sqlite`) with JSON fallback · vanilla JS/CSS

This file is a status snapshot: what is shipped, what remains, and how to verify/run it.

---

## 1. What's done (shipped)

### v1 baseline (verified)
- Categorized browsing + search + filters (category / tag / pricing) + 3 sorts
- 91-tool curated catalog across 13 categories
- Tool detail pages (metadata, pricing, tags, outbound links)
- Email/password accounts (scrypt-hashed, rate-limited) + sessions + CSRF
- Persistent favorites, personal dashboard (favorites / recent activity / stats)
- Explainable recommendations (category / tags / popularity / recency)
- Admin content workflow with full change-history ledger
- SEO (meta, canonical, JSON-LD, sitemap, robots)
- SQLite + JSON storage fallback; deployment runbook (`docs/HANDOFF.md`)

### v1.5 Interactive UX
- Dark mode (persistent, FOUC-free), command palette (⌘K / Ctrl+K), side-by-side compare, toast notifications, scroll-reveal animations, animated stat counters, card hover, back-to-top, hero gradient mesh, dashboard mini bar chart, page transitions, compare tray, enhanced focus states

### Trust metadata (commit `efa3b80`)
- `commercial_use_status`, `data_privacy_status`, `api_availability_status` plus `verification_source`, `notes`, `lifecycle_status`, editorial badges, and compliance fields — populated on all 91 tools

### Logo redesign (commit `4abfa20`)
- Monochrome wireframe atlas-globe mark (pure black/white, no gradients)

### AI Stack Builder (commits `58f5ed2` + `3d0133d`)
- Persistent user-owned stacks (name / slug / description / currency) + stack items (tool, provider, category, monthly cost, quantity, active flag)
- Live monthly total (active-only, integer-cents arithmetic) + yearly total (monthly × 12)
- `/my-stack` dashboard (plus `/stacks` alias); nav + footer wired
- "Save to Stack" button on every tool card (CSRF-safe form POST, auto-creates a default stack)
- Dark cards use `#0A0A0A` elevated surfaces
- Ownership-scoped (IDOR-safe → 404 on cross-user), validation rejects negative / >2-decimal / empty-name input

### Verification
- `node scripts/verify.js` → **77 checks, 77 pass, 0 fail**

---

## 2. What's left to do (remaining)

### Deployment (not yet done)
- The app runs locally (`node server.js`) but is **not deployed to production**.
- Node runtime → no desktop auto-preview. Aliyun FC packaging exists (`scripts/package-fc.sh` → `dist/atlas-fc.zip`, gitignored) but no managed upload/publish is wired.
- Deploy steps: `docs/HANDOFF.md` §9 (VPS/systemd or Aliyun Function Compute).

### Roadmap features (from `docs/FEATURE-ENHANCEMENTS.md`)
- **E1** side-by-side compare (v1.5 ships a basic version) · **E2** public trust signals · **E3** free-tier honesty · **E4** newsletter · **E5** AI-search / `llms.txt` · **E6** verified reviews · **E7** editorial tests · **E8** maker portal · **E9** community layer · **E10** launch tracking · **E11** personal alerts · **E12** public API · **E13** security/compliance · **E14** PWA · **E15** i18n · **E16** monetization

### Stack builder extensions (potential)
- Multi-currency, price import from a catalog field, stack sharing/export (CSV/PDF), compare-stacks view

### Housekeeping
- `docs/VERIFICATION-REPORT.md` documents the 53-check baseline; the suite is now **77 checks** (stack-builder S1–S14 added) — docs should be refreshed to match.

---

## 3. Run locally

```bash
node server.js   # http://localhost:3000
```

Default admin: `admin@example.com` / `Admin!2026` (change after first login).

---

## 4. Recent commits

| Hash | Description |
|---|---|
| `3d0133d` | Save-to-Stack card button, /my-stack route, yearly total, #0A0A0A surfaces |
| `58f5ed2` | AI stack builder (custom stacks + monthly spend) |
| `4abfa20` | Monochrome wireframe atlas-globe logo |
| `efa3b80` | Trust metadata on all 91 tools |
| `4359c1a` | Baseline logo redesign + static asset serving hardening |

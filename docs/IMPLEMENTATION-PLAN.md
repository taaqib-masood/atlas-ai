# Implementation Plan — Atlas AI Directory Enhancement

**Source:** Product & User Analysis Report (`.cluster/ai-tool-directory-analysis/report.md`)
**Goal:** Map every recommendation (F-1–F-17) and use case (20 total) to a concrete build item, then build the top-priority ones.

## Feature Status Matrix

| ID | Feature | Priority | Use Cases Served | Status | Build Location |
|----|---------|----------|------------------|--------|----------------|
| F-1 | Use-case-first natural-language search | P0 | D1-1, D1-3, D2-1, D5-2, D4-2 | **BUILD** | `lib/task-search.js` + handlers |
| F-2 | Structured verified listing schema | P0 | All | **BUILD** | `lib/extensions.js` migration + tool detail |
| F-3 | Lifecycle & freshness system | P0 | D1-2, D5-3, D2-2 | ✅ Shipped (E2) | Tool detail + admin |
| F-4 | Pricing transparency module + calculator | P0 | D1-3, D4-2, D5-1, D3-1 | **BUILD** | Tool detail + `lib/pricing.js` |
| F-5 | Maker portal (consent, claim, SLA) | P0 | S1-1, S1-3, S2-1, S2-2 | ✅ Shipped (E8) | `/claim`, `/maker` |
| F-6 | Maker referral analytics | P0 | S1-2, S2-2 | **BUILD** | `lib/analytics.js` + maker dashboard |
| F-7 | Review authenticity system | P0 | D1-1, D2-3, S2-3 | ✅ Shipped (E6) | Tool detail reviews |
| F-8 | Side-by-side comparison tool | P1 | D1-3, D2-2, D3-1 | ✅ Shipped (E1) | `/compare` |
| F-9 | Hands-on testing program | P1 | D2-1, D2-3 | **BUILD** | Tool detail + `/methodology` |
| F-10 | Merit-based category pages + ranking | P1 | S2-1, D2-1 | **BUILD** | Browse sort + formula doc |
| F-11 | AI-search readiness | P1 | All | ✅ Shipped (E5) | `/llms.txt`, `/api/v1/tools` |
| F-12 | Community layer | P1 | D2-3, D1-1 | ✅ Shipped (E9) | Votes, stacks |
| F-13 | Free-tier honesty & student program | P1 | D4-1, D4-2, D5-1 | **BUILD** | `/student` hub |
| F-14 | Security/compliance verification | P2 | D3-3, D6 | ✅ Shipped (E13) | `compliance_data` field |
| F-15 | Public data API + widgets | P2 | Agencies, D6 | ✅ Shipped (E12) | `/api/v1/tools`, `/api/docs` |
| F-16 | Personal stacks & alerts | P2 | D2-2, D5-3 | ✅ Shipped (E9, E11) | `/stacks`, alert toggle |
| F-17 | Mobile PWA | P2 | All | ✅ Shipped (E14) | `/manifest.json`, `/sw.js` |

## Use Case Priority Ranking (Impact × Feasibility)

| Rank | Use Case | Segment | Impact | Feasibility | Served By |
|------|----------|---------|--------|-------------|-----------|
| 1 | Task-first search (D1-1) | Professionals | High | High | F-1 |
| 2 | Defensible purchase proposal (D1-3) | Professionals | High | High | F-8, F-4 |
| 3 | Avoiding dead tools (D1-2) | Professionals | High | High | F-3 ✅ |
| 4 | Technical shortlist (D3-1) | Developers | High | Medium | F-2, F-4 |
| 5 | Zero-friction launch (S1-1) | Indie hackers | High | High | F-5 ✅ |
| 6 | Data-driven paid decision (S1-2) | Indie hackers | High | Medium | F-6 |
| 7 | New-category triage (D2-1) | Power users | High | Medium | F-1, F-10 |
| 8 | Clicks-to-signups measurement (S2-2) | Startups | High | Medium | F-6 |
| 9 | Five-minute go/no-go (D5-1) | SMB | Medium | High | F-4, F-2 |
| 10 | Review authenticity defense (S2-3) | Startups | Medium | Medium | F-7 ✅ |
| 11 | Contributing signal (D2-3) | Power users | Medium | High | F-12 ✅ |
| 12 | Control of own profile (S1-3) | Indie hackers | Medium | High | F-5 ✅ |
| 13 | Integrity-safe research (D4-1) | Students | Medium | High | F-13 |
| 14 | Long-lived choice (D2-2) | Power users | Medium | Medium | F-8 ✅, F-16 ✅ |
| 15 | Security pre-screen (D3-3) | Developers | Medium | Medium | F-14 ✅ |
| 16 | Winning category on merit (S2-1) | Startups | Medium | Medium | F-10 |
| 17 | Free-alternative discovery (D4-2) | Students | Medium | High | F-13, F-4 |
| 18 | Niche dev utility lookup (D3-2) | Developers | Low | High | F-1 |
| 19 | No-dev-skill output (D5-2) | SMB | Low | High | F-1 |
| 20 | Subscription exit plan (D5-3) | SMB | Low | High | F-3 ✅, F-16 ✅ |

## Build Items (this delivery)

1. **F-1: Task-first search** — natural-language query → task taxonomy matching
2. **F-2: Field-level provenance** — "claimed by maker / verified by editor" per field
3. **F-4: Pricing calculator** — usage-based cost estimation
4. **F-6: Maker referral analytics** — views→clicks→signups dashboard with auto-UTM
5. **F-9: Hands-on test results** — editorial test result content on tool pages
6. **F-10: Merit-based ranking** — transparent formula, freshness boost, documented
7. **F-13: Student/integrity hub** — academic-integrity guidance, student discounts, privacy summary
8. **Traceability matrix** — full artifact→use-case→recommendation mapping
9. **Handoff document** — setup, usage, limitations, next steps

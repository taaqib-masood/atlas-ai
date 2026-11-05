# Graph Report - atlas-ai  (2026-11-05)

## Corpus Check
- 52 files · ~56,356 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 2, .service 1, .css 1)

## Summary
- 490 nodes · 1071 edges · 17 communities (12 shown, 5 thin omitted)
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 176 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `485233c2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- handlers.js
- core.js
- extensions.js
- app.js
- more-pending.js
- SqliteStore
- stack-builder.js
- JsonStore
- verify.js
- report-features.js
- package.json
- recommender.js
- widget.js
- backup.sh
- package-fc.sh
- restore.sh
- rollback.sh

## God Nodes (most connected - your core abstractions)
1. `esc()` - 51 edges
2. `SqliteStore` - 40 edges
3. `JsonStore` - 39 edges
4. `section()` - 27 edges
5. `layout()` - 23 edges
6. `csrfField()` - 21 edges
7. `now()` - 19 edges
8. `boot()` - 19 edges
9. `toolCard()` - 17 edges
10. `page()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `handler()` --calls--> `handleRequest()`  [EXTRACTED]
  index.js → lib/core.js
- `server` --calls--> `handleRequest()`  [EXTRACTED]
  server.js → lib/core.js
- `rssFeed()` --calls--> `esc()`  [EXTRACTED]
  lib/extensions.js → lib/html.js
- `pricingCalculator()` --calls--> `esc()`  [EXTRACTED]
  lib/report-features.js → lib/html.js
- `registerPost()` --calls--> `hashPassword()`  [EXTRACTED]
  lib/handlers.js → lib/auth.js

## Import Cycles
- None detected.

## Communities (17 total, 5 thin omitted)

### Community 0 - "handlers.js"
Cohesion: 0.08
Nodes (58): rateLimit(), validateEmail(), validatePassword(), HttpError, adminHistory(), adminOverview(), adminToolAction(), adminToolEdit() (+50 more)

### Community 1 - "core.js"
Cohesion: 0.05
Nodes (44): handler(), store, crypto, csrfForToken(), hashPassword(), hashToken(), limits, makeSalt() (+36 more)

### Community 2 - "extensions.js"
Cohesion: 0.07
Nodes (44): addPriceHistory(), addSubscriber(), alertToggle(), apiDocsPage(), apiKeyCreate(), apiKeyDelete(), apiKeysPage(), apiV1Tools() (+36 more)

### Community 3 - "app.js"
Cohesion: 0.08
Nodes (44): add(), addCheckboxesToCards(), apply(), boot(), clear(), close(), esc(), exposeCSRF() (+36 more)

### Community 4 - "more-pending.js"
Cohesion: 0.07
Nodes (34): adminNewsletter(), adminNewsletterSend(), adminTestNew(), adminTestNewPost(), adminTestResults(), checkToolUptime(), crypto, emailTemplate() (+26 more)

### Community 5 - "SqliteStore"
Cohesion: 0.09
Nodes (3): now(), parseTool(), SqliteStore

### Community 6 - "stack-builder.js"
Cohesion: 0.13
Nodes (37): slugify(), addStackItem(), apiStackSave(), catalogDatalist(), createStack(), CURRENCY_SYMBOLS, deleteStack(), deleteStackItem() (+29 more)

### Community 8 - "verify.js"
Cohesion: 0.11
Nodes (21): ADMIN, check(), crypto, csrfOf(), DATA_DIR, fs, Jar, loadTrustMap() (+13 more)

### Community 9 - "report-features.js"
Cohesion: 0.14
Nodes (13): createTestResult(), getReferralStats(), handlers, makerAnalyticsPage(), now(), pricingCalculator(), rankingFormulaPage(), recordReferralEvent() (+5 more)

### Community 10 - "package.json"
Cohesion: 0.12
Nodes (16): description, engines, node, license, main, name, private, scripts (+8 more)

### Community 11 - "recommender.js"
Cohesion: 0.54
Nodes (7): forUser(), maxPopularity(), normalizeTagList(), recencyFactor(), related(), scoreAgainstBase(), sharedTags()

### Community 12 - "widget.js"
Cohesion: 0.52
Nodes (5): buildCard(), esc(), fetchTools(), renderSkeleton(), renderWidget()

## Knowledge Gaps
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `JsonStore` connect `JsonStore` to `core.js`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Should `handlers.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07565392354124749 - nodes in this community are weakly interconnected._
- **Why does `SqliteStore` connect `SqliteStore` to `core.js`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Should `core.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05423728813559322 - nodes in this community are weakly interconnected._
- **Why does `openStore()` connect `core.js` to `SqliteStore`, `JsonStore`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Should `extensions.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06848357791754019 - nodes in this community are weakly interconnected._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08418367346938775 - nodes in this community are weakly interconnected._
## Build scope

AST-only extraction of 27 code files. Documents and media were not semantically extracted. Community names use deterministic hub labels. No LLM or paid API calls were made.

Raw pre-build extraction diagnostics (not exported-graph counts): dangling_endpoint_edges=10, self_loop_edges=1, undirected_same_endpoint_collapsed_edges=183. During build, endpoints may be resolved or external import stubs created; edges whose endpoints remain unresolved are dropped and are absent from `graph.json`. The exported graph has no dangling endpoints.

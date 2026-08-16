'use strict';
/**
 * Local HTTP server entry.  Usage:  node server.js  (PORT=3000 default)
 * The same request pipeline is exposed to Function Compute via index.js.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openStore } = require('./lib/storage');
const { handleRequest } = require('./lib/core');
const handlers = require('./lib/handlers');
const ext = require('./lib/extensions');
const rf = require('./lib/report-features');
const cp = require('./lib/critical-pending');
const mp = require('./lib/more-pending');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const store = openStore();

// Run all migrations
console.log('Running migrations...');
try { ext.migrate(store); } catch (e) { console.error('Migration warning:', e.message); }
try { rf.migrateAnalytics(store); } catch (e) { console.error('Analytics migration warning:', e.message); }
try { rf.migrateTestResults(store); } catch (e) { console.error('Test results migration warning:', e.message); }
try { cp.migrateReferralRedirect(store); } catch (e) { console.error('Referral migration warning:', e.message); }
try { mp.migrateReviewVerification(store); console.log('  review_verify migrated'); } catch (e) { console.error('Review migration warning:', e.message); }
try { mp.migrateDeals(store); console.log('  deals migrated'); } catch (e) { console.error('Deals migration warning:', e.message); }
try { mp.migrateMakerTiers(store); console.log('  maker_tiers migrated'); } catch (e) { console.error('Maker tiers migration warning:', e.message); }
console.log('Migrations complete.');

handlers.configure({ baseUrl: process.env.BASE_URL || `http://localhost:${PORT}` });

// Ensure admin + catalog exist on first boot (idempotent) — seed the SAME
// instance so it sees the data immediately (no divergent writers).
try { require('./lib/seed').seedStore(store); } catch (e) { console.error('Seed warning:', e.message); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(u.searchParams);
  let bodyRaw = '';
  req.on('data', (chunk) => { if (bodyRaw.length < 1_000_000) bodyRaw += chunk; });
  req.on('end', async () => {
    try {
      // T12: Serve widget.js with CORS for embedding on external sites
      if (req.method === 'GET' && u.pathname === '/widget.js') {
        const widgetFile = path.join(__dirname, 'public', 'widget.js');
        if (fs.existsSync(widgetFile)) {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
          res.end(fs.readFileSync(widgetFile));
          return;
        }
      }

      const result = await handleRequest(store, {
        method: req.method,
        path: u.pathname,
        query,
        headers: req.headers,
        bodyRaw,
        ip: req.socket.remoteAddress || '',
        rawBody: bodyRaw, // For CSV multipart parsing
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error('Request error:', err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Atlas AI directory running at http://localhost:${PORT} (storage: ${store.kind()})`);
  console.log(`Health: http://localhost:${PORT}/healthz`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });

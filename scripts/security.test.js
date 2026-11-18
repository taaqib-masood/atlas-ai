'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { openStore } = require('../lib/storage');
const { seedStore } = require('../lib/seed');
const { verifyPassword } = require('../lib/auth');
const { handleRequest } = require('../lib/core');
const extensions = require('../lib/extensions');

delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD = 'Local-security-fixture-only!';
function seed(store, opts) {
  const output = [];
  const log = console.log, warn = console.warn;
  console.log = console.warn = (...args) => output.push(args.join(' '));
  try {
    const result = seedStore(store, opts);
    assert.ok(!output.join('\n').includes(ADMIN_PASSWORD));
    assert.equal(Object.hasOwn(result, 'adminPassword'), false);
    return result;
  } finally { console.log = log; console.warn = warn; }
}

for (const storage of ['sqlite', 'json']) {
  test(`${storage}: bootstrap, ownership, publication, email removal and JSON-LD boundaries`, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-security-'));
    const store = openStore({ storage, dataDir });
    extensions.migrate(store);
    require('../lib/stack-builder').migrate(store);
    const request = (method, pathname, { body, token, query, headers } = {}) => handleRequest(store, {
      method, path: pathname, query, ip: '127.0.0.1',
      headers: { 'content-type': 'application/json', accept: 'application/json',
        ...(token ? { cookie: `sid=${token}` } : {}), ...headers },
      bodyRaw: body ? JSON.stringify(body) : '',
    });
    try {
      await t.test('no default admin; explicit valid credentials are private and idempotent', async () => {
        seed(store);
        assert.equal(store.getUserByEmail('admin@example.com'), null);
        assert.ok(store.stats().published > 0);
        for (const adminPassword of ['short', 'x'.repeat(129)]) seed(store, { adminPassword });
        assert.equal(store.getUserByEmail('admin@example.com'), null);
        seed(store, { adminPassword: ADMIN_PASSWORD });
        const admin = store.getUserByEmail('admin@example.com');
        assert.equal(admin.role, 'admin');
        assert.ok(verifyPassword(ADMIN_PASSWORD, admin.salt, admin.password_hash));
        seed(store, { adminPassword: 'Different-local-fixture!' });
        assert.equal(store.getUserByEmail(admin.email).password_hash, admin.password_hash);
      });
      const admin = store.getUserByEmail('admin@example.com');
      const adminToken = store.createSession(admin.id, 60000);
      const alice = store.createUser({ email: 'alice@example.test', name: 'Alice', salt: 'unused', passwordHash: 'unused' });
      const bob = store.createUser({ email: 'bob@example.test', name: 'Bob', salt: 'unused', passwordHash: 'unused' });
      const aliceToken = store.createSession(alice.id, 60000), bobToken = store.createSession(bob.id, 60000);

      await t.test('API keys can only be revoked by their owner', async () => {
        const created = await request('POST', '/api/api-keys/create', { token: aliceToken, body: { name: 'Local fixture' } });
        const key = JSON.parse(created.body);
        assert.equal(created.status, 200);
        assert.equal((await request('POST', '/api/api-keys/delete', { body: { id: key.id } })).status, 401);
        assert.equal((await request('POST', '/api/api-keys/delete', { token: bobToken, body: { id: key.id } })).status, 404);
        assert.equal((await request('GET', '/api/v1/tools', { headers: { authorization: `Bearer ${key.key}` } })).status, 200);
        for (const body of [{}, { id: 999999 }]) {
          assert.equal((await request('POST', '/api/api-keys/delete', { token: aliceToken, body })).status, 404);
        }
        assert.equal((await request('POST', '/api/api-keys/delete', { token: aliceToken, body: { id: key.id } })).status, 200);
        assert.equal((await request('GET', '/api/v1/tools', { headers: { authorization: `Bearer ${key.key}` } })).status, 403);
      });

      await t.test('email knowledge alone cannot remove newsletter subscriptions', async () => {
        const body = { email: 'subscriber@example.test' };
        await request('POST', '/api/newsletter/subscribe', { body });
        assert.equal((await request('POST', '/api/newsletter/unsubscribe', { body })).status, 401);
        assert.equal((await request('POST', '/api/newsletter/unsubscribe', { body, token: bobToken })).status, 403);
        const count = () => storage === 'sqlite'
          ? store.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').n
          : store.data.subscribers.filter(s => s.active).length;
        assert.equal(count(), 1);
        assert.equal((await request('POST', '/api/newsletter/unsubscribe', { body, token: adminToken })).status, 200);
        assert.equal(count(), 0);
      });

      await t.test('JSON-LD cannot close its script element, while JSON values round-trip', async () => {
        for (const q of ['', 'normal search', '</script><b data-marker=fixture>', '</ScRiPt ><script data-marker=fixture>']) {
          const result = await request('GET', '/browse', { query: { q } });
          assert.equal(result.status, 200);
          const json = result.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
          assert.ok(!json.includes('<'));
          assert.ok(JSON.parse(json).name.includes(q));
          if (q.startsWith('<')) assert.ok(!result.body.includes(q));
        }
      });

      await t.test('draft and archived tools are not exported or accessed by public interactions', async () => {
        const published = store.listTools({ limit: 2 });
        for (const status of ['draft', 'archived']) {
          const name = `Private ${storage} ${status} fixture`, slug = `private-${status}`;
          const id = store.createTool({ name, slug, status, category: 'Writing', tagline: 'Private editorial fixture',
            description: 'Unpublished editorial fixture content', url: 'https://example.test', pricing_model: 'Free', tags: [], logo_color: '#000000' });
          for (const [pathname, query] of [
            ['/compare', { slugs: [slug, ...published.map(p => p.slug)].join(',') }],
            ['/compare/pdf', { ids: [id, ...published.map(p => p.id)].join(',') }],
          ]) {
            const result = await request('GET', pathname, { query });
            assert.equal(result.status, 200);
            assert.ok(!result.body.includes(name));
            assert.ok(result.body.includes(published[0].name));
          }
          for (const pathname of [`/tool/${slug}`, `/ref/${slug}`]) {
            assert.equal((await request('GET', pathname)).status, 404);
          }
          assert.equal((await request('GET', '/compare/pdf', { query: { ids: String(id) } })).status, 404);
          for (const pathname of ['/api/favorites/toggle', '/api/reviews/create', '/api/claims/create', '/api/votes/toggle', '/api/alerts/toggle', '/api/stacks/save']) {
            const body = { tool_id: id, tool_slug: slug, rating: 5, body: 'Local review fixture content' };
            assert.equal((await request('POST', pathname, { token: aliceToken, body })).status, 404, pathname);
          }
          store.addFavorite(alice.id, id);
          store.addEvent({ userId: alice.id, type: 'view', toolId: id });
          assert.ok(!store.listFavorites(alice.id).some(tool => tool.id === id));
          assert.ok(!store.recentViews(alice.id).some(tool => tool.id === id));
          assert.ok(!JSON.stringify(store.listEventsByUser(alice.id)).includes(name));
          assert.ok(!(await request('GET', '/dashboard', { token: aliceToken })).body.includes(name));
        }
        assert.equal((await request('GET', '/compare/pdf', { query: { ids: '' } })).status, 404);
        const tool = published[0];
        for (const pathname of ['/api/favorites/toggle', '/api/reviews/create', '/api/claims/create', '/api/votes/toggle', '/api/alerts/toggle', '/api/stacks/save']) {
          const body = { tool_id: tool.id, tool_slug: tool.slug, rating: 5, body: 'Local review fixture content' };
          assert.equal((await request('POST', pathname, { token: aliceToken, body })).status, 200, pathname);
          assert.equal((await request('POST', pathname, { token: aliceToken, body: {} })).status, 404, pathname);
        }
        store.addEvent({ userId: alice.id, type: 'view', toolId: tool.id });
        store.setToolStatus(tool.id, 'draft');
        store.updateTool(tool.id, { name: 'Unpublished revised fixture' });
        for (const pathname of ['/dashboard', '/claim']) {
          assert.ok(!(await request('GET', pathname, { token: aliceToken })).body.includes('Unpublished revised fixture'));
        }
        assert.ok(!JSON.stringify(extensions.helpers.listAlertsByUser(store, alice.id)).includes('Unpublished revised fixture'));
        const editor = await request('GET', `/admin/tools/${tool.id}/edit`, { token: adminToken });
        assert.equal(editor.status, 200);
        assert.ok(editor.body.includes('Unpublished revised fixture'));
      });

      await t.test('referral clicks store capped UTM values and a bounded number of events per IP', async () => {
        require('../lib/report-features').migrateAnalytics(store);
        require('../lib/critical-pending').migrateReferralRedirect(store);
        const tool = store.listTools({ limit: 1 })[0];
        const ip = `198.51.100.${storage === 'json' ? 2 : 1}`;
        const clicks = () => store.kind() === 'sqlite'
          ? store.all('SELECT * FROM referral_events WHERE ip = ?', [ip])
          : (store.data.referral_events || []).filter(e => e.ip === ip);
        const query = { utm_campaign: 'a'.repeat(10240) + '<script>', utm_source: '"><x>' };
        for (let i = 0; i < 100; i++) {
          const result = await handleRequest(store, { method: 'GET', path: `/ref/${tool.slug}`, query, ip, headers: {}, bodyRaw: '' });
          assert.equal(result.status, 303);
          assert.ok(new URL(result.headers.location).searchParams.get('utm_campaign').length <= 100);
        }
        const events = clicks();
        assert.ok(events.length > 0 && events.length <= 5, `stored ${events.length}`);
        assert.equal(events[0].utm_campaign, 'a'.repeat(100));
        assert.equal(events[0].utm_source, 'x');
      });

      await t.test('HTTPS configuration marks session cookies Secure without trusting forwarding headers', async () => {
        const prior = process.env.BASE_URL;
        try {
          process.env.BASE_URL = 'https://atlas.example.test';
          const result = await request('POST', '/login', { body: { email: admin.email, password: ADMIN_PASSWORD } });
          assert.equal(result.status, 303);
          assert.ok(result.headers['set-cookie'].every(cookie => cookie.includes('; Secure')));
          process.env.BASE_URL = 'http://127.0.0.1';
          const local = await request('GET', '/login', { headers: { 'x-forwarded-proto': 'https' } });
          assert.ok(local.headers['set-cookie'].every(cookie => !cookie.includes('; Secure')));
        } finally { if (prior === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prior; }
      });
    } finally { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}

test('malformed URL input cannot terminate the local HTTP server', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-http-security-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, STORAGE: 'json', ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let timer;
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Local server startup timed out')), 5000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('Atlas AI directory running')) resolve(); });
      child.once('exit', code => reject(Error(`Local server exited: ${code}`)));
    });
    clearTimeout(timer);
    const get = (pathname, host) => new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: pathname, headers: { host } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      }).once('error', reject);
    });
    assert.equal(await get('/healthz', '['), 200);
    assert.equal(await get('http://[', 'localhost'), 400);
    assert.equal(await get('/healthz', 'localhost'), 200);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

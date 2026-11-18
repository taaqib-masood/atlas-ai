'use strict';
/**
 * Seed runner: idempotent. Creates the admin account and loads the curated
 * catalog only when the tools table is empty.
 *
 * - seedStore(store) seeds an already-open store (used by server.js/index.js
 *   so the running instance sees the data immediately).
 * - run() opens its own store (npm run seed).
 *
 * Admin creation requires an explicit ADMIN_PASSWORD; credentials are never logged.
 */
const { openStore, trustFor, backfillTrustMetadata } = require('./storage');
const { hashPassword, makeSalt, validatePassword } = require('./auth');
const { TOOLS } = require('./seed-data');

function seedStore(store, opts = {}) {
  const adminEmail = opts.adminEmail || process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD;

  if (store.countTools({ status: null }) === 0) {
    // Fresh catalog: seed trust metadata from lib/trust-map.json alongside the
    // rows (trustFor falls back to defaults for any slug missing from the map).
    const insert = () => { for (const t of TOOLS) store.createTool({ ...t, ...trustFor(t.slug) }); };
    if (typeof store.tx === 'function') store.tx(insert); else insert();
    console.log(`Seeded ${TOOLS.length} tools.`);
  } else {
    console.log(`Catalog already present (${store.countTools({ status: null })} tools). Skipping.`);
  }

  // Trust-metadata backfill — idempotent, every boot (self-heals restores /
  // rollbacks). UPDATE-only merge of lib/trust-map.json by slug; never touches
  // rows outside the map and never overwrites non-default user-set values.
  try {
    const n = backfillTrustMetadata(store);
    if (n) console.log(`Trust metadata backfilled (${n} rows).`);
  } catch (e) {
    console.error('Trust metadata backfill warning:', e.message);
  }

  if (!store.getUserByEmail(adminEmail)) {
    if (!validatePassword(adminPassword)) {
      console.warn('Admin not created: configure ADMIN_PASSWORD with 8–128 characters.');
    } else {
      const salt = makeSalt();
      store.createUser({
        email: adminEmail,
        name: 'Directory Admin',
        passwordHash: hashPassword(adminPassword, salt),
        salt,
        role: 'admin',
      });
      console.log(`Admin created: ${adminEmail}`);
    }
  } else {
    console.log(`Admin account exists: ${adminEmail}`);
  }

  const stats = store.stats();
  console.log(`Storage: ${store.kind()} | users=${stats.users} tools=${stats.tools} published=${stats.published}`);
  return { adminEmail };
}

function run(opts = {}) {
  const store = openStore(opts);
  const result = seedStore(store, opts);
  store.close();
  return result;
}

module.exports = { run, seedStore };
if (require.main === module) run();

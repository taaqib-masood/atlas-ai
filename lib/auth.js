'use strict';
/**
 * Auth: scrypt password hashing, session tokens (hashed at rest), CSRF
 * (double-submit, derived from the session token), and a simple in-memory
 * login rate limiter (per-IP; single-instance deployments).
 */
const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, expectedHash) {
  const actual = hashPassword(password, salt);
  const a = Buffer.from(actual, 'hex'); const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function csrfForToken(token) { return crypto.createHash('sha256').update(token + ':csrf').digest('hex').slice(0, 32); }

/* In-memory rate limiter: ip -> { count, windowStart } */
const limits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const entry = limits.get(key);
  if (!entry || t - entry.start > windowMs) { limits.set(key, { count: 1, start: t }); return { ok: true, remaining: max - 1 }; }
  entry.count += 1;
  if (entry.count > max) return { ok: false, remaining: 0 };
  return { ok: true, remaining: max - entry.count };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of limits) if (t - v.start > 60 * 60 * 1000) limits.delete(k);
}, 10 * 60 * 1000).unref();

/* Validation helpers */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateEmail(v) { return typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v.trim()); }
function validatePassword(v) { return typeof v === 'string' && v.length >= 8 && v.length <= 128; }
function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

module.exports = {
  SESSION_TTL_MS, hashPassword, makeSalt, verifyPassword, hashToken, csrfForToken,
  rateLimit, validateEmail, validatePassword, slugify,
};

'use strict';
/**
 * T13: Multi-language locale system
 * Lightweight i18n helper. Loads locale files from /locales/{lang}.json.
 * Falls back to English if a key or locale file is missing.
 */
const fs = require('fs');
const path = require('path');

let locales = {};
let currentLang = 'en';
const localeDir = path.join(__dirname, '..', 'locales');

function loadLocale(lang) {
  const file = path.join(localeDir, lang + '.json');
  try {
    locales[lang] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    if (lang !== 'en') {
      // Fallback to English
      try {
        locales[lang] = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf-8'));
      } catch {
        locales[lang] = {};
      }
    }
  }
}

function init(lang) {
  currentLang = lang || 'en';
  loadLocale('en');
  if (lang && lang !== 'en') loadLocale(lang);
}

/**
 * Simple dot-path lookup: t('nav.browse') → 'Browse'
 * Supports basic {variable} substitution: t('browse.results_count', { count: 5 }) → '5 tool(s) found'
 */
function t(key, vars) {
  const parts = key.split('.');
  let val = locales[currentLang] || locales['en'] || {};
  for (const p of parts) {
    if (val && typeof val === 'object' && p in val) val = val[p];
    else { val = null; break; }
  }
  if (val === null && currentLang !== 'en') {
    // Try English fallback
    val = locales['en'] || {};
    for (const p of parts) {
      if (val && typeof val === 'object' && p in val) val = val[p];
      else { val = key.split('.').pop(); break; }
    }
  }
  if (val === null) val = key.split('.').pop();
  if (typeof val !== 'string') val = key.split('.').pop();

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = String(val).replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }
  return String(val);
}

function getCurrentLang() { return currentLang; }
function getDirection() {
  const rtl = ['ar', 'he', 'fa', 'ur'];
  return rtl.includes(currentLang) ? 'rtl' : 'ltr';
}

module.exports = { init, t, getCurrentLang, getDirection };

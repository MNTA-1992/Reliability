#!/usr/bin/env node
/* =========================================================================
 * tools/check-templates.js — Memastikan template di `sample-data/templates/`
 * masih dapat di-parse aplikasi SETELAH dianonimkan.
 * -------------------------------------------------------------------------
 * Anonimisasi tidak berguna kalau justru membuat template tak terbaca.
 * Skrip ini memuat parser APLIKASI (bukan menyalin logikanya) lalu
 * menegaskan tiap template menghasilkan baris yang wajar.
 *
 * PAKAI: node tools/check-templates.js
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'sample-data', 'templates');

/* Muat modul aplikasi (IIFE + global.*) seperti test/test-suite.js. */
const APP_GLOBAL = {};
APP_GLOBAL.window = APP_GLOBAL;
APP_GLOBAL.console = console;
APP_GLOBAL.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; }
};

const MODULES = [
  'js/csv-util.js', 'js/model-match.js', 'js/ui-util.js',
  'js/sos-config.js', 'js/sos-parser.js', 'js/vhms-config.js', 'js/vhms-parser.js',
  'js/lifetime-parser.js', 'js/topup-parser.js', 'js/section-parser.js'
];

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('global', 'window', 'module', 'exports', 'require', code)(
    APP_GLOBAL, APP_GLOBAL, { exports: {} }, {}, require
  );
}
MODULES.forEach(load);

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let fail = 0;
const say = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  GAGAL ') + msg); };

console.log('Parse template hasil anonimisasi\n' + '='.repeat(60));

/* --- SOS --- */
try {
  const r = APP_GLOBAL.SOS_PARSER.parse(read('sos-analysist-caterpillar-template.csv'), 'sos.csv');
  console.log('\nSOS');
  say(r.samples.length > 0, 'sampel terbaca: ' + r.samples.length);
  const s = r.samples[0];
  say(!!s && !!s.asset_id, 'nomor lambung terbaca: ' + (s && s.asset_id));
  say(!!s && !!s.component, 'kompartemen terbaca: ' + (s && s.component));
  say(!!s && !!s.asset_serial, 'serial unit terbaca: ' + (s && s.asset_serial));
  say(!!s && !!s.model, 'model terbaca: ' + (s && s.model));
  const num = r.samples.filter((x) => typeof x.wear_fe === 'number').length;
  say(num > 0, 'nilai teknis (Fe) terbaca pada ' + num + '/' + r.samples.length + ' sampel');
} catch (e) { say(false, 'SOS throw: ' + e.message); }

/* --- VHMS --- */
try {
  const r = APP_GLOBAL.VHMS_PARSER.parse(read('vhms-template.csv'), 'vhms.csv');
  console.log('\nVHMS');
  say((r.records || []).length > 0, 'record terbaca: ' + (r.records || []).length);
  say(!!(r.meta && r.meta.serial), 'serial terbaca: ' + (r.meta && r.meta.serial));
  say(!!(r.meta && r.meta.model), 'model terbaca: ' + (r.meta && r.meta.model));
} catch (e) { say(false, 'VHMS throw: ' + e.message); }

/* --- Lifetime --- */
try {
  const r = APP_GLOBAL.LIFETIME_PARSER.parse(read('nomor-lambung-umur-comp-section-template.csv'), 'life.csv');
  console.log('\nLifetime');
  say((r.rows || []).length > 0, 'baris terbaca: ' + (r.rows || []).length);
  const row = (r.rows || [])[0] || {};
  say(!!row.lambung, 'nomor lambung terbaca: ' + row.lambung);
  say(!!row.component, 'kompartemen terbaca: ' + row.component);
} catch (e) { say(false, 'Lifetime throw: ' + e.message); }

/* --- Top-Up --- */
try {
  const r = APP_GLOBAL.TOPUP_PARSER.parse(read('oil-rad-topup-layout-aa-rt-template.csv'), 'topup.csv');
  console.log('\nTop-Up');
  say((r.rows || []).length > 0, 'baris terbaca: ' + (r.rows || []).length);
} catch (e) { say(false, 'Top-Up throw: ' + e.message); }

/* --- Section --- */
try {
  const r = APP_GLOBAL.SECTION_PARSER.parse(read('nomor-lambung-umur-comp-section-template.csv'), 'sec.csv');
  console.log('\nSection');
  const n = (r.rows || []).length;
  say(n > 0, 'baris terbaca: ' + n);
  const first = (r.rows || [])[0] || {};
  say(!!first.section, 'section terbaca: ' + first.section);
} catch (e) { say(false, 'Section throw: ' + e.message); }

console.log('\n' + '='.repeat(60));
console.log(fail === 0 ? 'LULUS: semua template masih ter-parse.' : 'GAGAL: ' + fail + ' pemeriksaan.');
process.exit(fail === 0 ? 0 : 1);

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
  'js/sos-config.js', 'js/sos-parser.js', 'js/vhms-config.js',
  'js/vhms-profiles.js',
  'js/vhms-parser.js',
  'js/vhms-fault-parser.js',
  'js/komatsu-section.js',
  'js/vhms-loadmap.js', 'js/vhms-snapshot.js', 'js/vhms-opava.js',
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

/* --- VHMS Fault History (T7.4) — baru 2026-10-08 --- */
try {
  const r = APP_GLOBAL.VHMS_FAULT_PARSER.parseFault(read('fault-history-template.csv'));
  console.log('\nVHMS Fault History (dataType 10)');
  say(r.dataType === '10', 'dataType terdeteksi: ' + r.dataType);
  say((r.events || []).length > 0, 'event terbaca: ' + (r.events || []).length);
  say(!!(r.meta && r.meta['Machine Serial No.']), 'serial terbaca: ' + (r.meta && r.meta['Machine Serial No.']));
  say(r.smrUnreliable === true, 'flag smrUnreliable diset (From SMR tidak dipakai)');
  const withMsg = r.events.filter((e) => !!e.msg).length;
  say(withMsg === r.events.length, 'Error Message terbaca utuh pada ' + withMsg + '/' + r.events.length + ' event');
  const withEpoch = r.events.filter((e) => e.fromEpoch !== null).length;
  say(withEpoch > 0, 'From Time (epoch) terbaca pada ' + withEpoch + '/' + r.events.length + ' event');
} catch (e) { say(false, 'Fault History throw: ' + e.message); }

/* --- VHMS T/M Trend (T7.4) — baru 2026-10-08 --- */
try {
  const r = APP_GLOBAL.VHMS_PARSER.parse(read('tm-trend-template.csv'));
  console.log('\nVHMS T/M Trend (dataType 81)');
  say(r.dataType === '81', 'dataType terdeteksi: ' + r.dataType);
  say((r.records || []).length > 0, 'record terbaca: ' + (r.records || []).length);
  say(r.usedFallback === false, 'tidak jatuh ke fallback kolom trend mesin');
  const keys = ['tmTrgTimeF', 'tmTrgTimeR', 'tmTrgTime1', 'tmTrgTime2', 'tmTrgTime3',
                'tcOilOver120', 'tcOilOver130', 'tcOilOver140'];
  const filled = keys.filter((k) => (r.records || []).every((x) => x[k] !== null && x[k] !== undefined));
  say(filled.length === keys.length, '8 parameter T/M terisi: ' + filled.length + '/' + keys.length);
} catch (e) { say(false, 'T/M Trend throw: ' + e.message); }

/* --- [T14 2026-10-10] Chassis Trend PC2000 (dataType 86 = jalur trend) --- */
try {
  const r = APP_GLOBAL.VHMS_PARSER.parse(read('chas-trend-template.csv'));
  console.log('\nVHMS Chassis Trend (dataType 86)');
  say(r.dataType === '86', 'dataType terdeteksi: ' + r.dataType);
  say((r.records || []).length > 0, 'record terbaca: ' + (r.records || []).length);
  say(r.usedFallback === false, 'tidak jatuh ke fallback kolom trend mesin');
} catch (e) { say(false, 'Chassis Trend throw: ' + e.message); }

/* --- [T14] Load Map beban mesin (dataType 30) --- */
try {
  const r = APP_GLOBAL.VHMS_LOADMAP.parse(read('load-map-template.csv'), { dataType: '30' });
  console.log('\nLoad Map beban mesin (dataType 30)');
  say(r.kind === APP_GLOBAL.VHMS_LOADMAP.KIND_ENGINE_LOAD, 'jenis: ' + r.kind);
  say(r.matrix.length > 0, 'baris matriks: ' + r.matrix.length);
  say(!!r.zones && typeof r.zones.lugShare === 'number',
    'zona LUG terhitung: ' + (r.zones && r.zones.lugShare !== undefined));
  say(r.rejected !== true, 'tidak ditolak');
} catch (e) { say(false, 'Load Map throw: ' + e.message); }

/* --- [T14] Load Map torsi ALL & WORK (dataType 7F / 7E) + selisihnya --- */
try {
  const all = APP_GLOBAL.VHMS_LOADMAP.parse(read('load-map-torque-all-template.csv'), { dataType: '7F' });
  const work = APP_GLOBAL.VHMS_LOADMAP.parse(read('load-map-torque-work-template.csv'), { dataType: '7E' });
  console.log('\nLoad Map torsi pompa (dataType 7F / 7E)');
  say(all.kind === APP_GLOBAL.VHMS_LOADMAP.KIND_TORQUE_ALL, 'ALL kind: ' + all.kind);
  say(work.kind === APP_GLOBAL.VHMS_LOADMAP.KIND_TORQUE_WORK, 'WORK kind: ' + work.kind);
  const d = APP_GLOBAL.VHMS_LOADMAP.torqueDelta(all, work);
  say(!!d && typeof d.nonWorkHighTorque === 'number',
    'selisih non-kerja terhitung: ' + (d && d.nonWorkHighTorque));
} catch (e) { say(false, 'Load Map torsi throw: ' + e.message); }

/* --- [T14] Snapshot (dataType 60) --- */
try {
  const r = APP_GLOBAL.VHMS_SNAPSHOT.parse(read('snapshot-template.csv'), { dataType: '60' });
  console.log('\nSnapshot (dataType 60)');
  say(r.dataType === '60', 'dataType: ' + r.dataType);
  say(r.rowCount > 0, 'titik rekaman: ' + r.rowCount);
  say(r.columns.length > 0, 'kolom: ' + r.columns.length);
  say(!!r.summary && typeof r.summary.stuckCount === 'number',
    'kolom stuck terdeteksi: ' + (r.summary && r.summary.stuckCount));
} catch (e) { say(false, 'Snapshot throw: ' + e.message); }

/* --- [T14] Operating Availability (dataType 90) --- */
try {
  const r = APP_GLOBAL.VHMS_OPAVA.parse(read('op-availability-template.csv'), { dataType: '90' });
  console.log('\nOperating Availability (dataType 90)');
  say(r.windows.length > 0, 'jendela terbaca: ' + r.windows.length);
  say(!!r.summary && r.summary.windowCount === r.windows.length, 'ringkasan dihitung');
  say(r.summary.duty.work !== null, 'duty mode terhitung');
} catch (e) { say(false, 'Op. Availability throw: ' + e.message); }

/* --- [T2] KOMATSU_SECTION membaca blok [Data] yang sama --- */
try {
  const r = APP_GLOBAL.KOMATSU_SECTION.read(read('snapshot-template.csv'));
  console.log('\nKOMATSU_SECTION (pembaca blok bersama)');
  say(r.hasData === true, 'blok [Data] ditemukan');
  say(r.dataType.type === '60', 'dataType terbaca: ' + r.dataType.type);
  say(r.items.length > 0, 'kolom terbaca: ' + r.items.length);
} catch (e) { say(false, 'KOMATSU_SECTION throw: ' + e.message); }

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

#!/usr/bin/env node
/* =========================================================================
 * tools/verify-minify.js — Buktikan minifier TIDAK mengubah perilaku.
 * -------------------------------------------------------------------------
 * [O-8 2026-10-12]
 *
 * Minify adalah perubahan berisiko tinggi dengan imbalan kecil: kalau satu
 * berkas rusak, aplikasi mati total di produksi, dan gejalanya muncul jauh
 * dari penyebabnya. Karena itu hasil minify WAJIB dibuktikan, bukan dipercaya.
 *
 * Tiga lapis pemeriksaan:
 *   1. SINTAKS   — `new Function(src)` atas setiap berkas hasil minify.
 *                  Gagal parse = langsung ketahuan.
 *   2. KONTRAK   — muat berkas ASLI dan hasil MINIFY ke dua sandbox terpisah,
 *                  lalu bandingkan daftar global yang diekspor beserta daftar
 *                  kunci publiknya. Ini menangkap modul yang "berhasil parse"
 *                  tetapi berhenti mengekspor sesuatu.
 *   3. PERILAKU  — jalankan beberapa pemanggilan nyata pada kedua versi dan
 *                  bandingkan hasilnya. Menangkap kerusakan halus seperti
 *                  regex literal yang terpotong oleh penghapus komentar.
 *
 * Jalankan: node tools/verify-minify.js
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { minify } = require('./minify-js.js');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');

let failures = 0;
function fail(msg) { failures++; console.error('  GAGAL: ' + msg); }

/* ---------------- Sandbox minimal: cukup untuk memuat modul ---------------- */
function makeSandbox() {
  const g = {};
  g.window = g;
  g.globalThis = g;
  g.console = { log() {}, warn() {}, error() {} };
  const ls = {};
  g.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
    clear: () => { for (const k in ls) delete ls[k]; }
  };
  g.sessionStorage = g.localStorage;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;
  g.Intl = Intl;
  const el = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null
  });
  g.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: el, addEventListener() {}, removeEventListener() {},
    body: el(), documentElement: el()
  };
  return g;
}

/** Muat daftar berkas ke sandbox. `transform` dipakai untuk versi minify. */
function loadAll(files, transform) {
  const sandbox = makeSandbox();
  const ctx = vm.createContext(sandbox);
  for (const f of files) {
    let src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    if (transform) src = transform(src);
    // `module`/`exports` disediakan agar cabang `module.exports` modul aman.
    const wrapped = '(function(module, exports){' + src + '\n})({exports:{}},{})';
    try {
      vm.runInContext(wrapped, ctx, { filename: f });
    } catch (e) {
      fail((transform ? '[minify] ' : '[asli] ') + f + ' -> ' + e.message);
      return null;
    }
  }
  return sandbox;
}

/* Modul yang murni logika (tanpa kebutuhan DOM saat dimuat). Cukup untuk
   membuktikan penghapus komentar aman; modul render diuji sintaksnya saja. */
const LOGIC = [
  'csv-util.js', 'ui-util.js', 'model-match.js',
  'sos-config.js', 'sos-analytics.js',
  'vhms-config.js', 'vhms-profiles.js', 'vhms-parser.js',
  'vhms-fault-parser.js', 'komatsu-section.js',
  'vhms-loadmap.js', 'vhms-snapshot-knowledge.js', 'vhms-snapshot.js',
  'vhms-opava.js', 'vhms-clutch.js', 'vhms-analytics.js'
];

function publicShape(sandbox) {
  const shape = {};
  Object.keys(sandbox)
    .filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k))
    .sort()
    .forEach((k) => {
      const v = sandbox[k];
      shape[k] = v && typeof v === 'object' ? Object.keys(v).sort().join(',') : typeof v;
    });
  return shape;
}

/* -------------------------------------------------------------------------
 * Lapis 0 — KASUS BERMUSUHAN sintetis.
 *
 * Ditambahkan setelah temuan jujur: versi pertama verifier ini LOLOS meski
 * penanganan regex-literal pada minifier sengaja dimatikan. Sebabnya, tidak
 * ada modul di `js/` yang saat ini memuat regex berisi `//` atau `/*`. Jadi
 * lapis 1-3 hanya membuktikan "aman untuk kode HARI INI", bukan "minifier
 * benar". Kasus di bawah menguji pemindainya secara langsung, sehingga
 * kerusakan tertangkap SEBELUM ada yang menulis kode seperti itu.
 * ----------------------------------------------------------------------- */
const HOSTILE = [
  {
    label: 'regex berisi // tidak boleh dianggap komentar',
    src: 'var re = /https?:\\/\\//; out = re.test("http://a") ? "Y" : "N";',
    expect: 'Y'
  },
  {
    label: 'regex berisi /* tidak boleh membuka komentar blok',
    src: 'var re = /a\\/\\*b/; out = re.test("a/*b") ? "Y" : "N";',
    expect: 'Y'
  },
  {
    label: 'kelas karakter berisi / aman',
    src: 'out = " a/b ".replace(/[\\s._\\-/]+/g, "");',
    expect: 'ab'
  },
  {
    label: 'string berisi // tidak boleh terpotong',
    src: 'out = "lihat //bukan-komentar";',
    expect: 'lihat //bukan-komentar'
  },
  {
    label: 'string berisi /* tidak boleh terpotong',
    src: 'out = "a /* bukan komentar */ b";',
    expect: 'a /* bukan komentar */ b'
  },
  {
    label: 'template literal berisi // aman',
    src: 'var x = 1; out = `nilai ${x} //akhir`;',
    expect: 'nilai 1 //akhir'
  },
  {
    label: 'pembagian setelah tanda kurung bukan regex',
    src: 'out = String((10) / 2 / 1);',
    expect: '5'
  },
  {
    label: 'komentar sesudah kode tetap dibuang',
    src: 'out = "v"; // komentar ini harus hilang',
    expect: 'v'
  },
  {
    label: 'kelas karakter berisi kutip tidak membuka string',
    src: 'out = `a\'b"c`.replace(/[\'"]/g, "");',
    expect: 'abc'
  }
];

function runHostile() {
  console.log('0. Kasus bermusuhan (' + HOSTILE.length + ')');
  let ok = 0;
  for (const t of HOSTILE) {
    const minified = minify(t.src);
    // 1) hasil minify harus masih memuat konstruksi yang sama secara perilaku
    let got;
    try {
      // Newline WAJIB: bila cuplikan diakhiri komentar `//`, menyambung
      // `; return out;` di baris yang sama akan ikut terkomentari.
      got = new Function('var out;\n' + minified + '\nreturn out;')();
    } catch (e) {
      fail(t.label + ' -> tidak dapat diparse: ' + e.message + '\n    minify: ' + minified.trim());
      continue;
    }
    if (String(got) !== t.expect) {
      fail(t.label + '\n    harap : ' + t.expect + '\n    dapat : ' + got +
        '\n    minify: ' + minified.trim());
      continue;
    }
    // 2) dan harus sama dengan hasil versi ASLI (pembanding sejati)
    let orig;
    try { orig = new Function('var out;\n' + t.src + '\nreturn out;')(); } catch (e) { orig = 'ERR'; }
    if (String(orig) !== String(got)) {
      fail(t.label + ' -> berbeda dari versi asli (' + orig + ' vs ' + got + ')');
      continue;
    }
    ok++;
  }
  console.log('   ' + ok + '/' + HOSTILE.length + ' lulus');
}

function main() {
  const allFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();

  runHostile();

  /* ---- Lapis 1: setiap berkas hasil minify harus bisa diparse ---- */
  console.log('1. Sintaks (' + allFiles.length + ' berkas)');
  let origBytes = 0, minBytes = 0;
  for (const f of allFiles) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const out = minify(src);
    origBytes += Buffer.byteLength(src);
    minBytes += Buffer.byteLength(out);
    try {
      new Function(out);
    } catch (e) {
      fail(f + ' tidak dapat diparse setelah minify -> ' + e.message);
    }
  }
  const saved = (100 * (1 - minBytes / origBytes)).toFixed(1);
  console.log('   ' + (origBytes / 1024).toFixed(0) + ' KB -> ' +
    (minBytes / 1024).toFixed(0) + ' KB (hemat ' + saved + '%)');

  /* ---- Lapis 2: kontrak global harus identik ---- */
  console.log('2. Kontrak global (' + LOGIC.length + ' modul logika)');
  const a = loadAll(LOGIC, null);
  const b = loadAll(LOGIC, minify);
  if (a && b) {
    const sa = publicShape(a), sb = publicShape(b);
    const ka = Object.keys(sa), kb = Object.keys(sb);
    if (ka.join('|') !== kb.join('|')) {
      fail('daftar global berbeda.\n    asli   : ' + ka.join(',') + '\n    minify : ' + kb.join(','));
    } else {
      ka.forEach((k) => {
        if (sa[k] !== sb[k]) fail('kunci publik ' + k + ' berbeda setelah minify');
      });
      console.log('   ' + ka.length + ' global, bentuk publik identik');
    }
  }

  /* ---- Lapis 3: perilaku nyata harus sama ---- */
  console.log('3. Perilaku');
  if (a && b) {
    const probes = [
      ['CSV_UTIL.splitLine kutip', (g) => JSON.stringify(g.CSV_UTIL.splitLine('a,"b,c",d'))],
      ['CSV_UTIL.toNum id-ID', (g) => String(g.CSV_UTIL.toNum('1.234,5'))],
      ['CSV_UTIL.toNumStrict tolak sampah', (g) => String(g.CSV_UTIL.toNumStrict('12abc'))],
      ['CSV_UTIL.normHeader regex', (g) => g.CSV_UTIL.normHeader(' Engine Oil Press (H) %')],
      ['CSV_UTIL.csvEscape', (g) => g.CSV_UTIL.csvEscape('a;b"c')],
      ['UI_UTIL.fmt locale', (g) => g.UI_UTIL.fmt(1234.5, 1)],
      ['UI_UTIL.fmtRate kecil', (g) => g.UI_UTIL.fmtRate(0.0005)],
      ['UI_UTIL.esc XSS', (g) => g.UI_UTIL.esc('<img src=x onerror="y">')],
      ['MODEL_MATCH', (g) => String(g.MODEL_MATCH && typeof g.MODEL_MATCH.normalizeModel)],
      ['VHMS_OPAVA.isOpAvaType', (g) => String(g.VHMS_OPAVA.isOpAvaType('90'))],
      ['VHMS_OPAVA.parseEpochField', (g) => JSON.stringify(g.VHMS_OPAVA.parseEpochField('1750000000|9|0'))]
    ];
    let ok = 0;
    for (const [label, fn] of probes) {
      let ra, rb;
      try { ra = fn(a); } catch (e) { ra = 'ERR:' + e.message; }
      try { rb = fn(b); } catch (e) { rb = 'ERR:' + e.message; }
      if (ra !== rb) fail(label + '\n    asli   : ' + ra + '\n    minify : ' + rb);
      else if (String(ra).startsWith('ERR:')) fail(label + ' melempar di KEDUA versi -> ' + ra);
      else ok++;
    }
    console.log('   ' + ok + '/' + probes.length + ' pemanggilan menghasilkan nilai identik');
  }

  console.log('');
  if (failures) {
    console.error(failures + ' pemeriksaan GAGAL — JANGAN pakai hasil minify.');
    process.exit(1);
  }
  console.log('Minifier aman: sintaks, kontrak global, dan perilaku identik.');
}

main();

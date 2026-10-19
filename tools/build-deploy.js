#!/usr/bin/env node
/* =========================================================================
 * tools/build-deploy.js — Menyalin HANYA aset runtime ke folder `dist/`.
 * -------------------------------------------------------------------------
 * MASALAH YANG DISELESAIKAN
 *   Repo berisi folder yang tidak dipakai di production (`docs/`, `tools/`,
 *   `test/`, `sample-data/`). Menghapusnya dari repo = membuang test suite
 *   (regression gate) & dokumentasi. Yang benar: repo tetap lengkap,
 *   yang DI-DEPLOY cuma runtime.
 *
 * PAKAI
 *   node tools/build-deploy.js        -> membuat ./dist
 *   Unggah ISI folder `dist/` ke web server. Selesai.
 *
 * CATATAN
 *   `dist/` sudah ada di .gitignore, jadi hasil build tidak masuk repo.
 *   `serve.js` TIDAK disertakan: itu server uji lokal, bukan runtime web.
 *
 * ponytail: daftar RUNTIME di bawah ditulis manual (eksplisit > ajaib).
 *   Kalau nanti menambah folder aset runtime baru, tambahkan di sini.
 *   Dijaga oleh pemeriksaan referensi index.html di bawah — build GAGAL
 *   bila ada aset yang dirujuk index.html tapi tidak ikut tersalin.
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { minify } = require('./minify-js.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* [O-8 2026-10-12] Minify HANYA bila diminta: `node tools/build-deploy.js --minify`.
   Sengaja opt-in, bukan default. Alasannya jujur: imbalannya sedang (~37%)
   sementara kerusakannya total bila salah, dan `dist/` tanpa minify selalu
   byte-identik dengan sumber yang sudah diuji 239 kali oleh `npm test`.
   Jalankan `node tools/verify-minify.js` sebelum memakai hasilnya. */
const MINIFY = process.argv.includes('--minify');

/* Aset yang BENAR-BENAR dimuat browser. */
const RUNTIME = ['index.html', 'js', 'css', 'vendor', 'assets'];

/* Sengaja TIDAK ikut (tetap ada di repo): docs, tools, test, sample-data,
   serve.js, package.json, README.md, .gitignore. */

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // Penyebab paling umum di Windows: ada proses yang memegang folder
    // (mis. `node serve.js` dijalankan DARI dalam dist/, atau folder terbuka
    // di Explorer). Beri pesan yang bisa ditindaklanjuti, bukan stack trace.
    console.error('GAGAL membersihkan ' + path.relative(ROOT, p) + '/ -> ' + e.code);
    console.error('Folder sedang dipakai proses lain. Tutup server/Explorer yang');
    console.error('membuka folder itu, lalu jalankan ulang `npm run build`.');
    process.exit(1);
  }
}

let fileCount = 0;
let byteCount = 0;

let minifiedCount = 0;
let minifiedSaved = 0;

function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (MINIFY && src.endsWith('.js') && !src.includes('vendor')) {
    // vendor/ dikecualikan: berkas itu SUDAH ter-minify oleh pembuatnya.
    const original = fs.readFileSync(src, 'utf8');
    const out = minify(original);
    // GERBANG KESELAMATAN: berkas yang tidak dapat diparse TIDAK ikut dikirim.
    // Lebih baik gagal di build daripada aplikasi mati di produksi.
    try {
      new Function(out);
    } catch (e) {
      console.error('GAGAL minify ' + path.relative(ROOT, src) + ' -> ' + e.message);
      console.error('Jalankan `node tools/verify-minify.js` untuk menelusuri.');
      process.exit(1);
    }
    fs.writeFileSync(dest, out, 'utf8');
    minifiedCount++;
    minifiedSaved += Buffer.byteLength(original) - Buffer.byteLength(out);
    fileCount++;
    byteCount += Buffer.byteLength(out);
    return;
  }

  fs.copyFileSync(src, dest);
  fileCount++;
  byteCount += st.size;
}

/* ---------- Jaring pengaman: setiap aset yang dirujuk index.html WAJIB ada
     di dist. Mencegah "lupa menambah folder baru ke RUNTIME". ---------- */
function verifyReferences() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = new Set();
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let ref = m[1];
    if (/^(https?:|data:|mailto:|#|\/\/)/i.test(ref)) continue;
    ref = ref.split('?')[0].split('#')[0];
    if (!ref) continue;
    refs.add(ref.replace(/^\.?\//, ''));
  }
  const missing = [...refs].filter((r) => !fs.existsSync(path.join(DIST, r)));
  return { checked: refs.size, missing };
}

function main() {
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  for (const item of RUNTIME) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      console.error('GAGAL: aset runtime tidak ditemukan -> ' + item);
      process.exit(1);
    }
    copy(src, path.join(DIST, item));
  }

  const { checked, missing } = verifyReferences();
  if (missing.length) {
    console.error('\nGAGAL: ' + missing.length + ' aset dirujuk index.html tapi TIDAK ada di dist/:');
    missing.forEach((f) => console.error('  - ' + f));
    console.error('\nTambahkan folder-nya ke daftar RUNTIME di tools/build-deploy.js.');
    process.exit(1);
  }

  console.log('dist/ siap deploy.');
  console.log('  berkas    : ' + fileCount);
  console.log('  ukuran    : ' + (byteCount / 1024).toFixed(1) + ' KB');
  console.log('  referensi : ' + checked + ' diperiksa, 0 hilang');
  if (MINIFY) {
    console.log('  minify    : ' + minifiedCount + ' berkas JS, hemat ' +
      (minifiedSaved / 1024).toFixed(0) + ' KB');
  } else {
    console.log('  minify    : tidak (pakai --minify untuk mengaktifkan)');
  }
  console.log('\nUnggah ISI folder dist/ ke web server.');
  console.log('Catatan: aktifkan gzip/brotli di web server — penghematannya');
  console.log('lebih besar daripada minify dan tanpa risiko mengubah kode.');
}

main();

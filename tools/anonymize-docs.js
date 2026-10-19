#!/usr/bin/env node
/* =========================================================================
 * tools/anonymize-docs.js — Menyamarkan nomor lambung asli yang tersisa
 * di berkas DOKUMENTASI (docs/*.md).
 * -------------------------------------------------------------------------
 * KENAPA
 *   Setelah template dianonimkan, nomor lambung nyata masih melekat di
 *   dokumen contoh (mis. tabel kasus di DOCS/spek). Repo publik tidak boleh
 *   memuat identitas unit armada, sekalipun hanya di dalam tabel spek.
 *
 * PEMETAAN
 *   Memakai algoritma yang SAMA dengan tools/anonymize-samples.js sehingga
 *   hasilnya konsisten antara dokumen dan template: nomor lambung yang sama
 *   di kedua tempat menghasilkan pseudonim yang sama.
 *
 * CATATAN
 *   Nama lab/dealer (Intertek, Trakindo) TIDAK diubah: itu nama perusahaan
 *   pihak ketiga yang lazim, disebut sebagai FORMAT EKSPOR yang didukung
 *   aplikasi — bukan data pelanggan.
 *
 * PAKAI
 *   node tools/anonymize-docs.js --check
 *   node tools/anonymize-docs.js
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const CHECK = process.argv.includes('--check');

/* Pola nomor lambung: PREFIKS HURUF + ANGKA (mis. TEST1234). */
const UNIT_RE = /\b([A-Z]{2,6})(\d{4,6})\b/g;

/* HANYA prefiks yang dikenal sebagai kode armada. Daftar ini mencegah
   salah-tangkap pada istilah teknis (mis. ISO4406, SAE30, PC14U). */
const UNIT_PREFIX = /^(HDKM|HDCT|HDMR|EXKM|EXCT|GDKM|DTVV|DTV|ACAT|BDKM|GSYA|GSPR|EHKM)$/;

/* Hash deterministik (FNV-1a) — identik dengan anonymize-samples.js. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function digits(seed, n) {
  let out = ''; let h = hash(seed);
  while (out.length < n) { out += String(h % 10); h = hash(seed + out); }
  return out.slice(0, n);
}
function fakeUnit(u) {
  const m = /^([A-Z]+)(\d+)$/.exec(u);
  return m ? m[1] + digits('unit\u0000' + u, m[2].length) : u;
}

let total = 0;
if (!fs.existsSync(DOCS)) { console.error('GAGAL: docs/ tidak ditemukan.'); process.exit(1); }

for (const f of fs.readdirSync(DOCS).filter((x) => /\.md$/i.test(x))) {
  const p = path.join(DOCS, f);
  const before = fs.readFileSync(p, 'utf8');
  let changed = 0;
  const after = before.replace(UNIT_RE, (all, pre, num) => {
    if (!UNIT_PREFIX.test(pre)) return all;
    changed++;
    return fakeUnit(pre + num);
  });
  if (!changed) continue;
  total += changed;
  if (!CHECK) fs.writeFileSync(p, after, 'utf8');
  console.log('  ' + (CHECK ? '[periksa] ' : '') + f + ': ' + changed + ' nomor lambung');
}

console.log('\nTotal: ' + total + ' nomor lambung ' + (CHECK ? 'perlu disamarkan.' : 'disamarkan.'));
if (!total) console.log('Dokumen sudah bersih.');
if (CHECK && total) process.exit(1);

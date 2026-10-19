#!/usr/bin/env node
/* =========================================================================
 * tools/make-vhms-extras-templates.js
 * -------------------------------------------------------------------------
 * Membangun template KECIL untuk dua jenis file VHMS yang baru didukung:
 *   - `fault-history-template.csv`  (Data Type 10 — Fault History)
 *   - `tm-trend-template.csv`       (Data Type 81 — T/M Trend)
 *
 * Dari mana sumbernya? File contoh NYATA disimpan di luar repo (mis.
 * `d:\20261006\CHK0001\fault0.CSV`). Skrip ini mengambil hanya BEBERAPA
 * baris data pertama, lalu MENGANONIMKAN identitasnya.
 *
 * PRINSIP (sama dengan tools/anonymize-samples.js):
 *   1. STRUKTUR TIDAK BERUBAH — header, urutan kolom, delimiter, kutip, dan
 *      bentuk baris tetap sama persis; parser tidak melihat beda selain nilai.
 *   2. DETERMINISTIK — nilai sama -> pseudonim sama (FNV-1a), sehingga bisa
 *      diulang tanpa menghasilkan diff yang berisik.
 *   3. ANGKA TEKNIS TIDAK DISENTUH — SMR, Trg. Time, TC Oil T., Count, dst.
 *      tetap asli agar pengujian ambang & scoring tetap realistis.
 *
 * PAKAI:
 *   node tools/make-vhms-extras-templates.js --check   # lapor saja
 *   node tools/make-vhms-extras-templates.js           # tulis
 *
 * Variabel lingkungan:
 *   VHMS_SRC_DIR  direktori file contoh (default `d:\20261006\CHK0001`)
 *   VHMS_TMPL_ROWS jumlah baris data contoh (default 8)
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DST = path.join(ROOT, 'sample-data', 'templates');
const SRC = process.env.VHMS_SRC_DIR || 'd:\\20261006\\CHK0001';
const N_ROWS = Number(process.env.VHMS_TMPL_ROWS || 8);
const CHECK_ONLY = process.argv.includes('--check');

/* --------------------------------------------------------------- pseudonim */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function digits(seed, len) {
  let out = '', h = hash(seed);
  while (out.length < len) { out += String(h % 10); h = hash(seed + out); }
  return out.slice(0, len);
}
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function alnum(seed, len) {
  let out = '', h = hash(seed);
  while (out.length < len) { out += ALNUM[h % ALNUM.length]; h = hash(seed + out); }
  return out.slice(0, len);
}
const MAP = new Map();
function pseudo(value, kind) {
  const key = kind + '\u0000' + value;
  if (MAP.has(key)) return MAP.get(key);
  let out;
  if (kind === 'serial') {
    /* Pertahankan panjang & kelas karakter per posisi (huruf tetap huruf). */
    out = value.replace(/[A-Za-z]/g, (c, i) => alnum(key + 'a' + i, 1))
               .replace(/\d/g, (c, i) => digits(key + 'd' + i, 1));
  } else if (kind === 'unit') {
    /* Nomor lambung: pertahankan prefiks HURUF, ganti angka. */
    const m = /^([A-Za-z]*)(\d+)(.*)$/.exec(value);
    out = m ? m[1] + digits(key, m[2].length) + m[3] : alnum(key, Math.max(4, value.length));
  } else {
    out = alnum(key, Math.max(4, value.length));
  }
  MAP.set(key, out);
  return out;
}

/* Baris identitas blok header VHMS yang perlu disamarkan. */
function scrubHeaderLine(line) {
  const idx = line.indexOf(',');
  if (idx < 0) return line;
  const key = line.slice(0, idx).trim();
  const parts = line.slice(idx + 1).split(',');

  switch (key) {
    /* Model dipakai untuk identitas & pemilihan profil -> disamarkan, TETAPI
       Product Group dipertahankan apa adanya (bukan identitas unit). */
    case 'Machine Serial No.':
      return key + ',' + pseudo(parts[0].trim(), 'serial');
    case 'Machine Model':
      return key + ',' + pseudo(parts[0].trim(), 'serial');
    case 'Comment':
      /* Komentar memuat nomor lambung + tanggal -> samarkan bagian pertama
         saja, sisanya (tanggal) dipertahankan agar konteks waktu tetap ada. */
      parts[0] = pseudo(parts[0].trim(), 'unit');
      return key + ',' + parts.join(',');
    case 'Engine Model & Serial No.1 2 3':
      /* parts[0] = model engine (BUKAN identitas) -> dipertahankan.
         parts[1..] = nomor seri engine -> disamarkan. */
      for (let k = 1; k < parts.length; k++) {
        if (parts[k].trim()) parts[k] = pseudo(parts[k].trim(), 'serial');
      }
      return key + ',' + parts.join(',');
    default:
      return line;
  }
}

/* ------------------------------------------------------------------ build */
function build(srcFile, dstFile) {
  const srcPath = path.join(SRC, srcFile);
  if (!fs.existsSync(srcPath)) {
    console.log('  LEWATI ' + srcFile + ' — tidak ada di ' + SRC);
    return { skipped: true };
  }
  const text = fs.readFileSync(srcPath, 'utf8');
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  const dataIdx = lines.findIndex((l) => /^\s*\[Data\]\s*$/i.test(l));
  if (dataIdx < 0) throw new Error('Tanpa [Data]: ' + srcFile);

  /* Header = SELURUH baris sebelum [Data] (termasuk baris label kolom).
     Baris kosong tepat sebelum [Data] dibuang agar tidak ada baris ganda. */
  const head = lines.slice(0, dataIdx);
  while (head.length && head[head.length - 1].trim() === '') head.pop();

  const body = lines.slice(dataIdx + 1).filter((l) => l.trim() !== '');
  const rows = body.slice(0, N_ROWS);

  const outHead = head.map(scrubHeaderLine);
  const out = outHead.concat(['[Data]'], rows, ['']).join(eol);

  /* Jaring pengaman: struktur wajib tetap valid. */
  const dataMarkers = (out.match(/^\s*\[Data\]\s*$/gim) || []).length;
  if (dataMarkers !== 1) throw new Error('Jumlah [Data] harus 1, dapat ' + dataMarkers);

  if (!CHECK_ONLY) fs.writeFileSync(path.join(DST, dstFile), out, 'utf8');
  console.log('  ' + srcFile + ' -> ' + dstFile +
    '  (' + rows.length + ' baris data, ' + outHead.length + ' baris header)');
  return { skipped: false };
}

console.log('Templat VHMS tambahan — sumber: ' + SRC);
console.log(CHECK_ONLY ? '(MODE PERIKSA — tidak menulis)\n' : '');
build('fault0.CSV', 'fault-history-template.csv');
build('tm_trend0.CSV', 'tm-trend-template.csv');
// [PC2000 2026-10-10 — T14] Sumber data tambahan PC2000. Struktur (header,
// kolom, jumlah baris) tidak berubah; hanya identitas yang disamarkan.
build('chas_trend0.CSV', 'chas-trend-template.csv');
build('loadm0.CSV', 'load-map-template.csv');
build('loadmop0.CSV', 'load-map-torque-all-template.csv');
build('loadmwork0.CSV', 'load-map-torque-work-template.csv');
build('snap00.CSV', 'snapshot-template.csv');
build('op_ava0.CSV', 'op-availability-template.csv');
console.log('\nPseudonim unik: ' + MAP.size);
console.log('Struktur (header, kolom, jumlah baris) tidak berubah; angka teknis utuh.');

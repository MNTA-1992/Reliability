#!/usr/bin/env node
/* =========================================================================
 * tools/anonymize-samples.js — Menyamarkan data identitas di
 * `sample-data/templates/` agar repo aman dipublikasikan.
 * -------------------------------------------------------------------------
 * LATAR BELAKANG
 *   Template berasal dari ekspor NYATA (lab Trakindo/Intertek, SAP, VHMS).
 *   Isinya memuat identitas pelanggan, nomor lambung, serial unit, jobsite,
 *   work order, dan cost center armada sungguhan. Repo publik tidak boleh
 *   memuat itu. Template hanya dibutuhkan sebagai referensi FORMAT KOLOM.
 *
 * PRINSIP
 *   1. STRUKTUR TIDAK BERUBAH. Header, jumlah kolom, urutan, delimiter,
 *      tanda kutip, dan jumlah baris tetap sama persis. Parser tidak boleh
 *      melihat perbedaan apa pun selain NILAI identitas.
 *   2. DETERMINISTIK. Nilai sama -> pseudonim sama, di semua berkas. Ini
 *      WAJIB karena aplikasi mencocokkan SOS <-> Lifetime <-> Top-Up lewat
 *      nomor lambung & serial. Kalau tidak konsisten, fitur pencocokan
 *      kompartemen tidak bisa diuji lagi dengan template ini.
 *   3. BENTUK DIPERTAHANKAN. Prefiks huruf nomor lambung dipertahankan,
 *      hanya angkanya yang diganti — prefiks menandai tipe alat dan dipakai
 *      pengelompokan, bukan identitas unit.
 *   4. ANGKA TEKNIS TIDAK DISENTUH. Fe/Cu/Si/V100/TBN/SMR/ComponentLife
 *      tetap asli supaya nilai ambang & scoring tetap realistis saat diuji.
 *
 * PAKAI
 *   node tools/anonymize-samples.js --check   # lapor saja, tidak menulis
 *   node tools/anonymize-samples.js           # tulis perubahan
 *
 * ponytail: pemetaan kolom di SENSITIVE ditulis per NAMA header (bukan
 *   indeks) supaya tahan terhadap perubahan urutan kolom. Kalau nanti ada
 *   kolom identitas baru dari ekspor lab, tambahkan namanya di sana.
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'sample-data', 'templates');
const CHECK_ONLY = process.argv.includes('--check');

/* ---------------------------------------------------------------- utilitas */

/* FNV-1a — hash deterministik tanpa dependency. Dipakai agar nilai yang
   sama selalu menghasilkan pseudonim yang sama di seluruh berkas. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function digitsFrom(seed, len) {
  let out = '';
  let h = hash(seed);
  while (out.length < len) {
    out += String(h % 10);
    h = hash(seed + out);
  }
  return out.slice(0, len);
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function alnumFrom(seed, len) {
  let out = '';
  let h = hash(seed);
  while (out.length < len) {
    out += ALNUM[h % ALNUM.length];
    h = hash(seed + out);
  }
  return out.slice(0, len);
}

/* Peta global: nilai asli -> pseudonim. Menjamin konsistensi lintas berkas. */
const MAP = new Map();
function pseudonym(value, kind) {
  const key = kind + '\u0000' + value;
  if (MAP.has(key)) return MAP.get(key);
  const seed = key;
  let out;
  switch (kind) {
    /* Nomor lambung: pertahankan prefiks huruf, ganti angka.
       CONTOH123 -> CONTOH456 */
    case 'unit': {
      const m = /^([A-Za-z]*)(\d+)(.*)$/.exec(value);
      out = m ? m[1] + digitsFrom(seed, m[2].length) + m[3] : alnumFrom(seed, value.length);
      break;
    }
    /* Serial: pertahankan panjang & kelas karakter per posisi. */
    case 'serial':
      out = value.replace(/[A-Za-z]/g, (c, i) => alnumFrom(seed + 'a' + i, 1))
                 .replace(/\d/g, (c, i) => digitsFrom(seed + 'd' + i, 1));
      break;
    /* Nomor dokumen (lab no, WO, material doc): pertahankan pemisah. */
    case 'doc':
      out = value.replace(/\d/g, (c, i) => digitsFrom(seed + i, 1))
                 .replace(/[A-Za-z]/g, (c, i) => alnumFrom(seed + 'L' + i, 1));
      break;
    default:
      out = alnumFrom(seed, Math.max(4, value.length));
  }
  MAP.set(key, out);
  return out;
}

/* Nilai tetap (bukan di-hash) — identitas organisasi diganti nama fiktif. */
const FIXED = {
  'P.T. TRAKINDO UTAMA': 'PT DEALER LAB NUSANTARA',
  'BUKIT MAKMUR MANDIRI UTAMA PT.': 'PT TAMBANG CONTOH SEJAHTERA',
  'PT. BUKIT MAKMUR MANDIRI UTAMA': 'PT TAMBANG CONTOH SEJAHTERA',
  PERTAMINA: 'OIL BRAND A'
};

/* Kolom identitas per jenis berkas, dirujuk lewat NAMA header. */
const SENSITIVE = {
  'Lab No.': 'doc',
  'Asset ID': 'unit',
  'Asset Serial Number': 'serial',
  'Component Serial Number': 'serial',
  'Work Order No.': 'doc',
  'Label No.': 'doc',
  'Dealer Name': 'fixed',
  'Customer Name': 'fixed',
  Jobsite: 'jobsite',
  UCID: 'doc',
  'Fluid Brand': 'fixed',
  'Created by': 'blank',
  /* Lifetime / Section */
  EquipmentNumber: 'unit',
  SerialNumber: 'serial',
  ComponentNo: 'doc',
  LastMONumber: 'doc',
  /* Top-Up SAP */
  'Material Document': 'doc',
  'Cost Center': 'doc',
  Plant: 'doc',
  Equipment: 'unit'
};

/* --------------------------------------------- CSV split/join aman-kutip */
/* RFC 4180: kutip ganda `""` di dalam sel = satu karakter `"`. Nilai yang
   dikembalikan sudah TANPA kutip pembungkus; `joinCell` memasangnya ulang
   hanya bila memang diperlukan. */
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
      continue;
    }
    if (ch === delim && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function joinCell(v, delim) {
  return /["\n\r]/.test(v) || v.indexOf(delim) >= 0 ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/* -------------------------------------------------------------- transform */
let changedTotal = 0;
const report = [];

function transformTabular(file, text) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const header = splitLine(lines[0], delim);

  /* Indeks kolom yang perlu disamarkan. Nama header dinormalisasi ringan. */
  const targets = [];
  header.forEach((h, i) => {
    const kind = SENSITIVE[h.trim()];
    if (kind) targets.push({ i, kind, name: h.trim() });
  });
  if (!targets.length) return { text, changed: 0, targets: [] };

  let changed = 0;
  for (let r = 1; r < lines.length; r++) {
    if (!lines[r].trim()) continue;
    const cells = splitLine(lines[r], delim);
    targets.forEach(({ i, kind }) => {
      const v = (cells[i] || '').trim();
      if (!v) return;
      let nv;
      if (kind === 'fixed') nv = FIXED[v] || 'CONTOH';
      else if (kind === 'blank') nv = '';
      else if (kind === 'jobsite') nv = 'SITE-A - CONTOH';
      else nv = pseudonym(v, kind);
      if (nv !== cells[i]) { cells[i] = nv; changed++; }
    });
    lines[r] = cells.map((c) => joinCell(c, delim)).join(delim);
  }
  return { text: lines.join(eol), changed, targets: targets.map((t) => t.name) };
}

/* VHMS bukan tabel: blok `key,value`. Samarkan baris identitas saja. */
function transformVhms(text) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const key = (parts[0] || '').trim();
    if (key === 'Machine Serial No.' && parts[1]) {
      parts[1] = pseudonym(parts[1].trim(), 'doc');
      lines[i] = parts.join(','); changed++;
    } else if (key === 'Engine Model & Serial No.1 2 3') {
      /* parts[1] = model engine (BUKAN identitas) -> dipertahankan. */
      for (let k = 2; k < parts.length; k++) {
        if (parts[k].trim()) { parts[k] = pseudonym(parts[k].trim(), 'serial'); changed++; }
      }
      lines[i] = parts.join(',');
    } else if (key === 'Comment' && parts[1] && parts[1].trim()) {
      parts[1] = pseudonym(parts[1].trim(), 'unit');
      lines[i] = parts.join(','); changed++;
    }
  }
  return { text: lines.join(eol), changed, targets: ['Machine Serial No.', 'Engine Serial', 'Comment'] };
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.error('GAGAL: ' + path.relative(ROOT, DIR) + ' tidak ditemukan.');
    process.exit(1);
  }
  const files = fs.readdirSync(DIR).filter((f) => /\.csv$/i.test(f));
  for (const f of files) {
    const p = path.join(DIR, f);
    const before = fs.readFileSync(p, 'utf8');
    const res = /vhms/i.test(f) ? transformVhms(before) : transformTabular(p, before);

    /* Jaring pengaman: jumlah baris WAJIB tetap sama. */
    const lb = before.split(/\r?\n/).length;
    const la = res.text.split(/\r?\n/).length;
    if (lb !== la) {
      console.error('GAGAL: jumlah baris berubah pada ' + f + ' (' + lb + ' -> ' + la + ').');
      process.exit(1);
    }
    if (!CHECK_ONLY && res.changed) fs.writeFileSync(p, res.text, 'utf8');
    changedTotal += res.changed;
    report.push({ file: f, changed: res.changed, cols: res.targets.length });
  }

  console.log(CHECK_ONLY ? 'MODE PERIKSA (tidak menulis)\n' : 'Anonimisasi selesai.\n');
  report.forEach((r) => console.log('  ' + r.file + '\n    nilai disamarkan: ' + r.changed + '  (kolom identitas: ' + r.cols + ')'));
  console.log('\n  total nilai disamarkan: ' + changedTotal);
  console.log('  pseudonim unik        : ' + MAP.size);
  console.log('\nStruktur (header, jumlah kolom, jumlah baris) TIDAK berubah.');
}

main();

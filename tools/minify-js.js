#!/usr/bin/env node
/* =========================================================================
 * tools/minify-js.js — Pengecil berkas JS yang KONSERVATIF, tanpa dependensi.
 * -------------------------------------------------------------------------
 * [O-8 2026-10-12]
 *
 * MENGAPA BUKAN TERSER/ESBUILD
 *   Aplikasi ini 100% statis dan dijalankan di jaringan tambang. Menambah
 *   dependensi build (puluhan MB node_modules) untuk memangkas ~300 KB tidak
 *   sebanding, dan menambah permukaan rawat. Yang dibutuhkan cuma membuang
 *   komentar & indentasi — itu sudah menghapus sebagian besar berat, karena
 *   basis kode ini SANGAT banyak komentar penjelas (memang disengaja).
 *
 * APA YANG DILAKUKAN (hanya ini, sengaja)
 *   1. Buang komentar blok dan komentar baris.
 *   2. Buang indentasi awal baris & spasi akhir baris.
 *   3. Buang baris yang menjadi kosong.
 *
 * APA YANG TIDAK DILAKUKAN (dan alasannya)
 *   - TIDAK mengubah nama variabel. Modul ini memakai pola IIFE + `global.*`;
 *     mengubah nama berisiko merusak kontrak antar-modul.
 *   - TIDAK menggabungkan berkas (bundling). Urutan muat skrip global itu
 *     bermakna; menggabungkan berisiko mengubah urutan inisialisasi.
 *   - TIDAK menyatukan baris menjadi satu. Newline dipertahankan supaya
 *     Automatic Semicolon Insertion (ASI) tetap berperilaku sama. Ini
 *     keputusan keamanan, bukan kelalaian.
 *
 * MENGAPA PERLU PEMINDAI, BUKAN REGEX
 *   Membuang komentar dengan regex adalah bug klasik: `'https://x'` di dalam
 *   string akan terpotong menjadi `'https:`. Begitu juga `/[/*]/` (regex
 *   literal) dan template literal berisi `//`. Karena itu di bawah dipakai
 *   pemindai karakter yang melacak keadaan: string ' " `, regex literal, dan
 *   komentar. Lebih panjang, tetapi benar.
 *
 * ponytail: tanpa pengubahan nama variabel, penghematan berhenti di sekitar
 *   40-50%. Bila nanti butuh lebih kecil, aktifkan gzip/brotli di web server
 *   (sekali setel, nol risiko) SEBELUM mempertimbangkan minifier sungguhan.
 * ========================================================================= */
'use strict';

/** Apakah token sebelum `/` menandakan posisi tersebut awal REGEX, bukan bagi? */
function regexAllowed(prev) {
  if (!prev) return true;
  // Setelah nilai (identifier/angka/penutup), `/` berarti pembagian.
  // Setelah operator/pembuka/koma/kata-kunci, `/` memulai regex literal.
  return !/[\w$)\].'"`]/.test(prev);
}

/**
 * Buang komentar dari sumber JS dengan aman terhadap string/template/regex.
 * Newline di dalam komentar blok DIPERTAHANKAN agar nomor baris & ASI stabil.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = '';   // karakter bukan-spasi terakhir yang ditulis

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // --- string berkutip tunggal/ganda ---
    if (c === '"' || c === "'") {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      lastSignificant = quote;
      continue;
    }

    // --- template literal (bisa memuat ${...} dan newline) ---
    if (c === '`') {
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === '`') { i++; break; }
        i++;
      }
      lastSignificant = '`';
      continue;
    }

    // --- komentar blok: dibuang, newline di dalamnya dipertahankan ---
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    // --- komentar baris: dibuang sampai akhir baris ---
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // --- regex literal: HARUS dilewati utuh, isinya bisa memuat / dan * ---
    if (c === '/' && regexAllowed(lastSignificant)) {
      out += c; i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += ch + (src[i + 1] || ''); i += 2; continue; }
        if (ch === '\n') break;            // regex tak boleh lintas baris -> bukan regex
        out += ch; i++;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      lastSignificant = '/';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/** Buang indentasi, spasi akhir, dan baris kosong. */
function squeezeWhitespace(src) {
  return src
    .split('\n')
    .map((l) => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''))
    .filter((l) => l !== '')
    .join('\n');
}

function minify(src) {
  return squeezeWhitespace(stripComments(src)) + '\n';
}

module.exports = { minify, stripComments, squeezeWhitespace };

/* Pemakaian langsung: node tools/minify-js.js <file> -> cetak hasil ke stdout. */
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('Pakai: node tools/minify-js.js <berkas.js>');
    process.exit(1);
  }
  process.stdout.write(minify(fs.readFileSync(file, 'utf8')));
}

#!/usr/bin/env node
/**
 * tools/fetch-fonts.js
 * -----------------------------------------------------------------------------
 * [P2-5 2026-10-05] Mengunduh font Web (Inter + JetBrains Mono) dari Google
 * Fonts SEKALI SAJA, menyimpannya sebagai .woff2 ke vendor/fonts/, lalu
 * menulis ulang vendor/fonts/fonts.css dengan @font-face ber-`url()` LOKAL.
 *
 * Jalankan di mesin yang PUNYA internet (sekali saja, sebelum deploy):
 *     node tools/fetch-fonts.js
 *
 * Setelah itu aplikasi siap offline — tidak ada permintaan ke fonts.googleapis.com
 * saat runtime (penting untuk jaringan tambang tertutup).
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'vendor', 'fonts');
const CSS_OUT = path.join(OUT_DIR, 'fonts.css');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800' +
  '&family=JetBrains+Mono:wght@400;600;700&display=swap';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function getBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Mengunduh CSS Google Fonts...');
  let css;
  try {
    css = await get(CSS_URL);
  } catch (e) {
    console.error('GAGAL mengunduh CSS: ' + e.message);
    console.error('Jalankan di mesin ber-internet. Aplikasi tetap jalan dgn font sistem.');
    process.exit(1);
  }

  // Kumpulkan semua url(...) unik
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))];
  console.log('Ditemukan ' + urls.length + ' berkas font.');

  const map = {};
  let i = 0;
  for (const u of urls) {
    const name = 'font-' + (i++) + '-' + path.basename(u.split('?')[0]);
    const buf = await getBinary(u);
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    map[u] = name;
    console.log('  tersimpan ' + name + ' (' + Math.round(buf.length / 1024) + ' KB)');
  }

  // Ganti url absolut -> lokal
  let localCss = css;
  for (const [abs, local] of Object.entries(map)) {
    localCss = localCss.split(abs).join(local);
  }
  const header = '/* Font lokal — dibuat otomatis oleh tools/fetch-fonts.js pada ' +
    new Date().toISOString() + ' */\n' +
    '/* JANGAN hapus: dipakai index.html sebagai pengganti Google Fonts CDN. */\n\n';
  fs.writeFileSync(CSS_OUT, header + localCss, 'utf8');
  console.log('\nSELESAI. vendor/fonts/fonts.css ditulis ulang dengan url() lokal.');
  console.log('Aplikasi kini siap offline.');
})().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });

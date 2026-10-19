#!/usr/bin/env node
/**
 * tools/bump-version.js
 * -----------------------------------------------------------------------
 * [FASE 5 2026-10-15] Naikkan cache-buster `?v=YYYYMMDD<huruf>` di index.html
 * secara otomatis. Mencari stempel saat ini, menaikkan huruf terakhir,
 * lalu mengganti SEMUA kemunculan sekaligus.
 *
 * Pemakaian:
 *   node tools/bump-version.js          # naikkan huruf (c -> d -> e ...)
 *   node tools/bump-version.js 20261016a   # set stempel eksplisit
 *
 * Juga memverifikasi: tidak ada BOM, jumlah replacement dilaporkan.
 * -----------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'index.html');
let content = fs.readFileSync(indexPath, 'utf8');

// Cari stempel saat ini: ?v=YYYYMMDD<huruf>
const match = content.match(/\?v=(\d{8}[a-z])/);
if (!match) {
  console.error('ERROR: tidak menemukan stempel ?v=YYYYMMDD<huruf> di index.html');
  process.exit(1);
}

const oldStamp = match[1];
let newStamp;

// Mode stempel eksplisit
const arg = process.argv[2];
if (arg && /^\d{8}[a-z]$/.test(arg)) {
  newStamp = arg;
} else {
  // Naikkan huruf terakhir
  const date = oldStamp.slice(0, 8);
  const letter = oldStamp.slice(8);
  const nextLetter = String.fromCharCode(letter.charCodeAt(0) + 1);
  // Jika huruf melewati 'z', reset ke 'a' dan tambahkan tanggal hari ini
  newStamp = nextLetter > 'z' ? date + 'a' : date + nextLetter;
  // Jika tanggal hari ini berbeda, pakai tanggal hari ini + 'a'
  const today = new Date();
  const todayStr = String(today.getFullYear()) +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  if (todayStr !== date) {
    newStamp = todayStr + 'a';
  }
}

if (oldStamp === newStamp) {
  console.log('Stempel tidak berubah: ?v=' + newStamp + ' (sudah terbaru)');
  process.exit(0);
}

// Ganti semua kemunculan
const oldPattern = '?v=' + oldStamp;
const newPattern = '?v=' + newStamp;
const count = (content.split(oldPattern).length - 1);

content = content.split(oldPattern).join(newPattern);
fs.writeFileSync(indexPath, content, 'utf8');

// Verifikasi tidak ada BOM
const buf = fs.readFileSync(indexPath);
const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;

console.log('Cache-buster: ?v=' + oldStamp + ' -> ?v=' + newStamp);
console.log('Replacement: ' + count + ' lokasi');
console.log('BOM: ' + (hasBom ? 'ADA (ERROR!)' : 'tidak ada (OK)'));

#!/usr/bin/env node
/* =========================================================================
 * tools/verify-anonymize.js — Membuktikan anonymize-samples.js benar.
 * -------------------------------------------------------------------------
 * Membandingkan `sample-data/templates/` terhadap salinan ASLI (baseline)
 * lalu menegaskan DUA hal sekaligus:
 *   1. NEGATIF — tidak ada satu pun sel NON-identitas yang berubah.
 *      (kalau ini gagal, anonimisasi telah merusak data teknis)
 *   2. POSITIF  — setiap sel identitas memang berubah & tidak ada nilai
 *      identitas asli yang tersisa.
 *
 * Juga memeriksa VHMS (berkas non-tabel) secara terpisah.
 *
 * PAKAI
 *   node tools/verify-anonymize.js <folder-baseline>
 *   contoh: node tools/verify-anonymize.js "$TEMP/tpl-before"
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'sample-data', 'templates');
const BASE = process.argv[2];
if (!BASE || !fs.existsSync(BASE)) {
  console.error('Pakai: node tools/verify-anonymize.js <folder-baseline>');
  process.exit(2);
}

/* Kolom identitas — HARUS sinkron dengan SENSITIVE di anonymize-samples.js. */
const SENS = new Set([
  'Lab No.', 'Asset ID', 'Asset Serial Number', 'Component Serial Number',
  'Work Order No.', 'Label No.', 'Dealer Name', 'Customer Name', 'Jobsite',
  'UCID', 'Fluid Brand', 'Created by', 'EquipmentNumber', 'SerialNumber',
  'ComponentNo', 'LastMONumber', 'Material Document', 'Cost Center',
  'Plant', 'Equipment'
]);

function splitLine(line, d) {
  const o = []; let c = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; continue; }
    if (ch === d && !q) { o.push(c); c = ''; continue; }
    c += ch;
  }
  o.push(c); return o;
}

let fail = 0;
const say = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  GAGAL ') + msg); };

console.log('Verifikasi anonimisasi\n' + '='.repeat(60));

for (const f of fs.readdirSync(DIR).filter((x) => /\.csv$/i.test(x))) {
  const A = fs.readFileSync(path.join(BASE, f), 'utf8').split(/\r?\n/);
  const B = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
  console.log('\n' + f);

  /* --- struktur --- */
  say(A.length === B.length, 'jumlah baris tetap (' + A.length + ')');
  say(A[0] === B[0], 'header tetap identik');

  if (/vhms/i.test(f)) {
    /* VHMS: blok key,value — periksa baris identitas saja. */
    const idKeys = ['Machine Serial No.', 'Engine Model & Serial No.1 2 3', 'Comment'];
    let chg = 0; const leftovers = [];
    for (let i = 0; i < A.length; i++) {
      const ka = A[i].split(',')[0].trim();
      if (!idKeys.includes(ka)) {
        if (A[i] !== B[i]) say(false, 'baris NON-identitas berubah: baris ' + (i + 1) + ' -> ' + A[i]);
        continue;
      }
      if (A[i] !== B[i]) chg++;
      else leftovers.push(ka);
    }
    say(chg > 0, 'baris identitas VHMS disamarkan (' + chg + ')');
    say(leftovers.length === 0, 'tidak ada baris identitas yang terlewat' + (leftovers.length ? ': ' + leftovers.join(', ') : ''));
    /* model engine tetap (BUKAN identitas) */
    const aEng = (A.find((l) => l.startsWith('Engine Model')) || '').split(',')[1];
    const bEng = (B.find((l) => l.startsWith('Engine Model')) || '').split(',')[1];
    say(aEng === bEng, 'model engine dipertahankan (' + aEng + ')');
    continue;
  }

  /* --- tabel: bandingkan per sel --- */
  const h = splitLine(A[0], ',');
  const sensIdx = new Set();
  h.forEach((x, i) => { if (SENS.has((x || '').trim())) sensIdx.add(i); });

  let nNon = 0; const exNon = [];
  let nSensChanged = 0; let nSensSame = 0;
  for (let r = 1; r < A.length; r++) {
    if (!A[r].trim() && !B[r].trim()) continue;
    const ca = splitLine(A[r], ',');
    const cb = splitLine(B[r], ',');
    if (ca.length !== cb.length) { say(false, 'jumlah kolom beda di baris ' + (r + 1)); continue; }
    for (let c = 0; c < ca.length; c++) {
      if (ca[c] === cb[c]) { if (sensIdx.has(c) && ca[c].trim()) nSensSame++; continue; }
      if (sensIdx.has(c)) nSensChanged++;
      else { nNon++; if (exNon.length < 5) exNon.push(h[c] + ': "' + ca[c] + '" -> "' + cb[c] + '"'); }
    }
  }
  say(nNon === 0, 'nol sel NON-identitas berubah' + (nNon ? ' (' + nNon + '): ' + exNon.join(' | ') : ''));
  say(nSensChanged > 0, 'sel identitas disamarkan: ' + nSensChanged);
  say(nSensSame === 0, 'tidak ada sel identitas yang terlewat' + (nSensSame ? ' (' + nSensSame + ')' : ''));
}

console.log('\n' + '='.repeat(60));
console.log(fail === 0 ? 'LULUS: anonimisasi benar & tidak merusak data teknis.' : 'GAGAL: ' + fail + ' pemeriksaan tidak lolos.');
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/* =========================================================================
 * tools/purge-history.js — Menghapus data identitas asli dari SELURUH
 * riwayat Git (bukan hanya commit terakhir).
 * -------------------------------------------------------------------------
 * KENAPA PERLU
 *   Anonimisasi berkas hanya membersihkan commit TERBARU. Commit-commit lama
 *   masih menyimpan berkas asli, sehingga `git show <commit-lama>:<berkas>`
 *   tetap dapat membuka data pelanggan. Pada repo publik itu kebocoran penuh.
 *
 * PAKAI
 *   node tools/purge-history.js --check   # lapor saja
 *   node tools/purge-history.js           # tulis ulang riwayat
 *
 * PRASYARAT
 *   - Working tree BERSIH (di-commit). filter-branch menolak bila ada
 *     perubahan belum di-commit — skrip ini memeriksanya lebih dulu.
 *   - BELUM ada remote/push. Setelah push, riwayat lama mungkin sudah dicache.
 *   - `.purge-patterns` sudah dibuat (lihat .purge-patterns.example).
 *
 * ⚠️  PERINGATAN PENTING — BACA SEBELUM MENJALANKAN
 *   `--index-filter` dengan `git rm` menghapus berkas dari INDEX. Karena
 *   berkas selalu ada di HEAD, menjalankan `filter-branch` juga membuat
 *   berkas itu TIDAK ADA di commit hasil rewrite, dan setelah
 *   `git gc` + reset, berkas tersebut HILANG dari working tree.
 *   Karena itu:
 *     (a) SKRIP INI MEMBUAT BACKUP BUNDLE lebih dulu (--backup-dir),
 *     (b) setelah purge, berkas yang dibuang HARUS di-commit ulang dari
 *         salinan yang sudah bersih.
 *   Lihat catatan "ALUR AMAN" di bawah.
 *
 * ALUR AMAN
 *   1. Bersihkan berkas (anonymize-samples.js / anonymize-docs.js).
 *   2. Commit. Salin berkas-berkas yang akan di-purge ke LUAR repo:
 *        node tools/purge-history.js --save-clean <folder-tujuan>
 *   3. Jalankan purge: node tools/purge-history.js
 *   4. Pulihkan: node tools/purge-history.js --restore <folder-tujuan>
 *   5. Commit ulang. Verifikasi: node tools/purge-history.js --check
 * ========================================================================= */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const SAVE = process.argv.indexOf('--save-clean');
const RESTORE = process.argv.indexOf('--restore');

/* Jalur berkas yang memuat identitas asli di riwayat. Semua berkas ini sudah
   BERSIH di working tree; yang dibuang hanyalah versi lamanya di riwayat. */
const BAD_PATHS = [
  'sample-data/templates/sos-analysist-caterpillar-template.csv',
  'sample-data/templates/nomor-lambung-umur-comp-section-template.csv',
  'sample-data/templates/oil-rad-topup-layout-aa-rt-template.csv',
  'sample-data/templates/vhms-template.csv',
  'docs/SPEK_COMPONENT_LIFE_CUTOFF.md',
  'docs/TAHAPAN_SOS_WARNA_HISTORI_DAN_KOLOM_PB.md',
  'sample-data/README.md',
  'tools/anonymize-samples.js',
  'tools/anonymize-docs.js',
  'tools/purge-history.js'
];

/* Pola identitas dibaca dari `.purge-patterns` (di-gitignore) agar nomor unit
   nyata TIDAK ikut tersimpan di dalam kode skrip ini.
   CATATAN: 'Trakindo' & 'PT Bukit Makmur Mandiri Utama' SENGAJA tidak masuk
   daftar — keduanya bukan kebocoran, melainkan nama format ekspor lab yang
   didukung aplikasi dan kop laporan milik aplikasi itu sendiri. */
function loadPatterns() {
  const f = path.join(ROOT, '.purge-patterns');
  if (!fs.existsSync(f)) {
    console.warn('PERINGATAN: ' + path.relative(ROOT, f) + ' tidak ada. Pemindaian riwayat');
    console.warn('TIDAK BERARTI tanpa pola. Buat dulu (lihat .purge-patterns.example).');
    process.exit(3);
  }
  return fs.readFileSync(f, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('|');
}
const PATTERNS = loadPatterns();

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8' }, opts || {}));
}
function gitSoft(args) {
  try { return git(args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return ''; }
}

function scan() {
  const shas = git(['log', '--all', '--format=%H']).trim().split('\n').filter(Boolean);
  let dirty = 0; const sample = [];
  for (const sha of shas) {
    if (gitSoft(['grep', '-l', '-I', '-E', PATTERNS, sha]).trim()) {
      dirty++; if (sample.length < 3) sample.push(sha.slice(0, 7));
    }
  }
  return { total: shas.length, dirty, sample };
}

/* Salin berkas bersih ke luar repo sebelum di-purge. */
function saveClean(dir) {
  fs.mkdirSync(dir, { recursive: true });
  BAD_PATHS.forEach((rel) => {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) { console.log('  (lewat, tidak ada) ' + rel); return; }
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  });
  console.log('Berkas bersih disalin ke: ' + dir);
  console.log('Jangan lupa dipulihkan (--restore) setelah purge.');
}

/* Pulihkan dari salinan. */
function restore(dir) {
  let n = 0;
  BAD_PATHS.forEach((rel) => {
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) { console.log('  (tidak ada di salinan) ' + rel); return; }
    const dst = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst); n++;
  });
  console.log(n + ' berkas dipulihkan dari ' + dir);
  console.log('Commit ulang berkas-berkas ini sekarang.');
}

function main() {
  if (SAVE !== -1 && process.argv[SAVE + 1]) return saveClean(process.argv[SAVE + 1]);
  if (RESTORE !== -1 && process.argv[RESTORE + 1]) return restore(process.argv[RESTORE + 1]);

  console.log('Pembersihan riwayat Git\n' + '='.repeat(60));

  if (git(['remote']).trim()) {
    console.error('HENTI: repo sudah punya remote. Rewrite setelah push berisiko tinggi.');
    process.exit(2);
  }

  const before = scan();
  console.log('commit total            : ' + before.total);
  console.log('commit memuat identitas : ' + before.dirty + (before.sample.length ? '  (' + before.sample.join(', ') + '...)' : ''));
  if (before.dirty === 0) { console.log('\nBersih. Tidak ada yang perlu ditulis ulang.'); return; }
  if (CHECK) { console.log('\nMODE PERIKSA: riwayat masih memuat identitas.'); process.exit(1); }

  const dirtyTree = gitSoft(['status', '--porcelain']).trim();
  if (dirtyTree) {
    console.error('\nHENTI: ada perubahan belum di-commit. filter-branch akan menolak.');
    dirtyTree.split('\n').slice(0, 10).forEach((l) => console.error('  ' + l));
    process.exit(4);
  }

  /* Backup otomatis sebelum menulis ulang. */
  const backup = path.join(ROOT, '..', 'repo-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bundle');
  console.log('\nMembuat backup: ' + path.basename(backup));
  try { git(['bundle', 'create', backup, '--all'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { console.error('GAGAL membuat backup. Dibatalkan.'); process.exit(6); }

  console.log('Menulis ulang riwayat (semua ref)...');
  const rmCmd = 'git rm -r --cached --ignore-unmatch ' + BAD_PATHS.map((p) => "'" + p + "'").join(' ');
  try {
    execFileSync('git', ['filter-branch', '-f', '--prune-empty', '--tag-name-filter', 'cat',
      '--index-filter', rmCmd, '--', '--all'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { FILTER_BRANCH_SQUELCH_WARNING: '1' }) });
  } catch (e) {
    const msg = ((e.stdout || '') + (e.stderr || '')).toString();
    console.error('\nGAGAL menjalankan filter-branch:');
    console.error(msg.split('\n').filter(Boolean).slice(-8).join('\n') || e.message);
    process.exit(5);
  }
  console.log('  selesai.');

  console.log('Membersihkan ref backup, reflog, dan garbage collect...');
  gitSoft(['for-each-ref', '--format=%(refname)', 'refs/original/']).trim().split('\n')
    .filter(Boolean).forEach((r) => gitSoft(['update-ref', '-d', r]));
  if (gitSoft(['stash', 'list']).trim()) {
    console.log('  (stash ditulis ulang oleh filter-branch; ref-nya dihapus)');
    gitSoft(['update-ref', '-d', 'refs/stash']);
  }
  gitSoft(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  try { git(['gc', '--prune=now']); } catch (e) { void e; }

  const after = scan();
  console.log('\n' + '='.repeat(60));
  console.log('commit memuat identitas SESUDAH : ' + after.dirty);
  if (after.dirty !== 0) { console.log('GAGAL: masih ada ' + after.dirty + ' commit.'); process.exit(1); }
  console.log('LULUS: riwayat bersih.');

  /* Deteksi berkas yang hilang akibat purge, lalu arahkan pemulihan. */
  const missing = BAD_PATHS.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  if (missing.length) {
    console.log('\n⚠️  ' + missing.length + ' berkas terhapus dari working tree (efek --index-filter):');
    missing.forEach((p) => console.log('   - ' + p));
    console.log('\nPulihkan:  node tools/purge-history.js --restore <folder-salinan>');
    console.log('lalu COMMIT ULANG berkas tersebut.');
  }
  console.log('\nBackup riwayat lama: ' + backup);
}

main();

/* =========================================================================
 * sos-db.js — transport IndexedDB untuk data SOS (FASE 3, 2026-10-31)
 * -------------------------------------------------------------------------
 * Padanan `fuel-db.js` untuk sisi oli. VHMS (Fase 2) TIDAK memakai modul ini.
 *
 * KENAPA DIPISAH DARI sos-store.js
 *   `sos-store.js` adalah API yang dipakai 10 berkas (5 modul UI, pengaturan,
 *   portofolio, index.html). Menaruh seluruh logika IndexedDB di sana berarti
 *   satu berkas memuat tiga hal: API, aturan dedup/analitik, dan transport.
 *   Transport dipisah supaya bisa ditukar/diuji sendiri.
 *
 * KONTRAK: modul ini TIDAK punya API publik untuk UI.
 *   Semua akses lewat `SOS_STORE`. Ekspornya hanya untuk diuji.
 *
 * GRANULARITAS — SATU RECORD = SATU SAMPEL
 *   Terukur (`tools/probe-sos-scale.js`, data aktual 2.426 baris):
 *     2.305 sampel unik · 1.594 unit (asset|component) · median 1 sampel/unit
 *   Dengan per-unit, setiap perubahan satu sampel menulis ulang seluruh unit;
 *   dengan per-sampel, tepat satu record. Kuncinya PUNYA STABILITAS YANG
 *   DIPERCAKAP `sampleKey()` (lab_no, atau komposit asset|component|tanggal|HM):
 *   sampel yang sama (berkas di-upload ulang) menulis ke kunci yang SAMA,
 *   sehingga "data baru menang" berlaku juga setelah reload.
 *
 * MIGRASI (sekali, otomatis, TIDAK destruktif)
 *   Data lama ada di localStorage `sos.fleet.v1`.
 *     1. Bila IndexedDB sudah berisi -> migrasi DILEWATI (tidak menimpa).
 *     2. Bila kosong DAN localStorage berisi -> pindahkan per sampel.
 *     3. Tandai `meta.migratedAt`.
 *   Kunci localStorage **TIDAK dihapus** di sini. Penghapusan hanya lewat
 *   `compactLegacyKey()` setelah jumlah di IndexedDB TERVERIFIKASI.
 *
 * PEMBERSIHAN SAMPEL YATIM (orphan)
 *   Bila data ditulis lewat mode cadangan (localStorage, IDB mati) lalu IDB
 *   hidup lagi, mode AI menyimpan sampel-sampel itu ke disk — sebagian
 *   mungkin masih ada (tulisan berantai yang belum selesai). `pruneOrphans()`
 *   membuang record yang TIDAK ADA di memori. WAJIB dipanggil setelah
 *   `hydrate()` sukses; tanpa itu resolusinya: record hantu muncul kembali
 *   di daftar setelah reload, padahal operator sudah menghapusnya.
 * ========================================================================= */

(function (global) {
  'use strict';

  var ST = 'sosSamples';
  var META = 'meta';

  function D() { return global.DB_UTIL || null; }

  /** Apakah IndexedDB siap dipakai (ada modul + peramban mendukung). */
  function available() {
    var d = D();
    return !!(d && d.available && d.available());
  }

  function noIdb() {
    return Promise.reject(new Error('IndexedDB tidak tersedia'));
  }

  /* -------------------------------------------------------------------
   * CRUD
   * ----------------------------------------------------------------- */
  /**
   * all() -> Promise<Array<sample>> — urut `seq` NAIK (urutan masuk).
   * Urutan direkonstruksi dari data, bukan dari array terpisah: dua sumber
   * urutan adalah cara termudah membuat tabel dan store berbeda.
   */
  function all() {
    if (!available()) return noIdb();
    return D().all(ST).then(function (arr) {
      return (arr || []).slice().sort(function (a, b) {
        var sa = a.seq || 0, sb = b.seq || 0;
        if (sa !== sb) return sa - sb;
        return String(a.key).localeCompare(String(b.key));
      });
    });
  }

  /** get(key) -> Promise<sample|null> */
  function get(key) {
    if (!available()) return noIdb();
    return D().get(ST, key);
  }

  /**
   * putMany(list) -> Promise<void>
   * SATU transaksi untuk seluruh daftar. Dipakai "tambah sampel" (satu
   * berkas = satu transaksi) dan migrasi. Mengirim N transaksi terpisah
   * untuk 2.305 sampel berarti 2.305 commit — terukur jauh lebih lambat.
   *
   * [BUG NYATA 2026-10-31] Kunci KEMBAR dalam satu daftar tidak boleh
   * dioper apa adanya. `objectStore.put()` dengan kunci yang sudah ditulis
   * DI TRANSAKSI YANG SAMA melempar `ConstraintError`, dan satu galat
   * membatalkan SELURUH transaksi — akibatnya NOL record tertulis dan
   * migrasi melaporkan "verifikasi-gagal" padahal datanya baik-baik saja.
   * Terukur: satu berkas SOS aktual berisi 2.426 baris dengan 121 duplikat.
   * "Data BARU menang" diterapkan di sini: yang terakhir menempati kunci.
   */
  function putMany(list) {
    if (!available()) return noIdb();
    var seen = {};
    var arr = [];
    var src = list || [];
    for (var i = 0; i < src.length; i++) {
      var r = src[i];
      if (!r || !r.key) continue;
      if (seen[r.key]) {
        // Ganti posisi record sebelumnya agar urutan tetap = urutan masuk
        // pertama, sementara ISI-nya versi terakhir.
        arr[seen[r.key].at] = r;
      } else {
        seen[r.key] = { at: arr.length };
        arr.push(r);
      }
    }
    if (!arr.length) return Promise.resolve();
    return D().putMany(ST, arr);
  }

  /** remove(key) -> Promise<void> */
  function remove(key) {
    if (!available()) return noIdb();
    return D().del(ST, key);
  }

  /** removeMany(keys) -> Promise<void> — satu transaksi. */
  function removeMany(keys) {
    var arr = (keys || []).filter(Boolean);
    if (!arr.length) return Promise.resolve();
    if (!available()) return noIdb();
    // `del` satu per satu di dalam satu rantai tetap N transaksi; jumlah
    // penghapusan bersamaan pada praktiknya kecil (dedup/pembersihan), jadi
    // cukup berurutan supaya kode tetap sederhana dan dapat diuji.
    return arr.reduce(function (p, k) {
      return p.then(function () { return D().del(ST, k); });
    }, Promise.resolve());
  }

  /** clear() -> Promise<void> */
  function clear() {
    if (!available()) return noIdb();
    return D().clear(ST);
  }

  /** count() -> Promise<number> */
  function count() {
    return all().then(function (a) { return a.length; });
  }

  /** Apakah index pada `store` ada (catatan: tidak semua peramban/implan
   *  menyediakan `indexNames.contains`, jadi diperlakukan sebagai opsional). */
  function hasIndex(store, name) {
    try {
      return !!(store && store.indexNames && typeof store.indexNames.contains === 'function'
        && store.indexNames.contains(name));
    } catch (e) {
      return false;
    }
  }

  /**
   * pruneOrphans(keepKeys) -> Promise<{removed:number}>
   * Membuang record yang kuncinya TIDAK ADA di `keepKeys` (memori).
   * Lihat catatan "PEMBERSIHAN SAMPEL YATIM" di atas.
   */
  function pruneOrphans(keepKeys) {
    if (!available()) return Promise.resolve({ removed: 0 });
    var keep = {};
    (keepKeys || []).forEach(function (k) { if (k) keep[k] = true; });
    var buang = [];
    return D().open().then(function (db) {
      var tx = db.transaction(ST, 'readonly');
      var store = tx.objectStore(ST);
      return new Promise(function (resolve, reject) {
        // `openKeyCursor` (bila ada) hanya membaca KUNCI, tanpa memuat 2.305
        // record utuh. Jatuh ke `openCursor` bila tidak tersedia.
        var req = (hasIndex(store) && typeof store.openKeyCursor === 'function')
          ? store.openKeyCursor() : store.openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) return;
          var k = cur.key;
          // Pada `openCursor`, `cur.key` = kunci juga (keyPath 'key').
          if (k != null && !keep[String(k)]) buang.push(String(k));
          cur.continue();
        };
        tx.oncomplete = function () { resolve(buang); };
        tx.onerror = function () { reject(tx.error || new Error('gagal membaca sosSamples')); };
        tx.onabort = function () { reject(tx.error || new Error('abort sosSamples')); };
      });
    }).then(function (list) {
      if (!list.length) return { removed: 0 };
      return removeMany(list).then(function () { return { removed: list.length }; });
    });
  }

  /* -------------------------------------------------------------------
   * Penanda migrasi
   * ----------------------------------------------------------------- */
  function getMeta(k) {
    if (!available()) return Promise.resolve(null);
    return D().get(META, k).then(function (r) { return r ? r.v : null; });
  }

  function setMeta(k, v) {
    return D().put(META, { k: k, v: v, at: Date.now() });
  }

  /**
   * migrateFromLocalStorage(readLegacy) -> Promise<{moved, skipped, reason}>
   *
   * `readLegacy()` disediakan `SOS_STORE` (ia yang tahu format
   * `sos.fleet.v1` dan cara memulihkan `Date`); modul ini TIDAK menebak
   * bentuk data lama.
   *
   * TIDAK PERNAH menimpa data yang sudah ada di IndexedDB.
   */
  function migrateFromLocalStorage(readLegacy) {
    if (!available()) return Promise.resolve({ moved: 0, skipped: 0, reason: 'idb-tidak-tersedia' });
    return getMeta('migratedAt').then(function (sudah) {
      if (sudah) return { moved: 0, skipped: 0, reason: 'sudah-pernah' };
      return count().then(function (n) {
        if (n > 0) {
          return setMeta('migratedAt', Date.now())
            .then(function () { return { moved: 0, skipped: n, reason: 'idb-sudah-berisi' }; });
        }
        var legacy = null;
        try { legacy = readLegacy(); } catch (e) { legacy = null; }
        if (!legacy || !legacy.samples || !legacy.samples.length) {
          return setMeta('migratedAt', Date.now())
            .then(function () { return { moved: 0, skipped: 0, reason: 'localstorage-kosong' }; });
        }
        var list = legacy.samples;
        var setelah = 0;
        return putMany(list).then(function () {
          return count();
        }).then(function (n) {
          setelah = n;
          /* VERIFIKASI dua arah. Bandingkan dengan jumlah record yang BENAR-
           * BENAR ditulis (`setelah`), bukan jumlah baris lama: data baru
           * memang MENGGANTIKAN yang lama, jadi `setelah` SELALU lebih kecil
           * bila ada duplikat (terukur 121 dari 2.426). Percobaan pertama
           * membandingkan dengan `list.length` -> migrasi yang BERHASIL
           * dilaporkan "verifikasi-gagal". */
          if (setelah === 0) {
            return { moved: 0, skipped: list.length, reason: 'verifikasi-gagal' };
          }
          return setMeta('migratedAt', Date.now()).then(function () {
            return setMeta('migratedFrom', 'localStorage');
          }).then(function () {
            return { moved: setelah, skipped: (legacy.count || list.length) - setelah, reason: 'ok' };
          });
        });
      });
    });
  }

  /**
   * roomFor(bytes) -> Promise<{ok, free, quota, unmeasured}>
   * Gerbang kuota SEBELUM tulis. Bila tak terukur, `unmeasured:true` —
   * pemanggil tidak boleh mengklaim aman.
   */
  function roomFor(bytes) {
    if (!available()) {
      return Promise.resolve({ ok: false, free: 0, quota: 0, unmeasured: true, reason: 'idb-tidak-tersedia' });
    }
    return D().ensureRoom(bytes);
  }

  function estimate() {
    if (!available()) return Promise.resolve({ quota: null, usage: null, persisted: null, available: false });
    return D().estimate();
  }

  global.SOS_DB = {
    STORE: ST,
    available: available,
    all: all,
    get: get,
    putMany: putMany,
    remove: remove,
    removeMany: removeMany,
    clear: clear,
    count: count,
    pruneOrphans: pruneOrphans,
    getMeta: getMeta,
    setMeta: setMeta,
    migrateFromLocalStorage: migrateFromLocalStorage,
    roomFor: roomFor,
    estimate: estimate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_DB;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * fuel-db.js — penyimpanan Fuel di IndexedDB (FASE 1, 2026-10-30)
 * -------------------------------------------------------------------------
 * PILOT migrasi penyimpanan. VHMS & SOS TIDAK memakai modul ini.
 *
 * KENAPA DIPISAH DARI fuel-store.js
 *   `fuel-store.js` adalah API yang dipakai 9 titik di `fuel-app.js` dan
 *   belasan uji. Menaruh seluruh logika IndexedDB di sana membuat satu berkas
 *   berisi tiga hal sekaligus (API, format ringkasan, transport). Di sini
 *   transport dipisah: kalau suatu saat harus kembali ke localStorage,
 *   `fuel-store.js` cukup menukar sumber data.
 *
 * KONTRAK: modul ini TIDAK punya API publik untuk UI.
 *   Semua akses lewat `FUEL_STORE`. Yang diekspor hanya untuk diuji.
 *
 * SATU sumber identitas: kunci unit = `FUEL_STORE.keyOf()` (S:<SN> dst).
 *   Menghitung kunci sendiri di sini akan membuat dua entri untuk satu truk
 *   begitu aturan keyOf berubah.
 *
 * MIGRASI (sekali, otomatis, TIDAK destruktif)
 *   Data lama ada di localStorage `fuel.store.v1` (schema 2: `order`+`units`).
 *   Saat dibuka:
 *     1. baca IndexedDB; bila sudah berisi -> selesai (tidak menimpa).
 *     2. bila kosong DAN localStorage berisi -> pindahkan per unit.
 *     3. tandai `meta.migratedFrom` = waktu migrasi.
 *   Kunci localStorage **TIDAK dihapus** di langkah ini. Penghapusan hanya
 *   terjadi setelah jumlah unit di IndexedDB TERVERIFIKASI sama — dan itu
 *   diputuskan `FUEL_STORE`, bukan modul ini.
 * ========================================================================= */

(function (global) {
  'use strict';

  var ST = 'units';
  var META = 'meta';

  function D() { return global.DB_UTIL || null; }

  /** Apakah IndexedDB siap dipakai (ada modul + peramban mendukung). */
  function available() {
    var d = D();
    return !!(d && d.available && d.available());
  }

  /**
   * all() -> Promise<Array<unit>> — urut `updatedAt` naik (urutan masuk).
   * Urutan dipulihkan dari data, BUKAN dari array `order` terpisah: dua
   * sumber urutan adalah cara paling mudah membuat tabel dan store berbeda.
   */
  function all() {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().all(ST).then(function (arr) {
      return (arr || []).slice().sort(function (a, b) {
        var ua = a.updatedAt || 0, ub = b.updatedAt || 0;
        if (ua !== ub) return ua - ub;
        return String(a.key).localeCompare(String(b.key));
      });
    });
  }

  /** get(key) -> Promise<unit|null> */
  function get(key) {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().get(ST, key);
  }

  /** put(unit) -> Promise<void> */
  function put(unit) {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().put(ST, unit);
  }

  /** putMany(list) -> Promise<void> — untuk impor/migrasi. */
  function putMany(list) {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().putMany(ST, list);
  }

  /** remove(key) -> Promise<void> */
  function remove(key) {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().del(ST, key);
  }

  /** clear() -> Promise<void> */
  function clear() {
    if (!available()) return Promise.reject(new Error('IndexedDB tidak tersedia'));
    return D().clear(ST);
  }

  /** count() -> Promise<number> */
  function count() {
    return all().then(function (a) { return a.length; });
  }

  /* -------------------------------------------------------------------
   * Penanda migrasi
   * ----------------------------------------------------------------- */
  function getMeta(k) {
    return D().get(META, k).then(function (r) { return r ? r.v : null; });
  }

  function setMeta(k, v) {
    return D().put(META, { k: k, v: v, at: Date.now() });
  }

  /**
   * migrateFromLocalStorage(readLegacy) -> Promise<{moved, skipped, reason}>
   *
   * `readLegacy()` disediakan `FUEL_STORE` (ia yang tahu format
   * `fuel.store.v1`); modul ini tidak boleh menebak bentuk data lama.
   *
   * TIDAK PERNAH menimpa data yang sudah ada di IndexedDB.
   */
  function migrateFromLocalStorage(readLegacy) {
    if (!available()) return Promise.resolve({ moved: 0, skipped: 0, reason: 'idb-tidak-tersedia' });
    return getMeta('migratedAt').then(function (sudah) {
      if (sudah) return { moved: 0, skipped: 0, reason: 'sudah-pernah' };
      return count().then(function (n) {
        // IndexedDB sudah berisi (dipakai versi baru lebih dulu) -> JANGAN
        // menimpa. Tandai selesai supaya tidak dicoba lagi tiap buka.
        if (n > 0) return setMeta('migratedAt', Date.now())
          .then(function () { return { moved: 0, skipped: n, reason: 'idb-sudah-berisi' }; });
        var legacy = null;
        try { legacy = readLegacy(); } catch (e) { legacy = null; }
        if (!legacy || !legacy.units || !legacy.order || !legacy.order.length) {
          return setMeta('migratedAt', Date.now())
            .then(function () { return { moved: 0, skipped: 0, reason: 'localstorage-kosong' }; });
        }
        var list = legacy.order
          .map(function (k) { return legacy.units[k]; })
          .filter(Boolean);
        if (!list.length) {
          return setMeta('migratedAt', Date.now())
            .then(function () { return { moved: 0, skipped: 0, reason: 'tidak-ada-unit-sah' }; });
        }
        return putMany(list).then(function () {
          return count();
        }).then(function (setelah) {
          // Verifikasi SEBELUM mengklaim berhasil: jumlah harus >= yang
          // dipindahkan. Kalau tidak, `moved:0` dan kunci lama WAJIB tetap.
          if (setelah < list.length) {
            return { moved: 0, skipped: list.length, reason: 'verifikasi-gagal' };
          }
          return setMeta('migratedAt', Date.now()).then(function () {
            return setMeta('migratedFrom', 'localStorage');
          }).then(function () {
            return { moved: list.length, skipped: 0, reason: 'ok' };
          });
        });
      });
    });
  }

  /**
   * roomFor(bytes) -> Promise<{ok, free, quota, unmeasured}>
   * Gerbang kuota SEBELUM tulis. Tidak menghalangi bila kuota tak terukur,
   * tetapi ditandai `unmeasured` supaya pemanggil tidak mengklaim aman.
   */
  function roomFor(bytes) {
    if (!available()) return Promise.resolve({ ok: false, free: 0, quota: 0, unmeasured: true, reason: 'idb-tidak-tersedia' });
    return D().ensureRoom(bytes);
  }

  /** estimate() -> Promise<{quota, usage, persisted, available}> */
  function estimate() {
    if (!available()) return Promise.resolve({ quota: null, usage: null, persisted: null, available: false });
    return D().estimate();
  }

  global.FUEL_DB = {
    available: available,
    all: all,
    get: get,
    put: put,
    putMany: putMany,
    remove: remove,
    clear: clear,
    count: count,
    getMeta: getMeta,
    setMeta: setMeta,
    migrateFromLocalStorage: migrateFromLocalStorage,
    roomFor: roomFor,
    estimate: estimate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.FUEL_DB;

})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * db-util.js — pondasi penyimpanan IndexedDB (ARPC)
 * -------------------------------------------------------------------------
 * [FASE 0 2026-10-30] Pondasi peralihan localStorage -> IndexedDB.
 *
 * PILOT: FUEL (Fase 1) dan SOS (Fase 3). VHMS (Fase 2) BELUM dipindahkan.
 *
 * KENAPA ADA
 *   localStorage dibatasi ±5 MB per origin. Diukur (`npm run audit:fuel-quota`):
 *   satu ringkasan unit Fuel = 18,2 KB, satu track GPS = 0,3–1,1 MB, dan
 *   kebutuhan armada 200 unit > 1 GB. Kuota IndexedDB di mesin uji =
 *   1,51 GB (60 % disk bebas, dipotong plafon browser).
 *
 * ATURAN MODUL
 *   1. SATU pintu. Modul lain tidak boleh menyentuh `indexedDB` langsung.
 *   2. Semua fungsi mengembalikan Promise. Tidak ada API sinkron.
 *   3. Gagal berarti GAGAL — tidak ada fallback diam-diam ke tempat lain.
 *      Pemanggil yang memutuskan apa yang ditampilkan ke operator.
 *   4. Modul ini TIDAK menulis localStorage. Setelan kecil tetap di sana.
 *
 * TOPOLOGI (versi 2 — v1 + store SOS)
 *   store `meta`       keyPath 'k'   -> {k, v}            penanda skema/migrasi
 *   store `units`      keyPath 'key' -> satu entri = satu unit (summary + windows)
 *                         index `updatedAt`
 *   store `gpsTrack`   keyPath 'key' -> track 1 unit, `session` menandai sesi
 *                         index `session`  (untuk pembersihan otomatis)
 *   store `sosSamples` keyPath 'key' -> SATU sampel SOS (FASE 3)
 *                         index `unitKey` (asset|component) · index `seq`
 *
 * MENGAPA `units` PER-RECORD, BUKAN SATU OBJEK BESAR
 *   localStorage menyimpan ULANG seluruh isi tiap kali satu unit berubah
 *   (280 unit = ±5 MB ditulis ulang per unit). IndexedDB menulis satu record.
 * ========================================================================= */

(function (global) {
  'use strict';

  var DB_NAME = 'arpc-db';
  /* [FASE 3 2026-10-31] v1 -> v2: menambah store `sosSamples` + index.
   * Naik versi berarti tab LAIN yang masih memegang koneksi v1 akan ikut
   * melepasnya lewat `db.onversionchange` (sudah ada di bawah). Tanpa itu,
   * pembukaan akan diblokir dan data SOS tampak kosong di tab baru. */
  var DB_VERSION = 2;

  var STORE_META = 'meta';
  var STORE_UNITS = 'units';
  var STORE_GPS = 'gpsTrack';
  /* FASE 3: SATU record = SATU sampel SOS.
   * Dipilih PER-SAMPEL (bukan per-unit) setelah pengukuran data aktual
   * (`tools/probe-sos-scale.js`): median 1 sampel/unit, 1.594 unit untuk
   * 2.305 sampel. Per-unit berarti setiap edit 1 sampel menulis ulang satu
   * unit; per-sampel menulis tepat satu record. */
  var STORE_SOS = 'sosSamples';

  /* Sesi pemakaian. Track GPS bersifat SEMENTARA: dimuat saat unit dibuka,
   * dihapus saat pindah unit. Kalau operator menutup tab/browser paksa,
   * pembersih `onDispose` tidak jalan — karena itu track ditandai `session`
   * dan SETIAP track dari sesi lama dibuang saat aplikasi dibuka lagi.
   * Nilai baru tiap pemuatan halaman (bukan tiap tab): cukup untuk tujuan ini. */
  var SESSION = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);

  /* ---------------------------------------------------------------------
   * Ketersediaan
   * ------------------------------------------------------------------- */
  /** @returns {boolean} true bila IndexedDB bisa dipakai di lingkungan ini. */
  function available() {
    try {
      return !!(global.indexedDB && typeof global.indexedDB.open === 'function');
    } catch (e) {
      return false;
    }
  }

  function dbName() { return DB_NAME; }
  function sessionId() { return SESSION; }

  /* ---------------------------------------------------------------------
   * Buka database (idempoten, promise di-cache)
   * ------------------------------------------------------------------- */
  var _openPromise = null;

  /**
   * open() -> Promise<IDBDatabase>
   * Membuka/membuat skema. Aman dipanggil berkali-kali.
   * @returns {Promise<IDBDatabase>}
   */
  function open() {
    if (_openPromise) return _openPromise;
    _openPromise = new Promise(function (resolve, reject) {
      if (!available()) {
        reject(new Error('IndexedDB tidak tersedia di peramban ini'));
        return;
      }
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function (ev) {
        var db = req.result;
        // `createObjectStore` MELEMPAR bila store sudah ada -> selalu cek.
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains(STORE_UNITS)) {
          var us = db.createObjectStore(STORE_UNITS, { keyPath: 'key' });
          us.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_GPS)) {
          var gs = db.createObjectStore(STORE_GPS, { keyPath: 'key' });
          // Index WAJIB ada: pembersihan sesi lama menyaring per `session`
          // tanpa memuat seluruh isi store.
          gs.createIndex('session', 'session', { unique: false });
        }
        // [FASE 3 2026-10-31] Store sampel SOS. Dibuat dengan `if` yang sama
        // supaya database lama (v1) ikut di-upgrade tanpa menghapus store lain.
        if (!db.objectStoreNames.contains(STORE_SOS)) {
          var ss = db.createObjectStore(STORE_SOS, { keyPath: 'key' });
          // `unitKey` = asset_id||component: dipakai `getAllSamplesFor()`.
          ss.createIndex('unitKey', 'unitKey', { unique: false });
          // `seq` = urutan masuk. WAJIB disimpan: urutan sampel menentukan
          // sampel "terakhir" pada analitik; tanpa ini urutan bergantung pada
          // urutan kunci (string), bukan kronologi masuk.
          ss.createIndex('seq', 'seq', { unique: false });
        }
        // Jejak versi supaya migrasi berikutnya tahu dari mana.
        try {
          req.transaction.objectStore(STORE_META).put({ k: 'schema', v: DB_VERSION, at: Date.now() });
        } catch (e) { /* bukan alasan menggagalkan pembuatan skema */ }
        if (ev.oldVersion === 0) {
          try {
            req.transaction.objectStore(STORE_META).put({ k: 'createdAt', v: Date.now() });
          } catch (e2) { /* idem */ }
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        // Tab lain minta versi lebih baru: lepaskan koneksi supaya tidak
        // mengunci. CACHE JUGA HARUS DIBUANG — kalau tidak, `open()`
        // berikutnya mengembalikan koneksi yang sedang closing dan SEMUA
        // transaksi gagal dengan "database connection is closing".
        // (Bug ini tertangkap saat uji Fase 0, bukan di produksi.)
        db.onversionchange = function () {
          try { db.close(); } catch (e) {}
          _openPromise = null;
        };
        // Peramban bisa menutup koneksi di luar kendali (mis. pembersihan
        // storage). Setelah itu promise lama TIDAK BOLEH dipakai lagi.
        db.onclose = function () { _openPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('Gagal membuka IndexedDB')); };
      // Terjadi bila tab lain memegang koneksi versi lama. JANGAN reject —
      // pembukaan akan tetap lanjut setelah tab itu menutup.
      req.onblocked = function () { /* didiamkan: lihat catatan di atas */ };
    });
    // Jangan simpan promise yang gagal: panggilan berikutnya harus boleh coba lagi.
    _openPromise.catch(function () { _openPromise = null; });
    return _openPromise;
  }

  /* ---------------------------------------------------------------------
   * Pembantu transaksi kecil
   * ------------------------------------------------------------------- */
  /**
   * withStore(mode, storeName, fn) -> Promise
   *
   * SELALU mencoba lewat koneksi yang di-cache. Bila transaksi gagal karena
   * koneksi sedang/menutup (`InvalidStateError`), cache DB dibuang dan
   * percobaan diulang SEKALI dengan koneksi baru.
   *
   * KENAPA PERLU RETRY (bug terukur saat uji Fase 0): `db.close()` TIDAK
   * seketika. `onclose` baru terpicu pada task berikutnya, sehingga ada
   * jendela waktu di mana `open()` mengembalikan koneksi yang masih
   * "closing" dan setiap transaksi gagal. Hanya membersihkan cache tidak
   * cukup — koneksi baru harus benar-benar dibuka.
   */
  function withStore(mode, storeName, fn, isRetry) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, store;
        try {
          tx = db.transaction(storeName, mode);
          store = tx.objectStore(storeName);
        } catch (e) {
          reject(e);
          return;
        }
        var result;
        try {
          result = fn(store);
        } catch (e2) { reject(e2); return; }
        // Selesaikan pada `oncomplete`, BUKAN `onsuccess` request: pada mode
        // readwrite, `onsuccess` bisa terbit sebelum commit ke disk.
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('Transaksi IndexedDB gagal')); };
        tx.onabort = function () { reject(tx.error || new Error('Transaksi IndexedDB dibatalkan')); };
      });
    }).catch(function (e) {
      // Hanya kegagalan KONEKSI yang layak diulang. Kegagalan data
      // (mis. keyPath hilang) tidak akan berubah dengan koneksi baru.
      if (!isRetry && e && e.name === 'InvalidStateError') {
        _openPromise = null;
        return withStore(mode, storeName, fn, true);
      }
      throw e;
    });
  }

  function wrap(mode, storeName, fn) {
    return withStore(mode, storeName, fn, false);
  }

  /**
   * reqValue(req) — resolusi nilai sebuah IDBRequest pada `onsuccess`.
   * Dipakai untuk mode `readonly` bila hasilnya perlu dikembalikan.
   */
  function readAll(store) {
    return new Promise(function (resolve, reject) {
      var req = store.getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* ---------------------------------------------------------------------
   * API umum: satu record
   * ------------------------------------------------------------------- */
  /** get(storeName, key) -> Promise<value|null> */
  /**
   * get(storeName, key) -> Promise<value|null>
   * Lewat `wrap` yang sama supaya ikut aturan retry koneksi.
   */
  function get(storeName, key) {
    return wrap('readonly', storeName, function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.get(key);
        req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /** put(storeName, value) -> Promise<void> (menunggu commit) */
  function put(storeName, value) {
    return wrap('readwrite', storeName, function (store) { store.put(value); });
  }

  /** del(storeName, key) -> Promise<void> */
  function del(storeName, key) {
    return wrap('readwrite', storeName, function (store) { store.delete(key); });
  }

  /** all(storeName) -> Promise<Array> */
  function all(storeName) {
    return wrap('readonly', storeName, readAll);
  }

  /** clear(storeName) -> Promise<void> */
  function clear(storeName) {
    return wrap('readwrite', storeName, function (store) { store.clear(); });
  }

  /**
   * putMany(storeName, values) — banyak record dalam SATU transaksi.
   * Untuk impor awal / pemindahan data: satu transaksi jauh lebih cepat
   * daripada N transaksi terpisah, dan commit-nya atomik.
   */
  function putMany(storeName, values) {
    var arr = values || [];
    if (!arr.length) return Promise.resolve();
    return wrap('readwrite', storeName, function (store) {
      for (var i = 0; i < arr.length; i++) store.put(arr[i]);
    });
  }

  /* ---------------------------------------------------------------------
   * Kuota & persistensi
   * ------------------------------------------------------------------- */
  /**
   * estimate() -> Promise<{quota, usage, available, persisted}>
   * `available` = false bila peramban tidak mendukung `storage.estimate`.
   */
  function estimate() {
    var s = global.navigator && global.navigator.storage;
    if (!s || typeof s.estimate !== 'function') {
      return Promise.resolve({ quota: null, usage: null, available: false, persisted: null });
    }
    return s.estimate().then(function (e) {
      var p = (typeof s.persisted === 'function') ? s.persisted() : Promise.resolve(null);
      return p.then(function (persisted) {
        return {
          quota: (e && typeof e.quota === 'number') ? e.quota : null,
          usage: (e && typeof e.usage === 'number') ? e.usage : null,
          available: true,
          persisted: persisted
        };
      });
    }).catch(function () {
      return { quota: null, usage: null, available: false, persisted: null };
    });
  }

  /**
   * requestPersist() -> Promise<{granted, reason}>
   * Tanpa ini, peramban BOLEH membuang data saat disk menipis.
   * Browser boleh menolak (mis. belum ada interaksi pengguna) — itu bukan
   * kesalahan, hanya dilaporkan.
   */
  function requestPersist() {
    var s = global.navigator && global.navigator.storage;
    if (!s || typeof s.persist !== 'function') {
      return Promise.resolve({ granted: false, reason: 'tidak-didukung' });
    }
    return s.persist().then(function (ok) {
      return { granted: !!ok, reason: ok ? 'diberikan' : 'ditolak' };
    }).catch(function (e) {
      return { granted: false, reason: (e && e.message) || 'gagal' };
    });
  }

  /**
   * ensureRoom(bytes) -> Promise<{ok, quota, usage, free}>
   * Menolak SEBELUM menulis bila data tidak akan muat. Tanpa ini, penulisan
   * gagal separuh jalan dan operator hanya melihat data hilang sebagian.
   */
  function ensureRoom(bytes) {
    var need = Number(bytes);
    if (!isFinite(need) || need < 0) need = 0;
    return estimate().then(function (e) {
      if (!e.available || e.quota === null) {
        // Tidak bisa diukur: JANGAN halangi operasi, tapi tandai tak terukur.
        return { ok: true, quota: null, usage: null, free: null, unmeasured: true };
      }
      var free = e.quota - (e.usage || 0);
      return { ok: need <= free, quota: e.quota, usage: e.usage || 0, free: free, unmeasured: false };
    });
  }

  /* ---------------------------------------------------------------------
   * Pembersihan sesi (khusus track GPS yang bersifat sementara)
   * ------------------------------------------------------------------- */
  /**
   * purgeForeignTracks() — buang SEMUA track yang `session`-nya bukan sesi
   * sekarang. Dipanggil sekali saat aplikasi dibuka, agar tab yang ditutup
   * paksa tidak meninggalkan track di disk.
   * @returns {Promise<number>} jumlah record yang dibuang.
   */
  function purgeForeignTracks() {
    if (!available()) return Promise.resolve(0);
    return wrap('readwrite', STORE_GPS, function (store) {
      var removed = 0;
      var req = store.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        if (cur.value && cur.value.session !== SESSION) {
          cur.delete();
          removed++;
        }
        cur.continue();
      };
      return { get removed() { return removed; } };
    }).then(function (box) { return box.removed; });
  }

  /** dropTracksFor(unitKey) — hapus track milik satu unit (pindah unit / tutup panel). */
  function dropTracksFor(unitKey) {
    if (!unitKey) return Promise.resolve(0);
    return del(STORE_GPS, String(unitKey)).then(function () { return 1; });
  }

  /* ---------------------------------------------------------------------
   * Pemeliharaan
   * ------------------------------------------------------------------- */
  /** destroy() — hapus SELURUH database. Hanya untuk "Hapus Data Fuel" & uji. */
  function destroy() {
    return new Promise(function (resolve, reject) {
      if (!available()) { resolve(false); return; }
      // [BUG TERUKUR 2026-10-30] Cache koneksi WAJIB dibuang SEBELUM
      // `deleteDatabase`. Tanpa ini, `open()` berikutnya mengembalikan
      // koneksi ke database yang sudah dihapus: transaksi terlihat berhasil
      // tetapi tulisannya lenyap — atau langsung gagal tanpa sebab jelas.
      // Gejalanya muncul sebagai uji yang gagal BERGANTIAN (bergantung
      // urutan), bukan selalu.
      _openPromise = null;
      var req = global.indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('Database masih dipakai tab lain')); };
    });
  }

  /**
   * _clearCacheForTest() — lepaskan koneksi yang di-cache.
   * HANYA untuk uji yang mematikan IndexedDB sementara (mis. menyimulasikan
   * mode privat). Tanpa ini, promise lama tetap dipegang dan uji berikutnya
   * memakai koneksi mati.
   */
  function _clearCacheForTest() { _openPromise = null; }
  var DB_UTIL = {
    NAME: DB_NAME,
    VERSION: DB_VERSION,
    STORE: { META: STORE_META, UNITS: STORE_UNITS, GPS: STORE_GPS, SOS: STORE_SOS },
    SESSION: SESSION,
    available: available,
    dbName: dbName,
    sessionId: sessionId,
    open: open,
    get: get,
    put: put,
    del: del,
    all: all,
    clear: clear,
    putMany: putMany,
    estimate: estimate,
    // [WILAYAH UJI]
    _clearCacheForTest: _clearCacheForTest,
    requestPersist: requestPersist,
    ensureRoom: ensureRoom,
    purgeForeignTracks: purgeForeignTracks,
    dropTracksFor: dropTracksFor,
    destroy: destroy
  };

  global.DB_UTIL = DB_UTIL;
  if (typeof module !== 'undefined' && module.exports) module.exports = DB_UTIL;

})(typeof window !== 'undefined' ? window : globalThis);

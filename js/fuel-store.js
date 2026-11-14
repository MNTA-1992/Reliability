/* =========================================================================
 * fuel-store.js
 * -------------------------------------------------------------------------
 * [FUEL 2026-10-28] Penyimpanan hasil Fuel Trending — modul **MANDIRI**.
 *
 * -------------------------------------------------------------------------
 * [FASE 1 2026-10-30] PENYIMPANAN PINDAH KE INDEXEDDB
 * -------------------------------------------------------------------------
 * localStorage dibatasi ±5 MB. Terukur: satu ringkasan unit = 17–18 KB,
 * sehingga kuota jebol pada unit ke-285 dan 16 unit terakhir HILANG SENYAP
 * setelah reload. IndexedDB memberi kuota 1,5 GB di mesin uji.
 *
 * KEPUTUSAN ARSITEKTUR — API TETAP SINKRON
 *   `fuel-app.js` memanggil STORE.list()/setUnit() dst. di 9 titik, dan
 *   puluhan uji memakainya secara sinkron. Mengubah semuanya menjadi Promise
 *   berarti menulis ulang alur render seluruh halaman Fuel sekaligus
 *   membongkar harness uji — risiko jauh lebih besar daripada manfaatnya
 *   untuk masalah yang sebenarnya hanya "kapasitas".
 *
 *   Jadi:
 *     - SUMBER KEBENARAN saat aplikasi berjalan = `_state` di MEMORI.
 *     - IndexedDB = cermin permanen. Setiap perubahan memori dituliskan ke
 *       sana secara asinkron, dan kegagalan tulis DILAPORKAN.
 *     - `hydrate()` memuat isi IndexedDB ke memori saat aplikasi dibuka.
 *       Ini SATU-SATUNYA titik asinkron, dan UI memanggilnya lebih dulu.
 *
 *   Membaca ulang dari IndexedDB saat berjalan TIDAK dilakukan: itu membuat
 *   `list()` bergantung pada event loop dan urutan tulis yang belum selesai.
 *
 * BATAS JUJUR (WAJIB dibaca sebelum menambah fitur)
 *   1. Bila tab ditutup PERSIS di antara perubahan memori dan selesainya
 *      tulis, perubahan terakhir bisa hilang. Jendelanya beberapa milidetik
 *      (terukur 0,06 ms/unit) tetapi ada. Jangan menjanjikan "tersimpan
 *      begitu diklik"; yang benar: "tersimpan segera setelahnya".
 *   2. localStorage TETAP dipakai sebagai CADANGAN bila IndexedDB mati
 *      (mode privat / kebijakan peramban). Semantiknya sama seperti dulu.
 *   3. Migrasi TIDAK menghapus `fuel.store.v1`. Pemadaman kunci lama hanya
 *      lewat `compactLegacyKey()` yang memverifikasi jumlah unit lebih dulu.
 * ========================================================================= */

(function (global) {
  'use strict';

  var KEY = 'fuel.store.v1';
  var SCHEMA_V1 = 1;          // format LAMA: satu `summary`
  var SCHEMA = 2;             // format SEKARANG: daftar unit

  /* Batas jumlah unit.
   *
   * [KOREKSI TERUKUR 2026-10-29] Komentar lama menulis "±11 KB per unit,
   * jadi 300 unit masih aman". Itu SALAH: diukur, satu ringkasan = 18,2 KB,
   * sehingga kuota localStorage 5 MB jebol pada unit ke-285.
   *
   * [FASE 1 2026-10-30] Batas ini KINI bukan pembatas kuota, melainkan
   * pembatas waras untuk ukuran tabel & waktu muat. Nilai 280 DIPERTAHANKAN
   * karena (a) itu batas yang sudah diuji & didokumentasikan kepada operator,
   * dan (b) menaikkannya butuh pengukuran UI pada 1000 baris yang belum
   * dilakukan. `capacity()` melaporkan angka terukur supaya kenaikan itu
   * punya dasar, bukan tebakan. */
  var MAX_UNITS = 280;

  /* [FASE 1] Angka TERUKUR untuk pembanding — JANGAN diubah tanpa
   * menjalankan ulang `npm run audit:fuel-quota`. */
  var MEASURED = {
    kbPerUnit: 17.2,          // IndexedDB, 80 jendela/unit
    localStorageKB: 5 * 1024, // kuota localStorage per origin
    idbQuotaKB: 1546 * 1024   // kuota IndexedDB aktual di mesin uji
  };

  var _state = null;   // { status, units: {key: unit}, order: [], savedAt }
  var _mode = 'memori'; // 'idb' | 'localstorage'
  var _writeChain = Promise.resolve();   // serialisasi tulis IndexedDB
  var _writeErrors = [];                 // kegagalan tulis yang BELUM dilaporkan
  var _hydrated = false;
  var _lastRaw = null;

  function storage() {
    try { return (global.localStorage || null); } catch (e) { return null; }
  }

  function DB() { return global.FUEL_DB || null; }
  function idbReady() {
    var d = DB();
    return !!(d && d.available && d.available());
  }

  /* -----------------------------------------------------------------------
   * compact(res) — ringkasan dari hasil FUEL_ANALYTICS.analyze().
   * BENTUK TIDAK DIUBAH dari schema 1 supaya pembaca lama tetap jalan.
   * --------------------------------------------------------------------- */
  function compact(res) {
    res = res || {};
    var wins = (res.windows || []).filter(function (w) {
      return w && w.verdictable && w.date;
    }).map(function (w) {
      return {
        date: w.date, t1: w.t1, dSmr: w.dSmr, Lh: w.fuelRate, L: w.liters,
        n: w.n, cov: w.coverage,
        lTk: w.lTk, lGt: w.lGt, pen: w.penalty,
        idle: w.idle, ovl: w.overLoad,
        z: (w.z == null ? null : w.z),
        zG: (w.zG == null ? null : w.zG),
        zP: (w.zP == null ? null : w.zP),
        verdict: w.verdict || null,
        driver: w.driver || null,
        // [REVISI 2026-10-28] `payloadAvg` TIDAK pernah disalin padahal tabel
        // jendela menampilkannya -> kolom "Payload" kosong setiap kali unit
        // dibuka dari penyimpanan.
        pavg: (w.payloadAvg == null ? null : w.payloadAvg)
      };
    });
    return {
      model: res.model || '',
      ready: !!res.ready,
      // `usable` WAJIB disimpan: tanpanya, unit dengan baseline datar akan
      // tampak "punya baseline" setelah dimuat ulang, lalu UI mengarang angka.
      usable: !!res.usable,
      eligible: res.eligible || 0,
      emptyWeight: (res.emptyWeight == null ? null : res.emptyWeight),
      baseline: res.baseline || null,
      counts: res.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 },
      gateStats: res.gateStats || {},
      warnings: res.warnings || [],
      dailyLoaded: !!res.dailyLoaded,
      trendExtent: res.trendExtent || null,
      trendSeries: res.trendSeries || null,
      fuelRateAvg: (res.fuelRateAvg == null ? null : res.fuelRateAvg),
      totalCyclePayload: (res.totalCyclePayload == null ? null : res.totalCyclePayload),
      totalCycleCount: (res.totalCycleCount == null ? null : res.totalCycleCount),
      cycleDaily: res.cycleDaily || null,
      windows: wins
    };
  }

  /** Kunci unit: Serial No. bila ada, kalau tidak model + nama sumber. */
  function keyOf(meta, res) {
    meta = meta || {};
    var serial = String(meta.serial || '').trim();
    if (serial) return 'S:' + serial;
    var model = String(meta.model || (res && res.model) || '').trim();
    return 'M:' + model + '|' + String(meta.name || '').trim();
  }

  /* ---------------------------------------------------------------------
   * Lapisan memori
   * ------------------------------------------------------------------- */
  function blank() { return { status: 'EMPTY', units: {}, order: [], savedAt: null }; }

  function ensure() {
    // [FASE 1] Dulu fungsi ini menyegarkan dari localStorage tiap panggil.
    // Dengan IndexedDB, sumber saat berjalan adalah MEMORI: menyegarkan
    // diam-diam di sini akan membuang perubahan yang tulisnya belum selesai.
    // Penyegaran dilakukan lewat `hydrate()` yang eksplisit.
    if (!_state) _state = loadLegacy() || blank();
    return _state;
  }

  function list() {
    var st = ensure();
    return st.order.map(function (k) { return st.units[k]; }).filter(Boolean);
  }

  function getUnit(serialOrKey) {
    var st = ensure();
    var key = String(serialOrKey);
    if (st.units[key]) return st.units[key];
    return st.units['S:' + key] || null;
  }

  /* ---------------------------------------------------------------------
   * localStorage — CADANGAN & SUMBER MIGRASI
   * ------------------------------------------------------------------- */
  function parseRaw(raw) {
    try {
      var o = JSON.parse(raw);
      if (!o) return null;
      if (o.schema === SCHEMA) {
        // Buang entri tak konsisten supaya UI tidak melempar.
        var units = {}, order = [];
        (o.order || []).forEach(function (k) {
          if (o.units && o.units[k]) { units[k] = o.units[k]; order.push(k); }
        });
        return {
          status: o.status || (order.length ? 'READY' : 'EMPTY'),
          units: units, order: order, savedAt: o.savedAt || null
        };
      }
      if (o.schema === SCHEMA_V1) return migrateV1(o);
      return null;
    } catch (e) {
      return null;
    }
  }

  /** Baca `fuel.store.v1` bila ada. Tidak melempar. */
  function loadLegacy() {
    var st = storage();
    if (!st) return null;
    var raw = null;
    try { raw = st.getItem(KEY); } catch (e) { return null; }
    _lastRaw = raw;
    if (!raw) return null;
    return parseRaw(raw);
  }

  /**
   * persistLegacy() — tulis ke localStorage.
   * Dipakai HANYA saat IndexedDB tidak tersedia (mode cadangan).
   */
  function persistLegacy() {
    var st = storage();
    var state = ensure();
    if (!st) return { ok: false, reason: 'no-storage' };
    try {
      var units = {};
      state.order.forEach(function (k) { units[k] = state.units[k]; });
      var payload = JSON.stringify({
        schema: SCHEMA, status: state.status,
        units: units, order: state.order.slice(), savedAt: state.savedAt
      });
      st.setItem(KEY, payload);
      _lastRaw = payload;
      return { ok: true };
    } catch (e) {
      // Kuota penuh. JANGAN jatuh ke tempat lain; laporkan jujur.
      if (global.console && global.console.warn) {
        global.console.warn('[FUEL_STORE] Gagal menyimpan ke localStorage:', e && e.message);
      }
      return { ok: false, reason: 'quota' };
    }
  }

  /* ---------------------------------------------------------------------
   * Tulis ke IndexedDB (async, berantai)
   *
   * BERANTAI, bukan serentak: dua penulisan ke kunci yang sama harus terjadi
   * berurutan agar yang terakhir menang — persis seperti localStorage.
   * ------------------------------------------------------------------- */
  function queueWrite(job, label) {
    var d = DB();
    if (!d) return;
    _writeChain = _writeChain.then(function () {
      return job(d);
    }).catch(function (e) {
      // Kegagalan tulis DICATAT, bukan ditelan. `takeWriteError()` membacanya
      // supaya UI bisa memberi tahu operator.
      _writeErrors.push({ key: label, reason: (e && e.message) || 'gagal tulis' });
      if (global.console && global.console.warn) {
        global.console.warn('[FUEL_STORE] Gagal menulis ' + label + ':', e && e.message);
      }
    });
  }

  function pushUnit(unit) {
    queueWrite(function (d) { return d.put(unit); }, unit && unit.key);
  }
  function pushRemove(key) {
    queueWrite(function (d) { return d.remove(key); }, key);
  }
  function pushClear() {
    queueWrite(function (d) { return d.clear(); }, '*');
  }

  /**
   * takeWriteError() -> {key, reason}|null
   * Mengambil (dan mengosongkan) kegagalan tulis pertama yang belum
   * dilaporkan, supaya "data tampil di layar tetapi gagal tersimpan" tidak
   * pernah lolos tanpa pesan.
   */
  function takeWriteError() {
    if (!_writeErrors.length) return null;
    return _writeErrors.shift();
  }

  /** flush() -> Promise — tunggu semua tulis selesai. Dipakai uji & tutup halaman. */
  function flush() {
    return _writeChain.then(function () { return true; });
  }

  /* ---------------------------------------------------------------------
   * setUnit
   * ------------------------------------------------------------------- */
  function setUnit(meta, res) {
    var st = ensure();
    var key = keyOf(meta, res);
    var isNew = !st.units[key];
    if (isNew && st.order.length >= MAX_UNITS) {
      return { ok: false, reason: 'max-units', key: key };
    }
    var summary = compact(res);
    // [FIX 2026-10-29] Keadaan SEBELUM disimpan — dipakai mengembalikan
    // memori bila penyimpanan gagal. Tanpa ini, unit yang ditolak kuota
    // TETAP ada di `_state` sehingga `list()` melaporkannya dan tabel
    // menampilkannya; sesudah reload unit itu hilang tanpa jejak.
    var prevUnit = isNew ? null : st.units[key];
    var prevStatus = st.status, prevSavedAt = st.savedAt;

    st.units[key] = {
      key: key,
      serial: String((meta && meta.serial) || '').trim(),
      model: String((meta && meta.model) || summary.model || '').trim(),
      source: String((meta && meta.name) || '').trim(),
      weakKey: key.charAt(0) !== 'S:',
      legacy: false,
      updatedAt: Date.now(),
      summary: summary
    };
    if (isNew) st.order.push(key);
    st.status = 'READY';
    st.savedAt = Date.now();

    if (_mode === 'idb' && idbReady()) {
      // Cermin permanen. Kuota 1,5 GB tidak mungkin ditolak pada ukuran
      // wajar, jadi kegagalan tulis dilaporkan TERPISAH lewat
      // `takeWriteError()` — bukan dengan membatalkan perubahan memori yang
      // sudah tampil di layar.
      //
      // [FIX 2026-10-30] Syarat `_mode === 'idb'` WAJIB ikut. Dulu cukup
      // `idbReady()`, sehingga uji jalur CADANGAN tetap menulis ke IndexedDB
      // dan aturan rollback kuota tidak pernah dijalankan. Mode yang dipaksa
      // (mis. karena IndexedDB gagal saat hydrate) harus DIHORMATI.
      pushUnit(st.units[key]);
      return { ok: true, reason: null, key: key, async: true };
    }

    // CADANGAN localStorage: perilaku lama, termasuk rollback.
    var p = persistLegacy();
    if (!p.ok && p.reason === 'quota') {
      if (isNew) {
        delete st.units[key];
        var at = st.order.indexOf(key);
        if (at >= 0) st.order.splice(at, 1);
      } else {
        st.units[key] = prevUnit;
      }
      st.status = prevStatus;
      st.savedAt = prevSavedAt;
    }
    return { ok: p.ok, reason: p.reason, key: key };
  }

  /** setResult(res) — KOMPATIBILITAS API lama (satu unit). */
  function setResult(res) {
    return setUnit({
      serial: (res && res.serial) || '',
      model: (res && res.model) || '',
      name: ''
    }, res).ok;
  }

  /** Hapus satu unit. @returns {boolean} true bila ada yang dihapus. */
  function removeUnit(serialOrKey) {
    var st = ensure();
    var key = String(serialOrKey);
    if (!st.units[key]) key = 'S:' + key;
    if (!st.units[key]) return false;
    delete st.units[key];
    st.order = st.order.filter(function (k) { return k !== key; });
    if (!st.order.length) st.status = 'EMPTY';
    st.savedAt = Date.now();
    if (_mode === 'idb' && idbReady()) pushRemove(key);
    else persistLegacy();
    return true;
  }

  /**
   * migrateV1(o) — schema 1 (satu `summary`) -> schema 2 (daftar unit).
   * Unit hasil migrasi ditandai `legacy` supaya UI bisa menjelaskan asalnya
   * (bukan hasil analisis yang baru dijalankan).
   */
  function migrateV1(o) {
    var s = o && o.summary;
    if (!s) return { status: 'EMPTY', units: {}, order: [], savedAt: (o && o.savedAt) || null };
    var serial = String(s.serial || '').trim();
    var key = serial ? 'S:' + serial : 'M:' + String(s.model || '') + '|(data lama)';
    var unit = {
      key: key, serial: serial, model: String(s.model || ''),
      source: '(data lama)', weakKey: !serial, legacy: true,
      updatedAt: (o && o.savedAt) || null, summary: s
    };
    var units = {};
    units[key] = unit;
    return { status: 'READY', units: units, order: [key], savedAt: (o && o.savedAt) || null };
  }

  /* ---------------------------------------------------------------------
   * hydrate() — SATU-SATUNYA titik asinkron
   * ------------------------------------------------------------------- */
  /**
   * hydrate() -> Promise<{mode, units, migrated, reason}>
   *
   *   1. IndexedDB tersedia? tidak -> muat localStorage (mode lama).
   *   2. MIGRASI: bila IndexedDB kosong & localStorage berisi, pindahkan.
   *      Bila IndexedDB sudah berisi, migrasi DILEWATI (tidak menimpa).
   *   3. Muat seluruh unit ke MEMORI.
   *
   * Bila langkah mana pun gagal, modul JATUH ke localStorage dan MELAPORKAN
   * sebabnya. Tidak ada jalur yang membuat data tampak ada padahal tidak.
   */
  function hydrate() {
    if (!idbReady()) {
      _state = loadLegacy() || blank();
      _mode = 'localstorage';
      _hydrated = true;
      return Promise.resolve({
        mode: 'localstorage', units: list().length, migrated: null,
        reason: DB() ? 'idb-api-tidak-tersedia' : 'modul-fuel-db-tidak-ada'
      });
    }
    var db = DB();
    var migrasi = null;
    /* [CATATAN KEJUJURAN 2026-10-30] Saya sempat menambahkan `flush()` di sini
     * dengan alasan "agar hydrate tidak menimpa memori dengan data yang belum
     * memuat tulis terakhir". SABOTASE MEMBUKTIKAN ITU KLAIM KOSONG: dengan
     * flush dibuang, perilakunya IDENTIK (diverifikasi `tools/_p.js`). Sebabnya
     * `migrateFromLocalStorage` & `all()` sendiri sudah menunggu rantai
     * transaksi IndexedDB.
     *
     * `flush()` DIPERTAHANKAN karena alasan yang berbeda dan tetap sah:
     * `hydrate()` adalah titik yang MENGGANTI seluruh memori dari disk. Bila
     * suatu saat urutan internal berubah (mis. migrasi memakai transaksi
     * terpisah yang lebih lambat), hydrate yang tidak menunggu akan menimpa
     * perubahan terakhir — kegagalan yang senyap dan mahal. Biayanya satu
     * microtask. Yang SALAH adalah mengklaim itu memperbaiki bug yang tidak
     * pernah ada, dan itulah yang dihindari di sini. */
    return flush().then(function () {
      return db.migrateFromLocalStorage(loadLegacy);
    }).then(function (mg) {
      migrasi = mg;
      return db.all();
    }).then(function (arr) {
      var units = {}, order = [];
      (arr || []).forEach(function (u) {
        if (!u || !u.key) return;
        units[u.key] = u;
        order.push(u.key);
      });
      _state = {
        status: order.length ? 'READY' : 'EMPTY',
        units: units, order: order,
        savedAt: order.length ? Date.now() : null
      };
      _mode = 'idb';
      _hydrated = true;
      return { mode: 'idb', units: order.length, migrated: migrasi, reason: null };
    }).catch(function (e) {
      // IndexedDB rusak/diblokir -> cadangan, TANPA menyembunyikan sebabnya.
      _state = loadLegacy() || blank();
      _mode = 'localstorage';
      _hydrated = true;
      return {
        mode: 'localstorage', units: list().length, migrated: migrasi,
        reason: 'idb-gagal: ' + ((e && e.message) || 'tidak diketahui')
      };
    });
  }

  function isHydrated() { return _hydrated; }
  function mode() { return _mode; }

  /**
   * setMode(m) — HANYA untuk uji. Menetapkan sumber yang dipakai `setUnit()`
   * tanpa menunggu `hydrate()`.
   *
   * KENAPA ADA: setelah migrasi, `setUnit()` menulis ke IndexedDB bila modul
   * DB tersedia. Uji yang ingin memeriksa jalur CADANGAN harus bisa memaksa
   * mode tanpa mematikan API global selama seluruh suite (itu mencemari uji
   * lain). Nilai tak dikenal DITOLAK, bukan diterima diam-diam.
   */
  function setMode(m) {
    if (m !== 'idb' && m !== 'localstorage') {
      throw new Error('mode tidak dikenal: ' + m);
    }
    // 'idb' hanya sah bila modulnya benar-benar ada.
    _mode = (m === 'idb' && !idbReady()) ? 'localstorage' : m;
    _hydrated = true;
    return _mode;
  }

  /**
   * compactLegacyKey() -> Promise<{removed:boolean, reason}>
   *
   * Padamkan `fuel.store.v1` SETELAH migrasi terverifikasi. Dipisah dari
   * `hydrate()` dengan sengaja: penghapusan hanya boleh terjadi ketika
   * jumlah unit di IndexedDB benar-benar >= jumlah unit lama. Bila ragu,
   * JANGAN hapus (prinsip yang sama dengan CLC: ragu = jangan potong).
   */
  function compactLegacyKey() {
    var st = storage();
    var legacy = loadLegacy();
    if (!st || !legacy || !legacy.order.length) {
      return Promise.resolve({ removed: false, reason: 'tidak-ada-data-lama' });
    }
    if (!idbReady()) return Promise.resolve({ removed: false, reason: 'idb-tidak-tersedia' });
    return DB().count().then(function (n) {
      if (n < legacy.order.length) {
        return {
          removed: false,
          reason: 'jumlah-idb-' + n + '-kurang-dari-lama-' + legacy.order.length
        };
      }
      try { st.removeItem(KEY); _lastRaw = null; }
      catch (e) { return { removed: false, reason: 'gagal-hapus: ' + e.message }; }
      return { removed: true, reason: 'terverifikasi ' + n + ' unit' };
    });
  }

  /** load() — kompatibilitas: memuat dari sumber yang sedang aktif (sinkron). */
  function load() {
    if (_mode === 'idb') return _state;   // sudah di memori lewat hydrate()
    _state = loadLegacy();
    return _state;
  }

  function getSummary() {
    var l = list();
    return l.length ? l[l.length - 1].summary : null;
  }

  function getStatus() {
    if (!_state) load();
    return _state ? _state.status : 'EMPTY';
  }

  function getSavedAt() {
    if (!_state) load();
    return _state ? _state.savedAt : null;
  }

  /**
   * clear() — hapus HANYA data fuel. Tombol "Hapus Data Fuel".
   * Menghapus di memori, IndexedDB, DAN localStorage: meninggalkan salinan
   * lama berarti data "terhapus" muncul kembali saat IndexedDB bermasalah.
   */
  function clear() {
    _state = null;
    _lastRaw = null;
    _writeErrors.length = 0;
    if (idbReady()) pushClear();
    var st = storage();
    if (st) { try { st.removeItem(KEY); } catch (e) { /* memori sudah kosong */ } }
    return true;
  }

  /** capacity() — angka TERUKUR untuk UI & dokumen. BUKAN perkiraan. */
  function capacity() {
    return {
      maxUnits: MAX_UNITS,
      kbPerUnit: MEASURED.kbPerUnit,
      mode: _mode,
      localStorageCapacity: Math.floor(MEASURED.localStorageKB / MEASURED.kbPerUnit),
      idbCapacity: Math.floor(MEASURED.idbQuotaKB / MEASURED.kbPerUnit)
    };
  }

  var FUEL_STORE = {
    KEY: KEY,
    SCHEMA: SCHEMA,
    SCHEMA_V1: SCHEMA_V1,
    MAX_UNITS: MAX_UNITS,
    compact: compact,
    keyOf: keyOf,
    setUnit: setUnit,
    setResult: setResult,
    list: list,
    getUnit: getUnit,
    removeUnit: removeUnit,
    load: load,
    getSummary: getSummary,
    getStatus: getStatus,
    getSavedAt: getSavedAt,
    clear: clear,
    // [FASE 1 2026-10-30] IndexedDB
    hydrate: hydrate,
    isHydrated: isHydrated,
    mode: mode,
    flush: flush,
    takeWriteError: takeWriteError,
    compactLegacyKey: compactLegacyKey,
    capacity: capacity,
    // [WILAYAH UJI]
    _migrateV1: migrateV1,
    _parseRaw: parseRaw,
    _setMode: setMode
  };

  global.FUEL_STORE = FUEL_STORE;
  if (typeof module !== 'undefined' && module.exports) module.exports = FUEL_STORE;

})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * sos-store.js
 * -------------------------------------------------------------------------
 * In-memory + localStorage store untuk data SOS.
 * [MIGRASI 2026-10-19] Pindah dari sessionStorage ke localStorage agar data
 * bertahan saat browser ditutup. Data hilang hanya saat klik "Kosongkan Semua".
 *
 * -------------------------------------------------------------------------
 * [FASE 3 2026-10-31] PENYIMPANAN PINDAH KE INDEXEDDB
 * -------------------------------------------------------------------------
 * Kuota localStorage ±5 MB per origin. Terukur dengan data aktual
 * (`tools/probe-sos-scale.js`): satu berkas SOS 2,9 MB = 2.305 sampel unik =
 * ±5,0 MB setelah round-trip JSON (2,2 KB/sampel). Satu berkas BERIKUTNYA
 * sudah melewati kuota, dan kegagalannya dulu SENYAP di sisi operator.
 *
 * KEPUTUSAN ARSITEKTUR — API TETAP SINKRON (pola Fase 1 / fuel-store.js)
 *   `sos-app.js`, `sos-render.js`, `sos-failmode.js`, `vhms-cross.js`,
 *   `vhms-settings.js`, `portfolio-render.js` dan `index.html` memakai 16
 *   fungsi store secara SINKRON (mis. `res.added` dibaca saat itu juga).
 *   Mengubahnya menjadi Promise berarti menulis ulang alur render seluruh
 *   halaman SOS sekaligus — risiko jauh lebih besar daripada manfaatnya.
 *
 *   Jadi:
 *     - SUMBER KEBENARAN saat berjalan = `_samples` di MEMORI.
 *     - IndexedDB = cermin permanen. Setiap perubahan memori dituliskan
 *       asinkron, dan kegagalan tulis DILAPORKAN (takeWriteError()).
 *     - `hydrate()` memuat isi IndexedDB ke memori saat aplikasi dibuka.
 *       Ini SATU-SATUNYA titik asinkron dan UI memanggilnya lebih dulu.
 *
 * BATAS JUJUR (WAJIB dibaca sebelum menambah fitur)
 *   1. Bila tab ditutup PERSIS di antara perubahan memori dan selesainya
 *      tulis, perubahan terakhir bisa hilang. Jendelanya milidetik, tetapi
 *      ada. Yang benar dijanjikan: "tersimpan segera setelahnya", bukan
 *      "tersimpan begitu diklik".
 *   2. localStorage TETAP dipakai sebagai CADANGAN bila IndexedDB mati —
 *      termasuk format PENUH `{samples:[...]}` sehingga data lama masih
 *      terbaca, bukan hanya penanda.
 *   3. Migrasi TIDAK menghapus `sos.fleet.v1`. Pemadaman hanya lewat
 *      `compactLegacyKey()` setelah jumlah sampel di IndexedDB TERVERIFIKASI.
 *   4. `Date` disimpan APA ADANYA oleh IndexedDB (structured clone). Format
 *      localStorage menyimpannya sebagai string ISO, jadi `hydrate()` dan
 *      `restore()` WAJIB memulihkannya — terukur: 9.700 tanggal pada data
 *      aktual berubah menjadi string bila tanpa pemulihan.
 * ========================================================================= */

(function (global) {
  'use strict';

  var STORAGE_KEY = 'sos.fleet.v1';
  /* [FASE 3] Penanda "memori sudah disinkronkan dari IndexedDB". Hanya
   * dipakai saat data terlalu besar untuk cadangan localStorage penuh. */
  var NOTICE_KEY = 'sos.idb.v2';
  /* [STARTUP 2026-10-31] Batas cadangan localStorage PENUH (karakter). Lihat
   * `persistLegacy()`: di atas ini hanya penanda yang disimpan. */
  var LEGACY_FULL_MAX = 4 * 1024 * 1024;

  var _samples = [];       // all raw samples
  var _analysis = null;    // result of analyzeFleet
  var _sourceFiles = [];   // list of uploaded file names
  var revision = 0;        // invalidasi cache konsumen lintas-modul

  /* [FASE 3] Transport & status */
  var _mode = 'memori';    // 'idb' | 'localstorage'
  var _hydrated = false;
  var _writeChain = Promise.resolve();   // serialisasi tulis IndexedDB
  var _writeErrors = [];                 // kegagalan tulis yang BELUM dilaporkan
  var _seq = 0;                          // penomoran urutan masuk

  function getRevision() { return revision; }

  function DB() { return global.SOS_DB || null; }
  function idbReady() {
    var d = DB();
    return !!(d && d.available && d.available());
  }

  /* Status persistensi harus setara VHMS: analitik boleh terus berjalan,
   * tetapi kegagalan penyimpanan TIDAK boleh disembunyikan dari operator. */
  var storageStatus = { ok: true, quotaExceeded: false, sampleCount: 0, bytes: 0, message: '' };

  function getStorageStatus() {
    return {
      ok: storageStatus.ok,
      quotaExceeded: storageStatus.quotaExceeded,
      sampleCount: storageStatus.sampleCount,
      bytes: storageStatus.bytes,
      message: storageStatus.message,
      mode: _mode
    };
  }

  function isQuotaError(e) {
    if (!e) return false;
    if (e.code === 22 || e.code === 1014) return true;
    var name = String(e.name || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
  }

  function storage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  /* -----------------------------------------------------------------------
   * [CLC 2026-10-04] Filter Umur Komponen (Component Life Cut-off).
   * Modul murni COMPONENT_LIFE adalah SATU-SATUNYA pemilik logika potong.
   * Di sini kita hanya: (1) minta anotasi `_clc` pada seluruh sampel,
   * (2) memberi analitik sampel yang LOLOS saja.
   * Saat fitur NONAKTIF, `_effectiveSamples()` mengembalikan array yang SAMA
   * (referensi identik) -> keluaran byte-identik baseline (test R1).
   * --------------------------------------------------------------------- */
  function _clc() { return global.COMPONENT_LIFE || null; }

  /** Jalankan anotasi CLC (aman bila modul belum termuat / fitur nonaktif). */
  function _annotateClc() {
    var clc = _clc();
    if (!clc || typeof clc.annotateSosSamples !== 'function') return;
    try { clc.annotateSosSamples(_samples); } catch (e) { /* jangan ganggu alur */ }
  }

  /** Sampel yang dipakai untuk analitik (terfilter bila CLC aktif). */
  function _effectiveSamples() {
    var clc = _clc();
    if (!clc || typeof clc.filterSosSamples !== 'function') return _samples;
    return clc.filterSosSamples(_samples);
  }

  /* [STARTUP 2026-10-31] Analitik armada pada data nyata (25.964 sampel,
   * ±2.600 unit) terukur ±0,7–1,1 detik — SATU tugas sinkron yang
   * MEMBEKUKAN halaman. Pemanggil (sos-app.js) menjalankannya setelah
   * halaman tergambar; `_analyzing` mencegah dua tugas analitik berjalan
   * bersamaan pada `_samples`, yang akan membuat keduanya menulis
   * `risk_tier`/`_violations` ke sampel yang sama tanpa jaminan urutan. */
  var _analyzing = false;

  /** Analisa ulang dengan sampel yang sesuai status CLC. */
  function _analyze() {
    _annotateClc();
    _analyzing = true;
    try {
      _analysis = global.SOS_ANALYTICS.analyzeFleet(_effectiveSamples());
      _analysisBuilt = true;
    } finally {
      _analyzing = false;
    }
    revision++;
    return _analysis;
  }

  /* -----------------------------------------------------------------------
   * Notifikasi UI
   * ---------------------------------------------------------------------
   * [STARTUP 2026-10-31] Store dipakai juga tanpa DOM (Node, uji, alat), jadi
   * SEMUA pemberitahuan ke renderer lewat SATU pintu dengan penjaga. Tanpa
   * ini, daftar yang digambar sebelum analitik bisa tertinggal berisi data
   * lama sesudah data berubah (mis. "Kosongkan Semua" menampilkan baris
   * kosong, tetapi grid KPI masih memajang angka armada lama).
   * Kegagalan di sisi UI TIDAK PERNAH menggagalkan operasi data.
   */
  function _invalidateUi() {
    try {
      var r = global.SOS_RENDER;
      if (!r) return;
      if (r.resetKpiCache) r.resetKpiCache();
      if (r.invalidateFleetCaches) r.invalidateFleetCaches();
    } catch (e) { /* UI belum siap / renderer gagal — data tetap benar */ }
  }

  /**
   * [STARTUP 2026-10-31] Analitik dapat DITUNDA ketika memuat halaman.
   *
   * LATAR (terukur, 25.964 sampel): `restore()` memanggil `_analyze()`
   * (±650–1.000 ms) SEBELUM halaman bisa diklik. Padahal pada pemuatan
   * berikutnya hasil analitik SUDAH tersimpan di setiap sampel (`risk_tier`,
   * `_violations`, `mprs_score`, `*_fe_100` — ditulis `commitAnalysis`/
   * `addSamples`), jadi yang benar-benar hilang hanya objek unit turunan
   * (irisan jendela 4000 jam, diagnosis, umur oli) yang bisa dibangun
   * BERTAHAP setelah halaman tampil — atau tidak sama sekali bila operator
   * membuka unit langsung (analitik penuh untuk unit itu dihitung saat
   * dibuka, tepat untuk threshold sekarang).
   *
   * `_analysisBuilt` = false berarti "data ada, hasil unit belum dibangun".
   * Dibedakan dari `_analysis === null` (data kosong) supaya daftar unit
   * tetap bisa digambar dari sampel.
   */
  var _analysisBuilt = true;

  function hasData() { return _samples.length > 0; }

  /** Data ada tetapi hasil analitiknya belum dibangun (mode pemuatan cepat). */
  function isAnalysisPending() { return _samples.length > 0 && !_analysisBuilt; }

  /** true selama `_analyze()` berjalan (dibaca pemanggil penjadwal). */
  function isAnalyzing() { return _analyzing; }

  /**
   * [STARTUP 2026-10-31] Hitung ulang analitik di MEMORI saja — dipakai
   * penjadwal saat halaman dibuka (init) sebelum ada tulisan apa pun.
   *
   * ⚠ NAMA SENGAJA BERBEDA dari `reanalyze()` di bawah. Versi pertama saya
   * menamainya `reanalyze` dan **MENIMPA** fungsi itu (di berkas yang sama,
   * hoisting membuat definisi terakhir menang): versi itu mengembalikan
   * ANALITIK, sedangkan pemanggil lama (`vhms-settings`) mengharapkan JUMLAH
   * SAMPEL, dan `_persist()` tidak lagi dijalankan. Terukur oleh uji SOS-22
   * (`typeof` angka, bukan objek) — bukan oleh review.
   */
  function analyzeInPlace() { return _analyze(); }

  /**
   * [STARTUP 2026-10-31] Dipakai penjadwal di sos-app.js yang menghitung
   * analitik BERTAHAP (beginFleet -> analyzeGroup per potongan -> finishFleet).
   *
   * `commitAnalysis(hasil)` memasang hasil itu seperti `analyzeInPlace()`:
   * menandai tugas berjalan selama pemasangan (agar penjadwal tidak
   * menjalankan analitik kedua pada sampel yang sama), lalu menyegarkan UI.
   *
   * ⚠ `_persist()` SENGAJA TIDAK dipanggil (beda dari `reanalyze()`):
   * analitik bertahap hanya menulis field TURUNAN (`risk_tier`,
   * `_violations`, `mprs_score`, `*_fe_100`) pada sampel yang sudah ada di
   * disk. `reanalyze()` menulis ulang SELURUH armada (±55 MB JSON) — itu
   * untuk threshold yang BERUBAH, bukan untuk pembukaan halaman.
   */
  function commitAnalysis(result) {
    _analyzing = true;
    try {
      _analysis = result || null;
      _analysisBuilt = true;
      revision++;
    } finally {
      _analyzing = false;
    }
    _invalidateUi();
    return _analysis;
  }

  /** Sampel yang dipakai analitik (terfilter CLC bila fitur aktif). */
  function getEffectiveSamples() { return _effectiveSamples(); }

  /* -----------------------------------------------------------------------
   * Core
   * --------------------------------------------------------------------- */

  /**
   * [DEDUP 2026-10-01] Bangun KUNCI IDENTITAS unik sebuah sampel SOS.
   *  - Utama : `lab_no` (nomor lab unik) bila ada.
   *  - Fallback: komposit `assetId|component|tanggal(YYYY-MM-DD)|hm_unit`
   *    agar sampel TANPA lab_no tetap bisa dideteksi duplikatnya (mis. file
   *    di-upload ulang). Bila tanggal & HM sama-sama kosong, kunci = null
   *    (tidak dapat di-dedup dengan aman -> dibiarkan ditambahkan).
   * @param {object} s sampel
   * @returns {string|null}
   */
  function sampleKey(s) {
    if (!s) return null;
    if (s.lab_no !== null && s.lab_no !== undefined && String(s.lab_no).trim() !== '') {
      return 'labno:' + String(s.lab_no).trim().toUpperCase();
    }
    var asset = String(s.asset_id == null ? '' : s.asset_id).trim().toUpperCase();
    var comp = String(s.component == null ? '' : s.component).trim().toUpperCase();
    if (!asset && !comp) return null;
    // Tanggal: pakai _date (Date) -> ISO YYYY-MM-DD; fallback '' bila tak ada.
    var dateKey = '';
    var d = s._date || s.lab_date || s.sampled_date;
    if (d) {
      var dd = (d instanceof Date) ? d : new Date(d);
      if (!isNaN(dd.getTime())) dateKey = dd.toISOString().slice(0, 10);
    }
    // HM dipakai sbg pembeda bila tanggal sama/kosong.
    var hm = (s.hm_unit !== null && s.hm_unit !== undefined) ? s.hm_unit : '';
    // Butuh minimal SATU pembeda (tanggal atau HM) agar tidak over-merge.
    if (!dateKey && hm === '') return null;
    return 'comp:' + asset + '|' + comp + '|' + dateKey + '|' + hm;
  }

  /** Kunci identitas sampel untuk penyimpanan; cadangan ber-indeks bila null. */
  function _keyOf(s, i) {
    return sampleKey(s) || ('raw:#' + (s && s._seq != null ? s._seq : i));
  }

  /**
   * Kunci IDENTITAS LONGGAR — hanya asset|component|HM, TANPA tanggal.
   * Alasan: lab bisa mengoreksi tanggal sampling, sehingga kunci komposit
   * (yang memuat tanggal) berubah untuk sampel yang SAMA. Tanpa kunci
   * longgar, sampel itu tersimpan DUA kali (yang lama tidak pernah dihapus).
   * `_dateStr` pada data aktual HANYA tanggal (tanpa jam) — memakainya
   * sebagai pembeda justru akan GAGAL mendeteksi koreksi tanggal.
   * @returns {string|null} null bila terlalu lemah untuk dipakai
   */
  function looseKey(s) {
    if (!s) return null;
    var asset = String(s.asset_id == null ? '' : s.asset_id).trim().toUpperCase();
    var comp = String(s.component == null ? '' : s.component).trim().toUpperCase();
    var hm = (s.hm_unit !== null && s.hm_unit !== undefined) ? s.hm_unit : '';
    if (!asset || !comp || hm === '') return null;
    return 'loose:' + asset + '|' + comp + '|' + hm;
  }

  /**
   * Tambah sampel dengan DEDUP "data BARU menang" (menggantikan lama).
   *  - Kunci `lab_no` sama -> sampel baru MENGGANTIKAN yang lama (posisi tetap).
   *  - Tanpa lab_no -> pakai kunci komposit (asset|component|tanggal|HM).
   * @returns {{added:number, replaced:number, total:number}}
   */
  function addSamples(newSamples, fileName) {
    if (!newSamples || !newSamples.length) return { added: 0, replaced: 0, total: _samples.length };

    // Peta kunci -> indeks di _samples (untuk penggantian "baru menang").
    var keyIndex = {};
    var looseIndex = {};
    function look(s, i) {
      var k = sampleKey(s);
      if (k && keyIndex[k] === undefined) keyIndex[k] = i;
      var lk = looseKey(s);
      if (lk && looseIndex[lk] === undefined) looseIndex[lk] = i;
    }
    _samples.forEach(function (s, i) { _stampSeq(s); look(s, i); });

    var added = 0, replaced = 0;
    var toDisk = [];      // record yang ditulis ke IndexedDB (satu transaksi)
    var removedKeys = []; // kunci record lama yang harus dibuang
    // Record per kunci DALAM BATCH INI. Dua baris dengan kunci sama di satu
    // berkas (terukur: 121 duplikat pada data aktual) TIDAK boleh dikirim
    // dua kali ke IndexedDB — satu galat ConstraintError membatalkan
    // seluruh transaksi sehingga NOL sampel tersimpan.
    var batch = {};

    function emit(s, k) {
      var rec = _record(s, k);
      if (batch[k]) {
        batch[k].rec.s = s;
        batch[k].rec.seq = rec.seq;
        batch[k].rec.unitKey = rec.unitKey;
      } else {
        batch[k] = { rec: rec };
        toDisk.push(rec);
      }
    }

    /** Nyatakan bahwa kunci `k` tidak boleh tertinggal di disk. */
    function dropOld(k) {
      if (batch[k]) { batch[k] = null; }   // belum terkirim -> batalkan
      else if (removedKeys.indexOf(k) < 0) removedKeys.push(k);
    }

    newSamples.forEach(function (s) {
      if (!s) return;
      _stampSeq(s);
      var k = sampleKey(s);
      var at = (k && keyIndex[k] !== undefined) ? keyIndex[k] : undefined;
      /* Kunci longgar dipakai bila kunci PASTI belum cocok.
       * [BUG NYATA 2026-10-31] Syarat "sampel baru tidak punya lab_no" yang
       * saya pasang di versi pertama MEMATIKAN seluruh mekanisme: justru
       * berkas baru yang membawa lab_no-lah yang perlu menemukan sampel lama
       * berkunci komposit (tanpa lab_no). Terukur: sampel muncul DUA kali.
       * Yang benar: kalau kuncinya tidak cocok, cari padanan longgar pada
       * sampel yang kuncinya masih "lemah" (bukan lab_no). */
      if (at === undefined) {
        var lk = looseKey(s);
        var cand = (lk && looseIndex[lk] !== undefined) ? looseIndex[lk] : undefined;
        if (cand !== undefined && !_hasLabNo(_samples[cand])) at = cand;
      }
      if (at !== undefined) {
        // Data BARU menang: ganti sampel lama di posisi yang sama (agar urutan stabil).
        var old = _samples[at];
        s._seq = (old && old._seq) || s._seq;
        _samples[at] = s;
        replaced++;
        // [!] Dua sampel tanpa lab_no yang SAMA (asset|comp|tanggal|HM) akan
        // menghasilkan kunci `raw:#N` BERBEDA karena `_seq` berbeda. Kunci
        // itu tidak boleh dipakai ulang — pakai kunci lama bila ADA.
        var storeKey = k || _keyOf(old, at);
        var oldKey = _keyOf(old, at);
        emit(s, storeKey);
        if (k && keyIndex[k] === undefined) keyIndex[k] = at;
        if (oldKey !== storeKey) dropOld(oldKey);
      } else {
        if (k) keyIndex[k] = _samples.length;
        var lk2 = looseKey(s);
        if (lk2 && looseIndex[lk2] === undefined) looseIndex[lk2] = _samples.length;
        _samples.push(s);
        added++;
        emit(s, k || _keyOf(s, _samples.length - 1));
      }
    });

    // Record yang dibatalkan (`dropOld`) tidak boleh ikut dikirim.
    toDisk = toDisk.filter(function (r) { return batch[r.key] && batch[r.key].rec === r; });

    if (fileName && _sourceFiles.indexOf(fileName) === -1) {
      _sourceFiles.push(fileName);
    }

    // Re-analyze (CLC: anotasi dulu, lalu analitik memakai sampel yang lolos)
    _analyze();
    _invalidateUi();

    // Persist — IndexedDB (cermin) atau localStorage (cadangan)
    _persist(toDisk, removedKeys);

    // Kembalikan objek statistik (kompatibel: angka tetap dibaca sebagai `added`).
    return { added: added, replaced: replaced, total: _samples.length };
  }

  function _hasLabNo(s) {
    return !!(s && s.lab_no !== null && s.lab_no !== undefined && String(s.lab_no).trim() !== '');
  }

  function getAnalysis() { return _analysis; }
  function count() { return _samples.length; }

  function clear() {
    _samples = [];
    _analysis = null;
    _analysisBuilt = true;          // tak ada data -> tak ada yang tertunda
    _sourceFiles = [];
    revision++;
    _seq = 0;
    _writeErrors.length = 0;
    // [FASE 3] Hapus dari IndexedDB + localStorage (utama) + sessionStorage
    // (legacy). Meninggalkan salinan berarti data "terhapus" muncul kembali
    // setelah reload — masalah yang justru diperbaiki di sini.
    if (_mode === 'idb' && idbReady()) {
      queueWrite(function (d) { return d.clear(); }, '*');
    }
    try {
      var st = storage();
      if (st) { st.removeItem(STORAGE_KEY); st.removeItem(NOTICE_KEY); }
    } catch (e) {}
    try { if (global.sessionStorage) global.sessionStorage.removeItem(STORAGE_KEY); } catch (e2) {}
    /* [STARTUP 2026-10-31] Notifikasi UI — lihat `_invalidateUi()`. */
    _invalidateUi();
    storageStatus = { ok: true, quotaExceeded: false, sampleCount: 0, bytes: 0, message: '' };
  }

  /* -----------------------------------------------------------------------
   * [FASE 3] Record IndexedDB
   * --------------------------------------------------------------------- */
  /** Nomor urut masuk — urutan sampel TIDAK boleh bergantung pada nama kunci. */
  function _stampSeq(s) {
    if (!s) return;
    if (s._seq === undefined || s._seq === null) s._seq = _seq++;
    else if (s._seq >= _seq) _seq = s._seq + 1;
  }

  /**
   * _record(s, key) -> record untuk IndexedDB.
   * `unitKey` adalah field KOPI (bukan dihitung ulang saat membaca) karena
   * index IndexedDB hanya bisa atas field yang tersimpan.
   * `_clc` SENGAJA tidak disimpan: anotasi dibangun ulang saat restore dan
   * berisi referensi objek yang tidak layak disimpan.
   */
  function _record(s, key) {
    return {
      key: key,
      seq: (s && s._seq) || 0,
      unitKey: String((s && s.asset_id) || '') + '||' + String((s && s.component) || ''),
      s: s
    };
  }

  /**
   * [STARTUP 2026-10-31] Pemeliharaan cadangan localStorage saat memuat:
   *   1. Sudah "idb" tetapi kunci penuh masih ada -> pindahkan isinya ke
   *      IndexedDB lewat migrasi yang SAMA (`_migrateLegacy`, idempoten),
   *      lalu hapus kuncinya. Tanpa ini salinan lama (terukur 85 MB pada
   *      data operator) tetap tersimpan DAN tetap dibongkar setiap reload
   *      — pemborosan yang menunda halaman siap ±200 ms. Kegagalan migrasi
   *      berarti kunci TIDAK dihapus (data lama tetap selamat).
   *   2. Tidak ada penanda/lama lagi -> `dropStaleLegacy()` (eksplisit, uji).
   * @returns {Promise<void>} tidak pernah menolak
   */
  function settleLegacy() {
    var legacy = readLegacy();
    if (!legacy) return Promise.resolve();
    if (_mode === 'idb' && idbReady() && legacy.full && legacy.samples && legacy.samples.length) {
      var migrasi;
      try { migrasi = _migrateLegacy(legacy); }
      catch (e) { return Promise.resolve(); }
      return migrasi.then(function (r) {
        if (r && (r.reason === 'ok' || r.reason === 'sudah-pernah')) {
          try {
            var st = storage();
            if (st) { st.removeItem(STORAGE_KEY); st.removeItem(NOTICE_KEY); }
          } catch (e2) { /* biarkan; percobaan berikutnya lagi */ }
        }
      }, function () { /* gagal: kunci dipertahankan */ });
    }
    if (!(_mode === 'idb' && idbReady())) return Promise.resolve();
    dropStaleLegacy();
    return Promise.resolve();
  }

  /**
   * [REVISI 2026-11-01] Pastikan tanggal efektif (_date & _dateStr) mengutamakan
   * Header Lab Date (lab_date), dengan fallback ke sampled_date, lalu distribution_date.
   */
  function _ensureEffectiveDate(s) {
    if (!s) return;
    var eff = s.lab_date || s.sampled_date || s.distribution_date || s._date;
    if (eff) {
      if (typeof eff === 'string') {
        var parsed = new Date(eff);
        if (!isNaN(parsed.getTime())) eff = parsed;
      }
      if (eff instanceof Date && !isNaN(eff.getTime())) {
        s._date = eff;
        var p = global.SOS_PARSER;
        if (p && typeof p.formatDate === 'function') {
          s._dateStr = p.formatDate(eff);
        } else {
          var dd = String(eff.getDate()).padStart(2, '0');
          var mm = String(eff.getMonth() + 1).padStart(2, '0');
          s._dateStr = dd + '/' + mm + '/' + eff.getFullYear();
        }
      }
    }
  }

  /**
   * fromRecords(records) -> Array<sample>
   * Membaca record IndexedDB MENJADI sampel memori.
   * - `_seq` dipulihkan supaya urutan tetap sama seperti sebelum reload.
   * - `Date` TIDAK dikonversi: IndexedDB menyimpan objek Date apa adanya
   *   (structured clone). Mengonversinya di sini akan MENGHANCURKAN tipe
   *   Date bila keliru. Pemulihan string hanya untuk format localStorage
   *   (lihat `_restoreDates`).
   */
  function fromRecords(records) {
    var out = [];
    (records || []).forEach(function (r) {
      var s = r && (r.s || r);
      if (!s || typeof s !== 'object') return;
      if (r && r.seq != null) s._seq = r.seq;
      if (s._seq != null && s._seq >= _seq) _seq = s._seq + 1;
      _ensureEffectiveDate(s);
      out.push(s);
    });
    return out;
  }

  /* -----------------------------------------------------------------------
   * Persistence — localStorage (CADANGAN) & IndexedDB (utama)
   * --------------------------------------------------------------------- */

  /** Serialisasi sampel ke objek JSON-friendly (Date -> ISO string). */
  function _serializeSamples() {
    return _samples.map(function (s) {
      var copy = {};
      for (var k in s) {
        if (k === '_clc') continue;            // CLC anotasi di-rebuild saat restore
        if (s[k] instanceof Date) copy[k] = s[k].toISOString();
        else copy[k] = s[k];
      }
      return copy;
    });
  }

  /**
   * _persist(toDisk, removedKeys)
   *  - IndexedDB: tulis record ke cermin permanen (berantai).
   *  - localStorage: simpan SALINAN PENUH bila masih muat; bila kuota penuh,
   *    simpan penanda (NOTICE_KEY) + laporkan bahwa cadangan tidak lengkap.
   *    Cadangan penuh yang sudah ada TIDAK dihapus: menghapus data lama yang
   *    masih sah lebih buruk daripada membiarkannya basi sedikit.
   */
  function _persist(toDisk, removedKeys) {
    if (_mode === 'idb' && idbReady()) {
      if (removedKeys && removedKeys.length) {
        queueWrite(function (db) { return db.removeMany(removedKeys); }, 'hapus-lama');
      }
      if (toDisk && toDisk.length) {
        queueWrite(function (db) { return db.putMany(toDisk); }, 'sampel');
      }
      // [BUG NYATA 2026-10-31] Status HANYA boleh "ok" bila tulis disk
      // benar-benar berhasil. Menyetel status sukses di sini membuat
      // kegagalan tulis IndexedDB tidak pernah terlihat lewat
      // `getStorageStatus()` — pola yang dilarang: analitik jalan,
      // kegagalan penyimpanan disembunyikan.
      _writeChain.then(function () {
        if (_writeErrors.length) {
          storageStatus = {
            ok: false, quotaExceeded: false, sampleCount: _samples.length, bytes: 0,
            message: 'Gagal menyimpan ' + (_writeErrors[0].reason || 'data') +
              ' ke IndexedDB. Data di layar tetap berjalan, tetapi bisa hilang setelah halaman dimuat ulang.'
          };
        } else {
          storageStatus = {
            ok: true, quotaExceeded: false, sampleCount: _samples.length, bytes: 0, message: ''
          };
        }
      });
      return;
    }
    persistLegacy();
  }

  /**
   * [STARTUP 2026-10-31] Ambil kunci cadangan yang BASI lalu hapus, supaya
   * pemuatan berikutnya TIDAK membongkar ulang JSON besar (terukur: 85 MB
   * lama disimpan, 99% berasal dari salinan lama; JSON.parse-nya ±200 ms
   * berkali-kali sebelum halaman bisa diklik).
   *
   * Kapan basi? HANYA bila ada data antara IndexedDB (atau penanda
   * NOTICE_KEY) — cadangan penuh adalah satu-satunya yang bisa menjadi
   * SATU-SATUNYA salinan, jadi tidak pernah dibuang karena "kelihatan tua".
   * Dipanggil SETELAH hydrate/migrasi selesai, tidak saat modul dimuat.
   */
  function dropStaleLegacy() {
    var st = storage();
    if (!st) return false;
    var adaPenanda = null;
    try { adaPenanda = st.getItem(NOTICE_KEY); } catch (e) { return false; }
    var adaIdb = _mode === 'idb' && idbReady();
    if (!adaIdb && !adaPenanda) return false;   // cadangan = salinan satu-satunya
    try {
      st.removeItem(STORAGE_KEY);
      st.removeItem(NOTICE_KEY);
      return true;
    } catch (e2) { return false; }
  }

  /** Tulis cadangan localStorage (format penuh lama: {samples, files, ts}). */
  function persistLegacy() {
    var st = storage();
    if (!st) {
      storageStatus = {
        ok: false, quotaExceeded: false, sampleCount: _samples.length, bytes: 0,
        message: 'Penyimpanan peramban tidak tersedia; data SOS hilang saat halaman dimuat ulang.'
      };
      return { ok: false, reason: 'no-storage' };
    }
    try {
      var payload = JSON.stringify({ samples: _serializeSamples(), files: _sourceFiles, ts: Date.now() });
      /* [STARTUP 2026-10-31] Di atas batas ini, cadangan penuh hanya
       * menambah biaya muat (JSON.parse ratusan milidetik) TANPA pernah
       * dibaca bila IndexedDB sehat — dan bila idb mati, menulisnya pun
       * hampir pasti gagal kuota. Simpan PENANDA saja (jumlah sampel),
       * bukan salinan kedua. Batas 4 MB aman di bawah kuota ±5 MB. */
      if (payload.length > LEGACY_FULL_MAX) {
        _markNotice(_samples.length);
        storageStatus = {
          ok: true, quotaExceeded: false, sampleCount: _samples.length, bytes: 0,
          message: ''
        };
        return { ok: true, noticeOnly: true };
      }
      st.setItem(STORAGE_KEY, payload);
      try { st.removeItem(NOTICE_KEY); } catch (e0) {}
      storageStatus = { ok: true, quotaExceeded: false, sampleCount: _samples.length, bytes: payload.length, message: '' };
      return { ok: true };
    } catch (e) {
      var quota = isQuotaError(e);
      // JANGAN menghapus salinan lama: isinya mungkin data sah sebelumnya.
      // Simpan penanda supaya operator tahu ada data yang tersimpan di
      // IndexedDB tetapi tidak tercadang di localStorage.
      _markNotice(_samples.length);
      storageStatus = {
        ok: false, quotaExceeded: quota, sampleCount: _samples.length, bytes: 0,
        message: quota
          ? 'Kuota localStorage penuh (' + _samples.length + ' sampel). Data SOS tersimpan di IndexedDB; cadangan localStorage tidak diperbarui.'
          : 'Gagal menyimpan data SOS ke penyimpanan peramban. Data di layar tetap berjalan, tetapi tidak bertahan setelah halaman dimuat ulang.'
      };
      if (global.console && global.console.warn) global.console.warn('[SOS_STORE] ' + storageStatus.message);
      return { ok: false, reason: quota ? 'quota' : 'error' };
    }
  }

  function _markNotice(n) {
    try {
      var st = storage();
      if (!st) return;
      if (n) st.setItem(NOTICE_KEY, JSON.stringify({ samples: n, files: _sourceFiles, ts: Date.now() }));
      else st.removeItem(NOTICE_KEY);
    } catch (e) { /* penanda hanya informasi */ }
  }

  /** Baca cadangan localStorage (penuh ATAU penanda). Tidak melempar. */
  function readLegacy() {
    var st = storage();
    if (!st) return null;
    var raw = null, notice = null;
    try { raw = st.getItem(STORAGE_KEY); } catch (e) { return null; }
    try { notice = st.getItem(NOTICE_KEY); } catch (e2) { notice = null; }
    if (!raw && !notice) return null;
    if (raw) {
      try {
        var data = JSON.parse(raw);
        if (data && data.samples && data.samples.length) {
          return { samples: _restoreDates(data.samples), files: data.files || [], full: true };
        }
      } catch (e3) { /* rusak -> coba penanda */ }
    }
    if (notice) {
      try {
        var nt = JSON.parse(notice);
        return { samples: [], files: nt.files || [], full: false, count: nt.samples || 0 };
      } catch (e4) { /* penanda rusak diabaikan */ }
    }
    return null;
  }

  /** Pulihkan Date dari string ISO (format localStorage). Lihat BATAS JUJUR 4. */
  function _restoreDates(arr) {
    var FIELDS = ['_date', 'sampled_date', 'lab_date', 'distribution_date'];
    arr.forEach(function (s) {
      if (!s) return;
      FIELDS.forEach(function (k) {
        if (typeof s[k] === 'string' && s[k]) {
          var d = new Date(s[k]);
          if (!isNaN(d.getTime())) s[k] = d;
        }
      });
      _ensureEffectiveDate(s);
      delete s._clc;
      delete s._sosDbK;
    });
    return arr;
  }

  /**
   * _hash(txt) -> string — sidik jari sederhana (djb2) untuk mendeteksi
   * bahwa record yang sudah ada di disk mewakili VERSI BERBEDA dari sampel
   * yang sama. Tanpa ini, `compactLegacyKey()` bisa memadamkan sampel yang
   * belum pernah ditulis ke IndexedDB (versi lampau yang kalah oleh
   * "data baru menang" sebelum migrasi).
   */
  function _hash(txt) {
    var h = 5381;
    var str = String(txt);
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /**
   * Sidik jari isi record (dipakai migrasi per record).
   * [BUG NYATA 2026-10-31] Semua `Date` dinormalisasi ke ISO-8601 lebih
   * dulu. Tanpa itu, sampel yang SAMA punya sidik jari berbeda hanya karena
   * satu tersimpan sebagai `Date` (IndexedDB) dan yang lain sebagai string
   * ISO (localStorage) — record akan ditimpa setiap kali hydrate.
   */
  function _fingerprint(sample) {
    return _hash(JSON.stringify(sample, function (k, v) {
      if (k === '_seq') return undefined;
      if (v instanceof Date) return 'D:' + v.toISOString();
      return v;
    }));
  }

  // Migrasi sekali: sessionStorage → localStorage
  (function _migrateFromSession() {
    try {
      if (!global.sessionStorage || !storage()) return;
      var old = global.sessionStorage.getItem(STORAGE_KEY);
      if (old && !storage().getItem(STORAGE_KEY)) {
        storage().setItem(STORAGE_KEY, old);
      }
      global.sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* abaikan */ }
  })();

  /* -----------------------------------------------------------------------
   * [FASE 3] Tulis IndexedDB berantai & pelaporan kegagalan
   *
   * BERANTAI, bukan serentak: dua penulisan harus terjadi berurutan agar
   * yang terakhir menang — persis seperti localStorage.
   * --------------------------------------------------------------------- */
  function queueWrite(job, label) {
    // [BUG NYATA 2026-10-31] Transport dibaca ULANG saat job dijalankan.
    // Versi pertama menangkap `DB()` di sini (saat antre) sementara
    // `_persist()` memakai `DB()` yang sama saat itu — begitu `global.SOS_DB`
    // diganti (mematikan IndexedDB sementara / transport uji), keduanya
    // menunjuk objek BERBEDA dan tulis tetap masuk ke tempat lama. Kini satu
    // sumber: `DB()` dipanggil di dalam job.
    _writeChain = _writeChain.then(function () {
      var d = DB();
      if (!d) return;
      // [BUG NYATA 2026-10-31] TANGKAP SYNC **DAN** ASYNC.
      // Versi pertama: `.catch()` di AKHIR rantai menelan galat lebih dulu
      // (tidak tercatat) DAN membuat rantai rejected sehingga semua tulis
      // berikutnya dilewati. Versi kedua: `p.then(null, f)` — tetapi bila
      // `job()` MELEMPAR SECARA SINKRON, `p` tidak pernah dibuat: galat
      // lolos melewati handlers dan handler rantai hanya menerima FULFILLED
      // (terukur: SOS-11 melihat `null` padahal tulis gagal).
      var p;
      try {
        p = job(d);
      } catch (e) {
        _writeErrors.push({ key: label, reason: (e && e.message) || 'gagal tulis' });
        return;
      }
      if (p && typeof p.then === 'function') {
        return p.then(null, function (e) {
          _writeErrors.push({ key: label, reason: (e && e.message) || 'gagal tulis' });
        });
      }
    });
    // Pelacak SEPARAT untuk log. Setiap `job` menelan galatnya sendiri
    // (dan `then(onFulfilled)` TANPA `onRejected` meneruskan penolakan),
    // jadi menghitung selisih `_writeErrors` sebelum/sesudah tulis ini
    // SELALU benar, berapa pun tulis yang mengantre di depannya.
    var before = _writeErrors.length;
    _writeChain.then(function () {
      for (var i = before; i < _writeErrors.length; i++) {
        if (global.console && global.console.warn) {
          global.console.warn('[SOS_STORE] Gagal menulis ' + _writeErrors[i].key + ':', _writeErrors[i].reason);
        }
      }
    });
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

  /** flush() -> Promise — tunggu semua tulis selesai (dipakai uji & tutup halaman). */
  function flush() {
    return _writeChain.then(function () { return true; });
  }

  /* -----------------------------------------------------------------------
   * restore() — SINKRON, dari localStorage
   * Aman dipanggil lebih dulu: `hydrate()` yang sukses MENGGANTI isi memori
   * dengan salinan IndexedDB yang lebih otoritatif.
   * --------------------------------------------------------------------- */
  function restore() {
    try {
      var legacy = readLegacy();
      if (!legacy || !legacy.samples || !legacy.samples.length) return false;
      _samples = legacy.samples;
      _samples.forEach(_stampSeq);
      _sourceFiles = legacy.files || [];
      /* [STARTUP 2026-10-31] TIDAK menjalankan `_analyze()` di sini.
       * Hasil per sampel sudah tersimpan; analitik armada dibangun
       * bertahap setelah halaman tampil (lihat `isAnalysisPending()`).
       * `_analysis` kini hanya hasil analitik yang MEMANG sudah dibangun. */
      _analysis = null;
      _analysisBuilt = false;
      revision++;
      // [STARTUP 2026-10-31] Isi data berganti → angka/urutan lama tak berlaku.
      _invalidateUi();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * _migrateLegacy(legacy) -> Promise<{moved, skipped, reason}>
   *
   * Migrasi PER RECORD, bukan "salin semuanya". Alasan (terukur dengan
   * data aktual): 2.426 baris berisi 121 duplikat. Versi localStorage menulis
   * SELURUH array pada setiap `addSamples`, sehingga duplikat "data baru
   * menang" selalu ikut tersimpan sebagai VERSI KEDUA. Record hasil migrasi
   * harus menggabungkan sikap yang sama di memori, BUKAN menyalin apa
   * adanya. Ini juga yang membuat penghapusan kunci lama aman: setiap
   * sampel versi lokal (yang akan menang) dipastikan ada di disk.
   *
   * Perbandingan memakai SIDIK JARI: kunci sama + isi berbeda = record harus
   * ditimpa. Tanpa itu, data yang sudah benar di disk tidak akan pernah
   * diperbarui untuk sampel yang isinya berubah.
   */
  function _migrateLegacy(legacy) {
    if (!legacy || !legacy.samples || !legacy.samples.length) {
      return DB().setMeta('migratedAt', Date.now())
        .then(function () { return { moved: 0, skipped: 0, reason: 'localstorage-kosong' }; });
    }
    var recs = legacy.samples.map(function (s, i) {
      if (s._seq == null) s._seq = i;
      if (s._seq >= _seq) _seq = s._seq + 1;
      var key = _keyOf(s, i);
      s._sosDbK = _fingerprint(s);
      return _record(s, key);
    });
    return DB().all().then(function (existing) {
      var daftar = existing || [];
      // [TIDAK MENIMPA] Data yang sudah ada di IndexedDB dianggap LEBIH BARU
      // (ditulis oleh sesi ini atau versi aplikasi yang lebih baru). Migrasi
      // hanya boleh mengisi disk yang KOSONG — sama seperti Fase 1
      // (`fuel-db.js`). Tanpa gerbang ini, membuka tab kedua bisa menimpa
      // data kerja dengan cadangan localStorage yang sudah basi.
      if (existing && existing.length) {
        return DB().setMeta('migratedAt', Date.now()).then(function () {
          return { moved: 0, skipped: daftar.length, reason: 'idb-sudah-berisi' };
        });
      }
      var ada = {};
      daftar.forEach(function (r) { if (r && r.key) ada[r.key] = r.s ? r.s._sosDbK : null; });
      var perlu = recs.filter(function (r) { return ada[r.key] !== r.s._sosDbK; });
      // Record lama yang kuncinya sama TIDAK perlu dihapus: `put` menimpa.
      return DB().putMany(perlu).then(function () { return DB().count(); }).then(function (total) {
        // Bandingkan dengan jumlah record UNIK yang ditulis, bukan jumlah
        // baris lama: data baru MENGGANTIKAN yang lama, jadi `total` memang
        // lebih kecil bila ada duplikat (terukur 121 dari 2.426).
        if (total === 0) {
          return { moved: 0, skipped: recs.length, reason: 'verifikasi-gagal' };
        }
        return DB().setMeta('migratedAt', Date.now()).then(function () {
          return DB().setMeta('migratedFrom', 'localStorage');
        }).then(function () {
          // `moved` = jumlah RECORD di disk yang mewakili versi lokal, bukan
          // jumlah sampel yang perlu ditulis (duplikat menyatu jadi 1).
          return { moved: Math.min(total, recs.length), skipped: 0, reason: 'ok' };
        });
      });
    });
  }

  /* -----------------------------------------------------------------------
   * hydrate() — SATU-SATUNYA titik asinkron
   * --------------------------------------------------------------------- */
  /**
   * hydrate() -> Promise<{mode, samples, units, migrated, pruned, reason}>
   *
   *   1. IndexedDB tersedia? tidak -> muat localStorage (mode lama), selesai.
   *   2. MIGRASI: IndexedDB kosong & localStorage berisi -> pindahkan.
   *      IndexedDB sudah berisi -> migrasi DILEWATI (tidak menimpa).
   *   3. Muat SELURUH sampel ke MEMORI (menggantikan apa pun di sana).
   *   4. BERSIHKAN record yatim agar tidak muncul lagi setelah reload.
   *   5. Bila isi disk BERBEDA dari cadangan lokal (sampel yang baru
   *
   * Bila langkah mana pun gagal, modul JATUH ke localStorage dan MELAPORKAN
   * sebabnya. Tidak ada jalur yang membuat data tampak ada padahal tidak.
   */
  function hydrate() {
    var db = DB();
    if (!idbReady()) {
      var leg = readLegacy();
      _samples = (leg && leg.samples) || [];
      _samples.forEach(_stampSeq);
      _sourceFiles = (leg && leg.files) || [];
      // [STARTUP 2026-10-31] Analitik armada TIDAK dijalankan di sini.
      _analysis = null;
      _analysisBuilt = !_samples.length;
      revision++;
      _mode = 'localstorage';
      _hydrated = true;
      return Promise.resolve({
        mode: 'localstorage', samples: _samples.length,
        units: _samples.length ? 'tertunda' : 0,
        migrated: null, pruned: 0,
        reason: db ? 'idb-api-tidak-tersedia' : 'modul-sos-db-tidak-ada'
      });
    }
    var migrasi = null;
    var legacy = readLegacy();
    return flush().then(function () {
      // `flush()` di sini PENGAMAN URUTAN (hydrate mengganti seluruh memori
      // dari disk), BUKAN perbaikan bug. Pelajaran Fase 1: jangan mengklaim
      // lebih dari itu — sabotase membuktikan membuangnya tidak mengubah
      // perilaku pada jalur yang sudah benar.
      return DB().getMeta('migratedAt').then(function (sudah) {
        if (sudah) {
          // [KONTRAK] Cadangan PENUH selalu menang walau migrasi sudah
          // pernah jalan (mis. tab lama masih memegang perubahan
          // terakhir). Gerbang 'sudah-pernah' hanya mencegah migrasi
          // berulang, bukan menolak snapshot yang lebih baru.
          return { moved: 0, skipped: 0, reason: 'sudah-pernah' };
        }
        // [PINDAH DARI sos-db.js] Migrasi memakai aturan IDENTITAS milik
        // store ini (sampleKey/looseKey) dan SIDIK JARI isi. Versi generik
        // di sos-db.js menyalin SELURUH array localStorage apa adanya —
        // termasuk 121 baris duplikat yang kalah "data baru menang".
        return _migrateLegacy(legacy);
      });
    }).then(function (mg) {
      migrasi = mg;
      return DB().all();
    }).then(function (records) {
      /* [BUG NYATA 2026-10-31] Uji SOS-18 membuktikan sampel "terhapus"
       * BANGKIT setelah reload. Kolaborasi dua cacat:
       *   1. `_persist()` menyetel status "ok" SEGERA walau tulis berantai
       *      belum jalan, sehingga Hapus Data bisa tampak berhasil padahal
       *      penghapusan di disk belum/tidak selesai.
       *   2. hydrate dulu memuat SEMUA record disk — termasuk yang seharusnya
       *      sudah dibuang.
       *
       * Perbaikan: cadangan localStorage PENUH dipakai sebagai SNAPSHOT
       * TERVERIFIKASI terakhir. Record yang tidak ada di sana dianggap yatim
       * dan dibuang (lintas tab sekaligus). Tanpa cadangan penuh, semua
       * record dimuat dan kegagalan tulis tetap DILAPORKAN (tidak disembunyikan).
       */
      /* [KOREKSI 2026-10-31] Versi pertama memakai daftar KUNCI cadangan
       * sebagai saringan. Itu salah: sidik jari yang berbeda (Date asli vs
       * string ISO) membuat sampel yang SAMA tampak "tidak dikenal" —
       * dan selain itu data lama/tab lain tidak punya cadangan sama sekali.
       *
       * Yang benar: cadangan menandai RENTANG URUTAN (seq) yang pernah sah.
       * Record di luar rentang itu = ditulis SETELAH snapshot (mis. sampel
       * yang sudah dihapus bangkit lagi), jadi dibuang. Record di dalam
       * rentang tetap dimuat walau tidak ada di cadangan. */
      var seqMaks = -1;
      if (legacy && legacy.full) {
        (legacy.samples || []).forEach(function (s) {
          var q = (s && s._seq != null) ? s._seq : -1;
          if (q > seqMaks) seqMaks = q;
        });
      }
      _samples = fromRecords(records.filter(function (r) {
        if (seqMaks < 0) return true;          // tak ada cadangan: muat semua
        return !r || r.seq == null || r.seq <= seqMaks;
      }));
      /* [STARTUP 2026-10-31] Sama seperti `restore()`: analitik armada TIDAK
       * dijalankan di sini (terukur ±0,5–1,0 detik yang membekukan halaman).
       * Penjadwal di sos-app.js membangunnya bertahap setelah halaman tampil. */
      _analysis = null;
      _analysisBuilt = false;
      revision++;
      _mode = 'idb';
      _hydrated = true;
      // [STARTUP 2026-10-31] Isi memori diganti salinan disk → UI lama basi.
      _invalidateUi();
      // Buang record yatim (lihat catatan di sos-db.js).
      var keep = _samples.map(_keyOf);
      return DB().pruneOrphans(keep).then(function (pr) {
        return {
          mode: 'idb', samples: _samples.length,
          // [STARTUP 2026-10-31] Analitik dibangun bertahap setelah halaman tampil.
          units: 'tertunda',
          migrated: migrasi, pruned: pr.removed, reason: null
        };
      });
    }).catch(function (e) {
      // IndexedDB rusak/diblokir -> cadangan, TANPA menyembunyikan sebabnya.
      var lg = readLegacy();
      _samples = (lg && lg.samples) || [];
      _samples.forEach(_stampSeq);
      _sourceFiles = (lg && lg.files) || [];
      _analysis = null;
      _analysisBuilt = !_samples.length;
      revision++;
      _mode = 'localstorage';
      _hydrated = true;
      _invalidateUi();
      return {
        mode: 'localstorage', samples: _samples.length,
        units: _samples.length ? 'tertunda' : 0,
        migrated: migrasi, pruned: 0,
        reason: 'idb-gagal: ' + ((e && e.message) || 'tidak diketahui')
      };
    });
  }

  /**
   * compactLegacyKey() -> Promise<{removed, reason}>
   * Padamkan `sos.fleet.v1` SETELAH migrasi terverifikasi. Dipisah dari
   * `hydrate()` dengan sengaja: penghapusan hanya boleh terjadi ketika
   * jumlah sampel di IndexedDB benar-benar >= jumlah sampel lama.
   */
  function compactLegacyKey() {
    var st = storage();
    var legacy = readLegacy();
    if (!st || !legacy || !legacy.full || !legacy.samples.length) {
      return Promise.resolve({ removed: false, reason: 'tidak-ada-data-lama' });
    }
    if (!idbReady()) return Promise.resolve({ removed: false, reason: 'idb-tidak-tersedia' });
    return DB().count().then(function (n) {
      if (n < legacy.samples.length) {
        return { removed: false, reason: 'jumlah-idb-' + n + '-kurang-dari-lama-' + legacy.samples.length };
      }
      try { st.removeItem(STORAGE_KEY); } catch (e) {
        return { removed: false, reason: 'gagal-hapus: ' + e.message };
      }
      return { removed: true, reason: 'terverifikasi ' + n + ' sampel' };
    });
  }

  function isHydrated() { return _hydrated; }
  function mode() { return _mode; }

  /**
   * _setMode(m) — HANYA untuk uji. Menetapkan sumber yang dipakai `_persist()`
   * tanpa menunggu `hydrate()`. Nilai tak dikenal DITOLAK.
   */
  function _setMode(m) {
    if (m !== 'idb' && m !== 'localstorage') {
      throw new Error('mode tidak dikenal: ' + m);
    }
    _mode = (m === 'idb' && !idbReady()) ? 'localstorage' : m;
    _hydrated = true;
    return _mode;
  }

  /* -----------------------------------------------------------------------
   * Query helpers
   * --------------------------------------------------------------------- */
  function getUnit(assetId, component) {
    if (!_analysis) return null;
    var key = assetId + '||' + component;
    return _analysis.units[key] || null;
  }

  /**
   * [CLC] Seluruh sampel (mentah, TANPA filter) untuk satu unit — termasuk yang
   * dipotong, supaya UI dapat menampilkannya "redup" (opt-in §7.4) tanpa
   * mengubah hasil analitik. Sampel yang dipotong ditandai `_clcCutDim = true`.
   */
  function getAllSamplesFor(assetId, component) {
    var out = [];
    _samples.forEach(function (s) {
      if (!s) return;
      if (s.asset_id !== assetId || s.component !== component) return;
      var copy = s;   // referensi apa adanya; tandai cut untuk renderer
      if (copy._clc && copy._clc.cut) copy._clcCutDim = true;
      out.push(copy);
    });
    return out;
  }

  function getUnitsForAsset(assetId) {
    if (!_analysis) return [];
    var result = [];
    Object.keys(_analysis.units).forEach(function (key) {
      if (key.startsWith(assetId + '||')) {
        result.push(_analysis.units[key]);
      }
    });
    return result;
  }

  function getAllUnits() {
    if (!_analysis) return [];
    return Object.keys(_analysis.units).map(function (k) { return _analysis.units[k]; });
  }

  function getFleetStats() {
    if (!_analysis) return { totalSamples: 0, uniqueAssets: {}, tiers: [0,0,0,0], models: {}, components: {} };
    return _analysis.stats;
  }

  function _unitCount() {
    if (!_analysis || !_analysis.units) return 0;
    return Object.keys(_analysis.units).length;
  }

  /* -----------------------------------------------------------------------
   * Ranking — daftar unit diurutkan dari paling critical
   * --------------------------------------------------------------------- */
  function getRankedUnits() {
    var all = getAllUnits();
    // Sort by criticality score descending
    all.sort(function (a, b) {
      return (b.criticality.score || 0) - (a.criticality.score || 0);
    });
    return all.map(function (u, i) {
      return {
        rank: i + 1,
        key: u.assetId + '||' + u.component,
        assetId: u.assetId,
        component: u.component,
        model: u.model,
        serial: u.serial,
        jobsite: u.jobsite,
        score: u.criticality.score,
        band: u.criticality.band,
        axis: u.criticality.axis,
        mprs: u.mprs.mprs,
        tier: u.mprs.tier,
        diagnosticCount: u.diagnostics.length,
        topDiagnostic: u.diagnostics.length > 0 ? u.diagnostics[0].title : '',
        sampleCount: u.sampleCount,
        hmUnit: u.hmUnit,
        lastDate: u.lastDate,
      };
    });
  }

  /* -----------------------------------------------------------------------
   * [SETTINGS] Analisa ulang seluruh sampel SOS dengan threshold terkini.
   * Dipakai saat user mengubah threshold SOS di panel Pengaturan.
   * --------------------------------------------------------------------- */
  function reanalyze() {
    if (!global.SOS_ANALYTICS || typeof global.SOS_ANALYTICS.analyzeFleet !== 'function') return 0;
    if (!_samples.length) return 0;
    _analyze();
    // Analitik berasal dari memori. Cermin permanen juga disegarkan supaya
    // tidak ada dua versi kebenaran setelah reload (record memuat sampelnya).
    _persist(_allRecords(), null);
    return _samples.length;
  }

  /** [CLC] Sampel mentah lengkap (termasuk yang terpotong) — untuk UI/laporan. */
  function getAllSamples() { return _samples; }

  /** [CLC] Ringkasan filter umur komponen (atau null bila modul tak ada). */
  function clcReport() {
    var clc = _clc();
    return (clc && typeof clc.reportFor === 'function') ? clc.reportFor() : null;
  }

  /** [CLC] Hitung ulang analitik setelah saklar/threshold CLC berubah. */
  function applyClcChange() {
    /* [STARTUP 2026-10-31] Saat pemuatan cepat belum ada hasil analitik —
     * jangan memaksa `_persist()` seluruh armada (±50 MB) hanya karena
     * status CLC disinkronkan saat init. Tandai "perlu dibangun"; penjadwal
     * di sos-app.js yang menghitungnya, bertahap. */
    if (!_analysisBuilt) { revision++; _invalidateUi(); return false; }
    if (!_samples.length) return false;
    _analyze();
    _persist(_allRecords(), null);
    return true;
  }

  /** Semua sampel sebagai record (untuk analitik ulang). */
  function _allRecords() {
    return _samples.map(function (s, i) { return _record(s, _keyOf(s, i)); });
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_STORE = {
    KEY: STORAGE_KEY,
    addSamples: addSamples,
    getAnalysis: getAnalysis,
    count: count,
    clear: clear,
    restore: restore,
    analyzeInPlace: analyzeInPlace,
    hasData: hasData,
    isAnalysisPending: isAnalysisPending,
    commitAnalysis: commitAnalysis,
    getEffectiveSamples: getEffectiveSamples,
    isAnalyzing: isAnalyzing,
    getUnit: getUnit,
    getAllSamplesFor: getAllSamplesFor,
    getUnitsForAsset: getUnitsForAsset,
    getAllUnits: getAllUnits,
    getFleetStats: getFleetStats,
    getRankedUnits: getRankedUnits,
    getStorageStatus: getStorageStatus,
    getRevision: getRevision,
    getAllSamples: getAllSamples,
    clcReport: clcReport,
    applyClcChange: applyClcChange,
    /* [STARTUP 2026-10-31] Analitik ulang + simpan ulang cermin permanen.
     * Dipakai `vhms-settings.js` saat threshold berubah. (Nama ini sempat
     * HILANG dari ekspor ketika versi pertama fitur startup menimpanya
     * dengan fungsi bernama sama — lihat catatan `analyzeInPlace()`.) */
    reanalyze: reanalyze,
    // [FASE 3] IndexedDB
    hydrate: hydrate,
    flush: flush,
    takeWriteError: takeWriteError,
    compactLegacyKey: compactLegacyKey,
    dropStaleLegacy: dropStaleLegacy,
    settleLegacy: settleLegacy,
    isHydrated: isHydrated,
    mode: mode,
    _setMode: _setMode,
    _internals: { sampleKey: sampleKey, fromRecords: fromRecords }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_STORE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

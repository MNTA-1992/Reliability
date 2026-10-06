/* =========================================================================
 * sos-store.js
 * -------------------------------------------------------------------------
 * In-memory + sessionStorage/localStorage store untuk data SOS.
 * Data CSV tersimpan di session agar bisa di-reload tanpa drag-drop ulang.
 * ========================================================================= */

(function (global) {
  'use strict';

  var STORAGE_KEY = 'sos.fleet.v1';

  var _samples = [];       // all raw samples
  var _analysis = null;    // result of analyzeFleet
  var _sourceFiles = [];   // list of uploaded file names

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

  /** Analisa ulang dengan sampel yang sesuai status CLC. */
  function _analyze() {
    _annotateClc();
    _analysis = global.SOS_ANALYTICS.analyzeFleet(_effectiveSamples());
    return _analysis;
  }

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
    var d = s.sampled_date || s.lab_date || s._date;
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

  /**
   * Tambah sampel dengan DEDUP "data BARU menang" (menggantikan lama).
   *  - Kunci `lab_no` sama -> sampel baru MENGGANTIKAN yang lama (posisi tetap).
   *  - Tanpa lab_no -> pakai kunci komposit (asset|component|tanggal|HM).
   * @returns {number} jumlah sampel BARU yang ditambahkan (bukan penggantian)
   */
  function addSamples(newSamples, fileName) {
    if (!newSamples || !newSamples.length) return 0;

    // Peta kunci -> indeks di _samples (untuk penggantian "baru menang").
    var keyIndex = {};
    _samples.forEach(function (s, i) {
      var k = sampleKey(s);
      if (k && keyIndex[k] === undefined) keyIndex[k] = i;
    });

    var added = 0, replaced = 0;
    newSamples.forEach(function (s) {
      var k = sampleKey(s);
      if (k && keyIndex[k] !== undefined) {
        // Data BARU menang: ganti sampel lama di posisi yang sama (agar urutan stabil).
        _samples[keyIndex[k]] = s;
        replaced++;
      } else {
        if (k) keyIndex[k] = _samples.length;
        _samples.push(s);
        added++;
      }
    });

    if (fileName && _sourceFiles.indexOf(fileName) === -1) {
      _sourceFiles.push(fileName);
    }

    // Re-analyze (CLC: anotasi dulu, lalu analitik memakai sampel yang lolos)
    _analyze();

    // Persist to sessionStorage
    _persist();

    // Kembalikan objek statistik (kompatibel: angka tetap dibaca sebagai `added`).
    return { added: added, replaced: replaced, total: _samples.length };
  }

  function getAnalysis() { return _analysis; }
  function count() { return _samples.length; }

  function clear() {
    _samples = [];
    _analysis = null;
    _sourceFiles = [];
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  /* -----------------------------------------------------------------------
   * Persistence — sessionStorage (hilang saat tab ditutup)
   * Hanya simpan data inti, bukan objek Date
   * --------------------------------------------------------------------- */
  function _persist() {
    try {
      var data = {
        samples: _samples.map(function (s) {
          var copy = {};
          for (var k in s) {
            if (k === '_date') {
              copy[k] = s[k] ? s[k].toISOString() : null;
            } else {
              copy[k] = s[k];
            }
          }
          return copy;
        }),
        files: _sourceFiles,
        ts: Date.now()
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // sessionStorage full or unavailable — silently ignore
    }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data.samples || !data.samples.length) return false;

      _samples = data.samples.map(function (s) {
        if (s._date) s._date = new Date(s._date);
        if (s.sampled_date) s.sampled_date = new Date(s.sampled_date);
        if (s.lab_date) s.lab_date = new Date(s.lab_date);
        if (s.distribution_date) s.distribution_date = new Date(s.distribution_date);
        return s;
      });
      _sourceFiles = data.files || [];
      _analysis = _analyze();
      return true;
    } catch (e) {
      return false;
    }
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
    _persist();
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
    if (!_samples.length) return false;
    _analyze();
    _persist();
    return true;
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_STORE = {
    addSamples: addSamples,
    getAnalysis: getAnalysis,
    count: count,
    clear: clear,
    restore: restore,
    reanalyze: reanalyze,
    getUnit: getUnit,
    getAllSamplesFor: getAllSamplesFor,
    getUnitsForAsset: getUnitsForAsset,
    getAllUnits: getAllUnits,
    getFleetStats: getFleetStats,
    getRankedUnits: getRankedUnits,
    getAllSamples: getAllSamples,
    clcReport: clcReport,
    applyClcChange: applyClcChange,
    _internals: { sampleKey: sampleKey }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_STORE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

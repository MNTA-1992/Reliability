/* =========================================================================
 * vhms-validate.js
 * -------------------------------------------------------------------------
 * Validasi & pembersihan data hasil parsing VHMS SEBELUM dianalisis.
 *
 * Tujuan:
 *   - Membuang record dengan SMR tidak wajar (null / <= 0 / negatif).
 *   - Mendeteksi & membuang DUPLIKAT SMR dalam satu file (data terbaru menang).
 *   - Melaporkan SN/Model yang kosong.
 *   - Memberi laporan (report) yang bisa ditampilkan ke pengguna, bukan
 *     dibuang diam-diam.
 *
 * Semua fungsi murni (tidak mengubah modul lain). Dipanggil oleh
 * VHMS_ANALYTICS.analyze() atau langsung dari controller.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG || {};

  /* -----------------------------------------------------------------------
   * Konfigurasi ambang validasi (dapat disesuaikan)
   * --------------------------------------------------------------------- */
  var RULES = {
    // SMR harus > 0 dan masuk akal (< ambang jam maksimum alat berat)
    // Catatan: SMR sudah dikonversi ke JAM oleh parser (SMR_SCALE).
    smrMin: 0,
    smrMax: 200000,           // 200.000 jam: nilai wajar maksimum
    // Lompatan SMR antar-record yang dianggap mencurigakan (jam)
    suddenJump: 5000
  };

  /* -----------------------------------------------------------------------
   * Validasi record
   * --------------------------------------------------------------------- */
  /**
   * @param {array} records  record hasil parser (akan disalin & dibersihkan)
   * @param {object} [meta]  metadata unit
   * @returns {object} { records, report, cleaned }
   */
  function validateRecords(records, meta) {
    meta = meta || {};
    var report = {
      total: records ? records.length : 0,
      kept: 0,
      droppedInvalidSmr: 0,
      droppedDuplicate: 0,
      duplicateSmr: [],
      invalidSmrSamples: [],
      suspicious: [],
      warnings: [],
      ok: true
    };

    if (!records || !records.length) {
      report.ok = false;
      report.warnings.push('Tidak ada record untuk divalidasi.');
      return { records: [], report: report, cleaned: false };
    }

    // --- 1) Buang record dengan SMR tidak wajar ---
    var valid = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var s = r.smr;
      if (s === null || s === undefined || isNaN(s)) {
        report.droppedInvalidSmr++;
        if (report.invalidSmrSamples.length < 5) report.invalidSmrSamples.push('(kosong)');
        continue;
      }
      if (s <= RULES.smrMin || s > RULES.smrMax) {
        report.droppedInvalidSmr++;
        if (report.invalidSmrSamples.length < 5) report.invalidSmrSamples.push(s);
        continue;
      }
      valid.push(r);
    }

    // --- 2) Urutkan berdasarkan SMR (naik) ---
    // [PERF] Bangun peta indeks ASLI (identitas objek -> posisi di array
    // `records`) SEBELUM sort. Sebelumnya kode memakai `records.indexOf(r)`
    // di dalam loop dedup (O(n^2) dan ambigu bila ada objek identik).
    var origIndex = new Map();
    records.forEach(function (r, ix) { if (!origIndex.has(r)) origIndex.set(r, ix); });
    valid.forEach(function (r) { r._origIdx = origIndex.has(r) ? origIndex.get(r) : 999999; });

    valid.sort(function (a, b) { return a.smr - b.smr; });

    // --- 3) Deteksi & buang duplikat SMR (data terbaru menang) ---
    // "Terbaru" = posisi paling akhir pada array ASLI (file terakhir diproses).
    var bySmr = {};
    for (var k = 0; k < valid.length; k++) {
      var key = String(valid[k].smr);
      if (!bySmr[key]) bySmr[key] = valid[k];
      else {
        // yang "orig" lebih besar = lebih akhir di file = lebih baru -> menang
        if (valid[k]._origIdx > bySmr[key]._origIdx) bySmr[key] = valid[k];
        report.droppedDuplicate++;
      }
    }
    var dedup = [];
    for (var dk in bySmr) {
      if (Object.prototype.hasOwnProperty.call(bySmr, dk)) {
        var rec = bySmr[dk];
        try { delete rec._origIdx; } catch (e) { rec._origIdx = undefined; }
        dedup.push(rec);
      }
    }
    dedup.sort(function (a, b) { return a.smr - b.smr; });

    // Kumpulkan daftar SMR yang terduplikasi (untuk laporan)
    var seen = {};
    records.forEach(function (r) {
      if (r.smr === null || r.smr === undefined || isNaN(r.smr)) return;
      if (r.smr <= RULES.smrMin) return;
      var kk = String(r.smr);
      seen[kk] = (seen[kk] || 0) + 1;
    });
    Object.keys(seen).forEach(function (kk) {
      if (seen[kk] > 1 && report.duplicateSmr.length < 10) {
        report.duplicateSmr.push(Number(kk));
      }
    });

    // --- 4) Deteksi lompatan SMR mencurigakan ---
    for (var j = 1; j < dedup.length; j++) {
      var gap = dedup[j].smr - dedup[j - 1].smr;
      if (gap > RULES.suddenJump && report.suspicious.length < 5) {
        report.suspicious.push({ from: dedup[j - 1].smr, to: dedup[j].smr, gap: gap });
      }
    }

    // --- 5) Peringatan metadata ---
    if (!meta.serial || !String(meta.serial).trim()) {
      report.warnings.push('Machine Serial No. kosong — unit diidentifikasi dari nama file.');
    }
    if (!meta.model || !String(meta.model).trim()) {
      report.warnings.push('Machine Model kosong.');
    }

    report.kept = dedup.length;
    report.ok = report.droppedInvalidSmr === 0 && report.droppedDuplicate === 0 && report.warnings.length === 0;

    var cleaned = (report.droppedInvalidSmr > 0 || report.droppedDuplicate > 0);
    return { records: dedup, report: report, cleaned: cleaned };
  }

  /** Ringkasan laporan dalam kalimat singkat (untuk toast). */
  function summarizeReport(report) {
    if (!report) return '';
    var parts = [];
    parts.push(report.kept + '/' + report.total + ' record valid');
    if (report.droppedInvalidSmr) parts.push(report.droppedInvalidSmr + ' SMR tidak wajar dibuang');
    if (report.droppedDuplicate) parts.push(report.droppedDuplicate + ' duplikat SMR dibuang');
    if (report.warnings.length) parts.push(report.warnings.length + ' peringatan');
    return parts.join(' · ');
  }

  global.VHMS_VALIDATE = {
    RULES: RULES,
    validateRecords: validateRecords,
    summarizeReport: summarizeReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_VALIDATE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

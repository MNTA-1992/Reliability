/* =========================================================================
 * vhms-fleet-store.js
 * -------------------------------------------------------------------------
 * Lapisan penyimpanan armada (fleet registry).
 *
 * TANGGUNG JAWAB:
 *   - Menyimpan banyak unit hasil VHMS_ANALYTICS.analyze() dalam satu map.
 *   - Memberi ID unik per unit (dari Serial No., fallback nama file).
 *   - Menyediakan AGREGASI RINGAN (fleet summary) tanpa perlu memuat ulang
 *     seluruh record untuk tampilan katalog.
 *   - Menjaga memori: record mentah boleh di-`release` bila sudah tidak
 *     dibuka, sementara ringkasan tetap tersimpan.
 *
 * DIRANCANG UNTUK SKALA 200+ UNIT:
 *   - Ringkasan (summary row) dihitung SEKALI saat unit ditambahkan, lalu
 *     dipakai untuk kartu/tabel katalog. Jadi merender tabel 200 unit
 *     tidak menyentuh 40.000+ record mentah.
 *   - Proses analitik tiap unit dapat dijalankan bertahap (chunked) agar
 *     UI tidak membeku.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;

  /* Penyimpanan internal */
  var units = {};        // id -> unit
  var order = [];        // urutan penambahan id

  /* [PERSISTENSI] Kunci sessionStorage untuk armada VHMS.
   * Data telemetri bertahan saat reload (dalam tab yang sama) agar pengguna
   * tidak perlu meng-upload ulang. Dihapus total lewat tombol "Kosongkan". */
  var STORAGE_KEY = 'vhms.fleet.v1';

  /** Serialisasi ringkas satu unit: cukup untuk re-analyze (records+meta). */
  function serializeUnit(u) {
    var a = u.analysis || {};
    var records = (a.records || []).map(function (r) {
      // Buang objek Date (calendar.date) — biarkan display/epoch tetap ada.
      var copy = {};
      for (var k in r) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        if (k === 'calendar') {
          copy.calendar = r.calendar ? { epoch: r.calendar.epoch, tzOffsetSec: r.calendar.tzOffsetSec, display: r.calendar.display } : null;
        } else {
          copy[k] = r[k];
        }
      }
      return copy;
    });
    return {
      id: u.id,
      sourceFile: a.sourceFile || '',
      mergeCount: u.mergeCount || 1,
      parsed: { records: records, meta: a.meta || {}, columns: a.columns || [] }
    };
  }

  /** Tulis seluruh armada ke sessionStorage (best-effort, abaikan bila penuh). */
  function _persist() {
    try {
      if (!order.length) { sessionStorage.removeItem(STORAGE_KEY); return; }
      var data = { units: order.map(function (id) { return serializeUnit(units[id]); }), ts: Date.now() };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // sessionStorage penuh / tidak tersedia — jangan ganggu alur utama.
      if (global.console && console.warn) console.warn('Gagal menyimpan armada VHMS ke sessionStorage:', e && e.message);
    }
  }

  /**
   * Pulihkan armada dari sessionStorage dengan MENGANALISIS ULANG tiap unit.
   * Dipanggil sekali saat inisialisasi aplikasi.
   * @returns {boolean} true bila ada unit yang berhasil dipulihkan
   */
  function restore() {
    var raw;
    try { raw = sessionStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !data.units || !data.units.length) return false;

    var analytics = global.VHMS_ANALYTICS;
    if (!analytics || typeof analytics.analyze !== 'function') return false;

    units = {}; order = [];
    var restored = 0;
    data.units.forEach(function (su) {
      try {
        var analysis = analytics.analyze(su.parsed);
        analysis.sourceFile = su.sourceFile || '';
        var id = buildUnitId(analysis, su.sourceFile);
        var unit = {
          id: id,
          analysis: analysis,
          summaryRow: buildSummaryRow(id, analysis),
          loadedAt: Date.now(),
          mergeCount: su.mergeCount || 1
        };
        if (!units[id]) order.push(id);
        units[id] = unit;
        restored++;
      } catch (e) {
        if (global.console && console.warn) console.warn('Gagal memulihkan unit VHMS:', e && e.message);
      }
    });
    return restored > 0;
  }

  /* -----------------------------------------------------------------------
   * Identitas unit
   * --------------------------------------------------------------------- */

  /**
   * Bangun ID unit yang stabil & unik dari metadata CSV.
   * Prioritas: Serial No. + Model. Bila kosong, pakai nama file.
   * Bila masih bentrok (unit yang sama di-upload dua kali), tambah suffix.
   */
  function buildUnitId(analysis, sourceName) {
    var m = analysis.meta || {};
    var serial = (m.serial || '').trim();
    var model = (m.model || '').trim();
    var base;

    if (serial) {
      base = (model ? model + '-' : '') + serial;
    } else if (sourceName) {
      base = sourceName.replace(/\.[^.]+$/, '');   // buang ekstensi
    } else {
      base = 'UNIT-' + (order.length + 1);
    }

    // Bersihkan karakter aneh agar aman dipakai sebagai ID
    base = base.replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!base) base = 'UNIT-' + (order.length + 1);

    // Pastikan unik
    var id = base;
    var n = 2;
    while (units[id]) { id = base + '#' + n; n++; }

    return id;
  }

  /* -----------------------------------------------------------------------
   * Ringkasan ringan per unit (dihitung sekali)
   * --------------------------------------------------------------------- */

  /**
   * Susun objek ringkasan yang cukup untuk katalog Home.
   * Menyimpan hanya angka yang dibutuhkan, BUKAN seluruh record.
   */
  function buildSummaryRow(id, analysis) {
    var m = analysis.meta || {};
    var s = analysis.summary || {};
    var h = analysis.health || {};

    function pick(key, field) {
      return (s[key] && s[key][field] !== undefined) ? s[key][field] : null;
    }

    // Hitung jumlah anomali per tingkat
    var nCrit = 0, nWarn = 0;
    (analysis.anomalies || []).forEach(function (a) {
      if (a.status === 'CRITICAL') nCrit++;
      else if (a.status === 'WARNING') nWarn++;
    });

    // Anomali paling berat (untuk highlight di katalog)
    var top = (analysis.anomalies || [])[0] || null;

    // [POIN 6] Flag pilar Engine critical — dipakai untuk mengurutkan katalog
    // agar unit dengan Engine critical berada paling atas.
    var engineCritical = 0, engineWarning = 0;
    (analysis.anomalies || []).forEach(function (a) {
      var pillar = cfg.RANKING_PILLARS ? cfg.RANKING_PILLARS[a.param] : null;
      if (pillar === 'ENGINE') {
        if (a.status === 'CRITICAL') engineCritical++;
        else if (a.status === 'WARNING') engineWarning++;
      }
    });

    // [POIN 6] Skor prioritas katalog.
    // Idealnya = skor criticality window sesungguhnya (VHMS_RANKING), agar
    // urutan katalog konsisten dengan halaman Unit Comparison. Dioptimasi:
    // dihitung SEKALI saat unit ditambahkan. Bila modul ranking belum siap,
    // pakai proxy dari health + engine critical.
    var rankScore = (function () {
      var R = global.VHMS_RANKING;
      if (R && typeof R.scoreUnit === 'function') {
        try {
          var sc = R.scoreUnit(id, analysis);
          if (sc && typeof sc.score === 'number' && !isNaN(sc.score)) return sc.score;
        } catch (e) { /* fallback di bawah */ }
      }
      var h = analysis.health || {};
      var s = (h.critical * 100 + h.warning * 60 + h.normal * 20) / Math.max(1, h.total || 1);
      return Math.round((100 - s) * 10) / 10 + engineCritical * 8;
    })();

    return {
      id: id,
      serial: m.serial || '',
      model: m.model || '',
      // [POIN 1] Keluarga produk (EXCAVATOR/TRUCK/DOZER/UNKNOWN)
      familyId: analysis.familyId || 'UNKNOWN',
      engineModel: m.engineModel || '',
      productGroup: m.productGroup || '',
      sourceFile: analysis.sourceFile || '',
      // [POIN 4] Nomor Lambung hasil lookup Database Unit (SN -> Lambung)
      lambung: (function () {
        var db = global.VHMS_UNITDB;
        return (db && db.getLambung) ? (db.getLambung(m.serial) || null) : null;
      })(),
      recordCount: (analysis.records || []).length,
      smrLast: analysis.smrRange ? analysis.smrRange.last : null,
      smrMin: analysis.smrRange ? analysis.smrRange.min : null,
      smrMax: analysis.smrRange ? analysis.smrRange.max : null,
      lastTimestamp: analysis.lastTimestamp || null,

      healthScore: h.score,
      healthLabel: h.label,
      nNormal: h.normal,
      nWarning: h.warning,
      nCritical: h.critical,

      anomalyCount: (analysis.anomalies || []).length,
      nCritThresholds: nCrit,
      nWarnThresholds: nWarn,
      // [POIN 6] sinyal prioritas katalog
      engineCritical: engineCritical,
      engineWarning: engineWarning,
      rankScore: rankScore,
      topAnomaly: top ? { title: top.title, param: top.param, status: top.status, value: top.value, unit: top.unit } : null,

      // [RUL] Sisa jam operasi terpendek (paling urgent)
      urgentRUL: analysis.urgentRUL || null,

      // KPI kunci untuk kolom ringkas di katalog
      // [REVISI #13] Tambah kolom Oil Press H-Min & Engine Oil Temp Max yang
      // diminta pada Daftar Unit. H-Min diprioritaskan; bila kolomnya tak ada
      // (mis. HD785), jatuh ke oilPressMax (min) sebagai cadangan.
      kpi: {
        blowbyMax: pick('blowbyMax', 'max'),
        hydTempMax: pick('hydTempMax', 'max'),
        coolantMax: pick('coolantTemp', 'max'),
        engOilTempMax: pick('engOilTemp', 'max'),
        oilPressMin: pick('oilPressMax', 'min'),
        oilPressHMin: (function () {
          var h = pick('oilPressHMin', 'min');
          return h !== null ? h : pick('oilPressMax', 'min');
        })(),
        fuelAvg: pick('fuelRate', 'avg'),
        powerAvg: pick('engPowerAve', 'avg')
      }
    };
  }

  /* -----------------------------------------------------------------------
   * Operasi CRUD
   * --------------------------------------------------------------------- */

  /**
   * Tambahkan (atau GABUNGKAN) satu unit dari hasil analyze().
   *
   * [MERGE] Bila Serial No. sudah ada di armada, unit yang baru TIDAK menimpa.
   * Sebaliknya, record-nya DIGABUNG dengan record unit lama berdasarkan SMR:
   *   - SMR sama  -> data terbaru (file terakhir diupload) menang.
   *   - SMR beda  -> record ditambahkan (data lanjutan).
   * Setelah merge, analitik & ringkasan dihitung ulang.
   *
   * @returns {object} { id, merged: boolean, addedRecords: number }
   */
  function add(analysis, sourceName) {
    // Cari unit existing berdasarkan SN + Model (kunci identitas unit).
    var existingId = findUnitIdBySerial(analysis);
    var id, merged = false, addedRecords = 0;

    if (existingId) {
      id = existingId;
      merged = true;
      var oldAnalysis = units[id].analysis;
      var oldRecords = (oldAnalysis && oldAnalysis.records) ? oldAnalysis.records : [];
      var newRecords = analysis.records || [];

      // Gabung record: key = SMR. Yang baru menimpa yang lama pada SMR sama.
      // [FIX 2026-10-01] Record TANPA SMR valid JANGAN dibuang — dedup hanya
      // berlaku untuk SMR valid. Record tanpa SMR dipertahankan (ditambahkan
      // di akhir) agar tidak ada data hilang saat merge/upload masal.
      var bySmr = {};
      var noSmr = [];
      function addRecords(list, isNew) {
        list.forEach(function (r) {
          if (!r) return;
          var hasSmr = (r.smr !== null && r.smr !== undefined && !isNaN(r.smr));
          if (hasSmr) {
            bySmr[String(r.smr)] = r;         // SMR sama -> yang diproses terakhir menang
          } else if (isNew) {
            noSmr.push(r);                     // record baru tanpa SMR -> tetap disimpan
          }
        });
      }
      // Record lama tanpa SMR ikut dipertahankan (bila ada dari sesi sebelumnya).
      oldRecords.forEach(function (r) {
        if (r && (r.smr === null || r.smr === undefined || isNaN(r.smr))) noSmr.push(r);
      });
      addRecords(oldRecords, false);
      var before = Object.keys(bySmr).length;
      addRecords(newRecords, true);
      addedRecords = Object.keys(bySmr).length - before;

      var mergedRecords = Object.keys(bySmr).map(function (k) { return bySmr[k]; });
      // Record tanpa SMR diletakkan di akhir (tidak dapat diurutkan).
      noSmr.forEach(function (r) { mergedRecords.push(r); });
      mergedRecords.sort(function (a, b) {
        var as = (a.smr === null || a.smr === undefined || isNaN(a.smr)) ? null : a.smr;
        var bs = (b.smr === null || b.smr === undefined || isNaN(b.smr)) ? null : b.smr;
        if (as === null && bs === null) return 0;
        if (as === null) return 1;
        if (bs === null) return -1;
        return as - bs;
      });

      // Hitung ulang analitik dari record gabungan.
      var newAnalysis;
      if (global.VHMS_ANALYTICS && global.VHMS_ANALYTICS.analyze) {
        newAnalysis = global.VHMS_ANALYTICS.analyze({
          meta: analysis.meta,
          columns: analysis.columns,
          units: analysis.units,
          records: mergedRecords
        });
        newAnalysis.sourceFile = analysis.sourceFile;
      } else {
        // Fallback: minimal ganti records & range (tanpa analitik ulang)
        newAnalysis = oldAnalysis;
        newAnalysis.records = mergedRecords;
      }

      units[id].analysis = newAnalysis;
      units[id].summaryRow = buildSummaryRow(id, newAnalysis);
      units[id].loadedAt = Date.now();
      units[id].mergeCount = (units[id].mergeCount || 1) + 1;
      // [POIN 4] segarkan nomor lambung untuk unit hasil merge
      var db = global.VHMS_UNITDB;
      if (db && db.getLambung) {
        units[id].summaryRow.lambung = db.getLambung(newAnalysis.meta ? newAnalysis.meta.serial : '') || null;
      }
    } else {
      id = buildUnitId(analysis, sourceName);
      var unit = {
        id: id,
        analysis: analysis,                 // objek lengkap (bisa di-release)
        summaryRow: buildSummaryRow(id, analysis),
        loadedAt: Date.now(),
        mergeCount: 1
      };
      if (!units[id]) order.push(id);
      units[id] = unit;
    }

    _persist();
    return { id: id, merged: merged, addedRecords: addedRecords };
  }

  /**
   * Cari ID unit lama berdasarkan identitas SN + Model.
   * [MERGE] Kunci identitas unit = Serial No. (fallback Model bila SN kosong).
   * @returns {string|null}
   */
  function findUnitIdBySerial(analysis) {
    var m = (analysis && analysis.meta) || {};
    var serial = normalizeSerial(m.serial);
    if (!serial) return null;   // tanpa SN tidak bisa di-merge
    for (var i = 0; i < order.length; i++) {
      var u = units[order[i]];
      if (!u || !u.analysis) continue;
      var um = u.analysis.meta || {};
      if (normalizeSerial(um.serial) === serial) return order[i];
    }
    return null;
  }

  /** Normalisasi serial untuk pencocokan (tahan spasi/tanda, uppercase). */
  function normalizeSerial(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  function get(id) { return units[id] || null; }
  function getAnalysis(id) { return units[id] ? units[id].analysis : null; }
  function count() { return order.length; }
  function ids() { return order.slice(); }

  /**
   * Daftar ringkasan semua unit (array summaryRow) — untuk katalog Home.
   */
  function rows() {
    return order.map(function (id) { return units[id].summaryRow; });
  }

  function clear() {
    units = {};
    order = [];
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /**
   * [POIN 4] Segarkan Nomor Lambung pada semua summaryRow setelah Database
   * Unit diunggah/dihapus. Dipanggil dari controller.
   * @returns {number} jumlah unit yang berhasil dipetakan
   */
  function refreshLambung() {
    var db = global.VHMS_UNITDB;
    var matched = 0;
    order.forEach(function (id) {
      var u = units[id];
      if (!u) return;
      var serial = u.analysis && u.analysis.meta ? u.analysis.meta.serial : '';
      var lb = (db && db.getLambung) ? (db.getLambung(serial) || null) : null;
      u.summaryRow.lambung = lb;
      if (lb) matched++;
    });
    return matched;
  }

  /* -----------------------------------------------------------------------
   * Agregasi armada
   * --------------------------------------------------------------------- */

  /**
   * Statistik agregat seluruh armada untuk header Fleet Overview.
   */
  function fleetStats() {
    var n = order.length;
    var agg = {
      count: n,
      critical: 0,
      warning: 0,
      normal: 0,
      avgHealth: null,
      totalRecords: 0,
      byModel: {},
      byGroup: {},
      worstUnits: []
    };
    if (n === 0) return agg;

    var scoreSum = 0, scoreN = 0;

    order.forEach(function (id) {
      var r = units[id].summaryRow;
      if (r.healthLabel === 'CRITICAL') agg.critical++;
      else if (r.healthLabel === 'WARNING') agg.warning++;
      else agg.normal++;

      if (r.healthScore !== null && r.healthScore !== undefined) {
        scoreSum += r.healthScore; scoreN++;
      }
      agg.totalRecords += r.recordCount || 0;

      var model = r.model || 'Tidak diketahui';
      agg.byModel[model] = (agg.byModel[model] || 0) + 1;
      var group = r.productGroup || 'Tidak diketahui';
      agg.byGroup[group] = (agg.byGroup[group] || 0) + 1;
    });

    agg.avgHealth = scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : null;

    // Unit dengan skor kesehatan terendah (perhatian utama)
    agg.worstUnits = rows()
      .filter(function (r) { return r.healthScore !== null && r.healthScore !== undefined; })
      .sort(function (a, b) { return a.healthScore - b.healthScore; })
      .slice(0, 5);

    return agg;
  }

  /* -----------------------------------------------------------------------
   * [SETTINGS] Analisa ulang SELURUH unit dengan threshold terkini.
   * Dipakai saat user mengubah threshold di panel Pengaturan (thresholdSet
   * di-snapshot per unit oleh analyze(), jadi harus di-render ulang).
   * --------------------------------------------------------------------- */
  function reanalyzeAll() {
    var analytics = global.VHMS_ANALYTICS;
    if (!analytics || typeof analytics.analyze !== 'function') return 0;
    var n = 0;
    order.forEach(function (id) {
      var u = units[id];
      if (!u || !u.analysis) return;
      // [FIX] Rekonstruksi objek `parsed` dari analisis tersimpan. Sebelumnya
      // fungsi ini bergantung pada `u.parsed` yang TIDAK PERNAH di-set oleh
      // add()/restore(), sehingga reanalyze (setelah user mengubah threshold
      // di Pengaturan) tidak pernah berjalan. analysis selalu menyimpan
      // meta/columns/records, jadi cukup dari situ.
      var records = u.analysis.records;
      if (!records || !records.length) return;   // record sudah dilepas -> lewati
      try {
        var analysis = analytics.analyze({
          meta: u.analysis.meta || {},
          columns: u.analysis.columns || [],
          units: u.analysis.units || [],
          records: records
        });
        analysis.sourceFile = u.analysis.sourceFile || '';
        u.analysis = analysis;
        u.summaryRow = buildSummaryRow(id, analysis);
        n++;
      } catch (e) {
        if (global.console && console.warn) console.warn('Gagal menganalisa ulang unit VHMS:', e && e.message);
      }
    });
    if (n) _persist();
    return n;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_FLEET = {
    add: add,
    get: get,
    getAnalysis: getAnalysis,
    count: count,
    ids: ids,
    rows: rows,
    clear: clear,
    refreshLambung: refreshLambung,
    fleetStats: fleetStats,
    buildUnitId: buildUnitId,
    restore: restore,
    persist: _persist,
    reanalyzeAll: reanalyzeAll
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_FLEET;
  }
})(typeof window !== 'undefined' ? window : globalThis);

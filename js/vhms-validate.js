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
    //
    // [B-5 2026-10-15] Kunci dedup = SMR + JENIS BERKAS SUMBER (`_src`).
    // Perbaikan yang SAMA dengan `vhms-fleet-store.js` (merge) — dulu hanya
    // diterapkan di sana, sedangkan validator ini tetap memakai SMR saja.
    // Akibatnya record Chassis Trend ('86') yang kebetulan ber-SMR sama
    // dengan record Trend Analysis ('40') saling MENIMPA, lalu parameter
    // transmisi HD785 (tmFillLow/High, tmFill1..4, tmFillR) HILANG SENYAP
    // dari jendela formula — kolom pilar Transmission tampil "—" padahal
    // datanya ada di berkas. Dedup tetap bekerja di dalam satu jenis berkas
    // (unggah ulang berkas yang sama -> yang baru menang).
    var bySmr = {};
    for (var k = 0; k < valid.length; k++) {
      var key = String(valid[k].smr) + '|' +
        (valid[k]._src === undefined || valid[k]._src === null ? '' : valid[k]._src);
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

    // Kumpulkan daftar SMR yang terduplikasi (untuk laporan).
    // [B-5 2026-10-15] Kunci SAMA dengan dedup di atas (SMR + `_src`), agar
    // laporan tidak mengklaim "duplikat" untuk SMR yang hanya kebetulan sama
    // antar JENIS berkas berbeda — itu bukan duplikat, melainkan dua ukuran
    // berbeda pada jam operasi yang sama.
    var seen = {};
    records.forEach(function (r) {
      if (r.smr === null || r.smr === undefined || isNaN(r.smr)) return;
      if (r.smr <= RULES.smrMin) return;
      var kk = String(r.smr) + '|' + (r._src === undefined || r._src === null ? '' : r._src);
      seen[kk] = (seen[kk] || 0) + 1;
    });
    Object.keys(seen).forEach(function (kk) {
      if (seen[kk] > 1 && report.duplicateSmr.length < 10) {
        report.duplicateSmr.push(Number(kk.split('|')[0]));
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

    // [T6 2026-10-09] Gerbang kewarasan duty termal (HD785). Temuan TIDAK
    // membuang record — hanya DILAPORKAN. Karena itu `report.ok` di atas
    // TIDAK terpengaruh.
    //
    // ⚠ [KOREKSI TEKS 2026-10-16] Pesan peringatan gerbang ini DULU berbunyi
    //   "nilai TIDAK dipakai menilai duty". Itu TIDAK BENAR: tidak ada kode
    //   yang mengecualikannya dari formula. Upaya menegakkannya (menandai
    //   `_masked`) TERBUKTI SALAH ARAH — gerbang memakai ambang 5 % dari
    //   interval, sehingga duty 25 % yang justru CRITICAL SAH (uji
    //   "B14-regresi") ikut tertandai dan deteksi EGT HD785 mati lagi.
    //   Teks pesan kini diperbaiki agar jujur: ini PERINGATAN BACA, bukan
    //   pengecualian. Lihat `checkThermalSanity()` untuk batasan ambangnya.
    var thermal = checkThermalSanity(dedup);
    if (thermal.findings.length) {
      report.thermalSuspectCount = thermal.report.thermalSuspectCount;
      report.thermalSuspectKeys = thermal.report.thermalSuspectKeys;
      thermal.report.warnings.forEach(function (w) { report.warnings.push(w); });
    }

    var cleaned = (report.droppedInvalidSmr > 0 || report.droppedDuplicate > 0);
    return { records: dedup, report: report, cleaned: cleaned };
  }

  /* -----------------------------------------------------------------------
   * [T2 2026-10-08] GERBANG KUALITAS DATA — parameter dari sensor rusak.
   * ---------------------------------------------------------------------
   * Sensor yang gagal (terbukti dari `fault0.CSV`) membuat parameter yang
   * bergantung padanya TIDAK LAYAK diskor. Fungsi di bawah menandai record
   * yang terpengaruh, TANPA menghapus nilainya (aturan dua sumber data,
   * README §6.3: nilai tetap TAMPIL, tetapi DIKELUARKAN dari FORMULA).
   *
   * @param {array}  records      record hasil parse trend (dapat kosong)
   * @param {array}  faultEvents  event dari VHMS_FAULT_PARSER.parseFault()
   * @param {object} [opts]
   *   - map      : peta SMR<->epoch (dari VHMS_CROSS.buildSmrEpochMap).
   *                Bila tidak ada -> mask berlaku UNIT-WIDE (konservatif).
   *   - rules    : override ambang (default cfg.FAULT_MASK_RULES)
   * @returns {{records: array, mask: object, report: object}}
   * --------------------------------------------------------------------- */
  function applyFaultMask(records, faultEvents, opts) {
    opts = opts || {};
    records = records || [];
    faultEvents = faultEvents || [];

    var map = opts.map || null;
    var rules = opts.rules || cfg.FAULT_MASK_RULES || {};
    var minCount = (rules.minCount !== undefined) ? rules.minCount : 10;
    var minDurationSec = (rules.minDurationSec !== undefined) ? rules.minDurationSec : 3600;
    // [KOREKSI 2026-10-12] Ambang KHUSUS untuk event yang MASIH AKTIF
    // (To Time kosong). Event aktif tetap lebih sensitif, tetapi tidak lagi
    // "nol syarat" — lihat penjelasan di vhms-config.js FAULT_MASK_RULES.
    var activeAlwaysMasks = (rules.activeAlwaysMasks === true);
    var activeMinCount = (rules.activeMinCount !== undefined) ? rules.activeMinCount : 2;
    var activeMinDurationSec = (rules.activeMinDurationSec !== undefined) ? rules.activeMinDurationSec : 300;

    var MAP = cfg.FAULT_SENSOR_MAP || {};
    var ALL = cfg.ALL_PARAMS_SENTINEL || '*';

    var report = {
      hasFault: !!faultEvents.length,
      maskScope: map ? 'window' : 'unit',
      maskedParams: [],
      maskedCodes: [],
      warnings: [],
      // ringkasan gerbang untuk summarizeReport()
      maskCount: 0
    };
    var mask = {};

    // 0) Bersihkan penanda `_masked` dari pemanggilan sebelumnya agar fungsi
    //    ini IDEMPOTEN dan TIDAK merusak data saat tidak ada fault. Ini juga
    //    menegakkan prinsip #3 (unit tanpa fault = perilaku persis seperti
    //    sebelumnya) walaupun array `records` yang sama dipakai ulang.
    for (var z = 0; z < records.length; z++) {
      if (records[z] && records[z]._masked) {
        try { delete records[z]._masked; } catch (e) { records[z]._masked = undefined; }
      }
    }

    if (!faultEvents.length) {
      return { records: records, mask: mask, report: report };
    }
    if (!map) {
      // Tanpa peta SMR<->epoch, kita tidak bisa membatasi mask ke window
      // fault. Pilih KONSERVATIF: mask berlaku untuk seluruh unit, dan
      // WAJIB dilaporkan (tidak ada penonaktifan diam-diam — prinsip #4).
      report.warnings.push(
        'Pemetaan SMR<->waktu fault tidak tersedia — parameter ter-mask ' +
        'diberlakukan untuk SELURUH unit (' + faultEvents.length + ' event).');
    }

    // 1) Agregasi event per KODE (hitung total count & durasi bila perlu).
    var byCode = {};
    faultEvents.forEach(function (ev) {
      if (!ev || !ev.code) return;
      var s = byCode[ev.code];
      if (!s) {
        s = byCode[ev.code] = {
          code: ev.code, msg: ev.msg || '', count: 0, durationSec: 0,
          active: false, n: 0, windows: []
        };
      }
      s.count += (ev.count || 0);
      if (ev.durationSec !== null && ev.durationSec !== undefined) s.durationSec += ev.durationSec;
      if (ev.active) s.active = true;
      s.n++;
      if (ev.fromEpoch !== null && ev.fromEpoch !== undefined) {
        s.windows.push({ from: ev.fromEpoch, to: (ev.toEpoch !== null && ev.toEpoch !== undefined) ? ev.toEpoch : Infinity });
      }
    });

    // 2) Tentukan kode mana yang MELEWATI ambang.
    var significant = [];
    Object.keys(byCode).forEach(function (code) {
      var def = MAP[code];
      if (!def) return;   // kode tak dikenal -> tidak mem-mask apa pun (R2)
      var s = byCode[code];
      // [KOREKSI 2026-10-12] Event AKTIF tidak lagi otomatis mem-mask.
      // Sensitivitasnya dinaikkan (ambang lebih rendah), tetapi tetap wajib
      // melewati minimal 1 ambang agar "kedipan" count 1 / durasi ~0 tidak
      // menandai kolom selamanya.
      var activeQualifies = s.active &&
        (activeAlwaysMasks || s.count >= activeMinCount || s.durationSec >= activeMinDurationSec);
      var ok = activeQualifies ||
               (s.count >= minCount) ||
               (s.durationSec >= minDurationSec);
      if (ok) significant.push({ def: def, s: s });
    });

    if (!significant.length) {
      return { records: records, mask: mask, report: report };
    }

    // 3) Susun peta parameter -> info fault terburuk (Count tertinggi).
    //    CATATAN PENTING: mask whole-unit ('*') TIDAK BOLEH menimpa alasan
    //    spesifik sebuah sensor. Sensor yang rusak adalah temuan yang jauh
    //    lebih akurat ("Exhaust temp. sensor R failure") daripada "ada
    //    masalah komunikasi". Karena itu prioritas: mask KHUSUS selalu
    //    menang atas mask whole-unit, berapa pun Count-nya.
    var paramFault = {};
    var paramWhole = {};
    function assign(key, def, s, whole) {
      var cur = paramFault[key];
      if (whole && cur) return;                       // jangan timpa alasan spesifik
      if (!cur || (!paramWhole[key] && s.count > cur.count) ||
          (paramWhole[key] && !whole)) {
        paramFault[key] = {
          code: s.code, msg: s.msg, count: s.count, durationSec: s.durationSec,
          active: s.active, occurrences: s.n, windows: s.windows
        };
        paramWhole[key] = whole;
      }
    }
    significant.forEach(function (item) {
      var params = item.def.params || [];
      var wholeUnit = params.indexOf(ALL) >= 0;
      if (wholeUnit) {
        // Seluruh parameter: tandai '*' DAN setiap key nyata di cfg.PARAMS
        // agar konsumen yang mengiterasi PARAMS dapat memeriksanya.
        paramWhole[ALL] = true;
        paramFault[ALL] = {
          code: item.s.code, msg: item.s.msg, count: item.s.count,
          durationSec: item.s.durationSec, active: item.s.active,
          occurrences: item.s.n, windows: item.s.windows
        };
        Object.keys(cfg.PARAMS || {}).forEach(function (k) {
          if (k === 'smr' || k === 'calendar') return;
          assign(k, item.def, item.s, true);
        });
      } else {
        params.forEach(function (p) { assign(p, item.def, item.s, false); });
      }
    });

    // 4) Bentuk objek `mask` untuk pelaporan.
    Object.keys(paramFault).forEach(function (key) {
      if (key === ALL) return;
      var f = paramFault[key];
      mask[key] = {
        reason: f.msg || f.code,
        code: f.code,
        msg: f.msg,
        count: f.count,
        durationSec: f.durationSec,
        active: f.active
      };
    });
    var wholeUnitMasked = !!paramFault[ALL];

    // 5) Tandai record (`_masked`) HANYA pada jendela fault, bila peta
    //    SMR<->epoch tersedia. Nilai TIDAK dihapus.
    var windowedKeys = null;
    if (map && typeof map.toSmr === 'function') {
      windowedKeys = {};
      significant.forEach(function (item) {
        var params = item.def.params || [];
        var wholeUnit = params.indexOf(ALL) >= 0;
        var keys = wholeUnit ? Object.keys(cfg.PARAMS || {}) : params;
        keys.forEach(function (k) {
          if (k === 'smr' || k === 'calendar') return;
          if (!windowedKeys[k]) windowedKeys[k] = [];
          item.s.windows.forEach(function (w) {
            windowedKeys[k].push({ from: w.from, to: w.to, meta: item.s });
          });
        });
      });

      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        if (!rec || rec.smr === null || rec.smr === undefined || isNaN(rec.smr)) continue;
        var ep = (typeof map.toEpoch === 'function') ? map.toEpoch(rec.smr) : null;
        if (ep === null || ep === undefined) continue;
        for (var wk in windowedKeys) {
          if (!Object.prototype.hasOwnProperty.call(windowedKeys, wk)) continue;
          var wins = windowedKeys[wk];
          for (var w = 0; w < wins.length; w++) {
            if (ep >= wins[w].from && ep <= wins[w].to) {
              if (!rec._masked) rec._masked = {};
              rec._masked[wk] = true;
              break;
            }
          }
        }
      }
    } else {
      // Tanpa peta: tandai SEMUA record (mask unit-wide).
      for (var q = 0; q < records.length; q++) {
        var rq = records[q];
        if (!rq) continue;
        if (!rq._masked) rq._masked = {};
        Object.keys(mask).forEach(function (k) { rq._masked[k] = true; });
      }
    }

    // 6) Laporan dalam bahasa Indonesia (dibaca pengguna).
    var codeSet = {};
    Object.keys(mask).forEach(function (k) { codeSet[mask[k].code] = true; });
    report.maskedParams = Object.keys(mask);
    report.maskedCodes = Object.keys(codeSet);
    report.maskCount = report.maskedParams.length;
    report.wholeUnitMasked = wholeUnitMasked;

    // Laporan: SATU kalimat per KODE fault (bukan per parameter) agar
    // laporan tetap terbaca saat seluruh unit ter-mask (52 parameter).
    var perCode = {};
    Object.keys(mask).forEach(function (k) {
      var f = mask[k];
      var entry = perCode[f.code];
      if (!entry) {
        entry = perCode[f.code] = { code: f.code, msg: f.msg, count: f.count, durationSec: f.durationSec, active: f.active, params: [] };
      }
      entry.params.push(k);
    });
    Object.keys(perCode).forEach(function (code) {
      var f = perCode[code];
      var nama = f.params.length > 6
        ? (f.params.slice(0, 6).join(', ') + ' … (+' + (f.params.length - 6) + ' param)')
        : f.params.join(', ');
      var kalimat = nama + ' dikecualikan dari skor — ' + f.code + ' (' + f.msg + ')';
      if (f.active) {
        kalimat += ' masih aktif, ' + f.count + ' kejadian';
      } else {
        var jam = Math.round((f.durationSec || 0) / 360) / 10;
        kalimat += ' terdeteksi ' + f.count + ' kejadian selama ' + jam + ' jam';
      }
      report.warnings.push(kalimat);
    });
    if (wholeUnitMasked) {
      report.warnings.push(
        'SELURUH parameter ditandai tidak layak (kegagalan sistem VHMS/komunikasi) ' +
        '— unit harus ditandai "DATA TIDAK LAYAK", bukan diberi skor 0.');
      report.wholeUnitMasked = true;
    } else if (!map) {
      report.warnings.push('Cakupan mask: SELURUH UNIT (maskScope: unit).');
    }

    // 7) Record bersih: pastikan field `_masked` yang kosong tidak tertinggal.
    records.forEach(function (rec) {
      if (rec && rec._masked && !Object.keys(rec._masked).length) delete rec._masked;
    });

    return { records: records, mask: mask, report: report };
  }

  /** Ringkasan laporan dalam kalimat singkat (untuk toast). */
  function summarizeReport(report) {
    if (!report) return '';
    var parts = [];
    parts.push(report.kept + '/' + report.total + ' record valid');
    if (report.droppedInvalidSmr) parts.push(report.droppedInvalidSmr + ' SMR tidak wajar dibuang');
    if (report.droppedDuplicate) parts.push(report.droppedDuplicate + ' duplikat SMR dibuang');
    // [T2.4] Hitung parameter yang di-mask sebagai bagian ringkasan.
    if (report.maskCount) parts.push(report.maskCount + ' parameter di-mask');
    // [T6 2026-10-09] Gerbang kewarasan duty termal.
    if (report.thermalSuspectCount) parts.push(report.thermalSuspectCount + ' nilai duty termal tidak wajar');
    if (report.warnings && report.warnings.length) parts.push(report.warnings.length + ' peringatan');
    return parts.join(' · ');
  }

  /* -----------------------------------------------------------------------
   * [T6 2026-10-09] GERBANG KEWARASAN DUTY TERMAL (HD785 — chas_trend0.CSV)
   * ---------------------------------------------------------------------
   * Kolom durasi (`fRtdOver*`, `rRtdOver*`, `lf/lr/rf/rrExhOver*`) menyatakan
   * DETIK sebuah suhu berada di atas ambang SELAMA SATU INTERVAL snapshot.
   * Nilai yang MELEBIHI durasi interval itu sendiri adalah mustahil.
   *
   * KASUS NYATA (SN 31991): `RR Exh.Temp 800-` bernilai 590.649 detik pada
   * interval ±2.004 jam (= 7.214.400 s) — hanya 8 % dari interval, sehingga
   * ambang konservatif 5 % (bukan 100 %) sengaja dipakai agar lonjakan ini
   * tetap tertangkap. Nilai sehat di kolom lain hanya 0-3.300 detik.
   *
   * Gerbang ini adalah JARING PENGAMAN KEDUA, independen dari FAULT_SENSOR_MAP:
   * ia tetap bekerja walau peta sensor belum/tidak memuat kode terkait.
   * [R2-HD 2026-10-09] Kode huruf kecil `dGT5KB`/`dGT6KB` KINI terdaftar &
   * mem-mask grup LR/RR secara benar; gerbang ini menjadi lapisan kedua.
   *
   * @param {array}  records  record trend (terurut SMR naik)
   * @param {object} [opts]
   *   - ratio : override ambang (default VHMS_CLUTCH.THERMAL_SANITY_RATIO=0.05)
   *   - keys  : override daftar kolom
   * @returns {{findings: array, suspectKeys: object, report: object}}
   * --------------------------------------------------------------------- */
  function checkThermalSanity(records, opts) {
    opts = opts || {};
    var report = {
      thermalSuspectCount: 0,
      thermalSuspectKeys: [],
      warnings: []
    };

    var records2 = records || [];
    if (!records2.length) return { findings: [], suspectKeys: {}, report: report };

    var clutch = global.VHMS_CLUTCH;
    var ratio = (opts.ratio !== undefined) ? opts.ratio
              : (clutch && clutch.THERMAL_SANITY_RATIO !== undefined)
              ? clutch.THERMAL_SANITY_RATIO : 0.05;

    var keys = opts.keys || null;
    if (!keys) {
      keys = Object.keys(cfg.PARAMS || {}).filter(function (k) {
        return cfg.PARAMS[k] && cfg.PARAMS[k].delta === true;
      });
    }
    if (!keys.length) return { findings: [], suspectKeys: {}, report: report };

    var findings = [];
    var suspectKeys = {};
    for (var i = 1; i < records2.length; i++) {
      var prev = records2[i - 1], cur = records2[i];
      if (!prev || !cur) continue;
      if (prev.smr === null || prev.smr === undefined || isNaN(prev.smr)) continue;
      if (cur.smr === null || cur.smr === undefined || isNaN(cur.smr)) continue;
      var dSmr = cur.smr - prev.smr;
      if (!(dSmr > 0)) continue;
      var intervalSec = dSmr * 3600;
      var limit = intervalSec * ratio;

      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var v = cur[key];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (v > limit) {
          suspectKeys[key] = true;
          findings.push({
            key: key, smr: cur.smr, prevSmr: prev.smr,
            deltaSec: v, intervalHours: dSmr, limitSec: limit,
            fractionOfInterval: v / intervalSec
          });
        }
      }
    }

    report.thermalSuspectCount = findings.length;
    report.thermalSuspectKeys = Object.keys(suspectKeys);
    if (findings.length) {
      // Ringkas maksimum dua temuan agar laporan tidak banjir.
      var show = findings.slice(0, 2);
      show.forEach(function (f) {
        var jam = Math.round(f.intervalHours * 10) / 10;
        var persen = Math.round(f.fractionOfInterval * 1000) / 10;
        // [KOREKSI TEKS 2026-10-16] Kalimat lama berbunyi "nilai TIDAK dipakai
        // menilai duty" — janji yang TIDAK pernah ditegakkan kode mana pun.
        // Teks kini menyatakan apa yang benar-benar terjadi: nilai TETAP
        // dipakai, operator yang harus memeriksanya.
        report.warnings.push(
          f.key + ' = ' + Math.round(f.deltaSec) + ' detik melampaui kewajaran ' +
          'untuk interval ' + jam + ' jam (' + persen + '% dari interval) — ' +
          'PERIKSA sensor/rangkaian sebelum menyimpulkan; nilai ini tetap ' +
          'ikut dinilai, jadi skor duty dapat terlalu tinggi.');
      });
      if (findings.length > 2) {
        report.warnings.push('… dan ' + (findings.length - 2) + ' nilai duty termal lain yang tidak wajar.');
      }
    }

    return { findings: findings, suspectKeys: suspectKeys, report: report };
  }

  global.VHMS_VALIDATE = {
    RULES: RULES,
    validateRecords: validateRecords,
    applyFaultMask: applyFaultMask,
    checkThermalSanity: checkThermalSanity,
    summarizeReport: summarizeReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_VALIDATE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * vhms-analytics.js
 * -------------------------------------------------------------------------
 * Lapisan analitik: mengubah record CSV mentah menjadi:
 *   - ringkasan (summary) per parameter: min / max / avg / last
 *   - status per record (NORMAL / WARNING / CRITICAL)
 *   - nilai KPI untuk kartu kompartemen
 *   - daftar anomali + rekomendasi tindakan
 *   - data siap-plot untuk Chart.js
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;

  /* -----------------------------------------------------------------------
   * Statistik dasar
   * --------------------------------------------------------------------- */
  function stats(values) {
    var v = values.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (v.length === 0) return { min: null, max: null, avg: null, last: null, first: null, count: 0 };
    var sum = 0;
    for (var i = 0; i < v.length; i++) sum += v[i];
    return {
      min: Math.min.apply(null, v),
      max: Math.max.apply(null, v),
      avg: sum / v.length,
      first: v[0],
      last: v[v.length - 1],
      count: v.length
    };
  }

  /** Least-squares slope dari (x=smr, y=nilai). */
  function slope(records, paramKey) {
    var xs = [], ys = [];
    for (var i = 0; i < records.length; i++) {
      var x = records[i].smr, y = records[i][paramKey];
      if (x === null || y === null) continue;
      xs.push(x); ys.push(y);
    }
    if (xs.length < 3) return null;
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  /* -----------------------------------------------------------------------
   * Evaluasi status terhadap threshold
   * ---------------------------------------------------------------------
   * thresholds opsional — bila tidak diberikan, pakai cfg.THRESHOLDS.
   * Hal ini memungkinkan threshold berbeda per KELUARGA PRODUK (POIN 1).
   */
  function evaluateParam(key, value, thresholds) {
    var th = (thresholds || cfg.THRESHOLDS)[key];
    if (!th || value === null || value === undefined) return null;
    if (th.mode === 'low') {
      if (value <= th.crit) return 'CRITICAL';
      if (value <= th.warn) return 'WARNING';
    } else {
      if (value >= th.crit) return 'CRITICAL';
      if (value >= th.warn) return 'WARNING';
    }
    return 'NORMAL';
  }

  var STATUS_RANK = { 'NORMAL': 0, 'WARNING': 1, 'CRITICAL': 2 };

  /** Evaluasi seluruh record, tetapkan status gabungan + detail pelanggaran. */
  function evaluateRecords(records, thresholds) {
    var TH = thresholds || cfg.THRESHOLDS;
    var keys = Object.keys(TH);
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var worst = 'NORMAL';
      var violations = [];
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        // Lewati parameter yang tidak ada di file (kecocokan field)
        if (rec[k] === undefined) continue;
        var st = evaluateParam(k, rec[k], TH);
        if (st && st !== 'NORMAL') {
          violations.push({ param: k, status: st, value: rec[k], threshold: TH[k] });
          if (STATUS_RANK[st] > STATUS_RANK[worst]) worst = st;
        }
      }
      rec.status = worst;
      rec.violations = violations;
    }
    return records;
  }

  /* -----------------------------------------------------------------------
   * Ringkasan seluruh dataset
   * --------------------------------------------------------------------- */
  function summarize(records) {
    var out = {};
    var P = cfg.PARAMS;
    for (var key in P) {
      if (!Object.prototype.hasOwnProperty.call(P, key)) continue;
      if (key === 'smr' || key === 'calendar') continue;
      var vals = records.map(function (r) { return r[key]; });
      out[key] = stats(vals);
    }
    return out;
  }

  /**
   * Nilai yang ditampilkan pada kartu KPI.
   * Untuk parameter yang dimonitor threshold -> pakai MAX (kondisi terburuk),
   * untuk parameter operasional biasa -> pakai nilai terakhir.
   */
  function kpiValue(paramKey, summary) {
    var s = summary[paramKey];
    if (!s) return null;
    return s.max;   // mayoritas kartu menonjolkan puncak/maksimum
  }

  /* -----------------------------------------------------------------------
   * Deteksi anomali & rekomendasi
   * --------------------------------------------------------------------- */
  var ACTIONS = {
    blowbyMax: {
      title: 'Blowby Pressure Anomaly',
      system: 'Engine',
      risk: 'Tinggi',
      actions: [
        'Lakukan Blowby Test konfirmasi di lapangan.',
        'Inspeksi keausan Piston Ring & Cylinder Liner.',
        'Periksa sampel oli untuk jelaga (soot) / kontaminasi bahan bakar.'
      ]
    },
    hydTempMax: {
      title: 'Hydraulic Oil Thermal Peak',
      system: 'Hydraulic',
      risk: 'Sedang',
      actions: [
        'Bersihkan sirip Hydraulic Oil Cooler.',
        'Periksa kerja Bypass Valve & Thermostat Valve.',
        'Cek level dan kondisi oli hidrolik (viskositas).'
      ]
    },
    coolantTemp: {
      title: 'Coolant Temperature High',
      system: 'Cooling',
      risk: 'Sedang',
      actions: [
        'Periksa level coolant & kebocoran radiator.',
        'Cek putaran fan drive dan kondisi belt.',
        'Uji kerja thermostat.'
      ]
    },
    engOilTemp: {
      title: 'Engine Oil Temperature High',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Periksa kebersihan oil cooler mesin.',
        'Cek level serta kondisi oli mesin.',
        'Verifikasi sensor suhu oli.'
      ]
    },
    ptoTempMax: {
      title: 'PTO Temperature High',
      system: 'Fan Drive & PTO',
      risk: 'Sedang',
      actions: [
        'Periksa sirkulasi pendinginan pada unit PTO.',
        'Cek beban pompa fan berlebih.'
      ]
    },
    oilPressMin: {
      title: 'Engine Oil Pressure Low',
      system: 'Engine',
      risk: 'Tinggi',
      actions: [
        'Periksa level oli mesin segera.',
        'Uji pompa oli & relief valve.',
        'Inspeksi kondisi filter oli (tersumbat/klog).'
      ]
    },
    oilPressMax: {
      title: 'Engine Oil Pressure Low',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Periksa level oli mesin.',
        'Verifikasi sensor/switch tekanan oli.'
      ]
    },
    oilPressHMin: {
      title: 'Engine Oil Pressure (H-Min) Low',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Periksa level oli mesin segera.',
        'Uji pompa oli & relief valve.',
        'Inspeksi kondisi filter oli (tersumbat/klog).'
      ]
    },
    fuelRate: {
      title: 'Fuel Consumption Elevated',
      system: 'Engine',
      risk: 'Rendah',
      actions: [
        'Cek kondisi injektor dan filter bahan bakar.',
        'Evaluasi gaya operasi (operating style) operator.'
      ]
    }
  };

  /**
   * Membangun daftar anomali utama dari summary (per parameter),
   * diurutkan berdasarkan keparahan.
   */
  function buildAnomalies(records, summary, thresholds) {
    var anomalies = [];
    var TH = thresholds || cfg.THRESHOLDS;
    // [REVISI] Hormati fallback: bila param punya `fallbackFor` dan target-nya
    // punya data, param cadangan dilewati (agar tidak dobel anomali).
    var keys;
    if (global.VHMS_RANKING && global.VHMS_RANKING.effectiveThresholdKeys) {
      keys = global.VHMS_RANKING.effectiveThresholdKeys(TH, summary);
    } else {
      keys = Object.keys(TH);
    }

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var th = TH[key];
      var s = summary[key];
      if (!s) continue;

      // Nilai paling ekstrem sesuai arah threshold
      var extreme = (th.mode === 'low') ? s.min : s.max;
      var st = evaluateParam(key, extreme, TH);
      if (!st || st === 'NORMAL') continue;

      // Temukan record yang menyentuh anomali -> ambil timestamp & SMR-nya
      var hitRec = null;
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        var v = rec[key];
        if (v === null) continue;
        if (th.mode === 'low' ? v <= th.warn : v >= th.warn) {
          if (!hitRec) hitRec = rec;
          else {
            // pilih yang paling ekstrem
            var cur = hitRec[key];
            if (th.mode === 'low' ? v < cur : v > cur) hitRec = rec;
          }
        }
      }

      var meta = ACTIONS[key] || { title: th.label, system: 'General', risk: 'Sedang', actions: [] };
      var sl = slope(records, key);

      anomalies.push({
        param: key,
        title: meta.title,
        system: meta.system,
        risk: meta.risk,
        status: st,
        value: extreme,
        warn: th.warn,
        crit: th.crit,
        mode: th.mode,
        unit: cfg.PARAMS[key] ? cfg.PARAMS[key].unit : '',
        label: cfg.PARAMS[key] ? cfg.PARAMS[key].label : key,
        smr: hitRec ? hitRec.smr : null,
        calendar: hitRec ? hitRec.calendar : null,
        slope: sl,
        rul: estimateRUL(records, key, th),
        actions: meta.actions
      });
    }

    anomalies.sort(function (a, b) {
      if (STATUS_RANK[b.status] !== STATUS_RANK[a.status]) return STATUS_RANK[b.status] - STATUS_RANK[a.status];
      return (b.smr || 0) - (a.smr || 0);
    });
    return anomalies;
  }

  /**
   * Indeks kesehatan 0..100 berbasis proporsi record NORMAL
   * dan seberapa parah penyimpangannya.
   */
  function healthIndex(records) {
    if (!records.length) return null;
    var nNormal = 0, nWarn = 0, nCrit = 0;
    for (var i = 0; i < records.length; i++) {
      var s = records[i].status;
      if (s === 'CRITICAL') nCrit++;
      else if (s === 'WARNING') nWarn++;
      else nNormal++;
    }
    var score = (nNormal * 100 + nWarn * 60 + nCrit * 20) / records.length;
    return {
      score: Math.round(score * 10) / 10,
      normal: nNormal,
      warning: nWarn,
      critical: nCrit,
      total: records.length,
      label: score >= 85 ? 'NORMAL' : (score >= 65 ? 'WARNING' : 'CRITICAL')
    };
  }

  /* -----------------------------------------------------------------------
   * Data chart
   * --------------------------------------------------------------------- */
  function buildChartData(parsed, chartDef) {
    var records = parsed.records;
    var labels = records.map(function (r) {
      return r.smr !== null ? r.smr.toLocaleString('id-ID', { maximumFractionDigits: 0 }) : '-';
    });
    // [REVISI] Tanggal (Waktu Rekam) per titik untuk judul tooltip chart.
    var dates = records.map(function (r) {
      return (r.calendar && r.calendar.display) ? r.calendar.display : '';
    });

    var datasets = chartDef.series.map(function (s) {
      var meta = cfg.PARAMS[s.param] || {};
      var data = records.map(function (r) { return r[s.param]; });
      var axis = s.axis === 'right' ? 'y1' : 'y';
      return {
        param: s.param,
        axisId: axis,
        label: (s.label || meta.label || s.param) + (meta.unit ? ' (' + meta.unit + ')' : ''),
        data: data,
        type: s.type || 'line',
        borderColor: s.color,
        backgroundColor: s.type === 'bar' ? s.color : (s.fill ? hexToRgba(s.color, 0.12) : s.color),
        borderWidth: s.width || 2,
        pointRadius: s.type === 'bar' ? 0 : 3,
        pointHoverRadius: 6,
        tension: 0.25,
        fill: !!s.fill,
        spanGaps: true,
        borderDash: s.dashed ? [5, 4] : undefined
      };
    });

    return {
      labels: labels,
      dates: dates,
      datasets: datasets,
      axisTitles: chartDef.axisTitles || {},
      type: chartDef.type || 'line',
      meta: { hasRightAxis: datasets.some(function (d) { return d.axisId === 'y1'; }) }
    };
  }

  function hexToRgba(hex, alpha) {
    if (!hex) return 'rgba(148,163,184,' + alpha + ')';
    if (hex.indexOf('rgba') === 0) return hex;
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* -----------------------------------------------------------------------
   * Analisis penuh
   * --------------------------------------------------------------------- */
  function analyze(parsed) {
    var records = parsed.records;

    // [VALIDASI] Bersihkan record: buang SMR tidak wajar & duplikat SMR.
    var validationReport = null;
    if (global.VHMS_VALIDATE && global.VHMS_VALIDATE.validateRecords) {
      var v = global.VHMS_VALIDATE.validateRecords(records, parsed.meta || {});
      records = v.records;
      validationReport = v.report;
    }

    // [POIN 1] Resolusi profil keluarga produk dari metadata unit.
    var prof = null;
    var thresholds = cfg.THRESHOLDS;
    if (global.VHMS_PROFILES && global.VHMS_PROFILES.profileFor) {
      prof = global.VHMS_PROFILES.profileFor(parsed.meta || {});
      if (prof && prof.profile && prof.profile.thresholds) {
        thresholds = prof.profile.thresholds;
      }
    }

    // [RULE DATA] Evaluasi status per-record untuk SELURUH data (dipakai tabel
    // log telemetri — Rule Tampilan). Status tiap record tak bergantung window.
    evaluateRecords(records, thresholds);

    // [RULE DATA] Window FORMULA: hanya N jam SMR terakhir (dari SMR tertinggi).
    // SEMUA perhitungan (KPI, summary, anomali, health, ranking, matrix) memakai
    // subset ini agar mencerminkan kondisi terkini.
    var win = sliceFormulaWindow(records);
    var winRecords = win.records;

    var summary = summarize(winRecords);
    var anomalies = buildAnomalies(winRecords, summary, thresholds);
    var health = healthIndex(winRecords);

    // [RUL] Estimasi sisa umur operasi per parameter (dari window formula)
    var rul = computeAllRUL(winRecords, thresholds);
    var urgentRUL = mostUrgentRUL(rul);

    // [CORRELATION] Deteksi korelasi antar parameter
    var correlations = detectCorrelations(winRecords, thresholds);

    // [ALERT HISTORY] Timeline degradasi per parameter
    var alertTimeline = buildAlertTimeline(records, thresholds);

    // Rentang SMR (seluruh data — untuk footer/tabel/identitas).
    var smrStats = stats(records.map(function (r) { return r.smr; }));

    // Waktu terakhir
    var lastWithCal = null;
    for (var i = records.length - 1; i >= 0; i--) {
      if (records[i].calendar) { lastWithCal = records[i]; break; }
    }

    return {
      meta: parsed.meta,
      columns: parsed.columns,
      // records = SELURUH data asli (Rule Tampilan: chart & tabel)
      records: records,
      // windowRecords = subset N jam terakhir (Rule Formula)
      windowRecords: winRecords,
      summary: summary,
      anomalies: anomalies,
      health: health,
      // info window formula untuk ditampilkan di UI
      formulaWindow: {
        hours: win.windowHours,
        smrMax: win.smrMax,
        smrCutoff: win.smrCutoff,
        recordCount: winRecords.length,
        totalRecords: records.length,
        full: win.full
      },
      // [POIN 1] info keluarga produk + profil terpakai
      familyId: prof ? prof.familyId : 'UNKNOWN',
      family: prof ? prof.family : null,
      thresholdSet: thresholds,
      // [VALIDASI] laporan validasi data
      validationReport: validationReport,
      smrRange: { min: smrStats.min, max: smrStats.max, last: smrStats.last },
      lastTimestamp: lastWithCal && lastWithCal.calendar ? lastWithCal.calendar.display : null,
      lastRecord: records[records.length - 1] || null,
      // [RUL] Estimasi sisa jam operasi per parameter
      rul: rul,
      urgentRUL: urgentRUL,
      // [CORRELATION] Korelasi antar parameter
      correlations: correlations,
      // [ALERT HISTORY] Timeline degradasi
      alertTimeline: alertTimeline
    };
  }

  /**
   * [RULE DATA] Potong record ke N jam SMR TERAKHIR (untuk FORMULA).
   * Memakai FORMULA_WINDOW_HOURS dari config. Bila window <= 0 atau rentang
   * lebih pendek dari window, seluruh record dikembalikan (full = true).
   * Logika sengaja diduplikasi (tanpa ketergantungan ke modul ranking) agar
   * vhms-analytics tetap mandiri.
   */
  function sliceFormulaWindow(records) {
    var win = (cfg.FORMULA_WINDOW_HOURS || 0);
    if (!records || !records.length || win <= 0) {
      return { records: records || [], windowHours: win, smrMax: null, smrCutoff: null, full: true };
    }
    var smrMax = null;
    for (var i = 0; i < records.length; i++) {
      var s = records[i].smr;
      if (s === null || s === undefined || isNaN(s)) continue;
      if (smrMax === null || s > smrMax) smrMax = s;
    }
    if (smrMax === null) {
      return { records: records, windowHours: win, smrMax: null, smrCutoff: null, full: true };
    }
    var cutoff = smrMax - win;
    var subset = records.filter(function (r) {
      return r.smr !== null && r.smr !== undefined && !isNaN(r.smr) && r.smr >= cutoff;
    });
    return {
      records: subset,
      windowHours: win,
      smrMax: smrMax,
      smrCutoff: cutoff,
      full: subset.length === records.length
    };
  }

  /* -----------------------------------------------------------------------
   * ALERT HISTORY TIMELINE — track degradasi per parameter
   * ---------------------------------------------------------------------
   * Untuk setiap parameter: kapan pertama kali memasuki zona WARNING,
   * kapan pertama kali CRITICAL, berapa lama transisi WARNING→CRITICAL,
   * dan kecepatan degradasi (jam SMR antara transisi).
   * --------------------------------------------------------------------- */
  function buildAlertTimeline(records, thresholds) {
    var TH = thresholds || cfg.THRESHOLDS;
    var keys = Object.keys(TH);
    var timeline = [];

    keys.forEach(function (key) {
      var th = TH[key];
      if (!th) return;

      var firstWarn = null, firstCrit = null;
      var lastNormal = null;

      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var v = r[key];
        if (v === null || v === undefined || isNaN(v)) continue;

        var st = evaluateParam(key, v, TH);
        if (st === 'NORMAL' && !firstWarn) {
          lastNormal = { smr: r.smr, calendar: r.calendar, value: v };
        }
        if ((st === 'WARNING' || st === 'CRITICAL') && !firstWarn) {
          firstWarn = { smr: r.smr, calendar: r.calendar, value: v, status: st };
        }
        if (st === 'CRITICAL' && !firstCrit) {
          firstCrit = { smr: r.smr, calendar: r.calendar, value: v };
        }
      }

      // Hanya include parameters yang pernah memasuki zona warning+
      if (!firstWarn) return;

      var degradationSpeed = null;
      if (firstWarn && firstCrit && firstCrit.smr > firstWarn.smr) {
        degradationSpeed = Math.round(firstCrit.smr - firstWarn.smr);
      }
      if (lastNormal && firstWarn && firstWarn.smr > lastNormal.smr) {
        var normalToWarn = Math.round(firstWarn.smr - lastNormal.smr);
      }

      var meta = cfg.PARAMS[key] || {};
      timeline.push({
        param: key,
        label: meta.label || key,
        unit: meta.unit || '',
        firstWarn: firstWarn,
        firstCrit: firstCrit,
        lastNormal: lastNormal,
        normalToWarnHours: normalToWarn || null,
        warnToCritHours: degradationSpeed,
        // Urgency: parameter yang cepat naik dari warn ke crit lebih urgent
        speed: degradationSpeed !== null
          ? (degradationSpeed <= 500 ? 'Cepat' : (degradationSpeed <= 2000 ? 'Sedang' : 'Lambat'))
          : null
      });
    });

    // Sort: yang sudah critical dan degradasi cepat di atas
    timeline.sort(function (a, b) {
      var ac = a.firstCrit ? 0 : 1, bc = b.firstCrit ? 0 : 1;
      if (ac !== bc) return ac - bc;
      var as = a.warnToCritHours || 99999, bs = b.warnToCritHours || 99999;
      return as - bs;
    });

    return timeline;
  }

  /* -----------------------------------------------------------------------
   * CORRELATION — Pearson correlation antar parameter
   * ---------------------------------------------------------------------
   * Deteksi otomatis: parameter mana yang bergerak bersamaan?
   * Misal: coolantTemp naik bersamaan dengan hydTempMax = kemungkinan
   * masalah radiator/fan shared system.
   * --------------------------------------------------------------------- */
  function pearson(xArr, yArr) {
    var n = Math.min(xArr.length, yArr.length);
    if (n < 5) return null;
    var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    var valid = 0;
    for (var i = 0; i < n; i++) {
      var x = xArr[i], y = yArr[i];
      if (x === null || y === null || isNaN(x) || isNaN(y)) continue;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      valid++;
    }
    if (valid < 5) return null;
    var denom = Math.sqrt((valid * sxx - sx * sx) * (valid * syy - sy * sy));
    if (denom < 1e-12) return null;
    return (valid * sxy - sx * sy) / denom;
  }

  /**
   * Hitung korelasi antar semua parameter yang punya threshold.
   * Mengembalikan array pasangan { paramA, paramB, r, strength, direction }
   * yang korelasinya kuat (|r| >= 0.6), diurutkan menurut |r| menurun.
   */
  function detectCorrelations(records, thresholds) {
    var TH = thresholds || cfg.THRESHOLDS;
    var keys = Object.keys(TH);
    // Tambahkan parameter menarik lain
    ['engSpeedMax', 'boostMax', 'ambientMax', 'engPowerAve', 'fuelRate'].forEach(function (k) {
      if (keys.indexOf(k) === -1 && cfg.PARAMS[k]) keys.push(k);
    });

    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
      for (var j = i + 1; j < keys.length; j++) {
        var a = keys[i], b = keys[j];
        var xArr = records.map(function (r) { return r[a]; });
        var yArr = records.map(function (r) { return r[b]; });
        var r = pearson(xArr, yArr);
        if (r === null) continue;
        var absR = Math.abs(r);
        if (absR < 0.6) continue; // hanya korelasi kuat
        pairs.push({
          paramA: a, labelA: (cfg.PARAMS[a] || {}).label || a,
          paramB: b, labelB: (cfg.PARAMS[b] || {}).label || b,
          r: Math.round(r * 1000) / 1000,
          strength: absR >= 0.85 ? 'Sangat Kuat' : (absR >= 0.7 ? 'Kuat' : 'Moderat'),
          direction: r > 0 ? 'positif' : 'negatif'
        });
      }
    }
    pairs.sort(function (a, b) { return Math.abs(b.r) - Math.abs(a.r); });
    return pairs;
  }

  /* -----------------------------------------------------------------------
   * RUL — Remaining Useful Life (estimasi sisa jam operasi)

   * ---------------------------------------------------------------------
   * Untuk setiap parameter yang sudah melampaui WARNING atau mendekati
   * CRITICAL, ekstrapolasi slope linier untuk memperkirakan kapan nilai
   * akan menembus ambang batas kritis.
   *
   * Rumus:
   *   mode 'high': RUL = (crit - lastValue) / slope   (slope > 0 = memburuk)
   *   mode 'low' : RUL = (lastValue - crit) / |slope|  (slope < 0 = memburuk)
   *
   * Hanya bermakna bila slope mengarah memburuk. Bila slope stabil/membaik,
   * RUL = Infinity (tidak akan mencapai critical pada laju saat ini).
   * --------------------------------------------------------------------- */
  function estimateRUL(records, paramKey, th) {
    if (!th || !records || records.length < 4) return null;

    var sl = slope(records, paramKey);
    if (sl === null) return null;

    // Ambil nilai terakhir yang valid
    var lastVal = null;
    for (var i = records.length - 1; i >= 0; i--) {
      var v = records[i][paramKey];
      if (v !== null && v !== undefined && !isNaN(v)) { lastVal = v; break; }
    }
    if (lastVal === null) return null;

    // Apakah slope mengarah memburuk?
    var worsening = (th.mode === 'low') ? (sl < 0) : (sl > 0);
    if (!worsening) {
      // Slope stabil / membaik — tidak akan mencapai critical
      return { hours: Infinity, confident: false, slope: sl, lastValue: lastVal, alreadyCritical: false };
    }

    // Sudah critical?
    var alreadyCrit = (th.mode === 'low') ? (lastVal <= th.crit) : (lastVal >= th.crit);
    if (alreadyCrit) {
      return { hours: 0, confident: true, slope: sl, lastValue: lastVal, alreadyCritical: true };
    }

    var distance = (th.mode === 'low')
      ? (lastVal - th.crit)     // berapa jauh dari batas (positif = masih aman)
      : (th.crit - lastVal);

    var rate = Math.abs(sl);     // perubahan per jam SMR
    if (rate < 1e-12) return { hours: Infinity, confident: false, slope: sl, lastValue: lastVal, alreadyCritical: false };

    var hours = distance / rate;

    // Confidence: slope dihitung dari >= 6 data points dan RUL < 10000 jam
    var nValid = 0;
    for (var j = 0; j < records.length; j++) {
      if (records[j][paramKey] !== null && records[j].smr !== null) nValid++;
    }
    var confident = nValid >= 6 && hours < 10000;

    return {
      hours: Math.round(hours),
      confident: confident,
      slope: sl,
      lastValue: lastVal,
      alreadyCritical: false
    };
  }

  /**
   * Hitung RUL untuk SEMUA parameter yang punya threshold pada sebuah unit.
   * @returns {object} { paramKey: { hours, confident, slope, lastValue, alreadyCritical } }
   */
  function computeAllRUL(records, thresholds) {
    var TH = thresholds || cfg.THRESHOLDS;
    var result = {};
    var keys = Object.keys(TH);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var rul = estimateRUL(records, k, TH[k]);
      if (rul) result[k] = rul;
    }
    return result;
  }

  /**
   * Parameter dengan RUL terpendek (paling urgent).
   * @returns {{ param, label, hours, confident, slope, alreadyCritical } | null}
   */
  function mostUrgentRUL(rulMap) {
    var best = null;
    for (var k in rulMap) {
      if (!Object.prototype.hasOwnProperty.call(rulMap, k)) continue;
      var r = rulMap[k];
      if (r.hours === Infinity) continue;
      if (!best || r.hours < best.hours) {
        best = { param: k, label: (cfg.PARAMS[k] || {}).label || k, hours: r.hours,
                 confident: r.confident, slope: r.slope, alreadyCritical: r.alreadyCritical };
      }
    }
    return best;
  }

  global.VHMS_ANALYTICS = {
    analyze: analyze,
    stats: stats,
    slope: slope,
    evaluateParam: evaluateParam,
    buildChartData: buildChartData,
    hexToRgba: hexToRgba,
    estimateRUL: estimateRUL,
    computeAllRUL: computeAllRUL,
    mostUrgentRUL: mostUrgentRUL,
    pearson: pearson,
    detectCorrelations: detectCorrelations,
    buildAlertTimeline: buildAlertTimeline
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_ANALYTICS;
  }
})(typeof window !== 'undefined' ? window : globalThis);

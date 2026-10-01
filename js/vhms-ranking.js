/* =========================================================================
 * vhms-ranking.js
 * -------------------------------------------------------------------------
 * Perhitungan skor CRITICALITAS per unit untuk halaman Unit Comparison.
 *
 * SKOR AKHIR (0-100) = kombinasi 3 sumbu berbobot:
 *
 *   1. KEPARAHAN (Severity)  45%  — seberapa JAUH nilai melewati batas kritis
 *   2. BUKTI    (Evidence)   30%  — seberapa LAMA melanggar (durasi jam SMR)
 *   3. TREN     (Trend)      25%  — seberapa CEPAT memburuk (slope vs SMR)
 *
 * Kriteria & bobot bersumber dari standar reliability umum industri
 * (Safety > Downtime > Biaya) — lihat docs/KRITERIA_RANKING_CRITICAL.md.
 * BUKAN dokumen resmi Komatsu. Semua bobot ada di vhms-config.js.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;

  /* -----------------------------------------------------------------------
   * 1. SEVERITY — seberapa jauh nilai ekstrem melewati batas kritis.
   * ---------------------------------------------------------------------
   * Mengembalikan 0..1. Nilai 1 berarti "sangat ekstrem" (jenuh).
   *
   * mode 'high': makin besar makin bahaya.
   *      rasio = (nilai - crit) / crit        (berapa persen di atas crit)
   * mode 'low' : makin kecil makin bahaya.
   *      rasio = (crit - nilai) / crit
   *
   * Rasio 1.0 (100% di atas batas) sudah dianggap ekstrem dan dijenuhkan
   * agar satu nilai outlier tak mendominasi seluruh skor.
   * --------------------------------------------------------------------- */
  var SEVERITY_SATURATION = 1.0;

  function severityScore(value, th) {
    if (value === null || value === undefined || isNaN(value)) return 0;
    var ratio;
    if (th.mode === 'low') {
      if (value >= th.crit) return 0;           // belum melewati batas kritis
      ratio = (th.crit - value) / Math.abs(th.crit);
    } else {
      if (value <= th.crit) return 0;
      ratio = (value - th.crit) / Math.abs(th.crit);
    }
    return Math.max(0, Math.min(1, ratio / SEVERITY_SATURATION));
  }

  /**
   * Skor severity dengan kurva tak-jenuh (soft): memakai sqrt agar nilai
   * yang baru sedikit melewati batas tetap memberi kontribusi bermakna,
   * namun perbedaan antar nilai ekstrem tetap terlihat (tidak semua 100).
   */
  function severityScoreSoft(value, th) {
    var raw = severityScore(value, th);
    if (raw <= 0) return 0;
    // petakan rasio mentah (0..~1) ke skor lebih menyebar
    return Math.max(0, Math.min(1, Math.sqrt(raw)));
  }

  /* -----------------------------------------------------------------------
   * 2. EVIDENCE — seberapa lama parameter berada di zona bahaya.
   * ---------------------------------------------------------------------
   * Dihitung dari DURASI (jam SMR) rentang data yang melanggar, bukan
   * sekadar jumlah record. Alasan: satu spike tajam pada 1 record bisa
   * lebih berbahaya daripada 50 record yang melanggar tipis-tipis —
   * maka durasi (jam) lebih merepresentasikan paparan nyata.
   *
   * Metode: total "record-hours" = jumlah jam antar-SMR dari setiap
   * record yang melanggar batas WARNING, dinormalisasi terhadap total
   * rentang SMR unit. Bukti tinggi = melanggar hampir sepanjang rentang.
   * --------------------------------------------------------------------- */
  function evidenceScore(records, paramKey, th) {
    if (!records || records.length < 2) return 0;

    var warnTh = th.warn;
    var violatingHours = 0;
    var totalHours = 0;

    for (var i = 1; i < records.length; i++) {
      var prev = records[i - 1], cur = records[i];
      if (prev.smr === null || cur.smr === null) continue;
      var dt = cur.smr - prev.smr;
      if (dt < 0) continue;              // lompatan tak wajar, abaikan
      totalHours += dt;

      var v = cur[paramKey];
      if (v === null || v === undefined) continue;
      var violates = (th.mode === 'low') ? (v <= warnTh) : (v >= warnTh);
      if (violates) violatingHours += dt;
    }

    if (totalHours <= 0) return 0;
    return Math.max(0, Math.min(1, violatingHours / totalHours));
  }

  /* -----------------------------------------------------------------------
   * 3. TREND — seberapa cepat parameter memburuk terhadap SMR.
   * ---------------------------------------------------------------------
   * slope (least-squares) dinyatakan dalam satuan-parameter per jam SMR.
   * Dinormalisasi: memburuk sebesar `trendRefPerHour` per jam dianggap
   * skor penuh. Arah "memburuk" bergantung mode threshold.
   * --------------------------------------------------------------------- */
  var TREND_FULL_SCALE = {
    // perkiraan perubahan yang dianggap "cepat memburuk" per 1 jam SMR
    blowbyMax:    0.002,   // kPa/jam   (~0.2 kPa per 100 jam)
    oilPressHMin: 0.0005,  // MPa/jam
    hydTempMax:   0.0015,  // C/jam
    engOilTemp:   0.0010,
    coolantTemp:  0.0010,
    ptoTempMax:   0.0010,
    pump1F:       0.0010,
    pump1R:       0.0010,
    pump2F:       0.0010,
    pump2R:       0.0010,
    fanPumpF:     0.0010,
    fanPumpR:     0.0010,
    fuelRate:     0.0015
  };

  function trendScore(records, paramKey, th) {
    var sl = slopeOf(records, paramKey);
    if (sl === null) return 0;
    // Arah memburuk
    var worsening = (th.mode === 'low') ? -sl : sl;
    if (worsening <= 0) return 0;
    var ref = TREND_FULL_SCALE[paramKey] || 0.001;
    return Math.max(0, Math.min(1, worsening / ref));
  }

  /** Least-squares slope (y = param, x = SMR). */
  function slopeOf(records, paramKey) {
    var xs = [], ys = [];
    for (var i = 0; i < records.length; i++) {
      var x = records[i].smr, y = records[i][paramKey];
      if (x === null || y === null || y === undefined) continue;
      xs.push(x); ys.push(y);
    }
    if (xs.length < 4) return null;
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  /* -----------------------------------------------------------------------
   * 4. Skor per parameter & agregasi per unit
   * --------------------------------------------------------------------- */
  function paramMeta(key) {
    return cfg.PARAMS[key] || { label: key, unit: '', decimals: 1 };
  }

  /* -----------------------------------------------------------------------
   * [POIN 8] Window 1500 jam terakhir.
   * ---------------------------------------------------------------------
   * Mengembalikan subset record yang berada pada N jam SMR terakhir,
   * dihitung dari SMR TERTINGGI (bukan dari awal file). Ini membuat
   * penilaian criticality mencerminkan kondisi terkini dan adil antar unit
   * yang panjang rentang datanya berbeda. Bila rentang total <= window,
   * seluruh record dikembalikan.
   * @param {array} records
   * @param {number} [hoursOverride] bila diisi, pakai nilai jam ini alih-alih
   *        cfg.FORMULA_WINDOW_HOURS (semua formula memakai window yang sama).
   * @returns {{records: array, windowHours: number, smrMax: number, smrCutoff: number, full: boolean}}
   * --------------------------------------------------------------------- */
  function sliceWindow(records, hoursOverride) {
    var win = (hoursOverride !== undefined && hoursOverride !== null)
      ? hoursOverride
      : (cfg.FORMULA_WINDOW_HOURS || cfg.RANKING_WINDOW_HOURS || 0);
    if (!records || !records.length || win <= 0) {
      return { records: records || [], windowHours: win, smrMax: null, smrCutoff: null, full: true };
    }
    // Tentukan SMR maksimum
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

  /** Ringkasan (summary) dihitung ulang dari subset window. */
  function summarizeSubset(records) {
    var out = {};
    var P = cfg.PARAMS;
    for (var key in P) {
      if (!Object.prototype.hasOwnProperty.call(P, key)) continue;
      if (key === 'smr' || key === 'calendar') continue;
      var v = [];
      for (var i = 0; i < records.length; i++) {
        var val = records[i][key];
        if (val !== null && val !== undefined && !isNaN(val)) v.push(val);
      }
      if (!v.length) { out[key] = { min: null, max: null, avg: null, last: null, first: null, count: 0 }; continue; }
      var sum = 0;
      for (var j = 0; j < v.length; j++) sum += v[j];
      out[key] = {
        min: Math.min.apply(null, v),
        max: Math.max.apply(null, v),
        avg: sum / v.length,
        first: v[0],
        last: v[v.length - 1],
        count: v.length
      };
    }
    return out;
  }

  /**
   * Tentukan KEY parameter yang benar-benar dipakai (efektif) dari sebuah
   * skema threshold, dengan aturan FALLBACK:
   *   - Bila sebuah threshold punya `fallbackFor: '<targetKey>'`, parameter
   *     itu HANYA dipakai bila parameter target TIDAK punya data.
   *   - Contoh: TRUCK memberi threshold pada `oilPressMax` (mode low) sebagai
   *     cadangan untuk `oilPressHMin`. Bila H-Min tersedia, H-Min yang dipakai
   *     (oilPressMax dilewati agar tidak dobel); bila H-Min tidak ada (HD785),
   *     barulah oilPressMax dipakai.
   *
   * @param {object} thresholds skema threshold (per keluarga)
   * @param {object} summary    ringkasan nilai (punya .max/.min) per param
   * @param {object} [only]     bila diisi, batasi ke key yang ada di sini
   * @returns {string[]} daftar key efektif (sudah siap diiterasi)
   */
  function effectiveThresholdKeys(thresholds, summary, only) {
    thresholds = thresholds || {};
    summary = summary || {};
    function hasData(key) {
      var s = summary[key];
      return !!(s && (s.max !== null || s.min !== null));
    }
    var keys = Object.keys(thresholds).filter(function (k) {
      return !only || Object.prototype.hasOwnProperty.call(only, k);
    });
    return keys.filter(function (k) {
      var th = thresholds[k];
      if (!th || !th.fallbackFor) return true;
      // Buang param cadangan bila target-nya punya data.
      return !hasData(th.fallbackFor);
    });
  }

  /**
   * Hitung kontribusi tiap parameter terhadap skor unit.
   * @param {object} analysis
   * @param {array}  winRecords  record yang sudah dipotong ke window (default: analysis.records)
   * @param {object} winSummary  summary yang dihitung dari winRecords (default: analysis.summary)
   * @returns {array} daftar { param, pillar, value, severity, evidence, trend, weight, contribution }
   */
  function scoreParameters(analysis, winRecords, winSummary) {
    var records = winRecords || analysis.records || [];
    var summary = winSummary || analysis.summary || {};
    // [POIN 1] Bobot & pilar mengikuti profil keluarga produk (bila ada)
    var prof = (global.VHMS_PROFILES && analysis.familyId)
      ? global.VHMS_PROFILES.PROFILES[analysis.familyId] : null;
    var weights = (prof && prof.weights) ? prof.weights : cfg.RANKING_WEIGHTS;
    var pillars = (prof && prof.pillars) ? prof.pillars : cfg.RANKING_PILLARS;
    var pillarWeights = cfg.RANKING_PILLAR_WEIGHTS || {};
    var thresholds = analysis.thresholdSet || cfg.THRESHOLDS;
    var out = [];

    // [REVISI] Hormati fallback (mis. oilPressMax dipakai hanya bila H-Min absen)
    effectiveThresholdKeys(thresholds, summary, weights).forEach(function (key) {
      var th = thresholds[key];
      if (!th) return;                       // parameter tanpa threshold: dilewati
      var s = summary[key];
      if (!s || (s.max === null && s.min === null)) return;  // tak ada data: dilewati
      if (weights[key] === undefined) return;  // tak ada bobot -> bukan param ranking

      var pillar = pillars[key] || 'OTHER';
      var extreme = (th.mode === 'low') ? s.min : s.max;
      var sev = severityScoreSoft(extreme, th);
      var evi = evidenceScore(records, key, th);
      var tre = trendScore(records, key, th);

      // [POIN 7] bobot efektif = bobot parameter x bobot pilar (Engine dominan)
      var pw = (pillarWeights[pillar] !== undefined) ? pillarWeights[pillar] : 1;
      var effWeight = weights[key] * pw;

      out.push({
        param: key,
        label: paramMeta(key).label,
        unit: paramMeta(key).unit,
        decimals: paramMeta(key).decimals,
        pillar: pillar,
        value: extreme,
        warn: th.warn,
        crit: th.crit,
        mode: th.mode,
        severity: sev,
        evidence: evi,
        trend: tre,
        weight: effWeight,
        pillarWeight: pw,
        baseWeight: weights[key],
        // kontribusi berbobot (0..effWeight)
        contribution: effWeight * (cfg.RANKING_AXES.severity * sev +
                                   cfg.RANKING_AXES.evidence * evi +
                                   cfg.RANKING_AXES.trend * tre)
      });
    });

    out.sort(function (a, b) { return b.contribution - a.contribution; });
    return out;
  }

  /**
   * Skor criticalitas lengkap sebuah unit.
   * [RULE DATA] HANYA memakai data pada window FORMULA_WINDOW_HOURS terakhir.
   * [POIN 7] Bobot pilar (Engine lebih besar) memengaruhi skor.
   * @returns {object} { id, score, band, severity, evidence, trend, params, topCause, pillar }
   */
  function scoreUnit(unitId, analysis) {
    if (!analysis) return null;

    // [POIN 8] Potong ke window jam terakhir
    var win = sliceWindow(analysis.records);
    var winRecords = win.records;
    var winSummary = summarizeSubset(winRecords);

    var params = scoreParameters(analysis, winRecords, winSummary);
    var axes = cfg.RANKING_AXES;

    // Sumbu agregat (rata-rata berbobot terhadap total bobot parameter)
    var totalWeight = 0;
    var axSev = 0, axEvi = 0, axTre = 0;
    params.forEach(function (p) {
      totalWeight += p.weight;
      axSev += p.weight * p.severity;
      axEvi += p.weight * p.evidence;
      axTre += p.weight * p.trend;
    });
    if (totalWeight === 0) totalWeight = 1;

    var sevPct = (axSev / totalWeight) * 100;
    var eviPct = (axEvi / totalWeight) * 100;
    var trePct = (axTre / totalWeight) * 100;

    var base = axes.severity * sevPct + axes.evidence * eviPct + axes.trend * trePct;

    // ---- Faktor BREADTH: berapa parameter yang benar-benar bermasalah ----
    // Unit dengan masalah di banyak parameter sekaligus (mis. engine AND
    // hydraulic AND cooling) jauh lebih berisiko daripada unit dengan satu
    // parameter sangat tinggi. Breadth memberi bobot tambahan proporsional.
    var affected = params.filter(function (p) {
      return p.severity > 0.15 || p.evidence > 0.25 || p.trend > 0.35;
    });
    var width = affected.length / Math.max(1, params.length);   // 0..1
    // pengali 1.0 (tidak ada) .. 1.6 (banyak parameter bermasalah)
    var breadthFactor = 1 + width * 0.6;

    // [POIN 7] Faktor pilar: bila parameter terburuk berada di pilar
    // berbobot tinggi (ENGINE), skor keseluruhan ikut terangkat agar unit
    // dengan Engine critical selalu trending di atas.
    var topForPillar = params[0] || null;
    var topPillarWeight = topForPillar ? (topForPillar.pillarWeight || 1) : 1;
    // normalisasi agar pilar bobot 1.0 -> faktor 1.0, ENGINE (2.0) -> +sesuai
    var pillarFactor = topPillarWeight >= 1 ? (1 + (topPillarWeight - 1) * 0.35) : topPillarWeight;

    // ---- Skala akhir ----
    // base (0..100) sudah merupakan rata-rata berbobot 3 sumbu. Karena
    // sebagian besar parameter hampir selalu "tenang", nilai base untuk
    // unit bermasalah nyata berada di kisaran 20-40. Kita lakukan
    // AMPLIFIKASI agar perbedaan antar unit lebih terbaca dan band
    // CRITICAL dapat tercapai oleh unit multi-pilar yang benar-benar parah.
    var SCALE_GAIN = 1.6;
    var raw = base * breadthFactor * pillarFactor * SCALE_GAIN;

    // [A5] SATURASI LUNAK di ujung atas agar unit yang sangat parah TIDAK
    // menumpuk di angka 100 (sehingga antar-unit terburuk tetap bisa
    // dibedakan). Skor <= SOFT_KNEE (90) TIDAK berubah sama sekali, jadi
    // kalibrasi band (critical 45 / warning 25) tetap persis seperti semula.
    //   raw <= 90 : score = raw                       (identitas)
    //   raw  > 90 : score = 90 + 10 * (raw-90)/((raw-90)+10)   (asimtotik -> 100)
    // Kontinu di raw = 90 (bernilai 90) dan monoton naik.
    var SOFT_KNEE = 90, SOFT_TAIL = 10;
    var score;
    if (raw <= SOFT_KNEE) {
      score = raw;
    } else {
      var over = raw - SOFT_KNEE;
      score = SOFT_KNEE + SOFT_TAIL * (over / (over + SOFT_TAIL));
    }
    score = Math.min(100, score);

    var bands = cfg.RANKING_BANDS;
    var band = score >= bands.critical ? 'CRITICAL'
              : (score >= bands.warning ? 'WARNING' : 'NORMAL');

    var top = params[0] || null;

    return {
      id: unitId,
      score: Math.round(score * 10) / 10,
      band: band,
      axis: {
        severity: Math.round(sevPct * 10) / 10,
        evidence: Math.round(eviPct * 10) / 10,
        trend: Math.round(trePct * 10) / 10
      },
      affectedCount: affected.length,
      affectedParams: affected,
      breadthFactor: Math.round(breadthFactor * 100) / 100,
      pillarFactor: Math.round(pillarFactor * 100) / 100,
      params: params,
      topCause: top,
      pillar: top ? top.pillar : '—',
      healthScore: analysis.health ? analysis.health.score : null,
      smrLast: analysis.smrRange ? analysis.smrRange.last : null,
      // [POIN 8] info window untuk ditampilkan di UI
      window: {
        hours: win.windowHours,
        smrMax: win.smrMax,
        smrCutoff: win.smrCutoff,
        recordCount: winRecords.length,
        totalRecords: (analysis.records || []).length,
        full: win.full
      }
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Ranking seluruh armada
   * --------------------------------------------------------------------- */
  function rankFleet(fleetStore, options) {
    options = options || {};
    var modelFilter = options.model || 'ALL';

    var results = [];
    fleetStore.rows().forEach(function (row) {
      if (modelFilter !== 'ALL' && row.model !== modelFilter) return;
      var analysis = fleetStore.getAnalysis(row.id);
      if (!analysis || !analysis.records) {
        // records sudah di-release -> skor parsial dari summaryRow
        results.push(buildPartialScore(row));
        return;
      }
      var sc = scoreUnit(row.id, analysis);
      if (sc) {
        sc.serial = row.serial;
        sc.model = row.model;
        sc.sourceFile = row.sourceFile;
        results.push(sc);
      }
    });

    // [A5] Tie-break agar unit dengan skor SAMA (mis. dua unit yang sama-sama
    // menyentuh batas atas 100) tetap terurut deterministik & bermakna:
    // severity -> evidence -> trend -> jumlah parameter bermasalah.
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ax = a.axis || {}, bx = b.axis || {};
      if ((bx.severity || 0) !== (ax.severity || 0)) return (bx.severity || 0) - (ax.severity || 0);
      if ((bx.evidence || 0) !== (ax.evidence || 0)) return (bx.evidence || 0) - (ax.evidence || 0);
      if ((bx.trend || 0) !== (ax.trend || 0)) return (bx.trend || 0) - (ax.trend || 0);
      var aa = a.affectedCount || 0, ab = b.affectedCount || 0;
      if (ab !== aa) return ab - aa;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    results.forEach(function (r, i) { r.rank = i + 1; });
    return results;
  }

  /** Skor cadangan bila record mentah sudah dilepas (hanya pakai summaryRow). */
  function buildPartialScore(row) {
    return {
      id: row.id, serial: row.serial, model: row.model, sourceFile: row.sourceFile,
      score: 0, band: 'NORMAL',
      axis: { severity: 0, evidence: 0, trend: 0 },
      params: [], topCause: null, pillar: '—',
      healthScore: row.healthScore, smrLast: row.smrLast,
      partial: true
    };
  }

  /* -----------------------------------------------------------------------
   * 6. PERBANDINGAN PER PARAMETER (matrix aple-to-aple)
   * ---------------------------------------------------------------------
   * Membangun matrix: baris = parameter (yang punya threshold & data),
   * kolom = unit (default TOP N peringkat criticalitas). Nilai diambil dari
   * NILAI MENTAH (raw) pada window jam yang sama dengan ranking.
   *
   * Setiap sel: { value, status, unit, decimals, mode } atau null.
   * Status dievaluasi terhadap threshold milik masing-masing unit (agar
   * fleksibel lintas keluarga/model yang ambangnya berbeda).
   *
   * @param {object} fleetStore  store armada (punya getAnalysis & rows)
   * @param {array}  ranked      hasil rankFleet (terurut menurun)
   * @param {object} [opts]      { topN:10, basis:'extreme'|'avg'|'last', pillar:'ALL' }
   * @returns {{units: array, rows: array, avgHours: number, windowHours: number}}
   * --------------------------------------------------------------------- */
  function paramMatrix(fleetStore, ranked, opts) {
    opts = opts || {};
    var topN = opts.topN || 10;
    var basis = opts.basis || 'extreme';     // extreme | avg | last
    var pillarFilter = opts.pillar || 'ALL';

    var top = (ranked || []).slice(0, topN);
    var units = [];
    var paramMap = {};       // paramKey -> { key, pillar, cells: { unitId: cell } }
    var windowHours = cfg.FORMULA_WINDOW_HOURS || cfg.RANKING_WINDOW_HOURS || 0;

    top.forEach(function (r) {
      var analysis = fleetStore.getAnalysis(r.id);
      units.push({
        id: r.id, serial: r.serial, model: r.model, rank: r.rank, band: r.band,
        hasData: !!analysis
      });
      if (!analysis || !analysis.records) return;

      // Potong ke window yang sama dengan ranking
      var win = sliceWindow(analysis.records);
      var sum = summarizeSubset(win.records);
      var thresholds = analysis.thresholdSet || cfg.THRESHOLDS;
      var pillars = cfg.RANKING_PILLARS || {};

      // [REVISI] Hormati fallback & hanya param berdata (mis. HD785 pakai
      // oilPressMax karena H-Min tidak ada).
      effectiveThresholdKeys(thresholds, sum).forEach(function (key) {
        var th = thresholds[key];
        if (!th) return;
        var s = sum[key];
        if (!s || (s.max === null && s.min === null)) return;

        var pillar = pillars[key] || 'OTHER';
        if (pillarFilter !== 'ALL' && pillar !== pillarFilter) return;

        // Ambil nilai sesuai basis & mode parameter
        var value;
        if (basis === 'avg') value = s.avg;
        else if (basis === 'last') value = s.last;
        else value = (th.mode === 'low') ? s.min : s.max;   // extreme (terburuk)

        var meta = paramMeta(key);
        var cell = {
          value: value,
          status: statusOf(value, th),
          unit: meta.unit,
          decimals: meta.decimals,
          mode: th.mode,
          warn: th.warn,
          crit: th.crit
        };

        if (!paramMap[key]) {
          paramMap[key] = { key: key, pillar: pillar, label: meta.label, unit: meta.unit,
                            decimals: meta.decimals, mode: th.mode, warn: th.warn, crit: th.crit,
                            cells: {} };
        }
        paramMap[key].cells[r.id] = cell;
      });
    });

    // Susun baris per pilar (urutan pilar tetap: ENGINE, HYDRAULIC, COOLING, ECONOMY, OTHER)
    var PILLAR_ORDER = ['ENGINE', 'HYDRAULIC', 'COOLING', 'ECONOMY', 'OTHER'];
    var rows = Object.keys(paramMap).map(function (k) { return paramMap[k]; });

    // Untuk tiap baris, tandai unit terbaik & terburuk
    rows.forEach(function (row) {
      var best = null, worst = null;
      units.forEach(function (u) {
        var c = row.cells[u.id];
        if (!c || c.value === null || c.value === undefined || isNaN(c.value)) return;
        // "Baik" = menjauh dari batas kritis. mode high: makin kecil makin baik.
        if (best === null) { best = u.id; worst = u.id; return; }
        var vb = row.cells[best].value, vw = row.cells[worst].value;
        if (row.mode === 'low') {
          if (c.value > vb) best = u.id;
          if (c.value < vw) worst = u.id;
        } else {
          if (c.value < vb) best = u.id;
          if (c.value > vw) worst = u.id;
        }
      });
      row.bestUnit = best;
      row.worstUnit = worst;
    });

    rows.sort(function (a, b) {
      var pa = PILLAR_ORDER.indexOf(a.pillar), pb = PILLAR_ORDER.indexOf(b.pillar);
      if (pa !== pb) return pa - pb;
      return a.label.localeCompare(b.label);
    });

    return {
      units: units,
      rows: rows,
      windowHours: windowHours,
      pillar: pillarFilter,
      basis: basis
    };
  }

  /** Evaluasi status satu nilai terhadap threshold (NORMAL/WARNING/CRITICAL). */
  function statusOf(value, th) {
    if (value === null || value === undefined || isNaN(value)) return 'NA';
    if (th.mode === 'low') {
      if (value <= th.crit) return 'CRITICAL';
      if (value <= th.warn) return 'WARNING';
    } else {
      if (value >= th.crit) return 'CRITICAL';
      if (value >= th.warn) return 'WARNING';
    }
    return 'NORMAL';
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_RANKING = {
    severityScore: severityScore,
    evidenceScore: evidenceScore,
    trendScore: trendScore,
    scoreParameters: scoreParameters,
    scoreUnit: scoreUnit,
    rankFleet: rankFleet,
    paramMatrix: paramMatrix,
    statusOf: statusOf,
    effectiveThresholdKeys: effectiveThresholdKeys,
    sliceWindow: sliceWindow,
    summarizeSubset: summarizeSubset,
    slopeOf: slopeOf
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_RANKING;
  }
})(typeof window !== 'undefined' ? window : globalThis);

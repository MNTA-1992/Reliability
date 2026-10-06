/* =========================================================================
 * sos-analytics.js
 * -------------------------------------------------------------------------
 * Engine analitik SOS: MPRS, ROW per 100 jam, Dirt Entry Index,
 * Criticality scoring, dan diagnostik.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.SOS_CONFIG;

  /* -----------------------------------------------------------------------
   * Severity Score — S(v): 0 | 1 | 2 | 4
   * Mengikuti backend criticality.py
   * --------------------------------------------------------------------- */
  function severityScore(value, thresholds, paramKey) {
    if (value === null || value === undefined) return 0;
    // [STANDARISASI 2026-10-03] Semantik SERAGAM untuk semua mode:
    //   1 = melewati ambang WARN    -> Caution
    //   2 = melewati ambang CRIT    -> Critical
    //   4 = melewati ambang EXTREME -> Critical
    // Sebelumnya dual-band memakai 2 untuk warn & 4 untuk crit, sehingga angka
    // yang sama berarti tingkat berbeda tergantung mode. Itu sumber
    // inkonsistensi label Monitor/Caution antar halaman.
    if (thresholds.warn_low !== undefined || thresholds.warn_high !== undefined) {
      if (thresholds.crit_low !== undefined && value <= thresholds.crit_low) return 2;
      if (thresholds.crit_high !== undefined && value >= thresholds.crit_high) return 2;
      if (thresholds.warn_low !== undefined && value <= thresholds.warn_low) return 1;
      if (thresholds.warn_high !== undefined && value >= thresholds.warn_high) return 1;
      return 0;
    }
    // Standard higher-is-worse
    if (!thresholds.warn) return 0;
    if (thresholds.extreme && value >= thresholds.extreme) return 4;
    if (value >= thresholds.crit) return 2;
    if (value >= thresholds.warn) return 1;
    return 0;
  }

  /* -----------------------------------------------------------------------
   * Evaluate status per sample terhadap threshold kompartemen
   * --------------------------------------------------------------------- */
  function evaluateSample(sample, thresholds) {
    var maxSev = 0;
    var violations = [];
    // [FIX 2026-10-01] Tambah Cr/Sn/Ni + oil condition (oxidation/nitration/
    // sulfation/V40) agar semua parameter yang punya threshold IKUT dievaluasi.
    // Sebelumnya 14 param, kini 21 — parameter tanpa threshold di kompartemen
    // tertentu otomatis dilewati (`if (!th) return;`), jadi aman.
    var paramKeys = ['wear_fe','wear_cu','wear_pb','wear_al','wear_cr','wear_si','wear_sn','wear_ni',
                     'additive_na','fuel_pct','water_pct','pqi','visc_v100','visc_v40','tbn',
                     'soot','oxidation','nitration','sulfation'];

    paramKeys.forEach(function (pk) {
      var th = thresholds[pk];
      if (!th) return;
      var v = sample[pk];
      if (v === null || v === undefined) return;
      var s = severityScore(v, th, pk);
      if (s > maxSev) maxSev = s;
      if (s >= 1) {
        violations.push({ param: pk, value: v, severity: s });
      }
    });

    // [STANDARISASI 2026-10-03] Map ke 3 tier: 0=Normal, 1=Caution, 2=Critical
    //   severity 0     -> Normal
    //   severity 1     -> Caution   (melewati ambang warn)
    //   severity 2 / 4 -> Critical  (melewati ambang crit / extreme)
    var tier = 0;
    if (maxSev >= 2) tier = 2;
    else if (maxSev >= 1) tier = 1;

    return { tier: tier, maxSeverity: maxSev, violations: violations };
  }

  /* -----------------------------------------------------------------------
   * MPRS — Multi-Parameter Risk Score
   * MPRS = Σ(weight × S(v)) × CompoundFactor
   * --------------------------------------------------------------------- */
  function calcMPRS(sample, component, model) {
    var thresholds = cfg.getThresholdsFor(component, model);
    var compWeight = cfg.getComponentWeight(component);

    var totalScore = 0;
    var maxSev = 0;
    var breachCount = 0;
    var paramKeys = Object.keys(thresholds);

    paramKeys.forEach(function (pk) {
      var v = sample[pk];
      if (v === null || v === undefined) return;
      var s = severityScore(v, thresholds[pk], pk);
      totalScore += compWeight * s;
      if (s > maxSev) maxSev = s;
      if (s >= 1) breachCount++;
    });

    // Compound factor
    var compFactor = breachCount >= 3 ? 2.0 : (breachCount === 2 ? 1.5 : 1.0);
    var mprs = totalScore * compFactor;

    // [STANDARISASI 2026-10-03] Risk tier 3 level: 0=Normal, 1=Caution, 2=Critical
    var tier = 0;
    if (mprs >= 20 || maxSev >= 2) tier = 2;
    else if (mprs >= 3 || maxSev >= 1) tier = 1;

    // Compound escalation: >=2 parameter breach -> naikkan ke Critical
    if (breachCount >= 2 && maxSev >= 2 && tier < 2) tier = 2;

    return { mprs: Math.round(mprs * 10) / 10, tier: tier, maxSeverity: maxSev, breachCount: breachCount };
  }

  /* -----------------------------------------------------------------------
   * [BARU 2026-09-30] Peringkat SOS — skor "keparahan pelanggaran threshold"
   * ---------------------------------------------------------------------
   * Dasar: parameter yang MELEWATI threshold pada SAMPEL TERBARU
   * (sesuai permintaan user). Skor ini MENGGANTIKAN kolom "Prioritas P1..P3".
   *
   * Konsep: makin BESAR skor = makin parah. Renderer mengurutkan DESC lalu
   * menomori 1..N sehingga **peringkat 1 = paling critical** (nilai terkecil
   * melambangkan level paling critical, sesuai permintaan).
   *
   * Rumus per parameter p yang punya threshold & nilai:
   *   sev(p)      = severityScore(v, th, p)         -> 0 | 1 | 2 | 4
   *   ratio(p)    = (v - th.warn) / (th.extreme - th.warn)   (utk high-is-worse)
   *                 atau kebalikannya untuk low-is-worse (viskositas/TBN)
   *   breach(p)   = sev(p) * (1 + clamp(ratio(p), 0, 3))
   *   rankScore   = Σ breach(p) + 0.5 * (jumlah param breach-2..4)
   *
   * @param {object} sample     sampel (biasanya `latest`)
   * @param {string} component  nama kompartemen
   * @returns {{score:number, breaches:array, worstParam:string}}
   * --------------------------------------------------------------------- */
  function calcRankScore(sample, component, model) {
    var thresholds = cfg.getThresholdsFor(component, model);
    var score = 0;
    var breaches = [];
    var worstVal = -1, worstParam = '';

    Object.keys(thresholds).forEach(function (pk) {
      var th = thresholds[pk];
      var v = sample ? sample[pk] : null;
      if (v === null || v === undefined || !th) return;
      var sev = severityScore(v, th, pk);
      if (sev <= 0) return;

      // Rasio "seberapa jauh melampaui" (0..3, dijepit). Dukung low-is-worse.
      var ratio = 0;
      if (th.warn_low !== undefined) {                 // low = worse
        var loRef = (th.crit_low !== undefined) ? th.crit_low : th.warn_low;
        var loSpan = (th.warn_low - loRef);
        ratio = loSpan > 0 ? (loRef - v) / loSpan : 0;
      } else if (th.warn !== undefined && th.extreme !== undefined && th.extreme > th.warn) {
        ratio = (v - th.warn) / (th.extreme - th.warn);
      } else if (th.warn !== undefined) {
        ratio = (v - th.warn) / (th.warn || 1);
      }
      if (ratio < 0) ratio = 0;
      if (ratio > 3) ratio = 3;

      var breach = sev * (1 + ratio);
      score += breach;
      breaches.push({ param: pk, value: v, severity: sev, ratio: ratio, breach: breach });
      if (breach > worstVal) { worstVal = breach; worstParam = pk; }
    });

    // Bonus: banyak pelanggaran sekaligus = lebih parah.
    score += 0.5 * Math.max(0, breaches.length - 1);

    return { score: Math.round(score * 100) / 100, breaches: breaches, worstParam: worstParam };
  }

  /* -----------------------------------------------------------------------
   * Rate of Wear per 100 jam (ROW₁₀₀)
   *   ROW₁₀₀ = (Metal_t2 - Metal_t1) / (HM_t2 - HM_t1) × 100
   * --------------------------------------------------------------------- */
  function calcROW100(currentSample, prevSample, paramKey) {
    if (!currentSample || !prevSample) return null;
    var v2 = currentSample[paramKey], v1 = prevSample[paramKey];
    var hm2 = currentSample._hm, hm1 = prevSample._hm;
    if (v2 === null || v1 === null || hm2 === null || hm1 === null) return null;
    var dHM = hm2 - hm1;
    if (dHM <= 0) return null;
    return ((v2 - v1) / dHM) * 100;
  }

  /* -----------------------------------------------------------------------
   * Dirt Entry Index = Si + Al
   * --------------------------------------------------------------------- */
  function calcDirtEntry(sample) {
    var si = sample.wear_si || 0;
    var al = sample.wear_al || 0;
    return si + al;
  }

  /* -----------------------------------------------------------------------
   * [REVISI #12] Potong sampel ke N JAM terakhir berdasarkan HM/Meter.
   * ---------------------------------------------------------------------
   * Window dihitung mundur dari sampel TERBARU (secara TANGGAL) dengan
   * mengakumulasi delta HM antar-sampel; berhenti saat total > `hours`.
   * Pendekatan akumulatif ini tahan terhadap nilai HM yang anomal/outlier.
   * Bila delta HM tidak dapat diandalkan, jatuh ke `fallbackSamples` sampel
   * terakhir (perilaku lama).
   *
   * @param {array}  samples          daftar sampel satu unit
   * @param {number} hours            lebar window (jam), mis. 4000
   * @param {number} [fallbackSamples] jumlah sampel fallback (mis. 5)
   * @returns {array}
   * --------------------------------------------------------------------- */
  function sliceByHours(samples, hours, fallbackSamples) {
    if (!samples || !samples.length) return [];
    var fb = fallbackSamples || 5;
    if (!hours || hours <= 0) return samples.slice(-fb);

    // [FIX] Urutkan dulu KRONOLOGIS (tanggal, tie-break HM) agar anchor =
    // sampel PALING BARU secara tanggal — bukan sampel dgn HM tertinggi yang
    // mungkin anomal/outlier (mis. HM jumbo tapi tanggalnya lama).
    var ord = samples.slice().sort(function (a, b) {
      var da = a._date ? a._date.getTime() : 0;
      var db = b._date ? b._date.getTime() : 0;
      if (da !== db) return da - db;
      return (a._hm || 0) - (b._hm || 0);
    });

    // Hitung mundur dari sampel terbaru dengan AKUMULASI delta HM antar-sampel.
    // Ini lebih tahan-anomali daripada (hmMax - hours): satu lonjakan HM tidak
    // langsung memotong seluruh window.
    var picked = [ord[ord.length - 1]];
    var acc = 0;
    var usable = false;
    for (var i = ord.length - 2; i >= 0; i--) {
      var cur = ord[i], nxt = ord[i + 1];
      var dh = (nxt._hm || 0) - (cur._hm || 0);
      if (dh > 0) { usable = true; acc += dh; }
      if (usable && acc > hours) break;
      picked.push(cur);
    }
    picked.reverse();

    // Bila tidak ada delta HM yang bisa diandalkan -> fallback N sampel terakhir.
    if (!usable) return ord.slice(-Math.max(2, fb));
    if (picked.length < 2) return ord.slice(-Math.max(2, fb));
    return picked;
  }

  /* -----------------------------------------------------------------------
   * Criticality Index (per spec): 0-100
   *   Score = (Severity × 0.45) + (Evidence × 0.30) + (Trend × 0.25)
   * --------------------------------------------------------------------- */
  function calcCriticality(samples, component, model) {
    if (!samples || samples.length === 0) return { score: 0, band: 'NORMAL', axis: { severity: 0, evidence: 0, trend: 0 } };

    var thresholds = cfg.getThresholdsFor(component, model);
    // [A4] Bobot kompartemen memakai getComponentWeight() yang mencocokkan
    // nama secara robust (mis. "SWING" -> "SWING DRIVE") dan lengkap untuk
    // 11 kompartemen. Sebelumnya lookup langsung `pillarWeights[UPPER]`
    // sehingga varian nama/kompartemen di luar 4 pilar jatuh ke 1.0.
    var pillarWeight = cfg.getComponentWeight(component);
    var axes = cfg.CRITICALITY.axes;
    var bands = cfg.CRITICALITY.bands;

    // [REVISI #12] Window FORMULA = hanya sampel dalam N JAM terakhir,
    // dihitung mundur dari Meter/HM TERTINGGI (bukan sekadar N sampel).
    // Bila HM tidak tersedia (semua 0/null), jatuh kembali ke N sampel terakhir.
    var window = sliceByHours(samples, cfg.CRITICALITY.formulaWindowHours, cfg.CRITICALITY.formulaWindowSamples);

    // 1. Severity (45%) — seberapa jauh melebihi limit
    var maxSevRatio = 0;
    var lastSample = window[window.length - 1];
    Object.keys(thresholds).forEach(function (pk) {
      var th = thresholds[pk];
      var v = lastSample[pk];
      if (v === null || v === undefined) return;
      if (th.crit) {
        var ratio = (v - th.crit) / th.crit;
        if (ratio > maxSevRatio) maxSevRatio = ratio;
      }
    });
    var severityVal = Math.min(maxSevRatio * 100, 100);
    if (severityVal < 0) severityVal = 0;

    // 2. Evidence (30%) — berapa sampel berturut-turut abnormal
    var abnormalCount = 0;
    window.forEach(function (s) {
      var eval_ = evaluateSample(s, thresholds);
      if (eval_.tier >= 1) abnormalCount++;
    });
    var evidenceVal = (abnormalCount / window.length) * 100;

    // 3. Trend (25%) — slope keausan per HM
    var trendVal = 0;
    var wearKeys = ['wear_fe', 'wear_cu', 'wear_al'];
    wearKeys.forEach(function (pk) {
      if (window.length >= 2) {
        var row = calcROW100(window[window.length - 1], window[0], pk);
        if (row !== null && row > trendVal) trendVal = row;
      }
    });
    trendVal = Math.min(trendVal * 2, 100); // Normalize: 50 ppm/100h = 100%

    // Weighted score
    var rawScore = (severityVal * axes.severity) + (evidenceVal * axes.evidence) + (trendVal * axes.trend);
    var score = Math.min(rawScore * pillarWeight, 100);
    score = Math.round(score * 10) / 10;

    // [STANDARISASI 2026-10-03] Band 3 level: NORMAL / CAUTION / CRITICAL
    var band = 'NORMAL';
    if (score >= bands.critical) band = 'CRITICAL';
    else if (score >= (bands.caution !== undefined ? bands.caution : bands.warning)) band = 'CAUTION';

    return {
      score: score, band: band,
      axis: {
        severity: Math.round(severityVal * 10) / 10,
        evidence: Math.round(evidenceVal * 10) / 10,
        trend: Math.round(trendVal * 10) / 10
      }
    };
  }

  /* -----------------------------------------------------------------------
   * Run diagnostics — cek semua rule pada sample terakhir
   * ---------------------------------------------------------------------
   * @param {object} sample    sampel (biasanya `latest`)
   * @param {string} [component] nama kompartemen — dipakai agar tindakan
   *   rule yang menyebut komponen (mis. magnetic plug) TIDAK salah konteks.
   * --------------------------------------------------------------------- */
  function runDiagnostics(sample, component) {
    var triggered = [];
    var K = global.SOS_KNOWLEDGE;
    cfg.DIAGNOSTIC_RULES.forEach(function (rule) {
      try {
        if (rule.check(sample)) {
          var action = rule.action;
          // [VALIDASI MAGNETIC PLUG 2026-09-30] Bila rule menyebut "magnetic
          // plug", ganti frasa dengan yang TEPAT sesuai kompartemen (engine
          // tidak punya magnetic plug -> pakai cut-open filter).
          if (component && /magnetic plug/i.test(action) && K && K.particleCheckPhrase) {
            action = action.replace(/[^.]*\bmagnetic plug\b[^.]*\./i, K.particleCheckPhrase(component));
          }
          // [RELEVANSI FILTER 2026-10-01] Placeholder {{PARTICLE_CHECK}} diganti
          // panduan partikel/kebersihan yang SESUAI kompartemen. Untuk FINAL
          // DRIVE / gear case (TANPA elemen filter), panduan menyebut magnetic
          // drain plug + kuras oli — BUKAN "ganti/potong filter" yang tak ada.
          if (action.indexOf('{{PARTICLE_CHECK}}') !== -1) {
            var phrase = (K && K.particleCheckPhrase) ? K.particleCheckPhrase(component) : '';
            if (component && K && K.isFilterless && K.isFilterless(component) && K.filterRelevancePhrase) {
              phrase = K.filterRelevancePhrase(component);
            }
            action = action.replace('{{PARTICLE_CHECK}}', phrase).replace(/\s{2,}/g, ' ').trim();
          }
          triggered.push({
            id: rule.id,
            title: rule.title,
            system: rule.system,
            risk: rule.risk,
            action: action,
          });
        }
      } catch (e) { /* skip rule errors */ }
    });
    return triggered;
  }

  /* -----------------------------------------------------------------------
   * Analyze fleet — proses seluruh sampel, kelompokkan per asset+component
   * Returns: { units: { assetId_component: { ... } }, stats: { ... } }
   * --------------------------------------------------------------------- */
  function analyzeFleet(samples) {
    // [FIX] Pastikan `_hm` = meter mesin (hm_unit) — naik monoton — agar
    // penentuan sampel TERBARU & urutan benar. Data lama (sessionStorage)
    // mungkin masih memakai hm_oil; kita normalkan ulang di sini.
    (samples || []).forEach(function (s) {
      if (s.hm_unit !== null && s.hm_unit !== undefined) s._hm = s.hm_unit;
      else if ((s._hm === null || s._hm === undefined) && s.hm_oil !== null && s.hm_oil !== undefined) s._hm = s.hm_oil;
    });

    // Group by asset_id + component
    var groups = {};
    samples.forEach(function (s) {
      var key = (s.asset_id || 'UNKNOWN') + '||' + (s.component || 'UNKNOWN');
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });

    var units = {};
    var totalSamples = samples.length;
    var tiers = [0, 0, 0]; // [STANDARISASI 2026-10-03] Normal, Caution, Critical
    var models = {};
    var components = {};

    Object.keys(groups).forEach(function (key) {
      var parts = key.split('||');
      var assetId = parts[0];
      var component = parts[1];
      var groupSamples = groups[key];

      // [FIX] Sort KRONOLOGIS: utamakan TANGGAL (sampling date) lalu HM sebagai
      // tie-break. Tanggal lebih andal daripada HM: kolom HM bisa berisi nilai
      // anomali/outlier (mis. HM jauh lebih besar tapi tanggalnya lama) sehingga
      // jika HM dijadikan kunci utama, "sampel terbaru" jadi salah.
      groupSamples.sort(function (a, b) {
        var da = a._date ? a._date.getTime() : 0;
        var db = b._date ? b._date.getTime() : 0;
        if (da !== db) return da - db;
        var ha = (a._hm || 0), hb = (b._hm || 0);
        return ha - hb;
      });

      var latest = groupSamples[groupSamples.length - 1];
      var prev = groupSamples.length >= 2 ? groupSamples[groupSamples.length - 2] : null;

      // [BARU 2026-10-01] MODEL UNIT — dipakai agar threshold yang berlaku
      // mengikuti model (mis. ENGINE HD785 berbeda dari PC2000). Bila model
      // kosong/tanpa override -> otomatis memakai threshold kompartemen.
      var unitModel = latest.model || '';

      // Calculate MPRS
      var mprsResult = calcMPRS(latest, component, unitModel);
      latest.mprs_score = mprsResult.mprs;
      latest.risk_tier = mprsResult.tier;

      // [BARU] Peringkat SOS — dari pelanggaran threshold pada sampel terbaru.
      var rankResult = calcRankScore(latest, component, unitModel);

      // Calculate ROW for Fe
      latest.row_fe_100 = calcROW100(latest, prev, 'wear_fe');

      // Calculate Dirt Entry
      latest.dirt_entry_index = calcDirtEntry(latest);

      // Calculate Criticality (spec formula)
      var criticality = calcCriticality(groupSamples, component, unitModel);

      // Diagnostics
      var diagnostics = runDiagnostics(latest, component);

      // Evaluate all samples — threshold sesuai MODEL unit (bila ada override).
      var thresholds = cfg.getThresholdsFor(component, unitModel);
      groupSamples.forEach(function (s) {
        var ev = evaluateSample(s, thresholds);
        s.risk_tier = ev.tier;
        s._violations = ev.violations;
      });

      tiers[mprsResult.tier]++;
      if (latest.model) models[latest.model] = (models[latest.model] || 0) + 1;
      components[component] = (components[component] || 0) + 1;

      units[key] = {
        assetId: assetId,
        component: component,
        model: latest.model,
        serial: latest.asset_serial,
        jobsite: latest.jobsite,
        samples: groupSamples,
        latest: latest,
        mprs: mprsResult,
        rankScore: rankResult.score,
        rankBreaches: rankResult.breaches,
        rankWorstParam: rankResult.worstParam,
        criticality: criticality,
        diagnostics: diagnostics,
        sampleCount: groupSamples.length,
        hmUnit: latest.hm_unit,
        hmOil: latest.hm_oil,
        lastDate: latest._dateStr,
      };
    });

    return {
      units: units,
      stats: {
        totalSamples: totalSamples,
        uniqueAssets: Object.keys(groups).reduce(function (s, k) { s[k.split('||')[0]] = 1; return s; }, {}),
        tiers: tiers,
        models: models,
        components: components,
      }
    };
  }

  /* -----------------------------------------------------------------------
   * Ringkasan nilai parameter pada JENDELA N sampel terakhir
   * ---------------------------------------------------------------------
   * Untuk setiap parameter (Fe, Cu, Si, PQI, V100, ISO, dst.) hitung:
   *   - last : nilai pada sampel terakhir (default katalog)
   *   - avg  : rata-rata N sampel terakhir
   *   - worst: nilai pada sampel dengan SEVERITY tertinggi (bukan sekadar
   *            max/min). Arah "buruk" ditentukan threshold: sebagian param
   *            high=buruk (wear metal, PQI), sebagian low=buruk (V100, TBN).
   *   - min/max: nilai ekstrem mentah pada jendela
   *
   * @param {object[]} samples  seluruh sampel satu unit (urut HM menaik)
   * @param {string}   component nama kompartemen (untuk threshold)
   * @param {string[]} keys     daftar key parameter yang ingin diringkas
   * @param {number}   [windowN] jumlah sampel jendela (default CRITICALITY.formulaWindowSamples)
   * @returns {object} { paramKey: { last, avg, worst, min, max, n, worstSample } }
   * --------------------------------------------------------------------- */
  function windowStats(samples, component, keys, windowN, model) {
    var out = {};
    if (!samples || !samples.length) return out;
    var thresholds = cfg.getThresholdsFor(component, model);
    var N = windowN || (cfg.CRITICALITY && cfg.CRITICALITY.formulaWindowSamples) || 5;
    // [REVISI #12] Jendela mengikuti 4000 jam terakhir (berbasis Meter/HM),
    // konsisten dengan calcCriticality. Bila HM tak tersedia -> N sampel.
    var window = sliceByHours(samples, cfg.CRITICALITY && cfg.CRITICALITY.formulaWindowHours, N);
    // [FIX] Urutkan window KRONOLOGIS (lama -> baru) berdasarkan tanggal
    // (fallback HM) agar rentang tanggal yang ditampilkan selalu
    // "terlama di kiri – terbaru di kanan", apa pun urutan HM/input.
    window = window.slice().sort(function (a, b) {
      var da = a._date ? a._date.getTime() : 0;
      var db = b._date ? b._date.getTime() : 0;
      if (da !== db) return da - db;
      return (a._hm || 0) - (b._hm || 0);
    });
    var last = samples[samples.length - 1];

    (keys || []).forEach(function (pk) {
      var vals = [];
      for (var i = 0; i < window.length; i++) {
        var v = window[i][pk];
        if (v !== null && v !== undefined && !isNaN(v)) vals.push(v);
      }
      var rec = {
        last: (last && last[pk] !== undefined && last[pk] !== null) ? last[pk] : null,
        avg: vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : null,
        min: vals.length ? Math.min.apply(null, vals) : null,
        max: vals.length ? Math.max.apply(null, vals) : null,
        n: vals.length,
        worst: null,
        worstSample: null,
        // [REVISI] Tanggal window & sampel terburuk — agar UI bisa menampilkan
        // TANGGAL yang menjelaskan asal nilai (rata-rata/worst) sesuai mode.
        firstDate: null,
        lastDate: null
      };

      // Catat tanggal window (sampel pertama & terakhir yang punya data parameter ini).
      for (var k = 0; k < window.length; k++) {
        var wv = window[k][pk];
        if (wv === null || wv === undefined || isNaN(wv)) continue;
        if (!rec.firstDate) rec.firstDate = window[k]._dateStr || null;
        rec.lastDate = window[k]._dateStr || rec.lastDate;
      }

      // Worst = nilai pada sampel dengan severity tertinggi (arah sesuai threshold).
      var th = thresholds[pk];
      var bestSev = -1;
      for (var j = 0; j < window.length; j++) {
        var vv = window[j][pk];
        if (vv === null || vv === undefined || isNaN(vv)) continue;
        var sev = th ? severityScore(vv, th, pk) : (rec.max === vv ? 1 : 0);
        if (sev > bestSev) { bestSev = sev; rec.worst = vv; rec.worstSample = window[j]; }
      }
      if (rec.worst === null && vals.length) {
        // fallback: tanpa threshold -> anggap high=buruk
        rec.worst = rec.max;
      }
      out[pk] = rec;
    });

    // [FIX] Sampel TERBURUK keseluruhan pada window: sampel dengan TOTAL
    // severity tertinggi di antara seluruh parameter yang diminta. Dipakai
    // mode "Terburuk" agar NILAI & TANGGAL berasal dari SATU sampel yang
    // sama (konsisten), bukan campuran beberapa sampel berbeda.
    var worstOverall = null, worstScore = -1;
    window.forEach(function (s) {
      var tot = 0;
      (keys || []).forEach(function (pk) {
        var v = s[pk];
        if (v === null || v === undefined || isNaN(v)) return;
        var th = thresholds[pk];
        tot += th ? severityScore(v, th, pk) : 0;
      });
      if (tot > worstScore) { worstScore = tot; worstOverall = s; }
    });
    // Simpan sebagai properti non-param agar tidak bentrok dgn key parameter.
    out.__worstSample = worstOverall;
    out.__windowFirst = window.length ? (window[0]._dateStr || null) : null;
    out.__windowLast = window.length ? (window[window.length - 1]._dateStr || null) : null;

    return out;
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_ANALYTICS = {
    severityScore: severityScore,
    evaluateSample: evaluateSample,
    calcMPRS: calcMPRS,
    calcRankScore: calcRankScore,
    calcROW100: calcROW100,
    calcDirtEntry: calcDirtEntry,
    calcCriticality: calcCriticality,
    runDiagnostics: runDiagnostics,
    analyzeFleet: analyzeFleet,
    windowStats: windowStats,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_ANALYTICS;
  }
})(typeof window !== 'undefined' ? window : globalThis);

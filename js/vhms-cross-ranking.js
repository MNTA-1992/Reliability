/* =========================================================================
 * vhms-cross-ranking.js
 * -------------------------------------------------------------------------
 * [FLEET COMBINED CONDITION RANKING (VHMS x SOS)]
 * Engine analitik gabungan peringkat kondisi armada terintegrasi antara:
 *   - Telemetri Fisik / Operasional (VHMS)
 *   - Analisa Kimia / Keausan Pelumas (SOS)
 *   - Titik Potong Perbaikan / Overhaul (Component Life)
 *   - Riwayat Ganti Oli (SOS fluid_changed)
 *
 * FORMULA INTI (Rentang Skor 0 - 100):
 *   Combined Score = (0.75 * Score_Current) + (0.25 * Score_History) + Bonus_Synergy
 *
 * KAIDAH INTEGRITAS & FLEET RELIABILITY:
 *   1. Anti-False Permanent Critical: Riwayat meluruh eksponensial (tau = 500 jam).
 *   2. Gerbang Pembatas Riwayat (Gate Rule): Bila kondisi terkini Normal, riwayat
 *      DILARANG mendongkrak status ke CRITICAL (maksimal Watchlist/Monitor <= 45).
 *   3. Reset Event: Penggantian komponen (Lifetime) atau ganti oli (fluid_changed)
 *      membersihkan riwayat pelanggaran lama sehingga unit memulai baseline segar.
 *   4. Sinergi Kerusakan Ganda: Pasangan terkurasi (CURATED_PAIRS) yang sama-sama
 *      abnormal menambah bonus prioritas hingga +20 poin.
 *
 * STATUS BADGE (5 Tingkat):
 *   - ACTIVE CRITICAL   (>= 75, gejala kritis aktif terkini)
 *   - HIGH RISK/CHRONIC (50 - 74, waspada berulang / kronis)
 *   - POST-REPAIR/WATCH (30 - 49, terkini normal pasca-overhaul / reset event)
 *   - MONITOR           (25 - 49, gejala ringan pada satu sumber)
 *   - STABLE/HEALTHY    (< 25, normal sempurna)
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Konfigurasi & Konstanta Utama
   * --------------------------------------------------------------------- */
  var CONFIG = {
    WEIGHT_CURRENT: 0.75,
    WEIGHT_HISTORY: 0.25,
    DECAY_TAU_HOURS: 500,               // Jam operasi untuk reduksi keparahan ~63.2%
    VHMS_WINDOW_HOURS: 2000,            // Jendela evaluasi riwayat VHMS
    SOS_WINDOW_SAMPLES: 5,              // Jumlah sampel lab riwayat SOS
    POST_REPAIR_OBSERVATION_HOURS: 500, // Durasi observasi kestabilan pasca-reset
    SYNERGY_MAX_BONUS: 20,              // Plafon bonus sinergi
    SYNERGY_PAIR_MULTIPLIER: 15,        // Pengali bobot curated pair
    SEVERITY_SATURATION: 1.0,
    SEVERITY_AT_LIMIT: 0.02
  };

  var STATUS_DEFINITIONS = {
    ACTIVE_CRITICAL: {
      code: 'ACTIVE_CRITICAL',
      label: 'ACTIVE CRITICAL',
      badgeClass: 'badge-active-crit',
      color: '#ef4444',
      icon: 'fa-circle-exclamation',
      priority: 1,
      minScore: 75,
      recommendation: 'STOP OPERASI / P1. Segera terbitkan Work Order inspeksi darurat (borescope, filter cut, kalibrasi sensor).'
    },
    HIGH_RISK: {
      code: 'HIGH_RISK',
      label: 'HIGH RISK / CHRONIC',
      badgeClass: 'badge-high-risk',
      color: '#f97316',
      icon: 'fa-triangle-exclamation',
      priority: 2,
      minScore: 50,
      recommendation: 'PRIORITAS SERVIS. Gejala berulang; jadwalkan overhaul terencana sebelum terjadi kerusakan sekunder.'
    },
    /* ---------------------------------------------------------------------
     * POST-REPAIR adalah band BERBASIS KONDISI, BUKAN berbasis skor.
     * -------------------------------------------------------------------
     * ⚠ SPEK §4 MENULIS RENTANG "30 - 49" UNTUK BAND INI, DAN ANGKA ITU
     *   TIDAK DAPAT DICAPAI. Dibuktikan oleh aritmetika kaidah lain yang
     *   ditetapkan spek yang sama:
     *     - Syarat band ini: Kondisi Terkini "Normal / Bersih (Hijau)"
     *     - Kaidah Normalitas (§2.2): terkini normal  ->  Score_Current = 0
     *     - Gate Rule (§2.3.C):       Score_History  <=  45
     *     - calcSynergy:              salah satu normal -> Bonus = 0
     *   Skor MAKSIMUM unit yang memenuhi syarat = 0,75x0 + 0,25x45 = 11,25.
     *   Jadi 30-49 mustahil; menggerbangkan band ini dengan `minScore 30`
     *   akan MEMATIKANNYA TOTAL (terukur: seluruh sapuan riwayat 4,2-60 kPa
     *   menghasilkan skor 11,3 dan status STABLE).
     *
     *   Baris contoh di spek sendiri tidak konsisten: "DZ-003 POST-REPAIR
     *   skor 42,0 / VHMS 12 / SOS 15" — VHMS 12 mustahil bagi unit yang
     *   ditulis "Cool Normal".
     *
     * KEPUTUSAN: badge ini ditentukan oleh KONDISI (terkini bersih DAN baru
     * diservis dalam jendela observasi), bukan oleh ambang skor. `minScore`
     * sengaja 0 agar tidak ada ambang mati yang menyesatkan pembaca kode.
     * Yang mencegahnya menyala untuk seluruh armada adalah jendela
     * kesegaran di `detectResetEvent()` ([FIX B5]/[FIX B6]) — itulah akar
     * masalah sebenarnya, bukan urutan cabang.
     * ------------------------------------------------------------------- */
    POST_REPAIR: {
      code: 'POST_REPAIR',
      label: 'POST-REPAIR / WATCH',
      badgeClass: 'badge-post-repair',
      color: '#3b82f6',
      icon: 'fa-wrench',
      priority: 3,
      minScore: 0,                 // berbasis kondisi — lihat catatan di atas
      scoreBased: false,
      recommendation: 'UNDER OBSERVATION. Komponen baru diganti / diservis. Masuk daftar pantau kestabilan 500 jam pertama.'
    },
    MONITOR: {
      code: 'MONITOR',
      label: 'MONITOR',
      badgeClass: 'badge-monitor',
      color: '#eab308',
      icon: 'fa-eye',
      priority: 4,
      minScore: 25,
      recommendation: 'MONITORING RUTIN. Belum butuh intervensi mekanik, pantau di jadwal servis reguler berikutnya.'
    },
    STABLE: {
      code: 'STABLE',
      label: 'STABLE / HEALTHY',
      badgeClass: 'badge-stable',
      color: '#22c55e',
      icon: 'fa-circle-check',
      priority: 5,
      minScore: 0,
      recommendation: 'UNIT SEHAT. Operasional normal sesuai target utilisasi.'
    }
  };

  /* -----------------------------------------------------------------------
   * [FIX B18 2026-11-13] PLAFON GERBANG RIWAYAT — SATU SUMBER KEBENARAN.
   * ---------------------------------------------------------------------
   * Spek §2.3.C: riwayat murni dibatasi pada "batas atas Zona Watchlist /
   * Monitor". Angkanya DITURUNKAN dari `STATUS_DEFINITIONS`, bukan ditulis
   * ulang sebagai `45` di dua tempat seperti versi pertama. Dengan begini
   * mengubah ambang band otomatis menggeser plafon gerbang, dan keduanya
   * tidak bisa lagi saling bertentangan.
   * --------------------------------------------------------------------- */
  var HISTORY_GATE_CAP = STATUS_DEFINITIONS.HIGH_RISK.minScore - 5;   // 50 - 5 = 45

  /* Cache hasil armada — lihat [FIX B19] di `calcFleetRanking()`. */
  var _fleetCache = null;
  function invalidateCache() { _fleetCache = null; }

  /* -----------------------------------------------------------------------
   * Utilitas Numerik & Masking
   * --------------------------------------------------------------------- */
  function toNum(v) {
    if (v === null || v === undefined || isNaN(v)) return null;
    return typeof v === 'number' ? v : parseFloat(v);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function normStr(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()]+/g, '').trim();
  }

  /* -----------------------------------------------------------------------
   * [FIX B7 2026-11-13] JAM METER SAMPEL — `0` ADALAH ANGKA SAH.
   * ---------------------------------------------------------------------
   * Versi pertama memakai `toNum(s.hm_unit) || toNum(s._hm)`. Operator `||`
   * menolak `0`, dan `hm_unit = 0` SAH untuk unit baru / meter yang baru
   * di-reset. Akibatnya nilai diganti `_hm` — yaitu JAM OLI, besaran yang
   * BERBEDA. Terukur: sampel `{hm_unit: 0, _hm: 7777}` membuat SMR unit
   * terbaca 7.777 jam di tabel, CSV, dan sumbu peluruhan riwayat.
   *
   * Kaidah di bawah memeriksa keberadaan secara eksplisit dan menandai
   * besaran mana yang dipakai, sehingga pemanggil tidak perlu menebak.
   *
   * @returns {{value:number|null, basis:'unit'|'oil'|null}}
   * --------------------------------------------------------------------- */
  function sampleMeterOf(s) {
    if (!s) return { value: null, basis: null };
    var hu = toNum(s.hm_unit);
    if (hu !== null) return { value: hu, basis: 'unit' };
    var ho = toNum(s._hm);
    if (ho !== null) return { value: ho, basis: 'oil' };
    return { value: null, basis: null };
  }

  /** Jam meter unit sebuah sampel SOS; `null` bila tidak ada sama sekali. */
  function sampleMeter(s) {
    return sampleMeterOf(s).value;
  }

  /** Penanda ganti oli pada satu sampel SOS (`fluid_changed = 'Y'`). */
  function isFluidChanged(s) {
    if (!s) return false;
    return String(s.fluid_changed == null ? '' : s.fluid_changed).trim().toUpperCase() === 'Y';
  }

  /**
   * Pilar VHMS untuk sebuah nama kompartemen SOS/Lifetime.
   * Memakai `COMPONENT_LIFE.canonComp()` + `PILLAR_OF_COMPONENT` agar
   * penamaan ("FINAL DRIVE LH REAR" vs "FINAL DRIVE REAR LEFT") dikanonkan
   * oleh satu sumber kebenaran, bukan oleh `indexOf()` di modul ini.
   */
  function pillarOfComponent(component) {
    var cl = global.COMPONENT_LIFE;
    if (!cl || !cl.canonComp || !cl.PILLAR_OF_COMPONENT) return 'OTHER';
    try {
      var c = cl.canonComp(component);
      return cl.PILLAR_OF_COMPONENT[c.fam] || 'OTHER';
    } catch (e) { return 'OTHER'; }
  }

  /* -----------------------------------------------------------------------
   * [FIX B2 2026-11-13] PEMBACAAN YANG MENGHORMATI GERBANG KUALITAS DATA.
   * ---------------------------------------------------------------------
   * `VHMS_VALIDATE.applyFaultMask()` menandai `record._masked[key]` untuk
   * nilai yang berasal dari sensor yang SEDANG RUSAK (mis. fault `DGT6KA` —
   * Exhaust temp. sensor R failure). Sesuai README §6.3 nilai TETAP TAMPIL
   * di tabel/chart, tetapi TIDAK BOLEH dipakai sebagai dasar keputusan.
   *
   * MASALAH YANG DIPERBAIKI. Versi pertama modul ini membaca `rec[pk]`
   * LANGSUNG. Terukur: satu record `blowbyMax` 99 kPa yang ditandai
   * `_masked` membuat unit yang sehat terbaca ACTIVE CRITICAL dengan skor
   * 100, sementara `VHMS_RANKING.lastValueOf()` pada deret yang SAMA
   * mengembalikan 1,5 kPa (nilai sah terakhir). Dua halaman melaporkan
   * status berbeda untuk unit yang sama — persis kelas cacat yang sudah
   * diperbaiki dua kali di proyek ini (`vhms-ranking.js:433`,
   * `vhms-analytics.js:250`).
   *
   * ⚠ SELURUH pembacaan nilai parameter VHMS di modul ini WAJIB lewat sini.
   * --------------------------------------------------------------------- */
  function maskedValueOf(rec, key) {
    if (!rec) return null;
    if (rec._masked && rec._masked[key]) return null;
    var v = rec[key];
    return (v === null || v === undefined || isNaN(v)) ? null : v;
  }

  /* -----------------------------------------------------------------------
   * [FIX B8 2026-11-13] CAKUPAN PARAMETER = `RANKING_WEIGHTS`, BUKAN
   * SELURUH KEY `THRESHOLDS`.
   * ---------------------------------------------------------------------
   * `VHMS_CONFIG.THRESHOLDS` memuat 59 parameter, `RANKING_WEIGHTS` hanya
   * 53. Enam-sembilan selisihnya (mis. `tmOilTempMax`, `lbfExhTempMax`,
   * `rbrExhTempMax`) punya ambang untuk BADGE/TABEL tetapi SENGAJA tidak
   * diberi bobot peringkat — lihat catatan di `vhms-config.js`.
   *
   * Versi pertama modul ini menskor seluruh key `THRESHOLDS` dan hanya
   * menyimpan `weights` sebagai variabel mati, sehingga parameter yang
   * sengaja dikecualikan dari peringkat resmi bisa menjatuhkan unit di
   * peringkat gabungan. Gerbang di bawah menyatukan kembali cakupannya.
   * --------------------------------------------------------------------- */
  function isScorableParam(pk, weights) {
    if (pk === 'smr' || pk === 'calendar') return false;
    if (!weights || !Object.keys(weights).length) return true;   // konfigurasi tak tersedia
    var w = weights[pk];
    return (w !== undefined && w !== null && w > 0);
  }

  /** Label manusiawi sebuah parameter VHMS (sumber: `VHMS_CONFIG.PARAMS`). */
  function paramLabel(pk) {
    var vcfg = global.VHMS_CONFIG || {};
    var def = vcfg.PARAMS && vcfg.PARAMS[pk];
    return (def && def.label) ? def.label : pk;
  }

  /**
   * [FIX B9 2026-11-13] Gerbang kelayakan jendela — DIPINJAM dari
   * `VHMS_ANALYTICS.hasAdequateSpan()`, tidak disalin.
   *
   * `vhms-ranking.js` [P0-2] memasang gerbang ini karena `estimateRUL()`
   * menolak jendela < 50 jam sementara skor tetap dihitung dari jendela
   * 0,4 jam — "RUL tidak tahu, peringkat paling kritis". Terukur pada modul
   * ini sebelum perbaikan: dua record berjarak 0,4 jam SMR menghasilkan
   * skor 77,9 / ACTIVE CRITICAL.
   *
   * Dipakai HANYA untuk komponen RIWAYAT (akumulasi lintas waktu). Kondisi
   * TERKINI tetap dinilai apa adanya: satu pembacaan di atas ambang kritis
   * adalah fakta sekarang, bukan kesimpulan atas tren.
   */
  function spanAdequate(records, paramKey) {
    var mod = global.VHMS_ANALYTICS;
    if (!mod || typeof mod.hasAdequateSpan !== 'function') return true;
    return !!mod.hasAdequateSpan(records, paramKey);
  }

  /* -----------------------------------------------------------------------
   * [FIX B12 2026-11-13] SATUAN EPOCH: Lifetime memakai MILIDETIK
   * (`Date.getTime()`), `vhms-parser` menulis `calendar.epoch` dalam DETIK.
   * Pola normalisasi ini meniru `_calEpochMs()` di `component-life.js:525`,
   * yang dibuat setelah bug "1970 < 2025 selalu benar" terjadi di sana.
   * --------------------------------------------------------------------- */
  function epochMs(v) {
    var e = toNum(v);
    if (e === null) return null;
    return e < 1e11 ? e * 1000 : e;   // < 1e11 hampir pasti DETIK
  }

  /** Epoch (ms) sebuah record VHMS dari `calendar`. */
  function recordEpochMs(rec) {
    if (!rec || !rec.calendar) return null;
    var c = rec.calendar;
    if (c.date && typeof c.date.getTime === 'function' && !isNaN(c.date.getTime())) {
      return c.date.getTime();
    }
    return epochMs(c.epoch);
  }

  /**
   * Apakah sebuah record berada SESUDAH titik potong pemasangan komponen?
   *
   * `cut` = { smr, dateMs, basis }. Record yang tidak dapat ditempatkan pada
   * sumbu titik potong (mis. tanpa SMR saat basis 'hm') DITERIMA — menolaknya
   * akan membuang data sah hanya karena satu kolom kosong, dan
   * `component-life.js` memakai kaidah yang sama (`cut` butuh nilai yang ada).
   */
  function afterCut(rec, cut) {
    if (!rec || !cut) return true;
    if (cut.basis === 'date' && cut.dateMs !== null && cut.dateMs !== undefined) {
      var t = recordEpochMs(rec);
      return (t === null) ? true : (t >= cut.dateMs);
    }
    if (cut.smr !== null && cut.smr !== undefined) {
      var smr = toNum(rec.smr);
      return (smr === null) ? true : (smr >= cut.smr);
    }
    return true;
  }

  /* -----------------------------------------------------------------------
   * 1. Evaluasi Kondisi VHMS Terkini (Score_VHMS-Current: 0 - 100)
   * --------------------------------------------------------------------- */
  function calcVhmsCurrent(analysis, opts) {
    opts = opts || {};
    if (!analysis) {
      return { score: 0, status: 'NORMAL', isNormal: true, worstParam: null, worstScore: 0, params: [] };
    }

    var records = analysis.records || [];
    var summary = analysis.summary || {};
    var vcfg = global.VHMS_CONFIG || {};
    var thresholds = analysis.thresholdSet || vcfg.THRESHOLDS || {};
    var weights = vcfg.RANKING_WEIGHTS || {};
    var pillars = vcfg.RANKING_PILLARS || {};
    var pillarWeights = vcfg.RANKING_PILLAR_WEIGHTS || {};

    if (!records.length && Object.keys(summary).length === 0) {
      return { score: 0, status: 'NORMAL', isNormal: true, worstParam: null, worstScore: 0, params: [] };
    }

    // Titik potong per pilar (hasil `detectResetEvent`) — parameter pilar yang
    // komponennya baru dipasang hanya dinilai dari data SESUDAH pemasangan.
    var pillarCuts = opts.pillarCuts || {};

    // Ambil pembacaan terakhir yang valid untuk setiap parameter
    var paramResults = [];
    var maxParamScore = 0;
    var worstParam = null;
    var breachCount = 0;
    var critCount = 0;

    Object.keys(thresholds).forEach(function (pk) {
      var th = thresholds[pk];
      if (!th) return;
      // [FIX B8] Hanya parameter yang punya bobot peringkat resmi.
      if (!isScorableParam(pk, weights)) return;

      var pillar = pillars[pk] || 'OTHER';
      var cut = pillarCuts[pillar] || null;

      /* [FIX B2] Nilai terakhir DIBACA LEWAT `maskedValueOf`, dan diambil
       * dari `records` — BUKAN dari `summary.last`. Dua sebab:
       *   1. `summary` dari `VHMS_ANALYTICS.summarize()` tidak menghormati
       *      `_masked` (ia memetakan `r[key]` langsung), jadi memakainya
       *      akan memasukkan kembali nilai sensor rusak lewat pintu lain.
       *   2. `summary` dihitung atas SELURUH deret, sehingga tidak dapat
       *      dipotong pada titik pemasangan komponen ([FIX B3]).
       * `summary` tetap dipakai sebagai cadangan terakhir bila record kosong
       * (mis. unit yang hanya punya ringkasan dari berkas pelengkap). */
      var latest = null;
      for (var i = records.length - 1; i >= 0; i--) {
        if (cut && !afterCut(records[i], cut)) continue;
        var val = maskedValueOf(records[i], pk);
        if (val !== null) { latest = val; break; }
      }
      if (latest === null && !records.length) {
        var s = summary[pk];
        if (s && s.last !== undefined && s.last !== null) latest = toNum(s.last);
      }

      if (latest === null) return;

      var mode = th.mode || 'high';
      var warn = toNum(th.warn);
      var crit = toNum(th.crit);
      var pw = (pillarWeights[pillar] !== undefined) ? pillarWeights[pillar] : 1.0;

      var paramScore = 0;
      var status = 'NORMAL';

      if (mode === 'low') {
        if (crit !== null && latest <= crit) {
          status = 'CRITICAL';
          critCount++;
          breachCount++;
          var ratio = (crit - latest) / Math.max(1e-9, Math.abs(crit));
          paramScore = 60 + 40 * clamp(ratio, 0, 1);
        } else if (warn !== null && crit !== null && latest <= warn) {
          status = 'CAUTION';
          breachCount++;
          var cRatio = (warn - latest) / Math.max(1e-9, warn - crit);
          paramScore = 21 + 38 * clamp(cRatio, 0, 1);
        }
      } else {
        if (crit !== null && latest >= crit) {
          status = 'CRITICAL';
          critCount++;
          breachCount++;
          var hRatio = (latest - crit) / Math.max(1e-9, Math.abs(crit));
          paramScore = 60 + 40 * clamp(hRatio, 0, 1);
        } else if (warn !== null && crit !== null && latest >= warn) {
          status = 'CAUTION';
          breachCount++;
          var hWarnRatio = (latest - warn) / Math.max(1e-9, crit - warn);
          paramScore = 21 + 38 * clamp(hWarnRatio, 0, 1);
        }
      }

      // Kalikan sedikit dengan bobot pilar bila pilar dominan (mis. ENGINE pw=2)
      if (paramScore > 0 && pw > 1) {
        paramScore = clamp(paramScore * (1 + (pw - 1) * 0.15), 0, 100);
      }

      var res = {
        // [FIX B1] Label dari `VHMS_CONFIG.PARAMS[pk].label` — `PARAM_META`
        // TIDAK ADA di modul config, sehingga versi pertama selalu jatuh ke
        // key mentah dan operator membaca "blowbyMax", bukan "Blowby Press Max".
        param: pk,
        label: paramLabel(pk),
        value: latest,
        warn: warn,
        crit: crit,
        mode: mode,
        pillar: pillar,
        score: Math.round(paramScore * 10) / 10,
        status: status
      };
      paramResults.push(res);

      if (paramScore > maxParamScore) {
        maxParamScore = paramScore;
        worstParam = res;
      }
    });

    // Kaidah Normalitas: Jika seluruh parameter VHMS pada data terkini berada
    // di bawah ambang waspada (Normal/Green), maka Score_VHMS-Current = 0.
    if (breachCount === 0) {
      return {
        score: 0,
        status: 'NORMAL',
        isNormal: true,
        worstParam: null,
        worstScore: 0,
        breachCount: 0,
        critCount: 0,
        params: paramResults
      };
    }

    // Compound bonus bila multi-parameter menyala bersamaan
    var breadthBonus = breachCount > 1 ? Math.min(15, (breachCount - 1) * 3) : 0;
    var totalScore = clamp(maxParamScore + breadthBonus, 0, 100);

    var overallStatus = critCount > 0 ? 'CRITICAL' : (totalScore >= 50 ? 'CAUTION' : (totalScore >= 20 ? 'MONITOR' : 'NORMAL'));

    return {
      score: Math.round(totalScore * 10) / 10,
      status: overallStatus,
      isNormal: false,
      worstParam: worstParam,
      worstScore: Math.round(maxParamScore * 10) / 10,
      breachCount: breachCount,
      critCount: critCount,
      params: paramResults
    };
  }

  /* -----------------------------------------------------------------------
   * 2. Evaluasi Kondisi SOS Terkini (Score_SOS-Current: 0 - 100)
   * --------------------------------------------------------------------- */
  function calcSosCurrent(sosUnits, opts) {
    opts = opts || {};
    if (!sosUnits || !sosUnits.length) {
      return { score: 0, tier: 0, status: 'NORMAL', isNormal: true, worstComp: null, worstSample: null, compScores: [] };
    }

    var sanal = global.SOS_ANALYTICS || {};
    var scfg = global.SOS_CONFIG || {};

    var compScores = [];
    var maxScore = 0;
    var worstComp = null;
    var worstSample = null;
    var highestTier = 0;
    var totalBreaches = 0;

    var pillarCuts = opts.pillarCuts || {};

    sosUnits.forEach(function (u) {
      var samples = u.samples || [];
      if (!samples.length) return;

      /* Sampel paling mutakhir. [FIX B3] Bila kompartemen ini punya titik
       * potong pemasangan komponen, sampel dari era SEBELUMNYA dilewati —
       * `u.latest` tidak dapat dipakai langsung karena ia tidak sadar cut. */
      var cut = pillarCuts[pillarOfComponent(u.component)] || null;
      var latest = null;
      if (cut && cut.smr !== null && cut.smr !== undefined) {
        for (var li = samples.length - 1; li >= 0; li--) {
          var lm = sampleMeter(samples[li]);
          if (lm === null || lm >= cut.smr) { latest = samples[li]; break; }
        }
      } else {
        latest = u.latest || samples[samples.length - 1];
      }
      if (!latest) return;

      var component = u.component || latest.component || 'UNKNOWN';
      var model = u.model || latest.model || '';

      var mprsRes = sanal.calcMPRS ? sanal.calcMPRS(latest, component, model) : null;
      var tier = mprsRes ? mprsRes.tier : 0;
      var mprs = mprsRes ? mprsRes.mprs : 0;
      var maxSev = mprsRes ? mprsRes.maxSeverity : 0;
      var breaches = mprsRes ? mprsRes.breachCount : 0;

      // Normalisasi skor 0 - 100 berbasis Severity Tier & MPRS:
      // Tier 0 (Normal): 0 – 20
      // Tier 1 (Caution): 21 – 59
      // Tier 2 (Critical): 60 – 100
      var cScore = 0;
      if (tier >= 2 || maxSev >= 2) {
        cScore = 60 + 40 * clamp((mprs - 20) / 30, 0, 1);
        if (maxSev > 2) cScore = Math.max(cScore, 75);
      } else if (tier === 1 || maxSev >= 1) {
        cScore = 21 + 38 * clamp((mprs - 3) / 17, 0, 1);
      } else {
        cScore = clamp(mprs * 3, 0, 20);
      }

      // Check ganti oli pada sampel terakhir
      var fluidChanged = String(latest.fluid_changed || '').trim().toUpperCase() === 'Y';

      var cEntry = {
        component: component,
        model: model,
        sample: latest,
        sampleDate: latest.sampled_date || latest.lab_date || null,
        sampleMeter: sampleMeter(latest),               // [FIX B7] 0 = angka sah
        sampleMeterBasis: sampleMeterOf(latest).basis,  // 'unit' | 'oil' | null
        tier: tier,
        mprs: mprs,
        maxSeverity: maxSev,
        score: Math.round(cScore * 10) / 10,
        fluidChanged: fluidChanged,
        breachCount: breaches
      };
      compScores.push(cEntry);

      if (tier > highestTier) highestTier = tier;
      totalBreaches += breaches;

      if (cScore > maxScore) {
        maxScore = cScore;
        worstComp = component;
        worstSample = latest;
      }
    });

    if (compScores.length === 0) {
      return { score: 0, tier: 0, status: 'NORMAL', isNormal: true, worstComp: null, worstSample: null, compScores: [] };
    }

    // Kaidah Normalitas SOS: Bila tier tertinggi 0 dan mprs mendekati 0
    var isNormal = highestTier === 0 && maxScore <= 20;
    var finalScore = isNormal ? Math.min(maxScore, 20) : clamp(maxScore, 0, 100);
    var status = highestTier >= 2 ? 'CRITICAL' : (highestTier === 1 ? 'CAUTION' : 'NORMAL');

    return {
      score: Math.round(finalScore * 10) / 10,
      tier: highestTier,
      status: status,
      isNormal: isNormal,
      worstComp: worstComp,
      worstSample: worstSample,
      compScores: compScores,
      totalBreaches: totalBreaches
    };
  }

  /* -----------------------------------------------------------------------
   * 3. Evaluasi Riwayat Kronis dengan Peluruhan Eksponensial
   *    (Score_History: 0 - 100 — Bobot 25%)
   * --------------------------------------------------------------------- */
  function calcHistoryDecayed(analysis, sosUnits, opts) {
    opts = opts || {};
    var tau = opts.tauHours || CONFIG.DECAY_TAU_HOURS;
    var vWindow = opts.vhmsWindowHours || CONFIG.VHMS_WINDOW_HOURS;
    var sWindowSamples = opts.sosWindowSamples || CONFIG.SOS_WINDOW_SAMPLES;
    var pillarCuts = opts.pillarCuts || {};

    var vcfg = global.VHMS_CONFIG || {};
    var thresholds = (analysis && analysis.thresholdSet) || vcfg.THRESHOLDS || {};
    var weights = vcfg.RANKING_WEIGHTS || {};
    var pillars = vcfg.RANKING_PILLARS || {};
    var records = (analysis && analysis.records) || [];

    var currentSmr = null;
    for (var ci = records.length - 1; ci >= 0; ci--) {
      var cv = toNum(records[ci].smr);
      if (cv !== null) { currentSmr = cv; break; }
    }

    // --- A. Evaluasi Riwayat VHMS ---
    var vhmsPeakDecayed = 0;
    var vhmsBreachFound = false;
    var spanSkipped = [];

    if (records.length && currentSmr !== null) {
      var minSmrWindow = currentSmr - vWindow;

      /* [FIX B8/B9] Parameter yang diperiksa ditentukan SEKALI di luar loop
       * record: hanya yang punya bobot peringkat resmi DAN jendelanya layak
       * disimpulkan. Gerbang `spanAdequate` dipakai di sini (bukan di
       * kondisi terkini) karena riwayat adalah pernyataan tentang RENTANG
       * waktu — dua record berjarak 0,4 jam tidak menyusun riwayat apa pun. */
      var histKeys = [];
      Object.keys(thresholds).forEach(function (pk) {
        if (!thresholds[pk]) return;
        if (!isScorableParam(pk, weights)) return;
        if (!spanAdequate(records, pk)) { spanSkipped.push(pk); return; }
        histKeys.push(pk);
      });

      for (var rIdx = records.length - 1; rIdx >= 0; rIdx--) {
        var rec = records[rIdx];
        var rSmr = toNum(rec.smr);
        if (rSmr === null) continue;
        if (rSmr < minSmrWindow) break; // Luar sliding window

        var deltaHm = Math.max(0, currentSmr - rSmr);
        var decay = Math.exp(-deltaHm / tau);

        // Uji tiap parameter terhadap ambang batas
        histKeys.forEach(function (pk) {
          var th = thresholds[pk];

          /* [FIX B3] Titik potong diterapkan PER PILAR, bukan global.
           * `component-life.js` sengaja memetakan komponen -> pilar
           * (`PILLAR_OF_COMPONENT`) lalu me-null-kan HANYA parameter pilar
           * itu (`applyVhmsPillarCut`). Versi pertama modul ini memakai satu
           * `cutSmr` = max(seluruh komponen), sehingga penggantian FINAL
           * DRIVE (POWERTRAIN) menghapus riwayat ENGINE. */
          var pillar = pillars[pk] || 'OTHER';
          var cut = pillarCuts[pillar];
          if (cut && !afterCut(rec, cut)) return;

          // [FIX B2] Nilai dari sensor ter-mask TIDAK menyusun riwayat.
          var val = maskedValueOf(rec, pk);
          if (val === null) return;

          var mode = th.mode || 'high';
          var warn = toNum(th.warn);
          var crit = toNum(th.crit);
          var severity = 0;

          if (mode === 'low') {
            if (crit !== null && val <= crit) {
              severity = 60 + 40 * clamp((crit - val) / Math.max(1e-9, Math.abs(crit)), 0, 1);
            } else if (warn !== null && crit !== null && val <= warn) {
              severity = 21 + 38 * clamp((warn - val) / Math.max(1e-9, warn - crit), 0, 1);
            }
          } else {
            if (crit !== null && val >= crit) {
              severity = 60 + 40 * clamp((val - crit) / Math.max(1e-9, Math.abs(crit)), 0, 1);
            } else if (warn !== null && crit !== null && val >= warn) {
              severity = 21 + 38 * clamp((val - warn) / Math.max(1e-9, crit - warn), 0, 1);
            }
          }

          if (severity > 0) {
            vhmsBreachFound = true;
            var decayedSev = severity * decay;
            if (decayedSev > vhmsPeakDecayed) {
              vhmsPeakDecayed = decayedSev;
            }
          }
        });
      }
    }

    // --- B. Evaluasi Riwayat SOS ---
    var sosPeakDecayed = 0;
    var sosBreachFound = false;
    var sanal = global.SOS_ANALYTICS || {};

    (sosUnits || []).forEach(function (u) {
      var samples = u.samples || [];
      if (!samples.length) return;

      // Bila fluid_changed terdeteksi di sampel paling akhir / kedua terakhir,
      // riwayat keausan era oli SEBELUMNYA tidak lagi menjadi acuan.
      var lastIdx = samples.length - 1;
      var lastSample = samples[lastIdx];
      var prevSample = lastIdx > 0 ? samples[lastIdx - 1] : null;

      var recentDrain = isFluidChanged(lastSample) || isFluidChanged(prevSample);

      // Titik potong SOS mengikuti pilar kompartemen sampel itu sendiri.
      var sosCut = pillarCuts[pillarOfComponent(u.component)] || null;

      var sampleSubset = samples.slice(-sWindowSamples);

      for (var sIdx = sampleSubset.length - 1; sIdx >= 0; sIdx--) {
        var s = sampleSubset[sIdx];
        if (!s) continue;

        // [FIX B7] `0` adalah jam meter yang sah — jangan ditolak oleh `||`.
        var sMeter = sampleMeter(s);
        if (sosCut && sosCut.smr !== null && sosCut.smr !== undefined &&
            sMeter !== null && sMeter < sosCut.smr) continue;

        // Jika baru ganti oli dan kita berada di sampel sebelum ganti oli: lewati
        if (recentDrain && sIdx < sampleSubset.length - 1) {
          if (isFluidChanged(sampleSubset[sIdx + 1])) break;
        }

        var deltaHmSos = 0;
        if (currentSmr !== null && sMeter !== null) {
          deltaHmSos = Math.max(0, currentSmr - sMeter);
        } else if (sampleSubset.length > 1) {
          deltaHmSos = (sampleSubset.length - 1 - sIdx) * 250; // taksiran konservatif bila meter absen
        }

        var decaySos = Math.exp(-deltaHmSos / tau);
        var mprsRes = sanal.calcMPRS ? sanal.calcMPRS(s, u.component, u.model) : null;
        var tier = mprsRes ? mprsRes.tier : 0;
        var mprs = mprsRes ? mprsRes.mprs : 0;
        var maxSev = mprsRes ? mprsRes.maxSeverity : 0;

        var sSev = 0;
        if (tier >= 2 || maxSev >= 2) {
          sSev = 60 + 40 * clamp((mprs - 20) / 30, 0, 1);
        } else if (tier === 1 || maxSev >= 1) {
          sSev = 21 + 38 * clamp((mprs - 3) / 17, 0, 1);
        }

        if (sSev > 0) {
          sosBreachFound = true;
          var decayedSosSev = sSev * decaySos;
          if (decayedSosSev > sosPeakDecayed) {
            sosPeakDecayed = decayedSosSev;
          }
        }
      }
    });

    /* ---------------------------------------------------------------------
     * [FIX B16 2026-11-13] RIWAYAT DIGABUNG DENGAN **MAKSIMUM**, BUKAN
     * RATA-RATA 50/50.
     * -------------------------------------------------------------------
     * MASALAH. Versi pertama memakai `0,5·vhms + 0,5·sos` tanpa syarat.
     * Terukur: riwayat VHMS ekstrem (puncak 100 setelah peluruhan) ENCER
     * menjadi 50 hanya karena kompartemen olinya bersih. Pelanggaran yang
     * SAMA PARAHNYA memberi skor berbeda tergantung berapa banyak sumber
     * yang kebetulan terbaca — pola DILUSI yang sudah dibuang dari
     * `vhms-ranking.js` [FIX B4 2026-10-26] dan dari `sos-analytics.js`
     * [P1-4]. `Score_Current` sudah punya fallback sumber tunggal;
     * `Score_History` tidak, dan itu tidak konsisten.
     *
     * KAIDAH SEKARANG: riwayat = pelanggaran TERBURUK yang masih tersisa
     * setelah peluruhan, dari sumber mana pun. Satu sumber yang bersih
     * TIDAK meringankan bukti dari sumber lain; ia hanya tidak menambah.
     * Rincian per sumber tetap dilaporkan agar dapat ditelusuri.
     * ------------------------------------------------------------------- */
    var rawHistoryScore = Math.max(vhmsPeakDecayed, sosPeakDecayed);

    return {
      score: Math.round(rawHistoryScore * 10) / 10,
      vhmsPeakDecayed: Math.round(vhmsPeakDecayed * 10) / 10,
      sosPeakDecayed: Math.round(sosPeakDecayed * 10) / 10,
      hasBreach: vhmsBreachFound || sosBreachFound,
      spanSkipped: spanSkipped,
      source: (vhmsPeakDecayed >= sosPeakDecayed) ? 'VHMS' : 'SOS'
    };
  }

  /* -----------------------------------------------------------------------
   * 4. Bonus Sinergi Kerusakan Ganda (Bonus_Synergy: 0 - 20 Poin)
   * --------------------------------------------------------------------- */
  function calcSynergy(vhmsCurrent, sosCurrent, analysis, sosUnits) {
    if (!vhmsCurrent || !sosCurrent || vhmsCurrent.isNormal || sosCurrent.isNormal) {
      return { bonus: 0, activePairs: [] };
    }

    var crossMod = global.VHMS_CROSS || {};
    var curatedPairs = crossMod.CURATED_PAIRS || [];
    var vcfg = global.VHMS_CONFIG || {};
    var scfg = global.SOS_CONFIG || {};
    var thresholdsV = (analysis && analysis.thresholdSet) || vcfg.THRESHOLDS || {};

    var activePairs = [];
    var totalBonus = 0;

    // Kumpulkan status breach parameter VHMS saat ini
    var vhmsBreachMap = {};
    (vhmsCurrent.params || []).forEach(function (p) {
      if (p.status === 'CRITICAL' || p.status === 'CAUTION') {
        vhmsBreachMap[p.param] = p;
      }
    });

    // Kumpulkan sampel SOS terbaru
    var latestSamples = (sosCurrent.compScores || []).map(function (cs) {
      return { comp: cs.component, sample: cs.sample, model: cs.model };
    });

    curatedPairs.forEach(function (pair) {
      var vParam = pair.vhms;
      var sParam = pair.sos;
      var weight = pair.weight || 0.8;

      var vBreach = vhmsBreachMap[vParam];
      if (!vBreach) return;

      // Cek apakah ada sampel SOS yang melanggar parameter SOS terkait
      var sBreached = false;
      var sVal = null;
      var sTh = null;

      for (var i = 0; i < latestSamples.length; i++) {
        var ls = latestSamples[i];
        if (!ls.sample) continue;

        var sth = scfg.getThresholdsFor ? scfg.getThresholdsFor(ls.comp, ls.model) : {};
        var targetTh = sth[sParam];
        var val = toNum(ls.sample[sParam]);
        if (val === null || !targetTh) continue;

        // Evaluasi breach SOS
        if (targetTh.warn !== undefined && val >= targetTh.warn) {
          sBreached = true; sVal = val; sTh = targetTh; break;
        }
        if (targetTh.warn_high !== undefined && val >= targetTh.warn_high) {
          sBreached = true; sVal = val; sTh = targetTh; break;
        }
        if (targetTh.warn_low !== undefined && val <= targetTh.warn_low) {
          sBreached = true; sVal = val; sTh = targetTh; break;
        }
      }

      if (sBreached) {
        var pairBonus = weight * CONFIG.SYNERGY_PAIR_MULTIPLIER;
        totalBonus += pairBonus;
        activePairs.push({
          pair: pair,
          vhmsParam: vParam,
          vhmsVal: vBreach.value,
          sosParam: sParam,
          sosVal: sVal,
          hypothesis: pair.hypothesis,
          pillar: pair.pillar,
          bonus: pairBonus
        });
      }
    });

    var finalBonus = Math.min(CONFIG.SYNERGY_MAX_BONUS, totalBonus);
    return {
      bonus: Math.round(finalBonus * 10) / 10,
      activePairs: activePairs
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Deteksi Maintenance Reset Event (Overhaul / Oil Drain)
   * ---------------------------------------------------------------------
   * [FIX B3/B13/B14 2026-11-13] Tiga pagar yang sebelumnya hilang:
   *
   *  B3 — TITIK POTONG PER PILAR. `component-life.js` memetakan komponen
   *       ke pilar (`PILLAR_OF_COMPONENT`) dan me-null-kan HANYA parameter
   *       pilar itu. Versi pertama modul ini memakai satu `cutSmr` global =
   *       max(seluruh komponen), sehingga penggantian FINAL DRIVE
   *       (POWERTRAIN) ikut menghapus riwayat ENGINE.
   *
   *  B13 — PAGAR KERANGKA HM (`frameDelta`). Lifetime dari SAP dapat
   *       memakai kerangka HM yang BERBEDA dari SMR telemetri. Terukur:
   *       `installHM = 98.800` pada unit ber-SMR 5.000 memotong SELURUH
   *       riwayat. `component-life.js` menolak potong-berbasis-HM bila
   *       selisih kerangka melebihi `HM_FRAME_TOLERANCE_HOURS` (500 jam) —
   *       pagar itu kini dipakai di sini juga.
   *
   *  B14 — TECO PALSU. `installPointOf()` menandai `tecoSuspect` saat WO
   *       ter-TECO di SAP tanpa penggantian nyata, dan dalam keadaan itu
   *       `pt.date` sengaja di-null-kan. Basisnya kini dicatat & dilaporkan
   *       sehingga "benar-benar diganti" dapat dibedakan dari "hanya TECO
   *       administratif".
   * --------------------------------------------------------------------- */
  function detectResetEvent(lambung, analysis, sosUnits) {
    var compLife = global.COMPONENT_LIFE;
    var portStore = global.PORTFOLIO_STORE;

    var hasOverhaulReset = false;
    var overhaulDetails = [];
    var pillarCuts = {};          // { PILLAR: { smr, dateMs, basis, component } }
    var hoursSinceReset = null;
    var frameDelta = null;
    var frameRejected = [];       // komponen yang cut-nya DIBATALKAN pagar kerangka

    var records = (analysis && analysis.records) || [];
    var currentSmr = null;
    for (var ci = records.length - 1; ci >= 0; ci--) {
      var cvv = toNum(records[ci].smr);
      if (cvv !== null) { currentSmr = cvv; break; }
    }

    // A. Penggantian Komponen (Lifetime)
    if (compLife && portStore && portStore.getLifetime && lambung) {
      var lifeRows = portStore.getLifetime(lambung) || [];

      /* [FIX B13] frameDelta VHMS = |SMR tertinggi telemetri − currentHM
       * tertinggi Lifetime|. Rumus & toleransinya mengikuti
       * `applyVhmsPillarCut()` di `component-life.js:578-590`. */
      var maxSmr = null;
      records.forEach(function (r) {
        var v = toNum(r && r.smr);
        if (v !== null && (maxSmr === null || v > maxSmr)) maxSmr = v;
      });
      var maxLife = null;
      lifeRows.forEach(function (r) {
        var v = toNum(r && r.currentHM);
        if (v !== null && (maxLife === null || v > maxLife)) maxLife = v;
      });
      frameDelta = (maxSmr !== null && maxLife !== null) ? Math.abs(maxSmr - maxLife) : null;
      var tolHours = (compLife.getTolerance ? compLife.getTolerance() : null);
      if (tolHours === null || tolHours === undefined || isNaN(tolHours)) {
        tolHours = compLife.HM_FRAME_TOLERANCE_HOURS;
      }
      if (tolHours === null || tolHours === undefined || isNaN(tolHours)) tolHours = 500;

      lifeRows.forEach(function (lr) {
        var pt = compLife.installPointOf ? compLife.installPointOf(lr) : null;
        if (!pt) return;

        var compName = lr.component || 'Komponen';
        var pillar = pillarOfComponent(compName);

        // [FIX B14] TECO palsu -> JANGAN pakai tanggal (installPointOf sudah
        // me-null-kan `pt.date`), pakai HM dari MeterRunComponent.
        var useDate = !pt.tecoSuspect && pt.date && pt.date.epoch !== null &&
                      pt.date.epoch !== undefined;
        // [FIX B13] HM hanya dipakai bila kerangka HM sepadan.
        var frameOk = (frameDelta === null) || (frameDelta <= tolHours);
        var useHM = !useDate && pt.hm !== null && frameOk;

        var instSmr = (pt.hm !== null && pt.hm !== undefined) ? pt.hm : null;
        // [FIX B12] Lifetime menulis epoch dalam MILIDETIK; dinormalkan.
        var instMs = (pt.date && pt.date.epoch !== null && pt.date.epoch !== undefined)
          ? epochMs(pt.date.epoch) : null;
        var runHm = (currentSmr !== null && instSmr !== null)
          ? Math.max(0, currentSmr - instSmr) : null;

        if (!useDate && !useHM) {
          // Tier 3 — jangan potong, tetapi catat sebabnya (jangan diam).
          if (pt.hm !== null && !frameOk) {
            frameRejected.push({
              component: compName, pillar: pillar,
              installSmr: instSmr, frameDelta: frameDelta, tolerance: tolHours
            });
          }
          overhaulDetails.push({
            component: compName, pillar: pillar,
            installSmr: instSmr,
            installDate: pt.date ? pt.date.iso : null,
            runningHours: runHm,
            basis: 'tidak-dipotong',
            tecoSuspect: !!pt.tecoSuspect,
            cutApplied: false
          });
          return;
        }

        hasOverhaulReset = true;

        // Per pilar: pertahankan titik pasang TERBARU untuk pilar itu.
        var cand = {
          smr: useHM ? instSmr : null,
          dateMs: useDate ? instMs : null,
          basis: useDate ? 'date' : 'hm',
          component: compName,
          tecoSuspect: !!pt.tecoSuspect
        };
        var prev = pillarCuts[pillar];
        var takeIt = !prev;
        if (prev) {
          if (cand.basis === prev.basis) {
            if (cand.basis === 'date') takeIt = (cand.dateMs > prev.dateMs);
            else takeIt = (cand.smr > prev.smr);
          } else {
            takeIt = (cand.basis === 'date');   // tanggal lebih tepercaya
          }
        }
        if (takeIt && pillar !== 'OTHER') pillarCuts[pillar] = cand;

        overhaulDetails.push({
          component: compName, pillar: pillar,
          installSmr: instSmr,
          installDate: pt.date ? pt.date.iso : null,
          runningHours: runHm,
          basis: cand.basis,
          tecoSuspect: !!pt.tecoSuspect,
          cutApplied: (pillar !== 'OTHER')
        });
      });
    }

    /* Jam sejak reset = pemasangan komponen PALING BARU (jarak terkecil),
     * bukan `currentSmr − max(cutSmr)`. Versi pertama memakai nilai `cutSmr`
     * global sehingga unit dengan satu komponen tua melaporkan
     * `hoursSinceReset` belasan ribu jam. */
    overhaulDetails.forEach(function (od) {
      if (od.runningHours === null || od.runningHours === undefined) return;
      if (hoursSinceReset === null || od.runningHours < hoursSinceReset) {
        hoursSinceReset = od.runningHours;
      }
    });

    // B. Penggantian Oli (fluid_changed)
    var hasOilDrainReset = false;
    var oilDrainDetails = [];
    (sosUnits || []).forEach(function (u) {
      var samples = u.samples || [];
      if (!samples.length) return;
      var last = samples[samples.length - 1];
      var prev = samples.length > 1 ? samples[samples.length - 2] : null;
      var drained = isFluidChanged(last) ? last : (isFluidChanged(prev) ? prev : null);
      if (!drained) return;

      hasOilDrainReset = true;
      var dm = sampleMeter(drained);
      oilDrainDetails.push({
        component: u.component,
        pillar: pillarOfComponent(u.component),
        sampleMeter: dm,                 // [FIX B7] 0 = angka sah
        sampleDate: drained.sampled_date || drained.lab_date || null,
        // Jam operasi sejak oli diganti — dipakai gerbang observasi [FIX B6].
        hoursSinceDrain: (currentSmr !== null && dm !== null)
          ? Math.max(0, currentSmr - dm) : null
      });
    });

    /* ---------------------------------------------------------------------
     * [FIX B6 2026-11-13] OBSERVASI PASCA-SERVIS WAJIB BERBATAS WAKTU.
     * -------------------------------------------------------------------
     * Versi pertama menyalakan `isUnderObservation` untuk SETIAP unit yang
     * punya `fluid_changed = 'Y'`, tanpa syarat jam. Ganti oli adalah
     * peristiwa RUTIN (tiap 250-500 jam), dan `hoursSinceDrain` tidak
     * diperiksa — jadi tidak ada yang bisa mematikan penanda itu. Terukur:
     * unit yang rajin ganti oli berbadge biru PERMANEN.
     *
     * Sekarang: observasi hanya aktif bila peristiwa reset benar-benar MASIH
     * SEGAR (<= POST_REPAIR_OBSERVATION_HOURS jam operasi). Bila jam tidak
     * dapat dihitung sama sekali (meter absen di kedua sisi), penanda TIDAK
     * dinyalakan — lebih baik tidak mengklaim daripada mengklaim tanpa dasar.
     * ------------------------------------------------------------------- */
    var obsLimit = CONFIG.POST_REPAIR_OBSERVATION_HOURS;
    var freshOverhaul = (hoursSinceReset !== null && hoursSinceReset <= obsLimit);
    var freshDrain = false;
    var hoursSinceDrain = null;
    oilDrainDetails.forEach(function (od) {
      if (od.hoursSinceDrain === null || od.hoursSinceDrain === undefined) return;
      if (hoursSinceDrain === null || od.hoursSinceDrain < hoursSinceDrain) {
        hoursSinceDrain = od.hoursSinceDrain;
      }
    });
    if (hoursSinceDrain !== null && hoursSinceDrain <= obsLimit) freshDrain = true;

    var isUnderObservation = freshOverhaul || freshDrain;

    /* [FIX B5 2026-11-13] `hasReset` DIBATASI PADA PERISTIWA SEGAR.
     * Versi pertama menyalakannya untuk setiap baris Lifetime yang punya
     * titik pasang — yaitu hampir seluruh armada, termasuk komponen yang
     * sudah berjalan 19.000 jam — sehingga "ada riwayat perbaikan"
     * kehilangan arti dan badge POST-REPAIR menjadi tak bermakna.
     * `hasOverhaulReset`/`hasOilDrainReset` tetap melaporkan fakta mentah
     * (dipakai untuk pemotongan riwayat); `hasReset` kini berarti
     * "baru saja diservis". */
    return {
      hasReset: isUnderObservation,
      hasOverhaulReset: hasOverhaulReset,
      hasOilDrainReset: hasOilDrainReset,
      pillarCuts: pillarCuts,
      hoursSinceReset: hoursSinceReset,
      hoursSinceDrain: hoursSinceDrain,
      observationLimitHours: obsLimit,
      isUnderObservation: isUnderObservation,
      frameDelta: frameDelta,
      frameRejected: frameRejected,
      overhaulDetails: overhaulDetails,
      oilDrainDetails: oilDrainDetails
    };
  }

  /* -----------------------------------------------------------------------
   * 6. Kalkulasi Skor Gabungan Per Unit (Single Unit Combined Ranking)
   * --------------------------------------------------------------------- */
  function calcUnitRanking(unitInfo, analysis, sosUnits, opts) {
    opts = opts || {};
    var lambung = unitInfo.lambung || (analysis && analysis.meta && analysis.meta.serial) || '';
    var serial = unitInfo.serial || (analysis && analysis.meta && analysis.meta.serial) || '';
    var model = unitInfo.model || (analysis && analysis.meta && analysis.meta.model) || '';
    var records0 = (analysis && analysis.records) || [];

    // Deteksi Reset Event / Post-Repair
    var resetInfo = detectResetEvent(lambung, analysis, sosUnits);

    // [FIX B3] Titik potong PER PILAR, bukan satu `cutSmr` global.
    var pillarCuts = (opts.autoExcludePreOverhaul !== false) ? resetInfo.pillarCuts : {};

    // 1. Kondisi Terkini
    var vhmsCurrent = calcVhmsCurrent(analysis, { pillarCuts: pillarCuts });
    var sosCurrent = calcSosCurrent(sosUnits, { pillarCuts: pillarCuts });

    var hasVhms = !!(analysis && analysis.records && analysis.records.length);
    var hasSos = !!(sosUnits && sosUnits.length);

    var wv = 0.5, ws = 0.5;
    if (hasVhms && !hasSos) { wv = 1.0; ws = 0.0; }
    else if (!hasVhms && hasSos) { wv = 0.0; ws = 1.0; }
    else if (!hasVhms && !hasSos) { wv = 0.0; ws = 0.0; }

    var currentScore = (wv * vhmsCurrent.score) + (ws * sosCurrent.score);

    // 2. Kondisi Riwayat Kronis (Meluruh)
    var historyRes = calcHistoryDecayed(analysis, sosUnits, {
      pillarCuts: pillarCuts,
      tauHours: opts.tauHours || CONFIG.DECAY_TAU_HOURS
    });
    var historyScore = historyRes.score;

    /* 3. Gerbang Pembatas Riwayat (Gate Rule) — §2.3.C spek.
     * Bila kondisi TERKINI normal, riwayat TIDAK BOLEH mendongkrak unit ke
     * zona kritis. Plafonnya = batas atas zona Watchlist/Monitor, dibaca
     * dari `STATUS_DEFINITIONS` [FIX B18] agar ambang hanya punya SATU
     * sumber kebenaran. */
    var isCurrentNormal = (hasVhms ? vhmsCurrent.isNormal : true) && (hasSos ? sosCurrent.isNormal : true);
    if (isCurrentNormal) {
      historyScore = Math.min(historyScore, HISTORY_GATE_CAP);
    }

    // 4. Bonus Sinergi
    var synergyRes = calcSynergy(vhmsCurrent, sosCurrent, analysis, sosUnits);
    var synergyBonus = synergyRes.bonus;

    // 5. Skor Akhir Gabungan
    var wCur = opts.weightCurrent !== undefined ? opts.weightCurrent : CONFIG.WEIGHT_CURRENT;
    var wHis = opts.weightHistory !== undefined ? opts.weightHistory : CONFIG.WEIGHT_HISTORY;

    var combinedScore = (wCur * currentScore) + (wHis * historyScore) + synergyBonus;

    // Gerbang Gate Rule pada Skor Akhir: bila kedua sumber bersih SEKARANG,
    // skor total tidak boleh melewati batas atas zona Watchlist.
    if (isCurrentNormal) {
      combinedScore = Math.min(HISTORY_GATE_CAP, combinedScore);
    }

    combinedScore = clamp(Math.round(combinedScore * 10) / 10, 0, 100);

    /* ---------------------------------------------------------------------
     * 6. Penentuan Taksonomi Status Badge
     * -------------------------------------------------------------------
     * [FIX B4/B18 2026-11-13] Ambang dibaca dari `STATUS_DEFINITIONS`
     * (`minScore`), BUKAN ditulis ulang sebagai angka telanjang. Versi
     * pertama menyalin 75/50/30/25 ke dalam `if`, sehingga `minScore` yang
     * diekspor tidak pernah dibaca — dua sumber kebenaran untuk ambang yang
     * sama, dan dokumen/uji bisa hijau sambil menjelaskan aturan yang tidak
     * dipakai.
     *
     * [FIX B4] POST-REPAIR TIDAK LAGI MENANG TANPA SYARAT — tetapi
     * syaratnya adalah KESEGARAN PERISTIWA SERVIS, bukan ambang skor
     * (lihat catatan panjang di `STATUS_DEFINITIONS.POST_REPAIR`: band
     * 30-49 yang ditulis spek terbukti tak terjangkau). Dulu cabang ini
     * menyala untuk unit berskor 0 karena `resetInfo.hasReset` menyala bagi
     * hampir seluruh armada — akar masalahnya kini ditutup di
     * `detectResetEvent()` ([FIX B5]/[FIX B6]), sehingga hanya unit yang
     * BENAR-BENAR baru diservis (<= 500 jam) yang memperoleh badge biru.
     * ------------------------------------------------------------------- */
    var SD = STATUS_DEFINITIONS;
    var anyCritical = (vhmsCurrent.status === 'CRITICAL' || sosCurrent.status === 'CRITICAL');
    var anyCaution = (vhmsCurrent.status === 'CAUTION' || sosCurrent.status === 'CAUTION');
    var statusDef;

    if (combinedScore >= SD.ACTIVE_CRITICAL.minScore &&
        (anyCritical || synergyBonus >= CONFIG.SYNERGY_PAIR_MULTIPLIER)) {
      statusDef = SD.ACTIVE_CRITICAL;
    } else if (combinedScore >= SD.HIGH_RISK.minScore || anyCritical) {
      statusDef = SD.HIGH_RISK;
    } else if (isCurrentNormal && resetInfo.isUnderObservation) {
      statusDef = SD.POST_REPAIR;
    } else if (combinedScore >= SD.MONITOR.minScore || anyCaution) {
      statusDef = SD.MONITOR;
    } else {
      statusDef = SD.STABLE;
    }

    // Ringkasan diagnosis dan akar masalah
    var diagnosis = '';
    if (synergyRes.activePairs.length > 0) {
      var topPair = synergyRes.activePairs[0];
      diagnosis = 'Sinergi Kerusakan Ganda: ' + topPair.hypothesis;
    } else if (vhmsCurrent.worstParam) {
      diagnosis = 'VHMS: ' + vhmsCurrent.worstParam.label + ' ' + vhmsCurrent.worstParam.status + ' (' + vhmsCurrent.worstParam.value + ')';
    } else if (sosCurrent.worstComp) {
      diagnosis = 'SOS: Kompartemen ' + sosCurrent.worstComp + ' Tier ' + sosCurrent.tier;
    } else if (resetInfo.isUnderObservation) {
      var sinceTxt = (resetInfo.hoursSinceReset !== null)
        ? (Math.round(resetInfo.hoursSinceReset) + ' jam sejak pemasangan komponen')
        : ((resetInfo.hoursSinceDrain !== null)
            ? (Math.round(resetInfo.hoursSinceDrain) + ' jam sejak ganti oli')
            : 'oli baru');
      diagnosis = 'Unit pasca-servis dalam pengamatan kestabilan (' + sinceTxt + ')';
    } else {
      diagnosis = 'Kondisi operasional dan kimia oli dalam batas wajar';
    }

    /* SMR terkini. [FIX B7] Tanpa `||`: `smr = 0` sah, dan jam OLI (`_hm`)
     * TIDAK boleh menyamar sebagai jam UNIT. Bila yang tersedia hanya jam
     * oli, besarannya ditandai agar UI dapat menyatakannya apa adanya. */
    var currentSmrVal = null;
    var currentSmrBasis = null;
    for (var si = records0.length - 1; si >= 0; si--) {
      var sv = toNum(records0[si].smr);
      if (sv !== null) { currentSmrVal = sv; currentSmrBasis = 'vhms'; break; }
    }
    if (currentSmrVal === null && sosCurrent.worstSample) {
      var mo = sampleMeterOf(sosCurrent.worstSample);
      currentSmrVal = mo.value;
      currentSmrBasis = (mo.basis === 'unit') ? 'sos-unit' : (mo.basis === 'oil' ? 'sos-oil' : null);
    }

    return {
      vhmsId: unitInfo.vhmsId || null,
      lambung: lambung,
      serial: serial,
      model: model,
      currentSmr: currentSmrVal,
      currentSmrBasis: currentSmrBasis,   // 'vhms' | 'sos-unit' | 'sos-oil' | null
      combinedScore: combinedScore,
      status: statusDef.code,
      statusLabel: statusDef.label,
      badgeClass: statusDef.badgeClass,
      statusColor: statusDef.color,
      statusIcon: statusDef.icon,
      priority: statusDef.priority,
      recommendation: statusDef.recommendation,
      diagnosis: diagnosis,
      // Komponen Skor
      scores: {
        combined: combinedScore,
        current: Math.round(currentScore * 10) / 10,
        history: Math.round(historyScore * 10) / 10,
        synergy: synergyBonus,
        vhmsCurrent: vhmsCurrent.score,
        sosCurrent: sosCurrent.score,
        weightCurrent: wCur,
        weightHistory: wHis
      },
      vhmsDetails: vhmsCurrent,
      sosDetails: sosCurrent,
      synergyDetails: synergyRes,
      historyDetails: historyRes,
      resetDetails: resetInfo,
      isLinked: hasVhms && hasSos
    };
  }

  /* -----------------------------------------------------------------------
   * 7. Kalkulasi Peringkat Seluruh Armada (Fleet Leaderboard)
   * --------------------------------------------------------------------- */
  function calcFleetRanking(opts) {
    opts = opts || {};
    var vStore = global.VHMS_FLEET;
    var sStore = global.SOS_STORE;
    var crossMod = global.VHMS_CROSS;

    /* ---------------------------------------------------------------------
     * [FIX B19 2026-11-13] CACHE BERBASIS REVISI DATA.
     * -------------------------------------------------------------------
     * Fungsi ini memindai seluruh record x seluruh parameter untuk SETIAP
     * unit. Renderer memanggilnya ulang pada tiap ketikan pencarian, ganti
     * filter, ganti sortir, dan centang checkbox — padahal penyaringan dan
     * pengurutan adalah pekerjaan sisi-tampilan yang tidak mengubah
     * analitik. `vhms-cross.js` memakai `fleetCache` untuk alasan yang
     * sama; pola & kunci revisinya diikuti di sini.
     *
     * Kunci memuat opsi yang BENAR-BENAR mengubah hasil (bobot, tau,
     * auto-exclude) sehingga mengubah salah satunya tetap memaksa hitung
     * ulang. Panggil `invalidateCache()` bila data armada berubah.
     * ------------------------------------------------------------------- */
    var cacheKey = [
      (vStore && vStore.getRevision) ? vStore.getRevision() : '',
      (sStore && sStore.getRevision) ? sStore.getRevision() : '',
      (opts.autoExcludePreOverhaul !== false) ? 1 : 0,
      (opts.weightCurrent !== undefined) ? opts.weightCurrent : CONFIG.WEIGHT_CURRENT,
      (opts.weightHistory !== undefined) ? opts.weightHistory : CONFIG.WEIGHT_HISTORY,
      opts.tauHours || CONFIG.DECAY_TAU_HOURS
    ].join('|');
    if (!opts.noCache && _fleetCache && _fleetCache.key === cacheKey) {
      return _fleetCache.result;
    }

    var rows = [];
    var sosIndex = (crossMod && crossMod.buildSosIndex) ? crossMod.buildSosIndex() : {};

    // 1. Ambil seluruh unit VHMS
    var vhmsRows = (vStore && vStore.rows) ? vStore.rows() : [];
    var processedSerials = {};

    vhmsRows.forEach(function (vr) {
      var analysis = vStore.getAnalysis ? vStore.getAnalysis(vr.id) : null;
      var sosUnits = (crossMod && crossMod.matchSos) ? crossMod.matchSos(vr, sosIndex) : [];
      var unitInfo = {
        vhmsId: vr.id,
        serial: vr.serial,
        model: vr.model,
        lambung: vr.lambung || vr.serial
      };

      var ranked = calcUnitRanking(unitInfo, analysis, sosUnits, opts);
      rows.push(ranked);
      if (vr.serial) processedSerials[normStr(vr.serial)] = true;
      if (vr.lambung) processedSerials[normStr(vr.lambung)] = true;
    });

    // 2. Sertakan unit SOS yang belum ada di VHMS (bila ada)
    if (sStore && sStore.getAllUnits) {
      var allSos = sStore.getAllUnits();
      var sosByUnit = {};
      allSos.forEach(function (su) {
        var lb = (crossMod && crossMod.sosLambung) ? crossMod.sosLambung(su) : (su.assetId || su.serial || '');
        var key = normStr(lb);
        if (!key || processedSerials[key]) return;
        if (!sosByUnit[key]) sosByUnit[key] = [];
        sosByUnit[key].push(su);
      });

      Object.keys(sosByUnit).forEach(function (key) {
        var units = sosByUnit[key];
        var first = units[0] || {};
        var lb = (crossMod && crossMod.sosLambung) ? crossMod.sosLambung(first) : (first.assetId || first.serial || '');
        var unitInfo = {
          vhmsId: null,
          serial: first.serial || lb,
          model: first.model || '',
          lambung: lb
        };
        var ranked = calcUnitRanking(unitInfo, null, units, opts);
        rows.push(ranked);
      });
    }

    // Urutkan peringkat armada:
    // Prioritas 1: Priority Status (1=Critical, 2=High Risk, 3=Post-Repair, 4=Monitor, 5=Stable)
    // Prioritas 2: Combined Score Descending
    rows.sort(function (a, b) {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.combinedScore - a.combinedScore;
    });

    /* Beri nomor peringkat (#1, #2, ...) dan KUNCI BARIS yang unik.
     * [FIX B20] Renderer dulu mengidentifikasi baris lewat nomor lambung;
     * dua baris bisa punya lambung sama (unit VHMS tanpa lambung jatuh ke
     * serial, unit SOS-only yang lambung-nya baru dikenali belakangan),
     * sehingga pencarian balik mengembalikan baris yang SALAH. `rowId`
     * dijamin unik dalam satu hasil. */
    rows.forEach(function (r, idx) {
      r.rank = idx + 1;
      r.rowId = 'ccr-' + idx + '-' + (r.vhmsId !== null && r.vhmsId !== undefined
        ? 'v' + r.vhmsId : 's' + normStr(r.lambung || r.serial || idx));
    });

    // Ringkasan KPI
    var totalLinked = rows.filter(function (r) { return r.isLinked; }).length;
    var activeCritical = rows.filter(function (r) { return r.status === 'ACTIVE_CRITICAL'; }).length;
    var highRisk = rows.filter(function (r) { return r.status === 'HIGH_RISK'; }).length;
    var postRepair = rows.filter(function (r) { return r.status === 'POST_REPAIR'; }).length;
    var monitor = rows.filter(function (r) { return r.status === 'MONITOR'; }).length;
    var stable = rows.filter(function (r) { return r.status === 'STABLE'; }).length;

    var result = {
      rows: rows,
      summary: {
        totalUnits: rows.length,
        totalLinked: totalLinked,
        activeCritical: activeCritical,
        highRisk: highRisk,
        postRepair: postRepair,
        monitor: monitor,
        stable: stable
      },
      // Dibedakan dari "tidak lolos filter" agar UI dapat menyampaikan
      // sebab yang benar: belum ada berkas vs filter terlalu sempit.
      hasAnyData: rows.length > 0,
      timestamp: new Date()
    };

    _fleetCache = { key: cacheKey, result: result };
    return result;
  }

  /* -----------------------------------------------------------------------
   * Export Modul
   * --------------------------------------------------------------------- */
  var api = {
    CONFIG: CONFIG,
    STATUS_DEFINITIONS: STATUS_DEFINITIONS,
    HISTORY_GATE_CAP: HISTORY_GATE_CAP,
    calcVhmsCurrent: calcVhmsCurrent,
    calcSosCurrent: calcSosCurrent,
    calcHistoryDecayed: calcHistoryDecayed,
    calcSynergy: calcSynergy,
    detectResetEvent: detectResetEvent,
    calcUnitRanking: calcUnitRanking,
    calcFleetRanking: calcFleetRanking,
    invalidateCache: invalidateCache,
    // Primitif (dibuka agar dapat diuji terpisah & dipakai renderer)
    maskedValueOf: maskedValueOf,
    isScorableParam: isScorableParam,
    paramLabel: paramLabel,
    sampleMeterOf: sampleMeterOf,
    isFluidChanged: isFluidChanged,
    pillarOfComponent: pillarOfComponent,
    afterCut: afterCut,
    epochMs: epochMs
  };

  global.VHMS_CROSS_RANKING = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

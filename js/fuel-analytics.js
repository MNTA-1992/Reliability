/* =========================================================================
 * fuel-analytics.js
 * -------------------------------------------------------------------------
 * [FUEL 2026-10-28] Inti analitik Fuel Trending — modul **MANDIRI**.
 * Lihat `docs/DEV_FUEL_TRENDING_2026-10-28.md` §3.
 *
 * MURNI: tanpa DOM, tanpa localStorage, tanpa `window.FUEL_STORE`.
 * Jalan di Node maupun browser (dipakai probe CLI + test suite).
 *
 * Ketergantungan DIIZINKAN (satu arah, read-only):
 *   VHMS_CONFIG.emptyWeightFor(model)  — tabel spesifikasi pabrik.
 *       BUKAN formula analisis, dan TIDAK boleh diduplikasi di sini
 *       (dua angka untuk satu konsep = akar bug `FUEL-b`).
 * Yang DILARANG (dijaga uji FUEL-ISO-4):
 *   VHMS_FLEET, SOS_STORE, PORTFOLIO_STORE, VHMS_ANALYTICS, VHMS_RANKING
 *
 * -------------------------------------------------------------------------
 * KENAPA JENDELA, BUKAN HARI
 * -------------------------------------------------------------------------
 * `trend0.CSV` BUKAN harian. Jarak antar record ~20,0 jam SMR (raw 200,
 * Axis Rate 10). Jadi "per hari" yang diminta sebenarnya "per jendela
 * 20 jam mesin" — dan itu LEBIH BAIK: `liters = L/h × dSMR` dan payload
 * terukur pada interval yang SAMA. Asumsi tersembunyi \"L/h konstan
 * sepanjang hari\" hilang dengan sendirinya.
 *
 * -------------------------------------------------------------------------
 * PENGAMAT (trajectory)
 * -------------------------------------------------------------------------
 * `analyze()` sengaja mengembalikan `trace` berisi SELURUH jendela 5 tahap
 * (window -> join -> gate -> metric -> verdict). Tanpa itu, jendela yang
 * gugur di tengah jalan TIDAK KELIHATAN dan penyebabnya tak bisa dibedakan
 * dari \"tidak ada data\". Ini yang membuat debugging bisa dikerjakan
 * bersama tim lain tanpa harus membaca ulang kode.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * KONSTANTA AMBANG — SATU TEMPAT.
   * Jangan hardcode angka ini di berkas lain (renderer, apps, probe).
   * Setiap angka punya SEBAB; jangan dilonggarkan tanpa uji baru.
   * --------------------------------------------------------------------- */
  var LIMITS = {
    // --- gerbang siklus -----------------------------------------------
    minPayload: 5,            // t   — di bawah ini: siklus relokasi, bukan produksi
    speedMin: 5,              // km/h — batas bawah plausibilitas
    speedMax: 60,             // km/h — batas atas. MENGGANTIKAN aturan sentinel
                              //        `255`: raw 255 bisa SAH (83 min -> 18 km/h)
                              //        maupun PALSU (10 min -> 153 km/h).
    minEmptyDist: 0.5,        // km  — menangkap sensor empty-leg mati (kelas R857)
    asymFlag: 0.5,            //     — |>0,5| DITANDAI, TIDAK di-drop (transisi rute)
    gradeMinLoaded: 1.0,      // km  — di bawah ini `Angle Ave` didominasi manuver dump

    // --- gerbang jendela ----------------------------------------------
    minCoverage: 0.70,        // Σ cycleTime / dSMR. WAJIB — lihat §3.5 dokumen.
                              // Tanpa ini: liters dari SELURUH 20 h dibagi TKM
                              // dari sebagian siklus -> L/TKM meledak (z=9,74 palsu
                              // pada 2026-04-26, coverage 28 %).
                              // Kelas bug IDENTIK slopeOf() tanpa gerbang rentang SMR.
    minCycles: 10,            // siklus valid per jendela
    minWindows: 20,           // jendela valid per unit sebelum baseline diterbitkan
    maxGapSmr: 100,           // h   — dSMR di atas ini = gap, jendela dibuang

    // --- verdict -------------------------------------------------------
    zCaution: 2,
    zOver: 3
  };

  /* -----------------------------------------------------------------------
   * SIGMA LANTAI — MENGAPA INI WAJIB ADA
   * ---------------------------------------------------------------------
   * MAD = median(|x − median|). Bila >50 % jendela berbagi satu nilai
   * (mis. fuel rate stabil, banyak jendela dangan cycleTime identik), MAD
   * menjadi TEPAT 0. Akibatnya:
   *
   *   z = (log r − median) / 0  ->  Infinity, atau kita paksa 0
   *
   * Dipaksa 0: SEMUA jendela jadi NORMAL dan anomali NYATA tidak pernah
   * terdeteksi (terbukti di uji FUEL-COV-2: 30 jendela, satu 3x lipat,
   * z semuanya 0). Dibiarkan Infinity: setiap deviasi jadi OVER.
   * Dua-duanya salah.
   *
   * Larutan: sigma di bawah ambang = "data terlalu rata untuk menvonis",
   * baseline TIDAK diterbitkan, dan `z` = null. Jendela tetap ditampilkan
   * BESERTA nilainya, tanpa verdict. Jangan pernah menvonis dari lantai.
   *
   * Nilai 0,005 (0,5 % pada skala log).
   *
   * ⚠ SEJARAH: percobaan pertama memakai 0,02 dan itu SALAH — uji
   * FUEL-COV-2 langsung menangkapnya. Pada data dengan mesin & rute yang
   * stabil, sigma wajar bisa sekecil 0,0067 (pilot: 0,038–0,118 hanya
   * karena melintasi berbulan-bulan). Lantai 0,02 lalu menveto baseline
   * sehingga jendela yang fuel rate-nya 3x lipat pun TIDAK mendapat verdict.
   *
   * Lantai ini hanya boleh menyala saat data benar-benar identik (MAD = 0).
   * --------------------------------------------------------------------- */
  var MIN_SIGMA_LOG = 0.005;

  /* -----------------------------------------------------------------------
   * median / MAD — robust, bukan mean/stdev.
   * MAD dipakai karena hari anomali adalah yang MAU DIDETEKSI; mean/stdev
   * akan menyerapnya ke dalam baseline sehingga anomali jadi tak terlihat.
   * --------------------------------------------------------------------- */
  function median(arr) {
    var a = arr.filter(function (v) { return v != null && isFinite(v); })
      .slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = a.length >> 1;
    return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** { med, sigma } di mana sigma = 1,4826 × MAD (konsisten utk distribusi normal). */
  function madN(arr) {
    var vals = arr.filter(function (v) { return v != null && isFinite(v); });
    if (!vals.length) return { med: null, sigma: null, n: 0 };
    var med = median(vals);
    var dev = vals.map(function (x) { return Math.abs(x - med); });
    return { med: med, sigma: 1.4826 * median(dev), n: vals.length };
  }

  /* -----------------------------------------------------------------------
   * ymd(epoch, tz) — tanggal LOKAL (bukan UTC).
   * Tanpa tz (28800 = UTC+8), tanggal bergeser 8 jam dan jendela jatuh di
   * hari yang salah.
   * --------------------------------------------------------------------- */
  function ymd(epochSec, tzSec) {
    var ms = (Number(epochSec) + (Number(tzSec) || 0)) * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* -----------------------------------------------------------------------
   * resolveEmptyWeight(model) — SATU-SATUNYA ketergantungan ke modul lain.
   * Mengembalikan `null` bila tidak diketahui. `null` BUKAN nol: pemanggil
   * WAJIB menahan diri, jangan memakai nilai asal.
   * --------------------------------------------------------------------- */
  function resolveEmptyWeight(model) {
    var vcfg = global.VHMS_CONFIG;
    if (!vcfg || typeof vcfg.emptyWeightFor !== 'function') return null;
    try {
      var w = vcfg.emptyWeightFor(model);
      return (typeof w === 'number' && isFinite(w) && w > 0) ? w : null;
    } catch (e) {
      return null;
    }
  }

  /* -----------------------------------------------------------------------
   * buildWindows(trend) — record trend -> jendela.
   *
   * trend: { smr:number[], fuelRate:number[], epoch:number[], tz:number }
   * Urutan WAJIB naik menurut SMR (diurutkan di sini, bukan di pemanggil).
   * --------------------------------------------------------------------- */
  function buildWindows(trend) {
    var rec = [];
    var n = (trend && trend.smr ? trend.smr.length : 0);
    for (var i = 0; i < n; i++) {
      var smr = trend.smr[i];
      if (smr == null || !isFinite(smr)) continue;
      if (trend.epoch[i] == null) continue;
      // `tz` WAJIB ikut: tanpa itu jendela ditandai tanggal UTC dan jatuh
      // di hari yang salah (±8 jam). `i` menyimpan indeks asal untuk telusur.
      rec.push({
        smr: smr,
        fuelRate: trend.fuelRate == null ? null : trend.fuelRate[i],
        t: trend.epoch[i],
        tz: trend.tz == null ? 0 : trend.tz[i],
        i: i
      });
    }
    // [RESET 2026-10-29] Urut berdasarkan WAKTU, bukan SMR. Setelah VHMS
    // di-reset SMR mulai dari nol, sehingga mengurut per SMR menaruh data
    // pasca-reset di DEPAN data pra-reset — jendela terbentuk dari pasangan
    // record yang salah dan seluruh deret jadi mundur. Epoch tidak pernah
    // ter-reset. (`t` = epoch, lihat blok push di atas.)
    //
    // Jendela sambungan (record terakhir pra-reset -> record pertama
    // pasca-reset) gugur dengan sendirinya lewat gerbang `smr-not-increasing`
    // yang sudah ada: itu BENAR, jam mesin memang tidak berlanjut melintasi
    // reset. Jangan "memperbaiki" gerbang itu.
    //
    // Pada data TANPA reset perilakunya identik: SMR dan epoch naik bersama.
    rec.sort(function (a, b) { return a.t - b.t; });

    var out = [], trace = [];
    for (var k = 1; k < rec.length; k++) {
      var a = rec[k - 1], b = rec[k];
      var dSmr = b.smr - a.smr;
      var w = {
        t0: a.t, t1: b.t, tz: b.tz, dSmr: dSmr,
        fuelRate: b.fuelRate, liters: null, cyc: [],
        // Tanggal LOKAL (tz dari field Calendar), bukan UTC.
        date: ymd(b.t, b.tz)
      };
      if (!(dSmr > 0)) { w.drop = 'smr-not-increasing'; trace.push(w); continue; }
      if (dSmr > LIMITS.maxGapSmr) { w.drop = 'gap-smr'; trace.push(w); continue; }
      if (!(b.t > a.t)) { w.drop = 'calendar-not-increasing'; trace.push(w); continue; }
      if (b.fuelRate == null || !isFinite(b.fuelRate)) {
        w.drop = 'fuel-rate-null'; trace.push(w); continue;
      }
      w.liters = b.fuelRate * dSmr;
      trace.push(w);
      out.push(w);
    }
    return { windows: out, trace: trace };
  }

  /* -----------------------------------------------------------------------
   * gateCycle(c) — gerbang validitas SATU siklus.
   * @returns {{ ok: boolean, reason?: string }}  (reason null bila lolos)
   *
   * Asimetri & grade TIDAK menggugurkan siklus — hanya menandai.
   * --------------------------------------------------------------------- */
  function gateCycle(c) {
    if (!(c.P > LIMITS.minPayload)) return { ok: false, reason: 'payload' };
    var mins = (c.tE || 0) + (c.tL || 0);
    var km = (c.dE || 0) + (c.dL || 0);
    // Cek waktu jalan SEBELUM membagi: `km/(0/60)` = Infinity, dan `Infinity
    // <= 60` bernilai false sehingga siklus ini LOLOS gerbang kecepatan tanpa
    // pernah diuji. Siklus tanpa waktu jalan = sensor mati, harus dibuang.
    if (!(mins > 0)) return { ok: false, reason: 'no-drive-time' };
    var v = km / (mins / 60);
    if (!(v >= LIMITS.speedMin && v <= LIMITS.speedMax)) return { ok: false, reason: 'speed' };
    if (!(c.dE >= LIMITS.minEmptyDist)) return { ok: false, reason: 'empty-dist' };
    var mx = Math.max(c.dE || 0, c.dL || 0);
    return {
      ok: true,
      reason: null,
      asym: (mx > 0 && Math.abs((c.dE || 0) - (c.dL || 0)) / mx > LIMITS.asymFlag),
      gradeOk: (c.dL || 0) >= LIMITS.gradeMinLoaded
    };
  }

  /* -----------------------------------------------------------------------
   * computeMetrics(cycles, liters, dSmr, Me) — metrik satu jendela.
   * `cycles` harus SUDAH lolos gateCycle.
   * --------------------------------------------------------------------- */
  function computeMetrics(cycles, liters, dSmr, Me) {
    var TKM = 0, GTKM = 0, stop = 0, cycT = 0, ovl = 0, pSum = 0;
    for (var i = 0; i < cycles.length; i++) {
      var c = cycles[i];
      TKM += c.P * (c.dL || 0);
      GTKM += (Me + c.P) * (c.dL || 0) + Me * (c.dE || 0);
      var s = (c.sE || 0) + (c.sL || 0) + (c.sLd || 0);
      stop += s;
      cycT += (c.tE || 0) + (c.tL || 0) + s;
      if (c.over >= 1) ovl++;
      pSum += c.P;
    }
    var cov = dSmr > 0 ? (cycT / 60) / dSmr : 0;
    return {
      n: cycles.length,
      TKM: TKM, GTKM: GTKM,
      coverage: cov,
      // GTKM=0 -> jangan bagi nol; kembalikan null agar pemanggil menahan diri.
      lTk: TKM > 0 ? liters / TKM : null,
      lGt: GTKM > 0 ? liters / GTKM : null,
      penalty: TKM > 0 ? GTKM / TKM : null,
      idle: cycT > 0 ? stop / cycT : null,
      overLoad: cycles.length ? ovl / cycles.length : null,
      payloadAvg: cycles.length ? pSum / cycles.length : null
    };
  }

  /* -----------------------------------------------------------------------
   * attachCycles(windows, cycles) — join berbasis waktu.
   * Jendela i mencakup (t0, t1]. Siklus tepat di t0 milik jendela sebelumnya.
   * --------------------------------------------------------------------- */
  function attachCycles(windows, cycles) {
    var list = (cycles || []).slice().sort(function (a, b) { return a.t - b.t; });
    var ci = 0;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      while (ci < list.length && list[ci].t <= w.t0) ci++;
      var j = ci;
      while (j < list.length && list[j].t <= w.t1) { w.cyc.push(list[j]); j++; }
    }
    return windows;
  }

  /* -----------------------------------------------------------------------
   * driverFromZs(zG, zP) — atribusi penyebab: 'engine' | 'underload' | null.
   *
   * Aturan SAMA dengan `classify()` (mesin bila z mesin >= z beban). Ditaruh
   * sebagai fungsi terpisah supaya unit yang dibuka dari penyimpanan (yang
   * `driver`-nya tidak ikut di-`compact()`) tetap bisa menampilkan atribusi
   * dari `zG`/`zP` yang tersimpan — bukan memunculkan peringatan bahwa
   * rinciannya "tidak tersimpan". Mengembalikan null bila kedua z kosong:
   * lebih baik tanpa atribusi daripada atribusi karangan.
   * --------------------------------------------------------------------- */
  function driverFromZs(zG, zP) {
    if (zG == null && zP == null) return null;
    var g = (zG == null ? 0 : zG), p = (zP == null ? 0 : zP);
    return (g >= p) ? 'engine' : 'underload';
  }

  /* -----------------------------------------------------------------------
   * classify(windows, opts) — verdict per-unit, log space, MAD, ONE-SIDED.
   *
   * ONE-SIDED: hanya \"over\" yang di-flag. Band bawah JANGAN di-flag —
   * itu hari produktif.
   *
   * Log space: rasio berdistribusi skewed (penyebut kecil -> outlier palsu);
   * di log, \"over 20 %\" jadi jarak konstan di semua level produktivitas.
   * --------------------------------------------------------------------- */
  function classify(windows, opts) {
    opts = opts || {};
    var lc = opts.limits || LIMITS;
    var via = windows.filter(function (w) {
      return w.verdictable && w.lTk != null && isFinite(w.lTk) && w.lTk > 0;
    });

    var res = {
      eligible: via.length,
      ready: via.length >= lc.minWindows,
      // `usable` = baseline benar-benar bisa dipakai untuk vonis (sigma
      // cukup). `ready` saja tidak cukup — lihat SIGMA LANTAI di atas.
      usable: false,
      baseline: null,
      counts: { NORMAL: 0, CAUTION: 0, OVER: 0 },
      windows: windows
    };
    if (!res.ready) return res;

    function stat(key) {
      return madN(via.map(function (w) { return (w[key] == null) ? null : Math.log(w[key]); }));
    }
    var sTk = stat('lTk'), sGt = stat('lGt'), sPn = stat('penalty');
    res.baseline = {
      lTk: { median: Math.exp(sTk.med), sigma: sTk.sigma, flat: !(sTk.sigma >= MIN_SIGMA_LOG) },
      lGt: { median: Math.exp(sGt.med), sigma: sGt.sigma, flat: !(sGt.sigma >= MIN_SIGMA_LOG) },
      penalty: { median: Math.exp(sPn.med), sigma: sPn.sigma, flat: !(sPn.sigma >= MIN_SIGMA_LOG) }
    };

    function z(v, s) {
      if (v == null || !isFinite(v) || v <= 0) return null;
      // Sigma di bawah lantai -> TIDAK menvonis (null), bukan 0 dan bukan
      // Infinity. Menvonis dari lantai = anomali tak terlihat atau semua OVER.
      if (!(s.sigma >= MIN_SIGMA_LOG)) return null;
      return (Math.log(v) - Math.log(s.median)) / s.sigma;
    }

    // Baseline dipakai untuk vonis HANYA untuk metrik yang sigma-nya di atas
    // lantai. Metrik "datar" tetap DITAMPILKAN (median terbit), tapi `z`-nya
    // null dan tidak menyumbang verdict.
    var assigned = 0;
    via.forEach(function (w) { if (z(w.lTk, res.baseline.lTk) != null) assigned++; });
    res.usable = assigned > 0;

    via.forEach(function (w) {
      w.z = z(w.lTk, res.baseline.lTk);
      w.zG = z(w.lGt, res.baseline.lGt);
      w.zP = z(w.penalty, res.baseline.penalty);
      // ONE-SIDED: hanya sisi ATAS yang menjadi verdict.
      w.verdict = (w.z == null) ? null
        : (w.z >= lc.zOver ? 'OVER' : (w.z >= lc.zCaution ? 'CAUTION' : 'NORMAL'));
      // Atribusi: penyebab dominan. Hanya informatif, bukan verdict.
      // Aturan dipusatkan di `driverFromZs()` agar unit yang dibuka dari
      // penyimpanan (lihat `fromSummary`) memakai definisi yang IDENTIK.
      w.driver = null;
      if (w.verdict && w.verdict !== 'NORMAL') {
        w.driver = driverFromZs(w.zG, w.zP);
      }
    });

    res.counts = { NORMAL: 0, CAUTION: 0, OVER: 0 };
    via.forEach(function (w) { if (w.verdict) res.counts[w.verdict]++; });
    return res;
  }

  /* -----------------------------------------------------------------------
   * analyze(input) — pipeline LENGKAP. Inilah API yang dipakai app/render/probe.
   *
   * @param {{
   *   model: string,                 // 'HD785-7' (untuk Me)
   *   trend: {smr,fuelRate,epoch,tz},
   *   cycles: [{t,P,dE,dL,tE,tL,sE,sL,sLd,over,angAve}],
   *   limits?: Object                // override parsial (uji)
   * }} input
   * @returns {{ meta, limits, emptyWeight, windows, baseline, counts, trace, warnings }}
   * --------------------------------------------------------------------- */
  function analyze(input) {
    input = input || {};
    var lc = Object.assign({}, LIMITS, input.limits || {});
    var warnings = [];
    var Me = resolveEmptyWeight(input.model);
    if (Me == null) {
      // Jangan pakai nilai asal. Tanpa Me, GTKM tidak bisa dihitung ->
      // `lGt` dan `penalty` menjadi null, dan verdict ditahan.
      warnings.push('Berat kosong (empty vehicle weight) untuk model "' +
        (input.model || '?') + '" tidak dikenal — angka L/ton-km TIDAK diterbitkan. ' +
        'Isi di Pengaturan > Berat Kosong Unit.');
    }

    var built = buildWindows(input.trend || {});
    var windows = built.windows;
    attachCycles(windows, input.cycles || []);

    // ---- gerbang per jendela (dengan TRAJECTORY) -----------------------
    var gateStats = {
      payload: 0, 'no-drive-time': 0, speed: 0, 'empty-dist': 0,
      asymFlagged: 0, gradeDisabled: 0,
      noCycles: 0, lowCoverage: 0, lowCycles: 0, noTkm: 0
    };

    windows.forEach(function (w) {
      var good = [];
      w.cyc.forEach(function (c) {
        var g = gateCycle(c);
        if (!g.ok) { gateStats[g.reason] = (gateStats[g.reason] || 0) + 1; return; }
        if (g.asym) gateStats.asymFlagged++;
        if (!g.gradeOk) gateStats.gradeDisabled++;
        good.push(c);
      });

      if (!good.length) { w.drop = 'no-valid-cycles'; gateStats.noCycles++; return; }
      if (!(Me > 0)) { w.drop = 'no-empty-weight'; return; }

      // Metrik dihitung SELALU (juga untuk jendela yang nanti gugur) supaya
      // gateStats/coverage bisa DITAMPILKAN dan penyebab gugurnya terlihat.
      // Tanpa ini, jendela kosong gugur sebagai `no-valid-cycles` dengan
      // coverage `undefined`, dan penyebab sebenarnya (coverage 0) tak terbaca.
      var m = computeMetrics(good, w.liters, w.dSmr, Me);
      Object.keys(m).forEach(function (k) { w[k] = m[k]; });

      if (!(w.TKM > 0)) { w.drop = 'no-tkm'; gateStats.noTkm++; return; }
      // URUTAN PENTING: cek COVERAGE lebih dulu, baru jumlah siklus.
      // Jendela yang tertutup sebagian (shift terpotong) punya BANYAK siklus
      // tapi coverage rendah — itulah artefak yang harus ditangkap gerbang
      // coverage. Membalik urutan membuat penyebabnya salah dilabeli.
      if (!(w.coverage >= lc.minCoverage)) { w.drop = 'low-coverage'; gateStats.lowCoverage++; return; }
      if (w.n < lc.minCycles) { w.drop = 'low-cycles'; gateStats.lowCycles++; return; }

      w.verdictable = true;
    });

    // ---- verdict per-unit ---------------------------------------------
    // `date` sudah terisi saat jendela dibuat (tanggal lokal). JANGAN dihitung
    // ulang di sini dengan tz default 0 — itu menggeser 8 jam ke tanggal UTC.
    var cls = classify(windows, { limits: lc });
    if (!cls.ready) {
      var need = (input.cycles || []).length;
      warnings.push('Baseline belum layak: ' + cls.eligible + ' jendela valid, butuh ' +
        lc.minWindows + '. Nilai ditampilkan TANPA verdict.' +
        (need ? '' : ' (Tidak ada siklus payload — berkas pldcyc belum dimuat?)'));
    } else if (!cls.usable) {
      // SIGMA LANTAI: cukup jendela, tapi variasi terlalu rata.
      warnings.push('Variasi antar jendela terlalu kecil (MAD ≈ 0) sehingga verdict ' +
        'TIDAK dapat diterbitkan. Ini terjadi bila data seragam/monoton. ' +
        'Nilai tetap ditampilkan apa adanya.');
    }
    if (input.limits && Object.keys(input.limits).length) {
      warnings.push('Ambang DIOVERRIDE: ' + JSON.stringify(input.limits) +
        ' — hasil ini TIDAK setara angka referensi pilot.');
    }

    return {
      model: input.model || '',
      emptyWeight: Me,
      limits: lc,
      windows: windows,
      // `trace` = SEMUA jendela termasuk yang gugur, berurutan.
      trace: built.trace,
      gateStats: gateStats,
      eligible: cls.eligible,
      ready: cls.ready,
      usable: !!cls.usable,
      baseline: cls.baseline,
      counts: cls.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 },
      // [2026-10-28] Cakupan berkas trend0 (SMR awal/akhir + jam operasi di
      // dalam berkas). Dihitung dari SELURUH record trend0 yang valid — bukan
      // dari jendela yang lolos gerbang — karena ini identitas berkas, bukan
      // hasil penilaian. null bila kolom SMR tidak terbaca.
      trendExtent: trendExtent(input.trend || {}),
      trendSeries: trendSeries(input.trend || {}),
      fuelRateAvg: meanFuelRate(input.trend || {}),
      totalCyclePayload: totalCyclePayload(input.cycles || []),
      totalCycleCount: totalCycleCount(input.cycles || []),
      // [RENTANG 2026-10-28] Rekap siklus per tanggal — satu-satunya jalan
      // agar Total Cycle / Total Tonnage ikut rentang tanggal DENGAN BASIS
      // yang sama seperti angka totalnya (siklus mentah tidak disimpan).
      cycleDaily: cycleDaily(input.cycles || []),
      warnings: warnings
    };
  }

  /**
   * meanFuelRate(trend) — rata-rata Fuel Rate (L/jam) record trend0 yang
   * valid. MURNI. Berbobot sama per record (bukan per jam) dan nilainya null
   * bila tidak ada satu pun pembacaan — JANGAN 0, yang terbaca "tidak boros".
   */
  function meanFuelRate(trend) {
    var fr = (trend && trend.fuelRate) || [];
    var sum = 0, n = 0;
    for (var i = 0; i < fr.length; i++) {
      var v = fr[i];
      if (v == null || !isFinite(v) || v <= 0) continue;
      sum += v; n++;
    }
    return n ? sum / n : null;
  }

  /* -----------------------------------------------------------------------
   * SIKLUS VALID — SATU definisi untuk total maupun rekap harian.
   *
   * [RENTANG 2026-10-28] Syarat `t != null` ditambahkan DENGAN SENGAJA.
   * Angka Total Cycle sekarang bisa dipotong per rentang tanggal lewat
   * `cycleDaily()`; siklus tanpa waktu tidak bisa ditempatkan di tanggal mana
   * pun. Bila ia tetap dihitung pada total, "pilih seluruh tanggal" akan
   * memberi angka yang BERBEDA dari "tanpa filter" — selisih yang tak bisa
   * dijelaskan ke operator. Praktiknya tidak mengubah angka: `cyclesFromTable()`
   * (fuel-parser) sudah melewati baris tanpa kolom Calendar.
   * --------------------------------------------------------------------- */
  function _cycleOk(c) {
    if (!c || c.t == null) return false;
    var p = Number(c.P);
    return isFinite(p) && p > 0;
  }

  /** Total payload dari pldcyc (ton). Null bila tidak ada payload valid. */
  function totalCyclePayload(cycles) {
    var sum = 0, n = 0;
    (cycles || []).forEach(function (c) {
      if (!_cycleOk(c)) return;
      sum += Number(c.P);
      n++;
    });
    return n ? sum : null;
  }

  /** Jumlah siklus valid yang tersedia di pldcyc untuk unit ini. */
  function totalCycleCount(cycles) {
    var n = 0;
    (cycles || []).forEach(function (c) { if (_cycleOk(c)) n++; });
    return n || null;
  }

  /* -----------------------------------------------------------------------
   * cycleDaily(cycles) — rekap siklus pldcyc PER TANGGAL LOKAL.
   *
   * [RENTANG 2026-10-28] Siklus mentah TIDAK disimpan (ribuan baris per unit
   * akan menjebol kuota localStorage). Yang disimpan adalah rekap harian:
   * cukup untuk menjawab "berapa siklus & tonase pada rentang tanggal ini"
   * DENGAN BASIS YANG SAMA PERSIS seperti angka tanpa rentang — sebab
   * jumlah seluruh hari = `totalCycleCount` / `totalCyclePayload`.
   *
   * Syarat siklus dihitung SAMA dengan kedua fungsi itu (payload > 0), bukan
   * syarat gerbang jendela. Menyamakan definisi adalah seluruh alasan rekap
   * ini ada: tanpanya, "Total Cycle" berubah arti saat tanggal dipilih.
   *
   * [SUPPORT 2026-10-30] REKAP DIPERLUAS — jarak & idle per tanggal.
   * ---------------------------------------------------------------------
   * Kolom adalah header `pldcycn23.CSV` (PLM23 'A2'; identik dengan PLM lama
   * '95' — lihat `CYCLE_COLS` di fuel-parser):
   *
   *   Empty Drv.Dist.   (dE)  -> `dE`   km    jarak tempuh KOSONG
   *   Loaded Drv.Dist.  (dL)  -> `dL`   km    jarak tempuh BERMUATAN
   *   Empty Stop Time   (sE)  -> `sE`   menit berhenti saat kosong
   *   LoadingStopTime   (sL)  -> `sL`   menit menunggu saat loading
   *   Loaded Stop Time  (sLd) -> `sLd`  menit berhenti saat bermuatan
   *
   * SATUAN tidak ditebak — mengikuti `gateCycle()` yang sudah ada:
   * kecepatan = km ÷ (tE+tL menit ÷ 60), jadi Km & menit. Tidak ada
   * konversi ke jam/jam di sini; pemanggil yang membagi 60.
   *
   * MENGAPA DI SINI, BUKAN DI RENDERER: rekap inilah satu-satunya bagian
   * siklus yang TERSIMPAN. Menghitung jarak/idle di renderer akan mustahil
   * setelah unit dimuat ulang dari IndexedDB (siklus mentah tidak ada).
   * Menaruhnya di rekap membuat angka rentang = angka tanpa rentang, sama
   * seperti `n`/`ton` — dan itu memang janji seluruh blok ini.
   *
   * KOMPATIBILITAS: field baru bersifat ADITIF. Ringkasan lama
   * (`cycleDaily` tanpa `dE`) tetap terbaca; `null` berarti "tidak disimpan"
   * dan UI WAJIB mencetak "—", bukan 0.
   *
   * MURNI.
   * @returns {Array<{date:string, n:number, ton:number,
   *   dE:number|null, dL:number|null, sE:number|null, sL:number|null,
   *   sLd:number|null}>} urut tanggal
   * --------------------------------------------------------------------- */
  /**
   * _addNum(obj, key, v) — tambah `v` ke `obj[key]`, tahan nilai kosong.
   *
   * Mengapa bukan `+=` saja: `undefined + 5` = NaN, dan SATU sel kosong di
   * pldcyc akan meracuni seluruh total hari itu. `null` dipertahankan
   * sebagai null sampai ada angka sungguhan — nol hanya muncul bila
   * pldcyc memang menulis nol.
   */
  function _addNum(obj, key, v) {
    if (v == null) return;
    var n = Number(v);
    if (!isFinite(n)) return;
    obj[key] = (obj[key] == null ? n : obj[key] + n);
  }

  function cycleDaily(cycles) {
    var by = {};
    (cycles || []).forEach(function (c) {
      if (!_cycleOk(c)) return;
      var d = ymd(c.t, c.tz || 0);
      if (!by[d]) {
        by[d] = { date: d, n: 0, ton: 0,
          dE: null, dL: null, sE: null, sL: null, sLd: null };
      }
      var b = by[d];
      b.n++;
      b.ton += Number(c.P);
      _addNum(b, 'dE', c.dE);
      _addNum(b, 'dL', c.dL);
      _addNum(b, 'sE', c.sE);
      _addNum(b, 'sL', c.sL);
      _addNum(b, 'sLd', c.sLd);
    });
    var keys = Object.keys(by).sort();
    if (!keys.length) return null;
    return keys.map(function (k) { return by[k]; });
  }

  /**
   * idleMinutes(rec) — total menit BERHENTI dari rekap harian.
   *
   * = `Empty Stop Time` + `LoadingStopTime` + `Loaded Stop Time`.
   *
   * [KEPUTUSAN 2026-10-30 — MENGIKUTI DEFINISI YANG SUDAH DIPAKAI]
   * Operator meminta idle = `Empty Stop Time + LoadingStopTime` (dua kolom).
   * Tetapi `computeMetrics()` di modul ini SUDAH mendefinisikan idle sebagai
   * `Σ(sE + sL + sLd) / Σ(tE + tL + sE + sL + sLd)` — berhenti saat kosong,
   * saat loading, DAN saat bermuatan (dump/queue). Memakai dua kolom untuk
   * kolom tabel akan memberi angka BERBEDA untuk hal yang bernama sama:
   * "Idle %" di tabel jendela dan "Idle (jam)" di panel Between. Dua definisi
   * untuk satu istilah adalah kelas bug yang paling mahal di modul ini.
   *
   * Karena itu fungsi ini memakai definisi TIGA komponen yang sudah dipakai
   * vonis & tabel utama, dan menyediakan rinciannya supaya pembaca bisa
   * melihat bahwa `sLd` ikut. Bila memang diinginkan dua komponen saja,
   * ubah DI SATU TEMPAT INI **dan** `computeMetrics()` sekaligus.
   *
   * @returns {number|null} menit; null bila tidak ada satu pun komponen.
   */
  function idleMinutes(rec) {
    if (!rec) return null;
    var parts = [rec.sE, rec.sL, rec.sLd]
      .map(function (v) { return (v == null || !isFinite(Number(v))) ? null : Number(v); })
      .filter(function (v) { return v != null; });
    if (!parts.length) return null;
    return parts.reduce(function (a, b) { return a + b; }, 0);
  }


  /**
   * trendExtent(trend) — SMR awal/akhir & total jam operasi.
   *
   * [RESET 2026-10-29] ΔSMR dijumlahkan PER SEGMEN. Satu segmen berakhir saat
   * SMR TURUN dibanding record sebelumnya — itu tanda VHMS di-reset. Memakai
   * `max - min` pada data gabungan pra/pasca-reset memberi angka jam operasi
   * yang jauh terlalu besar (mis. 63.168 h) karena ia mengukur jarak antara
   * SMR terkecil pasca-reset dan SMR terbesar pra-reset — dua sumbu berbeda.
   *
   * `smrStart`/`smrEnd` dilaporkan dari segmen TERAKHIR (kondisi unit saat
   * ini). Jumlah segmen ikut dilaporkan supaya UI bisa menyebut "2 periode
   * SMR" alih-alih menyamarkan bahwa berkasnya melintasi reset.
   *
   * KENAPA TIDAK MENGURUT SENDIRI: percobaan pertama mengurut per SMR lalu
   * memecah segmen di setiap penurunan — dan GAGAL TOTAL. `[45000, 45100,
   * 45200, 20, 60, 140]` diurut menjadi `[20, 60, 140, 45000, ...]` yang
   * MONOTON, jadi penurunan tidak pernah terdeteksi dan hasilnya kembali
   * `max - min` (45.180 h). Mengurut lebih dulu MENGHAPUS satu-satunya bukti
   * reset. Deteksi reset HARUS memakai urutan WAKTU.
   *
   * PRASYARAT: record mengikuti urutan WAKTU. Dijamin `FUEL_INGEST.accept`
   * (urut epoch) saat banyak berkas digabung, dan oleh `analyze()` yang
   * meneruskan deret apa adanya untuk satu berkas.
   *
   * TANPA RESET fungsinya TETAP "min/max", dan itu memang benar: pada satu
   * segmen yang sama, `max - min` = jumlah ΔSMR seluruh record, berapa pun
   * urutan masuknya. Uji lama (`FUEL-TREND-1`) mengunci sifat itu — jangan
   * diubah menjadi "record pertama ke terakhir", itu akan memberi angka salah
   * setiap kali baris berkas tidak rapi.
   *
   * Bila urutan masukan TIDAK kronologis, fungsi ini memakai jalur aman lama
   * (`max - min`, satu segmen) — sama persis dengan perilaku sebelum fitur ini.
   *
   * MURNI.
   * @returns {{smrStart:number, smrEnd:number, hours:number, n:number,
   *            segments:number}|null}
   */
  function trendExtent(trend) {
    var smr = (trend && trend.smr) || [];
    var vals = [], n = 0, min = null, max = null;
    for (var i = 0; i < smr.length; i++) {
      var x = smr[i];
      if (x == null || !isFinite(x)) continue;
      vals.push(x); n++;
      if (min == null || x < min) min = x;
      if (max == null || x > max) max = x;
    }
    if (min == null || max == null || !(max > min)) return null;

    // Reset VHMS dikenali dari DUA syarat sekaligus:
    //   (1) SMR turun  : v < prev
    //   (2) turunnya KE LEVEL RENDAH: v < max * RESET_FRAC (default 25 %)
    // Bukan "turun sedikit". Memakai syarat relatif terhadap record sebelumnya
    // GAGAL: `[120, 100, 300, 250]` — deret yang hanya tidak rapi — terdeteksi
    // sebagai 3 segmen, dan uji FUEL-TREND-1 menangkapnya. Reset sejati selalu
    // jatuh ke ~0, jauh di bawah puncak mana pun yang sudah tercatat.
    //
    // Akibat penting: pada deret TANPA reset hasilnya TETAP `max - min`, apa
    // pun urutan masukannya — identik dengan implementasi sebelum fitur ini.
    var RESET_FRAC = 0.25;
    var floorSmr = max * RESET_FRAC;
    var lastStart = vals[0], lastEnd = vals[0], segments = 1;
    for (var k = 1; k < vals.length; k++) {
      var v = vals[k];
      if (v < lastEnd && v < floorSmr) {
        // SMR mengulang dari nol -> VHMS direset. Segmen baru dimulai.
        segments++;
        lastStart = lastEnd = v;
        continue;
      }
      if (v > lastEnd) lastEnd = v;
    }
    if (segments === 1) {
      var only = { smrStart: min, smrEnd: max, hours: max - min, n: n };
      // `segments` HANYA ditambahkan saat memang ada lebih dari satu segmen.
      // Bentuk objek tanpa reset dijaga PERSIS seperti sebelumnya: uji
      // FUEL-TREND-1 (dan konsumen lama) membandingkannya dengan `deepStrictEqual`
      // terhadap empat field. Menambah field ke bentuk lama tanpa perlu
      // mengubah kontrak = perubahan yang tidak diminta.
      return only;
    }

    // Ada reset: ΔSMR dijumlah PER SEGMEN, bukan max - min.
    var hours = 0, segStart = null, segTop = null;
    for (var j = 0; j < vals.length; j++) {
      var y = vals[j];
      if (segStart == null) { segStart = segTop = y; continue; }
      if (y < segTop && y < floorSmr) {
        hours += (segTop - segStart);
        segStart = segTop = y;
        continue;
      }
      if (y > segTop) segTop = y;
    }
    hours += (segTop - segStart);
    if (!(hours > 0)) return null;
    return {
      smrStart: lastStart, smrEnd: lastEnd, hours: hours, n: n,
      segments: segments
    };
  }

  function trendSeries(trend) {
    var smr = (trend && trend.smr) || [], epoch = (trend && trend.epoch) || [], out = [];
    for (var i = 0; i < smr.length; i++) {
      if (smr[i] == null || !isFinite(smr[i])) continue;
      out.push({ smr: smr[i], date: epoch[i] == null ? null : new Date((epoch[i] + ((trend.tz || [])[i] || 0)) * 1000).toISOString().slice(0, 10) });
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * overloadByMonth(cycles) — TEMUAN INDEPENDEN dari fuel.
   * Overloading kronis = isu umur frame/tyre/powertrain, bukan isu fuel.
   * Sering jadi output PERTAMA yang bisa ditindaklanjuti sebelum trending
   * fuel jalan sama sekali.
   * --------------------------------------------------------------------- */
  function overloadByMonth(cycles, tz) {
    var by = {};
    (cycles || []).forEach(function (c) {
      if (!(c.P > LIMITS.minPayload)) return;
      var m = ymd(c.t, tz || 0).slice(0, 7);
      if (!by[m]) by[m] = { month: m, n: 0, over: 0, payloads: [] };
      by[m].n++;
      if (c.over >= 1) by[m].over++;
      by[m].payloads.push(c.P);
    });
    return Object.keys(by).sort().map(function (m) {
      var b = by[m];
      return {
        month: m, n: b.n,
        overPct: b.n ? b.over / b.n : null,
        payloadMedian: median(b.payloads)
      };
    });
  }

  /* -----------------------------------------------------------------------
   * dailyCorrelation(rows) — HARIAN: apakah unit semakin BOROS atau HEMAT?
   *
   * rows: [{ day, hours, payload(ton akumulasi), loadedKm, fuelRate(L/h) }]
   *   `payload` & `loadedKm` berasal dari payloadn (A0, agregat harian);
   *   `fuelRate` dari trend0 (di-join per tanggal LOKAL).
   *
   * ---------------------------------------------------------------------
   * KENAPA L/TON-KM, BUKAN L/km
   * ---------------------------------------------------------------------
   * BBM/km NAIK saat muatan naik (truk lebih berat) — itu fisika, bukan
   * pemborosan. Memakai L/km akan menyimpulkan "hari dengan muatan besar
   * = boros", lalu operator menurunkan muatan dan konsumsi per ton justru
   * memburuk. Rasio yang bermakna: liter per TON-KM.
   *
   * ---------------------------------------------------------------------
   * KENAPA TIDAK MEMVONIS DARI SAMPEL SEDIKIT
   * ---------------------------------------------------------------------
   * Tren dari 3 titik selalu tampak "trend". Di bawah `minDays` kita tetap
   * menampilkan titik (untuk diperiksa mata) tetapi `trend = null` dan
   * `verdictable = false` — jangan menvonis boros/hemat dari sampel tipis.
   * --------------------------------------------------------------------- */
  var MIN_DAILY_DAYS = 5;

  function dailyCorrelation(rows) {
    var out = {
      metric: 'lTk', unit: 'L/ton-km',
      points: [], dropped: 0, n: 0,
      dropNoData: 0, dropNoFuel: 0,
      slope: null, slopePctPerDay: null, r: null, r2: null, rReason: '',
      trend: null, verdictable: false, reason: ''
    };
    var pts = [];
    var dropped = 0, dropNoData = 0, dropNoFuel = 0;
    (rows || []).forEach(function (d) {
      // `null` BUKAN nol. Payload/jam/rate kosong berarti data tidak ada,
      // bukan "tidak ada muatan" — membuangnya lebih jujur daripada
      // memasukkannya sebagai 0 (0 akan menarik garis tren ke bawah palsu).
      var p = d ? Number(d.payload) : NaN;
      var km = d ? Number(d.loadedKm) : NaN;
      var hr = d ? Number(d.hours) : NaN;
      var fr = d ? Number(d.fuelRate) : NaN;
      // Dua sebab gugur DIPISAH supaya pesan ke pengguna jujur: "hari tanpa
      // data payload/km/jam" berbeda dari "hari tanpa pasangan trend0".
      if (!(p > 0) || !(km > 0) || !(hr > 0)) { dropped++; dropNoData++; return; }
      if (!(fr > 0)) { dropped++; dropNoFuel++; return; }
      var fuel = fr * hr;
      var tkm = p * km;
      pts.push({
        day: d.day, fuel: fuel, tkm: tkm, lTk: fuel / tkm,
        payload: p, loadedKm: km, hours: hr, fuelRate: fr
      });
    });
    out.dropped = dropped;
    out.dropNoData = dropNoData;
    out.dropNoFuel = dropNoFuel;
    pts.sort(function (a, b) { return String(a.day).localeCompare(String(b.day)); });
    out.points = pts;

    if (pts.length < 2) {
      out.reason = 'butuh ≥2 hari valid (dapat ' + pts.length + ')';
      return out;
    }

    // Regresi di ruang LOG: rasio berdistribusi skewed, dan "naik 10 %"
    // harus berarti sama di semua level konsumsi (alasan yang sama dengan
    // verdict jendela, §3.3 dokumen).
    //
    // PUSAT = MEAN, bukan median. [F1 2026-11-07]
    // ---------------------------------------------------------------------
    // Pembilang/penyebut di bawah adalah rumus KUADRAT-TERKECIL. Rumus itu
    // hanya menghasilkan OLS — dan `num/sqrt(den*syy)` hanya menghasilkan
    // Pearson r — bila pusatnya mean. Versi sebelumnya memakai `median`
    // sebagai pusat, sehingga `slope` bukan OLS maupun regresi robust:
    // ia menanggung biaya "tidak baku" tanpa memberi ketahanan pencilan,
    // karena ketahanan datang dari FUNGSI KERUGIAN (least-squares vs
    // least-absolute), bukan dari titik pusat. Terukur: pada data bergap
    // 60 hari (bentuk NYATA unit pilot) pusat median menggeser slope 1,0 %
    // relatif; pada data dengan 1 pencilan ekstrem, median dan mean memberi
    // slope IDENTIK — bukti bahwa median tidak melindungi apa pun di sini.
    var xs = pts.map(function (p) { return Date.UTC(
      Number(String(p.day).slice(0, 4)),
      Number(String(p.day).slice(5, 7)) - 1,
      Number(String(p.day).slice(8, 10))) / 86400000; });
    var ys = pts.map(function (p) { return Math.log(p.lTk); });
    var mx = 0, my = 0;
    for (var k = 0; k < pts.length; k++) { mx += xs[k]; my += ys[k]; }
    mx /= pts.length;
    my /= pts.length;
    var num = 0, den = 0, syy = 0;
    for (var i = 0; i < pts.length; i++) {
      var dx = xs[i] - mx;
      var dy = ys[i] - my;
      num += dx * dy;
      den += dx * dx;
      syy += dy * dy;   // ← simpangan kuadrat Y; DIPAKAI untuk r di bawah
    }
    if (!(den > 0)) {
      out.reason = 'semua hari bertanggal sama';
      return out;
    }
    var slope = num / den;            // satuan: log(L/TKM) per hari
    out.slope = slope;
    // Perubahan persen per hari. Tanda = arah; lihat PENINGKATAN/penurunan
    // sensitivitas: nilai kecil tetap jujur (mis. 0,05 %/hari = ~18 %/tahun).
    out.slopePctPerDay = (Math.exp(slope) - 1) * 100;

    // Korelasi Pearson di ruang log — ukuran KEANDALAN garis tren di atas.
    // ---------------------------------------------------------------------
    // BUG YANG DIPERBAIKI [F1 2026-11-07, akar AUD-1]: loop sebelumnya
    // mengisi akumulator `sy` sementara gerbangnya menguji `syy`. Karena
    // `syy` selamanya 0, gerbang selamanya tertutup dan `r`/`r2` SELALU
    // null — label "R²" di `fuel-render.js` tidak pernah sekali pun muncul,
    // sementara `slope` tetap terbit dan tetap menvonis boros/hemat.
    // Menvonis arah tanpa pernah mengukur keandalannya.
    //
    // `syy` kini dihitung di loop yang SAMA dengan num/den (satu sumber,
    // tidak ada akumulator kedua yang bisa salah sambung lagi).
    //
    // `syy === 0` berarti SELURUH hari punya lTk identik: korelasi TAK
    // TERDEFINISI, bukan nol. Maka `r` tetap null — jangan menyatakan
    // "tidak ada hubungan" padahal yang benar "tidak bisa dijawab".
    if (syy > 0) {
      out.r = num / Math.sqrt(den * syy);
      out.r2 = out.r * out.r;
    } else {
      out.rReason = 'semua hari punya L/TKM identik';
    }
    // `n` WAJIB diterbitkan bersama r2: R² tanpa ukuran sampel tidak bisa
    // dinilai (R² dari 3 titik hampir selalu tinggi). UI menampilkan keduanya.
    out.n = pts.length;

    out.verdictable = pts.length >= MIN_DAILY_DAYS;
    if (!out.verdictable) {
      out.reason = 'butuh ≥' + MIN_DAILY_DAYS + ' hari untuk menvonis arah (dapat ' + pts.length + ')';
      return out;
    }
    // Ambang arah: |0,1 %/hari| ≈ 3 %/bulan. Di bawah itu disebut "stabil"
    // supaya noise harian tidak dilaporkan sebagai tren.
    var perDayPct = out.slopePctPerDay;
    out.trend = (perDayPct > 0.1) ? 'worse' : (perDayPct < -0.1 ? 'better' : 'stable');
    return out;
  }

  /* -----------------------------------------------------------------------
   * fromSummary(summary) — pulihkan hasil analisis dari RINGKASAN TERSIMPAN.
   *
   * [2026-10-28] Menutup keluhan "data terunggah tapi detail tidak bisa
   * dibuka". Sebelumnya unit yang dimuat dari store dipaksa `result: null`
   * sehingga panel detail selalu kosong — padahal `FUEL_STORE.compact()`
   * SUDAH menyimpan seluruh kolom yang dibutuhkan tabel jendela, baseline,
   * counts, dan gateStats.
   *
   * BATAS KEJUJURAN — yang TIDAK bisa dipulihkan dari ringkasan:
   *   - payload per siklus & distribusi `driver` (engine/underload),
   *   - korelasi harian (butuh deret A0),
   *   - atribusi `zG`/`zP` per jendela.
   * Karena itu `restored = true` dipasang agar UI memberi tahu operator
   * bagian mana yang perlu unggah ulang, ALIH-ALIH mengarang angka.
   *
   * @returns {Object|null} hasil berbentuk `analyze()` atau null bila kosong.
   * --------------------------------------------------------------------- */
  function fromSummary(s) {
    if (!s || typeof s !== 'object') return null;
    var wins = Array.isArray(s.windows) ? s.windows : [];
    // Nama field DIPETAKAN ke bentuk `analyze()` (`pen` -> `penalty`,
    // `L` -> `liters`, `ovl` -> `overLoad`). Menyimpan dua tata nama akan
    // membuat renderer memilih nama yang salah dan kolom tampil kosong.
    var windows = wins.map(function (w) {
      var zG = (w.zG == null ? null : w.zG), zP = (w.zP == null ? null : w.zP);
      var verdict = w.verdict || null;
      // Atribusi hanya bermakna untuk jendela yang di-flag (CAUTION/OVER),
      // sama seperti `classify()`. Bila `driver` tersimpan pakai itu; bila
      // tidak, hitung ulang dari z mesin / z beban.
      var driver = (verdict && verdict !== 'NORMAL')
        ? (w.driver || driverFromZs(zG, zP))
        : (w.driver || null);
      return {
        date: w.date, t1: w.t1, dSmr: w.dSmr,
        fuelRate: w.Lh, liters: w.L,
        coverage: w.cov, n: w.n,
        lTk: w.lTk, lGt: w.lGt, penalty: w.pen,
        idle: w.idle, overLoad: w.ovl,
        // `pavg` (payload rata-rata) disimpan sejak revisi 2026-10-28. Unit
        // lama yang ringkasannya belum memuatnya -> null (kolom "—"), BUKAN
        // 0: payload 0 t akan terbaca seperti muatan kosong.
        payloadAvg: (w.pavg == null ? null : w.pavg),
        z: (w.z == null ? null : w.z),
        zG: zG,
        zP: zP,
        verdict: verdict,
        driver: driver,
        // Jendela tersimpan = jendela yang SUDAH layak verdict.
        verdictable: true,
        restored: true
      };
    });
    var counts = s.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 };
    var warnings = (s.warnings || []).slice();

    /* BATAS PEMULIHAN DISEBUT PER BAGIAN, bukan satu kalimat umum.
     * [REVISI 2026-10-28] Kalimat lama berderet "angka & tabel lengkap.
     * Atribusi per siklus dan korelasi harian hanya tersedia setelah unggah
     * ulang" SELALU muncul (juga pada data yang seluruhnya utuh) dan digambar
     * sebagai banner MERAH — terbaca seperti data bermasalah.
     * Sekarang:
     *   - hanya bagian yang BENAR-BENAR kosong yang disebut;
     *   - korelasi harian TIDAK disebut bila berkas payloadn memang tidak
     *     pernah dimuat (unggah ulang tidak akan mengubah apa pun);
     *   - kalimat TIDAK dipakai menyatakan angka valid — sebab semua angka
     *     panel detail (baseline, jendela, verdict) memang utuh.
     * [REVISI 2026-10-28 #2] Peringatan "Rincian penyebab per jendela
     * (mesin vs beban) tidak tersimpan" DIHAPUS. `driver` memang tidak
     * disimpan (`compact()` di fuel-store.js), tetapi kolom z mesin / z beban
     * dan status per jendela tetap tampil, dan tak ada tombol "unggah ulang"
     * per unit — pesannya menakutkan tanpa bisa ditindaklanjuti.
     * Teks ini sumbernya DATA (`s`), bukan UI.
     */
    if (s.dailyLoaded) {
      // Berkas harian ADA saat unit disimpan, tetapi deretnya tidak ikut
      // disimpan -> panel korelasi harian kosong dan itu bukan salah data.
      warnings.push('Deret harian (payloadn) tidak disimpan — panel korelasi ' +
        'harian kosong. Unggah ulang unit bila panel itu perlu.');
    }
    return {
      model: s.model || '',
      emptyWeight: (s.emptyWeight == null ? null : s.emptyWeight),
      limits: LIMITS,
      windows: windows,
      trace: windows.slice(),
      gateStats: s.gateStats || {},
      eligible: (s.eligible == null ? windows.length : s.eligible),
      ready: !!s.ready,
      usable: !!s.usable,
      baseline: s.baseline || null,
      counts: { NORMAL: counts.NORMAL || 0, CAUTION: counts.CAUTION || 0, OVER: counts.OVER || 0 },
      // [FIX 2026-10-28] Cakupan trend0 (SMR awal/akhir + jam operasi) dan
      // rata-rata Fuel Rate HARUS ikut dipulihkan. Tanpanya, unit yang dimuat
      // dari penyimpanan tampil dengan "—" di kolom SMR Awal/SMR Akhir/Total
      // Operation/Fuel Rate/Proyeksi — padahal ringkasannya menyimpan angka
      // itu. `windows` tidak bisa menggantikannya: SMR mulai tercatat sejak
      // jendela PERTAMA yang valid, bukan sejak record pertama berkas.
      trendExtent: s.trendExtent || null,
      trendSeries: s.trendSeries || null,
      fuelRateAvg: (s.fuelRateAvg == null ? null : s.fuelRateAvg),
      totalCyclePayload: (s.totalCyclePayload == null ? null : s.totalCyclePayload),
      totalCycleCount: (s.totalCycleCount == null ? null : s.totalCycleCount),
      // Unit yang disimpan SEBELUM revisi ini tidak punya rekap harian ->
      // null. UI HARUS membacanya sebagai "tidak tersedia" ("—"), bukan nol.
      cycleDaily: s.cycleDaily || null,
      warnings: warnings,
      restored: true
    };
  }

  var FUEL_ANALYTICS = {
    LIMITS: LIMITS,
    MIN_SIGMA_LOG: MIN_SIGMA_LOG,
    MIN_DAILY_DAYS: MIN_DAILY_DAYS,
    analyze: analyze,
    fromSummary: fromSummary,
    overloadByMonth: overloadByMonth,
    dailyCorrelation: dailyCorrelation,
    // bagian murni, diekspor untuk uji unit & pemakaian lanjutan
    buildWindows: buildWindows,
    gateCycle: gateCycle,
    computeMetrics: computeMetrics,
    attachCycles: attachCycles,
    classify: classify,
    trendExtent: trendExtent,
    meanFuelRate: meanFuelRate,
    totalCyclePayload: totalCyclePayload,
    totalCycleCount: totalCycleCount,
    // [SUPPORT 2026-10-30] Satu definisi idle untuk rekap harian — dipakai
    // panel Between. Sumbernya SAMA dengan `computeMetrics()` (sE+sL+sLd).
    idleMinutes: idleMinutes,
    cycleDaily: cycleDaily,
    driverFromZs: driverFromZs,
    resolveEmptyWeight: resolveEmptyWeight,
    median: median,
    madN: madN,
    ymd: ymd
  };

  global.FUEL_ANALYTICS = FUEL_ANALYTICS;
  if (typeof module !== 'undefined' && module.exports) module.exports = FUEL_ANALYTICS;

})(typeof window !== 'undefined' ? window : globalThis);

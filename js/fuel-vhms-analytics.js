/* =========================================================================
 * fuel-vhms-analytics.js
 * -------------------------------------------------------------------------
 * Modul analitik korelasi parameter teknis VHMS (Machine Health) terhadap
 * efisiensi bahan bakar (Fuel Intelligence) dan generator Report Failure Mode.
 *
 * Murni: tanpa manipulasi DOM, tanpa localStorage, tanpa ketergantungan UI.
 * Kompatibel dengan Browser maupun Node.js.
 * ========================================================================= */

(function (global) {
  'use strict';

  var FVA = {};

  /* -----------------------------------------------------------------------
   * 1. Utilitas Matematika & Statistik
   * --------------------------------------------------------------------- */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    var valid = arr.filter(isNum);
    if (!valid.length) return null;
    var s = valid.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function average(arr) {
    if (!arr || !arr.length) return null;
    var valid = arr.filter(isNum);
    if (!valid.length) return null;
    var sum = valid.reduce(function (a, b) { return a + b; }, 0);
    return sum / valid.length;
  }

  /**
   * Menghitung korelasi Pearson (r), koefisien determinasi (R2),
   * slope (m), dan intercept (c) dari deret x dan y: y = m*x + c.
   */
  function correlate(x, y) {
    if (!x || !y || x.length !== y.length) return null;
    var pairs = [];
    for (var i = 0; i < x.length; i++) {
      if (isNum(x[i]) && isNum(y[i])) {
        pairs.push([x[i], y[i]]);
      }
    }
    var n = pairs.length;
    if (n < 3) return null;

    var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (var j = 0; j < n; j++) {
      var xi = pairs[j][0];
      var yi = pairs[j][1];
      sx += xi;
      sy += yi;
      sxx += xi * xi;
      syy += yi * yi;
      sxy += xi * yi;
    }

    var varX = (n * sxx - sx * sx);
    var varY = (n * syy - sy * sy);
    var denom = Math.sqrt(varX * varY);

    // VARIANS NOL => `null`, BUKAN r:0. [F1 2026-11-07, akar AUD-13]
    // ---------------------------------------------------------------------
    // Bila seluruh x identik (mis. semua unit punya blowby sama) korelasi
    // TAK TERDEFINISI. Versi sebelumnya mengembalikan `{r:0, r2:0, slope:0}`,
    // yang mengubah "tidak bisa dijawab" menjadi "sudah terbukti tidak ada
    // hubungan" — dua pernyataan yang sangat berbeda bagi orang yang
    // memutuskan overhaul. `slope:0` juga ikut terbit dan bisa dipakai
    // menggambar garis datar yang tampak berwibawa.
    //
    // Mengembalikan null menyatukan perilaku dengan gerbang `n < 3` di atas:
    // pemanggil SUDAH wajib menangani null, jadi tidak ada jalur baru.
    if (!(denom > 0) || !isFinite(denom)) {
      return null;
    }

    var r = (n * sxy - sx * sy) / denom;
    var r2 = r * r;
    var slope = (n * sxy - sx * sy) / varX;
    var intercept = (sy - slope * sx) / n;

    return {
      n: n,
      r: r,
      r2: r2,
      slope: slope,
      intercept: intercept
    };
  }

  /**
   * [F5 2026-11-10] KORELASI TINGKAT UNIT (Unit-to-Unit).
   * =========================================================
   * Menghitung R² antara median blowby per unit dan median lGt per unit.
   * Menjawab: "Apakah SECARA KESELURUHAN, unit dengan blowby lebih tinggi
   * cenderung lebih boros?" — berdasarkan 1 titik per unit, bukan pencampuran
   * jendela dari 30 unit yang berbeda.
   *
   * Return: { n, r, r2, slope, intercept } atau null jika < 3 unit.
   *
   * [CATATAN F5 2026-11-10] Fungsi ini INDEPENDEN, tidak perlu outer scope.
   */
  function correlateUnitToUnit(evaluatedUnits) {
    if (!evaluatedUnits || evaluatedUnits.length < 3) return null;
    var pairs = [];
    evaluatedUnits.forEach(function (u) {
      if (isNum(u.medianBlowby) && isNum(u.medianLgt)) {
        pairs.push([u.medianBlowby, u.medianLgt]);
      }
    });
    if (pairs.length < 3) return null;
    
    var n = pairs.length;
    var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (var j = 0; j < n; j++) {
      var xi = pairs[j][0];
      var yi = pairs[j][1];
      sx += xi;
      sy += yi;
      sxx += xi * xi;
      syy += yi * yi;
      sxy += xi * yi;
    }

    var varX = (n * sxx - sx * sx);
    var varY = (n * syy - sy * sy);
    var denom = Math.sqrt(varX * varY);

    if (!(denom > 0) || !isFinite(denom)) return null;

    var r = (n * sxy - sx * sy) / denom;
    var r2 = r * r;
    var slope = (n * sxy - sx * sy) / varX;
    var intercept = (sy - slope * sx) / n;

    return {
      n: n,
      r: r,
      r2: r2,
      slope: slope,
      intercept: intercept
    };
  }

  /**
   * [F5 2026-11-10] KORELASI DALAM-UNIT (Within-Unit) — PLACEHOLDER.
   * ==================================================================
   * Fungsi ini perlu mengakses allMatchedRows dari outer scope analyzeFleet(),
   * jadi implementasi pindah ke dalam analyzeFleet() itu sendiri.
   * TODO: Implementasi di bawah adalah GARIS BESAR, dipindahkan in-place.
   */
  function correlateWithinUnits(evaluatedUnits, allMatchedRows) {
    // PLACEHOLDER: implementasi di bawah dalam analyzeFleet().
    // Menunggu refactor scope.
    return null;
  }

  /* -----------------------------------------------------------------------
   * Konfigurasi Default Environment-Adjusted Baseline (EAB)
   * --------------------------------------------------------------------- */

  /* [F4 JALAN C 2026-11-08] KONSTANTA HAFALAN DICABUT.
   * =====================================================================
   * Riwayat singkat yang harus dibaca sebelum mengubah blok ini:
   *
   * Dokumen `KONSEP_ENVIRONMENT_ADJUSTED_BASELINE_2026-11-03.md` mengklaim
   * `kPayload 0.35` "dikalibrasi dari karakteristik HD785" dan tahap EAB-7
   * "Kalibrasi kP & kRR dengan data riil armada — SELESAI". Grep `test/` +
   * `tools/`: NOL alat kalibrasi, NOL uji kalibrasi. Bukti kelulusan yang
   * dituliskan hanya "Test-suite Lulus" — padahal test-suite hanya
   * memverifikasi ARITMETIKA `0.6 x 0.48`, bukan bahwa 0.6 angka yang benar.
   *
   * Probe pada data NYATA (D:\DATA, 29 folder, 1206 jendela; GPS harian
   * `sample-data/data-gps/gps-daily-kpi.csv`, 3439 baris) menunjukkan:
   *
   *   kPayload  : TIDAK TERIDENTIFIKASI dan secara struktural SALAH.
   *               `lGt = L/GTKM` dan `GTKM = (Me+P)dL + Me dE` -> payload
   *               SUDAH ada di penyebut. Terukur r(pavg,lTk) = -0.793 vs
   *               r(pavg,lGt) = -0.407 (1.95x) => lGt sudah
   *               payload-normalized. Menormalkan lagi = KOREKSI GANDA.
   *               R2 per unit p50 = 0.018; tanda tak konsisten (5/20 unit
   *               negatif); BEFORE vs AFTER unit SAMA bergeser s/d 1.29.
   *               => DICABUT, bukan dikalibrasi.
   *
   *   wIdle     : DIDUKUNG data. r(idle, log lGt) p50 = +0.304, 19/20 unit
   *               positif. Dugaan p50 = 1.111 (bukan 0.6).
   *
   *   kRR       : DIDUKUNG data, dan 1.5 ternyata ~13x TERLALU KECIL.
   *               Dugaan per unit: 10.96 / 16.50 / 19.58 / 33.95 (p50 19.58),
   *               4/4 arah positif, R2 p50 = 0.482 — faktor TERKUAT yang
   *               ditemukan. Tetapi cakupan grade hanya 81/1206 = 6.7 %
   *               karena GPS hanya 2026-08-01..11-01.
   *
   * Karena itu konfigurasi di bawah TIDAK memuat nilai koreksi. Nilai
   * `wIdleCalibrated` / `kRollingResistCalibrated` HANYA boleh diisi oleh
   * `calibrateEab()` dari data yang dimuat. Bila kalibrasi gagal gerbang,
   * nilainya tetap `null` dan koreksi TIDAK DITERAPKAN — persis disiplin
   * `MIN_SIGMA_LOG`/`fabricated` yang sudah berlaku di modul ini.
   * ------------------------------------------------------------------- */
  var EAB_CONFIG = {
    idleMaxThreshold: 0.55,    // Jendela dengan idle > 55% dikecualikan dari baseline
    covMinThreshold: 0.65,     // Coverage minimum (65%) agar jendela masuk baseline

    /* Parameter koreksi — TIDAK ADA NILAI DEFAULT. Diisi `calibrateEab()`. */
    wIdleCalibrated: null,              // bobot idle hasil dugaan data
    kRollingResistCalibrated: null,     // koef grade hasil dugaan data

    /* Gerbang keberartian kalibrasi (bukan nilai koreksi — ini ambang
     * KECUKUPAN BUKTI, diturunkan dari sebaran nyata data pilot). */
    minCalWindows: 10,        // jendela minimum per unit agar unitnya ikut
    minCalUnits: 3,           // unit minimum lolos agar dugaan armada terbit
    minSdIdle: 0.02,          // sebaran idle minimum (terukur sd ~0.04-0.06)
    minSdGrade: 0.20,         // sebaran grade minimum (terukur sd ~0.39-0.84)

    enableGradeCorr: true,    // boleh dimatikan operator
    enableIdleCorr: true
  };

  /* ---------------------------------------------------------------------
   * calibrateEab(rows) — menduga parameter koreksi DARI DATA.
   * -------------------------------------------------------------------
   * METODE (dan mengapa bentuknya eksponensial):
   *   `w` diduga sebagai slope regresi `log(lGt) ~ idle` DI DALAM unit.
   *   Estimator itu hanya konsisten bila koreksinya `exp(-w*idle)`.
   *   Terukur pada 20 unit, sd(log lGt) dalam-unit TURUN pada:
   *       bentuk `lGt*(1-w*idle)` (EAB lama) : 17/20
   *       bentuk `lGt/(1+w*idle)`            : 20/20
   *       bentuk `lGt*exp(-w*idle)`          : 20/20
   *   Bentuk pengali bisa MELEDAK: HDKM78567 (w=2.368) membuat sd
   *   0.2789 -> 0.4324 (+55 %) karena `(1-w*idle)` mendekati nol.
   *   `exp()` tidak punya titik ledak dan cocok dengan estimatornya.
   *
   *   `kRR` diduga dari `lGt ~ a + b*grade` (ruang asli) => kRR = (b/a)*100,
   *   lalu diterapkan sebagai `exp(-kRR*g/100)` agar sejalan.
   *
   * DI DALAM UNIT, bukan antar unit: kondisi mesin ~konstan di dalam unit,
   * sehingga koreksi tidak menyerap efek keausan (confounding). Antar unit,
   * perbedaan lGt justru BERISI informasi keausan yang ingin dideteksi.
   *
   * @param {Array} rows baris ter-join { unit, lGt, idle, avgGradePct }
   * @param {Object} [cfg] override gerbang
   * @returns {Object} { wIdle:{ok,value,reason,nUnits,perUnit}, kRR:{...} }
   * ------------------------------------------------------------------- */
  function _olsIn(xs, ys) {
    var n = 0, mx = 0, my = 0, i;
    var X = [], Y = [];
    for (i = 0; i < xs.length; i++) {
      if (isNum(xs[i]) && isNum(ys[i])) { X.push(xs[i]); Y.push(ys[i]); }
    }
    n = X.length;
    if (n < 3) return null;
    for (i = 0; i < n; i++) { mx += X[i]; my += Y[i]; }
    mx /= n; my /= n;
    var num = 0, den = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = X[i] - mx, dy = Y[i] - my;
      num += dx * dy; den += dx * dx; syy += dy * dy;
    }
    if (!(den > 0) || !(syy > 0)) return null;
    var b = num / den;
    var r = num / Math.sqrt(den * syy);
    return { n: n, a: my - b * mx, b: b, r2: r * r, sdx: Math.sqrt(den / n) };
  }

  function calibrateEab(rows, cfg) {
    cfg = Object.assign({}, EAB_CONFIG, cfg || {});
    rows = rows || [];

    var byUnit = {};
    rows.forEach(function (r) {
      if (!r || !r.unit) return;
      (byUnit[r.unit] = byUnit[r.unit] || []).push(r);
    });
    var unitNames = Object.keys(byUnit);

    /* Satu putaran dugaan untuk satu parameter. `kind` memilih model. */
    function estimate(kind) {
      var perUnit = [];
      unitNames.forEach(function (u) {
        var w = byUnit[u];
        var xs = [], ys = [];
        w.forEach(function (r) {
          var lGt = isNum(r.lGt) ? r.lGt : null;
          if (!(lGt > 0)) return;
          if (kind === 'idle') {
            var idle = isNum(r.idle) ? r.idle : null;
            if (!(idle > 0) || !(idle < 1)) return;
            xs.push(idle); ys.push(Math.log(lGt));
          } else {
            // grade == 0 BUKAN "rute datar" — di data GPS itu artinya hari
            // tanpa grade terukur (17,9 % baris). Harus dikecualikan.
            var g = isNum(r.avgGradePct) ? r.avgGradePct : null;
            if (!(g > 0)) return;
            xs.push(g); ys.push(lGt);
          }
        });
        var f = _olsIn(xs, ys);
        if (!f) return;
        var minSd = (kind === 'idle') ? cfg.minSdIdle : cfg.minSdGrade;
        var value = (kind === 'idle') ? f.b : ((f.a > 0) ? (f.b / f.a) * 100 : null);
        if (value == null || !isFinite(value)) return;
        perUnit.push({
          unit: u, n: f.n, sdx: f.sdx, value: value, r2: f.r2,
          pass: (f.n >= cfg.minCalWindows && f.sdx >= minSd)
        });
      });

      var pass = perUnit.filter(function (p) { return p.pass; });
      if (pass.length < cfg.minCalUnits) {
        /* Tidak cukup bukti. `value: null` => koreksi TIDAK DITERAPKAN.
         * JANGAN jatuh ke konstanta hafalan (pelajaran F3/AUD-11). */
        return {
          ok: false, reason: 'insufficient-units', value: null,
          nUnits: pass.length, nUnitsTried: perUnit.length, perUnit: perUnit
        };
      }
      var vals = pass.map(function (p) { return p.value; });
      var v = median(vals);
      if (v == null || !isFinite(v)) {
        return { ok: false, reason: 'no-median', value: null, nUnits: pass.length, nUnitsTried: perUnit.length, perUnit: perUnit };
      }
      // Arah WAJIB sesuai asumsi fisik: idle naik => konsumsi/ton-km naik;
      // grade naik => konsumsi naik. Nilai <= 0 berarti data menolak asumsi.
      if (!(v > 0)) {
        return { ok: false, reason: 'direction-rejected', value: null, nUnits: pass.length, nUnitsTried: perUnit.length, perUnit: perUnit, median: v };
      }
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      return {
        ok: true, reason: null, value: v,
        nUnits: pass.length, nUnitsTried: perUnit.length,
        p25: sorted[Math.floor(sorted.length * 0.25)],
        p75: sorted[Math.floor(sorted.length * 0.75)],
        nPositive: vals.filter(function (x) { return x > 0; }).length,
        perUnit: perUnit
      };
    }

    return {
      wIdle: cfg.enableIdleCorr === false
        ? { ok: false, reason: 'disabled', value: null, nUnits: 0, nUnitsTried: 0, perUnit: [] }
        : estimate('idle'),
      kRR: cfg.enableGradeCorr === false
        ? { ok: false, reason: 'disabled', value: null, nUnits: 0, nUnitsTried: 0, perUnit: [] }
        : estimate('grade')
    };
  }

  /**
   * Menormalisasi konsumsi bahan bakar (lGt) terhadap faktor lingkungan (EAB):
   * 1. Idle fraction correction (wIdle)
   * 2. Payload deviation normalization (kPayload)
   * 3. Road gradient / rolling resistance compensation (kRollingResist)
   *
   * @param {Object} w Jendela fuel { lGt, idle, cov, pavg, payloadAvg, ... }
   * @param {number} [fleetPayloadMedian] Median payload armada (ton)
   * @param {number} [avgGradePct] Kemiringan jalan rata-rata (%)
   * @param {Object} [cfg] Override konfigurasi EAB
   * @returns {Object} { lGtEnv, lGtRaw, excluded, reason, icFactor, payloadFactor, gradeFactor }
   */
  function normalizeEnv(w, fleetPayloadMedian, avgGradePct, cfg) {
    cfg = Object.assign({}, EAB_CONFIG, cfg || {});
    if (!w) {
      return { lGtEnv: null, lGtRaw: null, excluded: true, reason: 'no-data', icFactor: 1, payloadFactor: 1, gradeFactor: 1 };
    }

    /* [F3 2026-11-07, akar AUD-2/S-1] Konstanta `0.38` DICABUT.
     * -------------------------------------------------------------------
     * `0.38` = 1/2,6167 adalah GTKM/TKM TERUKUR dari SATU unit pilot
     * (memori `fitur-fuel-trending-2026-10-28.md`). Memakainya sebagai
     * konstanta universal berarti memaku ulang rasio massa-kosong/muatan
     * armada yang sebenarnya BERVARIASI per unit & per siklus (bergantung
     * payload aktual dan jarak loaded/empty) — ini akar yang memori proyek
     * tandai `FUEL-b` dan secara eksplisit DILARANG.
     *
     * Rasio GTKM/TKM yang benar = (Me+P)·dL + Me·dE dibagi P·dL, dihitung
     * PER SIKLUS di `fuel-analytics.js:computeMetrics()`. Pada level jendela
     * (agregat) di sini, P/dL/dE individual sudah tidak ada — hanya `lTk`
     * agregat tersisa. Tidak ada cara JUJUR menurunkan `lGt` dari `lTk` di
     * titik ini tanpa menebak rasio (persis yang `0.38` lakukan).
     *
     * Maka: TANPA `lGt` eksplisit ⇒ `null`, BUKAN ditaksir dari `lTk`.
     * `fuel-store.js:compact()` SELALU menyimpan `lGt` berdampingan `lTk`
     * untuk unit yang dianalisis modul ini sendiri, sehingga dalam
     * pemakaian normal cabang ini jarang tereksekusi — tetapi kalaupun
     * tereksekusi (data eksternal/API langsung), ia menahan diri. */
    var lGt = isNum(w.lGt) ? w.lGt : null;
    if (!isNum(lGt) || lGt <= 0) {
      return { lGtEnv: null, lGtRaw: lGt, excluded: true, reason: 'no-lgt', icFactor: 1, payloadFactor: 1, gradeFactor: 1 };
    }

    var idle = isNum(w.idle) ? w.idle : (isNum(w.idleFraction) ? w.idleFraction : 0);
    var cov  = isNum(w.cov)  ? w.cov  : (isNum(w.coverage) ? w.coverage : 1);
    var pavg = isNum(w.pavg) ? w.pavg : (isNum(w.payloadAvg) ? w.payloadAvg : null);

    // Filter jendela tidak representatif dari baseline
    var excluded = false;
    var reason = null;

    if (idle > cfg.idleMaxThreshold) {
      excluded = true;
      reason = 'idle-high';
    } else if (cov < cfg.covMinThreshold) {
      excluded = true;
      reason = 'cov-low';
    } else if (isNum(cfg.p10PayloadMin) && isNum(pavg) && pavg < cfg.p10PayloadMin) {
      excluded = true;
      reason = 'payload-low';
    }

    /* Langkah 1: Idle Correction — BENTUK EKSPONENSIAL. [F4 2026-11-08]
     * -------------------------------------------------------------------
     * Formula: lGt_ic = lGt * exp(-w * idle)
     *
     * Bentuk lama `lGt * (1 - w*idle)` DIGANTI karena dua alasan terukur:
     *  (a) Ia tidak konsisten dengan estimatornya. `w` diduga sebagai slope
     *      regresi `log(lGt) ~ idle`; estimator itu menuntut koreksi
     *      `exp(-w*idle)`. Memakai bentuk lain berarti menduga satu hal lalu
     *      menerapkan hal lain.
     *  (b) Ia MELEDAK. `(1 - w*idle)` mendekati nol saat `w*idle -> 1`.
     *      Terukur: HDKM78567 (w=2.368, idle p50 0.351) membuat sd(log lGt)
     *      dalam-unit NAIK 0.2789 -> 0.4324 (+55 %). Dengan `exp()` ia
     *      TURUN ke 0.2556 (-8 %).
     *      Rekap 20 unit: sd turun pada bentuk KALI 17/20, EXP 20/20.
     *
     * `wIdleUsed` berasal dari kalibrasi data (`calibrateEab`). Bila `null`
     * (kalibrasi gagal gerbang) koreksi TIDAK DITERAPKAN -- faktor 1.0 --
     * bukan jatuh ke konstanta hafalan. */
    var wIdleUsed = isNum(cfg.wIdleCalibrated) ? cfg.wIdleCalibrated : null;
    var clIdle = Math.max(0, Math.min(1, idle));
    var icFactor = 1.0;
    var idleApplied = false;
    if (cfg.enableIdleCorr !== false && wIdleUsed != null && clIdle > 0) {
      icFactor = Math.exp(-wIdleUsed * clIdle);
      idleApplied = true;
    }
    var lGtIc = lGt * icFactor;

    /* Langkah 2: Payload Normalization — DICABUT. [F4 2026-11-08, AUD-2 lanjut]
     * -------------------------------------------------------------------
     * `lGt = liters/GTKM` dengan `GTKM = (Me+P)dL + Me dE` -- payload SUDAH
     * berada di penyebutnya. Terukur pada 1206 jendela nyata:
     *     r(pavg, lTk) = -0.7933   (lTk tidak menormalkan berat kosong)
     *     r(pavg, lGt) = -0.4068   (lGt sudah menormalkannya)  => 1.95x
     * Menormalkan lGt LAGI dengan `(fleetMed/pavg)^kP` = mengoreksi dua kali.
     * Diperkuat: R2 per unit p50 hanya 0.018, tanda tak konsisten (5/20 unit
     * negatif), dan nilainya bergeser s/d 1.29 antara BEFORE/AFTER unit yang
     * SAMA -- ciri derau, bukan parameter fisik.
     *
     * `payloadFactor` dipertahankan di keluaran bernilai 1.0 supaya pembaca
     * lama (tabel/CSV/uji) tidak pecah, tetapi ia tidak lagi mengubah apa pun. */
    var payloadFactor = 1.0;   // [F4] payload normalization DICABUT
    var lGtPn = lGtIc;

    /* Langkah 3: Grade Normalization — EKSPONENSIAL, parameter terkalibrasi.
     * -------------------------------------------------------------------
     * Formula: lGt_norm = lGt_pn * exp(-kRR * g/100)
     *
     * `kRR` dari kalibrasi data. Konstanta lama 1.5 terbukti ~13x TERLALU
     * KECIL: dugaan per unit 10.96 / 16.50 / 19.58 / 33.95 (p50 19.58),
     * 4/4 arah positif, R2 p50 0.482 -- faktor penjelas TERKUAT yang
     * ditemukan. Pada populasi ber-grade, normalisasi ini menurunkan
     * sd(log lGt) pada 5/6 unit (HDKM78526 -56 %).
     *
     * `g <= 0` TIDAK dikoreksi: di `gps-daily-kpi.csv`, `grade_avg_pct = 0`
     * muncul pada 614/3439 baris (17.9 %) dan artinya "hari tanpa grade
     * terukur", BUKAN "rute datar". Memperlakukannya sebagai datar akan
     * mengklaim koreksi yang tidak pernah terjadi. */
    var kRRUsed = isNum(cfg.kRollingResistCalibrated) ? cfg.kRollingResistCalibrated : null;
    var gradeFactor = 1.0;
    var lGtNorm = lGtPn;
    var gradeApplied = false;
    if (cfg.enableGradeCorr !== false && kRRUsed != null && isNum(avgGradePct) && avgGradePct > 0) {
      gradeFactor = Math.exp(-kRRUsed * (avgGradePct / 100));
      lGtNorm = lGtPn * gradeFactor;
      gradeApplied = true;
    }

    /* `envApplied` — status koreksi per jendela. WAJIB terbit. [F4]
     * -------------------------------------------------------------------
     * Terukur (hipotesis H3): kenaikan sd pada percobaan pertama bukan
     * karena koreksi grade salah, melainkan karena MENCAMPUR 6.7 % jendela
     * ter-koreksi dengan 93.3 % yang tidak. `lGtEnv` hanya sah dibandingkan
     * antar jendela yang status koreksinya SAMA -- karena itu statusnya
     * harus terlihat, bukan tersembunyi. */
    var envApplied = (idleApplied ? 'I' : '') + (gradeApplied ? 'G' : '');

    return {
      lGtEnv: lGtNorm,
      lGtRaw: lGt,
      excluded: excluded,
      reason: reason,
      icFactor: icFactor,
      payloadFactor: payloadFactor,
      gradeFactor: gradeFactor,
      idleApplied: idleApplied,
      gradeApplied: gradeApplied,
      envApplied: envApplied
    };
  }

  /* -----------------------------------------------------------------------
   * 2. Pengelompokan Tingkat Degradasi (Degradation Binning)
   * --------------------------------------------------------------------- */

  var DEFAULT_BLOWBY_BINS = [
    { id: 'b-base', label: 'Normal Baseline (< 2.8 kPa)',    min: -Infinity, max: 2.8 },
    { id: 'b-mod',  label: 'Moderate Normal (2.8 - 3.2 kPa)', min: 2.8,       max: 3.2 },
    { id: 'b-elev', label: 'Elevated (3.2 - 4.0 kPa)',        min: 3.2,       max: 4.0 },
    { id: 'b-warn', label: 'High Warning (4.0 - 5.0 kPa)',    min: 4.0,       max: 5.0 },
    { id: 'b-crit', label: 'Critical Alert (>= 5.0 kPa)',     min: 5.0,       max: Infinity }
  ];

  /**
   * Mengelompokkan baris hasil join ke dalam bin degradasi blow-by
   * dan menghitung metrik konsumsi agregat per kelompok (termasuk normalisasi EAB).
   */
  function binAnalysis(rows, binDefs, envOptions) {
    if (binDefs && !Array.isArray(binDefs) && typeof binDefs === 'object') {
      envOptions = binDefs;
      binDefs = null;
    }

    var defs = binDefs || DEFAULT_BLOWBY_BINS;
    var bins = defs.map(function (d) {
      return {
        id: d.id,
        label: d.label,
        min: d.min,
        max: d.max,
        items: []
      };
    });

    var hasEnvOptions = !!(envOptions && envOptions.enabled !== false);
    var fleetPayloadMed = null;
    var eabCfg = null;

    if (hasEnvOptions) {
      var allPavg = (rows || []).map(function (r) {
        return isNum(r.pavg) ? r.pavg : (isNum(r.payloadAvg) ? r.payloadAvg : null);
      }).filter(isNum);

      fleetPayloadMed = isNum(envOptions.fleetPayloadMedian)
        ? envOptions.fleetPayloadMedian
        : (median(allPavg) || null);

      eabCfg = Object.assign({}, EAB_CONFIG, envOptions.eabConfig || {});
      if (!isNum(eabCfg.p10PayloadMin) && allPavg.length >= 10) {
        var sortedP = allPavg.slice().sort(function (a, b) { return a - b; });
        var p10Idx = Math.floor(sortedP.length * 0.1);
        eabCfg.p10PayloadMin = sortedP[p10Idx];
      }
    }

    var processedRows = (rows || []).map(function (r) {
      if (!hasEnvOptions) return r;
      if (isNum(r.lGtEnv) && r.excludedFromBaseline != null && !envOptions.recompute) {
        return r;
      }
      var grade = null;
      if (typeof envOptions.getGradeForUnit === 'function') {
        grade = envOptions.getGradeForUnit(r.unit, r.date);
      } else if (isNum(r.avgGradePct)) {
        grade = r.avgGradePct;
      }
      var norm = normalizeEnv(r, fleetPayloadMed, grade, eabCfg);
      return Object.assign({}, r, {
        lGtEnv: norm.lGtEnv,
        lGtRaw: norm.lGtRaw,
        excludedFromBaseline: norm.excluded,
        excludeReason: norm.reason
      });
    });

    processedRows.forEach(function (r) {
      if (!isNum(r.blowby)) return;
      for (var i = 0; i < bins.length; i++) {
        var b = bins[i];
        if (r.blowby >= b.min && r.blowby < b.max) {
          b.items.push(r);
          break;
        }
      }
    });

    /* Cari baseline dari bin terendah yang memiliki minimal 5 sampel.
     * [F3 2026-11-07, akar AUD-12] Bin yang DILEWATI karena n < 5 kini
     * DICATAT di `baselineSkipped` — sebelumnya bin tersehat bisa dilewati
     * senyap (mis. 4 sampel sehat dilewati → baseline naik dari bin kedua,
     * +50 % pada kasus terukur) tanpa jejak apa pun di keluaran. */
    var baselineBin = null;
    var baselineSkipped = [];
    for (var j = 0; j < bins.length; j++) {
      if (bins[j].items.length >= 5) {
        baselineBin = bins[j];
        break;
      }
      if (bins[j].items.length > 0) {
        baselineSkipped.push({ binId: bins[j].id, label: bins[j].label, n: bins[j].items.length });
      }
    }

    /* [F3 2026-11-07, akar AUD-11] TIDAK ADA fallback `|| 0.0442` / `|| 73.0`.
     * -------------------------------------------------------------------
     * Versi sebelumnya menerbitkan baseline HAFALAN bila tak ada bin yang
     * layak (n>=5 di MANA PUN) — terukur: nol sampel sehat tetap melahirkan
     * `baseLgt=0.0442`, lalu delta +103,6% terhitung terhadap fiksi itu,
     * TANPA bendera apa pun yang memberi tahu UI bahwa angka itu dikarang.
     *
     * Sekarang: tak ada bin >= 5 sampel DI MANA PUN ⇒ `baseLgt`/`baseFr` JADI
     * NULL + `fabricated:true`. Konsumen hilir (evaluateTechnicalPenalty,
     * classifyQuadrant via analyzeFleetEngineFuel) SUDAH null-aware sejak
     * perbaikan ini — baseline null ⇒ delta null ⇒ TIDAK ADA vonis, TIDAK
     * ADA Rupiah. Persis disiplin `MIN_SIGMA_LOG`/`usable` yang sudah ada
     * di `fuel-analytics.js` sejak modul lama, kini diwarisi modul ini. */
    var fabricated = !baselineBin;
    if (!baselineBin) baselineBin = bins[0];

    var baseLgt = fabricated ? null : (median(baselineBin.items.map(function (m) { return m.lGt; })));
    var baseFr = fabricated ? null : (median(baselineBin.items.map(function (m) { return m.fuelRate; })));
    if (!fabricated && (baseLgt == null || baseFr == null)) {
      // Bin ada, tapi seluruh itemnya kebetulan tanpa lGt/fuelRate valid —
      // kondisi tepi yang sama tidak layaknya "nol bin memenuhi syarat".
      fabricated = true;
      baseLgt = null;
      baseFr = null;
    }

    // Hitung baseline EAB (hanya dari sampel non-excluded)
    var baseLgtEnv = baseLgt;
    if (!fabricated) {
      var baseItemsForEnv = baselineBin.items.filter(function (m) {
        return !m.excludedFromBaseline && isNum(m.lGtEnv);
      });
      if (baseItemsForEnv.length < 3) {
        baseItemsForEnv = baselineBin.items.filter(function (m) { return isNum(m.lGtEnv); });
      }
      if (baseItemsForEnv.length) {
        baseLgtEnv = median(baseItemsForEnv.map(function (m) { return m.lGtEnv; }));
        if (baseLgtEnv == null) baseLgtEnv = baseLgt;
      }
    }

    var summary = bins.map(function (b) {
      var n = b.items.length;
      var nExcluded = b.items.filter(function (m) { return m.excludedFromBaseline === true; }).length;
      if (!n) {
        return {
          id: b.id, label: b.label, n: 0, nExcluded: 0,
          medLgt: null, deltaLgtPct: null,
          medLgtEnv: null, deltaLgtEnvPct: null,
          medFr: null, deltaFrPct: null
        };
      }
      var medLgt = median(b.items.map(function (m) { return m.lGt; }));
      var medFr = median(b.items.map(function (m) { return m.fuelRate; }));
      // [F3 2026-11-07] `baseLgt`/`baseFr` bisa NULL (baseline tak layak) —
      // delta WAJIB null juga, bukan 0. `0` adalah klaim "sama dengan
      // baseline"; tanpa baseline, klaim itu tidak bisa dibuat.
      var deltaLgtPct = (isNum(baseLgt) && baseLgt > 0 && medLgt != null) ? ((medLgt - baseLgt) / baseLgt) * 100 : null;
      var deltaFrPct = (isNum(baseFr) && baseFr > 0 && medFr != null) ? ((medFr - baseFr) / baseFr) * 100 : null;

      /* EAB Normalisasi — pengecualian SIMETRIS. [F3 2026-11-07, akar AUD-10]
       * ---------------------------------------------------------------
       * Sebelumnya `excludedFromBaseline` dipakai HANYA saat menyusun
       * baseline; pembanding (median per bin) memasukkan SEMUA item
       * termasuk yang idle/cov-nya di luar ambang. Terukur: 6/6 sampel
       * bin excluded tetap menerbitkan median & delta terhadap baseline
       * yang justru disaring — pembilang bersampah, penyebut bersih.
       * Kelas bug IDENTIK `MIN_COVERAGE`/`slopeOf` di `fuel-analytics.js`.
       * Sekarang: median EAB per bin HANYA dari item non-excluded. Bila
       * semuanya excluded, `medLgtEnv` null — jujur, bukan dikira-kira
       * dari sampah. */
      var envVals = b.items.filter(function (m) { return !m.excludedFromBaseline; })
        .map(function (m) { return m.lGtEnv; }).filter(isNum);
      var medLgtEnv = envVals.length ? median(envVals) : null;
      var deltaLgtEnvPct = null;
      if (isNum(baseLgtEnv) && baseLgtEnv > 0 && medLgtEnv != null) {
        deltaLgtEnvPct = ((medLgtEnv - baseLgtEnv) / baseLgtEnv) * 100;
      }

      return {
        id: b.id,
        label: b.label,
        n: n,
        nExcluded: nExcluded,
        medLgt: medLgt,
        deltaLgtPct: deltaLgtPct,
        medLgtEnv: medLgtEnv,
        deltaLgtEnvPct: deltaLgtEnvPct,
        medFr: medFr,
        deltaFrPct: deltaFrPct
      };
    });

    var totalExcluded = processedRows.filter(function (r) { return r.excludedFromBaseline === true; }).length;

    return {
      baseline: {
        binId: fabricated ? null : baselineBin.id,
        label: fabricated ? 'Tidak ada baseline layak (semua bin < 5 sampel)' : baselineBin.label,
        n: fabricated ? 0 : baselineBin.items.length,
        nExcluded: fabricated ? 0 : baselineBin.items.filter(function (m) { return m.excludedFromBaseline === true; }).length,
        baseLgt: baseLgt,
        baseLgtEnv: baseLgtEnv,
        baseFr: baseFr,
        eabActive: hasEnvOptions,
        // [F3 2026-11-07] Dua bendera jujur baru:
        fabricated: fabricated,            // akar AUD-11: baseline TIDAK terukur
        baselineSkipped: baselineSkipped   // akar AUD-12: bin yang dilewati karena n<5
      },
      bins: summary,
      fleetPayloadMedian: fleetPayloadMed,
      totalExcluded: totalExcluded
    };
  }

  /* -----------------------------------------------------------------------
   * 3. Penghitungan Penalti Teknis (Technical Fuel Penalty)
   * --------------------------------------------------------------------- */

  /**
   * Menghitung penalti fuel per unit terhadap baseline referensi.
   *
   * @param {Object} unitSummary { unit, model, medianBlowby, medianLgt, medianFr, avgDailyGtkm, avgDailyHours }
   * @param {Object} baseline { baseLgt, baseFr }
   * @param {Object} [options] { blowbyThreshold, blowbyCritical, penaltyWarnPct, penaltyCritPct }
   */
  function evaluateTechnicalPenalty(unitSummary, baseline, options) {
    if (!unitSummary || !baseline) return null;

    var uLgt = unitSummary.medianLgt;
    var bLgt = baseline.baseLgt;
    var uFr = unitSummary.medianFr;
    var bFr = baseline.baseFr;

    var deltaLgt = (isNum(uLgt) && isNum(bLgt)) ? uLgt - bLgt : null;
    /* [F3 2026-11-07, akar AUD-11] Fallback `: 0` DICABUT. Tanpa baseline
     * terukur (`bLgt` null, mis. `fabricated`/nol sampel sehat), delta
     * TIDAK BISA dihitung — `0` adalah klaim "persis baseline", bukan
     * "baseline tidak ada". Penalti null membuat `evalDeltaPct` di bawah
     * null, yang pada gilirannya membuat `priority` jatuh ke default aman
     * (lihat catatan di gerbang prioritas). */
    var deltaLgtPct = (isNum(deltaLgt) && isNum(bLgt) && bLgt > 0) ? (deltaLgt / bLgt) * 100 : null;

    var deltaFr = (isNum(uFr) && isNum(bFr)) ? uFr - bFr : null;
    var deltaFrPct = (isNum(deltaFr) && isNum(bFr) && bFr > 0) ? (deltaFr / bFr) * 100 : null;

    // Metrik EAB (Environment-Adjusted Baseline)
    var uLgtEnv = isNum(unitSummary.medianLgtEnv) ? unitSummary.medianLgtEnv : uLgt;
    var bLgtEnv = isNum(baseline.baseLgtEnv) ? baseline.baseLgtEnv : bLgt;
    var deltaLgtEnv = (isNum(uLgtEnv) && isNum(bLgtEnv)) ? uLgtEnv - bLgtEnv : deltaLgt;
    var deltaLgtEnvPct = (isNum(deltaLgtEnv) && isNum(bLgtEnv) && bLgtEnv > 0) ? (deltaLgtEnv / bLgtEnv) * 100 : deltaLgtPct;

    /* Estimasi solar terbuang — HANYA dari penalti per ton-km.
     * -------------------------------------------------------------------
     * [F2 2026-11-07, akar AUD-7] Versi sebelumnya menguji cabang `deltaFr`
     * LEBIH DAHULU:
     *     if (deltaFr > 0) wasted = deltaFr * hoursPerDay;
     * Cabang itu hampir selalu menang, dan ia SALAH secara konsep: L/h yang
     * tinggi berarti unit MELAKUKAN LEBIH BANYAK PEKERJAAN, bukan memboroskan.
     *
     * Terukur pada armada uji: unit dengan L/GTKM PERSIS sama dengan baseline
     * (Δ 0,00 %) tetapi bekerja berat (95 L/h vs 73) dilaporkan membuang
     * 352 L/hari — DUA KALI LIPAT unit yang benar-benar aus (176 L/hari).
     * Karena `evaluatedUnits.sort` memakai angka ini, unit TERSIBUK mengapung
     * ke puncak antrean bengkel. Insentif terbalik yang nyata.
     *
     * Ini kekeliruan "L/km" yang sudah ditolak eksplisit dengan komentar
     * panjang di `fuel-analytics.js` (§ "BBM/km NAIK saat muatan naik — itu
     * fisika, bukan pemborosan"). Cabang `deltaFr` adalah bentuk lain dari
     * kesalahan yang sama.
     *
     * `null` vs `0` — PERBEDAAN PENTING:
     *   null = "tidak bisa dihitung" (GTKM tak ada / unit tidak boros)
     *   0    = KLAIM "terbukti tidak ada pemborosan"
     * Keduanya tidak boleh ditukar. Unit tanpa GTKM harus terlihat sebagai
     * "—" di UI, bukan sebagai unit bersih di dasar antrean.
     *
     * BATAS KEJUJURAN: `avgDailyGtkm` adalah rata-rata GTKM per JENDELA
     * (~20 jam mesin), bukan per hari kalender. Untuk armada ini keduanya
     * berdekatan (dSMR median ~20 h), tetapi penamaan "Daily" optimistis.
     */
    var wastedLitersPerDay = null;
    if (deltaLgt != null && deltaLgt > 0 && isNum(unitSummary.avgDailyGtkm) && unitSummary.avgDailyGtkm > 0) {
      wastedLitersPerDay = deltaLgt * unitSummary.avgDailyGtkm;
    } else if (deltaLgt != null && deltaLgt <= 0) {
      // Unit TIDAK boros — ini hasil pengukuran, bukan ketidaktahuan. 0 sah.
      wastedLitersPerDay = 0;
    }

    var wastedLitersPerMonth = (wastedLitersPerDay == null) ? null : wastedLitersPerDay * 30;

    // Tingkat Prioritas
    // P1: Blowby >= 4.0 kPa DAN Penalti L/GTKM >= 10% (atau salah satu ekstrem: Blowby >= 5.0 atau Penalti >= 15%)
    // P2: Blowby >= 3.2 kPa ATAU Penalti L/GTKM >= 6%
    // P3: Normal / Sehat
    var bbWarn = (options && isNum(options.blowbyThreshold)) ? options.blowbyThreshold : 3.2;
    var bbCrit = (options && isNum(options.blowbyCritical)) ? options.blowbyCritical : 4.0;
    var penWarn = (options && isNum(options.penaltyWarnPct)) ? options.penaltyWarnPct : 6.0;
    var penCrit = (options && isNum(options.penaltyCritPct)) ? options.penaltyCritPct : 12.0;

    /* [F4 JALAN C 2026-11-08, akar AUD-3/AUD-4] EAB kini DEFAULT AKTIF.
     * -------------------------------------------------------------------
     * Sebelumnya `useEabPriority` harus dikirim eksplisit, dan grep seluruh
     * kode menemukan NOL pemanggil yang mengirimnya. Akibatnya seluruh
     * pipeline EAB tidak pernah memengaruhi satu pun vonis -- ia hanya
     * kolom laporan. Terukur: unit dengan `deltaLgtEnvPct = 0,00 %` tetap
     * divonis P1 karena prioritas memakai delta MENTAH.
     *
     * Polaritas dibalik: EAB dipakai KECUALI dimatikan eksplisit
     * (`useEabPriority: false`). Bila baseline/EAB tak terukur,
     * `deltaLgtEnvPct` sendiri yang `null` dan gerbang di bawah sudah
     * menahan diri -- jadi aktif-secara-default tidak menciptakan vonis
     * dari ketiadaan data. */
    var evalDeltaPct = (options && options.useEabPriority === false) ? deltaLgtPct : deltaLgtEnvPct;

    /* [F3 2026-11-07] `evalDeltaPct` bisa NULL (baseline tak terukur).
     * `null >= penCrit` adalah `false` di JavaScript, jadi perbandingan di
     * bawah SUDAH aman menahan diri secara alami — unit jatuh ke prioritas
     * berbasis blowby SAJA, bukan diam-diam ikut membandingkan terhadap
     * `undefined`/`NaN`. Didokumentasikan eksplisit supaya tidak tampak
     * seperti kebetulan saat dibaca ulang nanti. */
    var priority = 'P3';
    var bb = unitSummary.medianBlowby || 0;
    if (bb >= bbCrit || (evalDeltaPct != null && evalDeltaPct >= penCrit)) {
      priority = 'P1';
    } else if (bb >= bbWarn || (evalDeltaPct != null && evalDeltaPct >= penWarn)) {
      priority = 'P2';
    }

    return {
      unit: unitSummary.unit,
      priority: priority,
      actualLgt: uLgt,
      baselineLgt: bLgt,
      deltaLgt: deltaLgt,
      deltaLgtPct: deltaLgtPct,
      actualLgtEnv: uLgtEnv,
      baselineLgtEnv: bLgtEnv,
      deltaLgtEnv: deltaLgtEnv,
      deltaLgtEnvPct: deltaLgtEnvPct,
      actualFr: uFr,
      baselineFr: bFr,
      deltaFr: deltaFr,
      deltaFrPct: deltaFrPct,
      wastedLitersPerDay: wastedLitersPerDay,
      wastedLitersPerMonth: wastedLitersPerMonth
    };
  }

  /* -----------------------------------------------------------------------
   * 4. Klasifikasi Kuadran (Machine Health vs. Fuel Intensity Matrix)
   * --------------------------------------------------------------------- */

  /**
   * Menentukan posisi kuadran matriks evaluasi:
   * Q1: Critical Action Required (Blowby tinggi & Fuel L/GTKM tinggi)
   * Q2: Operational/Route Issue (Blowby normal & Fuel L/GTKM tinggi)
   * Q3: Benchmark Fleet (Blowby normal & Fuel L/GTKM efisien)
   * Q4: Underload / Developing Wear (Blowby tinggi & Fuel L/GTKM efisien)
   *
   * @param {number} blowby Nilai blowby max (kPa)
   * @param {number} lGt Konsumsi spesifik (L/GTKM)
   * @param {Object} [options] { blowbyThreshold, baselineLgt, penaltyThresholdPct, lGtThreshold }
   */
  function classifyQuadrant(blowby, lGt, options) {
    if (!isNum(blowby) || !isNum(lGt)) return null;
    options = options || {};
    var bbWarn = isNum(options.blowbyThreshold) ? options.blowbyThreshold : 3.2;
    /* [F3 2026-11-07, akar AUD-11] Fallback `: 0.0442` DICABUT. Tanpa
     * `baselineLgt` ATAU `lGtThreshold` eksplisit, kuadran TIDAK BISA
     * dihitung — sebelumnya diam-diam memakai angka hafalan sehingga Q1..Q4
     * (dasar rekomendasi bengkel) terbit dari fiksi tanpa jejak. Pemanggil
     * (`analyzeFleetEngineFuel`) WAJIB mengirim `baselineLgt` dari
     * `fleetBaseline.baseLgt` yang sudah null-aware sejak perbaikan ini. */
    if (!isNum(options.baselineLgt) && !isNum(options.lGtThreshold)) return null;
    var baseLgt = options.baselineLgt;
    var penaltyPct = isNum(options.penaltyThresholdPct) ? options.penaltyThresholdPct : 10.0;
    var lGtThreshold = isNum(options.lGtThreshold) ? options.lGtThreshold : (baseLgt * (1 + penaltyPct / 100));

    var isBbHigh = blowby >= bbWarn;
    var isLgtHigh = lGt >= lGtThreshold;

    if (isBbHigh && isLgtHigh) {
      return {
        id: 'Q1',
        name: 'Critical Action Required',
        priority: 'P1',
        badge: 'P1 — Critical Action',
        color: '#ef4444',
        cause: 'Internal Engine Wear (Blow-by / Compression Loss)',
        desc: 'Blow-by tinggi & L/GTKM tinggi: kebocoran kompresi ruang bakar menyebabkan pembakaran inefisien.'
      };
    }
    if (!isBbHigh && isLgtHigh) {
      return {
        id: 'Q2',
        name: 'Operational / Route Issue',
        priority: 'P2',
        badge: 'P2 — Operational Audit',
        color: '#f59e0b',
        cause: 'External Operational (Grade, Rolling Resistance, Overload)',
        desc: 'Blow-by normal tetapi konsumsi bahan bakar tinggi: periksa gradien jalan, amblesan rute, atau muatan berlebih.'
      };
    }
    if (!isBbHigh && !isLgtHigh) {
      return {
        id: 'Q3',
        name: 'Benchmark Fleet',
        priority: 'P3',
        badge: 'P3 — Optimal',
        color: '#22c55e',
        cause: 'Normal Operation & Healthy Engine',
        desc: 'Blow-by normal dan efisiensi bahan bakar dalam batas baseline sehat armada.'
      };
    }
    // isBbHigh && !isLgtHigh
    return {
      id: 'Q4',
      name: 'Underload / Developing Wear',
      priority: 'P2',
      badge: 'P2 — Early Monitor',
      color: '#38bdf8',
      cause: 'Developing Engine Wear (Light Duty Cycle)',
      desc: 'Blow-by meningkat namun belum tercermin pada fuel: siklus kerja ringan/jarak pendek, pantau tren sebelum PM berikutnya.'
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Penjajaran Temporal (Temporal Bucket Join & Alignment)
   * --------------------------------------------------------------------- */

  /**
   * Mengonversi properti calendar VHMS (string, object, atau epoch) ke format YYYY-MM-DD.
   */
  function _calToYmd(cal) {
    if (!cal) return '';
    if (typeof cal === 'string') {
      var s = cal.trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      var parts = s.split(' ')[0].split(/[\/\-]/);
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return parts[0] + '-' + ('0' + parts[1]).slice(-2) + '-' + ('0' + parts[2]).slice(-2);
        }
        return parts[2] + '-' + ('0' + parts[1]).slice(-2) + '-' + ('0' + parts[0]).slice(-2);
      }
      return '';
    }
    if (cal.iso && typeof cal.iso === 'string') {
      return cal.iso.slice(0, 10);
    }
    if (cal.display && typeof cal.display === 'string') {
      var dParts = cal.display.trim().split(' ')[0].split(/[\/\-]/);
      if (dParts.length === 3) {
        if (dParts[0].length === 4) {
          return dParts[0] + '-' + ('0' + dParts[1]).slice(-2) + '-' + ('0' + dParts[2]).slice(-2);
        }
        return dParts[2] + '-' + ('0' + dParts[1]).slice(-2) + '-' + ('0' + dParts[0]).slice(-2);
      }
    }
    if (isNum(cal.epoch)) {
      var ms = cal.epoch > 1e11 ? cal.epoch : cal.epoch * 1000;
      var tz = isNum(cal.tzOffsetSec) ? cal.tzOffsetSec * 1000 : 0;
      var d = new Date(ms + tz);
      var y = d.getUTCFullYear();
      var m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
      var day = ('0' + d.getUTCDate()).slice(-2);
      return y + '-' + m + '-' + day;
    }
    return '';
  }

  /**
   * Menghubungkan records telemetri VHMS dengan jendela konsumsi bahan bakar (windows).
   *
   * @param {Array} records Baris telemetri VHMS (mengandung smr, calendar, blowbyMax, boostMax, dll)
   * @param {Array} windows Jendela siklus bahan bakar (mengandung smr/date, dSmr, lGt, fuelRate, dll)
   * @param {Object} [options]
   */
  function joinRecordsAndWindows(records, windows, options) {
    if (!records || !records.length || !windows || !windows.length) return [];
    options = options || {};

    var minBlowby = isNum(options.minValidBlowby) ? options.minValidBlowby : 0.1;
    var maxBlowby = isNum(options.maxValidBlowby) ? options.maxValidBlowby : 30.0;

    var matched = [];

    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (!w || !w.date) continue;

      var wSmr = isNum(w.smr) ? w.smr : (isNum(w.t1) ? w.t1 : null);
      var dSmr = isNum(w.dSmr) ? w.dSmr : 20.0;

      // Cari record telemetri yang relevan
      var recSubset = [];
      if (wSmr != null) {
        // Cari record yang berada tepat di titik batas SMR jendela wSmr
        recSubset = records.filter(function (r) {
          return r && isNum(r.smr) && Math.abs(r.smr - wSmr) <= 1.0;
        });
        // Jika tidak ada di titik batas persis, cari di dalam rentang terbuka (wSmr - dSmr, wSmr]
        if (!recSubset.length) {
          var smrStart = wSmr - dSmr + 0.01;
          var smrEnd = wSmr + 0.01;
          recSubset = records.filter(function (r) {
            return r && isNum(r.smr) && r.smr > smrStart && r.smr <= smrEnd;
          });
        }
      }

      // Fallback: pencocokan tanggal (dukung format string, ISO, dan object calendar VHMS)
      if (!recSubset.length && w.date) {
        recSubset = records.filter(function (r) {
          if (!r || !r.calendar) return false;
          var rYmd = _calToYmd(r.calendar);
          return rYmd === w.date;
        });
      }

      // Ambil nilai sensor
      var bbVals = [];
      var boostVals = [];
      var coolVals = [];
      var oilVals = [];
      var pressVals = [];

      recSubset.forEach(function (r) {
        var bb = r.blowbyMax != null ? r.blowbyMax : (r.blowby != null ? r.blowby : null);
        if (isNum(bb) && bb >= minBlowby && bb <= maxBlowby) bbVals.push(bb);

        var bst = r.boostMax != null ? r.boostMax : (r.boost != null ? r.boost : null);
        if (isNum(bst) && bst > 0) boostVals.push(bst);

        var cl = r.coolantTemp != null ? r.coolantTemp : (r.coolTemp != null ? r.coolTemp : null);
        if (isNum(cl) && cl >= -30 && cl <= 150) coolVals.push(cl);

        var ot = r.engOilTemp != null ? r.engOilTemp : (r.oilTemp != null ? r.oilTemp : null);
        if (isNum(ot) && ot >= -30 && ot <= 150) oilVals.push(ot);

        var op = r.oilPressMax != null ? r.oilPressMax : (r.oilPressHMin != null ? r.oilPressHMin : null);
        if (isNum(op) && op > 0) pressVals.push(op);
      });

      // Bila w sudah memiliki blowby terpasang (dari pre-parser)
      var finalBlowby = bbVals.length ? median(bbVals) : (isNum(w.blowby) ? w.blowby : null);
      var finalBoost = boostVals.length ? median(boostVals) : (isNum(w.boost) ? w.boost : null);
      var finalCool = coolVals.length ? Math.max.apply(null, coolVals) : (isNum(w.coolant) ? w.coolant : null);
      var finalOil = oilVals.length ? Math.max.apply(null, oilVals) : (isNum(w.engOil) ? w.engOil : null);
      var finalPress = pressVals.length ? median(pressVals) : (isNum(w.oilPress) ? w.oilPress : null);

      // Filter tanggal jika opsi disediakan
      if (options.dateStart && w.date && w.date < options.dateStart) continue;
      if (options.dateEnd && w.date && w.date > options.dateEnd) continue;

      // Filter SMR jika opsi disediakan
      if (isNum(options.smrMin) && wSmr != null && wSmr < options.smrMin) continue;
      if (isNum(options.smrMax) && wSmr != null && wSmr > options.smrMax) continue;

      // Pilihan kompartemen evaluasi: ENGINE (default, blowby), COOLING (coolant), POWERTRAIN (oilPress/temp)
      var comp = (options.compartment || 'ENGINE').toUpperCase();
      var primaryMetric = finalBlowby;
      if (comp === 'COOLING') {
        primaryMetric = finalCool;
      } else if (comp === 'POWERTRAIN') {
        primaryMetric = finalPress != null ? finalPress : finalOil;
      }

      // [F3 2026-11-07, akar AUD-2/S-1] Konstanta `0.38` DICABUT — lihat
      // catatan panjang di `normalizeEnv()`. Tanpa `lGt` eksplisit, null.
      var lGt = isNum(w.lGt) ? w.lGt : null;
      var fuelRate = isNum(w.fuelRate) ? w.fuelRate : (isNum(w.Lh) ? w.Lh : null);

      if (isNum(primaryMetric) && isNum(lGt) && lGt > 0) {
        matched.push({
          date: w.date,
          smr: wSmr,
          dSmr: dSmr,
          lGt: lGt,
          lTk: isNum(w.lTk) ? w.lTk : null,
          fuelRate: fuelRate,
          liters: isNum(w.liters) ? w.liters : (isNum(w.L) ? w.L : null),
          gtkm: isNum(w.gtkm) ? w.gtkm : (isNum(w.GTKM) ? w.GTKM : null),
          tkm: isNum(w.tkm) ? w.tkm : (isNum(w.TKM) ? w.TKM : null),
          n: isNum(w.n) ? w.n : 0,
          unit: w.unit || (options && options.unit) || null,
          serial: w.serial || (options && options.serial) || null,
          idle: isNum(w.idle) ? w.idle : (isNum(w.idleFraction) ? w.idleFraction : null),
          cov: isNum(w.cov) ? w.cov : (isNum(w.coverage) ? w.coverage : null),
          pavg: isNum(w.pavg) ? w.pavg : (isNum(w.payloadAvg) ? w.payloadAvg : null),
          avgGradePct: isNum(w.avgGradePct) ? w.avgGradePct : (isNum(w.gradePct) ? w.gradePct : null),
          blowby: finalBlowby,
          boost: finalBoost,
          coolant: finalCool,
          engOil: finalOil,
          oilPress: finalPress,
          compartmentMetric: primaryMetric
        });
      }
    }

    return matched;
  }

  /**
   * Menjajarkan telemetri dan fuel untuk satu unit.
   */
  function alignUnitTelemetryAndFuel(unitData, options) {
    if (!unitData) return null;
    options = options || {};

    var matched = [];
    if (unitData.matched && unitData.matched.length) {
      matched = unitData.matched.map(function (m) {
        if (!m.unit && unitData.unit) m.unit = unitData.unit;
        if (!m.serial && unitData.serial) m.serial = unitData.serial;
        return m;
      });
    } else if (unitData.records && unitData.windows) {
      var joinOpts = Object.assign({}, options, { unit: unitData.unit, serial: unitData.serial });
      matched = joinRecordsAndWindows(unitData.records, unitData.windows, joinOpts);
    }

    var bbList = matched.map(function (m) { return m.blowby; }).filter(isNum);
    var bstList = matched.map(function (m) { return m.boost; }).filter(isNum);
    var lgtList = matched.map(function (m) { return m.lGt; }).filter(isNum);
    var lgtEnvList = matched.map(function (m) { return m.lGtEnv; }).filter(isNum);
    var frList = matched.map(function (m) { return m.fuelRate; }).filter(isNum);
    var gtkmList = matched.map(function (m) { return m.gtkm; }).filter(isNum);
    var idleList = matched.map(function (m) { return m.idle; }).filter(isNum);
    var pavgList = matched.map(function (m) { return m.pavg; }).filter(isNum);
    var gradeList = matched.map(function (m) { return m.avgGradePct; }).filter(isNum);
    var icList = matched.map(function (m) { return m.icFactor; }).filter(isNum);
    var pfList = matched.map(function (m) { return m.payloadFactor; }).filter(isNum);
    var gfList = matched.map(function (m) { return m.gradeFactor; }).filter(isNum);

    var medBb = median(bbList);
    var maxBb = bbList.length ? Math.max.apply(null, bbList) : null;
    var medBst = median(bstList);
    var medLgt = median(lgtList);
    var medLgtEnv = lgtEnvList.length ? median(lgtEnvList) : medLgt;
    var medFr = median(frList);
    var avgDailyGtkm = average(gtkmList);
    var medIdle = idleList.length ? median(idleList) : null;
    var medPavg = pavgList.length ? median(pavgList) : null;
    var medGrade = gradeList.length ? median(gradeList) : null;
    var medIcFactor = icList.length ? median(icList) : null;
    var medPayloadFactor = pfList.length ? median(pfList) : null;
    var medGradeFactor = gfList.length ? median(gfList) : null;

    /* Jam operasi harian DARI DATA, bukan dipaku 16. [F2, akar AUD-9]
     * -------------------------------------------------------------------
     * `dSmr` (selisih Service Meter Reading) tersedia di SETIAP jendela dan
     * satuannya JAM MESIN — itu persis jam operasi jendela tersebut. Versi
     * sebelumnya memakai `unitData.avgDailyHours || 16.0`, padahal memori
     * proyek mencatat dSMR median armada ini **20,0 h**.
     *
     * Bila tak ada dSmr sama sekali ⇒ `null` + `hoursAssumed: true`, supaya
     * UI dapat membedakan "20,4 jam terukur" dari "kami tidak tahu".
     * JANGAN kembalikan 16 sebagai tebakan berwibawa. */
    var dSmrList = matched.map(function (m) { return m.dSmr; }).filter(isNum)
      .filter(function (v) { return v > 0; });
    var avgDailyHours = dSmrList.length ? median(dSmrList) : (isNum(unitData.avgDailyHours) ? unitData.avgDailyHours : null);

    var lastItem = matched.length ? matched[matched.length - 1] : {};

    var unitSummary = {
      unit: unitData.unit || unitData.serial || '—',
      // ID internal diperlukan UI Intel untuk kembali ke detail/chart VHMS.
      // Jangan gunakan serial/lambung sebagai pengganti: keduanya bukan key Fleet.
      vhmsUnitId: unitData.vhmsUnitId || null,
      model: unitData.model || 'HD785-7',
      serial: unitData.serial || '',
      smr: unitData.smr != null ? unitData.smr : (lastItem.smr != null ? lastItem.smr : null),
      date: unitData.date || lastItem.date || null,
      matchedCount: matched.length,
      medianBlowby: medBb != null ? medBb : (unitData.medianBlowby || null),
      maxBlowby: maxBb != null ? maxBb : (unitData.maxBlowby || null),
      medianBoost: medBst != null ? medBst : (unitData.medianBoost || null),
      medianLgt: medLgt != null ? medLgt : (unitData.medianLgt || null),
      medianLgtEnv: medLgtEnv != null ? medLgtEnv : (unitData.medianLgtEnv || medLgt),
      medianFr: medFr != null ? medFr : (unitData.medianFr || null),
      medianIdle: medIdle != null ? medIdle : (unitData.medianIdle || null),
      medianPavg: medPavg != null ? medPavg : (unitData.medianPavg || null),
      medianGrade: medGrade != null ? medGrade : (unitData.medianGrade || null),
      medianIcFactor: medIcFactor != null ? medIcFactor : (unitData.medianIcFactor || null),
      medianPayloadFactor: medPayloadFactor != null ? medPayloadFactor : (unitData.medianPayloadFactor || null),
      medianGradeFactor: medGradeFactor != null ? medGradeFactor : (unitData.medianGradeFactor || null),
      avgDailyGtkm: avgDailyGtkm != null ? avgDailyGtkm : (unitData.avgDailyGtkm || null),
      avgDailyHours: avgDailyHours,
      hoursAssumed: avgDailyHours == null
    };

    return {
      unit: unitSummary.unit,
      vhmsUnitId: unitSummary.vhmsUnitId,
      model: unitSummary.model,
      serial: unitSummary.serial,
      unitSummary: unitSummary,
      matched: matched,
      sosSamples: unitData.sosSamples || null,
      sosCr: unitData.sosCr != null ? unitData.sosCr : null,
      sosFe: unitData.sosFe != null ? unitData.sosFe : null,
      sosSoot: unitData.sosSoot != null ? unitData.sosSoot : null,
      sosDilution: unitData.sosDilution != null ? unitData.sosDilution : null,
      faultHistory: unitData.faultHistory || []
    };
  }

  /* -----------------------------------------------------------------------
   * 6. Analisis Terintegrasi Armada (Fleet Engine-Fuel Intelligence)
   * --------------------------------------------------------------------- */

  /**
   * Menjalankan analitik menyeluruh mesin vs fuel untuk armada multi-unit
   * dengan normalisasi faktor lingkungan (Environment-Adjusted Baseline / EAB).
   *
   * @param {Array} [unitsData] Daftar data unit
   * @param {Object} [options] Opsi analisis (ambang, harga solar, dsb)
   */
  function analyzeFleetEngineFuel(unitsData, options) {
    options = options || {};

    // Jika data tidak disediakan secara eksplisit, coba ambil dari store global
    var inputUnits = unitsData;
    if ((!inputUnits || !inputUnits.length) && typeof window !== 'undefined') {
      inputUnits = _collectFleetFromGlobals();
    }
    inputUnits = inputUnits || [];

    var allMatchedRows = [];
    var alignedUnits = [];

    inputUnits.forEach(function (u) {
      var al = alignUnitTelemetryAndFuel(u, options);
      if (al && al.unitSummary) {
        alignedUnits.push(al);
        if (al.matched && al.matched.length) {
          allMatchedRows = allMatchedRows.concat(al.matched);
        }
      }
    });

    // Helper lookup kemiringan rute GPS
    var gpsStore = options.gpsStore || global.GPS_ROUTE_STORE || null;
    var fuelGpsAgg = options.fuelGps || (global.FUEL_APP && global.FUEL_APP._state && global.FUEL_APP._state.gps) || null;
    var hasFuelGps = !!(fuelGpsAgg && fuelGpsAgg.byUnit && Object.keys(fuelGpsAgg.byUnit).length > 0);
    var gpsLoaded = !!(
      (gpsStore && (typeof gpsStore.isLoaded === 'function' ? gpsStore.isLoaded() : (gpsStore.getStateSummary && gpsStore.getStateSummary().loaded))) ||
      hasFuelGps
    );

    var unitDb = global.VHMS_UNITDB || global.VHMS_UNIT_DB || null;

    function getGradeForUnit(unit, date, serial) {
      if (options.getGradeForUnit && typeof options.getGradeForUnit === 'function') {
        return options.getGradeForUnit(unit, date, serial);
      }
      if (!unit && !serial) return null;

      // Kumpulkan kandidat identitas unit (lambung, serial, key)
      var uCandidates = [];
      if (unit) uCandidates.push(String(unit).trim());
      if (serial) {
        var sStr = String(serial).trim();
        if (uCandidates.indexOf(sStr) === -1) uCandidates.push(sStr);
        var sClean = sStr.replace(/^S:/i, '');
        if (uCandidates.indexOf(sClean) === -1) uCandidates.push(sClean);
      }
      if (unitDb && typeof unitDb.getLambung === 'function') {
        for (var ci = 0; ci < uCandidates.length; ci++) {
          var lb = unitDb.getLambung(uCandidates[ci]);
          if (lb && uCandidates.indexOf(lb) === -1) uCandidates.push(lb);
        }
      }

      // Sumber 1: GPS_ROUTE_STORE (inferred route assignments)
      if (gpsStore && typeof gpsStore.getAssignmentsForUnit === 'function') {
        var assignments = [];
        for (var c = 0; c < uCandidates.length; c++) {
          var candList = gpsStore.getAssignmentsForUnit(uCandidates[c]) || [];
          if (candList.length) { assignments = candList; break; }
        }

        /* [F4 2026-11-08, akar AUD-16] Fallback "rata-rata SELURUH rute"
         * DICABUT.
         * -----------------------------------------------------------------
         * Fallback itu memberi SATU nilai yang sama untuk semua tanggal unit,
         * sehingga koreksi grade menjadi SKALA KONSTAN per unit: ia menggeser
         * level absolut tanpa menjelaskan variasi harian -- padahal variasi
         * harian itulah objek analisis trending. Lebih buruk lagi, ia
         * membuat jendela tanpa data grade TAMPAK terkoreksi.
         *
         * Sekarang: HANYA kecocokan TANGGAL. Tidak cocok => `null` =>
         * `gradeApplied: false` dan statusnya terlihat di `envApplied`. */
        if (assignments.length && date) {
          for (var i = 0; i < assignments.length; i++) {
            var a = assignments[i];
            if (a.date === date || (a.dateStart && a.dateEnd && a.dateStart <= date && date <= a.dateEnd)) {
              var g = isNum(a.grade_pct) ? a.grade_pct : (isNum(a.avg_grade_pct) ? a.avg_grade_pct : (isNum(a.gradePct) ? a.gradePct : null));
              // `g <= 0` = hari tanpa grade terukur (17,9 % baris GPS nyata),
              // BUKAN rute datar. Jangan klaim koreksi yang tak terjadi.
              if (g !== null && g > 0) return g;
            }
          }
        }
      }

      // Sumber 2: FUEL_APP._state.gps (agregat track GPS yang diunggah via Tambah GPS)
      if (fuelGpsAgg && fuelGpsAgg.byUnit) {
        var G = global.FUEL_GPS;
        var normFn = (G && typeof G.normUnit === 'function')
          ? G.normUnit
          : function (s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); };

        var unitTrack = null;
        for (var u = 0; u < uCandidates.length; u++) {
          var key = normFn(uCandidates[u]);
          if (fuelGpsAgg.byUnit[key]) {
            unitTrack = fuelGpsAgg.byUnit[key];
            break;
          }
        }

        /* [F4 2026-11-08, akar AUD-16] Fallback rata-rata semua hari juga
         * DICABUT -- alasan sama seperti di Sumber 1. HANYA tanggal cocok. */
        if (unitTrack && date && unitTrack[date] && unitTrack[date].distKm > 0 && unitTrack[date].climb != null) {
          var gh = (unitTrack[date].climb / (unitTrack[date].distKm * 1000)) * 100;
          if (gh > 0) return gh;
        }
      }

      return null;
    }

    var eabEnabled = options.enableEab !== false;
    var eabConfig = Object.assign({}, EAB_CONFIG, options.eabConfig || {});

    // Hitung fleet payload median dari seluruh baris valid
    var allPavg = allMatchedRows.map(function (r) {
      return isNum(r.pavg) ? r.pavg : (isNum(r.payloadAvg) ? r.payloadAvg : null);
    }).filter(isNum);
    var fleetPayloadMedian = median(allPavg) || null;

    /* ---------------------------------------------------------------------
     * KALIBRASI DUA TAHAP. [F4 JALAN C 2026-11-08]
     * -------------------------------------------------------------------
     * Tahap 1: pasang `avgGradePct` HARIAN ke setiap baris (lewat
     *          `getGradeForUnit`, yang kini HANYA cocok-tanggal).
     * Tahap 2: duga `wIdle` & `kRR` dari baris itu (`calibrateEab`), lalu
     *          baru normalkan.
     *
     * Urutannya penting: kalibrasi butuh grade sudah terpasang, sedangkan
     * normalisasi butuh parameter sudah terkalibrasi. Satu lintasan tidak
     * cukup. Ini sebabnya `allMatchedRows` dipetakan dua kali di bawah --
     * bukan pemborosan, melainkan ketergantungan nyata.
     * ------------------------------------------------------------------- */
    var gradeActiveCount = 0;
    var idleActiveCount = 0;
    var payloadActiveCount = 0;

    // Tahap 1 — pasang grade harian.
    allMatchedRows = allMatchedRows.map(function (r) {
      var g = getGradeForUnit(r.unit, r.date, r.serial);
      if (g === null && isNum(r.avgGradePct) && r.avgGradePct > 0) g = r.avgGradePct;
      return Object.assign({}, r, { avgGradePct: (isNum(g) && g > 0) ? g : null });
    });

    // Tahap 2 — duga parameter DARI DATA (bukan konstanta).
    var calibration = eabEnabled
      ? calibrateEab(allMatchedRows, eabConfig)
      : {
        wIdle: { ok: false, reason: 'eab-disabled', value: null, nUnits: 0, nUnitsTried: 0, perUnit: [] },
        kRR: { ok: false, reason: 'eab-disabled', value: null, nUnits: 0, nUnitsTried: 0, perUnit: [] }
      };
    eabConfig = Object.assign({}, eabConfig, {
      wIdleCalibrated: calibration.wIdle.ok ? calibration.wIdle.value : null,
      kRollingResistCalibrated: calibration.kRR.ok ? calibration.kRR.value : null
    });

    allMatchedRows = allMatchedRows.map(function (r) {
      var grade = isNum(r.avgGradePct) ? r.avgGradePct : null;
      if (isNum(grade) && grade > 0) gradeActiveCount++;
      if (isNum(r.idle) && r.idle > 0) idleActiveCount++;
      if (isNum(r.pavg) && r.pavg > 0) payloadActiveCount++;

      if (!eabEnabled) {
        return Object.assign({}, r, { lGtEnv: r.lGt, lGtRaw: r.lGt, excludedFromBaseline: false });
      }

      var norm = normalizeEnv(r, fleetPayloadMedian, grade, eabConfig);
      return Object.assign({}, r, {
        lGtEnv: norm.lGtEnv,
        lGtRaw: norm.lGtRaw,
        avgGradePct: grade,
        excludedFromBaseline: norm.excluded,
        excludeReason: norm.reason,
        icFactor: norm.icFactor,
        payloadFactor: norm.payloadFactor,
        gradeFactor: norm.gradeFactor,
        // [F4] status koreksi per jendela — wajib ikut supaya perbandingan
        // lintas status tidak dilakukan tanpa sadar (lihat H3).
        idleApplied: norm.idleApplied,
        gradeApplied: norm.gradeApplied,
        envApplied: norm.envApplied
      });
    });

    // Re-sync alignedUnits dengan normalized rows
    alignedUnits.forEach(function (al) {
      var unitRows = allMatchedRows.filter(function (m) { return m.unit === al.unit; });
      if (unitRows.length) {
        al.matched = unitRows;
        var envVals = unitRows.map(function (m) { return m.lGtEnv; }).filter(isNum);
        var idleVals = unitRows.map(function (m) { return m.idle; }).filter(isNum);
        var pavgVals = unitRows.map(function (m) { return m.pavg; }).filter(isNum);
        var gradeVals = unitRows.map(function (m) { return m.avgGradePct; }).filter(isNum);
        var pfVals = unitRows.map(function (m) { return m.payloadFactor; }).filter(isNum);

        /* [F4 REVIEW 2026-11-10] Faktor median HANYA dari jendela yang
         * BENAR-BENAR dikoreksi — bukan dari seluruh jendela.
         * -----------------------------------------------------------------
         * Cacat terukur pada data nyata (6 unit, 386 jendela, grade 15,8 %):
         * `medianGrade` dihitung dari jendela ber-grade saja (filter isNum
         * membuang null), tetapi `medianGradeFactor` dihitung dari SEMUA
         * jendela — 84 % di antaranya tanpa GPS dan ber-`gradeFactor = 1.0`.
         * Mediannya jatuh ke 1.000 untuk 6/6 unit, lalu tooltip menampilkan
         * "Kemiringan 2,73 % -> exp(-18,04 x 0,0273) = 1.000" — kontradiksi
         * aritmetika (nilai benar ~0,61). Operator akan menyimpulkan koreksi
         * grade MATI, padahal angkanya tercampur dari dua populasi berbeda.
         * Ini persis pelanggaran H3 ("lGtEnv hanya sah dibandingkan antar
         * jendela berstatus koreksi sama") yang F4 sendiri tetapkan.
         *
         * Perbaikan: pisahkan populasi + terbitkan cakupan per unit supaya
         * UI bisa menulis "dari 7/62 jendela", bukan menyamarkan 84 % yang
         * tidak dikoreksi di balik satu angka median. */
        var idleAppliedRows = unitRows.filter(function (m) { return m.idleApplied === true; });
        var gradeAppliedRows = unitRows.filter(function (m) { return m.gradeApplied === true; });
        var icVals = idleAppliedRows.map(function (m) { return m.icFactor; }).filter(isNum);
        var gfVals = gradeAppliedRows.map(function (m) { return m.gradeFactor; }).filter(isNum);

        if (al.unitSummary) {
          if (envVals.length) al.unitSummary.medianLgtEnv = median(envVals);
          if (idleVals.length) al.unitSummary.medianIdle = median(idleVals);
          if (pavgVals.length) al.unitSummary.medianPavg = median(pavgVals);
          if (gradeVals.length) al.unitSummary.medianGrade = median(gradeVals);
          if (pfVals.length) al.unitSummary.medianPayloadFactor = median(pfVals);
          // null (bukan 1.0) bila TIDAK ADA jendela yang dikoreksi — pelajaran
          // F2/F3: null = "tak terhitung", 1.0 = klaim "terukur, tak berpengaruh".
          al.unitSummary.medianIcFactor = icVals.length ? median(icVals) : null;
          al.unitSummary.medianGradeFactor = gfVals.length ? median(gfVals) : null;
          al.unitSummary.envCoverage = {
            total: unitRows.length,
            idleApplied: idleAppliedRows.length,
            gradeApplied: gradeAppliedRows.length
          };
        }
      }
    });

    var envOptions = {
      enabled: eabEnabled,
      fleetPayloadMedian: fleetPayloadMedian,
      getGradeForUnit: getGradeForUnit,
      eabConfig: eabConfig
    };

    var bRes = binAnalysis(allMatchedRows, null, envOptions);

    // 1. Tentukan Baseline Sehat Armada
    var healthyThreshold = isNum(options.blowbyThreshold) ? options.blowbyThreshold : 3.2;
    var healthyRows = allMatchedRows.filter(function (r) {
      return isNum(r.blowby) && r.blowby < healthyThreshold && isNum(r.lGt) && r.lGt > 0;
    });

    /* [F3 2026-11-07, akar AUD-11] Fallback hafalan `0.0442`/`73.0` DICABUT.
     * Jalur baseline armada (bukan hanya `binAnalysis`) punya DUA sumber:
     * (a) >=5 baris sehat milik armada ini sendiri — cara terbaik;
     * (b) jatuh ke `bRes.baseline` dari `binAnalysis` — yang SEKARANG bisa
     *     `fabricated:true` + `baseLgt:null` bila tak ada satu pun bin punya
     *     >=5 sampel. Baseline null MENJALAR ke seluruh evaluasi unit
     *     (delta null ⇒ priority berbasis blowby saja ⇒ tidak ada Rupiah
     *     tanpa dasar), bukan diam-diam terbit dari angka hafalan. */
    var baseLgt = null;
    var baseLgtEnv = null;
    var baseFr = null;
    var baselineLabel = 'Normal Baseline (< ' + healthyThreshold + ' kPa)';
    var fabricated = false;

    if (healthyRows.length >= 5) {
      baseLgt = median(healthyRows.map(function (m) { return m.lGt; }));
      baseFr = median(healthyRows.map(function (m) { return m.fuelRate; }));
      var healthyNonExcluded = healthyRows.filter(function (m) { return !m.excludedFromBaseline && isNum(m.lGtEnv); });
      if (healthyNonExcluded.length < 3) healthyNonExcluded = healthyRows.filter(function (m) { return isNum(m.lGtEnv); });
      baseLgtEnv = healthyNonExcluded.length ? median(healthyNonExcluded.map(function (m) { return m.lGtEnv; })) : null;
      if (baseLgtEnv == null) baseLgtEnv = baseLgt;
      // Baris sehat ada tapi kebetulan tanpa lGt/fuelRate valid — kondisi
      // tepi yang sama tidak layaknya baseline terukur.
      if (baseLgt == null || baseFr == null) fabricated = true;
    } else if (bRes && bRes.baseline) {
      baseLgt = bRes.baseline.baseLgt;
      baseLgtEnv = bRes.baseline.baseLgtEnv != null ? bRes.baseline.baseLgtEnv : baseLgt;
      baseFr = bRes.baseline.baseFr;
      baselineLabel = bRes.baseline.label;
      fabricated = !!bRes.baseline.fabricated;
    } else {
      fabricated = true;
    }

    var fleetBaseline = {
      baseLgt: baseLgt,
      baseLgtEnv: baseLgtEnv,
      baseFr: baseFr,
      label: baselineLabel,
      fabricated: fabricated,     // [F3] akar AUD-11 — tak ada baseline terukur
      healthyCount: healthyRows.length,
      totalMatchedRows: allMatchedRows.length,
      eabActive: eabEnabled,
      fleetPayloadMedian: fleetPayloadMedian,
      eabStatus: {
        /* [F4] "active" kini berarti PARAMETER TERKALIBRASI *dan* ada data,
         * bukan sekadar "ada data". Punya data idle tanpa kalibrasi yang
         * lolos gerbang = koreksi TIDAK diterapkan, jadi melaporkannya
         * "aktif" akan menyesatkan. */
        idleActive: calibration.wIdle.ok && idleActiveCount > 0,
        // payload normalization DICABUT di F4 (koreksi ganda) — selalu false.
        payloadActive: false,
        gradeActive: calibration.kRR.ok && gradeActiveCount > 0,
        gpsLoaded: gpsLoaded
      }
    };

    // 2. Evaluasi Setiap Unit
    var evaluatedUnits = [];
    var quadCounts = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    /* Total armada mulai dari `null`, bukan 0. [F2 2026-11-07]
     * Bila TIDAK SATU PUN unit dapat dihitung, total harus `null` ("tak
     * terhitung"), bukan 0 ("terbukti nol pemborosan"). `null` berubah
     * menjadi angka pada penjumlahan pertama yang sah. */
    var totalWastedDay = null;
    var totalWastedMonth = null;
    var unitsCounted = 0;      // unit yang menyumbang angka
    var unitsUncounted = 0;    // unit yang TIDAK bisa dihitung — wajib dilaporkan
    var highPenaltyCount = 0;

    alignedUnits.forEach(function (al) {
      var sum = al.unitSummary;
      var penalty = evaluateTechnicalPenalty(sum, fleetBaseline, options) || {};
      /* [F3 2026-11-07, akar AUD-11] Fallback lama `{id:'Q3', ... 'P3 —
       * Optimal'}` MENGARANG kuadran sehat saat `classifyQuadrant`
       * mengembalikan null (baseline tak terukur / blowby|lGt kosong).
       * Unit tanpa dasar perbandingan BUKAN "Optimal" — ia "tidak bisa
       * dinilai". Fallback jujur: id null, tidak masuk hitungan quadCounts,
       * priority jatuh ke penalty.priority (berbasis blowby saja bila
       * delta null — lihat evaluateTechnicalPenalty). */
      /* [F4 2026-11-08, akar AUD-5] Kuadran kini memakai `medianLgtEnv`
       * (TERNORMALISASI), dibandingkan terhadap `baseLgtEnv`.
       * -----------------------------------------------------------------
       * Sebelumnya kuadran -- dasar rekomendasi tindakan bengkel --
       * memakai `medianLgt` MENTAH sementara `medianLgtEnv` dihitung,
       * disimpan, diekspor, lalu diabaikan. Keduanya WAJIB dari ruang yang
       * SAMA: membandingkan lGt ternormalisasi terhadap baseline mentah
       * (atau sebaliknya) akan menggeser seluruh armada ke satu kuadran. */
      var quadLgt = isNum(sum.medianLgtEnv) ? sum.medianLgtEnv : sum.medianLgt;
      var quadBase = isNum(baseLgtEnv) ? baseLgtEnv : baseLgt;
      var quad = classifyQuadrant(sum.medianBlowby, quadLgt, {
        blowbyThreshold: healthyThreshold,
        baselineLgt: quadBase,
        /* [F4 2026-11-08, akar AUD-6] AMBANG DISATUKAN.
         * Sebelumnya prioritas memakai `penaltyWarnPct` (default 6,0)
         * sementara kuadran memakai `penaltyThresholdPct` (default 10,0)
         * -- dua ambang untuk satu konsep, di layar yang sama. Terukur:
         * penalti 8 % memberi prioritas P2 tetapi kuadran Q3/P3.
         * Kini keduanya memakai SATU sumber: `penaltyWarnPct` (6,0). */
        penaltyThresholdPct: isNum(options.penaltyWarnPct) ? options.penaltyWarnPct : 6.0
      }) || {
        id: null, name: 'Tidak Dapat Dinilai', priority: penalty.priority || 'P3',
        badge: '— Baseline tak layak', color: '#64748b',
        cause: 'Baseline armada tidak terukur (sampel sehat < 5)',
        desc: 'Kuadran membutuhkan baseline L/GTKM yang terukur; armada ini belum memilikinya.'
      };

      if (quad.id && quadCounts[quad.id] != null) {
        quadCounts[quad.id]++;
      }

      if (penalty.priority === 'P1') {
        highPenaltyCount++;
      }

      /* Jumlahkan HANYA yang terhitung, dan HITUNG yang tidak. [F2]
       * Unit yang tak bisa dihitung tidak boleh hilang senyap dari total —
       * operator harus tahu total itu mewakili berapa unit. */
      if (isNum(penalty.wastedLitersPerDay)) {
        totalWastedDay = (totalWastedDay || 0) + penalty.wastedLitersPerDay;
        totalWastedMonth = (totalWastedMonth || 0) + (isNum(penalty.wastedLitersPerMonth) ? penalty.wastedLitersPerMonth : penalty.wastedLitersPerDay * 30);
        unitsCounted++;
      } else {
        unitsUncounted++;
      }

      // Siapkan laporan failure mode siap pakai
      var fmReport = generateFailureModeReport({
        unit: sum.unit,
        model: sum.model,
        serial: sum.serial,
        smr: sum.smr,
        date: sum.date,
        blowbyVal: sum.medianBlowby,
        boostVal: sum.medianBoost,
        unitSummary: sum,
        baseline: fleetBaseline,
        sosCr: al.sosCr != null ? al.sosCr : (al.sosSamples && al.sosSamples.cr),
        sosFe: al.sosFe != null ? al.sosFe : (al.sosSamples && al.sosSamples.fe),
        sosSoot: al.sosSoot != null ? al.sosSoot : (al.sosSamples && al.sosSamples.soot),
        sosDilution: al.sosDilution != null ? al.sosDilution : (al.sosSamples && al.sosSamples.dilution),
        faultHistory: al.faultHistory
      });

      evaluatedUnits.push({
        unit: sum.unit,
        vhmsUnitId: sum.vhmsUnitId || null,
        model: sum.model,
        serial: sum.serial,
        smr: sum.smr,
        date: sum.date,
        matchedCount: sum.matchedCount,
        medianBlowby: sum.medianBlowby,
        maxBlowby: sum.maxBlowby,
        medianBoost: sum.medianBoost,
        medianLgt: sum.medianLgt,
        medianLgtEnv: sum.medianLgtEnv != null ? sum.medianLgtEnv : sum.medianLgt,
        medianFr: sum.medianFr,
        medianIdle: sum.medianIdle != null ? sum.medianIdle : null,
        medianPavg: sum.medianPavg != null ? sum.medianPavg : null,
        medianGrade: sum.medianGrade != null ? sum.medianGrade : null,
        // Jam operasi TERUKUR (median dSmr) + penanda bila hanya diasumsikan.
        // UI wajib bisa membedakan "20,4 jam terukur" dari "kami tak tahu". [F2]
        avgDailyHours: sum.avgDailyHours != null ? sum.avgDailyHours : null,
        hoursAssumed: sum.hoursAssumed === true,
        avgDailyGtkm: sum.avgDailyGtkm != null ? sum.avgDailyGtkm : null,
        medianIcFactor: sum.medianIcFactor != null ? sum.medianIcFactor : null,
        medianPayloadFactor: sum.medianPayloadFactor != null ? sum.medianPayloadFactor : null,
        medianGradeFactor: sum.medianGradeFactor != null ? sum.medianGradeFactor : null,
        // [F4 REVIEW] cakupan koreksi per unit — UI wajib menampilkan "n/N jendela"
        envCoverage: sum.envCoverage || null,
        priority: penalty.priority || quad.priority || 'P3',
        penalty: penalty,
        quadrant: quad,
        fmReport: fmReport
      });
    });

    // Urutkan: P1 teratas, lalu P2, lalu P3. Jika sama, urutkan pemborosan terbesar
    var prioScore = { P1: 3, P2: 2, P3: 1 };
    evaluatedUnits.sort(function (a, b) {
      var sa = prioScore[a.priority] || 0;
      var sb = prioScore[b.priority] || 0;
      if (sb !== sa) return sb - sa;
      /* `null` TURUN ke bawah, tidak dianggap 0. [F2, akar AUD-8]
       * Memakai 0 membuat unit "tak terhitung" bercampur dengan unit yang
       * TERUKUR bersih — dua keadaan yang sangat berbeda bagi perencana
       * bengkel. `-1` menempatkannya di bawah unit ber-0 yang sah. */
      var wa = (a.penalty && isNum(a.penalty.wastedLitersPerDay)) ? a.penalty.wastedLitersPerDay : -1;
      var wb = (b.penalty && isNum(b.penalty.wastedLitersPerDay)) ? b.penalty.wastedLitersPerDay : -1;
      return wb - wa;
    });

    // 3. Hitung Korelasi Keseluruhan Armada
    var bbAll = allMatchedRows.map(function (m) { return m.blowby; });
    var lgtAll = allMatchedRows.map(function (m) { return m.lGt; });
    var frAll = allMatchedRows.map(function (m) { return m.fuelRate; });

    var corrLgt = correlate(bbAll, lgtAll);
    var corrFr = correlate(bbAll, frAll);

    /* Korelasi EAB — HANYA dari jendela berstatus koreksi SERAGAM.
     * -------------------------------------------------------------------
     * [F4 2026-11-08, hipotesis H3] Pencampuran populasi adalah jebakan
     * nyata, bukan teoretis. Terukur: memakai semua jendela, sd(log lGt)
     * dalam-unit NAIK di 13/20 unit; dihitung HANYA pada jendela ber-grade
     * (populasi seragam), sd TURUN di 5/6 unit (HDKM78526 -56 %).
     *
     * Sebabnya aritmetika sederhana: 6,7 % jendela dibagi `exp(-kRR*g/100)`
     * sementara 93,3 % tidak, sehingga dua kelompok bergeser relatif satu
     * terhadap yang lain. Menggabungkannya menciptakan sebaran bimodal yang
     * TAMPAK seperti derau — padahal itu artefak pencampuran.
     *
     * Maka: pilih status koreksi yang PALING BANYAK dipakai, lalu hitung
     * korelasi HANYA di dalam kelompok itu. Kelompok dilaporkan lewat
     * `eab.corrEnvGroup` supaya operator tahu angka itu mewakili apa. */
    var envGroups = {};
    allMatchedRows.forEach(function (m) {
      if (!isNum(m.blowby) || !isNum(m.lGtEnv)) return;
      if (m.excludedFromBaseline) return;
      var key = m.envApplied == null ? '' : m.envApplied;
      (envGroups[key] = envGroups[key] || []).push(m);
    });
    var corrEnvGroup = null;
    var corrEnvGroupN = 0;
    Object.keys(envGroups).forEach(function (k) {
      if (envGroups[k].length > corrEnvGroupN) { corrEnvGroupN = envGroups[k].length; corrEnvGroup = k; }
    });
    var envRows = corrEnvGroup == null ? [] : envGroups[corrEnvGroup];
    var corrLgtEnv = correlate(
      envRows.map(function (m) { return m.blowby; }),
      envRows.map(function (m) { return m.lGtEnv; })
    );

    var fuelPrice = isNum(options.fuelPricePerLiter) ? options.fuelPricePerLiter : 15000;
    /* Rupiah TERTAHAN bila tidak ada liter yang terhitung. [F2 2026-11-07]
     * Angka Rupiah adalah keluaran yang paling mungkin dibawa ke rapat.
     * Menerbitkan "Rp 0" dari data yang tak terhitung lebih buruk daripada
     * menerbitkan "—": yang pertama tampak seperti temuan. */
    var monthlySavings = (totalWastedMonth != null) ? Math.round(totalWastedMonth * fuelPrice) : null;

    // [F5 2026-11-10] KORELASI R² DUA TINGKAT.
    // =========================================
    // Sebelumnya: R² gabungan jendela (pseudo-replikasi, menyesatkan).
    // Kini: (1) U2U = tingkat unit, (2) WU = dalam-unit, (3) overallCorrelation = diagnostik saja.
    var corrU2U = correlateUnitToUnit(evaluatedUnits);
    var corrWU = correlateWithinUnits(evaluatedUnits, allMatchedRows);

    return {
      baseline: fleetBaseline,
      // [F5] Korelasi tingkat unit — menjawab "unit boros cenderung blowby tinggi?"
      correlationUnitToUnit: corrU2U,
      // [F5] Korelasi dalam-unit — menjawab "hubungan blowby-konsumsi per unit kuat?"
      correlationWithinUnits: corrWU,
      // [F5] Korelasi keseluruhan = DIAGNOSTIK, label pseudo-replikasi ditambahkan konsumen
      overallCorrelation: corrLgt,
      overallCorrelationEnv: corrLgtEnv,
      overallCorrelationFr: corrFr,
      bins: bRes ? bRes.bins : [],
      eab: {
        active: eabEnabled,
        status: fleetBaseline.eabStatus,
        // `null` DITERUSKAN, tidak dipaksa 0. [F1 2026-11-07, akar AUD-13]
        // -----------------------------------------------------------------
        // `correlate` kini jujur mengembalikan null saat korelasi tak
        // terdefinisi. Memetakannya ke 0 di sini akan MENGALAHKAN perbaikan
        // itu satu lapis di atasnya: UI menerima 0 dan menampilkan
        // "R² = 0.0%" sebagai temuan, padahal artinya "tak bisa dijawab".
        // `fuel-vhms-app.js:128` & `:633` SUDAH memeriksa `!= null` dan
        // menampilkan "—", jadi meneruskan null memakai jalur yang ada.
        r2Raw: corrLgt ? corrLgt.r2 : null,
        r2Env: corrLgtEnv ? corrLgtEnv.r2 : (corrLgt ? corrLgt.r2 : null),
        // deltaR2 hanya bermakna bila KEDUA korelasi ada.
        deltaR2: (corrLgtEnv && corrLgt) ? (corrLgtEnv.r2 - corrLgt.r2) : null,
        fleetPayloadMedian: fleetPayloadMedian,
        totalExcluded: (bRes && bRes.totalExcluded) || 0,

        /* [F4 JALAN C 2026-11-08] KALIBRASI & CAKUPAN — wajib terbit.
         * -----------------------------------------------------------------
         * Operator harus bisa menjawab tiga pertanyaan tanpa membuka kode:
         *   1. Angka koreksinya BERAPA, dan dari mana?  -> `calibration`
         *   2. Berapa banyak jendela yang BENAR-BENAR terkoreksi?
         *      -> `coverage` (terukur: idle 100 %, grade hanya 6,7 %)
         *   3. Korelasi EAB itu mewakili kelompok yang mana?
         *      -> `corrEnvGroup` ('IG' = idle+grade, 'I' = idle saja, '' = none)
         *
         * Tanpa (2), operator akan mengira seluruh armada sudah ternormalisasi
         * padahal hanya 7 % jendela yang tersentuh koreksi grade. */
        calibration: {
          wIdle: {
            ok: calibration.wIdle.ok,
            value: calibration.wIdle.value,
            reason: calibration.wIdle.reason,
            nUnits: calibration.wIdle.nUnits,
            nUnitsTried: calibration.wIdle.nUnitsTried,
            p25: calibration.wIdle.p25 != null ? calibration.wIdle.p25 : null,
            p75: calibration.wIdle.p75 != null ? calibration.wIdle.p75 : null
          },
          kRollingResist: {
            ok: calibration.kRR.ok,
            value: calibration.kRR.value,
            reason: calibration.kRR.reason,
            nUnits: calibration.kRR.nUnits,
            nUnitsTried: calibration.kRR.nUnitsTried,
            p25: calibration.kRR.p25 != null ? calibration.kRR.p25 : null,
            p75: calibration.kRR.p75 != null ? calibration.kRR.p75 : null
          },
          // payload normalization DICABUT di F4 — dicatat agar jelas bahwa
          // ketiadaannya adalah KEPUTUSAN, bukan kelalaian.
          payload: { ok: false, reason: 'removed-double-correction', value: null }
        },
        coverage: {
          totalWindows: allMatchedRows.length,
          idleApplied: allMatchedRows.filter(function (m) { return m.idleApplied === true; }).length,
          gradeApplied: allMatchedRows.filter(function (m) { return m.gradeApplied === true; }).length
        },
        corrEnvGroup: corrEnvGroup,
        corrEnvGroupN: corrEnvGroupN
      },
      kpi: {
        totalUnits: evaluatedUnits.length,
        highPenaltyCount: highPenaltyCount,
        correlationR2: corrLgt ? corrLgt.r2 : null,
        correlationR2Env: corrLgtEnv ? corrLgtEnv.r2 : (corrLgt ? corrLgt.r2 : null),
        // `null` diteruskan: "tak terhitung" ≠ "nol pemborosan". [F2]
        fleetWastedLitersPerDay: (totalWastedDay == null) ? null : Math.round(totalWastedDay),
        fleetWastedLitersPerMonth: (totalWastedMonth == null) ? null : Math.round(totalWastedMonth),
        monthlyCostSavings: monthlySavings,
        // Total di atas mewakili berapa unit? Tanpa ini, total dari 2 unit
        // tampak sama berwibawa dengan total dari 30 unit.
        unitsCounted: unitsCounted,
        unitsUncounted: unitsUncounted,
        quadrantCounts: quadCounts
      },
      units: evaluatedUnits,
      allMatchedRows: allMatchedRows
    };
  }

  /**
   * Mengumpulkan data unit otomatis dari modul global browser jika tersedia.
   */
  function _collectFleetFromGlobals() {
    var list = [];
    var fuelStore = global.FUEL_STORE;
    var vhmsFleet = global.VHMS_FLEET;
    // [FIX 2026-11-03] Nama global sebenarnya adalah VHMS_UNITDB (bukan VHMS_UNIT_DB).
    var unitDb = global.VHMS_UNITDB || global.VHMS_UNIT_DB || null;
    var sosStore = global.SOS_STORE;

    if (!fuelStore || typeof fuelStore.list !== 'function') return list;

    // [FIX 2026-11-03] Bangun indeks VHMS Fleet sekali dari semua unit yang ada,
    // ber-kunci ganda: serial (ternormalisasi) DAN lambung — karena VHMS Fleet
    // menggunakan ID internal (model+serial), bukan serial/lambung langsung.
    // Pakai VHMS_FLEET.ids() + get() untuk iterasi seluruh unit.
    var vhmsById = {};       // key = serial ternormalisasi  -> unit VHMS
    var vhmsByLambung = {};  // key = lambung ternormalisasi -> unit VHMS
    if (vhmsFleet && typeof vhmsFleet.ids === 'function') {
      var allIds = vhmsFleet.ids() || [];
      allIds.forEach(function (id) {
        var u = vhmsFleet.get(id);
        if (!u) return;
        // Serial dari analysis.meta
        var sn = (u.analysis && u.analysis.meta && u.analysis.meta.serial)
          ? String(u.analysis.meta.serial).trim().toUpperCase().replace(/[\s._\-/]+/g, '')
          : '';
        if (sn) vhmsById[sn] = u;
        // Lambung dari summaryRow (sudah di-lookup ke VHMS_UNITDB saat add/restore)
        var lb = (u.summaryRow && u.summaryRow.lambung)
          ? String(u.summaryRow.lambung).trim().toUpperCase()
          : '';
        if (lb) vhmsByLambung[lb] = u;
      });
    }

    function normSerial(s) {
      return String(s == null ? '' : s).trim().toUpperCase().replace(/[\s._\-/]+/g, '');
    }
    function normLambung(s) {
      return String(s == null ? '' : s).trim().toUpperCase();
    }

    var storedUnits = fuelStore.list() || [];
    storedUnits.forEach(function (fu) {
      // Serial dari key 'S:<serial>' atau dari field serial
      var serial = fu.serial
        ? fu.serial
        : (fu.key ? fu.key.replace(/^S:/, '') : '');

      // Lambung: lookup dari Unit DB menggunakan serial
      var lambung = (unitDb && typeof unitDb.getLambung === 'function')
        ? (unitDb.getLambung(serial) || null)
        : null;

      // [FIX 2026-11-03] Cari unit VHMS Fleet: coba cocokkan via serial dulu,
      // lalu via lambung. VHMS Fleet sudah terkonversi ke lambung di summaryRow,
      // tapi analysis.meta masih menyimpan serial asli.
      var snNorm = normSerial(serial);
      var lbNorm = lambung ? normLambung(lambung) : '';
      var vhmsUnit = (snNorm && vhmsById[snNorm])
        ? vhmsById[snNorm]
        : (lbNorm && vhmsByLambung[lbNorm] ? vhmsByLambung[lbNorm] : null);

      // Ambil records dari analysis (sumber paling lengkap setelah restore)
      var records = [];
      if (vhmsUnit) {
        if (vhmsUnit.analysis && vhmsUnit.analysis.records && vhmsUnit.analysis.records.length) {
          records = vhmsUnit.analysis.records;
        } else if (vhmsUnit.rawRecords && vhmsUnit.rawRecords.length) {
          records = vhmsUnit.rawRecords;
        }
      }

      // Nama tampilan unit: utamakan lambung (sudah terkonversi), fallback serial
      var displayUnit = lambung || serial;

      // Model: dari fuel store atau dari VHMS analysis meta
      var model = fu.model
        || (vhmsUnit && vhmsUnit.analysis && vhmsUnit.analysis.meta && vhmsUnit.analysis.meta.model)
        || (vhmsUnit && vhmsUnit.summaryRow && vhmsUnit.summaryRow.model)
        || 'HD785-7';

      // SMR terakhir dari VHMS
      var smrLast = vhmsUnit && vhmsUnit.summaryRow && vhmsUnit.summaryRow.smrLast != null
        ? vhmsUnit.summaryRow.smrLast
        : null;

      // Windows fuel dari FUEL_STORE (sudah dalam format yang diproses oleh compact())
      var windows = [];
      if (fu.summary && fu.summary.windows && fu.summary.windows.length) {
        // Format tersimpan: { date, t1, dSmr, Lh, L, lTk, lGt, idle, cov, pavg, ovl ... }
        windows = fu.summary.windows.map(function (w) {
          return {
            date: w.date,
            smr: w.t1 != null ? w.t1 : null,
            dSmr: w.dSmr != null ? w.dSmr : 20.0,
            lGt: w.lGt != null ? w.lGt : null,
            lTk: w.lTk != null ? w.lTk : null,
            fuelRate: w.Lh != null ? w.Lh : null,
            liters: w.L != null ? w.L : null,
            n: w.n != null ? w.n : 0,
            idle: isNum(w.idle) ? w.idle : (isNum(w.idleFraction) ? w.idleFraction : null),
            cov: isNum(w.cov) ? w.cov : (isNum(w.coverage) ? w.coverage : null),
            pavg: isNum(w.pavg) ? w.pavg : (isNum(w.payloadAvg) ? w.payloadAvg : null),
            ovl: isNum(w.ovl) ? w.ovl : null,
            unit: displayUnit,
            serial: serial
          };
        });
      }

      // SOS Lab data
      var sosCr = null, sosFe = null, sosSoot = null, sosDilution = null;
      if (sosStore) {
        var suList = [];
        if (typeof sosStore.getAllUnits === 'function') {
          suList = sosStore.getAllUnits() || [];
        } else if (typeof sosStore.getUnits === 'function') {
          suList = sosStore.getUnits() || [];
        }

        var matchedSosUnits = [];
        for (var si = 0; si < suList.length; si++) {
          var su = suList[si];
          var suLambung = normLambung(su.assetId || su.unitNumber || (su.latest && su.latest.asset_id) || '');
          var suSerial = normSerial(su.serial || su.serialNumber || (su.latest && su.latest.asset_serial) || '');
          if ((lbNorm && suLambung === lbNorm) || (snNorm && suSerial === snNorm) || (lbNorm && suSerial === lbNorm)) {
            matchedSosUnits.push(su);
          }
        }

        // Cari sampel Engine terdekat / terbaru dari unit SOS yang cocok
        var engUnit = null;
        for (var mj = 0; mj < matchedSosUnits.length; mj++) {
          var mComp = String(matchedSosUnits[mj].component || '').toUpperCase();
          if (mComp.indexOf('ENG') >= 0) {
            engUnit = matchedSosUnits[mj];
            break;
          }
        }
        if (!engUnit && matchedSosUnits.length) engUnit = matchedSosUnits[0];

        if (engUnit) {
          var samples = engUnit.samples || (engUnit.latest ? [engUnit.latest] : []);
          var latestSample = samples.length ? samples[samples.length - 1] : engUnit.latest;
          if (latestSample) {
            sosCr = latestSample.wear_cr != null ? latestSample.wear_cr : (latestSample.cr != null ? latestSample.cr : latestSample.Cr);
            sosFe = latestSample.wear_fe != null ? latestSample.wear_fe : (latestSample.fe != null ? latestSample.fe : latestSample.Fe);
            sosSoot = latestSample.soot != null ? latestSample.soot : latestSample.Soot;
            sosDilution = latestSample.fuel_pct != null ? latestSample.fuel_pct : (latestSample.fuel != null ? latestSample.fuel : latestSample.dilution);
          }
        }
      }

      // Fault history dari VHMS Fleet
      var faultHistory = [];
      if (vhmsUnit) {
        var faultEvents = vhmsUnit.faultEvents || [];
        if (faultEvents.length) {
          faultHistory = faultEvents.slice(0, 5).map(function (e) {
            var code = e.code || '';
            var msg = e.msg || '';
            return code + (msg ? ' — ' + msg : '');
          });
        }
      }

      list.push({
        unit: displayUnit,
        // `id` merupakan key resmi untuk VHMS_APP.openUnit(), bukan serial.
        vhmsUnitId: vhmsUnit && vhmsUnit.id ? vhmsUnit.id : null,
        model: model,
        serial: serial,
        smr: smrLast,
        records: records,
        windows: windows,
        sosSamples: { cr: sosCr, fe: sosFe, soot: sosSoot, dilution: sosDilution },
        faultHistory: faultHistory
      });
    });

    return list;
  }

  /* -----------------------------------------------------------------------
   * 7. Generator Report Failure Mode (FM-RING & FM-TURBO)
   * --------------------------------------------------------------------- */

  /**
   * Menyusun dokumen laporan Failure Mode terstruktur.
   */
  function generateFailureModeReport(data) {
    data = data || {};
    /* [F3 2026-11-07, akar AUD-11] Fallback hafalan `{baseLgt:0.0442,
     * baseFr:73.0}` DICABUT. Bila `data.baseline` tak disediakan, kirim
     * objek kosong `{}` — `evaluateTechnicalPenalty` SUDAH null-aware:
     * delta jadi null, priority jatuh ke evaluasi berbasis blowby saja.
     * Laporan tidak lagi membandingkan terhadap baseline yang dikarang. */
    var penalty = evaluateTechnicalPenalty(data.unitSummary || {}, data.baseline || {}) || {};

    var faultList = data.faultHistory || [];
    var defaultFaults = faultList.length ? faultList : ['Tidak ada kode fault aktif saat evaluasi'];

    // Periksa kode fault ECM khusus (DHE5KB, F@BBZL, CA115, dll)
    var hasBlowbyFault = false;
    var hasBoostOrExhFault = false;
    faultList.forEach(function (f) {
      var str = String(f).toUpperCase();
      if (str.indexOf('DHE5KB') >= 0 || str.indexOf('F@BBZL') >= 0) hasBlowbyFault = true;
      if (str.indexOf('DGT') >= 0 || str.indexOf('F@BY') >= 0 || str.indexOf('CA115') >= 0) hasBoostOrExhFault = true;
    });

    var quickTasks = [
      'Lakukan manual blow-by test menggunakan manometer pada kondisi stall speed.',
      'Lakukan Engine Cylinder Cut-out Test melalui Service Tool untuk mendeteksi silinder drop.'
    ];
    if (hasBlowbyFault) {
      quickTasks.unshift('VERIFIKASI / KALIBRASI sensor tekanan blowby (crankcase) terkait kode aktif ECM (DHE5KB/F@BBZL).');
    }
    if (hasBoostOrExhFault) {
      quickTasks.push('Periksa jalur sensor suhu gas buang & harness ECM dari gesekan/overheat.');
    }

    var maintTasks = [
      'Inspeksi borescopic pada dinding liner silinder yang terindikasi scoring/glazing.',
      'Periksa kebersihan saringan udara (Air Cleaner) dan pastikan tidak ada kebocoran intercooler piping.'
    ];
    if (data.sosFe > 80 || data.sosCr > 5) {
      maintTasks.push('Periksa filter oli mesin dari serpihan logam (cutting filter inspection) konfirmasi temuan lab Fe/Cr.');
    }

    var report = {
      caseId: data.caseId || ('FM-RING-' + (data.unit || 'UNIT')),
      title: 'RELIABILITY & FUEL IMPACT REPORT — FAILURE MODE',
      generatedAt: new Date().toISOString(),
      identity: {
        unit: data.unit || '—',
        model: data.model || 'HD785-7',
        serial: data.serial || '—',
        smr: data.smr != null ? data.smr : '—',
        evaluationDate: data.date || '—',
        priority: penalty.priority || 'P2'
      },
      technicalEvidence: {
        parameter: 'Blowby Press Max (kPa)',
        actual: data.blowbyVal != null ? Number(data.blowbyVal).toFixed(2) : '—',
        status: (data.blowbyVal >= 5.0 ? 'CRITICAL' : (data.blowbyVal >= 4.0 ? 'WARNING' : 'ELEVATED')),
        thresholds: { normal: '< 3.2', warning: '4.0 - 5.0', critical: '>= 5.0' },
        boostDeficit: data.boostVal != null ? (data.boostVal < 150 ? 'Defisit Terdeteksi (' + data.boostVal + ' mmHg)' : 'Normal') : '—',
        faultHistory: defaultFaults,
        hasEcmCodes: hasBlowbyFault || hasBoostOrExhFault
      },
      fuelImpact: {
        metric: 'Liter per Gross Ton-Kilometer (L/GTKM)',
        actualLgt: penalty.actualLgt != null ? penalty.actualLgt.toFixed(4) : '—',
        baselineLgt: penalty.baselineLgt != null ? penalty.baselineLgt.toFixed(4) : '—',
        deltaPct: penalty.deltaLgtPct != null ? (penalty.deltaLgtPct >= 0 ? '+' : '') + penalty.deltaLgtPct.toFixed(1) + ' %' : '—',
        actualFr: penalty.actualFr != null ? penalty.actualFr.toFixed(1) + ' L/h' : '—',
        baselineFr: penalty.baselineFr != null ? penalty.baselineFr.toFixed(1) + ' L/h' : '—',
        deltaFr: penalty.deltaFr != null ? (penalty.deltaFr >= 0 ? '+' : '') + penalty.deltaFr.toFixed(1) + ' L/h' : '—',
        wastedPerDay: penalty.wastedLitersPerDay ? Math.round(penalty.wastedLitersPerDay) + ' Liter/hari' : '—',
        wastedPerMonth: penalty.wastedLitersPerMonth ? Math.round(penalty.wastedLitersPerMonth) + ' Liter/bulan' : '—'
      },
      labEvidence: {
        cr: data.sosCr != null ? data.sosCr + ' ppm' : 'Normal / Belum Ada Sample Baru',
        fe: data.sosFe != null ? data.sosFe + ' ppm' : 'Normal / Belum Ada Sample Baru',
        soot: data.sosSoot != null ? data.sosSoot + ' %' : 'Dalam Batas Normal (< 1.5%)',
        dilution: data.sosDilution != null ? data.sosDilution + (typeof data.sosDilution === 'number' ? '%' : '') : 'Negatif (< 1.0%)'
      },
      diagnosis: data.diagnosis || (
        'Terjadi peningkatan tekanan blow-by di atas batas normal akibat keausan ring piston / cylinder liner. ' +
        'Kebocoran kompresi menurunkan efisiensi termal pembakaran sehingga ECM menginjeksi bahan bakar lebih banyak ' +
        'untuk mempertahankan torsi kerja.' +
        (hasBlowbyFault ? ' Catatan: Terdeteksi kode fault ECM terkait sensor blow-by yang perlu dikalibrasi.' : '')
      ),
      actionPlan: [
        {
          stage: '1. Tindakan Cepat (24 - 48 Jam)',
          tasks: quickTasks
        },
        {
          stage: '2. Tindakan Maintenance (Next Scheduled PM)',
          tasks: maintTasks
        },
        {
          stage: '3. Perencanaan Komponen (Parts Planning)',
          tasks: [
            'Siapkan part kit In-frame Overhaul (Piston rings, cylinder liners, seal kit, top gasket).'
          ]
        }
      ]
    };

    return report;
  }

  /**
   * Menghasilkan teks ASCII rapi dari objek report untuk clipboard / terminal / cetak.
   */
  function formatReportText(rep) {
    if (!rep) return '';
    var id = rep.identity || {};
    var te = rep.technicalEvidence || {};
    var fi = rep.fuelImpact || {};
    var lab = rep.labEvidence || {};

    var lines = [];
    lines.push('====================================================================================================');
    lines.push('                        RELIABILITY & FUEL IMPACT REPORT — FAILURE MODE');
    lines.push('                                  KODE KASUS: ' + rep.caseId);
    lines.push('====================================================================================================');
    lines.push('[IDENTITAS UNIT]');
    lines.push('Unit / Lambung : ' + id.unit + '          Model   : ' + id.model + '               SMR Evaluasi : ' + id.smr);
    lines.push('Serial Number  : ' + id.serial + '             Tingkat : [' + id.priority + ']               Tanggal      : ' + id.evaluationDate);
    lines.push('----------------------------------------------------------------------------------------------------');
    lines.push('[1. STATUS DEGRADASI TEKNIS (VHMS ENGINE TELEMETRY)]');
    lines.push('* Parameter      : ' + te.parameter);
    lines.push('* Nilai Terkini  : ' + te.actual + ' kPa  [STATUS: ' + te.status + ']  (Ambang: Normal ' + te.thresholds.normal + ' | Warn ' + te.thresholds.warning + ' | Crit ' + te.thresholds.critical + ')');
    lines.push('* Pasokan Udara  : ' + te.boostDeficit);
    lines.push('* Riwayat Fault  : ' + te.faultHistory.join(', '));
    lines.push('----------------------------------------------------------------------------------------------------');
    lines.push('[2. DAMPAK EFISIENSI FUEL (FUEL & PLD ATTRIBUTION)]');
    lines.push('* Metrik Beban   : ' + fi.metric);
    lines.push('* Baseline Sehat : ' + fi.baselineLgt + '  vs  Aktual: ' + fi.actualLgt + '  (' + fi.deltaPct + ')');
    lines.push('* Hourly Burn    : ' + fi.baselineFr + '  vs  Aktual: ' + fi.actualFr + '  (' + fi.deltaFr + ')');
    lines.push('* Solar Terbuang : ~ ' + fi.wastedPerDay + ' (~ ' + fi.wastedPerMonth + ' operasi)');
    lines.push('----------------------------------------------------------------------------------------------------');
    lines.push('[3. TRIANGULASI BUKTI SOS (LABORATORY VERIFICATION)]');
    lines.push('* Chromium (Cr)  : ' + lab.cr + '  |  Iron (Fe) : ' + lab.fe);
    lines.push('* Soot / Jelaga  : ' + lab.soot + '  |  Dilution  : ' + lab.dilution);
    lines.push('----------------------------------------------------------------------------------------------------');
    lines.push('[4. KESIMPULAN DIAGNOSTIK & AKAR MASALAH]');
    lines.push(rep.diagnosis);
    lines.push('----------------------------------------------------------------------------------------------------');
    lines.push('[5. REKOMENDASI TINDAKAN WORKSHOP (ACTIONABLE WORK ORDER)]');
    (rep.actionPlan || []).forEach(function (plan) {
      lines.push(plan.stage + ':');
      plan.tasks.forEach(function (t) {
        lines.push('  - ' + t);
      });
    });
    lines.push('====================================================================================================');

    return lines.join('\n');
  }

  /**
   * Menghasilkan representasi HTML terstruktur untuk modal / cetak PDF.
   */
  function formatReportHtml(rep) {
    if (!rep) return '';
    var id = rep.identity || {};
    var te = rep.technicalEvidence || {};
    var fi = rep.fuelImpact || {};
    var lab = rep.labEvidence || {};

    var prioColor = id.priority === 'P1' ? '#ef4444' : (id.priority === 'P2' ? '#f59e0b' : '#22c55e');
    var statusColor = te.status === 'CRITICAL' ? '#ef4444' : (te.status === 'WARNING' ? '#f59e0b' : '#38bdf8');

    var html = [
      '<div class="fm-report-card" style="font-family:inherit;color:#f8fafc;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:20px;line-height:1.5">',
      '  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #334155;padding-bottom:14px;margin-bottom:16px">',
      '    <div>',
      '      <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#94a3b8;text-transform:uppercase">' + (rep.caseId || 'FM-RING-FUEL') + '</div>',
      '      <h2 style="font-size:18px;font-weight:700;margin:4px 0 2px 0;color:#f8fafc">' + (rep.title || 'RELIABILITY & FUEL IMPACT REPORT') + '</h2>',
      '      <div style="font-size:12px;color:#94a3b8">Dibuat: ' + (rep.generatedAt ? rep.generatedAt.slice(0, 10) : '—') + ' | SMR: <strong>' + (id.smr || '—') + ' h</strong></div>',
      '    </div>',
      '    <div style="text-align:right">',
      '      <span style="display:inline-block;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:700;background:' + prioColor + '20;color:' + prioColor + ';border:1px solid ' + prioColor + '">Prioritas ' + (id.priority || 'P2') + '</span>',
      '      <div style="font-size:12px;color:#94a3b8;margin-top:4px">Unit: <strong style="color:#f8fafc">' + (id.unit || '—') + '</strong> (' + (id.model || '—') + ')</div>',
      '    </div>',
      '  </div>',

      '  <!-- Grid 3 Kolom Bukti -->',
      '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:16px">',
      '    <!-- Pilar 1: VHMS Engine Telemetry -->',
      '    <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px">',
      '      <div style="font-size:12px;font-weight:700;color:#38bdf8;margin-bottom:8px"><i class="fa-solid fa-gauge-high"></i> 1. Telemetri Mesin VHMS</div>',
      '      <div style="font-size:11px;color:#94a3b8">Parameter: <strong>' + (te.parameter || 'Blowby Max') + '</strong></div>',
      '      <div style="font-size:18px;font-weight:700;color:' + statusColor + ';margin:4px 0">' + (te.actual || '—') + ' <span style="font-size:12px;font-weight:400">kPa</span></div>',
      '      <div style="font-size:11px;color:#94a3b8">Status: <strong style="color:' + statusColor + '">' + (te.status || 'NORMAL') + '</strong></div>',
      '      <div style="font-size:11px;color:#94a3b8;margin-top:4px">Pasokan Udara: ' + (te.boostDeficit || 'Normal') + '</div>',
      '    </div>',

      '    <!-- Pilar 2: Fuel & PLD Impact -->',
      '    <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px">',
      '      <div style="font-size:12px;font-weight:700;color:#f59e0b;margin-bottom:8px"><i class="fa-solid fa-gas-pump"></i> 2. Dampak Konsumsi Solar</div>',
      '      <div style="font-size:11px;color:#94a3b8">Spesifik L/GTKM: <strong>' + (fi.actualLgt || '—') + '</strong> (Base: ' + (fi.baselineLgt || '—') + ')</div>',
      '      <div style="font-size:18px;font-weight:700;color:#f59e0b;margin:4px 0">' + (fi.deltaPct || '+0 %') + ' <span style="font-size:12px;font-weight:400">Deviasi</span></div>',
      '      <div style="font-size:11px;color:#cbd5e1">Solar Terbuang: <strong style="color:#ef4444">' + (fi.wastedPerDay || '—') + '</strong></div>',
      '      <div style="font-size:11px;color:#94a3b8;margin-top:2px">Proyeksi Bulanan: ' + (fi.wastedPerMonth || '—') + '</div>',
      '    </div>',

      '    <!-- Pilar 3: SOS Lab Triangulation -->',
      '    <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px">',
      '      <div style="font-size:12px;font-weight:700;color:#22c55e;margin-bottom:8px"><i class="fa-solid fa-flask-vial"></i> 3. Validasi Logam SOS</div>',
      '      <div style="font-size:11px;color:#94a3b8">Chromium (Piston Ring): <strong>' + (lab.cr || '—') + '</strong></div>',
      '      <div style="font-size:11px;color:#94a3b8">Iron (Cylinder Liner): <strong>' + (lab.fe || '—') + '</strong></div>',
      '      <div style="font-size:11px;color:#94a3b8">Soot (Jelaga): <strong>' + (lab.soot || '—') + '</strong></div>',
      '      <div style="font-size:11px;color:#94a3b8">Dilution (Pengenceran): <strong>' + (lab.dilution || '—') + '</strong></div>',
      '    </div>',
      '  </div>',

      '  <!-- Diagnosis & Root Cause -->',
      '  <div style="background:#1e293b;border-left:4px solid #f59e0b;border-radius:0 6px 6px 0;padding:12px 14px;margin-bottom:16px">',
      '    <div style="font-size:12px;font-weight:700;color:#fbbf24;margin-bottom:4px"><i class="fa-solid fa-clipboard-check"></i> Kesimpulan Diagnostik &amp; Akar Masalah</div>',
      '    <p style="font-size:12px;color:#e2e8f0;margin:0">' + (rep.diagnosis || '—') + '</p>',
      '  </div>',

      '  <!-- Rekomendasi Tindakan -->',
      '  <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:14px">',
      '    <div style="font-size:13px;font-weight:700;color:#f8fafc;margin-bottom:10px"><i class="fa-solid fa-wrench"></i> Rekomendasi Tindakan Teknisi (Action Plan)</div>'
    ];

    (rep.actionPlan || []).forEach(function (plan) {
      var stageTitle = plan.stage || plan.priority || plan.label || 'Tindakan';
      html.push('    <div style="margin-bottom:10px">');
      html.push('      <div style="font-size:12px;font-weight:700;color:#38bdf8">' + stageTitle + '</div>');
      html.push('      <ul style="margin:4px 0 0 18px;padding:0;font-size:12px;color:#cbd5e1">');
      (plan.tasks || []).forEach(function (t) {
        html.push('        <li>' + t + '</li>');
      });
      html.push('      </ul>');
      html.push('    </div>');
    });

    html.push('  </div>');
    html.push('</div>');

    return html.join('\n');
  }

  /* -----------------------------------------------------------------------
   * 8. Utilitas Ekspor CSV
   * --------------------------------------------------------------------- */

  /**
   * Menghasilkan teks CSV dari hasil evaluasi unit armada.
   */
  function exportFleetCsv(units, baseline) {
    if (!units || !units.length) return '';
    /* [F3 2026-11-07, akar AUD-11] Fallback hafalan DICABUT. `baseLgt`/
     * `baseFr` bisa null (`fabricated`) — kolom CSV-nya kini kosong (""),
     * bukan angka karangan. `.toFixed()` di bawah dijaga `isNum(...)`
     * supaya TIDAK crash saat null (sebelumnya `baseLgt.toFixed(4)` akan
     * melempar TypeError bila baseLgt null). */
    var baseLgt = baseline && isNum(baseline.baseLgt) ? baseline.baseLgt : null;
    var baseFr = baseline && isNum(baseline.baseFr) ? baseline.baseFr : null;

    var headers = [
      'Unit',
      'Model',
      'Serial',
      'SMR',
      'Tanggal',
      'Prioritas',
      'Kuadran',
      'Median Blowby (kPa)',
      'Max Blowby (kPa)',
      'Median Boost (mmHg)',
      'Idle (%)',
      'Muatan (ton)',
      'Grade GPS (%)',
      'L/GTKM Aktual',
      'L/GTKM Norm (EAB)',
      'L/GTKM Baseline',
      'L/GTKM Baseline (EAB)',
      'Delta L/GTKM (%)',
      'Delta EAB (%)',
      'Fuel Rate Aktual (L/h)',
      'Fuel Rate Baseline (L/h)',
      'Delta Fuel Rate (L/h)',
      'Solar Terbuang (L/hari)',
      'Solar Terbuang (L/bulan)',
      'SOS Cr (ppm)',
      'SOS Fe (ppm)',
      'SOS Soot (%)',
      'SOS Dilution (%)',
      'Riwayat Fault ECM'
    ];

    function csvCell(v) {
      if (v == null) return '""';
      var str = String(v).replace(/"/g, '""');
      return '"' + str + '"';
    }

    var lines = [headers.join(',')];

    units.forEach(function (u) {
      var pen = u.penalty || {};
      var quad = u.quadrant || {};
      var rep = u.fmReport || {};
      var lab = rep.labEvidence || {};
      var te = rep.technicalEvidence || {};
      var baseLgtEnv = (baseline && isNum(baseline.baseLgtEnv)) ? baseline.baseLgtEnv : baseLgt;

      var row = [
        csvCell(u.unit),
        csvCell(u.model),
        csvCell(u.serial),
        csvCell(u.smr),
        csvCell(u.date),
        csvCell(u.priority),
        csvCell(quad.id || ''),
        csvCell(u.medianBlowby != null ? u.medianBlowby.toFixed(2) : ''),
        csvCell(u.maxBlowby != null ? u.maxBlowby.toFixed(2) : ''),
        csvCell(u.medianBoost != null ? u.medianBoost.toFixed(1) : ''),
        csvCell(u.medianIdle != null ? (u.medianIdle * 100).toFixed(1) : ''),
        csvCell(u.medianPavg != null ? u.medianPavg.toFixed(1) : ''),
        csvCell(u.medianGrade != null ? u.medianGrade.toFixed(2) : ''),
        csvCell(u.medianLgt != null ? u.medianLgt.toFixed(4) : ''),
        csvCell(u.medianLgtEnv != null ? u.medianLgtEnv.toFixed(4) : (u.medianLgt != null ? u.medianLgt.toFixed(4) : '')),
        csvCell(isNum(baseLgt) ? baseLgt.toFixed(4) : ''),
        csvCell(isNum(baseLgtEnv) ? baseLgtEnv.toFixed(4) : ''),
        csvCell(pen.deltaLgtPct != null ? pen.deltaLgtPct.toFixed(1) : ''),
        csvCell(pen.deltaLgtEnvPct != null ? pen.deltaLgtEnvPct.toFixed(1) : (pen.deltaLgtPct != null ? pen.deltaLgtPct.toFixed(1) : '')),
        csvCell(u.medianFr != null ? u.medianFr.toFixed(1) : ''),
        csvCell(isNum(baseFr) ? baseFr.toFixed(1) : ''),
        csvCell(pen.deltaFr != null ? pen.deltaFr.toFixed(1) : ''),
        csvCell(pen.wastedLitersPerDay != null ? Math.round(pen.wastedLitersPerDay) : ''),
        csvCell(pen.wastedLitersPerMonth != null ? Math.round(pen.wastedLitersPerMonth) : ''),
        csvCell(lab.cr != null ? lab.cr : ''),
        csvCell(lab.fe != null ? lab.fe : ''),
        csvCell(lab.soot != null ? lab.soot : ''),
        csvCell(lab.dilution != null ? lab.dilution : ''),
        csvCell((te.faultHistory || []).join('; '))
      ];

      lines.push(row.join(','));
    });

    return lines.join('\r\n');
  }

  /**
   * Menghasilkan teks CSV dari sebuah FM Report terinci.
   */
  function exportFmReportCsv(report) {
    if (!report) return '';
    var id = report.identity || {};
    var te = report.technicalEvidence || {};
    var fi = report.fuelImpact || {};
    var lab = report.labEvidence || {};

    var rows = [
      ['Bagian', 'Kunci Parameter', 'Nilai'],
      ['Identitas', 'Kode Kasus', report.caseId || ''],
      ['Identitas', 'Unit', id.unit || ''],
      ['Identitas', 'Model', id.model || ''],
      ['Identitas', 'Serial', id.serial || ''],
      ['Identitas', 'SMR', id.smr || ''],
      ['Identitas', 'Tanggal Evaluasi', id.evaluationDate || ''],
      ['Identitas', 'Tingkat Prioritas', id.priority || ''],
      ['Telemetri', 'Parameter', te.parameter || ''],
      ['Telemetri', 'Aktual (kPa)', te.actual || ''],
      ['Telemetri', 'Status', te.status || ''],
      ['Telemetri', 'Pasokan Udara', te.boostDeficit || ''],
      ['Telemetri', 'Riwayat Fault ECM', (te.faultHistory || []).join('; ')],
      ['Dampak Fuel', 'Metrik Beban', fi.metric || ''],
      ['Dampak Fuel', 'L/GTKM Aktual', fi.actualLgt || ''],
      ['Dampak Fuel', 'L/GTKM Baseline', fi.baselineLgt || ''],
      ['Dampak Fuel', 'Deviasi Delta (%)', fi.deltaPct || ''],
      ['Dampak Fuel', 'Hourly Burn Aktual', fi.actualFr || ''],
      ['Dampak Fuel', 'Hourly Burn Baseline', fi.baselineFr || ''],
      ['Dampak Fuel', 'Solar Terbuang Per Hari', fi.wastedPerDay || ''],
      ['Dampak Fuel', 'Solar Terbuang Per Bulan', fi.wastedPerMonth || ''],
      ['Lab SOS', 'Chromium (Cr)', lab.cr || ''],
      ['Lab SOS', 'Iron (Fe)', lab.fe || ''],
      ['Lab SOS', 'Soot (Jelaga)', lab.soot || ''],
      ['Lab SOS', 'Dilution', lab.dilution || ''],
      ['Diagnosis', 'Kesimpulan Akar Masalah', report.diagnosis || '']
    ];

    (report.actionPlan || []).forEach(function (plan) {
      rows.push(['Rekomendasi', plan.stage, (plan.tasks || []).join('; ')]);
    });

    return rows.map(function (r) {
      return r.map(function (c) {
        return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
  }

  /* -----------------------------------------------------------------------
   * Ekspor API
   * --------------------------------------------------------------------- */

  FVA.EAB_CONFIG = EAB_CONFIG;
  FVA.normalizeEnv = normalizeEnv;
  // [F4 2026-11-08] Diekspor agar uji dapat MENGUNCI perilaku kalibrasi
  // (gerbang, arah, median) tanpa menyalin logikanya.
  FVA.calibrateEab = calibrateEab;
  FVA.correlate = correlate;
  FVA.median = median;
  FVA.average = average;
  FVA.binAnalysis = binAnalysis;
  FVA.DEFAULT_BLOWBY_BINS = DEFAULT_BLOWBY_BINS;
  FVA.evaluateTechnicalPenalty = evaluateTechnicalPenalty;
  FVA.classifyQuadrant = classifyQuadrant;
  FVA.joinRecordsAndWindows = joinRecordsAndWindows;
  FVA.alignUnitTelemetryAndFuel = alignUnitTelemetryAndFuel;
  FVA.analyzeFleetEngineFuel = analyzeFleetEngineFuel;
  FVA.generateFailureModeReport = generateFailureModeReport;
  FVA.formatReportText = formatReportText;
  FVA.formatReportHtml = formatReportHtml;
  FVA.exportFleetCsv = exportFleetCsv;
  FVA.exportFmReportCsv = exportFmReportCsv;

  global.FUEL_VHMS_ANALYTICS = FVA;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FVA;
  }
})(typeof window !== 'undefined' ? window : this);

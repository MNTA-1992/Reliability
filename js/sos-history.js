/* ============================================================================
 * [FASE 0-5 · 2026-10-18] SOS_HISTORY — riwayat umur oli & laju keausan
 * ----------------------------------------------------------------------------
 * Spesifikasi & dasar pengukuran: `docs/JOB-TASK-SOS-FLUID-AGE.md`.
 *
 * GAGASAN INTI — nilai logam mentah (Fe 20 ppm) tidak sebanding antar sampel
 * bila umur oli berbeda. Fe 20 pada oli 424 jam jauh lebih ringan daripada
 * Fe 12 pada oli 192 jam. Nilai mutlak mengukur LAMA OLI DIPAKAI, bukan laju
 * keausan — menilai keausan dari nilai mutlak = menilai pengemudi dari
 * odometer. Modul ini menormalkan ke ppm per 100 jam-oli.
 *
 * MURNI. Tidak menyentuh DOM, tidak membaca localStorage, tidak memanggil
 * Chart. Seluruhnya dapat diuji di Node (pola `js/sos-failmode.js`).
 *
 * ⚠ CATATAN PENGUKURAN (2026-10-18) — dibaca sebelum menyesuaikan rumus:
 *   Rumus `fluidAge()` di bawah ADALAH rumus yang disepakati operator di
 *   task dokumen, diimplementasikan apa adanya. Saat implementasi diuji pada
 *   data nyata PC2000 `EXKM21056` (75 sampel), diperoleh akurasi 66,2 %:
 *   25 dari 50 interval berselisih. SELURUH 25 kasus itu sampel dengan
 *   `Fluid Changed = Y` DAN sampel sebelumnya `N`, di mana kedua kolom lab
 *   (`MoF` & `Calculated`) sama-sama mengembalikan umur oli PENUH (mis. 644,
 *   889) alih-alih hasil rantai (mis. 382, 503). Uji koreksi "jangkar hanya
 *   bila MoF <= dHM" terbukti LEBIH BURUK (62,2 %) sehingga TIDAK dipakai.
 *   Konsekuensinya: pada data seperti ini, sebagian besar `trust` jatuh ke
 *   `COMPUTED`/`UNVERIFIED`, dan itu MEMANG benar — angka kolom lab tidak
 *   terverifikasi. Jangan "memperbaiki" dengan melonggarkan toleransi.
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------------
   * Helper angka
   * ---------------------------------------------------------------------- */

  function isNum(v) {
    return v !== null && v !== undefined && !isNaN(v);
  }

  /** Nilai > 0 atau null. `0` diperlakukan sebagai kolom kosong (lihat J1). */
  function posOrNull(v) {
    return (isNum(v) && v > 0) ? v : null;
  }

  function isChangedY(v) {
    return String(v == null ? '' : v).trim().toUpperCase() === 'Y';
  }

  /** Meter unit untuk urutan & selisih. Fallback `_hm`, lalu `hm_oil`. */
  function meterOf(s) {
    if (!s) return null;
    if (isNum(s.hm_unit)) return s.hm_unit;
    if (isNum(s._hm)) return s._hm;
    return posOrNull(s.hm_oil);
  }

  /** Urut kronologis: tanggal, tie-break meter. Stabil terhadap input. */
  function chronological(samples) {
    return (samples || []).slice().sort(function (a, b) {
      var da = a && a._date ? a._date.getTime() : 0;
      var db = b && b._date ? b._date.getTime() : 0;
      if (da !== db) return da - db;
      return (meterOf(a) || 0) - (meterOf(b) || 0);
    });
  }

  /**
   * Indeks ASLI setiap elemen, dihitung SEBELUM penyortiran.
   * ⚠ Jangan memakai `Map` berkunci objek: objek yang isinya identik masih
   * berbeda kunci, tetapi `Map` aman — yang TIDAK aman adalah mencari indeks
   * lewat `indexOf`/pencocokan nilai, karena sampel kembar akan tertukar.
   * Terbukti: dengan input terbalik, record[0] keliru memakai umur sampel
   * LAIN (198 alih-alih 192). Maka indeks dibawa menempel pada elemennya.
   */
  function withOriginalIndex(samples) {
    return (samples || []).map(function (s, i) { return { s: s, i: i }; });
  }

  /**
   * Toleransi pembulatan lab (J7): `max(2 jam, 1 %)`.
   * TIDAK boleh `===` ketat — berkas nyata memuat 385 vs 386 dan 513 vs 515.
   */
  function tolOf(expected) {
    return Math.max(2, 0.01 * Math.abs(expected));
  }

  /* ------------------------------------------------------------------------
   * 1. fluidAge(samples) — umur oli tervalidasi rantai berjangkar
   * ----------------------------------------------------------------------
   * RUMUS (task dokumen §1 butir 3):
   *
   *   ΔHM(n)   = Meter(n) − Meter(n−1)
   *   expected = ΔHM(n) + ( Changed(n−1) === 'Y' ? 0 : hours(n−1) )
   *
   * Jangkar = setiap sampel SERBELUMNYA yang `Fluid Changed = Y`, artinya
   * oli diganti tepat pada sampel itu sehingga umur oli di sampel berikutnya
   * mulai dari nol.
   *
   * TANGGA KEPUTUSAN (§Fase 1), berhenti di cabang pertama yang cocok:
   *   1. |calc − expected| <= tol  -> CALCULATED / VERIFIED
   *   2. |mof  − expected| <= tol  -> METER_ON_FLUID / VERIFIED
   *   3. expected sah              -> CHAIN / COMPUTED
   *   4. tanpa jangkar / ΔHM<=0 / sampel pertama -> RAW / UNVERIFIED
   *   5. hours <= 0                -> null / INVALID
   *
   * "expected sah" = ΔHM > 0 DAN rantai punya jangkar jelas.
   *
   * @param {object[]} samples  satu asset|komponen, urutan bebas
   * @returns {object[]} array SEJAJAR dengan `samples` MASUKAN (indeks sama)
   * ---------------------------------------------------------------------- */
  function fluidAge(samples) {
    var input = samples || [];
    var n = input.length;
    if (!n) return [];

    var ord = withOriginalIndex(input).sort(function (a, b) {
      var da = a.s && a.s._date ? a.s._date.getTime() : 0;
      var db = b.s && b.s._date ? b.s._date.getTime() : 0;
      if (da !== db) return da - db;
      return (meterOf(a.s) || 0) - (meterOf(b.s) || 0);
    });

    var out = new Array(n);

    var prevRow = null;     // sampel sebelumnya (kronologis)
    var prevOut = null;     // hasil sebelumnya
    var prevHours = null;   // hours(n−1) — inti rumus rantai
    var prevAnchored = false; // apakah sampel sebelumnya `Fluid Changed = Y`

    for (var i = 0; i < ord.length; i++) {
      var x = ord[i].s;
      var mof = posOrNull(x.hm_oil);
      var calc = posOrNull(x.hm_oil_calc);
      var meter = meterOf(x);
      var rec;

      var dHM = (prevRow && isNum(meter) && isNum(meterOf(prevRow)))
        ? (meter - meterOf(prevRow)) : null;

      // --- expected = ΔHM(n) + ( Changed(n−1)=='Y' ? 0 : hours(n−1) ) -----
      // RUMUS TASK DOKUMEN §1 butir 3. Jangkar ditentukan oleh sampel
      // SEBELUMNYA, bukan sampel ini.
      //
      // `prevHours` = umur oli yg DITEMUKAN untuk sampel sebelumnya. Rumus
      // mensyaratkan `hours(n−1)` — jadi bila sampel sebelumnya tak punya
      // umur yang sah, rantai TIDAK boleh dikarang (J2/J3).
      // `prevAnchored` = sampel sebelumnya adalah `Y` (oli baru mulai).
      var expected = null;
      if (dHM !== null && dHM > 0) {
        if (!prevRow) expected = dHM;                          // sampel pertama
        else if (prevAnchored) expected = dHM;                 // Changed(n-1)='Y'
        else if (isNum(prevHours) && prevHours >= 0) {
          expected = dHM + prevHours;                          // rantai berjalan
        }
        // else: rantai tak berjangkar -> expected tetap null
      }

      var expectedValid = expected !== null && expected > 0;

      if (expectedValid) {
        var tol = tolOf(expected);
        if (calc !== null && Math.abs(calc - expected) <= tol) {
          rec = { hours: calc, source: 'CALCULATED', trust: 'VERIFIED',
                  expected: expected, mof: mof, calc: calc };
        } else if (mof !== null && Math.abs(mof - expected) <= tol) {
          rec = { hours: mof, source: 'METER_ON_FLUID', trust: 'VERIFIED',
                  expected: expected, mof: mof, calc: calc };
        } else {
          rec = { hours: expected, source: 'CHAIN', trust: 'COMPUTED',
                  expected: expected, mof: mof, calc: calc };
        }
      } else {
        // --- cabang 4: tanpa jangkar / ΔHM<=0 / sampel pertama -----------
        var raw = calc !== null ? calc : mof;
        rec = { hours: raw, source: 'RAW', trust: 'UNVERIFIED',
                expected: null, mof: mof, calc: calc };
      }

      // --- cabang 5: nilai mustahil -> null ------------------------------
      if (!isNum(rec.hours) || rec.hours <= 0) {
        rec = { hours: null, source: rec.source, trust: 'INVALID',
                expected: rec.expected, mof: mof, calc: calc };
      }

      out[ord[i].i] = rec;

      // --- siapkan untuk sampel BERIKUTNYA -------------------------------
      // `prevHours` = hours(n) yang BARU DITEMUKAN. Inilah yang dipakai
      // rumus pada iterasi berikutnya: expected = ΔHM + hours(n−1).
      prevHours = rec.hours;
      prevAnchored = isChangedY(x.fluid_changed);
      prevRow = x;
      prevOut = rec;
      void prevOut;   // jejak; keputusan memakai prevHours/prevAnchored
    }

    return out;
  }

  /* ------------------------------------------------------------------------
   * 2. wearRate(sample, key, ageInfo) — ppm per 100 jam-oli
   * ----------------------------------------------------------------------
   *   rate = value / hours * 100
   *
   * null bila value kosong ATAU hours null/<=0. JANGAN pernah menghasilkan
   * Infinity/NaN — kartu yang menampilkan "∞" lebih buruk daripada "—".
   * ---------------------------------------------------------------------- */
  function wearRate(sample, key, ageInfo) {
    if (!sample) return null;
    var v = sample[key];
    if (!isNum(v)) return null;
    var hours = ageInfo ? ageInfo.hours : null;
    if (!isNum(hours) || hours <= 0) return null;
    var rate = (v / hours) * 100;
    if (!isFinite(rate)) return null;
    return { rate: rate, hours: hours, trust: ageInfo.trust || 'UNVERIFIED' };
  }

  /**
   * wearRateSeries(samples, key) — array SEJAJAR dengan `samples`.
   * Elemen null DIPERTAHANKAN (indeks harus sejajar, lihat FA-24).
   */
  function wearRateSeries(samples, key) {
    var ages = fluidAge(samples);
    return (samples || []).map(function (s, i) {
      var r = wearRate(s, key, ages[i]);
      return r ? { rate: r.rate, hours: r.hours, trust: r.trust,
                   date: s._dateStr || null } : null;
    });
  }

  /* ------------------------------------------------------------------------
   * 3. rateTrend(samples, key) — slope & percepatan atas wearRate
   * ----------------------------------------------------------------------
   *   slope: perubahan wearRate per 1000 jam HM unit (kuadrat-terkecil)
   *   r2   : 0..1 kecocokan — < 0,3 artinya berisik, jangan dipercaya
   *   accel: -1 melambat / 0 linear / +1 mempercepat (tanda turunan kedua)
   *   n    : titik terpakai; null bila n < 3
   *
   * ⚠ REGRESI KETIGA/KEEMPAT di proyek ini (`projectTrend` di
   *   portfolio-render.js, `calcROW100` di sos-analytics.js). Yang ini
   *   sengaja berdiri sendiri: ia meregres WARN (wearRate) terhadap METER
   *   (hm_unit), bukan nilai logam terhadap HM, dan tidak dapat memakai
   *   ulang keduanya tanpa mencampur satuan. Satu titik fokus, satu tujuan.
   * ---------------------------------------------------------------------- */
  function rateTrend(samples, key) {
    if (!samples || samples.length < 3) return null;
    var ages = fluidAge(samples);
    var pts = [];
    for (var i = 0; i < samples.length; i++) {
      var r = wearRate(samples[i], key, ages[i]);
      var m = meterOf(samples[i]);
      if (r && isNum(m)) pts.push({ x: m, y: r.rate });
    }
    if (pts.length < 3) return null;

    pts.sort(function (a, b) { return a.x - b.x; });

    var nP = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var j = 0; j < nP; j++) {
      sx += pts[j].x; sy += pts[j].y;
      sxx += pts[j].x * pts[j].x; sxy += pts[j].x * pts[j].y;
    }
    var den = nP * sxx - sx * sx;
    if (!den) return null;
    var slope = (nP * sxy - sx * sy) / den;         // per jam HM
    var intercept = (sy - slope * sx) / nP;

    var ssTot = 0, ssRes = 0, my = sy / nP;
    for (var k = 0; k < nP; k++) {
      var yhat = intercept + slope * pts[k].x;
      ssTot += Math.pow(pts[k].y - my, 2);
      ssRes += Math.pow(pts[k].y - yhat, 2);
    }
    var r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    // Percepatan: bandingkan SLOPE paruh KEDUA vs paruh PERTAMA.
    // ⚠ Versi pertama membandingkan RATA-RATA wearRate kedua paruh. Itu
    // SALAH secara matematis: pada data linear sempurna (rate 2,3,4,...,9)
    // rata-rata paruh = 2+3=2,5 vs 9+8=8,5 -> dianggap "mempercepat",
    // padahal slope-nya identik. Terbukti MERAH pada FA-21. Yang benar:
    // slope tiap paruh sama pada seri linear, dan slope paruh kedua lebih
    // besar hanya bila seri benar-benar mempercepat.
    function slopeOf(arr) {
      var m = arr.length;
      if (m < 2) return null;
      var sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (var t = 0; t < m; t++) {
        sx += arr[t].x; sy += arr[t].y;
        sxx += arr[t].x * arr[t].x; sxy += arr[t].x * arr[t].y;
      }
      var d = m * sxx - sx * sx;
      return d ? (m * sxy - sx * sy) / d : null;
    }
    var halfK = Math.floor(nP / 2);
    var s1 = slopeOf(pts.slice(0, halfK));
    var s2 = slopeOf(pts.slice(nP - halfK));
    var yMin = Math.min.apply(null, pts.map(function (p) { return p.y; }));
    var yMax = Math.max.apply(null, pts.map(function (p) { return p.y; }));
    // Ambang "praktis sama" relatif terhadap rentang slope yang mungkin:
    // 20 % dari |slope| global. Di bawah itu -> anggap linear (accel 0).
    var eps = Math.abs(slope) * 0.2 + 1e-12;
    var accel = 0;
    if (s1 !== null && s2 !== null) {
      var delta = s2 - s1;
      if (Math.abs(delta) > eps) accel = delta > 0 ? 1 : -1;
    }
    void yMin; void yMax;

    return {
      slope: slope * 1000,     // ke API: per 1000 jam HM
      r2: r2,
      accel: accel,
      n: nP
    };
  }

  /* ------------------------------------------------------------------------
   * 4. stableBaseline(samples, key, th) — median era "tenang"
   * ----------------------------------------------------------------------
   * Median hanya atas sampel yang TIDAK melewati ambang `warn`. Latar:
   * median seluruh riwayat mencampur era kebocoran coolant (Na 179 ppm)
   * dengan era bersih (Na 1-3 ppm) sehingga garis dasar kotor. null bila
   * sampel tenang < 3 -> pemanggil memakai perilaku lama (mundur-aman).
   * ---------------------------------------------------------------------- */
  // [FIX M3 · 2026-10-19] Handle warn_high untuk dual-band (viskositas).
  // Sebelumnya hanya cek warn_low → oil thickening masuk stable baseline.
  function passesWarn(v, th) {
    if (!isNum(v) || !th) return false;
    if (th.warn_low !== undefined && v < th.warn_low) return true;
    if (th.warn_high !== undefined && v > th.warn_high) return true;
    if (th.warn_low === undefined && th.warn_high === undefined && th.warn !== undefined) return v > th.warn;
    return false;
  }

  function stableBaseline(samples, key, th) {
    if (!samples || !samples.length) return null;
    var vals = [], from = null, to = null;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i][key];
      if (!isNum(v)) continue;
      if (passesWarn(v, th)) continue;        // lewati era "panas"
      vals.push(v);
      var d = samples[i]._dateStr || null;
      if (!from) from = d;
      to = d;
    }
    if (vals.length < 3) return null;
    vals.sort(function (a, b) { return a - b; });
    var mid = Math.floor(vals.length / 2);
    var med = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    return { median: med, n: vals.length, from: from, to: to };
  }

  /* ------------------------------------------------------------------------
   * 5. episodes(samples, key, th) — rekurensi lewat ambang
   * ----------------------------------------------------------------------
   * Episode = satu atau lebih sampel BERTURUT-TURUT melewati `th.warn`,
   * ditutup oleh >= 2 sampel di bawah warn. Dua (bukan satu) supaya satu
   * sampel bersih kebetulan tidak menutup episode secara palsu.
   * ---------------------------------------------------------------------- */
  function episodes(samples, key, th) {
    var out = { count: 0, maxVal: null, lastClearIdx: -1,
                spanHours: 0, samplesSinceClear: 0 };
    if (!samples || !samples.length || !th) return out;

    var inEp = false, cleanRun = 0, startMeter = null, lastMeter = null;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i][key];
      var m = meterOf(samples[i]);
      if (!isNum(v)) continue;
      if (isNum(m)) lastMeter = m;

      if (passesWarn(v, th)) {
        if (!inEp) {
          inEp = true;
          startMeter = isNum(m) ? m : null;
          out.count++;
        }
        cleanRun = 0;
        if (out.maxVal === null || v > out.maxVal) out.maxVal = v;
        if (startMeter !== null && lastMeter !== null) {
          out.spanHours = lastMeter - startMeter;
        }
      } else {
        if (inEp) {
          cleanRun++;
          if (cleanRun >= 2) { inEp = false; out.lastClearIdx = i; }
        } else {
          out.lastClearIdx = i;
        }
      }
    }
    out.samplesSinceClear = (out.lastClearIdx < 0) ? samples.length
      : (samples.length - 1 - out.lastClearIdx);
    return out;
  }

  /* ------------------------------------------------------------------------
   * 6. confidenceLabel — label keyakinan yang JUJUR
   * ----------------------------------------------------------------------
   * `displayMode` lama hanya menghitung `samples.length`, sehingga 70 sampel
   * yang semuanya tak terverifikasi tetap berlabel "Baik" — janji palsu.
   * ---------------------------------------------------------------------- */
  function confidenceLabel(ages, trendInfo) {
    var n = ages ? ages.length : 0;
    if (!n) return 'Snapshot';
    var verified = 0, usable = 0;
    (ages || []).forEach(function (a) {
      if (!a) return;
      if (a.trust === 'VERIFIED') verified++;
      if (a.trust === 'VERIFIED' || a.trust === 'COMPUTED') usable++;
    });
    var majorityVerified = verified * 2 > n;
    var majorityUsable = usable * 2 > n;
    var r2 = trendInfo ? trendInfo.r2 : 0;
    if (n >= 5 && majorityVerified && r2 > 0.5) return 'Baik';
    if (n >= 3 && majorityVerified) return 'Sedang';
    if (n >= 2 && majorityUsable) return 'Rendah';
    return 'Snapshot';
  }

  global.SOS_HISTORY = {
    fluidAge: fluidAge,
    wearRate: wearRate,
    wearRateSeries: wearRateSeries,
    rateTrend: rateTrend,
    stableBaseline: stableBaseline,
    episodes: episodes,
    confidenceLabel: confidenceLabel,
    // diekspor untuk diuji & dipakai ulang
    chronological: chronological,
    meterOf: meterOf,
    tolOf: tolOf,
    _internals: {
      posOrNull: posOrNull, isChangedY: isChangedY, passesWarn: passesWarn
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_HISTORY;
  }
  // ⚠ PENUTUP IIFE menyamai `js/sos-failmode.js` dan modul SOS lain di repo:
  //   `(typeof window !== 'undefined' ? window : this)`.
  // JANGAN `this` polos dan JANGAN `globalThis`. Alasannya bukan selera:
  // suite memuat berkas lewat `new Function('global', ...)` di dalam fungsi
  // strict, sehingga `this` = `window` parameter (APP_GLOBAL) — sedangkan
  // `globalThis` = objek Node. Keduanya terbukti SALAH saat dijalankan:
  //   - `})(this)`       -> `this` = undefined di strict mode -> hilang
  //   - `})(globalThis)` -> menulis ke objek Node, `REQUIRED` kosong
  // Dengan pola di bawah, `window` yang dioper suite dipakai apa adanya.
})(typeof window !== 'undefined' ? window : this);

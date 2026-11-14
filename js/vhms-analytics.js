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

  /**
   * [T5.6 2026-10-08] Kurva KUMULATIF untuk parameter bertipe DELTA.
   * ---------------------------------------------------------------------
   * ⚠ PERINGATAN PENTING — BACA SEBELUM MEMAKAI `slope` PADA PARAMETER INI.
   *
   * Kolom `TC Oil T.120-` / `130-` / `140-` pada `tm_trend0.CSV` berisi
   * AKUMULASI DETIK **PER PERIODE SNAPSHOT**, bukan akumulasi seumur hidup.
   * Buktinya: nilainya naik-turun antar-snapshot pada file contoh (mustahil
   * untuk besaran kumulatif).
   *
   * KONSEKUENSINYA: menghitung `slope` langsung atas nilai DELTA lalu
   * menafsirkannya sebagai "laju keausan" adalah SALAH. `slope` atas delta
   * hanya mengukur TREN INTENSITAS duty per interval, bukan pertumbuhan
   * total. Untuk mendapatkan besaran kumulatif yang benar, JUMLAHKAN delta
   * memakai fungsi ini — bukan lewat slope.
   *
   * @param {array}  records  record hasil parse (terurut SMR naik)
   * @param {string} paramKey key parameter bertipe delta
   * @returns {array} daftar { smr, delta, cum } — cum = akumulasi berjalan.
   * ---------------------------------------------------------------------
   */
  function cumulative(records, paramKey) {
    var out = [];
    var acc = 0;
    (records || []).forEach(function (r) {
      if (!r) return;
      var v = r[paramKey];
      if (v === null || v === undefined || isNaN(v)) return;
      acc += v;
      out.push({ smr: r.smr, delta: v, cum: acc });
    });
    return out;
  }

  /** Total akumulasi sebuah parameter delta (ringkas). */
  function cumulativeTotal(records, paramKey) {
    var series = cumulative(records, paramKey);
    return series.length ? series[series.length - 1].cum : 0;
  }

  /* -----------------------------------------------------------------------
   * [PC2000 2026-10-10 — T4] NORMALISASI DUTY GAS BUANG -> PERSEN JENDELA.
   * ---------------------------------------------------------------------
   * MENGAPA: kolom `LF/LR/RF/RR Exh.Temp 700-|750-|800-` berisi DETIK di atas
   * ambang, terakumulasi di dalam jendela SMR antar-baris. Panjang jendela
   * berbeda antar unit (PC2000 ~200 jam, HD785 ~40 jam), sehingga detik mentah
   * TIDAK dapat dibandingkan antar unit maupun diberi ambang tunggal.
   *
   * RUMUS:  persen = 100 × detik / (ΔSMR × 3600)
   *   - `ΔSMR` = SMR[i] − SMR[i−1] (sudah dalam JAM, parser menerapkan
   *     SMR_SCALE).
   *   - Baris PERTAMA tidak punya jendela -> nilainya diganti `null`, BUKAN 0.
   *     Pada berkas contoh nilai pertama justru TERBESAR (650 065 s) karena
   *     mengakumulasi sejak awal umur; bila dipakai akan selalu critical palsu.
   *   - `ΔSMR <= 0` (duplikat SMR / urutan aneh) -> `null`, jangan bagi nol.
   *   - Hasil di-clamp ke [0, 100]: nilai raw dapat melebihi jendela sedikit
   *     (pembulatan SMR), dan persen >100 tidak bermakna.
   *
   * Sengaja HANYA menyentuh 12 parameter duty (`*ExhOver700/750/800`).
   * Parameter trend lain tidak boleh diubah agar tidak ada regresi.
   * Bersifat in-place & idempoten (memanggil dua kali memberi hasil sama
   * karena nilai yang sudah dinormalkan berada dalam [0,100], dan syarat
   * "baris pertama" ditentukan posisi, bukan nilai).
   * --------------------------------------------------------------------- */
  var EXHAUST_DUTY_KEYS = [
    'lfExhOver700', 'lfExhOver750', 'lfExhOver800',
    'lrExhOver700', 'lrExhOver750', 'lrExhOver800',
    'rfExhOver700', 'rfExhOver750', 'rfExhOver800',
    'rrExhOver700', 'rrExhOver750', 'rrExhOver800'
  ];

  /**
   * Normalisasi duty gas buang -> PERSEN JENDELA.
   *
   * ⚠ TIDAK IDEMPOTEN bila dijalankan di tempat. Fungsi ini karena itu
   *   MENGEMBALIKAN ARRAY BARU dan TIDAK PERNAH menyentuh `records` masukan.
   *
   *   Bug yang pernah terjadi (B13, 2026-10-10): fungsi memutasi in-place,
   *   lalu `vhms-fleet-store` memanggil `analyze()` KEDUA kali atas array
   *   yang sama saat merge/restore (tanpa CLC aktif, `_prepareRecords`
   *   mengembalikan array asli, bukan klon). Hasilnya nilai persen dibagi
   *   jendela LAGI -> `98.89` menjadi `0.01`. Diam, tanpa error.
   *
   *   Kalau kelak ada yang menambah `flag` "sudah dinormalisasi" sebagai
   *   ganti klon: JANGAN. Flag hilang saat `JSON.stringify` di persistensi,
   *   sehingga unit yang di-restore akan dinormalisasi ulang. Klon adalah
   *   satu-satunya jaminan yang bertahan melintasi serialisasi.
   */
  function normalizeExhaustDuty(records) {
    if (!records || !records.length) return records;

    function blankFirstOnly(recs) {
      var out = recs.map(function (r) { return r; });
      if (!out.length) return out;
      var c = shallowCopy(out[0]);
      EXHAUST_DUTY_KEYS.forEach(function (k) { if (k in c) c[k] = null; });
      out[0] = c;
      return out;
    }

    if (records.length < 2) return blankFirstOnly(records);

    // Apakah berkas ini memang punya kolom duty gas buang sama sekali?
    // Bila tidak, kembalikan apa adanya (tanpa klon) — menghindari biaya.
    var hasDuty = EXHAUST_DUTY_KEYS.some(function (k) {
      for (var i = 0; i < records.length; i++) {
        if (records[i][k] !== null && records[i][k] !== undefined) return true;
      }
      return false;
    });
    if (!hasDuty) return records;

    var out = new Array(records.length);
    for (var i = 0; i < records.length; i++) out[i] = shallowCopy(records[i]);

    /* ---------------------------------------------------------------------
     * [FIX B16 2026-10-16] JENDELA WAJIB DIHITUNG PER JENIS BERKAS (`_src`).
     * -------------------------------------------------------------------
     * Bug yang diperbaiki: kode lama memakai `out[n].smr - out[n-1].smr`,
     * yaitu selisih SMR terhadap BARIS BERSEBELAHAN di array. Itu benar
     * HANYA bila seluruh array berasal dari satu berkas.
     *
     * Kenyataannya `vhms-fleet-store.mergeUnit()` menggabungkan beberapa
     * jenis berkas dalam SATU array lalu MENGURUTKANNYA MENURUT SMR
     * (lihat `mergedRecords.sort(...)`, dedup berkunci `SMR|_src`). Baris
     * trend `'40'` karena itu MENYELA baris chassis trend `'86'`, sehingga
     * selisih ke baris sebelumnya menjadi JAUH LEBIH KECIL dari jendela
     * sesungguhnya -> persen duty MEMBESAR secara palsu.
     *
     * Bukti terukur (3 baris `'86'` ber-jarak 100 jam, disela 2 baris `'40'`
     * di tengah, masing-masing 3600 s di atas ambang):
     *     benar   = 3600 / (100 x 3600) = 1,00 %
     *     sebelum = 2,00 %   (jendela terbaca 50 jam — separuh)
     *     sesudah = 1,00 %
     * Faktor kesalahan = jumlah berkas yang menyela; dengan 3 jenis berkas
     * nilainya bisa 3x. Arahnya SELALU melebih-lebihkan, jadi bug ini
     * memproduksi CRITICAL PALSU — kelas yang sama dengan B14.
     *
     * Baris PERTAMA DI SETIAP `_src` tetap `null` (tidak punya jendela),
     * konsisten dengan alasan asli: nilai pertama mengakumulasi sejak awal
     * umur unit. Idempotensi tetap terjaga: syarat "baris pertama"
     * ditentukan POSISI dalam kelompoknya, bukan nilainya.
     * ------------------------------------------------------------------- */
    function srcOf(r) {
      return (r && r._src !== undefined && r._src !== null) ? String(r._src) : '40';
    }

    // Indeks baris sebelumnya DARI SUMBER YANG SAMA (null bila ia yang pertama).
    var prevIdxBySrc = {};
    var prevOfRow = new Array(out.length);
    for (var p = 0; p < out.length; p++) {
      var s = srcOf(out[p]);
      prevOfRow[p] = (prevIdxBySrc[s] === undefined) ? null : prevIdxBySrc[s];
      prevIdxBySrc[s] = p;
    }

    for (var n = 0; n < out.length; n++) {
      var prevI = prevOfRow[n];
      var valid = false, winSec = 0;
      if (prevI !== null) {
        var dSmr = out[n].smr - out[prevI].smr;   // jam, dalam satu jenis berkas
        winSec = dSmr * 3600;
        valid = isFinite(dSmr) && dSmr > 0 && winSec > 0;
      }
      for (var j = 0; j < EXHAUST_DUTY_KEYS.length; j++) {
        var key = EXHAUST_DUTY_KEYS[j];
        if (!(key in out[n])) continue;
        var raw = out[n][key];
        if (raw === null || raw === undefined || isNaN(raw)) { out[n][key] = null; continue; }
        if (!valid) { out[n][key] = null; continue; }   // termasuk baris pertama tiap _src
        var pct = (100 * raw) / winSec;
        if (!isFinite(pct)) { out[n][key] = null; continue; }
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        out[n][key] = Math.round(pct * 100) / 100;   // 2 desimal
      }
    }
    return out;
  }

  /** Klon dangkal satu record + dalam-untuk `calendar` (pola vhms-fleet-store). */
  function shallowCopy(r) {
    if (!r) return r;
    var c = {};
    for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k]; }
    if (r.calendar) c.calendar = { epoch: r.calendar.epoch, tzOffsetSec: r.calendar.tzOffsetSec, display: r.calendar.display };
    return c;
  }

  /* -----------------------------------------------------------------------
   * [FIX MASK 2026-10-26] PEMBACAAN YANG MENGHORMATI GERBANG KUALITAS DATA.
   * ---------------------------------------------------------------------
   * `VHMS_VALIDATE.applyFaultMask()` menandai `record._masked[key]` untuk
   * nilai yang berasal dari sensor yang SEDANG RUSAK (mis. fault `DGT6KA`
   * — Exhaust temp. sensor R failure). Sesuai README §6.3 nilai TETAP
   * TAMPIL di tabel & chart, tetapi HARUS DIKELUARKAN dari SELURUH formula.
   *
   * MASALAH YANG DIPERBAIKI. `vhms-ranking.js` sudah membaca lewat
   * `maskedValueOf()`, tetapi `slope()` di modul ini membaca
   * `records[i][paramKey]` LANGSUNG. Akibatnya satu nilai yang sama
   * DITOLAK oleh skor peringkat tetapi DITERIMA oleh perhitungan RUL —
   * dua modul, dua kaidah, satu besaran.
   *
   * Terukur (tools/probe-rul-inputs.js): deret yang SELURUH barisnya
   * ditandai `_masked` menghasilkan RUL dan slope yang IDENTIK dengan
   * deret bersih (25 jam, slope 2,00e-1). Gerbang mask sama sekali tidak
   * berpengaruh. Kolom "Sisa Operasi" bisa menampilkan angka yang
   * bersumber dari sensor yang sistem sendiri sudah nyatakan rusak.
   *
   * ⚠ Gerbang `stuck` TIDAK menutup lubang ini: ia hanya menangkap sensor
   *   yang MEMBEKU, bukan sensor rusak yang nilainya masih bergerak.
   *
   * Fungsi ini dipakai SELURUH pembacaan nilai parameter untuk formula di
   * modul ini (slope, RUL). Nilai asli TIDAK dihapus dari record.
   * --------------------------------------------------------------------- */
  function maskedValueOf(rec, key) {
    if (!rec) return null;
    if (rec._masked && rec._masked[key]) return null;
    var v = rec[key];
    return (v === null || v === undefined || isNaN(v)) ? null : v;
  }

  /* [FIX LINIER 2026-10-26] Ambang kecocokan garis untuk RUL.
   * R² di bawah ini berarti "garis lurus tidak menjelaskan data" ->
   * estimasi ditandai LEMAH (tidak dibuang). Lihat catatan di estimateRUL. */
  var MIN_FIT_R2 = 0.50;

  /* [P0-2 2026-10-27] Rentang SMR minimum agar slope BERMAKNA.
   * Dulu konstanta ini hanya ada di dalam `estimateRUL()` (paling bawah
   * berkas), sehingga `VHMS_RANKING.slopeOf()` — yang memberi 25 % skor
   * criticality — TIDAK memakai gerbang apa pun. Artefak yang sama yang
   * membuat RUL membaca "1 jam" (D375A 65258: 6 baris dalam 0,4 jam ->
   * 17,86 degC/jam) justru tetap memberi skor tren PENUH ke peringkat.
   * Sekarang konstanta ini diekspor dan DIBACA oleh kedua modul — TIDAK
   * disalin (dua angka untuk satu konsep = akar FUEL-b). */
  var MIN_SMR_SPAN_HOURS = 50;

  /* [P0-3 2026-10-27] Jumlah titik minimum untuk regresi linier.
   * Dulu `slope()`/`fitR2()` memakai 3 sementara `slopeOf()` memakai 4,
   * padahal komentar di `slope()` menyatakan keduanya "kaidah yang SAMA".
   * Diseragamkan ke 4 (yang lebih ketat; `estimateRUL()` juga sudah
   * menuntut >= 4 record). */
  var MIN_FIT_POINTS = 4;

  /**
   * [P0-2 2026-10-27] Rentang SMR (jam) yang benar-benar MEMBENTANG nilai
   * parameter ini — dihitung dari baris yang PUNYA nilai (bukan
   * `records[0]`/`records[len-1]`, yang bisa berisi kolom kosong dari berkas
   * lain). `null` bila tidak ada titik.
   */
  function smrSpanHours(records, paramKey) {
    var first = null, last = null;
    if (!records) return null;
    for (var i = 0; i < records.length; i++) {
      var rs = records[i].smr;
      if (rs === null || rs === undefined || isNaN(rs)) continue;
      if (maskedValueOf(records[i], paramKey) === null) continue;
      if (first === null || rs < first) first = rs;
      if (last === null || rs > last) last = rs;
    }
    if (first === null) return null;
    return last - first;
  }

  /**
   * [P0-2 2026-10-27] Gerbang rentang: TRUE bila slope boleh dihitung.
   * Dipakai `estimateRUL()` DAN `VHMS_RANKING.slopeOf()` agar RUL & skor
   * tren tidak pernah berbeda pendapat soal data yang sama.
   */
  function hasAdequateSpan(records, paramKey) {
    var sp = smrSpanHours(records, paramKey);
    return sp !== null && sp >= MIN_SMR_SPAN_HOURS;
  }

  /**
   * Koefisien determinasi (R²) regresi linier y=nilai terhadap x=SMR.
   * Mengukur seberapa besar ragam data yang DIJELASKAN garis lurus.
   * @returns {number|null} 0..1, atau null bila tak cukup data / y konstan.
   */
  function fitR2(records, paramKey) {
    var xs = [], ys = [];
    for (var i = 0; i < records.length; i++) {
      var x = records[i].smr, y = maskedValueOf(records[i], paramKey);
      if (x === null || x === undefined || isNaN(x) || y === null) continue;
      xs.push(x); ys.push(y);
    }
    var n = xs.length;
    if (n < MIN_FIT_POINTS) return null;
    var sx = 0, sy = 0;
    for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; }
    var mx = sx / n, my = sy / n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var k = 0; k < n; k++) {
      var dx = xs[k] - mx, dy = ys[k] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    // y konstan (tak ada ragam) atau x konstan -> R² tak bermakna.
    if (sxx <= 0 || syy <= 0) return null;
    var r = sxy / Math.sqrt(sxx * syy);
    return Math.max(0, Math.min(1, r * r));
  }

  /**
   * Least-squares slope dari (x=smr, y=nilai).
   * [FIX MASK 2026-10-26] Nilai ter-mask DIKELUARKAN — lihat `maskedValueOf`.
   * Perubahan ini membuat `slope()` dan `VHMS_RANKING.slopeOf()` memakai
   * kaidah yang SAMA; uji F-5 mengunci keduanya agar tetap sepakat.
   */
  function slope(records, paramKey) {
    var xs = [], ys = [];
    for (var i = 0; i < records.length; i++) {
      var x = records[i].smr, y = maskedValueOf(records[i], paramKey);
      if (x === null || x === undefined || isNaN(x) || y === null) continue;
      xs.push(x); ys.push(y);
    }
    if (xs.length < MIN_FIT_POINTS) return null;
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  /* -----------------------------------------------------------------------
   * [KALIBRASI 2026-10-25] FUEL RATE — ambang dari KUARTIL sebaran unit sendiri
   * ---------------------------------------------------------------------
   * MASALAH yang diperbaiki: `MODEL_THRESHOLDS` memasang angka tetap per model
   * (D375A 100/130 · HD785 140/165 · PC2000 165/195). Pada D375A contoh
   * (SN 65898, 200 record) sebaran nyatanya Q1 47,0 · median 54,5 · Q3 60,4 ·
   * maks 82,3 L/h — `crit` 130 **DI ATAS NILAI MAKSIMUM**, jadi parameter itu
   * TIDAK PERNAH bisa memicu alarm. Ini kelas kesalahan yang SAMA dengan
   * ambang tekanan rem HD785 (lihat catatan `fBrakePressMax` di vhms-config):
   * ambang yang mati memberi rasa aman palsu.
   *
   * DASAR ANGKA (jujur — statistik, BUKAN Shop Manual):
   *   Kaidah pencilan Tukey atas kuartil konsumsi bahan bakar unit itu sendiri.
   *     warn = Q3 + 1,5 x IQR   (pagar dalam — konsumsi di luar kebiasaan)
   *     crit = Q3 + 3,0 x IQR   (pagar jauh  — pencilan ekstrem)
   *   Dipilih karena fuel rate adalah besaran OPERASIONAL (beban, operator,
   *   material, grade jalan), bukan batas rekayasa seperti tekanan oli — yang
   *   bermakna adalah "seberapa jauh dari kebiasaan unit ini", bukan angka
   *   absolut lintas-armada.
   *
   * PLAFON WAJIB: hasil kalibrasi hanya boleh MENGETATKAN, tidak pernah
   * melonggarkan. `warn`/`crit` di-`Math.min` terhadap ambang model/keluarga,
   * sehingga unit boros yang kuartilnya ikut tinggi tetap tertangkap ambang
   * rekayasa. Berlaku untuk SEMUA model (D375A, HD785, PC2000, dll) tanpa
   * perlu menebak angka per model.
   *
   * GERBANG — kalibrasi DILEWATI (ambang model dipakai apa adanya) bila:
   *   - sampel < MIN_FUEL_SAMPLES (kuartil dari sedikit titik tidak bermakna)
   *   - IQR = 0 (nilai konstan / sensor macet)
   *   - parameter tidak ada / ber-mode 'low'
   *
   * [SETELAN 2026-10-26] Pengali IQR, jumlah sampel minimum, dan saklar
   * aktif/nonaktif kini dibaca dari `cfg.FUEL_CALIBRATION` (dapat diubah dari
   * panel Pengaturan) — bukan lagi konstanta tertanam. Dibaca SETIAP panggil
   * agar perubahan langsung berlaku tanpa muat ulang halaman.
   *
   * ponytail: kuartil dihitung atas SELURUH record unit (riwayat penuh =
   * sebaran kebiasaan paling stabil). Bila nanti pola operasi berubah drastis
   * (ganti front/operator), ganti sumbernya ke `windowRecords` saja.
   * --------------------------------------------------------------------- */
  var FUEL_CAL_DEFAULT = { enabled: true, warnK: 1.5, critK: 3.0, minSamples: 20 };

  /** Setelan kalibrasi fuel efektif; nilai tak masuk akal jatuh ke default. */
  function fuelCalSettings() {
    var s = (cfg && cfg.FUEL_CALIBRATION) || {};
    function num(v, d, min) {
      v = parseFloat(v);
      return (isFinite(v) && v >= min) ? v : d;
    }
    return {
      enabled: (s.enabled === undefined) ? FUEL_CAL_DEFAULT.enabled : !!s.enabled,
      warnK: num(s.warnK, FUEL_CAL_DEFAULT.warnK, 0),
      critK: num(s.critK, FUEL_CAL_DEFAULT.critK, 0),
      minSamples: Math.round(num(s.minSamples, FUEL_CAL_DEFAULT.minSamples, 2))
    };
  }

  /** Kuartil interpolasi linier atas array yang SUDAH terurut naik. */
  function quantileSorted(v, q) {
    if (!v || !v.length) return null;
    var pos = (v.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }

  /**
   * Ambang fuelRate hasil kalibrasi kuartil, atau `null` bila gerbang di atas
   * tidak terlewati. TIDAK memutasi `base`.
   * @returns {object|null} { warn, crit, mode, label, source, q1, q3, iqr, n }
   */
  function calibrateFuelRate(records, base) {
    var th = base && base.fuelRate;
    if (!th || th.mode === 'low') return null;
    var S = fuelCalSettings();
    if (!S.enabled) return null;

    var v = [];
    var recs = records || [];
    for (var i = 0; i < recs.length; i++) {
      var x = recs[i] ? recs[i].fuelRate : null;
      if (x === null || x === undefined || isNaN(x)) continue;
      v.push(x);
    }
    if (v.length < S.minSamples) return null;

    v.sort(function (a, b) { return a - b; });
    var q1 = quantileSorted(v, 0.25);
    var q3 = quantileSorted(v, 0.75);
    var iqr = q3 - q1;
    if (!(iqr > 0)) return null;

    // Pagar Tukey, lalu PLAFON ambang model (hanya boleh mengetatkan).
    var warn = Math.min(q3 + S.warnK * iqr, th.warn);
    var crit = Math.min(q3 + S.critK * iqr, th.crit);
    // Jaga urutan warn < crit walau plafon memangkas dari arah berbeda.
    if (crit <= warn) crit = Math.min(th.crit, warn + S.warnK * iqr);
    if (crit <= warn) return null;

    var r1 = function (n) { return Math.round(n * 10) / 10; };
    return {
      warn: r1(warn), crit: r1(crit), mode: 'high',
      label: th.label || 'Fuel Rate',
      source: 'Kaidah pencilan Tukey atas kuartil unit ini (Q3 ' + r1(q3) +
              ' + ' + S.warnK + '/' + S.critK + ' x IQR ' + r1(iqr) + ', n=' + v.length +
              '), dibatasi ambang model ' + th.warn + '/' + th.crit +
              ' \u2014 statistik, BUKAN Shop Manual',
      q1: r1(q1), q3: r1(q3), iqr: r1(iqr), n: v.length
    };
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
    // [STANDARISASI 2026-10-03] 3 level: NORMAL / CAUTION / CRITICAL
    if (th.mode === 'low') {
      if (value <= th.crit) return 'CRITICAL';
      if (value <= th.warn) return 'CAUTION';
    } else {
      if (value >= th.crit) return 'CRITICAL';
      if (value >= th.warn) return 'CAUTION';
    }
    return 'NORMAL';
  }

  var STATUS_RANK = { 'NORMAL': 0, 'CAUTION': 1, 'CRITICAL': 2 };

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
      title: 'Engine Oil Pressure High',  // [FIX C8 · 2026-10-19] was "Low"
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
    },
    // [FIX 2026-10-01] ACTIONS untuk parameter VHMS yang baru punya threshold.
    brakeTemp: {
      title: 'Brake Temperature High',
      system: 'Brake & Retarder',
      risk: 'Tinggi',
      actions: [
        'Berhenti di area aman, biarkan brake mendingin.',
        'Periksa sistem pendinginan brake & level oli.',
        'Inspeksi brake lining/disc & seal.',
        'Tinjau prosedur operasi turunan.'
      ]
    },
    retarderTemp: {
      title: 'Retarder Temperature High',
      system: 'Brake & Retarder',
      risk: 'Tinggi',
      actions: [
        'Periksa level & kondisi oli retarder.',
        'Cek kerja heat exchanger retarder.',
        'Evaluasi pola pengoperasian turunan.'
      ]
    },
    boostMax: {
      title: 'Boost Pressure High (Over-boost)',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Periksa wastegate & aktuator.',
        'Inspeksi turbocharger (end-play, kebocoran oli).',
        'Verifikasi sensor tekanan boost.'
      ]
    },
    boostLow: {
      title: 'Boost Pressure Low (Under-boost / Defisit)',
      system: 'Engine',
      risk: 'Tinggi',
      actions: [
        'Periksa klem & selang charge air (intake ducting) dari kebocoran.',
        'Periksa kebersihan air cleaner (filter udara primer & sekunder).',
        'Inspeksi kerja wastegate & aktuator turbocharger.',
        'Verifikasi sensor tekanan boost.'
      ]
    },
    fExhTempMax: {
      title: 'F Exhaust Temp High',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Bandingkan suhu bank F vs R — selisih wajar < 50°C.',
        'Uji injektor & timing sisi kiri.',
        'Periksa kebersihan air cleaner & jalur intake.'
      ]
    },
    rExhTempMax: {
      title: 'R Exhaust Temp High',
      system: 'Engine',
      risk: 'Sedang',
      actions: [
        'Bandingkan suhu bank R vs F.',
        'Uji injektor & timing sisi kanan.',
        'Periksa kebersihan air cleaner & jalur intake.'
      ]
    },
    tcOilTempMax: {
      title: 'Torque Converter Oil Temp High',
      system: 'Powertrain',
      risk: 'Sedang',
      actions: [
        'Periksa level & kondisi oli torque converter.',
        'Bersihkan cooler oli transmisi / powertrain.',
        'Uji stall speed & tekanan torque converter.'
      ]
    },
    tmMainPressMax: {
      title: 'Transmission Main Pressure Low',
      system: 'Powertrain',
      risk: 'Sedang',
      actions: [
        'Periksa level & kondisi oli transmisi.',
        'Uji tekanan main dengan manometer.',
        'Periksa relief valve & regulator tekanan.'
      ]
    },
    largePumpPress: {
      title: 'Large Pump Pressure Low',
      system: 'Hydraulic',
      risk: 'Sedang',
      actions: [
        'Ukur tekanan pompa utama dengan manometer.',
        'Periksa main relief valve & setting.',
        'Ambil sampel oli hidrolik (uji kontaminasi).'
      ]
    }
  };

  /**
   * Membangun daftar anomali utama dari summary (per parameter),
   * diurutkan berdasarkan keparahan.
   */
  function buildAnomalies(records, summary, thresholds, historyOnly) {
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
      // Fuel Rate belongs to Fuel Trending, not VHMS.
      if (key === 'fuelRate') continue;
      var th = TH[key];
      var s = summary[key];
      if (!s) continue;

      // Peak dipertahankan sebagai bukti riwayat; status aktif ditentukan
      // pembacaan valid TERAKHIR agar katalog tidak menghukum spike lama.
      var extreme = (th.mode === 'low') ? s.min : s.max;
      var latestRec = null;
      for (var lr = records.length - 1; lr >= 0; lr--) {
        var latestValue = maskedValueOf(records[lr], key);
        if (latestValue !== null) { latestRec = records[lr]; break; }
      }
      var latest = latestRec ? maskedValueOf(latestRec, key) : null;
      var currentStatus = evaluateParam(key, latest, TH);
      var peakStatus = evaluateParam(key, extreme, TH);
      var isHistory = currentStatus === 'NORMAL' && peakStatus && peakStatus !== 'NORMAL';
      if (historyOnly ? !isHistory : (!currentStatus || currentStatus === 'NORMAL')) continue;

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
        status: historyOnly ? peakStatus : currentStatus,
        value: historyOnly ? extreme : latest,
        peak: extreme,
        peakStatus: peakStatus,
        warn: th.warn,
        crit: th.crit,
        mode: th.mode,
        unit: cfg.PARAMS[key] ? cfg.PARAMS[key].unit : '',
        label: cfg.PARAMS[key] ? cfg.PARAMS[key].label : key,
        smr: historyOnly ? (hitRec ? hitRec.smr : null) : (latestRec ? latestRec.smr : null),
        calendar: historyOnly ? (hitRec ? hitRec.calendar : null) : (latestRec ? latestRec.calendar : null),
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
  function healthIndex(records, opts) {
    // [REVISI 2026-10-29] Kondisi utama mengikuti pembacaan terbaru tiap
    // parameter, sama seperti Equipment List. Riwayat hanya disimpan sebagai
    // informasi tambahan; tidak boleh menggantikan kondisi terkini.
    if (opts && opts.thresholds) {
      var latestNormal = 0, latestWarn = 0, latestCrit = 0, latestNoData = 0;
      var historyCount = 0;
      var thKeys = Object.keys(opts.thresholds);
      for (var k = 0; k < thKeys.length; k++) {
        var key = thKeys[k], th = opts.thresholds[key], latest = null, hadHistoryBreach = false;
        for (var ri = records.length - 1; ri >= 0; ri--) {
          var value = maskedValueOf(records[ri], key);
          if (value !== null) {
            if (latest === null) latest = value;
            if ((th.mode === 'low' ? value <= th.warn : value >= th.warn)) hadHistoryBreach = true;
          }
        }
        if (latest === null) { latestNoData++; continue; }
        var status = evaluateParam(key, latest, opts.thresholds);
        if (status === 'CRITICAL') latestCrit++;
        else if (status === 'CAUTION' || status === 'WARNING') latestWarn++;
        else latestNormal++;
        if (hadHistoryBreach && status === 'NORMAL') historyCount++;
      }
      var latestTotal = latestNormal + latestWarn + latestCrit;
      var latestScore = latestTotal > 0
        ? (latestNormal * 100 + latestWarn * 60 + latestCrit * 20) / latestTotal : null;
      return {
        score: latestScore === null ? null : Math.round(latestScore * 10) / 10,
        normal: latestNormal, caution: latestWarn, warning: latestWarn,
        critical: latestCrit, noData: latestNoData, total: latestTotal,
        history: historyCount,
        label: latestScore === null ? null : (latestScore >= 85 ? 'NORMAL' : (latestScore >= 65 ? 'CAUTION' : 'CRITICAL'))
      };
    }
    if (!records.length) return null;
    var nNormal = 0, nWarn = 0, nCrit = 0, nNoData = 0;
    for (var i = 0; i < records.length; i++) {
      var s = records[i].status;
      // [P1-3 2026-10-27] Record TANPA status = tidak ada parameter terbaca.
      // Dulu record seperti ini jatuh ke `else -> nNormal`, sehingga DATA
      // KOSONG MENAIKKAN skor sehat — dan setelah gerbang `minValid`/
      // `maxValid` ditambah, jumlah record null justru BERTAMBAH pada unit
      // bersensor rusak. Kini dipisah: tidak masuk pembilang MAUPUN penyebut,
      // dan jumlahnya dilaporkan sebagai `noData` supaya terlihat.
      if (s === 'CRITICAL') nCrit++;
      else if (s === 'CAUTION' || s === 'WARNING') nWarn++;
      else if (s === 'NORMAL') nNormal++;
      else nNoData++;
    }
    var nData = records.length - nNoData;
    // Tanpa satu pun record berdata: skor = null (jujur "tidak tahu").
    // Dulu fungsi ini mengembalikan 100 untuk data kosong.
    var score = nData > 0 ? (nNormal * 100 + nWarn * 60 + nCrit * 20) / nData : null;
    return {
      score: score === null ? null : Math.round(score * 10) / 10,
      normal: nNormal,
      caution: nWarn,
      warning: nWarn,   // alias kompatibilitas
      critical: nCrit,
      noData: nNoData,
      total: records.length,
      // [STANDARISASI 2026-10-03] Label 3 level
      label: score === null ? null : (score >= 85 ? 'NORMAL' : (score >= 65 ? 'CAUTION' : 'CRITICAL'))
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

    // [PC2000 2026-10-10 — T4] NORMALISASI DUTY GAS BUANG -> PERSEN JENDELA.
    // ---------------------------------------------------------------------
    // `chas_trend0.CSV` menyimpan tiap kolom `*Exh.Temp 700-/750-/800-` sebagai
    // DETIK DI ATAS AMBANG, TERAKUMULASI DI DALAM jendela SMR antar-baris.
    // Panjang jendela BERBEDA antar unit/model (PC2000 ~200 jam, HD785 ~40 jam),
    // sehingga `warn: 300` detik berarti hal yang sangat berbeda pada keduanya.
    //
    // Persen jendela = 100 × detik / (ΔSMR × 3600).
    //   - Baris PERTAMA tidak punya jendela (tak ada SMR sebelumnya) -> DIBUANG.
    //     Nilainya di file contoh justru yang terbesar (650 065 s) sehingga
    //     bila dipakai akan selalu memicu critical palsu.
    //   - ΔSMR <= 0 (duplikat/urutan aneh) -> tidak dihitung.
    //
    // SENGAJA HANYA untuk parameter duty (7xx/8xx). Parameter trend lain
    // tidak dinormalisasi agar tidak ada regresi.
    //
    // ⚠ WAJIB memakai NILAI KEMBALIAN. Fungsi ini mengembalikan array BARU
    //   (tidak memutasi `records`) agar analyze() aman dipanggil berulang
    //   atas array yang sama — lihat catatan idempotensi di fungsi tsb. (B13)
    records = normalizeExhaustDuty(records);

    // [POIN 1] Resolusi profil keluarga produk dari metadata unit.
    var prof = null;
    var thresholds = cfg.THRESHOLDS;
    if (global.VHMS_PROFILES && global.VHMS_PROFILES.profileFor) {
      prof = global.VHMS_PROFILES.profileFor(parsed.meta || {});
      if (prof && prof.profile && prof.profile.thresholds) {
        thresholds = prof.profile.thresholds;
      }
    }

    // [BARU 2026-10-01] MODEL UNIT — terapkan override threshold per model
    // (mis. HD785 vs D375A punya Fuel Rate/Boost berbeda). Override PARSIAL:
    // parameter yang tidak di-override tetap memakai nilai keluarga. Bila
    // model kosong / tanpa entri -> thresholds keluarga apa adanya.
    var unitModel = (parsed.meta && parsed.meta.model) || '';
    if (cfg.thresholdsForModel && cfg.hasModelOverrides && cfg.hasModelOverrides(unitModel)) {
      thresholds = cfg.thresholdsForModel(thresholds, unitModel);
    }

    // [RULE DATA] Window FORMULA: hanya N jam SMR terakhir (dari SMR tertinggi).
    // SEMUA perhitungan (KPI, summary, anomali, health, ranking, matrix) memakai
    // subset ini agar mencerminkan kondisi terkini.
    var win = sliceFormulaWindow(records);
    var winRecords = win.records;

    /* [KALIBRASI 2026-10-25] FUEL RATE dari kuartil unit ini (lihat
     * `calibrateFuelRate`). Objek `thresholds` disalin dulu — ia bisa berupa
     * REFERENSI ke objek profil keluarga bersama (`TH_DOZER` dkk); memutasinya
     * akan mencemari SELURUH unit keluarga itu.
     *
     * [P3-3a 2026-10-27] KUARTIL DARI `winRecords`, BUKAN `records` PENUH.
     * ---------------------------------------------------------------------
     * Ini bentuk data snooping yang paling langsung: ambang di-fit pada
     * SUPERSET data yang dinilai. Sebaran lama (operasi tahun lalu, operator
     * lain, material lain) ikut menentukan apa yang "normal" HARI INI,
     * padahal skor hanya dihitung atas `FORMULA_WINDOW_HOURS` terakhir.
     * `ponytail:` di blok `calibrateFuelRate` sudah menyebut jalan keluar ini.
     *
     * ⚠ Karena itu blok kalibrasi WAJIB berada SETELAH `sliceFormulaWindow()`.
     *   Jangan dipindah ke atas — jendela harus ada lebih dulu.
     * ⚠ `evaluateRecords()` di bawah tetap dijalankan atas `records` PENUH
     *   (Rule Tampilan: tabel log telemetri menampilkan seluruh data) dengan
     *   ambang yang sama — jadi status baris lama dinilai dengan ambang era
     *   sekarang. Itu disengaja: satu layar, satu definisi "normal".
     * Dikunci uji `FUEL-9`.
     * ------------------------------------------------------------------- */
    var fuelCal = calibrateFuelRate(winRecords, thresholds);
    if (fuelCal) {
      var merged = {};
      Object.keys(thresholds).forEach(function (k) { merged[k] = thresholds[k]; });
      merged.fuelRate = fuelCal;
      thresholds = merged;
    }

    // [RULE DATA] Evaluasi status per-record untuk SELURUH data (dipakai tabel
    // log telemetri — Rule Tampilan). Status tiap record tak bergantung window.
    evaluateRecords(records, thresholds);

    var summary = summarize(winRecords);
    var anomalies = buildAnomalies(winRecords, summary, thresholds, false);
    var historyAnomalies = buildAnomalies(winRecords, summary, thresholds, true);
    var health = healthIndex(winRecords, { thresholds: thresholds });

    /* -------------------------------------------------------------------
     * [FIX 2026-10-09] LANTAI LABEL dari anomali kritis.
     * -----------------------------------------------------------------
     * `healthIndex` menilai PROPORSI record, bukan ada/tidaknya parameter
     * yang melewati batas kritis. Akibatnya unit dengan 10 record CRITICAL
     * dari 200 record mendapat skor 96 -> label NORMAL, padahal beberapa
     * parameter benar-benar melewati batas (terlihat di katalog sebagai
     * "Normal" dengan "6 anomali (4 kritis)").
     *
     * Karena `healthLabel` adalah kunci urut PERTAMA di katalog Home
     * (compareSeverity), unit berbahaya bisa terdorong ke bawah unit aman.
     * Di sini label diberi LANTAI berdasarkan jumlah anomali CRITICAL.
     * Skor numerik (health.score) TIDAK diubah — hanya klasifikasinya.
     *
     * ponytail: lantai sederhana, bukan rumus health baru. Bila butuh
     * gradasi lebih halus, ganti healthIndex jadi skor gabungan
     * proporsi-record + bobot anomali.
     * ----------------------------------------------------------------- */
    if (health) {
      // [P1-3 2026-10-27] `healthIndex()` kini bisa mengembalikan label
      // `null` (tidak ada record berdata). `null` TIDAK boleh diperlakukan
      // sebagai NORMAL oleh lantai anomali.
      var nCritAnom = 0;
      for (var ai = 0; ai < anomalies.length; ai++) {
        if (anomalies[ai].status === 'CRITICAL') nCritAnom++;
      }
      if (health.label === null && nCritAnom > 0) health.label = 'CAUTION';
      if (nCritAnom >= 2) health.label = 'CRITICAL';
      else if (nCritAnom === 1 && health.label === 'NORMAL') health.label = 'CAUTION';
    }

    // [RUL] Estimasi sisa umur operasi per parameter (dari window formula)
    var rul = computeAllRUL(winRecords, thresholds);
    var urgentRUL = mostUrgentRUL(rul);
    /* [REVISI 2026-10-26] Bila TIDAK ada satu pun RUL yang sah tetapi ADA
     * parameter yang macet, tulis alasannya di sel Sisa Operasi — kalimat
     * "—" biasa membuat operator menduga fiturnya rusak. */
    if (!urgentRUL) {
      var stuckNames = Object.keys(rul).filter(function (k) { return !!rul[k].stuck; });
      if (stuckNames.length) {
        urgentRUL = {
          param: stuckNames[0], label: (cfg.PARAMS[stuckNames[0]] || {}).label || stuckNames[0],
          hours: Infinity, confident: false, alreadyCritical: false, stuckOnly: true,
          note: 'RUL tidak dapat dihitung: ' + stuckNames.length + ' parameter macet (' +
                stuckNames.slice(0, 3).map(function (k) {
                  var m = cfg.PARAMS[k] || {};
                  return (m.label || k) + ' tertahan di ' + rul[k].stuck.value +
                         ' pada ' + Math.round(rul[k].stuck.ratio * 100) + '% pembacaan';
                }).join('; ') + '). Periksa sensor/wiring lebih dulu.'
        };
      }
    }

    // [CORRELATION] Deteksi korelasi antar parameter
    var correlations = detectCorrelations(winRecords, thresholds);

    // [ALERT HISTORY] Timeline degradasi per parameter
    var alertTimeline = buildAlertTimeline(records, thresholds);

    // Rentang SMR (seluruh data — untuk footer/tabel/identitas).
    var smrStats = stats(records.map(function (r) { return r.smr; }));

    // Waktu terakhir (lintas seluruh berkas — dipakai sebagai pembanding).
    var lastWithCal = null;
    for (var i = records.length - 1; i >= 0; i--) {
      if (records[i].calendar) { lastWithCal = records[i]; break; }
    }

    /* -------------------------------------------------------------------
     * [REVISI 2026-10-26] IDENTITAS UNIT DARI SUMBER DOMINAN
     * -----------------------------------------------------------------
     * `records` adalah gabungan beberapa jenis berkas (`_src`). Menghitung
     * SMR terakhir & tanggal dari SELURUH gabungan membuat identitas unit
     * mengikuti berkas mana pun yang SMR-nya paling tinggi — bukan berkas
     * yang mewakili kondisi mesin.
     *
     * Contoh nyata D375A SN 19551: `trend0.CSV` ('40') berhenti di SMR
     * 675.004, sedangkan `tm_trend0.CSV` ('81') berjalan sampai 70.911.
     * Hasilnya baris katalog menampilkan "SMR 70.911" dan "Last Update
     * 08/06/2026" dari berkas transmisi, seolah-olah seluruh unit segar.
     * Persis kelas bug yang sudah diperbaiki di pop-up Failure Mode.
     *
     * Aturan: `'40'` (trend0.CSV — Trend Analysis) adalah berkas acuan
     * kondisi mesin. Bila ada, IA yang dipakai untuk identitas. Berkas lain
     * ('81' T/M Trend, '86' chassis, dll.) hanya pelengkap parameter dan
     * TIDAK boleh menentukan SMR/tanggal unit. Bila '40' tidak ada, pakai
     * `_src` dengan record TERBANYAK sebagai cadangan.
     *
     * ⚠ Versi pertama saya memakai "record terbanyak" saja dan itu SALAH
     *   pada kasus ini: '81' punya 200 record sedangkan '40' hanya 18,
     *   sehingga identitas tetap terambil dari berkas transmisi.
     * ----------------------------------------------------------------- */
    var srcCount = {};
    records.forEach(function (r) {
      var s = (r && r._src !== undefined && r._src !== null) ? String(r._src) : '40';
      srcCount[s] = (srcCount[s] || 0) + 1;
    });
    var dominantSrc = null, dominantN = 0;
    if (srcCount['40']) {
      dominantSrc = '40'; dominantN = srcCount['40'];
    } else {
      Object.keys(srcCount).forEach(function (s) {
        if (srcCount[s] > dominantN) { dominantN = srcCount[s]; dominantSrc = s; }
      });
    }
    var mainRecords = (dominantSrc === null) ? records : records.filter(function (r) {
      var s = (r && r._src !== undefined && r._src !== null) ? String(r._src) : '40';
      return s === dominantSrc;
    });
    if (!mainRecords.length) mainRecords = records;
    var mainSmr = stats(mainRecords.map(function (r) { return r.smr; }));
    var mainLast = null;
    for (var mi = mainRecords.length - 1; mi >= 0; mi--) {
      if (mainRecords[mi].calendar) { mainLast = mainRecords[mi]; break; }
    }
    var mainLastDisplay = (mainLast && mainLast.calendar) ? mainLast.calendar.display : null;
    var identitySplit = (mainSmr.last !== null && smrStats.last !== null &&
                         Math.abs(mainSmr.last - smrStats.last) > 0.05)
      ? { dominantSrc: dominantSrc, dominantCount: dominantN,
          smrMain: mainSmr.last, smrAll: smrStats.last,
          dateMain: mainLastDisplay,
          dateAll: lastWithCal && lastWithCal.calendar ? lastWithCal.calendar.display : null }
      : null;

    return {
      meta: parsed.meta,
      columns: parsed.columns,
      // records = SELURUH data asli (Rule Tampilan: chart & tabel)
      records: records,
      // windowRecords = subset N jam terakhir (Rule Formula)
      windowRecords: winRecords,
      summary: summary,
      anomalies: anomalies,
      historyAnomalies: historyAnomalies,
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
      smrRange: { min: mainSmr.min, max: mainSmr.max, last: mainSmr.last },
      // Rentang SELURUH berkas (pembanding) — dipakai UI untuk menjelaskan
      // bila sumber dominan tertinggal dari berkas lain.
      smrRangeAll: { min: smrStats.min, max: smrStats.max, last: smrStats.last },
      identitySplit: identitySplit,
      lastTimestamp: mainLastDisplay ||
        (lastWithCal && lastWithCal.calendar ? lastWithCal.calendar.display : null),
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
        if ((st === 'CAUTION' || st === 'WARNING' || st === 'CRITICAL') && !firstWarn) {
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

    /* [FIX RENTANG 2026-10-26] SLOPE BUTUH RENTANG SMR YANG MEMADAI.
     * -------------------------------------------------------------------
     * `slope` bersatuan "perubahan per JAM SMR". Bila seluruh pembacaan
     * terkumpul dalam rentang SMR yang sangat sempit, penyebutnya mendekati
     * nol dan slope meledak — lalu RUL (jarak / laju) menyusut jadi angka
     * sangat kecil yang TERLIHAT seperti kedaruratan.
     *
     * Terukur pada data nyata D375A SN 65258 (terlihat di Equipment List
     * sebagai "1 jam"):
     *   6 baris, SMR 99.999,0 .. 99.999,4  -> rentang hanya 0,4 JAM
     *   hydTempMax: [null, 71, 71, null, 76, null] -> hanya 3 nilai terpakai
     *   71 -> 76 °C dalam 0,4 jam  => slope 17,86 °C/JAM
     *   RUL = (100 - 76) / 17,86 = 1 jam
     * Suhu hidrolik naik 17,86 °C per jam adalah mustahil secara fisik;
     * yang sebenarnya terjadi adalah pembagian oleh rentang ~0. SELURUH
     * parameter unit itu ikut terseret (coolant 3 jam, fuelRate 2 jam,
     * engOilTemp 5 jam) — pola khas artefak, bukan kerusakan.
     *
     * Satu baris data per 0,07 jam juga menandakan SMR tidak bergerak
     * (unit idle/mati) sementara jam kalender berjalan.
     *
     * Ambang 50 jam dipilih karena seluruh unit SEHAT di armada contoh
     * punya rentang jendela ribuan jam (yang terkecil 1.092 jam pada
     * PC2000 20127); 50 jam memisahkan bersih tanpa membuang data sah.
     * Dikembalikan `null` (bukan 0 atau Infinity) supaya UI menulis "—":
     * jujur "tidak dapat dihitung", bukan tebakan yang menakutkan.
     *
     * [P0-2b 2026-10-27] SATU IMPLEMENTASI, bukan dua.
     * Versi P0-2 pertama menulis komentar "rentang kini dihitung oleh
     * `smrSpanHours()`" tetapi MENINGGALKAN loop inline di sini — jadi
     * gerbang yang sama punya DUA kode. Itu persis akar `FUEL-b`
     * (satu konsep, dua angka/rumus: yang satu diperbaiki, yang lain
     * hidup sendiri). Kini `estimateRUL()` dan `VHMS_RANKING.trendScore()`
     * memanggil `hasAdequateSpan()` yang SAMA. Dikunci uji `SPAN-10`.
     * ------------------------------------------------------------------- */
    if (!hasAdequateSpan(records, paramKey)) return null;

    /* Ambil nilai valid terakhir.
     * [FIX MASK 2026-10-26] Lewat `maskedValueOf` — nilai dari sensor yang
     * sedang rusak TIDAK boleh menjadi titik awal RUL. Bila SELURUH
     * pembacaan ter-mask, fungsi pulang `null` (RUL tidak dihitung), sama
     * seperti parameter tanpa data. Itu disengaja: lebih baik menulis
     * "—" daripada angka dari sensor rusak. */
    var lastVal = null;
    for (var i = records.length - 1; i >= 0; i--) {
      var v = maskedValueOf(records[i], paramKey);
      if (v !== null) { lastVal = v; break; }
    }
    if (lastVal === null) return null;

    /* [REVISI 2026-10-26] SENSOR MACET -> RUL TIDAK BERMAKNA.
     * -------------------------------------------------------------------
     * `slope()` tidak tahu apakah deret itu bergerak sungguhan. Sensor yang
     * membeku pada satu angka (mis. EGT tertahan 969 °C di 99 dari 99
     * pembacaan) menghasilkan slope positif kecil -> RUL "0 jam" yang
     * TERLIHAT seperti kerusakan mendesak padahal sumbernya sensor/wiring.
     * Terukur pada data nyata: PC2000 SN 20881 `rbfExhTempMax` n=99 dengan
     * hanya 6 nilai unik (min 952, maks 969) -> RUL 0 jam.
     *
     * Kaidah yang dipakai SAMA dengan `VHMS_FAILMODE.stuckSensor()`
     * (rasio nilai dominan >= STUCK_RATIO) supaya dua modul tidak berbeda
     * kesimpulan. Di sini ambangnya sedikit lebih longgar (0,75) karena RUL
     * butuh "cukup beku untuk diragukan", bukan bukti sekuat panel Failure
     * Mode: deret yang masih berubah 1 dari 4 pembacaan tetap dihitung.
     * Sensor macet DITANDAI (`stuck`), bukan dibuang diam-diam, agar UI
     * dapat menulis "perlu cek sensor" alih-alih "0 jam".
     * ------------------------------------------------------------------- */
    var stuck = null;
    if (STUCK_EXEMPT_KEY_RE.test(paramKey)) {
      var freq = {}, valid = 0;
      for (var si = 0; si < records.length; si++) {
        // [FIX MASK 2026-10-26] Rasio "beku" dihitung dari pembacaan yang
        // DIPAKAI formula saja; nilai ter-mask tidak ikut menggemukkan
        // penyebut maupun pembilang.
        var sv = maskedValueOf(records[si], paramKey);
        if (sv === null) continue;
        valid++;
        var sk = String(Math.round(sv * 1000) / 1000);
        freq[sk] = (freq[sk] || 0) + 1;
      }
      if (valid >= STUCK_MIN_N) {
        var topKey = null, topN = 0;
        Object.keys(freq).forEach(function (k) {
          if (freq[k] > topN) { topN = freq[k]; topKey = k; }
        });
        var ratio = topN / valid;
        if (ratio >= STUCK_RUL_RATIO) {
          stuck = { value: Number(topKey), ratio: ratio, count: topN, total: valid };
          return { hours: Infinity, confident: false, slope: sl, lastValue: lastVal,
                   alreadyCritical: false, stuck: stuck };
        }
      }
    }

    /* [FIX B1 2026-10-26] KONDISI SEKARANG DIPERIKSA LEBIH DULU.
     * -------------------------------------------------------------------
     * MASALAH. Dulu gerbang `worsening` ditempatkan DI ATAS `alreadyCrit`.
     * Akibatnya parameter yang NILAI TERAKHIRNYA SUDAH DI ATAS AMBANG KRITIS
     * tetapi slope-nya datar/membaik tidak pernah sampai ke pemeriksaan
     * `alreadyCrit` — ia dipulangkan `hours: Infinity`, dan
     * `rulCellHtml()` menerjemahkan Infinity menjadi "Stabil" BERWARNA
     * HIJAU. Unit yang sedang melewati batas kritis terbaca aman.
     *
     * Terukur (tools/probe-rul-order.js):
     *   hyd 103 °C datar, crit 100      -> Infinity, alreadyCritical false
     *   coolant 112->106 °C, crit 105   -> Infinity, alreadyCritical false
     *   coolant 106->112 °C, crit 105   -> 0 jam,    alreadyCritical true
     * Tiga baris itu kondisinya SAMA (sudah di atas crit); hanya arah slope
     * yang berbeda, dan hanya yang memburuk dilaporkan benar.
     *
     * KAIDAH SEKARANG: "sudah melewati ambang" adalah FAKTA tentang kondisi
     * sekarang, tidak bergantung arah tren — jadi ia diperiksa lebih dulu.
     * Sisa operasi 0 jam berarti "jatah aman sudah habis", bukan ramalan.
     *
     * ⚠ Gerbang SENSOR MACET sengaja TETAP di atas blok ini. Nilai beku
     *   (mis. EGT tertahan 969 °C dengan crit 800) memang di atas crit,
     *   tetapi sumbernya sensor — ia harus tetap pulang sebagai `stuck`,
     *   bukan sebagai "0 jam". Urutan: stuck -> alreadyCrit -> worsening.
     * ------------------------------------------------------------------- */
    var alreadyCrit = (th.mode === 'low') ? (lastVal <= th.crit) : (lastVal >= th.crit);
    if (alreadyCrit) {
      return { hours: 0, confident: true, slope: sl, lastValue: lastVal, alreadyCritical: true };
    }

    // Apakah slope mengarah memburuk?
    var worsening = (th.mode === 'low') ? (sl < 0) : (sl > 0);
    if (!worsening) {
      // Masih di zona aman DAN tidak memburuk — tidak akan mencapai critical
      return { hours: Infinity, confident: false, slope: sl, lastValue: lastVal, alreadyCritical: false };
    }

    var distance = (th.mode === 'low')
      ? (lastVal - th.crit)     // berapa jauh dari batas (positif = masih aman)
      : (th.crit - lastVal);

    var rate = Math.abs(sl);     // perubahan per jam SMR
    if (rate < 1e-12) return { hours: Infinity, confident: false, slope: sl, lastValue: lastVal, alreadyCritical: false };

    var hours = distance / rate;

    /* Confidence: slope dihitung dari >= 6 titik DAN RUL < 10.000 jam.
     * [FIX MASK 2026-10-26] Titik yang ter-mask tidak dihitung — dulu
     * `confident` bisa bernilai true karena baris yang justru dibuang
     * dari slope. */
    var nValid = 0;
    for (var j = 0; j < records.length; j++) {
      var cv = maskedValueOf(records[j], paramKey);
      if (cv !== null && records[j].smr !== null && records[j].smr !== undefined) nValid++;
    }
    var confident = nValid >= 6 && hours < 10000;

    /* [FIX LINIER 2026-10-26] APAKAH GARIS LURUS MEMANG COCOK?
     * -------------------------------------------------------------------
     * RUL mengandaikan laju perburukan TETAP (ekstrapolasi linier). Itu
     * pengandaian, bukan kebenaran — dan sampai sekarang TIDAK PERNAH
     * diperiksa. Bila data sebenarnya berhamburan atau melengkung,
     * garis lurus tetap dipaksakan dan hasilnya dilaporkan dengan
     * kepercayaan yang sama seperti data yang rapi.
     *
     * `fitR2` mengukur seberapa besar ragam data yang DIJELASKAN garis:
     *   R² -> 1  : titik-titik hampir persis di garis (ekstrapolasi layak)
     *   R² -> 0  : garis tak menjelaskan apa pun (ekstrapolasi menyesatkan)
     *
     * Yang DILAKUKAN di sini sengaja TERBATAS: R² hanya MENURUNKAN
     * `confident`, TIDAK mengubah angka `hours` dan tidak membuang RUL.
     * Alasannya jujur — saya tidak punya data kegagalan nyata untuk
     * mengalibrasi model non-linier (Weibull/eksponensial), dan menebak
     * bentuk kurva lebih berbahaya daripada mengakui ketidakpastian.
     *
     * Ambang 0,50 = garis menjelaskan separuh ragam. Di bawah itu, angka
     * RUL tetap ditampilkan tetapi DITANDAI lemah di UI ("?"), sehingga
     * terbaca sebagai isyarat awal, bukan jadwal.
     *
     * ⚠ CATATAN YANG HARUS JUJUR DISAMPAIKAN: R² tinggi TIDAK menjamin
     *   ekstrapolasi benar. Degradasi mekanis kerap melengkung tajam di
     *   akhir, sehingga RUL linier cenderung TERLALU OPTIMIS menjelang
     *   kegagalan. R² hanya menangkap "data yang SUDAH ada tidak cocok
     *   garis" — ia tidak bisa melihat kelengkungan yang belum terjadi.
     * ------------------------------------------------------------------- */
    var r2 = fitR2(records, paramKey);
    if (r2 !== null && r2 < MIN_FIT_R2) confident = false;

    return {
      hours: Math.round(hours),
      confident: confident,
      slope: sl,
      lastValue: lastVal,
      alreadyCritical: false,
      /* [FIX LINIER 2026-10-26] Kecocokan garis (0..1) dibawa serta agar UI
       * / audit dapat menjelaskan MENGAPA sebuah estimasi ditandai lemah,
       * bukan sekadar menandainya. */
      r2: r2,
      nPoints: nValid
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
      // Fuel Trending owns this threshold and its verdict/RUL equivalent.
      if (k === 'fuelRate') continue;
      var rul = estimateRUL(records, k, TH[k]);
      if (rul) result[k] = rul;
    }
    return result;
  }

  /*
   * [REVISI 2026-10-26] Gerbang sensor macet untuk RUL.
   * ---------------------------------------------------------------------
   * HANYA parameter yang MEMANG SELALU BERGEREAK yang diperiksa. Suhu gas
   * buang, boost, dan pressure adalah besaran yang di mesin hidup tidak
   * mungkin membeku di satu angka; kalau membeku, itu sensor/wiring.
   * Parameter seperti `*ExhOver*` (durasi duty) SAH bernilai 0 berulang
   * kali — memasukkannya ke gerbang ini akan membuang RUL yang benar.
   * ------------------------------------------------------------------- */
  var STUCK_EXEMPT_KEY_RE = /(exhtemp|boost|blowby|press|temp)/i;
  var STUCK_MIN_N = 10;        // < 10 pembacaan: rasio tidak bermakna

  /* [FIX RENTANG 2026-10-26] Rentang SMR minimum agar slope bermakna.
   * Lihat catatan lengkap di `estimateRUL()`. Dasar: unit sehat terkecil di
   * armada contoh punya rentang jendela 1.092 jam; unit artefak (D375A
   * 65258) hanya 0,4 jam. 50 jam memisahkan bersih dengan margin lebar.
   * [P0-2 2026-10-27] KONSTANTA INI DIPINDAH KE ATAS berkas (dekat
   * `MIN_FIT_R2`) agar dapat diekspor & dibaca `VHMS_RANKING.slopeOf()`.
   * Dulu ia terkubur di dalam `estimateRUL()` -> hanya RUL yang memakai
   * gerbang, sementara skor tren (25 %) tidak. Jangan mendeklarasikan ulang. */
  /* [KALIBRASI 2026-10-26] Ambang rasio 0,60 — BUKAN 0,90 seperti panel
   * Failure Mode. Dasar dari data nyata armada (urutan rasio nilai dominan):
   *   100% 969 (x100), 100% 100, 91% 969, 85% 969, 79% 0 MPa (oli),
   *   78% 969, 70% 0,37, 66% 969, 64% 969, 63% 969
   * Semua deret EGT di atas adalah SENSOR RUSAK yang sama, tetapi rasionya
   * tersebar 63-100% karena nilai antar-baris sedikit berbeda (919/964).
   * Memakai 0,90 akan meloloskan 7 dari 10. Panel Failure Mode memakai 0,90
   * karena di sana bukti harus kuat untuk menuduh sensor; di sini tujuannya
   * berbeda — cukup untuk MENGATAKAN RUL tidak dapat dipercaya, karena
   * alternatifnya adalah menampilkan "0 jam" yang salah.
   * 0,60 memisahkan bersih: deret sehat tertinggi hanya ~56% (tmMainPress
   * 3 MPa, nilai operasi yang memang sering berulang). */
  var STUCK_RUL_RATIO = 0.60;

  /**
   * Parameter dengan RUL terpendek (paling urgent).
   * [REVISI 2026-10-26] Parameter yang sensornya MACET dilewati — RUL-nya
   * angka semu. Bila SEMUA parameter macet, hasilnya `null` sehingga UI
   * menulis "—" alih-alih "0 jam" yang menakutkan tanpa dasar.
   * @returns {{ param, label, hours, confident, slope, alreadyCritical } | null}
   */
  function mostUrgentRUL(rulMap) {
    var best = null;
    for (var k in rulMap) {
      if (!Object.prototype.hasOwnProperty.call(rulMap, k)) continue;
      var r = rulMap[k];
      if (r.hours === Infinity) continue;
      // [REVISI 2026-10-26] Sensor macet -> RUL tidak bermakna, jangan dipilih.
      if (r.stuck) continue;
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
    /**
     * [AUDIT 2026-10-15 — butir C] DIEKSPOR agar bobot 100/60/20 dan batas
     * label 85/65 dapat DIKUNCI uji. Sebelumnya fungsi ini hanya dipakai
     * internal oleh `analyze()`, sehingga mutation testing membuktikan
     * seluruh bobot & batasnya bisa digeser tanpa satu uji pun merah.
     * Bukan API untuk UI — UI memakai `analyze().health`.
     */
    healthIndex: healthIndex,
    // [T5.6] Kurva kumulatif untuk parameter bertipe DELTA (TC Oil T.1xx-)
    cumulative: cumulative,
    cumulativeTotal: cumulativeTotal,
    evaluateParam: evaluateParam,
    // [KALIBRASI 2026-10-25] Ambang fuelRate dari kuartil unit (Tukey).
    calibrateFuelRate: calibrateFuelRate,
    quantileSorted: quantileSorted,
    /* [P3-3a 2026-10-27] Diekspor agar uji dapat membuktikan kalibrasi
     * memakai JENDELA yang sama dengan yang dinilai skor (FUEL-9). */
    sliceFormulaWindow: sliceFormulaWindow,
    // [SETELAN 2026-10-26] Nilai EFEKTIF (config + default) — dulu konstanta
    // `MIN_FUEL_SAMPLES`. Getter supaya selalu mencerminkan setelan terkini.
    fuelCalSettings: fuelCalSettings,
    get MIN_FUEL_SAMPLES() { return fuelCalSettings().minSamples; },
    buildChartData: buildChartData,
    hexToRgba: hexToRgba,
    estimateRUL: estimateRUL,
    computeAllRUL: computeAllRUL,
    mostUrgentRUL: mostUrgentRUL,
    /* [FIX LINIER 2026-10-26] Diekspor agar ambang kecocokan garis dapat
     * dikunci uji — tanpa ini MIN_FIT_R2 bisa digeser tanpa uji merah. */
    fitR2: fitR2,
    /* [P0-2/P0-3 2026-10-27] Gerbang rentang & jumlah titik diekspor agar
     * `VHMS_RANKING.slopeOf()` MEMBACA nilai yang sama (bukan menyalinnya
     * — lihat SPAN-9). */
    MIN_SMR_SPAN_HOURS: MIN_SMR_SPAN_HOURS,
    MIN_FIT_POINTS: MIN_FIT_POINTS,
    smrSpanHours: smrSpanHours,
    hasAdequateSpan: hasAdequateSpan,
    pearson: pearson,
    detectCorrelations: detectCorrelations,
    buildAnomalies: buildAnomalies,
    buildAlertTimeline: buildAlertTimeline,
    // [PC2000 2026-10-10 — T4] Normalisasi duty gas buang -> persen jendela.
    normalizeExhaustDuty: normalizeExhaustDuty,
    EXHAUST_DUTY_KEYS: EXHAUST_DUTY_KEYS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_ANALYTICS;
  }
})(typeof window !== 'undefined' ? window : globalThis);

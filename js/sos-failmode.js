/* ============================================================================
 * [FITUR 2026-10-17] FAILURE MODE SUMMARY — SOS (analisis oli)
 * ----------------------------------------------------------------------------
 * Padanan `vhms-failmode.js` untuk sisi oli. Spesifikasi lengkap beserta
 * dasar pengukurannya ada di `docs/SPEK-FAILURE-MODE-SOS.md`.
 *
 * GAGASAN INTI — diagnosis lahir dari KORELASI, bukan dari satu unsur.
 *   Fe tinggi sendirian tidak mendiagnosis apa pun (bisa liner, gigi, karat,
 *   atau debu). Yang mendiagnosis adalah POLA beberapa unsur yang naik
 *   bersamaan, dan RASIO di antara mereka:
 *     Fe + Cr          -> ring/liner (krom = pelapis ring)
 *     Fe + Si + Al     -> masuknya debu (abrasif), BUKAN keausan primer
 *     Cu + Pb + Sn     -> overlay bearing tri-metal terkikis
 *     Na + K           -> bocor coolant (Na saja = garam/udara laut)
 *     PQI tinggi/Fe rendah -> SPALLING DINI (spektro buta, lihat pqiRatio)
 *
 * TIGA PERBEDAAN MENDASAR DARI VHMS-FAILMODE (bukan selera, hasil ukur):
 *
 *  1. DATA SOS JARANG. Terukur pada data nyata: 83 % pasangan
 *     (asset|kompartemen) hanya punya 1 sampel; maksimum seluruh armada 6.
 *     VHMS punya 200-350 record. Karena itu kartu di sini TIDAK boleh berupa
 *     grafik garis — satu titik menghasilkan kanvas yang tampak rusak.
 *     Mode tampilan dipilih otomatis: SNAPSHOT -> DELTA -> TREND -> TREND+.
 *
 *  2. GERBANG KORELASI. Skor diturunkan paksa ke NORMAL bila kurang dari
 *     separuh bukti wajib terpenuhi (`evidence < 0.5`). Inilah pembeda
 *     terhadap tabel kompartemen yang sudah ada: satu unsur ekstrem
 *     sendirian BUKAN failure mode, melainkan pencilan yang perlu
 *     diverifikasi. Satu-satunya pengecualian adalah `pqi-debris`, yang
 *     buktinya sendiri (pqi/Fe) SUDAH merupakan korelasi dua kolom.
 *
 *  3. KELUARGA KOMPARTEMEN, bukan nama kompartemen. Data nyata memuat 56
 *     varian nama bebas ("FINAL DRIVE SPUR RIGHT", bahkan nama merek oli
 *     yang salah masuk kolom). Mode dipetakan ke 5 keluarga; kompartemen
 *     tak dikenal jatuh ke GEAR (ambang paling longgar = paling aman).
 *
 * Kontrak data (TIDAK ada parser baru — semua dari SOS_STORE/SOS_ANALYTICS):
 *   unit.samples[]   sampel urut kronologis (dari `SOS_ANALYTICS.analyzeFleet`)
 *   unit.latest      sampel terakhir
 *   unit.component   nama kompartemen MENTAH dari lab (bebas-bentuk)
 *   cfg.getThresholdsFor(component, model)  ambang efektif (+override model)
 * ========================================================================== */
(function (global) {
  'use strict';

  var cfg = global.SOS_CONFIG;
  var _ui = global.UI_UTIL || {};
  var esc = _ui.esc || function (s) { return String(s == null ? '' : s); };
  // [FASE 3-5 · 2026-10-18] Riwayat umur oli & laju keausan. Opsional: bila
  // `sos-history.js` tidak dimuat, seluruh jalur di bawah mundur ke perilaku
  // lama (lane `undefined` -> tak ada perubahan skor).
  var hist = global.SOS_HISTORY || null;

  /* ------------------------------------------------------------------------
   * 1. KELUARGA KOMPARTEMEN
   * ----------------------------------------------------------------------
   * Pencocokan memakai POLA TERPANJANG yang cocok, meniru kaidah
   * `matchComponentKey` di sos-config.js (yang sayangnya tidak diekspor).
   * Urutan di dalam array TIDAK menentukan; panjang pola yang menentukan,
   * sehingga 'SWING DRIVE' menang atas 'DRIVE' bila keduanya cocok.
   * ---------------------------------------------------------------------- */
  var FAMILY_PATTERNS = {
    ENGINE:     ['ENGINE'],
    POWERTRAIN: ['TRANSMISSION', 'TORQUE CONVERTER', 'POWER TAKE OFF',
                 'TRANSFER GEAR', 'DROP BOX', 'CLUTCH'],
    GEAR:       ['FINAL DRIVE', 'DIFFERENTIAL', 'SWING DRIVE', 'TANDEM',
                 'GEAR REDUCER', 'AXLE REDUCTION', 'CIRCLE DRIVE',
                 'VIBRATOR', 'VIBRO', 'DRUM DRIVE', 'PINION'],
    HYDRAULIC:  ['HYDRAULIC', 'STEERING', 'VIBRATORY PUMP', 'VIBRATOR PUMP',
                 'HYDROSTATIC'],
    BEARING:    ['WHEEL BEARING', 'WHEEL HUB', 'SPINDLE', 'BEARING SHAFT',
                 'BARE SHAFT', 'DAMPER', 'BEARING']
  };

  /** Keluarga cadangan untuk kompartemen tak dikenal. GEAR dipilih karena
   *  ambangnya paling longgar — kompartemen asing tidak akan memicu alarm
   *  palsu. Sejalan dengan `THRESHOLD_FALLBACK = 'FINAL DRIVE'`. */
  var FAMILY_FALLBACK = 'GEAR';

  /**
   * Petakan nama kompartemen bebas-bentuk ke salah satu dari 5 keluarga.
   * MURNI (tanpa DOM) agar dapat diuji di Node.
   * @param {string} component
   * @returns {string} 'ENGINE'|'POWERTRAIN'|'GEAR'|'HYDRAULIC'|'BEARING'
   */
  function familyOf(component) {
    var c = String(component == null ? '' : component).toUpperCase().trim();
    if (!c) return FAMILY_FALLBACK;
    var bestFam = null, bestLen = -1;
    Object.keys(FAMILY_PATTERNS).forEach(function (fam) {
      FAMILY_PATTERNS[fam].forEach(function (pat) {
        if (c.indexOf(pat) !== -1 && pat.length > bestLen) {
          bestLen = pat.length; bestFam = fam;
        }
      });
    });
    return bestFam || FAMILY_FALLBACK;
  }

  /* ------------------------------------------------------------------------
   * 2. RASIO PQI/Fe — korelasi paling berharga dalam fitur ini
   * ----------------------------------------------------------------------
   * ICP/spektrometer hanya "melihat" partikel < 5 um. PQI mengukur MASSA
   * feromagnetik total, termasuk serpihan besar. Maka Fe rendah + PQI tinggi
   * berarti retak lelah sedang melepas serpihan BESAR yang tak terlihat
   * spektro — secara historis penyebab nomor satu "gagal mendadak padahal
   * SOS normal". Kondisi ini TIDAK akan pernah tertangkap tabel kompartemen
   * yang menilai tiap kolom sendiri-sendiri.
   *
   * ⚠ AMBANGNYA BERBEDA PER KELUARGA — ini BUKAN penyetelan selera.
   * Terukur pada 1.577 pasangan unit-kompartemen nyata (persentil rasio):
   *
   *            p50    p75    p90    p95    p99    >=3
   *   ENGINE   0,18   0,47   1,00   1,50   3,4    1,8 %
   *   BEARING  0,67   1,00   1,91   4,09  13,6    8,3 %
   *   HYDRAUL  0,56   1,50   3,50   6,00  18,9   12,8 %
   *   POWERTR  0,50   1,15   4,00  12,31  44,8   15,5 %
   *   GEAR     1,20   2,61   7,72  12,37  25,5   21,8 %
   *
   * Kompartemen roda gigi memang WAJAR melepas serpihan besar (PQI ribuan
   * adalah hal biasa di sana), sedangkan mesin tidak. Memakai satu angka 3
   * untuk semuanya = memasang ambang MESIN pada GEARBOX: terbukti menyalakan
   * 21,8 % kompartemen gigi — 437 unit sekaligus. Itu bukan temuan,
   * itu kebisingan yang akan membuat operator berhenti membaca kartunya.
   * Ambang per keluarga dipasang di sekitar p95 masing-masing sehingga
   * tiap keluarga menyalakan ~5 % teratasnya sendiri.
   *
   * @returns {number|null} null bila PQI tidak ada (bukan 0 — beda makna).
   * ---------------------------------------------------------------------- */
  var PQI_RATIO_WARN = {
    ENGINE: 3, BEARING: 4, HYDRAULIC: 6, POWERTRAIN: 12, GEAR: 12
  };

  /** Ambang rasio untuk sebuah keluarga (fallback = nilai paling longgar). */
  function pqiRatioWarn(family) {
    return PQI_RATIO_WARN[family] !== undefined
      ? PQI_RATIO_WARN[family]
      : PQI_RATIO_WARN[FAMILY_FALLBACK];
  }

  function pqiRatio(sample) {
    if (!sample) return null;
    var pqi = sample.pqi;
    if (pqi === null || pqi === undefined || isNaN(pqi)) return null;
    var fe = sample.wear_fe;
    if (fe === null || fe === undefined || isNaN(fe)) return null;
    return pqi / Math.max(fe, 1);
  }

  /* ------------------------------------------------------------------------
   * 3. MATRIKS FAILURE MODE
   * ----------------------------------------------------------------------
   * `req`  = bukti WAJIB  (bobot 1,0) — menentukan `evidence` & gerbang
   * `sup`  = bukti PENGUAT (bobot 0,5) — menaikkan severity, tidak membuka gerbang
   * `low`  = daftar key yang BAHAYANYA DI ARAH RENDAH (viskositas, TBN)
   * `fam`  = keluarga tempat mode ini berlaku
   * URUTAN ARRAY = URUTAN RENDER kartu.
   * ---------------------------------------------------------------------- */
  var FAILURE_MODES = [
    /* ---------------- ENGINE ---------------- */
    { id: 'eng-dirt', fam: 'ENGINE', title: 'Dirt Ingress / Abrasive Wear',
      why: 'Debu silika masuk lewat filter udara atau seal yang bocor dan bekerja seperti amplas.',
      req: ['wear_si', 'wear_al'], sup: ['wear_fe', 'wear_cr'] },
    { id: 'eng-liner', fam: 'ENGINE', title: 'Liner & Ring Wear',
      why: 'Krom adalah pelapis ring piston. Fe naik TANPA Cr berarti sumbernya bukan ring.',
      req: ['wear_fe', 'wear_cr'], sup: ['pqi'] },
    { id: 'eng-bearing', fam: 'ENGINE', title: 'Bearing Wear (Bottom End)',
      why: 'Bearing tri-metal terkikis berurutan: overlay timbal lebih dulu, lalu tembaga.',
      req: ['wear_cu', 'wear_pb'], sup: ['wear_sn', 'wear_al', 'pqi'] },
    { id: 'eng-coolant', fam: 'ENGINE', title: 'Coolant Leak',
      why: 'Na BERSAMA K adalah tanda tangan inhibitor coolant. Na sendirian = garam/udara laut.',
      req: ['additive_na', 'additive_k'], sup: ['water_pct', 'wear_cu'] },
    { id: 'eng-fuel', fam: 'ENGINE', title: 'Fuel Dilution',
      why: 'Solar mengencerkan oli: viskositas turun, cadangan basa ikut habis.',
      req: ['visc_v100', 'tbn'], sup: ['fuel_pct'], low: ['visc_v100', 'tbn'] },
    { id: 'eng-degrade', fam: 'ENGINE', title: 'Oil Degradation / Drain Terlambat',
      why: 'Oli menua karena panas: oksidasi naik sementara cadangan basa (TBN) habis.',
      req: ['oxidation', 'tbn'], sup: ['nitration', 'sulfation', 'visc_v100'], low: ['tbn'] },
    { id: 'eng-topend', fam: 'ENGINE', title: 'Turbo & Valvetrain Wear',
      why: 'Nikel menandai baja paduan tinggi: poros turbo, valve, dan dudukannya.',
      req: ['wear_ni', 'wear_cr'], sup: ['wear_fe'] },
    { id: 'eng-oilmix', fam: 'ENGINE', title: 'Wrong Oil / Top-up Salah',
      why: 'Paket aditif bergeser jauh dari kebiasaan unit ini — indikasi oli beda spesifikasi.',
      additive: true, req: ['additive_zn', 'additive_p'], sup: ['additive_ca', 'additive_mg'] },
    { id: 'eng-debris', fam: 'ENGINE', title: 'Coarse Debris (PQI vs Fe)',
      why: 'PQI tinggi dengan Fe spektro rendah = serpihan BESAR; spektrometer buta terhadapnya.',
      ratio: true, req: ['pqi'], sup: ['wear_fe'] },

    /* ---------------- POWERTRAIN ---------------- */
    { id: 'pwr-spall', fam: 'POWERTRAIN', title: 'Gear & Bearing Spalling',
      why: 'Serpihan feromagnetik besar dari permukaan gigi/bantalan yang mulai mengelupas.',
      ratio: true, req: ['pqi', 'wear_fe'], sup: [] },
    { id: 'pwr-clutch', fam: 'POWERTRAIN', title: 'Clutch Plate / Friction Wear',
      why: 'Pelat kopling berbahan dasar tembaga; Cu naik bersama Fe saat pelat terkikis.',
      req: ['wear_cu', 'wear_fe'], sup: ['pqi'] },
    { id: 'pwr-bush', fam: 'POWERTRAIN', title: 'Bushing & Thrust Washer',
      why: 'Bushing perunggu melepas tembaga dan timah bersamaan.',
      req: ['wear_cu', 'wear_sn'], sup: ['wear_pb'] },
    { id: 'pwr-dirt', fam: 'POWERTRAIN', title: 'Dirt Ingress',
      why: 'Debu masuk lewat breather atau seal; silika + aluminium naik bersama.',
      req: ['wear_si', 'wear_al'], sup: ['wear_fe'] },
    { id: 'pwr-water', fam: 'POWERTRAIN', title: 'Water / Seal Ingress',
      why: 'Air masuk lewat seal menimbulkan korosi dan merusak lapisan aditif.',
      req: ['additive_na', 'water_pct'], sup: ['wear_fe'] },
    { id: 'pwr-oil', fam: 'POWERTRAIN', title: 'Oil Grade Drift',
      why: 'Viskositas keluar pita spesifikasi — salah grade atau oli sudah rusak.',
      req: ['visc_v100'], sup: ['oxidation'], low: ['visc_v100'] },

    /* ---------------- GEAR ---------------- */
    { id: 'gear-spall', fam: 'GEAR', title: 'Tooth Spalling / Pitting',
      why: 'PQI ribuan WAJAR di kompartemen gigi — yang diagnostik adalah rasionya terhadap Fe.',
      ratio: true, req: ['pqi', 'wear_fe'], sup: [] },
    { id: 'gear-bush', fam: 'GEAR', title: 'Bushing & Thrust Wear',
      why: 'Bushing perunggu melepas tembaga dan timah bersamaan.',
      req: ['wear_cu', 'wear_sn'], sup: ['wear_pb'] },
    { id: 'gear-dirt', fam: 'GEAR', title: 'Dirt Ingress / Seal Bocor',
      why: 'Seal gear yang bocor adalah jalur masuk debu nomor satu pada unit tambang.',
      req: ['wear_si', 'wear_al'], sup: ['wear_fe'] },
    { id: 'gear-water', fam: 'GEAR', title: 'Water Ingress / Korosi',
      why: 'Fe karat naik tanpa diikuti PQI — ciri korosi, bukan keausan mekanis.',
      req: ['additive_na', 'water_pct'], sup: ['wear_fe'] },
    { id: 'gear-brake', fam: 'GEAR', title: 'Wet Brake Disc Wear',
      why: 'Final drive berbrake basah: material gesek melepas tembaga bersama besi.',
      req: ['wear_cu', 'wear_fe'], sup: ['pqi'] },

    /* ---------------- HYDRAULIC ---------------- */
    { id: 'hyd-pump', fam: 'HYDRAULIC', title: 'Pump / Motor Wear',
      why: 'Piston shoe & swash plate melepas tembaga; blok silinder melepas besi.',
      req: ['wear_fe', 'wear_cu'], sup: ['wear_cr', 'pqi'] },
    { id: 'hyd-rod', fam: 'HYDRAULIC', title: 'Cylinder Rod Plating',
      why: 'Batang silinder berlapis krom keras; Cr naik berarti lapisannya terkelupas.',
      req: ['wear_cr'], sup: ['wear_fe'] },
    { id: 'hyd-clean', fam: 'HYDRAULIC', title: 'Kontaminasi & Filtrasi',
      why: 'Hidrolik paling peka terhadap partikel: celah kerjanya hanya beberapa mikron.',
      req: ['wear_si', 'pqi'], sup: ['wear_al'] },
    { id: 'hyd-water', fam: 'HYDRAULIC', title: 'Water Ingress',
      why: 'Air dalam hidrolik menimbulkan kavitasi dan karat pada katup presisi.',
      req: ['additive_na', 'water_pct'], sup: ['wear_fe'] },
    { id: 'hyd-additive', fam: 'HYDRAULIC', title: 'Additive Depletion',
      why: 'Zn & P adalah aditif anti-aus; habisnya mendahului lonjakan keausan.',
      additive: true, req: ['additive_zn', 'additive_p'], sup: ['visc_v100'] },

    /* ---------------- BEARING ---------------- */
    { id: 'brg-spall', fam: 'BEARING', title: 'Bearing Spalling',
      why: 'Serpihan feromagnetik besar dari raceway bantalan yang mulai mengelupas.',
      ratio: true, req: ['pqi', 'wear_fe'], sup: [] },
    { id: 'brg-seal', fam: 'BEARING', title: 'Seal Failure',
      why: 'Seal jebol memasukkan air dan debu sekaligus — Na dan Si naik bersama.',
      req: ['additive_na', 'wear_si'], sup: ['water_pct'] },
    { id: 'brg-bush', fam: 'BEARING', title: 'Bushing Wear',
      why: 'Bushing perunggu melepas tembaga dan timah bersamaan.',
      req: ['wear_cu', 'wear_sn'], sup: ['wear_pb'] }
  ];

  /* ------------------------------------------------------------------------
   * 4. PENILAIAN SATU MODE
   * ---------------------------------------------------------------------- */

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  /**
   * Seberapa jauh sebuah nilai melewati ambang `warn`, dinormalkan 0..1.
   * 0 pada 0,7x warn; 1 pada 1,5x warn. Mendukung ambang pita-ganda
   * (visc/tbn) dengan membaca sisi yang relevan.
   *
   * @param {number} value
   * @param {object} th      satu entri threshold
   * @param {boolean} isLow  true bila BAHAYA ada di arah rendah
   * @returns {number} 0..1
   */
  function severityOf(value, th, isLow) {
    if (value === null || value === undefined || isNaN(value) || !th) return 0;
    var worst = 0;

    /* --- AMBANG PITA-GANDA (viskositas, TBN) ----------------------------
     * NOL di dalam pita sehat, naik begitu keluar pita: 0 pada `warn`,
     * 1 pada `crit`.
     *
     * ⚠ DUA kekeliruan ditemukan saat menulis uji SFM-16:
     *  1. Versi pertama hanya menilai sisi RENDAH bila `warn_low` ada,
     *     sehingga oli yang MENGENTAL (oksidasi/jelaga) — justru gejala
     *     mode `eng-degrade` — tidak pernah terdeteksi.
     *  2. Versi kedua memakai kurva "mulai 0,7x ambang" yang sama dengan
     *     ambang tunggal. Pada pita V100 11,5-16 itu berarti severity
     *     mulai naik sejak 11,2 — yakni DI DALAM pita sehat. Oli yang
     *     sempurna (13,5 cSt) ikut tercatat bermasalah. Pita punya batas
     *     tegas di kedua sisi, jadi tidak boleh ada "ancang-ancang".
     * -------------------------------------------------------------------- */
    var dual = (th.warn_low !== undefined || th.warn_high !== undefined);
    if (dual) {
      if (th.warn_low !== undefined && value < th.warn_low) {
        var spanLo = th.warn_low - (th.crit_low !== undefined ? th.crit_low : th.warn_low * 0.8);
        worst = Math.max(worst, spanLo > 0 ? clamp01((th.warn_low - value) / spanLo) : 1);
      }
      if (th.warn_high !== undefined && value > th.warn_high) {
        var spanHi = (th.crit_high !== undefined ? th.crit_high : th.warn_high * 1.2) - th.warn_high;
        worst = Math.max(worst, spanHi > 0 ? clamp01((value - th.warn_high) / spanHi) : 1);
      }
      return worst;
    }

    // --- AMBANG TUNGGAL "makin tinggi makin buruk" ------------------------
    // Di sini "ancang-ancang" DISENGAJA: 0 pada 0,7x warn, 1 pada 1,5x warn.
    // Dua unsur yang sama-sama MENDEKATI ambang adalah korelasi yang berarti,
    // dan harus terlihat sebelum salah satunya melewatinya.
    if (isLow) return 0;        // diminta sisi rendah, tapi ambangnya tunggal
    if (th.warn === undefined || th.warn <= 0) return 0;
    return clamp01((value / th.warn - 0.7) / 0.8);
  }

  /**
   * Garis dasar aditif = MEDIAN unit itu sendiri. Dipakai mode `additive:true`
   * (Wrong Oil / Additive Depletion), di mana yang diagnostik adalah
   * PERGESERAN terhadap kebiasaan unit, bukan nilai mutlak (paket aditif
   * berbeda sah antar merek oli).
   * ⚠ Dengan 1 sampel, median = nilai itu sendiri -> pergeseran 0. Itu BENAR:
   * tanpa riwayat, "berubah dari kebiasaan" memang tak dapat dibuktikan.
   */
  function additiveShift(samples, key) {
    if (!samples || samples.length < 3) return 0;
    var vals = [];
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i][key];
      if (v !== null && v !== undefined && !isNaN(v)) vals.push(v);
    }
    if (vals.length < 3) return 0;
    var last = vals[vals.length - 1];
    var prior = vals.slice(0, -1).sort(function (a, b) { return a - b; });
    var med = prior[Math.floor(prior.length / 2)];
    if (!med) return 0;
    return Math.abs(last - med) / med;      // 0,30 = bergeser 30 %
  }

  /**
   * [FASE 4 · 2026-10-18] Garis dasar ERA TENANG.
   *
   * Masalah `additiveShift` lama: ia memakai median SELURUH riwayat. Makin
   * panjang riwayat, makin buruk — median 4 tahun mencampur era kebocoran
   * coolant (Na puncak 179 ppm) dengan era bersih (Na 1-3 ppm), sehingga
   * garis dasarnya kotor dan pergeseran sungguhan tak terbaca.
   *
   * Maka: median hanya atas sampel yang TIDAK melewati ambang warn. Bila
   * sampel "tenang" kurang dari 3 (unit yang seluruh riwayatnya bermasalah),
   * MUNDUR ke perilaku lama — jangan mengarang garis dasar dari 1-2 titik.
   */
  function stableShift(samples, key, th) {
    if (!samples || samples.length < 3) return 0;
    if (!hist || !hist.stableBaseline) return additiveShift(samples, key);
    var base = hist.stableBaseline(samples, key, th);
    if (!base || !base.median) return additiveShift(samples, key);

    // Nilai terakhir yang terukur, dibandingkan ke era TENANG.
    var last = null;
    for (var i = samples.length - 1; i >= 0; i--) {
      var v = samples[i][key];
      if (v !== null && v !== undefined && !isNaN(v)) { last = v; break; }
    }
    if (last === null) return 0;
    return Math.abs(last - base.median) / base.median;   // 0,30 = bergeser 30 %
  }

  /** Laju keausan per 100 jam untuk satu key, dari dua sampel terakhir. */
  function row100(samples, key) {
    if (!samples || samples.length < 2) return null;
    var A = global.SOS_ANALYTICS;
    if (!A || !A.calcROW100) return null;
    return A.calcROW100(samples[samples.length - 1], samples[samples.length - 2], key);
  }

  /** Mode tampilan kartu menurut jumlah sampel (lihat §4 spek). */
  function displayMode(n) {
    if (n >= 5) return 'TREND+';
    if (n >= 3) return 'TREND';
    if (n === 2) return 'DELTA';
    return 'SNAPSHOT';
  }

  var CONFIDENCE = { 'SNAPSHOT': 'Snapshot', 'DELTA': 'Rendah', 'TREND': 'Sedang', 'TREND+': 'Baik' };

  /**
   * Skor satu failure mode untuk satu unit (asset|kompartemen).
   * MURNI — tidak menyentuh DOM. Dapat diuji langsung di Node.
   *
   *   SKOR = 100 x evidence x (0,65 x severity + 0,35 x trend)
   *   Pita: >= 45 CRITICAL, >= 25 CAUTION, < 25 NORMAL
   *         (sama dengan SOS_CONFIG.CRITICALITY.bands)
   *
   * Korelasi MENGALIKAN (keyakinan), tidak MENAMBAH (besaran) — lihat
   * catatan panjang di badan fungsi: rumus penjumlahan membuat pita CAUTION
   * praktis mati (terukur 0 % pada 4 dari 6 mode).
   *
   * GERBANG KORELASI: bukti wajib terpenuhi < 2 -> band dipaksa NORMAL.
   *
   * @param {object} mode  satu entri FAILURE_MODES
   * @param {object} unit  dari SOS_ANALYTICS.analyzeFleet
   * @returns {object|null} null bila mode tidak berlaku (tak ada data sama sekali)
   */
  function modeScore(mode, unit) {
    if (!mode || !unit || !unit.latest) return null;
    var samples = unit.samples || [unit.latest];
    var s = unit.latest;
    var th = cfg.getThresholdsFor(unit.component, unit.model) || {};
    var lowKeys = {};
    (mode.low || []).forEach(function (k) { lowKeys[k] = true; });

    var items = [];
    var reqMet = 0, reqTotal = 0, reqWithData = 0;
    var sevNum = 0, sevDen = 0;
    var trendNum = 0, trendDen = 0;

    function consider(key, weight, isReq) {
      var v = s[key];
      var has = (v !== null && v !== undefined && !isNaN(v));
      if (isReq) reqTotal++;
      if (!has) {
        if (isReq) items.push({ key: key, value: null, req: true, sev: 0, met: false });
        return;
      }
      if (isReq) reqWithData++;

      var sev;
      if (mode.additive) {
        // Pergeseran relatif terhadap garis dasar unit; 30 % = penuh.
        // [FASE 4] `stableShift` memakai median ERA TENANG bila tersedia,
        // dan mundur ke `additiveShift` (median seluruh riwayat) bila tidak.
        sev = clamp01(stableShift(samples, key, th[key]) / 0.30);
      } else {
        sev = severityOf(v, th[key], !!lowKeys[key]);
      }

      // "Terpenuhi" = sudah melewati ~0,9x ambang warn (sev >= 0,25 pada
      // kurva severityOf). Sengaja SEDIKIT di bawah ambang: korelasi dua
      // unsur yang keduanya mendekati ambang lebih berarti daripada satu
      // unsur yang melewatinya sendirian.
      var met = sev >= 0.25;
      if (isReq && met) reqMet++;

      sevNum += weight * sev; sevDen += weight;

      var r = row100(samples, key);
      if (r !== null && !isNaN(r)) {
        // Referensi laju: ambang warn per 1000 jam. Naik secepat itu = 1,0.
        var ref = (th[key] && th[key].warn) ? th[key].warn / 1000 : null;
        if (ref && ref > 0) { trendNum += weight * clamp01(r / ref); trendDen += weight; }
      }

      items.push({ key: key, value: v, req: isReq, sev: sev, met: met, row100: r,
                   th: th[key] || null, low: !!lowKeys[key] });
    }

    (mode.req || []).forEach(function (k) { consider(k, 1.0, true); });
    (mode.sup || []).forEach(function (k) { consider(k, 0.5, false); });

    // Mode berbasis rasio: PQI/Fe menggantikan perhitungan bukti biasa,
    // karena rasio itu SENDIRI sudah merupakan korelasi dua kolom.
    var ratio = null, ratioWarn = null;
    if (mode.ratio) {
      ratio = pqiRatio(s);
      ratioWarn = pqiRatioWarn(familyOf(unit.component));
      if (ratio !== null) {
        // 0 pada setengah ambang, 1 pada dua kali ambang.
        var rsev = clamp01((ratio - ratioWarn * 0.5) / (ratioWarn * 1.5));
        sevNum += 1.0 * rsev; sevDen += 1.0;
        if (ratio >= ratioWarn) { reqMet = reqTotal; }   // rasio = bukti utuh
      }
    }

    // Tak satu pun bukti wajib punya data -> mode tidak berlaku untuk unit ini.
    if (reqWithData === 0 && ratio === null) return null;

    var severity = sevDen > 0 ? sevNum / sevDen : 0;
    var evidence = reqTotal > 0 ? reqMet / reqTotal : 0;
    var trend = trendDen > 0 ? trendNum / trendDen : 0;

    /* ---- [FASE 3 · 2026-10-18] LANTAI TREND dari laju keausan per jam-oli
     * `trend` di atas dihitung `calcROW100` (nilai logam per 100 jam HM).
     * Pelebaran umur oli — Fe 20 pada oli 424 jam jauh lebih ringan daripada
     * Fe 12 pada oli 192 jam — tidak terlihat oleh ukuran itu. `rateTrend`
     * meregres wearRate (ppm per 100 jam-OLI) terhadap meter unit.
     *
     * KEPUTUSAN: pakai nilai yang LEBIH BESAR (lantai), bukan menukar.
     * Alasannya perlindungan: Fase 2 membuat `calcROW100` mengembalikan null
     * lintas ganti oli, jadi sebagian unit kehilangan suku trend. Tanpa
     * lantai, skor mereka turun bukan karena mesin membaik, melainkan karena
     * aritmetikanya kini benar. Lantai menjamin fase ini TIDAK PERNAH
     * menurunkan skor unit mana pun — hanya dapat menaikkannya.
     * ------------------------------------------------------------------- */
    var trendOil = null;
    if (hist && samples.length >= 3) {
      var tNum = 0, tDen = 0;
      // ⚠ `items` BELUM terisi di titik ini — `consider()` baru dijalankan
      // beberapa baris di atas untuk req/sup, TETAPI `th[key]` di sini selalu
      // undefined karena `th` adalah objek ambang, bukan `items`. Versi
      // pertama membaca `it.th` dari `items` yang kosong sehingga SELURUH
      // cabang tak pernah menyala — terbukti di browser: rateTrend r2=1 tapi
      // trend kartu tetap 0. Sumber yang benar: `mode.req`/`mode.sup` + `th`.
      var keys = [];
      (mode.req || []).forEach(function (k) { keys.push({ k: k, w: 1.0 }); });
      (mode.sup || []).forEach(function (k) { keys.push({ k: k, w: 0.5 }); });
      keys.forEach(function (e) {
        var v = s[e.k];
        if (v === null || v === undefined || isNaN(v)) return;
        var rt = hist.rateTrend(samples, e.k);
        if (!rt || !isFinite(rt.slope) || rt.r2 < 0.3) return;   // berisik
        // Referensi: ambang warn per 1000 jam-oli. Naik secepat itu = 1,0.
        var ref = (th[e.k] && th[e.k].warn) ? th[e.k].warn : null;
        if (!ref || ref <= 0) return;
        tNum += e.w * clamp01(rt.slope / ref);
        tDen += e.w;
      });
      if (tDen > 0) trendOil = tNum / tDen;
    }
    if (trendOil !== null && trendOil > trend) trend = trendOil;

    // ---- SKOR: korelasi MENGALIKAN, tidak MENAMBAH -------------------------
    // \u26a0 KEKELIRUAN KEEMPAT (ditemukan dari sapuan 1.601 unit / 8.951 mode).
    // Rumus awal (spek \u00a75) menjumlah: 0,45\u00b7sev + 0,30\u00b7ev + 0,25\u00b7tren.
    // Terukur hasilnya MUSTAHIL: pita CAUTION nyaris tak pernah tercapai \u2014
    // `gear-spall` 36 % CRITICAL tetapi 0 % CAUTION; `gear-dirt` 17 %/0 %;
    // `brg-spall` 49 %/0 %. Mode melompat NORMAL -> CRITICAL tanpa transisi.
    //
    // Sebabnya: korelasi dihitung DUA KALI. Ia sudah menjadi GERBANG (di
    // bawah), lalu ditambahkan lagi sebagai 30 angka. Karena gerbang membuat
    // `evidence` praktis biner untuk mode berbukti-dua, melewatinya langsung
    // menabung 30 angka \u2014 hanya menyisakan celah 15 angka untuk seluruh pita
    // CAUTION. Pita yang tak dapat dicapai = pita mati: operator kehilangan
    // peringatan dini dan hanya menerima vonis merah mendadak.
    //
    // Yang benar secara fisik: korelasi adalah KEYAKINAN, bukan BESARAN.
    // "Seberapa yakin ini mode tsb" mengalikan "seberapa parah", persis
    // seperti nilai harapan. Maka: skor = besaran x keyakinan.
    var magnitude = 0.65 * severity + 0.35 * trend;
    var score = 100 * evidence * magnitude;

    var band = score >= 45 ? 'CRITICAL' : (score >= 25 ? 'CAUTION' : 'NORMAL');

    // ---- GERBANG KORELASI -------------------------------------------------
    // Korelasi berarti DUA HAL TERJADI BERSAMAAN. Maka syaratnya adalah
    // JUMLAH bukti wajib yang terpenuhi (>= 2), BUKAN pecahannya.
    //
    // ⚠ Versi pertama memakai `evidence < 0.5`. Itu KELIRU dan terbukti
    // bocor pada uji SFM-4: mode dengan 2 bukti wajib yang hanya terpenuhi
    // SATU menghasilkan evidence = 0,50 — tepat lolos ambang — sehingga
    // Fe 400 ppm dengan Cr normal tetap berstatus Caution. Padahal justru
    // kasus itulah yang ingin dicegah. Sebagian besar mode di sini punya
    // tepat 2 bukti wajib, jadi kebocorannya luas, bukan kasus pinggiran.
    //
    // Mode berbukti-wajib-tunggal (dirancang demikian) tetap boleh menyala
    // dengan satu bukti; `mode.ratio` dikecualikan karena rasio PQI/Fe
    // dengan sendirinya sudah merupakan korelasi dua kolom.
    // \u26a0 KEKELIRUAN KETIGA (ditemukan saat kalibrasi per-keluarga): mode
    // rasio semula dikecualikan dari gerbang TANPA SYARAT. Akibatnya PQI
    // tinggi SENDIRIAN tetap lolos walau rasionya masih wajar untuk
    // keluarganya \u2014 persis kebocoran yang gerbang ini ada untuk mencegah.
    // Pengecualian hanya sah bila RASIONYA SENDIRI yang menyala; bila tidak,
    // mode rasio tunduk pada aturan yang sama dengan mode lain.
    var ratioFired = (mode.ratio && ratio !== null && ratio >= ratioWarn);
    var needPair = (mode.req || []).length >= 2;
    var gated = false;
    if (!ratioFired && needPair && reqMet < 2 && band !== 'NORMAL') {
      band = 'NORMAL'; gated = true;
    }

    /* ---- [FASE 5 · 2026-10-18] REKURENSI menahan band dari NORMAL --------
     * Unit yang baru bersih SETELAH beberapa episode tidak sama dengan unit
     * yang tak pernah bermasalah. Contoh nyata (EXKM21056, Na): episode
     * Des-2024 s/d Jun-2026 dengan puncak 179 ppm, lalu turun ke 1-2 ppm.
     * Sampel terbaru Na = 1 -> severity 0 -> NORMAL. Padahal ini justru
     * periode pasca-perbaikan yang paling perlu dipantau.
     *
     * HANYA MENAHAN BAND. Tidak menambah skor — supaya tidak mengulangi
     * kekeliruan "korelasi dihitung dua kali" yang dijelaskan panjang di atas.
     * Syarat ketat agar tidak menjadi alarm permanen:
     *   count >= 2  (rekurensi, bukan kejadian tunggal)
     *   samplesSinceClear < 3  (baru saja bersih)
     *   ambang masih "hidup" (warn > 0) agar mode tanpa ambang tak menyala.
     * ------------------------------------------------------------------- */
    var recurrence = null;
    if (hist && hist.episodes && band === 'NORMAL' && samples.length >= 4) {
      var best = null;
      items.forEach(function (it) {
        if (it.value === null || it.value === undefined) return;
        if (!it.th || !(it.th.warn > 0)) return;
        var ep = hist.episodes(samples, it.key, it.th);
        if (!ep || ep.count < 2) return;
        if (ep.samplesSinceClear >= 3) return;
        if (!best || ep.count > best.count) {
          best = { count: ep.count, maxVal: ep.maxVal, key: it.key,
                   samplesSinceClear: ep.samplesSinceClear };
        }
      });
      if (best) {
        band = 'CAUTION';
        recurrence = best;
      }
    }

    var dm = displayMode(samples.length);

    /* [FASE 6 · 2026-10-18] Label keyakinan yang JUJUR.
     * `displayMode` lama hanya menghitung `samples.length`, sehingga 70
     * sampel yang semuanya `UNVERIFIED` tetap berlabel "Baik" — janji palsu:
     * angkanya tidak memakai kedalaman itu. Bila riwayat tersedia, label
     * diturunkan dari trust umur oli + r² slope. Output TIDAK PERNAH naik
     * di atas nilai lama (hanya sama atau lebih rendah), jadi tak ada unit
     * yang tiba-tiba dipromosikan tanpa bukti. */
    var confidence = CONFIDENCE[dm];
    if (hist && hist.confidenceLabel && unit.oilAges) {
      try {
        var td = hist.rateTrend(samples, items.length ? items[0].key : 'wear_fe');
        var lab = hist.confidenceLabel(unit.oilAges, td);
        var rank = { 'Snapshot': 0, 'Rendah': 1, 'Sedang': 2, 'Baik': 3 };
        if (rank[lab] < rank[confidence]) confidence = lab;
      } catch (e) { /* label tetap nilai lama */ }
    }

    return {
      id: mode.id, title: mode.title, why: mode.why,
      score: Math.round(score * 10) / 10,
      band: band, gated: gated,
      severity: severity, evidence: evidence, trend: trend,
      ratio: ratio, ratioWarn: ratioWarn, items: items,
      display: dm, confidence: confidence,
      recurrence: recurrence,
      sampleCount: samples.length
    };
  }

  /**
   * Semua mode yang berlaku untuk sebuah unit, sudah diskor dan DIURUTKAN
   * menurut skor menurun (yang paling mendesak di kiri-atas).
   * Mode tanpa data bukti wajib di-hide otomatis (modeScore -> null).
   */
  function visibleModes(unit) {
    if (!unit) return [];
    var fam = familyOf(unit.component);
    var out = [];
    FAILURE_MODES.forEach(function (m) {
      if (m.fam !== fam) return;
      var r = modeScore(m, unit);
      if (r) out.push(r);
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /**
   * Teks sub-judul panel. MURNI agar dapat diuji (pola `buildSubText` di
   * vhms-failmode.js). Nomor lambung lewat rantai resolusi bersama.
   */
  function buildSubText(unit) {
    if (!unit) return '';
    var ps = global.PORTFOLIO_STORE;
    var lambung = unit.assetId;
    if (ps && ps.resolveLambung) {
      try { lambung = ps.resolveLambung(unit.assetId, unit.serial) || unit.assetId; } catch (e) {}
    }
    var parts = [lambung];
    if (unit.model) parts.push(unit.model);
    parts.push(unit.component);
    var hm = [];
    if (unit.hmUnit) hm.push('HM ' + Math.round(unit.hmUnit));
    if (unit.hmOil) hm.push('Oil ' + Math.round(unit.hmOil));
    if (hm.length) parts.push(hm.join(' / '));
    var n = (unit.samples || []).length;
    parts.push(n + ' sampel');
    var txt = parts.join(' • ');
    if (unit.lastDate) txt += ' - Last Update ' + unit.lastDate;
    return txt;
  }

  /* ------------------------------------------------------------------------
   * 5. RENDER
   * ---------------------------------------------------------------------- */

  var charts = {};
  var currentUnit = null;

  function destroyAll() {
    Object.keys(charts).forEach(function (k) {
      try { charts[k].destroy(); } catch (e) {}
      delete charts[k];
    });
  }

  var BAND_CLASS = { CRITICAL: 'crit', CAUTION: 'caut', NORMAL: 'norm' };

  function labelOf(key) {
    var p = cfg.PARAMS[key];
    return p ? p.label : key;
  }

  function decimalsOf(key) {
    var p = cfg.PARAMS[key];
    return (p && p.decimals !== undefined) ? p.decimals : 1;
  }

  function fmtVal(v, key) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(decimalsOf(key));
  }

  /**
   * Satu baris bukti: bar "bullet" yang menunjukkan posisi nilai relatif
   * terhadap ambang warn/crit. Inilah pengganti grafik garis untuk 83 %
   * armada yang hanya punya satu sampel.
   */
  function evidenceRow(it) {
    var pctw = Math.round(it.sev * 100);
    var cls = it.sev >= 0.75 ? 'crit' : (it.sev >= 0.25 ? 'caut' : 'norm');
    var thTxt = '';
    if (it.th) {
      if (it.th.warn_low !== undefined) thTxt = 'ambang rendah ' + it.th.warn_low;
      else if (it.th.warn !== undefined) thTxt = 'warn ' + it.th.warn +
        (it.th.crit !== undefined ? ' / crit ' + it.th.crit : '');
    }
    var row = '';
    if (it.row100 !== null && it.row100 !== undefined && !isNaN(it.row100)) {
      var sign = it.row100 > 0 ? '+' : '';
      row = '<span class="sfm-row100" title="Laju perubahan per 100 jam operasi">' +
            sign + it.row100.toFixed(2) + '/100j</span>';
    }
    return '<div class="sfm-ev' + (it.req ? ' is-req' : '') + '">' +
      '<span class="sfm-ev-name" title="' + esc(it.req ? 'Bukti wajib' : 'Bukti penguat') + '">' +
        (it.req ? '<i class="fa-solid fa-circle-dot"></i> ' : '<i class="fa-regular fa-circle"></i> ') +
        esc(labelOf(it.key)) + '</span>' +
      '<span class="sfm-ev-val">' + esc(fmtVal(it.value, it.key)) + '</span>' +
      '<span class="sfm-bar" title="' + esc(thTxt) + '">' +
        '<i class="sfm-bar-fill ' + cls + '" style="width:' + pctw + '%"></i>' +
      '</span>' + row +
      '</div>';
  }

  /** Kartu satu failure mode. */
  function cardHtml(r) {
    var bc = BAND_CLASS[r.band] || 'norm';
    var ev = Math.round(r.evidence * 100);
    var gate = r.gated
      ? '<div class="sfm-gate" title="Kurang dari separuh bukti wajib terpenuhi — pola korelasi belum terbentuk, jadi status ditahan di Normal meski ada parameter yang tinggi.">' +
        '<i class="fa-solid fa-filter-circle-xmark"></i> Ditahan: korelasi belum terbentuk</div>'
      : '';
    var ratio = '';
    if (r.ratio !== null && r.ratio !== undefined) {
      var rw = r.ratioWarn;
      var rc = r.ratio >= rw ? 'crit' : (r.ratio >= rw * 0.5 ? 'caut' : 'norm');
      ratio = '<div class="sfm-ratio ' + rc + '" title="PQI dibagi Fe spektro. Spektrometer hanya melihat partikel di bawah 5 mikron, jadi rasio tinggi menandakan kerusakan yang tak terbaca unsur Fe. Ambang keluarga ini ' + rw + ' — kompartemen roda gigi wajar berasio lebih tinggi daripada mesin.">' +
        'PQI/Fe = ' + r.ratio.toFixed(2) + ' (ambang ' + rw + ')' +
        (r.ratio >= rw ? ' — serpihan kasar' : '') + '</div>';
    }
    /* [FASE 5 · 2026-10-18] Badge REKURENSI.
     * Tanpa ini, kartu CAUTION ber-"Skor 0" tampak seperti salah hitung —
     * padahal band-nya SENGAJA ditahan oleh riwayat episode, bukan oleh skor.
     * Operator harus melihat ALASANNYA, bukan menebak. */
    var recur = '';
    if (r.recurrence) {
      recur = '<div class="sfm-gate" title="Band ditahan di CAUTION oleh RIWAYAT: parameter ini sudah beberapa kali melewati ambang lalu kembali normal. Unit yang baru pulih tidak setara dengan unit yang tidak pernah bermasalah — periode pasca-perbaikan justru paling perlu dipantau.">' +
        '<i class="fa-solid fa-clock-rotate-left"></i> Berulang: ' +
        r.recurrence.count + ' episode' +
        (r.recurrence.maxVal !== null ? ' (puncak ' + labelOf(r.recurrence.key) + ' ' +
          fmtVal(r.recurrence.maxVal, r.recurrence.key) + ')' : '') +
        ' — baru pulih</div>';
    }
    var trendOil = (r.trend > 0 && hist)
      ? '<span title="Suku laju keausan per 100 jam-OLI (Fase 3). Nilai kartu memakai yang LEBIH BESAR antara laju lama dan laju ternormalkan, jadi skor tidak pernah turun.">' +
        'Laju ' + (r.trend * 100).toFixed(0) + '%</span>'
      : '';
    return '<div class="panel sfm-card sfm-' + bc + '" data-sfm-id="' + esc(r.id) + '">' +
      '<div class="sfm-head">' +
        '<h3 class="sfm-title">' + esc(r.title) + '</h3>' +
        // Kelas badge memakai kunci HURUF BESAR (`sev-CRITICAL`), sesuai
        // `.sev-badge.sev-*` yang sudah ada di vhms-dashboard.css.
        '<span class="sev-badge sev-' + esc(r.band) + '" title="Skor ' + r.score + ' dari 100">' +
          esc(r.band) + '</span>' +
      '</div>' +
      '<p class="sfm-why">' + esc(r.why) + '</p>' +
      '<div class="sfm-meta">' +
        '<span title="Bukti wajib yang terpenuhi. Inilah yang membedakan failure mode dari satu parameter tinggi yang berdiri sendiri.">Korelasi ' + ev + '%</span>' +
        '<span title="Skor gabungan: severity 65% + laju 35%, dikalikan korelasi">Skor ' + r.score + '</span>' +
        trendOil +
        '<span title="Keyakinan: ' + r.sampleCount + ' sampel, diturunkan bila umur oli tak terverifikasi atau tren berisik (r\u00b2 rendah)">' +
          esc(r.confidence) + '</span>' +
      '</div>' +
      recur + gate + ratio +
      '<div class="sfm-evs">' + r.items.map(evidenceRow).join('') + '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------------------
   * [FITUR 2026-10-17] RESULT DESCRIPTION
   * ----------------------------------------------------------------------
   * Rangkuman naratif yang HANYA mengambil kartu berskor SEDANG ke TINGGI,
   * yaitu band CAUTION & CRITICAL (ambang band sudah ditetapkan di modeScore:
   * >= 45 CRITICAL, >= 25 CAUTION). Kartu yang DITAHAN gerbang korelasi
   * (`gated`) sengaja TIDAK ikut walau skor mentahnya tinggi — menyertakannya
   * akan membatalkan alasan keberadaan gerbang itu.
   *
   * MURNI (tanpa DOM) agar dapat diuji di Node, mengikuti pola buildSubText.
   * @param {object[]} modes hasil visibleModes()
   * @returns {object|null} { crit[], caut[], drivers[], text } atau null
   * ---------------------------------------------------------------------- */
  function buildDescription(modes) {
    var sel = (modes || []).filter(function (m) {
      return !m.gated && (m.band === 'CRITICAL' || m.band === 'CAUTION');
    });
    if (!sel.length) return null;

    var crit = sel.filter(function (m) { return m.band === 'CRITICAL'; });
    var caut = sel.filter(function (m) { return m.band === 'CAUTION'; });

    // Unsur pendorong = bukti WAJIB yang terpenuhi pada kartu terpilih,
    // diurutkan dari yang paling jauh melewati ambang. Dedup per parameter
    // karena satu unsur (mis. Fe) bisa muncul di beberapa mode.
    var seen = {}, drivers = [];
    sel.forEach(function (m) {
      (m.items || []).forEach(function (it) {
        if (!it.req || !it.met) return;
        if (seen[it.key] && seen[it.key].sev >= it.sev) return;
        if (!seen[it.key]) drivers.push(it.key);
        seen[it.key] = it;
      });
    });
    drivers.sort(function (a, b) { return seen[b].sev - seen[a].sev; });
    var driverObjs = drivers.map(function (k) { return seen[k]; });

    // Keyakinan paling lemah di antara kartu terpilih — pembaca harus tahu
    // kesimpulan ini berdiri di atas berapa sampel.
    var minSamples = sel.reduce(function (n, m) {
      return Math.min(n, m.sampleCount || 0);
    }, Infinity);

    var t = '';
    if (crit.length) {
      t += crit.length + ' pola kegagalan berstatus <strong>Critical</strong>' +
           (caut.length ? ' dan ' + caut.length + ' berstatus <strong>Caution</strong>' : '') +
           ' terbentuk pada kompartemen ini. ';
    } else {
      t += caut.length + ' pola kegagalan berstatus <strong>Caution</strong> ' +
           'terbentuk pada kompartemen ini. ';
    }
    t += 'Yang paling mendesak: <strong>' + esc(sel[0].title) + '</strong> (skor ' +
         sel[0].score + ', korelasi ' + Math.round(sel[0].evidence * 100) + '%) — ' +
         esc(sel[0].why) + ' ';
    if (driverObjs.length) {
      t += 'Unsur yang mendorong kesimpulan: ' +
        driverObjs.slice(0, 5).map(function (it) {
          return '<strong>' + esc(labelOf(it.key)) + '</strong> ' + esc(fmtVal(it.value, it.key));
        }).join(', ') + '. ';
    }
    t += 'Tindak lanjut mengikuti kartu berstatus tertinggi lebih dulu; ' +
         'keyakinan penilaian ' + (minSamples >= 4 ? 'baik' : (minSamples >= 2 ? 'sedang' : 'terbatas')) +
         ' karena bersandar pada ' + minSamples + ' sampel.';

    return { crit: crit, caut: caut, drivers: driverObjs, text: t, minSamples: minSamples };
  }

  /** HTML blok Result description ('' bila tak ada kartu Caution/Critical). */
  function descriptionHtml(modes) {
    var d = buildDescription(modes);
    if (!d) {
      return '<div class="panel sfm-desc sfm-desc-ok">' +
        '<h3 class="sfm-desc-title"><i class="fa-solid fa-circle-check"></i> Result Description</h3>' +
        '<p class="sfm-desc-body">Tidak ada pola kegagalan berskor sedang ke tinggi pada ' +
        'kompartemen ini. Seluruh kartu berstatus Normal — baik karena nilainya memang ' +
        'di bawah ambang, maupun karena korelasi antar unsur belum terbentuk.</p></div>';
    }
    var cls = d.crit.length ? 'sfm-desc-crit' : 'sfm-desc-caut';
    var chips = d.crit.concat(d.caut).map(function (m) {
      return '<span class="sfm-desc-chip ' + (BAND_CLASS[m.band] || 'norm') + '">' +
             esc(m.title) + ' <b>' + m.score + '</b></span>';
    }).join('');
    return '<div class="panel sfm-desc ' + cls + '">' +
      '<h3 class="sfm-desc-title"><i class="fa-solid fa-clipboard-list"></i> Result Description</h3>' +
      '<p class="sfm-desc-body">' + d.text + '</p>' +
      '<div class="sfm-desc-chips">' + chips + '</div>' +
      '</div>';
  }

  /** Gambar panel untuk satu unit. */
  function render(unit) {
    var grid = document.getElementById('sos-failmode-grid');
    var sub = document.getElementById('sos-failmode-sub');
    if (!grid) return;
    destroyAll();
    currentUnit = unit;

    if (sub) sub.textContent = buildSubText(unit);

    var desc = document.getElementById('sos-failmode-desc');
    var modes = visibleModes(unit);
    if (!modes.length) {
      grid.innerHTML = '<p class="sfm-empty">Tidak ada failure mode yang dapat dinilai — ' +
        'sampel terakhir kompartemen ini tidak memuat parameter bukti yang diperlukan.</p>';
      if (desc) desc.innerHTML = '';
      return;
    }
    grid.innerHTML = modes.map(cardHtml).join('');
    if (desc) desc.innerHTML = descriptionHtml(modes);

    var fam = document.getElementById('sos-failmode-family');
    if (fam) fam.textContent = 'Keluarga: ' + familyOf(unit.component) +
      ' • ' + modes.length + ' mode dinilai';
  }

  /** Buka panel untuk (assetId, component). */
  function open(assetId, component) {
    var store = global.SOS_STORE;
    if (!store || !store.getUnit) return;
    var unit = store.getUnit(assetId, component);
    if (!unit) return;
    render(unit);
    if (global.SOS_RENDER && global.SOS_RENDER.showView) {
      global.SOS_RENDER.showView('failmode');
    }
  }

  function close() {
    destroyAll();
    currentUnit = null;
    if (global.SOS_RENDER && global.SOS_RENDER.showView) {
      global.SOS_RENDER.showView('fleet');
    }
  }

  /* ------------------------------------------------------------------------
   * [ADD 2026-10-19] COPY IMAGE / EXPORT PDF — paritas dengan VHMS failure mode.
   * ----------------------------------------------------------------------
   * BEDA PENTING dari VHMS: kartu SOS BUKAN canvas Chart.js, melainkan HTML
   * (bar bukti + badge). Karena itu citra disusun ulang secara programatis
   * di <canvas>: judul -> sub -> kartu (badge, meta, bar bukti) -> Result
   * Description. Pendekatan ini sama dengan yang sudah dipakai untuk blok
   * teks di `vhms-failmode.js` (tanpa html2canvas) — nol dependensi tambahan.
   * --------------------------------------------------------------------- */

  function _bandColor(band) {
    if (band === 'CRITICAL') return { bar: '#ef4444', text: '#fecaca', bg: 'rgba(239,68,68,.10)' };
    if (band === 'CAUTION') return { bar: '#f59e0b', text: '#fde68a', bg: 'rgba(245,158,11,.10)' };
    return { bar: '#10b981', text: '#bbf7d0', bg: 'rgba(16,185,129,.10)' };
  }

  /** Bungkus teks (manual) sesuai lebar; mengembalikan array baris. */
  function _wrapText(ctx, text, maxW) {
    var words = String(text || '').split(/\s+/);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW) {
        if (cur) lines.push(cur);
        cur = words[i];
      } else { cur = test; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /** Potong teks dengan elipsis bila melebihi maxW. */
  function _ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /**
   * Susun citra ringkasan SOS ke satu canvas.
   * [REVISI 2026-10-19] Layout GRID 3 KOLOM, meniru persis `.sfm-grid` di web
   * (`grid-template-columns: repeat(3, 1fr)`, gap 14px, tinggi baris = kartu
   * TERTINGGI pada baris itu). Grid memakai tinggi baris sama rata (seperti
   * CSS Grid default `stretch`) sehingga tampak rapi seperti di layar.
   * @param {number} [exportScale] skala resolusi (default 2 → tajam saat di-share)
   * @returns {HTMLCanvasElement|null}
   */
  function composeImage(exportScale) {
    var grid = document.getElementById('sos-failmode-grid');
    var unit = currentUnit;
    if (!grid || !unit) return null;

    var modes = visibleModes(unit);
    if (!modes.length) return null;

    var S = exportScale || 2;          // supersampling agar teks tajam
    var PAD = 20, GAP = 14, CARD_PAD = 12, LINE = 15, BAR_H = 5;
    var COLS = 3;                       // sama dengan `.sfm-grid` web

    // Lebar disamakan dengan grid di layar agar proporsi teks/bar identik.
    // Bila grid belum terlihat (lebar 0), pakai lebar default 3 kolom.
    var W = Math.round(grid.getBoundingClientRect().width) || 1140;
    if (W < 900) W = 1140;              // paksa muat 3 kolom saat ekspor
    var innerW = W - PAD * 2;
    var cardW = (innerW - GAP * (COLS - 1)) / COLS;

    // Kanvas ukur untuk menghitung tinggi blok sebelum menggambar.
    var probe = document.createElement('canvas');
    var pctx = probe.getContext('2d');

    // ---- Hitung tinggi setiap kartu (untuk lebar kolom yang SEMPIT) -------
    var cards = modes.map(function (r) {
      var evH = r.items.length * 18;
      var extra = 0;
      if (r.recurrence) extra += 16;
      if (r.gated) extra += 16;
      if (r.ratio !== null && r.ratio !== undefined) extra += 16;
      var txW = cardW - CARD_PAD * 2 - 4;   // lebar dalam kartu
      pctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      var whyLines = _wrapText(pctx, r.why, txW).length;
      // Badge dapat menumpuk ke baris 2 bila judul panjang → beri 2 baris judul.
      pctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, sans-serif';
      var titleLines = _wrapText(pctx, r.title, txW - 74).length;
      var h = CARD_PAD * 2 + titleLines * 17 + 6 + whyLines * LINE + 16 + extra + evH;
      return { r: r, h: h, whyLines: whyLines, titleLines: titleLines, extra: extra, evH: evH };
    });

    // ---- Bagi ke baris grid; tinggi baris = kartu TERTINGGI --------------
    var rows = [];
    for (var ci = 0; ci < cards.length; ci += COLS) {
      var chunk = cards.slice(ci, ci + COLS);
      var rowH = chunk.reduce(function (m, c) { return Math.max(m, c.h); }, 0);
      rows.push({ cards: chunk, h: rowH });
    }

    // ---- Result description (wrapped selebar konten) ---------------------
    var descText = '';
    var d = buildDescription(modes);
    var descEl = document.getElementById('sos-failmode-desc');
    if (d) {
      var bodyEl = descEl ? descEl.querySelector('.sfm-desc-body') : null;
      descText = bodyEl ? bodyEl.textContent.trim() : String(d.text || '').replace(/<[^>]+>/g, '');
    } else if (descEl) {
      var okBody = descEl.querySelector('.sfm-desc-body');
      descText = okBody ? okBody.textContent.trim() : '';
    }
    pctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    var descLines = descText ? _wrapText(pctx, descText, innerW - 24) : [];

    // ---- Header ----------------------------------------------------------
    var titleEl = document.querySelector('#sos-failmode-panel .panel-title');
    var subEl = document.getElementById('sos-failmode-sub');
    var famEl = document.getElementById('sos-failmode-family');
    var HEAD = 74;

    var gridH = rows.reduce(function (a, rw) { return a + rw.h + GAP; }, 0);
    var descH = descLines.length ? (36 + descLines.length * LINE + 22) : 0;
    var totalH = PAD + HEAD + gridH + descH + PAD;

    var out = document.createElement('canvas');
    out.width = Math.round(W * S);
    out.height = Math.round(totalH * S);
    var ctx = out.getContext('2d');
    ctx.scale(S, S);
    ctx.textBaseline = 'top';

    // Latar
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, totalH);

    // ---- Header ----------------------------------------------------------
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText((titleEl && titleEl.textContent.trim()) || 'Failure Mode Summary - SOS', PAD, PAD);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText((subEl && subEl.textContent.trim()) || '', PAD, PAD + 24);
    ctx.fillStyle = '#64748b';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText((famEl && famEl.textContent.trim()) || '', PAD, PAD + 42);

    // ---- Gambar satu kartu -------------------------------------------------
    function drawCard(c, x, y, h) {
      var r = c.r, col = _bandColor(r.band);

      // Latar kartu + pita kiri (band)
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(x, y, cardW, h);
      ctx.fillStyle = col.bar;
      ctx.fillRect(x, y, 3, h);

      var ix = x + CARD_PAD + 4;
      var iw = cardW - CARD_PAD * 2 - 4;
      var rightX = x + cardW - CARD_PAD;
      var cy = y + CARD_PAD;

      // Badge (hitung dulu agar judul dapat ruang yang benar)
      ctx.font = 'bold 9.5px system-ui, -apple-system, Segoe UI, sans-serif';
      var bw = ctx.measureText(r.band).width + 12;
      var badgeX = rightX - bw;

      // Judul — dibungkus, tidak boleh menimpa badge
      ctx.font = 'bold 12.5px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      _wrapText(ctx, r.title, iw - bw - 8).forEach(function (ln, i) {
        ctx.fillText(ln, ix, cy + i * 17);
      });
      ctx.fillStyle = col.bg;
      ctx.fillRect(badgeX, cy, bw, 15);
      ctx.fillStyle = col.text;
      ctx.fillText(r.band, badgeX + 6, cy + 3);
      cy += c.titleLines * 17 + 6;

      // "why" — alasan (dibungkus)
      ctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = '#94a3b8';
      _wrapText(ctx, r.why, iw).forEach(function (ln) {
        ctx.fillText(_ellipsize(ctx, ln, iw), ix, cy);
        cy += LINE;
      });
      cy += 2;

      // Meta: Korelasi / Skor / [Laju] / Keyakinan — dibungkus (kolom sempit)
      ctx.fillStyle = '#7dd3fc';
      ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
      var metaParts = ['Korelasi ' + Math.round(r.evidence * 100) + '%', 'Skor ' + r.score];
      if (r.trend > 0 && hist) metaParts.push('Laju ' + (r.trend * 100).toFixed(0) + '%');
      metaParts.push(r.confidence);
      var mline = '', my = cy;
      metaParts.forEach(function (p) {
        var test = mline ? mline + '  ·  ' + p : p;
        if (ctx.measureText(test).width > iw) { ctx.fillText(mline, ix, my); my += 14; mline = p; }
        else mline = test;
      });
      if (mline) { ctx.fillText(mline, ix, my); my += 14; }
      cy = Math.max(cy + 15, my);

      // Baris tambahan (recurrence / gate / ratio)
      var extraTxt = [];
      if (r.recurrence) extraTxt.push('Berulang: ' + r.recurrence.count + ' episode — baru pulih');
      if (r.gated) extraTxt.push('Ditahan: korelasi belum terbentuk');
      if (r.ratio !== null && r.ratio !== undefined) extraTxt.push('PQI/Fe = ' + r.ratio.toFixed(2) + ' (ambang ' + r.ratioWarn + ')');
      if (extraTxt.length) {
        ctx.fillStyle = '#7dd3fc';
        ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
        extraTxt.forEach(function (t) { ctx.fillText(_ellipsize(ctx, t, iw), ix, cy); cy += 15; });
        cy += 1;
      }

      // Baris bukti: nama | nilai | bar | row100
      r.items.forEach(function (it) {
        var req = !!it.req;
        var sev = it.sev || 0;
        var barCol = sev >= 0.75 ? '#ef4444' : (sev >= 0.25 ? '#f59e0b' : '#10b981');

        // Lebar nama & nilai proporsional terhadap kolom sempit
        var nameMax = iw * 0.40;
        var valW = 46;

        ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.fillStyle = req ? '#e2e8f0' : '#94a3b8';
        var dot = req ? '● ' : '○ ';
        ctx.fillText(_ellipsize(ctx, dot + labelOf(it.key), nameMax), ix, cy);

        ctx.font = 'bold 10px Consolas, monospace';
        ctx.fillStyle = '#e2e8f0';
        var valX = ix + nameMax + 4;
        ctx.fillText(fmtVal(it.value, it.key), valX, cy);

        // Bar bullet
        var barX = valX + valW;
        var hasRow = (it.row100 !== null && it.row100 !== undefined && !isNaN(it.row100));
        var rowW = hasRow ? 34 : 0;
        var barW = (ix + iw) - barX - rowW;
        if (barW > 8) {
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(barX, cy + 5, barW, BAR_H);
          ctx.fillStyle = barCol;
          ctx.fillRect(barX, cy + 5, Math.max(0, Math.min(1, sev)) * barW, BAR_H);
        }

        // ROW100
        if (hasRow) {
          ctx.fillStyle = '#64748b';
          ctx.font = '9.5px Consolas, monospace';
          var sign = it.row100 > 0 ? '+' : '';
          ctx.fillText(sign + it.row100.toFixed(1), barX + barW + 4, cy);
        }
        cy += 18;
      });
    }

    // ---- Grid 3 kolom ------------------------------------------------------
    var y = PAD + HEAD;
    rows.forEach(function (rw) {
      rw.cards.forEach(function (c, col) {
        var x = PAD + col * (cardW + GAP);
        drawCard(c, x, y, rw.h);
      });
      y += rw.h + GAP;
    });

    // ---- Result Description ----------------------------------------------
    if (descLines.length) {
      var bandCls = d && d.crit.length ? 'crit' : (d && d.caut.length ? 'caut' : 'ok');
      var bandCol = bandCls === 'crit' ? '#ef4444' : (bandCls === 'caut' ? '#f59e0b' : '#22c55e');
      var bh = 36 + descLines.length * LINE + 22;
      ctx.fillStyle = 'rgba(15,23,42,.55)';
      ctx.fillRect(PAD, y, innerW, bh);
      ctx.fillStyle = bandCol;
      ctx.fillRect(PAD, y, 3, bh);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText('Result Description', PAD + 12, y + 12);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      var ty = y + 34;
      descLines.forEach(function (ln) { ctx.fillText(ln, PAD + 12, ty); ty += LINE; });
    }

    return out;
  }

  /** Umpan balik ringkas; memakai toast app bila tersedia. */
  function _notify(msg, type) {
    if (global.SOS_APP && global.SOS_APP.toast) { global.SOS_APP.toast(msg, type); return; }
    if (global.VHMS_APP && global.VHMS_APP.toast) { global.VHMS_APP.toast(msg, type); return; }
    if (type === 'err') console.error(msg); else console.log(msg);
  }

  /** Nama berkas dasar untuk unduhan. */
  function exportBaseName() {
    var u = currentUnit;
    if (!u) return 'FailureMode-SOS';
    var parts = ['FailureMode-SOS'];
    if (u.asset_id) parts.push(String(u.asset_id));
    if (u.component) parts.push(String(u.component));
    return parts.join('_').replace(/[\/\\:*?"<>|]/g, '-');
  }

  /**
   * Salin citra ke clipboard. `navigator.clipboard.write` butuh konteks aman
   * (https/localhost); saat dibuka lewat `file://` tidak tersedia — karena itu
   * ada jalur cadangan MENGUNDUH PNG, bukan gagal diam-diam.
   */
  function copyImage() {
    var canvas = composeImage(2);
    if (!canvas) { _notify('Tidak ada ringkasan untuk disalin.', 'err'); return; }

    function fallbackDownload(reason) {
      canvas.toBlob(function (blob) {
        if (!blob) { _notify('Gagal membuat gambar.', 'err'); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = exportBaseName() + '.png';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        _notify(reason + ' — gambar diunduh sebagai PNG.', 'info');
      }, 'image/png');
    }

    var hasClip = global.navigator && navigator.clipboard && navigator.clipboard.write &&
                  global.ClipboardItem;
    if (!hasClip) { fallbackDownload('Clipboard tidak tersedia'); return; }

    canvas.toBlob(function (blob) {
      if (!blob) { _notify('Gagal membuat gambar.', 'err'); return; }
      try {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          .then(function () { _notify('Gambar ringkasan disalin ke clipboard.', 'info'); })
          .catch(function () { fallbackDownload('Izin clipboard ditolak'); });
      } catch (e) { fallbackDownload('Clipboard gagal'); }
    }, 'image/png');
  }

  /** Ekspor citra ke PDF satu halaman (tanpa dependensi; pakai print). */
  function exportPdf() {
    var canvas = composeImage(2);
    if (!canvas) { _notify('Tidak ada ringkasan untuk diekspor.', 'err'); return; }
    var img = canvas.toDataURL('image/png');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' +
      exportBaseName() + '</title><style>' +
      '@page{size:A4;margin:10mm}body{margin:0;font-family:system-ui,sans-serif}' +
      'img{width:100%;height:auto;display:block}' +
      '</style></head><body><img src="' + img + '"></body></html>';

    // Bila ada jendela cetak (browser) — buka & picu print.
    if (global.open) {
      var w = global.open('', '_blank');
      if (w && w.document) {
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(function () { try { w.print(); } catch (e) {} }, 350);
        return;
      }
    }
    // Fallback: unduh PNG (bisa dikonversi/dicetak manual).
    var a = document.createElement('a');
    a.href = img;
    a.download = exportBaseName() + '.png';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 1000);
    _notify('Jendela cetak tidak tersedia — gambar diunduh sebagai PNG.', 'info');
  }

  /* ------------------------------------------------------------------------
   * Export
   * ---------------------------------------------------------------------- */
  global.SOS_FAILMODE = {
    // UI
    open: open,
    close: close,
    render: render,
    getCurrentUnit: function () { return currentUnit; },
    // [ADD 2026-10-19] Paritas dengan VHMS failure mode.
    composeImage: composeImage,
    copyImage: copyImage,
    exportPdf: exportPdf,
    exportBaseName: exportBaseName,
    // Murni (diuji di test-suite)
    FAILURE_MODES: FAILURE_MODES,
    FAMILY_PATTERNS: FAMILY_PATTERNS,
    FAMILY_FALLBACK: FAMILY_FALLBACK,
    PQI_RATIO_WARN: PQI_RATIO_WARN,
    buildDescription: buildDescription,
    familyOf: familyOf,
    pqiRatio: pqiRatio,
    pqiRatioWarn: pqiRatioWarn,
    severityOf: severityOf,
    additiveShift: additiveShift,
    displayMode: displayMode,
    modeScore: modeScore,
    visibleModes: visibleModes,
    buildSubText: buildSubText
  };

})(typeof window !== 'undefined' ? window : this);

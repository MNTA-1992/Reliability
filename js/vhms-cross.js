/* =========================================================================
 * vhms-cross.js
 * -------------------------------------------------------------------------
 * [CROSS ANALYSIS] Modul penghubung data VHMS (telemetri mekanikal/thermal)
 * dengan SOS (analisa kimia/keausan oli) untuk satu unit yang sama.
 *
 * TUJUAN
 *   Memberi analisa korelasi lintas-sumber: sinyal VHMS + sinyal SOS yang
 *   bergerak bersamaan mengindikasikan akar masalah (root cause) yang tidak
 *   terlihat dari satu sumber saja.
 *
 * PENGHUBUNG (LINKAGE)
 *   VHMS.meta.serial      ─┐
 *   SOS.asset_serial      ─┼─► VHMS_UNITDB.getLambung()  ─► kunci: Nomor Lambung
 *   SOS.asset_id          ─┘    (fallback: normalisasi SN / asset_id)
 *
 * PRINSIP (mengikuti aturan project)
 *   - SUMBER KEBENARAN nama parameter: PARAMS (VHMS) & SOS_CONFIG.PARAMS (SOS).
 *   - Peta pasangan parameter DIKURASI MANUAL (rekomendasi engineering),
 *     dapat ditambah/diubah pada CURATED_PAIRS di bawah.
 *   - Parameter yang tidak ada datanya → dilewati (bukan error).
 *
 * METODOLOGI
 *   1. Ambil titik sampel SOS (punya meter HM) sebagai "titik korelasi".
 *   2. Interpolasi nilai VHMS pada meter/SMR titik SOS (linear).
 *   3. Normalisasi tiap parameter 0..1 relatif threshold masing-masing.
 *   4. Hitung Pearson r pada pasangan terkurasi + label kepercayaan
 *      (n titik & kelengkapan data).
 * ========================================================================= */

(function (global) {
  'use strict';

  var vcfg = global.VHMS_CONFIG;
  var scfg = global.SOS_CONFIG;

  /* -----------------------------------------------------------------------
   * 1. PETA KURASI PASANGAN PARAMETER VHMS <-> SOS
   * ---------------------------------------------------------------------
   * Setiap entri: { vhms, sos, hypothesis, pillar, weight }
   *  - vhms      : key parameter VHMS (vhms-config PARAMS)
   *  - sos       : key parameter SOS (sos-config PARAMS)
   *  - hypothesis: penjelasan engineering bila keduanya naik bersamaan
   *  - pillar    : pilar/kompartemen untuk agregasi
   *  - weight    : bobot kepentingan (untuk skor prioritas fleet)
   * --------------------------------------------------------------------- */
  var CURATED_PAIRS = [
    { vhms: 'blowbyMax',      sos: 'wear_fe',   pillar: 'ENGINE',    weight: 1.0,
      hypothesis: 'Blowby tinggi + besi (Fe) naik → keausan piston ring / cylinder liner' },
    // [PELUMASAN] Blowby = gejala kompresi bocor / pelumasan buruk. Selain Fe & Si,
    // kontaminan Na (coolant leak) & aditif TBN yang terkuras juga dapat
    // memperburuk pelumasan dan menaikkan blowby.
    { vhms: 'blowbyMax',      sos: 'additive_na', pillar: 'ENGINE',  weight: 0.9,
      hypothesis: 'Blowby tinggi + sodium (Na) naik → kontaminasi coolant/eksternal merusak oli, pelumasan menurun' },
    { vhms: 'blowbyMax',      sos: 'tbn',       pillar: 'ENGINE',    weight: 0.7,
      hypothesis: 'Blowby tinggi + TBN turun → aditif oli terkuras, kemampuan pelumasan menurun' },
    { vhms: 'oilPressHMin',   sos: 'wear_cu',   pillar: 'ENGINE',    weight: 0.9,
      hypothesis: 'Tekanan oli turun + tembaga (Cu) naik → keausan bearing/bushing mesin' },
    { vhms: 'oilPressHMin',   sos: 'wear_pb',   pillar: 'ENGINE',    weight: 0.8,
      hypothesis: 'Tekanan oli turun + timbal (Pb) naik → keausan bearing (overlay)' },
    { vhms: 'engOilTemp',     sos: 'oxidation', pillar: 'ENGINE',    weight: 0.8,
      hypothesis: 'Suhu oli mesin tinggi + oksidasi naik → degradasi oli dipercepat' },
    { vhms: 'engOilTemp',     sos: 'tbn',       pillar: 'ENGINE',    weight: 0.7,
      hypothesis: 'Suhu oli tinggi + TBN turun → aditif terpakai/oli menua' },
    { vhms: 'coolantTemp',    sos: 'water_pct', pillar: 'COOLING',   weight: 0.9,
      hypothesis: 'Suhu coolant tinggi + air (water) di oli → kebocoran cooling/gasket' },
    { vhms: 'coolantTemp',    sos: 'wear_si',   pillar: 'COOLING',   weight: 0.7,
      hypothesis: 'Overheat + silikon (Si) naik → dirt ingression / pasir masuk' },
    { vhms: 'hydTempMax',     sos: 'wear_cu',   pillar: 'HYDRAULIC', weight: 0.9,
      hypothesis: 'Suhu hidrolik tinggi + tembaga (Cu) naik → keausan bushing/pompa' },
    { vhms: 'hydTempMax',     sos: 'wear_sn',   pillar: 'HYDRAULIC', weight: 0.7,
      hypothesis: 'Suhu hidrolik tinggi + timah (Sn) naik → keausan lapisan bearing' },
    { vhms: 'tcOilTempMax',   sos: 'wear_cu',   pillar: 'POWERTRAIN', weight: 0.9,
      hypothesis: 'Suhu torque converter tinggi + tembaga (Cu) naik → keausan konverter/transmisi' },
    { vhms: 'tmMainPressMax', sos: 'wear_cu',   pillar: 'POWERTRAIN', weight: 0.8,
      hypothesis: 'Tekanan transmisi turun + tembaga (Cu) naik → keausan internal transmisi' },
    { vhms: 'largePumpPress', sos: 'wear_cu',   pillar: 'HYDRAULIC', weight: 0.7,
      hypothesis: 'Tekanan pompa hidrolik turun + tembaga (Cu) naik → keausan pompa' },
    { vhms: 'blowbyMax',      sos: 'wear_si',   pillar: 'ENGINE',    weight: 0.8,
      hypothesis: 'Blowby tinggi + silikon (Si) naik → dirt ingression lewat intake' },
    { vhms: 'fuelRate',       sos: 'fuel_pct',  pillar: 'ECONOMY',   weight: 0.7,
      hypothesis: 'Konsumsi BBM tinggi + dilusi fuel → injektor/bahan bakar bermasalah' },
    { vhms: 'boostMax',       sos: 'wear_si',   pillar: 'ENGINE',    weight: 0.6,
      hypothesis: 'Boost tinggi + silikon (Si) naik → kebocoran jalur intake (debu masuk)' }
  ];

  /* -----------------------------------------------------------------------
   * 2. Penghubung unit VHMS <-> SOS
   * --------------------------------------------------------------------- */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()]+/g, '').trim();
  }

  /** Nomor Lambung efektif untuk sebuah unit SOS (asset_id sudah lambung bila ada). */
  function sosLambung(sosUnit) {
    var asset = sosUnit.assetId || (sosUnit.latest && sosUnit.latest.asset_id) || '';
    var serial = sosUnit.serial || (sosUnit.latest && sosUnit.latest.asset_serial) || '';
    var db = global.VHMS_UNITDB;
    // Bila asset BUKAN lambung (mis. SN), coba resolve dari serial.
    if (db && db.getLambung && serial) {
      var viaSerial = db.getLambung(serial);
      if (viaSerial) return viaSerial;
    }
    return asset;
  }

  /**
   * Bangun indeks unit SOS: key -> array unit SOS (per kompartemen).
   * Key dicoba berlapis: nomor lambung, asset_id, asset_serial (semua dinorm).
   */
  function buildSosIndex() {
    var store = global.SOS_STORE;
    var idx = {};
    if (!store) return idx;
    store.getAllUnits().forEach(function (u) {
      var asset = u.assetId || (u.latest && u.latest.asset_id) || '';
      var serial = u.serial || (u.latest && u.latest.asset_serial) || '';
      var keys = [];
      var lb = sosLambung(u);
      if (lb) keys.push(norm(lb));
      if (asset) keys.push(norm(asset));
      if (serial) keys.push(norm(serial));
      keys.forEach(function (k) {
        if (!k) return;
        if (!idx[k]) idx[k] = [];
        if (idx[k].indexOf(u) === -1) idx[k].push(u);
      });
    });
    return idx;
  }

  /** Cari unit-unit SOS yang cocok untuk sebuah summaryRow VHMS. */
  function matchSos(summaryRow, sosIndex) {
    var db = global.VHMS_UNITDB;
    var candidates = [];
    if (summaryRow.lambung) candidates.push(norm(summaryRow.lambung));
    if (summaryRow.serial) candidates.push(norm(summaryRow.serial));
    // Via Database Unit (SN -> lambung)
    if (db && db.getLambung && summaryRow.serial) {
      var lb = db.getLambung(summaryRow.serial);
      if (lb) candidates.push(norm(lb));
    }
    for (var i = 0; i < candidates.length; i++) {
      var hit = sosIndex[candidates[i]];
      if (hit && hit.length) return hit;
    }
    return [];
  }

  /* -----------------------------------------------------------------------
   * 3. Utilitas numerik
   * --------------------------------------------------------------------- */
  function num(v) {
    if (v === null || v === undefined || isNaN(v)) return null;
    return typeof v === 'number' ? v : (parseFloat(v));
  }

  /**
   * Interpolasi linear nilai VHMS pada SUMBU target.
   * @param {object[]} records  record VHMS
   * @param {string}   paramKey key parameter
   * @param {number}   target   nilai sumbu target (HM atau epoch ms)
   * @param {function} [axisOf] ambil sumbu dari record (default: SMR/HM)
   */
  function interpVhms(records, paramKey, target, axisOf) {
    if (!records || !records.length) return null;
    var getAxis = axisOf || function (r) { return num(r.smr); };
    var pts = [];
    for (var i = 0; i < records.length; i++) {
      var v = num(records[i][paramKey]);
      var s = getAxis(records[i]);
      if (v !== null && s !== null) pts.push({ s: s, v: v });
    }
    if (!pts.length) return null;
    pts.sort(function (a, b) { return a.s - b.s; });
    if (target <= pts[0].s) return pts[0].v;
    if (target >= pts[pts.length - 1].s) return pts[pts.length - 1].v;
    for (var j = 0; j < pts.length - 1; j++) {
      var a = pts[j], b = pts[j + 1];
      if (target >= a.s && target <= b.s) {
        if (b.s === a.s) return b.v;
        var t = (target - a.s) / (b.s - a.s);
        return a.v + t * (b.v - a.v);
      }
    }
    return pts[pts.length - 1].v;
  }

  /** Normalisasi 0..1 relatif threshold (makin tinggi = makin buruk). */
  function normVhms(value, th) {
    if (value === null || !th) return null;
    var warn = th.warn, crit = th.crit;
    if (th.mode === 'low') {
      // makin KECIL makin buruk
      if (value >= warn) return 0;
      if (value <= crit) return 1;
      return (warn - value) / Math.max(1e-9, (warn - crit));
    }
    if (value <= warn) return 0;
    if (value >= crit) return 1;
    return (value - warn) / Math.max(1e-9, (crit - warn));
  }

  /** Normalisasi SOS 0..1 relatif threshold kompartemen. */
  function normSos(value, th) {
    if (value === null || !th) return null;
    var warn = (th.warn !== undefined) ? th.warn : th.warn_high;
    var crit = (th.crit !== undefined) ? th.crit : th.crit_high;
    var isLow = (th.warn_low !== undefined || th.crit_low !== undefined);
    // [FIX] Parameter mode-LOW murni (mis. TBN: hanya warn_low/crit_low):
    // nilai di ATAS warn_low berarti SEHAT -> normalisasi 0 (bukan null).
    // Sebelumnya nilai sehat ini mengembalikan null sehingga titik data
    // terbuang sia-sia dan korelasi kehilangan banyak sampel.
    if (isLow) {
      var wl = (th.warn_low !== undefined) ? th.warn_low : th.crit_low;
      var cl = (th.crit_low !== undefined) ? th.crit_low : (th.warn_low !== undefined ? th.warn_low * 0.5 : th.crit_low * 0.5);
      if (value >= wl) return 0;                 // masih aman
      if (value <= cl) return 1;                 // kritis
      return (wl - value) / Math.max(1e-9, (wl - cl));
    }
    if (warn === undefined || crit === undefined) return null;
    if (value <= warn) return 0;
    if (value >= crit) return 1;
    return (value - warn) / Math.max(1e-9, (crit - warn));
  }

  /** Pearson r antara dua deret (abaikan pasangan null). */
  function pearson(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (var i = 0; i < xs.length; i++) {
      var x = xs[i], y = ys[i];
      if (x === null || y === null || isNaN(x) || isNaN(y)) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < 3) return { r: null, n: n };
    var denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    if (denom < 1e-12) return { r: null, n: n };
    return { r: (n * sxy - sx * sy) / denom, n: n };
  }

  /** Normalisasi min-max 0..1 sebuah deret (null dibiarkan null). */
  function minmax(arr) {
    var vals = arr.filter(function (v) { return v !== null && !isNaN(v); });
    if (!vals.length) return arr.map(function () { return null; });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var span = mx - mn;
    if (span < 1e-12) return arr.map(function (v) { return v === null ? null : 0.5; });
    return arr.map(function (v) { return (v === null || isNaN(v)) ? null : (v - mn) / span; });
  }

  /** Apakah deret (tanpa null) memiliki variasi? */
  function isConstant(arr) {
    var vals = arr.filter(function (v) { return v !== null && !isNaN(v); });
    if (vals.length < 2) return true;
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    return (mx - mn) < 1e-9;
  }

  /** Rentang (max-margin) deret tanpa null; 0 bila tidak ada data. */
  function spread(arr) {
    var vals = arr.filter(function (v) { return v !== null && !isNaN(v); });
    if (vals.length < 2) return 0;
    return Math.max.apply(null, vals) - Math.min.apply(null, vals);
  }

  /* -----------------------------------------------------------------------
   * 3b. ACUAN WAKTU (TIME BASE)
   * ---------------------------------------------------------------------
   * Korelasi VHMS <-> SOS butuh "sumbu" yang bisa dibandingkan:
   *   - 'hm'   : jam meter (HM Unit VHMS vs HM Unit/Oil SOS) — paling akurat
   *              secara mekanikal (keausan vs jam operasi).
   *   - 'date' : tanggal (epoch ms). Dipakai bila SOS TIDAK punya HM.
   *   - 'auto' : coba 'hm' dulu; bila titik valid < MIN, jatuh ke 'date'.
   * --------------------------------------------------------------------- */

  /** Epoch (ms) dari Calendar VHMS (calendar.epoch detik + tzOffset). */
  function recordTime(rec) {
    if (!rec || !rec.calendar) return null;
    var c = rec.calendar;
    if (c.date && !isNaN(c.date.getTime())) return c.date.getTime();
    if (c.epoch) return (c.epoch + (c.tzOffsetSec || 0)) * 1000;
    return null;
  }

  /** Epoch (ms) dari sampel SOS (_date). */
  function sampleTime(s) {
    if (!s) return null;
    if (s._date) {
      var t = (s._date instanceof Date) ? s._date.getTime() : new Date(s._date).getTime();
      if (!isNaN(t)) return t;
    }
    if (s.sampled_date) return new Date(s.sampled_date).getTime();
    return null;
  }

  /** HM Unit (jam mesin) sebuah sampel SOS; fallback _hm (hm_oil). */
  function sampleMeter(s) {
    var hu = num(s.hm_unit);
    if (hu !== null && hu > 0) return hu;
    var hm = num(s._hm);
    return (hm !== null && hm > 0) ? hm : null;
  }

  /**
   * Pilih acuan waktu terbaik untuk sebuah unit SOS.
   * @returns {{ base:'hm'|'date', reason:string }}
   */
  function pickTimeBase(samples, minN) {
    minN = minN || 3;
    var nHm = 0, nDate = 0;
    (samples || []).forEach(function (s) {
      if (sampleMeter(s) !== null) nHm++;
      if (sampleTime(s) !== null) nDate++;
    });
    if (nHm >= minN) return { base: 'hm', reason: 'HM tersedia (' + nHm + ' titik)' };
    if (nDate >= minN) {
      return { base: 'date', reason: nHm > 0
        ? 'HM hanya ' + nHm + ' titik -> memakai tanggal'
        : 'SOS tanpa HM -> memakai tanggal' };
    }
    return { base: nDate >= nHm ? 'date' : 'hm', reason: 'data terbatas' };
  }

  /**
   * [FITUR FALLBACK] Evaluasi KEDUA acuan sumbu (HM & Tanggal) dan pilih yang
   * paling banyak menghasilkan TITIK TUMPANG-TINDIH dengan rentang VHMS.
   * Ini mengatasi kasus "HM VHMS berbeda dgn HM SOS" sehingga chart korelasi
   * tetap bisa dibentuk dengan acuan tanggal.
   *
   * @param {object} vhmsAnalysis  hasil analisa VHMS (punya records)
   * @param {object} sosUnit       unit SOS
   * @param {number} [minN]        minimum titik agar acuan dianggap layak
   * @returns {{ base, reason, trigger:boolean, evaluated:{hm,date}, suggest }}
   */
  function autoTimeBase(vhmsAnalysis, sosUnit, minN) {
    minN = minN || 4;
    var records = (vhmsAnalysis && vhmsAnalysis.records) || [];
    var samples = (sosUnit && sosUnit.samples) || [];

    function evalBase(base) {
      var sosAxisOf = (base === 'date')
        ? function (s) { return sampleTime(s); }
        : function (s) { return sampleMeter(s); };
      var vhmsAxisOf = (base === 'date')
        ? function (r) { return recordTime(r); }
        : function (r) { return num(r.smr); };
      var ptsAxis = samples
        .map(function (s) { return sosAxisOf(s); })
        .filter(function (m) { return m !== null && m !== undefined; })
        .sort(function (a, b) { return a - b; });
      var vAxis = records.map(vhmsAxisOf).filter(function (v) { return v !== null; });
      if (!vAxis.length || !ptsAxis.length) return { n: ptsAxis.length, overlap: 0, rangeSos: null, rangeVhms: null };
      var mn = Math.min.apply(null, vAxis), mx = Math.max.apply(null, vAxis);
      var overlap = ptsAxis.filter(function (m) { return m >= mn && m <= mx; }).length;
      return {
        n: ptsAxis.length, overlap: overlap,
        rangeSos: [ptsAxis[0], ptsAxis[ptsAxis.length - 1]], rangeVhms: [mn, mx]
      };
    }

    var hm = evalBase('hm');
    var date = evalBase('date');

    // Pilih base dengan overlap terbanyak; bila seri, utamakan yang punya
    // titik valid lebih banyak; terakhir utamakan 'hm' (lebih akurat mekanikal).
    var base;
    if (date.overlap > hm.overlap) base = 'date';
    else if (hm.overlap > date.overlap) base = 'hm';
    else base = (hm.n >= date.n) ? 'hm' : 'date';

    var trigger = (base === 'date');   // fallback aktif bila pindah ke tanggal
    var reason = trigger
      ? (hm.overlap < minN
          ? 'HM VHMS & SOS tidak tumpang-tindih -> memakai TANGGAL'
          : 'Tanggal memberi tumpang-tindih lebih baik')
      : 'HM cocok (' + hm.overlap + ' titik)';

    var suggest = null;
    if (hm.overlap < minN && date.overlap >= minN) suggest = 'date';
    else if (date.overlap < minN && hm.overlap >= minN) suggest = 'hm';

    return { base: base, reason: reason, trigger: trigger,
             evaluated: { hm: hm, date: date }, suggest: suggest, minN: minN };
  }

  /* -----------------------------------------------------------------------
   * 4. ANALISA SATU KOMPARTEMEN (VHMS unit <-> SOS unit)
   * --------------------------------------------------------------------- */
  /**
   * @param {object} vhmsAnalysis  hasil VHMS_ANALYTICS.analyze()
   * @param {object} sosUnit       salah satu unit dari SOS_STORE.getAllUnits()
   * @returns {object} hasil korelasi + titik plot
   */
  function analyzePair(vhmsAnalysis, sosUnit, opts) {
    opts = opts || {};
    var records = (vhmsAnalysis && vhmsAnalysis.records) || [];
    var samples = (sosUnit && sosUnit.samples) || [];
    var vth = (vhmsAnalysis && vhmsAnalysis.thresholdSet) || vcfg.THRESHOLDS;
    var sth = scfg.getThresholdsFor(sosUnit.component, sosUnit.model);

    // [ACUAN WAKTU] Pilih base: 'hm' (jam meter) atau 'date' (tanggal).
    // opts.timeBase: 'auto' (default) | 'hm' | 'date'
    var wantBase = opts.timeBase || 'auto';
    // [FITUR FALLBACK] Saat 'auto', gunakan autoTimeBase() yang mengevaluasi
    // KEDUA acuan (HM & Tanggal) dan memilih titik tumpang-tindih terbanyak.
    var base, baseReason, baseDiag = null;
    if (wantBase === 'auto') {
      var auto = autoTimeBase(vhmsAnalysis, sosUnit, 4);
      base = auto.base;
      baseReason = auto.reason;
      baseDiag = auto;
    } else {
      base = wantBase;
      baseReason = (base === 'date' ? 'manual: tanggal' : 'manual: HM');
    }

    // Accessor sumbu untuk titik SOS & interpolasi VHMS.
    var sosAxisOf = (base === 'date')
      ? function (s) { return sampleTime(s); }
      : function (s) { return sampleMeter(s); };
    var vhmsAxisOf = (base === 'date')
      ? function (r) { return recordTime(r); }
      : function (r) { return num(r.smr); };

    // Titik sampel SOS dengan sumbu valid → dipakai sebagai titik korelasi.
    var points = samples
      .map(function (s) { return { s: s, m: sosAxisOf(s) }; })
      .filter(function (o) { return o.m !== null && o.m !== undefined; })
      .sort(function (a, b) { return a.m - b.m; })
      .map(function (o) { o.s._crossAxis = o.m; return o.s; });

    // Rentang sumbu VHMS untuk validasi tumpang-tindih.
    var vhmsAxisVals = records.map(vhmsAxisOf).filter(function (v) { return v !== null; });
    var overlap = { any: false, warning: null, count: 0, total: points.length };
    if (vhmsAxisVals.length && points.length) {
      var mn = Math.min.apply(null, vhmsAxisVals), mx = Math.max.apply(null, vhmsAxisVals);
      var inRange = points.filter(function (s) { return s._crossAxis >= mn && s._crossAxis <= mx; });
      overlap.any = inRange.length > 0;
      overlap.count = inRange.length;
      if (!overlap.any) {
        var fmt = (base === 'date')
          ? function (t) { return new Date(t).toLocaleDateString('id-ID'); }
          : function (t) { return Math.round(t); };
        overlap.warning = 'Rentang ' + (base === 'date' ? 'tanggal' : 'SMR') + ' VHMS (' + fmt(mn) + '–' + fmt(mx) +
          ') tidak tumpang-tindih dengan ' + (base === 'date' ? 'tanggal' : 'HM') + ' SOS (' + fmt(points[0]._crossAxis) + '–' + fmt(points[points.length - 1]._crossAxis) + ').';
      }
    }

    // Deret VHMS (diinterpolasi ke tiap titik SOS) & deret SOS.
    var usedPairs = [];

    CURATED_PAIRS.forEach(function (pair) {
      // Hanya pasangan yang kompartemennya relevan (SOS kompartemen vs pilar VHMS)
      var xs = [], ys = [], xN = [], yN = [];
      var vDef = vcfg.PARAMS[pair.vhms] || {};
      var hasV = false, hasS = false;
      points.forEach(function (s) {
        var vVal = interpVhms(records, pair.vhms, s._crossAxis, vhmsAxisOf);
        var sVal = num(s[pair.sos]);
        if (vVal !== null) hasV = true;
        if (sVal !== null) hasS = true;
        xs.push(vVal); ys.push(sVal);
        xN.push(normVhms(vVal, vth[pair.vhms]));
        yN.push(normSos(sVal, sth[pair.sos]));
      });
      if (!hasV || !hasS) return;   // salah satu tidak punya data → lewati

      // Bila normalisasi-threshold tidak menghasilkan SEBARAN yang cukup
      // (param tanpa threshold / semua di bawah batas → deret hampir konstan),
      // fallback ke min-max deret agar scatter tetap menyebar & arah tren
      // terlihat (ditandai basis 'min-max').
      var xUse = xN, yUse = yN;
      var xVals = xN.filter(function (v) { return v !== null; });
      var yVals = yN.filter(function (v) { return v !== null; });
      var usedFallback = false;
      // Rentang (max-min) sangat kecil (< 0.05) dianggap tidak menyebar.
      if (xVals.length < 2 || yVals.length < 2 ||
          spread(xN) < 0.05 || spread(yN) < 0.05) {
        xUse = minmax(xs); yUse = minmax(ys); usedFallback = true;
      }

      var rNorm = pearson(xUse, yUse);
      var xConst = isConstant(xUse), yConst = isConstant(yUse);
      var rFinal = rNorm.r;
      var basis = usedFallback ? 'minmax' : 'threshold';
      var note = null;

      // Syarat minimal titik agar korelasi dianggap layak (hindari r palsu
      // dari 2-3 titik). n < MIN_N -> tandai tidak reliable.
      var MIN_N = 4;
      if (rFinal !== null && rNorm.n < MIN_N) {
        note = 'hanya ' + rNorm.n + ' titik — korelasi belum reliable (min ' + MIN_N + ')';
        rFinal = null;
        basis = null;
      }

      if (rFinal === null && !note) {
        if (xConst && yConst) note = 'Kedua parameter konstan pada jendela ini';
        else if (xConst) note = 'Parameter VHMS konstan (tidak ada variasi)';
        else if (yConst) note = 'Parameter SOS konstan (tidak ada variasi)';
        else note = 'Data tidak cukup untuk korelasi';
      }

      usedPairs.push({
        vhms: pair.vhms, sos: pair.sos, pillar: pair.pillar, weight: pair.weight,
        hypothesis: pair.hypothesis,
        vhmsLabel: vDef.label || pair.vhms,
        vhmsUnit: vDef.unit || '',
        sosLabel: (scfg.PARAMS[pair.sos] || {}).label || pair.sos,
        sosUnit: (scfg.PARAMS[pair.sos] || {}).unit || '',
        r: rFinal,
        n: rNorm.n,
        basis: basis,
        note: note,
        usedFallback: usedFallback,
        x: xUse, y: yUse,        // untuk scatter (0..1)
        xRaw: xs, yRaw: ys
      });
    });

    // Kepercayaan: berbasis jumlah titik & apakah tumpang-tindih SMR.
    var nPts = points.length;
    var confidence = (!overlap.any || nPts < 3) ? 'Rendah'
      : (nPts >= 6 ? 'Tinggi' : 'Sedang');

    // --- SKOR PRIORITAS (urgensi) -------------------------------------
    // Prinsip: STATUS KEPARAHAN menentukan level prioritas minimum,
    // kekuatan korelasi hanya MENGUATKAN (bukan menentukan).
    //   Tier SOS : 0 NORMAL, 1 MONITOR, 2 CRITICAL, 3 EXTREME
    //   Health VHMS: CRITICAL / WARNING / NORMAL
    // EXTREME -> wajib P1 (urgent), CRITICAL -> minimal P1/P2, dst.
    var maxR = 0;
    usedPairs.forEach(function (p) { if (p.r !== null && Math.abs(p.r) > maxR) maxR = Math.abs(p.r); });
    var sosSev = (sosUnit.mprs && sosUnit.mprs.tier) ? sosUnit.mprs.tier : 0;
    var vhmsSev = vhmsAnalysis && vhmsAnalysis.health
      ? (vhmsAnalysis.health.label === 'CRITICAL' ? 3 : (vhmsAnalysis.health.label === 'WARNING' ? 1.5 : 0)) : 0;

    // Skor keparahan gabungan (0..100): ambil yang tertinggi antara SOS & VHMS
    // lalu tambah kontribusi sumber kedua (bukan rata-rata) agar salah satu
    // yang EXTREME tetap mendominasi.
    var sevPct = Math.max(sosSev / 3 * 100, vhmsSev / 3 * 100);
    var secondPct = Math.min(sosSev / 3 * 100, vhmsSev / 3 * 100);
    var sevScore = Math.min(100, sevPct + secondPct * 0.15);
    // Korelasi sebagai penguat (maks +20 poin).
    var corrBoost = maxR * 20;
    var priority = Math.round(Math.min(100, sevScore + corrBoost) * 10) / 10;

    // Level prioritas MINIMUM dari status mentah (urgensi tidak boleh turun
    // hanya karena korelasi rendah).
    //   1 = P1 (Critical/Extreme), 2 = P2 (Warning/Monitor), 3 = P3 (Normal)
    var minLevel = 3;
    if (sosSev >= 2 || vhmsSev >= 3) minLevel = 1;               // CRITICAL/EXTREME -> P1
    else if (sosSev === 1 || vhmsSev >= 1.5) minLevel = 2;       // MONITOR/WARNING -> P2+
    else if (sosSev === 0 && vhmsSev === 0) minLevel = 3;

    usedPairs.sort(function (a, b) { return Math.abs(b.r || 0) - Math.abs(a.r || 0); });

    return {
      vhmsId: vhmsAnalysis ? vhmsAnalysis.meta.serial : null,
      sosAsset: sosUnit.assetId,
      component: sosUnit.component,
      sosModel: sosUnit.model,
      timeBase: base,               // 'hm' | 'date'
      baseReason: baseReason,
      baseDiag: baseDiag,           // [FITUR] evaluasi kedua acuan (fallback)
      points: points.map(function (s) {
        // Simpan snapshot nilai SOS pada titik ini agar timeline bisa memplot
        // beberapa parameter SOS sekaligus (multi-sumbu) tanpa akses ulang.
        var vals = {};
        Object.keys(scfg.PARAMS).forEach(function (pk) {
          var sv = num(s[pk]);
          if (sv !== null) vals[pk] = sv;
        });
        return { hm: (base === 'hm' ? s._crossAxis : s._crossMeter), axis: s._crossAxis,
                 date: s._dateStr, iso: s.iso_code, tier: s.risk_tier, vals: vals };
      }),
      pairs: usedPairs,
      confidence: confidence,
      overlap: overlap,
      maxR: Math.round(maxR * 100) / 100,
      priority: priority,
      minLevel: minLevel,           // 1=P1, 2=P2, 3=P3 (dari status keparahan)
      sosTier: sosSev,
      vhmsLabel: vhmsAnalysis && vhmsAnalysis.health ? vhmsAnalysis.health.label : '—',
      nPoints: nPts
    };
  }

  /* -----------------------------------------------------------------------
   * 5. OVERVIEW FLEET — semua unit yang terhubung VHMS <-> SOS
   * --------------------------------------------------------------------- */
  function buildFleet(opts) {
    opts = opts || {};
    var wantBase = opts.timeBase || 'auto';
    var store = global.VHMS_FLEET;
    if (!store) return { rows: [], linked: 0, total: 0, sosOnly: 0 };
    var sosIndex = buildSosIndex();
    var rows = [];
    var vhmsRows = store.rows();

    vhmsRows.forEach(function (r) {
      var sosUnits = matchSos(r, sosIndex);
      var analysis = store.getAnalysis(r.id);
      var perComp = [];
      var usable = [];
      sosUnits.forEach(function (u) {
        var res = analyzePair(analysis, u, { timeBase: wantBase });
        perComp.push(res);
        if (res.pairs && res.pairs.length) usable.push(res);
      });
      var best = null;
      usable.forEach(function (p) { if (!best || p.priority > best.priority) best = p; });
      // Level urgensi fleet = paling berat di antara seluruh kompartemen.
      var minLevel = 3;
      usable.forEach(function (p) { if (p.minLevel < minLevel) minLevel = p.minLevel; });
      rows.push({
        vhmsId: r.id,
        serial: r.serial,
        model: r.model,
        lambung: r.lambung,
        familyId: r.familyId,
        healthLabel: r.healthLabel,
        healthScore: r.healthScore,
        // Punya data SOS (tercocokkan) tapi mungkin belum tentu ada titik valid.
        matchedSos: perComp.length > 0,
        // linked = benar-benar ada pasangan parameter valid (bisa dibuka).
        linked: !!best,
        components: perComp,
        usable: usable,
        best: best,
        priority: best ? best.priority : 0,
        minLevel: minLevel,
        maxR: best ? best.maxR : 0,
        sosTier: best ? best.sosTier : null
      });
    });

    // Unit SOS yang tidak punya pasangan VHMS (untuk info)
    var linkedKeys = {};
    rows.forEach(function (r) { if (r.linked) linkedKeys[r.vhmsId] = true; });

    rows.sort(function (a, b) {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      // Utamakan URGENSI (status keparahan) dulu, baru skor prioritas.
      if (a.minLevel !== b.minLevel) return a.minLevel - b.minLevel;
      return b.priority - a.priority;
    });

    return {
      rows: rows,
      linked: rows.filter(function (r) { return r.linked; }).length,
      total: rows.length,
      sosUnitCount: global.SOS_STORE ? global.SOS_STORE.getAllUnits().length : 0
    };
  }

  /* -----------------------------------------------------------------------
   * 6. KORELASI DINAMIS (R sesuai seleksi parameter)
   * ---------------------------------------------------------------------
   * Menghitung Pearson r antara SATU parameter VHMS dan SATU parameter SOS
   * apa pun, pada titik-titik sampel SOS yang sama (acuan HM/tanggal).
   * Dipakai oleh Timeline gabungan agar nilai r berubah mengikuti pilihan
   * parameter SOS user (bukan hanya pasangan terkurasi).
   *
   * @param {object} vhmsAnalysis  hasil VHMS_ANALYTICS.analyze()
   * @param {object} sosUnit       unit SOS (sosUnit.samples[])
   * @param {string} vhmsKey       key parameter VHMS
   * @param {string} sosKey        key parameter SOS
   * @param {object} [opts]        { timeBase }
   * @returns {{ r:number|null, n:number, basis:string|null, note:string|null, xRaw:number[], yRaw:number[] }}
   */
  function pairCorrelation(vhmsAnalysis, sosUnit, vhmsKey, sosKey, opts) {
    opts = opts || {};
    var records = (vhmsAnalysis && vhmsAnalysis.records) || [];
    var samples = (sosUnit && sosUnit.samples) || [];
    var vth = (vhmsAnalysis && vhmsAnalysis.thresholdSet) || vcfg.THRESHOLDS;
    var sth = scfg.getThresholdsFor(sosUnit.component, sosUnit.model);

    var wantBase = opts.timeBase || 'hm';
    var picked = pickTimeBase(samples, 3);
    var base = (wantBase === 'auto') ? picked.base : wantBase;
    var sosAxisOf = (base === 'date')
      ? function (s) { return sampleTime(s); }
      : function (s) { return sampleMeter(s); };
    var vhmsAxisOf = (base === 'date')
      ? function (r) { return recordTime(r); }
      : function (r) { return num(r.smr); };

    var pts = samples
      .map(function (s) { return { s: s, m: sosAxisOf(s) }; })
      .filter(function (o) { return o.m !== null && o.m !== undefined; })
      .sort(function (a, b) { return a.m - b.m; });

    var xs = [], ys = [], xN = [], yN = [], hasV = false, hasS = false;
    pts.forEach(function (o) {
      var vVal = interpVhms(records, vhmsKey, o.m, vhmsAxisOf);
      var sVal = num(o.s[sosKey]);
      if (vVal !== null) hasV = true;
      if (sVal !== null) hasS = true;
      xs.push(vVal); ys.push(sVal);
      xN.push(normVhms(vVal, vth[vhmsKey]));
      yN.push(normSos(sVal, sth[sosKey]));
    });

    if (!hasV || !hasS) {
      return { r: null, n: 0, basis: null, note: 'Salah satu parameter tidak punya data pada rentang ini', xRaw: xs, yRaw: ys };
    }

    // Fallback min-max bila normalisasi-threshold tidak menyebar (sama seperti analyzePair).
    var xUse = xN, yUse = yN, usedFallback = false;
    var xVals = xN.filter(function (v) { return v !== null; });
    var yVals = yN.filter(function (v) { return v !== null; });
    if (xVals.length < 2 || yVals.length < 2 || spread(xN) < 0.05 || spread(yN) < 0.05) {
      xUse = minmax(xs); yUse = minmax(ys); usedFallback = true;
    }

    var res = pearson(xUse, yUse);
    var rFinal = res.r, basis = usedFallback ? 'minmax' : 'threshold', note = null;
    var MIN_N = 4;
    if (rFinal !== null && res.n < MIN_N) {
      note = 'hanya ' + res.n + ' titik — belum reliable (min ' + MIN_N + ')';
      rFinal = null; basis = null;
    }
    if (rFinal === null && !note) {
      if (isConstant(xUse) && isConstant(yUse)) note = 'Kedua parameter konstan';
      else if (isConstant(xUse)) note = 'Parameter VHMS konstan (tidak ada variasi)';
      else if (isConstant(yUse)) note = 'Parameter SOS konstan (tidak ada variasi)';
      else note = 'Data tidak cukup untuk korelasi';
    }
    return { r: rFinal, n: res.n, basis: basis, note: note, xRaw: xs, yRaw: ys, usedFallback: usedFallback };
  }

  /* -----------------------------------------------------------------------
   * 7. KORELASI BERGANDA (MULTIPLE) — 1 variabel Y vs 3 variabel X
   * ---------------------------------------------------------------------
   * Secara statistik: regresi linear berganda Y = b0 + b1·X1 + b2·X2 + b3·X3,
   * lalu dihitung KOEFISIEN KORELASI BERGANDA (multiple R) = akar dari
   * R^2 = 1 - SSres/SStot. Ini mengukur seberapa baik KOMBINASI X1..Xk
   * menjelaskan Y (bukan korelasi satu-satu).
   *
   * Input deret sudah dinormalisasi 0..1 (relatif threshold) agar satuan
   * antar-parameter setara, konsisten dengan pairCorrelation.
   *
   * @returns {{ R:number|null, R2:number|null, n:number, k:number,
   *             betas:number[]|null, perVar:array, note:string|null }}
   *   R  : koefisien korelasi berganda (0..1)
   *   R2 : koefisien determinasi
   *   betas : [b0, b1, b2, b3] (b0 = intersep)
   *   perVar: [{ key, r, note }] korelasi Pearson sederhana tiap X vs Y
   * --------------------------------------------------------------------- */
  function multipleCorrelation(vhmsAnalysis, sosUnit, vhmsKey, sosKeys, opts) {
    opts = opts || {};
    var records = (vhmsAnalysis && vhmsAnalysis.records) || [];
    var samples = (sosUnit && sosUnit.samples) || [];
    var vth = (vhmsAnalysis && vhmsAnalysis.thresholdSet) || vcfg.THRESHOLDS;
    var sth = scfg.getThresholdsFor(sosUnit.component, sosUnit.model);
    var xkeys = (sosKeys || []).slice(0, 3);   // maksimum 3 variabel X

    var wantBase = opts.timeBase || 'hm';
    var picked = pickTimeBase(samples, 3);
    var base = (wantBase === 'auto') ? picked.base : wantBase;
    var sosAxisOf = (base === 'date')
      ? function (s) { return sampleTime(s); }
      : function (s) { return sampleMeter(s); };
    var vhmsAxisOf = (base === 'date')
      ? function (r) { return recordTime(r); }
      : function (r) { return num(r.smr); };

    var pts = samples
      .map(function (s) { return { s: s, m: sosAxisOf(s) }; })
      .filter(function (o) { return o.m !== null && o.m !== undefined; })
      .sort(function (a, b) { return a.m - b.m; });

    // [FIX] Bangun deret pada GRID YANG SAMA tanpa menuntut semua X lengkap.
    // Tiap parameter SOS diinterpolasi linier di atas titik-titiknya sendiri,
    // lalu dievaluasi pada sumbu acuan sehingga parameter yang jadwal
    // sampling-nya jarang tetap punya nilai pada grid yang sama.
    function interpSeries(samples, key, axisOf, target) {
      var pts = [];
      for (var i = 0; i < samples.length; i++) {
        var v = num(samples[i][key]);
        var a = axisOf(samples[i]);
        if (v !== null && a !== null) pts.push({ a: a, v: v });
      }
      if (!pts.length) return null;
      pts.sort(function (p, q) { return p.a - q.a; });
      if (target <= pts[0].a) return pts[0].v;
      if (target >= pts[pts.length - 1].a) return pts[pts.length - 1].v;
      for (var j = 0; j < pts.length - 1; j++) {
        var x = pts[j], y = pts[j + 1];
        if (target >= x.a && target <= y.a) {
          if (y.a === x.a) return y.v;
          var t = (target - x.a) / (y.a - x.a);
          return x.v + t * (y.v - x.v);
        }
      }
      return pts[pts.length - 1].v;
    }

    var yRaw = [], xRawCols = xkeys.map(function () { return []; });
    var yN = [], xNCols = xkeys.map(function () { return []; });
    pts.forEach(function (o) {
      var vVal = interpVhms(records, vhmsKey, o.m, vhmsAxisOf);
      if (vVal === null) return;                    // Y (VHMS) harus ada
      var yNorm = normVhms(vVal, vth[vhmsKey]);
      if (yNorm === null) return;
      // X: ambil nilai langsung bila ada, jika tidak -> interpolasi SOS pada sumbu ini.
      var xs = xkeys.map(function (k) {
        var direct = num(o.s[k]);
        return (direct !== null) ? direct : interpSeries(samples, k, sosAxisOf, o.m);
      });
      yRaw.push(vVal); yN.push(yNorm);
      xs.forEach(function (val, i) { xRawCols[i].push(val); xNCols[i].push(normSos(val, sth[xkeys[i]])); });
    });

    // Untuk kolom X yang masih null (tak terinterpolasi karena param itu
    // memang tak punya data sama sekali di unit ini), tandai & buang kolomnya
    // nanti di tahap robust (spread nol). Isi dgn 0 netral agar baris tetap ajeg.
    xNCols.forEach(function (col) {
      for (var r = 0; r < col.length; r++) {
        if (col[r] === null || col[r] === undefined || isNaN(col[r])) col[r] = 0;
      }
    });

    var n = yN.length;
    var k = xkeys.length;
    // Fallback min-max bila normalisasi threshold tak menyebar.
    if (n >= 2) {
      var spreadOk = spread(yN) >= 0.05 && xNCols.every(function (c) { return spread(c) >= 0.05; });
      if (!spreadOk) {
        yN = minmax(yRaw);
        xNCols = xRawCols.map(function (c) { return minmax(c); });
      }
    }

    if (n < Math.max(4, k + 1)) {
      return { R: null, R2: null, n: n, k: k,
        betas: null,
        perVar: xkeys.map(function (kk) { return { key: kk, r: null, note: 'data tidak cukup' }; }),
        note: 'Butuh minimal ' + Math.max(4, k + 1) + ' titik lengkap (tersedia ' + n + ')' };
    }

    // [ROBUST] Buang kolom X yang (hampir) KONSTAN — varians nol membuat
    // matriks singular. Kolom konstan tidak menambah informasi untuk regresi.
    var usedIdx = [], droppedKeys = [];
    xNCols.forEach(function (col, i) {
      if (spread(col) >= 0.02) usedIdx.push(i);
      else droppedKeys.push(xkeys[i]);
    });
    if (!usedIdx.length) {
      return { R: null, R2: null, n: n, k: 0, betas: null,
        perVar: xkeys.map(function (kk) { return { key: kk, r: null, note: 'konstan' }; }),
        note: 'Semua parameter X konstan pada window ini (tidak ada variasi)' };
    }
    var xUse = usedIdx.map(function (i) { return xNCols[i]; });
    var kUse = xUse.length;

    // --- Regresi linear berganda via Normal Equations (X'X)b = X'y ---
    // Matriks desain [1, X1, X2, ...] (hanya kolom yang dipakai).
    var p = kUse + 1;
    var XtX = zeros(p, p), Xty = zeros(p, 1);
    for (var i = 0; i < n; i++) {
      var row = [1];
      for (var j = 0; j < kUse; j++) row.push(xUse[j][i]);
      for (var a = 0; a < p; a++) {
        Xty[a][0] += row[a] * yN[i];
        for (var b = 0; b < p; b++) XtX[a][b] += row[a] * row[b];
      }
    }
    var inv = invertMatrix(XtX);
    if (!inv) {
      return { R: null, R2: null, n: n, k: kUse, betas: null,
        perVar: xkeys.map(function (kk) { return { key: kk, r: null, note: 'matriks singular' }; }),
        note: 'Kolom X saling bergantung (multikolinearitas) / variasi kurang' };
    }
    var beta = mulMatrix(inv, Xty);   // [b0, b1, ...]
    var betas = beta.map(function (r) { return r[0]; });

    // Hitung R^2 = 1 - SSres/SStot.
    var yMean = yN.reduce(function (s, v) { return s + v; }, 0) / n;
    var sstot = 0, ssres = 0;
    for (var t = 0; t < n; t++) {
      var yhat = betas[0];
      for (var c = 0; c < kUse; c++) yhat += betas[c + 1] * xUse[c][t];
      sstot += Math.pow(yN[t] - yMean, 2);
      ssres += Math.pow(yN[t] - yhat, 2);
    }
    var R2 = sstot < 1e-12 ? null : (1 - ssres / sstot);
    if (R2 !== null) R2 = Math.max(0, Math.min(1, R2));
    var R = (R2 === null) ? null : Math.sqrt(R2);

    // Korelasi Pearson sederhana tiap X vs Y (untuk perbandingan).
    var perVar = xkeys.map(function (kk, idx) {
      if (usedIdx.indexOf(idx) === -1) return { key: kk, r: null, note: 'konstan (dikeluarkan)' };
      var pr = pearson(xNCols[idx], yN);
      return { key: kk, r: pr.r, note: null };
    });

    return { R: R, R2: R2, n: n, k: kUse, betas: betas, perVar: perVar,
             dropped: droppedKeys, note: null };
  }

  /* --- Utilitas matriks kecil (untuk regresi berganda) --- */
  function zeros(r, c) {
    var m = [];
    for (var i = 0; i < r; i++) { m[i] = []; for (var j = 0; j < c; j++) m[i][j] = 0; }
    return m;
  }
  function mulMatrix(A, B) {
    var n = A.length, m = B[0].length, p = B.length, out = zeros(n, m);
    for (var i = 0; i < n; i++)
      for (var j = 0; j < m; j++) {
        var s = 0;
        for (var k = 0; k < p; k++) s += A[i][k] * B[k][j];
        out[i][j] = s;
      }
    return out;
  }
  /** Invers matriks persegi via Gauss-Jordan. Kembalikan null bila singular. */
  function invertMatrix(M) {
    var n = M.length;
    var A = M.map(function (row, i) {
      return row.slice().concat(Array.from({ length: n }, function (_, j) { return i === j ? 1 : 0; }));
    });
    for (var col = 0; col < n; col++) {
      // Pivot: cari baris dgn |nilai| terbesar.
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;   // singular
      var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      // Normalisasi baris pivot.
      var d = A[col][col];
      for (var c = 0; c < 2 * n; c++) A[col][c] /= d;
      // Eliminasi baris lain.
      for (var rr2 = 0; rr2 < n; rr2++) {
        if (rr2 === col) continue;
        var f = A[rr2][col];
        if (f === 0) continue;
        for (var cc = 0; cc < 2 * n; cc++) A[rr2][cc] -= f * A[col][cc];
      }
    }
    return A.map(function (row) { return row.slice(n); });
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.VHMS_CROSS = {
    CURATED_PAIRS: CURATED_PAIRS,
    buildFleet: buildFleet,
    buildSosIndex: buildSosIndex,
    matchSos: matchSos,
    analyzePair: analyzePair,
    pairCorrelation: pairCorrelation,
    multipleCorrelation: multipleCorrelation,
    interpVhms: interpVhms,
    normVhms: normVhms,
    normSos: normSos,
    pearson: pearson,
    sosLambung: sosLambung,
    norm: norm,
    pickTimeBase: pickTimeBase,
    autoTimeBase: autoTimeBase,
    recordTime: recordTime,
    sampleTime: sampleTime,
    sampleMeter: sampleMeter
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_CROSS;
  }
})(typeof window !== 'undefined' ? window : globalThis);

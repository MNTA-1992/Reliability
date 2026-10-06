/* =========================================================================
 * component-life.js — Component Life Cut-off (CLC)
 * -------------------------------------------------------------------------
 * Filter objektivitas data SOS & VHMS berbasis PEMASANGAN komponen terakhir.
 *
 * MASALAH yang dipecahkan:
 *   Fe 350 ppm pada komponen berumur 12.000 jam = normal (keausan wajar).
 *   Fe 350 ppm pada komponen berumur 200 jam    = kegagalan dini (alarm).
 *   Mencampur sampel komponen LAMA dengan komponen BARU merusak trend,
 *   rate-of-change, dan evidence (durasi) di skor criticality.
 *
 * CARA KERJA (lihat docs/SPEK_COMPONENT_LIFE_CUTOFF.md):
 *   Untuk tiap pasangan (unit x kompartemen) buang sampel yang terjadi
 *   SEBELUM pemasangan komponen terakhir. Skema HIBRIDA berjenjang:
 *     TIER 1  tanggal (LastTecoDate)        -> keyakinan 'tinggi'
 *     TIER 2  HM (dengan pagar kerangka)    -> keyakinan 'sedang'
 *     TIER 3  ragu                          -> JANGAN memotong
 *
 * PRINSIP TAK BOLEH DILANGGAR:
 *   - Ragu = JANGAN POTONG (Tier 3). Salah potong lebih bahaya dari tidak.
 *   - Jangan menebak saat kompartemen ambigu (LH vs RH) -> kembalikan null.
 *   - Default fitur NONAKTIF (opt-in). Saklar mati = keluaran identik baseline.
 *   - Modul ini MURNI: tanpa DOM, tanpa window, dapat di-require dari Node.
 *     Ini SATU-SATUNYA pemilik logika potong — jangan tanam di store/renderer
 *     (pelajaran C-1 header & B-1 splitCsvLine yang divergen).
 *
 * Ketergantungan (opsional, diakses lazy):
 *   global.CSV_UTIL          (normalisasi kunci)
 *   global.PORTFOLIO_STORE   (sumber baris Lifetime & resolve lambung)
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Konfigurasi
   * --------------------------------------------------------------------- */

  /** Ambang selisih kerangka HM (jam) antara sumber sampel & Lifetime. */
  var HM_FRAME_TOLERANCE_HOURS = 500;

  var LS_ENABLED_KEY = 'clc.enabled.v1';
  var LS_TOL_KEY     = 'clc.hmTolerance.v1';
  var LS_SHOWCUT_KEY = 'clc.showCut.v1';

  /** State in-memory. Default NONAKTIF (opt-in). */
  var _enabled = false;
  var _tolHours = HM_FRAME_TOLERANCE_HOURS;
  var _showCut = false;   // tampilkan sampel terpotong (redup) di chart/tabel
  var _lastReport = null;

  /* Muat preferensi tersimpan (hanya bila localStorage tersedia). */
  (function loadPrefs() {
    try {
      if (global.localStorage) {
        var e = global.localStorage.getItem(LS_ENABLED_KEY);
        if (e === '1') _enabled = true;
        else if (e === '0') _enabled = false;
        var t = parseFloat(global.localStorage.getItem(LS_TOL_KEY));
        if (!isNaN(t) && t > 0) _tolHours = t;
        _showCut = global.localStorage.getItem(LS_SHOWCUT_KEY) === '1';
      }
    } catch (err) { /* localStorage tidak tersedia — pakai default */ }
  })();

  function isEnabled() { return _enabled; }

  function setEnabled(v) {
    _enabled = !!v;
    try { if (global.localStorage) global.localStorage.setItem(LS_ENABLED_KEY, _enabled ? '1' : '0'); } catch (e) {}
    return _enabled;
  }

  function getTolerance() { return _tolHours; }

  function setTolerance(hours) {
    var t = parseFloat(hours);
    if (!isNaN(t) && t > 0) {
      _tolHours = t;
      try { if (global.localStorage) global.localStorage.setItem(LS_TOL_KEY, String(t)); } catch (e) {}
    }
    return _tolHours;
  }

  /** Saklar tampilan: tampilkan sampel yang dipotong (redup) di chart/tabel. */
  function isShowCut() { return _showCut; }

  function setShowCut(v) {
    _showCut = !!v;
    try { if (global.localStorage) global.localStorage.setItem(LS_SHOWCUT_KEY, _showCut ? '1' : '0'); } catch (e) {}
    return _showCut;
  }

  /* -----------------------------------------------------------------------
   * Utilitas normalisasi (delegasi ke CSV_UTIL bila ada)
   * --------------------------------------------------------------------- */

  function _csv() { return global.CSV_UTIL || {}; }

  /** Normalisasi kunci (serial/lambung): buang spasi/tanda, uppercase. */
  function normKey(s) {
    var c = _csv();
    if (c.normKey) return c.normKey(s);
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /** Apakah nilai parameter "ada data" (non-null/non-NaN)? */
  function _hasData(v) {
    return v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v));
  }

  function _num(v) {
    if (v === null || v === undefined) return null;
    var n = (typeof v === 'number') ? v : parseFloat(String(v).replace(/[^0-9.\-eE]/g, ''));
    return isNaN(n) ? null : n;
  }

  /* -----------------------------------------------------------------------
   * [4.2] Kanonikalisasi nama kompartemen
   * ---------------------------------------------------------------------
   * 'FINAL DRIVE REAR LEFT' -> { fam:'FINALDRIVE', axis:'R', side:'L' }
   * --------------------------------------------------------------------- */

  var FAM_TABLE = [
    ['ENGINE DAMPER', 'DAMPER'],   // HARUS dicek sebelum 'ENGINE'
    ['ENGINE', 'ENGINE'],
    ['HYDRAULIC', 'HYDRAULIC'],
    ['FINAL DRIVE', 'FINALDRIVE'],
    ['DIFFERENTIAL', 'DIFFERENTIAL'],
    ['TRANSMISSION', 'TRANSMISSION'],
    ['WHEEL BEARING', 'WHEELBEARING'],
    ['BRAKE CHAMBER', 'BRAKECHAMBER'],
    ['BRAKE', 'BRAKE'],
    ['SWING', 'SWING'],
    ['STEERING', 'STEERING'],
    ['CIRCLE DRIVE', 'CIRCLEDRIVE'],
    ['PUMP', 'PUMP']
  ];

  function canonComp(raw) {
    var s = ' ' + String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() + ' ';

    var side = '';
    if (/ (LH|LEFT) /.test(s)) side = 'L';
    if (/ (RH|RIGHT) /.test(s)) side = 'R';

    var axis = '';
    if (/ FRONT /.test(s)) axis = 'F';
    if (/ REAR /.test(s)) axis = 'R';
    if (/ (CENTER|CENTRE) /.test(s)) axis = 'C';

    s = s.replace(/ (LH|RH|LEFT|RIGHT|FRONT|REAR|CENTER|CENTRE|SYSTEM|OIL|POWER SHIFT|BOX) /g, ' ')
         .replace(/\s+/g, ' ').trim();

    var fam = null;
    for (var i = 0; i < FAM_TABLE.length; i++) {
      if (s.indexOf(FAM_TABLE[i][0]) !== -1) { fam = FAM_TABLE[i][1]; break; }
    }
    if (!fam) fam = s.replace(/ /g, '');

    return { fam: fam, axis: axis, side: side };
  }

  /* -----------------------------------------------------------------------
   * [4.3] Pencocokan berjenjang ke baris Lifetime
   * ---------------------------------------------------------------------
   * 1. famili + sumbu + sisi sama                  -> cocok (keyakinan tinggi)
   * 2. famili + sisi sama, HANYA SATU kandidat      -> cocok (keyakinan sedang)
   * 3. famili sama tapi kandidat ganda / ambigu     -> TIDAK cocok
   * 4. famili tidak ditemukan                        -> TIDAK cocok
   * --------------------------------------------------------------------- */

  function _candidateKey(c) { return c.fam + '|' + c.axis + '|' + c.side; }

  function _axisOrSideCompatible(a, b) {
    // Konflik arah harus dicegah (LH vs RH, F vs R).
    if (a.side && b.side && a.side !== b.side) return false;
    if (a.axis && b.axis && a.axis !== b.axis) return false;
    return true;
  }

  /**
   * Cocokkan deskriptor kompartemen (dari canonComp) ke daftar baris Lifetime.
   * @param {{fam,axis,side}} comp
   * @param {object[]} lifeRows  baris Lifetime milik satu unit
   * @returns {{row:object, confidence:string}|null}
   */
  function matchLifeRow(comp, lifeRows) {
    if (!comp || !lifeRows || !lifeRows.length) return null;
    if (!comp.fam) return null;

    // Kandidat: baris yang familinya sama.
    var cands = [];
    for (var i = 0; i < lifeRows.length; i++) {
      var lc = canonComp(lifeRows[i].component);
      if (lc.fam !== comp.fam) continue;
      cands.push({ row: lifeRows[i], c: lc });
    }
    if (!cands.length) return null;

    var exact = [], generic = [];
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j].c;
      if (c.axis === comp.axis && c.side === comp.side) {
        exact.push(cands[j]);
        continue;
      }
      // Famili + sisi sama, sumbu diabaikan (Tier 2 kanonikalisasi).
      var sideOk = (c.side === comp.side) || (!c.side && !comp.side);
      if (sideOk && _axisOrSideCompatible(c, comp)) generic.push(cands[j]);
    }

    // 1. Exact: famili + sumbu + sisi persis.
    if (exact.length === 1) return { row: exact[0].row, confidence: 'tinggi' };
    if (exact.length > 1) return null;   // ambigu -> jangan menebak

    // 2. Famili + sisi sama, HANYA SATU kandidat.
    //    Kecuali kompartemen tak bersumbu/sisi (mis. HYDRAULIC) yang punya
    //    banyak baris -> biarkan ambigu -> null (jujur tidak cocok).
    if (generic.length === 1) {
      var only = generic[0].c;
      // Bila kompartemen generik (tanpa sisi) & baris pun tanpa sisi, tetapi
      // ada >1 baris se-famili -> ambigu (sudah tertangani: length!==1).
      // Bila sisi kompartemen kosong, terima hanya bila tak ada konflik.
      if (_axisOrSideCompatible(only, comp)) return { row: generic[0].row, confidence: 'sedang' };
    }

    return null;   // 3 & 4 — ambigu atau tak ditemukan: jangan menebak
  }

  /* -----------------------------------------------------------------------
   * [3.1 / 3.3] Titik pemasangan & perhitungan frameDelta
   * --------------------------------------------------------------------- */

  /**
   * Titik pemasangan komponen dari satu baris Lifetime.
   * @returns {{date:object|null, hm:number|null}|null}
   */
  function installPointOf(lifeRow) {
    if (!lifeRow) return null;
    var date = lifeRow.installDate || null;   // objek {epoch,iso,display}
    var hm = null;
    if (_hasData(lifeRow.currentHM) && _hasData(lifeRow.ageHours)) {
      hm = _num(lifeRow.currentHM) - _num(lifeRow.ageHours);
    }
    if (!date && hm === null) return null;
    return { date: date, hm: hm };
  }

  /**
   * frameDelta(unit) = |HM tertinggi sampel unit − TotalCountReading tertinggi Lifetime|
   * Dihitung PER UNIT (satu unit punya satu kerangka HM).
   * @returns {number|null} null bila tak dapat dihitung.
   */
  function frameDeltaOf(samples, lifeRows) {
    var maxSample = null;
    (samples || []).forEach(function (s) {
      var hm = _sampleHM(s);
      if (hm !== null && (maxSample === null || hm > maxSample)) maxSample = hm;
    });
    var maxLife = null;
    (lifeRows || []).forEach(function (r) {
      var hm = _num(r.currentHM);
      if (hm !== null && (maxLife === null || hm > maxLife)) maxLife = hm;
    });
    if (maxSample === null || maxLife === null) return null;
    return Math.abs(maxSample - maxLife);
  }

  /* -----------------------------------------------------------------------
   * [3.2] Keputusan untuk SATU sampel. Tidak pernah melempar.
   * --------------------------------------------------------------------- */

  /**
   * @param {object} sample    sampel SOS (punya _date/hm_unit, atau date/hm)
   * @param {object|null} lifeRow baris Lifetime yang cocok (atau null)
   * @param {number|null} frameDelta selisih kerangka HM unit
   * @returns {object} keputusan { cut, basis, confidence, ... }
   */
  function decide(sample, lifeRow, frameDelta) {
    if (!sample || typeof sample !== 'object') sample = {};
    if (!lifeRow || typeof lifeRow !== 'object') lifeRow = null;
    if (typeof frameDelta !== 'number' || isNaN(frameDelta)) frameDelta = null;

    // Tanggal sampel: utamakan Date object, lalu parser field.
    var sDate = _sampleDate(sample);
    var sHM = _sampleHM(sample);

    // --- TIER 1: tanggal ---
    if (lifeRow && lifeRow.installDate && lifeRow.installDate.epoch != null && sDate != null) {
      return {
        cut: sDate < lifeRow.installDate.epoch,
        basis: 'date',
        confidence: 'tinggi',
        refDate: lifeRow.installDate.iso,
        frameDelta: (frameDelta == null ? null : frameDelta)
      };
    }

    // --- TIER 2: HM, dengan pagar pengaman kerangka ---
    var pt = installPointOf(lifeRow);
    var installHM = pt ? pt.hm : null;

    if (installHM !== null && sHM !== null) {
      if (frameDelta == null || frameDelta <= _tolHours) {
        return {
          cut: sHM < installHM,
          basis: 'hm',
          confidence: 'sedang',
          refHM: installHM,
          frameDelta: (frameDelta == null ? null : frameDelta)
        };
      }
      // Kerangka HM tidak dapat dipercaya.
      return {
        cut: false,
        basis: 'none',
        confidence: 'tanpa-referensi',
        frameDelta: frameDelta,
        reason: 'selisih kerangka HM ' + Math.round(frameDelta) + ' j > ambang'
      };
    }

    // --- TIER 3: menyerah dengan jujur ---
    return {
      cut: false,
      basis: 'none',
      confidence: 'tanpa-referensi',
      frameDelta: (frameDelta == null ? null : frameDelta),
      reason: (lifeRow ? 'tidak ada referensi pemasangan' : 'kompartemen tidak ada di Lifetime')
    };
  }

  function _sampleDate(sample) {
    var d = sample._date || sample.sampled_date || sample.lab_date || sample.distribution_date;
    if (!d) return null;
    var dd = (d instanceof Date) ? d : new Date(d);
    var t = dd.getTime();
    return isNaN(t) ? null : t;
  }

  function _sampleHM(sample) {
    var hm = sample._hm;
    if (hm === null || hm === undefined) hm = sample.hm_unit;
    return _num(hm);
  }

  /* -----------------------------------------------------------------------
   * Indeks Lifetime (per lambung) — dibangun sekali per pemanggilan batch
   * --------------------------------------------------------------------- */

  /** Akses PORTFOLIO_STORE secara lazy (hindari ketergantungan urutan muat). */
  function _store() { return global.PORTFOLIO_STORE || null; }

  /**
   * Ambil baris Lifetime untuk sebuah lambung (menggunakan PORTFOLIO_STORE).
   * @returns {object[]}
   */
  function lifeRowsFor(lambung) {
    var store = _store();
    if (!store || !lambung) return [];
    try {
      if (typeof store.getLifetime === 'function') return store.getLifetime(lambung) || [];
    } catch (e) { /* fallback */ }
    return [];
  }

  /* -----------------------------------------------------------------------
   * [SOS] Anotasi & filter sampel
   * --------------------------------------------------------------------- */

  /**
   * Anotasi setiap sampel dengan `_clc` (in-place). SELALU dijalankan, baik
   * fitur aktif maupun tidak, supaya UI dapat menjelaskan dasar keputusan.
   * @param {object[]} samples
   * @returns {object} ringkasan { total, cut, byBasis }
   */
  function annotateSosSamples(samples) {
    var report = { total: 0, cut: 0, byBasis: { date: 0, hm: 0, none: 0 }, matched: 0, unmatched: 0 };
    if (!Array.isArray(samples) || !samples.length) { _lastReport = report; return report; }

    var store = _store();
    // Cache baris Lifetime per lambung (memo per pemanggilan).
    var byUnit = {};

    samples.forEach(function (s) {
      if (!s) return;
      report.total++;

      var assetKey = s.asset_id != null ? String(s.asset_id) : '';
      var lambung = assetKey;
      try {
        if (store && typeof store.resolveLambung === 'function') {
          lambung = store.resolveLambung(assetKey, s.component_serial || s.serial) || assetKey;
        }
      } catch (e) { /* pakai assetId apa adanya */ }

      var uKey = normKey(lambung);
      if (!byUnit[uKey]) {
        byUnit[uKey] = { rows: lifeRowsFor(lambung), delta: null, deltaDone: false };
      }
      var unit = byUnit[uKey];

      var comp = canonComp(s.component);
      var match = matchLifeRow(comp, unit.rows);
      var lifeRow = match ? match.row : null;

      // frameDelta dihitung sekali per unit (butuh sampel unit ini — pakai
      // seluruh sampel yang ada di batch, difilter per lambung).
      if (!unit.deltaDone) {
        var unitSamples = samples.filter(function (x) {
          if (!x) return false;
          var a = x.asset_id != null ? String(x.asset_id) : '';
          var lb = a;
          try {
            if (store && typeof store.resolveLambung === 'function') lb = store.resolveLambung(a, x.component_serial || x.serial) || a;
          } catch (e) { lb = a; }
          return normKey(lb) === uKey;
        });
        unit.delta = frameDeltaOf(unitSamples, unit.rows);
        unit.deltaDone = true;
      }

      var dec = decide(s, lifeRow, unit.delta);
      dec.component = comp;
      if (!lifeRow) dec.matched = false; else dec.matched = true;

      s._clc = dec;

      if (match) report.matched++; else report.unmatched++;
      if (dec.cut) report.cut++;
      if (dec.basis === 'date') report.byBasis.date++;
      else if (dec.basis === 'hm') report.byBasis.hm++;
      else report.byBasis.none++;
    });

    _lastReport = report;
    return report;
  }

  /**
   * Kembalikan hanya sampel yang LOLOS (tidak dipotong). Bila fitur NONAKTIF,
   * kembalikan array yang sama apa adanya (byte-identik baseline, test R1).
   * @param {object[]} samples
   * @returns {object[]}
   */
  function filterSosSamples(samples) {
    if (!Array.isArray(samples) || !samples.length) return samples || [];
    if (!_enabled) return samples;
    return samples.filter(function (s) { return !(s && s._clc && s._clc.cut); });
  }

  /* -----------------------------------------------------------------------
   * [VHMS] Potong PER-PILAR (null-kan parameter, JANGAN hapus record)
   * --------------------------------------------------------------------- */

  /** Pemetaan famili kompartemen Lifetime -> pilar VHMS. */
  var PILLAR_OF_COMPONENT = {
    ENGINE: 'ENGINE',
    HYDRAULIC: 'HYDRAULIC',
    PUMP: 'HYDRAULIC',
    TRANSMISSION: 'POWERTRAIN',
    DIFFERENTIAL: 'POWERTRAIN',
    FINALDRIVE: 'POWERTRAIN',
    BRAKE: 'BRAKE',
    BRAKECHAMBER: 'BRAKE'
  };

  /**
   * Epoch kalender VHMS -> milidetik. Parser VHMS menyimpan `calendar.epoch`
   * dalam DETIK (mis. 1639594520), sedangkan Lifetime memakai MILIDETIK.
   * Tanpa normalisasi ini, perbandingan Tier 1 VHMS selalu salah
   * (1970 < 2025 selalu benar -> semua record dianggap "sebelum pemasangan").
   */
  function _calEpochMs(cal) {
    if (!cal || cal.epoch == null) return null;
    var e = _num(cal.epoch);
    if (e === null) return null;
    // Nilai < 1e11 hampir pasti DETIK (dalam ms = ±1970). MS modern ~1.7e12.
    return e < 1e11 ? e * 1000 : e;
  }

  /** Peta pilar -> daftar parameter VHMS (dari RANKING_PILLARS). */
  function _paramsOfPillar(cfg) {
    var map = {};
    if (!cfg || !cfg.RANKING_PILLARS) return map;
    var RP = cfg.RANKING_PILLARS;
    Object.keys(RP).forEach(function (param) {
      var pillar = RP[param];
      if (!map[pillar]) map[pillar] = [];
      map[pillar].push(param);
    });
    return map;
  }

  /**
   * Potong parameter per pilar pada record VHMS berdasarkan pemasangan
   * komponen terakhir. Menerima objek analysis ({records, meta}) ATAU array
   * records langsung.
   *
   * @param {object|object[]} analysisOrRecords
   * @param {string} serial  Serial No. unit (kunci join Lifetime)
   * @returns {object} ringkasan { applied, pillars: {PILLAR: {cutoff, paramCount}} , nulled }
   */
  function applyVhmsPillarCut(analysisOrRecords, serial) {
    var result = { applied: false, pillars: {}, nulled: 0, reason: '' };
    if (!_enabled) { result.reason = 'nonaktif'; return result; }

    var records = Array.isArray(analysisOrRecords)
      ? analysisOrRecords
      : (analysisOrRecords && analysisOrRecords.records);
    if (!records || !records.length) { result.reason = 'tidak ada record'; return result; }

    var store = _store();
    if (!store) { result.reason = 'Lifetime belum dimuat'; return result; }

    // Resolve lambung dari serial.
    var lambung = serial;
    try {
      if (store.resolveLambung && serial) lambung = store.resolveLambung(serial, serial) || serial;
    } catch (e) { lambung = serial; }

    var lifeRows = lifeRowsFor(lambung);
    if (!lifeRows.length) { result.reason = 'unit tidak ada di Lifetime'; return result; }

    var cfg = global.VHMS_CONFIG;
    var paramMap = _paramsOfPillar(cfg);

    // frameDelta VHMS: HM unit = smr tertinggi; Lifetime = currentHM tertinggi.
    var maxSmr = null;
    records.forEach(function (r) {
      var v = _num(r && r.smr);
      if (v !== null && (maxSmr === null || v > maxSmr)) maxSmr = v;
    });
    var maxLife = null;
    lifeRows.forEach(function (r) {
      var v = _num(r.currentHM);
      if (v !== null && (maxLife === null || v > maxLife)) maxLife = v;
    });
    var frameDelta = (maxSmr !== null && maxLife !== null) ? Math.abs(maxSmr - maxLife) : null;

    // Untuk tiap komponen Lifetime -> tentukan titik potong -> pilar.
    lifeRows.forEach(function (lifeRow) {
      var comp = canonComp(lifeRow.component);
      var pillar = PILLAR_OF_COMPONENT[comp.fam];
      if (!pillar) return;
      var params = paramMap[pillar];
      if (!params || !params.length) return;

      var pt = installPointOf(lifeRow);
      if (!pt) return;

      // Tentukan mana yang dipakai: tanggal (Tier 1) atau SMR (Tier 2).
      var useDate = pt.date && pt.date.epoch != null;
      var useHM = !useDate && pt.hm !== null && (frameDelta == null || frameDelta <= _tolHours);

      if (!useDate && !useHM) return;   // Tier 3 -> jangan potong

      // Jangan menimpa pilar yang sudah punya titik potong.
      if (result.pillars[pillar]) return;

      // Rencanakan dulu (jangan mutasi sebelum tahu dampaknya) — [R-5].
      var cutCount = 0, afterCount = 0;
      var toNull = [];   // daftar {record, params: true}
      records.forEach(function (r) {
        if (!r) return;
        var cut;
        if (useDate) {
          var t = _calEpochMs(r.calendar);
          cut = (t != null) && (t < pt.date.epoch);
        } else {
          var smr = _num(r.smr);
          cut = (smr !== null) && (smr < pt.hm);
        }
        if (cut) { cutCount++; toNull.push(r); }
        else afterCount++;
      });

      var cutoffRef = useDate ? pt.date.iso : pt.hm;

      // [R-5] Bila potong menghabiskan SELURUH titik pilar -> JANGAN potong.
      if (cutCount > 0 && afterCount === 0) {
        result.pillars[pillar] = { cutoff: cutoffRef, paramCount: params.length, cutRecords: 0, cancelled: true };
        result.reason = 'pilar ' + pillar + ' akan kosong — potong dibatalkan';
        return;
      }

      // Terapkan: JANGAN hapus record — null-kan hanya param pilar.
      toNull.forEach(function (r) {
        params.forEach(function (k) {
          if (_hasData(r[k])) { r[k] = null; result.nulled++; }
        });
      });

      result.pillars[pillar] = { cutoff: cutoffRef, paramCount: params.length, cutRecords: cutCount };
      result.applied = true;
    });

    return result;
  }

  /* -----------------------------------------------------------------------
   * Pelaporan
   * --------------------------------------------------------------------- */

  function reportFor() { return _lastReport; }
  function lastReport() { return _lastReport; }

  /* ----------------------------------------------------------------------- */
  global.COMPONENT_LIFE = {
    // Konfigurasi
    HM_FRAME_TOLERANCE_HOURS: HM_FRAME_TOLERANCE_HOURS,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    getTolerance: getTolerance,
    setTolerance: setTolerance,
    isShowCut: isShowCut,
    setShowCut: setShowCut,

    // Primitif (teruji penuh)
    canonComp: canonComp,
    matchLifeRow: matchLifeRow,
    installPointOf: installPointOf,
    frameDeltaOf: frameDeltaOf,
    decide: decide,

    // SOS
    annotateSosSamples: annotateSosSamples,
    filterSosSamples: filterSosSamples,

    // VHMS
    PILLAR_OF_COMPONENT: PILLAR_OF_COMPONENT,
    applyVhmsPillarCut: applyVhmsPillarCut,

    // Pelaporan
    reportFor: reportFor,
    lastReport: lastReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.COMPONENT_LIFE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

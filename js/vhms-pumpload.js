/* =========================================================================
 * vhms-pumpload.js
 * -------------------------------------------------------------------------
 * [D375A 2026-10-14 — T3] Penafsir DUA berkas beban pompa hidraulik dozer
 * D375A (`CHK0001/`):
 *
 *   '36' loadmp1.CSV   Pump 1 Load Map
 *   '37' loadmp2.CSV   Pump 2 Load Map
 *
 * BENTUK (terverifikasi pada SN 19559, SMR 28 812,1 h)
 *   X = `PumpN IN. Speed`  (rpm)   9 band "0 - 400","- 700",…,"2500 -"
 *   Y = `PumpN IN. Torque` (Nm)    8 band "0 - 100","- 200",…,"700 -"
 *   Z = `Time, sec`  ·  Sampling 1000 msec  ·  Column Rate 1
 *   Σ tiap berkas = 103 569 6xx s = 28 769 h = 99,9 % SMR
 *
 * =========================================================================
 * ⚠⚠ MENGAPA MODUL INI BERDIRI SENDIRI — INI PAGAR J3
 * =========================================================================
 * Skala torsi pompa D375A berhenti di **700 Nm**. Skala torsi pompa PC2000
 * (`loadmop0` / `loadmwork0`, tipe '7E'/'7F') berhenti di **7 000 Nm** —
 * BEDA 10 KALI.
 *
 * `VHMS_LOADMAP` memegang `TORQUE_HI = 3000` dan `TORQUE_VERY_HI = 3500`
 * yang dikalibrasi untuk POMPA PC2000. Bila konstanta itu dipakai di sini:
 *
 *     "torsi di atas 3000 Nm" = SELALU 0 %  ->  laporan "BERSIH" PALSU
 *
 * Perhatikan bahwa ini KEBALIKAN dari bug yang menimpa HD785, di mana
 * konstanta yang sama menghasilkan "61,4 %" yang tidak bermakna. Dua arah
 * kegagalan, satu akar: MEMAKAI ULANG konstanta lintas model. Pola bug ini
 * (`*ExhOver800`) sudah tiga kali kambuh di proyek ini.
 *
 * Karena itu:
 *   - MODUL INI ADALAH MODUL TERPISAH, tidak menempel ke `VHMS_LOADMAP`.
 *   - Ia TIDAK mereferensikan `VHMS_LOADMAP.TORQUE_HI`/`TORQUE_VERY_HI`
 *     SAMA SEKALI. Itu dikunci oleh uji sumber-kode `PP-4`.
 *   - Ambang absolut = NOL. Hanya besaran relatif / self-referential.
 *
 * =========================================================================
 * ⚠ ARTI TEKNIS P1 vs P2 BELUM DIKETAHUI
 * =========================================================================
 * Terukur: pompa 1 jauh lebih banyak bekerja pada torsi tinggi daripada
 * pompa 2 (rasio ~3,3x). TETAPI belum diketahui apakah P1 & P2 melayani
 * sirkuit BERBEDA (blade vs ripper vs steering) atau PARALEL pada beban yang
 * sama. Tanpa info itu, angka rasio TIDAK boleh diubah menjadi pernyataan
 * tentang fungsi sirkuit, keausan komponen, atau rekomendasi tindakan.
 *
 * Modul melaporkan rasio + batas atas emisi pompa 2. Itu saja.
 *
 * PRINSIP PROYEK
 *   - `parse()` MURNI atas teks masukan.
 *   - `null` != `0`.
 *   - Logika band dipinjam dari `VHMS_LOADMAP.resolveBands`.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Peta tipe
   * --------------------------------------------------------------------- */

  var KIND_P1 = 'pump1';
  var KIND_P2 = 'pump2';

  var TYPE_MAP = { '36': KIND_P1, '37': KIND_P2 };

  var KIND_LABEL = {};
  KIND_LABEL[KIND_P1] = 'Beban pompa 1';
  KIND_LABEL[KIND_P2] = 'Beban pompa 2';

  var SEC_PER_HOUR = 3600;

  /**
   * Label band torsi terendah pada berkas pompa D375A.
   * Dipakai untuk memisahkan "pompa menganggur" dari "pompa bekerja".
   * ⚠ Ini BUKAN ambang OEM — ia adalah label band pertama dari BERKAS
   * ITU SENDIRI, diambil dari `rowLabels[0]`, bukan dikarang.
   */
  var IDLE_BAND_FALLBACK = '0 - 100';

  var BASIS_NOTE = 'Basis "aktif" = torsi di atas band terendah berkas ' +
    '(label diambil dari berkas itu sendiri, bukan ambang pabrik). ' +
    'Basis "bergerak" tidak berlaku di modul ini.';

  var CIRCUIT_NOTE = 'Arti teknis Pompa 1 vs Pompa 2 BELUM diketahui — apakah ' +
    'melayani sirkuit berbeda (blade/ripper/steering) atau paralel pada beban ' +
    'yang sama. Rasio dilaporkan sebagai perbandingan RELATIF; jangan ' +
    'ditafsirkan sebagai fungsi sirkuit, keausan komponen, atau tindakan.';

  /* -----------------------------------------------------------------------
   * 2. Deteksi & utilitas
   * --------------------------------------------------------------------- */

  function normType(t) { return String(t == null ? '' : t).trim().toUpperCase(); }

  function isPumpType(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_MAP, normType(type));
  }

  function kindFromType(type) { return TYPE_MAP[normType(type)] || null; }

  /**
   * Cadangan dari NAMA BERKAS. BERJANGKAR — pelajaran J4.
   * Hanya `loadmp1`/`loadmp2` yang diterima.
   */
  function kindFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    var m = /(^|[\\/])loadmp([12])(\.csv)?$/.exec(n);
    return m ? (m[2] === '1' ? KIND_P1 : KIND_P2) : null;
  }

  function splitLine(line) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.splitLine === 'function') return cu.splitLine(line);
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** Lengkapi batas bawah band — dipinjam dari VHMS_LOADMAP (satu sumber). */
  function resolveBands(labels) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') return lm.resolveBands(labels);
    var prev = null;
    return (labels || []).map(function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      var out = { lo: null, hi: null, open: false, label: s };
      var m2 = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
      if (m2) { out.lo = toNum(m2[1]); out.hi = toNum(m2[2]); prev = out.hi; return out; }
      var m1 = /^-\s*([\d.]+)$/.exec(s);
      if (m1) { out.hi = toNum(m1[1]); out.lo = prev; prev = out.hi; return out; }
      var m3 = /^([\d.]+)\s*-$/.exec(s);
      if (m3) { out.lo = toNum(m3[1]); out.open = true; prev = out.lo; return out; }
      return out;
    });
  }

  function bandLow(b) {
    if (!b) return null;
    return (b.lo !== null && b.lo !== undefined) ? b.lo : b.hi;
  }

  /* -----------------------------------------------------------------------
   * 3. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse satu berkas beban pompa.
   *
   * @param {string} text
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} { kind, label, dataType, dataTitle, meta,
   *   rowLabels[], colLabels[], matrix[][], xAxis, yAxis, zAxis,
   *   totalSec, hours, secondsValid, stats, warnings[] }
   * @throws {Error} bila blok [Data] tidak ada atau kosong
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: null, label: '',
      dataType: '', dataTitle: '',
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      totalSec: 0, hours: null, secondsValid: false,
      stats: null,
      warnings: []
    };

    var inData = false, sawData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      var sec = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (sec) {
        if (/^data$/i.test(sec[1])) { inData = true; sawData = true; }
        else inData = false;
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);
      var key = String(cells[0] || '').trim();

      if (!inData) {
        if (!key) continue;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = String(cells[1] || '').trim();
          result.dataTitle = String(cells[2] || '').trim();
        } else if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (!/^(status of item|view item\d*|column (type|rate|scale))$/i.test(key)) {
          var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();
          result.meta[key] = val;
        }
        continue;
      }

      if (/^\s*(Column (Item|Rate|Type|Scale)|Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) {
        if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        }
        continue;
      }
      if (key === '') continue;
      var nums = cells.slice(1).map(toNum);
      if (!nums.some(function (v) { return v !== null; })) continue;
      result.rowLabels.push(key);
      result.matrix.push(nums.map(function (v) { return v === null ? 0 : v; }));
    }

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas beban pompa.');
    if (!result.matrix.length) throw new Error('Berkas beban pompa tidak mengandung baris data.');

    // --- Jenis berkas ---
    result.dataType = normType(opts.dataType || result.dataType);
    result.kind = kindFromType(result.dataType) || kindFromFileName(opts.sourceName || '');
    if (!result.kind) {
      result.warnings.push('Jenis berkas pompa tidak dapat ditentukan dari tipe "' +
        result.dataType + '" maupun nama berkas "' + (opts.sourceName || '') + '".');
      return result;
    }
    result.label = KIND_LABEL[result.kind] || result.kind;

    // --- Satuan sumbu Z: WAJIB detik ---
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    result.secondsValid = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (!result.secondsValid) {
      result.warnings.push('Satuan sumbu Z terbaca "' + (result.zAxis.unit || '(kosong)') +
        '", bukan detik — nilai jam TIDAK dilaporkan.');
    }

    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.totalSec = total;
    result.hours = result.secondsValid ? (total / SEC_PER_HOUR) : null;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — tidak ada data untuk dianalisis.');
      return result;
    }

    result.stats = buildStats(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 4. Statistik per berkas — semua RELATIF, tanpa ambang
   * --------------------------------------------------------------------- */

  /**
   * Metrik per pompa.
   *
   * `activeSec` = torsi DI ATAS band terendah. Band terendah menampung
   * keadaan pompa nyaris tanpa beban; memasukkannya akan menenggelamkan
   * sinyal (pelajaran `slopeZones` di vhms-dutymap.js).
   *
   * `ceilingBand` = label band torsi TERTINGGI yang masih berisi jam.
   * Ini menjawab "seberapa tinggi pompa ini pernah dibebani" memakai
   * LABEL BERKAS, bukan ambang.
   */
  function buildStats(res) {
    var rowBands = resolveBands(res.rowLabels);   // torsi (Nm)
    var colBands = resolveBands(res.colLabels);   // rpm
    var total = res.totalSec;
    if (total <= 0) return null;

    var rowSums = res.matrix.map(function (r) {
      return r.reduce(function (a, b) { return a + b; }, 0);
    });

    var nRows = res.matrix.length;
    var nCols = res.colLabels.length || (res.matrix[0] ? res.matrix[0].length : 0);

    // Aktif = torsi di atas band terendah.
    var idleSec = nRows ? rowSums[0] : 0;
    var activeSec = 0;
    for (var i = 1; i < nRows; i++) activeSec += rowSums[i];

    // Band torsi tertinggi yang MASIH punya jam > 0.
    var ceilingIdx = -1;
    for (var k = nRows - 1; k >= 0; k--) {
      if (rowSums[k] > 0) { ceilingIdx = k; break; }
    }

    // Puncak rpm (kolom dengan jam terbanyak) — deskriptif.
    var colSums = [];
    for (var c = 0; c < nCols; c++) {
      var s = 0;
      for (var r2 = 0; r2 < nRows; r2++) s += (res.matrix[r2][c] || 0);
      colSums.push(s);
    }
    var peakCol = -1, peakVal = -1;
    for (var m = 0; m < colSums.length; m++) {
      if (colSums[m] > peakVal) { peakVal = colSums[m]; peakCol = m; }
    }

    function hrs(s) { return res.secondsValid ? (s / SEC_PER_HOUR) : null; }

    return {
      totalSec: total,
      hours: hrs(total),
      idleBandLabel: nRows ? res.rowLabels[0] : null,
      idleSec: idleSec, idleHours: hrs(idleSec), idleShare: 100 * idleSec / total,
      /** Torsi di atas band terendah. */
      activeSec: activeSec, activeHours: hrs(activeSec), activeShare: 100 * activeSec / total,
      /** Label band torsi tertinggi yang masih terisi (null bila semua nol). */
      ceilingBand: ceilingIdx >= 0 ? res.rowLabels[ceilingIdx] : null,
      ceilingLow: ceilingIdx >= 0 ? bandLow(rowBands[ceilingIdx]) : null,
      ceilingSec: ceilingIdx >= 0 ? rowSums[ceilingIdx] : 0,
      ceilingHours: ceilingIdx >= 0 ? hrs(rowSums[ceilingIdx]) : null,
      peakRpmBand: peakCol >= 0 ? res.colLabels[peakCol] : null,
      peakRpmShare: peakCol >= 0 ? (100 * colSums[peakCol] / total) : null,
      torqueRows: res.rowLabels.map(function (lbl, idx) {
        return { label: lbl, sec: rowSums[idx], hours: hrs(rowSums[idx]), share: 100 * rowSums[idx] / total };
      }),
      rpmCols: res.colLabels.map(function (lbl, idx) {
        return { label: lbl, sec: colSums[idx], hours: hrs(colSums[idx]), share: 100 * colSums[idx] / total };
      }),
      /**
       * [AUDIT 2026-10-15 — A-1] Label & satuan sumbu APA ADANYA dari berkas,
       * untuk header tabel panel. Sebelumnya field ini TIDAK ADA sehingga
       * `vhms-powertrain-render.js` selalu memakai fallback literal 'Nm'.
       * Fallback itu kebetulan benar untuk D375A (band ≤700 Nm) sehingga
       * cacatnya tak terlihat — model dengan satuan torsi lain akan salah.
       * Pola ini menyamakan diri dengan `luStats()` di `vhms-tcload.js`.
       */
      yLabel: res.yAxis.title || 'Pump Torque',
      yUnit: res.yAxis.unit || '',
      xLabel: res.xAxis.title || 'Engine Speed',
      xUnit: res.xAxis.unit || '',
      thresholdsUsed: {},
      basisNote: BASIS_NOTE
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Agregat lintas-berkas — membandingkan P1 vs P2 (RELATIF saja)
   * --------------------------------------------------------------------- */

  /**
   * Bandingkan Pompa 1 & Pompa 2.
   *
   * @param {object} p1Res hasil parse '36'
   * @param {object} p2Res hasil parse '37'
   * @returns {object|null}
   */
  function comparePumps(p1Res, p2Res) {
    if (!p1Res || !p2Res) return null;
    var a = p1Res.stats, b = p2Res.stats;
    if (!a || !b) return null;

    function ratio(x, y) {
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      if (!isFinite(x) || !isFinite(y) || y <= 0) return null;
      return x / y;
    }

    return {
      p1Hours: a.hours, p2Hours: b.hours,
      p1ActiveHours: a.activeHours, p2ActiveHours: b.activeHours,
      /** Rasio jam AKTIF P1/P2. >1 berarti P1 lebih banyak dibebani. */
      asymPump: ratio(a.activeSec, b.activeSec),
      p1ActiveShare: a.activeShare, p2ActiveShare: b.activeShare,
      p1CeilingBand: a.ceilingBand, p2CeilingBand: b.ceilingBand,
      p1Stats: a, p2Stats: b,
      /** Selalu true: modul tidak menafsirkan fungsi sirkuit. */
      circuitMeaningDeferred: true,
      circuitNote: CIRCUIT_NOTE,
      basisNote: 'Rasio = jam AKTIF Pompa 1 / jam AKTIF Pompa 2. '
    };
  }

  /**
   * Gabungkan kedua berkas menjadi ringkasan siap-panel.
   * Bandingkan HANYA bila keduanya ada — satu berkas saja -> null.
   *
   * @param {object} byKind peta `kind -> hasil parse()`
   * @returns {object|null}
   */
  function summarize(byKind) {
    if (!byKind) return null;
    var p1 = byKind[KIND_P1] || null, p2 = byKind[KIND_P2] || null;
    if (!p1 && !p2) return null;

    return {
      fileCount: (p1 ? 1 : 0) + (p2 ? 1 : 0),
      p1: p1 ? p1.stats : null,
      p2: p2 ? p2.stats : null,
      compare: comparePumps(p1, p2),
      circuitNote: CIRCUIT_NOTE,
      missing: [KIND_P1, KIND_P2].filter(function (k) { return !byKind[k]; })
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_PUMPLOAD = {
    KIND_P1: KIND_P1,
    KIND_P2: KIND_P2,
    KIND_LABEL: KIND_LABEL,
    TYPE_MAP: TYPE_MAP,
    ACCEPTED_TYPES: Object.keys(TYPE_MAP),
    IDLE_BAND_FALLBACK: IDLE_BAND_FALLBACK,
    CIRCUIT_NOTE: CIRCUIT_NOTE,
    isPumpType: isPumpType,
    kindFromType: kindFromType,
    kindFromFileName: kindFromFileName,
    resolveBands: resolveBands,
    parse: parse,
    buildStats: buildStats,
    comparePumps: comparePumps,
    summarize: summarize
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_PUMPLOAD;
  }
})(typeof window !== 'undefined' ? window : globalThis);

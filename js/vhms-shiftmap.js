/* =========================================================================
 * vhms-shiftmap.js
 * -------------------------------------------------------------------------
 * [D375A 2026-10-13] Penafsir MATRIKS PERPINDAHAN GIGI transmisi dari berkas
 * VHMS `tm_sft0.CSV` (Data Type '83', judul "T/M Shift Change Map").
 *
 * APA YANG DIMODELKAN
 *   Berkas ini BUKAN seri waktu. Strukturnya tabel silang 7x7:
 *
 *            To -> R3     R2     R1     N      F1     F2     F3
 *     From R3      0   1495      7    342   2208     36      1
 *          R2   3356      0  15791  97855 1852138    45      0
 *          ...
 *
 *   baris = posisi ASAL (`From`), kolom = posisi TUJUAN (`To`), sel = JUMLAH
 *   perpindahan gigi seumur hidup (kumulatif). Tidak ada SMR, tidak ada
 *   Calendar -> TIDAK dapat diplot sebagai tren dan TIDAK BOLEH masuk
 *   `records` trend.
 *
 *   Nama sumbu dibaca APA ADANYA dari berkas:
 *       "X Axis Title & X Axis Scale,To,"
 *       "Y Axis Title & Y Axis Scale,From,"
 *
 * JEBAKAN YANG WAJIB DITANGANI
 *   1. Baris data diawali LABEL POSISI (`R3`), bukan angka SMR.
 *   2. Label kolom ada di baris `Column Item` — BUKAN tanggal/area.
 *   3. Diagonal (From = To) selalu 0: tidak ada "perpindahan" ke posisi yang
 *      sama. Nilai bukan-nol di diagonal = data mencurigakan -> diperingatkan.
 *   4. Tidak ada saturasi uint16 seperti clutch: nilai terbesar pada unit
 *      contoh = 2.003.412 (butuh 32-bit). Jadi TIDAK ada penandaan ">=".
 *
 * INDIKATOR TURUNAN
 *   Matriks 7x7 sulit dibaca langsung, jadi diturunkan:
 *     - totalShift      : seluruh perpindahan (tanpa diagonal)
 *     - selfShift        : isi diagonal (HARUS 0; bila tidak -> peringatan)
 *     - forwardShift     : tujuan F1..F3 (maju)
 *     - reverseShift     : tujuan R1..R3 (mundur)
 *     - neutralShift     : tujuan N
 *     - reverseRatio     : reverseShift / totalShift
 *     - neutralRatio     : neutralShift / totalShift
 *     - biggestCell      : sel terbesar (From -> To) + nilainya
 *     - rowTotals / colTotals
 *     - topTransitions   : 10 perpindahan terbesar, terurut menurun
 *
 *   CATATAN KEJUJURAN
 *     Seluruh ambang interpretasi BELUM TERKALIBRASI. Rasio mundur/netral
 *     HANYA dilaporkan sebagai angka; modul ini TIDAK memberi vonis
 *     "normal/abnormal" karena tidak ada dasar rujukan (bukan Shop Manual,
 *     bukan statistik populasi). Panel hanya menyajikan angka + konteks.
 *
 * PRINSIP PROYEK
 *   - Nilai TIDAK dimutasi; modul ini murni (pure) atas teks/objek masukan.
 *   - Tanpa dependensi kecuali CSV_UTIL (opsional).
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Konstanta
   * --------------------------------------------------------------------- */

  /** Tipe VHMS yang ditangani modul ini. */
  var SHIFTMAP_TYPE = '83';        // T/M Shift Change Map

  /**
   * Posisi transmisi baku, urut dari mundur ke maju.
   * Pabrik kadang menulis bentuk lain (`R3`/`REV3`/`3R`) -> dinormalkan.
   */
  var POSITION_ORDER = ['R3', 'R2', 'R1', 'N', 'F1', 'F2', 'F3'];

  /** Klasifikasi arah sebuah posisi. */
  var POSITION_DIR = {
    R3: 'reverse', R2: 'reverse', R1: 'reverse',
    N: 'neutral',
    F1: 'forward', F2: 'forward', F3: 'forward'
  };

  /** Berapa perpindahan teratas yang dilaporkan. */
  var TOP_N = 10;

  /* -----------------------------------------------------------------------
   * 2. Deteksi jenis berkas
   * --------------------------------------------------------------------- */

  function isShiftMapType(type) {
    return String(type == null ? '' : type).trim() === SHIFTMAP_TYPE;
  }

  /* -----------------------------------------------------------------------
   * 3. Utilitas
   * --------------------------------------------------------------------- */

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

  /** Angka dari sel CSV; null bila kosong/bukan angka (delegasi CSV_UTIL). */
  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /**
   * Normalisasi label POSISI transmisi ke bentuk baku.
   * Menerima varian pabrik (huruf kecil, spasi, urutan terbalik).
   *   'R3' | 'r3' | 'REV3' | '3R'  -> 'R3'
   *   'N'  | 'NEU' | 'NEUTRAL'     -> 'N'
   *   'F1' | 'f1' | 'FWD1' | '1F'  -> 'F1'
   * @returns {string|null} null bila tak dikenal
   */
  function normalizePosition(label) {
    var s = String(label == null ? '' : label).trim().toUpperCase().replace(/\s+/g, '');
    if (s === '') return null;
    if (s === 'N' || s === 'NEU' || s === 'NEUTRAL') return 'N';
    // "R3" / "REV3" / "3R" / "R-3"
    var m = /^(?:REV|R)?[-]?([123])(?:R|REV)?$/.exec(s);
    if (m) return 'R' + m[1];
    // "F3" / "FWD3" / "3F"
    var m2 = /^(?:FWD|F)?[-]?([123])(?:F|FWD)?$/.exec(s);
    if (m2) return 'F' + m2[1];
    return null;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse teks berkas T/M Shift Change Map.
   *
   * @param {string} text
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} hasil matriks + indikator turunan
   */
  function parse(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r\n|\n|\r/);

    var result = {
      kind: 'shiftMap',
      dataType: '',
      dataTitle: '',
      // Judul sumbu APA ADANYA dari berkas.
      xAxisTitle: '',
      xAxisScale: '',
      yAxisTitle: '',
      yAxisScale: '',
      zAxisTitle: '',
      zAxisScale: '',
      meta: {},
      colLabels: [],        // label Tujuan (To)
      rowLabels: [],        // label Asal (From)
      matrix: [],           // matrix[from][to] = jumlah
      cells: [],            // daftar { from, to, count } tanpa diagonal
      indicators: null,
      warnings: []
    };

    var section = '';
    var inData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      var secMatch = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (secMatch) {
        section = secMatch[1].toLowerCase();
        inData = /^data/.test(section);
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);

      // --- Header umum / display ---
      if (section === 'common header' || section === 'version information' ||
          section === 'display information') {
        var key = String(cells[0] || '').trim();
        var val = cells.length > 1 ? String(cells[1] || '').trim() : '';
        if (key) result.meta[key.toLowerCase()] = val;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = val || result.dataType;
          result.dataTitle = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxisTitle = val;
          result.xAxisScale = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxisTitle = val;
          result.yAxisScale = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxisTitle = val;
          result.zAxisScale = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        // Label kolom (Tujuan) — "Column Item,R3,R2,R1,N,F1,F2,F3"
        if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (c) { return String(c || '').trim(); })
            .filter(function (c) { return c !== ''; });
        }
        continue;
      }

      // --- Blok data ---
      if (!inData) continue;

      // "Column Item" bisa juga muncul setelah [Data] pada varian exporter.
      if (/^column item$/i.test(String(cells[0] || '').trim())) {
        result.colLabels = cells.slice(1).map(function (c) { return String(c || '').trim(); })
          .filter(function (c) { return c !== ''; });
        continue;
      }

      var rowPos = normalizePosition(cells[0]);
      if (rowPos === null) continue;     // bukan baris posisi -> abaikan

      var row = [];
      for (var c = 1; c < cells.length; c++) {
        row.push(toNum(cells[c]));
      }
      result.rowLabels.push(rowPos);
      result.matrix.push(row);
    }

    if (!result.rowLabels.length) {
      result.warnings.push(
        'Tidak ada baris posisi transmisi yang terbaca. Periksa apakah berkas ' +
        'benar-benar T/M Shift Change Map (tipe 83).');
      return result;
    }

    result.dataType = String(opts.dataType || result.dataType || '').trim();
    if (!result.xAxisTitle) result.xAxisTitle = 'To';
    if (!result.yAxisTitle) result.yAxisTitle = 'From';

    // Samakan jumlah label kolom dengan lebar matriks.
    var width = 0;
    result.matrix.forEach(function (r) { if (r.length > width) width = r.length; });
    if (result.colLabels.length !== width) {
      // Bila label kolom tidak lengkap, pakai urutan posisi baku sebagai fallback.
      if (result.colLabels.length === 0) {
        result.colLabels = POSITION_ORDER.slice(0, width);
      } else {
        result.warnings.push(
          'Jumlah label kolom (' + result.colLabels.length + ') tidak sama dengan ' +
          'lebar matriks (' + width + ') — label tidak dipetakan.');
      }
    }

    buildIndicators(result);
    return result;
  }

  /**
   * Turunkan indikator dari matriks mentah.
   * Mengisi `result.cells` dan `result.indicators`.
   */
  function buildIndicators(result) {
    var rows = result.rowLabels;
    var cols = result.colLabels;
    var m = result.matrix;

    var colTotals = [];
    var rowTotals = [];
    var totalShift = 0, selfShift = 0;
    var forwardShift = 0, reverseShift = 0, neutralShift = 0;
    var cells = [];
    var unknowns = {};
    var biggest = { from: null, to: null, count: -1 };

    for (var ri = 0; ri < rows.length; ri++) {
      var from = rows[ri];
      var rowSum = 0;
      for (var ci = 0; ci < m[ri].length; ci++) {
        var v = m[ri][ci];
        if (v === null || v === undefined || isNaN(v)) continue;
        var to = cols[ci] || ('#' + ci);

        if (!colTotals[ci]) colTotals[ci] = 0;
        colTotals[ci] += v;
        rowSum += v;

        if (from === to) {
          // Diagonal: "perpindahan" ke posisi yang sama secara fisik mustahil.
          selfShift += v;
          continue;                       // TIDAK dihitung sebagai perpindahan
        }

        totalShift += v;
        var dir = POSITION_DIR[to] || 'unknown';
        if (dir === 'forward') forwardShift += v;
        else if (dir === 'reverse') reverseShift += v;
        else if (dir === 'neutral') neutralShift += v;
        else unknowns[to] = (unknowns[to] || 0) + v;

        cells.push({ from: from, to: to, count: v, dir: dir });
        if (v > biggest.count) biggest = { from: from, to: to, count: v };
      }
      rowTotals.push(rowSum);
    }

    var top = cells.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, TOP_N);

    function ratio(x) { return totalShift > 0 ? (x / totalShift) * 100 : null; }

    result.cells = cells;
    result.indicators = {
      totalShift: totalShift,
      selfShift: selfShift,
      forwardShift: forwardShift,
      reverseShift: reverseShift,
      neutralShift: neutralShift,
      reverseRatio: ratio(reverseShift),
      neutralRatio: ratio(neutralShift),
      // Perpindahan yang arahnya tak dapat diklasifikasi (label kolom aneh).
      unknownShift: Object.keys(unknowns).reduce(function (a, k) { return a + unknowns[k]; }, 0),
      unknownTo: Object.keys(unknowns),
      biggestCell: biggest.count >= 0 ? biggest : null,
      rowTotals: rowTotals,
      colTotals: colTotals,
      topTransitions: top
    };

    // --- Peringatan kejujuran data ---
    if (selfShift > 0) {
      result.warnings.push(
        'Diagonal From = To berisi ' + selfShift + ' kejadian. Secara fisik ' +
        'perpindahan ke posisi yang sama tidak mungkin — nilai ini DIABAIKAN ' +
        'dalam total dan patut diperiksa (kemungkinan artefak ekspor).');
    }
    if (result.indicators.unknownShift > 0) {
      result.warnings.push(
        'Ada perpindahan menuju posisi yang tidak dikenali (' +
        result.indicators.unknownTo.join(', ') + ') sebanyak ' +
        result.indicators.unknownShift + '. Tidak ikut klasifikasi arah.');
    }
  }

  /* -----------------------------------------------------------------------
   * 5. Ekspor
   * --------------------------------------------------------------------- */
  global.VHMS_SHIFTMAP = {
    SHIFTMAP_TYPE: SHIFTMAP_TYPE,
    POSITION_ORDER: POSITION_ORDER,
    POSITION_DIR: POSITION_DIR,
    TOP_N: TOP_N,

    isShiftMapType: isShiftMapType,
    normalizePosition: normalizePosition,
    parse: parse
  };

})(typeof window !== 'undefined' ? window : globalThis);

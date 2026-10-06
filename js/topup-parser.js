/* =========================================================================
 * topup-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk file "Top Up Oil" (export konsumsi oli/material).
 * Sumber kolom: Template Top Up Oil.csv
 *
 * Kolom yang DIAMBIL (sesuai permintaan):
 *   Equipment            -> No Lambung
 *   Eq. Model            -> Model
 *   Consumtion Type      -> status; HANYA ambil kode TOU & RPR (SVC dikecualikan)
 *   Cmp Desc             -> Kompartemen
 *   Posting Date         -> tanggal top up ("23-Jul-26" -> dd-Mon-yy)
 *   Quantity             -> Qty Top Up
 *   Base Unit of Measure -> satuan (selalu "L")
 *
 * Output: array baris ternormalisasi, di-index per nomor lambung.
 * ========================================================================= */

(function (global) {
  'use strict';

  // Kode Consumtion Type yang dianggap "top up" (SVC = servis rutin, dibuang).
  var TOPUP_CODES = { 'TOU': true, 'RPR': true };

  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  /* -----------------------------------------------------------------------
   * Utilitas CSV
   * [KONSOLIDASI 2026-10-04 · B-1] Delegasi ke CSV_UTIL (satu definisi
   * bersama). Fallback lokal dipertahankan bila csv-util belum termuat.
   * --------------------------------------------------------------------- */
  var _csv = global.CSV_UTIL || {};

  function normKey(s) {
    if (_csv.normKey) return _csv.normKey(s);
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }
  function normHeader(s) {
    if (_csv.normHeader) return _csv.normHeader(s);
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()%]+/g, '');
  }
  function splitLine(line, delim) {
    if (_csv.splitLine) return _csv.splitLine(line, delim);
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }
  function detectDelim(line) {
    if (_csv.detectDelim) return _csv.detectDelim(line);
    var cand = [',', ';', '\t'];
    var best = ',', bestN = 0;
    cand.forEach(function (d) {
      var n = line.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }
  function findColIndex(headers, aliases) {
    if (_csv.findColIndex) return _csv.findColIndex(headers, aliases);
    for (var a = 0; a < aliases.length; a++) {
      var target = normHeader(aliases[a]);
      for (var i = 0; i < headers.length; i++) {
        if (normHeader(headers[i]) === target) return i;
      }
    }
    return -1;
  }

  /* -----------------------------------------------------------------------
   * Konversi nilai
   * --------------------------------------------------------------------- */
  function toNum(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-') return null;
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.indexOf(',') !== -1) {
      s = s.replace(',', '.');
    }
    var n = parseFloat(s.replace(/[^0-9.\-eE]/g, ''));
    return isNaN(n) ? null : n;
  }

  /**
   * Tanggal file top up. Format SAP "Posting Date" yang TERBUKTI di data:
   *   "9/26/2026"  -> Month/Day/Year (US)  => 26 September 2026.
   * Selain itu didukung: "23-Jul-26" (dd-Mon-yy), ISO "YYYY-MM-DD", "dd/mm/yyyy".
   *
   * [FIX 2026-10-01] Sebelumnya format angka diasumsikan dd/mm/yyyy -> tanggal
   * seperti "9/26/2026" salah (jadi Feb 2027) & "12/31/2026" meluber ke 2028.
   * Sekarang DISAMBIGUASI: bila salah satu komponen >12 -> komponen itu hari;
   * bila ambigu (keduanya <=12) -> default US (Month/Day) sesuai ekspor SAP.
   * @param {string} raw
   * @param {string} [order] 'MDY' | 'DMY' — paksa urutan (opsional).
   * @returns {{iso:string, display:string, epoch:number}|null}
   */
  function toDate(raw, order) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '') return null;

    var d = null;
    var m;
    // "23-Jul-26" atau "23-Jul-2026" (dd-Mon-yy/yyyy), pemisah - atau / atau spasi
    m = s.match(/^(\d{1,2})[\-\/ ]([A-Za-z]{3,})[\-\/ ](\d{2,4})$/);
    if (m) {
      var day = parseInt(m[1], 10);
      var mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      var yr = parseInt(m[3], 10);
      if (yr < 100) yr += 2000;
      if (mon !== undefined) d = new Date(yr, mon, day);
    }
    // ISO: YYYY-MM-DD
    if (!d && /^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s);
    // Numerik murni: "M/D/YYYY", "D/M/YYYY", atau 2-digit tahun.
    if (!d) {
      m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
        if (y < 100) y += 2000;
        var aIsDay, bIsDay;
        if (order === 'MDY') { aIsDay = false; bIsDay = true; }
        else if (order === 'DMY') { aIsDay = true; bIsDay = false; }
        else if (a > 12 && b <= 12) { aIsDay = true; bIsDay = false; }   // 26/9 -> day first
        else if (b > 12 && a <= 12) { aIsDay = false; bIsDay = true; }  // 9/26 -> month first (US)
        else { aIsDay = false; bIsDay = true; }                         // ambigu -> default US (SAP)
        var dayN = aIsDay ? a : b;
        var monN = (aIsDay ? b : a) - 1;
        if (monN >= 0 && monN <= 11 && dayN >= 1 && dayN <= 31) d = new Date(y, monN, dayN);
      }
    }
    if (!d) d = new Date(s);
    if (!d || isNaN(d.getTime())) return null;

    function pad2(n) { return String(n).padStart(2, '0'); }
    return {
      epoch: d.getTime(),
      iso: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
      display: pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear()
    };
  }

  /* -----------------------------------------------------------------------
   * Parser utama
   * ---------------------------------------------------------------------
   * @param {string} text   isi file CSV
   * @param {object} [opts] { includeAll: true } untuk mengambil SEMUA jenis
   *                        (default false = hanya TOU & RPR).
   * @returns {object} { rows, byLambung, count, skipped, excluded, hasHeader,
   *                     codes: {TOU:n, RPR:n, SVC:n, lain:n} }
   * ---------------------------------------------------------------------
   * row = { lambung, model, component, date(obj), qty, unit, type }
   * --------------------------------------------------------------------- */
  function parse(text, opts) {
    opts = opts || {};
    var includeAll = !!opts.includeAll;

    var lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('File Top Up Oil kosong.');

    var delim = detectDelim(lines[0]);
    var headers = splitLine(lines[0], delim);

    var idx = {
      lambung:   findColIndex(headers, ['Equipment', 'No Lambung', 'Lambung', 'Equipment Number']),
      model:     findColIndex(headers, ['Eq. Model', 'Eq Model', 'Model']),
      type:      findColIndex(headers, ['Consumtion Type', 'Consumption Type', 'Type']),
      component: findColIndex(headers, ['Cmp Desc', 'Component', 'Kompartemen', 'Cmp Description']),
      date:      findColIndex(headers, ['Posting Date', 'Date', 'Tanggal']),
      qty:       findColIndex(headers, ['Quantity', 'Qty', 'Qty Top Up']),
      unit:      findColIndex(headers, ['Base Unit of Measure', 'UoM', 'Unit', 'Satuan'])
    };

    if (idx.lambung === -1) {
      throw new Error('Kolom "Equipment" (No Lambung) tidak ditemukan. Pastikan ini file Top Up Oil yang benar.');
    }

    var hasHeader = true;
    var rows = [], byLambung = {}, skipped = 0, excluded = 0;
    var codes = { TOU: 0, RPR: 0, SVC: 0, OTHER: 0 };

    for (var i = 1; i < lines.length; i++) {
      var c = splitLine(lines[i], delim);
      if (c.length <= idx.lambung) { skipped++; continue; }

      var lambung = (c[idx.lambung] || '').trim();
      if (!lambung) { skipped++; continue; }

      var type = idx.type !== -1 ? (c[idx.type] || '').trim().toUpperCase() : '';
      // Hitung distribusi kode
      if (type === 'TOU') codes.TOU++;
      else if (type === 'RPR') codes.RPR++;
      else if (type === 'SVC') codes.SVC++;
      else codes.OTHER++;

      // Filter: hanya TOU & RPR (kecuali includeAll)
      if (!includeAll && !TOPUP_CODES[type]) { excluded++; continue; }

      var row = {
        lambung: lambung,
        model: idx.model !== -1 ? (c[idx.model] || '').trim() : '',
        component: idx.component !== -1 ? (c[idx.component] || '').trim() : '',
        date: idx.date !== -1 ? toDate(c[idx.date]) : null,
        qty: idx.qty !== -1 ? toNum(c[idx.qty]) : null,
        unit: idx.unit !== -1 ? (c[idx.unit] || '').trim() : '',
        type: type
      };

      rows.push(row);
      var key = normKey(lambung);
      if (!byLambung[key]) byLambung[key] = [];
      byLambung[key].push(row);
    }

    return {
      rows: rows,
      byLambung: byLambung,
      count: rows.length,
      skipped: skipped,
      excluded: excluded,
      hasHeader: hasHeader,
      codes: codes
    };
  }

  /* ----------------------------------------------------------------------- */
  global.TOPUP_PARSER = {
    parse: parse,
    normKey: normKey,
    toNum: toNum,
    toDate: toDate,
    TOPUP_CODES: TOPUP_CODES
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TOPUP_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

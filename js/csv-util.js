/* =========================================================================
 * csv-util.js
 * -------------------------------------------------------------------------
 * Shared CSV utilities for all parsers (VHMS, SOS, Lifetime, TopUp, Unit DB, Section).
 * Handles quoting, delimiter detection, key/header normalization, and locale numbers.
 * ========================================================================= */

(function (global) {
  'use strict';

  /** Normalisasi kunci serial/lambung: buang spasi/tanda, uppercase. */
  function normKey(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /** Normalisasi nama header kolom: lowercase, buang spasi/tanda/kurung. */
  function normHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()%]+/g, '');
  }

  /**
   * Pisah baris CSV dengan dukungan tanda kutip ganda RFC 4180 (`""`).
   * @param {string} line
   * @param {string} [delim=',']
   * @returns {string[]}
   */
  function splitLine(line, delim) {
    var d = delim || ',';
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === d) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }

  /**
   * Pisah baris CSV dengan MULTI-delimiter: koma (,) / titik-koma (;) / tab (\t)
   * SEMUA diperlakukan sebagai pemisah sekaligus (bukan dipilih salah satu).
   * Dukungan escape kutip ganda `""`. Perilaku ini identik dengan yang dipakai
   * parser SOS (yang menerima file ekspor lab dengan pemisah campuran).
   *
   * [KONSOLIDASI 2026-10-04] Ditambahkan agar sos-parser dapat men-delegasi
   * splitCsvLine-nya tanpa perubahan perilaku.
   * @param {string} line
   * @returns {string[]}
   */
  function splitMulti(line) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQ = false; }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',' || ch === ';' || ch === '\t') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }

  /** Deteksi delimiter dominan (, ; \t) dari satu atau beberapa baris. */
  function detectDelim(line) {
    if (!line) return ',';
    var cand = [',', ';', '\t'];
    var best = ',', bestN = 0;
    for (var i = 0; i < cand.length; i++) {
      var d = cand[i];
      var n = line.split(d).length - 1;
      if (n > bestN) {
        bestN = n;
        best = d;
      }
    }
    return best;
  }

  /** Cari indeks kolom berdasar daftar alias nama header. */
  function findColIndex(headers, aliases) {
    if (!headers || !aliases) return -1;
    for (var a = 0; a < aliases.length; a++) {
      var target = normHeader(aliases[a]);
      for (var i = 0; i < headers.length; i++) {
        if (normHeader(headers[i]) === target) return i;
      }
    }
    return -1;
  }

  /**
   * Konversi string ke angka aman locale Indonesia ("1.234,5") maupun baku ("1234.5").
   * Nilai kosong/strip menghasilkan null.
   */
  function toNum(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-' || s === '—' || s === 'N/A' || s === 'NA') return null;
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.indexOf(',') !== -1) {
      s = s.replace(',', '.');
    }
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /** Escape string untuk output CSV. */
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(';') !== -1 || s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  var CSV_UTIL = {
    normKey: normKey,
    normHeader: normHeader,
    splitLine: splitLine,
    splitMulti: splitMulti,
    detectDelim: detectDelim,
    findColIndex: findColIndex,
    toNum: toNum,
    csvEscape: csvEscape
  };

  global.CSV_UTIL = CSV_UTIL;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CSV_UTIL;
  }
})(typeof window !== 'undefined' ? window : globalThis);

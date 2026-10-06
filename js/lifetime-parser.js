/* =========================================================================
 * lifetime-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk file "Lifetime Unit" (export lifecycle komponen).
 * Sumber kolom: Template Life time.csv
 *
 * Kolom yang DIAMBIL (sesuai permintaan):
 *   EquipmentNumber        -> No Lambung
 *   ModelUnit              -> Model
 *   Component              -> Kompartemen
 *   CyclePerComponent      -> Cycle budget (jam)
 *   LastTecoDate           -> Last Install (tanggal)
 *   LastTotalCountReading  -> HM Install
 *   TotalCountReading      -> HM / Umur Unit
 *   MeterRunComponent      -> Umur kompartemen terpakai (jam)
 *   ComponentLife(%)       -> Umur kompartemen (%)
 * (Kolom Status TIDAK diambil.)
 *
 * Output: array baris ternormalisasi, di-index per nomor lambung.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Utilitas CSV
   * [KONSOLIDASI 2026-10-04 · B-1] Delegasi ke CSV_UTIL (satu definisi
   * bersama). Fallback lokal bila csv-util belum termuat.
   * --------------------------------------------------------------------- */
  var _csv = global.CSV_UTIL || {};

  /** Normalisasi kunci: buang spasi/tanda, uppercase. */
  function normKey(s) {
    if (_csv.normKey) return _csv.normKey(s);
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /** Normalisasi nama header: lowercase, buang spasi/tanda/kurung. */
  function normHeader(s) {
    if (_csv.normHeader) return _csv.normHeader(s);
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()%]+/g, '');
  }

  /** Pisah baris CSV (dukung kutip + pemisah koma/titik-koma/tab). */
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

  /** Deteksi delimiter dominan dari sebuah baris. */
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

  /** Cari indeks kolom berdasar daftar alias nama header. */
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

  /** Angka locale-aman: "18391" / "20121.1" / "1.234,5" -> Number|null. */
  function toNum(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-') return null;
    // Bila ada koma DAN titik: asumsikan titik = ribuan, koma = desimal
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.indexOf(',') !== -1) {
      s = s.replace(',', '.');
    }
    var n = parseFloat(s.replace(/[^0-9.\-eE]/g, ''));
    return isNaN(n) ? null : n;
  }

  /**
   * Tanggal format file lifetime: "6/26/2023" (M/D/YYYY) atau ISO.
   * Mengembalikan { iso:'YYYY-MM-DD', display:'DD/MM/YYYY', epoch } | null.
   */
  function toDate(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || /^original$/i.test(s)) return null;

    var d = null;
    // ISO: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      d = new Date(s);
    } else {
      // M/D/YYYY atau MM/DD/YYYY (file lifetime memakai format US)
      var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        var mo = parseInt(m[1], 10), da = parseInt(m[2], 10), yr = parseInt(m[3], 10);
        if (yr < 100) yr += 2000;
        d = new Date(yr, mo - 1, da);
      } else {
        d = new Date(s);
      }
    }
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
   * @param {string} text  isi file CSV
   * @returns {object} { rows: [...], byLambung: {lambungNorm: [row,...]},
   *                     count, skipped, hasHeader }
   * ---------------------------------------------------------------------
   * row = {
   *   lambung, model, component,
   *   cycleBudget, installDate (obj), installHM, currentHM,
   *   ageHours (= MeterRunComponent), lifePct, remainingHours
   * }
   * --------------------------------------------------------------------- */
  function parse(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('File Lifetime kosong.');

    var delim = detectDelim(lines[0]);
    var headers = splitLine(lines[0], delim);

    // Pemetaan kolom (alias agar tahan variasi nama header)
    var idx = {
      lambung:   findColIndex(headers, ['EquipmentNumber', 'Equipment Number', 'No Lambung', 'Lambung']),
      model:     findColIndex(headers, ['ModelUnit', 'Model Unit', 'Model']),
      serial:    findColIndex(headers, ['SerialNumber', 'Serial Number', 'SN', 'Machine Serial No.']),
      component: findColIndex(headers, ['Component', 'Kompartemen', 'Component Desc']),
      budget:    findColIndex(headers, ['CyclePerComponent', 'Cycle Per Component', 'Cycle Budget']),
      instDate:  findColIndex(headers, ['LastTecoDate', 'Last Teco Date', 'Last Install']),
      instHM:    findColIndex(headers, ['LastTotalCountReading', 'Last Total Count Reading', 'HM Install']),
      currentHM: findColIndex(headers, ['TotalCountReading', 'Total Count Reading', 'HM']),
      ageHours:  findColIndex(headers, ['MeterRunComponent', 'Meter Run Component']),
      lifePct:   findColIndex(headers, ['ComponentLife(%)', 'ComponentLife', 'Component Life'])
    };

    // Kolom wajib minimal
    if (idx.lambung === -1) {
      throw new Error('Kolom "EquipmentNumber" (No Lambung) tidak ditemukan. Pastikan ini file Lifetime yang benar.');
    }
    if (idx.component === -1) {
      throw new Error('Kolom "Component" (Kompartemen) tidak ditemukan.');
    }

    var hasHeader = true;   // asumsi baris pertama header (file ini punya header)
    var rows = [], byLambung = {}, skipped = 0;

    for (var i = 1; i < lines.length; i++) {
      var c = splitLine(lines[i], delim);
      if (c.length <= idx.lambung) { skipped++; continue; }

      var lambung = (c[idx.lambung] || '').trim();
      if (!lambung) { skipped++; continue; }

      var cycleBudget = idx.budget !== -1 ? toNum(c[idx.budget]) : null;
      var ageHours = idx.ageHours !== -1 ? toNum(c[idx.ageHours]) : null;

      var row = {
        lambung: lambung,
        model: idx.model !== -1 ? (c[idx.model] || '').trim() : '',
        serial: idx.serial !== -1 ? (c[idx.serial] || '').trim() : '',
        component: idx.component !== -1 ? (c[idx.component] || '').trim() : '',
        cycleBudget: cycleBudget,
        installDate: idx.instDate !== -1 ? toDate(c[idx.instDate]) : null,
        installHM: idx.instHM !== -1 ? toNum(c[idx.instHM]) : null,
        currentHM: idx.currentHM !== -1 ? toNum(c[idx.currentHM]) : null,
        ageHours: ageHours,
        lifePct: idx.lifePct !== -1 ? toNum(c[idx.lifePct]) : null
      };
      // Sisa jam = cycle budget - umur terpakai (boleh negatif = over)
      row.remainingHours = (cycleBudget !== null && ageHours !== null)
        ? (cycleBudget - ageHours) : null;
      // [ALIAS] totalHM = HM/umur unit saat ini (dari TotalCountReading)
      // Dipakai di laporan sbg kolom "Total HM".
      row.totalHM = row.currentHM;

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
      hasHeader: hasHeader
    };
  }

  /* ----------------------------------------------------------------------- */
  global.LIFETIME_PARSER = {
    parse: parse,
    normKey: normKey,
    toNum: toNum,
    toDate: toDate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LIFETIME_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

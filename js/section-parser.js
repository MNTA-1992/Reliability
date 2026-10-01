/* =========================================================================
 * section-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk file "Section Unit" (pemetaan unit ke seksi/site).
 * Header CSV yang diharapkan:  SN, Nomor Lambung, Section
 *
 * [FITUR 2026-09-30] Dipakai halaman PORTOFOLIO untuk:
 *   - Mengisi dropdown "Section" (di samping No. Lambung).
 *   - Memfilter daftar unit pada dropdown No. Lambung per Section.
 *
 * Output: { rows, byLambung, bySn, sections, count, skipped, hasHeader }
 *   row = { sn, lambung, section }
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Utilitas CSV (konsisten dgn topup-parser.js / vhms-unit-db.js)
   * --------------------------------------------------------------------- */
  function normKey(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }
  function normHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()%]+/g, '');
  }
  function splitLine(line, delim) {
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
    var cand = [',', ';', '\t'];
    var best = ',', bestN = 0;
    cand.forEach(function (d) {
      var n = line.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }
  function findColIndex(headers, aliases) {
    for (var a = 0; a < aliases.length; a++) {
      var target = normHeader(aliases[a]);
      for (var i = 0; i < headers.length; i++) {
        if (normHeader(headers[i]) === target) return i;
      }
    }
    return -1;
  }

  /* -----------------------------------------------------------------------
   * Parser utama
   * ---------------------------------------------------------------------
   * @param {string} text  isi file CSV
   * @returns {object} { rows, byLambung, bySn, sections, count, skipped, hasHeader }
   * --------------------------------------------------------------------- */
  function parse(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('File Section kosong.');

    var delim = detectDelim(lines[0]);
    var headers = splitLine(lines[0], delim);

    var idx = {
      sn:      findColIndex(headers, ['SN', 'Serial', 'Serial No', 'Serial Number', 'Machine Serial No.']),
      lambung: findColIndex(headers, ['Nomor Lambung', 'No Lambung', 'Lambung', 'Equipment', 'Equipment Number']),
      section: findColIndex(headers, ['Section', 'Seksi', 'Site', 'Area'])
    };

    if (idx.lambung === -1) {
      throw new Error('Kolom "Nomor Lambung" tidak ditemukan. Header yang diharapkan: SN, Nomor Lambung, Section.');
    }
    if (idx.section === -1) {
      throw new Error('Kolom "Section" tidak ditemukan. Header yang diharapkan: SN, Nomor Lambung, Section.');
    }

    var rows = [], byLambung = {}, bySn = {}, sections = {}, skipped = 0;

    for (var i = 1; i < lines.length; i++) {
      var c = splitLine(lines[i], delim);
      if (c.length <= idx.lambung) { skipped++; continue; }

      var lambung = (c[idx.lambung] || '').trim();
      if (!lambung) { skipped++; continue; }

      var row = {
        sn: idx.sn !== -1 ? (c[idx.sn] || '').trim() : '',
        lambung: lambung,
        section: (c[idx.section] || '').trim()
      };

      rows.push(row);
      var kLb = normKey(lambung);
      byLambung[kLb] = row;                 // 1 lambung -> 1 section (baris terakhir menang)
      if (row.sn) bySn[normKey(row.sn)] = row;
      if (row.section) sections[row.section] = (sections[row.section] || 0) + 1;
    }

    return {
      rows: rows,
      byLambung: byLambung,
      bySn: bySn,
      sections: sections,
      count: rows.length,
      skipped: skipped,
      hasHeader: true
    };
  }

  /* ----------------------------------------------------------------------- */
  global.SECTION_PARSER = {
    parse: parse,
    normKey: normKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SECTION_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

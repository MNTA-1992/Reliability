/* =========================================================================
 * vhms-unit-db.js
 * -------------------------------------------------------------------------
 * [POIN 4] Database Unit — pemetaan Machine Serial No. -> Nomor Lambung.
 *
 * TANGGUNG JAWAB:
 *   - Membaca file CSV/teks database unit (kolom: SN + Nomor Lambung).
 *   - Menyimpan mapping di memori + localStorage (bertahan antar sesi).
 *   - Menyediakan lookup cepat getLambung(serial).
 *
 * FORMAT FILE YANG DIDUKUNG (fleksibel, deteksi otomatis):
 *   - Berpemisah koma atau titik-koma.
 *   - Nama kolom SN : "Machine Serial No.", "Serial No.", "SN", "Serial".
 *   - Nama kolom No. Lambung: "Nomor Lambung", "No Lambung", "Lambung",
 *     "Nomor Unit", "Unit Number", "Fleet No.".
 *   - Bila tidak ada header, diasumsikan kolom 1 = SN, kolom 2 = Nomor Lambung.
 * ========================================================================= */

(function (global) {
  'use strict';

  var LS_KEY = 'vhms.unitdb.v1';

  var map = {};         // normalized SN -> nomor lambung (string, asli)
  var rawMap = {};      // normalized SN -> SN asli (untuk tampilan)
  var meta = { count: 0, loadedAt: null, source: '' };

  /* -----------------------------------------------------------------------
   * Utilitas
   * --------------------------------------------------------------------- */

  /** Normalisasi kunci SN: buang spasi/tanda, uppercase. */
  function normSerial(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  function normHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()]+/g, '');
  }

  /** Pisah baris CSV (dukung kutip + pemisah koma/titik-koma/tab). */
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

  /** Deteksi delimiter dominan dari sebuah baris. */
  function detectDelim(line) {
    var cand = [',', ';', '\t'];
    var best = ',', bestN = 0;
    cand.forEach(function (d) {
      var n = line.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  /* -----------------------------------------------------------------------
   * Pengenalan kolom
   * --------------------------------------------------------------------- */
  var SN_KEYS = ['machineserialno', 'serialno', 'msn', 'sn', 'serial', 'machineserial'];
  var LB_KEYS = ['nomorlambung', 'nolambung', 'lambung', 'nomorunit', 'unitnumber',
                 'fleetno', 'nomorlambungunit', 'lambungunit', 'unitno'];

  function findColIndex(headers, keys) {
    for (var i = 0; i < headers.length; i++) {
      var h = normHeader(headers[i]);
      if (keys.indexOf(h) !== -1) return i;
    }
    // pencocokan longgar (mengandung)
    for (var j = 0; j < headers.length; j++) {
      var hj = normHeader(headers[j]);
      for (var k = 0; k < keys.length; k++) {
        if (hj.indexOf(keys[k]) !== -1) return j;
      }
    }
    return -1;
  }

  /* -----------------------------------------------------------------------
   * Parsing file database unit
   * --------------------------------------------------------------------- */
  /**
   * @param {string} text  isi file
   * @param {object} [opts] { merge: boolean } — default false (ganti seluruh map)
   * @returns {object} { added, skipped, total, hasHeader, replaced }
   */
  function parse(text, opts) {
    opts = opts || {};
    var merge = !!opts.merge;
    // Default: GANTI isi map (bukan menumpuk), agar unggahan DB baru
    // benar-benar menggantikan data lama.
    if (!merge) {
      map = {};
      rawMap = {};
    }

    var lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('File database unit kosong.');

    var delim = detectDelim(lines[0]);
    var first = splitLine(lines[0], delim);

    // Apakah baris pertama header?
    var idxSn = findColIndex(first, SN_KEYS);
    var idxLb = findColIndex(first, LB_KEYS);
    var hasHeader = (idxSn !== -1 && idxLb !== -1);

    var startRow = 0;
    if (!hasHeader) {
      // Tanpa header: asumsi kolom 0 = SN, kolom 1 = Nomor Lambung
      idxSn = 0; idxLb = 1;
      // Namun jika baris pertama tampak data (angka), proses dari baris 0
      startRow = 0;
    } else {
      startRow = 1;
    }

    var added = 0, skipped = 0;
    for (var i = startRow; i < lines.length; i++) {
      var cells = splitLine(lines[i], delim);
      if (cells.length <= Math.max(idxSn, idxLb)) { skipped++; continue; }
      var sn = cells[idxSn];
      var lb = cells[idxLb];
      if (!sn || !lb) { skipped++; continue; }
      var key = normSerial(sn);
      if (!key) { skipped++; continue; }
      map[key] = lb;
      rawMap[key] = sn;
      added++;
    }

    meta.count = Object.keys(map).length;
    meta.loadedAt = Date.now();
    return {
      added: added,
      skipped: skipped,
      total: meta.count,
      hasHeader: hasHeader,
      replaced: !merge
    };
  }

  /* -----------------------------------------------------------------------
   * Persistensi localStorage
   * --------------------------------------------------------------------- */
  function save(sourceName) {
    try {
      var payload = { map: map, rawMap: rawMap, meta: { count: meta.count, loadedAt: meta.loadedAt, source: sourceName || meta.source } };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
      meta.source = sourceName || meta.source;
      return true;
    } catch (e) {
      console.warn('Gagal menyimpan database unit ke localStorage:', e);
      return false;
    }
  }

  function loadFromStorage() {
    try {
      var s = localStorage.getItem(LS_KEY);
      if (!s) return false;
      var payload = JSON.parse(s);
      if (payload && payload.map) {
        map = payload.map || {};
        rawMap = payload.rawMap || {};
        meta.count = Object.keys(map).length;
        meta.loadedAt = payload.meta ? payload.meta.loadedAt : null;
        meta.source = payload.meta ? payload.meta.source : '';
        return meta.count > 0;
      }
    } catch (e) {
      console.warn('Gagal memuat database unit dari localStorage:', e);
    }
    return false;
  }

  function clear() {
    map = {}; rawMap = {};
    meta = { count: 0, loadedAt: null, source: '' };
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  /* -----------------------------------------------------------------------
   * Lookup
   * --------------------------------------------------------------------- */
  /** Ambil Nomor Lambung untuk SN tertentu (null bila tak ada). */
  function getLambung(serial) {
    if (!serial) return null;
    var key = normSerial(serial);
    return map[key] || null;
  }

  function has(serial) {
    if (!serial) return false;
    return !!map[normSerial(serial)];
  }

  function count() { return Object.keys(map).length; }
  function getMeta() { return { count: meta.count, loadedAt: meta.loadedAt, source: meta.source }; }

  /* ----------------------------------------------------------------------- */

  // Muat otomatis dari localStorage saat modul diinisialisasi
  loadFromStorage();

  global.VHMS_UNITDB = {
    parse: parse,
    save: save,
    load: loadFromStorage,
    clear: clear,
    getLambung: getLambung,
    has: has,
    count: count,
    getMeta: getMeta,
    normSerial: normSerial
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_UNITDB;
  }
})(typeof window !== 'undefined' ? window : globalThis);

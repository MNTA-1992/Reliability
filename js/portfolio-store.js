/* =========================================================================
 * portfolio-store.js
 * -------------------------------------------------------------------------
 * Penyimpan + penggabung data pendukung halaman PORTOFOLIO:
 *   - Lifetime Unit  (dari LIFETIME_PARSER)
 *   - Top Up Oil     (dari TOPUP_PARSER)
 *
 * Semua data di-index per NOMOR LAMBUNG (dinormalisasi) sehingga dapat
 * digabung dengan unit SOS (SOS_STORE.assetId) dan VHMS (via Database Unit).
 * ========================================================================= */

(function (global) {
  'use strict';

  // Normalisasi kunci lambung: buang spasi/tanda, uppercase.
  // Sama dengan normSerial di vhms-unit-db.js agar konsisten.
  function normLambung(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /**
   * Normalisasi nama kompartemen untuk keperluan PENCOCOKAN (bukan tampilan).
   * Contoh: "HYD OIL" -> "HYDOIL"; "FINAL DRIVE LH" -> "FINALDRIVELH".
   */
  function normComp(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Cocokkan nama kompartemen dari sumber berbeda.
   * Pencocokan dua arah + prioritas token terpanjang, sehingga:
   *   "ENGINE" vs "ENGINE"     -> cocok
   *   "SWING"  vs "SWING DRIVE"-> cocok
   *   "HYD"    vs "HYD OIL"    -> cocok
   * @returns {boolean}
   */
  function compMatches(a, b) {
    var na = normComp(a), nb = normComp(b);
    if (!na || !nb) return false;
    return na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
  }

  // ---- State ----
  var lifetime = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '' } };
  var topup = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '', codes: null } };

  /* -----------------------------------------------------------------------
   * Setter data
   * --------------------------------------------------------------------- */
  function setLifetime(parsed, sourceName) {
    lifetime = {
      byLambung: (parsed && parsed.byLambung) || {},
      rows: (parsed && parsed.rows) || [],
      meta: {
        count: (parsed && parsed.count) || 0,
        skipped: (parsed && parsed.skipped) || 0,
        loadedAt: Date.now(),
        source: sourceName || ''
      }
    };
    return lifetime.meta;
  }

  function setTopup(parsed, sourceName) {
    topup = {
      byLambung: (parsed && parsed.byLambung) || {},
      rows: (parsed && parsed.rows) || [],
      meta: {
        count: (parsed && parsed.count) || 0,
        excluded: (parsed && parsed.excluded) || 0,
        codes: (parsed && parsed.codes) || null,
        loadedAt: Date.now(),
        source: sourceName || ''
      }
    };
    return topup.meta;
  }

  function clearLifetime() {
    lifetime = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '' } };
  }
  function clearTopup() {
    topup = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '', codes: null } };
  }
  function clearAll() { clearLifetime(); clearTopup(); }

  /* -----------------------------------------------------------------------
   * Getter
   * --------------------------------------------------------------------- */
  function lifetimeMeta() { return lifetime.meta; }
  function topupMeta() { return topup.meta; }
  function hasLifetime() { return lifetime.rows.length > 0; }
  function hasTopup() { return topup.rows.length > 0; }

  /**
   * Ambil baris lifetime untuk sebuah lambung.
   * @param {string} lambung
   * @param {string} [component] bila diisi -> filter kompartemen yang cocok.
   * @returns {array}
   */
  function getLifetime(lambung, component) {
    var arr = lifetime.byLambung[normLambung(lambung)] || [];
    if (!component) return arr;
    return arr.filter(function (r) { return compMatches(r.component, component); });
  }

  /**
   * Ambil baris top up untuk sebuah lambung.
   * @param {string} lambung
   * @param {string} [component] bila diisi -> filter kompartemen yang cocok.
   * @returns {array}
   */
  function getTopup(lambung, component) {
    var arr = topup.byLambung[normLambung(lambung)] || [];
    if (!component) return arr;
    return arr.filter(function (r) { return compMatches(r.component, component); });
  }

  /**
   * Ringkasan top up untuk sebuah lambung (+ opsional kompartemen).
   * @returns {object} { count, totalQty, lastDate, firstDate, rows }
   */
  function topupSummary(lambung, component) {
    var arr = getTopup(lambung, component).slice();
    arr.sort(function (a, b) {
      var ea = a.date ? a.date.epoch : 0, eb = b.date ? b.date.epoch : 0;
      return eb - ea; // terbaru dulu
    });
    var total = 0, has = false;
    arr.forEach(function (r) { if (typeof r.qty === 'number') { total += r.qty; has = true; } });
    return {
      count: arr.length,
      totalQty: has ? Math.round(total * 10) / 10 : null,
      lastDate: arr.length && arr[0].date ? arr[0].date : null,
      firstDate: arr.length && arr[arr.length - 1].date ? arr[arr.length - 1].date : null,
      rows: arr
    };
  }

  /**
   * Ringkasan lifetime untuk sebuah lambung (+ opsional kompartemen).
   * Bila ada beberapa baris komponen -> ambil yang paling "terpakai" (lifePct
   * terbesar) sebagai representasi, dan kembalikan juga semua baris.
   * @returns {object} { row, rows, lifePct, ageHours, remainingHours, cycleBudget }
   */
  function lifetimeSummary(lambung, component) {
    var arr = getLifetime(lambung, component);
    if (!arr.length) return { row: null, rows: [] };
    // [EXACT-MATCH PRIORITY] Bila nama kompartemen yang diminta PERSIS sama
    // dengan salah satu baris (mis. "ENGINE" vs "ENGINE"; bukan "ENGINE DAMPER"),
    // pilih baris EXACT itu sebagai representasi — meski lifePct-nya lebih
    // rendah. Ini mencegah "ENGINE DAMPER" (yang ikut cocok via substring)
    // dianggap sebagai life ENGINE.
    var wantN = normComp(component);
    var exact = null;
    if (wantN) {
      for (var ei = 0; ei < arr.length; ei++) {
        if (normComp(arr[ei].component) === wantN) { exact = arr[ei]; break; }
      }
    }
    var best = exact;
    if (!best) {
      // Tidak ada exact match -> pakai lifePct tertinggi (perilaku lama).
      best = arr[0];
      arr.forEach(function (r) {
        var bp = (best.lifePct === null || best.lifePct === undefined) ? -Infinity : best.lifePct;
        var rp = (r.lifePct === null || r.lifePct === undefined) ? -Infinity : r.lifePct;
        if (rp > bp) best = r;
      });
    }
    return {
      row: best,
      rows: arr,
      lifePct: best.lifePct,
      ageHours: best.ageHours,
      remainingHours: best.remainingHours,
      cycleBudget: best.cycleBudget
    };
  }

  /**
   * Cari nomor lambung untuk sebuah unit berdasarkan identifier apa pun
   * (assetId/SN). Berguna saat menyambung unit SOS/VHMS.
   * Prioritas: cocokkan langsung di index lifetime/topup, lalu via Unit DB.
   */
  function resolveLambung(identifier, serial) {
    var cand = [normLambung(identifier)];
    if (lifetime.byLambung[cand[0]] || topup.byLambung[cand[0]]) return identifier;

    // Via Database Unit (SN -> lambung)
    var db = global.VHMS_UNITDB;
    if (db && db.getLambung && serial) {
      var lb = db.getLambung(serial);
      if (lb) return lb;
    }
    return identifier;
  }

  /* ----------------------------------------------------------------------- */
  global.PORTFOLIO_STORE = {
    normLambung: normLambung,
    normComp: normComp,
    compMatches: compMatches,
    setLifetime: setLifetime,
    setTopup: setTopup,
    clearLifetime: clearLifetime,
    clearTopup: clearTopup,
    clearAll: clearAll,
    lifetimeMeta: lifetimeMeta,
    topupMeta: topupMeta,
    hasLifetime: hasLifetime,
    hasTopup: hasTopup,
    getLifetime: getLifetime,
    getTopup: getTopup,
    topupSummary: topupSummary,
    lifetimeSummary: lifetimeSummary,
    resolveLambung: resolveLambung
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PORTFOLIO_STORE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

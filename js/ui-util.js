/* =========================================================================
 * ui-util.js
 * -------------------------------------------------------------------------
 * Utilitas UI bersama untuk SEMUA modul render/analitik ARPC.
 *
 * Alasan: sebelumnya `esc`, `fmt`, `fmtInt`, `setText`, `debounce`
 * diduplikasi di banyak file (esc ×5, fmt ×3, dst) dengan risiko drift.
 * File ini menjadi SATU-SATUNYA definisi. Modul lain mengonsumsi via
 * `global.UI_UTIL` (browser) atau `require('.../ui-util.js')` (Node/test).
 *
 * Dipakai oleh: vhms-render, sos-render, portfolio-render, vhms-cross-render,
 * vhms-settings, dan modul lain yang butuh format/escape.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Escape HTML — aman untuk innerHTML (mencegah XSS dari data CSV/user).
   * Menangani & < > " ' menjadi entitas. Null/undefined -> ''.
   * --------------------------------------------------------------------- */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Escape untuk atribut HTML (sama dgn esc, disediakan untuk kejelasan). */
  function escapeAttr(s) { return esc(s); }

  /* -----------------------------------------------------------------------
   * Format angka (locale Indonesia: 1.234,5)
   * --------------------------------------------------------------------- */
  function fmt(value, decimals) {
    if (value === null || value === undefined || (typeof value === 'number' && isNaN(value))) return '\u2014';
    var v = Number(value);
    if (isNaN(v)) return '\u2014';
    var d = (decimals === undefined || decimals === null) ? 1 : decimals;
    return v.toLocaleString('id-ID', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function fmtInt(value) {
    if (value === null || value === undefined) return '\u2014';
    var v = Number(value);
    if (isNaN(v)) return '\u2014';
    return v.toLocaleString('id-ID', { maximumFractionDigits: 0 });
  }

  /**
   * Format laju/trend (mis. slope per jam) TANPA notasi ilmiah, dengan jumlah
   * desimal menyesuaikan besaran agar angka penting tetap terbaca.
   */
  function fmtRate(value) {
    if (value === null || value === undefined) return '\u2014';
    var n = Number(value);
    if (isNaN(n)) return '\u2014';
    var v = Math.abs(n);
    var d;
    if (v === 0) d = 2;
    else if (v < 0.001) d = 6;
    else if (v < 0.01) d = 5;
    else if (v < 0.1) d = 4;
    else if (v < 1) d = 3;
    else if (v < 100) d = 2;
    else d = 1;
    return n.toLocaleString('id-ID', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  /* -----------------------------------------------------------------------
   * DOM helpers (no-op aman bila berjalan di Node tanpa document)
   * --------------------------------------------------------------------- */
  /** Set textContent sebuah elemen berdasarkan id (null-safe). */
  function setText(id, txt) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  /** Set innerHTML sebuah elemen berdasarkan id (null-safe). */
  function setHtml(id, html) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * Debounce — tunda pemanggilan fn sampai ms berlalu tanpa panggilan baru.
   * --------------------------------------------------------------------- */
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  var UI_UTIL = {
    esc: esc,
    escapeAttr: escapeAttr,
    fmt: fmt,
    fmtInt: fmtInt,
    fmtRate: fmtRate,
    setText: setText,
    setHtml: setHtml,
    debounce: debounce
  };

  global.UI_UTIL = UI_UTIL;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UI_UTIL;
  }
})(typeof window !== 'undefined' ? window : globalThis);

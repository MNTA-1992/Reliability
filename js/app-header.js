/* =========================================================================
 * app-header.js
 * -------------------------------------------------------------------------
 * SATU PEMILIK header global (`.app-header`) + baris unit aktif.
 *
 * [FIX AUDIT 2026-10-04 · tiket C-1] Sebelumnya tiga modul (vhms-render,
 * sos-render, sos-app) memutasi elemen header yang SAMA (#machine-*,
 * #header-*, #unit-bar-*) secara langsung. Tidak ada pemilik tunggal ->
 * rawan bug "header nyangkut" (identitas unit lama tersisa) dan saling
 * menimpa antar mode. Kini SEMUA mutasi header melewati API eksplisit di
 * file ini.
 *
 * API:
 *   APP_HEADER.setHome()                  -> mode Home/katalog (header ringkas)
 *   APP_HEADER.setVhms(analysis)          -> identitas + statistik unit VHMS
 *   APP_HEADER.setSos(unit)               -> identitas + statistik unit SOS
 *   APP_HEADER.applyUnitBar(text, badge)  -> baris unit aktif
 *
 * Modul ini adalah SATU-SATUNYA tempat yang boleh menyentuh elemen header
 * tersebut. Renderer lain cukup memanggil API di atas.
 * ========================================================================= */

(function (global) {
  'use strict';

  var ui = global.UI_UTIL || {};
  var esc = ui.esc || function (s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = ui.fmt || function (v, d) { if (v == null || isNaN(v)) return '\u2014'; var dd = (d == null) ? 1 : d; return Number(v).toLocaleString('id-ID', { minimumFractionDigits: dd, maximumFractionDigits: dd }); };

  function $(id) { return (typeof document === 'undefined') ? null : document.getElementById(id); }
  function setText(id, txt) { var el = $(id); if (el) el.textContent = txt; }
  function setDisplay(id, show) { var el = $(id); if (el) el.style.display = show ? '' : 'none'; }

  function headerEl() {
    return (typeof document === 'undefined') ? null : document.querySelector('.app-header');
  }

  /* -----------------------------------------------------------------------
   * [FIX 2026-10-04 · G-4] Sumber kebenaran tunggal untuk judul default.
   * Sebelumnya string default di-hardcode di 4 file dan BERBEDA dari <title>
   * di index.html, sehingga tab browser menampilkan teks yang tidak sesuai.
   * Kita simpan judul asli dari <title> SEKALI saat modul dimuat, lalu semua
   * reset title memakai nilai ini.
   * --------------------------------------------------------------------- */
  var DEFAULT_TITLE = (function () {
    try {
      if (typeof document !== 'undefined' && document.title) return document.title.trim();
    } catch (e) {}
    return 'Asset Reliability Performance Center (ARPC)';
  })();

  /** Judul default halaman (sesuai <title> di index.html). */
  function getDefaultTitle() { return DEFAULT_TITLE; }

  /** Set document.title ke judul default (aman, null-safe). */
  function setDefaultTitle() {
    try { if (typeof document !== 'undefined') document.title = DEFAULT_TITLE; } catch (e) {}
  }

  /* -----------------------------------------------------------------------
   * MODE HOME / KATALOG — header ringkas, tanpa identitas unit.
   * --------------------------------------------------------------------- */
  function setHome() {
    var header = headerEl();
    if (header) header.classList.add('header-compact');

    // Judul: brand tampil, span model disembunyikan.
    var brandEl = $('machine-brand');
    var modelEl = $('machine-model');
    if (brandEl) brandEl.style.display = '';
    if (modelEl) { modelEl.style.display = 'none'; modelEl.textContent = ''; }
    var h1 = document.querySelector('.header-title h1');
    if (h1) h1.title = '';

    // [FIX G-4] Pakai judul default dari <title> index.html (sumber tunggal).
    setDefaultTitle();

    // Chip identitas: semua disembunyikan kecuali SN netral.
    var famEl = $('machine-family');
    if (famEl) { famEl.textContent = '\u2014'; famEl.style.display = 'none'; famEl.style.borderColor = ''; famEl.style.color = ''; }
    var lbEl = $('machine-lambung');
    if (lbEl) { lbEl.textContent = 'Lambung: \u2014'; lbEl.style.display = 'none'; lbEl.style.borderColor = ''; lbEl.style.color = ''; }
    var snEl = $('machine-sn');
    if (snEl) { snEl.textContent = 'SN: \u2014'; snEl.style.display = ''; snEl.style.borderColor = ''; snEl.style.color = ''; }

    // Subjudul engine (bisa disembunyikan mode SOS).
    var engEl = $('machine-engine');
    if (engEl) {
      var engWrap = engEl.closest ? engEl.closest('.header-sub') : null;
      if (engWrap) engWrap.style.display = '';
      engEl.style.display = '';
    }
    setText('machine-engine', 'Engine: \u2014');

    // Statistik: kembalikan label VHMS default.
    setText('header-smr-label', 'Service Meter Reading');
    setText('header-health-label', 'Health Index');
    setText('header-rul-label', 'Sisa Operasi (RUL)');
    setText('header-smr', '\u2014');
    setText('header-time', '\u2014');
    var hi = $('header-health');
    if (hi) { hi.textContent = '\u2014'; hi.className = 'v'; hi.title = ''; }
    var rulEl = $('header-rul');
    if (rulEl) { rulEl.textContent = '\u2014'; rulEl.className = 'v mono'; rulEl.title = ''; }
    setDisplay('header-time-wrap', false);

    // Baris unit aktif ikut direset.
    setText('unit-bar-serial', '\u2014');
    var ub = $('unit-bar-badge');
    if (ub) { ub.textContent = '\u2014'; ub.className = 'badge'; }
    var ubEng = $('unit-bar-engine');
    if (ubEng) {
      ubEng.textContent = '\u2014';
      setDisplay('unit-bar-engine-wrap', false);
    }
    setText('header-file', '\u2014');

    // [FIX 2026-10-05] Footer ikut direset — tanpa ini identitas unit terakhir
    // tetap terpampang di footer meski sudah kembali ke katalog.
    clearFooter();
  }

  /* -----------------------------------------------------------------------
   * Helper chip & statistik bersama untuk mode unit (VHMS & SOS).
   * --------------------------------------------------------------------- */
  function header_startUnit() {
    var header = headerEl();
    if (header) header.classList.remove('header-compact');
    // Brand/ARPC disembunyikan oleh mode detail (digantikan judul unit).
    setDisplay('machine-brand', false);
  }

  function setFamilyChip(text, color) {
    var famEl = $('machine-family');
    if (!famEl) return;
    famEl.textContent = text || '\u2014';
    famEl.style.display = '';
    famEl.style.borderColor = color || '';
    famEl.style.color = color || '';
  }

  function hideLambungChip() {
    var lbEl = $('machine-lambung');
    if (lbEl) lbEl.style.display = 'none';
  }

  function setSnChip(text) {
    var snEl = $('machine-sn');
    if (!snEl) return;
    snEl.textContent = text;
    snEl.style.display = '';
    snEl.style.borderColor = '';
    snEl.style.color = '';
  }

  function hideEngineSubtitle() {
    var subEl = $('machine-engine');
    if (subEl) {
      var subWrap = subEl.closest ? subEl.closest('.header-sub') : null;
      (subWrap || subEl).style.display = 'none';
    }
    setText('machine-engine', '');
  }

  function setStats(smrLabel, smrVal, healthLabel, healthText, healthClass, healthTitle, rulLabel, rulText, rulClass, rulTitle) {
    setText('header-smr-label', smrLabel);
    setText('header-smr', smrVal);
    setText('header-health-label', healthLabel);
    var hi = $('header-health');
    if (hi) { hi.textContent = healthText; hi.className = 'v ' + (healthClass || ''); hi.title = healthTitle || ''; }
    setText('header-rul-label', rulLabel);
    var rulEl = $('header-rul');
    if (rulEl) { rulEl.textContent = rulText; rulEl.className = 'v ' + (rulClass || ''); rulEl.title = rulTitle || ''; }
  }

  function setTime(dateText) {
    if (dateText) { setDisplay('header-time-wrap', true); setText('header-time', dateText); }
    else setDisplay('header-time-wrap', false);
  }

  function applyUnitBar(text, badgeText, badgeClass) {
    setText('unit-bar-serial', text || '\u2014');
    var ub = $('unit-bar-badge');
    if (ub) { ub.textContent = badgeText || '\u2014'; ub.className = 'badge ' + (badgeClass || ''); }
  }

  /* -----------------------------------------------------------------------
   * MODE VHMS — identitas & statistik unit telemetri.
   * @param {object} analysis hasil VHMS_ANALYTICS.analyze()
   * --------------------------------------------------------------------- */
  function setVhms(analysis) {
    var m = (analysis && analysis.meta) || {};
    header_startUnit();

    // Judul unit: brand disembunyikan (lihat header_startUnit).
    var modelEl = $('machine-model');
    if (modelEl) modelEl.style.display = 'none';
    setDisplay('machine-family', false);
    setDisplay('machine-sn', false);
    setDisplay('machine-lambung', false);
    hideEngineSubtitle();

    // Statistik VHMS.
    setStats(
      'Service Meter Reading', fmt(analysis && analysis.smrRange ? analysis.smrRange.last : null, 1),
      'Health Index', '\u2014', '', '',
      'Sisa Operasi (RUL)', '\u2014', 'mono', ''
    );
    // Health label + warna.
    var hi = analysis && analysis.health ? analysis.health : {};
    var el = $('header-health');
    if (el) {
      el.textContent = hi.label || '\u2014';
      el.className = 'v ' + (hi.label === 'CRITICAL' ? 'warn' : (hi.label === 'NORMAL' ? 'ok' : ''));
    }
    // RUL.
    var rulEl = $('header-rul');
    if (rulEl && analysis && analysis.urgentRUL) {
      var u = analysis.urgentRUL;
      if (u.alreadyCritical) { rulEl.textContent = '0 jam'; rulEl.className = 'v warn'; rulEl.title = u.label + ' sudah melewati batas kritis'; }
      else if (u.hours === Infinity || u.hours > 50000) { rulEl.textContent = 'Stabil'; rulEl.className = 'v ok'; rulEl.title = 'Tidak ada parameter yang diprediksi mencapai batas kritis'; }
      else { rulEl.textContent = fmtIntSafe(u.hours) + ' jam'; rulEl.className = 'v ' + (u.hours <= 500 ? 'warn' : (u.hours <= 2000 ? '' : 'ok')); rulEl.title = u.label + ': estimasi ' + fmtIntSafe(u.hours) + ' jam sebelum critical'; }
    } else if (rulEl) {
      rulEl.textContent = '\u2014'; rulEl.className = 'v'; rulEl.title = '';
    }
    setTime(analysis ? analysis.lastTimestamp : '');
    setText('header-file', (analysis && analysis.sourceFile) || '\u2014');

    // Baris unit aktif: Lambung (SN) + level.
    var db = global.VHMS_UNITDB;
    var lb = (db && db.getLambung) ? db.getLambung(m.serial) : null;
    var unitLabel = lb ? (lb + (m.serial ? ' (SN ' + m.serial + ')' : '')) : ('SN ' + (m.serial || '\u2014'));
    applyUnitBar(unitLabel, (hi.label || '\u2014'), (hi.label || 'NORMAL'));

    // Engine di baris unit (huruf kapital).
    var engText = m.engineModel ? ('ENGINE: ' + String(m.engineModel).toUpperCase()) : '';
    var ubEng = $('unit-bar-engine');
    if (ubEng) {
      ubEng.textContent = engText || 'ENGINE: \u2014';
      setDisplay('unit-bar-engine-wrap', !!engText);
    }
  }

  function fmtIntSafe(v) { if (v == null || isNaN(v)) return '\u2014'; return Number(v).toLocaleString('id-ID', { maximumFractionDigits: 0 }); }

  /* -----------------------------------------------------------------------
   * MODE SOS — identitas & statistik unit analisis oli.
   * @param {object} unit unit SOS (assetId, component, mprs, criticality, ...)
   * --------------------------------------------------------------------- */
  function setSos(unit) {
    if (!unit) return;
    header_startUnit();

    // Judul statis "Result Oil Analysis".
    var modelEl = $('machine-model');
    if (modelEl) { modelEl.style.display = ''; modelEl.textContent = 'Result Oil Analysis'; }

    // Chip keluarga -> nama kompartemen (warna ungu khas SOS).
    setFamilyChip(unit.component || '\u2014', '#a78bfa');
    hideLambungChip();
    // Chip SN -> Asset ID.
    setSnChip('Unit: ' + (unit.assetId || '\u2014'));
    hideEngineSubtitle();

    // Statistik: HM Unit | MPRS | Criticality.
    setStats('HM Unit', fmt(unit.hmUnit, 0), 'MPRS', '\u2014', '', '', 'Criticality', '\u2014', '', '');
    var hi = $('header-health');
    if (hi) {
      hi.textContent = fmt(unit.mprs ? unit.mprs.mprs : null, 1);
      var tier = unit.mprs ? unit.mprs.tier : 0;
      hi.className = 'v ' + (tier >= 2 ? 'warn' : (tier === 1 ? '' : 'ok'));
    }
    var rulEl = $('header-rul');
    if (rulEl) {
      var band = (unit.criticality && unit.criticality.band) || 'NORMAL';
      rulEl.textContent = fmt(unit.criticality ? unit.criticality.score : null, 1) + ' (' + band + ')';
      rulEl.className = 'v ' + (band === 'CRITICAL' ? 'warn' : (band === 'CAUTION' || band === 'WARNING' ? '' : 'ok'));
    }
    setTime(unit.lastDate || '');

    // Baris unit aktif.
    applyUnitBar((unit.assetId || '\u2014') + ' \u2014 ' + (unit.component || ''),
      (global.SOS_CONFIG && global.SOS_CONFIG.TIER_LABELS ? global.SOS_CONFIG.TIER_LABELS[unit.mprs ? unit.mprs.tier : 0] : '\u2014') || '\u2014',
      (unit.mprs && unit.mprs.tier >= 2) ? 'CRITICAL' : (unit.mprs && unit.mprs.tier === 1 ? 'CAUTION' : 'NORMAL'));
  }

  /* -----------------------------------------------------------------------
   * FOOTER STATISTIK — SATU PEMILIK (pola sama seperti header, tiket C-1).
   *
   * [FIX 2026-10-05] Sebelumnya HANYA vhms-render.renderFooter() yang menulis
   * #footer-unit/#footer-points/#footer-range dan TIDAK ADA yang mereset.
   * Akibatnya identitas unit VHMS "nyangkut" di footer saat pengguna pindah
   * ke mode SOS atau membuka unit lain. Kini semua mode melewati API ini.
   * --------------------------------------------------------------------- */

  function setFooter(unitText, pointsText, rangeText) {
    setText('footer-unit', 'Unit: ' + (unitText || '\u2014'));
    setText('footer-points', 'Data Points: ' + (pointsText || '\u2014'));
    setText('footer-range', rangeText || 'SMR: \u2014');
  }

  /** Kosongkan footer (mode Home/katalog — tidak ada unit aktif). */
  function clearFooter() { setFooter(null, null, null); }

  /**
   * Footer mode VHMS.
   * @param {object} analysis hasil VHMS_ANALYTICS.analyze()
   */
  function setFooterVhms(analysis) {
    if (!analysis) { clearFooter(); return; }
    var m = analysis.meta || {};
    var n = (analysis.records && analysis.records.length) || 0;
    var r = analysis.smrRange || {};
    setFooter(
      (m.model || '\u2014') + ' #' + (m.serial || '\u2014'),
      fmtIntSafe(n) + ' record',
      'SMR: ' + fmt(r.min, 1) + ' \u2013 ' + fmt(r.max, 1) + ' jam'
    );
  }

  /**
   * Footer mode SOS. Rentang memakai HM Unit dari sampel yang ditampilkan.
   * @param {object} unit unit SOS (assetId, component, samples, model, ...)
   */
  function setFooterSos(unit) {
    if (!unit) { clearFooter(); return; }
    var samples = unit.samples || [];
    var lo = null, hi = null;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i] && samples[i].hm_unit;
      if (v == null || isNaN(v)) continue;
      v = Number(v);
      if (lo === null || v < lo) lo = v;
      if (hi === null || v > hi) hi = v;
    }
    var label = (unit.model ? unit.model + ' ' : '') + (unit.assetId || '\u2014') +
      (unit.component ? ' \u00b7 ' + unit.component : '');
    setFooter(
      label,
      fmtIntSafe(unit.sampleCount != null ? unit.sampleCount : samples.length) + ' sampel',
      'HM Unit: ' + fmt(lo, 0) + ' \u2013 ' + fmt(hi, 0) + ' jam'
    );
  }

  var APP_HEADER = {
    setHome: setHome,
    setVhms: setVhms,
    setSos: setSos,
    applyUnitBar: applyUnitBar,
    getDefaultTitle: getDefaultTitle,
    setDefaultTitle: setDefaultTitle,
    setFooterVhms: setFooterVhms,
    setFooterSos: setFooterSos,
    clearFooter: clearFooter
  };

  global.APP_HEADER = APP_HEADER;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = APP_HEADER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

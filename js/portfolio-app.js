/* =========================================================================
 * portfolio-app.js
 * -------------------------------------------------------------------------
 * Pengendali UI halaman PORTOFOLIO:
 *   - Membuka/menutup halaman #portfolio-area (menyembunyikan area VHMS/SOS)
 *   - Upload & parsing 2 data pendukung: Lifetime Unit & Top-Up Oil
 *   - Ganti mode (armada / per unit) & cetak
 * ========================================================================= */

(function (global) {
  'use strict';

  var AREA_VHMS = ['welcome-area', 'fleet-area', 'comparison-area', 'cross-area', 'dashboard-area'];
  var AREA_IDS = AREA_VHMS.concat(['sos-area']);

  function el(id) { return document.getElementById(id); }
  function toggle(id, show) { var e = el(id); if (e) e.classList.toggle('hidden', !show); }

  /* -----------------------------------------------------------------------
   * Buka / tutup halaman portofolio
   * --------------------------------------------------------------------- */
  function openPortfolio() {
    // Sembunyikan area mode lain
    AREA_IDS.forEach(function (id) { toggle(id, false); });
    var banner = el('alert-banner');
    if (banner) banner.classList.add('hidden');

    // Tampilkan area portofolio
    toggle('portfolio-area', true);

    // Isi dropdown unit & status data pendukung
    refreshUnitOptions();
    refreshDataStatus();

    // Render
    if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();

    // Scroll ke atas
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  function closePortfolio() {
    toggle('portfolio-area', false);
    // Kembali ke mode yang sedang aktif (SOS/VHMS) via API yang ada
    if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.goHome) {
      global.VHMS_SOS_MODE.goHome();
    } else if (global.VHMS_APP && global.VHMS_APP.showFleetView) {
      global.VHMS_APP.showFleetView();
    }
  }

  /* -----------------------------------------------------------------------
   * Mode & dropdown unit
   * --------------------------------------------------------------------- */
  function refreshUnitOptions() {
    var sel = el('portfolio-unit');
    if (!sel || !global.PORTFOLIO_RENDER) return;
    var units = global.PORTFOLIO_RENDER.availableUnits();
    var cur = global.PORTFOLIO_RENDER.getState().unitLambung;
    var opts = '<option value="">— Pilih unit —</option>';
    units.forEach(function (u) {
      opts += '<option value="' + u.lambung + '">' + u.lambung +
        (u.model ? ' — ' + u.model : '') + '</option>';
    });
    sel.innerHTML = opts;
    if (cur) sel.value = cur;
  }

  function applyMode() {
    var modeSel = el('portfolio-mode');
    var unitSel = el('portfolio-unit');
    var mode = modeSel ? modeSel.value : 'fleet';
    if (unitSel) unitSel.classList.toggle('hidden', mode !== 'unit');
    if (global.PORTFOLIO_RENDER) {
      global.PORTFOLIO_RENDER.setState({ mode: mode, unitLambung: unitSel ? unitSel.value : '' });
      global.PORTFOLIO_RENDER.render();
    }
  }

  /* -----------------------------------------------------------------------
   * Status chip data pendukung
   * --------------------------------------------------------------------- */
  function refreshDataStatus() {
    var store = global.PORTFOLIO_STORE;
    if (!store) return;
    var lt = store.lifetimeMeta();
    var tp = store.topupMeta();

    var ltChip = el('portfolio-lifetime-status');
    if (ltChip) {
      ltChip.innerHTML = lt.count
        ? '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> Lifetime: ' + lt.count + ' baris'
        : '<i class="fa-solid fa-circle-question"></i> Lifetime: belum dimuat';
    }
    var tpChip = el('portfolio-topup-status');
    if (tpChip) {
      tpChip.innerHTML = tp.count
        ? '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> Top-Up Oil: ' + tp.count + ' baris' +
          (tp.excluded ? ' (' + tp.excluded + ' non-topup dibuang)' : '')
        : '<i class="fa-solid fa-circle-question"></i> Top-Up Oil: belum dimuat';
    }
  }

  /* -----------------------------------------------------------------------
   * Upload data pendukung
   * --------------------------------------------------------------------- */
  function readFile(file, onOk, onErr) {
    var reader = new FileReader();
    reader.onload = function (e) { onOk(e.target.result); };
    reader.onerror = function () { onErr(new Error('Gagal membaca file.')); };
    reader.readAsText(file, 'utf-8');
  }

  function handleLifetimeFile(file) {
    readFile(file, function (text) {
      try {
        var parsed = global.LIFETIME_PARSER.parse(text);
        global.PORTFOLIO_STORE.setLifetime(parsed, file.name);
        refreshDataStatus();
        if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
        toast('Lifetime dimuat: ' + parsed.count + ' baris' +
          (parsed.skipped ? ', ' + parsed.skipped + ' dilewati' : '') + '.', 'ok');
      } catch (err) {
        console.error(err);
        toast('Gagal membaca Lifetime: ' + err.message, 'err');
      }
    }, function (err) { toast(err.message, 'err'); });
  }

  function handleTopupFile(file) {
    readFile(file, function (text) {
      try {
        var parsed = global.TOPUP_PARSER.parse(text);
        global.PORTFOLIO_STORE.setTopup(parsed, file.name);
        refreshDataStatus();
        if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
        var c = parsed.codes || {};
        toast('Top-Up Oil dimuat: ' + parsed.count + ' baris (TOU:' + (c.TOU || 0) +
          ', RPR:' + (c.RPR || 0) + '; SVC dibuang:' + (parsed.excluded || 0) + ').', 'ok');
      } catch (err) {
        console.error(err);
        toast('Gagal membaca Top-Up Oil: ' + err.message, 'err');
      }
    }, function (err) { toast(err.message, 'err'); });
  }

  /* -----------------------------------------------------------------------
   * Toast ringan (fallback bila VHMS_APP.toast tidak tersedia)
   * --------------------------------------------------------------------- */
  function toast(msg, type) {
    if (global.VHMS_APP && global.VHMS_APP.toast) { global.VHMS_APP.toast(msg, type); return; }
    if (global.SOS_APP && global.SOS_APP.toast) { global.SOS_APP.toast(msg, type); return; }
    var wrap = el('toast-wrap');
    if (!wrap) { return; }
    var d = document.createElement('div');
    d.className = 'toast ' + (type || 'ok');
    d.textContent = msg;
    wrap.appendChild(d);
    setTimeout(function () { d.remove(); }, 4000);
  }

  /* -----------------------------------------------------------------------
   * Print Preview
   * ---------------------------------------------------------------------
   * Alur: tombol "Cetak / Simpan PDF" -> buka modal pratinjau (isi salinan
   * konten portofolio) -> user periksa -> tombol di modal memanggil print
   * (hanya konten pratinjau yang tercetak).
   * --------------------------------------------------------------------- */
  function openPreview() {
    if (!global.PORTFOLIO_RENDER) return;
    global.PORTFOLIO_RENDER.render();  // pastikan konten terbaru

    var src = el('portfolio-content');
    var paper = el('pf-preview-paper');
    if (!src || !paper) return;

    // Salin konten portofolio ke kertas pratinjau. Hapus header cetak lama
    // dari sumber (kita buat versi sendiri di preview agar tidak dobel).
    var html = src.innerHTML;
    paper.innerHTML = html;

    var modal = el('portfolio-preview-modal');
    if (modal) modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closePreview() {
    var modal = el('portfolio-preview-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    // Bersihkan isi agar tidak menumpuk
    var paper = el('pf-preview-paper');
    if (paper) paper.innerHTML = '';
  }

  /** Cetak isi pratinjau (bukan seluruh halaman). */
  function printPreview() {
    // Tandai body agar CSS @media print hanya menampilkan modal pratinjau.
    document.body.classList.add('printing-portfolio');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-portfolio'); }, 600);
  }

  /* -----------------------------------------------------------------------
   * Wiring
   * --------------------------------------------------------------------- */
  function init() {
    var btn = el('btn-portfolio');
    if (btn) btn.addEventListener('click', openPortfolio);

    var back = el('btn-portfolio-back');
    if (back) back.addEventListener('click', closePortfolio);

    // Tombol cetak di halaman -> buka pratinjau (bukan langsung print).
    var printBtn = el('btn-portfolio-print');
    if (printBtn) printBtn.addEventListener('click', openPreview);

    // Kontrol modal pratinjau
    var pvClose = el('pf-preview-close');
    if (pvClose) pvClose.addEventListener('click', closePreview);
    var pvCancel = el('pf-preview-cancel');
    if (pvCancel) pvCancel.addEventListener('click', closePreview);
    var pvPrint = el('pf-preview-print');
    if (pvPrint) pvPrint.addEventListener('click', printPreview);
    var pvModal = el('portfolio-preview-modal');
    if (pvModal) pvModal.addEventListener('click', function (e) { if (e.target === pvModal) closePreview(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = el('portfolio-preview-modal');
        if (m && !m.classList.contains('hidden')) closePreview();
      }
    });

    var modeSel = el('portfolio-mode');
    if (modeSel) modeSel.addEventListener('change', applyMode);

    var unitSel = el('portfolio-unit');
    if (unitSel) unitSel.addEventListener('change', applyMode);

    // Upload Lifetime
    var ltPick = el('btn-lifetime-pick');
    var ltInput = el('lifetime-input');
    if (ltPick && ltInput) ltPick.addEventListener('click', function () { ltInput.click(); });
    if (ltInput) ltInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleLifetimeFile(e.target.files[0]);
      e.target.value = '';
    });

    // Upload Top-Up Oil
    var tpPick = el('btn-topup-pick');
    var tpInput = el('topup-input');
    if (tpPick && tpInput) tpPick.addEventListener('click', function () { tpInput.click(); });
    if (tpInput) tpInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleTopupFile(e.target.files[0]);
      e.target.value = '';
    });

    // Clear
    var ltClear = el('btn-lifetime-clear');
    if (ltClear) ltClear.addEventListener('click', function () {
      global.PORTFOLIO_STORE.clearLifetime(); refreshDataStatus();
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
      toast('Data Lifetime dihapus.', 'info');
    });
    var tpClear = el('btn-topup-clear');
    if (tpClear) tpClear.addEventListener('click', function () {
      global.PORTFOLIO_STORE.clearTopup(); refreshDataStatus();
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
      toast('Data Top-Up Oil dihapus.', 'info');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.PORTFOLIO_APP = {
    open: openPortfolio,
    close: closePortfolio,
    refresh: function () { refreshUnitOptions(); refreshDataStatus(); if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);

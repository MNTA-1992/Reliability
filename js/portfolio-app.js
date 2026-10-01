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

    // Isi dropdown unit & status data pendukung (cascading: Section->Model->Unit)
    refreshSectionOptions();
    refreshModelOptions();
    refreshUnitOptions();
    refreshCompartmentOptions();
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
  /**
   * [REVISI 2026-09-30] Cascading filter: Section -> Model -> Unit.
   * Helper: unit yang lolos filter SECTION saja (dasar utk opsi Model & Unit).
   *
   * [FITUR 2026-10-01] HANYA unit yang PUNYA TEMUAN (parameter di atas
   * threshold) yang muncul — unit NORMAL disembunyikan agar pencarian cepat.
   * Sumber: PORTFOLIO_RENDER.availableUnitsWithFindings() (turunan collect()).
   */
  function unitsForSection(sectionFilter) {
    var units = (global.PORTFOLIO_RENDER && global.PORTFOLIO_RENDER.availableUnitsWithFindings)
      ? global.PORTFOLIO_RENDER.availableUnitsWithFindings()
      : (global.PORTFOLIO_RENDER ? global.PORTFOLIO_RENDER.availableUnits() : []);
    if (!sectionFilter) return units;
    var store = global.PORTFOLIO_STORE;
    return units.filter(function (u) {
      var sec = (store && store.getSection) ? store.getSection(u.lambung) : '';
      return sec === sectionFilter;
    });
  }

  function refreshUnitOptions() {
    var sel = el('portfolio-unit');
    if (!sel || !global.PORTFOLIO_RENDER) return;
    var st = global.PORTFOLIO_RENDER.getState();
    var cur = st.unitLambung;

    // Filter unit sesuai Section lalu Model terpilih.
    var sectionFilter = (el('portfolio-section') ? el('portfolio-section').value : '') || '';
    var modelFilter = (el('portfolio-model') ? el('portfolio-model').value : '') || '';
    var units = unitsForSection(sectionFilter).filter(function (u) {
      if (modelFilter && String(u.model || '') !== modelFilter) return false;
      return true;
    });

    // Point 2: cukup tampilkan Nomor Lambung (tanpa SN/model).
    var opts = '<option value="">— Pilih unit —</option>';
    units.forEach(function (u) {
      opts += '<option value="' + u.lambung + '">' + u.lambung + '</option>';
    });
    sel.innerHTML = opts;
    if (cur && units.some(function (u) { return u.lambung === cur; })) sel.value = cur;
    else if (cur) { sel.value = ''; }
  }

  /**
   * [FITUR 2026-10-01] Dropdown KOMPARTEMEN — untuk mempercepat pencarian &
   * mencetak SEBAGIAN kompartemen saja (mis. hanya ENGINE).
   *
   * Isi opsi mengikuti konteks:
   *  - Bila Nomor Lambung dipilih -> kompartemen unit itu saja.
   *  - Bila belum -> gabungan kompartemen dari unit yang cocok filter
   *    Section + Model terpilih (agar tetap konsisten & relevan).
   * Bila kompartemen terpilih tidak lagi tersedia -> reset ke "Semua Kompartemen".
   */
  function refreshCompartmentOptions() {
    var sel = el('portfolio-compartment');
    if (!sel || !global.PORTFOLIO_RENDER) return;
    var cur = sel.value;
    var unitFilter = el('portfolio-unit') ? (el('portfolio-unit').value || '') : '';
    var sectionFilter = el('portfolio-section') ? (el('portfolio-section').value || '') : '';
    var modelFilter = el('portfolio-model') ? (el('portfolio-model').value || '') : '';
    var comps = [];
    if (global.PORTFOLIO_RENDER.availableCompartments) {
      comps = global.PORTFOLIO_RENDER.availableCompartments(unitFilter, sectionFilter, modelFilter);
    }
    var opts = '<option value="">Semua Kompartemen</option>';
    comps.forEach(function (c) { opts += '<option value="' + c + '">' + c + '</option>'; });
    sel.innerHTML = opts;
    if (cur && comps.indexOf(cur) !== -1) sel.value = cur;
    else sel.value = '';
  }

  /**
   * [REVISI 2026-09-30] Dropdown Model Unit — HANYA menampilkan model yang ADA
   * pada Section terpilih. Bila model terpilih tidak lagi tersedia -> reset.
   */
  function refreshModelOptions() {
    var sel = el('portfolio-model');
    if (!sel || !global.PORTFOLIO_RENDER) return;
    var cur = sel.value;
    var sectionFilter = (el('portfolio-section') ? el('portfolio-section').value : '') || '';
    var units = unitsForSection(sectionFilter);
    var models = {};
    units.forEach(function (u) { if (u.model) models[u.model] = (models[u.model] || 0) + 1; });
    var names = Object.keys(models).sort(function (a, b) { return a.localeCompare(b); });
    var opts = '<option value="">Semua Model</option>';
    names.forEach(function (m) { opts += '<option value="' + m + '">' + m + ' (' + models[m] + ')</option>'; });
    sel.innerHTML = opts;
    // Pertahankan pilihan bila masih ada; jika tidak -> reset ke "Semua Model".
    if (cur && names.indexOf(cur) !== -1) sel.value = cur;
    else sel.value = '';
  }

  /** [FITUR 2026-09-30] Isi dropdown Section (dari data Section terunggah). */
  function refreshSectionOptions() {
    var sel = el('portfolio-section');
    if (!sel) return;
    var store = global.PORTFOLIO_STORE;
    var list = (store && store.sectionList) ? store.sectionList() : [];
    var cur = sel.value;
    var opts = '<option value="">Semua Section</option>';
    list.forEach(function (s) { opts += '<option value="' + s.name + '">' + s.name + ' (' + s.count + ')</option>'; });
    sel.innerHTML = opts;
    if (cur && list.some(function (s) { return s.name === cur; })) sel.value = cur;
    else sel.value = '';
  }

  function applyMode() {
    var modeSel = el('portfolio-mode');
    var unitSel = el('portfolio-unit');
    var secSel = el('portfolio-section');
    var modelSel = el('portfolio-model');
    var compSel = el('portfolio-compartment');
    var mode = modeSel ? modeSel.value : 'fleet';
    // Dropdown Section/Model/Unit/Kompartemen hanya tampil di mode Per Unit.
    if (unitSel) unitSel.classList.toggle('hidden', mode !== 'unit');
    if (secSel) secSel.classList.toggle('hidden', mode !== 'unit');
    if (modelSel) modelSel.classList.toggle('hidden', mode !== 'unit');
    if (compSel) compSel.classList.toggle('hidden', mode !== 'unit');
    if (mode === 'unit') {
      refreshSectionOptions();
      refreshModelOptions();   // model mengikuti section
      refreshUnitOptions();    // unit mengikuti section + model
      refreshCompartmentOptions(); // kompartemen mengikuti unit/section/model
    }
    if (global.PORTFOLIO_RENDER) {
      global.PORTFOLIO_RENDER.setState({
        mode: mode,
        unitLambung: unitSel ? unitSel.value : '',
        // [FIX 2026-10-01] Sertakan Section & Model agar filter benar-benar
        // menyaring isi laporan (bukan hanya mengubah daftar opsi).
        section: secSel ? secSel.value : '',
        model: modelSel ? modelSel.value : '',
        // [FITUR 2026-10-01] Kompartemen untuk print out partial.
        compartment: mode === 'unit' ? (compSel ? compSel.value : '') : ''
      });
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
    // [FITUR 2026-09-30] Chip Section.
    var sec = (store.sectionMeta ? store.sectionMeta() : { count: 0 });
    var secChip = el('portfolio-section-status');
    if (secChip) {
      secChip.innerHTML = sec.count
        ? '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> Section: ' + sec.count + ' baris'
        : '<i class="fa-solid fa-circle-question"></i> Section: belum dimuat';
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

  // [FITUR 2026-09-30] Upload file Section (SN, Nomor Lambung, Section).
  function handleSectionFile(file) {
    readFile(file, function (text) {
      try {
        var parsed = global.SECTION_PARSER.parse(text);
        global.PORTFOLIO_STORE.setSection(parsed, file.name);
        refreshDataStatus();
        refreshSectionOptions();
        refreshModelOptions();
        refreshUnitOptions();
        if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
        toast('Section dimuat: ' + parsed.count + ' baris, ' +
          Object.keys(parsed.sections || {}).length + ' section' +
          (parsed.skipped ? ', ' + parsed.skipped + ' dilewati' : '') + '.', 'ok');
      } catch (err) {
        console.error(err);
        toast('Gagal membaca Section: ' + err.message, 'err');
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

    // [SMART PAGE BREAK 2026-10-01] Hitung ulang page-break pada KERTAS
    // PRATINJAU (lebar 210mm = WYSIWYG dgn PDF) agar estimasi akurat:
    // unit yang muat di sisa halaman TIDAK dipaksa pindah (hindari halaman
    // hampir kosong / "ter-split jauh").
    if (global.PORTFOLIO_RENDER.applySmartPageBreaks) {
      // Dua kali: sekali untuk ukur, sekali untuk stabilkan setelah reflow.
      try { global.PORTFOLIO_RENDER.applySmartPageBreaks(paper.querySelector('.rp-doc') || paper); } catch (e) {}
      requestAnimationFrame(function () {
        try { global.PORTFOLIO_RENDER.applySmartPageBreaks(paper.querySelector('.rp-doc') || paper); } catch (e) {}
      });
    }
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

    // [FIX 2026-10-01] Ubah UNIT (Nomor Lambung) JANGAN pakai applyMode:
    // applyMode() memanggil refreshUnitOptions() yang MEMBANGUN ULANG opsi &
    // mereset nilai select ke '' — sehingga pilihan yang baru diklik hilang
    // dan laporan tetap menampilkan semua. Handler ini hanya menyinkronkan
    // state + render, TANPA membangun ulang daftar opsi UNIT. Daftar
    // KOMPARTEMEN di-refresh karena bergantung pada unit terpilih.
    var unitSel = el('portfolio-unit');
    if (unitSel) unitSel.addEventListener('change', function () {
      if (!global.PORTFOLIO_RENDER) return;
      refreshCompartmentOptions();   // kompartemen menyesuaikan unit
      global.PORTFOLIO_RENDER.setState({
        mode: 'unit',
        section: el('portfolio-section') ? (el('portfolio-section').value || '') : '',
        model: el('portfolio-model') ? (el('portfolio-model').value || '') : '',
        unitLambung: unitSel.value || '',
        compartment: el('portfolio-compartment') ? (el('portfolio-compartment').value || '') : ''
      });
      global.PORTFOLIO_RENDER.render();
    });

    // [FITUR 2026-10-01] Ubah KOMPARTEMEN -> print out partial (mis. ENGINE saja).
    // Tidak membangun ulang opsi apa pun; hanya sinkron state + render.
    var compSel = el('portfolio-compartment');
    if (compSel) compSel.addEventListener('change', function () {
      if (!global.PORTFOLIO_RENDER) return;
      global.PORTFOLIO_RENDER.setState({ compartment: compSel.value || '' });
      global.PORTFOLIO_RENDER.render();
    });

    // [REVISI 2026-09-30] Cascading: Section -> Model -> Unit.
    // Ubah Section: reset & isi ulang opsi Model (hanya model di section itu),
    // lalu isi ulang Unit.
    var sectionSel = el('portfolio-section');
    if (sectionSel) sectionSel.addEventListener('change', function () {
      refreshModelOptions();   // model menyesuaikan section
      refreshUnitOptions();    // unit menyesuaikan section + model
      refreshCompartmentOptions(); // kompartemen menyesuaikan filter
      if (global.PORTFOLIO_RENDER && el('portfolio-mode').value === 'unit') {
        global.PORTFOLIO_RENDER.setState({
          section: el('portfolio-section').value || '',
          model: el('portfolio-model') ? (el('portfolio-model').value || '') : '',
          unitLambung: el('portfolio-unit').value || '',
          compartment: el('portfolio-compartment') ? (el('portfolio-compartment').value || '') : ''
        });
        global.PORTFOLIO_RENDER.render();
      }
    });
    // Ubah Model: isi ulang opsi Unit (hanya unit dari model itu).
    var modelSel = el('portfolio-model');
    if (modelSel) modelSel.addEventListener('change', function () {
      refreshUnitOptions();
      refreshCompartmentOptions(); // kompartemen menyesuaikan filter
      if (global.PORTFOLIO_RENDER && el('portfolio-mode').value === 'unit') {
        global.PORTFOLIO_RENDER.setState({
          section: el('portfolio-section') ? (el('portfolio-section').value || '') : '',
          model: modelSel.value || '',
          unitLambung: el('portfolio-unit').value || '',
          compartment: el('portfolio-compartment') ? (el('portfolio-compartment').value || '') : ''
        });
        global.PORTFOLIO_RENDER.render();
      }
    });

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

    // [SATU UPLOAD 2026-10-01] Upload Section DIPINDAH ke panel "Data Unit"
    // (mode VHMS/SOS) agar satu file mengisi Nomor Lambung + Section sekaligus.
    // Handler lama (btn-section-pick) dibiarkan null-safe: tombolnya sudah
    // dihapus dari index.html, jadi blok ini tidak memasang apa-apa.
    var secPick = el('btn-section-pick');
    var secInput = el('section-input');
    if (secPick && secInput) secPick.addEventListener('click', function () { secInput.click(); });
    if (secInput) secInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleSectionFile(e.target.files[0]);
      e.target.value = '';
    });
    var secClear = el('btn-section-clear');
    if (secClear) secClear.addEventListener('click', function () {
      global.PORTFOLIO_STORE.clearSection();
      refreshDataStatus(); refreshSectionOptions(); refreshUnitOptions();
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
      toast('Data Section dihapus.', 'info');
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
    refresh: function () {
      refreshSectionOptions();
      refreshModelOptions();
      refreshUnitOptions();
      refreshCompartmentOptions();
      refreshDataStatus();
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

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
   * [FITUR 2026-10-03] Searchable Select — pengganti <select> yang bisa
   * diketik untuk mencari (Section / Model / Nomor Lambung).
   * --------------------------------------------------------------------- */
  var SS = {};   // registry: id -> { items, value, optText }

  function ssInit(id, opts) {
    var wrap = el(id);
    if (!wrap) return;
    var btn = wrap.querySelector('.pfss-toggle');
    var panel = wrap.querySelector('.pfss-panel');
    var search = wrap.querySelector('.pfss-search');
    var list = wrap.querySelector('.pfss-list');
    SS[id] = { items: [], value: '', optText: (opts && opts.optText) || function (it) { return it.label; }, onChange: (opts && opts.onChange) || null };

    function open() {
      // Tutup semua SS lain
      Object.keys(SS).forEach(function (k) { if (k !== id) ssClose(k); });
      panel.classList.add('pfss-open');
      btn.classList.add('pfss-open');
      search.value = '';
      ssRenderList(id);
      setTimeout(function () { search.focus(); }, 0);
    }
    function close() {
      panel.classList.remove('pfss-open');
      btn.classList.remove('pfss-open');
    }
    SS[id].close = close;
    SS[id].open = open;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.classList.contains('pfss-open')) close(); else open();
    });
    search.addEventListener('input', function () { ssRenderList(id); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        var first = list.querySelector('.pfss-opt');
        if (first) first.click();
      }
    });
    wrap.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function ssClose(id) { if (SS[id] && SS[id].close) SS[id].close(); }

  // Tutup semua panel bila klik di luar.
  document.addEventListener('click', function () {
    Object.keys(SS).forEach(function (k) { ssClose(k); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') Object.keys(SS).forEach(function (k) { ssClose(k); });
  });

  function ssSetItems(id, items) {
    if (!SS[id]) return;
    SS[id].items = items || [];
    // Validasi nilai terpilih masih ada.
    var exists = SS[id].items.some(function (it) { return String(it.value) === String(SS[id].value); });
    if (SS[id].value !== '' && !exists) SS[id].value = '';
    ssUpdateLabel(id);
  }

  function ssSetValue(id, val) {
    if (!SS[id]) return;
    SS[id].value = val == null ? '' : String(val);
    ssUpdateLabel(id);
  }
  function ssGetValue(id) { return SS[id] ? SS[id].value : ''; }

  function ssUpdateLabel(id) {
    var wrap = el(id);
    if (!wrap || !SS[id]) return;
    var lbl = wrap.querySelector('.pfss-label');
    var sel = SS[id].items.filter(function (it) { return String(it.value) === String(SS[id].value); })[0];
    lbl.textContent = sel ? sel.label : SS[id].placeholder;
  }

  function ssRenderList(id) {
    var wrap = el(id);
    if (!wrap || !SS[id]) return;
    var list = wrap.querySelector('.pfss-list');
    var q = (wrap.querySelector('.pfss-search').value || '').toLowerCase().trim();
    var items = SS[id].items.filter(function (it) {
      if (!q) return true;
      return String(it.label).toLowerCase().indexOf(q) !== -1 || String(it.value).toLowerCase().indexOf(q) !== -1;
    });
    var html = '';
    items.forEach(function (it) {
      var selCls = (String(it.value) === String(SS[id].value)) ? ' pfss-selected' : '';
      html += '<div class="pfss-opt' + selCls + '" data-value="' + String(it.value).replace(/"/g, '&quot;') + '">' +
        (SS[id].optText ? SS[id].optText(it) : it.label) + '</div>';
    });
    list.innerHTML = html || '<div class="pfss-empty">Tidak ada hasil</div>';
    list.querySelectorAll('.pfss-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        SS[id].value = this.getAttribute('data-value');
        ssUpdateLabel(id);
        ssClose(id);
        if (SS[id].onChange) SS[id].onChange(SS[id].value);
      });
    });
  }

  /* -----------------------------------------------------------------------
   * Buka / tutup halaman portofolio
   * --------------------------------------------------------------------- */
  function openPortfolio() {
    // Sembunyikan area mode lain
    AREA_IDS.forEach(function (id) { toggle(id, false); });
    var banner = el('alert-banner');
    if (banner) banner.classList.add('hidden');

    // [FITUR 2026-10-05] Tombol header "Cetak / Ekspor Laporan" redundan di
    // Portofolio (sudah ada tombol cetak di toolbar halaman) -> sembunyikan.
    toggleHeaderReportBtn(false);

    // Tampilkan area portofolio
    toggle('portfolio-area', true);

    // Isi dropdown unit & status data pendukung (cascading: Section->Model->Unit)
    refreshSectionOptions();
    refreshModelOptions();
    refreshUnitOptions();
    refreshCompartmentOptions();
    renderCompChips();
    refreshDataStatus();

    // Render
    if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();

    // Scroll ke atas
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  /**
   * [FITUR 2026-10-03] Buka Portofolio untuk SATU unit + kompartemen, lalu
   * langsung tampilkan pratinjau cetak. Dipakai tombol "Print" pada tabel SOS.
   *
   * Langkah:
   *  1) Buka halaman Portofolio (mengisi semua dropdown).
   *  2) Set filter unit = assetId, kompartemen = component (checkbox tunggal).
   *  3) Render ulang & buka pratinjau cetak.
   *
   * @param {string} assetId   Nomor lambung / Asset ID unit
   * @param {string} component Nama kompartemen (mis. "ENGINE")
   */
  function openPortfolioForPrint(assetId, component) {
    // 1) Buka halaman portofolio lebih dulu (mengisi opsi dropdown & render).
    openPortfolio();

    if (!global.PORTFOLIO_RENDER) return;

    // 2) Set unit pada searchable-select & state.
    if (el('pf-ss-unit') && SS['pf-ss-unit']) {
      ssSetValue('pf-ss-unit', assetId || '');
    }
    // Selaraskan filter model/section agar tidak mempersempit unit yang diminta.
    ssSetValue('pf-ss-section', '');
    ssSetValue('pf-ss-model', '');
    // [FIX 2026-10-06] Pastikan pilihan kompartemen LAMA dibuang dulu, agar
    // nama laporan & isi laporan hanya mengikuti kompartemen yang diminta.
    global.PORTFOLIO_RENDER.setState({ compartmentSelected: [], compartment: '' });
    refreshCompartmentOptions();

    global.PORTFOLIO_RENDER.setState({
      mode: 'unit',
      section: '',
      model: '',
      unitLambung: assetId || ''
    });

    // 3) Pilih kompartemen pada checkbox (bila ada & punya temuan).
    var container = el('portfolio-compartment-container');
    if (container && component) {
      var cb = container.querySelector('.portfolio-comp-checkbox[value="' + String(component).replace(/"/g, '\\"') + '"]');
      if (cb) {
        cb.checked = true;
        applyCompItemStyle(cb);
        updateCompartmentFilter();   // sinkron state + chip + render
      } else {
        // Kompartemen tidak punya temuan -> kosongkan pilihan (tampil normal).
        updateCompartmentFilter();
      }
    }

    // 4) Render final + buka pratinjau cetak.
    global.PORTFOLIO_RENDER.render();
    try { window.scrollTo(0, 0); } catch (e) {}
    openPreview();
  }

  /** Tampilkan/sembunyikan tombol cetak di header aplikasi. */
  function toggleHeaderReportBtn(show) {
    var b = el('btn-report-1');
    if (b) b.style.display = show ? '' : 'none';
  }

  function closePortfolio() {
    toggle('portfolio-area', false);
    toggleHeaderReportBtn(true);
    // [FIX G-4] Judul default dari sumber tunggal (sesuai <title> index.html).
    if (global.APP_HEADER && global.APP_HEADER.setDefaultTitle) {
      global.APP_HEADER.setDefaultTitle();
    } else {
      try { document.title = 'Asset Reliability Performance Center (ARPC)'; } catch (e) {}
    }
    // Kembali ke mode yang sedang aktif (SOS/VHMS) via API yang ada
    if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.goHome) {
      global.VHMS_SOS_MODE.goHome();
    } else if (global.VHMS_APP && global.VHMS_APP.showFleetView) {
      global.VHMS_APP.showFleetView();
    }
  }

  /* -----------------------------------------------------------------------
   * Mapping kompartmen ke kategori & theme color
   * --------------------------------------------------------------------- */
  var COMPARTMENT_GROUPS = [
    { group: 'Engine', color: '#f87171', items: ['ENGINE'] },
    { group: 'Transmission', color: '#fbbf24', items: ['TRANSMISSION'] },
    { group: 'Hydraulic', color: '#60a5fa', items: ['HYDRAULIC'] },
    { group: 'Final Drive', color: '#34d399', items: ['FINAL DRIVE', 'SWING DRIVE'] },
    { group: 'Differential', color: '#a78bfa', items: ['DIFFERENTIAL'] },
    { group: 'Wheel Bearing', color: '#fb923c', items: ['WHEEL BEARING', 'WHEEL BEARINGS FRONT RIGHT', 'WHEEL BEARINGS FRONT LEFT', 'WHEEL BEARINGS REAR RIGHT', 'WHEEL BEARINGS REAR LEFT'] },
    { group: 'Splitter / PTO', color: '#ec4899', items: ['SPLITTER', 'PTO'] },
    { group: 'Pump / IMP', color: '#22d3ee', items: ['PUMP', 'PUMP IMP'] },
    { group: 'Other', color: '#94a3b8', items: [] }  // fallback untuk kompartmen tak terdaftar
  ];

  function getCompartmentGroup(compartmentName) {
    var name = String(compartmentName || '').toUpperCase();
    for (var i = 0; i < COMPARTMENT_GROUPS.length; i++) {
      var group = COMPARTMENT_GROUPS[i];
      for (var j = 0; j < group.items.length; j++) {
        if (name.indexOf(group.items[j]) !== -1) {
          return group;
        }
      }
    }
    // Fallback ke kategori "Other"
    return COMPARTMENT_GROUPS[COMPARTMENT_GROUPS.length - 1];
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
    if (!el('pf-ss-unit') || !SS['pf-ss-unit'] || !global.PORTFOLIO_RENDER) return;
    var st = global.PORTFOLIO_RENDER.getState();
    var cur = st.unitLambung;

    // Filter unit sesuai Section lalu Model terpilih.
    var sectionFilter = ssGetValue('pf-ss-section') || '';
    var modelFilter = ssGetValue('pf-ss-model') || '';
    var units = unitsForSection(sectionFilter).filter(function (u) {
      if (modelFilter && String(u.model || '') !== modelFilter) return false;
      return true;
    });

    // Point 2: cukup tampilkan Nomor Lambung (tanpa SN/model).
    var items = [{ value: '', label: '— Pilih unit —' }];
    units.forEach(function (u) { items.push({ value: u.lambung, label: u.lambung }); });
    SS['pf-ss-unit'].placeholder = '— Pilih unit —';
    SS['pf-ss-unit'].value = cur || '';
    ssSetItems('pf-ss-unit', items);

    // Auto-pilih unit pertama bila belum ada pilihan (perilaku lama).
    if (!ssGetValue('pf-ss-unit') && units.length > 0) {
      ssSetValue('pf-ss-unit', units[0].lambung);
      global.PORTFOLIO_RENDER.setState({ unitLambung: units[0].lambung });
    }
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
    var container = el('portfolio-compartment-container');
    if (!container || !global.PORTFOLIO_RENDER) return;
    
    var unitFilter = ssGetValue('pf-ss-unit') || '';
    var sectionFilter = ssGetValue('pf-ss-section') || '';
    var modelFilter = ssGetValue('pf-ss-model') || '';
    
    // [FITUR 2026-10-03] Ambil kompartmen yang PUNYA BREACH (melewati threshold)
    var compsWithBreach = [];
    if (global.PORTFOLIO_RENDER.compartmentsWithBreach) {
      compsWithBreach = global.PORTFOLIO_RENDER.compartmentsWithBreach(unitFilter, sectionFilter, modelFilter);
    }
    
    // Simpan pilihan sebelumnya
    var prev = container.querySelectorAll('.portfolio-comp-checkbox:checked');
    var prevChecked = {};
    prev.forEach(function (cb) { prevChecked[cb.value] = true; });

    // Buat checkbox dinamis — flat list berjajar (tanpa header grup)
    var html = '';
    if (compsWithBreach.length === 0) {
      html = '<span style="font-size:12px;color:#94a3b8;padding:6px 0">Semua kompartmen normal</span>';
    } else {
      compsWithBreach.forEach(function (c) {
        var group = getCompartmentGroup(c);
        var isChecked = prevChecked[c] ? ' checked' : '';
        // [P0 KONTRAS 2026-10-05] Warna teks #e2e8f0 di atas latar chip gelap
        // (--comp-color + alpha .06 di atas panel) -> rasio terukur aman.
        html += '<label class="portfolio-comp-item" data-color="' + group.color + '" title="' + c + '" ' +
          'style="--comp-color:' + group.color + ';display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 10px;border-radius:4px;' +
          'width:100%;box-sizing:border-box;border:1px solid ' + group.color + '99;background:' + group.color + '1a;transition:all .2s;color:#e2e8f0">' +
          '<input type="checkbox" value="' + c + '" class="portfolio-comp-checkbox"' + isChecked + ' ' +
          'style="cursor:pointer;margin:0;accent-color:' + group.color + '">' +
          '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + group.color + ';flex:0 0 auto"></span>' +
          '<span style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + c + '</span>' +
          '</label>';
      });
    }
    container.innerHTML = html;

    // Event: ketika checkbox diubah -> update state & render
    var checkboxes = container.querySelectorAll('.portfolio-comp-checkbox');
    checkboxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        applyCompItemStyle(this);
        updateCompartmentFilter();
      });
      // Hover effect (warna mengikuti group)
      cb.parentElement.addEventListener('mouseenter', function () {
        var color = this.getAttribute('data-color') || '#38bdf8';
        this.style.background = color + '22';
        this.style.borderColor = color + '80';
        this.style.color = '#e2e8f0';
      });
      cb.parentElement.addEventListener('mouseleave', function () {
        applyCompItemStyle(cb);
      });
      // Terapkan style awal (checked/unchecked) sesuai warna group
      applyCompItemStyle(cb);
    });

    // Perbarui label toggle & chip
    updateCompToggleLabel();
  }

  /** Buka/tutup panel checkbox. */
  function toggleCompPanel(force) {
    var panel = el('portfolio-compartment-container');
    var caret = el('portfolio-comp-caret');
    if (!panel) return;
    var isOpen = panel.style.display !== 'none' && panel.style.display !== '';
    var open = (typeof force === 'boolean') ? force : !isOpen;
    panel.style.display = open ? 'flex' : 'none';
    if (caret) caret.style.transform = open ? 'rotate(180deg)' : 'rotate(0)';
  }

  /** Tutup panel bila klik di luar. */
  function onDocClickComp(e) {
    var wrap = el('portfolio-compartment-dropdown');
    if (wrap && !wrap.contains(e.target)) toggleCompPanel(false);
  }
  document.addEventListener('click', onDocClickComp);

  /** Perbarui label tombol dropdown ("Semua Kompartemen" / "N dipilih"). */
  function updateCompToggleLabel() {
    var lbl = el('portfolio-comp-label');
    if (!lbl) return;
    var container = el('portfolio-compartment-container');
    if (!container) return;
    var n = container.querySelectorAll('.portfolio-comp-checkbox:checked').length;
    var total = container.querySelectorAll('.portfolio-comp-checkbox').length;
    if (n === 0) lbl.innerHTML = '<i class="fa-solid fa-filter" style="opacity:.6;margin-right:6px"></i>Semua Kompartemen' + (total ? ' (' + total + ')' : '');
    else lbl.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#34d399;margin-right:6px"></i>' + n + ' kompartmen dipilih';
  }

  /** Render chip untuk kompartmen terpilih (dengan tombol hapus). */
  function renderCompChips() {
    var box = el('portfolio-comp-chips');
    var container = el('portfolio-compartment-container');
    if (!box || !container) return;
    var checked = container.querySelectorAll('.portfolio-comp-checkbox:checked');
    var html = '';
    checked.forEach(function (cb) {
      var label = cb.parentElement;
      var color = label.getAttribute('data-color') || '#38bdf8';
      var val = cb.value;
      html += '<span class="portfolio-comp-chip" data-value="' + val + '" title="' + val + '" ' +
        'style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;font-size:11px;' +
        'border:1px solid ' + color + '80;background:' + color + '22;color:#e2e8f0">' +
        '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + color + '"></span>' +
        val +
        '<i class="fa-solid fa-xmark portfolio-comp-chip-x" style="cursor:pointer;opacity:.7;font-size:10px"></i>' +
        '</span>';
    });
    box.innerHTML = html;
    // Event hapus chip
    box.querySelectorAll('.portfolio-comp-chip-x').forEach(function (x) {
      x.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var chip = this.closest('.portfolio-comp-chip');
        var val = chip.getAttribute('data-value');
        var target = container.querySelector('.portfolio-comp-checkbox[value="' + val.replace(/"/g, '\\"') + '"]');
        if (target) {
          target.checked = false;
          applyCompItemStyle(target);
        }
        updateCompartmentFilter();
      });
    });
  }

  /** [FITUR 2026-10-03] Terapkan warna item checkbox sesuai status & group. */
  function applyCompItemStyle(cb) {
    var label = cb.parentElement;
    if (!label) return;
    var color = label.getAttribute('data-color') || '#38bdf8';
    if (cb.checked) {
      label.style.background = color + '30';
      label.style.borderColor = color;
      label.style.color = '#f1f5f9';
      label.style.boxShadow = '0 0 0 1px ' + color + '60, 0 0 8px ' + color + '40';
    } else {
      label.style.background = color + '0f';
      label.style.borderColor = color + '40';
      label.style.color = '#cbd5e1';
      label.style.boxShadow = 'none';
    }
  }
  
  function updateCompartmentFilter() {
    var container = el('portfolio-compartment-container');
    if (!container || !global.PORTFOLIO_RENDER) return;
    
    // Kumpulkan kompartmen yang diceklis
    var checked = [];
    var checkboxes = container.querySelectorAll('.portfolio-comp-checkbox:checked');
    checkboxes.forEach(function (cb) { checked.push(cb.value); });

    // Perbarui label toggle + chip
    updateCompToggleLabel();
    renderCompChips();
    
    // Update state: gunakan array (atau string terpisah koma)
    global.PORTFOLIO_RENDER.setState({ compartmentSelected: checked });
    global.PORTFOLIO_RENDER.render();
    syncFollowupIfOpen();
  }

  /**
   * [FITUR 2026-10-05] Bila halaman Form Follow-Up sedang terbuka, render ulang
   * agar isinya mengikuti unit/kompartemen yang baru dipilih di filter.
   */
  function syncFollowupIfOpen() {
    var box = el('portfolio-followup-container');
    if (!box || box.classList.contains('hidden')) return;
    if (global.PORTFOLIO_FOLLOWUP) global.PORTFOLIO_FOLLOWUP.render();
  }

  /**
   * [REVISI 2026-09-30] Dropdown Model Unit — HANYA menampilkan model yang ADA
   * pada Section terpilih. Bila model terpilih tidak lagi tersedia -> reset.
   */
  function refreshModelOptions() {
    if (!el('pf-ss-model') || !SS['pf-ss-model'] || !global.PORTFOLIO_RENDER) return;
    var sectionFilter = ssGetValue('pf-ss-section') || '';
    var units = unitsForSection(sectionFilter);
    var models = {};
    units.forEach(function (u) { if (u.model) models[u.model] = (models[u.model] || 0) + 1; });
    var names = Object.keys(models).sort(function (a, b) { return a.localeCompare(b); });
    var items = [{ value: '', label: 'Semua Model' }];
    names.forEach(function (m) { items.push({ value: m, label: m + ' (' + models[m] + ')' }); });
    SS['pf-ss-model'].placeholder = 'Semua Model';
    ssSetItems('pf-ss-model', items);
  }

  /** [FITUR 2026-09-30] Isi dropdown Section (dari data Section terunggah). */
  function refreshSectionOptions() {
    if (!el('pf-ss-section') || !SS['pf-ss-section']) return;
    var store = global.PORTFOLIO_STORE;
    var list = (store && store.sectionList) ? store.sectionList() : [];
    var items = [{ value: '', label: 'Semua Section' }];
    list.forEach(function (s) { items.push({ value: s.name, label: s.name + ' (' + s.count + ')' }); });
    SS['pf-ss-section'].placeholder = 'Semua Section';
    ssSetItems('pf-ss-section', items);
  }

  function applyMode() {
    var mode = 'unit'; // default & satu-satunya mode: Per Unit

    refreshSectionOptions();
    refreshModelOptions();   // model mengikuti section
    refreshUnitOptions();    // unit mengikuti section + model
    refreshCompartmentOptions(); // kompartemen mengikuti unit/section/model

    if (global.PORTFOLIO_RENDER) {
      global.PORTFOLIO_RENDER.setState({
        mode: mode,
        unitLambung: ssGetValue('pf-ss-unit') || '',
        section: ssGetValue('pf-ss-section') || '',
        model: ssGetValue('pf-ss-model') || ''
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
    var tp = store.topupMeta();

    var tpChip = el('portfolio-topup-status');
    if (tpChip) {
      tpChip.innerHTML = tp.count
        ? '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> Top-Up: ' + tp.count + ' baris'
        : '<i class="fa-solid fa-circle-question"></i> Top-Up: belum dimuat';
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

    // Set document.title ke penamaan report default saat pratinjau dibuka
    if (global.PORTFOLIO_RENDER && global.PORTFOLIO_RENDER.getPortfolioReportFileName) {
      var fname = global.PORTFOLIO_RENDER.getPortfolioReportFileName();
      if (fname) {
        try { document.title = fname; } catch (e) {}
      }
    }

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
    if (global.PORTFOLIO_RENDER && global.PORTFOLIO_RENDER.getPortfolioReportFileName) {
      var fname = global.PORTFOLIO_RENDER.getPortfolioReportFileName();
      if (fname) {
        try { document.title = fname; } catch (e) {}
      }
    }
    window.print();
  }

  /**
   * [FITUR 2026-10-05] Cetak sesuai halaman Portofolio yang sedang aktif.
   * Dipakai oleh satu-satunya tombol "Cetak / Simpan PDF" di toolbar.
   */
  function printActivePage() {
    var followup = el('portfolio-followup-container');
    var isFollowup = followup && !followup.classList.contains('hidden');

    if (isFollowup) {
      if (global.PORTFOLIO_FOLLOWUP && global.PORTFOLIO_FOLLOWUP.print) {
        global.PORTFOLIO_FOLLOWUP.print();
      }
      return;
    }
    openPreview();
  }

  /* -----------------------------------------------------------------------
   * Wiring
   * --------------------------------------------------------------------- */
  function init() {
    var btn = el('btn-portfolio');
    if (btn) btn.addEventListener('click', openPortfolio);

    var back = el('btn-portfolio-back');
    if (back) back.addEventListener('click', closePortfolio);

    // [FITUR 2026-10-05] SATU tombol cetak untuk seluruh halaman Portofolio.
    // Tujuannya mengikuti halaman yang sedang aktif:
    //   - Overview      -> buka pratinjau laporan
    //   - Form Follow-Up -> cetak formulir langsung (sudah WYSIWYG A4)
    var printBtn = el('btn-portfolio-print');
    if (printBtn) printBtn.addEventListener('click', printActivePage);

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

    // [FITUR 2026-10-03] Searchable select: Section / Model / Unit.
    ssInit('pf-ss-unit', { onChange: function () {
      if (!global.PORTFOLIO_RENDER) return;
      // [FIX 2026-10-06] Reset pilihan KOMPARTEMEN saat unit berubah. Sebelumnya
      // `compartmentSelected` dari unit LAMA ikut terbawa -> filter kosong/
      // salah & nama laporan "nyangkut" di pilihan pertama.
      global.PORTFOLIO_RENDER.setState({ compartmentSelected: [], compartment: '' });
      refreshCompartmentOptions();
      global.PORTFOLIO_RENDER.setState({
        mode: 'unit',
        section: ssGetValue('pf-ss-section') || '',
        model: ssGetValue('pf-ss-model') || '',
        unitLambung: ssGetValue('pf-ss-unit') || ''
      });
      global.PORTFOLIO_RENDER.render();
      syncFollowupIfOpen();
    }});
    ssInit('pf-ss-section', { onChange: function () {
      refreshModelOptions();
      refreshUnitOptions();
      // [FIX 2026-10-06] Reset pilihan kompartemen saat Section berubah.
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.setState({ compartmentSelected: [], compartment: '' });
      refreshCompartmentOptions();
      if (global.PORTFOLIO_RENDER) {
        global.PORTFOLIO_RENDER.setState({
          section: ssGetValue('pf-ss-section') || '',
          model: ssGetValue('pf-ss-model') || '',
          unitLambung: ssGetValue('pf-ss-unit') || ''
        });
        global.PORTFOLIO_RENDER.render();
      }
    }});
    ssInit('pf-ss-model', { onChange: function () {
      refreshUnitOptions();
      // [FIX 2026-10-06] Reset pilihan kompartemen saat Model berubah.
      if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.setState({ compartmentSelected: [], compartment: '' });
      refreshCompartmentOptions();
      if (global.PORTFOLIO_RENDER) {
        global.PORTFOLIO_RENDER.setState({
          section: ssGetValue('pf-ss-section') || '',
          model: ssGetValue('pf-ss-model') || '',
          unitLambung: ssGetValue('pf-ss-unit') || ''
        });
        global.PORTFOLIO_RENDER.render();
      }
    }});

    // [FITUR 2026-10-03] Tombol dropdown multi-select kompartmen -> buka/tutup panel.
    var compToggle = el('portfolio-comp-toggle');
    if (compToggle) compToggle.addEventListener('click', function () { toggleCompPanel(); });

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

    /* -----------------------------------------------------------------------
     * [FITUR 2026-10-05] Navigasi halaman portofolio: Overview / Form Follow-Up
     * Form Follow-Up memakai unit & kompartemen yang sedang dipilih di filter
     * Overview (satu sumber pemilihan unit — tidak ada dropdown terpisah).
     * --------------------------------------------------------------------- */
    var btnOverview = el('pf-page-overview');
    var btnFollowup = el('pf-page-followup');

    function showPortfolioPage(page) {
      var content = el('portfolio-content');
      var followup = el('portfolio-followup-container');

      var isFollowup = (page === 'followup');

      [btnOverview, btnFollowup].forEach(function (btn) {
        if (!btn) return;
        var active = (btn === (isFollowup ? btnFollowup : btnOverview));
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });

      if (isFollowup) {
        if (content) content.classList.add('hidden');
        if (followup) {
          followup.classList.remove('hidden');
          if (global.PORTFOLIO_FOLLOWUP) global.PORTFOLIO_FOLLOWUP.render();
        }
      } else {
        if (content) content.classList.remove('hidden');
        if (followup) followup.classList.add('hidden');
        if (global.PORTFOLIO_RENDER) global.PORTFOLIO_RENDER.render();
      }

      updatePrintButtonLabel(isFollowup);
    }

    /** Samakan label tombol cetak tunggal dengan halaman yang sedang aktif. */
    function updatePrintButtonLabel(isFollowup) {
      var btn = el('btn-portfolio-print');
      if (!btn) return;
      btn.innerHTML = isFollowup
        ? '<i class="fa-solid fa-print"></i> Cetak Formulir'
        : '<i class="fa-solid fa-print"></i> Cetak / Simpan PDF';
      btn.title = isFollowup
        ? 'Cetak formulir Follow-Up sesuai unit aktif'
        : 'Pratinjau & cetak laporan portofolio';
    }

    if (btnOverview) btnOverview.addEventListener('click', function () { showPortfolioPage('overview'); });
    if (btnFollowup) btnFollowup.addEventListener('click', function () { showPortfolioPage('followup'); });

    window.PORTFOLIO_PAGE_SHOW = showPortfolioPage;
  }

  /**
   * [FITUR 2026-10-05] Unit & kompartemen yang sedang dipilih pada filter
   * Overview — dipakai Form Follow-Up agar pemilihan unit cukup satu tempat.
   * @returns {{unitLambung:string, compartments:string[]}}
   */
  function currentSelection() {
    var st = (global.PORTFOLIO_RENDER && global.PORTFOLIO_RENDER.getState)
      ? global.PORTFOLIO_RENDER.getState() : {};
    var comps = (st.compartmentSelected && st.compartmentSelected.length)
      ? st.compartmentSelected.slice()
      : (st.compartment ? [st.compartment] : []);
    return { unitLambung: st.unitLambung || '', compartments: comps };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.PORTFOLIO_APP = {
    open: openPortfolio,
    openPrintFor: openPortfolioForPrint,   // [FITUR 2026-10-03] print per unit+kompartemen
    currentSelection: currentSelection,    // [FITUR 2026-10-05] dipakai Form Follow-Up
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

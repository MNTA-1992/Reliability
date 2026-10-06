/* =========================================================================
 * sos-app.js
 * -------------------------------------------------------------------------
 * Controller SOS tab — menangani upload, navigasi, event wiring.
 * Dijalankan sebagai tab embed di dalam VHMS Dashboard.
 * ========================================================================= */

(function (global) {
  'use strict';

  var parser   = global.SOS_PARSER;
  var analytics= global.SOS_ANALYTICS;
  var store    = global.SOS_STORE;
  var render   = global.SOS_RENDER;

  // [POST-6 2026-10-03] Debounce agar pencarian tidak render penuh tiap ketikan.
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  function toast(msg, type, ms) {
    // Re-use VHMS toast if available
    if (global.VHMS_APP && global.VHMS_APP.toast) {
      global.VHMS_APP.toast(msg, type, ms);
      return;
    }
    // Fallback
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) { console.log(msg); return; }
    var div = document.createElement('div');
    div.className = 'toast ' + (type || 'info');
    // [P1 A11Y 2026-10-05] Error -> role=alert (assertive).
    div.setAttribute('role', type === 'err' ? 'alert' : 'status');
    var icon = type === 'err' ? 'fa-circle-exclamation' : (type === 'ok' ? 'fa-circle-check' : 'fa-circle-info');
    div.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + (render.esc ? render.esc(msg) : msg) + '</span>';
    wrap.appendChild(div);
    setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, ms || 4000);
  }

  /* -----------------------------------------------------------------------
   * File processing
   * --------------------------------------------------------------------- */
  function processFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var files = Array.from(fileList).filter(function (f) {
      return /\.(csv|txt|xls|xlsx)$/i.test(f.name);
    });
    if (!files.length) { toast('Tidak ada file CSV/TXT yang valid.', 'err'); return; }

    var total = files.length, done = 0, totalAdded = 0, totalReplaced = 0, errors = [], warnings = [];
    var totalCorrected = 0, totalInvalidSamples = 0;

    files.forEach(function (file) {
      parser.parseFile(file).then(function (result) {
        if (result.errors.length > 0) {
          errors.push(file.name + ': ' + result.errors.join('; '));
        }
        // [FIX 2026-09-30] Kumpulkan peringatan kualitas data (nilai di luar
        // rentang wajar / desimal hilang pada file ekspor lab).
        if (result.meta && result.meta.warnings && result.meta.warnings.length) {
          warnings = warnings.concat(result.meta.warnings);
        }
        if (result.meta) {
          totalInvalidSamples += result.meta.samplesWithInvalid || 0;
        }
        (result.samples || []).forEach(function (s) {
          if (s._correctedParams && s._correctedParams.length) totalCorrected++;
        });
        // [DEDUP 2026-10-01] addSamples kini mengembalikan { added, replaced, total }.
        var res = store.addSamples(result.samples, file.name);
        var added = (typeof res === 'number') ? res : (res.added || 0);
        var replaced = (typeof res === 'object' && res) ? (res.replaced || 0) : 0;
        totalAdded += added;
        totalReplaced += replaced;
        done++;
        if (done === total) finishUpload(totalAdded, errors, warnings, totalCorrected, totalInvalidSamples, totalReplaced);
      }).catch(function (err) {
        errors.push(file.name + ': ' + err.message);
        done++;
        if (done === total) finishUpload(totalAdded, errors, warnings, totalCorrected, totalInvalidSamples, totalReplaced);
      });
    });
  }

  function finishUpload(totalAdded, errors, warnings, correctedCount, invalidSamples, replacedCount) {
    if (errors.length > 0) {
      toast('Peringatan: ' + errors.join(' | '), 'err', 6000);
    }
    // [FIX 2026-09-30] Transparansi kualitas data. Nilai yang dikoreksi TIDAK
    // membatalkan data (mis. viskositas 6274 -> 6.274). Nilai yang benar-benar
    // mustahil sudah dibuang dari analitik oleh parser.
    if (correctedCount > 0) {
      toast(correctedCount + ' nilai terkoreksi otomatis (mis. viskositas tanpa titik desimal pada file ekspor lab).', 'info', 6000);
    }
    if (invalidSamples > 0) {
      toast(invalidSamples + ' sampel memiliki nilai di luar rentang wajar; nilai tsb dibuang dari analitik.', 'err', 7000);
    } else if (!errors.length && warnings.length > 0) {
      toast(warnings[0], 'info', 6000);
    }
    // [DEDUP 2026-10-01] Transparansi hasil dedup: data baru MENGGANTIKAN lama.
    if (replacedCount > 0) {
      toast(replacedCount + ' sampel diperbarui (data baru menggantikan data lama dengan kunci sama).', 'info', 7000);
    }
    if (totalAdded > 0) {
      toast(totalAdded + ' sampel SOS berhasil dimuat.', 'ok');
      render.updateUploadVisibility();
      render.showView('fleet');
    } else if (replacedCount > 0) {
      // Tidak ada sampel BARU, tetapi ada data yang diperbarui -> bukan "kosong".
      render.showView('fleet');
    } else if (errors.length === 0) {
      toast('Tidak ada sampel baru (mungkin duplikat).', 'info');
    }
  }

  /* -----------------------------------------------------------------------
   * Navigation & event wiring
   * --------------------------------------------------------------------- */
  function openDetail(assetId, component) {
    render.renderAssetDetail(assetId, component);
    render.showView('detail');
  }

  /**
   * [FITUR 2026-10-03] Buka halaman Portofolio terfilter pada SATU unit +
   * kompartemen (dari baris SOS), lalu langsung tampilkan pratinjau cetak.
   * Dipakai tombol "Print" di tabel SOS Equipment.
   */
  function openPortfolioForPrint(assetId, component) {
    var app = global.PORTFOLIO_APP;
    if (!app) {
      if (typeof toast === 'function') toast('Halaman Portofolio belum siap.', 'err');
      return;
    }
    if (typeof app.openPrintFor === 'function') {
      app.openPrintFor(assetId, component);
    } else if (typeof app.open === 'function') {
      // Fallback: buka portofolio saja bila API khusus tak tersedia.
      app.open();
      if (typeof toast === 'function') toast('Fitur print per unit belum tersedia.', 'info');
    }
  }

  function init() {
    // Restore session data
    if (store.restore()) {
      toast('Data SOS sebelumnya dipulihkan dari sesi browser.', 'info');
    }

    // File input — dua tombol pemicu: "Pilih File" (form upload) & "Tambah SOS" (toolbar)
    var fileInput = document.getElementById('sos-file-input');
    var pickBtn = document.getElementById('sos-btn-pick');
    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.click(); });
    }
    var addBtn = document.getElementById('sos-btn-add');
    if (addBtn && fileInput) {
      addBtn.addEventListener('click', function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processFiles(e.target.files);
        e.target.value = '';
      });
    }

    // Clear
    var clearBtn = document.getElementById('sos-btn-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        // Bila controller VHMS tersedia, tombol ini mengosongkan SEMUA data
        // (VHMS + SOS) dengan konfirmasi — konsisten dengan tombol VHMS.
        if (global.VHMS_APP && global.VHMS_APP.clearAllData) {
          global.VHMS_APP.clearAllData();
          return;
        }
        // Fallback: hapus SOS saja.
        store.clear();
        render.updateUploadVisibility();
        render.showView('fleet');
        toast('Data SOS dihapus.', 'info');
      });
    }

    // Heatmap
    var heatBtn = document.getElementById('sos-btn-heatmap');
    if (heatBtn) heatBtn.addEventListener('click', function () { render.showView('heatmap'); });
    var heatClose = document.getElementById('sos-btn-heatmap-close');
    if (heatClose) heatClose.addEventListener('click', function () { render.showView('fleet'); });

    // Perbandingan (overlay antar kompartemen)
    var compBtn = document.getElementById('sos-btn-comparison');
    if (compBtn) compBtn.addEventListener('click', function () { render.showView('comparison'); });
    var compClose = document.getElementById('sos-btn-comparison-close');
    if (compClose) compClose.addEventListener('click', function () { render.showView('fleet'); });
    var compDraw = document.getElementById('sos-btn-comp-draw');
    if (compDraw) compDraw.addEventListener('click', render.renderComparison);

    // Fleet table click delegation
    var fleetBody = document.getElementById('sos-fleet-body');
    if (fleetBody) {
      fleetBody.addEventListener('click', function (e) {
        // [FITUR 2026-10-03] Tombol Print per baris -> buka Portofolio unit +
        // kompartemen baris ini, lalu langsung tampilkan pratinjau cetak.
        var printBtn = e.target.closest('[data-sos-print]');
        if (printBtn) {
          e.stopPropagation();
          var pp = printBtn.getAttribute('data-sos-print').split('|');
          openPortfolioForPrint(pp[0], pp[1]);
          return;
        }
        var detailBtn = e.target.closest('[data-sos-detail]');
        if (detailBtn) {
          var parts = detailBtn.getAttribute('data-sos-detail').split('|');
          openDetail(parts[0], parts[1]);
          return;
        }
        var row = e.target.closest('[data-sos-unit]');
        if (row) {
          openDetail(row.getAttribute('data-sos-unit'), row.getAttribute('data-sos-comp'));
        }
      });
    }

    // Component tab switching in detail view
    document.addEventListener('click', function (e) {
      var compBtn = e.target.closest('[data-sos-switch-comp]');
      if (compBtn) {
        var parts = compBtn.getAttribute('data-sos-switch-comp').split('|');
        openDetail(parts[0], parts[1]);
      }
    });

    // Search
    var searchInput = document.getElementById('sos-fleet-search');
    if (searchInput) {
      var runSosSearch = debounce(function () {
        render.setFleetState({ search: searchInput.value, page: 1 });
        render.renderFleetTable();
      }, 200);
      searchInput.addEventListener('input', runSosSearch);
    }

    // [FITUR 2026-10-06] Filter SECTION (dropdown di baris filter, kiri chip).
    var sectionSel = document.getElementById('sos-fleet-section');
    if (sectionSel) {
      sectionSel.addEventListener('change', function () {
        render.setFleetState({ section: sectionSel.value, page: 1 });
        render.renderFleetTable();
      });
    }

    // [POST-5 2026-10-03] Kontrol paginasi tabel SOS fleet.
    document.addEventListener('click', function (e) {
      var pg = e.target.closest('[data-sos-page]');
      if (!pg || pg.disabled) return;
      var p = parseInt(pg.getAttribute('data-sos-page'), 10);
      if (!p || p < 1) return;
      render.setFleetState({ page: p });
      render.renderFleetTable();
    });

    // Indikator arah sortir pada header (▲/▼) untuk tabel SOS Equipment.
    function updateSortIndicators(activeKey, dir) {
      document.querySelectorAll('#sos-fleet-head th[data-sos-sort]').forEach(function (th) {
        var k = th.getAttribute('data-sos-sort');
        var base = th.getAttribute('data-label') || th.textContent.replace(/[\u25B2\u25BC]\s*$/, '').trim();
        th.setAttribute('data-label', base);
        th.innerHTML = base + (k === activeKey ? (dir === 'asc' ? ' <span style="font-size:11px">▲</span>' : ' <span style="font-size:11px">▼</span>') : '');
      });
    }
    window.__sosUpdateSortIndicators = updateSortIndicators;

    // Mode nilai parameter (Terakhir / Rata-rata / Terburuk)
    var valueModeSel = document.getElementById('sos-value-mode');
    if (valueModeSel) {
      valueModeSel.addEventListener('change', function () {
        render.setFleetState({ valueMode: valueModeSel.value, page: 1 });
        render.renderFleetTable();
      });
    }

    // Quick filter chips
    var filterBar = document.getElementById('sos-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-sos-quick-filter]');
        if (chip) {
          render.setFleetState({ filter: chip.getAttribute('data-sos-quick-filter'), page: 1 });
          render.renderFleetTable();
        }
      });
    }

    // Sort headers — semua kolom bisa diklik (asc/desc toggle).
    // Khusus "Peringkat": arah asc = 1 paling atas (paling critical).
    document.querySelectorAll('#sos-fleet-head th[data-sos-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sos-sort');
        var st = render.getFleetState();
        var dir = (st.sortKey === k && st.sortDir === 'desc') ? 'asc' : 'desc';
        render.setFleetState({ sortKey: k, sortDir: dir, page: 1 });
        render.renderFleetTable();
        updateSortIndicators(k, dir);
      });
    });
    updateSortIndicators(render.getFleetState().sortKey, render.getFleetState().sortDir);

    // Drag & drop on SOS dropzone
    var dz = document.getElementById('sos-dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
      });
      dz.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) processFiles(dt.files);
      });
    }

    // Show fleet view if data exists
    if (store.count() > 0) {
      render.showView('fleet');
    }
  }

  global.SOS_APP = {
    init: init,
    processFiles: processFiles,
    openDetail: openDetail,
    toast: toast,
    getState: function () {
      return {
        view: global.SOS_RENDER ? global.SOS_RENDER.getView() : 'fleet',
        currentUnit: global.SOS_RENDER ? global.SOS_RENDER.getCurrentUnit() : null
      };
    },
  };

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Defer slightly to ensure SOS modules are loaded after VHMS
    setTimeout(init, 100);
  }

})(typeof window !== 'undefined' ? window : globalThis);

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
  var cfg      = global.SOS_CONFIG;

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

    var total = files.length, done = 0, totalAdded = 0, errors = [];

    files.forEach(function (file) {
      parser.parseFile(file).then(function (result) {
        if (result.errors.length > 0) {
          errors.push(file.name + ': ' + result.errors.join('; '));
        }
        var added = store.addSamples(result.samples, file.name);
        totalAdded += added;
        done++;
        if (done === total) finishUpload(totalAdded, errors);
      }).catch(function (err) {
        errors.push(file.name + ': ' + err.message);
        done++;
        if (done === total) finishUpload(totalAdded, errors);
      });
    });
  }

  function finishUpload(totalAdded, errors) {
    if (errors.length > 0) {
      toast('Peringatan: ' + errors.join(' | '), 'err', 6000);
    }
    if (totalAdded > 0) {
      toast(totalAdded + ' sampel SOS berhasil dimuat.', 'ok');
      render.updateUploadVisibility();
      render.showView('fleet');
    } else if (errors.length === 0) {
      toast('Tidak ada sampel baru (mungkin duplikat).', 'info');
    }
  }

  /* -----------------------------------------------------------------------
   * Export CSV
   * --------------------------------------------------------------------- */
  function exportFleetCsv() {
    var units = store.getAllUnits();
    if (!units.length) { toast('Belum ada data untuk diekspor.', 'err'); return; }

    var headers = ['Asset ID','Model','Component','HM Unit','HM Oil','Status','MPRS','Criticality Score','Band',
      'Fe','Cu','Al','Si','Cr','Pb','V100','Water%','Fuel%','PQI','ISO','Tanggal Terakhir','Jumlah Sampel'];
    var lines = [headers.join(';')];

    units.forEach(function (u) {
      var s = u.latest;
      function n(v, d) { return v === null || v === undefined ? '' : Number(v).toFixed(d).replace('.', ','); }
      lines.push([
        u.assetId, u.model, u.component, n(u.hmUnit, 0), n(u.hmOil, 0),
        cfg.TIER_LABELS[u.mprs.tier], n(u.mprs.mprs, 1), n(u.criticality.score, 1), u.criticality.band,
        n(s.wear_fe, 1), n(s.wear_cu, 1), n(s.wear_al, 1), n(s.wear_si, 1), n(s.wear_cr, 1), n(s.wear_pb, 1),
        n(s.visc_v100, 2), n(s.water_pct, 2), n(s.fuel_pct, 2), n(s.pqi, 0), s.iso_code || '',
        u.lastDate || '', u.sampleCount
      ].join(';'));
    });

    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'sos-fleet-summary.csv');
    toast('Data SOS berhasil diekspor (' + units.length + ' kompartemen).', 'ok');
  }

  function exportRankingCsv() {
    var ranked = store.getRankedUnits();
    if (!ranked.length) { toast('Belum ada data.', 'err'); return; }

    var headers = ['Rank','Asset ID','Model','Component','Band','Skor','Keparahan','Bukti','Tren','MPRS','Diagnostik'];
    var lines = [headers.join(';')];
    ranked.forEach(function (r) {
      function n(v) { return String(v).replace('.', ','); }
      lines.push([r.rank, r.assetId, r.model, r.component, r.band, n(r.score),
        n(r.axis.severity), n(r.axis.evidence), n(r.axis.trend), n(r.mprs), r.topDiagnostic || ''
      ].join(';'));
    });

    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'sos-criticality-ranking.csv');
    toast('Ranking berhasil diekspor.', 'ok');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  /* -----------------------------------------------------------------------
   * Navigation & event wiring
   * --------------------------------------------------------------------- */
  function openDetail(assetId, component) {
    render.renderAssetDetail(assetId, component);
    render.showView('detail');
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

    // Export buttons
    var expFleet = document.getElementById('sos-btn-export');
    if (expFleet) expFleet.addEventListener('click', exportFleetCsv);

    var expRank = document.getElementById('sos-btn-export-ranking');
    if (expRank) expRank.addEventListener('click', exportRankingCsv);

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
      searchInput.addEventListener('input', function () {
        render.setFleetState({ search: searchInput.value });
        render.renderFleetTable();
      });
    }

    // Filter dropdown
    var filterSel = document.getElementById('sos-fleet-filter');
    if (filterSel) {
      filterSel.addEventListener('change', function () {
        render.setFleetState({ filter: filterSel.value });
        render.renderFleetTable();
      });
    }

    // Mode nilai parameter (Terakhir / Rata-rata / Terburuk)
    var valueModeSel = document.getElementById('sos-value-mode');
    if (valueModeSel) {
      valueModeSel.addEventListener('change', function () {
        render.setFleetState({ valueMode: valueModeSel.value });
        render.renderFleetTable();
      });
    }

    // Quick filter chips
    var filterBar = document.getElementById('sos-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-sos-quick-filter]');
        if (chip) {
          render.setFleetState({ filter: chip.getAttribute('data-sos-quick-filter') });
          render.renderFleetTable();
        }
      });
    }

    // Sort headers
    document.querySelectorAll('#sos-fleet-head th[data-sos-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sos-sort');
        var st = render.getFleetState();
        // Kolom "severity" selalu diurutkan worst→best (arah tetap).
        if (k === 'severity') {
          render.setFleetState({ sortKey: 'severity', sortDir: 'desc' });
          render.renderFleetTable();
          return;
        }
        var dir = (st.sortKey === k && st.sortDir === 'desc') ? 'asc' : 'desc';
        render.setFleetState({ sortKey: k, sortDir: dir });
        render.renderFleetTable();
      });
    });

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

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_APP = {
    init: init,
    processFiles: processFiles,
    openDetail: openDetail,
    exportFleetCsv: exportFleetCsv,
    exportRankingCsv: exportRankingCsv,
    toast: toast,
  };

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Defer slightly to ensure SOS modules are loaded after VHMS
    setTimeout(init, 100);
  }

})(typeof window !== 'undefined' ? window : globalThis);

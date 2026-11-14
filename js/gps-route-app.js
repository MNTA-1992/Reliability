/* =========================================================================
 * gps-route-app.js
 * -------------------------------------------------------------------------
 * [GPS ROUTE REPAIR INTELLIGENCE · 2026-11-02]
 * Controller Aplikasi untuk Dashboard Intel Rute GPS:
 *   - Pengendali sub-tab pada Fuel Trending Analysis;
 *   - Penanganan deteksi protokol server http:// vs file://;
 *   - Pengikatan event header, filter, KPI cards, visual SVG, drawer;
 *   - Penyimpanan interaktif verifikasi operator (nama resmi, status, WO);
 *   - Unduh ekspor CSV data rute & draft work order;
 *   - Integrasi navigasi ke Fuel Trending detail unit.
 * ========================================================================= */

(function (global) {
  'use strict';

  var STORE = global.GPS_ROUTE_STORE || null;
  var ANALYTICS = global.GPS_ROUTE_ANALYTICS || null;
  var RENDER = global.GPS_ROUTE_RENDER || null;

  var _state = {
    subTab: 'trending',          // 'trending' | 'route-intel'
    filter: {
      startDate: '',
      endDate: '',
      routeId: '',
      minSeverity: 0,
      tier: '',
      onlyUnverified: false
    },
    selectedRouteId: null,
    analyzedFleet: null
  };

  function $id(id) {
    return (global.document && typeof global.document.getElementById === 'function')
      ? global.document.getElementById(id)
      : null;
  }

  function toast(msg, kind) {
    if (global.VHMS_APP && typeof global.VHMS_APP.toast === 'function') {
      global.VHMS_APP.toast(msg, kind);
      return;
    }
    if (global.console) console.log('[GPS_ROUTE] ' + msg);
  }

  function isHttpProtocol() {
    if (typeof location === 'undefined') return true;
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function downloadCsv(filename, content) {
    if (!content) return;
    try {
      var blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      if (global.console) console.warn('[GPS_ROUTE] Gagal unduh CSV:', e);
    }
  }

  /* -----------------------------------------------------------------------
   * Siklus Hidup & Render Sub-Tab
   * --------------------------------------------------------------------- */

  function setSubTab(tabName) {
    _state.subTab = tabName === 'route-intel' ? 'route-intel' : 'trending';

    var btnTrending = $id('btn-subtab-fuel-trending');
    var btnRoute = $id('btn-subtab-fuel-route');
    var panelTrending = $id('fuel-trending-subtab-panel');
    var panelRoute = $id('fuel-route-intel-subtab-panel');

    if (btnTrending) {
      if (_state.subTab === 'trending') btnTrending.classList.add('active');
      else btnTrending.classList.remove('active');
    }
    if (btnRoute) {
      if (_state.subTab === 'route-intel') btnRoute.classList.add('active');
      else btnRoute.classList.remove('active');
    }

    if (panelTrending) {
      panelTrending.style.display = (_state.subTab === 'trending') ? '' : 'none';
    }
    if (panelRoute) {
      panelRoute.style.display = (_state.subTab === 'route-intel') ? '' : 'none';
      if (_state.subTab === 'route-intel') {
        renderRouteIntelDashboard();
      }
    }
  }

  function renderRouteIntelDashboard() {
    var container = $id('fuel-route-intel-container');
    if (!container) return;

    if (!isHttpProtocol()) {
      container.innerHTML = [
        '<div class="panel" style="padding:28px;text-align:center">',
        '  <div style="font-size:32px;color:#f59e0b;margin-bottom:12px"><i class="fa-solid fa-triangle-exclamation"></i></div>',
        '  <h3 class="panel-title" style="margin-bottom:8px">Akses Melalui Protokol HTTP Diperlukan</h3>',
        '  <p class="panel-sub" style="max-width:560px;margin:0 auto 16px auto">',
        '    Dashboard Intel Rute GPS membutuhkan pembacaan berkas hasil telemetri melalui server lokal. ',
        '    Pada protokol <code>file://</code>, peramban memblokir pengambilan berkas CSV.',
        '  </p>',
        '  <p class="panel-sub">Jalankan <code>node serve.js</code> di terminal lalu buka <strong>http://127.0.0.1:5500</strong>.</p>',
        '</div>'
      ].join('\n');
      return;
    }

    if (!STORE || !ANALYTICS || !RENDER) {
      container.innerHTML = '<div class="panel" style="padding:24px;text-align:center"><p class="panel-sub text-red">Modul GPS Route belum siap.</p></div>';
      return;
    }

    // Bila belum dimuat, coba muat otomatis dari sample-data/data-gps/
    if (!STORE.isLoaded()) {
      container.innerHTML = [
        '<div class="panel" style="padding:32px;text-align:center">',
        '  <i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:#22d3ee;margin-bottom:12px"></i>',
        '  <p class="panel-sub">Memuat berkas inferensi rute GPS...</p>',
        '</div>'
      ].join('\n');

      STORE.loadData().then(function () {
        renderRouteIntelDashboard();
      }).catch(function (err) {
        container.innerHTML = [
          '<div class="panel" style="padding:28px;text-align:center">',
          '  <div style="font-size:32px;color:#ef4444;margin-bottom:12px"><i class="fa-solid fa-triangle-exclamation"></i></div>',
          '  <h3 class="panel-title" style="margin-bottom:8px">Berkas Rute GPS Belum Tersedia</h3>',
          '  <p class="panel-sub" style="max-width:540px;margin:0 auto 16px auto">',
          '    ' + (err.message || 'Tidak dapat memuat berkas rute GPS turunan.') + '<br>',
          '    Pastikan proses agregasi GPS dan rute jalan telah dijalankan.',
          '  </p>',
          '  <div style="display:flex;gap:10px;justify-content:center">',
          '    <button class="btn btn-ghost btn-sm" id="btn-gps-initial-aggregate"><i class="fa-solid fa-satellite-dish"></i> Generate Agregat GPS</button>',
          '    <button class="btn btn-ghost btn-sm" id="btn-gps-initial-road"><i class="fa-solid fa-road"></i> Generate Rute GPS</button>',
          '    <button class="btn btn-ghost btn-sm" id="btn-gps-initial-reload"><i class="fa-solid fa-rotate-right"></i> Coba Lagi</button>',
          '  </div>',
          '</div>'
        ].join('\n');
        bindInitialActionButtons();
      });
      return;
    }

    // Ambil data untuk analisis
    var routes = STORE.getRoutes();
    var assignments = STORE.getAllAssignments();
    var segments = STORE.getAllSegments();

    // Data Fuel Units dari FUEL_STORE (bila ada)
    var fuelUnits = [];
    if (global.FUEL_STORE && typeof global.FUEL_STORE.list === 'function') {
      fuelUnits = global.FUEL_STORE.list();
    }

    // Unit DB
    var unitDb = global.VHMS_UNITDB || null;

    // Jalankan analisis armada
    var analysis = ANALYTICS.analyzeFleetRoutes(routes, assignments, segments, fuelUnits, unitDb, _state.filter);
    _state.analyzedFleet = analysis;

    // Filter tambahan lokal: onlyUnverified
    var displayRoutes = analysis.routes;
    if (_state.filter.onlyUnverified) {
      displayRoutes = displayRoutes.filter(function (ar) {
        var meta = STORE.getRouteMeta(ar.route_id);
        return (!meta.status || meta.status === 'candidate');
      });
    }

    // Ambil user meta map
    var userMetaMap = {};
    routes.forEach(function (r) {
      userMetaMap[r.route_id] = STORE.getRouteMeta(r.route_id);
    });

    // Susun options rute untuk filter dropdown
    var routeOptions = routes.map(function (r) { return r.route_id; });
    var filterWithOpts = Object.assign({}, _state.filter, { routeOptions: routeOptions });

    // Render HTML Komponen
    var html = [
      RENDER.renderHeaderActions(STORE.getStateSummary(), filterWithOpts),
      RENDER.renderKpiCards(analysis.kpi, _state.filter.tier),
      RENDER.renderCoordinateMapSvg(displayRoutes, segments, _state.selectedRouteId),
      RENDER.renderPriorityTable(displayRoutes, userMetaMap),
      '<div id="gps-drawer-mount"></div>'
    ].join('\n');

    container.innerHTML = html;
    bindDashboardEvents();
  }

  /* -----------------------------------------------------------------------
   * Binding Event Dashboard
   * --------------------------------------------------------------------- */

  function bindInitialActionButtons() {
    var btnAgg = $id('btn-gps-initial-aggregate');
    var btnRoad = $id('btn-gps-initial-road');
    var btnRel = $id('btn-gps-initial-reload');

    if (btnAgg) btnAgg.addEventListener('click', function () { runGenerator('/api/gps/aggregate', btnAgg, 'Generate Agregat GPS'); });
    if (btnRoad) btnRoad.addEventListener('click', function () { runGenerator('/api/gps/road-derive', btnRoad, 'Generate Rute GPS'); });
    if (btnRel) btnRel.addEventListener('click', function () { renderRouteIntelDashboard(); });
  }

  function runGenerator(endpoint, btn, label) {
    if (btn) btn.disabled = true;
    toast(label + ' sedang dijalankan...', 'info');
    fetch(endpoint, { method: 'POST' }).then(function (res) {
      return res.json().catch(function () { return { ok: false, message: 'Respons server tidak valid' }; });
    }).then(function (result) {
      if (!result.ok) throw new Error(result.message || 'Gagal');
      toast(result.message || label + ' selesai', 'ok');
      if (STORE) STORE.loadData().then(function () { renderRouteIntelDashboard(); });
    }).catch(function (err) {
      toast(err.message || 'Gagal menjalankan generator', 'err');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function bindDashboardEvents() {
    var container = $id('fuel-route-intel-container');
    if (!container) return;

    // 1. Generator Buttons
    var btnAgg = $id('btn-gps-route-aggregate');
    var btnRoad = $id('btn-gps-route-road');
    var btnRel = $id('btn-gps-route-reload');

    if (btnAgg) btnAgg.addEventListener('click', function () { runGenerator('/api/gps/aggregate', btnAgg, 'Generate Agregat GPS'); });
    if (btnRoad) btnRoad.addEventListener('click', function () { runGenerator('/api/gps/road-derive', btnRoad, 'Generate Rute GPS'); });
    if (btnRel) btnRel.addEventListener('click', function () {
      if (STORE) {
        STORE.loadData().then(function () {
          toast('Data Rute GPS berhasil diperbarui', 'ok');
          renderRouteIntelDashboard();
        }).catch(function (err) {
          toast(err.message || 'Gagal memuat ulang', 'err');
        });
      }
    });

    // 2. Filter Bar
    var inStart = $id('gps-filter-start');
    var inEnd = $id('gps-filter-end');
    var selRoute = $id('gps-filter-route');
    var selSev = $id('gps-filter-min-sev');
    var chkUnver = $id('gps-filter-unverified');

    if (inStart) inStart.addEventListener('change', function () { _state.filter.startDate = inStart.value; renderRouteIntelDashboard(); });
    if (inEnd) inEnd.addEventListener('change', function () { _state.filter.endDate = inEnd.value; renderRouteIntelDashboard(); });
    if (selRoute) selRoute.addEventListener('change', function () { _state.filter.routeId = selRoute.value; renderRouteIntelDashboard(); });
    if (selSev) selSev.addEventListener('change', function () { _state.filter.minSeverity = parseInt(selSev.value, 10) || 0; renderRouteIntelDashboard(); });
    if (chkUnver) chkUnver.addEventListener('change', function () { _state.filter.onlyUnverified = !!chkUnver.checked; renderRouteIntelDashboard(); });

    // 3. KPI Cards Filter
    var cards = container.querySelectorAll('.gps-kpi-card');
    cards.forEach(function (c) {
      c.addEventListener('click', function () {
        var kpiType = c.getAttribute('data-kpi-filter');
        if (kpiType === 'P1') {
          _state.filter.tier = (_state.filter.tier === 'P1') ? '' : 'P1';
        } else if (kpiType === 'fuel') {
          _state.filter.minSeverity = (_state.filter.minSeverity === 35) ? 0 : 35;
        } else {
          _state.filter.tier = '';
        }
        renderRouteIntelDashboard();
      });
    });

    // 4. Delegasi event pada container: Buka Route Detail, Klik SVG, Salin Koordinat
    container.addEventListener('click', function (e) {
      var t = e.target;

      // Copy coordinate
      var copyBtn = t.closest('.btn-copy-coord');
      if (copyBtn) {
        var coord = copyBtn.getAttribute('data-coord');
        if (coord && global.navigator && navigator.clipboard) {
          navigator.clipboard.writeText(coord).then(function () {
            toast('Koordinat disalin: ' + coord, 'ok');
          });
        }
        return;
      }

      // Open detail button
      var openBtn = t.closest('.btn-open-route-detail');
      if (openBtn) {
        var rId = openBtn.getAttribute('data-route-id');
        openRouteDrawer(rId);
        return;
      }

      // Click SVG Point or Route BBox
      var svgPoint = t.closest('.gps-segment-point');
      if (svgPoint) {
        var pRouteId = svgPoint.getAttribute('data-route-id');
        if (pRouteId) openRouteDrawer(pRouteId);
        return;
      }

      var svgBbox = t.closest('.gps-route-bbox');
      if (svgBbox) {
        var bRouteId = svgBbox.getAttribute('data-route-id');
        if (bRouteId) openRouteDrawer(bRouteId);
        return;
      }
    });

    // 5. Sort header tabel prioritas GPS
    _bindGpsPrioritySort();

    // 6. Filter search tabel prioritas GPS
    _bindGpsPriorityFilter();
  }

  /* -----------------------------------------------------------------------
   * Sort & Filter lokal tabel GPS Priority (tanpa re-render seluruh panel)
   * --------------------------------------------------------------------- */
  var _gpsSort = { key: 'score', dir: 1 };
  var _gpsAllRows = null;   // cache NodeList <tr> asli setelah render

  function _getGpsSortValue(tr, key) {
    var rId = tr.getAttribute('data-route-id');
    if (!rId || !_state.analyzedFleet) return '';
    var ar = null;
    (_state.analyzedFleet.routes || []).forEach(function (r) {
      if (r.route_id === rId) ar = r;
    });
    if (!ar) return '';
    if (key === 'score') return ar.priority ? ar.priority.score : 0;
    if (key === 'routeId') return rId;
    if (key === 'severity') return ar.maxSeverity || 0;
    if (key === 'unitCount') return ar.unitCount || 0;
    if (key === 'exposureKm') return ar.exposureKm != null ? ar.exposureKm : -Infinity;
    if (key === 'fuelDelta') return (ar.fuelImpact && ar.fuelImpact.deltaLtkPct != null)
      ? ar.fuelImpact.deltaLtkPct : -Infinity;
    return '';
  }

  function _applyGpsSort(tbody, rows) {
    if (!tbody) return;
    var sorted = rows.slice().sort(function (a, b) {
      var va = _getGpsSortValue(a, _gpsSort.key);
      var vb = _getGpsSortValue(b, _gpsSort.key);
      if (typeof va === 'string' && typeof vb === 'string') {
        return _gpsSort.dir * va.localeCompare(vb);
      }
      return _gpsSort.dir * (va < vb ? -1 : va > vb ? 1 : 0);
    });
    sorted.forEach(function (tr) { tbody.appendChild(tr); });
  }

  function _applyGpsFilter() {
    var tbody = $id('gps-priority-tbody');
    if (!tbody || !_gpsAllRows) return;
    var q = (($id('gps-priority-search') || {}).value || '').toLowerCase();
    var tierF = ($id('gps-priority-filter-tier') || {}).value || '';

    var visible = [];
    _gpsAllRows.forEach(function (tr) {
      var rId = (tr.getAttribute('data-route-id') || '').toLowerCase();
      var ar = null;
      if (_state.analyzedFleet) {
        (_state.analyzedFleet.routes || []).forEach(function (r) {
          if (r.route_id.toLowerCase() === rId) ar = r;
        });
      }
      var matchQ = !q || rId.indexOf(q) >= 0 ||
        (tr.textContent || '').toLowerCase().indexOf(q) >= 0;
      var matchTier = !tierF || (ar && ar.priority && ar.priority.tier === tierF);
      tr.style.display = (matchQ && matchTier) ? '' : 'none';
      if (matchQ && matchTier) visible.push(tr);
    });

    // Update count chip
    var countEl = $id('gps-priority-table-count');
    if (countEl) {
      countEl.textContent = visible.length + ' rute' +
        (visible.length < _gpsAllRows.length ? ' (filter aktif)' : '');
    }

    _applyGpsSort(tbody, visible);
  }

  function _bindGpsPrioritySort() {
    var tbl = $id('gps-priority-table');
    if (!tbl) return;
    var tbody = $id('gps-priority-tbody');
    if (!tbody) return;

    // Cache baris asli
    _gpsAllRows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-route-id]'));

    var ths = tbl.querySelectorAll('thead th[data-gps-sort]');
    ths.forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-gps-sort');
        if (_gpsSort.key === k) { _gpsSort.dir *= -1; }
        else { _gpsSort.key = k; _gpsSort.dir = 1; }

        // Update arrow indicators
        ths.forEach(function (t) {
          var ind = t.querySelector('.sort-ind');
          if (ind) {
            if (t.getAttribute('data-gps-sort') === _gpsSort.key) {
              ind.textContent = _gpsSort.dir === 1 ? '↑' : '↓';
              ind.classList.add('active');
            } else {
              ind.textContent = '⇅';
              ind.classList.remove('active');
            }
          }
        });

        var visibleRows = _gpsAllRows.filter(function (tr) {
          return tr.style.display !== 'none';
        });
        _applyGpsSort(tbody, visibleRows);
      });
    });
  }

  function _bindGpsPriorityFilter() {
    var srch = $id('gps-priority-search');
    if (srch) srch.addEventListener('input', _applyGpsFilter);
    var tierSel = $id('gps-priority-filter-tier');
    if (tierSel) tierSel.addEventListener('change', _applyGpsFilter);
  }

  /* -----------------------------------------------------------------------
   * Drawer Detail Route (§5)
   * --------------------------------------------------------------------- */

  function openRouteDrawer(routeId) {
    if (!routeId || !STORE || !ANALYTICS || !RENDER) return;
    _state.selectedRouteId = routeId;

    var route = STORE.getRoute(routeId);
    if (!route) {
      toast('Rute ' + routeId + ' tidak ditemukan', 'err');
      return;
    }

    var assignments = STORE.getAssignments(routeId);
    var segments = STORE.getSegments(routeId);
    var fuelUnits = (global.FUEL_STORE && typeof global.FUEL_STORE.list === 'function')
      ? global.FUEL_STORE.list() : [];
    var unitDb = global.VHMS_UNITDB || null;

    var analyzedRoute = ANALYTICS.analyzeRoute(route, assignments, segments, fuelUnits, unitDb, _state.filter);
    var userMeta = STORE.getRouteMeta(routeId);
    var repairPlan = STORE.getRepairPlan(routeId);

    var mount = $id('gps-drawer-mount');
    if (!mount) return;

    mount.innerHTML = RENDER.renderRouteDetailDrawer(analyzedRoute, userMeta, repairPlan);
    bindDrawerEvents(analyzedRoute);
  }

  function closeRouteDrawer() {
    _state.selectedRouteId = null;
    var mount = $id('gps-drawer-mount');
    if (mount) mount.innerHTML = '';
  }

  function bindDrawerEvents(analyzedRoute) {
    var closeBtn = $id('btn-close-gps-drawer');
    var backdrop = $id('gps-drawer-backdrop');
    if (closeBtn) closeBtn.addEventListener('click', closeRouteDrawer);
    if (backdrop) backdrop.addEventListener('click', closeRouteDrawer);

    var rId = analyzedRoute.route_id;

    // Simpan Identitas & Status
    var saveMetaBtn = $id('btn-save-route-meta');
    if (saveMetaBtn) {
      saveMetaBtn.addEventListener('click', function () {
        var offName = ($id('gps-drawer-official-name') || {}).value || '';
        var engId = ($id('gps-drawer-eng-id') || {}).value || '';
        var st = ($id('gps-drawer-status') || {}).value || 'candidate';
        var notes = ($id('gps-drawer-notes') || {}).value || '';

        STORE.setRouteMeta(rId, {
          officialName: offName.trim(),
          engineeringId: engId.trim(),
          status: st,
          notes: notes.trim()
        });
        toast('Identitas dan status rute ' + rId + ' berhasil disimpan', 'ok');
        renderRouteIntelDashboard();
        openRouteDrawer(rId);
      });
    }

    // Ekspor Route CSV
    var expRouteBtn = $id('btn-export-route-csv');
    if (expRouteBtn) {
      expRouteBtn.addEventListener('click', function () {
        var csv = RENDER.exportRouteDetailCsv(analyzedRoute);
        downloadCsv('Route-Detail-' + rId + '.csv', csv);
      });
    }

    // Simpan Rencana Perbaikan (Work Order)
    var savePlanBtn = $id('btn-save-repair-plan');
    if (savePlanBtn) {
      savePlanBtn.addEventListener('click', function () {
        var action = ($id('gps-plan-action') || {}).value || '';
        var owner = ($id('gps-plan-owner') || {}).value || '';
        var tDate = ($id('gps-plan-target-date') || {}).value || '';
        var st = ($id('gps-plan-status') || {}).value || 'planned';
        var baseline = parseFloat(($id('gps-plan-baseline') || {}).value) || null;
        var reeval = ($id('gps-plan-reeval-date') || {}).value || '';
        var notes = ($id('gps-plan-notes') || {}).value || '';

        STORE.setRepairPlan(rId, {
          action: action,
          owner: owner.trim(),
          targetDate: tDate,
          status: st,
          baselineFuel: baseline,
          reevaluationDate: reeval,
          notes: notes.trim()
        });
        toast('Rencana perbaikan rute ' + rId + ' berhasil disimpan', 'ok');
      });
    }

    // Ekspor Work Order Draft CSV
    var expWoBtn = $id('btn-export-work-order');
    if (expWoBtn) {
      expWoBtn.addEventListener('click', function () {
        var plan = STORE.getRepairPlan(rId) || {};
        var csv = RENDER.exportWorkOrderCsv(analyzedRoute, plan);
        downloadCsv('WorkOrder-Draft-' + rId + '.csv', csv);
      });
    }

    // Navigasi ke Fuel Trending Detail Unit bila link unit diklik
    var mount = $id('gps-drawer-mount');
    if (mount) {
      mount.addEventListener('click', function (e) {
        var unitLink = e.target.closest('.gps-unit-link');
        if (unitLink) {
          var unitName = unitLink.getAttribute('data-unit');
          if (unitName && global.FUEL_APP && typeof global.FUEL_APP.selectUnit === 'function') {
            closeRouteDrawer();
            setSubTab('trending');
            global.FUEL_APP.selectUnit(unitName);
          }
        }
      });
    }
  }

  /* -----------------------------------------------------------------------
   * Inisialisasi Modul
   * --------------------------------------------------------------------- */

  function init() {
    var btnTrending = $id('btn-subtab-fuel-trending');
    var btnRoute = $id('btn-subtab-fuel-route');

    if (btnTrending) {
      btnTrending.addEventListener('click', function () { setSubTab('trending'); });
    }
    if (btnRoute) {
      btnRoute.addEventListener('click', function () { setSubTab('route-intel'); });
    }
  }

  var API = {
    init: init,
    setSubTab: setSubTab,
    renderRouteIntelDashboard: renderRouteIntelDashboard,
    openRouteDrawer: openRouteDrawer,
    closeRouteDrawer: closeRouteDrawer
  };

  global.GPS_ROUTE_APP = API;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init);
  }

})(typeof window !== 'undefined' ? window : global);

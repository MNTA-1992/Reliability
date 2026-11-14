/* =========================================================================
 * gps-route-store.js
 * -------------------------------------------------------------------------
 * [GPS ROUTE REPAIR INTELLIGENCE · 2026-11-02]
 * Penyimpanan dan loader data turunan GPS:
 *   - road-gps-inferred-master.csv
 *   - road-gps-inferred-unit-assignment.csv
 *   - road-gps-inferred-repair-segments.csv
 *   - road-gps-inferred.csv (ringkasan rute)
 *
 * MURNI DATA & I/O:
 *   - Fetch berkas hasil GPS dari server lokal (sample-data/data-gps/);
 *   - Parse CSV ke struktur objek in-memory yang rapi;
 *   - TIDAK menyimpan track mentah berukuran besar;
 *   - Menyimpan anotasi/verifikasi operator lokal di localStorage (`gps.route.meta.v1`);
 *   - Bekerja di peramban dan di Node.js (untuk pengujian otomatis).
 * ========================================================================= */

(function (global) {
  'use strict';

  var LS_KEY = 'gps.route.meta.v1';

  var _csv = global.CSV_UTIL || null;

  /* Helper pembaca angka aman */
  function num(val) {
    if (val === null || val === undefined || val === '') return null;
    var n = parseFloat(String(val).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function intVal(val) {
    var n = num(val);
    return n === null ? null : Math.round(n);
  }

  function splitLine(line, delim) {
    if (_csv && typeof _csv.splitLine === 'function') {
      return _csv.splitLine(line, delim);
    }
    var d = delim || ',';
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === d) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }

  function parseCsvRows(text) {
    if (!text || typeof text !== 'string') return [];
    var lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var head = null;
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cells = splitLine(line, ',');
      if (!head) {
        head = cells.map(function (c) { return c.replace(/^["']|["']$/g, '').trim(); });
        continue;
      }
      var row = {};
      for (var c = 0; c < head.length; c++) {
        row[head[c]] = (cells[c] !== undefined) ? cells[c].replace(/^["']|["']$/g, '').trim() : '';
      }
      rows.push(row);
    }
    return rows;
  }

  /* -----------------------------------------------------------------------
   * Status & Cache In-Memory
   * --------------------------------------------------------------------- */
  var _state = {
    loaded: false,
    loadedAt: null,
    source: '',
    error: null,
    routes: {},        // route_id -> route master object
    routeList: [],     // array terurut
    assignments: [],   // array unit assignment rows
    assignmentsByRoute: {}, // route_id -> []
    assignmentsByUnit: {},  // unit -> []
    segments: [],      // array repair segments
    segmentsByRoute: {},    // route_id -> []
    summaryByRoute: {}      // route_id -> summary metrics
  };

  /* LocalStorage metadata (anotasi, status verifikasi, rencana perbaikan) */
  var _userMeta = {
    version: 1,
    routes: {},   // route_id -> { officialName, engineeringId, status, notes, updatedAt }
    segments: {}, // "route_id:lat:lon" -> { status, notes, updatedAt }
    plans: {}     // route_id -> { action, owner, targetDate, status, notes, baselineFuel, reevaluationDate, updatedAt }
  };

  function getStorage() {
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function loadUserMetaFromStorage() {
    var st = getStorage();
    if (!st) return;
    try {
      var raw = st.getItem(LS_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _userMeta.routes = parsed.routes || {};
        _userMeta.segments = parsed.segments || {};
        _userMeta.plans = parsed.plans || {};
      }
    } catch (e) {
      if (global.console && global.console.warn) {
        global.console.warn('[GPS_ROUTE_STORE] Gagal memuat metadata verifikasi:', e);
      }
    }
  }

  function saveUserMetaToStorage() {
    var st = getStorage();
    if (!st) return false;
    try {
      st.setItem(LS_KEY, JSON.stringify(_userMeta));
      return true;
    } catch (e) {
      if (global.console && global.console.warn) {
        global.console.warn('[GPS_ROUTE_STORE] Gagal menyimpan metadata verifikasi:', e);
      }
      return false;
    }
  }

  /* -----------------------------------------------------------------------
   * Parsers untuk Masing-Masing Berkas
   * --------------------------------------------------------------------- */

  function parseMasterCsv(csvText) {
    var rows = parseCsvRows(csvText);
    var map = {};
    rows.forEach(function (r) {
      var id = r.route_id || r.Route || r.route;
      if (!id) return;
      var unitsStr = r.units || '';
      var units = unitsStr ? unitsStr.split('|').map(function (u) { return u.trim(); }).filter(Boolean) : [];
      map[id] = {
        route_id: id,
        centroid_lat: num(r.centroid_lat),
        centroid_lon: num(r.centroid_lon),
        bbox_min_lat: num(r.bbox_min_lat),
        bbox_min_lon: num(r.bbox_min_lon),
        bbox_max_lat: num(r.bbox_max_lat),
        bbox_max_lon: num(r.bbox_max_lon),
        start_lat: num(r.start_lat),
        start_lon: num(r.start_lon),
        end_lat: num(r.end_lat),
        end_lon: num(r.end_lon),
        unit_count: intVal(r.unit_count) || units.length,
        units: units,
        eq_days: intVal(r.eq_days) || 0,
        repair_segment_count: intVal(r.repair_segment_count) || 0,
        inferred: r.inferred === 'true' || r.inferred === true,
        source: r.source || 'gps-derived'
      };
    });
    return map;
  }

  function parseSummaryCsv(csvText) {
    var rows = parseCsvRows(csvText);
    var map = {};
    rows.forEach(function (r) {
      var id = r.Route || r.route_id || r.route;
      if (!id) return;
      map[id] = {
        route: id,
        distanceKm: num(r['Distance Km'] || r.distanceKm || r.distance_km),
        avgGradePct: num(r['Avg Grade Pct'] || r.avgGradePct || r.avg_grade_pct),
        rollingResistancePct: num(r['Rolling Resistance Pct'] || r.rollingResistancePct || r.rolling_resistance_pct),
        surface: r.Surface || r.surface || '',
        eqDays: intVal(r.eqDays || r.eq_days),
        unitCount: intVal(r.unitCount || r.unit_count),
        gradeMaxPct: num(r.gradeMaxPct || r.grade_max_pct),
        climbPerKmM: num(r.climbPerKmM || r.climb_per_km_m),
        dateFirst: r.dateFirst || r.date_first || '',
        dateLast: r.dateLast || r.date_last || ''
      };
    });
    return map;
  }

  function parseUnitAssignmentCsv(csvText) {
    var rows = parseCsvRows(csvText);
    var list = [];
    rows.forEach(function (r) {
      var unit = String(r.unit || '').trim();
      var date = String(r.date || '').trim();
      var routeId = String(r.route_id || r.route || '').trim();
      if (!unit || !routeId) return;
      list.push({
        unit: unit,
        date: date,
        route_id: routeId,
        distance_km: num(r.distance_km || r.distanceKm),
        grade_pct: num(r.grade_pct || r.gradePct),
        climb_per_km_m: num(r.climb_per_km_m || r.climbPerKmM),
        track_points: intVal(r.track_points || r.points) || 0,
        assignment_status: r.assignment_status || 'inferred'
      });
    });
    return list;
  }

  function parseRepairSegmentsCsv(csvText) {
    var rows = parseCsvRows(csvText);
    var list = [];
    rows.forEach(function (r) {
      var routeId = String(r.route_id || r.route || '').trim();
      var lat = num(r.segment_lat != null ? r.segment_lat : r.lat);
      var lon = num(r.segment_lon != null ? r.segment_lon : r.lon);
      if (!routeId || lat === null || lon === null) return;
      var sev = intVal(r.severity) || 0;
      list.push({
        route_id: routeId,
        segment_lat: lat,
        segment_lon: lon,
        segments: intVal(r.segments || r.count) || 1,
        avg_grade_pct: num(r.avg_grade_pct || r.gradePct),
        avg_speed_kmh: num(r.avg_speed_kmh || r.speedKmh),
        unit_count: intVal(r.unit_count || r.unitCount) || 0,
        severity: sev,
        indication: r.indication || (sev >= 55 ? 'inspect-grade-or-road-condition' : 'monitor'),
        status: r.status || 'candidate'
      });
    });
    return list;
  }

  /* -----------------------------------------------------------------------
   * Ingest & Penggabungan Data
   * --------------------------------------------------------------------- */

  function ingestData(bundle, sourceInfo) {
    bundle = bundle || {};
    var masterMap = parseMasterCsv(bundle.masterCsv || '');
    var summaryMap = parseSummaryCsv(bundle.summaryCsv || '');
    var assignments = parseUnitAssignmentCsv(bundle.assignmentCsv || '');
    var segments = parseRepairSegmentsCsv(bundle.repairCsv || '');

    // Jika master kosong tapi summary ada rute, bangun master minimal dari summary
    Object.keys(summaryMap).forEach(function (id) {
      if (!masterMap[id]) {
        masterMap[id] = {
          route_id: id,
          centroid_lat: null, centroid_lon: null,
          bbox_min_lat: null, bbox_min_lon: null,
          bbox_max_lat: null, bbox_max_lon: null,
          start_lat: null, start_lon: null, end_lat: null, end_lon: null,
          unit_count: summaryMap[id].unitCount || 0,
          units: [],
          eq_days: summaryMap[id].eqDays || 0,
          repair_segment_count: 0,
          inferred: true,
          source: 'gps-derived'
        };
      }
    });

    // Gabungkan summary ke master
    Object.keys(masterMap).forEach(function (id) {
      var m = masterMap[id];
      var s = summaryMap[id] || {};
      m.distanceKm = s.distanceKm != null ? s.distanceKm : null;
      m.avgGradePct = s.avgGradePct != null ? s.avgGradePct : null;
      m.rollingResistancePct = s.rollingResistancePct != null ? s.rollingResistancePct : null;
      m.surface = s.surface || '';
      m.gradeMaxPct = s.gradeMaxPct != null ? s.gradeMaxPct : null;
      m.climbPerKmM = s.climbPerKmM != null ? s.climbPerKmM : null;
      m.dateFirst = s.dateFirst || '';
      m.dateLast = s.dateLast || '';
    });

    // Indeks assignments
    var byRoute = {};
    var byUnit = {};
    assignments.forEach(function (a) {
      (byRoute[a.route_id] || (byRoute[a.route_id] = [])).push(a);
      (byUnit[a.unit] || (byUnit[a.unit] = [])).push(a);
    });

    // Indeks segments
    var segByRoute = {};
    segments.forEach(function (seg) {
      (segByRoute[seg.route_id] || (segByRoute[seg.route_id] = [])).push(seg);
    });

    // Sinkronkan segment count pada master
    Object.keys(masterMap).forEach(function (id) {
      var segs = segByRoute[id] || [];
      if (segs.length > 0) {
        masterMap[id].repair_segment_count = segs.length;
      }
    });

    var routeList = Object.keys(masterMap).sort().map(function (k) { return masterMap[k]; });

    _state.loaded = routeList.length > 0;
    _state.loadedAt = Date.now();
    _state.source = sourceInfo || 'loaded';
    _state.error = null;
    _state.routes = masterMap;
    _state.routeList = routeList;
    _state.assignments = assignments;
    _state.assignmentsByRoute = byRoute;
    _state.assignmentsByUnit = byUnit;
    _state.segments = segments;
    _state.segmentsByRoute = segByRoute;
    _state.summaryByRoute = summaryMap;

    return {
      ok: true,
      routesCount: routeList.length,
      assignmentsCount: assignments.length,
      segmentsCount: segments.length
    };
  }

  /* -----------------------------------------------------------------------
   * Loader via Fetch HTTP
   * --------------------------------------------------------------------- */

  function loadData(basePath) {
    basePath = basePath || 'sample-data/data-gps/';
    if (!/\/$/.test(basePath)) basePath += '/';

    // Deteksi protokol file://
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      var msg = 'Protokol file:// tidak mengizinkan fetch berkas data GPS. Jalankan aplikasi melalui server lokal (misalnya node serve.js) lalu buka http://127.0.0.1:5500.';
      _state.loaded = false;
      _state.error = msg;
      return Promise.reject(new Error(msg));
    }

    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('Fetch API tidak tersedia di lingkungan ini.'));
    }

    var urls = {
      master: basePath + 'road-gps-inferred-master.csv',
      assignment: basePath + 'road-gps-inferred-unit-assignment.csv',
      repair: basePath + 'road-gps-inferred-repair-segments.csv',
      summary: basePath + 'road-gps-inferred.csv'
    };

    function fetchText(url) {
      return fetch(url + '?_t=' + Date.now()).then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' saat memuat ' + url);
        }
        return res.text();
      });
    }

    return Promise.all([
      fetchText(urls.master),
      fetchText(urls.assignment),
      fetchText(urls.repair),
      fetchText(urls.summary).catch(function () { return ''; })
    ]).then(function (texts) {
      var res = ingestData({
        masterCsv: texts[0],
        assignmentCsv: texts[1],
        repairCsv: texts[2],
        summaryCsv: texts[3]
      }, basePath);
      return res;
    }).catch(function (err) {
      _state.loaded = false;
      _state.error = err.message || 'Gagal memuat berkas GPS turunan.';
      throw err;
    });
  }

  /* -----------------------------------------------------------------------
   * Metadata & Verifikasi Pengguna (localStorage)
   * --------------------------------------------------------------------- */

  function getRouteMeta(routeId) {
    if (!routeId) return {};
    return _userMeta.routes[routeId] || {};
  }

  function setRouteMeta(routeId, patch) {
    if (!routeId || !patch || typeof patch !== 'object') return false;
    var cur = _userMeta.routes[routeId] || {};
    var updated = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    _userMeta.routes[routeId] = updated;
    saveUserMetaToStorage();
    return updated;
  }

  function segmentKey(routeId, lat, lon) {
    return String(routeId) + ':' + Number(lat).toFixed(4) + ':' + Number(lon).toFixed(4);
  }

  function getSegmentMeta(routeId, lat, lon) {
    var key = segmentKey(routeId, lat, lon);
    return _userMeta.segments[key] || {};
  }

  function setSegmentMeta(routeId, lat, lon, patch) {
    if (!routeId || lat == null || lon == null) return false;
    var key = segmentKey(routeId, lat, lon);
    var cur = _userMeta.segments[key] || {};
    var updated = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    _userMeta.segments[key] = updated;
    saveUserMetaToStorage();
    return updated;
  }

  function getRepairPlan(routeId) {
    if (!routeId) return null;
    return _userMeta.plans[routeId] || null;
  }

  function setRepairPlan(routeId, plan) {
    if (!routeId || !plan || typeof plan !== 'object') return false;
    var cur = _userMeta.plans[routeId] || {};
    var updated = Object.assign({}, cur, plan, { updatedAt: Date.now() });
    _userMeta.plans[routeId] = updated;
    saveUserMetaToStorage();
    return updated;
  }

  function clearUserMeta() {
    _userMeta = { version: 1, routes: {}, segments: {}, plans: {} };
    var st = getStorage();
    if (st) {
      try { st.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    }
  }

  function clearAll() {
    _state.loaded = false;
    _state.loadedAt = null;
    _state.source = '';
    _state.error = null;
    _state.routes = {};
    _state.routeList = [];
    _state.assignments = [];
    _state.assignmentsByRoute = {};
    _state.assignmentsByUnit = {};
    _state.segments = [];
    _state.segmentsByRoute = {};
    _state.summaryByRoute = {};
  }

  /* -----------------------------------------------------------------------
   * Query API
   * --------------------------------------------------------------------- */

  function isLoaded() {
    return !!_state.loaded;
  }

  function getError() {
    return _state.error;
  }

  function getRoutes() {
    return _state.routeList.slice();
  }

  function getRoute(routeId) {
    return _state.routes[routeId] || null;
  }

  function getAssignments(routeId) {
    if (!routeId) return _state.assignments.slice();
    return (_state.assignmentsByRoute[routeId] || []).slice();
  }

  function getAssignmentsForUnit(unit) {
    if (!unit) return [];
    return (_state.assignmentsByUnit[unit] || []).slice();
  }

  function getSegments(routeId) {
    if (!routeId) return _state.segments.slice();
    return (_state.segmentsByRoute[routeId] || []).slice();
  }

  function getAllSegments() {
    return _state.segments.slice();
  }

  function getAllAssignments() {
    return _state.assignments.slice();
  }

  function getStateSummary() {
    return {
      loaded: _state.loaded,
      loadedAt: _state.loadedAt,
      source: _state.source,
      routesCount: _state.routeList.length,
      assignmentsCount: _state.assignments.length,
      segmentsCount: _state.segments.length,
      error: _state.error
    };
  }

  // Muat metadata tersimpan saat init
  loadUserMetaFromStorage();

  var API = {
    loadData: loadData,
    ingestData: ingestData,
    parseMasterCsv: parseMasterCsv,
    parseSummaryCsv: parseSummaryCsv,
    parseUnitAssignmentCsv: parseUnitAssignmentCsv,
    parseRepairSegmentsCsv: parseRepairSegmentsCsv,
    isLoaded: isLoaded,
    getError: getError,
    getRoutes: getRoutes,
    getRoute: getRoute,
    getAssignments: getAssignments,
    getAssignmentsForUnit: getAssignmentsForUnit,
    getSegments: getSegments,
    getAllSegments: getAllSegments,
    getAllAssignments: getAllAssignments,
    getStateSummary: getStateSummary,
    getRouteMeta: getRouteMeta,
    setRouteMeta: setRouteMeta,
    getSegmentMeta: getSegmentMeta,
    setSegmentMeta: setSegmentMeta,
    getRepairPlan: getRepairPlan,
    setRepairPlan: setRepairPlan,
    clearUserMeta: clearUserMeta,
    clearAll: clearAll,
    segmentKey: segmentKey
  };

  global.GPS_ROUTE_STORE = API;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof window !== 'undefined' ? window : global);

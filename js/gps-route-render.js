/* =========================================================================
 * gps-route-render.js
 * -------------------------------------------------------------------------
 * [GPS ROUTE REPAIR INTELLIGENCE · 2026-11-02]
 * Renderer UI untuk Intel Rute GPS:
 *   - Header status & tindakan;
 *   - 4 Kartu KPI Ringkas (clickable filter);
 *   - Visual grid / scatter koordinat SVG internal (offline-ready, 0 API);
 *   - Tabel prioritas area (P1/P2/P3, severity, exposure, impact fuel);
 *   - Detail Route Drawer (5 bagian: identitas, segmen, unit, fuel, rencana);
 *   - Ekspor data CSV (detail rute & draft work order).
 * ========================================================================= */

(function (global) {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n, dec) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Number(n).toLocaleString('id-ID', {
      minimumFractionDigits: dec != null ? dec : 0,
      maximumFractionDigits: dec != null ? dec : 2
    });
  }

  /* -----------------------------------------------------------------------
   * 1. Header Tindakan & Filter
   * --------------------------------------------------------------------- */

  function renderHeaderActions(stateSummary, filterState) {
    filterState = filterState || {};
    var loaded = stateSummary && stateSummary.loaded;
    var countRoutes = (stateSummary && stateSummary.routesCount) || 0;
    var countUnits = (stateSummary && stateSummary.assignmentsCount) || 0;
    var countSegments = (stateSummary && stateSummary.segmentsCount) || 0;

    var statusHtml = loaded
      ? '<span class="gps-status-badge ok"><i class="fa-solid fa-circle-check"></i> ' +
        countRoutes + ' Rute GPS (' + countSegments + ' segmen kandidat, ' + countUnits + ' paparan unit)</span>'
      : '<span class="gps-status-badge warn"><i class="fa-solid fa-triangle-exclamation"></i> Belum ada data Rute GPS</span>';

    return [
      '<div class="panel gps-action-header" style="padding:14px 18px">',
      '  <div class="gps-header-top">',
      '    <div class="gps-title-area">',
      '      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">',
      '        <h3 class="panel-title" style="font-size:16px;margin:0">',
      '          <i class="fa-solid fa-map-location-dot" style="color:#22d3ee"></i> Intel Rute GPS — Prioritas Perbaikan Jalan',
      '        </h3>',
      '        <span class="badge badge-inferred" title="Seluruh rute diturunkan secara algoritmik dari data telemetri GPS">',
      '          <i class="fa-solid fa-tag"></i> Inferred — perlu verifikasi lapangan',
      '        </span>',
      '      </div>',
      '      <p class="panel-sub" style="margin:4px 0 0 0">',
      '        Mengidentifikasi area jalan kritis berdasarkan bukti spasial GPS, intensitas operasi armada, dan dampak efisiensi fuel.',
      '      </p>',
      '    </div>',
      '    <div class="gps-btn-group">',
      '      <button class="btn btn-ghost btn-sm" id="btn-gps-route-aggregate"',
      '              title="Jalankan tools/gps-aggregate.js untuk mengolah track mentah GPS">',
      '        <i class="fa-solid fa-satellite-dish"></i> Generate Agregat GPS',
      '      </button>',
      '      <button class="btn btn-ghost btn-sm" id="btn-gps-route-road"',
      '              title="Jalankan tools/road-derive.js untuk menghasilkan master rute dan segmen perbaikan">',
      '        <i class="fa-solid fa-road"></i> Generate Rute GPS',
      '      </button>',
      '      <button class="btn btn-ghost btn-sm" id="btn-gps-route-reload"',
      '              title="Muat ulang berkas CSV rute dan segmen dari server lokal">',
      '        <i class="fa-solid fa-rotate-right"></i> Muat Ulang Hasil',
      '      </button>',
      '    </div>',
      '  </div>',
      '  <div class="gps-header-bottom">',
      '    <div class="gps-status-info">' + statusHtml + '</div>',
      '    <div class="gps-filters-bar">',
      '      <div class="gps-filter-item">',
      '        <label for="gps-filter-start">Dari:</label>',
      '        <input type="date" id="gps-filter-start" class="gps-input-sm" value="' + esc(filterState.startDate || '') + '">',
      '      </div>',
      '      <div class="gps-filter-item">',
      '        <label for="gps-filter-end">Sampai:</label>',
      '        <input type="date" id="gps-filter-end" class="gps-input-sm" value="' + esc(filterState.endDate || '') + '">',
      '      </div>',
      '      <div class="gps-filter-item">',
      '        <label for="gps-filter-route">Rute:</label>',
      '        <select id="gps-filter-route" class="gps-input-sm">',
      '          <option value="">Semua Rute</option>',
                 (filterState.routeOptions || []).map(function (opt) {
                   var sel = opt === filterState.routeId ? ' selected' : '';
                   return '<option value="' + esc(opt) + '"' + sel + '>' + esc(opt) + '</option>';
                 }).join(''),
      '        </select>',
      '      </div>',
      '      <div class="gps-filter-item">',
      '        <label for="gps-filter-min-sev">Min Severity:</label>',
      '        <select id="gps-filter-min-sev" class="gps-input-sm">',
      '          <option value="0"' + (filterState.minSeverity === 0 ? ' selected' : '') + '>Semua (&ge;0)</option>',
      '          <option value="35"' + (filterState.minSeverity === 35 ? ' selected' : '') + '>&ge; 35 (Kandidat)</option>',
      '          <option value="55"' + (filterState.minSeverity === 55 ? ' selected' : '') + '>&ge; 55 (Tinggi)</option>',
      '          <option value="75"' + (filterState.minSeverity === 75 ? ' selected' : '') + '>&ge; 75 (Kritis)</option>',
      '        </select>',
      '      </div>',
      '      <div class="gps-filter-item" style="margin-left:auto">',
      '        <label class="gps-checkbox-label">',
      '          <input type="checkbox" id="gps-filter-unverified"' + (filterState.onlyUnverified ? ' checked' : '') + '>',
      '          <span>Hanya Belum Diverifikasi</span>',
      '        </label>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');
  }

  /* -----------------------------------------------------------------------
   * 2. KPI Ringkas (4 Kartu)
   * --------------------------------------------------------------------- */

  function renderKpiCards(kpi, activeFilterTier) {
    kpi = kpi || {};

    var c1Active = activeFilterTier === 'P1' ? ' kpi-card-active' : '';
    var c4Val = (kpi.hasFuelImpactData && kpi.medianDeltaLtkPct != null)
      ? (kpi.medianDeltaLtkPct >= 0 ? '+' : '') + fmtNum(kpi.medianDeltaLtkPct, 1) + '%'
      : '—';

    return [
      '<div class="gps-kpi-grid">',
      '  <!-- Kartu 1: Area Prioritas -->',
      '  <div class="panel gps-kpi-card' + c1Active + '" data-kpi-filter="P1" role="button" tabindex="0"',
      '       title="Klik untuk memfilter tabel hanya rute Prioritas P1">',
      '    <div class="gps-kpi-icon icon-p1"><i class="fa-solid fa-triangle-exclamation"></i></div>',
      '    <div class="gps-kpi-body">',
      '      <span class="gps-kpi-title">Area Prioritas Inspeksi (P1)</span>',
      '      <span class="gps-kpi-value text-red">' + fmtNum(kpi.priorityAreaCount) + '</span>',
      '      <span class="gps-kpi-sub">dari ' + fmtNum(kpi.totalRoutesCount) + ' rute teridentifikasi</span>',
      '    </div>',
      '  </div>',
      '  <!-- Kartu 2: Unit Terdampak -->',
      '  <div class="panel gps-kpi-card" data-kpi-filter="impacted" role="button" tabindex="0"',
      '       title="Jumlah unit unik yang beroperasi di area rute prioritas">',
      '    <div class="gps-kpi-icon icon-units"><i class="fa-solid fa-truck-monster"></i></div>',
      '    <div class="gps-kpi-body">',
      '      <span class="gps-kpi-title">Unit Terdampak</span>',
      '      <span class="gps-kpi-value text-orange">' + fmtNum(kpi.impactedUnitsCount) + '</span>',
      '      <span class="gps-kpi-sub">unit unik pada rute prioritas</span>',
      '    </div>',
      '  </div>',
      '  <!-- Kartu 3: Paparan Operasi -->',
      '  <div class="panel gps-kpi-card" data-kpi-filter="exposure" role="button" tabindex="0"',
      '       title="Total unit-hari dan jarak akumulatif pada rute prioritas">',
      '    <div class="gps-kpi-icon icon-exposure"><i class="fa-solid fa-route"></i></div>',
      '    <div class="gps-kpi-body">',
      '      <span class="gps-kpi-title">Paparan Operasi</span>',
      '      <span class="gps-kpi-value">' + fmtNum(kpi.operatingExposureDays) + ' <small>unit-hari</small></span>',
      '      <span class="gps-kpi-sub">' + fmtNum(kpi.operatingExposureKm, 1) + ' km total exposure</span>',
      '    </div>',
      '  </div>',
      '  <!-- Kartu 4: Impact Fuel Terukur -->',
      '  <div class="panel gps-kpi-card" data-kpi-filter="fuel" role="button" tabindex="0"',
      '       title="Perubahan median L/ton-km unit yang terpapar vs baseline">',
      '    <div class="gps-kpi-icon icon-fuel"><i class="fa-solid fa-gas-pump"></i></div>',
      '    <div class="gps-kpi-body">',
      '      <span class="gps-kpi-title">Impact Fuel Terukur</span>',
      '      <span class="gps-kpi-value text-cyan">' + c4Val + '</span>',
      '      <span class="gps-kpi-sub">' + esc(kpi.fuelCoverageText || 'Menunggu data Fuel') + '</span>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');
  }

  /* -----------------------------------------------------------------------
   * 3. Visual Grid / Scatter Koordinat SVG (§4.D)
   * --------------------------------------------------------------------- */

  function isCoordValid(lat, lon) {
    var la = Number(lat), lo = Number(lon);
    // Tolak anomali GPS / dropout satelit (lat ~ 0.0) dan di luar kepulauan Indonesia
    // Untuk site operasional Kalimantan Timur, koordinat valid berada di lat > 0.1 s/d 6 dan lon 95 s/d 141
    return isFinite(la) && isFinite(lo) && la > 0.1 && la < 6 && lo > 95 && lo < 141;
  }

  function renderCoordinateMapSvg(routes, allSegments, selectedRouteId) {
    routes = routes || [];
    allSegments = allSegments || [];

    if (!allSegments.length && !routes.length) {
      return [
        '<div class="panel gps-map-panel" style="padding:24px;text-align:center">',
        '  <p class="panel-sub"><i class="fa-solid fa-map"></i> Belum ada data koordinat segmen untuk divisualisasikan.</p>',
        '</div>'
      ].join('\n');
    }

    // Hitung Bounding Box Global hanya dari koordinat yang valid (outlier-free)
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

    routes.forEach(function (r) {
      var m = r.master || r;
      if (isCoordValid(m.bbox_min_lat, m.bbox_min_lon) && isCoordValid(m.bbox_max_lat, m.bbox_max_lon)) {
        minLat = Math.min(minLat, m.bbox_min_lat);
        maxLat = Math.max(maxLat, m.bbox_max_lat);
        minLon = Math.min(minLon, m.bbox_min_lon);
        maxLon = Math.max(maxLon, m.bbox_max_lon);
      }
    });

    allSegments.forEach(function (s) {
      if (isCoordValid(s.segment_lat, s.segment_lon)) {
        minLat = Math.min(minLat, s.segment_lat);
        maxLat = Math.max(maxLat, s.segment_lat);
        minLon = Math.min(minLon, s.segment_lon);
        maxLon = Math.max(maxLon, s.segment_lon);
      }
    });

    // Fallback bila koordinat tunggal atau invalid
    if (!isFinite(minLat) || !isFinite(maxLat) || minLat >= maxLat) {
      minLat = 0.45; maxLat = 0.55;
    }
    if (!isFinite(minLon) || !isFinite(maxLon) || minLon >= maxLon) {
      minLon = 116.12; maxLon = 116.22;
    }

    // Tambah margin 6% agar titik di tepi kanvas tidak terpotong
    var latPad = Math.max(0.003, (maxLat - minLat) * 0.06);
    var lonPad = Math.max(0.003, (maxLon - minLon) * 0.06);
    minLat -= latPad; maxLat += latPad;
    minLon -= lonPad; maxLon += lonPad;

    // Proyeksi Isomorfis 1:1 Geografis (mengoreksi faktor cosinus latitude)
    var midLat = (minLat + maxLat) / 2;
    var cosLat = Math.cos((midLat * Math.PI) / 180);
    var geoW = (maxLon - minLon) * cosLat;
    var geoH = (maxLat - minLat);
    if (geoW <= 0.0001) geoW = 0.01;
    if (geoH <= 0.0001) geoH = 0.01;

    var svgW = 900;
    var svgH = 480;
    var padX = 35;
    var padY = 28;
    var availW = svgW - (padX * 2);
    var availH = svgH - (padY * 2);

    // Skala seragam: 1 km vertikal = 1 km horizontal (tidak gepeng)
    var scale = Math.min(availW / geoW, availH / geoH);
    var plotW = geoW * scale;
    var plotH = geoH * scale;

    var originX = padX + (availW - plotW) / 2;
    var originY = padY + (availH - plotH) / 2;

    function projX(lon) {
      return originX + ((lon - minLon) * cosLat * scale);
    }

    function projY(lat) {
      // Sumbu Y SVG terbalik terhadap Latitude
      return originY + (plotH - ((lat - minLat) * scale));
    }

    // Buat SVG elements
    var svgParts = [];
    svgParts.push('<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" class="gps-svg-canvas" preserveAspectRatio="xMidYMid meet">');

    // 1. Defs & background
    svgParts.push('  <defs>');
    svgParts.push('    <pattern id="gpsGrid" width="40" height="40" patternUnits="userSpaceOnUse">');
    svgParts.push('      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.025)" stroke-width="1"/>');
    svgParts.push('    </pattern>');
    svgParts.push('  </defs>');
    svgParts.push('  <rect width="100%" height="100%" fill="#0b1120"/>');

    // Area peta aktif
    svgParts.push('  <rect x="' + (originX - 10).toFixed(1) + '" y="' + (originY - 8).toFixed(1) + '" width="' + (plotW + 20).toFixed(1) + '" height="' + (plotH + 16).toFixed(1) + '" fill="#070c18" stroke="rgba(56, 189, 248, 0.15)" stroke-width="1" rx="6"/>');
    svgParts.push('  <rect x="' + (originX - 10).toFixed(1) + '" y="' + (originY - 8).toFixed(1) + '" width="' + (plotW + 20).toFixed(1) + '" height="' + (plotH + 16).toFixed(1) + '" fill="url(#gpsGrid)" rx="6"/>');

    // 2. Garis grid geografis & label koordinat
    var gridStep = 0.02;
    if (geoH > 0.25) gridStep = 0.05;
    else if (geoH < 0.04) gridStep = 0.01;

    var firstLon = Math.ceil(minLon / gridStep) * gridStep;
    for (var gl = firstLon; gl <= maxLon; gl += gridStep) {
      var gx = projX(gl);
      if (gx >= originX - 2 && gx <= originX + plotW + 2) {
        svgParts.push('  <line x1="' + gx.toFixed(1) + '" y1="' + (originY - 5).toFixed(1) + '" x2="' + gx.toFixed(1) + '" y2="' + (originY + plotH + 5).toFixed(1) + '" stroke="rgba(148,163,184,0.12)" stroke-dasharray="2 3"/>');
        svgParts.push('  <text x="' + gx.toFixed(1) + '" y="' + (originY + plotH + 16).toFixed(1) + '" fill="#64748b" font-size="9" font-family="monospace" text-anchor="middle">' + gl.toFixed(2) + '&deg;E</text>');
      }
    }

    var firstLat = Math.ceil(minLat / gridStep) * gridStep;
    for (var gt = firstLat; gt <= maxLat; gt += gridStep) {
      var gy = projY(gt);
      if (gy >= originY - 2 && gy <= originY + plotH + 2) {
        svgParts.push('  <line x1="' + (originX - 6).toFixed(1) + '" y1="' + gy.toFixed(1) + '" x2="' + (originX + plotW + 6).toFixed(1) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(148,163,184,0.12)" stroke-dasharray="2 3"/>');
        svgParts.push('  <text x="' + (originX - 14).toFixed(1) + '" y="' + (gy + 3).toFixed(1) + '" fill="#64748b" font-size="9" font-family="monospace" text-anchor="end">' + gt.toFixed(2) + '&deg;N</text>');
      }
    }

    // 3. Bounding box per rute
    routes.forEach(function (r) {
      var m = r.master || r;
      if (!isCoordValid(m.bbox_min_lat, m.bbox_min_lon) || !isCoordValid(m.bbox_max_lat, m.bbox_max_lon)) return;
      var bx1 = projX(m.bbox_min_lon);
      var bx2 = projX(m.bbox_max_lon);
      var by1 = projY(m.bbox_max_lat); // lat max = Y min
      var by2 = projY(m.bbox_min_lat); // lat min = Y max
      var bw = Math.max(8, Math.abs(bx2 - bx1));
      var bh = Math.max(8, Math.abs(by2 - by1));
      var isSel = (r.route_id === selectedRouteId);
      var strokeColor = isSel ? '#22d3ee' : 'rgba(56, 189, 248, 0.28)';
      var fillColor = isSel ? 'rgba(34, 211, 238, 0.08)' : 'rgba(14, 165, 233, 0.02)';
      var strokeDash = isSel ? 'none' : '4 3';

      svgParts.push('  <rect x="' + bx1.toFixed(1) + '" y="' + by1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"');
      svgParts.push('        fill="' + fillColor + '" stroke="' + strokeColor + '" stroke-width="' + (isSel ? '2' : '1') + '"');
      svgParts.push('        stroke-dasharray="' + strokeDash + '" rx="4" class="gps-route-bbox" data-route-id="' + esc(r.route_id) + '">');
      svgParts.push('    <title>' + esc(r.route_id) + ' (BBox)</title>');
      svgParts.push('  </rect>');

      // Label rute di pojok bbox
      svgParts.push('  <text x="' + (bx1 + 6).toFixed(1) + '" y="' + (by1 + 14).toFixed(1) + '" fill="' + (isSel ? '#22d3ee' : '#64748b') + '"');
      svgParts.push('        font-size="11" font-weight="600" font-family="monospace">' + esc(r.route_id) + '</text>');
    });

    // 4. Titik Kandidat Segmen
    allSegments.forEach(function (s) {
      if (!isCoordValid(s.segment_lat, s.segment_lon)) return;
      var cx = projX(s.segment_lon);
      var cy = projY(s.segment_lat);

      // Warna severity (§4.D):
      // hijau < 35, kuning 35–54, oranye 55–74, merah >= 75
      var fill = '#10b981'; // hijau
      if (s.severity >= 75) fill = '#ef4444'; // merah
      else if (s.severity >= 55) fill = '#f97316'; // oranye
      else if (s.severity >= 35) fill = '#f59e0b'; // kuning

      // Ukuran berdasarkan unit_count atau segments
      var radius = 4;
      if (s.unit_count >= 15 || s.segments >= 200) radius = 8;
      else if (s.unit_count >= 8 || s.segments >= 50) radius = 6.5;
      else if (s.unit_count >= 4 || s.segments >= 15) radius = 5;

      var isThisRoute = !selectedRouteId || (s.route_id === selectedRouteId);
      var opacity = isThisRoute ? '0.88' : '0.22';
      var strokeColor = isThisRoute ? '#ffffff' : 'transparent';
      var strokeWidth = (selectedRouteId && s.route_id === selectedRouteId) ? '1.2' : '0.6';

      var tooltip = [
        s.route_id,
        'Koordinat: ' + s.segment_lat.toFixed(4) + ', ' + s.segment_lon.toFixed(4),
        'Severity: ' + s.severity + ' (' + (s.indication || 'Kandidat') + ')',
        'Grade: ' + (s.avg_grade_pct != null ? s.avg_grade_pct + '%' : '—'),
        'Kecepatan: ' + (s.avg_speed_kmh != null ? s.avg_speed_kmh + ' km/h' : '—'),
        'Unit Terdampak: ' + (s.unit_count || '—') + ' unit (' + (s.segments || '—') + ' segmen)'
      ].join(' \n');

      svgParts.push('  <circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + radius.toFixed(1) + '"');
      svgParts.push('          fill="' + fill + '" fill-opacity="' + opacity + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '"');
      svgParts.push('          class="gps-segment-point" data-route-id="' + esc(s.route_id) + '"');
      svgParts.push('          data-lat="' + s.segment_lat + '" data-lon="' + s.segment_lon + '">');
      svgParts.push('    <title>' + esc(tooltip) + '</title>');
      svgParts.push('  </circle>');
    });

    // 5. Arah Mata Angin Utara (Compass)
    svgParts.push('  <g transform="translate(' + (svgW - 36) + ', 32)" class="gps-map-compass">');
    svgParts.push('    <circle cx="0" cy="0" r="14" fill="rgba(15,23,42,0.8)" stroke="rgba(56,189,248,0.3)" stroke-width="1"/>');
    svgParts.push('    <polygon points="0,-10 3.5,1 0,-1 -3.5,1" fill="#ef4444"/>');
    svgParts.push('    <polygon points="0,10 3.5,-1 0,1 -3.5,-1" fill="#64748b"/>');
    svgParts.push('    <text x="0" y="-12" fill="#ef4444" font-size="8" font-weight="700" text-anchor="middle" font-family="system-ui">U</text>');
    svgParts.push('  </g>');

    // 6. Skala Jarak Metrik (Scale Bar)
    var pxPerM = scale / 111320;
    var candidates = [500, 1000, 2000, 3000, 5000];
    var targetM = 1000;
    for (var ci = 0; ci < candidates.length; ci++) {
      if (candidates[ci] * pxPerM >= 50 && candidates[ci] * pxPerM <= 150) {
        targetM = candidates[ci];
        break;
      }
    }
    var barPx = targetM * pxPerM;
    var barLabel = targetM >= 1000 ? (targetM / 1000) + ' km' : targetM + ' m';
    var sbX = 20, sbY = svgH - 20;

    svgParts.push('  <g transform="translate(' + sbX + ', ' + sbY + ')" class="gps-map-scale-bar">');
    svgParts.push('    <rect x="-6" y="-14" width="' + (barPx + 12).toFixed(1) + '" height="20" fill="rgba(15,23,42,0.85)" stroke="rgba(148,163,184,0.25)" stroke-width="0.8" rx="3"/>');
    svgParts.push('    <line x1="0" y1="0" x2="' + barPx.toFixed(1) + '" y2="0" stroke="#f8fafc" stroke-width="2"/>');
    svgParts.push('    <line x1="0" y1="-3" x2="0" y2="3" stroke="#f8fafc" stroke-width="2"/>');
    svgParts.push('    <line x1="' + barPx.toFixed(1) + '" y1="-3" x2="' + barPx.toFixed(1) + '" y2="3" stroke="#f8fafc" stroke-width="2"/>');
    svgParts.push('    <text x="' + (barPx / 2).toFixed(1) + '" y="-4" fill="#f8fafc" font-size="9" font-family="monospace" text-anchor="middle" font-weight="600">' + barLabel + '</text>');
    svgParts.push('  </g>');

    // 7. Info Skala 1:1 Geografis
    var infoBadge = 'Aspek Rasio 1:1 Geografis &middot; Area ' + ((maxLat - minLat) * 111.32).toFixed(1) + ' &times; ' + (geoW * 111.32).toFixed(1) + ' km';
    svgParts.push('  <g transform="translate(' + (svgW - 20) + ', ' + (svgH - 18) + ')" text-anchor="end">');
    svgParts.push('    <text fill="#64748b" font-size="9" font-family="system-ui, monospace">' + infoBadge + '</text>');
    svgParts.push('  </g>');

    svgParts.push('</svg>');

    var selectedNote = selectedRouteId ? ' <span class="chip" style="font-size:11px;background:rgba(34,211,238,0.15);color:#22d3ee;border:1px solid #22d3ee;padding:1px 6px">Fokus: ' + esc(selectedRouteId) + '</span>' : '';

    return [
      '<div class="panel gps-map-panel" style="padding:14px 18px">',
      '  <div class="table-toolbar" style="margin-bottom:10px">',
      '    <div>',
      '      <h4 class="panel-title" style="font-size:14px;margin:0">',
      '        <i class="fa-solid fa-compass" style="color:#38bdf8"></i> Visual Spasial Segmen Kandidat Inspeksi' + selectedNote,
      '      </h4>',
      '      <p class="panel-sub" style="margin:2px 0 0 0">',
      '        Plot sebaran koordinat aktual (proyeksi 1:1 geografis). Klik titik atau rute untuk membuka panel detail.',
      '      </p>',
      '    </div>',
      '    <div class="gps-map-legend">',
      '      <span class="legend-item"><span class="legend-dot" style="background:#ef4444"></span> &ge;75 Kritis</span>',
      '      <span class="legend-item"><span class="legend-dot" style="background:#f97316"></span> 55–74 Tinggi</span>',
      '      <span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span> 35–54 Sedang</span>',
      '      <span class="legend-item"><span class="legend-dot" style="background:#10b981"></span> &lt;35 Rendah</span>',
      '    </div>',
      '  </div>',
      '  <div class="gps-svg-container">' + svgParts.join('\n') + '</div>',
      '</div>'
    ].join('\n');
  }

  /* -----------------------------------------------------------------------
   * 4. Tabel Prioritas Area (§4.C)
   * --------------------------------------------------------------------- */

  function renderPriorityTable(analyzedRoutes, userMetaMap) {
    analyzedRoutes = analyzedRoutes || [];
    userMetaMap = userMetaMap || {};

    if (!analyzedRoutes.length) {
      return [
        '<div class="panel" style="padding:32px;text-align:center">',
        '  <p class="panel-sub"><i class="fa-solid fa-road-barrier"></i> Tidak ada rute yang cocok dengan filter yang dipilih.</p>',
        '</div>'
      ].join('\n');
    }

    var rowsHtml = analyzedRoutes.map(function (ar, idx) {
      var rId = ar.route_id;
      var meta = userMetaMap[rId] || {};
      var officialName = meta.officialName ? ' <span class="gps-official-name">(' + esc(meta.officialName) + ')</span>' : '';
      var status = meta.status || 'candidate';

      // Status badge
      var statusBadge = '';
      if (status === 'verified') statusBadge = '<span class="badge badge-verified">verified</span>';
      else if (status === 'planned') statusBadge = '<span class="badge badge-planned">planned</span>';
      else if (status === 'completed') statusBadge = '<span class="badge badge-completed">completed</span>';
      else if (status === 'rejected') statusBadge = '<span class="badge badge-rejected">rejected</span>';
      else statusBadge = '<span class="badge badge-candidate">candidate</span>';

      // Tier badge
      var tier = ar.priority.tier;
      var tierBadge = '<span class="badge badge-tier badge-tier-' + tier.toLowerCase() + '">' + esc(tier) + ' (' + fmtNum(ar.priority.score, 1) + ')</span>';

      // Lokasi centroid
      var m = ar.master;
      var cLat = m.centroid_lat != null ? m.centroid_lat.toFixed(4) : '—';
      var cLon = m.centroid_lon != null ? m.centroid_lon.toFixed(4) : '—';
      var coordStr = cLat + ', ' + cLon;

      // Severity & alasan
      var sevColor = ar.maxSeverity >= 75 ? 'text-red' : (ar.maxSeverity >= 55 ? 'text-orange' : 'text-amber');
      var sevHtml = '<strong class="' + sevColor + '">' + ar.maxSeverity + '</strong> ' +
        '<div class="text-xs text-muted">' + esc(ar.severityReason) + '</div>';

      // Unit terdampak
      var unitHtml = '<strong>' + fmtNum(ar.unitCount) + ' unit</strong>' +
        '<div class="text-xs text-muted">' + fmtNum(ar.eqDays) + ' unit-hari</div>';

      // Exposure
      var dFirst = m.dateFirst || '';
      var dLast = m.dateLast || '';
      var dateRangeStr = (dFirst && dLast) ? (dFirst + ' s/d ' + dLast) : '—';
      var expHtml = '<strong>' + (ar.exposureKm != null ? fmtNum(ar.exposureKm, 1) + ' km' : '—') + '</strong>' +
        '<div class="text-xs text-muted">' + esc(dateRangeStr) + '</div>';

      // Impact fuel
      var fi = ar.fuelImpact;
      var fuelHtml = '';
      if (fi.gatePassed && fi.deltaLtkPct != null) {
        var dSign = fi.deltaLtkPct >= 0 ? '+' : '';
        var dColor = fi.deltaLtkPct > 3 ? 'text-red' : (fi.deltaLtkPct < -2 ? 'text-emerald' : '');
        fuelHtml = '<strong class="' + dColor + '">' + dSign + fmtNum(fi.deltaLtkPct, 1) + '%</strong> (' + fmtNum(fi.routeMedianLtk, 2) + ' L/t-km)' +
          '<div class="text-xs text-muted">' + esc(fi.coverageText) + '</div>';
      } else {
        fuelHtml = '<span class="text-muted">' + (fi.unitsWithFuel > 0 ? 'Cakupan belum cukup' : 'Menunggu data Fuel') + '</span>' +
          '<div class="text-xs text-muted">' + esc(fi.coverageText) + '</div>';
      }

      return [
        '<tr data-route-id="' + esc(rId) + '">',
        '  <td class="center">' + tierBadge + '</td>',
        '  <td><strong>' + esc(rId) + '</strong>' + officialName + '</td>',
        '  <td>',
        '    <span>' + esc(coordStr) + '</span> ',
        '    <button class="btn btn-ghost btn-xs btn-copy-coord" data-coord="' + esc(coordStr) + '" title="Salin koordinat">',
        '      <i class="fa-regular fa-copy"></i>',
        '    </button>',
        '  </td>',
        '  <td><span class="gps-indication-text">' + esc(ar.indicationLabel) + '</span></td>',
        '  <td>' + sevHtml + '</td>',
        '  <td>' + unitHtml + '</td>',
        '  <td>' + expHtml + '</td>',
        '  <td>' + fuelHtml + '</td>',
        '  <td class="center">' + statusBadge + '</td>',
        '  <td class="center">',
        '    <button class="btn btn-ghost btn-sm btn-open-route-detail" data-route-id="' + esc(rId) + '">',
        '      <i class="fa-solid fa-arrow-up-right-from-square"></i> Detail',
        '    </button>',
        '  </td>',
        '</tr>'
      ].join('\n');
    }).join('\n');

    var totalRoutes = analyzedRoutes.length;

    return [
      '<div class="panel" style="padding:14px 18px">',
      '  <div class="table-toolbar" style="margin-bottom:10px">',
      '    <div>',
      '      <h4 class="panel-title" style="font-size:14px;margin:0">',
      '        <i class="fa-solid fa-list-check" style="color:#f59e0b"></i> Tabel Prioritas Area Inspeksi Jalan',
      '      </h4>',
      '      <p class="panel-sub" style="margin:2px 0 0 0">',
      '        Diurutkan berdasarkan skor prioritas terpadu P1 &gt; P2 &gt; P3, severity segmen, dan paparan operasi.',
      '        <span id="gps-priority-table-count" class="fuel-table-count">' + totalRoutes + ' rute</span>',
      '      </p>',
      '    </div>',
      '    <div class="fuel-filter-bar" style="margin-top:0">',
      '      <label class="fuel-filter">',
      '        <i class="fa-solid fa-magnifying-glass"></i>',
      '        <input type="search" id="gps-priority-search" placeholder="Cari Route ID / indikasi…" autocomplete="off">',
      '      </label>',
      '      <label class="fuel-filter">',
      '        <select id="gps-priority-filter-tier">',
      '          <option value="">Semua Tier</option>',
      '          <option value="P1">P1 Kritis</option>',
      '          <option value="P2">P2 Tinggi</option>',
      '          <option value="P3">P3 Sedang</option>',
      '        </select>',
      '      </label>',
      '    </div>',
      '  </div>',
      '  <div class="table-scroll">',
      '    <table class="data gps-priority-table" id="gps-priority-table">',
      '      <thead>',
      '        <tr>',
      '          <th class="center sortable" data-gps-sort="score" style="width:110px">Prioritas <span class="sort-ind">⇅</span></th>',
      '          <th class="sortable" data-gps-sort="routeId">Route ID <span class="sort-ind">⇅</span></th>',
      '          <th>Lokasi Centroid</th>',
      '          <th>Indikasi</th>',
      '          <th class="sortable" data-gps-sort="severity">Severity <span class="sort-ind">⇅</span></th>',
      '          <th class="sortable fuel-num" data-gps-sort="unitCount">Unit Terdampak <span class="sort-ind">⇅</span></th>',
      '          <th class="sortable fuel-num" data-gps-sort="exposureKm">Exposure (km) <span class="sort-ind">⇅</span></th>',
      '          <th class="sortable fuel-num" data-gps-sort="fuelDelta">Impact Fuel <span class="sort-ind">⇅</span></th>',
      '          <th class="center" style="width:100px">Status</th>',
      '          <th class="center" style="width:90px">Aksi</th>',
      '        </tr>',
      '      </thead>',
      '      <tbody id="gps-priority-tbody">' + rowsHtml + '</tbody>',
      '    </table>',
      '  </div>',
      '  <div id="gps-priority-pager" class="table-pager" style="margin-top:8px"></div>',
      '</div>'
    ].join('\n');
  }

  /* -----------------------------------------------------------------------
   * 5. Detail Route Drawer (§5)
   * --------------------------------------------------------------------- */

  function renderRouteDetailDrawer(analyzedRoute, userMeta, repairPlan) {
    if (!analyzedRoute) return '';
    var r = analyzedRoute;
    var m = r.master || {};
    var meta = userMeta || {};
    var plan = repairPlan || {};

    var officialName = meta.officialName || '';
    var engineeringId = meta.engineeringId || '';
    var routeStatus = meta.status || 'candidate';
    var routeNotes = meta.notes || '';

    // Centroid, Bbox, Start, End
    var centroid = (m.centroid_lat != null && m.centroid_lon != null)
      ? m.centroid_lat.toFixed(6) + ', ' + m.centroid_lon.toFixed(6) : '—';
    var bbox = (m.bbox_min_lat != null)
      ? '[' + m.bbox_min_lat.toFixed(4) + ', ' + m.bbox_min_lon.toFixed(4) + '] s/d [' +
        m.bbox_max_lat.toFixed(4) + ', ' + m.bbox_max_lon.toFixed(4) + ']' : '—';
    var startCoord = (m.start_lat != null) ? m.start_lat.toFixed(6) + ', ' + m.start_lon.toFixed(6) : '—';
    var endCoord = (m.end_lat != null) ? m.end_lat.toFixed(6) + ', ' + m.end_lon.toFixed(6) : '—';

    // Sub-komponen B: Segmen Kandidat Perbaikan
    var segmentsHtml = (r.segments || []).map(function (s) {
      var sKey = s.route_id + ':' + s.segment_lat.toFixed(4) + ':' + s.segment_lon.toFixed(4);
      var sevClass = s.severity >= 75 ? 'text-red' : (s.severity >= 55 ? 'text-orange' : 'text-amber');
      return [
        '<tr>',
        '  <td><code>' + s.segment_lat.toFixed(4) + ', ' + s.segment_lon.toFixed(4) + '</code></td>',
        '  <td><strong class="' + sevClass + '">' + s.severity + '</strong></td>',
        '  <td>' + (s.avg_grade_pct != null ? fmtNum(s.avg_grade_pct, 2) + '%' : '—') + '</td>',
        '  <td>' + (s.avg_speed_kmh != null ? fmtNum(s.avg_speed_kmh, 1) + ' km/h' : '—') + '</td>',
        '  <td>' + fmtNum(s.unit_count) + ' unit (' + fmtNum(s.segments) + ' titik)</td>',
        '  <td><span class="text-xs">' + esc(s.indication || 'Kandidat') + '</span></td>',
        '  <td><span class="badge badge-candidate">' + esc(s.status || 'candidate') + '</span></td>',
        '</tr>'
      ].join('\n');
    }).join('\n');

    if (!segmentsHtml) {
      segmentsHtml = '<tr><td colspan="7" class="center text-muted">Tidak ada segmen kritis tercatat pada rute ini.</td></tr>';
    }

    // Sub-komponen C: Unit yang Beroperasi
    var unitRowsHtml = (r.fuelImpact.unitTable || []).map(function (u) {
      var fuelStatusBadge = u.hasFuelData
        ? '<span class="badge badge-verified" title="' + u.fuelDays + ' hari data">' + fmtNum(u.medianLtk, 3) + ' L/t-km</span>'
        : '<span class="badge badge-candidate">Belum ada</span>';

      var deltaStr = u.deltaPct != null ? (u.deltaPct >= 0 ? '+' : '') + fmtNum(u.deltaPct, 1) + '%' : '—';
      var deltaColor = u.deltaPct != null ? (u.deltaPct > 3 ? 'text-red' : (u.deltaPct < -2 ? 'text-emerald' : '')) : '';

      return [
        '<tr class="gps-unit-row" data-unit="' + esc(u.unit) + '">',
        '  <td><a href="javascript:void(0)" class="gps-unit-link" data-unit="' + esc(u.unit) + '"><strong>' + esc(u.unit) + '</strong></a></td>',
        '  <td class="center">' + fmtNum(u.activeDays) + '</td>',
        '  <td>' + fmtNum(u.exposureKm, 1) + ' km</td>',
        '  <td>' + fmtNum(u.medianGradePct, 2) + '%</td>',
        '  <td>' + fmtNum(u.climbPerKmM, 1) + ' m/km</td>',
        '  <td>' + fuelStatusBadge + '</td>',
        '  <td class="' + deltaColor + '"><strong>' + deltaStr + '</strong></td>',
        '</tr>'
      ].join('\n');
    }).join('\n');

    if (!unitRowsHtml) {
      unitRowsHtml = '<tr><td colspan="7" class="center text-muted">Belum ada data unit ter-assign.</td></tr>';
    }

    // Sub-komponen D: Dampak Fuel Evidence Cards
    var fi = r.fuelImpact;
    var gateBadge = fi.gatePassed
      ? '<span class="badge badge-verified"><i class="fa-solid fa-circle-check"></i> Gerbang Bukti Lolos</span>'
      : '<span class="badge badge-caution"><i class="fa-solid fa-shield-halved"></i> Gerbang Bukti Belum Terpenuhi</span>';

    return [
      '<div class="gps-drawer-backdrop" id="gps-drawer-backdrop"></div>',
      '<div class="gps-drawer" id="gps-route-drawer" role="dialog" aria-modal="true">',
      '  <div class="gps-drawer-header">',
      '    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">',
      '      <h3 style="margin:0;font-size:18px"><i class="fa-solid fa-route" style="color:#22d3ee"></i> Detail Rute ' + esc(r.route_id) + '</h3>',
      '      <span class="badge badge-inferred">inferred</span>',
      '      <span class="badge badge-tier badge-tier-' + r.priority.tier.toLowerCase() + '">' + esc(r.priority.tier) + ' (Skor ' + fmtNum(r.priority.score, 1) + ')</span>',
      '    </div>',
      '    <button class="btn btn-ghost btn-sm" id="btn-close-gps-drawer" aria-label="Tutup detail rute"><i class="fa-solid fa-xmark"></i> Tutup</button>',
      '  </div>',
      '  <div class="gps-drawer-content">',
      '    <!-- BAGIAN A: Identitas & Status -->',
      '    <div class="panel gps-drawer-section">',
      '      <h4 class="gps-section-title"><i class="fa-solid fa-id-card"></i> A. Identitas &amp; Status Lapangan</h4>',
      '      <div class="gps-form-grid">',
      '        <div>',
      '          <label class="gps-label">Nama Rute Resmi (Engineering / Operasi):</label>',
      '          <input type="text" id="gps-drawer-official-name" class="gps-input" placeholder="Misal: Haul Road Pit A ke Crusher 1" value="' + esc(officialName) + '">',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">ID Engineering:</label>',
      '          <input type="text" id="gps-drawer-eng-id" class="gps-input" placeholder="Misal: HR-01-NORTH" value="' + esc(engineeringId) + '">',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Status Verifikasi:</label>',
      '          <select id="gps-drawer-status" class="gps-input">',
      '            <option value="candidate"' + (routeStatus === 'candidate' ? ' selected' : '') + '>candidate (hasil inferensi GPS)</option>',
      '            <option value="verified"' + (routeStatus === 'verified' ? ' selected' : '') + '>verified (dikonfirmasi lapangan)</option>',
      '            <option value="planned"' + (routeStatus === 'planned' ? ' selected' : '') + '>planned (masuk jadwal perbaikan)</option>',
      '            <option value="completed"' + (routeStatus === 'completed' ? ' selected' : '') + '>completed (selesai diperbaiki)</option>',
      '            <option value="rejected"' + (routeStatus === 'rejected' ? ' selected' : '') + '>rejected (bukan isu jalan)</option>',
      '          </select>',
      '        </div>',
      '      </div>',
      '      <div style="margin-top:12px">',
      '        <label class="gps-label">Catatan Operator / Verifikasi:</label>',
      '        <textarea id="gps-drawer-notes" class="gps-input" rows="2" placeholder="Catatan hasil survei drone/inspeksi visual...">' + esc(routeNotes) + '</textarea>',
      '      </div>',
      '      <div class="gps-meta-grid" style="margin-top:14px">',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Centroid:</span> <code>' + esc(centroid) + '</code></div>',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Bounding Box:</span> <code>' + esc(bbox) + '</code></div>',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Titik Awal:</span> <code>' + esc(startCoord) + '</code></div>',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Titik Akhir:</span> <code>' + esc(endCoord) + '</code></div>',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Unit Beroperasi:</span> ' + fmtNum(r.unitCount) + ' unit (' + fmtNum(r.eqDays) + ' unit-hari)</div>',
      '        <div class="gps-meta-item"><span class="gps-meta-label">Panjang Est:</span> ' + (r.exposureKm != null ? fmtNum(r.exposureKm, 1) + ' km' : '—') + '</div>',
      '      </div>',
      '      <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">',
      '        <button class="btn btn-ghost btn-sm" id="btn-save-route-meta" data-route-id="' + esc(r.route_id) + '">',
      '          <i class="fa-solid fa-floppy-disk"></i> Simpan Identitas &amp; Status',
      '        </button>',
      '        <button class="btn btn-ghost btn-sm" id="btn-export-route-csv" data-route-id="' + esc(r.route_id) + '">',
      '          <i class="fa-solid fa-file-csv"></i> Ekspor CSV Rute Detail',
      '        </button>',
      '      </div>',
      '    </div>',
      '    <!-- BAGIAN B: Segmen Kandidat Perbaikan -->',
      '    <div class="panel gps-drawer-section">',
      '      <h4 class="gps-section-title"><i class="fa-solid fa-triangle-exclamation"></i> B. Segmen Kandidat Perbaikan (' + (r.segments ? r.segments.length : 0) + ' segmen)</h4>',
      '      <p class="panel-sub" style="margin:0 0 10px 0">Segmen dengan severity &ge; 35 yang membutuhkan perhatian Engineering / Road Maintenance.</p>',
      '      <div class="table-scroll" style="max-height:260px">',
      '        <table class="data">',
      '          <thead>',
      '            <tr>',
      '              <th>Koordinat Segmen</th>',
      '              <th>Severity</th>',
      '              <th>Avg Grade</th>',
      '              <th>Avg Speed</th>',
      '              <th>Paparan Operasi</th>',
      '              <th>Indikasi Masalah</th>',
      '              <th>Status</th>',
      '            </tr>',
      '          </thead>',
      '          <tbody>' + segmentsHtml + '</tbody>',
      '        </table>',
      '      </div>',
      '    </div>',
      '    <!-- BAGIAN C: Unit yang Beroperasi -->',
      '    <div class="panel gps-drawer-section">',
      '      <h4 class="gps-section-title"><i class="fa-solid fa-truck"></i> C. Unit yang Beroperasi pada Rute Ini</h4>',
      '      <p class="panel-sub" style="margin:0 0 10px 0">Klik nama unit untuk melompat ke analisis Fuel Trending unit tersebut.</p>',
      '      <div class="table-scroll" style="max-height:240px">',
      '        <table class="data">',
      '          <thead>',
      '            <tr>',
      '              <th>Nomor Lambung</th>',
      '              <th class="center">Hari Aktif</th>',
      '              <th>Exposure</th>',
      '              <th>Grade Median</th>',
      '              <th>Climb/Km</th>',
      '              <th>Data Fuel</th>',
      '              <th>&Delta; vs Baseline</th>',
      '            </tr>',
      '          </thead>',
      '          <tbody>' + unitRowsHtml + '</tbody>',
      '        </table>',
      '      </div>',
      '    </div>',
      '    <!-- BAGIAN D: Dampak Fuel -->',
      '    <div class="panel gps-drawer-section">',
      '      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">',
      '        <h4 class="gps-section-title" style="margin:0"><i class="fa-solid fa-gas-pump"></i> D. Pembuktian Dampak Fuel (L/ton-km)</h4>',
      '        ' + gateBadge,
      '      </div>',
      '      <div class="gps-evidence-grid">',
      '        <div class="gps-evidence-card">',
      '          <span class="evidence-title">1. Paparan (Exposure)</span>',
      '          <span class="evidence-val">' + fmtNum(fi.unitsTotal) + ' unit</span>',
      '          <span class="evidence-sub">' + fmtNum(r.eqDays) + ' unit-hari ter-assign</span>',
      '        </div>',
      '        <div class="gps-evidence-card">',
      '          <span class="evidence-title">2. Tingkat Fuel Rute</span>',
      '          <span class="evidence-val text-cyan">' + (fi.routeMedianLtk != null ? fmtNum(fi.routeMedianLtk, 3) + ' L/t-km' : '—') + '</span>',
      '          <span class="evidence-sub">Median pada hari aktif rute</span>',
      '        </div>',
      '        <div class="gps-evidence-card">',
      '          <span class="evidence-title">3. Perbandingan Baseline</span>',
      '          <span class="evidence-val ' + (fi.deltaLtkPct > 3 ? 'text-red' : (fi.deltaLtkPct < -2 ? 'text-emerald' : '')) + '">',
      '            ' + (fi.deltaLtkPct != null ? (fi.deltaLtkPct >= 0 ? '+' : '') + fmtNum(fi.deltaLtkPct, 1) + '%' : '—'),
      '          </span>',
      '          <span class="evidence-sub">' + (fi.baselineMedianLtk != null ? 'Baseline: ' + fmtNum(fi.baselineMedianLtk, 3) + ' L/t-km' : 'Menunggu data') + '</span>',
      '        </div>',
      '      </div>',
      '      <div class="gps-narrative-box" style="margin-top:12px">',
      '        <i class="fa-solid fa-circle-info"></i> ' + esc(fi.narrative),
      '      </div>',
      '    </div>',
      '    <!-- BAGIAN E: Rencana Perbaikan (Work Order Draft) -->',
      '    <div class="panel gps-drawer-section">',
      '      <h4 class="gps-section-title"><i class="fa-solid fa-clipboard-list"></i> E. Rencana Perbaikan &amp; Evaluasi Lapangan</h4>',
      '      <div class="gps-form-grid">',
      '        <div>',
      '          <label class="gps-label">Tindakan Direkomendasikan:</label>',
      '          <select id="gps-plan-action" class="gps-input">',
      '            <option value="inspeksi-grade"' + (plan.action === 'inspeksi-grade' ? ' selected' : '') + '>Inspeksi Grade Tanjakan &amp; Keselarasan Geometri</option>',
      '            <option value="grading-permukaan"' + (plan.action === 'grading-permukaan' ? ' selected' : '') + '>Perataan Permukaan / Motor Grader &amp; Compactor</option>',
      '            <option value="drainase-lumpur"' + (plan.action === 'drainase-lumpur' ? ' selected' : '') + '>Perbaikan Drainase, Parit &amp; Pembuangan Lumpur</option>',
      '            <option value="evaluasi-rr"' + (plan.action === 'evaluasi-rr' ? ' selected' : '') + '>Evaluasi Rolling Resistance &amp; Material Agregat</option>',
      '            <option value="verifikasi-gps"' + (plan.action === 'verifikasi-gps' ? ' selected' : '') + '>Verifikasi Titik Koordinat GPS di Lapangan</option>',
      '          </select>',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Owner / PIC:</label>',
      '          <input type="text" id="gps-plan-owner" class="gps-input" placeholder="Misal: Pit Supervisor / Road Maintenance" value="' + esc(plan.owner || '') + '">',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Target Tanggal Pelaksanaan:</label>',
      '          <input type="date" id="gps-plan-target-date" class="gps-input" value="' + esc(plan.targetDate || '') + '">',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Status Rencana:</label>',
      '          <select id="gps-plan-status" class="gps-input">',
      '            <option value="planned"' + (plan.status === 'planned' ? ' selected' : '') + '>Planned (Terencana)</option>',
      '            <option value="in-progress"' + (plan.status === 'in-progress' ? ' selected' : '') + '>In-Progress (Sedang Dikerjakan)</option>',
      '            <option value="completed"' + (plan.status === 'completed' ? ' selected' : '') + '>Completed (Selesai)</option>',
      '            <option value="rejected"' + (plan.status === 'rejected' ? ' selected' : '') + '>Rejected (Dibatalkan)</option>',
      '          </select>',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Baseline L/t-km Sebelum Perbaikan:</label>',
      '          <input type="number" step="0.001" id="gps-plan-baseline" class="gps-input" placeholder="Misal: 2.15" value="' + (plan.baselineFuel != null ? plan.baselineFuel : (fi.routeMedianLtk || '')) + '">',
      '        </div>',
      '        <div>',
      '          <label class="gps-label">Tanggal Re-evaluasi Fuel:</label>',
      '          <input type="date" id="gps-plan-reeval-date" class="gps-input" value="' + esc(plan.reevaluationDate || '') + '">',
      '        </div>',
      '      </div>',
      '      <div style="margin-top:12px">',
      '        <label class="gps-label">Catatan Tindakan &amp; Spesifikasi:</label>',
      '        <textarea id="gps-plan-notes" class="gps-input" rows="2" placeholder="Detail alat yang dikerahkan, material penimbun, atau instruksi kerja khusus...">' + esc(plan.notes || '') + '</textarea>',
      '      </div>',
      '      <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">',
      '        <button class="btn btn-ghost btn-sm" id="btn-save-repair-plan" data-route-id="' + esc(r.route_id) + '">',
      '          <i class="fa-solid fa-floppy-disk"></i> Simpan Rencana Perbaikan',
      '        </button>',
      '        <button class="btn btn-ghost btn-sm" id="btn-export-work-order" data-route-id="' + esc(r.route_id) + '">',
      '          <i class="fa-solid fa-file-lines"></i> Ekspor Draft Work Order (CSV)',
      '        </button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');
  }

  /* -----------------------------------------------------------------------
   * 6. Ekspor Berkas CSV
   * --------------------------------------------------------------------- */

  function exportRouteDetailCsv(analyzedRoute) {
    if (!analyzedRoute) return '';
    var r = analyzedRoute;
    var lines = [];
    lines.push('Route ID,Official Name,Centroid Lat,Centroid Lon,Unit Count,Eq Days,Max Severity,Priority Tier,Priority Score');
    lines.push([
      r.route_id,
      r.master.officialName || '',
      r.master.centroid_lat != null ? r.master.centroid_lat : '',
      r.master.centroid_lon != null ? r.master.centroid_lon : '',
      r.unitCount,
      r.eqDays,
      r.maxSeverity,
      r.priority.tier,
      r.priority.score
    ].join(','));
    lines.push('');
    lines.push('Segment Lat,Segment Lon,Severity,Avg Grade Pct,Avg Speed Kmh,Unit Count,Segments Count,Indication,Status');
    (r.segments || []).forEach(function (s) {
      lines.push([
        s.segment_lat,
        s.segment_lon,
        s.severity,
        s.avg_grade_pct != null ? s.avg_grade_pct : '',
        s.avg_speed_kmh != null ? s.avg_speed_kmh : '',
        s.unit_count != null ? s.unit_count : '',
        s.segments != null ? s.segments : '',
        '"' + (s.indication || '').replace(/"/g, '""') + '"',
        s.status || 'candidate'
      ].join(','));
    });
    return lines.join('\n');
  }

  function exportWorkOrderCsv(analyzedRoute, repairPlan) {
    if (!analyzedRoute) return '';
    var r = analyzedRoute;
    var plan = repairPlan || {};
    var lines = [];
    lines.push('WORK ORDER DRAFT — REPARASI JALAN HAUL');
    lines.push('Tanggal Dokumen,' + new Date().toISOString().slice(0, 10));
    lines.push('Route ID,' + r.route_id);
    lines.push('Prioritas,' + r.priority.tier + ' (Skor ' + r.priority.score + ')');
    lines.push('Tindakan Direkomendasikan,' + (plan.action || 'inspeksi-grade'));
    lines.push('Owner / PIC,' + '"' + (plan.owner || '').replace(/"/g, '""') + '"');
    lines.push('Target Tanggal,' + (plan.targetDate || ''));
    lines.push('Status Rencana,' + (plan.status || 'planned'));
    lines.push('Baseline L/t-km Sebelum,' + (plan.baselineFuel || ''));
    lines.push('Tanggal Re-evaluasi,' + (plan.reevaluationDate || ''));
    lines.push('Catatan Kerja,' + '"' + (plan.notes || '').replace(/"/g, '""') + '"');
    return lines.join('\n');
  }

  var API = {
    renderHeaderActions: renderHeaderActions,
    renderKpiCards: renderKpiCards,
    renderCoordinateMapSvg: renderCoordinateMapSvg,
    renderPriorityTable: renderPriorityTable,
    renderRouteDetailDrawer: renderRouteDetailDrawer,
    exportRouteDetailCsv: exportRouteDetailCsv,
    exportWorkOrderCsv: exportWorkOrderCsv
  };

  global.GPS_ROUTE_RENDER = API;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof window !== 'undefined' ? window : global);

/* =========================================================================
 * vhms-cross-render.js
 * -------------------------------------------------------------------------
 * [CROSS ANALYSIS] Render halaman korelasi VHMS x SOS:
 *   - KPI ringkas + Peta unit terhubung (fleet)
 *   - Detail: Heatmap korelasi, Timeline gabungan, Scatter, Radar, Tabel
 * Memakai Chart.js (global.Chart) — sudah dimuat di index.html.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cross = global.VHMS_CROSS;
  var vcfg = global.VHMS_CONFIG;
  var scfg = global.SOS_CONFIG;

  var charts = {};           // Chart.js instances (agar bisa di-destroy)
  var state = {
    search: '',
    filter: 'ALL',
    sortKey: 'priority',
    sortDir: 'desc',
    currentUnitId: null,
    currentResult: null,
    matched: null,          // kompartemen SOS yang match (untuk radar)
    timelinePair: 0,
    timelineSosParams: null,   // array key param SOS yang ditampilkan di timeline
    scatterPair: 0,
    timeBase: 'auto'        // [FITUR] 'auto' = auto-fallback (HM<->Tanggal); bisa 'hm'/'date'
  };

  /* ------------------------------ util ---------------------------------- */
  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML;
  }
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  function settings(id, html) { var e = document.getElementById(id); if (e) e.innerHTML = html; }
  function vis(id, show) { var e = document.getElementById(id); if (e) e.classList.toggle('hidden', !show); }
  function num(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function tierBadge(tier) {
    var labels = ['NORMAL', 'MONITOR', 'CRITICAL', 'EXTREME'];
    var colors = ['#22c55e', '#eab308', '#ef4444', '#991b1b'];
    var t = tier || 0;
    return '<span class="badge" style="background:' + colors[t] + '22;color:' + colors[t] + ';border:1px solid ' + colors[t] + '55">' + labels[t] + '</span>';
  }
  function healthBadge(label) {
    var l = label || 'NORMAL';
    var cls = l === 'CRITICAL' ? 'CRITICAL' : (l === 'WARNING' ? 'WARNING' : 'NORMAL');
    return '<span class="badge ' + cls + '">' + esc(l) + '</span>';
  }
  /** Warna korelasi: merah (-1) .. abu (0) .. hijau (+1). */
  function corrColor(r) {
    if (r === null || r === undefined) return 'rgba(100,116,139,0.15)';
    var a = Math.min(Math.abs(r), 1);
    if (r >= 0) return 'rgba(34,197,94,' + (0.15 + a * 0.7).toFixed(2) + ')';
    return 'rgba(239,68,68,' + (0.15 + a * 0.7).toFixed(2) + ')';
  }
  function strengthLabel(r) {
    if (r === null) return '—';
    var a = Math.abs(r);
    if (a >= 0.85) return 'Sangat Kuat';
    if (a >= 0.7) return 'Kuat';
    if (a >= 0.5) return 'Moderat';
    if (a >= 0.3) return 'Lemah';
    return 'Sangat Lemah';
  }
  function confBadge(c) {
    var col = c === 'Tinggi' ? '#22c55e' : (c === 'Sedang' ? '#eab308' : '#f87171');
    return '<span class="chip" style="border-color:' + col + '55;color:' + col + '">' + esc(c) + '</span>';
  }
  /** Chip sumber perhitungan korelasi (basis normalisasi). */
  function basisChip(basis) {
    if (basis === 'threshold') return '<span class="chip" title="Dihitung dari nilai ternormalisasi threshold">threshold</span>';
    if (basis === 'minmax') return '<span class="chip" title="Dihitung dari skala min-max deret (threshold tidak tersedia)">min-max</span>';
    if (basis === 'raw') return '<span class="chip" title="Dihitung dari nilai mentah">raw</span>';
    return '';
  }

  /* --------------------------- Fleet map -------------------------------- */
  function renderFleet() {
    var data = cross.buildFleet({ timeBase: state.timeBase || 'auto' });
    var tbody = document.getElementById('cross-fleet-body');
    if (!tbody) return;

    setText('cross-summary-chip', data.linked + ' dari ' + data.total + ' unit VHMS terhubung SOS');
    setText('cross-fleet-count', 'Menampilkan unit dengan / tanpa data SOS — total ' + data.total + ' unit VHMS, ' + data.sosUnitCount + ' kompartemen SOS');

    // KPI
    var kpi = document.getElementById('cross-kpi');
    if (kpi) {
      var urgent = data.rows.filter(function (r) { return r.linked && (r.minLevel || 3) === 1; }).length;
      var strong = data.rows.filter(function (r) { return r.linked && r.maxR >= 0.7; }).length;
      var conf = data.rows.filter(function (r) { return r.linked && r.best && r.best.confidence === 'Tinggi'; }).length;
      kpi.innerHTML =
        kpiCard('fa-link', 'Unit Terhubung', data.linked + ' / ' + data.total, 'cyan', 'punya data SOS') +
        kpiCard('fa-triangle-exclamation', 'Prioritas P1 (Urgent)', urgent, 'red', 'Extreme / Critical') +
        kpiCard('fa-diagram-project', 'Korelasi Kuat (|r|≥0.7)', strong, 'amber', 'pasangan selaras') +
        kpiCard('fa-shield-halved', 'Kepercayaan Tinggi', conf, 'emerald', '≥6 titik sampel');
    }

    // Filter & search
    var rows = data.rows.slice();
    if (state.filter === 'LINKED') rows = rows.filter(function (r) { return r.linked; });
    else if (state.filter === 'UNLINKED') rows = rows.filter(function (r) { return !r.linked; });
    var q = (state.search || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return ((r.serial || '') + ' ' + (r.lambung || '') + ' ' + (r.model || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    var k = state.sortKey, dir = state.sortDir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      if (k === 'priority') {
        // Urutkan menurut URGENSI (status keparahan) dulu, lalu skor.
        var la = (a.linked ? (a.minLevel || 3) : 9), lb = (b.linked ? (b.minLevel || 3) : 9);
        var hasA = a.linked ? 0 : 1, hasB = b.linked ? 0 : 1;
        if (hasA !== hasB) return hasA - hasB;
        if (la !== lb) return la - lb;
        return (b.priority - a.priority);
      }
      if (k === 'maxR') return (b.maxR - a.maxR);
      if (k === 'vhmsLabel') { var o = { CRITICAL: 3, WARNING: 2, NORMAL: 1 }; return (o[b.healthLabel] || 0) - (o[a.healthLabel] || 0); }
      var va = a[k] || '', vb = b[k] || '';
      return String(va).localeCompare(String(vb)) * dir;
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:#64748b">Belum ada unit VHMS. Muat file telemetri terlebih dahulu.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      var unitLabel = r.lambung ? ('<span style="color:#34d399;font-weight:600">' + esc(r.lambung) + '</span>') : ('<span style="color:#94a3b8">' + esc(r.serial || '—') + '</span>');
      var best = r.best;
      var hip = (r.linked && best)
        ? '<span style="font-size:11px;color:#cbd5e1">' + esc(best.pairs[0].hypothesis) + '</span>'
        : (r.matchedSos
          ? '<span style="color:#fbbf24;font-size:11px"><i class="fa-solid fa-circle-exclamation"></i> SOS ada tapi tidak ada titik HM valid</span>'
          : '<span style="color:#64748b;font-size:11px">— belum ada data SOS pembanding —</span>');
      var sosTier = (r.linked && best) ? tierBadge(best.sosTier) : '<span style="color:#475569;font-size:11px">—</span>';
      var korel = (r.linked && best)
        ? '<span style="font-weight:700;color:' + (best.maxR >= 0.7 ? '#22c55e' : (best.maxR >= 0.4 ? '#eab308' : '#94a3b8')) + '">' + num(best.maxR, 2) + '</span>'
        : '—';
      var prio = (r.linked && best)
        ? sevBadge(r.minLevel, best.priority, best.sosTier)
        : '<span class="sev-badge sev-NORMAL">—</span>';
      var action = r.linked
        ? '<button class="btn btn-primary btn-sm cross-open" data-unit-id="' + esc(r.vhmsId) + '">Analisa</button>'
        : (r.matchedSos
          ? '<span style="color:#fbbf24;font-size:11px" title="Data SOS cocok tetapi tanpa meter (HM) valid">tidak dapat dianalisa</span>'
          : '<span style="color:#475569;font-size:11px">SOS belum ada</span>');
      return '<tr class="row-' + (r.healthLabel || 'NORMAL') + '">' +
        '<td class="center">' + prio + '</td>' +
        '<td class="mono">' + unitLabel + '</td>' +
        '<td>' + esc(r.model || '—') + '</td>' +
        '<td class="center">' + healthBadge(r.healthLabel) + '</td>' +
        '<td class="center">' + sosTier + '</td>' +
        '<td class="center mono">' + korel + '</td>' +
        '<td>' + hip + '</td>' +
        '<td class="center">' + action + '</td>' +
        '</tr>';
    }).join('');
  }

  /**
   * Badge prioritas Cross Analysis.
   * Level ditentukan STATUS KEPARAHAN (bukan skor): minLevel 1=P1, 2=P2, 3=P3.
   * Bila skor tinggi menaikkan level, badge bisa lebih tinggi (tidak menurun).
   */
  function sevBadge(minLevel, priority, sosTier) {
    var level = minLevel || 3;
    // Skor tinggi boleh menaikkan urutan (prioritas), tapi tidak menurunkannya.
    if (priority >= 70) level = Math.min(level, 1);
    else if (priority >= 45) level = Math.min(level, 2);
    var cls = level === 1 ? 'CRITICAL' : (level === 2 ? 'WARNING' : 'NORMAL');
    var txt = 'P' + level;
    var tierName = ['NORMAL', 'MONITOR', 'CRITICAL', 'EXTREME'][sosTier || 0];
    return '<span class="sev-badge sev-' + cls + '" title="Prioritas ' + txt +
      ' — status SOS ' + tierName + ', skor ' + num(priority, 1) + '">' + txt + '</span>';
  }
  function kpiCard(icon, label, value, accent, sub) {
    return '<div class="kpi-card accent-' + accent + '"><div class="glow"></div>' +
      '<p class="kpi-title">' + esc(label) + '</p>' +
      '<div class="kpi-value"><span class="num">' + value + '</span></div>' +
      '<p class="kpi-note">' + (sub ? esc(sub) : '<i class="fa-solid ' + icon + '"></i>') + '</p></div>';
  }

  /* --------------------------- Detail ----------------------------------- */
  function openDetail(vhmsId) {
    var store = global.VHMS_FLEET;
    var analysis = store ? store.getAnalysis(vhmsId) : null;
    if (!analysis) return;
    var summary = null;
    store.rows().forEach(function (r) { if (r.id === vhmsId) summary = r; });
    var row = { vhmsId: vhmsId, serial: analysis.meta.serial, model: analysis.meta.model, lambung: summary ? summary.lambung : null, healthLabel: analysis.health.label };

    // Cari kompartemen SOS yang match
    var sosIndex = cross.buildSosIndex();
    var matched = cross.matchSos({ serial: row.serial, lambung: row.lambung }, sosIndex);
    if (!matched.length) {
      alert('Tidak ada data SOS untuk unit ' + (row.lambung || row.serial) + '.');
      return;
    }

    // Pilih kompartemen dengan prioritas tertinggi — HANYA yang punya
    // pasangan parameter valid (>=1). [ACUAN] Selalu memakai HM/SMR.
    var best = null;
    var candidates = [];
    matched.forEach(function (u) {
      var res = cross.analyzePair(analysis, u, { timeBase: state.timeBase || 'auto' });
      if (res.pairs && res.pairs.length) candidates.push(res);
    });
    if (!candidates.length) {
      alert('Data SOS untuk unit ' + (row.lambung || row.serial) +
        ' tidak bisa dipasangkan dengan VHMS.\n\n' +
        'Tidak ada titik sampel SOS yang tumpang-tindih dengan rentang VHMS, ' +
        'baik pada acuan HM maupun Tanggal.\n\n' +
        'Periksa kembali rentang data (SMR/HM & tanggal) kedua sumber, ' +
        'atau coba ubah "Mode Pencocokan" pada panel Timeline Gabungan.');
      return;
    }
    candidates.forEach(function (res) { if (!best || res.priority > best.priority) best = res; });

    state.currentUnitId = vhmsId;
    state.currentResult = best;
    state.matched = matched;            // untuk radar (pilih kompartemen)
    state.timelineSosParams = null;     // reset pilihan SOS → dihitung ulang per unit

    vis('cross-fleet-panel', false);
    vis('cross-detail-panel', true);
    renderDetailHeader(row, best);
    renderHeatmap(best);
    renderPairsTable(best);
    initPairSelectors(best);
    renderTimeline(best);
    renderScatter(best);
    renderRadar(analysis, matched, 0);

    // Dropdown kompartemen pada radar.
    var radarSel = document.getElementById('cross-radar-unit');
    if (radarSel) radarSel.addEventListener('change', function () {
      renderRadar(analysis, state.matched, parseInt(radarSel.value, 10) || 0);
    });

    var backDetail = document.getElementById('cross-detail-back');
    if (backDetail) backDetail.addEventListener('click', backToFleet);
  }

  function backToFleet() {
    // Kembali dari DETAIL ke peta unit (masih di dalam Cross Analysis).
    vis('cross-fleet-panel', true);
    vis('cross-detail-panel', false);
    destroyCharts();
    renderFleet();
  }

  /** Keluar sepenuhnya dari Cross Analysis -> kembali ke home mode aktif. */
  function exitCross() {
    destroyCharts();
    state.currentUnitId = null;
    state.currentResult = null;
    vis('cross-fleet-panel', true);
    vis('cross-detail-panel', false);
    if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.goHome) {
      global.VHMS_SOS_MODE.goHome();
    } else if (global.VHMS_APP && global.VHMS_APP.showFleetView) {
      global.VHMS_APP.showFleetView();
    }
  }

  function renderDetailHeader(row, res) {
    var el = document.getElementById('cross-detail-header');
    if (!el) return;
    var unitLabel = row.lambung ? row.lambung : row.serial;
    var best = res.pairs && res.pairs.length ? res.pairs[0] : null;
    var prioLevel = res.minLevel || 3;
    var prioCls = prioLevel === 1 ? 'CRITICAL' : (prioLevel === 2 ? 'WARNING' : 'NORMAL');

    function stat(icon, label, value, color) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(30,41,59,.45);border:1px solid rgba(51,65,85,.6);border-radius:10px;min-width:130px">' +
        '<i class="fa-solid ' + icon + '" style="color:' + (color || '#94a3b8') + ';font-size:15px"></i>' +
        '<div><p style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#64748b">' + esc(label) + '</p>' +
        '<p style="font-size:14px;font-weight:700;color:#e2e8f0">' + value + '</p></div></div>';
    }

    el.innerHTML =
      // Baris 1: identitas + tombol kembali
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<span class="sev-badge sev-' + prioCls + '" title="Level prioritas" style="font-size:13px;padding:5px 10px">P' + prioLevel + '</span>' +
          '<h2 style="font-size:17px;font-weight:700"><i class="fa-solid fa-boxes-stacked" style="color:#22d3ee;margin-right:6px"></i>' + esc(unitLabel) + '</h2>' +
          '<span class="chip">' + esc(row.model || '') + '</span>' +
          '<span class="chip" style="border-color:#a78bfa55;color:#a78bfa"><i class="fa-solid fa-microchip"></i> ' + esc(res.component || '') + '</span>' +
          healthBadge(row.healthLabel) + tierBadge(res.sosTier) +
        '</div>' +
        '<button class="btn btn-ghost btn-sm" id="cross-detail-back"><i class="fa-solid fa-arrow-left"></i> Kembali ke Daftar</button>' +
      '</div>' +
      // Baris 2: stat cards (rapi & sejajar)
      '<div style="display:flex;align-items:stretch;gap:12px;flex-wrap:wrap;margin-top:12px">' +
        stat('fa-location-crosshairs', 'Titik Korelasi', res.nPoints, '#22d3ee') +
        stat('fa-gauge-high', 'Acuan', 'HM/SMR', '#22d3ee') +
        stat('fa-arrows-left-right', 'Korelasi Terkuat', '|r| ' + num(res.maxR, 2), res.maxR >= 0.7 ? '#22c55e' : (res.maxR >= 0.4 ? '#eab308' : '#94a3b8')) +
        stat('fa-signal', 'Kepercayaan', res.confidence, res.confidence === 'Tinggi' ? '#22c55e' : (res.confidence === 'Sedang' ? '#eab308' : '#f87171')) +
      '</div>' +
      // Baris 3: hipotesis dominan
      (best
        ? '<div style="margin-top:12px;padding:10px 14px;background:rgba(34,211,238,.08);border-left:3px solid #22d3ee;border-radius:8px">' +
            '<p style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#67e8f9"><i class="fa-solid fa-lightbulb"></i> Hipotesis Dominan</p>' +
            '<p style="font-size:12.5px;color:#e2e8f0;margin-top:3px">' + esc(best.hypothesis) + '</p>' +
            '<p style="font-size:10.5px;color:#94a3b8;margin-top:3px">' + esc(best.vhmsLabel) + ' ↔ ' + esc(best.sosLabel) + ' · r = ' + num(best.r, 2) + ' · ' + esc(best.basis || '—') + '</p>' +
          '</div>'
        : '') +
      (res.overlap && res.overlap.warning
        ? '<p style="margin-top:10px;font-size:11px;color:#fbbf24"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(res.overlap.warning) + '</p>'
        : '');
  }

  /* -------- Heatmap korelasi VHMS x SOS -------- */
  function renderHeatmap(res) {
    var head = document.getElementById('cross-heatmap-head');
    var body = document.getElementById('cross-heatmap-body');
    if (!head || !body) return;

    // Kumpulkan SOS param unik (kolom) & VHMS param unik (baris)
    var sosCols = [], vhmsRows = [];
    var cellMap = {};
    res.pairs.forEach(function (p) {
      if (sosCols.indexOf(p.sos) === -1) sosCols.push(p.sos);
      if (vhmsRows.indexOf(p.vhms) === -1) vhmsRows.push(p.vhms);
      cellMap[p.vhms + '|' + p.sos] = p;
    });

    head.innerHTML = '<tr><th class="heat-label">VHMS ↓ / SOS →</th>' +
      sosCols.map(function (s) {
        var lbl = (scfg.PARAMS[s] || {}).label || s;
        return '<th class="center">' + esc(lbl) + '</th>';
      }).join('') + '</tr>';

    // [REVISI #15] Kelompokkan baris VHMS menurut arah degradasi HIGH/LOW
    // (mode threshold). HIGH = makin besar makin bahaya; LOW = makin kecil.
    var dirOf = (vcfg.paramDirection) ? vcfg.paramDirection : function () { return 'HIGH'; };
    var highRows = vhmsRows.filter(function (k) { return dirOf(k) === 'HIGH'; });
    var lowRows = vhmsRows.filter(function (k) { return dirOf(k) === 'LOW'; });
    var rowGroups = [];
    if (highRows.length) rowGroups.push({ dir: 'HIGH', keys: highRows, label: 'Grup HIGH — makin besar makin bahaya', color: '#f87171', icon: 'arrow-trend-up' });
    if (lowRows.length) rowGroups.push({ dir: 'LOW', keys: lowRows, label: 'Grup LOW — makin kecil makin bahaya', color: '#38bdf8', icon: 'arrow-trend-down' });

    var rowsHtml = '';
    rowGroups.forEach(function (grp) {
      rowsHtml += '<tr class="cross-dir-row"><td class="heat-label" colspan="' + (sosCols.length + 1) + '" ' +
        'style="background:rgba(2,6,23,.85);color:' + grp.color + ';font-weight:700;font-size:10.5px;' +
        'letter-spacing:.5px;text-transform:uppercase;padding:7px 10px;border-top:1px solid #334155">' +
        '<i class="fa-solid fa-' + grp.icon + '"></i> ' + esc(grp.label) + '</td></tr>';
      rowsHtml += grp.keys.map(function (vk) {
        var vLbl = (vcfg.PARAMS[vk] || {}).label || vk;
        var vUnit = (vcfg.PARAMS[vk] || {}).unit || '';
        var dirColor = grp.color;
        var cells = sosCols.map(function (sk) {
          var p = cellMap[vk + '|' + sk];
          if (!p) return '<td class="center" style="color:#334155">·</td>';
          var r = p.r;
          if (r === null) {
            return '<td class="center cross-cell" style="background:rgba(100,116,139,0.10)" ' +
              'data-cross-pair="' + esc(vk) + '|' + esc(sk) + '" ' +
              'title="' + esc(p.vhmsLabel + ' vs ' + p.sosLabel + ' — ' + (p.note || 'tidak dapat dihitung')) + '">' +
              '<span style="color:#64748b;font-size:10px">n/a</span></td>';
          }
          return '<td class="center cross-cell" style="background:' + corrColor(r) + '" ' +
            'data-cross-pair="' + esc(vk) + '|' + esc(sk) + '" ' +
            'title="' + esc(p.vhmsLabel + ' vs ' + p.sosLabel + ' — r=' + num(r, 2) + ', n=' + p.n) + '">' +
            '<strong style="color:#f8fafc">' + num(r, 2) + '</strong></td>';
        }).join('');
        // Tag arah (HIGH/LOW) kecil di samping label baris.
        var dirTag = '<span style="font-size:9px;font-weight:700;color:' + dirColor + ';border:1px solid ' + dirColor +
          '55;border-radius:4px;padding:0 4px;margin-left:6px">' + grp.dir + '</span>';
        return '<tr><td class="heat-label" style="font-size:11px">' + esc(vLbl) +
          (vUnit ? ' <span style="color:#64748b">(' + esc(vUnit) + ')</span>' : '') + dirTag + '</td>' + cells + '</tr>';
      }).join('');
    });
    body.innerHTML = rowsHtml;

    var legend = document.getElementById('cross-heatmap-legend');
    if (legend) {
      legend.innerHTML = '<div style="display:flex;align-items:center;gap:10px;font-size:10.5px;color:#94a3b8;flex-wrap:wrap">' +
        '<span>Korelasi:</span>' +
        '<span style="display:inline-block;width:16px;height:12px;background:' + corrColor(-1) + '"></span> -1 (berlawanan)' +
        '<span style="display:inline-block;width:16px;height:12px;background:' + corrColor(0) + '"></span> 0' +
        '<span style="display:inline-block;width:16px;height:12px;background:' + corrColor(1) + '"></span> +1 (selaras)' +
        '<span style="margin-left:10px">· = tidak ada pasangan terkurasi</span></div>';
    }

    // Klik sel → buka POPUP scatter pasangan tsb (chart + narasi + tombol kembali).
    body.querySelectorAll('[data-cross-pair]').forEach(function (td) {
      td.addEventListener('click', function () {
        var pairKey = td.getAttribute('data-cross-pair');
        var parts = pairKey.split('|');
        var idx = res.pairs.findIndex(function (p) { return p.vhms === parts[0] && p.sos === parts[1]; });
        if (idx < 0) return;
        // Tandai sel terpilih.
        body.querySelectorAll('[data-cross-pair]').forEach(function (c) { c.classList.remove('is-selected'); });
        td.classList.add('is-selected');
        openScatterModal(res, idx);
      });
    });
  }

  /* -------- Popup scatter (klik sel heatmap) -------- */
  function openScatterModal(res, pairIdx) {
    var overlay = document.getElementById('cross-scatter-modal');
    var canvas = document.getElementById('cross-modal-scatter-chart');
    if (!overlay || !canvas) return;
    var p = res.pairs[pairIdx];
    if (!p) return;

    // Judul & subjudul.
    setText('cross-modal-title-text', p.vhmsLabel + ' ↔ ' + p.sosLabel);
    setText('cross-modal-sub', 'Korelasi VHMS × SOS · ' + (res.component || '') +
      ' · sumbu acuan ' + (res.timeBase === 'date' ? 'Tanggal' : 'HM/SMR'));

    // Statistik ringkas di atas chart.
    var r = p.r;
    var atOrigin = 0;
    for (var k = 0; k < p.x.length; k++) { if (p.x[k] === 0 && p.y[k] === 0) atOrigin++; }
    var statsEl = document.getElementById('cross-modal-stats');
    if (statsEl) {
      statsEl.innerHTML =
        modalStat('Pearson r', r === null ? 'n/a' : num(r, 2), r !== null && Math.abs(r) >= 0.5 ? '#22c55e' : '#94a3b8') +
        modalStat('Titik (n)', p.n, '#22d3ee') +
        modalStat('Basis', p.basis || '—', '#a78bfa') +
        modalStat('Kekuatan', strengthLabel(r), '#f59e0b') +
        modalStat('Tumpang-tindih', res.overlap && res.overlap.any ? 'Ada' : 'Tidak', (res.overlap && res.overlap.any) ? '#22c55e' : '#ef4444');
    }

    // Scatter (sama seperti panel, tapi dirender di canvas modal).
    var pts = [];
    for (var i = 0; i < p.x.length; i++) {
      if (p.x[i] !== null && p.y[i] !== null) pts.push({ x: p.x[i], y: p.y[i] });
    }
    var trend = null;
    if (pts.length >= 2) {
      var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      pts.forEach(function (o) { sx += o.x; sy += o.y; sxx += o.x * o.x; sxy += o.x * o.y; });
      var den = n * sxx - sx * sx;
      if (Math.abs(den) > 1e-9) {
        var slope = (n * sxy - sx * sy) / den;
        var intercept = (sy - slope * sx) / n;
        trend = [{ x: 0, y: intercept }, { x: 1, y: slope + intercept }];
      }
    }
    var tColor = r === null ? '#64748b' : (r > 0 ? '#22c55e' : '#ef4444');
    var datasets = [{
      label: p.vhmsLabel + ' vs ' + p.sosLabel,
      data: pts,
      backgroundColor: 'rgba(245,158,11,0.85)', borderColor: '#fbbf24',
      pointRadius: 6, pointHoverRadius: 10
    }];
    if (trend) {
      datasets.push({
        type: 'line', label: 'Tren (r=' + num(r, 2) + ')',
        data: trend, borderColor: tColor, borderWidth: 2, borderDash: [6, 4],
        pointRadius: 0, fill: false, tension: 0
      });
    }
    destroyChart('modalScatter');
    charts.modalScatter = new global.Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { right: 6 } },
        plugins: {
          legend: { position: 'bottom', align: 'center', labels: { color: '#cbd5e1', font: { size: 11 }, usePointStyle: true } },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': (' + num(ctx.parsed.x, 2) + ', ' + num(ctx.parsed.y, 2) + ')'; } } }
        },
        scales: {
          x: { title: { display: true, text: p.vhmsLabel + ' (normal 0–1)', color: '#22d3ee', font: { size: 12 } }, min: 0, max: 1, ticks: { color: '#94a3b8' } },
          y: { title: { display: true, text: p.sosLabel + ' (normal 0–1)', color: '#f59e0b', font: { size: 12 } }, min: 0, max: 1, ticks: { color: '#94a3b8' } }
        }
      }
    });
    setTimeout(function () { if (charts.modalScatter) { try { charts.modalScatter.resize(); } catch (e) {} } }, 60);

    // Narasi penjelasan.
    var narr = document.getElementById('cross-modal-narrative');
    if (narr) narr.innerHTML = buildNarrative(p, res, atOrigin);

    // Tabel nilai mentah.
    var dt = document.getElementById('cross-modal-datatable');
    if (dt) {
      if (!res.points.length) { dt.innerHTML = ''; }
      else {
        // [REVISI #3] Data terbaru di paling atas (konsisten dgn tabel utama).
        var rows = res.points.map(function (pt, ii) { return { pt: pt, ii: ii }; }).reverse().map(function (row) {
          var pt = row.pt, ii = row.ii;
          var vv = p.xRaw ? p.xRaw[ii] : null;
          var sv = p.yRaw ? p.yRaw[ii] : null;
          var axisTxt = (res.timeBase === 'date')
            ? (pt.date || new Date(pt.axis).toLocaleDateString('id-ID'))
            : num(pt.axis, 0);
          return '<tr><td class="mono" style="font-size:10.5px">' + esc(pt.date || '—') + '</td>' +
            '<td class="center mono">' + axisTxt + '</td>' +
            '<td class="center mono">' + num(vv, 2) + '</td>' +
            '<td class="center mono">' + num(sv, 2) + '</td></tr>';
        }).join('');
        dt.innerHTML = '<table class="data"><thead><tr>' +
          '<th>Tanggal SOS</th><th class="center">HM/SMR</th>' +
          '<th class="center">' + esc(p.vhmsLabel) + '</th><th class="center">' + esc(p.sosLabel) + '</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }

    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeScatterModal() {
    var overlay = document.getElementById('cross-scatter-modal');
    if (overlay) overlay.classList.add('hidden');
    document.body.classList.remove('modal-open');
    destroyChart('modalScatter');
    // Lepas penanda sel terpilih agar tidak membingungkan saat modal ditutup.
    document.querySelectorAll('#cross-heatmap-body .is-selected').forEach(function (c) { c.classList.remove('is-selected'); });
  }

  function modalStat(k, v, color) {
    return '<div class="cross-modal-stat">' +
      '<span class="cms-k">' + esc(k) + '</span>' +
      '<span class="cms-v" style="color:' + (color || '#e2e8f0') + '">' + esc(String(v)) + '</span></div>';
  }

  /** Narasi penjelasan korelasi agar user awam dapat memahami. */
  function buildNarrative(p, res, atOrigin) {
    var r = p.r;
    var cls, title, body;
    if (r === null) {
      cls = 'weak'; title = 'Korelasi tidak dapat dihitung';
      body = p.note || 'Jumlah titik data belum cukup untuk menghitung korelasi yang layak (minimal 4 titik).';
    } else {
      var a = Math.abs(r), dir = r > 0 ? 'searah' : 'berlawanan';
      if (a >= 0.7) { cls = r > 0 ? 'strong-pos' : 'strong-neg'; title = 'Korelasi KUAT (' + dir + ')'; }
      else if (a >= 0.5) { cls = r > 0 ? 'mod-pos' : 'mod-neg'; title = 'Korelasi MODERAT (' + dir + ')'; }
      else { cls = 'weak'; title = 'Korelasi LEMAH'; }
      if (r > 0) {
        body = 'Ketika <strong>' + esc(p.vhmsLabel) + '</strong> naik, <strong>' + esc(p.sosLabel) +
          '</strong> cenderung <strong>ikut naik</strong>. Pola searah ini mengindikasikan kedua gejala berasal dari sumber/root-cause yang sama.';
      } else {
        body = 'Ketika <strong>' + esc(p.vhmsLabel) + '</strong> naik, <strong>' + esc(p.sosLabel) +
          '</strong> cenderung <strong>turun</strong> (atau sebaliknya). Pola berlawanan sering muncul mis. tekanan vs keausan, atau aditif yang terkuras seiring beban kerja.';
      }
    }

    var strengthPct = r === null ? '—' : (Math.abs(r) * 100).toFixed(0) + '%';
    var conf = res.confidence || '—';

    var html = '<div class="cross-narrative">' +
      '<h4><i class="fa-solid fa-book-open-reader"></i> Penjelasan</h4>' +
      '<p><strong>' + esc(p.vhmsLabel) + '</strong> (telemetri VHMS) diuji terhadap <strong>' +
        esc(p.sosLabel) + '</strong> (data konfirmasi SOS) pada <strong>' + p.n + ' titik</strong> sampel dengan acuan <strong>' +
        (res.timeBase === 'date' ? 'Tanggal' : 'HM/SMR') + '</strong>.</p>' +
      '<div class="narr-verdict ' + cls + '"><i class="fa-solid fa-chart-line"></i> ' + title +
        (r === null ? '' : ' — r = ' + num(r, 2) + ' (' + strengthPct + ' kekuatan)') + '</div>' +
      '<p>' + body + '</p>' +
      '<ul>' +
        '<li><strong>Kekuatan korelasi:</strong> ' + strengthLabel(r) + ' (|r| ' + (r === null ? '—' : num(Math.abs(r), 2)) + '). Skala 0–1; makin dekat 1 makin kuat.</li>' +
        '<li><strong>Kepercayaan data:</strong> ' + conf + ' — ' + p.n + ' titik sampel' +
          ((res.overlap && res.overlap.any) ? ' dengan rentang HM tumpang-tindih.' : ', rentang HM belum tumpang-tindih.') + '</li>' +
        '<li><strong>Arah hubungan:</strong> ' + (r === null ? '—' : (r > 0 ? 'positif (satu naik, satu naik).' : 'negatif (satu naik, satu turun).')) + '</li>' +
        (atOrigin ? '<li><strong>' + atOrigin + ' titik di sudut (0,0):</strong> kedua parameter masih di bawah ambang normal pada titik tersebut — tidak menunjukkan penyimpangan.</li>' : '') +
        (p.hypothesis ? '<li><strong>Hipotesis root-cause:</strong> ' + esc(p.hypothesis) + '</li>' : '') +
      '</ul>' +
      '<p style="margin-top:10px;font-size:11px;color:#94a3b8"><i class="fa-solid fa-circle-info"></i> ' +
        'Catatan: korelasi menunjukkan <em>hubungan</em>, bukan sebab-akibat. Gunakan sebagai indikasi awal bersama data mekanikal & riwayat unit.</p>' +
      '</div>';
    return html;
  }

  /* -------- Tabel pairs -------- */
  function renderPairsTable(res) {
    var body = document.getElementById('cross-pairs-body');
    if (!body) return;
    if (!res.pairs.length) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#64748b">Tidak ada pasangan parameter dengan data cukup untuk dihitung.</td></tr>';
      return;
    }
    body.innerHTML = res.pairs.map(function (p) {
      var r = p.r;
      var color = r === null ? '#94a3b8' : (Math.abs(r) >= 0.7 ? (r > 0 ? '#22c55e' : '#ef4444') : '#eab308');
      // [REVISI #15] Tag arah degradasi parameter VHMS (HIGH/LOW).
      var dir = (vcfg.paramDirection) ? vcfg.paramDirection(p.vhms) : 'HIGH';
      var dirColor = dir === 'HIGH' ? '#f87171' : '#38bdf8';
      var dirTag = '<span style="font-size:9px;font-weight:700;color:' + dirColor + ';border:1px solid ' + dirColor +
        '55;border-radius:4px;padding:0 4px;margin-left:5px">' + dir + '</span>';
      var rCell = (r === null)
        ? '<span style="color:#64748b" title="' + esc(p.note || '') + '">n/a</span>'
        : num(r, 2);
      var strengthCell = (r === null)
        ? '<span style="color:#64748b;font-size:10px">' + esc(p.note || '—') + '</span>'
        : strengthLabel(r);
      return '<tr>' +
        '<td>' + esc(p.vhmsLabel) + (p.vhmsUnit ? ' <span style="color:#64748b">(' + esc(p.vhmsUnit) + ')</span>' : '') + dirTag + '</td>' +
        '<td>' + esc(p.sosLabel) + (p.sosUnit ? ' <span style="color:#64748b">(' + esc(p.sosUnit) + ')</span>' : '') + '</td>' +
        '<td class="center mono">' + p.n + '</td>' +
        '<td class="center mono" style="color:' + color + ';font-weight:700">' + rCell + '</td>' +
        '<td class="center">' + basisChip(p.basis) + '</td>' +
        '<td class="center">' + strengthCell + '</td>' +
        '<td class="wrap-text" style="font-size:11px;color:#cbd5e1">' + esc(p.hypothesis) + '</td>' +
        '</tr>';
    }).join('');
  }

  /* -------- Selectors -------- */
  function initPairSelectors(res) {
    var opts = res.pairs.map(function (p, i) {
      return '<option value="' + i + '">' + esc(p.vhmsLabel) + ' ↔ ' + esc(p.sosLabel) + ' (r=' + num(p.r, 2) + ')</option>';
    }).join('');
    var tl = document.getElementById('cross-timeline-pair');
    var sc = document.getElementById('cross-scatter-pair');
    if (tl) { tl.innerHTML = opts; tl.value = '0'; state.timelinePair = 0; }
    if (sc) { sc.innerHTML = opts; sc.value = '0'; state.scatterPair = 0; }
    buildTimelineSosSelector(res);
  }

  /* -------- Selector multi-parameter SOS (timeline) -------- */
  /**
   * Bangun daftar checkbox parameter SOS yang relevan dengan kompartemen ini.
   * Default terpilih: parameter SOS dari pasangan (r terkuat) + Na + TBN,
   * sehingga variabel bebas SOS menjadi 3 item (bila tersedia).
   */
  function buildTimelineSosSelector(res) {
    var panel = document.getElementById('cross-timeline-sos-panel');
    if (!panel) return;

    // Kandidat param: dari pasangan terkurasi + Na + TBN (bila ada nilainya).
    var candidateKeys = [];
    res.pairs.forEach(function (p) { if (candidateKeys.indexOf(p.sos) === -1) candidateKeys.push(p.sos); });
    ['additive_na', 'tbn'].forEach(function (k) { if (candidateKeys.indexOf(k) === -1) candidateKeys.push(k); });

    // Kelompokkan per cluster sesuai sos-config.
    var groups = {};
    candidateKeys.forEach(function (k) {
      var def = scfg.PARAMS[k];
      if (!def) return;
      var g = def.cluster || 'lain';
      if (!groups[g]) groups[g] = [];
      groups[g].push(k);
    });
    var groupLabels = { wear: 'Keausan (Wear)', oil: 'Kondisi Oli (Oil)', clean: 'Kebersihan (Cleanliness)', additive: 'Aditif / Kontaminan', lain: 'Lain-lain' };

    // Default terpilih: param SOS pasangan terkuat + Na + TBN.
    var defaults = [];
    if (res.pairs.length) defaults.push(res.pairs[0].sos);
    ['additive_na', 'tbn'].forEach(function (k) {
      if (scfg.PARAMS[k] && defaults.indexOf(k) === -1) defaults.push(k);
    });
    // Kalau belum pernah user pilih (state masih null) → pakai default.
    if (!state.timelineSosParams) state.timelineSosParams = defaults.slice();

    var html = Object.keys(groups).map(function (g) {
      return '<div class="sms-group">' + esc(groupLabels[g] || g) + '</div>' +
        groups[g].map(function (k) {
          var def = scfg.PARAMS[k];
          var checked = state.timelineSosParams.indexOf(k) >= 0 ? ' checked' : '';
          return '<label><input type="checkbox" data-sos-param="' + esc(k) + '"' + checked + '> ' +
            esc(def.label) + ' <span style="color:#64748b">(' + esc(def.unit || '') + ')</span></label>';
        }).join('');
    }).join('');
    panel.innerHTML = html;

    panel.querySelectorAll('input[data-sos-param]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var key = cb.getAttribute('data-sos-param');
        var i = state.timelineSosParams.indexOf(key);
        if (cb.checked && i < 0) state.timelineSosParams.push(key);
        else if (!cb.checked && i >= 0) state.timelineSosParams.splice(i, 1);
        // Minimal 1 & maksimal 6 agar chart tetap terbaca.
        if (state.timelineSosParams.length === 0) { state.timelineSosParams.push(key); cb.checked = true; }
        if (state.timelineSosParams.length > 6) {
          state.timelineSosParams.splice(0, state.timelineSosParams.length - 6);
          panel.querySelectorAll('input[data-sos-param]').forEach(function (c) {
            c.checked = state.timelineSosParams.indexOf(c.getAttribute('data-sos-param')) >= 0;
          });
        }
        updateTimelineSosSummary();
        if (state.currentResult) renderTimeline(state.currentResult);
      });
    });
    updateTimelineSosSummary();
  }

  function updateTimelineSosSummary() {
    var sel = state.timelineSosParams || [];
    var el = document.getElementById('cross-timeline-sos-summary');
    var cnt = document.getElementById('cross-timeline-sos-count');
    if (cnt) cnt.textContent = sel.length;
    if (el) {
      el.textContent = sel.length === 0 ? 'Pilih parameter'
        : sel.map(function (k) { return (scfg.PARAMS[k] || {}).label || k; }).join(', ');
    }
  }

  /* -------- Tabel data mentah titik pasangan -------- */
  function renderScatterDataTable(res, p) {
    var el = document.getElementById('cross-scatter-datatable');
    if (!el) return;
    if (!p || !res.points.length) { el.innerHTML = ''; return; }
    var axisCol = (res.timeBase === 'date') ? 'Tanggal (acuan)' : 'HM/SMR (acuan)';
    // [REVISI #3] Tampilkan titik korelasi dengan DATA TERBARU di paling atas
    // (urut menurun). Data sumber `res.points` urut menaik (lama->baru), jadi
    // kita balik urutannya untuk tampilan tabel. Indeks asli dipertahankan
    // agar pasangan xRaw/yRaw tetap sinkron (tanpa indexOf O(n^2)).
    var pointsDesc = res.points.map(function (pt, i) { return { pt: pt, i: i }; }).reverse();
    var rows = pointsDesc.map(function (row) {
      var pt = row.pt, i = row.i;
      var vv = p.xRaw ? p.xRaw[i] : null;
      var sv = p.yRaw ? p.yRaw[i] : null;
      var axisTxt = (res.timeBase === 'date')
        ? (pt.date || new Date(pt.axis).toLocaleDateString('id-ID'))
        : num(pt.axis, 0);
      return '<tr>' +
        '<td class="mono" style="font-size:10.5px">' + (pt.date || '—') + '</td>' +
        '<td class="center mono">' + axisTxt + '</td>' +
        '<td class="center mono">' + num(vv, 2) + '</td>' +
        '<td class="center mono">' + num(sv, 2) + '</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table class="data" style="margin-top:8px">' +
      '<thead><tr><th>Tanggal SOS</th><th class="center">' + axisCol + '</th><th class="center">' + esc(p.vhmsLabel) + '</th><th class="center">' + esc(p.sosLabel) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  /* -------- Timeline gabungan -------- */
  /** Palet warna untuk dataset SOS (konsisten per urutan). */
  var SOS_COLORS = ['#f59e0b', '#22c55e', '#a78bfa', '#f43f5e', '#38bdf8', '#eab308'];
  var SOS_POINTS = ['rectRot', 'circle', 'triangle', 'rect', 'diamond', 'crossRot'];

  /**
   * [FITUR] Tampilkan acuan sumbu terpakai + diagnostik fallback + saran.
   * Mengisi chip #cross-timeline-base-note dan panel #cross-timeline-diagnostic.
   */
  function renderTimelineBaseInfo(res) {
    var noteEl = document.getElementById('cross-timeline-base-note');
    var diagEl = document.getElementById('cross-timeline-diagnostic');
    var diag = res && res.baseDiag;
    var isDate = res && res.timeBase === 'date';

    if (noteEl) {
      if (diag && diag.trigger) {
        noteEl.innerHTML = '<i class="fa-solid fa-shuffle"></i> Terpakai: <strong>Tanggal</strong> (fallback)';
        noteEl.style.borderColor = '#f59e0b88'; noteEl.style.color = '#fbbf24';
      } else {
        noteEl.innerHTML = '<i class="fa-solid fa-check"></i> Terpakai: <strong>' + (isDate ? 'Tanggal' : 'HM/SMR') + '</strong>';
        noteEl.style.borderColor = '#22c55e66'; noteEl.style.color = '#34d399';
      }
    }
    if (!diagEl) return;
    if (!diag) { diagEl.innerHTML = ''; return; }

    var hm = diag.evaluated.hm, dt = diag.evaluated.date;
    var rng = function (arr, isDateAxis) {
      if (!arr) return '—';
      var f = isDateAxis ? function (t) { return new Date(t).toLocaleDateString('id-ID'); }
                         : function (t) { return Math.round(t).toLocaleString('id-ID'); };
      return f(arr[0]) + '–' + f(arr[1]);
    };

    // Hanya tampilkan banner diagnostik bila memang ada masalah overlap
    // (fallback aktif, atau tidak ada acuan yang cukup).
    var problem = diag.trigger || (hm.overlap < diag.minN && dt.overlap < diag.minN);
    if (!problem) { diagEl.innerHTML = ''; return; }

    var tone = (dt.overlap >= diag.minN || hm.overlap >= diag.minN) ? '#f59e0b' : '#ef4444';
    var icon = (dt.overlap >= diag.minN || hm.overlap >= diag.minN) ? 'fa-shuffle' : 'fa-triangle-exclamation';
    var html = '<div style="padding:10px 12px;border-radius:9px;background:rgba(245,158,11,.08);' +
      'border-left:3px solid ' + tone + ';font-size:11.5px;color:#cbd5e1">' +
      '<div style="font-weight:700;color:' + tone + ';margin-bottom:4px"><i class="fa-solid ' + icon + '"></i> ' +
        (diag.trigger ? 'Fallback sumbu aktif' : 'Data tidak tumpang-tindih') + '</div>' +
      '<div>Sumbu <strong>HM/SMR</strong>: VHMS ' + rng(hm.rangeVhms, false) + ' vs SOS ' + rng(hm.rangeSos, false) +
        ' → <strong>' + hm.overlap + '</strong> titik overlap.</div>' +
      '<div>Sumbu <strong>Tanggal</strong>: VHMS ' + rng(dt.rangeVhms, true) + ' vs SOS ' + rng(dt.rangeSos, true) +
        ' → <strong>' + dt.overlap + '</strong> titik overlap.</div>';
    if (diag.suggest) {
      html += '<div style="margin-top:5px"><i class="fa-solid fa-lightbulb" style="color:#fbbf24"></i> Saran: pilih ' +
        '<strong>"' + (diag.suggest === 'date' ? 'Tanggal ↔ Tanggal' : 'HM ↔ HM (SMR)') + '"</strong> pada dropdown <em>Mode Pencocokan</em>.</div>';
    } else if (hm.overlap < diag.minN && dt.overlap < diag.minN) {
      html += '<div style="margin-top:5px;color:#94a3b8"><i class="fa-solid fa-circle-info"></i> Tidak ada acuan yang cukup (' +
        diag.minN + ' titik). Periksa kembali data sumber.</div>';
    }
    html += '</div>';
    diagEl.innerHTML = html;
  }

  function renderTimeline(res) {
    var canvas = document.getElementById('cross-timeline-chart');
    if (!canvas || !res.pairs.length) return;
    var p = res.pairs[state.timelinePair] || res.pairs[0];
    var store = global.VHMS_FLEET;
    var analysis = store.getAnalysis(state.currentUnitId);
    var records = analysis.records;
    var useDate = (res.timeBase === 'date');

    // [FITUR] Tampilkan acuan terpakai + diagnostik fallback.
    renderTimelineBaseInfo(res);

    // Sumbu X = SMR (HM) atau Tanggal, sesuai acuan analisa.
    var axisOf = useDate
      ? function (r) { return cross.recordTime(r); }
      : function (r) { return r.smr; };
    var labels = records.map(function (r) {
      var a = axisOf(r);
      if (a === null || a === undefined) return '—';
      return useDate ? new Date(a).toLocaleDateString('id-ID') : Math.round(a);
    });
    var vSeries = records.map(function (r) { return r[p.vhms]; });

    // [REVISI #1] Tanggal telemetri (Waktu Rekam VHMS) per record — untuk
    // judul tooltip agar pengguna tahu KAPAN kejadian (bukan hanya SMR).
    var recDates = records.map(function (r) {
      return (r.calendar && r.calendar.display) ? r.calendar.display : '';
    });

    // Daftar parameter SOS terpilih (fallback: param pasangan).
    var sosKeys = (state.timelineSosParams && state.timelineSosParams.length)
      ? state.timelineSosParams.slice()
      : [p.sos];

    // Tolerance snap titik SOS ke record VHMS terdekat.
    var tol = useDate ? 1000 * 60 * 60 * 24 * 3 : 500;  // 3 hari atau 500 jam

    // Untuk tiap parameter SOS, buat deret marker (null di luar titik sampel).
    var sosSeriesList = sosKeys.map(function (sk, si) {
      var markerData = records.map(function () { return null; });
      var markerInfo = records.map(function () { return null; });
      res.points.forEach(function (pt) {
        var val = pt.vals ? pt.vals[sk] : undefined;
        if (val === undefined || val === null) return;
        var bestIdx = -1, bestDist = Infinity;
        for (var j = 0; j < records.length; j++) {
          var av = axisOf(records[j]);
          if (av === null || av === undefined) continue;
          var d = Math.abs(av - pt.axis);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        if (bestIdx >= 0 && bestDist <= tol) {
          markerData[bestIdx] = val;
          markerInfo[bestIdx] = { hm: pt.axis, date: pt.date, val: val };
        }
      });
      var def = scfg.PARAMS[sk] || {};
      return {
        key: sk, label: def.label || sk, unit: def.unit || '',
        color: SOS_COLORS[si % SOS_COLORS.length], pointStyle: SOS_POINTS[si % SOS_POINTS.length],
        data: markerData, info: markerInfo
      };
    });

    // Datasets: 1 garis VHMS + N marker SOS (masing-masing sumbu-Y 'y'..).
    var datasets = [{
      label: p.vhmsLabel + ' (' + (p.vhmsUnit || '') + ')',
      data: vSeries,
      borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.10)',
      borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false, yAxisID: 'y'
    }];
    sosSeriesList.forEach(function (s, si) {
      datasets.push({
        label: s.label + ' (' + s.unit + ')',
        data: s.data,
        borderColor: s.color, backgroundColor: s.color,
        showLine: false,
        pointRadius: 7, pointHoverRadius: 10, pointStyle: s.pointStyle,
        yAxisID: 'ysos' + si
      });
    });

    // Scale: sumbu kiri = VHMS; sumbu-sumbu kanan = tiap param SOS (Opsi A).
    var scales = {
      x: { title: { display: true, text: (useDate ? 'Tanggal' : 'SMR / HM (jam)'), color: '#94a3b8' }, ticks: { color: '#94a3b8', maxTicksLimit: 12 } },
      y: { position: 'left', title: { display: true, text: p.vhmsLabel, color: '#22d3ee' }, ticks: { color: '#22d3ee' } }
    };
    sosSeriesList.forEach(function (s, si) {
      scales['ysos' + si] = {
        position: 'right',
        // Hanya sumbu pertama menampilkan gridline agar tidak tumpang-tindih.
        grid: { drawOnChartArea: si === 0 ? false : false },
        title: { display: true, text: s.label + (s.unit ? ' (' + s.unit + ')' : ''), color: s.color, font: { size: 10 } },
        ticks: { color: s.color, font: { size: 10 } }
      };
    });

    destroyChart('timeline');
    charts.timeline = new global.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        // [REVISI #2] Tooltip fleksibel — mode index, tanpa intersect.
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#cbd5e1', font: { size: 11 }, usePointStyle: true } },
          tooltip: {
            callbacks: {
              // [REVISI #1] Judul tooltip = TANGGAL (Waktu Rekam) + SMR.
              title: function (it) {
                if (!it || !it.length) return '';
                var i = it[0].dataIndex;
                var d = (recDates && recDates[i]) ? recDates[i] : '';
                var l = it[0].label;
                if (useDate) return d || ('Tanggal ' + l);
                if (d && l !== undefined) return d + '  \u2022  SMR ' + l + ' jam';
                return d || ('SMR ' + l + ' jam');
              },
              label: function (ctx) { return ctx.dataset.label + ': ' + num(ctx.parsed.y, 2); },
              afterBody: function (it) {
                var idx = it[0].dataIndex;
                var lines = [];
                sosSeriesList.forEach(function (s) {
                  var mi = s.info[idx];
                  if (mi) lines.push('   ' + s.label + ' = ' + num(mi.val, 2) + ' ' + (s.unit || '') +
                    ' @ HM ' + Math.round(mi.hm) + (mi.date ? ' (' + mi.date + ')' : ''));
                });
                return lines.length ? [''].concat(lines) : '';
              }
            }
          }
        },
        scales: scales
      }
    });
    if (charts.timeline) { setTimeout(function () { if (charts.timeline) { try { charts.timeline.resize(); } catch (e) {} } }, 60); }

    // Legenda ringkas di bawah chart (memperjelas sumbu-Y tiap warna).
    var legendEl = document.getElementById('cross-timeline-legend');
    if (legendEl) {
      var chips = ['<span class="chip" style="border-color:#22d3ee55;color:#22d3ee"><i class="fa-solid fa-minus"></i> ' + esc(p.vhmsLabel) + ' (VHMS)</span>'];
      sosSeriesList.forEach(function (s) {
        chips.push('<span class="chip" style="border-color:' + s.color + '55;color:' + s.color + '"><i class="fa-solid fa-caret-up"></i> ' + esc(s.label) + ' (SOS)</span>');
      });
      legendEl.innerHTML = chips.join('');
    }

    // Tabel R DINAMIS: korelasi parameter VHMS timeline vs tiap param SOS terpilih.
    renderTimelineRTable(res, p, sosSeriesList);
  }

  /**
   * Tabel korelasi dinamis antara parameter VHMS (garis timeline) dengan tiap
   * parameter SOS yang dipilih user. Nilai r dihitung ulang setiap seleksi
   * berubah — sehingga user dapat melihat kontribusi tiap parameter SOS
   * (mis. Si vs Na vs TBN) terhadap gejala VHMS (mis. Blowby).
   */
  /**
   * [FITUR] Kartu ringkasan KORELASI BERGANDA: Y (VHMS) vs kombinasi X (SOS).
   * Menampilkan Multiple R, R2, kekuatan, n/k, dan persamaan regresi.
   */
  function buildMultipleRHtml(multi, vhmsPair, sosSeriesList) {
    var xNames = sosSeriesList.slice(0, 3).map(function (s) { return esc(s.label); }).join(' + ') || '\u2014';
    if (!multi || multi.R === null) {
      return '<div style="margin-top:10px;padding:10px 12px;border-radius:9px;background:rgba(100,116,139,.12);' +
        'border-left:3px solid #64748b;font-size:11.5px;color:#94a3b8">' +
        '<i class="fa-solid fa-circle-info"></i> <strong>Korelasi Berganda</strong> (Y = ' + esc(vhmsPair.vhmsLabel) +
        ' vs X = ' + xNames + '): ' + esc((multi && multi.note) || 'tidak dapat dihitung') +
        ' \u00b7 n=' + (multi ? multi.n : 0) + '.</div>';
    }
    var Rcol = multi.R >= 0.7 ? '#22c55e' : (multi.R >= 0.4 ? '#eab308' : '#94a3b8');
    var strengthTxt = multi.R >= 0.85 ? 'Sangat Kuat' : (multi.R >= 0.7 ? 'Kuat' : (multi.R >= 0.4 ? 'Moderat' : 'Lemah'));
    var betasTxt = '';
    if (multi.betas) {
      betasTxt = 'Y\u0302 = ' + num(multi.betas[0], 3) +
        multi.betas.slice(1).map(function (b, i) {
          return (b >= 0 ? ' + ' : ' \u2212 ') + num(Math.abs(b), 3) + '\u00b7X' + (i + 1);
        }).join('');
    }
    return '<div style="margin-top:12px;padding:12px 14px;border-radius:10px;background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.22)">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<span style="font-size:12px;font-weight:700;color:#22d3ee"><i class="fa-solid fa-layer-group"></i> Korelasi Berganda (Multiple R)</span>' +
          '<span class="chip" style="font-size:10px">Y = ' + esc(vhmsPair.vhmsLabel) + '</span>' +
          '<span class="chip" style="font-size:10px">X = ' + xNames + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:8px">' +
          '<div><div style="font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Multiple R</div>' +
            '<div style="font-size:22px;font-weight:800;color:' + Rcol + '">' + num(multi.R, 3) + '</div></div>' +
          '<div><div style="font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">R\u00b2 (determinasi)</div>' +
            '<div style="font-size:22px;font-weight:800;color:#e2e8f0">' + num(multi.R2 * 100, 1) + '%</div></div>' +
          '<div><div style="font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Kekuatan</div>' +
            '<div style="font-size:14px;font-weight:700;color:' + Rcol + ';margin-top:5px">' + strengthTxt + '</div></div>' +
          '<div><div style="font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">n / k</div>' +
            '<div style="font-size:14px;font-weight:700;color:#e2e8f0;margin-top:5px">' + multi.n + ' / ' + multi.k + '</div></div>' +
        '</div>' +
        '<p style="margin-top:8px;font-size:11px;color:#cbd5e1">R\u00b2 = ' + num(multi.R2 * 100, 1) +
          '% variasi <strong>' + esc(vhmsPair.vhmsLabel) + '</strong> dapat dijelaskan oleh kombinasi ' + multi.k +
          ' parameter SOS tersebut.</p>' +
        (betasTxt ? '<p style="margin-top:4px;font-size:10.5px;color:#94a3b8;font-family:Consolas,monospace">' + betasTxt +
          ' <span style="color:#64748b">(seri ternormalisasi 0\u20131)</span></p>' : '') +
      '</div>';
  }

  function renderTimelineRTable(res, vhmsPair, sosSeriesList) {
    var el = document.getElementById('cross-timeline-r-table');
    if (!el) return;
    var store = global.VHMS_FLEET;
    var analysis = store.getAnalysis(state.currentUnitId);
    var matched = state.matched || [];

    // Cari unit SOS & kompartemen yang sedang ditampilkan (cocok dengan res).
    var sosUnit = null;
    for (var i = 0; i < matched.length; i++) {
      if (matched[i].component === res.component) { sosUnit = matched[i]; break; }
    }
    if (!sosUnit) sosUnit = matched[0];
    if (!sosUnit) { el.innerHTML = ''; return; }

    var vhmsKey = vhmsPair.vhms;
    var rows = sosSeriesList.map(function (s) {
      var corr = cross.pairCorrelation(analysis, sosUnit, vhmsKey, s.key, { timeBase: res.timeBase });
      return { s: s, corr: corr };
    });

    // Urutkan: r kuat (|r| besar) di atas; null di bawah.
    rows.sort(function (a, b) {
      var ra = a.corr.r === null ? -1 : Math.abs(a.corr.r);
      var rb = b.corr.r === null ? -1 : Math.abs(b.corr.r);
      return rb - ra;
    });

    // [FITUR] KORELASI BERGANDA (multiple R): Y = VHMS, X1..Xk = parameter SOS
    // terpilih (maks 3). Mengukur seberapa baik KOMBINASI X menjelaskan Y.
    var sosKeysForMulti = sosSeriesList.map(function (s) { return s.key; }).slice(0, 3);
    var multi = cross.multipleCorrelation(analysis, sosUnit, vhmsKey, sosKeysForMulti, { timeBase: res.timeBase });

    // Kartu ringkasan KORELASI BERGANDA (Y vs X1+X2+X3).
    var multiHtml = buildMultipleRHtml(multi, vhmsPair, sosSeriesList);

    // Tentukan kandidat penyebab dominan (|r| terbesar, min 0.5).
    var top = rows.find(function (x) { return x.corr.r !== null && Math.abs(x.corr.r) >= 0.5; });

    var body = rows.map(function (x) {
      var r = x.corr.r;
      var color = r === null ? '#94a3b8' : (Math.abs(r) >= 0.7 ? (r > 0 ? '#22c55e' : '#ef4444') : (Math.abs(r) >= 0.5 ? '#eab308' : '#94a3b8'));
      var rCell = (r === null)
        ? '<span style="color:#64748b" title="' + esc(x.corr.note || '') + '">n/a</span>'
        : '<strong style="color:' + color + '">' + num(r, 2) + '</strong>';
      var strength = (r === null)
        ? '<span style="color:#64748b;font-size:10px">' + esc(x.corr.note || '—') + '</span>'
        : strengthLabel(r);
      var isTop = top && x === top;
      return '<tr' + (isTop ? ' style="background:rgba(34,211,238,.08)"' : '') + '>' +
        '<td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + x.s.color + ';margin-right:7px"></span>' +
          esc(x.s.label) + ' <span style="color:#64748b">(' + esc(x.s.unit) + ')</span>' +
          (isTop ? ' <span class="chip" style="border-color:#22d3ee55;color:#22d3ee;font-size:9px">penyebab dominan</span>' : '') + '</td>' +
        '<td class="center">' + rCell + '</td>' +
        '<td class="center">' + strength + '</td>' +
        '<td class="center mono">' + x.corr.n + '</td>' +
        '<td class="center">' + basisChip(x.corr.basis) + '</td>' +
        '</tr>';
    }).join('');

    el.innerHTML = '<div class="panel-head" style="margin-bottom:6px">' +
        '<div><h2 class="panel-title" style="font-size:13px"><i class="fa-solid fa-calculator" style="color:#22d3ee"></i> Korelasi Dinamis — ' +
          esc(vhmsPair.vhmsLabel) + ' (VHMS) vs parameter SOS terpilih</h2>' +
        '<p class="panel-sub">Nilai r dihitung ulang mengikuti pilihan parameter SOS di atas. Parameter dengan |r| tertinggi = kandidat penyebab dominan.</p></div>' +
      '</div>' +
      multiHtml +
      '<div class="table-scroll" style="margin-top:12px"><table class="data">' +
        '<thead><tr><th>Parameter SOS</th><th class="center">Pearson r</th><th class="center">Kekuatan</th><th class="center">n</th><th class="center">Basis</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table></div>' +
      (top
        ? '<p style="margin-top:10px;font-size:11.5px;color:#cbd5e1"><i class="fa-solid fa-lightbulb" style="color:#fbbf24"></i> ' +
            'Kandidat penyebab dominan: <strong>' + esc(top.s.label) + '</strong> dengan r = ' + num(top.corr.r, 2) + ' (' + strengthLabel(top.corr.r) + '). ' +
            'Hubungan ' + (top.corr.r > 0 ? 'searah' : 'berlawanan') + ' terhadap ' + esc(vhmsPair.vhmsLabel) + '.</p>'
        : '<p style="margin-top:10px;font-size:11px;color:#94a3b8"><i class="fa-solid fa-circle-info"></i> Belum ada parameter SOS dengan korelasi cukup kuat (|r| ≥ 0.5) pada window ini. Tambah data sampel untuk analisa lebih lanjut.</p>');
  }

  /* -------- Scatter -------- */
  function renderScatter(res) {
    var canvas = document.getElementById('cross-scatter-chart');
    if (!canvas || !res.pairs.length) return;
    var p = res.pairs[state.scatterPair] || res.pairs[0];
    var pts = [];
    for (var i = 0; i < p.x.length; i++) {
      if (p.x[i] !== null && p.y[i] !== null) pts.push({ x: p.x[i], y: p.y[i] });
    }
    // Garis tren (regresi linear sederhana) + warna sesuai arah korelasi.
    var trend = null;
    if (pts.length >= 2) {
      var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      pts.forEach(function (o) { sx += o.x; sy += o.y; sxx += o.x * o.x; sxy += o.x * o.y; });
      var den = n * sxx - sx * sx;
      if (Math.abs(den) > 1e-9) {
        var slope = (n * sxy - sx * sy) / den;
        var intercept = (sy - slope * sx) / n;
        trend = [{ x: 0, y: intercept }, { x: 1, y: slope + intercept }];
      }
    }
    var tColor = p.r === null ? '#64748b' : (p.r > 0 ? '#22c55e' : '#ef4444');
    var datasets = [{
      label: p.vhmsLabel + ' vs ' + p.sosLabel,
      data: pts,
      backgroundColor: 'rgba(245,158,11,0.85)',
      borderColor: '#fbbf24',
      pointRadius: 6, pointHoverRadius: 9
    }];
    if (trend) {
      datasets.push({
        type: 'line', label: 'Tren (r=' + num(p.r, 2) + ')',
        data: trend, borderColor: tColor, borderWidth: 2, borderDash: [6, 4],
        pointRadius: 0, fill: false, tension: 0
      });
    }
    destroyChart('scatter');
    charts.scatter = new global.Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 10, right: 12, bottom: 6, left: 6 } },
        plugins: {
          legend: {
            // [REVISI #14] Legend dipindah ke BAWAH chart (sebelumnya di kanan),
            // di-center & sejajar, agar scatter & radar tampil bersebelahan rapi.
            position: 'bottom',
            align: 'center',
            labels: { color: '#cbd5e1', font: { size: 11 }, boxWidth: 14, boxHeight: 14, padding: 12, usePointStyle: true }
          },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': (' + num(ctx.parsed.x, 2) + ', ' + num(ctx.parsed.y, 2) + ')'; } } }
        },
        scales: {
          x: { title: { display: true, text: p.vhmsLabel + ' (normal 0–1)', color: '#94a3b8', font: { size: 12 } }, min: 0, max: 1, grace: '6%', ticks: { color: '#94a3b8', font: { size: 11 } } },
          y: { title: { display: true, text: p.sosLabel + ' (normal 0–1)', color: '#94a3b8', font: { size: 12 } }, min: 0, max: 1, grace: '6%', ticks: { color: '#94a3b8', font: { size: 11 } } }
        }
      }
    });
    // Pastikan chart mengisi lebar container (bila dirender saat panel sempat
    // berukuran kecil, Chart.js perlu resize eksplisit setelah layout selesai).
    if (charts.scatter) {
      // [REVISI #2] Jangan klip titik di tepi area chart.
      try { charts.scatter.data.datasets.forEach(function (ds) { ds.clip = false; }); } catch (e) {}
      try { charts.scatter.resize(); } catch (e) {}
      setTimeout(function () { if (charts.scatter) { try { charts.scatter.resize(); } catch (e) {} } }, 60);
    }
    setText('cross-scatter-sub', 'Pasangan terpilih: ' + p.vhmsLabel + ' ↔ ' + p.sosLabel);
    var stat = document.getElementById('cross-scatter-stat');
    if (stat) {
      var r = p.r;
      // Hitung titik yang berada di zona normal (x=0 & y=0) untuk menjelaskan
      // kenapa banyak titik menumpuk di sudut (0,0).
      var atOrigin = 0;
      for (var k = 0; k < p.x.length; k++) {
        if (p.x[k] === 0 && p.y[k] === 0) atOrigin++;
      }
      var verdict = r === null
        ? ('Tidak dapat dihitung: ' + (p.note || 'data tidak cukup'))
        : (Math.abs(r) >= 0.7 ? (r > 0 ? 'Korelasi KUAT searah → indikasi saling terkait'
          : 'Korelasi KUAT berlawanan → satu naik, satu turun (mis. tekanan vs keausan)')
          : (Math.abs(r) >= 0.5 ? 'Korelasi MODERAT — indikasi awal, perlu data tambahan'
          : 'Korelasi lemah — tafsir hati-hati'));
      stat.innerHTML = '<span class="chip">r = ' + (r === null ? 'n/a' : num(r, 2)) + '</span> <span class="chip">n = ' + p.n + '</span>' +
        basisChip(p.basis) +
        (atOrigin ? ' <span class="chip" title="Titik di sudut (0,0) = kedua parameter masih di bawah batas normal">' + atOrigin + ' di (0,0)</span>' : '') +
        '<div style="margin-top:6px;font-size:11px;color:#cbd5e1">' + esc(verdict) + '</div>' +
        (atOrigin === p.n ? '<div style="margin-top:4px;font-size:10px;color:#fbbf24"><i class="fa-solid fa-circle-info"></i> Kedua parameter selalu di bawah batas — tidak ada penyimpangan pada jendela ini.</div>' : '') +
        (p.note ? '<div style="margin-top:4px;font-size:10px;color:#94a3b8"><i class="fa-solid fa-circle-info"></i> ' + esc(p.note) + '</div>' : '');
    }
    // Tabel nilai mentah VHMS vs SOS di tiap titik sampel (buktikan data tampil)
    renderScatterDataTable(res, p);
  }

  /* -------- Radar profil gabungan -------- */
  function renderRadar(vhmsAnalysis, sosUnits, compIndex) {
    var canvas = document.getElementById('cross-radar-chart');
    if (!canvas) return;

    // Dropdown kompartemen SOS (bila lebih dari satu).
    var sel = document.getElementById('cross-radar-unit');
    if (sel) {
      var cur = (compIndex === undefined || compIndex === null) ? 0 : compIndex;
      sel.innerHTML = sosUnits.map(function (u, i) {
        return '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' +
          esc(u.component + ' (' + (u.mprs ? cfgTier(u.mprs.tier) : '') + ')') + '</option>';
      }).join('');
      sel.style.display = sosUnits.length > 1 ? '' : 'none';
    }
    var idx = (compIndex === undefined || compIndex === null) ? 0 : compIndex;
    var comp = sosUnits[idx] || sosUnits[0];

    // Pilar VHMS (normalisasi keparahan 0-100 berdasarkan anomali window)
    var vhmsPillar = { ENGINE: 0, HYDRAULIC: 0, COOLING: 0, POWERTRAIN: 0 };
    var pFactor = global.VHMS_CONFIG.RANKING_PILLARS || {};
    (vhmsAnalysis.anomalies || []).forEach(function (a) {
      var pil = pFactor[a.param];
      if (!pil || vhmsPillar[pil] === undefined) return;
      var sev = a.status === 'CRITICAL' ? 100 : (a.status === 'WARNING' ? 55 : 0);
      if (sev > vhmsPillar[pil]) vhmsPillar[pil] = sev;
    });

    // Cluster SOS (wear/oil/clean) → rata-rata normalisasi
    var thresholds = scfg.getThresholdsFor(comp.component);
    var clusterMap = { wear: 0, oil: 0, clean: 0 };
    var cnt = { wear: 0, oil: 0, clean: 0 };
    Object.keys(thresholds).forEach(function (pk) {
      var def = scfg.PARAMS[pk]; if (!def) return;
      var v = comp.latest[pk]; if (v === null || v === undefined) return;
      var nv = cross.normSos(v, thresholds[pk]);
      if (nv === null) return;
      var cl = def.cluster; if (clusterMap[cl] === undefined) return;
      clusterMap[cl] += nv * 100; cnt[cl]++;
    });
    var sosCluster = {
      wear: cnt.wear ? clusterMap.wear / cnt.wear : 0,
      oil: cnt.oil ? clusterMap.oil / cnt.oil : 0,
      clean: cnt.clean ? clusterMap.clean / cnt.clean : 0
    };

    destroyChart('radar');
    charts.radar = new global.Chart(canvas.getContext('2d'), {
      type: 'radar',
      data: {
        labels: ['ENGINE', 'HYDRAULIC', 'COOLING', 'POWERTRAIN', 'SOS Wear', 'SOS Oil', 'SOS Clean'],
        datasets: [
          {
            label: 'VHMS (keparahan %)',
            data: [vhmsPillar.ENGINE, vhmsPillar.HYDRAULIC, vhmsPillar.COOLING, vhmsPillar.POWERTRAIN, 0, 0, 0],
            borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.20)', borderWidth: 2, pointBackgroundColor: '#22d3ee'
          },
          {
            label: 'SOS ' + comp.component + ' (keparahan %)',
            data: [0, 0, 0, 0, sosCluster.wear, sosCluster.oil, sosCluster.clean],
            borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.20)', borderWidth: 2, pointBackgroundColor: '#f59e0b'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        // [REVISI #2] Tooltip fleksibel (mode index, tanpa intersect).
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: 6 } },
        plugins: {
          legend: {
            // [REVISI #14] Legend di BAWAH chart (sebelumnya kanan), center.
            position: 'bottom',
            align: 'center',
            labels: { color: '#cbd5e1', font: { size: 11 }, boxWidth: 14, boxHeight: 14, padding: 12, usePointStyle: true }
          }
        },
        scales: { r: { min: 0, max: 100, ticks: { color: '#64748b', backdropColor: 'transparent', font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.2)' }, pointLabels: { color: '#cbd5e1', font: { size: 11 } } } }
      }
    });
    if (charts.radar) {
      try { charts.radar.resize(); } catch (e) {}
      setTimeout(function () { if (charts.radar) { try { charts.radar.resize(); } catch (e) {} } }, 60);
    }

    // Stat: pilar VHMS terburuk & cluster SOS terburuk.
    var stat = document.getElementById('cross-radar-stat');
    if (stat) {
      var vhmsWorst = null;
      Object.keys(vhmsPillar).forEach(function (k) { if (!vhmsWorst || vhmsPillar[k] > vhmsPillar[vhmsWorst]) vhmsWorst = k; });
      var sosWorst = null;
      Object.keys(sosCluster).forEach(function (k) { if (!sosWorst || sosCluster[k] > sosCluster[sosWorst]) sosWorst = k; });
      stat.innerHTML =
        '<span class="chip" style="border-color:#22d3ee55;color:#22d3ee">VHMS terburuk: ' + (vhmsWorst || '—') + ' ' + num(vhmsPillar[vhmsWorst] || 0, 0) + '%</span> ' +
        '<span class="chip" style="border-color:#f59e0b55;color:#f59e0b">SOS terburuk: ' + (sosWorst || '—') + ' ' + num(sosCluster[sosWorst] || 0, 0) + '%</span>';
    }
  }
  function cfgTier(t) { return ['NORMAL', 'MONITOR', 'CRITICAL', 'EXTREME'][t || 0]; }

  // Peta canvas id untuk tiap chart (untuk destroy yang andal).
  var CANVAS_ID = {
    timeline: 'cross-timeline-chart',
    scatter: 'cross-scatter-chart',
    radar: 'cross-radar-chart',
    modalScatter: 'cross-modal-scatter-chart'
  };

  function destroyChart(key) {
    // 1) Destroy instance yang kita simpan.
    if (charts[key]) { try { charts[key].destroy(); } catch (e) {} charts[key] = null; }
    // 2) Jaring pengaman: destroy instance apa pun yang masih terikat ke canvas
    //    (mencegah "Canvas is already in use" bila ada render ganda/error).
    var cid = CANVAS_ID[key];
    var canvas = cid ? document.getElementById(cid) : null;
    if (canvas && global.Chart && global.Chart.getChart) {
      var inst = global.Chart.getChart(canvas);
      if (inst) { try { inst.destroy(); } catch (e) {} }
    }
  }
  function destroyCharts() {
    ['timeline', 'scatter', 'radar', 'modalScatter'].forEach(destroyChart);
  }

  /* --------------------------- Wiring ----------------------------------- */
  function onTimelinePairChange() {
    state.timelinePair = parseInt(document.getElementById('cross-timeline-pair').value, 10) || 0;
    if (state.currentResult) renderTimeline(state.currentResult);
  }
  function onScatterPairChange() {
    state.scatterPair = parseInt(document.getElementById('cross-scatter-pair').value, 10) || 0;
    if (state.currentResult) renderScatter(state.currentResult);
  }

  function showCross() {
    state.currentUnitId = null;
    state.currentResult = null;
    vis('cross-fleet-panel', true);
    vis('cross-detail-panel', false);
    renderFleet();
  }

  function init() {
    var back = document.getElementById('btn-cross-back');
    if (back) back.addEventListener('click', exitCross);
    var s = document.getElementById('cross-search');
    if (s) s.addEventListener('input', function () { state.search = s.value; renderFleet(); });
    var f = document.getElementById('cross-filter');
    if (f) f.addEventListener('change', function () { state.filter = f.value; renderFleet(); });
    var body = document.getElementById('cross-fleet-body');
    if (body) body.addEventListener('click', function (e) {
      var b = e.target.closest('.cross-open');
      if (b) openDetail(b.getAttribute('data-unit-id'));
    });
    document.querySelectorAll('#cross-area th[data-cross-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-cross-sort');
        state.sortDir = (state.sortKey === k && state.sortDir === 'desc') ? 'asc' : 'desc';
        state.sortKey = k;
        renderFleet();
      });
    });
    var tl = document.getElementById('cross-timeline-pair');
    if (tl) tl.addEventListener('change', onTimelinePairChange);
    var sc = document.getElementById('cross-scatter-pair');
    if (sc) sc.addEventListener('change', onScatterPairChange);

    // [FITUR] Dropdown mode pencocokan sumbu (auto/HM/Tanggal).
    var baseSel = document.getElementById('cross-timeline-base');
    if (baseSel) {
      baseSel.value = state.timeBase || 'auto';
      baseSel.addEventListener('change', function () {
        state.timeBase = baseSel.value || 'auto';
        // Hitung ulang detail unit yang sedang dibuka (bila ada).
        if (state.currentUnitId) { openDetail(state.currentUnitId); }
        else { renderFleet(); }
      });
    }

    // Modal scatter: tombol kembali + klik overlay + tombol ESC.
    var modalClose = document.getElementById('cross-scatter-modal-close');
    if (modalClose) modalClose.addEventListener('click', closeScatterModal);
    var modalOverlay = document.getElementById('cross-scatter-modal');
    if (modalOverlay) modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) closeScatterModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var ov = document.getElementById('cross-scatter-modal');
        if (ov && !ov.classList.contains('hidden')) closeScatterModal();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.VHMS_CROSS_RENDER = {
    showCross: showCross,
    renderFleet: renderFleet,
    openDetail: openDetail,
    backToFleet: backToFleet,
    exitCross: exitCross,
    destroyCharts: destroyCharts
  };
})(typeof window !== 'undefined' ? window : globalThis);

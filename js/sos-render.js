/* =========================================================================
 * sos-render.js
 * -------------------------------------------------------------------------
 * Render SOS Dashboard: KPI cards, fleet table, 3-cluster charts,
 * diagnostics panel, ranking table.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg    = global.SOS_CONFIG;
  var store  = global.SOS_STORE;
  var parser = global.SOS_PARSER;

  var charts = {};  // Chart.js instances

  /* -----------------------------------------------------------------------
   * Utilitas format
   * --------------------------------------------------------------------- */
  function fmt(v, d) {
    if (v === null || v === undefined) return '—';
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function esc(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
  /** Set teks sebuah elemen berdasarkan id (null-safe). */
  function setText(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }
  function tierBadge(tier) {
    var labels = cfg.TIER_LABELS;
    var colors = ['#22c55e','#eab308','#ef4444','#991b1b'];
    var t = tier || 0;
    return '<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700;' +
      'background:' + colors[t] + '22;color:' + colors[t] + '">' + labels[t] + '</span>';
  }
  function bandBadge(band) {
    var map = { 'NORMAL': 0, 'MONITOR': 1, 'WARNING': 1, 'CRITICAL': 2, 'EXTREME': 3 };
    return tierBadge(map[band] || 0);
  }

  /* -----------------------------------------------------------------------
   * KPI Cards
   * --------------------------------------------------------------------- */
  function renderKPI(stats) {
    var el = document.getElementById('sos-kpi-grid');
    if (!el) return;
    var nAssets = Object.keys(stats.uniqueAssets).length;
    var t = stats.tiers;
    var total = t[0] + t[1] + t[2] + t[3] || 1;
    el.innerHTML =
      kpiCard('fa-flask', 'Total Sampel', fmt(stats.totalSamples, 0), 'sky', '') +
      kpiCard('fa-truck-monster', 'Unit Unik', fmt(nAssets, 0), 'cyan', '') +
      kpiCard('fa-circle-check', 'Normal', fmt(t[0], 0), 'emerald', fmt((t[0] / total) * 100, 0) + '% unit') +
      kpiCard('fa-circle-exclamation', 'Monitor', fmt(t[1], 0), 'amber', fmt((t[1] / total) * 100, 0) + '% unit') +
      kpiCard('fa-triangle-exclamation', 'Critical', fmt(t[2], 0), 'red', fmt((t[2] / total) * 100, 0) + '% unit') +
      kpiCard('fa-skull-crossbones', 'Extreme', fmt(t[3], 0), 'red', fmt((t[3] / total) * 100, 0) + '% unit');
  }

  /** Kartu KPI dengan gaya yang sama seperti mode VHMS (accent + glow + note). */
  function kpiCard(icon, label, value, accent, sub) {
    return '<div class="kpi-card accent-' + accent + '">' +
      '<div class="glow"></div>' +
      '<p class="kpi-title">' + esc(label) + '</p>' +
      '<div class="kpi-value"><span class="num">' + value + '</span></div>' +
      '<p class="kpi-note">' + (sub ? esc(sub) : '<i class="fa-solid ' + icon + '"></i>') + '</p>' +
      '</div>';
  }

  /* -----------------------------------------------------------------------
   * Fleet Table (sorted, filtered)
   * --------------------------------------------------------------------- */
  // Default: urutkan menurut SEVERITY (EXTREME paling atas → NORMAL paling
  // bawah). Tier: NORMAL=0, MONITOR=1, CRITICAL=2, EXTREME=3.
  // valueMode: sumber nilai kolom parameter (last | avg | worst).
  var fleetState = { sortKey: 'severity', sortDir: 'desc', filter: 'ALL', search: '', valueMode: 'last' };

  // Parameter yang ditampilkan di kolom katalog + presisi desimalnya.
  // [REVISI] Tambah additive_na (Na); ISO dihapus dari kolom.
  var FLEET_PARAMS = [
    { key: 'wear_fe', d: 1 }, { key: 'wear_cu', d: 1 }, { key: 'wear_si', d: 1 },
    { key: 'additive_na', d: 0 },
    { key: 'pqi', d: 0 }, { key: 'visc_v100', d: 2 }
  ];

  /**
   * Nilai parameter yang DITAMPILKAN untuk sebuah unit sesuai valueMode.
   * - 'last'  -> sampel terbaru (default)
   * - 'avg'   -> rata-rata sampel dalam window 4000 jam
   * - 'worst' -> nilai pada sampel dengan severity tertinggi pada jendela
   * @returns {{ map, iso, sample, date, dateHint }}
   *   `date` = tanggal yang MENJELASKAN asal nilai (agar kolom "Tanggal"
   *   ikut berubah sesuai mode): last -> tanggal sampel terbaru; worst ->
   *   tanggal sampel terburuk; avg -> rentang tanggal window.
   */
  function displayedValues(u) {
    var mode = fleetState.valueMode || 'last';
    var latest = u.latest;
    if (mode === 'last' || !global.SOS_ANALYTICS || !global.SOS_ANALYTICS.windowStats) {
      return { map: null, iso: latest.iso_code, sample: latest, date: latest._dateStr || null,
               dateHint: 'Tanggal sampel SOS terbaru' };
    }
    var stats = u._winStats;
    if (!stats) {
      var keys = FLEET_PARAMS.map(function (p) { return p.key; }).concat(['iso_code']);
      stats = global.SOS_ANALYTICS.windowStats(u.samples, u.component, keys);
      u._winStats = stats;
    }
    var map = {};
    var iso = latest.iso_code;
    var date = latest._dateStr || null;
    var dateHint = '';
    if (mode === 'worst') {
      // [FIX] Ambil SATU sampel terburuk keseluruhan (severity tertinggi pada
      // window). Semua nilai & tanggal berasal dari sampel yang SAMA agar
      // konsisten dan tidak menyesatkan.
      var ws = stats.__worstSample || null;
      FLEET_PARAMS.forEach(function (p) {
        map[p.key] = ws ? ws[p.key] : null;
      });
      if (ws) { iso = ws.iso_code || iso; date = ws._dateStr || date; }
      dateHint = 'Tanggal sampel TERBURUK (window 4000 jam)';
    } else {
      // mode 'avg' -> rata-rata per parameter + rentang tanggal window.
      FLEET_PARAMS.forEach(function (p) {
        var rec = stats[p.key];
        map[p.key] = rec ? rec.avg : null;
      });
      var fd = stats.__windowFirst || null;
      var ld = stats.__windowLast || null;
      if (fd && ld && fd !== ld) { date = fd + ' – ' + ld; dateHint = 'Rentang tanggal window 4000 jam (rata-rata)'; }
      else { date = ld || fd || date; dateHint = 'Tanggal window 4000 jam (rata-rata)'; }
    }
    return { map: map, iso: iso, sample: latest, date: date, dateHint: dateHint };
  }

  // Prioritas P1..P4 (makin besar = makin critical).
  var SEV_RANK = { 'NORMAL': 1, 'MONITOR': 2, 'CRITICAL': 3, 'EXTREME': 4 };

  /**
   * Komparator prioritas tabel SOS.
   * Urutan kunci (makin besar = makin diprioritaskan di atas):
   *   1) tier (EXTREME > CRITICAL > MONITOR > NORMAL)
   *   2) MPRS (skor keparahan)
   *   3) criticality.score
   *   4) hmUnit (jam operasi lebih tinggi → lebih dulu bila seri)
   * @returns {number} negatif bila a lebih diprioritaskan
   */
  function compareSeverity(a, b) {
    var ta = a.mprs.tier || 0, tb = b.mprs.tier || 0;
    if (ta !== tb) return tb - ta;
    var ma = a.mprs.mprs || 0, mb = b.mprs.mprs || 0;
    if (ma !== mb) return mb - ma;
    var ca = (a.criticality && a.criticality.score) || 0;
    var cb = (b.criticality && b.criticality.score) || 0;
    if (ca !== cb) return cb - ca;
    return (b.hmUnit || 0) - (a.hmUnit || 0);
  }

  /** Teks badge prioritas P1..P4 untuk tabel SOS. */
  function sevBadgeText(u) {
    var label = cfg.TIER_LABELS[u.mprs.tier] || 'NORMAL';
    return 'P' + (SEV_RANK[label] || 1);
  }

  function renderFleetTable() {
    var tbody = document.getElementById('sos-fleet-body');
    var countEl = document.getElementById('sos-fleet-count');
    if (!tbody) return;

    var units = store.getAllUnits();

    // Filter
    if (fleetState.filter !== 'ALL') {
      var tierMap = { 'NORMAL': 0, 'MONITOR': 1, 'CRITICAL': 2, 'EXTREME': 3 };
      var ft = tierMap[fleetState.filter];
      if (ft !== undefined) units = units.filter(function (u) { return u.mprs.tier === ft; });
    }
    if (fleetState.search) {
      var q = fleetState.search.toLowerCase();
      units = units.filter(function (u) {
        return (u.assetId + ' ' + u.component + ' ' + u.model + ' ' + u.serial + ' ' + u.jobsite).toLowerCase().indexOf(q) !== -1;
      });
    }

    // Sort
    var sk = fleetState.sortKey;
    var dir = fleetState.sortDir === 'asc' ? 1 : -1;
    units.sort(function (a, b) {
      var va, vb;
      if (sk === 'severity') {
        // Prioritas default: paling EXTREME/CRITICAL di atas, NORMAL di bawah.
        return compareSeverity(a, b);
      }
      if (sk === 'tier') { va = a.mprs.tier; vb = b.mprs.tier; }
      else if (sk === 'mprs') { va = a.mprs.mprs; vb = b.mprs.mprs; }
      else if (sk === 'score') { va = a.criticality.score; vb = b.criticality.score; }
      else if (sk === 'hmUnit') { va = a.hmUnit || 0; vb = b.hmUnit || 0; }
      else if (sk === 'hmOil') { va = a.hmOil || 0; vb = b.hmOil || 0; }
      else { va = (a[sk] || '').toString().toLowerCase(); vb = (b[sk] || '').toString().toLowerCase(); }
      if (va < vb) return -dir; if (va > vb) return dir; return 0;
    });

    if (countEl) countEl.textContent = units.length + ' kompartemen dari ' + store.count() + ' sampel';

    var mode = fleetState.valueMode || 'last';
    var modeTag = mode === 'avg' ? ' <span style="font-size:9px;color:#64748b">avg</span>'
                : (mode === 'worst' ? ' <span style="font-size:9px;color:#f87171">worst</span>' : '');
    var html = '';
    units.forEach(function (u) {
      var dv = displayedValues(u);
      var s = u.latest;
      var valColor = function (v, pk) {
        var th = cfg.getThresholdsFor(u.component);
        if (!th[pk] || v === null || v === undefined) return '';
        var t = th[pk];
        // Dukungan batas high/low (mis. visc_v100 warn_low/warn_high).
        if (t.extreme !== undefined && v >= t.extreme) return 'color:#991b1b;font-weight:700';
        if (t.crit !== undefined && v >= t.crit) return 'color:#ef4444;font-weight:700';
        if (t.crit_high !== undefined && v >= t.crit_high) return 'color:#ef4444;font-weight:700';
        if (t.crit_low !== undefined && v <= t.crit_low) return 'color:#ef4444;font-weight:700';
        if (t.warn !== undefined && v >= t.warn) return 'color:#eab308';
        if (t.warn_high !== undefined && v >= t.warn_high) return 'color:#eab308';
        if (t.warn_low !== undefined && v <= t.warn_low) return 'color:#eab308';
        return '';
      };
      // Ambil nilai tampil: dari window stats bila mode avg/worst, else latest.
      var val = function (pk) { return dv.map ? dv.map[pk] : s[pk]; };
      var fe = val('wear_fe'), cu = val('wear_cu'), si = val('wear_si'), na = val('additive_na');
      var pqi = val('pqi'), v100 = val('visc_v100');

      html += '<tr style="cursor:pointer" data-sos-unit="' + esc(u.assetId) + '" data-sos-comp="' + esc(u.component) + '">' +
        '<td class="center"><span class="sev-badge sev-' + (cfg.TIER_LABELS[u.mprs.tier] || 'NORMAL') + '" title="Prioritas P1..P4 — EXTREME (P4) paling atas, NORMAL (P1) paling bawah">' +
          sevBadgeText(u) + '</span></td>' +
        '<td>' + tierBadge(u.mprs.tier) + '</td>' +
        '<td><strong>' + esc(u.assetId) + '</strong></td>' +
        '<td>' + esc(u.model) + '</td>' +
        '<td>' + esc(u.component) + '</td>' +
        '<td class="center">' + fmt(u.hmUnit, 0) + '</td>' +
        '<td class="center">' + fmt(u.hmOil, 0) + '</td>' +
        '<td class="center" style="' + valColor(fe, 'wear_fe') + '">' + fmt(fe, 1) + '</td>' +
        '<td class="center" style="' + valColor(cu, 'wear_cu') + '">' + fmt(cu, 1) + '</td>' +
        '<td class="center" style="' + valColor(si, 'wear_si') + '">' + fmt(si, 1) + '</td>' +
        // [REVISI] Kolom Na (Sodium) menggantikan ISO.
        '<td class="center" style="' + valColor(na, 'additive_na') + '">' + fmt(na, 0) + '</td>' +
        '<td class="center" style="' + valColor(pqi, 'pqi') + '">' + fmt(pqi, 0) + '</td>' +
        '<td class="center" style="' + valColor(v100, 'visc_v100') + '">' + fmt(v100, 2) + '</td>' +
        '<td class="center"><strong>' + fmt(u.mprs.mprs, 1) + '</strong></td>' +
        '<td class="center" title="' + esc(dv.dateHint || 'Tanggal sampel terbaru') + '">' + esc(dv.date || u.lastDate || '—') + '</td>' +
        '<td class="center"><button class="btn btn-primary btn-sm" data-sos-detail="' + esc(u.assetId) + '|' + esc(u.component) + '">' +
          '<i class="fa-solid fa-chart-line"></i> Detail</button></td>' +
        '</tr>';
    });

    tbody.innerHTML = html || '<tr><td colspan="16" style="text-align:center;padding:30px;color:var(--text-mute)">Belum ada data SOS. Upload file CSV lab report.</td></tr>';

    // Update filter counts
    updateFilterCounts();
  }

  function updateFilterCounts() {
    var units = store.getAllUnits();
    var counts = { ALL: units.length, NORMAL: 0, MONITOR: 0, CRITICAL: 0, EXTREME: 0 };
    units.forEach(function (u) {
      var label = cfg.TIER_LABELS[u.mprs.tier];
      if (counts[label] !== undefined) counts[label]++;
    });
    ['ALL','NORMAL','MONITOR','CRITICAL','EXTREME'].forEach(function (k) {
      var el = document.querySelector('#sos-filter-bar .fc-count[data-count="' + k + '"]');
      if (el) el.textContent = counts[k];
    });
  }

  /* -----------------------------------------------------------------------
   * Header global (konsisten dengan VHMS)
   * ---------------------------------------------------------------------
   * Di mode SOS, saat membuka DETAIL kompartemen, header global (yang sama
   * dipakai VHMS) diisi identitas unit SOS:
   *   h1        : "<MODEL> <ASSET>"  (brand disembunyikan)
   *   chip      : Kompartemen + tier
   *   SN chip   : Asset ID
   *   statistik : HM Unit | MPRS | Criticality
   * Saat kembali ke daftar (home), resetHeader() mengembalikan brand.
   * --------------------------------------------------------------------- */
  function renderHeader(unit) {
    if (!unit) return;
    var header = document.querySelector('.app-header');
    if (header) header.classList.remove('header-compact');

    // Judul: "<MODEL> <ASSET ID>" pada #machine-model (brand disembunyikan).
    var brandEl = document.getElementById('machine-brand');
    var modelEl = document.getElementById('machine-model');
    if (brandEl) brandEl.style.display = 'none';
    if (modelEl) {
      modelEl.style.display = '';
      modelEl.textContent = 'SOS ' + (unit.assetId || '') + (unit.model ? ' • ' + unit.model : '');
    }

    // Chip keluarga -> nama kompartemen (warna ungu khas SOS).
    var famEl = document.getElementById('machine-family');
    if (famEl) {
      famEl.textContent = unit.component || '—';
      famEl.style.display = '';
      famEl.style.borderColor = '#a78bfa';
      famEl.style.color = '#a78bfa';
    }
    // Chip Lambung -> sembunyikan; chip SN -> Asset ID.
    var lbEl = document.getElementById('machine-lambung');
    if (lbEl) { lbEl.style.display = 'none'; }
    var snEl = document.getElementById('machine-sn');
    if (snEl) {
      snEl.textContent = 'Unit: ' + (unit.assetId || '—');
      snEl.style.display = '';
      snEl.style.borderColor = ''; snEl.style.color = '';
    }

    // [REVISI #8] Subjudul "Kompartemen: ... • SN ... • N sampel" DIHAPUS di
    // mode SOS. Informasi ini sudah tampil sebagai chip di header global
    // (kompartemen + Unit/Asset ID), sehingga baris subjudul hanya membuat
    // header tampak padat. Kita kosongkan teksnya lalu sembunyikan elemen
    // `.header-sub` agar layout header lebih rapi.
    setText('machine-engine', '');
    var subEl = document.getElementById('machine-engine');
    if (subEl) { var subWrap = subEl.closest ? subEl.closest('.header-sub') : null; (subWrap || subEl).style.display = 'none'; }

    // Statistik: HM Unit | MPRS | Criticality.
    setText('header-smr-label', 'HM Unit');
    setText('header-smr', fmt(unit.hmUnit, 0));
    setText('header-health-label', 'MPRS');
    var hi = document.getElementById('header-health');
    if (hi) {
      hi.textContent = fmt(unit.mprs.mprs, 1);
      hi.className = 'v ' + (unit.mprs.tier >= 2 ? 'warn' : (unit.mprs.tier === 1 ? '' : 'ok'));
    }
    setText('header-rul-label', 'Criticality');
    var rulEl = document.getElementById('header-rul');
    if (rulEl) {
      var band = (unit.criticality && unit.criticality.band) || 'NORMAL';
      rulEl.textContent = fmt(unit.criticality.score, 1) + ' (' + band + ')';
      rulEl.className = 'v ' + (band === 'CRITICAL' ? 'warn' : (band === 'WARNING' ? '' : 'ok'));
    }
    // Waktu sampel terakhir dipakai sebagai "Telemetri Terakhir".
    var tw = document.getElementById('header-time-wrap');
    if (tw && unit.lastDate) { tw.style.display = ''; setText('header-time', unit.lastDate); }

    // Baris unit aktif (dipakai di tampilan VHMS) — samakan bila ada.
    setText('unit-bar-serial', (unit.assetId || '—') + ' — ' + (unit.component || ''));
    var ub = document.getElementById('unit-bar-badge');
    if (ub) {
      ub.textContent = cfg.TIER_LABELS[unit.mprs.tier] || '—';
      ub.className = 'badge ' + (unit.mprs.tier >= 2 ? (unit.mprs.tier === 3 ? 'CRITICAL' : 'WARNING') : 'NORMAL');
    }
  }

  /* -----------------------------------------------------------------------
   * Asset Detail — 3 Cluster Charts
   * --------------------------------------------------------------------- */
  function renderAssetDetail(assetId, component) {
    var unit = store.getUnit(assetId, component);
    if (!unit) return;

    // [HEADER] Isi header global seperti VHMS (identitas unit + statistik).
    renderHeader(unit);

    // Header panel detail: HANYA tombol kembali. Identitas unit (asset, model,
    // kompartemen, tier, MPRS, Criticality) sudah tampil di HEADER GLOBAL di
    // atas (renderHeader), jadi tidak diulang di sini (hindari duplikasi).
    var headerEl = document.getElementById('sos-detail-header');
    if (headerEl) {
      headerEl.innerHTML =
        '<button class="btn btn-ghost btn-sm" id="sos-btn-back-fleet">' +
          '<i class="fa-solid fa-arrow-left"></i> Kembali ke Daftar' +
        '</button>';
      var backBtn = document.getElementById('sos-btn-back-fleet');
      if (backBtn) backBtn.addEventListener('click', function () { showView('fleet'); });
    }

    // Component tabs
    var compTabEl = document.getElementById('sos-comp-tabs');
    if (compTabEl) {
      var allComps = store.getUnitsForAsset(assetId);
      compTabEl.innerHTML = allComps.map(function (cu) {
        var active = cu.component === component;
        return '<button class="' + (active ? 'subtab-btn active' : 'subtab-btn') + '" data-sos-switch-comp="' +
          esc(cu.assetId) + '|' + esc(cu.component) + '">' +
          tierBadge(cu.mprs.tier) + ' ' + esc(cu.component) + '</button>';
      }).join('');
    }

    // Diagnostics
    renderDiagnostics(unit);

    // Charts
    renderClusterCharts(unit);

    // Historical table
    renderSampleTable(unit);
  }

  /* -----------------------------------------------------------------------
   * Cluster Charts (Chart.js)
   * --------------------------------------------------------------------- */
  function renderClusterCharts(unit) {
    var chartArea = document.getElementById('sos-charts-area');
    if (!chartArea) return;

    // Destroy old charts
    Object.keys(charts).forEach(function (k) { if (charts[k]) charts[k].destroy(); });
    charts = {};

    var clusters = cfg.CHART_CLUSTERS;
    var html = '';
    // [REVISI #5] Sertakan cluster baru 'contamination' (Water & Fuel).
    ['wear', 'oil', 'clean', 'contamination'].forEach(function (cid) {
      var cl = clusters[cid];
      if (!cl) return;
      html += '<div class="panel" style="margin-bottom:16px">' +
        '<h3 style="font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:10px">' +
        '<i class="fa-solid ' + cl.icon + '" style="color:' + cl.color + '"></i> ' + cl.title + '</h3>' +
        '<div class="chart-legend" id="sos-legend-' + cid + '"></div>' +
        '<div class="chart-wrap" style="min-height:280px"><canvas id="sos-chart-' + cid + '"></canvas></div></div>';
    });
    chartArea.innerHTML = html;

    // [REVISI #4] Pastikan urutan KRONOLOGIS: tanggal TERLAMA di kiri,
    // TERBARU di kanan. Sumber `unit.samples` umumnya sudah naik (HM/date),
    // namun kita tegaskan di sini (urut `_date`, fallback `_hm`) agar chart
    // selalu konsisten apa pun urutan masuknya.
    var samples = chronologicalSamples(unit.samples);
    var labels = samples.map(function (s) {
      // [REVISI] Sumbu-X = SMR/Meter (hm_unit) agar konsepnya sama dgn VHMS.
      var meter = (s.hm_unit !== null && s.hm_unit !== undefined) ? s.hm_unit
                : ((s._hm !== null && s._hm !== undefined) ? s._hm : (s.hm_oil));
      return (meter !== null && meter !== undefined) ? fmt(meter, 0) : '-';
    });
    var dates = samples.map(function (s) { return s._dateStr || ''; });

    buildLineChart('sos-chart-wear', labels, dates, clusters.wear.series, samples);
    buildLineChart('sos-chart-oil', labels, dates, clusters.oil.series, samples);
    buildMixedChart('sos-chart-clean', labels, dates, clusters.clean.series, samples);
    // [REVISI #5] Cluster D: Partikel Kontaminasi (Water & Fuel) — line chart.
    if (clusters.contamination) {
      buildLineChart('sos-chart-contamination', labels, dates, clusters.contamination.series, samples);
    }
  }

  /**
   * [REVISI #4] Kembalikan salinan sampel terurut KRONOLOGIS (lama -> baru).
   * Prioritas kunci: `_date` (ms) lalu `_hm` (hour meter). Sampel tanpa kedua
   * kunci ditempatkan di depan agar tidak mengacak urutan relatif lainnya.
   * @param {array} samples
   * @returns {array}
   */
  function chronologicalSamples(samples) {
    return (samples || []).slice().sort(function (a, b) {
      var da = a._date ? a._date.getTime() : 0;
      var db = b._date ? b._date.getTime() : 0;
      if (da !== db) return da - db;
      return (a._hm || 0) - (b._hm || 0);
    });
  }

  /**
   * Bangun baris TOMBOL legend kustom di atas chart.
   * Setiap tombol mengaktifkan/menonaktifkan satu dataset (series) pada chart.
   * @param {string} legendId   id elemen kontainer legend
   * @param {object} chart      instance Chart.js
   */
  function buildLegendButtons(legendId, chart) {
    var box = document.getElementById(legendId);
    if (!box) return;
    var datasets = chart.data.datasets || [];
    if (!datasets.length) { box.innerHTML = ''; return; }

    box.innerHTML = datasets.map(function (ds, i) {
      var color = ds.borderColor || ds.backgroundColor || '#94a3b8';
      // Bar (mis. PQI) -> swatch kotak, Line -> swatch garis
      var isBar = ds.type === 'bar';
      return '<button type="button" class="chart-legend-btn' + (ds.hidden ? '' : ' active') + '"' +
        ' data-sos-legend="' + esc(chart.canvas.id) + '" data-ds-index="' + i + '"' +
        ' style="--legend-color:' + color + '" title="Klik untuk ' + (ds.hidden ? 'menampilkan' : 'menyembunyikan') + ' ' + esc(ds.label) + '">' +
        '<span class="swatch' + (isBar ? ' square' : '') + '"></span>' + esc(ds.label) + '</button>';
    }).join('');

    // Delegasi klik: toggle dataset terkait.
    box.onclick = function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.chart-legend-btn') : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute('data-ds-index'), 10);
      var ds = chart.data.datasets[idx];
      if (!ds) return;
      ds.hidden = !ds.hidden;
      chart.update();
      btn.classList.toggle('active', !ds.hidden);
      btn.title = 'Klik untuk ' + (ds.hidden ? 'menampilkan' : 'menyembunyikan') + ' ' + ds.label;
    };
  }

  function buildLineChart(canvasId, labels, dates, seriesDefs, samples) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var datasets = [];
    seriesDefs.forEach(function (sd) {
      var pm = cfg.PARAMS[sd.key];
      if (!pm) return;
      var data = samples.map(function (s) { return s[sd.key]; });
      if (data.every(function (v) { return v === null || v === undefined; })) return;
      datasets.push({
        label: pm.label + (pm.unit ? ' (' + pm.unit + ')' : ''),
        data: data,
        borderColor: sd.color,
        backgroundColor: sd.color + '22',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: false,
        yAxisID: sd.yAxis === 'right' ? 'y1' : 'y',
      });
    });

    var hasRight = datasets.some(function (d) { return d.yAxisID === 'y1'; });
    var scales = {
      x: {
        ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        grid: { color: '#1e293b' },
        title: { display: true, text: 'SMR / HM (jam)', color: '#64748b', font: { size: 11 } }
      },
      y: { position: 'left', ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#1e293b' } },
    };
    if (hasRight) {
      scales.y1 = { position: 'right', ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { drawOnChartArea: false } };
    }

    charts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        // [REVISI #2] Tooltip fleksibel: cukup arahkan kursor ke area vertikal
        // (tak perlu tepat di titik data).
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(2,6,23,.95)', borderColor: '#334155', borderWidth: 1,
            callbacks: {
              // [REVISI] Judul tooltip = SMR (Meter) + TANGGAL.
              title: function (items) {
                if (!items || !items.length) return '';
                var i = items[0].dataIndex;
                var smr = labels[i] || '-';
                var d = (dates && dates[i]) ? dates[i] : '';
                return (d ? d + '  \u2022  ' : '') + 'SMR ' + smr + ' jam';
              }
            }
          }
        },
        scales: scales,
      }
    });

    buildLegendButtons('sos-legend-' + clusterIdFromCanvas(canvasId), charts[canvasId]);
  }

  function buildMixedChart(canvasId, labels, dates, seriesDefs, samples) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var datasets = [];
    seriesDefs.forEach(function (sd) {
      var pm = cfg.PARAMS[sd.key];
      if (!pm) return;
      var data = samples.map(function (s) { return s[sd.key]; });
      if (data.every(function (v) { return v === null || v === undefined; })) return;
      var ds = {
        label: pm.label + (pm.unit ? ' (' + pm.unit + ')' : ''),
        data: data,
        borderColor: sd.color,
        backgroundColor: sd.color + (sd.type === 'bar' ? '66' : '22'),
        borderWidth: sd.type === 'bar' ? 0 : 2,
        pointRadius: sd.type === 'bar' ? 0 : 3,
        tension: 0.3,
        fill: false,
        type: sd.type || 'line',
        yAxisID: sd.yAxis === 'right' ? 'y1' : 'y',
      };
      datasets.push(ds);
    });

    charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        // [REVISI #2] Tooltip fleksibel (mode index, tanpa intersect).
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(2,6,23,.95)', borderColor: '#334155', borderWidth: 1,
            callbacks: {
              // [REVISI] Judul tooltip = SMR (Meter) + TANGGAL.
              title: function (items) {
                if (!items || !items.length) return '';
                var i = items[0].dataIndex;
                var smr = labels[i] || '-';
                var d = (dates && dates[i]) ? dates[i] : '';
                return (d ? d + '  \u2022  ' : '') + 'SMR ' + smr + ' jam';
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
            grid: { color: '#1e293b' },
            title: { display: true, text: 'SMR / HM (jam)', color: '#64748b', font: { size: 11 } }
          },
          y: { position: 'left', ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
          y1: { position: 'right', ticks: { color: '#94a3b8' }, grid: { drawOnChartArea: false } },
        }
      }
    });

    buildLegendButtons('sos-legend-' + clusterIdFromCanvas(canvasId), charts[canvasId]);
  }

  /** Ambil id cluster dari id canvas, mis. "sos-chart-wear" -> "wear". */
  function clusterIdFromCanvas(canvasId) {
    return String(canvasId || '').replace(/^sos-chart-/, '');
  }

  /* -----------------------------------------------------------------------
   * Diagnostics Panel
   * --------------------------------------------------------------------- */
  function renderDiagnostics(unit) {
    var el = document.getElementById('sos-diagnostics');
    if (!el) return;
    var diag = unit.diagnostics;
    var tier = unit.mprs.tier;
    var borderColor = cfg.TIER_COLORS[tier];

    var html = '<div class="panel" style="border-left:4px solid ' + borderColor + '">' +
      '<h3 style="font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:10px">' +
      '<i class="fa-solid fa-screwdriver-wrench" style="color:#38bdf8"></i> Predictive Diagnostics — ' +
      cfg.TIER_LABELS[tier] + '</h3>';

    if (diag.length === 0) {
      html += '<p style="font-size:12px;color:var(--emerald)"><i class="fa-solid fa-circle-check"></i> Tidak ada anomali terdeteksi pada sampel terakhir.</p>';
    } else {
      diag.forEach(function (d) {
        html += '<div style="background:var(--card-2);border-radius:8px;padding:12px;margin-bottom:8px">' +
          '<p style="font-size:12px;font-weight:700;color:var(--red)"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(d.title) + '</p>' +
          '<p style="font-size:11px;color:var(--text-dim);margin:4px 0">Sistem: ' + esc(d.system) + '</p>' +
          '<p style="font-size:11px;color:var(--text-mute)">Risiko: ' + esc(d.risk) + '</p>' +
          '<p style="font-size:11px;color:var(--cyan);margin-top:6px"><i class="fa-solid fa-wrench"></i> ' + esc(d.action) + '</p>' +
          '</div>';
      });
    }

    // Interpretation text
    var latest = unit.latest;
    if (latest.interp_text || latest.translated_interp) {
      html += '<div style="margin-top:12px;padding:10px;background:var(--card-2);border-radius:8px">' +
        '<p style="font-size:11px;font-weight:600;color:var(--text-dim)"><i class="fa-solid fa-comment-dots"></i> Lab Interpretation</p>' +
        '<p style="font-size:11px;color:var(--text-mute);margin-top:4px">' + esc(latest.translated_interp || latest.interp_text) + '</p></div>';
    }

    // ROW & Dirt Entry summary
    html += '<div style="display:flex;gap:12px;margin-top:12px;flex-wrap:wrap">';
    if (latest.row_fe_100 !== null) {
      html += '<div class="chip">ROW Fe/100h: <strong>' + fmt(latest.row_fe_100, 1) + ' ppm</strong></div>';
    }
    html += '<div class="chip">Dirt Entry (Si+Al): <strong>' + fmt(latest.dirt_entry_index, 0) + ' ppm</strong></div>';
    if (latest.dirt_entry_index > 15 && latest.row_fe_100 > 20) {
      html += '<div class="chip" style="background:var(--red)22;color:var(--red);border-color:var(--red)"><i class="fa-solid fa-triangle-exclamation"></i> High Dirt Entry!</div>';
    }
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * Sample History Table
   * --------------------------------------------------------------------- */
  /**
   * [REVISI #11] State filter untuk form "Historical SOS Samples".
   * Memudahkan pengguna menyaring/mengurutkan riwayat sampel sesuai kebutuhan
   * (mis. hanya sampel CRITICAL, atau rentang tanggal tertentu).
   */
  var sampleTableState = { tier: 'ALL', from: '', to: '', search: '', sortKey: '_date', sortDir: 'desc' };

  /** Unit aktif untuk tabel sampel (dipakai saat filter berubah / re-render). */
  var _sampleTableUnit = null;

  function renderSampleTable(unit) {
    var el = document.getElementById('sos-sample-table');
    if (!el) return;

    var allCount = unit.samples.length;

    // [REVISI #11] Toolbar filter (status/tier, rentang tanggal, pencarian).
    var toolbar =
      '<div class="table-toolbar" style="margin-bottom:10px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<select id="sos-st-filter-tier" title="Filter status/tier">' +
            '<option value="ALL">Semua Status</option>' +
            '<option value="EXTREME">Extreme</option>' +
            '<option value="CRITICAL">Critical</option>' +
            '<option value="MONITOR">Monitor</option>' +
            '<option value="NORMAL">Normal</option>' +
          '</select>' +
          '<input type="date" id="sos-st-from" title="Dari tanggal" style="width:150px">' +
          '<span style="color:var(--text-mute);font-size:11px">s/d</span>' +
          '<input type="date" id="sos-st-to" title="Sampai tanggal" style="width:150px">' +
          '<input type="search" id="sos-st-search" placeholder="Cari ISO / tanggal..." style="width:180px">' +
          '<button class="btn btn-ghost btn-sm" id="sos-st-reset"><i class="fa-solid fa-xmark"></i> Reset</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-mute)" id="sos-st-count"></div>' +
      '</div>';

    // Hitung baris terfilter + simpan unit di cache untuk re-render.
    _sampleTableUnit = unit;
    var rows = applySampleTableFilter(unit.samples);

    var html = '<div class="panel"><h3 style="font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:10px">' +
      '<i class="fa-solid fa-table-list" style="color:var(--sky)"></i> Historical SOS Samples (' + allCount + ')</h3>' +
      toolbar +
      '<div class="table-scroll"><table class="data"><thead><tr>' +
      // [REVISI] Header kolom sejajar dgn isi (td): kolom teks/kiri tanpa class,
      // kolom angka/status diberi class="center" agar rata tengah seperti td.
      '<th data-st-sort="_date">Tanggal</th>' +
      '<th class="center" data-st-sort="hm_unit">HM Unit</th>' +
      '<th class="center" data-st-sort="hm_oil">HM Oil</th>' +
      '<th class="center" data-st-sort="risk_tier">Status</th>' +
      '<th class="center" data-st-sort="wear_fe">Fe</th>' +
      '<th class="center" data-st-sort="wear_cu">Cu</th>' +
      '<th class="center" data-st-sort="wear_al">Al</th>' +
      '<th class="center" data-st-sort="wear_si">Si</th>' +
      '<th class="center" data-st-sort="wear_cr">Cr</th>' +
      '<th class="center" data-st-sort="wear_pb">Pb</th>' +
      '<th class="center" data-st-sort="visc_v100">V100</th>' +
      '<th class="center" data-st-sort="water_pct">Water%</th>' +
      '<th class="center" data-st-sort="fuel_pct">Fuel%</th>' +
      '<th class="center" data-st-sort="pqi">PQI</th>' +
      '<th class="center">ISO</th>' +
      '</tr></thead><tbody>';

    if (!rows.length) {
      html += '<tr><td colspan="15" style="text-align:center;padding:24px;color:#64748b">Tidak ada sampel yang cocok dengan filter.</td></tr>';
    } else {
      rows.forEach(function (s) {
        var bgStyle = s.risk_tier >= 3 ? 'background:rgba(153,27,27,0.15)' :
                      s.risk_tier >= 2 ? 'background:rgba(239,68,68,0.1)' :
                      s.risk_tier >= 1 ? 'background:rgba(234,179,8,0.08)' : '';
        html += '<tr style="' + bgStyle + '">' +
          '<td>' + (s._dateStr || '—') + '</td>' +
          '<td class="center">' + fmt(s.hm_unit, 0) + '</td>' +
          '<td class="center">' + fmt(s.hm_oil, 0) + '</td>' +
          '<td class="center">' + tierBadge(s.risk_tier) + '</td>' +
          '<td class="center">' + fmt(s.wear_fe, 1) + '</td>' +
          '<td class="center">' + fmt(s.wear_cu, 1) + '</td>' +
          '<td class="center">' + fmt(s.wear_al, 1) + '</td>' +
          '<td class="center">' + fmt(s.wear_si, 1) + '</td>' +
          '<td class="center">' + fmt(s.wear_cr, 1) + '</td>' +
          '<td class="center">' + fmt(s.wear_pb, 1) + '</td>' +
          '<td class="center">' + fmt(s.visc_v100, 2) + '</td>' +
          '<td class="center">' + fmt(s.water_pct, 2) + '</td>' +
          '<td class="center">' + fmt(s.fuel_pct, 2) + '</td>' +
          '<td class="center">' + fmt(s.pqi, 0) + '</td>' +
          '<td class="center">' + (s.iso_code || '—') + '</td></tr>';
      });
    }

    html += '</tbody></table></div></div>';
    el.innerHTML = html;

    // Pulihkan nilai kontrol dari state lalu pasang event.
    var tSel = document.getElementById('sos-st-filter-tier');
    var fromEl = document.getElementById('sos-st-from');
    var toEl = document.getElementById('sos-st-to');
    var searchEl = document.getElementById('sos-st-search');
    var resetBtn = document.getElementById('sos-st-reset');
    if (tSel) tSel.value = sampleTableState.tier;
    if (fromEl) fromEl.value = sampleTableState.from;
    if (toEl) toEl.value = sampleTableState.to;
    if (searchEl) searchEl.value = sampleTableState.search;
    if (tSel) tSel.addEventListener('change', function () { sampleTableState.tier = tSel.value; renderSampleTable(_sampleTableUnit); });
    if (fromEl) fromEl.addEventListener('change', function () { sampleTableState.from = fromEl.value; renderSampleTable(_sampleTableUnit); });
    if (toEl) toEl.addEventListener('change', function () { sampleTableState.to = toEl.value; renderSampleTable(_sampleTableUnit); });
    if (searchEl) searchEl.addEventListener('input', function () { sampleTableState.search = searchEl.value; renderSampleTable(_sampleTableUnit); });
    if (resetBtn) resetBtn.addEventListener('click', function () {
      sampleTableState = { tier: 'ALL', from: '', to: '', search: '', sortKey: '_date', sortDir: 'desc' };
      renderSampleTable(_sampleTableUnit);
    });
    // Sortir via klik header.
    el.querySelectorAll('th[data-st-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-st-sort');
        sampleTableState.sortDir = (sampleTableState.sortKey === k && sampleTableState.sortDir === 'desc') ? 'asc' : 'desc';
        sampleTableState.sortKey = k;
        renderSampleTable(_sampleTableUnit);
      });
    });
    updateSampleTableCount(allCount, rows.length);
  }

  /** [REVISI #11] Saring + urutkan sampel sesuai state filter. */
  function applySampleTableFilter(samples) {
    var st = sampleTableState;
    var tierMap = { 'NORMAL': 0, 'MONITOR': 1, 'CRITICAL': 2, 'EXTREME': 3 };
    var fromMs = st.from ? new Date(st.from + 'T00:00:00').getTime() : null;
    var toMs = st.to ? new Date(st.to + 'T23:59:59').getTime() : null;
    var q = (st.search || '').trim().toLowerCase();

    var out = (samples || []).filter(function (s) {
      if (st.tier !== 'ALL' && tierMap[st.tier] !== undefined) {
        if ((s.risk_tier || 0) !== tierMap[st.tier]) return false;
      }
      if (fromMs !== null || toMs !== null) {
        var t = s._date ? s._date.getTime() : null;
        if (t === null) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      if (q) {
        var hay = ((s._dateStr || '') + ' ' + (s.iso_code || '') + ' ' + (s.lab_no || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var key = st.sortKey, dir = st.sortDir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var va, vb;
      if (key === '_date') { va = a._date ? a._date.getTime() : 0; vb = b._date ? b._date.getTime() : 0; }
      else { va = Number(a[key]); vb = Number(b[key]); if (isNaN(va)) va = -Infinity; if (isNaN(vb)) vb = -Infinity; }
      return va < vb ? -dir : (va > vb ? dir : 0);
    });
    return out;
  }

  /** Tampilkan jumlah baris terfilter pada toolbar. */
  function updateSampleTableCount(total, shown) {
    var el = document.getElementById('sos-st-count');
    if (el) el.textContent = shown + ' dari ' + total + ' sampel ditampilkan';
  }

  /* -----------------------------------------------------------------------
   * SOS Heatmap — severity matrix (baris=kompartemen, kolom=parameter)
   * --------------------------------------------------------------------- */
  // Parameter yang ditampilkan pada heatmap (subset relevan lintas kompartemen)
  var HEATMAP_PARAMS = [
    { key: 'wear_fe',  label: 'Fe' },
    { key: 'wear_cu',  label: 'Cu' },
    { key: 'wear_al',  label: 'Al' },
    { key: 'wear_cr',  label: 'Cr' },
    { key: 'wear_pb',  label: 'Pb' },
    { key: 'wear_si',  label: 'Si' },
    { key: 'pqi',      label: 'PQI' },
    { key: 'visc_v100',label: 'V100' },
    { key: 'tbn',      label: 'TBN' },
    { key: 'water_pct',label: 'H2O' },
    { key: 'fuel_pct', label: 'Fuel' },
    { key: 'soot',     label: 'Soot' },
  ];

  /** Kelas warna sel heatmap dari status ('NORMAL'|'MONITOR'|'CRITICAL'|'EXTREME'). */
  function tierClass(label) {
    var map = { 'NORMAL': 'hm-normal', 'MONITOR': 'hm-warning', 'CRITICAL': 'hm-critical', 'EXTREME': 'hm-critical' };
    return map[label] || 'hm-na';
  }

  function renderHeatmap() {
    var head = document.getElementById('sos-heatmap-head');
    var body = document.getElementById('sos-heatmap-body');
    if (!head || !body) return;

    var units = store.getAllUnits();

    // Header: Kompartemen | Fe | Cu | ... | MPRS
    // (Lebar kolom mengikuti isi tabel; header parameter hanya diberi
    //  lebar minimum agar otomatis sejajar dengan kolom datanya.)
    var thHtml = '<tr><th class="th-label" style="position:sticky;left:0;z-index:2;background:#0f172a">Kompartemen</th>';
    HEATMAP_PARAMS.forEach(function (p) {
      thHtml += '<th class="center th-param" title="' + esc(p.label) + '">' +
        '<span class="th-param-txt">' + esc(p.label) + '</span></th>';
    });
    thHtml += '<th class="center">MPRS</th></tr>';
    head.innerHTML = thHtml;

    if (!units.length) {
      body.innerHTML = '<tr><td colspan="' + (HEATMAP_PARAMS.length + 2) + '" style="text-align:center;padding:30px;color:var(--text-mute)">Belum ada data SOS.</td></tr>';
      return;
    }

    // Urutkan: tier tertinggi dulu
    units = units.slice().sort(function (a, b) {
      var da = (b.mprs.tier || 0) - (a.mprs.tier || 0);
      if (da !== 0) return da;
      return (b.criticality.score || 0) - (a.criticality.score || 0);
    });

    var html = '';
    units.forEach(function (u) {
      var th = cfg.getThresholdsFor(u.component);
      var latest = u.latest;
      var label = u.assetId + ' — ' + u.component;
      var tierColor = cfg.TIER_COLORS[u.mprs.tier] || '#22c55e';

      html += '<tr data-sos-heat-unit="' + esc(u.assetId) + '" data-sos-heat-comp="' + esc(u.component) + '" style="cursor:pointer">';
      html += '<td class="hm-label" style="position:sticky;left:0;z-index:1;background:#0f172a">' +
        '<span class="badge" style="font-size:8px;padding:1px 5px;margin-right:4px;background:' + tierColor + '22;color:' + tierColor + '">' +
        cfg.TIER_LABELS[u.mprs.tier].charAt(0) + '</span>' + esc(label) + '</td>';

      HEATMAP_PARAMS.forEach(function (p) {
        var t = th[p.key];
        var v = latest[p.key];
        if (!t || v === null || v === undefined) {
          html += '<td class="center hm-cell hm-na">—</td>';
          return;
        }
        var sev = global.SOS_ANALYTICS.severityScore(v, t, p.key);
        var st = sev >= 4 ? 'EXTREME' : sev >= 2 ? 'CRITICAL' : sev >= 1 ? 'MONITOR' : 'NORMAL';
        var meta = cfg.PARAMS[p.key];
        html += '<td class="center hm-cell ' + tierClass(st) + '" title="' + esc(meta.label) + ': ' + fmt(v, meta.decimals) + '">' +
          fmt(v, meta.decimals) + '</td>';
      });

      html += '<td class="center"><strong>' + fmt(u.mprs.mprs, 1) + '</strong></td>';
      html += '</tr>';
    });

    body.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * SOS Perbandingan — overlay tren parameter antar kompartemen (maks 5)
   * --------------------------------------------------------------------- */
  var COMPARE_COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#22c55e', '#ef4444'];
  var COMPARE_SELECTS = ['sos-comp-unit1', 'sos-comp-unit2', 'sos-comp-unit3', 'sos-comp-unit4', 'sos-comp-unit5'];

  /** Isi opsi dropdown kompartemen untuk perbandingan. */
  function fillCompareOptions() {
    var units = store.getAllUnits();
    var sels = COMPARE_SELECTS.map(function (id) { return document.getElementById(id); });
    if (!sels[0] || !sels[1]) return;

    function opts(includeNone) {
      var h = includeNone ? '<option value="">— Tidak ada —</option>' : '';
      units.forEach(function (u, i) {
        var val = u.assetId + '||' + u.component;
        h += '<option value="' + esc(val) + '" data-idx="' + i + '">' + esc(u.assetId + ' — ' + u.component) + '</option>';
      });
      return h;
    }

    var prev = sels.map(function (s) { return s ? s.value : ''; });
    sels.forEach(function (sel, i) {
      if (!sel) return;
      sel.innerHTML = opts(i >= 2);   // kompartemen ke-3/4/5 boleh kosong
    });

    // Pertahankan pilihan sebelumnya bila masih ada; jika tidak, pakai default dua pertama
    var values = units.map(function (u) { return u.assetId + '||' + u.component; });
    sels.forEach(function (sel, i) {
      if (!sel) return;
      if (i < 2) sel.value = values.indexOf(prev[i]) !== -1 ? prev[i] : (values[i] || values[0] || '');
      else sel.value = values.indexOf(prev[i]) !== -1 ? prev[i] : '';
    });
  }

  function renderComparison() {
    fillCompareOptions();

    var paramSel = document.getElementById('sos-comp-param');
    var canvas = document.getElementById('sos-comparison-chart');
    if (!paramSel || !canvas) return;

    var paramKey = paramSel.value;
    var meta = cfg.PARAMS[paramKey] || { label: paramKey, decimals: 1, unit: '' };

    // Kumpulkan kompartemen yang dipilih (unik, maks 5)
    var picks = [];
    COMPARE_SELECTS.forEach(function (id) {
      var v = (document.getElementById(id) || {}).value;
      if (v && picks.indexOf(v) === -1) picks.push(v);
    });

    var datasets = [];
    var pickedUnits = [];
    picks.forEach(function (val, i) {
      var parts = val.split('||');
      var unit = store.getUnit(parts[0], parts[1]);
      if (!unit) return;
      pickedUnits.push(unit);
      // [REVISI #4] Urutkan kronologis (lama -> baru) agar chart konsisten.
      var us = chronologicalSamples(unit.samples);
      var data = us.map(function (s) { return s[paramKey]; });
      datasets.push({
        label: unit.assetId + ' — ' + unit.component,
        data: data,
        borderColor: COMPARE_COLORS[i % COMPARE_COLORS.length],
        backgroundColor: COMPARE_COLORS[i % COMPARE_COLORS.length] + '22',
        borderWidth: 2, pointRadius: 3, tension: 0.3, fill: false,
      });
      // Label diambil dari kompartemen pertama (sumbu x tanggal/HM)
      if (i === 0) {
        canvas._labels = us.map(function (s) { return s._dateStr || ('HM ' + fmt(s._hm, 0)); });
      }
    });

    if (charts['sos-comparison-chart']) charts['sos-comparison-chart'].destroy();
    charts['sos-comparison-chart'] = new Chart(canvas, {
      type: 'line',
      data: { labels: canvas._labels || [], datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        // [REVISI #2] Tooltip fleksibel (mode index, tanpa intersect).
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#e2e8f0', font: { size: 11 } } },
          title: { display: true, text: meta.label + (meta.unit ? ' (' + meta.unit + ')' : ''), color: '#e2e8f0', font: { size: 13 } },
        },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#1e293b' } },
          y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#1e293b' } },
        }
      }
    });

    renderComparisonSummary(pickedUnits, paramKey);
  }

  /**
   * Ringkasan + kesimpulan level hasil penilaian, diurutkan dari paling
   * CRITICAL ke NORMAL. Menampilkan nilai terakhir/maks, MPRS, tier, tren.
   */
  function renderComparisonSummary(units, paramKey) {
    var box = document.getElementById('sos-comparison-summary');
    if (!box) return;
    if (!units || !units.length) { box.innerHTML = ''; return; }

    // Urutkan dari tier tertinggi lalu criticality tertinggi
    var sorted = units.slice().sort(function (a, b) {
      var dt = (b.mprs.tier || 0) - (a.mprs.tier || 0);
      if (dt !== 0) return dt;
      return (b.criticality.score || 0) - (a.criticality.score || 0);
    });

    var counts = { EXTREME: 0, CRITICAL: 0, MONITOR: 0, NORMAL: 0 };
    sorted.forEach(function (u) {
      var lbl = cfg.TIER_LABELS[u.mprs.tier];
      if (counts[lbl] !== undefined) counts[lbl]++;
    });

    var html = '<div class="panel-head"><div>' +
      '<h2 class="panel-title"><i class="fa-solid fa-clipboard-check" style="color:#22c55e"></i> Ringkasan &amp; Kesimpulan</h2>' +
      '<p class="panel-sub">Penilaian ' + sorted.length + ' kompartemen terpilih — dari paling critical ke normal</p>' +
      '</div></div>';

    // Baris kesimpulan level
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px">';
    [['EXTREME', '#991b1b'], ['CRITICAL', '#ef4444'], ['MONITOR', '#eab308'], ['NORMAL', '#22c55e']].forEach(function (p) {
      var lbl = p[0], col = p[1];
      html += '<span class="chip" style="background:' + col + '22;color:' + col + ';border-color:' + col + '55">' +
        lbl + ': <strong>' + counts[lbl] + '</strong></span>';
    });
    html += '</div>';

    // Tabel ringkasan
    html += '<div class="table-scroll"><table class="data"><thead><tr>' +
      '<th>Kompartemen</th><th class="center">Level</th><th class="center">MPRS</th>' +
      '<th class="center">Criticality</th><th class="center">Fe</th><th class="center">Cu</th>' +
      '<th class="center">Si</th><th class="center">PQI</th><th class="center">Terakhir (HM)</th>' +
      '</tr></thead><tbody>';

    sorted.forEach(function (u) {
      var t = u.mprs.tier;
      var col = cfg.TIER_COLORS[t];
      var s = u.latest;
      html += '<tr style="cursor:pointer" data-sos-unit="' + esc(u.assetId) + '" data-sos-comp="' + esc(u.component) + '">' +
        '<td><strong>' + esc(u.assetId) + '</strong> — ' + esc(u.component) + '</td>' +
        '<td class="center"><span class="badge" style="background:' + col + '22;color:' + col + '">' + cfg.TIER_LABELS[t] + '</span></td>' +
        '<td class="center">' + fmt(u.mprs.mprs, 1) + '</td>' +
        '<td class="center">' + fmt(u.criticality.score, 1) + ' <span style="color:var(--text-mute);font-size:10px">(' + u.criticality.band + ')</span></td>' +
        '<td class="center">' + fmt(s.wear_fe, 1) + '</td>' +
        '<td class="center">' + fmt(s.wear_cu, 1) + '</td>' +
        '<td class="center">' + fmt(s.wear_si, 1) + '</td>' +
        '<td class="center">' + fmt(s.pqi, 0) + '</td>' +
        '<td class="center">' + fmt(s.hm_unit, 0) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';

    // Kesimpulan tekstual
    var most = sorted[0];
    var concl = 'Kompartemen paling perlu perhatian: <strong>' + esc(most.assetId + ' — ' + most.component) +
      '</strong> dengan level <strong style="color:' + cfg.TIER_COLORS[most.mprs.tier] + '">' +
      cfg.TIER_LABELS[most.mprs.tier] + '</strong> (MPRS ' + fmt(most.mprs.mprs, 1) + ').';
    if (counts.EXTREME || counts.CRITICAL) {
      concl += ' Prioritaskan tindakan pada ' + (counts.EXTREME + counts.CRITICAL) + ' kompartemen berisiko tinggi.';
    } else {
      concl += ' Tidak ada kompartemen berisiko tinggi pada perbandingan ini.';
    }
    html += '<p style="font-size:11.5px;color:var(--text-dim);margin-top:12px;padding:10px;background:var(--card-2);border-radius:8px">' +
      '<i class="fa-solid fa-lightbulb" style="color:#fbbf24"></i> ' + concl + '</p>';

    box.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * Model distribution chips
   * --------------------------------------------------------------------- */
  function renderModelChips(stats) {
    var el = document.getElementById('sos-models');
    if (!el) return;
    var html = '';
    Object.keys(stats.models).forEach(function (m) {
      html += '<span class="chip">' + esc(m) + ' <strong>(' + stats.models[m] + ')</strong></span>';
    });
    el.innerHTML = html || '<span class="chip">—</span>';
  }

  /* -----------------------------------------------------------------------
   * View switching
   * --------------------------------------------------------------------- */
  var currentView = 'fleet'; // 'fleet' | 'detail' | 'heatmap' | 'comparison'

  /**
   * Atur visibilitas form upload vs konten SOS.
   * Bila belum ada data  -> hanya form upload yang tampil (halaman awal).
   * Bila sudah ada data  -> form disembunyikan, konten (toolbar/KPI/tabel) tampil.
   */
  function updateUploadVisibility() {
    var wrap = document.getElementById('sos-upload-wrap');
    var content = document.getElementById('sos-content');
    var hasData = store.count() > 0;
    if (wrap) wrap.classList.toggle('hidden', hasData);
    if (content) content.classList.toggle('hidden', !hasData);
  }

  function showView(view) {
    currentView = view;
    toggle('sos-fleet-panel', view === 'fleet');
    toggle('sos-detail-panel', view === 'detail');
    toggle('sos-heatmap-panel', view === 'heatmap');
    toggle('sos-comparison-panel', view === 'comparison');

    // [HEADER] Semua view SELAIN detail menampilkan header netral (brand).
    // Detail diisi oleh renderAssetDetail() -> renderHeader(unit).
    if (view !== 'detail') {
      if (global.VHMS_RENDER && global.VHMS_RENDER.resetHeader) {
        try { global.VHMS_RENDER.resetHeader(); } catch (e) {}
      }
    }

    if (view === 'fleet') {
      updateUploadVisibility();
      if (store.count() > 0) {
        var stats = store.getFleetStats();
        renderKPI(stats);
        renderModelChips(stats);
        renderFleetTable();
      }
    } else if (view === 'heatmap') {
      renderHeatmap();
    } else if (view === 'comparison') {
      renderComparison();
    }
  }

  function toggle(id, show) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !show);
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_RENDER = {
    renderKPI: renderKPI,
    renderFleetTable: renderFleetTable,
    renderAssetDetail: renderAssetDetail,
    renderHeader: renderHeader,
    renderHeatmap: renderHeatmap,
    renderComparison: renderComparison,
    renderModelChips: renderModelChips,
    showView: showView,
    updateUploadVisibility: updateUploadVisibility,
    getFleetState: function () { return fleetState; },
    setFleetState: function (s) { for (var k in s) fleetState[k] = s[k]; },
    fmt: fmt,
    esc: esc,
    tierBadge: tierBadge,
  };

})(typeof window !== 'undefined' ? window : globalThis);

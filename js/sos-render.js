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

  // [FIX 2026-10-04] Debounce agar pencarian tabel sampel tidak re-render tiap
  // ketikan (gap dari POST-6: search historis sebelumnya belum di-debounce).
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  /* -----------------------------------------------------------------------
   * Utilitas format
   * [KONSOLIDASI 2026-10-04] Delegasi ke UI_UTIL (satu definisi bersama).
   * --------------------------------------------------------------------- */
  var _ui = global.UI_UTIL || {};

  function fmt(v, d) {
    return _ui.fmt ? _ui.fmt(v, d) : _fmtLocal(v, d);
  }
  function esc(s) {
    return _ui.esc ? _ui.esc(s) : _escLocal(s);
  }
  /** Set teks sebuah elemen berdasarkan id (null-safe). */
  function setText(id, txt) {
    if (_ui.setText) { _ui.setText(id, txt); return; }
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  /* Fallback lokal (bila UI_UTIL belum termuat). */
  function _fmtLocal(v, d) {
    if (v === null || v === undefined) return '—';
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function _escLocal(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tierBadge(tier) {
    var labels = cfg.TIER_LABELS;
    var colors = cfg.TIER_COLORS || ['#e2e8f0','#eab308','#f97316','#ef4444'];
    var t = tier || 0;
    var col = colors[t] || colors[0];
    // Normal (putih) diberi sedikit border agar terbaca di tema gelap.
    var border = (t === 0) ? 'border:1px solid rgba(226,232,240,.35);' : '';
    return '<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700;' +
      border + 'background:' + col + '22;color:' + col + '">' + labels[t] + '</span>';
  }
  /* -----------------------------------------------------------------------
   * KPI Cards
   * --------------------------------------------------------------------- */
  function renderKPI(stats) {
    var el = document.getElementById('sos-kpi-grid');
    if (!el) return;
    var nAssets = Object.keys(stats.uniqueAssets).length;
    // [STANDARISASI 2026-10-03] 3 level: Normal / Caution / Critical
    var t = stats.tiers;
    var total = (t[0] + t[1] + t[2]) || 1;
    el.innerHTML =
      kpiCard('fa-flask', 'Total Sampel', fmt(stats.totalSamples, 0), 'sky', '') +
      kpiCard('fa-truck-monster', 'Unit Unik', fmt(nAssets, 0), 'cyan', '') +
      kpiCard('fa-circle-check', 'Normal', fmt(t[0], 0), 'emerald', fmt((t[0] / total) * 100, 0) + '% unit') +
      kpiCard('fa-triangle-exclamation', 'Caution', fmt(t[1], 0), 'amber', fmt((t[1] / total) * 100, 0) + '% unit') +
      kpiCard('fa-skull-crossbones', 'Critical', fmt(t[2], 0), 'red', fmt((t[2] / total) * 100, 0) + '% unit');
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
   * Pewarnaan nilai parameter berdasarkan threshold kompartemen.
   * [KONSOLIDASI 2026-10-05] Satu helper bersama (dulu ter-duplikasi di
   * renderFleetTable + renderCompareSummary). Mengembalikan string style CSS
   * untuk nilai di atas `warn`/`crit`/`extreme`, atau sisi rendah untuk
   * parameter dual-threshold (mis. visc_v100 warn_low/crit_low).
   * Nilai normal -> '' (mewarisi warna default tabel).
   * --------------------------------------------------------------------- */
  function paramColorStyle(v, pk, component, model) {
    if (v === null || v === undefined || isNaN(v)) return '';
    var th = cfg.getThresholdsFor(component, model);
    if (!th || !th[pk]) return '';
    var t = th[pk];
    if (t.extreme   !== undefined && v >= t.extreme)   return 'color:#f87171;font-weight:700';
    if (t.crit      !== undefined && v >= t.crit)      return 'color:#fb923c;font-weight:700';
    if (t.crit_high !== undefined && v >= t.crit_high) return 'color:#fb923c;font-weight:700';
    if (t.crit_low  !== undefined && v <= t.crit_low)  return 'color:#fb923c;font-weight:700';
    if (t.warn      !== undefined && v >= t.warn)      return 'color:#facc15;font-weight:600';
    if (t.warn_high !== undefined && v >= t.warn_high) return 'color:#facc15;font-weight:600';
    if (t.warn_low  !== undefined && v <= t.warn_low)  return 'color:#facc15;font-weight:600';
    return '';
  }

  /* -----------------------------------------------------------------------
   * Fleet Table (sorted, filtered)
   * --------------------------------------------------------------------- */
  // Default: urutkan menurut Peringkat (skor pelanggaran threshold tertinggi
  // di atas → paling critical paling atas). Tier: NORMAL=0..EXTREME=3.
  // valueMode: sumber nilai kolom parameter (last | avg | worst).
  var fleetState = { sortKey: 'rank', sortDir: 'desc', filter: 'ALL', section: 'ALL', search: '', valueMode: 'last', page: 1, pageSize: 100 };

  // Parameter yang ditampilkan di kolom katalog + presisi desimalnya.
  // [REVISI 2026-09-30] Urutan kolom: Na | Fe | Cu | Si | Al | PQI | V100.
  // [FIX 2026-10-05] Pb disisipkan di kiri PQI -> Na|Fe|Cu|Si|Al|Pb|PQI|V100.
  var FLEET_PARAMS = [
    { key: 'additive_na', d: 0 },
    { key: 'wear_fe', d: 1 }, { key: 'wear_cu', d: 1 },
    { key: 'wear_si', d: 1 }, { key: 'wear_al', d: 1 },
    { key: 'wear_pb', d: 1 },
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

  // [STANDARISASI 2026-10-03] Prioritas P1..P3 (makin besar = makin critical).
  var SEV_RANK = { 'NORMAL': 1, 'CAUTION': 2, 'CRITICAL': 3 };

  /**
   * Komparator prioritas tabel SOS.
   * Urutan kunci (makin besar = makin diprioritaskan di atas):
   *   1) tier (CRITICAL > CAUTION > NORMAL)
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

  /** Teks badge prioritas P1..P3 untuk tabel SOS. */
  function sevBadgeText(u) {
    var key = (cfg.TIER_KEYS || [])[u.mprs.tier] || 'NORMAL';
    return 'P' + (SEV_RANK[key] || 1);
  }
  /** Kunci tier internal (NORMAL/CAUTION/CRITICAL) untuk CSS class. */
  function tierKey(tier) {
    return (cfg.TIER_KEYS || [])[tier || 0] || 'NORMAL';
  }

  /**
   * [FITUR 2026-10-06] Section unit (dari data Lifetime/Unit DB).
   * Nomor lambung diresolusi dari assetId/SN via PORTFOLIO_STORE.
   * @returns {string} nama section ('' bila tidak ada).
   */
  function sectionForUnit(u) {
    var ps = global.PORTFOLIO_STORE;
    if (!ps || !ps.getSection || !u) return '';
    try {
      var lambung = (ps.resolveLambung && ps.resolveLambung(u.assetId, u.serial)) || u.assetId;
      return ps.getSection(lambung) || '';
    } catch (e) { return ''; }
  }

  /**
   * [FITUR 2026-10-06] Umur komponen (%) untuk sebuah unit dari data Lifetime.
   * Pencocokan nama kompartemen sadar-sinonim via PORTFOLIO_STORE.
   * @returns {number|null} lifePct (null bila tidak ada data).
   */
  function lifePctForUnit(u) {
    var ps = global.PORTFOLIO_STORE;
    if (!ps || !ps.lifetimeSummary || !u) return null;
    try {
      var lambung = (ps.resolveLambung && ps.resolveLambung(u.assetId, u.serial)) || u.assetId;
      var lt = ps.lifetimeSummary(lambung, u.component);
      return (lt && typeof lt.lifePct === 'number') ? lt.lifePct : null;
    } catch (e) { return null; }
  }

  /**
   * [FITUR 2026-10-06] Isi opsi dropdown SECTION di baris filter SOS.
   * Sumber: PORTFOLIO_STORE.sectionList() (dari data Lifetime/Unit DB).
   * Menjaga nilai terpilih bila masih ada; fallback ke 'ALL'.
   */
  function refreshSectionOptions() {
    var sel = document.getElementById('sos-fleet-section');
    if (!sel) return;
    var ps = global.PORTFOLIO_STORE;
    var list = (ps && ps.sectionList) ? ps.sectionList() : [];
    var cur = fleetState.section || 'ALL';
    var html = '<option value="ALL">Semua Section</option>';
    var found = false;
    list.forEach(function (s) {
      if (!s || !s.name) return;
      if (s.name === cur) found = true;
      html += '<option value="' + esc(s.name) + '">' + esc(s.name) + ' (' + s.count + ')</option>';
    });
    sel.innerHTML = html;
    sel.value = found ? cur : 'ALL';
    if (!found) fleetState.section = 'ALL';
  }

  /** Badge Life Time (%) — warna bertingkat agar cepat dibaca. */
  function lifePctBadge(u) {
    var v = lifePctForUnit(u);
    if (v === null || v === undefined || isNaN(v)) {
      return '<span style="color:var(--text-dim)" title="Tidak ada data Lifetime untuk kompartemen ini">&mdash;</span>';
    }
    var style = 'font-weight:600';
    var tip = 'Umur komponen ' + fmt(v, 2) + '% dari data Lifetime';
    if (v >= 100) style += ';color:#f87171';        // melewati budget → critical
    else if (v >= 80) style += ';color:#fb923c';    // mendekati batas
    else if (v >= 60) style += ';color:#facc15';    // perhatian
    return '<span style="' + style + '" title="' + esc(tip) + '">' + fmt(v, 2) + '%</span>';
  }

  function renderFleetTable() {
    var tbody = document.getElementById('sos-fleet-body');
    var countEl = document.getElementById('sos-fleet-count');
    if (!tbody) return;

    // Pastikan dropdown Section selalu sinkron dengan data Lifetime terkini.
    refreshSectionOptions();

    var units = store.getAllUnits();

    // Filter
    if (fleetState.filter !== 'ALL') {
      var tierMap = { 'NORMAL': 0, 'CAUTION': 1, 'CRITICAL': 2 };
      var ft = tierMap[cfg.normalizeTierKey ? cfg.normalizeTierKey(fleetState.filter) : fleetState.filter];
      if (ft !== undefined) units = units.filter(function (u) { return u.mprs.tier === ft; });
    }
    if (fleetState.search) {
      var q = fleetState.search.toLowerCase();
      units = units.filter(function (u) {
        return (u.assetId + ' ' + u.component + ' ' + u.model + ' ' + u.serial + ' ' + u.jobsite).toLowerCase().indexOf(q) !== -1;
      });
    }
    // [FITUR 2026-10-06] Filter SECTION (dropdown di baris filter). Section
    // diambil dari data Lifetime (SN/Nomor Lambung/Section). Nilai '' = unit
    // tanpa section; hanya lolos bila 'ALL' dipilih.
    if (fleetState.section && fleetState.section !== 'ALL') {
      var wantSec = fleetState.section;
      units = units.filter(function (u) { return sectionForUnit(u) === wantSec; });
    }

    // Sort
    var sk = fleetState.sortKey;
    var dir = fleetState.sortDir === 'asc' ? 1 : -1;
    // Helper ambil nilai kolom parameter sesuai valueMode (agar sortir kolom
    // Fe/Cu/Si/Al/Na/PQI/V100 konsisten dengan nilai yang DITAMPILKAN).
    function cellVal(u, pk) {
      var th, v;
      if (pk === 'pqi' || pk === 'visc_v100' || pk === 'additive_na' ||
          pk === 'wear_fe' || pk === 'wear_cu' || pk === 'wear_si' || pk === 'wear_al' ||
          pk === 'wear_pb') {
        var dv = displayedValues(u);
        v = dv.map ? dv.map[pk] : u.latest[pk];
      } else {
        v = u.latest[pk];
      }
      return v;
    }
    units.sort(function (a, b) {
      var va, vb;
      if (sk === 'rank') {
        // Peringkat: skor lebih besar = lebih critical. Default desc.
        va = a.rankScore || 0; vb = b.rankScore || 0;
      }
      else if (sk === 'severity') { return compareSeverity(a, b); }
      else if (sk === 'tier') { va = a.mprs.tier; vb = b.mprs.tier; }
      else if (sk === 'score') { va = a.criticality.score; vb = b.criticality.score; }
      else if (sk === 'hmUnit') { va = a.hmUnit || 0; vb = b.hmUnit || 0; }
      else if (sk === 'hmOil') { va = a.hmOil || 0; vb = b.hmOil || 0; }
      else if (sk === 'lifetime') {
        va = lifePctForUnit(a); vb = lifePctForUnit(b);
        // Nilai null selalu di bawah.
        var lna = (va === null || va === undefined || isNaN(va));
        var lnb = (vb === null || vb === undefined || isNaN(vb));
        if (lna && lnb) return 0;
        if (lna) return 1;
        if (lnb) return -1;
      }
      else if (sk === 'lastDate') {
        var da = a.latest && a.latest._date ? a.latest._date.getTime() : 0;
        var db = b.latest && b.latest._date ? b.latest._date.getTime() : 0;
        va = da; vb = db;
      }
      else if (['wear_fe','wear_cu','wear_si','wear_al','wear_pb','additive_na','pqi','visc_v100'].indexOf(sk) !== -1) {
        va = cellVal(a, sk); vb = cellVal(b, sk);
        // Nilai null selalu di bawah.
        var na = (va === null || va === undefined || isNaN(va));
        var nb = (vb === null || vb === undefined || isNaN(vb));
        if (na && nb) return 0;
        if (na) return 1;
        if (nb) return -1;
      }
      else { va = (a[sk] || '').toString().toLowerCase(); vb = (b[sk] || '').toString().toLowerCase(); }
      if (va < vb) return -dir; if (va > vb) return dir; return 0;
    });

    if (countEl) countEl.textContent = units.length + ' kompartemen dari ' + store.count() + ' sampel';

    var mode = fleetState.valueMode || 'last';
    var modeTag = mode === 'avg' ? ' <span style="font-size:11px;color:var(--text-mute)">avg</span>'
                : (mode === 'worst' ? ' <span style="font-size:11px;color:#f87171">worst</span>' : '');

    // [BARU] Nomor Peringkat 1..N: urutkan salinan berdasarkan rankScore DESC
    // (skor lebih besar = lebih parah) lalu beri nomor 1 = paling critical.
    // Nomor ini INDEPENDEN dari urutan tampil tabel (yang mengikuti sort kolom),
    // sehingga Peringkat tetap bermakna sebagai identitas unit.
    var rankByKey = {};
    units.slice().sort(function (a, b) { return (b.rankScore || 0) - (a.rankScore || 0); })
      .forEach(function (u, i) { rankByKey[u.assetId + '||' + u.component] = i + 1; });

    // [FIX 2026-10-04] Paginasi tabel fleet SOS. Sebelumnya fungsi ini
    // memanggil renderFleetPager(tbody, totalRows, page, pageCount) dengan
    // variabel `totalRows`/`page`/`pageCount` yang TIDAK PERNAH didefinisikan
    // -> ReferenceError yang menggagalkan seluruh render tabel fleet SOS.
    // Kini baris dipotong per halaman (default 100) seperti tabel VHMS.
    var totalRows = units.length;
    var pageSize = fleetState.pageSize || 100;
    var pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    var page = Math.min(Math.max(1, fleetState.page || 1), pageCount);
    fleetState.page = page;
    var pageUnits = units.slice((page - 1) * pageSize, page * pageSize);

    var html = '';
    pageUnits.forEach(function (u) {
      var dv = displayedValues(u);
      var s = u.latest;
      var valColor = function (v, pk) { return paramColorStyle(v, pk, u.component, u.model); };
      // Ambil nilai tampil: dari window stats bila mode avg/worst, else latest.
      var val = function (pk) { return dv.map ? dv.map[pk] : s[pk]; };
      var na = val('additive_na');
      var fe = val('wear_fe'), cu = val('wear_cu'), si = val('wear_si'), al = val('wear_al');
      var pb = val('wear_pb');
      var pqi = val('pqi'), v100 = val('visc_v100');
      var rank = rankByKey[u.assetId + '||' + u.component] || '—';
      var rankKey = tierKey(u.mprs.tier);

      html += '<tr style="cursor:pointer" data-sos-unit="' + esc(u.assetId) + '" data-sos-comp="' + esc(u.component) + '">' +
        '<td class="center"><span class="sev-badge sev-' + rankKey + '" title="Peringkat SOS — makin kecil = makin critical (dari pelanggaran threshold pada sampel terbaru)">' + rank + '</span></td>' +
        '<td><strong>' + esc(u.assetId) + '</strong></td>' +
        '<td>' + esc(u.model) + '</td>' +
        '<td>' + tierBadge(u.mprs.tier) + '</td>' +
        '<td>' + esc(u.component) + clcBadge(u) + '</td>' +
        '<td class="center">' + lifePctBadge(u) + '</td>' +
        '<td class="center">' + fmt(u.hmUnit, 0) + '</td>' +
        '<td class="center">' + fmt(u.hmOil, 0) + '</td>' +
        '<td class="center" style="' + valColor(na, 'additive_na') + '">' + fmt(na, 0) + '</td>' +
        '<td class="center" style="' + valColor(fe, 'wear_fe') + '">' + fmt(fe, 1) + '</td>' +
        '<td class="center" style="' + valColor(cu, 'wear_cu') + '">' + fmt(cu, 1) + '</td>' +
        '<td class="center" style="' + valColor(si, 'wear_si') + '">' + fmt(si, 1) + '</td>' +
        '<td class="center" style="' + valColor(al, 'wear_al') + '">' + fmt(al, 1) + '</td>' +
        '<td class="center" style="' + valColor(pb, 'wear_pb') + '">' + fmt(pb, 1) + '</td>' +
        '<td class="center" style="' + valColor(pqi, 'pqi') + '">' + fmt(pqi, 0) + '</td>' +
        '<td class="center" style="' + valColor(v100, 'visc_v100') + '">' + fmt(v100, (cfg.PARAMS.visc_v100 && cfg.PARAMS.visc_v100.decimals !== undefined ? cfg.PARAMS.visc_v100.decimals : 1)) + '</td>' +
        '<td class="center" title="' + esc(dv.dateHint || 'Tanggal sampel terbaru') + '">' + esc(dv.date || u.lastDate || '—') + '</td>' +
        '<td class="center" style="white-space:nowrap">' +
          '<button class="btn btn-primary btn-sm" data-sos-detail="' + esc(u.assetId) + '|' + esc(u.component) + '">' +
            '<i class="fa-solid fa-chart-line"></i> Detail</button> ' +
          '<button class="btn btn-ghost btn-sm" data-sos-print="' + esc(u.assetId) + '|' + esc(u.component) + '" ' +
            'title="Cetak portofolio unit & kompartemen ini" style="border:1px solid #38bdf8;color:#38bdf8">' +
            '<i class="fa-solid fa-print"></i> Print</button>' +
        '</td>' +
        '</tr>';
    });

    tbody.innerHTML = html || '<tr><td colspan="18" style="text-align:center;padding:30px;color:var(--text-mute)">Belum ada data SOS. Upload file CSV lab report.</td></tr>';

    renderFleetPager(tbody, totalRows, page, pageCount);

    // Update filter counts
    updateFilterCounts();
  }

  /** [POST-5 2026-10-03] Kontrol paginasi tabel SOS fleet. */
  function renderFleetPager(tbody, total, page, pageCount) {
    var pager = document.getElementById('sos-fleet-pager');
    if (!pager) {
      var scroller = tbody && tbody.closest ? tbody.closest('.table-scroll') : null;
      if (!scroller || !scroller.parentNode) return;
      pager = document.createElement('div');
      pager.id = 'sos-fleet-pager';
      pager.className = 'table-pager';
      scroller.parentNode.insertBefore(pager, scroller.nextSibling);
    }
    if (pageCount <= 1) { pager.innerHTML = '<span class="tp-info">' + total + ' baris</span>'; return; }
    var btns = '';
    function btn(p, label, disabled, active) {
      return '<button class="tp-btn' + (active ? ' is-active' : '') + '" data-sos-page="' + p + '"' +
        (disabled ? ' disabled' : '') + '>' + label + '</button>';
    }
    var startP = Math.max(1, page - 2), endP = Math.min(pageCount, startP + 4);
    startP = Math.max(1, endP - 4);
    btns += btn(1, '«', page === 1);
    btns += btn(page - 1, '‹', page === 1);
    for (var p = startP; p <= endP; p++) btns += btn(p, String(p), false, p === page);
    btns += btn(page + 1, '›', page === pageCount);
    btns += btn(pageCount, '»', page === pageCount);
    pager.innerHTML = '<span class="tp-info">Baris ' + (((page - 1) * (fleetState.pageSize || 100)) + 1) +
      '–' + Math.min(page * (fleetState.pageSize || 100), total) + ' dari ' + total + '</span>' + btns;
  }

  function updateFilterCounts() {
    var units = store.getAllUnits();
    // Kunci internal tier tetap dipakai untuk pencocokan chip filter.
    var keys = cfg.TIER_KEYS || ['NORMAL','CAUTION','CRITICAL'];
    var counts = { ALL: units.length };
    keys.forEach(function (k) { counts[k] = 0; });
    units.forEach(function (u) {
      var key = keys[u.mprs.tier];
      if (key && counts[key] !== undefined) counts[key]++;
    });
    ['ALL'].concat(keys).forEach(function (k) {
      var el = document.querySelector('#sos-filter-bar .fc-count[data-count="' + k + '"]');
      if (el) el.textContent = counts[k];
    });
  }

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-05] Ekspor tabel "SOS Kompartemen List" ke Excel (CSV).
   * ---------------------------------------------------------------------
   * Menghasilkan CSV (pemisah `;`, BOM UTF-8) berisi SELURUH kompartemen —
   * TANPA menghiraukan filter/pencarian yang sedang aktif (sesuai permintaan).
   * Susunan kolom & nilai SAMA dengan tabel di layar (memakai `displayedValues`
   * sesuai mode "Nilai parameter": last/avg/worst). Urutan mengikuti Peringkat
   * (rankScore DESC) = paling critical di atas.
   * @returns {{ csv:string, filename:string, rows:number }}
   */
  function buildFleetCsv() {
    var CSV = global.CSV_UTIL || {};
    var csvEscape = CSV.csvEscape || function (v) {
      if (v === null || v === undefined) return '';
      var s = String(v);
      return (s.indexOf(';') !== -1 || s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1)
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // Nilai numerik ditulis apa adanya agar Excel mengenalinya sebagai angka
    // (bukan string ber-locale). Desimal pakai titik.
    function num(v, d) {
      if (v === null || v === undefined || isNaN(v)) return '';
      return Number(v).toFixed(d);
    }

    var units = store.getAllUnits();
    // Urutkan menurut peringkat criticality (rankScore DESC) — konsisten
    // dengan arti kolom "Peringkat" di tabel.
    units = units.slice().sort(function (a, b) { return (b.rankScore || 0) - (a.rankScore || 0); });

    var header = [
      'Peringkat', 'Asset ID', 'Model', 'Status', 'Kompartemen',
      'Lifetime Comp (%)', 'HM Unit', 'HM Oil',
      'Na (ppm)', 'Fe (ppm)', 'Cu (ppm)', 'Si (ppm)', 'Al (ppm)', 'Pb (ppm)',
      'PQI', 'V100 (cSt)', 'Tanggal'
    ];

    var lines = [header.map(csvEscape).join(';')];
    units.forEach(function (u, i) {
      var dv = displayedValues(u);
      var s = u.latest || {};
      var val = function (pk) { return dv.map ? dv.map[pk] : s[pk]; };
      var tierName = (cfg.TIER_LABELS && cfg.TIER_LABELS[u.mprs.tier]) ||
        ((cfg.TIER_KEYS || [])[u.mprs.tier]) || 'NORMAL';
      var lifeV = lifePctForUnit(u);
      var row = [
        i + 1,
        u.assetId, u.model, tierName, u.component,
        (lifeV === null || lifeV === undefined || isNaN(lifeV)) ? '' : Number(lifeV).toFixed(2),
        num(u.hmUnit, 0), num(u.hmOil, 0),
        num(val('additive_na'), 0),
        num(val('wear_fe'), 1), num(val('wear_cu'), 1), num(val('wear_si'), 1),
        num(val('wear_al'), 1), num(val('wear_pb'), 1),
        num(val('pqi'), 0),
        num(val('visc_v100'), (cfg.PARAMS && cfg.PARAMS.visc_v100 && cfg.PARAMS.visc_v100.decimals !== undefined) ? cfg.PARAMS.visc_v100.decimals : 1),
        dv.date || u.lastDate || ''
      ];
      lines.push(row.map(csvEscape).join(';'));
    });

    // BOM agar Excel (ID) membaca UTF-8 dengan benar.
    var csv = '\uFEFF' + lines.join('\r\n');
    var fname = 'SOS Kompartemen List_' + _stamp() + '.csv';
    return { csv: csv, filename: fname, rows: units.length };
  }

  /** Stempel tanggal-waktu untuk nama berkas: YYYYMMDD-HHMM. */
  function _stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /** Ekspor tabel SOS Kompartemen List ke berkas CSV/Excel. */
  function exportFleetCsv() {
    if (store.count() === 0) {
      if (global.VHMS_APP && global.VHMS_APP.toast) global.VHMS_APP.toast('Belum ada data SOS untuk diekspor.', 'err');
      return false;
    }
    var out = buildFleetCsv();
    var blob = new Blob([out.csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = out.filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    if (global.VHMS_APP && global.VHMS_APP.toast) {
      global.VHMS_APP.toast('Export Data: ' + out.rows + ' kompartemen \u2192 ' + out.filename, 'ok');
    }
    return true;
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
  /**
   * [PENAMAAN LAPORAN 2026-10-03] Format nama file default saat cetak / simpan SOS:
   * # Result Oil Analysis_[Compartment]_[Caution/Critical]_[No Lambung]_Follow Up [SLA]
   */
  function getSOSReportFileName(unit) {
    if (!unit) {
      if (currentDetailUnit) {
        unit = store.getUnit(currentDetailUnit.assetId, currentDetailUnit.component);
      }
      if (!unit && store.count() > 0) {
        var ranked = store.getRankedUnits();
        if (ranked && ranked.length) {
          unit = store.getUnit(ranked[0].assetId, ranked[0].component);
        }
      }
    }
    if (!unit) return '# Result Oil Analysis';

    // 1. Compartment
    var comp = (unit.component || 'Compartment').replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 2. No Lambung
    var lambung = '';
    if (global.PORTFOLIO_STORE && global.PORTFOLIO_STORE.resolveLambung && unit.assetId) {
      lambung = global.PORTFOLIO_STORE.resolveLambung(unit.assetId, unit.serial);
    }
    if (!lambung && unit.assetId) lambung = unit.assetId;
    if (!lambung) lambung = 'Unit';
    lambung = String(lambung).replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 3. Status Caution / Critical / Normal berdasarkan threshold terlampaui
    var hasCrit = false;
    var hasCaution = false;
    var scfg = global.SOS_CONFIG;
    var latest = unit.latest || {};
    var th = (scfg && scfg.getThresholdsFor) ? scfg.getThresholdsFor(unit.component, unit.model) : {};

    if (th && latest) {
      Object.keys(th).forEach(function (pk) {
        var v = latest[pk];
        if (v === null || v === undefined) return;
        var t = th[pk];
        if (!t) return;
        var val = Number(v);
        if (isNaN(val)) return;

        // Cek low-limit / dual threshold (viskositas / TBN)
        if (t.warn_low !== undefined || t.crit_low !== undefined || t.warn_high !== undefined || t.crit_high !== undefined) {
          if (typeof t.crit_low === 'number' && val <= t.crit_low) hasCrit = true;
          if (typeof t.crit_high === 'number' && val >= t.crit_high) hasCrit = true;
          if (typeof t.warn_low === 'number' && val <= t.warn_low) hasCaution = true;
          if (typeof t.warn_high === 'number' && val >= t.warn_high) hasCaution = true;
        } else if (t.mode === 'low') {
          var cl = typeof t.crit_low === 'number' ? t.crit_low : t.crit;
          var wl = typeof t.warn_low === 'number' ? t.warn_low : t.warn;
          if (typeof cl === 'number' && val <= cl) hasCrit = true;
          if (typeof wl === 'number' && val <= wl) hasCaution = true;
        } else {
          if (typeof t.extreme === 'number' && val >= t.extreme) hasCrit = true;
          if (typeof t.crit === 'number' && val >= t.crit) hasCrit = true;
          if (typeof t.warn === 'number' && val >= t.warn) hasCaution = true;
        }
      });
    }

    // [STANDARISASI 2026-10-03] tier 2 = Critical, tier 1 = Caution
    if (!hasCrit && unit.mprs && unit.mprs.tier >= 2) hasCrit = true;
    if (!hasCrit && !hasCaution && unit.mprs && unit.mprs.tier === 1) hasCaution = true;

    var status = hasCrit ? 'Critical' : (hasCaution ? 'Caution' : 'Normal');

    // 4. SLA merefer ke threshold
    var vcfg = global.VHMS_CONFIG;
    var fup = (vcfg && vcfg.FOLLOWUP_STATUS) || {};
    var sla = '1x24 Jam';
    if (status === 'Critical') {
      sla = (fup.CRITICAL && fup.CRITICAL.sla) || '1x24 Jam';
    } else if (status === 'Caution') {
      // [STANDARISASI 2026-10-03] CAUTION kini benar 2x24 Jam di config.
      sla = (fup.CAUTION && fup.CAUTION.sla) || '2x24 Jam';
    } else {
      sla = (fup.NORMAL && fup.NORMAL.sla) || '-';
    }

    return '# Result Oil Analysis_' + comp + '_' + status + '_' + lambung + '_Follow Up ' + sla;
  }

  function renderHeader(unit) {
    if (!unit) return;
    var header = document.querySelector('.app-header');
    if (header) header.classList.remove('header-compact');

    // Judul statis "Result Oil Analysis" pada #machine-model (brand disembunyikan).
    var brandEl = document.getElementById('machine-brand');
    var modelEl = document.getElementById('machine-model');
    if (brandEl) brandEl.style.display = 'none';
    if (modelEl) {
      modelEl.style.display = '';
      modelEl.textContent = 'Result Oil Analysis';
    }

    // Set document.title default untuk Cetak / Ekspor Laporan
    try {
      document.title = getSOSReportFileName(unit);
    } catch (e) { if (global.console && console.warn) console.warn('[SOS_RENDER] gagal set document.title:', e && e.message); }

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
      rulEl.className = 'v ' + (band === 'CRITICAL' ? 'warn' : (band === 'CAUTION' || band === 'WARNING' ? '' : 'ok'));
    }
    // Waktu sampel terakhir dipakai sebagai "Telemetri Terakhir".
    var tw = document.getElementById('header-time-wrap');
    if (tw && unit.lastDate) { tw.style.display = ''; setText('header-time', unit.lastDate); }

    // Baris unit aktif (dipakai di tampilan VHMS) — samakan bila ada.
    setText('unit-bar-serial', (unit.assetId || '—') + ' — ' + (unit.component || ''));
    var ub = document.getElementById('unit-bar-badge');
    if (ub) {
      ub.textContent = cfg.TIER_LABELS[unit.mprs.tier] || '—';
      // [STANDARISASI 2026-10-03] tier 2 = Critical, tier 1 = Caution.
      ub.className = 'badge ' + (unit.mprs.tier >= 2 ? 'CRITICAL' : (unit.mprs.tier === 1 ? 'CAUTION' : 'NORMAL'));
    }

    // [FIX 2026-10-05] Footer mengikuti unit SOS yang dibuka (sebelumnya
    // footer hanya pernah diisi mode VHMS lalu nyangkut di semua mode).
    if (global.APP_HEADER && global.APP_HEADER.setFooterSos) {
      global.APP_HEADER.setFooterSos(unit);
    }
  }

  /* -----------------------------------------------------------------------
   * Asset Detail — 3 Cluster Charts
   * --------------------------------------------------------------------- */
  function renderAssetDetail(assetId, component) {
    currentDetailUnit = { assetId: assetId, component: component };
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
        '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;flex-wrap:wrap;gap:12px">' +
          '<div>' +
            '<h2 class="panel-title" style="font-size:17px"><i class="fa-solid fa-chart-line" style="color:#38bdf8"></i> Detail Analisis Sampel SOS</h2>' +
            '<p class="panel-sub">Grafik tren parameter, diagnostik anomali &amp; riwayat pengujian</p>' +
          '</div>' +
          '<button class="btn btn-ghost btn-sm" id="sos-btn-back-fleet">' +
            '<i class="fa-solid fa-arrow-left"></i> Kembali ke Daftar' +
          '</button>' +
        '</div>';
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
    //
    // [CLC §7.4] Bila opsi "tampilkan sampel terpotong (redup)" aktif, sertakan
    // sampel yang dipotong dari sumber MENTAH (store.getAllSamplesFor) dengan
    // penanda `_clcCutDim` — HANYA untuk tampilan, tidak memengaruhi analitik.
    var samples = chronologicalSamples(displaySamples(unit));
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
   * [CLC §7.4] Sampel untuk DITAMPILKAN pada chart/tabel.
   * - Opsi "tampilkan terpotong" NONAKTIF: kembalikan `unit.samples` (hanya lolos).
   * - AKTIF: gabungkan sampel yang dipotong (dari sumber mentah) dan tandai
   *   `_clcCutDim = true` agar dirender redup. Tidak pernah menyentuh analitik.
   * @param {object} unit unit analitik (punya assetId/component/samples)
   * @returns {object[]}
   */
  function displaySamples(unit) {
    var clc = global.COMPONENT_LIFE;
    if (!clc || !clc.isEnabled() || !clc.isShowCut || !clc.isShowCut()) return unit.samples;
    var all = (store && store.getAllSamplesFor) ? store.getAllSamplesFor(unit.assetId, unit.component) : [];
    if (!all.length) return unit.samples;
    // Tandai cut + pastikan tidak menggandakan sampel yang sudah ada (lolos).
    var passedKeys = {};
    (unit.samples || []).forEach(function (s) { passedKeys[sampleKeyOf(s)] = true; });
    var merged = (unit.samples || []).slice();
    all.forEach(function (s) {
      if (s._clc && s._clc.cut && !passedKeys[sampleKeyOf(s)]) {
        s._clcCutDim = true;
        merged.push(s);
      }
    });
    return merged;
  }

  /** Kunci identitas ringan sampel (untuk cegah duplikat tampilan). */
  function sampleKeyOf(s) {
    return String(s.lab_no || '') + '|' + (s.hm_unit != null ? s.hm_unit : '') + '|' +
      (s._date ? s._date.getTime() : '');
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
        tension: 0.3,
        fill: false,
        yAxisID: sd.yAxis === 'right' ? 'y1' : 'y',
        // [CLC §7.4] Sampel terpotong dirender redup (radius kecil, warna suram,
        // titik berlubang) agar terlihat "di luar perhitungan".
        pointRadius: samples.map(function (s) { return s._clcCutDim ? 2 : 3; }),
        pointStyle: samples.map(function (s) { return s._clcCutDim ? 'crossRot' : 'circle'; }),
        pointBackgroundColor: samples.map(function (s) { return s._clcCutDim ? 'transparent' : sd.color; }),
        pointBorderColor: samples.map(function (s) { return s._clcCutDim ? '#64748b' : sd.color; }),
        pointBorderWidth: samples.map(function (s) { return s._clcCutDim ? 1 : 1; }),
        // Garis putus-putus pada segmen yang menyentuh titik terpotong.
        segment: {
          borderDash: function (ctx) {
            var i = ctx.p0 ? ctx.p0.dataIndex : 0;
            var j = ctx.p1 ? ctx.p1.dataIndex : 0;
            var dim = (samples[i] && samples[i]._clcCutDim) || (samples[j] && samples[j]._clcCutDim);
            return dim ? [5, 4] : undefined;
          },
          borderColor: function (ctx) {
            var i = ctx.p0 ? ctx.p0.dataIndex : 0;
            var j = ctx.p1 ? ctx.p1.dataIndex : 0;
            var dim = (samples[i] && samples[i]._clcCutDim) || (samples[j] && samples[j]._clcCutDim);
            return dim ? '#475569' : undefined;
          }
        }
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
      // [CLC §7.4] Redupkan titik terpotong (khusus seri garis).
      if (sd.type !== 'bar') {
        ds.pointRadius = samples.map(function (s) { return s._clcCutDim ? 2 : 3; });
        ds.pointStyle = samples.map(function (s) { return s._clcCutDim ? 'crossRot' : 'circle'; });
        ds.pointBackgroundColor = samples.map(function (s) { return s._clcCutDim ? 'transparent' : sd.color; });
        ds.pointBorderColor = samples.map(function (s) { return s._clcCutDim ? '#64748b' : sd.color; });
        ds.segment = {
          borderDash: function (ctx) {
            var i = ctx.p0 ? ctx.p0.dataIndex : 0;
            var j = ctx.p1 ? ctx.p1.dataIndex : 0;
            var dim = (samples[i] && samples[i]._clcCutDim) || (samples[j] && samples[j]._clcCutDim);
            return dim ? [5, 4] : undefined;
          }
        };
      }
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

    // [CLC §7.4] Sertakan sampel terpotong bila opsi tampil-redup aktif.
    var display = displaySamples(unit);
    var allCount = display.length;
    var dimCount = display.filter(function (s) { return s._clcCutDim; }).length;

    // [REVISI #11] Toolbar filter (status/tier, rentang tanggal, pencarian).
    var toolbar =
      '<div class="table-toolbar" style="margin-bottom:10px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<select id="sos-st-filter-tier" title="Filter status/tier">' +
            '<option value="ALL">Semua Status</option>' +
            '<option value="CRITICAL">Critical</option>' +
            '<option value="CAUTION">Caution</option>' +
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
    // [FIX 2026-10-05] Pewarnaan sel parameter per threshold kompartemen unit.
    var pc = function (v, pk) { return paramColorStyle(v, pk, unit.component, unit.model); };
    var rows = applySampleTableFilter(display);

    var html = '<div class="panel"><h3 style="font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:10px">' +
      '<i class="fa-solid fa-table-list" style="color:var(--sky)"></i> Historical SOS Samples (' + allCount + ')' +
      (dimCount ? ' <span class="u-text-mute" style="font-size:11px;font-weight:400">· ' + dimCount + ' terpotong (redup, di luar hitungan)</span>' : '') +
      '</h3>' +
      toolbar +
      '<div class="table-scroll"><table class="data"><thead><tr>' +
      // [REVISI] Header kolom sejajar dgn isi (td): kolom teks/kiri tanpa class,
      // kolom angka/status diberi class="center" agar rata tengah seperti td.
      '<th scope="col" data-st-sort="_date">Tanggal</th>' +
      '<th scope="col" class="center" data-st-sort="hm_unit">HM Unit</th>' +
      '<th scope="col" class="center" data-st-sort="hm_oil">HM Oil</th>' +
      '<th scope="col" class="center" data-st-sort="risk_tier">Status</th>' +
      '<th scope="col" class="center" data-st-sort="wear_fe">Fe</th>' +
      '<th scope="col" class="center" data-st-sort="wear_cu">Cu</th>' +
      '<th scope="col" class="center" data-st-sort="wear_al">Al</th>' +
      '<th scope="col" class="center" data-st-sort="wear_si">Si</th>' +
      '<th scope="col" class="center" data-st-sort="wear_cr">Cr</th>' +
      '<th scope="col" class="center" data-st-sort="wear_pb">Pb</th>' +
      '<th scope="col" class="center" data-st-sort="additive_na">Na</th>' +
      '<th scope="col" class="center" data-st-sort="visc_v100">V100</th>' +
      '<th scope="col" class="center" data-st-sort="water_pct">Water%</th>' +
      '<th scope="col" class="center" data-st-sort="fuel_pct">Fuel%</th>' +
      '<th scope="col" class="center" data-st-sort="pqi">PQI</th>' +
      '<th scope="col" class="center">ISO</th>' +
      '</tr></thead><tbody>';

    if (!rows.length) {
      html += '<tr><td colspan="16" style="text-align:center;padding:24px;color:var(--text-mute)">Tidak ada sampel yang cocok dengan filter.</td></tr>';
    } else {
      rows.forEach(function (s) {
        var isDim = !!s._clcCutDim;
        var bgStyle = isDim ? 'background:rgba(100,116,139,0.10)' :
                      s.risk_tier >= 3 ? 'background:rgba(153,27,27,0.15)' :
                      s.risk_tier >= 2 ? 'background:rgba(239,68,68,0.1)' :
                      s.risk_tier >= 1 ? 'background:rgba(234,179,8,0.08)' : '';
        var dimStyle = isDim ? 'opacity:.55;font-style:italic' : '';
        var cutBadge = isDim
          ? ' <span class="u-text-mute" style="font-size:10px;white-space:nowrap" title="' + esc(s._clc && s._clc.reason ? s._clc.reason : 'Sampel sebelum pemasangan komponen terakhir — tidak ikut perhitungan') + '"><i class="fa-solid fa-scissors"></i> cut</span>'
          : '';
        html += '<tr style="' + bgStyle + dimStyle + '">' +
          '<td>' + (s._dateStr || '—') + cutBadge + '</td>' +
          '<td class="center">' + fmt(s.hm_unit, 0) + '</td>' +
          '<td class="center">' + fmt(s.hm_oil, 0) + '</td>' +
          '<td class="center">' + tierBadge(s.risk_tier) + '</td>' +
          '<td class="center" style="' + pc(s.wear_fe, 'wear_fe') + '">' + fmt(s.wear_fe, 1) + '</td>' +
          '<td class="center" style="' + pc(s.wear_cu, 'wear_cu') + '">' + fmt(s.wear_cu, 1) + '</td>' +
          '<td class="center" style="' + pc(s.wear_al, 'wear_al') + '">' + fmt(s.wear_al, 1) + '</td>' +
          '<td class="center" style="' + pc(s.wear_si, 'wear_si') + '">' + fmt(s.wear_si, 1) + '</td>' +
          '<td class="center" style="' + pc(s.wear_cr, 'wear_cr') + '">' + fmt(s.wear_cr, 1) + '</td>' +
          '<td class="center" style="' + pc(s.wear_pb, 'wear_pb') + '">' + fmt(s.wear_pb, 1) + '</td>' +
          '<td class="center" style="' + pc(s.additive_na, 'additive_na') + '">' + fmt(s.additive_na, 0) + '</td>' +
          '<td class="center" style="' + pc(s.visc_v100, 'visc_v100') + '">' + fmt(s.visc_v100, 2) + '</td>' +
          '<td class="center" style="' + pc(s.water_pct, 'water_pct') + '">' + fmt(s.water_pct, 2) + '</td>' +
          '<td class="center" style="' + pc(s.fuel_pct, 'fuel_pct') + '">' + fmt(s.fuel_pct, 2) + '</td>' +
          '<td class="center" style="' + pc(s.pqi, 'pqi') + '">' + fmt(s.pqi, 0) + '</td>' +
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
    if (searchEl) searchEl.addEventListener('input', debounce(function () { sampleTableState.search = searchEl.value; renderSampleTable(_sampleTableUnit); }, 200));
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
    var tierMap = { 'NORMAL': 0, 'CAUTION': 1, 'CRITICAL': 2 };
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
  // [FIX 2026-10-01] Tambah 6 param yang kini punya threshold + evaluasi:
  // wear_sn, wear_ni (minor metals), visc_v40, oxidation, nitration, sulfation.
  // Tanpa ini, breach ke-6 param tsb TIDAK terlihat di heatmap.
  var HEATMAP_PARAMS = [
    { key: 'wear_fe',  label: 'Fe' },
    { key: 'wear_cu',  label: 'Cu' },
    { key: 'wear_al',  label: 'Al' },
    { key: 'wear_cr',  label: 'Cr' },
    { key: 'wear_pb',  label: 'Pb' },
    { key: 'wear_si',  label: 'Si' },
    { key: 'wear_sn',  label: 'Sn' },
    { key: 'wear_ni',  label: 'Ni' },
    { key: 'additive_na', label: 'Na' },
    { key: 'pqi',      label: 'PQI' },
    { key: 'visc_v100',label: 'V100' },
    { key: 'visc_v40', label: 'V40' },
    { key: 'tbn',      label: 'TBN' },
    { key: 'water_pct',label: 'H2O' },
    { key: 'fuel_pct', label: 'Fuel' },
    { key: 'soot',     label: 'Soot' },
    { key: 'oxidation',label: 'OXI' },
    { key: 'nitration',label: 'NIT' },
    { key: 'sulfation',label: 'SUL' },
  ];

  // [BARU] State sortir heatmap SOS (default: MPRS/prioritas tertinggi di atas).
  var heatmapState = { sortKey: 'sort', sortDir: 'desc' };

  // [REVISI 2026-10-03] Filter kompartemen pada heatmap SOS (dropdown + search).
  var heatmapCompFilter = '';   // '' = semua; selain itu = "assetId||component"

  /** Isi opsi dropdown filter kompartemen heatmap SOS dari daftar unit. */
  function fillHeatmapFilter() {
    var input = document.getElementById('sos-heatmap-filter');
    if (!input || !global.SEARCHABLE_SELECT) return;
    if (!input._ssel) {
      input._ssel = global.SEARCHABLE_SELECT.create(input, {
        allLabel: 'Semua Kompartemen',
        placeholder: 'Cari / pilih kompartemen...',
        onChange: function (val) {
          heatmapCompFilter = val || '';
          renderHeatmap();
        }
      });
    }
    var units = store.getAllUnits();
    // Dedupe kompartemen (assetId + component) sambil pertahankan label unik.
    var seen = {};
    var opts = [];
    units.forEach(function (u) {
      var val = u.assetId + '||' + u.component;
      if (seen[val]) return;
      seen[val] = true;
      opts.push({ value: val, label: u.assetId + ' — ' + u.component });
    });
    opts.sort(function (a, b) { return a.label.localeCompare(b.label); });
    input._ssel.setOptions(opts);
    // Bila filter lama tidak ada lagi, kembalikan ke "Semua".
    if (heatmapCompFilter && !seen[heatmapCompFilter]) {
      heatmapCompFilter = '';
      input._ssel.setValue('');
    }
  }

  // [BARU] State sortir tabel ringkasan Perbandingan (default: ranking 1 teratas).
  var compareSummaryState = { key: 'rank', dir: 'asc' };
  var _lastCompareUnits = null, _lastCompareParam = null;

  /** Set/ubah state sortir heatmap + render ulang. */
  function setHeatmapSort(key, dir) { heatmapState.sortKey = key; heatmapState.sortDir = dir; }

  /** Kelas warna sel heatmap dari status ('NORMAL'|'CAUTION'|'CRITICAL'). */
  function tierClass(label) {
    // [STANDARISASI 2026-10-03] 3 level; kunci lama dinormalisasi.
    var key = cfg.normalizeTierKey ? cfg.normalizeTierKey(label) : label;
    var map = { 'NORMAL': 'hm-normal', 'CAUTION': 'hm-caution', 'CRITICAL': 'hm-critical' };
    return map[key] || 'hm-na';
  }

  function renderHeatmap() {
    var head = document.getElementById('sos-heatmap-head');
    var body = document.getElementById('sos-heatmap-body');
    if (!head || !body) return;

    // Siapkan dropdown filter kompartemen (idempoten).
    fillHeatmapFilter();

    var units = store.getAllUnits();

    // [REVISI 2026-10-03] Terapkan filter kompartemen bila dipilih.
    if (heatmapCompFilter) {
      units = units.filter(function (u) {
        return (u.assetId + '||' + u.component) === heatmapCompFilter;
      });
    }

    // Header: Kompartemen | Fe | Cu | ... | MPRS (klik untuk sortir)
    var sortMark = function (key) {
      if (heatmapState.sortKey !== key) return '';
      return heatmapState.sortDir === 'asc' ? ' ▲' : ' ▼';
    };
    // [FIX 2026-10-04] Sticky & urutan lapis kolom label TIDAK boleh ditulis
    // inline di sini. Inline mengalahkan CSS, sehingga header pojok kalah
    // lapis terhadap sel label baris dan teks kompartemen menembus header
    // parameter saat tabel di-scroll. Lihat css/vhms-dashboard.css.
    var thHtml = '<tr><th scope="col" class="th-label u-pointer" data-heat-sort="label" title="Urutkan berdasarkan kompartemen">Kompartemen' + sortMark('label') + '</th>';
    // [REVISI 2026-10-03] Header mengikuti KONSEP TABEL LABEL: struktur
    // dua-baris + garis aksen kiri berwarna per kategori (cluster).
    //   baris 1 : simbol singkat (Fe, Cu, ...) — tebal, berwarna kategori
    //   baris 2 : nama lengkap elemen (Iron, Copper, ...) — kecil, muted
    // Warna kategori: wear=merah, oil=cyan, clean=violet, additive=hijau.
    var CLUSTER_COLORS = { wear: '#ef4444', oil: '#38bdf8', clean: '#a78bfa', additive: '#10b981' };
    HEATMAP_PARAMS.forEach(function (p) {
      var meta = cfg.PARAMS[p.key] || {};
      var cl = meta.cluster ? (' hm-cl-' + meta.cluster) : '';
      var accent = CLUSTER_COLORS[meta.cluster] || '#64748b';
      // Ambil nama lengkap dari config (mis. "Iron (Fe)") untuk baris kedua;
      // simbol singkat tetap dari p.label (mis. "Fe").
      var full = String(meta.label || p.label || '');
      var sym = String(p.label || full);
      var name = '';
      var m = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (m) { name = m[1].trim(); }
      var title = full + ' — klik untuk sortir';
      thHtml += '<th scope="col" class="center th-param' + cl + '" data-heat-sort="' + p.key + '" title="' + esc(title) + '" ' +
        'style="cursor:pointer;--hdr-accent:' + accent + '">' +
        '<span class="th-param-txt">' +
          '<span class="th-sym">' + esc(sym) + sortMark(p.key) + '</span>' +
          (name ? '<span class="th-name">' + esc(name) + '</span>' : '') +
        '</span></th>';
    });
    thHtml += '</tr>';
    head.innerHTML = thHtml;

    // Delegasi klik header heatmap (sekali pasang).
    if (!head._sosHeatBound) {
      head._sosHeatBound = true;
      head.addEventListener('click', function (e) {
        var th = e.target.closest('[data-heat-sort]');
        if (!th) return;
        var k = th.getAttribute('data-heat-sort');
        var st = { key: heatmapState.sortKey, dir: heatmapState.sortDir };
        var dir = (st.key === k && st.dir === 'desc') ? 'asc' : 'desc';
        setHeatmapSort(k, dir);
        renderHeatmap();
      });
    }

    if (!units.length) {
      body.innerHTML = '<tr><td colspan="' + (HEATMAP_PARAMS.length + 1) + '" style="text-align:center;padding:30px;color:var(--text-mute)">Belum ada data SOS.</td></tr>';
      return;
    }

    // Urutkan sesuai state sortir heatmap (default: tier/MPRS tertinggi dulu).
    var hk = heatmapState.sortKey, hd = heatmapState.sortDir === 'asc' ? 1 : -1;
    units = units.slice().sort(function (a, b) {
      var va, vb;
      if (hk === 'sort') {
        var dt = (b.mprs.tier || 0) - (a.mprs.tier || 0);
        if (dt !== 0) return dt;
        return (b.criticality.score || 0) - (a.criticality.score || 0);
      }
      if (hk === 'label') { va = (a.assetId + ' ' + a.component); vb = (b.assetId + ' ' + b.component); }
      else { va = a.latest[hk]; vb = b.latest[hk]; }
      var na = (va === null || va === undefined || isNaN(va));
      var nb = (vb === null || vb === undefined || isNaN(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
      }
      return va < vb ? -hd : (va > vb ? hd : 0);
    });

    var html = '';
    units.forEach(function (u) {
      var th = cfg.getThresholdsFor(u.component, u.model);
      var latest = u.latest;
      var tierColor = cfg.TIER_COLORS[u.mprs.tier] || cfg.TIER_COLORS[0];

      html += '<tr data-sos-heat-unit="' + esc(u.assetId) + '" data-sos-heat-comp="' + esc(u.component) + '" style="cursor:pointer">';
      // Inisial badge diambil dari KUNCI tier internal (N/M/C/E) agar konsisten
      // dgn tierKey() dan tidak rapuh bila label tampilan berubah.
      var tierInitial = tierKey(u.mprs.tier).charAt(0);
      // [REDESIGN 2026-10-03] Label dua-baris: asset ID (tebal) + kompartemen
      // (kecil, warna) agar terbaca cepat; badge tier + aksen kiri berwarna.
      var isNormal = (u.mprs.tier || 0) === 0;
      html += '<td class="hm-label" style="--row-accent:' + tierColor + '">' +
        '<span class="hm-tier" style="background:' + tierColor + '26;color:' + tierColor + ';box-shadow:0 0 0 1px ' + tierColor + '55,0 0 10px ' + tierColor + '44">' +
        tierInitial + '</span>' +
        '<span class="hm-label-txt">' +
          '<span class="hm-asset">' + esc(u.assetId) + '</span>' +
          '<span class="hm-comp' + (isNormal ? ' is-normal' : '') + '">' + esc(u.component) + '</span>' +
        '</span></td>';

      HEATMAP_PARAMS.forEach(function (p) {
        var t = th[p.key];
        var v = latest[p.key];
        if (!t || v === null || v === undefined) {
          html += '<td class="center hm-cell hm-na">—</td>';
          return;
        }
        var sev = global.SOS_ANALYTICS.severityScore(v, t, p.key);
        // [STANDARISASI 2026-10-03] severity 1 = Caution, >=2 = Critical
        var st = sev >= 2 ? 'CRITICAL' : sev >= 1 ? 'CAUTION' : 'NORMAL';
        var meta = cfg.PARAMS[p.key];
        html += '<td class="center hm-cell ' + tierClass(st) + '" title="' + esc(meta.label) + ': ' + fmt(v, meta.decimals) + '">' +
          fmt(v, meta.decimals) + '</td>';
      });

      html += '</tr>';
    });

    body.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * SOS Perbandingan — overlay tren parameter antar kompartemen (maks 4)
   * --------------------------------------------------------------------- */
  var COMPARE_COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#22c55e'];
  var COMPARE_SELECTS = ['sos-comp-unit1', 'sos-comp-unit2', 'sos-comp-unit3', 'sos-comp-unit4'];

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
      sel.innerHTML = opts(i >= 2);   // kompartemen ke-3/4 boleh kosong
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

    // Kumpulkan kompartemen yang dipilih (unik, maks 4)
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
    _lastCompareUnits = units; _lastCompareParam = paramKey;   // simpan utk re-render saat sortir

    // Hitung nomor ranking relatif (1..N) berdasarkan rankScore (skor pelanggaran threshold sampel terbaru)
    var rankByKey = {};
    units.slice().sort(function (a, b) { return (b.rankScore || 0) - (a.rankScore || 0); })
      .forEach(function (u, i) { rankByKey[u.assetId + '||' + u.component] = i + 1; });

    // Pewarnaan nilai SOS berdasarkan threshold kompartemen (Normal / Caution / Critical)
    // [KONSOLIDASI 2026-10-05] Delegasi ke helper bersama paramColorStyle;
    // nilai normal dikembalikan ke warna default tabel ringkasan (#94a3b8).
    var valColor = function (v, pk, u) {
      return paramColorStyle(v, pk, u.component, u.model) || 'color:#94a3b8';
    };

    // Urutkan dari tier tertinggi lalu criticality tertinggi
    var sorted = units.slice().sort(function (a, b) {
      var dt = (b.mprs.tier || 0) - (a.mprs.tier || 0);
      if (dt !== 0) return dt;
      return (b.criticality.score || 0) - (a.criticality.score || 0);
    });

    // [STANDARISASI 2026-10-03] 3 level.
    var counts = { CRITICAL: 0, CAUTION: 0, NORMAL: 0 };
    sorted.forEach(function (u) {
      var key = (cfg.TIER_KEYS || [])[u.mprs.tier];
      if (key && counts[key] !== undefined) counts[key]++;
    });

    var html = '<div class="panel-head"><div>' +
      '<h2 class="panel-title"><i class="fa-solid fa-clipboard-check" style="color:#22c55e"></i> Ringkasan &amp; Kesimpulan</h2>' +
      '<p class="panel-sub">Penilaian ' + sorted.length + ' kompartemen terpilih — dari paling critical ke normal</p>' +
      '</div></div>';

    // Baris kesimpulan level (label tampilan baru, warna baru)
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px">';
    // [STANDARISASI 2026-10-03] Legend 3 level.
    [['CRITICAL', '#ef4444'], ['CAUTION', '#f59e0b'], ['NORMAL', '#e2e8f0']].forEach(function (p) {
      var key = p[0], col = p[1];
      html += '<span class="chip" style="background:' + col + '22;color:' + col + ';border-color:' + col + '55">' +
        cfg.tierLabelOf(key) + ': <strong>' + (counts[key] || 0) + '</strong></span>';
    });
    html += '</div>';

    // Helper Life Time % dari database lifetime
    var getLife = function (u) {
      if (!global.PORTFOLIO_STORE) return null;
      var lambung = global.PORTFOLIO_STORE.resolveLambung(u.assetId, u.serial) || u.assetId;
      var lt = global.PORTFOLIO_STORE.lifetimeSummary(lambung, u.component);
      return (lt && typeof lt.lifePct === 'number') ? lt.lifePct : null;
    };

    // Tabel ringkasan — header dapat diklik untuk sortir (Point 4).
    var cs = compareSummaryState;
    var mark = function (k) { return cs.key === k ? (cs.dir === 'asc' ? ' ▲' : ' ▼') : ''; };
    sorted = sorted.slice().sort(function (a, b) {
      var va, vb;
      if (cs.key === 'rank') { va = rankByKey[a.assetId + '||' + a.component] || 999; vb = rankByKey[b.assetId + '||' + b.component] || 999; }
      else if (cs.key === 'label') { va = a.assetId + ' ' + a.component; vb = b.assetId + ' ' + b.component; }
      else if (cs.key === 'lifetime') { va = getLife(a); vb = getLife(b); }
      else if (cs.key === 'level') { va = a.mprs.tier || 0; vb = b.mprs.tier || 0; }
      else if (cs.key === 'mprs') { va = a.mprs.mprs || 0; vb = b.mprs.mprs || 0; }
      else if (cs.key === 'crit') { va = a.criticality.score || 0; vb = b.criticality.score || 0; }
      else if (cs.key === 'fe') { va = a.latest.wear_fe; vb = b.latest.wear_fe; }
      else if (cs.key === 'cu') { va = a.latest.wear_cu; vb = b.latest.wear_cu; }
      else if (cs.key === 'si') { va = a.latest.wear_si; vb = b.latest.wear_si; }
      else if (cs.key === 'al') { va = a.latest.wear_al; vb = b.latest.wear_al; }
      else if (cs.key === 'pb') { va = a.latest.wear_pb; vb = b.latest.wear_pb; }
      else if (cs.key === 'pqi') { va = a.latest.pqi; vb = b.latest.pqi; }
      else if (cs.key === 'hm') { va = a.latest.hm_unit || 0; vb = b.latest.hm_unit || 0; }
      else if (cs.key === 'date') { va = a.latest._dateStr || a.lastDate || ''; vb = b.latest._dateStr || b.lastDate || ''; }
      else { va = rankByKey[a.assetId + '||' + a.component] || 999; vb = rankByKey[b.assetId + '||' + b.component] || 999; }
      var na = (va === null || va === undefined || isNaN(va));
      var nb = (vb === null || vb === undefined || isNaN(vb));
      if (na && nb) return 0; if (na) return 1; if (nb) return -1;
      if (typeof va === 'string' || typeof vb === 'string') { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      var d = cs.dir === 'asc' ? 1 : -1;
      return va < vb ? -d : (va > vb ? d : 0);
    });

    html += '<div class="table-scroll"><table class="data"><thead><tr>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="rank" style="cursor:pointer">Peringkat' + mark('rank') + '</th>' +
      '<th scope="col" class="cs-sort" data-cs-sort="label" style="cursor:pointer">Kompartemen' + mark('label') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="lifetime" style="cursor:pointer">Life Time (%)' + mark('lifetime') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="level" style="cursor:pointer">Level' + mark('level') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="mprs" style="cursor:pointer">MPRS' + mark('mprs') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="crit" style="cursor:pointer">Criticality' + mark('crit') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="fe" style="cursor:pointer">Fe' + mark('fe') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="cu" style="cursor:pointer">Cu' + mark('cu') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="si" style="cursor:pointer">Si' + mark('si') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="al" style="cursor:pointer">Al' + mark('al') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="pb" style="cursor:pointer">Pb' + mark('pb') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="pqi" style="cursor:pointer">PQI' + mark('pqi') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="hm" style="cursor:pointer">Terakhir (HM)' + mark('hm') + '</th>' +
      '<th scope="col" class="cs-sort center" data-cs-sort="date" style="cursor:pointer">Tanggal' + mark('date') + '</th>' +
      '</tr></thead><tbody>';

    sorted.forEach(function (u) {
      var t = u.mprs.tier;
      var col = cfg.TIER_COLORS[t];
      var s = u.latest;
      var rank = rankByKey[u.assetId + '||' + u.component] || '—';
      var rankKey = tierKey(u.mprs.tier);
      var dateStr = s._dateStr || u.lastDate || '—';
      var lp = getLife(u);
      var lpCol = (lp !== null && lp >= 100) ? '#f87171' : ((lp !== null && lp >= 80) ? '#facc15' : '#4ade80');
      var lpHtml = (lp !== null)
        ? ('<span class="badge" style="background:' + lpCol + '22;color:' + lpCol + '">' + lp + '%</span>')
        : '<span class="u-text-mute">—</span>';

      html += '<tr style="cursor:pointer" data-sos-unit="' + esc(u.assetId) + '" data-sos-comp="' + esc(u.component) + '">' +
        '<td class="center"><span class="sev-badge sev-' + rankKey + '" title="Peringkat keparahan pelanggaran threshold: ' + rank + '">' + rank + '</span></td>' +
        '<td><strong>' + esc(u.assetId) + '</strong> — ' + esc(u.component) + '</td>' +
        '<td class="center">' + lpHtml + '</td>' +
        '<td class="center"><span class="badge" style="background:' + col + '22;color:' + col + '">' + cfg.TIER_LABELS[t] + '</span></td>' +
        '<td class="center">' + fmt(u.mprs.mprs, 1) + '</td>' +
        '<td class="center">' + fmt(u.criticality.score, 1) + ' <span style="color:var(--text-mute);font-size:10px">(' + u.criticality.band + ')</span></td>' +
        '<td class="center" style="' + valColor(s.wear_fe, 'wear_fe', u) + '">' + fmt(s.wear_fe, 1) + '</td>' +
        '<td class="center" style="' + valColor(s.wear_cu, 'wear_cu', u) + '">' + fmt(s.wear_cu, 1) + '</td>' +
        '<td class="center" style="' + valColor(s.wear_si, 'wear_si', u) + '">' + fmt(s.wear_si, 1) + '</td>' +
        '<td class="center" style="' + valColor(s.wear_al, 'wear_al', u) + '">' + fmt(s.wear_al, 1) + '</td>' +
        '<td class="center" style="' + valColor(s.wear_pb, 'wear_pb', u) + '">' + fmt(s.wear_pb, 1) + '</td>' +
        '<td class="center" style="' + valColor(s.pqi, 'pqi', u) + '">' + fmt(s.pqi, 0) + '</td>' +
        '<td class="center">' + fmt(s.hm_unit, 0) + '</td>' +
        '<td class="center mono" style="font-size:11px;color:#94a3b8">' + esc(dateStr) + '</td>' +
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

    // Delegasi klik header sortir tabel ringkasan (Point 4).
    var thead = box.querySelector('thead');
    if (thead && !thead._csBound) {
      thead._csBound = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('[data-cs-sort]');
        if (!th) return;
        var k = th.getAttribute('data-cs-sort');
        var dir = (compareSummaryState.key === k && compareSummaryState.dir === 'desc') ? 'asc' : 'desc';
        compareSummaryState.key = k; compareSummaryState.dir = dir;
        if (_lastCompareUnits) renderComparisonSummary(_lastCompareUnits, _lastCompareParam);
      });
    }
  }

  /* -----------------------------------------------------------------------
   * Model distribution chips (Slideshow / Carousel kompak)
   * --------------------------------------------------------------------- */
  var _sosModelTimer = null;
  function renderModelChips(stats) {
    var el = document.getElementById('sos-models');
    if (!el) return;
    if (_sosModelTimer) { clearInterval(_sosModelTimer); _sosModelTimer = null; }

    var keys = Object.keys(stats.models || {}).sort();
    if (!keys.length) {
      el.innerHTML = '<span class="chip" style="font-size:11px;color:var(--text-mute)"><i class="fa-solid fa-truck"></i> Belum ada model terdeteksi</span>';
      return;
    }

    var items = keys.map(function (m) {
      return '<span class="chip" style="font-size:11px;white-space:nowrap"><i class="fa-solid fa-truck-monster" style="color:#38bdf8"></i> ' + esc(m) + ' <strong style="color:#e2e8f0">(' + stats.models[m] + ')</strong></span>';
    });

    if (items.length <= 4) {
      el.innerHTML = items.join('');
      return;
    }

    // Carousel jika model banyak (> 4) agar tidak memenuhi layar
    var batchSize = 3;
    var pages = [];
    for (var i = 0; i < items.length; i += batchSize) {
      pages.push(items.slice(i, i + batchSize).join(''));
    }

    var cur = 0;
    function renderPage(idx) {
      el.style.opacity = '0.1';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(function () {
        el.innerHTML = '<span style="font-size:10px;color:var(--text-mute);margin-right:4px;white-space:nowrap"><i class="fa-solid fa-layer-group"></i> Model (' + (idx + 1) + '/' + pages.length + '):</span>' + pages[idx];
        el.style.opacity = '1';
      }, 250);
    }

    renderPage(0);
    _sosModelTimer = setInterval(function () {
      cur = (cur + 1) % pages.length;
      renderPage(cur);
    }, 3500);
  }

  /* -----------------------------------------------------------------------
   * View switching
   * --------------------------------------------------------------------- */
  var currentView = 'fleet'; // 'fleet' | 'detail' | 'heatmap' | 'comparison'
  var currentDetailUnit = null; // { assetId, component }

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

  /**
   * [CLC 2026-10-04] Banner status Filter Umur Komponen untuk tabel fleet SOS.
   * Tampil hanya bila fitur aktif. Menjelaskan dasar & jumlah yang dikecualikan
   * (prinsip: tidak ada data hilang diam-diam).
   */
  function renderClcBanner() {
    var el = document.getElementById('sos-clc-banner');
    if (!el) return;
    var clc = global.COMPONENT_LIFE;
    if (!clc || !clc.isEnabled()) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    var rep = (store && store.clcReport) ? store.clcReport() : null;
    if (!rep || !rep.total) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    var used = rep.total - rep.cut;
    var conf = '';
    conf += '<span class="u-text-ok"><i class="fa-solid fa-check"></i> ' + rep.byBasis.date + ' tanggal</span> · ';
    conf += '<span class="u-text-warn"><i class="fa-solid fa-equals"></i> ' + rep.byBasis.hm + ' HM</span> · ';
    conf += '<span class="u-text-mute"><i class="fa-solid fa-question"></i> ' + rep.byBasis.none + ' tanpa referensi</span>';
    el.innerHTML =
      '<span class="clc-title"><i class="fa-solid fa-filter-circle-xmark"></i>' +
      '<strong>Filter Umur Komponen AKTIF</strong></span>' +
      '<span class="clc-detail">' +
      used + ' dari ' + rep.total + ' sampel dipakai <span class="clc-sep">·</span> ' +
      rep.cut + ' dikecualikan (sebelum pemasangan) <span class="clc-sep">·</span> ' +
      'Dasar: ' + conf +
      '</span>';
    el.classList.remove('hidden');
  }

  /**
   * [CLC] Lencana per-baris pada tabel fleet SOS — menjelaskan dasar potong.
   * @param {object} u unit (punya latest._clc)
   * @returns {string} HTML lencana ('') bila fitur nonaktif.
   */
  function clcBadge(u) {
    var clc = global.COMPONENT_LIFE;
    if (!clc || !clc.isEnabled()) return '';
    var d = (u && u.latest && u.latest._clc) ? u.latest._clc : null;
    if (!d) return '';
    var tip, cls, label;
    if (d.basis === 'date') {
      cls = 'u-text-ok'; label = 'tanggal';
      tip = 'Dipasang ' + (d.refDate || '?') + ' (LastTecoDate). Sampel sebelum tanggal ini dikecualikan.';
    } else if (d.basis === 'hm') {
      cls = 'u-text-warn'; label = 'HM';
      tip = 'Dipasang pada HM ' + Math.round(d.refHM) + '. Sampel sebelum HM ini dikecualikan.';
    } else {
      cls = 'u-text-mute'; label = 'tanpa referensi';
      tip = d.reason || 'Tidak ada referensi pemasangan — potong dilewati.';
    }
    var icon = d.basis === 'date' ? 'fa-check' : (d.basis === 'hm' ? 'fa-equals' : 'fa-question');
    return ' <span class="' + cls + '" style="font-size:11px;white-space:nowrap" title="' + esc(tip) + '">' +
      '<i class="fa-solid ' + icon + '"></i> ' + label + '</span>';
  }

  function showView(view) {
    currentView = view;
    toggle('sos-fleet-panel', view === 'fleet');
    toggle('sos-detail-panel', view === 'detail');
    toggle('sos-heatmap-panel', view === 'heatmap');
    toggle('sos-comparison-panel', view === 'comparison');

    // [HEADER] Semua view SELAIN detail menampilkan header netral (brand).
    // Detail diisi oleh renderAssetDetail() -> renderHeader(unit).
    // [FIX AUDIT 2026-10-04 · C-1] Semua view SELAIN detail menampilkan header
    // netral (brand). Kini lewat SATU PEMILIK header: APP_HEADER.setHome().
    if (view !== 'detail') {
      if (global.APP_HEADER && global.APP_HEADER.setHome) {
        try { global.APP_HEADER.setHome(); } catch (e) {}
      } else if (global.VHMS_RENDER && global.VHMS_RENDER.resetHeader) {
        try { global.VHMS_RENDER.resetHeader(); } catch (e) {}
      }
      // [FIX G-4] Judul default dari sumber tunggal (APP_HEADER.setHome sudah
      // menanganinya; baris ini hanya pengaman bila app-header belum termuat).
      if (!(global.APP_HEADER && global.APP_HEADER.setHome)) {
        try { document.title = 'Asset Reliability Performance Center (ARPC)'; } catch (e) {}
      }
    }

    if (view === 'fleet') {
      updateUploadVisibility();
      renderClcBanner();
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

  /**
   * [KONSISTENSI NAVIGASI 2026-10-03] Pulihkan tampilan SOS ke state terakhir
   * yang dilihat pengguna (detail unit, heatmap, comparison, atau fleet).
   */
  function restoreView() {
    if (store.count() === 0) {
      showView('fleet');
      return;
    }
    if (currentView === 'detail' && currentDetailUnit) {
      var unit = store.getUnit(currentDetailUnit.assetId, currentDetailUnit.component);
      if (unit) {
        renderAssetDetail(currentDetailUnit.assetId, currentDetailUnit.component);
        showView('detail');
        return;
      }
    }
    if (currentView === 'heatmap') {
      showView('heatmap');
      return;
    }
    if (currentView === 'comparison') {
      showView('comparison');
      return;
    }
    showView('fleet');
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
    getSOSReportFileName: getSOSReportFileName,
    renderHeatmap: renderHeatmap,
    renderComparison: renderComparison,
    renderModelChips: renderModelChips,
    showView: showView,
    restoreView: restoreView,
    renderClcBanner: renderClcBanner,
    /** Segarkan ulang tampilan yang sedang aktif (dipakai setelah CLC berubah). */
    refreshCurrentView: function () { restoreView(); },
    getView: function () { return currentView; },
    getCurrentUnit: function () { return currentDetailUnit; },
    updateUploadVisibility: updateUploadVisibility,
    getFleetState: function () { return fleetState; },
    setFleetState: function (s) { for (var k in s) fleetState[k] = s[k]; },
    refreshSectionOptions: refreshSectionOptions,
    setHeatmapSort: setHeatmapSort,
    fmt: fmt,
    esc: esc,
    tierBadge: tierBadge,
    /** [FITUR 2026-10-05] Ekspor SOS Kompartemen List ke Excel (CSV). */
    exportFleetCsv: exportFleetCsv,
    buildFleetCsv: buildFleetCsv,
  };

})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * fuel-render.js
 * -------------------------------------------------------------------------
 * [FUEL 2026-10-28] Tampilan halaman Fuel Trending. Modul **MANDIRI**.
 *
 * MURNI terhadap data: menerima hasil `FUEL_ANALYTICS.analyze()` + daftar
 * siklus, lalu menulis HTML. Tidak membaca store RBM mana pun.
 *
 * Prinsip tampilan:
 *   1. `z` dan atribusi WAJIB tampil — tanpa itu user tidak bisa membedakan
 *      tiga penyebab "boros" (mesin / underload / idle).
 *   2. Baseline belum layak -> TIDAK ada verdict, TAPI nilai tetap tampil,
 *      disertai alasan. Menyembunyikan angka membuat user menebak.
 *   3. Jendela yang gugur ditampilkan beserta sebabnya, bukan dihilangkan.
 * ========================================================================= */

(function (global) {
  'use strict';

  var ui = global.UI_UTIL || {};
  var esc = ui.esc || function (s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function num(v, d) {
    if (v == null || !isFinite(v)) return '\u2014';
    var dd = (d == null) ? 1 : d;
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: dd, maximumFractionDigits: dd });
  }

  var VERDICT_META = {
    NORMAL:  { cls: 'is-normal',   label: 'Normal',  color: '#34d399' },
    CAUTION: { cls: 'is-warning',  label: 'Caution', color: '#f59e0b' },
    OVER:    { cls: 'is-critical', label: 'Over',    color: '#f87171' }
  };
  var DRIVER_LABEL = {
    engine: 'Mesin / jalan',
    underload: 'Underload'
  };
  var DROP_LABEL = {
    'no-valid-cycles': 'Tidak ada siklus payload valid di jendela ini',
    'gap-smr': 'Lompatan SMR (unit lama tidak beroperasi / data hilang)',
    'low-coverage': 'Siklus tidak menutupi jendela (coverage < 70 %) — angka tidak bisa dipercaya',
    'low-cycles': 'Siklus valid < 10 (sampel terlalu tipis)',
    'no-tkm': 'Ton-km nol (payload/jarak tidak terukur)',
    'fuel-rate-null': 'Fuel Rate kosong pada record',
    'smr-not-increasing': 'SMR tidak naik (record ganda / urutan rusak)',
    'calendar-not-increasing': 'Tanggal calendar tidak naik',
    'no-empty-weight': 'Berat kosong unit tidak dikenal'
  };

  /* [F1 2026-10-29] Pencari elemen bisa DIPINDAHKAN lewat `setDomLookup()`
   * supaya chart (dan panel) dapat diuji di Node tanpa DOM sungguhan: tes
   * memasang pencari palsu yang mengembalikan canvas tiruan, lalu merekam
   * konfigurasi Chart. Tanpa pintu ini, satu-satunya cara menguji "tidak ada
   * spline" adalah membaca teks sumber — tes yang tidak membuktikan perilaku. */
  var _domLookup = function (id) {
    return (typeof document === 'undefined') ? null : document.getElementById(id);
  };
  function setDomLookup(fn) {
    var prev = _domLookup;
    _domLookup = (typeof fn === 'function') ? fn : function (id) {
      return (typeof document === 'undefined') ? null : document.getElementById(id);
    };
    return prev;
  }
  var $id = function (id) { return _domLookup(id); };

  /* Keadaan tampilan yang MENGUBAH isi tabel jendela (bukan data).
   * `verdictFilter`: null = semua; 'NORMAL' | 'CAUTION' | 'OVER' = hanya
   * status tersebut. Di-set chip di ringkasan baseline / handler lembar
   * status per-baris (lihat fuel-app.js). `setVerdictFilter()` mengembalikan
   * nilai TERPAKAI agar handler tahu apakah filter berubah (perlu render). */
  var _state = { verdictFilter: null };

  function setVerdictFilter(v) {
    var ok = { NORMAL: 1, CAUTION: 1, OVER: 1 };
    _state.verdictFilter = ok[v] ? v : null;
    return _state.verdictFilter;
  }
  function getVerdictFilter() { return _state.verdictFilter; }

  /* -----------------------------------------------------------------------
   * renderWarnings(res) — banner penahanan.
   * Selalu dirender, juga saat kosong (dikosongkan).
   * --------------------------------------------------------------------- */
  function renderWarnings(res) {
    var host = $id('fuel-warnings');
    if (!host) return;
    var w = (res && res.warnings) || [];
    if (!w.length) { host.innerHTML = ''; return; }
    host.innerHTML = w.map(function (s) {
      return '<div class="alert-banner" role="alert" style="cursor:default;margin-bottom:8px">' +
        '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> ' + esc(s) + '</div>';
    }).join('');
  }

  /* -----------------------------------------------------------------------
   * renderSummary(res) — statistik metrik + keadaan jendela, RAPI & INTERAKTIF.
   *
   * [REVISI 2026-10-28] Bentuk lama: satu <table> 3 baris + daftar teks di
   * kanan ("Berat kosong / Jendela layak / Normal: 62 Caution: 7 Over: 5").
   * Terbaca seperti log, tidak ada affordance. Bentuk baru:
   *   - kartu metrik (.fuel-card, sama dengan kartu di atas) tetap dapat
   *     dibuka untuk rincian — atribut aria diisi handler klik di fuel-app.js;
   *   - chip status memakai `<button aria-pressed>` supaya bisa difilter dan
   *     terjangkau keyboard;
   *   - setiap angka memakai tabular-nums + label satuan yang jelas.
   * Semua konten berasal dari `res` — TIDAK ada angka yang dikarang: chip
   * tetap tampil walau nilainya 0, kartu tetap "—" bila baseline kosong.
   * --------------------------------------------------------------------- */
  var METRIC_HELP = {
    lTk: 'Pembilang = liter terpakai; penyebut = ton yang benar-benar diangkut × jarak ' +
      'bermuatan. Angka inilah yang dipakai menvonis jendela (z-score log).',
    lGt: 'Penyebut memakai bobot total (berat kosong + muatan) untuk jarak bermuatan ' +
      'DAN jarak kosong — jadi biaya membawa unit kosong ikut terhitung.',
    penalty: 'Rasio L/GTKM terhadap L/ton-km. 1,0 = tidak ada penalti bobot kosong; ' +
      'makin besar makin banyak bahan bakar terpakai untuk mengangkut unit sendiri.'
  };

  function renderSummary(res) {
    var panel = $id('fuel-summary-panel'), host = $id('fuel-summary');
    if (!panel || !host) return;
    if (!res || !res.baseline) { panel.style.display = 'none'; host.innerHTML = ''; return; }
    panel.style.display = '';

    var b = res.baseline;
    var counts = res.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 };
    var total = (counts.NORMAL || 0) + (counts.CAUTION || 0) + (counts.OVER || 0);
    var usable = !!(res.ready && res.usable);

    var METRICS = [
      { key: 'lTk', label: 'L / ton-km', unit: 'L/ton-km', d: 4, accent: '#22d3ee', note: 'Dipakai verdict' },
      { key: 'lGt', label: 'L / GTKM', unit: 'L/ton-km', d: 4, accent: '#38bdf8', note: 'Mesin + kondisi jalan' },
      { key: 'penalty', label: 'GTKM / TKM', unit: '\u00d7', d: 3, accent: '#f59e0b', note: 'Penalti underload' }
    ];

    var cards = METRICS.map(function (m) {
      var s = b[m.key];
      var flat = !s || s.flat;
      var sigma = (!s || s.sigma == null) ? '\u2014' : num(s.sigma, 4);
      return '<button type="button" class="fuel-card is-static fuel-metric" tabindex="-1"' +
          ' style="--fuel-accent:' + m.accent + '"' +
          ' data-fuel-metric="' + m.key + '"' +
          ' aria-label="' + esc(m.label + ': median ' + num(s && s.median, m.d) + ' ' + m.unit) + '">' +
          '<span class="fuel-metric-head">' +
            '<span class="fuel-card-label">' + esc(m.label) + '</span>' +
            (flat ? '<span class="fuel-metric-flag">datar</span>' : '') +
          '</span>' +
          '<span class="fuel-card-value">' + num(s && s.median, m.d) +
            '<small>' + esc(m.unit) + '</small></span>' +
          '<span class="fuel-card-meta">\u03c3(log) <strong>' + sigma + '</strong></span>' +
          '<span class="fuel-card-note">' + esc(m.note) + '</span>' +
        '</button>';
    }).join('');

    // Chip status = TOMBOL filter. Angka kecil di kanan = porsi jendela.
    var CHIPS = ['NORMAL', 'CAUTION', 'OVER'];
    var curFilter = _state.verdictFilter;
    var chips = CHIPS.map(function (k) {
      var m = VERDICT_META[k];
      var n = counts[k] || 0;
      var pct = total > 0 ? Math.round(100 * n / total) : null;
      // `is-active`/aria-pressed HARUS ikut dirender: `render()` menggambar
      // ulang seluruh panel setelah chip diklik, jadi status aktif tidak boleh
      // bergantung pada sinkronisasi DOM sesudahnya.
      var on = (curFilter === k);
      return '<button type="button" class="fuel-count-chip ' + m.cls + (on ? ' is-active' : '') + '"' +
          ' data-fuel-verdict="' + k + '"' +
          ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
          ' title="Tampilkan hanya jendela ' + esc(m.label) + ' di tabel bawah">' +
          '<span class="fuel-count-chip-dot" style="background:' + m.color + '"></span>' +
          '<span class="fuel-count-chip-label">' + esc(m.label) + '</span>' +
          '<strong>' + n + '</strong>' +
          '<span class="fuel-count-chip-pct">' + (pct == null ? '\u2014' : pct + '%') + '</span>' +
        '</button>';
    }).join('');

    var me = (res.emptyWeight == null) ? '\u2014' : num(res.emptyWeight, 1) + ' t';
    var gate = usable ? 'Baseline dipakai menvonis' : 'Baseline belum menvonis';

    host.innerHTML =
      '<div class="fuel-metric-row fuel-cards">' + cards + '</div>' +
      '<div class="fuel-summary-bar">' +
        '<div class="fuel-summary-facts">' +
          '<span class="fuel-fact" title="Berat kosong (Me) unit — dipakai menghitung GTKM">' +
            '<i class="fa-solid fa-weight-hanging"></i>' +
            '<span class="fuel-fact-k">Berat kosong (Me)</span>' +
            '<strong>' + me + '</strong>' +
          '</span>' +
          '<span class="fuel-fact" title="Jumlah jendela yang lolos gerbang sampel dan dipakai menghitung baseline">' +
            '<i class="fa-solid fa-layer-group"></i>' +
            '<span class="fuel-fact-k">Jendela layak verdict</span>' +
            '<strong>' + esc(String(res.eligible)) + '</strong>' +
          '</span>' +
          '<span class="fuel-fact fuel-fact-status ' + (usable ? 'is-ok' : 'is-warn') + '">' +
            '<i class="fa-solid ' + (usable ? 'fa-circle-check' : 'fa-circle-exclamation') + '"></i>' +
            '<span>' + esc(gate) + '</span>' +
          '</span>' +
        '</div>' +
        '<div class="fuel-count-chips" role="group" aria-label="Filter tabel jendela menurut status">' +
          chips +
        '</div>' +
      '</div>' +
      '<p class="fuel-summary-hint">' +
        '<i class="fa-solid fa-hand-pointer"></i> Klik kartu metrik untuk rumus + rentang (min/p25/median/p75/max). ' +
        'Klik chip status untuk menyaring tabel jendela di bawah.' +
      '</p>' +
      (res.ready && !res.usable
        ? '<div class="alert-banner" role="note" style="cursor:default;margin-top:10px">' +
          '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> ' +
          'Verdict tidak diterbitkan: variasi data terlalu kecil (\u03c3 di bawah lantai).</div>'
        : '');
  }

  /* -----------------------------------------------------------------------
   * renderTable(res) — tabel jendela + atribusi.
   * DIURUTKAN menurun berdasar z agar anomali di atas.
   *
   * [REVISI 2026-10-28] `_state.verdictFilter` = 'NORMAL' | 'CAUTION' | 'OVER'
   * | null, di-set oleh chip status di ringkasan baseline. Penyaringan HANYA
   * menyembunyikan baris yang memang tidak dipilih — total jendela tetap
   * disebut di catatan supaya user tahu ada berapa yang tersembunyi.
   * --------------------------------------------------------------------- */
  function renderTable(res) {
    var panel = $id('fuel-table-panel'), head = $id('fuel-window-head'), body = $id('fuel-window-body');
    var note = $id('fuel-table-note');
    if (!panel || !head || !body) return;
    var allWins = ((res && res.windows) || []).filter(function (w) { return w.verdictable; });
    if (!allWins.length) { panel.style.display = 'none'; body.innerHTML = ''; head.innerHTML = ''; return; }
    panel.style.display = '';

    var vFilter = _state.verdictFilter || null;
    var wins = vFilter
      ? allWins.filter(function (w) { return w.verdict === vFilter; })
      : allWins;
    // Filter aktif tetapi tidak ada baris -> tetap gambar header agar chip
    // bisa dilepas (jangan menyembunyikan panel dan mengunci user).
    if (!wins.length && !vFilter) return;

    var COLS = [
      ['Tanggal', 'left'], ['N', 'right'], ['L/h', 'right'], ['L', 'right'],
      ['L/TKM', 'right'], ['z', 'right'], ['z mesin', 'right'], ['z beban', 'right'],
      ['Idle %', 'right'], ['Over %%', 'right'], ['Payload', 'right'], ['Status', 'left']
    ];
    head.innerHTML = '<tr>' + COLS.map(function (c) {
      return '<th scope="col" style="text-align:' + c[1] + '">' + esc(c[0].replace('%%', '%')) + '</th>';
    }).join('') + '</tr>';

    var sorted = wins.slice().sort(function (a, b) {
      var az = (a.z == null ? -999 : a.z), bz = (b.z == null ? -999 : b.z);
      if (bz !== az) return bz - az;
      return String(b.date).localeCompare(String(a.date));
    });

    body.innerHTML = sorted.map(function (w) {
      var meta = w.verdict ? VERDICT_META[w.verdict] : null;
      var zCell = (w.z == null)
        ? '<span class="u-text-mute" title="Baseline belum layak / variasi terlalu kecil">\u2014</span>'
        : num(w.z, 2);
      var status = meta
        ? '<button type="button" class="badge ' + meta.cls + ' fuel-badge-btn"' +
          ' data-fuel-verdict="' + esc(w.verdict) + '"' +
          ' aria-pressed="' + (vFilter === w.verdict ? 'true' : 'false') + '"' +
          ' title="Klik untuk menampilkan hanya jendela ' + esc(meta.label) + '">' +
          esc(meta.label) + '</button>' +
          (w.driver ? ' <span class="u-text-mute" style="font-size:11px">' + esc(DRIVER_LABEL[w.driver] || w.driver) + '</span>' : '')
        : '<span class="u-text-mute">tanpa verdict</span>';
      // Sorot sel atribusi hanya bila jendela memang di-flag.
      var isFlag = w.verdict === 'OVER' || w.verdict === 'CAUTION';
      return '<tr' + (isFlag ? ' class="fuel-row-flag"' : '') + '>' +
        '<td class="fuel-cell-date">' + esc(w.date || '') + '</td>' +
        '<td class="fuel-num">' + esc(String(w.n)) + '</td>' +
        '<td class="fuel-num">' + num(w.fuelRate, 1) + '</td>' +
        '<td class="fuel-num">' + num(w.liters, 0) + '</td>' +
        '<td class="fuel-num">' + num(w.lTk, 4) + '</td>' +
        '<td class="fuel-num fuel-num-key">' + zCell + '</td>' +
        '<td class="fuel-num">' + num(w.zG, 2) + '</td>' +
        '<td class="fuel-num">' + num(w.zP, 2) + '</td>' +
        '<td class="fuel-num">' + (w.idle == null ? '\u2014' : num(100 * w.idle, 0)) + '</td>' +
        '<td class="fuel-num">' + (w.overLoad == null ? '\u2014' : num(100 * w.overLoad, 0)) + '</td>' +
        '<td class="fuel-num">' + num(w.payloadAvg, 1) + '</td>' +
        '<td class="fuel-cell-status">' + status + '</td>' +
      '</tr>';
    }).join('') || ('<tr><td colspan="' + COLS.length + '" class="u-text-mute" ' +
      'style="text-align:center;padding:16px">Tidak ada jendela berstatus ' +
      '<strong>' + esc((VERDICT_META[vFilter] || {}).label || String(vFilter || '')) + '</strong> — ' +
      'klik chip status itu lagi untuk menampilkan semua jendela.</td></tr>');

    var shown = sorted.length, total = res.windows.length;
    var layak = allWins.length;
    if (note) {
      note.textContent = vFilter
        ? 'Menampilkan ' + shown + ' jendela berstatus ' +
          ((VERDICT_META[vFilter] || {}).label || vFilter) + ' dari ' + layak +
          ' jendela layak (' + total + ' jendela terbentuk). Diurutkan dari deviasi terbesar.'
        : 'Menampilkan ' + shown + ' jendela layak dari ' + total +
          ' jendela terbentuk. Diurutkan dari deviasi terbesar.';
    }
  }

  /* -----------------------------------------------------------------------
   * CHART L/TKM + RIBBON MEDIAN/MAD  (F5b, 2026-10-28)
   *
   * Dua lapis, sengaja DIPISAH:
   *   chartModel(res)  — MURNI, tanpa Chart.js, tanpa DOM. Bisa diuji di Node.
   *   renderChart(res) — hanya menyerahkan model ke Chart.js.
   *
   * Aturan waktu: titik DIURUTKAN menurut `t` (bukan menurut z seperti tabel).
   * Jendela gugur TIDAK diisi/dipadatkan — jarak antar titik memperlihatkan
   * gap apa adanya. Memadatkan gap membuat grafik terlihat kontinu padahal
   * data hilang beberapa minggu.
   * --------------------------------------------------------------------- */
  var _chart = null;

  function chartModel(res) {
    var out = { points: [], median: null, cautionLimit: null, overLimit: null };
    if (!res || !res.windows) return out;
    var lc = res.limits || (global.FUEL_ANALYTICS && global.FUEL_ANALYTICS.LIMITS) || { zCaution: 2, zOver: 3 };
    var pts = res.windows.filter(function (w) {
      return w.verdictable && w.lTk != null && isFinite(w.lTk) && w.lTk > 0;
    }).sort(function (a, b) { return a.t1 - b.t1; });
    out.points = pts.map(function (w) {
      return {
        // `t1` = waktu RECORD penutup jendela. Jendela tidak punya field `t`;
        // memakai `w.t` menghasilkan NaN dan sumbu waktu rusak tanpa error.
        t: w.t1, date: w.date, lTk: w.lTk,
        // Sengaja MENYALIN verdict dari analitik, tidak menghitung ulang:
        // dua implementasi vonis = risiko menyimpang (kelas `FUEL-b`).
        verdict: w.verdict || null,
        driver: w.driver || null
      };
    });
    // Baseline bisa null (belum layak) atau "datar" (sigma di bawah lantai).
    // Dalam kedua kasus JANGAN gambar garis — garis median palsu lebih buruk
    // daripada tidak ada garis.
    var b = res.baseline && res.baseline.lTk;
    if (res.usable && b && b.median > 0 && isFinite(b.sigma) && !b.flat) {
      out.median = b.median;
      out.cautionLimit = b.median * Math.exp(lc.zCaution * b.sigma);
      out.overLimit = b.median * Math.exp(lc.zOver * b.sigma);
    }
    return out;
  }

  function _destroyChart() {
    var Chart = global.Chart;
    var canvas = $id('fuel-trend-chart');
    var mine = _chart;
    if (mine && typeof mine.destroy === 'function') {
      try { mine.destroy(); } catch (e) { /* ok */ }
    }
    _chart = null;
    // Bersihkan instance yang mungkin tersisa di canvas (mis. setelah
    // area disembunyikan/ditampilkan ulang). WAJIB dibandingkan identitas:
    // `Chart.getChart()` bisa mengembalikan instance YANG SAMA dengan `_chart`,
    // dan men-destroy dua kali membuat Chart.js melempar di tengah render.
    if (Chart && canvas && typeof Chart.getChart === 'function') {
      try {
        var old = Chart.getChart(canvas);
        if (old && old !== mine) old.destroy();
      } catch (e) { /* ok */ }
    }
  }

  function renderChart(res) {
    var panel = $id('fuel-chart-panel');
    var canvas = $id('fuel-trend-chart');
    var Chart = global.Chart;
    var m = chartModel(res);

    // Output chart INSET untuk PDF tanpa merusak tampilan normal — pelajaran
    // dari tiga ambang stuck yang berbeda di proyek ini: satu angka, satu tempat.
    // Panel opsional: yang menentukan adalah canvas + Chart.js. Memaksa panel
    // membuat renderer tak bisa diuji dan diam-diam melewatkan chart bila
    // markup berubah.
    _destroyChart();
    if (!canvas || !Chart || !m.points.length) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (panel) panel.style.display = '';

    var labels = m.points.map(function (p) { return p.date; });
    var data = m.points.map(function (p) { return p.lTk; });
    var colors = m.points.map(function (p) {
      var meta = p.verdict ? VERDICT_META[p.verdict] : null;
      return meta ? meta.color : 'rgba(148,163,184,.85)';
    });
    function flat(y, color, dash, label) {
      return {
        label: label, type: 'line',
        data: data.map(function () { return y; }),
        borderColor: color, borderWidth: 1, borderDash: dash,
        pointRadius: 0, pointHoverRadius: 0, fill: false, tension: 0, order: 0
      };
    }
    var datasets = [{
      label: 'L / ton-km', type: 'scatter',
      data: data, backgroundColor: colors, borderColor: colors,
      pointRadius: 3, pointHoverRadius: 6, order: 1
    }];
    if (m.median != null) {
      datasets.push(flat(m.median, '#94a3b8', [], 'Median'));
      datasets.push(flat(m.cautionLimit, '#f59e0b', [6, 4], 'Batas Caution (z=2)'));
      datasets.push(flat(m.overLimit, '#f87171', [6, 4], 'Batas Over (z=3)'));
    }

    _chart = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0] ? items[0].label : ''; },
              label: function (it) {
                var p = m.points[it.dataIndex];
                if (!p) return '';
                var v = p.verdict ? (VERDICT_META[p.verdict] || {}).label : 'tanpa verdict';
                return 'L/ton-km ' + num(p.lTk, 4) + '  ·  ' + v +
                  (p.driver ? ' (' + (DRIVER_LABEL[p.driver] || p.driver) + ')' : '');
              }
            }
          }
        },
        scales: {
          x: { type: 'category', ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'L / ton-km', font: { size: 11 } } }
        }
      }
    });
    return _chart;
  }

  /* -----------------------------------------------------------------------
   * BASELINE CARDS + WATERFALL  (permintaan user 2026-10-28)
   *
   * Keduanya MURNI (tanpa DOM) supaya bisa diuji di Node. Renderer hanya
   * menempelkan hasilnya ke halaman.
   * --------------------------------------------------------------------- */

  var CARD_META = {
    lTk: {
      label: 'L / ton-km', unit: 'L/ton-km', d: 4, accent: '#22d3ee',
      note: 'Angka yang dipakai verdict',
      formula: 'L/TKM = L / Σ(P·dL)'
    },
    lGt: {
      label: 'L / GTKM', unit: 'L/ton-km', d: 4, accent: '#38bdf8',
      note: 'Mesin + kondisi jalan',
      formula: 'L/GTKM = L / (Σ(Me+P)·dL + Σ Me·dE)'
    },
    penalty: {
      label: 'GTKM / TKM', unit: '×', d: 3, accent: '#f59e0b',
      note: 'Penalti underload',
      formula: 'GTKM/TKM = (Σ(Me+P)·dL + Σ Me·dE) / Σ(P·dL)'
    }
  };

  function _series(res, key) {
    return ((res && res.windows) || []).filter(function (w) {
      return w.verdictable && w[key] != null && isFinite(w[key]) && w[key] > 0;
    }).map(function (w) { return w[key]; });
  }

  /**
   * baselineCards(res) — data kartu interaktif untuk Baseline Unit.
   * @returns {Array<{key,label,value,unit,sigma,flat,note,formula,detail}>}
   *          `[]` bila baseline belum layak (JANGAN mengarang angka 0).
   */
  function baselineCards(res) {
    if (!res || !res.baseline) return [];
    return ['lTk', 'lGt', 'penalty'].map(function (key) {
      var meta = CARD_META[key], b = res.baseline[key];
      if (!b) return null;
      var s = _series(res, key).sort(function (a, b2) { return a - b2; });
      var n = s.length;
      var detail = {
        n: n,
        min: n ? s[0] : null,
        p25: n ? s[Math.floor((n - 1) * 0.25)] : null,
        p50: n ? s[Math.floor((n - 1) * 0.5)] : null,
        p75: n ? s[Math.floor((n - 1) * 0.75)] : null,
        max: n ? s[n - 1] : null
      };
      return {
        key: key, label: meta.label, unit: meta.unit, d: meta.d,
        accent: meta.accent, note: meta.note, formula: meta.formula,
        value: b.median, sigma: b.sigma, flat: !!b.flat,
        detail: detail
      };
    }).filter(Boolean);
  }

  /**
   * waterfall(res) — dekomposisi L/TKM sebagai air terjun.
   *
   *   L/GTKM  ×  GTKM/TKM  =  L/TKM
   *   (mesin)    (underload)
   *
   * Langkah 1 = `total` (puncak), langkah 2 = `delta` (penalti), langkah 3
   * = `total` (hasil). `starts`/`ends` disediakan agar renderer tidak perlu
   * menghitung ulang tangga air terjun (dua implementasi = risiko menyimpang).
   *
   * Baseline datar / belum layak -> steps KOSONG. Menggambar dekomposisi
   * dari baseline yang tidak dipakai untuk vonis = angka tanpa dasar.
   */
  function waterfall(res) {
    var out = { steps: [], median: null, cautionLimit: null, overLimit: null };
    if (!res || !res.usable || !res.baseline) return out;
    var b = res.baseline;
    if (!b.lGt || !b.penalty || !b.lTk) return out;
    if (b.lGt.flat || b.penalty.flat || b.lTk.flat) return out;
    var lGt = b.lGt.median, pen = b.penalty.median, lTk = b.lTk.median;
    if (!(lGt > 0 && pen > 0 && lTk > 0)) return out;

    var lc = res.limits || (global.FUEL_ANALYTICS && global.FUEL_ANALYTICS.LIMITS) || {};
    out.median = lTk;
    out.cautionLimit = lTk * Math.exp((lc.zCaution || 2) * b.lTk.sigma);
    out.overLimit = lTk * Math.exp((lc.zOver || 3) * b.lTk.sigma);
    out.steps = [
      { key: 'lGt', kind: 'total', value: lGt, start: 0, end: lGt,
        label: 'L / GTKM', note: 'mesin + kondisi jalan', color: '#38bdf8' },
      { key: 'penalty', kind: 'delta', value: pen, start: lGt, end: lTk,
        label: 'Penalti underload', note: 'GTKM/TKM = ' + num(pen, 3) + '×', color: '#f59e0b' },
      { key: 'lTk', kind: 'total', value: lTk, start: 0, end: lTk,
        label: 'L / ton-km', note: 'hasil akhir', color: '#22d3ee' }
    ];
    return out;
  }

  /** Tabel penjelasan legenda + pemakaian formula (boleh diklip untuk UI). */
  function formulaHelp() {
    return {
      legend: [
        { color: '#38bdf8', label: 'L / GTKM', text: 'Liter per ton-km bruto — mesin, transmisi, dan kondisi jalan (tanpa penalti muatan).' },
        { color: '#f59e0b', label: 'Penalti underload', text: 'Kenaikan karena membawa bobot kosong (Me) dan muatan kecil. Angka > 1 artinya mengangkut bobot yang tidak menghasilkan ton-km.' },
        { color: '#22d3ee', label: 'L / ton-km', text: 'Hasil akhir — liter per ton-km muatan. Inilah rasio yang bermakna antar rute.' }
      ],
      formulas: [
        { name: 'Liter per jendela', expr: 'L = Fuel Rate (L/h) × ΔSMR (h)' },
        { name: 'Ton-km muatan', expr: 'TKM = Σ P · dL' },
        { name: 'Ton-km bruto', expr: 'GTKM = Σ (Me + P) · dL + Σ Me · dE' },
        { name: 'Dekomposisi', expr: 'L/TKM = (L/GTKM) × (GTKM/TKM)' },
        { name: 'Verdict (log/MAD)', expr: 'z = (ln r − median ln r) / (1,4826 · MAD ln r)' }
      ],
      thresholds: [
        { label: 'Caution', text: 'z ≥ 2 (≈ +2σ log)' },
        { label: 'Over', text: 'z ≥ 3 (≈ +3σ log)' }
      ]
    };
  }

  /* -----------------------------------------------------------------------
   * renderBaselineCards(res) — kartu interaktif (klik untuk detail).
   * --------------------------------------------------------------------- */
  function renderBaselineCards(res) {
    var host = $id('fuel-baseline-cards');
    var panel = $id('fuel-summary-panel');
    if (!host) return;
    var cards = baselineCards(res);
    if (!cards.length) {
      host.innerHTML = '<p class="u-text-mute" style="font-size:12px;margin:0">' +
        'Baseline belum layak — kartu tidak diterbitkan.</p>';
      return;
    }
    host.innerHTML = cards.map(function (c) {
      var d = c.detail;
      var tip = d.n
        ? 'n=' + d.n + ' · min ' + num(d.min, c.d) + ' · p25 ' + num(d.p25, c.d) +
          ' · median ' + num(d.p50, c.d) + ' · p75 ' + num(d.p75, c.d) + ' · max ' + num(d.max, c.d)
        : '';
      return '<button type="button" class="fuel-card" data-fuel-card="' + esc(c.key) + '"' +
        ' style="--fuel-accent:' + c.accent + '"' +
        ' title="' + esc(c.note) + ' — klik untuk detail">' +
        '<span class="fuel-card-label">' + esc(c.label) + '</span>' +
        '<span class="fuel-card-value">' + num(c.value, c.d) +
          '<small>' + esc(c.unit) + '</small></span>' +
        '<span class="fuel-card-meta">' + (c.flat
          ? '<span class="fuel-card-flag">σ datar — tidak menvonis</span>'
          : 'σ(log) ' + num(c.sigma, 4)) + '</span>' +
        '<span class="fuel-card-note">' + esc(c.note) + '</span>' +
        '<span class="fuel-card-detail" hidden>' +
          '<span class="fuel-card-eq">' + esc(c.formula) + '</span><br>' +
          esc(tip) +
        '</span>' +
      '</button>';
    }).join('');
  }

  /* -----------------------------------------------------------------------
   * renderWaterfall(res) — chart air terjun L/TKM (Chart.js bar float).
   *
   * Chart.js tidak punya tipe "waterfall", jadi dipakai `bar` dengan
   * `[y, y+h]` (bar mengapung). `waterfall()` sudah menyiapkan start/end;
   * di sini TIDAK dihitung ulang.
   * --------------------------------------------------------------------- */
  var _wfChart = null;

  function _destroyOne(which, id) {
    var Chart = global.Chart;
    var canvas = $id(id);
    var mine = which === 'wf' ? _wfChart : _corrChart;
    if (mine && typeof mine.destroy === 'function') {
      try { mine.destroy(); } catch (e) { /* ok */ }
    }
    if (Chart && canvas && typeof Chart.getChart === 'function') {
      try {
        var old = Chart.getChart(canvas);
        if (old && old !== mine) old.destroy();
      } catch (e) { /* ok */ }
    }
    if (which === 'wf') _wfChart = null; else _corrChart = null;
  }

  function renderWaterfall(res) {
    var panel = $id('fuel-waterfall-panel'), canvas = $id('fuel-waterfall-chart');
    var note = $id('fuel-waterfall-note');
    var Chart = global.Chart;
    var wf = waterfall(res);
    _destroyOne('wf', 'fuel-waterfall-chart');
    if (!canvas || !Chart || !wf.steps.length) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (panel) panel.style.display = '';

    var steps = wf.steps;
    var floats = steps.map(function (s) {
      // 100 % dari langkah 1 ke langkah 3 bukan "naik dari nol" — bar
      // mengapung mulai dari `start`. Delta bisa NEGATIF (penalti < 1:
      // muatan lebih berat dari bobot kosong) -> tangga turun.
      var lo = Math.min(s.start, s.end), hi = Math.max(s.start, s.end);
      return [lo, hi];
    });
    // Warna: langkah `total` (awal & hasil) memakai warna metriknya,
    // langkah `delta` (penalti) memakai amber — sama dengan legenda.
    var colors = steps.map(function (s) {
      if (s.kind !== 'total') return 'rgba(245,158,11,.85)';
      return s.key === 'lGt' ? 'rgba(56,189,248,.85)' : 'rgba(34,211,238,.85)';
    });

    _wfChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: steps.map(function (s) { return s.label; }),
        datasets: [{
          label: 'L / ton-km',
          data: floats,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (it) {
                var s = steps[it.dataIndex];
                if (!s) return '';
                return s.kind === 'total'
                  ? s.label + ': ' + num(s.value, 5)
                  : 'Penalti ×' + num(s.value, 3) + '  →  ' + num(s.start, 5) +
                    ' → ' + num(s.end, 5);
              },
              afterLabel: function (it) {
                var s = steps[it.dataIndex];
                return s ? s.note : '';
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            beginAtZero: true,
            title: { display: true, text: 'L / ton-km', font: { size: 11 } }
          }
        }
      }
    });
    if (note) {
      note.textContent = 'L/GTKM ' + num(wf.steps[0].value, 5) + '  ×  GTKM/TKM ' +
        num(wf.steps[1].value, 3) + '  =  L/TKM ' + num(wf.steps[2].value, 5) +
        '   ·   batas Caution ' + num(wf.cautionLimit, 5) +
        ' · Over ' + num(wf.overLimit, 5);
    }
  }

  /* -----------------------------------------------------------------------
   * renderCorrelation(corr, daysCount) — chart harian raw payload × trend0.
   *
   * Dua panel dalam satu canvas: (a) garis L/TKM harian + garis tren,
   * (b) scatter muatan vs L/TKM (pembuktian bahwa rasio per ton-km tidak
   * dihukum oleh muatan besar).
   * --------------------------------------------------------------------- */
  var _corrChart = null;

  function renderCorrelation(corr) {
    var panel = $id('fuel-corr-panel'), canvas = $id('fuel-corr-chart');
    var note = $id('fuel-corr-note'), badge = $id('fuel-corr-verdict');
    var Chart = global.Chart;
    _destroyOne('corr', 'fuel-corr-chart');
    if (!corr || !corr.points || corr.points.length < 2 || !canvas || !Chart) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (panel) panel.style.display = '';

    var labels = corr.points.map(function (p) { return p.day; });
    var vals = corr.points.map(function (p) { return p.lTk; });
    // Garis tren dieksponensialkan kembali dari regresi log agar tampil
    // sebagai garis lurus di skala LINEAR nilai L/TKM.
    var trendLine = null;
    if (corr.slope != null) {
      var y0 = Math.log(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
      trendLine = vals.map(function (v, i) {
        var days = i - (vals.length - 1) / 2;
        return Math.exp(y0 + corr.slope * days);
      });
    }

    var datasets = [{
      label: 'L / ton-km harian', type: 'line',
      data: vals, borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,.12)',
      pointRadius: 2.5, pointHoverRadius: 5, tension: 0.25, fill: true, order: 2
    }];
    if (trendLine) {
      datasets.push({
        label: 'Garis tren', type: 'line', data: trendLine,
        borderColor: corr.trend === 'worse' ? '#f87171' : (corr.trend === 'better' ? '#34d399' : '#94a3b8'),
        borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false, order: 1
      });
    }

    _corrChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function (it) {
                var p = corr.points[it.dataIndex];
                if (!p) return '';
                return 'L/ton-km ' + num(p.lTk, 4) + ' · ' + num(p.fuel, 0) + ' L · ' +
                  num(p.payload, 0) + ' t · ' + num(p.loadedKm, 1) + ' km';
              }
            }
          }
        },
        scales: {
          x: { ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 20, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'L / ton-km', font: { size: 11 } } }
        }
      }
    });

    if (badge) {
      var meta = {
        worse: ['BOROS', 'is-critical'],
        better: ['HEMAT', 'is-normal'],
        stable: ['STABIL', 'is-warning']
      };
      if (corr.verdictable && corr.trend && meta[corr.trend]) {
        badge.innerHTML = '<span class="badge ' + meta[corr.trend][1] + '">' +
          meta[corr.trend][0] + '</span>';
      } else {
        badge.innerHTML = '<span class="u-text-mute" style="font-size:11px">tanpa verdict</span>';
      }
    }
    if (note) {
      var txt = corr.points.length + ' hari harian ter-join';
      if (corr.slopePctPerDay != null) {
        txt += ' · perubahan ' + num(corr.slopePctPerDay, 3) + ' %/hari' +
          ' (≈ ' + num(corr.slopePctPerDay * 30, 1) + ' %/bulan)';
      }
      // R² SELALU didampingi n: R² dari 3 titik hampir pasti tinggi dan
      // tanpa n operator tak punya cara menilai keandalannya. [F1 2026-11-07]
      if (corr.r2 != null) {
        txt += ' · R² ' + num(corr.r2, 2) + ' (n=' + (corr.n || corr.points.length) + ')';
      } else if (corr.rReason) {
        txt += ' · R² tak terdefinisi (' + corr.rReason + ')';
      }
      // Sebab gugur DIPISAH agar jujur: hari A0 yang tidak punya pasangan
      // jendela trend0 bukan "data rusak", melainkan hari di luar cakupan.
      if (corr.dropNoFuel) txt += ' · ' + corr.dropNoFuel + ' hari tanpa pasangan trend0';
      if (corr.dropNoData) txt += ' · ' + corr.dropNoData + ' hari tanpa payload/km/jam';
      if (corr.reason && !corr.verdictable) txt += ' · ' + corr.reason;
      note.textContent = txt;
    }
  }

  /* -----------------------------------------------------------------------
   * renderCompareChart(model) — bar berpasangan Sebelum vs Sesudah.
   *
   * Dipisah dari `compareChartModel()` (murni, teruji di Node) supaya Chart.js
   * hanya dibutuhkan di peramban.
   * --------------------------------------------------------------------- */
  var _cmpChart = null;

  function renderCompareChart(model) {
    var canvas = $id('fuel-cmp-chart');
    var Chart = global.Chart;
    if (_cmpChart && typeof _cmpChart.destroy === 'function') {
      try { _cmpChart.destroy(); } catch (e) { /* ok */ }
    }
    if (Chart && canvas && typeof Chart.getChart === 'function') {
      try {
        var old = Chart.getChart(canvas);
        if (old && old !== _cmpChart) old.destroy();
      } catch (e) { /* ok */ }
    }
    _cmpChart = null;
    if (!canvas || !Chart || !model || !model.labels.length) return;

    _cmpChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      // [F1 2026-10-29] SPLINE "Trending" DIHAPUS. Garis itu menghubungkan
      // NILAI B antar unit (HDKM78612 -> 78524 -> 78468), sehingga tampak
      // seperti deret waktu yang naik lalu turun. Unit BUKAN deret waktu —
      // urutannya pun cuma hasil sortir Δ%, jadi lengkungan itu tidak
      // menyatakan apa pun tentang tren. Perubahan A->B sudah dibaca dari
      // pasangan bar + kolom Δ% di tabel.
      data: {
        labels: model.labels,
        datasets: [
          { label: 'Sebelum', data: model.before,
            backgroundColor: 'rgba(148,163,184,.75)', borderColor: '#94a3b8',
            borderWidth: 1, borderRadius: 3 },
          { label: 'Sesudah', data: model.after,
            // Warna per bar = vonis unit itu, sehingga "lebih boros" terlihat
            // tanpa membaca tabel.
            backgroundColor: model.verdicts.map(function (v) {
              return v === 'BOROS' ? 'rgba(248,113,113,.85)'
                : (v === 'HEMAT' ? 'rgba(52,211,153,.85)' : 'rgba(245,158,11,.85)');
            }),
            borderWidth: 1, borderRadius: 3 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterBody: function (items) {
                var r = model.rows[items[0].dataIndex];
                if (!r) return '';
                return [
                  (r.deltaPct < 0 ? '\u25BC ' : '\u25B2 ') + num(Math.abs(r.deltaPct), 1) +
                    ' % \u00b7 ' + (CMP_META[r.verdict] ? CMP_META[r.verdict].label : ''),
                  // [F0] Pita disebut sebagai RENTANG, bukan `±x %`: batas atas
                  // dan bawah berbeda (e^σ − 1 vs 1 − e^−σ).
                  'pita derau unit \u2212' + num(r.bandDown, 1) + ' % \u2026 +' + num(r.bandUp, 1) + ' %',
                  r.aWindows + ' \u2192 ' + r.bWindows + ' baris data'
                ];
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 60, autoSkip: false } },
          y: { beginAtZero: true, title: { display: true, text: 'L / ton-km', font: { size: 11 } } }
        }
      }
    });
  }

  /* -----------------------------------------------------------------------
   * FLEET — TABEL "TRENDING FUEL RATIO LIST"  (permintaan user 2026-10-28)
   *
   * MURNI: menerima daftar unit {serial, model, updatedAt, result|summary}
   * lalu menghasilkan baris tabel. Tanpa DOM, tanpa store.
   * --------------------------------------------------------------------- */

  function _pct(counts, key) {
    var t = (counts.NORMAL || 0) + (counts.CAUTION || 0) + (counts.OVER || 0);
    return t ? ((counts[key] || 0) / t) : null;
  }

  /** Ambil ringkasan yang seragam dari unit (hasil analyze() ATAU summary). */
  function _summaryOf(unit) {
    if (!unit) return null;
    if (unit.result) {
      var r = unit.result;
      var ok = !!(r.baseline && r.usable);
      return {
        ready: !!r.ready, usable: !!r.usable, hasBaseline: ok,
        baseline: r.baseline || null,
        eligible: r.eligible || 0,
        counts: r.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 },
        warnings: r.warnings || [],
        model: r.model || (unit.model || '')
      };
    }
    if (unit.summary) {
      var s = unit.summary;
      return {
        ready: !!s.ready, usable: !!s.usable,
        // `usable` tidak ada di data v1 -> dianggap TIDAK dipakai untuk vonis
        // (konservatif). Lebih baik "tanpa verdict" daripada angka palsu.
        hasBaseline: !!(s.baseline && s.usable),
        baseline: s.baseline || null,
        eligible: s.eligible || 0,
        counts: s.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 },
        warnings: s.warnings || [],
        model: s.model || (unit.model || '')
      };
    }
    return null;
  }

  /**
   * flagStats(unit, verdict) — rentang z jendela ber-verdict tertentu.
   *
   * MURNI. Dipakai kolom "Result" agar kalimatnya menyebut RENTANG z yang
   * benar-benar memicu (bukan hanya jumlah). Hanya membaca jendela yang
   * punya verdict SAMA — jendela CAUTION tidak boleh memperlebar rentang OVER.
   * @returns {{min:number|null, max:number|null}}
   */
  function flagStats(unit, verdict, winsOverride) {
    var wins = winsOverride || (unit && unit.result && unit.result.windows) ||
      (unit && unit.summary && unit.summary.windows) || [];
    var min = null, max = null;
    wins.forEach(function (w) {
      if (!w || w.verdict !== verdict) return;
      if (w.z == null || !isFinite(w.z)) return;
      if (min == null || w.z < min) min = w.z;
      if (max == null || w.z > max) max = w.z;
    });
    return { min: min, max: max };
  }

  /**
   * dominantDriver(unit) — pemicu yang paling sering muncul di jendela
   * CAUTION/OVER milik unit ini ('engine' | 'underload' | null).
   *
   * Sumber: `driver` per jendela (sudah dihitung `classify()` dari z mesin vs
   * z beban). Unit terstore yang ringkasannya tidak membawa `driver` tetap
   * dapat nilainya karena `fromSummary()` menghitung ulang dari z.
   * Null bila tidak ada jendela ber-flag atau kedua penyebab imbang — lebih
   * baik tanpa klaim daripada memilih pemenang yang tidak jelas.
   */
  function dominantDriver(unit, winsOverride) {
    var wins = winsOverride || (unit && unit.result && unit.result.windows) ||
      (unit && unit.summary && unit.summary.windows) || [];
    var tally = { engine: 0, underload: 0 };
    wins.forEach(function (w) {
      if (!w || !w.driver) return;
      if (tally[w.driver] == null) return;
      tally[w.driver]++;
    });
    if (!tally.engine && !tally.underload) return null;
    if (tally.engine === tally.underload) return null;
    return tally.engine > tally.underload ? 'engine' : 'underload';
  }

  /* ---------------------------------------------------------------------
   * RENTANG TANGGAL [2026-10-28]
   *
   * Sebelumnya tanggal hanya menyembunyikan BARIS; angka di dalam baris tetap
   * angka seluruh berkas, sehingga "1 bulan" dan "2 tahun" menampilkan tonase
   * yang sama. Sekarang setiap angka DIHITUNG ULANG dari data bertanggal.
   *
   * Sumber yang bertanggal dan IKUT TERSIMPAN (fuel-store `compact()`):
   *   - `windows[]`     : satu jendela per pasang record trend0, punya `date`,
   *                       `dSmr`, `fuelRate`, `n`, `payloadAvg`, `lTk`, `lGt`,
   *                       `penalty`, `z`, `verdict`, `driver`.
   *   - `trendSeries[]` : `{smr, date}` per record trend0 -> SMR awal/akhir.
   *
   * BATAS YANG DIAKUI JUJUR: siklus mentah pldcyc TIDAK disimpan. Dalam
   * rentang, Total Tonnage/Total Cycle diturunkan dari jendela VALID
   * (sum n, sum n x payloadAvg) — basisnya BERBEDA dari angka seluruh berkas
   * yang menghitung semua siklus termasuk yang gugur gerbang. Karena itu
   * baris ber-rentang diberi tanda `scoped:true` dan UI menyebut basisnya,
   * bukan diam-diam menyamakan dua angka yang tidak sebanding.
   *
   * Baseline (median+sigma) TIDAK dihitung ulang: verdict per jendela adalah
   * hasil perbandingan dengan riwayat unit itu sendiri. Mengikutkan baseline
   * pada rentang tampilan membuat unit boros terlihat normal hanya karena
   * rentangnya dipersempit. Yang ikut rentang adalah MEDIAN YANG DITAMPILKAN.
   * ------------------------------------------------------------------- */
  function _inRange(d, a, b) {
    if (!d) return false;
    if (a && d < a) return false;
    if (b && d > b) return false;
    return true;
  }

  function unitWindows(unit) {
    return (unit && unit.result && unit.result.windows) ||
      (unit && unit.summary && unit.summary.windows) || [];
  }

  function unitSeries(unit) {
    return (unit && unit.result && unit.result.trendSeries) ||
      (unit && unit.summary && unit.summary.trendSeries) || [];
  }

  /** Rekap siklus pldcyc per tanggal `{date,n,ton}` — null bila tidak ada. */
  function unitCycleDaily(unit) {
    return (unit && unit.result && unit.result.cycleDaily) ||
      (unit && unit.summary && unit.summary.cycleDaily) || null;
  }

  /**
   * _dayCount(wins) — jumlah HARI KALENDER unik yang diwakili jendela.
   * Jendela tanpa tanggal sah tidak dihitung (tidak dikarang jadi 1 hari).
   */
  function _dayCount(wins) {
    var seen = {}, n = 0;
    (wins || []).forEach(function (w) {
      var d = String((w && w.date) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen[d]) return;
      seen[d] = 1; n++;
    });
    return n;
  }

  /**
   * _med2(arr) — median nilai BERTANDA. Berbeda dari `_med()` yang sengaja
   * membuang nilai <= 0 (rasio L/ton-km tidak pernah nol).
   *
   * [F7' 2026-10-29] Dibutuhkan untuk median Δ%: −11,8 % adalah nilai yang
   * SAH dan justru yang paling ingin dilihat. Memakai `_med()` di sana akan
   * membuang seluruh unit yang membaik, lalu melaporkan armada memburuk.
   */
  function _med2(arr) {
    var v = (arr || []).filter(function (x) {
      return x != null && isFinite(x);
    }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = v.length >> 1;
    return (v.length % 2) ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /** Median nilai positif. null bila tak ada angka — JANGAN 0. */
  function _med(arr) {
    var v = (arr || []).filter(function (x) {
      return x != null && isFinite(x) && x > 0;
    }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = v.length >> 1;
    return (v.length % 2) ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /**
   * scopeUnit(unit, start, end) — agregat unit DI DALAM rentang tanggal.
   * MURNI. Mengembalikan null bila rentang tidak aktif (tidak ada scoping).
   * @param {string} [start] 'YYYY-MM-DD'
   * @param {string} [end]   'YYYY-MM-DD'
   */
  function scopeUnit(unit, start, end) {
    if (!start && !end) return null;
    // HANYA jendela yang LAYAK VERDICT. `result.windows` dari analisis langsung
    // juga memuat jendela yang GUGUR gerbang (coverage rendah, siklus kurang);
    // mengikutkannya membuat angka rentang tidak setara dengan angka tanpa
    // rentang, dan menaikkan tonase dari jendela yang sengaja dibuang.
    var wins = unitWindows(unit).filter(function (w) {
      return w && w.verdictable === true &&
        _inRange(String(w.date || '').slice(0, 10), start, end);
    });
    var series = unitSeries(unit).filter(function (x) {
      return _inRange(x && x.date, start, end);
    });

    var counts = { NORMAL: 0, CAUTION: 0, OVER: 0 };
    var eligible = 0, frSum = 0, frN = 0, cyc = 0, ton = 0, tonOk = false;
    wins.forEach(function (w) {
      eligible++;
      if (w.verdict && counts[w.verdict] != null) counts[w.verdict]++;
      var fr = (w.fuelRate == null ? w.Lh : w.fuelRate);
      if (fr != null && isFinite(fr) && fr > 0) { frSum += fr; frN++; }
      var n = Number(w.n);
      var p = Number(w.payloadAvg == null ? w.pavg : w.payloadAvg);
      if (isFinite(n) && n > 0) {
        cyc += n;
        if (isFinite(p) && p > 0) { ton += n * p; tonOk = true; }
      }
    });

    /* Qty siklus & tonase: SUMBER UTAMA adalah rekap harian pldcyc
     * (`cycleDaily`), karena definisinya SAMA PERSIS dengan angka tanpa
     * rentang (`totalCycleCount` / `totalCyclePayload`): setiap siklus
     * berpayload > 0, bukan hanya siklus di dalam jendela yang lolos gerbang.
     * Jumlah seluruh hari = angka total -> memilih "semua tanggal" dan tidak
     * memfilter memberi angka yang identik.
     *
     * `cycFromWin` dipakai HANYA sebagai cadangan untuk unit yang disimpan
     * SEBELUM rekap ini ada. Basisnya berbeda (lebih kecil) dan itu disebut
     * di UI lewat `cycleBasis`, bukan disamarkan. */
    var cycFromWin = cyc, tonFromWin = tonOk ? ton : null;
    var daily = unitCycleDaily(unit), cycleBasis = 'window';
    if (daily) {
      var dn = 0, dt = 0, hit = 0;
      /* [FIX 2026-10-30] DITULIS ULANG DENGAN GUARD EKSPLISIT.
       *
       * Baris lama berbunyi:
       *     if (!d || !_inRange(d.date, start, end)) return;
       *     hit++;
       * `_inRange` sendiri sudah menolak tanggal kosong, jadi tertutup
       * secara logika — tetapi bentuk"!x || !fn()" di dalam callback
       * forEach adalah pola yang SULIT diperiksa ulang (dan pernah terbukti
       * lolos di satu jalur pemanggilan saat diuji dengan harness berbeda).
       * Semua yang mencapai `hit++` di bawah ini SUDAH dijamin punya
       * `date` berupa string; tidak ada jalan masuk yang melewatkan saringan. */
      daily.forEach(function (d) {
        if (!d || typeof d.date !== 'string' || !d.date) return;
        if (!_inRange(d.date, start, end)) return;
        hit++;
        if (isFinite(Number(d.n))) dn += Number(d.n);
        if (isFinite(Number(d.ton))) dt += Number(d.ton);
      });
      cycleBasis = 'cycle';
      cyc = dn;
      ton = dt;
      tonOk = hit > 0 && dt > 0;
    }

    // SMR awal/akhir dari deret trend0 (record, bukan jendela) — identitas
    // berkas, sama definisinya dengan `trendExtent()` pada mode tanpa filter.
    var smrs = series.map(function (x) { return x.smr; })
      .filter(function (v) { return v != null && isFinite(v); });
    var ext = null, extApprox = false;
    if (smrs.length) {
      var a = Math.min.apply(Math, smrs), b = Math.max.apply(Math, smrs);
      if (b > a) ext = { smrStart: a, smrEnd: b, hours: b - a, n: smrs.length };
    }
    /* [FALLBACK 2026-10-29] Record trend0 TIDAK harian (~20 h SMR antar
     * record). Rentang sempit bisa memuat 0–1 record, sehingga SMR Awal/Akhir
     * kosong padahal Total Operation terisi dari jendela — pembacaan yang
     * tidak utuh. Cadangan: pakai record TERDEKAT di luar rentang sebagai
     * jangkar. Hasilnya PERKIRAAN (cakupan record melebihi rentang), karena
     * itu ditandai `extApprox` dan disebut di UI, bukan disamarkan. */
    // Jam operasi dari jendela di DALAM rentang — lebih tepat daripada ΔSMR
    // record jangkar yang melebihi rentang.
    var winH = 0;
    wins.forEach(function (w) {
      var d = Number(w.dSmr);
      if (isFinite(d) && d > 0) winH += d;
    });
    if (!ext) {
      var seq = unitSeries(unit).filter(function (x) {
        return x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '').slice(0, 10)) &&
          x.smr != null && isFinite(x.smr);
      }).sort(function (p, q) { return String(p.date).localeCompare(String(q.date)); });
      if (seq.length >= 2) {
        // Jangkar = record terakhir <= start dan record pertama >= end.
        var lo = 0, hi = seq.length - 1, i;
        for (i = 0; i < seq.length; i++) {
          if (!start || String(seq[i].date).slice(0, 10) <= start) lo = i;
        }
        for (i = seq.length - 1; i >= 0; i--) {
          if (!end || String(seq[i].date).slice(0, 10) >= end) hi = i;
        }
        if (hi <= lo) { hi = lo + 1; if (hi > seq.length - 1) { hi = seq.length - 1; lo = hi - 1; } }
        var s0 = seq[lo].smr, s1 = seq[hi].smr;
        if (s1 > s0) {
          ext = {
            smrStart: s0, smrEnd: s1,
            hours: winH > 0 ? winH : (s1 - s0),
            n: hi - lo + 1
          };
          extApprox = true;
        }
      }
    }
    // Cadangan untuk unit tersimpan LAMA yang belum punya `trendSeries`:
    // jam operasi = jumlah dSmr jendela dalam rentang. SMR awal/akhir tetap
    // null — dikosongkan, bukan dikarang dari jendela.
    if (!ext && winH > 0) {
      ext = { smrStart: null, smrEnd: null, hours: winH, n: wins.length };
    }

    var dayHit = (daily || []).filter(function (d) {
      return d && _inRange(d.date, start, end);
    });

    var dates = wins.map(function (w) { return String(w.date || '').slice(0, 10); })
      .concat(series.map(function (x) { return x.date; }))
      .concat(dayHit.map(function (d) { return d.date; }))
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();

    return {
      scoped: true,
      wins: wins,
      counts: counts,
      eligible: eligible,
      // [2026-10-29] Jumlah HARI KALENDER berbeda yang diwakili baris-baris
      // itu. Satu record trend0 menutup ~20 h SMR, jadi "4 baris" bisa saja
      // 3 hari — dua angka yang berbeda arti, keduanya disebut, tidak dipukul
      // rata jadi satu.
      dayCount: _dayCount(wins),
      ext: ext,
      // true = SMR awal/akhir dari record TERDEKAT di luar rentang (jangkar),
      // bukan record di dalam rentang. Angkanya perkiraan -> disebut di UI.
      extApprox: extApprox,
      frAvg: frN ? frSum / frN : null,
      // [BUG 2026-10-30] `cyc || null` mengubah NOL menjadi "tidak ada".
      // Nol siklus adalah HASIL UKUR ("unit berhenti beroperasi"); null
      // berarti tak terdefinisi. Kolom pendukung membedakan keduanya naik
      // ke layar, jadi pembandengan ini harus dibuang. `tonOk` sudah menjadi
      // penjaga sendiri (rekap tanpa tonase tetap memberi null).
      cycleCount: (daily ? cyc : (cyc || null)),
      // `tonOk` sudah menjadi penjaga sendiri: rekap tanpa tonase -> null.
      // JANGAN `ton || null` — nol tonase bisa berarti "tidak mengangkut".
      totalCycle: tonOk ? ton : null,
      // `cycleBasis` = dari mana Qty Cycle/Tonase berasal:
      //   'cycle'  -> rekap siklus pldcyc per tanggal (SAMA dengan angka total)
      //   'window' -> cadangan dari jendela valid (unit simpanan lama; LEBIH
      //               KECIL dari angka total, dan itu disebut di UI)
      cycleBasis: cycleBasis,
      cycleCountWin: cycFromWin || null,
      totalCycleWin: tonFromWin,
      lTk: _med(wins.map(function (w) { return w.lTk; })),
      lGt: _med(wins.map(function (w) { return w.lGt; })),
      penalty: _med(wins.map(function (w) {
        return (w.penalty == null ? w.pen : w.penalty);
      })),
      dateStart: dates.length ? dates[0] : null,
      dateEnd: dates.length ? dates[dates.length - 1] : null,
      // `empty` = unit ini memang tidak beroperasi / tidak tercatat pada
      // rentang tsb. Dipakai untuk MENYEMBUNYIKAN baris, bukan menampilkan 0.
      // Hari bersiklus ikut dihitung: unit yang pldcyc-nya terisi tapi
      // jendelanya gugur gerbang TETAP punya data di rentang itu.
      empty: !wins.length && !series.length && !dayHit.length
    };
  }

  /**
   * ratioRows(units, mapCtx, range) — satu baris per unit.
   * @param {Array<Object>} units
   * @param {Object} [mapCtx] konteks pemetaan SN->lambung (`lambungContext()`).
   *   Bila tidak diberikan, pemetaan dibaca dari sumber global yang ada.
   * @param {{dateStart?:string, dateEnd?:string}} [range] rentang tanggal
   *   aktif. Bila diisi, SELURUH angka baris dihitung ulang untuk rentang itu
   *   (lihat catatan RENTANG TANGGAL di atas).
   * @returns {Array<Object>}
   */
  function ratioRows(units, mapCtx, range) {
    var ctxForLambung = mapCtx || lambungContext();
    var rs = (range && range.dateStart) || '';
    var re = (range && range.dateEnd) || '';
    return (units || []).map(function (u) {
      var s = _summaryOf(u);
      var lb = lambungOf(u.serial, ctxForLambung);
      // `sc` = agregat dalam rentang tanggal (null bila rentang tidak aktif).
      var sc = scopeUnit(u, rs, re);
      var c = (sc ? sc.counts : (s && s.counts)) || { NORMAL: 0, CAUTION: 0, OVER: 0 };
      var hasBase = !!(s && s.hasBaseline && s.baseline && s.baseline.lTk);
      // Dalam rentang, angka yang DITAMPILKAN adalah median jendela rentang
      // itu. Baseline vonis tetap baseline unit (lihat catatan di atas), jadi
      // `hasBase` tetap jadi syarat: tanpa baseline, angka terbit tanpa vonis.
      var lTk = sc
        ? sc.lTk
        : ((hasBase && s.baseline.lTk.median > 0) ? s.baseline.lTk.median : null);
      // Verdict unit = kondisi TERBURUK yang ditemukan, supaya satu baris bisa
      // dibaca tanpa membuka detail. Unit tanpa baseline -> null (bukan NORMAL).
      var verdict = null;
      if (hasBase && (!sc || sc.eligible > 0)) {
        verdict = c.OVER > 0 ? 'OVER' : (c.CAUTION > 0 ? 'CAUTION' : 'NORMAL');
      }
      var dateRange = sc
        ? { start: sc.dateStart, end: sc.dateEnd }
        : unitDateRange(u);
      // [2026-10-28] Cakupan berkas trend0 + Fuel Rate. Sumber: ANALYTICS
      // (`trendExtent`/`meanFuelRate`) untuk hasil baru; untuk unit tersimpan
      // lama dipakai `summary.trendExtent` yang DISIMPAN (bukan diturunkan).
      // [RESET 2026-10-29] Dipindah KE ATAS blok `reason`: alasan baseline
      // butuh `smrStart` untuk mengenali unit yang baru di-reset. Sebelumnya
      // deklarasi ini berada sesudahnya — `var` hoisting membuatnya `undefined`
      // (bukan error), jadi bug-nya akan senyap.
      var ext = (u.result && u.result.trendExtent) || (u.summary && u.summary.trendExtent) || null;
      var reason = '';
      if (!s) reason = 'Belum ada hasil analisis';
      else if (!s.ready) {
        reason = 'Baseline belum layak (' + s.eligible + ' jendela)';
        // SMR awal sangat rendah (atau berkasnya terbagi beberapa segmen) =
        // VHMS baru di-reset. Sebut JALAN KELUARNYA, jangan biarkan operator
        // menunggu 20 hari tanpa tahu ada opsi lain.
        var exS = ext && ext.smrStart != null ? ext.smrStart : null;
        var multiSeg = !!(ext && ext.segments > 1);
        if (exS != null && exS < 500) {
          reason += ' — SMR mulai dari ' + Math.round(exS) + ' h (VHMS baru di-reset). ' +
            'Unggah juga berkas trend0 SEBELUM reset agar jendela mencukupi.';
        } else if (multiSeg) {
          reason += ' — berkas melintasi ' + ext.segments + ' periode SMR (pernah di-reset).';
        }
      } else if (!s.hasBaseline) reason = 'Variasi terlalu datar — tidak menvonis';
      // `reasonShort` = ringkasan untuk SEL TABEL. Alasan lengkap di `reason`
      // hanya muncul di tooltip, sehingga tidak terbaca di layar sentuh,
      // tidak tercetak di PDF, dan tak terjangkau keyboard. Tanpa versi
      // pendek yang tampil, operator membaca "tanpa data" lalu menyimpulkan
      // datanya kosong — padahal sampelnya yang kurang.
      var reasonShort = '';
      if (sc && sc.empty) {
        // Rentang tanpa data: sebut APA ADANYA. Jangan diam-diam menampilkan
        // angka seluruh berkas, dan jangan menampilkan 0 (terbaca "irit").
        reasonShort = 'tak ada data di rentang ini';
      } else if (!s) {
        // Unit gagal: sebut SEBABNYA (mis. berkas mana yang kurang), bukan
        // "gagal dianalisis" yang tidak bisa ditindaklanjuti.
        var why = String(u.reason || 'hasil tidak tersedia');
        why = why.replace(/^Berkas kurang:\s*/i, 'kurang ');
        reasonShort = why.length > 46 ? why.slice(0, 45) + '\u2026' : why;
      } else if (!s.ready) {
        // Ambang dibaca dari ANALYTICS, bukan ditulis ulang di sini: dua angka
        // untuk satu konsep membuat UI berbohong saat ambang diubah.
        var needWin = (global.FUEL_ANALYTICS && global.FUEL_ANALYTICS.LIMITS &&
          global.FUEL_ANALYTICS.LIMITS.minWindows) || 20;
        reasonShort = s.eligible
          ? 'sampel kurang (' + s.eligible + '/' + needWin + ' jendela)'
          : 'tanpa jendela valid';
      } else if (!s.hasBaseline) {
        reasonShort = 'variasi datar';
      }
      // Rentang z per status (dipakai narasi Result). Dihitung dari jendela
      // yang benar-benar ber-verdict itu, bukan dari seluruh jendela.
      var overZ = flagStats(u, 'OVER', sc && sc.wins);
      var cauZ = flagStats(u, 'CAUTION', sc && sc.wins);
      var frAvg = (u.result && u.result.fuelRateAvg != null)
        ? u.result.fuelRateAvg
        : (u.summary && u.summary.fuelRateAvg != null ? u.summary.fuelRateAvg : null);
      var totalCycle = (u.result && u.result.totalCyclePayload != null)
        ? u.result.totalCyclePayload
        : (u.summary && u.summary.totalCyclePayload != null ? u.summary.totalCyclePayload : null);
      var cycleCount = (u.result && u.result.totalCycleCount != null)
        ? u.result.totalCycleCount
        : (u.summary && u.summary.totalCycleCount != null ? u.summary.totalCycleCount : null);
      if (sc) {
        // Rentang aktif: angka berkas penuh DIGANTI, bukan dicampur. Yang
        // tidak bisa diturunkan dari data bertanggal menjadi null ("—").
        ext = sc.ext;
        frAvg = sc.frAvg;
        totalCycle = sc.totalCycle;
        cycleCount = sc.cycleCount;
      }
      // Proyeksi total fuel = konsumsi AKTUAL di dalam berkas (L/jam × jam
      // operasi), BUKAN ramalan. Menjaminkan angka bisa direproduksi dari data.
      var projFuel = (frAvg != null && ext && ext.hours > 0) ? frAvg * ext.hours : null;
      return {
        key: u.key || (u.serial || ''),
        serial: u.serial || '',
        // Nomor lambung = identitas yang dibaca operator. `lambungExact:false`
        // berarti SN tidak terpetakan (lambung = SN) -> HARUS ditandai di UI.
        lambung: lb.lambung,
        lambungExact: lb.exact,
        lambungSource: lb.source,
        model: u.model || (s && s.model) || '',
        source: u.source || '',
        updatedAt: u.updatedAt || null,
        dateStart: dateRange.start,
        dateEnd: dateRange.end,
        legacy: !!u.legacy,
        weakKey: !!u.weakKey,
        // Baris ini dihitung untuk RENTANG (bukan seluruh berkas) — dipakai
        // UI untuk menyebut basis angkanya secara jujur.
        scoped: !!sc,
        scopedEmpty: !!(sc && sc.empty),
        // 'cycle' = rekap siklus pldcyc (setara angka total) | 'window' =
        // cadangan dari jendela valid (unit simpanan lama) | null = tanpa rentang.
        cycleBasis: sc ? sc.cycleBasis : null,
        lTk: lTk,
        lGt: sc ? sc.lGt
          : ((hasBase && s.baseline.lGt && s.baseline.lGt.median > 0) ? s.baseline.lGt.median : null),
        penalty: sc ? sc.penalty
          : ((hasBase && s.baseline.penalty && s.baseline.penalty.median > 0) ? s.baseline.penalty.median : null),
        eligible: sc ? sc.eligible : (s ? s.eligible : 0),
        // [2026-10-29] Jumlah HARI KALENDER unik di balik baris-baris itu.
        // "4 baris" bisa 3 hari (record trend0 ~20 h SMR, bukan harian), jadi
        // dua angka ini disebut terpisah — bukan dipukul rata.
        dayCount: sc ? sc.dayCount : _dayCount(unitWindows(u).filter(function (w) {
          return w && w.verdictable === true;
        })),
        counts: { NORMAL: c.NORMAL || 0, CAUTION: c.CAUTION || 0, OVER: c.OVER || 0 },
        // overPct = porsi jendela ber-verdict OVER (%). null bila tak ada data.
        overPct: s && hasBase ? _pct(c, 'OVER') : null,
        cautionPct: s && hasBase ? _pct(c, 'CAUTION') : null,
        verdict: verdict,
        // `driver` = penyebab dominan jendela yang di-flag (dihitung dari
        // z mesin vs z beban tiap jendela). Dipakai kolom "Result" agar
        // penjelasan Over % menyebut pemicu yang NYATA, bukan tebakan.
        driver: dominantDriver(u, sc && sc.wins),
        // Rentang z jendela yang di-flag — SATU-SATUNYA rentang yang dipakai
        // narasi Result (total jendela sudah terbaca di kolom Jendela).
        overZMin: overZ.min, overZMax: overZ.max,
        cauZMin: cauZ.min, cauZMax: cauZ.max,
        // Cakupan trend0 + Fuel Rate + proyeksi (dipakai kolom tabel).
        smrStart: ext ? ext.smrStart : null,
        smrEnd: ext ? ext.smrEnd : null,
        // SMR dari record jangkar terdekat (di luar rentang) -> perkiraan.
        smrApprox: !!(sc && sc.extApprox),
        totalHours: ext ? ext.hours : null,
        fuelRateAvg: frAvg,
        totalCycle: totalCycle,
        cycleCount: cycleCount,
        projFuel: projFuel,
        // Baseline L/ton-km unit ini — sumber angka batas CAUTION/OVER di
        // narasi (`median × e^(z·σ)`), sama dengan yang dipakai `classify()`.
        baseline: hasBase ? { lTk: { median: s.baseline.lTk.median, sigma: s.baseline.lTk.sigma } } : null,
        reason: reason,
        reasonShort: reasonShort
      };
    });
  }

  function unitDateRange(unit) {
    var wins = (unit && unit.result && unit.result.windows) ||
      (unit && unit.summary && unit.summary.windows) || [];
    var dates = wins.map(function (w) { return String(w.date || '').slice(0, 10); })
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
    return { start: dates.length ? dates[0] : null, end: dates.length ? dates[dates.length - 1] : null };
  }

  function smrForDates(unit, start, end) {
    var series = (unit && unit.result && unit.result.trendSeries) || (unit && unit.summary && unit.summary.trendSeries) || [];
    var vals = series.filter(function (x) { return x.date && (!start || x.date >= start) && (!end || x.date <= end); }).map(function (x) { return x.smr; });
    if (!vals.length) return { start: null, end: null };
    return { start: Math.min.apply(Math, vals), end: Math.max.apply(Math, vals) };
  }

  /**
   * canOpenUnit(row) — boleh tidaknya baris dibuka di panel detail.
   *
   * [FIX 2026-10-28] Sebelumnya tombol detail bergantung pada `verdict`.
   * Unit yang punya jendela tetapi belum layak verdict (mis. 17 jendela)
   * menjadi TIDAK BISA DIBUKA — operator mengira datanya hilang.
   * Yang menentukan adalah ADA TIDAKNYA ANGKA, bukan ada tidaknya vonis.
   */
  function canOpenUnit(row) {
    if (!row) return false;
    if (row.lTk != null && isFinite(row.lTk)) return true;
    return !!(row.eligible > 0);
  }

  /**
   * kpiSummary(units) — KPI ringkas untuk HALAMAN HOME.
   *
   * [HOME 2026-10-28] Halaman home hanya menampilkan KPI + daftar ratio;
   * tabel lengkapnya dipindah ke tampilan detail. Karena itu KPI HARUS
   * cukup untuk menyimpulkan kondisi armada TANPA membuka detail:
   *   - fleet   : total rasio tertimbang jendela (nol atau lebih unit)
   *   - terboros: unit dengan rasio tertinggi — hanya bermakna bila ada
   *               perbandingan (>= 2 unit). Satu unit tidak "paling boros".
   *   - terhemat: unit dengan rasio terendah (syarat sama).
   *   - attention: unit yang punya jendela OVER/CAUTION.
   *   - nodata  : unit yang belum bisa dihitung (jangan dianggap 0).
   *
   * Peringatan lintas-unit TETAP ditampilkan oleh pemanggil (`scopeWarning`):
   * rasio antar unit dengan rute berbeda TIDAK sebanding, dan angka
   * "terboros/terhemat" di sini TIDAK boleh dibaca sebagai vonis.
   *
   * @returns {Object} MURNI — tanpa DOM.
   */
  function kpiSummary(units) {
    return kpiSummaryFromRows(ratioRows(units));
  }

  /** kpiSummaryFromRows(rows) — KPI dari baris yang SUDAH difilter. */
  function kpiSummaryFromRows(rows) {
    rows = rows || [];
    var t = fleetTotalsFromRows(rows);
    var withNum = rows.filter(function (r) { return r.lTk != null; });
    // Urutkan SALINAN: jangan mengubah urutan yang dipakai tabel.
    var byRatio = withNum.slice().sort(function (a, b) { return a.lTk - b.lTk; });
    var comparable = byRatio.length >= 2;
    var attention = rows.filter(function (r) {
      return (r.counts.OVER || 0) + (r.counts.CAUTION || 0) > 0;
    }).sort(function (a, b) {
      if (b.counts.OVER !== a.counts.OVER) return b.counts.OVER - a.counts.OVER;
      return b.counts.CAUTION - a.counts.CAUTION;
    });
    var nodata = rows.filter(function (r) { return r.lTk == null; });
    return {
      units: t.units,
      withBaseline: t.withBaseline,
      windows: t.windows,
      // Total hari-unit berdata (lihat `fleetTotalsFromRows.days`).
      days: t.days,
      counts: t.counts,
      lTkWeighted: t.lTkWeighted,
      lTkSimple: t.lTkSimple,
      comparable: comparable,
      // `null` (bukan unit acak) bila hanya ada satu unit berangka.
      worst: comparable ? byRatio[byRatio.length - 1] : null,
      best: comparable ? byRatio[0] : null,
      attention: attention,
      nAttention: attention.length,
      overUnits: rows.filter(function (r) { return r.counts.OVER > 0; }).length,
      nodata: nodata,
      nNoData: nodata.length
    };
  }
  /**

   * eventLines(row, cLimits) — OBSERVASI kolom "Event", satu kalimat per baris.

   *

   * [REVISI 2026-10-28] Menggantikan narasi "Result" yang panjang & berkesan

   * dipaksakan. Aturan barunya:

   *   1. Cukup MENJELASKAN ANGKA — setiap fakta diikuti jumlahnya, dan satuannya

   *      disebut "baris" (bukan "jendela"), sesuai istilah data trend0.

   *   2. Satu baris = satu fakta. Tidak ada klausa majemuk yang menuntut

   *      pembaca menyusun sendiri hubungan sebab-akibatnya.

   *   3. Semua angka berasal dari baris itu (counts, rentang z, baseline) —

   *      tidak ada klaim yang tidak terukur.

   * MURNI: mengembalikan array string; renderer menambahkan penanda tebal.

   */

  function eventLines(row, cLimits) {
    if (!row) return [];
    var counts = row.counts || { NORMAL: 0, CAUTION: 0, OVER: 0 };
    var nWin = (counts.NORMAL || 0) + (counts.CAUTION || 0) + (counts.OVER || 0);

    // Tanpa vonis: sebut sebabnya, bukan klaim normal.
    if (row.verdict == null || !nWin) {
      var why = row.reasonShort || row.reason || '';
      return ['Belum ada baris dinilai' + (why ? ' · ' + why : '')];
    }

    var nOver = counts.OVER || 0;
    var nCau = counts.CAUTION || 0;

    // Bentuk ringkas: jumlah flag + judul metrik. Normal dan pemicu dominan
    // tidak ditampilkan; detail total baris sudah ada di kolom Jendela.
    var out = [];
    if (nOver > 0) {
      out.push('**' + nOver + 'x Over** [ L/ton-km ]');
    }
    if (nCau > 0) {
      out.push('**' + nCau + 'x Caution** [ L/ton-km ]');
    }
    // Baris NORMAL dan pemicu dominan SENGAJA tidak disebut (permintaan
    // operator 2026-10-28): kolom Jendela sudah memuat total baris, dan
    // Event hanya menjawab berapa yang di-flag terhadap batas berapa.
    return out;
  }
  /** Teks satu kalimat per baris untuk ekspor/uji (tanpa penanda tebal). */

  function eventText(row, cLimits) {

    return eventLines(row, cLimits).join('\n').replace(/\*\*/g, '');

  }



  /** Event sebagai HTML aman: penanda ** -> <strong> SETELAH escaping. */

  function eventHtml(row, cLimits) {

    var lines = eventLines(row, cLimits);

    if (!lines.length) return '';

    return '<ul class="fuel-event-list">' + lines.map(function (s) {

      return '<li>' + esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</li>';

    }).join('') + '</ul>';

  }

  /** Teks KPI untuk SALIPAN/PDF (tanpa DOM). Dipakai uji & tombol salin. */
  function kpiText(kpi, fmt) {
    if (!kpi) return '';
    fmt = fmt || num;
    var out = [];
    // [REVISI 2026-10-28] Istilah disamakan dengan kartu KPI (istilah statistik
    // umum): N unit / N jendela / Mean / Maks / Min / Unit flag.
    out.push('N unit: ' + kpi.units + ' · N jendela: ' + kpi.windows);
    out.push('Mean L/TKM (tertimbang): ' + (kpi.lTkWeighted == null ? '—' : fmt(kpi.lTkWeighted, 4)) +
      ' · Normal ' + kpi.counts.NORMAL + ' · Caution ' + kpi.counts.CAUTION +
      ' · Over ' + kpi.counts.OVER);
    if (kpi.worst && kpi.best) {
      out.push('Maks L/TKM: ' + fmt(kpi.worst.lTk, 4) + ' · Min L/TKM: ' + fmt(kpi.best.lTk, 4));
    } else {
      out.push('Maks/Min L/TKM: butuh minimal 2 unit berbaseline');
    }
    out.push('Unit flag: ' + kpi.nAttention + ' unit · Tanpa angka: ' + kpi.nNoData + ' unit');
    return out.join('\n');
  }

  /* ---------------------------------------------------------------------
   * NOMOR LAMBUNG (permintaan operator 2026-10-28)
   * ---------------------------------------------------------------------
   * Berkas telemetri hanya membawa Serial Number (SN). Operator membaca
   * unit lewat NOMOR LAMBUNG. Konversinya TIDAK dikarang di modul Fuel:
   * datanya diambil dari sumber yang sama dengan modul lain —
   * `VHMS_UNITDB` (unggahan SN · Lambung · Section) atau data Lifetime
   * (EquipmentNumber = No Lambung, SerialNumber = SN).
   *
   * Aturan (fungsi MURNI, bisa diuji tanpa DOM):
   *   1. SN -> lambung lewat `snMap` (dari VHMS_UNITDB / Lifetime).
   *   2. `resolveLambung` (PORTFOLIO_STORE) dipakai sebagai jalur cadangan.
   *   3. TIDAK ADA tebakan: SN yang tidak terpetakan dikembalikan apa adanya
   *      dengan `exact:false` + `source:'sn'` agar UI bisa menandainya.
   * ------------------------------------------------------------------- */

  /** Normalisasi kunci SN — SAMA dengan normSerial di vhms-unit-db.js. */
  function normSn(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /** Buang spasi ganda + trim (nilai yang dibaca operator, bukan kunci). */
  function cleanLambung(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * lambungOf(serial, ctx) — SN -> nomor lambung.
   * @param {string} serial
   * @param {{snMap?:Object, resolveLambung?:Function}} [ctx]
   * @returns {{sn:string, lambung:string, exact:boolean, source:'db'|'lifetime'|'store'|'sn'}}
   *   `exact`  = true hanya bila lambung benar-benar hasil pemetaan.
   *   `source` = 'sn' berarti pemetaan tidak ditemukan (lambung = SN).
   */
  function lambungOf(serial, ctx) {
    // Tanpa `ctx`, pakai peta SUMBER GLOBAL yang sedang berlaku. Sebelumnya
    // default-nya peta kosong -> pemanggil yang lupa memberi konteks akan
    // selalu mendapat SN apa adanya (bug senyap: fitur tampak "tidak jalan").
    ctx = ctx || lambungContext();
    var sn = String(serial == null ? '' : serial).trim();
    if (!sn) return { sn: '', lambung: '', exact: false, source: 'sn' };

    var hit = ctx.snMap ? ctx.snMap[normSn(sn)] : null;
    if (hit && cleanLambung(hit.lambung)) {
      return { sn: sn, lambung: cleanLambung(hit.lambung), exact: true, source: hit.source || 'db' };
    }
    return { sn: sn, lambung: sn, exact: false, source: 'sn' };
  }

  /**
   * snLambungMap() — peta SN -> { lambung, source } dari sumber yang ADA.
   * PRIORITAS: VHMS_UNITDB (unggahan resmi SN·Lambung·Section — juga sumber
   * Section Portofolio), lalu kait Lifetime (`registerLambungRows`).
   *
   * ⚠ ISOLASI MODUL (uji FUEL-ISO-4): modul Fuel TIDAK membaca PORTFOLIO_STORE
   * secara langsung. Bila peta Lifetime perlu dipakai, modul pemilik data
   * mendorong barisnya lewat kait — satu arah, tanpa ketergantungan modul.
   * Sumber pertama menang; entri tanpa lambung DILEWATI agar tidak menimpa
   * hasil yang benar dengan kosong.
   */
  var _lambungRowsHook = [];

  function registerLambungRows(rows) {
    _lambungRowsHook = Array.isArray(rows) ? rows.slice() : [];
    return _lambungRowsHook.length;
  }

  function snLambungMap() {
    var out = {};
    var db = global.VHMS_UNITDB;

    if (db && typeof db.entries === 'function') {
      try {
        db.entries().forEach(function (e) {
          var k = normSn(e && e.sn);
          var lb = cleanLambung(e && e.lambung);
          if (k && lb && !out[k]) out[k] = { lambung: lb, source: 'db' };
        });
      } catch (e) { /* sumber tidak tersedia -> lanjut ke kait Lifetime */ }
    }

    _lambungRowsHook.forEach(function (r) {
      var k = normSn(r && r.serial);
      var lb = cleanLambung(r && r.lambung);
      if (k && lb && !out[k]) out[k] = { lambung: lb, source: 'lifetime' };
    });
    return out;
  }

  /** Konteks pemetaan untuk pemanggil (app) — satu objek berisi peta saja. */
  function lambungContext() {
    return { snMap: snLambungMap() };
  }

  /**
   * filterRatioRows(rows, opts) — filter + urut, MURNI.
   *
   * [REVISI 2026-10-28] `filterRatioRows` TIDAK diubah. @param {{text?, verdict?, model?, sort?, dir?}} opts
   *        verdict: 'OVER' | 'CAUTION' | 'NORMAL' | 'NODATA'
   *        sort:    'serial' | 'model' | 'lTk' | 'eligible' | 'overPct'
   *        dir:     'asc' | 'desc'
   *
   * ATURAN URUTAN: unit tanpa angka SELALU di bawah, apa pun arahnya.
   * Menganggap `null` sebagai 0 akan menaruh unit tanpa data di puncak
   * "paling hemat" — kesimpulan yang salah dan berbahaya.
   */
  function filterRatioRows(rows, opts) {
    opts = opts || {};
    var text = String(opts.text || '').trim().toLowerCase();
    var out = (rows || []).filter(function (r) {
      if (text) {
        // Cari lewat DUA identitas: nomor lambung (yang dibaca operator) dan
        // SN (yang tercetak di berkas telemetri). Jangan salah satunya saja —
        // operator kadang hanya punya SN dari sheet lain.
        var hay = (String(r.lambung || '') + ' ' + String(r.serial || '') + ' ' +
          String(r.model || '') + ' ' + String(r.source || '')).toLowerCase();
        if (hay.indexOf(text) < 0) return false;
      }
      if (opts.model && String(r.model) !== String(opts.model)) return false;
      // [2026-10-28] Baris yang SUDAH dihitung per rentang (`scoped`) tidak
      // lagi diuji tumpang-tindih: pengujian itu hanya tahu rentang total
      // unit, sedangkan `scopeUnit()` sudah memeriksa tiap jendela/record.
      // Yang tersisa: buang unit yang memang tak punya data di rentang itu.
      if (r.scoped) {
        if (r.scopedEmpty) return false;
      } else {
        if (opts.dateStart && (!r.dateEnd || r.dateEnd < opts.dateStart)) return false;
        if (opts.dateEnd && (!r.dateStart || r.dateStart > opts.dateEnd)) return false;
      }
      if (opts.verdict) {
        if (opts.verdict === 'NODATA') { if (r.verdict != null) return false; }
        else if (r.verdict !== opts.verdict) return false;
      }
      return true;
    });
    var sort = opts.sort || 'lTk';
    var desc = (opts.dir || 'desc') === 'desc';
    out.sort(function (a, b) {
      // Unit tanpa angka selalu di bawah.
      var av = a[sort], bv = b[sort];
      var an = (av == null || av === ''), bn = (bv == null || bv === '');
      if (an && bn) return String(a.lambung || a.serial).localeCompare(String(b.lambung || b.serial));
      if (an) return 1;
      if (bn) return -1;
      var c = (typeof av === 'number' && typeof bv === 'number')
        ? (av - bv)
        : String(av).localeCompare(String(bv));
      return desc ? -c : c;
    });
    return out;
  }

  /* -----------------------------------------------------------------------
   * BETWEEN — PEMBANDING DUA RENTANG  (permintaan user 2026-10-29)
   *
   * "Sebelum" (A) vs "Sesudah" (B) per unit, dengan vonis HEMAT / BOROS /
   * STABIL. MURNI: tidak menyentuh DOM, tidak menghitung ulang apa pun —
   * memanggil `ratioRows()` dua kali supaya definisi angkanya PERSIS SAMA
   * dengan tabel di atasnya. Menulis rumus kedua di sini akan membuat panel
   * ini dan tabel melaporkan dua angka berbeda untuk satu konsep.
   *
   * GERBANG YANG WAJIB ADA (tanpanya panel ini membual):
   *  1. Kedua rentang harus LENGKAP. Satu tanggal kosong = `ratioRows`
   *     mengembalikan angka SELURUH berkas, jadi "sebelum" diam-diam menjadi
   *     "semua data" dan selisihnya tak bermakna.
   *  2. Rentang TIDAK BOLEH bertumpang-tindih tanpa diberi tahu — sebagian
   *     data yang sama muncul di kedua sisi dan meredam selisihnya.
   *  3. Unit tanpa angka di SALAH SATU sisi TIDAK divonis. Menganggap null
   *     sebagai 0 akan melaporkan "hemat 100 %" untuk unit yang justru tidak
   *     punya data.
   *  4. Selisih di dalam pita derau unit itu = STABIL, bukan hemat/boros.
   *     Pita diambil dari σ(log) baseline unit (variasi antar-jendela yang
   *     normal), bukan angka tetap yang dikarang.
   * --------------------------------------------------------------------- */

  /* -----------------------------------------------------------------------
   * [F0 2026-10-29] PITA DERAU — BATAS ATAS & BAWAH TIDAK SIMETRIS
   * ---------------------------------------------------------------------
   * SEBELUMNYA satu angka `(e^σ − 1) × 100` dipakai untuk kedua arah
   * (`Math.abs(deltaPct) <= pct`). Itu SALAH secara aritmetika: Δ% dihitung
   * linier `(B−A)/A`, sedangkan `e^σ − 1` adalah konversi SATU SISI dari
   * ruang log. Batas bawah yang benar adalah `1 − e^−σ`.
   *
   * Dampaknya bukan teoretis: σ = 0,4555 (HDKM78468) memberi batas atas
   * +57,7 % tetapi batas bawah hanya −36,6 %. Memakai ±57,7 % membuat
   * penurunan 40 % — perbaikan nyata — dibaca "Stabil".
   *
   * σ < MIN_SIGMA_LOG juga TIDAK BOLEH menerbitkan pita: `classify()` sudah
   * menolak menvonis pada σ selebar itu (MAD ≈ 0), jadi memakai σ tersebut
   * di sini akan menghasilkan pita ±0,3 % dan memvonis BOROS/HEMAT dari
   * derau. Unit seperti itu jatuh ke pita cadangan, ditandai `*` di UI.
   * --------------------------------------------------------------------- */
  var CMP_BAND_FALLBACK = 5;   // % — dipakai HANYA bila σ tidak diketahui

  /* -----------------------------------------------------------------------
   * [F3 2026-10-29] GERBANG KECUKUPAN PER PERIODE
   * ---------------------------------------------------------------------
   * SEBAB: panel memvonis "Stabil" untuk unit yang sisi B-nya hanya 1 baris
   * dari 27 hari kalender. Satu baris = satu jendela ~20 jam mesin; median
   * dari satu angka adalah angka itu sendiri, tanpa ukuran sebaran apa pun.
   * Vonis seperti itu bukan kesimpulan, hanya pengulangan satu pembacaan.
   *
   * Dua ambang DIPAKAI BERSAMA karena masing-masing menutup lubang yang
   * berbeda:
   *   - `minRows`     menolak sampel tipis (1–4 baris),
   *   - `minCoverage` menolak sampel yang banyak tapi menumpuk di 2–3 hari
   *                   (mis. 12 baris semua dari akhir pekan yang sama).
   * `minDays` menjaga periode PENDEK tetap bisa dinilai: rentang 6 hari
   * dengan 5 hari berdata sudah cakupan 83 %, jangan ditolak karena barisnya
   * kebetulan di bawah `minRows`.
   *
   * `maxBandUp` menutup lubang KETIGA yang tidak ditangkap keduanya: unit
   * yang σ-nya sangat lebar (HDKM78468, σ = 0,4555 → pita +57,7 %) akan
   * selalu "Stabil" apa pun yang terjadi — pita selebar itu tidak punya daya
   * pisah. Menyebutnya "Stabil" memberi rasa aman palsu justru pada unit
   * yang paling boros di armada.
   *
   * ---------------------------------------------------------------------
   * KALIBRASI 2026-10-29 — angka di bawah DIUKUR, bukan ditebak.
   * Sumber: `tools/audit-fuel-between-thin-b.js` atas 10 unit nyata
   * (26 berkas trend0 + 26 pldcyc, D:\Testing).
   *
   * BATAS STRUKTURAL YANG DITEMUKAN: record trend0 berjarak ~20,1 jam SMR
   * (median 32 jam dinding), jadi satu unit yang bekerja SETIAP HARI tetap
   * hanya menghasilkan record pada **sebagian** hari kalender. Diukur pada
   * bulan yang unitnya terbukti bekerja (≥ 20 hari bersiklus):
   *
   *   cakupan hari ber-jendela : median 57 %, maksimum 80 %, n = 31 bulan-unit
   *
   * Artinya ambang 60 % menolak **61 %** bulan yang unitnya benar-benar
   * bekerja — gerbang yang menghukum ritme perekaman, bukan data yang buruk.
   * Ambang diturunkan ke 45 %: di bawah median kerja normal, tetapi masih
   * menolak periode yang hanya tersentuh beberapa hari.
   *
   *   minCoverage 45 % → menolak 13 dari 31 (42 %) — dan 10 di antaranya
   *   adalah bulan dengan cakupan 0 % (trend0 memang tidak ada sama sekali),
   *   yang MEMANG harus ditolak.
   *
   * `minRows = 10` TERBUKTI TEPAT dan tidak diubah: pada bulan kerja normal
   * distribusinya 15–24 baris (median 20), sehingga ambang 10 hanya menolak
   * 1 dari 21 bulan — yaitu bulan dengan 3 baris, yang memang pantas ditolak.
   *
   * Diekspor supaya UI, uji, dan dokumen membaca SATU sumber.
   * --------------------------------------------------------------------- */
  var CMP_LIMITS = {
    // Terkalibrasi: bulan kerja normal 15–24 baris (median 20, n = 21).
    minRows: 10,
    /* Terkalibrasi: cakupan maksimum yang MUNGKIN pada unit yang bekerja
     * setiap hari hanyalah ±80 % (record trend0 ~20 jam SMR, bukan harian).
     * Ambang 60 % yang semula dipakai menolak 61 % bulan kerja normal. */
    minCoverage: 0.45,
    minDays: 5,         // hari berdata — jalan pintas untuk periode pendek
    maxBandUp: 25       // % — di atas ini pita tak punya daya pisah
  };

  /** Lantai σ dibaca dari ANALYTICS agar tidak ada dua angka untuk satu konsep. */
  function _minSigmaLog() {
    var v = global.FUEL_ANALYTICS && global.FUEL_ANALYTICS.MIN_SIGMA_LOG;
    return (v != null && isFinite(v) && v > 0) ? v : 0.005;
  }

  /**
   * _bandPct(row) → { up, down, pct, fromSigma }
   * `up`/`down` = batas (%) searah kenaikan/penurunan L/ton-km.
   * `pct` = `up` — dipakai label kolom agar lebar tabel tidak berubah;
   *         batas sebenarnya dibaca di tooltip.
   */
  function _bandPct(row) {
    var s = row && row.baseline && row.baseline.lTk && row.baseline.lTk.sigma;
    if (s != null && isFinite(s) && s >= _minSigmaLog()) {
      var up = (Math.exp(s) - 1) * 100;
      return { up: up, down: (1 - Math.exp(-s)) * 100, pct: up, fromSigma: true };
    }
    return { up: CMP_BAND_FALLBACK, down: CMP_BAND_FALLBACK,
      pct: CMP_BAND_FALLBACK, fromSigma: false };
  }

  /**
   * compareRows(units, mapCtx, ranges) — pembanding dua rentang.
   * @param {Array<Object>} units
   * @param {Object} [mapCtx] konteks lambung (`lambungContext()`).
   * @param {{a:{dateStart,dateEnd}, b:{dateStart,dateEnd}}} ranges
   * @returns {{ready:boolean, reason:string, overlap:boolean,
   *            rows:Array<Object>, totals:Object|null}}
   */
  /**
   * _periodDays(start, end, dataLast) — hari kalender periode, DIPOTONG di
   * tanggal data terakhir. 0 bila seluruh periode berada setelah data.
   */
  function _periodDays(start, end, dataLast) {
    if (!start || !end) return 0;
    var hi = (dataLast && dataLast < end) ? dataLast : end;
    if (hi < start) return 0;
    var ms = Date.parse(hi + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z');
    if (!isFinite(ms)) return 0;
    return Math.round(ms / 86400000) + 1;
  }

  /**
   * _sideOk(rows, days, periodDays, lim) → { ok, cov }
   * Satu sisi dinyatakan CUKUP bila barisnya memadai DAN sebarannya tidak
   * menumpuk di beberapa hari saja. `minDays` adalah jalan pintas untuk
   * periode pendek (lihat blok CMP_LIMITS).
   */
  function _sideOk(rows, days, periodDays, lim) {
    var cov = periodDays > 0 ? days / periodDays : null;
    var enoughRows = rows >= lim.minRows || days >= lim.minDays;
    var enoughCov = (cov == null) ? false : (cov >= lim.minCoverage);
    return { ok: !!(rows > 0 && enoughRows && enoughCov), cov: cov };
  }

  /**
   * _thinWhy(side, rows, days, periodDays, lim) — alasan yang bisa
   * DITINDAKLANJUTI: sebut angka yang didapat DAN angka yang dibutuhkan.
   * "Data tidak cukup" tanpa angka membuat operator menebak.
   */
  function _thinWhy(side, rows, days, periodDays, lim) {
    var cov = periodDays > 0 ? Math.round(100 * days / periodDays) : 0;
    return side + ' ' + rows + ' baris / ' + days + ' hari dari ' + periodDays +
      ' (' + cov + ' %, butuh ' + lim.minRows + ' baris atau ' + lim.minDays +
      ' hari, dan \u2265' + Math.round(lim.minCoverage * 100) + ' %)';
  }

  /**
   * compareRows(units, mapCtx, ranges, opts)
   * @param {{allowThin?:boolean, limits?:Object}} [opts] `allowThin` melewati
   *   gerbang kecukupan F3 — HANYA untuk uji & contoh legenda, jangan di UI.
   */
  function compareRows(units, mapCtx, ranges, opts) {
    var a = (ranges && ranges.a) || {}, b = (ranges && ranges.b) || {};
    var out = { ready: false, reason: '', overlap: false, rows: [], totals: null };
    var as = a.dateStart || '', ae = a.dateEnd || '';
    var bs = b.dateStart || '', be = b.dateEnd || '';
    if (!(as && ae && bs && be)) {
      out.reason = 'Isi KEDUA rentang (tanggal awal & akhir) untuk membandingkan.';
      return out;
    }
    if (as > ae || bs > be) {
      out.reason = 'Tanggal awal melewati tanggal akhir.';
      return out;
    }
    out.overlap = (as <= be && bs <= ae);

    var ctx = mapCtx || lambungContext();
    var A = ratioRows(units, ctx, { dateStart: as, dateEnd: ae });
    var B = ratioRows(units, ctx, { dateStart: bs, dateEnd: be });

    /* [F3] Penyebut cakupan DIPOTONG di tanggal data terakhir. Rentang yang
     * melewatinya menghitung hari yang berkasnya memang belum diunggah —
     * "4 dari 30 hari" lalu menyalahkan operator untuk hari yang tak pernah
     * ada datanya. `allowThin` menonaktifkan gerbang untuk uji/legenda. */
    var dataLast = dataLastDate(units);
    var lim = (opts && opts.limits) || CMP_LIMITS;
    var allowThin = !!(opts && opts.allowThin);
    var aDaysTotal = _periodDays(as, ae, dataLast);
    var bDaysTotal = _periodDays(bs, be, dataLast);
    var byKey = {}, allKeys = [];
    A.forEach(function (r) { byKey[r.key] = { a: r }; allKeys.push(r.key); });
    B.forEach(function (r) {
      if (!byKey[r.key]) { byKey[r.key] = {}; allKeys.push(r.key); }
      byKey[r.key].b = r;
    });

    out.rows = allKeys.map(function (key) {
      var pair = byKey[key] || {}, ra = pair.a || {}, rb = pair.b || {};
      var av = ra.lTk, bv = rb.lTk;
      var band = _bandPct(ra.baseline ? ra : rb);
      var row = {
        key: key,
        lambung: ra.lambung || rb.lambung, lambungExact: ra.lambungExact != null ? ra.lambungExact : rb.lambungExact,
        serial: ra.serial || rb.serial, model: ra.model || rb.model,
        aLTk: av, bLTk: bv,
        aWindows: ra.eligible || 0, bWindows: rb.eligible || 0,
        aDays: ra.dayCount || 0, bDays: rb.dayCount || 0,
        delta: null, deltaPct: null,
        bandPct: band.pct, bandFromSigma: band.fromSigma,
        // [F0] Batas SEBENARNYA per arah — satu skalar ± tidak sah.
        bandUp: band.up, bandDown: band.down,
        // [F3] Cakupan per sisi — hari berdata ÷ hari kalender (dipotong
        // tanggal data terakhir). null bila periodenya kosong.
        aPeriodDays: aDaysTotal, bPeriodDays: bDaysTotal,
        aCov: null, bCov: null,
        insufficient: false,
        // [F4] Keyakinan = baris di sisi TERLEMAH (lihat blok KEYAKINAN).
        weakRows: null, confidence: null,
        verdict: null, reason: ''
      };
      /* [F5 FIX 2026-10-29] Cakupan dihitung SEBELUM gerbang sepihak.
       * Sebelumnya ia baru diisi setelah kedua sisi punya angka, sehingga
       * unit yang satu sisinya KOSONG — justru kasus yang paling perlu
       * dijelaskan — tampil "— / —" dan sebabnya hilang dari layar.
       * "0 / 30 hari (0 %)" langsung menjawab kenapa sisinya kosong. */
      var ga = _sideOk(row.aWindows, row.aDays, aDaysTotal, lim);
      var gb = _sideOk(row.bWindows, row.bDays, bDaysTotal, lim);
      row.aCov = ga.cov; row.bCov = gb.cov;
      // Gerbang 3: satu sisi tanpa angka -> SEBUTKAN sisi mana, jangan vonis.
      if (av == null && bv == null) { row.reason = 'tak ada angka di kedua rentang'; return row; }
      if (av == null) { row.reason = 'tak ada angka di rentang Sebelum'; return row; }
      if (bv == null) { row.reason = 'tak ada angka di rentang Sesudah'; return row; }
      row.delta = bv - av;
      row.deltaPct = 100 * (bv - av) / av;

      /* [F3] KECUKUPAN DATA — diperiksa SEBELUM pita.
       * Unit yang sisi B-nya 1 baris tidak "stabil"; ia tidak terukur. Ini
       * `verdict = 'INSUFFICIENT'`, bukan `null`: `null` sudah dipakai untuk
       * "tak ada angka sama sekali", dan dua sebab yang berbeda harus
       * menghasilkan dua pesan yang berbeda di layar. */
      if (!allowThin && !(ga.ok && gb.ok)) {
        var thin = [];
        if (!ga.ok) thin.push(_thinWhy('A', row.aWindows, row.aDays, aDaysTotal, lim));
        if (!gb.ok) thin.push(_thinWhy('B', row.bWindows, row.bDays, bDaysTotal, lim));
        row.insufficient = true;
        row.verdict = 'INSUFFICIENT';
        row.reason = 'Data tidak cukup: ' + thin.join(' \u00b7 ');
        return row;
      }

      /* [F4 2026-10-29] KEYAKINAN = JUMLAH BARIS DI SISI TERLEMAH.
       *
       * Rencana awal memakai skor gabungan `0,5·n + 0,3·cov + 0,2·(1−CV)`.
       * Bobot itu TIDAK PERNAH DIKALIBRASI, dan skor berbobot karangan
       * terlihat lebih ilmiah daripada isinya — persis cacat yang sedang
       * diperbaiki di panel ini.
       *
       * Yang dipakai justru besaran yang artinya tidak perlu dibela:
       * perbandingan hanya sekuat sisi yang datanya paling sedikit. Angkanya
       * dicetak apa adanya sehingga pembaca bisa menilai sendiri.
       * Ambang = kelipatan `minRows`, bukan angka baru. */
      row.weakRows = Math.min(row.aWindows, row.bWindows);
      row.confidence = (row.weakRows >= lim.minRows * 2) ? 'TINGGI'
        : (row.weakRows >= lim.minRows ? 'SEDANG' : 'RENDAH');

      /* [F3] PITA TERLALU LEBAR = TIDAK PUNYA DAYA PISAH.
       * σ = 0,4555 menerbitkan pita +57,7 %. Apa pun yang terjadi pada unit
       * itu akan jatuh "Stabil" — dan unit itulah yang konsumsinya 2,6×
       * armada. Memberinya label hijau-kuning adalah rasa aman palsu. */
      if (band.fromSigma && band.up > lim.maxBandUp) {
        row.insufficient = true;
        row.verdict = 'INSUFFICIENT';
        row.reason = 'Variasi unit terlalu lebar (pita +' + num(band.up, 1) +
          ' % > ' + num(lim.maxBandUp, 0) + ' %) \u2014 selisih sebesar apa pun ' +
          'akan terbaca "stabil", jadi panel ini tidak menvonis.';
        return row;
      }
      // Gerbang 4: pita derau. `<=` (bukan `<`) supaya tepat di batas pita
      // tetap dibaca STABIL.
      //
      // [F0 2026-10-29] Per ARAH, bukan `|Δ%| <= pct`: batas atas dan bawah
      // pita berbeda (e^σ − 1 vs 1 − e^−σ). Memakai satu angka membuat
      // perbaikan besar (Δ negatif) lolos sebagai "Stabil" pada unit ber-σ
      // lebar. Lihat blok "PITA DERAU" di atas.
      //
      // EPS: (0,19 − 0,20)/0,20 × 100 keluar sebagai −5,000000000000004,
      // sehingga selisih yang PERSIS di batas 5 % dinyatakan di luar pita.
      // "Tepat di batas = Stabil" adalah janji yang ditulis di legenda; tanpa
      // toleransi relatif, janji itu gagal hanya karena pembulatan IEEE-754.
      var eps = 1e-9 * Math.max(1, Math.abs(row.deltaPct));
      var withinBand = (row.deltaPct >= -band.down - eps) && (row.deltaPct <= band.up + eps);
      if (withinBand) {
        row.verdict = 'STABIL';
        row.reason = 'selisih di dalam pita derau unit (\u2212' + num(band.down, 1) +
          ' % \u2026 +' + num(band.up, 1) + ' %)';
      } else {
        row.verdict = row.deltaPct < 0 ? 'HEMAT' : 'BOROS';
      }
      return row;
    });

    out.ready = true;
    out.totals = compareTotals(out.rows);
    if (out.overlap) {
      out.reason = 'Kedua rentang BERTUMPANG-TINDIH (' + bs + ' \u2264 ' + ae +
        ') \u2014 sebagian data yang sama ada di kedua sisi, selisihnya teredam.';
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * [SUPPORT 2026-10-30] DATA PENDUKUNG PADA BARIS PEMBANDING
   *
   * MASALAH YANG DISELESAIKAN: Δ% pada satu kolom menjawab "berapa" tetapi
   * tidak "kenapa". Dua unit bisa sama-sama -4 % padahal yang satu turun
   * karena jam operasi berkurang dan yang lain karena jarak kosong naik.
   * Kolom pendukung ini hanya MEMBACA ULANG agregat yang sudah ada — tidak
   * ada rumus baru, tidak ada angka yang berbeda dari tabel utama.
   *
   * ATURAN YANG WAJIB DIPEGANG:
   *
   * 1. SATU DEFINISI. Siklus & tonase memakai `cycleDaily` (rekap pldcyc per
   *    tanggal), bukan jumlah jendela — sama dengan tabel utama. Kalau rekap
   *    tidak ada (unit tersimpan lama), dipakai cadangan jendela dan
   *    `cycleBasis='window'` DITERBITKAN supaya UI bisa menyebutnya. Dua
   *    angka dengan basis berbeda yang dicetak sama adalah kebohongan kecil
   *    yang paling mahal di panel ini.
   *
   * 2. JARAK LOADED/EMPTY KOSONG, BUKAN NOL. Siklus mentah pldcyc
   *    (`dL`/`dE`) TIDAK disimpan di ringkasan (`fuel-store.compact()`) —
   *    lihat catatan RENTANG TANGGAL. Karena itu kolom ini TIDAK BISA diisi
   *    dari data tersimpan, dan `null` harus tetap `null` ("—"), bukan 0.
   *    Mencetak 0 km berarti "tidak berjalan", kebalikan dari kenyataan.
   *    Jadi fungsi ini SENGAJA belum mengisinya: menambahkannya tanpa
   *    menyimpan `dE`/`dL` per hari akan mengarang angka.
   *
   * 3. GPS OPSIONAL. `opts.gps` = hasil `FUEL_GPS.aggregate()`. Bila tidak
   *    ada (belum diunggah), `dropGps`/`climbGps` = null — kolom menulis
   *    "belum ada GPS", bukan 0 m. Nol meter berarti datar, dan itu klaim
   *    yang tidak boleh diberikan tanpa data.
   * --------------------------------------------------------------------- */
  function sumCycleDaily(unit, start, end) {
    var daily = unitCycleDaily(unit);
    if (!daily) return null;
    var n = 0, ton = 0, hit = 0;
    // [SUPPORT 2026-10-30] Jarak kosong/bermuatan & idle ikut dijumlah.
    // `null` dipertahankan sampai ada angka sungguhan: satu hari tanpa
    // pembacaan `dE` tidak boleh membuat total bulan itu 0 km.
    var agg = { dE: null, dL: null, idleMin: null, sE: null, sL: null, sLd: null };
    var A = global.FUEL_ANALYTICS;
    daily.forEach(function (d) {
      if (!d || typeof d.date !== 'string' || !d.date) return;
      if (!_inRange(d.date, start, end)) return;
      hit++;
      if (isFinite(Number(d.n))) n += Number(d.n);
      if (isFinite(Number(d.ton))) ton += Number(d.ton);
      ['dE', 'dL', 'sE', 'sL', 'sLd'].forEach(function (k) {
        var v = d[k];
        if (v == null || !isFinite(Number(v))) return;
        agg[k] = (agg[k] == null ? 0 : agg[k]) + Number(v);
      });
    });
    if (!hit) return null;
    agg.idleMin = (A && typeof A.idleMinutes === 'function')
      ? A.idleMinutes(agg)
      // Cadangan bila modul analytics versi lama: definisi SAMA (tiga komponen).
      : ((agg.sE == null && agg.sL == null && agg.sLd == null) ? null
        : (agg.sE || 0) + (agg.sL || 0) + (agg.sLd || 0));
    return { cycles: n, tonnage: ton, days: hit,
      distEmpty: agg.dE, distLoaded: agg.dL, idleMin: agg.idleMin,
      sE: agg.sE, sL: agg.sL, sLd: agg.sLd };
  }

  /**
   * supportStats(unit, range, opts) — angka pendukung SATU sisi.
   * MURNI terhadap data unit yang diberikan.
   * @returns {{rows:number, days:number, hours:number|null,
   *            cycles:number|null, tonnage:number|null, cycleBasis:string|null,
   *            dropGps:number|null, climbGps:number|null,
   *            gpsDays:number|null, gpsDistKm:number|null}|null}
   */
  function supportStats(unit, range, opts) {
    if (!unit || !range) return null;
    var sc = scopeUnit(unit, range.dateStart, range.dateEnd);
    if (!sc || sc.empty) return null;
    var out = {
      rows: sc.eligible || 0,
      days: sc.dayCount || 0,
      // "Total Operation" = ΔSMR dalam rentang (jam mesin), SAMA dengan
      // kolom Total Operation di tabel utama.
      hours: (sc.ext && sc.ext.hours != null) ? sc.ext.hours : null,
      cycles: null, tonnage: null, cycleBasis: null,
      // [SUPPORT 2026-10-30] Dari rekap harian pldcyc. null = tidak tersimpan
      // (unit lama sebelum rekap diperluas) -> UI mencetak "—", BUKAN 0.
      distEmpty: null, distLoaded: null, idleMin: null,
      sE: null, sL: null, sLd: null,
      dropGps: null, climbGps: null, gpsDays: null, gpsDistKm: null
    };
    var cd = sumCycleDaily(unit, range.dateStart, range.dateEnd);
    if (cd) {
      out.cycles = cd.cycles; out.tonnage = cd.tonnage; out.cycleBasis = 'cycle';
      out.distEmpty = cd.distEmpty; out.distLoaded = cd.distLoaded;
      out.idleMin = cd.idleMin;
      out.sE = cd.sE; out.sL = cd.sL; out.sLd = cd.sLd;
    } else if (sc.cycleCount != null || sc.totalCycle != null) {
      // Cadangan: jendela VALID. Lebih kecil dari angka total — disebut di UI.
      out.cycles = sc.cycleCount == null ? null : sc.cycleCount;
      out.tonnage = sc.totalCycle == null ? null : sc.totalCycle;
      out.cycleBasis = 'window';
    }
    var G = global.FUEL_GPS;
    var agg = opts && opts.gps;
    if (G && agg) {
      // Track GPS dikunci dengan nomor lambung, sedangkan telemetri Fuel
      // sering membawa serial (mis. J31776). Mengutamakan serial di sini
      // membuat GPS sudah termuat tetapi selalu terlihat "unit tidak ada".
      var st = G.rangeStats(agg, unitKeyOf(unit, opts && opts.ctx), range.dateStart, range.dateEnd);
      if (st) {
        out.climbGps = st.climb;
        out.dropGps = st.drop;
        out.gpsDays = st.days;
        out.gpsDistKm = st.distKm;
        // Deret harian (rapat) DITERUSKAN agar sparkline digambar dari
        // sumber yang sama; menghitung ulang di UI berarti dua definisi.
        out.gpsDaily = st.dailyDense || [];
      } else {
        // Ada GPS tetapi TIDAK untuk unit ini -> bedakan dari "belum ada
        // GPS sama sekali" lewat `gpsDays = 0` (bukan null).
        out.gpsDays = 0;
      }
    }
    return out;
  }

  /** Kunci track GPS adalah nomor lambung; serial hanya cadangan bila belum
   * ada pemetaan SN → lambung. */
  function unitKeyOf(unit, ctx) {
    if (!unit) return '';
    var direct = unit.lambung || '';
    if (direct) return direct;
    var mapped = lambungOf(unit.serial || unit.key || '', ctx || lambungContext());
    return mapped.lambung || unit.serial || unit.key || '';
  }

  /**
   * augmentSupport(units, ranges, opts) — tambahkan `aSupp`/`bSupp` ke
   * setiap baris hasil `compareRows()`.
   *
   * Dipisah dari `compareRows()` supaya fungsi pembanding tetap MURNI dan
   * ringan: kolom pendukung adalah LAPISAN TAMBAHAN yang boleh gagal tanpa
   * membatalkan vonis. Hasilnya diubah di tempat (baris dikembalikan).
   */
  function augmentSupport(rows, units, ranges, opts) {
    var byKey = {};
    (units || []).forEach(function (u) {
      var lb = lambungOf(u.serial, (opts && opts.ctx) || lambungContext());
      byKey[u.key || u.serial] = u;
      byKey[lb.lambung] = u;
    });
    (rows || []).forEach(function (r) {
      var u = byKey[r.key] || byKey[r.lambung] || byKey[r.serial];
      if (!u) return;
      r.aSupp = supportStats(u, (ranges && ranges.a) || {}, opts);
      r.bSupp = supportStats(u, (ranges && ranges.b) || {}, opts);
    });
    return rows;
  }

  /**
   * compareTotals(rows) — ringkasan armada untuk panel Between.
   *
   * ANGKA UTAMA (`deltaPct`) = MEDIAN Δ% PER UNIT (lihat blok HEADLINE di
   * dalam fungsi). `aLTk`/`bLTk` tetap rata-rata tertimbang baris dan tetap
   * ditampilkan, tetapi selisihnya kini bernama `weightedDeltaPct` supaya
   * tidak ada lagi angka yang menyebut dirinya "armada" padahal sebagian
   * besar gerakannya berasal dari komposisi sampel.
   *
   * Hanya unit yang BERVONIS yang masuk. `INSUFFICIENT` (F3) dihitung
   * terpisah: ia bukan "stabil" dan bukan "tanpa angka".
   *
   * [F2 2026-10-29] `basis` menerbitkan JUMLAH BARIS yang menopang angka
   * tertimbang. Tanpa ini, A 0,1612 -> B 0,1324 (-17,9 %) sementara tiap
   * unit hanya bergerak +5,4 % .. -4,5 % terlihat MUSTAHIL.
   */
  function compareTotals(rows) {
    var t = {
      units: 0, counts: { HEMAT: 0, BOROS: 0, STABIL: 0 }, noVerdict: 0,
      insufficient: 0,
      aLTk: null, bLTk: null, deltaPct: null, verdict: null,
      // [F7' 2026-10-29] Angka UTAMA panel. Lihat blok HEADLINE di bawah.
      medianDeltaPct: null, deltas: [],
      // Rata-rata tertimbang baris DIPERTAHANKAN dengan nama yang jujur,
      // supaya angka historis tetap bisa ditelusuri — tapi TIDAK lagi
      // menjadi headline.
      weightedDeltaPct: null,
      // [F6 2026-10-29] Angka AUDIT: rata-rata yang kedua sisinya memakai
      // bobot yang SAMA (bobot A). Selisihnya terhadap `weightedDeltaPct`
      // adalah besaran efek komposisi — bukan tebakan, melainkan hitungan.
      fixedWeightDeltaPct: null,
      compositionShiftPct: null,
      // Unit yang DIKELUARKAN, disebut per nomor lambung. "Tanpa vonis 1"
      // tidak bisa ditindaklanjuti; "HDKM78566 tak ada angka di B" bisa.
      excluded: { oneSided: [], insufficient: [] },
      basis: { aRows: 0, bRows: 0, aWindows: 0, bWindows: 0 }
    };
    var aw = 0, bw = 0, awn = 0, bwn = 0;
    var bFixed = 0;   // Σ (bLTk × bobot A) — penyebutnya sama dengan `awn`.
    (rows || []).forEach(function (r) {
      // [F3] INSUFFICIENT bukan vonis: unit itu TIDAK menambah Hemat/Boros/
      // Stabil dan TIDAK masuk rata-rata mana pun. Dihitung terpisah agar
      // bisa disebut di layar, bukan hilang diam-diam.
      if (r.verdict === 'INSUFFICIENT') {
        t.insufficient++;
        t.excluded.insufficient.push(r.lambung || r.serial || r.key);
        return;
      }
      if (!r.verdict) {
        t.noVerdict++;
        t.excluded.oneSided.push(r.lambung || r.serial || r.key);
        return;
      }
      t.units++;
      t.counts[r.verdict]++;
      if (r.deltaPct != null && isFinite(r.deltaPct)) t.deltas.push(r.deltaPct);
      // [F2] Baris yang BENAR-BENAR menopang angka armada: unit bervonis di
      // kedua sisi selalu punya >= 1 baris; `|| 0` menjaga unit tanpa field
      // (fixture lama / pemanggil luar) tidak mengarang 1 baris.
      t.basis.aRows += r.aWindows || 0;
      t.basis.bRows += r.bWindows || 0;
      var wa = r.aWindows || 1, wb = r.bWindows || 1;
      t.basis.aWindows += wa; t.basis.bWindows += wb;
      aw += r.aLTk * wa; awn += wa;
      bw += r.bLTk * wb; bwn += wb;
      // [F6] Sisi B dengan bobot A: satu-satunya cara memisahkan "konsumsi
      // berubah" dari "komposisi sampel berubah" tanpa data tambahan.
      bFixed += r.bLTk * wa;
    });
    if (!t.units) return t;
    t.aLTk = awn ? aw / awn : null;
    t.bLTk = bwn ? bw / bwn : null;

    /* ---------------------------------------------------------------------
     * [F7' 2026-10-29] HEADLINE = MEDIAN Δ% PER UNIT
     * -------------------------------------------------------------------
     * TEMUAN YANG MEMAKSA PERUBAHAN INI (data pilot 2026-10-29): tak satu
     * pun dari 5 unit bergerak lebih dari 4,5 %, tetapi KPI armada melaporkan
     * −17,9 %. Angka itu benar secara aritmetika dan salah secara kesimpulan.
     *
     * Sebabnya paradoks Simpson, bukan penghematan:
     *   HDKM78468 berkonsumsi 0,31 L/TKM (2,6× armada). Bobotnya di A
     *   22/97 = 22,7 % baris; di B hanya 1/14 = 7,1 %. Unit boros itu
     *   "keluar" dari rata-rata, dan rata-rata pun jatuh.
     *   Dengan bobot yang DISAMAKAN, armada justru +1,0 %.
     *
     * Rata-rata tertimbang baris MENGUKUR DUA HAL SEKALIGUS — perubahan
     * konsumsi dan perubahan komposisi sampel — lalu melaporkannya sebagai
     * satu angka. Σ liter ÷ Σ ton-km TIDAK memperbaikinya: unit yang datanya
     * hilang tetap hilang dari pembilang maupun penyebut.
     *
     * Median Δ% per unit kebal terhadap komposisi: tiap unit dibandingkan
     * DENGAN DIRINYA SENDIRI, lalu satu unit = satu suara. Bonusnya, angka
     * ini sejalan dengan vonis per baris yang sudah terlihat di tabel, jadi
     * layar tidak lagi menunjukkan dua kesimpulan yang bertentangan.
     *
     * Yang lama tetap dihitung (`weightedDeltaPct`) dan boleh ditampilkan —
     * tapi dengan NAMA yang menyebut bobotnya, bukan sebagai "armada".
     * ------------------------------------------------------------------- */
    t.medianDeltaPct = _med2(t.deltas);
    if (t.aLTk > 0 && t.bLTk != null) {
      t.weightedDeltaPct = 100 * (t.bLTk - t.aLTk) / t.aLTk;
      /* [F6 2026-10-29] BESARAN EFEK KOMPOSISI, dihitung bukan ditebak.
       * `fixedWeight` memakai bobot A di KEDUA sisi, jadi satu-satunya hal
       * yang berubah adalah L/TKM tiap unit. Selisih antara keduanya
       * karenanya MURNI berasal dari perpindahan bobot.
       * Pada data pilot: −17,9 % (tertimbang) vs +1,0 % (bobot tetap) →
       * 18,9 poin persen yang selama ini terbaca sebagai "penghematan". */
      var bFix = awn ? bFixed / awn : null;
      if (bFix != null) {
        t.fixedWeightDeltaPct = 100 * (bFix - t.aLTk) / t.aLTk;
        t.compositionShiftPct = t.weightedDeltaPct - t.fixedWeightDeltaPct;
      }
    }
    // `deltaPct` = angka yang DICETAK di chip hasil armada. Dipindahkan ke
    // median agar nama lama tidak menunjuk ke rumus yang sudah ditinggalkan.
    t.deltaPct = t.medianDeltaPct;

    // Vonis armada = suara mayoritas unit, BUKAN tanda selisih rata-rata:
    // satu unit yang memburuk tajam bisa membalik rata-rata armada yang
    // sebenarnya membaik.
    //
    // [TEMUAN VERIFIKASI BROWSER 2026-10-29] 1 Hemat + 1 Boros sebelumnya
    // dilaporkan 'STABIL'. Itu KELIRU: "stabil" berarti tidak berubah,
    // sedangkan yang terjadi adalah armada TERBAGI (ada yang membaik, ada
    // yang memburuk) — kesimpulan yang berbeda tindak lanjutnya.
    //
    // [F7' 2026-10-29] Syarat `t.aLTk > 0` DILEPAS. Vonis ini tidak pernah
    // memakai rata-rata tertimbang; menggantungkannya pada angka itu berarti
    // armada kehilangan vonis hanya karena satu unit tak punya `aLTk` —
    // padahal setiap unit yang dihitung di sini SUDAH bervonis.
    var c = t.counts;
    if (c.HEMAT > c.BOROS) t.verdict = 'HEMAT';
    else if (c.BOROS > c.HEMAT) t.verdict = 'BOROS';
    else t.verdict = (c.HEMAT === 0) ? 'STABIL' : 'TERBAGI';
    return t;
  }

  /* -----------------------------------------------------------------------
   * [PAGINASI 2026-10-29] pageSlice(rows, page, size) — MURNI.
   *
   * Dulu aritmetika halaman ditulis INLINE di `fuel-app.js` (dua kali: tabel
   * utama & panel Between), bercampur dengan penulisan DOM, sehingga tidak
   * bisa diuji di Node — sabotase `pageRows = sorted` dan `pageSize = 1e9`
   * dua-duanya LOLOS hijau. Satu fungsi, satu definisi, dapat diuji.
   *
   * Aturan yang ditegakkan di sini (semuanya pernah jadi bug di proyek ini):
   *  - `page` di luar jangkauan DIJEPIT, tidak pernah menghasilkan halaman
   *    kosong. Daftar menyusut (mis. filter diperketat) tidak boleh membuat
   *    operator mendarat di layar hampa.
   *  - `page` yang BUKAN angka (NaN, '', null, '3') dinormalkan — `||` tidak
   *    dipakai karena 0 adalah nilai yang mungkin masuk.
   *  - `pageCount` minimal 1 walau `rows` kosong, supaya pembagi tidak nol.
   *
   * Mengembalikan `{ rows, page, pageCount, size, total, from, to }`;
   * `from`/`to` berbasis 1 untuk teks "menampilkan 11–20 dari 57".
   * --------------------------------------------------------------------- */
  function pageSlice(rows, page, size) {
    var list = Array.isArray(rows) ? rows : [];
    var n = Number(size);
    var sz = (isFinite(n) && n >= 1) ? Math.floor(n) : 10;
    var pageCount = Math.max(1, Math.ceil(list.length / sz));
    var p = Number(page);
    if (!isFinite(p)) p = 1;
    p = Math.floor(p);
    if (p < 1) p = 1;
    if (p > pageCount) p = pageCount;
    var from = list.length ? (p - 1) * sz + 1 : 0;
    var slice = list.slice((p - 1) * sz, p * sz);
    return {
      rows: slice, page: p, pageCount: pageCount, size: sz,
      total: list.length, from: from, to: list.length ? from + slice.length - 1 : 0
    };
  }

  /* -----------------------------------------------------------------------
   * [F9 2026-10-29] compareCsv(rows, ranges) — ekspor APA YANG DILIHAT.
   *
   * MURNI (mengembalikan string; tidak menyentuh DOM/Blob) supaya isinya
   * bisa diuji tanpa peramban.
   *
   * Yang diekspor MENCAKUP kolom yang tidak tampil di tabel (cakupan, kedua
   * batas pita, sebab penahanan). Sebabnya: berkas CSV dipakai untuk audit,
   * dan audit yang hanya memuat angka hasil tidak bisa memeriksa apakah
   * angka itu layak diterbitkan. Pemisah `;` dan desimal `.` mengikuti
   * seluruh ekspor lain di proyek ini.
   * --------------------------------------------------------------------- */
  function compareCsv(rows, ranges) {
    var esc = (global.CSV_UTIL && global.CSV_UTIL.csvEscape) || function (v) {
      var s = (v == null) ? '' : String(v);
      return /[;,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var a = (ranges && ranges.a) || {}, b = (ranges && ranges.b) || {};
    var head = [
      'lambung', 'serial', 'model',
      'a_mulai', 'a_selesai', 'b_mulai', 'b_selesai',
      'a_ltkm', 'b_ltkm', 'delta_pct',
      'pita_bawah_pct', 'pita_atas_pct', 'pita_dari_sigma',
      'a_baris', 'b_baris', 'a_hari', 'b_hari',
      'a_hari_periode', 'b_hari_periode', 'a_cakupan', 'b_cakupan',
      'baris_sisi_lemah', 'keyakinan',
      // [SUPPORT 2026-10-30] Angka pendukung. Ditempatkan SESUDAH kolom audit
      // agar pembaca lama tidak kehilangan urutan kolomnya. Kolom yang
      // memang tidak tersedia tetap DICETAK KOSONG (bukan 0).
      'a_operasi_jam', 'b_operasi_jam',
      'a_siklus', 'b_siklus', 'a_tonase', 'b_tonase', 'basis_siklus',
      // [SUPPORT 2026-10-30] Jarak & idle dari rekap pldcyc per tanggal.
      // `idle_menit` diekspor dalam MENIT (satuan asli pldcyc) agar bisa
      // diperiksa ulang; layar membagi 60 ke jam.
      'a_jarak_kosong_km', 'b_jarak_kosong_km',
      'a_jarak_muatan_km', 'b_jarak_muatan_km',
      'a_idle_menit', 'b_idle_menit',
      'a_idle_kosong_menit', 'b_idle_kosong_menit',
      'a_idle_loading_menit', 'b_idle_loading_menit',
      'a_idle_muatan_menit', 'b_idle_muatan_menit',
      'a_gps_drop_m', 'b_gps_drop_m', 'a_gps_climb_m', 'b_gps_climb_m',
      'a_gps_hari', 'b_gps_hari',
      'vonis', 'sebab'
    ];
    function n(v, d) {
      return (v == null || !isFinite(v)) ? '' : Number(v).toFixed(d);
    }
    function s(side, k) { return side ? side[k] : null; }
    var lines = [head.map(esc).join(';')];
    (rows || []).forEach(function (r) {
      lines.push([
        r.lambung || '', r.serial || '', r.model || '',
        a.dateStart || '', a.dateEnd || '', b.dateStart || '', b.dateEnd || '',
        n(r.aLTk, 6), n(r.bLTk, 6), n(r.deltaPct, 2),
        n(r.bandDown, 2), n(r.bandUp, 2), r.bandFromSigma ? '1' : '0',
        r.aWindows || 0, r.bWindows || 0, r.aDays || 0, r.bDays || 0,
        r.aPeriodDays || 0, r.bPeriodDays || 0, n(r.aCov, 4), n(r.bCov, 4),
        r.weakRows == null ? '' : r.weakRows, r.confidence || '',
        n(s(r.aSupp, 'hours'), 1), n(s(r.bSupp, 'hours'), 1),
        n(s(r.aSupp, 'cycles'), 0), n(s(r.bSupp, 'cycles'), 0),
        n(s(r.aSupp, 'tonnage'), 1), n(s(r.bSupp, 'tonnage'), 1),
        (r.aSupp && r.aSupp.cycleBasis) || (r.bSupp && r.bSupp.cycleBasis) || '',
        n(s(r.aSupp, 'distEmpty'), 2), n(s(r.bSupp, 'distEmpty'), 2),
        n(s(r.aSupp, 'distLoaded'), 2), n(s(r.bSupp, 'distLoaded'), 2),
        n(s(r.aSupp, 'idleMin'), 1), n(s(r.bSupp, 'idleMin'), 1),
        n(s(r.aSupp, 'sE'), 1), n(s(r.bSupp, 'sE'), 1),
        n(s(r.aSupp, 'sL'), 1), n(s(r.bSupp, 'sL'), 1),
        n(s(r.aSupp, 'sLd'), 1), n(s(r.bSupp, 'sLd'), 1),
        n(s(r.aSupp, 'dropGps'), 1), n(s(r.bSupp, 'dropGps'), 1),
        n(s(r.aSupp, 'climbGps'), 1), n(s(r.bSupp, 'climbGps'), 1),
        s(r.aSupp, 'gpsDays') == null ? '' : s(r.aSupp, 'gpsDays'),
        s(r.bSupp, 'gpsDays') == null ? '' : s(r.bSupp, 'gpsDays'),
        r.verdict || '', r.reason || ''
      ].map(esc).join(';'));
    });
    return lines.join('\r\n');
  }

  var CMP_META = {
    HEMAT:  { cls: 'is-normal',   label: 'Lebih Hemat' },
    BOROS:  { cls: 'is-critical', label: 'Lebih Boros' },
    STABIL: { cls: 'is-warning',  label: 'Stabil' },
    // [F3 2026-10-29] Kategori keempat. BUKAN sinonim "stabil": stabil
    // berarti sudah diukur dan tidak berubah, ini berarti BELUM terukur.
    // Menggabungkan keduanya membuat unit bersampel 1 baris tampak aman.
    INSUFFICIENT: { cls: 'is-mute', label: 'Data tidak cukup' },
    // Hanya dipakai pada vonis ARMADA (tidak ada di tingkat unit): jumlah
    // unit membaik = jumlah unit memburuk.
    TERBAGI: { cls: 'is-warning', label: 'Terbagi' }
  };

  /**
   * dataLastDate(units) — tanggal LOKAL terakhir yang BENAR-BENAR berdata.
   *
   * [F2 2026-10-29] Sumber: setiap `date` di jendela (semua, bukan hanya
   * yang lolos gerbang — hari yang datanya ada tapi jendelanya gugur tetap
   * hari berdata) dan di `trendSeries`. Mengembalikan 'YYYY-MM-DD' atau null.
   *
   * Dipakai sebagai `max` input tanggal pembanding. Alasannya: rentang yang
   * melewati data terakhir membuat cakupan periode dihitung dari hari yang
   * memang belum diunggah — "4 dari 30 hari" menyalahkan operator untuk hari
   * yang datanya belum ada.
   */
  function dataLastDate(units) {
    var max = null;
    (units || []).forEach(function (u) {
      unitWindows(u).forEach(function (w) {
        var d = String((w && w.date) || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!max || d > max)) max = d;
      });
      unitSeries(u).forEach(function (x) {
        var d = String((x && x.date) || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!max || d > max)) max = d;
      });
    });
    return max;
  }

  /**
   * ymdLocal(date) — 'YYYY-MM-DD' menurut tanggal LOKAL peramban.
   * `toISOString()` memakai UTC: pada WIB (UTC+8) tanggal 1 pukul 07.00
   * menjadi '…-31' — atribut `max` lalu melarang hari ini.
   */
  function ymdLocal(date) {
    var d = date || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /**
   * compareChartModel(rows) — model chart murni (tanpa Chart.js/DOM).
   * Hanya unit BERVONIS yang digambar: bar kosong untuk unit tanpa angka
   * terbaca sebagai nol, dan nol berarti "paling hemat".
   *
   * [F1 2026-10-29] Model ini TIDAK punya seri garis. Sebelumnya chart
   * menambahkan dataset `Trending` dari `model.after` — menghubungkan nilai
   * antar unit, bukan antar waktu. Unit bukan deret waktu.
   */
  function compareChartModel(rows) {
    // [F3 2026-10-29] `INSUFFICIENT` TIDAK digambar. Barnya akan terlihat
    // sama kokohnya dengan unit ber-22 baris, padahal angkanya berasal dari
    // satu pembacaan — chart akan membantah tabel di bawahnya.
    var ok = (rows || []).filter(function (r) {
      return r.verdict && r.verdict !== 'INSUFFICIENT';
    });
    // Terburuk di kiri: yang perlu ditindak harus terlihat tanpa menggulir.
    ok.sort(function (p, q) { return q.deltaPct - p.deltaPct; });
    return {
      labels: ok.map(function (r) { return r.lambung || r.serial || r.key; }),
      before: ok.map(function (r) { return r.aLTk; }),
      after: ok.map(function (r) { return r.bLTk; }),
      deltaPct: ok.map(function (r) { return r.deltaPct; }),
      verdicts: ok.map(function (r) { return r.verdict; }),
      rows: ok
    };
  }

  /**
   * fleetTotals(units) — ringkasan armada.
   *
   * [SEBAB] Rata-rata dari rata-rata SALAH: unit dengan 90 jendela tidak
   * boleh sama beratnya dengan unit yang hanya 10 jendela. Keduanya
   * disediakan dan DIBERI NAMA jelas supaya pembaca tidak salah pilih.
   */
  function fleetTotals(units) {
    return fleetTotalsFromRows(ratioRows(units));
  }

  /**
   * fleetTotalsFromRows(rows) — versi yang menerima BARIS yang sudah
   * difilter. [2026-10-28] Dibutuhkan karena ringkasan Normal/Caution/Over
   * dan KPI harus mengikuti filter (termasuk rentang tanggal); memberi
   * `units` mentah membuat kartu KPI melaporkan armada penuh sementara tabel
   * di bawahnya menampilkan subset — dua angka berbeda di satu layar.
   */
  function fleetTotalsFromRows(rows) {
    rows = rows || [];
    var out = {
      units: rows.length, withBaseline: 0, windows: 0,
      // `days` = total hari-unit (jumlah hari kalender berdata, per unit,
      // dijumlahkan). BUKAN jumlah hari kalender armada — dua unit yang
      // beroperasi di hari yang sama dihitung 2.
      days: 0,
      counts: { NORMAL: 0, CAUTION: 0, OVER: 0 },
      lTkSimple: null, lTkWeighted: null, sumW: 0
    };
    var sum = 0, wsum = 0, w = 0;
    rows.forEach(function (r) {
      out.windows += r.eligible || 0;
      out.days += r.dayCount || 0;
      out.counts.NORMAL += r.counts.NORMAL;
      out.counts.CAUTION += r.counts.CAUTION;
      out.counts.OVER += r.counts.OVER;
      if (r.lTk != null) {
        out.withBaseline++;
        sum += r.lTk;
        wsum += r.lTk * (r.eligible || 0);
        w += (r.eligible || 0);
      }
    });
    out.lTkSimple = out.withBaseline ? sum / out.withBaseline : null;
    out.sumW = w;
    // Tertimbang hanya bermakna bila memang ada jendela.
    out.lTkWeighted = w > 0 ? wsum / w : null;
    return out;
  }

  /* -----------------------------------------------------------------------
   * renderOverload(rows) — temuan independen dari fuel.
   * --------------------------------------------------------------------- */
  function renderOverload(rows) {
    var panel = $id('fuel-overload-panel'), host = $id('fuel-overload');
    if (!panel || !host) return;
    if (!rows || !rows.length) { panel.style.display = 'none'; host.innerHTML = ''; return; }
    panel.style.display = '';
    host.innerHTML = '<table style="font-size:12px;border-collapse:collapse;min-width:420px">' +
      '<thead><tr style="color:var(--text-dim)">' +
        '<th style="text-align:left">Bulan</th><th style="text-align:right">Siklus</th>' +
        '<th style="text-align:right">Over Load</th><th style="text-align:left;padding-left:16px">Payload median</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (m) {
        var pct = m.overPct == null ? null : 100 * m.overPct;
        var cls = (pct != null && pct >= 50) ? 'is-critical' : (pct >= 30 ? 'is-warning' : 'is-normal');
        return '<tr><td>' + esc(m.month) + '</td>' +
          '<td style="text-align:right">' + esc(String(m.n)) + '</td>' +
          '<td style="text-align:right"><span class="badge ' + cls + '">' + num(pct, 0) + ' %</span></td>' +
          '<td style="padding-left:16px">' + num(m.payloadMedian, 1) + ' t</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* -----------------------------------------------------------------------
   * renderDropped(res) — transparansi gerbang.
   * --------------------------------------------------------------------- */
  function renderDropped(res) {
    var panel = $id('fuel-dropped-panel'), host = $id('fuel-dropped');
    if (!panel || !host) return;
    var by = {}, gs = (res && res.gateStats) || {};
    ((res && res.trace) || []).forEach(function (w) {
      if (w.drop) by[w.drop] = (by[w.drop] || 0) + 1;
    });
    var keys = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    if (!keys.length) { panel.style.display = 'none'; host.innerHTML = ''; return; }
    panel.style.display = '';

    // [3] = satuan. Siklus dan jendela BUKAN satuan yang sama; menulis
    // "1 siklus" untuk jendela yang gugur membuat pembaca salah menilai
    // besarnya data yang dibuang.
    var GATE_ROWS = [
      ['Siklus: payload < 5 t', gs.payload, 'siklus'],
      ['Siklus: kecepatan di luar 5–60 km/h', gs.speed, 'siklus'],
      ['Siklus: jarak tempuh kosong < 0,5 km (sensor)', gs['empty-dist'], 'siklus'],
      ['Siklus: tanpa waktu jalan', gs['no-drive-time'], 'siklus'],
      ['Jendela gugur: coverage < 70 %', gs.lowCoverage, 'jendela'],
      ['Jendela gugur: siklus < 10', gs.lowCycles, 'jendela']
    ].filter(function (r) { return r[1]; });

    var html = '';
    if (keys.length) {
      html += '<table style="font-size:12px;border-collapse:collapse;min-width:420px"><tbody>' +
        keys.map(function (k) {
          return '<tr><td style="padding-right:16px">' + esc(DROP_LABEL[k] || k) + '</td>' +
            '<td style="text-align:right"><strong>' + esc(String(by[k])) + '</strong> jendela</td></tr>';
        }).join('') + '</tbody></table>';
    }
    if (GATE_ROWS.length) {
      html += '<p class="panel-sub" style="margin:10px 0 4px">Siklus yang ditolak:</p>' +
        '<table style="font-size:12px;border-collapse:collapse;min-width:420px"><tbody>' +
        GATE_ROWS.map(function (r) {
          return '<tr><td style="padding-right:16px">' + esc(r[0]) + '</td>' +
            '<td style="text-align:right"><strong>' + esc(String(r[1])) + '</strong> ' + esc(r[2]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    // Yang DITANDAI (tidak dibuang) — penting agar user tahu ini bukan bug.
    if (gs.asymFlagged) {
      html += '<p class="panel-sub" style="margin:10px 0 0">Ditandai (TIDAK dibuang): ' +
        '<strong>' + esc(String(gs.asymFlagged)) + '</strong> siklus dengan rute kosong/muatan ' +
        'sangat asimetris — siklus transisi rute, pembakarannya nyata.</p>';
    }
    if (gs.gradeDisabled) {
      html += '<p class="panel-sub" style="margin:6px 0 0">Grade tidak dipakai pada <strong>' +
        esc(String(gs.gradeDisabled)) + '</strong> siklus (jarak bermuatan < 1 km: sudut didominasi ' +
        'manuver dumping).</p>';
    }
    host.innerHTML = html;
  }

  /** Kosongkan seluruh tampilan hasil (dipakai saat berkas dikosongkan). */
  function clearAll() {
    _state.verdictFilter = null;
    renderWarnings(null);
    renderSummary(null);
    renderBaselineCards(null);
    renderChart(null);   // juga men-destroy chart lama
    renderWaterfall(null);
    renderCorrelation(null);
    renderTable(null);
    renderOverload(null);
    renderDropped(null);
    // [BETWEEN 2026-10-29] Chart pembanding ikut di-destroy. Tanpa ini ia
    // tertinggal di kanvas setelah data dihapus dan terbaca sebagai data
    // yang masih ada (cacat yang sama dengan FUEL-CHART-7).
    renderCompareChart(null);
    var p = $id('fuel-table-note'); if (p) p.textContent = '';
  }

  /**
   * render(res, cycles) — gambar semua bagian.
   * @param {Object} res hasil FUEL_ANALYTICS.analyze()
   * @param {Array}  cycles daftar siklus (untuk panel overload)
   * @param {Object} [corr] hasil FUEL_ANALYTICS.dailyCorrelation() — opsional
   */
  function render(res, cycles, corr) {
    var A = global.FUEL_ANALYTICS;
    renderWarnings(res);
    renderSummary(res);
    renderBaselineCards(res);
    renderChart(res);
    renderWaterfall(res);
    renderCorrelation(corr);
    renderTable(res);
    renderOverload(A ? A.overloadByMonth(cycles || [], 28800) : null);
    renderDropped(res);
  }

  /**
   * metricHelp(key) — teks bantuan satu metrik baseline.
   * MURNI (dipakai kartu ringkasan maupun pengujian): `{ title, formula,
   * note, detail, unit }` atau null bila kunci tidak dikenal.
   */
  function metricHelp(key) {
    var meta = CARD_META[key];
    if (!meta) return null;
    return {
      title: meta.label,
      formula: meta.formula,
      note: meta.note,
      detail: METRIC_HELP[key] || '',
      unit: meta.unit
    };
  }

  global.FUEL_RENDER = {
    render: render,
    clearAll: clearAll,
    setVerdictFilter: setVerdictFilter,
    getVerdictFilter: getVerdictFilter,
    metricHelp: metricHelp,
    // [WILAYAH UJI] Model chart murni + renderer Chart.js.
    chartModel: chartModel,
    renderChart: renderChart,
    renderWaterfall: renderWaterfall,
    renderCorrelation: renderCorrelation,
    // Baseline kartu + waterfall (permintaan user 2026-10-28) — murni.
    baselineCards: baselineCards,
    waterfall: waterfall,
    formulaHelp: formulaHelp,
    canOpenUnit: canOpenUnit,
    // Fleet: tabel "Trending Fuel Ratio List" (multi-unit) — murni.
    // [REVISI 2026-10-28] Kolom "Event" (dulu "Result"): observasi per fakta,
    // satu kalimat per baris, satuan "baris".
    eventLines: eventLines,
    eventText: eventText,
    eventHtml: eventHtml,
    flagStats: flagStats,
    ratioRows: ratioRows,
    // [2026-10-28] SN -> Nomor Lambung (sumber: VHMS_UNITDB + Lifetime).
    normSn: normSn,
    lambungOf: lambungOf,
    snLambungMap: snLambungMap,
    lambungContext: lambungContext,
    registerLambungRows: registerLambungRows,
    filterRatioRows: filterRatioRows,
    unitDateRange: unitDateRange,
    // [F2] Batas tanggal berdata untuk input pembanding (murni, teruji).
    dataLastDate: dataLastDate,
    ymdLocal: ymdLocal,
    // [RENTANG 2026-10-28] Agregat per rentang tanggal (murni).
    scopeUnit: scopeUnit,
    smrForDates: smrForDates,
    fleetTotals: fleetTotals,
    fleetTotalsFromRows: fleetTotalsFromRows,
    // [BETWEEN 2026-10-29] Pembanding dua rentang (murni) + chart-nya.
    compareRows: compareRows,
    compareTotals: compareTotals,
    compareChartModel: compareChartModel,
    renderCompareChart: renderCompareChart,
    // [SUPPORT 2026-10-30] Angka pendukung (jam, siklus, tonase, GPS) per
    // sisi. Murni terhadap data unit yang diberikan -> dapat diuji di Node.
    supportStats: supportStats,
    augmentSupport: augmentSupport,
    // [F0] Diekspor untuk tes & tooltip: batas pita per arah.
    CMP_BAND_FALLBACK: CMP_BAND_FALLBACK,
    // [F3] Satu sumber ambang kecukupan untuk UI, uji, dan dokumen.
    CMP_LIMITS: CMP_LIMITS,
    // [F9] Ekspor CSV panel Between (murni, dapat diuji di Node).
    compareCsv: compareCsv,
    // [PAGINASI 2026-10-29] Satu aritmetika halaman untuk kedua tabel.
    pageSlice: pageSlice,
    // [F1] Hook DOM untuk tes chart di Node (hanya tes yang memakai).
    setDomLookup: setDomLookup,
    // [HOME 2026-10-28] KPI ringkas halaman home (murni, teruji).
    kpiSummary: kpiSummary,
    kpiSummaryFromRows: kpiSummaryFromRows,
    kpiText: kpiText,
    _labels: { verdict: VERDICT_META, driver: DRIVER_LABEL, drop: DROP_LABEL, compare: CMP_META },
    _num: num
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.FUEL_RENDER;

})(typeof window !== 'undefined' ? window : globalThis);

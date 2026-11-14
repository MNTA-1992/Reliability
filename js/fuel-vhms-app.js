/* =========================================================================
 * fuel-vhms-app.js  [2026-11-03]
 * -------------------------------------------------------------------------
 * Controller sub-tab "Intel Mesin & Fuel" (Sub-Tab 3 pada Fuel Trending).
 *
 * Tanggung jawab:
 *   1. Switch sub-tab (aktifkan / sembunyikan panel).
 *   2. Eksekusi FUEL_VHMS_ANALYTICS.analyzeFleetEngineFuel() saat tombol diklik.
 *   3. Render 4 KPI Card, kuadran scatter (Chart.js), tabel prioritas, bin tabel.
 *   4. Tampilkan modal Failure Mode Report saat baris P1/P2 diklik.
 *   5. Tombol "Salin Teks" laporan ke clipboard.
 *
 * Dependensi (harus dimuat SEBELUM file ini):
 *   - js/fuel-vhms-analytics.js  → window.FUEL_VHMS_ANALYTICS
 *   - js/fuel-store.js            → window.FUEL_STORE
 *   - js/vhms-fleet-store.js      → window.VHMS_FLEET  (opsional)
 *   - js/vhms-unit-db.js          → window.VHMS_UNIT_DB (opsional)
 *   - vendor/chart.js             → window.Chart
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Referensi DOM & state lokal
   * --------------------------------------------------------------------- */
  var _scatterChart = null; // Referensi instance Chart.js scatter
  var _lastFleetResult = null; // Cache hasil analisis armada terakhir untuk ekspor

  function $id(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function showEl(el, display) {
    if (!el) return;
    el.style.display = display || 'block';
  }

  function hideEl(el) {
    if (!el) return;
    el.style.display = 'none';
  }

  /* -----------------------------------------------------------------------
   * Utilitas format angka
   * --------------------------------------------------------------------- */
  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toLocaleString('id-ID', {
      minimumFractionDigits: d != null ? d : 2,
      maximumFractionDigits: d != null ? d : 2
    });
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function esc(s) {
    return s == null ? '' : String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* -----------------------------------------------------------------------
   * Switch Sub-Tab (Trending | Intel GPS | Intel Mesin)
   * --------------------------------------------------------------------- */
  function initSubTabSwitcher() {
    var panels = {
      'btn-subtab-fuel-trending': 'fuel-trending-subtab-panel',
      'btn-subtab-fuel-route':    'fuel-route-intel-subtab-panel',
      'btn-subtab-fuel-vhms':     'fuel-vhms-intel-subtab-panel'
    };

    Object.keys(panels).forEach(function (btnId) {
      var btn = $id(btnId);
      if (!btn) return;
      btn.addEventListener('click', function () {
        // Nonaktifkan semua tombol
        Object.keys(panels).forEach(function (id) {
          var b = $id(id);
          if (b) b.classList.remove('active');
        });
        // Sembunyikan semua panel
        Object.keys(panels).forEach(function (id) {
          var p = $id(panels[id]);
          if (p) hideEl(p);
        });
        // Aktifkan yang dipilih
        btn.classList.add('active');
        var targetPanel = $id(panels[btnId]);
        if (targetPanel) {
          targetPanel.style.display = 'flex';
          targetPanel.style.flexDirection = 'column';
        }

        // Auto-run analisis saat sub-tab Intel Mesin dibuka jika belum pernah atau hasil kosong
        if (btnId === 'btn-subtab-fuel-vhms' && (!_lastFleetResult || (_lastFleetResult.kpi && _lastFleetResult.kpi.totalUnits === 0))) {
          runAnalysis();
        }
      });
    });
  }

  /* -----------------------------------------------------------------------
   * Render 4 KPI Card
   * --------------------------------------------------------------------- */
  function renderKpiCards(kpi, baseline) {
    var bar = $id('vhms-intel-kpi-bar');
    var host = $id('vhms-intel-kpi-cards');
    if (!host) return;

    var fuelPrice = 15000; // Rp/liter default

    var cards = [
      {
        icon: 'fa-engine',
        color: '#ef4444',
        label: 'Unit Berpenalti Tinggi (P1)',
        value: kpi.highPenaltyCount || 0,
        unit: 'unit',
        // `kpi.totalUnits` bisa undefined - terukur di peramban sebagai
        // "dari undefined unit dianalisis".
        sub: 'dari ' + (kpi.totalUnits != null ? kpi.totalUnits : 0) + ' unit dianalisis',
        accent: kpi.highPenaltyCount > 0 ? '#ef4444' : '#22c55e'
      },
      {
        icon: 'fa-chart-scatter',
        color: '#38bdf8',
        label: 'Korelasi Armada (R²)',
        value: (kpi.correlationR2Env != null ? (kpi.correlationR2Env * 100).toFixed(1) : (kpi.correlationR2 != null ? (kpi.correlationR2 * 100).toFixed(1) : '—')),
        unit: '%',
        sub: (kpi.correlationR2Env != null && kpi.correlationR2 != null && Math.abs(kpi.correlationR2Env - kpi.correlationR2) > 0.001)
          ? 'EAB: ' + (kpi.correlationR2Env * 100).toFixed(1) + '% (Mentah: ' + (kpi.correlationR2 * 100).toFixed(1) + '%)'
          : 'Blowby ↔ L/GTKM',
        accent: '#38bdf8'
      },
      {
        icon: 'fa-gas-pump',
        color: '#f59e0b',
        label: 'Solar Terbuang / Hari',
        value: fmt(kpi.fleetWastedLitersPerDay, 0),
        unit: 'L/hari',
        // CAKUPAN ditampilkan [F2 2026-11-07, akar AUD-8]: total yang hanya
        // mewakili sebagian unit tidak boleh tampak seperti total armada.
        // Unit tanpa GTKM tidak bisa dihitung dan harus terlihat, bukan
        // hilang senyap dari penyebut.
        sub: (kpi.fleetWastedLitersPerDay == null)
          ? 'tak satu pun unit dapat dihitung (butuh GTKM)'
          : ('\u2248 ' + fmt(kpi.fleetWastedLitersPerMonth, 0) + ' L/bulan' +
             (kpi.unitsCounted != null
               ? ' \u00b7 dari ' + kpi.unitsCounted + '/' +
                 (kpi.unitsCounted + (kpi.unitsUncounted || 0)) + ' unit terhitung'
               : ' armada')),
        accent: '#f59e0b'
      },
      {
        icon: 'fa-piggy-bank',
        color: '#22c55e',
        label: 'Potensi Hemat / Bulan',
        // `|| 0` DICABUT [F2 2026-11-07]. Pola itu mengubah `null`
        // ("tidak bisa dihitung") menjadi "Rp 0 juta" - sebuah KLAIM bahwa
        // tidak ada potensi penghematan. Terukur di peramban: armada tanpa
        // satu pun unit terhitung menampilkan "Rp 0 juta" padahal
        // `monthlyCostSavings === null`. Angka Rupiah paling mungkin dibawa
        // ke rapat, jadi ia WAJIB tertahan saat tak terukur.
        value: (kpi.monthlyCostSavings == null)
          ? '\u2014'
          : 'Rp ' + Math.round(kpi.monthlyCostSavings / 1e6).toLocaleString('id-ID'),
        unit: (kpi.monthlyCostSavings == null) ? '' : 'juta',
        sub: '@ Rp ' + (fuelPrice / 1000).toFixed(0) + 'K/liter × ' + fmt(kpi.fleetWastedLitersPerMonth, 0) + ' L',
        accent: '#22c55e'
      }
    ];

    host.innerHTML = cards.map(function (c) {
      return '<div class="vhms-intel-kpi-card" style="--kpi-accent:' + c.accent + '">' +
        '<div class="vhms-intel-kpi-icon"><i class="fa-solid ' + c.icon + '" style="color:' + c.color + '"></i></div>' +
        '<div class="vhms-intel-kpi-body">' +
          '<div class="vhms-intel-kpi-label">' + esc(c.label) + '</div>' +
          '<div class="vhms-intel-kpi-value" style="color:' + c.accent + '">' +
            esc(String(c.value)) + ' <small>' + esc(c.unit) + '</small>' +
          '</div>' +
          '<div class="vhms-intel-kpi-sub">' + esc(c.sub) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    showEl(bar);
  }

  /* -----------------------------------------------------------------------
   * Render Scatter Chart (Chart.js)
   * --------------------------------------------------------------------- */
  var QUAD_COLORS = { Q1: '#ef4444', Q2: '#f59e0b', Q3: '#22c55e', Q4: '#38bdf8' };
  var QUAD_LABELS = {
    Q1: 'Q1 — Critical (Blowby↑ + Fuel↑)',
    Q2: 'Q2 — Operasional/Rute (Blowby normal, Fuel↑)',
    Q3: 'Q3 — Benchmark Sehat',
    Q4: 'Q4 — Keausan Awal (Blowby↑, Fuel masih oke)'
  };

  function renderScatterChart(units, baseline, options) {
    var canvas = $id('vhms-intel-scatter-canvas');
    if (!canvas || typeof Chart === 'undefined') return;

    // Hancurkan chart lama
    if (_scatterChart) {
      _scatterChart.destroy();
      _scatterChart = null;
    }

    // Kelompokkan per kuadran
    var datasets = {};
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(function (q) {
      datasets[q] = {
        label: QUAD_LABELS[q],
        data: [],
        backgroundColor: QUAD_COLORS[q] + 'cc',
        borderColor: QUAD_COLORS[q],
        pointRadius: 7,
        pointHoverRadius: 10
      };
    });

    var unitMap = {};
    (units || []).forEach(function (u) {
      var qid = (u.quadrant && u.quadrant.id) || 'Q3';
      var x = u.medianBlowby;
      var y = u.medianLgt;
      if (x == null || y == null) return;
      var pt = {
        x: x,
        y: y,
        _unit: u.unit,
        _vhmsUnitId: u.vhmsUnitId || null,
        _priority: u.priority,
        _penalty: u.penalty,
        _lgtEnv: u.medianLgtEnv
      };
      datasets[qid].data.push(pt);
      unitMap[u.unit] = u;
    });

    var dsArr = ['Q1', 'Q2', 'Q3', 'Q4'].map(function (q) { return datasets[q]; });

    // Garis threshold
    var bbThreshold = (options && options.blowbyThreshold) || 3.2;
    var lgtThreshold = baseline ? (baseline.baseLgt * 1.10) : 0.0486;

    _scatterChart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: dsArr },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 12 }
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var pt = ctx.raw;
                var lines = [
                  'Unit: ' + (pt._unit || '?'),
                  'Blowby: ' + (pt.x != null ? pt.x.toFixed(2) + ' kPa' : '—'),
                  'L/GTKM: ' + (pt.y != null ? pt.y.toFixed(4) : '—'),
                  'Prioritas: ' + (pt._priority || '—')
                ];
                if (pt._lgtEnv != null && Math.abs(pt._lgtEnv - pt.y) > 0.0001) {
                  lines.push('L/GTKM Norm (EAB): ' + pt._lgtEnv.toFixed(4));
                }
                if (pt._penalty && pt._penalty.deltaLgtPct != null) {
                  lines.push('Penalti: ' + (pt._penalty.deltaLgtPct >= 0 ? '+' : '') + pt._penalty.deltaLgtPct.toFixed(1) + '%');
                }
                return lines;
              }
            },
            bodyColor: '#f8fafc',
            titleColor: '#38bdf8',
            backgroundColor: '#1e293bee',
            borderColor: '#334155',
            borderWidth: 1
          },
          annotation: undefined
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Blowby Max (kPa)',
              color: '#94a3b8',
              font: { size: 11 }
            },
            grid: { color: '#1e293b' },
            ticks: { color: '#64748b', font: { size: 10 } }
          },
          y: {
            title: {
              display: true,
              text: 'L / GTKM',
              color: '#94a3b8',
              font: { size: 11 }
            },
            grid: { color: '#1e293b' },
            ticks: { color: '#64748b', font: { size: 10 } }
          }
        },
        onClick: function (evt, elements) {
          if (!elements || !elements.length) return;
          var el = elements[0];
          var pt = dsArr[el.datasetIndex].data[el.index];
          if (pt && pt._unit) {
            // Cari unit lengkap
            var fullUnit = null;
            (units || []).forEach(function (u) {
              if (u.unit === pt._unit) fullUnit = u;
            });
            if (fullUnit && openVhmsUnit(fullUnit)) return;
            if (fullUnit && fullUnit.fmReport) openFmModal(fullUnit.fmReport);
          }
        }
      }
    });

    // Render legenda kuadran
    var legHost = $id('vhms-intel-quadrant-legend');
    if (legHost) {
      legHost.innerHTML = ['Q1', 'Q2', 'Q3', 'Q4'].map(function (q) {
        var cnt = datasets[q].data.length;
        return '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;' +
          'background:' + QUAD_COLORS[q] + '22;border:1px solid ' + QUAD_COLORS[q] + '55;' +
          'border-radius:4px;color:' + QUAD_COLORS[q] + '">' +
          '<i class="fa-solid fa-circle" style="font-size:8px"></i>' +
          '<strong>' + q + '</strong>&nbsp;(' + cnt + ')' +
          '</span>';
      }).join('');
    }

    // Badge korelasi (dukung R2 mentah & R2 EAB)
    var badge = $id('vhms-intel-corr-badge');
    if (badge && options) {
      var r2Raw = options.corrR2 != null ? (options.corrR2 * 100).toFixed(1) : null;
      var r2Env = options.corrR2Env != null ? (options.corrR2Env * 100).toFixed(1) : null;
      if (r2Env != null && r2Raw != null && Math.abs(options.corrR2Env - options.corrR2) > 0.001) {
        badge.innerHTML = 'Korelasi EAB &nbsp;<strong style="color:#22c55e">R² = ' + r2Env + '%</strong>' +
          ' <small style="color:#64748b;margin-left:4px">(Mentah: ' + r2Raw + '%)</small>';
      } else if (r2Raw != null) {
        badge.innerHTML = 'Korelasi Blowby↔L/GTKM &nbsp;<strong style="color:' +
          (options.corrR2 > 0.5 ? '#22c55e' : (options.corrR2 > 0.25 ? '#f59e0b' : '#94a3b8')) +
          '">R² = ' + r2Raw + '%</strong>';
      }
    }
  }

  /* -----------------------------------------------------------------------
   * State sort & filter tabel Intel Mesin
   * --------------------------------------------------------------------- */
  var _vhmsSort = { key: 'priority', dir: 1 };  // dir: 1=asc, -1=desc
  var _vhmsUnits = [];    // cache untuk re-sort tanpa analisis ulang

  /** Buka detail VHMS menggunakan ID Fleet yang stabil, lalu fokus ke chart mesin. */
  function openVhmsUnit(unit) {
    var app = global.VHMS_APP;
    if (!unit || !unit.vhmsUnitId || !app || typeof app.openUnit !== 'function') return false;
    app.openUnit(unit.vhmsUnitId);
    if (typeof app.switchTab === 'function') app.switchTab('engine');
    return true;
  }

  function _vhmsSortUnits(units, key, dir) {
    var order = { P1: 1, P2: 2, P3: 3 };
    return units.slice().sort(function (a, b) {
      var va, vb;
      if (key === 'priority') {
        va = order[a.priority] || 9; vb = order[b.priority] || 9;
      } else if (key === 'blowby') {
        va = a.medianBlowby != null ? a.medianBlowby : -Infinity;
        vb = b.medianBlowby != null ? b.medianBlowby : -Infinity;
      } else if (key === 'idle') {
        va = a.medianIdle != null ? a.medianIdle : -Infinity;
        vb = b.medianIdle != null ? b.medianIdle : -Infinity;
      } else if (key === 'pavg') {
        va = a.medianPavg != null ? a.medianPavg : -Infinity;
        vb = b.medianPavg != null ? b.medianPavg : -Infinity;
      } else if (key === 'grade') {
        va = a.medianGrade != null ? a.medianGrade : -Infinity;
        vb = b.medianGrade != null ? b.medianGrade : -Infinity;
      } else if (key === 'lgt') {
        va = a.medianLgt != null ? a.medianLgt : -Infinity;
        vb = b.medianLgt != null ? b.medianLgt : -Infinity;
      } else if (key === 'lgtEnv') {
        va = a.medianLgtEnv != null ? a.medianLgtEnv : -Infinity;
        vb = b.medianLgtEnv != null ? b.medianLgtEnv : -Infinity;
      } else if (key === 'delta' || key === 'deltaEnv') {
        var penA = a.penalty || {};
        var penB = b.penalty || {};
        va = penA.deltaLgtEnvPct != null ? penA.deltaLgtEnvPct : (penA.deltaLgtPct != null ? penA.deltaLgtPct : -Infinity);
        vb = penB.deltaLgtEnvPct != null ? penB.deltaLgtEnvPct : (penB.deltaLgtPct != null ? penB.deltaLgtPct : -Infinity);
      } else if (key === 'wasted') {
        va = (a.penalty && a.penalty.wastedLitersPerDay) ? a.penalty.wastedLitersPerDay : -Infinity;
        vb = (b.penalty && b.penalty.wastedLitersPerDay) ? b.penalty.wastedLitersPerDay : -Infinity;
      } else {
        va = String(a.unit || ''); vb = String(b.unit || '');
        return dir * va.localeCompare(vb);
      }
      return dir * (va < vb ? -1 : va > vb ? 1 : 0);
    });
  }

  function _vhmsArrow(key) {
    if (_vhmsSort.key !== key) return '<span class="sort-ind">⇅</span>';
    return '<span class="sort-ind">' + (_vhmsSort.dir === 1 ? '↑' : '↓') + '</span>';
  }

  function _bindVhmsSort(host, units, fleetResult) {
    if (!host) return;
    var ths = host.querySelectorAll('th[data-vhms-sort]');
    ths.forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-vhms-sort');
        if (_vhmsSort.key === k) { _vhmsSort.dir *= -1; }
        else { _vhmsSort.key = k; _vhmsSort.dir = 1; }
        _fillVhmsTable(host, _vhmsSortUnits(_vhmsUnits, _vhmsSort.key, _vhmsSort.dir), fleetResult);
        // Update indikator panah
        var allTh = host.querySelectorAll('th[data-vhms-sort]');
        allTh.forEach(function (t) {
          var ind = t.querySelector('.sort-ind');
          if (ind) {
            if (t.getAttribute('data-vhms-sort') === _vhmsSort.key) {
              ind.textContent = _vhmsSort.dir === 1 ? '↑' : '↓';
            } else {
              ind.textContent = '⇅';
            }
          }
        });
      });
    });
  }

  function _fillVhmsTable(host, sorted, fleetResult) {
    var PRIO_COLOR = { P1: '#ef4444', P2: '#f59e0b', P3: '#22c55e' };
    var tbody = host.querySelector('#vhms-priority-tbody');
    if (!tbody) return;
    fleetResult = fleetResult || _lastFleetResult;
    // [F3 2026-11-07, akar AUD-11] Fallback hafalan `|| 0.0442` DICABUT.
    // `baseLgt` kini bisa null (`fabricated:true` dari analitik) saat armada
    // tak punya >=5 sampel sehat. Tooltip di bawah WAJIB tahan null, kalau
    // tidak `.toFixed(4)` pada null akan melempar TypeError (terukur saat
    // menulis patch ini: sempat crash sebelum dijaga `isNumFn`).
    var isNumFn = function (v) { return typeof v === 'number' && isFinite(v); };
    var baseLgt = (fleetResult && fleetResult.baseline && isNumFn(fleetResult.baseline.baseLgt))
      ? fleetResult.baseline.baseLgt : null;
    var baseLgtEnv = (fleetResult && fleetResult.baseline && isNumFn(fleetResult.baseline.baseLgtEnv))
      ? fleetResult.baseline.baseLgtEnv : baseLgt;
    var baselineFabricated = !!(fleetResult && fleetResult.baseline && fleetResult.baseline.fabricated);
    var medFleetP = (fleetResult && fleetResult.eab && fleetResult.eab.fleetPayloadMedian) || null;

    var rows = sorted.map(function (u) {
      var pen = u.penalty || {};
      var quad = u.quadrant || {};
      var pColor = PRIO_COLOR[u.priority] || '#94a3b8';
      var bb = u.medianBlowby != null ? u.medianBlowby.toFixed(2) : '—';

      // EAB Faktor A: Idle Fraction (Koreksi Eksponensial Terkalibrasi [F4])
      var calib = (fleetResult && fleetResult.eab && fleetResult.eab.calibration) || {};
      var wIdleVal = (calib.wIdle && calib.wIdle.ok && isNumFn(calib.wIdle.value)) ? calib.wIdle.value : null;
      var cov = u.envCoverage || {};
      var idleStr = u.medianIdle != null ? (u.medianIdle * 100).toFixed(1) + '%' : '—';
      var idleTitle = u.medianIdle != null
        ? 'Idle: ' + (u.medianIdle * 100).toFixed(1) + '%\n' +
          (u.medianIcFactor != null && wIdleVal != null
            ? 'Faktor Koreksi: exp(-w × idle) = ' + u.medianIcFactor.toFixed(3) + ' (w terkalibrasi=' + wIdleVal.toFixed(3) +
              (isNumFn(cov.idleApplied) && isNumFn(cov.total) ? '; ' + cov.idleApplied + '/' + cov.total + ' jendela dikoreksi' : '') + ')'
            : 'Koreksi idle TIDAK diterapkan (kalibrasi tidak lolos gerbang)')
        : 'Tidak ada data idle';

      // EAB Faktor B: Muatan Rata-rata (Normalisasi Muatan Dicabut di F4)
      var pavgStr = u.medianPavg != null ? u.medianPavg.toFixed(1) + ' <small>t</small>' : '—';
      var pavgTitle = u.medianPavg != null
        ? 'Rata-rata Muatan: ' + u.medianPavg.toFixed(1) + ' ton' + (medFleetP ? ' (Median Armada: ' + medFleetP.toFixed(1) + ' t)' : '') +
          '\nNormalisasi Muatan: Dicabut di F4 (penyebut L/GTKM sudah memuat berat kosong + payload, tidak dikoreksi ganda)'
        : 'Tidak ada data muatan';

      // EAB Faktor C: Kemiringan Rute GPS (Koreksi Eksponensial Terkalibrasi [F4])
      var kRRVal = (calib.kRollingResist && calib.kRollingResist.ok && isNumFn(calib.kRollingResist.value)) ? calib.kRollingResist.value : null;
      // [F4 REVIEW 2026-11-10] Cakupan grade WAJIB terlihat. Pada data nyata
      // hanya 15,8 % jendela ber-GPS; median faktor dari SEMUA jendela akan
      // jatuh ke 1.000 dan menyesatkan ("koreksi mati"). Angka di sel tetap
      // median grade dari jendela ber-GPS; tooltip menyebut berapa dari berapa.
      var gradeN = isNumFn(cov.gradeApplied) ? cov.gradeApplied : null;
      var gradeStr = u.medianGrade != null
        ? u.medianGrade.toFixed(2) + '%' + (gradeN != null && isNumFn(cov.total) ? ' <small style="color:#64748b">' + gradeN + '/' + cov.total + '</small>' : '')
        : '—';
      var gradeTitle = u.medianGrade != null
        ? 'Kemiringan Rute GPS (median jendela ber-GPS): ' + u.medianGrade.toFixed(2) + '%\n' +
          (u.medianGradeFactor != null && kRRVal != null
            ? 'Faktor Koreksi Grade: exp(-kRR × g/100) = ' + u.medianGradeFactor.toFixed(3) + ' (kRR terkalibrasi=' + kRRVal.toFixed(2) + ')\n'
            : 'Koreksi grade TIDAK diterapkan pada unit ini\n') +
          (gradeN != null && isNumFn(cov.total)
            ? 'Cakupan: ' + gradeN + ' dari ' + cov.total + ' jendela dikoreksi grade; sisanya TIDAK dikoreksi (faktor 1,0). ' +
              'lGtEnv antar jendela berstatus koreksi berbeda tidak sebanding langsung.'
            : '')
        : 'Belum terpetakan ke data rute GPS';

      // L/GTKM Mentah
      var lgtRawVal = u.medianLgt != null ? u.medianLgt.toFixed(4) : '—';

      // L/GTKM EAB (Normalized)
      var lgtEnvVal = u.medianLgtEnv != null ? u.medianLgtEnv.toFixed(4) : lgtRawVal;
      var lgtDiff = (u.medianLgt != null && u.medianLgtEnv != null) ? (u.medianLgtEnv - u.medianLgt) : 0;
      var lgtTitle = 'lGt Mentah: ' + lgtRawVal + '\n-> Terkoreksi EAB: ' + lgtEnvVal + ' (' + (lgtDiff >= 0 ? '+' : '') + lgtDiff.toFixed(4) + ')';

      // Δ Penalti EAB vs Baseline EAB
      var deltaEnvVal = pen.deltaLgtEnvPct != null ? pen.deltaLgtEnvPct : pen.deltaLgtPct;
      var deltaEnvStr = deltaEnvVal != null ? (deltaEnvVal >= 0 ? '+' : '') + deltaEnvVal.toFixed(1) + '%' : '—';
      var deltaEnvColor = deltaEnvVal != null ? (deltaEnvVal > 15 ? '#f87171' : (deltaEnvVal > 5 ? '#f59e0b' : '#34d399')) : 'inherit';
      // [F3 2026-11-07] `baseLgt`/`baseLgtEnv` dijaga null sebelum `.toFixed`.
      // Baseline tak terukur (`baselineFabricated`) tampil jujur di tooltip,
      // bukan diam-diam menampilkan angka hafalan sebagai acuan.
      var deltaTitle = baselineFabricated
        ? 'Δ EAB: ' + deltaEnvStr + ' \u2014 baseline armada belum terukur (sampel sehat < 5)'
        : 'Δ EAB: ' + deltaEnvStr + ' vs Baseline EAB (' + (isNumFn(baseLgtEnv) ? baseLgtEnv.toFixed(4) : '\u2014') + ')' +
          (pen.deltaLgtPct != null ? '\nΔ Mentah: ' + (pen.deltaLgtPct >= 0 ? '+' : '') + pen.deltaLgtPct.toFixed(1) + '% vs Baseline Mentah (' + (isNumFn(baseLgt) ? baseLgt.toFixed(4) : '\u2014') + ')' : '');

      var wasted = pen.wastedLitersPerDay ? Math.round(pen.wastedLitersPerDay) + ' L/hari' : '—';
      var quadBadge = quad.id
        ? '<span class="badge" style="background:' +
          (QUAD_COLORS[quad.id] || '#334155') + '33;color:' + (QUAD_COLORS[quad.id] || '#94a3b8') +
          ';border:1px solid ' + (QUAD_COLORS[quad.id] || '#334155') + '55">' + quad.id + '</span>'
        : '';
      var prioBadge = '<span class="badge" style="background:' + pColor + '20;color:' + pColor +
        ';border:1px solid ' + pColor + '55;font-weight:700">' + esc(u.priority) + '</span>';
      var openBtn = (u.priority === 'P1' || u.priority === 'P2')
        ? '<button class="btn btn-ghost btn-sm" data-vhms-fm-unit="' + esc(u.unit) + '" type="button">' +
          '<i class="fa-solid fa-file-medical"></i> FM</button>'
        : '';

      return '<tr' + (u.vhmsUnitId ? ' class="vhms-intel-unit-row" data-vhms-unit-id="' + esc(u.vhmsUnitId) + '" title="Klik untuk membuka detail dan chart parameter VHMS"' : '') + '>' +
        '<td style="font-weight:600;white-space:nowrap">' + esc(u.unit) + '</td>' +
        '<td class="center">' + prioBadge + '</td>' +
        '<td class="fuel-num">' + bb + ' <small>kPa</small></td>' +
        '<td class="fuel-num" title="' + esc(idleTitle) + '">' + idleStr + '</td>' +
        '<td class="fuel-num" title="' + esc(pavgTitle) + '">' + pavgStr + '</td>' +
        '<td class="fuel-num" title="' + esc(gradeTitle) + '">' + gradeStr + '</td>' +
        '<td class="fuel-num">' + lgtRawVal + '</td>' +
        '<td class="fuel-num" style="font-weight:600;color:#38bdf8" title="' + esc(lgtTitle) + '">' + lgtEnvVal + '</td>' +
        '<td class="fuel-num" style="font-weight:600;color:' + deltaEnvColor + '" title="' + esc(deltaTitle) + '">' + deltaEnvStr + '</td>' +
        '<td class="fuel-num">' + esc(wasted) + '</td>' +
        '<td class="center">' + quadBadge + '</td>' +
        '<td class="center">' + openBtn + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = rows;

    // Baris Intel EAB membuka detail VHMS agar parameter dapat langsung diaudit.
    tbody.addEventListener('click', function (e) {
      if (e.target.closest('[data-vhms-fm-unit]')) return;
      var row = e.target.closest('[data-vhms-unit-id]');
      if (!row) return;
      var unitId = row.getAttribute('data-vhms-unit-id');
      var targetUnit = null;
      _vhmsUnits.forEach(function (u) { if (u.vhmsUnitId === unitId) targetUnit = u; });
      openVhmsUnit(targetUnit);
    });

    // Tombol FM tetap membuka laporan, tanpa juga membuka detail unit.
    var fmBtns = tbody.querySelectorAll('[data-vhms-fm-unit]');
    fmBtns.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var unitName = btn.getAttribute('data-vhms-fm-unit');
        var targetUnit = null;
        _vhmsUnits.forEach(function (u) { if (u.unit === unitName) targetUnit = u; });
        if (targetUnit && targetUnit.fmReport) openFmModal(targetUnit.fmReport);
      });
    });
  }

  /* -----------------------------------------------------------------------
   * Render Tabel Prioritas Intervensi
   * --------------------------------------------------------------------- */
  function renderPriorityTable(units, fleetResult) {
    var host = $id('vhms-intel-priority-table');
    if (!host) return;

    if (!units || !units.length) {
      host.innerHTML = '<p style="color:#64748b;font-size:12px;padding:8px 0">Tidak ada unit yang dapat dievaluasi.</p>';
      return;
    }

    _vhmsUnits = units;
    var sorted = _vhmsSortUnits(units, _vhmsSort.key, _vhmsSort.dir);

    var calib = (fleetResult && fleetResult.eab && fleetResult.eab.calibration) || {};
    var wIdleDesc = (calib.wIdle && calib.wIdle.ok && isNum(calib.wIdle.value))
      ? 'Idle (w=' + calib.wIdle.value.toFixed(3) + ')'
      : 'Idle (tidak dikoreksi)';
    var kRRDesc = (calib.kRollingResist && calib.kRollingResist.ok && isNum(calib.kRollingResist.value))
      ? 'Grade GPS (kRR=' + calib.kRollingResist.value.toFixed(1) + ')'
      : 'Grade GPS (belum aktif)';
    var eabSubtitle = units.length + ' unit teranalisis · Kalibrasi EAB: ' + wIdleDesc + ' | Muatan: Netral (koreksi ganda dicabut) | ' + kRRDesc;

    host.innerHTML =
      '<div class="table-toolbar" style="margin-bottom:8px">' +
        '<div>' +
          '<h4 class="panel-title" style="font-size:13px;margin:0">' +
            '<i class="fa-solid fa-list-ol" style="color:#f59e0b"></i> Prioritas Intervensi Bengkel (Data Formulasi EAB)' +
          '</h4>' +
          '<p class="panel-sub" style="margin:2px 0 0 0">' +
            esc(eabSubtitle) +
          '</p>' +
        '</div>' +
        '<div class="fuel-filter-bar" style="margin-top:0">' +
          '<label class="fuel-filter">' +
            '<i class="fa-solid fa-magnifying-glass"></i>' +
            '<input type="search" id="vhms-priority-search" placeholder="Cari unit…" autocomplete="off">' +
          '</label>' +
          '<label class="fuel-filter">' +
            '<select id="vhms-priority-filter-prio">' +
              '<option value="">Semua Prioritas</option>' +
              '<option value="P1">P1 Critical</option>' +
              '<option value="P2">P2 Warning</option>' +
              '<option value="P3">P3 Normal</option>' +
            '</select>' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="table-scroll">' +
        '<table class="data" id="vhms-priority-table-inner">' +
          '<thead><tr>' +
            '<th class="sortable" data-vhms-sort="unit" style="text-align:left">Unit <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable center" data-vhms-sort="priority" style="text-align:center">Prioritas ' + _vhmsArrow('priority') + '</th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="blowby" style="text-align:right">Blowby <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="idle" style="text-align:right" title="Faktor A: Idle fraction jendela evaluasi (koreksi eksponensial exp(-w·idle))">Idle % <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="pavg" style="text-align:right" title="Rata-rata muatan per siklus (ton) — L/GTKM sudah memperhitungkan berat kosong + payload">Muatan <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="grade" style="text-align:right" title="Faktor B: Kemiringan rute GPS (%) via penugasan rute armada (koreksi exp(-kRR·g/100))">Grade GPS <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="lgt" style="text-align:right" title="Konsumsi aktual sebelum koreksi lingkungan (L/GTKM)">L/GTKM Mentah <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="lgtEnv" style="text-align:right" title="Konsumsi bersih setelah normalisasi lingkungan EAB (L/GTKM)">lGt Norm (EAB) <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="deltaEnv" style="text-align:right" title="Deviasi penalti terhadap baseline bersih EAB armada">Δ Penalti EAB <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-vhms-sort="wasted" style="text-align:right">Solar Terbuang <span class="sort-ind">⇅</span></th>' +
            '<th class="center" style="text-align:center">Kuadran</th>' +
            '<th class="center" style="text-align:center">Laporan</th>' +
          '</tr></thead>' +
          '<tbody id="vhms-priority-tbody"></tbody>' +
        '</table>' +
      '</div>';

    _fillVhmsTable(host, sorted, fleetResult);
    _bindVhmsSort(host, units, fleetResult);

    // Filter search & prioritas
    function applyVhmsFilter() {
      var q = ($id('vhms-priority-search') || {}).value || '';
      var pFilter = ($id('vhms-priority-filter-prio') || {}).value || '';
      var filtered = _vhmsUnits.filter(function (u) {
        var matchQ = !q || (u.unit || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
        var matchP = !pFilter || u.priority === pFilter;
        return matchQ && matchP;
      });
      _fillVhmsTable(host, _vhmsSortUnits(filtered, _vhmsSort.key, _vhmsSort.dir), fleetResult);
    }
    var srch = $id('vhms-priority-search');
    if (srch) srch.addEventListener('input', applyVhmsFilter);
    var pSel = $id('vhms-priority-filter-prio');
    if (pSel) pSel.addEventListener('change', applyVhmsFilter);
  }

  /* -----------------------------------------------------------------------
   * Indikator Status EAB (Environment-Adjusted Baseline)
   * --------------------------------------------------------------------- */
  function updateEabStatusIndicator(fleetResult) {
    var el = $id('vhms-intel-eab-status');
    if (!el) return;
    if (!fleetResult || !fleetResult.eab || !fleetResult.eab.active) {
      el.innerHTML = '<i class="fa-solid fa-sliders" style="color:#64748b"></i> <strong>EAB:</strong> Nonaktif';
      el.title = 'Normalisasi faktor lingkungan belum aktif';
      return;
    }
    var st = (fleetResult.baseline && fleetResult.baseline.eabStatus) || {};
    var calib = fleetResult.eab.calibration || {};
    var cov = fleetResult.eab.coverage || {};

    var idleOk = calib.wIdle && calib.wIdle.ok && isNum(calib.wIdle.value);
    var idleText = idleOk
      ? '<span style="color:#22c55e">Idle ✓ (' + calib.wIdle.value.toFixed(2) + ')</span>'
      : (st.idleActive ? '<span style="color:#22c55e">Idle ✓</span>' : '<span style="color:#64748b">Idle —</span>');

    var payloadText = '<span style="color:#94a3b8" title="Normalisasi muatan dinonaktifkan di F4 (koreksi ganda)">Muatan ⊘</span>';

    var gradeOk = calib.kRollingResist && calib.kRollingResist.ok && isNum(calib.kRollingResist.value);
    var gradeText = gradeOk
      ? '<span style="color:#22c55e">Grade ✓ (' + calib.kRollingResist.value.toFixed(1) + ')</span>'
      : (st.gradeActive
        ? '<span style="color:#22c55e">Grade ✓</span>'
        : (st.gpsLoaded ? '<span style="color:#f59e0b">Grade (0 rute)</span>' : '<span style="color:#64748b">Grade — (GPS belum diunggah)</span>'));

    el.innerHTML = '<i class="fa-solid fa-sliders" style="color:#38bdf8"></i> <strong>EAB:</strong> ' +
      idleText + ' | ' + payloadText + ' | ' + gradeText;

    var title = 'Status Environment-Adjusted Baseline (EAB — Kalibrasi Dinamis):\n';
    title += '• Koreksi Idle: ' + (idleOk
      ? 'Aktif — terkalibrasi w=' + calib.wIdle.value.toFixed(3) + ' (formula exp(-w·idle), ' + (cov.idleApplied || 0) + ' jendela)'
      : (st.idleActive ? 'Aktif' : 'Tidak ada data idle')) + '\n';
    title += '• Normalisasi Muatan: Dicabut di F4 (formula L/GTKM sudah memuat berat kosong + payload di penyebutnya)\n';
    title += '• Koreksi Tanjakan GPS: ' + (gradeOk
      ? 'Aktif via GPS — terkalibrasi kRR=' + calib.kRollingResist.value.toFixed(2) + ' (formula exp(-kRR·g/100), ' + (cov.gradeApplied || 0) + ' jendela terkoreksi)'
      : (st.gradeActive ? 'Aktif' : (st.gpsLoaded ? 'GPS aktif namun penugasan rute kosong' : 'GPS belum diunggah (fallback normal)'))) + '\n';
    if (fleetResult.eab.totalExcluded > 0) {
      title += '• Outlier baseline: ' + fleetResult.eab.totalExcluded + ' jendela dikecualikan dari baseline.\n';
    }
    // r2Raw dapat null walau r2Env ada (atau sebaliknya) — jangan kalikan null.
    if (fleetResult.eab.r2Env != null) {
      title += '• Korelasi R² EAB: ' + (fleetResult.eab.r2Env * 100).toFixed(1) + '%' +
        (fleetResult.eab.r2Raw != null
          ? ' (Mentah: ' + (fleetResult.eab.r2Raw * 100).toFixed(1) + '%)'
          : '');
      if (fleetResult.eab.corrEnvGroup) {
        title += ' [' + fleetResult.eab.corrEnvGroup + ', n=' + (fleetResult.eab.corrEnvGroupN || 0) + ']';
      }
    } else {
      title += '• Korelasi R² EAB: tak terdefinisi (varians blowby nol / sampel kurang)';
    }
    el.title = title;
  }

  /* -----------------------------------------------------------------------
   * State sort tabel Bin Analisis
   * --------------------------------------------------------------------- */
  var _binSort = { key: 'none', dir: 1 };
  var _binData  = [];

  function _vhmsBinArrow(key) {
    if (_binSort.key !== key) return '<span class="sort-ind">⇅</span>';
    return '<span class="sort-ind">' + (_binSort.dir === 1 ? '↑' : '↓') + '</span>';
  }

  function _fillBinTable(host, bins) {
    var tbody = host.querySelector('#vhms-bin-tbody');
    if (!tbody) return;
    var rows = bins.map(function (b) {
      var deltaColor = b.deltaLgtPct != null
        ? (b.deltaLgtPct > 15 ? '#f87171' : (b.deltaLgtPct > 5 ? '#f59e0b' : '#34d399'))
        : 'inherit';
      var deltaStr = b.deltaLgtPct != null
        ? (b.deltaLgtPct >= 0 ? '+' : '') + b.deltaLgtPct.toFixed(1) + '%' : '—';

      var deltaEnvColor = b.deltaLgtEnvPct != null
        ? (b.deltaLgtEnvPct > 15 ? '#f87171' : (b.deltaLgtEnvPct > 5 ? '#f59e0b' : '#34d399'))
        : deltaColor;
      var deltaEnvStr = b.deltaLgtEnvPct != null
        ? (b.deltaLgtEnvPct >= 0 ? '+' : '') + b.deltaLgtEnvPct.toFixed(1) + '%' : deltaStr;

      var nCountStr = String(b.n || 0);
      if (b.nExcluded > 0) {
        nCountStr += ' <small style="color:#64748b" title="' + b.nExcluded + ' jendela outlier idle/cov dikeluarkan dari baseline">(-' + b.nExcluded + ')</small>';
      }

      return '<tr>' +
        '<td>' + esc(b.label) + '</td>' +
        '<td class="fuel-num">' + nCountStr + '</td>' +
        '<td class="fuel-num">' + (b.medLgt != null ? b.medLgt.toFixed(4) : '—') + '</td>' +
        '<td class="fuel-num" style="font-weight:600;color:#38bdf8">' + (b.medLgtEnv != null ? b.medLgtEnv.toFixed(4) : '—') + '</td>' +
        '<td class="fuel-num" style="color:' + deltaEnvColor + '">' + deltaEnvStr + '</td>' +
        '<td class="fuel-num">' + (b.medFr != null ? b.medFr.toFixed(1) + ' <small>L/h</small>' : '—') + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = rows;
  }

  /* -----------------------------------------------------------------------
   * Render Tabel Bin Analisis
   * --------------------------------------------------------------------- */
  function renderBinTable(bins) {
    var host = $id('vhms-intel-bin-table');
    var panel = $id('vhms-intel-bin-panel');
    if (!host || !bins || !bins.length) return;

    _binData = bins;

    host.innerHTML =
      '<div class="table-toolbar" style="margin-bottom:8px">' +
        '<div>' +
          '<h4 class="panel-title" style="font-size:13px;margin:0">' +
            '<i class="fa-solid fa-chart-bar" style="color:#a78bfa"></i> Analisis Kelompok Degradasi Blow-by (EAB)' +
          '</h4>' +
          '<p class="panel-sub" style="margin:2px 0 0 0">' +
            bins.length + ' kelompok · Normalisasi idle, payload & grade · Klik header untuk mengurutkan' +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div class="table-scroll">' +
        '<table class="data" id="vhms-bin-table-inner">' +
          '<thead><tr>' +
            '<th class="sortable" data-bin-sort="label" style="text-align:left">Kelompok Degradasi <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-bin-sort="n" style="text-align:right">N ' + _vhmsBinArrow('n') + '</th>' +
            '<th class="sortable fuel-num right" data-bin-sort="medLgt" style="text-align:right">Median L/GTKM (Mentah) <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-bin-sort="medLgtEnv" style="text-align:right">Median lGt (norm EAB) <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-bin-sort="deltaEnv" style="text-align:right">Δ vs Baseline EAB <span class="sort-ind">⇅</span></th>' +
            '<th class="sortable fuel-num right" data-bin-sort="medFr" style="text-align:right">Median L/jam <span class="sort-ind">⇅</span></th>' +
          '</tr></thead>' +
          '<tbody id="vhms-bin-tbody"></tbody>' +
        '</table>' +
      '</div>';

    _fillBinTable(host, bins);

    // Bind sort
    var ths = host.querySelectorAll('th[data-bin-sort]');
    ths.forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-bin-sort');
        if (_binSort.key === k) { _binSort.dir *= -1; }
        else { _binSort.key = k; _binSort.dir = 1; }
        var sorted = _binData.slice().sort(function (a, b) {
          var va, vb;
          if (k === 'n') { va = a.n || 0; vb = b.n || 0; }
          else if (k === 'medLgt') { va = a.medLgt != null ? a.medLgt : -Infinity; vb = b.medLgt != null ? b.medLgt : -Infinity; }
          else if (k === 'medLgtEnv') { va = a.medLgtEnv != null ? a.medLgtEnv : -Infinity; vb = b.medLgtEnv != null ? b.medLgtEnv : -Infinity; }
          else if (k === 'delta' || k === 'deltaEnv') {
            va = a.deltaLgtEnvPct != null ? a.deltaLgtEnvPct : (a.deltaLgtPct != null ? a.deltaLgtPct : -Infinity);
            vb = b.deltaLgtEnvPct != null ? b.deltaLgtEnvPct : (b.deltaLgtPct != null ? b.deltaLgtPct : -Infinity);
          }
          else if (k === 'medFr') { va = a.medFr != null ? a.medFr : -Infinity; vb = b.medFr != null ? b.medFr : -Infinity; }
          else { return _binSort.dir * String(a.label || '').localeCompare(String(b.label || '')); }
          return _binSort.dir * (va < vb ? -1 : va > vb ? 1 : 0);
        });
        _fillBinTable(host, sorted);
        ths.forEach(function (t) {
          var ind = t.querySelector('.sort-ind');
          if (ind) ind.textContent = t.getAttribute('data-bin-sort') === k ? (_binSort.dir === 1 ? '↑' : '↓') : '⇅';
        });
      });
    });

    showEl(panel);
  }

  /* -----------------------------------------------------------------------
   * Modal Failure Mode Report
   * --------------------------------------------------------------------- */
  function openFmModal(report) {
    var modal = $id('vhms-intel-fm-modal');
    var content = $id('vhms-intel-fm-content');
    if (!modal || !content) return;

    var FVA = global.FUEL_VHMS_ANALYTICS;
    if (!FVA) return;

    content.innerHTML = FVA.formatReportHtml(report);
    showEl(modal, 'flex');

    // Tombol salin
    var copyBtn = $id('btn-vhms-fm-copy');
    if (copyBtn) {
      copyBtn._fmReport = report;
    }
  }

  function closeFmModal() {
    var modal = $id('vhms-intel-fm-modal');
    if (modal) hideEl(modal);
  }

  /* -----------------------------------------------------------------------
   * Eksekusi Analisis Utama
   * --------------------------------------------------------------------- */
  function runAnalysis() {
    var FVA = global.FUEL_VHMS_ANALYTICS;
    if (!FVA) {
      showToast('Modul FUEL_VHMS_ANALYTICS belum dimuat.', 'error');
      return;
    }

    var bbThreshold = parseFloat(($id('vhms-intel-blowby-threshold') || {}).value) || 3.2;
    var penaltyPct = parseFloat(($id('vhms-intel-penalty-pct') || {}).value) || 10.0;
    var compartment = ($id('vhms-intel-compartment') || {}).value || 'ENGINE';
    var dateStart = ($id('vhms-intel-date-start') || {}).value || null;
    var dateEnd = ($id('vhms-intel-date-end') || {}).value || null;
    var smrMin = parseFloat(($id('vhms-intel-smr-min') || {}).value);
    var smrMax = parseFloat(($id('vhms-intel-smr-max') || {}).value);

    // Sembunyikan konten lama
    hideEl($id('vhms-intel-empty'));
    hideEl($id('vhms-intel-kpi-bar'));
    var mainContent = $id('vhms-intel-main-content');
    if (mainContent) mainContent.style.display = 'none';
    hideEl($id('vhms-intel-bin-panel'));

    var runBtn = $id('btn-vhms-intel-run');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menganalisis...';
    }

    // Pastikan data GPS Route dan Fuel Store ter-load / ter-hydrate terlebih dahulu
    var ensureGps = Promise.resolve();
    if (global.GPS_ROUTE_STORE && typeof global.GPS_ROUTE_STORE.isLoaded === 'function' && !global.GPS_ROUTE_STORE.isLoaded()) {
      if (typeof location === 'undefined' || location.protocol !== 'file:') {
        ensureGps = global.GPS_ROUTE_STORE.loadData().catch(function () { return null; });
      }
    }

    var ensureFuel = Promise.resolve();
    if (global.FUEL_STORE && typeof global.FUEL_STORE.isHydrated === 'function' && !global.FUEL_STORE.isHydrated()) {
      ensureFuel = global.FUEL_STORE.hydrate().catch(function () { return null; });
    }

    // Jalankan secara async agar UI tidak freeze
    Promise.all([ensureGps, ensureFuel]).then(function () {
      setTimeout(function () {
        try {
          var fleetResult = FVA.analyzeFleetEngineFuel(null, {
            compartment: compartment,
            dateStart: dateStart,
            dateEnd: dateEnd,
            smrMin: isFinite(smrMin) ? smrMin : null,
            smrMax: isFinite(smrMax) ? smrMax : null,
            blowbyThreshold: bbThreshold,
            penaltyWarnPct: penaltyPct,
            penaltyCritPct: penaltyPct * 1.5
          });

          _lastFleetResult = fleetResult;

          if (!fleetResult || !fleetResult.kpi || fleetResult.kpi.totalUnits === 0) {
            showEl($id('vhms-intel-empty'));
            showToast('Tidak ada data yang dapat dianalisis pada filter yang dipilih.', 'warn');
            return;
          }

          // Render KPI
          renderKpiCards(fleetResult.kpi, fleetResult.baseline);

          // Render Scatter
          renderScatterChart(fleetResult.units, fleetResult.baseline, {
            blowbyThreshold: bbThreshold,
            corrR2: fleetResult.kpi.correlationR2,
            corrR2Env: fleetResult.kpi.correlationR2Env
          });

          // Update status EAB pada toolbar
          updateEabStatusIndicator(fleetResult);

          // Render Tabel Prioritas
          renderPriorityTable(fleetResult.units, fleetResult);

          // Render Bin
          renderBinTable(fleetResult.bins);

          // Tampilkan konten utama (flex column seragam)
          if (mainContent) {
            mainContent.style.display = 'flex';
            mainContent.style.flexDirection = 'column';
          }

          showToast(
            'Analisis selesai: ' + fleetResult.kpi.totalUnits + ' unit, ' +
            fleetResult.kpi.highPenaltyCount + ' unit P1 terdeteksi.',
            'ok'
          );
        } catch (err) {
          console.error('[fuel-vhms-app] Analisis gagal:', err);
          showEl($id('vhms-intel-empty'));
          showToast('Terjadi kesalahan saat analisis: ' + err.message, 'error');
        } finally {
          if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Eksekusi';
          }
        }
      }, 40);
    });
  }

  /* -----------------------------------------------------------------------
   * Toast notifikasi ringan
   * --------------------------------------------------------------------- */
  function showToast(msg, type) {
    if (global.UI_UTIL && typeof global.UI_UTIL.toast === 'function') {
      global.UI_UTIL.toast(msg);
      return;
    }
    // Fallback sederhana
    var color = { ok: '#22c55e', warn: '#f59e0b', error: '#ef4444' }[type] || '#38bdf8';
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;' +
      'background:#1e293b;border-left:4px solid ' + color + ';color:#f8fafc;' +
      'padding:10px 16px;border-radius:6px;font-size:13px;box-shadow:0 4px 20px #0008;' +
      'max-width:380px;line-height:1.4';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  /* -----------------------------------------------------------------------
   * Inisialisasi semua event listener
   * --------------------------------------------------------------------- */
  function init() {
    // Switch sub-tab
    initSubTabSwitcher();

    // Auto-load data GPS Route di background jika diakses lewat HTTP
    if (global.GPS_ROUTE_STORE && typeof global.GPS_ROUTE_STORE.isLoaded === 'function' && !global.GPS_ROUTE_STORE.isLoaded()) {
      if (typeof location === 'undefined' || location.protocol !== 'file:') {
        global.GPS_ROUTE_STORE.loadData().catch(function () { /* abaikan jika gagal, graceful fallback */ });
      }
    }

    // Tombol Eksekusi
    var runBtn = $id('btn-vhms-intel-run');
    if (runBtn) {
      runBtn.addEventListener('click', runAnalysis);
    }

    // Tutup modal FM
    var closeBtn = $id('btn-vhms-fm-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeFmModal);
    }

    // Klik backdrop modal
    var modal = $id('vhms-intel-fm-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeFmModal();
      });
    }

    // Tombol salin teks laporan
    var copyBtn = $id('btn-vhms-fm-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var FVA = global.FUEL_VHMS_ANALYTICS;
        if (!FVA || !copyBtn._fmReport) return;
        var text = FVA.formatReportText(copyBtn._fmReport);
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            showToast('Teks laporan berhasil disalin ke clipboard.', 'ok');
          });
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          showToast('Teks laporan berhasil disalin.', 'ok');
        }
      });
    }

    // Tombol ekspor CSV FM Report
    var fmCsvBtn = $id('btn-vhms-fm-csv');
    if (fmCsvBtn) {
      fmCsvBtn.addEventListener('click', function () {
        var copyBtn = $id('btn-vhms-fm-copy');
        var report = copyBtn ? copyBtn._fmReport : null;
        var FVA = global.FUEL_VHMS_ANALYTICS;
        if (!FVA || !report) {
          showToast('Laporan tidak ditemukan.', 'warn');
          return;
        }
        var csv = FVA.exportFmReportCsv(report);
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (report.caseId || 'FM-REPORT') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Ekspor CSV FM Report selesai.', 'ok');
      });
    }

    // Tombol cetak PDF FM Report
    var fmPrintBtn = $id('btn-vhms-fm-print');
    if (fmPrintBtn) {
      fmPrintBtn.addEventListener('click', function () {
        var modal = $id('vhms-intel-fm-modal');
        var content = $id('vhms-intel-fm-content');
        if (!content) return;
        var printWin = window.open('', '_blank');
        if (!printWin) {
          window.print();
          return;
        }
        printWin.document.write('<!DOCTYPE html><html><head><title>Reliability & Fuel Impact Report</title>');
        printWin.document.write('<style>body { font-family: system-ui, -apple-system, sans-serif; background: #fff; color: #0f172a; padding: 20px; } .fm-report-card { background: #fff !important; color: #0f172a !important; border: 1px solid #cbd5e1 !important; } .fm-report-card div, .fm-report-card p, .fm-report-card li { color: #0f172a !important; } .fm-report-card h2 { color: #0f172a !important; } @media print { @page { size: landscape; margin: 10mm; } }</style>');
        printWin.document.write('</head><body>');
        printWin.document.write(content.innerHTML);
        printWin.document.write('</body></html>');
        printWin.document.close();
        printWin.focus();
        setTimeout(function () {
          printWin.print();
          printWin.close();
        }, 400);
      });
    }

    // Tombol ekspor CSV seluruh armada
    var fleetCsvBtn = $id('btn-vhms-intel-export-csv');
    if (fleetCsvBtn) {
      fleetCsvBtn.addEventListener('click', function () {
        var FVA = global.FUEL_VHMS_ANALYTICS;
        if (!FVA || !_lastFleetResult || !_lastFleetResult.units || !_lastFleetResult.units.length) {
          showToast('Jalankan eksekusi analisis terlebih dahulu.', 'warn');
          return;
        }
        var csv = FVA.exportFleetCsv(_lastFleetResult.units, _lastFleetResult.baseline);
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'vhms-fuel-intelligence-fleet-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Ekspor CSV armada berhasil diunduh.', 'ok');
      });
    }

    // Tombol cetak PDF seluruh dashboard sub-tab
    var fleetPdfBtn = $id('btn-vhms-intel-export-pdf');
    if (fleetPdfBtn) {
      fleetPdfBtn.addEventListener('click', function () {
        if (!_lastFleetResult || !_lastFleetResult.units || !_lastFleetResult.units.length) {
          showToast('Jalankan eksekusi analisis terlebih dahulu.', 'warn');
          return;
        }
        window.print();
      });
    }
  }

  /* -----------------------------------------------------------------------
   * Bootstrap — tunggu DOM siap
   * --------------------------------------------------------------------- */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* -----------------------------------------------------------------------
   * Ekspor (opsional, untuk testing)
   * --------------------------------------------------------------------- */
  global.FUEL_VHMS_APP = {
    runAnalysis: runAnalysis,
    invalidateAnalysis: function () { _lastFleetResult = null; },
    renderKpiCards: renderKpiCards,
    renderPriorityTable: renderPriorityTable,
    renderBinTable: renderBinTable,
    openVhmsUnit: openVhmsUnit,
    openFmModal: openFmModal,
    closeFmModal: closeFmModal
  };

})(typeof window !== 'undefined' ? window : this);

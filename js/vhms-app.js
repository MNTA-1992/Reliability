/* =========================================================================
 * vhms-app.js
 * -------------------------------------------------------------------------
 * Controller utama: menangani pemuatan file (picker, drag & drop, contoh),
 * orkestrasi parse -> analitik -> render, navigasi tab, filter tabel,
 * ekspor CSV/laporan cetak, dan notifikasi.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  var parser = global.VHMS_PARSER;
  var analytics = global.VHMS_ANALYTICS;
  var render = global.VHMS_RENDER;
  var fleet = global.VHMS_FLEET;
  var ranking = global.VHMS_RANKING;

  var state = {
    current: null,        // hasil analyze() unit yang sedang dibuka
    currentUnitId: null,  // id unit yang sedang dibuka di tampilan detail
    fileName: null,
    activeTab: 'overview',
    view: 'fleet',        // 'fleet' | 'unit' | 'comparison'
    ranked: null          // cache hasil ranking
  };

  /* -----------------------------------------------------------------------
   * Notifikasi toast
   * ---------------------------------------------------------------------
   * Durasi tampil dibuat PROPORSIONAL terhadap panjang pesan, namun
   * dibatasi agar tidak bertahan terlalu lama di layar:
   *   - pesan pendek  -> ~2.5 detik
   *   - pesan panjang -> maksimum ~5 detik
   * Bila `ms` diberikan eksplisit, nilai itu yang dipakai (dibatasi maks 6s).
   */
  function toast(message, type, ms) {
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) { console[type === 'err' ? 'error' : 'log'](message); return; }
    var div = document.createElement('div');
    div.className = 'toast ' + (type || 'info');
    var icon = type === 'err' ? 'fa-circle-exclamation' : (type === 'ok' ? 'fa-circle-check' : 'fa-circle-info');
    div.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + render.esc(message) + '</span>';
    wrap.appendChild(div);

    // Hitung durasi tampil.
    var text = String(message || '');
    var dur;
    if (ms) {
      dur = Math.min(ms, 6000);                 // batasi maksimum 6 detik
    } else {
      // ~55ms per karakter + basis 2200ms, dibatasi 2500..5000ms
      dur = Math.max(2500, Math.min(5000, 2200 + text.length * 55));
      if (type === 'err') dur = Math.min(6000, dur + 800);  // error sedikit lebih lama
    }

    setTimeout(function () {
      div.style.transition = 'opacity .3s, transform .3s';
      div.style.opacity = '0';
      div.style.transform = 'translateX(30px)';
      setTimeout(function () { div.remove(); }, 320);
    }, dur);
  }

  function showLoading(text) {
    var ov = document.getElementById('loading');
    if (!ov) return;
    ov.querySelector('p').textContent = text || 'Memuat data...';
    ov.classList.remove('hidden');
  }

  function hideLoading() {
    var ov = document.getElementById('loading');
    if (ov) ov.classList.add('hidden');
  }

  /* -----------------------------------------------------------------------
   * Inti: proses teks CSV -> dashboard
   * --------------------------------------------------------------------- */
  function processText(text, sourceName) {
    try {
      showLoading('Membaca & memvalidasi CSV...');

      // 1) Parse
      var parsed = parser.parse(text);
      if (!parsed.records.length) throw new Error('File tidak mengandung baris data.');

      // 2) Analitik
      showLoading('Menghitung analitik & mendeteksi anomali...');
      var analysis = analytics.analyze(parsed);
      analysis.sourceFile = sourceName || 'data.csv';

      // 3) Daftarkan ke fleet & buka unit ini (bisa merge bila SN sudah ada)
      var res = fleet.add(analysis, sourceName);
      openUnit(res.id);

      var nCrit = analysis.anomalies.filter(function (a) { return a.status === 'CRITICAL'; }).length;
      var msg;
      if (res.merged) {
        msg = 'Unit SN ' + (analysis.meta.serial || '—') + ' digabung (+' + res.addedRecords +
          ' record baru). Total ' + analysis.records.length + ' record.';
      } else {
        msg = 'Berhasil memuat ' + analysis.records.length + ' record dari "' + (sourceName || 'data.csv') + '".';
      }
      if (nCrit > 0) msg += ' ' + nCrit + ' anomali kritis terdeteksi.';
      var vRep = analysis.validationReport;
      if (vRep && (vRep.droppedInvalidSmr || vRep.droppedDuplicate)) {
        msg += ' Validasi: ' + global.VHMS_VALIDATE.summarizeReport(vRep) + '.';
      }
      toast(msg, (nCrit > 0 || (vRep && (vRep.droppedInvalidSmr || vRep.droppedDuplicate))) ? 'err' : 'ok');

      hideLoading();
      return true;
    } catch (err) {
      hideLoading();
      console.error(err);
      toast('Gagal memuat: ' + err.message, 'err');
      return false;
    }
  }

  /* -----------------------------------------------------------------------
   * Buka satu unit di tampilan detail
   * --------------------------------------------------------------------- */
  function openUnit(id) {
    var analysis = fleet.getAnalysis(id);
    if (!analysis) { toast('Unit tidak ditemukan.', 'err'); return; }

    state.currentUnitId = id;
    state.current = analysis;
    state.fileName = analysis.sourceFile || id;
    state.view = 'unit';

    render.renderAll(analysis);
    showUnitView();
  }

  function showUnitView() {
    toggle('fleet-area', false);
    toggle('comparison-area', false);
    toggle('cross-area', false);
    // [ISOLASI VIEW] Sembunyikan halaman Portofolio saat membuka detail unit.
    toggle('portfolio-area', false);
    setHeaderCompact(false);
    document.getElementById('dashboard-area').classList.remove('hidden');
    document.getElementById('welcome-area').classList.add('hidden');
    setBannerVisible(true);
    // Aktifkan tab default saat membuka unit
    switchTab('overview');
  }

  /**
   * [GUARD PORTOFOLIO] Apakah halaman PORTOFOLIO sedang terbuka?
   * Bila ya, fungsi-fungsi navigasi VHMS TIDAK boleh menampilkan/menyembunyikan
   * area VHMS, agar tidak menimpa tampilan Portofolio (mis. race condition
   * restoreActiveMode yang tertunda, atau navigasi yang tak diinginkan).
   */
  function isPortfolioOpen() {
    var pf = document.getElementById('portfolio-area');
    return !!(pf && !pf.classList.contains('hidden'));
  }

  function showFleetView() {
    // [GUARD PORTOFOLIO] Jangan timpa tampilan Portofolio bila sedang terbuka.
    // Ini mencegah race condition restoreActiveMode() (yang tertunda) dan
    // navigasi tak sengaja memunculkan dropzone VHMS di atas Portofolio.
    if (isPortfolioOpen()) return;
    state.view = 'fleet';
    render.resetCharts();
    setBannerVisible(false);
    toggle('table-section', false);
    toggle('dashboard-area', false);
    toggle('comparison-area', false);
    toggle('cross-area', false);
    toggle('welcome-area', false);
    // [REVISI #7] Pastikan heatmap tertutup & daftar katalog tampil kembali.
    toggle('fleet-heatmap-panel', false);
    toggle('fleet-list-wrap', true);

    // [HEADER HOME] Katalog unit BUKAN detail unit -> header diringkas:
    // sembunyikan chip SN/keluarga/ONLINE, subjudul Engine, dan statistik
    // (SMR/Health/RUL) agar header fokus ke nama perusahaan di halaman home.
    setHeaderCompact(true);
    if (render.resetHeader) render.resetHeader();

    if (fleet.count() > 0) {
      toggle('fleet-area', true);
      render.renderFleet(fleet.fleetStats());
    } else {
      // Belum ada data -> hanya form upload yang tampil.
      toggle('fleet-area', false);
      toggle('welcome-area', true);
    }
  }

  /** Ringkas/lebarkan statistik & chip pada header.
   *  compact = true  -> halaman home/katalog (header nama perusahaan)
   *  compact = false -> detail unit (tampilkan identitas & statistik unit)
   */
  function setHeaderCompact(compact) {
    var header = document.querySelector('.app-header');
    if (header) header.classList.toggle('header-compact', !!compact);
  }

  /* -----------------------------------------------------------------------
   * Tampilan Perbandingan Unit (ranking criticalitas)
   * --------------------------------------------------------------------- */
  function showComparisonView() {
    if (fleet.count() === 0) {
      toast('Belum ada unit. Muat file CSV terlebih dahulu.', 'err');
      return;
    }
    state.view = 'comparison';

    showLoading('Menghitung peringkat criticalitas...');
    // beri jeda 1 frame agar overlay loading sempat tampil
    setTimeout(function () {
      // Hitung ulang (atau pakai cache bila data tak berubah)
      state.ranked = ranking.rankFleet(fleet, { model: 'ALL' });

      toggle('fleet-area', false);
      toggle('dashboard-area', false);
      toggle('welcome-area', false);
      toggle('comparison-area', true);
      toggle('cross-area', false);
      // [ISOLASI VIEW] Sembunyikan juga halaman Portofolio agar tidak bocor
      // (muncul di bawah) saat masuk ke Comparison.
      toggle('portfolio-area', false);
      setBannerVisible(false);
      // [HEADER HOME] Perbandingan bukan detail unit -> header ringkas + netral.
      setHeaderCompact(true);
      if (render.resetHeader) render.resetHeader();

      // Isi dropdown model dari data yang ada
      var modelSel = document.getElementById('comparison-model');
      if (modelSel) {
        var models = {};
        fleet.rows().forEach(function (r) { if (r.model) models[r.model] = true; });
        var opts = '<option value="ALL">Semua Model</option>';
        Object.keys(models).sort().forEach(function (m) {
          opts += '<option value="' + render.esc(m) + '">' + render.esc(m) + '</option>';
        });
        modelSel.innerHTML = opts;
        modelSel.value = render.getCompState().model || 'ALL';
      }

      render.setCompState({ model: modelSel ? modelSel.value : 'ALL' });
      render.renderComparison(state.ranked);
      switchCompTab('rank');
      hideLoading();
    }, 30);
  }

  /* -----------------------------------------------------------------------
   * [CROSS ANALYSIS] Tampilan korelasi VHMS x SOS
   * --------------------------------------------------------------------- */
  function showCrossView() {
    if (fleet.count() === 0) {
      toast('Belum ada unit VHMS. Muat file telemetri terlebih dahulu.', 'err');
      return;
    }
    if (!global.SOS_STORE || global.SOS_STORE.count() === 0) {
      toast('Belum ada data SOS. Muat file lab SOS untuk analisa silang.', 'err');
      return;
    }
    state.view = 'cross';
    toggle('welcome-area', false);
    toggle('fleet-area', false);
    toggle('comparison-area', false);
    toggle('dashboard-area', false);
    // [ISOLASI VIEW] Cross Analysis adalah area mandiri: sembunyikan area SOS
    // agar tidak bocor/tumpang-tindih saat dibuka dari mode SOS.
    toggle('sos-area', false);
    // [ISOLASI VIEW] Sembunyikan juga halaman Portofolio agar tidak bocor
    // (muncul di bawah) saat masuk ke Cross Analysis.
    toggle('portfolio-area', false);
    toggle('cross-area', true);
    setBannerVisible(false);
    // Header ringkas + netral (bukan detail unit).
    setHeaderCompact(true);
    if (render.resetHeader) render.resetHeader();
    if (global.VHMS_CROSS_RENDER) global.VHMS_CROSS_RENDER.showCross();
  }

  /* -----------------------------------------------------------------------
   * Pemuatan BANYAK file sekaligus (multi-upload)
   * Diproses BERTAHAP agar UI tidak membeku pada 200+ file.
   * --------------------------------------------------------------------- */
  function processFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /\.(csv|txt)$/i.test(f.name);
    });
    if (!files.length) {
      toast('Tidak ada file .csv/.txt yang valid pada pilihan tersebut.', 'err');
      return;
    }

    var okCount = 0, failCount = 0, critCount = 0, mergeCount = 0, fixedCount = 0;
    var i = 0;
    var CHUNK = 6;   // jumlah file per giliran agar browser tetap responsif

    function step() {
      var end = Math.min(i + CHUNK, files.length);
      var batch = files.slice(i, end);

      var jobs = batch.map(function (f) {
        return parser.parseFile(f).then(function (parsed) {
          var analysis = analytics.analyze(parsed);
          analysis.sourceFile = f.name;
          var r = fleet.add(analysis, f.name);
          okCount++;
          if (r.merged) mergeCount++;
          var vr = analysis.validationReport;
          if (vr && (vr.droppedInvalidSmr || vr.droppedDuplicate || vr.warnings.length)) fixedCount++;
          if (analysis.health.label === 'CRITICAL') critCount++;
        }).catch(function (err) {
          failCount++;
          console.error('Gagal memproses ' + f.name, err);
        });
      });

      Promise.all(jobs).then(function () {
        i = end;
        showLoading('Memproses unit... ' + i + ' / ' + files.length);
        if (i < files.length) {
          setTimeout(step, 0);      // lepas kontrol ke UI, lalu lanjut
        } else {
          hideLoading();
          var msg = okCount + ' file diproses';
          if (mergeCount) msg += ', ' + mergeCount + ' digabung ke unit lama (SN sama)';
          msg += ' → ' + fleet.count() + ' unit di Home.';
          if (critCount) msg += ' ' + critCount + ' unit CRITICAL.';
          if (fixedCount) msg += ' ' + fixedCount + ' file melewati validasi (duplikat/SMR tidak wajar).';
          if (failCount) msg += ' ' + failCount + ' file gagal.';
          toast(msg, (critCount || fixedCount) ? 'err' : 'ok');
          if (fleet.count() === 1) {
            openUnit(fleet.ids()[0]);       // hanya 1 unit -> langsung buka detail
          } else {
            showFleetView();                // banyak unit -> tampilkan katalog
          }
        }
      });
    }

    showLoading('Memproses ' + files.length + ' file...');
    step();
  }

  function processFile(file) {
    processFiles([file]);
  }

  /* -----------------------------------------------------------------------
   * Ekspor
   * --------------------------------------------------------------------- */
  function exportCsv() {
    if (!state.current) { toast('Belum ada data untuk diekspor.', 'err'); return; }
    var a = state.current;
    // [FIX] Pakai parameter EFEKTIF per keluarga (mengikuti override kolom
    // TRUCK/DOZER) agar header ekspor konsisten dengan nilai yang ditulis.
    var P = (cfg.paramsForFamily && a.familyId) ? cfg.paramsForFamily(a.familyId) : cfg.PARAMS;
    var headers = ['Timestamp', 'SMR'];
    Object.keys(P).forEach(function (k) {
      if (k === 'smr' || k === 'calendar') return;
      headers.push(P[k].label + (P[k].unit ? ' (' + P[k].unit + ')' : ''));
    });
    headers.push('Status');

    var lines = [headers.join(';')];
    a.records.forEach(function (r) {
      var row = [
        r.calendar ? r.calendar.display : '',
        r.smr !== null ? String(r.smr) : ''
      ];
      Object.keys(P).forEach(function (k) {
        if (k === 'smr' || k === 'calendar') return;
        var v = r[k];
        row.push(v === null || v === undefined ? '' : String(v).replace('.', ','));
      });
      row.push(r.status);
      lines.push(row.join(';'));
    });

    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'vhms-export-' + (a.meta.serial || 'unit') + '.csv');
    toast('Data berhasil diekspor ke CSV.', 'ok');
  }

  function exportJson() {
    if (!state.current) { toast('Belum ada data untuk diekspor.', 'err'); return; }
    var a = state.current;
    // [FIX] Parameter efektif per keluarga (lihat catatan pada exportCsv).
    var P = (cfg.paramsForFamily && a.familyId) ? cfg.paramsForFamily(a.familyId) : cfg.PARAMS;
    var payload = {
      meta: a.meta,
      smrRange: a.smrRange,
      health: a.health,
      anomalies: a.anomalies,
      summary: a.summary,
      records: a.records.map(function (r) {
        var o = { timestamp: r.calendar ? r.calendar.display : null, smr: r.smr, status: r.status };
        Object.keys(P).forEach(function (k) {
          if (k === 'smr' || k === 'calendar') return;
          o[k] = r[k];
        });
        return o;
      })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'vhms-export-' + (a.meta.serial || 'unit') + '.json');
    toast('Data berhasil diekspor ke JSON.', 'ok');
  }

  function exportReport() {
    if (!state.current) { toast('Belum ada data untuk dijadikan laporan.', 'err'); return; }
    document.body.classList.add('printing');
    setTimeout(function () {
      window.print();
      setTimeout(function () { document.body.classList.remove('printing'); }, 400);
    }, 120);
  }

  /* -----------------------------------------------------------------------
   * Ekspor hasil peringkat criticalitas
   * --------------------------------------------------------------------- */
  function exportComparisonCsv() {
    if (!state.ranked || !state.ranked.length) {
      toast('Belum ada hasil peringkat untuk diekspor.', 'err');
      return;
    }
    var headers = [
      'Rank', 'Unit ID', 'Serial No.', 'Model', 'Band', 'Skor Criticalitas',
      'Keparahan', 'Bukti', 'Tren', 'Pilar Utama', 'Penyebab Utama',
      'Nilai Penyebab', 'Satuan', 'Jumlah Param Bermasalah'
    ];
    var lines = [headers.join(';')];
    state.ranked.forEach(function (u) {
      var tc = u.topCause;
      lines.push([
        u.rank, u.id, u.serial || '', u.model || '', u.band,
        String(u.score).replace('.', ','),
        String(u.axis.severity).replace('.', ','),
        String(u.axis.evidence).replace('.', ','),
        String(u.axis.trend).replace('.', ','),
        u.pillar,
        tc ? tc.label : '',
        tc && tc.value !== null ? String(tc.value).replace('.', ',') : '',
        tc ? tc.unit : '',
        u.affectedCount || 0
      ].join(';'));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'vhms-unit-ranking.csv');
    toast('Peringkat ' + state.ranked.length + ' unit berhasil diekspor.', 'ok');
  }

  /* -----------------------------------------------------------------------
   * [FITUR BARU] Sub-page Perbandingan per Parameter
   * --------------------------------------------------------------------- */
  function exportParamMatrixCsv() {
    if (!state.ranked || !state.ranked.length) {
      toast('Belum ada data untuk diekspor.', 'err');
      return;
    }
    var csv = render.paramMatrixToCsv(state.ranked);
    if (!csv) {
      toast('Matrix perbandingan kosong.', 'err');
      return;
    }
    var blob = new Blob(['\uFEFF' + csv.replace(/\n/g, '\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'vhms-param-comparison.csv');
    toast('Matrix perbandingan parameter berhasil diekspor.', 'ok');
  }

  /** Ganti sub-tab dalam halaman Unit Comparison (Peringkat | Per Parameter | Overlay). */
  function switchCompTab(tab) {
    var validTabs = ['rank', 'param', 'overlay'];
    if (validTabs.indexOf(tab) === -1) tab = 'rank';
    render.setCompState({ tab: tab });

    // Toggle tombol tab
    document.querySelectorAll('#comparison-subtabs .subtab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-comp-tab') === tab);
    });
    // Toggle panel
    toggle('comparison-tab-rank', tab === 'rank');
    toggle('comparison-tab-param', tab === 'param');
    toggle('comparison-tab-overlay', tab === 'overlay');

    // Sub-judul & label tombol ekspor
    var sub = document.getElementById('comparison-subtitle');
    var expLabel = document.getElementById('btn-export-comparison-label');
    if (tab === 'rank') {
      if (sub) sub.textContent = 'Peringkat criticalitas Home — skor 0–100 (Keparahan 45% + Bukti 30% + Tren 25%)';
      if (expLabel) expLabel.textContent = 'Ekspor Peringkat';
      if (state.ranked) render.renderComparison(state.ranked);
    } else if (tab === 'param') {
      if (sub) sub.textContent = 'Perbandingan nilai mentah antar unit (aple-to-aple) per parameter';
      if (expLabel) expLabel.textContent = 'Ekspor Matrix';
      if (state.ranked) render.renderComparisonByParam(state.ranked);
    } else {
      if (sub) sub.textContent = 'Overlay tren parameter yang sama pada 2–3 unit sekaligus';
      if (expLabel) expLabel.textContent = 'Ekspor Peringkat';
      if (state.ranked) render.initOverlaySelectors(state.ranked);
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  /* -----------------------------------------------------------------------
   * [POIN 5] Reset filter katalog (status + pencarian) ke default.
   * --------------------------------------------------------------------- */
  function resetFleetFilters() {
    render.setFleetState({ filter: 'ALL', search: '' });
    var s = document.getElementById('fleet-search');
    if (s) s.value = '';
    render.renderFleetTable();
  }

  /* -----------------------------------------------------------------------
   * [POIN 4] Database Unit (SN -> Nomor Lambung)
   * --------------------------------------------------------------------- */
  function unitdb() { return global.VHMS_UNITDB; }

  /** Perbarui indikator status DB di UI. */
  function updateUnitDbStatus() {
    var el = document.getElementById('unitdb-status');
    var db = unitdb();
    if (!el || !db) return;
    var n = db.count();
    var meta = db.getMeta();
    if (n > 0) {
      el.className = 'chip';
      el.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
        fmtIntSafe(n) + ' unit terpetakan' +
        (meta.source ? ' <span style="color:#64748b">(' + render.esc(meta.source) + ')</span>' : '');
    } else {
      el.className = 'chip';
      el.innerHTML = '<i class="fa-solid fa-circle-question"></i> Belum dimuat';
    }
  }

  function fmtIntSafe(n) {
    return Number(n).toLocaleString('id-ID');
  }

  /** Proses file database unit. */
  function processUnitDbFile(file) {
    var db = unitdb();
    if (!db) { toast('Modul Database Unit tidak tersedia.', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var res = db.parse(e.target.result);
        db.save(file.name);
        var matched = fleet.refreshLambung();
        updateUnitDbStatus();
        // Perbarui tampilan yang sedang aktif
        if (state.view === 'fleet') render.renderFleet(fleet.fleetStats());
        else if (state.view === 'comparison' && state.ranked) render.renderComparison(state.ranked);
        else if (state.view === 'unit' && state.current) render.renderHeader(state.current);

        toast('Database Unit dimuat: ' + res.added + ' baris' +
          (matched ? ' — ' + matched + ' unit berhasil dicocokkan.' : ' — belum ada unit yang cocok.'),
          matched ? 'ok' : 'info', 7000);
      } catch (err) {
        console.error(err);
        toast('Gagal membaca Database Unit: ' + err.message, 'err');
      }
    };
    reader.onerror = function () { toast('Gagal membaca file.', 'err'); };
    reader.readAsText(file, 'utf-8');
  }

  /** Unduh template CSV Database Unit. */
  function downloadUnitDbTemplate() {
    var csv = 'Machine Serial No.,Nomor Lambung\n20046,EX-001\n20047,EX-002\n20048,EX-003\n';
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'template-database-unit.csv');
    toast('Template Database Unit diunduh.', 'ok');
  }

  function clearUnitDb() {
    var db = unitdb();
    if (!db) return;
    db.clear();
    fleet.refreshLambung();
    updateUnitDbStatus();
    if (state.view === 'fleet') render.renderFleet(fleet.fleetStats());
    toast('Database Unit dihapus dari browser.', 'info');
  }

  /* -----------------------------------------------------------------------
   * Ekspor katalog unit (semua unit) ke CSV
   * --------------------------------------------------------------------- */
  function exportFleetCsv() {
    if (!fleet.count()) { toast('Belum ada unit untuk diekspor.', 'err'); return; }
    var rows = fleet.rows();
    var headers = [
      'Unit ID', 'Serial No.', 'Nomor Lambung', 'Keluarga', 'Model', 'Engine Model', 'Product Group', 'File Sumber',
      'Status', 'Health Score', 'SMR Terakhir', 'Telemetri Terakhir', 'Jumlah Record',
      'Normal', 'Warning', 'Critical', 'Jumlah Anomali',
      'Blowby Press Max (kPa)', 'Engine Oil Press H-Min (MPa)', 'Engine Oil Temp Max (C)', 'Coolant Temp Max (C)',
      'Hyd Temp Max', 'Fuel Avg (L/h)', 'Power Avg (kW)'
    ];
    var lines = [headers.join(';')];
    rows.forEach(function (r) {
      function n(v, d) { return v === null || v === undefined ? '' : Number(v).toFixed(d).replace('.', ','); }
      lines.push([
        r.id, r.serial, r.lambung || '', r.familyId || '', r.model, r.engineModel, r.productGroup, r.sourceFile,
        r.healthLabel, n(r.healthScore, 1), n(r.smrLast, 1), r.lastTimestamp || '', r.recordCount,
        r.nNormal, r.nWarning, r.nCritical, r.anomalyCount,
        n(r.kpi.blowbyMax, 2), n(r.kpi.oilPressHMin, 2), n(r.kpi.engOilTempMax, 1), n(r.kpi.coolantMax, 1),
        n(r.kpi.hydTempMax, 1), n(r.kpi.fuelAvg, 1), n(r.kpi.powerAvg, 0)
      ].join(';'));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'vhms-fleet-summary.csv');
    toast('Katalog Home berhasil diekspor (' + rows.length + ' unit).', 'ok');
  }

  /* -----------------------------------------------------------------------
   * Navigasi tab (menyaring kartu KPI, chart, dll.)
   * --------------------------------------------------------------------- */
  var TAB_MAP = {
    overview:   { kpi: null,                panels: ['overview-panels'] },
    engine:     { kpi: ['engine', 'exhaust', 'powertrain'], charts: ['group-engine', 'group-exhaust', 'group-powertrain'] },
    hydraulic:  { kpi: ['hydraulic'],      charts: ['group-hydraulic'] },
    cooling:    { kpi: ['cooling', 'fanpto', 'brakes'], charts: ['group-cooling', 'group-fanpto'] },
    productivity: { kpi: ['productivity'], charts: ['group-power', 'group-greasing', 'group-dozing'] },
    'data-table': { table: true }
  };

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    var btn = document.getElementById('tab-' + tab);
    if (btn) btn.classList.add('active');

    var isTable = (tab === 'data-table');
    toggle('kpi-section', !isTable);
    toggle('charts-section', !isTable);
    toggle('insights-section', !isTable);
    toggle('overview-panels', tab === 'overview');
    toggle('table-section', isTable);

    if (!isTable) {
      // Filter kartu KPI
      var spec = TAB_MAP[tab] || {};
      // [FIX] Filter berdasarkan data-comp-id (id kompartemen sebenarnya),
      // BUKAN indeks posisi. Hal ini penting untuk keluarga non-excavator
      // (TRUCK/DOZER) yang daftar kompartemennya berbeda/tersaring, sehingga
      // pencocokan indeks ke cfg.COMPARTMENTS akan salah kartu.
      document.querySelectorAll('#kpi-grid .kpi-card').forEach(function (card) {
        var compId = card.getAttribute('data-comp-id');
        var show = !spec.kpi || (compId && spec.kpi.indexOf(compId) !== -1);
        card.classList.toggle('hidden', !show);
      });
      // Filter chart
      document.querySelectorAll('#charts-section .panel[data-chart]').forEach(function (panel) {
        var id = panel.getAttribute('data-chart');
        var show = !spec.charts || spec.charts.indexOf(id) !== -1;
        panel.classList.toggle('hidden', !show);
      });
      // Resize chart agar menyesuaikan container baru
      setTimeout(function () {
        Object.keys(render.getCharts()).forEach(function (k) {
          var c = render.getCharts()[k];
          if (c) c.resize();
        });
        if (render.syncInsightHeight) render.syncInsightHeight();
      }, 60);
    }
  }

  function toggle(id, show) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !show);
  }

  /** Banner alert hanya relevan di halaman Dashboard Unit. */
  function setBannerVisible(show) {
    var banner = document.getElementById('alert-banner');
    if (!banner) return;
    if (show) banner.classList.remove('hidden');
    else {
      banner.classList.add('hidden');
      // Tutup modal rekomendasi bila banner disembunyikan (pindah halaman)
      if (render.closeAnomalyModal) render.closeAnomalyModal();
    }
  }

  /* -----------------------------------------------------------------------
   * Kosongkan SEMUA data (VHMS + SOS) — konfirmasi lalu reset total.
   * --------------------------------------------------------------------- */
  function clearAllData() {
    var nVhms = fleet.count();
    var sos = global.SOS_STORE;
    var nSos = sos ? sos.count() : 0;

    if (nVhms === 0 && nSos === 0) {
      toast('Tidak ada data untuk dikosongkan.', 'info');
      return;
    }

    var msg = 'Hapus SEMUA data?\n\n' +
      '• VHMS: ' + nVhms + ' unit\n' +
      '• SOS: ' + nSos + ' sampel\n\n' +
      'Tindakan ini tidak dapat dibatalkan.';
    if (!global.confirm || !global.confirm(msg)) return;

    // Hapus VHMS (termasuk data tersimpan di sesi)
    state.current = null;
    state.currentUnitId = null;
    state.ranked = null;
    fleet.clear();

    // Hapus SOS (termasuk data tersimpan di sesi) + segarkan tampilan SOS
    if (sos) {
      sos.clear();
      var sosRender = global.SOS_RENDER;
      if (sosRender) {
        if (sosRender.updateUploadVisibility) sosRender.updateUploadVisibility();
        if (sosRender.showView) sosRender.showView('fleet');
      }
    }

    toast('Semua data VHMS & SOS dikosongkan.', 'info');
    showFleetView();
  }

  /* -----------------------------------------------------------------------
   * Inisialisasi event
   * --------------------------------------------------------------------- */
  function init() {
    // Tombol tab
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    // Tombol pilih file (dukung MULTI-file)
    var fileInput = document.getElementById('file-input');
    var pickBtn = document.getElementById('btn-pick');
    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processFiles(e.target.files);
        e.target.value = '';
      });
    }

    // Tombol kembali ke katalog Home
    var backBtn = document.getElementById('btn-back-fleet');
    if (backBtn) backBtn.addEventListener('click', showFleetView);

    // Tombol tambah unit dari katalog Home
    var pickFleetBtn = document.getElementById('btn-pick-fleet');
    if (pickFleetBtn && fileInput) {
      pickFleetBtn.addEventListener('click', function () { fileInput.click(); });
    }

    // Tombol buka katalog dari header.
    // Mode-aware: bila mode SOS sedang aktif, klik "Home" cukup
    // mengembalikan ke halaman utama SOS (tidak membuka VHMS di atasnya).
    var fleetBtn = document.getElementById('btn-fleet');
    if (fleetBtn) {
      fleetBtn.addEventListener('click', function () {
        if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.goHome) {
          global.VHMS_SOS_MODE.goHome();
          return;
        }
        showFleetView();
      });
    }

    // Tombol bersihkan armada — hapus SEMUA data (VHMS + SOS)
    var clearBtn = document.getElementById('btn-clear-fleet');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () { clearAllData(); });
    }

    // Ekspor katalog Home
    var fleetExportBtn = document.getElementById('btn-export-fleet');
    if (fleetExportBtn) fleetExportBtn.addEventListener('click', exportFleetCsv);

    /* ---------------- [POIN 4] Database Unit ---------------- */
    var unitDbInput = document.getElementById('unitdb-input');
    var unitDbPick = document.getElementById('btn-unitdb-pick');
    if (unitDbPick && unitDbInput) {
      unitDbPick.addEventListener('click', function () { unitDbInput.click(); });
    }
    if (unitDbInput) {
      unitDbInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processUnitDbFile(e.target.files[0]);
        e.target.value = '';
      });
    }
    var unitDbTpl = document.getElementById('btn-unitdb-template');
    if (unitDbTpl) unitDbTpl.addEventListener('click', downloadUnitDbTemplate);
    var unitDbClear = document.getElementById('btn-unitdb-clear');
    if (unitDbClear) unitDbClear.addEventListener('click', clearUnitDb);
    updateUnitDbStatus();

    // Filter / pencarian / sortir tabel armada
    var fleetSearch = document.getElementById('fleet-search');
    if (fleetSearch) {
      fleetSearch.addEventListener('input', function () {
        render.setFleetState({ search: fleetSearch.value });
        render.renderFleetTable();
      });
    }
    var fleetFilter = document.getElementById('fleet-filter');
    if (fleetFilter) {
      fleetFilter.addEventListener('change', function () {
        render.setFleetState({ filter: fleetFilter.value });
        render.renderFleetTable();
      });
    }

    /* ---------------- [POIN 5] Filter cepat & penanda filter aktif ---------------- */
    var filterBar = document.getElementById('fleet-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        // Klik chip filter cepat
        var chip = e.target.closest('[data-quick-filter]');
        if (chip) {
          var val = chip.getAttribute('data-quick-filter');
          var newVal = (val === 'ALL') ? 'ALL' : val;
          render.setFleetState({ filter: newVal });
          render.renderFleetTable();
          return;
        }
        // Klik tanda "x" pada tag filter aktif
        if (e.target.id === 'fleet-tag-clear') {
          resetFleetFilters();
        }
      });
    }
    var resetFilterBtn = document.getElementById('btn-reset-filter');
    if (resetFilterBtn) resetFilterBtn.addEventListener('click', resetFleetFilters);
    document.querySelectorAll('#fleet-table-head th[data-fleet-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-fleet-sort');
        var st = render.getFleetState();
        // Kolom "severity" selalu diurutkan worst→best (arah tetap).
        if (k === 'severity') {
          render.setFleetState({ sortKey: 'severity', sortDir: 'desc' });
          render.renderFleetTable();
          return;
        }
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setFleetState({ sortKey: k, sortDir: dir });
        render.renderFleetTable();
      });
    });

    // Delegasi klik tombol Detail di tabel armada
    var fleetTbody = document.getElementById('fleet-table-body');
    if (fleetTbody) {
      fleetTbody.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-unit-id]');
        if (btn) openUnit(btn.getAttribute('data-unit-id'));
      });
    }

    /* ---------------- Unit Comparison ---------------- */
    var compBtn = document.getElementById('btn-comparison');
    if (compBtn) compBtn.addEventListener('click', showComparisonView);

    /* ---------------- Cross Analysis (VHMS x SOS) ---------------- */
    var crossBtn = document.getElementById('btn-cross');
    if (crossBtn) crossBtn.addEventListener('click', showCrossView);

    /* ---------------- Fleet Heatmap ---------------- */
    // [REVISI #7] Heatmap VHMS kini berperilaku sebagai SUB-VIEW seperti mode
    // SOS: membukanya menyembunyikan daftar/katalog (toolbar, kartu, tabel) dan
    // hanya menampilkan panel heatmap. Tombol "Kembali" mengembalikan katalog.
    var hmBtn = document.getElementById('btn-heatmap');
    var hmPanel = document.getElementById('fleet-heatmap-panel');
    var hmClose = document.getElementById('btn-heatmap-close');
    function openHeatmap() {
      // Butuh data unit; bila kosong, beri tahu (tidak membuka view kosong).
      if (fleet.count() === 0) { toast('Belum ada unit untuk heatmap.', 'err'); return; }
      toggle('fleet-list-wrap', false);
      toggle('fleet-heatmap-panel', true);
      setHeaderCompact(true);
      if (render.resetHeader) render.resetHeader();
      render.renderHeatmap();
    }
    function closeHeatmap() {
      toggle('fleet-heatmap-panel', false);
      toggle('fleet-list-wrap', true);
      render.renderHeatmap && render.resetCharts && render.resetCharts();
    }
    if (hmBtn && hmPanel) {
      hmBtn.addEventListener('click', openHeatmap);
    }
    if (hmClose && hmPanel) {
      hmClose.addEventListener('click', closeHeatmap);
    }

    var backFleet2 = document.getElementById('btn-back-fleet-2');
    if (backFleet2) backFleet2.addEventListener('click', showFleetView);

    var compSearch = document.getElementById('comparison-search');
    if (compSearch) {
      compSearch.addEventListener('input', function () {
        render.setCompState({ search: compSearch.value });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    }
    var compModel = document.getElementById('comparison-model');
    if (compModel) {
      compModel.addEventListener('change', function () {
        render.setCompState({ model: compModel.value });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    }
    var compBand = document.getElementById('comparison-band');
    if (compBand) {
      compBand.addEventListener('change', function () {
        render.setCompState({ band: compBand.value });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    }
    document.querySelectorAll('#comparison-head th[data-comp-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-comp-sort');
        var st = render.getCompState();
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setCompState({ sortKey: k, sortDir: dir });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    });
    // Klik baris/tombol di tabel comparison -> buka detail unit
    var compBody = document.getElementById('comparison-body');
    if (compBody) {
      compBody.addEventListener('click', function (e) {
        var el = e.target.closest('[data-unit-id]');
        if (el) openUnit(el.getAttribute('data-unit-id'));
      });
    }
    // Klik kartu Top 10 -> buka detail unit
    var compTop = document.getElementById('comparison-top10');
    if (compTop) {
      compTop.addEventListener('click', function (e) {
        var el = e.target.closest('[data-unit-id]');
        if (el) openUnit(el.getAttribute('data-unit-id'));
      });
    }
    var compExport = document.getElementById('btn-export-comparison');
    if (compExport) compExport.addEventListener('click', function () {
      var st = render.getCompState();
      if (st.tab === 'param') exportParamMatrixCsv();
      else exportComparisonCsv();
    });

    /* ---------------- Sub-tab: Perbandingan per Parameter ---------------- */
    document.querySelectorAll('#comparison-subtabs .subtab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchCompTab(b.getAttribute('data-comp-tab')); });
    });

    var paramPillar = document.getElementById('param-comp-pillar');
    if (paramPillar) {
      paramPillar.addEventListener('change', function () {
        render.setCompParamState({ paramPillar: paramPillar.value });
        if (state.ranked) render.renderComparisonByParam(state.ranked);
      });
    }
    var paramBasis = document.getElementById('param-comp-basis');
    if (paramBasis) {
      paramBasis.addEventListener('change', function () {
        render.setCompParamState({ paramBasis: paramBasis.value });
        if (state.ranked) render.renderComparisonByParam(state.ranked);
      });
    }
    var paramExport = document.getElementById('btn-export-param-comp');
    if (paramExport) paramExport.addEventListener('click', exportParamMatrixCsv);

    /* ---------------- Overlay Chart ---------------- */
    var overlayDraw = document.getElementById('btn-overlay-draw');
    if (overlayDraw) overlayDraw.addEventListener('click', function () { render.drawOverlayChart(); });

    /* ---------------- Banner Alert -> Modal Rekomendasi ---------------- */
    var alertBanner = document.getElementById('alert-banner');
    if (alertBanner) {
      var openModalFromBanner = function () {
        if (alertBanner.classList.contains('clickable')) render.openAnomalyModal();
      };
      alertBanner.addEventListener('click', openModalFromBanner);
      alertBanner.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModalFromBanner(); }
      });
    }
    var modalClose = document.getElementById('anomaly-modal-close');
    if (modalClose) modalClose.addEventListener('click', function () { render.closeAnomalyModal(); });
    var modalEl = document.getElementById('anomaly-modal');
    if (modalEl) {
      // Klik area gelap (di luar panel) -> tutup
      modalEl.addEventListener('click', function (e) {
        if (e.target === modalEl) render.closeAnomalyModal();
      });
    }
    // Tombol Esc menutup modal
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && render.isAnomalyModalOpen && render.isAnomalyModalOpen()) {
        render.closeAnomalyModal();
      }
    });

    // Tombol ekspor
    ['btn-export-csv', 'btn-export-1'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', exportCsv);
    });
    var jb = document.getElementById('btn-export-json');
    if (jb) jb.addEventListener('click', exportJson);
    ['btn-report', 'btn-report-1'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', exportReport);
    });

    // Drag & drop di seluruh dokumen
    setupDragDrop();

    // Kontrol tabel
    var search = document.getElementById('table-search');
    if (search) {
      search.addEventListener('input', function () {
        if (!state.current) return;
        render.setTableState({ search: search.value });
        render.renderTable(state.current);
      });
    }
    var filter = document.getElementById('table-filter');
    if (filter) {
      filter.addEventListener('change', function () {
        if (!state.current) return;
        render.setTableState({ filter: filter.value });
        render.renderTable(state.current);
      });
    }
    // Klik header untuk sort
    document.querySelectorAll('#table-head th[data-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        if (!state.current) return;
        var k = th.getAttribute('data-sort');
        var st = render.getTableState();
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setTableState({ sortKey: k, sortDir: dir });
        render.renderTable(state.current);
      });
    });

    // Dropzone besar di halaman sambutan
    var dz = document.getElementById('dropzone');
    if (dz) {
      dz.addEventListener('click', function () { if (fileInput) fileInput.click(); });
    }

    // [PERSISTENSI] Pulihkan armada VHMS dari sesi browser (bila ada).
    // Bertahan saat reload; dihapus total lewat tombol "Kosongkan".
    if (fleet.count() === 0 && fleet.restore && fleet.restore()) {
      // [FRESH THRESHOLD] Setelah restore, hitung ULANG analitik agar
      // `thresholdSet` snapshot memakai threshold/config TERKINI (mis. Boost
      // yang baru dikonversi ke mmHg). Tanpa ini, unit yang datanya tersimpan
      // sebelum perubahan satuan bisa menampilkan ambang lama (kPa).
      try { if (fleet.reanalyzeAll) fleet.reanalyzeAll(); } catch (e) {}
      toast('Data VHMS sebelumnya dipulihkan dari sesi browser (' + fleet.count() + ' unit).', 'info');
      showFleetView();
    }
  }

  function setupDragDrop() {
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        var dz = document.getElementById('dropzone');
        if (dz && !document.getElementById('welcome-area').classList.contains('hidden')) {
          dz.classList.add('dragover');
        }
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        var dz = document.getElementById('dropzone');
        if (dz) dz.classList.remove('dragover');
        document.body.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        processFiles(dt.files);
      }
    });
  }

  /* ----------------------------------------------------------------------- */
  /**
   * [SETTINGS] Segarkan tampilan saat ini tanpa mengubah navigasi.
   * Dipakai setelah threshold berubah agar KPI/anomali/ranking ter-update.
   */
  function refreshCurrent() {
    if (state.view === 'unit' && state.currentUnitId) {
      var analysis = fleet.getAnalysis(state.currentUnitId);
      if (analysis) { state.current = analysis; render.renderAll(analysis); }
    } else if (state.view === 'comparison') {
      showComparisonView();
    } else if (state.view === 'fleet') {
      if (fleet.count() > 0) render.renderFleet(fleet.fleetStats());
    } else if (state.view === 'cross') {
      if (global.VHMS_CROSS_RENDER && global.VHMS_CROSS_RENDER.showCross) {
        try { global.VHMS_CROSS_RENDER.showCross(); } catch (e) {}
      }
    }
  }

  global.VHMS_APP = {
    init: init,
    processFile: processFile,
    processFiles: processFiles,
    processText: processText,
    openUnit: openUnit,
    showFleetView: showFleetView,
    showUnitView: showUnitView,
    showComparisonView: showComparisonView,
    showCrossView: showCrossView,
    clearAllData: clearAllData,
    exportCsv: exportCsv,
    exportJson: exportJson,
    exportFleetCsv: exportFleetCsv,
    exportComparisonCsv: exportComparisonCsv,
    exportParamMatrixCsv: exportParamMatrixCsv,
    exportReport: exportReport,
    switchTab: switchTab,
    switchCompTab: switchCompTab,
    refreshCurrent: refreshCurrent,
    toast: toast,
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

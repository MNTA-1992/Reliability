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
   * Utilitas: debounce (batasi frekuensi render saat input cepat)
   * --------------------------------------------------------------------- */
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

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
    // [P1 A11Y 2026-10-05] Error diumumkan segera oleh screen reader
    // (role=alert = assertive); info/ok cukup polite.
    if (type === 'err') { div.setAttribute('role', 'alert'); }
    else { div.setAttribute('role', 'status'); }
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

      // 3) Daftarkan ke fleet (bisa merge bila SN sudah ada).
      // [KONSISTENSI NAVIGASI 2026-10-03] JANGAN langsung buka detail unit.
      // Alur harus sama dengan SOS: setelah upload -> halaman DAFTAR UNIT,
      // lalu detail dibuka hanya saat pengguna menekan tombol "Detail".
      var res = fleet.add(analysis, sourceName);
      showFleetView();

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
    if (state.current && render.renderHeader) {
      render.renderHeader(state.current);
    }
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
          // [KONSISTENSI NAVIGASI 2026-10-03] SELALU ke halaman daftar unit
          // setelah upload — berapa pun jumlah unitnya. Detail hanya dibuka
          // lewat tombol "Detail" (perilaku sama dengan mode SOS).
          showFleetView();
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
  /**
   * [PENAMAAN LAPORAN 2026-10-03] Format nama file default saat cetak / simpan VHMS:
   * # Result VHMS Trend_[Engine]_[Caution/Critical]_[No Lambung]_Follow Up [SLA]
   */
  function getVHMSReportFileName(analysis) {
    if (!analysis) {
      if (state && state.current) analysis = state.current;
    }
    if (!analysis) return '# Result VHMS Trend';

    // 1. Compartment: default "Engine" untuk VHMS
    var comp = 'Engine';

    // 2. No Lambung
    var serial = analysis.meta ? (analysis.meta.serial || analysis.meta.machineNo) : '';
    var db = global.VHMS_UNITDB;
    var lambung = '';
    if (db && db.getLambung && serial) {
      lambung = db.getLambung(serial);
    }
    if (!lambung && analysis.meta && analysis.meta.lambung) {
      lambung = analysis.meta.lambung;
    }
    if (!lambung) {
      lambung = serial || (state && state.currentUnitId) || 'Unit';
    }
    lambung = String(lambung).replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 3. Status Caution / Critical / Normal berdasarkan threshold terlampaui
    var hasCrit = false;
    var hasWarn = false;

    if (analysis.anomalies && analysis.anomalies.length) {
      hasCrit = analysis.anomalies.some(function (a) { return a.status === 'CRITICAL'; });
      hasWarn = analysis.anomalies.some(function (a) { return a.status === 'WARNING' || a.status === 'CAUTION'; });
    }
    if (!hasCrit && analysis.health && analysis.health.label === 'CRITICAL') {
      hasCrit = true;
    }
    if (!hasCrit && !hasWarn && analysis.health && (analysis.health.label === 'WARNING' || analysis.health.label === 'CAUTION')) {
      hasWarn = true;
    }

    var status = hasCrit ? 'Critical' : (hasWarn ? 'Caution' : 'Normal');

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

    return '# Result VHMS Trend_' + comp + '_' + status + '_' + lambung + '_Follow Up ' + sla;
  }

  function exportReport() {
    if (!state.current) { toast('Belum ada data untuk dijadikan laporan.', 'err'); return; }
    var fname = getVHMSReportFileName(state.current);
    document.title = fname;
    document.body.classList.add('printing');
    setTimeout(function () {
      window.print();
    }, 120);
  }

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-05] Ekspor tabel "Equipment List" (katalog VHMS) ke Excel (CSV).
   * ---------------------------------------------------------------------
   * Menghasilkan CSV (pemisah `;`, BOM UTF-8) berisi SELURUH unit — TANPA
   * menghiraukan filter/pencarian yang aktif (sesuai permintaan). Susunan
   * kolom & nilai SAMA dengan tabel katalog di layar, diurutkan menurut
   * Peringkat (rankScore DESC) = paling critical di atas.
   */
  function buildFleetCsv() {
    var CSV = global.CSV_UTIL || {};
    var csvEscape = CSV.csvEscape || function (v) {
      if (v === null || v === undefined) return '';
      var s = String(v);
      return (s.indexOf(';') !== -1 || s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1)
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var R = global.VHMS_FLEET;
    var rows = (R && R.rows) ? R.rows() : [];
    rows = rows.slice().sort(function (a, b) { return (b.rankScore || 0) - (a.rankScore || 0); });

    var vcfg = global.VHMS_CONFIG;
    function statusOf(lbl) { return (vcfg && vcfg.statusLabelOf) ? vcfg.statusLabelOf(lbl) : (lbl || ''); }
    function num(v, d) {
      if (v === null || v === undefined || isNaN(v)) return '';
      return Number(v).toFixed(d);
    }

    var header = [
      'Peringkat', 'Nomor Lambung', 'Model', 'Serial', 'Status Health',
      'Health Index', 'Hours Meter', 'Tanggal',
      'Blowby Press Max (kPa)', 'Engine Oil Press H-Min (MPa)',
      'Engine Oil Temp Max (\u00B0C)', 'Coolant Temp Max (\u00B0C)', 'Hyd Temp Max (\u00B0C)',
      'Anomali', 'Anomali Kritis', 'Perhatian Utama', 'Sisa Operasi (RUL)'
    ];

    var lines = [header.map(csvEscape).join(';')];
    rows.forEach(function (r, i) {
      var kpi = r.kpi || {};
      var top = r.topAnomaly;
      var rulTxt = '';
      if (r.urgentRUL !== null && r.urgentRUL !== undefined && !isNaN(r.urgentRUL)) {
        rulTxt = Math.round(Number(r.urgentRUL)) + ' jam';
      }
      var row = [
        i + 1,
        r.lambung || '', r.model || '', r.serial || '', statusOf(r.healthLabel),
        (r.healthScore === null || r.healthScore === undefined) ? '' : num(r.healthScore, 1),
        num(r.smrLast, 1), r.lastTimestamp || '',
        num(kpi.blowbyMax, 2), num(kpi.oilPressHMin, 2),
        num(kpi.engOilTempMax, 1), num(kpi.coolantMax, 1), num(kpi.hydTempMax, 1),
        r.anomalyCount || 0, r.nCritThresholds || 0,
        top ? (top.title || '') : '', rulTxt
      ];
      lines.push(row.map(csvEscape).join(';'));
    });

    var csv = '\uFEFF' + lines.join('\r\n');
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    return { csv: csv, filename: 'Equipment List_' + stamp + '.csv', rows: rows.length };
  }

  /** Ekspor tabel Equipment List (katalog VHMS) ke berkas CSV/Excel. */
  function exportFleetCsv() {
    var R = global.VHMS_FLEET;
    if (!R || !R.count || R.count() === 0) {
      toast('Belum ada unit VHMS untuk diekspor.', 'err');
      return false;
    }
    var out = buildFleetCsv();
    var blob = new Blob([out.csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, out.filename);
    toast('Export Data: ' + out.rows + ' unit \u2192 ' + out.filename, 'ok');
    return true;
  }

  /* -----------------------------------------------------------------------
   * Ekspor hasil peringkat criticalitas
   * --------------------------------------------------------------------- */
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

    // Sub-judul per tab
    var sub = document.getElementById('comparison-subtitle');
    if (tab === 'rank') {
      if (sub) sub.textContent = 'Peringkat criticalitas Home — skor 0–100 (Keparahan 45% + Bukti 30% + Tren 25%)';
      if (state.ranked) render.renderComparison(state.ranked);
    } else if (tab === 'param') {
      if (sub) sub.textContent = 'Perbandingan nilai mentah antar unit (aple-to-aple) per parameter';
      if (state.ranked) render.renderComparisonByParam(state.ranked);
    } else {
      if (sub) sub.textContent = 'Overlay tren parameter yang sama pada 2–3 unit sekaligus';
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
    render.setFleetState({ filter: 'ALL', search: '', page: 1 });
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
    var nSec = (db.sectionCount ? db.sectionCount() : (meta.withSection || 0));
    var ltMeta = (global.PORTFOLIO_STORE && global.PORTFOLIO_STORE.lifetimeMeta) ? global.PORTFOLIO_STORE.lifetimeMeta() : { count: 0 };
    if (n > 0 || ltMeta.count > 0) {
      el.className = 'chip';
      el.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
        fmtIntSafe(n) + ' unit terpetakan' +
        (nSec ? ' <span style="color:#a78bfa">· ' + fmtIntSafe(nSec) + ' ber-section</span>' : '') +
        (ltMeta.count ? ' <span style="color:#38bdf8">· ' + fmtIntSafe(ltMeta.count) + ' baris lifetime</span>' : '') +
        (meta.source ? ' <span class="u-text-mute">(' + render.esc(meta.source) + ')</span>' : '');
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
        var text = e.target.result;
        var res = db.parse(text);
        db.save(file.name);
        var matched = fleet.refreshLambung();

        // Cek apakah file ini juga berisi data Lifetime Komponen (format Lifetime SAP/EHMS)
        var ltSynced = 0;
        if (global.LIFETIME_PARSER && global.PORTFOLIO_STORE) {
          try {
            var parsedLt = global.LIFETIME_PARSER.parse(text);
            if (parsedLt && parsedLt.count > 0) {
              global.PORTFOLIO_STORE.setLifetime(parsedLt, file.name);
              ltSynced = parsedLt.count;
            }
          } catch (eLt) {
            // Bukan file Lifetime (mis. file mapping SN-Lambung sederhana), abaikan
          }
        }

        updateUnitDbStatus();
        // [SATU UPLOAD 2026-10-01] Sinkronkan SECTION ke Portofolio dari data
        // yang sama (kolom Section opsional). Satu file mengisi Database Unit
        // (SN->Lambung) SEKALIGUS Section Portofolio (SN/Lambung->Section).
        var secSynced = syncSectionToPortfolio(file.name);
        // [FIX 2026-10-06] Segarkan dropdown Section + tabel SOS Kompartemen List
        // agar opsi Section langsung muncul tanpa perlu berpindah mode dulu.
        if (global.SOS_RENDER && global.SOS_RENDER.refreshSectionOptions) {
          try { global.SOS_RENDER.refreshSectionOptions(); } catch (eS) {}
        }
        // Perbarui tampilan yang sedang aktif
        if (state.view === 'fleet') render.renderFleet(fleet.fleetStats());
        else if (state.view === 'comparison' && state.ranked) render.renderComparison(state.ranked);
        else if (state.view === 'unit' && state.current) render.renderHeader(state.current);
        // Segarkan Portofolio bila sedang terbuka.
        if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) {
          try { global.PORTFOLIO_APP.refresh(); } catch (e2) {}
        }

        var msg = 'Data Unit dimuat: ' + res.added + ' baris' +
          (matched ? ' — ' + matched + ' unit dicocokkan' : ' — belum ada unit yang cocok');
        if (res.withSection) msg += ', ' + res.withSection + ' baris ber-section';
        if (ltSynced) msg += ', ' + ltSynced + ' baris data lifetime tersinkronkan';
        toast(msg + '.', (matched || ltSynced) ? 'ok' : 'info', 7000);
      } catch (err) {
        console.error(err);
        toast('Gagal membaca data unit: ' + err.message, 'err');
      }
    };
    reader.onerror = function () { toast('Gagal membaca file.', 'err'); };
    reader.readAsText(file, 'utf-8');
  }

  /**
   * [SATU UPLOAD 2026-10-01] Sinkronkan Section dari VHMS_UNITDB ke
   * PORTFOLIO_STORE (agar menu Portofolio membaca Section yang sama).
   * @returns {number} jumlah unit yang ter-sinkron (0 bila tak ada/tak tersedia).
   */
  function syncSectionToPortfolio(sourceName) {
    var db = unitdb();
    var store = global.PORTFOLIO_STORE;
    if (!db || !store || !db.entries || !store.setSection) return 0;
    var ents = db.entries();
    var rows = [], byLambung = {}, bySn = {}, sections = {}, n = 0;
    ents.forEach(function (en) {
      if (!en.section) return;
      n++;
      var row = { sn: en.snRaw || '', lambung: en.lambung || '', section: en.section };
      rows.push(row);
      var kLb = (store.normLambung ? store.normLambung(row.lambung) : String(row.lambung).toUpperCase());
      if (kLb) byLambung[kLb] = row;
      if (row.sn) bySn[String(row.sn).replace(/[\s._\-/]+/g, '').toUpperCase()] = row;
      sections[row.section] = (sections[row.section] || 0) + 1;
    });
    if (!rows.length) return 0;
    store.setSection({ rows: rows, byLambung: byLambung, bySn: bySn, sections: sections, count: rows.length, skipped: 0 }, sourceName || 'Database Unit');
    return n;
  }

  /** Unduh template CSV Data Unit & Lifetime EHMS/SAP */
  function downloadDataUnitLifetimeTemplate() {
    var csv = 'Site,EquipmentStatus,ComponentNo,EquipmentNumber,ModelUnit,SerialNumber,ObjectType,Component,CyclePerComponent,Status,LastMONumber,LastTecoDate,LastTotalCountReading,CounterReading,TotalCountReading,MeterRunComponent,MeterToRun,ComponentLife(%)\n' +
      '2005,INPR,2000030120,HD785-01,HD785-7,10025,A000,ENGINE,16000,NORMAL,,,0,45360,52606,12610,3390,78.81\n' +
      '2005,INPR,2000030121,HD785-01,HD785-7,10025,B000,TRANSMISSION,12500,NORMAL,,,0,45360,52606,9500,3000,76.00\n' +
      '2005,INPR,2000030122,HD785-01,HD785-7,10025,D00L,FINAL DRIVE LH,20000,NORMAL,,,0,45360,52606,14200,5800,71.00\n' +
      '2005,INPR,2000030123,HD785-01,HD785-7,10025,F000,HYDRAULIC SYSTEM,12000,NORMAL,,,0,45360,52606,8200,3800,68.33\n';
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'template-data-unit-lifetime.csv');
    toast('Template Data Unit & Lifetime diunduh.', 'ok');
  }

  /** Unduh template CSV Top-Up Oil SAP */
  function downloadTopupTemplate() {
    var csv = 'Site,Order,Equipment,Model,Material,Material Description,Movement Type,Compartment,Valuation Type,Quantity,Posting Date,Time,Base Unit,Amount,Currency,Created By,Purchase Order\n' +
      '2005,4915461090,HD785-01,HD785-7,A070134301,"OIL,TRANSLIK HD 10W,SAE 10W",TOU,ENGINE,,20.00,9/8/2026,16.00,L,29.18,USD,,1800215115\n' +
      '2005,4915461091,HD785-01,HD785-7,A070134302,"OIL,RORED HDA 80W-90",RPR,FINAL DRIVE,,15.00,9/15/2026,14.30,L,22.50,USD,,1800215116\n';
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'template-topup-oil-sap.csv');
    toast('Template Top-Up Oil SAP diunduh.', 'ok');
  }

  /** Unduh template CSV Threshold */
  function downloadThresholdTemplate() {
    if (global.VHMS_SETTINGS && global.VHMS_SETTINGS.exportThresholdsCsv) {
      global.VHMS_SETTINGS.exportThresholdsCsv();
    } else {
      toast('Fitur ekspor threshold belum siap.', 'err');
    }
  }

  function openTemplateModal() {
    var m = document.getElementById('template-download-modal');
    if (m) m.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeTemplateModal() {
    var m = document.getElementById('template-download-modal');
    if (m) m.classList.add('hidden');
    document.body.classList.remove('modal-open');
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
      // Filter chart — [REVISI 2026-10-03] Toggle SELURUH baris grup
      // (.chart-group-row) agar panel Predictive Diagnostic pasangannya
      // ikut tersembunyi bersama chart-nya.
      document.querySelectorAll('#charts-section .panel[data-chart]').forEach(function (panel) {
        var id = panel.getAttribute('data-chart');
        var show = !spec.charts || spec.charts.indexOf(id) !== -1;
        panel.classList.toggle('hidden', !show);
        // Untuk baris grup biasa (chart + diagnostik pasangannya), sembunyikan
        // SELURUH baris agar panel diagnostik tak menggantung sendirian.
        var row = panel.closest ? panel.closest('.chart-group-row') : null;
        if (row) row.classList.toggle('hidden', !show);
      });
      // [REVISI 2026-10-03] Baris pasangan (Productivity + Dozing): sembunyikan
      // hanya bila TIDAK ada chart di dalamnya yang lolos filter.
      document.querySelectorAll('#charts-section .chart-pair-row').forEach(function (row) {
        var anyVisible = Array.prototype.some.call(
          row.querySelectorAll('.panel[data-chart]'),
          function (p) { return !p.classList.contains('hidden'); }
        );
        row.classList.toggle('hidden', !anyVisible);
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
      if (render.stopBannerTimer) render.stopBannerTimer();
      // Tutup modal rekomendasi bila banner disembunyikan (pindah halaman)
      if (render.closeAnomalyModal) render.closeAnomalyModal();
    }
  }

  /* -----------------------------------------------------------------------
   * Kosongkan SEMUA data (VHMS + SOS + Unit DB + Lifetime + Top-Up) — konfirmasi lalu reset total.
   * --------------------------------------------------------------------- */
  function clearAllData() {
    var nVhms = fleet.count();
    var sos = global.SOS_STORE;
    var nSos = sos ? sos.count() : 0;
    var db = unitdb();
    var nDb = db ? db.count() : 0;

    if (nVhms === 0 && nSos === 0 && nDb === 0) {
      toast('Tidak ada data untuk dikosongkan.', 'info');
      return;
    }

    var msg = 'Hapus SEMUA data keseluruhan?\n\n' +
      '• VHMS: ' + nVhms + ' unit\n' +
      '• SOS: ' + nSos + ' sampel\n' +
      '• Data Unit & Lifetime: ' + nDb + ' unit\n' +
      '• Riwayat Top-Up Oil\n\n' +
      'Tindakan ini akan mengosongkan seluruh data dan tidak dapat dibatalkan.';
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

    // Hapus Database Unit
    if (db) db.clear();

    // Hapus Portfolio (Lifetime, TopUp, Section)
    if (global.PORTFOLIO_STORE) {
      try {
        if (global.PORTFOLIO_STORE.clearLifetime) global.PORTFOLIO_STORE.clearLifetime();
        if (global.PORTFOLIO_STORE.clearTopup) global.PORTFOLIO_STORE.clearTopup();
        if (global.PORTFOLIO_STORE.clearSection) global.PORTFOLIO_STORE.clearSection();
      } catch (e) {
        // [FIX AUDIT 2026-10-04 · F-3] Gagal mengosongkan = data lama masih ada
        // padahal pengguna diberi tahu "berhasil dikosongkan". Harus terlihat.
        if (global.console && console.warn) console.warn('[VHMS_APP] gagal mengosongkan data portofolio:', e && e.message);
      }
    }

    updateUnitDbStatus();
    if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) {
      try { global.PORTFOLIO_APP.refresh(); } catch (e) {}
    }

    toast('Seluruh data (VHMS, SOS, Data Unit, Lifetime & Top-Up) berhasil dikosongkan.', 'info');
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
    if (unitDbTpl) unitDbTpl.addEventListener('click', openTemplateModal);
    var tplModalClose = document.getElementById('template-modal-close');
    if (tplModalClose) tplModalClose.addEventListener('click', closeTemplateModal);
    var tplModal = document.getElementById('template-download-modal');
    if (tplModal) tplModal.addEventListener('click', function (e) { if (e.target === tplModal) closeTemplateModal(); });

    var dlUnitDb = document.getElementById('btn-dl-tpl-unitdb');
    if (dlUnitDb) dlUnitDb.addEventListener('click', function () { downloadDataUnitLifetimeTemplate(); closeTemplateModal(); });
    var dlTopup = document.getElementById('btn-dl-tpl-topup');
    if (dlTopup) dlTopup.addEventListener('click', function () { downloadTopupTemplate(); closeTemplateModal(); });
    var dlThreshold = document.getElementById('btn-dl-tpl-threshold');
    if (dlThreshold) dlThreshold.addEventListener('click', function () { downloadThresholdTemplate(); closeTemplateModal(); });

    // [UX 2026-10-03] Tombol "Hapus" per-panel dihapus; pembersihan terpusat
    // di tombol "Kosongkan" (clearAllData) agar tidak ada aksi parsial.
    updateUnitDbStatus();

    // Filter / pencarian / sortir tabel armada
    var fleetSearch = document.getElementById('fleet-search');
    if (fleetSearch) {
      var runFleetSearch = debounce(function () {
        render.setFleetState({ search: fleetSearch.value, page: 1 });
        render.renderFleetTable();
      }, 200);
      fleetSearch.addEventListener('input', runFleetSearch);
    }
    var fleetFilter = document.getElementById('fleet-filter');
    if (fleetFilter) {
      fleetFilter.addEventListener('change', function () {
        render.setFleetState({ filter: fleetFilter.value, page: 1 });
        render.renderFleetTable();
      });
    }

    // [POST-5 2026-10-03] Kontrol paginasi tabel Fleet VHMS.
    document.addEventListener('click', function (e) {
      var pg = e.target.closest('[data-fleet-page]');
      if (!pg || pg.disabled) return;
      var p = parseInt(pg.getAttribute('data-fleet-page'), 10);
      if (!p || p < 1) return;
      render.setFleetState({ page: p });
      render.renderFleetTable();
    });

    /* ---------------- [POIN 5] Filter cepat & penanda filter aktif ---------------- */
    var filterBar = document.getElementById('fleet-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        // Klik chip filter cepat
        var chip = e.target.closest('[data-quick-filter]');
        if (chip) {
          var val = chip.getAttribute('data-quick-filter');
          var newVal = (val === 'ALL') ? 'ALL' : val;
          render.setFleetState({ filter: newVal, page: 1 });
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
          render.setFleetState({ sortKey: 'severity', sortDir: 'desc', page: 1 });
          render.renderFleetTable();
          return;
        }
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setFleetState({ sortKey: k, sortDir: dir, page: 1 });
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
      var runCompSearch = debounce(function () {
        render.setCompState({ search: compSearch.value });
        if (state.ranked) render.renderComparison(state.ranked);
      }, 200);
      compSearch.addEventListener('input', runCompSearch);
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

    // Tombol cetak laporan.
    // [FITUR 2026-10-05] Header kini hanya punya tombol statis "Export Data"
    // (#btn-report-1, ditangani di index.html). Cetak laporan tetap tersedia
    // lewat dialog cetak browser (Ctrl+P); judul dokumen diatur otomatis oleh
    // listener `beforeprint` di index.html.
    // #btn-report (legacy, bila ada) tetap langsung mencetak.
    var bLegacy = document.getElementById('btn-report');
    if (bLegacy) bLegacy.addEventListener('click', exportReport);

    // Drag & drop di seluruh dokumen
    setupDragDrop();

    // Kontrol tabel
    var search = document.getElementById('table-search');
    if (search) {
      var runTableSearch = debounce(function () {
        if (!state.current) return;
        render.setTableState({ search: search.value });
        render.renderTable(state.current);
      }, 200);
      search.addEventListener('input', runTableSearch);
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
      try { if (fleet.reanalyzeAll) fleet.reanalyzeAll(); } catch (e) {
        // [FIX AUDIT 2026-10-04 · F-3] Gagal re-analisa = ambang lama dipakai
        // diam-diam (angka salah di layar). Wajib terlihat.
        if (global.console && console.warn) console.warn('[VHMS_APP] gagal re-analisa setelah restore:', e && e.message);
      }
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
    exportReport: exportReport,
    getVHMSReportFileName: getVHMSReportFileName,
    switchTab: switchTab,
    switchCompTab: switchCompTab,
    refreshCurrent: refreshCurrent,
    toast: toast,
    /** [FITUR 2026-10-05] Ekspor Equipment List (katalog VHMS) ke Excel (CSV). */
    exportFleetCsv: exportFleetCsv,
    buildFleetCsv: buildFleetCsv,
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

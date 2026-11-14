/* =========================================================================
 * fuel-app.js
 * -------------------------------------------------------------------------
 * [FUEL 2026-10-28] Orkestrasi halaman Fuel Trending. Modul **MANDIRI**.
 *
 * Alur: berkas -> FUEL_PARSER -> FUEL_ANALYTICS -> FUEL_RENDER + FUEL_STORE.
 *
 * ISOLASI (docs/DEV_FUEL_TRENDING_2026-10-28.md §1):
 *   - TIDAK PERNAH memanggil VHMS_FLEET / SOS_STORE / PORTFOLIO_STORE.
 *   - TIDAK PERNAH menulis kunci localStorage selain `fuel.store.v1`.
 *   - TIDAK memakai VHMS_ANALYTICS / VHMS_RANKING / VHMS_CONFIG.THRESHOLDS.
 *   - Membuka halaman ini hanya menyembunyikan area mode lain; TIDAK
 *     mereset/menghapus data mode tersebut.
 * ========================================================================= */

(function (global) {
  'use strict';

  var PARSER = global.FUEL_PARSER;
  var ANALYTICS = global.FUEL_ANALYTICS;
  var RENDER = global.FUEL_RENDER;
  var STORE = global.FUEL_STORE;

  function $id(id) { return (typeof document === 'undefined') ? null : document.getElementById(id); }
  function toggle(id, show) {
    var el = $id(id);
    if (el) el.classList.toggle('hidden', !show);
  }

  /* Area mode lain yang harus disembunyikan. Samakan dengan AREA_VHMS di
     js/portfolio-app.js + `sos-area` — TAPI jangan mengimpor daftar itu,
     karena portofolio adalah modul RBM. Duplikasi daftar di sini AMAN
     (daftar ID DOM, bukan logika); diawasi uji FUEL-ISO-4. */
  var OTHER_AREAS = ['welcome-area', 'fleet-area', 'dashboard-area', 'comparison-area',
    'cross-area', 'sos-area', 'portfolio-area', 'unitdb-panel'];

  var _state = {
    trendText: null, cycleText: null, dailyText: null,
    trendName: '', cycleName: '', dailyName: '',
    result: null, cycles: [], dailyDays: [], correlate: null,
    model: '', serial: '',
    // [2026-10-28] Nomor lambung unit terpilih + konteks pemetaan SN->lambung
    // (dibangun ulang tiap renderFleet; `null` = baca sumber global).
    lambung: '', lambungCtx: null,
    // [FLEET 2026-10-28] Daftar SEMUA unit ter-upload + unit yang dipilih.
    // `fleet` = {key,serial,model,source,updatedAt,result,cycles,correlate,
    //            dailyDays} atau baris error {result:null, reason}.
    fleet: [],
    selectedKey: null,
    // [HOME/DETAIL 2026-10-28] 'home' = KPI + daftar ratio; 'detail' = satu unit.
    view: 'home',
    filter: { text: '', verdict: '', model: '', sort: 'lTk', dir: 'desc' },
    // [BETWEEN 2026-10-29] Rentang pembanding. SENGAJA terpisah dari
    // `filter.dateStart/dateEnd`: filter tabel adalah SATU rentang, pembanding
    // butuh DUA. Dicampur akan membuat tabel dan panel pembanding melaporkan
    // periode berbeda tanpa terlihat oleh pembaca.
    compare: { aStart: '', aEnd: '', bStart: '', bEnd: '', page: 1 },
    // [F9 2026-10-29] Hasil panel Between yang TERAKHIR DIGAMBAR, dipakai
    // ekspor CSV supaya berkas selalu sama dengan layar. null bila panel
    // menolak menggambar (rentang belum lengkap).
    compareLast: null,
    // [F2 2026-10-29] Batas tanggal berdata untuk input pembanding:
    // { dataLast, today, maxDate }. Ditulis ulang setiap `renderCompare()`.
    limits: { dataLast: null, today: '', maxDate: '' },
    // [GPS 2026-10-30] Agregat GPS track (`FUEL_GPS.aggregate()`) untuk kolom
    // pendukung elevasi. `null` = belum diunggah — BUKAN nol meter.
    // `gpsInfo` = ringkasan unggahan terakhir untuk ditampilkan ke operator.
    gps: null, gpsInfo: null,
    // [SHARED 2026-10-28] true bila berkas berasal dari upload RBM.
    fromIngest: false
  };

  function toast(msg, kind) {
    if (global.VHMS_APP && typeof global.VHMS_APP.toast === 'function') {
      global.VHMS_APP.toast(msg, kind);
      return;
    }
    if (global.console) console.log('[FUEL] ' + msg);
  }

  /* -----------------------------------------------------------------------
   * Muat data — HANYA dari `FUEL_INGEST` (gerbang upload VHMS).
   *
   * [SATU GERBANG 2026-10-28] Halaman Fuel TIDAK punya dropzone/input berkas
   * lagi. Alasannya bukan sekadar UI: dropzone sendiri berarti daftar kolom
   * dan aturan klasifikasi berkas KEDUA yang harus dijaga selaras dengan
   * gerbang RBM. Satu sumber = satu aturan.
   * --------------------------------------------------------------------- */

  /** Dipakai uji: klasifikasi berkas kini milik parser (`roleOf`). */
  function roleOfText(text, name) {
    var head = String(text || '').slice(0, 4000);
    var m = /^\s*Data Type\s*&\s*Title\s*,(.*)$/im.exec(head);
    if (m) {
      var type = String(m[1].split(',')[0] || '').trim();
      return PARSER.roleOf(type);
    }
    var n = String(name || '').toLowerCase();
    if (/^pldcyc/.test(n)) return 'cycle';
    if (/^payload/.test(n)) return 'daily';
    if (/^trend/.test(n)) return 'trend';
    return 'other';
  }

  function setStatus() {
    var el = $id('fuel-file-status');
    if (!el) return;
    var fleet = _state.fleet || [];
    // [HATI-HATI] Unit dari STORE hanya membawa `summary` (bukan `result`).
    // Menghitung "bermasalah" dari `!u.result` membuat SEMUA unit tersimpan
    // tampil sebagai galat setelah muat ulang — padahal datanya sehat.
    // `u.reason` hanya ada pada baris yang BENAR-BENAR gagal.
    // `nUnits` tetap dihitung: ia menentukan apakah pesan "Belum ada data
    // Fuel…" masih jujur. Hanya CETAKANNYA yang dihapus.
    var nUnits = fleet.filter(function (u) { return u.result || u.summary; }).length;
    var nFail = fleet.filter(function (u) { return !u.result && !u.summary; }).length;
    // [REVISI 2026-10-28] "N unit dianalisis" TIDAK lagi dicetak di sini:
    // jumlah unit sudah dibaca di KPI Summary (home) dan daftar ratio. Yang
    // tetap ditampilkan hanya yang tidak muncul di tempat lain — unit
    // bermasalah dan unit yang sedang dibuka.
    var parts = [];
    if (nFail) {
      parts.push('<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> ' +
        '<strong>' + nFail + '</strong> unit bermasalah');
    }
    if (_state.selectedKey) {
      var sel = null;
      fleet.forEach(function (u) { if (u.key === _state.selectedKey) sel = u; });
      if (sel) {
        parts.push('Dibuka: <strong>' + esc(labelOf(sel.serial) || sel.key) + '</strong>' +
          (sel.model ? ' <span class="u-text-mute">' + esc(sel.model) + '</span>' : ''));
      }
    }
    el.innerHTML = parts.length
      ? parts.join(' &nbsp;&middot;&nbsp; ')
      : (nUnits
        ? ''
        : 'Belum ada data Fuel. Unggah folder unit di <strong>Equipment List</strong>.');
    // Baris status tanpa isi TIDAK boleh menyisakan ruang kosong di kartu.
    el.classList.toggle('hidden', !el.innerHTML);

    var hasAny = (fleet.length > 0) || !!(_state.trendText || _state.cycleText);

    // Petunjuk hanya muncul saat BELUM ada unit sama sekali — bukan saat ada
    // unit bermasalah (untuk itu tabel sudah menjelaskan sebabnya).
    var hint = $id('fuel-need-hint');
    if (hint) {
      if (!fleet.length) {
        hint.innerHTML = '<i class="fa-solid fa-circle-info"></i> Belum ada data. ' +
          'Unggah folder unit (berisi <code>trend0</code>, <code>pldcyc</code>, ' +
          '<code>payloadn</code>) di <strong>Equipment List</strong> — satu unggahan ' +
          'untuk RBM &amp; Fuel, boleh banyak unit sekaligus.';
        hint.classList.remove('hidden');
      } else {
        hint.innerHTML = '';
        hint.classList.add('hidden');
      }
    }
  }

  function esc(s) {
    var ui = global.UI_UTIL || {};
    if (ui.esc) return ui.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -----------------------------------------------------------------------
   * labelOf(serial) — SN -> Nomor Lambung untuk SEMUA teks yang dibaca operator.
   *
   * [2026-10-28] Sumber pemetaan TIDAK diduplikasi di sini: `RENDER.lambungOf`
   * membaca VHMS_UNITDB + data Lifetime (sumber yang sama dengan modul lain).
   * Bila tidak terpetakan -> kembalikan SN apa adanya (jangan mengarang).
   * -------------------------------------------------------------------- */
  function labelOf(serial) {
    if (!serial) return '';
    if (RENDER && typeof RENDER.lambungOf === 'function') {
      try {
        var lb = RENDER.lambungOf(serial, _state.lambungCtx || null);
        if (lb && lb.lambung) return lb.lambung;
      } catch (e) { /* jatuh ke SN */ }
    }
    return serial;
  }

  /**
   * analyzeUnit(trendText, cycleText) — analisis SATU unit.
   * MURNI terhadap state global: mengembalikan { ok, res, cycles, model,
   * serial, error } sehingga bisa dipakai untuk banyak unit sekaligus.
   */
  function analyzeUnit(trendText, cycleText, preCycles, preTrend) {
    var out = { ok: false, res: null, cycles: [], model: '', serial: '', error: '' };
    if (!PARSER || !ANALYTICS) { out.error = 'Modul Fuel tidak termuat.'; return out; }
    var tp = PARSER.parse(trendText || '');
    var cp = PARSER.parse(cycleText || '');
    out.model = String(tp.meta['Machine Model'] || '');
    out.serial = String(tp.meta['Machine Serial No.'] || '');

    function col(p, name) {
      var i = PARSER.colIndex(p.items, name);
      if (i < 0) return null;
      return p.rows.map(function (r) { return r[i]; });
    }
    var trend;
    if (preTrend && preTrend.length) {
      // [RESET 2026-10-29] Deret GABUNGAN dari beberapa berkas trend0 (lihat
      // `FUEL_INGEST.accept`: digabung per EPOCH, bukan per SMR). `trendText`
      // hanya memuat berkas TERAKHIR; memakainya saja membuang seluruh rentang
      // berkas pra-reset tanpa pesan — kelas bug yang sama persis dengan
      // `preCycles` di bawah.
      trend = { smr: [], fuelRate: [], epoch: [], tz: [] };
      preTrend.forEach(function (p) {
        trend.smr.push(p.smr);
        trend.fuelRate.push(p.fuelRate);
        trend.epoch.push(p.epoch);
        trend.tz.push(p.tz);
      });
      if (!trend.smr.length) {
        out.error = 'Berkas trend tidak punya satu pun record dengan Calendar.';
        return out;
      }
    } else {
      var smr = col(tp, 'SMR'), fuelRate = col(tp, 'Fuel Rate');
      if (!smr || !fuelRate) {
        out.error = 'Berkas trend tidak punya kolom "SMR" / "Fuel Rate".';
        return out;
      }
      trend = {
        smr: smr,
        fuelRate: fuelRate,
        epoch: (tp.calendars || []).map(function (c) { return c ? c.epoch : null; }),
        tz: (tp.calendars || []).map(function (c) { return c ? c.tz : 0; })
      };
    }
    // [SHARED 2026-10-28] Ekstraksi siklus memakai fungsi BERSAMA dengan
    // jalur upload RBM (`FUEL_PARSER.cyclesFromTable`) — satu aturan kolom.
    //
    // [FIX 2026-10-28] `preCycles` = siklus yang SUDAH digabung oleh ingest
    // dari BEBERAPA berkas pldcyc milik unit yang sama (PLM lama + PLM23).
    // `cycleText` hanya memuat berkas TERAKHIR; memakainya saja membuang
    // rentang tanggal berkas lain tanpa pesan.
    var cy = PARSER.cyclesFromTable(cp, { tz: true });
    if (preCycles && preCycles.length) {
      cy = { ok: true, cycles: preCycles, missing: [] };
    } else if (!cy.ok) {
      out.error = 'Berkas payload tidak memuat siklus valid.' +
        (cy.missing.length ? ' Kolom kurang: ' + cy.missing.join(', ') : '');
      return out;
    }
    out.cycles = cy.cycles;

    // Fuel Rate dan payload hanya boleh dipasangkan bila periode waktunya
    // beririsan. Tanpa gerbang ini, pasangan berkas beda periode tetap masuk
    // analisis lalu semua jendela gugur sebagai "no-valid-cycles" — pesan
    // yang tidak menjelaskan bahwa operator memilih trend0 yang salah.
    var trendEpochs = (trend.epoch || []).filter(function (v) {
      return typeof v === 'number' && isFinite(v);
    });
    var cycleEpochs = cy.cycles.map(function (c) { return c && c.t; }).filter(function (v) {
      return typeof v === 'number' && isFinite(v);
    });
    if (trendEpochs.length && cycleEpochs.length) {
      var trendStart = Math.min.apply(null, trendEpochs);
      var trendEnd = Math.max.apply(null, trendEpochs);
      var cycleStart = Math.min.apply(null, cycleEpochs);
      var cycleEnd = Math.max.apply(null, cycleEpochs);
      if (trendEnd < cycleStart || cycleEnd < trendStart) {
        function dateText(epoch) {
          return new Date(epoch * 1000).toISOString().slice(0, 10);
        }
        out.error = 'Rentang data trend0 (' + dateText(trendStart) + ' s/d ' + dateText(trendEnd) +
          ') tidak beririsan dengan pldcyc (' + dateText(cycleStart) + ' s/d ' + dateText(cycleEnd) +
          '). Unggah pasangan trend0 dan pldcyc dari periode/unit yang sama.';
        return out;
      }
    }
    out.res = ANALYTICS.analyze({ model: out.model, trend: trend, cycles: cy.cycles });
    out.ok = true;
    return out;
  }

  /**
   * analyzeTexts() — KOMPATIBILITAS: analisis unit yang sedang dipilih.
   * Memakai `analyzeUnit` supaya aturan kolom tidak pernah bercabang.
   */
  function analyzeTexts() {
    var a = analyzeUnit(_state.trendText, _state.cycleText);
    if (!a.ok) {
      toast(a.error, 'err');
      return null;
    }
    _state.model = a.model;
    _state.serial = a.serial;
    _state.cycles = a.cycles;
    _state.result = a.res;
    return a.res;
  }

  /* -----------------------------------------------------------------------
   * FLEET — proses BANYAK unit sekaligus (permintaan user 2026-10-28).
   *
   * Satu upload folder -> ingest mengelompokkan berkas per Serial No. ->
   * di sini tiap unit dianalisis, disimpan ke store (per SN), lalu
   * ditampilkan di tabel "Trending Fuel Ratio List".
   *
   * Unit yang GAGAL dianalisis TETAP dicatat (report.errors) dan ikut
   * tampil sebagai baris "tanpa data" — TIDAK boleh hilang diam-diam.
   * --------------------------------------------------------------------- */
  function processUnits(ingestUnits, opts) {
    opts = opts || {};
    var report = { processed: 0, added: 0, replaced: 0, errors: [] };
    var now = Date.now();
    var fleet = _state.fleet || [];

    (ingestUnits || []).forEach(function (u, idx) {
      var label = u.serial || u.model || ('unit-' + (idx + 1));
      if (!u.trend || !u.cycle) {
        var need = [];
        if (!u.trend) need.push('trend0');
        if (!u.cycle) need.push('pldcyc');
        report.errors.push({
          key: u.key || ('E:' + label), serial: u.serial || '', model: u.model || '',
          source: (u.names && u.names[0]) || '', updatedAt: now,
          result: null, correlate: null, dailyDays: [],
          reason: 'Berkas kurang: ' + need.join(' + ')
        });
        return;
      }
      // [RESET 2026-10-29] `u.trend.series` = deret GABUNGAN semua berkas
      // trend0 unit ini (pra-reset + pasca-reset), sudah urut waktu dan
      // bebas duplikat. Meneruskan `u.trend.text` saja akan membuang seluruh
      // rentang berkas yang masuk lebih dulu.
      var a = analyzeUnit(u.trend.text, u.cycle.text, u.cycle.cycles, u.trend.series);
      if (!a.ok) {
        report.errors.push({
          key: u.key || ('E:' + label), serial: u.serial || a.serial || '', model: u.model || a.model || '',
          source: u.trend.name || '', updatedAt: now,
          result: null, correlate: null, dailyDays: [],
          reason: a.error
        });
        return;
      }
      report.processed++;

      // Serial dari BLOK TREND diutamakan: itulah kunci yang dipakai ingest
      // untuk mengelompokkan berkas, jadi store harus memakai kunci sama.
      var serial = u.serial || a.serial || '';
      var model = u.model || a.model || '';
      var meta = { serial: serial, model: model, name: u.trend.name || '' };
      var key = (STORE && STORE.keyOf) ? STORE.keyOf(meta, a.res)
        : (serial ? 'S:' + serial : 'K:' + label);

      // [REVISI 2026-10-28] Tandai apakah deret HARIAN (payloadn/A0) ada saat
      // unit disimpan. HARUS di-set SEBELUM `setUnit()` karena di sanalah
      // `compact()` dipanggil — kalau sesudah, flag tidak pernah ikut
      // tersimpan dan pesan "korelasi harian kosong" jadi salah sasaran.
      // payloadn hanya fallback. Pada tanggal yang sama, pldcyc menjadi
      // sumber utama agar dua berkas tidak saling menimpa secara acak.
      var dailyDays = PARSER.mergeDailyDays
        ? PARSER.mergeDailyDays((u.daily && u.daily.days) || [], a.cycles)
        : ((u.daily && u.daily.days) || []);
      a.res.dailyLoaded = dailyDays.length > 0;

      if (STORE && STORE.setUnit) {
        var w = STORE.setUnit(meta, a.res);
        if (!w.ok) {
          report.errors.push({
            key: key, serial: serial, model: model, source: u.trend.name || '',
            updatedAt: now, result: null, correlate: null, dailyDays: [],
            reason: w.reason === 'quota' ? 'Penyimpanan browser penuh'
              : (w.reason === 'max-units' ? 'Batas unit tersimpan tercapai' : 'Gagal menyimpan')
          });
          return;
        }
      }
      var existing = null;
      fleet.forEach(function (f) { if (f.key === key) existing = f; });
      var entry = {
        key: key, serial: serial, model: model,
        source: u.trend.name || '', updatedAt: now,
        result: a.res, cycles: a.cycles,
        dailyDays: dailyDays, correlate: buildCorrelation(a.res, dailyDays)
      };
      if (existing) {
        report.replaced++;
        Object.keys(entry).forEach(function (k) { existing[k] = entry[k]; });
      } else {
        report.added++;
        fleet.push(entry);
      }

      // Unit PERTAMA otomatis dibuka supaya operator langsung melihat detail.
      // [HOME/DETAIL 2026-10-28] Kecuali saat `silentDetail` (muat ulang/ingest
      // massal): halaman HARUS berhenti di home — KPI + daftar — bukan
      // melompat ke detail unit pertama.
      if (!_state.selectedKey && !opts.silentDetail) selectUnit(key, { noScroll: true });
    });

    // Baris bermasalah digabung ke daftar fleet, tapi TIDAK ditimpa bila
    // unit yang sama berhasil dianalisis pada berkas lain.
    report.errors.forEach(function (e) {
      var dup = null;
      fleet.forEach(function (f) { if (f.key === e.key && f.result) dup = f; });
      if (dup) return;
      var old = null;
      fleet.forEach(function (f) { if (f.key === e.key) old = f; });
      if (old) { Object.keys(e).forEach(function (k) { old[k] = e[k]; }); }
      else { fleet.push(e); }
    });

    _state.fleet = fleet;
    return report;
  }

  /* -----------------------------------------------------------------------
   * HOME vs DETAIL (permintaan user 2026-10-28)
   *
   *   HOME   = KPI Summary + tabel "Trending Fuel Ratio List".
   *   DETAIL = panel unit (baseline, waterfall, chart, korelasi, tabel jendela,
   *            overload, data yang tidak dipakai).
   *
   * Tabel "Trending Fuel Ratio List" SENGAJA DISEMBUNYIKAN di detail: di sana
   * operator sedang membaca SATU unit, dan daftar 8+ unit di atasnya hanya
   * menambah gulir + risiko salah baca baris ("unit mana yang sedang
   * dibuka?"). Sebaliknya di home tidak ada satu pun panel unit, sehingga
   * KPI + daftar adalah satu-satunya isi halaman.
   *
   * `_state.view` disimpan di state supaya render ulang (filter, hapus unit)
   * tidak mengembalikan tabel ke layar saat operator sedang di detail.
   * --------------------------------------------------------------------- */

  /** Panel yang HANYA relevan untuk satu unit (disembunyikan di home). */
  var DETAIL_PANELS = ['fuel-summary-panel', 'fuel-waterfall-panel', 'fuel-chart-panel',
    'fuel-corr-panel', 'fuel-table-panel', 'fuel-overload-panel', 'fuel-dropped-panel'];

  function currentView() {
    return _state.view === 'detail' ? 'detail' : 'home';
  }

  /**
   * setView(view) — tampilkan home ATAU detail. TIDAK membuang data.
   * 'detail' tanpa unit terbuka tidak bermakna -> tetap home.
   */
  function setView(view, opts) {
    opts = opts || {};
    var v = (view === 'detail') ? 'detail' : 'home';
    if (v === 'detail' && !_state.selectedKey) v = 'home';
    _state.view = v;

    toggle('fuel-home-panel', v === 'home');
    toggle('fuel-detail-panel', v === 'detail');

    var listPanel = $id('fuel-ratio-panel');
    if (listPanel) listPanel.style.display = (v === 'detail') ? 'none' : '';

    if (RENDER) {
      if (v === 'home') {
        // Panel satu-unit dibersihkan agar chart unit lama tidak "hantu" di
        // belakang layar (dan chart lama dilepas oleh `clearAll`).
        DETAIL_PANELS.forEach(function (id) { toggle(id, false); });
        if (typeof RENDER.disposeCharts === 'function') RENDER.disposeCharts();
        else if (RENDER.clearAll) RENDER.clearAll();
      } else {
        DETAIL_PANELS.forEach(function (id) {
          // Panel tetap dikelola renderer (display:'' atau 'none'); di sini
          // hanya memastikan kelas `hidden` tidak menyembunyikannya.
          var el = $id(id);
          if (el) el.classList.remove('hidden');
        });
        // Panel diisi ulang oleh selectUnit/render — jangan tampilkan panel
        // yang isinya belum ada (mis. korelasi harian tanpa berkas payloadn).
        if (RENDER.clearAll && opts.clear) RENDER.clearAll();
      }
    }

    // Tombol "Kembali" = kembali ke DAFTAR di halaman yang sama (bukan
    // menutup modul); dari home baru menutup modul. Sebelumnya satu tombol
    // langsung menutup modul, sehingga dari detail tidak ada jalan ke daftar
    // selain membuka menu Fuel lagi.
    var back = $id('btn-fuel-back');
    if (back) {
      back.innerHTML = (v === 'detail')
        ? '<i class="fa-solid fa-arrow-left"></i> Kembali ke daftar'
        : '<i class="fa-solid fa-arrow-left"></i> Kembali';
      back.title = (v === 'detail')
        ? 'Kembali ke KPI & daftar unit (data tetap tersimpan)'
        : 'Tutup halaman Fuel Trending';
    }
    var sub = $id('fuel-sub');
    if (sub) {
      sub.innerHTML = (v === 'detail')
        ? 'Detail <strong>satu unit</strong>. Angka di sini TIDAK sebanding antar unit dengan ' +
          'rute/jarak berbeda — lihat batasan di atas.'
        : 'Konsumsi bahan bakar per ton-km dari telemetri (Fuel Rate) &times; payload per siklus. ' +
          '<strong>Modul mandiri</strong> — tidak mempengaruhi analisis RBM.';
    }
    if (!opts.noScroll) { try { window.scrollTo(0, 0); } catch (e) { /* ok */ } }
  }

  /**
   * goHome() — tutup detail dan kembali ke KPI + daftar. Data TIDAK dihapus,
   * hanya pilihan unit yang dilepas (supaya baris aktif tidak "menggantung").
   */
  function goHome() {
    _state.selectedKey = null;
    _state.result = null; _state.cycles = []; _state.correlate = null;
    setView('home');
    renderFleet();
    setStatus();
  }

  /** Pilih unit untuk panel detail (kartu, waterfall, chart, tabel jendela). */
  function selectUnit(key, opts) {
    opts = opts || {};
    var fleet = _state.fleet || [];
    var u = null;
    fleet.forEach(function (f) { if (f.key === key) u = f; });
    _state.selectedKey = key;
    if (!u || !u.result) {
      // Unit tanpa hasil: kosongkan detail + jelaskan. Meninggalkan chart
      // unit sebelumnya akan membuat operator membaca unit yang salah.
      _state.result = null; _state.cycles = []; _state.correlate = null;
      if (RENDER) RENDER.clearAll();
      // Tidak ada yang bisa dibuka -> kembali ke daftar (home).
      _state.selectedKey = null;
      setView('home');
      renderFleet();
      setStatus();
      // SATU pesan saja, dan sebut sebabnya. Toast per unit saat memuat
      // 10 unit akan menumpuk di pojok layar dan menutupi tabel.
      if (!opts.silent) {
        toast((u && u.serial ? 'Unit ' + (labelOf(u.serial) || u.serial) : 'Unit ini') + ': ' +
          ((u && u.reason) || 'belum punya hasil analisis'), 'err');
      }
      return false;
    }
    _state.serial = u.serial || '';
    // Nomor lambung = label unit yang dibaca operator (SN tetap disimpan
    // untuk penelusuran berkas telemetri).
    _state.lambung = labelOf(u.serial);
    _state.model = u.model || '';
    _state.result = u.result;
    _state.cycles = u.cycles || [];
    // Unit dari store tidak punya deret harian -> tidak ada korelasi.
    // `buildCorrelation` sudah menahan diri saat `dailyDays` kosong.
    _state.correlate = u.correlate || buildCorrelation(u.result, u.dailyDays || []);
    // Panel detail dilepas dulu agar chart lama tidak menumpuk dengan chart
    // unit baru (Chart.js menolak canvas yang masih terikat instance).
    if (RENDER && RENDER.clearAll) RENDER.clearAll();
    setStatus();
    // [HOME/DETAIL 2026-10-28] Buka panel detail: daftar unit disembunyikan.
    setView('detail', { noScroll: true });
    if (RENDER) RENDER.render(_state.result, _state.cycles, _state.correlate);
    renderFleet();
    setStatus();
    if (!opts.noScroll) {
      var t = $id('fuel-detail-panel') || $id('fuel-table-panel');
      if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'start' }); } catch (e) { /* ok */ } }
    }
    return true;
  }

  function run() {
    try {
      var res = analyzeTexts();
      if (!res) return;
      _state.correlate = buildCorrelation(res);
      RENDER.render(res, _state.cycles, _state.correlate);
      if (STORE) STORE.setResult(res);   // ringkasan saja; kunci fuel.*
    } catch (e) {
      toast('Gagal menganalisis: ' + (e && e.message ? e.message : e), 'err');
      if (global.console) console.error('[FUEL_APP]', e);
    }
  }

  /* -----------------------------------------------------------------------
   * Baca data dari `FUEL_INGEST` (satu-satunya jalur masuk).
   * --------------------------------------------------------------------- */
  function loadFromIngest() {
    var ing = global.FUEL_INGEST;
    if (!ing || typeof ing.take !== 'function' || !ing.has()) return false;
    var snap = ing.take();
    var units = snap.units || [];
    // Ingest massal = operator ingin MELIHAT DAFTAR dulu (KPI + ratio),
    // bukan langsung masuk ke satu unit.
    var report = processUnits(units, { silentDetail: true });
    _state.fromIngest = true;
    // [FASE 1] Tulis ke IndexedDB asinkron: laporkan kegagalan yang tertunda
    // setelah rantai tulis selesai, bukan sesudah `setUnit()` kembali.
    if (STORE && typeof STORE.flush === 'function') {
      STORE.flush().then(reportWriteError, reportWriteError);
    }
    // Kompatibilitas field lama (dipakai setStatus).
    var first = units[0];
    if (first) {
      _state.trendName = (first.trend && first.trend.name) || '';
      _state.cycleName = (first.cycle && first.cycle.name) || '';
      _state.dailyName = (first.daily && first.daily.name) || '';
    }
    renderFleet();
    if (report.processed) {
      toast(report.processed + ' unit dianalisis' +
        (report.added ? ' · ' + report.added + ' baru' : '') +
        (report.replaced ? ' · ' + report.replaced + ' diperbarui' : '') +
        (report.errors.length ? ' · ' + report.errors.length + ' bermasalah' : ''), 'ok');
    } else if (report.errors.length) {
      toast(report.errors.length + ' unit tidak dapat dianalisis — lihat tabel.', 'err');
    }
    return report.processed > 0;
  }

  /** Kosongkan data hasil analisis (TIDAK menyentuh berkas yang diunggah RBM). */
  function clearFiles() {
    _state.trendText = null; _state.cycleText = null; _state.dailyText = null;
    _state.trendName = ''; _state.cycleName = ''; _state.dailyName = '';
    _state.result = null; _state.cycles = []; _state.dailyDays = []; _state.correlate = null;
    _state.fleet = []; _state.selectedKey = null;
    _state.fromIngest = false;
    setView('home', { noScroll: true });   // tanpa unit -> tidak ada detail
    setStatus();
    if (RENDER) RENDER.clearAll();
    renderFleet();
  }

  /* -----------------------------------------------------------------------
   * renderFleet() — KPI SUMMARY + daftar "Trending Fuel Ratio List" (home).
   * Logika baris/filter/urutan/KPI ada di FUEL_RENDER (murni, teruji).
   *
   * Panel daftar TIDAK dipaksa tampil saat detail terbuka — dulu setiap
   * render (filter, hapus unit) memaksa `display:''` sehingga tabel muncul
   * kembali di halaman detail.
   * --------------------------------------------------------------------- */
  /* -----------------------------------------------------------------------
   * renderHomeKpi() — KPI Summary halaman home.
   *
   * Isi (dari FUEL_RENDER.kpiSummary, murni):
   *   rasio fleet tertimbang · jumlah unit · jendela · Normal/Caution/Over ·
   *   unit tertinggi & terendah · unit perlu perhatian · unit tanpa angka.
   *
   * Jujur soal batas: perbandingan antar unit TIDAK sebanding bila rute
   * berbeda. Peringatan itulah yang membuat angka "tertinggi/terendah"
   * tidak dibaca sebagai vonis.
   * --------------------------------------------------------------------- */
  function kpiCard(label, value, unit, note, cls) {
    return '<div class="fuel-kpi-card' + (cls ? ' ' + cls : '') + '">' +
      '<div class="fuel-kpi-card-label">' + esc(label) + '</div>' +
      '<div class="fuel-kpi-card-value">' + esc(value) +
        (unit ? ' <small>' + esc(unit) + '</small>' : '') + '</div>' +
      (note ? '<div class="fuel-kpi-card-note">' + note + '</div>' : '') +
      '</div>';
  }

  /**
   * renderHomeKpi(rows, filter) — KPI dari BARIS YANG SEDANG DITAMPILKAN.
   *
   * [RENTANG 2026-10-28] Dulu menerima armada penuh, sehingga kartu KPI tidak
   * berubah saat filter tanggal/model dipakai — angka di kartu dan angka di
   * tabel bertentangan di layar yang sama.
   */
  function renderHomeKpi(rows, filter) {
    var host = $id('fuel-kpi');
    if (!host || !RENDER || typeof RENDER.kpiSummaryFromRows !== 'function') return;
    if (!_state.lambungCtx && RENDER.lambungContext) _state.lambungCtx = RENDER.lambungContext();
    var k = RENDER.kpiSummaryFromRows(rows || []);
    var fr = filter || {};
    if (!k.units) {
      host.innerHTML = '<p class="u-text-mute" style="font-size:12px;margin:0">' +
        ((fr.dateStart || fr.dateEnd)
          ? 'Tidak ada data pada rentang tanggal yang dipilih.'
          : 'Belum ada unit untuk diringkas.') + '</p>';
      return;
    }
    var N = RENDER._num;
    var cards = [];

    // [REVISI 2026-10-28] SISI OPERATOR: kartu KPI cukup memuat ANGKA +
    // SATUAN. Nama unit / daftar unit / catatan panjang dihapus — rincian
    // per unit sudah ada di tabel "Trending Fuel Ratio List" di bawahnya,
    // jadi mengulangnya di sini hanya membuat kartu padat dan tidak terbaca.
    // Label memakai istilah statistik yang umum agar konsisten dengan
    // tabel/ekspor: Mean tertimbang, N unit, N jendela, Maks, Min, Unit flag.

    // 1. Rata-rata TERTIMBANG jumlah jendela (bukan rata-rata dari rata-rata).
    cards.push(kpiCard('Mean L/TKM (tertimbang)',
      k.lTkWeighted == null ? '\u2014' : N(k.lTkWeighted, 4), 'L/ton-km', '', 'is-accent'));

    // 2. N = jumlah unit (unit tanpa angka tetap dihitung, lihat disklaimer).
    cards.push(kpiCard('Total unit',
      String(k.units), 'unit', ''));

    // 3. N jendela ber-verdict (Normal + Caution + Over).
    cards.push(kpiCard('TOTAL DATA',
      String(k.counts.NORMAL + k.counts.CAUTION + k.counts.OVER), 'Baris Data | Semua Unit', ''));
    // 4-5. Maks / Min rasio — hanya angka. Hanya bila ada pembanding.
    if (k.comparable) {
      cards.push(kpiCard('Maks L/TKM', N(k.worst.lTk, 4), 'L/ton-km', '', 'is-warn'));
      cards.push(kpiCard('Min L/TKM', N(k.best.lTk, 4), 'L/ton-km', '', 'is-ok'));
    } else {
      cards.push(kpiCard('Maks / Min L/TKM', '\u2014', '', 'butuh \u2265 2 unit'));
    }

    // 6. Unit yang punya minimal satu jendela Caution/Over.
    cards.push(kpiCard('Unit flag', String(k.nAttention), 'unit', '',
      k.nAttention ? 'is-warn' : ''));

    // Basis angka DISEBUT bila rentang aktif: pembaca harus tahu kartu ini
    // bukan angka seluruh berkas, dan tahu bahwa tonase/siklus pada rentang
    // diturunkan dari jendela valid (siklus mentah pldcyc tidak tersimpan).
    var scopeNote = '';
    if (fr.dateStart || fr.dateEnd) {
      // Peringatan basis hanya muncul bila MEMANG ADA unit yang terpaksa
      // memakai cadangan jendela. Menampilkannya selalu (termasuk saat semua
      // unit sudah punya rekap siklus harian) membuat catatan ini diabaikan.
      var nWin = (rows || []).filter(function (r) { return r.cycleBasis === 'window'; }).length;
      scopeNote = '<p class="fuel-kpi-disclaimer">' +
        '<i class="fa-solid fa-calendar-day"></i> ' +
        'Semua angka dihitung untuk rentang <strong>' +
        esc(fr.dateStart || 'awal data') + '</strong> s/d <strong>' +
        esc(fr.dateEnd || 'akhir data') + '</strong>.' +
        (nWin
          ? ' <strong>' + nWin + ' unit</strong> ditandai <strong>*</strong>: tersimpan ' +
            'sebelum rekap siklus harian ada, sehingga Total Cycle &amp; Total Tonnage-nya ' +
            'hanya bisa dipotong lewat <strong>jendela valid</strong> — lebih kecil dari ' +
            'angka seluruh berkas. Unggah ulang unit itu untuk basis penuh.'
          : '') +
        '</p>';
    }

    var body = '<div class="fuel-kpi-cards">' + cards.join('') + '</div>' + scopeNote +
      '<p class="fuel-kpi-disclaimer">' +
      '<i class="fa-solid fa-triangle-exclamation"></i> ' +
      'Angka Maks/Min dan Mean L/TKM <strong>hanya untuk pemantauan</strong> | ' +
      'Rute, Jarak, dan Grade yang berbeda membuat rasio antar unit tidak sebanding. ' +
      'Data Valid hanya untuk <strong>satu unit dibanding riwayatnya sendiri</strong>.' +
      '</p>';

    // Catatan tunggu: baseline armada belum ada (semua unit tanpa angka).
    if (!k.withBaseline) {
      body = '<div class="alert-banner" role="note" style="margin-bottom:10px">' +
        '<i class="fa-solid fa-hourglass-half"></i> Baseline armada belum terbentuk — ' +
        'belum ada unit dengan sampel cukup. Rasio ditampilkan sebagai \u201c\u2014\u201d, ' +
        'bukan nol.</div>' + body;
    }
    host.innerHTML = body;
  }

  function renderFleet() {
    if (!RENDER || typeof RENDER.ratioRows !== 'function') return;
    var panel = $id('fuel-ratio-panel');
    if (!panel) return;
    var fleet = _state.fleet || [];
    var view = currentView();
    if (!fleet.length) { panel.style.display = 'none'; }
    else { panel.style.display = (view === 'detail') ? 'none' : ''; }
    if (view === 'detail') return;   // detail tidak memuat daftar

    // Peta SN -> Nomor Lambung dibangun SEKALI per render (VHMS_UNITDB +
    // Lifetime), lalu dipakai baris tabel dan label di tempat lain.
    // SELALU dibangun ulang: pengguna bisa mengunggah Data Unit/Lifetime
    // kapan saja, dan peta lama akan membuat nomor lambung basi.
    if (RENDER && typeof RENDER.lambungContext === 'function') {
      _state.lambungCtx = RENDER.lambungContext();
    }
    var f = _state.filter || {};
    // [RENTANG 2026-10-28] Rentang tanggal diteruskan ke `ratioRows` supaya
    // SELURUH angka baris (SMR, jam operasi, tonase, siklus, L/ton-km, jumlah
    // jendela, status) dihitung dari jendela/record di dalam rentang itu.
    // Sebelumnya tanggal hanya menyembunyikan baris: memilih satu bulan tetap
    // menampilkan tonase dua tahun.
    var range = { dateStart: f.dateStart || '', dateEnd: f.dateEnd || '' };
    var allRows = RENDER.ratioRows(fleet, _state.lambungCtx, range);
    var rows = RENDER.filterRatioRows(allRows, f);
    // Ringkasan HARUS dari baris yang sedang dilihat. Memakai armada penuh
    // membuat kartu KPI dan tabel di bawahnya melaporkan dua angka berbeda.
    var totals = RENDER.fleetTotalsFromRows
      ? RENDER.fleetTotalsFromRows(rows)
      : RENDER.fleetTotals(fleet);
    // Maksimal 10 unit per halaman agar tabel tetap terbaca tanpa scroll
    // vertikal berlebihan. Aritmetikanya ada di `RENDER.pageSlice` (murni,
    // teruji) — JANGAN dihitung ulang di sini: dua salinan rumus halaman
    // adalah cara lama dua bug penjepitan masuk tanpa terdeteksi.
    var PAGE_SIZE = 10;
    var pg = RENDER.pageSlice(rows, f.page, PAGE_SIZE);
    var pageSize = pg.size;
    var pageCount = pg.pageCount;
    f.page = pg.page;
    var page = pg.rows;

    // ---- KPI Summary (home) ----
    renderHomeKpi(rows, f);

    // ---- status ringkas: dipertahankan di kanan filter ------------------
    // Unit/baseline/jendela/L-TKM dihapus karena redundan dengan KPI Summary;
    // Normal/Caution/Over tetap dipertahankan sesuai instruksi operator.
    var sumEl = $id('fuel-fleet-summary');
    if (sumEl) {
      sumEl.innerHTML =
        '<span class="fuel-kpi"><em>Normal</em> <strong>' + esc(String(totals.counts.NORMAL)) + '</strong></span>' +
        '<span class="fuel-kpi"><em>Caution</em> <strong>' + esc(String(totals.counts.CAUTION)) + '</strong></span>' +
        '<span class="fuel-kpi"><em>Over</em> <strong>' + esc(String(totals.counts.OVER)) + '</strong></span>';
      sumEl.classList.remove('hidden');
    }

    // ---- isi tabel ----
    var head = $id('fuel-ratio-head'), body = $id('fuel-ratio-body');    if (head) {
      // [REVISI 2026-10-28] Urutan kolom mengikuti permintaan operator:
      // No. Lambung · Model · Status · SMR Awal · SMR Akhir · Total Operation ·
      // Total Tonnage · Total Cycle ·
      // L/ton-km · L/GTKM · GTKM/TKM · Jendela · Over % · Event ·
      // Fuel Rate · Proyeksi Total Fuel · Diperbarui · Action.
      // SMR/Operation/Fuel Rate diambil dari berkas trend0 (diformulasikan di
      // FUEL_ANALYTICS: `trendExtent` & `meanFuelRate`).
      var COLS = [
        ['lambung', 'No. Lambung', 'left'], ['model', 'Model', 'left'],
        ['verdict', 'Status', 'left'],
        ['smrStart', 'SMR Awal', 'right'],
        ['smrEnd', 'SMR Akhir', 'right'],
        ['totalHours', 'Total Operation', 'right'],
        ['totalCycle', 'Total Tonnage', 'right'],
        ['cycleCount', 'Total Cycle', 'right'],
        ['lTk', 'L/ton-km', 'right'], ['lGt', 'L/GTKM', 'right'],
        // [2026-10-29] "Jendela" sendirian ambigu: isinya N baris data valid
        // DAN cakupan harinya. Judulnya menyebut keduanya.
        ['penalty', 'GTKM/TKM', 'right'], ['eligible', 'Baris / Hari', 'right'],
        ['overPct', 'Over %', 'right'], ['event', 'Event', 'left'],
        ['fuelRateAvg', 'Fuel Rate', 'right'],
        ['projFuel', 'Proyeksi Total Fuel', 'right'],
        // [2026-10-29] "Diperbarui" (tanggal unggah) diganti RENTANG DATA:
        // tanggal awal/akhir data yang BENAR-BENAR dipakai baris ini. Tanggal
        // unggah tidak menjelaskan periode angka yang sedang dibaca.
        ['dateStart', 'Rentang Data', 'left'], ['act', 'Action', 'center']
      ];
      head.innerHTML = '<tr>' + COLS.map(function (c) {
        var active = (f.sort === c[0]);
        var arrow = active ? (f.dir === 'desc' ? ' \u25BC' : ' \u25B2') : '';
        if (c[0] === 'act') {
          return '<th scope="col" style="text-align:center">' + esc(c[1]) + '</th>';
        }
        // `event` TIDAK sortable: ia observasi teks, bukan satu angka.
        if (c[0] === 'event') {
          return '<th scope="col" style="text-align:left;font-weight:600">' + esc(c[1]) + '</th>';
        }
        return '<th scope="col" style="text-align:' + c[2] + ';cursor:pointer" ' +
          'data-fuel-sort="' + c[0] + '">' + esc(c[1]) + arrow + '</th>';
      }).join('') + '</tr>';
    }

    if (body) {
      if (!rows.length) {
        // [FIX 2026-10-30] `colspan` tabel UTAMA = 18 (jumlah `COLS`), bukan
        // 16 — pesan "tidak ada unit" menyempit dan barisnya tidak selebar
        // tabel. Angka ini adalah milik tabel Fuel Ratio (kolom berbeda dari
        // panel Between yang 15), jadi jangan diseragamkan dengan di bawah.
        body.innerHTML = '<tr><td colspan="18" class="u-text-mute" style="text-align:center;padding:14px">' +
          'Tidak ada unit yang cocok dengan filter.</td></tr>';
      } else {
        body.innerHTML = page.map(function (r) {
          var meta = r.verdict ? RENDER._labels.verdict[r.verdict] : null;
          var status = meta
            ? '<span class="badge ' + meta.cls + '">' + esc(meta.label) + '</span>'
            // Alasan yang TERLIHAT, bukan hanya `title`. "tanpa data" saja
            // membuat operator mengira berkasnya kosong.
            : '<span class="u-text-mute" title="' + esc(r.reason) + '">tanpa data' +
              (r.reasonShort ? ' <span style="opacity:.8">\u00b7 ' + esc(r.reasonShort) + '</span>' : '') +
              '</span>';
          // [2026-10-28] Angka 2 desimal (permintaan operator). Simbol — bila
          // tidak ada angka (JANGAN 0) supaya unit tanpa data tidak terbaca
          // "paling hemat".
          var n2 = function (v) { return v == null ? '\u2014' : RENDER._num(v, 2); };
          var n1 = function (v) { return v == null ? '\u2014' : RENDER._num(v, 1); };
          var n0 = function (v) { return v == null ? '\u2014' : RENDER._num(v, 0); };
          var h1 = function (v) { return v == null ? '\u2014' : RENDER._num(v, 1) + ' h'; };
          // dd/mm/yy — ringkas supaya dua tanggal muat dalam satu kolom.
          var dShort = function (d) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return '\u2014';
            return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(2, 4);
          };
          var rangeTxt = function (row) {
            if (!row.dateStart && !row.dateEnd) return '\u2014';
            return dShort(row.dateStart) + ' \u2013 ' + dShort(row.dateEnd);
          };
          var rangeTitle = function (row) {
            if (!row.dateStart && !row.dateEnd) return 'Tidak ada data bertanggal pada baris ini.';
            return 'Data yang dipakai baris ini: ' + row.dateStart + ' s/d ' + row.dateEnd +
              (row.scoped ? ' (dipotong filter tanggal).' : ' (seluruh berkas).') +
              (row.updatedAt ? ' \u00b7 Diunggah ' + new Date(row.updatedAt).toLocaleDateString('id-ID') : '');
          };
          var winTitle = function (row) {
            return row.eligible + ' baris data valid, mencakup ' + (row.dayCount || 0) +
              ' hari kalender. Satu baris trend0 menutup \u00b1 20 jam SMR (BUKAN harian), ' +
              'jadi jumlah baris dan jumlah hari tidak sama.';
          };
          // SMR dari record jangkar terdekat di luar rentang -> ditandai `~`.
          var smrCell = function (v, tip) {
            if (v == null) return '<td class="fuel-num" title="' + esc(tip) + '">\u2014</td>';
            return '<td class="fuel-num" title="' + esc(tip +
              (r.smrApprox ? ' \u2014 record trend0 tidak ada tepat di batas rentang, dipakai record TERDEKAT sebagai jangkar (perkiraan).' : '')) +
              '">' + (r.smrApprox ? '~' : '') + h1(v) + '</td>';
          };
          // Judul sel siklus/tonase: sebut DARI MANA angkanya, karena pada
          // rentang tanggal ada dua kemungkinan basis yang TIDAK sebanding.
          var cycTitle = function (row, base) {
            if (row.cycleBasis === 'cycle') {
              return base + ' pada rentang tanggal terpilih (basis sama dengan angka total).';
            }
            if (row.cycleBasis === 'window') {
              return base + ' pada rentang tanggal terpilih, diturunkan dari JENDELA VALID ' +
                'karena unit ini tersimpan sebelum rekap siklus harian ada. ' +
                'Angkanya lebih kecil dari total berkas \u2014 unggah ulang unit untuk basis penuh.';
            }
            return base + ' (seluruh berkas).';
          };
          var isSel = (r.key === _state.selectedKey);
          return '<tr' + (isSel ? ' class="fuel-row-active"' : '') + '>' +
            '<td>' +
              // No. Lambung adalah identitas yang dibaca operator. SN hanya
              // ditampilkan pada tooltip (tidak memenuhi kolom).
              '<strong>' + esc(r.lambung || r.serial || '\u2014') + '</strong>' +
              (r.lambungExact === false && r.serial
                ? ' <span class="fuel-sn-unmapped" title="SN belum terpetakan ke Nomor Lambung — unggah Data Unit (SN · Lambung · Section) atau data Lifetime">SN</span>'
                : '') +
              (r.weakKey ? ' <span class="u-text-mute" title="Berkas tanpa Serial No. — identitas tidak pasti">?</span>' : '') +
              (r.legacy ? ' <span class="u-text-mute" title="Data dari format penyimpanan lama">(lama)</span>' : '') +
            '</td>' +
            '<td>' + esc(r.model || '') + '</td>' +
            '<td>' + status + '</td>' +
            // Cakupan berkas trend0: SMR awal, SMR akhir, dan jam operasi di
            // dalam berkas (ΔSMR). Sumber: ANALYTICS.trendExtent.
            smrCell(r.smrStart, 'SMR record pertama di trend0 (jam operasi)') +
            smrCell(r.smrEnd, 'SMR record terakhir di trend0 (jam operasi)') +
            '<td class="fuel-num" title="Total operasi di dalam berkas = SMR akhir - SMR awal (jam)">' + h1(r.totalHours) + '</td>' +
            // [RENTANG 2026-10-28] Judul sel MENYEBUT basis angkanya. Unit
            // simpanan lama (sebelum rekap siklus harian ada) hanya bisa
            // dipotong lewat jendela valid — angkanya lebih kecil dari total
            // berkas, dan itu harus terbaca, bukan disamarkan.
            '<td class="fuel-num" title="' + esc(cycTitle(r, 'Akumulasi payload dari pldcyc')) + '">' +
              (r.totalCycle == null ? '\u2014' : RENDER._num(r.totalCycle, 1) + ' Ton') +
              (r.cycleBasis === 'window' ? ' <span class="u-text-mute">*</span>' : '') + '</td>' +
            '<td class="fuel-num" title="' + esc(cycTitle(r, 'Jumlah siklus valid dari pldcyc')) + '">' +
              (r.cycleCount == null ? '\u2014' : RENDER._num(r.cycleCount, 0)) +
              (r.cycleBasis === 'window' ? ' <span class="u-text-mute">*</span>' : '') + '</td>' +
            '<td class="fuel-num">' + n2(r.lTk) + '</td>' +
            '<td class="fuel-num">' + n2(r.lGt) + '</td>' +
            '<td class="fuel-num">' + n2(r.penalty) + '</td>' +
            // [2026-10-29] Jendela = N baris data + cakupan HARI-nya. Record
            // trend0 menutup ~20 h SMR (bukan harian), jadi "4" bisa 3 hari.
            '<td class="fuel-num" title="' + esc(winTitle(r)) + '">' +
              esc(String(r.eligible)) +
              (r.dayCount ? ' <small class="u-text-mute">/ ' + esc(String(r.dayCount)) + ' hr</small>' : '') +
            '</td>' +
            '<td class="fuel-num">' + (r.overPct == null ? '\u2014' : RENDER._num(100 * r.overPct, 0) + ' %') + '</td>' +
            // `eventHtml` milik renderer (FUNGSI MURNI) — dipanggil lewat
            // RENDER, bukan nama lokal: memanggil nama lokal melempar
            // ReferenceError dan menggagalkan SELURUH tabel.
            '<td class="fuel-ratio-result">' + RENDER.eventHtml(r, (global.FUEL_ANALYTICS || {}).LIMITS) + '</td>' +
            // Satuan HANYA ditempel bila angkanya ada — "— L/jam" terbaca
            // seperti nilai yang terukur.
            '<td class="fuel-num" title="Rata-rata Fuel Rate record trend0">' + n1(r.fuelRateAvg) +
              (r.fuelRateAvg == null ? '' : ' <small>L/jam</small>') + '</td>' +
            '<td class="fuel-num" title="Proyeksi total fuel = Fuel Rate rata-rata x Total Operation (konsumsi aktual di dalam berkas)">' +
              n0(r.projFuel) + (r.projFuel == null ? '' : ' <small>L</small>') + '</td>' +
            // Rentang data = tanggal data terawal s/d terakhir yang masuk
            // perhitungan baris ini (mengikuti filter tanggal bila aktif).
            '<td class="u-text-mute" style="font-size:11px;white-space:nowrap"' +
              ' title="' + esc(rangeTitle(r)) + '">' + rangeTxt(r) + '</td>' +
            '<td style="white-space:nowrap;text-align:center">' +
              // [FIX 2026-10-28] Tombol detail TIDAK boleh bergantung pada
              // `verdict`. Unit ber-jendela tapi tanpa verdict (mis. 17
              // jendela) MASIH punya data untuk diperiksa. Sebelumnya tombol
              // disabled sehingga "data terunggah tapi tidak bisa dilihat".
              '<button class="btn btn-ghost btn-sm" data-fuel-open="' + esc(r.key) + '"' +
                (RENDER.canOpenUnit(r) ? ' title="Buka detail unit ini"' :
                  ' disabled title="Tidak ada hasil untuk dibuka"') + '>' +
                '<i class="fa-solid fa-up-right-from-square"></i></button> ' +
              '<button class="btn btn-ghost btn-sm" data-fuel-del="' + esc(r.key) + '"' +
                ' title="Hapus unit ini dari daftar &amp; penyimpanan">' +
                '<i class="fa-solid fa-trash"></i></button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }
    }

    var pager = $id('fuel-ratio-pagination');
    if (pager) {
      pager.innerHTML = rows.length <= pageSize ? '' :
        '<button class="btn btn-ghost btn-sm" data-fuel-page="prev" ' + (f.page === 1 ? 'disabled' : '') + '>Sebelumnya</button>' +
        '<span>Halaman <strong>' + f.page + '</strong> / ' + pageCount + ' · ' + rows.length + ' unit</span>' +
        '<button class="btn btn-ghost btn-sm" data-fuel-page="next" ' + (f.page === pageCount ? 'disabled' : '') + '>Berikutnya</button>';
    }

    var note = $id('fuel-ratio-note');
    if (note) {
      note.textContent = 'Menampilkan ' + ((f.page - 1) * pageSize + 1) + '–' + Math.min(f.page * pageSize, rows.length) + ' dari ' + rows.length + ' unit terfilter (' + allRows.length + ' total).' +
        ' unit. Rasio Formulasi per unit | Kolom Over % = Formulasi dari Total Event yang masuk sesuai area flag CAUTION dan OVER.';
    }

    // Isi pilihan model pada filter (sekali, tanpa duplikat).
    var sel = $id('fuel-filter-model');
    if (sel) {
      var models = [];
      allRows.forEach(function (r) { if (r.model && models.indexOf(r.model) < 0) models.push(r.model); });
      var cur = f.model || '';
      var html = '<option value="">Semua model</option>' + models.sort().map(function (m) {
        return '<option value="' + esc(m) + '"' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>';
      }).join('');
      // Jangan tulis ulang bila tidak berubah (mencegah kursor melompat).
      if (sel.innerHTML !== html) sel.innerHTML = html;
    }

    renderCompare();
  }

  /* -----------------------------------------------------------------------
   * renderCompare() — panel "Between": dua rentang, hasil hemat/boros.
   *
   * SELURUH angka berasal dari `RENDER.compareRows()` (murni, teruji). Di
   * sini hanya pemetaan ke HTML. Menambahkan perhitungan di sini akan
   * membuat panel ini dan tabel di atasnya memakai dua definisi rasio.
   * --------------------------------------------------------------------- */
  /** [F2] 'YYYY-MM-DD' -> 'DD/MM/YYYY' untuk kalimat pemberitahuan. */
  function _fmtDateShort(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(ymd || '\u2014');
  }

  /**
   * [GPS 2026-10-30] readGpsFiles(files) — baca berkas track GPS, agregat,
   * lalu gambar ulang panel Between.
   *
   * MENGAPA BERPOTONG-BERPOTONG: satu berkas track bisa 400 KB berisi
   * ~3.000 titik; folder satu armada ~100 MB. Membacanya dalam satu
   * gelung `await` membuat browser membeku tanpa umpan balik. Di sini tiap
   * berkas dibaca berurutan, lalu `yield` satu putaran event loop supaya
   * tombol & status tetap hidup.
   *
   * KEGAGALAN TIDAK DIAM: berkas yang tidak dikenali (mis. agregat harian
   * `gps-daily-kpi.csv` yang TIDAK punya lat/lon) disebut jumlahnya, karena
   * operator yang mengunggah berkas salah harus tahu, bukan melihat kolom
   * kosong tanpa sebab.
   */
  /**
   * TATA LETAK 2026-10-31 (keputusan operator): kontrol GPS ("Tambah GPS",
   * "Lepas", `<input>` berkasnya) KEMBALI ke gugus tombol panel perbandingan
   * seperti posisi 2026-10-30. Percobaan sidebar kanan pada hari yang sama
   * DIBATALKAN karena kolom 232px-nya menyempitkan tabel Fuel Ratio.
   *
   * Kontrak SATU GERBANG (`FUEL-UPLOAD-1`) tetap berlaku: elemen ini bukan
   * jalur analisis Fuel, melainkan data pendukung per sesi (lihat
   * `FUEL-UPLOAD-1b`). Elemen WAJIB tetap tunggal & memakai id yang sama.
   */
  /**
   * [GPS 2026-10-31] Status GPS. Yang dipakai sekarang satu tempat saja:
   * `#fuel-gps-status` di panel perbandingan (progres baca per berkas, lalu
   * ringkasan hasil). `#fuel-gps-sidebar-status` sudah TIDAK ada setelah
   * sidebar dibatalkan — aksesnya tetap null-safe agar kode lama/HTML lain
   * tidak meledak bila elemen itu muncul lagi.
   */
  function _gpsStatus(progress, summary) {
    var p = $id('fuel-gps-status');
    var s = $id('fuel-gps-sidebar-status');
    if (p) {
      // Belum ada ringkasan -> jangan biarkan teks progres menempel.
      p.textContent = progress != null ? progress : (summary || '');
    }
    if (s) {
      s.textContent = summary == null ? '' : summary;
      // Ringkasan kosong = belum ada GPS; sembunyikan kotak agar tidak
      // meninggalkan baris kosong di sidebar.
      s.style.display = summary ? '' : 'none';
    }
  }

  function readGpsFiles(files) {
    var G = global.FUEL_GPS;
    var btn = $id('btn-fuel-gps-add');
    if (!G) { toast('Modul GPS (js/fuel-gps.js) belum termuat.', 'err'); return; }
    var list = Array.prototype.slice.call(files || []);
    var track = [], rejected = [], failed = 0;
    var i = 0;
    if (btn) btn.disabled = true;

    function step() {
      if (i >= list.length) return done();
      var f = list[i++];
      // Berkas yang jelas bukan track ditolak SEBELUM dibaca: mengunggah
      // `gps-daily-kpi.csv` (agregat) adalah kesalahan yang mudah terjadi
      // karena namanya mirip.
      if (!/track/i.test(f.name) && !/gps/i.test(f.name)) {
        rejected.push(f.name); return next();
      }
      _gpsStatus('Membaca GPS ' + i + '/' + list.length + ' \u2014 ' + f.name, null);
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        if (!G.looksLikeTrack(text)) { rejected.push(f.name); return next(); }
        track.push({ name: f.name, text: text });
        next();
      };
      reader.onerror = function () { failed++; next(); };
      reader.readAsText(f);
    }
    function next() {
      // `setTimeout(0)` = lepaskan event loop agar UI tidak membeku.
      if (global.setTimeout) global.setTimeout(step, 0); else step();
    }
    function done() {
      if (btn) btn.disabled = false;
      if (!track.length) {
        _gpsStatus('', _state.gpsInfo ? _gpsSummaryText(_state.gpsInfo) : '');
        toast('Tidak ada berkas track GPS yang bisa dibaca' +
          (rejected.length ? ' (' + rejected.length + ' ditolak)' : '') + '.', 'err');
        return;
      }
      _gpsStatus('Menghitung elevasi\u2026', null);
      // Beri kesempatan status tergambar sebelum pekerjaan CPU dimulai.
      (global.setTimeout || function (fn) { fn(); })(function () {
        var agg = G.aggregate(track);
        _state.gps = agg;
        var units = Object.keys(agg.byUnit);
        var days = 0;
        units.forEach(function (u) { days += (agg.byUnit[u].__meta || {}).days || 0; });
        _state.gpsInfo = { files: track.length, units: units.length, days: days,
          rejected: rejected.length, failed: failed };
        _gpsStatus('', _gpsSummaryText(_state.gpsInfo));
        if (global.FUEL_VHMS_APP && typeof global.FUEL_VHMS_APP.invalidateAnalysis === 'function') {
          global.FUEL_VHMS_APP.invalidateAnalysis();
        }
        renderCompare();
        toast('GPS dibaca: ' + track.length + ' berkas, ' + units.length + ' unit, ' +
          days + ' hari-unit.' +
          (rejected.length ? ' ' + rejected.length + ' berkas ditolak (bukan track).' : '') +
          (failed ? ' ' + failed + ' gagal dibaca.' : ''), 'ok');
      }, 0);
    }
    step();
  }

  /**
   * Ringkasan GPS untuk sidebar. Menyebut BERKAS DITOLAK secara eksplisit:
   * operator yang salah memilih folder harus tahu berkasnya tidak terpakai,
   * bukan melihat kolom elevasi kosong tanpa sebab.
   */
  function _gpsSummaryText(info) {
    if (!info) return '';
    var t = info.files + ' berkas track \u00b7 ' + info.units + ' unit \u00b7 ' +
      info.days + ' hari-unit';
    if (info.rejected) t += ' \u00b7 ' + info.rejected + ' ditolak';
    if (info.failed) t += ' \u00b7 ' + info.failed + ' gagal';
    return t;
  }

  /* Browser tidak dapat menelusuri folder proyek. Manifest hasil generator
   * dipakai untuk memuat hanya track unit yang terdapat di Fuel saat ini. */
  function loadGeneratedGps() {
    var G = global.FUEL_GPS;
    var btn = $id('btn-fuel-gps-load-generated');
    if (!G) { toast('Modul GPS belum termuat.', 'err'); return; }
    if (btn) btn.disabled = true;
    _gpsStatus('Memeriksa hasil Generate Agregat GPS…', null);
    fetch('sample-data/data-gps/gps-daily-kpi-tracks-manifest.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('Manifest GPS belum ada. Klik Generate Agregat GPS terlebih dahulu.');
        return res.json();
      })
      .then(function (manifest) {
        var available = {}, targets = {};
        (manifest.units || []).forEach(function (unit) { available[G.normUnit(unit)] = true; });
        (_state.fleet || []).forEach(function (u) {
          var unit = labelOf(u.serial) || u.lambung || u.serial || u.key;
          var key = G.normUnit(unit);
          if (available[key]) targets[key] = true;
        });
        var units = Object.keys(targets);
        if (!units.length) throw new Error('Tidak ada nomor lambung Fuel yang cocok dengan hasil GPS. Periksa pemetaan SN ke nomor lambung.');
        var loaded = [], index = 0;
        function next() {
          if (index >= units.length) return finish();
          var unit = units[index++];
          _gpsStatus('Memuat GPS ' + index + '/' + units.length + ' — ' + unit, null);
          fetch('sample-data/data-gps/gps-daily-kpi-track-' + encodeURIComponent(unit) + '.csv', { cache: 'no-store' })
            .then(function (res) { if (!res.ok) throw new Error(unit); return res.text(); })
            .then(function (text) { loaded.push({ name: 'gps-daily-kpi-track-' + unit + '.csv', text: text }); })
            .catch(function () { /* manifest dapat berubah, file hilang dilewati */ })
            .then(function () { (global.setTimeout || function (fn) { fn(); })(next, 0); });
        }
        function finish() {
          if (!loaded.length) throw new Error('Track GPS untuk unit Fuel tidak dapat dibaca.');
          _state.gps = G.aggregate(loaded);
          var actual = Object.keys(_state.gps.byUnit), days = 0;
          actual.forEach(function (u) { days += (_state.gps.byUnit[u].__meta || {}).days || 0; });
          _state.gpsInfo = { files: loaded.length, units: actual.length, days: days, rejected: 0, failed: units.length - loaded.length };
          _gpsStatus('', _gpsSummaryText(_state.gpsInfo));
          if (global.FUEL_VHMS_APP && typeof global.FUEL_VHMS_APP.invalidateAnalysis === 'function') {
            global.FUEL_VHMS_APP.invalidateAnalysis();
          }
          renderCompare();
          toast('GPS hasil generate dimuat: ' + loaded.length + ' unit, ' + days + ' hari-unit.', 'ok');
          if (btn) btn.disabled = false;
        }
        next();
      })
      .catch(function (err) {
        _gpsStatus('', err.message);
        toast(err.message, 'err');
        if (btn) btn.disabled = false;
      });
  }

  /** [F5] '13 % / 97 %' — cakupan hari per sisi, dibulatkan. */
  function _covPct(c) {
    return (c == null || !isFinite(c)) ? '\u2014' : Math.round(c * 100) + ' %';
  }
  function _covText(r) {
    return _covPct(r.aCov) + ' / ' + _covPct(r.bCov);
  }

  /* [F4 2026-10-29] Ambang keyakinan DIBACA dari sumber yang sama dengan
   * gerbangnya (`CMP_LIMITS`). Menulis angkanya lagi di sini akan membuat
   * tooltip menjelaskan aturan yang tidak dipakai begitu ambang diubah. */
  var CMPLIM = (RENDER && RENDER.CMP_LIMITS) || { minRows: 10 };

  /**
   * [F5b] Tooltip DIBANGUN DARI BARIS ITU SENDIRI, bukan kalimat tetap.
   * Teks statis akan basi diam-diam saat rumus berubah; teks yang memuat
   * angka baris akan terlihat salah begitu angkanya tidak cocok.
   */
  function _covTitle(r) {
    return 'A: ' + r.aWindows + ' baris valid pada ' + r.aDays + ' hari' +
      ' dari ' + (r.aPeriodDays || 0) + ' hari periode (' + _covPct(r.aCov) + ')\n' +
      'B: ' + r.bWindows + ' baris valid pada ' + r.bDays + ' hari' +
      ' dari ' + (r.bPeriodDays || 0) + ' hari periode (' + _covPct(r.bCov) + ')\n' +
      'Satu baris = satu jendela ~20 jam mesin, bukan satu hari.';
  }

  /** [F5b] Tooltip Δ% memuat ARITMETIKA baris itu agar bisa diverifikasi. */
  function _deltaTitle(r) {
    if (r.deltaPct == null || r.aLTk == null || r.bLTk == null) return '';
    return '(' + RENDER._num(r.bLTk, 4) + ' \u2212 ' + RENDER._num(r.aLTk, 4) +
      ') \u00f7 ' + RENDER._num(r.aLTk, 4) + ' \u00d7 100 = ' +
      (r.deltaPct < 0 ? '\u2212' : '+') + RENDER._num(Math.abs(r.deltaPct), 1) + ' %';
  }

  /* ---------------- [SUPPORT 2026-10-30] Sel angka pendukung -------------
   * ATURAN: null SELALU dicetak "\u2014", tidak pernah 0. Pada panel ini nol
   * punya arti sendiri ("tidak beroperasi", "datar"), sehingga menulis 0
   * untuk "tidak ada data" adalah klaim yang salah.
   * Nilai From dan To ditumpuk dalam SATU sel; angka kedua diberi warna
   * redup. Tujuannya membandingkan secara VERTIKAL (mata menurun di kolom
   * yang sama), bukan horizontal — arah yang sama dengan judul "From \u2192 To". */
  function _pairNum(a, b, d, unitTitle) {
    var A = (a == null || !isFinite(a)) ? '\u2014' : RENDER._num(a, d);
    var B = (b == null || !isFinite(b)) ? '\u2014' : RENDER._num(b, d);
    return '<span class="fuel-cmp-pair-v" title="' + esc(unitTitle || '') + '">' +
      '<b>' + A + '</b><span class="fuel-cmp-arrow-v">\u2192</span>' +
      '<span class="fuel-cmp-to">' + B + '</span></span>';
  }
  /* [FORMAT 2026-10-30] Jam & meter tidak perlu desimal bila angkanya utuh:
   * "560,0 -> 560,0" lebih ramai daripada "560 -> 560" dan memakan lebar
   * kolom yang langka (15 kolom). Nilai PECAHAN tetap dicetak 1 desimal supaya
   * 12,4 jam tidak dibulatkan jadi 12. */
  function _fmtAuto(v, d) {
    if (v == null || !isFinite(v)) return '\u2014';
    var r = Math.round(v);
    if (Math.abs(v - r) < 1e-9) return RENDER._num(r, 0);
    return RENDER._num(v, d);
  }
  function _pairAuto(a, b, unitTitle) {
    return '<span class="fuel-cmp-pair-v" title="' + esc(unitTitle || '') + '">' +
      '<b>' + _fmtAuto(a, 1) + '</b><span class="fuel-cmp-arrow-v">\u2192</span>' +
      '<span class="fuel-cmp-to">' + _fmtAuto(b, 1) + '</span></span>';
  }
  function _sup(r, side) { return (side === 'a' ? r.aSupp : r.bSupp) || null; }
  function _supNum(r, key, d) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    var va = a ? a[key] : null, vb = b ? b[key] : null;
    return _pairNum(va, vb, d);
  }
  /** Operasi & elevasi: angka utuh tanpa desimal (lihat `_fmtAuto`). */
  function _supAuto(r, key) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    return _pairAuto(a ? a[key] : null, b ? b[key] : null);
  }

  /**
   * _basisNote(r, key) — tanda `*` bila angka jarak/idle berasal dari unit
   * yang ringkasannya tersimpan SEBELUM rekap pldcyc diperluas.
   *
   * [SUPPORT 2026-10-30] Unit lama tidak punya `cycleDaily[].dE/dL/sE/sLd`,
   * sehingga nilainya `null` dan sel menulis "\u2014". Penanda membuat sebabnya
   * terbaca (dan bisa ditindaklanjuti: unggah ulang), alih-alih tampak seperti
   * unit yang memang tidak berjalan.
   */
  function _basisNote(r, key) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    // Ada nilai di salah satu sisi -> angka nyata, tak perlu penanda.
    if ((a && a[key] != null) || (b && b[key] != null)) return '';
    // Tidak ada nilai: sebut SEBABNYA hanya bila memang seharusnya ada,
    // yaitu saat sisi itu memiliki rekap siklus ('cycle'). Unit yang
    // jatuh ke cadangan jendela ('window') memang tidak pernah punya
    // dE/dL (siklus mentah tidak tersimpan) — penanda di situ hanya derau.
    var rekapA = a && a.cycleBasis === 'cycle';
    var rekapB = b && b.cycleBasis === 'cycle';
    if (!rekapA && !rekapB) return '';
    return ' <span class="u-text-mute" title="Unit ini tersimpan sebelum rekap pldcyc per tanggal diperluas (Empty/Loaded Drv.Dist. & Stop Time). Jarak/idle belum tersedia \u2014 unggah ulang unit untuk mengisinya.">*</span>';
  }

  /**
   * _idleCell(r) — idle dalam JAM (dari menit pldcyc ÷ 60).
   *
   * Idle = `Empty Stop Time + LoadingStopTime + Loaded Stop Time`, definisi
   * yang SAMA dengan "Idle %" di tabel jendela (`computeMetrics`). Rinciannya
   * ada di tooltip supaya pembaca bisa memeriksa komponen mana yang dominan —
   * idle saat loading (antre) dan idle saat bermuatan (dump) punya tindak
   * lanjut berbeda, padahal keduanya tampil sebagai satu angka.
   */
  function _idleCell(r) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    var ha = a && a.idleMin != null, hb = b && b.idleMin != null;
    var va = ha ? a.idleMin / 60 : null;
    var vb = hb ? b.idleMin / 60 : null;
    function parts(s) {
      if (!s || s.idleMin == null) return 'rincian tidak tersimpan';
      return 'kosong ' + RENDER._num((s.sE || 0) / 60, 1) + ' j \u00b7 loading ' +
        RENDER._num((s.sL || 0) / 60, 1) + ' j \u00b7 bermuatan ' +
        RENDER._num((s.sLd || 0) / 60, 1) + ' j';
    }
    var title = 'Idle = Empty Stop Time + LoadingStopTime + Loaded Stop Time (pldcyc), dijumlah per tanggal lalu dibagi 60 ke jam.\n' +
      'A: ' + parts(a) + '\nB: ' + parts(b);
    return '<span title="' + esc(title) + '">' + _pairAuto(va, vb) + '</span>' + _basisNote(r, 'idleMin');
  }
  /** "28h / 26h" — hari berdata per sisi di bawah kolom Operasi. */
  function _supDays(r) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    function d(s) { return (s && s.days != null) ? (s.days + 'h') : '\u2014'; }
    if (!a && !b) return '\u2014';
    return d(a) + ' / ' + d(b) + ' hari';
  }
  function _isWindowBasis(r) {
    return !!((r.aSupp && r.aSupp.cycleBasis === 'window') ||
      (r.bSupp && r.bSupp.cycleBasis === 'window'));
  }

  /**
   * _gpsCell(r) — "Naik (m)" From/To + sparkline tren harian.
   *
   * Sparkline digambar dari deret HARIAN yang RAPAT (hari kosong = null),
   * jadi lubang data terlihat sebagai garis terputus — sama seperti chart
   * utama. Bila GPS belum diunggah untuk unit ini, sel menulis sebabnya.
   */
  function _gpsCell(r) {
    var a = _sup(r, 'a'), b = _sup(r, 'b');
    var hasA = a && a.gpsDays != null && a.gpsDays > 0;
    var hasB = b && b.gpsDays != null && b.gpsDays > 0;
    var G = global.FUEL_GPS;
    // [KEJUJURAN 2026-10-30] Ada GPS, tetapi nol perubahan elevasi di
    // KEDUA sisi. Menulis angka saja ("0") membuat mata membacanya sama
    // seperti "0 m BUKAN hasil ukur". Karena itu angkanya tetap dicetak
    // (itu hasil yang sah) dengan keterangan "datar".
    var flatA = hasA && a.climbGps != null && a.climbGps === 0;
    var flatB = hasB && b.climbGps != null && b.climbGps === 0;
    function statusNote() {
      if (!hasA && !hasB) return '';
      var n = [];
      if (hasA && !hasB) n.push('To belum diukur');
      if (hasB && !hasA) n.push('From belum diukur');
      // Sisi yang punya GPS sudah pasti dicetak; sisa pesannya hanya bila
      // TIDAK ADA sisi yang diukur pada rentang ini.
      return n.length ? '\u00b7 ' + n.join(' \u00b7 ') : '';
    }
    if (!hasA && !hasB) {
      var reason = (!_state.gps) ? 'GPS belum diunggah'
        : ((a && a.gpsDays === 0) || (b && b.gpsDays === 0)) ? 'unit tidak ada di berkas GPS'
          : 'tidak ada data pada rentang ini';
      return '<span class="fuel-cmp-gps-none" title="' + esc(reason + ' \u2014 kolom dikosongkan, BUKAN diisi 0 m') + '">' +
        '\u2014</span><br><span class="fuel-cmp-cov">' + esc(reason) + '</span>';
    }
    // Dua sparkline: From di atas, To di bawah, masing-masing diskalakan
    // sendiri — yang dibandingkan adalah POLA, bukan tinggi absolut.
    var spA = G ? G.sparkline((a && a.gpsDaily) || []) : { ok: false };
    var spB = G ? G.sparkline((b && b.gpsDaily) || []) : { ok: false };
    function mini(sp, cls, label) {
      if (!sp.ok) return '<span class="fuel-cmp-gps-none">\u2014</span>';
      return '<svg class="fuel-cmp-spark ' + cls + '" width="' + sp.w + '" height="' + sp.h +
        '" viewBox="0 0 ' + sp.w + ' ' + sp.h + '" role="img" aria-label="' +
        esc(label + ': tren harian naik elevasi') + '"><path d="' + sp.path + '"/></svg>';
    }
    var tA = (spA.trend == null) ? '' : ' \u00b7 tren ' + (spA.trend > 0 ? '+' : '\u2212') +
      RENDER._num(Math.abs(spA.trend), 0) + ' %';
    var note = statusNote();
    return '<span class="fuel-cmp-gps">' +
      '<span class="fuel-cmp-pair-v"><b>' + (hasA ? _fmtAuto(a.climbGps, 0) : '\u2014') + '</b>' +
      '<span class="fuel-cmp-arrow-v">\u2192</span>' +
      '<span class="fuel-cmp-to">' + (hasB ? _fmtAuto(b.climbGps, 0) : '\u2014') + '</span></span>' +
      '<span class="fuel-cmp-sparks" title="Titik = satu hari. Garis terputus = hari tanpa GPS.' +
      esc(tA) + '">' + mini(spA, 'is-from', 'From') + mini(spB, 'is-to', 'To') + '</span>' +
      '<span class="fuel-cmp-cov">' + (hasA ? a.gpsDays + 'h' : '\u2014') + ' / ' +
      (hasB ? b.gpsDays + 'h' : '\u2014') + ' GPS' +
      ((flatA || flatB) ? ' \u00b7 datar' : '') + (note ? ' ' + note : '') + '</span>' +
      '</span>';
  }

  function renderCompare() {
    var panel = $id('fuel-cmp-panel');
    if (!panel || !RENDER || typeof RENDER.compareRows !== 'function') return;
    var fleet = _state.fleet || [];
    // Tanpa unit, atau sedang di halaman detail -> panel tidak relevan.
    if (!fleet.length || currentView() === 'detail') {
      panel.style.display = 'none';
      if (RENDER.renderCompareChart) RENDER.renderCompareChart(null);
      return;
    }
    panel.style.display = '';

    // [F2 2026-10-29] Batas tanggal = data terakhir yang BENAR-BENAR ada,
    // bukan hari ini. Tanggal masa depan / belum terunggah hanya memperlebar
    // penyebut cakupan dan membuat sisi B tampak tipis tanpa sebab.
    // Dihitung ULANG tiap render: unggahan baru menambah tanggal.
    var dataLast = typeof RENDER.dataLastDate === 'function' ? RENDER.dataLastDate(fleet) : null;
    var today = typeof RENDER.ymdLocal === 'function' ? RENDER.ymdLocal() : '';
    var maxDate = (dataLast && today) ? (dataLast < today ? dataLast : today)
      : (dataLast || today || '');
    _state.limits = { dataLast: dataLast, today: today, maxDate: maxDate };
    ['fuel-cmp-a-start', 'fuel-cmp-a-end', 'fuel-cmp-b-start', 'fuel-cmp-b-end']
      .forEach(function (id) {
        var el = $id(id);
        if (el) el.setAttribute('max', maxDate || '');
      });

    var c = _state.compare || {};
    var cmpRanges = {
      a: { dateStart: c.aStart, dateEnd: c.aEnd },
      b: { dateStart: c.bStart, dateEnd: c.bEnd }
    };
    var res = RENDER.compareRows(fleet, _state.lambungCtx, cmpRanges);
    /* [SUPPORT 2026-10-30] Kolom pendukung ditambahkan SESUDAH vonis
     * dihitung. Lapisan ini boleh gagal tanpa membatalkan vonis — karena itu
     * ia terpisah dari `compareRows()` yang murni & teruji. */
    if (RENDER.augmentSupport) {
      RENDER.augmentSupport(res.rows, fleet, cmpRanges, { gps: _state.gps, ctx: _state.lambungCtx });
    }
    // [F9] Simpan HASIL YANG DIGAMBAR agar ekspor tidak pernah menghitung
    // ulang dengan parameter yang berbeda dari yang terlihat di layar.
    _state.compareLast = res.ready ? { rows: res.rows, ranges: cmpRanges } : null;
    var csvBtn = $id('btn-fuel-cmp-csv');
    if (csvBtn) csvBtn.disabled = !(res.ready && res.rows.length);
    var imageBtn = $id('btn-fuel-cmp-image');
    if (imageBtn) imageBtn.disabled = !(res.ready && res.rows.length);

    var status = $id('fuel-cmp-status');
    var totalsEl = $id('fuel-cmp-totals');
    var wrap = $id('fuel-cmp-chart-wrap');
    var head = $id('fuel-cmp-head'), body = $id('fuel-cmp-body');

    // ---- rentang belum lengkap / tidak sah: JANGAN gambar apa pun -------
    // Menggambar tabel dari rentang setengah terisi berarti menampilkan
    // angka SELURUH berkas dan menyebutnya "sebelum".
    if (!res.ready) {
      if (status) {
        status.innerHTML = '<div class="alert-banner" role="note" style="margin:0 0 10px">' +
          '<i class="fa-solid fa-circle-info"></i> ' + esc(res.reason) + '</div>';
      }
      if (totalsEl) totalsEl.innerHTML = '';
      if (wrap) wrap.style.display = 'none';
      if (head) head.innerHTML = '<tr></tr>';
      if (body) body.innerHTML = '<tr></tr>';
      var emptyPager = $id('fuel-cmp-pagination');
      if (emptyPager) emptyPager.innerHTML = '';
      if (RENDER.renderCompareChart) RENDER.renderCompareChart(null);
      var emptyImageBtn = $id('btn-fuel-cmp-image');
      if (emptyImageBtn) emptyImageBtn.disabled = true;
      return;
    }

    if (status) {
      // Tumpang-tindih TIDAK memblokir (operator boleh membandingkan periode
      // bersarang dengan sadar), tapi WAJIB disebut: sebagian data yang sama
      // ada di kedua sisi sehingga selisihnya teredam.
      //
      // [F2 2026-10-29] Rentang yang melewati data terakhir juga disebut.
      // Data bisa berhenti sebelum tanggal yang dipilih (upload terakhir
      // terlambat), sehingga sisi B "tipis" bukan karena operator tapi karena
      // datanya memang belum ada. Tidak memblokir — hanya memberi tahu.
      var notes = [];
      if (res.overlap) notes.push(esc(res.reason));
      /* [F6 2026-10-29] Bila rata-rata tertimbang dan rata-rata berbobot
       * tetap berbeda jauh, yang berpindah adalah KOMPOSISI SAMPEL, bukan
       * konsumsi. Ini disebut terang-terangan karena angka tertimbang masih
       * tampil di layar dan tanpa catatan ini pembaca akan menyimpulkan
       * penghematan yang tidak terjadi. Ambang 5 poin persen: di bawah itu
       * selisihnya tidak mengubah keputusan apa pun. */
      var tt = res.totals || {};
      if (tt.compositionShiftPct != null && Math.abs(tt.compositionShiftPct) >= 5) {
        notes.push('Rata-rata tertimbang baris bergerak <strong>' +
          (tt.weightedDeltaPct < 0 ? '\u2212' : '+') + RENDER._num(Math.abs(tt.weightedDeltaPct), 1) +
          ' %</strong>, tetapi dengan bobot yang disamakan hanya <strong>' +
          (tt.fixedWeightDeltaPct < 0 ? '\u2212' : '+') + RENDER._num(Math.abs(tt.fixedWeightDeltaPct), 1) +
          ' %</strong>. Selisih <strong>' + RENDER._num(Math.abs(tt.compositionShiftPct), 1) +
          ' poin</strong> berasal dari perubahan KOMPOSISI data (unit tertentu ' +
          'menyumbang lebih sedikit baris di satu periode), bukan dari perubahan ' +
          'konsumsi. Angka armada memakai median \u0394 per unit yang tidak terpengaruh hal ini.');
      }
      var exc = tt.excluded || {};
      var excNames = (exc.insufficient || []).concat(exc.oneSided || []);
      if (excNames.length) {
        notes.push('Tidak ikut angka armada: <strong>' +
          esc(excNames.slice(0, 8).join(', ')) +
          (excNames.length > 8 ? ' \u2026 (+' + (excNames.length - 8) + ')' : '') +
          '</strong> \u2014 lihat kolom Hasil untuk sebab tiap unit.');
      }
      var dLast = _state.limits && _state.limits.dataLast;
      var past = [c.aEnd, c.bEnd].filter(function (d) { return dLast && d && d > dLast; });
      if (past.length) {
        notes.push('Data terakhir yang tersedia <strong>' +
          esc(_fmtDateShort(dLast)) + '</strong>. Tanggal sesudahnya belum berdata, ' +
          'jadi cakupan periode dihitung sampai tanggal itu.');
      }
      status.innerHTML = notes.length
        ? '<div class="alert-banner is-warning" role="alert" style="margin:0 0 10px">' +
          '<i class="fa-solid fa-triangle-exclamation"></i> ' + notes.join('<br>') + '</div>'
        : '';
    }

    var t = res.totals || {};
    if (totalsEl) {
      var meta = t.verdict && RENDER._labels.compare ? RENDER._labels.compare[t.verdict] : null;
      var cls = t.verdict ? ('is-' + t.verdict.toLowerCase()) : '';
      // [F2] Bobot per BARIS disebut di chip yang sama dengan angkanya:
      // A 0,1612 -> B 0,1324 tidak bisa diturunkan dari Δ per unit, dan tanpa
      // keterangan ini angkanya terbaca seperti kesalahan hitung.
      var basis = t.basis || {};
      var wTitle = 'Rata-rata L/ton-km armada ditimbang JUMLAH BARIS tiap unit. ' +
        'Unit dengan banyak baris (banyak jendela valid) berbobot lebih besar. ' +
        'Jumlah baris yang menopang \u2014 From (A): ' + (basis.aRows || 0) +
        ' baris, To (B): ' + (basis.bRows || 0) + ' baris.';
      totalsEl.innerHTML = t.units
        ? '<span class="fuel-kpi"><em>Unit dibanding</em> <strong>' + esc(String(t.units)) + '</strong></span>' +
          /* [CHIP 2026-10-30 — permintaan operator] Tiga perubahan label:
           *   1. `A \u2192 B (L/ton-km)` -> `From \u2192 To (L/ton-km)`
           *   2. `· timbang baris 544 \u2192 384` -> jumlah baris sekarang
           *      berada di KURUNG SIKU tepat di samping angkanya:
           *      `0,1290 [544 baris data] \u2192 0,1223 [384 baris data]`.
           *      SEBAB: "timbang baris" adalah istilah internal; pembaca
           *      perlu tahu setiap angka ditopang berapa baris, dan
           *      pasangan angka-dan-barisnya harus terbaca tanpa hover.
           *   3. `Hasil armada` -> `Result` (operator tetap memakai istilah
           *      Inggris untuk label hasil, sejalan dengan From/To).
           *   4. `Tanpa vonis` -> `Data Missing` (istilah operator).
           * Istilah `A`/`B` TETAP ada di tooltip agar cocok dengan CSV. */
          '<span class="fuel-kpi" title="' + esc(wTitle) + '"><em>From \u2192 To (L/ton-km)</em> <strong>' +
            RENDER._num(t.aLTk, 4) +
            ' <span class="fuel-kpi-basis">[' + (basis.aRows || 0) + ' baris data]</span> \u2192 ' +
            RENDER._num(t.bLTk, 4) +
            ' <span class="fuel-kpi-basis">[' + (basis.bRows || 0) + ' baris data]</span>' +
          '</strong></span>' +
          '<span class="fuel-kpi ' + cls + '"><em>Result</em> <strong>' +
            (meta ? esc(meta.label) : '\u2014') +
            (t.deltaPct == null ? '' : ' (' + (t.deltaPct < 0 ? '' : '+') + RENDER._num(t.deltaPct, 1) + ' %)') +
          '</strong></span>' +
          '<span class="fuel-kpi"><em>Hemat / Boros / Stabil</em> <strong>' +
            t.counts.HEMAT + ' / ' + t.counts.BOROS + ' / ' + t.counts.STABIL + '</strong></span>' +
          (t.noVerdict ? '<span class="fuel-kpi" title="Unit tanpa angka di salah satu rentang (satu sisi kosong) — tidak ikut rata-rata maupun chart">' +
            '<em>Data Missing</em> <strong>' + t.noVerdict + '</strong></span>' : '')
        : '<span class="fuel-kpi"><em>Tidak ada unit yang punya angka di KEDUA rentang</em></span>';
    }

    var model = RENDER.compareChartModel(res.rows);
    if (wrap) wrap.style.display = model.labels.length ? '' : 'none';
    if (RENDER.renderCompareChart) RENDER.renderCompareChart(model.labels.length ? model : null);

    if (head) {
      /* [REVISI HEADER 2026-10-30 — permintaan operator] Tiga perubahan:
       *   1. `A: L/ton-km` -> `From : L/ton-km`
       *   2. `B: L/ton-km` -> `To : L/ton-km`
       *   3. `Baris A / B` -> `Baris From / To`
       * SEBAB: `A`/`B` tidak menjelaskan arah waktu bagi pembaca baru, dan
       * pada dua kolom bersebelahan mata harus bolak-balik ke fieldset di
       * atas untuk tahu mana "sebelum". `From`/`To` menyebut arahnya
       * langsung di judul kolom. Istilah `A`/`B` TETAP dipakai di chip,
       * tooltip, CSV, dan legenda (kontrak data & ekspor tidak berubah);
       * sub-judul "A=sebelum · B=sesudah" dipertahankan supaya keduanya
       * bisa dicocokkan. */
      head.innerHTML = '<tr>' +
        '<th scope="col" style="text-align:left">No. Lambung</th>' +
        '<th scope="col" style="text-align:left">Model</th>' +
        // [SUPPORT 2026-10-30] Kolom pendukung diletakkan BERDAMPINGAN dengan
        // kolom yang dijelaskannya, bukan di ujung kanan. Pembaca harus bisa
        // membaca "Δ −4 %" lalu tepat di sebelahnya "operasi −12 %, siklus
        // −9 %" tanpa melompati enam kolom.
        '<th scope="col" style="text-align:right" title="Total Operation = selisih SMR dalam rentang (jam mesin). Sama dengan kolom Total Operation di tabel utama. Angka kedua = jumlah hari berdata di sisi itu.">Operasi (jam)<br><span class="fuel-cmp-subhead">From \u2192 To</span></th>' +
        '<th scope="col" style="text-align:right" title="Total Cycle = jumlah siklus payload>0 dari rekap pldcyc per tanggal (SAMA dengan tabel utama). Bila unit tersimpan sebelum rekap ada, dipakai cadangan jendela valid dan angkanya DITANDAI.">Siklus<br><span class="fuel-cmp-subhead">From \u2192 To</span></th>' +
        '<th scope="col" style="text-align:right" title="Total Tonnage = jumlah payload (ton) dari rekap pldcyc per tanggal, sama dengan tabel utama.">Tonase (t)<br><span class="fuel-cmp-subhead">From \u2192 To</span></th>' +
        '<th scope="col" style="text-align:right" title="Jarak tempuh KOSONG = Σ header &quot;Empty Drv.Dist.&quot; (km) dari pldcyc, dijumlah per tanggal lalu dipotong rentang. Sama dengan kolom dE yang dipakai menghitung GTKM. Belum tersedia pada unit yang ringkasannya tersimpan sebelum rekap ini ada (ditandai *).">Jarak Kosong (km)<br><span class="fuel-cmp-subhead">Empty Drv.Dist.</span></th>' +
        '<th scope="col" style="text-align:right" title="Jarak tempuh BERMUATAN = Σ header &quot;Loaded Drv.Dist.&quot; (km) dari pldcyc. Inilah jarak yang dipakai di pembilang ton-km (L/TKM = L ÷ Σ P×dL).">Jarak Muatan (km)<br><span class="fuel-cmp-subhead">Loaded Drv.Dist.</span></th>' +
        '<th scope="col" style="text-align:right" title="Idle = Empty Stop Time + LoadingStopTime + Loaded Stop Time (menit) dijumlah per tanggal, lalu dibagi 60 ke jam. Definisi SAMA dengan kolom Idle % di tabel jendela. Arahkan tetikus untuk rincian per komponen.">Idle (jam)<br><span class="fuel-cmp-subhead">sE + sL + sLd</span></th>' +
        '<th scope="col" style="text-align:right" title="Elevasi dari berkas TRACK GPS (gps-daily-kpi-track-*.csv). Naik = jumlah seluruh kenaikan elevasi (meter) dalam rentang; sparkline = tren harian. BUKAN \'elevasi rute\': riak & derau ikut terjumlah. Unggah lewat tombol \'Tambah GPS\' di atas tabel. Tanpa GPS: \u2014 (bukan 0 m).">Trending Elevasi<br><span class="fuel-cmp-subhead">naik (m) \u00b7 harian</span></th>' +
        '<th scope="col" style="text-align:right" title="L/ton-km pada rentang From (sebelum).">From : L/ton-km</th>' +
        '<th scope="col" style="text-align:right" title="L/ton-km pada rentang To (sesudah).">To : L/ton-km</th>' +
        '<th scope="col" style="text-align:right" title="Selisih To terhadap From dalam persen">\u0394 %</th>' +
        // [F0b 2026-10-29] Judul & isi kolom menyebut DUA batas. Kolom lama
        // mencetak "\u00b1 x %" dari batas ATAS saja, padahal vonis memakai
        // batas bawah `1 \u2212 e^\u2212\u03c3` yang selalu LEBIH KECIL. Untuk \u03c3 = 0,4555
        // layar menulis \u00b157,7 % sementara penurunan 40 % sudah divonis HEMAT:
        // angka yang tercetak tidak pernah dipakai menghakimi apa pun.
        '<th scope="col" style="text-align:right" title="Batas pita derau unit: bawah = (1 - e^-sigma) x 100, atas = (e^sigma - 1) x 100. Selisih di dalam pita dibaca Stabil.">Pita (\u2212\u2026+ %)</th>' +
        // [F5b] Nama kolom LENGKAP di layar. Judul pendek + penjelasan di
        // `title` berarti arti kolom hanya terbaca oleh yang memakai tetikus.
        '<th scope="col" style="text-align:right" title="Baris = jendela ~20 jam mesin yang lolos gerbang. Baris kedua = cakupan hari berdata terhadap hari periode.">Baris From / To<br><span class="fuel-cmp-subhead">cakupan hari</span></th>' +
        '<th scope="col" style="text-align:left">Hasil</th>' +
      '</tr>';
    }

    // [PAGINASI 2026-10-30] Panel Between juga dibatasi 10 baris per halaman.
    // Disimpan di `_state.compare.page` supaya bertahan saat tabel digambar
    // ulang (mis. saat tanggal diubah, halaman kembali ke 1).
    // Aritmetika halaman memakai `RENDER.pageSlice` yang SAMA dengan tabel
    // utama — potongan barisnya diambil setelah pengurutan di bawah.
    var cmpPageSize = 10;
    var cmpMeta = RENDER.pageSlice(res.rows, _state.compare.page, cmpPageSize);
    var cmpPageCount = cmpMeta.pageCount;
    var cmpPage = cmpMeta.page;
    _state.compare.page = cmpPage;

    if (body) {
      if (!res.rows.length) {
        // [SUPPORT 2026-10-30] 15 kolom (2 identitas + 8 pendukung + 3 rasio
        // + pita + baris + hasil). `colspan` yang tertinggal membuat pesan
        // "belum ada unit" menyempit di kolom pertama.
        body.innerHTML = '<tr><td colspan="15" class="u-text-mute" style="text-align:center;padding:14px">' +
          'Belum ada unit untuk dibandingkan.</td></tr>';
      } else {
        // Terburuk di atas; unit tanpa vonis SELALU di bawah (bukan dianggap 0).
        // [F3] `INSUFFICIENT` diperlakukan seperti tanpa vonis untuk urutan:
        // angkanya ada tapi tidak boleh bersaing memperebutkan perhatian
        // dengan unit yang benar-benar terukur.
        var rank = function (r) {
          return (!r.verdict || r.verdict === 'INSUFFICIENT') ? 1 : 0;
        };
        var sorted = res.rows.slice().sort(function (p, q) {
          var rp = rank(p), rq = rank(q);
          if (rp !== rq) return rp - rq;
          if (rp === 1) {
            return String(p.lambung || p.serial).localeCompare(String(q.lambung || q.serial));
          }
          return q.deltaPct - p.deltaPct;
        });
        // Dipotong SETELAH diurut: memotong lebih dulu akan mem-paginasi
        // urutan unggah, bukan urutan "terburuk di atas" yang dilihat
        // operator. `cmpPage` sudah dijepit oleh `pageSlice` di atas.
        var pageRows = RENDER.pageSlice(sorted, cmpPage, cmpPageSize).rows;
        body.innerHTML = pageRows.map(function (r) {
          var m = r.verdict && RENDER._labels.compare ? RENDER._labels.compare[r.verdict] : null;
          var hasil = m
            // [F3] Alasan ditampilkan untuk STABIL *dan* INSUFFICIENT.
            // "Data tidak cukup" tanpa angka tidak bisa ditindaklanjuti —
            // operator perlu tahu sisi mana dan kurang berapa.
            ? '<span class="badge ' + m.cls + '">' + esc(m.label) + '</span>' +
              // [F4 2026-10-29] Keyakinan = jumlah baris di sisi TERLEMAH,
              // dicetak apa adanya. Bukan skor gabungan berbobot: bobot yang
              // tidak terkalibrasi terlihat lebih ilmiah daripada isinya.
              (r.verdict !== 'INSUFFICIENT' && r.weakRows != null
                ? ' <span class="fuel-cmp-conf is-' + String(r.confidence || '').toLowerCase() +
                  '" title="Perbandingan hanya sekuat sisi yang datanya paling sedikit: ' +
                  r.weakRows + ' baris. Tinggi \u2265 ' + (CMPLIM.minRows * 2) +
                  ' · Sedang \u2265 ' + CMPLIM.minRows + ' · di bawah itu Rendah.">' +
                  esc(String(r.confidence || '').toLowerCase()) + ' \u00b7 ' + r.weakRows + ' baris</span>'
                : '') +
              ((r.verdict === 'STABIL' || r.verdict === 'INSUFFICIENT') && r.reason
                ? '<br><span class="u-text-mute fuel-cmp-reason" style="font-size:10.5px">' + esc(r.reason) + '</span>' : '')
            // Sebab yang TERLIHAT, bukan hanya tooltip — sama dengan aturan
            // kolom Status pada tabel di atas.
            : '<span class="u-text-mute">tanpa vonis \u00b7 ' + esc(r.reason) + '</span>';
          // Δ% unit INSUFFICIENT tetap DICETAK (angkanya memang ada) tapi
          // TIDAK diwarnai hijau/merah: mewarnainya memberi kesan ada
          // kesimpulan arah, padahal justru itu yang ditahan.
          var dCls = (r.deltaPct == null || r.verdict === 'STABIL' ||
              r.verdict === 'INSUFFICIENT') ? 'is-flat'
            : (r.deltaPct < 0 ? 'is-down' : 'is-up');
          // Tanda +/- SELALU dicetak: warna saja tidak terbaca oleh pengguna
          // buta warna maupun pada hasil cetak hitam-putih.
          var dTxt = r.deltaPct == null ? '\u2014'
            : (r.deltaPct < 0 ? '\u2212' : '+') + RENDER._num(Math.abs(r.deltaPct), 1) + ' %';
          return '<tr>' +
            '<td><strong>' + esc(r.lambung || r.serial || '\u2014') + '</strong>' +
              (r.lambungExact === false && r.serial
                ? ' <span class="fuel-sn-unmapped" title="SN belum terpetakan ke Nomor Lambung">SN</span>' : '') +
            '</td>' +
            '<td>' + esc(r.model || '') + '</td>' +
            // [SUPPORT 2026-10-30] Tujuh kolom pendukung, urutannya SAMA
            // dengan header di atas. Sel yang datanya tidak tersedia menulis
            // "\u2014" + sebabnya, tidak pernah 0.
            '<td class="fuel-num">' + _supAuto(r, 'hours') +
              '<br><span class="fuel-cmp-cov">' + _supDays(r) + '</span></td>' +
            '<td class="fuel-num">' + _supNum(r, 'cycles', 0) +
              // [KEJUJURAN] Cadangan jendela = angka LEBIH KECIL dari total
              // sebenarnya. Ditandai * dan dijelaskan, bukan disamarkan.
              (_isWindowBasis(r)
                ? ' <span class="u-text-mute" title="Unit ini tersimpan sebelum rekap siklus harian ada: siklus & tonase hanya dipotong lewat jendela valid, lebih kecil dari angka total. Unggah ulang unit untuk basis penuh.">*</span>' : '') +
            '</td>' +
            '<td class="fuel-num">' + _supNum(r, 'tonnage', 1) + '</td>' +
            '<td class="fuel-num">' + _supNum(r, 'distEmpty', 1) +
              _basisNote(r, 'distEmpty') + '</td>' +
            '<td class="fuel-num">' + _supNum(r, 'distLoaded', 1) +
              _basisNote(r, 'distLoaded') + '</td>' +
            '<td class="fuel-num">' + _idleCell(r) + '</td>' +
            '<td class="fuel-num">' + _gpsCell(r) + '</td>' +
            '<td class="fuel-num">' + (r.aLTk == null ? '\u2014' : RENDER._num(r.aLTk, 4)) + '</td>' +
            '<td class="fuel-num">' + (r.bLTk == null ? '\u2014' : RENDER._num(r.bLTk, 4)) + '</td>' +
            '<td class="fuel-num fuel-cmp-delta ' + dCls + '" title="' +
              esc(_deltaTitle(r)) + '">' + dTxt + '</td>' +
            // [F0b] Cetak batas yang BENAR-BENAR dipakai `compareRows()`.
            // `bandUp`/`bandDown` selalu ada sejak F0; `bandPct` hanya
            // cadangan untuk pemanggil/fixture lama.
            '<td class="fuel-num" title="' + (r.bandFromSigma
              ? 'Dari sigma(log) baseline SELURUH riwayat unit ini \u2014 bukan dari periode B'
              : 'Sigma unit tidak diketahui \u2014 dipakai pita cadangan') + '">' +
              '\u2212' + RENDER._num(r.bandDown == null ? r.bandPct : r.bandDown, 1) +
              ' \u2026 +' + RENDER._num(r.bandUp == null ? r.bandPct : r.bandUp, 1) + ' %' +
              (r.bandFromSigma ? '' : ' <span class="u-text-mute">*</span>') + '</td>' +
            // [F5 2026-10-29] Cakupan DITAMPILKAN, bukan hanya di `title`:
            // tooltip tidak terbaca di layar sentuh, tidak ikut tercetak,
            // dan tak terjangkau keyboard. "22 / 1" tanpa konteks terbaca
            // seperti dua angka setara, padahal yang satu berarti sampel
            // 30 hari dan yang lain satu pembacaan.
            '<td class="fuel-num" title="' + esc(_covTitle(r)) + '">' +
              r.aWindows + ' / ' + r.bWindows +
              '<br><span class="fuel-cmp-cov">' + _covText(r) + '</span></td>' +
            '<td>' + hasil + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    var cmpPager = $id('fuel-cmp-pagination');
    if (cmpPager) {
      cmpPager.innerHTML = res.rows.length <= cmpPageSize ? '' :
        '<button class="btn btn-ghost btn-sm" data-fuel-cmp-page="prev" ' + (cmpPage === 1 ? 'disabled' : '') + '>Sebelumnya</button>' +
        '<span>Halaman <strong>' + cmpPage + '</strong> / ' + cmpPageCount + ' · ' + res.rows.length + ' unit</span>' +
        '<button class="btn btn-ghost btn-sm" data-fuel-cmp-page="next" ' + (cmpPage === cmpPageCount ? 'disabled' : '') + '>Berikutnya</button>';
    }
  }

  /**
   * hydrateStore() -> Promise<boolean>
   *
   * [FASE 1 2026-10-30] Memuat isi IndexedDB ke MEMORI store. Dipanggil
   * SEBELUM apa pun membaca `STORE.list()`. Tanpa ini, halaman Fuel akan
   * menampilkan daftar kosong walau datanya ada di disk.
   *
   * Kegagalan TIDAK memblokir halaman: store sudah punya cadangan
   * localStorage, dan penyebabnya dilaporkan lewat toast — bukan ditelan.
   */
  var _hydratePromise = null;
  function hydrateStore() {
    if (_hydratePromise) return _hydratePromise;
    if (!STORE || typeof STORE.hydrate !== 'function') {
      _hydratePromise = Promise.resolve(false);
      return _hydratePromise;
    }
    _hydratePromise = STORE.hydrate().then(function (r) {
      if (r && r.reason) {
        toast('Penyimpanan IndexedDB tidak aktif (' + r.reason + ') — memakai penyimpanan lama dengan batas 5 MB.', 'err');
      }
      // Migrasi dari localStorage: sebut apa yang terjadi, jangan senyap.
      if (r && r.migrated && r.migrated.moved > 0) {
        toast(r.migrated.moved + ' unit dipindahkan ke penyimpanan baru (IndexedDB).', 'ok');
      }
      return true;
    }).catch(function (e) {
      _hydratePromise = null;
      toast('Gagal memuat penyimpanan Fuel: ' + ((e && e.message) || e), 'err');
      return false;
    });
    return _hydratePromise;
  }

  /**
   * reportWriteError() — tampilkan kegagalan tulis IndexedDB yang tertunda.
   * Dipanggil setelah operasi simpan/hapus. "Angka tampil di layar tetapi
   * gagal tersimpan" adalah kebohongan kecil yang paling mahal.
   */
  function reportWriteError() {
    if (!STORE || typeof STORE.takeWriteError !== 'function') return;
    var w = STORE.takeWriteError();
    if (w) toast('Gagal menyimpan ' + (w.key || 'unit') + ' ke disk: ' + w.reason, 'err');
  }

  /** Muat daftar unit yang sudah tersimpan di store (dipanggil saat open). */
  function loadStoredFleet() {
    if (!STORE || !STORE.list) return 0;
    var list = STORE.list();    var fleet = [];
    var restored = 0;
    list.forEach(function (u) {
      // [FIX 2026-10-28] Sebelumnya `result` sengaja dikosongkan sehingga
      // unit terstore TIDAK PERNAH bisa dibuka ("data terunggah tetapi
      // detail tidak bisa dilihat"). Ringkasan menyimpan jendela, baseline,
      // counts, dan gateStats — cukup untuk seluruh panel detail. Yang tidak
      // ada (per-siklus, korelasi harian) ditandai `restored` oleh
      // `fromSummary()` supaya UI jujur, bukan mengarang.
      var res = (ANALYTICS && ANALYTICS.fromSummary) ? ANALYTICS.fromSummary(u.summary) : null;
      if (res) restored++;
      fleet.push({
        key: u.key, serial: u.serial || '', model: u.model || '',
        source: u.source || '', updatedAt: u.updatedAt || null,
        result: res, cycles: [], restored: !!res,
        dailyDays: [], correlate: null,
        summary: u.summary, legacy: !!u.legacy
      });
    });
    _state.fleet = fleet;
    renderFleet();
    return restored;
  }

  /* -----------------------------------------------------------------------
   * KORELASI HARIAN — raw payload (payloadn/A0) x trend0.
   * ----------------------------------------------------------------------- */

  /**
   * buildCorrelation(res) — gabung deret HARIAN dengan trend0 per tanggal LOKAL.
   *
   * Hari `d` memakai Fuel Rate dari jendela trend0 yang MENUTUP di tanggal itu
   * (`w.date === d`). `Fuel Rate` adalah LAJU (L/jam), bukan liter; dikalikan
   * jam operasi hari itu menjadi liter hari itu.
   *
   * JANGAN memakai `Fuel Rate x 24`: jam sungguhan bervariasi (0–24 jam) dan
   * 24 h adalah asumsi yang melebihkan hari libur.
   *
   * Jendela yang gugur karena coverage/siklus MASIH DIPAKAI (Fuel Rate-nya
   * tetap pengukuran sah); jendela yang gugur karena SMR/gap/fuel-rate-null
   * TIDAK (di sana Fuel Rate tidak bisa dipercaya).
   */
  function buildCorrelation(res, dailyDays) {
    var days = dailyDays || _state.dailyDays || [];
    if (!days.length || !res || !res.windows || !ANALYTICS) return null;
    var byDay = {};
    res.windows.forEach(function (w) {
      if (w.drop && w.drop !== 'low-coverage' && w.drop !== 'low-cycles') return;
      if (w.fuelRate == null || !(w.fuelRate > 0)) return;
      var d = w.date;
      if (!byDay[d]) byDay[d] = { sum: 0, n: 0 };
      byDay[d].sum += w.fuelRate; byDay[d].n++;
    });
    var rows = days.map(function (d) {
      var f = byDay[d.day];
      return {
        day: d.day, hours: d.hours, payload: d.payload, loadedKm: d.loadedKm,
        cycles: d.cycles, rated: d.rated,
        fuelRate: f ? f.sum / f.n : null
      };
    });
    return ANALYTICS.dailyCorrelation(rows);
  }

  function run() {
    try {
      var res = analyzeTexts();
      if (!res) return;
      _state.correlate = buildCorrelation(res);
      RENDER.render(res, _state.cycles, _state.correlate);
      if (STORE) STORE.setResult(res);   // ringkasan saja; kunci fuel.*
    } catch (e) {
      toast('Gagal menganalisis: ' + (e && e.message ? e.message : e), 'err');
      if (global.console) console.error('[FUEL_APP]', e);
    }
  }

  /* -----------------------------------------------------------------------
   * Buka / tutup
   * --------------------------------------------------------------------- */
  function open() {
    OTHER_AREAS.forEach(function (id) { toggle(id, false); });
    toggle('fuel-area', true);

    // [FASE 1 2026-10-30] Muat dari IndexedDB DULU (asinkron), baru gambar.
    // `_openOnce` menjaga agar pemanggilan ganda (klik menu dua kali,
    // Fuel -> Portofolio -> Fuel) tidak memuat ulang & menimpa pilihan
    // operator yang sedang berjalan.
    if (!_openOnce) {
      _openOnce = hydrateStore().then(function () {
        finishOpen();
        return true;
      }, function () { finishOpen(); return false; });
      // Tampilkan kerangka dulu supaya layar tidak kosong selama ±50 ms.
      renderFleet();
      return;
    }
    finishOpen();
  }

  var _openOnce = null;

  /** Bagian `open()` yang SINKRON — dipisah agar mudah dibaca & diuji. */
  function finishOpen() {
    // [SATU GERBANG 2026-10-28] Data HANYA datang dari gerbang upload VHMS.
    // Ambil bila ingest berisi; bila tidak, tampilkan unit yang TERSIMPAN.
    var ingested = false;
    if (global.FUEL_INGEST && global.FUEL_INGEST.has()) {
      ingested = loadFromIngest();
    }
    if (!ingested) {
      loadStoredFleet();
      setStatus();
    }

    // [PENTING] Hanya menyembunyikan banner — TIDAK mereset data VHMS/SOS.
    var banner = $id('alert-banner');
    if (banner) banner.classList.add('hidden');

    // Tombol ekspor header tidak relevan di halaman ini.
    var rep = $id('btn-report-1');
    var prevRep = rep ? rep.style.display : '';
    if (rep) rep.style.display = 'none';

    if (global.APP_HEADER) {
      if (global.APP_HEADER.setDefaultTitle) global.APP_HEADER.setDefaultTitle();
    }
    try { document.title = 'Fuel Trending Analysis \u2014 ARPC'; } catch (e) {}

    // [HOME/DETAIL 2026-10-28] Selalu mulai di HOME: KPI + daftar unit.
    // Detail hanya dibuka bila operator mengklik satu unit.
    if (!_state.selectedKey) _state.view = 'home';
    setView(currentView(), { noScroll: true });
    renderFleet();

    setStatus();
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  function close() {
    toggle('fuel-area', false);
    var rep = $id('btn-report-1');
    if (rep) rep.style.display = '';
    // Kembalikan ke mode aktif lewat API yang SUDAH ADA (tidak menulis data).
    if (global.VHMS_SOS_MODE && typeof global.VHMS_SOS_MODE.goHome === 'function') {
      global.VHMS_SOS_MODE.goHome();
    } else if (global.VHMS_APP && typeof global.VHMS_APP.showFleetView === 'function') {
      global.VHMS_APP.showFleetView();
    }
  }

  function clearFuelData() {
    var ok = global.confirm ? global.confirm(
      'Hapus HANYA data Fuel Trending?\n\nData VHMS, SOS, dan Portofolio TIDAK tersentuh.')
      : true;
    if (!ok) return;
    if (STORE) STORE.clear();
    clearFiles();
    // [FASE 1] `clear()` mengosongkan memori seketika, tetapi penghapusan di
    // disk berjalan asinkron. Konfirmasi ke operator DITUNDA sampai disk
    // benar-benar selesai — kalau tidak, dia diberi tahu "dihapus" padahal
    // unit bisa muncul lagi setelah reload.
    var done = function () {
      reportWriteError();
      toast('Data Fuel Trending dihapus. Data VHMS/SOS tidak tersentuh.', 'ok');
    };
    if (STORE && typeof STORE.flush === 'function') STORE.flush().then(done, done);
    else done();
  }

  /* -----------------------------------------------------------------------
   * Wiring
   * --------------------------------------------------------------------- */
  function init() {
    // [MENU 2026-10-28] Pintu masuk Fuel:
    //   - `btn-fuel-nav` = menu di navigasi header (SATU-SATUNYA tombol di
    //     halaman utama). Tombol lama di toolbar Equipment List DIHAPUS atas
    //     permintaan user: dua tombol bertujuan sama pada satu layar hanya
    //     membingungkan.
    //   - `btn-fuel-sos` = pintasan di toolbar SOS, dipertahankan karena di
    //     mode SOS tidak ada menu header yang bisa dijangkau tanpa berpindah.
    ['btn-fuel-nav', 'btn-fuel-sos'].forEach(function (id) {
      var b = $id(id);
      if (b) b.addEventListener('click', open);
    });
    // [HOME/DETAIL 2026-10-28] Tombol "Kembali ke daftar" DI DALAM panel
    // detail: menutup detail tanpa perlu menggulir ke toolbar atas.
    var backList = $id('btn-fuel-back-list');
    if (backList) backList.addEventListener('click', function () { goHome(); });

    // [HOME/DETAIL 2026-10-28] Di DETAIL, tombol Kembali -> daftar (home).
    // Di HOME, tombol Kembali -> tutup modul (perilaku lama).
    var back = $id('btn-fuel-back');
    if (back) back.addEventListener('click', function () {
      if (currentView() === 'detail') goHome();
      else close();
    });

    // [SATU GERBANG 2026-10-28] Tidak ada input berkas di halaman ini.
    // Tombol di sini hanya MEMBUKA gerbang upload VHMS yang sudah ada.
    var gotoUpload = $id('btn-fuel-goto-upload');
    if (gotoUpload) gotoUpload.addEventListener('click', function () {
      close();
      if (global.VHMS_APP && typeof global.VHMS_APP.showFleetView === 'function') {
        global.VHMS_APP.showFleetView();
      }
      var pick = $id('btn-pick');   // gerbang upload VHMS yang SUDAH ADA
      if (pick && typeof pick.click === 'function') pick.click();
    });

    // Generator GPS membutuhkan server Node (`node serve.js`) karena browser
    // tidak berhak menjalankan berkas di disk. Endpoint hanya memakai sumber
    // dan keluaran baku proyek; tidak menerima path dari peramban.
    function runGpsGenerator(endpoint, button, label) {
      var status = $id('fuel-generate-status');
      if (button) button.disabled = true;
      if (status) {
        status.classList.remove('hidden');
        status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(label) + ' sedang berjalan…';
      }
      fetch(endpoint, { method: 'POST' }).then(function (response) {
        return response.json().catch(function () { return { ok: false, message: 'Respons server tidak valid.' }; });
      }).then(function (result) {
        if (!result.ok) throw new Error(result.message || 'Proses GPS gagal.');
        if (status) status.innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + esc(result.message || label + ' selesai.');
        toast(result.message || label + ' selesai.', 'ok');
      }).catch(function (err) {
        var message = err.message || 'Proses GPS gagal. Jalankan aplikasi dengan node serve.js.';
        // Batasi status layar agar log per-file yang besar tidak merusak tata letak;
        // detail lengkap tetap tersedia di terminal server.
        if (message.length > 420) message = message.slice(0, 417) + '…';
        if (status) status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + esc(message);
        toast(message, 'err');
      }).then(function () { if (button) button.disabled = false; });
    }
    var gpsAggregate = $id('btn-fuel-gps-aggregate');
    if (gpsAggregate) gpsAggregate.addEventListener('click', function () {
      runGpsGenerator('/api/gps/aggregate', gpsAggregate, 'Generate agregat GPS');
    });
    var gpsRoad = $id('btn-fuel-gps-road');
    if (gpsRoad) gpsRoad.addEventListener('click', function () {
      runGpsGenerator('/api/gps/road-derive', gpsRoad, 'Generate rute GPS');
    });

    var clearBtn = $id('btn-fuel-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearFuelData);

    // ---------------------------------------------------------------
    // Tabel "Trending Fuel Ratio List": filter, urut, buka, hapus.
    // Delegasi event di container agar tabel yang dirender ulang tetap jalan.
    // ---------------------------------------------------------------
    // Pager berada di luar elemen table; delegasi harus memakai panel agar
    // tombol pagination ikut menerima event klik.
    var ratioHost = $id('fuel-ratio-panel');
    if (ratioHost) ratioHost.addEventListener('click', function (e) {
      var t = e.target;
      // Cari elemen ber-atribut di antara target dan container.
      while (t && t !== ratioHost && !(t.getAttribute && (
        t.getAttribute('data-fuel-sort') || t.getAttribute('data-fuel-open') ||
        t.getAttribute('data-fuel-del') || t.getAttribute('data-fuel-page')))) {
        t = t.parentNode;
      }
      if (!t || t === ratioHost || !t.getAttribute) return;

      var sortKey = t.getAttribute('data-fuel-sort');
      if (sortKey) {
        // Klik kolom yang sama = balik arah; kolom lain = mulai menurun
        // (kecuali teks, yang lebih wajar menaik).
        var cur = _state.filter;
        cur.page = 1;
        if (cur.sort === sortKey) cur.dir = (cur.dir === 'desc' ? 'asc' : 'desc');
        else {
          cur.sort = sortKey;
          cur.dir = (sortKey === 'serial' || sortKey === 'model' || sortKey === 'verdict') ? 'asc' : 'desc';
        }
        renderFleet();
        return;
      }
      var pageAction = t.getAttribute('data-fuel-page');
      if (pageAction) {
        _state.filter.page = Math.max(1, (_state.filter.page || 1) + (pageAction === 'next' ? 1 : -1));
        renderFleet();
        return;
      }
      var openKey = t.getAttribute('data-fuel-open');
      if (openKey) { selectUnit(openKey); return; }
      var delKey = t.getAttribute('data-fuel-del');
      if (delKey) {
        var u = null;
        (_state.fleet || []).forEach(function (x) { if (x.key === delKey) u = x; });
        var who = (u && u.serial) || delKey;
        var okDel = global.confirm
          ? global.confirm('Hapus unit ' + who + ' dari daftar Fuel?\n\nUnit lain dan data VHMS/SOS tidak tersentuh.')
          : true;
        if (!okDel) return;
        if (STORE && STORE.removeUnit) STORE.removeUnit(delKey);
        _state.fleet = (_state.fleet || []).filter(function (x) { return x.key !== delKey; });
        if (_state.selectedKey === delKey) {
          _state.selectedKey = null;
          _state.result = null; _state.cycles = []; _state.correlate = null;
          if (RENDER) RENDER.clearAll();
        }
        // Unit terpilih hilang -> tidak ada yang bisa ditampilkan di detail.
        if (!_state.selectedKey) setView('home', { noScroll: true });
        renderFleet();
        // [FASE 1] Penghapusan di disk asinkron — laporkan bila gagal.
        if (STORE && typeof STORE.flush === 'function') STORE.flush().then(reportWriteError, reportWriteError);
        toast('Unit ' + who + ' dihapus dari Fuel.', 'ok');
      }
    });

    function bindFilter(id, key, evt) {
      var el = $id(id);
      if (!el) return;
      el.addEventListener(evt || 'change', function () {
        _state.filter[key] = el.value;
        _state.filter.page = 1;
        renderFleet();
      });
    }
    bindFilter('fuel-filter-text', 'text', 'input');
    bindFilter('fuel-filter-verdict', 'verdict');
    bindFilter('fuel-filter-model', 'model');
    bindFilter('fuel-filter-date-start', 'dateStart', 'change');
    bindFilter('fuel-filter-date-end', 'dateEnd', 'change');

    var cmpPagerHost = $id('fuel-cmp-pagination');
    if (cmpPagerHost) cmpPagerHost.addEventListener('click', function (e) {
      var button = e.target;
      while (button && button !== cmpPagerHost && !(button.getAttribute && button.getAttribute('data-fuel-cmp-page'))) {
        button = button.parentNode;
      }
      if (!button || button === cmpPagerHost) return;
      _state.compare.page = Math.max(1, (_state.compare.page || 1) +
        (button.getAttribute('data-fuel-cmp-page') === 'next' ? 1 : -1));
      renderCompare();
    });

    // [BETWEEN 2026-10-29] Rentang pembanding. Hanya `renderCompare()` yang
    // dipanggil: `renderFleet()` akan menggambar ulang tabel utama dan
    // menggeser halaman, padahal filter tabel TIDAK berubah.
    [['fuel-cmp-a-start', 'aStart'], ['fuel-cmp-a-end', 'aEnd'],
     ['fuel-cmp-b-start', 'bStart'], ['fuel-cmp-b-end', 'bEnd']].forEach(function (p) {
      var el = $id(p[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        _state.compare[p[1]] = el.value;
        // Rentang berubah = daftar baris baru: kembali ke halaman 1 supaya
        // operator tidak mendarat di halaman kosong/asing.
        _state.compare.page = 1;
        renderCompare();
      });
    });
    /* [F9 2026-10-29] Ekspor memakai `_state.compareLast` — HASIL YANG
     * SEDANG DIGAMBAR, bukan hitung ulang. Menghitung ulang di sini akan
     * membuat berkas dan layar bisa berbeda tanpa ada yang menyadarinya. */
    var cmpCsv = $id('btn-fuel-cmp-csv');
    if (cmpCsv) {
      cmpCsv.addEventListener('click', function () {
        var last = _state.compareLast;
        if (!last || !last.rows || !last.rows.length) return;
        var csv = RENDER.compareCsv(last.rows, last.ranges);
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fuel-between-' + (last.ranges.a.dateStart || 'A') + '_' +
          (last.ranges.a.dateEnd || '') + '--' + (last.ranges.b.dateStart || 'B') + '_' +
          (last.ranges.b.dateEnd || '') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }
    var cmpImage = $id('btn-fuel-cmp-image');
    if (cmpImage) cmpImage.addEventListener('click', function () {
      var last = _state.compareLast;
      if (!last || !last.rows || !last.rows.length) return;
      var rows = last.rows, W = 2400, rowH = 34, headH = 92, pad = 28;
      var canvas = document.createElement('canvas');
      canvas.width = W * 2; canvas.height = (headH + rowH * (rows.length + 1)) * 2;
      var ctx = canvas.getContext('2d'); ctx.scale(2, 2);
      ctx.fillStyle = '#0b1224'; ctx.fillRect(0, 0, W, canvas.height / 2);
      ctx.fillStyle = '#e2e8f0'; ctx.font = '700 22px system-ui';
      ctx.fillText('Perbandingan Rentang (Between)', pad, 32);
      ctx.font = '14px system-ui'; ctx.fillStyle = '#94a3b8';
      ctx.fillText('A: ' + last.ranges.a.dateStart + ' – ' + last.ranges.a.dateEnd +
        '   |   B: ' + last.ranges.b.dateStart + ' – ' + last.ranges.b.dateEnd, pad, 58);
      var cols = ['No. Lambung','Model','Operasi (jam)','Siklus','Tonase (t)','Jarak Kosong (km)',
        'Jarak Muatan (km)','Idle (jam)','Trending Elevasi','From: L/ton-km','To: L/ton-km',
        'Δ %','Pita (− … + %)','Baris From / To','Hasil'];
      var widths = [150,110,145,95,130,165,170,120,180,145,145,100,160,145,220];
      var x = pad, y = headH;
      ctx.fillStyle = '#17243b'; ctx.fillRect(0, y - 26, W, rowH);
      ctx.font = '700 13px system-ui'; ctx.fillStyle = '#cbd5e1';
      cols.forEach(function (c, i) { ctx.fillText(c, x, y - 7); x += widths[i]; });
      function val(r, i) {
        var a = [r.lambung || r.serial || '—', r.model || '—', r.hours, r.cycles,
          r.tonnage, r.distEmpty, r.distLoaded, r.idle, r.elev, r.aLTk, r.bLTk,
          r.deltaPct == null ? '—' : (r.deltaPct < 0 ? '−' : '+') + RENDER._num(Math.abs(r.deltaPct), 1) + ' %',
          '−' + RENDER._num(r.bandDown == null ? r.bandPct : r.bandDown, 1) + ' … +' + RENDER._num(r.bandUp == null ? r.bandPct : r.bandUp, 1) + ' %',
          (r.aWindows || 0) + ' / ' + (r.bWindows || 0), r.verdict || r.reason || '—'];
        return a[i] == null ? '—' : String(a[i]);
      }
      ctx.font = '13px system-ui';
      rows.forEach(function (r, ri) {
        x = pad; y += rowH; ctx.fillStyle = ri % 2 ? '#101a2d' : '#0d1729';
        ctx.fillRect(0, y - 25, W, rowH); ctx.fillStyle = '#dbeafe';
        cols.forEach(function (_, i) { ctx.fillText(val(r, i), x, y - 7); x += widths[i]; });
      });
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var name = 'fuel-between-' + (last.ranges.a.dateStart || 'A') + '_' +
          (last.ranges.b.dateEnd || 'B') + '.png';
        if (navigator.clipboard && navigator.clipboard.write && global.ClipboardItem) {
          navigator.clipboard.write([new global.ClipboardItem({'image/png': blob})])
            .then(function () { toast('Seluruh tabel Between disalin sebagai gambar.', 'ok'); })
            .catch(function () { downloadImage(blob, name); });
        } else downloadImage(blob, name);
      }, 'image/png');
    });
    function downloadImage(blob, name) {
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Clipboard tidak tersedia — gambar diunduh: ' + name, 'info');
    }

    /* [GPS 2026-10-30] Unggah berkas TRACK GPS (`gps-daily-kpi-track-*.csv`).
     * Berkas track berukuran ~400 KB/unit dan bisa ratusan, jadi pembacaan
     * dilakukan BERKELOMPOK dengan jeda supaya halaman tidak membeku.
     * Hasil disimpan di `_state.gps` (memori) dan TIDAK masuk store: agregat
     * ini selalu bisa dibuat ulang dari berkas sumber, dan menyimpannya di
     * IndexedDB akan mengunci pemakai pada versi ambang yang lama. */
    var gpsBtn = $id('btn-fuel-gps-add');
    var gpsFile = $id('fuel-gps-files');
    if (gpsBtn && gpsFile) {
      gpsBtn.addEventListener('click', function () { gpsFile.click(); });
      gpsFile.addEventListener('change', function () {
        var list = Array.prototype.slice.call(gpsFile.files || []);
        // Dikosongkan SEKARANG: memilih berkas yang sama dua kali tidak
        // memicu `change` bila `value` tidak direset.
        gpsFile.value = '';
        if (!list.length) return;
        readGpsFiles(list);
      });
    }
    var gpsGenerated = $id('btn-fuel-gps-load-generated');
    if (gpsGenerated) gpsGenerated.addEventListener('click', loadGeneratedGps);
    var gpsClear = $id('btn-fuel-gps-clear');
    if (gpsClear) {
      gpsClear.addEventListener('click', function () {
        _state.gps = null;
        _state.gpsInfo = null;
        _gpsStatus('', '');
        renderCompare();
        toast('Data GPS dilepas. Kolom elevasi dikosongkan \u2014 bukan diisi nol.', 'ok');
      });
    }

    var cmpReset = $id('btn-fuel-cmp-reset');
    if (cmpReset) cmpReset.addEventListener('click', function () {
      _state.compare = { aStart: '', aEnd: '', bStart: '', bEnd: '', page: 1 };
      ['fuel-cmp-a-start', 'fuel-cmp-a-end', 'fuel-cmp-b-start', 'fuel-cmp-b-end']
        .forEach(function (id) { var el = $id(id); if (el) el.value = ''; });
      renderCompare();
    });

    var cardsHostEl = $id('fuel-baseline-cards');
    if (cardsHostEl) cardsHostEl.addEventListener('click', function (e) {
      var card = e.target;
      while (card && card !== cardsHostEl && !(card.getAttribute && card.getAttribute('data-fuel-card'))) {
        card = card.parentNode;
      }
      if (!card || card === cardsHostEl) return;
      var detail = card.querySelector('.fuel-card-detail');
      if (!detail) return;
      var open = detail.hasAttribute('hidden');
      if (open) detail.removeAttribute('hidden'); else detail.setAttribute('hidden', '');
      card.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // ---------------------------------------------------------------
    // RINGKASAN BASELINE (statistik metrik + chip status) — delegasi.
    // Kartu metrik memakai kelas .fuel-card (tampilan sama dengan kartu
    // interaktif di atasnya), tetapi handler-nya di sini: kartu itu
    // membuka rumus + penjelasan, bukan rentang distribusi per jendela.
    // Chip status = filter tabel jendela (aria-pressed + renderTable).
    // ---------------------------------------------------------------
    var summaryHost = $id('fuel-summary');
    if (summaryHost) summaryHost.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== summaryHost && !(t.getAttribute && (
        t.getAttribute('data-fuel-metric') || t.getAttribute('data-fuel-verdict')))) {
        t = t.parentNode;
      }
      if (!t || t === summaryHost || !t.getAttribute) return;

      var vKey = t.getAttribute('data-fuel-verdict');
      if (vKey) {
        // Klik chip yang sedang aktif = lepas filter (tampilkan semua).
        var active = t.getAttribute('aria-pressed') === 'true';
        if (RENDER && RENDER.setVerdictFilter) RENDER.setVerdictFilter(active ? null : vKey);
        // `render()` menggambar ULANG #fuel-summary (chip aktif & panel bantuan
        // ikut hilang), jadi metrik yang sedang terbuka diingat lalu dipulihkan.
        // Dibaca via `dataset` — getAttribute('data-key') mengembalikan nilai
        // atribut canonical `dataKey` (null), sehingga panel tidak pulih.
        var reopen = $id('fuel-summary') && $id('fuel-summary').querySelector('.fuel-metric-help');
        var reopenKey = (reopen && reopen.dataset) ? reopen.dataset.key : null;
        if (RENDER && RENDER.render) RENDER.render(_state.result, _state.cycles, _state.correlate);
        if (reopenKey && RENDER.metricHelp) {
          var again = $id('fuel-summary').querySelector('[data-fuel-metric="' + reopenKey + '"]');
          var info = RENDER.metricHelp(reopenKey);
          if (again && info) openMetricHelp(info, again, reopenKey);
        }
        return;
      }

      var mKey = t.getAttribute('data-fuel-metric');
      if (!mKey || !RENDER || !RENDER.metricHelp) return;
      var help = RENDER.metricHelp(mKey);
      if (help) openMetricHelp(help, t, mKey);
    });

    /**
     * openMetricHelp(help, anchor, key) — panel rincian di bawah kartu metrik.
     * Inline (bukan modal) agar user tetap melihat angka sambil membaca
     * rumus; satu panel saja, klik kartu lain memindahkannya (klik kartu
     * yang sama menutupnya).
     */
    function openMetricHelp(help, anchor, key) {
      var host = $id('fuel-summary');
      if (!host || !anchor) return;
      var panel = host.querySelector('.fuel-metric-help');
      var same = panel && panel.dataset && panel.dataset.key === key;
      if (panel) panel.parentNode.removeChild(panel);
      // Kartu lain dipastikan tertutup (satu panel pada satu waktu).
      var all = host.querySelectorAll('.fuel-metric');
      for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-expanded', 'false');
      if (same) return;
      anchor.setAttribute('aria-expanded', 'true');
      var box = global.document.createElement('div');
      box.className = 'fuel-metric-help';
      box.dataset.key = key || '';
      box.setAttribute('data-for', help.title);
      box.innerHTML =
        '<div class="fuel-metric-help-head">' +
          '<strong>' + esc(help.title) + '</strong>' +
          '<span class="u-text-mute"> \u00b7 ' + esc(help.note) + '</span>' +
        '</div>' +
        '<div class="fuel-card-eq">' + esc(help.formula) + '</div>' +
        (help.detail ? '<p class="fuel-metric-help-text">' + esc(help.detail) + '</p>' : '');
      // Sisipkan tepat SETELAH baris kartu metrik.
      var row = host.querySelector('.fuel-metric-row');
      if (row && row.nextSibling) host.insertBefore(box, row.nextSibling);
      else host.appendChild(box);
    }

    var clearBtn = $id('btn-fuel-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearFuelData);
  }

  var FUEL_APP = {
    init: init,
    open: open,
    close: close,
    run: run,
    clearFiles: clearFiles,
    clearFuelData: clearFuelData,
    // [MULTI 2026-10-28] fleet: proses banyak unit + tabel summary.
    processUnits: processUnits,
    selectUnit: selectUnit,
    renderFleet: renderFleet,
    // [BETWEEN 2026-10-29] Panel pembanding dua rentang.
    renderCompare: renderCompare,
    // [HOME/DETAIL 2026-10-28] 'home' | 'detail'.
    setView: setView,
    currentView: currentView,
    goHome: goHome,
    loadStoredFleet: loadStoredFleet,
    // [WILAYAH UJI]
    analyzeUnit: analyzeUnit,
    roleOfText: roleOfText,
    buildCorrelation: buildCorrelation,
    // [SUPPORT 2026-10-30] Pembentuk sel kolom pendukung — diekspor supaya
    // "null dicetak \u2014, bukan 0" bisa diuji tanpa DOM.
    _pairNum: _pairNum,
    _pairAuto: _pairAuto,
    _supDays: _supDays,
    _isWindowBasis: _isWindowBasis,
    // [SUPPORT 2026-10-30] Penanda * untuk unit yang ringkasannya belum
    // memuat dE/dL/idle. Diekspor agar "null -> bertanda, 0 -> tidak" diuji
    // tanpa DOM.
    _basisNote: _basisNote,
    _state: function () { return _state; }
  };

  global.FUEL_APP = FUEL_APP;
  if (typeof module !== 'undefined' && module.exports) module.exports = FUEL_APP;

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init);
  }

})(typeof window !== 'undefined' ? window : globalThis);

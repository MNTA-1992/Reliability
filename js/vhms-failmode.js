/* ============================================================================
 * [FITUR 2026-10-16] FAILURE MODE SUMMARY — grid multi-chart per unit
 * ----------------------------------------------------------------------------
 * Grid 3 kolom: satu panel = satu mode kegagalan, berisi 1..4 trend parameter
 * VHMS + garis threshold putus-putus (warn/crit). Dipicu tombol "Failure Mode"
 * di baris Filter Cepat Equipment List (index.html), tepat di kanan dropdown
 * Kompartemen, lalu tampil sebagai modal `#failmode-modal`.
 *
 * Kontrak data (TIDAK ada parser baru — semua sudah ada di `analysis`):
 *   analysis.records        Array baris CSV mentah (per baris ada `calendar`,
 *                           `smr`, `_src`, dan satu nilai per key cfg.PARAMS)
 *   analysis.thresholdSet   Threshold efektif (family + override model).
 *                           WAJIB dipakai — `cfg.THRESHOLDS` mentah mengabaikan
 *                           override model (mis. D375A coolantTemp 98 vs 95).
 *   analysis.meta           { productGroup, model, serial, ... }
 *
 * Jebakan yang sengaja ditangani (lihat docs/SPEK-FAILURE-MODE-SUMMARY.md §6):
 *   1. Threshold      -> analysis.thresholdSet, bukan cfg.THRESHOLDS
 *   2. Garis threshold-> dataset array konstan (x-axis CATEGORY, bukan linear)
 *   3. innerHTML grid -> destroy dulu + jaring Chart.getChart(canvas)
 *   4. Sumber campur  -> recordsFor() memilih `_src` dominan per parameter
 *   5. Modal tersembunyi -> resize() setelah 60ms
 * ========================================================================== */
(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  var _ui = global.UI_UTIL || {};
  var esc = _ui.esc || function (s) { return String(s == null ? '' : s); };
  var fmt = _ui.fmt || function (v, d) { return String(v); };
  var fmtInt = _ui.fmtInt || function (v) { return String(v); };

  /* ------------------------------------------------------------------------
   * 1. Definisi Failure Mode — semua key WAJIB ada di cfg.PARAMS.
   *    Palet warna dipakai berurutan sesuai index di `params`.
   * ---------------------------------------------------------------------- */
  // [REVISI 2026-10-16] Palet seri dibuat VARIATIF dan TIDAK memakai MERAH.
  // Alasan: garis threshold "Critical" sudah berwarna merah; bila seri data
  // juga merah, keduanya sulit dibedakan dan grid tampak "dominan merah".
  // Enam hue dipilih agar berdekatan-tidak-sama di latar gelap, dan dua seri
  // pertama (paling sering dipakai: coolant/oil, area/load) sudah kontras.
  // Dua warna terakhir (`#e879f9` fuchsia, `#94a3b8` slate) jarang terpakai —
  // hanya bila sebuah kartu benar-benar punya >6 seri berdata.
  var SERIES_COLORS = ['#38bdf8', '#a3e635', '#f59e0b', '#c084fc',
                       '#2dd4bf', '#fb923c', '#e879f9', '#94a3b8'];

  // URUTAN ARRAY = URUTAN RENDER kartu di grid. Sembilan entri pertama adalah
  // susunan yang diminta operator untuk HD785 (truk) — unit itu hanya punya
  // data untuk kesembilan kartu tsb, sehingga grid 3x3-nya persis urutan ini.
  // Kartu khusus dozer/excavator (overload, top end, hidrolik, pump) diletakkan
  // SETELAHNYA; untuk HD785 keempatnya otomatis hilang (visibleModes -> hasData).
  var FAILURE_MODES = [
    { id: 'fm-overheat',  title: 'Engine Overheat',                 pillar: 'COOLING',
      params: ['coolantTemp', 'engOilTemp'] },
    { id: 'fm-bearing',   title: 'E/G Bearing Wear',                pillar: 'ENGINE',
      // E/G Bearing = tekanan oli mesin. H-Min & L-Min (D375A/PC2000) atau
      // Max (HD785, kolom `E.Oil P.Max`) — `visibleModes()` memakai yang ada.
      params: ['oilPressHMin', 'oilPressMin', 'oilPressMax'] },
    { id: 'fm-ring',      title: 'Piston Ring Wear',                pillar: 'ENGINE',
      params: ['blowbyMax'] },
    { id: 'fm-turbo',     title: 'Turbo Wear',                      pillar: 'ENGINE',
      params: ['boostMax'] },
    // Gas buang HD785 memakai SUHU EGT ABSOLUT (°C) dari berkas trend utama
    // `'40'` (header `LF/LR/RF/RR Exh.Temp Max`), BUKAN duty `% jendela` dari
    // chas_trend. Nilai <= 0 dibuang parser (sensor rusak -> `minValid`),
    // jadi kartu ini bersih dari spike negatif.
    { id: 'fm-exhduty',   title: 'Exhaust Temperature',             pillar: 'ENGINE',
      params: ['lfExhTempMax', 'lrExhTempMax', 'rfExhTempMax', 'rrExhTempMax'] },
    // [REVISI 2026-10-16] T/M Oil (oli transmisi) DIGABUNG ke sini sesuai
    // permintaan operator — satu kartu menampilkan tekanan oli mesin, suhu
    // oli mesin, dan suhu oli transmisi sekaligus.
    { id: 'fm-oilcooler', title: 'Oil Cooler Fouling/Contamination', pillar: 'ENGINE',
      params: ['oilPressMax', 'engOilTemp', 'tmOilTempMax'] },
    // Keausan clutch pack: fill time per posisi gigi (1-4) + arah mundur (R).
    { id: 'fm-transm',    title: 'Transmission Clutch Wear',        pillar: 'POWERTRAIN',
      params: ['tmFill1', 'tmFill2', 'tmFill3', 'tmFill4', 'tmFillR'] },
    // [REVISI 2026-10-16] TEKANAN REM F/R (HD785, trend0 `F/R Brake P.Max`)
    // — menggantikan kartu "Retarder/Brake Thermal Duty" (yang memakai duty
    // detik dari chas_trend). Tekanan rem = indikator KESELAMATAN langsung.
    { id: 'fm-brakepress', title: 'Retarder/Brake Pressure',        pillar: 'BRAKE',
      params: ['fBrakePressMax', 'rBrakePressMax'] },
    // Konsumsi bahan bakar — indikator ekonomi & penurunan efisiensi.
    { id: 'fm-fuel',      title: 'Fuel Consumption',                pillar: 'ECONOMY',
      params: ['fuelRate'] },

    // ----------------------------------------------------------------------
    // Kartu di bawah TIDAK muncul di HD785 (kolomnya tidak ada di ekspor truk).
    // ----------------------------------------------------------------------
    // [REVISI 2026-10-17] Kartu "Engine Overload" (`fm-overload`,
    // `engPowerAve`/`engPowerMax`) DIHAPUS atas permintaan operator.
    { id: 'fm-topend',    title: 'Top End Wear',                    pillar: 'ENGINE',
      // Bank F/R = dozer (D375A); LBF/LBR/RBF/RBR = excavator (PC2000).
      // EGT truk (LF/LR/RF/RR) sengaja TIDAK di sini — sudah punya kartu
      // "Exhaust Temperature" sendiri agar tidak duplikat.
      params: ['fExhTempMax', 'rExhTempMax',
               'lbfExhTempMax', 'lbrExhTempMax', 'rbfExhTempMax', 'rbrExhTempMax'] },
    { id: 'fm-hydheat',   title: 'Hyd Overheat',                    pillar: 'HYDRAULIC',
      // [REVISI 2026-10-17] +`ptoTempMax` (PTO Temp Max): suhu sistem
      // fan/PTO hidrolik. Satu keluarga panas dgn oli hidrolik → ditaruh di
      // kartu "Hyd Overheat". Kolom ini hanya ada di ekspor excavator (PC2000);
      // model tanpa kolomnya otomatis ter-hide oleh `hasData`.
      params: ['hydTempAve', 'hydTempMax', 'ptoTempMax'] },
    { id: 'fm-pump',      title: 'Pump Wear',                       pillar: 'HYDRAULIC',
      params: ['pump1F', 'pump1R', 'pump2F', 'pump2R'] }
    // [REVISI 2026-10-16] Kartu "T/M Oil Overheat" DIHAPUS — parameternya
    // (tmOilTempMax) pindah ke "Oil Cooler Fouling/Contamination".
    // [REVISI 2026-10-16] Kartu "T/C Oil Thermal Duty" (`fm-tcduty`,
    // `tcOilOver140`) DIHAPUS atas permintaan operator: nilainya DETIK
    // AKUMULATIF mentah (tidak dinormalkan ke % jendela seperti *ExhOver*),
    // sehingga grafiknya datar dan ambang 300 s selalu "critical" palsu.
  ];

  // Instance chart per id panel. Dibersihkan di destroyAll() tiap re-render.
  var charts = {};

  /* ------------------------------------------------------------------------
   * 1b. PARAMETER KHUSUS PER KELUARGA (model override)
   * ----------------------------------------------------------------------
   * [REVISI 2026-10-17] Permintaan operator: susunan kartu/parameter model
   * D375A (DOZER) disamakan dengan HD785 (TRUCK) — sejauh datanya tersedia.
   *
   * Masalahnya: daftar `params` di atas dipakai BERSAMA lintas model, jadi
   * menambah param di sana justru MENGUBAH model lain. Contoh: HD785 mengekspor
   * `tmFill*` DAN `tmTrgTime*` sekaligus, sehingga menaruh keduanya di
   * `fm-transm` membuat kartu HD785 melonjak dari 5 → 9 seri. Itu BUKAN yang
   * diminta.
   *
   * Karena itu override di bawah mengganti `params` HANYA untuk keluarga
   * tertentu (kunci = id keluarga dari `VHMS_PROFILES.detectFamily`):
   *   - Kartu & urutannya = susunan HD785 (kotak grid sama).
   *   - Isi tiap kartu = param yang BENAR-BENAR ada di ekspor keluarga itu.
   * Kartu tanpa data tetap auto-hide (`hasData`), jadi dozer tidak menampilkan
   * "Retarder/Brake Pressure" (tidak mengekspor tekanan rem).
   * ---------------------------------------------------------------------- */
  var FAMILY_PARAMS = {
    DOZER: {
      // EGT: dozer memakai bank F/R (`F/R Exh.Temp Max`), bukan sudut LF/LR/
      // RF/RR truk — tapi kartunya SAMA dgn HD785 ("Exhaust Temperature").
      'fm-exhduty':   ['fExhTempMax', 'rExhTempMax'],
      // Oli powertrain: dozer mengekspor suhu oli TORQUE CONVERTER
      // (`tcOilTempMax`), bukan oli transmisi truk (`tmOilTempMax`).
      'fm-oilcooler': ['oilPressMax', 'engOilTemp', 'tcOilTempMax'],
      // Keausan clutch: dozer mengekspor `tmTrgTime*` (trigger time arah F/R
      // & gigi 1-3), bukan `tmFill*` (fill time) milik truk.
      'fm-transm':    ['tmTrgTime1', 'tmTrgTime2', 'tmTrgTime3',
                       'tmTrgTimeF', 'tmTrgTimeR'],
      // "Top End Wear" (bank F/R) kini DUPLIKAT dgn "Exhaust Temperature" di
      // atas → demi susunan seragam HD785, kartu ini dibuang untuk DOZER.
      'fm-topend':    []
    },
    EXCAVATOR: {
      // [REVISI 2026-10-17] PC2000: EGT-nya (`lbf/lbr/rbf/rbrExhTempMax`) masuk
      // ke kartu "Top End Wear" (di ATAS), jadi kartu "Exhaust Temperature"
      // (yang khusus sudut LF/LR/RF/RR truk) DIBUANG untuk excavator.
      'fm-exhduty':   []
    }
  };

  /* ------------------------------------------------------------------------
   * 1c. URUTAN KARTU KHUSUS PER KELUARGA
   * ----------------------------------------------------------------------
   * [REVISI 2026-10-17]
   *   - DOZER: kartu "Fuel Consumption" ditaruh PALING AKHIR (pojok kanan
   *     bawah grid) karena D375A punya kartu khas dozer "Hyd Overheat".
   *   - EXCAVATOR (PC2000): urutan kartu DIPAKU penuh sesuai permintaan
   *     operator, dari kiri-atas sampai kanan-bawah:
   *       Engine Overheat · E/G Bearing · Piston Ring · Turbo · Top End Wear ·
   *       Oil Cooler · Hyd Overheat · Pump Wear · Fuel Consumption
   *     Id yang tidak berdata tetap dibuang oleh `hasData` (mis. Oil Cooler
   *     untuk unit tanpa kolom terkait).
   */
  var FAMILY_ORDER_END = {
    DOZER: ['fm-fuel']
  };
  var FAMILY_ORDER_ALL = {
    EXCAVATOR: ['fm-overheat', 'fm-bearing', 'fm-ring', 'fm-turbo', 'fm-topend',
                'fm-oilcooler', 'fm-hydheat', 'fm-pump', 'fm-fuel']
  };

  /** Keluarga model dari metadata analysis (via VHMS_PROFILES bila ada). */
  function familyOf(analysis) {
    var meta = (analysis && analysis.meta) || {};
    if (global.VHMS_PROFILES && global.VHMS_PROFILES.detectFamily) {
      return global.VHMS_PROFILES.detectFamily(meta);
    }
    var m = String(meta.model || '').toUpperCase();
    if (m.indexOf('D') === 0) return 'DOZER';
    if (m.indexOf('HD') === 0) return 'TRUCK';
    if (m.indexOf('PC') === 0) return 'EXCAVATOR';
    return 'UNKNOWN';
  }

  /* ------------------------------------------------------------------------
   * 2. Helper data
   * ---------------------------------------------------------------------- */

  /** Nilai numerik valid? (null/undefined/NaN dianggap kosong). */
  function _isNum(v) { return v !== null && v !== undefined && !isNaN(v); }

  /** Deskripsi meta parameter (label/unit/decimals) dengan fallback aman. */
  function paramMeta(key) {
    return (cfg && cfg.PARAMS && cfg.PARAMS[key]) || { label: key, unit: '', decimals: 1 };
  }

  /** Desimal default untuk key tsb (untuk label garis threshold). */
  function metaDec(key) {
    var m = cfg && cfg.PARAMS && cfg.PARAMS[key];
    return (m && m.decimals !== null && m.decimals !== undefined) ? m.decimals : 1;
  }

  /**
   * Ada minimal satu nilai valid untuk `paramKey` di SELURUH record?
   * Meniru idiom `pillarKpiColumns()` (js/vhms-render.js) — kolom/panel tanpa
   * data dibuang, bukan ditampilkan kosong.
   */
  function hasData(analysis, paramKey) {
    var recs = (analysis && analysis.records) || [];
    for (var i = 0; i < recs.length; i++) {
      if (_isNum(recs[i][paramKey])) return true;
    }
    return false;
  }

  /**
   * Pilih record dari SATU jenis berkas (`_src`) yang paling banyak memuat
   * `paramKey`. Satu unit bisa memuat beberapa tipe file ('40' trend,
   * '81' tm_trend, '86' chas_trend); menggambar param '81' di atas SELURUH
   * record menghasilkan grafik hampir kosong (mayoritas null).
   */
  function recordsFor(analysis, paramKey) {
    var all = (analysis && analysis.records) || [];
    var bySrc = {};
    all.forEach(function (r) {
      if (!_isNum(r[paramKey])) return;
      var s = r._src || '40';
      bySrc[s] = (bySrc[s] || 0) + 1;
    });
    var best = null, bestN = 0;
    Object.keys(bySrc).forEach(function (s) {
      if (bySrc[s] > bestN) { bestN = bySrc[s]; best = s; }
    });
    if (!best) return [];
    return all.filter(function (r) { return (r._src || '40') === best; });
  }

  /**
   * Daftar param EFEKTIF sebuah kartu untuk unit ini: pakai override keluarga
   * (`FAMILY_PARAMS`) bila ada, jika tidak pakai `params` bawaan. Hasil kosong
   * (`[]`) berarti kartu sengaja dibuang untuk keluarga itu.
   */
  function paramsFor(mode, family) {
    var ov = FAMILY_PARAMS[family];
    if (ov && Object.prototype.hasOwnProperty.call(ov, mode.id)) {
      return ov[mode.id];
    }
    return mode.params;
  }

  /**
   * Failure mode yang layak ditampilkan untuk unit ini: buang param tanpa data
   * dan buang panel yang seluruh param-nya kosong (mis. D375A tanpa kolom Pump,
   * PC2000 tanpa kolom TM Main P.). Param ditentukan per-keluarga agar susunan
   * D375A dapat disamakan dengan HD785 tanpa mengubah HD785.
   */
  function visibleModes(analysis) {
    var out = [];
    if (!analysis) return out;
    var family = familyOf(analysis);
    FAILURE_MODES.forEach(function (m) {
      var keys = paramsFor(m, family).filter(function (k) {
        return cfg.PARAMS && cfg.PARAMS[k] && hasData(analysis, k);
      });
      if (keys.length) {
        out.push({ id: m.id, title: m.title, pillar: m.pillar, params: keys });
      }
    });

    // (a) URUTAN PENUH per-keluarga (mis. PC2000): susun ulang `out` PERSIS
    //     mengikuti daftar id; id yang tidak berdata otomatis tak ada di `out`
    //     sementara id di luar daftar tetap diletakkan setelahnya.
    var fullOrder = FAMILY_ORDER_ALL[family];
    if (fullOrder && fullOrder.length) {
      var byId = {};
      out.forEach(function (m) { byId[m.id] = m; });
      var ordered = [], seen = {};
      fullOrder.forEach(function (id) {
        if (byId[id]) { ordered.push(byId[id]); seen[id] = 1; }
      });
      out.forEach(function (m) { if (!seen[m.id]) ordered.push(m); });
      out = ordered;
    }

    // (b) Pindahkan kartu yang diminta ke posisi PALING AKHIR untuk keluarga
    //     ini (mis. "Fuel Consumption" di D375A -> pojok kanan bawah grid).
    var endIds = FAMILY_ORDER_END[family];
    if (endIds && endIds.length) {
      var tail = [];
      endIds.forEach(function (id) {
        for (var i = out.length - 1; i >= 0; i--) {
          if (out[i].id === id) { tail.unshift(out.splice(i, 1)[0]); }
        }
      });
      out = out.concat(tail);
    }
    return out;
  }

  /* ------------------------------------------------------------------------
   * 3. Bangun dataset Chart.js dari satu failure mode
   * ---------------------------------------------------------------------- */
  function buildDatasets(analysis, mode) {
    // X-axis CATEGORY (label = SMR) supaya konsisten dengan renderCharts().
    // Konsekuensi: garis threshold TIDAK boleh pakai trik {x:-Infinity} —
    // itu hanya jalan pada x-axis linear. Pakai array konstan sepanjang label.
    var base = recordsFor(analysis, mode.params[0]);
    var labels = base.map(function (r) { return fmtInt(r.smr); });
    var dates = base.map(function (r) { return r.calendar && r.calendar.display; });

    var TH = (analysis && analysis.thresholdSet) || (cfg && cfg.THRESHOLDS) || {};
    var datasets = [];

    // (a) Seri data tiap parameter.
    mode.params.forEach(function (key, i) {
      var meta = paramMeta(key);
      var label = meta.label + (meta.unit ? ' (' + meta.unit + ')' : '');
      datasets.push({
        label: label,
        data: base.map(function (r) { return _isNum(r[key]) ? r[key] : null; }),
        borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
        backgroundColor: 'transparent',
        borderWidth: 1.6,
        pointRadius: 0,
        tension: 0.15,
        spanGaps: true
      });
    });

    // (b) Garis threshold warn/crit — satu pasang per param yang punya threshold,
    //     de-dup agar dua param dengan nilai sama tidak menumpuk.
    //     `mode:'low'` (mis. oilPressHMin) -> crit < warn; warna tetap (warn
    //     amber, crit merah), hanya posisi relatif garis yang otomatis terbalik.
    var seen = {};
    var LINES = [
      { lvl: 'warn', color: 'rgba(245,158,11,.75)', dash: [6, 4] },
      { lvl: 'crit', color: 'rgba(239,68,68,.75)',  dash: [4, 3] }
    ];
    mode.params.forEach(function (key) {
      var th = TH[key];
      if (!th) return;
      var dec = metaDec(key);
      LINES.forEach(function (line) {
        var val = th[line.lvl];
        if (!_isNum(val)) return;
        var sig = line.lvl + ':' + val;
        if (seen[sig]) return;
        seen[sig] = 1;
        var arr = [];
        for (var j = 0; j < labels.length; j++) arr.push(val);
        datasets.push({
          label: (line.lvl === 'warn' ? 'Warning ' : 'Critical ') + fmt(val, dec),
          data: arr,
          borderColor: line.color,
          borderWidth: 1.4,
          borderDash: line.dash,
          pointRadius: 0,
          fill: false,
          spanGaps: true,
          _isThreshold: true            // ditandai agar tidak muncul di tooltip
        });
      });
    });

    return { labels: labels, dates: dates, datasets: datasets };
  }

  /* ------------------------------------------------------------------------
   * 4. Legend HTML ringkas (Chart.js legend dimatikan)
   * ---------------------------------------------------------------------- */
  function renderLegend(mode, built) {
    var el = document.getElementById(mode.id + '-legend');
    if (!el) return;
    var html = '';
    mode.params.forEach(function (key, i) {
      var meta = paramMeta(key);
      html += '<span><span class="dot" style="background:' +
              SERIES_COLORS[i % SERIES_COLORS.length] + '"></span>' +
              esc(meta.label) + (meta.unit ? ' (' + esc(meta.unit) + ')' : '') + '</span>';
    });
    el.innerHTML = html;
  }

  /* ------------------------------------------------------------------------
   * 5. Teardown — WAJIB sebelum menimpa innerHTML grid
   * ---------------------------------------------------------------------- */
  function destroyAll() {
    Object.keys(charts).forEach(function (id) {
      if (charts[id]) { try { charts[id].destroy(); } catch (e) {} }
      delete charts[id];
      // Jaring pengaman: instance yatim (canvas dipakai ulang) -> "Canvas is
      // already in use". Pola sama dengan destroyChart() di vhms-cross-render.js.
      var canvas = document.getElementById(id);
      if (canvas && global.Chart && global.Chart.getChart) {
        var inst = global.Chart.getChart(canvas);
        if (inst) { try { inst.destroy(); } catch (e) {} }
      }
    });
  }

  /* ------------------------------------------------------------------------
   * 6. Render grid untuk satu analysis
   * ---------------------------------------------------------------------- */
  /**
   * Ukur legend TERPANJANG di seluruh kartu, lalu pakai tingginya sebagai
   * tinggi SERAGAM untuk semua legend -> tinggi kartu pun seragam dan
   * proporsional (legend 1..N baris muat penuh, tidak terpotong).
   *
   * Trik: legend diukur pada LEBAR AKHIRNYA. Karena tinggi legend bergantung
   * pada lebar kolom (grid belum tentu sudah ter-layout saat fungsi dipanggil),
   * kita paku dulu lebar tiap legend ke lebar panelnya, longgarkan tinggi ke
   * `auto`, ukur max `scrollHeight`, lalu set `--fm-legend-h` dan `--fm-card-h`
   * (legend + sisa tetap untuk judul + padding + chart). Chart.js lalu di-resize
   * agar mengisi ruang sisa. Fallback angka dipakai bila grid belum berukuran.
   */
  function layoutGrid() {
    var grid = document.getElementById('failmode-grid');
    if (!grid) return;
    var panels = grid.querySelectorAll('.chart-panel');
    if (!panels.length) return;

    var LEGEND_MIN = 30;   // ~2 baris @ font 11px (fallback sebelum JS jalan)
    var CHART_MIN = 150;   // tinggi minimum area chart agar trend tetap terbaca
    var CHROME = 62;       // judul (19) + margin (6) + padding kartu (24) +
                           // margin legend (4) + kelonggaran (9)

    var maxLegend = 0;
    Array.prototype.forEach.call(panels, function (p) {
      var leg = p.querySelector('.failmode-legend');
      if (!leg) return;
      // Pakai lebar final panel (di-dikurangi padding 12px x2) supaya wrap
      // baris legend identik dengan hasil render nanti.
      var w = p.clientWidth ? (p.clientWidth - 24) : 0;
      leg.style.height = 'auto';
      leg.style.overflow = 'visible';
      if (w > 0) leg.style.width = w + 'px';
      var h = leg.scrollHeight || leg.getBoundingClientRect().height;
      leg.style.height = '';
      leg.style.width = '';
      leg.style.overflow = '';
      if (h > maxLegend) maxLegend = h;
    });

    if (maxLegend < LEGEND_MIN) maxLegend = LEGEND_MIN;
    maxLegend = Math.ceil(maxLegend);
    var cardH = maxLegend + CHART_MIN + CHROME;

    grid.style.setProperty('--fm-legend-h', maxLegend + 'px');
    grid.style.setProperty('--fm-card-h', cardH + 'px');
  }

  /* ------------------------------------------------------------------------
   * 6b. [FITUR 2026-10-17] RESULT DESCRIPTION — konsep sama dengan SOS
   * ----------------------------------------------------------------------
   * Bedanya terletak pada SUMBER BUKTI, karena fisika datanya memang berbeda:
   *
   *   SOS  : korelasi antar UNSUR dalam satu sampel oli (Fe+Cr, Cu+Pb+Sn).
   *          Satu unsur ekstrem sendirian = pencilan, maka ada gerbang
   *          korelasi yang menahan kartu di Normal.
   *   VHMS : deret waktu per PARAMETER (339 record pada unit contoh). Yang
   *          mendiagnosis bukan "berapa unsur yang naik bersamaan", melainkan
   *          SEBERAPA SERING & SEBERAPA JAUH nilai melewati ambang sepanjang
   *          jendela. Jadi tidak ada gerbang korelasi di sini — menirunya
   *          akan membuang informasi yang justru dimiliki VHMS.
   *
   * Sumber: `analysis.anomalies` (sudah dihitung vhms-analytics; memuat
   * status/value/warn/crit/slope/rul per parameter). Kartu dianggap melewati
   * threshold bila SALAH SATU parameternya punya anomali != NORMAL.
   *
   * MURNI (tanpa DOM) agar dapat diuji di Node.
   * @param {object} analysis
   * @param {object[]} modes hasil visibleModes(analysis)
   * @returns {object|null} { crit[], caut[], text, worst } atau null
   * ---------------------------------------------------------------------- */
  function buildDescription(analysis, modes) {
    if (!analysis || !modes || !modes.length) return null;
    var anoms = analysis.anomalies || [];
    if (!anoms.length) return null;

    // Indeks anomali per parameter agar pemetaan ke kartu murah.
    var byParam = {};
    anoms.forEach(function (a) {
      if (!a || !a.param || a.status === 'NORMAL') return;
      byParam[a.param] = a;
    });

    var RANK = { NORMAL: 0, CAUTION: 1, CRITICAL: 2 };
    var hits = [];
    modes.forEach(function (m) {
      var mine = m.params.map(function (k) { return byParam[k]; })
                         .filter(function (a) { return !!a; });
      if (!mine.length) return;
      mine.sort(function (a, b) { return RANK[b.status] - RANK[a.status]; });
      hits.push({
        id: m.id, title: m.title, pillar: m.pillar,
        status: mine[0].status, anomalies: mine
      });
    });
    if (!hits.length) return null;

    hits.sort(function (a, b) { return RANK[b.status] - RANK[a.status]; });
    var crit = hits.filter(function (h) { return h.status === 'CRITICAL'; });
    var caut = hits.filter(function (h) { return h.status === 'CAUTION'; });
    var worst = hits[0];
    var wa = worst.anomalies[0];

    var t = '';
    if (crit.length) {
      t += crit.length + ' pola kegagalan berstatus <strong>Critical</strong>' +
           (caut.length ? ' dan ' + caut.length + ' berstatus <strong>Caution</strong>' : '') +
           ' melewati ambang pada unit ini. ';
    } else {
      t += caut.length + ' pola kegagalan berstatus <strong>Caution</strong> ' +
           'melewati ambang pada unit ini. ';
    }
    t += 'Yang paling mendesak: <strong>' + esc(worst.title) + '</strong> — ' +
         '<strong>' + esc(wa.label || wa.param) + '</strong> mencapai ' +
         fmt(wa.value, 2) + (wa.unit ? ' ' + esc(wa.unit) : '') +
         ' terhadap ambang ' + (wa.status === 'CRITICAL' ? 'critical ' + fmt(wa.crit, 2)
                                                          : 'warning ' + fmt(wa.warn, 2)) +
         (wa.calendar && wa.calendar.display ? ' (' + esc(wa.calendar.display) + ')' : '') + '. ';

    // Parameter pendorong lain — dedup, Critical lebih dulu, maksimum 5.
    var seen = {}, drivers = [];
    hits.forEach(function (h) {
      h.anomalies.forEach(function (a) {
        if (seen[a.param]) return;
        seen[a.param] = 1; drivers.push(a);
      });
    });
    if (drivers.length > 1) {
      t += 'Parameter lain yang melewati ambang: ' +
        drivers.slice(1, 6).map(function (a) {
          return '<strong>' + esc(a.label || a.param) + '</strong> ' + fmt(a.value, 2) +
                 (a.unit ? ' ' + esc(a.unit) : '');
        }).join(', ') + '. ';
    }

    // Sisa umur (RUL) terpendek — hanya bila analytics berhasil menghitungnya.
    var rul = null;
    drivers.forEach(function (a) {
      if (a.rul && _isNum(a.rul.hours) && a.rul.hours > 0) {
        if (rul === null || a.rul.hours < rul.hours) rul = { hours: a.rul.hours, label: (a.label || a.param) };
      }
    });
    if (rul) {
      t += 'Estimasi tersisa sekitar <strong>' + fmtInt(Math.round(rul.hours)) +
           ' jam operasi</strong> sebelum ' + esc(rul.label) + ' menyentuh ambang critical. ';
    }
    t += 'Tindak lanjut mengikuti kartu berstatus tertinggi lebih dulu; ' +
         'dasar penilaian ' + ((analysis.records || []).length) + ' record telemetri.';

    return { crit: crit, caut: caut, worst: worst, drivers: drivers, text: t };
  }

  /** HTML blok Result description. */
  function descriptionHtml(analysis, modes) {
    var d = buildDescription(analysis, modes);
    if (!d) {
      return '<div class="panel sfm-desc sfm-desc-ok">' +
        '<h3 class="sfm-desc-title"><i class="fa-solid fa-circle-check"></i> Result Description</h3>' +
        '<p class="sfm-desc-body">Tidak ada parameter failure mode yang melewati ambang pada ' +
        'jendela data unit ini. Seluruh kartu berada dalam batas normal.</p></div>';
    }
    var cls = d.crit.length ? 'sfm-desc-crit' : 'sfm-desc-caut';
    var chips = d.crit.concat(d.caut).map(function (h) {
      return '<span class="sfm-desc-chip ' + (h.status === 'CRITICAL' ? 'crit' : 'caut') + '">' +
             esc(h.title) + '</span>';
    }).join('');
    return '<div class="panel sfm-desc ' + cls + '">' +
      '<h3 class="sfm-desc-title"><i class="fa-solid fa-clipboard-list"></i> Result Description</h3>' +
      '<p class="sfm-desc-body">' + d.text + '</p>' +
      '<div class="sfm-desc-chips">' + chips + '</div>' +
      '</div>';
  }

  function render(analysis) {
    destroyAll();

    var grid = document.getElementById('failmode-grid');
    var emptyEl = document.getElementById('failmode-empty');
    var descEl = document.getElementById('failmode-desc');
    if (!grid) return;
    if (!analysis) {
      grid.innerHTML = '';
      if (descEl) descEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    var modes = visibleModes(analysis);
    if (!modes.length) {
      grid.innerHTML = '';
      if (descEl) descEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (descEl) descEl.innerHTML = descriptionHtml(analysis, modes);

    // Satu tulisan innerHTML untuk seluruh grid (canvas id == id panel).
    var html = '';
    modes.forEach(function (m) {
      html += '<div class="panel chart-panel" data-failmode="' + esc(m.id) + '">' +
                '<p class="failmode-title">' + esc(m.title) + '</p>' +
                '<div class="failmode-legend" id="' + esc(m.id) + '-legend"></div>' +
                '<div class="chart-wrap"><canvas id="' + esc(m.id) + '"></canvas></div>' +
              '</div>';
    });
    grid.innerHTML = html;

    // Samakan tinggi legend & tinggi kartu SEBELUM chart dibuat, supaya canvas
    // baru langsung mendapat tinggi area chart yang benar.
    layoutGrid();

    if (!global.Chart) return;

    modes.forEach(function (m) {
      var canvas = document.getElementById(m.id);
      if (!canvas) return;
      var built = buildDatasets(analysis, m);
      if (!built.labels.length) return;

      charts[m.id] = new global.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: built.labels, datasets: built.datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },                  // legend HTML kustom
            tooltip: {
              backgroundColor: 'rgba(2,6,23,.95)',
              borderColor: '#334155', borderWidth: 1,
              // Garis threshold tidak ikut tooltip (bukan pengukuran).
              filter: function (item) { return !item.dataset._isThreshold; },
              callbacks: {
                title: function (items) {
                  // [FIX 2026-10-16] `items` bisa KOSONG / elemen pertama
                  // undefined saat kursor menyentuh titik yang HANYA punya
                  // seri threshold (difilter dari tooltip) — Chart.js tetap
                  // memanggil title() dan sebelumnya melempar
                  // "Cannot read properties of undefined (reading 'dataIndex')".
                  if (!items || !items.length || !items[0]) return '';
                  var i = items[0].dataIndex;
                  var d = built.dates[i], l = built.labels[i];
                  return (d && l) ? (d + '  \u2022  SMR ' + l + ' jam') : (d || ('SMR ' + l + ' jam'));
                },
                label: function (ctx) {
                  if (!ctx || !ctx.dataset) return '';
                  return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2);
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 5, color: '#64748b', font: { size: 10 } },
              grid: { display: false }
            },
            y: {
              ticks: { color: '#64748b', font: { size: 10 } },
              grid: { color: 'rgba(51,65,85,.35)' }
            }
          }
        }
      });
      renderLegend(m, built);
    });
  }

  /* ------------------------------------------------------------------------
   * 7. Buka/tutup modal + ganti unit
   * ---------------------------------------------------------------------- */

  /**
   * Susun TEKS sub-judul (murni, tanpa DOM — bisa diuji):
   *   {Nomor Lambung} • SN {serial} • SMR {min}–{max} jam • {n} record - Last Update {tanggal}
   * - Nomor Lambung dari Database Unit (`VHMS_UNITDB.getLambung`); fallback
   *   `unitId` lalu `model`.
   * - Last Update = tanggal data VHMS terakhir.
   */
  function buildSubText(analysis) {
    var meta = (analysis && analysis.meta) || {};
    var recs = (analysis && analysis.records) || [];
    var n = recs.length;
    var smrMin = null, smrMax = null, lastCal = null, lastEpoch = -Infinity;
    recs.forEach(function (r) {
      if (_isNum(r.smr)) {
        if (smrMin === null || r.smr < smrMin) smrMin = r.smr;
        if (smrMax === null || r.smr > smrMax) smrMax = r.smr;
      }
      if (r.calendar && _isNum(r.calendar.epoch) && r.calendar.epoch > lastEpoch) {
        lastEpoch = r.calendar.epoch;
        lastCal = r.calendar;
      }
    });
    var range = (smrMin !== null && smrMax !== null)
      ? (fmtInt(smrMin) + '\u2013' + fmtInt(smrMax) + ' jam')
      : '\u2014';

    var db = global.VHMS_UNITDB;
    var lambung = (db && db.getLambung && meta.serial) ? db.getLambung(meta.serial) : null;
    var head = lambung || meta.unitId || meta.model || '\u2014';

    var lastUpd = (analysis && analysis.lastTimestamp)
      || (lastCal && lastCal.display)
      || '\u2014';

    return head +
      (meta.serial ? ' \u2022 SN ' + meta.serial : '') +
      ' \u2022 SMR ' + range +
      ' \u2022 ' + n + ' record - Last Update ' + lastUpd;
  }

  /** Isi #failmode-sub dengan teks identitas unit (lihat buildSubText). */
  function updateSub(analysis) {
    var sub = document.getElementById('failmode-sub');
    if (!sub) return;
    sub.textContent = buildSubText(analysis);
  }

  /** Ganti unit aktif di dalam modal (dropdown #failmode-unit). */
  function selectUnit(id) {
    var analysis = (global.VHMS_FLEET && global.VHMS_FLEET.getAnalysis)
      ? global.VHMS_FLEET.getAnalysis(id) : null;
    if (!analysis) return;
    updateSub(analysis);
    render(analysis);
  }

  /**
   * Buka modal.
   * @param {object[]} rows        Baris fleet yang sedang terfilter (summaryRow).
   * @param {string=}  preferredId id unit yang dipilih lebih dulu.
   */
  /**
   * Label dropdown unit — SERAGAM dengan sub-judul: Nomor Lambung lebih dulu
   * (hasil unggah "Data Unit" -> `row.lambung`), fallback `unitId` lalu `id`.
   * Model ditampilkan di belakang bila ada. Murni (bisa diuji).
   */
  function unitLabel(r) {
    r = r || {};
    var head = r.lambung || r.unitId || r.id || '';
    return head + (r.model ? ' \u2014 ' + r.model : '');
  }

  /**
   * Buka modal.
   * @param {object[]} rows        Baris fleet yang sedang terfilter (summaryRow).
   * @param {string=}  preferredId id unit yang dipilih lebih dulu.
   */
  function open(rows, preferredId) {
    var modal = document.getElementById('failmode-modal');
    var sel = document.getElementById('failmode-unit');
    if (!modal || !sel) return;

    var list = rows || [];
    // [REVISI 2026-10-17] Label dropdown memakai NOMOR LAMBUNG (hasil unggah
    // "Data Unit"), SERAGAM dengan sub-judul modal — lihat unitLabel().
    sel.innerHTML = list.map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(unitLabel(r)) + '</option>';
    }).join('');

    if (preferredId) sel.value = preferredId;
    if (!sel.value && list.length) sel.value = list[0].id;

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    selectUnit(sel.value);

    // Chart di modal yang baru di-unhide perlu resize setelah layout settle.
    // layoutGrid() diulang di sini karena saat render() pertama grid masih
    // tersembunyi (clientWidth 0) -> pengukuran legend harus diulang setelah
    // modal terlihat agar tinggi kartu presisi & label panjang tidak terpotong.
    setTimeout(function () {
      layoutGrid();
      Object.keys(charts).forEach(function (k) {
        try { charts[k].resize(); } catch (e) {}
      });
    }, 60);
  }

  function close() {
    destroyAll();
    var modal = document.getElementById('failmode-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  function isOpen() {
    var modal = document.getElementById('failmode-modal');
    return !!(modal && !modal.classList.contains('hidden'));
  }

  /* ------------------------------------------------------------------------
   * 7b. [FITUR 2026-10-17] COPY IMAGE & EXPORT PDF
   * ----------------------------------------------------------------------
   * TANPA pustaka tambahan (html2canvas dkk). Alasannya bukan selera:
   * seluruh isi kartu yang penting SUDAH berupa <canvas> Chart.js, yang bisa
   * digambar ulang ke satu canvas gabungan lewat drawImage(). Menambah
   * dependensi 200 KB hanya untuk menyalin judul teks tidak sepadan — judul
   * digambar manual dengan fillText.
   *
   * Hasil: satu PNG berisi grid kartu (judul + grafik) dengan latar gelap
   * yang sama dengan layar.
   * ---------------------------------------------------------------------- */

  /** Nama berkas standar: Failure Mode VHMS_{lambung}_{tanggal}. */
  function exportBaseName() {
    var sub = document.getElementById('failmode-sub');
    var head = '';
    if (sub && sub.textContent) head = String(sub.textContent).split('\u2022')[0].trim();
    var d = new Date();
    var stamp = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return ('Failure Mode VHMS_' + (head || 'Unit') + '_' + stamp)
      .replace(/[\/\\:*?"<>|]/g, '-');
  }

  /**
   * Gambar seluruh grid ke satu canvas gabungan.
   * @returns {HTMLCanvasElement|null}
   */
  function composeImage() {
    var grid = document.getElementById('failmode-grid');
    if (!grid) return null;
    var panels = Array.prototype.slice.call(grid.querySelectorAll('.chart-panel'));
    if (!panels.length) return null;

    var PAD = 16, GAP = 12, HEAD = 56, TITLE_H = 26;
    var gridRect = grid.getBoundingClientRect();
    // Kolom dihitung dari posisi nyata panel (grid responsif 1..3 kolom).
    var cols = 0, firstTop = Math.round(panels[0].getBoundingClientRect().top);
    panels.forEach(function (p) {
      if (Math.round(p.getBoundingClientRect().top) === firstTop) cols++;
    });
    if (cols < 1) cols = 1;
    var rows = Math.ceil(panels.length / cols);

    // Ukuran sel = canvas chart terbesar (semua kartu setinggi seragam).
    var cw = 0, ch = 0;
    panels.forEach(function (p) {
      var c = p.querySelector('canvas');
      if (!c) return;
      if (c.width > cw) cw = c.width;
      if (c.height > ch) ch = c.height;
    });
    if (!cw || !ch) return null;

    var cellW = cw, cellH = ch + TITLE_H;
    // [ADD 2026-10-19] Sisakan ruang legend per kartu pada tinggi sel agar
    // legend tidak menimpa kartu di baris berikutnya.
    // [RAPI 2026-10-19] Legend disusun 2 kolom. Mode ber-item terbanyak
    // (Top End Wear: 6 item) butuh 3 baris → offset 6 + 3×13 = 45px.
    var LEGEND_RESERVE = 45;
    var out = document.createElement('canvas');
    out.width = PAD * 2 + cols * cellW + (cols - 1) * GAP;
    out.height = PAD * 2 + HEAD + rows * (cellH + LEGEND_RESERVE) + (rows - 1) * GAP;
    var ctx = out.getContext('2d');

    // Latar + judul (disalin dari DOM agar gambar berdiri sendiri).
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, out.width, out.height);
    var titleEl = document.getElementById('failmode-title-text');
    var subEl = document.getElementById('failmode-sub');
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText((titleEl && titleEl.textContent) || 'Failure Mode Summary - VHMS', PAD, PAD);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText((subEl && subEl.textContent) || '', PAD, PAD + 24);

    panels.forEach(function (p, i) {
      var c = p.querySelector('canvas');
      if (!c) return;
      var col = i % cols, row = Math.floor(i / cols);
      var x = PAD + col * (cellW + GAP);
      var y = PAD + HEAD + row * (cellH + LEGEND_RESERVE + GAP);
      var t = p.querySelector('.failmode-title');
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText((t && t.textContent) || '', x, y + 4);
      try { ctx.drawImage(c, x, y + TITLE_H, cw, ch); } catch (e) {}

      // [ADD 2026-10-19] Gambar LEGEND kartu ke citra hasil Copy Image agar
      // pembaca gambar yang di-share tahu arti warna tiap garis.
      // Sumber: id panel <mode.id>-legend (HTML dot+label yang dibangun
      // renderLegend). Ditambahkan DI BAWAH canvas agar tidak menutup data.
      //
      // [RAPI 2026-10-19] Layout GRID KOLOM TETAP (bukan mengalir bebas):
      // legend disusun dalam 2 kolom sama lebar sehingga dot & teks SEJAJAR
      // vertikal antar-baris — tampak rapi & rata kiri-kanan pada gambar.
      var cvEl = panels[i].querySelector('canvas');
      var legEl = cvEl ? document.getElementById(cvEl.id + '-legend') : null;
      var legItems = legEl ? Array.prototype.slice.call(legEl.children) : [];
      if (legItems.length) {
        var LG_PAD_X = 2;                 // geser tipis dari tepi kiri kartu
        var LG_TOP = y + TITLE_H + ch + 6;
        var LG_LINE_H = 13;
        var LG_COLS = 2;                  // 2 kolom tetap
        var LG_COL_GAP = 14;              // jarak antar-kolom
        var LG_DOT_R = 3.5;
        var LG_DOT_W = LG_DOT_R * 2 + 4;  // lebar area dot
        var avail = cellW - LG_PAD_X * 2;
        var colW = (avail - LG_COL_GAP * (LG_COLS - 1)) / LG_COLS;

        ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.textBaseline = 'top';

        legItems.forEach(function (item, idx) {
          var row = Math.floor(idx / LG_COLS);
          var colIdx = idx % LG_COLS;
          var ix = x + LG_PAD_X + colIdx * (colW + LG_COL_GAP);
          var iy = LG_TOP + row * LG_LINE_H;

          var dotEl = item.querySelector('.dot');
          var dotColor = dotEl ? getComputedStyle(dotEl).backgroundColor : '#38bdf8';
          var txt = (item.textContent || '').trim();

          // Dot — vertikal sejajar tengah baris teks (10px font → ~7px tinggi)
          ctx.fillStyle = dotColor;
          ctx.beginPath();
          ctx.arc(ix + LG_DOT_R, iy + 5, LG_DOT_R, 0, Math.PI * 2);
          ctx.fill();

          // Label — dipotong dengan elipsis bila melebihi lebar kolom
          ctx.fillStyle = '#94a3b8';
          var tx = ix + LG_DOT_W + 4;
          var maxW = colW - (LG_DOT_W + 4);
          var label = txt;
          if (ctx.measureText(label).width > maxW) {
            while (label.length > 1 && ctx.measureText(label + '…').width > maxW) {
              label = label.slice(0, -1);
            }
            label += '…';
          }
          ctx.fillText(label, tx, iy);
        });
      }
    });

    // [REVISI 2026-10-17] Sertakan Result Description di bawah grid. Berbeda
    // dengan kartu (canvas), blok ini HTML — teks dibungkus manual: bungkus
    // kata per lebar panel, gambar judul + paragraf + chip per kartu.
    // Alasan tidak pakai html2canvas: menambah dependensi 200 KB hanya untuk
    // satu blok teks yang strukturnya sudah sederhana tidak sepadan, dan
    // render html2canvas di atas Chart.js sering menghasilkan latar kosong.
    var descEl = document.getElementById('failmode-desc');
    if (descEl && descEl.textContent.trim()) {
      var DPAD = 12, DHEAD = 22, DLINE = 15, DCHIP_H = 18, DCHIP_GAP = 6;
      var innerW = out.width - PAD * 2;
      var bodyEl = descEl.querySelector('.sfm-desc-body');
      var bodyText = bodyEl ? (bodyEl.textContent || '').trim() : '';
      var chipEls = Array.prototype.slice.call(descEl.querySelectorAll('.sfm-desc-chip'));
      var chips = chipEls.map(function (el) { return el.textContent.trim(); });

      // Bungkus kata (manual) pada lebar innerW; font 11px reguler.
      ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      var words = bodyText.split(/\s+/);
      var lines = [], cur = '';
      for (var wi = 0; wi < words.length; wi++) {
        var test = cur ? cur + ' ' + words[wi] : words[wi];
        if (ctx.measureText(test).width > innerW - DPAD * 2) {
          if (cur) lines.push(cur);
          cur = words[wi];
        } else { cur = test; }
      }
      if (cur) lines.push(cur);

      // Pita kiri: ikut kelas deskripsi (crit/caut/ok) untuk konsistensi
      // visual dengan kartu. Ambil dari classList.
      var cls = 'ok';
      if (descEl.querySelector('.sfm-desc-crit')) cls = 'crit';
      else if (descEl.querySelector('.sfm-desc-caut')) cls = 'caut';
      var bandColor = cls === 'crit' ? '#ef4444'
                    : (cls === 'caut' ? '#f59e0b' : '#22c55e');

      // Hitung tinggi yang dibutuhkan, lalu perpanjang canvas (canvas tidak
      // bisa di-resize tanpa menghapus konteks — jadi gambar ulang konten
      // grid ke canvas baru yang sudah diperpanjang).
      var dBlockH = DPAD * 2 + DHEAD + lines.length * DLINE +
                    (chips.length ? DCHIP_H + 4 : 0);
      var newH = out.height + GAP + dBlockH;
      var newOut = document.createElement('canvas');
      newOut.width = out.width; newOut.height = newH;
      var nctx = newOut.getContext('2d');
      // Latar + salin gambar grid sebelumnya (gambar stabil, tidak perlu
      // membangun ulang Chart.js).
      nctx.fillStyle = '#0b1220';
      nctx.fillRect(0, 0, newOut.width, newOut.height);
      nctx.drawImage(out, 0, 0);

      var dx = PAD, dy = out.height + GAP;
      // Latar blok
      nctx.fillStyle = 'rgba(15,23,42,.55)';
      nctx.fillRect(dx, dy, innerW, dBlockH);
      // Pita kiri
      nctx.fillStyle = bandColor;
      nctx.fillRect(dx, dy, 3, dBlockH);

      // Judul
      nctx.fillStyle = '#e2e8f0';
      nctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, sans-serif';
      nctx.textBaseline = 'top';
      nctx.fillText('Result Description', dx + DPAD, dy + DPAD);
      // Badan teks
      nctx.fillStyle = '#cbd5e1';
      nctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      var ty = dy + DPAD + DHEAD;
      for (var li = 0; li < lines.length; li++) {
        nctx.fillText(lines[li], dx + DPAD, ty);
        ty += DLINE;
      }
      // Chip (label kartu)
      if (chips.length) {
        var cx = dx + DPAD, cyy = ty + 4;
        nctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
        chips.forEach(function (txt) {
          var w = nctx.measureText(txt).width + 16;
          if (cx + w > dx + innerW - DPAD) { cx = dx + DPAD; cyy += DCHIP_H + DCHIP_GAP; }
          nctx.fillStyle = cls === 'crit' ? 'rgba(239,68,68,.10)'
                        : (cls === 'caut' ? 'rgba(245,158,11,.10)' : 'rgba(148,163,184,.10)');
          nctx.fillRect(cx, cyy, w, DCHIP_H);
          nctx.fillStyle = cls === 'crit' ? '#fecaca'
                        : (cls === 'caut' ? '#fde68a' : '#94a3b8');
          nctx.fillText(txt, cx + 8, cyy + 3);
          cx += w + DCHIP_GAP;
        });
      }
      out = newOut;
    }
    return out;
  }

  /** Umpan balik ringkas; memakai toast app bila tersedia. */
  function _notify(msg, type) {
    if (global.VHMS_APP && global.VHMS_APP.toast) { global.VHMS_APP.toast(msg, type); return; }
    if (type === 'err') console.error(msg); else console.log(msg);
  }

  /**
   * Salin grid sebagai PNG ke clipboard.
   * CATATAN: `navigator.clipboard.write` butuh konteks aman (https / localhost).
   * Dibuka lewat `file://` ia tidak tersedia — karena itu ada jalur cadangan
   * mengunduh berkas PNG, bukan gagal diam-diam.
   */
  function copyImage() {
    var canvas = composeImage();
    if (!canvas) { _notify('Tidak ada grafik untuk disalin.', 'err'); return; }
    var name = exportBaseName() + '.png';

    function fallbackDownload(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      _notify('Clipboard tidak tersedia di konteks ini — gambar diunduh: ' + name, 'info');
    }

    canvas.toBlob(function (blob) {
      if (!blob) { _notify('Gagal membuat gambar.', 'err'); return; }
      var canCopy = global.ClipboardItem && navigator.clipboard && navigator.clipboard.write;
      if (!canCopy) { fallbackDownload(blob); return; }
      navigator.clipboard.write([new global.ClipboardItem({ 'image/png': blob })])
        .then(function () { _notify('Grafik failure mode disalin ke clipboard.', 'ok'); })
        .catch(function () { fallbackDownload(blob); });
    }, 'image/png');
  }

  /**
   * Cetak / simpan modal sebagai PDF. Memakai @media print + kelas penanda
   * pada body (pola yang sama dengan portfolio-followup.js), sehingga hanya
   * isi modal yang tercetak dan judul dokumen menjadi nama berkas default.
   */
  function exportPdf() {
    if (!isOpen()) return;
    var prevTitle = document.title;
    try { document.title = exportBaseName(); } catch (e) {}
    document.body.classList.add('printing-failmode');
    var cleanup = function () {
      document.body.classList.remove('printing-failmode');
      try { document.title = prevTitle; } catch (e) {}
      global.removeEventListener('afterprint', cleanup);
    };
    global.addEventListener('afterprint', cleanup);
    try { global.print(); } catch (e) { cleanup(); }
  }

  /* ------------------------------------------------------------------------
   * 8. Ekspor
   * ---------------------------------------------------------------------- */
  var API = {
    open: open,
    close: close,
    isOpen: isOpen,
    render: render,
    selectUnit: selectUnit,
    copyImage: copyImage,
    exportPdf: exportPdf,
    exportBaseName: exportBaseName,
    // [ADD 2026-10-19] composeImage diekspor agar dapat diverifikasi di tes
    // (memastikan legend ikut tergambar pada citra hasil "Copy Image").
    composeImage: composeImage,
    // Bagian murni (tanpa DOM) — dipakai tes.
    buildDescription: buildDescription,
    FAILURE_MODES: FAILURE_MODES,
    SERIES_COLORS: SERIES_COLORS,
    FAMILY_PARAMS: FAMILY_PARAMS,
    FAMILY_ORDER_END: FAMILY_ORDER_END,
    FAMILY_ORDER_ALL: FAMILY_ORDER_ALL,
    familyOf: familyOf,
    paramsFor: paramsFor,
    visibleModes: visibleModes,
    recordsFor: recordsFor,
    hasData: hasData,
    buildDatasets: buildDatasets,
    buildSubText: buildSubText,
    unitLabel: unitLabel
  };

  global.VHMS_FAILMODE = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_FAILMODE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

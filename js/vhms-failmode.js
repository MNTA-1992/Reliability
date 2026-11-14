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
      params: ['boostMax', 'boostLow'] },
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
  var RANK = { NORMAL: 0, CAUTION: 1, CRITICAL: 2 };

  /**
   * [REVISI 2026-10-25] Nilai TERBARU sebuah parameter + statusnya SEKARANG.
   * -----------------------------------------------------------------------
   * Dibaca dari record TERAKHIR yang punya nilai untuk `key`, bukan dari
   * puncak jendela 2000 jam. Alasan: kartu harus menjawab "bagaimana kondisi
   * unit HARI INI". Ini pola yang sudah dipakai laporan Portofolio
   * (`breachedVhmsParams` memakai record terbaru, lihat portfolio-render.js).
   *
   * ⚠ `analysis.records` adalah gabungan beberapa jenis berkas yang diurut
   * SMR; mengambil `records[records.length - 1]` begitu saja bisa mendarat di
   * baris berkas LAIN yang kolomnya kosong. Karena itu dicari mundur sampai
   * ketemu nilai yang benar-benar ada (kelas jebakan yang sama dengan B16).
   * @returns {object|null} { value, smr, calendar, status }
   */
  function latestOf(analysis, key, TH) {
    var recs = (analysis && analysis.records) || [];
    for (var i = recs.length - 1; i >= 0; i--) {
      var r = recs[i];
      if (!r || !_isNum(r[key])) continue;
      var th = TH[key];
      var st = 'NORMAL';
      if (th) {
        if (th.mode === 'low') {
          if (r[key] <= th.crit) st = 'CRITICAL';
          else if (r[key] <= th.warn) st = 'CAUTION';
        } else {
          if (r[key] >= th.crit) st = 'CRITICAL';
          else if (r[key] >= th.warn) st = 'CAUTION';
        }
      }
      return { value: r[key], smr: r.smr, calendar: r.calendar, status: st };
    }
    return null;
  }

  /* ------------------------------------------------------------------------
   * [REVISI 2026-10-25a] ANGKA BULAT di Result Description
   * ----------------------------------------------------------------------
   * Permintaan operator: tulis angka bulat, jangan dua digit di belakang
   * koma ("20,20 kPa" -> "20 kPa", "1.567,63 mmHg" -> "1.568 mmHg").
   *
   * ⚠ TIDAK boleh membulatkan BUTA. Sebagian parameter bernilai pecahan
   * kecil dan akan HANCUR jika dipaksa bulat: tekanan oli 0,15 MPa menjadi
   * "0 MPa" (menyesatkan), ambang pompa 0,8 MPa menjadi "1 MPa". Karena itu:
   *   |nilai| >= 10  -> bulat (suhu, tekanan kPa/mmHg, fuel rate, jam)
   *   |nilai| <  10  -> pakai desimal bawaan parameter (cfg.PARAMS.decimals),
   *                     TETAPI nol di belakang koma dibuang
   * Batas 10 dipilih karena di bawahnya satu digit desimal mengubah makna
   * lebih dari 5 %; di atasnya pembulatan menggeser nilai < 5 %.
   *
   * Pembuangan nol-ekor menjaga maksud permintaan tanpa mengorbankan angka
   * penting: ambang 5,0 kPa ditulis "5" (bukan "5,00"), sementara tekanan
   * 0,15 MPa tetap "0,15". Pemisah desimal mengikuti locale id-ID (koma),
   * jadi pemangkasan dilakukan atas hasil format — bukan atas angkanya.
   * ---------------------------------------------------------------------- */
  function fmtVal(v, key) {
    if (!_isNum(v)) return '\u2014';
    if (Math.abs(v) >= 10) return fmtInt(Math.round(v));
    var s = fmt(v, metaDec(key));
    // Hanya bila BENAR-BENAR ada bagian desimal (ada koma). Titik di id-ID
    // adalah pemisah RIBUAN — jangan pernah dipangkas.
    if (s.indexOf(',') >= 0) {
      s = s.replace(/0+$/, '').replace(/,$/, '');
    }
    return s;
  }

  /* ------------------------------------------------------------------------
   * [REVISI 2026-10-25a] SENSOR EGT MACET (stuck-high)
   * ----------------------------------------------------------------------
   * Kasus nyata unit contoh PC2000 SN 20020: `LBR Exh Temp` menunjukkan
   * 969 °C KONSTAN selama berbulan-bulan. Nilai itu jauh di atas ambang
   * critical sehingga kartu "Top End Wear" selalu merah — padahal buktinya
   * justru menunjuk SENSOR RUSAK, bukan mesin overheat: gas buang yang nyata
   * tidak mungkin tidak bergerak sama sekali sementara rpm & beban berubah.
   * Catatan yang sama sudah tertulis di `vhms-knowledge.js` (lbfExhTempMax)
   * dan `vhms-profiles.js`, tetapi Result Description belum memakainya.
   *
   * Uji di sini memakai KAIDAH yang sama dengan `detectStuck()` di
   * `vhms-snapshot.js` (rasio nilai dominan >= 90 %) agar kedua tempat tidak
   * memberi kesimpulan berbeda atas gejala yang sama. Bedanya hanya sumber
   * data: di sana snapshot resolusi tinggi, di sini trend per-interval.
   *
   * HANYA untuk parameter suhu gas buang. Parameter lain (mis. tekanan
   * atmosfer) memang wajar konstan — menandainya akan menghasilkan
   * peringatan palsu, lihat catatan B12.
   *
   * ⚠ Statusnya TIDAK diturunkan diam-diam. Menyembunyikan nilai critical
   * karena "mungkin sensor" adalah kehilangan data pada batas kepercayaan;
   * yang dilakukan hanyalah (a) memberi peringatan verifikasi sensor dan
   * (b) tidak menjadikannya temuan "paling mendesak" bila ada parameter lain
   * yang benar-benar bergerak.
   * ---------------------------------------------------------------------- */
  var EGT_KEY_RE = /exhtemp/i;
  var STUCK_RATIO = 0.90;     // sama dengan VHMS_SNAPSHOT.STUCK_RATIO
  var STUCK_MIN_N = 5;

  /**
   * @returns {object|null} { value, ratio, count, total } bila sensor EGT
   *   terbaca macet pada satu nilai, `null` bila wajar / bukan EGT.
   */
  function stuckSensor(analysis, key) {
    if (!EGT_KEY_RE.test(key)) return null;
    var recs = recordsFor(analysis, key);
    var freq = {}, valid = 0;
    for (var i = 0; i < recs.length; i++) {
      var v = recs[i][key];
      if (!_isNum(v)) continue;
      valid++;
      var k = String(v);
      freq[k] = (freq[k] || 0) + 1;
    }
    if (valid < STUCK_MIN_N) return null;
    var topKey = null, topN = 0;
    Object.keys(freq).forEach(function (k) {
      if (freq[k] > topN) { topN = freq[k]; topKey = k; }
    });
    var ratio = topN / valid;
    if (ratio < STUCK_RATIO) return null;
    return { value: Number(topKey), ratio: ratio, count: topN, total: valid };
  }

  /* ------------------------------------------------------------------------
   * [REVISI 2026-10-25] Status kartu = KONDISI TERBARU; puncak jendela 2000
   * jam turun pangkat jadi CATATAN RIWAYAT.
   * ----------------------------------------------------------------------
   * Sebelumnya status kartu diambil dari `analysis.anomalies`, yaitu nilai
   * paling EKSTREM dalam jendela 2000 jam. Akibatnya satu lonjakan tunggal
   * berbulan lalu membuat kartu tetap merah walau unit sudah normal kembali
   * berminggu-minggu — operator kehilangan kemampuan membedakan "sedang
   * bermasalah" dari "pernah bermasalah".
   *
   * Sekarang:
   *   status kartu  = parameter terparah menurut NILAI TERBARU
   *   `history[]`   = parameter yang pernah melewati ambang di jendela 2000
   *                   jam tetapi nilai terbarunya sudah normal
   * Kartu yang hanya punya riwayat TIDAK lagi berstatus Critical/Caution; ia
   * muncul sebagai chip "pernah High" supaya buktinya tidak hilang.
   * ---------------------------------------------------------------------- */
  function buildDescription(analysis, modes) {
    if (!analysis || !modes || !modes.length) return null;
    var anoms = (analysis.anomalies || []).concat(analysis.historyAnomalies || []);
    var TH = (analysis && analysis.thresholdSet) || (cfg && cfg.THRESHOLDS) || {};

    // Indeks anomali jendela per parameter (bukti RIWAYAT: puncak + tanggal).
    var peakOf = {};
    anoms.forEach(function (a) {
      if (!a || !a.param || a.status === 'NORMAL') return;
      peakOf[a.param] = a;
    });

    var hits = [], history = [];
    if(global.__DBG){var _n=0,_h=0;} 
    modes.forEach(function (m) {
      var now = [], past = [];
      m.params.forEach(function (k) {
        var cur = latestOf(analysis, k, TH);
        var peak = peakOf[k];
        if (cur && cur.status !== 'NORMAL') {
          var th = TH[k] || {};
          var meta = paramMeta(k);
          now.push({
            param: k, label: meta.label || k, unit: meta.unit || '',
            status: cur.status, value: cur.value,
            warn: th.warn, crit: th.crit, mode: th.mode,
            smr: cur.smr, calendar: cur.calendar,
            rul: peak ? peak.rul : null,
            // Sensor macet: bukti bahwa angka ini belum tentu kondisi mesin.
            stuck: stuckSensor(analysis, k),
            peak: peak ? { value: peak.value, status: peak.status,
                           calendar: peak.calendar } : null
          });
        } else if (peak) {
          // Pernah melewati ambang, nilai terbaru sudah normal.
          //
          // [FIX 2026-10-26] SATUAN diambil dari `paramMeta(k)`, BUKAN dari
          // `peak.unit`. `peak` berasal dari `analysis.anomalies` yang
          // `unit`-nya diisi `cfg.PARAMS[key].unit` — bisa kosong pada jalur
          // tertentu (mis. anomali hasil rehidrasi/pemadatan), dan saat itu
          // angka "pernah 1.245" tampil TELANJANG tanpa "mmHg". Label pun
          // begitu: memakai `peak.label` lebih dulu membuat nama parameter
          // mengikuti anomali, bukan definisi parameter. `paramMeta` adalah
          // sumber yang SAMA dengan `fmtVal` memformat angkanya, jadi angka
          // dan satuannya mustahil berbeda asal.
          var pMeta = paramMeta(k);
          past.push({
            param: k, label: pMeta.label || peak.label || k,
            unit: pMeta.unit || peak.unit || '',
            peakStatus: peak.status, peakValue: peak.value,
            warn: peak.warn, crit: peak.crit,
            calendar: peak.calendar,
            latest: cur ? cur.value : null
          });
        }
      });

      if (now.length) {
        // Parameter yang sensornya terbaca MACET didorong ke belakang pada
        // tingkat status yang sama: yang "paling mendesak" harus parameter
        // yang benar-benar bergerak, bukan angka beku dari sensor rusak.
        now.sort(function (a, b) {
          if (RANK[b.status] !== RANK[a.status]) return RANK[b.status] - RANK[a.status];
          return (a.stuck ? 1 : 0) - (b.stuck ? 1 : 0);
        });
        hits.push({ id: m.id, title: m.title, pillar: m.pillar,
                    status: now[0].status, anomalies: now, past: past,
                    // Kartu ini SELURUH temuannya berasal dari sensor macet?
                    allStuck: now.every(function (a) { return !!a.stuck; }) });
      } else if (past.length) {
        history.push({ id: m.id, title: m.title, pillar: m.pillar, past: past });
      }
    });

    if (!hits.length && !history.length) return null;

    hits.sort(function (a, b) { return RANK[b.status] - RANK[a.status]; });
    var crit = hits.filter(function (h) { return h.status === 'CRITICAL'; });
    var caut = hits.filter(function (h) { return h.status === 'CAUTION'; });

    // Jumlah record yang benar-benar jadi dasar penilaian (jendela formula).
    var nWin = (analysis.formulaWindow && analysis.formulaWindow.recordCount) ||
               (analysis.windowRecords || []).length ||
               (analysis.records || []).length;
    var winH = analysis.formulaWindow && analysis.formulaWindow.hours;

    /* --------------------------------------------------------------------
     * Narasi. Ditulis sebagaimana seorang pengawas memberi arahan di pagi
     * hari: apa yang terjadi, seberapa serius, kerjakan yang mana dulu, dan
     * dari mana angkanya. Tanpa jargon kosong, tanpa nada robot.
     *
     * [REVISI 2026-10-25a] ISTILAH DISERAGAMKAN. Satu gagasan = satu frasa:
     *   "melewati ambang threshold"  -> SATU-SATUNYA frasa untuk pelanggaran
     *                                   batas, di seluruh paragraf.
     * Varian lama "keluar batas" / "keluar dari batas wajar" DIHAPUS supaya
     * pembaca tidak menduga keduanya berarti hal yang berbeda.
     * ------------------------------------------------------------------ */
    var t = '', worst = null, drivers = [];

    if (!hits.length) {
      t += 'Pada data terbaru unit ini <strong>tidak ada parameter yang masih ' +
           'melewati ambang threshold</strong>. ';
    } else {
      worst = hits[0];
      var wa = worst.anomalies[0];
      /* [REVISI 2026-10-25b] SATUAN pada angka ambang.
       * Sebelumnya "ambang threshold critical 800" berdiri sendiri tanpa
       * satuan, padahal nilai actual di kalimat yang sama memakai "\u00b0C" \u2014
       * pembaca harus menebak 800 apa. Satuan diturunkan dari unit parameter
       * yang sama, jadi tidak mungkin beda dengan angka actual-nya. */
      var uSuffix = wa.unit ? ' ' + esc(wa.unit) : '';
      var thLabel = (wa.status === 'CRITICAL')
        ? 'ambang threshold critical ' + fmtVal(wa.crit, wa.param) + uSuffix
        : 'ambang threshold warning ' + fmtVal(wa.warn, wa.param) + uSuffix;
      var arah = (wa.mode === 'low') ? 'turun ke' : 'berada di';

      if (crit.length) {
        t += 'Pada pembacaan terakhir, <strong>' + crit.length + ' pola kegagalan ' +
             'sudah masuk zona Critical</strong>' +
             (caut.length ? ' dan ' + caut.length + ' lagi di zona Caution' : '') +
             '. Kondisi ini perlu ditangani, bukan sekadar dipantau. ';
      } else {
        t += 'Pada pembacaan terakhir, <strong>' + caut.length + ' pola kegagalan ' +
             'berada di zona Caution</strong> — belum kritis, tetapi sudah ' +
             'melewati ambang threshold dan sebaiknya diperiksa pada kesempatan ' +
             'servis terdekat. ';
      }

      t += 'Yang paling mendesak <strong>' + esc(worst.title) + '</strong>: ' +
           esc(wa.label || wa.param) + ' ' + arah + ' ' + fmtVal(wa.value, wa.param) +
           (wa.unit ? ' ' + esc(wa.unit) : '') + ' terhadap ' + thLabel +
           (wa.calendar && wa.calendar.display
              ? ' pada pembacaan ' + esc(wa.calendar.display) : '') + '. ';

      // Puncak historis parameter yang sama — memberi rasa "sejak kapan".
      if (wa.peak && _isNum(wa.peak.value) && wa.peak.value !== wa.value) {
        t += 'Nilai tertingginya dalam ' + (winH ? fmtInt(winH) + ' jam' : 'jendela') +
             ' terakhir ' + fmtVal(wa.peak.value, wa.param) +
             (wa.peak.calendar && wa.peak.calendar.display
                ? ' (' + esc(wa.peak.calendar.display) + ')' : '') + '. ';
      }

      // Parameter pendorong lain — dedup, Critical lebih dulu, maksimum 5.
      var seen = {};
      hits.forEach(function (h) {
        h.anomalies.forEach(function (a) {
          if (seen[a.param]) return;
          seen[a.param] = 1; drivers.push(a);
        });
      });
      if (drivers.length > 1) {
        t += 'Ikut melewati ambang threshold pada pembacaan yang sama: ' +
          drivers.slice(1, 6).map(function (a) {
            return '<strong>' + esc(a.label || a.param) + '</strong> ' +
                   fmtVal(a.value, a.param) + (a.unit ? ' ' + esc(a.unit) : '');
          }).join(', ') + '. ';
      }

      /* ------------------------------------------------------------------
       * PERINGATAN SENSOR MACET. Diletakkan SEBELUM estimasi sisa umur
       * karena ia mengubah cara seluruh angka di atas harus dibaca — tidak
       * ada gunanya membicarakan sisa umur bila sumber angkanya diragukan.
       * ---------------------------------------------------------------- */
      var stuckList = drivers.filter(function (a) { return !!a.stuck; });
      if (stuckList.length) {
        var sNames = stuckList.slice(0, 4).map(function (a) {
          return '<strong>' + esc(a.label || a.param) + '</strong> tertahan di ' +
                 fmtVal(a.stuck.value, a.param) + (a.unit ? ' ' + esc(a.unit) : '') +
                 ' pada ' + Math.round(a.stuck.ratio * 100) + '% dari ' +
                 fmtInt(a.stuck.total) + ' pembacaan';
        }).join('; ');
        t += '<strong>Perhatian — periksa sensor lebih dulu:</strong> ' + sNames +
             '. Suhu gas buang mesin yang benar-benar bekerja selalu bergerak ' +
             'mengikuti putaran dan beban; nilai yang membeku di satu angka ' +
             'jauh lebih menunjuk ke sensor atau wiring yang rusak daripada ke ' +
             'kondisi mesin. Periksa kode fault sensor gas buang (mis. ' +
             '<strong>dGT5KB</strong>/<strong>DGT5KA</strong>) dan bandingkan ' +
             'dengan sudut manifold lain sebelum menyimpulkan overheat — ' +
             'jangan bongkar mesin atas dasar angka ini saja. ';
      }

      /* ------------------------------------------------------------------
       * Sisa umur (RUL) terpendek — hanya bila analytics menghasilkannya.
       *
       * [FIX 2026-10-25b] BUG NYATA: muncul "∞ jam operasi" di layar.
       * Penyebabnya `estimateRUL()` mengembalikan `Infinity` (atau angka
       * sangat besar) ketika tren parameter nyaris datar / slope ~ 0 —
       * secara matematis "tidak akan pernah menyentuh ambang". Kode lama
       * hanya menyaring `> 0`, dan `Infinity > 0` bernilai TRUE, sehingga
       * `Math.round(Infinity)` -> Infinity -> diformat menjadi "∞".
       * Itu kalimat yang tidak bisa ditindaklanjuti operator.
       *
       * Sekarang: RUL hanya ditulis bila nilainya BERHINGGA dan masih di
       * dalam satuan jam yang masuk akal (<= RUL_MAX_HOURS). Bila laju
       * perburukan terlalu landai, hal itu dikatakan apa adanya dalam
       * bahasa manusia — bukan simbol matematika.
       * ----------------------------------------------------------------- */
      var RUL_MAX_HOURS = 100000;      // ~11 tahun operasi; di atas ini = datar
      var rul = null, rulFlat = null;
      drivers.forEach(function (a) {
        if (a.stuck) return;                       // deret beku = angka semu
        if (!a.rul) return;
        var h = a.rul.hours;
        if (!_isNum(h)) return;                    // null / NaN / Infinity
        if (!isFinite(h)) { if (!rulFlat) rulFlat = (a.label || a.param); return; }
        if (h <= 0) return;
        if (h > RUL_MAX_HOURS) { if (!rulFlat) rulFlat = (a.label || a.param); return; }
        if (rul === null || h < rul.hours) {
          rul = { hours: h, label: (a.label || a.param) };
        }
      });
      if (rul) {
        t += 'Bila laju perburukan bertahan seperti sekarang, masih tersisa sekitar ' +
             '<strong>' + fmtInt(Math.round(rul.hours)) + ' jam operasi</strong> ' +
             'sebelum ' + esc(rul.label) + ' menyentuh ambang threshold critical — ' +
             'itu jendela waktu untuk menyiapkan part dan jadwal perbaikan. ';
      } else if (rulFlat) {
        t += 'Laju kenaikan ' + esc(rulFlat) + ' masih terlalu landai untuk ' +
             'dijadikan dasar perkiraan waktu, jadi belum ada tanggal perbaikan ' +
             'yang bisa ditetapkan dari tren ini — pantau pada pemeriksaan berikutnya. ';
      }
    }

    /* --------------------------------------------------------------------
     * Catatan RIWAYAT — kartu yang kini normal tetapi pernah melewati ambang
     * di jendela 2000 jam. Bukan alarm, tetapi jangan dibuang: pola yang
     * berulang adalah petunjuk paling murah untuk akar masalah.
     * ------------------------------------------------------------------ */
    if (history.length) {
      var hp = [];
      history.forEach(function (h) {
        h.past.slice(0, 2).forEach(function (p) {
          hp.push(esc(h.title) + ' (' + esc(p.label) + ' pernah ' +
                  fmtVal(p.peakValue, p.param) + (p.unit ? ' ' + esc(p.unit) : '') +
                  (p.calendar && p.calendar.display ? ', ' + esc(p.calendar.display) : '') + ')');
        });
      });
      /* [REVISI 2026-10-25b] Penutup catatan riwayat disesuaikan: kalimat
       * lama "cukup diingat bila keluhan yang sama muncul lagi" menggantung
       * tanpa menjelaskan APA yang harus diingat. Diganti pernyataan peran
       * catatan itu sendiri — sebagai penanda parameter yang pernah
       * melewati ambang threshold, untuk dibandingkan pada pembacaan
       * berikutnya. */
      t += '<strong>Catatan riwayat:</strong> ' + hp.slice(0, 4).join('; ') +
           ' sempat melewati ambang threshold dalam ' +
           (winH ? fmtInt(winH) + ' jam' : 'jendela') +
           ' terakhir namun sudah kembali normal. Catatan ini disimpan ' +
           'sebagai penanda parameter yang pernah melewati ambang threshold, ' +
           'agar dapat dibandingkan dengan pembacaan berikutnya. ';
    }

    // Urutan kerja + dasar penilaian.
    if (hits.length) {
      t += 'Kerjakan kartu berstatus tertinggi lebih dulu' +
           (crit.length && caut.length ? ' — selesaikan yang Critical sebelum menyentuh yang Caution' : '') +
           '; ';
    } else {
      t += 'Lanjutkan pemantauan rutin; ';
    }
    t += 'penilaian ini berdasar ' + fmtInt(nWin) + ' record telemetri' +
         (winH ? ' pada ' + fmtInt(winH) + ' jam operasi terakhir' : '') +
         ', dengan status diambil dari pembacaan paling baru.';

    return { crit: crit, caut: caut, worst: worst, drivers: drivers,
             history: history, text: t };
  }

  /** HTML blok Result description. */
  function descriptionHtml(analysis, modes) {
    var d = buildDescription(analysis, modes);
    if (!d) {
      return '<div class="panel sfm-desc sfm-desc-ok">' +
        '<h3 class="sfm-desc-title"><i class="fa-solid fa-circle-check"></i> Result Description</h3>' +
        '<p class="sfm-desc-body">Tidak ada parameter failure mode yang melewati ambang threshold ' +
        'pada jendela data unit ini. Seluruh kartu berada dalam batas normal.</p></div>';
    }
    var cls = d.crit.length ? 'sfm-desc-crit'
            : (d.caut.length ? 'sfm-desc-caut' : 'sfm-desc-ok');
    // [REVISI 2026-10-25a] Kartu yang SELURUH temuannya dari sensor macet
    // diberi penanda "cek sensor" supaya operator tidak langsung membaca
    // chip merah sebagai kerusakan mesin.
    var chips = d.crit.concat(d.caut).map(function (h) {
      return '<span class="sfm-desc-chip ' + (h.status === 'CRITICAL' ? 'crit' : 'caut') + '">' +
             esc(h.title) + (h.allStuck ? ' \u00b7 cek sensor' : '') + '</span>';
    }).join('');
    // [REVISI 2026-10-25] Chip RIWAYAT — kartu yang kini normal tapi pernah
    // melewati ambang. Dibedakan secara visual agar tidak terbaca sebagai alarm.
    chips += (d.history || []).map(function (h) {
      return '<span class="sfm-desc-chip hist">' + esc(h.title) +
             ' \u00b7 pernah High</span>';
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
   * Tanggal "Last Update" yang JUJUR terhadap isi grid.
   *
   * [FIX 2026-10-26 — BUG ECM MATI]
   * ----------------------------------------------------------------------
   * `analysis.lastTimestamp` = calendar TERBESAR di SELURUH record unit,
   * lintas jenis berkas (`_src`). Pada unit yang ECM-nya bermasalah, berkas
   * trend utama ('40' trend0.CSV) BERHENTI merekam sementara berkas lain
   * terus jalan. Contoh nyata D375A SN 19551:
   *   trend0.CSV    ('40') berhenti 07/05/2025  -> menyuplai 8 dari 9 kartu
   *   tm_trend0.CSV ('81') terakhir 08/06/2026  -> menyuplai 1 kartu
   * Sub-judul lama menulis "Last Update 08/06/2026" padahal delapan grafik
   * berhenti di 2025. Operator membacanya sebagai "data segar".
   *
   * MENGAMBIL TANGGAL TERBARU DARI SUMBER YANG DIPAKAI PUN MASIH SALAH di
   * kasus ini — '81' memang dipakai, jadi hasilnya tetap 2026. Yang benar
   * adalah BATAS TERDEPAN YANG LENGKAP: tanggal terakhir dari sumber yang
   * PALING TERTINGGAL di antara yang digambar. Itulah titik di mana seluruh
   * grid masih punya data. Bila sumber lain lebih baru, selisihnya ditulis
   * apa adanya — bukan dipakai sebagai angka utama, bukan pula disembunyikan.
   *
   * @returns {{shown:(string|null), newest:(string|null), stale:boolean}}
   *   shown  = batas terdepan yang lengkap (dipakai sebagai Last Update)
   *   newest = tanggal terbaru yang ada di berkas mana pun
   *   stale  = true bila keduanya berbeda (ada sumber yang tertinggal)
   */
  function lastUpdateInfo(analysis) {
    var recs = (analysis && analysis.records) || [];
    var modes = visibleModes(analysis);

    // Sumber yang BENAR-BENAR menyuplai kartu (lihat `recordsFor`).
    var used = {};
    modes.forEach(function (m) {
      var rs = recordsFor(analysis, m.params[0]);
      if (rs.length) used[rs[0]._src || '40'] = 1;   // satu baris cukup: _src seragam
    });

    // Tanggal TERAKHIR per sumber + tanggal terbaru lintas seluruh berkas.
    var lastBySrc = {}, newestE = -Infinity, newest = null;
    recs.forEach(function (r) {
      if (!r.calendar || !_isNum(r.calendar.epoch)) return;
      var s = r._src || '40';
      if (!lastBySrc[s] || r.calendar.epoch > lastBySrc[s].e) {
        lastBySrc[s] = { e: r.calendar.epoch, d: r.calendar.display };
      }
      if (r.calendar.epoch > newestE) { newestE = r.calendar.epoch; newest = r.calendar.display; }
    });

    // Batas terdepan yang lengkap = sumber terpakai yang PALING TERTINGGAL.
    var shown = null, shownE = Infinity;
    Object.keys(used).forEach(function (s) {
      var l = lastBySrc[s];
      if (l && l.e < shownE) { shownE = l.e; shown = l.d; }
    });
    if (!shown) { shown = (analysis && analysis.lastTimestamp) || newest; shownE = newestE; }

    return { shown: shown, newest: newest, stale: (newestE > shownE) };
  }

  /**
   * Susun TEKS sub-judul (murni, tanpa DOM — bisa diuji):
   *   {Nomor Lambung} • SN {serial} • SMR {min}–{max} jam • {n} record - Last Update {tanggal}
   * - Nomor Lambung dari Database Unit (`VHMS_UNITDB.getLambung`); fallback
   *   `unitId` lalu `model`.
   * - Last Update = batas terdepan yang LENGKAP untuk seluruh kartu (lihat
   *   `lastUpdateInfo`). Bila ada sumber yang lebih baru, ditambahkan
   *   "s/d {tanggal}" supaya ketimpangan terlihat.
   *
   * [REVISI 2026-10-26] Penanda sumber: dulu "(sebagian berkas s/d ...)".
   * Disederhanakan jadi "s/d ..." saja, TETAPI diberi kata "berkas" karena
   * tanggal telanjang setelah "s/d" terbaca sebagai "data berhenti di X",
   * padahal artinya justru SEBALIKNYA: sebagian berkas masih berjalan
   * sampai tanggal itu. Tanpa kata benda, operator bisa salah membaca arah.
   */
  function buildSubText(analysis) {
    var meta = (analysis && analysis.meta) || {};
    var recs = (analysis && analysis.records) || [];
    var n = recs.length;
    var smrMin = null, smrMax = null;
    recs.forEach(function (r) {
      if (_isNum(r.smr)) {
        if (smrMin === null || r.smr < smrMin) smrMin = r.smr;
        if (smrMax === null || r.smr > smrMax) smrMax = r.smr;
      }
    });
    var range = (smrMin !== null && smrMax !== null)
      ? (fmtInt(smrMin) + '\u2013' + fmtInt(smrMax) + ' jam')
      : '\u2014';

    var db = global.VHMS_UNITDB;
    var lambung = (db && db.getLambung && meta.serial) ? db.getLambung(meta.serial) : null;
    var head = lambung || meta.unitId || meta.model || '\u2014';

    var lu = lastUpdateInfo(analysis);
    var lastUpd = lu.shown || '\u2014';
    if (lu.stale && lu.newest) lastUpd += ' (berkas lain s/d ' + lu.newest + ')';

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

    /* ====================================================================
     * [REVISI 2026-10-26] TATA LETAK DIIKUTI DARI DOM, BUKAN DIKARANG.
     * --------------------------------------------------------------------
     * Versi lama menyusun gambar dengan konstanta sendiri (PAD 16, GAP 12,
     * HEAD 56, TITLE_H 26, legend 2 kolom 10px, tanpa border/padding kartu).
     * Akibatnya hasil Copy Image BEDA dari pop-up pada hampir semua hal yang
     * terlihat mata:
     *   - kanvas memakai ukuran ATRIBUT (284x133), sedangkan di layar ia
     *     DIPERBESAR CSS ke 341x160 (scale 1,20) -> semua grafik mengecil 17%
     *   - lebar total 908px vs 1130px di pop-up
     *   - border 1,2px radius 16px, padding 12px, dan bayangan kartu HILANG
     *   - legend asli 1 baris (11px, dot 9px); digambar 2 kolom 10px sehingga
     *     teks terpotong "…" padahal di layar utuh
     *   - blok Result Description digambar TANPA panel, border kiri warna,
     *     judul berikon, maupun chip bergaya
     *
     * Sekarang SEMUA angka layout dibaca dari computed style elemen aslinya,
     * dan setiap elemen teks diposisikan dari getBoundingClientRect() milik
     * elemen itu sendiri. Tidak ada satu pun konstanta tata letak yang
     * dikarang — maka gambar tidak bisa lagi "menyimpang" dari pop-up.
     *
     * Skala: `SS` (supersampling) = 2 agar teks & garis tetap tajam saat
     * gambar diperbesar; seluruh koordinat CSS dikali SS.
     * ================================================================== */
    var SS = 2;
    var FONT_FALLBACK = 'system-ui, -apple-system, Segoe UI, sans-serif';

    /** "12px Inter, ..." + SS -> "24px Inter, ..." (ukuran font ikut skala). */
    function scaledFont(font) {
      var f = String(font || '');
      if (!f) return (11 * SS) + 'px ' + FONT_FALLBACK;
      return f.replace(/(\d*\.?\d+)px/, function (m, n) {
        return (parseFloat(n) * SS) + 'px';
      });
    }
    /** Font dari computed style; bila kosong -> fallback tebal/normal. */
    function fontOf(el, weight) {
      if (!el) return (weight || 400) + ' ' + (11 * SS) + 'px ' + FONT_FALLBACK;
      return scaledFont(getComputedStyle(el).font);
    }
    function cssOf(el, prop) { return el ? getComputedStyle(el)[prop] : ''; }
    function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

    /**
     * LATAR sebuah elemen: `background-color` SAJA TIDAK CUKUP.
     * Kartu `.chart-panel` memakai `linear-gradient(#0f172a, #0b1220)` dengan
     * `background-color: transparent`. Versi lama hanya membaca
     * background-color -> kartu tergambar tanpa isian sama sekali. Di sini
     * gradient diurai menjadi pemanggilan gradient canvas.
     * @returns {object|null} { type:'color', color } | { type:'linear', ... }
     */
    function bgPaintOf(el) {
      if (!el) return null;
      var cs = getComputedStyle(el);
      var img = cs.backgroundImage;
      if (img && img !== 'none') {
        // "linear-gradient(rgb(15, 23, 42), rgb(11, 18, 32))" atau dengan sudut.
        var m = img.match(/linear-gradient\((.*)\)/);
        if (m) {
          var args = m[1];
          var angle = 180;                         // default CSS: ke bawah
          var am = args.match(/^\s*(-?[\d.]+)deg\s*,/);
          if (am) { angle = parseFloat(am[1]); args = args.slice(am[0].length); }
          else if (/^\s*to\s+/i.test(args)) { angle = 180; args = args.replace(/^\s*to\s+\w+\s*,?/i, ''); }
          var stops = [];
          // Pisahkan stop dengan koma DI LUAR tanda kurung warna.
          var depth = 0, cur = '';
          for (var i = 0; i < args.length; i++) {
            var ch = args[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) { stops.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          if (cur.trim()) stops.push(cur.trim());
          stops = stops.map(function (s) {
            var pm = s.match(/^(.*?)(?:\s+([\d.]+)%)?$/);
            return { color: (pm && pm[1] ? pm[1] : s), pos: pm && pm[2] ? parseFloat(pm[2]) / 100 : null };
          }).filter(function (s) { return !!s.color; });
          if (stops.length) return { type: 'linear', angle: angle, stops: stops };
        }
      }
      var bc = cs.backgroundColor;
      if (bc && bc !== 'rgba(0, 0, 0, 0)') return { type: 'color', color: bc };
      return null;
    }

    /** Isi area dengan hasil `bgPaintOf` (warna atau gradient). */
    function fillBg(c, x, y, w, h, paint) {
      if (!paint) return;
      if (paint.type === 'color') { c.fillStyle = paint.color; c.fillRect(x, y, w, h); return; }
      // Canvas gradient: sudut CSS (0deg = ke atas, 180deg = ke bawah).
      var rad = (paint.angle - 90) * Math.PI / 180;
      var cx = x + w / 2, cy = y + h / 2;
      var len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      var g = c.createLinearGradient(
        cx - Math.cos(rad) * len / 2, cy - Math.sin(rad) * len / 2,
        cx + Math.cos(rad) * len / 2, cy + Math.sin(rad) * len / 2);
      paint.stops.forEach(function (s, i) {
        var pos = s.pos;
        if (pos === null) pos = paint.stops.length === 1 ? 0 : i / (paint.stops.length - 1);
        try { g.addColorStop(Math.max(0, Math.min(1, pos)), s.color); } catch (e) {}
      });
      c.fillStyle = g;
      c.fillRect(x, y, w, h);
    }

    /**
     * GLYPH IKON Font Awesome.
     * `element.textContent` untuk <i class="fa-solid ..."> KOSONG — glyph-nya
     * berasal dari pseudo-element `::before` berupa karakter Private Use Area.
     * Versi lama meng-hardcode '\uf46d' sebagai string literal, sehingga yang
     * tercetak justru tulisan "\uf46d" di gambar. Di sini glyph dibaca dari
     * `getComputedStyle(el, '::before').content`.
     * @returns {{glyph:string, font:string, color:string, size:number}|null}
     */
    function iconOf(el) {
      if (!el) return null;
      var bef;
      try { bef = global.getComputedStyle(el, '::before'); } catch (e) { return null; }
      if (!bef) return null;
      var raw = bef.content || '';
      // content bisa: "\uf46d" | "\"\uf1fe\"" | "none" | "normal" | ""
      //
      // ⚠ [BUG 2026-10-26d] Font Awesome 6 memasang content BERLAPIS dua:
      //     content: "\"\uf1fe\""      (kutip di DALAM string CSS)
      //   Membuang satu lapis kutip saja menyisakan karakter kutip sebagai
      //   bagian glyph -> measureText menghitung lebar kutip + glyph,
      //   sehingga glyph tergeser dan tampak menimpa teks judul.
      //   Di sini SEMUA kutip pembungkus dibuang (bisa 1 atau 2 lapis).
      if (!raw || raw === 'none' || raw === 'normal') return null;
      var glyph = raw;
      for (var guard = 0; guard < 4; guard++) {
        var next = glyph.replace(/^["']/, '').replace(/["']$/, '');
        if (next === glyph) break;
        glyph = next;
      }
      if (!glyph) return null;
      var cs = getComputedStyle(el);
      return {
        glyph: glyph,
        font: bef.fontFamily || cs.fontFamily || 'Font Awesome 6 Free',
        // ⚠ [FIX 2026-10-26e] BERAT HURUF WAJIB IKUT.
        // Ikon `fa-solid` memakai `font-weight: 900`. Bila string font canvas
        // hanya "14px Font Awesome 6 Free" (tanpa 900), browser memakai face
        // 400 — glyph tetap muncul tetapi jadi SILUET TIPIS: terukur 50 piksel
        // tinta 9x10 px, sedangkan face 900 menghasilkan 133 piksel 16x13 px.
        // Itu sebabnya ikon di Copy Image "tidak sama persis" dengan pop-up.
        weight: String(bef.fontWeight || cs.fontWeight || '900').trim(),
        style: String(bef.fontStyle || cs.fontStyle || 'normal').trim(),
        color: cs.color,
        size: px(bef.fontSize || cs.fontSize) || 13
      };
    }

    /**
     * CSS `text-align` -> nilai `ctx.textAlign` yang setara.
     * `start`/`end` di konteks LTR = `left`/`right`; nilai tak dikenal
     * (`justify`, `-moz-*`) jatuh ke 'left' — perilaku lama.
     */
    function cssAlign(v) {
      var a = String(v || '').trim();
      if (a === 'center') return 'center';
      if (a === 'right' || a === 'end') return 'right';
      return 'left';
    }

    /** String font canvas LENGKAP: "<style> <weight> <size>px <family>". */
    function iconFont(ic, scale) {
      var sz = (ic.size * (scale || 1));
      var st = ic.style && ic.style !== 'normal' ? ic.style + ' ' : '';
      var wt = ic.weight || '900';
      return st + wt + ' ' + sz + 'px ' + ic.font;
    }

    /**
     * [FIX 2026-10-26d] Gambar GLYPH ikon Font Awesome di kotak yang diberikan.
     * ---------------------------------------------------------------------
     * BUG yang diperbaiki: ikon MENUMPUK teks judul. Penyebabnya BUKAN jarak
     * (gap 7px terukur benar) melainkan `ctx.textAlign` yang TIDAK PERNAH
     * di-set: ia mewarisi nilai dari penggambaran sebelumnya (chip memakai
     * 'center'), sehingga glyph yang seharusnya mulai di tepi kiri kotak
     * justru bergeser ke KIRI sejauh setengah lebarnya — menimpa teks di
     * sebelah kiri, dan judul tampak "menempel" pada ikon.
     *
     * Semua state kanvas yang memengaruhi posisi (textAlign, textBaseline)
     * di-set EKSPLISIT di sini dan dipulihkan lewat save/restore. Fungsi
     * gambar tidak boleh bergantung pada sisa state pemanggil.
     *
     * Posisi horizontal memakai `actualBoundingBoxLeft`: Font Awesome punya
     * bearing kiri ~1px, tanpa koreksi ini glyph tampak bergeser sedikit.
     *
     * @param {CanvasRenderingContext2D} c
     * @param {object} ic  hasil iconOf() -> { glyph, font, color, size }
     * @param {number} boxX  tepi KIRI kotak ikon (px kanvas)
     * @param {number} centerY pusat vertikal kotak ikon (px kanvas)
     * @param {number} boxW  lebar kotak ikon (px kanvas)
     */
    function drawIconGlyph(c, ic, boxX, centerY, boxW) {
      if (!ic || !ic.glyph) return;
      c.save();
      // WAJIB pakai iconFont(): tanpa berat 900 glyph jadi siluet tipis dan
      // TIDAK sama dengan ikon di pop-up (lihat catatan iconOf).
      c.font = iconFont(ic, SS);
      c.fillStyle = ic.color;
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      // Font Awesome memakai glyph yang lebarnya SUDAH sama dengan kotak <i>
      // (terukur: natural 14,01 px vs kotak 14,01 px), dan CSS `text-align:
      // start`. Jadi glyph digambar RATA KIRI di tepi kotak — sama seperti
      // pop-up. Memberi offset "tengah" justru menggeser 5px lebih kanan.
      c.fillText(ic.glyph, boxX, centerY);
      c.restore();
    }

    /** Kotak pembulatan (radius) + isian + garis tepi, skala SS. */
    function roundRectPath(c, x, y, w, h, r) {
      var rr = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rr, y);
      c.arcTo(x + w, y, x + w, y + h, rr);
      c.arcTo(x + w, y + h, x, y + h, rr);
      c.arcTo(x, y + h, x, y, rr);
      c.arcTo(x, y, x + w, y, rr);
      c.closePath();
    }

    /**
     * Gambar satu kotak "panel": isian, bayangan, lalu garis tepi.
     * `opts` = { bg, borderLeft:{w,color}, border:{w,color}, radius, shadow, pad }
     * `sides` menentukan sisi mana yang digambar (default semua).
     */
    function drawBox(c, x, y, w, h, o) {
      var r = (o.radius || 0) * SS;
      // `o.paint` = hasil bgPaintOf() (warna ATAU linear-gradient).
      // `o.bg` tetap didukung untuk kasus sederhana (chip, fallback).
      var paint = o.paint || (o.bg && o.bg !== 'rgba(0, 0, 0, 0)'
        ? { type: 'color', color: o.bg } : null);

      if (o.shadow) {
        c.save();
        c.shadowColor = o.shadow;
        c.shadowBlur = (o.shadowBlur || 0) * SS;
        c.shadowOffsetY = (o.shadowY || 0) * SS;
        roundRectPath(c, x, y, w, h, r);
        c.fillStyle = o.shadowBase || '#0f172a';
        c.fill();
        c.restore();
      }
      if (paint) {
        c.save();
        roundRectPath(c, x, y, w, h, r);
        c.clip();
        fillBg(c, x, y, w, h, paint);
        c.restore();
      }
      if (o.borderLeft && o.borderLeft.w > 0) {
        // Pita kiri (border-left berwarna) — digambar sebagai busur radius.
        c.save();
        roundRectPath(c, x, y, w, h, r);
        c.clip();
        c.fillStyle = o.borderLeft.color;
        c.fillRect(x, y, o.borderLeft.w * SS, h);
        c.restore();
      }
      if (o.border && o.border.w > 0) {
        roundRectPath(c, x, y, w, h, r);
        c.lineWidth = o.border.w * SS;
        c.strokeStyle = o.border.color;
        c.stroke();
      }
    }

    /**
     * Teks yang MENGALIR seperti HTML: kata dibungkus pada lebar `maxW`,
     * dengan potongan `<strong>` memakai font/teks tersendiri.
     * `segs` = [{ text, el }] — el menentukan font & warna.
     * Mengembalikan tinggi yang terpakai.
     */
    function drawRichText(c, segs, x, y, maxW, lineH, baseColor) {
      // State kanvas di-set EKSPLISIT: 'center' yang bocor dari penggambaran
      // sebelumnya akan menggeser SETIAP kata sejauh setengah lebarnya.
      c.save();
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      // Bangun daftar token: {word, font, color, isSpace}
      var tokens = [];
      segs.forEach(function (s) {
        var words = String(s.text || '').split(/(\s+)/).filter(function (t) { return t !== ''; });
        words.forEach(function (t) {
          tokens.push({ t: t, font: s.font, color: s.color, space: /^\s+$/.test(t) });
        });
      });
      var cx = 0, cy = 0;
      var asc = lineH * 0.78;
      tokens.forEach(function (tk) {
        c.font = tk.font;
        if (tk.space) { cx += c.measureText(tk.t).width; return; }
        var w = c.measureText(tk.t).width;
        if (cx > 0 && cx + w > maxW) { cx = 0; cy += lineH; }
        c.fillStyle = tk.color || baseColor;
        c.fillText(tk.t, x + cx, y + cy + asc);
        cx += w;
      });
      c.restore();
      return cy + lineH;
    }

    var out = document.createElement('canvas');

    // --- Geometri dari DOM ------------------------------------------------
    var gridRect = grid.getBoundingClientRect();
    var descEl0 = document.getElementById('failmode-desc');
    var wrapEl = descEl0 ? descEl0.parentElement : null;

    // Kolom dihitung dari posisi nyata panel (grid responsif 1..3 kolom).
    var cols = 0, firstTop = Math.round(panels[0].getBoundingClientRect().top);
    var panelBoxes = panels.map(function (p) {
      var r = p.getBoundingClientRect();
      return { el: p, w: r.width, h: r.height, top: r.top, left: r.left };
    });
    panelBoxes.forEach(function (b) {
      if (Math.round(b.top) === firstTop) cols++;
    });
    if (cols < 1) cols = 1;
    var rows = Math.ceil(panels.length / cols);

    // Jarak kolom & baris diambil dari grid (gap CSS), bukan konstanta.
    var gridCs = getComputedStyle(grid);
    var colGap = panelBoxes.length > 1 ? (panelBoxes[1].left - panelBoxes[0].left - panelBoxes[0].w) : 0;
    if (!isFinite(colGap) || colGap < 0) colGap = px(gridCs.columnGap) || 14;
    var rowGap = rows > 1 && panelBoxes[cols]
      ? (panelBoxes[cols].top - panelBoxes[0].top - panelBoxes[0].h)
      : px(gridCs.rowGap) || 14;
    if (!isFinite(rowGap) || rowGap < 0) rowGap = 14;

    var PAD = px(gridCs.paddingLeft) || 16;
    var GAP = rowGap;

    // Lebar konten = grid selebar aslinya (bukan lebar sel × kolom).
    var contentW = gridRect.width;
    if (!contentW) return null;
    var descRect = descEl0 ? descEl0.getBoundingClientRect() : null;
    var descChild = descEl0 ? descEl0.firstElementChild : null;

    /* [REVISI 2026-10-26c] BREADCRUMB: LEBAR PENUH + JARAK = GAP KARTU.
     * --------------------------------------------------------------------
     * Ukuran & jarak TIDAK LAGI dikarang. Ketiga angka di bawah semuanya
     * diukur dari DOM aslinya, sehingga gambar tidak bisa menyimpang lagi:
     *
     *   boxW  (boks breadcrumb) = lebar ISI modal, yaitu lebar grid.
     *         Versi lama memakai lebar panel modal (1178) sedangkan grid
     *         (1138) di-inset 20px oleh padding modal-body -> boks breadcrumb
     *         tampak lebih lebar dari kartu di bawahnya. Permintaan operator:
     *         "lebar breadcrumb full horizontal seperti di pop-up" -> ikut
     *         lebar grid, tepi kiri-kanan lurus dengan kartu.
     *
     *   headGap (breadcrumb -> kartu pertama) = SAMA dengan jarak antar-kartu
     *         (gap grid). Dulu diambil padding-top modal-body (16px) sementara
     *         gap grid 14px, jadi jaraknya terlihat tidak konsisten.
     *
     *   bodyGap (grid -> Result Description) juga diukur, bukan ditebak 16.
     * ------------------------------------------------------------------ */
    var headElM = document.querySelector('#failmode-modal .modal-head');
    var headRect = headElM ? headElM.getBoundingClientRect() : null;
    var HEAD_H = headRect ? headRect.height : 56;

    // Jarak antar-kartu VERTIKAL = acuan jarak breadcrumb -> kartu.
    var ROW_GAP_REF = rowGap;                     // diukur dari grid (lihat atas)
    var headGap = ROW_GAP_REF;

    var gridH = gridRect.height;
    var bodyGap = (descRect && wrapEl) ? (descRect.top - (gridRect.top + gridH)) : 0;
    if (!isFinite(bodyGap) || bodyGap < 0) bodyGap = HEAD_H;
    var descH = descRect ? descRect.height : 0;

    out.width = Math.round((PAD * 2 + contentW) * SS);
    var totalH = PAD + HEAD_H + headGap + gridH +
                 (descH ? bodyGap + descH : 0) + PAD;
    out.height = Math.round(totalH * SS);

    var ctx = out.getContext('2d');
    ctx.textBaseline = 'top';

    // Latar modal = warna panel modal sebenarnya.
    var modalPanel = document.querySelector('#failmode-modal .modal-panel');
    var bgColor = modalPanel ? getComputedStyle(modalPanel).backgroundColor : 'rgb(15, 23, 42)';
    if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)') bgColor = '#0f172a';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, out.width, out.height);

    if (headElM && headRect) {
      var hr = headRect;
      var hcs = getComputedStyle(headElM);
      var hx = PAD * SS, hy = PAD * SS;
      // LEBAR PENUH: selebar grid (bukan selebar panel modal). Padding kiri
      // judul tetap dipertahankan agar sejajar dengan padding modal aslinya.
      var hw = contentW * SS;
      var hh = HEAD_H * SS;
      // Padding kiri teks judul di layar dihitung dari tepi KIRI GRID, supaya
      // saat boks dilebarkan judul tidak ikut bergeser keluar.
      var hPadL = px(hcs.paddingLeft);
      if (gridRect.left > hr.left) hPadL += (gridRect.left - hr.left);
      drawBox(ctx, hx, hy, hw, hh, {
        paint: bgPaintOf(headElM),
        border: { w: px(hcs.borderBottomWidth), color: hcs.borderBottomColor },
        radius: px(hcs.borderTopLeftRadius),
        pad: 0
      });
      // Ikon di kepala modal (fa-chart-area) — ikut digambar, bukan hilang.
      //
      // ⚠ [BUG 2026-10-26d] ORIGIN HARUS KONSISTEN. Boks breadcrumb digambar
      //   mulai x = PAD dan selebar GRID, sedangkan judul/ikon di DOM bertolak
      //   dari tepi PANEL modal — selisihnya `gridRect.left - hr.left` (20px,
      //   yaitu padding horizontal modal-body). Tanpa dikurangi, ikon bergeser
      //   +40px kanvas dan mendarat TEPAT di atas teks judul.
      var hIcon = headElM.querySelector('h2 i, h3 i, i');
      if (hIcon) {
        var hir = hIcon.getBoundingClientRect();
        var hOffX = gridRect.left - hr.left;      // geser sama dgn teks judul
        drawIconGlyph(ctx, iconOf(hIcon),
                      hx + (hir.left - hr.left - hOffX) * SS,
                      hy + (hir.top - hr.top + hir.height / 2) * SS,
                      hir.width * SS);
      }
      var titleEl = document.getElementById('failmode-title-text');
      var subEl = document.getElementById('failmode-sub');
      [titleEl, subEl].forEach(function (el) {
        if (!el) return;
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        ctx.save();
        ctx.font = scaledFont(cs.font);
        ctx.fillStyle = cs.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        // Posisi horizontal MURNI dari DOM (relatif boks breadcrumb yang
        // sudah disejajarkan dengan grid) — tidak ada hPadL tebakan.
        var relL = (r.left - hr.left) - (gridRect.left - hr.left);
        ctx.fillText(el.textContent || '', hx + relL * SS,
                     hy + (r.top - hr.top) * SS);
        ctx.restore();
      });
    }

    // --- Kartu ------------------------------------------------------------
    panelBoxes.forEach(function (b, i) {
      var p = b.el;
      var col = i % cols, row = Math.floor(i / cols);
      // Posisi vertikal: PAD -> breadcrumb -> headGap -> kartu (lihat HEAD_H).
      var x = (PAD + col * (b.w + colGap)) * SS;
      var y = (PAD + HEAD_H + headGap + row * (b.h + GAP)) * SS;
      var w = b.w * SS, h = b.h * SS;

      var pcs = getComputedStyle(p);
      var shadowTxt = pcs.boxShadow;
      var shadow = null, shadowBlur = 0, shadowY = 0;
      if (shadowTxt && shadowTxt !== 'none') {
        // "rgba(0, 0, 0, 0.25) 0px 8px 30px 0px"
        var m = shadowTxt.match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/);
        if (m) { shadow = m[1]; shadowBlur = parseFloat(m[4]); shadowY = parseFloat(m[3]); }
      }
      drawBox(ctx, x, y, w, h, {
        // ⚠ background-color kartu TRANSPARAN; isian sebenarnya linear-gradient.
        paint: bgPaintOf(p),
        border: { w: px(pcs.borderTopWidth), color: pcs.borderTopColor },
        radius: px(pcs.borderTopLeftRadius),
        shadow: shadow, shadowBlur: shadowBlur, shadowY: shadowY,
        shadowBase: bgColor
      });

      var padL = px(pcs.paddingLeft), padT = px(pcs.paddingTop);

      // Judul kartu — posisi, perataan & font dari elemen aslinya.
      //
      // [FIX 2026-10-26e] PERATAAN IKUT CSS, BUKAN DIPAKU 'left'.
      // `.failmode-title` memakai `text-align:center` (css/vhms-dashboard.css),
      // jadi memaku 'left' membuat judul di Copy Image rata kiri sementara di
      // pop-up rata tengah — persis ketidakkonsistenan yang dilaporkan.
      // Catatan lama "jangan mewarisi 'center' dari chip" tetap dihormati:
      // nilainya di-set EKSPLISIT dari computed style, bukan dibiarkan bocor.
      var titleElP = p.querySelector('.failmode-title');
      if (titleElP) {
        var tr = titleElP.getBoundingClientRect();
        var tcs = getComputedStyle(titleElP);
        ctx.save();
        ctx.font = scaledFont(tcs.font);
        ctx.fillStyle = tcs.color;
        var tAlign = cssAlign(tcs.textAlign);
        ctx.textAlign = tAlign;
        ctx.textBaseline = 'top';
        var tx = (tAlign === 'center') ? (x + w / 2)
               : (tAlign === 'right')  ? (x + w - padL * SS)
               : (x + padL * SS);
        ctx.fillText((titleElP.textContent || '').trim(),
                     tx, y + (tr.top - b.top) * SS);
        ctx.restore();
      }

      // Kanvas grafik — digambar pada ukuran CSS-nya (bukan ukuran atribut),
      // sehingga skala visual SAMA dengan pop-up (dulu mengecil 1/1,2).
      var cvEl = p.querySelector('canvas');
      if (cvEl) {
        var cr = cvEl.getBoundingClientRect();
        try {
          ctx.drawImage(cvEl, x + (cr.left - b.left) * SS, y + (cr.top - b.top) * SS,
                        cr.width * SS, cr.height * SS);
        } catch (e) {}
      }

      /* Legend — MENGALIR seperti flexbox aslinya.
       * --------------------------------------------------------------------
       * [FIX 2026-10-26e] PERATAAN BARIS IKUT `justify-content`.
       * `.failmode-legend` memakai `justify-content:center`, jadi tiap BARIS
       * legend di pop-up rata tengah. Versi lama menggambar semua item mulai
       * dari tepi kiri legend -> di Copy Image legend menumpuk ke kiri,
       * sementara di pop-up ia simetris. Sekarang item dikumpulkan dulu per
       * baris (ukur lebar baris), lalu digambar dengan offset tengah/kanan
       * sesuai `justify-content`. Perilaku 'flex-start' tetap sama persis
       * seperti sebelumnya. */
      var legEl = cvEl ? document.getElementById(cvEl.id + '-legend') : null;
      if (legEl) {
        var lr = legEl.getBoundingClientRect();
        var lcs = getComputedStyle(legEl);
        var items = Array.prototype.slice.call(legEl.children);
        var itemGap = px(lcs.columnGap) || 10;
        var legMaxW = lr.width * SS;
        var cx0 = x + (lr.left - b.left) * SS;
        var cy0 = y + (lr.top - b.top) * SS;
        var dotEl0 = legEl.querySelector('.dot');
        var dotW = dotEl0 ? dotEl0.getBoundingClientRect().width * SS : 9 * SS;

        // (1) Bungkus item menjadi baris — sama persis dengan flex-wrap.
        var lines = [], line = { items: [], w: 0, h: 0 };
        items.forEach(function (item) {
          var icss = getComputedStyle(item);
          var f = scaledFont(icss.font);
          ctx.font = f;
          var txt = (item.textContent || '').trim();
          var iw = dotW + 6 * SS + ctx.measureText(txt).width;
          var ih = item.getBoundingClientRect().height * SS;
          var need = line.items.length ? (line.w + itemGap * SS + iw) : iw;
          if (line.items.length && need > legMaxW) { lines.push(line); line = { items: [], w: 0, h: 0 }; }
          line.w = line.items.length ? (line.w + itemGap * SS + iw) : iw;
          if (ih > line.h) line.h = ih;
          line.items.push({ txt: txt, w: iw, font: f, color: icss.color,
                            dot: item.querySelector('.dot') });
        });
        if (line.items.length) lines.push(line);

        // (2) Gambar tiap baris dengan offset sesuai justify-content.
        var jc = String(lcs.justifyContent || 'flex-start');
        var cy = cy0;
        lines.forEach(function (ln) {
          var free = legMaxW - ln.w;
          if (free < 0) free = 0;
          var cx = cx0 + (jc === 'center' ? free / 2
                        : (jc === 'flex-end' || jc === 'right' || jc === 'end') ? free
                        : 0);
          ln.items.forEach(function (it) {
            var dotColor = it.dot ? getComputedStyle(it.dot).backgroundColor : '#38bdf8';
            ctx.fillStyle = dotColor;
            ctx.beginPath();
            ctx.arc(cx + dotW / 2, cy + ln.h / 2, dotW / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = it.font;
            ctx.fillStyle = it.color;
            ctx.textAlign = 'left';  // eksplisit — lihat catatan drawIconGlyph
            ctx.textBaseline = 'middle';
            ctx.fillText(it.txt, cx + dotW + 6 * SS, cy + ln.h / 2);
            ctx.textBaseline = 'top';
            cx += it.w + itemGap * SS;
          });
          cy += ln.h;
        });
      }
    });

    /* --------------------------------------------------------------------
     * Result Description — digambar dari DOM, bukan dikarang ulang.
     * ------------------------------------------------------------------
     * Versi lama menggambar blok ini dengan konstanta sendiri: tanpa panel
     * (latar & border), judul tanpa ikon, font 11px padahal aslinya 11,5px,
     * dan chip sebagai kotak polos. Hasilnya terbaca sebagai "kotak teks
     * biasa" yang jelas berbeda dari pop-up.
     *
     * Sekarang: panel (latar/garis tepi/radius/bayangan) dari computed style
     * `.sfm-desc`, judul + ikon Font Awesome dari elemen aslinya, paragraf
     * digambar sebagai RICH TEXT (potongan <strong> tebal & lebih terang),
     * dan setiap chip digambar persis kotak aslinya (latar, garis, radius,
     * warna teks, termasuk chip riwayat bergaris putus-putus).
     * ---------------------------------------------------------------- */
    if (descEl0 && descChild && descH > 0) {
      var dr = descRect;
      var dx = PAD * SS;
      var dy = (PAD + HEAD_H + headGap + gridH + bodyGap) * SS;
      var dw = dr.width * SS, dh = dr.height * SS;

      var dcs2 = getComputedStyle(descChild);
      var dShadow = null, dShadowBlur = 0, dShadowY = 0;
      if (dcs2.boxShadow && dcs2.boxShadow !== 'none') {
        var dm = dcs2.boxShadow.match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/);
        if (dm) { dShadow = dm[1]; dShadowBlur = parseFloat(dm[4]); dShadowY = parseFloat(dm[3]); }
      }
      // Latar `.sfm-desc` transparan di atas modal gelap; beri isian halus
      // supaya panel tetap terbaca seperti di layar (CSS memakai rgba).
      var dBg = dcs2.backgroundColor;
      if (!dBg || dBg === 'rgba(0, 0, 0, 0)') {
        dBg = (dcs2.classList && dcs2.classList.contains('sfm-desc-crit'))
          ? 'rgba(239,68,68,.055)' : 'rgba(15,23,42,.55)';
      }
      drawBox(ctx, dx, dy, dw, dh, {
        bg: dBg,
        borderLeft: { w: px(dcs2.borderLeftWidth), color: dcs2.borderLeftColor },
        border: { w: 0, color: 'transparent' },
        radius: px(dcs2.borderTopLeftRadius),
        shadow: dShadow, shadowBlur: dShadowBlur, shadowY: dShadowY,
        shadowBase: bgColor
      });

      var dPadL = px(dcs2.paddingLeft), dPadT = px(dcs2.paddingTop);

      // Judul + ikon.
      var dTitleEl = descChild.querySelector('.sfm-desc-title');
      if (dTitleEl) {
        var dtr = dTitleEl.getBoundingClientRect();
        var dtcs = getComputedStyle(dTitleEl);
        var ty0 = dy + (dtr.top - dr.top) * SS;
        // Ikon Font Awesome: glyph dari `::before` (lihat iconOf).
        var iconEl = dTitleEl.querySelector('i');
        if (iconEl) {
          var ic = iconOf(iconEl);
          var iwr = iconEl.getBoundingClientRect();
          // Origin: dx = tepi kiri boks deskripsi, dr = rect DOM-nya. Konsisten.
          drawIconGlyph(ctx, ic,
                        dx + (iwr.left - dr.left) * SS,
                        dy + (iwr.top + iwr.height / 2 - dr.top) * SS,
                        iwr.width * SS);
        }
        // TEKS JUDUL: posisi horizontal diambil dari kotak teks SETELAH ikon.
        // `i.nextSibling` adalah text-node judul; pakai Range agar posisinya
        // eksak (bukan menebak lebar ikon + gap).
        var titleTxt = dTitleEl.textContent.trim();
        var tx0 = dx + dPadL * SS;
        if (iconEl && iconEl.nextSibling) {
          try {
            var rng = document.createRange();
            rng.selectNodeContents(iconEl.nextSibling);
            var tr2 = rng.getBoundingClientRect();
            if (tr2 && tr2.width > 0) tx0 = dx + (tr2.left - dr.left) * SS;
          } catch (e) {}
        }
        ctx.save();
        ctx.font = scaledFont(dtcs.font);
        ctx.fillStyle = dtcs.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(titleTxt, tx0, ty0);
        ctx.restore();
      }

      // Paragraf — RICH TEXT: <strong> tetap tebal & warnanya sendiri.
      var dBody = descChild.querySelector('.sfm-desc-body');
      if (dBody) {
        var bcs = dBody.getBoundingClientRect();
        var bstyle = getComputedStyle(dBody);
        var lineH = px(bstyle.lineHeight) * SS || (px(bstyle.fontSize) * 1.65 * SS);
        var segs = [];
        Array.prototype.slice.call(dBody.childNodes).forEach(function (node) {
          if (node.nodeType === 3) {
            var t = node.textContent.replace(/\s+/g, ' ');
            if (t.trim()) segs.push({ text: t, font: scaledFont(bstyle.font), color: bstyle.color });
          } else if (node.nodeType === 1) {
            var ecs = getComputedStyle(node);
            var et = node.textContent.replace(/\s+/g, ' ');
            if (et.trim()) segs.push({ text: et, font: scaledFont(ecs.font), color: ecs.color });
          }
        });
        drawRichText(ctx, segs, dx + dPadL * SS,
                     dy + (bcs.top - dr.top) * SS,
                     bcs.width * SS, lineH, bstyle.color);
      }

      // Chip — tiap chip digambar dari kotaknya sendiri.
      var chipsWrap = descChild.querySelector('.sfm-desc-chips');
      if (chipsWrap) {
        Array.prototype.slice.call(chipsWrap.children).forEach(function (chip) {
          var cr2 = chip.getBoundingClientRect();
          var ccs = getComputedStyle(chip);
          var cw = cr2.width * SS, chh = cr2.height * SS;
          var cxp = dx + (cr2.left - dr.left) * SS;
          var cyp = dy + (cr2.top - dr.top) * SS;
          var cBg = ccs.backgroundColor;
          drawBox(ctx, cxp, cyp, cw, chh, {
            bg: cBg && cBg !== 'rgba(0, 0, 0, 0)' ? cBg : null,
            border: { w: px(ccs.borderTopWidth), color: ccs.borderTopColor },
            radius: px(ccs.borderTopLeftRadius)
          });
          // Chip riwayat bergaris putus-putus (border-style: dashed).
          if (ccs.borderTopStyle === 'dashed' && px(ccs.borderTopWidth) > 0) {
            ctx.save();
            ctx.setLineDash([3 * SS, 3 * SS]);
            roundRectPath(ctx, cxp, cyp, cw, chh, px(ccs.borderTopLeftRadius) * SS);
            ctx.lineWidth = px(ccs.borderTopWidth) * SS;
            ctx.strokeStyle = ccs.borderTopColor;
            ctx.stroke();
            ctx.restore();
          }
          var ctcs = getComputedStyle(chip);
          ctx.save();
          ctx.font = scaledFont(ctcs.font);
          ctx.fillStyle = ctcs.color;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText(chip.textContent.trim(), cxp + cw / 2, cyp + chh / 2);
          // save/restore WAJIB: 'center' yang bocor ke pemanggil berikutnya
          // adalah penyebab bug ikon menumpuk teks (lihat drawIconGlyph).
          ctx.restore();
        });
      }
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
    // [REVISI 2026-10-25a] Diekspor agar aturan pembulatan & kaidah deteksi
    // sensor macet dapat DIKUNCI uji — keduanya mudah rusak senyap.
    fmtVal: fmtVal,
    stuckSensor: stuckSensor,
    latestOf: latestOf,
    STUCK_RATIO: STUCK_RATIO,
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

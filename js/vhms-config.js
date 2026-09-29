/* =========================================================================
 * vhms-config.js
 * -------------------------------------------------------------------------
 * Konfigurasi pemetaan kolom VHMS PC2000 <-> struktur dashboard.
 *
 * Sumber kebenaran NAMA KOLOM adalah baris "Axis Item" pada file trend0.CSV.
 * Jadi kunci di sini ditulis SAMA PERSIS dengan header CSV (case-insensitive,
 * spasi/tanda titik diabaikan saat pencocokan) supaya kalau format VHMS
 * sedikit berubah, cukup sesuaikan file ini saja.
 *
 * CATATAN: Definisi kolom di bawah mengikuti struktur umum VHMS "Trend
 * Analysis" (Axis Item 1..N). Urutan/posisi TIDAK dipakai untuk indexing;
 * parser selalu mencari berdasarkan NAMA header. Jadi kalau unit lain punya
 * urutan kolom berbeda, dashboard tetap jalan.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1a. SKALA SMR
   * ---------------------------------------------------------------------
   * Pada beberapa export VHMS, kolom SMR tersimpan dalam satuan 0.1 jam
   * (mis. 750035 => 75.003,5 jam). Field `SMR_SCALE` membagi nilai mentah
   * ke satuan jam yang benar agar tampil wajar (tidak ratusan ribu).
   *
   * Bila unit Anda menulis SMR dalam satuan jam penuh (mis. 75003),
   * cukup ubah nilai ini menjadi 1.
   * --------------------------------------------------------------------- */
  var SMR_SCALE = 0.1;

  /* -----------------------------------------------------------------------
   * 1. Definisi parameter chart & KPI
   * --------------------------------------------------------------------- */

  /**
   * Setiap entri: { key, csvHeader, label, unit, scale, decimals }
   *  - key       : id internal di dalam aplikasi
   *  - csvHeader : nama persis seperti di baris "Axis Item" (fuzzy match)
   *  - scale     : pengali setelah parsing (mis. cm3 -> Liter = 0.001)
   *  - decimals  : jumlah desimal untuk tampilan
   */
  var PARAMS = {
    smr:             { csvHeader: 'SMR',                  label: 'SMR',                    unit: 'h',       decimals: 1 },
    calendar:        { csvHeader: 'Calendar',             label: 'Waktu Rekam',            unit: '',        decimals: 0 },

    engSpeedMax:     { csvHeader: 'Eng.Speed(Max)',       label: 'Eng. Speed Max',         unit: 'rpm',     decimals: 0 },
    engSpeedAve:     { csvHeader: 'Eng.Speed(Ave)',       label: 'Eng. Speed Ave',         unit: 'rpm',     decimals: 0 },
    // CATATAN SKALA: CSV VHMS menyimpan sebagian nilai dalam satuan terkecil
    // (mis. tekanan MPa dikali 10, blowby kPa dikali 100, BBM L/h dikali 10).
    // Field `scale` membagi nilai mentah ke satuan engineering yang benar.
    blowbyMax:       { csvHeader: 'BlowbyPress Max',      label: 'Blowby Press Max',       unit: 'kPa',     decimals: 2, scale: 0.01 },
    // [SATUAN mmHg] Boost ditampilkan dalam mmHg. Nilai mentah CSV dalam kPa
    // (lihat baris "Axis Scale" = kPa), dikonversi ke mmHg dengan kali 7.50062.
    // CATATAN: scale lama 0.1 SALAH (menganggap nilai kPa/10) -> nilai boost
    // 10x terlalu kecil. Kini scale = 7.50062 (kPa -> mmHg).
    boostMax:        { csvHeader: 'Boost Press Max',      label: 'Boost Press Max',        unit: 'mmHg',    decimals: 1, scale: 7.50062 },
    oilPressMax:     { csvHeader: 'EOil Pre.MAX',         label: 'Engine Oil Press Max',   unit: 'MPa',     decimals: 2, scale: 0.01 },
    oilPressMin:     { csvHeader: 'E.Oil P.L_Min',        label: 'Engine Oil Press L-Min', unit: 'MPa',     decimals: 2, scale: 0.01 },
    // CATATAN ALIAS: sebagian unit (mis. HD785) menulis tekanan oli high-min
    // sebagai "E.Oil P.Hi_Min" (dengan "Hi"), bukan "E.Oil P.H_Min".
    // Field `aliases` membuat parser mencocokkan SEMUA nama alternatif.
    oilPressHMin:    { csvHeader: 'E.Oil P.H_Min',        label: 'Engine Oil Press H-Min', unit: 'MPa',     decimals: 2, scale: 0.01,
                       aliases: ['E.Oil P.Hi_Min', 'E.Oil P.H.Min', 'EOil P.H_Min', 'Engine Oil Press H-Min'] },
    engOilTemp:      { csvHeader: 'Eng.Oil Tmp.MAX',      label: 'Engine Oil Temp Max',    unit: '\u00B0C', decimals: 1 },
    coolantTemp:     { csvHeader: 'Cool Temp.MAX',        label: 'Coolant Temp Max',       unit: '\u00B0C', decimals: 1 },
    coolantTempMin:  { csvHeader: 'Cool Temp.Min',        label: 'Coolant Temp Min',       unit: '\u00B0C', decimals: 1 },
    fuelRate:        { csvHeader: 'Fuel Rate',            label: 'Fuel Rate',              unit: 'L/h',     decimals: 1, scale: 0.1 },
    ambientMax:      { csvHeader: 'Ambient TempMax',      label: 'Ambient Temp Max',       unit: '\u00B0C', decimals: 1 },
    ambientAve:      { csvHeader: 'Ambient TempAve',      label: 'Ambient Temp Ave',       unit: '\u00B0C', decimals: 1 },
    ambientMin:      { csvHeader: 'Ambient TempMin',      label: 'Ambient Temp Min',       unit: '\u00B0C', decimals: 1 },
    // CATATAN KONVERSI: CSV VHMS menyimpan tekanan atmosfer dalam kPa
    // (mis. 98 kPa), sedangkan tampilan & threshold baku memakai hPa.
    // 1 kPa = 10 hPa, jadi nilai mentah dikali 10 (mis. 98 -> 980 hPa).
    atmosAve:        { csvHeader: 'Atomos. Pres.Ave',     label: 'Atmospheric Press Ave',  unit: 'hPa',     decimals: 0, scale: 10 },

    pump1F:          { csvHeader: 'Pump 1F P.Max',        label: 'Pump 1F Press Max',      unit: 'MPa',     decimals: 1, scale: 0.1 },
    pump1R:          { csvHeader: 'Pump 1R P.Max',        label: 'Pump 1R Press Max',      unit: 'MPa',     decimals: 1, scale: 0.1 },
    pump2F:          { csvHeader: 'Pump 2F P.Max',        label: 'Pump 2F Press Max',      unit: 'MPa',     decimals: 1, scale: 0.1 },
    pump2R:          { csvHeader: 'Pump 2R P.Max',        label: 'Pump 2R Press Max',      unit: 'MPa',     decimals: 1, scale: 0.1 },
    hydTempMax:      { csvHeader: 'HydOilTempMax',        label: 'Hyd. Oil Temp Max',      unit: '\u00B0C', decimals: 1 },
    hydTempAve:      { csvHeader: 'HydOilTempAve',        label: 'Hyd. Oil Temp Ave',      unit: '\u00B0C', decimals: 1 },
    hydTempMin:      { csvHeader: 'HydOilTempMin',        label: 'Hyd. Oil Temp Min',      unit: '\u00B0C', decimals: 1 },

    fanPumpF:        { csvHeader: 'FanPumpF P.Max',       label: 'Fan Pump F Press',       unit: 'MPa',     decimals: 1, scale: 0.1 },
    fanPumpR:        { csvHeader: 'FanPumpR P.Max',       label: 'Fan Pump R Press',       unit: 'MPa',     decimals: 1, scale: 0.1 },
    ptoTempMax:      { csvHeader: 'PTO Temp Max',         label: 'PTO Temp Max',           unit: '\u00B0C', decimals: 1 },
    ptoTempMin:      { csvHeader: 'PTO Temp Min',         label: 'PTO Temp Min',           unit: '\u00B0C', decimals: 1 },

    autoGrsPress:    { csvHeader: 'Auto GRS P.Max',       label: 'Auto Grease Press Max',  unit: 'MPa',     decimals: 1, scale: 0.1 },
    autoGrsOn:       { csvHeader: 'Auto GRS P. ON',       label: 'Auto GRS ON Cycles',     unit: 'kali',    decimals: 0 },

    truckCounter1:   { csvHeader: 'Truck Counter1',       label: 'Truck Counter 1',        unit: 'kali',    decimals: 0 },
    truckCounter2:   { csvHeader: 'Truck Counter2',       label: 'Truck Counter 2',        unit: 'kali',    decimals: 0 },
    swingCount:      { csvHeader: 'Swing Count',          label: 'Swing Count',            unit: 'kali',    decimals: 0 },
    loadCount:       { csvHeader: 'Load Count',           label: 'Load Count',             unit: 'kali',    decimals: 0 },

    engPowerMax:     { csvHeader: 'Engine Power Max',     label: 'Engine Power Max',       unit: 'kW',      decimals: 0 },
    engPowerAve:     { csvHeader: 'Engine Power Ave',     label: 'Engine Power Ave',       unit: 'kW',      decimals: 0 },
    ecoModeOn:       { csvHeader: 'Eco Mode on',          label: 'Eco Mode ON',            unit: 'sec',     decimals: 0 },

    // [POIN 1] Parameter khas keluarga lain (HD Truck / Dozer).
    // Hanya muncul bila kolomnya ada — parser mengabaikan bila absen.
    retarderTemp:    { csvHeader: 'Retarder Temp',        label: 'Retarder Temp',          unit: '\u00B0C', decimals: 1 },
    brakeTemp:       { csvHeader: 'Brake Temp',           label: 'Brake Temp',             unit: '\u00B0C', decimals: 1 },
    oilPressAve:     { csvHeader: 'EOil Pre.AVE',         label: 'Engine Oil Press Ave',   unit: 'MPa',     decimals: 2, scale: 0.01 },
    boostAve:        { csvHeader: 'Boost Press Ave',      label: 'Boost Press Ave',        unit: 'mmHg',    decimals: 1, scale: 7.50062 },

    // -----------------------------------------------------------------------
    // [D375A] Parameter khas DOZER tipe besar (D375A-6). Lihat file template
    // "65258.CSV". Kolom di bawah ini HANYA muncul pada keluarga DOZER; parser
    // otomatis mengabaikannya bila kolomnya tidak ada pada file lain, jadi
    // aman dipakai lintas model.
    // -----------------------------------------------------------------------

    // Suhu gas buang per bank (kiri/kanan). Nilai -32768 = sensor tidak ada.
    fExhTempMax:     { csvHeader: 'F Exh.Temp Max',       label: 'F Exhaust Temp Max',     unit: '\u00B0C', decimals: 0,
                       aliases: ['F Exh.TempMax', 'F Exhaust Temp Max'] },
    rExhTempMax:     { csvHeader: 'R Exh.Temp Max',       label: 'R Exhaust Temp Max',     unit: '\u00B0C', decimals: 0,
                       aliases: ['R Exh.TempMax', 'R Exhaust Temp Max'] },

    // Tekanan & suhu rantai transmisi / torque converter (Torque Main + T/C).
    tmMainPressMax:  { csvHeader: 'TM Main P.Max',        label: 'TM Main Press Max',      unit: 'MPa',     decimals: 2, scale: 0.1 },
    tmMainPressAve:  { csvHeader: 'TM Main P.Ave',        label: 'TM Main Press Ave',      unit: 'MPa',     decimals: 2, scale: 0.1 },
    tcOilTempMax:    { csvHeader: 'T/C Oil TempMax',      label: 'T/C Oil Temp Max',       unit: '\u00B0C', decimals: 1 },

    // Pompa hidrolik utama ("Large Pump") — penggerak blade/ripper dozer.
    // Catatan: CSV menulis dalam satuan terkecil (x10 kPa => MPa * 10),
    // sehingga scale 0.1 mengubah nilai mentah ke MPa.
    largePumpPress:  { csvHeader: 'Large Pump P.Max',     label: 'Large Pump Press Max',   unit: 'MPa',     decimals: 2, scale: 0.1 },

    // --- Produktivitas / payload DOZER (counter jam & jarak) ---
    operatingTime:   { csvHeader: 'Operating Time',       label: 'Operating Time',         unit: 'h',       decimals: 1, scale: 0.1 },
    dozingTime:      { csvHeader: 'Dozing Time',          label: 'Dozing Time',            unit: 'h',       decimals: 1, scale: 0.1 },
    rippingTime:     { csvHeader: 'Ripping Time',         label: 'Ripping Time',           unit: 'h',       decimals: 1, scale: 0.1 },
    passTimes:       { csvHeader: 'Pass Times',           label: 'Pass Times',             unit: 'kali',    decimals: 0 },

    // --- Kemiringan blade (pitch angle) — diagnostik beban & sikap unit ---
    pitchAngleMax:   { csvHeader: 'Pitch Angle Max',      label: 'Pitch Angle Max',        unit: '\u00B0',  decimals: 1, scale: 0.1 },
    pitchAngleAve:   { csvHeader: 'Pitch Angle Ave',      label: 'Pitch Angle Ave',        unit: '\u00B0',  decimals: 1, scale: 0.1 },
    pitchAngleMin:   { csvHeader: 'Pitch Angle Min',      label: 'Pitch Angle Min',        unit: '\u00B0',  decimals: 1, scale: 0.1 }
  };

  /* -----------------------------------------------------------------------
   * 1a-bis. [REVISI] PEMETAAN KOLOM DINAMIS PER KELUARGA PRODUK
   * ---------------------------------------------------------------------
   * Tidak semua keluarga menulis nama kolom yang sama. Mis. HD Truck
   * memakai "EOil Pre.MAX" (tanpa H-Min) sementara Excavator punya
   * "E.Oil P.H_Min"/"E.Oil P.Hi_Min". Agar pengambilan data DINAMIS dan
   * sesuai per model, tiap keluarga boleh menimpa (override) sebuah
   * parameter: ganti `csvHeader`, tambah `aliases`, ubah `scale`, atau
   * ubah `unit`. Data di bawah digabung dengan PARAMS saat resolusi.
   *
   * Format: { FAMILY_ID: { paramKey: { csvHeader?, aliases?, scale?, unit? } } }
   * --------------------------------------------------------------------- */
  var PARAM_COLUMN_OVERRIDES = {
    TRUCK: {
      // HD Truck: tekanan oli tersedia sebagai MAX & (opsional) Hi_Min.
      oilPressMax:  { aliases: ['EOil P.MAX', 'EOil Pre Max', 'Engine Oil Press Max'] },
      oilPressHMin: { aliases: ['E.Oil P.Hi_Min', 'E.Oil P.H.Min', 'EOil P.H_Min'] }
    },
    DOZER: {
      // [D375A] Dozer besar menulis "E.Oil P.Hi_Min" (dengan "Hi") serta
      // "Blowby Press Max" (pakai spasi). Semua nama alternatif didaftarkan
      // di sini agar pencocokan berbasis nama tetap berhasil.
      oilPressHMin: { aliases: ['E.Oil P.Hi_Min', 'E.Oil P.H.Min'] },
      oilPressMax:  { aliases: ['E.Oil P.Max', 'EOil P.Max', 'EOil Pre.Max'] },
      blowbyMax:    { aliases: ['Blowby Press Max'] }
    },
    EXCAVATOR: {}
  };

  /**
   * Ambil salinan efektif definisi PARAMS untuk sebuah keluarga:
   * gabungkan PARAMS dengan PARAM_COLUMN_OVERRIDES[familyId].
   * @param {string} familyId
   * @returns {object} peta PARAMS yang sudah di-override
   */
  function paramsForFamily(familyId) {
    var ov = PARAM_COLUMN_OVERRIDES[familyId];
    if (!ov || !Object.keys(ov).length) return PARAMS;
    var out = {};
    Object.keys(PARAMS).forEach(function (k) {
      out[k] = Object.assign({}, PARAMS[k]);
      var o = ov[k];
      if (o) {
        if (o.csvHeader) out[k].csvHeader = o.csvHeader;
        if (o.unit) out[k].unit = o.unit;
        if (o.scale !== undefined) out[k].scale = o.scale;
        if (o.aliases) out[k].aliases = (out[k].aliases || []).concat(o.aliases);
      }
    });
    return out;
  }

  /**
   * Daftar SEMUA nama header (untuk pencocokan) sebuah parameter: csvHeader
   * utama + seluruh alias. Dipakai parser agar toleran beda penamaan kolom.
   * @param {object} def definisi parameter (entri PARAMS)
   * @returns {string[]}
   */
  function paramHeaders(def) {
    if (!def) return [];
    var list = [];
    if (def.csvHeader) list.push(def.csvHeader);
    (def.aliases || []).forEach(function (a) { if (a) list.push(a); });
    return list;
  }

  /* -----------------------------------------------------------------------
   * 1b. [POIN 3] STANDARISASI SATUAN (mengikuti konvensi engineering Komatsu)
   * ---------------------------------------------------------------------
   * File VHMS kadang menulis satuan dengan notasi berbeda
   * (mis. "degC" vs "°C", "Liter/h" vs "L/h", "kPa" vs "KPa").
   * Peta di bawah menyatukan semuanya ke SATU notasi baku.
   * Kunci = satuan ternormalisasi (lowercase, tanpa tanda), nilai = baku.
   * --------------------------------------------------------------------- */
  var UNIT_ALIASES = {
    'degc': '\u00B0C', 'c': '\u00B0C', 'celsius': '\u00B0C', '\u00B0c': '\u00B0C',
    'kpa': 'kPa', 'kpaa': 'kPa',
    'mpa': 'MPa',
    'bar': 'bar',
    'hpa': 'hPa',
    'rpm': 'rpm', 'min-1': 'rpm',
    'l/h': 'L/h', 'liter/h': 'L/h', 'ltr/h': 'L/h', 'l/hours': 'L/h',
    'l/min': 'L/min', 'liter/min': 'L/min',
    'kw': 'kW', 'ps': 'PS', 'hp': 'HP',
    'nm': 'Nm',
    'h': 'h', 'hr': 'h', 'hours': 'h', 'hm': 'h',
    'sec': 's', 's': 's', 'second': 's', 'detik': 's',
    'times': 'kali', 'kali': 'kali', 'count': 'kali', 'cnt': 'kali',
    'v': 'V', 'volt': 'V', 'a': 'A', 'ampere': 'A',
    'l': 'L', 'liter': 'L', 'litre': 'L'
  };

  /** Bakukan satuan dari string mentah Axis Scale. */
  function normalizeUnit(raw) {
    if (raw === null || raw === undefined || raw === '') return '';
    var s = String(raw).trim();
    if (!s || s === '-' || s === '---') return '';
    var key = s.toLowerCase().replace(/\s+/g, '');
    return UNIT_ALIASES[key] || s;
  }

  /* -----------------------------------------------------------------------
   * 1c. [POIN 3] GRUP CHART DINAMIS
   * ---------------------------------------------------------------------
   * Alih-alih 4 chart hardcode, chart dibangun OTOMATIS dari grup di bawah.
   * Setiap grup hanya ditampilkan bila minimal `minParams` parameternya
   * benar-benar memiliki data pada file yang dimuat (fleksibel lintas model:
   * HD/PC/Dozer yang kolomnya berbeda).
   *
   * Tiap seri: { param, axis: 'left'|'right', color, type, fill, dashed }
   * Sumbu kiri/kanan dipisah otomatis bila satuan seri berbeda.
   * --------------------------------------------------------------------- */
  var CHART_GROUPS = [
    {
      id: 'group-engine', title: 'Engine Compartment',
      subtitle: 'Blowby & tekanan oli — pendeteksian dini keausan ring/liner',
      icon: 'fa-gauge-high', accent: '#ef4444', minParams: 1,
      series: [
        { param: 'blowbyMax',  axis: 'left',  color: '#ef4444', type: 'line', fill: true, width: 3 },
        { param: 'oilPressHMin', axis: 'right', color: '#fbbf24', type: 'line', width: 2, dashed: true },
        { param: 'oilPressMax', axis: 'right', color: '#f59e0b', type: 'line', width: 1.5 },
        { param: 'engOilTemp', axis: 'right', color: '#fb923c', type: 'line', width: 1.5, dashed: true }
      ]
    },
    {
      // [CHART TERPISAH] Boost (mmHg) nilainya jauh lebih besar dari blowby
      // (kPa) sehingga bila digabung membuat parameter lain "gepeng". Boost
      // dibuat chart sendiri agar skalanya terbaca jelas.
      id: 'group-boost', title: 'Turbo / Boost Pressure',
      subtitle: 'Tekanan boost (mmHg) — indikator pembakaran, turbo & filter udara',
      icon: 'fa-gauge-high', accent: '#22c55e', minParams: 1,
      series: [
        { param: 'boostMax', axis: 'left', color: '#22c55e', type: 'line', fill: true, width: 2.5 }
      ]
    },
    {
      id: 'group-hydraulic', title: 'Hydraulic System',
      subtitle: 'Matrix tekanan pompa & suhu oli hidrolik',
      icon: 'fa-oil-can', accent: '#f59e0b', minParams: 1,
      series: [
        { param: 'hydTempMax', axis: 'right', color: '#f59e0b', type: 'line', width: 2.5 },
        { param: 'pump1F', axis: 'left', color: 'rgba(6,182,212,0.75)', type: 'bar' },
        { param: 'pump1R', axis: 'left', color: 'rgba(59,130,246,0.75)', type: 'bar' },
        { param: 'pump2F', axis: 'left', color: 'rgba(129,140,248,0.75)', type: 'bar' },
        { param: 'pump2R', axis: 'left', color: 'rgba(192,132,252,0.75)', type: 'bar' }
      ]
    },
    {
      id: 'group-cooling', title: 'Thermal & Cooling',
      subtitle: 'Stabilitas pendinginan terhadap beban kerja & lingkungan',
      icon: 'fa-temperature-half', accent: '#38bdf8', minParams: 1,
      series: [
        { param: 'coolantTemp', axis: 'left', color: '#38bdf8', type: 'line', width: 2.5 },
        { param: 'engOilTemp',  axis: 'left', color: '#f97316', type: 'line', width: 2 },
        { param: 'ambientMax',  axis: 'left', color: '#94a3b8', type: 'line', width: 1.5, dashed: true }
      ]
    },
    {
      id: 'group-fanpto', title: 'Fan Drive & PTO',
      subtitle: 'Beban pompa fan & suhu sistem PTO',
      icon: 'fa-fan', accent: '#0ea5e9', minParams: 1,
      series: [
        { param: 'fanPumpF',  axis: 'left', color: '#0ea5e9', type: 'line', width: 2 },
        { param: 'fanPumpR',  axis: 'left', color: '#22d3ee', type: 'line', width: 2 },
        { param: 'ptoTempMax', axis: 'right', color: '#a78bfa', type: 'line', width: 2, dashed: true }
      ]
    },
    {
      id: 'group-power', title: 'Productivity & Power',
      subtitle: 'Efisiensi pembakaran dan utilisasi tenaga mesin',
      icon: 'fa-bolt', accent: '#22c55e', minParams: 1,
      series: [
        { param: 'engPowerAve', axis: 'left', color: '#22c55e', type: 'line', fill: true, width: 2.5 },
        { param: 'engSpeedAve', axis: 'left', color: '#84cc16', type: 'line', width: 1.5 },
        { param: 'fuelRate',    axis: 'right', color: '#f43f5e', type: 'line', width: 2 }
      ]
    },
    {
      id: 'group-greasing', title: 'Auto Greasing',
      subtitle: 'Siklus & tekanan sistem pelumasan otomatis',
      icon: 'fa-droplet', accent: '#a78bfa', minParams: 1,
      series: [
        { param: 'autoGrsPress', axis: 'left', color: '#a78bfa', type: 'line', width: 2 },
        { param: 'autoGrsOn',    axis: 'right', color: '#c084fc', type: 'line', width: 1.5, dashed: true }
      ]
    },
    {
      // [D375A] Suhu gas buang per bank (kiri/kanan). Selisih besar antara
      // F & R mengindikasikan injektor/kompresi tidak seimbang per bank.
      id: 'group-exhaust', title: 'Exhaust Gas Temperature',
      subtitle: 'Suhu gas buang bank kiri & kanan — deteksi ketidakseimbangan injeksi/kompresi',
      icon: 'fa-fire-flame-simple', accent: '#f97316', minParams: 1,
      series: [
        { param: 'fExhTempMax', axis: 'left', color: '#fb7185', type: 'line', width: 2 },
        { param: 'rExhTempMax', axis: 'left', color: '#38bdf8', type: 'line', width: 2 }
      ]
    },
    {
      // [D375A] Torque converter / power train dozer.
      id: 'group-powertrain', title: 'Torque Converter & Transmission',
      subtitle: 'Tekanan main & suhu oli torque converter — deteksi slip berlebih',
      icon: 'fa-gears', accent: '#8b5cf6', minParams: 1,
      series: [
        { param: 'tmMainPressMax', axis: 'left',  color: '#a78bfa', type: 'line', width: 2.5 },
        { param: 'tmMainPressAve', axis: 'left',  color: '#c4b5fd', type: 'line', width: 1.5, dashed: true },
        { param: 'tcOilTempMax',   axis: 'right', color: '#f59e0b', type: 'line', width: 2 }
      ]
    },
    {
      // [D375A] Aktivitas kerja dozer (jam & siklus) + kemiringan blade.
      id: 'group-dozing', title: 'Dozing Productivity',
      subtitle: 'Durasi dozing/ripping, pass times, dan kemiringan blade',
      icon: 'fa-tractor', accent: '#22c55e', minParams: 1,
      series: [
        { param: 'dozingTime',   axis: 'left',  color: '#22c55e', type: 'line', width: 2 },
        { param: 'rippingTime',  axis: 'left',  color: '#84cc16', type: 'line', width: 2 },
        { param: 'passTimes',    axis: 'right', color: '#0ea5e9', type: 'line', width: 1.5, dashed: true },
        { param: 'pitchAngleAve', axis: 'right', color: '#eab308', type: 'line', width: 1.5 }
      ]
    }
  ];

  /* -----------------------------------------------------------------------
   * 2. Threshold / batas trigger per parameter
   *    warn & crit dievaluasi terhadap nilai MAX pada satu record.
   *    mode: 'high'  -> makin besar makin bahaya (default)
   *          'low'   -> makin kecil makin bahaya
   * --------------------------------------------------------------------- */
  var THRESHOLDS = {
    blowbyMax:    { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
    coolantTemp:  { warn: 95.0, crit: 102.0, mode: 'high', label: 'Coolant Temp' },
    engOilTemp:   { warn: 105.0, crit: 115.0, mode: 'high', label: 'Engine Oil Temp' },
    hydTempMax:   { warn: 95.0, crit: 105.0, mode: 'high', label: 'Hydraulic Oil Temp' },
    ptoTempMax:   { warn: 98.0, crit: 105.0, mode: 'high', label: 'PTO Temp' },
    // CATATAN: tekanan oli MAKSIMUM yang rendah bukan indikator bahaya,
    // jadi TIDAK diberi threshold. Yang dipantau adalah tekanan MINIMUM
    // (H-Min) yang mengindikasikan kehilangan tekanan saat operasi.
    oilPressHMin: { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press H-Min' },
    fuelRate:     { warn: 160.0, crit: 185.0, mode: 'high', label: 'Fuel Rate' }
  };

  /* -----------------------------------------------------------------------
   * 2a. STATUS & SLA TINDAK LANJUT (halaman Portofolio / laporan)
   * ---------------------------------------------------------------------
   * Status ditentukan dari NILAI vs THRESHOLD parameter:
   *   - nilai melewati ambang CRITICAL -> status "CRITICAL" (SLA 1x24 Jam)
   *   - nilai melewati ambang WARNING  -> status "WARNING"  (SLA 2x24 Jam)
   *   - nilai di bawah ambang warning  -> status "NORMAL"
   * Objek di bawah dapat disesuaikan lewat halaman Pengaturan (tab Status & SLA).
   * --------------------------------------------------------------------- */
  var FOLLOWUP_STATUS = {
    CRITICAL: { label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    WARNING:  { label: 'WARNING',  cls: 'pf-warning',  sla: '2x24 Jam' },
    NORMAL:   { label: 'NORMAL',   cls: 'pf-normal',   sla: '-' }
  };
  // Kompatibilitas: alias lama (P1..P3) diarahkan ke status baru.
  var FOLLOWUP_PRIORITY = {
    4: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    3: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    2: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    1: { key: 'WARNING',  label: 'WARNING',  cls: 'pf-warning',  sla: '2x24 Jam' }
  };
  // Fallback bila severity tak dikenal (mis. kosong).
  var FOLLOWUP_PRIORITY_FALLBACK = 2;

  /** Teks verifikasi default per kelompok parameter. */
  var FOLLOWUP_VERIFY = {
    wear:     'Ambil sampel ulang; pastikan tren logam turun & kembali < ambang warning.',
    oil:      'Uji ulang kondisi oli; pastikan viskositas/TBN/oksidasi kembali dalam spesifikasi.',
    clean:    'Periksa kontaminan (Si/air/soot) turun; pastikan kebersihan oli sesuai target ISO.',
    additive: 'Pastikan aditif (Zn/P/Ca) kembali dalam rentang spesifikasi setelah ganti oli.',
    vhms:     'Uji fungsi & ukur ulang parameter; pastikan nilai kembali dalam ambang normal.'
  };
  var FOLLOWUP_REF_DEFAULT = 'Komatsu Shop Manual & SOP Condition Monitoring terkait.';

  /* -----------------------------------------------------------------------
   * 2b. KRITERIA RANKING CRITICALITAS UNIT (Unit Comparison)
   * ---------------------------------------------------------------------
   * Dasar: hierarki prioritas reliability umum industri alat berat —
   *        Safety > Downtime > Biaya. BUKAN dokumen resmi Komatsu.
   *        Semua bobot & ambang di bawah ini dapat disesuaikan.
   *
   * Bobot parameter (relatif). Blowby diturunkan ke 18 agar pilar lain
   * (hydraulic/cooling) tetap mungkin muncul di peringkat teratas.
   * --------------------------------------------------------------------- */

  // Bobot kontribusi tiap parameter terhadap sumbu KEPARAHAN.
  var RANKING_WEIGHTS = {
    blowbyMax:    18,   // indikator keausan ring/liner -> overhaul termahal
    oilPressHMin: 16,   // kehilangan tekanan oli -> risiko seize
    hydTempMax:   14,   // overheat hidrolik -> seal bocor, pompa aus
    engOilTemp:   10,   // degradasi oli, mempercepat keausan
    coolantTemp:   9,   // overheat -> derate mesin
    ptoTempMax:    8,   // beban berlebih sistem fan/PTO
    fanPumpF:      7,   // kegagalan bertahap
    fanPumpR:      6,
    pump1F:        6,   // ketidakseimbangan tekanan pompa
    pump1R:        4,
    pump2F:        6,
    pump2R:        4,
    fuelRate:      2    // indikator ekonomi (bukan keselamatan)
  };

  // Pilar/kelompok parameter untuk analisis distribusi penyebab.
  var RANKING_PILLARS = {
    blowbyMax:    'ENGINE',
    oilPressHMin: 'ENGINE',
    engOilTemp:   'ENGINE',
    hydTempMax:   'HYDRAULIC',
    ptoTempMax:   'HYDRAULIC',
    pump1F:       'HYDRAULIC', pump1R: 'HYDRAULIC',
    pump2F:       'HYDRAULIC', pump2R: 'HYDRAULIC',
    coolantTemp:  'COOLING',
    fanPumpF:     'COOLING',
    fanPumpR:     'COOLING',
    fuelRate:     'ECONOMY'
  };

  // Bobot 3 sumbu skor akhir (jumlah = 1.0).
  var RANKING_AXES = {
    severity: 0.45,   // seberapa jauh melewati batas kritis
    evidence: 0.30,   // seberapa lama/banyak melanggar (durasi jam SMR)
    trend:    0.25    // seberapa cepat memburuk (slope vs SMR)
  };

  // Ambang batas kritisitas overall (skor 0-100) untuk label unit.
  // Dikalibrasi terhadap rentang skor nyata: unit sehat ~2-10,
  // bermasalah satu pilar ~20-35, multi-pilar parah ~40+.
  var RANKING_BANDS = {
    critical: 45,     // skor >= 45 -> CRITICAL
    warning:  25      // skor >= 25 -> WARNING, di bawahnya NORMAL
  };

  // [POIN 7] Bobot relatif per PILAR/kompartemen.
  // Tujuan: Engine lebih dominan daripada kompartemen lain, sehingga unit
  // dengan masalah Engine selalu naik ke atas peringkat trending.
  // Skor sumbu parameter dikalikan bobot pilar di sini (lihat vhms-ranking.js).
  var RANKING_PILLAR_WEIGHTS = {
    ENGINE:    2.0,   // paling dominan (Safety + biaya overhaul tertinggi)
    POWERTRAIN: 1.4,  // dozer torque converter / transmisi (biaya tinggi)
    HYDRAULIC: 1.2,
    COOLING:   1.1,
    BRAKE:     1.3,   // HD truck: prioritas keselamatan
    ECONOMY:   0.6,
    OTHER:     1.0
  };

  // =======================================================================
  // [RULE DATA] DUA ATURAN SUMBER DATA (dipisah tegas)
  // =======================================================================
  // 1) TAMPILAN  -> SELURUH data asli dari file trend0 yang di-upload.
  //    Dipakai oleh: chart grup dinamis & tabel log telemetri.
  //    Tidak ada pemotongan/penyaringan rentang SMR.
  //
  // 2) FORMULA   -> HANYA N jam SMR TERAKHIR (dihitung dari SMR tertinggi).
  //    Dipakai oleh SEMUA perhitungan: nilai critical/event per card, KPI,
  //    status/anomali, health index, ranking criticality (severity/evidence/
  //    trend), matriks perbandingan parameter, dsb. Tujuannya agar penilaian
  //    mencerminkan kondisi terkini & adil antar unit.
  // =======================================================================
  var FORMULA_WINDOW_HOURS = 2000;

  // --- Kompatibilitas nama lama (alias ke FORMULA_WINDOW_HOURS) ---
  // RANKING_WINDOW_HOURS dipakai modul ranking & matrix.
  var RANKING_WINDOW_HOURS = FORMULA_WINDOW_HOURS;

  // CHART_WINDOW_HOURS = 0 -> NONAKTIF => chart menampilkan SELURUH data
  // (sesuai Rule Tampilan). Ubah ke >0 bila ingin memotong chart.
  var CHART_WINDOW_HOURS = 0;

  /* -----------------------------------------------------------------------
   * 3. Definisi kompartemen (kartu KPI atas)
   *    primary = parameter utama yang ditampilkan besar
   * --------------------------------------------------------------------- */
  var COMPARTMENTS = [
    {
      id: 'engine',
      title: 'Engine Compartment',
      icon: 'fa-gauge-high',
      accent: 'red',
      primary: 'blowbyMax',
      footLeft:  { label: 'Speed',      param: 'engSpeedMax' },
      footRight: { label: 'Oil Press',  param: 'oilPressMax' }
    },
    {
      id: 'hydraulic',
      title: 'Hydraulic System',
      icon: 'fa-oil-can',
      accent: 'amber',
      primary: 'hydTempMax',
      footLeft:  { label: 'Pump 1F',   param: 'pump1F' },
      footRight: { label: 'Pump 2F',   param: 'pump2F' }
    },
    {
      id: 'cooling',
      title: 'Cooling &amp; Thermal',
      icon: 'fa-snowflake',
      accent: 'emerald',
      primary: 'coolantTemp',
      footLeft:  { label: 'Ambient',   param: 'ambientMax' },
      footRight: { label: 'Atmos',     param: 'atmosAve' }
    },
    {
      id: 'fanpto',
      title: 'Fan Drive &amp; PTO',
      icon: 'fa-fan',
      accent: 'sky',
      primary: 'ptoTempMax',
      footLeft:  { label: 'Fan Pump F', param: 'fanPumpF' },
      footRight: { label: 'Fan Pump R', param: 'fanPumpR' }
    },
    {
      id: 'greasing',
      title: 'Auto Greasing',
      icon: 'fa-droplet',
      accent: 'violet',
      primary: 'autoGrsOn',
      footLeft:  { label: 'GRS Press',  param: 'autoGrsPress' },
      footRight: { label: 'Cycles',     param: 'autoGrsOn' }
    },
    {
      id: 'productivity',
      title: 'Productivity',
      icon: 'fa-bolt',
      accent: 'sky',
      primary: 'fuelRate',
      footLeft:  { label: 'Power Ave',  param: 'engPowerAve' },
      footRight: { label: 'Swing',      param: 'swingCount' }
    }
  ];

  /* -----------------------------------------------------------------------
   * 4. Definisi chart
   *    series: daftar { param, color, type, axis, fill, dashed }
   *    axis  : 'left' | 'right'
   * --------------------------------------------------------------------- */
  var CHARTS = [
    {
      id: 'chart-engine',
      title: 'Engine Compartment: Blowby Pressure &amp; Oil Pressure Trend',
      subtitle: 'Parameter utama pendeteksian dini keausan Piston Ring &amp; Cylinder Liner',
      type: 'line',
      xAxis: 'smr',
      series: [
        { param: 'blowbyMax',  label: 'Blowby Max',      axis: 'left',  color: '#ef4444', fill: true, type: 'line', width: 3 },
        { param: 'oilPressMax', label: 'Oil Press Max',  axis: 'right', color: '#fbbf24', type: 'line', width: 2, dashed: true }
      ],
      axisTitles: { left: 'Blowby (kPa)', right: 'Oil Press (MPa)' }
    },
    {
      id: 'chart-hydraulic',
      title: 'Hydraulic Compartment: Multi-Pump Pressure &amp; Thermal Matrix',
      subtitle: 'Korelasi tekanan Pompa 1F/1R/2F/2R terhadap suhu oli hidrolik',
      type: 'bar',
      xAxis: 'smr',
      series: [
        { param: 'hydTempMax', label: 'Hyd Temp Max', axis: 'right', color: '#f59e0b', type: 'line', width: 2.5 },
        { param: 'pump1F',     label: 'Pump 1F',      axis: 'left',  color: 'rgba(6,182,212,0.75)',  type: 'bar' },
        { param: 'pump1R',     label: 'Pump 1R',      axis: 'left',  color: 'rgba(59,130,246,0.75)', type: 'bar' },
        { param: 'pump2F',     label: 'Pump 2F',      axis: 'left',  color: 'rgba(129,140,248,0.75)', type: 'bar' },
        { param: 'pump2R',     label: 'Pump 2R',      axis: 'left',  color: 'rgba(192,132,252,0.75)', type: 'bar' }
      ],
      axisTitles: { left: 'Pump Press (MPa)', right: 'Hyd Temp (\u00B0C)' }
    },
    {
      id: 'chart-cooling',
      title: 'Thermal &amp; Cooling: Coolant, Engine Oil, Ambient',
      subtitle: 'Stabilitas sistem pendingin terhadap beban kerja dan suhu lingkungan',
      type: 'line',
      xAxis: 'smr',
      series: [
        { param: 'coolantTemp', label: 'Coolant Temp Max', axis: 'left',  color: '#38bdf8', type: 'line', width: 2.5 },
        { param: 'engOilTemp',  label: 'Eng Oil Temp Max', axis: 'left',  color: '#f97316', type: 'line', width: 2 },
        { param: 'ambientMax',  label: 'Ambient Temp Max', axis: 'left',  color: '#94a3b8', type: 'line', width: 1.5, dashed: true }
      ],
      axisTitles: { left: 'Temperatur (\u00B0C)' }
    },
    {
      id: 'chart-power',
      title: 'Productivity: Engine Power &amp; Fuel Rate',
      subtitle: 'Efisiensi pembakaran dan utilisasi tenaga mesin',
      type: 'line',
      xAxis: 'smr',
      series: [
        { param: 'engPowerAve', label: 'Engine Power Ave', axis: 'left',  color: '#22c55e', type: 'line', fill: true, width: 2.5 },
        { param: 'fuelRate',    label: 'Fuel Rate',        axis: 'right', color: '#f43f5e', type: 'line', width: 2 }
      ],
      axisTitles: { left: 'Power (kW)', right: 'Fuel (L/h)' }
    }
  ];

  /* -----------------------------------------------------------------------
   * 5. Kolom tabel log mentah
   * --------------------------------------------------------------------- */
  var TABLE_COLUMNS = [
    { param: 'smr',        align: 'left'  },
    { param: 'engSpeedAve', align: 'center' },
    { param: 'blowbyMax',  align: 'center', colored: true },
    { param: 'oilPressMax', align: 'center' },
    { param: 'coolantTemp', align: 'center' },
    { param: 'hydTempMax', align: 'center', colored: true },
    { param: 'pump1F',     align: 'center' },
    { param: 'fuelRate',   align: 'center' },
    { param: 'engPowerAve', align: 'center' },
    { param: 'status',     align: 'center', isStatus: true }
  ];

  /* -----------------------------------------------------------------------
   * 5b. [D375A] Kolom tabel log KHUSUS per keluarga produk.
   * ---------------------------------------------------------------------
   * Excavator/HD memakai daftar umum (TABLE_COLUMNS) di atas. DOZER tipe
   * besar (D375A) menonjolkan parameter khasnya: suhu gas buang, torque
   * converter, pompa hidrolik besar, dan aktivitas penggusuran.
   * --------------------------------------------------------------------- */
  var TABLE_COLUMNS_DOZER = [
    { param: 'smr',          align: 'left'  },
    { param: 'engSpeedAve',  align: 'center' },
    { param: 'blowbyMax',    align: 'center', colored: true },
    { param: 'fExhTempMax',  align: 'center' },
    { param: 'rExhTempMax',  align: 'center' },
    { param: 'coolantTemp',  align: 'center', colored: true },
    { param: 'engOilTemp',   align: 'center', colored: true },
    { param: 'tcOilTempMax', align: 'center', colored: true },
    { param: 'hydTempMax',   align: 'center', colored: true },
    { param: 'tmMainPressMax', align: 'center' },
    { param: 'hydTempAve',   align: 'center' },
    { param: 'fuelRate',     align: 'center' },
    { param: 'pitchAngleAve', align: 'center' },
    { param: 'status',       align: 'center', isStatus: true }
  ];

  /**
   * Pilih daftar kolom tabel log yang relevan untuk sebuah keluarga +
   * saring kolom yang tidak punya data pada records (mis. dozer kecil tanpa
   * pitch angle tetap diekspor ke CSV-nya saja).
   * @param {string} familyId
   * @param {object[]} records
   * @returns {object[]}
   */
  function tableColumnsFor(familyId, records) {
    var base = (familyId === 'DOZER') ? TABLE_COLUMNS_DOZER : TABLE_COLUMNS;
    if (!records || !records.length) return base;
    var sample = records.slice(0, Math.min(records.length, 20));
    function hasData(param) {
      for (var i = 0; i < sample.length; i++) {
        var v = sample[i][param];
        if (v !== null && v !== undefined && !isNaN(v)) return true;
      }
      return false;
    }
    // Selalu pertahankan smr & status; saring kolom lain yang benar-benar kosong.
    var filtered = base.filter(function (col) {
      if (col.isStatus || col.param === 'smr') return true;
      return hasData(col.param);
    });
    // Minimal 4 kolom data; bila terlalu banyak terbuang, pakai daftar umum.
    return filtered.length >= 4 ? filtered : base;
  }

  /* -----------------------------------------------------------------------
   * 6. Nilai sentinel VHMS yang berarti "tidak ada data"
   * --------------------------------------------------------------------- */
  var NULL_SENTINELS = [-32768, -32767, '-32768', '-32767', '', '-', '---', 'N/A'];

  /* -----------------------------------------------------------------------
   * 6b. [POIN 3] Helper: tentukan grup chart yang RELEVAN untuk sebuah unit.
   * ---------------------------------------------------------------------
   * Mengembalikan grup yang minimal `minParams` serinya punya data (non-null)
   * pada records, SEHINGGA chart menyesuaikan kolom yang benar-benar ada
   * (fleksibel untuk model HD/PC/Dozer dengan set kolom berbeda).
   * --------------------------------------------------------------------- */
  function chartGroupsFor(records) {
    if (!records || !records.length) return CHART_GROUPS.slice();
    // Cache kolom yang terisi: cukup periksa beberapa record pertama
    var sample = records.slice(0, Math.min(records.length, 20));
    function hasData(param) {
      for (var i = 0; i < sample.length; i++) {
        var v = sample[i][param];
        if (v !== null && v !== undefined && !isNaN(v)) return true;
      }
      return false;
    }
    return CHART_GROUPS.filter(function (g) {
      var n = 0;
      g.series.forEach(function (s) { if (hasData(s.param)) n++; });
      g._available = n;
      return n >= (g.minParams || 1);
    }).map(function (g) {
      // Hanya sertakan seri yang punya data
      var avail = g.series.filter(function (s) { return hasData(s.param); });
      return Object.assign({}, g, { series: avail });
    });
  }

  /* -----------------------------------------------------------------------
   * 6c. [REVISI #15] KATEGORI ARAH DEGRADASI PARAMETER: HIGH vs LOW.
   * ---------------------------------------------------------------------
   * Membagi parameter menjadi 2 grup sesuai arah "makin buruk":
   *   - HIGH : makin BESAR makin bahaya (mode threshold 'high')
   *            mis. Blowby, Coolant/Engine/Hyd Temp, Fuel Rate, Exhaust Temp.
   *   - LOW  : makin KECIL makin bahaya (mode threshold 'low')
   *            mis. Oil Press H-Min, TM Main Press, Large Pump Press, Atmos Press.
   *
   * Dipakai oleh:
   *   (a) Perhitungan KORELASI Cross Analysis (menentukan arah normalisasi),
   *   (b) Pengelompokan THRESHOLD LIMIT di mode VHMS (tabel Pengaturan).
   *
   * Mode ditentukan dari THRESHOLDS[param].mode (default 'high' bila absen).
   * --------------------------------------------------------------------- */
  var DIRECTION_GROUPS = { HIGH: 'HIGH', LOW: 'LOW' };
  var DIRECTION_LABELS = {
    HIGH: 'Grup HIGH — makin besar makin bahaya',
    LOW:  'Grup LOW — makin kecil makin bahaya'
  };

  /**
   * Tentukan arah degradasi sebuah parameter: 'HIGH' atau 'LOW'.
   * Mengutamakan mode dari skema threshold yang diberikan (mis. per keluarga),
   * lalu jatuh ke cfg.THRESHOLDS. Default 'high'.
   * @param {string} paramKey
   * @param {object} [thresholds] skema threshold (opsional, mis. per keluarga)
   * @returns {'HIGH'|'LOW'}
   */
  function paramDirection(paramKey, thresholds) {
    var set = thresholds || THRESHOLDS || {};
    var th = set[paramKey];
    if (!th) return DIRECTION_GROUPS.HIGH;
    return (th.mode === 'low') ? DIRECTION_GROUPS.LOW : DIRECTION_GROUPS.HIGH;
  }

  /**
   * Kelompokkan daftar key threshold menjadi { HIGH: [...], LOW: [...] }.
   * @param {object} [thresholds]
   * @returns {{HIGH: string[], LOW: string[]}}
   */
  function groupByDirection(thresholds) {
    var set = thresholds || THRESHOLDS || {};
    var out = { HIGH: [], LOW: [] };
    Object.keys(set).forEach(function (k) {
      out[paramDirection(k, set)].push(k);
    });
    return out;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_CONFIG = {
    PARAMS: PARAMS,
    SMR_SCALE: SMR_SCALE,
    THRESHOLDS: THRESHOLDS,
    FOLLOWUP_PRIORITY: FOLLOWUP_PRIORITY,
    FOLLOWUP_STATUS: FOLLOWUP_STATUS,
    FOLLOWUP_PRIORITY_FALLBACK: FOLLOWUP_PRIORITY_FALLBACK,
    FOLLOWUP_VERIFY: FOLLOWUP_VERIFY,
    FOLLOWUP_REF_DEFAULT: FOLLOWUP_REF_DEFAULT,
    COMPARTMENTS: COMPARTMENTS,
    CHARTS: CHARTS,
    CHART_GROUPS: CHART_GROUPS,
    chartGroupsFor: chartGroupsFor,
    UNIT_ALIASES: UNIT_ALIASES,
    normalizeUnit: normalizeUnit,
    TABLE_COLUMNS: TABLE_COLUMNS,
    TABLE_COLUMNS_DOZER: TABLE_COLUMNS_DOZER,
    tableColumnsFor: tableColumnsFor,
    NULL_SENTINELS: NULL_SENTINELS,
    RANKING_WEIGHTS: RANKING_WEIGHTS,
    RANKING_PILLARS: RANKING_PILLARS,
    RANKING_AXES: RANKING_AXES,
    RANKING_BANDS: RANKING_BANDS,
    RANKING_PILLAR_WEIGHTS: RANKING_PILLAR_WEIGHTS,
    FORMULA_WINDOW_HOURS: FORMULA_WINDOW_HOURS,
    RANKING_WINDOW_HOURS: RANKING_WINDOW_HOURS,
    CHART_WINDOW_HOURS: CHART_WINDOW_HOURS,
    PARAM_COLUMN_OVERRIDES: PARAM_COLUMN_OVERRIDES,
    paramsForFamily: paramsForFamily,
    paramHeaders: paramHeaders,
    // [REVISI #15] kategori arah degradasi HIGH/LOW
    DIRECTION_GROUPS: DIRECTION_GROUPS,
    DIRECTION_LABELS: DIRECTION_LABELS,
    paramDirection: paramDirection,
    groupByDirection: groupByDirection
  };

  // Dukungan ESM (opsional) di samping pemakaian global browser
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);

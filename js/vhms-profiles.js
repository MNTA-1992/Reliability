/* =========================================================================
 * vhms-profiles.js
 * -------------------------------------------------------------------------
 * [POIN 1] Profil KELUARGA PRODUK (Product Family) Komatsu.
 *
 * Tujuan: satu dashboard melayani beberapa keluarga produk VHMS —
 *   - EXCAVATOR (PC...)     : PC2000, PC1250, PC3000, PC5500, dst.
 *   - TRUCK / HD (HD...)    : HD465, HD785, HD1500, dst.
 *   - DOZER (D...)          : D65, D155, D375, dst.
 *   - UNKNOWN               : skema generik (semua kolom yang ada diproses).
 *
 * Tiap keluarga punya SKEMA sendiri:
 *   - thresholds : batas warning/critical per parameter (boleh beda antar model)
 *   - compartments: kartu KPI kompartemen
 *   - chartGroups: grup chart default
 *   - rankingWeights / pillarWeights : bobot criticality
 *
 * PRINSIP KECOCOKAN FIELD (field matching):
 *   Skema merujuk NAMA parameter (key di PARAMS). Bila sebuah parameter tidak
 *   ada pada file (kolom absen / nilainya null), parameter itu otomatis
 *   DILEWATI di KPI, chart, anomali, dan ranking — bukan error.
 *
 * CATATAN: Isi threshold/threshold di sini mengikuti struktur umum VHMS
 * Komatsu + praktik reliability umum. BUKAN dokumen resmi; sesuaikan bila
 * Anda punya angka resmi dari manual/bulletin.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;

  /* -----------------------------------------------------------------------
   * 1. Definisi keluarga produk
   * --------------------------------------------------------------------- */
  var FAMILIES = {
    EXCAVATOR: {
      id: 'EXCAVATOR',
      label: 'Excavator',
      short: 'EX',
      icon: 'fa-truck-monster',
      accent: '#0ea5e9',
      // Deteksi: kata kunci pada Product Group (lowercase)
      groupKeywords: ['excavator', 'excav', 'hoe', 'shovel'],
      // Deteksi: prefix kode pada Machine Model (uppercase)
      modelPrefixes: ['PC']
    },
    TRUCK: {
      id: 'TRUCK',
      label: 'Haul Truck (HD)',
      short: 'HD',
      icon: 'fa-truck',
      accent: '#f59e0b',
      groupKeywords: ['truck', 'dump', 'haul', 'hauler', 'rigid'],
      modelPrefixes: ['HD', 'HM', 'HT']
    },
    DOZER: {
      id: 'DOZER',
      label: 'Dozer',
      short: 'DZ',
      icon: 'fa-tractor',
      accent: '#22c55e',
      groupKeywords: ['dozer', 'dozer', 'bulldozer', 'crawler dozer', 'd65', 'd155', 'd375'],
      modelPrefixes: ['D', 'DZ']
    },
    UNKNOWN: {
      id: 'UNKNOWN',
      label: 'Tidak Dikenal',
      short: 'NA',
      icon: 'fa-circle-question',
      accent: '#94a3b8',
      groupKeywords: [],
      modelPrefixes: []
    }
  };

  /* -----------------------------------------------------------------------
   * 2. Deteksi keluarga dari metadata
   * --------------------------------------------------------------------- */
  function detectFamily(meta) {
    meta = meta || {};
    var group = String(meta.productGroup || '').toLowerCase();
    var model = String(meta.model || '').toUpperCase();

    // a) Utamakan Product Group
    if (group) {
      var famIds = ['EXCAVATOR', 'TRUCK', 'DOZER'];
      for (var i = 0; i < famIds.length; i++) {
        var f = FAMILIES[famIds[i]];
        for (var k = 0; k < f.groupKeywords.length; k++) {
          if (group.indexOf(f.groupKeywords[k]) !== -1) return f.id;
        }
      }
    }

    // b) Fallback: prefix kode Machine Model
    if (model) {
      // Cocokkan prefix terpanjang dulu (mis. 'DZ' sebelum 'D')
      var best = null, bestLen = 0;
      ['EXCAVATOR', 'TRUCK', 'DOZER'].forEach(function (fid) {
        FAMILIES[fid].modelPrefixes.forEach(function (p) {
          if (model.indexOf(p) === 0 && p.length > bestLen) {
            best = fid; bestLen = p.length;
          }
        });
      });
      if (best) return best;
    }

    return 'UNKNOWN';
  }

  /* -----------------------------------------------------------------------
   * 3. SKEMA THRESHOLD per keluarga
   * ---------------------------------------------------------------------
   * Hanya parameter yang RELEVAN untuk keluarga tersebut. Kunci harus sama
   * dengan key di cfg.PARAMS. Parameter yang tidak ada di file dilewati.
   * --------------------------------------------------------------------- */

  // EXCAVATOR — basis seperti config (PC2000)
  var TH_EXCAVATOR = {
    blowbyMax:    { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
    coolantTemp:  { warn: 95.0, crit: 105.0, mode: 'high', label: 'Coolant Temp' },
    engOilTemp:   { warn: 105.0, crit: 115.0, mode: 'high', label: 'Engine Oil Temp' },
    hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high', label: 'Hydraulic Oil Temp' },
    ptoTempMax:   { warn: 95.0, crit: 105.0, mode: 'high', label: 'PTO Temp' },
    oilPressHMin: { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press H-Min' },
    fuelRate:     { warn: 160.0, crit: 200.0, mode: 'high', label: 'Fuel Rate' },
    // Tambahan umum (dipakai bila kolomnya ada)
    // [mmHg] Boost 150/180 kPa -> 1125,1/1350,1 mmHg (x7.50062)
    boostMax:     { warn: 1125.1, crit: 1350.1, mode: 'high', label: 'Boost Pressure (mmHg)' },
    atmosAve:     { warn: 900.0, crit: 880.0, mode: 'low',  label: 'Atmospheric Pressure' },

    // ---------------------------------------------------------------------
    // [PC2000 2026-10-10 — T3] DUTY GAS BUANG 4 GRUP SILINDER (`chas_trend0`).
    // ---------------------------------------------------------------------
    // Sumber nilai: `chas_trend0.CSV` SN 20020 (PC2000-8, SAA12V140E3).
    // Kolom `LF/LR/RF/RR Exh.Temp 700-|750-|800-` berisi DETIK di atas ambang
    // suhu, TERAKUMULASI PER JENDELA SMR (~200 jam pada unit contoh).
    //
    // ⚠ SATUAN ADALAH PERSEN JENDELA, BUKAN DETIK MENTAH.
    //   T4 (`vhms-analytics.js`) menormalkan nilai mentah menjadi
    //   `100 × detik / (ΔSMR × 3600)`. Tanpa normalisasi itu, angka mentah
    //   (ratusan ribu detik) akan selalu melewati `crit` dan skor tren
    //   meledak. Jendela 200 h = 720 000 s, jadi 5 % = 36 000 s.
    //   Persen dipilih agar ambang dapat dibandingkan antar unit yang
    //   panjang jendelanya berbeda.
    //
    // Ambang mesin SAMA dengan TH_TRUCK (engine SAA12V140E3 identik) — D8.
    // Hanya satuannya yang berbeda (persen jendela vs detik absolut).
    //
    // ⚠ USULAN — BELUM TERKALIBRASI LAPANGAN (R2). Unit contoh satu-satunya
    //   yang tersedia justru memiliki sensor LBR rusak-tinggi (969 °C konstan
    //   selama 18 bulan), sehingga nilainya tidak dapat dipakai untuk
    //   memvalidasi ambang. Kalibrasi ulang setelah >=5 unit PC2000 dengan
    //   sensor SEHAT terkumpul. Lihat docs/STATUS_PROYEK.md §2.4.
    lfExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'LF Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lfExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'LF Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lfExhOver800: { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'LF Exhaust >800\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lrExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'LR Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lrExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'LR Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lrExhOver800: { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'LR Exhaust >800\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rfExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'RF Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rfExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'RF Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rfExhOver800: { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'RF Exhaust >800\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rrExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'RR Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rrExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'RR Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rrExhOver800: { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'RR Exhaust >800\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' }
  };

  // TRUCK / HD — perbedaan utama: tidak ada swing/pump hidrolik excavator,
  // ada retarder, brake temp, payload, exhaust temp per bank, dll.
  var TH_TRUCK = {
    blowbyMax:    { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
    coolantTemp:  { warn: 95.0, crit: 105.0, mode: 'high', label: 'Coolant Temp' },
    engOilTemp:   { warn: 105.0, crit: 115.0, mode: 'high', label: 'Engine Oil Temp' },
    oilPressHMin: { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press H-Min' },
    // [REVISI] HD785 sering HANYA punya kolom "EOil Pre.MAX" (tanpa H-Min).
    // Karena tekanan oli MAKSIMUM yang rendah juga indikasi bahaya pada HD,
    // kita beri threshold mode 'low' sebagai FALLBACK. Bila H-Min tersedia,
    // H-Min yang dipakai (lihat resolveEngineOilPress di vhms-ranking).
    oilPressMax:  { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press Max',
                    fallbackFor: 'oilPressHMin' },
    fuelRate:     { warn: 200.0, crit: 250.0, mode: 'high', label: 'Fuel Rate' },
    // [mmHg] Boost 160/193 kPa -> 1200/1450 mmHg (x7.50062)
    boostMax:     { warn: 1200.0, crit: 1450.0, mode: 'high', label: 'Boost Pressure (mmHg)' },
    atmosAve:     { warn: 900.0, crit: 880.0, mode: 'low',  label: 'Atmospheric Pressure' },
    // Parameter khas HD (hanya muncul bila kolomnya ada)
    retarderTemp: { warn: 115.0, crit: 140.0, mode: 'high', label: 'Retarder Temp' },
    brakeTemp:    { warn: 180.0, crit: 230.0, mode: 'high', label: 'Brake Temp' },
    hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high', label: 'Hydraulic Oil Temp' },

    /* ---------------------------------------------------------------------
     * [FIX 2026-10-09] PARAMETER CHASSIS TREND HD785.
     * -------------------------------------------------------------------
     * BUG YANG DIPERBAIKI DI SINI: `analysis.thresholdSet` memakai objek
     * PROFIL KELUARGA (`TH_TRUCK`) ini — BUKAN `cfg.THRESHOLDS`. Ketika
     * parameter `chas_trend0` (tmFill*, *RtdOver140, *ExhOver800) hanya
     * ditambahkan ke `cfg.THRESHOLDS`, unit HD785 TIDAK mengenalinya:
     *   - heatmap menampilkan "—" untuk seluruh kolom fill time,
     *   - skor/ranking mengabaikannya (tanpa threshold -> dilewati).
     * Nilai di sini DISALIN dari cfg.THRESHOLDS (satu sumber kebenaran =
     * spek §2 D2/D4). Bila kelak ambang di-tuning, UBAH DI KEDUA TEMPAT.
     *
     * Semuanya SUMBER OEM / service limit Komatsu (2026-10-09) — `provisional`
     * DIHAPUS. Nilai disalin dari cfg.THRESHOLDS (satu sumber kebenaran =
     * spek §2 D2/D4). Bila kelak ambang di-tuning, UBAH DI KEDUA TEMPAT.
     * Tetap DAPAT di-edit di halaman Pengaturan.
     * ------------------------------------------------------------------- */
    // [KOREKSI 2026-10-12] `source` di sini DULU berbunyi "OEM service limit".
    // Itu salah DAN berbahaya: teks inilah yang tampil di kolom
    // "Sumber / Asal Nilai" halaman Pengaturan (profil keluarga model dipakai
    // untuk render, bukan cfg.THRESHOLDS). Operator jadi membaca "OEM" padahal
    // angkanya berasal dari dasar awal-umur SATU unit (SN 31991) — lihat
    // `docs/STATUS_PROYEK.md` §5.2 & risiko R5-HD §5.3.
    tmFillLow:     { warn: 400,  crit: 490,  mode: 'high', label: 'Low Clutch Fill Time',  source: 'Kaidah service \u00d71,32/1,58 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFillHigh:    { warn: 390,  crit: 470,  mode: 'high', label: 'High Clutch Fill Time', source: 'Kaidah service \u00d71,32/1,58 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill1:       { warn: 950,  crit: 1170, mode: 'high', label: '1st Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill2:       { warn: 890,  crit: 1100, mode: 'high', label: '2nd Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill3:       { warn: 500,  crit: 620,  mode: 'high', label: '3rd Clutch Fill Time',  source: 'Kaidah service \u00d71,29/1,60 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill4:       { warn: 460,  crit: 570,  mode: 'high', label: '4th Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,61 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFillR:       { warn: 1180, crit: 1450, mode: 'high', label: 'R Clutch Fill Time',    source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    fRtdOver140:   { warn: 60,   crit: 300,  mode: 'high', label: 'F Retarder Oil >140\u00B0C', source: 'Suhu 140 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 durasi 60/300 s USULAN, belum terkalibrasi' },
    rRtdOver140:   { warn: 60,   crit: 300,  mode: 'high', label: 'R Retarder Oil >140\u00B0C', source: 'Suhu 140 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 durasi 60/300 s USULAN, belum terkalibrasi' },
    lfExhOver800:  { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'LF Exhaust >800\u00b0C (% waktu)', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    lrExhOver800:  { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'LR Exhaust >800\u00b0C (% waktu)', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    rfExhOver800:  { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'RF Exhaust >800\u00b0C (% waktu)', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    rrExhOver800:  { warn: 1.0,  crit: 8.0,  mode: 'high', label: 'RR Exhaust >800\u00b0C (% waktu)', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' }
  };

  // DOZER — ada torque converter, steering clutch, tilt/ripper hidrolik.
  // [D375A] Disetel mengikuti template "65258.CSV": exhaust temp per bank,
  // TM Main pressure, T/C oil temp, dan Large Pump pressure.
  var TH_DOZER = {
    blowbyMax:     { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
    coolantTemp:   { warn: 95.0, crit: 105.0, mode: 'high', label: 'Coolant Temp' },
    engOilTemp:    { warn: 105.0, crit: 115.0, mode: 'high', label: 'Engine Oil Temp' },
    oilPressHMin:  { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press H-Min' },
    hydTempMax:    { warn: 90.0, crit: 100.0, mode: 'high', label: 'Hydraulic Oil Temp' },
    ptoTempMax:    { warn: 95.0, crit: 105.0, mode: 'high', label: 'PTO/Torque Conv Temp' },
    fuelRate:      { warn: 110.0, crit: 135.0, mode: 'high', label: 'Fuel Rate' },
    // [mmHg] Boost 150/180 kPa -> 1125,1/1350,1 mmHg (x7.50062)
    boostMax:      { warn: 1125.1, crit: 1350.1, mode: 'high', label: 'Boost Pressure (mmHg)' },
    // --- [D375A] Parameter khas dozer besar ---
    // Suhu gas buang per bank. Overheat exhaust = risiko kerusakan valve/turbo.
    fExhTempMax:   { warn: 550.0, crit: 650.0, mode: 'high', label: 'F Exhaust Temp' },
    rExhTempMax:   { warn: 550.0, crit: 650.0, mode: 'high', label: 'R Exhaust Temp' },
    // Suhu oli torque converter. Overheat => degradasi oli & slip berlebih.
    tcOilTempMax:  { warn: 110.0, crit: 120.0, mode: 'high', label: 'Torque Converter Oil Temp' },
    // Tekanan main transmisi (torque main). Terlalu RENDAH = slip / tekanan hilang.
    tmMainPressMax: { warn: 2.2, crit: 1.8, mode: 'low', label: 'TM Main Pressure' },
    // Tekanan pompa hidrolik utama (blade/ripper). Turun = keausan pompa/relief.
    largePumpPress: { warn: 20.0, crit: 15.0, mode: 'low', label: 'Large Pump Pressure' },

    /* ---------------------------------------------------------------------
     * [FIX 2026-10-09] PARAMETER T/M TREND D375A.
     * -------------------------------------------------------------------
     * BUG YANG SAMA dengan TH_TRUCK di atas: `analysis.thresholdSet` memakai
     * objek profil ini, BUKAN cfg.THRESHOLDS. Parameter `tm_trend0.CSV`
     * (tmTrgTime*, tcOilOver*) hanya ditambahkan ke cfg.THRESHOLDS, sehingga
     * heatmap D375A menampilkan "—" untuk kolom T/M sejak fitur itu dipasang.
     *
     * `tcOilOver120` SENGAJA TIDAK diberi ambang (indikator duty, bukan
     * alarm) — sama seperti cfg.THRESHOLDS. Nilai di sini disalin dari sana;
     * bila di-tuning, ubah DI KEDUA TEMPAT. Sumber OEM / service limit
     * (2026-10-09) — `provisional` DIHAPUS.
     * ------------------------------------------------------------------- */
    // [KOREKSI 2026-10-12] "OEM service normal" → dinyatakan sebagai kaidah
    // service umum yang BELUM diverifikasi ke Shop Manual D375A.
    // [B-4 2026-10-13] Label diperbaiki: ini TRIGGER time (respons ECMV,
    // belasan msec), BUKAN clutch fill time (ratusan msec) — dulu berlabel
    // sama persis dengan `tmFillR` sehingga dua kolom berjudul identik.
    tmTrgTimeF:    { warn: 150,  crit: 200,  mode: 'high', label: 'F Trigger Time',  source: 'Kaidah service trigger time (150/200 msec) \u2014 belum diverifikasi ke Shop Manual' },
    tmTrgTimeR:    { warn: 150,  crit: 200,  mode: 'high', label: 'R Trigger Time',  source: 'Kaidah service trigger time (150/200 msec) \u2014 belum diverifikasi ke Shop Manual' },
    tmTrgTime1:    { warn: 200,  crit: 250,  mode: 'high', label: '1st Gear Trigger Time', source: 'Kaidah service fill time per gigi \u2014 belum diverifikasi ke Shop Manual' },
    tmTrgTime2:    { warn: 200,  crit: 250,  mode: 'high', label: '2nd Gear Trigger Time', source: 'Kaidah service fill time per gigi \u2014 belum diverifikasi ke Shop Manual' },
    tmTrgTime3:    { warn: 200,  crit: 250,  mode: 'high', label: '3rd Gear Trigger Time', source: 'Kaidah service fill time per gigi \u2014 belum diverifikasi ke Shop Manual' },
    // Duty termal oli T/C: hanya tingkat TERTINGGI yang diberi ambang.
    // CATATAN: tcOilOver130 memakai ambang LEBIH TINGGI (300/1800) daripada
    // tcOilOver140 (60/300) — suhu 130 °C lebih sering & lebih lama tercapai
    // sehingga durasi "normal"-nya pun lebih panjang. Jangan tertukar.
    tcOilOver130:  { warn: 300,  crit: 1800, mode: 'high', label: 'T/C Oil >130\u00B0C', source: 'OEM T/C oil warning 130 \u00B0C' },
    tcOilOver140:  { warn: 60,   crit: 300,  mode: 'high', label: 'T/C Oil >140\u00B0C', source: 'OEM T/C oil limit 140 \u00B0C' }
  };

  /* -----------------------------------------------------------------------
   * 4. SKEMA KOMPARTEMEN (kartu KPI) per keluarga
   * --------------------------------------------------------------------- */
  var COMP_EXCAVATOR = [
    { id: 'engine', title: 'Engine Compartment', icon: 'fa-gauge-high', accent: 'red', primary: 'blowbyMax',
      footLeft: { label: 'Speed', param: 'engSpeedMax' }, footRight: { label: 'Oil Press', param: 'oilPressMax' } },
    { id: 'hydraulic', title: 'Hydraulic System', icon: 'fa-oil-can', accent: 'amber', primary: 'hydTempMax',
      footLeft: { label: 'Pump 1F', param: 'pump1F' }, footRight: { label: 'Pump 2F', param: 'pump2F' } },
    { id: 'cooling', title: 'Cooling &amp; Thermal', icon: 'fa-snowflake', accent: 'emerald', primary: 'coolantTemp',
      footLeft: { label: 'Ambient', param: 'ambientMax' }, footRight: { label: 'Atmos', param: 'atmosAve' } },
    { id: 'fanpto', title: 'Fan Drive &amp; PTO', icon: 'fa-fan', accent: 'sky', primary: 'ptoTempMax',
      footLeft: { label: 'Fan Pump F', param: 'fanPumpF' }, footRight: { label: 'Fan Pump R', param: 'fanPumpR' } },
    { id: 'greasing', title: 'Auto Greasing', icon: 'fa-droplet', accent: 'violet', primary: 'autoGrsOn',
      footLeft: { label: 'GRS Press', param: 'autoGrsPress' }, footRight: { label: 'Cycles', param: 'autoGrsOn' } },
    { id: 'productivity', title: 'Productivity', icon: 'fa-bolt', accent: 'sky', primary: 'fuelRate',
      footLeft: { label: 'Power Ave', param: 'engPowerAve' }, footRight: { label: 'Swing', param: 'swingCount' } }
  ];

  var COMP_TRUCK = [
    { id: 'engine', title: 'Engine Compartment', icon: 'fa-gauge-high', accent: 'red', primary: 'blowbyMax',
      footLeft: { label: 'Speed', param: 'engSpeedMax' }, footRight: { label: 'Oil Press', param: 'oilPressMax' } },
    { id: 'brakes', title: 'Brake &amp; Retarder', icon: 'fa-hand', accent: 'red', primary: 'brakeTemp',
      footLeft: { label: 'Retarder', param: 'retarderTemp' }, footRight: { label: 'Coolant', param: 'coolantTemp' } },
    { id: 'cooling', title: 'Cooling &amp; Thermal', icon: 'fa-snowflake', accent: 'emerald', primary: 'coolantTemp',
      footLeft: { label: 'Ambient', param: 'ambientMax' }, footRight: { label: 'Atmos', param: 'atmosAve' } },
    { id: 'hydraulic', title: 'Hydraulic / Steering', icon: 'fa-oil-can', accent: 'amber', primary: 'hydTempMax',
      footLeft: { label: 'Pressure', param: 'pump1F' }, footRight: { label: 'Temp Ave', param: 'hydTempAve' } },
    { id: 'productivity', title: 'Payload &amp; Productivity', icon: 'fa-weight-hanging', accent: 'sky', primary: 'fuelRate',
      footLeft: { label: 'Power Ave', param: 'engPowerAve' }, footRight: { label: 'Distance', param: 'truckCounter1' } }
  ];

  var COMP_DOZER = [
    { id: 'engine', title: 'Engine Compartment', icon: 'fa-gauge-high', accent: 'red', primary: 'blowbyMax',
      footLeft: { label: 'Speed', param: 'engSpeedMax' }, footRight: { label: 'Oil Press', param: 'oilPressHMin' } },
    { id: 'exhaust', title: 'Exhaust &amp; Combustion', icon: 'fa-fire-flame-simple', accent: 'red', primary: 'fExhTempMax',
      footLeft: { label: 'R Exh Temp', param: 'rExhTempMax' }, footRight: { label: 'Boost', param: 'boostMax' } },
    { id: 'hydraulic', title: 'Blade &amp; Ripper Hydraulic', icon: 'fa-oil-can', accent: 'amber', primary: 'hydTempMax',
      footLeft: { label: 'Large Pump', param: 'largePumpPress' }, footRight: { label: 'Hyd Temp Ave', param: 'hydTempAve' } },
    { id: 'powertrain', title: 'Torque Converter / PTO', icon: 'fa-gears', accent: 'sky', primary: 'tcOilTempMax',
      footLeft: { label: 'TM Main Press', param: 'tmMainPressMax' }, footRight: { label: 'Speed Ave', param: 'engSpeedAve' } },
    { id: 'cooling', title: 'Cooling &amp; Thermal', icon: 'fa-snowflake', accent: 'emerald', primary: 'coolantTemp',
      footLeft: { label: 'Eng Oil Temp', param: 'engOilTemp' }, footRight: { label: 'Ambient', param: 'ambientMax' } },
    { id: 'productivity', title: 'Dozing Productivity', icon: 'fa-tractor', accent: 'sky', primary: 'dozingTime',
      footLeft: { label: 'Ripping', param: 'rippingTime' }, footRight: { label: 'Pass Times', param: 'passTimes' } }
  ];

  // UNKNOWN — kompartemen generik (engine + cooling + productivity)
  var COMP_GENERIC = [
    { id: 'engine', title: 'Engine Compartment', icon: 'fa-gauge-high', accent: 'red', primary: 'blowbyMax',
      footLeft: { label: 'Speed', param: 'engSpeedMax' }, footRight: { label: 'Oil Press', param: 'oilPressMax' } },
    { id: 'cooling', title: 'Cooling &amp; Thermal', icon: 'fa-snowflake', accent: 'emerald', primary: 'coolantTemp',
      footLeft: { label: 'Oil Temp', param: 'engOilTemp' }, footRight: { label: 'Ambient', param: 'ambientMax' } },
    { id: 'productivity', title: 'Productivity', icon: 'fa-bolt', accent: 'sky', primary: 'fuelRate',
      footLeft: { label: 'Power Ave', param: 'engPowerAve' }, footRight: { label: 'Speed Ave', param: 'engSpeedAve' } }
  ];

  /* -----------------------------------------------------------------------
   * 5. SKEMA BOBOT RANKING per keluarga
   * --------------------------------------------------------------------- */
  var WEIGHTS_EXCAVATOR = { blowbyMax: 18, oilPressHMin: 16, hydTempMax: 14, engOilTemp: 10, coolantTemp: 9,
    ptoTempMax: 8, fanPumpF: 7, fanPumpR: 6, pump1F: 6, pump1R: 4, pump2F: 6, pump2R: 4, fuelRate: 2 };
  var WEIGHTS_TRUCK = { blowbyMax: 20, oilPressHMin: 18, brakeTemp: 16, retarderTemp: 14, coolantTemp: 10,
    engOilTemp: 10, hydTempMax: 8, fuelRate: 3 };
  var WEIGHTS_DOZER = { blowbyMax: 18, oilPressHMin: 16, hydTempMax: 14, ptoTempMax: 10, engOilTemp: 10,
    coolantTemp: 9, tcOilTempMax: 10, fExhTempMax: 8, rExhTempMax: 8, tmMainPressMax: 7,
    largePumpPress: 6, fuelRate: 3 };

  var PILLARS_EXCAVATOR = { blowbyMax: 'ENGINE', oilPressHMin: 'ENGINE', engOilTemp: 'ENGINE',
    hydTempMax: 'HYDRAULIC', ptoTempMax: 'HYDRAULIC', pump1F: 'HYDRAULIC', pump1R: 'HYDRAULIC',
    pump2F: 'HYDRAULIC', pump2R: 'HYDRAULIC', coolantTemp: 'COOLING', fanPumpF: 'COOLING', fanPumpR: 'COOLING', fuelRate: 'ECONOMY' };
  var PILLARS_TRUCK = { blowbyMax: 'ENGINE', oilPressHMin: 'ENGINE', engOilTemp: 'ENGINE',
    brakeTemp: 'BRAKE', retarderTemp: 'BRAKE', hydTempMax: 'HYDRAULIC', coolantTemp: 'COOLING', fuelRate: 'ECONOMY' };
  var PILLARS_DOZER = { blowbyMax: 'ENGINE', oilPressHMin: 'ENGINE', engOilTemp: 'ENGINE',
    fExhTempMax: 'ENGINE', rExhTempMax: 'ENGINE',
    hydTempMax: 'HYDRAULIC', largePumpPress: 'HYDRAULIC',
    ptoTempMax: 'POWERTRAIN', tcOilTempMax: 'POWERTRAIN', tmMainPressMax: 'POWERTRAIN',
    coolantTemp: 'COOLING', fuelRate: 'ECONOMY' };

  /* -----------------------------------------------------------------------
   * 6. Rakit profil lengkap per keluarga
   * --------------------------------------------------------------------- */
  var PROFILES = {
    EXCAVATOR: { family: FAMILIES.EXCAVATOR, thresholds: TH_EXCAVATOR, compartments: COMP_EXCAVATOR,
      weights: WEIGHTS_EXCAVATOR, pillars: PILLARS_EXCAVATOR },
    TRUCK: { family: FAMILIES.TRUCK, thresholds: TH_TRUCK, compartments: COMP_TRUCK,
      weights: WEIGHTS_TRUCK, pillars: PILLARS_TRUCK },
    DOZER: { family: FAMILIES.DOZER, thresholds: TH_DOZER, compartments: COMP_DOZER,
      weights: WEIGHTS_DOZER, pillars: PILLARS_DOZER },
    UNKNOWN: { family: FAMILIES.UNKNOWN, thresholds: TH_EXCAVATOR, compartments: COMP_GENERIC,
      weights: WEIGHTS_EXCAVATOR, pillars: PILLARS_EXCAVATOR }
  };

  /* -----------------------------------------------------------------------
   * 7. API
   * --------------------------------------------------------------------- */

  /** Profil untuk sebuah unit (berdasarkan metadata). */
  function profileFor(meta) {
    var fam = detectFamily(meta);
    var p = PROFILES[fam] || PROFILES.UNKNOWN;
    return { familyId: fam, profile: p, family: p.family };
  }

  function getFamily(id) { return FAMILIES[id] || FAMILIES.UNKNOWN; }

  global.VHMS_PROFILES = {
    FAMILIES: FAMILIES,
    PROFILES: PROFILES,
    detectFamily: detectFamily,
    profileFor: profileFor,
    getFamily: getFamily
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_PROFILES;
  }
})(typeof window !== 'undefined' ? window : globalThis);

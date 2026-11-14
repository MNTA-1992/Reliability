/* =========================================================================
 * vhms-snapshot-knowledge.js
 * -------------------------------------------------------------------------
 * [2026-10-12] KAMUS REFERENSI untuk KOLOM "Result" pada tabel parameter
 * Snapshot Alarm (snap00/snap01.CSV).
 *
 * MENGAPA MODUL INI ADA
 * ---------------------
 * Sebelumnya narasi Result dibangun INLINE di `vhms-extras-render.js` dengan
 * daftar kolom & teks yang tersebar. Akibatnya:
 *   - tidak ada rujukan tunggal saat ditanya "dari mana angka ini?";
 *   - kolom baru (mis. `FanPump F Press`) tidak punya narasi apa pun;
 *   - ambang (LUG 160 mm³/st, idle 1000 rpm) TIDAK dapat ditelusuri.
 *
 * Modul ini menyamakan pola dengan KB VHMS (`vhms-knowledge.js`) dan KB SOS
 * (`sos-knowledge.js`):
 *   - `DIMENSIONS` : kamus semua DIMENSI/BESARAN fisis yang mungkin muncul di
 *                    berkas snapshot, lengkap dengan satuan, rentang wajar,
 *                    dan rujukan manual.
 *   - `COLUMN_MAP` : kamus PEMETAAN nama kolom (berkas nyata) → dimensi +
 *                    peran. Inilah yang membuat kolom tak dikenal tetap
 *                    mendapat narasi yang benar, bukan teks generik.
 *   - `SIGNAL_COLUMNS`: kolom diskret ON/OFF.
 *   - `SIGNAL_KB` / `ROLE_RULES` / `GENERIC_KB` : kamus narasi per peran.
 *   - `THRESHOLDS`: ambang yang benar-benar dipakai (diturunkan dari
 *                    `VHMS_LOADMAP`), sehingga UI & spek TIDAK bisa berbeda.
 *
 * PRINSIP: 100% offline, tanpa berkas tambahan, satu sumber kebenaran.
 * Teks bersifat panduan umum industri & struktur manual Komatsu. BUKAN
 * kutipan resmi; teknisi tetap mengacu SOP & shop manual.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. DIMENSI — semua besarан fisis yang mungkin muncul pada snapshot.
   * ---------------------------------------------------------------------
   * unit      : satuan setelah dibagi `Axis Rate`.
   * band      : rentang wajar operasi; bila di luar → catatan khusus.
   * refs      : rujukan manual/industri untuk ditelusuri teknisi.
   * --------------------------------------------------------------------- */
  var DIMENSIONS = {
    rpm: {
      unit: 'rpm', label: 'Putaran mesin',
      band: [500, 2100],
      refs: ['Komatsu Shop Manual — Engine: Rated / Idle Speed'],
      note: 'Putaran mesin menentukan apakah beban mesin sehat atau berada di zona LUG.'
    },
    fuel: {
      unit: 'mm3/st', label: 'Jumlah bahan bakar per langkah',
      band: [0, 400],
      refs: ['Komatsu Shop Manual — Fuel Injection System (Full-load rate)'],
      note: 'Bahan bakar tinggi pada putaran rendah = beban tinggi lambat = paling merusak piston & turbo.'
    },
    temp_exh: {
      unit: 'degC', label: 'Suhu gas buang',
      band: [100, 800],
      refs: ['Komatsu Shop Manual — Exhaust Gas Temperature',
             'Komatsu Technical Bulletin — EGT Monitoring'],
      note: 'Beban termal turbo & valve; bandingkan antar bank silinder.'
    },
    temp_fluid: {
      unit: 'degC', label: 'Suhu cairan (oli/air)',
      band: [-20, 120],
      refs: ['Komatsu Shop Manual — Lubrication & Cooling System'],
      note: 'Suhu tinggi mempercepat degradasi oli/pendingin.'
    },
    temp_ambient: {
      unit: 'degC', label: 'Suhu lingkungan / kanal stabil',
      band: [-20, 60],
      refs: ['Komatsu Shop Manual — General Specifications'],
      note: 'Konstan adalah NORMAL: bukan indikator beban mesin.'
    },
    press_fluid: {
      unit: 'MPa', label: 'Tekanan cairan',
      band: [0, 50],
      refs: ['Komatsu Shop Manual — Hydraulic System / Lubrication'],
      note: 'Responsif terhadap beban; datar = periksa sensor RELIEF/beban nol.'
    },
    press_air: {
      unit: 'kPa', label: 'Tekanan udara / gas',
      band: [0, 300],
      refs: ['Komatsu Shop Manual — Turbocharger / Charge Air System'],
      note: 'Ikut beban turbo; datar atau melonjak = curiga sensor/wastegate.'
    },
    press_crank: {
      unit: 'kPa', label: 'Tekanan crankcase (blowby)',
      band: [0, 20],
      refs: ['Komatsu Shop Manual — Engine: Blowby Inspection'],
      note: 'Naik seiring keausan ring/liner; konstan = sensor patut diragukan.'
    },
    press_rail: {
      unit: 'MPa', label: 'Tekanan common rail',
      band: [0, 200],
      refs: ['Komatsu Shop Manual — Common Rail Fuel System'],
      note: 'Bergerak mengikuti permintaan injeksi/putaran.'
    },
    press_ppc: {
      unit: 'MPa', label: 'Tekanan pilot (PPC)',
      band: [0, 45],
      refs: ['Komatsu Shop Manual — PPC / Pilot Hydraulic Circuit'],
      note: 'Hanya ada di snapshot: bukti operasi lever operator.'
    },
    current_ma: {
      unit: 'mA', label: 'Arus perintah EPC',
      band: [450, 800],
      refs: ['Komatsu Shop Manual — Electric/Hydraulic EPC Control'],
      note: 'Arus naik/menurun mengikuti permintaan pompa — datar = curiga solenoid/sensor.'
    },
    percent: {
      unit: '%', label: 'Posisi / pembukaan (%)',
      band: [0, 100],
      refs: ['Komatsu Shop Manual — Throttle / Dial Control'],
      note: 'Menunjukkan permintaan operator terhadap beban.'
    },
    angle: {
      unit: 'deg', label: 'Sudut / timing',
      band: [0, 40],
      refs: ['Komatsu Shop Manual — Injection Timing Control'],
      note: 'Kode/posisi status; bukan indikator beban mesin.'
    },
    /* Posisi valve & kanal sinyal ON/OFF. Nilai 0/1 (bukan satuan fisis) tetapi
       tetap perlu entri agar `dimensionFor` mengembalikan rujukan — tanpa ini
       kolom seperti `Main Relief Valve` jatuh ke narasi generik walau sudah
       terpetakan di `COLUMN_MAP`. */
    valve: {
      unit: 'status', label: 'Posisi valve / kontak sinyal',
      band: [0, 1],
      refs: ['Komatsu Shop Manual — Hydraulic Control Valve',
             'Komatsu Shop Manual — Electric Circuit Monitor'],
      note: 'Nilai 0 = tidak aktif, 1 = aktif. Datar cukup wajar bila valve memang tidak dioperasikan.'
    }
  };

  /* -----------------------------------------------------------------------
   * 2. KAMUS PEMETAAN KOLOM (nama berkas nyata) → dimensi + peran.
   * ---------------------------------------------------------------------
   * Kunci WAJIB sudah dinormalkan lewat `normKey` (huruf kecil, tanpa
   * spasi/titik). Tambahkan entri baru DI SINI bila muncul kolom baru —
   * jangan menambah `if` di modul render.
   * --------------------------------------------------------------------- */
  var COLUMN_MAP = {
    // --- Sumbu ---
    time: { dim: 'time', role: 'time' },

    // --- Mesin: dasar ---
    engspeed: { dim: 'rpm', role: 'speed' },
    fuelinject: { dim: 'fuel', role: 'fuel' },
    fueldialpos: { dim: 'percent', role: 'demand' },
    finalthrotpos: { dim: 'percent', role: 'demand' },

    // --- Mesin: gas buang & pembakaran ---
    // ⚠ Nama kolom berkas nyata = "LBF/LBR/RBF/RBR Exh Temp" (Bank). Kunci
    // kamus WAJIB sama supaya tidak jatuh ke narasi generik.
    lbfexhtemp: { dim: 'temp_exh', role: 'egt', bank: 'LBF', cylinderGroup: 'Left-Bank Front' },
    lbrexhtemp: { dim: 'temp_exh', role: 'egt', bank: 'LBR', cylinderGroup: 'Left-Bank Rear' },
    rbfexhtemp: { dim: 'temp_exh', role: 'egt', bank: 'RBF', cylinderGroup: 'Right-Bank Front' },
    rbrexhtemp: { dim: 'temp_exh', role: 'egt', bank: 'RBR', cylinderGroup: 'Right-Bank Rear' },

    // --- Mesin: pemasukan & pernapasan ---
    boostpress: { dim: 'press_air', role: 'load_sensor', system: 'Turbocharger' },
    boosttemp: { dim: 'temp_fluid', role: 'thermal', system: 'Charge Air Cooler' },
    blowbypress: { dim: 'press_crank', role: 'load_sensor', system: 'Engine Crankcase' },
    comrailpress: { dim: 'press_rail', role: 'load_sensor', system: 'Fuel System' },
    pcvacttiming: { dim: 'angle', role: 'status' },

    // --- Mesin: pelumasan & pendinginan ---
    engoilpress: { dim: 'press_fluid', role: 'load_sensor', system: 'Lubrication' },
    engoiltemp: { dim: 'temp_fluid', role: 'thermal', system: 'Lubrication' },
    engcooltemp: { dim: 'temp_fluid', role: 'thermal', system: 'Cooling' },

    // --- Hidrolik: tekanan kerja ---
    pump1fpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Pump 1 Front' },
    pump1rpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Pump 1 Rear' },
    pump2fpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Pump 2 Front' },
    pump2rpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Pump 2 Rear' },
    boomraisepres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Boom Raise Cylinder' },
    boomlowerpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Boom Lower Cylinder' },
    arminpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Arm IN Cylinder' },
    armoutpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Arm OUT Cylinder' },
    bucketcurlpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Bucket Curl Cylinder' },
    bucketdumppres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Bucket Dump Cylinder' },
    swingrhpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Swing RH Circuit' },
    swinglhpres: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Swing LH Circuit' },
    fanpumpfpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Fan Pump Front' },
    fanpumprpress: { dim: 'press_fluid', role: 'hydraulic_work', system: 'Fan Pump Rear' },
    ppserviceon: { dim: 'press_ppc', role: 'pilot', system: 'PPC Service Circuit' },
    pptravel: { dim: 'press_ppc', role: 'pilot', system: 'PPC Travel Circuit' },
    hydroiltemp: { dim: 'temp_fluid', role: 'thermal', system: 'Hydraulic Oil' },

    // [D375A 2026-10-16] Kolom khas DOZER D375A-6 (snap00–snap05).
    // Berbeda dari PC2000 yang menulis EGT per bank 4-silinder
    // (LBF/LBR/RBF/RBR), D375A menulis "Exhaust Temp F" (Front) dan
    // "Exhaust Temp R" (Rear) — dua bank saja, V12-inline.
    // ⚠ Kunci = normKey(nama kolom nyata): "Exhaust Temp F" -> `exhausttempf`.
    // ⚠ `exhausttempf`/`exhausttempr` SUDAH cocok dengan regex `/exhtemp/`
    // di `SHOULD_VARY_PATTERNS`, sehingga uji stuck otomatis menangkap
    // sensor EGT yang konstan 969 °C.
    exhausttempf: { dim: 'temp_exh', role: 'egt', bank: 'F', cylinderGroup: 'Front Bank' },
    exhausttempr: { dim: 'temp_exh', role: 'egt', bank: 'R', cylinderGroup: 'Rear Bank' },

    // --- D375A: Pendinginan & turbocharger ---
    // ⚠ Nama kolom nyata = "EngCoolantTemp" (tanpa spasi) -> normKey
    // `engcoolanttemp`. Jangan disingkat jadi `engcooltemp` (itu milik
    // kolom PC2000 "Eng Cool Temp").
    engcoolanttemp: { dim: 'temp_fluid', role: 'thermal', system: 'Cooling' },
    tcoiltemp: { dim: 'temp_fluid', role: 'thermal', system: 'Turbocharger Oil' },

    // --- D375A: Transmisi (powershift) ---
    tmmainpres: { dim: 'press_fluid', role: 'load_sensor', system: 'Transmission Main' },
    tmoutputspeed: { dim: 'rpm', role: 'load_sensor', system: 'Transmission Output' },
    shiftposition: { dim: 'angle', role: 'status' },

    // --- D375A: Steering clutch & brake ---
    stclutchstate: { dim: 'valve', role: 'valve', system: 'Steering Clutch' },
    stbrakestate: { dim: 'valve', role: 'valve', system: 'Steering Brake' },

    // --- D375A: Hidrolik & implement ---
    largepumppress: { dim: 'press_fluid', role: 'load_sensor', system: 'Large Pump' },
    bodypitchangle: { dim: 'angle', role: 'status' },

    // --- D375A: Pendingin kipas & torque converter ---
    fanspeed: { dim: 'rpm', role: 'thermal', system: 'Cooling Fan' },
    tcinpress: { dim: 'press_fluid', role: 'load_sensor', system: 'Torque Converter Inlet' },
    tcoutpress: { dim: 'press_fluid', role: 'load_sensor', system: 'Torque Converter Outlet' },

    // --- Hidrolik: arus EPC ---
    pump1fepc: { dim: 'current_ma', role: 'epc', system: 'Pump 1 Front EPC' },
    pump1repc: { dim: 'current_ma', role: 'epc', system: 'Pump 1 Rear EPC' },
    pump2fepc: { dim: 'current_ma', role: 'epc', system: 'Pump 2 Front EPC' },
    pump2repc: { dim: 'current_ma', role: 'epc', system: 'Pump 2 Rear EPC' },
    radfanpumpepc: { dim: 'current_ma', role: 'epc', system: 'Radiator Fan Pump EPC' },
    ocfanpumpepc: { dim: 'current_ma', role: 'epc', system: 'Oil Cooler Fan Pump EPC' },

    // --- Suhu kompartemen ---
    ptotemp: { dim: 'temp_fluid', role: 'thermal', system: 'PTO' },
    ambienttemp: { dim: 'temp_ambient', role: 'ambient' },
    atmospres: { dim: 'press_air', role: 'ambient' },

    // --- Valve (posisi) ---
    mainreliefvalve: { dim: 'valve', role: 'valve', system: 'Main Relief' },
    armthrotlevalvel: { dim: 'valve', role: 'valve', system: 'Arm Throttle Valve L' },
    armthrotlevalver: { dim: 'valve', role: 'valve', system: 'Arm Throttle Valve R' },
    swingbrakevalve: { dim: 'valve', role: 'valve', system: 'Swing Brake' },
    swingprivalve: { dim: 'valve', role: 'valve', system: 'Swing Priority' },
    varibackvalve: { dim: 'valve', role: 'valve', system: 'Variable Back Pressure' },
    boomthrotlevalve: { dim: 'valve', role: 'valve', system: 'Boom Throttle Valve' },
    straighttravelvalv: { dim: 'valve', role: 'valve', system: 'Straight Travel' },
    code: { dim: 'angle', role: 'status' }
  };

  /* -----------------------------------------------------------------------
   * 3. KOLOM SINYAL DISKRET (ON/OFF).
   * ---------------------------------------------------------------------
   * Dipisah dari `COLUMN_MAP` agar tidak dibingungkan dengan tekanan PPC
   * (yang memang analog) maupun valve posisi.
   * --------------------------------------------------------------------- */
  var SIGNAL_COLUMNS = {
    ppcrhtravelon: { system: 'PPC Right Travel', label: 'PPC RH Travel' },
    ppclhtravelon: { system: 'PPC Left Travel', label: 'PPC LH Travel' }
  };

  /* -----------------------------------------------------------------------
   * 4. KAMUS NARASI per PERAN.
   * ---------------------------------------------------------------------
   * Setiap peran punya 3 nada: `ok`, `warn`, `crit` + `note` opsional.
   * `{val}`/`{range}`/`{unit}`/`{pct}`/`{bank}` diganti saat render.
   * --------------------------------------------------------------------- */
  var ROLE_KB = {
    speed: {
      unit: 'rpm',
      note: 'Putaran mesin rendah + bahan bakar tinggi = ZONA LUG (merusak piston & turbo).',
      ok: 'Bervariasi mengikuti permintaan operator (rentang {range} rpm) — sensor responsif.',
      warn: 'Hanya bergerak {range} rpm sepanjang rekaman — periksa apakah mesin memang idle sesaat.',
      crit: 'Nyaris tidak bergerak padahal pemicu alarm terjadi — sensor putaran patut diverifikasi.'
    },
    fuel: {
      unit: 'mm3/st',
      note: 'Bahan bakar ≥{lugFuel} mm³/st pada putaran <{lugRpm} rpm = zona LUG.',
      ok: 'Bervariasi mengikuti beban (rentang {range} mm³/st) — sensor responsif.',
      warn: 'Bervariasi sempit (rentang {range}) — periksa apakah rekaman memang sesaat.',
      crit: 'Nyaris tidak berubah padahal beban berubah — sensor injeksi patut diverifikasi.'
    },
    egt: {
      unit: 'degC',
      note: 'Suhu gas buang adalah indikator beban termal tiap bank silinder.',
      ok: 'Bergerak mengikuti beban (rentang {range} degC) — sensor responsif.',
      warn: 'Bank {bank} ({group}) bergerak sempit (rentang {range} degC) — bandingkan dengan bank lain.',
      crit: 'Nyaris konstan (rentang {range} degC) padahal harus mengikuti beban — ' +
        'indikasi sensor EGT bank {bank} ({group}) RUSAK; angka kolom ini tidak layak dipercaya.'
    },
    load_sensor: {
      unit: '',
      note: 'Sensor ini seharusnya bergerak mengikuti beban mesin.',
      ok: 'Bervariasi mengikuti beban mesin (rentang {range}) — sensor responsif.',
      warn: 'Rentang hanya {range} — variasi kecil; periksa bila ada gejala lain.',
      crit: 'Nyaris tidak berubah padahal seharusnya mengikuti beban — indikasi sensor RUSAK.'
    },
    hydraulic_work: {
      unit: '',
      note: 'Tekanan hanya terbentuk bila silinder/sirkuit bergerak — datar bisa wajar.',
      ok: 'Bervariasi mengikuti gerakan attachment (rentang {range}) — sensor responsif.',
      warn: 'Rentang sempit ({range}) — kemungkinan sirkuit memang tidak beroperasi selama rekaman.',
      crit: 'Nyaris tidak berubah padahal ada gerakan (lihat kolom pilot) — sensor tekanan patut diverifikasi.'
    },
    pilot: {
      unit: '',
      note: 'Hanya ada di snapshot: bukti posisi lever operator (PPC).',
      ok: 'Terbentuk mengikuti perintah operator (rentang {range}) — sistem pilot bekerja.',
      warn: 'Rentang {range} — perintah operator kecil selama rekaman.',
      crit: 'Tidak terbentuk selama rekaman — pastikan lever memang tidak dioperasikan.'
    },
    epc: {
      unit: '',
      note: 'Arus EPC naik-turun mengikuti permintaan pompa; nilai tetap = curiga solenoid/sensor.',
      ok: 'Bervariasi mengikuti permintaan pompa (rentang {range}) — respons normal.',
      warn: 'Bervariasi kecil ({range}) — perintah pompa ringan selama rekaman.',
      crit: 'Arus nyaris tetap padahal pompa bergerak — curiga solenoid/sensor EPC.'
    },
    thermal: {
      unit: '',
      note: 'Suhu bisa stabil saat operasi mantap — konstan belum tentu kerusakan.',
      ok: 'Bergerak mengikuti beban (rentang {range}) — sensor responsif.',
      warn: 'Bergerak kecil ({range}) — pertimbangkan apakah operasi memang mantap.',
      crit: 'Nyaris konstan padahal beban berubah — periksa sensor suhu & kondisi pendinginan.'
    },
    valve: {
      unit: '',
      note: 'Kolom posisi valve (0/1): menunjukkan valve bergerak atau tidak.',
      ok: 'Valve berganti posisi selama rekaman ({pct} % waktu aktif) — fungsi terpantau.',
      warn: 'Valve aktif {pct} % waktu — aktivitas rendah; periksa bila ada keluhan.',
      crit: 'Tidak ada perubahan posisi sepanjang rekaman — pantau fungsi valve bila ada gejala.'
    },
    demand: {
      unit: '%',
      note: 'Permintaan operator (dial/throttle) terhadap beban mesin.',
      ok: 'Bervariasi mengikuti permintaan operator (rentang {range} %) — responsif.',
      warn: 'Permintaan berubah sempit ({range} %) — operasi mantap selama rekaman.',
      crit: 'Permintaan tetap padahal beban berubah — verifikasi sensor posisi.'
    },
    ambient: {
      unit: '',
      note: 'Bukan indikator beban mesin — konstan adalah NORMAL.',
      ok: 'Bergerak sedikit (rentang {range}) — sesuai kondisi lingkungan.',
      warn: 'Bergerak kecil ({range}) — wajar bila lingkungan stabil.',
      crit: 'Konstan {val} — wajar bila rekaman singkat; bukan indikasi kerusakan.'
    },
    status: {
      unit: '',
      note: 'Kode/posisi status kontrol — bukan indikator beban mesin.',
      ok: null, warn: null,
      crit: null
    },
    time: {
      unit: 's',
      note: 'Sumbu waktu relatif terhadap pemicu alarm.',
      ok: null, warn: null, crit: null
    }
  };

  /* -----------------------------------------------------------------------
   * 5. NARASI GENERIK per peran (bila `ROLE_KB` tidak mengisi suatu nada).
   * --------------------------------------------------------------------- */
  var GENERIC_KB = {
    ok: 'Bervariasi normal selama rekaman (rentang {range}) — tidak ada indikasi gangguan.',
    warn: 'Variasi sempit (rentang {range}) — nilai hampir tetap; periksa bila ada gejala lain.',
    crit: 'Nilai nyaris konstan padahal seharusnya mengikuti beban — indikasi sensor rusak.',
    none: 'Bervariasi normal selama rekaman — tidak ada indikasi gangguan.'
  };

  var SIGNAL_KB = {
    on: 'Kontak aktif {pct} % waktu rekaman — operasi kanal sinyal ini terkerekam.',
    off: 'Kontak tidak aktif selama rekaman — tidak ada operasi pada kanal sinyal ini.'
  };

  /* -----------------------------------------------------------------------
   * 6. AMBANG — diturunkan dari VHMS_LOADMAP agar UI & spek TIDAK berbeda.
   * --------------------------------------------------------------------- */
  var THRESHOLDS = {
    lugFuelMin: 160,     // mm3/st
    lugRpmMax: 1600,     // rpm
    hiPowerFuelMin: 210, // mm3/st
    hiPowerRpmMin: 1600, // rpm
    idleRpmMax: 1000     // rpm
  };
  // Ambil dari modul load map bila tersedia (satu sumber kebenaran).
  (function () {
    var lm = global.VHMS_LOADMAP;
    if (!lm) return;
    if (lm.LUG_FUEL_MIN !== undefined) THRESHOLDS.lugFuelMin = lm.LUG_FUEL_MIN;
    if (lm.LUG_RPM_MAX !== undefined) THRESHOLDS.lugRpmMax = lm.LUG_RPM_MAX;
    if (lm.HIPOWER_FUEL_MIN !== undefined) THRESHOLDS.hiPowerFuelMin = lm.HIPOWER_FUEL_MIN;
    if (lm.HIPOWER_RPM_MIN !== undefined) THRESHOLDS.hiPowerRpmMin = lm.HIPOWER_RPM_MIN;
  })();

  /* -----------------------------------------------------------------------
   * 7. Utilitas
   * --------------------------------------------------------------------- */

  /** Normalkan nama kolom → kunci kamus (huruf kecil, tanpa spasi/titik). */
  function normKey(name) {
    return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Cari padanan kolom di kamus.
   * Urutan: PERSIS → SINYAL → awalan/akhiran `COLUMN_MAP` → null.
   * Pemetaan berawalan dipakai untuk kolom dinamis seperti `PPC RH Travel ON`
   * yang namanya berubah antar unit.
   * @returns {{key:string, def:object}|null}
   */
  function lookupColumn(name) {
    var k = normKey(name);
    if (!k) return null;
    if (COLUMN_MAP[k]) return { key: k, def: COLUMN_MAP[k] };
    if (SIGNAL_COLUMNS[k]) return { key: k, def: { dim: 'valve', role: 'signal' } };
    // Awalan yang dikenal (kolom tulisannya bisa bervariasi).
    var prefixes = [
      ['ppcrhtravel', 'rhtravel'], ['ppclhtravel', 'lhtravel'],
      ['ppcservice', 'service'], ['ppctravel', 'travel']
    ];
    for (var i = 0; i < prefixes.length; i++) {
      if (k.indexOf(prefixes[i][0]) === 0) {
        return { key: prefixes[i][1], def: { dim: 'valve', role: 'signal' } };
      }
    }
    // Cari kecocokan sebagian (mis. "FanPump F Press" → fanpumpfpress).
    var found = null;
    Object.keys(COLUMN_MAP).forEach(function (ck) {
      if (found) return;
      if (ck.length >= 6 && (k.indexOf(ck) >= 0 || ck.indexOf(k) >= 0)) found = { key: ck, def: COLUMN_MAP[ck] };
    });
    return found;
  }

  /** Ambil definisi dimensi (satuan/rujukan/catatan) untuk sebuah kolom. */
  function dimensionFor(name) {
    var hit = lookupColumn(name);
    if (!hit) return null;
    var d = DIMENSIONS[hit.def.dim];
    return d ? { def: hit.def, dim: d, key: hit.key } : null;
  }

  /** Daftar rujukan (refs) untuk sebuah kolom; gabungan dimensi + catatan. */
  function refsFor(name) {
    var info = dimensionFor(name);
    if (!info) return [];
    return (info.dim.refs || []).slice();
  }

  /** Peran sebuah kolom ('egt', 'load_sensor', ...). */
  function roleFor(name) {
    var hit = lookupColumn(name);
    return hit ? hit.def.role : null;
  }

  /** Dimensi fisis sebuah kolom ('temp_exh', 'rpm', ...). */
  function dimFor(name) {
    var hit = lookupColumn(name);
    return hit ? hit.def.dim : null;
  }

  /** Apakah kolom ini termasuk sinyal ON/OFF? */
  function isSignalColumn(name) {
    var k = normKey(name);
    if (SIGNAL_COLUMNS[k]) return true;
    return /^(ppc.*on|ppcrhtravel|ppclhtravel|ppcservice|ppctravel)/.test(k);
  }

  /**
   * Narasi untuk kolom TAK DIKENAL. Menyebut nilai & rentang apa adanya
   * supaya tetap objektif, bukan teks kosong.
   */
  function genericNarration(stats) {
    stats = stats || {};
    var rng = stats.range;
    var last = stats.last;
    if (rng === 0) {
      return {
        text: 'Konstan ' + fmt(last) + (stats.unit ? ' ' + stats.unit : '') +
          ' sepanjang rekaman — tidak mengikuti beban mesin.',
        tone: 'muted'
      };
    }
    return { text: GENERIC_KB.none, tone: 'muted' };
  }

  /** Masukkan rujukan & catatan ke sel tabel (dipakai tabel stuck). */
  function referenceNote(name) {
    var info = dimensionFor(name);
    if (!info) return '';
    var parts = [];
    if (info.dim.label) parts.push(info.dim.label);
    if (info.dim.note) parts.push(info.dim.note);
    return parts.join(' — ');
  }

  function fmt(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = Number(v);
    return (Math.abs(n) >= 100) ? n.toFixed(0) : n.toFixed(2);
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_SNAPSHOT_KNOWLEDGE = {
    DIMENSIONS: DIMENSIONS,
    COLUMN_MAP: COLUMN_MAP,
    SIGNAL_COLUMNS: SIGNAL_COLUMNS,
    ROLE_KB: ROLE_KB,
    GENERIC_KB: GENERIC_KB,
    SIGNAL_KB: SIGNAL_KB,
    THRESHOLDS: THRESHOLDS,
    normKey: normKey,
    lookupColumn: lookupColumn,
    dimensionFor: dimensionFor,
    refsFor: refsFor,
    roleFor: roleFor,
    dimFor: dimFor,
    isSignalColumn: isSignalColumn,
    genericNarration: genericNarration,
    referenceNote: referenceNote
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_SNAPSHOT_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

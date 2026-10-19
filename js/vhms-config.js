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

  // [KONSOLIDASI 2026-10-04 · B-3] Helper pencocokan model bersama.
  var _mm = global.MODEL_MATCH || {};

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
    // [B-3 2026-10-13] `nullValues` = sentinel KHUSUS PARAMETER ini.
    // Pada sebagian berkas HD785, sensor ambient tidak terpasang/tidak terbaca
    // dan ECM menulis nilai batas int8: Max = -128, Min = 127 — KONSTAN di
    // seluruh 200 baris, dan secara fisika mustahil (max < min).
    // `NULL_SENTINELS` global hanya memuat batas int16 (-32768/-32767)
    // sehingga angka ini lolos dan tampil sebagai suhu sungguhan.
    // Sentinel ini TIDAK boleh global: -128 dan 127 adalah nilai SAH untuk
    // parameter lain (mis. hitungan duty, tekanan, sudut).
    // CATATAN: `ambientAve` TIDAK diberi `nullValues: [0]` — 0 °C adalah suhu
    // yang SAH di tempat lain. Kasus "Ave = 0 padahal Max/Min sentinel"
    // ditangani aturan KOHERENSI di vhms-parser (lihat `_voidIncoherent`).
    ambientMax:      { csvHeader: 'Ambient TempMax',      label: 'Ambient Temp Max',       unit: '\u00B0C', decimals: 1, nullValues: [-128, 127] },
    ambientAve:      { csvHeader: 'Ambient TempAve',      label: 'Ambient Temp Ave',       unit: '\u00B0C', decimals: 1, nullValues: [-128, 127] },
    ambientMin:      { csvHeader: 'Ambient TempMin',      label: 'Ambient Temp Min',       unit: '\u00B0C', decimals: 1, nullValues: [-128, 127] },
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

    // -----------------------------------------------------------------------
    // [FITUR 2026-10-16] TEKANAN REM F/R — HD785 (kolom berkas trend `'40'`:
    // "F Brake P.Max" / "R Brake P.Max"). Berbeda dari `brakeTemp` (°C):
    // ini TEKANAN (MPa), indikator kerja sistem rem/retarder.
    //   F Brake P.Max -> fBrakePressMax   R Brake P.Max -> rBrakePressMax
    // Satuan: CSV menulis dalam satuan terkecil (x10 kPa => MPa*10), sama
    // seperti `tmMainPressMax`, sehingga `scale: 0.1` mengubah ke MPa.
    // ⚠ Ambang = USULAN, BELUM terkalibrasi per-model.
    // -----------------------------------------------------------------------
    fBrakePressMax:  { csvHeader: 'F Brake P.Max',        label: 'F Brake Press Max',      unit: 'MPa',     decimals: 2, scale: 0.1 },
    rBrakePressMax:  { csvHeader: 'R Brake P.Max',        label: 'R Brake Press Max',      unit: 'MPa',     decimals: 2, scale: 0.1 },
    oilPressAve:     { csvHeader: 'EOil Pre.AVE',         label: 'Engine Oil Press Ave',   unit: 'MPa',     decimals: 2, scale: 0.01 },
    boostAve:        { csvHeader: 'Boost Press Ave',      label: 'Boost Press Ave',        unit: 'mmHg',    decimals: 1, scale: 7.50062 },

    // -----------------------------------------------------------------------
    // [D375A] Parameter khas DOZER tipe besar (D375A-6). Lihat file template
    // "65258.CSV". Kolom di bawah ini HANYA muncul pada keluarga DOZER; parser
    // otomatis mengabaikannya bila kolomnya tidak ada pada file lain, jadi
    // aman dipakai lintas model.
    // -----------------------------------------------------------------------

    // Suhu gas buang per bank (kiri/kanan). Nilai -32768 = sensor tidak ada.
    // [FITUR 2026-10-16] `minValid: 1` — suhu EGT ABSOLUT tidak mungkin <= 0
    // °C pada mesin hidup; nilai minus = SINYAL SENSOR RUSAK (ECM menulis
    // sentinel negatif seperti -40/-32768). Parser membuang nilai < minValid
    // sehingga tidak pernah muncul sebagai pembacaan sungguhan.
    fExhTempMax:     { csvHeader: 'F Exh.Temp Max',       label: 'F Exhaust Temp Max',     unit: '\u00B0C', decimals: 0, minValid: 1,
                       aliases: ['F Exh.TempMax', 'F Exhaust Temp Max'] },
    rExhTempMax:     { csvHeader: 'R Exh.Temp Max',       label: 'R Exhaust Temp Max',     unit: '\u00B0C', decimals: 0, minValid: 1,
                       aliases: ['R Exh.TempMax', 'R Exhaust Temp Max'] },

    // -----------------------------------------------------------------------
    // [FITUR 2026-10-16] Suhu gas buang per SUDUT MANIFOLD — KHUSUS EXCAVATOR
    // (PC2000). Excavator Komatsu tidak mengekspor "bank depan/belakang"
    // seperti dozer (`F/R Exh.Temp Max`), melainkan SUHU ABSOLUT per sudut
    // manifold, mengikuti konvensi sensor fault yang SAMA dengan HD785:
    //   LBF = Left-Bank Front   -> lbfExhTempMax
    //   LBR = Left-Bank Rear    -> lbrExhTempMax
    //   RBF = Right-Bank Front  -> rbfExhTempMax
    //   RBR = Right-Bank Rear   -> rbrExhTempMax
    //
    // Beda dengan `lfExhOver*` (duty "% jendela" >700/750/800 °C pada berkas
    // chassis trend `'86'`), param di bawah adalah SUHU AKTUAL (°C) pada
    // berkas trend utama `'40'` — sehingga bisa dipakai panel "Top End Wear"
    // di Failure Mode Summary.
    //
    // Aman lintas model: berkas D375A/HD785 tidak memuat kolom ini, sehingga
    // parser meninggalkannya `null` (tidak pernah error). Pencocokan berbasis
    // NAMA, bukan posisi.
    //
    // Sumber nama: kolom `Axis Item` berkas VHMS PC2000 SN 20020, dibaca apa
    // adanya (bukan tebakan).
    // -----------------------------------------------------------------------
    lbfExhTempMax:   { csvHeader: 'LBF Exh.TempMax',      label: 'LBF Exhaust Temp Max',   unit: '\u00B0C', decimals: 0, minValid: 1 },
    lbrExhTempMax:   { csvHeader: 'LBR Exh.TempMax',      label: 'LBR Exhaust Temp Max',   unit: '\u00B0C', decimals: 0, minValid: 1 },
    rbfExhTempMax:   { csvHeader: 'RBF Exh.TempMax',      label: 'RBF Exhaust Temp Max',   unit: '\u00B0C', decimals: 0, minValid: 1 },
    rbrExhTempMax:   { csvHeader: 'RBR Exh.TempMax',      label: 'RBR Exhaust Temp Max',   unit: '\u00B0C', decimals: 0, minValid: 1 },

    // -----------------------------------------------------------------------
    // [FITUR 2026-10-16] Suhu gas buang ABSOLUT per GRUP SILINDER — HD785
    // (V12 SAA12V140E3). Truk mengekspor 4 kolom suhu AKTUAL (°C) di berkas
    // trend utama `'40'` dengan penamaan LF/LR/RF/RR (tanpa "B" seperti
    // excavator `lbf*`), BERBEDA dari `lfExhOver*` yang bersatuan "% jendela"
    // pada berkas chassis trend `'86'`.
    //   LF = Left-Bank Front   -> lfExhTempMax
    //   LR = Left-Bank Rear    -> lrExhTempMax
    //   RF = Right-Bank Front  -> rfExhTempMax
    //   RR = Right-Bank Rear   -> rrExhTempMax
    // Memungkinkan panel "Top End Wear" memakai suhu absolut (lebih mudah
    // dibaca operator dibanding duty %).
    //
    // ⚠ JANGAN tertukar dengan `lfExhOver700/750/800` (duty, satu kanal).
    //   Nama di sini = kolom CSV APA ADANYA ('LF Exh.Temp Max').
    // -----------------------------------------------------------------------
    lfExhTempMax:    { csvHeader: 'LF Exh.Temp Max',      label: 'LF Exhaust Temp Max',    unit: '\u00B0C', decimals: 0, minValid: 1 },
    lrExhTempMax:    { csvHeader: 'LR Exh.Temp Max',      label: 'LR Exhaust Temp Max',    unit: '\u00B0C', decimals: 0, minValid: 1 },
    rfExhTempMax:    { csvHeader: 'RF Exh.Temp Max',      label: 'RF Exhaust Temp Max',    unit: '\u00B0C', decimals: 0, minValid: 1 },
    rrExhTempMax:    { csvHeader: 'RR Exh.Temp Max',      label: 'RR Exhaust Temp Max',    unit: '\u00B0C', decimals: 0, minValid: 1 },

    // [FITUR 2026-10-16] Suhu oli transmisi (T/M) — HD785 (kolom
    // "TM Oil Temp.Max"). Sumber: berkas VHMS HD785 SN 33295, dibaca apa
    // adanya. Menjadi indikator kesehatan powertrain truk.
    tmOilTempMax:    { csvHeader: 'TM Oil Temp.Max',      label: 'T/M Oil Temp Max',       unit: '\u00B0C', decimals: 0 },

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
    pitchAngleMin:   { csvHeader: 'Pitch Angle Min',      label: 'Pitch Angle Min',        unit: '\u00B0',  decimals: 1, scale: 0.1 },

    // -----------------------------------------------------------------------
    // [T5 2026-10-08] PARAMETER T/M TREND (file `tm_trend0.CSV`, Data Type 81)
    // -----------------------------------------------------------------------
    // Satu-satunya sumber longitudinal panjang untuk powertrain dozer.
    // Nama header SAMA PERSIS dengan baris "Axis Item" file tm_trend0:
    //   Axis Item,SMR,Calendar,F Trg. Time,R Trg. Time,1st Trg. Time,
    //             2nd Trg. Time,3rd Trg. Time,TC Oil T.120-,TC Oil T.130-,TC Oil T.140-
    //
    // ARTI:
    //   * Trg. Time       = waktu trigger / CLUTCH FILL TIME (msec).
    //                       NAIK = clutch pack aus atau tekanan modulasi turun.
    //   * TC Oil T.1xx-   = DURASI (detik) suhu oli torque converter berada di
    //                       atas 120/130/140 °C. ⚠ Ini DELTA PER INTERVAL
    //                       snapshot, BUKAN akumulasi seumur hidup (lihat
    //                       vhms-analytics.cumulative() + docs §1.2). Karena
    //                       itu parameter ini TIDAK BOLEH ditafsirkan lewat
    //                       `slope` seolah akumulasi.
    // -----------------------------------------------------------------------
    // [B-4 2026-10-13] LABEL DIPERBAIKI: dulu keduanya berlabel
    // "F/R Clutch Fill Time" sehingga `tmTrgTimeR` BERTABRAKAN PERSIS dengan
    // `tmFillR` — dua kolom berjudul sama muncul berdampingan di tabel log
    // (terbukti di browser pada HD785). Padahal keduanya besaran BERBEDA,
    // seperti dijelaskan komentar blok di bawah: `Trg. Time` = respons ECMV
    // (belasan msec; terukur 17), `Fill Time` = pengisian clutch pack
    // (ratusan msec; terukur 930). Ambangnya pun berbeda jauh (200 vs 1450).
    // Penamaan kini mengikuti `tmTrgTimeLow`/`tmTrgTimeHigh` yang sudah benar.
    tmTrgTimeF:      { csvHeader: 'F Trg. Time',          label: 'F Trigger Time',         unit: 'msec',    decimals: 0 },
    tmTrgTimeR:      { csvHeader: 'R Trg. Time',          label: 'R Trigger Time',         unit: 'msec',    decimals: 0 },
    tmTrgTime1:      { csvHeader: '1st Trg. Time',        label: '1st Gear Trigger Time',  unit: 'msec',    decimals: 0 },
    tmTrgTime2:      { csvHeader: '2nd Trg. Time',        label: '2nd Gear Trigger Time',  unit: 'msec',    decimals: 0 },
    tmTrgTime3:      { csvHeader: '3rd Trg. Time',        label: '3rd Gear Trigger Time',  unit: 'msec',    decimals: 0 },
    tcOilOver120:    { csvHeader: 'TC Oil T.120-',        label: 'T/C Oil over 120\u00B0C', unit: 'sec',     decimals: 0, delta: true },
    tcOilOver130:    { csvHeader: 'TC Oil T.130-',        label: 'T/C Oil over 130\u00B0C', unit: 'sec',     decimals: 0, delta: true },
    tcOilOver140:    { csvHeader: 'TC Oil T.140-',        label: 'T/C Oil over 140\u00B0C', unit: 'sec',     decimals: 0, delta: true },

    // -----------------------------------------------------------------------
    // [HD785 2026-10-09] PARAMETER CHASSIS TREND (`chas_trend0.CSV`, Type 86)
    // -----------------------------------------------------------------------
    // Nama header SAMA PERSIS dengan baris "Axis Item" chas_trend0 HD785-7.
    // Berkas ini punya SMR **dan** Calendar yang DUA-DUANYA SAH (berbeda dari
    // `tm_trend0.CSV` D375A yang Calendar-nya tidak sinkron), sehingga ia
    // digabung sebagai record trend biasa lewat VHMS_FLEET.add().
    //
    // TIGA KELOMPOK BESAR:
    //  1) *Fill Time*  — waktu PENGISIAN clutch pack (msec) per posisi.
    //       NAIK = clutch pack aus / tekanan modulasi turun / seal bocor.
    //       Ini indikator keausan powertrain yang paling langsung.
    //  2) *Trg. Time*  — waktu TRIGGER (msec), yaitu respons ECMV.
    //       Nilainya jauh lebih kecil (belasan msec) daripada fill time.
    //  3) *T.1xx- / Temp 7xx-* — DURASI (detik) sebuah suhu berada di atas
    //       ambang pada periode snapshot. ⚠ DELTA PER INTERVAL, bukan
    //       akumulasi seumur hidup — sama seperti `tcOilOver*` (lihat
    //       vhms-analytics.cumulative()). JANGAN ditafsirkan lewat `slope`
    //       seolah besaran kumulatif.
    //
    // ⚠ `Fill Time` dan `Trg. Time` adalah DUA kolom BERBEDA pada berkas ini.
    //    Jangan menyamakan keduanya: `tmTrgTime*` (sudah ada, dipakai D375A)
    //    tetap memetakan "Trg. Time", sedangkan `tmFill*` adalah kolom baru.
    // -----------------------------------------------------------------------
    tmFillLow:       { csvHeader: 'Low Fill Time',        label: 'Low Clutch Fill Time',   unit: 'msec',    decimals: 0 },
    tmFillHigh:      { csvHeader: 'High Fill Time',       label: 'High Clutch Fill Time',  unit: 'msec',    decimals: 0 },
    tmFill1:         { csvHeader: '1st Fill Time',        label: '1st Clutch Fill Time',   unit: 'msec',    decimals: 0 },
    tmFill2:         { csvHeader: '2nd Fill Time',        label: '2nd Clutch Fill Time',   unit: 'msec',    decimals: 0 },
    tmFill3:         { csvHeader: '3rd Fill Time',        label: '3rd Clutch Fill Time',   unit: 'msec',    decimals: 0 },
    tmFill4:         { csvHeader: '4th Fill Time',        label: '4th Clutch Fill Time',   unit: 'msec',    decimals: 0 },
    tmFillR:         { csvHeader: 'R Fill Time',          label: 'R Clutch Fill Time',     unit: 'msec',    decimals: 0 },

    tmTrgTimeLow:    { csvHeader: 'Low Trg. Time',        label: 'Low Trigger Time',       unit: 'msec',    decimals: 0 },
    tmTrgTimeHigh:   { csvHeader: 'High Trg. Time',       label: 'High Trigger Time',      unit: 'msec',    decimals: 0 },
    tmTrgTime4:      { csvHeader: '4th Trg. Time',        label: '4th Gear Trigger Time',  unit: 'msec',    decimals: 0 },

    // Oli retarder depan/belakang (RTD = ReTarDer) — duty termal pengereman.
    fRtdOver120:     { csvHeader: 'F RTD Oil T.120-',     label: 'F Retarder Oil >120\u00B0C', unit: 'sec', decimals: 0, delta: true },
    fRtdOver130:     { csvHeader: 'F RTD Oil T.130-',     label: 'F Retarder Oil >130\u00B0C', unit: 'sec', decimals: 0, delta: true },
    fRtdOver140:     { csvHeader: 'F RTD Oil T.140-',     label: 'F Retarder Oil >140\u00B0C', unit: 'sec', decimals: 0, delta: true },
    rRtdOver120:     { csvHeader: 'R RTD Oil T.120-',     label: 'R Retarder Oil >120\u00B0C', unit: 'sec', decimals: 0, delta: true },
    rRtdOver130:     { csvHeader: 'R RTD Oil T.130-',     label: 'R Retarder Oil >130\u00B0C', unit: 'sec', decimals: 0, delta: true },
    rRtdOver140:     { csvHeader: 'R RTD Oil T.140-',     label: 'R Retarder Oil >140\u00B0C', unit: 'sec', decimals: 0, delta: true },

    // Suhu gas buang per GRUP SILINDER. HD785 mesin V12 dibagi 4 grup:
    // LF = Left-Bank Front, LR = Left-Bank Rear, RF = Right-Bank Front,
    // RR = Right-Bank Rear. Nama ini sepadan dengan LBF/LBR/RBF/RBR pada
    // pesan fault (`Exhaust Temp. Sensor RBF Failure`) — dipakai oleh
    // FAULT_SENSOR_MAP untuk gerbang kualitas data.
    lfExhOver700:    { csvHeader: 'LF Exh.Temp 700-',     label: 'LF Exhaust >700\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    lfExhOver750:    { csvHeader: 'LF Exh.Temp 750-',     label: 'LF Exhaust >750\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    lfExhOver800:    { csvHeader: 'LF Exh.Temp 800-',     label: 'LF Exhaust >800\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    lrExhOver700:    { csvHeader: 'LR Exh.Temp 700-',     label: 'LR Exhaust >700\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    lrExhOver750:    { csvHeader: 'LR Exh.Temp 750-',     label: 'LR Exhaust >750\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    lrExhOver800:    { csvHeader: 'LR Exh.Temp 800-',     label: 'LR Exhaust >800\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rfExhOver700:    { csvHeader: 'RF Exh.Temp 700-',     label: 'RF Exhaust >700\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rfExhOver750:    { csvHeader: 'RF Exh.Temp 750-',     label: 'RF Exhaust >750\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rfExhOver800:    { csvHeader: 'RF Exh.Temp 800-',     label: 'RF Exhaust >800\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rrExhOver700:    { csvHeader: 'RR Exh.Temp 700-',     label: 'RR Exhaust >700\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rrExhOver750:    { csvHeader: 'RR Exh.Temp 750-',     label: 'RR Exhaust >750\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
    rrExhOver800:    { csvHeader: 'RR Exh.Temp 800-',     label: 'RR Exhaust >800\u00B0C', unit: '% jendela',     decimals: 2, delta: true },
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
      // [T5.4 2026-10-08] Chart T/M Clutch Fill Time & Thermal Duty.
      // Sumber: tm_trend0.CSV (Data Type 81). Kiri = 5 seri Trg. Time (msec),
      // kanan = duty termal oli T/C (detik di atas 130/140 °C).
      // Taruh tepat setelah group-powertrain sesuai spek T5.4.
      id: 'group-tmtrend', title: 'T/M Clutch Fill Time &amp; Thermal Duty',
      subtitle: 'Waktu trigger clutch (msec) &lt;-&gt; durasi oli T/C di atas 130/140 \u00B0C (detik)',
      icon: 'fa-stopwatch', accent: '#6366f1', minParams: 1,
      series: [
        { param: 'tmTrgTimeF', axis: 'left', color: '#818cf8', type: 'line', width: 2.5 },
        { param: 'tmTrgTimeR', axis: 'left', color: '#a78bfa', type: 'line', width: 2.5 },
        { param: 'tmTrgTime1', axis: 'left', color: '#38bdf8', type: 'line', width: 1.5, dashed: true },
        { param: 'tmTrgTime2', axis: 'left', color: '#22d3ee', type: 'line', width: 1.5, dashed: true },
        { param: 'tmTrgTime3', axis: 'left', color: '#2dd4bf', type: 'line', width: 1.5, dashed: true },
        { param: 'tcOilOver130', axis: 'right', color: '#f59e0b', type: 'line', width: 2 },
        { param: 'tcOilOver140', axis: 'right', color: '#ef4444', type: 'line', width: 2 }
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
    },
    {
      // [T10 2026-10-09] CLUTCH PACK FILL TIME — HD785 (chas_trend0.CSV).
      // Kiri = 7 posisi clutch (msec). NAIK = clutch pack aus / seal bocor /
      // tekanan modulasi turun. Ini indikator keausan powertrain paling
      // langsung, jadi ia layak mendapat layar sendiri (bukan dicampur).
      // Semua threshold-nya `provisional: true` — UI wajib menandainya.
      id: 'group-hd785-clutch', title: 'Clutch Pack Fill Time',
      subtitle: 'Waktu pengisian clutch pack per posisi (msec) \u2014 keausan pack / kebocoran seal / tekanan modulasi',
      icon: 'fa-stopwatch', accent: '#8b5cf6', minParams: 1,
      series: [
        { param: 'tmFillLow',  axis: 'left', color: '#818cf8', type: 'line', width: 2 },
        { param: 'tmFillHigh', axis: 'left', color: '#a78bfa', type: 'line', width: 2 },
        { param: 'tmFillR',    axis: 'left', color: '#c084fc', type: 'line', width: 2.5 },
        { param: 'tmFill1',    axis: 'left', color: '#38bdf8', type: 'line', width: 1.5, dashed: true },
        { param: 'tmFill2',    axis: 'left', color: '#22d3ee', type: 'line', width: 1.5, dashed: true },
        { param: 'tmFill3',    axis: 'left', color: '#2dd4bf', type: 'line', width: 1.5, dashed: true },
        { param: 'tmFill4',    axis: 'left', color: '#34d399', type: 'line', width: 1.5, dashed: true }
      ]
    },
    {
      // [T10 2026-10-09] DUTY TERMAL RETARDER — HD785.
      // Durasi oli retarder di atas 140 °C (detik, DELTA per interval) diadu
      // dengan suhu retarder sesaat. Terkait SAFETY: brake fading saat
      // turunan berbeban, bukan sekadar biaya komponen.
      id: 'group-hd785-retarder', title: 'Retarder Thermal Duty',
      subtitle: 'Durasi oli retarder &gt;140 \u00B0C (detik) \u2194 suhu retarder \u2014 risiko brake fading saat turunan',
      icon: 'fa-temperature-arrow-up', accent: '#ef4444', minParams: 1,
      series: [
        { param: 'fRtdOver140',  axis: 'left',  color: '#f87171', type: 'line', width: 2.5 },
        { param: 'rRtdOver140',  axis: 'left',  color: '#fb923c', type: 'line', width: 2.5 },
        { param: 'retarderTemp', axis: 'right', color: '#fbbf24', type: 'line', width: 1.5, dashed: true }
      ]
    },
    {
      // [T10 2026-10-09] DUTY GAS BUANG PER GRUP SILINDER — HD785 (mesin V12).
      // LF = Left-Bank Front, LR = Left-Bank Rear, RF = Right-Bank Front,
      // RR = Right-Bank Rear. Perbedaan besar antar grup = injeksi / kompresi
      // tidak seimbang PADA GRUP ITU. Sensor grup rusak (DGT5KB/DGT6KB) akan
      // mem-mask kanal terkait, dan gerbang kewarasan termal menandai nilai
      // mustahil (mis. 590.649 detik pada interval 200 jam) — jadi chart ini
      // tetap jujur meski sensor bermasalah.
      id: 'group-hd785-exhaust', title: 'Exhaust Duty per Cylinder Group',
      subtitle: 'Durasi gas buang &gt;800 \u00B0C per grup silinder (detik) \u2014 deteksi ketidakseimbangan injeksi/kompresi',
      icon: 'fa-fire-flame-simple', accent: '#f97316', minParams: 1,
      series: [
        { param: 'lfExhOver800', axis: 'left', color: '#fb7185', type: 'line', width: 2 },
        { param: 'lrExhOver800', axis: 'left', color: '#f472b6', type: 'line', width: 2 },
        { param: 'rfExhOver800', axis: 'left', color: '#38bdf8', type: 'line', width: 2 },
        { param: 'rrExhOver800', axis: 'left', color: '#22d3ee', type: 'line', width: 2 }
      ]
    }
  ];

  /* -----------------------------------------------------------------------
   * 2. Threshold / batas trigger per parameter
   *    warn & crit dievaluasi terhadap nilai MAX pada satu record.
   *    mode: 'high'  -> makin besar makin bahaya (default)
   *          'low'   -> makin kecil makin bahaya
   *    Sesuai literatur standar Komatsu Shop Manual & Testing/Adjusting.
   * --------------------------------------------------------------------- */
  var THRESHOLDS = {
    blowbyMax:    { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
    coolantTemp:  { warn: 95.0, crit: 105.0, mode: 'high', label: 'Coolant Temp' },
    engOilTemp:   { warn: 105.0, crit: 115.0, mode: 'high', label: 'Engine Oil Temp' },
    hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high', label: 'Hydraulic Oil Temp' },
    ptoTempMax:   { warn: 95.0, crit: 105.0, mode: 'high', label: 'PTO Temp' },
    // CATATAN: tekanan oli MAKSIMUM yang rendah bukan indikator bahaya,
    // jadi TIDAK diberi threshold. Yang dipantau adalah tekanan MINIMUM
    // (H-Min) yang mengindikasikan kehilangan tekanan saat operasi.
    oilPressHMin: { warn: 0.25, crit: 0.18, mode: 'low',  label: 'Engine Oil Press H-Min' },
    fuelRate:     { warn: 160.0, crit: 200.0, mode: 'high', label: 'Fuel Rate' },
    // [FIX 2026-10-01] Parameter SAFETY & powertrain standar Komatsu
    brakeTemp:    { warn: 180.0, crit: 230.0, mode: 'high', label: 'Brake Temp' },
    retarderTemp: { warn: 115.0, crit: 140.0, mode: 'high', label: 'Retarder Temp' },
    // -----------------------------------------------------------------------
    // [FITUR 2026-10-16 · KALIBRASI 2026-10-16] TEKANAN REM F/R (HD785).
    // -----------------------------------------------------------------------
    // `mode:'low'` — tekanan rem yang TERLALU RENDAH = potensi kehilangan
    // daya pengereman (KESELAMATAN).
    //
    // ⚠ ANGKA LAMA 4,0 / 3,0 MPa SALAH SKALA dan membuat parameter ini MATI
    //   TOTAL, bukan sekadar "belum terkalibrasi". Data nyata HD785-J30235
    //   (200 record, berkas trend `'40'`) berkisar 19,9-24,4 MPa dengan
    //   median 20,6 — **lima kali** di atas ambang lama, sehingga 0 dari 200
    //   record pernah menyentuh warn. Parameter berbobot KESELAMATAN (15)
    //   yang tidak pernah bisa memicu alarm lebih berbahaya daripada tidak
    //   ada sama sekali: ia memberi rasa aman palsu.
    //
    // DASAR NILAI BARU (jujur — BUKAN Shop Manual):
    //   Yang dapat dipertanggungjawabkan adalah KAIDAH-nya, bukan angkanya:
    //   tekanan rem dinilai dari PENURUNAN RELATIF terhadap kondisi
    //   awal-umur, bukan nilai absolut. Dasar = median 20,6 MPa dari SATU
    //   unit (SN J30235). warn = dasar x 0,90 = 18,5 · crit = dasar x 0,80
    //   = 16,5 (dibulatkan 0,5 MPa). Pola identik `tmFill*` di bawah.
    //
    // RISIKO (MASIH TERBUKA, sama kelas dengan R5-HD):
    //   Dasar dari SATU unit. Bila unit HD785 lain memakai varian sistem rem
    //   berbeda, dasar ini TIDAK berlaku. Jalan keluar: kumpulkan trend `'40'`
    //   dari >=5 unit HD785, lalu kalibrasi ulang memakai MEDIAN antar-unit.
    // -----------------------------------------------------------------------
    fBrakePressMax:{ warn: 18.5, crit: 16.5, mode: 'low',  label: 'F Brake Press Max',
                    source: 'Kaidah penurunan relatif x0,90/0,80 · dasar median 20,6 MPa dari 1 unit (SN J30235) — BUKAN Shop Manual' },
    rBrakePressMax:{ warn: 18.5, crit: 16.5, mode: 'low',  label: 'R Brake Press Max',
                    source: 'Kaidah penurunan relatif x0,90/0,80 · dasar median 20,6 MPa dari 1 unit (SN J30235) — BUKAN Shop Manual' },
    boostMax:     { warn: 1125.1, crit: 1350.1, mode: 'high', label: 'Boost Press Max' },
    // [FIX 2026-10-15] 550/650 -> 700/800. Lihat catatan panjang di
    // `vhms-profiles.js` TH_DOZER: 550/650 dilanggar SELURUH record D375A
    // (alarm permanen). 700/800 = band duty yang ECU Komatsu sendiri hitung
    // di berkas yang sama. Ubah DI KEDUA TEMPAT bila di-tuning lagi.
    fExhTempMax:  { warn: 700.0, crit: 800.0, mode: 'high', label: 'F Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu (kolom F/R Exh.Temp 700-/800-) · dikalibrasi 2026-10-15' },
    rExhTempMax:  { warn: 700.0, crit: 800.0, mode: 'high', label: 'R Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu (kolom F/R Exh.Temp 700-/800-) · dikalibrasi 2026-10-15' },
    // [FITUR 2026-10-16] Suhu gas buang per SUDUT MANIFOLD (excavator PC2000).
    // Ambang SAMA dengan bank F/R D375A (700/800 °C): keduanya mengukur
    // besaran setara (EGT absolut di manifold) dan memakai band 700-/800-
    // dari berkas Komatsu. Sumber = KAIDAH TURUNAN, bukan Shop Manual
    // per-model — lihat catatan di TH_EXCAVATOR (js/vhms-profiles.js).
    lbfExhTempMax:{ warn: 700.0, crit: 800.0, mode: 'high', label: 'LBF Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    lbrExhTempMax:{ warn: 700.0, crit: 800.0, mode: 'high', label: 'LBR Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    rbfExhTempMax:{ warn: 700.0, crit: 800.0, mode: 'high', label: 'RBF Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    rbrExhTempMax:{ warn: 700.0, crit: 800.0, mode: 'high', label: 'RBR Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    // [FITUR 2026-10-16] Suhu EGT absolut per grup silinder — HD785 (V12).
    // Ambang SAMA (700/800 °C): besaran setara dengan bank F/R & sudut
    // excavator; memakai band duty ECU Komatsu yang sama.
    lfExhTempMax: { warn: 700.0, crit: 800.0, mode: 'high', label: 'LF Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    lrExhTempMax: { warn: 700.0, crit: 800.0, mode: 'high', label: 'LR Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    rfExhTempMax: { warn: 700.0, crit: 800.0, mode: 'high', label: 'RF Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    rrExhTempMax: { warn: 700.0, crit: 800.0, mode: 'high', label: 'RR Exhaust Temp Max',
                    source: 'Band duty ECU Komatsu 700-/800- · turunan bank F/R · dikalibrasi 2026-10-16' },
    // [FITUR 2026-10-16] Suhu oli transmisi HD785. Ambang mengikuti
    // `tcOilTempMax` (T/C Oil, 110/120 °C) — keduanya oli powertrain dengan
    // batas material serupa. USULAN, belum terkalibrasi per-model.
    tmOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high', label: 'T/M Oil Temp Max',
                    source: 'Turunan tcOilTempMax (110/120 \u00b0C) \u00b7 USULAN, belum terkalibrasi per-model' },
    tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high', label: 'T/C Oil Temp Max' },
    tmMainPressMax:{ warn: 2.2,  crit: 1.8,  mode: 'low',  label: 'TM Main Press Max' },

    // -----------------------------------------------------------------------
    // [T5.2 2026-10-08 · OEM 2026-10-09] THRESHOLD T/M TREND D375A.
    // -----------------------------------------------------------------------
    // STATUS: `provisional` DIHAPUS. Nilai kini berbasis standar service
    // Komatsu (limit trigger/fill clutch & temperatur oli T/C), bukan lagi
    // sekadar nilai awal. `source` menjelaskan asal tiap angka.
    //   tmTrgTime F/R 150 msec  — fill time arah maju/mundur (service normal)
    //   tmTrgTime 1-3 200 msec  — fill time per gigi (service normal)
    //   tcOilOver130 warn 300 s — duty oli T/C > 130 °C (warning OEM)
    //   tcOilOver140 warn  60 s — duty oli T/C > 140 °C (limit OEM)
    // CATATAN penting: `tcOilOver130` SENGAJA ber-ambang LEBIH TINGGI
    // (300/1800) daripada `tcOilOver140` (60/300) — suhu 130 °C lebih sering
    // dan lebih lama tercapai sehingga durasi "normal"-nya lebih panjang.
    // Jangan tertukar.
    // -----------------------------------------------------------------------
    // [B-4 2026-10-13] Label diselaraskan dengan PARAMS (lihat catatan di sana):
    // ini TRIGGER time (respons ECMV), bukan clutch fill time.
    tmTrgTimeF:    { warn: 150,  crit: 200,  mode: 'high', label: 'F Trigger Time',  source: 'OEM service normal trigger time' },
    tmTrgTimeR:    { warn: 150,  crit: 200,  mode: 'high', label: 'R Trigger Time',  source: 'OEM service normal trigger time' },
    tmTrgTime1:    { warn: 200,  crit: 250,  mode: 'high', label: '1st Gear Trigger Time', source: 'OEM service normal fill time' },
    tmTrgTime2:    { warn: 200,  crit: 250,  mode: 'high', label: '2nd Gear Trigger Time', source: 'OEM service normal fill time' },
    tmTrgTime3:    { warn: 200,  crit: 250,  mode: 'high', label: '3rd Gear Trigger Time', source: 'OEM service normal fill time' },
    tcOilOver130:  { warn: 300,  crit: 1800, mode: 'high', label: 'T/C Oil over 130\u00B0C', source: 'OEM T/C oil warning 130 \u00B0C (duty)' },
    tcOilOver140:  { warn: 60,   crit: 300,  mode: 'high', label: 'T/C Oil over 140\u00B0C', source: 'OEM T/C oil limit 140 \u00B0C (duty)' },
    // CATATAN: `tcOilOver120` SENGAJA TANPA THRESHOLD. Oli T/C melewati 120 °C
    // adalah hal NORMAL pada operasi dozing berat; parameter ini dipakai sebagai
    // indikator DUTY (beban termal), bukan alarm. Lihat spek T5.2.
    largePumpPress:{ warn: 20.0, crit: 15.0, mode: 'low',  label: 'Large Pump Press Max' },

    // [ADD 2026-10-19] TEKANAN POMPA HIDROLIK individual (pump1F/1R/2F/2R).
    // Sebelumnya parameter ini TIDAK punya threshold sama sekali, sehingga
    // kartu "Pump Wear" di Failure Mode Summary tampil TANPA garis warn/crit.
    //
    // ARAH: `mode:'low'` — tekanan pompa TINGGI = normal (pompa bekerja
    // melawan beban). Yang menandakan keausan pompa adalah tekanan yang
    // TURUN karena internal leakage (clearance pompa membesar).
    //
    // KALIBRASI (belum terverifikasi OEM — tandai sebagai proposal):
    //   Data PC2000-8 pada sampel menunjukkan pump pressure 33,6–40,7 MPa
    //   pada operasi normal. Ambang dipasang DI BAWAH rentang tersebut:
    //     warn 30 MPa (~12% di bawah minimum teramati)
    //     crit 25 MPa (~25% di bawah minimum teramati)
    //   Ini mencegah alarm palsu pada operasi normal, tetapi masih
    //   menangkap kecenderungan tekanan merosot akibat keausan.
    //   VERIFIKASI ke Shop Manual / spesifikasi pompa model terkait
    //   sebelum dipakai sebagai dasar keputusan maintenance.
    pump1F:        { warn: 30.0, crit: 25.0, mode: 'low', label: 'Pump 1F Press Max', source: 'PROPOSAL (kalibrasi data operasi)' },
    pump1R:        { warn: 30.0, crit: 25.0, mode: 'low', label: 'Pump 1R Press Max', source: 'PROPOSAL (kalibrasi data operasi)' },
    pump2F:        { warn: 30.0, crit: 25.0, mode: 'low', label: 'Pump 2F Press Max', source: 'PROPOSAL (kalibrasi data operasi)' },
    pump2R:        { warn: 30.0, crit: 25.0, mode: 'low', label: 'Pump 2R Press Max', source: 'PROPOSAL (kalibrasi data operasi)' },

    // -----------------------------------------------------------------------
    // [HD785 2026-10-09] THRESHOLD CHASSIS TREND — DASAR AWAL-UMUR + KAIDAH
    // SERVICE. (Judul lama "SUMBER OEM / SERVICE LIMIT" menyesatkan — lihat
    // koreksi di bawah.)
    // -----------------------------------------------------------------------
    // ⚠ STATUS JUJUR [KOREKSI 2026-10-12] — BACA SEBELUM MENGUBAH APA PUN.
    //
    // Komentar versi sebelumnya mengklaim nilai baseline di bawah adalah
    // "spesifikasi mekanis HD785-7 ... bukan sekadar observasi". **KLAIM ITU
    // TERLALU KUAT.** Penelusuran ke spek asal (`SPEK_HD785_CHASSIS_CLUTCH.md`
    // D2 & risiko R5-HD) menunjukkan angka Low 305 / High 296 / 1st 731 /
    // 2nd 686 / 3rd 388 / 4th 355 / R 908 msec berasal dari **SNAPSHOT
    // PERTAMA SATU UNIT** (SN 31991) — terbaca langsung di barisnya:
    //     ...,305,296,731,686,388,355,908,17,11,...
    // Jadi itu **dasar awal-umur satu unit**, bukan angka Shop Manual.
    //
    // Pencarian literatur resmi Komatsu (2026-10-12) TIDAK menghasilkan satu
    // pun tabel "standard value" HD785 yang dapat diakses: seluruh Shop
    // Manual (SEN01274 / TEN00694) berada di belakang pembayaran, dan laman
    // produk HD785-8 mengembalikan 404. Karena itu **tidak ada angka OEM baru
    // yang dapat dipertanggungjawabkan** untuk dimasukkan ke sini.
    //
    // YANG DAPAT DIPERTANGGUNGJAWABKAN:
    //   • KAIDAH-nya (bukan angkanya): clutch pack dinilai dari KENAIKAN
    //     RELATIF fill time terhadap kondisi awal-umur, bukan nilai absolut.
    //     warn = dasar × ~1,30 · crit = dasar × ~1,60.
    //   • Angka di bawah = dasar unit SN 31991 × 1,32/1,58, dibulatkan ke
    //     puluhan msec (≈ 1,30×/1,60×).
    //
    // RISIKO R5-HD (MASIH TERBUKA, jangan dihapus dari daftar):
    //   Dasar diambil dari SATU unit. Bila unit HD785 lain memakai varian T/M
    //   berbeda, dasar ini TIDAK berlaku untuk unit tersebut.
    //   Jalan keluar: kumpulkan `chas_trend0` dari ≥5 unit HD785, lalu
    //   kalibrasi ulang memakai MEDIAN dasar antar-unit.
    //
    // `provisional: true` tetap dihapus — bukan karena angkanya naik derajat
    // menjadi OEM, melainkan karena field `source` kini menyatakan asalnya
    // secara eksplisit dan nilainya DAPAT di-edit di halaman Pengaturan.
    //   • DUTY TERMAL = DURASI (detik) melewati temperatur peringatan OEM.
    //     Ambang berbasis "berapa lama", bukan "apakah" — melewati ambang
    //     sekali adalah normal. Warn/crit = akumulasi per interval 200 jam.
    //
    // Nilai & sumber tiap grup:
    //   tmFill*      — fill time clutch T/M (msec). OEM: service limit
    //                  +30 %/+60 % dari baseline unit-baru tiap posisi.
    //                  WARN = wear mulai terukur · CRIT = perlu overhaul.
    //   *RtdOver140  — durasi oli retarder > 140 °C (detik/interval).
    //                  OEM: warning retarder oil 120 °C, LIMIT 140 °C.
    //                  140 °C = limit, jadi durasi di atasnya = bahaya:
    //                  warn 60 s (≈1 jam pamakai berat), crit 300 s.
    //   *ExhOver800  — PERSEN WAKTU jendela dengan gas buang > 800 °C.
    //                  ⚠ [KOREKSI 2026-10-12] Komentar lama di sini menulis
    //                  "detik/interval · warn 300 s, crit 1800 s". Itu SUDAH
    //                  TIDAK BERLAKU sejak B15 (2026-10-10) mengubah satuan
    //                  ke % jendela; nilai sebenarnya di bawah = 1,0 / 8,0 %.
    //                  Komentar basi ini dibiarkan 2 hari dan berpotensi
    //                  menyesatkan siapa pun yang menyetel ulang ambang.
    //                  Dasar: 800 °C dipakai sebagai ambang alarm pelindung
    //                  valve/turbo (EGT normal maks ~700 °C pada beban penuh).
    //                  Angka 1,0/8,0 % sendiri BELUM TERKALIBRASI — lihat
    //                  `source` tiap entri.
    //   tcOilOver130/140 — duty oli torque converter (D375A, grup T/M Trend).
    //   tmTrgTime*   — trigger/fill time clutch D375A (msec); limit service
    //                  normal 150 msec (F/R) & 200 msec (per gigi).
    // -----------------------------------------------------------------------
    // `source` di bawah SENGAJA menyebut "dasar 1 unit (SN 31991)" — teks ini
    // tampil di kolom "Sumber / Asal Nilai" halaman Pengaturan, jadi operator
    // harus melihat bahwa ini BUKAN angka Shop Manual (risiko R5-HD).
    tmFillLow:     { warn: 400,  crit: 490,  mode: 'high', label: 'Low Clutch Fill Time',  source: 'Kaidah service \u00d71,32/1,58 \u00b7 dasar 305 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFillHigh:    { warn: 390,  crit: 470,  mode: 'high', label: 'High Clutch Fill Time', source: 'Kaidah service \u00d71,32/1,58 \u00b7 dasar 296 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill1:       { warn: 950,  crit: 1170, mode: 'high', label: '1st Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 731 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill2:       { warn: 890,  crit: 1100, mode: 'high', label: '2nd Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 686 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill3:       { warn: 500,  crit: 620,  mode: 'high', label: '3rd Clutch Fill Time',  source: 'Kaidah service \u00d71,29/1,60 \u00b7 dasar 388 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFill4:       { warn: 460,  crit: 570,  mode: 'high', label: '4th Clutch Fill Time',  source: 'Kaidah service \u00d71,30/1,61 \u00b7 dasar 355 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },
    tmFillR:       { warn: 1180, crit: 1450, mode: 'high', label: 'R Clutch Fill Time',    source: 'Kaidah service \u00d71,30/1,60 \u00b7 dasar 908 msec dari 1 unit (SN 31991) \u2014 BUKAN Shop Manual' },

    // Duty termal: hanya TINGKAT TERTINGGI diberi ambang. Tingkat bawah
    // (120-/130-, 700-/750-) dibiarkan TANPA ambang sebagai indikator beban
    // kerja — alasan yang sama dengan `tcOilOver120`. Melewati 120 °C pada
    // retarder saat turunan berbeban, atau 700 °C pada gas buang saat hauling
    // menanjak, adalah hal NORMAL dan tidak boleh memicu alarm.
    // 140 °C = ambang kolom pada berkas itu sendiri (`R RTD Oil T.140-`), jadi
    // TEMPERATUR-nya memang berasal dari Komatsu. Yang BELUM terkalibrasi
    // adalah DURASI yang dianggap wajar (60 s / 300 s per interval 200 jam).
    fRtdOver140:   { warn: 60,  crit: 300, mode: 'high', label: 'F Retarder Oil >140\u00B0C', source: 'Suhu 140 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 durasi 60/300 s USULAN, belum terkalibrasi' },
    rRtdOver140:   { warn: 60,  crit: 300, mode: 'high', label: 'R Retarder Oil >140\u00B0C', source: 'Suhu 140 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 durasi 60/300 s USULAN, belum terkalibrasi' },
    lfExhOver800:  { warn: 1.0, crit: 8.0, mode: 'high', label: 'LF Exhaust >800\u00B0C', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    lrExhOver800:  { warn: 1.0, crit: 8.0, mode: 'high', label: 'LR Exhaust >800\u00B0C', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    rfExhOver800:  { warn: 1.0, crit: 8.0, mode: 'high', label: 'RF Exhaust >800\u00B0C', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    rrExhOver800:  { warn: 1.0, crit: 8.0, mode: 'high', label: 'RR Exhaust >800\u00B0C', source: 'Suhu 800 \u00B0C = ambang kolom berkas (Komatsu) \u00b7 % waktu 1,0/8,0 USULAN, belum terkalibrasi' },
    // CATATAN: `Low/High/4th Trg. Time` SENGAJA TANPA AMBANG. Pada data nyata
    // nilainya hanya 3-18 msec dan nyaris tidak bergerak sepanjang 286.000 jam
    // SMR — ia mengukur respons solenoid ECMV, bukan keausan clutch pack.
    // Memberinya ambang hanya akan menghasilkan derau, bukan temuan.

    // -----------------------------------------------------------------------
    // [PC2000 2026-10-10 — T3] DUTY GAS BUANG EXCAVATOR (`chas_trend0`).
    // -----------------------------------------------------------------------
    // Untuk `lfExhOver800`/`lrExhOver800`/`rfExhOver800`/`rrExhOver800`,
    // ambang TRUCK di atas TIDAK dipakai ulang: nilainya dalam DETIK absolut
    // per jendela HD785 (~40 jam), sedangkan jendela PC2000 ~200 jam sehingga
    // detik absolut tidak sebanding. Nilai di bawah memakai PERSEN JENDELA.
    //
    // ⚠ WAJIB SAMA PERSIS dengan `TH_EXCAVATOR` di js/vhms-profiles.js.
    //   `analysis.thresholdSet` memakai objek PROFIL (TH_EXCAVATOR),
    //   sedangkan heatmap/beberapa jalur lain membaca `cfg.THRESHOLDS`. Bila
    //   hanya salah satu yang diisi, heatmap menampilkan "—" dan ranking
    //   melewati parameter itu. Dijaga test suite ("ANTI-DRIFT: nilai
    //   threshold profil SAMA dengan cfg.THRESHOLDS").
    //
    // ⚠ SATUAN = PERSEN JENDELA, bukan detik mentah. T4 (`vhms-analytics.js`)
    //   menormalkan `100 × detik / (ΔSMR × 3600)`.
    //
    // ⚠ USULAN — BELUM TERKALIBRASI LAPANGAN (R2). `source` memuat kata
    //   "USULAN" agar badge PROV muncul di halaman Pengaturan.
    lfExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'LF Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lfExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'LF Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lrExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'LR Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    lrExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'LR Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rfExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'RF Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rfExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'RF Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rrExhOver700: { warn: 5.0,  crit: 25.0, mode: 'high', label: 'RR Exhaust >700\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' },
    rrExhOver750: { warn: 3.0,  crit: 15.0, mode: 'high', label: 'RR Exhaust >750\u00B0C (% waktu)', source: 'USULAN — belum terkalibrasi' }
  };

  /* -----------------------------------------------------------------------
   * 2a. STATUS & SLA TINDAK LANJUT (halaman Portofolio / laporan)
   * ---------------------------------------------------------------------
   * [STANDARISASI 2026-10-03] SOP perusahaan: HANYA 3 level.
   * Status ditentukan dari NILAI vs THRESHOLD parameter:
   *   - nilai melewati ambang EXTREME -> "CRITICAL" (SLA 1x24 Jam)
   *   - nilai melewati ambang WARN/CRIT -> "CAUTION" (SLA 2x24 Jam)
   *   - nilai di bawah ambang warn    -> "NORMAL"   (SLA -)
   * Objek di bawah dapat disesuaikan lewat halaman Pengaturan (tab Status & SLA).
   * --------------------------------------------------------------------- */
  var FOLLOWUP_STATUS = {
    CRITICAL: { label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    CAUTION:  { label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
    NORMAL:   { label: 'Normal',   cls: 'pf-normal',   sla: '-' }
  };
  // [STANDARISASI 2026-10-03] Severity -> status (3 level).
  //   4     = Critical (melewati ambang extreme)
  //   1..3  = Caution  (melewati ambang warn/crit)
  var FOLLOWUP_PRIORITY = {
    4: { key: 'CRITICAL', label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    3: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
    2: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
    1: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' }
  };

  /** Teks verifikasi default per kelompok parameter. */
  var FOLLOWUP_VERIFY = {
    wear:     'Ambil sampel ulang; pastikan tren logam turun & kembali < ambang warning.',
    oil:      'Uji ulang kondisi oli; pastikan viskositas/TBN/oksidasi kembali dalam spesifikasi.',
    clean:    'Periksa kontaminan (Si/air/soot) turun; pastikan kebersihan oli sesuai target ISO.',
    additive: 'Pastikan aditif (Zn/P/Ca) kembali dalam rentang spesifikasi setelah ganti oli.',
    vhms:     'Uji fungsi & ukur ulang parameter; pastikan nilai kembali dalam ambang normal.'
  };
  var FOLLOWUP_REF_DEFAULT = 'Shop Manual Unit & SOP Condition Monitoring terkait.';

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
    brakeTemp:    15,   // [FIX] SAFETY — risiko kehilangan pengereman (HD Truck)
    retarderTemp: 14,   // [FIX] SAFETY — risiko fading saat turunan berbeban
    // [FITUR 2026-10-16] Tekanan rem F/R HD785 — SAFETY (daya pengereman).
    fBrakePressMax: 15,
    rBrakePressMax: 15,
    hydTempMax:   14,   // overheat hidrolik -> seal bocor, pompa aus
    boostMax:     12,   // [FIX] over-boost -> kerusakan turbo, power loss
    engOilTemp:   10,   // degradasi oli, mempercepat keausan
    tcOilTempMax: 10,   // [FIX] overheat torque converter -> slip, power loss
    coolantTemp:   9,   // overheat -> derate mesin
    fExhTempMax:   9,   // [FIX] ketidakseimbangan pembakaran
    rExhTempMax:   9,   // [FIX] ketidakseimbangan pembakaran
    ptoTempMax:    8,   // beban berlebih sistem fan/PTO
    tmMainPressMax: 8,  // [FIX] kehilangan tekanan transmisi -> slip
    largePumpPress: 7,  // [FIX] tekanan pompa utama turun
    fanPumpF:      7,   // kegagalan bertahap
    fanPumpR:      6,
    pump1F:        6,   // ketidakseimbangan tekanan pompa
    pump1R:        4,
    pump2F:        6,
    pump2R:        4,
    fuelRate:      2,   // indikator ekonomi (bukan keselamatan)
    // [T5.3 2026-10-08] Parameter T/M Trend (file tm_trend0.CSV).
    tmTrgTimeF:    8,   // clutch fill time arah maju -> keausan clutch pack
    tmTrgTimeR:    8,   // clutch fill time arah mundur
    tmTrgTime1:    6,   // waktu trigger gigi 1
    tmTrgTime2:    6,   // waktu trigger gigi 2
    tmTrgTime3:    6,   // waktu trigger gigi 3
    tcOilOver140:  9,   // duty termal TERTINGGI -> degradasi oli tercepat
    tcOilOver130:  7,   // duty termal menengah
    tcOilOver120:  0,   // tampil saja, TIDAK diskor (normal terjadi)
    // [HD785 2026-10-09] Parameter Chassis Trend (file chas_trend0.CSV).
    // Fill time = indikator keausan clutch pack yang paling langsung, jadi
    // bobotnya disetarakan `tmTrgTime*` D375A (8 utk arah, 6 utk per-gigi).
    tmFillLow:     8,
    tmFillHigh:    8,
    tmFillR:       8,
    tmFill1:       6,
    tmFill2:       6,
    tmFill3:       6,
    tmFill4:       6,
    // Duty termal retarder = SAFETY (brake fading saat turunan berbeban),
    // karena itu bobotnya mengikuti `retarderTemp` (14), bukan duty T/C (9).
    fRtdOver140:   14,
    rRtdOver140:   14,
    // Duty gas buang per grup silinder: setara `fExhTempMax`/`rExhTempMax` (9),
    // dibagi 4 grup agar satu grup bermasalah tidak langsung mendominasi.
    lfExhOver800:  7,
    lrExhOver800:  7,
    rfExhOver800:  7,
    rrExhOver800:  7,
    // [PC2000 2026-10-10 — T3] Duty gas buang tingkat 700 & 750.
    // HANYA ada pada excavator (`chas_trend0.CSV` PC2000 punya 3 tingkat).
    // Bobot MENURUN seiring ambang naik: melewati 800 °C adalah bahaya yang
    // jauh lebih besar daripada 700 °C, jadi tingkat bawah tidak boleh
    // menyamai tingkat atas — kalau sama, tiga tingkat yang mengukur hal
    // serupa akan TRIPLE COUNTING pada satu grup silinder.
    //   700 °C = beban termal tinggi (wajar saat digging berat) -> 4
    //   750 °C = mendekati batas material valve/turbo            -> 6
    lfExhOver700:  4,
    lfExhOver750:  6,
    lrExhOver700:  4,
    lrExhOver750:  6,
    rfExhOver700:  4,
    rfExhOver750:  6,
    rrExhOver700:  4,
    rrExhOver750:  6
  };

  // Pilar/kelompok parameter untuk analisis distribusi penyebab.
  var RANKING_PILLARS = {
    blowbyMax:    'ENGINE',
    oilPressHMin: 'ENGINE',
    engOilTemp:   'ENGINE',
    boostMax:     'ENGINE',
    fExhTempMax:  'ENGINE',
    rExhTempMax:  'ENGINE',
    // [FITUR 2026-10-16] Suhu gas buang per sudut manifold (excavator PC2000).
    lbfExhTempMax: 'ENGINE',
    lbrExhTempMax: 'ENGINE',
    rbfExhTempMax: 'ENGINE',
    rbrExhTempMax: 'ENGINE',
    // [FITUR 2026-10-16] Suhu EGT absolut per grup silinder (truk HD785).
    lfExhTempMax: 'ENGINE',
    lrExhTempMax: 'ENGINE',
    rfExhTempMax: 'ENGINE',
    rrExhTempMax: 'ENGINE',
    hydTempMax:   'HYDRAULIC',
    ptoTempMax:   'HYDRAULIC',
    pump1F:       'HYDRAULIC', pump1R: 'HYDRAULIC',
    pump2F:       'HYDRAULIC', pump2R: 'HYDRAULIC',
    largePumpPress: 'HYDRAULIC',
    coolantTemp:  'COOLING',
    fanPumpF:     'COOLING',
    fanPumpR:     'COOLING',
    brakeTemp:    'BRAKE',
    retarderTemp: 'BRAKE',
    // [FITUR 2026-10-16] Tekanan rem F/R HD785 -> pilar BRAKE.
    fBrakePressMax: 'BRAKE',
    rBrakePressMax: 'BRAKE',
    tcOilTempMax: 'POWERTRAIN',
    tmMainPressMax: 'POWERTRAIN',
    // [FITUR 2026-10-16] Suhu oli T/M HD785 -> pilar POWERTRAIN.
    tmOilTempMax: 'POWERTRAIN',
    // [T5.3 2026-10-08] Seluruh parameter T/M Trend masuk pilar POWERTRAIN —
    // clutch fill time & duty termal T/C keduanya komponen powertrain.
    tmTrgTimeF:   'POWERTRAIN',
    tmTrgTimeR:   'POWERTRAIN',
    tmTrgTime1:   'POWERTRAIN',
    tmTrgTime2:   'POWERTRAIN',
    tmTrgTime3:   'POWERTRAIN',
    tcOilOver120: 'POWERTRAIN',
    tcOilOver130: 'POWERTRAIN',
    tcOilOver140: 'POWERTRAIN',
    // [HD785 2026-10-09] Chassis Trend: fill time = POWERTRAIN (clutch pack),
    // duty retarder = BRAKE (keselamatan), duty gas buang = ENGINE.
    tmFillLow:    'POWERTRAIN',
    tmFillHigh:   'POWERTRAIN',
    tmFillR:      'POWERTRAIN',
    tmFill1:      'POWERTRAIN',
    tmFill2:      'POWERTRAIN',
    tmFill3:      'POWERTRAIN',
    tmFill4:      'POWERTRAIN',
    tmTrgTimeLow: 'POWERTRAIN',
    tmTrgTimeHigh:'POWERTRAIN',
    tmTrgTime4:   'POWERTRAIN',
    fRtdOver120:  'BRAKE',
    fRtdOver130:  'BRAKE',
    fRtdOver140:  'BRAKE',
    rRtdOver120:  'BRAKE',
    rRtdOver130:  'BRAKE',
    rRtdOver140:  'BRAKE',
    lfExhOver700: 'ENGINE', lfExhOver750: 'ENGINE', lfExhOver800: 'ENGINE',
    lrExhOver700: 'ENGINE', lrExhOver750: 'ENGINE', lrExhOver800: 'ENGINE',
    rfExhOver700: 'ENGINE', rfExhOver750: 'ENGINE', rfExhOver800: 'ENGINE',
    rrExhOver700: 'ENGINE', rrExhOver750: 'ENGINE', rrExhOver800: 'ENGINE',
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
    caution:  25,     // skor >= 25 -> CAUTION, di bawahnya NORMAL
    warning:  25      // alias kompatibilitas (konfigurasi lama)
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
    OTHER:     1.0,
    // [T4.3 2026-10-08] Pilar EVENT — kontribusi dari riwayat fault/alarm
    // (fault0.CSV). Nilai awal 1.0 = NETRAL terhadap pilar lain; sengaja
    // tidak dibuat dominan sampai divalidasi lapangan. Lihat README §6.2.
    EVENT:     1.0
  };

  /* =======================================================================
   * [FITUR 2026-10-15] KATALOG PILAR/KOMPARTEMEN untuk tombol pilar dinamis
   * Equipment List (Engine / Transmission / Hydraulic / Cooling / Brake).
   * =======================================================================
   * Menjadi SATU SUMBER KEBENARAN untuk:
   *   - urutan tombol pilar
   *   - label & ikon tombol
   *   - daftar kolom KPI yang ditampilkan saat pilar aktif (mengacu ke PARAMS)
   *
   * CATATAN PENTING (kejujuran data):
   *   - `pillarKey` HARUS cocok dengan nilai di RANKING_PILLARS (mis. POWERTRAIN
   *     untuk Transmission). Jangan menyalin ulang definisi pilar di tempat lain.
   *   - `kpi` berisi KEY PARAMS (bukan csvHeader). Kolom yang tidak punya data
   *     pada unit tidak akan menampilkan angka (—).
   *   - Hanya pilar yang PUNYA data di armada yang tombolnya dirender.
   *
   * [REVISI 2026-10-15 — permintaan operator]
   *   1. Kompartemen COOLING DIGABUNG ke ENGINE (satu kartu "Engine").
   *   2. Kompartemen BRAKE DIHAPUS dari daftar pilihan.
   *
   *   Penggabungan dilakukan di LAPISAN TAMPILAN lewat `pillarKeys`, BUKAN
   *   dengan mengubah `RANKING_PILLARS`. Alasannya: `RANKING_PILLARS` dipakai
   *   skoring (`RANKING_PILLAR_WEIGHTS`: ENGINE 2.0 vs COOLING 1.1), Cross
   *   Analysis, knowledge base, dan Component Life Cut. Memindahkan parameter
   *   coolant ke ENGINE di sana akan DIAM-DIAM mengubah peringkat armada —
   *   efek samping yang tidak diminta.
   *
   *   `pillarKeys` = daftar pilar RANKING yang DIKUMPULKAN ke satu entri
   *   tampilan. Bila tidak ada, dipakai `[pillarKey]`.
   *
   *   ⚠ Parameter pilar BRAKE (brakeTemp, retarderTemp, fRtdOver*, rRtdOver*)
   *   TETAP dinilai & tetap muncul pada kolom "Anomali" mode Semua serta pada
   *   peringkat — yang dihapus hanya PILIHAN kompartemennya, bukan datanya.
   * ======================================================================= */
  var PILLAR_CATALOG = [
    { pillarKey: 'ENGINE',     pillarKeys: ['ENGINE', 'COOLING'],
      label: 'Engine',       icon: 'fa-fire-flame-curved',
      kpi: ['blowbyMax', 'oilPressHMin', 'engOilTemp', 'fExhTempMax', 'rExhTempMax',
            'coolantTemp', 'fanPumpF', 'fanPumpR'] },
    { pillarKey: 'POWERTRAIN', label: 'Transmission', icon: 'fa-gears',
      kpi: ['tcOilTempMax', 'tmMainPressMax', 'tmTrgTime1', 'tmFillLow', 'tmFillHigh'] },
    { pillarKey: 'HYDRAULIC',  label: 'Hydraulic',    icon: 'fa-oil-can',
      kpi: ['hydTempMax', 'ptoTempMax', 'pump1F', 'pump1R', 'largePumpPress'] }
  ];

  /* =======================================================================
   * [REVISI 2026-10-15] PARAMETER TAMPILAN TAMBAHAN per kompartemen.
   * =======================================================================
   * Permintaan operator: "keluarkan SEMUA data yang berkaitan dengan
   * kompartemen engine/transmission/hydraulic di Equipment List".
   *
   * `RANKING_PILLARS` tidak memetakan parameter yang TIDAK dinilai (tanpa
   * ambang & tanpa bobot) — mis. `engSpeedMax`, `hydTempAve`, `oilPressMax`.
   * Parameter itu tetap INFORMATIF bagi teknisi dan harus bisa ditampilkan.
   *
   * ⚠ SENGAJA DIPISAH dari `RANKING_PILLARS`. Menambahkannya ke sana akan
   *   memasukkan parameter tak-berambang ke agregasi pilar (`byPillar`,
   *   `summarizeByPillar`, distribusi penyebab fault, Component Life Cut)
   *   sehingga `recorded` membengkak dan proporsi "X dari N terpantau" jadi
   *   MENYESATKAN. Peta di bawah HANYA untuk kolom tabel.
   *
   * Kolom dari daftar ini tidak pernah diwarnai (tidak punya ambang) —
   * `kpiCellStyle` sudah menanganinya secara alami.
   * ===================================================================== */
  var PILLAR_DISPLAY_EXTRA = {
    ENGINE: ['engSpeedMax', 'engSpeedAve', 'oilPressMax', 'oilPressMin', 'oilPressAve',
             'boostAve', 'coolantTempMin', 'engPowerMax', 'engPowerAve', 'ecoModeOn',
             'fuelRate'],
    POWERTRAIN: ['tmMainPressAve'],
    HYDRAULIC: ['hydTempAve', 'hydTempMin', 'ptoTempMin', 'autoGrsPress', 'autoGrsOn']
  };

  /**
   * Daftar pilar RANKING yang dikumpulkan ke satu entri katalog tampilan.
   * @param {object} entry entri PILLAR_CATALOG
   * @returns {string[]}
   */
  function pillarKeysOf(entry) {
    if (!entry) return [];
    if (entry.pillarKeys && entry.pillarKeys.length) return entry.pillarKeys;
    return [entry.pillarKey];
  }

  /**
   * [REVISI 2026-10-15 — permintaan operator]
   * SELURUH parameter milik sebuah kompartemen (bukan hanya 5 KPI pilihan).
   * ---------------------------------------------------------------------
   * Sumber kebenaran = `RANKING_PILLARS` (peta param -> pilar). Entri `kpi`
   * pada PILLAR_CATALOG kini berperan sebagai URUTAN PRIORITAS saja: param
   * di daftar itu tampil lebih dulu, sisanya menyusul mengikuti urutan
   * deklarasi `PARAMS` (urutan kolom berkas Komatsu — supaya mudah dibaca).
   *
   * Param TANPA definisi di `PARAMS` dibuang: tanpa label & satuan, kolomnya
   * tidak dapat ditampilkan secara jujur.
   *
   * @param {string} pillarKey pillarKey entri katalog (ENGINE/POWERTRAIN/...)
   * @returns {string[]} daftar key PARAMS
   */
  function pillarParamsOf(pillarKey) {
    var entry = null;
    for (var i = 0; i < PILLAR_CATALOG.length; i++) {
      if (PILLAR_CATALOG[i].pillarKey === pillarKey) { entry = PILLAR_CATALOG[i]; break; }
    }
    if (!entry) return [];

    var wanted = {};
    pillarKeysOf(entry).forEach(function (k) { wanted[k] = true; });

    var out = [], seen = {};
    // 1) Urutan prioritas dari katalog (kolom yang paling sering dilihat).
    (entry.kpi || []).forEach(function (k) {
      if (!PARAMS[k] || seen[k]) return;
      if (!wanted[RANKING_PILLARS[k]]) return;   // jaga konsistensi peta pilar
      seen[k] = true; out.push(k);
    });
    // 2) Sisa parameter BERNILAI-SKOR milik pilar, mengikuti urutan PARAMS.
    for (var key in PARAMS) {
      if (!Object.prototype.hasOwnProperty.call(PARAMS, key)) continue;
      if (seen[key]) continue;
      if (key === 'smr' || key === 'calendar') continue;
      if (!wanted[RANKING_PILLARS[key]]) continue;
      seen[key] = true; out.push(key);
    }
    // 3) Parameter TAMPILAN tambahan (tanpa ambang/bobot) — lihat catatan
    //    pada PILLAR_DISPLAY_EXTRA. Ditempatkan paling akhir agar kolom yang
    //    dinilai tetap berada di kiri.
    pillarKeysOf(entry).forEach(function (pk) {
      (PILLAR_DISPLAY_EXTRA[pk] || []).forEach(function (k) {
        if (!PARAMS[k] || seen[k]) return;
        seen[k] = true; out.push(k);
      });
    });
    return out;
  }

  /** Label singkat pilar dari `pillarKey` (untuk badge/kolom). */
  function pillarLabelOf(pillarKey) {
    for (var i = 0; i < PILLAR_CATALOG.length; i++) {
      if (PILLAR_CATALOG[i].pillarKey === pillarKey) return PILLAR_CATALOG[i].label;
    }
    return pillarKey || '—';
  }


  /* =======================================================================
   * 2c. [T2 2026-10-08] DATA-QUALITY GATE — PETA KODE FAULT -> PARAMETER
   * =======================================================================
   * Ketika sebuah SENSOR gagal, nilai parameter yang bergantung padanya
   * TIDAK LAYAK dipercaya. Tanpa gerbang ini, parameter dari sensor rusak
   * tetap diskor dan dapat membalik arah ranking kritikalitas.
   *
   * Sumber arti kode = kolom `Error Message` pada `fault0.CSV` itu sendiri
   * (bukan tebakan). Sentinel '*' berarti "SELURUH parameter".
   *
   * ⚠ Cakupan sengaja SEMPIT (hanya kode yang terbukti ada di data contoh)
   *   — lihat docs/STATUS_PROYEK.md §2.4 butir 1. Kode tak
   *   dikenal TIDAK mem-mask apa pun (tetap dihitung di pilar EVENT).
   * ======================================================================= */
  var ALL_PARAMS = '*';
  var FAULT_SENSOR_MAP = {
    // "Exhaust temp. sensor F failure" -> suhu gas buang bank kiri
    //
    // [HD785 2026-10-09] KODE YANG SAMA DIPAKAI DUA KELUARGA dengan nama
    // parameter berbeda: D375A menulis satu nilai per bank (`fExhTempMax`),
    // HD785 menulis DURASI per grup silinder (`lfExh*`). Karena itu kedua
    // daftar DIGABUNG dalam satu entri — mask atas parameter yang tidak ada
    // pada sebuah unit TIDAK berefek (tanpa data -> dilewati formula), jadi
    // penggabungan ini aman dan menghindari kunci objek duplikat.
    DGT5KA: { params: ['fExhTempMax'], msg: 'Exhaust temp. sensor F failure' },
    DGT5KB: { params: ['fExhTempMax', 'lfExhOver700', 'lfExhOver750', 'lfExhOver800'],
              msg: 'Exhaust temp. sensor F / LBF failure' },
    // "Exhaust temp. sensor R failure" -> suhu gas buang bank kanan
    DGT6KA: { params: ['rExhTempMax'], msg: 'Exhaust temp. sensor R failure' },
    DGT6KB: { params: ['rExhTempMax', 'rfExhOver700', 'rfExhOver750', 'rfExhOver800'],
              msg: 'Exhaust temp. sensor R / RBF failure' },
    // "Blowby pressure sensor failure" -> tekanan blowby crankcase
    DHE5KB: { params: ['blowbyMax'], msg: 'Blowby pressure sensor failure' },
    // "T/M main pressure sensor failure" -> tekanan main transmisi
    DHT3KX: { params: ['tmMainPressMax', 'tmMainPressAve'], msg: 'T/M main pressure sensor failure' },
    // "Abnormality in 24V source system (VHMS)" -> suplai daya logger
    // abnormal, sehingga SELURUH pembacaan tidak dapat dipercaya.
    DBB6KP: { params: [ALL_PARAMS], msg: 'Abnormality in 24V source system (VHMS)' },
    // Kegagalan komunikasi (CAN-NET / KOM-net) -> data bisa hilang/tertunda
    // di seluruh kanal, jadi SELURUH parameter juga ditandai.
    DBBRKR: { params: [ALL_PARAMS], msg: 'CAN-NET sys (J1939) Error' },
    DBBQKR: { params: [ALL_PARAMS], msg: 'KOM-net communication failure' },

    /* ---------------------------------------------------------------------
     * [HD785 2026-10-09] KODE SENSOR HD785-7 (dari `fault0.CSV` SN 31991).
     * -------------------------------------------------------------------
     * Arti kode dibaca APA ADANYA dari kolom `Error Message` berkas itu,
     * bukan ditebak. Pemetaan grup silinder mengikuti penamaan pesan:
     *   LBF = Left-Bank Front  -> lfExh*     LBR = Left-Bank Rear  -> lrExh*
     *   RBF = Right-Bank Front -> rfExh*     RBR = Right-Bank Rear -> rrExh*
     *
     * ⚠ HURUF BESAR/KECIL BERMAKNA. Pada berkas HD785, `DGT6KB` (huruf besar)
     *   = "Exhaust Temp. Sensor RBF Failure" sedangkan `dGT6KB` (huruf kecil
     *   di depan) = "Exhaust Temp. Sensor RBR Failure" — GRUP SILINDER YANG
     *   BERBEDA. Hal yang sama untuk `DGT5KB` (LBF) vs `dGT5KB` (LBR).
     *
     * [R2-HD 2026-10-09 — DIPERBAIKI TUNTAS] Sebelumnya kode huruf kecil
     *   SENGAJA tidak didaftarkan karena diasumsikan pencarian mask
     *   meng-UPPERCASE kode sehingga akan bertabrakan dengan kode huruf
     *   besar. ASUMSI ITU TERBUKTI SALAH: `VHMS_FAULT_PARSER` mempertahankan
     *   huruf asli (`String(code).trim()`, TANPA toUpperCase) dan
     *   `applyFaultMask()` mencocokkan `byCode[code]` secara persis
     *   (case-sensitive). Terverifikasi empiris: `DGT6KB` & `dGT6KB` menjadi
     *   kunci terpisah.
     *   => Karena itu kode huruf kecil kini DIDAFTARKAN dan BENAR mem-mask
     *      grup silinder-nya sendiri (`dGT5KB`->lrExh*, `dGT6KB`->rrExh*).
     *      Jaring pengaman gerbang kewarasan termal (T6/D9) TETAP ada sebagai
     *      lapisan kedua yang independen.
     *
     * SENGAJA TIDAK DIDAFTARKAN (tetap terhitung di pilar EVENT lewat
     * bucket UNKNOWN, tetapi tidak mem-mask apa pun):
     *   - `DHP7KA`/`DHP7KY` sensor tekanan suspensi — tidak ada di PARAMS.
     *   - `DJF1KA` sensor level bahan bakar — tidak ada di PARAMS.
     *   - `DLF1KA`/`DLF2KA`/`DLT3KA` sensor kecepatan poros transmisi —
     *     memengaruhi perhitungan clutch slip pada ECU, tetapi TIDAK
     *     memetakan satu-ke-satu ke parameter yang kita skor.
     * ------------------------------------------------------------------- */

    // "Exhaust temp. sensor LBR failure" (huruf kecil) -> grup LR (rear).
    // Grup LR/RR dipakai HD785 sebagai durasi >700/750/800 °C per grup.
    // [FITUR 2026-10-16] Sekaligus mem-mask suhu EGT absolut `lbrExhTempMax`
    // pada excavator PC2000 (sensor LBR yang sama). Mask atas param yang
    // tidak ada pada sebuah unit tidak berefek — penggabungan aman.
    dGT5KB: { params: ['lrExhOver700', 'lrExhOver750', 'lrExhOver800', 'lbrExhTempMax'],
              msg: 'Exhaust temp. sensor LBR failure (LR group)' },
    // "Exhaust temp. sensor RBR failure" (huruf kecil) -> grup RR (rear).
    dGT6KB: { params: ['rrExhOver700', 'rrExhOver750', 'rrExhOver800', 'rbrExhTempMax'],
              msg: 'Exhaust temp. sensor RBR failure (RR group)' },
    // Kode huruf kecil juga dapat memetakan bank exhaust D375A (satu nilai
    // per bank) bila unit itu memakai kode yang sama — penggabungan aman
    // (mask atas param yang tidak ada = tanpa efek).
    dGT5KA: { params: ['fExhTempMax', 'lbfExhTempMax'], msg: 'Exhaust temp. sensor F / LBF failure (lowercase)' },
    dGT6KA: { params: ['rExhTempMax', 'rbfExhTempMax'], msg: 'Exhaust temp. sensor R / RBF failure (lowercase)' },

    // "Drop in Retarder Controller Battery Direct Power Source" -> suplai
    // daya controller retarder turun, sehingga SELURUH pembacaan kanal
    // retarder (duty oli F/R) tidak layak dipercaya.
    DB13KK: { params: ['fRtdOver120', 'fRtdOver130', 'fRtdOver140',
                       'rRtdOver120', 'rRtdOver130', 'rRtdOver140'],
              msg: 'Drop in Retarder Controller Battery Direct Power Source' },

    /* =====================================================================
     * [PC2000 2026-10-10 — T6] KODE FAULT EXCAVATOR PC2000 (SN 20020).
     * =====================================================================
     * Pemetaan di bawah membuat kode fault PC2000 punya PILAR yang benar
     * (`summarizeByPillar` menurunkan pilar dari param -> RANKING_PILLARS).
     * Sebelum ini 28 kode PC2000 tidak punya entri sehingga SEMUA event-nya
     * jatuh ke bucket 'UNKNOWN' (495 dari 600 event = 82,5 %) — sebaran
     * penyebab tidak informatif dan tidak menambah bobot pilar mana pun.
     *
     * PESAN dibaca APA ADANYA dari kolom `Error Message` `fault0.CSV`
     * SN 20020, bukan ditebak.
     *
     * DUA JENIS ENTRI:
     *   (a) KEGAGALAN SENSOR -> `params` diisi parameter yang bergantung
     *       padanya, sehingga nilainya DIKECUALIKAN dari skor (gerbang
     *       kualitas data). Contoh: sensor PPC, EPC, auto-grease.
     *   (b) ALARM NILAI (mis. High Exhaust Temp, Water Overheat) -> data
     *       DIPERCAYA, jadi TIDAK boleh mem-mask param apa pun. Untuk
     *       memasukkannya ke pilar tanpa mem-mask, pakai `pillarOnly: true`.
     *
     * ⚠ `pillarOnly` adalah field BARU (lihat `summarizeByPillar` &
     *   `faultSensorLookup`). Entri dengan `pillarOnly` hanya menyumbang
     *   PILAR, tidak menyentuh gerbang kualitas data.
     * ===================================================================== */

    /* --- (b) ALARM NILAI -> pilar saja, TIDAK mem-mask --- */
    'f@BYNS': { pillarOnly: 'ENGINE', msg: 'High LBR CYL. Exhaust Temp' },
    'f@BYNR': { pillarOnly: 'ENGINE', msg: 'Very High LBR CYL. Exhaust Temp' },
    'B@BCNS': { pillarOnly: 'COOLING', msg: 'Engine Water Overheat' },
    'F@BBZL': { pillarOnly: 'ENGINE', msg: 'High Blowby Pressure' },
    '6014NX': { pillarOnly: 'HYDRAULIC', msg: 'Hydraulic Oil Filter Clogging' },
    '7@HCZL': { pillarOnly: 'HYDRAULIC', msg: 'VR2/P2F Relief Press Abnormality' },
    'DW45KA': { pillarOnly: 'BRAKE', msg: 'Swing Brake Sol. Open Circuit' },
    'DW45KB': { pillarOnly: 'BRAKE', msg: 'Swing Brake Sol. Short Circuit' },
    'DWA5KA': { pillarOnly: 'HYDRAULIC', msg: 'Auto Grease Sol.Open Circuit' },
    '8800ZG': { pillarOnly: 'HYDRAULIC', msg: 'Auto Grease Abnormality' },
    'DY2FMA': { pillarOnly: 'OTHER', msg: 'Upper Wiper Working Abnormality' },

    /* --- (a) KEGAGALAN SENSOR / ELEKTRIK -> mem-mask param terkait --- */
    // Kecepatan mesin: nilai engSpeed* tidak dapat dipercaya.
    CA115: { params: ['engSpeedMax', 'engSpeedAve'], msg: 'Eng. Ne and Backup Speed Sensor Error' },
    // EPC pompa: tekanan pompa terkait tidak dapat dipercaya.
    DXAAKA: { params: ['pump1F'], msg: 'P1F EPC Sol. Open Circuit' },
    DXABKA: { params: ['pump1R'], msg: 'P1R EPC Sol. Open Circuit' },
    DXACKA: { params: ['pump2F'], msg: 'P2F EPC Sol. Open Circuit' },
    DXADKA: { params: ['pump2R'], msg: 'P2R EPC Sol. Open Circuit' },
    dA25KP: { params: ['pump2F', 'pump2R'], msg: 'Pump2 Sens Supply Vol Low Error' },
    // Komunikasi modul pompa: HANYA pompa (bukan unit-wide) — lihat catatan
    // di KB (`DA2TMC`). Menjadikannya unit-wide akan terlalu luas.
    DA2TMC: { params: ['pump1F', 'pump1R', 'pump2F', 'pump2R'], msg: 'Pump Comm. ECM R/B Abnormality' },
    // Sensor tekanan PPC: parameter terkait tidak ada di PARAMS trend
    // (PPC hanya ada di snapshot), jadi dipetakan ke pilar lewat pillarOnly
    // agar tetap menyumbang HYDRAULIC tanpa mem-mask apa pun.
    DHS8KX: { pillarOnly: 'HYDRAULIC', msg: 'Boom Raise PPC Press.Sensor Abnormality' },
    DHS9KX: { pillarOnly: 'HYDRAULIC', msg: 'Boom Lower PPC Press.Sensor Abnormality' },
    DHS3KX: { pillarOnly: 'HYDRAULIC', msg: 'Arm Dig PPC Press. Sensor Abnormality' },
    DHSCKX: { pillarOnly: 'HYDRAULIC', msg: 'Arm Dump PPC Press. Sensor Abnormality' },
    DHS4KX: { pillarOnly: 'HYDRAULIC', msg: 'Bucket Curl PPC Press. Sensor Abnormality' },
    DHSDKX: { pillarOnly: 'HYDRAULIC', msg: 'Bucket Dump PPC Press. Sensor Abnormality' },
    DHSAKX: { pillarOnly: 'HYDRAULIC', msg: 'Swing Right PPC Press. Sensor Abnormality' },
    DHSBKX: { pillarOnly: 'HYDRAULIC', msg: 'Swing Left PPC Press. Sensor Abnormality' },
    DHPSKX: { params: ['autoGrsPress'], msg: 'Auto Grease Press Sensor Abnormality' },
    // CAN hilang di monitor = SELURUH data berisiko -> unit-wide.
    DAFRMC: { params: [ALL_PARAMS], msg: 'CAN Disconnected (Monitor Detected)' }
  };

  /* -----------------------------------------------------------------------
   * 2c-bis. [T2.2] AMBANG MASK — hanya mask bila SIGNIFIKAN.
   * ---------------------------------------------------------------------
   * Tujuan: satu "kedipan" sensor (fault sesaat) TIDAK boleh membuang
   * parameter dari penilaian.
   *
   * [KOREKSI 2026-10-12] SEBELUMNYA `activeAlwaysMasks: true` berarti
   * SETIAP event yang masih terbuka (To Time kosong) LANGSUNG mem-mask
   * parameter-nya untuk SELURUH UNIT — tanpa memandang count/durasi. Akibat
   * yang dilaporkan operator: "data masih update tetapi ada keterangan
   * SENSOR FAULT". Penyebabnya: satu event aktif ber-count 1 (mis. baris
   * `E05PKE` pada berkas contoh) menandai kolom itu selamanya, walau nilainya
   * sudah normal dan terus bergerak.
   *
   * ATURAN BARU (lebih proporsional, TETAP konservatif):
   *   Mask berlaku bila SALAH SATU terpenuhi:
   *     - count        >= minCount            (default 10), ATAU
   *     - durasi       >= minDurationSec      (default 3600 s = 1 jam), ATAU
   *     - MASIH AKTIF  DAN (count >= activeMinCount (2) ATAU durasi >=
   *       activeMinDurationSec (300 s = 5 menit)).
   *   Event aktif tetap LEBIH sensitif daripada event selesai (ambangnya
   *   lebih rendah), tetapi "kedipan" count 1 dengan durasi ~0 tidak lagi
   *   mem-mask. Setel `activeAlwaysMasks: true` HANYA bila Anda memang ingin
   *   perilaku lama (event aktif apa pun = langsung mask).
   *
   * Nilai di bawah ini PLAIN OBJECT CONFIG (dapat di-tuning, dan dibaca
   * ulang setiap kali applyFaultMask() dipanggil — bukan di-snapshot).
   * --------------------------------------------------------------------- */
  var FAULT_MASK_RULES = {
    minCount: 10,               // total Count dalam window
    minDurationSec: 3600,       // total durasi aktif dalam window (1 jam)
    // Ambang KHUSUS saat event MASIH AKTIF (To Time kosong). Lebih rendah
    // daripada ambang di atas, tetapi TIDAK nol.
    //
    // [KEJUJURAN SUMBER 2026-10-13] Kedua angka di bawah adalah **USULAN
    // TEKNIS, BELUM TERKALIBRASI** — BUKAN dari Shop Manual Komatsu dan
    // BUKAN hasil statistik populasi. Dasarnya hanya penalaran: count 1 +
    // durasi ~0 = "kedipan" yang tidak membuktikan sensor rusak (kasus yang
    // dilaporkan operator), sedangkan 2 kemunculan ATAU 5 menit menerus
    // sudah merupakan pola. Kalibrasi yang benar menuntut perbandingan
    // riwayat fault terhadap hasil penggantian sensor aktual (lihat
    // STATUS_PROYEK §5 — keputusan tim). Konsekuensi bila salah: parameter
    // IKUT/TIDAK IKUT formula skor, jadi angka ini harus ditinjau tim.
    activeMinCount: 2,          // USULAN, belum terkalibrasi
    activeMinDurationSec: 300,  // USULAN, belum terkalibrasi (5 menit)
    /** Jejak sumber agar tidak disalahsangka sebagai angka OEM. */
    source: 'activeMinCount/activeMinDurationSec = USULAN teknis, BELUM TERKALIBRASI ' +
            '(bukan Shop Manual, bukan statistik populasi). minCount/minDurationSec ' +
            'adalah ambang konservatif awal proyek, juga belum terkalibrasi.',
    // [KOMPAT] Bila true -> perilaku LAMA dipertahankan (event aktif apa pun
    // langsung mask). Default false (aturan proporsional di atas).
    activeAlwaysMasks: false
  };

  /* -----------------------------------------------------------------------
   * [PC2000 2026-10-10 — T6/D10] ALARM TURUNAN DARI SENSOR RUSAK.
   * ---------------------------------------------------------------------
   * MASALAH: beberapa kode adalah ALARM NILAI yang berasal dari sensor yang
   * mungkin RUSAK. Contoh nyata (SN 20020): `dGT5KB` = "Exhaust Temp. Sensor
   * LBR Failure" (sensor rusak) SEMENTARA `f@BYNR` = "Very High LBR CYL.
   * Exhaust Temp" (alarm nilai) berbunyi dari PEMBACAAN SENSOR YANG SAMA.
   *
   * Bila keduanya dihitung, satu sensor rusak menghasilkan skor DUA KALI:
   *   - lewat kontribusi fault (`__fault`, semua event dihitung), dan
   *   - seandainya alarm nilai ikut dinilai.
   * Ini DOUBLE COUNTING dan menggeser prioritas armada.
   *
   * ATURAN: bila sensor SUMBER terbukti rusak/mask-aktif, alarm turunannya
   * DIANGGAP TIDAK DAPAT DIPERCAYA dan dikeluarkan dari:
   *   - `eventCount` / `recurrence` / `activeCount` (faultScore),
   *   - agregasi pilar.
   * Nilainya tetap DILAPORKAN (tidak disembunyikan) lewat `suppressedDerived`
   * agar dapat diaudit.
   *
   * Format: { KODE_ALARM: [kode sensor sumber, ...] }.
   * --------------------------------------------------------------------- */
  var FAULT_DERIVED_FROM = {
    // LBR exhaust temp alarm <- sensor LBR (kiri-belakang) rusak.
    'f@BYNS': ['dGT5KB', 'DGT5KB'],
    'f@BYNR': ['dGT5KB', 'DGT5KB']
  };

  /**
   * [T2] Ekspansi FAULT_SENSOR_MAP menjadi peta param -> info fault terburuk.
   * Dipakai oleh gerbang kualitas data (vhms-validate) & agregasi pilar.
   * @returns {object} { paramKey: [{code, msg, params, wholeUnit}] }
   */
  function faultSensorLookup() {
    var out = {};
    Object.keys(FAULT_SENSOR_MAP).forEach(function (code) {
      var e = FAULT_SENSOR_MAP[code];
      // [PC2000 2026-10-10 — T6] Entri `pillarOnly` (alarm nilai) TIDAK
      // mem-mask parameter apa pun, jadi lewati di peta gerbang kualitas data.
      if (e.pillarOnly) return;
      var params = e.params || [];
      var wholeUnit = params.indexOf(ALL_PARAMS) >= 0;
      var targets = wholeUnit ? [ALL_PARAMS] : params;
      targets.forEach(function (p) {
        if (!out[p]) out[p] = [];
        out[p].push({ code: code, msg: e.msg || '', wholeUnit: wholeUnit });
      });
    });
    return out;
  }

  /** Daftar seluruh key parameter yang MUNGKIN ter-mask (tanpa '*').
   * @returns {string[]}
   */
  function faultMaskableParams() {
    var set = {};
    Object.keys(FAULT_SENSOR_MAP).forEach(function (code) {
      if (FAULT_SENSOR_MAP[code].pillarOnly) return;   // alarm nilai: tak mem-mask
      (FAULT_SENSOR_MAP[code].params || []).forEach(function (p) {
        if (p !== ALL_PARAMS) set[p] = true;
      });
    });
    return Object.keys(set);
  }

  /** Key parameter VHMS yang lebih panjang dari ini (-4) kadang berupa
   *  varian penamaan; dipakai oleh gerbang kualitas data (vhms-validate). */
  var ALL_PARAMS_SENTINEL = ALL_PARAMS;


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

  /* -----------------------------------------------------------------------
   * 5c. [HD785 2026-10-12] KOLOM TABEL LOG KHUSUS HAUL TRUCK (HD...).
   * ---------------------------------------------------------------------
   * Menerapkan KAIDAH YANG SAMA dengan TABLE_COLUMNS_DOZER (D375A): tabel
   * log mentah menampilkan parameter yang RELEVAN bagi keluarga produk itu,
   * bukan daftar generik. Truck menonjolkan SUHU PENGEREMAN (retarder/brake
   * — terkait keselamatan saat turunan berbeban), tekanan boost (turbo),
   * serta duty gas buang.
   *
   * [KOREKSI KLAIM 2026-10-13] Daftar PRIORITAS di bawah hanya memuat DUA
   * grup silinder depan (`lfExhOver800`, `rfExhOver800`) agar tabel tidak
   * melebar berlebihan — BUKAN keempat grup V12. `lrExhOver800`/
   * `rrExhOver800` tetap muncul otomatis lewat auto-append di
   * `tableColumnsFor()` bila unit itu memang punya datanya.
   *
   * STATUS pewarnaan (colored: true) memakai threshold effektif unit —
   * `MODEL_THRESHOLDS` (mis. HD785) di atas `TH_TRUCK`. Kolom yang tidak
   * punya ambang resmi (mis. `oilPressMax`) sengaja TIDAK diwarnai.
   * --------------------------------------------------------------------- */
  var TABLE_COLUMNS_TRUCK = [
    { param: 'smr',        align: 'left'  },
    { param: 'engSpeedAve', align: 'center' },
    { param: 'blowbyMax',  align: 'center', colored: true },
    { param: 'boostMax',   align: 'center', colored: true },
    { param: 'oilPressMax', align: 'center' },
    { param: 'coolantTemp', align: 'center', colored: true },
    { param: 'engOilTemp', align: 'center', colored: true },
    { param: 'hydTempMax', align: 'center', colored: true },
    { param: 'retarderTemp', align: 'center', colored: true },
    { param: 'brakeTemp',  align: 'center', colored: true },
    { param: 'fuelRate',   align: 'center', colored: true },
    { param: 'lfExhOver800', align: 'center', colored: true },
    { param: 'rfExhOver800', align: 'center', colored: true },
    { param: 'status',     align: 'center', isStatus: true }
  ];

  /* -----------------------------------------------------------------------
   * 5d. [PC2000 2026-10-12] KOLOM TABEL LOG KHUSUS EXCAVATOR (PC...).
   * ---------------------------------------------------------------------
   * Kaidah yang sama dengan DOZER/TRUCK. Excavator menonjolkan SISTEM
   * HIDROLIK yang menjadi beban utama mesin PC2000, serta duty gas buang.
   *
   * [KOREKSI KLAIM 2026-10-13] Daftar PRIORITAS hanya memuat `pump1F` &
   * `pump2F` (bukan keempat pompa) dan dua grup exhaust depan — demi lebar
   * tabel. `pump1R`/`pump2R`/`lrExhOver800`/`rrExhOver800` ikut otomatis
   * lewat auto-append di `tableColumnsFor()` bila unit punya datanya.
   *
   * CATATAN: `*ExhOver800` pada excavator bersatuan % JENDELA (dilihat dari
   * `chas_trend0.CSV`), dinormalkan oleh vhms-analytics.normalizeExhaustDuty.
   * Kolom 700/750 sengaja tidak ditampilkan agar tabel tidak melebar; nilai
   * lengkap tetap dapat dilihat pada chart grup & heatmap.
   * --------------------------------------------------------------------- */
  var TABLE_COLUMNS_EXCAVATOR = [
    { param: 'smr',        align: 'left'  },
    { param: 'engSpeedAve', align: 'center' },
    { param: 'blowbyMax',  align: 'center', colored: true },
    { param: 'oilPressHMin', align: 'center', colored: true },
    { param: 'coolantTemp', align: 'center', colored: true },
    { param: 'engOilTemp', align: 'center', colored: true },
    { param: 'hydTempMax', align: 'center', colored: true },
    { param: 'pump1F',     align: 'center' },
    { param: 'pump2F',     align: 'center' },
    { param: 'fuelRate',   align: 'center', colored: true },
    { param: 'lfExhOver800', align: 'center', colored: true },
    { param: 'rfExhOver800', align: 'center', colored: true },
    { param: 'status',     align: 'center', isStatus: true }
  ];

  /**
   * [DRY 2026-10-04 · B-4] Helper bersama: apakah sebuah parameter punya data
   * (non-null/non-NaN) pada minimal satu record sampel? Dulu didefinisikan
   * ganda sebagai fungsi lokal di tableColumnsFor() & chartGroupsFor().
   * @param {object[]} sample daftar record (sudah dibatasi)
   * @param {string} param nama kolom parameter
   */
  function _sampleHasData(sample, param) {
    for (var i = 0; i < sample.length; i++) {
      var v = sample[i][param];
      if (v !== null && v !== undefined && !isNaN(v)) return true;
    }
    return false;
  }

  /**
   * Pilih daftar kolom tabel log yang relevan untuk sebuah keluarga.
   *
   * [HD785/PC2000 2026-10-12] KAIDAH PER KELUARGA + TAMPILKAN SEMUA DATA:
   *   1) Keluarga menentukan KOLOM PRIORITAS (dipakai lebih dulu, di kiri):
   *        DOZER     -> TABLE_COLUMNS_DOZER      (exhaust per bank, T/C, blade)
   *        TRUCK     -> TABLE_COLUMNS_TRUCK      (retarder/brake, boost, exhaust grup)
   *        EXCAVATOR -> TABLE_COLUMNS_EXCAVATOR  (4 pompa hidrolik, exhaust grup)
   *        lainnya   -> TABLE_COLUMNS            (daftar umum)
   *   2) Setelah kolom prioritas, SELURUH parameter lain yang BENAR-BENAR punya
   *      data pada unit ini IKUT DITAMPILKAN (agar tidak ada data yang
   *      tersembunyi). Kolom yang kosong/absen tetap dilewati.
   *   `status` selalu dipindah ke kolom paling kanan.
   *
   * Tabel menjadi lebar sesuai isi; `.table-scroll` (CSS) menyediakan scroll
   * horizontal bila melebihi lebar panel (lihat vhms-dashboard.css
   * #table-section).
   * @param {string} familyId
   * @param {object[]} records
   * @param {object} [thresholdSet] ambang EFEKTIF unit (`analysis.thresholdSet`).
   *   Bila diberikan, penentuan `colored` memakai set ini — bukan gabungan
   *   seluruh model (lihat `_paramHasThreshold`).
   * @returns {object[]}
   */
  var TABLE_COLUMNS_BY_FAMILY = {
    DOZER:     TABLE_COLUMNS_DOZER,
    TRUCK:     TABLE_COLUMNS_TRUCK,
    EXCAVATOR: TABLE_COLUMNS_EXCAVATOR
  };

  // Parameter yang SELALU ditangani khusus (tidak ikut auto-append).
  var TABLE_PARAM_EXCLUDE = { smr: true, calendar: true };

  /**
   * Apakah sebuah parameter punya ambang? Dipakai agar kolom auto-append ikut
   * DIWARNAI bila layak, tanpa harus didaftarkan manual di tiap keluarga.
   *
   * [FIX AUDIT 2026-10-13] Dulu fungsi ini memindai SELURUH `MODEL_THRESHOLDS`
   * (semua model), sehingga kolom bisa ditandai `colored:true` untuk unit yang
   * threshold EFEKTIF-nya tidak punya ambang itu — lalu `evaluateParam()`
   * mengembalikan `null` dan sel diwarnai seperti NORMAL. Kini bila
   * `thresholdSet` unit diberikan, HANYA set itu yang dipakai (sumber
   * kebenaran yang sama dengan badge status baris). Pemindaian semua model
   * dipertahankan HANYA sebagai fallback saat pemanggil tidak tahu unitnya
   * (mis. pengujian konfigurasi) — dan di jalur render, `renderTable()` tetap
   * menolak mewarnai parameter tanpa ambang.
   * @param {string} key
   * @param {object} [thresholdSet] ambang efektif unit (profil + model)
   */
  function _paramHasThreshold(key, thresholdSet) {
    if (thresholdSet) return !!thresholdSet[key];
    if (THRESHOLDS[key]) return true;
    var mk = Object.keys(MODEL_THRESHOLDS);
    for (var i = 0; i < mk.length; i++) {
      if (MODEL_THRESHOLDS[mk[i]] && MODEL_THRESHOLDS[mk[i]][key]) return true;
    }
    return false;
  }

  function tableColumnsFor(familyId, records, thresholdSet) {
    var base = TABLE_COLUMNS_BY_FAMILY[familyId] || TABLE_COLUMNS;
    if (!records || !records.length) return base;
    /* [B-2 2026-10-13] DULU: `records.slice(0, 20)` — kolom ditentukan hanya
     * dari 20 record PERTAMA. Bila 20 baris pertama kebetulan berasal dari
     * satu jenis berkas saja (hal yang LAZIM karena record diurutkan menurut
     * SMR), seluruh kolom milik berkas lain HILANG dari tabel DAN dari ekspor
     * CSV — tanpa peringatan apa pun. Terukur pada HD785: menukar urutan
     * record menjatuhkan jumlah kolom dari 51 menjadi 16 (35 kolom lenyap,
     * termasuk seluruh kolom Clutch Fill Time).
     *
     * SEKARANG: pindai SELURUH record. Biayanya kecil dan dibatasi oleh
     * hubung-singkat `_sampleHasData` (berhenti pada nilai pertama yang ada):
     * kolom yang berisi langsung berhenti di baris pertama; hanya kolom yang
     * benar-benar kosong yang menelusuri seluruh baris. Terukur pada dataset
     * terbesar (324 record × 90 parameter): < 2 ms. */
    var sample = records;

    var out = [];
    var seen = {};
    // 1) Kolom prioritas keluarga — hanya yang punya data (kecuali smr/status).
    base.forEach(function (col) {
      if (col.isStatus) return;                       // status dipindah ke akhir
      if (col.param === 'smr' || _sampleHasData(sample, col.param)) {
        out.push(col);
        seen[col.param] = true;
      }
    });
    // 2) LENGKAPI dengan seluruh parameter PARAMS lain yang punya data,
    //    mengikuti urutan definisi PARAMS (stabil & bermakna).
    Object.keys(PARAMS).forEach(function (key) {
      if (TABLE_PARAM_EXCLUDE[key] || seen[key]) return;
      if (!_sampleHasData(sample, key)) return;
      out.push({ param: key, align: 'center', colored: _paramHasThreshold(key, thresholdSet) });
      seen[key] = true;
    });
    // 3) Selalu ada minimal satu kolom data; bila kosong, pakai daftar keluarga.
    if (out.length < 2) return base;
    // 4) Status SELALU paling kanan.
    if (base.some(function (c) { return c.isStatus; })) {
      out.push({ param: 'status', align: 'center', isStatus: true });
    }
    return out;
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
    /* [B-2 2026-10-13] DULU `records.slice(0, 20)` — BUG YANG SAMA dengan
     * `tableColumnsFor`. Bila 20 record pertama berasal dari satu jenis berkas
     * saja (lazim, karena record diurutkan menurut SMR dan satu unit dapat
     * menerima Chassis Trend + T/M Trend), SELURUH grup chart milik berkas
     * lain ikut HILANG — mis. grafik "T/M Clutch Fill Time & Thermal Duty"
     * tidak pernah muncul meski datanya ada. Pindai seluruh record;
     * `_sampleHasData` berhenti pada nilai pertama yang ada (< 2 ms terukur). */
    var sample = records;
    return CHART_GROUPS.filter(function (g) {
      var n = 0;
      g.series.forEach(function (s) { if (_sampleHasData(sample, s.param)) n++; });
      g._available = n;
      return n >= (g.minParams || 1);
    }).map(function (g) {
      // Hanya sertakan seri yang punya data
      var avail = g.series.filter(function (s) { return _sampleHasData(sample, s.param); });
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

  /* -----------------------------------------------------------------------
   * [BARU 2026-10-01] OVERRIDE THRESHOLD VHMS PER MODEL UNIT
   * ---------------------------------------------------------------------
   * Sama seperti SOS: sebagian parameter VHMS berbeda antar MODEL (mis.
   * Fuel Rate / Boost untuk HD785 vs D375A vs PC2000), sehingga ambang batas
   * TIDAK boleh disamakan. Struktur:
   *
   *   MODEL_THRESHOLDS = {
   *     'HD785':  { fuelRate: { warn: 240, crit: 280, mode: 'high' },
   *                 blowbyMax: { warn: 4.5, crit: 11 } },
   *     'D375A': { ... }
   *   }
   *
   * OVERRIDE PARSIAL: cukup tulis parameter yang berbeda; sisanya memakai
   * nilai default (base per-keluarga atau global). Bila belum ada entri model
   * -> perilaku IDENTIK dengan sebelumnya (tanpa regresi).
   * --------------------------------------------------------------------- */
  var MODEL_THRESHOLDS = {
    // =========================================================================
    // [REFERENSI 2026-10-01] Model-specific VHMS thresholds berdasarkan:
    //   - Komatsu Shop Manual spesifikasi per model
    //   - Caterpillar Performance Handbook & ET specifications
    //   - Hitachi Technical Manual specifications
    //   - Field experience mining operations
    //
    // OVERRIDE PARSIAL: hanya param yang BERBEDA dari base. Param lain → base.
    // =========================================================================

    // --- KOMATSU HD TRUCK ---
    'HD785': {
      // SAA12V140E-3: blowby lebih tinggi di unit besar (>4 kPa normal)
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      // Fuel rate HD785-7: ~80-130 L/h normal, bisa 150+ saat hauling berat
      fuelRate:     { warn: 140.0, crit: 165.0, mode: 'high' },
      // Coolant HD785: thermostat 83°C, alarm 107°C
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      // Oil press H-Min: 0.29 MPa normal idle, alarm <0.15 MPa
      oilPressHMin: { warn: 0.22, crit: 0.15, mode: 'low' },
      // Brake/retarder relevan (HD truck)
      brakeTemp:    { warn: 180.0, crit: 230.0, mode: 'high' },
      retarderTemp: { warn: 115.0, crit: 140.0, mode: 'high' }
    },

    'HD785-7': {
      // Spesifik -7: engine SAA12V140E-3B (Tier 2)
      fuelRate:     { warn: 145.0, crit: 170.0, mode: 'high' },
      boostMax:     { warn: 1200.0, crit: 1420.0, mode: 'high' }
    },

    'HD785-5': {
      // Spesifik -5: engine SA12V140-1
      blowbyMax:    { warn: 4.5, crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 135.0, crit: 160.0, mode: 'high' }
    },

    'HD465': {
      // SAA6D170E-5: 6-cylinder 23.15L
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 90.0,  crit: 115.0, mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      oilPressHMin: { warn: 0.25, crit: 0.18, mode: 'low' },
      brakeTemp:    { warn: 180.0, crit: 230.0, mode: 'high' },
      retarderTemp: { warn: 115.0, crit: 140.0, mode: 'high' }
    },

    'HD465-7': {
      fuelRate:     { warn: 95.0,  crit: 120.0, mode: 'high' },
      boostMax:     { warn: 1125.1, crit: 1350.1, mode: 'high' }
    },

    'HD1500': {
      // SDA12V160 / QSK50: 12-cylinder 50L
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 220.0, crit: 260.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' },
      oilPressHMin: { warn: 0.22, crit: 0.15, mode: 'low' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' },
      retarderTemp: { warn: 120.0, crit: 145.0, mode: 'high' }
    },

    'HD1500-8': {
      fuelRate:     { warn: 230.0, crit: 275.0, mode: 'high' },
      boostMax:     { warn: 1300.0, crit: 1550.0, mode: 'high' }
    },

    'HM400': {
      // Articulated hauler SAA6D140E-5
      blowbyMax:    { warn: 4.0,  crit: 9.0,  mode: 'high' },
      fuelRate:     { warn: 70.0,  crit: 90.0,  mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      retarderTemp: { warn: 115.0, crit: 135.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'HM300': {
      // SAA6D125E-5
      blowbyMax:    { warn: 3.5,  crit: 8.0,  mode: 'high' },
      fuelRate:     { warn: 50.0,  crit: 65.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      retarderTemp: { warn: 115.0, crit: 135.0, mode: 'high' }
    },

    // --- KOMATSU EXCAVATOR ---
    'PC2000': {
      // SAA12V140E-3: excavator, blowby threshold sama dgn truck
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      fuelRate:     { warn: 165.0, crit: 195.0, mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      // Hydraulic temp: excavator beban hidrolik sangat tinggi
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' },
      ptoTempMax:   { warn: 95.0, crit: 105.0, mode: 'high' },
      // [B14 2026-10-10 — OPSI A] Pin satuan B10 DIHAPUS.
      // Sebelumnya keempat kunci `*ExhOver800` di-pin ke PERSEN di sini
      // untuk menambal `cfg.THRESHOLDS` yang masih DETIK. Setelah B14,
      // `cfg.THRESHOLDS` dan `TH_TRUCK` sama-sama PERSEN — pin ini tidak
      // lagi menambal apa pun, hanya risiko drift. Nilai persen kini dari
      // SATU sumber: TH_EXCAVATOR.
      lfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LF Exhaust >800\u00B0C (% waktu)' },
      lrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LR Exhaust >800\u00B0C (% waktu)' },
      rfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RF Exhaust >800\u00B0C (% waktu)' },
      rrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RR Exhaust >800\u00B0C (% waktu)' }
    },

    'PC2000-8': {
      fuelRate:     { warn: 170.0, crit: 200.0, mode: 'high' },
      boostMax:     { warn: 1200.0, crit: 1420.0, mode: 'high' },
      // [B14] Lihat catatan pada PC2000 — pin satuan dihapus.
      lfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LF Exhaust >800\u00B0C (% waktu)' },
      lrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LR Exhaust >800\u00B0C (% waktu)' },
      rfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RF Exhaust >800\u00B0C (% waktu)' },
      rrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RR Exhaust >800\u00B0C (% waktu)' }
    },

    'PC1250': {
      // SAA6D170E-5
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 115.0, crit: 140.0, mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' },
      // [B14] Lihat catatan pada PC2000 — pin satuan dihapus.
      lfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LF Exhaust >800\u00B0C (% waktu)' },
      lrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LR Exhaust >800\u00B0C (% waktu)' },
      rfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RF Exhaust >800\u00B0C (% waktu)' },
      rrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RR Exhaust >800\u00B0C (% waktu)' }
    },

    'PC1250-8': {
      fuelRate:     { warn: 120.0, crit: 145.0, mode: 'high' },
      boostMax:     { warn: 1150.0, crit: 1380.0, mode: 'high' },
      // [B14] Lihat catatan pada PC2000 — pin satuan dihapus.
      lfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LF Exhaust >800\u00B0C (% waktu)' },
      lrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'LR Exhaust >800\u00B0C (% waktu)' },
      rfExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RF Exhaust >800\u00B0C (% waktu)' },
      rrExhOver800: { warn: 1.0, crit: 8.0, mode: 'high', label: 'RR Exhaust >800\u00B0C (% waktu)' }
    },

    'PC3000': {
      // QSK50 Cummins: blowby karakteristik berbeda
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 200.0, crit: 240.0, mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      hydTempMax:   { warn: 88.0, crit: 98.0,  mode: 'high' }
    },

    'PC4000': {
      // SDA16V160 / QSK60 Cummins
      blowbyMax:    { warn: 6.5,  crit: 15.0, mode: 'high' },
      fuelRate:     { warn: 260.0, crit: 310.0, mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      hydTempMax:   { warn: 88.0, crit: 98.0,  mode: 'high' }
    },

    'PC800': {
      // SAA6D140E-5
      blowbyMax:    { warn: 4.0,  crit: 9.0,  mode: 'high' },
      fuelRate:     { warn: 75.0,  crit: 95.0,  mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'PC400': {
      // SAA6D125E-5
      blowbyMax:    { warn: 3.5,  crit: 8.0,  mode: 'high' },
      fuelRate:     { warn: 45.0,  crit: 60.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'PC300': {
      // SAA6D114E-3
      blowbyMax:    { warn: 3.0,  crit: 7.0,  mode: 'high' },
      fuelRate:     { warn: 35.0,  crit: 48.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'PC200': {
      // SAA6D107E-1
      blowbyMax:    { warn: 2.5,  crit: 6.0,  mode: 'high' },
      fuelRate:     { warn: 22.0,  crit: 32.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 102.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    // --- KOMATSU DOZER ---
    'D375A': {
      // SAA6D170E-5: dozer, beban tinggi terus-menerus
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      fuelRate:     { warn: 100.0, crit: 130.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' },
      // T/C temp relevan (dozer)
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      // TM main press (dozer power shift: normal 2.5-3.2 MPa)
      tmMainPressMax:{ warn: 2.2, crit: 1.8, mode: 'low' },
      // Exhaust temp (D375A bank F/R) — [FIX 2026-10-15] 550/650 -> 700/800,
      // band duty ECU Komatsu. Override model ini MENIMPA TH_DOZER, jadi
      // membiarkannya 550/650 akan mengembalikan alarm permanen khusus D375A.
      fExhTempMax:  { warn: 700.0, crit: 800.0, mode: 'high' },
      rExhTempMax:  { warn: 700.0, crit: 800.0, mode: 'high' },
      largePumpPress:{ warn: 20.0, crit: 15.0, mode: 'low' }
    },

    'D375A-6': {
      fuelRate:     { warn: 105.0, crit: 135.0, mode: 'high' },
      boostMax:     { warn: 1150.0, crit: 1380.0, mode: 'high' }
    },

    'D275A': {
      // SAA6D140E-5
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 75.0,  crit: 95.0,  mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      tmMainPressMax:{ warn: 2.2, crit: 1.8, mode: 'low' }
    },

    'D155A': {
      // SAA6D140E-5
      blowbyMax:    { warn: 4.0,  crit: 9.0,  mode: 'high' },
      fuelRate:     { warn: 55.0,  crit: 70.0,  mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      tmMainPressMax:{ warn: 2.2, crit: 1.8, mode: 'low' }
    },

    'D475A': {
      // SAA12V140E-3
      blowbyMax:    { warn: 5.5,  crit: 13.0, mode: 'high' },
      fuelRate:     { warn: 150.0, crit: 190.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      tmMainPressMax:{ warn: 2.2, crit: 1.8, mode: 'low' }
    },

    'D85ESS': {
      // SAA6D125E-5
      blowbyMax:    { warn: 3.5,  crit: 8.0,  mode: 'high' },
      fuelRate:     { warn: 35.0,  crit: 48.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' }
    },

    'D65': {
      // SAA6D114E-3
      blowbyMax:    { warn: 3.0,  crit: 7.0,  mode: 'high' },
      fuelRate:     { warn: 25.0,  crit: 35.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' }
    },

    // --- KOMATSU MOTOR GRADER & WHEEL LOADER ---
    'GD825': {
      // SAA6D140E-5
      blowbyMax:    { warn: 4.0,  crit: 9.0,  mode: 'high' },
      fuelRate:     { warn: 45.0,  crit: 60.0,  mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      tmMainPressMax:{ warn: 2.0, crit: 1.5, mode: 'low' }
    },

    'GD705': {
      // SAA6D114E-3
      blowbyMax:    { warn: 3.0,  crit: 7.0,  mode: 'high' },
      fuelRate:     { warn: 30.0,  crit: 42.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' }
    },

    'WA600': {
      // SAA6D170E-5
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 75.0,  crit: 95.0,  mode: 'high' },
      coolantTemp:  { warn: 96.0, crit: 104.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'WA800': {
      // SAA12V140E-3
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      fuelRate:     { warn: 120.0, crit: 155.0, mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'WA900': {
      blowbyMax:    { warn: 5.5,  crit: 13.0, mode: 'high' },
      fuelRate:     { warn: 140.0, crit: 180.0, mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'WA500': {
      // SAA6D140E-5
      blowbyMax:    { warn: 4.0,  crit: 9.0,  mode: 'high' },
      fuelRate:     { warn: 50.0,  crit: 65.0,  mode: 'high' },
      coolantTemp:  { warn: 95.0, crit: 103.0, mode: 'high' },
      tcOilTempMax: { warn: 110.0, crit: 120.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    // --- CATERPILLAR HD TRUCK ---
    'CAT 785': {
      // 3512B/C: fuel rate ~100-180 L/h
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      fuelRate:     { warn: 155.0, crit: 180.0, mode: 'high' },
      coolantTemp:  { warn: 99.0, crit: 107.0, mode: 'high' },
      engOilTemp:   { warn: 110.0, crit: 120.0, mode: 'high' },
      oilPressHMin: { warn: 0.20, crit: 0.14, mode: 'low' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' },
      retarderTemp: { warn: 120.0, crit: 145.0, mode: 'high' }
    },

    'CAT 789': {
      // 3516B: fuel rate ~120-200 L/h
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 175.0, crit: 210.0, mode: 'high' },
      coolantTemp:  { warn: 99.0, crit: 107.0, mode: 'high' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' }
    },

    'CAT 777': {
      // 3508 / C32 ACERT
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 100.0, crit: 130.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' },
      brakeTemp:    { warn: 185.0, crit: 235.0, mode: 'high' },
      retarderTemp: { warn: 118.0, crit: 142.0, mode: 'high' }
    },

    'CAT 793': {
      // 3516B/E
      blowbyMax:    { warn: 6.5,  crit: 15.0, mode: 'high' },
      fuelRate:     { warn: 210.0, crit: 250.0, mode: 'high' },
      coolantTemp:  { warn: 99.0, crit: 107.0, mode: 'high' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' }
    },

    // --- CATERPILLAR EXCAVATOR ---
    'CAT 390': {
      // C18 ACERT: fuel rate ~40-80 L/h
      blowbyMax:    { warn: 3.5,  crit: 8.0,  mode: 'high' },
      fuelRate:     { warn: 70.0,  crit: 90.0,  mode: 'high' },
      hydTempMax:   { warn: 90.0,  crit: 100.0, mode: 'high' }
    },

    'CAT 349': {
      // C13 ACERT
      blowbyMax:    { warn: 3.0,  crit: 7.0,  mode: 'high' },
      fuelRate:     { warn: 40.0,  crit: 55.0,  mode: 'high' },
      hydTempMax:   { warn: 90.0,  crit: 100.0, mode: 'high' }
    },

    'CAT 374': {
      // C15 ACERT
      blowbyMax:    { warn: 3.5,  crit: 8.0,  mode: 'high' },
      fuelRate:     { warn: 55.0,  crit: 72.0,  mode: 'high' },
      hydTempMax:   { warn: 90.0,  crit: 100.0, mode: 'high' }
    },

    // --- CATERPILLAR DOZER ---
    'CAT D10': {
      // C27 ACERT: beban dozer tinggi
      blowbyMax:    { warn: 5.0,  crit: 12.0, mode: 'high' },
      fuelRate:     { warn: 100.0, crit: 130.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' }
    },

    'CAT D11': {
      // C32 ACERT
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 140.0, crit: 180.0, mode: 'high' },
      coolantTemp:  { warn: 98.0, crit: 106.0, mode: 'high' }
    },

    'CAT D9': {
      // C18 ACERT
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 75.0,  crit: 95.0,  mode: 'high' },
      coolantTemp:  { warn: 97.0, crit: 105.0, mode: 'high' }
    },

    // --- HITACHI ---
    'EX3600': {
      // QSK60 Cummins
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 200.0, crit: 240.0, mode: 'high' },
      hydTempMax:   { warn: 88.0, crit: 98.0,  mode: 'high' }
    },

    'EX2600': {
      // QSK50 Cummins
      blowbyMax:    { warn: 5.5,  crit: 13.0, mode: 'high' },
      fuelRate:     { warn: 160.0, crit: 195.0, mode: 'high' },
      hydTempMax:   { warn: 88.0, crit: 98.0,  mode: 'high' }
    },

    'EX1200': {
      // QSK23 Cummins
      blowbyMax:    { warn: 4.5,  crit: 10.0, mode: 'high' },
      fuelRate:     { warn: 90.0,  crit: 115.0, mode: 'high' },
      hydTempMax:   { warn: 90.0, crit: 100.0, mode: 'high' }
    },

    'EH4000': {
      // QSK78 Cummins
      blowbyMax:    { warn: 6.0,  crit: 14.0, mode: 'high' },
      fuelRate:     { warn: 220.0, crit: 260.0, mode: 'high' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' }
    },

    'EH5000': {
      // QSK78 Cummins / MTU
      blowbyMax:    { warn: 6.5,  crit: 15.0, mode: 'high' },
      fuelRate:     { warn: 250.0, crit: 300.0, mode: 'high' },
      brakeTemp:    { warn: 190.0, crit: 240.0, mode: 'high' }
    }
  };

  function normModel(m) {
    if (_mm.normModel) return _mm.normModel(m);
    return String(m == null ? '' : m).toUpperCase().replace(/\s+/g, ' ').trim();
  }

  function listModelKeys() {
    return Object.keys(MODEL_THRESHOLDS);
  }

  /** Cocokkan nama model bebas ke kunci MODEL_THRESHOLDS (exact lalu substring). */
  function matchModelKey(model, keys) {
    if (_mm.matchModelKey) return _mm.matchModelKey(model, keys);
    var m = normModel(model);
    if (!m || !keys || !keys.length) return null;
    for (var i = 0; i < keys.length; i++) {
      if (normModel(keys[i]) === m) return keys[i];
    }
    var best = null;
    for (var j = 0; j < keys.length; j++) {
      var k = normModel(keys[j]);
      if (!k) continue;
      if (m.indexOf(k) !== -1 || k.indexOf(m) !== -1) {
        if (best === null || k.length > normModel(best).length) best = keys[j];
      }
    }
    return best;
  }

  /** Daftar kunci model yang cocok, urut umum -> spesifik. */
  function matchModelCandidateKeys(model) {
    if (_mm.matchModelCandidateKeys) return _mm.matchModelCandidateKeys(model, Object.keys(MODEL_THRESHOLDS));
    var m = normModel(model);
    var keys = Object.keys(MODEL_THRESHOLDS);
    if (!m || !keys.length) return [];
    var hits = [];
    for (var i = 0; i < keys.length; i++) {
      var k = normModel(keys[i]);
      if (!k) continue;
      if (m === k || m.indexOf(k) !== -1 || k.indexOf(m) !== -1) hits.push(keys[i]);
    }
    hits.sort(function (a, b) { return normModel(a).length - normModel(b).length; });
    return hits;
  }

  /** Kumpulkan override {paramKey:{...}} untuk suatu model. */
  function modelOverride(model) {
    var out = {};
    matchModelCandidateKeys(model).forEach(function (mk) {
      var set = MODEL_THRESHOLDS[mk];
      if (!set) return;
      Object.keys(set).forEach(function (pk) {
        out[pk] = Object.assign(out[pk] || {}, set[pk]);
      });
    });
    return out;
  }

  /** Apakah ada override untuk model ini? */
  function hasModelOverrides(model) {
    return matchModelCandidateKeys(model).length > 0;
  }

  /**
   * Threshold efektif VHMS untuk (base, model). `base` = skema keluarga
   * (atau THRESHOLDS global). Model opsional; tanpa override -> base apa
   * adanya (referensi sama, tanpa regresi).
   */
  function thresholdsForModel(base, model) {
    base = base || THRESHOLDS || {};
    if (!model || !hasModelOverrides(model)) return base;
    var ov = modelOverride(model);
    var merged = {};
    Object.keys(base).forEach(function (pk) {
      merged[pk] = ov[pk] ? Object.assign({}, base[pk], ov[pk]) : base[pk];
    });
    Object.keys(ov).forEach(function (pk) {
      if (!merged[pk]) merged[pk] = Object.assign({}, ov[pk]);
    });
    return merged;
  }

  /* -----------------------------------------------------------------------
   * Status display helpers (VHMS = 3 tingkat)
   * ---------------------------------------------------------------------
   * [REVISI 2026-09-30] Nama status VHMS diselaraskan dengan gaya SOS:
   *   NORMAL   -> "Normal"
   *   CAUTION  -> "Caution"
   *   CRITICAL -> "Critical"
   * [STANDARISASI 2026-10-03] Kunci internal SAMA DENGAN label (3 level).
   * Kunci lama WARNING/MONITOR/EXTREME tetap dikenali lewat STATUS_ALIAS.
   */
  var STATUS_LABELS = { 'NORMAL': 'Normal', 'CAUTION': 'Caution', 'CRITICAL': 'Critical' };
  /** Alias kunci lama -> kunci kanonik 3 level. */
  var STATUS_ALIAS = { 'WARNING': 'CAUTION', 'MONITOR': 'CAUTION', 'EXTREME': 'CRITICAL' };
  /** Normalisasi kunci status apa pun ke NORMAL/CAUTION/CRITICAL. */
  function normalizeStatus(key) {
    var k = String(key || '').toUpperCase();
    if (STATUS_ALIAS[k]) k = STATUS_ALIAS[k];
    return STATUS_LABELS[k] ? k : 'NORMAL';
  }
  /** Label tampilan dari kunci status VHMS. */
  function statusLabelOf(key) {
    return STATUS_LABELS[normalizeStatus(key)] || 'Normal';
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_CONFIG = {
    PARAMS: PARAMS,
    SMR_SCALE: SMR_SCALE,
    STATUS_LABELS: STATUS_LABELS,
    STATUS_ALIAS: STATUS_ALIAS,
    statusLabelOf: statusLabelOf,
    normalizeStatus: normalizeStatus,
    THRESHOLDS: THRESHOLDS,
    // [BARU 2026-10-01] Override threshold per MODEL unit (VHMS).
    MODEL_THRESHOLDS: MODEL_THRESHOLDS,
    listModelKeys: listModelKeys,
    matchModelKey: matchModelKey,
    matchModelCandidateKeys: matchModelCandidateKeys,
    modelOverride: modelOverride,
    hasModelOverrides: hasModelOverrides,
    thresholdsForModel: thresholdsForModel,
    normModel: normModel,
    FOLLOWUP_PRIORITY: FOLLOWUP_PRIORITY,
    FOLLOWUP_STATUS: FOLLOWUP_STATUS,
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
    TABLE_COLUMNS_TRUCK: TABLE_COLUMNS_TRUCK,
    TABLE_COLUMNS_EXCAVATOR: TABLE_COLUMNS_EXCAVATOR,
    TABLE_COLUMNS_BY_FAMILY: TABLE_COLUMNS_BY_FAMILY,
    tableColumnsFor: tableColumnsFor,
    NULL_SENTINELS: NULL_SENTINELS,
    RANKING_WEIGHTS: RANKING_WEIGHTS,
    RANKING_PILLARS: RANKING_PILLARS,
    RANKING_AXES: RANKING_AXES,
    RANKING_BANDS: RANKING_BANDS,
    RANKING_PILLAR_WEIGHTS: RANKING_PILLAR_WEIGHTS,
    // [FITUR 2026-10-15] Katalog pilar untuk tombol pilar dinamis Equipment List.
    PILLAR_CATALOG: PILLAR_CATALOG,
    pillarLabelOf: pillarLabelOf,
    pillarKeysOf: pillarKeysOf,
    pillarParamsOf: pillarParamsOf,
    PILLAR_DISPLAY_EXTRA: PILLAR_DISPLAY_EXTRA,
    // [T2 2026-10-08] Gerbang kualitas data dari riwayat fault.
    FAULT_SENSOR_MAP: FAULT_SENSOR_MAP,
    FAULT_MASK_RULES: FAULT_MASK_RULES,
    // [PC2000 2026-10-10 — T6/D10] Alarm turunan dari sensor rusak.
    FAULT_DERIVED_FROM: FAULT_DERIVED_FROM,
    ALL_PARAMS_SENTINEL: ALL_PARAMS_SENTINEL,
    faultSensorLookup: faultSensorLookup,
    faultMaskableParams: faultMaskableParams,
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

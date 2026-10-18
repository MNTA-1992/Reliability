/* =========================================================================
 * vhms-knowledge.js
 * -------------------------------------------------------------------------
 * [POIN 2] Basis pengetahuan (knowledge base) OFFLINE untuk rekomendasi
 * tindakan preventive maintenance.
 *
 * PRINSIP:
 *   - 100% offline: TIDAK ada panggilan ke internet saat runtime.
 *   - Tanpa file tambahan: seluruh pengetahuan tertanam di modul ini.
 *   - Rekomendasi dipilih secara KONTEKSTUAL berdasarkan:
 *       parameter  +  tingkat keparahan (WARNING/CRITICAL)  +
 *       keluarga produk (EXCAVATOR/TRUCK/DOZER)  +  arah tren.
 *   - Hasil di-cache di memori sesi saja (tidak ditulis ke disk).
 *
 * Struktur tiap entri parameter:
 *   {
 *     KB.ENGINE.blowbyMax = {
 *       system: 'Engine',
 *       refs: ['Komatsu Shop Manual — Engine, Bab Blowby Inspection', ...],
 *       warn:     { likely: [...penyebab...], actions: [...tindakan...] },
 *       critical: { likely: [...], actions: [...], escalate: '...' }
 *     }
 *   }
 *
 * Catatan: teks tindakan bersifat panduan umum industri & struktur manual
 * Komatsu. BUKAN kutipan resmi; teknisi tetap mengacu SOP & shop manual.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Helper pembentuk entri
   * --------------------------------------------------------------------- */
  function entry(system, refs, warn, crit) {
    return {
      system: system,
      refs: refs || [],
      warn: warn || { likely: [], actions: [] },
      critical: crit || { likely: [], actions: [] }
    };
  }

  /* -----------------------------------------------------------------------
   * 1. KNOWLEDGE BASE — dikelompokkan per kompartemen
   * --------------------------------------------------------------------- */
  var KB = {

    ENGINE: {
      blowbyMax: entry(
        'Engine',
        ['Komatsu Shop Manual — Engine: Blowby Inspection',
         'Komatsu Technical Bulletin — Piston Ring / Cylinder Liner Wear'],
        {
          likely: ['Keausan awal piston ring', 'Filter udara mulai tersumbat', 'Tekanan crankcase sedikit naik saat beban tinggi'],
          actions: ['Lakukan Blowby Test konfirmasi di lapangan (alat manometer).',
                    'Periksa & bersihkan/ganti elemen air cleaner.',
                    'Catat tren blowby vs SMR untuk evaluasi berkala.',
                    'Cross-check SOS Engine: apakah Fe/Cr (ring/liner) atau Soot naik bersamaan.']
        },
        {
          likely: ['Keausan signifikan piston ring / cylinder liner',
                   'Kebocoran kompresi ke crankcase',
                   'Risiko blow-by berlebih → penurunan tenaga & konsumsi oli naik'],
          actions: ['Blowby Test konfirmasi — bandingkan dengan spesifikasi manual.',
                    'Inspeksi end-gap piston ring & keausan liner (borescope).',
                    'Uji kompresi per silinder.',
                    'Periksa kondisi turbocharger & sistem pernapasan crankcase (breather).',
                    'Cross-check SOS Engine: Fe/Cr (ring/liner aus), Soot (pembakaran), Fuel% (dilution).',
                    'Siapkan rencana overhaul bila melewati limit manual.'],
          escalate: 'Hentikan operasi berat, jadwalkan inspeksi mesin oleh mekanik senior.'
        }
      ),
      oilPressHMin: entry(
        'Engine',
        ['Komatsu Shop Manual — Lubrication System',
         'Komatsu Technical Bulletin — Oil Pressure Diagnostics'],
        {
          likely: ['Level oli mesin rendah', 'Filter oli mulai klog', 'Sensor tekanan perlu kalibrasi'],
          actions: ['Periksa level oli mesin; tambah bila kurang.',
                    'Periksa jadwal & kondisi filter oli.',
                    'Verifikasi pembacaan sensor/switch tekanan oli.',
                    'Cross-check SOS Engine: Fe/Cu/Pb (bearing aus) & Water% (emulsi menurunkan pelumasan).']
        },
        {
          likely: ['Kehilangan tekanan oli saat operasi',
                   'Pompa oli melemah / relief valve bermasalah',
                   'Kontaminasi / viskositas oli tidak sesuai'],
          actions: ['STOP mesin bila tekanan benar-benar rendah — risiko seize.',
                    'Periksa level & kondisi oli (viskositas, kontaminasi).',
                    'Uji pompa oli dan relief valve.',
                    'Ganti filter oli & periksa adanya serpihan logam.',
                    'Lakukan analisis oli (oil sampling).'],
          escalate: 'Jangan operasikan unit sebelum tekanan oli terbukti normal.'
        }
      ),
      engOilTemp: entry(
        'Engine',
        ['Komatsu Shop Manual — Cooling & Lubrication',
         'Komatsu Technical Bulletin — Oil Temperature Limits'],
        {
          likely: ['Beban operasi tinggi berkepanjangan', 'Oil cooler mulai kotor', 'Level oli kurang'],
          actions: ['Periksa kebersihan oil cooler mesin.', 'Cek level & kondisi oli.', 'Verifikasi sensor suhu oli.',
                    'Cross-check SOS Engine: Oxidation & Viskositas (panas mempercepat degradasi oli).']
        },
        {
          likely: ['Overheat oli → degradasi pelumasan', 'Oil cooler tersumbat', 'Sistem pendingin bermasalah'],
          actions: ['Bersihkan oil cooler & radiator.',
                    'Cek kerja thermostat & sirkulasi coolant.',
                    'Analisis sampel oli untuk degradasi.',
                    'Kurangi beban operasi sementara hingga suhu normal.'],
          escalate: 'Hindari operasi terus-menerus pada suhu di atas limit manual.'
        }
      ),
      boostMax: entry(
        'Engine',
        ['Komatsu Shop Manual — Turbocharger System'],
        {
          likely: ['Kebocoran jalur intake/charge air', 'Wastegate mulai tidak akurat', 'Filter udara mulai kotor'],
          actions: ['Periksa klem & selang charge air.', 'Cek kebersihan air cleaner.', 'Verifikasi sensor boost.',
                    'Cross-check SOS Engine: Fe/Ni (turbo wear) & Soot (kualitas pembakaran).']
        },
        {
          likely: ['Over-boost → risiko kerusakan turbo', 'Wastegate macet', 'Sensor MAP bermasalah'],
          actions: ['Periksa wastegate & aktuator.', 'Inspeksi turbocharger (end-play, kebocoran oli).',
                    'Verifikasi sensor tekanan boost.',
                    'Cross-check SOS Engine: Ni (turbo bearing), Fe/Cr (valve/liner) & Fuel% (pembakaran).']
        }
      ),
      // [D375A] Suhu gas buang per bank (kiri/kanan). Selisih besar antar bank
      // = indikasi injektor / kompresi tidak seimbang pada sisi tsb.
      fExhTempMax: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (D375A)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban operasi tinggi / dozing berat', 'Injektor sisi kiri mulai tidak seimbang', 'Sensor EGT perlu verifikasi'],
          actions: ['Bandingkan suhu bank F vs R — selisih wajar umumnya < 50 °C.',
                    'Periksa kebersihan air cleaner & jalur intake.',
                    'Verifikasi pembacaan sensor EGT bank kiri.']
        },
        {
          likely: ['Overheat gas buang → risiko valve/turbo', 'Injektor kiri tidak bekerja optimal',
                   'Kebocoran/keterlambatan sistem bahan bakar'],
          actions: ['Uji injektor & timing sisi kiri.', 'Inspeksi kondisi valve & turbocharger.',
                    'Periksa sistem bahan bakar (filter, kebocoran).',
                    'Kurangi beban operasi sementara.'],
          escalate: 'Hindari operasi berbeban berat hingga suhu gas buang kembali normal.'
        }
      ),
      rExhTempMax: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (D375A)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban operasi tinggi / dozing berat', 'Injektor sisi kanan mulai tidak seimbang', 'Sensor EGT perlu verifikasi'],
          actions: ['Bandingkan suhu bank R vs F (deteksi ketidakseimbangan).',
                    'Periksa kebersihan air cleaner & jalur intake.',
                    'Verifikasi pembacaan sensor EGT bank kanan.']
        },
        {
          likely: ['Overheat gas buang → risiko valve/turbo', 'Injektor kanan tidak bekerja optimal',
                   'Kebocoran/keterlambatan sistem bahan bakar'],
          actions: ['Uji injektor & timing sisi kanan.', 'Inspeksi kondisi valve & turbocharger.',
                    'Periksa sistem bahan bakar (filter, kebocoran).',
                    'Kurangi beban operasi sementara.'],
          escalate: 'Hindari operasi berbeban berat hingga suhu gas buang kembali normal.'
        }
      ),
      fuelRate: entry(
        'Engine',
        ['Komatsu Shop Manual — Fuel System',
         'Komatsu Technical Bulletin — Fuel Efficiency'],
        {
          likely: ['Beban operasi tinggi', 'Filter bahan bakar mulai kotor', 'Gaya operasi tidak efisien'],
          actions: ['Periksa konsumsi vs target operasi.', 'Ganti filter bahan bakar bila perlu.',
                    'Evaluasi metode kerja operator (idle berlebih, dsb.).',
                    'Cross-check SOS Engine: Fuel% (fuel dilution ke oli) & Soot (pembakaran tidak optimal).']
        },
        {
          likely: ['Konsumsi BBM abnormal', 'Injektor tidak efisien', 'Sistem bahan bakar bermasalah'],
          actions: ['Uji injektor & timing.', 'Periksa kebocoran jalur bahan bakar.',
                    'Analisis pola operasi (payload, jarak, grade).',
                    'Lakukan kalibrasi sistem bahan bakar.']
        }
      ),
      /* -----------------------------------------------------------------
       * [T11 2026-10-09] DUTY GAS BUANG PER GRUP SILINDER — HD785 (V12).
       * -----------------------------------------------------------------
       * Mesin SAA12V140E3 dibagi 4 grup:
       *   LF = Left-Bank Front    LR = Left-Bank Rear
       *   RF = Right-Bank Front   RR = Right-Bank Rear
       * `XxExhOver800` = DURASI (detik) suhu grup itu di atas 800 \\u00b0C
       * selama SATU INTERVAL snapshot \\u2014 ukuran beban termal per grup.
       *
       * Untuk D375A, dua bank ditulis sebagai `fExhTempMax`/`rExhTempMax`
       * (satu nilai per bank). HD785 menulis DURASI per grup \\u2014 dua hal
       * berbeda, jangan disamakan.
       *
       * \\u26a0 WAJIB: VERIFIKASI SENSOR SEBELUM MENINDAKLANJUTI.
       *   Kode fault `DGT5KB`/`DGT6KB` (LBF/RBF) mem-mask kanal LF/RF.
       *   [R2-HD 2026-10-09] Kode huruf kecil `dGT5KB`/`dGT6KB` (LBR/RBR) kini
       *   JUGA terdaftar dan mem-mask kanal LR/RR secara BENAR — pencarian
       *   mask terbukti case-sensitive, jadi tidak ada tabrakan nama.
       *   Gerbang kewarasan termal (nilai > 5 % dari durasi interval) TETAP
       *   menjadi jaring pengaman KEDUA yang independen dari FAULT_SENSOR_MAP.
       *   Nilai seperti 590.649 detik pada interval 200 jam adalah MUSTAHIL
       *   secara fisik dan berarti sensor, bukan mesin.
       * ----------------------------------------------------------------- */
      lfExhOver800: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (HD785)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban hauling menanjak pada grup LF', 'Injektor grup LF mulai tidak seimbang',
                   'Sensor EGT grup LF perlu verifikasi'],
          actions: ['VERIFIKASI SENSOR lebih dulu — cek fault `DGT5KB` (LBF Failure). Bila ada, perbaiki sensor dahulu.',
                    'Bandingkan durasi LF vs LR vs RF vs RR — selisih besar menandakan grup bermasalah.',
                    'Periksa kebersihan air cleaner & jalur intake.']
        },
        {
          likely: ['Overheat gas buang grup LF → risiko valve/turbo pada grup itu',
                   'Injektor grup LF tidak bekerja optimal',
                   'Atau: SENSOR grup LF RUSAK — verifikasi dahulu'],
          actions: ['Periksa fault `DGT5KB`/`DGT5KF` — bila sensor rusak, ganti sebelum analisis lanjut.',
                    'Uji injektor & timing grup LF.',
                    'Inspeksi valve & turbocharger sisi kiri.',
                    'Kurangi beban operasi sementara.'],
          escalate: 'Pastikan sensor VALID sebelum memutuskan pembongkaran mesin.'
        }
      ),
      lrExhOver800: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (HD785)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban hauling pada grup LR', 'Injektor grup LR mulai tidak seimbang'],
          actions: ['VERIFIKASI SENSOR \\u2014 cek fault `dGT5KB` (LBR Failure). Kode ini mem-mask kanal LR otomatis (R2-HD diperbaiki).',
                    'Bandingkan durasi LR vs grup lain.',
                    'Periksa sistem bahan bakar grup LR.']
        },
        {
          likely: ['Overheat gas buang grup LR',
                   'Injektor grup LR tidak optimal',
                   'Atau: SENSOR grup LR RUSAK (nilai > 5 % durasi interval = mustahil)'],
          actions: ['Periksa fault `dGT5KB` — bila sensor rusak, data LR otomatis ter-mask; ganti sebelum analisis lanjut.',
                    'Uji injektor & timing grup LR.',
                    'Inspeksi valve & turbocharger sisi kiri belakang.'],
          escalate: 'Konfirmasi status mask kanal LR (fault `dGT5KB`) sebelum menilai pembakaran.'
        }
      ),
      rfExhOver800: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (HD785)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban hauling menanjak pada grup RF', 'Injektor grup RF mulai tidak seimbang'],
          actions: ['VERIFIKASI SENSOR \\u2014 cek fault `DGT6KB` (RBF Failure). Kode ini SERING muncul berulang (ribuan kali pada unit contoh).',
                    'Bandingkan durasi RF vs grup lain.',
                    'Periksa kebersihan air cleaner.']
        },
        {
          likely: ['Overheat gas buang grup RF',
                   'Injektor grup RF tidak optimal',
                   'Atau: SENSOR grup RF RUSAK \\u2014 `DGT6KB` sering berulang hingga snapshot terakhir'],
          actions: ['Periksa & GANTI sensor grup RF — kode `DGT6KB` mem-mask kanal ini otomatis, jadi data mentahnya tidak dipakai menilai pembakaran.',
                    'Setelah sensor valid, uji injektor & timing grup RF.',
                    'Inspeksi valve & turbocharger sisi kanan.'],
          escalate: 'Prioritaskan verifikasi sensor \\u2014 kanal RF paling sering ter-mask pada data contoh.'
        }
      ),
      rrExhOver800: entry(
        'Engine',
        ['Komatsu Shop Manual — Exhaust Temperature (HD785)',
         'Komatsu Technical Bulletin — Exhaust Gas Temperature Monitoring'],
        {
          likely: ['Beban hauling pada grup RR', 'Injektor grup RR mulai tidak seimbang'],
          actions: ['VERIFIKASI SENSOR \\u2014 cek fault `dGT6KB` (RBR Failure). Kode ini mem-mask kanal RR otomatis (R2-HD diperbaiki).',
                    'Bandingkan durasi RR vs grup lain.']
        },
        {
          likely: ['Overheat gas buang grup RR',
                   'Injektor grup RR tidak optimal',
                   'Atau: SENSOR grup RR RUSAK \\u2014 pada unit contoh nilainya 590.649 detik pada interval 200 jam (81,9 %), MUSTAHIL secara fisik'],
          actions: ['Periksa fault `dGT6KB` \\u2014 bila sensor rusak, data RR otomatis ter-mask (sekaligus gerbang kewarasan termal menandai 24 temuan pada unit contoh).',
                    'Ganti/verifikasi sensor grup RR sebelum analisis lanjut.',
                    'Setelah sensor valid, uji injektor & timing grup RR.'],
          escalate: 'Nilai mustahil = masalah SENSOR. Jangan tindak lanjuti sebagai masalah mesin.'
        }
      )
    },

    HYDRAULIC: {
      hydTempMax: entry(
        'Hydraulic',
        ['Komatsu Shop Manual — Hydraulic System',
         'Komatsu Technical Bulletin — Hydraulic Oil Temperature'],
        {
          likely: ['Hydraulic oil cooler mulai kotor', 'Beban sirkuit hidrolik tinggi', 'Level oli hidrolik kurang'],
          actions: ['Bersihkan sirip hydraulic oil cooler.',
                    'Periksa kerja bypass & thermostat valve.',
                    'Cek level & kondisi oli hidrolik (viskositas).',
                    'Cross-check SOS Hydraulic: Fe/Cu (pompa/bushing aus) & Viskositas (degradasi oli).']
        },
        {
          likely: ['Overheat hidrolik → seal bocor & pompa aus', 'Oil cooler tersumbat berat', 'Sirkulasi terhambat'],
          actions: ['Bersihkan/debuil hydraulic cooler secara menyeluruh.',
                    'Periksa relief valve & setting tekanan.',
                    'Ambil sampel oli hidrolik (uji kontaminasi/viskositas).',
                    'Periksa kondisi pompa hidrolik.'],
          escalate: 'Kurangi beban hidrolik; hindari operasi berkelanjutan pada suhu kritis.'
        }
      ),
      pump1F: entry('Hydraulic', ['Komatsu Shop Manual — Hydraulic Pump'],
        { likely: ['Perbedaan tekanan antar pompa', 'Kebocoran internal mulai terjadi'],
          actions: ['Ukur & bandingkan tekanan antar pompa.', 'Periksa kondisi hose & fitting.'] },
        { likely: ['Ketidakseimbangan tekanan pompa signifikan', 'Keausan pompa'],
          actions: ['Uji performa pompa hidrolik.', 'Periksa servo & main relief valve.'] }),
      pump1R: entry('Hydraulic', ['Komatsu Shop Manual — Hydraulic Pump'],
        { likely: ['Variasi tekanan pompa'], actions: ['Bandingkan tekanan antar sirkuit.', 'Periksa kebocoran fitting.'] },
        { likely: ['Keausan pompa / valve'], actions: ['Uji pompa & relief valve.'] }),
      pump2F: entry('Hydraulic', ['Komatsu Shop Manual — Hydraulic Pump'],
        { likely: ['Perbedaan tekanan antar pompa'], actions: ['Ukur tekanan pompa 2F vs 1F.', 'Periksa kebocoran internal.'] },
        { likely: ['Ketidakseimbangan pompa'], actions: ['Uji performa & setting pompa.'] }),
      pump2R: entry('Hydraulic', ['Komatsu Shop Manual — Hydraulic Pump'],
        { likely: ['Variasi tekanan pompa'], actions: ['Bandingkan tekanan antar sirkuit.'] },
        { likely: ['Keausan pompa / valve'], actions: ['Uji pompa & relief valve.'] })
    },

    COOLING: {
      coolantTemp: entry(
        'Cooling',
        ['Komatsu Shop Manual — Cooling System',
         'Komatsu Technical Bulletin — Overheating Prevention'],
        {
          likely: ['Radiator mulai kotor', 'Level coolant kurang', 'Beban/ambient tinggi'],
          actions: ['Periksa level coolant & kebocoran radiator.',
                    'Cek putaran fan drive & kondisi belt.',
                    'Uji kerja thermostat.',
                    'Cross-check SOS Engine: Water% & Na/K/B (indikasi kebocoran coolant ke oli).']
        },
        {
          likely: ['Overheat → derate mesin & risiko kerusakan', 'Radiator tersumbat', 'Kegagalan pompa air'],
          actions: ['Bersihkan/debuil radiator & aftercooler.',
                    'Uji pompa air & thermostat.',
                    'Cek tekanan sistem pendingin (pressure test).',
                    'Periksa kondisi fan drive & viscous coupling.'],
          escalate: 'Turunkan beban mesin segera; jangan operasikan pada suhu kritis berkelanjutan.'
        }
      ),
      atmosAve: entry('Cooling', ['Komatsu Shop Manual — Ambient/Sensor'],
        { likely: ['Kondisi lingkungan (altitude/cuaca)'], actions: ['Verifikasi sensor tekanan atmosfer.', 'Catat kondisi lingkungan.'] },
        { likely: ['Pembacaan sensor tidak wajar'], actions: ['Periksa/kalibrasi sensor barometrik.'] }),
      ambientMax: entry('Cooling', ['Environment'],
        { likely: ['Suhu lingkungan tinggi'], actions: ['Sesuaikan beban operasi terhadap kondisi lingkungan.'] },
        { likely: ['Suhu ekstrem'], actions: ['Pantau parameter thermal lain terhadap suhu ambient.'] })
    },

    FANPTO: {
      fanPumpF: entry('Fan Drive', ['Komatsu Shop Manual — Fan Drive'],
        { likely: ['Beban pompa fan meningkat'], actions: ['Periksa kondisi pompa fan & sirkuit.', 'Cek kipas & coupling.'] },
        { likely: ['Kegagalan bertahap pompa fan'], actions: ['Uji pompa fan & relief.', 'Periksa kebocoran sistem.'] }),
      fanPumpR: entry('Fan Drive', ['Komatsu Shop Manual — Fan Drive'],
        { likely: ['Beban pompa fan meningkat'], actions: ['Periksa pompa fan return.'] },
        { likely: ['Kegagalan bertahap'], actions: ['Uji pompa fan & valve.'] }),
      ptoTempMax: entry(
        'Fan Drive & PTO',
        ['Komatsu Shop Manual — PTO / Torque Converter'],
        { likely: ['Beban berlebih sistem PTO/fan'], actions: ['Periksa sirkulasi pendinginan pada unit PTO.', 'Cek beban pompa fan berlebih.'] },
        { likely: ['Overheat PTO / torque converter', 'Sistem pendinginan PTO terganggu'],
          actions: ['Periksa aliran & suhu sistem PTO.', 'Cek kondisi torque converter (Dozer).', 'Periksa level & kondisi oli transmisi terkait.'],
          escalate: 'Hindari pembebanan PTO berlebih hingga suhu normal.' }
      )
    },

    POWERTRAIN: {
      // [D375A] Suhu oli torque converter. Overheat => degradasi oli, seal
      // mengeras, dan slip berlebih (kehilangan tenaga ke blade).
      tcOilTempMax: entry(
        'Torque Converter',
        ['Komatsu Shop Manual — Torque Converter / Power Train (D375A)',
         'Komatsu Technical Bulletin — Torque Converter Oil Temperature'],
        {
          likely: ['Beban dozing berat berkepanjangan', 'Cooler oli torque converter mulai kotor',
                   'Level oli transmisi kurang'],
          actions: ['Periksa level & kondisi oli torque converter.',
                    'Bersihkan cooler oli transmisi / powertrain.',
                    'Verifikasi pembacaan sensor suhu oli T/C.']
        },
        {
          likely: ['Overheat torque converter → slip berlebih', 'Degradasi oli (viskositas turun)',
                   'Gangguan pendinginan sistem powertrain'],
          actions: ['Hentikan pembebanan berat, biarkan sistem mendingin.',
                    'Ambil sampel oli & uji kontaminasi/viskositas.',
                    'Periksa cooler, hose, dan sirkulasi oli T/C.',
                    'Uji stall speed & tekanan torque converter.'],
          escalate: 'Batasi operasi dozing berat hingga suhu oli T/C normal & diperiksa.'
        }
      ),
      // Tekanan main transmisi (TM). Terlalu RENDAH => tekanan hilang / slip.
      tmMainPressMax: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission / Torque Main Pressure (D375A)'],
        {
          likely: ['Tekanan main transmisi sedikit menurun', 'Filter transmisi mulai kotor', 'Sensor perlu verifikasi'],
          actions: ['Periksa level & kondisi oli transmisi.',
                    'Periksa filter & jadwal penggantian oli transmisi.',
                    'Verifikasi pembacaan pressure sensor dengan manometer.']
        },
        {
          likely: ['Kehilangan tekanan main transmisi → slip & panas berlebih',
                   'Pompa transmisi melemah / relief valve bermasalah',
                   'Kebocoran internal sirkuit transmisi'],
          actions: ['Uji tekanan main dengan manometer terhadap spesifikasi manual.',
                    'Periksa relief valve & regulator tekanan.',
                    'Inspeksi kebocoran pada sirkuit/valve body.',
                    'Evaluasi kondisi pompa transmisi.'],
          escalate: 'Hentikan operasi bila tekanan turun drastis — risiko kerusakan transmisi.'
        }
      ),
      largePumpPress: entry(
        'Hydraulic',
        ['Komatsu Shop Manual — Implement Hydraulic Pump (D375A)'],
        {
          likely: ['Keausan awal pompa hidrolik utama', 'Filter hidrolik mulai kotor', 'Setting main relief perlu dicek'],
          actions: ['Periksa filter & kondisi oli hidrolik.',
                    'Ukur tekanan pompa utama dengan manometer.',
                    'Verifikasi kerja main relief valve.']
        },
        {
          likely: ['Tekanan pompa hidrolik turun → blade/ripper lemah',
                   'Keausan pompa hidrolik utama'],
          actions: ['Uji performa pompa hidrolik & bandingkan dengan spesifikasi.',
                    'Periksa main relief valve & setting.',
                    'Ambil sampel oli hidrolik (uji kontaminasi).',
                    'Evaluasi kebutuhan repair/replace pompa.'],
          escalate: 'Hindari pembebanan blade berlebih hingga tekanan normal.'
        }
      ),
      /* -----------------------------------------------------------------
       * [T11 2026-10-09] CLUTCH PACK FILL TIME — HD785 (chas_trend0.CSV).
       * -----------------------------------------------------------------
       * `tmFillX` = waktu (msec) yang dibutuhkan clutch pack untuk terisi
       * penuh, PER POSISI. Ini indikator keausan powertrain PALING LANGSUNG
       * pada haul truck: saat pack aus, seal mengeras, atau tekanan modulasi
       * turun, oli butuh waktu lebih lama mengisi pack.
       *
       * ⚠ WAJIB DIINGAT SAAT MEMBACA:
       *   - Nilai absolut BERBEDA ANTAR POSISI pada unit sehat (Low ~305 msec
       *     vs R ~908 msec). Karena itu yang bermakna adalah KENAIKAN relatif
       *     terhadap dasar awal-umur unit itu sendiri — bukan satu angka sama
       *     untuk semua posisi.
       *   - `tmFillX` (waktu PENGISIAN pack) BERBEDA dari `tmTrgTimeX`
       *     (waktu TRIGGER solenoid ECMV, hanya belasan msec). Jangan tertukar.
       *   - Threshold masih `provisional` (diturunkan dari 1 unit). Jangan
       *     memicu work order sebelum dikonfirmasi tim maintenance.
       * TODO: satukan 7 entri di bawah bila UI sudah mendukung rujukan bersama
       *       (saat ini ditulis eksplisit agar jelas & tidak berbagi objek).
       * ----------------------------------------------------------------- */
      tmFillLow: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)',
         'Komatsu Technical Bulletin — Transmission Clutch Wear Monitoring'],
        {
          likely: ['Keausan awal clutch pack posisi Low',
                   'Tekanan modulasi clutch sedikit menurun',
                   'Seal piston clutch mulai mengeras'],
          actions: ['Bandingkan dengan nilai DASAR awal-umur unit ini (bukan angka mutlak).',
                    'Periksa tekanan main transmisi & jadwal ganti oli T/M.',
                    'Cross-check matriks clutch_slip: apakah posisi Low mulai masuk area keparahan tinggi.']
        },
        {
          likely: ['Clutch pack posisi Low aus / seal bocor',
                   'Kebocoran internal sirkuit clutch',
                   'Filter oli T/M tersumbat berulang'],
          actions: ['Ambil sampel oli T/M — cari serpihan & uji viskositas.',
                    'Periksa filter oli T/M (fault 15B0NX T/M Oil Filter Clogged).',
                    'Uji tekanan clutch per posisi terhadap spesifikasi manual.',
                    'Jadwalkan inspeksi clutch pack bila fill time terus memanjang.'],
          escalate: 'Hentikan pembebanan berat bila fill time melewati batas kritis — risiko slip & panas berlebih.'
        }
      ),
      tmFillHigh: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)'],
        {
          likely: ['Keausan awal clutch pack posisi High',
                   'Tekanan modulasi clutch sedikit menurun',
                   'Variasi wajar antar-interval operasi'],
          actions: ['Bandingkan dengan DASAR awal-umur unit (bukan angka mutlak).',
                    'Periksa tekanan main transmisi.',
                    'Catat: pada data nyata posisi High bisa TURUN — bukan selalu naik.']
        },
        {
          likely: ['Clutch pack posisi High aus', 'Kebocoran internal sirkuit clutch',
                   'Filter oli T/M tersumbat'],
          actions: ['Ambil sampel oli T/M (serpihan & viskositas).',
                    'Periksa filter oli T/M.',
                    'Uji tekanan clutch posisi High terhadap spesifikasi.'],
          escalate: 'Batasi operasi sampai penyebab fill time abnormal dipastikan.'
        }
      ),
      tmFill1: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)'],
        {
          likely: ['Keausan awal clutch pack gigi 1', 'Tekanan modulasi clutch menurun',
                   'Seal piston clutch mulai mengeras'],
          actions: ['Bandingkan dengan DASAR awal-umur unit.',
                    'Cross-check matriks clutch_slip — posisi 1st adalah yang PALING SERING menumpuk kejadian slip berat.',
                    'Periksa tekanan main & jadwal ganti oli T/M.']
        },
        {
          likely: ['Clutch pack gigi 1 aus / slip berlebih',
                   'Kaitan dengan fault 15K0MW "1st Clutch Slipping"',
                   'Kaitan dengan fault 15F7KM "TM clutch disk Abuse (Front)"',
                   'Filter oli T/M tersumbat (15B0NX)'],
          actions: ['Ambil sampel oli T/M — cari serpihan clutch & uji viskositas.',
                    'Periksa filter oli T/M.',
                    'Inspeksi clutch pack gigi 1 (pack paling terbebani saat start berbeban).',
                    'Evaluasi gaya operasi operator (start berbeban penuh).'],
          escalate: 'Prioritaskan inspeksi transmisi — slip gigi 1 memperburuk seluruh powertrain.'
        }
      ),
      tmFill2: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)'],
        {
          likely: ['Keausan awal clutch pack gigi 2', 'Tekanan modulasi clutch menurun',
                   'Variasi wajar antar-interval'],
          actions: ['Bandingkan dengan DASAR awal-umur unit.',
                    'Periksa tekanan main transmisi & filter oli T/M.',
                    'Cross-check matriks clutch_slip posisi 2nd.']
        },
        {
          likely: ['Clutch pack gigi 2 aus', 'Kebocoran internal sirkuit clutch gigi 2',
                   'Filter oli T/M tersumbat'],
          actions: ['Ambil sampel oli T/M.', 'Periksa filter oli T/M.',
                    'Uji tekanan clutch gigi 2 terhadap spesifikasi.'],
          escalate: 'Jadwalkan inspeksi transmisi bila disertai slip (clutch_slip area tinggi).'
        }
      ),
      tmFill3: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)'],
        {
          likely: ['Keausan awal clutch pack gigi 3', 'Tekanan modulasi clutch menurun',
                   'Variasi wajar antar-interval'],
          actions: ['Bandingkan dengan DASAR awal-umur unit.',
                    'Periksa tekanan main transmisi & filter oli T/M.']
        },
        {
          likely: ['Clutch pack gigi 3 aus', 'Kebocoran internal sirkuit clutch gigi 3',
                   'Filter oli T/M tersumbat'],
          actions: ['Ambil sampel oli T/M.', 'Periksa filter oli T/M.',
                    'Uji tekanan clutch gigi 3 terhadap spesifikasi.'],
          escalate: 'Jadwalkan inspeksi transmisi bila disertai slip.'
        }
      ),
      tmFill4: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)'],
        {
          likely: ['Keausan awal clutch pack gigi 4', 'Tekanan modulasi clutch menurun',
                   'Variasi wajar antar-interval'],
          actions: ['Bandingkan dengan DASAR awal-umur unit.',
                    'Periksa tekanan main transmisi & filter oli T/M.',
                    'Catatan: pada matriks thermal, posisi 4rd justru mencatat duty termal tertinggi kedua.']
        },
        {
          likely: ['Clutch pack gigi 4 aus', 'Kebocoran internal sirkuit clutch gigi 4',
                   'Filter oli T/M tersumbat'],
          actions: ['Ambil sampel oli T/M.', 'Periksa filter oli T/M.',
                    'Uji tekanan clutch gigi 4 terhadap spesifikasi.'],
          escalate: 'Jadwalkan inspeksi transmisi bila disertai slip atau duty termal tinggi.'
        }
      ),
      tmFillR: entry(
        'Transmission',
        ['Komatsu Shop Manual — Transmission Clutch Fill Time (HD785)',
         'Komatsu Technical Bulletin — Transmission Clutch Wear Monitoring'],
        {
          likely: ['Keausan awal clutch pack posisi R (mundur)',
                   'Tekanan modulasi clutch menurun',
                   'Seal piston clutch mulai mengeras'],
          actions: ['Bandingkan dengan DASAR awal-umur unit (R ~908 msec pada unit sehat — jangan dipakai angka Low).',
                    'Periksa tekanan main transmisi & filter oli T/M.',
                    'Cross-check fault DDTNKA "R Clutch Fill Switch circuit Disconnect" bila berulang.']
        },
        {
          likely: ['Clutch pack posisi R aus / seal bocor',
                   'Kebocoran internal sirkuit clutch R',
                   'Filter oli T/M tersumbat berulang (15B0NX)'],
          actions: ['Ambil sampel oli T/M — serpihan & viskositas.',
                    'Periksa filter oli T/M.',
                    'Uji tekanan clutch posisi R terhadap spesifikasi.',
                    'Inspeksi switch pengisian clutch R (DDTNKA).'],
          escalate: 'Batasi operasi mundur berbeban berat hingga fill time kembali normal.'
        }
      )
    },

    BRAKE: {
      brakeTemp: entry(
        'Brake & Retarder',
        ['Komatsu Shop Manual — Brake System (HD)',
         'Komatsu Technical Bulletin — Retarder & Brake Temperature'],
        {
          likely: ['Penggunaan retarder/rem berkepanjangan', 'Pendinginan brake mulai terganggu'],
          actions: ['Evaluasi cara operasi turunan (gunakan retarder dengan benar).',
                    'Periksa aliran pendingin brake (oil-cooled).',
                    'Cek kondisi brake lining.']
        },
        {
          likely: ['Overheat brake → fade & risiko kehilangan pengereman',
                   'Kegagalan pendinginan brake', 'Beban berlebih saat turunan'],
          actions: ['Berhenti di area aman, biarkan brake mendingin.',
                    'Periksa sistem pendinginan brake & level oli.',
                    'Inspeksi lining/disc & seal.',
                    'Tinjau ulang prosedur operasi turunan.'],
          escalate: 'Prioritas keselamatan: jangan lanjutkan turunan berbeban sebelum brake normal.'
        }
      ),
      retarderTemp: entry(
        'Brake & Retarder',
        ['Komatsu Shop Manual — Retarder System (HD)'],
        {
          likely: ['Penggunaan retarder intensif', 'Pendinginan retarder mulai kurang optimal'],
          actions: ['Periksa level & kondisi oli retarder.', 'Cek kerja heat exchanger retarder.']
        },
        {
          likely: ['Overheat retarder', 'Gangguan pendinginan retarder'],
          actions: ['Periksa sirkuit pendingin retarder & pompa.', 'Cek kondisi oli & filter.', 'Evaluasi pola pengoperasian turunan.'],
          escalate: 'Batasi penggunaan retarder hingga sistem dingin & diperiksa.'
        }
      ),
      /* -----------------------------------------------------------------
       * [T11 2026-10-09] DUTY TERMAL RETARDER — HD785 (chas_trend0.CSV).
       * -----------------------------------------------------------------
       * `fRtdOver140`/`rRtdOver140` = DURASI (detik) oli retarder berada di
       * atas 140 \u00b0C selama SATU INTERVAL snapshot. Ini ukuran BEBAN
       * pengereman kumulatif per interval, bukan suhu sesaat.
       *
       * \u26a0 Dua hal yang wajib diingat:
       *   1. Nilainya DELTA PER INTERVAL \u2014 JANGAN dibaca sebagai akumulasi
       *      seumur hidup, dan JANGAN ditafsirkan lewat `slope`.
       *   2. Melewati 120/130 \u00b0C saat turunan berbeban adalah NORMAL dan
       *      tidak diberi ambang. Hanya tingkat 140 \u00b0C yang dinilai.
       *
       * Bobot ranking-nya 14 (setara `retarderTemp`), LEBIH TINGGI dari duty
       * T/C, karena brake fading saat turunan berbeban adalah risiko
       * KESELAMATAN \u2014 bukan sekadar biaya komponen.
       * ----------------------------------------------------------------- */
      fRtdOver140: entry(
        'Brake & Retarder',
        ['Komatsu Shop Manual — Retarder System (HD785)',
         'Komatsu Technical Bulletin — Retarder Thermal Duty'],
        {
          likely: ['Penggunaan retarder berkepanjangan pada turunan panjang',
                   'Pendinginan retarder mulai kurang optimal',
                   'Pola operasi turunan tidak efisien'],
          actions: ['Periksa level & kondisi oli retarder (viskositas turun saat overheat).',
                    'Cek kerja heat exchanger & pompa sirkulasi retarder.',
                    'Evaluasi prosedur turunan: gunakan gigi & retarder bertahap, bukan menahan penuh.',
                    'Cross-check SOS Transmission: viskositas & oksidasi oli (overheat mempercepat degradasi).']
        },
        {
          likely: ['Duty termal retarder berlebih \u2192 degradasi oli & seal mengeras',
                   'Risiko brake fading saat turunan berbeban (KESELAMATAN)',
                   'Gangguan pendinginan retarder depan'],
          actions: ['Ambil sampel oli retarder/transmisi \u2014 uji viskositas & oksidasi.',
                    'Periksa heat exchanger, pompa, & kebocoran sirkuit.',
                    'Tinjau ulang rute & prosedur operasi turunan.',
                    'Inspeksi seal & kondisi retarder bila duty tetap tinggi.'],
          escalate: 'PRIORITAS KESELAMATAN: verifikasi performa pengereman sebelum melanjutkan operasi turunan berbeban.'
        }
      ),
      rRtdOver140: entry(
        'Brake & Retarder',
        ['Komatsu Shop Manual — Retarder System (HD785)',
         'Komatsu Technical Bulletin — Retarder Thermal Duty'],
        {
          likely: ['Penggunaan retarder belakang berkepanjangan',
                   'Pendinginan retarder belakang kurang optimal',
                   'Distribusi pengereman tidak seimbang depan/belakang'],
          actions: ['Bandingkan duty R vs F \u2014 selisih besar berarti distribusi tidak seimbang.',
                    'Periksa level & kondisi oli retarder belakang.',
                    'Cek heat exchanger retarder belakang.',
                    'Evaluasi prosedur pengereman turunan.']
        },
        {
          likely: ['Duty termal retarder belakang berlebih',
                   'Ketidakseimbangan pengereman depan/belakang',
                   'Risiko brake fading (KESELAMATAN)'],
          actions: ['Ambil sampel oli \u2014 uji viskositas & oksidasi.',
                    'Periksa sirkuit pendingin retarder belakang.',
                    'Verifikasi keseimbangan sistem pengereman depan/belakang.'],
          escalate: 'PRIORITAS KESELAMATAN: jangan lanjutkan turunan berbeban sebelum sistem diperiksa.'
        }
      )
    },

    GREASING: {
      autoGrsPress: entry('Auto Greasing', ['Komatsu Shop Manual — Automatic Greasing'],
        { likely: ['Level grease mulai rendah', 'Saluran grease mulai tersumbat'],
          actions: ['Periksa level & kondisi grease.', 'Cek saluran/pompa grease otomatis.'] },
        { likely: ['Tekanan grease tidak tercapai', 'Pompa/kebocoran sistem grease'],
          actions: ['Periksa pompa & kebocoran grease.', 'Bersihkan nozzle/saluran tersumbat.'] }),
      autoGrsOn: entry('Auto Greasing', ['Komatsu Shop Manual — Automatic Greasing'],
        { likely: ['Interval pelumasan perlu evaluasi'], actions: ['Verifikasi interval & fungsi timer grease.'] },
        { likely: ['Siklus grease abnormal'], actions: ['Periksa controller & sensor auto grease.'] })
    },

    ECONOMY: {
      loadCount: entry('Productivity', ['Operation'],
        { likely: ['Beban siklus operasi'], actions: ['Evaluasi produktivitas & konsumsi BBM per siklus.'] },
        { likely: ['Anomali siklus'], actions: ['Periksa pola kerja & payload.'] }),
      swingCount: entry('Productivity', ['Operation'],
        { likely: ['Intensitas siklus swing'], actions: ['Pantau kebersihan sirkuit swing & pelumasan.'] },
        { likely: ['Siklus swing tidak wajar'], actions: ['Periksa brake swing & sistem swing.'] })
    }
  };

  /* -----------------------------------------------------------------------
   * 2. Pencarian entri lintas kompartemen
   * --------------------------------------------------------------------- */
  function findEntry(paramKey) {
    for (var pillar in KB) {
      if (Object.prototype.hasOwnProperty.call(KB, pillar)) {
        if (KB[pillar][paramKey]) return { pillar: pillar, data: KB[pillar][paramKey] };
      }
    }
    return null;
  }

  /* -----------------------------------------------------------------------
   * 2b. [DAMPAK OPERASIONAL 2026-10-01] Dampak berbasis KESEHATAN ALAT &
   *     PERFORMA OPERASIONAL (bukan part). VHMS = telemetri mesin, sehingga
   *     dampaknya lebih natural berupa konsekuensi operasi:
   *       - kehilangan tenaga / produktivitas turun
   *       - konsumsi bahan bakar & oli naik
   *       - derate / unplanned downtime / risiko berhenti di jalan
   *       - risiko keselamatan & biaya pemeliharaan meningkat
   *     Part TIDAK disebut di sini (itu ranah SOS "Dampak (Part)").
   *     Format: { warn: '...', critical: '...' }
   * --------------------------------------------------------------------- */
  var IMPACT_OP = {
    // --- ENGINE ---
    blowbyMax: {
      warn: 'Performa mesin mulai menurun & konsumsi oli cenderung naik; efisiensi bahan bakar berkurang.',
      critical: 'Penurunan tenaga signifikan, konsumsi oli & BBM meningkat tajam — risiko mesin kehilangan kompresi, derate, hingga berhenti operasi (unplanned downtime).'
    },
    oilPressHMin: {
      warn: 'Tekanan pelumasan menurun — risiko keausan dipercepat & suhu mesin naik.',
      critical: 'RISIKO TINGGI: pelumasan tidak memadai dapat menyebabkan mesin mati mendadak (seize) — unit berhenti total di lokasi kerja.'
    },
    engOilTemp: {
      warn: 'Suhu oli mesin meninggi — oli lebih cepat terdegradasi, umur pakai pelumasan berkurang.',
      critical: 'Overheat oli mesin: risiko derate & kerusakan mesin; unit berisiko berhenti operasi untuk pendinginan/perbaikan.'
    },
    boostMax: {
      warn: 'Respons tenaga mulai berkurang & konsumsi BBM naik tipis.',
      critical: 'Kehilangan tenaga nyata (power loss), akselerasi & produktivitas menurun — risiko unit tidak mampu memikul beban kerja penuh.'
    },
    fExhTempMax: {
      warn: 'Pembakaran sisi kiri kurang optimal — tenaga & efisiensi BBM sedikit menurun.',
      critical: 'Ketidakseimbangan pembakaran: tenaga turun, konsumsi BBM naik — risiko overheat & kerusakan mesin bila dibiarkan.'
    },
    rExhTempMax: {
      warn: 'Pembakaran sisi kanan kurang optimal — tenaga & efisiensi BBM sedikit menurun.',
      critical: 'Ketidakseimbangan pembakaran: tenaga turun, konsumsi BBM naik — risiko overheat & kerusakan mesin bila dibiarkan.'
    },
    fuelRate: {
      warn: 'Konsumsi bahan bakar mulai naik di atas kebiasaan — tanda efisiensi operasi menurun.',
      critical: 'Konsumsi BBM jauh di atas normal: biaya operasi membengkak & indikasi penurunan efisiensi drivetrain/mesin.'
    },
    // --- HYDRAULIC ---
    hydTempMax: {
      warn: 'Suhu hidrolik meninggi — respons gerak melambat & oli hidrolik lebih cepat rusak.',
      critical: 'Overheat hidrolik: gerakan alat melemah, produktivitas turun — risiko seal bocor & pompa rusak, unit berhenti operasi.'
    },
    pump1F: { warn: 'Aliran/tekanan pompa 1F mulai tidak stabil — gerakan fungsi front melemah.', critical: 'Tekanan pompa 1F turun: fungsi front kehilangan tenaga — produktivitas turun & risiko unit tak mampu bekerja optimal.' },
    pump1R: { warn: 'Aliran/tekanan pompa 1R mulai tidak stabil — respons gerak melemah.', critical: 'Tekanan pompa 1R turun: sirkuit hidrolik kehilangan tenaga — produktivitas turun & risiko downtime.' },
    pump2F: { warn: 'Aliran/tekanan pompa 2F mulai tidak stabil — gerakan fungsi front melemah.', critical: 'Tekanan pompa 2F turun: fungsi front kehilangan tenaga — produktivitas turun & risiko downtime.' },
    pump2R: { warn: 'Aliran/tekanan pompa 2R mulai tidak stabil — respons gerak melemah.', critical: 'Tekanan pompa 2R turun: sirkuit hidrolik kehilangan tenaga — produktivitas turun & risiko downtime.' },
    // --- COOLING ---
    coolantTemp: {
      warn: 'Sistem pendinginan bekerja lebih keras — suhu mesin cenderung naik saat beban tinggi.',
      critical: 'Overheat mesin: derate otomatis, tenaga turun drastis — risiko mesin berhenti operasi & kerusakan bila dibiarkan.'
    },
    atmosAve: { warn: 'Pembacaan tekanan atmosfer menyimpang — perhitungan performa bisa kurang akurat.', critical: 'Sensor tekanan atmosfer tidak wajar: data performa mesin tidak akurat — evaluasi & kalibrasi sensor diperlukan.' },
    ambientMax: { warn: 'Suhu lingkungan tinggi — mesin bekerja di kondisi panas, potensi derate.', critical: 'Suhu lingkungan ekstrem: risiko derate & overheat saat beban tinggi — sesuaikan beban operasi.' },
    // --- FAN DRIVE & PTO ---
    fanPumpF: { warn: 'Beban pompa fan depan meningkat — efisiensi pendinginan cenderung menurun.', critical: 'Pompa fan depan bermasalah: pendinginan terganggu — risiko overheat & derate mesin.' },
    fanPumpR: { warn: 'Beban pompa fan belakang meningkat — efisiensi pendinginan cenderung menurun.', critical: 'Pompa fan belakang bermasalah: pendinginan terganggu — risiko overheat & derate mesin.' },
    ptoTempMax: {
      warn: 'Suhu sistem PTO/fan meninggi — efisiensi penyaluran tenaga menurun.',
      critical: 'Overheat sistem PTO: risiko kerusakan komponen penggerak & unit tak mampu bekerja optimal (downtime).'
    },
    // --- POWERTRAIN ---
    tcOilTempMax: {
      warn: 'Suhu oli torque converter meninggi — penyaluran tenaga & gerak alat menurun.',
      critical: 'Overheat torque converter: kehilangan tenaga saat mendorong/menggali, produktivitas turun — risiko downtime & kerusakan powertrain.'
    },
    tmMainPressMax: {
      warn: 'Tekanan main transmisi mulai tidak stabil — perpindahan tenaga kurang halus.',
      critical: 'Tekanan transmisi tidak normal: risiko kehilangan tenaga gerak & unit tidak dapat bekerja — potensi downtime besar.'
    },
    largePumpPress: { warn: 'Tekanan pompa besar mulai turun — tenaga gerak utama melemah.', critical: 'Tekanan pompa besar rendah: alat kehilangan tenaga kerja — produktivitas turun & risiko unit berhenti operasi.' },
    brakeTemp: {
      warn: 'Suhu rem meninggi — efektivitas pengereman menurun.',
      critical: 'RISIKO KESELAMATAN TINGGI: overheat rem dapat menurunkan daya pengereman secara drastis (fading) — risiko berhenti tak terkendali, khususnya saat turunan berbeban.'
    },
    retarderTemp: {
      warn: 'Suhu retarder meninggi — kemampuan pengereman menurun pada turunan berbeban.',
      critical: 'RISIKO KESELAMATAN: overheat retarder memicu penurunan daya perlambatan — risiko kecelakaan saat operasi turunan berbeban.'
    },
    // --- AUTO GREASING & PRODUCTIVITY ---
    autoGrsPress: { warn: 'Tekanan grease menurun — distribusi pelumasan otomatis mulai tidak merata.', critical: 'Sistem grease gagal menekan: komponen bergesekan tanpa pelumasan memadai — risiko keausan dipercepat & downtime.' },
    autoGrsOn: { warn: 'Siklus pelumasan otomatis tidak konsisten — kelangsungan pelumasan terpantau.', critical: 'Pelumasan otomatis terganggu: risiko keausan sendi/komponen dipercepat — perlu pemeriksaan sistem segera.' },
    loadCount: { warn: 'Jumlah siklus pemuatan sedikit menyimpang — efisiensi kerja mulai menurun.', critical: 'Siklus pemuatan tidak wajar: produktivitas alat turun — evaluasi pola kerja & kondisi unit.' },
    swingCount: { warn: 'Intensitas siklus swing menyimpang — efisiensi gerak menurun.', critical: 'Siklus swing tidak wajar: produktivitas & keselamatan gerak menurun — perlu evaluasi operasi.' }
  };

  /**
   * Dampak OPERASIONAL dari KB (bila ada). Bila tidak ada entri spesifik,
   * mundur ke turunan sistem agar tetap memberi konteks (tanpa menyebut part).
   * @param {string} paramKey
   * @param {string} severity 'warn'|'critical'
   * @returns {string|null}
   */
  function impactOperational(paramKey, severity) {
    var e = IMPACT_OP[paramKey];
    if (e) return (severity === 'critical' ? (e.critical || e.warn) : (e.warn || e.critical)) || null;
    return null;
  }

  /* -----------------------------------------------------------------------
   * 3. Bangun rekomendasi untuk satu anomali
   * ---------------------------------------------------------------------
   * @param {object} anomaly  dari analysis.anomalies
   * @param {object} [opts]   { trend: 'up'|'down'|null }
   * @returns {object} { system, refs, likely[], actions[], escalate, severity }
   * --------------------------------------------------------------------- */
  function recommend(anomaly, opts) {
    opts = opts || {};
    var found = findEntry(anomaly.param);
    var sev = anomaly.status === 'CRITICAL' ? 'critical' : 'warn';

    var system = (found && found.data.system) || anomaly.system || 'General';
    var refs = (found && found.data.refs) ? found.data.refs.slice() : [];
    var likely = [], actions = [], escalate = '';

    if (found) {
      var block = found.data[sev] || found.data.warn || {};
      likely = (block.likely || []).slice();
      actions = (block.actions || []).slice();
      escalate = block.escalate || '';
    }

    // Fallback generik bila parameter tidak ada di KB
    if (!actions.length) {
      actions = (anomaly.actions || []).slice();
      if (!actions.length) {
        actions = ['Lakukan inspeksi menyeluruh pada parameter ini sesuai shop manual.',
                   'Catat tren nilai terhadap SMR untuk evaluasi berkala.'];
      }
    }

    // Sisipkan konteks TREN bila tersedia
    if (opts.trend === 'up') {
      actions.push('Tren menunjukkan nilai MENINGKAT — pantau lebih ketat pada periode berikutnya.');
    } else if (opts.trend === 'down') {
      // untuk mode 'low' (tekanan), turun = memburuk
      actions.push('Tren menunjukkan nilai MENURUN — indikasi degradasi, pantau ketat.');
    }

    // [DAMPAK OPERASIONAL 2026-10-01] Ambil dari KB operasional (bila ada).
    // VHMS = telemetri mesin -> dampak disajikan sbg konsekuensi OPERASI &
    // kesehatan alat (performa, produktivitas, downtime, keselamatan), BUKAN
    // daftar part (itu ranah SOS "Dampak (Part)").
    var impact = impactOperational(anomaly.param, sev);

    return {
      param: anomaly.param,
      title: anomaly.title,
      system: system,
      severity: sev,
      refs: refs,
      likely: likely,
      actions: actions,
      escalate: escalate,
      impact: impact,
      fromKB: !!found
    };
  }

  /** Rekomendasi untuk SELURUH anomali sebuah unit. */
  /* -----------------------------------------------------------------------
   * [T7.3 2026-10-08] BASIS PENGETAHUAN KODE FAULT (fault0.CSV)
   * ---------------------------------------------------------------------
   * Kunci = kode fault VHMS; nilai = { system, title, likely[], actions[] }.
   * Bentuk mengikuti KB parameter yang sudah ada (gejala -> kemungkinan
   * penyebab -> tindakan).
   *
   * ATURAN KERAS untuk kode SENSOR: tindakan PERTAMA selalu "verifikasi /
   * ganti sensor SEBELUM menindaklanjuti nilai parameternya". Alasannya
   * sederhana — bila sensornya yang rusak, seluruh pembacaan parameternya
   * tidak layak dipakai untuk keputusan (inilah gerbang kualitas data T2).
   * --------------------------------------------------------------------- */
  var FAULT_KB = {
    DGT5KA: {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust temp. sensor F failure',
      likely: [
        'Sensor suhu gas buang bank kiri (F) rusak / kabel putus',
        'Konektor sensor kotor, lembab, atau longgar',
        'Modul input VHMS bermasalah'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang bank F sebelum menindaklanjuti nilai fExhTempMax.',
        'Periksa konektor & harness sensor dari kotoran/kelembapan/korosi.',
        'Bandingkan pembacaan bank F vs bank R saat idle — selisih tak wajar menandakan sensor.',
        'Setelah sensor sehat, baru evaluasi keseimbangan pembakaran per bank.'
      ]
    },
    DGT5KB: {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust temp. sensor F failure',
      likely: [
        'Sensor suhu gas buang bank kiri (F) rusak / intermiten',
        'Harness terkelupas atau tersenggol komponen panas',
        'Ground sensor tidak stabil'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang bank F sebelum menindaklanjuti nilai fExhTempMax.',
        'Periksa jalur harness dari panas & gesekan; rapikan pengikat kabel.',
        'Periksa kualitas ground/arde rangkaian sensor.',
        'Catat kronologi fault untuk melihat apakah intermiten atau permanen.'
      ]
    },
    DGT6KA: {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust temp. sensor R failure',
      likely: [
        'Sensor suhu gas buang bank kanan (R) rusak / kabel putus',
        'Konektor sensor kotor, lembab, atau longgar',
        'Modul input VHMS bermasalah'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang bank R sebelum menindaklanjuti nilai rExhTempMax.',
        'Periksa konektor & harness sensor dari kotoran/kelembapan/korosi.',
        'Bandingkan pembacaan bank R vs bank F saat idle — selisih tak wajar menandakan sensor.',
        'Setelah sensor sehat, baru evaluasi keseimbangan pembakaran per bank.'
      ]
    },
    DGT6KB: {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust temp. sensor R failure',
      likely: [
        'Sensor suhu gas buang bank kanan (R) rusak / intermiten',
        'Harness terkelupas atau tersenggol komponen panas',
        'Ground sensor tidak stabil'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang bank R sebelum menindaklanjuti nilai rExhTempMax.',
        'Periksa jalur harness dari panas & gesekan; rapikan pengikat kabel.',
        'Periksa kualitas ground/arde rangkaian sensor.',
        'Catat kronologi fault untuk melihat apakah intermiten atau permanen.'
      ]
    },
    DHE5KB: {
      system: 'Engine — Blowby',
      title: 'Blowby pressure sensor failure',
      likely: [
        'Sensor tekanan blowby (crankcase) rusak / tersumbat',
        'Selang ukur blowby bocor atau tertekuk',
        'Konektor/harness sensor bermasalah'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor tekanan blowby sebelum menindaklanjuti nilai blowbyMax.',
        'Periksa selang & saluran ukur blowby dari kebocoran, tekukan, atau kerak.',
        'Lakukan Blowby Test manual (manometer) sebagai cross-check independen.',
        'Bila sensor sehat tetapi blowby tetap tinggi, lanjutkan analisis keausan ring/liner via SOS (Fe/Cr).'
      ]
    },
    DHT3KX: {
      system: 'Powertrain — Transmission',
      title: 'T/M main pressure sensor failure',
      likely: [
        'Sensor tekanan main transmisi rusak / kabel putus',
        'Konektor sensor lembab atau korosi',
        'Tekanan transmisi benar-benar tidak normal (sensor bekerja, sistem bermasalah)'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor tekanan main transmisi sebelum menindaklanjuti tmMainPressMax/Ave.',
        'Ukur tekanan main dengan manometer mekanis sebagai pembanding.',
        'Periksa level & kondisi oli transmisi serta filter.',
        'Bila tekanan terukur memang menyimpang, evaluasi pompa & relief valve transmisi.'
      ]
    },
    DBB6KP: {
      system: 'VHMS — Sistem Kelistrikan',
      title: 'Abnormality in 24V source system (VHMS)',
      likely: [
        'Tegangan suplai 24V ke modul VHMS tidak stabil / di luar rentang',
        'Ground VHMS lemah atau korosi',
        'Fuse/relay suplai logger bermasalah, atau baterai melemah'
      ],
      actions: [
        'PERIKSA suplai 24V & ground modul VHMS SEBELUM mempercayai SELURUH data telemetri unit ini.',
        'Ukur tegangan pada terminal modul VHMS saat mesin hidup & mati.',
        'Periksa kualitas ground, fuse, dan relay suplai logger.',
        'Analisis VHMS dianggap TIDAK LAYAK sampai suplai normal kembali (tandai unit: DATA TIDAK LAYAK).'
      ]
    },
    DBBRKR: {
      system: 'VHMS — Komunikasi',
      title: 'CAN-NET sys (J1939) Error',
      likely: [
        'Bus CAN/J1939 terganggu — terminasi salah atau resistansi tidak sesuai',
        'Harness CAN longgar, terkelupas, atau tertekuk',
        'Modul ECU/node pada bus bermasalah atau alamat duplikat'
      ],
      actions: [
        'PERIKSA integritas bus CAN (resistansi terminasi 60 Ω, kondisi harness) SEBELUM mempercayai data telemetri unit ini.',
        'Periksa konektor CAN pada ECU, modul VHMS, dan node terkait.',
        'Cek apakah node lain pada bus juga melaporkan error (menentukan apakah ECU atau bus).',
        'Data VHMS dianggap TIDAK LAYAK selama kegagalan komunikasi berulang/masih aktif.'
      ]
    },
    DBBQKR: {
      system: 'VHMS — Komunikasi',
      title: 'KOM-net communication failure',
      likely: [
        'Jaringan komunikasi KOM-net terputus / tidak stabil',
        'Modul komunikasi VHMS bermasalah',
        'Antena/kanal transmisi data terganggu'
      ],
      actions: [
        'PERIKSA jaringan & modul komunikasi KOM-net SEBELUM mempercayai kelengkapan data telemetri unit ini.',
        'Pastikan modul komunikasi mendapat suplai & ground yang baik.',
        'Verifikasi data yang terkirim tidak hilang sebagian (gap waktu pada trend).',
        'Data VHMS dianggap TIDAK LAYAK bila kegagalan komunikasi masih aktif.'
      ]
    },
    MFA0: {
      system: 'VHMS — Umum',
      title: 'Manual Trigger',
      likely: [
        'Pemicu manual oleh operator/teknisi (bukan kegagalan komponen)',
        'Unduhan data dipicu manual saat pengambilan sampel'
      ],
      actions: [
        'Tidak perlu tindakan perbaikan — ini catatan pemicu manual.',
        'Gunakan sebagai penanda waktu untuk mengaitkan aktivitas pemeriksaan dengan data telemetri.'
      ]
    },

    /* =====================================================================
     * [PC2000 2026-10-10 — T5] KODE FAULT EXCAVATOR PC2000.
     * =====================================================================
     * Sumber: `fault0.CSV` SN 20020 (PC2000-8). 34 kode distinct; 24 di
     * antaranya sebelumnya TIDAK punya entri -> nol rekomendasi tindakan
     * (tampil sebagai kode mentah saja).
     *
     * ⚠ HURUF BESAR/KECIL BERMAKNA (lihat `faultEntry()` T7).
     *   `DGT6KA` = RBF (Right-Bank Front)  vs  `dGT6KA` = RBR (Right-Bank Rear)
     *   `DGT5KB` = LBF (Left-Bank Front)   vs  `dGT5KB` = LBR (Left-Bank Rear)
     *
     * Prinsip penulisan (sama dengan entri HD785/D375A di atas):
     *   - Sensor rusak -> tindakan UTAMA adalah verifikasi/ganti sensor
     *     SEBELUM menindaklanjuti nilai parameter (gerbang kualitas data).
     *   - Alarm nilai (High Exhaust Temp, Overheat, Blowby) -> yang diperiksa
     *     adalah SEBAB dari nilai tinggi, bukan sensornya.
     * ===================================================================== */

    /* --- Exhaust temp per grup silinder (komplemen FAULT_SENSOR_MAP) --- */
    'dGT5KB': {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust Temp. Sensor LBR Failure (Left-Bank Rear)',
      likely: [
        'Sensor suhu gas buang LBR (kiri-belakang) rusak / intermiten',
        'Harness sensor tersenggol komponen panas atau ground tidak stabil',
        'Konektor sensor lembab / korosi'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang LBR sebelum menindaklanjuti lrExhOver700/750/800 — nilainya DIKECUALIKAN dari skor selama fault aktif.',
        'Periksa jalur harness dari panas & gesekan; rapikan pengikat kabel.',
        'Bandingkan pembacaan 4 grup (LBF/LBR/RBF/RBR) saat idle — satu grup menyimpang jauh menandakan sensor.',
        'Bila sensor sudah sehat, baru evaluasi keseimbangan pembakaran bank kiri.'
      ]
    },
    'dGT6KA': {
      system: 'Engine — Exhaust Temperature',
      title: 'Exhaust Temp. Sensor RBR Failure (Right-Bank Rear)',
      likely: [
        'Sensor suhu gas buang RBR (kanan-belakang) rusak / intermiten',
        'Harness sensor tersenggol komponen panas atau ground tidak stabil',
        'Konektor sensor lembab / korosi'
      ],
      actions: [
        'VERIFIKASI / GANTI sensor suhu gas buang RBR sebelum menindaklanjuti rrExhOver700/750/800.',
        'Periksa jalur harness dari panas & gesekan.',
        'Bandingkan pembacaan 4 grup (LBF/LBR/RBF/RBR) saat idle.',
        'Bila sensor sudah sehat, baru evaluasi keseimbangan pembakaran bank kanan.'
      ]
    },
    'f@BYNS': {
      system: 'Engine — Exhaust Temperature',
      title: 'High LBR Cylinder Exhaust Temp (ALARM NILAI)',
      likely: [
        'Beban pembakaran berlebih pada grup LBR (kiri-belakang)',
        'Injektor grup LBR tidak seimbang / nozzel tersumbat',
        'Pendinginan tidak merata atau EGR/air intake bermasalah di grup itu',
        'Bila sensor LBR juga fault (dGT5KB) — nilai ini TIDAK dapat dipercaya'
      ],
      actions: [
        'CEK dulu apakah `dGT5KB`/`DGT5KA` aktif — bila ya, ini ALARM PALSU dari sensor rusak; perbaiki sensornya lebih dahulu.',
        'Bila sensor sehat: periksa injektor & kompresi grup LBR, bandingkan dengan 3 grup lain.',
        'Periksa kebersihan radiator/aftercooler & meratanya aliran udara pendingin.',
        'Kurangi beban kerja sementara sampai suhu grup kembali merata.'
      ]
    },
    'f@BYNR': {
      system: 'Engine — Exhaust Temperature',
      title: 'Very High LBR Cylinder Exhaust Temp (ALARM NILAI)',
      likely: [
        'Overheat nyata grup LBR — risiko kerusakan valve/piston grup tersebut',
        'Injektor grup LBR over-fuelling / nozzel bocor',
        'Sensor LBR rusak-tinggi (stuck-high) sehingga alarm terus berbunyi',
        'Bila sensor LBR juga fault (dGT5KB) — nilai ini TIDAK dapat dipercaya'
      ],
      actions: [
        'PRIORITAS: pastikan dulu apakah `dGT5KB` aktif. Bila ya, alarm ini TIDAK dapat dipercaya — ganti sensor LBR, jangan turun mesin.',
        'Bila sensor sehat: HENTIKAN operasi berbeban & periksa injektor grup LBR segera.',
        'Periksa endoskopi (borescope) grup LBR bila alarm berulang dengan sensor sehat.',
        'Catat durasi alarm — paparan lama di atas 800 °C dapat merusak valve seat.'
      ]
    },
    'B@BCNS': {
      system: 'Cooling',
      title: 'Engine Water Overheat',
      likely: [
        'Level coolant rendah / kebocoran sistem pendingin',
        'Radiator tersumbat debu/kotoran atau fan pendingin lemah',
        'Thermostat macet / water pump lemah',
        'Beban operasi berlebih pada lingkungan panas'
      ],
      actions: [
        'HENTIKAN operasi & biarkan mesin mendingin sebelum membuka tutup radiator.',
        'Periksa level & kondisi coolant; cari kebocoran pada selang/radiator.',
        'Bersihkan inti radiator dari debu & kotoran (pembersihan berkala di area berdebu).',
        'Uji thermostat & water pump; periksa tegangan/tali kipas.',
        'Bila berulang, periksa sensor suhu coolant agar tidak salah baca.'
      ]
    },
    'F@BBZL': {
      system: 'Engine — Blowby',
      title: 'High Blowby Pressure',
      likely: [
        'Keausan ring piston / cylinder liner',
        'Crankcase breather tersumbat sehingga tekanan blowby terukur naik',
        'Kondisi ini juga sering muncul pada unit berduty berat (beban tinggi terus-menerus)'
      ],
      actions: [
        'Periksa & bersihkan crankcase breather sebelum menyimpulkan keausan mesin.',
        'Ukur blowby dengan alat kalibrasi; bandingkan dengan spesifikasi model.',
        'Bila blowby tinggi disertai konsumsi oli meningkat & asap berlebih, siapkan rencana overhaul bertahap.',
        'CATATAN: muncul bersama `f@BYNR`/`f@BYNS` (beban termal tinggi) — nilai bersamanya memperkuat dugaan kelelahan thermal.'
      ]
    },
    'CA115': {
      system: 'Engine — Sensor Speed',
      title: 'Eng. Ne and Backup Speed Sensor Error',
      likely: [
        'Sensor putaran mesin (Ne) atau sensor cadangan gagal / kotor',
        'Harness atau konektor sensor bergesekan / lembab',
        'Celah (gap) sensor ke roda gigi tidak tepat'
      ],
      actions: [
        'VERIFIKASI pembacaan engSpeed sebelum mempercayai data putaran mesin.',
        'Periksa konektor & harness kedua sensor; bersihkan bila kotor.',
        'Periksa & setel celah sensor ke roda gigi sesuai spesifikasi.',
        'Bila sensor cadangan ikut gagal, ganti agar proteksi over-speed tetap aktif.'
      ]
    },

    /* --- Hidrolik: filter, relief, PPC, EPC, komunikasi pompa --- */
    '6014NX': {
      system: 'Hydraulic',
      title: 'Hydraulic Oil Filter Clogging',
      likely: [
        'Elemen filter hidrolik tersumbat (interval ganti terlampaui)',
        'Kontaminasi/partikel dari komponen aus masuk ke sirkuit',
        'Oli hidrolik terdegradasi / viskositas tidak sesuai'
      ],
      actions: [
        'GANTI elemen filter hidrolik; catat apakah penggantian sebelumnya terlalu lama.',
        'Periksa sumbatan berulang — bila sering, uji kandungan partikel oli (SOS) untuk mencari sumber keausan.',
        'Periksa kebersihan breather tangki hidrolik & pastikan tidak ada kebocoran masuknya debu.',
        'Catat jam penggantian filter sebagai basis perbandingan berkala.'
      ]
    },
    '7@HCZL': {
      system: 'Hydraulic',
      title: 'VR2 / P2F Relief Pressure Abnormality',
      likely: [
        'Setelan relief valve VR2 (sirkuit pompa 2F) menyimpang',
        'Relief valve macet / spring lemah / seal bocor',
        'Tekanan pompa 2F tidak stabil sehingga relief bekerja tidak tepat'
      ],
      actions: [
        'UJI tekanan sirkuit pompa 2F & bandingkan dengan spesifikasi.',
        'Periksa relief valve VR2: kebersihan, spring, dan seal-nya.',
        'Bila menyertai pressure drop pompa 2F, periksa juga pompa & EPC terkait.',
        'Setel ulang relief sesuai spesifikasi setelah komponen terbukti baik.'
      ]
    },
    'DXAAKA': {
      system: 'Hydraulic — EPC',
      title: 'P1F EPC Solenoid Open Circuit',
      likely: ['Solenoid EPC pompa 1F putus / konektor lepas', 'Harness EPC terputus atau korosi'],
      actions: ['Periksa kondisi & kontinuitas solenoid EPC pompa 1F.', 'Periksa konektor/harness EPC dari korosi & gesekan.', 'Bila solenoid putus, ganti sebelum menilai tekanan pompa 1F.']
    },
    'DXABKA': {
      system: 'Hydraulic — EPC',
      title: 'P1R EPC Solenoid Open Circuit',
      likely: ['Solenoid EPC pompa 1R putus / konektor lepas', 'Harness EPC terputus atau korosi'],
      actions: ['Periksa kondisi & kontinuitas solenoid EPC pompa 1R.', 'Periksa konektor/harness EPC dari korosi & gesekan.', 'Bila solenoid putus, ganti sebelum menilai tekanan pompa 1R.']
    },
    'DXACKA': {
      system: 'Hydraulic — EPC',
      title: 'P2F EPC Solenoid Open Circuit',
      likely: ['Solenoid EPC pompa 2F putus / konektor lepas', 'Harness EPC terputus atau korosi'],
      actions: ['Periksa kondisi & kontinuitas solenoid EPC pompa 2F.', 'Periksa konektor/harness EPC dari korosi & gesekan.', 'Bila solenoid putus, ganti sebelum menilai tekanan pompa 2F.']
    },
    'DXADKA': {
      system: 'Hydraulic — EPC',
      title: 'P2R EPC Solenoid Open Circuit',
      likely: ['Solenoid EPC pompa 2R putus / konektor lepas', 'Harness EPC terputus atau korosi'],
      actions: ['Periksa kondisi & kontinuitas solenoid EPC pompa 2R.', 'Periksa konektor/harness EPC dari korosi & gesekan.', 'Bila solenoid putus, ganti sebelum menilai tekanan pompa 2R.']
    },
    'dA25KP': {
      system: 'Hydraulic — EPC',
      title: 'Pump2 Sensor Supply Voltage Low Error',
      likely: [
        'Tegangan suplai sensor pompa 2 terlalu rendah (bukan sensor itu sendiri)',
        'Korsleting / beban berlebih pada jalur suplai sensor',
        'Ground atau suplai modul kontrol bermasalah'
      ],
      actions: [
        'UKUR tegangan suplai 5V sensor pompa 2 — bila di bawah spesifikasi, JANGAN menyalahkan sensor dulu.',
        'Periksa korsleting pada jalur suplai & konektor.',
        'Periksa ground modul kontrol.',
        'Nilai parameter pump2F/pump2R TIDAK dapat dipercaya selama fault ini aktif.'
      ]
    },
    'DHS8KX': {
      system: 'Hydraulic — PPC',
      title: 'Boom Raise PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC boom-raise rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC boom-raise; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve boom.']
    },
    'DHS9KX': {
      system: 'Hydraulic — PPC',
      title: 'Boom Lower PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC boom-lower rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC boom-lower; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve boom.']
    },
    'DHS3KX': {
      system: 'Hydraulic — PPC',
      title: 'Arm Dig PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC arm-dig rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC arm-dig; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve arm.']
    },
    'DHSCKX': {
      system: 'Hydraulic — PPC',
      title: 'Arm Dump PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC arm-dump rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC arm-dump; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve arm.']
    },
    'DHS4KX': {
      system: 'Hydraulic — PPC',
      title: 'Bucket Curl PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC bucket-curl rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC bucket-curl; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve bucket.']
    },
    'DHSDKX': {
      system: 'Hydraulic — PPC',
      title: 'Bucket Dump PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC bucket-dump rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC bucket-dump; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons valve bucket.']
    },
    'DHSAKX': {
      system: 'Hydraulic — PPC',
      title: 'Swing Right PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC swing-right rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC swing-right; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons swing.']
    },
    'DHSBKX': {
      system: 'Hydraulic — PPC',
      title: 'Swing Left PPC Pressure Sensor Abnormality',
      likely: ['Sensor tekanan PPC swing-left rusak / drift', 'Konektor lembab atau harness bermasalah'],
      actions: ['Uji sensor tekanan PPC swing-left; bandingkan dengan pressure gauge.', 'Periksa konektor & harness dari kelembapan.', 'Bila sensor menyimpang, ganti sebelum menilai respons swing.']
    },
    'DA2TMC': {
      system: 'Hydraulic — Komunikasi',
      title: 'Pump Comm. ECM R/B Abnormality',
      likely: [
        'Komunikasi data modul pompa terputus sesaat (bukan kerusakan pompa)',
        'Konektor CAN modul pompa lepas/korosi atau ground tidak stabil'
      ],
      actions: [
        'Periksa konektor & harness komunikasi modul pompa dari korosi/kelembapan.',
        'Periksa ground & suplai modul pompa.',
        'Bila intermiten dan jarang, catat saja — namun bila sering, periksa modul kontrol pompa.',
        'CATATAN: ini BUKAN unit-wide; hanya data pompa yang berisiko tidak lengkap.'
      ]
    },

    /* --- Brake (swing) --- */
    'DW45KA': {
      system: 'Brake — Swing',
      title: 'Swing Brake Solenoid Open Circuit',
      likely: ['Solenoid rem swing putus / konektor lepas', 'Harness rem swing terputus atau korosi'],
      actions: [
        'Periksa kontinuitas solenoid rem swing & konektornya.',
        'Periksa harness dari gesekan/korosi.',
        'Bila solenoid putus, ganti — rem swing berperan pada keselamatan saat parkir di permukaan miring.'
      ]
    },
    'DW45KB': {
      system: 'Brake — Swing',
      title: 'Swing Brake Solenoid Short Circuit',
      likely: ['Solenoid rem swing korsleting', 'Harness terjepit / isolasi terkelupas'],
      actions: [
        'Periksa korsleting pada solenoid rem swing & harness.',
        'Isolasi/rapikan harness yang terjepit.',
        'Ganti solenoid bila korsleting berasal dari dalam kumparan.',
        'Verifikasi fungsi rem swing setelah perbaikan.'
      ]
    },

    /* --- Auto grease --- */
    'DHPSKX': {
      system: 'Greasing — Auto Grease',
      title: 'Auto Grease Press Sensor Abnormality',
      likely: ['Sensor tekanan pengukur grease rusak / drift', 'Suplai grease habis sehingga tekanan tidak terbentuk'],
      actions: [
        'CEK level grease lebih dahulu — sensor ini sering "error" hanya karena grease habis.',
        'Isi/bersihkan tangki & pastikan pompa mengisi tekanan.',
        'Bila grease cukup namun tekanan tetap tidak wajar, ganti sensor tekanan.',
        'Bandingkan dengan fault `8800ZG`/`DWA5KA` untuk mengetahui apakah masalah pada sensor atau sistem grease.'
      ]
    },
    'DWA5KA': {
      system: 'Greasing — Auto Grease',
      title: 'Auto Grease Solenoid Open Circuit',
      likely: ['Solenoid pompa auto-grease putus / konektor lepas', 'Harness auto-grease terputus'],
      actions: [
        'Periksa kontinuitas solenoid & konektor auto-grease.',
        'Periksa harness dari gesekan/korosi.',
        'Bila putus, ganti — tanpa solenoid, pelumasan otomatis berhenti dan titik grease bisa kering.'
      ]
    },
    '8800ZG': {
      system: 'Greasing — Auto Grease',
      title: 'Auto Grease Abnormality',
      likely: [
        'Sistem pelumasan otomatis gagal menyelesaikan siklus',
        'Grease habis / saluran tersumbat sehingga tekanan tidak tercapai',
        'Pompa atau distributor auto-grease bermasalah'
      ],
      actions: [
        'CEK level & jenis grease (kekentalan salah dapat memicu alarm).',
        'Periksa saluran & fitting yang tersumbat.',
        'Uji siklus pompa auto-grease & tekanannya.',
        'Lumasi manual titik kritis sampai sistem auto-grease diperbaiki.'
      ]
    },

    /* --- Komunikasi & lain-lain --- */
    'DAFRMC': {
      system: 'VHMS — Komunikasi',
      title: 'CAN Disconnected (Monitor Detected)',
      likely: [
        'Bus CAN terputus sesaat — MONITOR kehilangan data seluruh kanal',
        'Konektor CAN longgar / terminasi bus bermasalah'
      ],
      actions: [
        'PERIKSA jaringan CAN & terminasi bus — SELURUH data telemetri unit ini berisiko tidak lengkap.',
        'Periksa konektor utama & harness CAN dari kelembapan.',
        'Verifikasi tidak ada gap waktu pada trend setelah kejadian.',
        'Bila berulang, catat sebagai masalah integritas data (data tidak layak untuk keputusan).'
      ]
    },
    'DY2FMA': {
      system: 'Lain-lain — Wiper',
      title: 'Upper Wiper Working Abnormality',
      likely: ['Motor/linkage wiper atas macet atau motor lemah', 'Suplai/daya wiper bermasalah'],
      actions: [
        'Periksa motor & linkage wiper atas; bersihkan/lumasi mekanisme.',
        'Periksa sekring/daya wiper.',
        'Bila unit beroperasi di area hujan/debu, perbaikan penting untuk visibilitas operator.',
        'CATATAN: TIDAK memengaruhi data telemetri apa pun — bobot prioritas rendah.'
      ]
    }
  };

  /** Cari entri KB untuk sebuah KODE FAULT (bukan key parameter). */
  function faultEntry(code) {
    // [PC2000 2026-10-10 — T7] JANGAN paksa UPPERCASE.
    // ------------------------------------------------------------------
    // Kode fault Komatsu CASE-SENSITIVE dan perbedaannya BERMAKNA. Terbukti
    // di `fault0.CSV` PC2000 SN 20020: `DGT6KA` = "Exhaust Temp. Sensor RBF
    // Failure" sedangkan `dGT6KA` = "... RBR Failure" — GRUP SILINDER BERBEDA
    // (Front vs Rear) di berkas yang SAMA. Versi lama `toUpperCase()` membuat
    // keduanya bertabrakan sehingga entri pertama menang dan entri kedua
    // tak pernah terjangkau.
    //
    // `FAULT_SENSOR_MAP` (gerbang kualitas data) sudah case-sensitive sejak
    // awal — di sini disamakan.
    //
    // Urutan pencarian: PERSIS dulu (menghormati huruf besar/kecil), BARU
    // fallback UPPERCASE untuk entri yang memang ditulis huruf besar semua
    // (mis. `DGT5KA`, `DHE5KB`). Fallback ini menjaga kompatibilitas entri
    // KB lama yang tidak punya varian huruf kecil.
    var raw = String(code || '').trim();
    if (!raw) return null;
    if (FAULT_KB[raw]) return FAULT_KB[raw];
    return FAULT_KB[raw.toUpperCase()] || null;
  }

  /** Rekomendasi tindakan untuk sebuah kode fault. */
  function recommendFault(code) {
    var e = faultEntry(code);
    if (!e) return null;
    return {
      code: code,
      system: e.system,
      title: e.title,
      likely: (e.likely || []).slice(),
      actions: (e.actions || []).slice(),
      fromKB: true
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_KNOWLEDGE = {
    KB: KB,
    IMPACT_OP: IMPACT_OP,
    // [T7.3] Basis pengetahuan kode fault history
    FAULT_KB: FAULT_KB,
    faultEntry: faultEntry,
    recommendFault: recommendFault,
    recommend: recommend,
    findEntry: findEntry,
    impactOperational: impactOperational
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

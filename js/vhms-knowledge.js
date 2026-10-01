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
                    'Catat tren blowby vs SMR untuk evaluasi berkala.']
        },
        {
          likely: ['Keausan signifikan piston ring / cylinder liner',
                   'Kebocoran kompresi ke crankcase',
                   'Risiko blow-by berlebih → penurunan tenaga & konsumsi oli naik'],
          actions: ['Blowby Test konfirmasi — bandingkan dengan spesifikasi manual.',
                    'Inspeksi end-gap piston ring & keausan liner (borescope).',
                    'Uji kompresi per silinder.',
                    'Periksa kondisi turbocharger & sistem pernapasan crankcase (breather).',
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
                    'Verifikasi pembacaan sensor/switch tekanan oli.']
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
          actions: ['Periksa kebersihan oil cooler mesin.', 'Cek level & kondisi oli.', 'Verifikasi sensor suhu oli.']
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
          actions: ['Periksa klem & selang charge air.', 'Cek kebersihan air cleaner.', 'Verifikasi sensor boost.']
        },
        {
          likely: ['Over-boost → risiko kerusakan turbo', 'Wastegate macet', 'Sensor MAP bermasalah'],
          actions: ['Periksa wastegate & aktuator.', 'Inspeksi turbocharger (end-play, kebocoran oli).',
                    'Verifikasi sensor tekanan boost.']
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
                    'Evaluasi metode kerja operator (idle berlebih, dsb.).']
        },
        {
          likely: ['Konsumsi BBM abnormal', 'Injektor tidak efisien', 'Sistem bahan bakar bermasalah'],
          actions: ['Uji injektor & timing.', 'Periksa kebocoran jalur bahan bakar.',
                    'Analisis pola operasi (payload, jarak, grade).',
                    'Lakukan kalibrasi sistem bahan bakar.']
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
                    'Cek level & kondisi oli hidrolik (viskositas).']
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
                    'Uji kerja thermostat.']
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
  /* ----------------------------------------------------------------------- */
  global.VHMS_KNOWLEDGE = {
    KB: KB,
    IMPACT_OP: IMPACT_OP,
    recommend: recommend,
    findEntry: findEntry,
    impactOperational: impactOperational
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

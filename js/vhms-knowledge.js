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

    return {
      param: anomaly.param,
      title: anomaly.title,
      system: system,
      severity: sev,
      refs: refs,
      likely: likely,
      actions: actions,
      escalate: escalate,
      fromKB: !!found
    };
  }

  /** Rekomendasi untuk SELURUH anomali sebuah unit. */
  function recommendAll(analysis) {
    var anomalies = (analysis && analysis.anomalies) || [];
    return anomalies.map(function (a) {
      var trend = null;
      if (a.slope !== null && a.slope !== undefined && Math.abs(a.slope) > 1e-9) {
        trend = a.slope > 0 ? 'up' : 'down';
      }
      return recommend(a, { trend: trend });
    });
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_KNOWLEDGE = {
    KB: KB,
    recommend: recommend,
    recommendAll: recommendAll,
    findEntry: findEntry
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

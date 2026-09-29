/* =========================================================================
 * sos-knowledge.js
 * -------------------------------------------------------------------------
 * Basis pengetahuan (knowledge base) OFFLINE untuk parameter SOS (oil
 * analysis) + mesin aturan (rule-based) untuk REKOMENDASI TEKNIS pada
 * halaman PORTOFOLIO.
 *
 * Struktur entri per parameter:
 *   {
 *     group:    'wear' | 'oil' | 'clean' | 'additive',
 *     refs:     [..referensi singkat..],
 *     warn:     { likely: [..penyebab..], actions: [..tindakan..] },
 *     critical: { likely: [...], actions: [...], escalate: '...' }
 *   }
 *
 * API:
 *   recommend(paramKey, severity, opts) -> { param, label, severity, likely, actions, escalate, fromKB }
 *   recommendForUnit(context)           -> [ ...rekomendasi + rule-based... ]
 *
 * Catatan: teks bersifat panduan umum industri & praktik condition monitoring.
 * BUKAN kutipan resmi; teknisi tetap mengacu SOP & manual komponen.
 * ========================================================================= */

(function (global) {
  'use strict';

  function entry(group, refs, warn, crit) {
    return {
      group: group,
      refs: refs || [],
      warn: warn || { likely: [], actions: [] },
      critical: crit || { likely: [], actions: [] }
    };
  }

  /* -----------------------------------------------------------------------
   * 1. KNOWLEDGE BASE per parameter SOS
   * --------------------------------------------------------------------- */
  var KB = {
    /* ---------------- WEAR METALS ---------------- */
    wear_fe: entry('wear',
      ['Piston ring / liner', 'Gear & bearing wear'],
      { likely: ['Keausan normal (break-in) atau keausan ring/liner mulai meningkat',
                 'Kontaminasi partikel besi dari komponen bergerak'],
        actions: ['Pantau tren Fe antar sampling (gunakan ROW₁₀₀).',
                  'Periksa riwayat penambahan oli & interval penggantian.',
                  'Cek kondisi air cleaner / jalur intake bila Si juga tinggi.'] },
      { likely: ['Keausan signifikan piston ring / cylinder liner',
                 'Keausan gear/bearing internal',
                 'Kontaminasi besi dari komponen yang aus (abrasive)'],
        actions: ['Lakukan inspeksi borescope silinder & end-gap ring.',
                  'Ambil sampel ulang untuk konfirmasi & cek tren ROW₁₀₀.',
                  'Periksa filter oli (potong) untuk serpihan logam.',
                  'Siapkan rencana overhaul bila tren terus naik.'],
        escalate: 'Batasi operasi berat, jadwalkan inspeksi mekanik segera.' }),

    wear_cu: entry('wear',
      ['Bearing (Cu-Pb)', 'Oil cooler', 'Bushing'],
      { likely: ['Keausan bushing / bearing kuningan mulai terjadi',
                 'Kontaminasi dari oil cooler (Cu) atau seal'],
        actions: ['Pantau tren Cu & Sn (bila ada) untuk lokalisasi.',
                  'Periksa kebersihan & integritas oil cooler.'] },
      { likely: ['Keausan bearing Cu-Pb signifikan',
                 'Kebocoran internal oil cooler ke oli',
                 'Kontaminasi dari bantalan/cage yang aus'],
        actions: ['Uji tekanan & periksa kebocoran oil cooler.',
                  'Inspeksi bearing utama & connecting rod.',
                  'Lakukan analisis lanjutan (SEM/EDS bila tersedia).'],
        escalate: 'Waspadai indikasi bearing failure — siapkan shutdown terkendali.' }),

    wear_al: entry('wear',
      ['Piston (aluminium)', 'Housing', 'Bearing shell'],
      { likely: ['Keausan ringan komponen aluminium (piston/shell)',
                 'Kontaminasi silika (bila Si tinggi bersamaan)'],
        actions: ['Bandingkan dengan Si & Fe untuk membedakan dirt vs wear.',
                  'Pantau tren Al antar sampling.'] },
      { likely: ['Keausan piston / shell bearing',
                 'Ingesti debu abrasif (dengan Si tinggi)'],
        actions: ['Inspeksi sistem intake & pembersihan.',
                  'Periksa piston/skirt & bearing shell.',
                  'Konfirmasi kontaminasi debu (Si, Al sama-sama tinggi).'],
        escalate: 'Cegah ingesti debu; periksa & perbaiki jalur intake segera.' }),

    wear_cr: entry('wear',
      ['Ring (chrome-plated)', 'Liner', 'Seal'],
      { likely: ['Keausan coating chromium ring/liner',
                 'Kontaminasi coolant (bila Na/B/K juga naik)'],
        actions: ['Pantau tren Cr; cek keberadaan coolant infiltration.',
                  'Periksa kondisi ring & liner saat kesempatan.'] },
      { likely: ['Keausan lapisan chromium yang signifikan',
                 'Kebocoran coolant ke oli (glycol contamination)'],
        actions: ['Uji kontaminasi coolant (glycol test, K, B).',
                  'Inspeksi ring, liner, dan sistem pendingin.',
                  'Periksa gasket head / oil cooler.'],
        escalate: 'Segera cek sistem pendingin jika curiga coolant masuk oli.' }),

    wear_pb: entry('wear',
      ['Bearing overlay (Pb)', 'Seal', 'Babbitt'],
      { likely: ['Keausan overlay bearing / bantalan',
                 'Kontaminasi Pb dari bantalan berbasis timah'],
        actions: ['Pantau tren Pb & Cu (sering bersamaan).',
                  'Periksa kondisi bearing yang menggunakan overlay.'] },
      { likely: ['Keausan overlay bearing Pb yang kritis',
                 'Risiko bearing failure bila masih beroperasi'],
        actions: ['Inspeksi bearing utama & rod secara menyeluruh.',
                  'Cek clearance & kondisi oli (viskositas, TBN).',
                  'Evaluasi jadwal penggantian bearing.'],
        escalate: 'Jangan abaikan — overlay Pb habis dapat menyebabkan metal-to-metal.' }),

    wear_si: entry('wear',
      ['Ingesti debu', 'Gasket/seal silicon', 'Additive (anti-foam)'],
      { likely: ['Kontaminasi debu melalui intake (air cleaner)',
                 'RTV/sealant silicon terlarut',
                 'Residu additive anti-foam (kadar rendah)'],
        actions: ['Periksa & ganti elemen air cleaner bila perlu.',
                  'Cek integritas jalur intake setelah filter.',
                  'Konfirmasi dengan Al tinggi (dirt indicator).'] },
      { likely: ['Ingesti debu abrasif berkelanjutan (Dirt Entry tinggi)',
                 'Kerusakan seal/gasket terkait'],
        actions: ['Inspeksi menyeluruh sistem intake & intercooler.',
                  'Periksa clamp, hose, boot intake.',
                  'Lakukan pembersihan & perbaikan kebocoran.',
                  'Pantau Dirt Entry Index (Si + Al).'],
        escalate: 'Hentikan sumber ingesti debu sebelum keausan linier meluas.' }),

    wear_sn: entry('wear',
      ['Bearing (Cu-Pb-Sn)', 'Piston ring coating'],
      { likely: ['Keausan komponen berbasis timah mulai terjadi'],
        actions: ['Pantau tren Sn bersama Cu/Pb.',
                  'Periksa bearing terkait.'] },
      { likely: ['Keausan bearing Sbco-Sn significan', 'Risiko bearing damage'],
        actions: ['Inspeksi bearing utama.',
                  'Cek kondisi pelumasan & clearance.'],
        escalate: 'Perhatikan potensi bearing failure.' }),

    wear_ni: entry('wear',
      ['Valve / seat', 'Turbocharger', 'Alloy steel'],
      { likely: ['Keausan komponen paduan nikel'],
        actions: ['Pantau tren Ni bersama parameter terkait.'] },
      { likely: ['Keausan signifikan komponen nikel (valve/turbo)'],
        actions: ['Inspeksi valve, seat, dan turbocharger.',
                  'Cek end-play & kondisi turbo.'],
        escalate: 'Periksa turbo & top-end bila Ni terus naik.' }),

    /* ---------------- OIL CONDITION ---------------- */
    visc_v100: entry('oil',
      ['SAE grade', 'Degradasi oli'],
      { likely: ['Viskositas di luar rentang normal (mulai bergeser)',
                 'Oksidasi / soot loading atau fuel dilution mulai terlihat'],
        actions: ['Cek Fuel Dilution & Soot & Oxidation sebagai penyebab.',
                  'Verifikasi grade oli yang dipakai & interval ganti.'] },
      { likely: ['Viskositas sangat menyimpang (terlalu kental/encer)',
                 'Degradasi oli lanjut / kontaminasi fuel berat'],
        actions: ['Ganti oli & filter segera.',
                  'Cari penyebab: fuel dilution (injektor), soot, atau panas berlebih.',
                  'Lakukan analisis ulang setelah penggantian.'],
        escalate: 'Viskositas ekstrem mengancam film pelumasan — jangan ditunda.' }),

    visc_v40: entry('oil',
      ['SAE grade', 'Degradasi oli'],
      { likely: ['Pergeseran viskositas rendah (mulai)'],
        actions: ['Cek penyebab (fuel/soot/oksidasi).'] },
      { likely: ['Pergeseran viskositas signifikan'],
        actions: ['Ganti oli bila di luar spesifikasi.',
                  'Cek kontaminasi & degradasi.'],
        escalate: 'Selaraskan dengan spesifikasi viskositas manual.' }),

    tbn: entry('oil',
      ['Reserve alkalinity'],
      { likely: ['Cadangan alkalinitas mulai berkurang (netralisasi asam)',
                 'Interval ganti oli mendekati batas'],
        actions: ['Pantau tren TBN; pertimbangkan ganti oli lebih awal.',
                  'Cek kadar sulfur bahan bakar & kondisi operasi.'] },
      { likely: ['TBN rendah -> daya netralisasi asam habis',
                 'Risiko korosi & keausan akibat oli asam'],
        actions: ['Ganti oli & filter segera.',
                  'Verifikasi kualitas bahan bakar (sulfur).',
                  'Rutinkan sampling untuk memantau TBN.'],
        escalate: 'TBN habis -> risiko korosi internal; ganti oli tanpa ditunda.' }),

    water_pct: entry('oil',
      ['Kondensasi', 'Kebocoran coolant'],
      { likely: ['Kondensasi ringan / masuknya uap air',
                 'Kebocoran coolant kecil'],
        actions: ['Periksa sistem pendingin & breather.',
                  'Panaskan unit untuk menguapkan kondensasi (bila ringan).'] },
      { likely: ['Kontaminasi air/koolan signifikan',
                 'Kebocoran oil cooler / gasket head'],
        actions: ['Uji kebocoran sistem pendingin (pressure test).',
                  'Ganti oli (air merusak pelumasan & memicu korosi).',
                  'Periksa oil cooler & gasket head.'],
        escalate: 'Air > ambang kritis -> risiko emulsi & korosi; hentikan bila perlu.' }),

    fuel_pct: entry('oil',
      ['Injektor', 'Ring piston', 'Sistem bahan bakar'],
      { likely: ['Dilusi bahan bakar ringan (idle lama / stop-and-go)',
                 'Injektor mulai tidak optimal'],
        actions: ['Minimalkan idle berkepanjangan.',
                  'Pantau tren fuel dilution & viskositas.'] },
      { likely: ['Dilusi bahan bakar signifikan',
                 'Injektor bocor / ring aus / strategi bahan bakar salah'],
        actions: ['Uji injektor & periksa kebocoran.',
                  'Cek kompresi / ring piston.',
                  'Ganti oli dulu (viskositas menurun tajam).'],
        escalate: 'Fuel dilution tinggi menurunkan viskositas -> risiko keausan.' }),

    soot: entry('oil',
      ['Pembakaran', 'EGR', 'Filter udara'],
      { likely: ['Akumulasi soot mulai meningkat',
                 'Kualitas pembakaran / intake perlu perhatian'],
        actions: ['Periksa filter udara & kualitas pembakaran.',
                  'Pantau tren soot & viskositas.'] },
      { likely: ['Soot loading tinggi -> oli mengental, sludge',
                 'Masalah pembakaran / intake signifikan'],
        actions: ['Ganti oli & filter.',
                  'Periksa sistem intake, injektor, & pembakaran.',
                  'Evaluasi kondisi operasi (beban, putaran).'],
        escalate: 'Soot berlebih meningkatkan keausan & mempercepat degradasi oli.' }),

    oxidation: entry('oil',
      ['Panas berlebih', 'Umur oli'],
      { likely: ['Oksidasi oli mulai meningkat (panas/umur)'],
        actions: ['Cek suhu operasi & interval ganti oli.',
                  'Pantau viskositas & TBN.'] },
      { likely: ['Oksidasi lanjut -> varnish, sludge, keasaman naik'],
        actions: ['Ganti oli segera.',
                  'Periksa penyebab panas berlebih (cooling, beban).'],
        escalate: 'Oksidasi tinggi mempercepat keausan & memperpendek umur komponen.' }),

    nitration: entry('oil',
      ['Pembakaran', 'Gas buang'],
      { likely: ['Nitrasi mulai meningkat'],
        actions: ['Pantau bersama oksidasi & soot.'] },
      { likely: ['Nitrasi tinggi (indikasi pembakaran/gas buang)'],
        actions: ['Cek sistem pembakaran & EGR (bila ada).',
                  'Ganti oli bila di luar batas.'],
        escalate: 'Nitrasi tinggi mempercepat degradasi oli.' }),

    sulfation: entry('oil',
      ['Kualitas bahan bakar', 'Pembakaran'],
      { likely: ['Sulfasi mulai terbentuk'],
        actions: ['Verifikasi kualitas bahan bakar (sulfur).',
                  'Pantau bersama TBN.'] },
      { likely: ['Sulfasi tinggi (bahan bakar sulfur / pembakaran)'],
        actions: ['Periksa kualitas bahan bakar.',
                  'Ganti oli & pantau TBN.'],
        escalate: 'Sulfasi mengikis cadangan basa & memicu korosi.' }),

    /* ---------------- CLEANLINESS ---------------- */
    pqi: entry('clean',
      ['Particle Quantifier Index'],
      { likely: ['Peningkatan partikel (kebersihan mulai menurun)',
                 'Filter mulai klog / kontaminasi masuk'],
        actions: ['Periksa kondisi filter oli.',
                  'Cek titik masuk kontaminasi (breather, seal).'] },
      { likely: ['Tingkat partikel tinggi -> risiko keausan abrasif',
                 'Kontaminasi berat / filter tidak efektif'],
        actions: ['Ganti filter & oli bila perlu.',
                  'Periksa seluruh titik masuk kontaminasi.',
                  'Rutinkan sampling untuk verifikasi kebersihan.'],
        escalate: 'Partikel tinggi mempercepat keausan & merusak clearance presisi.' }),

    pc_4u: entry('clean', ['Particle count >4µm'],
      { likely: ['Partikel halus mulai meningkat'], actions: ['Periksa filtrasi & kebersihan oli.'] },
      { likely: ['Partikel halus tinggi'], actions: ['Ganti filter, cek sumber kontaminasi.'],
        escalate: 'Kebersihan oli di bawah target ISO.' }),

    pc_6u: entry('clean', ['Particle count >6µm'],
      { likely: ['Partikel sedang meningkat'], actions: ['Pantau kebersihan & filtrasi.'] },
      { likely: ['Partikel sedang tinggi'], actions: ['Evaluasi filter & kontaminasi.'],
        escalate: 'Kebersihan oli di bawah target ISO.' }),

    pc_14u: entry('clean', ['Particle count >14µm'],
      { likely: ['Partikel besar meningkat'], actions: ['Periksa sumber keausan/kontaminasi.'] },
      { likely: ['Partikel besar tinggi -> keausan']  ,
        actions: ['Inspeksi komponen bergerak & filtrasi.'],
        escalate: 'Partikel besar mengindikasikan keausan aktif.' }),

    pc_21u: entry('clean', ['Particle count >21µm'],
      { likely: ['Partikel besar kritis'], actions: ['Segera periksa sumber keausan.'] },
      { likely: ['Partikel besar sangat tinggi'], actions: ['Inspeksi menyeluruh; ganti oli/filter.'],
        escalate: 'Risiko keausan berat — prioritaskan inspeksi.' }),

    /* ---------------- ADDITIVES ---------------- */
    additive_p:  entry('additive', ['ZDDP'], { likely: ['Kadar phosphorus mulai turun (aditif terpakai)'], actions: ['Pantau bersama Zn & TBN.'] }, { likely: ['Aditif anti-aus habis'], actions: ['Ganti oli.'], escalate: 'Proteksi anti-aus menurun.' }),
    additive_zn: entry('additive', ['ZDDP'], { likely: ['Zinc (anti-aus) mulai turun'], actions: ['Pantau bersama P & TBN.'] }, { likely: ['Aditif anti-aus habis'], actions: ['Ganti oli.'], escalate: 'Proteksi anti-aus menurun.' }),
    additive_ca: entry('additive', ['Detergent'], { likely: ['Calcium (detergen) bergeser'], actions: ['Cek bersama TBN & Mg.'] }, { likely: ['Keseimbangan aditif terganggu'], actions: ['Ganti oli, verifikasi grade.'], escalate: 'Kondisi oli perlu evaluasi.' }),
    additive_mg: entry('additive', ['Detergent'], { likely: ['Magnesium bergeser'], actions: ['Pantau bersama Ca & TBN.'] }, { likely: ['Keseimbangan aditif terganggu'], actions: ['Ganti oli.'], escalate: '-' }),
    additive_mo: entry('additive', ['Mo-Friction modifier'], { likely: ['Molybdenum bergeser'], actions: ['Pantau tren.'] }, { likely: ['Modifier fraksi bergeser'], actions: ['Cek grade oli.'], escalate: '-' }),
    additive_b:  entry('additive', ['Boron (dispersant)'], { likely: ['Boron bergeser; bila tinggal jejak cek coolant (B dalam coolant)'], actions: ['Bila B & Na/K naik -> curiga coolant.'], }, { likely: ['Kontaminasi coolant (borat)'], actions: ['Uji glycol/ coolant infiltration.'], escalate: 'Cek sistem pendingin.' }),
    additive_na: entry('additive', ['Sodium (detergen/kontaminan)'], { likely: ['Sodium tinggi bisa dari aditif ATAU coolant'], actions: ['Bila bersama K/B -> curiga coolant, bukan aditif.'], }, { likely: ['Indikasi kuat kontaminasi coolant'], actions: ['Uji glycol & pressure test pendingin.'], escalate: 'Konfirmasi kebocoran coolant.' }),
    additive_ba: entry('additive', ['Barium (detergen)'], { likely: ['Barium bergeser'], actions: ['Pantau tren.'] }, { likely: ['Kondisi aditif terganggu'], actions: ['Cek grade & ganti bila perlu.'], escalate: '-' })
  };

  /* -----------------------------------------------------------------------
   * 2. Pencarian & rekomendasi berbasis KB
   * --------------------------------------------------------------------- */
  function findEntry(paramKey) {
    return KB[paramKey] || null;
  }

  /* -----------------------------------------------------------------------
   * RUJUKAN DOKUMEN per parameter — untuk blok "Rujukan" pada laporan.
   * Berisi panduan teknis/manual/SOP yang relevan sebagai dasar tindakan.
   * Bila tidak ada entri spesifik, dipakai Rujukan default (lihat recommend).
   * --------------------------------------------------------------------- */
  var REF_SOP_GENERAL = 'SOP Condition Monitoring & Oil Sampling (interval 250 jam)';
  var REFS = {
    /* WEAR METALS */
    wear_fe: ['Komatsu Shop Manual — Engine: Piston Ring / Cylinder Liner Wear',
              'Komatsu Technical Bulletin — Blowby & Compression Diagnostics'],
    wear_cu: ['Komatsu Shop Manual — Bearing (Cu-Pb) & Oil Cooler',
              'SOP inspeksi bearing utama / connecting rod'],
    wear_al: ['Komatsu Shop Manual — Piston & Bearing Shell (Aluminium)',
              'SOP inspeksi sistem intake & pembersihan'],
    wear_cr: ['Komatsu Shop Manual — Piston Ring (Chrome-plated) & Liner',
              'SOP uji kontaminasi coolant (glycol test)'],
    wear_pb: ['Komatsu Shop Manual — Bearing Overlay (Pb) / Babbitt',
              'SOP evaluasi clearance & jadwal ganti bearing'],
    wear_si: ['Komatsu Shop Manual — Air Cleaner & Intake System',
              'SOP Dirt Entry Index (Si + Al)'],
    wear_sn: ['Komatsu Shop Manual — Bearing (Cu-Pb-Sn)',
              'SOP inspeksi bearing & kondisi pelumasan'],
    wear_ni: ['Komatsu Shop Manual — Valve Train & Turbocharger',
              'SOP inspeksi end-play turbo & top-end overhaul'],
    /* OIL CONDITION */
    visc_v100: ['Komatsu Shop Manual — Lubrication: Spesifikasi Viskositas',
                'SOP analisis degradasi oli (fuel dilution / soot / oksidasi)'],
    visc_v40: ['Komatsu Shop Manual — Lubrication: Spesifikasi Viskositas'],
    tbn: ['Komatsu Shop Manual — Lubrication: TBN & Interval Ganti Oli',
          'SOP verifikasi kualitas bahan bakar (sulfur)'],
    water_pct: ['Komatsu Shop Manual — Cooling System: Coolant Leak Test',
                'SOP pressure test sistem pendingin'],
    fuel_pct: ['Komatsu Shop Manual — Fuel System: Injector Test',
               'SOP uji injektor & kebocoran bahan bakar'],
    soot: ['Komatsu Shop Manual — Engine: Combustion & Intake',
           'SOP pemeriksaan filter udara & pembakaran'],
    oxidation: ['Komatsu Shop Manual — Lubrication: Oil Oxidation',
                'SOP evaluasi suhu operasi & interval ganti oli'],
    nitration: ['Komatsu Shop Manual — Engine: Combustion / EGR',
                'SOP analisis degradasi oli'],
    sulfation: ['Komatsu Shop Manual — Fuel Quality & Lubrication',
                'SOP verifikasi bahan bakar (sulfur) & pemantauan TBN'],
    /* CLEANLINESS */
    pqi: ['Komatsu Shop Manual — Lubrication: Filtration & Cleanliness',
          'ISO 4406 — Target kebersihan oli'],
    pc_4u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP filtrasi oli'],
    pc_6u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP filtrasi oli'],
    pc_14u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP inspeksi sumber keausan'],
    pc_21u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP inspeksi komponen bergerak'],
    /* ADDITIVES */
    additive_p: ['Komatsu Shop Manual — Lubrication: Additive (ZDDP)'],
    additive_zn: ['Komatsu Shop Manual — Lubrication: Additive (ZDDP)'],
    additive_ca: ['Komatsu Shop Manual — Lubrication: Detergent Additive'],
    additive_mg: ['Komatsu Shop Manual — Lubrication: Detergent Additive'],
    additive_mo: ['Komatsu Shop Manual — Lubrication: Friction Modifier'],
    additive_b: ['Komatsu Shop Manual — Cooling System: Coolant Infiltration'],
    additive_na: ['Komatsu Shop Manual — Cooling System: Coolant Infiltration',
                  'SOP uji glycol & pressure test pendingin'],
    additive_ba: ['Komatsu Shop Manual — Lubrication: Detergent Additive']
  };

  /** Ambil rujukan dokumen untuk sebuah parameter (fallback ke SOP umum). */
  function refsFor(paramKey) {
    var r = REFS[paramKey];
    if (r && r.length) return r.slice();
    return [REF_SOP_GENERAL];
  }

  /**
   * Bangun rekomendasi untuk satu parameter yang berstatus tertentu.
   * @param {string} paramKey
   * @param {number} severity  1 = warn, 2 = crit, 4 = extreme
   * @param {object} [opts]    { label, value, unit, trend }
   * @returns {object}
   */
  function recommend(paramKey, severity, opts) {
    opts = opts || {};
    var data = findEntry(paramKey);
    var level = severity >= 2 ? 'critical' : 'warn';

    var likely = [], actions = [], escalate = '';
    if (data) {
      var block = data[level] || data.warn || {};
      likely = (block.likely || []).slice();
      actions = (block.actions || []).slice();
      escalate = block.escalate || '';
    }
    if (!actions.length) {
      actions = ['Lakukan inspeksi parameter ini sesuai prosedur laboratorium/SOP.',
                 'Catat tren nilai terhadap HM/meter untuk evaluasi berkala.'];
    }

    // Konteks tren (ROW100) bila tersedia
    if (opts.trend === 'up') {
      actions.push('Tren MENINGKAT — pantau lebih ketat pada sampling berikutnya.');
    } else if (opts.trend === 'down') {
      actions.push('Tren MENURUN — indikasi degradasi, pantau ketat.');
    }

    return {
      param: paramKey,
      label: opts.label || paramKey,
      value: (opts.value === undefined ? null : opts.value),
      unit: opts.unit || '',
      severity: severity,
      level: level,
      likely: likely,
      actions: actions,
      escalate: escalate,
      refs: refsFor(paramKey),                          // [RUJUKAN] dokumen/SOP
      components: (data && data.refs) ? data.refs.slice() : [],  // komponen terkait
      fromKB: !!data
    };
  }

  /* -----------------------------------------------------------------------
   * 3. RULE-BASED: konteks LIFETIME & TOP-UP OIL
   * ---------------------------------------------------------------------
   * Menghasilkan rekomendasi tambahan di luar KB parameter, berdasar:
   *   - ComponentLife(%) dari data Lifetime
   *   - Volume Top-Up Oil (indikasi konsumsi oli abnormal)
   * @param {object} ctx {
   *   component, lifePct, remainingHours, cycleBudget,
   *   topupQty, topupCount, topupPerHour, topupLastDate
   * }
   * @returns {array} daftar { title, detail, level }
   * --------------------------------------------------------------------- */
  function ruleBased(contexts) {
    var out = [];
    (contexts || []).forEach(function (c) {
      // --- Rule: LIFE % ---
      if (typeof c.lifePct === 'number') {
        if (c.lifePct >= 100) {
          out.push({
            level: 'critical',
            title: 'Life komponen ' + (c.component || '') + ' sudah ' + c.lifePct + '%',
            detail: 'Umur komponen melampaui cycle budget (' + (c.cycleBudget || '-') + ' jam). ' +
                    'Jadwalkan penggantian/overhaul; risiko kegagalan meningkat.'
          });
        } else if (c.lifePct >= 80) {
          out.push({
            level: 'warning',
            title: 'Life komponen ' + (c.component || '') + ' mendekati batas (' + c.lifePct + '%)',
            detail: 'Siapkan rencana penggantian sebelum mencapai cycle budget.' +
                    (c.remainingHours !== null && c.remainingHours !== undefined
                      ? ' Sisa ±' + Math.round(c.remainingHours) + ' jam.' : '')
          });
        }
      }

      // --- Rule: TOP UP OIL ---
      // Deteksi konsumsi oli tinggi (indikasi kebocoran / blow-by / keausan).
      if (c.topupCount > 0 && typeof c.topupQty === 'number') {
        // Ambang sederhana: total top up dalam data dianggap tinggi bila
        // melebihi volume referensi (fallback 50 L) -> sesuaikan per kompartemen.
        var refVol = (c.refVolume && c.refVolume > 0) ? c.refVolume : 50;
        if (c.topupQty >= refVol * 2) {
          out.push({
            level: 'critical',
            title: 'Konsumsi top-up ' + (c.component || '') + ' tinggi (' + c.topupQty + ' L)',
            detail: 'Total penambahan oli ' + c.topupQty + ' L dalam ' + c.topupCount +
                    ' transaksi. Curigai kebocoran / over-consumption (blow-by, seal, oil cooler). ' +
                    'Periksa titik kebocoran & bandingkan dengan kapasitas sistem.'
          });
        } else if (c.topupQty > 0 && c.topupQty >= refVol) {
          out.push({
            level: 'warning',
            title: 'Ada aktivitas top-up ' + (c.component || '') + ' (' + c.topupQty + ' L)',
            detail: 'Terdapat penambahan oli (mungkin normal). Pantau tren konsumsi ' +
                    'dibandingkan interval servis.'
          });
        }
      }
    });
    return out;
  }

  /* ----------------------------------------------------------------------- */
  global.SOS_KNOWLEDGE = {
    KB: KB,
    REFS: REFS,
    findEntry: findEntry,
    refsFor: refsFor,
    recommend: recommend,
    ruleBased: ruleBased
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

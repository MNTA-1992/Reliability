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

  function entry(group, refs, warn, crit, severe) {
    return {
      group: group,
      refs: refs || [],
      warn: warn || { likely: [], actions: [] },
      critical: crit || { likely: [], actions: [] },
      // [REVISI 2026-09-30] Tier ke-3 (severity 4 = status Critical).
      // Bila tidak diisi, `recommend()` otomatis memakai `critical` sebagai
      // fallback (backward-compatible) — jadi entry lama tetap aman.
      severe: severe || null
    };
  }

  /* -----------------------------------------------------------------------
   * 1. KNOWLEDGE BASE per parameter SOS
   * --------------------------------------------------------------------- */
  var KB = {
    /* ---------------- WEAR METALS ---------------- */
    wear_fe: entry('wear',
      ['Piston ring / liner', 'Gear & bearing wear'],
      // [TIER 1 — Monitor] Sedikit di atas batas: cukup INSPEKSI RINGAN, belum bongkar.
      { likely: ['Kenaikan Fe ringan — seringkali keausan normal/break-in, variasi sampling, atau awal tren naik',
                 'Belum tentu kerusakan: nilai tunggal di atas batas ringan perlu dikonfirmasi tren'],
        actions: ['INSPEKSI RINGAN dulu: cek riwayat Fe (tren/ROW₁₀₀) — apakah naik bertahap atau lonjakan sesaat.',
                  'Periksa kondisi air cleaner & jalur intake (bila Si juga naik).',
                  'Verifikasi jam oli (HM oil) & riwayat penambahan/penggantian oli.',
                  'Ambil sampel ulang pada interval normal (250 jam) untuk konfirmasi — BELUM perlu bongkar.'] },
      // [TIER 2 — Caution] Jelas melewati batas: inspeksi terarah + setel/adjust.
      { likely: ['Keausan mulai nyata pada ring/liner atau komponen bergerak — perlu tindak lanjut terarah',
                 'Indikasi awaI keausan; belum tentu komponen utama harus dibongkar'],
        actions: ['INSPEKSI TERARAH: periksa valve mechanism (clearance, kebocoran kompresi) — tidak perlu turun mesin.',
                  'ADJUST bila perlu: setel valve clearance sesuai spesifikasi manual.',
                  'Periksa tekanan oli & suara mesin tidak normal (deteksi dini).',
                  'Periksa filter oli (buka/potong) untuk serpihan logam.',
                  'Persingkat interval sampling (100–150 jam) untuk memantau laju kenaikan.'] },
      // [TIER 3 — Critical] Tinggi + bukti pendukung: baru deep-dive.
      { likely: ['Keausan signifikan piston ring / cylinder liner / bearing internal (biasanya DISERTAI kenaikan Cr, Cu, Pb, atau Si, dan blowby tinggi)',
                 'Kontaminasi besi dari komponen aus (abrasive) bila bersama Si/Al tinggi',
                 'Lonjakan Fe tajam antar-sampel (laju keausan akseleratif)'],
        actions: ['DEEP-DIVE (setelah tier di atas & konfirmasi bukti pendukung): inspeksi borescope silinder & ukur end-gap ring.',
                  'Cut-open filter oli & periksa partikel/serpihan logam (metode utama pada engine; engine umumnya tidak memiliki magnetic plug).',
                  'Kompression/blowby test & analisis lanjutan (oil debris) bila tersedia.',
                  'Siapkan rencana overhaul terukur bila tren Fe terus naik & didukung Cr/Cu/Pb.'],
        escalate: 'Batasi operasi berat & jadwalkan inspeksi mekanik segera — HANYA bila Fe tinggi disertai bukti pendukung (bukan nilai tunggal).' }),

    wear_cu: entry('wear',
      ['Bearing (Cu-Pb)', 'Oil cooler', 'Bushing'],
      // TIER 1 — Monitor
      { likely: ['Cu sedikit naik — bisa dari keausan normal bushing/bearing atau residu awal',
                 'Belum spesifik: perlu dibedakan dari kontaminasi oil cooler'],
        actions: ['INSPEKSI RINGAN: pantau tren Cu & Sn (bila ada) untuk lokalisasi sumber.',
                  'Periksa kebersihan & integritas oil cooler secara visual.',
                  'Konfirmasi ulang pada sampling berikutnya sebelum tindakan lebih jauh.'] },
      // TIER 2 — Caution
      { likely: ['Keausan bushing/bearing kuningan mulai nyata',
                 'Awal kontaminasi dari oil cooler atau seal'],
        actions: ['INSPEKSI TERARAH: uji tekanan & periksa kebocoran oil cooler (pressure/leak test).',
                  'Cek clearance & kondisi pelumasan bearing yang terjangkau.',
                  'Persingkat interval sampling & pantau tren Cu bersama Pb/Sn.'] },
      // TIER 3 — Critical
      { likely: ['Keausan bearing Cu-Pb signifikan / kebocoran internal oil cooler yang berlanjut',
                 'Kontaminasi dari bantalan/cage yang aus (biasanya disertai Pb/Sn naik)'],
        actions: ['DEEP-DIVE: inspeksi bearing utama & connecting rod (bila bukti pendukung kuat).',
                  'Analisis lanjutan (debris/SEM-EDS) & evaluasi jadwal ganti bearing.',
                  'Perbaiki sumber kontaminasi (oil cooler/seal) secara menyeluruh.'],
        escalate: 'Waspadai indikasi bearing failure — siapkan shutdown terkendali bila didukung Pb/Sn & tren naik.' }),

    wear_al: entry('wear',
      ['Piston (aluminium)', 'Housing', 'Bearing shell'],
      // TIER 1 — Monitor
      { likely: ['Al sedikit naik — bisa keausan ringan komponen aluminium atau awal ingesti debu',
                 'Perlu dibedakan: dirt (bersama Si) vs wear komponen'],
        actions: ['INSPEKSI RINGAN: bandingkan Al dengan Silika (Si) — bila keduanya naik, curiga debu.',
                  'Pantau tren Aluminium (Al) antar sampling.'] },
      // TIER 2 — Caution
      { likely: ['Keausan aluminium/piston mulai nyata',
                 'Indikasi awal ingesti debu'],
        actions: ['INSPEKSI TERARAH: periksa sistem intake & lakukan pembersihan bila kotor.',
                  'Cek & kencangkan clamp/hose jalur intake (potensi kebocoran debu).',
                  'Hitung Dirt Entry Index (Si + Al) & pantau trennya.'] },
      // TIER 3 — Critical
      { likely: ['Keausan piston/shell bearing signifikan (disertai Fe/Si naik)',
                 'Ingesti debu abrasif berkelanjutan (Dirt Entry tinggi)'],
        actions: ['DEEP-DIVE: inspeksi piston/skirt & bearing shell + borescope silinder.',
                  'Inspeksi menyeluruh jalur intake & intercooler; perbaiki kebocoran.',
                  'Konfirmasi kontaminasi debu (Si & Al tinggi bersamaan).'],
        escalate: 'Cegah ingesti debu sebelum keausan linier meluas — konfirmasi & perbaiki jalur intake segera.' }),

    wear_cr: entry('wear',
      ['Ring (chrome-plated)', 'Liner', 'Seal'],
      // TIER 1 — Monitor
      { likely: ['Cr sedikit naik — awal keausan coating chromium ring/liner',
                 'Perlu cek apakah disertai indikasi coolant (Na/K/B)'],
        actions: ['INSPEKSI RINGAN: pantau tren Cr & cek keberadaan indikasi coolant infiltration.',
                  'Periksa kondisi ring & liner saat kesempatan (bila ada akses).'] },
      // TIER 2 — Caution
      { likely: ['Keausan lapisan chromium mulai nyata',
                 'Kemungkinan awal kebocoran coolant ke oli'],
        actions: ['INSPEKSI TERARAH: uji kontaminasi coolant (glycol test, K, B).',
                  'Periksa gasket head & oil cooler (indikasi visual).',
                  'Pantau Cr bersama Fe & indikator coolant.'] },
      // TIER 3 — Critical
      { likely: ['Keausan lapisan chromium signifikan',
                 'Kebocoran coolant ke oli (glycol contamination) yang berlanjut'],
        actions: ['DEEP-DIVE: inspeksi ring, liner, dan sistem pendingin secara menyeluruh.',
                  'Perbaiki sumber kebocoran (gasket head / oil cooler / seal).',
                  'Ganti oli bila terjadi emulsi; coolant merusak pelumasan.'],
        escalate: 'Segera cek sistem pendingin bila curiga coolant masuk oli (Na/K/B juga tinggi).' }),

    wear_pb: entry('wear',
      ['Bearing overlay (Pb)', 'Seal', 'Babbitt'],
      // TIER 1 — Monitor
      { likely: ['Pb sedikit naik — awal keausan overlay bearing',
                 'Sering bergerak bersama Cu (pantau keduanya)'],
        actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu (sering bersamaan).',
                  'Cek kondisi oli (viskositas, TBN) yang mempengaruhi umur bearing.'] },
      // TIER 2 — Caution
      { likely: ['Keausan overlay bearing mulai signifikan',
                 'Perlu evaluasi clearance & pelumasan'],
        actions: ['INSPEKSI TERARAH: cek clearance & kondisi pelumasan bearing.',
                  'Periksa tekanan oli & suara abnormal (tanpa bongkar penuh).',
                  'Persingkat interval sampling & pantau laju kenaikan Pb.'] },
      // TIER 3 — Critical
      { likely: ['Keausan overlay Pb kritis — risiko bearing failure bila terus beroperasi',
                 'Overlay menipis (disertai Cu/Sn naik)'],
        actions: ['DEEP-DIVE: inspeksi bearing utama & rod menyeluruh (konfirmasi bukti pendukung).',
                  'Evaluasi jadwal penggantian bearing & clearance.',
                  'Verifikasi kualitas oli (viskositas/TBN) sebelum operasi lanjut.'],
        escalate: 'Jangan abaikan — overlay Pb habis dapat menyebabkan metal-to-metal.' }),

    wear_si: entry('wear',
      ['Ingesti debu', 'Gasket/seal silicon', 'Additive (anti-foam)'],
      // TIER 1 — Monitor
      { likely: ['Si sedikit naik — awal ingesti debu / RTV / residu additive anti-foam (kadar rendah)',
                 'Perlu dibedakan: dirt vs sealant'],
        actions: ['INSPEKSI RINGAN: periksa & ganti elemen air cleaner bila perlu.',
                  'Cek integritas jalur intake setelah filter (visual).',
                  'Bandingkan dengan Aluminium (Al) — bila keduanya tinggi, kuat indikasi debu masuk.'] },
      // TIER 2 — Caution
      { likely: ['Ingesti debu mulai nyata',
                 'Kemungkinan kebocoran kecil jalur intake / seal'],
        actions: ['INSPEKSI TERARAH: periksa clamp, hose, boot intake — perbaiki kebocoran ringan.',
                  'Ganti elemen filter udara bila kotor; pastikan pemasangan benar.',
                  'Hitung & pantau Dirt Entry Index (Si + Al).'] },
      // TIER 3 — Critical
      { likely: ['Ingesti debu abrasif berkelanjutan (Dirt Entry tinggi)',
                 'Kerusakan seal/gasket terkait (disertai keausan Fe/Al)'],
        actions: ['DEEP-DIVE: inspeksi menyeluruh sistem intake & intercooler.',
                  'Perbaiki seluruh titik kebocoran; ganti komponen seal yang rusak.',
                  'Pantau Dirt Entry Index pasca-perbaikan untuk verifikasi.'],
        escalate: 'Hentikan sumber ingesti debu sebelum keausan linier meluas (bila Si & Al terus naik).' }),

    wear_sn: entry('wear',
      ['Bearing (Cu-Pb-Sn)', 'Piston ring coating'],
      // TIER 1 — Monitor
      { likely: ['Sn sedikit naik — keausan ringan komponen berbasis timah'],
        actions: ['INSPEKSI RINGAN: pantau tren Sn bersama Cu/Pb.',
                  'Periksa bearing terkait bila ada akses.'] },
      // TIER 2 — Caution
      { likely: ['Keausan komponen Sn mulai nyata'],
        actions: ['INSPEKSI TERARAH: periksa bearing terkait & kondisi pelumasan.',
                  'Pantau tren Sn bersama Cu/Pb untuk lokalisasi.'] },
      // TIER 3 — Critical
      { likely: ['Keausan bearing Sn signifikan — risiko bearing damage'],
        actions: ['DEEP-DIVE: inspeksi bearing utama (konfirmasi bukti pendukung).',
                  'Cek kondisi pelumasan & clearance.'],
        escalate: 'Perhatikan potensi bearing failure bila Sn terus naik.' }),

    wear_ni: entry('wear',
      ['Valve / seat', 'Turbocharger', 'Alloy steel'],
      // TIER 1 — Monitor
      { likely: ['Ni sedikit naik — awal keausan komponen paduan nikel'],
        actions: ['INSPEKSI RINGAN: pantau tren Ni bersama parameter terkait.'] },
      // TIER 2 — Caution
      { likely: ['Keausan komponen nikel mulai nyata (valve/turbo)'],
        actions: ['INSPEKSI TERARAH: periksa valve & seat (clearance), cek end-play turbo.',
                  'Periksa suara abnormal & performa turbo.'] },
      // TIER 3 — Critical
      { likely: ['Keausan signifikan komponen nikel (valve/turbo)'],
        actions: ['DEEP-DIVE: inspeksi valve, seat, dan turbocharger menyeluruh.'],
        escalate: 'Periksa turbo & top-end bila Ni terus naik.' }),

    /* ---------------- OIL CONDITION ---------------- */
    visc_v100: entry('oil',
      ['SAE grade', 'Degradasi oli'],
      // TIER 1 — Monitor
      { likely: ['Viskositas mulai bergeser (masih dekat rentang) — awal oksidasi/soot/fuel dilution',
                 'Bisa juga variasi sampling atau grade oli'],
        actions: ['INSPEKSI RINGAN: cek Fuel Dilution, Soot & Oxidation sebagai penyebab potensial.',
                  'Verifikasi grade oli yang dipakai & interval ganti.',
                  'Konfirmasi pada sampling berikutnya.'] },
      // TIER 2 — Caution
      { likely: ['Viskositas menyimpang nyata — degradasi/degradasi mulai berdampak pada film pelumasan'],
        actions: ['INSPEKSI TERARAH: cari penyebab dominan (fuel dilution / soot / panas).',
                  'Pertimbangkan ganti oli lebih awal & verifikasi grade.',
                  'Cek kondisi operasi (beban, suhu) yang mempercepat degradasi.'] },
      // TIER 3 — Critical
      { likely: ['Viskositas sangat menyimpang (terlalu kental/encer) — degradasi lanjut / kontaminasi fuel berat'],
        actions: ['DEEP-DIVE: ganti oli & filter segera.',
                  'Cari akar penyebab: injektor (fuel dilution), soot tinggi, atau panas berlebih.',
                  'Analisis ulang setelah penggantian untuk verifikasi.'],
        escalate: 'Viskositas ekstrem mengancam film pelumasan — jangan ditunda.' }),

    visc_v40: entry('oil',
      ['SAE grade', 'Degradasi oli'],
      { likely: ['Pergeseran viskositas rendah (mulai)'],
        actions: ['INSPEKSI RINGAN: cek penyebab (fuel/soot/oksidasi).',
                  'Pantau tren viskositas.'] },
      { likely: ['Pergeseran viskositas sedang'], actions: ['INSPEKSI TERARAH: ganti oli bila di luar spesifikasi.', 'Cek kontaminasi & degradasi.'] },
      { likely: ['Pergeseran viskositas signifikan'], actions: ['DEEP-DIVE: ganti oli & filter; selaraskan dengan spesifikasi manual.'],
        escalate: 'Selaraskan dengan spesifikasi viskositas manual.' }),

    tbn: entry('oil',
      ['Reserve alkalinity'],
      { likely: ['Cadangan alkalinitas mulai berkurang (netralisasi asam)'],
        actions: ['INSPEKSI RINGAN: pantau tren TBN; pertimbangkan ganti oli lebih awal.',
                  'Cek kadar sulfur bahan bakar & kondisi operasi.'] },
      { likely: ['TBN menurun nyata — daya netralisasi asam menipis'],
        actions: ['INSPEKSI TERARAH: siapkan ganti oli & filter.',
                  'Verifikasi kualitas bahan bakar (sulfur); pantau bersama oksidasi.'] },
      { likely: ['TBN rendah -> daya netralisasi asam habis',
                 'Risiko korosi & keausan akibat oli asam'],
        actions: ['DEEP-DIVE: ganti oli & filter segera.',
                  'Rutinkan sampling untuk memantau TBN pasca-ganti.'],
        escalate: 'TBN habis -> risiko korosi internal; ganti oli tanpa ditunda.' }),

    water_pct: entry('oil',
      ['Kondensasi', 'Kebocoran coolant'],
      { likely: ['Kondensasi ringan / masuknya uap air', 'Kebocoran coolant kecil'],
        actions: ['INSPEKSI RINGAN: periksa sistem pendingin & breather.',
                  'Panaskan unit untuk menguapkan kondensasi (bila ringan).'] },
      { likely: ['Kontaminasi air mulai nyata'],
        actions: ['INSPEKSI TERARAH: cek titik masuk air (breather, seal, filler cap).',
                  'Pantau kadar air & kondisi oli (kekeruhan).'] },
      { likely: ['Kontaminasi air/coolant signifikan', 'Kebocoran oil cooler / gasket head'],
        actions: ['DEEP-DIVE: uji kebocoran sistem pendingin (pressure test).',
                  'Ganti oli (air merusak pelumasan & memicu korosi).',
                  'Periksa oil cooler & gasket head menyeluruh.'],
        escalate: 'Air > ambang kritis -> risiko emulsi & korosi; hentikan bila perlu.' }),

    fuel_pct: entry('oil',
      ['Injektor', 'Ring piston', 'Sistem bahan bakar'],
      { likely: ['Dilusi bahan bakar ringan (idle lama / stop-and-go)', 'Injektor mulai tidak optimal'],
        actions: ['INSPEKSI RINGAN: minimalkan idle berkepanjangan.',
                  'Pantau tren fuel dilution & viskositas.'] },
      { likely: ['Dilusi bahan bakar sedang — viskositas mulai turun'],
        actions: ['INSPEKSI TERARAH: uji injektor (spray/leak) tanpa bongkar penuh.',
                  'Cek strategi bahan bakar & pola operasi.',
                  'Pantau viskositas: bila turun tajam, pertimbangkan ganti oli.'] },
      { likely: ['Dilusi bahan bakar signifikan', 'Injektor bocor / ring aus / strategi bahan bakar salah'],
        actions: ['DEEP-DIVE: uji injektor & periksa kebocoran; cek kompresi/ring piston.',
                  'Ganti oli (viskositas menurun tajam).'],
        escalate: 'Fuel dilution tinggi menurunkan viskositas -> risiko keausan.' }),

    soot: entry('oil',
      ['Pembakaran', 'EGR', 'Filter udara'],
      { likely: ['Akumulasi soot mulai meningkat'],
        actions: ['INSPEKSI RINGAN: periksa filter udara & kualitas pembakaran.',
                  'Pantau tren soot & viskositas.'] },
      { likely: ['Soot loading sedang — mulai memengaruhi viskositas'],
        actions: ['INSPEKSI TERARAH: periksa sistem intake & pola pembakaran.',
                  'Pantau bersama viskositas & TBN.'] },
      { likely: ['Soot loading tinggi -> oli mengental, sludge', 'Masalah pembakaran / intake signifikan'],
        actions: ['DEEP-DIVE: ganti oli & filter.',
                  'Periksa sistem intake, injektor, & pembakaran menyeluruh.',
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

    oxidation: entry('oil',
      ['Panas berlebih', 'Umur oli'],
      { likely: ['Oksidasi oli mulai meningkat (panas/umur)'],
        actions: ['INSPEKSI RINGAN: cek suhu operasi & interval ganti oli.',
                  'Pantau viskositas & TBN.'] },
      { likely: ['Oksidasi sedang — mulai membentuk varnish'],
        actions: ['INSPEKSI TERARAH: identifikasi sumber panas berlebih (cooling, beban).',
                  'Pertimbangkan ganti oli lebih awal; pantau viskositas.'] },
      { likely: ['Oksidasi lanjut -> varnish, sludge, keasaman naik'],
        actions: ['DEEP-DIVE: ganti oli segera.',
                  'Perbaiki penyebab panas berlebih (cooling, beban) secara menyeluruh.'],
        escalate: 'Oksidasi tinggi mempercepat keausan & memperpendek umur komponen.' }),

    nitration: entry('oil',
      ['Pembakaran', 'Gas buang'],
      { likely: ['Nitrasi mulai meningkat'],
        actions: ['INSPEKSI RINGAN: pantau bersama oksidasi & soot.'] },
      { likely: ['Nitrasi sedang — indikasi pembakaran/gas buang'],
        actions: ['INSPEKSI TERARAH: cek sistem pembakaran & EGR (bila ada).',
                  'Pantau tren nitrasi & viskositas.'] },
      { likely: ['Nitrasi tinggi (indikasi pembakaran/gas buang)'],
        actions: ['DEEP-DIVE: cek & perbaiki sistem pembakaran/EGR; ganti oli bila di luar batas.'],
        escalate: 'Nitrasi tinggi mempercepat degradasi oli.' }),

    sulfation: entry('oil',
      ['Kualitas bahan bakar', 'Pembakaran'],
      { likely: ['Sulfasi mulai terbentuk'],
        actions: ['INSPEKSI RINGAN: verifikasi kualitas bahan bakar (sulfur); pantau bersama TBN.'] },
      { likely: ['Sulfasi sedang — cadangan basa mulai terkuras'],
        actions: ['INSPEKSI TERARAH: verifikasi bahan bakar (sulfur); pantau TBN bersama sulfasi.'] },
      { likely: ['Sulfasi tinggi (bahan bakar sulfur / pembakaran)'],
        actions: ['DEEP-DIVE: perbaiki kualitas bahan bakar; ganti oli & pantau TBN.'],
        escalate: 'Sulfasi mengikis cadangan basa & memicu korosi.' }),

    /* ---------------- CLEANLINESS ---------------- */
    pqi: entry('clean',
      ['Particle Quantifier Index'],
      { likely: ['Peningkatan partikel (kebersihan mulai menurun)',
                 'Filter mulai klog / kontaminasi masuk'],
        actions: ['INSPEKSI RINGAN: periksa kondisi filter oli.',
                  'Cek titik masuk kontaminasi (breather, seal).'] },
      { likely: ['Partikel sedang tinggi — filter mulai tidak efektif'],
        actions: ['INSPEKSI TERARAH: periksa & bersihkan titik masuk kontaminasi.',
                  'Pertimbangkan ganti filter lebih awal.',
                  'Pantau tren PQI antar sampling.'] },
      { likely: ['Tingkat partikel tinggi -> risiko keausan abrasif',
                 'Kontaminasi berat / filter tidak efektif'],
        actions: ['DEEP-DIVE: ganti filter & oli.',
                  'Periksa seluruh titik masuk kontaminasi & komponen bergerak.',
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
    additive_na: entry('additive',
      ['Sodium (Na) — aditif ATAU kontaminan coolant',
       'Indikator kebocoran coolant / water pump / head gasket'],
      { likely: ['Sodium mulai meningkat — bisa dari aditif detergen ATAU awal masuknya coolant',
                 'Kontaminasi eksternal ringan (jalan air/debu bergaram)'],
        actions: ['Bandingkan Sodium (Na) dengan Kalium (K) & Boron (B) — bila sama-sama naik, indikasi coolant.',
                  'Cek kadar Water (%) & kondisi oli (emulsi, kekeruhan).',
                  'Catat tren Na antar sampling untuk membedakan aditif vs kontaminan.'] },
      { likely: ['Indikasi kuat kontaminasi coolant (Na tinggi, sering bersama Water/K/B)',
                 'Kebocoran dari head gasket, oil cooler, atau seal water pump'],
        actions: ['Uji glycol & lakukan pressure test sistem pendingin.',
                  'Periksa head gasket, cooler core, & seal water pump.',
                  'Ganti oli bila terjadi emulsi; coolant merusak pelumasan & memicu korosi bearing.'],
        escalate: 'Kebocoran coolant merusak bearing & seal — konfirmasi & perbaiki segera.' }),
    additive_ba: entry('additive', ['Barium (detergen)'], { likely: ['Barium bergeser'], actions: ['Pantau tren.'] }, { likely: ['Kondisi aditif terganggu'], actions: ['Cek grade & ganti bila perlu.'], escalate: '-' })
  };

  /* -----------------------------------------------------------------------
   * 1a2. [VALIDASI MAGNETIC PLUG 2026-09-30] Keberadaan magnetic plug PER
   * kompartemen. Klaim "cek magnetic plug" TIDAK BOLEH dipakai sembarangan:
   *   - ENGINE  : umumnya TIDAK ada magnetic plug → periksa via CUT-OPEN FILTER.
   *   - Drivetrain (final drive, differential, swing, transmission) : UMUMNYA
   *     ada magnetic plug/screen — NAMUN tetap perlu konfirmasi per model/unit.
   * Fungsi di bawah mengembalikan frasa yang TEPAT untuk dipakai di narasi.
   * --------------------------------------------------------------------- */
  // Komponen yang UMUMNYA punya magnetic plug / magnetic screen.
  var MAGNETIC_PLUG_FAMILIES = { gearbox: true, axle: true, gear: true };
  // Komponen yang umumnya TIDAK punya magnetic plug (periksa via filter).
  var NO_MAGNETIC_PLUG_FAMILIES = { engine: true, hydraulic: true, cooling: true };

  /**
   * Frasa inspeksi partikel logam yang TEPAT untuk sebuah kompartemen.
   * @param {string} component nama kompartemen
   * @returns {string} frasa (siap ditempel di narasi tindakan)
   */
  function particleCheckPhrase(component) {
    var comp = normalizeComponent(component);
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    if (fam === 'engine') {
      return 'Cut-open filter oli untuk memeriksa partikel/serpihan logam (engine umumnya TIDAK memiliki magnetic plug).';
    }
    if (MAGNETIC_PLUG_FAMILIES[fam]) {
      return 'Periksa magnetic plug / magnetic screen kompartemen (bila model unit menyediakannya) & potong filter untuk serpihan logam.';
    }
    if (fam === 'hydraulic' || fam === 'cooling') {
      return 'Potong/periksa filter kompartemen & cek drain plug untuk partikel logam (verifikasi keberadaan magnetic plug sesuai model unit).';
    }
    // Kompartemen tak dikenal: JANGAN mengasumsikan ada magnetic plug.
    return 'Periksa filter & drain plug kompartemen untuk partikel logam; cek magnetic plug HANYA bila model unit menyediakannya.';
  }

  /* -----------------------------------------------------------------------
   * 1b. KNOWLEDGE BASE PER KOMPARTEMEN (component-aware)
   * ---------------------------------------------------------------------
   * KB di atas (`KB`) ditulis dari PERSPEKTIF MESIN (piston ring, cylinder
   * liner, connecting rod, oil cooler engine, dst.). Bila parameter yang sama
   * naik di kompartemen LAIN (TRANSMISSION / HYDRAULIC / FINAL DRIVE / ...),
   * narasi mesin menjadi SALAH KONTEKS.
   *
   * Lapisan ini menyimpan override narasi PER KOMPARTEMEN untuk parameter
   * yang maknanya berbeda antar kompartemen (terutama wear metal). Bentuknya
   * sama seperti `entry(...)`: { refs, warn:{likely,actions}, critical:{...} }.
   *
   * Aturan pemakaian (lihat recommend):
   *   - Kompartemen ENGINE          -> pakai `KB` (perspektif mesin, benar).
   *   - Kompartemen lain yang ADA   -> pakai override kompartemen ini.
   *   - Parameter OIL CONDITION /
   *     CLEANLINESS / ADDITIVE      -> umum (relevan lintas kompartemen),
   *                                    tetap pakai `KB` bila tak ada override.
   *   - Kompartemen TAK DIKENAL     -> JANGAN pakai narasi mesin; pakai
   *                                    `COMPONENT_NARRATIVE_NEUTRAL` (netral,
   *                                    tanpa klaim komponen spesifik mesin).
   * --------------------------------------------------------------------- */

  // Daftar kompartemen yang DIKENAL (selaras sos-config.THRESHOLDS + umum).
  // [PERLUASAN 2026-09-30] Ditambah agar mencakup nama kompartemen NYATA dari
  // file SOS lapangan (mis. "FINAL DRIVE FRONT LEFT", "WHEEL HUB RIGHT",
  // "TRANSMISSION POWER SHIFT", "SPINDLE FRONT LEFT", "CIRCLE DRIVE BOX", dst).
  // Pencocokan memakai `indexOf` dua arah + pilih kunci TERPANJANG, sehingga
  // variasi panjang/orientasi (LEFT/RIGHT/FRONT/REAR) tetap jatuh ke keluarga benar.
  var KNOWN_COMPONENTS = [
    // Mesin
    'ENGINE', 'ENGINE OIL', 'ENGINE POWER TAKE OFF',
    // Transmisi & turunannya
    'TRANSMISSION', 'TRANSMISSION POWER SHIFT', 'POWER SHIFT', 'TRANS OIL',
    'TORQUE CONVERTER', 'CONVERTER', 'GEARBOX', 'GEAR BOX',
    'POWER TAKE OFF', 'PTO', 'PUMP DRIVE', 'TRANSFER GEARS', 'TRANSFER CASE',
    'TRANSFER', 'RETARDER', 'GEAR REDUCER', 'REDUCER', 'GEAR CASE',
    'CIRCLE DRIVE BOX', 'CIRCLE DRIVE', 'CIRCLE',
    // Hidrolik & kemudi
    'HYDRAULIC SYSTEM', 'HYDRAULIC', 'HYD OIL', 'STEERING SYSTEM', 'STEERING',
    // Gardan / final drive / axle
    'FINAL DRIVE', 'DIFFERENTIAL', 'SWING DRIVE', 'SWING MACHINERY', 'SWING',
    'WHEEL BEARINGS', 'WHEEL BEARING', 'WHEEL HUB', 'WHEEL',
    'TANDEM', 'SPINDLE', 'DAMPER', 'AXLE', 'BEARING SHAFT', 'DRUM',
    // Pendingin
    'RADIATOR', 'COOLING'
  ];

  // Normalisasi nama kompartemen -> kunci kanonik.
  function normalizeComponent(component) {
    var c = String(component || '').toUpperCase().trim();
    if (!c) return '';
    // Cocokkan dua arah dengan daftar dikenal (pilih yang paling spesifik/panjang).
    var best = '';
    for (var i = 0; i < KNOWN_COMPONENTS.length; i++) {
      var k = KNOWN_COMPONENTS[i];
      if (c === k) return k;
      if ((c.indexOf(k) !== -1 || k.indexOf(c) !== -1) && k.length > best.length) best = k;
    }
    return best;   // '' = tidak dikenal
  }

  // Kelompok kompartemen untuk memilih keluarga narasi.
  var COMPONENT_FAMILY = {
    'ENGINE': 'engine', 'ENGINE OIL': 'engine', 'ENGINE POWER TAKE OFF': 'engine',
    'TRANSMISSION': 'gearbox', 'TRANSMISSION POWER SHIFT': 'gearbox',
    'POWER SHIFT': 'gearbox', 'TRANS OIL': 'gearbox',
    'TORQUE CONVERTER': 'gearbox', 'CONVERTER': 'gearbox',
    'GEARBOX': 'gearbox', 'GEAR BOX': 'gearbox',
    'PUMP DRIVE': 'gear', 'POWER TAKE OFF': 'gear', 'PTO': 'gear',
    'TRANSFER GEARS': 'gear', 'TRANSFER CASE': 'gear', 'TRANSFER': 'gear',
    'RETARDER': 'gear', 'GEAR REDUCER': 'gear', 'REDUCER': 'gear',
    'GEAR CASE': 'gear', 'CIRCLE DRIVE BOX': 'gear', 'CIRCLE DRIVE': 'gear',
    'CIRCLE': 'gear',
    'HYDRAULIC': 'hydraulic', 'HYDRAULIC SYSTEM': 'hydraulic', 'HYD OIL': 'hydraulic',
    'STEERING': 'hydraulic', 'STEERING SYSTEM': 'hydraulic',
    'FINAL DRIVE': 'axle', 'DIFFERENTIAL': 'axle', 'SWING DRIVE': 'axle',
    'SWING': 'axle', 'SWING MACHINERY': 'axle', 'AXLE': 'axle',
    'WHEEL BEARINGS': 'axle', 'WHEEL BEARING': 'axle', 'WHEEL HUB': 'axle',
    'WHEEL': 'axle', 'TANDEM': 'axle', 'SPINDLE': 'axle', 'DAMPER': 'axle',
    'BEARING SHAFT': 'axle', 'DRUM': 'axle',
    'RADIATOR': 'cooling', 'COOLING': 'cooling'
  };

  /**
   * Template narasi per KELUARGA kompartemen untuk parameter wear metal.
   * Hanya parameter yang MAKNANYA BEDA antar kompartemen yang diberi override;
   * parameter oil-condition (visc/tbn/water/fuel/soot/oksidasi) sifatnya umum
   * dan tetap memakai `KB` (kecuali disebut khusus di sini).
   * Struktur: FAMILY_KB[family][paramKey] = { warn, critical }.
   */
  var FAMILY_KB = {
    /* ---------- GEARBOX: transmisi / converter / final drive kopling ---------- */
    gearbox: {
      wear_fe: {
        // TIER 1 — Monitor (inspeksi ringan)
        warn: { likely: ['Keausan normal gearset/bearing transmisi mulai meningkat',
                         'Kontaminasi besi dari komponen bergerak (gear, bearing, clutch plate)'],
                actions: ['INSPEKSI RINGAN: pantau tren Fe antar sampling; bandingkan dengan baseline kompartemen.',
                          'Periksa riwayat ganti oli transmisi & kondisi filter.',
                          'Cek suhu operasi transmisi (panas berlebih mempercepat keausan).'] },
        // TIER 2 — Caution (inspeksi terarah + setel)
        critical: { likely: ['Keausan mulai nyata pada gear/bearing/clutch pack — perlu tindak lanjut terarah'],
                actions: ['INSPEKSI TERARAH: periksa magnet drain plug transmisi (bila model menyediakan) & filter (serpihan halus).',
                          'Cek tekanan & kualitas oli transmisi (viskositas, warna).',
                          'Lakukan transmission performance test ringan (shifting, suara).',
                          'Persingkat interval sampling untuk memantau laju kenaikan.'] },
        // TIER 3 — Critical (deep dive)
        severe: { likely: ['Keausan signifikan gear/bearing/clutch pack internal (disertai Cu/Pb/Cr naik)',
                           'Kontaminasi besi abrasive dari komponen yang aus'],
                actions: ['DEEP-DIVE: inspeksi internal gear train & clutch pack (bila bukti pendukung kuat).',
                          'Potong filter & periksa magnet/magnetic screen transmisi (bila ada) untuk serpihan besar.',
                          'Rencanakan overhaul/inspeksi internal terukur bila tren terus naik.'],
                escalate: 'Batasi beban berat & jadwalkan inspeksi transmisi segera (bila disertai bukti pendukung).' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/bearing kuningan clutch pack / planetary mulai',
                         'Kontaminasi dari oil cooler transmisi atau seal'],
                actions: ['INSPEKSI RINGAN: pantau tren Cu & Pb (bearing/clutch bushing).',
                          'Periksa integritas cooler transmisi & kondisi oli.'] },
        critical: { likely: ['Keausan bushing/bearing Cu-Pb mulai nyata'],
                actions: ['INSPEKSI TERARAH: uji tekanan & periksa kebocoran oil cooler transmisi.',
                          'Cek clearance & kondisi pelumasan yang terjangkau.',
                          'Pantau tren Cu bersama Pb/Sn.'] },
        severe: { likely: ['Keausan signifikan bearing/bushing Cu-Pb (planetary/clutch)',
                           'Kebocoran internal oil cooler transmisi'],
                actions: ['DEEP-DIVE: inspeksi planetary gear, clutch pack, & bearing.',
                          'Evaluasi jadwal overhaul transmisi.'],
                escalate: 'Waspadai clutch/bearing failure — siapkan shutdown terkendali.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing/bushing transmisi mulai',
                         'Kontaminasi Pb dari bantalan berbasis timah'],
                actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu (sering bersamaan).',
                          'Periksa kondisi bearing & bushing transmisi.'] },
        critical: { likely: ['Keausan overlay bearing transmisi mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli (viskositas, kontaminasi).',
                          'Pantau laju kenaikan Pb.'] },
        severe: { likely: ['Keausan overlay bearing transmisi kritis',
                           'Risiko bearing failure bila terus dioperasikan'],
                actions: ['DEEP-DIVE: inspeksi bearing transmisi & clearance menyeluruh.',
                          'Evaluasi jadwal penggantian bearing.'],
                escalate: 'Overlay Pb habis -> risiko metal-to-metal pada gear train.' }
      },
      wear_al: {
        warn: { likely: ['Keausan ringan komponen aluminium (housing/piston clutch)',
                         'Kontaminasi silika (bila Si tinggi bersamaan)'],
                actions: ['INSPEKSI RINGAN: bandingkan dengan Si & Fe (dirt vs wear).',
                          'Pantau tren Aluminium (Al) antar sampling.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa jalur breather/intake transmisi (visual).',
                          'Bandingkan Aluminium (Al) dengan Silika (Si).'] },
        severe: { likely: ['Keausan housing/piston clutch berbasis aluminium',
                           'Ingesti debu abrasif (dengan Si tinggi)'],
                actions: ['DEEP-DIVE: periksa piston clutch & housing transmisi.',
                          'Inspeksi menyeluruh jalur breather/intake & perbaiki kebocoran.'],
                escalate: 'Cegah ingesti debu; periksa jalur breather transmisi.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent transmisi', 'Residu sealant silicon'],
                actions: ['INSPEKSI RINGAN: periksa breather/vent transmisi & kebersihan area.',
                          'Bandingkan dengan kadar Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke transmisi'],
                actions: ['INSPEKSI TERARAH: periksa breather, seal, & jalur masuk debu; bersihkan.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif berkelanjutan ke transmisi', 'Kerusakan seal/gasket terkait'],
                actions: ['DEEP-DIVE: perbaiki titik masuk kontaminan menyeluruh.',
                          'Ganti oli & filter transmisi.'],
                escalate: 'Hentikan sumber ingesti debu sebelum keausan gear meluas.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating komponen baja (gear/shaft) mulai',
                         'Kontaminasi (bila Na/B/K naik -> coolant)'],
                actions: ['INSPEKSI RINGAN: pantau tren Cr; cek indikasi kontaminasi.',
                          'Periksa kondisi gear/shaft saat kesempatan.'] },
        critical: { likely: ['Keausan coating gear/shaft mulai nyata'],
                actions: ['INSPEKSI TERARAH: uji kontaminasi coolant (glycol, K, B).',
                          'Periksa cooler/gasket transmisi.'] },
        severe: { likely: ['Keausan lapisan keras gear/shaft signifikan', 'Kebocoran coolant ke oli transmisi'],
                actions: ['DEEP-DIVE: inspeksi gear, shaft, & sistem pendingin transmisi menyeluruh.',
                          'Perbaiki sumber kebocoran coolant.'],
                escalate: 'Segera cek sistem pendingin bila curiga coolant masuk.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah (bushing/bearing) mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Sn bersama Cu/Pb.', 'Periksa bearing/bushing transmisi.'] },
        critical: { likely: ['Keausan komponen Sn mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa bearing/bushing & kondisi pelumasan.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan di transmisi'],
                actions: ['DEEP-DIVE: inspeksi bearing transmisi & clearance.', 'Cek kontaminasi menyeluruh.'],
                escalate: 'Perhatikan potensi bearing failure transmisi.' }
      }
    },

    /* ---------------------------------------------------------------------
     * GEAR: gearset/reducer murni (PTO, transfer, gear reducer, circle drive,
     * gear case). TANPA asumsi clutch pack / transmisi, karena komponen ini
     * umumnya hanya berisi roda gigi & bearing.
     * ------------------------------------------------------------------- */
    gear: {
      wear_fe: {
        warn: { likely: ['Keausan normal gearset/bearing mulai meningkat',
                         'Kontaminasi besi dari roda gigi & bearing'],
                actions: ['INSPEKSI RINGAN: pantau tren Fe antar sampling; bandingkan dengan baseline kompartemen.',
                          'Periksa riwayat ganti oli & kondisi filter.',
                          'Cek suhu operasi (panas berlebih mempercepat keausan).'] },
        critical: { likely: ['Keausan mulai nyata pada roda gigi/bearing — perlu tindak lanjut terarah'],
                actions: ['INSPEKSI TERARAH: periksa magnet drain plug (bila model menyediakan) & filter (serpihan halus).',
                          'Cek kondisi oli (viskositas, warna, kontaminasi).',
                          'Persingkat interval sampling untuk memantau laju kenaikan.'] },
        severe: { likely: ['Keausan signifikan roda gigi/bearing internal', 'Kontaminasi besi abrasive dari komponen yang aus'],
                actions: ['DEEP-DIVE: inspeksi internal gear/bearing (bila bukti pendukung kuat).',
                          'Potong filter & periksa magnet (bila ada) untuk serpihan besar; cek backlash bila memungkinkan.',
                          'Rencanakan inspeksi internal / overhaul terukur bila tren terus naik.'],
                escalate: 'Batasi beban berat & jadwalkan inspeksi kompartemen segera (bila disertai bukti pendukung).' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/bearing kuningan mulai', 'Kontaminasi dari seal/cooler (bila ada)'],
                actions: ['INSPEKSI RINGAN: pantau tren Cu & Pb.', 'Periksa seal & bearing terkait.'] },
        critical: { likely: ['Keausan bushing/bearing Cu-Pb mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli (viskositas, kebersihan).',
                          'Periksa sumber kontaminasi (seal).'] },
        severe: { likely: ['Keausan signifikan bearing/bushing Cu-Pb', 'Kontaminasi internal berlanjut'],
                actions: ['DEEP-DIVE: inspeksi bearing & clearance kompartemen menyeluruh.'],
                escalate: 'Waspadai bearing failure — siapkan inspeksi terkendali.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing mulai', 'Kontaminasi Pb dari bantalan berbasis timah'],
                actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu (sering bersamaan).', 'Periksa kondisi bearing terkait.'] },
        critical: { likely: ['Keausan overlay bearing mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli.', 'Pantau laju kenaikan Pb.'] },
        severe: { likely: ['Keausan overlay bearing kritis', 'Risiko bearing failure bila terus dioperasikan'],
                actions: ['DEEP-DIVE: inspeksi bearing & clearance; evaluasi jadwal penggantian.'],
                escalate: 'Overlay Pb habis -> risiko metal-to-metal pada gear train.' }
      },
      wear_al: {
        warn: { likely: ['Keausan ringan komponen aluminium (housing)',
                         'Kontaminasi silika (bila Si tinggi bersamaan)'],
                actions: ['INSPEKSI RINGAN: bandingkan dengan Si & Fe (dirt vs wear).',
                          'Pantau tren Aluminium (Al) antar sampling.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa housing & jalur breather kompartemen.',
                          'Bandingkan Aluminium (Al) dengan Silika (Si).'] },
        severe: { likely: ['Keausan housing/aluminium signifikan', 'Ingesti debu abrasif (dengan Si tinggi)'],
                actions: ['DEEP-DIVE: inspeksi housing & perbaiki seluruh jalur masuk kontaminan.'],
                escalate: 'Cegah ingesti debu; periksa jalur masuk kontaminan.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent', 'Residu sealant silicon'],
                actions: ['INSPEKSI RINGAN: periksa breather & kebersihan area.',
                          'Bandingkan dengan Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa breather, seal, & jalur masuk debu; bersihkan.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif berkelanjutan', 'Kerusakan seal/gasket terkait'],
                actions: ['DEEP-DIVE: perbaiki titik masuk debu; ganti oli & filter.'],
                escalate: 'Hentikan sumber ingesti debu sebelum keausan gear meluas.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating komponen baja (gear/shaft) mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Cr.', 'Periksa gear/shaft saat kesempatan.'] },
        critical: { likely: ['Keausan coating gear/shaft mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kontaminasi coolant bila relevan (Na/B/K).'] },
        severe: { likely: ['Keausan lapisan keras gear/shaft signifikan', 'Kontaminasi coolant (bila Na/B/K naik)'],
                actions: ['DEEP-DIVE: inspeksi gear & shaft kompartemen.'],
                escalate: 'Periksa kondisi gear/shaft kompartemen.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Sn bersama Cu/Pb.'] },
        critical: { likely: ['Keausan komponen Sn mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa bearing terkait & kondisi pelumasan.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan'],
                actions: ['DEEP-DIVE: inspeksi bearing terkait & clearance.'],
                escalate: 'Perhatikan potensi bearing failure.' }
      }
    },

    /* ---------- HYDRAULIC: sistem hidrolik / steering ---------- */
    hydraulic: {
      wear_fe: {
        warn: { likely: ['Keausan normal pompa/motor/cylinder hidrolik mulai',
                         'Kontaminasi besi dari komponen bergerak hidrolik'],
                actions: ['INSPEKSI RINGAN: pantau tren Fe; cek level kebersihan oli hidrolik (ISO).',
                          'Periksa kondisi filter hidrolik.',
                          'Cek suhu operasi (panas berlebih mempercepat keausan).'] },
        critical: { likely: ['Keausan mulai nyata pada pompa/motor/cylinder hidrolik'],
                actions: ['INSPEKSI TERARAH: cek kebersihan sistem (ISO 4406) & sumber kontaminasi.',
                          'Periksa filter hidrolik (serpihan halus).',
                          'Cek suara/Getaran pompa & performa siklus (ringan).'] },
        severe: { likely: ['Keausan signifikan pompa/motor/cylinder hidrolik', 'Kontaminasi besi abrasive (partikel besar)'],
                actions: ['DEEP-DIVE: inspeksi pompa & motor hidrolik (efisiensi/flow test).',
                          'Potong filter hidrolik, periksa serpihan besar.'],
                escalate: 'Batasi operasi berat; risiko keausan lanjut pompa & valve.' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/pompa hidrolik (Cu) mulai', 'Kontaminasi dari cooler hidrolik/seal'],
                actions: ['INSPEKSI RINGAN: pantau tren Cu & kebersihan oli hidrolik.', 'Periksa cooler & kondisi seal hidrolik.'] },
        critical: { likely: ['Keausan bushing/pompa hidrolik mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kebocoran cooler (visual) & kondisi seal.',
                          'Pantau tren Cu bersama Pb.'] },
        severe: { likely: ['Keausan signifikan bushing/pompa hidrolik', 'Kebocoran internal cooler hidrolik'],
                actions: ['DEEP-DIVE: uji pompa (flow/pressure) & inspeksi bushing/piston/cylinder.',
                          'Ganti oli & filter bila kontaminasi tinggi.'],
                escalate: 'Waspadai penurunan efisiensi hidrolik — siapkan inspeksi.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing hidrolik mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu.', 'Periksa bearing/bushing terkait.'] },
        critical: { likely: ['Keausan bearing hidrolik mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli.'] },
        severe: { likely: ['Keausan bearing hidrolik signifikan'],
                actions: ['DEEP-DIVE: inspeksi bearing pompa/motor hidrolik.'],
                escalate: 'Risiko bearing failure pada sistem hidrolik.' }
      },
      wear_al: {
        warn: { likely: ['Keausan komponen aluminium (housing/piston) mulai', 'Kontaminasi silika (dengan Si tinggi)'],
                actions: ['INSPEKSI RINGAN: bandingkan dengan Si & Fe.', 'Pantau tren Aluminium (Al).'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa breather/filter hidrolik; bersihkan.'] },
        severe: { likely: ['Keausan housing/piston aluminium hidrolik', 'Ingesti debu abrasif (Si tinggi)'],
                actions: ['DEEP-DIVE: inspeksi housing/piston & perbaiki sumber ingesti debu.'],
                escalate: 'Perbaiki sumber ingesti debu segera.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent hidrolik',
                         'Residu sealant silicon'],
                actions: ['INSPEKSI RINGAN: periksa breather tangki & kebersihan area.',
                          'Bandingkan dengan Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke sistem hidrolik'],
                actions: ['INSPEKSI TERARAH: periksa breather, seal, & filtrasi hidrolik.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif ke sistem hidrolik', 'Kerusakan seal/filter'],
                actions: ['DEEP-DIVE: perbaiki titik masuk debu; ganti oli & filter.'],
                escalate: 'Kebersihan hidrolik kritis — risiko keausan valve/pompa.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating rod/shaft hidrolik mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Cr.', 'Periksa rod/shaft saat kesempatan.'] },
        critical: { likely: ['Keausan coating rod/shaft mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kontaminasi (glycol/K/B) bila relevan.'] },
        severe: { likely: ['Keausan lapisan keras rod/shaft hidrolik', 'Kontaminasi coolant (bila Na/B/K naik)'],
                actions: ['DEEP-DIVE: periksa rod/shaft & seal hidrolik menyeluruh.'],
                escalate: 'Periksa kebocoran/kontaminasi sistem hidrolik.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Sn bersama Cu/Pb.'] },
        critical: { likely: ['Keausan komponen Sn mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa bearing/bushing pompa hidrolik.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn hidrolik signifikan'],
                actions: ['DEEP-DIVE: inspeksi bearing/bushing pompa hidrolik menyeluruh.'],
                escalate: 'Perhatikan potensi bearing failure hidrolik.' }
      }
    },

    /* ---------- AXLE: final drive / differential / swing drive ---------- */
    axle: {
      wear_fe: {
        warn: { likely: ['Keausan normal gearset/bearing mulai', 'Kontaminasi besi dari gear & bearing'],
                actions: ['INSPEKSI RINGAN: pantau tren Fe; cek magnet drain plug (bila model menyediakan).',
                          'Periksa kondisi oli & interval ganti.', 'Cek suhu operasi kompartemen.'] },
        critical: { likely: ['Keausan mulai nyata pada gear/bearing kompartemen'],
                actions: ['INSPEKSI TERARAH: periksa magnet drain plug (bila model menyediakan) & filter (serpihan halus).',
                          'Cek kondisi oli (viskositas, warna).', 'Persingkat interval sampling.'] },
        severe: { likely: ['Keausan signifikan gear/bearing', 'Kontaminasi besi abrasive berat'],
                actions: ['DEEP-DIVE: inspeksi internal gear/bearing (bila bukti pendukung kuat).',
                          'Potong filter & periksa magnet (bila ada) untuk serpihan besar; cek backlash bila memungkinkan.',
                          'Rencanakan inspeksi internal/overhaul.'],
                escalate: 'Batasi beban berat; jadwalkan inspeksi kompartemen segera (bila disertai bukti pendukung).' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/bearing kuningan mulai', 'Kontaminasi dari seal/cooler'],
                actions: ['INSPEKSI RINGAN: pantau tren Cu & Pb.', 'Periksa seal & bearing.'] },
        critical: { likely: ['Keausan bushing/bearing Cu-Pb mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kondisi seal & sumber kontaminasi.', 'Cek kondisi oli.'] },
        severe: { likely: ['Keausan signifikan bearing/bushing Cu-Pb', 'Kontaminasi internal'],
                actions: ['DEEP-DIVE: inspeksi bearing & clearance unit menyeluruh.'],
                escalate: 'Waspadai bearing failure pada komponen bergerak.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing mulai'], actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu.'] },
        critical: { likely: ['Keausan overlay bearing mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli.'] },
        severe: { likely: ['Keausan overlay bearing kritis', 'Risiko bearing failure'],
                actions: ['DEEP-DIVE: inspeksi bearing & clearance; evaluasi ganti bearing.'],
                escalate: 'Overlay Pb habis -> risiko metal-to-metal gear train.' }
      },
      wear_al: {
        warn: { likely: ['Keausan komponen aluminium (housing) mulai', 'Kontaminasi silika (Si tinggi)'],
                actions: ['INSPEKSI RINGAN: bandingkan dengan Si & Fe.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa breather kompartemen; bersihkan.'] },
        severe: { likely: ['Keausan housing aluminium', 'Ingesti debu abrasif'],
                actions: ['DEEP-DIVE: perbaiki sumber ingesti debu menyeluruh.'],
                escalate: 'Cegah ingesti debu; periksa breather kompartemen.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent', 'Residu sealant silicon'],
                actions: ['INSPEKSI RINGAN: periksa breather & kebersihan.', 'Bandingkan dengan Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke kompartemen'],
                actions: ['INSPEKSI TERARAH: periksa breather, seal, & jalur masuk debu; bersihkan.'] },
        severe: { likely: ['Ingesti debu abrasif ke kompartemen', 'Kerusakan seal/gasket'],
                actions: ['DEEP-DIVE: perbaiki titik masuk debu; ganti oli & filter.'],
                escalate: 'Hentikan ingesti debu sebelum keausan gear meluas.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating komponen baja (gear/shaft) mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Cr.'] },
        critical: { likely: ['Keausan coating gear/shaft mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kontaminasi coolant bila ada.'] },
        severe: { likely: ['Keausan lapisan keras gear/shaft signifikan'],
                actions: ['DEEP-DIVE: inspeksi gear & shaft kompartemen.'],
                escalate: 'Periksa kondisi gear/shaft kompartemen.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah mulai'],
                actions: ['INSPEKSI RINGAN: pantau tren Sn bersama Cu/Pb.'] },
        critical: { likely: ['Keausan komponen Sn mulai nyata'],
                actions: ['INSPEKSI TERARAH: periksa bearing terkait.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan'],
                actions: ['DEEP-DIVE: inspeksi bearing terkait menyeluruh.'],
                escalate: 'Perhatikan potensi bearing failure.' }
      }
    },

    /* ---------- COOLING: radiator / sistem pendingin ---------- */
    cooling: {
      wear_fe: {
        warn: { likely: ['Keausan ringan komponen pompa/water pump mulai',
                         'Korosi logam sistem pendingin'],
                actions: ['INSPEKSI RINGAN: pantau tren Fe; cek kondisi & pH coolant.',
                          'Periksa water pump & sirkulasi.'] },
        critical: { likely: ['Keausan/korosi mulai nyata pada sistem pendingin'],
                actions: ['INSPEKSI TERARAH: cek inhibitor & pH coolant; periksa pompa (visual).',
                          'Pantau suhu operasi & tren Fe.'] },
        severe: { likely: ['Keausan signifikan komponen pompa pendingin', 'Korosi internal sistem cooling'],
                actions: ['DEEP-DIVE: inspeksi water pump, bearing, & seal; flush & ganti coolant.',
                          'Periksa radiator & blok terhadap korosi.'],
                escalate: 'Risiko overheating — perbaiki sistem pendingin segera.' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bearing water pump / keluruhan Cu dari radiator'],
                actions: ['INSPEKSI RINGAN: pantau tren Cu.', 'Periksa water pump & radiator core.'] },
        critical: { likely: ['Keausan bearing pompa / korosi radiator mulai nyata'],
                actions: ['INSPEKSI TERARAH: cek kondisi coolant & inhibitor; periksa sirkulasi.'] },
        severe: { likely: ['Keausan bearing pompa / korosi radiator (Cu)'],
                actions: ['DEEP-DIVE: inspeksi water pump & radiator; ganti komponen yang aus.'],
                escalate: 'Waspadai kebocoran/gagal sirkulasi pendingin.' }
      }
    }
  };

  /**
   * Narasi NETRAL untuk kompartemen yang TIDAK DIKENAL.
   * Sengaja TIDAK menyebut komponen mesin (piston/liner/connecting rod) agar
   * tidak salah konteks. Hanya panduan umum condition monitoring.
   */
  var COMPONENT_NARRATIVE_NEUTRAL = {
    wear_fe: {
      warn: { likely: ['Keausan komponen bergerak berbasis besi mulai meningkat',
                       'Kontaminasi partikel besi dari komponen internal'],
              actions: ['Pantau tren Fe antar sampling; bandingkan dengan baseline.',
                        'Periksa riwayat ganti oli & kondisi filter.'] },
      critical: { likely: ['Keausan mulai nyata pada komponen internal berbasis besi'],
              actions: ['INSPEKSI TERARAH: periksa filter & drain plug kompartemen untuk partikel logam (serpihan halus).',
                        'Cek kondisi oli & sumber kontaminasi.',
                        'Persingkat interval sampling.'] },
      severe: { likely: ['Keausan signifikan komponen internal berbasis besi',
                         'Kontaminasi besi abrasive'],
              actions: ['DEEP-DIVE: inspeksi internal komponen bergerak (bila bukti pendukung kuat).',
                        'Potong filter untuk serpihan besar.',
                        'Rencanakan inspeksi internal.' ],
              escalate: 'Batasi operasi berat; jadwalkan inspeksi segera.' }
    },
    wear_cu: {
      warn: { likely: ['Keausan bushing/bearing kuningan mulai'],
              actions: ['INSPEKSI RINGAN: pantau tren Cu & Pb.', 'Periksa kondisi oli & filter.'] },
      critical: { likely: ['Keausan bushing/bearing Cu-Pb mulai nyata'],
              actions: ['INSPEKSI TERARAH: cek cooler/seal bila ada.', 'Cek kondisi oli.'] },
      severe: { likely: ['Keausan signifikan bearing/bushing Cu-Pb',
                         'Kontaminasi internal (cooler/seal bila ada)'],
              actions: ['DEEP-DIVE: inspeksi bearing/bushing terkait menyeluruh.'],
              escalate: 'Waspadai bearing failure — siapkan inspeksi terkendali.' }
    },
    wear_al: {
      warn: { likely: ['Keausan ringan komponen aluminium',
                       'Kontaminasi silika (bila Si tinggi)'],
              actions: ['INSPEKSI RINGAN: bandingkan dengan Si & Fe.', 'Pantau tren Aluminium (Al).'] },
      critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
              actions: ['INSPEKSI TERARAH: periksa jalur intake/breather; bersihkan.'] },
      severe: { likely: ['Keausan komponen aluminium signifikan',
                         'Ingesti debu abrasif (dengan Si tinggi)'],
              actions: ['DEEP-DIVE: perbaiki seluruh jalur masuk kontaminan.'],
              escalate: 'Cegah ingesti debu; periksa jalur masuk kontaminan.' }
    },
    wear_pb: {
      warn: { likely: ['Keausan overlay bearing mulai'],
              actions: ['INSPEKSI RINGAN: pantau tren Pb & Cu.'] },
      critical: { likely: ['Keausan overlay bearing mulai nyata'],
              actions: ['INSPEKSI TERARAH: cek clearance & kondisi oli.'] },
      severe: { likely: ['Keausan overlay bearing kritis',
                         'Risiko bearing failure'],
              actions: ['DEEP-DIVE: inspeksi bearing & clearance; evaluasi ganti bearing.'],
              escalate: 'Jangan abaikan — overlay Pb habis dapat metal-to-metal.' }
    },
    wear_cr: {
      warn: { likely: ['Keausan coating komponen baja mulai'],
              actions: ['INSPEKSI RINGAN: pantau tren Cr.'] },
      critical: { likely: ['Keausan coating komponen baja mulai nyata'],
              actions: ['INSPEKSI TERARAH: cek kontaminasi coolant bila relevan (Na/B/K).'] },
      severe: { likely: ['Keausan lapisan keras signifikan',
                         'Kontaminasi coolant (bila Na/B/K naik)'],
              actions: ['DEEP-DIVE: inspeksi komponen baja terkait.'],
              escalate: 'Segera cek sumber keausan/kontaminasi.' }
    },
    wear_si: {
      warn: { likely: ['Kontaminasi debu (via breather/intake)',
                       'Residu sealant silicon'],
              actions: ['INSPEKSI RINGAN: periksa breather/filter & kebersihan.', 'Bandingkan dengan Aluminium (Al).'] },
      critical: { likely: ['Ingesti debu mulai nyata'],
              actions: ['INSPEKSI TERARAH: periksa jalur masuk debu & seal; bersihkan.'] },
      severe: { likely: ['Ingesti debu abrasif berkelanjutan',
                         'Kerusakan seal/gasket terkait'],
              actions: ['DEEP-DIVE: perbaiki titik masuk debu menyeluruh; ganti oli/filter.'],
              escalate: 'Hentikan sumber ingesti debu sebelum keausan meluas.' }
    }
  };

  /* -----------------------------------------------------------------------
   * 2. Pencarian & rekomendasi berbasis KB
   * --------------------------------------------------------------------- */
  function findEntry(paramKey) {
    return KB[paramKey] || null;
  }

  /**
   * Ambil override narasi KB untuk (paramKey, component) bila ada.
   * @returns {object|null} { refs, warn:{likely,actions}, critical:{...} }
   */
  function findComponentEntry(paramKey, component) {
    var comp = normalizeComponent(component);
    if (!comp || comp === 'ENGINE') return null;   // ENGINE pakai KB utama
    var fam = COMPONENT_FAMILY[comp];
    if (!fam) return null;
    var famKB = FAMILY_KB[fam];
    if (!famKB) return null;
    return famKB[paramKey] || null;
  }

  /** Kompartemen ini dikenali? (untuk memutuskan neutral fallback) */
  function isKnownComponent(component) {
    return !!normalizeComponent(component);
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
              'SOP Dirt Entry Index (Si + Aluminium)'],
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
    additive_na: ['Komatsu Shop Manual — Cooling System: Coolant Leak Test',
                  'SOP uji glycol & pressure test sistem pendingin',
                  'SOP analisis Sodium/Kalium sebagai penanda kebocoran coolant'],
    additive_ba: ['Komatsu Shop Manual — Lubrication: Detergent Additive']
  };

  /** Ambil rujukan dokumen untuk sebuah parameter (fallback ke SOP umum). */
  function refsFor(paramKey) {
    var r = REFS[paramKey];
    if (r && r.length) return r.slice();
    return [REF_SOP_GENERAL];
  }

  /* -----------------------------------------------------------------------
   * [RUJUKAN SADAR-KOMPARTEMEN 2026-09-30] Manual/section yang lebih spesifik
   * per KELUARGA kompartemen. Dipakai menambah/mengganti rujukan generik agar
   * setiap tindakan dapat dipertanggungjawabkan ke sumber yang tepat.
   * --------------------------------------------------------------------- */
  var FAMILY_REF = {
    engine:    ['Komatsu Shop Manual — ENGINE (Piston/Liner/Valve Train/Turbo)'],
    gearbox:   ['Komatsu Shop Manual — POWER TRAIN (Transmission / Torque Converter / Clutch)'],
    gear:      ['Komatsu Shop Manual — POWER TRAIN (Gears / Reducer / Transfer)'],
    hydraulic: ['Komatsu Shop Manual — HYDRAULIC & STEERING SYSTEM'],
    axle:      ['Komatsu Shop Manual — POWER TRAIN (Final Drive / Differential / Axle)'],
    cooling:   ['Komatsu Shop Manual — COOLING SYSTEM (Radiator / Water Pump)']
  };

  /* -----------------------------------------------------------------------
   * [DAMPAK SPESIFIK 2026-09-30] Pemetaan parameter → PART/KOMPONEN SPESIFIK
   * yang berisiko rusak, per KELUARGA kompartemen. Dipakai mengisi kolom
   * "Dampak / Risiko" agar TIDAK generik (menyebut part nyata, bukan hanya
   * "kerusakan komponen mayor").
   *
   * Struktur: PARAM_IMPACT[family][paramKey] = 'frasa part/komponen'
   *   - family '' (fallback) dipakai bila kompartemen tak dikenal.
   * Frasa ditulis ringkas & konkret (nama komponen yang bisa diinspeksi).
   * --------------------------------------------------------------------- */
  var PARAM_IMPACT = {
    /* ---------------- ENGINE ---------------- */
    engine: {
      wear_fe: 'Piston ring, cylinder liner, valve seat, & bearing (main/rod) berisiko aus',
      wear_cu: 'Main/rod bearing (overlay Cu-Pb), oil cooler (kebocoran internal), & bushing turbo',
      wear_al: 'Piston/skirt, bearing shell, & housing aluminium berisiko aus',
      wear_cr: 'Piston ring (lapisan chrome) & cylinder liner berisiko terkikis',
      wear_pb: 'Bearing overlay (Pb) main/rod — risiko metal-to-metal',
      wear_si: 'Cylinder liner, piston ring, & valve train (keausan abrasif debu)',
      wear_sn: 'Bearing (Cu-Pb-Sn) & piston ring coating',
      wear_ni: 'Valve & seat, turbocharger (bearing/shaft) berisiko aus',
      visc_v100: 'Film pelumasan menipis → bearing, camshaft, & cylinder liner berisiko kontak logam',
      tbn: 'Oli kehilangan daya netralisasi → korosi bearing & liner',
      water_pct: 'Emulsi oli → korosi bearing, rust liner, & kegagalan pelumasan',
      fuel_pct: 'Dilusi bahan bakar menurunkan viskositas → bearing & camshaft berisiko seize',
      soot: 'Soot mengental → filter tersumbat, sludge di oil gallery, & keausan liner',
      oxidation: 'Varnish/sludge → oil gallery tersumbat & bearing berisiko overheat',
      pqi: 'Partikel abrasif → keausan presisi bearing, pompa oli, & cylinder liner',
      additive_na: 'Kebocoran coolant → korosi bearing, rust liner, & kerusakan oil cooler'
    },
    /* ---------------- GEARBOX (transmisi/converter) ---------------- */
    gearbox: {
      wear_fe: 'Gear set, shaft, bearing, & clutch plate transmisi berisiko aus',
      wear_cu: 'Bushing/bearing planetary, clutch pack, & cooler transmisi (kebocoran)',
      wear_al: 'Housing & piston clutch (aluminium) berisiko aus',
      wear_cr: 'Gear & shaft (lapisan keras) berisiko terkikis',
      wear_pb: 'Bearing transmisi (overlay Pb) — risiko metal-to-metal',
      wear_si: 'Gear, bearing, & spline (keausan abrasif debu)',
      wear_sn: 'Bearing Cu-Pb-Sn planetary & clutch bushing',
      wear_ni: 'Gear & shaft paduan nikel',
      visc_v100: 'Viskositas menyimpang → clutch pack & gear set berisiko slip/aus',
      water_pct: 'Air → korosi bearing & clutch plate, kehilangan cengkeraman',
      pqi: 'Partikel → keausan valve body, clutch pack, & bearing transmisi',
      additive_na: 'Kebocoran coolant → korosi bearing & clutch transmisi'
    },
    /* ---------------- GEAR (PTO/transfer/reducer) ---------------- */
    gear: {
      wear_fe: 'Roda gigi, shaft, & bearing kompartemen berisiko aus',
      wear_cu: 'Bushing/bearing kuningan & seal berisiko aus',
      wear_al: 'Housing aluminium berisiko aus',
      wear_cr: 'Gear & shaft (lapisan keras) berisiko terkikis',
      wear_pb: 'Bearing overlay (Pb) — risiko metal-to-metal',
      wear_si: 'Roda gigi & bearing (keausan abrasif debu)',
      wear_sn: 'Bearing Cu-Pb-Sn',
      pqi: 'Partikel → keausan presisi gear & bearing'
    },
    /* ---------------- HYDRAULIC ---------------- */
    hydraulic: {
      wear_fe: 'Pompa, motor, & cylinder hidrolik berisiko aus (efisiensi turun)',
      wear_cu: 'Bushing pompa, piston/cylinder, & cooler hidrolik (kebocoran)',
      wear_al: 'Housing & piston aluminium hidrolik',
      wear_cr: 'Rod & shaft hidrolik (lapisan keras)',
      wear_pb: 'Bearing pompa/motor hidrolik (overlay Pb)',
      wear_si: 'Pompa & valve hidrolik (keausan abrasif debu)',
      wear_sn: 'Bearing pompa hidrolik',
      pqi: 'Partikel → valve spool macet, pompa aus, & seal bocor',
      water_pct: 'Air → korosi valve & pompa, degradasi seal',
      additive_na: 'Kebocoran coolant/oil cooler hidrolik'
    },
    /* ---------------- AXLE (final drive/differential/swing) ---------------- */
    axle: {
      wear_fe: 'Gear final drive, bearing, & spline axle berisiko aus',
      wear_cu: 'Bushing/bearing kuningan & seal axle',
      wear_al: 'Housing axle aluminium',
      wear_cr: 'Gear & shaft (lapisan keras) axle',
      wear_pb: 'Bearing axle (overlay Pb) — risiko metal-to-metal',
      wear_si: 'Gear & bearing axle (keausan abrasif debu)',
      wear_sn: 'Bearing Cu-Pb-Sn axle',
      pqi: 'Partikel → keausan gear & bearing final drive/axle'
    },
    /* ---------------- COOLING ---------------- */
    cooling: {
      wear_fe: 'Water pump (bearing/seal), liner wet, & blok berisiko korosi/aus',
      wear_cu: 'Bearing water pump & radiator core (korosi Cu)',
      water_pct: 'Korosi radiator, water pump, & liner',
      additive_na: 'Korosi sistem pendingin & water pump'
    }
  };

  /**
   * Dampak (part/komponen spesifik) untuk sebuah parameter + kompartemen.
   * Fallback berurutan: impact spesifik keluarga -> impact generik param
   * (dari KB.components) -> frasa netral.
   * @param {string} paramKey
   * @param {string} [component]
   * @returns {string} frasa part/komponen
   */
  function impactFor(paramKey, component) {
    var comp = component ? normalizeComponent(component) : '';
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    if (fam && PARAM_IMPACT[fam] && PARAM_IMPACT[fam][paramKey]) return PARAM_IMPACT[fam][paramKey];
    if (PARAM_IMPACT.engine[paramKey]) return PARAM_IMPACT.engine[paramKey];
    // Fallback: komponen terkait dari KB utama.
    var data = findEntry(paramKey);
    if (data && data.refs && data.refs.length) return data.refs.join(', ') + ' berisiko terpengaruh';
    return 'Komponen terkait parameter ini berisiko terpengaruh bila dibiarkan';
  }

  /**
   * Rujukan (refs) untuk sebuah parameter + kompartemen.
   * Menggabungkan: rujukan manual per-keluarga + rujukan per-parameter (REFS)
   * + SOP umum. Didedup, urutan dipertahankan.
   *
   * [PENTING] Untuk kompartemen NON-ENGINE, rujukan per-parameter wear dari
   * `REFS` (yang ditulis dari perspektif mesin: "Piston Ring", "Cylinder
   * Liner") DIGANTI dengan rujukan kompartemen netral, agar tidak salah
   * konteks (mis. transmisi tidak punya piston ring).
   * @param {string} paramKey
   * @param {string} [component]
   * @returns {string[]}
   */
  function refsForComponent(paramKey, component) {
    var out = [];
    var seen = {};
    function add(list) {
      (list || []).forEach(function (x) {
        var k = String(x).trim();
        if (k && !seen[k]) { seen[k] = 1; out.push(k); }
      });
    }
    var comp = component ? normalizeComponent(component) : '';
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    var isEngine = (fam === 'engine' || !comp);
    var isWear = /^wear_/.test(String(paramKey || ''));

    add(FAMILY_REF[fam]);

    if (isEngine || !isWear) {
      // Engine ATAU parameter non-wear (oil/clean/additive) -> rujukan param normal.
      add(refsFor(paramKey));
    } else {
      // Kompartemen non-engine & parameter wear -> ganti rujukan mesin dgn netral.
      add(['SOP Wear-Metal Analysis Kompartemen (' + (comp || 'kompartemen') + ')',
           'Panduan penilaian keausan berbasis keluarga kompartemen (gear/bearing/bushing)']);
    }
    add([REF_SOP_GENERAL]);
    return out;
  }

  /**
   * Bangun rekomendasi untuk satu parameter yang berstatus tertentu.
   * @param {string} paramKey
   * @param {number} severity  1 = warn, 2 = crit, 4 = extreme
   * @param {object} [opts]    { label, value, unit, trend, component }
   * @returns {object}
   *
   * [KOMPARTEMEN-SADAR 2026-09-30] Bila `opts.component` diberikan dan BUKAN
   * ENGINE, narasi dipilih dari FAMILY_KB kompartemen tsb. Bila kompartemen
   * TIDAK DIKENAL dan parameter bukan parameter umum (oil/clean/additive yang
   * memang netral), narasi memakai COMPONENT_NARRATIVE_NEUTRAL (TANPA klaim
   * komponen mesin) — bukan lagi memaksa narasi engine.
   */
  function recommend(paramKey, severity, opts) {
    opts = opts || {};
    var data = findEntry(paramKey);
    // [REVISI 2026-09-30] Tingkat narasi BERTINGKAT sesuai keparahan:
    //   severity 1 (Monitor)   -> 'warn'    (inspeksi ringan / monitoring)
    //   severity 2 (Caution)   -> 'critical' (setel/adjust + inspeksi terarah)
    //   severity 4 (Critical)  -> 'severe'  (deep-dive / perbaikan berat)
    // Bila blok 'severe' belum ada utk suatu param -> fallback ke 'critical'
    // agar tetap aman (tidak menghilangkan rekomendasi).
    var level = severity >= 4 ? 'severe' : (severity >= 2 ? 'critical' : 'warn');
    var comp = opts.component ? normalizeComponent(opts.component) : '';
    var isEngine = (comp === 'ENGINE');
    var known = isKnownComponent(opts.component);

    // Kelompok parameter yang narasinya UMUM (relevan lintas kompartemen):
    // oil condition, cleanliness, additive. Untuk ini KB utama tetap dipakai
    // (kecuali ada override kompartemen spesifik).
    var group = data ? data.group : '';
    var isGenericParam = (group === 'oil' || group === 'clean' || group === 'additive');

    // Pilih sumber narasi (prioritas):
    //   1) Override kompartemen spesifik (FAMILY_KB)  -> paling akurat
    //   2) ENGINE atau parameter umum                  -> KB utama (perspektif mesin / netral)
    //   3) Kompartemen tak dikenal & parameter wear     -> narasi NETRAL (jangan pakai mesin)
    var chosen = null;
    var chosenFrom = '';

    var compEntry = findComponentEntry(paramKey, opts.component);
    if (compEntry) {
      chosen = compEntry; chosenFrom = 'component';
    } else if (isEngine || isGenericParam) {
      chosen = data; chosenFrom = data ? 'kb' : '';
    } else if (!known) {
      // Kompartemen tak dikenal: JANGAN pakai narasi mesin.
      chosen = COMPONENT_NARRATIVE_NEUTRAL[paramKey] || null;
      chosenFrom = chosen ? 'neutral' : '';
    } else {
      // Kompartemen DIKENAL tapi tak ada override utk param ini.
      // Parameter wear tanpa override -> pakai netral; param lain -> KB utama.
      if (data && (data.group === 'oil' || data.group === 'clean' || data.group === 'additive')) {
        chosen = data; chosenFrom = 'kb';
      } else {
        chosen = COMPONENT_NARRATIVE_NEUTRAL[paramKey] || null;
        chosenFrom = chosen ? 'neutral' : '';
      }
    }

    var likely = [], actions = [], escalate = '';
    if (chosen) {
      // Pilih blok sesuai level; bila 'severe' kosong -> pakai 'critical'.
      var block;
      if (level === 'severe') {
        block = chosen.severe || chosen.critical || chosen.warn || {};
      } else {
        block = chosen[level] || chosen.warn || {};
      }
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

    // [RISIKO 2026-09-30] Estimasi risiko bertingkat — menjelaskan DAMPAK bila
    // dibiarkan, agar laporan "humanis" & bisa dipertanggungjawabkan (bukan
    // hanya daftar tindakan). Ringkas, berbasis level keparahan.
    var risk = (level === 'severe')
      ? 'RISIKO TINGGI: bila dibiarkan, berpotensi kerusakan komponen mayor, downtime tak terencana, dan biaya perbaikan besar.'
      : (level === 'critical')
      ? 'RISIKO MENENGAH: berpotensi berkembang menjadi kerusakan signifikan bila tidak segera ditindaklanjuti; biaya perbaikan meningkat seiring waktu.'
      : 'RISIKO RENDAH: umumnya masih dalam batas aman untuk dipantau; tindak lanjut terjadwal pada interval sampling berikutnya.';

    return {
      param: paramKey,
      label: opts.label || paramKey,
      value: (opts.value === undefined ? null : opts.value),
      unit: opts.unit || '',
      severity: severity,
      level: level,
      // Label level utk tampilan (Indonesia) — dipakai laporan Portofolio.
      levelLabel: (level === 'severe' ? 'Critical' : (level === 'critical' ? 'Caution' : 'Monitor')),
      likely: likely,
      actions: actions,
      escalate: escalate,
      risk: risk,                                        // [RISIKO] estimasi dampak (level)
      impact: impactFor(paramKey, opts.component),       // [DAMPAK] part/komponen spesifik
      refs: refsForComponent(paramKey, opts.component),  // [RUJUKAN] sadar-kompartemen
      components: (data && data.refs) ? data.refs.slice() : [],  // komponen terkait
      fromKB: !!chosen,
      narrativeSource: chosenFrom                        // 'component'|'kb'|'neutral'|''
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
      // [SPESIFIK PER KOMPARTEMEN 2026-10-01] Bila tersedia `topupByComponent`,
      // buat rule TERPISAH per kompartemen dengan Qty OBJECTIVE masing-masing
      // (mis. ENGINE vs RADIATOR) — JANGAN mencampur jadi satu total gabungan.
      if (c.topupCount > 0 && typeof c.topupQty === 'number') {
        var refVol = (c.refVolume && c.refVolume > 0) ? c.refVolume : 50;
        if (c.topupQty >= refVol * 2) {
          out.push({
            level: 'critical',
            title: 'Konsumsi top-up ' + (c.component || '') + ' tinggi (' + c.topupQty + ' L)',
            detail: 'Penambahan ' + (c.viewLabel || 'oli') + ' ' + (c.component || '') + ' ' + c.topupQty + ' L dalam ' + c.topupCount +
                    ' transaksi. Curigai kebocoran / over-consumption (blow-by, seal, oil cooler). ' +
                    'Periksa titik kebocoran & bandingkan dengan kapasitas sistem.'
          });
        } else if (c.topupQty > 0 && c.topupQty >= refVol) {
          out.push({
            level: 'warning',
            title: 'Ada aktivitas top-up ' + (c.component || '') + ' (' + c.topupQty + ' L)',
            detail: 'Terdapat penambahan ' + (c.viewLabel || 'oli') + ' ' + (c.component || '') + ' (mungkin normal). Pantau tren konsumsi ' +
                    'dibandingkan interval servis.'
          });
        }
      }
      // [RINCIAN PER KOMPARTEMEN] Bila ada beberapa kompartemen (mis. ENGINE +
      // RADIATOR) atau komponen ekstra dengan konsumsi signifikan, tambahkan
      // catatan OBJECTIVE per kompartemen agar tindakan tepat sasaran.
      if (Array.isArray(c.topupByComponent) && c.topupByComponent.length) {
        var extras = c.topupByComponent.filter(function (b) {
          var isPrimary = String(b.component).toUpperCase() === String(c.component || '').toUpperCase();
          return !isPrimary && b.qty !== null && b.qty > 0;
        });
        if (extras.length) {
          var refVol2 = (c.refVolume && c.refVolume > 0) ? c.refVolume : 50;
          extras.forEach(function (b) {
            var lvl = (b.qty >= refVol2 * 2) ? 'critical' : (b.qty >= refVol2 ? 'warning' : 'info');
            out.push({
              level: lvl,
              title: 'Konsumsi top-up ' + b.component + ' (' + b.qty + ' L) — komponen terkait',
              detail: 'Penambahan ' + b.qty + ' L pada ' + b.component + ' dalam ' + b.count + ' transaksi. ' +
                      'Ini adalah sistem TERKAIT mesin (bukan oli mesin itu sendiri) — ' +
                      'periksa kebocoran/over-consumption pada sirkuit ' + b.component + ' secara terpisah.'
            });
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
    FAMILY_KB: FAMILY_KB,
    findEntry: findEntry,
    findComponentEntry: findComponentEntry,
    normalizeComponent: normalizeComponent,
    isKnownComponent: isKnownComponent,
    refsFor: refsFor,
    refsForComponent: refsForComponent,
    impactFor: impactFor,
    recommend: recommend,
    ruleBased: ruleBased,
    particleCheckPhrase: particleCheckPhrase
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

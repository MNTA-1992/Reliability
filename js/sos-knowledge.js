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
        actions: ['Cek riwayat Fe (tren/ROW₁₀₀) — apakah naik bertahap atau lonjakan sesaat.',
                  'Periksa kondisi air cleaner & jalur intake (bila Si juga naik).',
                  'Verifikasi jam oli (HM oil) & riwayat penambahan/penggantian oli.',
                  'Ambil sampel ulang pada interval normal (250 jam) untuk konfirmasi — BELUM perlu bongkar.'] },
      // [TIER 2 — Caution] Jelas melewati batas: inspeksi terarah + setel/adjust.
      { likely: ['Keausan mulai nyata pada ring/liner atau komponen bergerak — perlu tindak lanjut terarah',
                 'Indikasi awaI keausan; belum tentu komponen utama harus dibongkar'],
        actions: ['Periksa valve mechanism (clearance, kebocoran kompresi) — tidak perlu turun mesin.',
                  'ADJUST bila perlu: setel valve clearance sesuai spesifikasi manual.',
                  'Periksa tekanan oli & suara mesin tidak normal (deteksi dini).',
                  'Periksa filter oli (buka/potong) untuk serpihan logam.',
                  'Persingkat interval sampling (100–150 jam) untuk memantau laju kenaikan.'] },
      // [TIER 3 — Critical] Tinggi + bukti pendukung: baru deep-dive.
      { likely: ['Keausan signifikan piston ring / cylinder liner / bearing internal (biasanya DISERTAI kenaikan Cr, Cu, Pb, atau Si, dan blowby tinggi)',
                 'Kontaminasi besi dari komponen aus (abrasive) bila bersama Si/Al tinggi',
                 'Lonjakan Fe tajam antar-sampel (laju keausan akseleratif)'],
        actions: ['Inspeksi borescope silinder & ukur end-gap ring.',
                  'Cut-open filter oli & periksa partikel/serpihan logam (metode utama pada engine; engine umumnya tidak memiliki magnetic plug).',
                  'Kompression/blowby test & analisis lanjutan (oil debris) bila tersedia.',
                  'Siapkan rencana overhaul terukur bila tren Fe terus naik & didukung Cr/Cu/Pb.'],
        escalate: 'Batasi operasi berat & jadwalkan inspeksi mekanik segera — HANYA bila Fe tinggi disertai bukti pendukung (bukan nilai tunggal).' }),

    wear_cu: entry('wear',
      ['Bearing (Cu-Pb)', 'Oil cooler', 'Bushing'],
      // TIER 1 — Monitor
      { likely: ['Cu sedikit naik — bisa dari keausan normal bushing/bearing atau residu awal',
                 'Belum spesifik: perlu dibedakan dari kontaminasi oil cooler'],
        actions: ['Pantau tren Cu & Sn (bila ada) untuk lokalisasi sumber.',
                  'Periksa kebersihan & integritas oil cooler secara visual.',
                  'Konfirmasi ulang pada sampling berikutnya sebelum tindakan lebih jauh.'] },
      // TIER 2 — Caution
      { likely: ['Keausan bushing/bearing kuningan mulai nyata',
                 'Awal kontaminasi dari oil cooler atau seal'],
        actions: ['Uji tekanan & periksa kebocoran oil cooler (pressure/leak test).',
                  'Cek clearance & kondisi pelumasan bearing yang terjangkau.',
                  'Persingkat interval sampling & pantau tren Cu bersama Pb/Sn.'] },
      // TIER 3 — Critical
      { likely: ['Keausan bearing Cu-Pb signifikan / kebocoran internal oil cooler yang berlanjut',
                 'Kontaminasi dari bantalan/cage yang aus (biasanya disertai Pb/Sn naik)'],
        actions: ['Inspeksi bearing utama & connecting rod (bila bukti pendukung kuat).',
                  'Analisis lanjutan (debris/SEM-EDS) & evaluasi jadwal ganti bearing.',
                  'Perbaiki sumber kontaminasi (oil cooler/seal) secara menyeluruh.'],
        escalate: 'Waspadai indikasi bearing failure — siapkan shutdown terkendali bila didukung Pb/Sn & tren naik.' }),

    wear_al: entry('wear',
      ['Piston (aluminium)', 'Housing', 'Bearing shell'],
      // TIER 1 — Monitor
      { likely: ['Al sedikit naik — bisa keausan ringan komponen aluminium atau awal ingesti debu',
                 'Perlu dibedakan: dirt (bersama Si) vs wear komponen'],
        actions: ['Bandingkan Al dengan Silika (Si) — bila keduanya naik, curiga debu.',
                  'Pantau tren Aluminium (Al) antar sampling.'] },
      // TIER 2 — Caution
      { likely: ['Keausan aluminium/piston mulai nyata',
                 'Indikasi awal ingesti debu'],
        actions: ['Periksa sistem intake & lakukan pembersihan bila kotor.',
                  'Cek & kencangkan clamp/hose jalur intake (potensi kebocoran debu).',
                  'Hitung Dirt Entry Index (Si + Al) & pantau trennya.'] },
      // TIER 3 — Critical
      { likely: ['Keausan piston/shell bearing signifikan (disertai Fe/Si naik)',
                 'Ingesti debu abrasif berkelanjutan (Dirt Entry tinggi)'],
        actions: ['Inspeksi piston/skirt & bearing shell + borescope silinder.',
                  'Inspeksi menyeluruh jalur intake & intercooler; perbaiki kebocoran.',
                  'Konfirmasi kontaminasi debu (Si & Al tinggi bersamaan).'],
        escalate: 'Cegah ingesti debu sebelum keausan linier meluas — konfirmasi & perbaiki jalur intake segera.' }),

    wear_cr: entry('wear',
      ['Ring (chrome-plated)', 'Liner', 'Seal'],
      // TIER 1 — Monitor
      { likely: ['Cr sedikit naik — awal keausan coating chromium ring/liner',
                 'Perlu cek apakah disertai indikasi coolant (Na/K/B)'],
        actions: ['Pantau tren Cr & cek keberadaan indikasi coolant infiltration.',
                  'Periksa kondisi ring & liner saat kesempatan (bila ada akses).'] },
      // TIER 2 — Caution
      { likely: ['Keausan lapisan chromium mulai nyata',
                 'Kemungkinan awal kebocoran coolant ke oli'],
        actions: ['Uji kontaminasi coolant (glycol test, K, B).',
                  'Periksa gasket head & oil cooler (indikasi visual).',
                  'Periksa & adjust valve clearance — Cr naik sering terkait valve seat chrome yang aus.',
                  'Pantau Cr bersama Fe & indikator coolant.'] },
      // TIER 3 — Critical
      { likely: ['Keausan lapisan chromium signifikan',
                 'Kebocoran coolant ke oli (glycol contamination) yang berlanjut'],
        actions: ['Inspeksi ring, liner, dan sistem pendingin secara menyeluruh.',
                  'Perbaiki sumber kebocoran (gasket head / oil cooler / seal).',
                  'Ganti oli bila terjadi emulsi; coolant merusak pelumasan.'],
        escalate: 'Segera cek sistem pendingin bila curiga coolant masuk oli (Na/K/B juga tinggi).' }),

    wear_pb: entry('wear',
      ['Bearing overlay (Pb)', 'Seal', 'Babbitt'],
      // TIER 1 — Monitor
      { likely: ['Pb sedikit naik — awal keausan overlay bearing',
                 'Sering bergerak bersama Cu (pantau keduanya)'],
        actions: ['Pantau tren Pb & Cu (sering bersamaan).',
                  'Cek kondisi oli (viskositas, TBN) yang mempengaruhi umur bearing.'] },
      // TIER 2 — Caution
      { likely: ['Keausan overlay bearing mulai signifikan',
                 'Perlu evaluasi clearance & pelumasan'],
        actions: ['Cek clearance & kondisi pelumasan bearing.',
                  'Periksa tekanan oli & suara abnormal (tanpa bongkar penuh).',
                  'Persingkat interval sampling & pantau laju kenaikan Pb.'] },
      // TIER 3 — Critical
      { likely: ['Keausan overlay Pb kritis — risiko bearing failure bila terus beroperasi',
                 'Overlay menipis (disertai Cu/Sn naik)'],
        actions: ['Inspeksi bearing utama & rod menyeluruh (konfirmasi bukti pendukung).',
                  'Evaluasi jadwal penggantian bearing & clearance.',
                  'Verifikasi kualitas oli (viskositas/TBN) sebelum operasi lanjut.'],
        escalate: 'Jangan abaikan — overlay Pb habis dapat menyebabkan metal-to-metal.' }),

    wear_si: entry('wear',
      ['Ingesti debu', 'Gasket/seal silicon', 'Additive (anti-foam)'],
      // TIER 1 — Monitor
      { likely: ['Si sedikit naik — awal ingesti debu / RTV / residu additive anti-foam (kadar rendah)',
                 'Perlu dibedakan: dirt vs sealant'],
        actions: ['Periksa & ganti elemen air cleaner bila perlu.',
                  'Cek integritas jalur intake setelah filter (visual).',
                  'Bandingkan dengan Aluminium (Al) — bila keduanya tinggi, kuat indikasi debu masuk.'] },
      // TIER 2 — Caution
      { likely: ['Ingesti debu mulai nyata',
                 'Kemungkinan kebocoran kecil jalur intake / seal'],
        actions: ['Periksa clamp, hose, boot intake — perbaiki kebocoran ringan.',
                  'Ganti elemen filter udara bila kotor; pastikan pemasangan benar.',
                  'Hitung & pantau Dirt Entry Index (Si + Al).'] },
      // TIER 3 — Critical
      { likely: ['Ingesti debu abrasif berkelanjutan (Dirt Entry tinggi)',
                 'Kerusakan seal/gasket terkait (disertai keausan Fe/Al)'],
        actions: ['Inspeksi menyeluruh sistem intake & intercooler.',
                  'Perbaiki seluruh titik kebocoran; ganti komponen seal yang rusak.',
                  'Pantau Dirt Entry Index pasca-perbaikan untuk verifikasi.'],
        escalate: 'Hentikan sumber ingesti debu sebelum keausan linier meluas (bila Si & Al terus naik).' }),

    wear_sn: entry('wear',
      ['Bearing (Cu-Pb-Sn)', 'Piston ring coating'],
      // TIER 1 — Monitor
      { likely: ['Sn sedikit naik — keausan ringan komponen berbasis timah (bearing overlay, bushing)',
                 'Sn sering muncul bersama Cu/Pb pada bearing Cu-Pb-Sn; pantau ketiganya bersamaan'],
        actions: ['Pantau tren Sn bersama Cu & Pb — bila ketiganya naik, indikasi bearing overlay menipis.',
                  'Cek kondisi oli (viskositas, TBN) — pelumasan buruk mempercepat keausan Sn.',
                  'Periksa bearing/bushing terkait saat ada akses (preventive inspection).'] },
      // TIER 2 — Caution
      { likely: ['Keausan komponen Sn mulai nyata — bearing overlay atau bushing Cu-Pb-Sn aus',
                 'Perlu evaluasi clearance & kondisi pelumasan'],
        actions: ['Cek clearance bearing (plastigauge/feeler gauge bila dapat diakses).',
                  'Uji viskositas & TBN oli — pelumasan tidak memadai mempercepat Sn naik.',
                  'Persingkat interval sampling (100–150 jam) untuk pantau laju kenaikan.',
                  'Cross-check Cu & Pb: bila keduanya juga naik, arahkan inspeksi ke bearing.'] },
      // TIER 3 — Critical
      { likely: ['Keausan bearing Sn signifikan — overlay Cu-Pb-Sn hampir habis',
                 'Risiko bearing failure bila terus beroperasi tanpa tindakan'],
        actions: ['Inspeksi bearing utama (main & rod bearing) — konfirmasi dengan bukti Cu/Pb.',
                  'Evaluasi jadwal penggantian bearing & ukur clearance aktual vs spesifikasi.',
                  'Verifikasi kualitas oli (viskositas, TBN, kontaminasi) sebelum operasi lanjut.',
                  'Periksa oil cooler & sistem pelumasan untuk memastikan aliran oli memadai.'],
        escalate: 'Sn tinggi bersama Cu/Pb = overlay bearing hampir habis — siapkan penggantian bearing segera.' }),

    wear_ni: entry('wear',
      ['Valve / seat', 'Turbocharger', 'Alloy steel'],
      // TIER 1 — Monitor
      { likely: ['Ni sedikit naik — awal keausan komponen paduan nikel (valve seat, turbo bearing/shaft)',
                 'Perlu dibedakan: keausan valve vs turbo vs komponen paduan lain'],
        actions: ['Pantau tren Ni bersama Cr (valve seat chrome) & Fe (general wear).',
                  'Cek boost pressure — indikasi awal performa turbo menurun.',
                  'Dengarkan suara abnormal dari turbo (whining/grinding/whistling).'] },
      // TIER 2 — Caution
      { likely: ['Keausan komponen nikel mulai nyata — valve seat dan/atau turbo bearing',
                 'Bila disertai Cr naik: fokus ke valve seat; bila Fe juga naik: turbo shaft'],
        actions: ['Ukur end-play turbocharger (radial & axial) dengan dial indicator — bandingkan spesifikasi.',
                  'Periksa valve clearance & kondisi seat (lapping/recession) saat ada akses.',
                  'Periksa kondisi intercooler & jalur boost untuk kebocoran.',
                  'Cross-check SOS Cr — bila Cr juga naik, kuat indikasi valve seat aus.'] },
      // TIER 3 — Critical
      { likely: ['Keausan signifikan komponen paduan nikel — valve seat recession atau turbo bearing failure',
                 'Perlu inspeksi menyeluruh untuk identifikasi sumber Ni'],
        actions: ['Inspeksi turbocharger menyeluruh: bongkar, cek bearing/shaft, ukur end-play vs batas manual.',
                  'Top-end inspection: periksa valve, seat, guide — ukur seat recession & clearance.',
                  'Cross-check boost pressure trend & SOS Cr/Fe untuk lokalisasi sumber.',
                  'Evaluasi jadwal overhaul top-end atau turbo replacement.'],
        escalate: 'Ni tinggi berkelanjutan mengindikasikan keausan valve/turbo lanjut — jadwalkan inspeksi segera.' }),

    /* ---------------- OIL CONDITION ---------------- */
    visc_v100: entry('oil',
      ['SAE grade', 'Degradasi oli'],
      // TIER 1 — Monitor
      { likely: ['Viskositas mulai bergeser (masih dekat rentang) — awal oksidasi/soot/fuel dilution',
                 'Bisa juga variasi sampling atau grade oli'],
        actions: ['Cek Fuel Dilution, Soot & Oxidation sebagai penyebab potensial.',
                  'Verifikasi grade oli yang dipakai & interval ganti.',
                  'Konfirmasi pada sampling berikutnya.'] },
      // TIER 2 — Caution
      { likely: ['Viskositas menyimpang nyata — degradasi mulai berdampak pada film pelumasan'],
        actions: ['Cari penyebab dominan (fuel dilution / soot / panas).',
                  'Pertimbangkan ganti oli lebih awal & verifikasi grade.',
                  'Cek kondisi operasi (beban, suhu) yang mempercepat degradasi.'] },
      // TIER 3 — Critical
      { likely: ['Viskositas sangat menyimpang (terlalu kental/encer) — degradasi lanjut / kontaminasi fuel berat'],
        actions: ['Ganti oli & filter segera.',
                  'Cari akar penyebab: injektor (fuel dilution), soot tinggi, atau panas berlebih.',
                  'Analisis ulang setelah penggantian untuk verifikasi.'],
        escalate: 'Viskositas ekstrem mengancam film pelumasan — jangan ditunda.' }),

    visc_v40: entry('oil',
      ['SAE grade', 'Degradasi oli', 'Viscosity Index'],
      // TIER 1 — Monitor
      { likely: ['Viskositas @40\u00b0C mulai bergeser dari rentang baseline — awal degradasi atau kontaminasi ringan',
                 'V40 naik = soot/oksidasi (oli mengental); V40 turun = fuel dilution/shear (oli mengencer)'],
        actions: ['Bandingkan V40 dengan V100 untuk hitung Viscosity Index (VI) — VI turun = degradasi lanjut.',
                  'Cek SOS Fuel Dilution & Soot — penyebab utama pergeseran viskositas.',
                  'Verifikasi grade oli yang digunakan vs spesifikasi manual (SAE 10W-30/15W-40/dll).',
                  'Konfirmasi pada sampling berikutnya sebelum tindakan.'] },
      // TIER 2 — Caution
      { likely: ['Viskositas @40\u00b0C menyimpang nyata — film pelumasan mulai terdampak',
                 'Penyebab dominan: fuel dilution (V40 turun) atau oksidasi/soot (V40 naik)'],
        actions: ['Identifikasi penyebab: cek Fuel%, Soot, Oxidation, Water% pada sampel yang sama.',
                  'Bila V40 TURUN: uji injektor (spray/leak), cek ring piston, kurangi idle berkepanjangan.',
                  'Bila V40 NAIK: cek suhu operasi berlebih, evaluasi interval ganti oli.',
                  'Pertimbangkan ganti oli lebih awal & verifikasi grade sesuai manual.'] },
      // TIER 3 — Critical
      { likely: ['Viskositas @40\u00b0C sangat menyimpang — pelumasan tidak efektif',
                 'Film oli tidak mampu melindungi komponen pada suhu operasi normal'],
        actions: ['Ganti oli & filter segera — jangan operasikan unit dengan viskositas ekstrem.',
                  'Cari akar penyebab: injektor bocor (fuel), soot berlebih (pembakaran), atau panas (cooling).',
                  'Analisis ulang setelah ganti oli untuk verifikasi penyebab teratasi.',
                  'Pantau V40 bersama V100 & Oxidation pada sampling berikutnya.'],
        escalate: 'Viskositas @40\u00b0C ekstrem = film pelumasan hilang pada suhu operasi — ganti oli tanpa ditunda.' }),

    tbn: entry('oil',
      ['Reserve alkalinity', 'Total Base Number'],
      // TIER 1 — Monitor
      { likely: ['Cadangan alkalinitas mulai berkurang — kemampuan netralisasi asam menurun',
                 'TBN turun lebih cepat bila: sulfur bahan bakar tinggi, interval ganti oli panjang, suhu operasi tinggi'],
        actions: ['Pantau tren TBN antar sampling — hitung laju penurunan per 100 jam.',
                  'Cek kadar sulfur bahan bakar & kondisi operasi (beban, suhu).',
                  'Bandingkan TBN dengan Oxidation & Sulfation — ketiganya saling terkait.',
                  'Pertimbangkan persingkat interval ganti oli bila laju penurunan TBN > 1 mgKOH/g per 250 jam.'] },
      // TIER 2 — Caution
      { likely: ['TBN menurun nyata — daya netralisasi asam menipis, oli mulai bersifat asam',
                 'Risiko korosi internal & degradasi aditif meningkat'],
        actions: ['Siapkan ganti oli & filter dalam waktu dekat.',
                  'Verifikasi kualitas bahan bakar (sulfur) — bahan bakar sulfur tinggi menguras TBN lebih cepat.',
                  'Pantau bersama Oxidation & Sulfation — bila keduanya juga naik, degradasi oli menyeluruh.',
                  'Cek apakah ada pencampuran grade oli (top-up dengan grade berbeda menurunkan TBN).'] },
      // TIER 3 — Critical
      { likely: ['TBN sangat rendah / habis — oli bersifat asam, tidak mampu melindungi dari korosi',
                 'Risiko korosi bearing, seal, & komponen internal meningkat signifikan'],
        actions: ['Ganti oli & filter segera — oli asam merusak bearing & seal.',
                  'Periksa komponen internal untuk tanda korosi (discoloration, pitting).',
                  'Rutinkan sampling pasca-ganti untuk memantau TBN baru tercapai.',
                  'Evaluasi: apakah grade oli, interval, atau kualitas BBM perlu disesuaikan.'],
        escalate: 'TBN habis = oli bersifat asam — risiko korosi internal; ganti oli tanpa ditunda.' }),

    water_pct: entry('oil',
      ['Kondensasi', 'Kebocoran coolant'],
      { likely: ['Kondensasi ringan / masuknya uap air', 'Kebocoran coolant kecil'],
        actions: ['Periksa sistem pendingin & breather.',
                  'Panaskan unit untuk menguapkan kondensasi (bila ringan).'] },
      { likely: ['Kontaminasi air mulai nyata'],
        actions: ['Cek titik masuk air (breather, seal, filler cap).',
                  'Pantau kadar air & kondisi oli (kekeruhan).'] },
      { likely: ['Kontaminasi air/coolant signifikan', 'Kebocoran oil cooler / gasket head'],
        actions: ['Uji kebocoran sistem pendingin (pressure test).',
                  'Ganti oli (air merusak pelumasan & memicu korosi).',
                  'Periksa oil cooler & gasket head menyeluruh.'],
        escalate: 'Air > ambang kritis -> risiko emulsi & korosi; hentikan bila perlu.' }),

    fuel_pct: entry('oil',
      ['Injektor', 'Ring piston', 'Sistem bahan bakar'],
      { likely: ['Dilusi bahan bakar ringan (idle lama / stop-and-go)', 'Injektor mulai tidak optimal'],
        actions: ['Minimalkan idle berkepanjangan.',
                  'Pantau tren fuel dilution & viskositas.'] },
      { likely: ['Dilusi bahan bakar sedang — viskositas mulai turun'],
        actions: ['Uji injektor (spray/leak) tanpa bongkar penuh.',
                  'Cek strategi bahan bakar & pola operasi.',
                  'Pantau viskositas: bila turun tajam, pertimbangkan ganti oli.'] },
      { likely: ['Dilusi bahan bakar signifikan', 'Injektor bocor / ring aus / strategi bahan bakar salah'],
        actions: ['Uji injektor & periksa kebocoran; cek kompresi/ring piston.',
                  'Ganti oli (viskositas menurun tajam).'],
        escalate: 'Fuel dilution tinggi menurunkan viskositas -> risiko keausan.' }),

    soot: entry('oil',
      ['Pembakaran', 'EGR', 'Filter udara'],
      { likely: ['Akumulasi soot mulai meningkat'],
        actions: ['Periksa filter udara & kualitas pembakaran.',
                  'Pantau tren soot & viskositas.'] },
      { likely: ['Soot loading sedang — mulai memengaruhi viskositas'],
        actions: ['Periksa sistem intake & pola pembakaran.',
                  'Pantau bersama viskositas & TBN.'] },
      { likely: ['Soot loading tinggi -> oli mengental, sludge', 'Masalah pembakaran / intake signifikan'],
        actions: ['Ganti oli & filter.',
                  'Periksa sistem intake, injektor, & pembakaran menyeluruh.',
                  'Evaluasi kondisi operasi (beban, putaran).'],
        escalate: 'Soot berlebih meningkatkan keausan & mempercepat degradasi oli.' }),

    oxidation: entry('oil',
      ['Panas berlebih', 'Umur oli', 'FTIR Oxidation Peak'],
      // TIER 1 — Monitor
      { likely: ['Oksidasi oli mulai meningkat — panas operasi atau umur oli mendekati batas',
                 'Oksidasi mempercepat pembentukan varnish & sludge yang menyumbat saluran oli'],
        actions: ['Cek suhu operasi (Engine Oil Temp, Coolant Temp) — panas berlebih mempercepat oksidasi.',
                  'Pantau Oxidation bersama TBN & Viskositas — ketiganya degradasi saling terkait.',
                  'Verifikasi interval ganti oli vs rekomendasi manual.'] },
      // TIER 2 — Caution
      { likely: ['Oksidasi sedang — mulai membentuk varnish & deposit pada permukaan komponen',
                 'Viskositas cenderung naik (oli mengental); TBN cenderung turun'],
        actions: ['Identifikasi sumber panas berlebih: periksa cooling system, beban operasi, oil cooler.',
                  'Pertimbangkan ganti oli lebih awal — oksidasi lanjut tidak reversibel.',
                  'Pantau viskositas: bila naik bersamaan, konfirmasi degradasi termal.',
                  'Cross-check suhu VHMS (Engine Oil Temp, Coolant Temp) untuk korelasi panas.'] },
      // TIER 3 — Critical
      { likely: ['Oksidasi lanjut — varnish, sludge, & keasaman naik signifikan',
                 'Oli kehilangan kemampuan pelumasan & perlindungan anti-korosi'],
        actions: ['Ganti oli & filter segera — oksidasi tidak bisa dipulihkan.',
                  'Bersihkan sistem (flush) bila terjadi sludge/deposit.',
                  'Perbaiki penyebab panas berlebih (cooling, beban, oil cooler) secara menyeluruh.',
                  'Periksa komponen internal untuk deposit/scoring akibat varnish.'],
        escalate: 'Oksidasi tinggi mempercepat keausan & memperpendek umur komponen — ganti oli segera.' }),

    nitration: entry('oil',
      ['Pembakaran', 'Gas buang', 'NOx reaction', 'FTIR Nitration Peak'],
      // TIER 1 — Monitor
      { likely: ['Nitrasi mulai meningkat — produk reaksi NOx gas buang dengan oli',
                 'Penyebab umum: blow-by gas ke crankcase, EGR berlebih, pembakaran tidak sempurna'],
        actions: ['Pantau Nitration bersama Soot & Oxidation — ketiganya sering naik bersamaan.',
                  'Cek sistem breather/crankcase ventilation — tersumbat mempercepat nitrasi.',
                  'Periksa kondisi air cleaner & kualitas pembakaran (warna gas buang).'] },
      // TIER 2 — Caution
      { likely: ['Nitrasi sedang — reaksi NOx meningkat, indikasi pembakaran tidak optimal',
                 'Sering disertai kenaikan soot (pembakaran tidak sempurna) dan penurunan TBN'],
        actions: ['Cek sistem EGR (bila ada): valve, cooler, jalur — EGR macet/berlebih meningkatkan NOx ke oli.',
                  'Periksa kondisi injektor & timing injeksi — pembakaran buruk menghasilkan NOx berlebih.',
                  'Evaluasi deposit/carbon build-up pada ruang bakar & cylinder head.',
                  'Cross-check Soot & Fuel Dilution pada sampel yang sama.'] },
      // TIER 3 — Critical
      { likely: ['Nitrasi tinggi — degradasi oli akibat reaksi NOx berlebih',
                 'Oli mengental (gel/sludge), aditif terkuras, risiko plugging filter'],
        actions: ['Ganti oli & filter segera — nitrasi tinggi menyebabkan gel & sludge.',
                  'Inspeksi & perbaiki: EGR, injektor, timing, crankcase ventilation.',
                  'Periksa filter oli & saluran untuk sumbatan akibat gel/deposit.',
                  'Evaluasi kondisi operasi: beban, putaran, suhu — sesuaikan bila memungkinkan.'],
        escalate: 'Nitrasi tinggi membentuk gel/sludge & mempercepat degradasi total oli.' }),

    sulfation: entry('oil',
      ['Kualitas bahan bakar', 'Pembakaran', 'Sulfur content', 'FTIR Sulfation Peak'],
      // TIER 1 — Monitor
      { likely: ['Sulfasi mulai terbentuk — produk reaksi sulfur bahan bakar dengan oli',
                 'Sulfasi mengikis cadangan basa (TBN) dan memicu korosi bila berlanjut'],
        actions: ['Verifikasi kualitas bahan bakar: cek kandungan sulfur (tinggi di area tambang tertentu).',
                  'Pantau Sulfation bersama TBN — sulfasi menguras TBN lebih cepat.',
                  'Bandingkan dengan baseline unit lain di lokasi yang sama (apakah masalah BBM regional).'] },
      // TIER 2 — Caution
      { likely: ['Sulfasi sedang — cadangan basa mulai terkuras, asam sulfat mulai terbentuk',
                 'Indikasi: TBN turun bersamaan; risiko korosi bearing & komponen internal'],
        actions: ['Persingkat interval ganti oli untuk kompensasi konsumsi TBN.',
                  'Verifikasi sumber BBM: apakah ada perubahan supplier/kualitas.',
                  'Pantau TBN: bila TBN habis bersamaan sulfasi naik, ganti oli segera.',
                  'Pertimbangkan oli dengan TBN awal lebih tinggi (heavy-duty grade) untuk lingkungan sulfur tinggi.'] },
      // TIER 3 — Critical
      { likely: ['Sulfasi tinggi — asam sulfat terbentuk signifikan dalam oli',
                 'TBN kemungkinan habis; risiko korosi & keausan internal lanjut'],
        actions: ['Ganti oli & filter segera — asam sulfat merusak bearing & seal.',
                  'Perbaiki kualitas bahan bakar: ganti sumber BBM atau gunakan grade rendah sulfur.',
                  'Periksa komponen internal untuk tanda korosi (pitting, discoloration).',
                  'Evaluasi: gunakan oli spesifikasi CK-4/FA-4 (tahan sulfur) atau setara.'],
        escalate: 'Sulfasi tinggi + TBN habis = korosi internal aktif — ganti oli & BBM segera.' }),

    /* ---------------- CLEANLINESS ---------------- */
    pqi: entry('clean',
      ['Particle Quantifier Index'],
      { likely: ['Peningkatan partikel (kebersihan mulai menurun)',
                 'Kontaminasi mulai masuk (breather/seal/drain plug)'],
        actions: ['Tinjau tren PQI antar sampling & bandingkan dengan baseline kompartemen.',
                  'Cek titik masuk kontaminasi (breather, seal, & drain plug).'] },
      { likely: ['Partikel sedang tinggi — kontaminasi masuk melebihi kemampuan pembersihan'],
        actions: ['Periksa & bersihkan titik masuk kontaminasi; verifikasi kondisi kebersihan kompartemen.',
                  'Tindak kebersihan kompartemen sesuai panduan spesifik kompartemen (baris panduan di bawah).',
                  'Pantau tren PQI antar sampling.'] },
      { likely: ['Tingkat partikel tinggi -> risiko keausan abrasif',
                 'Kontaminasi berat / sistem kebersihan tidak efektif'],
        actions: ['Lakukan tindakan kebersihan spesifik kompartemen (lihat panduan kompartemen di bawah) & ganti oli.',
                  'Periksa seluruh titik masuk kontaminasi & komponen bergerak.',
                  'Rutinkan sampling untuk verifikasi kebersihan.'],
        escalate: 'Partikel tinggi mempercepat keausan & merusak clearance presisi.' }),

    pc_4u: entry('clean', ['Particle count >4µm'],
      { likely: ['Partikel halus mulai meningkat'], actions: ['Periksa filtrasi & kebersihan oli.'] },
      { likely: ['Partikel halus tinggi'], actions: ['Tindak kebersihan/penyaringan yang RELEVAN kompartemen; cek sumber kontaminasi.'],
        escalate: 'Kebersihan oli di bawah target ISO.' }),

    pc_6u: entry('clean', ['Particle count >6µm'],
      { likely: ['Partikel sedang meningkat'], actions: ['Pantau kebersihan & filtrasi.'] },
      { likely: ['Partikel sedang tinggi'], actions: ['Evaluasi kebersihan & kontaminasi kompartemen.'],
        escalate: 'Kebersihan oli di bawah target ISO.' }),

    pc_14u: entry('clean', ['Particle count >14µm'],
      { likely: ['Partikel besar meningkat'], actions: ['Periksa sumber keausan/kontaminasi.'] },
      { likely: ['Partikel besar tinggi -> keausan']  ,
        actions: ['Inspeksi komponen bergerak & langkah kebersihan kompartemen.'],
        escalate: 'Partikel besar mengindikasikan keausan aktif.' }),

    pc_21u: entry('clean', ['Particle count >21µm'],
      { likely: ['Partikel besar kritis'], actions: ['Segera periksa sumber keausan.'] },
      { likely: ['Partikel besar sangat tinggi'], actions: ['Inspeksi menyeluruh; kuras & ganti oli; tindak kebersihan yang relevan kompartemen.'],
        escalate: 'Risiko keausan berat — prioritaskan inspeksi.' }),

    /* ---------------- ADDITIVES ---------------- */
    additive_p:  entry('additive', ['ZDDP (Zinc Dialkyl Dithiophosphate)'],
      { likely: ['Kadar Phosphorus mulai turun — aditif anti-aus (ZDDP) terpakai seiring operasi',
                 'Penurunan normal bila proporsional dengan jam oli; waspadai bila turun tajam'],
        actions: ['Pantau tren P bersama Zn & TBN — ketiganya bagian dari paket ZDDP.',
                  'Cek interval ganti oli: P turun lebih cepat bila interval terlalu panjang.',
                  'Bandingkan dengan baseline oli baru (nilai P awal dari spesifikasi oli).'] },
      { likely: ['Aditif anti-aus (ZDDP) menipis signifikan — perlindungan keausan berkurang',
                 'Indikasi oli sudah melampaui usia pakai efektif'],
        actions: ['Ganti oli & filter — aditif tidak bisa diisi ulang (harus ganti penuh).',
                  'Verifikasi grade oli: pastikan mengandung ZDDP sesuai spesifikasi mesin.',
                  'Cek apakah ada pencampuran grade oli (top-up dengan oli berbeda merusak keseimbangan aditif).'],
        escalate: 'Proteksi anti-aus menurun — percepat penggantian oli.' }),
    additive_zn: entry('additive', ['ZDDP (Zinc Dialkyl Dithiophosphate)'],
      { likely: ['Zinc (anti-aus ZDDP) mulai turun — normal seiring operasi',
                 'Zn & P biasanya turun bersamaan (keduanya dari paket ZDDP)'],
        actions: ['Pantau tren Zn bersama P & TBN — pola turun bersamaan = konsumsi ZDDP normal.',
                  'Zn turun TANPA P turun = kemungkinan kontaminasi atau pencampuran oli.'] },
      { likely: ['Aditif anti-aus habis — pelumasan batas (boundary lubrication) tidak efektif'],
        actions: ['Ganti oli & filter.',
                  'Verifikasi grade oli sesuai spesifikasi — pastikan aditif ZDDP tercukupi.'],
        escalate: 'Proteksi anti-aus menurun — percepat penggantian oli.' }),
    additive_ca: entry('additive', ['Detergent (Calcium Sulfonate/Phenate)'],
      { likely: ['Calcium (detergen) bergeser — bisa turun (terpakai) atau naik (kontaminasi/pencampuran)',
                 'Ca sebagai detergen menjaga kebersihan internal & menetralisasi asam'],
        actions: ['Cek tren Ca bersama TBN & Mg — Ca turun + TBN turun = detergen terpakai.',
                  'Bandingkan dengan baseline oli baru untuk evaluasi sisa detergen.'] },
      { likely: ['Keseimbangan aditif detergen terganggu — risiko pembentukan deposit & sludge'],
        actions: ['Ganti oli & verifikasi grade sesuai spesifikasi.',
                  'Cek apakah ada pencampuran grade oli (top-up dengan oli berbeda).'],
        escalate: 'Kondisi aditif detergen perlu evaluasi — pertimbangkan ganti oli.' }),
    additive_mg: entry('additive', ['Detergent (Magnesium Sulfonate)'],
      { likely: ['Magnesium (detergen) bergeser — biasanya bergerak bersama Ca',
                 'Mg sebagai co-detergent bekerja bersama Ca menetralisasi asam'],
        actions: ['Pantau bersama Ca & TBN — pola bersamaan = konsumsi detergen normal.',
                  'Bandingkan dengan baseline oli baru.'] },
      { likely: ['Keseimbangan aditif terganggu — detergen tidak efektif'],
        actions: ['Ganti oli — aditif detergen tidak bisa ditambahkan terpisah.',
                  'Verifikasi grade oli sesuai spesifikasi manual.'],
        escalate: 'Evaluasi keseimbangan aditif — konsultasikan dengan supplier oli.' }),
    additive_mo: entry('additive', ['Friction Modifier (Molybdenum)'],
      { likely: ['Molybdenum (friction modifier) bergeser — aditif pengurang gesekan berubah',
                 'Mo tidak selalu ada di semua grade oli — cek formulasi oli yang digunakan'],
        actions: ['Pantau tren Mo: bila turun = aditif terpakai; bila naik tanpa ganti oli = kontaminasi.',
                  'Verifikasi formulasi oli yang digunakan (apakah mengandung MoDTC/MoDTP).'] },
      { likely: ['Friction modifier habis atau berubah signifikan — efisiensi gesekan menurun'],
        actions: ['Verifikasi grade oli & formulasi aditif.',
                  'Ganti oli bila formulasi tidak sesuai spesifikasi.'],
        escalate: 'Evaluasi aditif anti-friksi — pertimbangkan grade oli yang sesuai.' }),
    additive_b:  entry('additive', ['Boron (dispersant/coolant indicator)'], { likely: ['Boron bergeser; bila tinggal jejak cek coolant (B dalam coolant)'], actions: ['Bila B & Na/K naik -> curiga coolant.'], }, { likely: ['Kontaminasi coolant (borat)'], actions: ['Uji glycol/ coolant infiltration.'], escalate: 'Cek sistem pendingin.' }),
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
    additive_ba: entry('additive', ['Barium (detergen/inhibitor)'],
      { likely: ['Barium (detergen/inhibitor) bergeser — Ba tidak umum di oli modern; bisa indikasi kontaminasi lintas-grade',
                 'Beberapa oli khusus (marine, gas engine) mengandung Ba sebagai detergen'],
        actions: ['Pantau tren Ba — bila konsisten stabil, kemungkinan bagian dari formulasi oli.',
                  'Cek apakah ada pencampuran grade oli (Ba muncul dari oli berbeda saat top-up).'] },
      { likely: ['Kondisi aditif terganggu — Ba berubah signifikan dari baseline'],
        actions: ['Verifikasi grade & supplier oli — pastikan sesuai spesifikasi.',
                  'Ganti oli bila terjadi pencampuran grade atau kontaminasi.'],
        escalate: 'Evaluasi formulasi oli & pastikan grade sesuai spesifikasi manual.' })
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
   * 1a3. [VALIDASI RELEVANSI FILTER 2026-10-01] Tidak semua kompartemen
   * memiliki ELEMEN FILTER oli. Final drive / differential / swing / gearbox
   * murni (gear case, reducer, transfer) umumnya beroperasi TANPA filter —
   * hanya magnetic drain plug / magnetic screen. Karena itu saran
   * "ganti filter" / "potong filter" TIDAK BOLEH muncul untuk kompartemen
   * tsb; diganti dengan pemeriksaan magnetic plug + pengurasan oli.
   *   - engine   : ADA filter oli (cut-open filter = metode utama).
   *   - gearbox  : UMUMNYA ada filter/screen (transmisi & converter).
   *   - hydraulic: ADA filter hidrolik.
   *   - axle     : TIDAK ada filter → magnetic plug/drain plug saja.
   *   - gear     : TIDAK ada filter → magnetic plug/drain plug saja.
   *   - cooling  : tidak memakai istilah filter oli (media coolant/radiator).
   * --------------------------------------------------------------------- */
  var FILTERLESS_FAMILIES = { axle: true, gear: true };

  /** Kompartemen ini (umumnya) TIDAK memiliki elemen filter oli? */
  function isFilterless(component) {
    var comp = normalizeComponent(component);
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    return !!(fam && FILTERLESS_FAMILIES[fam]);
  }

  /**
   * Frasa RELEVAN untuk aksi terkait FILTRASI/kebersihan, sesuai kompartemen.
   * Dipakai mengganti saran "ganti filter"/"potong filter" pada kompartemen
   * yang TIDAK punya filter (mis. FINAL DRIVE / gear case).
   * @param {string} component nama kompartemen
   * @returns {string} frasa siap pakai di narasi tindakan
   */
  function filterRelevancePhrase(component) {
    var comp = normalizeComponent(component);
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    if (fam === 'engine') {
      return 'Periksa/ganti filter oli mesin & potong (cut-open) untuk memeriksa partikel kontaminan.';
    }
    if (fam === 'gearbox') {
      return 'Periksa filter/screen & magnetic drain plug kompartemen (bila model menyediakan); bersihkan magnet dari serpihan.';
    }
    if (fam === 'hydraulic') {
      return 'Periksa/ganti elemen filter hidrolik & bersihkan magnet drain plug (bila ada); verifikasi tingkat kebersihan oli.';
    }
    if (FILTERLESS_FAMILIES[fam]) {
      // axle (final drive/differential/swing) & gear (PTO/reducer/case):
      // kompartemen ini TIDAK memakai elemen penyaring — cukup magnetic plug + kuras oli.
      // [FIX 2026-10-01] Tambah rekomendasi kidney loop (portable filtering)
      // untuk membersihkan kontaminan partikel tanpa harus kuras penuh.
      return 'Bersihkan & periksa magnetic drain plug / magnetic screen (bila model unit menyediakan), lalu kuras & ganti oli kompartemen. Pertimbangkan kidney loop filtration (portable filtering unit) untuk membersihkan partikel tanpa kuras penuh.';
    }
    if (fam === 'cooling') {
      return 'Periksa kebersihan sistem coolant/radiator & buang kotoran endapan; verifikasi kondisi cairan pendingin.';
    }
    // Tak dikenal: jangan asumsikan ada elemen penyaring.
    return 'Periksa titik masuk kontaminasi & magnetic drain plug kompartemen (bila model unit menyediakan); kuras & ganti oli bila perlu.';
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
                actions: ['Pantau tren Fe antar sampling; bandingkan dengan baseline kompartemen.',
                          'Periksa riwayat ganti oli transmisi & kondisi filter.',
                          'Cek suhu operasi transmisi (panas berlebih mempercepat keausan).'] },
        // TIER 2 — Caution (inspeksi terarah + setel)
        critical: { likely: ['Keausan mulai nyata pada gear/bearing/clutch pack — perlu tindak lanjut terarah'],
                actions: ['Periksa magnet drain plug transmisi (bila model menyediakan) & filter (serpihan halus).',
                          'Cek tekanan & kualitas oli transmisi (viskositas, warna).',
                          'Lakukan transmission performance test ringan (shifting, suara).',
                          'Persingkat interval sampling untuk memantau laju kenaikan.'] },
        // TIER 3 — Critical (deep dive)
        severe: { likely: ['Keausan signifikan gear/bearing/clutch pack internal (disertai Cu/Pb/Cr naik)',
                           'Kontaminasi besi abrasive dari komponen yang aus'],
                actions: ['Inspeksi internal gear train & clutch pack (bila bukti pendukung kuat).',
                          'Potong filter & periksa magnet/magnetic screen transmisi (bila ada) untuk serpihan besar.',
                          'Rencanakan overhaul/inspeksi internal terukur bila tren terus naik.'],
                escalate: 'Batasi beban berat & jadwalkan inspeksi transmisi segera (bila disertai bukti pendukung).' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/bearing kuningan clutch pack / planetary mulai',
                         'Kontaminasi dari oil cooler transmisi atau seal'],
                actions: ['Pantau tren Cu & Pb (bearing/clutch bushing).',
                          'Periksa integritas cooler transmisi & kondisi oli.'] },
        critical: { likely: ['Keausan bushing/bearing Cu-Pb mulai nyata'],
                actions: ['Uji tekanan & periksa kebocoran oil cooler transmisi.',
                          'Cek clearance & kondisi pelumasan yang terjangkau.',
                          'Pantau tren Cu bersama Pb/Sn.'] },
        severe: { likely: ['Keausan signifikan bearing/bushing Cu-Pb (planetary/clutch)',
                           'Kebocoran internal oil cooler transmisi'],
                actions: ['Inspeksi planetary gear, clutch pack, & bearing.',
                          'Evaluasi jadwal overhaul transmisi.'],
                escalate: 'Waspadai clutch/bearing failure — siapkan shutdown terkendali.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing/bushing transmisi mulai',
                         'Kontaminasi Pb dari bantalan berbasis timah'],
                actions: ['Pantau tren Pb & Cu (sering bersamaan).',
                          'Periksa kondisi bearing & bushing transmisi.'] },
        critical: { likely: ['Keausan overlay bearing transmisi mulai nyata'],
                actions: ['Cek clearance & kondisi oli (viskositas, kontaminasi).',
                          'Pantau laju kenaikan Pb.'] },
        severe: { likely: ['Keausan overlay bearing transmisi kritis',
                           'Risiko bearing failure bila terus dioperasikan'],
                actions: ['Inspeksi bearing transmisi & clearance menyeluruh.',
                          'Evaluasi jadwal penggantian bearing.'],
                escalate: 'Overlay Pb habis -> risiko metal-to-metal pada gear train.' }
      },
      wear_al: {
        warn: { likely: ['Keausan ringan komponen aluminium (housing/piston clutch)',
                         'Kontaminasi silika (bila Si tinggi bersamaan)'],
                actions: ['Bandingkan dengan Si & Fe (dirt vs wear).',
                          'Pantau tren Aluminium (Al) antar sampling.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['Periksa jalur breather/intake transmisi (visual).',
                          'Bandingkan Aluminium (Al) dengan Silika (Si).'] },
        severe: { likely: ['Keausan housing/piston clutch berbasis aluminium',
                           'Ingesti debu abrasif (dengan Si tinggi)'],
                actions: ['Periksa piston clutch & housing transmisi.',
                          'Inspeksi menyeluruh jalur breather/intake & perbaiki kebocoran.'],
                escalate: 'Cegah ingesti debu; periksa jalur breather transmisi.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent transmisi', 'Residu sealant silicon'],
                actions: ['Periksa breather/vent transmisi & kebersihan area.',
                          'Bandingkan dengan kadar Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke transmisi'],
                actions: ['Periksa breather, seal, & jalur masuk debu; bersihkan.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif berkelanjutan ke transmisi', 'Kerusakan seal/gasket terkait'],
                actions: ['Perbaiki titik masuk kontaminan menyeluruh.',
                          'Ganti oli & filter transmisi.'],
                escalate: 'Hentikan sumber ingesti debu sebelum keausan gear meluas.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating komponen baja (gear/shaft) mulai',
                         'Kontaminasi (bila Na/B/K naik -> coolant)'],
                actions: ['Pantau tren Cr; cek indikasi kontaminasi.',
                          'Periksa kondisi gear/shaft saat kesempatan.'] },
        critical: { likely: ['Keausan coating gear/shaft mulai nyata'],
                actions: ['Uji kontaminasi coolant (glycol, K, B).',
                          'Periksa cooler/gasket transmisi.'] },
        severe: { likely: ['Keausan lapisan keras gear/shaft signifikan', 'Kebocoran coolant ke oli transmisi'],
                actions: ['Inspeksi gear, shaft, & sistem pendingin transmisi menyeluruh.',
                          'Perbaiki sumber kebocoran coolant.'],
                escalate: 'Segera cek sistem pendingin bila curiga coolant masuk.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah (bushing/bearing Cu-Pb-Sn) mulai',
                         'Sn biasanya naik bersama Cu & Pb pada bearing overlay'],
                actions: ['Pantau tren Sn bersama Cu & Pb — ketiganya dari bearing overlay.',
                          'Periksa bearing/bushing transmisi saat ada akses.'] },
        critical: { likely: ['Keausan overlay bearing transmisi mulai nyata',
                             'Perlu evaluasi clearance & kondisi pelumasan'],
                actions: ['Periksa bearing/bushing & kondisi pelumasan transmisi.',
                          'Persingkat interval sampling; pantau laju kenaikan Sn bersama Cu/Pb.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan di transmisi — overlay menipis'],
                actions: ['Inspeksi bearing transmisi & clearance — ukur vs spesifikasi.',
                          'Cek kontaminasi oli menyeluruh; evaluasi jadwal rebuild.'],
                escalate: 'Bearing overlay transmisi aus — siapkan penggantian segera.' }
      },
      wear_ni: {
        warn: { likely: ['Keausan ringan komponen paduan nikel (gear/shaft alloy transmisi) mulai'],
                actions: ['Pantau tren Ni bersama Cr & Fe (komponen baja paduan).',
                          'Periksa kondisi pelumasan transmisi & suhu operasi.'] },
        critical: { likely: ['Keausan komponen paduan nikel mulai nyata pada gear/shaft transmisi'],
                actions: ['Periksa gear & shaft transmisi untuk tanda pitting/scoring.',
                          'Persingkat interval sampling (100–150 jam).'] },
        severe: { likely: ['Keausan signifikan gear/shaft paduan nikel transmisi internal'],
                actions: ['Inspeksi internal gear & shaft transmisi menyeluruh.',
                          'Evaluasi jadwal perbaikan/penggantian komponen aus.'],
                escalate: 'Keausan paduan nikel tinggi pada transmisi — jadwalkan inspeksi segera.' }
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
                actions: ['Pantau tren Fe antar sampling; bandingkan dengan baseline kompartemen.',
                          'Periksa riwayat ganti oli & kondisi magnetic drain plug.',
                          'Cek suhu operasi (panas berlebih mempercepat keausan).'] },
        critical: { likely: ['Keausan mulai nyata pada roda gigi/bearing — perlu tindak lanjut terarah'],
                actions: ['Periksa magnetic drain plug (bila model menyediakan) untuk serpihan halus.',
                          'Cek kondisi oli (viskositas, warna, kontaminasi).',
                          'Persingkat interval sampling untuk memantau laju kenaikan.'] },
        severe: { likely: ['Keausan signifikan roda gigi/bearing internal', 'Kontaminasi besi abrasive dari komponen yang aus'],
                actions: ['Inspeksi internal gear/bearing (bila bukti pendukung kuat).',
                          'Periksa & bersihkan magnetic drain plug (bila ada) untuk serpihan besar; cek backlash bila memungkinkan.',
                          'Rencanakan inspeksi internal / overhaul terukur bila tren terus naik.'],
                escalate: 'Batasi beban berat & jadwalkan inspeksi kompartemen segera (bila disertai bukti pendukung).' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing bronze / thrust washer kuningan mulai', 'Kontaminasi dari seal kompartemen'],
                actions: ['Pantau tren Cu antar sampling.', 'Periksa kondisi seal & thrust washer terkait.'] },
        critical: { likely: ['Keausan bushing bronze / thrust washer kuningan mulai nyata'],
                actions: ['Cek clearance & kondisi oli (viskositas, kebersihan).',
                          'Periksa sumber kontaminasi (seal/bushing).'] },
        severe: { likely: ['Keausan signifikan bushing bronze atau thrust washer', 'Kontaminasi internal berlanjut'],
                actions: ['Inspeksi bushing, thrust washer, & clearance kompartemen menyeluruh.'],
                escalate: 'Waspadai keausan thrust washer/bushing — siapkan inspeksi terkendali.' }
      },
      wear_pb: {
        warn: { likely: ['Indikasi residu timbal / kontaminasi eksternal (jarang ada komponen Pb pada gearset murni)'],
                actions: ['Pantau tren Pb & verifikasi potensi kontaminasi dispensing oli.', 'Periksa kondisi oli kompartemen.'] },
        critical: { likely: ['Kadar Pb meningkat — evaluasi sumber kontaminasi atau aditif pelumas'],
                actions: ['Cek kebersihan oli & peralatan pengisian.', 'Pantau laju kenaikan Pb.'] },
        severe: { likely: ['Kontaminasi Pb tidak wajar pada kompartemen gearset'],
                actions: ['Kuras & ganti oli; verifikasi sumber pelumas & kebersihan dispensing.'],
                escalate: 'Periksa sumber kontaminasi pelumas segera.' }
      },
      wear_al: {
        warn: { likely: ['Keausan ringan komponen aluminium (housing)',
                         'Kontaminasi silika (bila Si tinggi bersamaan)'],
                actions: ['Bandingkan dengan Si & Fe (dirt vs wear).',
                          'Pantau tren Aluminium (Al) antar sampling.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
                actions: ['Periksa housing & jalur breather kompartemen.',
                          'Bandingkan Aluminium (Al) dengan Silika (Si).'] },
        severe: { likely: ['Keausan housing/aluminium signifikan', 'Ingesti debu abrasif (dengan Si tinggi)'],
                actions: ['Inspeksi housing & perbaiki seluruh jalur masuk kontaminan.'],
                escalate: 'Cegah ingesti debu; periksa jalur masuk kontaminan.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent', 'Residu sealant silicon'],
                actions: ['Periksa breather & kebersihan area.',
                          'Bandingkan dengan Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata'],
                actions: ['Periksa breather, seal, & jalur masuk debu; bersihkan.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif berkelanjutan', 'Kerusakan seal/gasket terkait'],
                actions: ['Perbaiki titik masuk debu; kuras & ganti oli.'],
                escalate: 'Hentikan sumber ingesti debu sebelum keausan gear meluas.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating komponen baja (gear/shaft) mulai',
                         'Cr juga bisa dari kontaminasi coolant bersama Na/K/B'],
                actions: ['Pantau tren Cr bersama Fe (komponen baja).',
                          'Periksa gear/shaft saat kesempatan — cek scoring/pitting.'] },
        critical: { likely: ['Keausan coating gear/shaft mulai nyata',
                             'Kemungkinan kontaminasi coolant (cek Na/B/K)'],
                actions: ['Cek kontaminasi coolant: glycol test, Na/K/B pada sampel.',
                          'Persingkat interval sampling; pantau tren Cr bersama Fe.'] },
        severe: { likely: ['Keausan lapisan keras gear/shaft signifikan',
                           'Kontaminasi coolant ke oli (bila Na/B/K naik)'],
                actions: ['Inspeksi gear & shaft kompartemen — cek scoring/spalling.',
                          'Uji kontaminasi & perbaiki sumber kebocoran.'],
                escalate: 'Keausan lapisan keras gear — jadwalkan inspeksi internal.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah (bearing overlay Cu-Pb-Sn) mulai'],
                actions: ['Pantau tren Sn bersama Cu & Pb — ketiganya dari bearing overlay.',
                          'Cek kondisi oli (pelumasan memadai memperlambat keausan).'] },
        critical: { likely: ['Keausan overlay bearing Sn mulai nyata',
                             'Biasanya disertai Cu & Pb naik bersamaan'],
                actions: ['Periksa bearing terkait & evaluasi clearance.',
                          'Persingkat interval sampling; pantau laju kenaikan bersama Cu/Pb.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan — overlay hampir habis'],
                actions: ['Inspeksi bearing menyeluruh & clearance.',
                          'Evaluasi jadwal penggantian bearing berdasarkan bukti Cu/Pb/Sn.'],
                escalate: 'Bearing overlay habis — siapkan penggantian segera.' }
      },
      wear_ni: {
        warn: { likely: ['Keausan paduan nikel pada roda gigi / shaft mulai'],
                actions: ['Pantau tren Ni bersama Cr & Fe (komponen baja paduan).',
                          'Periksa kondisi pelumasan & suhu operasi gearset.'] },
        critical: { likely: ['Keausan komponen paduan nikel mulai nyata pada gear/shaft'],
                actions: ['Periksa gear & shaft kompartemen untuk tanda pitting/scoring.',
                          'Persingkat interval sampling (100–150 jam).'] },
        severe: { likely: ['Keausan signifikan gear/shaft paduan nikel internal'],
                actions: ['Inspeksi internal gear & shaft kompartemen menyeluruh.',
                          'Evaluasi jadwal perbaikan/penggantian komponen aus.'],
                escalate: 'Keausan paduan nikel tinggi — jadwalkan inspeksi internal segera.' }
      }
    },

    /* ---------- HYDRAULIC: sistem hidrolik / steering ---------- */
    hydraulic: {
      wear_fe: {
        warn: { likely: ['Keausan normal pompa/motor/cylinder hidrolik mulai',
                         'Kontaminasi besi dari komponen bergerak hidrolik'],
                actions: ['Pantau tren Fe; cek level kebersihan oli hidrolik (ISO).',
                          'Periksa kondisi filter hidrolik.',
                          'Cek suhu operasi (panas berlebih mempercepat keausan).'] },
        critical: { likely: ['Keausan mulai nyata pada pompa/motor/cylinder hidrolik'],
                actions: ['Cek kebersihan sistem (ISO 4406) & sumber kontaminasi.',
                          'Periksa filter hidrolik (serpihan halus).',
                          'Cek suara/Getaran pompa & performa siklus (ringan).'] },
        severe: { likely: ['Keausan signifikan pompa/motor/cylinder hidrolik', 'Kontaminasi besi abrasive (partikel besar)'],
                actions: ['Inspeksi pompa & motor hidrolik (efisiensi/flow test).',
                          'Potong filter hidrolik, periksa serpihan besar.'],
                escalate: 'Batasi operasi berat; risiko keausan lanjut pompa & valve.' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bushing/pompa hidrolik (Cu) mulai', 'Kontaminasi dari cooler hidrolik/seal'],
                actions: ['Pantau tren Cu & kebersihan oli hidrolik.', 'Periksa cooler & kondisi seal hidrolik.'] },
        critical: { likely: ['Keausan bushing/pompa hidrolik mulai nyata'],
                actions: ['Cek kebocoran cooler (visual) & kondisi seal.',
                          'Pantau tren Cu bersama Pb.'] },
        severe: { likely: ['Keausan signifikan bushing/pompa hidrolik', 'Kebocoran internal cooler hidrolik'],
                actions: ['Uji pompa (flow/pressure) & inspeksi bushing/piston/cylinder.',
                          'Ganti oli & filter bila kontaminasi tinggi.'],
                escalate: 'Waspadai penurunan efisiensi hidrolik — siapkan inspeksi.' }
      },
      wear_pb: {
        warn: { likely: ['Keausan overlay bearing hidrolik mulai — Pb bersama Cu dari bearing Cu-Pb'],
                actions: ['Pantau tren Pb bersama Cu & Sn — ketiganya dari bearing overlay.',
                          'Periksa bearing/bushing pompa & motor hidrolik saat ada akses.'] },
        critical: { likely: ['Keausan bearing pompa/motor hidrolik mulai nyata'],
                actions: ['Cek clearance bearing pompa & kondisi oli (viskositas).',
                          'Persingkat interval sampling; pantau laju kenaikan Pb bersama Cu.'] },
        severe: { likely: ['Keausan bearing pompa/motor hidrolik signifikan — overlay Pb menipis'],
                actions: ['Inspeksi bearing pompa/motor hidrolik — evaluasi clearance vs spesifikasi.',
                          'Uji efisiensi pompa (flow test) untuk konfirmasi dampak keausan.'],
                escalate: 'Risiko bearing failure pompa/motor hidrolik — jadwalkan inspeksi.' }
      },
      wear_al: {
        warn: { likely: ['Keausan komponen aluminium hidrolik (housing, piston, swash plate) mulai',
                         'Kontaminasi silika bersama Si (debu via breather tangki)'],
                actions: ['Bandingkan Al dengan Si & Fe — ketiganya naik = debu masuk via breather.',
                          'Pantau tren Aluminium (Al) antar sampling.'] },
        critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata',
                             'Breather tangki hidrolik kotor atau tidak efektif'],
                actions: ['Periksa & ganti breather tangki hidrolik.',
                          'Cek filter hidrolik (potong/periksa kontaminan).',
                          'Hitung Dirt Entry Index (Si + Al) & pantau tren.'] },
        severe: { likely: ['Keausan housing/piston/swash plate aluminium hidrolik signifikan',
                           'Ingesti debu abrasif berkelanjutan (Si + Al tinggi)'],
                actions: ['Inspeksi housing & piston pompa hidrolik.',
                          'Perbaiki sumber debu (breather, seal, filler cap) secara menyeluruh.',
                          'Kuras & ganti oli; ganti filter hidrolik.'],
                escalate: 'Ingesti debu ke hidrolik — perbaiki sumber & periksa pompa segera.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent hidrolik',
                         'Residu sealant silicon'],
                actions: ['Periksa breather tangki & kebersihan area.',
                          'Bandingkan dengan Aluminium (Al).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke sistem hidrolik'],
                actions: ['Periksa breather, seal, & filtrasi hidrolik.',
                          'Pantau Dirt Entry Index (Si + Al).'] },
        severe: { likely: ['Ingesti debu abrasif ke sistem hidrolik', 'Kerusakan seal/filter'],
                actions: ['Perbaiki titik masuk debu; ganti oli & filter.'],
                escalate: 'Kebersihan hidrolik kritis — risiko keausan valve/pompa.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating rod/shaft hidrolik (hard chrome plating) mulai',
                         'Cr juga bisa indikasi kontaminasi coolant bersama Na/K/B'],
                actions: ['Pantau tren Cr bersama Fe (komponen baja).',
                          'Periksa rod/shaft saat kesempatan — cek scoring/scratch.'] },
        critical: { likely: ['Keausan coating rod/shaft hidrolik mulai nyata',
                             'Kemungkinan kontaminasi coolant (cek bersama Na/K/B)'],
                actions: ['Cek kontaminasi: glycol test, Na/K/B pada sampel yang sama.',
                          'Periksa rod hidrolik untuk scoring/scratch — rod aus menyebabkan seal bocor.',
                          'Persingkat interval sampling; pantau tren Cr.'] },
        severe: { likely: ['Keausan lapisan keras rod/shaft signifikan — seal bocor/rusak',
                           'Kontaminasi coolant ke oli hidrolik (bila Na/B/K juga naik)'],
                actions: ['Periksa rod/shaft & seal hidrolik menyeluruh — ganti rod bila scoring parah.',
                          'Uji kontaminasi coolant & perbaiki sumber kebocoran.',
                          'Kuras & ganti oli; periksa filter untuk serpihan chrome.'],
                escalate: 'Rod hidrolik aus merusak seal — risiko kebocoran eksternal; periksa segera.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah (bearing overlay Cu-Pb-Sn) pada pompa/motor'],
                actions: ['Pantau tren Sn bersama Cu & Pb — ketiganya dari bearing overlay.',
                          'Cek kondisi oli (viskositas) — pelumasan buruk mempercepat Sn naik.'] },
        critical: { likely: ['Keausan overlay bearing pompa/motor hidrolik mulai nyata',
                             'Biasanya disertai Cu & Pb naik bersamaan'],
                actions: ['Periksa bearing/bushing pompa hidrolik.',
                          'Persingkat interval sampling; pantau laju kenaikan bersama Cu/Pb.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn pompa/motor signifikan — overlay hampir habis'],
                actions: ['Inspeksi bearing/bushing pompa & motor hidrolik menyeluruh.',
                          'Uji efisiensi pompa (flow test) — bearing aus menurunkan efisiensi.',
                          'Evaluasi jadwal rebuild pompa/motor.'],
                escalate: 'Bearing pompa hidrolik aus — risiko penurunan performa & kebocoran internal.' }
      },
      wear_ni: {
        warn: { likely: ['Keausan paduan nikel pada shaft pompa/motor atau valve spool hidrolik mulai'],
                actions: ['Pantau tren Ni bersama Cr & Fe.',
                          'Periksa kebersihan oli (ISO 4406) & filter hidrolik.'] },
        critical: { likely: ['Keausan komponen paduan nikel mulai nyata pada pompa/valve hidrolik'],
                actions: ['Periksa valve spool & shaft pompa hidrolik terhadap scoring.',
                          'Persingkat interval sampling (100–150 jam).'] },
        severe: { likely: ['Keausan signifikan shaft pompa/valve spool paduan nikel hidrolik'],
                actions: ['Inspeksi pompa & valve block hidrolik menyeluruh.',
                          'Evaluasi jadwal perbaikan/rebuild pompa/valve.'],
                escalate: 'Keausan paduan nikel hidrolik tinggi — risiko sticking valve & efisiensi drop.' }
      }
    },

    /* ---------- AXLE: final drive / differential / swing drive ---------- */
    axle: {
      wear_fe: {
        warn: { likely: ['Keausan normal gearset/bearing mulai — Fe indikator utama keausan pada kompartemen axle',
                         'Kontaminasi besi dari gear tooth & bearing race'],
                actions: ['Pantau tren Fe antar sampling; cek magnet drain plug (bila model menyediakan) untuk serpihan.',
                          'Periksa kondisi oli & interval ganti — oli lama mempercepat keausan.',
                          'Cek suhu operasi kompartemen — overheat meningkatkan laju keausan.'] },
        critical: { likely: ['Keausan gear/bearing mulai nyata — perlu inspeksi terarah',
                             'Kontaminasi besi meningkat, indikasi keausan progresif'],
                actions: ['Periksa magnetic drain plug (bila model menyediakan) — evaluasi ukuran & jumlah serpihan.',
                          'Cek kondisi oli (viskositas, warna, bau terbakar) — degradasi oli mempercepat keausan.',
                          'Persingkat interval sampling (100–150 jam) untuk pantau laju kenaikan Fe.',
                          'Cek Si & Al bersamaan — bila naik, curiga ingesti debu via breather.'] },
        severe: { likely: ['Keausan signifikan gear/bearing — laju Fe akseleratif',
                           'Kontaminasi besi abrasif berat (potensi fatigue crack pada gear)'],
                actions: ['Inspeksi internal gear/bearing: cek pitting, spalling, scoring pada gear tooth & bearing race.',
                          'Periksa & bersihkan magnetic drain plug/screen (serpihan besar = konfirmasi keausan).',
                          'Cek backlash & preload bearing bila memungkinkan — bandingkan dgn spesifikasi manual.',
                          'Pertimbangkan kidney loop filtration (portable filtering) untuk membersihkan kontaminan tanpa harus kuras penuh.',
                          'Rencanakan inspeksi internal/overhaul berdasarkan tren & bukti fisik.'],
                escalate: 'Keausan gear/bearing akseleratif — batasi beban berat; jadwalkan inspeksi internal segera.' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bronze thrust washer / bushing kuningan / pinion washer mulai',
                         'Kontaminasi gesekan dari wear plate / thrust ring kompartemen'],
                actions: ['Pantau tren Cu antar sampling.',
                          'Periksa magnetic drain plug untuk partikel non-ferrous.',
                          'Periksa kondisi oli & suhu operasi kompartemen.'] },
        critical: { likely: ['Keausan bronze thrust washer / bushing kuningan mulai nyata',
                             'Indikasi gesekan berlebih pada thrust face roda gigi / pinion differential'],
                actions: ['Periksa kondisi oli (viskositas & bau) — pelumasan buruk mempercepat keausan thrust washer.',
                          'Cek magnetic plug & drain plug untuk serpihan kuningan/bronze.',
                          'Persingkat interval sampling (100–150 jam).'] },
        severe: { likely: ['Keausan signifikan bronze thrust washer / pinion washer axle/differential',
                           'Risiko pergeseran alignment roda gigi akibat ausnya thrust washer'],
                actions: ['Inspeksi internal thrust washer, pinion washer, & clearance roda gigi.',
                          'Cek backlash & end-play gear train.',
                          'Evaluasi jadwal perbaikan/penggantian thrust washer sebelum merusak roda gigi.'],
                escalate: 'Thrust washer/bushing bronze aus berat — siapkan pembongkaran & inspeksi internal segera.' }
      },
      wear_pb: {
        warn: { likely: ['Kadar Pb terdeteksi — kompartemen axle/gearbox umumnya tidak memakai bearing Pb (curiga kontaminasi oli/grease)'],
                actions: ['Pantau tren Pb & verifikasi kebersihan alat pengisian / kontaminasi silang oli.',
                          'Cek riwayat penggantian pelumas.'] },
        critical: { likely: ['Kenaikan Pb tidak biasa pada kompartemen axle/differential',
                             'Kemungkinan kontaminasi silang atau residu aditif EP lama'],
                actions: ['Verifikasi sumber oli & peralatan dispensing.',
                          'Cek kondisi oli kompartemen & persingkat interval sampling.'] },
        severe: { likely: ['Kontaminasi Pb tinggi tidak normal pada kompartemen axle/differential'],
                actions: ['Kuras & ganti oli kompartemen.',
                          'Periksa sumber kontaminasi pelumas & pastikan memakai oli gear yang tepat.'],
                escalate: 'Kontaminasi abnormal pada kompartemen axle — lakukan kuras & ganti oli segera.' }
      },
      wear_al: {
        warn: { likely: ['Keausan komponen aluminium (housing/cap) mulai', 'Awal ingesti debu (bersama Si)'],
                actions: ['Bandingkan Al dengan Si & Fe — ketiganya naik bersamaan = indikasi debu masuk.',
                          'Periksa breather/vent kompartemen — pastikan tidak tersumbat atau bocor.'] },
        critical: { likely: ['Ingesti debu/keausan aluminium mulai nyata',
                             'Hitung Dirt Entry Index (Si + Al) & bandingkan dengan baseline'],
                actions: ['Periksa & bersihkan breather/vent kompartemen.',
                          'Cek seal & gasket kompartemen — perbaiki bila bocor.',
                          'Pantau Dirt Entry Index antar sampling.'] },
        severe: { likely: ['Keausan housing aluminium signifikan atau ingesti debu abrasif berkelanjutan'],
                actions: ['Perbaiki seluruh titik masuk debu (breather, seal, gasket) secara menyeluruh.',
                          'Kuras & ganti oli; bersihkan magnetic drain plug (bila ada).',
                          'Periksa permukaan gear & bearing untuk scoring akibat abrasif.'],
                escalate: 'Cegah ingesti debu — periksa & perbaiki breather/seal kompartemen segera.' }
      },
      wear_si: {
        warn: { likely: ['Kontaminasi debu via breather/vent kompartemen', 'Residu sealant silicon (RTV)'],
                actions: ['Periksa breather/vent & kebersihan kompartemen.',
                          'Bandingkan dengan Al — keduanya naik = kuat indikasi debu.',
                          'Cek apakah ada perbaikan baru yang menggunakan RTV (sumber Si sementara).'] },
        critical: { likely: ['Ingesti debu mulai nyata ke kompartemen — Dirt Entry meningkat',
                             'Breather/seal bocor atau tidak terpasang dengan benar'],
                actions: ['Periksa breather, seal, & seluruh jalur masuk debu; perbaiki/ganti.',
                          'Hitung Dirt Entry Index (Si + Al) & pantau tren antar sampling.',
                          'Pertimbangkan kuras & ganti oli bila kontaminasi signifikan.'] },
        severe: { likely: ['Ingesti debu abrasif ke kompartemen — keausan gear/bearing dipercepat',
                           'Kerusakan seal/gasket kompartemen'],
                actions: ['Perbaiki seluruh titik masuk debu; ganti seal/gasket yang rusak.',
                          'Kuras & ganti oli (bersihkan magnetic drain plug bila ada).',
                          'Periksa gear & bearing untuk scoring/pitting akibat abrasif.'],
                escalate: 'Hentikan ingesti debu sebelum keausan gear meluas — periksa breather/seal segera.' }
      },
      wear_cr: {
        warn: { likely: ['Keausan coating keras (hardened) pada gear/shaft mulai',
                         'Cr juga bisa dari seal/O-ring metalik'],
                actions: ['Pantau tren Cr bersama Fe (keduanya dari komponen baja).',
                          'Cek apakah ada indikasi kontaminasi coolant (Na/K/B) yang memicu korosi.'] },
        critical: { likely: ['Keausan lapisan keras gear/shaft mulai nyata',
                             'Kemungkinan korosi bila disertai Na/K/B naik'],
                actions: ['Cek kontaminasi coolant (glycol test) bila Na/K juga naik.',
                          'Pantau bersama Fe & Ni untuk lokalisasi sumber.',
                          'Persingkat interval sampling.'] },
        severe: { likely: ['Keausan signifikan lapisan keras gear/shaft',
                           'Korosi aktif dari kontaminan (coolant/air)'],
                actions: ['Inspeksi gear & shaft kompartemen — cek pitting/scoring pada permukaan keras.',
                          'Uji kontaminasi (coolant, air) & perbaiki sumber.',
                          'Evaluasi kebutuhan repair/replace komponen yang aus.'],
                escalate: 'Keausan lapisan keras gear — jadwalkan inspeksi internal.' }
      },
      wear_sn: {
        warn: { likely: ['Keausan komponen berbasis timah (bearing overlay Cu-Pb-Sn) mulai'],
                actions: ['Pantau tren Sn bersama Cu & Pb — ketiganya dari bearing overlay.',
                          'Cek kondisi oli (pelumasan memadai memperlambat keausan).'] },
        critical: { likely: ['Keausan overlay bearing Sn mulai nyata',
                             'Biasanya disertai kenaikan Cu & Pb'],
                actions: ['Periksa bearing terkait & evaluasi clearance.',
                          'Persingkat interval sampling; pantau laju kenaikan bersama Cu/Pb.'] },
        severe: { likely: ['Keausan bearing Cu-Pb-Sn signifikan — overlay hampir habis'],
                actions: ['Inspeksi bearing menyeluruh; ukur clearance vs spesifikasi.',
                          'Evaluasi jadwal penggantian bearing berdasarkan bukti Cu/Pb/Sn.'],
                escalate: 'Bearing overlay habis — siapkan penggantian segera.' }
      },
      wear_ni: {
        warn: { likely: ['Keausan paduan nikel pada roda gigi planetary/pinion/shaft axle mulai'],
                actions: ['Pantau tren Ni bersama Cr & Fe (komponen baja paduan keras).',
                          'Periksa kondisi pelumasan & suhu operasi axle.'] },
        critical: { likely: ['Keausan komponen paduan nikel mulai nyata pada gear/shaft axle'],
                actions: ['Periksa gear & shaft kompartemen untuk tanda pitting/spalling.',
                          'Persingkat interval sampling (100–150 jam).'] },
        severe: { likely: ['Keausan signifikan gear/shaft/bearing race paduan nikel axle'],
                actions: ['Inspeksi internal gear & shaft kompartemen axle menyeluruh.',
                          'Evaluasi jadwal perbaikan/penggantian komponen aus.'],
                escalate: 'Keausan paduan nikel tinggi pada axle — jadwalkan inspeksi internal segera.' }
      }
    },

    /* ---------- COOLING: radiator / sistem pendingin ---------- */
    cooling: {
      wear_fe: {
        warn: { likely: ['Keausan ringan komponen pompa/water pump mulai',
                         'Korosi logam sistem pendingin'],
                actions: ['Pantau tren Fe; cek kondisi & pH coolant.',
                          'Periksa water pump & sirkulasi.'] },
        critical: { likely: ['Keausan/korosi mulai nyata pada sistem pendingin'],
                actions: ['Cek inhibitor & pH coolant; periksa pompa (visual).',
                          'Pantau suhu operasi & tren Fe.'] },
        severe: { likely: ['Keausan signifikan komponen pompa pendingin', 'Korosi internal sistem cooling'],
                actions: ['Inspeksi water pump, bearing, & seal; flush & ganti coolant.',
                          'Periksa radiator & blok terhadap korosi.'],
                escalate: 'Risiko overheating — perbaiki sistem pendingin segera.' }
      },
      wear_cu: {
        warn: { likely: ['Keausan bearing water pump / keluruhan Cu dari radiator'],
                actions: ['Pantau tren Cu.', 'Periksa water pump & radiator core.'] },
        critical: { likely: ['Keausan bearing pompa / korosi radiator mulai nyata'],
                actions: ['Cek kondisi coolant & inhibitor; periksa sirkulasi.'] },
        severe: { likely: ['Keausan bearing pompa / korosi radiator (Cu)'],
                actions: ['Inspeksi water pump & radiator; ganti komponen yang aus.'],
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
                        'Periksa riwayat ganti oli & kebersihan kompartemen.'] },
      critical: { likely: ['Keausan mulai nyata pada komponen internal berbasis besi'],
              actions: ['Periksa magnetic drain plug (bila ada) & drain plug kompartemen untuk partikel logam (serpihan halus).',
                        'Cek kondisi oli & sumber kontaminasi.',
                        'Persingkat interval sampling.'] },
      severe: { likely: ['Keausan signifikan komponen internal berbasis besi',
                         'Kontaminasi besi abrasive'],
              actions: ['Inspeksi internal komponen bergerak (bila bukti pendukung kuat).',
                        'Periksa & bersihkan drain plug/magnetic plug kompartemen (bila ada) untuk serpihan besar.',
                        'Rencanakan inspeksi internal.' ],
              escalate: 'Batasi operasi berat; jadwalkan inspeksi segera.' }
    },
    wear_cu: {
      warn: { likely: ['Keausan bushing bronze / thrust washer kuningan mulai'],
              actions: ['Pantau tren Cu.', 'Periksa kondisi oli & drain plug kompartemen.'] },
      critical: { likely: ['Keausan bushing bronze / komponen tembaga/kuningan mulai nyata'],
              actions: ['Cek cooler/seal bila ada.', 'Cek kondisi oli kompartemen.'] },
      severe: { likely: ['Keausan signifikan bushing bronze / komponen tembaga/kuningan',
                         'Kontaminasi internal kompartemen'],
              actions: ['Inspeksi bushing/thrust washer terkait menyeluruh.'],
              escalate: 'Waspadai keausan bushing/komponen bronze — siapkan inspeksi terkendali.' }
    },
    wear_al: {
      warn: { likely: ['Keausan ringan komponen aluminium',
                       'Kontaminasi silika (bila Si tinggi)'],
              actions: ['Bandingkan dengan Si & Fe.', 'Pantau tren Aluminium (Al).'] },
      critical: { likely: ['Kontaminasi debu/keausan aluminium mulai nyata'],
              actions: ['Periksa jalur intake/breather; bersihkan.'] },
      severe: { likely: ['Keausan komponen aluminium signifikan',
                         'Ingesti debu abrasif (dengan Si tinggi)'],
              actions: ['Perbaiki seluruh jalur masuk kontaminan.'],
              escalate: 'Cegah ingesti debu; periksa jalur masuk kontaminan.' }
    },
    wear_pb: {
      warn: { likely: ['Kadar timbal (Pb) terdeteksi pada kompartemen'],
              actions: ['Pantau tren Pb & verifikasi potensi kontaminasi pelumas.'] },
      critical: { likely: ['Peningkatan kadar timbal (Pb) pada kompartemen'],
              actions: ['Cek kebersihan pelumas & sumber kontaminasi.'] },
      severe: { likely: ['Kadar timbal (Pb) tinggi abnormal pada kompartemen'],
              actions: ['Kuras & ganti oli; verifikasi sumber pelumas.'],
              escalate: 'Periksa sumber kontaminasi pelumas kompartemen segera.' }
    },
    wear_cr: {
      warn: { likely: ['Keausan coating komponen baja mulai'],
              actions: ['Pantau tren Cr.'] },
      critical: { likely: ['Keausan coating komponen baja mulai nyata'],
              actions: ['Cek kontaminasi coolant bila relevan (Na/B/K).'] },
      severe: { likely: ['Keausan lapisan keras signifikan',
                         'Kontaminasi coolant (bila Na/B/K naik)'],
              actions: ['Inspeksi komponen baja terkait.'],
              escalate: 'Segera cek sumber keausan/kontaminasi.' }
    },
    wear_si: {
      warn: { likely: ['Kontaminasi debu (via breather/intake)',
                       'Residu sealant silicon'],
              actions: ['Periksa breather/vent & kebersihan area.', 'Bandingkan dengan Aluminium (Al).'] },
      critical: { likely: ['Ingesti debu mulai nyata'],
              actions: ['Periksa jalur masuk debu & seal; bersihkan.'] },
      severe: { likely: ['Ingesti debu abrasif berkelanjutan',
                         'Kerusakan seal/gasket terkait'],
              actions: ['Perbaiki titik masuk debu menyeluruh; kuras & ganti oli.'],
              escalate: 'Hentikan sumber ingesti debu sebelum keausan meluas.' }
    },
    wear_sn: {
      warn: { likely: ['Keausan komponen berbasis timah (bearing/bushing) mulai'],
              actions: ['Pantau tren Sn bersama Cu & Pb.', 'Cek kondisi oli kompartemen.'] },
      critical: { likely: ['Keausan komponen berbasis timah mulai nyata'],
              actions: ['Cek clearance bearing & kondisi pelumasan.', 'Persingkat interval sampling.'] },
      severe: { likely: ['Keausan signifikan bearing/bushing berbasis timah'],
              actions: ['Inspeksi bearing & clearance kompartemen menyeluruh.'],
              escalate: 'Bearing overlay aus — siapkan penggantian segera.' }
    },
    wear_ni: {
      warn: { likely: ['Keausan komponen paduan nikel mulai meningkat'],
              actions: ['Pantau tren Ni bersama Fe.', 'Periksa kondisi oli kompartemen.'] },
      critical: { likely: ['Keausan komponen paduan nikel mulai nyata'],
              actions: ['Cek kondisi komponen internal & drain plug.', 'Persingkat interval sampling.'] },
      severe: { likely: ['Keausan signifikan komponen paduan nikel'],
              actions: ['Inspeksi internal kompartemen (bila bukti pendukung kuat).'],
              escalate: 'Segera cek sumber keausan paduan nikel.' }
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
    wear_fe: ['Shop Manual — Engine: Piston Ring / Cylinder Liner Wear',
              'Technical Bulletin — Blowby & Compression Diagnostics'],
    wear_cu: ['Shop Manual — Bearing (Cu-Pb) & Oil Cooler',
              'SOP inspeksi bearing utama / connecting rod'],
    wear_al: ['Shop Manual — Piston & Bearing Shell (Aluminium)',
              'SOP inspeksi sistem intake & pembersihan'],
    wear_cr: ['Shop Manual — Piston Ring (Chrome-plated) & Liner',
              'SOP uji kontaminasi coolant (glycol test)'],
    wear_pb: ['Shop Manual — Bearing Overlay (Pb) / Babbitt',
              'SOP evaluasi clearance & jadwal ganti bearing'],
    wear_si: ['Shop Manual — Air Cleaner & Intake System',
              'SOP Dirt Entry Index (Si + Aluminium)'],
    wear_sn: ['Shop Manual — Bearing (Cu-Pb-Sn)',
              'SOP inspeksi bearing & kondisi pelumasan'],
    wear_ni: ['Shop Manual — Valve Train & Turbocharger',
              'SOP inspeksi end-play turbo & top-end overhaul'],
    /* OIL CONDITION */
    visc_v100: ['Shop Manual — Lubrication: Spesifikasi Viskositas',
                'SOP analisis degradasi oli (fuel dilution / soot / oksidasi)'],
    visc_v40: ['Shop Manual — Lubrication: Spesifikasi Viskositas'],
    tbn: ['Shop Manual — Lubrication: TBN & Interval Ganti Oli',
          'SOP verifikasi kualitas bahan bakar (sulfur)'],
    water_pct: ['Shop Manual — Cooling System: Coolant Leak Test',
                'SOP pressure test sistem pendingin'],
    fuel_pct: ['Shop Manual — Fuel System: Injector Test',
               'SOP uji injektor & kebocoran bahan bakar'],
    soot: ['Shop Manual — Engine: Combustion & Intake',
           'SOP pemeriksaan filter udara & pembakaran'],
    oxidation: ['Shop Manual — Lubrication: Oil Oxidation',
                'SOP evaluasi suhu operasi & interval ganti oli'],
    nitration: ['Shop Manual — Engine: Combustion / EGR',
                'SOP analisis degradasi oli'],
    sulfation: ['Shop Manual — Fuel Quality & Lubrication',
                'SOP verifikasi bahan bakar (sulfur) & pemantauan TBN'],
    /* CLEANLINESS */
    pqi: ['Shop Manual — Lubrication: Filtration & Cleanliness',
          'ISO 4406 — Target kebersihan oli'],
    pc_4u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP filtrasi oli'],
    pc_6u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP filtrasi oli'],
    pc_14u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP inspeksi sumber keausan'],
    pc_21u: ['ISO 4406 — Kode Kebersihan Partikel', 'SOP inspeksi komponen bergerak'],
    /* ADDITIVES */
    additive_p: ['Shop Manual — Lubrication: Additive (ZDDP)'],
    additive_zn: ['Shop Manual — Lubrication: Additive (ZDDP)'],
    additive_ca: ['Shop Manual — Lubrication: Detergent Additive'],
    additive_mg: ['Shop Manual — Lubrication: Detergent Additive'],
    additive_mo: ['Shop Manual — Lubrication: Friction Modifier'],
    additive_b: ['Shop Manual — Cooling System: Coolant Infiltration'],
    additive_na: ['Shop Manual — Cooling System: Coolant Leak Test',
                  'SOP uji glycol & pressure test sistem pendingin',
                  'SOP analisis Sodium/Kalium sebagai penanda kebocoran coolant'],
    additive_ba: ['Shop Manual — Lubrication: Detergent Additive']
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
    engine:    ['Shop Manual — ENGINE (Piston/Liner/Valve Train/Turbo)'],
    gearbox:   ['Shop Manual — POWER TRAIN (Transmission / Torque Converter / Clutch)'],
    gear:      ['Shop Manual — POWER TRAIN (Gears / Reducer / Transfer)'],
    hydraulic: ['Shop Manual — HYDRAULIC & STEERING SYSTEM'],
    axle:      ['Shop Manual — POWER TRAIN (Final Drive / Differential / Axle)'],
    cooling:   ['Shop Manual — COOLING SYSTEM (Radiator / Water Pump)']
  };

  /* -----------------------------------------------------------------------
   * [RUJUKAN SADAR-MODEL 2026-10-01] Rujukan manual TIDAK boleh selalu
   * "Komatsu" — armada bisa berisi merek lain. `brandManualName(model)`
   * mendeteksi merek dari string model (mis. "D375A6R_KOMATSU", "CAT 777",
   * "HD785-7") dan mengembalikan nama manual yang TEPAT. Bila merek tak
   * dikenali, dipakai istilah netral "Shop Manual Unit" (TANPA mengarang).
   * --------------------------------------------------------------------- */
  var BRAND_MAP = [
    { re: /komatsu|\bD\d{2,3}[A-Z]*\b|\bHD\d|\bPC\d|\bWA\d|\bGD\d|\bHM\d/i, name: 'Komatsu Shop Manual' },
    { re: /caterpillar|\bCAT\b|\b\d{3}[A-Z]\b/i,                            name: 'Caterpillar (CAT) Service Manual' },
    { re: /hitachi|zaxis|\bEX\d|\bZX\d|\bEH\d/i,                           name: 'Hitachi Service Manual' },
    { re: /volvo|\bL\d{2,3}[A-Z]*\b/i,                                      name: 'Volvo CE Service Manual' },
    { re: /kobelco|\bSK\d|\bSK\d{2,3}\b/i,                                  name: 'Kobelco Service Manual' },
    { re: /doosan|\bDX\d/i,                                                 name: 'Doosan Service Manual' },
    { re: /sany|\bSY\d/i,                                                   name: 'SANY Service Manual' },
    { re: /liebherr|\bR\d{4}\b/i,                                           name: 'Liebherr Service Manual' },
    { re: /scania|man\b|mercedes|deutz|cummins|perkins|mtu/i,               name: 'Manufacturer Engine Service Manual' }
  ];

  /**
   * Nama manual yang TEPAT berdasar model unit (sadar-merek).
   * @param {string} [model] string model unit (mis. "D375A6R_KOMATSU")
   * @returns {string} mis. "Komatsu Shop Manual" / "Shop Manual Unit"
   */
  function brandManualName(model) {
    var m = String(model || '').trim();
    if (!m) return 'Shop Manual Unit';
    for (var i = 0; i < BRAND_MAP.length; i++) {
      if (BRAND_MAP[i].re.test(m)) return BRAND_MAP[i].name;
    }
    // Merek tak dikenali: JANGAN mengarang merek — pakai istilah netral.
    return 'Shop Manual Unit';
  }

  /**
   * Terapkan nama manual sadar-merek pada sebuah frasa rujukan.
   * Menangani bentuk referensi baku:
   *   "Shop Manual — X"      -> "<brand> — X"
   *   "Technical Bulletin — X" -> "<brandBulletin> — X"
   *   "Shop Manual — X"              -> "<brand> — X"
   * Bila brand netral ("Shop Manual Unit"), dihasilkan "Shop Manual Unit — X".
   */
  function applyBrandToRef(ref, brand) {
    if (!ref) return ref;
    var s = String(ref);
    var neutral = (brand === 'Shop Manual Unit');
    // Bulletin teknis (nama merek tanpa kata "Shop Manual"/"Service Manual").
    var bulletinBrand = neutral ? 'Shop Manual Unit'
      : brand.replace(/\s*(Shop Manual|Service Manual)$/, '') + ' Technical Bulletin';
    // Pakai placeholder agar substitusi TIDAK saling menimpa (mis. "Shop Manual"
    // di dalam "Shop Manual Unit" jangan di-replace dua kali).
    var PH = '\u0001';
    s = s.replace(/Komatsu Technical Bulletin/g, PH);
    s = s.replace(/(^|\s)Technical Bulletin(?![A-Za-z])/g, function (mt, pre) { return pre + PH; });
    s = s.replace(/Komatsu Shop Manual/g, brand);
    s = s.replace(/(^|\s)Shop Manual(?![A-Za-z])/g, function (mt, pre) { return pre + brand; });
    // Kembalikan placeholder menjadi nama bulletin merek.
    s = s.split(PH).join(bulletinBrand);
    return s;
  }


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
      wear_cu: 'Clutch pack disc (sintered bronze), bushing planetary, & cooler transmisi',
      wear_al: 'Housing & piston clutch (aluminium) berisiko aus',
      wear_cr: 'Gear & shaft (lapisan keras) berisiko terkikis',
      wear_pb: 'Bushing transmisi / residu kontaminasi Pb',
      wear_si: 'Gear, bearing, & spline (keausan abrasif debu)',
      wear_sn: 'Bearing planetary & clutch bushing',
      wear_ni: 'Gear & shaft paduan nikel transmisi berisiko aus',
      visc_v100: 'Viskositas menyimpang → clutch pack & gear set berisiko slip/aus',
      visc_v40: 'Viskositas @40°C menyimpang → pelumasan transmisi & respon clutch terganggu',
      tbn: 'Oli kehilangan daya netralisasi → korosi bearing & komponen transmisi',
      water_pct: 'Air → korosi bearing & clutch plate, kehilangan cengkeraman',
      fuel_pct: 'Kontaminan fluida cair pengencer oli transmisi',
      soot: 'Deposit kontaminan → sirkulasi & clutch valve terganggu',
      oxidation: 'Varnish/sludge → valve body transmisi macet & clutch slip',
      nitration: 'Degradasi termal oli transmisi',
      sulfation: 'Kontaminasi asam & degradasi pelumas transmisi',
      pqi: 'Partikel → keausan valve body, clutch pack, & bearing transmisi',
      additive_na: 'Kebocoran coolant → korosi bearing & clutch transmisi'
    },
    /* ---------------- GEAR (PTO/transfer/reducer) ---------------- */
    gear: {
      wear_fe: 'Roda gigi, shaft, & bearing kompartemen berisiko aus',
      wear_cu: 'Bronze thrust washer, shaft bushing kuningan, & seal',
      wear_al: 'Housing aluminium berisiko aus',
      wear_cr: 'Gear & shaft (lapisan keras) berisiko terkikis',
      wear_pb: 'Kontaminasi eksternal timbal (Pb) pada pelumas gearset',
      wear_si: 'Roda gigi & bearing (keausan abrasif debu)',
      wear_sn: 'Bushing & komponen bronze kompartemen',
      wear_ni: 'Roda gigi & shaft paduan nikel berisiko aus',
      visc_v100: 'Viskositas menyimpang → gear & bearing berisiko aus akibat film pelumasan tidak memadai',
      visc_v40: 'Viskositas @40\u00b0C menyimpang → pelumasan gear & bearing terganggu',
      tbn: 'Oli kehilangan daya netralisasi asam → korosi gear & bearing',
      water_pct: 'Air → korosi gear & bearing, degradasi oli & seal',
      fuel_pct: 'Kontaminan fluida luar / pelarut pengencer oli',
      soot: 'Kontaminan menebalkan oli → sirkulasi terganggu, deposit pada gear',
      oxidation: 'Varnish/sludge → saluran oli tersumbat, gear & bearing kekurangan pelumasan',
      nitration: 'Degradasi termal & penuaan oli gear',
      sulfation: 'Kontaminasi sulfur & pembentukan asam pada oli gear',
      pqi: 'Partikel → keausan presisi gear & bearing',
      additive_na: 'Kebocoran seal/cooler kompartemen gear'
    },
    /* ---------------- HYDRAULIC ---------------- */
    hydraulic: {
      wear_fe: 'Pompa, motor, & cylinder hidrolik berisiko aus (efisiensi turun)',
      wear_cu: 'Slipper pads, valve plate bronze, & bushing pompa hidrolik',
      wear_al: 'Housing & piston aluminium hidrolik',
      wear_cr: 'Rod & shaft hidrolik (lapisan keras)',
      wear_pb: 'Bushing pompa/motor hidrolik / residu Pb',
      wear_si: 'Pompa & valve hidrolik (keausan abrasif debu)',
      wear_sn: 'Bushing & slipper pad pompa hidrolik',
      wear_ni: 'Shaft pompa & valve spool paduan nikel hidrolik berisiko aus',
      visc_v100: 'Viskositas menyimpang → pompa, valve, & seal hidrolik berisiko aus akibat film pelumasan tidak memadai',
      visc_v40: 'Viskositas @40\u00b0C menyimpang → respons hidrolik melambat, seal & pompa berisiko aus',
      tbn: 'Oli kehilangan daya netralisasi → korosi valve & pompa hidrolik',
      water_pct: 'Air → korosi valve & pompa, degradasi seal',
      fuel_pct: 'Kontaminan pelarut / pengenceran fluida hidrolik',
      soot: 'Kontaminan menebalkan oli → valve spool macet, sirkulasi terhambat',
      oxidation: 'Varnish/sludge → valve spool macet, saluran oli tersumbat, pompa kekurangan pelumasan',
      nitration: 'Degradasi termal oli hidrolik',
      sulfation: 'Kontaminasi asam pada sistem hidrolik',
      pqi: 'Partikel → valve spool macet, pompa aus, & seal bocor',
      additive_na: 'Kebocoran coolant/oil cooler hidrolik'
    },
    /* ---------------- AXLE (final drive/differential/swing) ---------------- */
    axle: {
      wear_fe: 'Gear final drive/differential/swing, bearing, & spline axle berisiko aus',
      wear_cu: 'Bronze thrust washer, pinion thrust washer, & bushing kuningan axle/differential',
      wear_al: 'Housing axle aluminium',
      wear_cr: 'Gear & shaft (lapisan keras) axle/differential',
      wear_pb: 'Kontaminasi timbal (Pb) / kontaminasi silang pelumas kompartemen axle',
      wear_si: 'Gear & bearing axle/differential (keausan abrasif debu)',
      wear_sn: 'Bushing bronze & wear plate axle/differential',
      wear_ni: 'Gear & shaft paduan nikel axle/differential berisiko aus',
      visc_v100: 'Viskositas menyimpang → gear & bearing axle berisiko aus akibat film pelumasan tidak memadai',
      visc_v40: 'Viskositas @40\u00b0C menyimpang → pelumasan gear & bearing axle terganggu',
      tbn: 'Oli kehilangan daya netralisasi → korosi gear & bearing axle/differential',
      water_pct: 'Air → korosi gear & bearing, degradasi seal axle',
      fuel_pct: 'Kontaminan fluida luar / pengenceran oli kompartemen',
      soot: 'Kontaminan menebalkan oli → gear & bearing kekurangan pelumasan',
      oxidation: 'Varnish/sludge → saluran oli tersumbat, gear & bearing kekurangan pelumasan',
      nitration: 'Degradasi termal oli kompartemen axle/differential',
      sulfation: 'Kontaminasi asam & degradasi oli axle/differential',
      pqi: 'Partikel → keausan gear & bearing final drive/differential/swing',
      additive_na: 'Kebocoran seal/cooler kompartemen axle/differential'
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
   * [HIPOTESIS SPESIFIK-NILAI 2026-10-01] Bangun SATU baris hipotesis yang
   * mengikat NILAI nyata + ambang warning/critical, agar Hipotesis Effect
   * tidak generik. Contoh keluaran:
   *   "PQI = 513 (10,3× ambang Critical 50) — tingkat partikel sangat tinggi,
   *    indikasi keausan abrasif / kontaminasi berat."
   * Mengembalikan '' bila data nilai/ambang tidak tersedia (fallback aman).
   * @param {string} paramKey
   * @param {object} opts { label, value, unit, warn, crit }
   * @returns {string}
   */
  function hypothesisValueLine(paramKey, opts) {
    if (!opts || opts.value === null || opts.value === undefined) return '';
    var label = opts.label || paramKey;
    var unit = opts.unit || '';
    var val = opts.value;
    var warnTh = (opts.warn !== undefined && opts.warn !== null) ? opts.warn : null;
    var critTh = (opts.crit !== undefined && opts.crit !== null) ? opts.crit : null;
    var warnLow = (opts.warn_low !== undefined && opts.warn_low !== null) ? opts.warn_low : null;
    var critLow = (opts.crit_low !== undefined && opts.crit_low !== null) ? opts.crit_low : null;
    var warnHigh = (opts.warn_high !== undefined && opts.warn_high !== null) ? opts.warn_high : null;
    var critHigh = (opts.crit_high !== undefined && opts.crit_high !== null) ? opts.crit_high : null;

    var isDual = !!opts.isDual || (warnLow !== null && (warnHigh !== null || warnTh !== null));
    var lowMode = (opts.breachDirection === 'low') ||
                  (critTh !== null && warnTh !== null && critTh < warnTh) ||
                  (opts.thMode === 'low') || (opts.mode === 'low') ||
                  (warnLow !== null && val <= warnLow) ||
                  (critLow !== null && val <= critLow);

    var meta = (global.SOS_CONFIG && global.SOS_CONFIG.PARAMS && global.SOS_CONFIG.PARAMS[paramKey]) || {};
    var dec = (meta.decimals === undefined) ? 1 : meta.decimals;

    function fmtNum(n) {
      if (n === null || n === undefined || isNaN(n)) return null;
      var s = Number(n).toFixed(dec);
      // Format ribuan gaya Indonesia (1.234) & desimal koma.
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return parts.join(',');
    }
    var valTxt = fmtNum(val);
    if (valTxt === null) return '';

    var sev = opts.severity || 0;
    var extTh = (opts.extreme !== undefined && opts.extreme !== null) ? opts.extreme : null;
    var refTh, refName;

    if (lowMode) {
      var cl = critLow !== null ? critLow : critTh;
      var wl = warnLow !== null ? warnLow : warnTh;
      if (sev >= 2 && cl !== null) {
        refTh = cl;
        refName = isDual ? 'Critical Bawah' : 'Critical';
      } else if (wl !== null) {
        refTh = wl;
        refName = isDual ? 'Warning Bawah' : 'Warning';
      } else if (cl !== null) {
        refTh = cl;
        refName = isDual ? 'Critical Bawah' : 'Critical';
      } else {
        refTh = null; refName = '';
      }
    } else {
      var ch = critHigh !== null ? critHigh : critTh;
      var wh = warnHigh !== null ? warnHigh : warnTh;
      if (sev >= 4 && extTh !== null) {
        refTh = extTh;
        refName = isDual ? 'Critical Atas' : 'Critical';
      } else if (sev >= 2 && ch !== null) {
        refTh = ch;
        refName = isDual ? 'Critical Atas' : 'Critical';
      } else if (wh !== null) {
        refTh = wh;
        refName = isDual ? 'Warning Atas' : 'Warning';
      } else if (ch !== null) {
        refTh = ch;
        refName = isDual ? 'Critical Atas' : 'Critical';
      } else {
        refTh = null; refName = '';
      }
    }

    var valStr = label + ' = ' + valTxt + (unit ? ' ' + unit : '');
    var ratioTxt = '';
    if (refTh !== null && refTh !== undefined && !isNaN(refTh) && refTh !== 0) {
      var ratio = lowMode ? (refTh / (val || 1)) : (val / refTh);
      if (isFinite(ratio) && ratio > 0) {
        ratioTxt = ' (' + (Math.round(ratio * 10) / 10).toString().replace('.', ',') +
                   '× ambang ' + refName + ' ' + fmtNum(refTh) + (unit ? ' ' + unit : '') + ')';
      }
    }

    // Frasa kondisi SPESIFIK per kelompok parameter (humanis, tanpa halusinasi).
    var cond = '';
    var g = (findEntry(paramKey) || {}).group;
    if (paramKey === 'visc_v100' || paramKey === 'visc_v40') {
      var comp = opts.component ? normalizeComponent(opts.component) : '';
      var isEngine = (comp === 'ENGINE');
      var fam = comp ? COMPONENT_FAMILY[comp] : '';
      var isPump = (fam === 'hydraulic');
      var isGear = (fam === 'axle' || fam === 'gear' || fam === 'gearbox');

      if (lowMode) {
        if (isEngine) {
          cond = 'menunjukkan oli terlalu encer (potensi fuel dilution bahan bakar / mechanical shearing aditif / salah grade oli)';
        } else if (isPump) {
          cond = 'menunjukkan fluida hidrolik terlalu encer (potensi kontaminasi pelarut, mechanical shearing, atau salah grade oli)';
        } else if (isGear) {
          cond = 'menunjukkan oli gear terlalu encer (potensi mechanical shearing aditif, kebocoran seal fluida lain, atau salah grade oli)';
        } else {
          cond = 'menunjukkan oli terlalu encer (potensi kontaminasi pelarut, mechanical shearing aditif, atau salah grade oli)';
        }
      } else {
        if (isEngine) {
          cond = 'menunjukkan oli terlalu kental (indikasi jelaga soot tinggi, oksidasi/panas operasi berlebih, atau akumulasi partikel)';
        } else if (isPump) {
          cond = 'menunjukkan fluida hidrolik terlalu kental (indikasi oksidasi fluida karena temperatur tinggi, kontaminasi partikel, atau salah grade oli)';
        } else if (isGear) {
          cond = 'menunjukkan oli gear terlalu kental (indikasi oksidasi/panas operasi kompartemen tinggi, breather tersumbat, atau kontaminasi partikel padat Si/Fe)';
        } else {
          cond = 'menunjukkan oli terlalu kental (indikasi oksidasi/panas berlebih atau kontaminasi partikel padat Si/Fe)';
        }
      }
    } else if (g === 'wear') {
      cond = 'menandakan keausan komponen berbasis logam ini meningkat' +
             (lowMode ? '' : ' — makin tinggi makin aktif keausannya');
    } else if (paramKey === 'pqi' || paramKey === 'pc_4u' || paramKey === 'pc_6u' ||
               paramKey === 'pc_14u' || paramKey === 'pc_21u') {
      cond = 'menandakan tingkat partikel & kontaminasi melebihi batas — potensi keausan abrasif & penyumbatan jalur oli';
    } else if (g === 'oil') {
      cond = 'menunjukkan kondisi oli bergeser dari spesifikasi';
    } else if (g === 'additive') {
      cond = 'menunjukkan perubahan keseimbangan aditif / indikasi kontaminasi';
    } else {
      cond = lowMode ? 'di bawah ambang batas yang ditetapkan' : 'di atas ambang yang ditetapkan';
    }
    return valStr + ratioTxt + ' — ' + cond + '.';
  }

  // [DAMPAK SPESIFIK VISKOSITAS 2026-10-03] Pembedaan dampak antara oli mengental (batas atas) vs mengencer (batas bawah)
  var VISC_IMPACT_HIGH = {
    engine: 'Oli terlalu kental → hambatan sirkulasi pelumasan meningkat, risiko starved lubrication saat start-up, deposit varnish, & keausan bearing/camshaft',
    gearbox: 'Oli terlalu kental → hambatan hidrodinamis meningkat, respons perpindahan clutch lambat, suhu kerja naik, & gear set berisiko aus',
    gear: 'Oli terlalu kental → sirkulasi pelumas terhambat, hambatan gesek meningkat, gear & bearing berisiko starved lubrication serta overheat',
    hydraulic: 'Oli terlalu kental → kavitasi pompa hidrolik, respons valve melambat, pressure drop tinggi, & pompa hidrolik berisiko aus',
    axle: 'Oli terlalu kental → sirkulasi oli terhambat, hambatan putar & temperatur gear set meningkat, gear & bearing axle berisiko aus',
    cooling: 'Oli terlalu kental → sirkulasi terhambat, beban pompa & bearing meningkat'
  };

  var VISC_IMPACT_LOW = {
    engine: 'Oli terlalu encer → film pelumasan menipis/pecah, bearing, camshaft, & cylinder liner berisiko kontak logam langsung (seizure/aus)',
    gearbox: 'Oli terlalu encer → daya dukung beban turun drastis, clutch pack berisiko slip & gear set berisiko aus/pitting',
    gear: 'Oli terlalu encer → film pelumasan tidak mampu menahan beban kontak tinggi, gear & bearing berisiko aus dan pitting',
    hydraulic: 'Oli terlalu encer → internal leakage meningkat, efisiensi volumetrik pompa turun drastis, pompa & spool valve berisiko aus',
    axle: 'Oli terlalu encer → film pelumasan pecah saat beban berat, gear & bearing axle berisiko aus/skuffing',
    cooling: 'Oli terlalu encer → daya dukung pelumasan turun, bearing berisiko aus'
  };

  /**
   * Dampak (part/komponen spesifik) untuk sebuah parameter + kompartemen.
   * Fallback berurutan: impact spesifik keluarga -> impact generik param
   * (dari KB.components) -> frasa netral.
   * @param {string} paramKey
   * @param {string} [component]
   * @param {boolean|object} [isLow]  apakah melewati batas bawah (pengenceran) vs atas (kekentalan)
   * @returns {string} frasa part/komponen
   */
  function impactFor(paramKey, component, isLow) {
    var comp = component ? normalizeComponent(component) : '';
    var fam = comp ? COMPONENT_FAMILY[comp] : '';

    if (paramKey === 'visc_v100' || paramKey === 'visc_v40') {
      var low = false;
      if (typeof isLow === 'boolean') {
        low = isLow;
      } else if (isLow && typeof isLow === 'object') {
        low = isLow.breachDirection === 'low' || isLow.isLow || (isLow.thMode === 'low');
      }
      if (low) {
        return (fam && VISC_IMPACT_LOW[fam]) || VISC_IMPACT_LOW.engine;
      } else {
        return (fam && VISC_IMPACT_HIGH[fam]) || VISC_IMPACT_HIGH.engine;
      }
    }

    if (fam && PARAM_IMPACT[fam] && PARAM_IMPACT[fam][paramKey]) return PARAM_IMPACT[fam][paramKey];
    // [FIX 2026-10-01] Fallback ke engine HANYA untuk kompartemen ENGINE.
    // Non-engine jatuh ke frasa netral — JANGAN pakai engine impact
    // (camshaft, cylinder liner) untuk kompartemen yang tidak memilikinya.
    if ((!comp || fam === 'engine') && PARAM_IMPACT.engine[paramKey]) return PARAM_IMPACT.engine[paramKey];
    // Fallback: komponen terkait dari KB utama (dibersihkan bila non-engine).
    var data = findEntry(paramKey);
    if (data && data.refs && data.refs.length) {
      if (fam && fam !== 'engine') {
        var cleanRefs = data.refs.map(function (r) {
          return r.replace(/\b(piston|liner|valve|cylinder|combustion|injector|blowby|air cleaner|head gasket|ruang bakar)\b/gi, 'komponen internal');
        }).filter(function (r) { return r && r.length > 2; });
        if (cleanRefs.length) return cleanRefs.join(', ') + ' berisiko terpengaruh';
      } else {
        return data.refs.join(', ') + ' berisiko terpengaruh';
      }
    }
    return 'Komponen internal kompartemen berisiko terpengaruh bila dibiarkan';
  }

  /**
   * Rujukan (refs) untuk sebuah parameter + kompartemen.
   * Menggabungkan: rujukan manual per-keluarga + rujukan per-parameter (REFS)
   *
   * [PENTING] Untuk kompartemen NON-ENGINE, rujukan per-parameter wear dari
   * `REFS` (yang ditulis dari perspektif mesin: "Piston Ring", "Cylinder
   * Liner") DIGANTI dengan rujukan kompartemen netral, agar tidak salah
   * konteks (mis. transmisi tidak punya piston ring).
   * @param {string} paramKey
   * @param {string} [component]
   * @param {string} [model]  model unit — menentukan nama manual (sadar-merek).
   * @returns {string[]}
   */
  function refsForComponent(paramKey, component, model) {
    var out = [];
    var seen = {};
    var brand = brandManualName(model);
    function add(list) {
      (list || []).forEach(function (x) {
        var k = String(applyBrandToRef(x, brand)).trim();
        if (k && !seen[k]) { seen[k] = 1; out.push(k); }
      });
    }
    var comp = component ? normalizeComponent(component) : '';
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
    var isEngine = (fam === 'engine' || !comp);
    var isWear = /^wear_/.test(String(paramKey || ''));

    add(FAMILY_REF[fam]);

    if (isEngine) {
      add(refsFor(paramKey));
    } else {
      if (isWear) {
        add(['SOP Wear-Metal Analysis Kompartemen (' + (comp || 'kompartemen') + ')',
             'Panduan penilaian keausan berbasis keluarga kompartemen (gear/bearing/bushing)']);
      } else if (paramKey === 'fuel_pct') {
        add(['SOP verifikasi kontaminasi fluida eksternal / pelarut kompartemen']);
      } else if (paramKey === 'soot') {
        add(['SOP verifikasi kontaminasi partikel jelaga / degradasi termal kompartemen']);
      } else if (paramKey === 'nitration') {
        add(['SOP analisis degradasi termal & nitrasi oli kompartemen']);
      } else if (paramKey === 'sulfation') {
        add(['SOP analisis sulfasi & kualitas pelumas kompartemen']);
      } else if (paramKey === 'additive_na') {
        add(['SOP uji kebocoran seal/cooler kompartemen & analisis Sodium (Na)']);
      } else {
        add(refsFor(paramKey));
      }
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
    var fam = comp ? COMPONENT_FAMILY[comp] : '';
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

    // [PEMBEDAAN VISKOSITAS 2026-10-03] Pisahkan narasi Penyebab (Why) & Aksi (What & How)
    // antara treshold batas atas (kekentalan oli) vs batas bawah (pengenceran oli),
    // serta dibedakan spesifik antara Engine, Hydraulic (Pump), dan Gear/Axle (Final Drive/Diff/Transmission).
    var isVisc = (paramKey === 'visc_v100' || paramKey === 'visc_v40');
    var isLow = false;
    if (isVisc) {
      if (opts.breachDirection === 'low') {
        isLow = true;
      } else if (opts.breachDirection === 'high') {
        isLow = false;
      } else if (opts.thMode === 'low') {
        isLow = true;
      } else if (typeof opts.value === 'number') {
        if (typeof opts.crit_low === 'number' && opts.value <= opts.crit_low) isLow = true;
        else if (typeof opts.warn_low === 'number' && opts.value <= opts.warn_low) isLow = true;
        else if (typeof opts.crit_high === 'number' && opts.value >= opts.crit_high) isLow = false;
        else if (typeof opts.warn_high === 'number' && opts.value >= opts.warn_high) isLow = false;
        else if (typeof opts.crit === 'number' && typeof opts.warn === 'number' && opts.crit < opts.warn) isLow = true;
      }

      var isPump = (fam === 'hydraulic');
      var isGear = (fam === 'axle' || fam === 'gear' || fam === 'gearbox');

      if (isLow) {
        // --- BATAS BAWAH (PENGENCERAN OLI / THINNING) ---
        if (level === 'severe') {
          likely = [
            isEngine
              ? 'Pengenceran bahan bakar (fuel dilution) berat atau kontaminasi pelarut menurunkan viskositas drastis'
              : (isPump
                ? 'Viskositas fluida hidrolik anjlok drastis — indikasi kontaminasi pelarut/cairan lain atau mechanical shear parah'
                : 'Viskositas oli gear anjlok drastis — mechanical shearing parah pada aditif atau kontaminasi pelarut/kebocoran seal fluida lain'),
            isEngine
              ? 'Film pelumasan pecah — oli tidak mampu menahan beban gesek kontak antara piston ring, liner, dan bearing engine'
              : (isPump
                ? 'Daya dukung film pelumasan hilang — internal leakage meningkat di dalam pompa dan spool valve hidrolik'
                : 'Daya dukung pelumasan hilang — film oli tidak mampu menahan tekanan kontak ekstrem (EP) antar permukaan gigi roda gigi')
          ];
          actions = [
            (comp && isFilterless(comp))
              ? 'Kuras & ganti oli segera — jangan operasikan unit dengan viskositas oli yang terlalu encer.'
              : (isEngine ? 'Ganti oli & filter segera — hentikan unit untuk perbaikan kebocoran bahan bakar.' : 'Kuras & ganti oli segera — jangan operasikan unit dengan viskositas oli yang terlalu encer.'),
            isEngine
              ? 'Cek sistem bahan bakar: uji kebocoran injektor, seal injector, dan timing pembakaran.'
              : (isPump
                ? 'Identifikasi sumber pengenceran: periksa kebocoran seal pompa, kontaminasi pembersih/pelarut, atau kesalahan grade oli.'
                : 'Identifikasi sumber pengenceran: periksa seal kompartemen (duo cone / oil seal) dari kebocoran/rembesan fluida lain.'),
            isEngine
              ? 'Verifikasi spesifikasi grade oli SAE (pastikan tidak salah menggunakan oli yang lebih encer).'
              : (isPump
                ? 'Verifikasi spesifikasi grade oli hidrolik sesuai standar manual pabrikan (ISO VG 46/68).'
                : 'Verifikasi spesifikasi grade SAE gear oil (pastikan tidak salah menggunakan oli yang lebih encer dari standar manual).'),
            'Uji ulang sampel oli setelah penggantian untuk memastikan viskositas kembali stabil.'
          ];
          escalate = 'Viskositas terlalu encer mengancam rusaknya film pelumasan — risiko kontak logam & seizure komponen kritis.';
        } else if (level === 'critical') {
          likely = [
            isEngine
              ? 'Viskositas turun melampaui batas — indikasi awal fuel dilution atau mechanical shearing aditif'
              : (isPump
                ? 'Viskositas fluida hidrolik turun melampaui batas — degradasi shearing aditif atau kontaminasi cairan lain yang lebih encer'
                : 'Viskositas oli gear turun melampaui batas — indikasi degradasi shearing aditif atau masuknya kontaminan fluida yang lebih encer'),
            isEngine
              ? 'Penurunan daya dukung pelumasan mulai berdampak pada peningkatan keausan bearing dan liner'
              : (isPump
                ? 'Penurunan viskositas menyebabkan efisiensi volumetrik pompa turun dan kebocoran internal meningkat'
                : 'Penurunan viskositas mengurangi ketebalan lapisan film oli pada roda gigi dan bearing')
          ];
          actions = [
            isEngine
              ? 'Cari penyebab dominan oli mengencer: uji kebocoran injektor (fuel dilution) atau shearing aditif.'
              : (isPump
                ? 'Cari penyebab dominan fluida mengencer: periksa kontaminasi fluida lain, pelarut pembersih, atau shearing aditif.'
                : 'Cari penyebab dominan oli mengencer: periksa kontaminasi fluida lain, keausan seal, atau degradasi aditif oli gear.'),
            'Pertimbangkan penggantian oli lebih awal dan verifikasi kesesuaian grade oli sesuai spesifikasi manual.',
            isGear
              ? 'Periksa magnetic drain plug dari akumulasi partikel aus dan pantau parameter keausan Fe/Cu.'
              : 'Pantau tren laju keausan logam pada sampling berikutnya untuk memastikan tidak ada gesekan abnormal.'
          ];
        } else {
          likely = [
            'Viskositas mulai bergeser ke batas bawah — indikasi degradasi aditif atau pengenceran ringan',
            'Variasi sampling atau ketidaksesuaian grade oli saat top-up'
          ];
          actions = [
            isEngine
              ? 'Cek Fuel Dilution & Oxidation sebagai potensi penyebab penurunan viskositas.'
              : 'Periksa potensi kontaminasi fluida eksternal atau variasi grade oli saat top-up.',
            'Verifikasi kesesuaian grade oli yang dipakai & interval penggantian.',
            'Konfirmasi tren viskositas pada sampling berikutnya.'
          ];
        }
      } else {
        // --- BATAS ATAS (KEKENTALAN OLI / THICKENING) ---
        if (level === 'severe') {
          likely = [
            isEngine
              ? 'Viskositas melonjak tinggi melampaui batas atas — oli engine mengalami penumpukan jelaga (soot) tinggi, oksidasi parah, atau penuaan termal'
              : (isPump
                ? 'Viskositas fluida hidrolik melonjak melampaui batas atas — degradasi termal parah, oksidasi lanjut karena panas sistem, atau kontaminasi partikel'
                : 'Viskositas oli gear melonjak tinggi melampaui batas atas — oksidasi termal parah akibat gesekan gigi berat, ventilasi breather tersumbat, atau kontaminasi partikel'),
            isEngine
              ? 'Oli terlalu kental — hambatan sirkulasi pelumasan meningkat, memicu starved lubrication pada bearing & camshaft saat start-up'
              : (isPump
                ? 'Fluida hidrolik terlalu kental — hambatan aliran sangat tinggi, memicu kavitasi pompa hidrolik & lonjakan tekanan sistem'
                : 'Oli terlalu kental — aliran pelumas ke celah sempit bearing dan kontak gigi terhambat, memicu starved lubrication & kenaikan panas lokal')
          ];
          actions = [
            (comp && isFilterless(comp))
              ? 'Kuras & ganti oli segera — jangan operasikan unit dengan oli yang mengental ekstrem.'
              : 'Ganti oli & filter segera — jangan operasikan unit dengan oli yang mengental ekstrem.',
            isEngine
              ? 'Investigasi penyebab oli mengental: cek jelaga soot tinggi, suhu operasi berlebih (overheating), atau oksidasi lanjut.'
              : (isPump
                ? 'Inspeksi sistem pendingin oli hidrolik (hydraulic oil cooler) dan atasi penyebab temperatur kerja hidrolik berlebih.'
                : 'Periksa ventilasi breather kompartemen (pastikan tidak buntu/tersumbat yang menyebabkan panas terperangkap).'),
            isEngine
              ? 'Verifikasi spesifikasi grade oli SAE (pastikan tidak salah mengisi grade oli yang lebih kental dari standar manual).'
              : (isPump
                ? 'Verifikasi grade kekentalan oli (pastikan sesuai spesifikasi ISO VG 46/68 atau SAE 10W pabrikan).'
                : 'Verifikasi spesifikasi grade SAE gear oil (pastikan tidak salah menggunakan oli yang lebih kental dari standar manual).'),
            isGear
              ? 'Inspeksi serpihan logam pada magnetic plug atau drain plug sebelum pengisian oli baru.'
              : 'Bersihkan/inspeksi pendingin (cooler) dan jalur sirkulasi oli untuk memastikan pelepasan panas optimal.'
          ];
          escalate = 'Viskositas oli terlalu kental menghambat sirkulasi pelumasan — risiko keausan gesek tinggi dan overheating komponen.';
        } else if (level === 'critical') {
          likely = [
            isEngine
              ? 'Viskositas naik melampaui batas atas — oli engine menebal akibat akumulasi jelaga (soot), oksidasi awal, atau temperatur kerja mesin tinggi'
              : (isPump
                ? 'Viskositas fluida hidrolik naik melampaui batas atas — oli mengalami oksidasi termal akibat temperatur kerja hidrolik tinggi atau salah grade oli yang lebih kental'
                : 'Viskositas oli gear naik melampaui batas atas — pelumas mengalami penebalan akibat oksidasi temperatur tinggi atau kontaminasi partikel debu/logam'),
            isEngine
              ? 'Peningkatan viskositas menaikkan hambatan gesek & beban sirkulasi pelumasan internal engine'
              : (isPump
                ? 'Hambatan gesek fluida meningkat, memicu perlambatan respons aktuator dan kenaikan suhu operasi hidrolik'
                : 'Hambatan putar gear set dan temperatur operasi kompartemen meningkat akibat oli yang terlalu kental')
          ];
          actions = [
            isEngine
              ? 'Cari penyebab dominan oli mengental: cek kadar Soot, laju Oksidasi, atau temperatur kerja mesin.'
              : (isPump
                ? 'Cari penyebab dominan fluida mengental: cek indikasi oksidasi fluida, kebersihan oil cooler hidrolik, dan temperatur kerja sistem.'
                : 'Cari penyebab dominan oli mengental: periksa oksidasi pelumas, kebersihan ventilasi breather, atau kontaminasi partikel padat.'),
            'Pertimbangkan penggantian/kuras oli lebih awal dan verifikasi spesifikasi grade oli yang digunakan.',
            isEngine
              ? 'Periksa kondisi filter udara (air cleaner) dan sistem pendingin untuk mencegah penumpukan panas/jelaga lebih lanjut.'
              : (isPump
                ? 'Periksa sirkulasi pendingin hidrolik dan bersihkan sirip cooler dari hambatan kotoran/debu.'
                : 'Periksa kondisi operasi beban dan pastikan breather kompartemen bersih agar panas tidak terperangkap.')
          ];
        } else {
          likely = [
            'Viskositas mulai bergeser ke batas atas — awal proses oksidasi pelumas atau akumulasi partikel',
            'Kemungkinan pengisian top-up dengan grade oli yang sedikit lebih kental'
          ];
          actions = [
            'Pantau tren kenaikan viskositas bersama nilai oksidasi dan kontaminan pada sampling berikutnya.',
            'Verifikasi spesifikasi grade oli yang dipakai saat penggantian atau top-up terakhir.',
            isGear
              ? 'Pastikan ventilasi breather kompartemen bersih dari sumbatan tanah/kotoran.'
              : 'Pastikan ventilasi breather dan pendingin kompartemen bersih dari kotoran.'
          ];
        }
      }
    }

    if (!actions.length) {
      actions = ['Lakukan inspeksi parameter ini sesuai prosedur laboratorium/SOP.',
                 'Catat tren nilai terhadap HM/meter untuk evaluasi berkala.'];
    }

    // [HIPOTESIS SPESIFIK-NILAI 2026-10-01] Bangun SATU baris hipotesis yang
    // mengikat NILAI nyata + ambang warning/critical, agar Hipotesis Effect
    // tidak generik. Contoh keluaran:
    //   "PQI = 513 (10,3× ambang Critical 50) — tingkat partikel sangat tinggi,
    //    indikasi keausan abrasif / kontaminasi berat."
    // Mengembalikan '' bila data nilai/ambang tidak tersedia (fallback aman).
    var hypoLine = hypothesisValueLine(paramKey, {
      label: opts.label, value: opts.value, unit: opts.unit,
      component: opts.component,
      warn: opts.warn, crit: opts.crit, extreme: opts.extreme,
      warn_low: opts.warn_low, crit_low: opts.crit_low,
      warn_high: opts.warn_high, crit_high: opts.crit_high,
      isDual: opts.isDual, breachDirection: opts.breachDirection,
      thMode: opts.thMode, severity: severity
    });
    if (hypoLine) likely.unshift(hypoLine);

    // Konteks tren (ROW100) bila tersedia
    if (opts.trend === 'up') {
      actions.push('Tren MENINGKAT — pantau lebih ketat pada sampling berikutnya.');
    } else if (opts.trend === 'down') {
      actions.push('Tren MENURUN — indikasi degradasi, pantau ketat.');
    }

    // [RELEVANSI FILTER 2026-10-01] Untuk parameter kebersihan (PQI / particle
    // count), tambahkan panduan kebersihan yang TEPAT untuk kompartemen:
    //   - kompartemen TANPA filter (mis. FINAL DRIVE / gear case) -> magnetic
    //     drain plug + kuras oli (JANGAN menyarankan "ganti filter").
    //   - kompartemen dgn filter (engine/gearbox/hydraulic) -> saran filter yg
    //     benar sesuai jenisnya (engine: cut-open filter oli).
    // Hanya ditambahkan bila belum ada frasa filter di tindakan (hindari
    // duplikasi / kontradiksi) dan kompartemennya DIKENAL.
    if (group === 'clean' && comp) {
      var mentionsFilter = actions.some(function (a) {
        return /filter/i.test(String(a));
      });
      if (!mentionsFilter) actions.push(filterRelevancePhrase(opts.component));
    }

    // [RELEVANSI FILTER 2026-10-01] Untuk kompartemen TANPA elemen penyaring
    // (axle/gear: final drive, differential, swing, PTO, reducer, gear case),
    // BERSIHKAN semua sisa sebutan "filter" pada tindakan oil/clean yang
    // diwarisi dari KB (mis. "ganti oli & filter" -> "kuras & ganti oli").
    // Transmisi (gearbox) & hidrolik TETAP boleh menyebut filter.
    if (comp && isFilterless(comp)) {
      actions = actions.map(function (a) {
        var s = String(a);
        if (!/filter/i.test(s)) return s;
        // "filter udara" (air intake) tetap dipertahankan.
        s = s.replace(/ganti oli & filter/gi, 'kuras & ganti oli');
        s = s.replace(/ganti oli\/filter/gi, 'kuras & ganti oli');
        s = s.replace(/\s*&\s*periksa filter(?!\s*udara)\b/gi, '');
        s = s.replace(/\s*&\s*ganti filter(?!\s*udara)\b/gi, '');
        s = s.replace(/,\s*periksa filter(?!\s*udara)\b/gi, '');
        s = s.replace(/\s*\(bila ada\)\s*untuk serpihan besar/gi, ' untuk serpihan besar');
        s = s.replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
        // Kapitalkan huruf pertama (mis. "kuras & ganti oli" -> "Kuras & ganti oli").
        if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
        return s;
      });
      // Buang tindakan yang menjadi kosong/duplikat setelah pembersihan.
      var seenAct = {};
      actions = actions.filter(function (a) {
        var k = String(a).trim().toLowerCase();
        if (!k) return false;
        if (seenAct[k]) return false;
        seenAct[k] = 1; return true;
      });
    }

    // [FIX 2026-10-01] PEMBERSIHAN NARASI ENGINE pada kompartemen NON-ENGINE.
    // KB utama ditulis dari perspektif mesin (menyebut injektor, piston ring,
    // EGR, crankcase, silinder, dll). Narasi ini SALAH konteks bila diterapkan
    // ke FINAL DRIVE / HYDRAULIC / TRANSMISSION / DIFFERENTIAL / dll.
    //
    // Strategi: ganti frasa engine-specific → frasa NETRAL kompartemen.
    var engineReplacements = [
      // gasket / cooler
      [/\bgasket head\b/gi, 'seal/gasket kompartemen'],
      [/\bhead gasket\b/gi, 'seal/gasket kompartemen'],
      [/\boil cooler engine\b/gi, 'cooler kompartemen'],
      // injektor → sumber kontaminasi
      [/\binjektor\b[^.;]*/gi, 'sumber kontaminasi kompartemen'],
      [/\buji injektor[^.;]*/gi, 'Identifikasi sumber kontaminasi/degradasi oli'],
      [/\bcek injector[^.;]*/gi, 'Cek sumber kontaminasi oli kompartemen'],
      [/\binjector\b/gi, 'sumber kontaminasi'],
      // valve (kecuali hidrolik)
      [/\bvalve mechanism\b/gi, (fam === 'hydraulic' ? 'valve hidrolik' : 'komponen internal')],
      [/\bvalve clearance\b/gi, 'clearance komponen'],
      [/\bvalve seat\b/gi, 'komponen internal'],
      [/\bvalve\b/gi, (fam === 'hydraulic' ? 'valve hidrolik' : 'komponen internal')],
      // piston ring → komponen bergerak
      [/\bring piston\b/gi, 'komponen bergerak'],
      [/\bpiston ring\b/gi, 'komponen bergerak'],
      [/\bring\/piston\b/gi, 'komponen bergerak'],
      [/\bring,?\s*liner\b/gi, 'komponen internal'],
      [/\bpiston\/skirt\b/gi, 'komponen internal'],
      [/\bpiston\b/gi, (fam === 'hydraulic' ? 'piston pompa hidrolik' : 'komponen internal')],
      [/\bliner\b/gi, 'komponen internal'],
      // crankcase → kompartemen
      [/\bcrankcase\b/gi, 'kompartemen'],
      [/\btekanan crankcase\b/gi, 'kondisi internal kompartemen'],
      // blowby
      [/\bblowby\b/gi, 'tekanan internal'],
      // EGR → (hapus, tidak relevan)
      [/\bEGR\s*\([^)]*\)\s*/gi, ''],
      [/\bsistem\s*EGR\b/gi, 'kondisi operasi'],
      [/\bEGR\b/gi, ''],
      [/\bcek \u0026 perbaiki sistem pembakaran\/[^.;]*/gi, 'Identifikasi & perbaiki sumber degradasi oli'],
      // silinder → kompartemen
      [/\bsilinder\b/gi, (fam === 'hydraulic' ? 'cylinder hidrolik' : 'kompartemen')],
      [/\bcylinder\b/gi, (fam === 'hydraulic' ? 'cylinder hidrolik' : 'kompartemen')],
      [/\bruang bakar\b/gi, 'ruang operasi'],
      // pembakaran → degradasi termal / kontaminasi
      [/\bpembakaran tidak sempurna\b/gi, 'degradasi termal'],
      [/\bkualitas pembakaran\b/gi, 'kondisi operasi'],
      [/\bsistem pembakaran\b/gi, 'kondisi termal'],
      [/\bpembakaran\b/gi, 'degradasi termal/kontaminasi'],
      // gas buang → (hapus, tidak relevan non-engine)
      [/\breaksi NOx\b/gi, 'degradasi termal/oksidasi'],
      [/\bproduk reaksi NOx\b/gi, 'produk degradasi termal'],
      [/\bgas buang\b/gi, 'kontaminasi'],
      [/\bexhaust\b/gi, 'kontaminasi'],
      // idle → beban operasi
      [/\bidle berkepanjangan\b/gi, 'operasi ringan berkepanjangan'],
      [/\bidle berlebih\b/gi, 'operasi abnormal'],
      [/\bidle\b/gi, 'operasi'],
      // intake → jalur masuk
      [/\bsistem intake\b/gi, 'titik masuk kontaminasi'],
      [/\bjalur intake\b/gi, 'jalur masuk'],
      [/\bintake\b/gi, 'jalur masuk'],
      // bahan bakar → (ganti konteks)
      [/\bkualitas bahan bakar[^.;]*/gi, 'kualitas & kondisi oli'],
      [/\bkadar sulfur bahan bakar\b/gi, 'kontaminan dalam oli'],
      [/\bsulfur bahan bakar\b/gi, 'kontaminan'],
      [/\bbahan bakar sulfur\b/gi, 'kontaminan berbasis sulfur'],
      [/\bfilter bahan bakar\b/gi, 'filter kompartemen'],
      [/\bsistem bahan bakar\b/gi, 'sistem pelumasan'],
      [/\bbahan bakar\b/gi, 'oli/fluida'],
      [/\bfuel dilution\b/gi, 'pengenceran fluida'],
      // turbo → (hapus, tidak relevan)
      [/\bturbocharger\b/gi, 'komponen terkait'],
      [/\bturbo\b/gi, 'komponen'],
      // breather → breather kompartemen (sudah netral)
      [/\belemen air cleaner\b/gi, 'breather/vent kompartemen'],
      [/\bair cleaner\b/gi, 'breather kompartemen']
    ];

    function cleanEngineTerms(arr) {
      return (arr || []).map(function (txt) {
        var s = String(txt);
        engineReplacements.forEach(function (pair) {
          s = s.replace(pair[0], pair[1]);
        });
        // Bersihkan artefak: spasi ganda, koma ganda, kalimat kosong
        s = s.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',')
             .replace(/:\s*,\s*/g, ': ').replace(/,\s*\./g, '.')
             .replace(/\(\s*\)/g, '').replace(/\(\s*bila ada\s*\)/gi, '')
             .replace(/^\s*[,;.]\s*/, '').replace(/\s+([.,;])/g, '$1').trim();
        if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
        return s;
      }).filter(function (s) { return s && s.length > 3; });
    }

    if (!isEngine) {
      likely = cleanEngineTerms(likely);
      actions = cleanEngineTerms(actions);
      if (escalate) {
        var cleaned = cleanEngineTerms([escalate]);
        escalate = cleaned.length ? cleaned[0] : '';
      }
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
      // [STANDARISASI 2026-10-03] Label level 3 tingkat utk tampilan (Indonesia).
      // severe -> Critical, critical -> Caution, warn -> Caution (paling rendah).
      levelLabel: (level === 'severe' ? 'Critical' : 'Caution'),
      likely: likely,
      actions: actions,
      escalate: escalate,
      risk: risk,                                        // [RISIKO] estimasi dampak (level)
      impact: impactFor(paramKey, opts.component, isLow), // [DAMPAK] part/komponen spesifik (sadar batas atas/bawah viskositas)
      refs: refsForComponent(paramKey, opts.component, opts.model),  // [RUJUKAN] sadar-kompartemen & sadar-merek
      components: (data && data.refs) ? (isEngine ? data.refs.slice() : cleanEngineTerms(data.refs)) : [],  // komponen terkait
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
              title: 'Konsumsi top-up ' + b.component + ' (' + b.qty + ' L)',
              detail: 'Penambahan ' + b.qty + ' L pada ' + b.component + ' dalam ' + b.count + ' transaksi. ' +
                      'Periksa kebocoran atau konsumsi berlebih pada sirkuit ' + b.component + ' ' +
                      '(seal, sambungan, & titik kebocoran) secara terpisah.'
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
    particleCheckPhrase: particleCheckPhrase,
    filterRelevancePhrase: filterRelevancePhrase,
    isFilterless: isFilterless,
    brandManualName: brandManualName
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_KNOWLEDGE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

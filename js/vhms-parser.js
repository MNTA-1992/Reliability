/* =========================================================================
 * vhms-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk file CSV export VHMS Komatsu (format "Trend Analysis").
 *
 * STRUKTUR FILE (contoh trend0.CSV):
 *   [Common Header]
 *   Product Group,Excavator
 *   Machine Model,PC2000
 *   ...
 *   [Version Information]
 *   ...
 *   [Display Information]
 *   Data Type & Title,40,Trend Analysis
 *   Axis Type,4,100,2,2,...
 *   Axis Rate,10,1,1,...
 *   Status Of Item,0,0,0,...
 *
 *   [Data]
 *   <kolom header TANPA SEKsi>,         <- ini baris "Axis Item"
 *   <kolom satuan>,                     <- ini baris "Axis Scale"
 *   <baris data>...
 *
 * KARAKTERISTIK PENTING:
 *  - Baris data DIAWALI koma (kolom pertama kosong) -> nilai pertama = SMR.
 *  - Header kolom tidak diberi label "[Axis Item]"; ia baris pertama
 *    setelah "[Data]" yang mengandung banyak koma.
 *  - Banyak kolom punya sub-field tambahan (mis. Machine Type: "-8,STD").
 *    Karena itu PARSING SELALU BERBASIS NAMA HEADER, bukan indeks posisi.
 *  - Nilai sentinel (mis. -32768) berarti "tidak ada data" -> jadikan null.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  if (!cfg) {
    throw new Error('vhms-parser.js membutuhkan vhms-config.js dimuat lebih dulu.');
  }

  // [KONSOLIDASI 2026-10-04 · B-1] Util CSV bersama.
  var _csv = global.CSV_UTIL || {};

  /* -----------------------------------------------------------------------
   * Utilitas teks
   * --------------------------------------------------------------------- */

  /** Normalisasi nama header untuk pencocokan toleran. */
  function normKey(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s._\-/()]+/g, '')   // buang spasi, titik, underscore, dsb.
      .trim();
  }

  /**
   * Pisah satu baris CSV dengan dukungan tanda kutip ("...").
   * VHMS tidak pakai kutip, tapi kita amankan untuk fleksibilitas.
   */
  function splitCsvLine(line) {
    // [KONSOLIDASI 2026-10-04 · B-1] Delegasi ke CSV_UTIL.splitLine dengan
    // delimiter koma (VHMS tidak memakai kutip; tetap aman untuk fleksibilitas).
    if (_csv.splitLine) return _csv.splitLine(line, ',');
    var out = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuote = false; }
        } else { cur += ch; }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }

  /** Konversi string ke angka; kembalikan null jika bukan angka valid. */
  function toNumber(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '') return null;
    if (isSentinel(s)) return null;
    // buang pemisah ribuan bila ada (mis. "1,234" -> 1234 sudah terlanjur
    // terpecah oleh koma, jadi di sini cukup hilangkan spasi)
    s = s.replace(/\s+/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function isSentinel(s) {
    var list = cfg.NULL_SENTINELS || [];
    for (var i = 0; i < list.length; i++) {
      if (s === String(list[i])) return true;
    }
    return false;
  }

  /* [P2-1 2026-10-27] STATISTIK VALIDASI.
   * Insiden yang dijaga: saat `validRange` oksidasi dipasang [0,5] padahal
   * data nyata 3..58, **653 dari 690 nilai LENYAP TANPA PESAN**
   * (`sos-config.js:40-56`). Gerbang yang bisa menghapus data WAJIB
   * melaporkan berapa yang dihapus, kalau tidak kerusakan konfigurasi
   * tidak bisa dibedakan dari data yang memang buruk. */
  var VALIDATION_STATS = { droppedBelowMin: 0, droppedAboveMax: 0, byKey: {} };

  function resetValidationStats() {
    VALIDATION_STATS = { droppedBelowMin: 0, droppedAboveMax: 0, byKey: {} };
  }

  function getValidationStats() {
    var byKey = {};
    for (var k in VALIDATION_STATS.byKey) {
      if (Object.prototype.hasOwnProperty.call(VALIDATION_STATS.byKey, k)) {
        byKey[k] = VALIDATION_STATS.byKey[k];
      }
    }
    return {
      droppedBelowMin: VALIDATION_STATS.droppedBelowMin,
      droppedAboveMax: VALIDATION_STATS.droppedAboveMax,
      byKey: byKey
    };
  }

  function noteDropped(key, kind) {
    if (kind === 'aboveMax') VALIDATION_STATS.droppedAboveMax++;
    else VALIDATION_STATS.droppedBelowMin++;
    var e = VALIDATION_STATS.byKey[key] || (VALIDATION_STATS.byKey[key] = { belowMin: 0, aboveMax: 0 });
    if (kind === 'aboveMax') e.aboveMax++;
    else e.belowMin++;
  }

  /** Deteksi apakah sebuah baris punya pola seperti "[Section]". */
  function isSectionHeader(line) {
    return /^\s*\[.+\]\s*$/.test(line);
  }

  /* -----------------------------------------------------------------------
   * Pembacaan blok [Common Header]
   * --------------------------------------------------------------------- */
  function parseKeyValueBlocks(lines) {
    // Mengumpulkan pasangan key->value dari SEMUA blok sebelum [Data].
    // Contoh baris:  "Machine Model,PC2000"
    //                "Machine Serial No.,20046"
    var kv = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isSectionHeader(line)) continue;
      var parts = splitCsvLine(line);
      if (parts.length >= 2 && parts[0] !== '') {
        var key = parts[0];
        var val = parts.slice(1).filter(function (x) { return x !== ''; }).join(', ');
        if (!(key in kv)) kv[key] = val;
      }
    }
    return kv;
  }

  /* -----------------------------------------------------------------------
   * Inti: parse seluruh teks file
   * --------------------------------------------------------------------- */
  function parse(text) {
    // Disimpan untuk pembaca tabel bersama (`FUEL_PARSER.readKvTable`)
    // yang memakai teks UTUH — ia punya pemindai sendiri untuk [Data].
    var rawText = String(text == null ? '' : text);
    var rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');

    // 1) Temukan indeks bagian [Data]
    var dataStart = -1;
    for (var i = 0; i < rawLines.length; i++) {
      if (/^\s*\[Data\]\s*$/i.test(rawLines[i])) { dataStart = i; break; }
    }
    if (dataStart === -1) {
      throw new Error('Bagian [Data] tidak ditemukan. Pastikan ini file export VHMS (.CSV) yang benar.');
    }

    var headerLines = rawLines.slice(0, dataStart);
    var bodyLines = rawLines.slice(dataStart + 1);

    // 1b) [T1.1] Deteksi TIPE FILE dari baris "Data Type & Title" pada
    //     [Display Information]. Nilainya adalah angka tipe VHMS:
    //       '40' = Trend Analysis (perilaku lama),
    //       '10' = Fault History (fault0.CSV),
    //       '81' = T/M Trend (tm_trend0.CSV).
    //     Parser tetap MEMBACA file tipe 10 secara mekanis (dipakai untuk
    //     uji/inspeksi), tetapi modul fault khusus (VHMS_FAULT_PARSER)
    //     yang menafsirkan isinya.
    var dataTypeInfo = detectDataType(headerLines);

    /* ---------------------------------------------------------------------
     * [SHARED 2026-10-28] PEMBACA TABEL BERSAMA — implementasi TUNGGAL.
     * ---------------------------------------------------------------------
     * Sebelum ini `vhms-parser` dan `fuel-parser` masing-masing memecah baris
     * `,SMR,Calendar,...` dengan caranya sendiri. Dua pembaca untuk satu
     * format = dua peluang menyimpang (kelas bug yang sudah mahal di proyek
     * ini). Kini keduanya memakai `FUEL_PARSER.readKvTable`.
     *
     * Batas pembagian yang SENGAJA:
     *   BERSAMA   : pemecahan baris, offset kolom kosong pertama, `meta`,
     *               `items`, `Axis Rate`.
     *   TETAP RBM : semantik tipe file (`dataTypeOf`), `effParams`, override
     *               keluarga, fallback POSISIONAL, `parseRecord`.
     *
     * Bila modul Fuel tidak termuat (mis. konteks uji terpisah), jalur lama
     * di bawah TETAP dipakai — fitur RBM tidak boleh bergantung pada modul
     * Fuel yang bersifat opsional.
     * ------------------------------------------------------------------- */
    var shared = (global.FUEL_PARSER && global.FUEL_PARSER.readKvTable)
      ? global.FUEL_PARSER.readKvTable(rawText, {
          split: splitCsvLine,
          // VHMS memetakan per RECORD; `rates` & `types` per kolom tidak
          // dipakai lagi sesudah `parseRecord`, jadi tidak disimpan.
          keepRates: false,
          scaled: false
        })
      : null;

    // 2) Header blok identitas mesin
    var meta = (shared && shared.ok && shared.meta && Object.keys(shared.meta).length)
      ? shared.meta
      : parseKeyValueBlocks(headerLines);
    // Rapikan field yang umum dipakai
    var machine = {
      productGroup: meta['Product Group'] || '',
      model:        meta['Machine Model'] || '',
      serial:       meta['Machine Serial No.'] || '',
      engineModel:  meta['Engine Model & Serial No.1 2 3'] || meta['Engine Model  Serial No.1 2 3'] || '',
      timeStamp:    meta['Time Stamp'] || '',
      smrStart:     toNumber(meta['SMR']),
      comment:      meta['Comment'] || '',
      raw:          meta
    };

    // Ambil vendor/program version bila ada
    machine.formatVer  = meta['Format Ver.'] || '';
    machine.programVer = (meta['Program Ver.'] || '').split(',')[0] || '';

    // [REVISI] Deteksi keluarga produk lebih awal agar PEMETAAN KOLOM bisa
    // berbeda per keluarga (mis. nama kolom tekanan oli HD vs PC).
    var familyId = 'UNKNOWN';
    if (global.VHMS_PROFILES && global.VHMS_PROFILES.detectFamily) {
      try { familyId = global.VHMS_PROFILES.detectFamily(machine); } catch (e) { familyId = 'UNKNOWN'; }
    }
    // Peta parameter EFEKTIF untuk keluarga ini (PARAMS + override keluarga).
    // [HD465 2026-10-27] NAMA MODEL ikut dikirim: sebagian override hanya
    // berlaku untuk model tertentu (mis. skala blowby HD465 yang mmAq,
    // berbeda dari HD785 yang pascal). Tanpa `machine.model`, override itu
    // sengaja dilewati dan model tersebut memakai skala dasar.
    var effParams = (cfg.paramsForFamily)
      ? cfg.paramsForFamily(familyId, machine.model)
      : cfg.PARAMS;

    // 3) Cari definisi kolom. Header VHMS (baris "Axis Item") dan satuan
    //    ("Axis Scale") bisa berada DI BLOK ATAS (di dalam [Display
    //    Information]) maupun sebagai baris pertama di dalam [Data],
    //    tergantung versi exporter. Kita cari keduanya.
    var colDef = findColumnDefinition(headerLines, bodyLines, dataTypeInfo.type);

    // Bangun indeks nama -> posisi (normalized).
    function buildIndex(names) {
      var idx = {};
      for (var c = 0; c < names.length; c++) {
        var nm = names[c];
        if (nm === '') continue;
        idx[normKey(nm)] = c;
      }
      return idx;
    }

    // [SHARED 2026-10-28] Skala pembagi per kolom.
    //  - Jalur bersama : `shared.scalesMap` (nama kolom -> Axis Rate)
    //  - Jalur lama    : `colDef.scales` (array posisi)
    // Peta nama diterjemahkan ke urutan `names` yang sedang dipakai
    // (`parseRows` memanggilnya di setiap kandidat pemetaan kolom).
    //
    // CATATAN PENTING: `scalesFor` adalah CADANGAN, bukan pengganti.
    // `parseRecord` tetap memakai `def.scale` dari `cfg.PARAMS` sebagai
    // sumber utama (perilaku lama TIDAK berubah).
    function scalesFor(names, fallbackScales) {
      if (!(shared && shared.ok && shared.scalesMap)) return fallbackScales;
      return names.map(function (nm) {
        var v = shared.scalesMap[nm];
        return (v == null) ? 1 : v;
      });
    }

    // Titik awal baris data.
    //   - Jalur bersama : 0 — nama kolom sudah diambil dari SELURUH teks;
    //     baris header di dalam [Data] dilewati regex di bawah.
    //   - Jalur lama    : tepat sesudah baris "Axis Item" di dalam [Data].
    // Salah titik awal -> baris data dilewati senyap dan SEMUA parameter
    // menjadi null meski berkasnya sehat.
    var dataFrom = (shared && shared.ok) ? 0 : colDef.bodyDataStart;

    // Loop parse yang sama, dipakai berulang untuk kandidat pemetaan kolom.
    function parseRows(names, units, colIndex, scales) {
      var out = [];
      for (var k = dataFrom; k < bodyLines.length; k++) {
        var raw = bodyLines[k];
        if (raw === undefined || raw.trim() === '') continue;
        // Lewati baris definisi kolom ("Axis Item/Sale") dan blok lain
        if (/^\s*(Axis (Item|Scale)|Column (Item|Scale)|Status Of Item|View Item)/i.test(raw)) continue;
        var cells = splitCsvLine(raw);
        var offset = (cells.length > 0 && cells[0] === '') ? 1 : 0;
        if (cells.length - offset < 3) continue;
        // [T1.3] Baris data harus diawali angka pada kolom SMR — KECUALI pada
        // Fault History (dataType '10'), di mana sel pertama setelah offset
        // adalah KODE ALFANUMERIK fault (mis. "DHE5KB"), bukan angka.
        // [HD785] Matriks clutch ('DA'/'D9') juga diawali LABEL baris
        // ("Low","1st",...), bukan angka — perlakukan seperti fault.
        if (isFaultType(dataTypeInfo.type) || isMatrixType(dataTypeInfo.type)) {
          if (!cells[offset] || cells[offset] === '') continue;
        } else if (toNumber(cells[offset]) === null) {
          continue;
        }
        var rec = parseRecord(cells, offset, names, colIndex, units, effParams,
          scalesFor(names, scales));
        if (rec) out.push(rec);
      }
      return out;
    }

    // 4) Kandidat pertama: pakai header apa adanya (bila ada)
    //
    // [SHARED 2026-10-28] `columnNames` diambil dari pembaca BERSAMA bila
    // tersedia, dan `parseRows` memasukkan `scale` per kolom dari
    // `colDef.scales` (jalur lama) ATAU dari `shared.scalesMap` (jalur
    // bersama). Satuan tetap berasal dari `colDef.units` seperti sebelumnya.
    // [SHARED 2026-10-28] KESESUAIAN INDEKS — sumber bug yang sudah tampak:
    //   jalur LAMA      : `colDef.names` punya PLACEHOLDER kosong di depan
    //                     ('', 'SMR', 'Calendar', ...), dan `parseRecord`
    //                     memakai `cells[idx]` TANPA memotong offset.
    //   jalur BERSAMA   : `shared.items` = ['SMR','Calendar',...] — tanpa
    //                     placeholder. Memasangnya apa adanya membuat SEMUA
    //                     nilai bergeser satu kolom (blowby membaca Eng.Speed).
    // Karena itu placeholder kosong DIPASANG ULANG di sini, sehingga bentuk
    // `columnNames` selalu identik dengan jalur lama.
    var columnNames = (shared && shared.ok && shared.items.length)
      ? [''].concat(shared.items)
      : colDef.names.slice();
    var unitRow = colDef.units.slice();
    var colIndex = buildIndex(columnNames);
    var usedFallback = false;
    var records = parseRows(columnNames, unitRow, colIndex, colDef.scales);
    if (shared && shared.ok && records.length !== shared.rows.length) {
      // Diagnosa jujur: bila jumlah record berbeda dari jumlah baris yang
      // dihitung pembaca bersama, beri jejak — jangan diam.
      (meta.__diag || (meta.__diag = [])).push(
        'record=' + records.length + ' baris=' + shared.rows.length);
    }

    // 5) Fallback berbasis POSISI bila header tidak ada / parameter inti kosong.
    //    (Beberapa exporter hanya menulis [Data] tanpa baris nama kolom.)
    //    [T1.3] JANGAN jalankan fallback untuk Fault History ('10'): tabelnya
    //    sama sekali berbeda (kode fault, bukan SMR) sehingga pemetaan posisi
    //    trend akan salah total.
    //    [T5 2026-10-08] JANGAN jalankan fallback untuk T/M Trend ('81'):
    //    `hasCoreParams()` menguji parameter inti TREND MESIN (blowbyMax,
    //    hydTempMax, dst) yang memang TIDAK ADA di file T/M Trend, sehingga
    //    fallback selalu terpicu dan menimpa kolom T/M yang sudah benar
    //    dengan daftar kolom trend mesin -> seluruh 8 parameter T/M jadi null.
    //    [HD785 2026-10-09] JANGAN jalankan fallback untuk Chassis Trend
    //    ('86') maupun matriks clutch ('DA'/'D9') dengan alasan yang sama:
    //    `hasCoreParams()` menguji parameter trend MESIN yang tidak ada di
    //    berkas tersebut, sehingga fallback akan menimpa kolom yang sudah
    //    benar dengan daftar kolom trend mesin.
    //    [PC2000 2026-10-10 — T1] GANTI DAFTAR-NEGATIF MENJADI DAFTAR-POSITIF.
    //    Daftar-negatif di atas sudah GAGAL TIGA KALI: '10', '81', lalu '86'
    //    masing-masing ditambal SETELAH bug-nya terbukti. Setiap tipe baru
    //    Komatsu (mis. '30' Load Map, '60' Snap-shot, '90' Op. Availability)
    //    otomatis mengulang bug yang sama: baris-nya diawali LABEL/epoch
    //    (bukan SMR), `hasCoreParams()` gagal, lalu `buildFallbackColumns()`
    //    memetakan kolom BERDASARKAN POSISI memakai daftar 54-kolom Trend
    //    Analysis PC2000 -> nilai frekuensi load map masuk ke `blowbyMax`,
    //    `coolantTemp`, `oilPressHMin`, dst., lalu dinilai & merusak ranking
    //    armada secara SENYAP. Terbukti pada `loadm0.CSV` SN 20020.
    //
    //    Sekarang: fallback HANYA boleh jalan untuk Trend Analysis ('40') dan
    //    untuk berkas TANPA baris "Data Type & Title" (eksport lama). Tipe
    //    apa pun selain itu dianggap punya struktur sendiri dan ditafsirkan
    //    modul khusus.
    var skipFallback = !isFallbackEligibleType(dataTypeInfo.type);
    if (!skipFallback &&
        (records.length === 0 || Object.keys(colIndex).length === 0 || !hasCoreParams(records))) {
      var fb = buildFallbackColumns(meta);
      columnNames = fb.names;
      unitRow = fb.units;
      colIndex = buildIndex(columnNames);
      usedFallback = true;
      var fallbackRecords = parseRows(columnNames, unitRow, colIndex);
      // Pakai hasil fallback hanya bila lebih baik
      if (fallbackRecords.length > 0) records = fallbackRecords;
    }

    // [PC2000 2026-10-10 — T1 lanjutan] GERBANG KEWAJARAN SMR.
    // ---------------------------------------------------------------------
    // Setelah fallback dimatikan, `parseRows()` masih menerima baris yang
    // diawali ANGKA tetapi BUKAN jam SMR:
    //   - `loadm0.CSV`    baris diawali LABEL ("0 - 10") -> toNumber() = -10
    //   - `snap00.CSV`    kolom pertama = waktu relatif ms (-140000..+120000)
    //                     -> toNumber() * SMR_SCALE(0.1) = 12000 "jam"
    //   - `loadmop0.CSV`  label "- 2000" -> -2000
    // Baris-baris ini BUKAN seri waktu SMR dan tidak boleh masuk `records`:
    // nilai 12000 h dari sumbu waktu snapshot akan terlihat seperti record
    // trend yang SAH dan meracuni analitik/ranking.
    //
    // Karena itu JANGAN hanya mengandalkan VHMS_VALIDATE (yang membuang SMR
    // NULL/<=0 saja). Tipe non-trend harus BENAR-BENAR menghasilkan NOL
    // record di sini, sehingga gerbang `records.length === 0` di bawah
    // melempar error yang jelas DAN mengembalikan `_rawText` (dipakai
    // modul khusus lewat blok `catch` di controller).
    var isMachineTrend = isFallbackEligibleType(dataTypeInfo.type);
    if (!isMachineTrend && records.length > 0) {
      // (a) Hanya buang record yang SMR-nya TERBUKTI tidak wajar (negatif/0).
      //     Record dengan SMR wajar DIPERTAHANKAN: Chassis Trend ('86')
      //     memang punya kolom SMR yang SAH dan dipakai jalur analitik biasa
      //     — membuangnya akan merusak fitur HD785 yang sudah berjalan.
      records = records.filter(function (r) {
        return r.smr !== null && r.smr !== undefined && !isNaN(r.smr) && r.smr > 0;
      });
      // (b) Sumbu pertama BUKAN SMR -> seluruh baris adalah artefak.
      //     Snapshot ('60'/'61') memakai "Time" (ms relatif terhadap pemicu,
      //     -140000..+120000). Semua nilainya POSITIF setelah dikali
      //     SMR_SCALE, sehingga filter (a) tidak dapat menangkapnya dan 120
      //     "record" palsu dengan SMR 2000-12000 h akan lolos ke armada.
      //     Deteksi lewat NAMA kolom sumbu pertama: parser sudah membacanya
      //     apa adanya di `colDef.names[1]` (indeks 1 karena kolom 0 kosong).
      var axis0 = String((colDef.names && colDef.names[1]) || '').trim();
      if (axis0 && axis0.toUpperCase() !== 'SMR') {
        records = [];
      }
    }

    // [HD785 2026-10-09] Matriks clutch ('DA'/'D9') tidak punya record trend;
    // nilainya ditafsirkan modul lain. Melempar error di sini akan membuat
    // berkas yang SAH ditolak saat upload, jadi pengecualian ini WAJIB.
    //
    // [PC2000 2026-10-10 — T1] PERLUASAN yang sama untuk SEMUA tipe
    // non-trend. Sejak fallback dibatasi ke '40'/'' saja, tipe lain
    // (mis. '10' Fault History, '60' Snap-shot, '30' Load Map) memang
    // sengaja menghasilkan NOL record di sini. Melempar error akan:
    //   1. kehilangan `_rawText` — padahal controller MEMAKAINYA untuk
    //      meneruskan teks mentah ke VHMS_FAULT_PARSER/modul khusus
    //      (jalur dua tahap upload `fault0.CSV`, dijaga test suite);
    //   2. menampilkan "Gagal memuat" pada berkas yang sebenarnya SAH.
    // Jadi: throw HANYA bila berkas memang mengaku sebagai trend mesin.
    //
    // [FIX 2026-10-13] BUG LOGIKA `else if` — berkas MATRIKS ('DA'/'D9')
    // SELALU ditolak. Rantai lama:
    //     if  (0 record && !trend && !matrix) { /* aman */ }
    //     else if (0 record)                   { throw  }
    // Untuk 'DA': (0 && !trend && !matrix) = false (matrix=true), sehingga
    // jatuh ke `else if` dan DILEMPAR — padahal komentar di atasnya menyatakan
    // pengecualian matriks WAJIB agar berkas sah tidak ditolak. Akibatnya
    // clutch_slip.CSV & clutch_therm.CSV selalu gagal dengan pesan
    // "Tidak ada baris data valid" (laporan pengguna, dikonfirmasi ulang
    // lewat reproduksi). Kondisi throw kini ditulis POSITIF & eksplisit:
    // throw HANYA bila tipe ini memang seharusnya punya record trend.
    if (records.length === 0 && isMachineTrend) {
      throw new Error('Tidak ada baris data valid yang bisa dibaca dari bagian [Data]. ' +
        'Pastikan file export VHMS (.CSV) yang benar.');
    } else if (records.length === 0) {
      // Tipe non-trend ('10', '30', '60', '90', 'DA', 'D9', ...) -> BUKAN
      // error. Berkasnya SAH; isinya ditafsirkan modul khusus lewat
      // `_rawText`. Melempar di sini akan menghilangkan `_rawText` dan
      // memutus jalur dua tahap upload (fault/clutch/loadmap/snapshot).
    }

    /* -----------------------------------------------------------------------
     * [B-5 2026-10-13] PENANDA SUMBER PER RECORD.
     * ---------------------------------------------------------------------
     * Satu unit dapat menerima record dari BEBERAPA jenis berkas VHMS
     * (mis. HD785: Chassis Trend '86' + T/M Trend '81'). Setelah digabung
     * di `VHMS_FLEET.add()`, asal-usul tiap baris HILANG — tidak ada cara
     * membedakan baris "16 parameter mesin" dari baris "37 parameter T/M".
     * Akibatnya tabel log menampilkan keduanya berdampingan sehingga
     * sebagian besar sel tampak "—" (laporan pengguna: kolom Clutch kosong).
     *
     * Penanda ini TIDAK diawali garis bawah ganda dan sengaja ringkas agar
     * aman diserialisasi ke sessionStorage bersama record lain.
     * --------------------------------------------------------------------- */
    var _srcType = dataTypeInfo.type || '';
    var _srcTitle = dataTypeInfo.title || '';
    for (var si = 0; si < records.length; si++) {
      if (records[si] && records[si]._src === undefined) {
        records[si]._src = _srcType;
        records[si]._srcTitle = _srcTitle;
      }
    }

    // Urutkan naik berdasarkan SMR bila SMR tersedia.
    // [FIX B2 2026-09-30] Comparator harus TRANSITIF & konsisten: record tanpa
    // SMR diletakkan di akhir (bukan `return 0` yang membuat urutan tak stabil
    // saat banyak SMR null dan bisa mengacaukan sort library).
    records.sort(function (a, b) {
      var as = (a.smr === null || a.smr === undefined || isNaN(a.smr)) ? null : a.smr;
      var bs = (b.smr === null || b.smr === undefined || isNaN(b.smr)) ? null : b.smr;
      if (as === null && bs === null) return 0;
      if (as === null) return 1;    // a tanpa SMR -> ke bawah
      if (bs === null) return -1;   // b tanpa SMR -> ke bawah
      return as - bs;
    });

    return {
      meta: machine,
      familyId: familyId,
      // [T1.1] Tipe & judul file VHMS ('40' tren, '10' fault, '81' T/M trend)
      dataType: dataTypeInfo.type,
      dataTitle: dataTypeInfo.title,
      // [FIX 2026-10-08] Teks mentah dipertahankan agar pemanggil dapat
      // meneruskannya ke parser khusus setelah tipe file diketahui — mis.
      // Fault History ('10') yang WAJIB ditafsirkan VHMS_FAULT_PARSER.
      // Tanpa ini, upload fault0.CSV lewat file picker gagal: pemanggil
      // mengirim string kosong ke parseFault().
      _rawText: String(text),
      columns: columnNames,
      units: unitRow,
      usedFallback: usedFallback,
      records: records
    };
  }

  /* -----------------------------------------------------------------------
   * [T1.1] Deteksi tipe file dari baris "Data Type & Title".
   * ---------------------------------------------------------------------
   * Format baris:  Data Type & Title,10,Fault History
   * Mengembalikan { type: '40'|'10'|'81'|'', title: string }.
   * Bila baris tidak ada (file lama/varian), `type` dikosongkan dan seluruh
   * perilaku parser kembali ke asumsi lama ('40' = trend).
   * --------------------------------------------------------------------- */
  function detectDataType(headerLines) {
    for (var i = 0; i < headerLines.length; i++) {
      var m = /^\s*Data Type\s*&\s*Title\s*,(.*)$/i.exec(headerLines[i]);
      if (!m) continue;
      var parts = splitCsvLine(m[1]);
      var type = (parts[0] || '').trim();
      var title = (parts[1] || '').trim();
      return { type: type, title: title };
    }
    return { type: '', title: '' };
  }

  /** Apakah tipe file ini Fault History ('10')? */
  function isFaultType(type) {
    return String(type || '').trim() === '10';
  }

  /* -----------------------------------------------------------------------
   * [HD785 2026-10-09] TIPE MATRIKS (histogram), bukan seri waktu.
   * ---------------------------------------------------------------------
   *   'DA' = Clutch slip time(TM)      -> clutch_slip.CSV
   *   'D9' = Clutch thermal load(TM)   -> clutch_therm.CSV
   *
   * Strukturnya BUKAN (SMR, Calendar, nilai...) melainkan tabel silang:
   * baris = posisi clutch (Low/High/Rev/1st..4th), kolom = AREA pada sumbu-X
   * 0..6. Jadi parser trend TIDAK boleh memaksa baris data diawali angka
   * SMR, dan TIDAK boleh melempar error ketika `records` kosong — tugas
   * penafsiran ada pada VHMS_CLUTCH.parseClutchMatrix().
   *
   * Fungsi `parse()` tetap dipakai sebagai PINTU DETEKSI: ia mengembalikan
   * `dataType` + `_rawText` sehingga pemanggil dapat merutekan file ke
   * modul yang tepat tanpa membaca ulang berkas.
   * --------------------------------------------------------------------- */
  function isMatrixType(type) {
    var t = String(type || '').trim().toUpperCase();
    return t === 'DA' || t === 'D9';
  }

  /* -----------------------------------------------------------------------
   * [PC2000 2026-10-10 — T1] APAKAH TIPE INI BOLEH MEMAKAI FALLBACK POSISIONAL?
   * ---------------------------------------------------------------------
   * `buildFallbackColumns()` adalah pemetaan POSISI untuk Trend Analysis
   * (54 kolom tetap). Hanya berkas yang BENAR-BENAR trend mesin yang boleh
   * memakainya.
   *
   *   '40'  = Trend Analysis         -> BOLEH (satu-satunya).
   *   ''    = tanpa baris Data Type  -> BOLEH (varian/eksport lama, asumsi
   *                                     historis parser; jangan diubah agar
   *                                     tidak ada regresi).
   *   lain  = punya struktur sendiri -> TIDAK BOLEH.
   *
   * Daftar tipe yang DIKETAHUI (untuk pesan/diagnosa; bukan syarat lolos —
   * apa pun selain '40'/'' tetap ditolak, sehingga tipe baru aman secara
   * default):
   *   '10' Fault History, '30' Load Map, '31' Temporary Load Map,
   *   '60'/'61' Snap-shot, '7E'/'7F' Operating/Work Load Map,
   *   '81' T/M Trend, '86' Chassis Trend, '90' Operating Availability,
   *   'DA'/'D9' matriks clutch.
   * --------------------------------------------------------------------- */
  function isFallbackEligibleType(type) {
    var t = String(type || '').trim();
    return t === '' || t === '40';
  }

  /* -----------------------------------------------------------------------
   * Lokasi definisi kolom (header + satuan)
   * --------------------------------------------------------------------- */
  /* -----------------------------------------------------------------------
   * Lokasi definisi kolom (header + satuan)
   * ---------------------------------------------------------------------
   * [T1.2] Header kolom bisa berlabel "Axis Item"/"Axis Scale" (trend)
   * ATAU "Column Item"/"Column Scale" (fault history). Satu regex alias
   * dipakai untuk keduanya — bukan fungsi duplikat.
   * --------------------------------------------------------------------- */
  function findColumnDefinition(headerLines, bodyLines, dataType) {
    var names = null, units = [], bodyDataStart = 0;
    var HDR_LABEL  = /^\s*(?:Axis|Column)\s+Item\s*(,|$)/i;
    var UNIT_LABEL = /^\s*(?:Axis|Column)\s+Scale\s*(,|$)/i;
    var HDR_EXACT  = /^(?:Axis|Column) Item$/i;
    var UNIT_EXACT = /^(?:Axis|Column) Scale$/i;
    // Baris data diawali LABEL (bukan angka SMR) pada fault history dan
    // matriks clutch — keduanya butuh deteksi "sel pertama terisi".
    var fault = isFaultType(dataType) || isMatrixType(dataType);

    // a) Cari di blok atas: baris yang diawali "Axis Item," / "Column Item,"
    for (var i = 0; i < headerLines.length; i++) {
      if (HDR_LABEL.test(headerLines[i])) {
        var parts = splitCsvLine(headerLines[i]);
        // Buang label "Axis Item"/"Column Item" di depan; sisanya nama kolom
        // PENTING: baris DATA selalu diawali koma (kolom pertama kosong),
        // sehingga SMR berada di indeks 1 pada baris data, tetapi indeks 0
        // pada header setelah label dibuang. Kita pad dengan sel kosong
        // di depan agar penomoran kolom header SEJAJAR dengan baris data.
        if (parts.length > 0 && HDR_EXACT.test(parts[0].trim())) {
          parts = [''].concat(parts.slice(1));
        }
        names = parts;
        // Baris setelahnya biasanya "Axis Scale"/"Column Scale" -> satuan
        if (headerLines[i + 1] && UNIT_LABEL.test(headerLines[i + 1])) {
          var u = splitCsvLine(headerLines[i + 1]);
          if (u.length > 0 && UNIT_EXACT.test(u[0].trim())) u = [''].concat(u.slice(1));
          units = u;
        }
        break;
      }
    }

    if (names && names.length) {
      // Header ada di blok atas -> seluruh bodyLines adalah data
      return { names: names, units: units, bodyDataStart: 0 };
    }

    // b) Cari di dalam bodyLines: baris pertama non-kosong yang mengandung
    //    >=3 kolom dan bukan baris data.
    for (var j = 0; j < bodyLines.length; j++) {
      var line = bodyLines[j];
      if (line === undefined || line.trim() === '') continue;
      var cells = splitCsvLine(line);
      if (cells.length < 3) continue;
      // Baris data VHMS diawali koma (kolom 0 kosong) dan kolom 1 = angka SMR.
      // [T1.3] Pada fault, kolom 1 = KODE fault (bukan angka) -> deteksi baris
      // data cukup dari "sel pertama terisi dan bukan baris label kolom".
      var dataOffset = (cells[0] === '') ? 1 : 0;
      var isData = fault
        ? (!!cells[dataOffset] && !HDR_LABEL.test(line) && !UNIT_LABEL.test(line))
        : (toNumber(cells[dataOffset]) !== null);
      if (!isData) {
        var hdr = cells;
        if (hdr.length && hdr[0] === '') hdr = hdr.slice(1);
        names = hdr;
        if (bodyLines[j + 1] !== undefined) {
          var us = splitCsvLine(bodyLines[j + 1]);
          if (us.length && us[0] === '') us = us.slice(1);
          units = us;
          return { names: names, units: units, bodyDataStart: j + 2 };
        }
        return { names: names, units: units, bodyDataStart: j + 1 };
      }
      break; // ketemu baris data lebih dulu -> tidak ada header eksplisit
    }

    // c) Tidak ada header eksplisit
    return { names: [], units: [], bodyDataStart: 0 };
  }

  /**
   * Pemetaan kolom berbasis POSISI (fallback).
   * Menggunakan baris "Axis Item" standar VHMS Trend Analysis PC2000.
   * Referensi: struktur umum export Trend Analysis.
   */
  function buildFallbackColumns(meta) {
    // Coba ambil Axis Type untuk memvalidasi jumlah kolom
    var names = [
      '', // kolom 0 kosong (penanda; SMR ada di indeks 1)
      'SMR', 'Calendar',
      'Eng.Speed(Max)', 'Eng.Speed(Ave)', 'BlowbyPress Max',
      'LBF Exh.TempMax', 'LBR Exh.TempMax', 'RBF Exh.TempMax', 'RBR Exh.TempMax',
      'Boost Press Max', 'EOil Pre.MAX', 'E.Oil P.L_Min', 'E.Oil P.H_Min',
      'Eng.Oil Tmp.MAX', 'Cool Temp.MAX', 'Cool Temp.Min', 'Fuel Rate',
      'Ambient TempMax', 'Ambient TempAve', 'Ambient TempMin', 'Atomos. Pres.Ave',
      'Pump 1F P.Max', 'Pump 1R P.Max', 'Pump 2F P.Max', 'Pump 2R P.Max',
      'FanPumpF P.Max', 'FanPumpR P.Max',
      'HydOilTempMax', 'HydOilTempAve', 'HydOilTempMin',
      'PTO Temp Max', 'PTO Temp Min',
      'Truck Counter1', 'Truck Counter2',
      'Load1F', 'Load1R', 'Load2F', 'Load2R', 'LoadFF', 'LoadFR',
      'Load Count', 'Swing Count', 'Auto GRS P.Max', 'Auto GRS P. ON',
      'Pump1 Torque Max', 'Pump1 Torque Ave', 'Pump2 Torque Max', 'Pump2 Torque Ave',
      'FanPumpTorque Max', 'FanPumpTorque Ave',
      'Engine Power Max', 'Engine Power Ave', 'Eco Mode on'
    ];
    var units = [
      '', 'h', '',
      'rpm', 'rpm', 'kPa',
      'degC', 'degC', 'degC', 'degC',
      'kPa', 'MPa', 'MPa', 'MPa',
      'degC', 'degC', 'degC', 'Liter/h',
      'degC', 'degC', 'degC', 'hPa',
      'MPa', 'MPa', 'MPa', 'MPa',
      'MPa', 'MPa',
      'degC', 'degC', 'degC',
      'degC', 'degC',
      'Times', 'Times',
      '10^8Times', '10^8Times', '10^8Times', '10^8Times', '10^6Times', '10^6Times',
      'Times', 'Times', 'MPa', 'Times',
      'Nm', 'Nm', 'Nm', 'Nm',
      'Nm', 'Nm',
      'kW', 'kW', 'sec'
    ];
    return { names: names, units: units };
  }

  /** Cek apakah parameter inti berhasil terisi (bukan semua null). */
  function hasCoreParams(records) {
    var cores = ['blowbyMax', 'hydTempMax', 'coolantTemp', 'fuelRate', 'engSpeedAve'];
    for (var i = 0; i < records.length; i++) {
      var n = 0;
      for (var j = 0; j < cores.length; j++) {
        if (records[i][cores[j]] !== null) n++;
      }
      if (n >= 2) return true;
    }
    return false;
  }

  /**
   * [B-3 2026-10-13] Buang nilai tengah (Ave) bila KEDUA ujung (Max & Min)
   * sudah gugur sebagai sentinel — ketiganya berasal dari sensor yang sama,
   * jadi angka tengah yang tersisa tidak dapat dipercaya. Dipakai agar tidak
   * perlu men-sentinel nilai yang SAH di tempat lain (mis. 0 °C).
   * @param {object} rec
   * @param {string} maxKey
   * @param {string} aveKey
   * @param {string} minKey
   */
  function _voidIncoherent(rec, maxKey, aveKey, minKey) {
    var hasMax = rec[maxKey] !== null && rec[maxKey] !== undefined;
    var hasMin = rec[minKey] !== null && rec[minKey] !== undefined;
    if (!hasMax && !hasMin && rec[aveKey] !== undefined) rec[aveKey] = null;
  }

  /* -----------------------------------------------------------------------
   * Konversi satu baris data mentah -> record terstruktur
   * --------------------------------------------------------------------- */
  function parseRecord(cells, offset, columnNames, colIndex, unitRow, effParams, unitScales) {
    var P = effParams || cfg.PARAMS;
    // [SHARED 2026-10-28] `unitScales` = Axis Rate per POSISI kolom, dari
    // pembaca tabel bersama. Diterima agar satu parser dipakai kedua jalur;
    // SUMBER SKALA untuk parameter RBM tetap `def.scale` (tidak berubah).

    // Fungsi ambil nilai berdasarkan nama header (fuzzy/normalized).
    // [REVISI] Coba SEMUA nama alternatif (csvHeader + aliases) parameter.
    function resolveIndex(def) {
      var names = (cfg.paramHeaders) ? cfg.paramHeaders(def) : [def.csvHeader];
      for (var n = 0; n < names.length; n++) {
        var idx = colIndex[normKey(names[n])];
        if (idx !== undefined) return idx;
      }
      return undefined;
    }

    var rec = {};

    // SMR = umumnya kolom pertama data (setelah offset).
    // Terapkan SMR_SCALE bila CSV menyimpan SMR dalam satuan 0.1 jam.
    rec.smr = toNumber(cells[offset]);
    if (rec.smr !== null && cfg.SMR_SCALE) rec.smr = rec.smr * cfg.SMR_SCALE;

    // Calendar: kolom kedua data biasanya timestamp unix
    var calRaw = cells[offset + 1];
    rec.calendarRaw = calRaw || null;
    rec.calendar = decodeCalendar(calRaw);

    // Iterasi seluruh parameter yang terkonfigurasi (efektif per keluarga)
    for (var key in P) {
      if (!Object.prototype.hasOwnProperty.call(P, key)) continue;
      if (key === 'smr' || key === 'calendar') continue;
      var def = P[key];
      var idx2 = resolveIndex(def);
      var raw = (idx2 === undefined) ? null : cells[idx2];
      var val = toNumber(raw);
      // [B-3 2026-10-13] Sentinel KHUSUS parameter. Diuji pada nilai MENTAH
      // (sebelum `scale`) karena sentinel ditulis ECM dalam satuan terkecil.
      if (val !== null && def.nullValues) {
        for (var nv = 0; nv < def.nullValues.length; nv++) {
          if (val === def.nullValues[nv]) { val = null; break; }
        }
      }
      // [FITUR 2026-10-16] Batas bawah FISIK per parameter (`minValid`).
      // Dipakai untuk besaran yang TIDAK MUNGKIN bernilai <= batas pada mesin
      // hidup — terutama suhu EGT absolut: ECM menulis sentinel negatif
      // (mis. -40 / -32768) saat SINYAL SENSOR RUSAK. Nilai seperti itu
      // dibuang agar tidak pernah terbaca sebagai suhu sungguhan (dan agar
      // panel "Top End Wear" tidak menampilkan garis turun ke negatif).
      //
      // [FIX 2026-10-26] Kini juga dipakai untuk NOL pada besaran TEKANAN.
      // Sensor/kode yang tidak terbaca ditulis ECM sebagai 0, dan pada mesin
      // hidup (audit: rata-rata 1.430 rpm) tekanan 0 MPa mustahil. Tanpa
      // gerbang ini, mode 'low' memberi severity MAKSIMUM pada parameter
      // berbobot terbesar — satu sensor mati mengangkat unit ke peringkat 1.
      // Lihat catatan panjang di `vhms-config.js` pada `oilPressHMin`.
      //
      // Diuji pada nilai MENTAH (sebelum `scale`) supaya batas dinyatakan
      // dalam satuan terkecil berkas — °C untuk suhu, 0,01/0,1 MPa untuk
      // tekanan. Karena itu nilai `minValid` HARUS dibaca bersama `scale`
      // parameter yang bersangkutan.
      if (val !== null && def.minValid !== undefined && val < def.minValid) {
        val = null;
        noteDropped(key, 'belowMin');
      }
      // [P2-1 2026-10-27] Batas ATAS FISIK per parameter (`maxValid`).
      // Sebelumnya HANYA ada batas bawah, sehingga pembacaan mustahil
      // (mis. boost 32.000 kPa karena thermopile/ADC rusak) lolos utuh ke
      // formula, chart, dan korelasi.
      //
      // ⚠ `maxValid` BUKAN ambang alarm — ia pagar FISIK yang dipasang
      //   JAUH di atas maksimum yang pernah TERUKUR. Hanya dipasang pada
      //   parameter yang sebarannya benar-benar diaudit (lihat MAXV-2):
      //   memasang batas dari perasaan = mengulang insiden oksidasi SOS
      //   (653/690 nilai hilang senyap). Diuji pada nilai MENTAH
      //   (sebelum `scale`), sama seperti `minValid`.
      if (val !== null && def.maxValid !== undefined && val > def.maxValid) {
        val = null;
        noteDropped(key, 'aboveMax');
      }
      // Terapkan faktor skala bila kolom disimpan dalam satuan terkecil
      if (val !== null && def.scale) val = val * def.scale;
      rec[key] = val;
    }

    // [B-3 2026-10-13] GERBANG KOHERENSI trio Max/Ave/Min.
    // Bila Max & Min sudah gugur sebagai sentinel, nilai Ave yang tersisa
    // TIDAK dapat dipercaya — ia berasal dari sensor yang sama. Menampilkan
    // "Ambient Ave 0,0 °C" sementara Max & Min kosong akan dibaca sebagai
    // pengukuran sungguhan. Dibuang BERDASARKAN KOHERENSI, bukan dengan
    // men-sentinel angka 0 secara global (0 °C sah di tempat lain).
    _voidIncoherent(rec, 'ambientMax', 'ambientAve', 'ambientMin');

    // [BOOST LOW FALLBACK] Bila kolom Boost Press Min tidak ada di CSV, gunakan nilai boostMax
    // agar batas bawah (underboost / defisit pasokan udara) tetap dinilai dari puncak boost terukur.
    if ((rec.boostLow === null || rec.boostLow === undefined) && rec.boostMax !== null && rec.boostMax !== undefined) {
      rec.boostLow = rec.boostMax;
    }

    // Simpan semua kolom mentah (untuk tabel "semua parameter"/debug)
    rec.raw = {};
    for (var i = 0; i < columnNames.length; i++) {
      var name = columnNames[i];
      if (!name) continue;
      rec.raw[name] = cells[i] !== undefined ? cells[i] : null;
    }

    // [POIN 3] Simpan satuan yang sudah dinormalisasi per parameter,
    // diambil dari baris "Axis Scale" bila tersedia. Dipakai untuk
    // menstandardisasi label/legend/axis chart sesuai konvensi Komatsu.
    rec._units = {};
    if (unitRow && unitRow.length) {
      for (var k2 in P) {
        if (!Object.prototype.hasOwnProperty.call(P, k2)) continue;
        if (k2 === 'smr' || k2 === 'calendar') continue;
        var def2 = P[k2];
        var idxU = resolveIndex(def2);
        if (idxU !== undefined && unitRow[idxU] !== undefined) {
          rec._units[k2] = cfg.normalizeUnit ? cfg.normalizeUnit(unitRow[idxU]) : unitRow[idxU];
        }
      }
    }

    return rec;
  }

  /**
   * Decode field Calendar VHMS.
   * Format: "1733013976|28800|0"  =>  unixEpoch | offsetDetik | flag
   * Offset 28800 = UTC+8 (WITA). Kita jumlahkan agar jam lokal benar.
   */
  function decodeCalendar(raw) {
    if (!raw || raw === '-') return null;
    var parts = String(raw).split('|');
    var epoch = parseFloat(parts[0]);
    if (isNaN(epoch)) return null;
    var tzOffset = parts.length > 1 ? (parseFloat(parts[1]) || 0) : 0;
    var ms = (epoch + tzOffset) * 1000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return {
      epoch: epoch,
      tzOffsetSec: tzOffset,
      date: d,
      // String tanggal siap-tampil dalam zona lokal-perhitungan (WITA)
      display: formatDateTime(d)
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDateTime(d) {
    // Pakai UTC karena kita sudah menambahkan offset zona secara manual.
    return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  /* -----------------------------------------------------------------------
   * [POIN 3] Satuan standar per parameter.
   * Prioritas: satuan dari file (Axis Scale, sudah dinormalisasi) ->
   *            satuan baku di config.
   * --------------------------------------------------------------------- */
  function getColumnUnit(parsed, paramKey) {
    if (!parsed) return '';
    var recs = parsed.records || [];
    for (var i = 0; i < recs.length && i < 20; i++) {
      if (recs[i]._units && recs[i]._units[paramKey]) return recs[i]._units[paramKey];
    }
    // Fallback: satuan baku dari config (family-aware bila tersedia)
    // [HD465 2026-10-27] Sertakan juga nama model agar satuan/override khusus
    // model (mis. blowby HD465) ikut terpakai saat membaca label satuan.
    var mdl = (parsed.meta && parsed.meta.model) || '';
    var P = (cfg.paramsForFamily && parsed.familyId) ? cfg.paramsForFamily(parsed.familyId, mdl) : cfg.PARAMS;
    var meta = P[paramKey] || cfg.PARAMS[paramKey];
    return meta ? (meta.unit || '') : '';
  }

  /* -----------------------------------------------------------------------
   * API publik
   * --------------------------------------------------------------------- */
  function parseLargeFileInWorker(file) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker('js/csv-parse-worker.js');
      var settled = false;
      function done(fn, value) { if (settled) return; settled = true; worker.terminate(); fn(value); }
      worker.onmessage = function (event) {
        var data = event.data || {};
        if (data.ok) done(resolve, data.result); else done(reject, new Error(data.error || 'Gagal memproses file besar.'));
      };
      worker.onerror = function () { done(reject, new Error('Gagal memproses file besar.')); };
      var reader = new FileReader();
      reader.onload = function () { worker.postMessage({ kind: 'vhms', text: reader.result, fileName: file.name }); };
      reader.onerror = function () { done(reject, new Error('Gagal membaca file.')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  global.VHMS_PARSER = {
    parse: parse,
    getColumnUnit: getColumnUnit,
    parseFile: function (file) {
      if (file && file.size > 5 * 1024 * 1024 && typeof Worker !== 'undefined') return parseLargeFileInWorker(file);
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          try { resolve(parse(reader.result)); }
          catch (e) { reject(e); }
        };
        reader.onerror = function () { reject(new Error('Gagal membaca file.')); };
        // VHMS kadang menulis header UTF-8 BOM; pakai utf-8 (BOM ditangani)
        reader.readAsText(file, 'utf-8');
      });
    },
    _internals: { splitCsvLine: splitCsvLine, toNumber: toNumber, normKey: normKey, decodeCalendar: decodeCalendar,
                  isFaultType: isFaultType, isMatrixType: isMatrixType,
                  isFallbackEligibleType: isFallbackEligibleType,
                  buildFallbackColumns: buildFallbackColumns, hasCoreParams: hasCoreParams,
                  // [P2-1 2026-10-27] gerbang yang menghapus data WAJIB dapat dihitung.
                  resetValidationStats: resetValidationStats,
                  getValidationStats: getValidationStats }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

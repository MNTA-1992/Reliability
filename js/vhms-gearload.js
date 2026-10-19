/* =========================================================================
 * vhms-gearload.js
 * -------------------------------------------------------------------------
 * [HD785 2026-10-14] Penafsir MATRIKS BEBAN TRANSMISI PER GIGI dari ekspor
 * VHMS HD785 (`CHK0001/`). Tiga belas berkas, SATU struktur identik.
 *
 * BERKAS YANG DITANGANI (Data Type -> gigi, mode)
 *   LOCK-UP (Y = "T/M Input Torque")      : F8 tmf1lu  -> F1
 *                                           E2 tmf2lu  -> F2
 *                                           E3 tmf3lu  -> F3
 *                                           E4 tmf4lu  -> F4
 *                                           F9 tmf5lu  -> F5
 *                                           FA tmf6lu  -> F6
 *                                           FB tmf7lu  -> F7
 *                                           CA CSVDATA_ca -> R1
 *                                           E5 tmr2lu  -> R2
 *   TORQUE CONVERTER (Y = "T/C Output Torque") :
 *                                           44 loadmtmf1 -> F1
 *                                           45 loadmtmf2 -> F2
 *                                           47 loadmtmr1 -> R1
 *                                           48 loadmtmr2 -> R2
 *
 * BENTUK BERKAS (terverifikasi pada SN 31991, SMR 35.165,4 h)
 *   X = `T/M Input Speed` (rpm), 9 band: "0 - 800","- 1000",…,"2200 -"
 *   Y = torque (Nm),            8 band: "0 - 1000","- 2000",…,"7000 -"
 *   Z = `Time, sec`             `Sampling Time` 1000 msec, `Column Rate` 1
 *   Baris data diawali LABEL band torsi di kolom 0.
 *
 * SATUAN — INI YANG MEMBEDAKANNYA DARI `vhms-loadmap.js`
 *   Sumbu Z berkas ini adalah DETIK NYATA, bukan frekuensi relatif. Jumlah
 *   seluruh sel ke-13 berkas = 62.395.xxx detik = 17.332 jam = 49,3 % dari
 *   SMR 35.165,4 h. Angka itu masuk akal untuk dump truck (sisanya idle,
 *   loading, dumping, netral). Karena itu modul ini MELAPORKAN JAM —
 *   `jam = Σ sel / 3600` — bukan sekadar persen.
 *
 *   ⚠ Ini BERBEDA dari `loadm0` (tipe '30') yang sumbu Z-nya
 *     `Frequency, %` dengan total ≈100.000 (distribusi, bukan durasi).
 *     Jangan menyamakan keduanya.
 *
 * =========================================================================
 * ⚠⚠ AMBANG TORSI: KENAPA MODUL INI TIDAK MEMAKAI `VHMS_LOADMAP.TORQUE_HI`
 * =========================================================================
 *   `VHMS_LOADMAP` memakai TORQUE_HI = 3000 Nm / TORQUE_VERY_HI = 3500 Nm.
 *   Angka itu dikalibrasi untuk **torsi POMPA HIDROLIK PC2000** (tipe
 *   '7E'/'7F', sumbu Y "All Pump Torque"/"Work Pump Torque"). Besaran di
 *   berkas ini adalah **torsi POROS TRANSMISI HD785** — besaran fisis yang
 *   BERBEDA, rentang berbeda, mesin berbeda.
 *
 *   Bukti kalau konstanta itu dipakai ulang: F2 L/U menghasilkan "61,4 %
 *   waktu di torsi ≥3000 Nm". Angka itu tidak menandakan apa pun — ia hanya
 *   mencerminkan bahwa band torsi transmisi memang tinggi secara normal.
 *
 *   Ini PERSIS pola bug `*ExhOver800` (satu kunci, dua satuan, dua model)
 *   yang sudah dua kali jadi masalah di proyek ini. Karena itu:
 *
 *     MODUL INI TIDAK MENGELUARKAN VONIS AMBANG SAMA SEKALI.
 *
 *   Yang dilaporkan hanya besaran RELATIF yang sah tanpa rujukan OEM:
 *     - jam per gigi (dari detik — terukur, bukan tafsiran)
 *     - pangsa jam tiap gigi terhadap total waktu jalan
 *     - rasio LOCK-UP vs TORQUE CONVERTER
 *     - band torsi & rpm PUNCAK tiap gigi (modus, bukan ambang)
 *     - pangsa torsi di kuartil ATAS matriks itu sendiri (self-referential,
 *       jadi tetap bermakna lintas model)
 *
 *   Bila kelak ada angka Shop Manual HD785, taruh di kunci TERPISAH per
 *   model — JANGAN pakai ulang kunci milik load map pompa.
 * =========================================================================
 *
 * KENAPA RASIO L/U vs T/C PENTING (dan ini sah tanpa ambang OEM)
 *   Torque converter meneruskan tenaga lewat fluida -> selalu ada slip ->
 *   panas & rugi daya. Lock-up clutch mengunci poros input-output sehingga
 *   transmisi langsung (tanpa slip). Makin besar porsi waktu LOCK-UP, makin
 *   kecil beban termal pada oli T/C. Perbandingan ini:
 *     - sah dibandingkan ANTAR UNIT model sama (rasio tanpa satuan),
 *     - sah dibandingkan ANTAR WAKTU pada unit sama,
 *     - TIDAK butuh angka OEM karena ia bukan ambang, melainkan komposisi.
 *   Unit contoh: L/U 81,4 % — T/C 18,6 %.
 *
 * PRINSIP PROYEK
 *   - Nilai TIDAK dimutasi; modul murni atas teks masukan.
 *   - Tanpa dependensi kecuali CSV_UTIL & VHMS_LOADMAP (keduanya opsional;
 *     `resolveBands` dipinjam bila tersedia agar logika band TIDAK diduplikasi).
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Peta tipe -> (gigi, mode)
   * --------------------------------------------------------------------- */

  /** Mode penyaluran tenaga. */
  var MODE_LOCKUP = 'lockup';      // kopling L/U terkunci (tanpa slip)
  var MODE_CONVERTER = 'converter'; // lewat torque converter (ada slip)

  /**
   * [D375A 2026-10-14 — J1] Mode KETIGA: seluruh waktu gigi, L/U + converter
   * TERGABUNG. Dipakai untuk model yang TIDAK mengekspor matriks L/U per gigi.
   *
   * HD785 mengekspor `tmf1lu`..`tmf7lu` + `CSVDATA_ca` + `tmr2lu` (9 berkas
   * L/U per gigi), jadi tipe 44/45/47/48 di sana memang HANYA porsi converter.
   * D375A HANYA punya SATU `loadmlu` (tipe 34) yang agregat — tidak terpecah
   * per gigi. Maka 44..49 di D375A = SELURUH waktu gigi.
   *
   * Kalau mode converter dipaksakan ke D375A, `summarize()` menghasilkan
   * `lockupSec = 0` dan panel menulis "lock-up 0,0 %" untuk unit yang
   * sebenarnya 13,5 % (2 672 h L/U / 19 834 h travel). Itu VONIS PALSU,
   * bukan data hilang — jauh lebih berbahaya karena terlihat seperti temuan.
   */
  var MODE_ALL = 'all';

  /**
   * Peta Data Type -> { gear, mode }.
   * Sumber: `index00.csv` ekspor SN 31991 + baris `Data Type & Title` tiap
   * berkas. Kode heksadesimal ini BUKAN urutan — jangan ditebak dari pola.
   */
  var TYPE_MAP = {
    'F8': { gear: 'F1', mode: MODE_LOCKUP },
    'E2': { gear: 'F2', mode: MODE_LOCKUP },
    'E3': { gear: 'F3', mode: MODE_LOCKUP },
    'E4': { gear: 'F4', mode: MODE_LOCKUP },
    'F9': { gear: 'F5', mode: MODE_LOCKUP },
    'FA': { gear: 'F6', mode: MODE_LOCKUP },
    'FB': { gear: 'F7', mode: MODE_LOCKUP },
    'CA': { gear: 'R1', mode: MODE_LOCKUP },
    'E5': { gear: 'R2', mode: MODE_LOCKUP },
    '44': { gear: 'F1', mode: MODE_CONVERTER },
    '45': { gear: 'F2', mode: MODE_CONVERTER },
    // [D375A 2026-10-14 — J2] 46 & 49 DITAMBAHKAN. Ekspor D375A memuat 6
    // matriks `loadmtm*` (F1..F3 + R1..R3), sedangkan HD785 hanya 4. Tanpa
    // dua kunci ini, F3 & R3 jatuh ke `unknown` dan DITOLAK TANPA PESAN —
    // padahal jamnya kecil justru karena profil dozing D375A jarak pendek
    // (F3 = 36 h, R3 = 10 h). Nol yang hilang senyap tetap informasi.
    '46': { gear: 'F3', mode: MODE_CONVERTER },
    '47': { gear: 'R1', mode: MODE_CONVERTER },
    '48': { gear: 'R2', mode: MODE_CONVERTER },
    '49': { gear: 'R3', mode: MODE_CONVERTER }
  };

  /** Urutan tampil gigi (maju dulu, lalu mundur). */
  var GEAR_ORDER = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'R1', 'R2', 'R3'];

  /** Detik per jam — satu-satunya konversi satuan di modul ini. */
  var SEC_PER_HOUR = 3600;

  /* -----------------------------------------------------------------------
   * 2. Deteksi jenis berkas
   * --------------------------------------------------------------------- */

  function normType(type) {
    // Kode heksa ditulis huruf besar di berkas; tetap dinormalkan agar
    // ekspor varian huruf kecil ('f8') tidak lolos jadi 'unknown'.
    return String(type == null ? '' : type).trim().toUpperCase();
  }

  function isGearLoadType(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_MAP, normType(type));
  }

  /** `{gear, mode}` untuk sebuah tipe, atau null. */
  function gearInfoFromType(type) {
    var t = normType(type);
    return TYPE_MAP[t] ? { gear: TYPE_MAP[t].gear, mode: TYPE_MAP[t].mode } : null;
  }

  /**
   * Tebak dari NAMA BERKAS — cadangan bila `dataType` tidak terbaca.
   * `tmf3lu.CSV` -> F3 lock-up ; `loadmtmr2.CSV` -> R2 converter.
   */
  function gearInfoFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    // Lock-up: "tm" + f/r + angka + "lu"
    var m = /tm([fr])(\d)lu/.exec(n);
    if (m) return { gear: m[1].toUpperCase() + m[2], mode: MODE_LOCKUP };
    // Converter: "loadmtm" + f/r + angka
    var m2 = /loadmtm([fr])(\d)/.exec(n);
    if (m2) return { gear: m2[1].toUpperCase() + m2[2], mode: MODE_CONVERTER };
    return null;
  }

  /**
   * Keluarga model yang TIDAK punya matriks L/U per gigi -> mode `all`.
   * ---------------------------------------------------------------------
   * Sengaja DAFTAR-PUTIH (whitelist), bukan daftar-hitam: model baru yang
   * belum diteliti HARUS jatuh ke perilaku HD785 yang sudah terverifikasi,
   * bukan ke asumsi dozer. Menambah keluarga berarti menambah bukti, bukan
   * menambah keyakinan.
   *
   * Kunci = `VHMS_PROFILES.detectFamily(meta)` yang mengembalikan STRING
   * (`'DOZER'`, `'TRUCK'`, `'EXCAVATOR'`, `'UNKNOWN'`) — terverifikasi pada
   * probe 2026-10-14, bukan objek.
   *
   * Bukti D375A: SN 19559 SMR 28 812,1 h -> 6 berkas `loadmtm*` (Σ 19 834 h)
   * + 1 `loadmlu` agregat (2 672 h). Tidak ada `tmf*lu*.CSV` sama sekali.
   */
  var AGGREGATE_LU_FAMILIES = { DOZER: true };

  /**
   * Himpunan gigi yang BENAR-BENAR ada pada sebuah keluarga model.
   * ---------------------------------------------------------------------
   * Dipakai untuk `missingGears`: gigi yang tidak ada di model bukan "data
   * hilang". Kalau memakai GEAR_ORDER global, HD785 selalu melaporkan R3
   * hilang dan D375A selalu melaporkan F4..F7 hilang — dua-duanya palsu.
   */
  var GEARS_BY_FAMILY = {
    DOZER: ['F1', 'F2', 'F3', 'R1', 'R2', 'R3'],
    TRUCK: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'R1', 'R2'],
    EXCAVATOR: ['F1', 'F2', 'F3', 'R1', 'R2', 'R3']
  };

  /**
   * Normalisasi blok `[Common Header]` menjadi bentuk yang dimengerti
   * `VHMS_PROFILES.detectFamily(meta)`.
   * ---------------------------------------------------------------------
   * `parse()` menyimpan meta dengan KUNCI HURUF KECIL asli berkas
   * (`'machine model'`, `'product group'`), sedangkan detectFamily membaca
   * `meta.productGroup` / `meta.model`. Tanpa penjembatan ini, setiap
   * resolusi keluarga mengembalikan UNKNOWN dan J1 kambuh tanpa suara.
   */
  var META_ALIASES = {
    productgroup: 'productGroup',
    machinemodel: 'model',
    machineserialno: 'serialNo',
    'machineserialno.': 'serialNo'
  };
  function toFamilyMeta(meta) {
    var m = meta || {};
    var out = {};
    Object.keys(m).forEach(function (k) {
      var key = String(k).replace(/[.\s]/g, '').toLowerCase();
      out[META_ALIASES[key] || key] = m[k];
    });
    return out;
  }

  /** Keluarga model dari sebuah hasil parse (selalu string, mungkin UNKNOWN). */
  function familyOfMeta(meta) {
    var prof = global.VHMS_PROFILES;
    if (!prof || typeof prof.detectFamily !== 'function') return 'UNKNOWN';
    return String(prof.detectFamily(toFamilyMeta(meta)) || 'UNKNOWN');
  }

  /** Keluarga dengan suara terbanyak dari sekumpulan berkas. */
  function dominantFamily(votes) {
    var best = 'UNKNOWN', n = -1;
    Object.keys(votes || {}).forEach(function (f) {
      if (f === 'UNKNOWN') return;
      if (votes[f] > n) { n = votes[f]; best = f; }
    });
    return best;
  }

  /** Himpunan gigi untuk sebuah keluarga; jatuh ke GEAR_ORDER bila tak dikenal. */
  function gearSetForFamily(fam) {
    return GEARS_BY_FAMILY[fam] || GEAR_ORDER;
  }

  /**
   * Tentukan mode NYATA sebuah tipe untuk sebuah unit.
   *
   * Berbeda dari `gearInfoFromType()` yang mengembalikan mode STATIS dari
   * `TYPE_MAP`: fungsi ini menyadari bahwa arti sebuah tipe bergantung pada
   * TOPOLOGI EKSPOR keluarga modelnya.
   *
   * @param {string} type Data Type apa adanya dari berkas
   * @param {object} [meta] blok `[Common Header]` hasil parse
   * @returns {string|null} MODE_LOCKUP | MODE_CONVERTER | MODE_ALL | null
   */
  function resolveMode(type, meta) {
    var info = gearInfoFromType(type);
    if (!info) return null;
    // Berkas L/U per gigi selalu lock-up, model apa pun. Tidak ada ambiguitas:
    // nama berkasnya sendiri sudah menyatakan mode-nya.
    if (info.mode === MODE_LOCKUP) return MODE_LOCKUP;
    // ⚠ WAJIB lewat `toFamilyMeta`. `detectFamily` membaca `meta.productGroup`
    // /`meta.model`, sedangkan `meta` mentah dari parse() memakai kunci asli
    // berkas (`'Product Group'`, `'Machine Model'`). Tanpa penjembatan ini
    // setiap panggilan mengembalikan UNKNOWN -> SELALU converter -> J1 kambuh
    // tanpa suara. Ini pernah terjadi pada implementasi pertama T0.
    var fam = familyOfMeta(meta);
    return AGGREGATE_LU_FAMILIES[fam] ? MODE_ALL : MODE_CONVERTER;
  }

  /* -----------------------------------------------------------------------
   * 3. Utilitas
   * --------------------------------------------------------------------- */

  function splitLine(line) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.splitLine === 'function') return cu.splitLine(line);
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /**
   * Lengkapi batas bawah band satu-sisi ("- 2000" = 1000..2000).
   * Dipinjam dari `VHMS_LOADMAP` bila tersedia agar aturan band HANYA ada
   * di satu tempat — menduplikasinya pernah jadi sumber bug (B7).
   */
  function resolveBands(labels) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') return lm.resolveBands(labels);
    // Cadangan ringkas (hanya dipakai bila loadmap belum dimuat).
    var prev = null;
    return (labels || []).map(function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      var out = { lo: null, hi: null, open: false, label: s };
      var m2 = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
      if (m2) { out.lo = toNum(m2[1]); out.hi = toNum(m2[2]); prev = out.hi; return out; }
      var m1 = /^-\s*([\d.]+)$/.exec(s);
      if (m1) { out.hi = toNum(m1[1]); out.lo = prev; prev = out.hi; return out; }
      var m3 = /^([\d.]+)\s*-$/.exec(s);
      if (m3) { out.lo = toNum(m3[1]); out.open = true; prev = out.lo; return out; }
      return out;
    });
  }

  /** Batas bawah band sebagai angka pembanding; null bila tak terbaca. */
  function bandLow(b) {
    if (!b) return null;
    return (b.lo !== null && b.lo !== undefined) ? b.lo : b.hi;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse satu berkas matriks beban gigi.
   *
   * @param {string} text isi berkas
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} {
   *   kind:'gearLoad', dataType, dataTitle, gear, mode, meta,
   *   rowLabels[], colLabels[], matrix[][],
   *   xAxis{title,unit}, yAxis{title,unit}, zAxis{title,unit},
   *   totalSec, hours, stats{...}, warnings[] }
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: 'gearLoad',
      dataType: '', dataTitle: '',
      gear: null, mode: null,
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      totalSec: 0, hours: 0,
      stats: null,
      warnings: []
    };

    var inData = false, sawData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      var sec = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (sec) {
        if (/^data$/i.test(sec[1])) { inData = true; sawData = true; }
        else { inData = false; }
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);
      var key = String(cells[0] || '').trim();

      if (!inData) {
        if (!key) continue;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = String(cells[1] || '').trim();
          result.dataTitle = String(cells[2] || '').trim();
        } else if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (!/^(status of item|view item\d*|column (type|rate|scale))$/i.test(key)) {
          // [D375A 2026-10-14 — J1] Baris `Product Group`/`Machine Model` HANYA
          // ditangkap di sini bila mereka berada di dalam blok tempat `key`
          // disimpan. Blok `[Common Header]` memang terletak SEBELUM `[Display
          // Information]`, jadi `key` ada — tetapi hanya selama perulangan ini
          // tidak melewati batas blok. Komentar pengaman: kunci WAJIB
          // dinormalkan agar `resolveMode` dapat memanggil `detectFamily`,
          // yang membaca `meta.productGroup`/`meta.model` (bukan kunci asli
          // berkas yang memakai spasi). Lihat `toFamilyMeta`.
          var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();
          result.meta[key] = val;
        }
        continue;
      }

      // --- Baris data: label band torsi di kolom 0 ---
      // Sebagian ekspor mengulang baris definisi di dalam [Data].
      if (/^\s*(Column (Item|Rate|Type|Scale)|Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) {
        if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        }
        continue;
      }
      if (key === '') continue;
      var nums = cells.slice(1).map(toNum);
      if (!nums.some(function (v) { return v !== null; })) continue;
      result.rowLabels.push(key);
      result.matrix.push(nums.map(function (v) { return v === null ? 0 : v; }));
    }

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas matriks beban gigi.');
    if (!result.matrix.length) throw new Error('Berkas matriks beban gigi tidak mengandung baris data.');

    // --- Identitas gigi & mode ---
    result.dataType = normType(opts.dataType || result.dataType);
    var info = gearInfoFromType(result.dataType) || gearInfoFromFileName(opts.sourceName || '');
    if (info) {
      result.gear = info.gear;
      // [D375A 2026-10-14 — J1] Mode TIDAK diambil mentah dari `info.mode`.
      // `resolveMode` memutuskan berdasarkan KELUARGA MODEL: di D375A, 44..49
      // berarti seluruh waktu gigi (MODE_ALL), bukan hanya converter.
      // Meta sudah terisi di titik ini — urutan ini yang membuat resolusi sah;
      // kalau meta dibaca SESUDAHNYA, resolveMode menerima objek kosong dan
      // SELALU jatuh ke MODE_CONVERTER.
      result.mode = resolveMode(result.dataType, result.meta) || info.mode;
      if (!gearInfoFromType(result.dataType)) {
        // Gigi ditebak dari nama berkas (bukan dari `dataType`): mode tetap
        // statis dari nama, karena nama menyatakan mode secara eksplisit.
        result.mode = info.mode;
      }
    } else {
      // Tanpa tipe & tanpa nama berkas yang cocok, mode MASIH bisa
      // disimpulkan dari sumbu Y — "T/C Output" vs "T/M Input" ditulis
      // eksplisit oleh exporter. Gigi tetap tidak dapat ditebak.
      var yt = (result.yAxis.title || '').toLowerCase();
      result.mode = /t\/c|converter|output/.test(yt) ? MODE_CONVERTER : MODE_LOCKUP;
      result.warnings.push('Gigi tidak dapat ditentukan dari tipe "' + result.dataType +
        '" maupun nama berkas "' + (opts.sourceName || '') + '"; mode ditebak dari sumbu Y.');
    }

    // --- Satuan sumbu Z: WAJIB detik ---
    // Bila exporter memakai satuan lain, laporkan jam sebagai tidak sahih
    // daripada diam-diam membagi 3600 atas angka yang bukan detik.
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    var zIsSeconds = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (!zIsSeconds) {
      result.warnings.push('Satuan sumbu Z terbaca "' + (result.zAxis.unit || '(kosong)') +
        '", bukan detik — nilai jam TIDAK dilaporkan agar tidak menyesatkan.');
    }

    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.totalSec = total;
    result.hours = zIsSeconds ? (total / SEC_PER_HOUR) : null;
    result.secondsValid = zIsSeconds;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — gigi ini tidak pernah terpakai pada rentang data.');
      result.stats = null;
      return result;
    }

    result.stats = buildStats(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 5. Statistik per berkas — SEMUANYA relatif, TANPA ambang absolut
   * --------------------------------------------------------------------- */

  /**
   * Turunkan ciri sebuah matriks tanpa memakai ambang torsi absolut.
   *
   * Yang dihitung:
   *   - peakTorque / peakRpm : band dengan jam TERBANYAK (modus). Ini
   *     deskriptif murni — menjawab "unit ini paling sering bekerja di mana",
   *     bukan "apakah itu terlalu tinggi".
   *   - p50/p90 band torsi : band tempat 50 %/90 % waktu kumulatif tercapai.
   *     Self-referential (dihitung dari distribusi berkas itu sendiri) jadi
   *     sah dibandingkan antar gigi, antar mode, dan antar unit model sama —
   *     TANPA butuh angka OEM. p90 menjawab "seberapa tinggi ekor bebannya".
   *   - torqueRows / rpmCols : distribusi penuh (jam + pangsa) untuk tabel.
   *
   * ⚠ PERCOBAAN YANG DIBUANG: versi pertama memakai "pangsa 25 % band teratas".
   *   Pada 13 berkas nyata hasilnya 0,0 % di SEMUA berkas — dua band teratas
   *   (`- 7000`, `7000 -`) memang selalu kosong, jadi ukuran itu tidak pernah
   *   membedakan apa pun. Persentil tidak punya masalah ini karena ia
   *   mengikuti SEBARAN, bukan posisi band.
   */
  function buildStats(res) {
    var rowBands = resolveBands(res.rowLabels);
    var colBands = resolveBands(res.colLabels);
    var total = res.totalSec;
    if (total <= 0) return null;

    var rowSums = res.matrix.map(function (r) {
      return r.reduce(function (a, b) { return a + b; }, 0);
    });
    var colCount = res.colLabels.length || (res.matrix[0] ? res.matrix[0].length : 0);
    var colSums = [];
    for (var c = 0; c < colCount; c++) {
      var s = 0;
      for (var r2 = 0; r2 < res.matrix.length; r2++) s += (res.matrix[r2][c] || 0);
      colSums.push(s);
    }

    function peakIndex(arr) {
      var bi = -1, bv = -1;
      for (var i = 0; i < arr.length; i++) { if (arr[i] > bv) { bv = arr[i]; bi = i; } }
      return bi;
    }
    var pr = peakIndex(rowSums), pc = peakIndex(colSums);

    /**
     * Band tempat fraksi `q` dari waktu kumulatif tercapai (persentil).
     * Dihitung dari distribusi berkas itu sendiri -> bebas skala Nm.
     * @returns {{index:number, label:string, low:number|null}|null}
     */
    function quantileBand(sums, labels, bands, q) {
      var target = total * q;
      var acc = 0;
      for (var i = 0; i < sums.length; i++) {
        acc += sums[i];
        if (acc >= target) {
          return { index: i, label: labels[i] || null, low: bandLow(bands[i]) };
        }
      }
      var last = sums.length - 1;
      return last >= 0 ? { index: last, label: labels[last] || null, low: bandLow(bands[last]) } : null;
    }

    var tqP50 = quantileBand(rowSums, res.rowLabels, rowBands, 0.5);
    var tqP90 = quantileBand(rowSums, res.rowLabels, rowBands, 0.9);
    var rpmP50 = quantileBand(colSums, res.colLabels, colBands, 0.5);

    function toHours(sec) { return res.secondsValid ? (sec / SEC_PER_HOUR) : null; }

    return {
      totalSec: total,
      hours: toHours(total),
      peakTorqueBand: pr >= 0 ? res.rowLabels[pr] : null,
      peakTorqueLow: pr >= 0 ? bandLow(rowBands[pr]) : null,
      peakTorqueShare: pr >= 0 ? (100 * rowSums[pr] / total) : null,
      peakRpmBand: pc >= 0 ? res.colLabels[pc] : null,
      peakRpmLow: pc >= 0 ? bandLow(colBands[pc]) : null,
      peakRpmShare: pc >= 0 ? (100 * colSums[pc] / total) : null,
      /** Band torsi median (50 % waktu kumulatif) — deskriptif, bukan ambang. */
      medianTorqueBand: tqP50 ? tqP50.label : null,
      medianTorqueLow: tqP50 ? tqP50.low : null,
      /** Band torsi p90 — "ekor" beban. Naik antar waktu = beban memberat. */
      p90TorqueBand: tqP90 ? tqP90.label : null,
      p90TorqueLow: tqP90 ? tqP90.low : null,
      medianRpmBand: rpmP50 ? rpmP50.label : null,
      medianRpmLow: rpmP50 ? rpmP50.low : null,
      torqueRows: res.rowLabels.map(function (lbl, i) {
        return { label: lbl, sec: rowSums[i], hours: toHours(rowSums[i]), share: 100 * rowSums[i] / total };
      }),
      rpmCols: res.colLabels.map(function (lbl, i) {
        return { label: lbl, sec: colSums[i], hours: toHours(colSums[i]), share: 100 * colSums[i] / total };
      })
    };
  }

  /* -----------------------------------------------------------------------
   * 6. Agregat lintas-berkas (satu unit)
   * --------------------------------------------------------------------- */

  /**
   * Gabungkan semua matriks gigi sebuah unit menjadi ringkasan armada-siap.
   *
   * @param {object} byKey peta `"<mode>:<gear>" -> hasil parse()`
   * @returns {object|null} ringkasan, atau null bila tidak ada data sah
   *
   * Yang dikembalikan:
   *   totalHours        jam jalan total (L/U + T/C)
   *   lockupHours / converterHours / lockupShare
   *   gears[]           per gigi: jam L/U, jam T/C, total, pangsa
   *   dominantGear      gigi dengan jam terbanyak
   *   coverageNote      perbandingan terhadap SMR bila diketahui pemanggil
   */
  function summarize(byKey) {
    if (!byKey) return null;
    var keys = Object.keys(byKey);
    if (!keys.length) return null;

    var lockupSec = 0, converterSec = 0, allModeSec = 0;
    var perGear = {};
    var anyValid = false;
    var fileCount = 0;
    // Keluarga model dominan dari berkas yang ada — dipakai untuk memilih
    // daftar gigi yang relevan (lihat catatan missingGears di bawah).
    var famVotes = {};

    keys.forEach(function (k) {
      var res = byKey[k];
      if (!res || !res.totalSec) return;
      fileCount++;
      if (res.secondsValid) anyValid = true;
      var fam = familyOfMeta(res.meta);
      famVotes[fam] = (famVotes[fam] || 0) + 1;
      var g = res.gear || '?';
      if (!perGear[g]) perGear[g] = { gear: g, lockupSec: 0, converterSec: 0, allSec: 0 };
      if (res.mode === MODE_ALL) {
        // [D375A 2026-10-14 — J1] Seluruh waktu gigi. TIDAK boleh masuk
        // lockupSec ATAU converterSec — kalau masuk converterSec, pangsa
        // L/U menjadi 0 % dan panel memberi vonis palsu.
        allModeSec += res.totalSec;
        perGear[g].allSec += res.totalSec;
      } else if (res.mode === MODE_CONVERTER) {
        converterSec += res.totalSec;
        perGear[g].converterSec += res.totalSec;
      } else {
        lockupSec += res.totalSec;
        perGear[g].lockupSec += res.totalSec;
      }
    });

    var totalSec = lockupSec + converterSec + allModeSec;
    if (totalSec <= 0) return null;

    function hrs(sec) { return anyValid ? (sec / SEC_PER_HOUR) : null; }

    var gearSet = gearSetForFamily(dominantFamily(famVotes));

    var gears = gearSet.filter(function (g) { return perGear[g]; })
      .concat(Object.keys(perGear).filter(function (g) { return gearSet.indexOf(g) < 0; }))
      .map(function (g) {
        var e = perGear[g];
        var t = e.lockupSec + e.converterSec + e.allSec;
        return {
          gear: g,
          lockupSec: e.lockupSec, converterSec: e.converterSec, allSec: e.allSec, totalSec: t,
          lockupHours: hrs(e.lockupSec), converterHours: hrs(e.converterSec),
          allHours: hrs(e.allSec), hours: hrs(t),
          share: 100 * t / totalSec,
          /** Pangsa L/U DI DALAM gigi ini — null bila gigi hanya punya satu mode. */
          lockupShare: (e.lockupSec && e.converterSec) ? (100 * e.lockupSec / t) : null
        };
      });

    var dom = null;
    gears.forEach(function (g) { if (!dom || g.totalSec > dom.totalSec) dom = g; });

    // Mode L/U vs T/C hanya bermakna bila KEDUA sisi benar-benar terpisah.
    // Untuk D375A murni (`MODE_ALL`), pangsa = null (tidak terpisah), BUKAN 0.
    var separated = (lockupSec + converterSec) > 0;

    return {
      fileCount: fileCount,
      secondsValid: anyValid,
      totalSec: totalSec,
      totalHours: hrs(totalSec),
      lockupSec: lockupSec, converterSec: converterSec, allModeSec: allModeSec,
      lockupHours: hrs(lockupSec), converterHours: hrs(converterSec),
      /**
       * Pangsa waktu jalan dengan kopling L/U terkunci (%).
       * `null` bila keluarga model ini TIDAK memisahkan L/U per gigi —
       * lihat MODE_ALL. `null` != `0`: `0` berarti terukur nol.
       */
      lockupShare: separated ? (100 * lockupSec / totalSec) : null,
      converterShare: separated ? (100 * converterSec / totalSec) : null,
      /** false -> pangsa L/U vs T/C tidak tersedia untuk model ini. */
      modeSeparated: separated,
      /** true -> jam berasal dari `MODE_ALL` (L/U + T/C tergabung). */
      hasAggregateMode: allModeSec > 0,
      gears: gears,
      dominantGear: dom ? dom.gear : null,
      /**
       * Gigi yang berkasnya BELUM diunggah (untuk pesan kejujuran data).
       * [D375A 2026-10-14] Dihitung dari HIMPUNAN GIGI KELUARGA, bukan dari
       * GEAR_ORDER global — kalau tidak, unit HD785 (7 gigi maju, tanpa R3)
       * akan selalu melaporkan "R3 belum diunggah" padahal R3 tidak ada di
       * model itu. Gigi yang tidak ada di model bukan "data hilang".
       */
      missingGears: gearSet.filter(function (g) { return !perGear[g]; }),
      /** Keluarga model yang dipakai untuk menentukan himpunan gigi di atas. */
      family: dominantFamily(famVotes)
    };
  }

  /**
   * Pangsa waktu jalan terhadap SMR unit.
   * Dipisah dari `summarize` karena SMR berasal dari unit, bukan dari berkas.
   * @returns {number|null} persen, null bila SMR tidak sahih
   */
  function travelShareOfSmr(summary, smrHours) {
    if (!summary || summary.totalHours === null) return null;
    var smr = Number(smrHours);
    if (!isFinite(smr) || smr <= 0) return null;
    return 100 * summary.totalHours / smr;
  }

  /** Kunci penyimpanan sebuah hasil parse (mode + gigi). */
  function gearKey(res) {
    if (!res) return '';
    return String(res.mode || MODE_LOCKUP) + ':' + String(res.gear || '?');
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_GEARLOAD = {
    MODE_LOCKUP: MODE_LOCKUP,
    MODE_CONVERTER: MODE_CONVERTER,
    MODE_ALL: MODE_ALL,
    TYPE_MAP: TYPE_MAP,
    GEAR_ORDER: GEAR_ORDER,
    GEARS_BY_FAMILY: GEARS_BY_FAMILY,
    AGGREGATE_LU_FAMILIES: AGGREGATE_LU_FAMILIES,
    ACCEPTED_TYPES: Object.keys(TYPE_MAP),
    isGearLoadType: isGearLoadType,
    gearInfoFromType: gearInfoFromType,
    gearInfoFromFileName: gearInfoFromFileName,
    resolveMode: resolveMode,
    gearSetForFamily: gearSetForFamily,
    toFamilyMeta: toFamilyMeta,
    resolveBands: resolveBands,
    parse: parse,
    buildStats: buildStats,
    summarize: summarize,
    travelShareOfSmr: travelShareOfSmr,
    gearKey: gearKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_GEARLOAD;
  }
})(typeof window !== 'undefined' ? window : globalThis);

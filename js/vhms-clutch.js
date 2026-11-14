/* =========================================================================
 * vhms-clutch.js
 * -------------------------------------------------------------------------
 * [HD785 2026-10-09 · T5] Penafsir MATRIKS beban clutch dari berkas VHMS
 * `clutch_slip.CSV` (Data Type 'DA') dan `clutch_therm.CSV` (Data Type 'D9').
 *
 * APA YANG DIMODELKAN
 *   Kedua berkas itu BUKAN seri waktu. Strukturnya tabel silang:
 *
 *             area 0   1     2     3     4     5    6
 *     Low    65535 65535 65535  1464     5     1    0
 *     1st    65535 65535 65535 65535 10369  1106  739
 *
 *   baris = posisi clutch (low/high/rev/1st..4th), kolom = AREA pada sumbu-X
 *   yang dideklarasikan berkas, sel = JUMLAH KEJADIAN seumur hidup
 *   (kumulatif). Tidak ada SMR, tidak ada Calendar -> tidak dapat diplot
 *   sebagai tren dan TIDAK BOLEH masuk `records` trend.
 *
 *   Istilah "area" (bukan "bin") diambil dari berkas Komatsu sendiri:
 *       clutch_slip.CSV  -> X Axis Title & X Axis Scale,Slip time area,
 *       clutch_therm.CSV -> X Axis Title & X Axis Scale,Clutch area,
 *
 * JEBAKAN YANG WAJIB DITANGANI (lihat docs/STATUS_PROYEK.md §2.4 butir 2)
 *   1. Baris data diawali LABEL, bukan angka SMR.
 *   2. `65535` = COUNTER SATURASI (uint16), BUKAN nilai sebenarnya.
 *      Buktinya `3rd,65535,42009,65535,...` -> area1 < area2 (tidak monotonik).
 *      Menjumlahkan nilai mentah akan SALAH.
 *   3. Label baris dari pabrik mengandung salah tulis: `3th`, `4rd`.
 *
 * INDEKS KEPARAHAN (§2 D8)
 *   severity = Σ count[i] × w[i],  w = {3:1, 4:3, 5:9, 6:27},  i = 3..6
 *   - Area 0-2 DIABAIKAN: hampir semuanya bersaturasi pada semua posisi
 *     (termasuk posisi sehat) -> nol informasi pembeda.
 *   - Bobot geometrik (×3/area): energi gesek saat slip tumbuh NONLINIER
 *     terhadap durasi -> satu slip panjang jauh lebih merusak daripada
 *     sepuluh slip pendek. Bobot linier akan menyamakan keduanya.
 *   - Sel bersaturasi pada area 3..6 -> `saturated: true`, skor = BATAS BAWAH.
 *
 * PRINSIP PROYEK
 *   - Nilai TIDAK dimutasi; modul ini murni (pure) atas teks/objek masukan.
 *   - Tanpa dependensi modul lain kecuali CSV_UTIL (opsional & berguna).
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Konstanta
   * --------------------------------------------------------------------- */

  /** Batas counter uint16: nilai ini berarti ">= 65535", bukan tepat 65535. */
  var SATURATION = 65535;

  /**
   * [ISTILAH 2026-10-13] "BIN" -> "AREA".
   * ---------------------------------------------------------------------
   * Kata "bin" TIDAK PERNAH muncul di berkas Komatsu — itu istilah histogram
   * yang kita pinjam. Berkas OEM mendeklarasikan sumbu-X-nya sendiri:
   *     clutch_slip.CSV  -> "X Axis Title & X Axis Scale,Slip time area,"
   *     clutch_therm.CSV -> "X Axis Title & X Axis Scale,Clutch area,"
   * Jadi setiap kolom adalah satu AREA pada sumbu itu, bukan "bin". Istilah
   * yang dipakai sekarang mengikuti kata OEM agar tidak dapat diperdebatkan.
   */

  /** Bobot keparahan per area. Area 0-2 tidak diberi bobot (diabaikan). */
  var AREA_WEIGHTS = { 3: 1, 4: 3, 5: 9, 6: 27 };

  /** Area terendah yang ikut dinilai. */
  var SEVERITY_AREA_MIN = 3;

  /** Judul sumbu-X baku bila berkas tidak menyediakannya (kunci: kind matriks). */
  var AXIS_TITLE_DEFAULT = { slip: 'Slip time area', thermal: 'Clutch area' };

  /**
   * Normalisasi label posisi clutch.
   * Pabrik menulis `3th` dan `4rd` pada clutch_therm.CSV; di sini keduanya
   * dipulihkan menjadi `3rd`/`4th` agar kedua berkas dapat disandingkan.
   */
  var POSITION_ALIASES = {
    'low': 'Low',   'lo': 'Low',
    'high': 'High', 'hi': 'High',
    'rev': 'Rev',   'r': 'Rev',  'reverse': 'Rev',
    '1st': '1st',   'first': '1st',  '1': '1st',
    '2nd': '2nd',   'second': '2nd', '2': '2nd',
    '3rd': '3rd',   '3th': '3rd',   'third': '3rd', '3': '3rd',
    '4th': '4th',   '4rd': '4th',   'fourth': '4th', '4': '4th'
  };

  /** Urutan tampil posisi clutch (Low/High/Rev lalu gigi 1-4). */
  var POSITION_ORDER = ['Low', 'High', 'Rev', '1st', '2nd', '3rd', '4th'];

  /** Nama parameter VHMS untuk tiap posisi (dipakai bila perlu korelasi). */
  var POSITION_PARAM = {
    Low: 'tmFillLow', High: 'tmFillHigh',
    '1st': 'tmFill1', '2nd': 'tmFill2', '3rd': 'tmFill3', '4th': 'tmFill4',
    Rev: 'tmFillR'
  };

  /**
   * [R4-HD 2026-10-09] Komponen Lifetime (T/M) yang overhaul-nya meng-nol-kan
   * matriks clutch. Matriks clutch_slip/clutch_therm bersifat KUMULATIF
   * SEUMUR HIDUP; setelah clutch/transmisi di-overhaul, counter lama TIDAK
   * ter-reset di ECU, sehingga unit yang baru di-overhaul tetap terlihat buruk.
   *
   * Mengikuti KONSEP CLC (Component Life Cut-off): data SEBELUM pemasangan
   * komponen terakhir (Last Install / LastTecoDate pada berkas Lifetime)
   * dibuang dari penilaian. Karena matriks tidak punya cap waktu per-sel,
   * pemotongan dilakukan pada TINGKAT MATRIKS: bila snapshot matriks diambil
   * SEBELUM tanggal overhaul, seluruh matriks dianggap "pre-overhaul" -> tidak
   * dipakai untuk skoring (ditandai `cut:true`).
   */
  var OVERHAUL_COMPONENT_RE = /(transmission|transmisi|torque|clutch|t\/m|tm\b|powertrain|power\s*train)/i;

  /* -----------------------------------------------------------------------
   * 2. Utilitas lokal (tahan ketiadaan CSV_UTIL)
   * --------------------------------------------------------------------- */

  /**
   * Pecah satu baris CSV mengikuti RFC 4180.
   * Memakai CSV_UTIL.splitLine bila tersedia (satu sumber kebenaran),
   * jika tidak memakai implementasi lokal minimal agar modul tetap dapat
   * diuji berdiri sendiri.
   */
  function splitLine(line) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.splitLine === 'function') return cu.splitLine(line);
    // Implementasi cadangan: cukup untuk berkas VHMS (kutip ganda).
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  /** Angka dari sel CSV; null bila kosong/bukan angka. */
  function toNumber(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '') return null;
    // Buang pemisah ribuan (VHMS Inggris memakai koma, tetapi koma sudah
    // jadi delimiter sehingga tidak akan muncul di sini) dan spasi.
    s = s.replace(/\s+/g, '');
    var n = Number(s);
    return isNaN(n) ? null : n;
  }

  /** Label posisi -> bentuk baku, atau null bila tak dikenal. */
  function normalizePosition(label) {
    var key = String(label == null ? '' : label).trim().toLowerCase();
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(POSITION_ALIASES, key)) {
      return POSITION_ALIASES[key];
    }
    // Tangani varian seperti "1ST" / "3TH" (sudah lowercase di atas) dan
    // label berhias, mis. "1st " atau "*1st".
    var m = /^[^a-z0-9]*(low|high|rev|reverse|first|second|third|fourth|[1-4](?:st|th|nd|rd)?)/.exec(key);
    if (m && Object.prototype.hasOwnProperty.call(POSITION_ALIASES, m[1])) {
      return POSITION_ALIASES[m[1]];
    }
    return null;
  }

  /**
   * [R4-HD] Baca tanggal dari field `Time Stamp` VHMS.
   * Format contoh: "27/09/2026 14:46:04,1790491564|28800|0" — parser umum
   * VHMS menyimpan sel pertama saja ("27/09/2026 14:46:04") ke meta.
   * Mendukung dd/mm/yyyy, yyyy-mm-dd, dan epoch detik (bila terbaca angka).
   * @returns {{epoch:number, iso:string}|null}
   */
  function parseStampDate(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    // Buang sisa "|tz|dst" bila ada.
    s = s.split('|')[0].trim();
    var d = null;
    var mdy = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);       // yyyy-mm-dd
    if (mdy) {
      d = new Date(parseInt(mdy[1], 10), parseInt(mdy[2], 10) - 1, parseInt(mdy[3], 10));
    } else {
      var dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);   // dd/mm/yyyy
      if (dmy) {
        var yr = parseInt(dmy[3], 10); if (yr < 100) yr += 2000;
        d = new Date(yr, parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10));
      }
    }
    if (!d || isNaN(d.getTime())) return null;
    function p2(n) { return String(n).padStart(2, '0'); }
    return {
      epoch: d.getTime(),
      iso: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    };
  }

  /* -----------------------------------------------------------------------
   * 3. Deteksi tipe matriks
   * --------------------------------------------------------------------- */

  function isClutchType(dataType) {
    var t = String(dataType == null ? '' : dataType).trim().toUpperCase();
    return t === 'DA' || t === 'D9';
  }

  /** Nama berkas -> apakah ini berkas matriks clutch? (fallback deteksi) */
  function isClutchFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    return /clutch[_-]?(slip|therm)/.test(n);
  }

  /**
   * Judul -> jenis matriks bila `dataType` tidak tersedia.
   * 'DA' = slip time, 'D9' = thermal load.
   */
  function kindFromTitle(title) {
    var t = String(title == null ? '' : title).toLowerCase();
    if (/slip/.test(t)) return 'slip';
    if (/thermal/.test(t)) return 'thermal';
    return null;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser matriks
   * --------------------------------------------------------------------- */

  /**
   * Parse teks berkas matriks clutch.
   *
   * @param {string} text  isi berkas `clutch_slip.CSV` / `clutch_therm.CSV`
   * @param {object} [opts]
   *   - dataType : tipe dari VHMS_PARSER.parse() (opsional, 'DA'|'D9')
   *   - sourceName : nama berkas (untuk pesan & cadangan deteksi)
   * @returns {object} {
   *     kind, dataType, dataTitle, unit, meta,
   *     positions: { <Posisi>: { row, counts[], total, saturated,
   *                              saturatedAreas[], severity, severityMin, maxArea } },
   *     severity:      { <Posisi>: number },
   *     severityRank:  [ { position, severity, saturated, severityMin } ... ],
   *     topPosition, maxSeverity, anySaturated,
   *     warnings: []
   *   }
   * --------------------------------------------------------------------- */
  function parseClutchMatrix(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r\n|\n|\r/);

    var result = {
      kind: null,
      dataType: '',
      dataTitle: '',
      unit: '',
      // [ISTILAH 2026-10-13] Judul & satuan sumbu APA ADANYA dari berkas.
      // Dipakai UI untuk memberi tahu operator "area" ini area apa
      // (mis. "Slip time area" / "Clutch area"), bukan sekadar "Area 3".
      xAxisTitle: '',
      xAxisScale: '',
      yAxisTitle: '',
      yAxisScale: '',
      meta: {},
      positions: {},
      severity: {},
      severityRank: [],
      topPosition: null,
      maxSeverity: 0,
      anySaturated: false,
      warnings: []
    };

    var section = '';
    var columnCount = 0;
    var inData = false;
    var sawData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      // --- Judul bagian [xxx] ---
      var secMatch = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (secMatch) {
        section = secMatch[1].toLowerCase();
        inData = /^data/.test(section);
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);

      // --- Header umum / display ---
      if (section === 'common header' || section === 'version information' ||
          section === 'display information') {
        var key = String(cells[0] || '').trim();
        var val = cells.length > 1 ? String(cells[1] || '').trim() : '';
        if (key) result.meta[key.toLowerCase()] = val;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = val || result.dataType;
          result.dataTitle = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        // Satuan sumbu-Z ("Count") hanya informatif; tidak wajib.
        if (/^column item$/i.test(key)) {
          // FIXTURE: "Column Item,0,1,2,3,4,5,6" -> jumlah area = sel - 1
          columnCount = Math.max(0, cells.length - 1);
        }
        // [ISTILAH] Simpan judul & satuan sumbu X apa adanya dari berkas.
        // Baris: "X Axis Title & X Axis Scale,Slip time area,"
        if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxisTitle = val;
          result.xAxisScale = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        // Judul & satuan sumbu Y (biasanya "Clutch Position").
        if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxisTitle = val;
          result.yAxisScale = cells.length > 2 ? String(cells[2] || '').trim() : '';
        }
        continue;
      }

      // --- Blok data ---
      if (!inData) continue;

      // Baris "Column Item,..." bisa muncul di blok display; sokong juga
      // bila exporter menaruhnya setelah [Data].
      if (/^column item$/i.test(String(cells[0] || '').trim())) {
        columnCount = Math.max(0, cells.length - 1);
        continue;
      }

      var pos = normalizePosition(cells[0]);
      if (pos === null) {
        // Bukan baris posisi clutch -> abaikan (mis. baris catatan).
        continue;
      }
      sawData = true;

      // Baca tiap area mulai kolom ke-1.
      var counts = [];
      for (var c = 1; c < cells.length; c++) {
        counts.push(toNumber(cells[c]));
      }
      // Samakan panjang area dengan columnCount (bila diketahui).
      if (columnCount && counts.length !== columnCount) {
        if (counts.length > columnCount) counts = counts.slice(0, columnCount);
        else while (counts.length < columnCount) counts.push(null);
      }

      result.positions[pos] = buildPosition(pos, counts);
    }

    if (!sawData) {
      result.warnings.push(
        'Tidak ada baris posisi clutch yang terbaca. Periksa apakah berkas ' +
        'benar-benar clutch_slip.CSV / clutch_therm.CSV.');
      return result;
    }

    // --- Kelengkapan metadata & jenis matriks ---
    result.dataType = String(opts.dataType || result.dataType || '').trim();
    if (!result.kind) {
      result.kind = (result.dataType.toUpperCase() === 'DA') ? 'slip'
                  : (result.dataType.toUpperCase() === 'D9') ? 'thermal'
                  : (kindFromTitle(result.dataTitle + ' ' + (opts.sourceName || '')) || 'unknown');
    }
    result.unit = (result.kind === 'thermal') ? 'count' : 'count';
    // [ISTILAH 2026-10-13] Judul sumbu X baku bila berkas tidak menyediakan
    // (varian exporter lama). Dipakai UI untuk memberi judul kolom area.
    if (!result.xAxisTitle) {
      result.xAxisTitle = AXIS_TITLE_DEFAULT[result.kind] || 'Area';
    }
    if (!result.yAxisTitle) result.yAxisTitle = 'Clutch Position';

    // --- [R4-HD] Cap waktu snapshot (untuk pemotongan overhaul / CLC) ---
    // `Time Stamp` disimpan di meta (huruf kecil) oleh loop header di atas
    // dengan NAMA APA ADANYA (mis. "time stamp" — masih ada spasi). Cari
    // longgar: buang spasi/tanda lalu cocokkan "timestamp".
    var tsRaw = null;
    Object.keys(result.meta).forEach(function (mk) {
      var norm = String(mk).toLowerCase().replace(/[\s._\-]/g, '');
      if (/^timestamp$/.test(norm) && tsRaw === null) tsRaw = result.meta[mk];
    });
    result.capturedAt = parseStampDate(tsRaw);
    // Status pomotongan (diisi applyOverhaulCut). Default: tidak dipotong.
    result.cut = false;
    result.cutReason = '';
    result.overhaulDate = null;

    // --- Susun peringkat keparahan ---
    var rank = [];
    Object.keys(result.positions).forEach(function (p) {
      var entry = result.positions[p];
      result.severity[p] = entry.severity;
      if (entry.severity > result.maxSeverity) result.maxSeverity = entry.severity;
      if (entry.saturated) result.anySaturated = true;
      rank.push({
        position: p,
        severity: entry.severity,
        severityMin: entry.severityMin,
        saturated: entry.saturated,
        saturatedAreas: entry.saturatedAreas,
        fillParam: POSITION_PARAM[p] || null
      });
    });

    // Urut: severity desc; seri -> jumlah area bersaturasi desc (lebih pasti
    // berarti), lalu urutan posisi baku agar deterministik.
    var orderIdx = {};
    POSITION_ORDER.forEach(function (p, ix) { orderIdx[p] = ix; });
    rank.sort(function (a, b) {
      if (b.severity !== a.severity) return b.severity - a.severity;
      var as = (a.saturatedAreas || []).length, bs = (b.saturatedAreas || []).length;
      if (as !== bs) return bs - as;
      return (orderIdx[a.position] !== undefined ? orderIdx[a.position] : 999) - (orderIdx[b.position] !== undefined ? orderIdx[b.position] : 999);
    });
    result.severityRank = rank;
    result.topPosition = rank.length ? rank[0].position : null;

    // --- Peringatan kejujuran data ---
    if (result.anySaturated) {
      // Tulis dengan KATA, bukan simbol "<="/">=": string ini ditampilkan
      // lewat esc() di UI, dan tanda kurung sudut akan di-escape menjadi
      // entitas yang membingungkan bila tercampur teks biasa.
      result.warnings.push(
        'Ada sel bersaturasi: nilai sama dengan ' + SATURATION + ', yang berarti ' +
        '"setidaknya ' + SATURATION + '" \u2014 bukan angka pasti. Skor keparahan ' +
        'posisi terkait dilaporkan sebagai BATAS BAWAH.');
    }
    if (columnCount && columnCount <= SEVERITY_AREA_MIN) {
      result.warnings.push(
        'Jumlah area (' + columnCount + ') <= ' + SEVERITY_AREA_MIN +
        ' sehingga seluruh sel diabaikan oleh indeks keparahan.');
    }

    return result;
  }

  /**
   * Bentuk entri satu posisi clutch dari deret `counts`.
   * @param {string} position
   * @param {array}  counts  jumlah per AREA (0..n-1), boleh null
   * @returns {object}
   */
  function buildPosition(position, counts) {
    var total = 0, hasTotal = false;
    var saturated = false;
    var saturatedAreas = [];
    var severity = 0, severityMin = 0;
    var maxArea = -1;
    var maxAreaCount = null;

    for (var b = 0; b < counts.length; b++) {
      var v = counts[b];
      if (v === null || v === undefined || isNaN(v)) continue;
      total += v; hasTotal = true;
      if (b > maxArea) { maxArea = b; maxAreaCount = v; }

      if (v >= SATURATION) {
        saturated = true;
        saturatedAreas.push(b);
      }

      var w = AREA_WEIGHTS[b];
      if (w === undefined) continue;         // area 0-2 diabaikan (D8)
      if (v >= SATURATION) {
        // Sel bersaturasi: nilai sebenarnya tak diketahui, hanya ">= BATAS".
        severityMin += SATURATION * w;       // batas bawah pasti
        // Untuk `severity` optimistis kita tetap pakai SATURATION; selisih
        // kedua angka ditampilkan agar pengguna tahu ada ketidakpastian.
        severity += SATURATION * w;
      } else {
        severity += v * w;
        severityMin += v * w;
      }
    }

    return {
      position: position,
      counts: counts.slice(),
      total: hasTotal ? total : null,
      saturated: saturated,
      saturatedAreas: saturatedAreas,
      severity: severity,
      severityMin: severityMin,
      maxArea: maxAreaCount === null ? -1 : maxArea,
      maxAreaCount: maxAreaCount
    };
  }

  /**
   * Hitung keparahan satu posisi dari deret counts (fungsi publik tipis).
   * @param {array} counts  jumlah per AREA
   * @returns {{severity:number, severityMin:number, saturated:boolean,
   *            saturatedAreas:number[]}}
   */
  function severityIndex(counts) {
    var e = buildPosition('_', counts || []);
    return {
      severity: e.severity,
      severityMin: e.severityMin,
      saturated: e.saturated,
      saturatedAreas: e.saturatedAreas
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Ringkasan untuk UI / ranking
   * --------------------------------------------------------------------- */

  /**
   * Ringkas matriks menjadi angka siap-tampil. Aman dipanggil dengan
   * `null`/objek kosong (mengembalikan objek "tidak ada data").
   *
   * @param {object} matrix hasil parseClutchMatrix()
   * @returns {object}
   */
  function summarize(matrix) {
    if (!matrix || !matrix.severityRank || !matrix.severityRank.length) {
      return { available: false, topPosition: null, maxSeverity: 0, anySaturated: false, positions: [] };
    }
    return {
      available: true,
      kind: matrix.kind,
      topPosition: matrix.topPosition,
      maxSeverity: matrix.maxSeverity,
      maxSeverityMin: matrix.severityRank[0] ? matrix.severityRank[0].severityMin : 0,
      anySaturated: matrix.anySaturated,
      positions: matrix.severityRank.map(function (r) {
        return { position: r.position, severity: r.severity, severityMin: r.severityMin, saturated: r.saturated };
      }),
      warnings: matrix.warnings || []
    };
  }

  /* -----------------------------------------------------------------------
   * 6. [R4-HD] Pemotongan matriks setelah OVERHAUL (konsep CLC)
   * ---------------------------------------------------------------------
   * Matriks clutch adalah counter KUMULATIF SEUMUR HIDUP. Setelah transmisi/
   * clutch di-overhaul, counter ECU TIDAK ter-reset -> unit baru di-overhaul
   * tetap tampak buruk. Mengikuti konsep CLC (Component Life Cut-off), data
   * sebelum pemasangan komponen terakhir dibuang.
   *
   * Karena matriks tidak punya cap waktu per-sel, pemotongan dilakukan pada
   * TINGKAT MATRIKS:
   *   cut  bila  capturedAt(mat[[s]] < overhaulDate            (kepastian TINGGI)
   *   cut  bila  opts.ageHoursAtOverhaul >= opts.matrixAgeHours (kepastian SEDANG)
   * Bila ragu (tanggal tak tersedia) -> JANGAN potong (prinsip CLC: salah
   * potong lebih berbahaya daripada tidak potong).
   *
   * Fungsi ini MURNI (tidak memutasi di luar objek matriks yang diberikan)
   * dan selalu mengembalikan keputusan, tidak pernah melempar.
   *
   * @param {object} matrix  hasil parseClutchMatrix()
   * @param {object} [opts]
   *   - overhaulDate   : {epoch, iso} | Date | number(ms) | string -> tanggal overhaul
   *   - matrixAgeHours : umur matriks (jam) bila diketahui
   *   - ageHoursAtOverhaul : umur komponen sejak overhaul (jam) bila diketahui
   *   - component      : nama komponen sumber (informatif)
   *   - source         : keterangan sumber tanggal (mis. 'LastTecoDate')
   * @returns {{cut:boolean, basis:string, confidence:string, reason:string,
   *            overhaulDate:object|null}}
   * --------------------------------------------------------------------- */
  function _toEpochObj(d) {
    if (d === null || d === undefined) return null;
    if (typeof d === 'object' && d.epoch != null) return d;
    var ms = null;
    if (typeof d === 'number') ms = d;
    else if (d instanceof Date) ms = d.getTime();
    else {
      var parsed = parseStampDate(String(d));
      if (parsed) return parsed;
      var t = Date.parse(String(d));
      if (!isNaN(t)) ms = t;
    }
    if (ms === null || isNaN(ms)) return null;
    var dd = new Date(ms);
    function p2(n) { return String(n).padStart(2, '0'); }
    return { epoch: ms, iso: dd.getFullYear() + '-' + p2(dd.getMonth() + 1) + '-' + p2(dd.getDate()) };
  }

  function applyOverhaulCut(matrix, opts) {
    opts = opts || {};
    var out = { cut: false, basis: '', confidence: '', reason: '', overhaulDate: null };
    if (!matrix || typeof matrix !== 'object') { out.reason = 'matriks tidak ada'; return out; }

    var od = _toEpochObj(opts.overhaulDate);
    out.overhaulDate = od;
    matrix.overhaulDate = od;

    // Tier 1: tanggal (paling pasti).
    if (od && od.epoch != null && matrix.capturedAt && matrix.capturedAt.epoch != null) {
      out.basis = 'date';
      out.confidence = 'tinggi';
      if (matrix.capturedAt.epoch < od.epoch) {
        out.cut = true;
        out.reason = 'Snapshot matriks (' + matrix.capturedAt.iso + ') diambil SEBELUM ' +
          'overhaul ' + od.iso + ' — matriks berisi riwayat pra-overhaul.';
      } else {
        out.reason = 'Snapshot matriks (' + matrix.capturedAt.iso + ') sesudah overhaul ' +
          od.iso + ' — matriks tetap dipakai.';
      }
    } else if (typeof opts.ageHoursAtOverhaul === 'number' && typeof opts.matrixAgeHours === 'number') {
      // Tier 2: HM relatif (kurang pasti). Potong bila umur matriks < umur
      // sejak overhaul, artinya matriks mayoritas terbentuk sebelum overhaul.
      out.basis = 'hm';
      out.confidence = 'sedang';
      if (opts.matrixAgeHours < opts.ageHoursAtOverhaul) {
        out.cut = true;
        out.reason = 'Umur matriks (' + opts.matrixAgeHours.toFixed(0) + ' jam) lebih pendek ' +
          'dari umur sejak overhaul (' + opts.ageHoursAtOverhaul.toFixed(0) + ' jam) — ' +
          'matriks didominasi riwayat pra-overhaul.';
      } else {
        out.reason = 'Umur matriks mencakup periode pasca-overhaul.';
      }
    } else {
      // Tier 3: ragu -> JANGAN potong (prinsip CLC).
      out.basis = 'none';
      out.confidence = '';
      out.reason = od
        ? 'Tanggal overhaul diketahui (' + od.iso + ') tetapi cap waktu snapshot matriks tidak tersedia — potong dibatalkan (ragu).'
        : 'Tanggal overhaul tidak tersedia — potong dibatalkan (ragu).';
    }

    matrix.cut = out.cut;
    matrix.cutReason = out.reason;
    matrix.cutBasis = out.basis;
    matrix.cutConfidence = out.confidence;
    if (opts.source) matrix.overhaulSource = opts.source;
    if (opts.component) matrix.overhaulComponent = opts.component;
    return out;
  }

  /* -----------------------------------------------------------------------
   * 7. Gerbang kewarasan duty termal (\u00A72 D9 \u00b7 dipakai T6)
   * ---------------------------------------------------------------------
   * Kolom durasi (*Rtd* / *Exh*Over*) menyatakan DETIK sebuah suhu berada di
   * atas ambang SELAMA SATU INTERVAL. Nilai yang lebih besar dari durasi
   * interval itu sendiri adalah mustahil.
   *
   * ATURAN (konservatif):
   *   suspect  bila  deltaSec > RASIO × (Δ SMR dalam detik)
   *   RASIO = 0,05 (5 %) -> jauh di bawah batas teoretis 100 %, tetapi
   *   cukup untuk menangkap lonjakan sensor seperti RR Exh >800 °C yang
   *   bernilai 590.649 detik pada interval ±2.004 jam (ambang ≈ 360.720 s).
   *
   * Fungsi ini MURNI: tidak memutasi records, hanya mengembalikan daftar
   * temuan agar pemanggil (vhms-validate) yang memutuskan penandaan.
   *
   * @param {array} records  record trend (terurut SMR naik)
   * @param {object} [opts]
   *   - ratio : override ambang (default 0.05)
   *   - keys  : daftar kunci kolom-durasi. Default: seluruh key PARAMS yang
   *             bertanda `delta: true`.
   *   - config: VHMS_CONFIG (bila tidak ingin membaca global)
   * @returns {{ findings: array, suspectKeys: object }}
   * --------------------------------------------------------------------- */
  var THERMAL_SANITY_RATIO = 0.05;

  function thermalSanityFindings(records, opts) {
    opts = opts || {};
    var ratio = (opts.ratio !== undefined) ? opts.ratio : THERMAL_SANITY_RATIO;
    var cfg = opts.config || global.VHMS_CONFIG || {};
    var params = cfg.PARAMS || {};

    var keys = opts.keys;
    if (!keys) {
      keys = Object.keys(params).filter(function (k) {
        return params[k] && params[k].delta === true;
      });
    }

    var findings = [];
    var suspectKeys = {};
    var recs = records || [];
    if (!recs.length || !keys.length) return { findings: findings, suspectKeys: suspectKeys };

    for (var i = 1; i < recs.length; i++) {
      var prev = recs[i - 1], cur = recs[i];
      if (!prev || !cur) continue;
      if (prev.smr === null || prev.smr === undefined || isNaN(prev.smr)) continue;
      if (cur.smr === null || cur.smr === undefined || isNaN(cur.smr)) continue;

      var dSmr = cur.smr - prev.smr;            // jam
      if (!(dSmr > 0)) continue;                 // lompatan tak wajar / duplikat
      var limitSec = dSmr * 3600 * ratio;

      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var v = cur[key];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (v > limitSec) {
          suspectKeys[key] = true;
          findings.push({
            key: key,
            smr: cur.smr,
            prevSmr: prev.smr,
            deltaSec: v,
            intervalHours: dSmr,
            limitSec: limitSec,
            ratio: (v / (dSmr * 3600))
          });
        }
      }
    }

    return { findings: findings, suspectKeys: suspectKeys };
  }

  /* -----------------------------------------------------------------------
   * 7. Ekspor
   * --------------------------------------------------------------------- */
  global.VHMS_CLUTCH = {
    SATURATION: SATURATION,
    AREA_WEIGHTS: AREA_WEIGHTS,
    SEVERITY_AREA_MIN: SEVERITY_AREA_MIN,
    AXIS_TITLE_DEFAULT: AXIS_TITLE_DEFAULT,
    POSITION_ORDER: POSITION_ORDER,
    POSITION_PARAM: POSITION_PARAM,
    THERMAL_SANITY_RATIO: THERMAL_SANITY_RATIO,

    isClutchType: isClutchType,
    isClutchFileName: isClutchFileName,
    normalizePosition: normalizePosition,

    parseClutchMatrix: parseClutchMatrix,
    severityIndex: severityIndex,
    summarize: summarize,
    applyOverhaulCut: applyOverhaulCut,
    parseStampDate: parseStampDate,
    OVERHAUL_COMPONENT_RE: OVERHAUL_COMPONENT_RE,
    thermalSanityFindings: thermalSanityFindings
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_CLUTCH;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * vhms-steering.js
 * -------------------------------------------------------------------------
 * [D375A 2026-10-14 — T2] Penafsir EMPAT berkas steering clutch & brake
 * dozer D375A (`CHK0001/`). Khas dozer: tidak ada padanannya di HD785
 * maupun PC2000 (haul truck & excavator tidak punya steering clutch/brake).
 *
 *   '25' loadmstlc.CSV   S/T L Clutch Load Map
 *   '24' loadmstrc.CSV   S/T R Clutch Load Map
 *   '27' loadmstlb.CSV   S/T L Brake  Load Map
 *   '26' loadmstrb.CSV   S/T R Brake  Load Map
 *
 * BENTUK (terverifikasi pada SN 19559, SMR 28 812,1 h)
 *   X = `Travel Speed` (0,1 km/h)   9 band "0 - 20","- 40",…,"160 -"
 *   Y = `<sisi> <Clutch|Brake> Press` (10 kPa)
 *                                   8 band "0 - 50","- 75",…,"200 -"
 *   Z = `Time, sec`  ·  Sampling 1000 msec  ·  Column Rate 1
 *   Σ tiap berkas = 103 569 9xx s = 28 769 h = 99,9 % SMR
 *
 * =========================================================================
 * ⚠⚠ PEMBALIKAN TIPE YANG WAJIB DIINGAT
 * =========================================================================
 *   '24' = KANAN (R)  ·  '25' = KIRI (L)
 *   '26' = KANAN (R)  ·  '27' = KIRI (L)
 *
 * Urutan ini BERLAWANAN INTUISI (orang mengira angka lebih kecil = kiri).
 * Menukarnya membalik SELURUH kesimpulan asimetri tanpa error apa pun —
 * 0,57 menjadi 1,75. Peta di bawah diambil dari baris `Data Type & Title`
 * masing-masing berkas, BUKAN dari pola angka. Jangan "merapikan" peta ini.
 *
 * =========================================================================
 * ⚠⚠ PAGAR KEJUJURAN — BAGIAN TERPENTING MODUL INI
 * =========================================================================
 * Modul ini MENGUKUR asimetri, dan HANYA itu. Ia TIDAK menafsirkan ARAH.
 *
 * Yang sah dan dilaporkan:
 *   - besar asimetri kiri/kanan (rasio tanpa satuan),
 *   - bukti bahwa denominatornya identik (waktu "bergerak" L == R),
 *     sehingga asimetri itu NYATA, bukan artefak basis data.
 *
 * Yang SENGAJA TIDAK dilakukan:
 *   - menyatakan "bias menikung kiri" / "final drive kiri lebih berat",
 *   - menyimpulkan sisi mana yang lebih sering DILEPAS,
 *   - merekomendasikan tindakan apa pun.
 *
 * ALASAN: pada dozer steering-clutch-&-brake, konvensi umumnya tekanan
 * TINGGI = clutch ENGAGED (lurus) dan tekanan TURUN = disengaged (menikung).
 * Bila benar, rasio 0,57 berarti sisi KIRI lebih sering dilepas. TETAPI
 * konvensi itu BELUM diverifikasi dari Shop Manual D375A-5. Menyimpulkan
 * arah tanpa sumber = mengarang, dan itu kelas kesalahan yang paling mahal
 * di proyek ini (lihat J5 di dokumen spesifikasi).
 *
 * Karena itu setiap ringkasan membawa `directionNote` yang WAJIB ditampilkan
 * panel (`ST-9` menguji kata "Shop Manual" benar-benar muncul di UI).
 *
 * =========================================================================
 * TANPA AMBANG ABSOLUT
 * =========================================================================
 * Tidak ada satu pun angka Shop Manual D375A di proyek ini. Semua metrik
 * adalah RASIO antara dua sisi unit yang SAMA — self-referential, sehingga
 * sah TANPA rujukan pabrik.
 *
 * Tapi hati-hati: simetri BUKAN "lulus". `asym = 1,00` berarti seimbang —
 * itu TEMUAN juga (beban merata), bukan nilai bagus. Dan `asymClutch`
 * TIDAK boleh dibandingkan dengan `asymBrake` seolah satu skala: keduanya
 * punya rentang tekanan kerja yang berbeda.
 *
 * PRINSIP PROYEK
 *   - `parse()` MURNI atas teks masukan.
 *   - `null` != `0`.
 *   - Logika band dipinjam dari `VHMS_LOADMAP.resolveBands`.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Peta tipe -> (sisi, komponen)
   * --------------------------------------------------------------------- */

  var SIDE_L = 'left';
  var SIDE_R = 'right';
  var PART_CLUTCH = 'clutch';
  var PART_BRAKE = 'brake';

  /**
   * Peta Data Type -> { side, part, kind }.
   * Sumber: baris `Data Type & Title` tiap berkas + `index00.csv`.
   * ⚠ 24=KANAN, 25=KIRI — lihat catatan kepala berkas.
   */
  var TYPE_MAP = {
    '25': { side: SIDE_L, part: PART_CLUTCH, kind: 'lClutch' },
    '24': { side: SIDE_R, part: PART_CLUTCH, kind: 'rClutch' },
    '27': { side: SIDE_L, part: PART_BRAKE, kind: 'lBrake' },
    '26': { side: SIDE_R, part: PART_BRAKE, kind: 'rBrake' }
  };

  var KIND_LABEL = {
    lClutch: 'Steering clutch KIRI',
    rClutch: 'Steering clutch KANAN',
    lBrake: 'Steering brake KIRI',
    rBrake: 'Steering brake KANAN'
  };

  /** Detik per jam — satu-satunya konversi satuan di modul ini. */
  var SEC_PER_HOUR = 3600;

  /**
   * Kalimat pagar yang WAJIB tampil di panel (diuji `ST-9`).
   * Ditaruh sebagai konstanta agar tidak bisa hilang tanpa terlihat.
   */
  var DIRECTION_NOTE = 'Arah tafsir (sisi mana yang lebih sering dilepas) ' +
    'menunggu konfirmasi Shop Manual D375A-5.';

  /* -----------------------------------------------------------------------
   * 2. Deteksi & utilitas
   * --------------------------------------------------------------------- */

  function normType(t) { return String(t == null ? '' : t).trim().toUpperCase(); }

  function isSteeringType(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_MAP, normType(type));
  }

  function kindFromType(type) {
    var e = TYPE_MAP[normType(type)];
    return e ? e.kind : null;
  }

  function sideOfType(type) {
    var e = TYPE_MAP[normType(type)];
    return e ? e.side : null;
  }

  /**
   * Cadangan dari NAMA BERKAS bila `dataType` tidak terbaca.
   * BERJANGKAR — pelajaran J4: catch-all pernah mencaplok 14 berkas D375A.
   * Pola: `loadmst` + [lr] + [cb]  -> `loadmstlc` (L clutch), `loadmstrb` (R brake).
   */
  function kindFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    var m = /(^|[\\/])loadmst([lr])([cb])(\.csv)?$/.exec(n);
    if (!m) return null;
    var side = m[2] === 'l' ? SIDE_L : SIDE_R;
    var part = m[3] === 'c' ? PART_CLUTCH : PART_BRAKE;
    return (side === SIDE_L ? 'l' : 'r') + (part === PART_CLUTCH ? 'Clutch' : 'Brake');
  }

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

  /** Lengkapi batas bawah band — dipinjam dari VHMS_LOADMAP (satu sumber). */
  function resolveBands(labels) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') return lm.resolveBands(labels);
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

  function bandLow(b) {
    if (!b) return null;
    return (b.lo !== null && b.lo !== undefined) ? b.lo : b.hi;
  }

  /* -----------------------------------------------------------------------
   * 3. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse satu berkas steering clutch/brake.
   *
   * @param {string} text
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} { kind, side, part, dataType, dataTitle, meta,
   *   rowLabels[], colLabels[], matrix[][], xAxis, yAxis, zAxis,
   *   totalSec, hours, secondsValid, stats, warnings[] }
   * @throws {Error} bila blok [Data] tidak ada atau kosong
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: null, side: null, part: null,
      dataType: '', dataTitle: '',
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      totalSec: 0, hours: null, secondsValid: false,
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
        else inData = false;
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
          var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();
          result.meta[key] = val;
        }
        continue;
      }

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

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas steering clutch/brake.');
    if (!result.matrix.length) throw new Error('Berkas steering clutch/brake tidak mengandung baris data.');

    // --- Identitas: sisi & komponen ---
    result.dataType = normType(opts.dataType || result.dataType);
    result.kind = kindFromType(result.dataType) || kindFromFileName(opts.sourceName || '');
    if (!result.kind) {
      result.warnings.push('Jenis berkas steering tidak dapat ditentukan dari tipe "' +
        result.dataType + '" maupun nama berkas "' + (opts.sourceName || '') + '".');
      return result;
    }
    result.side = result.kind.charAt(0) === 'l' ? SIDE_L : SIDE_R;
    result.part = /Clutch$/.test(result.kind) ? PART_CLUTCH : PART_BRAKE;
    result.label = KIND_LABEL[result.kind] || result.kind;

    // --- Satuan sumbu Z: WAJIB detik ---
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    result.secondsValid = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (!result.secondsValid) {
      result.warnings.push('Satuan sumbu Z terbaca "' + (result.zAxis.unit || '(kosong)') +
        '", bukan detik — nilai jam TIDAK dilaporkan.');
    }

    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.totalSec = total;
    result.hours = result.secondsValid ? (total / SEC_PER_HOUR) : null;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — tidak ada data untuk dianalisis.');
      return result;
    }

    result.stats = buildStats(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 4. Statistik per berkas — semua RELATIF, tanpa ambang
   * --------------------------------------------------------------------- */

  /**
   * Metrik per sisi.
   *
   * `movingSec` = seluruh band kecepatan KECUALI band pertama. Ini penting:
   *   - ia menjadi DENOMINATOR asimetri. Bila waktu "bergerak" kiri dan kanan
   *     identik (terbukti pada unit contoh: 18 833 h dua-duanya), maka
   *     perbedaan `activeSec`/`topBandSec` adalah asimetri OPERASIONAL yang
   *     nyata, bukan artefak lama perekaman.
   *   - ia juga dipakai untuk memisahkan "tekanan saat mesin diam" dari
   *     "tekanan saat benar-benar berjalan" — basis penuh menenggelamkan
   *     temuan (pelajaran `slopeZones` di `vhms-dutymap.js`).
   */
  function buildStats(res) {
    var rowBands = resolveBands(res.rowLabels);   // tekanan (10 kPa)
    var total = res.totalSec;
    if (total <= 0) return null;

    var rowSums = res.matrix.map(function (r) {
      return r.reduce(function (a, b) { return a + b; }, 0);
    });

    var nRows = res.matrix.length;
    var nCols = res.colLabels.length || (res.matrix[0] ? res.matrix[0].length : 0);

    // Waktu "bergerak" = seluruh kolom kecuali kolom kecepatan pertama.
    var movingSec = 0, stillSec = 0;
    for (var i = 0; i < nRows; i++) {
      for (var j = 0; j < nCols; j++) {
        var v = res.matrix[i][j] || 0;
        if (j === 0) stillSec += v; else movingSec += v;
      }
    }

    // "Aktif" = tekanan DI ATAS band tekanan terendah. Band terendah
    // menampung keadaan tanpa tekanan (kopling/rem bebas) — memasukkannya
    // akan menenggelamkan sinyal, persis seperti band kecepatan pertama.
    var activeSec = 0;
    for (var r2 = 1; r2 < nRows; r2++) activeSec += rowSums[r2];

    // Band tekanan TERTINGGI = baris terakhir (label terbuka "200 -").
    var topBandSec = nRows ? rowSums[nRows - 1] : 0;
    var topBandLabel = nRows ? res.rowLabels[nRows - 1] : null;

    function hrs(s) { return res.secondsValid ? (s / SEC_PER_HOUR) : null; }

    return {
      totalSec: total,
      hours: hrs(total),
      stillSec: stillSec, stillHours: hrs(stillSec), stillShare: 100 * stillSec / total,
      /** Waktu bergerak — DENOMINATOR asimetri. Harus identik L vs R. */
      movingSec: movingSec, movingHours: hrs(movingSec), movingShare: 100 * movingSec / total,
      /** Tekanan di atas band terendah. */
      activeSec: activeSec, activeHours: hrs(activeSec), activeShare: 100 * activeSec / total,
      /** Band tekanan tertinggi ("200 -"). */
      topBandSec: topBandSec, topBandHours: hrs(topBandSec), topBandShare: 100 * topBandSec / total,
      topBandLabel: topBandLabel,
      pressureRows: res.rowLabels.map(function (lbl, k) {
        return {
          label: lbl, sec: rowSums[k], hours: hrs(rowSums[k]),
          share: 100 * rowSums[k] / total,
          /** Pangsa DI DALAM waktu bergerak — basis kedua, lebih tajam. */
          movShare: movingSec > 0 ? (100 * rowSums[k] / movingSec) : null
        };
      }),
      thresholdsUsed: {},
      basisNote: 'Basis "bergerak" = seluruh band kecepatan KECUALI band pertama (' +
        (res.colLabels[0] || '?') + '). Basis "aktif" = tekanan di atas band terendah (' +
        (res.rowLabels[0] || '?') + '). Keduanya proksi struktural dari berkas, ' +
        'bukan sinyal eksplisit.'
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Agregat lintas-berkas — INTI modul ini: ASIMETRI KIRI vs KANAN
   * --------------------------------------------------------------------- */

  /**
   * Bandingkan sisi KIRI dan KANAN untuk satu komponen (clutch atau brake).
   *
   * Semua rasio = nilai KIRI / nilai KANAN. `1,00` = seimbang.
   *
   * @param {object} leftRes  hasil parse sisi kiri (atau null)
   * @param {object} rightRes hasil parse sisi kanan (atau null)
   * @param {string} part `'clutch'` | `'brake'`
   * @returns {object|null}
   */
  function compareSides(leftRes, rightRes, part) {
    if (!leftRes || !rightRes) return null;
    if (leftRes.part !== part || rightRes.part !== part) return null;
    var lt = leftRes.stats, rt = rightRes.stats;
    if (!lt || !rt) return null;

    /**
     * Rasio aman: null bila pembagi bukan angka positif.
     * `null` != `1`: `null` berarti tidak terukur, `1` berarti benar-benar
     * seimbang. Membedakannya penting — lihat aturan proyek.
     */
    function ratio(a, b) {
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      if (!isFinite(a) || !isFinite(b) || b <= 0) return null;
      return a / b;
    }

    /**
     * Bukti bahwa kedua sisi mengukur rentang waktu yang SETARA.
     * Rasio `movingSec` dekat 1,00 -> perbandingan sah.
     * Bila tidak setara, asimetri bisa jadi artefak cakupan perekaman.
     */
    var evidence = ratio(lt.movingSec, rt.movingSec);
    var basisComparable = (evidence !== null && Math.abs(evidence - 1) <= 0.02);

    var asymActive = ratio(lt.activeSec, rt.activeSec);
    var asymTop = ratio(lt.topBandSec, rt.topBandSec);
    var asymMoving = ratio(lt.movingSec, rt.movingSec);

    // Selisih dalam POIN PERSEN (bukan rasio) — lebih mudah dibaca untuk
    // selisih kecil, dan tetap sahih karena satuan kedua sisi sama.
    var activeDeltaPct = lt.activeShare - rt.activeShare;
    var topDeltaPct = lt.topBandShare - rt.topBandShare;

    return {
      part: part,
      secondsValid: !!(leftRes.secondsValid && rightRes.secondsValid),

      leftKind: leftRes.kind, rightKind: rightRes.kind,
      leftHours: lt.hours, rightHours: rt.hours,

      /** Denumerator yang sama-sama dipakai — bukti perbandingan sah. */
      leftMovingHours: lt.movingHours, rightMovingHours: rt.movingHours,
      movingEvidenceRatio: evidence,
      basisComparable: basisComparable,

      /** Rasio KIRI/KANAN. 1,00 = seimbang. null = tidak terukur. */
      asymActive: asymActive,
      asymTopBand: asymTop,
      asymMoving: asymMoving,
      activeDeltaPct: activeDeltaPct,
      topDeltaPct: topDeltaPct,

      leftTopBandLabel: lt.topBandLabel, rightTopBandLabel: rt.topBandLabel,
      leftStats: lt, rightStats: rt,

      /**
       * Kalimat pagar — WAJIB ditampilkan panel. Modul HANYA melaporkan
       * besar asimetri, TIDAK menafsirkan arah. Lihat catatan kepala berkas.
       */
      directionNote: DIRECTION_NOTE,
      /** Selalu true: modul ini tidak pernah memberi vonis arah. */
      directionDeferred: true,
      basisNote: 'Rasio = KIRI / KANAN. 1,00 berarti seimbang — itu TEMUAN ' +
        '(beban merata), bukan nilai lulus. '
    };
  }

  /**
   * Gabungkan keempat berkas menjadi ringkasan siap-panel.
   *
   * Asimetri dihitung HANYA bila KEDUA sisi komponen itu tersedia — persis
   * pola `torqueDelta` di `vhms-loadmap.js`. Satu sisi saja -> null, dan
   * panel harus menulis "perlu kedua sisi", BUKAN menampilkan angka.
   *
   * @param {object} byKind peta `kind -> hasil parse()`
   * @returns {object|null}
   */
  function summarize(byKind) {
    if (!byKind) return null;
    var lc = byKind.lClutch || null, rc = byKind.rClutch || null;
    var lb = byKind.lBrake || null, rb = byKind.rBrake || null;
    if (!lc && !rc && !lb && !rb) return null;

    return {
      fileCount: (lc ? 1 : 0) + (rc ? 1 : 0) + (lb ? 1 : 0) + (rb ? 1 : 0),
      clutch: compareSides(lc, rc, PART_CLUTCH),
      brake: compareSides(lb, rb, PART_BRAKE),
      /** true bila ada komponen yang punya KEDUA sisi (asimetri dapat dihitung). */
      hasAnyPair: !!(compareSides(lc, rc, PART_CLUTCH) || compareSides(lb, rb, PART_BRAKE)),
      /** Daftar berkas yang belum ada — untuk pesan kejujuran data. */
      missing: ['lClutch', 'rClutch', 'lBrake', 'rBrake'].filter(function (k) {
        return !byKind[k];
      }),
      directionNote: DIRECTION_NOTE,
      /**
       * Peringatan tetap: JANGAN membandingkan asymClutch dengan asymBrake.
       * Keduanya punya rentang tekanan kerja berbeda, jadi rasionya tidak
       * berada pada satu skala yang sama.
       */
      crossPartNote: 'Rasio clutch dan brake TIDAK boleh dibandingkan satu ' +
        'sama lain sebagai satu skala — keduanya punya rentang tekanan kerja ' +
        'berbeda.'
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_STEERING = {
    SIDE_L: SIDE_L,
    SIDE_R: SIDE_R,
    PART_CLUTCH: PART_CLUTCH,
    PART_BRAKE: PART_BRAKE,
    TYPE_MAP: TYPE_MAP,
    KIND_LABEL: KIND_LABEL,
    DIRECTION_NOTE: DIRECTION_NOTE,
    ACCEPTED_TYPES: Object.keys(TYPE_MAP),
    isSteeringType: isSteeringType,
    kindFromType: kindFromType,
    kindFromFileName: kindFromFileName,
    sideOfType: sideOfType,
    resolveBands: resolveBands,
    parse: parse,
    buildStats: buildStats,
    compareSides: compareSides,
    summarize: summarize
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_STEERING;
  }
})(typeof window !== 'undefined' ? window : globalThis);

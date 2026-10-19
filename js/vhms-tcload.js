/* =========================================================================
 * vhms-tcload.js
 * -------------------------------------------------------------------------
 * [D375A 2026-10-14 — T1] Penafsir TIGA berkas torque-converter / lock-up
 * dari ekspor VHMS dozer D375A (`CHK0001/`):
 *
 *   '35'  loadmtc.CSV   T/C Load Map
 *        X = T/C Input Speed (rpm)   9 band "0 - 400","- 700",…,"2500 -"
 *        Y = T/C Speed Ratio (%)     8 band "0 - 20","- 40",…,"140 -"
 *        Z = Time, sec  ·  Sampling 1000 msec  ·  Column Rate 1
 *        -> DISTRIBUSI SPEED RATIO. Metrik keausan T/C paling langsung.
 *
 *   '34'  loadmlu.CSV   L/U Load Map
 *        X = T/C Input Speed (rpm)
 *        Y = T/C Input Torque (Nm)   8 band "0 - 3000","- 3500",…,"6000 -"
 *        Z = Time, sec
 *        -> JAM operasi dalam kondisi lock-up.
 *
 *   '88'  lu_sft0.CSV   L/U Shift Change Map
 *        Matriks 2x2 `L/U ON` <-> `L/U OFF`, Z = Count (bukan detik)
 *        -> JUMLAH siklus engage/disengage (dua arah, jadi /2).
 *
 * BUKTI ANGKA (SN 19559, SMR 28 812,1 h)
 *   '35' Σ = 93 950 808 s = 26 097 h = 90,6 % SMR
 *   '34' Σ =  9 619 193 s =  2 672 h =  9,3 % SMR
 *   '88' Σ =  2 263 216     =  1 131 608 siklus (dua arah x 1 131 608)
 *
 * =========================================================================
 * ⚠⚠ TIGA JEBAKAN YANG DITUTUP MODUL INI
 * =========================================================================
 *
 * J5b — BAND > 100 % BUKAN "LOCK-UP".
 *   Band `- 120` pada '35' = 12 614 h = 48,3 % — angka TERBESAR di berkas
 *   itu, dan sangat menggoda untuk disebut "lock-up". ITU SALAH: '34' hanya
 *   mencatat 2 672 h lock-up, selisih 5x lipat. Band > 100 % paling mungkin
 *   OVERRUN (output berputar lebih cepat dari input, mis. meluncur turun).
 *   Karena itu kunci-kunci di modul ini bernama `overrun*`, BUKAN `lockup*`,
 *   dan panel memakai kata "overrun" yang ditandai belum terkonfirmasi.
 *
 * T1.3 — DENOMINATOR PANGSA L/U.
 *   `luHours / (luHours + tcHours)` = 9,3 % adalah angka YANG SALAH DIPAKAI,
 *   sebab '35' memuat idle, netral, dan stall — jauh lebih luas dari waktu
 *   travel. Membandingkannya dengan "L/U 81,4 %" HD785 = membandingkan dua
 *   rasio dengan denominator berbeda. Yang benar:
 *       luShareOfTravel = luHours / travelHours   (travel dari berkas 44..49)
 *   = 2 672 / 19 834 = 13,5 %. Travel TIDAK tersedia di modul ini, jadi ia
 *   DIHITUNG DI STORE (`attachTcLoad`) dan bernilai `null` bila berkas
 *   matriks gigi belum ada.
 *
 * TANPA AMBANG ABSOLUT.
 *   Tidak ada satu pun angka Shop Manual D375A di proyek ini. Kebijakan sama
 *   dengan `vhms-gearload.js:41-69`. Hanya metrik relatif / self-referential
 *   yang dilaporkan. Menambahkan ambang = mengarang.
 *
 * PRINSIP PROYEK
 *   - `parse()` MURNI atas teks masukan; tidak membaca store, tidak memutasi.
 *   - `null` != `0`: `0` = terukur nol, `null` = tidak terukur/tidak berlaku.
 *   - Logika band DIPINJAM dari `VHMS_LOADMAP.resolveBands` (jangan duplikasi).
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Peta tipe
   * --------------------------------------------------------------------- */

  var KIND_RATIO = 'ratio';       // '35' distribusi T/C speed ratio
  var KIND_LU = 'lu';             // '34' jam lock-up
  var KIND_LUSHIFT = 'luShift';   // '88' siklus ON/OFF lock-up

  var TYPE_MAP = {
    '35': KIND_RATIO,
    '34': KIND_LU,
    '88': KIND_LUSHIFT
  };

  var KIND_LABEL = {};
  KIND_LABEL[KIND_RATIO] = 'Distribusi speed ratio torque converter';
  KIND_LABEL[KIND_LU] = 'Waktu lock-up';
  KIND_LABEL[KIND_LUSHIFT] = 'Siklus ON/OFF lock-up';

  var SEC_PER_HOUR = 3600;
  /** Satu siklus = satu pasang transisi ON->OFF dan OFF->ON. */
  var TRANSITIONS_PER_CYCLE = 2;

  /**
   * Ambang band speed-ratio untuk metrik deskriptif.
   * ---------------------------------------------------------------------
   * ⚠ INI BUKAN AMBANG OEM. Nilai dipilih dari SEBARAN berkas nyata: band
   * `0 - 20` adalah tempat converter benar-benar stall (slip maksimum, panas
   * maksimum). Batasnya mengikuti label band berkas itu sendiri, bukan angka
   * pabrik — sehingga tetap sah lintas unit model sama.
   */
  var STALL_RATIO_MAX = 20;    // batas atas band pertama

  /* -----------------------------------------------------------------------
   * 2. Deteksi & utilitas
   * --------------------------------------------------------------------- */

  function normType(t) { return String(t == null ? '' : t).trim().toUpperCase(); }

  function isTcLoadType(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_MAP, normType(type));
  }

  function kindFromType(type) { return TYPE_MAP[normType(type)] || null; }

  /** Cadangan dari NAMA BERKAS bila `dataType` tidak terbaca. */
  function kindFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    // BERJANGKAR — pelajaran J4 (vhms-loadmap.js): catch-all `/loadm/` pernah
    // mencaplok 14 berkas D375A. Di sini pola harus tepat.
    if (/(^|[\\/])lu_sft0(\.csv)?$/.test(n)) return KIND_LUSHIFT;
    if (/(^|[\\/])loadmlu(\.csv)?$/.test(n)) return KIND_LU;
    if (/(^|[\\/])loadmtc(\.csv)?$/.test(n)) return KIND_RATIO;
    return null;
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

  /**
   * Lengkapi batas bawah band — DIPINJAM dari `VHMS_LOADMAP.resolveBands`
   * agar aturan band hanya ada di SATU tempat (menduplikasinya pernah jadi
   * sumber bug B7).
   */
  function resolveBands(labels) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') return lm.resolveBands(labels);
    var prev = null;
    return (labels || []).map(function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      var out = { lo: null, hi: null, open: false, label: s };
      var m2 = /^(-?[\d.]+)\s*-\s*(-?[\d.]+)$/.exec(s);
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
   * Parse satu berkas T/C / L-U.
   *
   * @param {string} text isi berkas
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} {
   *   kind, dataType, dataTitle, meta, rowLabels[], colLabels[], matrix[][],
   *   columnRate, xAxis{title,unit}, yAxis{title,unit}, zAxis{title,unit},
   *   total, hours, secondsValid, stats, warnings[] }
   * @throws {Error} bila blok [Data] tidak ada atau tidak berisi baris data
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: null,
      dataType: '', dataTitle: '',
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      columnRate: 1,
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      total: 0, hours: null, secondsValid: false,
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
        } else if (/^column rate$/i.test(key)) {
          var r0 = toNum(cells[1]);
          result.columnRate = (r0 === null || r0 <= 0) ? 1 : r0;
        } else if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (!/^(status of item|view item\d*|column (type|scale))$/i.test(key)) {
          var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();
          result.meta[key] = val;
        }
        continue;
      }

      // Baris definisi yang kadang diulang D I DALAM blok [Data].
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

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas T/C atau L/U.');
    if (!result.matrix.length) throw new Error('Berkas T/C atau L/U tidak mengandung baris data.');

    // --- Jenis berkas ---
    result.dataType = normType(opts.dataType || result.dataType);
    result.kind = kindFromType(result.dataType) || kindFromFileName(opts.sourceName || '');
    if (!result.kind) {
      result.warnings.push('Jenis berkas tidak dapat ditentukan dari tipe "' +
        result.dataType + '" maupun nama berkas "' + (opts.sourceName || '') + '".');
      return result;
    }
    result.label = KIND_LABEL[result.kind] || result.kind;

    // --- Satuan sumbu Z ---
    // '88' BUKAN detik (satuan = jumlah transisi) -> itu normal, TIDAK diberi
    // peringatan, tetapi `hours` WAJIB null agar tidak ada "jam" palsu.
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    var zIsSeconds = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (result.kind === KIND_LUSHIFT) {
      result.secondsValid = false;
    } else {
      result.secondsValid = zIsSeconds;
      if (!zIsSeconds) {
        result.warnings.push('Satuan sumbu Z terbaca "' + (result.zAxis.unit || '(kosong)') +
          '", bukan detik — nilai jam TIDAK dilaporkan agar tidak menyesatkan.');
      }
    }

    // --- Total ---
    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.total = total;
    result.hours = result.secondsValid ? (total / SEC_PER_HOUR) : null;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — tidak ada data untuk dianalisis.');
      return result;
    }

    result.stats = buildStats(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 4. Statistik per berkas — SEMUA relatif / self-referential
   * --------------------------------------------------------------------- */

  function buildStats(res) {
    if (res.kind === KIND_RATIO) return ratioStats(res);
    if (res.kind === KIND_LU) return luStats(res);
    if (res.kind === KIND_LUSHIFT) return luShiftStats(res);
    return null;
  }

  /**
   * '35' — distribusi speed ratio.
   *
   * Band > 100 % dilaporkan sebagai OVERRUN, bukan lock-up (lihat J5b di
   * kepala berkas). Menggabungkannya ke "lock-up" akan melebihkan waktu
   * lock-up 5x lipat dibanding bukti dari '34'.
   */
  function ratioStats(res) {
    var bands = resolveBands(res.rowLabels);
    var total = res.total;
    if (total <= 0) return null;

    var rowSums = res.matrix.map(function (r) {
      return r.reduce(function (a, b) { return a + b; }, 0);
    });

    var stall = 0, low = 0, overrun = 0, at100 = 0;
    var rows = res.rowLabels.map(function (lbl, i) {
      var lo = bandLow(bands[i]);
      var hi = (bands[i] && bands[i].hi !== null) ? bands[i].hi : null;
      var sec = rowSums[i];
      var isOpenTop = !!(bands[i] && bands[i].open);
      // Band "overrun" = batas bawah >= 100. Band terbuka teratas juga
      // dianggap overrun karena labelnya "140 -" (di atas 140 %).
      var isOverrun = (!isOpenTop && lo !== null && lo >= 100) ||
        (isOpenTop && lo !== null && lo >= 100);
      if (!isOpenTop && lo !== null && hi !== null && lo <= 100 && hi >= 100) at100 += sec;
      if (lo !== null && lo < STALL_RATIO_MAX) stall += sec;
      // ⚠ BATAS `lo < 60`, BUKAN `lo <= 60`. Band `- 60` punya lo=40 (masuk),
      // band `- 80` punya lo=60 (TIDAK masuk — lower-boundnya sudah 60 %).
      // Versi pertama memakai `<=` sehingga band 60-80 % ikut terhitung dan
      // angka membengkak dari 5,1 % menjadi 16,0 %.
      if (lo !== null && lo < 60) low += sec;
      if (isOverrun) overrun += sec;
      return { label: lbl, sec: sec, hours: sec / SEC_PER_HOUR, share: 100 * sec / total };
    });

    var peak = null;
    rows.forEach(function (r) { if (!peak || r.sec > peak.sec) peak = r; });

    function hrs(s) { return s / SEC_PER_HOUR; }
    function pct(v) { return 100 * v / total; }

    return {
      kind: KIND_RATIO,
      totalSec: total,
      hours: hrs(total),
      /** Speed ratio 0-STALL_RATIO_MAX %: converter stall (slip maksimum). */
      stallSec: stall, stallHours: hrs(stall), stallShare: pct(stall),
      /** Ratio <= 60 %: slip besar, konversi torsi tinggi. */
      lowRatioSec: low, lowRatioHours: hrs(low), lowRatioShare: pct(low),
      /**
       * Ratio > 100 %: OVERRUN (output > input). BUKAN lock-up.
       * Lihat J5b. Nama kunci ini sengaja `overrun*`.
       */
      overrunSec: overrun, overrunHours: hrs(overrun), overrunShare: pct(overrun),
      peakBand: peak ? peak.label : null,
      peakShare: peak ? peak.share : null,
      rows: rows,
      thresholdsUsed: { stallRatioMax: STALL_RATIO_MAX },
      basisNote: 'Band speed-ratio > 100 % dilaporkan sebagai OVERRUN (kemungkinan ' +
        'meluncur/coasting), BUKAN lock-up. Bukti: peta L/U (tipe 34) mencatat ' +
        'jam lock-up yang jauh lebih sedikit daripada band ini. Tafsir overrun ' +
        'BELUM terkonfirmasi dari Shop Manual.'
    };
  }

  /**
   * '34' — jam lock-up.
   * Yang dihitung di sini hanya jam & ciri beban; pangsa terhadap waktu jalan
   * dihitung di STORE karena butuh berkas matriks gigi (lihat T1.3).
   */
  function luStats(res) {
    var rowBands = resolveBands(res.rowLabels);
    var colBands = resolveBands(res.colLabels);
    var total = res.total;
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

    function peakOf(arr) {
      var bi = -1, bv = -1;
      for (var i = 0; i < arr.length; i++) { if (arr[i] > bv) { bv = arr[i]; bi = i; } }
      return bi;
    }
    var pr = peakOf(rowSums), pc = peakOf(colSums);

    function quantile(sums, labels, q) {
      var target = total * q, acc = 0;
      for (var i = 0; i < sums.length; i++) {
        acc += sums[i];
        if (acc >= target) return labels[i] || null;
      }
      return sums.length ? labels[sums.length - 1] : null;
    }

    function hrs(s) { return s / SEC_PER_HOUR; }

    return {
      kind: KIND_LU,
      totalSec: total,
      hours: hrs(total),
      peakTorqueBand: pr >= 0 ? res.rowLabels[pr] : null,
      peakTorqueShare: pr >= 0 ? (100 * rowSums[pr] / total) : null,
      peakRpmBand: pc >= 0 ? res.colLabels[pc] : null,
      peakRpmShare: pc >= 0 ? (100 * colSums[pc] / total) : null,
      /**
       * Band torque & rpm tempat 50 % / 90 % waktu kumulatif tercapai.
       * Self-referential (dihitung dari sebaran berkas itu sendiri) sehingga
       * sah dibandingkan antar waktu TANPA angka OEM.
       */
      medianTorqueBand: quantile(rowSums, res.rowLabels, 0.5),
      p90TorqueBand: quantile(rowSums, res.rowLabels, 0.9),
      medianRpmBand: quantile(colSums, res.colLabels, 0.5),
      torqueRows: res.rowLabels.map(function (lbl, i) {
        return { label: lbl, sec: rowSums[i], hours: hrs(rowSums[i]), share: 100 * rowSums[i] / total };
      }),
      rpmCols: res.colLabels.map(function (lbl, i) {
        return { label: lbl, sec: colSums[i], hours: hrs(colSums[i]), share: 100 * colSums[i] / total };
      }),
      /** Label sumbu apa adanya dari berkas — untuk header tabel panel. */
      yLabel: res.yAxis.title || 'T/C Input Torque',
      yUnit: res.yAxis.unit || '',
      xLabel: res.xAxis.title || 'T/C Input Speed',
      xUnit: res.xAxis.unit || '',
      thresholdsUsed: {},
      basisNote: 'Jam lock-up terukur. Pangsa terhadap waktu JALAN butuh berkas ' +
        'matriks gigi (tipe 44..49) dan dihitung terpisah — bukan terhadap total ' +
        'peta T/C yang memuat idle/netral/stall.'
    };
  }

  /**
   * '88' — matriks 2x2 ON/OFF. Z = jumlah TRANSISI, bukan detik.
   * Diagonal seharusnya nol (ON->ON atau OFF->OFF tidak mungkin). Diagonal
   * berisi angka = indikasi cacat ekspor, dilaporkan jujur, tidak disembunyikan.
   */
  function luShiftStats(res) {
    var m = res.matrix;
    if (!m.length) return null;

    var offDiagonal = 0, diagonal = 0, total = 0;
    for (var i = 0; i < m.length; i++) {
      for (var j = 0; j < m[i].length; j++) {
        var v = m[i][j] || 0;
        total += v;
        if (i === j) diagonal += v; else offDiagonal += v;
      }
    }
    if (total <= 0) return null;

    return {
      kind: KIND_LUSHIFT,
      /** Jumlah TRANSISI terekam (ON->OFF + OFF->ON). */
      transitions: total,
      /** Jumlah SIKLUS penuh (satu ON dan satu OFF) = transisi / 2. */
      cycles: total / TRANSITIONS_PER_CYCLE,
      /** Diagonal: seharusnya 0. Non-nol = ekspor tidak wajar. */
      diagonalCount: diagonal,
      offDiagonalCount: offDiagonal,
      rowLabels: res.rowLabels.slice(),
      colLabels: res.colLabels.slice(),
      matrix: m.map(function (r) { return r.slice(); }),
      thresholdsUsed: {},
      basisNote: 'Satu siklus = satu pasang transisi ON->OFF dan OFF->ON; ' +
        'jumlah siklus = jumlah transisi / ' + TRANSITIONS_PER_CYCLE + '.'
    };
  }

  /* -----------------------------------------------------------------------
   * 5. Agregat lintas-berkas (satu unit)
   * --------------------------------------------------------------------- */

  /**
   * Gabungkan ketiga berkas menjadi ringkasan siap-panel.
   *
   * @param {object} byKind peta `kind -> hasil parse()`
   * @param {number} [travelHours] jam JALAN dari matriks gigi (tipe 44..49).
   *   Dioper oleh store karena tidak berasal dari berkas apa pun di modul ini.
   *   Bila tidak tersedia, `luShareOfTravel` = null (BUKAN 0).
   * @param {number} [smrHours] SMR unit, untuk kerapatan siklus per jam.
   * @returns {object|null}
   */
  function summarize(byKind, travelHours, smrHours) {
    if (!byKind) return null;
    var ratio = byKind[KIND_RATIO] || null;
    var lu = byKind[KIND_LU] || null;
    var shift = byKind[KIND_LUSHIFT] || null;
    if (!ratio && !lu && !shift) return null;

    // `cycles`/`transitions` hidup di `.stats`, BUKAN di akar hasil parse.
    // Versi pertama membaca `shift.cycles` (undefined) sehingga
    // `engagePerLuHour`/`engagePerSrHour` menjadi NaN.
    var shiftStats = (shift && shift.stats) ? shift.stats : null;

    var travel = Number(travelHours);
    var hasTravel = isFinite(travel) && travel > 0;
    var smr = Number(smrHours);
    // `Number(null)` = 0, jadi tanpa penjaga ini `isFinite(0)` bernilai TRUE
    // dan pembagian menghasilkan Infinity — bukan null seperti yang dimaksud.
    var hasSmr = (smrHours !== null && smrHours !== undefined) && isFinite(smr) && smr > 0;

    var luHours = (lu && lu.hours !== null) ? lu.hours : null;
    var ratioHours = (ratio && ratio.hours !== null) ? ratio.hours : null;
    var cycles = shiftStats ? shiftStats.cycles : null;
    // ⚠ SELURUH besaran turunan (stall/lowRatio/overrun/peak) hidup di
    // `.stats`, BUKAN di akar hasil parse. Membacanya dari `ratio` mentah
    // menghasilkan `undefined` untuk semua — dan karena kuncinya tetap ada
    // di objek hasil, `Object.keys()` TIDAK menunjukkan masalahnya.
    // Tertangkap hanya lewat impor-nyata, bukan lewat uji unit.
    var rs = (ratio && ratio.stats) ? ratio.stats : null;

    return {
      fileCount: (ratio ? 1 : 0) + (lu ? 1 : 0) + (shift ? 1 : 0),

      /* --- Torque converter speed ratio ('35') --- */
      ratioHours: ratioHours,
      stallHours: rs ? rs.stallHours : null,
      stallShare: rs ? rs.stallShare : null,
      lowRatioShare: rs ? rs.lowRatioShare : null,
      /** Overrun = ratio > 100 %. BUKAN lock-up. */
      overrunShare: rs ? rs.overrunShare : null,
      peakRatioBand: rs ? rs.peakBand : null,
      ratioStats: rs,

      /* --- Lock-up ('34') --- */
      luHours: luHours,
      luStats: (lu && lu.stats) ? lu.stats : null,

      /* --- Siklus engage ('88') --- */
      transitions: shiftStats ? shiftStats.transitions : null,
      cycles: cycles,
      luShiftStats: shiftStats,

      /**
       * Pangsa L/U terhadap WAKTU JALAN (%). Denominator yang BENAR —
       * lihat T1.3 di kepala berkas. `null` bila berkas gigi belum ada.
       */
      luShareOfTravel: (luHours !== null && hasTravel) ? (100 * luHours / travel) : null,
      travelHoursUsed: hasTravel ? travel : null,

      /**
       * ⚠ BUKAN indikator. Disertakan HANYA agar panel dapat memperingatkan
       * pembaca mengapa ia tidak dipakai: denominatornya memuat idle/netral/
       * stall sehingga tidak sebanding dengan pangsa HD785.
       *
       * Denumerator = pangsa L/U + pangsa T/C (spesifikasi §1.2: 9,3 %),
       * BUKAN `ratio.hours` saja. Dua rumus itu menghasilkan angka berbeda
       * (9,3 % vs 10,2 %) — perbedaan itulah yang membuat angka ini menipu.
       */
      luShareOfRatioTotal: (luHours !== null && ratioHours) > 0
        ? (100 * luHours / (luHours + ratioHours)) : null,

      /* --- Kerapatan siklus --- */
      engagePerLuHour: (cycles !== null && luHours) ? (cycles / luHours) : null,
      engagePerSmrHour: (cycles !== null && hasSmr) ? (cycles / smr) : null,
      smrHoursUsed: hasSmr ? smr : null,

      /** Catatan batasan yang WAJIB ditampilkan panel. */
      transparency: {
        overrunIsNotLockup: true,
        travelBasisMissing: !hasTravel,
        crossModelNotComparable: true
      }
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_TCLOAD = {
    KIND_RATIO: KIND_RATIO,
    KIND_LU: KIND_LU,
    KIND_LUSHIFT: KIND_LUSHIFT,
    KIND_LABEL: KIND_LABEL,
    TYPE_MAP: TYPE_MAP,
    ACCEPTED_TYPES: Object.keys(TYPE_MAP),
    STALL_RATIO_MAX: STALL_RATIO_MAX,
    TRANSITIONS_PER_CYCLE: TRANSITIONS_PER_CYCLE,
    isTcLoadType: isTcLoadType,
    kindFromType: kindFromType,
    kindFromFileName: kindFromFileName,
    resolveBands: resolveBands,
    parse: parse,
    buildStats: buildStats,
    summarize: summarize
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_TCLOAD;
  }
})(typeof window !== 'undefined' ? window : globalThis);

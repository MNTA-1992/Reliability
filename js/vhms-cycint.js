/* =========================================================================
 * vhms-cycint.js
 * -------------------------------------------------------------------------
 * [D375A 2026-10-14 — T4, OPSI (b)] Penafsir SATU berkas Cycle Interval
 * dozer D375A (`CHK0001/cyc_int0.CSV`, tipe '50').
 *
 * BENTUK (terverifikasi pada SN 19559, SMR 28 812,1 h)
 *   X = `Interval`  (sec)   2 band: "5sec -", "20 sec -"
 *   Y = `Amplitude` (rpm)   11 band: "200 - 400","- 600",…,"2200 -"
 *   Z = `Counts, times`     Sampling 100 msec  ·  Column Rate 1
 *   Σ seluruh sel = 2 592 586  =  90 siklus/jam SMR
 *
 * =========================================================================
 * ⚠⚠ OPSI (b) — APA YANG DILAPORKAN DAN APA YANG TIDAK
 * =========================================================================
 * Spek §7 membatasi tipe ini dengan tegas:
 *
 *   "Kerjakan HANYA kalau: (a) legenda ditemukan, ATAU (b) cukup dengan
 *    melaporkan '<N> siklus/jam' sebagai intensitas siklus kerja TANPA
 *    menafsirkan sumbu amplitudo."
 *
 * Legenda sumbu `Amplitude, rpm` BELUM ditemukan. Ia bisa berarti ayunan
 * putaran mesin per siklus kerja, ayunan beban, atau sesuatu yang lain.
 * Karena itu modul ini mengambil OPSI (b):
 *
 *   DILAPORKAN:
 *     - jumlah siklus total & per jam (intensitas siklus kerja),
 *     - distribusi siklus antar band amplitudo (SEBAGAI HITUNGAN, bukan jam),
 *     - pangsa kolom interval (5 detik vs 20 detik).
 *
 *   TIDAK DILAPORKAN / TIDAK DITAFSIRKAN:
 *     - arti fisis sumbu `Amplitude, rpm`. Tidak ada pernyataan "ayunan rpm
 *       mesin", "fluktuasi beban", atau penyebab apa pun.
 *     - JAM. Sumbu Z di sini `Counts, times` — BUKAN detik. Menghitung jam
 *       dari berkas ini = mengarang. `hours` WAJIB `null`.
 *
 * ⚠ JEBAKAN SATUAN: modul lain di proyek ini memakai Z = `Time, sec` dan
 * menghitung jam. Berkas INI memakai Z = `Counts, times`. Pola pikiran
 * "kalikan Column Rate / bagi 3600" akan menghasilkan angka yang TAMPAK
 * masuk akal tetapi salah. Karena itu `hours` dipaksa `null` di sini dan
 * diuji eksplisit (`CI-*`).
 *
 * PRINSIP PROYEK
 *   - `parse()` MURNI atas teks masukan.
 *   - `null` != `0`.
 *   - Logika band dipinjam dari `VHMS_LOADMAP.resolveBands`.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Konstanta
   * --------------------------------------------------------------------- */

  var KIND_CYCLE = 'cycleInterval';
  var CYCLE_TYPE = '50';

  var LABEL = 'Interval siklus kerja';

  var SEC_PER_HOUR = 3600;

  /**
   * Kalimat pagar yang WAJIB ditampilkan panel. Diuji `CI-*`.
   * Menyatakan dengan tegas bahwa sumbu amplitudo TIDAK ditafsirkan.
   */
  var AMPLITUDE_NOTE = 'Arti sumbu Amplitude (rpm) sengaja TIDAK ditafsirkan: ' +
    'legenda resminya belum tersedia, sehingga arti fisisnya belum dapat ' +
    'dipastikan. Yang dilaporkan hanya JUMLAH siklus dan sebarannya antar band.';

  /** Satuan sumbu Z berkas ini adalah HITUNGAN, bukan detik. */
  var BASIS_NOTE = 'Satuan sumbu Z berkas ini adalah jumlah kejadian ' +
    '(Counts, times), BUKAN detik. Karena itu jam TIDAK dihitung dari berkas ini.';

  /* -----------------------------------------------------------------------
   * 2. Deteksi & utilitas
   * --------------------------------------------------------------------- */

  function normType(t) { return String(t == null ? '' : t).trim().toUpperCase(); }

  function isCycleType(type) { return normType(type) === CYCLE_TYPE; }

  function kindFromType(type) { return isCycleType(type) ? KIND_CYCLE : null; }

  /**
   * Cadangan dari NAMA BERKAS. BERJANGKAR — pelajaran J4.
   * Hanya `cyc_int0` yang diterima.
   */
  function kindFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    return /(^|[\\/])cyc_int0(\.csv)?$/.test(n) ? KIND_CYCLE : null;
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
      var m2 = /^(\d+)\s*-\s*(\d+)$/.exec(s);
      if (m2) { out.lo = toNum(m2[1]); out.hi = toNum(m2[2]); prev = out.hi; return out; }
      var m1 = /^-\s*(\d+)$/.exec(s);
      if (m1) { out.hi = toNum(m1[1]); out.lo = prev; prev = out.hi; return out; }
      var m3 = /^(\d+)\s*-$/.exec(s);
      if (m3) { out.lo = toNum(m3[1]); out.open = true; prev = out.lo; return out; }
      return out;
    });
  }

  /* -----------------------------------------------------------------------
   * 3. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse berkas Cycle Interval.
   *
   * @param {string} text
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} { kind, dataType, dataTitle, meta, rowLabels[],
   *   colLabels[], matrix[][], xAxis, yAxis, zAxis,
   *   totalCount, hours (SELALU null), secondsValid (SELALU false),
   *   stats, warnings[] }
   * @throws {Error} bila blok [Data] tidak ada atau kosong
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: null,
      dataType: '', dataTitle: '',
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      totalCount: 0,
      /** ⚠ SELALU null: satuan berkas ini adalah HITUNGAN, bukan detik. */
      hours: null,
      secondsValid: false,
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

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas Cycle Interval.');
    if (!result.matrix.length) throw new Error('Berkas Cycle Interval tidak mengandung baris data.');

    // --- Jenis berkas ---
    result.dataType = normType(opts.dataType || result.dataType);
    result.kind = kindFromType(result.dataType) || kindFromFileName(opts.sourceName || '');
    if (!result.kind) {
      result.warnings.push('Jenis berkas Cycle Interval tidak dapat ditentukan dari tipe "' +
        result.dataType + '" maupun nama berkas "' + (opts.sourceName || '') + '".');
      return result;
    }
    result.label = LABEL;

    // --- Satuan sumbu Z: berkas ini HITUNGAN, bukan detik ---
    // Tidak diberi peringatan: satuan hitungan di sini NORMAL (seperti '56'
    // di vhms-dutymap.js). Peringatan hanya bila ada yang keliru mengira detik.
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    var zIsSeconds = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (zIsSeconds) {
      // Ekspor tak terduga: laporkan JUJUR, jangan diam-diam bagi 3600.
      result.warnings.push('Satuan sumbu Z terbaca "' + result.zAxis.unit +
        '" pada berkas yang seharusnya berisi HITUNGAN. Modul ini TETAP tidak ' +
        'menghitung jam agar tidak menyesatkan.');
    }

    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.totalCount = total;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — tidak ada data untuk dianalisis.');
      return result;
    }

    result.stats = buildStats(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 4. Statistik — HITUNGAN, bukan jam
   * --------------------------------------------------------------------- */

  function buildStats(res) {
    var rowBands = resolveBands(res.rowLabels);   // amplitudo (rpm)
    var total = res.totalCount;
    if (total <= 0) return null;

    var rowSums = res.matrix.map(function (r) {
      return r.reduce(function (a, b) { return a + b; }, 0);
    });

    var nRows = res.matrix.length;
    var nCols = res.colLabels.length || (res.matrix[0] ? res.matrix[0].length : 0);

    var colSums = [];
    for (var c = 0; c < nCols; c++) {
      var s = 0;
      for (var r2 = 0; r2 < nRows; r2++) s += (res.matrix[r2][c] || 0);
      colSums.push(s);
    }

    var peakIdx = -1, peakVal = -1;
    for (var i = 0; i < rowSums.length; i++) {
      if (rowSums[i] > peakVal) { peakVal = rowSums[i]; peakIdx = i; }
    }

    return {
      /** Jumlah SELURUH siklus terekam. SATUAN: kali, BUKAN jam. */
      totalCount: total,
      /** ⚠ SELALU null. Lihat catatan kepala — satuan Z bukan detik. */
      hours: null,
      peakBand: peakIdx >= 0 ? res.rowLabels[peakIdx] : null,
      peakCount: peakIdx >= 0 ? rowSums[peakIdx] : null,
      peakShare: peakIdx >= 0 ? (100 * rowSums[peakIdx] / total) : null,
      /** Distribusi siklus antar band amplitudo. */
      amplitudeRows: res.rowLabels.map(function (lbl, idx) {
        return {
          label: lbl, count: rowSums[idx], share: 100 * rowSums[idx] / total,
          low: rowBands[idx] ? (rowBands[idx].lo !== null ? rowBands[idx].lo : rowBands[idx].hi) : null
        };
      }),
      /** Distribusi siklus antar kolom interval. */
      intervalCols: res.colLabels.map(function (lbl, idx) {
        return { label: lbl, count: colSums[idx], share: 100 * colSums[idx] / total };
      }),
      thresholdsUsed: {},
      amplitudeNote: AMPLITUDE_NOTE,
      basisNote: BASIS_NOTE
    };
  }

  /**
   * Intensitas siklus per jam SMR.
   *
   * ⚠ Ini BUKAN "jam dari berkas". SMR berasal dari UNIT (berkas trend),
   * bukan dari berkas ini. Yang dihitung adalah KERAPATAN siklus:
   * "berapa siklus per jam operasi". Itu sah tanpa legenda amplitudo.
   *
   * @param {object} res hasil parse
   * @param {number} smrHours SMR unit
   * @returns {number|null} siklus per jam, atau null bila SMR tidak sahih
   */
  function cyclesPerSmrHour(res, smrHours) {
    if (!res || !res.stats) return null;
    var smr = Number(smrHours);
    // `Number(null)` = 0 -> penjaga eksplisit WAJIB, kalau tidak pembagian nol.
    if (smrHours === null || smrHours === undefined) return null;
    if (!isFinite(smr) || smr <= 0) return null;
    return res.stats.totalCount / smr;
  }

  /**
   * Ringkasan siap-panel.
   * @param {object} res hasil parse
   * @param {number} [smrHours] SMR unit (untuk intensitas)
   * @returns {object|null}
   */
  function summarize(res, smrHours) {
    if (!res || !res.stats) return null;
    return {
      totalCount: res.stats.totalCount,
      /** ⚠ SELALU null — berkas ini bukan durasi. */
      hours: null,
      cyclesPerSmrHour: cyclesPerSmrHour(res, smrHours),
      smrHoursUsed: (function () {
        var v = Number(smrHours);
        return (smrHours !== null && smrHours !== undefined && isFinite(v) && v > 0) ? v : null;
      })(),
      peakBand: res.stats.peakBand,
      peakShare: res.stats.peakShare,
      amplitudeRows: res.stats.amplitudeRows,
      intervalCols: res.stats.intervalCols,
      /** Selalu true: modul tidak menafsirkan arti sumbu amplitudo. */
      amplitudeMeaningDeferred: true,
      amplitudeNote: AMPLITUDE_NOTE,
      basisNote: BASIS_NOTE,
      /** Jumlah band interval (mis. 2) — untuk panel. */
      intervalBandCount: res.stats.intervalCols.length
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_CYCINT = {
    KIND_CYCLE: KIND_CYCLE,
    CYCLE_TYPE: CYCLE_TYPE,
    LABEL: LABEL,
    AMPLITUDE_NOTE: AMPLITUDE_NOTE,
    BASIS_NOTE: BASIS_NOTE,
    ACCEPTED_TYPES: [CYCLE_TYPE],
    isCycleType: isCycleType,
    kindFromType: kindFromType,
    kindFromFileName: kindFromFileName,
    resolveBands: resolveBands,
    parse: parse,
    buildStats: buildStats,
    cyclesPerSmrHour: cyclesPerSmrHour,
    summarize: summarize
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_CYCINT;
  }
})(typeof window !== 'undefined' ? window : globalThis);

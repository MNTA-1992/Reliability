/* =========================================================================
 * vhms-opava.js
 * -------------------------------------------------------------------------
 * [PC2000 2026-10-10 — T11] Parser OPERATING AVAILABILITY (`op_ava0.CSV`).
 *
 * MENGAPA MODUL TERPISAH
 * ----------------------
 * Berkas ini TIDAK berbentuk seri waktu SMR seperti trend. Satu baris =
 * satu JENDELA KERJA (biasanya 1 hari kalender) dengan sumbu waktu berupa
 * `From Time` / `To Time` berformat `epoch|tzOffset|dst` — BUKAN SMR numerik.
 *
 * Sebelum modul ini, `VHMS_PARSER.parse()` MELEMPAR
 * "Tidak ada baris data valid yang bisa dibaca dari bagian [Data]"
 * karena kolom pertama bukan angka. Sekarang parser itu mengembalikan
 * `records: []` untuk tipe non-trend (`_rawText` tetap ada), dan berkas
 * ini ditafsirkan di sini.
 *
 * YANG DIHITUNG
 * -------------
 *   - 4 meter kumulatif (×0.1 jam): SMR0 (key-on), SMR (ENGINE RUNNING),
 *     SMR1 & SMR2 (meter sekunder — D5: TIDAK ditampilkan, artinya belum
 *     dikonfirmasi dari manual Komatsu).
 *   - Delta per jendela tiap meter -> utilisasi, fraksi idle.
 *   - Duty mode: Work / Swing / Travel, 3 kolom persen per mode.
 *   - Gerbang kebasian (staleness): celah antar-jendela & utilisasi terkini.
 *
 * ATURAN PENTING (D5)
 * -------------------
 * `SMR1` & `SMR2` kumulatifnya LEBIH BESAR dari `SMR` (engine) — mustahil
 * karena per-jendela deltanya konsisten ≤. Artinya kedua meter itu pernah
 * di-reset / ECU diganti. Karena itu NILAI ABSOLUT keduanya TIDAK DIPAKAI;
 * hanya delta per jendela. Rasio idle di-clamp ke [0,1] karena 6 dari 95
 * jendela punya `ΔSMR0 < ΔSMR` (meter key-on tidak monoton sempurna).
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG || {};

  /* -----------------------------------------------------------------------
   * 1. Konstanta & tabel
   * --------------------------------------------------------------------- */

  /** Tipe VHMS untuk Operating Availability. */
  var OPAVA_TYPE = '90';

  /** Skala meter: berkas menyimpan dalam 0,1 jam. */
  var METER_SCALE = 0.1;

  /**
   * Kolom meter (indeks 3..6, setelah From Time/To Time/Date Change).
   * URUTAN INI DIBACA DARI BERKAS, bukan ditebak — lihat `Axis Item`:
   *   From Time, To Time, Date Change, SMR0, SMR, SMR1, SMR2, ...
   */
  var METER_KEYS = ['smr0', 'engine', 'smr1', 'smr2'];
  var METER_LABELS = {
    smr0: 'Key-on (SMR0)',
    engine: 'Engine Running (SMR)',
    smr1: 'Meter sekunder 1 (SMR1)',
    smr2: 'Meter sekunder 2 (SMR2)'
  };

  /**
   * Tiga mode duty, masing-masing 3 kolom persen:
   *   Work  (0-10) / Work (-20) / Work (20-)
   * Pemetaan indeks dari kolom ke-7 (setelah 4 meter).
   */
  var DUTY_MODES = ['work', 'swing', 'travel'];
  var DUTY_LABELS = { work: 'Work', swing: 'Swing', travel: 'Travel' };
  /** Ambang persen ketiga kolom tiap mode (rendah / menengah / tinggi). */
  var DUTY_BANDS = ['0-10', '10-20', '>20'];

  /** Celah antar-jendela dianggap "data basi" bila melebihi ini (hari). */
  var STALE_GAP_DAYS = 7;

  /** Jendela dianggap "aktif" bila meter engine maju minimal ini (jam). */
  var ACTIVE_MIN_HOURS = 0.5;

  /** Jumlah jendela terakhir untuk menghitung utilisasi "terkini". */
  var RECENT_WINDOW_COUNT = 20;

  /* -----------------------------------------------------------------------
   * 2. Deteksi jenis berkas
   * --------------------------------------------------------------------- */

  /** Apakah `dataType` (dari VHMS_PARSER) adalah Operating Availability? */
  function isOpAvaType(type) {
    return String(type == null ? '' : type).trim() === OPAVA_TYPE;
  }

  /**
   * Tebak dari NAMA berkas bila `dataType` tidak tersedia.
   * @param {string} name nama berkas
   */
  function isOpAvaFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    return /op[_-]?ava/.test(n);
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

  // [O-5 2026-10-12] Delegasi ke `CSV_UTIL.toNumStrict` (lihat csv-util.js).
  // Ketat disengaja: nilai berimbuhan huruf atau berkoma = data rusak -> null.
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
   * Pecah field waktu VHMS `epoch|tzOffsetSec|dst`.
   * @returns {{epoch:number|null, tz:number|null, dst:number|null}}
   */
  function parseEpochField(v) {
    var out = { epoch: null, tz: null, dst: null };
    if (v === null || v === undefined) return out;
    var parts = String(v).split('|');
    var e = toNum(parts[0]);
    if (e === null || e <= 0) return out;   // 0 = belum ada (mis. toTime 0)
    out.epoch = e;
    out.tz = toNum(parts[1]);
    out.dst = toNum(parts[2]);
    return out;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser
   * --------------------------------------------------------------------- */

  /**
   * Parse teks `op_ava0.CSV`.
   *
   * @param {string} text  isi berkas
   * @param {object} [opts]
   *   - dataType   : tipe dari parser utama (opsional)
   *   - sourceName : nama berkas (untuk pesan)
   *   - headerSmr  : SMR dari [Common Header] — dipakai untuk verifikasi
   *                  lintas-berkas (D5). Bila beda > 1 jam -> warning.
   * @returns {object} lihat `result` di bawah.
   */
  function parse(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r\n|\n|\r/);

    var result = {
      dataType: OPAVA_TYPE,
      dataTitle: '',
      meta: {},
      columns: [],
      /** Seluruh jendela mentah (terurut waktu naik). */
      windows: [],
      /** Ringkasan (angka penting untuk UI/uji). */
      summary: null,
      warnings: []
    };

    var section = '';
    var inData = false;
    var sawDataMarker = false;
    /** Baris "Axis Item" = nama kolom; dipakai untuk memetakan indeks. */
    var axisItem = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      // --- [Section] ---
      var sec = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (sec) {
        section = sec[1].toLowerCase();
        if (/^data$/.test(section)) { inData = true; sawDataMarker = true; }
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);

      if (!inData) {
        // Blok header: kumpulkan meta + cari "Axis Item".
        var key = String(cells[0] || '').trim();
        if (key) {
          if (/^data type\s*&\s*title$/i.test(key)) {
            result.dataType = String(cells[1] || '').trim() || result.dataType;
            result.dataTitle = String(cells[2] || '').trim();
          } else if (/^axis item$/i.test(key)) {
            axisItem = cells.slice(1).map(function (s) { return String(s).trim(); });
          } else if (!/^(axis scale|axis type|axis rate|status of item|view item\d*)$/i.test(key)) {
            result.meta[key.toLowerCase()] = String(cells[1] || '').trim();
          }
        }
        continue;
      }

      // --- Baris data ---
      // Lewati baris definisi kolom yang muncul DI DALAM [Data].
      if (/^\s*(Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) continue;

      if (cells.length < 7) continue;
      // Baris data diawali koma (kolom 0 kosong) -> offset 1.
      var off = (cells.length > 0 && String(cells[0]).trim() === '') ? 1 : 0;

      var from = parseEpochField(cells[off]);
      var to = parseEpochField(cells[off + 1]);
      if (from.epoch === null) continue;

      var meters = {};
      for (var m = 0; m < METER_KEYS.length; m++) {
        var mv = toNum(cells[off + 3 + m]);
        meters[METER_KEYS[m]] = (mv === null) ? null : mv * METER_SCALE;
      }

      var duty = {};
      for (var d = 0; d < DUTY_MODES.length; d++) {
        var mode = DUTY_MODES[d];
        var band = [];
        for (var b = 0; b < 3; b++) {
          var dv = toNum(cells[off + 7 + d * 3 + b]);
          band.push(dv === null ? 0 : dv);
        }
        duty[mode] = { bands: band, total: band[0] + band[1] + band[2] };
      }

      var dateChange = toNum(cells[off + 2]);

      result.windows.push({
        fromEpoch: from.epoch,
        toEpoch: to.epoch,
        fromTz: from.tz,
        toTz: to.tz,
        dateChange: dateChange,
        meters: meters,
        duty: duty,
        raw: cells.slice(off)
      });
    }

    if (!sawDataMarker) {
      throw new Error('Bagian [Data] tidak ditemukan pada berkas Operating Availability.');
    }
    if (!result.windows.length) {
      throw new Error('Berkas Operating Availability tidak mengandung jendela data.');
    }

    result.columns = axisItem || [];
    result.meta.smrHeader = (opts.headerSmr === null || opts.headerSmr === undefined) ? null : Number(opts.headerSmr);

    result.windows.sort(function (a, b) { return a.fromEpoch - b.fromEpoch; });
    result.summary = summarize(result.windows, result.meta, opts);

    if (result.summary.warnings.length) {
      result.warnings = result.warnings.concat(result.summary.warnings);
    }
    return result;
  }

  /* -----------------------------------------------------------------------
   * 5. Ringkasan (utilisasi, duty mode, gerbang kebasian)
   * --------------------------------------------------------------------- */

  /**
   * Hitung ringkasan dari daftar jendela.
   *
   * @param {array}  windows  hasil `parse()`
   * @param {object} [meta]
   * @param {object} [opts]
   * @returns {object} {
   *   windowCount, activeWindowCount,
   *   firstEpoch, lastEpoch, spanDays,
   *   meters: { smr0, engine, smr1, smr2 },      // kumulatif (info saja)
   *   meterOrderWarning: string|null,
   *   utilizationOverall, utilizationRecent,     // jam/hari
   *   idleRatio,                                 // 1 - engine/keyon (clamp 0..1)
   *   meterStart, meterEnd,                      // SMR engine (h) awal/akhir rentang
   *   keyOnStart, keyOnEnd,                      // SMR0 key-on (h) awal/akhir rentang
   *   operatingHours,                            // SMR akhir - SMR awal (h)
   *   calendarDays,                              // rentang kalender (hari)
   *   duty: { work:{...}, swing:{...}, travel:{...} },
   *   heavyWorkShare,                            // % dari waktu kerja
   *   maxGapDays, staleGaps[], daysSinceLastWindow,
   *   openEnded,                                 // jendela terakhir belum tutup
   *   warnings: []
   * }
   */
  function summarize(windows, meta, opts) {
    opts = opts || {};
    meta = meta || {};
    var out = {
      windowCount: (windows || []).length,
      activeWindowCount: 0,
      firstEpoch: null,
      lastEpoch: null,
      spanDays: 0,
      meters: { smr0: null, engine: null, smr1: null, smr2: null },
      meterOrderWarning: null,
      utilizationOverall: null,
      utilizationRecent: null,
      idleRatio: null,
      // [2026-10-12] SMR awal/akhir + total operasi pada RENTANG terpilih.
      //   SMR yang dipakai = `engine` (engine running) karena itu acuan
      //   ketersediaan; SMR0 (key-on) hanya untuk fraksi idle.
      //   `operatingHours` = SMR akhir − SMR awal, jadi SELALU konsisten
      //   dengan `utilizationOverall × spanDays` (tidak ada dua definisi).
      meterStart: null,
      meterEnd: null,
      keyOnStart: null,
      keyOnEnd: null,
      operatingHours: null,
      calendarDays: null,
      duty: { work: null, swing: null, travel: null },
      heavyWorkShare: null,
      maxGapDays: 0,
      staleGaps: [],
      daysSinceLastWindow: null,
      openEnded: false,
      warnings: []
    };
    if (!windows || !windows.length) return out;

    var first = windows[0];
    var last = windows[windows.length - 1];
    out.firstEpoch = first.fromEpoch;
    out.lastEpoch = last.toEpoch || last.fromEpoch;
    out.spanDays = (out.lastEpoch - out.firstEpoch) / 86400;
    // Jendela terakhir belum ditutup bila toEpoch mengarah ke masa depan relatif
    // dari jendela sebelumnya, atau tanggalnya sama dengan 'now' berkas.
    out.openEnded = !!(last.toEpoch && last.fromEpoch && (last.toEpoch - last.fromEpoch) < 3600);

    // --- Meter kumulatif (nilai akhir) ---
    Object.keys(out.meters).forEach(function (k) {
      out.meters[k] = last.meters[k];
    });

    // --- [2026-10-12] SMR awal/akhir & total operasi RENTANG TERPILIH ---
    // Nilai kumulatif dilepas dari skala file (METER_SCALE) di `parse()`,
    // jadi angka di sini sudah dalam JAM.
    out.meterStart = first.meters.engine;
    out.meterEnd = last.meters.engine;
    out.keyOnStart = first.meters.smr0;
    out.keyOnEnd = last.meters.smr0;
    out.calendarDays = out.spanDays;
    if (out.meterStart !== null && out.meterEnd !== null) {
      out.operatingHours = out.meterEnd - out.meterStart;
    }

    // --- Peringatan urutan meter (D5). Bila SMR1/SMR2 > engine -> pernah reset.
    var engCum = out.meters.engine;
    if (engCum !== null && out.meters.smr1 !== null && out.meters.smr1 > engCum + 1) {
      out.meterOrderWarning = 'SMR1 (' + out.meters.smr1.toFixed(0) + ' h) > engine (' +
        engCum.toFixed(0) + ' h) — meter pernah di-reset/ECU diganti; nilai absolut SMR1 TIDAK dipakai.';
    }
    if (engCum !== null && out.meters.smr2 !== null && out.meters.smr2 > engCum + 1) {
      var w2 = 'SMR2 (' + out.meters.smr2.toFixed(0) + ' h) > engine (' + engCum.toFixed(0) + ' h) — idem.';
      out.meterOrderWarning = out.meterOrderWarning ? out.meterOrderWarning + ' ' + w2 : w2;
    }

    // --- Delta per jendela ---
    var active = [];
    var gaps = [];
    for (var i = 1; i < windows.length; i++) {
      var w = windows[i];
      var p = windows[i - 1];
      var dEng = (w.meters.engine !== null && p.meters.engine !== null)
        ? (w.meters.engine - p.meters.engine) : null;
      var dKey = (w.meters.smr0 !== null && p.meters.smr0 !== null)
        ? (w.meters.smr0 - p.meters.smr0) : null;
      var gapDays = (w.fromEpoch - (p.toEpoch || p.fromEpoch)) / 86400;
      if (gapDays > 0) gaps.push({ afterEpoch: p.toEpoch || p.fromEpoch, days: gapDays });
      if (dEng === null || dEng < ACTIVE_MIN_HOURS) continue;   // jendela tak aktif
      active.push({ w: w, dEng: dEng, dKey: dKey });
    }
    out.activeWindowCount = active.length;

    // --- Utilisasi (jam/hari) ---
    if (out.spanDays > 0 && engCum !== null && windows[0].meters.engine !== null) {
      var totalEng = engCum - windows[0].meters.engine;
      out.utilizationOverall = totalEng / out.spanDays;
    }
    // Utilisasi "terkini": RECENT_WINDOW_COUNT jendela terakhir.
    var rIdx = Math.max(0, windows.length - 1 - RECENT_WINDOW_COUNT);
    var rFirst = windows[rIdx];
    var rDays = (out.lastEpoch - rFirst.fromEpoch) / 86400;
    if (rDays > 0 && last.meters.engine !== null && rFirst.meters.engine !== null) {
      out.utilizationRecent = (last.meters.engine - rFirst.meters.engine) / rDays;
    }

    // --- Rasio idle (di-clamp 0..1) ---
    var sumKey = 0, sumEng = 0, nRatio = 0;
    active.forEach(function (a) {
      if (a.dKey === null || a.dKey <= 0) return;
      var r = 1 - (a.dEng / a.dKey);
      if (!isFinite(r)) return;
      if (r < 0) r = 0;         // ⚠ clamp: ΔSMR0 < ΔSMR pada 6 jendela
      if (r > 1) r = 1;
      sumKey += r; nRatio++;
    });
    out.idleRatio = nRatio ? (sumKey / nRatio) : null;

    // --- Duty mode (rata-rata atas jendela AKTIF) ---
    if (active.length) {
      DUTY_MODES.forEach(function (mode) {
        var acc = [0, 0, 0];
        var n = 0;
        active.forEach(function (a) {
          var b = a.w.duty[mode];
          if (!b) return;
          acc[0] += b.bands[0]; acc[1] += b.bands[1]; acc[2] += b.bands[2];
          n++;
        });
        if (!n) return;
        var mean = [acc[0] / n, acc[1] / n, acc[2] / n];
        out.duty[mode] = {
          bands: mean,
          total: mean[0] + mean[1] + mean[2],
          label: DUTY_LABELS[mode],
          bandLabels: DUTY_BANDS
        };
      });
      // Share kerja berat = Work >20 % dibagi total Work.
      var heavy = 0, workTotal = 0;
      active.forEach(function (a) {
        var wk = a.w.duty.work;
        if (!wk) return;
        heavy += wk.bands[2];
        workTotal += wk.total;
      });
      out.heavyWorkShare = workTotal > 0 ? (100 * heavy / workTotal) : null;
    }

    // --- Gerbang kebasian ---
    gaps.forEach(function (g) {
      if (g.days > out.maxGapDays) out.maxGapDays = g.days;
      if (g.days > STALE_GAP_DAYS) {
        out.staleGaps.push({ afterEpoch: g.afterEpoch, days: Math.round(g.days * 10) / 10 });
      }
    });
    out.staleGaps.sort(function (a, b) { return b.days - a.days; });

    // --- Verifikasi lintas-berkas terhadap header SMR (D5) ---
    var hdr = (opts.headerSmr !== null && opts.headerSmr !== undefined)
      ? Number(opts.headerSmr) : (meta.smrHeader !== null && meta.smrHeader !== undefined ? Number(meta.smrHeader) : null);
    if (hdr !== null && isFinite(hdr) && out.meters.engine !== null) {
      var diff = Math.abs(out.meters.engine - hdr);
      if (diff > 1) {
        out.warnings.push('Meter engine (' + out.meters.engine.toFixed(1) +
          ' h) berbeda ' + diff.toFixed(1) + ' h dari SMR header (' + hdr +
          ' h) — periksa integritas data.');
      }
    }
    if (out.meterOrderWarning) out.warnings.push(out.meterOrderWarning);
    if (out.staleGaps.length) {
      out.warnings.push('Terdapat ' + out.staleGaps.length + ' celah data > ' +
        STALE_GAP_DAYS + ' hari (terbesar ' + out.maxGapDays.toFixed(1) + ' hari) — ' +
        'analisis mencerminkan kondisi lampau, bukan terkini.');
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * 6. Ringkas untuk UI (label siap-pakai)
   * --------------------------------------------------------------------- */

  /**
   * Susun baris ringkas siap-tampil dari summary.
   * @returns {array} daftar { label, value, unit, note }
   */
  function headlineRows(summary) {
    if (!summary) return [];
    var rows = [];
    var f1 = function (v) { return (v === null || v === undefined) ? '—' : v.toFixed(1); };
    rows.push({ label: 'Jendela kerja', value: String(summary.windowCount), unit: 'jendela', note: summary.activeWindowCount + ' aktif' });
    rows.push({ label: 'Utilisasi keseluruhan', value: f1(summary.utilizationOverall), unit: 'jam/hari', note: summary.spanDays.toFixed(0) + ' hari' });
    rows.push({ label: 'Utilisasi 20 jendela terakhir', value: f1(summary.utilizationRecent), unit: 'jam/hari', note: 'kondisi terkini' });
    rows.push({ label: 'Fraksi idle', value: summary.idleRatio === null ? '—' : (summary.idleRatio * 100).toFixed(1), unit: '%', note: 'key-on tanpa engine' });
    DUTY_MODES.forEach(function (m) {
      var d = summary.duty[m];
      rows.push({
        label: 'Duty ' + DUTY_LABELS[m],
        value: d ? d.total.toFixed(1) : '—',
        unit: '%',
        note: d ? (d.bands[0].toFixed(1) + ' / ' + d.bands[1].toFixed(1) + ' / ' + d.bands[2].toFixed(1)) : ''
      });
    });
    if (summary.heavyWorkShare !== null) {
      rows.push({ label: 'Kerja berat (Work >20 %)', value: summary.heavyWorkShare.toFixed(1), unit: '% dari waktu kerja', note: '' });
    }
    rows.push({ label: 'Celah data terbesar', value: summary.maxGapDays.toFixed(1), unit: 'hari', note: summary.staleGaps.length + ' celah > 7 hari' });
    return rows;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_OPAVA = {
    OPAVA_TYPE: OPAVA_TYPE,
    METER_SCALE: METER_SCALE,
    METER_KEYS: METER_KEYS,
    METER_LABELS: METER_LABELS,
    DUTY_MODES: DUTY_MODES,
    DUTY_LABELS: DUTY_LABELS,
    DUTY_BANDS: DUTY_BANDS,
    STALE_GAP_DAYS: STALE_GAP_DAYS,
    ACTIVE_MIN_HOURS: ACTIVE_MIN_HOURS,
    RECENT_WINDOW_COUNT: RECENT_WINDOW_COUNT,
    isOpAvaType: isOpAvaType,
    isOpAvaFileName: isOpAvaFileName,
    parseEpochField: parseEpochField,
    parse: parse,
    summarize: summarize,
    headlineRows: headlineRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_OPAVA;
  }
})(typeof window !== 'undefined' ? window : globalThis);

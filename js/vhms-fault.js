/* =========================================================================
 * vhms-fault.js
 * -------------------------------------------------------------------------
 * PILAR `EVENT` — ringkasan & skor kritikalitas dari RIWAYAT FAULT/ALARM
 * (`fault0.CSV`, Data Type '10').
 *
 * MENGAPA PILAR BARU:
 *   Sebelum ini seluruh analisis ARPC bertumpu pada trend VHMS. Akibatnya
 *   yang terukur hanya "ambang terlampaui", BUKAN bukti kegagalan aktual.
 *   Riwayat fault memberi bukti kejadian nyata: berapa sering, seberapa
 *   aktif, dan komponen mana yang paling sering mengeluh.
 *
 * PRINSIP DESAIN (docs/STATUS_PROYEK.md §2.4):
 *   - Tanpa dependensi baru; pola IIFE + `global.*`.
 *   - Normalisasi memakai SATURATING CURVE (x / (x + k)), BUKAN pembagian
 *     oleh nilai maksimum armada. Dengan begitu skor satu unit TIDAK
 *     berubah ketika unit lain di-upload (skor bersifat absolut).
 *   - Agregasi pilar memakai `RANKING_PILLARS` atas parameter hasil
 *     `FAULT_SENSOR_MAP`.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG || {};

  /* -----------------------------------------------------------------------
   * Konstanta kalibrasi (dapat di-tuning).
   * Semua memakai bentuk saturating agar skor "jenuh" dan tidak meledak.
   * --------------------------------------------------------------------- */
  var CAL = {
    // saturasi eventDensity: 20 event / 1000 h dianggap parah
    densityK: 20,
    // saturasi recurrence: 200 kemunculan dianggap parah
    recurrenceK: 200,
    // saturasi activeCount: 5 event yang masih aktif dianggap parah
    activeK: 5,
    // bobot 3 komponen (jumlah = 1.0)
    wDensity: 0.4,
    wActive: 0.35,
    wRecurrence: 0.25
  };

  /** Kurva penjenuhan: 0 pada x=0, mendekati 1 saat x >> k. */
  function saturate(x, k) {
    if (!(x > 0)) return 0;
    return x / (x + k);
  }

  /* -----------------------------------------------------------------------
   * [T4.1] summarize — metrik ringkas riwayat fault sebuah unit
   * ---------------------------------------------------------------------
   * @param {array}  faultEvents event dari VHMS_FAULT_PARSER.parseFault()
   * @param {object} [opts]
   *   - smrRange : { min, max } rentang SMR trend unit (untuk eventDensity).
   *                Bila absen, eventDensity = null (TIDAK ditebak).
   *   - maskReport : laporan applyFaultMask() (untuk menandai data tak layak)
   * @returns {object|null} null bila tidak ada event.
   * --------------------------------------------------------------------- */
  function summarize(faultEvents, opts) {
    opts = opts || {};
    var evs = (faultEvents || []).filter(function (e) { return e && e.code; });
    if (!evs.length) return null;

    /* -------------------------------------------------------------------
     * [PC2000 2026-10-10 — T6/D10] SUPRESI ALARM TURUNAN.
     * -----------------------------------------------------------------
     * Bila sensor SUMBER rusak/mask-aktif, alarm nilai yang berasal dari
     * sensor yang sama DIKELUARKAN dari skor (lihat `cfg.FAULT_DERIVED_FROM`
     * & penjelasan lengkap di vhms-config.js). Tanpa ini, satu sensor EGT
     * rusak menghitung dua kali: sekali sebagai fault sensor, sekali lagi
     * sebagai alarm "suhu tinggi" dari pembacaan palsu.
     *
     * `suppressedDerived` tetap mencatat supaya tidak hilang diam-diam.
     * ---------------------------------------------------------------- */
    var derivedMap = cfg.FAULT_DERIVED_FROM || {};
    var distinctAll = {};
    evs.forEach(function (e) { distinctAll[e.code] = true; });
    var suppressedCodes = {};
    Object.keys(derivedMap).forEach(function (alarmCode) {
      var sources = derivedMap[alarmCode] || [];
      // Aktif bila ADA kode sensor sumber yang muncul di berkas ini.
      var hit = sources.some(function (sc) { return distinctAll[sc]; });
      if (hit && distinctAll[alarmCode]) suppressedCodes[alarmCode] = sources.slice();
    });
    var suppressedDerived = {};
    var evsScored = evs.filter(function (e) {
      if (suppressedCodes[e.code]) {
        if (!suppressedDerived[e.code]) {
          suppressedDerived[e.code] = { code: e.code, msg: e.msg || '', events: 0, count: 0, sources: suppressedCodes[e.code] };
        }
        suppressedDerived[e.code].events += 1;
        suppressedDerived[e.code].count += (e.count === null || e.count === undefined) ? 1 : e.count;
        return false;
      }
      return true;
    });

    var totalCount = 0;          // recurrence: total `Count`
    var activeCount = 0;         // event dengan toEpoch === null
    var activeDurationSec = 0;   // total durasi event yang sudah PULIH
    var activeSpanSec = 0;       // total durasi event yang MASIH aktif
    var distinct = {};
    var byCode = {};
    var recovered = 0;

    evsScored.forEach(function (e) {
      var c = (e.count === null || e.count === undefined) ? 1 : e.count;
      totalCount += c;

      if (!byCode[e.code]) {
        byCode[e.code] = {
          code: e.code, msg: e.msg || '', count: 0, occurrences: 0,
          active: false, durationSec: 0, fromEpochMin: null, toEpochMax: null
        };
      }
      var agg = byCode[e.code];
      agg.count += c;
      agg.occurrences += 1;
      if (e.fromEpoch !== null && e.fromEpoch !== undefined) {
        if (agg.fromEpochMin === null || e.fromEpoch < agg.fromEpochMin) agg.fromEpochMin = e.fromEpoch;
      }
      if (e.toEpoch !== null && e.toEpoch !== undefined) {
        if (agg.toEpochMax === null || e.toEpoch > agg.toEpochMax) agg.toEpochMax = e.toEpoch;
      }

      distinct[e.code] = true;

      if (e.active) {
        activeCount++;
        agg.active = true;
        // Event aktif: durasi belum selesai -> hitung sampai epoch fault
        // terakhir yang kita miliki (bukan "sekarang", agar deterministik).
        if (e.fromEpoch !== null && e.fromEpoch !== undefined) {
          activeSpanSec += Math.max(0, lastEpoch(evs) - e.fromEpoch);
        }
      } else {
        recovered++;
        var dur = (e.durationSec === null || e.durationSec === undefined) ? 0 : e.durationSec;
        activeDurationSec += dur;
        agg.durationSec += dur;
      }
    });

    // --- eventDensity: jumlah EVENT per 1000 jam operasi ---
    var smrRange = opts.smrRange;
    var hours = null;
    if (smrRange && smrRange.min !== null && smrRange.max !== null &&
        isFinite(smrRange.min) && isFinite(smrRange.max) && smrRange.max > smrRange.min) {
      hours = smrRange.max - smrRange.min;
    }
    var eventDensity = (hours && hours > 0) ? (evsScored.length / hours) * 1000 : null;

    // --- topCode: kode dengan Count tertinggi ---
    var topCode = null;
    Object.keys(byCode).forEach(function (k) {
      if (!topCode || byCode[k].count > topCode.count) topCode = byCode[k];
    });

    // --- byPillar: agregat yang sama dikelompokkan per pilar ---
    var byPillar = summarizeByPillar(byCode);

    // --- Integrasi gerbang kualitas data (T2) ---
    var maskReport = opts.maskReport || null;
    var dataUnfit = !!(maskReport && maskReport.wholeUnitMasked);

    var out = {
      eventCount: evsScored.length,
      recurrence: totalCount,
      activeCount: activeCount,
      recoveredCount: recovered,
      activeDurationSec: activeDurationSec,
      activeSpanSec: activeSpanSec,
      distinctCodes: Object.keys(distinct).length,
      smrHours: hours,
      eventDensity: eventDensity,
      topCode: topCode ? { code: topCode.code, msg: topCode.msg, count: topCode.count } : null,
      byCode: byCode,
      byPillar: byPillar,
      dataUnfit: dataUnfit,
      maskReport: maskReport,
      // [T6/D10] Alarm turunan dari sensor rusak yang DIKELUARKAN dari skor.
      // Daftar kode + jumlahnya tetap dilaporkan agar dapat diaudit.
      suppressedDerived: suppressedDerived,
      suppressedDerivedCount: Object.keys(suppressedDerived).length
    };
    out.faultScore = faultScore(out);
    return out;
  }

  /** Epoch terbesar di antara seluruh event (untuk menutup durasi aktif). */
  function lastEpoch(evs) {
    var hi = null;
    evs.forEach(function (e) {
      [e.fromEpoch, e.toEpoch].forEach(function (v) {
        if (v === null || v === undefined) return;
        if (hi === null || v > hi) hi = v;
      });
    });
    return (hi === null) ? 0 : hi;
  }

  /* -----------------------------------------------------------------------
   * Agregasi per PILAR.
   * ---------------------------------------------------------------------
   * `FAULT_SENSOR_MAP` memetakan kode fault -> key parameter VHMS. Melalui
   * `RANKING_PILLARS` kita tahu pilar parameter itu (ENGINE, POWERTRAIN, …).
   *
   * ATURAN PENTING: kode fault yang memetakan ke SELURUH parameter
   * (mis. `DBB6KP` suplai 24V, `DBBRKR` komunikasi) TIDAK dialokasikan ke
   * satu pilar pun. Fault itu bersifat UNIT-WIDE, jadi menaruhnya di pilar
   * tertentu akan menyesatkan sebaran penyebab. Kode tersebut dilaporkan
   * terpisah pada `unitWideCodes`.
   * --------------------------------------------------------------------- */
  function summarizeByPillar(byCode) {
    var MAP = cfg.FAULT_SENSOR_MAP || {};
    var PILLARS = cfg.RANKING_PILLARS || {};
    var ALL = cfg.ALL_PARAMS_SENTINEL || '*';
    var out = {};
    var unitWide = {};

    function bucket(pillar) {
      if (!out[pillar]) {
        out[pillar] = {
          pillar: pillar, eventCount: 0, recurrence: 0, distinctCodes: 0,
          activeCount: 0, codes: []
        };
      }
      return out[pillar];
    }

    Object.keys(byCode).forEach(function (code) {
      var agg = byCode[code];
      var def = MAP[code];
      if (!def) {
        // Kode tak dikenal (R2): tidak mem-mask apa pun, tetapi tetap
        // dihitung di pilar EVENT -> masuk bucket 'UNKNOWN'.
        var ub = bucket('UNKNOWN');
        ub.eventCount += agg.occurrences;
        ub.recurrence += agg.count;
        ub.distinctCodes += 1;
        if (agg.active) ub.activeCount += 1;
        ub.codes.push({ code: code, msg: agg.msg, count: agg.count, pillar: 'UNKNOWN' });
        return;
      }
      var params = def.params || [];
      if (params.indexOf(ALL) >= 0) {
        unitWide[code] = { code: code, msg: def.msg || agg.msg, count: agg.count, active: agg.active };
        return;
      }
      // [PC2000 2026-10-10 — T6] ALARM NILAI (`pillarOnly`).
      // -------------------------------------------------------------------
      // Sebagian kode PC2000 adalah ALARM NILAI (mis. "High LBR CYL. Exhaust
      // Temp"), bukan kegagalan sensor. Data-nya DIPERCAYA, jadi TIDAK boleh
      // mem-mask parameter apa pun — kalau di-mask, unit bermasalah justru
      // kehilangan bukti. Tetapi kode itu tetap harus menyumbang PILAR agar
      // sebaran penyebab (`summarizeByPillar`) informatif dan tidak menumpuk
      // di 'UNKNOWN'. Karena itu `pillarOnly` hanya mengisi bucket pilar.
      if (def.pillarOnly) {
        var bOnly = bucket(def.pillarOnly);
        bOnly.eventCount += agg.occurrences;
        bOnly.recurrence += agg.count;
        bOnly.distinctCodes += 1;
        if (agg.active) bOnly.activeCount += 1;
        bOnly.codes.push({ code: code, msg: def.msg || agg.msg, count: agg.count, pillar: def.pillarOnly });
        return;
      }
      // Semua param dari satu kode umumnya se-pilar; kumpulkan secara unik.
      var pillarsSeen = {};
      params.forEach(function (p) {
        var pillar = PILLARS[p] || 'OTHER';
        if (pillarsSeen[pillar]) return;
        pillarsSeen[pillar] = true;
        var b = bucket(pillar);
        b.eventCount += agg.occurrences;
        b.recurrence += agg.count;
        b.distinctCodes += 1;
        if (agg.active) b.activeCount += 1;
        b.codes.push({ code: code, msg: def.msg || agg.msg, count: agg.count, pillar: pillar });
      });
    });

    return { pillars: out, unitWideCodes: unitWide };
  }

  /* -----------------------------------------------------------------------
   * [T4.2] faultScore — 0..1
   * ---------------------------------------------------------------------
   * Kombinasi ter-normalisasi dari eventDensity (0.4), activeCount (0.35),
   * dan recurrence (0.25). Memakai SATURATING CURVE, BUKAN pembagian oleh
   * nilai maksimum armada — dengan begitu skor satu unit tidak berubah
   * ketika unit lain di-upload.
   *
   * Bila `eventDensity` tidak tersedia (rentang SMR trend belum diketahui),
   * bobotnya DIALIHKAN proporsional ke dua komponen lain agar skor tetap
   * bermakna dan tidak dianggap 0.
   * @returns {number} 0..1
   * --------------------------------------------------------------------- */
  function faultScore(summary) {
    if (!summary) return 0;

    var dNorm = (summary.eventDensity === null || summary.eventDensity === undefined)
      ? null : saturate(summary.eventDensity, CAL.densityK);
    var aNorm = saturate(summary.activeCount, CAL.activeK);
    var rNorm = saturate(summary.recurrence, CAL.recurrenceK);

    var wD = CAL.wDensity, wA = CAL.wActive, wR = CAL.wRecurrence;
    var score;
    if (dNorm === null) {
      // Alihkan bobot density secara proporsional (tanpa menebak density).
      var rest = wA + wR;
      score = (wA + wD * (wA / rest)) * aNorm + (wR + wD * (wR / rest)) * rNorm;
    } else {
      score = wD * dNorm + wA * aNorm + wR * rNorm;
    }
    if (!isFinite(score)) return 0;
    return Math.max(0, Math.min(1, score));
  }

  /** Ambang "unit layak skor" — true bila data fault menandai unit tak layak. */
  function isDataUnfit(summary) {
    return !!(summary && summary.dataUnfit);
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_FAULT = {
    CAL: CAL,
    saturate: saturate,
    summarize: summarize,
    faultScore: faultScore,
    summarizeByPillar: summarizeByPillar,
    isDataUnfit: isDataUnfit
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_FAULT;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * portfolio-render.js
 * -------------------------------------------------------------------------
 * Halaman PORTOFOLIO: menampilkan HANYA kompartemen SOS berstatus
 * CRITICAL/WARNING (di atas threshold) + summary highlight + konteks
 * Lifetime & Top-Up Oil + Suggestion teknis (KB + rule-based), siap cetak.
 *
 * Sumber data:
 *   - SOS_STORE         : unit & parameter SOS (Fe/Cu/Si/PQI/... )
 *   - SOS_CONFIG        : threshold per kompartemen + severityScore
 *   - SOS_KNOWLEDGE     : KB + rule-based rekomendasi
 *   - PORTFOLIO_STORE   : Lifetime Unit & Top-Up Oil (join per No Lambung)
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.SOS_CONFIG;

  /* -----------------------------------------------------------------------
   * Utilitas format (locale Indonesia)
   * --------------------------------------------------------------------- */
  function fmt(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var dec = (d === undefined || d === null) ? 1 : d;
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtInt(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('id-ID', { maximumFractionDigits: 0 });
  }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Parameter SOS yang dinilai (yang punya makna untuk wear/condition).
  var PARAM_KEYS = ['wear_fe', 'wear_cu', 'wear_al', 'wear_cr', 'wear_pb', 'wear_si',
                    'wear_sn', 'wear_ni', 'visc_v100', 'tbn', 'water_pct', 'fuel_pct',
                    'soot', 'oxidation', 'nitration', 'sulfation', 'pqi'];

  var TIER_BY_SEV = function (sev) {
    if (sev >= 4) return { label: 'EXTREME', cls: 'pf-extreme' };
    if (sev >= 2) return { label: 'CRITICAL', cls: 'pf-critical' };
    if (sev >= 1) return { label: 'WARNING', cls: 'pf-warning' };
    return { label: 'NORMAL', cls: 'pf-normal' };
  };
  // Band SOS (dari config TIER_LABELS): 0 NORMAL,1 MONITOR,2 CRITICAL,3 EXTREME
  var BAND_BY_TIER = ['NORMAL', 'MONITOR', 'CRITICAL', 'EXTREME'];

  /* -----------------------------------------------------------------------
   * [AUTO-TRIGGER KOMPONEN — TOP UP] Saat kompartemen ENGINE (section SOS
   * Engine ATAU section VHMS), tabel TOP UP juga menampilkan komponen
   * RADIATOR (sistem pendingin terkait mesin). Lifetime TIDAK terpengaruh
   * (tetap kompartemen aslinya). Pencocokan tetap via compMatches().
   * --------------------------------------------------------------------- */
  var TOPUP_EXTRA_COMPONENTS = { ENGINE: ['RADIATOR'] };
  /** Daftar nama komponen untuk tabel Top-Up (kompartemen + komponen ekstra). */
  function topupComponentsFor(component) {
    var base = String(component || '').trim();
    var up = base.toUpperCase();
    var extra = TOPUP_EXTRA_COMPONENTS[up] || [];
    var out = [base];
    extra.forEach(function (e) { out.push(e); });
    return out;
  }
  /**
   * Ambil baris Top-Up untuk kompartemen + komponen ekstra (mis. RADIATOR).
   * Dedup agar baris yang tertangkap dua kali tidak dobel.
   * @returns {object} { count, totalQty, lastDate, firstDate, rows }
   */
  function topupSummaryWithExtras(lambung, component) {
    var store = global.PORTFOLIO_STORE;
    if (!store) return { count: 0, totalQty: null, rows: [] };
    var keys = topupComponentsFor(component);
    var seen = {}, arr = [];
    keys.forEach(function (k) {
      (store.getTopup(lambung, k) || []).forEach(function (r) {
        var id = String(r.component) + '|' + String(r.date ? (r.date.epoch || r.date.display) : '') + '|' + String(r.qty);
        if (!seen[id]) { seen[id] = 1; arr.push(r); }
      });
    });
    arr.sort(function (a, b) {
      var ea = a.date ? a.date.epoch : 0, eb = b.date ? b.date.epoch : 0;
      return eb - ea;   // terbaru dulu
    });
    var total = 0, has = false;
    arr.forEach(function (r) { if (typeof r.qty === 'number') { total += r.qty; has = true; } });
    return {
      count: arr.length,
      totalQty: has ? Math.round(total * 10) / 10 : null,
      lastDate: arr.length && arr[0].date ? arr[0].date : null,
      firstDate: arr.length && arr[arr.length - 1].date ? arr[arr.length - 1].date : null,
      rows: arr
    };
  }

  /* -----------------------------------------------------------------------
   * SUGGESTION ENGINE v2 — lapisan terstruktur di atas KB (sos/vhms-knowledge).
   * Menambahkan, secara DETERMINISTIK (tanpa mengubah KB besar):
   *   - prioritas  : P1..P4 (berdasarkan severity umum, bukan rank lintas unit)
   *   - sla        : target waktu tindak lanjut
   *   - verifikasi : cara membuktikan perbaikan berhasil (acceptance criteria)
   *   - rujukan    : gabungan refs KB + rujukan SOP/manual default
   * --------------------------------------------------------------------- */
  var PRIORITY_BY_SEV = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_PRIORITY) || {
    4: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    3: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    2: { key: 'CRITICAL', label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    1: { key: 'WARNING',  label: 'WARNING',  cls: 'pf-warning',  sla: '2x24 Jam' }
  };
  var STATUS_CFG = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_STATUS) || {
    CRITICAL: { label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' },
    WARNING:  { label: 'WARNING',  cls: 'pf-warning',  sla: '2x24 Jam' },
    NORMAL:   { label: 'NORMAL',   cls: 'pf-normal',   sla: '-' }
  };
  /** Teks verifikasi default per kelompok parameter (dipakai bila tak ada spesifik). */
  var VERIFY_BY_GROUP = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_VERIFY) || {
    wear: 'Ambil sampel ulang; pastikan tren logam turun & kembali < ambang warning.',
    oil:  'Uji ulang kondisi oli; pastikan viskositas/TBN/oksidasi kembali dalam spesifikasi.',
    clean:'Periksa kontaminan (Si/air/soot) turun; pastikan kebersihan oli sesuai target ISO.',
    additive:'Pastikan aditif (Zn/P/Ca) kembali dalam rentang spesifikasi setelah ganti oli.',
    vhms: 'Uji fungsi & ukur ulang parameter; pastikan nilai kembali dalam ambang normal.'
  };
  var REF_DEFAULT = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_REF_DEFAULT)
    || 'Komatsu Shop Manual & SOP Condition Monitoring terkait.';
  /** Baca ulang config (bila user mengubah di Pengaturan tanpa reload). */
  function refreshFollowupConfig() {
    var vc = global.VHMS_CONFIG;
    if (!vc) return;
    if (vc.FOLLOWUP_STATUS) STATUS_CFG = vc.FOLLOWUP_STATUS;
    if (vc.FOLLOWUP_PRIORITY) PRIORITY_BY_SEV = vc.FOLLOWUP_PRIORITY;
    if (vc.FOLLOWUP_VERIFY) VERIFY_BY_GROUP = vc.FOLLOWUP_VERIFY;
    if (vc.FOLLOWUP_REF_DEFAULT) REF_DEFAULT = vc.FOLLOWUP_REF_DEFAULT;
  }

  /**
   * [STATUS DARI NILAI] Tentukan status dari NILAI vs THRESHOLD:
   *   - melewati ambang CRITICAL -> 'CRITICAL'
   *   - melewati ambang WARNING  -> 'WARNING'
   *   - selain itu               -> 'NORMAL'
   * Mendukung mode 'high' (makin besar makin buruk) & 'low' (makin kecil
   * makin buruk, mis. tekanan oli / TBN low / viskositas low).
   * @param {number} value
   * @param {object} th  { warn, crit, mode } — atau { warn_low, crit_low }
   * @returns {'CRITICAL'|'WARNING'|'NORMAL'}
   */
  function statusFromValue(value, th) {
    if (value === null || value === undefined || isNaN(value) || !th) return 'NORMAL';
    var v = Number(value);
    // Mode LOW: makin KECIL makin buruk (crit < warn).
    var isLow = (th.mode === 'low') || (th.crit_low !== undefined);
    if (isLow) {
      var warnL = (th.warn_low !== undefined) ? th.warn_low : th.warn;
      var critL = (th.crit_low !== undefined) ? th.crit_low : th.crit;
      if (typeof critL === 'number' && v <= critL) return 'CRITICAL';
      if (typeof warnL === 'number' && v <= warnL) return 'WARNING';
      return 'NORMAL';
    }
    // Mode HIGH: makin BESAR makin buruk.
    if (typeof th.crit === 'number' && v >= th.crit) return 'CRITICAL';
    if (typeof th.warn === 'number' && v >= th.warn) return 'WARNING';
    return 'NORMAL';
  }

  /** Ambil objek config status (label/cls/sla) dari config yang bisa diubah. */
  function statusMeta(status) {
    var s = STATUS_CFG[status];
    if (s) return s;
    // Fallback bila config tak lengkap.
    if (status === 'CRITICAL') return { label: 'CRITICAL', cls: 'pf-critical', sla: '1x24 Jam' };
    if (status === 'WARNING')  return { label: 'WARNING',  cls: 'pf-warning',  sla: '2x24 Jam' };
    return { label: 'NORMAL', cls: 'pf-normal', sla: '-' };
  }
  /**
   * Bangun metadata tindak lanjut untuk satu rekomendasi.
   * [STATUS] Ditentukan dari NILAI vs THRESHOLD (r.value, r.warnTh, r.critTh,
   * r.thMode) -> NORMAL / WARNING / CRITICAL, dengan SLA dari config.
   * @param {object} r rekomendasi (punya value/warnTh/critTh/thMode/param/refs)
   * @returns {object} { label, cls, sla, verify, refs }
   */
  function followUpMeta(r) {
    refreshFollowupConfig();   // ikuti perubahan Pengaturan tanpa reload
    // Flag historis (temuan yang sudah normal kini) -> status mengikuti record.
    var st = statusFromValue(r.value, { warn: r.warnTh, crit: r.critTh, mode: r.thMode });
    var p = statusMeta(st);
    // Verifikasi: pakai konteks grup bila ada di KB
    var group = r.group || '';
    var verify = VERIFY_BY_GROUP[group] || null;
    if (!verify) {
      var pk = String(r.param || '');
      if (/^wear_/.test(pk)) verify = VERIFY_BY_GROUP.wear;
      else if (/visc|tbn|oxidation|nitration|sulfation|tan|water|fuel|soot/.test(pk)) verify = VERIFY_BY_GROUP.oil;
      else if (/pqi|iso|clean/.test(pk)) verify = VERIFY_BY_GROUP.clean;
      else if (/^additive_/.test(pk)) verify = VERIFY_BY_GROUP.additive;
      else verify = VERIFY_BY_GROUP.vhms;
    }
    // Rujukan: pakai refs dari KB bila ada; default SOP hanya sebagai FALLBACK
    // (agar tidak muncul duplikat "SOP Condition Monitoring" di setiap baris).
    var refs = (r.refs || []).slice();
    if (!refs.length) refs.push(REF_DEFAULT);
    // dedup, jaga urutan
    var seen = {}, uniq = [];
    refs.forEach(function (x) { var k = String(x).trim(); if (k && !seen[k]) { seen[k] = 1; uniq.push(k); } });
    return { label: p.label, cls: p.cls, sla: p.sla, verify: verify, refs: uniq };
  }

  /* -----------------------------------------------------------------------
   * VHMS — kumpulkan anomali (melewati threshold) untuk sebuah unit VHMS.
   * Memakai analysis.anomalies (sudah dihitung vhms-analytics, status != NORMAL).
   * @param {object} summaryRow  baris katalog VHMS (punya id/lambung/model/serial)
   * @returns {array}
   * --------------------------------------------------------------------- */
  function breachedVhmsParams(summaryRow) {
    var fleet = global.VHMS_FLEET;
    if (!fleet || !summaryRow) return [];
    var analysis = fleet.getAnalysis(summaryRow.id);
    if (!analysis || !analysis.records || !analysis.records.length) return [];

    var vcfg = global.VHMS_CONFIG;
    var TH = analysis.thresholdSet || vcfg.THRESHOLDS;
    var evalParam = global.VHMS_ANALYTICS && global.VHMS_ANALYTICS.evaluateParam;

    // [DATA TERBARU] Pakai record TERAKHIR (paling baru) — bukan nilai ekstrem
    // window. Portofolio hanya menampilkan parameter yang melewati threshold
    // pada kondisi TERKINI.
    var records = analysis.records;
    var lastRec = records[records.length - 1];

    // Anomali historis (window) untuk catatan "pernah breach".
    var histMap = {};
    (analysis.anomalies || []).forEach(function (a) { histMap[a.param] = a; });

    var out = [];
    Object.keys(TH).forEach(function (key) {
      var th = TH[key];
      if (!th) return;
      var v = lastRec[key];
      if (v === null || v === undefined) return;

      // Evaluasi & tampilan ambang memakai threshold snapshot (TH). Snapshot
      // dijaga tetap segar via reanalyzeAll() saat boot (setelah config dimuat).
      var st = evalParam ? evalParam(key, v, TH) : null;
      var meta = vcfg.PARAMS[key] || { label: key, unit: '', decimals: 1 };

      if (st && st !== 'NORMAL') {
        // Melewati threshold pada data TERBARU -> tampilkan sebagai temuan aktif.
        out.push({
          key: key,
          label: meta.label,
          value: v,
          unit: meta.unit || '',
          decimals: meta.decimals,
          warn: th.warn,
          crit: th.crit,
          thMode: th.mode || 'high',
          severity: st === 'CRITICAL' ? 2 : 1,
          status: st,
          cls: st === 'CRITICAL' ? 'pf-critical' : 'pf-warning',
          title: (histMap[key] && histMap[key].title) || meta.label,
          system: (histMap[key] && histMap[key].system) || '',
          slope: histMap[key] ? histMap[key].slope : null,
          rul: histMap[key] ? histMap[key].rul : null,
          actions: (histMap[key] && histMap[key].actions) || [],
          current: true
        });
      } else if (histMap[key]) {
        // Nilai terbaru NORMAL, tapi parameter pernah melewati threshold pada
        // window -> catat sebagai temuan historis (informasi tambahan).
        var a = histMap[key];
        out.push({
          key: key,
          label: meta.label,
          value: v,
          unit: meta.unit || '',
          decimals: meta.decimals,
          warn: th.warn,
          crit: th.crit,
          thMode: th.mode || 'high',
          severity: a.status === 'CRITICAL' ? 2 : 1,
          status: a.status,             // status yang PERNAH terjadi
          cls: 'pf-muted',              // gaya redup (historis)
          title: a.title || meta.label,
          system: a.system || '',
          slope: a.slope,
          rul: a.rul,
          actions: a.actions || [],
          current: false,
          historicalValue: a.value,     // nilai puncak saat breach
          historicalDate: a.calendar && a.calendar.display ? a.calendar.display : null
        });
      }
    });

    // Urutkan: temuan AKTIF dulu (paling parah), lalu historis.
    out.sort(function (x, y) {
      if (x.current !== y.current) return x.current ? -1 : 1;
      return y.severity - x.severity;
    });
    return out;
  }

  /** Rekomendasi KB VHMS untuk satu anomali (memakai vhms-knowledge.js). */
  function vhmsRecommend(anomaly) {
    var trend = null;
    if (anomaly.slope !== null && anomaly.slope !== undefined && Math.abs(anomaly.slope) > 1e-9) {
      trend = anomaly.slope > 0 ? 'up' : 'down';
    }
    if (global.VHMS_KNOWLEDGE && global.VHMS_KNOWLEDGE.recommend) {
      var r = global.VHMS_KNOWLEDGE.recommend({
        param: anomaly.key, title: anomaly.title, system: anomaly.system,
        status: anomaly.status, value: anomaly.value, unit: anomaly.unit,
        actions: anomaly.actions, slope: anomaly.slope
      }, { trend: trend });
      // Normalisasi agar format sama dgn SOS:
      //  - severity: angka (2=critical, 1=warning), BUKAN string 'critical'/'warn'
      //  - label: nama parameter; title: nama event VHMS
      r.severity = anomaly.severity;
      r.level = anomaly.severity >= 2 ? 'critical' : 'warn';
      r.label = anomaly.label;
      r.title = anomaly.title || r.title;
      r.system = r.system || anomaly.system || '';
      r.value = anomaly.value;
      // [STATUS DARI NILAI] Simpan ambang agar status & SLA dihitung dari
      // perbandingan nilai vs threshold (bukan dari severity string).
      r.warnTh = anomaly.warn;
      r.critTh = anomaly.crit;
      r.thMode = anomaly.thMode || 'high';
      r.unit = anomaly.unit;
      return r;
    }
    return {
      param: anomaly.key, label: anomaly.label, title: anomaly.title,
      system: anomaly.system, value: anomaly.value, unit: anomaly.unit,
      severity: anomaly.severity, level: anomaly.severity >= 2 ? 'critical' : 'warn',
      likely: [], actions: anomaly.actions || ['Lakukan inspeksi sesuai shop manual.'],
      escalate: '', fromKB: false
    };
  }

  /* -----------------------------------------------------------------------
   * Kumpulkan parameter yang melewati threshold untuk sebuah unit SOS.
   * @returns {array} [{ key,label,value,unit,warn,crit,severity,status,tier }]
   * --------------------------------------------------------------------- */
  function breachedParams(unit) {
    var th = cfg.getThresholdsFor(unit.component);
    var latest = unit.latest || {};
    var out = [];
    PARAM_KEYS.forEach(function (pk) {
      var t = th[pk];
      if (!t) return;
      var v = latest[pk];
      if (v === null || v === undefined) return;
      var sev = global.SOS_ANALYTICS.severityScore(v, t, pk);
      if (sev < 1) return; // hanya yang melewati warning ke atas
      var meta = cfg.PARAMS[pk] || {};
      out.push({
        key: pk,
        label: meta.label || pk,
        value: v,
        unit: meta.unit || '',
        decimals: meta.decimals,
        warn: (t.warn !== undefined) ? t.warn : t.warn_low,
        crit: (t.crit !== undefined) ? t.crit : t.crit_low,
        severity: sev,
        status: TIER_BY_SEV(sev).label,
        cls: TIER_BY_SEV(sev).cls
      });
    });
    // urutkan paling parah dulu
    out.sort(function (a, b) { return b.severity - a.severity; });
    return out;
  }

  /**
   * Bangun bagian SOS untuk satu unit SOS (parameter kritis + rekomendasi +
   * konteks lifetime/top-up kompartemen). Mengembalikan null bila tidak ada
   * parameter SOS yang melewati threshold DAN tier bukan CRITICAL/EXTREME.
   */
  function buildSosSection(unit) {
    var breached = breachedParams(unit);
    var tier = (unit.mprs && unit.mprs.tier) || 0;
    if (!breached.length && tier < 2) return null;

    var lambung = global.PORTFOLIO_STORE
      ? global.PORTFOLIO_STORE.resolveLambung(unit.assetId, unit.serial)
      : unit.assetId;

    var lt = (global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.lifetimeSummary(lambung, unit.component) : { row: null, rows: [] });
    // [TOP-UP + EKSTRA] Untuk kompartemen ENGINE, Top-Up juga menarik RADIATOR.
    var tp = topupSummaryWithExtras(lambung, unit.component);

    var recs = breached.map(function (b) {
      var rec = global.SOS_KNOWLEDGE.recommend(b.key, b.severity, {
        label: b.label, value: b.value, unit: b.unit
      });
      // [STATUS DARI NILAI] Simpan nilai & ambang agar status (NORMAL/WARNING/
      // CRITICAL) + SLA dihitung dari perbandingan nilai vs threshold.
      rec.value = b.value;
      rec.warnTh = b.warn;
      rec.critTh = b.crit;
      rec.thMode = (b.crit !== undefined && b.warn !== undefined && b.crit < b.warn) ? 'low' : 'high';
      return rec;
    });
    var rules = global.SOS_KNOWLEDGE.ruleBased([{
      component: unit.component,
      lifePct: lt.lifePct,
      remainingHours: lt.remainingHours,
      cycleBudget: lt.cycleBudget,
      topupQty: tp.totalQty,
      topupCount: tp.count
    }]);

    return {
      source: 'SOS',
      unitId: unit.assetId,
      component: unit.component,
      model: unit.model,
      serial: unit.serial,
      lambung: lambung,
      band: BAND_BY_TIER[tier] || 'NORMAL',
      score: (unit.criticality && unit.criticality.score) || 0,
      hmUnit: unit.hmUnit,
      hmOil: unit.hmOil,
      lastDate: unit.lastDate,
      breached: breached,
      lifetime: lt,
      topup: tp,
      // Kompartemen untuk konteks Lifetime/Top-Up (auto-trigger = kompartemen SOS).
      contextComponent: unit.component,
      recs: recs,
      rules: rules
    };
  }

  /**
   * Bangun bagian VHMS untuk satu unit VHMS. Mengembalikan null bila tidak ada
   * anomali (CRITICAL/WARNING) pada unit tersebut.
   */
  function buildVhmsSection(row) {
    var breached = breachedVhmsParams(row);
    if (!breached.length) return null;

    var active = breached.filter(function (b) { return b.current; });
    var historical = breached.filter(function (b) { return !b.current; });

    var lambung = row.lambung || (global.PORTFOLIO_STORE
      ? global.PORTFOLIO_STORE.resolveLambung(row.serial, row.serial) : row.serial);
    // [AUTO-TRIGGER KOMPONEN] VHMS bersifat telemetri mesin -> Lifetime &
    // Top-Up difokuskan ke kompartemen ENGINE (bukan seluruh komponen).
    var vhmsComp = 'ENGINE';
    var lt = (global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.lifetimeSummary(lambung, vhmsComp) : { rows: [] });
    // [TOP-UP + EKSTRA] Section VHMS (Engine) -> Top-Up juga menarik RADIATOR.
    var tp = topupSummaryWithExtras(lambung, vhmsComp);
    // [REVISI] Rekomendasi untuk SEMUA temuan VHMS (aktif + historis), agar
    // section VHMS tetap muncul walau temuan hanya ada di window (historis).
    // Ini menyamakan perilaku VHMS dengan SOS (yang juga menampilkan historis).
    var recs = breached.map(vhmsRecommend);
    var rules = global.SOS_KNOWLEDGE.ruleBased([{
      component: 'ENGINE',  // VHMS tidak per-kompartemen; konteks utama pilar ENGINE
      lifePct: lt.lifePct, remainingHours: lt.remainingHours, cycleBudget: lt.cycleBudget,
      topupQty: tp.totalQty, topupCount: tp.count
    }]);
    // Band section VHMS: mengikuti temuan TERBURUK (aktif ATAU historis).
    var hasCrit = breached.some(function (b) { return b.severity >= 2; });
    var band = hasCrit ? 'CRITICAL' : 'WARNING';
    return {
      source: 'VHMS',
      unitId: row.id,
      component: row.productGroup || row.engineModel || 'TELEMETRI',
      model: row.model,
      serial: row.serial,
      lambung: lambung,
      band: band,
      score: row.rankScore || 0,
      hmUnit: row.smrLast,
      hmOil: null,
      lastDate: row.lastTimestamp,
      breached: breached,          // aktif + historis (historis ditandai `current:false`)
      activeCount: active.length,
      historicalCount: historical.length,
      lifetime: lt,
      topup: tp,
      // Kompartemen yang dipakai untuk konteks Lifetime/Top-Up (auto-trigger).
      contextComponent: vhmsComp,
      recs: recs,
      rules: rules
    };
  }

  /**
   * Kumpulkan unit untuk portofolio: gabungkan bagian SOS + VHMS PER UNIT
   * (berdasarkan Nomor Lambung). Setiap entri = satu unit dengan daftar
   * `sections` (bisa berisi SOS dan/atau VHMS).
   * @param {string} [onlyLambung] batasi ke satu unit (mode per-unit).
   * @returns {array}
   */
  function collect(onlyLambung) {
    var byUnit = {};   // normLambung -> { lambung, model, serial, sections: [] }

    function keyOf(lambung) {
      return global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.normLambung(lambung) : String(lambung).toUpperCase();
    }
    function ensure(lambung, model, serial) {
      var k = keyOf(lambung) || ('__' + (serial || Math.random()));
      if (!byUnit[k]) byUnit[k] = { lambung: lambung || serial || '—', model: model || '', serial: serial || '', sections: [] };
      if (!byUnit[k].model && model) byUnit[k].model = model;
      if (!byUnit[k].serial && serial) byUnit[k].serial = serial;
      return byUnit[k];
    }

    // --- SOS ---
    var sosStore = global.SOS_STORE;
    if (sosStore) {
      sosStore.getAllUnits().forEach(function (u) {
        var sec = buildSosSection(u);
        if (!sec) return;
        var ent = ensure(sec.lambung, sec.model, sec.serial);
        ent.sections.push(sec);
      });
    }

    // --- VHMS ---
    var vhmsStore = global.VHMS_FLEET;
    if (vhmsStore && vhmsStore.rows) {
      vhmsStore.rows().forEach(function (row) {
        var sec = buildVhmsSection(row);
        if (!sec) return;
        var ent = ensure(sec.lambung, sec.model, sec.serial);
        ent.sections.push(sec);
      });
    }

    var out = Object.keys(byUnit).map(function (k) { return byUnit[k]; });

    // Filter mode per-unit
    if (onlyLambung) {
      var target = global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.normLambung(onlyLambung) : String(onlyLambung).toUpperCase();
      out = out.filter(function (e) { return keyOf(e.lambung) === target; });
    }

    // Hitung band unit = yang terburuk di antara sections
    var order = { EXTREME: 4, CRITICAL: 3, WARNING: 2, MONITOR: 1, NORMAL: 0 };
    out.forEach(function (e) {
      var worst = 'NORMAL', worstScore = 0;
      e.sections.forEach(function (s) {
        if ((order[s.band] || 0) > (order[worst] || 0)) worst = s.band;
        if ((s.score || 0) > worstScore) worstScore = s.score;
      });
      e.band = worst;
      e.score = worstScore;
    });

    out.sort(function (a, b) {
      var oa = order[a.band] || 0, ob = order[b.band] || 0;
      if (oa !== ob) return ob - oa;
      return (b.score || 0) - (a.score || 0);
    });
    return out;
  }

  /* -----------------------------------------------------------------------
   * Render HTML
   * --------------------------------------------------------------------- */

  /**
   * RANGKUMAN SUGGESTION TEKNIS untuk satu section (v2 — terstruktur penuh).
   * Menyajikan rencana tindak lanjut yang dapat langsung dieksekusi:
   *   Prioritas | Parameter/Event | Aksi | Penyebab | Target (SLA) | Verifikasi
   * ditambah blok HIPOTESIS & "perlu tindakan segera". Rujukan dirangkum
   * di bawah tabel agar tidak memperlebar kolom.
   */
  function suggestionSummaryHtml(sec) {
    var recs = sec.recs || [];
    var rules = sec.rules || [];
    var h = '';

    // ---- 1) Tabel rencana tindak lanjut TERSTRUKTUR per parameter ----
    if (recs.length) {
      h += '<table class="pf-table pf-table-sm pf-sugg-table pf-sugg-plan">' +
        '<colgroup>' +
          '<col class="p-prio">' +
          '<col class="p-param">' +
          '<col class="p-act">' +
          '<col class="p-cause">' +
          '<col class="p-sla">' +
          '<col class="p-verify">' +
        '</colgroup>' +
        '<thead><tr>' +
        '<th class="center">Status</th><th>Parameter / Event</th><th>Aksi (What &amp; How)</th>' +
        '<th>Penyebab (Why)</th><th class="center">Target</th><th>Verifikasi</th>' +
        '</tr></thead><tbody>';
      recs.forEach(function (r) {
        var meta = followUpMeta(r);
        var name = r.title || r.label || r.param || '';
        var actions = (r.actions || []).slice(0, 3);
        var causes = (r.likely || []).slice(0, 3);
        h += '<tr>' +
          '<td class="center pf-prio-cell"><span class="pf-badge ' + meta.cls + '">' + esc(meta.label) + '</span></td>' +
          '<td class="pf-param-cell"><strong>' + esc(name) + '</strong>' +
            (r.title && r.label && r.label !== r.title ? '<span class="pf-unit"> ' + esc(r.label) + '</span>' : '') +
          '</td>' +
          '<td class="pf-sugg-act">' + (actions.length
              ? '<ol class="pf-plan-list">' + actions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ol>'
              : '—') + '</td>' +
          '<td class="pf-sugg-cause">' + (causes.length
              ? '<ul class="pf-plan-list">' + causes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>'
              : '—') + '</td>' +
          '<td class="center pf-sla-cell"><span class="pf-plan-sla">' + esc(meta.sla) + '</span></td>' +
          '<td class="pf-sugg-verify">' + esc(meta.verify) + '</td>' +
          '</tr>';
      });
      h += '</tbody></table>';

      // Rujukan gabungan (dedup) di bawah tabel agar tabel tetap ramping.
      var refSeen = {}, refList = [];
      recs.forEach(function (r) {
        followUpMeta(r).refs.forEach(function (x) {
          var k = String(x).trim();
          if (k && !refSeen[k]) { refSeen[k] = 1; refList.push(k); }
        });
      });
      if (refList.length) {
        h += '<div class="pf-refs"><i class="fa-solid fa-book"></i> <strong>Rujukan:</strong> ' +
          refList.map(function (x) { return esc(x); }).join(' · ') + '</div>';
      }
    }

    // Kumpulkan tindakan unik (dedup) + label KOMPARTEMEN asal tindakan.
    // Bila tindakan sama muncul dari >1 kompartemen -> kompartemen digabung.
    var actionMap = {}, actionOrder = [];
    recs.forEach(function (r) {
      var comp = compartmentFor(r.param, sec);
      (r.actions || []).forEach(function (a) {
        var k = String(a).trim();
        if (!k) return;
        if (!actionMap[k]) { actionMap[k] = {}; actionOrder.push(k); }
        if (comp) actionMap[k][comp] = true;
      });
    });
    function actionLi(text, isRule) {
      var comps = actionMap[text] ? Object.keys(actionMap[text]) : [];
      return '<li' + (isRule ? ' class="pf-sugg-rule"' : '') + '>' + esc(text) +
        (comps.length ? ' <span class="rp-comp-tag">[' + esc(comps.join(', ')) + ']</span>' : '') + '</li>';
    }
    // Rule-based (lifetime/top-up) menyumbang tindakan tanpa kompartemen spesifik.
    var ruleList = [];
    rules.forEach(function (rl) { ruleList.push(rl.title + ' — ' + rl.detail); });

    // ---- 2) Daftar TINDAKAN gabungan ----
    // [2 KOLOM EKSPLISIT] Untuk daftar panjang, jangan pakai column-count
    // (menyebabkan ketidakseimbangan saat pecah antar-halaman). Bagi item
    // menjadi 2 kolom SEIMBANG dan render 2 <ul> berdampingan (grid).
    var allActions = ruleList.concat(actionOrder);
    if (allActions.length) {
      var actN = allActions.length;
      var useTwoCol = actN >= 6;
      var actShort = actN <= 6 ? ' pf-sugg-short' : '';
      h += '<div class="pf-sugg-block' + actShort + '"><div class="pf-rec-sub"><i class="fa-solid fa-screwdriver-wrench"></i> ' +
        'Tindakan gabungan (' + actN + '):</div>';
      if (useTwoCol) {
        // bagi rata: separuh atas ke kolom kiri, sisanya ke kanan
        var half = Math.ceil(actN / 2);
        var colA = allActions.slice(0, half);
        var colB = allActions.slice(half);
        h += '<div class="pf-sugg-2col-grid">';
        h += '<ul class="pf-sugg-list pf-sugg-col">';
        colA.forEach(function (x) { h += actionLi(x, ruleList.indexOf(x) !== -1); });
        h += '</ul>';
        h += '<ul class="pf-sugg-list pf-sugg-col">';
        colB.forEach(function (x) { h += actionLi(x, ruleList.indexOf(x) !== -1); });
        h += '</ul>';
        h += '</div>';
      } else {
        h += '<ul class="pf-sugg-list">';
        allActions.forEach(function (x) { h += actionLi(x, ruleList.indexOf(x) !== -1); });
        h += '</ul>';
      }
      h += '</div>';
    }

    // ---- 3) HIPOTESIS EFFECT dipindah ke atas (di bawah tabel Parameter) ----
    // Lihat fungsi hypothesesHtml() yang dipanggil terpisah di render().

    // ---- 4) Peringatan mendesak gabungan ----
    var escSeen = {}, escList = [];
    recs.forEach(function (r) {
      if (r.escalate) {
        var k = String(r.escalate).trim();
        if (k && !escSeen[k]) { escSeen[k] = 1; escList.push(k); }
      }
    });
    if (escList.length) {
      h += '<div class="pf-escalate"><i class="fa-solid fa-triangle-exclamation"></i> <strong>Perlu tindakan segera:</strong> ' +
        escList.map(function (x) { return esc(x); }).join(' · ') + '</div>';
    }

    return h;
  }

  /**
   * [KOMPARTEMEN] Tentukan label kompartemen/pilar untuk sebuah parameter.
   * - VHMS: RANKING_PILLARS[param] (ENGINE/HYDRAULIC/COOLING/ECONOMY).
   *         Bila param tak ada di peta -> '' (JANGAN pakai productGroup spt
   *         "Bulldozer" karena itu tipe unit, bukan kompartemen).
   * - SOS : sec.component (kompartemen SOS, mis. ENGINE).
   * Ditampilkan Title Case, mis. "ENGINE" -> "Engine".
   */
  function titleCaseComp(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s/])([a-z])/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
  }
  function compartmentFor(paramKey, sec) {
    var vc = global.VHMS_CONFIG;
    var pil = vc && vc.RANKING_PILLARS ? vc.RANKING_PILLARS[paramKey] : null;
    if (pil) return titleCaseComp(pil);
    // SOS -> kompartemen section. VHMS tanpa pilar -> kosong.
    if (sec && sec.source === 'SOS' && sec.component) return titleCaseComp(sec.component);
    return '';
  }

  /**
   * Blok "Hipotesis Effect" — daftar hipotesis/penyebab gabungan (dedup).
   * Tiap item diberi label KOMPARTEMEN [Engine] agar tim follow-up tahu
   * di mana perbaikannya; bila teks sama muncul dari >1 kompartemen,
   * kompartemen digabung.
   */
  function hypothesesHtml(sec) {
    var recs = sec.recs || [];
    var causeMap = {}, causeOrder = [];
    recs.forEach(function (r) {
      var comp = compartmentFor(r.param, sec);
      (r.likely || []).forEach(function (x) {
        var k = String(x).trim();
        if (!k) return;
        if (!causeMap[k]) { causeMap[k] = {}; causeOrder.push(k); }
        if (comp) causeMap[k][comp] = true;
      });
    });
    if (!causeOrder.length) return '';
    var causeShort = causeOrder.length <= 6 ? ' pf-sugg-short' : '';
    var h = '<div class="pf-sugg-block rp-hypo"><div class="pf-rec-sub"><i class="fa-solid fa-magnifying-glass"></i> ' +
      'Hipotesis Effect (' + causeOrder.length + '):</div>' +
      '<ul class="pf-sugg-list pf-sugg-causes pf-sugg-2col' + causeShort + '">';
    causeOrder.forEach(function (x) {
      var comps = Object.keys(causeMap[x]);
      h += '<li>' + esc(x) + (comps.length ? ' <span class="rp-comp-tag">[' + esc(comps.join(', ')) + ']</span>' : '') + '</li>';
    });
    h += '</ul></div>';
    return h;
  }

  /* -----------------------------------------------------------------------
   * Entry render
   * --------------------------------------------------------------------- */
  var portfolioState = { mode: 'fleet', unitLambung: '' };

  function setState(patch) {
    Object.keys(patch || {}).forEach(function (k) { portfolioState[k] = patch[k]; });
  }
  function getState() { return Object.assign({}, portfolioState); }

  // Daftar unit yang tersedia (untuk dropdown mode per-unit)
  function availableUnits() {
    var seen = {}, out = [];
    function add(lambung, model) {
      if (!lambung) return;
      var key = global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.normLambung(lambung) : String(lambung).toUpperCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ lambung: lambung, model: model || '' });
    }
    var sosStore = global.SOS_STORE;
    if (sosStore) {
      sosStore.getAllUnits().forEach(function (u) {
        var lb = global.PORTFOLIO_STORE ? global.PORTFOLIO_STORE.resolveLambung(u.assetId, u.serial) : u.assetId;
        add(lb || u.assetId, u.model);
      });
    }
    var vhmsStore = global.VHMS_FLEET;
    if (vhmsStore && vhmsStore.rows) {
      vhmsStore.rows().forEach(function (row) {
        add(row.lambung || row.serial, row.model);
      });
    }
    return out.sort(function (a, b) { return String(a.lambung).localeCompare(String(b.lambung)); });
  }

  /* -----------------------------------------------------------------------
   * Entry render — DOKUMEN FORMAL (siap cetak)
   * ---------------------------------------------------------------------
   * Hanya menampilkan TEMPLATE DATA: tabel parameter di atas threshold
   * (SOS & VHMS), konteks lifetime & top-up, lalu rangkuman suggestion.
   * Informasi dashboard (kartu unit/critical/warning) TIDAK ditampilkan.
   * --------------------------------------------------------------------- */

  /** Format tanggal singkat Indonesia. */
  function todayLong() {
    var d = new Date();
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  /**
   * Tabel parameter di atas threshold dalam format formal.
   * @param {array}  breached  daftar temuan (aktif & historis)
   * @param {string} kind      'SOS' | 'VHMS'
   */
  function thresholdTableFormal(breached, kind) {
    var isVhms = kind === 'VHMS';
    // [LAYOUT] Lebar kolom dikunci via colgroup + table-layout:fixed agar
    // teks "Tindakan Utama" punya ruang cukup (tidak berdesakan/terpotong)
    // dan ruang kanan tabel tidak menganggur.
    var h = '<table class="rp-table rp-table-params">' +
      '<colgroup>' +
        '<col class="c-no">' +
        '<col class="c-param">' +
        '<col class="c-val">' +
        '<col class="c-warn">' +
        '<col class="c-crit">' +
        '<col class="c-status">' +
        '<col class="c-act">' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th class="rp-no">No</th>' +
      '<th>' + (isVhms ? 'Parameter / Event VHMS' : 'Parameter SOS') + '</th>' +
      '<th class="center">Nilai</th>' +
      '<th class="center">Ambang Warning</th>' +
      '<th class="center">Ambang Critical</th>' +
      '<th class="center">Status</th>' +
      '<th class="rp-act">Tindakan Utama</th>' +
      '</tr></thead><tbody>';
    var n = 0;
    breached.forEach(function (b) {
      n++;
      var isHist = b.current === false;
      var name = (isVhms && b.title) ? b.title : b.label;
      var sub = (isVhms && b.title && b.label && b.label !== b.title) ? b.label : '';
      var status = isHist ? (b.status + ' <span class="rp-muted">(kini normal)</span>') : b.status;
      var act = '—';
      if (!isHist && b.actions && b.actions.length) act = b.actions[0];
      h += '<tr' + (isHist ? ' class="rp-row-hist"' : '') + '>' +
        '<td class="rp-no">' + n + '</td>' +
        '<td><strong>' + esc(name) + '</strong>' +
          (sub ? '<span class="rp-sub"> (' + esc(sub) + ')</span>' : '') +
          (isHist && b.historicalValue !== null && b.historicalValue !== undefined
            ? '<span class="rp-peak">puncak ' + fmt(b.historicalValue, b.decimals) +
              (b.historicalDate ? ' @ ' + esc(b.historicalDate) : '') + '</span>' : '') +
        '</td>' +
        '<td class="center mono">' + fmt(b.value, b.decimals) + ' ' + esc(b.unit) + '</td>' +
        '<td class="center mono">' + fmt(b.warn, b.decimals) + '</td>' +
        '<td class="center mono">' + fmt(b.crit, b.decimals) + '</td>' +
        '<td class="center"><span class="rp-badge ' + (isHist ? 'rp-muted-badge' : b.cls) + '">' +
          esc(isHist ? 'NORMAL' : b.status) + '</span></td>' +
        '<td class="rp-act">' + esc(act) + '</td>' +
        '</tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  /** Blok heading bernomor untuk bagian dokumen. */
  function docSectionTitle(no, text) {
    return '<div class="rp-sec"><span class="rp-sec-no">' + no + '</span>' + esc(text) + '</div>';
  }

  function render() {
    var box = document.getElementById('portfolio-content');
    if (!box) return;

    var hasSos = global.SOS_STORE && global.SOS_STORE.getAllUnits().length;
    var hasVhms = global.VHMS_FLEET && global.VHMS_FLEET.rows && global.VHMS_FLEET.rows().length;
    if (!hasSos && !hasVhms) {
      box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-info"></i> ' +
        'Belum ada data SOS / VHMS. Muat data terlebih dahulu agar laporan dapat disusun.</div>';
      return;
    }

    var units;
    if (portfolioState.mode === 'unit' && portfolioState.unitLambung) {
      units = collect(portfolioState.unitLambung);
    } else {
      units = collect();
    }

    if (!units.length) {
      box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
        'Tidak ada parameter yang melewati threshold pada data terbaru.</div>';
      return;
    }

    var h = '<div class="rp-doc">';
    var sectionNo = 0;
    var unitIdx = 0;   // [PAGE BREAK] penghitung UNIT (bukan blok sumber)

    units.forEach(function (unit) {
      // [PAGE BREAK PINTAR] Setiap UNIT baru mulai di halaman baru (rapi antar
      // unit), TETAPI blok sumber di dalam 1 unit (SOS & VHMS) MENGALIR tanpa
      // dipaksa pindah halaman. Ini menghemat halaman (tidak ada halaman
      // setengah kosong karena paksa page-break per sumber).
      var unitPageBreak = unitIdx > 0;
      unitIdx++;
      // [KOP UNIT] Susunan: Nomor Lambung || Model || Serial Number.
      // Serial Number diambil dari data Lifetime (raw SerialNumber) untuk
      // lambung unit ini; fallback ke serial unit bila tak ada.
      var serialNo = '—';
      if (global.PORTFOLIO_STORE) {
        var ltRows = global.PORTFOLIO_STORE.getLifetime(unit.lambung);
        for (var li = 0; li < ltRows.length; li++) {
          if (ltRows[li].serial) { serialNo = ltRows[li].serial; break; }
        }
      }
      if (serialNo === '—' && unit.serial) serialNo = unit.serial;
      // [JUDUL] Bagian setelah em-dash = SUMBER temuan (SOS / VHMS / SOS - VHMS)
      // menyesuaikan parameter yang di atas threshold — bukan nomor lambung,
      // agar tidak dobel dengan baris meta di bawahnya.
      var srcLabels = [];
      unit.sections.forEach(function (s) {
        if ((s.breached || []).length && srcLabels.indexOf(s.source) === -1) srcLabels.push(s.source);
      });
      var srcLabel = srcLabels.length ? srcLabels.join(' - ') : 'SOS';
      // [WRAPPER UNIT] Bungkus seluruh unit agar page-break per unit bekerja
      // andal & tidak meninggalkan celah halaman kosong.
      h += '<div class="rp-unit-block' + (unitPageBreak ? ' rp-page-break' : '') + '">';
      h += '<div class="rp-unit-head">' +
        '<div class="rp-unit-title">Laporan Condition Monitoring — ' + esc(srcLabel) + '</div>' +
        '<div class="rp-unit-meta">' +
          'Nomor Lambung: <strong>' + esc(unit.lambung || '—') + '</strong>' +
          ' &nbsp;||&nbsp; Model: <strong>' + esc(unit.model || '—') + '</strong>' +
          ' &nbsp;||&nbsp; Serial Number: <strong>' + esc(serialNo) + '</strong>' +
        '</div></div>';

      // [TTD] Tentukan section yang mendapat blok tanda tangan.
      // Aturan: bila unit punya SOS & VHMS bersamaan, TTD HANYA di akhir VHMS;
      // bila hanya salah satu sumber, TTD di akhir section tersebut.
      var sectionsWithFindings = unit.sections.filter(function (s) { return (s.breached || []).length; });
      var hasBothSources = sectionsWithFindings.some(function (s) { return s.source === 'VHMS'; }) &&
                           sectionsWithFindings.some(function (s) { return s.source === 'SOS'; });
      var signSection = null;
      if (hasBothSources) {
        // utamakan VHMS sebagai penutup; fallback ke section terakhir.
        signSection = sectionsWithFindings.filter(function (s) { return s.source === 'VHMS'; }).pop()
                   || sectionsWithFindings[sectionsWithFindings.length - 1];
      } else {
        signSection = sectionsWithFindings[sectionsWithFindings.length - 1] || null;
      }

      // ---- Bagian parameter per sumber (SOS / VHMS) ----
      // [PAGE BREAK PINTAR] Tidak ada page-break antar sumber; SOS & VHMS
      // dalam satu unit mengalir berurutan agar halaman tidak setengah kosong.
      unit.sections.forEach(function (sec) {
        var isVhms = sec.source === 'VHMS';
        var breached = sec.breached || [];
        if (!breached.length) return;

        h += '<div class="rp-src-block">';

        sectionNo++;
        // [GROUP ANTI-SPLIT] Judul section + catatan dibungkus grup kecil agar
        // judul TIDAK terpisah dari isi pertamanya saat ganti halaman.
        h += '<div class="rp-sec-group">';
        h += docSectionTitle((sectionNo),
          (isVhms ? 'Parameter VHMS di Atas Threshold' : 'Parameter SOS di Atas Threshold') +
          (sec.component ? ' — ' + sec.component : ''));
        h += '<p class="rp-note">Dinilai dari <strong>data terbaru</strong>' +
          (sec.hmUnit !== null && sec.hmUnit !== undefined ? ' · HM ' + fmtInt(sec.hmUnit) : '') +
          (sec.lastDate ? ' · ' + esc(sec.lastDate) : '') + '.</p>';
        h += '</div>'; // tutup .rp-sec-group (header)
        h += thresholdTableFormal(breached, sec.source);

        // [REVISI] Hipotesis Effect diletakkan di BAWAH tabel Parameter dan
        // DI ATAS blok Summary (Component Life & Event Top Up).
        h += hypothesesHtml(sec);

        // [LAYOUT] Summary Component Life & Summary Event Top Up DIPINDAH ke
        // BAWAH Suggestion Teknis (lihat setelah blok suggestion di bawah).
        var hasLife = sec.lifetime && sec.lifetime.rows && sec.lifetime.rows.length;
        var hasTop = sec.topup && sec.topup.rows && sec.topup.rows.length;

        // Suggestion teknis (rangkuman)
        sectionNo++;
        // [ANTI-HALAMAN-KOSONG] Suggestion + Summary + TTD dibungkus SATU grup
        // agar bila TTD tidak muat di sisa halaman, seluruh grup berpindah
        // bersama ke halaman berikutnya (tidak ada halaman TTD sendirian).
        var isSignSection = (sec === signSection);
        if (isSignSection) h += '<div class="rp-sugg-sign-group">';

        // [GROUP ANTI-SPLIT] Judul Suggestion + tabel rencana dibungkus agar
        // judul tidak terpisah dari tabelnya. `rp-sec-group-sugg` menandai grup
        // BERISI TABEL BESAR (boleh mengalir antar-halaman; tanpa :has()).
        h += '<div class="rp-sec-group rp-sec-group-sugg">';
        h += docSectionTitle(sectionNo, 'Suggestion Teknis — ' +
          (isVhms ? 'VHMS (' + (sec.component || '') + ')' : 'SOS (' + (sec.component || '') + ')'));
        h += suggestionSummaryHtml(sec);
        h += '</div>'; // tutup .rp-sec-group (Suggestion)

        // ---- SUMMARY (Component Life & Event Top Up) — di BAWAH Suggestion ----
        if (hasLife || hasTop) {
          h += '<div class="rp-context' + (hasLife && hasTop ? ' rp-context-2col' : '') + '">';

          // Summary Component Life
          if (hasLife) {
            h += '<div class="rp-context-box">';
            h += '<div class="rp-sublabel">Summary Component Life</div>';
            h += '<table class="rp-table rp-table-sm rp-ctx-table"><thead><tr>' +
              '<th>Komponen</th><th class="center">Cycle Budget</th><th class="center">Total HM</th>' +
              '<th class="center">Umur Terpakai</th><th class="center">Life</th><th class="center">Last Install</th>' +
              '</tr></thead><tbody>';
            sec.lifetime.rows.forEach(function (r) {
              var lifeCls = (typeof r.lifePct === 'number' && r.lifePct >= 100) ? 'rp-critical'
                          : (typeof r.lifePct === 'number' && r.lifePct >= 80) ? 'rp-warning' : 'rp-normal';
              h += '<tr>' +
                '<td>' + esc(r.component) + '</td>' +
                '<td class="center mono">' + (r.cycleBudget !== null ? fmtInt(r.cycleBudget) : '—') + '</td>' +
                '<td class="center mono">' + (r.totalHM !== null && r.totalHM !== undefined ? fmtInt(r.totalHM) : '—') + '</td>' +
                '<td class="center mono">' + (r.ageHours !== null ? fmtInt(r.ageHours) : '—') + '</td>' +
                '<td class="center"><span class="rp-badge ' + lifeCls + '">' + (r.lifePct !== null ? r.lifePct + '%' : '—') + '</span></td>' +
                '<td class="center">' + (r.installDate ? esc(r.installDate.display) : '—') + '</td>' +
                '</tr>';
            });
            h += '</tbody></table></div>';
          }

          // Summary Event Top Up — maksimal 10 baris; total tetap di judul.
          if (hasTop) {
            var TOPUP_LIMIT = 10;
            var topRows = sec.topup.rows;
            var shown = topRows.slice(0, TOPUP_LIMIT);
            h += '<div class="rp-context-box">';
            h += '<div class="rp-sublabel">Summary Event Top Up — total ' +
              (sec.topup.totalQty !== null ? fmt(sec.topup.totalQty, 1) + ' L' : '—') +
              ' dalam ' + sec.topup.count + ' transaksi' +
              '</div>';
            // [LEBAR] tabel Top-Up pakai colgroup agar kolomnya konsisten &
            // sejajar dengan tabel Component Life di sebelah kiri.
            h += '<table class="rp-table rp-table-sm rp-ctx-table rp-topup-table">' +
              '<colgroup><col class="t-date"><col class="t-qty"><col class="t-unit">' +
              '<col class="t-comp"><col class="t-type"></colgroup>' +
              '<thead><tr>' +
              '<th class="center">Tanggal</th><th class="center">Qty</th><th class="center">Satuan</th>' +
              '<th class="center">Kompartemen</th><th class="center">Jenis</th></tr></thead><tbody>';
            shown.forEach(function (r) {
              h += '<tr>' +
                '<td class="center">' + (r.date ? esc(r.date.display) : '—') + '</td>' +
                '<td class="center mono">' + fmt(r.qty, 1) + '</td>' +
                '<td class="center">' + esc(r.unit || 'L') + '</td>' +
                '<td class="center">' + esc(r.component || '') + '</td>' +
                '<td class="center">' + esc(r.type || '') + '</td>' +
                '</tr>';
            });
            h += '</tbody></table></div>';
          }

          h += '</div>';
        }

        // [TTD] Tanda tangan SETELAH Summary (di akhir blok sumber), bila
        // section ini adalah penutup. Summary harus berada di atas TTD.
        if (isSignSection) {
          h += signBlockHtml(isVhms ? 'VHMS' : 'SOS', unit.lambung);
          h += '</div>'; // tutup .rp-sugg-sign-group
        }

        h += '</div>'; // tutup .rp-src-block
      });

      h += '</div>'; // tutup .rp-unit-block
    });

    h += '</div>'; // /rp-doc

    box.innerHTML = h;
  }

  /** Blok tanda tangan per halaman/sumber. */
  function signBlockHtml(srcLabel, lambung) {
    return '<div class="rp-sign">' +
      '<div class="rp-sign-date">' + esc(todayLong()) + '</div>' +
      '<div class="rp-sign-grid">' +
        '<div class="rp-sign-col"><div class="rp-sign-role">Disusun oleh</div><div class="rp-sign-line"></div><div class="rp-sign-name">Reliability Engineer</div></div>' +
        '<div class="rp-sign-col"><div class="rp-sign-role">Diverifikasi oleh</div><div class="rp-sign-line"></div><div class="rp-sign-name">Supervisor Maintenance</div></div>' +
      '</div>' +
      '</div>';
  }

  /* ----------------------------------------------------------------------- */
  global.PORTFOLIO_RENDER = {
    render: render,
    collect: collect,
    setState: setState,
    getState: getState,
    availableUnits: availableUnits,
    buildSosSection: buildSosSection,
    buildVhmsSection: buildVhmsSection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PORTFOLIO_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

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
                    'soot', 'oxidation', 'nitration', 'sulfation', 'pqi', 'additive_na'];

  var TIER_BY_SEV = function (sev) {
    if (sev >= 4) return { label: 'Critical', cls: 'pf-extreme' };
    if (sev >= 2) return { label: 'Caution', cls: 'pf-critical' };
    if (sev >= 1) return { label: 'Monitor', cls: 'pf-warning' };
    return { label: 'Normal', cls: 'pf-normal' };
  };
  // Band SOS (dari config TIER_LABELS): 0 NORMAL,1 MONITOR,2 CRITICAL,3 EXTREME
  var BAND_BY_TIER = ['Normal', 'Monitor', 'Caution', 'Critical'];

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
    if (!store) return { count: 0, totalQty: null, rows: [], byComponent: [], byComponentMap: {} };
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
    // [SPESIFIK PER KOMPARTEMEN 2026-10-01] Rincian per kompartemen agar Qty
    // OBJECTIVE masing-masing (mis. ENGINE vs RADIATOR) — bukan angka akumulatif
    // gabungan yang mencampur oli & radiator.
    var byComponentMap = {};
    arr.forEach(function (r) {
      var comp = String(r.component || '(lain)').trim().toUpperCase() || '(LAIN)';
      if (!byComponentMap[comp]) byComponentMap[comp] = { component: comp, qty: 0, count: 0, lastDate: null, hasQty: false };
      var b = byComponentMap[comp];
      b.count++;
      if (typeof r.qty === 'number') { b.qty += r.qty; b.hasQty = true; }
      if (!b.lastDate && r.date) b.lastDate = r.date;
      if (typeof r.qty === 'number') { total += r.qty; has = true; }
    });
    var byComponent = Object.keys(byComponentMap).map(function (k) {
      var b = byComponentMap[k];
      return { component: b.component, qty: b.hasQty ? Math.round(b.qty * 10) / 10 : null, count: b.count, lastDate: b.lastDate };
    });
    // Urutkan: qty terbesar dulu (paling relevan konsumsi), lalu nama.
    byComponent.sort(function (a, b) {
      var qa = (a.qty === null) ? -1 : a.qty, qb = (b.qty === null) ? -1 : b.qty;
      if (qb !== qa) return qb - qa;
      return String(a.component).localeCompare(String(b.component));
    });
    return {
      count: arr.length,
      totalQty: has ? Math.round(total * 10) / 10 : null,
      lastDate: arr.length && arr[0].date ? arr[0].date : null,
      firstDate: arr.length && arr[arr.length - 1].date ? arr[arr.length - 1].date : null,
      rows: arr,
      byComponent: byComponent
    };
  }
  /**
   * [SPESIFIK PER KOMPARTEMEN 2026-10-01] Ringkas Qty top-up untuk komponen
   * UTAMA (kompartemen asli section, mis. ENGINE) — TANPA mencampur komponen
   * ekstra (mis. RADIATOR). Dipakai agar narasi tindakan "Konsumsi top-up"
   * memakai angka OBJECTIVE kompartemen terkait, bukan total gabungan.
   * @returns {{qty:number|null, count:number, component:string}}
   */
  function topupPrimaryFor(tp, component) {
    var want = String(component || '').trim().toUpperCase();
    if (!tp || !tp.byComponent) return { qty: null, count: 0, component: want || '' };
    for (var i = 0; i < tp.byComponent.length; i++) {
      if (String(tp.byComponent[i].component).toUpperCase() === want) {
        return { qty: tp.byComponent[i].qty, count: tp.byComponent[i].count, component: tp.byComponent[i].component };
      }
    }
    return { qty: null, count: 0, component: want || '' };
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
    4: { key: 'CRITICAL', label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    3: { key: 'CRITICAL', label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    2: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-critical', sla: '1x24 Jam' },
    1: { key: 'MONITOR',  label: 'Monitor',  cls: 'pf-warning',  sla: '2x24 Jam' }
  };
  var STATUS_CFG = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_STATUS) || {
    CRITICAL: { label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    CAUTION:  { label: 'Caution',  cls: 'pf-critical', sla: '1x24 Jam' },
    MONITOR:  { label: 'Monitor',  cls: 'pf-warning',  sla: '2x24 Jam' },
    NORMAL:   { label: 'Normal',   cls: 'pf-normal',   sla: '-' }
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
      if (typeof warnL === 'number' && v <= warnL) return 'CAUTION';
      return 'NORMAL';
    }
    // Mode HIGH: makin BESAR makin buruk.
    if (typeof th.crit === 'number' && v >= th.crit) return 'CRITICAL';
    if (typeof th.warn === 'number' && v >= th.warn) return 'CAUTION';
    return 'NORMAL';
  }

  /** Ambil objek config status (label/cls/sla) dari config yang bisa diubah. */
  function statusMeta(status) {
    var s = STATUS_CFG[status];
    if (s) return s;
    // Fallback bila config tak lengkap. Kunci internal tetap CRITICAL/CAUTION/MONITOR.
    if (status === 'CRITICAL') return { label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' };
    if (status === 'CAUTION')  return { label: 'Caution',  cls: 'pf-critical', sla: '1x24 Jam' };
    if (status === 'MONITOR' || status === 'WARNING') return { label: 'Monitor', cls: 'pf-warning', sla: '2x24 Jam' };
    return { label: 'Normal', cls: 'pf-normal', sla: '-' };
  }
  /**
   * Bangun metadata tindak lanjut untuk satu rekomendasi.
   * [STATUS] Ditentukan dari NILAI vs THRESHOLD (r.value, r.warnTh, r.critTh,
   * r.thMode) -> NORMAL / WARNING / CRITICAL, dengan SLA dari config.
   * @param {object} r rekomendasi (punya value/warnTh/critTh/thMode/param/refs)
   * @returns {object} { label, cls, sla, verify, refs }
   */
  /**
   * Teks VERIFIKASI untuk sebuah parameter (berdasar kelompoknya).
   * Dipakai bersama oleh tabel Parameter (kolom "Verifikasi") dan tabel
   * Suggestion. Mengembalikan narasi cara membuktikan perbaikan berhasil.
   */
  function verifyForParam(paramKey, group) {
    refreshFollowupConfig();
    var verify = VERIFY_BY_GROUP[group || ''] || null;
    if (!verify) {
      var pk = String(paramKey || '');
      if (/^wear_/.test(pk)) verify = VERIFY_BY_GROUP.wear;
      else if (/visc|tbn|oxidation|nitration|sulfation|tan|water|fuel|soot/.test(pk)) verify = VERIFY_BY_GROUP.oil;
      else if (/pqi|iso|clean/.test(pk)) verify = VERIFY_BY_GROUP.clean;
      else if (/^additive_/.test(pk)) verify = VERIFY_BY_GROUP.additive;
      else verify = VERIFY_BY_GROUP.vhms;
    }
    return verify;
  }

  function followUpMeta(r) {
    refreshFollowupConfig();   // ikuti perubahan Pengaturan tanpa reload
    // Flag historis (temuan yang sudah normal kini) -> status mengikuti record.
    var st = statusFromValue(r.value, { warn: r.warnTh, crit: r.critTh, mode: r.thMode });
    var p = statusMeta(st);
    // Verifikasi: pakai konteks grup bila ada di KB
    var group = r.group || '';
    var verify = verifyForParam(r.param, group);
    // Rujukan: pakai refs dari KB bila ada; default SOP hanya sebagai FALLBACK
    // (agar tidak muncul duplikat "SOP Condition Monitoring" di setiap baris).
    var refs = (r.refs || []).slice();
    if (!refs.length) refs.push(REF_DEFAULT);
    // dedup, jaga urutan
    var seen = {}, uniq = [];
    refs.forEach(function (x) { var k = String(x).trim(); if (k && !seen[k]) { seen[k] = 1; uniq.push(k); } });
    // [REVISI 2026-09-30] Kedalaman rekomendasi diturunkan dari STATUS (badge)
    // yang sama agar SELALU konsisten (badge & depth tak boleh berbeda):
    //   CRITICAL -> Inspeksi mendalam (deep-dive)
    //   CAUTION  -> Inspeksi terarah (setel/adjust)
    //   MONITOR  -> Inspeksi ringan (pantau/inspeksi visual)
    var depth, depthLabel, risk;
    if (st === 'CRITICAL') {
      depth = 'berat'; depthLabel = 'Inspeksi mendalam';
      risk = 'RISIKO TINGGI: bila dibiarkan berpotensi kerusakan komponen mayor, downtime tak terencana, dan biaya perbaikan besar.';
    } else if (st === 'CAUTION') {
      depth = 'sedang'; depthLabel = 'Inspeksi terarah';
      risk = 'RISIKO MENENGAH: berpotensi berkembang menjadi kerusakan signifikan bila tidak ditindaklanjuti; biaya meningkat seiring waktu.';
    } else {
      depth = 'ringan'; depthLabel = 'Inspeksi ringan';
      risk = 'RISIKO RENDAH: masih dalam batas pantau; tindak lanjut terjadwal pada interval sampling berikutnya.';
    }
    // [RISIKO] Pakai estimasi dari KB bila ada (lebih spesifik), else fallback.
    if (r.risk) risk = r.risk;
    // [DAMPAK SPESIFIK 2026-09-30] Part/komponen konkret yang berisiko rusak.
    // Diambil dari r.impact (KB sadar-kompartemen); fallback ke `risk` (level).
    var impact = r.impact || null;
    return { label: p.label, cls: p.cls, sla: p.sla, verify: verify, refs: uniq,
             depth: depth, depthLabel: depthLabel, risk: risk, impact: impact };
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
      // [DAMPAK OPERASIONAL VHMS 2026-10-01] VHMS = telemetri -> dampak berupa
      // konsekuensi operasi & kesehatan alat (performa, produktivitas, downtime,
      // keselamatan), BUKAN daftar part. `impact` sudah diisi vhms-knowledge;
      // fallback netral bila parameter belum punya entri.
      r.impact = r.impact || 'Penurunan performa & kesehatan alat; berpotensi menambah downtime serta biaya operasi bila dibiarkan.';
      // [PROYEKSI TREN VHMS] Pakai RUL (estimasi jam ke critical) dari analytics;
      // konversi ke format { projection } agar tabel proyeksi memakainya juga.
      if (anomaly.rul) {
        var rh = anomaly.rul.hours;
        var hasH = (typeof rh === 'number') && isFinite(rh);
        var dirV = (anomaly.slope === null || anomaly.slope === undefined) ? 'datar'
                 : (anomaly.slope > 0 ? 'naik' : 'turun');
        r.projection = {
          slopePer100: (anomaly.slope !== null && anomaly.slope !== undefined) ? Math.round(anomaly.slope * 100 * 100) / 100 : null,
          hoursToCrit: hasH ? Math.round(rh) : (anomaly.rul.alreadyCritical ? 0 : null),
          daysToCrit: hasH ? Math.round(rh / 24) : (anomaly.rul.alreadyCritical ? 0 : null),
          direction: dirV,
          atCrit: !!anomaly.rul.alreadyCritical,
          lastValue: anomaly.value,
          critTh: anomaly.crit
        };
      }
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
    // [BARU 2026-10-01] Threshold mengikuti MODEL unit bila ada override
    // (mis. ENGINE HD785 berbeda dari PC2000). Tanpa model -> perilaku lama.
    var th = cfg.getThresholdsFor(unit.component, unit.model);
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

  /* -----------------------------------------------------------------------
   * [PROYEKSI TREN 2026-09-30] Estimasi kapan sebuah parameter mencapai
   * ambang critical, berdasar laju perubahan (slope) terhadap HM/meter.
   *
   * Metode: regresi linier sederhana nilai vs HM pada N sampel terakhir.
   *   slope = Δnilai / ΔHM  (per jam)
   *   sisa jam ke critical = (thresholdCrit - nilaiSekarang) / slope   (mode high)
   *                          (nilaiSekarang - thresholdCrit) / |slope|  (mode low)
   *
   * @param {array}  samples  sampel unit (punya _hm/_date)
   * @param {string} paramKey
   * @param {object} th       threshold ({warn,crit,extreme} atau {warn_low,crit_low})
   * @returns {object|null} { slopePer100, hoursToCrit, daysToCrit, direction, atCrit }
   * --------------------------------------------------------------------- */
  function projectTrend(samples, paramKey, th) {
    if (!samples || samples.length < 3 || !th) return null;
    // Ambil titik valid (nilai & HM) — urut kronologis.
    var pts = samples
      .filter(function (s) { return s[paramKey] !== null && s[paramKey] !== undefined && s._hm; })
      .map(function (s) { return { hm: Number(s._hm), v: Number(s[paramKey]) }; })
      .sort(function (a, b) { return a.hm - b.hm; });
    if (pts.length < 3) return null;

    // Regresi linier v = a + b*hm
    var n = pts.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    pts.forEach(function (p) { sx += p.hm; sy += p.v; sxy += p.hm * p.v; sxx += p.hm * p.hm; });
    var denom = (n * sxx - sx * sx);
    if (Math.abs(denom) < 1e-9) return null;
    var slope = (n * sxy - sx * sy) / denom;          // per jam HM
    var last = pts[pts.length - 1];

    var isLow = (th.warn_low !== undefined) || (th.mode === 'low');
    var critTh = isLow
      ? (th.crit_low !== undefined ? th.crit_low : th.crit)
      : (th.crit !== undefined ? th.crit : th.crit_high);
    if (critTh === null || critTh === undefined) return null;

    var slopePer100 = slope * 100;
    var hoursToCrit = null;
    if (Math.abs(slope) > 1e-9) {
      if (isLow) {
        // Nilai menurun menuju critical (low). Memburuk bila slope < 0.
        if (slope < 0 && last.v > critTh) hoursToCrit = (last.v - critTh) / (-slope);
        else if (last.v <= critTh) hoursToCrit = 0;
      } else {
        // Nilai meningkat menuju critical (high). Memburuk bila slope > 0.
        if (slope > 0 && last.v < critTh) hoursToCrit = (critTh - last.v) / slope;
        else if (last.v >= critTh) hoursToCrit = 0;
      }
    }
    if (hoursToCrit !== null && !isFinite(hoursToCrit)) hoursToCrit = null;
    var daysToCrit = (hoursToCrit !== null && hoursToCrit > 0) ? hoursToCrit / 24 : (hoursToCrit === 0 ? 0 : null);

    var direction = Math.abs(slope) < 1e-9 ? 'datar' : (slope > 0 ? 'naik' : 'turun');
    return {
      slopePer100: Math.round(slopePer100 * 100) / 100,
      hoursToCrit: (hoursToCrit === null ? null : Math.round(hoursToCrit)),
      daysToCrit: (daysToCrit === null ? null : Math.round(daysToCrit)),
      direction: direction,
      atCrit: hoursToCrit === 0,
      lastValue: last.v,
      lastHm: last.hm,
      critTh: critTh
    };
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
        label: b.label, value: b.value, unit: b.unit,
        // [KOMPARTEMEN-SADAR] Sertakan kompartemen agar narasi tidak memakai
        // perspektif mesin pada kompartemen lain (mis. TRANSMISSION/HYDRAULIC).
        component: unit.component
      });
      // [STATUS DARI NILAI] Simpan nilai & ambang agar status (NORMAL/WARNING/
      // CRITICAL) + SLA dihitung dari perbandingan nilai vs threshold.
      rec.value = b.value;
      rec.warnTh = b.warn;
      rec.critTh = b.crit;
      rec.thMode = (b.crit !== undefined && b.warn !== undefined && b.crit < b.warn) ? 'low' : 'high';
      // [PROYEKSI TREN] Estimasi waktu ke ambang critical per parameter.
      var thFull = cfg.getThresholdsFor(unit.component, unit.model)[b.key] || {};
      rec.projection = projectTrend(unit.samples, b.key, thFull);
      return rec;
    });
    var _tpPrimary = topupPrimaryFor(tp, unit.component);
    var rules = global.SOS_KNOWLEDGE.ruleBased([{
      component: unit.component,
      lifePct: lt.lifePct,
      remainingHours: lt.remainingHours,
      cycleBudget: lt.cycleBudget,
      // [SPESIFIK PER KOMPARTEMEN] Narasi "Konsumsi top-up" pakai Qty kompartemen
      // SECTION (mis. ENGINE) — bukan total gabungan (ENGINE + RADIATOR).
      topupQty: (_tpPrimary.qty !== null ? _tpPrimary.qty : tp.totalQty),
      topupCount: (_tpPrimary.count || tp.count),
      // Rincian per kompartemen (ENGINE, RADIATOR, ...) agar tindakan objective.
      topupByComponent: tp.byComponent || []
    }]);

    return {
      source: 'SOS',
      unitId: unit.assetId,
      component: unit.component,
      model: unit.model,
      serial: unit.serial,
      lambung: lambung,
      // Kunci internal band (NORMAL/MONITOR/CRITICAL/EXTREME) — dipakai utk
      // perbandingan 'terburuk'; label tampilan diambil dari BAND_BY_TIER saat render.
      band: (global.SOS_CONFIG && SOS_CONFIG.TIER_KEYS && SOS_CONFIG.TIER_KEYS[tier]) || 'NORMAL',
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
    var _tpPrimaryV = topupPrimaryFor(tp, vhmsComp);
    var rules = global.SOS_KNOWLEDGE.ruleBased([{
      component: 'ENGINE',  // VHMS tidak per-kompartemen; konteks utama pilar ENGINE
      lifePct: lt.lifePct, remainingHours: lt.remainingHours, cycleBudget: lt.cycleBudget,
      // [SPESIFIK PER KOMPARTEMEN] Qty OBJECTIVE kompartemen ENGINE (bukan gabungan).
      topupQty: (_tpPrimaryV.qty !== null ? _tpPrimaryV.qty : tp.totalQty),
      topupCount: (_tpPrimaryV.count || tp.count),
      topupByComponent: tp.byComponent || []
    }]);
    // Band section VHMS: mengikuti temuan TERBURUK (aktif ATAU historis).
    var hasCrit = breached.some(function (b) { return b.severity >= 2; });
    var band = hasCrit ? 'CRITICAL' : 'CAUTION';
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

    // Hitung band unit = yang terburuk di antara sections.
    // Kunci internal band: NORMAL < MONITOR < CAUTION < CRITICAL (alias WARNING=CAUTION).
    var order = { EXTREME: 4, CRITICAL: 4, CAUTION: 3, WARNING: 3, MONITOR: 2, NORMAL: 0 };
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

  /**
   * [FIX 2026-10-01] Saring daftar unit hasil `collect()` berdasarkan
   * SECTION (via PORTFOLIO_STORE.getSection) dan MODEL unit.
   * @param {array}  units
   * @param {string} section  nama section ('' = semua)
   * @param {string} model    nama model   ('' = semua)
   * @returns {array}
   */
  function filterUnits(units, section, model) {
    var store = global.PORTFOLIO_STORE;
    return units.filter(function (u) {
      if (section) {
        var sec = (store && store.getSection) ? store.getSection(u.lambung) : '';
        if (sec !== section) return false;
      }
      if (model && String(u.model || '') !== model) return false;
      return true;
    });
  }

  /**
   * [FITUR 2026-10-01] Daftar KOMPARTEMEN (SOS/VHMS) yang tersedia untuk
   * keperluan dropdown "Kompartemen" (print out partial).
   *
   * - Bila `onlyLambung` diisi -> kompartemen unit itu saja.
   * - Bila kosong -> gabungan kompartemen dari SEMUA unit (yang punya temuan),
   *   difilter opsional oleh section & model (konsisten dgn dropdown lain).
   *
   * @param {string} [onlyLambung]
   * @param {string} [section]
   * @param {string} [model]
   * @returns {array} daftar nama kompartemen unik (terurut, sudah dibersihkan).
   */
  function availableCompartments(onlyLambung, section, model) {
    var units;
    if (onlyLambung) {
      units = collect(onlyLambung);
    } else {
      units = filterUnits(collect(), section, model);
    }
    var seen = {};
    units.forEach(function (u) {
      (u.sections || []).forEach(function (s) {
        if (s.component) seen[s.component] = true;
      });
    });
    return Object.keys(seen).sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }

  /**
   * [FITUR 2026-10-01] Saring `unit.sections` sesuai KOMPARTEMEN terpilih.
   * Mengembalikan unit baru (copy) dengan sections yang cocok saja — dipakai
   * untuk mencetak sebagian kompartemen (mis. hanya ENGINE).
   * @param {array}  units
   * @param {string} compartment  '' = semua
   * @returns {array}
   */
  function filterByCompartment(units, compartment) {
    if (!compartment) return units;
    return units.map(function (u) {
      var secs = (u.sections || []).filter(function (s) {
        return String(s.component || '') === compartment;
      });
      if (!secs.length) return null;
      var copy = {};
      Object.keys(u).forEach(function (k) { copy[k] = u[k]; });
      copy.sections = secs;
      return copy;
    }).filter(Boolean);
  }

  /* -----------------------------------------------------------------------
   * Render HTML
   * --------------------------------------------------------------------- */

  /* -----------------------------------------------------------------------
   * [MERGE SEL VERTIKAL 2026-10-01] Gabungkan baris berurutan yang memiliki
   * KONTEN SEL IDENTIK menjadi satu sel dengan `rowspan`.
   * ---------------------------------------------------------------------
   * Tujuan: bila beberapa parameter punya narasi kolom yang sama (mis. sama-
   * sama "RISIKO RENDAH ..." atau aksi/penyebab identik), jangan diulang-ulang;
   * cukup satu sel yang membentang vertikal (rapi & ringkas).
   *
   * @param {array}    items  daftar baris (recs)
   * @param {array}    metas  metas[i] = followUpMeta(items[i])
   * @param {function} sigFn  sigFn(item, meta) -> string tanda tangan konten
   * @returns {array}  spans  spans[i] = { first:boolean, count:number }
   *                          (count>0 berarti baris pertama grup dgn rowspan)
   * ---------------------------------------------------------------------
   * Merge HANYA untuk konten identik & kolom SAFE-MERGE: Dampak/Risiko,
   * Aksi, Penyebab, Target/SLA, Status. Kolom Parameter/Event TIDAK di-merge
   * (identitas tiap baris wajib tetap tampil).
   */
  function computeRowSpans(items, metas, sigFn) {
    var spans = [];
    var i = 0;
    while (i < items.length) {
      var sig = sigFn(items[i], metas[i]);
      // Hanya merge bila konten BERMAKNA (bukan '—'/kosong).
      var meaningful = sig && sig !== '—' && sig !== '';
      var j = i + 1;
      if (meaningful) {
        while (j < items.length && sigFn(items[j], metas[j]) === sig) j++;
      }
      for (var k = i; k < j; k++) spans[k] = { first: k === i, count: k === i ? (j - i) : 1 };
      i = j;
    }
    return spans;
  }

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
      // [LABEL KOLOM DINAMIS 2026-10-01] SOS -> "Dampak (Part)" (komponen
      // konkret). VHMS -> "Dampak Operasional" (kesehatan alat & performa,
      // bukan daftar part). Sumber dari sec.source.
      var isVhmsSec = String(sec.source || '').toUpperCase() === 'VHMS';
      var impactColLabel = isVhmsSec ? 'Dampak Operasional' : 'Dampak (Part)';
      h += '<table class="pf-table pf-table-sm pf-sugg-table pf-sugg-plan">' +
        '<colgroup>' +
          '<col class="p-prio">' +
          '<col class="p-param">' +
          '<col class="p-act">' +
          '<col class="p-cause">' +
          '<col class="p-impact">' +
          '<col class="p-risk">' +
          '<col class="p-sla">' +
        '</colgroup>' +
        '<thead><tr>' +
        '<th class="center">Status</th><th>Parameter / Event</th><th>Aksi (What &amp; How)</th>' +
        '<th>Penyebab (Why)</th><th>' + esc(impactColLabel) + '</th><th>Tingkat Risiko</th><th class="center">Target</th>' +
        '</tr></thead><tbody>';

      // [MERGE SEL VERTIKAL 2026-10-01] Hitung spans SEBELUM render, agar
      // baris berurutan dgn konten kolom identik digabung (rowspan) -> tidak
      // ada narasi berulang.
      // KEPUTUSAN USER: narasi TINGKAT RISIKO (mis. "RISIKO MENENGAH: ...")
      // cukup tampil 1x bila sama; PART (Dampak) tetap per-baris. Kolom Aksi
      // & Penyebab TIDAK di-merge (spesifik per parameter).
      var metas = recs.map(function (r) { return followUpMeta(r); });
      var sigPrio = function (r, m) { return m.cls + '|' + m.label + '|' + m.depthLabel; };
      var sigRisk = function (r, m) { return (m.risk || '—'); };
      var sigSla = function (r, m) { return m.sla || '—'; };
      var spanPrio = computeRowSpans(recs, metas, sigPrio);
      var spanRisk = computeRowSpans(recs, metas, sigRisk);
      var spanSla = computeRowSpans(recs, metas, sigSla);

      recs.forEach(function (r, i) {
        var meta = metas[i];
        var name = r.title || r.label || r.param || '';
        var actions = (r.actions || []).slice(0, 3);
        var causes = (r.likely || []).slice(0, 3);
        // Hanya tulis atribut rowspan bila >1 (bersihkan rowspan="1" yg tak perlu).
        var rs = function (s) { return s.count > 1 ? ' rowspan="' + s.count + '"' : ''; };
        h += '<tr>' +
          // Status — merge bila badge & depth identik.
          (spanPrio[i].first
            ? '<td class="center pf-prio-cell"' + rs(spanPrio[i]) + '><span class="pf-badge ' + meta.cls + '">' + esc(meta.label) + '</span>' +
              '<div class="pf-depth">' + esc(meta.depthLabel) + '</div></td>'
            : '') +
          '<td class="pf-param-cell"><strong>' + esc(name) + '</strong>' +
            (r.title && r.label && r.label !== r.title ? '<span class="pf-unit"> ' + esc(r.label) + '</span>' : '') +
          '</td>' +
          // Aksi — TIDAK di-merge (spesifik per parameter).
          '<td class="pf-sugg-act">' + (actions.length
              ? '<ol class="pf-plan-list">' + actions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ol>'
              : '—') + '</td>' +
          // Penyebab — TIDAK di-merge (spesifik per parameter).
          '<td class="pf-sugg-cause">' + (causes.length
              ? '<ul class="pf-plan-list">' + causes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>'
              : '—') + '</td>' +
          // Dampak — SELALU per-baris.
          // SOS = part konkret (ikon peringatan); VHMS = dampak operasional
          // (ikon gauge/kesehatan alat). Kelas khusus agar styling tepat.
          '<td class="pf-sugg-impact ' + (isVhmsSec ? 'pf-impact-op' : 'pf-impact-part-cell') + ' pf-risk-' + esc(meta.depth) + '">' +
            (meta.impact
              ? (isVhmsSec
                  ? '<div class="pf-impact-op-txt"><i class="fa-solid fa-gauge-high"></i> ' + esc(meta.impact) + '</div>'
                  : '<div class="pf-impact-part"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(meta.impact) + '</div>')
              : '—') +
          '</td>' +
          // Tingkat Risiko — MERGE bila narasi level identik (1x saja).
          (spanRisk[i].first
            ? '<td class="pf-sugg-risk pf-risk-' + esc(meta.depth) + '"' + rs(spanRisk[i]) + '>' +
                '<div class="pf-impact-level">' + esc(meta.risk || '—') + '</div>' +
              '</td>'
            : '') +
          // Target/SLA — merge bila identik.
          (spanSla[i].first
            ? '<td class="center pf-sla-cell"' + rs(spanSla[i]) + '><span class="pf-plan-sla">' + esc(meta.sla) + '</span></td>'
            : '') +
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
    // [DUAL LAYOUT RATA 2026-10-01] Untuk daftar panjang, render sebagai SATU
    // grid 2 kolom (item langsung sebagai anak grid) agar baris kiri & kanan
    // SELALU rata/sejajar — bila jumlah GENAP, kedua sisi simetris. Menghindari
    // ketidakseimbangan dua <ul> terpisah & masalah pecah antar-halaman.
    var allActions = ruleList.concat(actionOrder);
    if (allActions.length) {
      var actN = allActions.length;
      var useTwoCol = actN >= 6;
      var actShort = actN <= 6 ? ' pf-sugg-short' : '';
      h += '<div class="pf-sugg-block' + actShort + '"><div class="pf-rec-sub"><i class="fa-solid fa-screwdriver-wrench"></i> ' +
        'Tindakan gabungan (' + actN + '):</div>';
      function actionItem(x, isRule) {
        var text = x;
        var comps = actionMap[text] ? Object.keys(actionMap[text]) : [];
        return '<div class="pf-sugg-grid-item' + (isRule ? ' pf-sugg-rule' : '') + '">' + esc(text) +
          (comps.length ? ' <span class="rp-comp-tag">[' + esc(comps.join(', ')) + ']</span>' : '') + '</div>';
      }
      if (useTwoCol) {
        h += '<div class="pf-dual-grid pf-dual-actions">';
        allActions.forEach(function (x) { h += actionItem(x, ruleList.indexOf(x) !== -1); });
        h += '</div>';
      } else {
        h += '<ul class="pf-sugg-list">';
        allActions.forEach(function (x) { h += actionLi(x, ruleList.indexOf(x) !== -1); });
        h += '</ul>';
      }
      h += '</div>';
    }

    // ---- 2b) [PROYEKSI TREN 2026-09-30] Summary note proyeksi tren ----
    // Menampilkan estimasi waktu menuju ambang critical per parameter yang
    // punya cukup data (>=3 sampel). Diletakkan tepat di bawah tindakan
    // gabungan; tanda tangan menyusul setelahnya.
    var projRows = [];
    recs.forEach(function (r) {
      if (!r.projection) return;
      var pj = r.projection;
      var nm = r.title || r.label || r.param || '';
      var eta;
      if (pj.atCrit) eta = 'sudah pada/melampaui ambang critical';
      else if (pj.hoursToCrit === null) eta = (pj.direction === 'naik' || pj.direction === 'turun')
        ? 'cenderung menjauh dari critical pada laju saat ini'
        : 'tren datar — tidak mendekati critical';
      else eta = '± ' + fmtInt(pj.hoursToCrit) + ' jam (~' + fmtInt(pj.daysToCrit) + ' hari) menuju critical';
      projRows.push({
        name: nm,
        slope: pj.slopePer100,
        dir: pj.direction,
        eta: eta,
        hours: pj.hoursToCrit,
        atCrit: pj.atCrit
      });
    });
    if (projRows.length) {
      // Urutkan: yang paling cepat mencapai critical di atas.
      projRows.sort(function (a, b) {
        var ha = (a.hours === null) ? Infinity : a.hours;
        var hb = (b.hours === null) ? Infinity : b.hours;
        return ha - hb;
      });
      h += '<div class="pf-sugg-block pf-projection">' +
        '<div class="pf-rec-sub"><i class="fa-solid fa-chart-line"></i> Proyeksi Tren — estimasi waktu menuju ambang Critical</div>' +
        '<p class="pf-proj-note">Perkiraan berbasis laju perubahan (regresi linier) nilai terhadap HM pada sampel terakhir. ' +
        'Bersifat indikatif — konfirmasi dengan tren ROW & inspeksi fisik.</p>' +
        '<table class="pf-table pf-table-sm pf-proj-table"><thead><tr>' +
        '<th>Parameter</th><th class="center">Laju /100 jam</th><th class="center">Arah</th><th>Estimasi</th>' +
        '</tr></thead><tbody>';
      projRows.forEach(function (p) {
        var dirIcon = p.dir === 'naik' ? '▲' : (p.dir === 'turun' ? '▼' : '■');
        var cls = p.atCrit ? 'pf-proj-crit' : (p.hours !== null && p.hours <= 500 ? 'pf-proj-warn' : '');
        h += '<tr class="' + cls + '">' +
          '<td>' + esc(p.name) + '</td>' +
          '<td class="center mono">' + (p.slope > 0 ? '+' : '') + fmt(p.slope, 2) + '</td>' +
          '<td class="center">' + dirIcon + ' ' + esc(p.dir) + '</td>' +
          '<td>' + esc(p.eta) + '</td>' +
          '</tr>';
      });
      h += '</tbody></table></div>';
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
      'Hipotesis Effect (' + causeOrder.length + '):</div>';
    // [DUAL LAYOUT RATA 2026-10-01] Bila >=2 item, render sebagai SATU grid
    // 2 kolom (item langsung sebagai anak grid, mengalir per-BARIS). Dengan
    // begitu baris kiri & kanan SELALU sejajar (rata), tidak seperti dua <ul>
    // terpisah yang tingginya bisa berbeda. Bila genap -> kiri & kanan simetris.
    function causeItem(x) {
      var comps = Object.keys(causeMap[x]);
      return '<div class="pf-sugg-grid-item">' + esc(x) + (comps.length ? ' <span class="rp-comp-tag">[' + esc(comps.join(', ')) + ']</span>' : '') + '</div>';
    }
    if (causeOrder.length >= 2) {
      h += '<div class="pf-dual-grid pf-dual-causes">';
      causeOrder.forEach(function (x) { h += causeItem(x); });
      h += '</div>';
    } else {
      h += '<ul class="pf-sugg-list pf-sugg-causes' + causeShort + '">';
      h += '<li>' + esc(causeOrder[0]) + '</li>';
      h += '</ul>';
    }
    h += '</div>';
    return h;
  }

  /* -----------------------------------------------------------------------
   * Entry render
   * --------------------------------------------------------------------- */
  // [FIX 2026-10-01] Tambah `section` & `model` agar filter Section/Model di
  // dropdown BENAR-BENAR mempengaruhi isi laporan (sebelumnya hanya unitLambung
  // yang dipakai, sehingga Section/Model tidak menyaring hasil render).
  // [FITUR 2026-10-01] Tambah `compartment` — cetak/seleksi SEBAGIAN kompartemen
  // saja (mis. hanya ENGINE) untuk mempercepat pencarian & print out partial.
  var portfolioState = { mode: 'fleet', unitLambung: '', section: '', model: '', compartment: '' };

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

  /**
   * [FITUR 2026-10-01] Daftar unit yang PUNYA TEMUAN (parameter di atas
   * threshold) saja — dipakai untuk mengisi dropdown Model & Nomor Lambung di
   * mode Per Unit. Unit yang NORMAL tidak ditampilkan agar pencarian lebih cepat.
   *
   * Diturunkan dari `collect()` karena `collect()` memang hanya mengembalikan
   * unit yang memiliki section dengan breach (buildSosSection/buildVhmsSection
   * mengembalikan null bila tak ada temuan).
   *
   * @returns {array} [{ lambung, model }]
   */
  function availableUnitsWithFindings() {
    return collect().map(function (u) {
      return { lambung: u.lambung, model: u.model || '' };
    }).sort(function (a, b) { return String(a.lambung).localeCompare(String(b.lambung)); });
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
    // [LAYOUT] Lebar kolom dikunci via colgroup + table-layout:fixed.
    // [REVISI 2026-09-30] Kolom terakhir = "Verifikasi" (narasi verifikasi),
    // menggantikan "Tindakan Utama" agar penjelasan cara membuktikan perbaikan
    // ada di tabel Parameter, dan tabel Suggestion bisa lebih lebar.
    var h = '<table class="rp-table rp-table-params">' +
      '<colgroup>' +
        '<col class="c-no">' +
        '<col class="c-param">' +
        '<col class="c-val">' +
        '<col class="c-warn">' +
        '<col class="c-crit">' +
        '<col class="c-status">' +
        '<col class="c-verify">' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th class="rp-no">No</th>' +
      '<th>' + (isVhms ? 'Parameter / Event VHMS' : 'Parameter SOS') + '</th>' +
      '<th class="center">Nilai</th>' +
      '<th class="center">Ambang Warning</th>' +
      '<th class="center">Ambang Critical</th>' +
      '<th class="center">Status</th>' +
      '<th class="rp-verify">Verifikasi</th>' +
      '</tr></thead><tbody>';
    var n = 0;
    breached.forEach(function (b) {
      n++;
      var isHist = b.current === false;
      var name = (isVhms && b.title) ? b.title : b.label;
      var sub = (isVhms && b.title && b.label && b.label !== b.title) ? b.label : '';
      var status = isHist ? (b.status + ' <span class="rp-muted">(kini normal)</span>') : b.status;
      // Verifikasi: narasi cara membuktikan perbaikan berhasil (per kelompok param).
      var verify = verifyForParam(b.key || b.param, b.group) || '—';
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
        '<td class="rp-verify">' + esc(verify) + '</td>' +
        '</tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  /** Blok heading bernomor untuk bagian dokumen. */
  function docSectionTitle(no, text) {
    return '<div class="rp-sec"><span class="rp-sec-no">' + no + '</span>' + esc(text) + '</div>';
  }

  /**
   * [MERGE SUMMARY 2026-10-01] Blok "Summary Component Life" + "Summary Event
   * Top Up" untuk SATU section. Dipakai SEKALI saja per unit (lihat render()),
   * diletakkan di bawah Proyeksi Tren VHMS agar tidak dobel saat SOS & VHMS
   * dua-duanya di atas threshold.
   * @param {object} sec  section sumber data (lifetime/topup)
   * @returns {string} HTML ('' bila tidak ada data)
   */
  function summaryContextHtml(sec) {
    if (!sec) return '';
    var hasLife = sec.lifetime && sec.lifetime.rows && sec.lifetime.rows.length;
    var hasTop = sec.topup && sec.topup.rows && sec.topup.rows.length;
    if (!hasLife && !hasTop) return '';
    var h = '';
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

    // Summary Event Top Up — maksimal 10 baris.
    // [SPESIFIK PER KOMPARTEMEN 2026-10-01] Judul menampilkan Qty OBJECTIVE
    // per kompartemen (mis. ENGINE 320 L · RADIATOR 559 L), BUKAN total
    // gabungan yang mencampur oli mesin & radiator.
    if (hasTop) {
      var TOPUP_LIMIT = 10;
      var topRows = sec.topup.rows;
      var shown = topRows.slice(0, TOPUP_LIMIT);
      h += '<div class="rp-context-box">';
      var byComp = sec.topup.byComponent || [];
      var qtyParts = byComp.filter(function (b) { return b.qty !== null; })
        .map(function (b) { return esc(b.component) + ' ' + fmt(b.qty, 1) + ' L'; });
      var titleQty = qtyParts.length ? (' — ' + qtyParts.join(' · '))
                   : (sec.topup.totalQty !== null ? ' — ' + fmt(sec.topup.totalQty, 1) + ' L' : ' —');
      h += '<div class="rp-sublabel">Summary Event Top Up' + titleQty +
        ' <span class="rp-topup-meta">(' + sec.topup.count + ' transaksi)</span>' +
        '</div>';
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
    return h;
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
    } else if (portfolioState.mode === 'unit' && (portfolioState.section || portfolioState.model)) {
      // [FIX 2026-10-01] Bila unit belum dipilih tetapi Section/Model sudah
      // dipilih, tampilkan SEMUA unit yang cocok dengan filter tsb.
      units = filterUnits(collect(), portfolioState.section, portfolioState.model);
    } else {
      units = collect();
    }

    // [FITUR 2026-10-01] Filter KOMPARTEMEN (print out partial). Berlaku di
    // mode Per Unit maupun saat kompartemen dipilih dari daftar armada.
    if (portfolioState.compartment) {
      units = filterByCompartment(units, portfolioState.compartment);
    }

    if (!units.length) {
      // [FIX 2026-10-01] Bedakan pesan:
      //  (a) Unit SPESIFIK dipilih & ada di data tetapi TIDAK punya temuan
      //      -> "tidak memiliki parameter di atas threshold".
      //  (b) Filter Section/Model/Kompartemen tidak menghasilkan unit apa pun.
      //  (c) Tidak ada filter -> memang tak ada parameter di atas threshold.
      var unitSelected = portfolioState.mode === 'unit' && !!portfolioState.unitLambung;
      var filterActive = portfolioState.mode === 'unit' &&
        (portfolioState.unitLambung || portfolioState.section || portfolioState.model);
      if (unitSelected) {
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
          'Unit <strong>' + esc(portfolioState.unitLambung) + '</strong>' +
          (portfolioState.compartment ? ' kompartemen <strong>' + esc(portfolioState.compartment) + '</strong>' : '') +
          ' tidak memiliki parameter yang melewati threshold pada data terbaru.</div>';
      } else if (filterActive || portfolioState.compartment) {
        var parts = [];
        if (portfolioState.section) parts.push('Section = ' + esc(portfolioState.section));
        if (portfolioState.model) parts.push('Model = ' + esc(portfolioState.model));
        if (portfolioState.compartment) parts.push('Kompartemen = ' + esc(portfolioState.compartment));
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-filter-circle-xmark"></i> ' +
          'Tidak ada unit yang cocok dengan filter (' + parts.join(', ') + ').</div>';
      } else {
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
          'Tidak ada parameter yang melewati threshold pada data terbaru.</div>';
      }
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

      // [MERGE SUMMARY 2026-10-01] Tentukan section SUMBER untuk blok Summary
      // (Component Life & Top Up) — tampil SEKALI per unit, di bawah Proyeksi
      // Tren. Prioritas: VHMS (telemetri mesin / konteks ENGINE), lalu SOS.
      // Section dianggap punya data bila lifetime atau topup berisi baris.
      function hasSummaryData(s) { return !!(s && ((s.lifetime && s.lifetime.rows && s.lifetime.rows.length) || (s.topup && s.topup.rows && s.topup.rows.length))); }
      var summarySection = null;
      // VHMS dahulu
      for (var _si = 0; _si < unit.sections.length; _si++) {
        if (unit.sections[_si].source === 'VHMS' && hasSummaryData(unit.sections[_si])) { summarySection = unit.sections[_si]; break; }
      }
      // lalu SOS bila belum ada
      if (!summarySection) {
        for (var _sj = 0; _sj < unit.sections.length; _sj++) {
          if (unit.sections[_sj].source === 'SOS' && hasSummaryData(unit.sections[_sj])) { summarySection = unit.sections[_sj]; break; }
        }
      }
      // fallback: section apa pun yang punya data summary
      if (!summarySection) {
        for (var _sk = 0; _sk < unit.sections.length; _sk++) {
          if (hasSummaryData(unit.sections[_sk])) { summarySection = unit.sections[_sk]; break; }
        }
      }
      var summaryAfterVhms = !!summarySection;

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

        // [MERGE SUMMARY 2026-10-01] Summary (Component Life & Top Up) TIDAK
        // lagi dirender per-section di sini — dipindah ke BAWAH Proyeksi Tren
        // VHMS dan hanya SEKALI per unit (lihat setelah loop sections).
        var hasLife = sec.lifetime && sec.lifetime.rows && sec.lifetime.rows.length;
        var hasTop = sec.topup && sec.topup.rows && sec.topup.rows.length;

        // Suggestion teknis (rangkuman)
        sectionNo++;
        // [ANTI-HALAMAN-KOSONG] Suggestion + TTD dibungkus SATU grup agar bila
        // TTD tidak muat di sisa halaman, seluruh grup berpindah bersama ke
        // halaman berikutnya (tidak ada halaman TTD sendirian).
        var isSignSection = (sec === signSection && !summaryAfterVhms);
        if (isSignSection) h += '<div class="rp-sugg-sign-group">';

        // [GROUP ANTI-SPLIT] Judul Suggestion + tabel rencana dibungkus agar
        // judul tidak terpisah dari tabelnya. `rp-sec-group-sugg` menandai grup
        // BERISI TABEL BESAR (boleh mengalir antar-halaman; tanpa :has()).
        h += '<div class="rp-sec-group rp-sec-group-sugg">';
        h += docSectionTitle(sectionNo, 'Suggestion Teknis — ' +
          (isVhms ? 'VHMS (' + (sec.component || '') + ')' : 'SOS (' + (sec.component || '') + ')'));
        h += suggestionSummaryHtml(sec);
        h += '</div>'; // tutup .rp-sec-group (Suggestion)

        // [MERGE SUMMARY] Blok tanda tangan: bila summary akan muncul setelah
        // section ini (unit punya temuan yang menutup dengan summary), tunda
        // TTD agar Summary berada DI ATAS TTD.
        if (sec === signSection && !summaryAfterVhms) {
          h += signBlockHtml(isVhms ? 'VHMS' : 'SOS', unit.lambung);
          h += '</div>'; // tutup .rp-sugg-sign-group
        }

        h += '</div>'; // tutup .rp-src-block
      });

      // [MERGE SUMMARY 2026-10-01] ---- Summary Component Life & Top Up (SEKALI) ----
      // Ditampilkan SEKALI per unit, di bawah Proyeksi Tren VHMS. Bila SOS & VHMS
      // dua-duanya di atas threshold -> tetap 1 kali. Bila hanya salah satu ->
      // tetap muncul di bawah proyeksi tren (pakai section tersebut).
      if (summaryAfterVhms) {
        // [TTD IKUT KONTEN 2026-10-01] Bungkus Summary + TTD dalam grup yang
        // dijaga rapat (break-before: avoid pada TTD) agar TTD TIDAK tampil
        // sendirian di halaman baru — bila tidak muat, Summary ikut pindah.
        h += '<div class="rp-summary-wrap' + (signSection ? ' rp-summary-sign-group' : '') + '">';
        h += summaryContextHtml(summarySection);
        if (signSection) {
          h += signBlockHtml(signSection.source === 'VHMS' ? 'VHMS' : 'SOS', unit.lambung);
        }
        h += '</div>';
      }

      h += '</div>'; // tutup .rp-unit-block
    });

    h += '</div>'; // /rp-doc

    box.innerHTML = h;

    // [SMART PAGE BREAK 2026-10-01] Halaman baru per unit hanya BILA PERLU —
    // mencegah halaman hampir kosong (yang terlihat sebagai "ter-split jauh").
    // Dijalankan setelah render; aman dipanggil berulang.
    try { applySmartPageBreaks(box); } catch (e) { /* non-fatal */ }
  }

  /* -----------------------------------------------------------------------
   * [SMART PAGE BREAK 2026-10-01] Atur page-break antar-unit secara PINTAR.
   * ---------------------------------------------------------------------
   * Masalah: `break-before: page` pada SEMUA unit membuat halaman hampir
   * kosong bila unit sebelumnya menyisakan ruang. Solusi: paksa halaman baru
   * HANYA bila sisa ruang di halaman terakhir TIDAK cukup untuk menampung
   * (minimal sebagian) unit berikutnya.
   *
   * Cara: ukur tinggi tiap unit di DOM (setelah render). Simulasikan posisi
   * terhadap tinggi halaman A4 yang dapat dipakai. Tandai `.rp-page-break`
   * hanya pada unit yang memicu halaman baru.
   */
  function applySmartPageBreaks(box) {
    if (!box) return;
    var unitBlocks = box.querySelectorAll('.rp-unit-block');
    if (!unitBlocks.length) return;

    // Tinggi area cetak A4 yang dapat dipakai (px @96dpi).
    // A4 = 1122.5px; margin @page 20mm atas+bawah = 2*75.6 = 151.2px -> ~971px.
    // Ambil sedikit konservatif agar aman.
    var PAGE_H = 971;
    // Ambang: paksa halaman baru bila sisa < (fraksi * tinggi unit berikutnya).
    // 0.6 artinya: bila sisa halaman < 60% unit berikutnya, mulai halaman baru.
    var THRESHOLD_FRAC = 0.6;
    // Cadangan aman agar tidak mepet batas bawah.
    var SAFETY = 24;

    // Ukur tinggi tiap unit (offsetHeight lebih stabil drpd getBoundingClientRect
    // saat elemen tersembunyi). Di preview/layar tetap terukur.
    var heights = [];
    for (var i = 0; i < unitBlocks.length; i++) {
      heights.push(unitBlocks[i].offsetHeight || unitBlocks[i].getBoundingClientRect().height || 0);
    }

    // Simulasi posisi vertikal relatif halaman.
    var posInPage = 0;   // pemakaian halaman saat ini (0..PAGE_H)
    for (var j = 0; j < unitBlocks.length; j++) {
      var blk = unitBlocks[j];
      var h = heights[j];
      if (j === 0) {
        // Unit pertama: selalu paling atas (tidak paksa/dilarang page-break).
        blk.classList.remove('rp-page-break');
        posInPage = h % PAGE_H;
        // Bila tinggi > sisa halaman, lanjut ke halaman berikutnya (posisi baru).
        if (h > PAGE_H) posInPage = h - Math.floor(h / PAGE_H) * PAGE_H;
        continue;
      }
      var remaining = PAGE_H - posInPage;
      var needBreak = (remaining - SAFETY) < (THRESHOLD_FRAC * Math.min(h, PAGE_H));
      if (needBreak) {
        blk.classList.add('rp-page-break');
        posInPage = h % PAGE_H;
        if (h > PAGE_H) posInPage = h - Math.floor(h / PAGE_H) * PAGE_H;
      } else {
        blk.classList.remove('rp-page-break');
        posInPage = (posInPage + h) % PAGE_H;
      }
    }
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
    availableUnitsWithFindings: availableUnitsWithFindings,
    availableCompartments: availableCompartments,
    applySmartPageBreaks: applySmartPageBreaks,
    buildSosSection: buildSosSection,
    buildVhmsSection: buildVhmsSection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PORTFOLIO_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

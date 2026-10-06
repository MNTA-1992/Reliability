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
   * [KONSOLIDASI 2026-10-04] Delegasi ke UI_UTIL (satu definisi bersama).
   * --------------------------------------------------------------------- */
  var _ui = global.UI_UTIL || {};

  function fmt(v, d) {
    return _ui.fmt ? _ui.fmt(v, d) : _fmtLocal(v, d);
  }
  function fmtInt(v) {
    return _ui.fmtInt ? _ui.fmtInt(v) : _fmtIntLocal(v);
  }
  function esc(s) {
    return _ui.esc ? _ui.esc(s) : _escLocal(s);
  }

  /* Fallback lokal (bila UI_UTIL belum termuat). */
  function _fmtLocal(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var dec = (d === undefined || d === null) ? 1 : d;
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function _fmtIntLocal(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('id-ID', { maximumFractionDigits: 0 });
  }
  function _escLocal(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Parameter SOS yang dinilai (yang punya makna untuk wear/condition).
  // [FIX 2026-10-01] Tambah visc_v40 agar breach V40 muncul di Portofolio.
  var PARAM_KEYS = ['wear_fe', 'wear_cu', 'wear_al', 'wear_cr', 'wear_pb', 'wear_si',
                    'wear_sn', 'wear_ni', 'visc_v100', 'visc_v40', 'tbn', 'water_pct',
                    'fuel_pct', 'soot', 'oxidation', 'nitration', 'sulfation',
                    'pqi', 'additive_na'];

  // [STANDARISASI 2026-10-03] 3 level: severity >=2 -> Critical, 1 -> Caution.
  var TIER_BY_SEV = function (sev) {
    if (sev >= 2) return { label: 'Critical', cls: 'pf-critical' };
    if (sev >= 1) return { label: 'Caution', cls: 'pf-warning' };
    return { label: 'Normal', cls: 'pf-normal' };
  };
  // Band SOS (dari config TIER_LABELS): 0 NORMAL, 1 CAUTION, 2 CRITICAL
  var BAND_BY_TIER = ['Normal', 'Caution', 'Critical'];

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
   *   - prioritas  : P1..P3 (berdasarkan severity umum, bukan rank lintas unit)
   *   - sla        : target waktu tindak lanjut
   *   - verifikasi : cara membuktikan perbaikan berhasil (acceptance criteria)
   *   - rujukan    : gabungan refs KB + rujukan SOP/manual default
   * --------------------------------------------------------------------- */
  // [STANDARISASI 2026-10-03] Fallback HARUS identik dengan vhms-config.js
  // agar hasil tidak bergantung pada urutan pemuatan skrip.
  var PRIORITY_BY_SEV = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_PRIORITY) || {
    4: { key: 'CRITICAL', label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    3: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
    2: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
    1: { key: 'CAUTION',  label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' }
  };
  var STATUS_CFG = (global.VHMS_CONFIG && global.VHMS_CONFIG.FOLLOWUP_STATUS) || {
    CRITICAL: { label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' },
    CAUTION:  { label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' },
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
    || 'Shop Manual Unit & SOP Condition Monitoring terkait.';
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
   *   - melewati ambang WARNING / CAUTION -> 'CAUTION'
   *   - selain itu               -> 'NORMAL'
   * Mendukung mode 'high', 'low', dan dual-band (visk/TBN).
   * @param {number} value
   * @param {object} th  { warn, crit, mode } — atau { warn_low, crit_low, warn_high, crit_high }
   * @returns {'CRITICAL'|'CAUTION'|'WARNING'|'NORMAL'}
   */
  function statusFromValue(value, th) {
    if (value === null || value === undefined || isNaN(value) || !th) return 'NORMAL';
    var v = Number(value);
    // Dual-band (mis. visc_v100, visc_v40, tbn) yang memiliki batas bawah / atas
    if (th.warn_low !== undefined || th.crit_low !== undefined || th.warn_high !== undefined || th.crit_high !== undefined) {
      if (typeof th.crit_low === 'number' && v <= th.crit_low) return 'CRITICAL';
      if (typeof th.crit_high === 'number' && v >= th.crit_high) return 'CRITICAL';
      if (typeof th.warn_low === 'number' && v <= th.warn_low) return 'CAUTION';
      if (typeof th.warn_high === 'number' && v >= th.warn_high) return 'CAUTION';
      return 'NORMAL';
    }
    // Mode LOW: makin KECIL makin buruk (crit < warn).
    var isLow = (th.mode === 'low');
    if (isLow) {
      var warnL = (th.warn_low !== undefined) ? th.warn_low : th.warn;
      var critL = (th.crit_low !== undefined) ? th.crit_low : th.crit;
      if (typeof critL === 'number' && v <= critL) return 'CRITICAL';
      if (typeof warnL === 'number' && v <= warnL) return 'CAUTION';
      return 'NORMAL';
    }
    // Mode HIGH: makin BESAR makin buruk.
    if (typeof th.extreme === 'number' && v >= th.extreme) return 'CRITICAL';
    if (typeof th.crit === 'number' && v >= th.crit) return 'CRITICAL';
    if (typeof th.warn === 'number' && v >= th.warn) return 'CAUTION';
    return 'NORMAL';
  }

  /**
   * [STANDARISASI 2026-10-03] Normalisasi kunci status apa pun ke 3 level.
   * Kunci lama MONITOR/WARNING -> CAUTION, EXTREME -> CRITICAL.
   */
  function normStatusKey(status) {
    var k = String(status || '').toUpperCase();
    if (k === 'MONITOR' || k === 'WARNING') return 'CAUTION';
    if (k === 'EXTREME') return 'CRITICAL';
    if (k === 'CRITICAL' || k === 'CAUTION') return k;
    return 'NORMAL';
  }

  /** Ambil objek config status (label/cls/sla) dari config yang bisa diubah. */
  function statusMeta(status) {
    var key = normStatusKey(status);
    var s = STATUS_CFG[key];
    if (s) return s;
    // Fallback bila config tak lengkap.
    if (key === 'CRITICAL') return { label: 'Critical', cls: 'pf-critical', sla: '1x24 Jam' };
    if (key === 'CAUTION')  return { label: 'Caution',  cls: 'pf-warning',  sla: '2x24 Jam' };
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
    // [KONSISTENSI STATUS] Prioritaskan status & severity yang sudah dihitung oleh
    // analytics engine (SOS_ANALYTICS / VHMS_ANALYTICS) agar tabel Suggestion
    // SELALU konsisten dengan tabel Parameter (tidak pernah mismatch/turun ke NORMAL).
    // [STANDARISASI 2026-10-03] Semua jalur dinormalisasi ke 3 level.
    var st = null;
    if (r.status && String(r.status).toUpperCase() !== 'NORMAL') {
      st = normStatusKey(r.status);
      if (st === 'NORMAL') st = null;
    }
    if (!st && typeof r.severity === 'number' && r.severity > 0) {
      st = (r.severity >= 2) ? 'CRITICAL' : 'CAUTION';
    }
    if (!st && r.level) {
      if (r.level === 'severe' || r.level === 'critical') st = 'CRITICAL';
      else if (r.level === 'warn') st = 'CAUTION';
    }
    // Fallback: hitung dari nilai vs threshold bila status/severity belum terisi
    if (!st) {
      st = statusFromValue(r.value, {
        warn: r.warnTh, crit: r.critTh, extreme: r.extremeTh,
        warn_low: r.warnLowTh, crit_low: r.critLowTh,
        warn_high: r.warnHighTh, crit_high: r.critHighTh,
        mode: r.thMode
      });
    }

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
    //   NORMAL   -> Inspeksi ringan (pantau/inspeksi visual)
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
        var isLow = th.mode === 'low' || (th.warn_low !== undefined);
        var warnDisp = isLow && th.warn !== null && th.warn !== undefined ? ('< ' + fmt(th.warn, meta.decimals)) : (th.warn !== null && th.warn !== undefined ? fmt(th.warn, meta.decimals) : '—');
        var critDisp = isLow && th.crit !== null && th.crit !== undefined ? ('< ' + fmt(th.crit, meta.decimals)) : (th.crit !== null && th.crit !== undefined ? fmt(th.crit, meta.decimals) : '—');
        // Melewati threshold pada data TERBARU -> tampilkan sebagai temuan aktif.
        out.push({
          key: key,
          label: meta.label,
          value: v,
          unit: meta.unit || '',
          decimals: meta.decimals,
          warn: th.warn,
          crit: th.crit,
          warnDisplay: warnDisp,
          critDisplay: critDisp,
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
        // [FITUR 2026-10-03] Ambang display historis: dukung dual-band & low-only.
        var _wLow = (typeof th.warn_low === 'number') ? th.warn_low : ((typeof th.warn === 'number') ? th.warn : null);
        var _cLow = (typeof th.crit_low === 'number') ? th.crit_low : ((typeof th.crit === 'number') ? th.crit : null);
        var _wHigh = (typeof th.warn_high === 'number') ? th.warn_high : ((typeof th.warn === 'number') ? th.warn : null);
        var _cHigh = (typeof th.crit_high === 'number') ? th.crit_high : ((typeof th.crit === 'number') ? th.crit : null);
        var _isDualH = (th.warn_low !== undefined || th.crit_low !== undefined) &&
                       (th.warn_high !== undefined || th.crit_high !== undefined);
        var _isLowH = (th.mode === 'low') || (th.warn_low !== undefined && !_isDualH);
        var warnDispH, critDispH;
        if (_isDualH) {
          // Puncak breach ada di nilai a.value -> tentukan sisi yang dilanggar.
          var _hv = (a.value !== null && a.value !== undefined) ? a.value : v;
          var _dir = (_wHigh !== null && _hv >= _wHigh) || (_cHigh !== null && _hv >= _cHigh) ? 'high' : 'low';
          if (_dir === 'high') {
            warnDispH = _wHigh !== null ? '> ' + fmt(_wHigh, meta.decimals) : '—';
            critDispH = _cHigh !== null ? '> ' + fmt(_cHigh, meta.decimals) : '—';
          } else {
            warnDispH = _wLow !== null ? '< ' + fmt(_wLow, meta.decimals) : '—';
            critDispH = _cLow !== null ? '< ' + fmt(_cLow, meta.decimals) : '—';
          }
        } else if (_isLowH) {
          warnDispH = _wLow !== null ? '< ' + fmt(_wLow, meta.decimals) : '—';
          critDispH = _cLow !== null ? '< ' + fmt(_cLow, meta.decimals) : '—';
        } else {
          warnDispH = _wHigh !== null ? fmt(_wHigh, meta.decimals) : '—';
          critDispH = _cHigh !== null ? fmt(_cHigh, meta.decimals) : '—';
        }
        out.push({
          key: key,
          label: meta.label,
          value: v,
          unit: meta.unit || '',
          decimals: meta.decimals,
          warn: th.warn,
          crit: th.crit,
          warnDisplay: warnDispH,
          critDisplay: critDispH,
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
      r.status = anomaly.status;
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

      var hasLow = (t.warn_low !== undefined || t.crit_low !== undefined);
      var hasHigh = (t.warn_high !== undefined || t.crit_high !== undefined || t.warn !== undefined || t.crit !== undefined);
      var isDual = hasLow && hasHigh;
      var isLowOnly = hasLow && !hasHigh;

      var warnLow = (typeof t.warn_low === 'number') ? t.warn_low : null;
      var critLow = (typeof t.crit_low === 'number') ? t.crit_low : null;
      var warnHigh = (typeof t.warn_high === 'number') ? t.warn_high : ((typeof t.warn === 'number') ? t.warn : null);
      var critHigh = (typeof t.crit_high === 'number') ? t.crit_high : ((typeof t.crit === 'number') ? t.crit : null);

      var breachDirection = 'high';
      if (hasLow) {
        if ((critLow !== null && v <= critLow) || (warnLow !== null && v <= warnLow)) {
          breachDirection = 'low';
        } else if (hasHigh && ((critHigh !== null && v >= critHigh) || (warnHigh !== null && v >= warnHigh))) {
          breachDirection = 'high';
        } else if (isLowOnly) {
          breachDirection = 'low';
        }
      }

      var warnDisplay = '';
      var critDisplay = '';
      var dec = meta.decimals;

      if (isDual) {
        // [FITUR 2026-10-03] Dual-band: tampilkan HANYA sisi yang dilanggar.
        // Melewati batas ATAS -> tampilkan ambang High. Melewati batas BAWAH
        // -> tampilkan ambang Low. Bila arah tak terdeteksi, tampilkan LOW
        // (batas yang paling umum jadi perhatian pada oli).
        var dir = (breachDirection === 'high') ? 'high' : 'low';
        if (dir === 'high') {
          warnDisplay = warnHigh !== null ? '> ' + fmt(warnHigh, dec) : '—';
          critDisplay = critHigh !== null ? '> ' + fmt(critHigh, dec) : '—';
        } else {
          warnDisplay = warnLow !== null ? '< ' + fmt(warnLow, dec) : '—';
          critDisplay = critLow !== null ? '< ' + fmt(critLow, dec) : '—';
        }
      } else if (isLowOnly) {
        warnDisplay = warnLow !== null ? '< ' + fmt(warnLow, dec) : '—';
        critDisplay = critLow !== null ? '< ' + fmt(critLow, dec) : '—';
      } else {
        warnDisplay = warnHigh !== null ? fmt(warnHigh, dec) : '—';
        critDisplay = critHigh !== null ? fmt(critHigh, dec) : '—';
      }

      out.push({
        key: pk,
        label: meta.label || pk,
        value: v,
        unit: meta.unit || '',
        decimals: meta.decimals,
        warn: (breachDirection === 'low' && warnLow !== null) ? warnLow : warnHigh,
        crit: (breachDirection === 'low' && critLow !== null) ? critLow : critHigh,
        extreme: (t.extreme !== undefined) ? t.extreme : t.extreme_high,
        warn_low: warnLow,
        crit_low: critLow,
        warn_high: warnHigh,
        crit_high: critHigh,
        isDual: isDual,
        isLowOnly: isLowOnly,
        breachDirection: breachDirection,
        warnDisplay: warnDisplay,
        critDisplay: critDisplay,
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

    var hasLow = (th.warn_low !== undefined || th.crit_low !== undefined);
    var hasHigh = (th.warn_high !== undefined || th.crit_high !== undefined || th.warn !== undefined || th.crit !== undefined);
    var isLow = false;
    if (hasLow && hasHigh) {
      isLow = (slope < 0);
    } else if (hasLow || th.mode === 'low') {
      isLow = true;
    }
    var critTh = isLow
      ? (th.crit_low !== undefined ? th.crit_low : th.crit)
      : (th.crit_high !== undefined ? th.crit_high : th.crit);
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
        component: unit.component,
        // [SADAR-MEREK 2026-10-01] Sertakan model agar rujukan manual TEPAT
        // (armada bisa berisi merek selain Komatsu).
        model: unit.model,
        // [HIPOTESIS SPESIFIK-NILAI 2026-10-01] Sertakan ambang agar hipotesis
        // mengikat nilai nyata vs Warning/Critical (bukan generik).
        warn: b.warn, crit: b.crit, extreme: b.extreme,
        warn_low: b.warn_low, crit_low: b.crit_low,
        warn_high: b.warn_high, crit_high: b.crit_high,
        isDual: b.isDual, breachDirection: b.breachDirection
      });
      // [STATUS DARI NILAI] Simpan nilai & ambang agar status (NORMAL/WARNING/
      // CRITICAL) + SLA dihitung dari perbandingan nilai vs threshold.
      rec.value = b.value;
      rec.warnTh = b.warn;
      rec.critTh = b.crit;
      rec.extremeTh = b.extreme;
      rec.warnLowTh = b.warn_low;
      rec.critLowTh = b.crit_low;
      rec.warnHighTh = b.warn_high;
      rec.critHighTh = b.crit_high;
      rec.severity = b.severity;
      rec.status = b.status;
      rec.thMode = b.breachDirection === 'low' ? 'low' : ((b.crit !== undefined && b.warn !== undefined && b.crit < b.warn) ? 'low' : 'high');
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
      // [STANDARISASI 2026-10-03] Kunci internal band (NORMAL/CAUTION/CRITICAL)
      // — dipakai utk perbandingan 'terburuk'; label dari BAND_BY_TIER saat render.
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

    // [STANDARISASI 2026-10-03] Band unit = yang terburuk di antara sections.
    // Urutan 3 level: NORMAL(0) < CAUTION(1) < CRITICAL(2).
    // Alias lama dinormalisasi lebih dulu agar tidak ada konflik semantik.
    var order = { CRITICAL: 2, CAUTION: 1, NORMAL: 0 };
    out.forEach(function (e) {
      var worst = 'NORMAL', worstScore = 0;
      e.sections.forEach(function (s) {
        var band = normStatusKey(s.band);
        s.band = band;
        if ((order[band] || 0) > (order[worst] || 0)) worst = band;
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
   * [FITUR 2026-10-03] Ambil daftar kompartmen yang PUNYA BREACH (parameter
   * melewati threshold) dari unit & filter yang diberikan.
   * @param {string} [onlyLambung]
   * @param {string} [section]
   * @param {string} [model]
   * @returns {array} daftar nama kompartmen unik yang punya breach (terurut)
   */
  function compartmentsWithBreach(onlyLambung, section, model) {
    var units;
    if (onlyLambung) {
      units = collect(onlyLambung);
    } else {
      units = filterUnits(collect(), section, model);
    }
    var seen = {};
    units.forEach(function (u) {
      (u.sections || []).forEach(function (s) {
        // Hanya kompartmen yang punya temuan (breached)
        if (s.breached && s.breached.length > 0 && s.component) {
          seen[s.component] = true;
        }
      });
    });
    return Object.keys(seen).sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }

  /**
   * [FITUR 2026-10-01] Saring `unit.sections` sesuai KOMPARTEMEN terpilih.
   * Mengembalikan unit baru (copy) dengan sections yang cocok saja — dipakai
   * untuk mencetak sebagian kompartemen (mis. hanya ENGINE).
   * @param {array}  units
   * @param {string|array} compartment  '' = semua, atau array kompartmen terpilih
   * @returns {array}
   */
  function filterByCompartment(units, compartment) {
    if (!compartment) return units;
    
    // [FITUR 2026-10-03] Support array (checkbox) atau string (backward compat)
    var selected = Array.isArray(compartment) ? compartment : [compartment];
    if (selected.length === 0) return units;
    
    return units.map(function (u) {
      var secs = (u.sections || []).filter(function (s) {
        return selected.indexOf(String(s.component || '')) !== -1;
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
        '<th scope="col" class="center">Status</th><th scope="col">Parameter / Event</th><th scope="col">Aksi (What &amp; How)</th>' +
        '<th scope="col">Penyebab (Why)</th><th scope="col">' + esc(impactColLabel) + '</th><th scope="col">Tingkat Risiko</th><th scope="col" class="center">Target</th>' +
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

    // ---- 2) Daftar TINDAKAN GABUNGAN (v3 — Terstruktur Bertahap) ----
    // Konsep penyampaian informasi:
    // (1) Menjelaskan action follow up sesuai URUTAN ELEMEN/PARAMETER yang di atas threshold.
    // (2) Dilanjutkan dengan narasi penjelasan penunjang/rule-based yang berkaitan.
    var paramActions = [];
    var seenActs = {};
    recs.forEach(function (r) {
      var name = r.title || r.label || r.param || '';
      var comp = compartmentFor(r.param, sec);
      var compTag = comp ? ' <span class="rp-comp-tag">[' + esc(comp) + ']</span>' : '';
      var acts = (r.actions || []).slice(0, 3);
      if (acts.length) {
        var actText = acts.map(esc).join(' · ');
        if (!seenActs[name + '|' + actText]) {
          seenActs[name + '|' + actText] = true;
          paramActions.push({
            html: '<strong>' + esc(name) + '</strong>: ' + actText + compTag,
            isRule: false
          });
        }
      }
    });

    var ruleActions = [];
    (rules || []).forEach(function (rl) {
      ruleActions.push({
        html: '<span class="pf-sugg-rule-tag"><i class="fa-solid fa-circle-info"></i> ' + esc(rl.title) + ':</span> ' + esc(rl.detail),
        isRule: true
      });
    });

    var allActions = paramActions.concat(ruleActions);
    if (allActions.length) {
      var actN = allActions.length;
      var useTwoCol = actN >= 4;
      var actShort = actN <= 4 ? ' pf-sugg-short' : '';
      h += '<div class="pf-sugg-block' + actShort + '"><div class="pf-rec-sub"><i class="fa-solid fa-screwdriver-wrench"></i> ' +
        'Tindakan Gabungan (' + actN + ' Tindakan Terarah):</div>';

      if (useTwoCol) {
        h += '<div class="pf-dual-grid pf-dual-actions">';
        allActions.forEach(function (x) {
          h += '<div class="pf-sugg-grid-item' + (x.isRule ? ' pf-sugg-rule' : '') + '">' + x.html + '</div>';
        });
        h += '</div>';
      } else {
        h += '<ul class="pf-sugg-list">';
        allActions.forEach(function (x) {
          h += '<li' + (x.isRule ? ' class="pf-sugg-rule"' : '') + '>' + x.html + '</li>';
        });
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
        '<th scope="col">Parameter</th><th scope="col" class="center">Laju /100 jam</th><th scope="col" class="center">Arah</th><th scope="col">Estimasi</th>' +
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
   * Blok "Dugaan Penyebab (Hipotesis Effect)" (v3 — Terstruktur Bertahap).
   * Konsep penyampaian informasi:
   * (1) Ditulis berurutan dahulu menjelaskan masing-masing elemen/parameter yang
   *     di atas threshold berdasarkan indikasi rujukan keausan jenis kompartemen.
   * (2) Setelah semua elemen dijelaskan, disambung narasi penunjang informasi lainnya.
   */
  function hypothesesHtml(sec) {
    var recs = sec.recs || [];
    var rules = sec.rules || [];
    if (!recs.length && !rules.length) return '';

    // 1) Butir utama: berurutan per parameter/elemen yang breach
    var paramItems = [];
    var seenCauses = {};
    recs.forEach(function (r) {
      var name = r.title || r.label || r.param || '';
      var comp = compartmentFor(r.param, sec);
      var compTag = comp ? ' <span class="rp-comp-tag">[' + esc(comp) + ']</span>' : '';
      var likelyList = (r.likely || []).slice();
      if (likelyList.length) {
        var text = likelyList.join(' — ');
        if (!seenCauses[name + '|' + text]) {
          seenCauses[name + '|' + text] = true;
          paramItems.push({
            html: '<strong>' + esc(name) + '</strong>: ' + esc(text) + compTag,
            isRule: false
          });
        }
      }
    });

    // 2) Butir penunjang: rule-based (Lifetime / Top-Up / temuan terkait)
    var ruleItems = [];
    (rules || []).forEach(function (rl) {
      ruleItems.push({
        html: '<span class="pf-sugg-rule-tag"><i class="fa-solid fa-circle-info"></i> ' + esc(rl.title) + ':</span> ' + esc(rl.detail),
        isRule: true
      });
    });

    var allHypo = paramItems.concat(ruleItems);
    if (!allHypo.length) return '';

    var hypoN = allHypo.length;
    var useTwoCol = hypoN >= 4;
    var hypoShort = hypoN <= 4 ? ' pf-sugg-short' : '';
    var h = '<div class="pf-sugg-block rp-hypo"><div class="pf-rec-sub"><i class="fa-solid fa-magnifying-glass"></i> ' +
      'Dugaan Penyebab (Hipotesis Effect) — ' + hypoN + ' Indikasi:</div>';

    if (useTwoCol) {
      h += '<div class="pf-dual-grid pf-dual-causes">';
      allHypo.forEach(function (x) {
        h += '<div class="pf-sugg-grid-item' + (x.isRule ? ' pf-sugg-rule' : '') + '">' + x.html + '</div>';
      });
      h += '</div>';
    } else {
      h += '<ul class="pf-sugg-list pf-sugg-causes' + hypoShort + '">';
      allHypo.forEach(function (x) {
        h += '<li' + (x.isRule ? ' class="pf-sugg-rule"' : '') + '>' + x.html + '</li>';
      });
      h += '</ul>';
    }
    h += '</div>';
    return h;
  }

  /* -----------------------------------------------------------------------
   * Entry render
   * --------------------------------------------------------------------- */
  // [FIX 2026-10-01] Mode default: 'unit' (Per Unit). Opsi seluruh armada dihapus.
  // [FITUR 2026-10-01] Tambah `compartment` — cetak/seleksi SEBAGIAN kompartemen
  // saja (mis. hanya ENGINE) untuk mempercepat pencarian & print out partial.
  // [FITUR 2026-10-03] Ubah `compartment` -> `compartmentSelected` (array checkbox)
  var portfolioState = { mode: 'unit', unitLambung: '', section: '', model: '', compartment: '', compartmentSelected: [] };

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
      '<th scope="col" class="rp-no">No</th>' +
      '<th scope="col">' + (isVhms ? 'Parameter / Event VHMS' : 'Parameter SOS') + '</th>' +
      '<th scope="col" class="center">Nilai</th>' +
      '<th scope="col" class="center">Ambang Warning</th>' +
      '<th scope="col" class="center">Ambang Critical</th>' +
      '<th scope="col" class="center">Status</th>' +
      '<th scope="col" class="rp-verify">Verifikasi</th>' +
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
      // [REVISI 2026-10-03] Ambang batas memakai satuan yang sama dengan nilai
      // (mis. "> 20,0 cSt") agar konsisten & mudah dibandingkan.
      var thUnit = b.unit ? ' ' + b.unit : '';
      var warnText = b.warnDisplay || (b.warn !== null && b.warn !== undefined ? fmt(b.warn, b.decimals) : '—');
      var critText = b.critDisplay || (b.crit !== null && b.crit !== undefined ? fmt(b.crit, b.decimals) : '—');
      if (warnText !== '—' && thUnit) warnText += thUnit;
      if (critText !== '—' && thUnit) critText += thUnit;
      h += '<tr' + (isHist ? ' class="rp-row-hist"' : '') + '>' +
        '<td class="rp-no">' + n + '</td>' +
        '<td><strong>' + esc(name) + '</strong>' +
          (sub ? '<span class="rp-sub"> (' + esc(sub) + ')</span>' : '') +
          (isHist && b.historicalValue !== null && b.historicalValue !== undefined
            ? '<span class="rp-peak">puncak ' + fmt(b.historicalValue, b.decimals) +
              (b.historicalDate ? ' @ ' + esc(b.historicalDate) : '') + '</span>' : '') +
        '</td>' +
        '<td class="center mono">' + fmt(b.value, b.decimals) + ' ' + esc(b.unit) + '</td>' +
        '<td class="center mono">' + esc(warnText) + '</td>' +
        '<td class="center mono">' + esc(critText) + '</td>' +
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
        '<th scope="col">Komponen</th><th scope="col" class="center">Cycle Budget</th><th scope="col" class="center">Total HM</th>' +
        '<th scope="col" class="center">Umur Terpakai</th><th scope="col" class="center">Life</th><th scope="col" class="center">Last Install</th>' +
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
        '<th scope="col" class="center">Tanggal</th><th scope="col" class="center">Qty</th><th scope="col" class="center">Satuan</th>' +
        '<th scope="col" class="center">Kompartemen</th><th scope="col" class="center">Jenis</th></tr></thead><tbody>';
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

  /**
   * [PENAMAAN LAPORAN 2026-10-03] Format nama file default saat cetak / simpan Portofolio:
   * # Result Oil Analysis_[Compartment]_[Caution/Critical]_[No Lambung]_Follow Up [SLA] (bila SOS)
   * # Result VHMS Trend_[Engine]_[Caution/Critical]_[No Lambung]_Follow Up [SLA] (bila VHMS)
   */
  function getPortfolioReportFileName(targetUnit) {
    var unit = targetUnit;
    if (!unit) {
      var units;
      if (portfolioState.mode === 'unit' && portfolioState.unitLambung) {
        units = collect(portfolioState.unitLambung);
      } else if (portfolioState.mode === 'unit' && (portfolioState.section || portfolioState.model)) {
        units = filterUnits(collect(), portfolioState.section, portfolioState.model);
      } else {
        units = collect();
      }
      if (portfolioState.compartment) {
        units = filterByCompartment(units, portfolioState.compartment);
      }
      if (units && units.length) unit = units[0];
    }
    if (!unit) return '# Result Oil Analysis';

    // 1. Cari section sumber (SOS / VHMS)
    var hasSos = false;
    var hasVhms = false;
    (unit.sections || []).forEach(function (s) {
      if ((s.breached || []).length) {
        if (s.source === 'SOS') hasSos = true;
        if (s.source === 'VHMS') hasVhms = true;
      }
    });
    if (!hasSos && !hasVhms && unit.sections && unit.sections.length) {
      if (unit.sections[0].source === 'VHMS') hasVhms = true;
      else hasSos = true;
    }
    var prefix = (hasVhms && !hasSos) ? '# Result VHMS Trend' : '# Result Oil Analysis';

    // 2. Compartment
    var comp = '';
    if (hasVhms && !hasSos) {
      comp = 'Engine';
    } else {
      // [FIX 2026-10-06] Prioritaskan KOMPARTEMEN TERPILIH (checkbox array
      // `compartmentSelected`) — sebelumnya hanya membaca `compartment` (string
      // legacy) sehingga nama file memakai "kompartemen critical pertama",
      // BUKAN kompartemen yang benar-benar dipilih user (mis. klik baris
      // "FINAL DRIVE REAR LEFT" tetapi nama jadi "...REAR RIGHT...").
      var selComps = (portfolioState.compartmentSelected && portfolioState.compartmentSelected.length)
        ? portfolioState.compartmentSelected
        : (portfolioState.compartment ? [portfolioState.compartment] : []);
      if (selComps.length) {
        comp = selComps.join(' & ');
      } else {
        var critSec = (unit.sections || []).filter(function (s) {
          return (s.breached || []).some(function (b) { return b.severity >= 2; });
        })[0];
        var warnSec = (unit.sections || []).filter(function (s) {
          return (s.breached || []).length > 0;
        })[0];
        var secForComp = critSec || warnSec || (unit.sections && unit.sections[0]);
        if (secForComp) comp = secForComp.component || secForComp.contextComponent || '';
      }
      if (!comp) comp = 'Compartment';
    }
    comp = String(comp).replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 3. No Lambung
    var lambung = unit.lambung || unit.serial || 'Unit';
    lambung = String(lambung).replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 4. Status: Normal / Caution / Critical (3 level)
    var isCrit = false;
    var isCaution = false;
    var recs = [];
    (unit.sections || []).forEach(function (s) {
      var sBand = normStatusKey(s.band);
      if (sBand === 'CRITICAL') isCrit = true;
      else if (sBand === 'CAUTION') isCaution = true;
      if (s.recs) recs = recs.concat(s.recs);
      (s.breached || []).forEach(function (b) {
        if (b.severity >= 2 || normStatusKey(b.status) === 'CRITICAL') isCrit = true;
        else if (b.severity >= 1 || normStatusKey(b.status) === 'CAUTION') isCaution = true;
      });
    });

    var uBand = normStatusKey(unit.band);
    if (uBand === 'CRITICAL') isCrit = true;
    else if (uBand === 'CAUTION') isCaution = true;

    var status = isCrit ? 'Critical' : (isCaution ? 'Caution' : 'Normal');

    // 5. SLA — langsung dari config (CAUTION kini benar 2x24 Jam).
    var sla = '1x24 Jam';
    var vcfg = global.VHMS_CONFIG;
    var fup = (vcfg && vcfg.FOLLOWUP_STATUS) || {};

    var critRec = recs.filter(function (r) {
      return normStatusKey(r.status) === 'CRITICAL';
    })[0];
    var cautionRec = recs.filter(function (r) {
      return normStatusKey(r.status) === 'CAUTION';
    })[0];

    if (status === 'Critical') {
      sla = (critRec && critRec.sla) || (fup.CRITICAL && fup.CRITICAL.sla) || '1x24 Jam';
    } else if (status === 'Caution') {
      sla = (cautionRec && cautionRec.sla) || (fup.CAUTION && fup.CAUTION.sla) || '2x24 Jam';
    } else {
      sla = (fup.NORMAL && fup.NORMAL.sla) || '-';
    }

    return prefix + '_' + comp + '_' + status + '_' + lambung + '_Follow Up ' + sla;
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

    // [FITUR 2026-10-03] Filter KOMPARTEMEN dari checkbox (array) atau backward compat
    // Gunakan compartmentSelected (array) jika ada, fallback ke compartment (string)
    var compFilter = portfolioState.compartmentSelected && portfolioState.compartmentSelected.length > 0
      ? portfolioState.compartmentSelected
      : (portfolioState.compartment || '');
    if (compFilter) {
      units = filterByCompartment(units, compFilter);
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
        var compDescr = '';
        if (portfolioState.compartmentSelected && portfolioState.compartmentSelected.length > 0) {
          compDescr = ' kompartemen <strong>' + portfolioState.compartmentSelected.join(', ') + '</strong>';
        } else if (portfolioState.compartment) {
          compDescr = ' kompartemen <strong>' + esc(portfolioState.compartment) + '</strong>';
        }
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
          'Unit <strong>' + esc(portfolioState.unitLambung) + '</strong>' + compDescr +
          ' tidak memiliki parameter yang melewati threshold pada data terbaru.</div>';
      } else if (filterActive || portfolioState.compartmentSelected?.length > 0 || portfolioState.compartment) {
        var parts = [];
        if (portfolioState.section) parts.push('Section = ' + esc(portfolioState.section));
        if (portfolioState.model) parts.push('Model = ' + esc(portfolioState.model));
        if (portfolioState.compartmentSelected && portfolioState.compartmentSelected.length > 0) {
          parts.push('Kompartemen = ' + portfolioState.compartmentSelected.join(', '));
        } else if (portfolioState.compartment) {
          parts.push('Kompartemen = ' + esc(portfolioState.compartment));
        }
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-filter-circle-xmark"></i> ' +
          'Tidak ada unit yang cocok dengan filter (' + parts.join(', ') + ').</div>';
      } else {
        box.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
          'Tidak ada parameter yang melewati threshold pada data terbaru.</div>';
      }
      return;
    }

    // Set document.title sesuai nama laporan unit yang sedang aktif/ditampilkan
    if (units.length) {
      try {
        document.title = getPortfolioReportFileName(units[0]);
      } catch (e) { if (global.console && console.warn) console.warn('[PORTFOLIO_RENDER] gagal set document.title:', e && e.message); }
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
      // ---- Bagian parameter per sumber (SOS / VHMS) ----
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
        var isSignSection = (sec === signSection);
        if (isSignSection) h += '<div class="rp-sugg-sign-group">';

        h += '<div class="rp-sec-group rp-sec-group-sugg">';
        h += docSectionTitle(sectionNo, 'Suggestion Teknis — ' +
          (isVhms ? 'VHMS (' + (sec.component || '') + ')' : 'SOS (' + (sec.component || '') + ')'));
        h += suggestionSummaryHtml(sec);
        h += '</div>'; // tutup .rp-sec-group (Suggestion)

        // [FIX 2026-10-01] Summary Component Life & Top Up dirender PER
        // SECTION (per kompartemen), BUKAN sekali per unit. Tiap section SOS
        // sudah punya lifetime/topup yang di-match ke kompartemennya sendiri.
        if (hasLife || hasTop) {
          h += summaryContextHtml(sec);
        }

        if (isSignSection) {
          h += signBlockHtml(isVhms ? 'VHMS' : 'SOS', unit.lambung);
          h += '</div>'; // tutup .rp-sugg-sign-group
        }

        h += '</div>'; // tutup .rp-src-block
      });

      // [FIX 2026-10-01] Summary TIDAK lagi dirender sekali setelah loop —
      // sudah dirender per-section di atas. TTD di section terakhir.
      // Jika tidak ada section yang punya summary tetapi ada signSection yang
      // belum ditutup, tutup di sini.

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
    getPortfolioReportFileName: getPortfolioReportFileName,
    availableUnits: availableUnits,
    availableUnitsWithFindings: availableUnitsWithFindings,
    availableCompartments: availableCompartments,
    compartmentsWithBreach: compartmentsWithBreach,
    applySmartPageBreaks: applySmartPageBreaks,
    buildSosSection: buildSosSection,
    buildVhmsSection: buildVhmsSection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PORTFOLIO_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

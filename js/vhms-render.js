/* =========================================================================
 * vhms-render.js
 * -------------------------------------------------------------------------
 * Lapisan presentasi: menggambar KPI, chart, panel anomali, dan tabel
 * berdasarkan objek hasil VHMS_ANALYTICS.analyze().
 * Semua angka ditampilkan format Indonesia (1.234,5).
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  var charts = {};   // simpan instance Chart.js agar bisa di-update/destroy
  var activeAnalysis = null;   // analisis unit aktif (untuk modal rekomendasi)

  /* [FITUR] State filter kolom pada tabel "Ringkasan & Kesimpulan" (overlay
   * Comparison). Tiap kolom punya input teks (seperti filter Excel) untuk
   * mempersempit baris. Data terakhir disimpan agar pengetikan filter dapat
   * me-render ulang tabel TANPA menggambar ulang chart overlay.
   * cols: daftar kunci kolom yang bisa difilter. */
  var overlaySummaryState = {
    filters: {},          // { colKey: 'teks filter' }
    lastRows: null,       // pickedRows terakhir
    lastParamKey: null,   // paramKey terakhir
    wired: false          // listener input sudah dipasang?
  };

  /* -----------------------------------------------------------------------
   * Format angka & tanggal (locale Indonesia)
   * --------------------------------------------------------------------- */
  function fmt(value, decimals) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    var d = (decimals === undefined || decimals === null) ? 1 : decimals;
    return Number(value).toLocaleString('id-ID', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function fmtInt(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return Number(value).toLocaleString('id-ID', { maximumFractionDigits: 0 });
  }

  /**
   * Format laju/trend (mis. slope per jam) dalam notasi desimal biasa —
   * TIDAK PERNAH memakai notasi ilmiah (mis. "9.4e-4") agar mudah dibaca.
   * Jumlah desimal menyesuaikan besaran nilai supaya angka penting tetap tampil.
   */
  function fmtRate(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    var v = Math.abs(Number(value));
    var d;
    if (v === 0) d = 2;
    else if (v < 0.001) d = 6;
    else if (v < 0.01) d = 5;
    else if (v < 0.1) d = 4;
    else if (v < 1) d = 3;
    else if (v < 100) d = 2;
    else d = 1;
    return Number(value).toLocaleString('id-ID', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function paramMeta(key) { return cfg.PARAMS[key] || { label: key, unit: '', decimals: 1 }; }

  /** [POIN 1] Label kecil penanda keluarga produk di katalog. */
  function familyTag(familyId) {
    if (!familyId || !global.VHMS_PROFILES) return '';
    var f = global.VHMS_PROFILES.getFamily(familyId);
    if (!f || f.id === 'UNKNOWN') {
      return ' <span class="chip" style="font-size:9px;padding:1px 6px;color:#94a3b8">NA</span>';
    }
    return ' <span class="chip" style="font-size:9px;padding:1px 6px;color:' + f.accent + ';border-color:' + f.accent + '">' + esc(f.short) + '</span>';
  }

  /** Ubah warna HEX/RGBA menjadi rgba dengan alpha tertentu.
   *  Delegasi ke VHMS_ANALYTICS.hexToRgba bila tersedia, dengan fallback lokal. */
  function toRgba(color, alpha) {
    if (!color) return 'rgba(148,163,184,' + alpha + ')';
    if (String(color).indexOf('rgba') === 0) return color;
    if (global.VHMS_ANALYTICS && global.VHMS_ANALYTICS.hexToRgba) {
      return global.VHMS_ANALYTICS.hexToRgba(color, alpha);
    }
    var h = String(color).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(148,163,184,' + alpha + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function displayValue(key, value) {
    var meta = paramMeta(key);
    return { text: fmt(value, meta.decimals), unit: meta.unit };
  }

  /** Format RUL (sisa jam) untuk sel tabel fleet/ranking. */
  function rulCellHtml(rul) {
    if (!rul) return '<span style="color:#64748b">—</span>';
    if (rul.alreadyCritical) return '<span style="color:#f87171;font-weight:700"><i class="fa-solid fa-skull-crossbones"></i> 0 jam</span>';
    if (rul.hours === Infinity || rul.hours > 50000) return '<span style="color:#34d399">Stabil</span>';
    var color = rul.hours <= 500 ? '#f87171' : (rul.hours <= 2000 ? '#fbbf24' : '#34d399');
    return '<span style="color:' + color + ';font-weight:600">' + fmtInt(rul.hours) + ' jam</span>';
  }

  /* -----------------------------------------------------------------------
   * Render header unit + KPI
   * --------------------------------------------------------------------- */
  function renderHeader(analysis) {
    var m = analysis.meta || {};
    // [HEADER DETAIL] Tampilkan kembali statistik & chip identitas unit.
    var header = document.querySelector('.app-header');
    if (header) header.classList.remove('header-compact');
    // Pastikan label statistik kembali ke istilah VHMS (bisa saja diubah
    // sebelumnya oleh mode SOS yang memakai elemen header yang sama).
    setText('header-smr-label', 'Service Meter Reading');
    setText('header-health-label', 'Health Index');
    setText('header-rul-label', 'Sisa Operasi (RUL)');
    setText('machine-model', m.model || 'PC2000');
    setText('machine-sn', 'SN: ' + (m.serial || '—'));
    // [REVISI #8] Pastikan subjudul header TAMPIL kembali saat masuk mode VHMS
    // (mode SOS menyembunyikannya agar header lebih rapi).
    var engEl = document.getElementById('machine-engine');
    if (engEl) {
      var engWrap = engEl.closest ? engEl.closest('.header-sub') : null;
      if (engWrap) engWrap.style.display = '';
      engEl.style.display = '';
    }
    setText('machine-engine', 'Engine: ' + (m.engineModel || '—'));
    setText('header-smr', fmt(analysis.smrRange.last, 1));
    setText('header-time', analysis.lastTimestamp || '—');

    // [POIN 1] Keluarga produk + ubah label h1 (EXCAVATOR/TRUCK/DOZER)
    var fam = (global.VHMS_PROFILES && analysis.familyId)
      ? global.VHMS_PROFILES.getFamily(analysis.familyId) : null;
    var famEl = document.getElementById('machine-family');
    if (famEl && fam) {
      famEl.textContent = fam.label;
      famEl.style.display = '';
      famEl.style.borderColor = fam.accent;
      famEl.style.color = fam.accent;
    }
    // Judul h1 (DETAIL): sembunyikan nama perusahaan (#machine-brand) dan
    // tampilkan "<KELUARGA> <MODEL>" pada #machine-model (mis. "DOZER D375A").
    // Saat kembali ke home, resetHeader() mengembalikan nama perusahaan.
    var h1 = document.querySelector('.header-title h1');
    var brandEl = document.getElementById('machine-brand');
    var modelEl = document.getElementById('machine-model');
    if (brandEl) brandEl.style.display = 'none';
    if (modelEl) {
      modelEl.style.display = '';
      if (fam) {
        var label = (fam.id === 'UNKNOWN' ? 'UNIT' : fam.label.toUpperCase());
        modelEl.textContent = label + ' ' + (m.model || '');
      } else {
        modelEl.textContent = (m.model || '—');
      }
    }
    if (h1) h1.title = (fam ? fam.label : '') + ' ' + (m.model || '');

    // [POIN 4] Nomor Lambung pada header (lookup dari Database Unit).
    // REVISI: header menampilkan NOMOR LAMBUNG sebagai identitas utama,
    // bukan SN. Bila Lambung belum tersedia (Database Unit belum dimuat),
    // tampilkan pesan agar pengguna mengunggah database — SN tetap tersedia
    // di tooltip & bar unit aktif untuk rujukan teknis.
    var db = global.VHMS_UNITDB;
    var lb = (db && db.getLambung) ? db.getLambung(m.serial) : null;

    // Sembunyikan chip SN agar header fokus ke Nomor Lambung.
    var snEl = document.getElementById('machine-sn');
    if (snEl) snEl.style.display = 'none';

    var lbEl = document.getElementById('machine-lambung');
    if (lbEl) {
      if (lb) {
        lbEl.textContent = lb;
        lbEl.title = 'Nomor Lambung unit (SN: ' + (m.serial || '—') + ')';
        lbEl.style.borderColor = '#34d399';
        lbEl.style.color = '#34d399';
      } else {
        lbEl.textContent = 'Lambung belum tersedia';
        lbEl.title = 'Muat Database Unit (Nomor Lambung) di halaman Home. SN: ' + (m.serial || '—');
        lbEl.style.borderColor = '';
        lbEl.style.color = '';
      }
      lbEl.style.display = '';
    }

    // Bar unit aktif (dipakai di multi-unit view).
    // REVISI: tampilkan Nomor Lambung sebagai identitas utama; SN ditaruh
    // dalam tanda kurung sebagai rujukan teknis.
    var unitLabel = (m.model ? m.model + ' — ' : '');
    unitLabel += lb ? ('Lambung ' + lb) : ('SN ' + (m.serial || '—'));
    if (lb && m.serial) unitLabel += ' (SN ' + m.serial + ')';
    setText('unit-bar-serial', unitLabel);
    var ub = document.getElementById('unit-bar-badge');
    if (ub && analysis.health) {
      ub.textContent = analysis.health.label || '—';
      ub.className = 'badge ' + (analysis.health.label || 'NORMAL');
    }
    setText('header-file', analysis.sourceFile || '—');
    var hi = analysis.health || {};
    var el = document.getElementById('header-health');
    if (el) {
      el.textContent = hi.label || '—';
      el.className = 'v ' + (hi.label === 'CRITICAL' ? 'warn' : (hi.label === 'NORMAL' ? 'ok' : ''));
    }
    // [RUL] Tampilkan estimasi sisa jam di header
    var rulEl = document.getElementById('header-rul');
    if (rulEl && analysis.urgentRUL) {
      var u = analysis.urgentRUL;
      if (u.alreadyCritical) {
        rulEl.textContent = '0 jam';
        rulEl.className = 'v warn';
        rulEl.title = u.label + ' sudah melewati batas kritis';
      } else if (u.hours === Infinity || u.hours > 50000) {
        rulEl.textContent = 'Stabil';
        rulEl.className = 'v ok';
        rulEl.title = 'Tidak ada parameter yang diprediksi mencapai batas kritis';
      } else {
        rulEl.textContent = fmtInt(u.hours) + ' jam';
        rulEl.className = 'v ' + (u.hours <= 500 ? 'warn' : (u.hours <= 2000 ? '' : 'ok'));
        rulEl.title = u.label + ': estimasi ' + fmtInt(u.hours) + ' jam sebelum critical';
      }
    } else if (rulEl) {
      rulEl.textContent = '—';
      rulEl.className = 'v';
    }
  }

  /* -----------------------------------------------------------------------
   * [RESET HEADER] Kembalikan header ke kondisi DEFAULT saat pengguna
   * kembali ke halaman utama (katalog Home).
   * ---------------------------------------------------------------------
   * Saat masuk ke detail unit, renderHeader() mengubah judul (h1) menjadi
   * "<KELUARGA> <MODEL>" + chip keluarga/SN/Lambung + statistik unit.
   * Bila pengguna menekan "Kembali ke Home", header HARUS kembali ke
   * nama brand (Reliability Based Maintenance || OMS-SOS Lab) agar tidak
   * menyisakan identitas unit terakhir.
   * --------------------------------------------------------------------- */
  function resetHeader() {
    // [HEADER HOME] Ringkas header: sembunyikan chip identitas, subjudul
    // Engine, dan statistik unit (SMR/Health/RUL) — fokus ke nama perusahaan.
    var header = document.querySelector('.app-header');
    if (header) header.classList.add('header-compact');

    // Judul h1: kembalikan ke nama perusahaan (brand). Sembunyikan span model.
    var h1 = document.querySelector('.header-title h1');
    var brandEl = document.getElementById('machine-brand');
    var modelEl = document.getElementById('machine-model');
    if (brandEl) brandEl.style.display = '';
    if (modelEl) { modelEl.style.display = 'none'; modelEl.textContent = 'HEALTH'; }
    if (h1) h1.title = '';

    // Chip identitas: sembunyikan keluarga & lambung, tampilkan netral pada SN.
    var famEl = document.getElementById('machine-family');
    if (famEl) { famEl.textContent = '—'; famEl.style.display = 'none'; famEl.style.borderColor = ''; famEl.style.color = ''; }
    var lbEl = document.getElementById('machine-lambung');
    if (lbEl) { lbEl.textContent = 'Lambung: —'; lbEl.style.display = 'none'; lbEl.style.borderColor = ''; lbEl.style.color = ''; }
    var snEl = document.getElementById('machine-sn');
    if (snEl) { snEl.textContent = 'SN: —'; snEl.style.display = ''; snEl.style.borderColor = ''; snEl.style.color = ''; }

    // Subjudul & statistik header.
    // [REVISI #8] Pulihkan tampilan subjudul (bisa disembunyikan oleh mode SOS).
    var engEl2 = document.getElementById('machine-engine');
    if (engEl2) {
      var engWrap2 = engEl2.closest ? engEl2.closest('.header-sub') : null;
      if (engWrap2) engWrap2.style.display = '';
      engEl2.style.display = '';
    }
    setText('machine-engine', 'Engine: —');
    // Kembalikan label statistik ke istilah VHMS (mode SOS memakai elemen sama).
    setText('header-smr-label', 'Service Meter Reading');
    setText('header-health-label', 'Health Index');
    setText('header-rul-label', 'Sisa Operasi (RUL)');
    setText('header-smr', '—');
    setText('header-time', '—');
    var hi = document.getElementById('header-health');
    if (hi) { hi.textContent = '—'; hi.className = 'v'; hi.title = ''; }
    var rulEl = document.getElementById('header-rul');
    if (rulEl) { rulEl.textContent = '—'; rulEl.className = 'v mono'; rulEl.title = ''; }
    var wrap = document.getElementById('header-time-wrap');
    if (wrap) wrap.style.display = 'none';

    // Bar unit aktif juga direset agar konsisten jika kembali ke katalog.
    setText('unit-bar-serial', '—');
    var ub = document.getElementById('unit-bar-badge');
    if (ub) { ub.textContent = '—'; ub.className = 'badge'; }
    setText('header-file', '—');
  }

  function setText(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  /* -----------------------------------------------------------------------
   * Kartu KPI 6 kompartemen
   * --------------------------------------------------------------------- */
  function renderKpi(analysis) {
    var container = document.getElementById('kpi-grid');
    if (!container) return;
    var summary = analysis.summary;
    var html = '';

    // [RULE DATA] Nilai KPI dihitung dari window FORMULA (bukan seluruh data).
    var fw = analysis.formulaWindow || {};
    var winTag = (fw.hours > 0 && !fw.full)
      ? '<span class="kpi-window-tag" title="Nilai dihitung dari ' + fmtInt(fw.hours) + ' jam SMR terakhir (rumus/event)">' +
        '<i class="fa-solid fa-clock-rotate-left"></i> ' + fmtInt(fw.hours) + 'j</span>'
      : (fw.hours > 0
        ? '<span class="kpi-window-tag" title="Rentang data <= ' + fmtInt(fw.hours) + ' jam, memakai seluruh data">' +
          '<i class="fa-solid fa-clock-rotate-left"></i> semua</span>'
        : '');

    // [POIN 1] Pakai kompartemen dari profil keluarga produk (bila ada),
    // lalu saring kompartemen yang parameter utamanya benar-benar ada.
    var comps = compartmentListFor(analysis);

    comps.forEach(function (comp) {
      var pk = comp.primary;
      var val = summary[pk] ? summary[pk].max : null;
      var disp = displayValue(pk, val);
      var status = evaluateStatus(analysis, pk, val);
      var note = buildNote(comp.id, summary);

      html += '' +
        '<div class="kpi-card accent-' + comp.accent + '" data-comp-id="' + esc(comp.id) + '">' +
          '<div class="glow"></div>' +
          '<div class="kpi-head">' +
            '<p class="kpi-title">' + comp.title + '</p>' +
            '<span class="badge ' + status + '">' + status + '</span>' +
          '</div>' +
          '<p class="kpi-label"><i class="fa-solid ' + comp.icon + ' kpi-icon"></i> ' + paramMeta(pk).label + '</p>' +
          '<div class="kpi-value">' +
            '<span class="num">' + disp.text + '</span>' +
            '<span class="unit">' + disp.unit + '</span>' +
          '</div>' +
          '<p class="kpi-note">' + winTag + note + '</p>' +
          '<div class="kpi-foot">' +
            '<span>' + comp.footLeft.label + ': <strong>' + footValue(comp.footLeft.param, summary) + '</strong></span>' +
            '<span>' + comp.footRight.label + ': <strong>' + footValue(comp.footRight.param, summary) + '</strong></span>' +
          '</div>' +
        '</div>';
    });

    container.innerHTML = html;
  }

  function footValue(key, summary) {
    if (!summary[key]) return '—';
    var meta = paramMeta(key);
    return fmt(summary[key].max, meta.decimals) + (meta.unit ? ' ' + meta.unit : '');
  }

  /**
   * [POIN 1] Daftar kompartemen KPI untuk sebuah unit.
   * Sumber: profil keluarga produk (bila ada) -> fallback cfg.COMPARTMENTS.
   * Kompartemen yang parameter UTAMA-nya tidak punya data tetap ditampilkan
   * namun dengan nilai "—" (agar layout konsisten), KECUALI seluruh kompartemen
   * benar-benar tidak relevan.
   */
  function compartmentListFor(analysis) {
    var list = cfg.COMPARTMENTS;
    if (global.VHMS_PROFILES && analysis && analysis.familyId) {
      var p = global.VHMS_PROFILES.PROFILES[analysis.familyId];
      if (p && p.compartments && p.compartments.length) list = p.compartments;
    }
    // Saring: buang kompartemen yang SEMUA parameternya (primary + foot) kosong
    var summary = (analysis && analysis.summary) || {};
    function hasAny(key) {
      var s = summary[key];
      return !!(s && (s.max !== null || s.min !== null || s.avg !== null));
    }
    var filtered = list.filter(function (c) {
      return hasAny(c.primary) ||
        (c.footLeft && hasAny(c.footLeft.param)) ||
        (c.footRight && hasAny(c.footRight.param));
    });
    return filtered.length ? filtered : list;
  }

  function evaluateStatus(analysis, key, value) {
    var th = (analysis && analysis.thresholdSet) || null;
    var st = global.VHMS_ANALYTICS.evaluateParam(key, value, th);
    return st || 'NORMAL';
  }

  function buildNote(compId, summary) {
    switch (compId) {
      case 'engine': {
        var b = summary.blowbyMax;
        if (!b || b.max === null) return 'Data tidak tersedia';
        return b.max > 10
          ? '<i class="fa-solid fa-arrow-trend-up"></i> Lonjakan abnormal &mdash; risiko keausan ring/liner'
          : '<i class="fa-solid fa-circle-check"></i> Dalam batas normal (&lt;10 kPa)';
      }
      case 'hydraulic': {
        var h = summary.hydTempMax;
        if (!h || h.max === null) return 'Data tidak tersedia';
        return h.max > 95
          ? '<i class="fa-solid fa-temperature-high"></i> Puncak termal tinggi terdeteksi'
          : '<i class="fa-solid fa-circle-check"></i> Suhu oli dalam batas aman';
      }
      case 'cooling': {
        var c = summary.coolantTemp;
        if (!c || c.max === null) return 'Data tidak tersedia';
        return c.max > 95
          ? '<i class="fa-solid fa-triangle-exclamation"></i> Perlu cek sistem pendingin'
          : '<i class="fa-solid fa-circle-check"></i> Sistem pendingin stabil';
      }
      case 'fanpto': {
        return '<i class="fa-solid fa-fan"></i> Pompa fan &amp; PTO beroperasi';
      }
      case 'greasing': {
        return '<i class="fa-solid fa-droplet"></i> Pelumasan otomatis aktif';
      }
      case 'productivity': {
        var p = summary.engPowerAve;
        if (!p || p.avg === null) return 'Data tidak tersedia';
        return 'Rata-rata daya: <strong>' + fmt(p.avg, 0) + ' kW</strong>';
      }
      default: return '';
    }
  }

  /* -----------------------------------------------------------------------
   * Banner alert global (klikable -> membuka modal rekomendasi diagnostik)
   * --------------------------------------------------------------------- */
  function renderBanner(analysis) {
    var banner = document.getElementById('alert-banner');
    if (!banner) return;
    // Simpan unit aktif agar modal tahu data mana yang ditampilkan.
    activeAnalysis = analysis;

    var crit = analysis.anomalies.filter(function (a) { return a.status === 'CRITICAL'; });
    var warn = analysis.anomalies.filter(function (a) { return a.status === 'WARNING'; });

    function cta(label) {
      return '<span class="banner-cta"><i class="fa-solid fa-helmet-safety"></i> ' + label +
             ' <i class="fa-solid fa-arrow-right" style="font-size:9px"></i></span>';
    }

    if (crit.length > 0) {
      var a = crit[0];
      banner.className = 'alert-banner clickable';
      banner.setAttribute('role', 'button');
      banner.setAttribute('tabindex', '0');
      banner.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<span class="alert-tag">Critical Alert</span>' +
          '<p><strong style="color:#fff">' + esc(a.title) + '!</strong> Nilai ekstrem mencapai ' +
          '<span class="mono" style="color:#fca5a5;font-weight:700">' + fmt(a.value, paramMeta(a.param).decimals) + ' ' + a.unit + '</span> ' +
          '(batas kritis: ' + fmt(a.crit, paramMeta(a.param).decimals) + ' ' + a.unit + ')' +
          (crit.length > 1 ? ' &mdash; <strong>+' + (crit.length - 1) + ' anomali kritis lainnya</strong>' : '') + '.</p>' +
        '</div>' + cta('Lihat Rekomendasi Diagnostik');
    } else if (warn.length > 0) {
      banner.className = 'alert-banner clickable';
      banner.setAttribute('role', 'button');
      banner.setAttribute('tabindex', '0');
      banner.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<span class="alert-tag">Perhatian</span>' +
          '<p><strong style="color:#fff">' + warn.length + ' parameter</strong> berada di zona peringatan dan perlu dipantau.</p>' +
        '</div>' + cta('Lihat Detail &amp; Rekomendasi');
    } else {
      banner.className = 'alert-banner ok';
      banner.removeAttribute('role');
      banner.removeAttribute('tabindex');
      banner.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<span class="alert-tag">Semua Normal</span>' +
          '<p>Tidak ada parameter yang melewati ambang batas pada dataset ini.</p>' +
        '</div>';
    }
  }

  /* -----------------------------------------------------------------------
   * Modal rekomendasi diagnostik
   * --------------------------------------------------------------------- */
  function openAnomalyModal() {
    var modal = document.getElementById('anomaly-modal');
    if (!modal || !activeAnalysis) return;
    var list = document.getElementById('anomaly-modal-list');
    var sub = document.getElementById('anomaly-modal-sub');
    var m = activeAnalysis.meta || {};
    var anomalies = activeAnalysis.anomalies || [];
    var crit = anomalies.filter(function (a) { return a.status === 'CRITICAL'; }).length;
    var warn = anomalies.filter(function (a) { return a.status === 'WARNING'; }).length;

    if (sub) {
      sub.innerHTML = esc((m.model || '') + ' #' + (m.serial || '—')) +
        ' &middot; <strong style="color:#f87171">' + crit + ' kritis</strong>' +
        ' &middot; <strong style="color:#fbbf24">' + warn + ' peringatan</strong>' +
        ' &middot; total ' + anomalies.length + ' anomali';
    }
    if (list) {
      list.innerHTML = anomalies.length
        ? buildAnomalyCards(activeAnalysis)
        : '<div class="empty-state" style="padding:30px"><div class="icon" style="font-size:32px"><i class="fa-solid fa-circle-check"></i></div>' +
          '<p style="font-size:12px">Tidak ada anomali terdeteksi pada unit ini.</p></div>';
    }
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    var closeBtn = document.getElementById('anomaly-modal-close');
    if (closeBtn) closeBtn.focus();
  }

  function closeAnomalyModal() {
    var modal = document.getElementById('anomaly-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  function isAnomalyModalOpen() {
    var modal = document.getElementById('anomaly-modal');
    return !!(modal && !modal.classList.contains('hidden'));
  }

  /* -----------------------------------------------------------------------
   * Panel AI / daftar anomali
   * --------------------------------------------------------------------- */
  /* -----------------------------------------------------------------------
   * Kartu anomali (reusable: dipakai panel AI dan modal rekomendasi)
   * --------------------------------------------------------------------- */
  function buildAnomalyCard(a) {
    var KB = global.VHMS_KNOWLEDGE;
    var s = a.calendar && a.calendar.display ? a.calendar.display : (a.smr !== null ? 'SMR ' + fmtInt(a.smr) : '');
    var trendTxt = '';
    var trendDir = null;
    if (a.slope !== null && a.slope !== undefined && Math.abs(a.slope) > 1e-6) {
      var arah = a.slope > 0 ? 'meningkat' : 'menurun';
      trendDir = a.slope > 0 ? 'up' : 'down';
      var sign = a.slope > 0 ? '+' : (a.slope < 0 ? '\u2212' : '');
      trendTxt = ' Tren ' + arah + ' (' + sign + fmtRate(Math.abs(a.slope)) + ' per jam).';
    }

    // [POIN 2] Rekomendasi dari basis pengetahuan OFFLINE (kontekstual)
    var rec = KB ? KB.recommend(a, { trend: trendDir }) : null;
    var actions = rec ? rec.actions : (a.actions || []);
    var likely = rec ? rec.likely : [];

    var likelyBox = likely.length
      ? '<div class="likely-box"><p class="h"><i class="fa-solid fa-magnifying-glass-chart"></i> Kemungkinan Penyebab</p>' +
        '<ul>' + likely.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>'
      : '';

    var refsBox = (rec && rec.refs && rec.refs.length)
      ? '<div class="refs-box"><i class="fa-solid fa-book"></i> <span>Rujukan: ' +
        rec.refs.map(function (r) { return esc(r); }).join(' &middot; ') + '</span></div>'
      : '';

    var escBox = (rec && rec.escalate)
      ? '<div class="escalate-box"><i class="fa-solid fa-tower-broadcast"></i> ' + esc(rec.escalate) + '</div>'
      : '';

    // [RUL] Estimasi sisa jam operasi hingga critical
    var rulBox = '';
    if (a.rul) {
      var r = a.rul;
      if (r.alreadyCritical) {
        rulBox = '<div class="rul-box rul-critical"><i class="fa-solid fa-skull-crossbones"></i> ' +
          '<strong>Sudah melewati batas kritis</strong> — tindakan segera diperlukan</div>';
      } else if (r.hours === Infinity || r.hours > 50000) {
        rulBox = '<div class="rul-box rul-safe"><i class="fa-solid fa-circle-check"></i> ' +
          'Tren stabil/membaik — tidak diprediksi mencapai batas kritis</div>';
      } else {
        var urgency = r.hours <= 500 ? 'rul-critical' : (r.hours <= 2000 ? 'rul-warning' : 'rul-normal');
        var confTag = r.confident ? '' : ' <span class="rul-conf">(estimasi kasar)</span>';
        rulBox = '<div class="rul-box ' + urgency + '">' +
          '<i class="fa-solid fa-hourglass-half"></i> ' +
          'Estimasi <strong>' + fmtInt(r.hours) + ' jam</strong> sebelum mencapai batas kritis' + confTag +
          '</div>';
      }
    }

    return '' +
      '<div class="anomaly-card ' + a.status + '">' +
        '<div class="anomaly-head">' +
          '<span class="anomaly-title"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(a.title) + '</span>' +
          '<span class="anomaly-src mono">' + esc(s) + '</span>' +
        '</div>' +
        '<p class="anomaly-body">' +
          'Nilai ekstrem <strong>' + fmt(a.value, paramMeta(a.param).decimals) + ' ' + a.unit + '</strong> ' +
          'terhadap batas ' + (a.status === 'CRITICAL' ? 'kritis' : 'peringatan') + ' ' +
          fmt(a.status === 'CRITICAL' ? a.crit : a.warn, paramMeta(a.param).decimals) + ' ' + a.unit + '.' +
          trendTxt +
        '</p>' +
        likelyBox +
        (actions.length ?
        '<div class="action-box">' +
          '<p class="h"><i class="fa-solid fa-wrench"></i> Rekomendasi Tindakan' +
            (rec && rec.fromKB ? ' <span class="kb-tag" title="Dari basis pengetahuan internal offline">KB Offline</span>' : '') +
          '</p>' +
          '<ul>' + actions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '</div>' : '') +
        escBox +
        rulBox +
        refsBox +
      '</div>';
  }

  /** Bangun HTML seluruh kartu anomali (limit opsional). */
  function buildAnomalyCards(analysis, limit) {
    var list = (analysis && analysis.anomalies) || [];
    var n = (limit && limit > 0) ? limit : list.length;
    return list.slice(0, n).map(buildAnomalyCard).join('');
  }

  function renderAnomalies(analysis) {
    var box = document.getElementById('anomaly-list');
    var okBox = document.getElementById('healthy-summary');
    if (!box) return;

    if (!analysis.anomalies.length) {
      box.innerHTML = '<div class="empty-state" style="padding:24px">' +
        '<div class="icon" style="font-size:32px"><i class="fa-solid fa-circle-check"></i></div>' +
        '<p style="font-size:12px">Tidak ada anomali terdeteksi.</p></div>';
      if (okBox) okBox.innerHTML = '';
      return;
    }

    box.innerHTML = buildAnomalyCards(analysis, 12);

    // Ringkasan sehat
    if (okBox) {
      // [POIN 1] Pakai threshold set milik unit (profil keluarga produk)
      var TH = analysis.thresholdSet || cfg.THRESHOLDS;
      var healthyParams = Object.keys(TH).filter(function (k) {
        var s = analysis.summary[k];
        if (!s) return false;
        var ex = TH[k].mode === 'low' ? s.min : s.max;
        return global.VHMS_ANALYTICS.evaluateParam(k, ex, TH) === 'NORMAL';
      });
      var total = Object.keys(TH).length;
      var badCount = analysis.anomalies.length;
      if (badCount === 0) {
        okBox.innerHTML = '<div class="summary-line ok"><span><i class="fa-solid fa-circle-check"></i> Seluruh parameter status normal</span><span>' + total + '/' + total + '</span></div>';
      } else {
        okBox.innerHTML = '<div class="summary-line ok"><span><i class="fa-solid fa-circle-check"></i> ' + healthyParams.length + ' parameter dalam kondisi sehat</span><span>' + healthyParams.length + '/' + total + '</span></div>';
      }
    }
  }

  /* -----------------------------------------------------------------------
   * Panel efisiensi (power & fuel)
   * --------------------------------------------------------------------- */
  function renderEfficiency(analysis) {
    var box = document.getElementById('efficiency-panel');
    if (!box) return;
    var s = analysis.summary;

    // Asumsi rating maksimum PC2000-8
    var MAX_POWER = 760;
    var FUEL_TARGET = 165;

    var pAvg = s.engPowerAve ? s.engPowerAve.avg : null;
    var pMax = s.engPowerMax ? s.engPowerMax.max : null;
    var fuelAvg = s.fuelRate ? s.fuelRate.avg : null;

    var pPct = pAvg !== null ? Math.min(100, (pAvg / MAX_POWER) * 100) : 0;
    var fuelPct = fuelAvg !== null ? Math.min(100, (fuelAvg / FUEL_TARGET) * 100) : 0;
    var fuelOk = fuelAvg !== null && fuelAvg <= FUEL_TARGET;

    box.innerHTML = '' +
      '<h2 class="panel-title"><i class="fa-solid fa-bolt" style="color:#fbbf24"></i> Status Tenaga &amp; Efisiensi Bahan Bakar</h2>' +
      '<div style="margin-top:14px">' +
        '<div class="progress-row">' +
          '<div class="top"><span>Utilisasi Daya Mesin (maks ' + MAX_POWER + ' kW)</span>' +
          '<span class="mono" style="color:#fbbf24">' + fmt(pAvg, 0) + ' kW (' + fmt(pPct, 1) + '%)</span></div>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + pPct + '%;background:#fbbf24"></div></div>' +
        '</div>' +
        '<div class="progress-row">' +
          '<div class="top"><span>Laju Konsumsi BBM vs Target ' + FUEL_TARGET + ' L/h</span>' +
          '<span class="mono" style="color:' + (fuelOk ? '#34d399' : '#f87171') + '">' + fmt(fuelAvg, 1) + ' L/h</span></div>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + fuelPct + '%;background:' + (fuelOk ? '#10b981' : '#ef4444') + '"></div></div>' +
        '</div>' +
        '<div class="two-col" style="margin-top:14px">' +
          '<div><p class="kpi-label">Puncak Daya Tercatat</p><p class="mono" style="font-size:15px;font-weight:700;color:#22c55e">' + fmt(pMax, 0) + ' kW</p></div>' +
          '<div><p class="kpi-label">Rata-rata BBM</p><p class="mono" style="font-size:15px;font-weight:700;color:#f87171">' + fmt(fuelAvg, 1) + ' L/h</p></div>' +
        '</div>' +
      '</div>';
  }

  /* -----------------------------------------------------------------------
   * Kartu identitas mesin (tab Overview)
   * --------------------------------------------------------------------- */
  function renderIdentity(analysis) {
    var box = document.getElementById('identity-panel');
    if (!box) return;
    var m = analysis.meta || {};
    var s = analysis.summary;

    var rows = [
      ['Product Group', m.productGroup || '—'],
      ['Machine Model', m.model || '—'],
      ['Serial Number', m.serial || '—'],
      ['Nomor Lambung', (function () {
        var db = global.VHMS_UNITDB;
        var lb = (db && db.getLambung) ? db.getLambung(m.serial) : null;
        return lb || '— (belum dipetakan)';
      })()],
      ['Engine Model', m.engineModel || '—'],
      ['Program Version', m.programVer || '—'],
      ['Jumlah Record', fmtInt(analysis.records.length) + ' titik'],
      ['Rentang SMR', fmt(smrKey(analysis, 'min'), 1) + ' – ' + fmt(smrKey(analysis, 'max'), 1) + ' h'],
      ['SMR Terakhir', fmt(analysis.smrRange.last, 1) + ' h'],
      ['Health Index', (analysis.health.score) + ' / 100'],
      ['Record Normal', analysis.health.normal + ' / ' + analysis.health.total]
    ];

    box.innerHTML =
      '<h2 class="panel-title"><i class="fa-solid fa-circle-info" style="color:#0ea5e9"></i> Identitas Unit</h2>' +
      '<table class="kv-table" style="margin-top:12px"><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td class="mono">' + esc(r[1]) + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  function smrKey(analysis, which) {
    return analysis.smrRange[which];
  }

  /* -----------------------------------------------------------------------
   * Ringkasan status (tab Overview)
   * --------------------------------------------------------------------- */
  function renderStatusSummary(analysis) {
    var box = document.getElementById('status-panel');
    if (!box) return;
    var h = analysis.health;
    var total = h.total || 1;
    var pctN = (h.normal / total) * 100;
    var pctW = (h.warning / total) * 100;
    var pctC = (h.critical / total) * 100;

    box.innerHTML =
      '<h2 class="panel-title"><i class="fa-solid fa-heart-pulse" style="color:#ef4444"></i> Distribusi Kondisi</h2>' +
      '<div style="margin-top:14px">' +
        statusBar('Normal', h.normal, pctN, '#10b981') +
        statusBar('Warning', h.warning, pctW, '#f59e0b') +
        statusBar('Critical', h.critical, pctC, '#ef4444') +
      '</div>' +
      '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #1e293b" class="summary-line ' +
        (h.label === 'CRITICAL' ? 'bad' : 'ok') + '">' +
        '<span><i class="fa-solid fa-gauge-high"></i> Health Index</span>' +
        '<strong class="mono">' + h.score + ' / 100 — ' + h.label + '</strong>' +
      '</div>';
  }

  function statusBar(label, count, pct, color) {
    return '<div class="progress-row">' +
      '<div class="top"><span>' + label + '</span><span class="mono">' + count + ' (' + fmt(pct, 1) + '%)</span></div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
  }

  /* -----------------------------------------------------------------------
   * Panel korelasi antar parameter
   * --------------------------------------------------------------------- */
  function renderCorrelations(analysis) {
    var box = document.getElementById('correlation-panel');
    if (!box) return;
    var corrs = analysis.correlations || [];
    if (!corrs.length) {
      box.innerHTML = '<h2 class="panel-title"><i class="fa-solid fa-link" style="color:#a78bfa"></i> Korelasi Antar Parameter</h2>' +
        '<p style="font-size:12px;color:#64748b;margin-top:10px">Tidak ditemukan korelasi kuat (|r| ≥ 0.6) antar parameter pada data ini.</p>';
      return;
    }
    var html = '<h2 class="panel-title"><i class="fa-solid fa-link" style="color:#a78bfa"></i> Korelasi Antar Parameter</h2>' +
      '<p style="font-size:11px;color:#64748b;margin:8px 0">Pasangan parameter yang bergerak bersamaan — membantu identifikasi masalah sistem terkait.</p>' +
      '<div class="corr-list">';
    corrs.slice(0, 8).forEach(function (c) {
      var absR = Math.abs(c.r);
      var barW = Math.round(absR * 100);
      var color = c.direction === 'positif' ? '#38bdf8' : '#f59e0b';
      var icon = c.direction === 'positif' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
      html += '<div class="corr-item">' +
        '<div class="corr-pair">' +
          '<span class="corr-param">' + esc(c.labelA) + '</span>' +
          '<i class="fa-solid fa-arrows-left-right" style="color:#475569;font-size:10px"></i>' +
          '<span class="corr-param">' + esc(c.labelB) + '</span>' +
        '</div>' +
        '<div class="corr-meta">' +
          '<span class="corr-r" style="color:' + color + '"><i class="fa-solid ' + icon + '"></i> r = ' + c.r + '</span>' +
          '<span class="corr-strength">' + c.strength + '</span>' +
          '<div class="corr-bar"><div class="corr-bar-fill" style="width:' + barW + '%;background:' + color + '"></div></div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    box.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * Panel timeline degradasi (Alert History)
   * --------------------------------------------------------------------- */
  function renderTimeline(analysis) {
    var box = document.getElementById('timeline-panel');
    if (!box) return;
    var tl = analysis.alertTimeline || [];
    if (!tl.length) {
      box.innerHTML = '<h2 class="panel-title"><i class="fa-solid fa-clock-rotate-left" style="color:#f59e0b"></i> Riwayat Degradasi</h2>' +
        '<p style="font-size:12px;color:#64748b;margin-top:10px">Tidak ada parameter yang pernah memasuki zona peringatan pada data ini.</p>';
      return;
    }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-clock-rotate-left" style="color:#f59e0b"></i> Riwayat Degradasi</h2>' +
      '<p style="font-size:11px;color:#64748b;margin:8px 0">Tracking: kapan parameter pertama kali memasuki zona Warning/Critical dan kecepatan degradasi.</p>' +
      '<div class="tl-list">';

    tl.forEach(function (t) {
      var warnSmr = t.firstWarn ? fmtInt(t.firstWarn.smr) + ' h' : '—';
      var critSmr = t.firstCrit ? fmtInt(t.firstCrit.smr) + ' h' : '—';
      var speedTag = '';
      if (t.speed) {
        var speedColor = t.speed === 'Cepat' ? '#f87171' : (t.speed === 'Sedang' ? '#fbbf24' : '#6ee7b7');
        speedTag = '<span class="tl-speed" style="color:' + speedColor + '"><i class="fa-solid fa-gauge-high"></i> ' + t.speed + '</span>';
      }

      html += '<div class="tl-item">' +
        '<div class="tl-header">' +
          '<span class="tl-label">' + esc(t.label) + '</span>' +
          speedTag +
        '</div>' +
        '<div class="tl-track">';

      // Normal marker
      if (t.lastNormal) {
        html += '<div class="tl-node tl-normal" title="Terakhir Normal @ SMR ' + fmtInt(t.lastNormal.smr) + '">' +
          '<span class="tl-dot bg-ok"></span><span class="tl-smr">Normal</span></div>';
        if (t.normalToWarnHours) {
          html += '<div class="tl-connector"><span class="tl-dur">' + fmtInt(t.normalToWarnHours) + ' jam</span></div>';
        }
      }

      // Warning marker
      if (t.firstWarn) {
        html += '<div class="tl-node tl-warn" title="Pertama Warning @ SMR ' + warnSmr + '">' +
          '<span class="tl-dot bg-warn"></span><span class="tl-smr">' + warnSmr + '</span></div>';
      }

      // Connector warn→crit
      if (t.warnToCritHours !== null) {
        html += '<div class="tl-connector"><span class="tl-dur">' + fmtInt(t.warnToCritHours) + ' jam</span></div>';
      }

      // Critical marker
      if (t.firstCrit) {
        html += '<div class="tl-node tl-crit" title="Pertama Critical @ SMR ' + critSmr + '">' +
          '<span class="tl-dot bg-crit"></span><span class="tl-smr">' + critSmr + '</span></div>';
      }

      html += '</div></div>';
    });

    html += '</div>';
    box.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
   * Chart  [POIN 3] — DINAMIS
   * ---------------------------------------------------------------------
   * Chart dibangun otomatis dari cfg.CHART_GROUPS, HANYA untuk grup yang
   * parameternya benar-benar ada di file (fleksibel lintas model).
   * Panel dibuat di DOM secara dinamis, lengkap dengan judul, legenda,
   * dan satuan standar Komatsu. Sumbu kiri/kanan dipisah otomatis bila
   * satuan seri berbeda.
   * --------------------------------------------------------------------- */
  function renderCharts(analysis) {
    // Bersihkan chart lama
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    });

    var container = document.getElementById('charts-dynamic');
    if (!container) {
      // Fallback: perilaku lama bila container dinamis tidak ada
      return renderChartsLegacy(analysis);
    }

    var groups = (cfg.chartGroupsFor ? cfg.chartGroupsFor(analysis.records) : cfg.CHART_GROUPS) || [];
    if (!groups.length) {
      container.innerHTML = '<div class="panel"><div class="empty-state" style="padding:30px">' +
        '<p style="font-size:12px">Tidak ada parameter yang bisa digrafikkan dari file ini.</p></div></div>';
      return;
    }

    // Bangun panel HTML. Jarak antar-panel diatur via CSS `#charts-dynamic`
    // (gap), sehingga panel PERTAMA rata atas dengan panel insight di kanan.
    var html = '';
    groups.forEach(function (g) {
      html += '' +
        '<div class="panel chart-panel" data-chart="' + esc(g.id) + '">' +
          '<div class="panel-head">' +
            '<div>' +
              '<h2 class="panel-title"><i class="fa-solid ' + esc(g.icon || 'fa-chart-line') + '" style="color:' + esc(g.accent || '#38bdf8') + '"></i> ' + esc(g.title) + '</h2>' +
              '<p class="panel-sub">' + esc(g.subtitle || '') + '</p>' +
            '</div>' +
            '<div class="legend" id="' + esc(g.id) + '-legend"></div>' +
          '</div>' +
          '<div class="chart-wrap"><canvas id="' + esc(g.id) + '"></canvas></div>' +
        '</div>';
    });
    container.innerHTML = html;

    // Gambar tiap chart
    groups.forEach(function (g) {
      var canvas = document.getElementById(g.id);
      if (!canvas) return;

      // Bangun data dari seri yang punya data + satuan standar
      var built = buildDynamicChartData(analysis, g);
      charts[g.id] = new Chart(canvas.getContext('2d'), {
        type: built.type,
        data: { labels: built.labels, datasets: built.datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 500 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(2,6,23,.95)',
              borderColor: '#334155',
              borderWidth: 1,
              titleFont: { size: 11 },
              bodyFont: { size: 11 },
              callbacks: {
                // [REVISI] Judul tooltip = TANGGAL (Waktu Rekam) + SMR.
                title: function (items) {
                  if (!items || !items.length) return '';
                  var i = items[0].dataIndex;
                  var d = (built.dates && built.dates[i]) ? built.dates[i] : '';
                  var l = (built.labels && built.labels[i]) ? built.labels[i] : '';
                  if (d && l) return d + '  •  SMR ' + l + ' jam';
                  return d || ('SMR ' + l + ' jam');
                },
                label: function (ctx) {
                  return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2);
                }
              }
            }
          },
          scales: built.scales
        }
      });

      // Legenda
      var lbox = document.getElementById(g.id + '-legend');
      if (lbox) {
        lbox.innerHTML = built.datasets.map(function (d) {
          var sw = d.type === 'bar'
            ? '<span class="swatch dot" style="background:' + d.borderColor + '"></span>'
            : '<span class="swatch" style="background:' + d.borderColor + '"></span>';
          return '<span>' + sw + esc(d.label) + '</span>';
        }).join('');
      }

      // [RULE DATA — TAMPILAN] Keterangan sumber data chart.
      // Default: chart menampilkan SELURUH data asli file (CHART_WINDOW_HOURS=0).
      var w = built.window;
      if (lbox) {
        if (w && w.windowHours > 0 && !w.full) {
          var badgeHtml = 'Window ' + fmtInt(w.windowHours) + ' jam terakhir'
            + ' &middot; SMR ' + fmtInt(w.smrCutoff) + '–' + fmtInt(w.smrMax) + ' h';
          lbox.innerHTML += '<span class="chart-window-note" title="Chart dipotong ke window jam">' +
            '<i class="fa-solid fa-clock-rotate-left"></i> ' + badgeHtml + '</span>';
        } else {
          lbox.innerHTML += '<span class="chart-window-note chart-full-note" title="Chart menampilkan seluruh data asli dari file">' +
            '<i class="fa-solid fa-database"></i> Seluruh data (' + fmtInt((analysis.records || []).length) + ' titik)</span>';
        }
      }
    });

    // Samakan tinggi panel insight dengan panel chart pertama (garis horisontal presisi)
    syncInsightHeight();
  }

  /**
   * Selaraskan tinggi panel "Predictive Diagnostic AI" dengan panel chart
   * pertama pada kolom kiri, supaya garis horisontalnya presisi. Diukur ulang
   * setelah render & saat ukuran jendela berubah. Aman bila elemen tak ada.
   */
  function syncInsightHeight() {
    var ai = document.querySelector('#insights-section > .panel-fill');
    var chartPanel = document.querySelector('#charts-dynamic .chart-panel');
    if (!ai) return;
    // Reset dulu agar pengukuran tidak terpengaruh nilai lama.
    ai.style.height = '';
    ai.style.minHeight = '';
    if (!chartPanel) return;
    var h = chartPanel.getBoundingClientRect().height;
    if (h > 0) ai.style.height = Math.round(h) + 'px';
  }

  // Jaga keselarasan saat ukuran jendela berubah (debounce sederhana).
  if (typeof window !== 'undefined') {
    var _syncTimer = null;
    window.addEventListener('resize', function () {
      if (_syncTimer) clearTimeout(_syncTimer);
      _syncTimer = setTimeout(syncInsightHeight, 150);
    });
  }

  /**
   * Susun dataset + skala (sumbu kiri/kanan) untuk sebuah grup dinamis.
   * Satuan diambil dari file (Axis Scale) bila ada, jika tidak dari config.
   */
  function buildDynamicChartData(analysis, group) {
    // [RULE DATA — TAMPILAN] Chart menampilkan SELURUH data asli dari file
    // (tanpa pemotongan window). CHART_WINDOW_HOURS = 0 berarti nonaktif; bila
    // suatu saat diisi > 0, chart akan dipotong ke window tersebut.
    var winHours = (cfg.CHART_WINDOW_HOURS || 0);
    var win = (winHours > 0 && global.VHMS_RANKING && global.VHMS_RANKING.sliceWindow)
      ? global.VHMS_RANKING.sliceWindow(analysis.records || [], winHours)
      : { records: analysis.records || [], windowHours: 0, smrMax: null, smrCutoff: null, full: true };
    var records = win.records;

    var labels = records.map(function (r) {
      return r.smr !== null ? fmtInt(r.smr) : '-';
    });
    // [REVISI] Tanggal (Waktu Rekam) per titik — dipakai tooltip chart agar
    // pengguna tahu KAPAN kejadian telemetri itu (bukan hanya SMR-nya).
    var dates = records.map(function (r) {
      return (r.calendar && r.calendar.display) ? r.calendar.display : '';
    });

    // Tentukan satuan tiap seri, lalu petakan ke sumbu kiri/kanan.
    // Seri tanpa deklarasi axis: kiri bila satuannya sama dgn seri pertama,
    // selain itu kanan.
    var unitsByAxis = { left: null, right: null };
    var datasets = [];
    var leftTitle = '', rightTitle = '';

    group.series.forEach(function (s) {
      var meta = paramMeta(s.param);
      // [SATUAN TAMPILAN] Utamakan satuan BAKU dari config (meta.unit), karena
      // sebagian parameter DIKONVERSI saat tampil (mis. Boost kPa->mmHg).
      // Satuan file (Axis Scale) hanya dipakai bila config tak punya satuan.
      var unit = meta.unit || ((global.VHMS_PARSER && global.VHMS_PARSER.getColumnUnit)
        ? (global.VHMS_PARSER.getColumnUnit({ records: records }, s.param) || '')
        : '');

      // Tentukan sumbu: hormati s.axis; bila bentrok satuan, pindah ke kanan
      var axis = s.axis || 'left';
      if (axis === 'left' && unitsByAxis.left && unit && unit !== unitsByAxis.left && !s.type_bar) {
        axis = 'right';
      }
      if (!unitsByAxis[axis]) unitsByAxis[axis] = unit;
      if (axis === 'left' && !leftTitle) leftTitle = unit;
      if (axis === 'right' && !rightTitle) rightTitle = unit;

      var data = records.map(function (r) { return r[s.param]; });
      datasets.push({
        param: s.param,
        axisId: axis === 'right' ? 'y1' : 'y',
        label: (s.label || meta.label || s.param) + (unit ? ' (' + unit + ')' : ''),
        data: data,
        type: s.type || 'line',
        borderColor: s.color,
        backgroundColor: s.type === 'bar' ? s.color : (s.fill ? toRgba(s.color, 0.12) : s.color),
        borderWidth: s.width || 2,
        pointRadius: s.type === 'bar' ? 0 : 3,
        pointHoverRadius: 6,
        tension: 0.25,
        fill: !!s.fill,
        spanGaps: true,
        borderDash: s.dashed ? [5, 4] : undefined
      });
    });

    var hasRight = datasets.some(function (d) { return d.axisId === 'y1'; });

    var scales = {
      x: {
        grid: { color: 'rgba(30,41,59,.8)' },
        ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        title: { display: true, text: 'SMR (jam)', color: '#64748b', font: { size: 11 } }
      },
      y: {
        position: 'left',
        grid: { color: 'rgba(30,41,59,.8)' },
        ticks: { color: '#38bdf8', font: { size: 10 } },
        title: { display: true, text: leftTitle, color: '#38bdf8', font: { size: 11 } }
      }
    };
    if (hasRight) {
      scales.y1 = {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#f59e0b', font: { size: 10 } },
        title: { display: true, text: rightTitle, color: '#f59e0b', font: { size: 11 } }
      };
    }

    return {
      labels: labels,
      dates: dates,
      datasets: datasets,
      type: 'line',
      scales: scales,
      window: win
    };
  }

  /** Versi lama (fallback) — chart statis dari cfg.CHARTS. */
  function renderChartsLegacy(analysis) {
    cfg.CHARTS.forEach(function (def) {
      var canvas = document.getElementById(def.id);
      if (!canvas) return;
      var data = global.VHMS_ANALYTICS.buildChartData(analysis, def);

      var scales = {
        x: {
          grid: { color: 'rgba(30,41,59,.8)' },
          ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          title: { display: true, text: 'SMR (jam)', color: '#64748b', font: { size: 11 } }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(30,41,59,.8)' },
          ticks: { color: '#38bdf8', font: { size: 10 } },
          title: { display: true, text: data.axisTitles.left || '', color: '#38bdf8', font: { size: 11 } }
        }
      };
      if (data.meta.hasRightAxis) {
        scales.y1 = {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#f59e0b', font: { size: 10 } },
          title: { display: true, text: data.axisTitles.right || '', color: '#f59e0b', font: { size: 11 } }
        };
      }

      charts[def.id] = new Chart(canvas.getContext('2d'), {
        type: data.type,
        data: { labels: data.labels, datasets: data.datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 500 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(2,6,23,.95)',
              borderColor: '#334155',
              borderWidth: 1,
              titleFont: { size: 11 },
              bodyFont: { size: 11 },
              callbacks: {
                // [REVISI] Judul tooltip = TANGGAL (Waktu Rekam) + SMR.
                title: function (items) {
                  if (!items || !items.length) return '';
                  var i = items[0].dataIndex;
                  var d = (data.dates && data.dates[i]) ? data.dates[i] : '';
                  var l = (data.labels && data.labels[i]) ? data.labels[i] : '';
                  if (d && l) return d + '  •  SMR ' + l + ' jam';
                  return d || ('SMR ' + l + ' jam');
                },
                label: function (ctx) {
                  return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2);
                }
              }
            }
          },
          scales: scales
        }
      });
    });
  }

  /* -----------------------------------------------------------------------
   * Legenda (fallback lama; versi dinamis sudah menangani legendanya sendiri)
   * --------------------------------------------------------------------- */
  function renderLegends(analysis) {
    if (document.getElementById('charts-dynamic')) return; // ditangani renderCharts
    cfg.CHARTS.forEach(function (def) {
      var box = document.getElementById(def.id + '-legend');
      if (!box) return;
      box.innerHTML = def.series.map(function (s) {
        var meta = paramMeta(s.param);
        var isBar = s.type === 'bar';
        var sw = isBar
          ? '<span class="swatch dot" style="background:' + s.color + '"></span>'
          : '<span class="swatch" style="background:' + s.color + '"></span>';
        return '<span>' + sw + (s.label || meta.label) + ' (' + meta.unit + ')</span>';
      }).join('');
    });
  }

  /* -----------------------------------------------------------------------
   * Tabel log telemetri
   * --------------------------------------------------------------------- */
  var tableState = { search: '', filter: 'ALL', sortKey: 'smr', sortDir: 'desc' };
  // [D375A] Kolom tabel AKTIF untuk unit yang sedang ditampilkan. Dipilih sesuai
  // keluarga produk (mis. DOZER memakai daftar kolom khusus) & disaring agar
  // hanya kolom yang benar-benar ada datanya. Diisi di renderTable().
  var activeTableColumns = null;

  function currentTableColumns(analysis) {
    if (activeTableColumns) return activeTableColumns;
    var fam = analysis && analysis.familyId;
    if (cfg.tableColumnsFor) activeTableColumns = cfg.tableColumnsFor(fam, analysis && analysis.records);
    else activeTableColumns = cfg.TABLE_COLUMNS;
    return activeTableColumns;
  }

  function renderTable(analysis) {
    var tbody = document.getElementById('table-body');
    if (!tbody) return;

    var cols = currentTableColumns(analysis);
    var rows = analysis.records.slice();

    // Filter status
    if (tableState.filter !== 'ALL') {
      rows = rows.filter(function (r) { return r.status === tableState.filter; });
    }

    // Pencarian (SMR / tanggal)
    var q = tableState.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        var smr = r.smr !== null ? String(r.smr) : '';
        var dt = r.calendar ? r.calendar.display.toLowerCase() : '';
        return smr.indexOf(q) !== -1 || dt.indexOf(q) !== -1 || r.status.toLowerCase().indexOf(q) !== -1;
      });
    }

    // Urutkan
    var key = tableState.sortKey, dir = tableState.sortDir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="' + (cols.length + 1) +
        '" class="center" style="padding:30px;color:#64748b">Tidak ada data yang cocok dengan filter.</td></tr>';
      updateTableCount(0, analysis.records.length);
      return;
    }

    // Batasi render maksimum agar UI tetap responsif pada dataset besar
    var MAX = 400;
    var limited = rows.slice(0, MAX);
    var html = '';

    limited.forEach(function (r) {
      html += '<tr class="row-' + r.status + '">';
      // Kolom tanggal
      html += '<td class="mono" style="color:#94a3b8">' +
        (r.calendar ? esc(r.calendar.display) : '—') + '</td>';
      cols.forEach(function (col) {
        if (col.isStatus) {
          html += '<td class="center"><span class="badge ' + r.status + '">' + r.status + '</span></td>';
          return;
        }
        var key = col.param;
        if (key === 'smr') {
          html += '<td class="mono ' + col.align + '" style="color:#fff;font-weight:600">' + fmtInt(r.smr) + '</td>';
          return;
        }
        var meta = paramMeta(key);
        var val = r[key];
        var cls = 'mono ' + (col.align || '');
        var style = '';
        if (col.colored && val !== null) {
          var st = global.VHMS_ANALYTICS.evaluateParam(key, val);
          if (st === 'CRITICAL') style = 'color:#f87171;font-weight:700';
          else if (st === 'WARNING') style = 'color:#fbbf24;font-weight:700';
          else style = 'color:#34d399';
        }
        html += '<td class="' + cls + '" style="' + style + '">' + fmt(val, meta.decimals) + '</td>';
      });
      html += '</tr>';
    });

    tbody.innerHTML = html;
    updateTableCount(limited.length, analysis.records.length, rows.length);
  }

  function updateTableCount(shown, total, filtered) {
    var el = document.getElementById('table-count');
    if (!el) return;
    if (filtered === undefined) {
      el.textContent = 'Menampilkan ' + shown + ' dari ' + total + ' record';
    } else {
      el.textContent = 'Menampilkan ' + shown + ' dari ' + filtered + ' record terfilter (total ' + total + ')';
    }
  }

  function setTableState(patch) {
    Object.keys(patch).forEach(function (k) { tableState[k] = patch[k]; });
  }

  /* -----------------------------------------------------------------------
   * Header tabel (dinamis dari konfigurasi)
   * --------------------------------------------------------------------- */
  function renderTableHeader() {
    var thead = document.getElementById('table-head');
    if (!thead) return;
    var cols = activeTableColumns || cfg.TABLE_COLUMNS;
    var th = '<tr><th>Waktu Rekam (WITA)</th>';
    cols.forEach(function (col) {
      var key = col.param;
      var label, unit;
      if (col.isStatus) { label = 'Status'; unit = ''; }
      else if (key === 'smr') { label = 'SMR'; unit = 'jam'; }
      else { var meta = paramMeta(key); label = meta.label; unit = meta.unit; }
      th += '<th class="' + (col.align || '') + '">' + esc(label) +
        (unit ? ' <span style="opacity:.6">(' + esc(unit) + ')</span>' : '') + '</th>';
    });
    th += '</tr>';
    thead.innerHTML = th;
  }

  /* -----------------------------------------------------------------------
   * Tampilkan seluruh dashboard
   * --------------------------------------------------------------------- */
  function renderAll(analysis) {
    renderHeader(analysis);
    renderBanner(analysis);
    renderKpi(analysis);
    renderCharts(analysis);
    renderLegends(analysis);
    renderAnomalies(analysis);
    renderEfficiency(analysis);
    renderIdentity(analysis);
    renderStatusSummary(analysis);
    renderCorrelations(analysis);
    renderTimeline(analysis);
    // [D375A] Pilih kolom tabel log sesuai keluarga produk SEBELUM render
    // header & body agar keduanya konsisten.
    activeTableColumns = cfg.tableColumnsFor
      ? cfg.tableColumnsFor(analysis.familyId, analysis.records)
      : cfg.TABLE_COLUMNS;
    renderTableHeader();
    renderTable(analysis);
    renderFooter(analysis);
    syncInsightHeight();
  }
  function renderFooter(analysis) {
    setText('footer-unit', 'Unit: ' + (analysis.meta.model || 'PC2000') + ' #' + (analysis.meta.serial || '—'));
    setText('footer-points', 'Data Points: ' + fmtInt(analysis.records.length) + ' record');
    setText('footer-range', 'SMR: ' + fmt(analysis.smrRange.min, 1) + ' – ' + fmt(analysis.smrRange.max, 1) + ' jam');
    setText('footer-file', analysis.sourceFile || '—');
    var wrap = document.getElementById('header-time-wrap');
    if (wrap) wrap.style.display = '';
  }

  /* -----------------------------------------------------------------------
   * HOME OVERVIEW — katalog unit
   * --------------------------------------------------------------------- */
  // [POIN 6] Default: urutkan berdasarkan SEVERITY (paling critical di atas,
  // paling normal di bawah). Unit dengan status lebih berat selalu di atas,
  // lalu di antara status yang sama diurutkan: Engine critical terbanyak,
  // skor criticality window tertinggi, jumlah anomali kritis, lalu health.
  var fleetState = { search: '', filter: 'ALL', sortKey: 'severity', sortDir: 'desc' };

  var HEALTH_ORDER = { 'CRITICAL': 0, 'WARNING': 1, 'NORMAL': 2 };
  // Bobot prioritas: makin BESAR makin diprioritaskan (tampil di atas).
  var SEVERITY_RANK = { 'CRITICAL': 3, 'WARNING': 2, 'NORMAL': 1 };

  /**
   * Ambil urutan health dengan aman. PENTING: HEALTH_ORDER['CRITICAL'] === 0
   * (falsy), jadi TIDAK boleh memakai `|| 2`. Label tak dikenal -> 2 (NORMAL).
   * Gunakan helper ini di SEMUA tempat agar bug falsy-zero tidak terulang.
   */
  function healthOrderOf(label) {
    var o = HEALTH_ORDER[label];
    return (o === undefined) ? 2 : o;
  }

  /**
   * Komparator prioritas katalog Home.
   * Urutan kunci (semua makin besar = makin diprioritaskan di atas):
   *   1) severity (CRITICAL > WARNING > NORMAL)
   *   2) engineCritical (jumlah anomali pilar Engine berstatus kritis)
   *   3) rankScore (skor criticality window 0-100)
   *   4) nCritThresholds (jumlah parameter melewati batas kritis)
   *   5) anomalyCount (total anomali)
   *   6) kebalikan healthScore (makin kecil health = makin atas)
   * @returns {number} negatif bila a lebih diprioritaskan (naik ke atas)
   */
  function compareSeverity(a, b) {
    var sa = SEVERITY_RANK[a.healthLabel] || 0;
    var sb = SEVERITY_RANK[b.healthLabel] || 0;
    if (sa !== sb) return sb - sa;
    var ea = a.engineCritical || 0, eb = b.engineCritical || 0;
    if (ea !== eb) return eb - ea;
    var ra = a.rankScore || 0, rb = b.rankScore || 0;
    if (ra !== rb) return rb - ra;
    var ca = a.nCritThresholds || 0, cb = b.nCritThresholds || 0;
    if (ca !== cb) return cb - ca;
    var aa = a.anomalyCount || 0, ab = b.anomalyCount || 0;
    if (aa !== ab) return ab - aa;
    var ha = a.healthScore === null || a.healthScore === undefined ? 999 : a.healthScore;
    var hb = b.healthScore === null || b.healthScore === undefined ? 999 : b.healthScore;
    return ha - hb;
  }

  /** Teks badge prioritas untuk kolom "Prioritas" katalog (P1 = paling critical). */
  function sevBadgeText(r) {
    var rank = SEVERITY_RANK[r.healthLabel] || 0;
    if (rank >= 3) return 'P1';
    if (rank === 2) return 'P2';
    return 'P3';
  }

  /** Tooltip menjelaskan urutan prioritas sebuah unit. */
  function sevTooltip(r) {
    return 'P1 = Critical (tindak segera), P2 = Warning (pantau), P3 = Normal. ' +
      'Status: ' + (r.healthLabel || '—') +
      ', Engine critical: ' + (r.engineCritical || 0) +
      ', Skor: ' + (r.rankScore === null || r.rankScore === undefined ? '—' : fmt(r.rankScore, 1));
  }

  function renderFleetHeader(stats) {
    setText('fleet-count', fmtInt(stats.count));
    setText('fleet-critical', fmtInt(stats.critical));
    setText('fleet-warning', fmtInt(stats.warning));
    setText('fleet-normal', fmtInt(stats.normal));
    setText('fleet-avg-health', stats.avgHealth === null ? '—' : fmt(stats.avgHealth, 1));
    setText('fleet-total-records', fmtInt(stats.totalRecords));

    // Kartu ringkasan status armada
    var box = document.getElementById('fleet-status-cards');
    if (box) {
      var total = stats.count || 1;
      box.innerHTML =
        fleetStatCard('Unit Dipantau', fmtInt(stats.count), 'fa-truck-monster', 'sky', '') +
        fleetStatCard('Critical', fmtInt(stats.critical), 'fa-triangle-exclamation', 'red',
          fmt((stats.critical / total) * 100, 0) + '% unit') +
        fleetStatCard('Warning', fmtInt(stats.warning), 'fa-circle-exclamation', 'amber',
          fmt((stats.warning / total) * 100, 0) + '% unit') +
        fleetStatCard('Normal', fmtInt(stats.normal), 'fa-circle-check', 'emerald',
          fmt((stats.normal / total) * 100, 0) + '% unit') +
        fleetStatCard('Rata-rata Health', stats.avgHealth === null ? '—' : fmt(stats.avgHealth, 1), 'fa-heart-pulse', 'violet', 'dari 100');
    }

    // Daftar model unit
    var modelBox = document.getElementById('fleet-models');
    if (modelBox) {
      var models = Object.keys(stats.byModel).sort();
      modelBox.innerHTML = models.length
        ? models.map(function (mm) {
            return '<span class="chip">' + esc(mm) + ' <strong style="color:#e2e8f0">' + stats.byModel[mm] + '</strong></span>';
          }).join('')
        : '<span class="chip">Belum ada data</span>';
    }
  }

  function fleetStatCard(label, value, icon, accent, sub) {
    return '' +
      '<div class="kpi-card accent-' + accent + '">' +
        '<div class="glow"></div>' +
        '<p class="kpi-title">' + esc(label) + '</p>' +
        '<div class="kpi-value"><span class="num">' + value + '</span></div>' +
        '<p class="kpi-note">' + (sub ? esc(sub) : '<i class="fa-solid ' + icon + '"></i>') + '</p>' +
      '</div>';
  }

  /* -----------------------------------------------------------------------
   * Tabel katalog Home (dioptimasi untuk 200+ baris)
   * --------------------------------------------------------------------- */
  function renderFleetTable() {
    var tbody = document.getElementById('fleet-table-body');
    if (!tbody) return;
    var store = global.VHMS_FLEET;
    var rows = store ? store.rows() : [];

    // [POIN 5] Perbarui indikator filter sebelum menyaring
    updateFleetFilterUI(store);

    // Filter
    if (fleetState.filter !== 'ALL') {
      rows = rows.filter(function (r) { return r.healthLabel === fleetState.filter; });
    }
    // Cari
    var q = fleetState.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return (r.serial + ' ' + r.model + ' ' + r.id + ' ' + r.sourceFile + ' ' + (r.engineModel || ''))
          .toLowerCase().indexOf(q) !== -1;
      });
    }
    // Urut
    var k = fleetState.sortKey, dir = fleetState.sortDir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va, vb;
      if (k === 'severity') {
        // Prioritas default: paling CRITICAL di atas, paling NORMAL di bawah.
        // Arah tetap (bukan dikali `dir`) agar konsisten worst→best.
        return compareSeverity(a, b);
      } else if (k === 'rankScore') {
        // Skor criticality window; bila seri, tetap hormati urutan severity.
        va = (a.rankScore || 0); vb = (b.rankScore || 0);
        if (va !== vb) return (vb - va);
        return compareSeverity(a, b);
      } else if (k === 'engineCritical') {
        va = -(a.engineCritical || 0) * 1e6 + healthOrderOf(a.healthLabel) * 1e3 - (a.rankScore || 0);
        vb = -(b.engineCritical || 0) * 1e6 + healthOrderOf(b.healthLabel) * 1e3 - (b.rankScore || 0);
        return va - vb;
      } else if (k === 'healthScore') {
        va = healthOrderOf(a.healthLabel) * 1000 + (a.healthScore || 0);
        vb = healthOrderOf(b.healthLabel) * 1000 + (b.healthScore || 0);
      } else if (k === 'serial' || k === 'model' || k === 'lambung') {
        va = a[k] || ''; vb = b[k] || '';
        return String(va).localeCompare(String(vb)) * dir;
      } else if (k === 'blowbyMax') {
        va = a.kpi.blowbyMax; vb = b.kpi.blowbyMax;
      } else if (k === 'hydTempMax') {
        va = a.kpi.hydTempMax; vb = b.kpi.hydTempMax;
      } else if (k === 'oilPressHMin') {
        va = a.kpi.oilPressHMin; vb = b.kpi.oilPressHMin;
      } else if (k === 'engOilTempMax') {
        va = a.kpi.engOilTempMax; vb = b.kpi.engOilTempMax;
      } else if (k === 'coolantMax') {
        va = a.kpi.coolantMax; vb = b.kpi.coolantMax;
      } else if (k === 'smrLast') {
        va = a.smrLast; vb = b.smrLast;
      } else {
        va = a[k]; vb = b[k];
      }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });

    // Batasi render DOM agar tetap responsif pada 200+ unit
    var MAX_ROWS = 300;
    var limited = rows.slice(0, MAX_ROWS);

    if (!limited.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="center" style="padding:34px;color:#64748b">' +
        (store && store.count() ? 'Tidak ada unit yang cocok dengan filter.' : 'Belum ada unit. Muat file CSV untuk memulai.') +
        '</td></tr>';
      setText('fleet-table-count', 'Menampilkan 0 unit');
      return;
    }

    var html = '';
    limited.forEach(function (r) {
      var badgeClass = r.healthLabel || 'NORMAL';
      var top = r.topAnomaly;
      var topCell = top
        ? '<span style="color:' + (top.status === 'CRITICAL' ? '#f87171' : '#fbbf24') + '">' + esc(top.title) + '</span>'
        : '<span style="color:#34d399">—</span>';

      html += '' +
        '<tr class="row-' + badgeClass + ' fleet-row" data-unit-id="' + esc(r.id) + '">' +
          '<td class="center"><span class="sev-badge sev-' + badgeClass + '" title="' + sevTooltip(r) + '">' +
            sevBadgeText(r) + '</span></td>' +
          '<td class="mono' + (r.lambung ? '' : ' kpi-cell') + '" style="font-weight:600">' +
            (r.lambung ? '<span style="color:#34d399">' + esc(r.lambung) + '</span>' : '<span style="color:#475569">—</span>') + '</td>' +
          '<td>' + esc(r.model || '—') + familyTag(r.familyId) +
            (r.serial ? '<span style="display:block;color:#64748b;font-size:9.5px;font-family:Consolas,monospace">SN: ' + esc(r.serial) + '</span>' : '') + '</td>' +
          '<td class="center"><span class="badge ' + badgeClass + '" title="Health Index: ' + (r.healthScore === null ? '—' : fmt(r.healthScore, 1)) + '">' + badgeClass + '</span></td>' +
          '<td class="center mono">' + (r.smrLast === null ? '—' : fmt(r.smrLast, 1)) + '</td>' +
          '<td class="center mono kpi-cell">' + (r.kpi.blowbyMax === null ? '—' : fmt(r.kpi.blowbyMax, 2)) + '</td>' +
          '<td class="center mono kpi-cell">' + (r.kpi.oilPressHMin === null || r.kpi.oilPressHMin === undefined ? '—' : fmt(r.kpi.oilPressHMin, 2)) + '</td>' +
          '<td class="center mono kpi-cell">' + (r.kpi.engOilTempMax === null || r.kpi.engOilTempMax === undefined ? '—' : fmt(r.kpi.engOilTempMax, 1)) + '</td>' +
          '<td class="center mono kpi-cell">' + (r.kpi.coolantMax === null || r.kpi.coolantMax === undefined ? '—' : fmt(r.kpi.coolantMax, 1)) + '</td>' +
          '<td class="center mono kpi-cell">' + (r.kpi.hydTempMax === null ? '—' : fmt(r.kpi.hydTempMax, 1)) + '</td>' +
          '<td class="center">' + (r.anomalyCount ? r.anomalyCount + ' <span style="color:#64748b">(' + r.nCritThresholds + ' kritis)</span>' : '0') + '</td>' +
          '<td class="wrap-text" style="font-size:11px">' + topCell + '</td>' +
          '<td class="center mono" style="font-size:11px">' + rulCellHtml(r.urgentRUL) + '</td>' +
          '<td class="center"><button class="btn btn-ghost btn-sm fleet-open" data-unit-id="' + esc(r.id) + '">Detail</button></td>' +
        '</tr>';
    });

    tbody.innerHTML = html;
    setText('fleet-table-count', 'Menampilkan ' + limited.length + ' dari ' + rows.length + ' unit terfilter (total unit: ' + (store ? store.count() : 0) + ')');
  }

  /* -----------------------------------------------------------------------
   * [POIN 5] Indikator filter aktif pada katalog Home
   * --------------------------------------------------------------------- */
  function updateFleetFilterUI(store) {
    var allRows = store ? store.rows() : [];

    // 1) Hitung jumlah per status untuk badge chip cepat
    var counts = { ALL: allRows.length, CRITICAL: 0, WARNING: 0, NORMAL: 0 };
    allRows.forEach(function (r) {
      var lb = r.healthLabel;
      if (counts[lb] !== undefined) counts[lb]++;
    });
    document.querySelectorAll('#fleet-filter-bar .fc-count').forEach(function (el) {
      var key = el.getAttribute('data-count');
      el.textContent = counts[key] !== undefined ? counts[key] : 0;
    });

    // 2) Tandai chip yang sedang aktif
    var active = fleetState.filter || 'ALL';
    document.querySelectorAll('#fleet-filter-bar .filter-chip').forEach(function (chip) {
      var val = chip.getAttribute('data-quick-filter');
      chip.classList.toggle('active', val === active);
    });

    // 3) Sinkronkan <select> + highlight bila aktif
    var sel = document.getElementById('fleet-filter');
    if (sel) {
      if (sel.value !== active) sel.value = active;
      sel.classList.toggle('filter-active', active !== 'ALL');
    }

    // 4) Tag "filter aktif" + tombol reset
    var tag = document.getElementById('fleet-active-filter');
    var resetBtn = document.getElementById('btn-reset-filter');
    var hasFilter = (active !== 'ALL');
    var hasSearch = !!(fleetState.search && fleetState.search.trim());
    if (tag) {
      if (hasFilter || hasSearch) {
        var parts = [];
        if (hasFilter) parts.push('Status: <strong>' + esc(active) + '</strong>');
        if (hasSearch) parts.push('Cari: "<strong>' + esc(fleetState.search.trim()) + '</strong>"');
        tag.innerHTML = '<i class="fa-solid fa-filter"></i> ' + parts.join(' &middot; ') +
          ' <span class="clear-x" id="fleet-tag-clear" title="Hapus filter">&times;</span>';
        tag.classList.remove('hidden');
      } else {
        tag.innerHTML = '';
        tag.classList.add('hidden');
      }
    }
    if (resetBtn) resetBtn.classList.toggle('hidden', !(hasFilter || hasSearch));

    return counts;
  }

  function renderFleet(stats) {
    renderFleetHeader(stats);
    renderFleetTable();
  }

  /* -----------------------------------------------------------------------
   * FLEET HEATMAP — severity matrix (baris=unit, kolom=parameter)
   * --------------------------------------------------------------------- */
  function renderHeatmap() {
    var head = document.getElementById('heatmap-head');
    var body = document.getElementById('heatmap-body');
    if (!head || !body) return;

    var store = global.VHMS_FLEET;
    var R = global.VHMS_RANKING;
    if (!store || !R) { body.innerHTML = '<tr><td style="padding:20px;color:#64748b">Data belum tersedia.</td></tr>'; return; }

    // Parameter threshold keys
    var TH = cfg.THRESHOLDS;
    var paramKeys = Object.keys(TH);

    // Header: Unit | param1 | param2 | ... | RUL
    // (Lebar kolom mengikuti isi tabel; header parameter hanya diberi
    //  lebar minimum agar otomatis sejajar dengan kolom datanya.)
    var thHtml = '<tr><th class="th-label" style="position:sticky;left:0;z-index:2;background:#0f172a">Unit</th>';
    paramKeys.forEach(function (k) {
      var meta = paramMeta(k);
      thHtml += '<th class="center th-param" title="' + esc(meta.label) + '">' +
        '<span class="th-param-txt">' + esc(meta.label) + '</span></th>';
    });
    thHtml += '<th class="center">RUL</th></tr>';
    head.innerHTML = thHtml;

    // Body: one row per unit
    var allRows = store.rows().slice();
    // Sort by health: critical first.
    // CATATAN: HEALTH_ORDER[CRITICAL] === 0 (falsy) -> JANGAN pakai `|| 2`,
    // harus cek undefined eksplisit (lihat juga renderHeatmap sos & overlay).
    allRows.sort(function (a, b) {
      var ha = healthOrderOf(a.healthLabel), hb = healthOrderOf(b.healthLabel);
      if (ha !== hb) return ha - hb;
      return (b.rankScore || 0) - (a.rankScore || 0);
    });

    var html = '';
    allRows.forEach(function (row) {
      var analysis = store.getAnalysis(row.id);
      if (!analysis) return;
      var summary = analysis.summary || {};
      var thSet = analysis.thresholdSet || TH;

      // Unit label
      var db = global.VHMS_UNITDB;
      var lb = (db && db.getLambung) ? db.getLambung(row.serial) : null;
      var label = lb || row.serial || row.id;

      html += '<tr>';
      html += '<td class="hm-label" style="position:sticky;left:0;z-index:1;background:#0f172a">' +
        '<span class="badge ' + row.healthLabel + '" style="font-size:8px;padding:1px 5px;margin-right:4px">' + row.healthLabel.charAt(0) + '</span>' +
        esc(label) + '</td>';

      paramKeys.forEach(function (k) {
        var s = summary[k];
        var th = thSet[k] || TH[k];
        if (!s || !th || (s.max === null && s.min === null)) {
          html += '<td class="center hm-cell hm-na">—</td>';
          return;
        }
        var extreme = (th.mode === 'low') ? s.min : s.max;
        var st = global.VHMS_ANALYTICS.evaluateParam(k, extreme, thSet);
        var cls = 'hm-' + (st || 'normal').toLowerCase();
        html += '<td class="center hm-cell ' + cls + '" title="' + esc(paramMeta(k).label) + ': ' + fmt(extreme, paramMeta(k).decimals) + '">' +
          fmt(extreme, paramMeta(k).decimals) + '</td>';
      });

      // RUL cell
      html += '<td class="center" style="font-size:10px">' + rulCellHtml(row.urgentRUL) + '</td>';
      html += '</tr>';
    });

    body.innerHTML = html || '<tr><td colspan="' + (paramKeys.length + 2) + '" class="center" style="padding:20px;color:#64748b">Belum ada data unit.</td></tr>';
  }

  function setFleetState(patch) {
    Object.keys(patch).forEach(function (k) { fleetState[k] = patch[k]; });
  }

  /* -----------------------------------------------------------------------
   * UNIT COMPARISON — ranking criticalitas armada
   * --------------------------------------------------------------------- */
  var compState = { model: 'ALL', search: '', band: 'ALL', sortKey: 'score', sortDir: 'desc',
    tab: 'rank', paramPillar: 'ALL', paramBasis: 'extreme', paramTopN: 10 };
  var compCharts = {};

  function renderComparison(ranked) {
    var all = ranked || [];
    // Filter model & band & search
    var rows = all.slice();
    if (compState.model !== 'ALL') rows = rows.filter(function (r) { return r.model === compState.model; });
    if (compState.band !== 'ALL') rows = rows.filter(function (r) { return r.band === compState.band; });
    var q = compState.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return ((r.serial || '') + ' ' + (r.model || '') + ' ' + (r.id || '')).toLowerCase().indexOf(q) !== -1;
      });
    }

    renderComparisonSummary(all, rows);
    renderComparisonTop10(rows.slice(0, 10));
    renderComparisonTable(rows);
    renderComparisonPillarChart(all);
  }

  function renderComparisonSummary(all, filtered) {
    var crit = all.filter(function (r) { return r.band === 'CRITICAL'; }).length;
    var warn = all.filter(function (r) { return r.band === 'WARNING'; }).length;
    var norm = all.filter(function (r) { return r.band === 'NORMAL'; }).length;
    var avg = all.length ? all.reduce(function (a, r) { return a + r.score; }, 0) / all.length : 0;

    // [RULE DATA] Info window jam yang dipakai untuk FORMULA (bukan tampilan)
    var winHours = cfg.FORMULA_WINDOW_HOURS || cfg.RANKING_WINDOW_HOURS || 0;
    var winSub = winHours > 0 ? ('formula ' + fmtInt(winHours) + ' jam terakhir') : 'seluruh data';

    var cards = document.getElementById('comparison-cards');
    if (cards) {
      cards.innerHTML =
        fleetStatCard('Unit Dinilai', fmtInt(all.length), 'fa-truck-monster', 'sky', winSub) +
        fleetStatCard('Critical', fmtInt(crit), 'fa-triangle-exclamation', 'red', 'prioritas utama') +
        fleetStatCard('Warning', fmtInt(warn), 'fa-circle-exclamation', 'amber', 'pantau berkala') +
        fleetStatCard('Normal', fmtInt(norm), 'fa-circle-check', 'emerald', 'kondisi baik') +
        fleetStatCard('Rata-rata Skor', fmt(avg, 1), 'fa-chart-simple', 'violet', 'bobot Engine dominan');
    }
    setText('comparison-count', 'Menampilkan ' + filtered.length + ' dari ' + all.length + ' unit');
  }

  function renderComparisonTop10(top) {
    var box = document.getElementById('comparison-top10');
    if (!box) return;

    if (!top.length) {
      box.innerHTML = '<div class="empty-state" style="padding:26px"><p style="font-size:12px">Tidak ada unit pada filter ini.</p></div>';
      return;
    }

    var html = '<div class="top-list">';
    top.forEach(function (u) {
      var tc = u.topCause;
      var cause = tc ? (tc.label + ' ' + fmt(tc.value, tc.decimals) + ' ' + tc.unit) : '—';
      var medal = u.rank <= 3 ? ['gold', 'silver', 'bronze'][u.rank - 1] : '';
      html += '' +
        '<div class="top-item ' + (medal ? 'medal-' + medal : '') + '" data-unit-id="' + esc(u.id) + '">' +
          '<div class="top-rank">' + u.rank + '</div>' +
          '<div class="top-main">' +
            '<div class="top-unit">' + esc(u.id) + ' <span class="pillar-tag p-' + (u.pillar || 'OTHER').toLowerCase() + '">' + esc(u.pillar) + '</span></div>' +
            '<div class="top-cause">' + esc(cause) + ' &middot; ' + (u.affectedCount || 0) + ' parameter bermasalah</div>' +
          '</div>' +
          '<div class="top-score">' +
            '<span class="badge ' + u.band + '">' + u.band + '</span>' +
            '<span class="score-num">' + fmt(u.score, 1) + '</span>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    box.innerHTML = html;
  }

  function renderComparisonTable(rows) {
    var tbody = document.getElementById('comparison-body');
    if (!tbody) return;

    // Urutkan sesuai state
    var sorted = rows.slice();
    var k = compState.sortKey, dir = compState.sortDir === 'asc' ? 1 : -1;
    sorted.sort(function (a, b) {
      var va = k === 'topCause' ? (a.topCause ? a.topCause.param : '') : a[k];
      var vb = k === 'topCause' ? (b.topCause ? b.topCause.param : '') : b[k];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });

    var MAX = 300;
    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="center" style="padding:30px;color:#64748b">Tidak ada data.</td></tr>';
      return;
    }

    var html = '';
    sorted.slice(0, MAX).forEach(function (u) {
      var tc = u.topCause;
      html += '' +
        '<tr class="fleet-row row-' + u.band + '" data-unit-id="' + esc(u.id) + '">' +
          '<td class="center mono" style="color:#fff;font-weight:700">' + u.rank + '</td>' +
          '<td class="mono">' + esc(u.serial || '—') + '</td>' +
          '<td>' + esc(u.model || '—') + '</td>' +
          '<td class="center"><span class="badge ' + u.band + '">' + u.band + '</span></td>' +
          '<td class="center mono" style="font-weight:700">' + fmt(u.score, 1) + '</td>' +
          '<td class="center mono">' + fmt(u.axis.severity, 0) + '</td>' +
          '<td class="center mono">' + fmt(u.axis.evidence, 0) + '</td>' +
          '<td class="center mono">' + fmt(u.axis.trend, 0) + '</td>' +
          '<td><span class="pillar-tag p-' + (u.pillar || 'other').toLowerCase() + '">' + esc(u.pillar) + '</span> ' +
            (tc ? esc(tc.label) + ' <span style="color:#94a3b8">' + fmt(tc.value, tc.decimals) + ' ' + esc(tc.unit) + '</span>' : '—') + '</td>' +
          '<td class="center"><button class="btn btn-ghost btn-sm comparison-open" data-unit-id="' + esc(u.id) + '">Detail</button></td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
  }

  /** Bar chart distribusi pilar penyebab pada Top N unit. */
  function renderComparisonPillarChart(all) {
    var canvas = document.getElementById('comparison-pillar-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (compCharts.pillar) { compCharts.pillar.destroy(); }

    var top = all.slice(0, 20);
    var mix = {};
    top.forEach(function (u) { mix[u.pillar] = (mix[u.pillar] || 0) + 1; });
    var labels = Object.keys(mix);
    var values = labels.map(function (l) { return mix[l]; });
    var colors = {
      ENGINE: '#ef4444', HYDRAULIC: '#f59e0b', COOLING: '#38bdf8',
      ECONOMY: '#22c55e', OTHER: '#94a3b8'
    };

    compCharts.pillar = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map(function (l) { return colors[l] || '#94a3b8'; }),
          borderColor: '#0f172a',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Rapatkan area chart agar donut tak bergeser ke kiri (perbaikan alignment).
        layout: { padding: { top: 4, bottom: 0, left: 0, right: 0 } },
        cutout: '62%',
        plugins: {
          legend: {
            // Legend di BAWAH: distribusi lebih seimbang & tidak menyisakan
            // ruang kosong besar di kiri chart.
            position: 'bottom',
            align: 'center',
            labels: {
              color: '#cbd5e1', font: { size: 11 }, boxWidth: 12, boxHeight: 12,
              padding: 12, usePointStyle: true, pointStyle: 'rectRounded'
            }
          },
          tooltip: {
            backgroundColor: 'rgba(2,6,23,.95)',
            callbacks: { label: function (c) { return c.label + ': ' + c.parsed + ' unit'; } }
          }
        }
      }
    });
  }

  function setCompState(patch) {
    Object.keys(patch).forEach(function (k) { compState[k] = patch[k]; });
  }

  /* -----------------------------------------------------------------------
   * [FITUR BARU] SUB-PAGE: Perbandingan per Parameter (matrix aple-to-aple)
   * ---------------------------------------------------------------------
   * Menampilkan nilai MENTAH tiap parameter untuk TOP N unit (default 10),
   * dengan kolom unit sebagai perbandingan langsung. Memakai window jam yang
   * sama dengan ranking (VHMS_RANKING.paramMatrix).
   * --------------------------------------------------------------------- */
  function renderComparisonByParam(ranked) {
    var store = global.VHMS_FLEET;
    var R = global.VHMS_RANKING;
    var head = document.getElementById('param-comp-head');
    var body = document.getElementById('param-comp-body');
    if (!head || !body) return;
    if (!store || !R || typeof R.paramMatrix !== 'function' || !ranked || !ranked.length) {
      head.innerHTML = '';
      body.innerHTML = '<tr><td class="center" style="padding:26px;color:#64748b">Belum ada data untuk dibandingkan.</td></tr>';
      return;
    }

    var matrix = R.paramMatrix(store, ranked, {
      topN: compState.paramTopN || 10,
      basis: compState.paramBasis || 'extreme',
      pillar: compState.paramPillar || 'ALL'
    });

    setText('param-comp-window', fmtInt(matrix.windowHours || 0));
    setText('param-comp-count', 'Membandingkan ' + matrix.rows.length + ' parameter pada ' +
      matrix.units.length + ' unit teratas' + (matrix.pillar !== 'ALL' ? ' · pilar ' + matrix.pillar : ''));

    // Isi dropdown pilar sekali (dari pilar yang muncul di config)
    var pilSel = document.getElementById('param-comp-pillar');
    if (pilSel) {
      var pillars = {};
      var PILLARS = global.VHMS_CONFIG.RANKING_PILLARS || {};
      Object.keys(PILLARS).forEach(function (k) { pillars[PILLARS[k]] = true; });
      var cur = pilSel.value || compState.paramPillar || 'ALL';
      var opts = '<option value="ALL">Semua Pilar</option>';
      ['ENGINE', 'HYDRAULIC', 'COOLING', 'ECONOMY', 'OTHER'].forEach(function (p) {
        if (pillars[p]) opts += '<option value="' + p + '">' + p + '</option>';
      });
      pilSel.innerHTML = opts;
      pilSel.value = cur;
    }

    // ---- Bangun header: Parameter | Satuan | Batas | <kolom unit> ... | Terbaik | Terburuk
    // REVISI: kolom unit menampilkan NOMOR LAMBUNG (dari Database Unit) sebagai
    // label utama agar mudah dikenali; SN dipakai sebagai cadangan bila Lambung
    // belum tersedia, dan model tetap ditampilkan di baris kecil.
    var dbU = global.VHMS_UNITDB;
    function lambungOf(serial) {
      if (!dbU || !dbU.getLambung) return null;
      try { return dbU.getLambung(serial); } catch (e) { return null; }
    }

    var headHtml = '<tr>' +
      '<th style="position:sticky;left:0;z-index:3;background:#020617">Parameter</th>' +
      '<th class="center">Satuan</th>' +
      '<th class="center">Batas (Warn/Crit)</th>';
    matrix.units.forEach(function (u) {
      var lb = lambungOf(u.serial);
      var primary = lb || u.serial || u.id;
      var sub = '#' + u.rank + ' · ' + (u.model || '');
      if (lb && u.serial) sub = '#' + u.rank + ' · SN ' + u.serial;
      headHtml += '<th class="unit-col"' + (lb ? ' title="Nomor Lambung: ' + esc(lb) + ' — SN: ' + esc(u.serial || '—') + '"' : '') + '>' +
        '<span class="u-serial' + (lb ? ' u-lambung' : '') + '">' + esc(primary) + '</span>' +
        '<span class="u-model">' + esc(sub) + '</span>' +
        '</th>';
    });
    headHtml += '<th class="center">Terbaik</th><th class="center">Terburuk</th></tr>';
    head.innerHTML = headHtml;

    // ---- Bangun body, dikelompokkan per pilar
    if (!matrix.rows.length) {
      body.innerHTML = '<tr><td class="center" style="padding:26px;color:#64748b" colspan="' +
        (3 + matrix.units.length + 2) + '">Tidak ada parameter dengan threshold pada filter ini.</td></tr>';
      return;
    }

    function unitLabel(id) {
      for (var i = 0; i < matrix.units.length; i++) {
        if (matrix.units[i].id === id) {
          var u = matrix.units[i];
          return lambungOf(u.serial) || u.serial || u.id;
        }
      }
      return '—';
    }

    var html = '';
    var lastPillar = null;
    matrix.rows.forEach(function (row) {
      if (row.pillar !== lastPillar) {
        lastPillar = row.pillar;
        html += '<tr class="pillar-row"><td colspan="' + (3 + matrix.units.length + 2) + '">' +
          '<span class="pillar-tag p-' + row.pillar.toLowerCase() + '">' + esc(row.pillar) + '</span></td></tr>';
      }
      var bound = fmt(row.warn, row.decimals) + ' / ' + fmt(row.crit, row.decimals);

      html += '<tr>' +
        '<td class="param-name" style="position:sticky;left:0;background:#0b1220">' +
          '<span class="p-label">' + esc(row.label) + '</span>' +
          '<span class="p-meta">' + (row.mode === 'low' ? '↓ makin kecil makin bahaya' : '↑ makin besar makin bahaya') + '</span>' +
        '</td>' +
        '<td class="center" style="color:#64748b">' + esc(row.unit || '—') + '</td>' +
        '<td class="center mono" style="color:#64748b;font-size:10.5px">' + bound + '</td>';

      matrix.units.forEach(function (u) {
        var c = row.cells[u.id];
        if (!c || c.value === null || c.value === undefined || isNaN(c.value)) {
          html += '<td class="val-cell v-NA">—</td>';
        } else {
          html += '<td class="val-cell v-' + c.status + '">' + fmt(c.value, c.decimals) +
            '<span class="v-unit">' + esc(c.unit || '') + '</span></td>';
        }
      });

      html += '<td class="best-worst"><span class="b">' + esc(unitLabel(row.bestUnit)) + '</span></td>' +
              '<td class="best-worst"><span class="w">' + esc(unitLabel(row.worstUnit)) + '</span></td>' +
              '</tr>';
    });
    body.innerHTML = html;
  }

  /** Ekspor matrix perbandingan per parameter ke CSV. */
  function paramMatrixToCsv(ranked) {
    var store = global.VHMS_FLEET;
    var R = global.VHMS_RANKING;
    if (!store || !R || !R.paramMatrix || !ranked || !ranked.length) return '';
    var matrix = R.paramMatrix(store, ranked, {
      topN: compState.paramTopN || 10,
      basis: compState.paramBasis || 'extreme',
      pillar: compState.paramPillar || 'ALL'
    });
    var lines = [];
    var dbU = global.VHMS_UNITDB;
    function lbOf(serial) {
      if (!dbU || !dbU.getLambung) return null;
      try { return dbU.getLambung(serial); } catch (e) { return null; }
    }
    function nameOf(u) {
      if (!u) return '';
      var lb = lbOf(u.serial);
      var id = lb || u.serial || u.id;
      return lb ? (lb + ' (SN ' + (u.serial || '') + ')') : id;
    }
    var head = ['Pilar', 'Parameter', 'Satuan', 'Batas'];
    matrix.units.forEach(function (u) { head.push(nameOf(u) + ' [' + (u.model || '') + ']'); });
    head.push('Terbaik', 'Terburuk');
    lines.push(head.join(','));

    function nameById(id) {
      for (var i = 0; i < matrix.units.length; i++) {
        if (matrix.units[i].id === id) return nameOf(matrix.units[i]);
      }
      return id || '';
    }

    matrix.rows.forEach(function (row) {
      var cols = [row.pillar, '"' + row.label + '"', row.unit || '', row.warn + '/' + row.crit];
      matrix.units.forEach(function (u) {
        var c = row.cells[u.id];
        cols.push((c && c.value !== null && !isNaN(c.value)) ? c.value : '');
      });
      cols.push('"' + nameById(row.bestUnit) + '"', '"' + nameById(row.worstUnit) + '"');
      lines.push(cols.join(','));
    });
    return lines.join('\n');
  }

  function setCompParamState(patch) {
    Object.keys(patch).forEach(function (k) { compState[k] = patch[k]; });
  }

  /* -----------------------------------------------------------------------
   * OVERLAY CHART — tren parameter yang sama untuk 2-5 unit sekaligus
   * --------------------------------------------------------------------- */
  var overlayChart = null;
  var OVERLAY_SELECTS = ['overlay-unit1', 'overlay-unit2', 'overlay-unit3', 'overlay-unit4', 'overlay-unit5'];

  /** Populasi dropdown unit & parameter pada tab overlay. */
  function initOverlaySelectors(ranked) {
    var store = global.VHMS_FLEET;
    if (!store) return;

    // Param select
    var paramSel = document.getElementById('overlay-param');
    if (paramSel) {
      var keys = Object.keys(cfg.THRESHOLDS);
      // Tambahkan parameter non-threshold yang menarik
      ['engSpeedMax', 'engSpeedAve', 'boostMax', 'pump1F', 'pump2F', 'fanPumpF', 'fuelRate', 'engPowerAve'].forEach(function (k) {
        if (keys.indexOf(k) === -1 && cfg.PARAMS[k]) keys.push(k);
      });
      paramSel.innerHTML = keys.map(function (k) {
        var meta = paramMeta(k);
        return '<option value="' + k + '">' + esc(meta.label) + ' (' + esc(meta.unit) + ')</option>';
      }).join('');
    }

    // Unit selects
    var rows = store.rows();
    var db = global.VHMS_UNITDB;
    function unitLabel(r) {
      var lb = (db && db.getLambung) ? db.getLambung(r.serial) : null;
      return (lb || r.serial || r.id) + ' — ' + (r.model || '');
    }
    var opts = rows.map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(unitLabel(r)) + '</option>';
    }).join('');
    var optEmpty = '<option value="">— Tidak ada —</option>';

    // Unit 1 & 2 wajib; unit 3/4/5 opsional (boleh "Tidak ada")
    OVERLAY_SELECTS.forEach(function (id, i) {
      var sel = document.getElementById(id);
      if (sel) sel.innerHTML = (i < 2 ? '' : optEmpty) + opts;
    });

    // Pre-select top 2 from ranking if available
    if (ranked && ranked.length >= 2) {
      var s1 = document.getElementById('overlay-unit1');
      var s2 = document.getElementById('overlay-unit2');
      if (s1) s1.value = ranked[0].id;
      if (s2) s2.value = ranked[1].id;
    }
  }

  /** Draw overlay chart for selected units & parameter. */
  function drawOverlayChart() {
    var canvas = document.getElementById('overlay-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    var store = global.VHMS_FLEET;
    if (!store) return;

    if (overlayChart) { overlayChart.destroy(); overlayChart = null; }

    var paramKey = (document.getElementById('overlay-param') || {}).value || 'blowbyMax';
    var ids = [];
    OVERLAY_SELECTS.forEach(function (selId) {
      var v = (document.getElementById(selId) || {}).value;
      if (v && ids.indexOf(v) === -1) ids.push(v);
    });

    if (ids.length < 2) return;

    var meta = paramMeta(paramKey);
    var COLORS = ['#ef4444', '#38bdf8', '#a78bfa', '#22c55e', '#f59e0b'];
    var datasets = [];
    var db = global.VHMS_UNITDB;
    var pickedRows = [];

    ids.forEach(function (id, idx) {
      var analysis = store.getAnalysis(id);
      if (!analysis || !analysis.records) return;
      var row = store.rows().filter(function (r) { return r.id === id; })[0];
      var lb = (db && db.getLambung && row) ? db.getLambung(row.serial) : null;
      var label = lb || (row ? row.serial : id);

      var data = analysis.records.map(function (r) {
        // [REVISI] Sertakan tanggal (Waktu Rekam) di tiap titik agar tooltip
        // bisa menampilkan KAPAN kejadian, bukan hanya SMR-nya.
        return { x: r.smr, y: r[paramKey], d: (r.calendar && r.calendar.display) ? r.calendar.display : '' };
      }).filter(function (d) { return d.x !== null && d.y !== null; });

      datasets.push({
        label: label + ' (' + (row ? row.model : '') + ')',
        data: data,
        borderColor: COLORS[idx % COLORS.length],
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.25,
        fill: false,
        spanGaps: true
      });

      pickedRows.push({ id: id, row: row, summary: analysis.summary || {}, thSet: analysis.thresholdSet || cfg.THRESHOLDS });
    });

    // Threshold lines
    var th = cfg.THRESHOLDS[paramKey];
    if (th) {
      datasets.push({
        label: 'Warning (' + fmt(th.warn, meta.decimals) + ')',
        data: [{ x: -Infinity, y: th.warn }, { x: Infinity, y: th.warn }],
        borderColor: 'rgba(245,158,11,.5)', borderWidth: 1.5, borderDash: [6, 4],
        pointRadius: 0, fill: false, spanGaps: true
      });
      datasets.push({
        label: 'Critical (' + fmt(th.crit, meta.decimals) + ')',
        data: [{ x: -Infinity, y: th.crit }, { x: Infinity, y: th.crit }],
        borderColor: 'rgba(239,68,68,.5)', borderWidth: 1.5, borderDash: [4, 3],
        pointRadius: 0, fill: false, spanGaps: true
      });
    }

    overlayChart = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        showLine: true,
        animation: { duration: 400 },
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: '#cbd5e1', font: { size: 11 }, boxWidth: 14, usePointStyle: true } },
          tooltip: {
            backgroundColor: 'rgba(2,6,23,.95)', borderColor: '#334155', borderWidth: 1,
            callbacks: {
              label: function (ctx) {
                var d = (ctx.raw && ctx.raw.d) ? ctx.raw.d : '';
                return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, meta.decimals) + ' ' + meta.unit +
                  ' @ SMR ' + fmtInt(ctx.parsed.x) + (d ? ' • ' + d : '');
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear', title: { display: true, text: 'SMR (jam)', color: '#64748b' },
            grid: { color: 'rgba(30,41,59,.8)' }, ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          y: {
            title: { display: true, text: meta.label + ' (' + meta.unit + ')', color: '#38bdf8' },
            grid: { color: 'rgba(30,41,59,.8)' }, ticks: { color: '#38bdf8', font: { size: 10 } }
          }
        }
      }
    });

    renderOverlaySummary(pickedRows, paramKey);
  }

  /**
   * Ringkasan & kesimpulan level hasil penilaian unit terpilih pada overlay,
   * diurutkan dari paling CRITICAL ke NORMAL.
   */
  /* Kolom tabel "Ringkasan & Kesimpulan" beserta metadata filter.
   * `key`   = kunci state filter (stabil antar render).
   * `label` = judul kolom.
   * `get`   = fungsi ambil teks yang bisa dicari dari satu baris (p, meta),
   *           dipakai untuk pencocokan filter teks case-insensitive. */
  var OVERLAY_SUMMARY_COLS = [
    { key: 'unit',   label: 'Unit', align: 'left' },
    { key: 'level',  label: 'Level', align: 'center' },
    { key: 'health', label: 'Health', align: 'center' },
    { key: 'param',  label: null, align: 'center' },   // label diisi meta.label (min/maks)
    { key: 'last',   label: 'Nilai Terakhir', align: 'center' },
    { key: 'smr',    label: 'SMR', align: 'center' },
    { key: 'rul',    label: 'Sisa Ops (RUL)', align: 'center' }
  ];

  /** Ambil teks pencarian untuk satu baris pada kolom tertentu. */
  function overlaySummaryCellText(colKey, p, meta) {
    var r = p.row || {};
    var s = (p.summary || {})[meta.__paramKey] || {};
    var db = global.VHMS_UNITDB;
    var lb = (db && db.getLambung && r.serial) ? db.getLambung(r.serial) : null;
    var name = lb || r.serial || p.id || '';
    switch (colKey) {
      case 'unit':   return name + ' ' + (r.model || '');
      case 'level':  return (r.healthLabel || 'NORMAL');
      case 'health': return (r.healthScore === null || r.healthScore === undefined) ? '' : String(r.healthScore);
      case 'param':  return fmt(s.min, meta.decimals) + ' / ' + fmt(s.max, meta.decimals) + ' ' + (meta.unit || '');
      case 'last':   return fmt(s.last, meta.decimals) + ' ' + (meta.unit || '');
      case 'smr':    return fmtInt(r.smrLast);
      case 'rul': {
        var u = r.urgentRUL || {};
        if (u.hours === Infinity || u.hours > 50000) return 'Stabil';
        return (u.hours === null || u.hours === undefined) ? '' : (fmtInt(u.hours) + ' jam');
      }
      default: return '';
    }
  }

  /**
   * Entry point lama (dipanggil setiap selesai menggambar chart overlay).
   * Menyimpan data terakhir + menggambar tabel ringkasan dengan filter kolom.
   * Filter TIDAK direset di sini agar pilihan pengguna tetap saat chart
   * digambar ulang dengan parameter yang sama.
   */
  function renderOverlaySummary(pickedRows, paramKey) {
    overlaySummaryState.lastRows = pickedRows || null;
    overlaySummaryState.lastParamKey = paramKey;
    // Bila unit terpilih berubah, buang filter kolom yang tak relevan tetap
    // dipertahankan (kolom sama), cukup render ulang.
    renderOverlaySummaryTable();
  }

  /**
   * Pasang listener filter kolom & klik baris untuk tabel ringkasan overlay.
   * Listener dipasang via delegasi pada `box` sehingga tetap berlaku setelah
   * `box.innerHTML` diganti pada setiap render.
   */
  function wireOverlaySummaryFilters(box) {
    if (!box || box.__ovlWired) return;
    box.__ovlWired = true;

    // Filter kolom: perbarui state lalu render ulang HANYA tabel (tanpa chart).
    box.addEventListener('input', function (e) {
      var inp = e.target.closest ? e.target.closest('.ovl-col-filter') : null;
      if (!inp) return;
      var col = inp.getAttribute('data-ovl-col');
      if (!col) return;
      overlaySummaryState.filters[col] = inp.value;
      // Simpan posisi kursor & scroll agar pengetikan tidak "meloncat".
      var selStart = inp.selectionStart, selEnd = inp.selectionEnd;
      var scrollWrap = box.querySelector('.table-scroll');
      var scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
      renderOverlaySummaryTable();
      // Kembalikan fokus ke input kolom yang sama.
      var again = box.querySelector('.ovl-col-filter[data-ovl-col="' + col + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(selStart, selEnd); } catch (_) { /* noop */ }
      }
      var sw = box.querySelector('.table-scroll');
      if (sw) sw.scrollLeft = scrollLeft;
    });

    // Reset filter.
    box.addEventListener('click', function (e) {
      var resetBtn = e.target.closest ? e.target.closest('#ovl-summary-reset') : null;
      if (resetBtn) {
        overlaySummaryState.filters = {};
        renderOverlaySummaryTable();
        return;
      }
      // Klik baris -> buka detail unit (bila handler global tersedia).
      var rowEl = e.target.closest ? e.target.closest('tr[data-unit-id]') : null;
      if (rowEl && global.VHMS_APP && typeof global.VHMS_APP.openUnit === 'function') {
        global.VHMS_APP.openUnit(rowEl.getAttribute('data-unit-id'));
      }
    });
  }

  /**
   * Gambar HANYA tabel + kesimpulan "Ringkasan & Kesimpulan" memakai state
   * filter saat ini. Dipanggil terpisah dari `renderOverlaySummary` agar
   * pengetikan filter tidak memicu penggambaran ulang chart overlay.
   */
  function renderOverlaySummaryTable() {
    var box = document.getElementById('overlay-summary');
    if (!box) return;
    var pickedRows = overlaySummaryState.lastRows;
    var paramKey = overlaySummaryState.lastParamKey;
    if (!pickedRows || !pickedRows.length) { box.innerHTML = ''; return; }

    var meta = paramMeta(paramKey);
    meta.__paramKey = paramKey;   // dipakai overlaySummaryCellText
    var HEALTH_COLOR = { CRITICAL: '#ef4444', WARNING: '#eab308', NORMAL: '#22c55e' };

    // [FILTER HEADER] Terapkan filter teks per kolom secara berurutan.
    var filtered = pickedRows.filter(function (p) {
      return OVERLAY_SUMMARY_COLS.every(function (c) {
        var f = (overlaySummaryState.filters[c.key] || '').trim().toLowerCase();
        if (!f) return true;
        return overlaySummaryCellText(c.key, p, meta).toLowerCase().indexOf(f) !== -1;
      });
    });

    // [DEFAULT URUTAN] Selalu health terburuk dulu (CRITICAL → WARNING →
    // NORMAL), lalu rankScore. Berlaku juga pada hasil filter.
    // Memakai `healthOrderOf` yang aman terhadap falsy-zero (CRITICAL === 0).
    var sorted = filtered.slice().sort(function (a, b) {
      var ha = healthOrderOf((a.row || {}).healthLabel);
      var hb = healthOrderOf((b.row || {}).healthLabel);
      if (ha !== hb) return ha - hb;
      return ((b.row || {}).rankScore || 0) - ((a.row || {}).rankScore || 0);
    });

    var counts = { CRITICAL: 0, WARNING: 0, NORMAL: 0 };
    sorted.forEach(function (p) {
      var lbl = (p.row || {}).healthLabel || 'NORMAL';
      if (counts[lbl] !== undefined) counts[lbl]++;
    });
    var totalSelected = pickedRows.length;
    var activeFilters = OVERLAY_SUMMARY_COLS.some(function (c) {
      return (overlaySummaryState.filters[c.key] || '').trim() !== '';
    });

    // ---- Header panel ----
    var html = '<div class="panel-head"><div>' +
      '<h2 class="panel-title"><i class="fa-solid fa-clipboard-check" style="color:#22c55e"></i> Ringkasan &amp; Kesimpulan</h2>' +
      '<p class="panel-sub">Penilaian ' + sorted.length + ' dari ' + totalSelected + ' unit terpilih — dari paling critical ke normal · parameter ' + esc(meta.label) + '</p>' +
      '</div>' +
      (activeFilters
        ? '<div><button class="btn btn-ghost btn-sm" id="ovl-summary-reset"><i class="fa-solid fa-xmark"></i> Reset Filter</button></div>'
        : '') +
      '</div>';

    // ---- Baris chip level (mengikuti hasil filter) ----
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px">';
    [['CRITICAL', '#ef4444'], ['WARNING', '#eab308'], ['NORMAL', '#22c55e']].forEach(function (p) {
      html += '<span class="chip" style="background:' + p[1] + '22;color:' + p[1] + ';border-color:' + p[1] + '55">' +
        p[0] + ': <strong>' + counts[p[0]] + '</strong></span>';
    });
    html += '</div>';

    // ---- Tabel: baris 1 judul kolom, baris 2 input filter (gaya Excel) ----
    html += '<div class="table-scroll"><table class="data ovl-summary-table"><thead>' +
      '<tr class="ovl-head-row">';
    OVERLAY_SUMMARY_COLS.forEach(function (c) {
      var txt = c.key === 'param' ? (esc(meta.label) + ' (min/maks)') : esc(c.label);
      html += '<th class="' + (c.align === 'center' ? 'center' : '') + '">' +
        '<span class="ovl-th-label">' + txt + '</span>' +
        '<i class="fa-solid fa-filter ovl-filter-icon" title="Filter kolom ini"></i>' +
        '</th>';
    });
    html += '</tr><tr class="ovl-filter-row">';
    OVERLAY_SUMMARY_COLS.forEach(function (c) {
      var val = esc(overlaySummaryState.filters[c.key] || '');
      html += '<th class="' + (c.align === 'center' ? 'center' : '') + '">' +
        '<input type="search" class="ovl-col-filter" data-ovl-col="' + c.key + '" ' +
        'placeholder="Filter…" value="' + val + '" autocomplete="off" spellcheck="false">' +
        '</th>';
    });
    html += '</tr></thead><tbody id="ovl-summary-body">';

    if (!sorted.length) {
      html += '<tr><td colspan="' + OVERLAY_SUMMARY_COLS.length + '" class="center" ' +
        'style="padding:26px;color:#64748b">Tidak ada unit yang cocok dengan filter.</td></tr>';
    } else {
      sorted.forEach(function (p) {
        var r = p.row || {};
        var lbl = r.healthLabel || 'NORMAL';
        var s = p.summary[paramKey] || {};
        var db = global.VHMS_UNITDB;
        var lb = (db && db.getLambung && r.serial) ? db.getLambung(r.serial) : null;
        var name = lb || r.serial || p.id;
        var rulTxt = rulCellHtml(r.urgentRUL);
        html += '<tr style="cursor:pointer" data-unit-id="' + esc(p.id) + '">' +
          '<td><strong>' + esc(name) + '</strong> <span style="color:var(--text-mute);font-size:10px">' + esc(r.model || '') + '</span></td>' +
          '<td class="center"><span class="badge ' + lbl + '">' + lbl + '</span></td>' +
          '<td class="center">' + (r.healthScore === null || r.healthScore === undefined ? '—' : fmt(r.healthScore, 1)) + '</td>' +
          '<td class="center">' + fmt(s.min, meta.decimals) + ' / ' + fmt(s.max, meta.decimals) + ' ' + esc(meta.unit) + '</td>' +
          '<td class="center">' + fmt(s.last, meta.decimals) + ' ' + esc(meta.unit) + '</td>' +
          '<td class="center">' + fmtInt(r.smrLast) + '</td>' +
          '<td class="center">' + rulTxt + '</td>' +
          '</tr>';
      });
    }
    html += '</tbody></table></div>';

    // ---- Kesimpulan tekstual (berdasarkan hasil filter) ----
    if (sorted.length) {
      var worst = sorted[0];
      var worstName = (function () { var db = global.VHMS_UNITDB; var lb = (db && db.getLambung && (worst.row || {}).serial) ? db.getLambung(worst.row.serial) : null; return lb || (worst.row || {}).serial || worst.id; })();
      var concl = 'Unit paling perlu perhatian pada parameter ini: <strong>' + esc(worstName) +
        '</strong> dengan level <strong style="color:' + (HEALTH_COLOR[(worst.row || {}).healthLabel] || '#22c55e') + '">' +
        ((worst.row || {}).healthLabel || 'NORMAL') + '</strong>.';
      if (counts.CRITICAL) concl += ' Terdapat ' + counts.CRITICAL + ' unit CRITICAL yang harus diprioritaskan.';
      else if (counts.WARNING) concl += ' Terdapat ' + counts.WARNING + ' unit WARNING untuk dipantau berkala.';
      else concl += ' Semua unit terpilih dalam kondisi normal.';
      html += '<p style="font-size:11.5px;color:var(--text-dim);margin-top:12px;padding:10px;background:var(--card-2);border-radius:8px">' +
        '<i class="fa-solid fa-lightbulb" style="color:#fbbf24"></i> ' + concl + '</p>';
    }

    box.innerHTML = html;
    wireOverlaySummaryFilters(box);
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_RENDER = {
    renderAll: renderAll,
    renderHeader: renderHeader,
    resetHeader: resetHeader,
    renderBanner: renderBanner,
    syncInsightHeight: syncInsightHeight,
    openAnomalyModal: openAnomalyModal,
    closeAnomalyModal: closeAnomalyModal,
    isAnomalyModalOpen: isAnomalyModalOpen,
    renderTable: renderTable,
    setTableState: setTableState,
    getTableState: function () { return Object.assign({}, tableState); },
    renderFleet: renderFleet,
    renderFleetTable: renderFleetTable,
    renderHeatmap: renderHeatmap,
    updateFleetFilterUI: updateFleetFilterUI,
    setFleetState: setFleetState,
    getFleetState: function () { return Object.assign({}, fleetState); },
    renderComparison: renderComparison,
    setCompState: setCompState,
    getCompState: function () { return Object.assign({}, compState); },
    renderComparisonByParam: renderComparisonByParam,
    paramMatrixToCsv: paramMatrixToCsv,
    setCompParamState: setCompParamState,
    initOverlaySelectors: initOverlaySelectors,
    drawOverlayChart: drawOverlayChart,
    getCharts: function () { return charts; },
    resetCharts: function () {
      Object.keys(charts).forEach(function (k) {
        if (charts[k]) { charts[k].destroy(); delete charts[k]; }
      });
      Object.keys(compCharts).forEach(function (k) {
        if (compCharts[k]) { compCharts[k].destroy(); delete compCharts[k]; }
      });
    },
    fmt: fmt,
    fmtInt: fmtInt,
    esc: esc
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

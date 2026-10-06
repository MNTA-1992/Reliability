/* =========================================================================
 * portfolio-followup.js
 * -------------------------------------------------------------------------
 * Halaman FORM FOLLOW-UP: replika layout template "File Follow Up Input.pdf"
 * (PT BUKIT MAKMUR MANDIRI UTAMA). Data unit di-load dari SOS store.
 * ========================================================================= */

(function (global) {
  'use strict';

  var uiUtil = global.UI_UTIL || {};

  function el(id) { return document.getElementById(id); }
  function sos() { return global.SOS_STORE; }

  function esc(s) {
    if (uiUtil.esc) return uiUtil.esc(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(d) {
    if (!d) return '';
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(dt.getDate()) + '.' + p(dt.getMonth() + 1) + '.' + dt.getFullYear();
  }

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-05] Unit diambil dari FILTER OVERVIEW (satu sumber pilihan).
   * Memakai PORTFOLIO_RENDER.collect() agar identik dengan Overview: sudah
   * menggabungkan SOS + VHMS dan memetakan Nomor Lambung secara konsisten.
   * Mengembalikan section terburuk (SOS/VHMS) dari unit terpilih.
   * --------------------------------------------------------------------- */
  function selectedUnit() {
    var render = global.PORTFOLIO_RENDER;
    var app = global.PORTFOLIO_APP;
    if (!render || !render.collect || !app || !app.currentSelection) return null;

    var sel = app.currentSelection();
    if (!sel.unitLambung) return null;

    var entry = (render.collect(sel.unitLambung) || [])[0];
    if (!entry || !entry.sections || !entry.sections.length) return null;

    var sections = entry.sections.slice();

    // Hormati filter kompartemen bila ada.
    if (sel.compartments.length) {
      var filtered = sections.filter(function (s) {
        return sel.compartments.indexOf(s.component) !== -1;
      });
      if (filtered.length) sections = filtered;
    }

    // Ambil section paling kritis (CRITICAL > CAUTION, lalu skor tertinggi).
    var order = { CRITICAL: 2, CAUTION: 1, NORMAL: 0 };
    sections.sort(function (a, b) {
      var oa = order[String(a.band || '').toUpperCase()] || 0;
      var ob = order[String(b.band || '').toUpperCase()] || 0;
      if (oa !== ob) return ob - oa;
      return (b.score || 0) - (a.score || 0);
    });

    var sec = sections[0];
    sec._lambung = entry.lambung;
    return sec;
  }

  /* -----------------------------------------------------------------------
   * Pre-fill form dari unit yang dipilih di filter Overview
   * --------------------------------------------------------------------- */
  function fillFromSelection() {
    var sec = selectedUnit();
    if (!sec) return false;

    var lambung = sec._lambung || sec.lambung || sec.unitId || '';
    var component = sec.component || '';
    var band = String(sec.band || '').toUpperCase();
    var src = sec.source || 'SOS';
    function set(id, val) { var e = el(id); if (e) e.value = (val == null ? '' : String(val)); }

    if (!el('fu-mo-no').value) {
      set('fu-mo-no', 'MO-' + new Date().getFullYear() + '-' +
        String(Math.floor(Math.random() * 999999)).padStart(6, '0'));
    }
    set('fu-mo-desc', 'EHMS ' + lambung + ' ' + component + ' ' + src + ' ' +
      (band === 'CRITICAL' ? 'C' : 'W'));
    set('fu-equipment-no', lambung);
    set('fu-equipment-sn', sec.serial || '');
    set('fu-plan-date', fmtDate(new Date()));
    set('fu-plan-hm', sec.hmUnit != null ? sec.hmUnit : '');
    set('fu-pm-type', 'EHM');

    // Description & Order Activity — ringkasan parameter di atas threshold
    var lines = [];
    lines.push(lambung + ' ' + component + ' | Source = ' + src +
      ' | Summary Last ' + (band === 'CRITICAL' ? 'Critical' : 'Caution') + ' Information');

    (sec.breached || []).slice(0, 10).forEach(function (b) {
      var name = b.label || b.name || b.param || b.key || '';
      var val = (b.value != null ? b.value : (b.displayValue != null ? b.displayValue : ''));
      var unitTxt = b.unit ? (' ' + b.unit) : '';
      var statusTxt = (b.severity >= 2 ? 'CRITICAL' : 'CAUTION');
      var histTxt = (b.current === false ? ' (historis)' : '');
      lines.push('- ' + name + ': ' + val + unitTxt + ' [' + statusTxt + ']' + histTxt);
    });

    if (sec.lifetime && sec.lifetime.lifePct != null) {
      lines.push('Component Life: ' + sec.lifetime.lifePct + '%' +
        (sec.lifetime.remainingHours != null ? ' (sisa ' + sec.lifetime.remainingHours + ' jam)' : ''));
    }
    if (sec.topup && sec.topup.count) {
      lines.push('Top-Up Oil: ' + sec.topup.count + ' transaksi' +
        (sec.topup.totalQty != null ? ', total ' + sec.topup.totalQty : ''));
    }

    lines.push('Action: Check & verify parameter; re-sample after corrective action.');
    set('fu-problem-desc', lines.join('\n'));
    return true;
  }

  /* -----------------------------------------------------------------------
   * Render halaman form (layout mengikuti template PDF)
   * --------------------------------------------------------------------- */
  function render() {
    var container = el('portfolio-followup-container');
    if (!container) return;

    var html = '';

    // --- Dokumen (kanvas A4) ---
    html += '<div class="rp-paper fu-paper">';
    html += '<div class="fu-company">PT BUKIT MAKMUR MANDIRI UTAMA</div>';
    html += '<table class="fu-form">';
    html += '<colgroup><col style="width:22%"><col style="width:28%"><col style="width:25%"><col style="width:25%"></colgroup>';

    html += '<tr>';
    html += '<td class="fu-lbl fu-strong">Plant Department</td>';
    html += '<td class="fu-lbl fu-strong">MO No</td>';
    html += '<td class="fu-val" colspan="2"><input id="fu-mo-no" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl fu-strong"><input id="fu-site" type="text" value="BUMA-Sungai Danau Jaya"></td>';
    html += '<td class="fu-lbl fu-strong">MO Description</td>';
    html += '<td class="fu-val fu-accent" colspan="2"><input id="fu-mo-desc" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl">Equipment No</td>';
    html += '<td class="fu-val"><input id="fu-equipment-no" type="text"></td>';
    html += '<td class="fu-lbl">Notification No.</td>';
    html += '<td class="fu-val"><input id="fu-notif-no" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl">Equipment SN</td>';
    html += '<td class="fu-val"><input id="fu-equipment-sn" type="text"></td>';
    html += '<td class="fu-lbl">Plan Date</td>';
    html += '<td class="fu-val"><input id="fu-plan-date" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl">Plan HM</td>';
    html += '<td class="fu-val"><input id="fu-plan-hm" type="text"></td>';
    html += '<td class="fu-lbl">Malf Start Date/Time</td>';
    html += '<td class="fu-val"><input id="fu-malf-start" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl">PM Act. Type</td>';
    html += '<td class="fu-val"><input id="fu-pm-type" type="text"></td>';
    html += '<td class="fu-lbl">Malf End Date/Time</td>';
    html += '<td class="fu-val"><input id="fu-malf-end" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl">Person Responsible</td>';
    html += '<td class="fu-val"><input id="fu-person" type="text"></td>';
    html += '<td class="fu-lbl">SN Component IN</td>';
    html += '<td class="fu-val"><input id="fu-sn-in" type="text"></td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-lbl" colspan="3">Description &amp; Order Activity</td>';
    html += '<td class="fu-lbl">SN Component OUT</td>';
    html += '</tr>';

    html += '<tr>';
    html += '<td class="fu-val fu-area" colspan="4"><textarea id="fu-problem-desc" rows="12"></textarea></td>';
    html += '</tr>';

    // Blok tanda tangan 1
    html += '<tr class="fu-sign-head"><td colspan="2">Prepared by</td><td colspan="2">Approved by</td></tr>';
    html += '<tr class="fu-sign-box"><td colspan="2"></td><td colspan="2"></td></tr>';
    html += '<tr class="fu-sign-name">';
    html += '<td colspan="2">Name: <input id="fu-prepared-by" type="text"></td>';
    html += '<td colspan="2">Name: <input id="fu-approved-by" type="text"></td>';
    html += '</tr>';
    html += '<tr class="fu-sign-role"><td colspan="2">Planner</td><td colspan="2">Supervisor</td></tr>';

    // Action Taken
    html += '<tr><td class="fu-lbl fu-strong" colspan="4">Action Taken (Follow Up Action):</td></tr>';
    html += '<tr>';
    html += '<td class="fu-lbl">Execution HM/SMU</td>';
    html += '<td class="fu-val"><input id="fu-hm-smu" type="text"></td>';
    html += '<td class="fu-lbl">Execution Date</td>';
    html += '<td class="fu-val"><input id="fu-execution-date" type="date"></td>';
    html += '</tr>';
    html += '<tr>';
    html += '<td class="fu-val fu-area" colspan="4"><textarea id="fu-action-notes" rows="12"></textarea></td>';
    html += '</tr>';

    // Blok tanda tangan 2
    html += '<tr class="fu-sign-head"><td>Executed by</td><td colspan="2">Approved by</td><td>Closed MO by</td></tr>';
    html += '<tr class="fu-sign-box"><td></td><td colspan="2"></td><td></td></tr>';
    html += '<tr class="fu-sign-name">';
    html += '<td>Name: <input id="fu-executed-by" type="text"></td>';
    html += '<td colspan="2">Name: <input id="fu-approved-exec" type="text"></td>';
    html += '<td>Name: <input id="fu-closed-by" type="text"></td>';
    html += '</tr>';
    html += '<tr class="fu-sign-role"><td>Mechanic</td><td colspan="2">Supervisor</td><td>Planner</td></tr>';
    html += '<tr class="fu-sign-date"><td>Date:</td><td colspan="2">Date:</td><td>Date:</td></tr>';

    html += '</table>';
    html += '</div>';

    container.innerHTML = html;
    attachListeners();

    // Pulihkan isian manual (TTD, catatan aksi, dsb) dari sesi.
    loadFormFromSession();

    // Field turunan SELALU mengikuti unit aktif di filter Overview — kosongkan
    // dulu agar tidak menyisakan data unit sebelumnya bila pilihan berganti.
    ['fu-mo-desc', 'fu-equipment-no', 'fu-equipment-sn', 'fu-plan-hm', 'fu-problem-desc']
      .forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    fillFromSelection();
  }

  function attachListeners() {
    var box = el('portfolio-followup-container');
    if (box) box.addEventListener('change', saveFormToSession);
  }

  /**
   * Cetak formulir (dipanggil tombol tunggal "Cetak / Simpan PDF" di toolbar
   * Portofolio). Menandai body agar CSS @media print hanya menampilkan form.
   */
  function print() {
    saveFormToSession();

    // Nama berkas default pada dialog Save as PDF.
    var prevTitle = document.title;
    var eq = el('fu-equipment-no');
    var moDesc = el('fu-mo-desc');
    if (eq && eq.value) {
      try {
        document.title = 'Follow Up Input_' + eq.value +
          (moDesc && moDesc.value ? '_' + moDesc.value : '');
      } catch (e) {}
    }

    document.body.classList.add('printing-followup');
    var cleanup = function () {
      document.body.classList.remove('printing-followup');
      try { document.title = prevTitle; } catch (e) {}
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    try { window.print(); } catch (e) { cleanup(); }
  }

  /* -----------------------------------------------------------------------
   * Persist isian ke sessionStorage
   * --------------------------------------------------------------------- */
  var FIELD_IDS = ['fu-mo-no', 'fu-site', 'fu-mo-desc', 'fu-equipment-no', 'fu-notif-no',
    'fu-equipment-sn', 'fu-plan-date', 'fu-plan-hm', 'fu-malf-start', 'fu-pm-type',
    'fu-malf-end', 'fu-person', 'fu-sn-in', 'fu-problem-desc', 'fu-prepared-by',
    'fu-approved-by', 'fu-hm-smu', 'fu-execution-date', 'fu-action-notes',
    'fu-executed-by', 'fu-approved-exec', 'fu-closed-by'];

  function saveFormToSession() {
    var data = {};
    FIELD_IDS.forEach(function (id) { var e = el(id); if (e) data[id] = e.value; });
    try { sessionStorage.setItem('portfolio-followup-form', JSON.stringify(data)); } catch (e) {}
  }

  function loadFormFromSession() {
    try {
      var data = JSON.parse(sessionStorage.getItem('portfolio-followup-form') || '{}');
      FIELD_IDS.forEach(function (id) {
        var e = el(id);
        if (e && data[id] != null && data[id] !== '') e.value = data[id];
      });
    } catch (e) {}
  }

  global.PORTFOLIO_FOLLOWUP = {
    render: render,
    print: print,
    fillFromSelection: fillFromSelection,
    saveFormToSession: saveFormToSession,
    loadFormFromSession: loadFormFromSession
  };

})(window);

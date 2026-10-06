/* =========================================================================
 * vhms-settings.js
 * -------------------------------------------------------------------------
 * [PENGATURAN] Panel setting global:
 *   1) TEMA      — ganti tema tampilan (disimpan di localStorage).
 *   2) THRESHOLD — ubah ambang batas VHMS & SOS lewat UI (tanpa edit .js).
 *                  Perubahan disimpan di localStorage, lalu diterapkan dengan
 *                  me-render ulang analisa (thresholdSet di-snapshot per unit).
 *
 * Dimuat SETELAH vhms-cross-render.js (paling akhir) karena minimal
 * bergantung pada VHMS_CONFIG, SOS_CONFIG, VHMS_FLEET, SOS_STORE.
 * ========================================================================= */

(function (global) {
  'use strict';

  var vcfg = global.VHMS_CONFIG;
  var scfg = global.SOS_CONFIG;

  var THEME_KEY = 'oms.theme';
  var VTH_KEY = 'oms.thresholds.vhms.v1';
  var STH_KEY = 'oms.thresholds.sos.v1';
  // [BARU 2026-10-01] Override threshold per MODEL UNIT (SOS & VHMS terpisah).
  var VMODEL_KEY = 'oms.thresholds.vhms.model.v1';
  var SMODEL_KEY = 'oms.thresholds.sos.model.v1';

  /**
   * [FIX AUDIT 2026-10-04 · F-3] Kegagalan baca/tulis setelan tidak boleh
   * senyap: pengguna bisa kehilangan threshold tersimpan tanpa jejak apa pun.
   */
  function warnFail(konteks, e) {
    if (global.console && console.warn) console.warn('[VHMS_SETTINGS] ' + konteks + ':', e && e.message);
  }

  /* Tema yang tersedia: id → { label, desc, swatch[] } */
  var THEMES = [
    { id: 'slate',     label: 'Slate',          desc: 'Biru gelap klasik (default)', swatch: ['#0f172a', '#1e293b', '#22d3ee'] },
    { id: 'obsidian',  label: 'Obsidian',       desc: 'Hitam matte + champagne-gold', swatch: ['#0c0e13', '#1a1f29', '#d6b36a'] },
    { id: 'sapphire',  label: 'Sapphire',       desc: 'Biru royal + sky cerah',      swatch: ['#0a1226', '#16233f', '#38bdf8'] },
    { id: 'plum',      label: 'Plum Noir',      desc: 'Ungu gelap + aksen rose',     swatch: ['#150f1e', '#271b38', '#f472b6'] },
    { id: 'midnight',  label: 'Midnight',       desc: 'Biru malam pekat + indigo',   swatch: ['#0b1220', '#172036', '#818cf8'] },
    { id: 'carbon',    label: 'Carbon',         desc: 'Hitam netral + amber',        swatch: ['#131316', '#232329', '#fbbf24'] },
    { id: 'forest',    label: 'Forest',         desc: 'Hijau tua + lime',            swatch: ['#0c1a15', '#17332a', '#84cc16'] },
    { id: 'porcelain', label: 'Porcelain',      desc: 'Terang bersih + indigo',      swatch: ['#fafbfc', '#ffffff', '#6366f1'] },
    { id: 'light',     label: 'Nordic Light',   desc: 'Terang low-glare',            swatch: ['#eef2f7', '#ffffff', '#0284c7'] }
  ];

  /* Snapshot default threshold (untuk reset). VHMS per-keluarga. */
  var VHMS_DEFAULT = JSON.parse(JSON.stringify(vcfg.THRESHOLDS || {}));
  var VHMS_FAMILY_DEFAULT = {};
  (function () {
    var profs = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES) || {};
    Object.keys(profs).forEach(function (family) {
      if (profs[family] && profs[family].thresholds) {
        VHMS_FAMILY_DEFAULT[family] = JSON.parse(JSON.stringify(profs[family].thresholds));
      }
    });
  })();
  var SOS_DEFAULT = JSON.parse(JSON.stringify(scfg.THRESHOLDS || {}));

  /* ------------------------------ util ---------------------------------- */
  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML;
  }
  function $(id) { return document.getElementById(id); }

  /* =======================================================================
   * 1. TEMA
   * ===================================================================== */
  function applyTheme(id) {
    var valid = THEMES.some(function (t) { return t.id === id; });
    if (!valid) id = 'slate';
    if (id === 'slate') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', id);
    }
    try { localStorage.setItem(THEME_KEY, id); } catch (e) {}
    highlightThemeChoice(id);
  }

  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'slate'; } catch (e) { return 'slate'; }
  }

  function renderThemeGrid() {
    var grid = $('theme-grid');
    if (!grid) return;
    grid.innerHTML = THEMES.map(function (t) {
      var sw = t.swatch.map(function (c) {
        return '<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:' + c + ';border:1px solid rgba(255,255,255,.15)"></span>';
      }).join('');
      return '<button class="theme-card" data-theme-id="' + t.id + '" ' +
        'style="text-align:left;cursor:pointer;background:var(--card-2);border:1px solid var(--border-2);border-radius:12px;padding:12px;color:var(--text)">' +
        '<div style="display:flex;gap:6px;margin-bottom:8px">' + sw + '</div>' +
        '<div style="font-size:12.5px;font-weight:700">' + esc(t.label) + '</div>' +
        '<div style="font-size:10.5px;color:var(--text-mute);margin-top:2px">' + esc(t.desc) + '</div>' +
        '<div class="theme-check" style="margin-top:8px;font-size:10px;color:var(--accent);display:none"><i class="fa-solid fa-circle-check"></i> Aktif</div>' +
        '</button>';
    }).join('');
    grid.querySelectorAll('[data-theme-id]').forEach(function (b) {
      b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-id')); });
    });
  }

  function highlightThemeChoice(id) {
    var grid = $('theme-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-theme-id]').forEach(function (b) {
      var on = b.getAttribute('data-theme-id') === id;
      var chk = b.querySelector('.theme-check');
      if (chk) chk.style.display = on ? 'block' : 'none';
      b.style.borderColor = on ? 'var(--accent)' : 'var(--border-2)';
      b.style.boxShadow = on ? '0 0 0 2px var(--accent-soft)' : 'none';
    });
  }

  /* =======================================================================
   * 2. THRESHOLD
   * ===================================================================== */

  /* ---------------------------------------------------------------------
   * [MIGRASI SATUAN] Boost Pressure berpindah dari kPa -> mmHg (x7.50062).
   * Data threshold LAMA yang tersimpan di localStorage masih kPa (mis. 180).
   * Bila terdeteksi nilai boost "kecil" (< BOOST_MMHG_MIN) sementara satuan
   * baru mmHg (ratusan-ribuan), konversi otomatis agar tidak menimpa config
   * mmHg dengan nilai kPa lama.
   * ------------------------------------------------------------------- */
  var BOOST_KEY = 'boostMax';
  var KPA_TO_MMHG = 7.50062;
  var BOOST_MMHG_MIN = 500;   // ambang deteksi: nilai < 500 hampir pasti kPa
  function migrateBoostThreshold(th) {
    if (!th || typeof th.warn !== 'number') return false;
    if (th.warn >= BOOST_MMHG_MIN) return false;   // sudah mmHg / wajar
    function conv(x) { return (typeof x === 'number') ? Math.round(x * KPA_TO_MMHG * 10) / 10 : x; }
    th.warn = conv(th.warn);
    th.crit = conv(th.crit);
    if (typeof th.extreme === 'number') th.extreme = conv(th.extreme);
    if (typeof th.warn_low === 'number') th.warn_low = conv(th.warn_low);
    if (typeof th.crit_low === 'number') th.crit_low = conv(th.crit_low);
    return true;
  }

  /**
   * Muat override tersimpan & tempel ke objek config (in-place).
   * VHMS disimpan per-keluarga: { BASE: {...}, DOZER: {...}, ... } agar
   * menyasar objek PROFILES[family].thresholds yang benar.
   */
  function loadThresholds() {
    try {
      var vSaved = JSON.parse(localStorage.getItem(VTH_KEY) || 'null');
      if (vSaved) {
        // Format baru (per-keluarga): nilai berupa objek bersarang.
        // Format lama (flat): langsung map paramKey -> {warn, crit,...}.
        var isFlat = vSaved && !vSaved.__perFamily &&
          Object.keys(vSaved).some(function (k) { return vSaved[k] && typeof vSaved[k] === 'object' && ('warn' in vSaved[k] || 'crit' in vSaved[k] || 'mode' in vSaved[k]); });
        if (isFlat) {
          // Kompatibilitas: terapkan ke base config.
          Object.keys(vSaved).forEach(function (k) {
            if (vcfg.THRESHOLDS[k]) {
              if (k === BOOST_KEY) migrateBoostThreshold(vSaved[k]);
              Object.assign(vcfg.THRESHOLDS[k], vSaved[k]);
            }
          });
        } else {
          Object.keys(vSaved).forEach(function (family) {
            if (family === '__perFamily') return;
            var set = vhmsThresholdSetFor(family);
            var saved = vSaved[family] || {};
            Object.keys(saved).forEach(function (k) {
              if (k === BOOST_KEY) migrateBoostThreshold(saved[k]);
              if (set[k]) Object.assign(set[k], saved[k]);
              else set[k] = saved[k];
            });
          });
        }
      }
      var sSaved = JSON.parse(localStorage.getItem(STH_KEY) || 'null');
      if (sSaved) Object.keys(sSaved).forEach(function (comp) {
        if (scfg.THRESHOLDS[comp]) {
          Object.keys(sSaved[comp]).forEach(function (pk) {
            if (scfg.THRESHOLDS[comp][pk]) Object.assign(scfg.THRESHOLDS[comp][pk], sSaved[comp][pk]);
            else scfg.THRESHOLDS[comp][pk] = sSaved[comp][pk];
          });
        }
      });
      // [BARU 2026-10-01] Muat override threshold per MODEL unit (SOS & VHMS).
      loadModelThresholds();
    } catch (e) { /* abai */ }
  }

  /* -----------------------------------------------------------------------
   * [BARU 2026-10-01] OVERRIDE THRESHOLD PER MODEL UNIT — muat & simpan.
   * ---------------------------------------------------------------------
   * Disimpan terpisah per modul (SOS & VHMS) sebagai:
   *   { "HD785": { "ENGINE": { wear_fe: {warn,crit,extreme} } }, ... }
   * Tempel in-place ke MODEL_THRESHOLDS milik SOS_CONFIG / VHMS_CONFIG.
   * ------------------------------------------------------------------- */
  function loadModelThresholds() {
    try {
      var s = JSON.parse(localStorage.getItem(SMODEL_KEY) || 'null');
      if (s && typeof s === 'object' && scfg.MODEL_THRESHOLDS) {
        Object.keys(s).forEach(function (m) { scfg.MODEL_THRESHOLDS[m] = s[m]; });
      }
    } catch (e) { warnFail('muat MODEL_THRESHOLDS SOS', e); }
    try {
      var v = JSON.parse(localStorage.getItem(VMODEL_KEY) || 'null');
      if (v && typeof v === 'object' && vcfg.MODEL_THRESHOLDS) {
        Object.keys(v).forEach(function (m) { vcfg.MODEL_THRESHOLDS[m] = v[m]; });
      }
    } catch (e) { warnFail('muat MODEL_THRESHOLDS VHMS', e); }
  }

  function persistModelThresholds() {
    try { localStorage.setItem(SMODEL_KEY, JSON.stringify(scfg.MODEL_THRESHOLDS || {})); } catch (e) {}
    try { localStorage.setItem(VMODEL_KEY, JSON.stringify(vcfg.MODEL_THRESHOLDS || {})); } catch (e) {}
  }

  /* -----------------------------------------------------------------------
   * VALIDASI THRESHOLD
   * ---------------------------------------------------------------------
   * Aturan:
   *   - Angka valid: bukan NaN, bukan negatif.
   *   - Urutan HIGH (makin besar makin bahaya): warn <= crit <= extreme.
   *   - Urutan LOW (makin kecil makin bahaya): warn_low >= crit_low.
   *   - Peringatan deviasi: nilai model menyimpang > DEVIATION_PCT dari
   *     default kompartemen/keluarga.
   * Mengembalikan { errors:[], warnings:[] } (pesan berbahasa Indonesia).
   * ------------------------------------------------------------------- */
  var DEVIATION_PCT = 50;   // ambang peringatan penyimpangan (%)

  function validateThresholdEntry(th, opts) {
    opts = opts || {};
    var errors = [], warnings = [];
    if (!th || typeof th !== 'object') { return { errors: ['Nilai threshold kosong/tidak valid.'], warnings: warnings }; }
    var isLow = (th.warn_low !== undefined || th.crit_low !== undefined);
    var nums = ['warn', 'crit', 'extreme', 'warn_low', 'crit_low', 'warn_high', 'crit_high'];
    nums.forEach(function (f) {
      var v = th[f];
      if (v === undefined || v === null || v === '') return;
      var n = parseFloat(v);
      if (isNaN(n)) { errors.push('Kolom "' + f + '" bukan angka yang valid.'); return; }
      if (n < 0) errors.push('Kolom "' + f + '" tidak boleh negatif (' + n + ').');
    });

    if (isLow) {
      var wl = parseFloat(th.warn_low), cl = parseFloat(th.crit_low);
      if (!isNaN(wl) && !isNaN(cl) && cl > wl) {
        errors.push('Urutan LOW salah: Crit Low (' + cl + ') harus <= Warn Low (' + wl + ').');
      }
    } else {
      var w = parseFloat(th.warn), c = parseFloat(th.crit), e = parseFloat(th.extreme);
      if (!isNaN(w) && !isNaN(c) && c < w) {
        errors.push('Urutan salah: Crit (' + c + ') harus >= Warn (' + w + ').');
      }
      if (!isNaN(c) && !isNaN(e) && e < c) {
        errors.push('Urutan salah: Extreme (' + e + ') harus >= Crit (' + c + ').');
      }
      if (th.mode === 'low') {
        // Mode low: makin kecil makin bahaya -> warn >= crit.
        if (!isNaN(w) && !isNaN(c) && c > w && !isNaN(c)) {
          errors.push('Mode LOW: Crit (' + c + ') harus <= Warn (' + w + ').');
        }
      }
    }

    // Peringatan deviasi vs default.
    var base = opts.base;
    if (base && typeof base === 'object') {
      ['warn', 'crit', 'extreme', 'warn_low', 'crit_low'].forEach(function (f) {
        var nv = parseFloat(th[f]); var bv = parseFloat(base[f]);
        if (isNaN(nv) || isNaN(bv) || bv === 0) return;
        var pct = Math.abs(nv - bv) / Math.abs(bv) * 100;
        if (pct > DEVIATION_PCT) {
          warnings.push('"' + f + '" menyimpang ' + Math.round(pct) + '% dari default (' + bv + ').');
        }
      });
    }
    return { errors: errors, warnings: warnings };
  }

  /** Validasi seluruh set threshold {paramKey:{...}} vs default. */
  function validateThresholdSet(set, baseSet) {
    var out = { errors: [], warnings: [] };
    Object.keys(set || {}).forEach(function (pk) {
      var base = baseSet ? baseSet[pk] : null;
      var r = validateThresholdEntry(set[pk], { base: base });
      r.errors.forEach(function (m) { out.errors.push(pk + ': ' + m); });
      r.warnings.forEach(function (m) { out.warnings.push(pk + ': ' + m); });
    });
    return out;
  }

  /** Simpan seluruh threshold yang sekarang ke localStorage. */
  function persistThresholds() {
    try {
      var vOut = { __perFamily: true };
      var profs = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES) || {};
      var seen = {};
      Object.keys(profs).forEach(function (family) {
        if (profs[family] && profs[family].thresholds) {
          vOut[family] = profs[family].thresholds;
          seen[family] = true;
        }
      });
      // Simpan juga base config (untuk unit tanpa profil / fallback).
      vOut.BASE = vcfg.THRESHOLDS;
      localStorage.setItem(VTH_KEY, JSON.stringify(vOut));
    } catch (e) { warnFail('simpan THRESHOLDS VHMS', e); }
    try { localStorage.setItem(STH_KEY, JSON.stringify(scfg.THRESHOLDS)); } catch (e) { warnFail('simpan THRESHOLDS SOS', e); }
    // [BARU 2026-10-01] Simpan juga override per MODEL unit (SOS & VHMS).
    persistModelThresholds();
  }

  /* -----------------------------------------------------------------------
   * 2b-1. EKSPOR / IMPOR THRESHOLD (JSON)
   * ---------------------------------------------------------------------
   * Memudahkan memindahkan / mencadangkan pengaturan threshold.
   * Format berkas: { version, savedAt, vhms: {...perFamily}, sos: {...} }
   * --------------------------------------------------------------------- */
  function buildExportObject() {
    var vhmsOut = { __perFamily: true };
    var profs = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES) || {};
    Object.keys(profs).forEach(function (family) {
      if (profs[family] && profs[family].thresholds) vhmsOut[family] = profs[family].thresholds;
    });
    vhmsOut.BASE = vcfg.THRESHOLDS;
    return {
      app: 'Reliability Based Maintenance — OMS/SOS',
      version: 1,
      savedAt: new Date().toISOString(),
      vhms: vhmsOut,
      sos: scfg.THRESHOLDS
    };
  }

  /** Unduh berkas JSON berisi seluruh threshold & prioritas. */
  function exportThresholds() {
    try {
      var payload = buildExportObject();
      payload.followup = { status: vcfg.FOLLOWUP_STATUS };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'threshold-settings-' + ts + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Threshold diekspor ke berkas JSON.', 'ok');
    } catch (e) {
      toast('Gagal mengekspor: ' + (e && e.message), 'err');
    }
  }

  /* ---------------------------------------------------------------------
   * EKSPOR CSV — format tabular (mudah diedit di Excel/spreadsheet).
   * Kolom: type;scope;param;warn;crit;extreme;warn_low;crit_low;mode;label
   *   type  : VHMS | SOS
   *   scope : nama keluarga (VHMS) atau kompartemen (SOS)
   * ------------------------------------------------------------------- */
  // [FIX AUDIT 2026-10-04 · E-4] Satu implementasi escape CSV (js/csv-util.js).
  var csvEscape = (global.CSV_UTIL && global.CSV_UTIL.csvEscape) || function (v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[;",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function exportThresholdsCsv() {
    try {
      var rows = [['type', 'scope', 'param', 'warn', 'crit', 'extreme', 'warn_low', 'crit_low', 'mode', 'label']];
      // VHMS per keluarga
      var profs = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES) || {};
      Object.keys(profs).forEach(function (family) {
        var set = (profs[family] && profs[family].thresholds) || {};
        Object.keys(set).forEach(function (k) {
          var t = set[k] || {};
          rows.push(['VHMS', family, k, t.warn, t.crit, t.extreme, t.warn_low, t.crit_low, t.mode || '', t.label || '']);
        });
      });
      // SOS per kompartemen
      Object.keys(scfg.THRESHOLDS || {}).forEach(function (comp) {
        var set = scfg.THRESHOLDS[comp] || {};
        Object.keys(set).forEach(function (pk) {
          var t = set[pk] || {};
          rows.push(['SOS', comp, pk, t.warn, t.crit, t.extreme, t.warn_low, t.crit_low, t.mode || '', t.label || '']);
        });
      });
      var csv = rows.map(function (r) { return r.map(csvEscape).join(';'); }).join('\r\n');
      var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });  // BOM utk Excel
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var ts = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = 'threshold-settings-' + ts + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Threshold diekspor ke berkas CSV.', 'ok');
    } catch (e) {
      toast('Gagal mengekspor CSV: ' + (e && e.message), 'err');
    }
  }

  /**
   * Impor dari CSV (hasil ekspor / suntingan Excel). Baris header dideteksi
   * otomatis. Pemisah: ; atau , atau tab.
   */
  function importThresholdsCsv(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) throw new Error('CSV kosong / tidak valid.');
    function splitLine(line) {
      var delim = (line.indexOf(';') !== -1) ? ';' : (line.indexOf('\t') !== -1 ? '\t' : ',');
      var out = [], cur = '', inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQ) {
          if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
          else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(function (v) { return v.trim(); });
    }
    var header = splitLine(lines[0]).map(function (h) { return h.toLowerCase().replace(/[^a-z_]/g, ''); });
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    if (idx.type === undefined || idx.scope === undefined || idx.param === undefined) {
      throw new Error('Header CSV wajib: type;scope;param;warn;crit;...');
    }
    function num(v) { if (v === undefined || v === '') return undefined; var n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? undefined : n; }

    var applied = { vhms: 0, sos: 0, followup: false };
    for (var r = 1; r < lines.length; r++) {
      var c = splitLine(lines[r]);
      var type = (c[idx.type] || '').toUpperCase();
      var scope = c[idx.scope] || '';
      var param = c[idx.param] || '';
      if (!type || !scope || !param) continue;
      var patch = {};
      ['warn', 'crit', 'extreme', 'warn_low', 'crit_low'].forEach(function (f) {
        if (idx[f] !== undefined) { var v = num(c[idx[f]]); if (v !== undefined) patch[f] = v; }
      });
      if (idx.mode !== undefined && c[idx.mode]) patch.mode = c[idx.mode];
      if (idx.label !== undefined && c[idx.label]) patch.label = c[idx.label];

      if (type === 'VHMS') {
        var set = vhmsThresholdSetFor(scope);
        if (set[param]) Object.assign(set[param], patch); else set[param] = patch;
        applied.vhms++;
      } else if (type === 'SOS') {
        if (!scfg.THRESHOLDS[scope]) scfg.THRESHOLDS[scope] = {};
        if (scfg.THRESHOLDS[scope][param]) Object.assign(scfg.THRESHOLDS[scope][param], patch);
        else scfg.THRESHOLDS[scope][param] = patch;
        applied.sos++;
      }
    }
    if (!applied.vhms && !applied.sos) throw new Error('Tidak ada baris threshold yang dikenali.');
    persistThresholds();
    reanalyzeAll();
    return applied;
  }

  /**
   * Impor threshold dari objek JSON (hasil export). Mengganti seluruh
   * threshold VHMS & SOS, lalu menyimpan permanen & menganalisis ulang.
   * @param {object} data  objek hasil export (punya .vhms &/atau .sos)
   */
  function applyImported(data) {
    if (!data || typeof data !== 'object') throw new Error('Berkas tidak valid.');
    var applied = { vhms: 0, sos: 0, followup: false };

    // --- VHMS (per-keluarga) ---
    if (data.vhms && typeof data.vhms === 'object') {
      var vhms = data.vhms;
      Object.keys(vhms).forEach(function (family) {
        if (family === '__perFamily') return;
        var set = vhmsThresholdSetFor(family);
        var saved = vhms[family] || {};
        Object.keys(saved).forEach(function (k) {
          if (set[k]) Object.assign(set[k], saved[k]);
          else set[k] = saved[k];
          applied.vhms++;
        });
      });
      // Format alternatif: file hanya berisi map flat (tanpa __perFamily)
      if (!vhms.__perFamily && !Object.keys(vhms).some(function (f) { return global.VHMS_PROFILES.PROFILES[f]; })) {
        Object.keys(vhms).forEach(function (k) {
          if (vcfg.THRESHOLDS[k]) { Object.assign(vcfg.THRESHOLDS[k], vhms[k]); applied.vhms++; }
        });
      }
    }

    // --- SOS (per-kompartemen) ---
    if (data.sos && typeof data.sos === 'object') {
      Object.keys(data.sos).forEach(function (comp) {
        if (!scfg.THRESHOLDS[comp]) scfg.THRESHOLDS[comp] = {};
        var saved = data.sos[comp] || {};
        Object.keys(saved).forEach(function (pk) {
          if (scfg.THRESHOLDS[comp][pk]) Object.assign(scfg.THRESHOLDS[comp][pk], saved[pk]);
          else scfg.THRESHOLDS[comp][pk] = saved[pk];
          applied.sos++;
        });
      });
    }

    // --- Status & SLA (opsional) ---
    // Format baru: { followup: { STATUS: {...} } }  atau { followup: { map... } } lama.
    var fup = data.followup;
    if (fup && (fup.status || fup.map)) {
      var src = fup.status || fup.map;
      Object.keys(src).forEach(function (k) {
        // Abaikan key numerik lama (severity) yang tak relevan.
        if (vcfg.FOLLOWUP_STATUS[k]) Object.assign(vcfg.FOLLOWUP_STATUS[k], src[k]);
        else vcfg.FOLLOWUP_STATUS[k] = src[k];
      });
      persistFollowup();
      applied.followup = true;
    }

    if (!applied.vhms && !applied.sos && !applied.followup) {
      throw new Error('Tidak ada threshold yang dikenali pada berkas.');
    }
    persistThresholds();
    reanalyzeAll();
    return applied;
  }

  /** Baca berkas (JSON atau CSV) lalu terapkan. */
  function importThresholdsFromFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var text = String(e.target.result || '');
        var isJson = /\.json$/i.test(file.name) || /^\s*[\{\[]/.test(text);
        var res;
        if (isJson) {
          res = applyImported(JSON.parse(text));
        } else {
          res = importThresholdsCsv(text);
        }
        renderVhmsThresholdTable();
        renderSosComponentOptions();
        var ss = $('sos-threshold-component');
        if (ss) renderSosThresholdTable(ss.value || Object.keys(scfg.THRESHOLDS)[0]);
        renderFollowupTable();
        toast('Threshold diimpor: VHMS ' + res.vhms + ' entri, SOS ' + res.sos + ' entri.', 'ok');
      } catch (err) {
        toast('Gagal impor: ' + (err && err.message), 'err');
      }
    };
    reader.onerror = function () { toast('Gagal membaca berkas.', 'err'); };
    reader.readAsText(file);
  }

  /* -----------------------------------------------------------------------
   * 2c. STATUS & SLA (Tindak Lanjut) — 3 level: NORMAL/CAUTION/CRITICAL -> SLA
   * --------------------------------------------------------------------- */
  var FUP_KEY = 'oms.followup.priority.v1';
  var FUP_STATUS_KEY = 'oms.followup.status.v1';
  // Default status (disalin dari config saat boot).
  var FUP_STATUS_DEFAULT = JSON.parse(JSON.stringify(vcfg.FOLLOWUP_STATUS || {}));

  /**
   * [MIGRASI 2026-10-03] Data localStorage lama masih memakai kunci
   * MONITOR/WARNING. Pindahkan nilainya ke CAUTION agar tidak muncul baris
   * status usang di tabel Pengaturan.
   */
  function migrateFollowup(saved) {
    if (!saved || typeof saved !== 'object') return saved;
    var out = {};
    Object.keys(saved).forEach(function (k) {
      var key = String(k).toUpperCase();
      if (key === 'MONITOR' || key === 'WARNING') key = 'CAUTION';
      else if (key === 'EXTREME') key = 'CRITICAL';
      // CAUTION menang atas MONITOR/WARNING (lebih terlihat / lebih baru).
      if (!out[key] || key !== 'CAUTION') out[key] = saved[k];
    });
    return out;
  }

  /** Muat status & SLA tersimpan (bila ada) ke vcfg.FOLLOWUP_STATUS. */
  function loadFollowup() {
    try {
      // Muat format BARU (status-based) bila ada.
      var savedStatus = migrateFollowup(JSON.parse(localStorage.getItem(FUP_STATUS_KEY) || 'null'));
      if (savedStatus) {
        // Bersihkan kunci usang dari config sebelum menerapkan yang tersimpan.
        ['MONITOR', 'WARNING', 'EXTREME'].forEach(function (k) { delete vcfg.FOLLOWUP_STATUS[k]; });
        Object.keys(savedStatus).forEach(function (k) {
          if (vcfg.FOLLOWUP_STATUS[k]) Object.assign(vcfg.FOLLOWUP_STATUS[k], savedStatus[k]);
          else vcfg.FOLLOWUP_STATUS[k] = savedStatus[k];
        });
      }
    } catch (e) { warnFail('muat FOLLOWUP_STATUS', e); }
  }

  /** Simpan status & SLA ke localStorage. */
  function persistFollowup() {
    try { localStorage.setItem(FUP_STATUS_KEY, JSON.stringify(vcfg.FOLLOWUP_STATUS)); } catch (e) {}
  }

  /** Render tabel status & SLA (Critical/Caution/Normal). */
  function renderFollowupTable() {
    var body = $('followup-priority-body');
    if (!body) return;
    var map = vcfg.FOLLOWUP_STATUS || {};
    // [STANDARISASI 2026-10-03] Urut 3 level: CRITICAL, CAUTION, NORMAL.
    var order = ['CRITICAL', 'CAUTION', 'NORMAL'].filter(function (k) { return map[k]; });
    Object.keys(map).forEach(function (k) { if (order.indexOf(k) === -1) order.push(k); });
    var h = '';
    order.forEach(function (st) {
      var p = map[st] || {};
      h += '<tr data-status="' + esc(st) + '">' +
        '<td class="center"><span class="pf-badge ' + esc(p.cls || '') + '">' + esc(p.label || st) + '</span></td>' +
        '<td><input type="text" data-field="sla" value="' + esc(p.sla || '') + '" style="width:100%"></td>' +
        '</tr>';
    });
    body.innerHTML = h;
  }

  /** Baca tabel status dari UI ke vcfg.FOLLOWUP_STATUS. */
  function collectFollowup() {
    var body = $('followup-priority-body');
    if (!body) return;
    body.querySelectorAll('tr[data-status]').forEach(function (tr) {
      var st = tr.getAttribute('data-status');
      var p = vcfg.FOLLOWUP_STATUS[st] || {};
      var sla = tr.querySelector('[data-field="sla"]');
      if (sla) p.sla = sla.value.trim();
      if (!p.label) p.label = st;
      vcfg.FOLLOWUP_STATUS[st] = p;
    });
  }

  /**
   * Ambil objek threshold VHMS yang aktif untuk sebuah keluarga.
   * Unit dengan profil keluarga memakai PROFILES[family].thresholds
   * (objek terpisah dari vcfg.THRESHOLDS), sehingga editor harus menyasar
   * objek tersebut agar perubahan benar-benar berlaku.
   */
  function vhmsThresholdSetFor(family) {
    var p = global.VHMS_PROFILES;
    if (p && p.PROFILES && p.PROFILES[family] && p.PROFILES[family].thresholds) {
      return p.PROFILES[family].thresholds;
    }
    return vcfg.THRESHOLDS;
  }

  /** Isi dropdown keluarga VHMS. */
  function renderVhmsFamilyOptions() {
    var sel = $('vhms-threshold-family');
    if (!sel) return;
    var fams = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES)
      ? Object.keys(global.VHMS_PROFILES.PROFILES)
      : ['EXCAVATOR', 'TRUCK', 'DOZER', 'UNKNOWN'];
    var cur = sel.value;
    sel.innerHTML = fams.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('');
    if (fams.indexOf(cur) >= 0) sel.value = cur;
  }

  /** Render tabel threshold VHMS untuk keluarga terpilih. */
  function renderVhmsThresholdTable() {
    var body = $('vhms-threshold-body');
    if (!body) return;
    var sel = $('vhms-threshold-family');
    var family = sel ? sel.value : null;
    var set = vhmsThresholdSetFor(family);
    // [REVISI #15] Kelompokkan baris threshold menurut arah degradasi
    // HIGH (makin besar makin bahaya) vs LOW (makin kecil makin bahaya),
    // memakai helper dari vhms-config. Tabel jadi lebih mudah dibaca.
    var groups = (vcfg.groupByDirection) ? vcfg.groupByDirection(set) : { HIGH: Object.keys(set), LOW: [] };
    var order = ['HIGH', 'LOW'];
    var html = '';
    order.forEach(function (grp) {
      var keys = groups[grp] || [];
      if (!keys.length) return;
      var label = (vcfg.DIRECTION_LABELS && vcfg.DIRECTION_LABELS[grp]) || ('Grup ' + grp);
      var badgeColor = (grp === 'HIGH') ? '#f87171' : '#38bdf8';
      html += '<tr class="th-group-row"><td colspan="5" style="background:rgba(2,6,23,.85);' +
        'color:' + badgeColor + ';font-weight:700;font-size:11px;letter-spacing:.5px;text-transform:uppercase;' +
        'padding:8px 10px;border-top:1px solid var(--border-2)">' +
        '<i class="fa-solid fa-' + (grp === 'HIGH' ? 'arrow-trend-up' : 'arrow-trend-down') + '"></i> ' +
        esc(label) + ' (' + keys.length + ')</td></tr>';
      html += keys.map(function (k) {
        var th = set[k] || {};
        return '<tr data-vth="' + esc(k) + '">' +
          '<td><strong>' + esc(k) + '</strong></td>' +
          '<td class="center"><input type="number" step="any" data-field="warn" value="' + (th.warn != null ? th.warn : '') + '" style="width:90px"></td>' +
          '<td class="center"><input type="number" step="any" data-field="crit" value="' + (th.crit != null ? th.crit : '') + '" style="width:90px"></td>' +
          '<td class="center"><select data-field="mode" style="width:80px">' +
            '<option value="high"' + (th.mode === 'high' ? ' selected' : '') + '>high</option>' +
            '<option value="low"' + (th.mode === 'low' ? ' selected' : '') + '>low</option>' +
          '</select></td>' +
          '<td><input type="text" data-field="label" value="' + esc(th.label || '') + '" style="width:100%"></td>' +
          '</tr>';
      }).join('');
    });
    body.innerHTML = html;
  }

  function collectVhmsThresholds() {
    var sel = $('vhms-threshold-family');
    var family = sel ? sel.value : null;
    var set = vhmsThresholdSetFor(family);
    document.querySelectorAll('#vhms-threshold-body tr[data-vth]').forEach(function (tr) {
      var k = tr.getAttribute('data-vth');
      var th = set[k]; if (!th) return;
      tr.querySelectorAll('[data-field]').forEach(function (inp) {
        var f = inp.getAttribute('data-field');
        if (f === 'mode' || f === 'label') th[f] = inp.value;
        else {
          var v = parseFloat(inp.value);
          if (!isNaN(v)) th[f] = v;
        }
      });
    });
  }

  /** Isi dropdown kompartemen SOS. */
  function renderSosComponentOptions() {
    var sel = $('sos-threshold-component');
    if (!sel) return;
    var comps = Object.keys(scfg.THRESHOLDS);
    sel.innerHTML = comps.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  }

  function renderSosThresholdTable(comp) {
    var body = $('sos-threshold-body');
    if (!body) return;
    var set = scfg.THRESHOLDS[comp] || {};
    var keys = Object.keys(set);
    body.innerHTML = keys.map(function (k) {
      var th = set[k] || {};
      function inp(field, w) {
        var v = th[field];
        return '<input type="number" step="any" data-field="' + field + '" value="' + (v != null ? v : '') + '" style="width:' + (w || 84) + 'px">';
      }
      return '<tr data-sth="' + esc(k) + '">' +
        '<td><strong>' + esc((scfg.PARAMS[k] || {}).label || k) + '</strong> <span style="color:var(--text-mute);font-size:10px">' + esc(k) + '</span></td>' +
        '<td class="center">' + inp('warn') + '</td>' +
        '<td class="center">' + inp('crit') + '</td>' +
        '<td class="center">' + inp('extreme') + '</td>' +
        '<td class="center">' + inp('warn_low') + '</td>' +
        '<td class="center">' + inp('crit_low') + '</td>' +
        '</tr>';
    }).join('');
  }

  function collectSosThresholds(comp) {
    var set = scfg.THRESHOLDS[comp] || {};
    document.querySelectorAll('#sos-threshold-body tr[data-sth]').forEach(function (tr) {
      var k = tr.getAttribute('data-sth');
      var th = set[k] = set[k] || {};
      tr.querySelectorAll('[data-field]').forEach(function (inp) {
        var f = inp.getAttribute('data-field');
        var raw = inp.value;
        if (raw === '') { delete th[f]; return; }
        var v = parseFloat(raw);
        th[f] = isNaN(v) ? raw : v;
      });
    });
  }

  /**
   * Terapkan threshold baru ke seluruh data yang sudah dimuat dengan
   * me-render ulang analisa (karena thresholdSet di-snapshot saat analyze()).
   */
  function reanalyzeAll() {
    var vf = global.VHMS_FLEET;
    if (vf && vf.reanalyzeAll) {
      try { vf.reanalyzeAll(); } catch (e) { console.warn('reanalyze VHMS gagal:', e); }
    }
    var ss = global.SOS_STORE;
    if (ss && ss.reanalyze) {
      try { ss.reanalyze(); } catch (e) { console.warn('reanalyze SOS gagal:', e); }
    }
    // Segarkan tampilan sesuai mode aktif.
    if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.refresh) {
      try { global.VHMS_SOS_MODE.refresh(); } catch (e) {}
    } else if (global.VHMS_APP && global.VHMS_APP.refreshCurrent) {
      try { global.VHMS_APP.refreshCurrent(); } catch (e) {}
    }
  }

  function toast(msg, type) {
    var fn = (global.VHMS_APP && global.VHMS_APP.toast) || (global.SOS_APP && global.SOS_APP.toast);
    if (fn) fn(msg, type || 'ok'); 
  }

  /* =======================================================================
   * 3. UI WIRING
   * ===================================================================== */

  /* -----------------------------------------------------------------------
   * [CLC 2026-10-04] Panel Filter Umur Komponen.
   * --------------------------------------------------------------------- */
  function _clc() { return global.COMPONENT_LIFE || null; }

  function renderClcPanel() {
    var clc = _clc();
    var cb = $('clc-enabled');
    var tol = $('clc-tolerance');
    var showCut = $('clc-show-cut');
    var status = $('clc-settings-status');
    if (cb) cb.checked = !!(clc && clc.isEnabled());
    if (tol) tol.value = clc ? clc.getTolerance() : 500;
    if (showCut) showCut.checked = !!(clc && clc.isShowCut && clc.isShowCut());
    if (status) {
      if (!clc) { status.textContent = 'Modul filter belum termuat.'; return; }
      var store = global.PORTFOLIO_STORE;
      var meta = store && store.lifetimeMeta ? store.lifetimeMeta() : null;
      if (!meta || !meta.count) {
        status.innerHTML = '<i class="fa-solid fa-triangle-exclamation u-text-warn"></i> ' +
          'Data <strong>Lifetime Unit</strong> belum dimuat — filter tidak dapat bekerja. ' +
          'Unggah file Lifetime di halaman Portofolio terlebih dahulu.';
      } else {
        var loaded = meta.loadedAt ? new Date(meta.loadedAt) : null;
        var ageDays = loaded ? Math.floor((Date.now() - loaded.getTime()) / 86400000) : null;
        var warnOld = (ageDays !== null && ageDays > 30);
        status.innerHTML = 'Data Lifetime: <strong>' + meta.count + ' baris</strong>' +
          (loaded ? ' (dimuat ' + ageDays + ' hari lalu)' : '') +
          (warnOld ? ' <span class="u-text-warn"><i class="fa-solid fa-triangle-exclamation"></i> data mungkin kedaluwarsa (&gt;30 hari)</span>' : '');
      }
    }
  }

  function switchTab(tab) {
    ['theme', 'vhms-threshold', 'sos-threshold', 'prioritas', 'clc'].forEach(function (t) {
      var p = $('settings-panel-' + t);
      if (p) p.classList.toggle('hidden', t !== tab);
    });
    document.querySelectorAll('#settings-tabs .subtab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-settings-tab') === tab);
    });
    if (tab === 'vhms-threshold') { renderVhmsFamilyOptions(); renderVhmsThresholdTable(); refreshVhmsModelList(); renderVhmsModelTable(); }
    if (tab === 'sos-threshold') {
      renderSosComponentOptions();
      var sel = $('sos-threshold-component');
      if (sel) renderSosThresholdTable(sel.value || Object.keys(scfg.THRESHOLDS)[0]);
      refreshSosModelList(); renderSosModelTable();
    }
    if (tab === 'prioritas') { renderFollowupTable(); }
    if (tab === 'clc') { renderClcPanel(); }
  }

  function openSettings() {
    var m = $('settings-modal');
    if (!m) return;
    renderThemeGrid();
    highlightThemeChoice(currentTheme());
    m.classList.remove('hidden');
    document.body.classList.add('modal-open');
    switchTab('theme');
  }

  function closeSettings() {
    var m = $('settings-modal');
    if (m) m.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  /* -----------------------------------------------------------------------
   * [BOOT] Terapkan tema & threshold tersimpan SEGERA saat script dimuat.
   * PENTING: harus jalan SEBELUM vhms-app.init() memanggil fleet.restore()
   * (yang menganalisa data). Karena settings dimuat paling akhir &
   * app menunggu DOMContentLoaded, eksekusi langsung di sini menjamin
   * threshold sudah terpasang saat analisa pertama berjalan.
   * --------------------------------------------------------------------- */
  applyTheme(currentTheme());
  loadThresholds();
  loadFollowup();

  /* =======================================================================
   * 2c. UI THRESHOLD PER MODEL UNIT (SOS & VHMS)
   * =====================================================================
   * Menyediakan:
   *   - daftar model otomatis dari data terunggah + model yang sudah punya
   *     override (datalist);
   *   - tabel editor override (kolom mengikuti struktur param SOS/VHMS);
   *   - tombol Tambah/Muat, Hapus, Simpan;
   *   - validasi urutan/angka/deviasi sebelum menyimpan.
   * ===================================================================== */

  /** Kumpulkan daftar model dari data SOS terunggah. */
  function sosModelsFromData() {
    var set = {};
    try {
      var st = global.SOS_STORE;
      var all = (st && st.getAllUnits) ? st.getAllUnits() : [];
      all.forEach(function (u) { if (u && u.model) set[u.model] = 1; });
    } catch (e) {}
    return Object.keys(set);
  }

  /** Kumpulkan daftar model dari data VHMS terunggah. */
  function vhmsModelsFromData() {
    var set = {};
    try {
      var fl = global.VHMS_FLEET;
      var ids = (fl && fl.ids) ? fl.ids() : [];
      ids.forEach(function (id) {
        var a = fl.getAnalysis ? fl.getAnalysis(id) : null;
        var m = a && a.meta && a.meta.model;
        if (m) set[m] = 1;
      });
    } catch (e) {}
    return Object.keys(set);
  }

  function uniqSorted(arr) {
    var set = {};
    (arr || []).forEach(function (x) { if (x) set[String(x).trim()] = 1; });
    return Object.keys(set).sort();
  }

  /* --- SOS model --- */
  function refreshSosModelList() {
    var dl = $('sos-model-list');
    var models = uniqSorted(sosModelsFromData().concat(scfg.listModelKeys ? scfg.listModelKeys() : []));
    if (dl) dl.innerHTML = models.map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('');
    var sel = $('sos-model-component');
    if (sel && !sel.options.length) {
      sel.innerHTML = Object.keys(scfg.THRESHOLDS).map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    }
  }

  /** Render tabel editor override SOS untuk (model, kompartemen). */
  function renderSosModelTable() {
    var body = $('sos-model-threshold-body');
    if (!body) return;
    var model = ($('sos-model-name') ? $('sos-model-name').value : '').trim();
    var comp = $('sos-model-component') ? $('sos-model-component').value : '';
    var base = scfg.getThresholdsFor(comp);   // threshold kompartemen (default)
    var overrides = (scfg.modelOverride ? scfg.modelOverride(model, comp) : {}) || {};
    var keys = Object.keys(base);
    // Tambahkan param yang hanya ada di override model.
    Object.keys(overrides).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });

    var chip = $('sos-model-chip');
    if (chip) {
      var hasOv = Object.keys(overrides).length;
      chip.innerHTML = model
        ? (hasOv ? '<i class="fa-solid fa-circle-check" style="color:#4ade80"></i> ' + esc(model) + ' — ' + hasOv + ' parameter di-override'
                 : '<i class="fa-solid fa-circle-info"></i> ' + esc(model) + ' — belum ada override (memakai default kompartemen)')
        : '';
    }

    body.innerHTML = keys.map(function (k) {
      var b = base[k] || {};
      var o = overrides[k] || {};
      // Nilai ditampilkan: override bila ada, kalau tidak -> kosong (placeholder default).
      function inp(field, w) {
        var isOv = (o[field] !== undefined);
        var v = isOv ? o[field] : '';
        var ph = (b[field] !== undefined) ? b[field] : '';
        return '<input type="number" step="any" data-mfield="' + field + '"' +
          ' value="' + (v !== '' ? v : '') + '" placeholder="' + ph + '"' +
          ' data-default="' + ph + '"' +
          ' style="width:' + (w || 84) + 'px' + (isOv ? ';border-color:var(--accent)' : '') + '">';
      }
      var label = (scfg.PARAMS[k] || {}).label || k;
      return '<tr data-msth="' + esc(k) + '">' +
        '<td><strong>' + esc(label) + '</strong> <span style="color:var(--text-mute);font-size:10px">' + esc(k) + '</span></td>' +
        '<td class="center">' + inp('warn') + '</td>' +
        '<td class="center">' + inp('crit') + '</td>' +
        '<td class="center">' + inp('extreme') + '</td>' +
        '<td class="center">' + inp('warn_low') + '</td>' +
        '<td class="center">' + inp('crit_low') + '</td>' +
        '</tr>';
    }).join('');
  }

  /** Kumpulkan override SOS dari tabel -> {paramKey:{...}} (hanya yg diisi). */
  function collectSosModelTable() {
    var out = {};
    document.querySelectorAll('#sos-model-threshold-body tr[data-msth]').forEach(function (tr) {
      var pk = tr.getAttribute('data-msth');
      var entry = {};
      tr.querySelectorAll('[data-mfield]').forEach(function (inp) {
        var f = inp.getAttribute('data-mfield');
        var raw = inp.value;
        if (raw === '') return;   // kosong = tidak di-override (pakai default)
        var v = parseFloat(raw);
        entry[f] = isNaN(v) ? raw : v;
      });
      if (Object.keys(entry).length) out[pk] = entry;
    });
    return out;
  }

  function showModelValidation(elId, res) {
    var el = $(elId);
    if (!el) return;
    var html = '';
    if (res.errors.length) {
      html += '<div style="color:#f87171"><i class="fa-solid fa-circle-xmark"></i> <strong>Error:</strong><ul style="margin:4px 0 0 18px">' +
        res.errors.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    }
    if (res.warnings.length) {
      html += '<div style="color:#facc15;margin-top:6px"><i class="fa-solid fa-triangle-exclamation"></i> <strong>Peringatan:</strong><ul style="margin:4px 0 0 18px">' +
        res.warnings.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    }
    if (!html) html = '<div style="color:#4ade80"><i class="fa-solid fa-circle-check"></i> Threshold valid.</div>';
    el.innerHTML = html;
  }

  /* --- VHMS model --- */
  function refreshVhmsModelList() {
    var dl = $('vhms-model-list');
    var models = uniqSorted(vhmsModelsFromData().concat(vcfg.listModelKeys ? vcfg.listModelKeys() : []));
    if (dl) dl.innerHTML = models.map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('');
  }

  /**
   * Render tabel editor override VHMS. Basis = threshold keluarga dari model
   * saat ini (dideteksi via VHMS_PROFILES.detectFamily({model})), agar
   * placeholder = nilai keluarga yang benar.
   */
  function vhmsBaseSetForModel(model) {
    var fam = 'EXCAVATOR';
    try {
      if (global.VHMS_PROFILES && global.VHMS_PROFILES.detectFamily) {
        fam = global.VHMS_PROFILES.detectFamily({ model: model });
      }
      var p = global.VHMS_PROFILES.PROFILES[fam];
      if (p && p.thresholds) return p.thresholds;
    } catch (e) {}
    return vcfg.THRESHOLDS;
  }

  function renderVhmsModelTable() {
    var body = $('vhms-model-threshold-body');
    if (!body) return;
    var model = ($('vhms-model-name') ? $('vhms-model-name').value : '').trim();
    var base = vhmsBaseSetForModel(model);
    var overrides = (vcfg.modelOverride ? vcfg.modelOverride(model) : {}) || {};
    var groups = (vcfg.groupByDirection) ? vcfg.groupByDirection(overrides) : { HIGH: Object.keys(overrides), LOW: [] };
    var keys = Object.keys(base);
    Object.keys(overrides).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });

    var chip = $('vhms-model-chip');
    if (chip) {
      var hasOv = Object.keys(overrides).length;
      chip.innerHTML = model
        ? (hasOv ? '<i class="fa-solid fa-circle-check" style="color:#4ade80"></i> ' + esc(model) + ' — ' + hasOv + ' parameter di-override'
                 : '<i class="fa-solid fa-circle-info"></i> ' + esc(model) + ' — belum ada override (memakai default keluarga)')
        : '';
    }

    body.innerHTML = keys.map(function (k) {
      var b = base[k] || {};
      var o = overrides[k] || {};
      function inp(field, w) {
        var isOv = (o[field] !== undefined);
        var v = isOv ? o[field] : '';
        var ph = (b[field] !== undefined) ? b[field] : '';
        return '<input type="number" step="any" data-mfield="' + field + '" value="' + (v !== '' ? v : '') +
          '" placeholder="' + ph + '" data-default="' + ph + '" style="width:' + (w || 90) + 'px' + (isOv ? ';border-color:var(--accent)' : '') + '">';
      }
      var mode = o.mode || b.mode || 'high';
      return '<tr data-mvth="' + esc(k) + '">' +
        '<td><strong>' + esc(k) + '</strong></td>' +
        '<td class="center">' + inp('warn') + '</td>' +
        '<td class="center">' + inp('crit') + '</td>' +
        '<td class="center"><select data-mfield="mode" style="width:80px">' +
          '<option value="high"' + (mode === 'high' ? ' selected' : '') + '>high</option>' +
          '<option value="low"' + (mode === 'low' ? ' selected' : '') + '>low</option>' +
        '</select></td>' +
        '<td>' + esc((b.label || o.label || k)) + '</td>' +
        '</tr>';
    }).join('');
  }

  function collectVhmsModelTable() {
    var body = $('vhms-model-threshold-body');
    if (!body) return {};
    var model = ($('vhms-model-name') ? $('vhms-model-name').value : '').trim();
    var base = vhmsBaseSetForModel(model);
    var out = {};
    document.querySelectorAll('#vhms-model-threshold-body tr[data-mvth]').forEach(function (tr) {
      var pk = tr.getAttribute('data-mvth');
      var entry = {};
      tr.querySelectorAll('[data-mfield]').forEach(function (inp) {
        var f = inp.getAttribute('data-mfield');
        if (f === 'mode') {
          // Hanya simpan mode bila BERBEDA dari default keluarga (hindari
          // entri "mode" palsu yang hanya mengulang nilai bawaan).
          var baseMode = (base[pk] && base[pk].mode) || 'high';
          if (inp.value && inp.value !== baseMode) entry.mode = inp.value;
          return;
        }
        var raw = inp.value;
        if (raw === '') return;
        var v = parseFloat(raw);
        entry[f] = isNaN(v) ? raw : v;
      });
      if (Object.keys(entry).length) out[pk] = entry;
    });
    return out;
  }

  /* --- Wiring model UI --- */
  function wireModelThresholds() {
    // SOS
    var sAdd = $('btn-sos-model-add');
    if (sAdd) sAdd.addEventListener('click', renderSosModelTable);
    var sSel = $('sos-model-component');
    if (sSel) sSel.addEventListener('change', renderSosModelTable);
    var sName = $('sos-model-name');
    if (sName) sName.addEventListener('change', renderSosModelTable);
    var sSave = $('btn-sos-model-save');
    if (sSave) sSave.addEventListener('click', function () {
      var model = ($('sos-model-name') ? $('sos-model-name').value : '').trim();
      if (!model) { toast('Isi nama model terlebih dahulu.', 'warn'); return; }
      var comp = $('sos-model-component') ? $('sos-model-component').value : '';
      var base = scfg.getThresholdsFor(comp);
      var entries = collectSosModelTable();
      // Validasi tiap entry vs default kompartemen.
      var res = { errors: [], warnings: [] };
      Object.keys(entries).forEach(function (pk) {
        var r = validateThresholdEntry(entries[pk], { base: base[pk] });
        r.errors.forEach(function (m) { res.errors.push(pk + ': ' + m); });
        r.warnings.forEach(function (m) { res.warnings.push(pk + ': ' + m); });
      });
      showModelValidation('sos-model-validation', res);
      if (res.errors.length) { toast('Threshold model tidak valid — periksa pesan error.', 'err'); return; }
      scfg.MODEL_THRESHOLDS[model] = scfg.MODEL_THRESHOLDS[model] || {};
      scfg.MODEL_THRESHOLDS[model][comp] = entries;
      if (!Object.keys(entries).length) delete scfg.MODEL_THRESHOLDS[model][comp];
      if (!Object.keys(scfg.MODEL_THRESHOLDS[model]).length) delete scfg.MODEL_THRESHOLDS[model];
      persistModelThresholds(); reanalyzeAll(); refreshSosModelList(); renderSosModelTable();
      toast('Threshold SOS model "' + model + '" disimpan.' + (res.warnings.length ? ' (' + res.warnings.length + ' peringatan)' : ''), 'ok');
    });
    var sDel = $('btn-sos-model-delete');
    if (sDel) sDel.addEventListener('click', function () {
      var model = ($('sos-model-name') ? $('sos-model-name').value : '').trim();
      if (!model || !scfg.MODEL_THRESHOLDS[model]) { toast('Tidak ada override untuk model ini.', 'info'); return; }
      delete scfg.MODEL_THRESHOLDS[model];
      persistModelThresholds(); reanalyzeAll(); refreshSosModelList(); renderSosModelTable();
      toast('Override SOS model "' + model + '" dihapus.', 'info');
    });

    // VHMS
    var vAdd = $('btn-vhms-model-add');
    if (vAdd) vAdd.addEventListener('click', renderVhmsModelTable);
    var vName = $('vhms-model-name');
    if (vName) vName.addEventListener('change', renderVhmsModelTable);
    var vSave = $('btn-vhms-model-save');
    if (vSave) vSave.addEventListener('click', function () {
      var model = ($('vhms-model-name') ? $('vhms-model-name').value : '').trim();
      if (!model) { toast('Isi nama model terlebih dahulu.', 'warn'); return; }
      var base = vhmsBaseSetForModel(model);
      var entries = collectVhmsModelTable();
      var res = { errors: [], warnings: [] };
      Object.keys(entries).forEach(function (pk) {
        // VHMS: warn/crit dengan mode. Bila mode low -> crit <= warn.
        var e = Object.assign({}, entries[pk]);
        var bmode = (base[pk] && base[pk].mode) || 'high';
        if (e.mode === undefined) e.mode = bmode;
        var r = validateThresholdEntry(e, { base: base[pk] });
        r.errors.forEach(function (m) { res.errors.push(pk + ': ' + m); });
        r.warnings.forEach(function (m) { res.warnings.push(pk + ': ' + m); });
      });
      showModelValidation('vhms-model-validation', res);
      if (res.errors.length) { toast('Threshold model tidak valid — periksa pesan error.', 'err'); return; }
      vcfg.MODEL_THRESHOLDS[model] = entries;
      if (!Object.keys(entries).length) delete vcfg.MODEL_THRESHOLDS[model];
      persistModelThresholds(); reanalyzeAll(); refreshVhmsModelList(); renderVhmsModelTable();
      toast('Threshold VHMS model "' + model + '" disimpan.' + (res.warnings.length ? ' (' + res.warnings.length + ' peringatan)' : ''), 'ok');
    });
    var vDel = $('btn-vhms-model-delete');
    if (vDel) vDel.addEventListener('click', function () {
      var model = ($('vhms-model-name') ? $('vhms-model-name').value : '').trim();
      if (!model || !vcfg.MODEL_THRESHOLDS[model]) { toast('Tidak ada override untuk model ini.', 'info'); return; }
      delete vcfg.MODEL_THRESHOLDS[model];
      persistModelThresholds(); reanalyzeAll(); refreshVhmsModelList(); renderVhmsModelTable();
      toast('Override VHMS model "' + model + '" dihapus.', 'info');
    });
  }

  function init() {
    var btn = $('btn-settings');
    if (btn) btn.addEventListener('click', openSettings);
    var close = $('settings-modal-close');
    if (close) close.addEventListener('click', closeSettings);
    var overlay = $('settings-modal');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSettings(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = $('settings-modal');
        if (m && !m.classList.contains('hidden')) closeSettings();
      }
    });

    document.querySelectorAll('#settings-tabs .subtab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-settings-tab')); });
    });

    // Threshold VHMS (per keluarga)
    var famSel = $('vhms-threshold-family');
    if (famSel) famSel.addEventListener('change', renderVhmsThresholdTable);
    var saveV = $('btn-threshold-save-vhms');
    if (saveV) saveV.addEventListener('click', function () {
      collectVhmsThresholds(); persistThresholds(); reanalyzeAll();
      toast('Threshold VHMS disimpan & diterapkan.', 'ok');
    });
    var resetV = $('btn-threshold-reset-vhms');
    if (resetV) resetV.addEventListener('click', function () {
      // Kembalikan base config + seluruh profil keluarga ke default.
      Object.keys(VHMS_DEFAULT).forEach(function (k) { vcfg.THRESHOLDS[k] = JSON.parse(JSON.stringify(VHMS_DEFAULT[k])); });
      Object.keys(VHMS_FAMILY_DEFAULT).forEach(function (family) {
        var set = vhmsThresholdSetFor(family);
        Object.keys(VHMS_FAMILY_DEFAULT[family]).forEach(function (k) {
          set[k] = JSON.parse(JSON.stringify(VHMS_FAMILY_DEFAULT[family][k]));
        });
      });
      persistThresholds(); renderVhmsThresholdTable(); reanalyzeAll();
      toast('Threshold VHMS direset ke default.', 'info');
    });

    // Ekspor / Impor threshold (JSON & CSV)
    var expBtn = $('btn-threshold-export');
    if (expBtn) expBtn.addEventListener('click', exportThresholds);
    var expCsvBtn = $('btn-threshold-export-csv');
    if (expCsvBtn) expCsvBtn.addEventListener('click', exportThresholdsCsv);
    var impBtn = $('btn-threshold-import');
    var impInput = $('threshold-import-input');
    if (impBtn && impInput) {
      impBtn.addEventListener('click', function () { impInput.value = ''; impInput.click(); });
      impInput.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) importThresholdsFromFile(f);
      });
    }

    // Threshold SOS
    var sel = $('sos-threshold-component');
    if (sel) sel.addEventListener('change', function () { renderSosThresholdTable(sel.value); });
    var saveS = $('btn-threshold-save-sos');
    if (saveS) saveS.addEventListener('click', function () {
      if (sel) collectSosThresholds(sel.value);
      persistThresholds(); reanalyzeAll();
      toast('Threshold SOS disimpan & diterapkan.', 'ok');
    });
    var resetS = $('btn-threshold-reset-sos');
    if (resetS) resetS.addEventListener('click', function () {
      Object.keys(SOS_DEFAULT).forEach(function (c) { scfg.THRESHOLDS[c] = JSON.parse(JSON.stringify(SOS_DEFAULT[c])); });
      persistThresholds();
      if (sel) renderSosThresholdTable(sel.value);
      reanalyzeAll();
      toast('Threshold SOS direset ke default.', 'info');
    });

    // [BARU 2026-10-01] Editor threshold per MODEL UNIT (SOS & VHMS).
    wireModelThresholds();

    // Status & SLA
    var saveF = $('btn-followup-save');
    if (saveF) saveF.addEventListener('click', function () {
      collectFollowup(); persistFollowup();
      if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) { try { global.PORTFOLIO_APP.refresh(); } catch (e) {} }
      toast('Status & SLA disimpan.', 'ok');
    });
    var resetF = $('btn-followup-reset');
    if (resetF) resetF.addEventListener('click', function () {
      Object.keys(FUP_STATUS_DEFAULT).forEach(function (k) {
        vcfg.FOLLOWUP_STATUS[k] = JSON.parse(JSON.stringify(FUP_STATUS_DEFAULT[k]));
      });
      persistFollowup(); renderFollowupTable();
      if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) { try { global.PORTFOLIO_APP.refresh(); } catch (e) {} }
      toast('Status & SLA direset ke default.', 'info');
    });

    // [CLC 2026-10-04] Filter Umur Komponen.
    var clcSave = $('btn-clc-save');
    if (clcSave) clcSave.addEventListener('click', function () {
      var clc = _clc();
      if (!clc) { toast('Modul filter belum termuat.', 'err'); return; }
      var cb = $('clc-enabled');
      var tol = $('clc-tolerance');
      var showCut = $('clc-show-cut');
      clc.setEnabled(cb ? cb.checked : false);
      if (tol && tol.value) clc.setTolerance(parseFloat(tol.value));
      if (clc.setShowCut) clc.setShowCut(showCut ? showCut.checked : false);
      // Terapkan ulang ke kedua store (bila modulnya tersedia).
      var sosN = 0, vhmsN = 0;
      if (global.SOS_STORE && global.SOS_STORE.applyClcChange) {
        try { sosN = global.SOS_STORE.applyClcChange() ? global.SOS_STORE.getAllSamples().length : 0; } catch (e) {}
      }
      if (global.VHMS_FLEET && global.VHMS_FLEET.applyClcChange) {
        try { vhmsN = global.VHMS_FLEET.applyClcChange(); } catch (e) {}
      }
      // Segarkan tampilan.
      if (global.SOS_RENDER && global.SOS_RENDER.refreshCurrentView) { try { global.SOS_RENDER.refreshCurrentView(); } catch (e) {} }
      if (global.VHMS_RENDER && global.VHMS_RENDER.renderFleet) { try { global.VHMS_RENDER.renderFleet(); } catch (e) {} }
      if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) { try { global.PORTFOLIO_APP.refresh(); } catch (e) {} }
      toast('Filter Umur Komponen ' + (clc.isEnabled() ? 'DIAKTIFKAN' : 'dimatikan') +
        ' · SOS ' + sosN + ' sampel · VHMS ' + vhmsN + ' unit dianalisa ulang.', 'ok');
      renderClcPanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.VHMS_SETTINGS = {
    THEMES: THEMES,
    applyTheme: applyTheme,
    currentTheme: currentTheme,
    loadThresholds: loadThresholds,
    persistThresholds: persistThresholds,
    exportThresholds: exportThresholds,
    exportThresholdsCsv: exportThresholdsCsv,
    importThresholdsCsv: importThresholdsCsv,
    applyImported: applyImported,
    reanalyzeAll: reanalyzeAll,
    // [BARU 2026-10-01] Override threshold per MODEL unit + validasi.
    loadModelThresholds: loadModelThresholds,
    persistModelThresholds: persistModelThresholds,
    validateThresholdEntry: validateThresholdEntry,
    validateThresholdSet: validateThresholdSet,
    renderClcPanel: renderClcPanel,
    open: openSettings,
    close: closeSettings
  };
})(typeof window !== 'undefined' ? window : globalThis);

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
  // [SETELAN 2026-10-26] Knob kalibrasi otomatis ambang Fuel Rate (Tukey).
  var FUELCAL_KEY = 'oms.fuelcal.v1';
  // [BARU 2026-10-01] Override threshold per MODEL UNIT (SOS & VHMS terpisah).
  var VMODEL_KEY = 'oms.thresholds.vhms.model.v1';
  var SMODEL_KEY = 'oms.thresholds.sos.model.v1';
  // [P2-2 2026-10-27] JEJAK AUDIT perubahan ambang.
  var AUDIT_KEY = 'oms.thresholds.audit.v1';

  /* -----------------------------------------------------------------------
   * [P2-2 2026-10-27] JEJAK AUDIT PERUBAHAN AMBANG (ring)
   * ---------------------------------------------------------------------
   * Dulu simpan = MENIMPA blob localStorage: nilai lama, waktu, dan sebab
   * hilang. Untuk angka yang menggerakkan keputusan perawatan itu celah
   * tata-kelola — pertanyaan "sejak kapan crit coolant 108?" tak terjawab.
   *
   * ⚠ TIDAK ada field PELAKU (`changedBy`). Aplikasi ini tanpa otentikasi;
   *   mengisi nama dari `navigator`/OS = MENGARANG BUKTI, lebih buruk
   *   daripada tidak ada jejak sama sekali.
   *
   * Bentuk entri: { at:ISO, scope:'vhms|sos|model', param, field, from, to }
   * --------------------------------------------------------------------- */
  var THRESHOLD_AUDIT_LIMIT = 200;

  function getThresholdAudit() {
    try {
      var raw = global.localStorage.getItem(AUDIT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function recordThresholdAudit(entry) {
    if (!entry || !entry.param || !entry.field) return null;
    // Nilai sama = bukan perubahan; jangan kotori jejak dengan no-op.
    if (entry.from === entry.to) return null;
    var rec = {
      at: new Date().toISOString(),
      scope: entry.scope || 'vhms',
      param: entry.param,
      field: entry.field,
      from: entry.from,
      to: entry.to
    };
    try {
      var arr = getThresholdAudit();
      arr.push(rec);
      if (arr.length > THRESHOLD_AUDIT_LIMIT) arr = arr.slice(arr.length - THRESHOLD_AUDIT_LIMIT);
      global.localStorage.setItem(AUDIT_KEY, JSON.stringify(arr));
    } catch (e) {
      // PENYIMPANAN GAGAL -> entri ini TIDAK tercatat. Kembalikan null supaya
      // pemanggil tidak mengira jejak tersimpan ("tercatat" ≠ "tersimpan").
      warnFail('simpan jejak audit threshold', e);
      return null;
    }
    return rec;
  }

  /**
   * Bandingkan dua kumpulan threshold (lama -> baru) dan catat tiap
   * perubahan field warn/crit/extreme/warn_low/crit_low/mode.
   * Dipanggil SEBELUM objek threshold ditimpa saat menyimpan.
   */
  function auditThresholdDiff(before, after, scope) {
    if (!before || !after) return;
    var FIELDS = ['warn', 'crit', 'extreme', 'warn_low', 'crit_low', 'mode'];
    Object.keys(after).forEach(function (param) {
      var a = after[param], b = before[param];
      if (!a || typeof a !== 'object') return;
      FIELDS.forEach(function (f) {
        if (a[f] === undefined && (!b || b[f] === undefined)) return;
        var from = b ? b[f] : undefined;
        var to = a[f];
        if (from === to) return;
        recordThresholdAudit({ scope: scope, param: param, field: f, from: from, to: to });
      });
    });
  }

  /* -----------------------------------------------------------------------
   * [P2-2b 2026-10-27] JEJAK HARUS TERLIHAT, bukan hanya tersimpan.
   * ---------------------------------------------------------------------
   * Versi P2-2 pertama menyimpan ring + mengekspor JSON, tetapi tidak
   * pernah merender apa pun. Jejak yang tak terbaca operator tidak menutup
   * celah tata-kelola — ia memindahkan celah dari "tidak dicatat" ke
   * "tidak terlihat".
   *
   * Dipisah dari renderer DOM supaya dapat dikunci uji di Node
   * (`AUD-4..AUD-7`) tanpa harness DOM penuh.
   *
   * ⚠ `esc()` WAJIB dipakai: nama parameter bisa masuk lewat IMPOR JSON/CSV
   *   (masukan tak-terpercaya) dan berakhir di `innerHTML` (`AUD-6`).
   * ⚠ Nilai `undefined` = field itu DULU tidak diset. Menulisnya "0" adalah
   *   mengarang bukti — kelas falsy-zero yang sama dengan `_hm`/`wear_si`.
   * --------------------------------------------------------------------- */
  function auditFmtValue(v) {
    if (v === undefined || v === null || v === '') return '<span class="u-text-mute">\u2014 (baru)</span>';
    return esc(String(v));
  }

  function auditFmtTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return esc(String(iso == null ? '\u2014' : iso));
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return esc(p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
               ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
  }

  /** Baris <tr> read-only untuk tabel jejak audit; TERBARU di atas. */
  function auditTrailRows(entries) {
    var arr = Array.isArray(entries) ? entries : [];
    return arr.slice().reverse().map(function (e) {
      e = e || {};
      return '<tr>' +
        '<td style="white-space:nowrap">' + auditFmtTime(e.at) + '</td>' +
        '<td>' + esc(e.scope == null ? '\u2014' : e.scope) + '</td>' +
        '<td>' + esc(e.param == null ? '\u2014' : e.param) + '</td>' +
        '<td>' + esc(e.field == null ? '\u2014' : e.field) + '</td>' +
        '<td class="center">' + auditFmtValue(e.from) + '</td>' +
        '<td class="center"><strong>' + auditFmtValue(e.to) + '</strong></td>' +
        '</tr>';
    });
  }

  /** Render tabel jejak + ringkasan. Aman bila elemen belum ada. */
  function renderAuditTrailPanel() {
    var body = $('threshold-audit-body');
    var status = $('threshold-audit-status');
    if (!body) return;
    var log = getThresholdAudit();
    var rows = auditTrailRows(log);
    body.innerHTML = rows.length ? rows.join('') :
      '<tr><td colspan="6" class="center u-text-mute" style="padding:18px">' +
      'Belum ada perubahan ambang yang tercatat.</td></tr>';
    if (status) {
      status.innerHTML = log.length
        ? '<strong>' + log.length + '</strong> perubahan tercatat (maksimum ' +
          THRESHOLD_AUDIT_LIMIT + ' terakhir disimpan). Jejak ikut dalam ' +
          '<em>Ekspor JSON</em>. Tanpa kolom pelaku: aplikasi ini tidak memakai ' +
          'otentikasi, jadi mencatat nama pengguna berarti mengarang bukti.'
        : 'Jejak akan terisi otomatis setiap kali ambang disimpan.';
    }
  }

  function clearAuditTrail() {
    if (!global.confirm || !global.confirm(
        'Hapus SELURUH jejak perubahan ambang? Tindakan ini tidak dapat dibatalkan ' +
        'dan menghilangkan riwayat yang dipakai untuk audit.')) return;
    try { global.localStorage.removeItem(AUDIT_KEY); } catch (e) { warnFail('hapus jejak audit', e); }
    renderAuditTrailPanel();
  }

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
  /* [P2-2b 2026-10-27] Escaping MURNI STRING, tidak lewat DOM.
   * Versi lama memakai `document.createElement('div').textContent` — di
   * harness Node (`document` stub) itu mengembalikan STRING KOSONG, jadi
   * uji escaping lolos/merah karena sebab yang salah dan proteksi XSS tidak
   * pernah benar-benar teruji. Versi string juga menutup `"` dan `'`
   * (textContent tidak, sehingga nilai di dalam atribut tetap rawan). */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
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

  /* ---------------------------------------------------------------------
   * [B15 2026-10-10 — MIGRASI SATUAN] `*ExhOver700/750/800` detik -> persen.
   * ---------------------------------------------------------------------
   * Sebelum B14, ambang duty gas buang disimpan dalam DETIK (HD785: 300/1800;
   * excavator 800: 300/1800). Setelah B14, `normalizeExhaustDuty()` selalu
   * mengubah nilai kolom menjadi PERSEN jendela, sehingga ambang LAMA menjadi
   * mustahil terlampaui (mis. 25 % vs warn 300 detik -> SELALU NORMAL).
   *
   * Bila threshold tersimpan dari versi lama dibiarkan menempel, bug HD785
   * yang baru diperbaiki akan HIDUP KEMBALI secara senyap pada setiap
   * browser yang pernah memakai versi lama. Karena itu nilai tersimpan
   * untuk kunci ini DIBUANG (bukan dikonversi) saat terdeteksi masih bersatuan
   * detik — nilai persen yang benar lalu diambil dari config keluaran baru.
   *
   * Deteksi: kunci cocok /^[a-z]{2}ExhOver(700|750|800)$/ DAN nilai warn
   * > EXH_PCT_MAX (50). Nilai persen sah maksimum 100, tetapi ambang warn
   * 50 % ke atas tidak masuk akal sebagai alarm -> aman dipakai sebagai
   * pembeda satuan. Ambang 300 (detik) > 50 -> terdeteksi.
   * ------------------------------------------------------------------- */
  var EXH_OVER_RE = /^[a-z]{2}ExhOver(700|750|800)$/;
  var EXH_PCT_MAX = 50;
  /** Kembalikan true bila entri ini MILIK kunci duty & masih bersatuan detik. */
  function isLegacyExhaustDutyUnit(k, th) {
    if (!EXH_OVER_RE.test(k) || !th) return false;
    var w = th.warn;
    if (typeof w !== 'number') return false;
    return w > EXH_PCT_MAX || (typeof th.crit === 'number' && th.crit > 100);
  }

  /* ---------------------------------------------------------------------
   * [HD465 2026-10-27 — MIGRASI AMBANG BASI] `HD465` / `HD465-7`.
   * ---------------------------------------------------------------------
   * MASALAH YANG DIPERBAIKI:
   * `loadModelThresholds()` menimpa `MODEL_THRESHOLDS` milik config dengan
   * salinan dari localStorage (`persistModelThresholds()` menyimpan SELURUH
   * peta, bukan hanya yang diubah operator). Artinya SETIAP perangkat yang
   * pernah membuka aplikasi versi lama menyimpan HD465 fuelRate 90/115 dan
   * blowbyMax 4,5/10 — sehingga ambang yang baru dikalibrasi (25/28 dan
   * 7,5/9) TIDAK PERNAH terpakai di perangkat itu. Terbukti di browser:
   * `thresholdsForModel(prof, 'HD465').fuelRate.crit` = 120 walau config
   * bernilai 28.
   *
   * Gejalanya identik dengan B15 (duty detik -> persen): perbaikan config
   * HIDUP KEMBALI sebagai bug pada pengguna lama, tanpa peringatan.
   *
   * PENANDA: nilai warn fuel `>= 60` L/jam tidak mungkin untuk HD465 —
   * truck ini adalah 6-silinder 23 L dengan sebaran terukur maks 29,6 L/jam.
   * Ambang baru (25) jauh di bawah penanda, ambang lama (90/95) jauh di atas.
   * Blowby `warn <= 4,5` kPa juga penanda: nilai operasi normal terukur
   * 6,6 kPa, jadi ambang di bawahnya mustahil berasal dari kalibrasi baru.
   * Yang dibuang HANYA dua kunci ini; nilai lain milik operator dipertahankan.
   * ------------------------------------------------------------------- */
  var LEGACY_HD465_FUEL_WARN_MIN = 60;
  var LEGACY_HD465_BLOWBY_WARN_MAX = 4.5;
  function isLegacyHd465Thresholds(modelKey, set) {
    if (!set || typeof set !== 'object') return false;
    if (String(modelKey).toUpperCase().indexOf('HD465') !== 0) return false;
    var f = set.fuelRate, b = set.blowbyMax;
    if (f && typeof f.warn === 'number' && f.warn >= LEGACY_HD465_FUEL_WARN_MIN) return true;
    if (b && typeof b.warn === 'number' && b.warn <= LEGACY_HD465_BLOWBY_WARN_MAX) return true;
    return false;
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
            if (isLegacyExhaustDutyUnit(k, vSaved[k])) return;   // [B15] buang detik lama
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
              if (isLegacyExhaustDutyUnit(k, saved[k])) return;  // [B15] buang detik lama
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
        Object.keys(v).forEach(function (m) {
          /* [HD465 2026-10-27] Buang SELURUH entri model bila masih memuat
           * ambang basi (fuel >= 60 L/jam atau blowby <= 4,5 kPa). Membuang
           * satu kunci saja akan menyisakan campuran angka lama & baru pada
           * model yang sama — lebih menyesatkan daripada memakai config.
           * Alasan lengkap: lihat `isLegacyHd465Thresholds`. */
          if (isLegacyHd465Thresholds(m, v[m])) return;
          var set = v[m] || {};
          // [B15] Buang ambang duty gas buang yang masih bersatuan DETIK,
          // agar bug HD785/PC2000 tidak hidup kembali lewat override model
          // yang tersimpan dari versi lama.
          Object.keys(set).forEach(function (k) {
            if (isLegacyExhaustDutyUnit(k, set[k])) delete set[k];
          });
          vcfg.MODEL_THRESHOLDS[m] = set;
        });
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
      // [FIX C6 · 2026-10-19] Pisahkan validasi mode:'low' vs mode:'high'.
      // Sebelumnya check c < w selalu fire → false positive untuk mode:'low'
      // di mana crit HARUS < warn (misal oilPressHMin: crit=0.18, warn=0.25).
      if (th.mode === 'low') {
        if (!isNaN(w) && !isNaN(c) && c > w) {
          errors.push('Mode LOW: Crit (' + c + ') harus \u2264 Warn (' + w + ').');
        }
      } else {
        if (!isNaN(w) && !isNaN(c) && c < w) {
          errors.push('Urutan salah: Crit (' + c + ') harus \u2265 Warn (' + w + ').');
        }
        if (!isNaN(c) && !isNaN(e) && e < c) {
          errors.push('Urutan salah: Extreme (' + e + ') harus \u2265 Crit (' + c + ').');
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

  /** Simpan seluruh threshold yang sekarang ke localStorage. */
  function persistThresholds() {
    // [P2-2 2026-10-27] Catat selisih TERHADAP salinan tersimpan SEBELUM
    // menimpa. Bila belum ada salinan (pertama kali), tidak ada pembanding ->
    // tidak ada yang dicatat (jujur: bukan "perubahan").
    try {
      var prevRaw = global.localStorage.getItem(VTH_KEY);
      if (prevRaw) {
        var prev = JSON.parse(prevRaw);
        auditThresholdDiff(prev.BASE, vcfg.THRESHOLDS, 'vhms');
        var profs0 = (global.VHMS_PROFILES && global.VHMS_PROFILES.PROFILES) || {};
        Object.keys(profs0).forEach(function (f) {
          if (profs0[f] && profs0[f].thresholds && prev[f]) {
            auditThresholdDiff(prev[f], profs0[f].thresholds, 'vhms:' + f);
          }
        });
      }
      var prevSos = global.localStorage.getItem(STH_KEY);
      if (prevSos) auditThresholdDiff(JSON.parse(prevSos), scfg.THRESHOLDS, 'sos');
    } catch (e) { /* audit tidak boleh menghalangi penyimpanan */ }
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
      sos: scfg.THRESHOLDS,
      // [P2-2 2026-10-27] Jejak perubahan ikut diekspor agar dapat diaudit
      // di luar aplikasi (tanpa pelaku — lihat catatan AUDIT_KEY).
      audit: getThresholdAudit()
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
    // [O-5 2026-10-12] Delegasi ke CSV_UTIL. Implementasi lokal sebelumnya
    // IDENTIK secara logika dengan `CSV_UTIL.splitLine` (escape `""`, trim
    // hasil), hanya pemilihan delimiternya ditulis ulang di sini.
    //
    // PERBEDAAN HALUS yang dipertahankan dengan sengaja: pemilihan delimiter
    // di sini memakai URUTAN KEUTAMAAN (`;` dulu, lalu tab, lalu `,`) karena
    // berkas ekspor threshold SELALU memakai `;` — sedangkan
    // `CSV_UTIL.detectDelim` memilih delimiter yang PALING BANYAK muncul.
    // Keduanya berbeda pada kasus nyata: label threshold boleh memuat koma
    // (mis. `Blowby, maks`), sehingga jumlah koma dapat melebihi `;` dan
    // detectDelim akan salah memilih. Karena itu delimiter tetap ditentukan
    // di sini, dan HANYA pemisahannya yang didelegasikan.
    function splitLine(line) {
      var delim = (line.indexOf(';') !== -1) ? ';' : (line.indexOf('\t') !== -1 ? '\t' : ',');
      var cu = global.CSV_UTIL;
      if (cu && typeof cu.splitLine === 'function') return cu.splitLine(line, delim);
      // Fallback (CSV_UTIL belum termuat) — perilaku sama.
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
      html += '<tr class="th-group-row"><td colspan="6" style="background:rgba(2,6,23,.85);' +
        'color:' + badgeColor + ';font-weight:700;font-size:11px;letter-spacing:.5px;text-transform:uppercase;' +
        'padding:8px 10px;border-top:1px solid var(--border-2)">' +
        '<i class="fa-solid fa-' + (grp === 'HIGH' ? 'arrow-trend-up' : 'arrow-trend-down') + '"></i> ' +
        esc(label) + ' (' + keys.length + ')</td></tr>';
      html += keys.map(function (k) {
        var th = set[k] || {};
        var prov = th.provisional;
        var src = th.source || (prov ? 'Sementara (provisional)' : '');
        return '<tr data-vth="' + esc(k) + '">' +
          '<td><strong>' + esc(k) + '</strong>' +
            (prov ? ' <span class="pf-badge" title="Nilai sementara — belum terkonfirmasi">PROV</span>' : '') +
            '</td>' +
          '<td class="center"><input type="number" step="any" data-field="warn" value="' + (th.warn != null ? th.warn : '') + '" style="width:90px"></td>' +
          '<td class="center"><input type="number" step="any" data-field="crit" value="' + (th.crit != null ? th.crit : '') + '" style="width:90px"></td>' +
          '<td class="center"><select data-field="mode" style="width:80px">' +
            '<option value="high"' + (th.mode === 'high' ? ' selected' : '') + '>high</option>' +
            '<option value="low"' + (th.mode === 'low' ? ' selected' : '') + '>low</option>' +
          '</select></td>' +
          '<td><input type="text" data-field="label" value="' + esc(th.label || '') + '" style="width:100%"></td>' +
          '<td><span class="u-text-mute" style="font-size:10.5px">' + esc(src) + '</span></td>' +
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
   * [SETELAN 2026-10-26] Kalibrasi otomatis ambang Fuel Rate (pagar Tukey).
   * ---------------------------------------------------------------------
   * Angka pengali IQR & sampel minimum dulu tertanam di `vhms-analytics.js`,
   * jadi operator tidak bisa menyesuaikannya tanpa mengedit .js. Sekarang
   * nilainya hidup di `vcfg.FUEL_CALIBRATION` (dibaca SETIAP analisa) dan
   * disimpan di localStorage seperti threshold lain.
   *
   * ⚠ PLAFON "hanya boleh mengetatkan" sengaja TIDAK dibuat dapat diatur:
   *   membolehkan pelonggaran akan membuat unit boros menyembunyikan dirinya
   *   sendiri — persis jenis ambang mati yang sedang diperbaiki.
   * --------------------------------------------------------------------- */
  var FUELCAL_DEFAULT = JSON.parse(JSON.stringify(vcfg.FUEL_CALIBRATION ||
    { enabled: true, warnK: 1.5, critK: 3.0, minSamples: 20 }));
  function loadFuelCal() {
    try {
      var s = JSON.parse(localStorage.getItem(FUELCAL_KEY) || 'null');
      if (s && typeof s === 'object' && vcfg.FUEL_CALIBRATION) {
        Object.assign(vcfg.FUEL_CALIBRATION, s);
      }
    } catch (e) { warnFail('muat kalibrasi fuel', e); }
  }

  function persistFuelCal() {
    try { localStorage.setItem(FUELCAL_KEY, JSON.stringify(vcfg.FUEL_CALIBRATION || {})); }
    catch (e) { warnFail('simpan kalibrasi fuel', e); }
  }

  function renderFuelCalPanel() {
    var c = vcfg.FUEL_CALIBRATION || FUELCAL_DEFAULT;
    var en = $('fuelcal-enabled'), wk = $('fuelcal-warnk'),
        ck = $('fuelcal-critk'), ms = $('fuelcal-minsamples'),
        st = $('fuelcal-status');
    if (en) en.checked = c.enabled !== false;
    if (wk) wk.value = c.warnK;
    if (ck) ck.value = c.critK;
    if (ms) ms.value = c.minSamples;
    if (st) {
      st.innerHTML = (c.enabled === false)
        ? '<i class="fa-solid fa-circle-info"></i> Kalibrasi nonaktif — ambang model/keluarga dipakai apa adanya.'
        : 'Aktif: <strong>warn = Q3 + ' + esc(String(c.warnK)) + ' &times; IQR</strong>, ' +
          '<strong>crit = Q3 + ' + esc(String(c.critK)) + ' &times; IQR</strong>, ' +
          'minimal ' + esc(String(c.minSamples)) + ' record. ' +
          'Hasil dibatasi ambang model (tidak pernah melonggarkan).';
    }
  }

  /** Validasi + simpan knob kalibrasi. @returns {boolean} berhasil? */
  function saveFuelCal() {
    var wk = parseFloat($('fuelcal-warnk') ? $('fuelcal-warnk').value : '');
    var ck = parseFloat($('fuelcal-critk') ? $('fuelcal-critk').value : '');
    var ms = parseInt($('fuelcal-minsamples') ? $('fuelcal-minsamples').value : '', 10);
    var en = $('fuelcal-enabled') ? !!$('fuelcal-enabled').checked : true;
    if (!isFinite(wk) || wk < 0) { toast('Pengali IQR Warn harus angka >= 0.', 'err'); return false; }
    if (!isFinite(ck) || ck < 0) { toast('Pengali IQR Crit harus angka >= 0.', 'err'); return false; }
    if (ck <= wk) { toast('Pengali Crit harus LEBIH BESAR dari Warn (crit selalu di atas warn).', 'err'); return false; }
    if (!isFinite(ms) || ms < 2) { toast('Sampel minimum harus >= 2 (kuartil butuh beberapa titik).', 'err'); return false; }
    vcfg.FUEL_CALIBRATION = vcfg.FUEL_CALIBRATION || {};
    vcfg.FUEL_CALIBRATION.enabled = en;
    vcfg.FUEL_CALIBRATION.warnK = wk;
    vcfg.FUEL_CALIBRATION.critK = ck;
    vcfg.FUEL_CALIBRATION.minSamples = ms;
    persistFuelCal(); reanalyzeAll(); renderFuelCalPanel();
    return true;
  }

  /* ---------------------------------------------------------------------
   * [SETELAN 2026-10-27] Berat kosong unit (empty vehicle weight)
   *
   * `vcfg.MODEL_SPECS` adalah KONSTANTA katalog. Override user disimpan
   * TERPISAH di localStorage dan diterapkan langsung ke `MODEL_SPECS[model]
   * .emptyWeight`, sehingga `vcfg.emptyWeightFor(model)` otomatis membaca
   * nilai hasil timbangan tanpa perlu mengubah signature fungsi mana pun.
   * Pola ini identik dengan FUEL_CALIBRATION di atas (mutasi in-place).
   * --------------------------------------------------------------------- */
  var EMPTYW_KEY = 'oms.emptyweight.v1';
  /** Snapshot nilai katalog, dipakai tombol "Reset ke Default". */
  var EMPTYW_DEFAULT = {};
  (function _snapEmptyW() {
    var specs = vcfg.MODEL_SPECS || {};
    for (var k in specs) {
      if (specs[k] && isFinite(specs[k].emptyWeight)) {
        EMPTYW_DEFAULT[k] = { emptyWeight: specs[k].emptyWeight, source: specs[k].source };
      }
    }
  })();

  function loadEmptyWeight() {
    try {
      var s = JSON.parse(localStorage.getItem(EMPTYW_KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      var specs = vcfg.MODEL_SPECS || {};
      for (var k in s) {
        var v = s[k];
        if (!v || !isFinite(v.emptyWeight) || v.emptyWeight <= 0) continue;
        specs[k] = specs[k] || {};
        specs[k].emptyWeight = v.emptyWeight;
        specs[k].source = v.source || 'timbangan aktual';
      }
    } catch (e) { warnFail('muat berat kosong', e); }
  }

  function persistEmptyWeight() {
    try {
      var specs = vcfg.MODEL_SPECS || {}, out = {};
      for (var k in specs) {
        var d = EMPTYW_DEFAULT[k];
        var cur = specs[k] && specs[k].emptyWeight;
        // Simpan hanya yang berbeda dari katalog, agar file kecil & jelas.
        if (isFinite(cur) && (!d || Math.abs(cur - d.emptyWeight) > 1e-9)) {
          out[k] = { emptyWeight: cur, source: specs[k].source || 'timbangan aktual' };
        }
      }
      localStorage.setItem(EMPTYW_KEY, JSON.stringify(out));
    } catch (e) { warnFail('simpan berat kosong', e); }
  }

  /** Isi datalist model + status panel. */
  function renderEmptyWeightPanel() {
    var dl = $('emptyweight-model-list');
    var specs = vcfg.MODEL_SPECS || {};
    if (dl) {
      dl.innerHTML = Object.keys(specs).map(function (m) {
        return '<option value="' + esc(m) + '"></option>';
      }).join('');
    }
    var st = $('emptyweight-status');
    if (!st) return;
    var rows = Object.keys(specs).filter(function (m) {
      return specs[m] && isFinite(specs[m].emptyWeight);
    }).map(function (m) {
      var d = EMPTYW_DEFAULT[m];
      var isCustom = d && Math.abs(specs[m].emptyWeight - d.emptyWeight) > 1e-9;
      return '<tr><td>' + esc(m) + '</td><td style="text-align:right">' +
        esc(specs[m].emptyWeight.toFixed(1)) + ' t</td><td>' +
        (isCustom
          ? '<span style="color:var(--warn,#d68a00)">timbangan aktual</span>'
          : '<span class="u-text-mute">katalog</span>') +
        '</td></tr>';
    }).join('');
    st.innerHTML = rows
      ? '<table style="width:100%;max-width:420px;font-size:11.5px;border-collapse:collapse">' +
        '<thead><tr style="color:var(--text-dim)"><th style="text-align:left">Model</th>' +
        '<th style="text-align:right">Berat kosong</th><th style="text-align:left;padding-left:10px">Sumber</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>'
      : '<i class="fa-solid fa-circle-info"></i> Belum ada spesifikasi berat kosong.';
  }

  /** Tampilkan nilai tersimpan untuk model yang diketik. */
  function syncEmptyWeightField() {
    var mi = $('emptyweight-model'), vi = $('emptyweight-value'), src = $('emptyweight-source');
    if (!mi || !vi) return;
    var model = (mi.value || '').trim();
    if (!model) { vi.value = ''; if (src) src.textContent = ''; return; }
    var specs = vcfg.MODEL_SPECS || {};
    // Pakai resolver katalog agar "HD785-7" tetap ketemu "HD785".
    var key = null, best = null;
    for (var k in specs) {
      if (k.toUpperCase() === model.toUpperCase()) { key = k; break; }
      if (model.toUpperCase().indexOf(k.toUpperCase()) === 0) {
        if (!best || k.length > best.length) best = k;
      }
    }
    key = key || best;
    if (key && specs[key] && isFinite(specs[key].emptyWeight)) {
      vi.value = specs[key].emptyWeight;
      if (src) src.textContent = '(' + key + ': ' + (specs[key].source || 'katalog') + ')';
    } else {
      vi.value = '';
      if (src) src.textContent = '(model tidak dikenal)';
    }
  }

  /** Validasi + simpan berat kosong satu model. @returns {boolean} */
  function saveEmptyWeight() {
    var mi = $('emptyweight-model'), vi = $('emptyweight-value');
    if (!mi || !vi) return false;
    var model = (mi.value || '').trim();
    var val = parseFloat(vi.value);
    if (!model) { toast('Model wajib diisi (mis. HD785).', 'err'); return false; }
    if (!isFinite(val) || val <= 0) { toast('Berat kosong harus angka > 0 ton.', 'err'); return false; }
    if (val > 400) { toast('Berat kosong > 400 ton tidak wajar untuk dump truck. Cek satuan (ton, bukan kg).', 'err'); return false; }
    vcfg.MODEL_SPECS = vcfg.MODEL_SPECS || {};
    vcfg.MODEL_SPECS[model] = vcfg.MODEL_SPECS[model] || {};
    vcfg.MODEL_SPECS[model].emptyWeight = val;
    vcfg.MODEL_SPECS[model].source = 'timbangan aktual';
    persistEmptyWeight();
    renderEmptyWeightPanel(); syncEmptyWeightField();
    try { if (typeof reanalyzeAll === 'function') reanalyzeAll(); } catch (e) { warnFail('analisis ulang', e); }
    return true;
  }

  /** Kembalikan SATU model (atau semua bila kosong) ke nilai katalog. */
  function resetEmptyWeight() {
    var mi = $('emptyweight-model');
    var model = mi ? (mi.value || '').trim() : '';
    var specs = vcfg.MODEL_SPECS || {};
    var targets = [];
    if (model) {
      for (var k in EMPTYW_DEFAULT) {
        if (k.toUpperCase() === model.toUpperCase()) { targets.push(k); break; }
      }
      if (!targets.length) targets.push(model);
    } else {
      targets = Object.keys(EMPTYW_DEFAULT);
    }
    targets.forEach(function (t) {
      if (EMPTYW_DEFAULT[t] && specs[t]) {
        specs[t].emptyWeight = EMPTYW_DEFAULT[t].emptyWeight;
        specs[t].source = EMPTYW_DEFAULT[t].source;
      }
    });
    persistEmptyWeight();
    renderEmptyWeightPanel(); syncEmptyWeightField();
    try { if (typeof reanalyzeAll === 'function') reanalyzeAll(); } catch (e) { warnFail('analisis ulang', e); }
    return true;
  }

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
    // [P2-2b 2026-10-27] 'audit' = tabel jejak perubahan ambang (hanya-baca).
    ['theme', 'vhms-threshold', 'sos-threshold', 'prioritas', 'clc', 'audit'].forEach(function (t) {
      var p = $('settings-panel-' + t);
      if (p) p.classList.toggle('hidden', t !== tab);
    });
    document.querySelectorAll('#settings-tabs .subtab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-settings-tab') === tab);
    });
    if (tab === 'vhms-threshold') { renderVhmsFamilyOptions(); renderVhmsThresholdTable(); refreshVhmsModelList(); renderVhmsModelTable(); renderFuelCalPanel(); renderEmptyWeightPanel(); syncEmptyWeightField(); }
    if (tab === 'sos-threshold') {
      renderSosComponentOptions();
      var sel = $('sos-threshold-component');
      if (sel) renderSosThresholdTable(sel.value || Object.keys(scfg.THRESHOLDS)[0]);
      refreshSosModelList(); renderSosModelTable();
    }
    if (tab === 'prioritas') { renderFollowupTable(); }
    if (tab === 'clc') { renderClcPanel(); }
    if (tab === 'audit') { renderAuditTrailPanel(); }
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
  loadFuelCal();
  loadEmptyWeight();

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

    // [SETELAN 2026-10-26] Kalibrasi otomatis Fuel Rate.
    var fSave = $('btn-fuelcal-save');
    if (fSave) fSave.addEventListener('click', function () {
      if (saveFuelCal()) toast('Kalibrasi Fuel Rate disimpan & diterapkan.', 'ok');
    });
    var fReset = $('btn-fuelcal-reset');
    if (fReset) fReset.addEventListener('click', function () {
      Object.assign(vcfg.FUEL_CALIBRATION, JSON.parse(JSON.stringify(FUELCAL_DEFAULT)));
      persistFuelCal(); reanalyzeAll(); renderFuelCalPanel();
      toast('Kalibrasi Fuel Rate dikembalikan ke default.', 'info');
    });

    // [SETELAN 2026-10-27] Berat kosong unit (emptyWeight) untuk normalisasi
    // GTKM. Lihat diskusi: HD785 nominal 91 t, Me = GVW - rated payload.
    var ewSave = $('btn-emptyweight-save');
    if (ewSave) ewSave.addEventListener('click', function () {
      saveEmptyWeight();
      toast('Berat kosong disimpan & diterapkan.', 'ok');
    });
    var ewReset = $('btn-emptyweight-reset');
    if (ewReset) ewReset.addEventListener('click', function () {
      resetEmptyWeight();
      toast('Berat kosong dikembalikan ke default katalog.', 'info');
    });
    var ewModel = $('emptyweight-model');
    if (ewModel) ewModel.addEventListener('input', syncEmptyWeightField);
    var ewValue = $('emptyweight-value');
    if (ewValue) ewValue.addEventListener('change', function () {
      var mi = $('emptyweight-model'), src = $('emptyweight-source');
      var model = mi && mi.value ? mi.value.trim() : '';
      var key = vcfg.normalizeModelKey(model);
      if (key && vcfg.MODEL_SPECS[key] && isFinite(parseFloat(ewValue.value))) {
        if (src) src.textContent = '(belum disimpan)';
      }
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

    // [P2-2b 2026-10-27] Jejak perubahan ambang (tab 'Jejak Perubahan').
    var auditClr = $('btn-threshold-audit-clear');
    if (auditClr) auditClr.addEventListener('click', clearAuditTrail);

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
    renderClcPanel: renderClcPanel,
    // [SETELAN 2026-10-26] Kalibrasi otomatis ambang Fuel Rate.
    loadFuelCal: loadFuelCal,
    persistFuelCal: persistFuelCal,
    renderFuelCalPanel: renderFuelCalPanel,
    saveFuelCal: saveFuelCal,
    // [SETELAN 2026-10-27] Berat kosong unit (emptyWeight) untuk GTKM.
    // Lihat diskusi: M_e = GVW - rated payload; konstan per unit.
    // Sumber default katalog, override via menu Setelan -> Ambang.
    loadEmptyWeight: loadEmptyWeight,
    persistEmptyWeight: persistEmptyWeight,
    renderEmptyWeightPanel: renderEmptyWeightPanel,
    syncEmptyWeightField: syncEmptyWeightField,
    saveEmptyWeight: saveEmptyWeight,
    resetEmptyWeight: resetEmptyWeight,
    EMPTYW_KEY: EMPTYW_KEY,
    open: openSettings,
    close: closeSettings,
    // [B15 2026-10-10] Diekspor agar dapat diuji langsung (migrasi satuan
    // duty gas buang detik -> persen). Bukan API publik aplikasi.
    isLegacyExhaustDutyUnit: isLegacyExhaustDutyUnit,
    // [HD465 2026-10-27] Diekspor agar migrasi ambang basi dapat DIKUNCI uji.
    isLegacyHd465Thresholds: isLegacyHd465Thresholds,
    // [P2-2 2026-10-27] Jejak audit perubahan ambang.
    getThresholdAudit: getThresholdAudit,
    recordThresholdAudit: recordThresholdAudit,
    auditThresholdDiff: auditThresholdDiff,
    buildExportObject: buildExportObject,
    THRESHOLD_AUDIT_LIMIT: THRESHOLD_AUDIT_LIMIT,
    /* [P2-2b 2026-10-27] Tampilan jejak. `auditTrailRows` dipisah dari
     * renderer agar escaping & format nilai lama/baru dapat dikunci uji
     * tanpa DOM (`AUD-4..AUD-7`). */
    auditTrailRows: auditTrailRows,
    renderAuditTrailPanel: renderAuditTrailPanel,
    clearAuditTrail: clearAuditTrail
  };
})(typeof window !== 'undefined' ? window : globalThis);

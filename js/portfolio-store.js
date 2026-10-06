/* =========================================================================
 * portfolio-store.js
 * -------------------------------------------------------------------------
 * Penyimpan + penggabung data pendukung halaman PORTOFOLIO:
 *   - Lifetime Unit  (dari LIFETIME_PARSER)
 *   - Top Up Oil     (dari TOPUP_PARSER)
 *
 * Semua data di-index per NOMOR LAMBUNG (dinormalisasi) sehingga dapat
 * digabung dengan unit SOS (SOS_STORE.assetId) dan VHMS (via Database Unit).
 * ========================================================================= */

(function (global) {
  'use strict';

  // Normalisasi kunci lambung: buang spasi/tanda, uppercase.
  // Sama dengan normSerial di vhms-unit-db.js agar konsisten.
  function normLambung(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /**
   * Normalisasi nama kompartemen untuk keperluan PENCOCOKAN (bukan tampilan).
   * Contoh: "HYD OIL" -> "HYDOIL"; "FINAL DRIVE LH" -> "FINALDRIVELH".
   */
  function normComp(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* -----------------------------------------------------------------------
   * [FIX 2026-10-01] Pencocokan kompartemen SADAR-SINONIM & TAHAN-URUTAN.
   * ---------------------------------------------------------------------
   * Sumber SOS & Lifetime memakai penamaan berbeda utk kompartemen yang SAMA:
   *   SOS "FINAL DRIVE REAR LEFT"  vs Lifetime "FINAL DRIVE LH REAR"
   *   SOS "FINAL DRIVE LEFT"       vs Lifetime "FINAL DRIVE LH"
   *   SOS "WHEEL BEARINGS FRONT LEFT" vs Lifetime "WHEEL BEARING LH FRONT"
   *   SOS "HYDRAULIC SYSTEM"       vs Lifetime "HYDRAULIC OIL"
   *   SOS "SWING DRIVE"            vs Lifetime "SWING BOX"
   * Pencocokan substring lama gagal utk kasus ini -> summary Lifetime kosong.
   *
   * Pendekatan baru:
   *   1) Token-kan (pisah non-alfanumerik), buang kata NOISE generik.
   *   2) Sinonim: LEFT->LH, RIGHT->RH, FRONT->F, REAR->R, dst.
   *   3) Cocok bila: (a) himpunan token SAMA, atau (b) substring normalisasi
   *      dua arah (kompatibel dgn perilaku lama, mis. "SWING" vs "SWING DRIVE"),
   *      atau (c) token inti (tanpa arah) sama + arah kompatibel.
   * --------------------------------------------------------------------- */
  // Kata yang TIDAK membedakan identitas kompartemen (dibuang saat tokenisasi).
  var COMP_NOISE = {
    SYSTEM: 1, SYSTEMS: 1, POWER: 1, SHIFT: 1, ASSY: 1, ASSEMBLY: 1,
    GROUP: 1, BOX: 1, OIL: 1, UNIT: 1, COMPONENT: 1, COMP: 1
  };
  // Sinonim token.
  var COMP_SYN = {
    LEFT: 'LH', L: 'LH', LH: 'LH',
    RIGHT: 'RH', R: 'RH', RH: 'RH',
    FRONT: 'F', F: 'F', FORWARD: 'F',
    REAR: 'R', BACK: 'R',
    CENTER: 'C', CENTRE: 'C', C: 'C', CTR: 'C',
    DRIVE: 'DRIVE', DRV: 'DRIVE', DRIVEN: 'DRIVE',
    BEARINGS: 'BEARING', BEARING: 'BEARING',
    WHEEL: 'WHEEL', WHEELS: 'WHEEL',
    DIFF: 'DIFFERENTIAL', DIFFERENTIAL: 'DIFFERENTIAL',
    TRANS: 'TRANSMISSION', TRANSMISSION: 'TRANSMISSION',
    HYD: 'HYDRAULIC', HYDRAULIC: 'HYDRAULIC', HYDRAULICS: 'HYDRAULIC',
    STEER: 'STEERING', STEERING: 'STEERING',
    SWING: 'SWING', SLEW: 'SWING'
  };

  function compTokens(s) {
    return String(s == null ? '' : s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  }
  function compCanonTokens(s) {
    return compTokens(s).filter(function (t) { return !COMP_NOISE[t]; }).map(function (t) {
      return COMP_SYN[t] || t;
    });
  }
  /**
   * Ekstraksi token "inti" untuk pencocokan SUPER-LONGGAR (fallback terakhir):
   *  - PTO/P.T.O -> PTO (supaya "POWER TAKE OFF" == "SPLITTER BOX PTO").
   *  - buang noise & sinonim.
   */
  function compKeyTokens(s) {
    var raw = compTokens(s);
    var toks = [];
    for (var i = 0; i < raw.length; i++) {
      // Gabung "POWER TAKE OFF" -> "PTO".
      if (raw[i] === 'POWER' && raw[i + 1] === 'TAKE' && raw[i + 2] === 'OFF') { toks.push('PTO'); i += 2; continue; }
      if (COMP_NOISE[raw[i]]) continue;
      var t = COMP_SYN[raw[i]] || raw[i];
      toks.push(t);
    }
    return toks;
  }
  function tokenSetEqual(a, b) {
    if (a.length !== b.length) return false;
    var sb = b.slice().sort();
    var sa = a.slice().sort();
    for (var i = 0; i < sa.length; i++) { if (sa[i] !== sb[i]) return false; }
    return true;
  }

  /**
   * Deteksi KONFLIK arah antar dua himpunan token.
   * Konflik bila satu sisi punya LH & sisi lain punya RH (tanpa sisi yg punya
   * keduanya), atau satu sisi F & sisi lain R (idem). Ini mencegah
   * "FINAL DRIVE LEFT" cocok dgn "FINAL DRIVE RH".
   */
  function hasDirConflict(ta, tb) {
    function sides(tokens) {
      var has = { LH: false, RH: false, F: false, R: false };
      tokens.forEach(function (t) { if (has[t] !== undefined) has[t] = true; });
      return has;
    }
    var A = sides(ta), B = sides(tb);
    // LH vs RH: konflik bila salah satu hanya LH dan lainnya hanya RH.
    var aLR = A.LH && !A.RH, bLR = B.LH && !B.RH;
    var aRR = A.RH && !A.LH, bRR = B.RH && !B.LH;
    if ((aLR && bRR) || (aRR && bLR)) return true;
    // F vs R: konflik bila salah satu hanya F dan lainnya hanya R.
    var aF = A.F && !A.R, bF = B.F && !B.R;
    var aR = A.R && !A.F, bR = B.R && !B.F;
    if ((aF && bR) || (aR && bF)) return true;
    return false;
  }

  /**
   * Cocokkan nama kompartemen dari sumber berbeda (SOS <-> Lifetime/Top-Up).
   * @returns {boolean}
   */
  function compMatches(a, b) {
    var na = normComp(a), nb = normComp(b);
    if (!na || !nb) return false;
    // Cepat: identik.
    if (na === nb) return true;
    // Token kanonik.
    var ta = compCanonTokens(a), tb = compCanonTokens(b);
    if (!ta.length || !tb.length) return false;
    // (a) himpunan token kanonik sama (tahan urutan & sinonim).
    if (tokenSetEqual(ta, tb)) return true;
    // (c) arah (LH/RH/F/R/C) harus kompatibel, lalu inti (tanpa arah) sama.
    var dirA = ta.filter(isDirToken).slice().sort().join(',');
    var dirB = tb.filter(isDirToken).slice().sort().join(',');
    var coreA = ta.filter(function (t) { return !isDirToken(t); }).sort().join(',');
    var coreB = tb.filter(function (t) { return !isDirToken(t); }).sort().join(',');
    if (coreA && coreA === coreB && dirA === dirB) return true;
    // Arah BERBEDA -> cek konflik: LH vs RH (atau F vs R) = JANGAN cocok.
    // Namun bila salah satu arah adalah SUBSET dari lainnya TANPA konflik
    // (mis. "FINAL DRIVE LH" vs "FINAL DRIVE REAR LEFT" -> {LH} ⊂ {LH,R}),
    // maka boleh cocok — nama yang lebih generik mewakili yang spesifik.
    var conflict = hasDirConflict(ta, tb);
    if (conflict) return false;
    if (coreA && coreB && coreA === coreB) return true;
    // (b) substring dua arah (perilaku lama — mis. "SWING" vs "SWING DRIVE").
    if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return true;
    // Token inti sama + salah satu tanpa arah -> cocok (generik vs spesifik arah).
    if (coreA && coreB && coreA === coreB) return true;
    // Inti salah satu substring inti lainnya (mis. "SWING" vs "SWING DRIVE"
    // ketika "BOX" dibuang sbg noise) — tetap harus kompatibel arah.
    var cA = coreA.replace(/,/g, ''), cB = coreB.replace(/,/g, '');
    if (cA && cB && (cA.indexOf(cB) !== -1 || cB.indexOf(cA) !== -1)) return true;
    // Fallback TERAKHIR: token inti kanonik (PTO diperluas, noise dibuang).
    var kA = compKeyTokens(a), kB = compKeyTokens(b);
    if (kA.length && kB.length) {
      var setA = {}, setB = {};
      kA.forEach(function (t) { setA[t] = true; });
      kB.forEach(function (t) { setB[t] = true; });
      var small = kA.length <= kB.length ? kA : kB;
      var big = kA.length <= kB.length ? setB : setA;
      var shared = small.filter(function (t) { return big[t]; });
      if (shared.length === small.length) return true; // subset + ada irisan
    }
    return false;
  }
  function isDirToken(t) { return t === 'LH' || t === 'RH' || t === 'F' || t === 'R' || t === 'C'; }

  /**
   * [FITUR 2026-10-06] SKOR pencocokan kompartemen untuk memilih baris Lifetime
   * PALING PRESISI saat beberapa baris ikut cocok (compMatches = boolean kasar).
   *
   * Masalah nyata: SOS "TRANSMISSION POWER SHIFT" ikut cocok ke DUA baris
   * Lifetime: "TRANSMISSION" (base, 62%) & "TRANSMISSION PUMP" (sub, 340%).
   * Pendekatan lama (lifePct tertinggi) salah memilih "TRANSMISSION PUMP".
   *
   * Solusi: beri skor berdasarkan tumpang-tindih token + PENALTI untuk token
   * EKSTRA yang ada di nama Lifetime tetapi TIDAK diminta oleh SOS. Baris yang
   * "paling dekat" (paling sedikit token tambahan) menang.
   *
   * Aturan skor (semakin besar = semakin presisi):
   *   +1000 bila normalisasi PERSIS sama.
   *   +400  bila himpunan token kanonik sama (hanya beda urutan/sinonim).
   *   +200  bila token inti (core, tanpa arah) sama.
   *   + 2 x jumlah token kanonik yang BERIRISAN.
   *   - 5 x jumlah token kanonik EKSTRA (ada di kandidat, tak diminta query).
   *   - 50 x bila ada KONFLIK arah (harusnya tak lolos compMatches).
   * @returns {number} skor (0 bila tidak cocok sama sekali)
   */
  function matchScore(query, candidate) {
    if (!compMatches(query, candidate)) return 0;
    var nq = normComp(query), nc = normComp(candidate);
    if (nq && nq === nc) return 1000;
    var tq = compCanonTokens(query), tc = compCanonTokens(candidate);
    if (tokenSetEqual(tq, tc)) return 400;
    var setQ = {}, setC = {};
    tq.forEach(function (t) { setQ[t] = true; });
    tc.forEach(function (t) { setC[t] = true; });
    var shared = 0;
    tq.forEach(function (t) { if (setC[t]) shared++; });
    var extra = 0;
    tc.forEach(function (t) { if (!setQ[t]) extra++; });
    var missing = 0;
    tq.forEach(function (t) { if (!setC[t]) missing++; });
    var score = 200 + shared * 2 - extra * 5 - missing * 3;
    if (hasDirConflict(tq, tc)) score -= 50;
    return score;
  }

  // ---- State ----
  var LS_LIFETIME_KEY = 'portfolio.lifetime.v1';
  var LS_TOPUP_KEY = 'portfolio.topup.v1';
  var LS_SECTION_KEY = 'portfolio.section.v1';

  var lifetime = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '' } };
  var topup = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '', codes: null } };
  // [FITUR 2026-09-30] Section unit (SN -> Lambung -> Section)
  var section = { byLambung: {}, rows: [], sections: {}, meta: { count: 0, loadedAt: null, source: '' } };

  // [FIX AUDIT 2026-10-04 · F-3] Data tersimpan yang gagal di-parse berarti
  // pengguna kehilangan dataset tanpa jejak. Minimal catat ke console.
  function warnLoad(label, e) {
    if (global.console && console.warn) console.warn('[PORTFOLIO_STORE] Gagal memuat ' + label + ' dari localStorage:', e && e.message);
  }

  // [POST-4 2026-10-03] Laporkan kegagalan penyimpanan (kuota penuh) ke pengguna
  // alih-alih menelan error secara senyap.
  var _quotaNotified = false;
  function reportQuota(e, label) {
    var isQuota = e && (e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
    console.warn('[PORTFOLIO_STORE] Gagal menyimpan ' + label + ':', e && e.message);
    if (isQuota && !_quotaNotified && global.SOS_APP && global.SOS_APP.toast) {
      _quotaNotified = true;
      global.SOS_APP.toast('Penyimpanan browser penuh — data ' + label + ' tidak tersimpan. Hapus sebagian data lama.', 'err', 8000);
    } else if (isQuota && !_quotaNotified) {
      _quotaNotified = true;
      try { alert('Penyimpanan browser penuh — data ' + label + ' tidak tersimpan. Hapus sebagian data lama.'); } catch (x) {}
    }
  }

  function saveLifetime() {
    // [POST-4 2026-10-03] Simpan HANYA rows + meta (byLambung adalah indeks
    // turunan — dibangun ulang saat load). Menghemat ~50% kuota localStorage.
    try {
      localStorage.setItem(LS_LIFETIME_KEY, JSON.stringify({ rows: lifetime.rows, meta: lifetime.meta }));
    } catch (e) {
      reportQuota(e, 'Lifetime');
    }
  }
  function buildIdx(rows) {
    var idx = {};
    (rows || []).forEach(function (r) {
      var k = normLambung(r.lambung);
      (idx[k] = idx[k] || []).push(r);
    });
    return idx;
  }
  function loadLifetime() {
    try {
      var s = localStorage.getItem(LS_LIFETIME_KEY);
      if (s) {
        var p = JSON.parse(s);
        var rows = (p && p.rows) ? p.rows : (Array.isArray(p) ? p : []);
        if (rows.length) lifetime = { byLambung: buildIdx(rows), rows: rows, meta: (p && p.meta) || { count: rows.length, loadedAt: null, source: '' } };
      }
    } catch (e) { warnLoad('Lifetime', e); }
  }

  function saveTopup() {
    try {
      localStorage.setItem(LS_TOPUP_KEY, JSON.stringify({ rows: topup.rows, meta: topup.meta }));
    } catch (e) {
      reportQuota(e, 'Top-Up Oil');
    }
  }
  function loadTopup() {
    try {
      var s = localStorage.getItem(LS_TOPUP_KEY);
      if (s) {
        var p = JSON.parse(s);
        var rows = (p && p.rows) ? p.rows : (Array.isArray(p) ? p : []);
        if (rows.length) topup = { byLambung: buildIdx(rows), rows: rows, meta: (p && p.meta) || { count: rows.length, loadedAt: null, source: '', codes: null } };
      }
    } catch (e) { warnLoad('Top-Up Oil', e); }
  }

  function saveSection() {
    try {
      // [POST-4] Simpan HANYA rows + meta; byLambung & sections dibangun ulang.
      localStorage.setItem(LS_SECTION_KEY, JSON.stringify({ rows: section.rows, meta: section.meta }));
    } catch (e) {
      reportQuota(e, 'Section');
    }
  }
  function loadSection() {
    try {
      var s = localStorage.getItem(LS_SECTION_KEY);
      if (s) {
        var p = JSON.parse(s);
        var rows = (p && p.rows) ? p.rows : (Array.isArray(p) ? p : []);
        if (rows.length) {
          var byLb = {}, secs = {};
          rows.forEach(function (r) {
            byLb[normLambung(r.lambung)] = r;
            if (r.section) secs[r.section] = (secs[r.section] || 0) + 1;
          });
          section = { byLambung: byLb, rows: rows, sections: secs, meta: (p && p.meta) || { count: rows.length, loadedAt: null, source: '' } };
        }
      }
    } catch (e) { warnLoad('Section', e); }
  }

  /* -----------------------------------------------------------------------
   * Setter data
   * --------------------------------------------------------------------- */
  function setLifetime(parsed, sourceName) {
    lifetime = {
      byLambung: (parsed && parsed.byLambung) || {},
      rows: (parsed && parsed.rows) || [],
      meta: {
        count: (parsed && parsed.count) || 0,
        skipped: (parsed && parsed.skipped) || 0,
        loadedAt: Date.now(),
        source: sourceName || ''
      }
    };
    saveLifetime();
    return lifetime.meta;
  }

  function setTopup(parsed, sourceName) {
    topup = {
      byLambung: (parsed && parsed.byLambung) || {},
      rows: (parsed && parsed.rows) || [],
      meta: {
        count: (parsed && parsed.count) || 0,
        excluded: (parsed && parsed.excluded) || 0,
        codes: (parsed && parsed.codes) || null,
        loadedAt: Date.now(),
        source: sourceName || ''
      }
    };
    saveTopup();
    return topup.meta;
  }

  function clearLifetime() {
    lifetime = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '' } };
    try { localStorage.removeItem(LS_LIFETIME_KEY); } catch (e) {}
  }
  function clearTopup() {
    topup = { byLambung: {}, rows: [], meta: { count: 0, loadedAt: null, source: '', codes: null } };
    try { localStorage.removeItem(LS_TOPUP_KEY); } catch (e) {}
  }
  /** [FITUR 2026-09-30] Set data Section (SN -> Lambung -> Section). */
  function setSection(parsed, sourceName) {
    section = {
      byLambung: (parsed && parsed.byLambung) || {},
      rows: (parsed && parsed.rows) || [],
      sections: (parsed && parsed.sections) || {},
      meta: {
        count: (parsed && parsed.count) || 0,
        skipped: (parsed && parsed.skipped) || 0,
        loadedAt: Date.now(),
        source: sourceName || ''
      }
    };
    saveSection();
    return section.meta;
  }
  function clearSection() {
    section = { byLambung: {}, rows: [], sections: {}, meta: { count: 0, loadedAt: null, source: '' } };
    try { localStorage.removeItem(LS_SECTION_KEY); } catch (e) {}
  }

  // Muat data dari localStorage saat inisialisasi
  loadLifetime();
  loadTopup();
  loadSection();

  /* -----------------------------------------------------------------------
   * Getter
   * --------------------------------------------------------------------- */
  function lifetimeMeta() { return lifetime.meta; }
  function topupMeta() { return topup.meta; }
  function sectionMeta() { return section.meta; }

  /**
   * [FITUR 2026-09-30] Ambil Section untuk sebuah lambung.
   * @param {string} lambung
   * @returns {string} nama section ('' bila tidak ada).
   */
  function getSection(lambung) {
    var row = section.byLambung[normLambung(lambung)];
    return row ? (row.section || '') : '';
  }

  /** Daftar section unik (terurut) + jumlah unit. */
  function sectionList() {
    return Object.keys(section.sections)
      .sort(function (a, b) { return a.localeCompare(b); })
      .map(function (name) { return { name: name, count: section.sections[name] }; });
  }

  /**
   * Ambil baris lifetime untuk sebuah lambung.
   * @param {string} lambung
   * @param {string} [component] bila diisi -> filter kompartemen yang cocok.
   * @returns {array}
   */
  function getLifetime(lambung, component) {
    var arr = lifetime.byLambung[normLambung(lambung)] || [];
    if (!component) return arr;
    return arr.filter(function (r) { return compMatches(r.component, component); });
  }

  /**
   * Ambil baris top up untuk sebuah lambung.
   * @param {string} lambung
   * @param {string} [component] bila diisi -> filter kompartemen yang cocok.
   * @returns {array}
   */
  function getTopup(lambung, component) {
    var arr = topup.byLambung[normLambung(lambung)] || [];
    if (!component) return arr;
    return arr.filter(function (r) { return compMatches(r.component, component); });
  }

  /**
   * Ringkasan lifetime untuk sebuah lambung (+ opsional kompartemen).
   * [FITUR 2026-10-06] Pemilihan baris representatif kini memakai SKOR
   * PRESISI (matchScore), bukan "exact-match ATAU lifePct tertinggi".
   * Ini mencegah sub-komponen (mis. "TRANSMISSION PUMP" 340%) mengalahkan
   * komponen utama ("TRANSMISSION" 62%) saat SOS meminta "TRANSMISSION POWER
   * SHIFT". Bila skor seri, lifePct tertinggi menang (mis. dua baris identik).
   * @returns {object} { row, rows, lifePct, ageHours, remainingHours, cycleBudget }
   */
  function lifetimeSummary(lambung, component) {
    var arr = getLifetime(lambung, component);
    if (!arr.length) return { row: null, rows: [] };
    // Bila komponen tidak ditentukan, ambil yang paling "terpakai".
    if (!component) {
      var bestNoComp = arr[0];
      arr.forEach(function (r) {
        var bp = (bestNoComp.lifePct === null || bestNoComp.lifePct === undefined) ? -Infinity : bestNoComp.lifePct;
        var rp = (r.lifePct === null || r.lifePct === undefined) ? -Infinity : r.lifePct;
        if (rp > bp) bestNoComp = r;
      });
      return mkSummary(bestNoComp, arr);
    }
    // Pilih baris dengan SKOR pencocokan terbaik; tie-break lifePct tertinggi.
    var best = arr[0], bestScore = -Infinity;
    for (var i = 0; i < arr.length; i++) {
      var sc = matchScore(component, arr[i].component);
      if (sc > bestScore) { bestScore = sc; best = arr[i]; continue; }
      if (sc === bestScore) {
        var bp2 = (best.lifePct === null || best.lifePct === undefined) ? -Infinity : best.lifePct;
        var rp2 = (arr[i].lifePct === null || arr[i].lifePct === undefined) ? -Infinity : arr[i].lifePct;
        if (rp2 > bp2) best = arr[i];
      }
    }
    return mkSummary(best, arr);
  }

  /** Bungkus hasil lifetimeSummary agar konsisten. */
  function mkSummary(best, arr) {
    return {
      row: best,
      rows: arr,
      lifePct: best.lifePct,
      ageHours: best.ageHours,
      remainingHours: best.remainingHours,
      cycleBudget: best.cycleBudget
    };
  }

  /**
   * Cari nomor lambung untuk sebuah unit berdasarkan identifier apa pun
   * (assetId/SN). Berguna saat menyambung unit SOS/VHMS.
   * Prioritas: cocokkan langsung di index lifetime/topup, lalu via Unit DB.
   */
  function resolveLambung(identifier, serial) {
    var cand = [normLambung(identifier)];
    if (lifetime.byLambung[cand[0]] || topup.byLambung[cand[0]]) return identifier;

    // Via Database Unit (SN -> lambung)
    var db = global.VHMS_UNITDB;
    if (db && db.getLambung && serial) {
      var lb = db.getLambung(serial);
      if (lb) return lb;
    }
    return identifier;
  }

  /* ----------------------------------------------------------------------- */
  global.PORTFOLIO_STORE = {
    normLambung: normLambung,
    normComp: normComp,
    compMatches: compMatches,
    matchScore: matchScore,
    setLifetime: setLifetime,
    setTopup: setTopup,
    setSection: setSection,
    clearLifetime: clearLifetime,
    clearTopup: clearTopup,
    clearSection: clearSection,
    lifetimeMeta: lifetimeMeta,
    topupMeta: topupMeta,
    sectionMeta: sectionMeta,
    getSection: getSection,
    sectionList: sectionList,
    getLifetime: getLifetime,
    getTopup: getTopup,
    lifetimeSummary: lifetimeSummary,
    resolveLambung: resolveLambung
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PORTFOLIO_STORE;
  }
})(typeof window !== 'undefined' ? window : globalThis);

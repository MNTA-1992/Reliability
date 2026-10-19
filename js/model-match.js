/* =========================================================================
 * model-match.js
 * -------------------------------------------------------------------------
 * Helper pencocokan nama model yang DIPAKAI BERSAMA oleh sos-config.js dan
 * vhms-config.js.
 *
 * [KONSOLIDASI 2026-10-04 · B-3] Sebelumnya `normModel`, `matchModelKey`, dan
 * `matchModelCandidateKeys` diduplikasi hampir identik di dua file config,
 * sehingga perilaku override threshold bisa DRIFT antar tab SOS & VHMS.
 * Fungsi murni di sini menjadi satu-satunya definisi.
 *
 * Semua fungsi menerima `keys` (daftar kunci model dari MODEL_THRESHOLDS
 * milik pemanggil), sehingga tidak bergantung pada state modul tertentu.
 * ========================================================================= */

(function (global) {
  'use strict';

  /** Normalisasi nama model: uppercase, rapikan spasi, trim. */
  function normModel(m) {
    return String(m == null ? '' : m).toUpperCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Cocokkan nama model bebas ke salah satu kunci (exact dulu, lalu substring
   * dua arah -> pilih kunci terpanjang = paling spesifik).
   * @param {string} model
   * @param {string[]} keys
   * @returns {string|null}
   */
  function matchModelKey(model, keys) {
    var m = normModel(model);
    if (!m || !keys || !keys.length) return null;
    // 1) Exact match.
    for (var i = 0; i < keys.length; i++) {
      if (normModel(keys[i]) === m) return keys[i];
    }
    // 2) Substring dua arah -> pilih kunci terpanjang (paling spesifik).
    var best = null;
    for (var j = 0; j < keys.length; j++) {
      var k = normModel(keys[j]);
      if (!k) continue;
      if (m.indexOf(k) !== -1 || k.indexOf(m) !== -1) {
        if (best === null || k.length > normModel(best).length) best = keys[j];
      }
    }
    return best;
  }

  /**
   * Daftar semua kunci yang cocok untuk `model`, urut paling UMUM (pendek) ->
   * paling SPESIFIK (panjang) agar override spesifik menimpa yang umum.
   * @param {string} model
   * @param {string[]} keys
   * @returns {string[]}
   */
  function matchModelCandidateKeys(model, keys) {
    var m = normModel(model);
    keys = keys || [];
    if (!m || !keys.length) return [];
    var hits = [];
    for (var i = 0; i < keys.length; i++) {
      var k = normModel(keys[i]);
      if (!k) continue;
      if (m === k || m.indexOf(k) !== -1 || k.indexOf(m) !== -1) hits.push(keys[i]);
    }
    hits.sort(function (a, b) { return normModel(a).length - normModel(b).length; });
    return hits;
  }

  var MODEL_MATCH = {
    normModel: normModel,
    matchModelKey: matchModelKey,
    matchModelCandidateKeys: matchModelCandidateKeys
  };

  global.MODEL_MATCH = MODEL_MATCH;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MODEL_MATCH;
  }
})(typeof window !== 'undefined' ? window : globalThis);

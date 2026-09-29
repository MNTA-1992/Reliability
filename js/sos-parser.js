/* =========================================================================
 * sos-parser.js
 * -------------------------------------------------------------------------
 * Parser CSV/Excel lab report SOS (Intertek, Trakindo, Dealer Lab).
 * Diproses sepenuhnya di browser — tidak ada data dikirim ke server.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.SOS_CONFIG;

  /* -----------------------------------------------------------------------
   * Utilitas
   * --------------------------------------------------------------------- */
  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9>µ%]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Deteksi baris HEADER yang berulang di tengah file (file SOS gabungan
   * beberapa batch ekspor). Cukup periksa beberapa sel khas label header.
   */
  function isRepeatedHeader(cells) {
    var probes = ['lab no', 'asset id', 'equipment id', 'component', 'meter', 'sampled date'];
    var hits = 0;
    var limit = Math.min(cells.length, 40);
    for (var i = 0; i < limit; i++) {
      var nk = normKey(cells[i]);
      for (var j = 0; j < probes.length; j++) {
        if (nk === probes[j]) { hits++; break; }
      }
    }
    return hits >= 3;   // >=3 sel persis label header -> baris header berulang
  }

  /** Nilai yang menyerupai label header (bukan data asli). */
  function looksLikeHeaderText(v) {
    var s = normKey(v);
    return s === 'lab no' || s === 'asset id' || s === 'equipment id' ||
           s === 'unit no' || s === 'component' || s === 'meter' || s === 'model';
  }

  function splitCsvLine(line) {
    var result = [], cell = '', inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if ((ch === ',' || ch === ';' || ch === '\t') && !inQuote) {
        result.push(cell.trim()); cell = ''; continue;
      }
      cell += ch;
    }
    result.push(cell.trim());
    return result;
  }

  function toFloat(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var s = String(raw).replace(/,/g, '.').replace(/[^0-9.\-eE]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function toDate(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    // Coba beberapa format umum
    // DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, MM/DD/YYYY
    var d;
    // ISO format
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    // DD/MM/YYYY or DD-MM-YYYY
    var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (!isNaN(d.getTime())) return d;
    }
    // fallback
    d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(d) {
    if (!d) return '';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + d.getFullYear();
  }

  /* -----------------------------------------------------------------------
   * buildColumnIndex — cocokkan header CSV ke key internal via COL_MAP
   * --------------------------------------------------------------------- */
  function buildColumnIndex(headers) {
    var index = {};
    var colMap = cfg.COL_MAP;
    headers.forEach(function (h, i) {
      var nk = normKey(h);
      if (colMap[nk]) {
        index[colMap[nk]] = i;
      }
    });
    return index;
  }

  /* -----------------------------------------------------------------------
   * parse — main entry point
   *   Input:  teks CSV mentah
   *   Output: { headers, samples, meta, errors }
   * --------------------------------------------------------------------- */
  function parse(text) {
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var result = { headers: [], samples: [], meta: { source: '' }, errors: [] };

    // Cari baris header (baris pertama yang mengandung kolom pengenal)
    var headerIdx = -1;
    var identifiers = ['lab no', 'sample number', 'laboratory number', 'equipment id',
                       'unit no', 'asset id', 'model', 'fe', 'iron', 'cu', 'copper'];

    for (var i = 0; i < Math.min(lines.length, 20); i++) {
      var nk = normKey(lines[i]);
      var matchCount = 0;
      identifiers.forEach(function (id) {
        if (nk.indexOf(id) !== -1) matchCount++;
      });
      if (matchCount >= 2) { headerIdx = i; break; }
    }

    if (headerIdx === -1) {
      result.errors.push('Tidak dapat menemukan baris header CSV. Pastikan kolom Lab No / Equipment ID / Fe / Cu ada.');
      return result;
    }

    var headers = splitCsvLine(lines[headerIdx]);
    result.headers = headers;
    var colIdx = buildColumnIndex(headers);

    // Cek minimal kolom yang diperlukan
    if (!('lab_no' in colIdx) && !('asset_id' in colIdx)) {
      // Coba pakai asset_id saja jika tidak ada lab_no
      if (!('asset_id' in colIdx)) {
        result.errors.push('Kolom "Lab No" atau "Equipment ID/Unit No" tidak ditemukan.');
        return result;
      }
    }

    // Parse data rows
    for (var r = headerIdx + 1; r < lines.length; r++) {
      var line = lines[r].trim();
      if (!line) continue;
      var cells = splitCsvLine(line);
      if (cells.length < 3) continue;

      // [REPEATED HEADER] File SOS gabungan sering mengulang baris header di
      // tengah file (mis. tiap batch ekspor). Lewati baris yang isinya sama
      // dengan header (mis. sel 'Lab No.' / 'Asset ID' / 'Meter').
      if (isRepeatedHeader(cells)) continue;

      var val = function (key) {
        return (key in colIdx) ? cells[colIdx[key]] : null;
      };

      var labNo = val('lab_no') || '';
      var assetId = val('asset_id') || '';
      if (!labNo && !assetId) continue; // skip empty rows
      // Tolak baris yang kolom identitasnya berupa label header (guard ganda).
      if (looksLikeHeaderText(labNo) || looksLikeHeaderText(assetId)) continue;

      var sample = {
        // Identity
        lab_no:        labNo,
        lab_date:      toDate(val('lab_date')),
        sampled_date:  toDate(val('sampled_date')),
        distribution_date: toDate(val('distribution_date')),

        // Asset
        model:         val('model') || '',
        asset_id:      assetId,
        asset_serial:  val('asset_serial') || '',
        component:     val('component') || '',
        component_serial: val('component_serial') || '',

        // Meters
        hm_unit:       toFloat(val('hm_unit')),
        hm_oil:        toFloat(val('hm_oil')),
        component_meter: toFloat(val('component_meter')),

        // Fluid
        fluid_changed: val('fluid_changed') || '',
        filter_changed: val('filter_changed') || '',
        fluid_brand:   val('fluid_brand') || '',
        fluid_type:    val('fluid_type') || '',
        fluid_weight:  val('fluid_weight') || '',

        // Org
        dealer:        val('dealer') || '',
        customer:      val('customer') || '',
        jobsite:       val('jobsite') || '',
        work_order:    val('work_order') || '',
        eval_status:   val('eval_status') || '',
        health:        val('health') || '',

        // Interpretation
        interp_text:       val('interp_text') || '',
        translated_interp: val('translated_interp') || '',

        // Wear metals
        wear_fe:  toFloat(val('wear_fe')),
        wear_cu:  toFloat(val('wear_cu')),
        wear_cr:  toFloat(val('wear_cr')),
        wear_pb:  toFloat(val('wear_pb')),
        wear_sn:  toFloat(val('wear_sn')),
        wear_si:  toFloat(val('wear_si')),
        wear_al:  toFloat(val('wear_al')),
        wear_ni:  toFloat(val('wear_ni')),

        // Additives
        additive_p:  toFloat(val('additive_p')),
        additive_mo: toFloat(val('additive_mo')),
        additive_ca: toFloat(val('additive_ca')),
        additive_zn: toFloat(val('additive_zn')),
        additive_mg: toFloat(val('additive_mg')),
        additive_b:  toFloat(val('additive_b')),
        additive_na: toFloat(val('additive_na')),
        additive_ba: toFloat(val('additive_ba')),

        // Oil condition
        visc_v100: toFloat(val('visc_v100')),
        visc_v40:  toFloat(val('visc_v40')),
        tbn:       toFloat(val('tbn')),
        water_pct: toFloat(val('water_pct')),
        fuel_pct:  toFloat(val('fuel_pct')),
        soot:      toFloat(val('soot')),
        oxidation: toFloat(val('oxidation')),
        nitration: toFloat(val('nitration')),
        sulfation: toFloat(val('sulfation')),

        // Cleanliness
        iso_code:  val('iso_code') || '',
        pqi:       toFloat(val('pqi')),
        pc_rating: val('pc_rating') || '',
        debris:    val('debris') || '',
        pc_4u:     toFloat(val('pc_4u')),
        pc_6u:     toFloat(val('pc_6u')),
        pc_14u:    toFloat(val('pc_14u')),
        pc_21u:    toFloat(val('pc_21u')),
        pc_38u:    toFloat(val('pc_38u')),
        pc_70u:    toFloat(val('pc_70u')),

        // Computed (filled by analytics)
        risk_tier: 0,
        mprs_score: 0,
        row_fe_100: null,
        dirt_entry_index: null,
      };

      // Effective date: sampled_date > lab_date > distribution_date
      sample._date = sample.sampled_date || sample.lab_date || sample.distribution_date;
      sample._dateStr = formatDate(sample._date);
      // [FIX] `_hm` = meter acuan untuk urutan/penentuan sampel TERBARU.
      // PRIORITAS harus `hm_unit` (SMR/HM mesin — naik monoton), BUKAN
      // `hm_oil` (meteran khusus oli yang bisa naik-turun/reset sehingga
      // membuat urutan salah). `hm_oil` hanya fallback bila hm_unit kosong.
      sample._hm = (sample.hm_unit !== null && sample.hm_unit !== undefined)
        ? sample.hm_unit
        : (sample.hm_oil !== null && sample.hm_oil !== undefined ? sample.hm_oil : 0);
      result.samples.push(sample);
    }

    // Sort by date
    result.samples.sort(function (a, b) {
      var da = a._date ? a._date.getTime() : 0;
      var db = b._date ? b._date.getTime() : 0;
      return da - db;
    });

    result.meta.source = 'CSV (' + result.samples.length + ' sampel)';
    return result;
  }

  /* -----------------------------------------------------------------------
   * parseFile — FileReader wrapper (returns Promise)
   * --------------------------------------------------------------------- */
  function parseFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var res = parse(e.target.result);
          res.meta.fileName = file.name;
          resolve(res);
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error('Gagal membaca file: ' + file.name)); };
      reader.readAsText(file, 'utf-8');
    });
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_PARSER = {
    parse: parse,
    parseFile: parseFile,
    formatDate: formatDate,
    _internals: { normKey: normKey, splitCsvLine: splitCsvLine, toFloat: toFloat, buildColumnIndex: buildColumnIndex }
  };

})(typeof window !== 'undefined' ? window : globalThis);

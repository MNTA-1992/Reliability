/* =========================================================================
 * sos-parser.js
 * -------------------------------------------------------------------------
 * Parser CSV/Excel lab report SOS (Intertek, Trakindo, Dealer Lab).
 * Diproses sepenuhnya di browser — tidak ada data dikirim ke server.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.SOS_CONFIG;
  // [KONSOLIDASI 2026-10-04 · B-1] Util CSV bersama.
  var _csv = global.CSV_UTIL || {};

  /**
   * [AUDIT 2026-10-15] Label manusiawi untuk field NON-PARAMETER.
   * `cfg.PARAMS` hanya memuat parameter lab (Fe, Cu, V100, …). Field meter &
   * identitas tidak ada di sana, sehingga pesan peringatan akan menampilkan
   * kunci internal ("hm_oil") kepada operator. Peta kecil ini menutup celah
   * itu tanpa mencemari `PARAMS` dengan entri yang bukan parameter.
   */
  var FIELD_LABELS = {
    hm_unit: 'HM Unit (meter mesin)',
    hm_oil: 'HM Oli (jam pada oli)',
    // [FASE 0 · 2026-10-18] Kolom "Calculated Meter on Fluid" = hitungan
    // pihak lab, key terpisah dari `hm_oil`.
    hm_oil_calc: 'HM Oli (hitungan lab)',
    component_meter: 'Meter Komponen',
    lab_no: 'Nomor Lab',
    asset_id: 'Nomor Lambung / Asset ID',
    asset_serial: 'Serial Number Unit',
    component: 'Kompartemen'
  };

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

  /**
   * Pisah satu baris CSV.
   * Mendukung pemisah koma / titik-koma / tab DAN tanda kutip dengan escape
   * `""` (dua kutip berturut => satu kutip literal), sama seperti parser CSV
   * lain di proyek ini (vhms-parser, vhms-unit-db, vhms-settings, dll).
   *
   * [FIX B1 2026-09-30] Versi lama hanya men-toggle kutip tanpa menangani
   * escape `""`, sehingga nilai seperti `A,"B""C,D",E` terpecah salah
   * (kolom bergeser -> parameter salah dipetakan).
   */
  function splitCsvLine(line) {
    // [KONSOLIDASI 2026-10-04 · B-1] Delegasi ke CSV_UTIL.splitMulti (multi
    // delimiter , ; \t + escape ""). Identik dengan implementasi lama di sini.
    if (_csv.splitMulti) return _csv.splitMulti(line);
    var result = [], cell = '', inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cell += '"'; i++; }   // escaped quote ""
          else { inQuote = false; }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',' || ch === ';' || ch === '\t') {
        result.push(cell.trim()); cell = '';
      } else {
        cell += ch;
      }
    }
    result.push(cell.trim());
    return result;
  }

  function toFloat(raw) {
    // [KONSOLIDASI 2026-10-04 · E-3] Delegasi ke CSV_UTIL.toNum (lebih ketat &
    // menangani locale "1.234,5" dgn benar). Versi lama membuang SEMUA karakter
    // non-numerik sehingga "D375A" -> 375 (salah); toNum mengembalikan null.
    if (_csv.toNum) return _csv.toNum(raw);
    if (raw === null || raw === undefined || raw === '') return null;
    var s = String(raw).replace(/,/g, '.').replace(/[^0-9.\-eE]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /**
   * [FIX 2026-09-30] Ambil nilai numerik + sanitasi terhadap rentang fisiologis.
   * Mengembalikan objek { value, invalid, raw } agar pemanggil dapat mencatat
   * parameter mana yang datanya tidak valid (noise dari file ekspor lab).
   *
   * - `value`   : nilai setelah sanitasi (mungkin dikoreksi / null).
   * - `invalid` : true bila nilai mentah di luar rentang wajar (setelah
   *               percobaan koreksi desimal) → dibuang dari analitik.
   * - `raw`     : nilai mentah sebelum sanitasi (untuk jejak audit).
   */
  function num(raw, paramKey) {
    var v = toFloat(raw);
    if (v === null) return { value: null, invalid: false, raw: null, corrected: false };
    var cfgSan = cfg.sanitizeValue;
    if (!cfgSan) return { value: v, invalid: false, raw: v, corrected: false };
    var wasAnomalous = cfg.isAnomalous ? cfg.isAnomalous(v, paramKey) : false;
    var cleaned = cfgSan(v, paramKey);
    return {
      value: cleaned,
      invalid: wasAnomalous && cleaned === null,
      corrected: wasAnomalous && cleaned !== null && cleaned !== v,
      raw: v
    };
  }

  // Helper ringkas: hanya nilai (dipakai bila jejak audit tak diperlukan).
  function numVal(raw, paramKey) { return num(raw, paramKey).value; }

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
    // [FIX C3 · 2026-10-19] Disambiguasi: jika salah satu komponen > 12,
    // komponen itu pasti hari. Default DD/MM/YYYY (konvensi Indonesia).
    var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      var a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
      if (b > 12) {
        // b > 12 berarti b = hari → format MM/DD/YYYY
        d = new Date(y, a - 1, b);
      } else {
        // Default DD/MM/YYYY (konvensi Indonesia)
        d = new Date(y, b - 1, a);
      }
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
  /**
   * [FIX 2026-10-05] Header CSV Web CAT MENGULANG nama kolom yang sama di
   * beberapa posisi (hasil gabungan banyak metode uji: ICP, RDE, RFS, dll).
   * Contoh terukur pada `Template SOS_Download Web CAT.csv` (11.236 baris):
   *
   *   Fe -> kolom 36 (83 terisi) & 184 (151 terisi)
   *   Cu -> kolom 35 (113)       & 152 (156)
   *   Si -> kolom 40 (158), 147 (66) & 182 (120)
   *   Al -> kolom 41 (164)       & 183 (149)
   *   Na -> kolom 155 (107)      & 179 (61)
   *
   * Versi lama menyimpan SATU indeks per key sehingga kolom terakhir selalu
   * menang. Baris yang nilainya hanya ada di kolom kiri terbaca KOSONG ->
   * tampil "—" di SOS Kompartemen List. Kini seluruh indeks disimpan dan
   * pembacaan mengambil nilai terisi PERTAMA (lihat `val()` di parse()).
   *
   * @param {string[]} headers
   * @returns {Object.<string, number[]>} key internal -> daftar indeks kolom
   */
  function buildColumnIndex(headers) {
    var index = {};
    var colMap = cfg.COL_MAP;
    headers.forEach(function (h, i) {
      var nk = normKey(h);
      var key = colMap[nk];
      if (!key) return;
      if (!index[key]) index[key] = [];
      index[key].push(i);
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

    /* -----------------------------------------------------------------------
     * [AUDIT 2026-10-15] PENCATAT KONFLIK KOLOM GANDA.
     * ---------------------------------------------------------------------
     * Satu key bisa memetakan ke BEBERAPA kolom (lihat `val()` di bawah) dan
     * `val()` memakai yang TERISI PERTAMA. Selama ini pilihan itu senyap —
     * kalau kolom-kolom itu berisi angka BERBEDA, aplikasi memakai salah
     * satunya tanpa memberi tahu siapa pun.
     *
     * Terukur pada berkas Web CAT nyata (2 426 baris): `hm_oil` memetakan ke
     * `"Meter on Fluid"` (index 9) DAN `"Calculated Meter on Fluid"` (index
     * 10), dan keduanya BERBEDA di 1 370 baris (56 %). Arah selisihnya tidak
     * konsisten (kadang kolom pertama lebih besar, kadang lebih kecil, 26
     * baris kolom kedua bernilai 0). `hm_oil` dipakai sebagai sumbu waktu
     * oleh `projectTrend`, jadi laju keausan & estimasi jam-ke-kritis bisa
     * menyimpang jauh.
     *
     * KEPUTUSAN (user, 2026-10-15): JANGAN ubah kolom yang dipilih — mana
     * yang otoritatif belum dikonfirmasi tim lab, dan ada baris di mana
     * justru kolom pertama yang benar. Yang ditambahkan HANYA transparansi:
     * hitung konfliknya dan laporkan lewat `meta` supaya tidak senyap.
     * --------------------------------------------------------------------- */
    var dupKeys = Object.keys(colIdx).filter(function (k) { return colIdx[k].length > 1; });
    var colConflict = {};   // paramKey -> { rows, headers:[], samples:[] }
    dupKeys.forEach(function (k) {
      colConflict[k] = {
        rows: 0,
        headers: colIdx[k].map(function (i) { return headers[i]; }),
        samples: []
      };
    });

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

      // [FIX 2026-10-05] Satu key bisa memetakan ke BEBERAPA kolom (header
      // berulang di CSV Web CAT). Ambil nilai terisi PERTAMA; bila semuanya
      // kosong kembalikan null. Berkas dengan header unik tidak terpengaruh
      // (daftar berisi satu indeks).
      var val = function (key) {
        var list = colIdx[key];
        if (!list) return null;
        for (var c = 0; c < list.length; c++) {
          var v = cells[list[c]];
          if (v != null && String(v).trim() !== '') return v;
        }
        return null;
      };

      var labNo = val('lab_no') || '';
      var assetId = val('asset_id') || '';
      if (!labNo && !assetId) continue; // skip empty rows
      // Tolak baris yang kolom identitasnya berupa label header (guard ganda).
      if (looksLikeHeaderText(labNo) || looksLikeHeaderText(assetId)) continue;

      // [AUDIT 2026-10-15] Catat baris di mana kolom-kolom yang memetakan ke
      // key SAMA berisi nilai BERBEDA. Dihitung SETELAH baris dipastikan
      // baris data (bukan header berulang), agar angkanya tidak terkotori.
      for (var dk = 0; dk < dupKeys.length; dk++) {
        var dKey = dupKeys[dk], dList = colIdx[dKey], terisi = [];
        for (var di = 0; di < dList.length; di++) {
          var dv = cells[dList[di]];
          if (dv != null && String(dv).trim() !== '') terisi.push(String(dv).trim());
        }
        if (terisi.length < 2) continue;
        var beda = false;
        for (var ti = 1; ti < terisi.length; ti++) {
          if (terisi[ti] !== terisi[0]) { beda = true; break; }
        }
        if (!beda) continue;
        var cc = colConflict[dKey];
        cc.rows++;
        if (cc.samples.length < 5) cc.samples.push(terisi.join(' vs '));
      }

      // [FIX 2026-09-30] Kumpulkan param yang nilainya di luar rentang wajar
      // (noise file ekspor lab) → dipakai untuk audit + badge di UI.
      var invalidParams = [];
      var correctedParams = [];

      function take(paramKey) {
        var res = num(val(paramKey), paramKey);
        if (res.invalid) invalidParams.push(paramKey);
        if (res.corrected) correctedParams.push(paramKey);
        return res.value;
      }

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
        hm_unit:       numVal(val('hm_unit'), 'hm_unit'),
        hm_oil:        numVal(val('hm_oil'), 'hm_oil'),
        // [FASE 0 · 2026-10-18] "Calculated Meter on Fluid" sebagai key
        // SENDIRI. Disanitasi TIDAK boleh `null`-kan nilai wajar: pakai
        // numVal tanpa rentang (sama seperti hm_oil).
        hm_oil_calc:   numVal(val('hm_oil_calc'), 'hm_oil_calc'),
        component_meter: numVal(val('component_meter'), 'component_meter'),

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
        wear_fe:  take('wear_fe'),
        wear_cu:  take('wear_cu'),
        wear_cr:  take('wear_cr'),
        wear_pb:  take('wear_pb'),
        wear_sn:  take('wear_sn'),
        wear_si:  take('wear_si'),
        wear_al:  take('wear_al'),
        wear_ni:  take('wear_ni'),

        // Additives
        additive_p:  take('additive_p'),
        additive_mo: take('additive_mo'),
        additive_ca: take('additive_ca'),
        additive_zn: take('additive_zn'),
        additive_mg: take('additive_mg'),
        additive_b:  take('additive_b'),
        additive_na: take('additive_na'),
        additive_ba: take('additive_ba'),
        // [FITUR 2026-10-17] Kalium — PEMBEDA kebocoran coolant (Na+K).
        // ⚠ Menambah alias di COL_MAP saja TIDAK CUKUP: objek sampel disusun
        // dari daftar eksplisit di sini, sehingga key yang tidak disebut akan
        // bernilai `undefined` tanpa error. Terbukti saat verifikasi browser:
        // alias terpasang, kolom ditemukan, tetapi fill = 0.
        additive_k:  take('additive_k'),

        // Oil condition
        visc_v100: take('visc_v100'),
        visc_v40:  take('visc_v40'),
        tbn:       take('tbn'),
        water_pct: take('water_pct'),
        fuel_pct:  take('fuel_pct'),
        soot:      take('soot'),
        oxidation: take('oxidation'),
        nitration: take('nitration'),
        sulfation: take('sulfation'),

        // Cleanliness
        iso_code:  val('iso_code') || '',
        pqi:       take('pqi'),
        pc_rating: val('pc_rating') || '',
        debris:    val('debris') || '',
        pc_4u:     take('pc_4u'),
        pc_6u:     take('pc_6u'),
        pc_14u:    take('pc_14u'),
        pc_21u:    take('pc_21u'),
        pc_38u:    numVal(val('pc_38u'), 'pc_38u'),
        pc_70u:    numVal(val('pc_70u'), 'pc_70u'),

        // Computed (filled by analytics)
        risk_tier: 0,
        mprs_score: 0,
        row_fe_100: null,
        dirt_entry_index: null,

        // [FIX] Jejak data tidak valid / dikoreksi (kosong bila semua wajar).
        _invalidParams: invalidParams,
        _correctedParams: correctedParams,
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

    // [FIX 2026-09-30] Ringkas jumlah nilai yang tidak valid (noise) untuk audit.
    var invalidParamCount = {};
    var samplesWithInvalid = 0;
    result.samples.forEach(function (s) {
      if (s._invalidParams && s._invalidParams.length) {
        samplesWithInvalid++;
        s._invalidParams.forEach(function (pk) { invalidParamCount[pk] = (invalidParamCount[pk] || 0) + 1; });
      }
    });
    result.meta.invalidParamCount = invalidParamCount;
    result.meta.samplesWithInvalid = samplesWithInvalid;
    if (samplesWithInvalid > 0) {
      result.meta.warnings = ['Sebagian nilai di luar rentang wajar dan sudah dibuang dari analitik'
        + ' (mis. viskositas tanpa titik desimal pada file ekspor lab).'
        + ' Sampel terdampak: ' + samplesWithInvalid + ' dari ' + result.samples.length + '.'];
    }

    /* [AUDIT 2026-10-15] Laporkan konflik kolom ganda. Hanya key yang
     * BENAR-BENAR berkonflik dilaporkan — berkas dengan header unik, atau
     * dengan kolom kembar yang isinya sama, tidak menghasilkan apa pun. */
    result.meta.columnConflicts = {};
    var nConflictKeys = 0;
    Object.keys(colConflict).forEach(function (k) {
      if (colConflict[k].rows > 0) {
        result.meta.columnConflicts[k] = colConflict[k];
        nConflictKeys++;
      }
    });
    if (nConflictKeys > 0) {
      result.meta.warnings = result.meta.warnings || [];
      Object.keys(result.meta.columnConflicts).forEach(function (k) {
        var c = result.meta.columnConflicts[k];
        // `hm_oil`/`hm_unit` tidak ada di PARAMS (bukan parameter lab) —
        // pakai label manusiawi agar pesan tidak menampilkan kunci internal.
        var label = (cfg.PARAMS[k] && cfg.PARAMS[k].label) || FIELD_LABELS[k] || k;
        result.meta.warnings.push(
          'Kolom ganda untuk ' + label + ': "' + c.headers.join('" & "')
          + '" berisi nilai BERBEDA pada ' + c.rows + ' dari ' + result.samples.length
          + ' sampel. Aplikasi memakai kolom "' + c.headers[0] + '" (yang terisi pertama).'
          + ' Contoh: ' + c.samples.slice(0, 3).join(' ; ') + '.'
          + ' Konfirmasikan ke tim lab kolom mana yang otoritatif.');
      });
    }

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
    _internals: { normKey: normKey, splitCsvLine: splitCsvLine, toFloat: toFloat, num: num, buildColumnIndex: buildColumnIndex }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

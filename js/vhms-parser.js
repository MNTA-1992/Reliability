/* =========================================================================
 * vhms-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk file CSV export VHMS Komatsu (format "Trend Analysis").
 *
 * STRUKTUR FILE (contoh trend0.CSV):
 *   [Common Header]
 *   Product Group,Excavator
 *   Machine Model,PC2000
 *   ...
 *   [Version Information]
 *   ...
 *   [Display Information]
 *   Data Type & Title,40,Trend Analysis
 *   Axis Type,4,100,2,2,...
 *   Axis Rate,10,1,1,...
 *   Status Of Item,0,0,0,...
 *
 *   [Data]
 *   <kolom header TANPA SEKsi>,         <- ini baris "Axis Item"
 *   <kolom satuan>,                     <- ini baris "Axis Scale"
 *   <baris data>...
 *
 * KARAKTERISTIK PENTING:
 *  - Baris data DIAWALI koma (kolom pertama kosong) -> nilai pertama = SMR.
 *  - Header kolom tidak diberi label "[Axis Item]"; ia baris pertama
 *    setelah "[Data]" yang mengandung banyak koma.
 *  - Banyak kolom punya sub-field tambahan (mis. Machine Type: "-8,STD").
 *    Karena itu PARSING SELALU BERBASIS NAMA HEADER, bukan indeks posisi.
 *  - Nilai sentinel (mis. -32768) berarti "tidak ada data" -> jadikan null.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  if (!cfg) {
    throw new Error('vhms-parser.js membutuhkan vhms-config.js dimuat lebih dulu.');
  }

  /* -----------------------------------------------------------------------
   * Utilitas teks
   * --------------------------------------------------------------------- */

  /** Normalisasi nama header untuk pencocokan toleran. */
  function normKey(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s._\-/()]+/g, '')   // buang spasi, titik, underscore, dsb.
      .trim();
  }

  /**
   * Pisah satu baris CSV dengan dukungan tanda kutip ("...").
   * VHMS tidak pakai kutip, tapi kita amankan untuk fleksibilitas.
   */
  function splitCsvLine(line) {
    var out = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuote = false; }
        } else { cur += ch; }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (v) { return v.trim(); });
  }

  /** Konversi string ke angka; kembalikan null jika bukan angka valid. */
  function toNumber(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '') return null;
    if (isSentinel(s)) return null;
    // buang pemisah ribuan bila ada (mis. "1,234" -> 1234 sudah terlanjur
    // terpecah oleh koma, jadi di sini cukup hilangkan spasi)
    s = s.replace(/\s+/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function isSentinel(s) {
    var list = cfg.NULL_SENTINELS || [];
    for (var i = 0; i < list.length; i++) {
      if (s === String(list[i])) return true;
    }
    return false;
  }

  /** Deteksi apakah sebuah baris punya pola seperti "[Section]". */
  function isSectionHeader(line) {
    return /^\s*\[.+\]\s*$/.test(line);
  }

  /* -----------------------------------------------------------------------
   * Pembacaan blok [Common Header]
   * --------------------------------------------------------------------- */
  function parseKeyValueBlocks(lines) {
    // Mengumpulkan pasangan key->value dari SEMUA blok sebelum [Data].
    // Contoh baris:  "Machine Model,PC2000"
    //                "Machine Serial No.,20046"
    var kv = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isSectionHeader(line)) continue;
      var parts = splitCsvLine(line);
      if (parts.length >= 2 && parts[0] !== '') {
        var key = parts[0];
        var val = parts.slice(1).filter(function (x) { return x !== ''; }).join(', ');
        if (!(key in kv)) kv[key] = val;
      }
    }
    return kv;
  }

  /* -----------------------------------------------------------------------
   * Inti: parse seluruh teks file
   * --------------------------------------------------------------------- */
  function parse(text) {
    var rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');

    // 1) Temukan indeks bagian [Data]
    var dataStart = -1;
    for (var i = 0; i < rawLines.length; i++) {
      if (/^\s*\[Data\]\s*$/i.test(rawLines[i])) { dataStart = i; break; }
    }
    if (dataStart === -1) {
      throw new Error('Bagian [Data] tidak ditemukan. Pastikan ini file export VHMS (.CSV) yang benar.');
    }

    var headerLines = rawLines.slice(0, dataStart);
    var bodyLines = rawLines.slice(dataStart + 1);

    // 2) Header blok identitas mesin
    var meta = parseKeyValueBlocks(headerLines);
    // Rapikan field yang umum dipakai
    var machine = {
      productGroup: meta['Product Group'] || '',
      model:        meta['Machine Model'] || '',
      serial:       meta['Machine Serial No.'] || '',
      engineModel:  meta['Engine Model & Serial No.1 2 3'] || meta['Engine Model  Serial No.1 2 3'] || '',
      timeStamp:    meta['Time Stamp'] || '',
      smrStart:     toNumber(meta['SMR']),
      comment:      meta['Comment'] || '',
      raw:          meta
    };

    // Ambil vendor/program version bila ada
    machine.formatVer  = meta['Format Ver.'] || '';
    machine.programVer = (meta['Program Ver.'] || '').split(',')[0] || '';

    // [REVISI] Deteksi keluarga produk lebih awal agar PEMETAAN KOLOM bisa
    // berbeda per keluarga (mis. nama kolom tekanan oli HD vs PC).
    var familyId = 'UNKNOWN';
    if (global.VHMS_PROFILES && global.VHMS_PROFILES.detectFamily) {
      try { familyId = global.VHMS_PROFILES.detectFamily(machine); } catch (e) { familyId = 'UNKNOWN'; }
    }
    // Peta parameter EFEKTIF untuk keluarga ini (PARAMS + override keluarga).
    var effParams = (cfg.paramsForFamily) ? cfg.paramsForFamily(familyId) : cfg.PARAMS;

    // 3) Cari definisi kolom. Header VHMS (baris "Axis Item") dan satuan
    //    ("Axis Scale") bisa berada DI BLOK ATAS (di dalam [Display
    //    Information]) maupun sebagai baris pertama di dalam [Data],
    //    tergantung versi exporter. Kita cari keduanya.
    var colDef = findColumnDefinition(headerLines, bodyLines);
    var dataFrom = colDef.bodyDataStart;

    // Bangun indeks nama -> posisi (normalized).
    function buildIndex(names) {
      var idx = {};
      for (var c = 0; c < names.length; c++) {
        var nm = names[c];
        if (nm === '') continue;
        idx[normKey(nm)] = c;
      }
      return idx;
    }

    // Loop parse yang sama, dipakai berulang untuk kandidat pemetaan kolom.
    function parseRows(names, units, colIndex) {
      var out = [];
      for (var k = dataFrom; k < bodyLines.length; k++) {
        var raw = bodyLines[k];
        if (raw === undefined || raw.trim() === '') continue;
        // Lewati baris definisi kolom ("Axis Item/Sale") dan blok lain
        if (/^\s*(Axis (Item|Scale)|Status Of Item|View Item)/i.test(raw)) continue;
        var cells = splitCsvLine(raw);
        var offset = (cells.length > 0 && cells[0] === '') ? 1 : 0;
        if (cells.length - offset < 3) continue;
        // Baris data harus diawali angka pada kolom SMR (setelah offset)
        if (toNumber(cells[offset]) === null) continue;
        var rec = parseRecord(cells, offset, names, colIndex, units, effParams);
        if (rec) out.push(rec);
      }
      return out;
    }

    // 4) Kandidat pertama: pakai header apa adanya (bila ada)
    var columnNames = colDef.names.slice();
    var unitRow = colDef.units.slice();
    var colIndex = buildIndex(columnNames);
    var usedFallback = false;
    var records = parseRows(columnNames, unitRow, colIndex);

    // 5) Fallback berbasis POSISI bila header tidak ada / parameter inti kosong.
    //    (Beberapa exporter hanya menulis [Data] tanpa baris nama kolom.)
    if (records.length === 0 || Object.keys(colIndex).length === 0 || !hasCoreParams(records)) {
      var fb = buildFallbackColumns(meta);
      columnNames = fb.names;
      unitRow = fb.units;
      colIndex = buildIndex(columnNames);
      usedFallback = true;
      var fallbackRecords = parseRows(columnNames, unitRow, colIndex);
      // Pakai hasil fallback hanya bila lebih baik
      if (fallbackRecords.length > 0) records = fallbackRecords;
    }

    if (records.length === 0) {
      throw new Error('Tidak ada baris data valid yang bisa dibaca dari bagian [Data]. ' +
        'Pastikan file export VHMS (.CSV) yang benar.');
    }

    // Urutkan naik berdasarkan SMR bila SMR tersedia.
    // [FIX B2 2026-09-30] Comparator harus TRANSITIF & konsisten: record tanpa
    // SMR diletakkan di akhir (bukan `return 0` yang membuat urutan tak stabil
    // saat banyak SMR null dan bisa mengacaukan sort library).
    records.sort(function (a, b) {
      var as = (a.smr === null || a.smr === undefined || isNaN(a.smr)) ? null : a.smr;
      var bs = (b.smr === null || b.smr === undefined || isNaN(b.smr)) ? null : b.smr;
      if (as === null && bs === null) return 0;
      if (as === null) return 1;    // a tanpa SMR -> ke bawah
      if (bs === null) return -1;   // b tanpa SMR -> ke bawah
      return as - bs;
    });

    return {
      meta: machine,
      familyId: familyId,
      columns: columnNames,
      units: unitRow,
      usedFallback: usedFallback,
      records: records
    };
  }

  /* -----------------------------------------------------------------------
   * Lokasi definisi kolom (header + satuan)
   * --------------------------------------------------------------------- */
  function findColumnDefinition(headerLines, bodyLines) {
    var names = null, units = [], bodyDataStart = 0;

    // a) Cari di blok atas: baris yang diawali "Axis Item,"
    for (var i = 0; i < headerLines.length; i++) {
      if (/^\s*Axis Item\s*(,|$)/i.test(headerLines[i])) {
        var parts = splitCsvLine(headerLines[i]);
        // Buang label "Axis Item" di depan; sisanya nama kolom
        // PENTING: baris DATA selalu diawali koma (kolom pertama kosong),
        // sehingga SMR berada di indeks 1 pada baris data, tetapi indeks 0
        // pada header setelah label dibuang. Kita pad dengan sel kosong
        // di depan agar penomoran kolom header SEJAJAR dengan baris data.
        if (parts.length > 0 && /^Axis Item$/i.test(parts[0].trim())) {
          parts = [''].concat(parts.slice(1));
        }
        names = parts;
        // Baris setelahnya biasanya "Axis Scale" -> satuan
        if (headerLines[i + 1] && /^\s*Axis Scale\s*(,|$)/i.test(headerLines[i + 1])) {
          var u = splitCsvLine(headerLines[i + 1]);
          if (u.length > 0 && /^Axis Scale$/i.test(u[0].trim())) u = [''].concat(u.slice(1));
          units = u;
        }
        break;
      }
    }

    if (names && names.length) {
      // Header ada di blok atas -> seluruh bodyLines adalah data
      return { names: names, units: units, bodyDataStart: 0 };
    }

    // b) Cari di dalam bodyLines: baris pertama non-kosong yang mengandung
    //    >=3 kolom dan bukan baris data.
    for (var j = 0; j < bodyLines.length; j++) {
      var line = bodyLines[j];
      if (line === undefined || line.trim() === '') continue;
      var cells = splitCsvLine(line);
      if (cells.length < 3) continue;
      // Baris data VHMS diawali koma (kolom 0 kosong) dan kolom 1 = angka SMR.
      var dataOffset = (cells[0] === '') ? 1 : 0;
      var isData = toNumber(cells[dataOffset]) !== null;
      if (!isData) {
        var hdr = cells;
        if (hdr.length && hdr[0] === '') hdr = hdr.slice(1);
        names = hdr;
        if (bodyLines[j + 1] !== undefined) {
          var us = splitCsvLine(bodyLines[j + 1]);
          if (us.length && us[0] === '') us = us.slice(1);
          units = us;
          return { names: names, units: units, bodyDataStart: j + 2 };
        }
        return { names: names, units: [], bodyDataStart: j + 1 };
      }
      break; // ketemu baris data lebih dulu -> tidak ada header eksplisit
    }

    // c) Tidak ada header eksplisit
    return { names: [], units: [], bodyDataStart: 0 };
  }

  /**
   * Pemetaan kolom berbasis POSISI (fallback).
   * Menggunakan baris "Axis Item" standar VHMS Trend Analysis PC2000.
   * Referensi: struktur umum export Trend Analysis.
   */
  function buildFallbackColumns(meta) {
    // Coba ambil Axis Type untuk memvalidasi jumlah kolom
    var names = [
      '', // kolom 0 kosong (penanda; SMR ada di indeks 1)
      'SMR', 'Calendar',
      'Eng.Speed(Max)', 'Eng.Speed(Ave)', 'BlowbyPress Max',
      'LBF Exh.TempMax', 'LBR Exh.TempMax', 'RBF Exh.TempMax', 'RBR Exh.TempMax',
      'Boost Press Max', 'EOil Pre.MAX', 'E.Oil P.L_Min', 'E.Oil P.H_Min',
      'Eng.Oil Tmp.MAX', 'Cool Temp.MAX', 'Cool Temp.Min', 'Fuel Rate',
      'Ambient TempMax', 'Ambient TempAve', 'Ambient TempMin', 'Atomos. Pres.Ave',
      'Pump 1F P.Max', 'Pump 1R P.Max', 'Pump 2F P.Max', 'Pump 2R P.Max',
      'FanPumpF P.Max', 'FanPumpR P.Max',
      'HydOilTempMax', 'HydOilTempAve', 'HydOilTempMin',
      'PTO Temp Max', 'PTO Temp Min',
      'Truck Counter1', 'Truck Counter2',
      'Load1F', 'Load1R', 'Load2F', 'Load2R', 'LoadFF', 'LoadFR',
      'Load Count', 'Swing Count', 'Auto GRS P.Max', 'Auto GRS P. ON',
      'Pump1 Torque Max', 'Pump1 Torque Ave', 'Pump2 Torque Max', 'Pump2 Torque Ave',
      'FanPumpTorque Max', 'FanPumpTorque Ave',
      'Engine Power Max', 'Engine Power Ave', 'Eco Mode on'
    ];
    var units = [
      '', 'h', '',
      'rpm', 'rpm', 'kPa',
      'degC', 'degC', 'degC', 'degC',
      'kPa', 'MPa', 'MPa', 'MPa',
      'degC', 'degC', 'degC', 'Liter/h',
      'degC', 'degC', 'degC', 'hPa',
      'MPa', 'MPa', 'MPa', 'MPa',
      'MPa', 'MPa',
      'degC', 'degC', 'degC',
      'degC', 'degC',
      'Times', 'Times',
      '10^8Times', '10^8Times', '10^8Times', '10^8Times', '10^6Times', '10^6Times',
      'Times', 'Times', 'MPa', 'Times',
      'Nm', 'Nm', 'Nm', 'Nm',
      'Nm', 'Nm',
      'kW', 'kW', 'sec'
    ];
    return { names: names, units: units };
  }

  /** Cek apakah parameter inti berhasil terisi (bukan semua null). */
  function hasCoreParams(records) {
    var cores = ['blowbyMax', 'hydTempMax', 'coolantTemp', 'fuelRate', 'engSpeedAve'];
    for (var i = 0; i < records.length; i++) {
      var n = 0;
      for (var j = 0; j < cores.length; j++) {
        if (records[i][cores[j]] !== null) n++;
      }
      if (n >= 2) return true;
    }
    return false;
  }

  /* -----------------------------------------------------------------------
   * Konversi satu baris data mentah -> record terstruktur
   * --------------------------------------------------------------------- */
  function parseRecord(cells, offset, columnNames, colIndex, unitRow, effParams) {
    var P = effParams || cfg.PARAMS;

    // Fungsi ambil nilai berdasarkan nama header (fuzzy/normalized).
    // [REVISI] Coba SEMUA nama alternatif (csvHeader + aliases) parameter.
    function resolveIndex(def) {
      var names = (cfg.paramHeaders) ? cfg.paramHeaders(def) : [def.csvHeader];
      for (var n = 0; n < names.length; n++) {
        var idx = colIndex[normKey(names[n])];
        if (idx !== undefined) return idx;
      }
      return undefined;
    }

    var rec = {};

    // SMR = umumnya kolom pertama data (setelah offset).
    // Terapkan SMR_SCALE bila CSV menyimpan SMR dalam satuan 0.1 jam.
    rec.smr = toNumber(cells[offset]);
    if (rec.smr !== null && cfg.SMR_SCALE) rec.smr = rec.smr * cfg.SMR_SCALE;

    // Calendar: kolom kedua data biasanya timestamp unix
    var calRaw = cells[offset + 1];
    rec.calendarRaw = calRaw || null;
    rec.calendar = decodeCalendar(calRaw);

    // Iterasi seluruh parameter yang terkonfigurasi (efektif per keluarga)
    for (var key in P) {
      if (!Object.prototype.hasOwnProperty.call(P, key)) continue;
      if (key === 'smr' || key === 'calendar') continue;
      var def = P[key];
      var idx2 = resolveIndex(def);
      var raw = (idx2 === undefined) ? null : cells[idx2];
      var val = toNumber(raw);
      // Terapkan faktor skala bila kolom disimpan dalam satuan terkecil
      if (val !== null && def.scale) val = val * def.scale;
      rec[key] = val;
    }

    // Simpan semua kolom mentah (untuk tabel "semua parameter"/debug)
    rec.raw = {};
    for (var i = 0; i < columnNames.length; i++) {
      var name = columnNames[i];
      if (!name) continue;
      rec.raw[name] = cells[i] !== undefined ? cells[i] : null;
    }

    // [POIN 3] Simpan satuan yang sudah dinormalisasi per parameter,
    // diambil dari baris "Axis Scale" bila tersedia. Dipakai untuk
    // menstandardisasi label/legend/axis chart sesuai konvensi Komatsu.
    rec._units = {};
    if (unitRow && unitRow.length) {
      for (var k2 in P) {
        if (!Object.prototype.hasOwnProperty.call(P, k2)) continue;
        if (k2 === 'smr' || k2 === 'calendar') continue;
        var def2 = P[k2];
        var idxU = resolveIndex(def2);
        if (idxU !== undefined && unitRow[idxU] !== undefined) {
          rec._units[k2] = cfg.normalizeUnit ? cfg.normalizeUnit(unitRow[idxU]) : unitRow[idxU];
        }
      }
    }

    return rec;
  }

  /**
   * Decode field Calendar VHMS.
   * Format: "1733013976|28800|0"  =>  unixEpoch | offsetDetik | flag
   * Offset 28800 = UTC+8 (WITA). Kita jumlahkan agar jam lokal benar.
   */
  function decodeCalendar(raw) {
    if (!raw || raw === '-') return null;
    var parts = String(raw).split('|');
    var epoch = parseFloat(parts[0]);
    if (isNaN(epoch)) return null;
    var tzOffset = parts.length > 1 ? (parseFloat(parts[1]) || 0) : 0;
    var ms = (epoch + tzOffset) * 1000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return {
      epoch: epoch,
      tzOffsetSec: tzOffset,
      date: d,
      // String tanggal siap-tampil dalam zona lokal-perhitungan (WITA)
      display: formatDateTime(d)
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDateTime(d) {
    // Pakai UTC karena kita sudah menambahkan offset zona secara manual.
    return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  /* -----------------------------------------------------------------------
   * [POIN 3] Satuan standar per parameter.
   * Prioritas: satuan dari file (Axis Scale, sudah dinormalisasi) ->
   *            satuan baku di config.
   * --------------------------------------------------------------------- */
  function getColumnUnit(parsed, paramKey) {
    if (!parsed) return '';
    var recs = parsed.records || [];
    for (var i = 0; i < recs.length && i < 20; i++) {
      if (recs[i]._units && recs[i]._units[paramKey]) return recs[i]._units[paramKey];
    }
    // Fallback: satuan baku dari config (family-aware bila tersedia)
    var P = (cfg.paramsForFamily && parsed.familyId) ? cfg.paramsForFamily(parsed.familyId) : cfg.PARAMS;
    var meta = P[paramKey] || cfg.PARAMS[paramKey];
    return meta ? (meta.unit || '') : '';
  }

  /* -----------------------------------------------------------------------
   * API publik
   * --------------------------------------------------------------------- */
  global.VHMS_PARSER = {
    parse: parse,
    getColumnUnit: getColumnUnit,
    parseFile: function (file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          try { resolve(parse(reader.result)); }
          catch (e) { reject(e); }
        };
        reader.onerror = function () { reject(new Error('Gagal membaca file.')); };
        // VHMS kadang menulis header UTF-8 BOM; pakai utf-8 (BOM ditangani)
        reader.readAsText(file, 'utf-8');
      });
    },
    _internals: { splitCsvLine: splitCsvLine, toNumber: toNumber, normKey: normKey, decodeCalendar: decodeCalendar }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

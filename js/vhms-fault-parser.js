/* =========================================================================
 * vhms-fault-parser.js
 * -------------------------------------------------------------------------
 * Parser untuk blok Fault History VHMS (file `fault0.CSV`, Data Type '10')
 * dan utilitas pembaca field waktu epoch VHMS.
 *
 * MENGAPA MODUL TERPISAH:
 *   Struktur fault history SANGAT berbeda dari trend: kolom pertama setelah
 *   offset adalah KODE ALFANUMERIK fault (mis. `DHE5KB`), bukan SMR. Sumbu
 *   waktunya adalah pasangan `From Time` / `To Time`, sedangkan `From SMR`
 *   dan `To SMR` RUSAK (konstan = SMR saat download) sehingga TIDAK DIPAKAI.
 *
 * STRUKTUR FILE (contoh `fault0.CSV`):
 *   [Display Information]
 *   Data Type & Title,10,Fault History
 *   Column Type,C,4,100,4,100,2,2,C
 *   Column Rate,0,10,1,10,1,1,1,0
 *
 *   Column Item,Code,From SMR,From Time,To SMR,To Time,C-GC View Flag,Count,Error Message
 *   Column Scale,,h,,h,,,,
 *   [Data]
 *   ,DHE5KB,288121,1683335875|28800|0,288121,1683335951|28800|0,1,5,"Blowby pressure sensor failure"
 *
 * CATATAN WAJIB:
 *  - `Error Message` memakai tanda kutip ganda dan dapat berisi koma ->
 *    gunakan CSV_UTIL.splitLine, JANGAN `split(',')`.
 *  - `From Time` / `To Time` berformat `epoch|tzOffsetSeconds|dst`.
 *    `0|0|0` pada `To Time` berarti fault BELUM PULIH (masih aktif).
 *  - `Count` = jumlah kemunculan dalam satu rentang (BUKAN durasi/detik).
 *  - `From SMR` / `To SMR` sengaja TIDAK dibaca; hasil menandai
 *    `smrUnreliable: true` agar konsumen tidak memakainya sebagai sumbu waktu.
 * ========================================================================= */

(function (global) {
  'use strict';

  var _csv = global.CSV_UTIL || {};

  /* -----------------------------------------------------------------------
   * Utilitas
   * --------------------------------------------------------------------- */

  /** Fallback split CSV bila CSV_UTIL belum tersedia (uji terisolasi). */
  function splitLine(line, delim) {
    if (_csv.splitLine) return _csv.splitLine(line, delim || ',');
    return String(line).split(delim || ',');
  }

  /** Normalisasi nama header: lowercase, tanpa spasi/tanda. */
  function normHeader(s) {
    if (_csv.normHeader) return _csv.normHeader(s);
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-/()%]+/g, '');
  }

  /** Konversi aman ke angka; nilai kosong/bukan angka -> null. */
  function toNum(raw) {
    if (_csv.toNum) return _csv.toNum(raw);
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-') return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /* -----------------------------------------------------------------------
   * [T1.4] parseEpochField — baca field waktu VHMS `epoch|tzOffset|dst`
   * ---------------------------------------------------------------------
   * `0|0|0` (atau kosong) menandakan "belum pulih" -> epoch: null.
   * Nilai `dst` disimpan apa adanya (tidak diinterpretasikan) karena belum
   * ada bukti bahwa flag itu dipakai untuk koreksi waktu.
   * @param {string} s
   * @returns {{epoch: number|null, tzOffset: number, dst: number}}
   * --------------------------------------------------------------------- */
  function parseEpochField(s) {
    var out = { epoch: null, tzOffset: 0, dst: 0 };
    if (s === null || s === undefined) return out;
    var raw = String(s).trim();
    if (!raw || raw === '-') return out;
    var parts = raw.split('|');
    var ep = toNum(parts[0]);
    out.tzOffset = parts.length > 1 ? (toNum(parts[1]) || 0) : 0;
    out.dst = parts.length > 2 ? (toNum(parts[2]) || 0) : 0;
    // 0 = sentinel "belum pulih" (bukan 1970-01-01).
    if (ep === null || ep <= 0) return out;
    out.epoch = ep;
    return out;
  }

  /** Format epoch (+offset) menjadi tanggal siap-tampil (UTC setelah offset). */
  function formatEpoch(epoch, tzOffsetSec) {
    if (epoch === null || epoch === undefined) return '';
    var d = new Date((epoch + (tzOffsetSec || 0)) * 1000);
    if (isNaN(d.getTime())) return '';
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() +
      ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }

  /* -----------------------------------------------------------------------
   * [T1.4] parseFault — baca fault0.CSV menjadi daftar event
   * ---------------------------------------------------------------------
   * @param {string} text isi file CSV
   * @returns {object} {
   *   meta, dataType: '10', dataTitle,
   *   events: [{ code, msg, fromEpoch, toEpoch, durationSec, count, active }],
   *   smrUnreliable: true, columns, units, warnings[]
   * }
   * --------------------------------------------------------------------- */
  function parseFault(text) {
    var rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');

    // 1) Cari [Data]
    var dataStart = -1;
    for (var i = 0; i < rawLines.length; i++) {
      if (/^\s*\[Data\]\s*$/i.test(rawLines[i])) { dataStart = i; break; }
    }
    if (dataStart === -1) {
      throw new Error('Bagian [Data] tidak ditemukan. Pastikan ini file Fault History VHMS (.CSV).');
    }

    var headerLines = rawLines.slice(0, dataStart);
    var bodyLines = rawLines.slice(dataStart + 1);

    // 2) Metadata identitas unit (blok key,value) + tipe file
    var meta = {};
    for (var h = 0; h < headerLines.length; h++) {
      var line = headerLines[h];
      if (/^\s*\[.+\]\s*$/.test(line)) continue;
      var kv = splitLine(line, ',');
      if (kv.length >= 2 && kv[0] !== '' && !/^\s*(Axis|Column)\s+(Item|Scale)/i.test(line)) {
        if (!(kv[0] in meta)) {
          meta[kv[0]] = kv.slice(1).filter(function (x) { return x !== ''; }).join(', ');
        }
      }
    }

    var dataType = '', dataTitle = '';
    for (var d = 0; d < headerLines.length; d++) {
      var m = /^\s*Data Type\s*&\s*Title\s*,(.*)$/i.exec(headerLines[d]);
      if (m) {
        var dt = splitLine(m[1], ',');
        dataType = (dt[0] || '').trim();
        dataTitle = (dt[1] || '').trim();
        break;
      }
    }

    // 3) Header kolom: "Column Item" / "Column Scale" (alias Axis)
    var colNames = null;
    for (var c = 0; c < headerLines.length; c++) {
      if (/^\s*(?:Axis|Column)\s+Item\s*(,|$)/i.test(headerLines[c])) {
        var parts = splitLine(headerLines[c], ',');
        if (parts.length && /^(?:Axis|Column) Item$/i.test(parts[0].trim())) {
          parts = [''].concat(parts.slice(1));
        }
        colNames = parts;
        break;
      }
    }
    // Fallback: header di dalam [Data] (baris non-data pertama)
    if (!colNames) {
      for (var b = 0; b < bodyLines.length; b++) {
        var bl = bodyLines[b];
        if (!bl || !bl.trim()) continue;
        if (/^\s*(?:Axis|Column)\s+(Item|Scale)/i.test(bl)) continue;
        var cells0 = splitLine(bl, ',');
        if (cells0.length < 3) continue;
        var off0 = (cells0[0] === '') ? 1 : 0;
        if (!cells0[off0]) continue;   // baris data (kode fault terisi)
        var hdr = cells0;
        if (hdr.length && hdr[0] === '') hdr = hdr.slice(1);
        colNames = hdr;
        dataStart = dataStart + b;     // baris ini adalah header
        break;
      }
    }

    colNames = colNames || [];
    // Peta nama kolom -> indeks (berbasis NAMA, bukan posisi)
    var idx = {};
    colNames.forEach(function (nm, ix) { if (nm !== '') idx[normHeader(nm)] = ix; });
    function col() {
      for (var a = 0; a < arguments.length; a++) {
        var k = normHeader(arguments[a]);
        if (idx[k] !== undefined) return idx[k];
      }
      return -1;
    }
    var iCode = col('Code');
    var iFromTime = col('From Time');
    var iToTime = col('To Time');
    var iCount = col('Count');
    var iMsg = col('Error Message');

    var warnings = [];
    if (iCode < 0) warnings.push('Kolom "Code" tidak ditemukan — parser memakai posisi kolom standar.');
    if (iFromTime < 0) warnings.push('Kolom "From Time" tidak ditemukan — sumbu waktu fault tidak tersedia.');

    // 4) Iterasi baris data
    var events = [];
    var bodyFrom = (colNames.length && !/^\s*(?:Axis|Column)\s+Item/i.test(bodyLines[0] || '')) ? 0 : 0;
    for (var r = bodyFrom; r < bodyLines.length; r++) {
      var raw = bodyLines[r];
      if (raw === undefined || raw.trim() === '') continue;
      if (/^\s*(?:Axis|Column)\s+(Item|Scale)/i.test(raw)) continue;
      var cells = splitLine(raw, ',');
      var offset = (cells.length && cells[0] === '') ? 1 : 0;
      if (cells.length - offset < 2) continue;

      var code = (iCode >= 0 ? cells[iCode] : cells[offset]) || '';
      code = String(code).trim();
      if (!code) continue;
      // Lewati baris yang jelas bukan data (mis. sisa baris label)
      if (/^(Code|From Time|To Time)$/i.test(code)) continue;

      var fromF = parseEpochField(iFromTime >= 0 ? cells[iFromTime] : cells[offset + 2]);
      var toF = parseEpochField(iToTime >= 0 ? cells[iToTime] : cells[offset + 4]);
      var cnt = toNum(iCount >= 0 ? cells[iCount] : null);
      // Count bukan durasi -> default 1 bila kosong (1 kemunculan).
      if (cnt === null) cnt = 1;
      if (cnt < 0) cnt = 0;

      var durationSec = null;
      if (fromF.epoch !== null && toF.epoch !== null) {
        durationSec = toF.epoch - fromF.epoch;
        if (durationSec < 0) durationSec = 0;
      }

      events.push({
        code: code,
        msg: String(iMsg >= 0 ? (cells[iMsg] || '') : '').trim(),
        fromEpoch: fromF.epoch,
        toEpoch: toF.epoch,
        fromTzOffset: fromF.tzOffset,
        toTzOffset: toF.tzOffset,
        fromDisplay: formatEpoch(fromF.epoch, fromF.tzOffset),
        toDisplay: formatEpoch(toF.epoch, toF.tzOffset),
        durationSec: durationSec,
        count: cnt,
        active: toF.epoch === null
        // CATATAN: fromSmr/toSmr SENGAJA tidak diisi — lihat smrUnreliable.
      });
    }

    return {
      meta: meta,
      dataType: dataType || '10',
      dataTitle: dataTitle || 'Fault History',
      columns: colNames,
      events: events,
      // `From SMR`/`To SMR` konstan (= SMR download) -> TIDAK DIPAKAI.
      smrUnreliable: true,
      warnings: warnings
    };
  }

  /* -----------------------------------------------------------------------
   * [T1.4] parseTmTrend — delegasi ke VHMS_PARSER.parse()
   * ---------------------------------------------------------------------
   * Format `tm_trend0.CSV` identik dengan trend utama (`Axis Item`/`Axis
   * Scale`), sehingga parser utama sudah bisa membacanya secara mekanis.
   * Fungsi ini hanya menegaskan tipe file '81' lalu mengembalikan records.
   * --------------------------------------------------------------------- */
  function parseTmTrend(text) {
    var parser = global.VHMS_PARSER;
    if (!parser || typeof parser.parse !== 'function') {
      throw new Error('VHMS_PARSER tidak tersedia — muat js/vhms-parser.js lebih dulu.');
    }
    var parsed = parser.parse(text);
    if (parsed.dataType && parsed.dataType !== '81') {
      // Bukan kegagalan fatal: tetap kembalikan hasilnya, tetapi tandai.
      parsed.tmTrendWarning = 'Data Type bukan 81 (ditemukan ' + parsed.dataType + ').';
    }
    parsed.dataType = '81';   // normalisasi agar konsumen yakin
    return parsed;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_FAULT_PARSER = {
    parseEpochField: parseEpochField,
    parseFault: parseFault,
    parseTmTrend: parseTmTrend,
    formatEpoch: formatEpoch,
    _internals: { normHeader: normHeader, toNum: toNum }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_FAULT_PARSER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

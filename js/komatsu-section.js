/* =========================================================================
 * komatsu-section.js
 * -------------------------------------------------------------------------
 * [PC2000 2026-10-10 — T2] PEMBACA BLOK `[Section]` KOMATSU — SATU sumber.
 *
 * MENGAPA MODUL INI ADA
 * ---------------------
 * Setiap ekspor VHMS Komatsu berbentuk berkas ber-blok:
 *
 *     [Common Header]
 *     Product Group,Excavator
 *     ...
 *     [Display Information]
 *     Data Type & Title,60,Snap-shot0
 *     Axis Item,Time,Eng Speed,...
 *     Axis Scale,sec,rpm,...
 *     Axis Rate,1000,1,...
 *     [Data]
 *     ,-140000,0,0,42,...
 *
 * Pola "cari [Data], baca baris `Axis Item`/`Column Item` + `... Scale` +
 * `... Rate`, lalu iterasi baris data" SEBELUMNYA disalin di TIGA modul
 * (`vhms-parser.js`, `vhms-fault-parser.js`, `vhms-clutch.js`). Dengan
 * tambahan `vhms-opava.js`, `vhms-loadmap.js`, dan `vhms-snapshot.js` jumlah
 * salinan menjadi ENAM — setiap perbaikan parsing harus ditambal enam kali.
 *
 * Modul ini mengekstrak pembacaan blok menjadi SATU fungsi murni. Modul
 * BARU memakainya sejak awal; modul lama dapat direfaktor bertahap dengan
 * suite uji yang ada sebagai jaring keamanan.
 *
 * API
 * ---
 *   KOMATSU_SECTION.read(text) -> {
 *     headerLines[], dataLines[],
 *     dataStartIndex,
 *     meta{},                    // pasangan key->nilai dari SEMUA blok header
 *     dataType{type,title},      // dari "Data Type & Title"
 *     samplingTime,
 *     trigger{smr,code,message}, // dari "SMR & Trigger Code & Trigger Message"
 *     axisItem[], axisScale[], axisRate[],   // blok sumbu/kolom (Kalau ada)
 *     columnItem[], columnScale[], columnRate[],
 *     items[], scales[], rates[],            // yang mana pun yang tersedia
 *     hasData, warnings[]
 *   }
 *
 *   KOMATSU_SECTION.cells(line)       -> array sel (CSV RFC-4180, quote-safe)
 *   KOMATSU_SECTION.num(v)            -> Number|null
 *   KOMATSU_SECTION.sectionOf(line)   -> nama bagian atau null
 *   KOMATSU_SECTION.iterate(text, cb) -> iterator hemat memori
 *
 * Modul ini TIDAK menafsirkan isi (tidak tahu arti tipe '60' dst.) — hanya
 * memecah struktur. Penafsiran tetap pada modul masing-masing. Prinsip:
 * lapisan struktur dipisah dari lapisan makna.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Utilitas dasar
   * --------------------------------------------------------------------- */

  /** Pecah satu baris CSV (quote-safe, dukung `""`). */
  function cells(line) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.splitLine === 'function') return cu.splitLine(line);
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** Angka atau null (mendukung sentinel "-", "---", kosong). */
  function num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---' || s === 'N/A') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** Nama bagian `[xxx]` -> "xxx" (huruf kecil) atau null. */
  function sectionOf(line) {
    var m = /^\s*\[(.+?)\]\s*$/.exec(String(line == null ? '' : line));
    return m ? m[1].toLowerCase() : null;
  }

  /** Baris definisi kolom/sumbu (bukan data). */
  function isDefinitionRow(line) {
    return /^\s*(Axis|Column)\s+(Item|Scale|Type|Rate)\s*(,|$)/i.test(String(line == null ? '' : line)) ||
      /^\s*(Status Of Item|View Item\d*)\s*(,|$)/i.test(String(line == null ? '' : line));
  }

  /** Pecah `epoch|tz|dst`. */
  function parseEpochField(v) {
    var out = { epoch: null, tz: null, dst: null };
    if (v === null || v === undefined) return out;
    var parts = String(v).split('|');
    var e = num(parts[0]);
    if (e === null || e <= 0) return out;
    out.epoch = e;
    out.tz = num(parts[1]);
    out.dst = num(parts[2]);
    return out;
  }

  /* -----------------------------------------------------------------------
   * 2. Normalisasi baris
   * --------------------------------------------------------------------- */

  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  /* -----------------------------------------------------------------------
   * 3. Pembaca utama
   * --------------------------------------------------------------------- */

  /**
   * Baca struktur berkas VHMS ber-blok.
   *
   * @param {string} text
   * @param {object} [opts]
   *   - dataTag : nama penanda bagian data (default 'data'). Beberapa ekspor
   *               memakai 'Data'. Perbandingan tanpa peka huruf.
   * @returns {object} lihat doc modul.
   */
  function read(text, opts) {
    opts = opts || {};
    var dataTag = String(opts.dataTag || 'data').toLowerCase();
    var lines = splitLines(text);

    var out = {
      lines: lines,
      headerLines: [],
      dataLines: [],
      dataStartIndex: -1,
      meta: {},
      dataType: { type: '', title: '' },
      samplingTime: '',
      trigger: { smr: null, code: '', message: '' },
      axisItem: [], axisScale: [], axisRate: [],
      columnItem: [], columnScale: [], columnRate: [],
      items: [], scales: [], rates: [],
      hasData: false,
      warnings: []
    };

    // --- 1) Temukan indeks [Data] ---
    var dataStart = -1;
    for (var i = 0; i < lines.length; i++) {
      var sec = sectionOf(lines[i]);
      if (sec === dataTag) { dataStart = i; break; }
    }
    out.dataStartIndex = dataStart;
    if (dataStart === -1) {
      out.warnings.push('Bagian [' + (opts.dataTag || 'Data') + '] tidak ditemukan.');
      return out;
    }
    out.hasData = true;

    out.headerLines = lines.slice(0, dataStart);
    out.dataLines = lines.slice(dataStart + 1)
      .filter(function (l) { return l !== undefined && l.trim() !== ''; });

    // --- 2) Baca blok header ---
    // `meta` dikumpulkan dari SEMUA blok header (key = kolom 0).
    // Baris definisi sumbu/kolom diperlakukan khusus (bukan meta biasa).
    for (var h = 0; h < out.headerLines.length; h++) {
      var line = out.headerLines[h];
      if (line === undefined || line.trim() === '') continue;
      if (sectionOf(line) !== null) continue;   // judul bagian
      var c = cells(line);
      var key = String(c[0] || '').trim();
      if (!key) continue;

      if (/^data type\s*&\s*title$/i.test(key)) {
        out.dataType.type = String(c[1] || '').trim();
        out.dataType.title = String(c[2] || '').trim();
        continue;
      }
      if (/^sampling time$/i.test(key)) {
        out.samplingTime = String(c[1] || '').trim();
        continue;
      }
      if (/^smr\s*&\s*trigger code\s*&\s*trigger message$/i.test(key)) {
        out.trigger.smr = num(c[1]);
        out.trigger.code = String(c[2] || '').trim();
        out.trigger.message = String(c[3] || '').trim();
        continue;
      }
      if (/^axis item$/i.test(key)) { out.axisItem = c.slice(1).map(trim); continue; }
      if (/^axis scale$/i.test(key)) { out.axisScale = c.slice(1).map(trim); continue; }
      if (/^axis rate$/i.test(key)) { out.axisRate = c.slice(1).map(num); continue; }
      if (/^column item$/i.test(key)) { out.columnItem = c.slice(1).map(trim); continue; }
      if (/^column scale$/i.test(key)) { out.columnScale = c.slice(1).map(trim); continue; }
      if (/^column rate$/i.test(key)) { out.columnRate = c.slice(1).map(num); continue; }
      if (isDefinitionRow(line)) continue;

      // Meta biasa.
      var val = c.length > 2
        ? c.slice(1).filter(function (x) { return x !== ''; }).join(', ')
        : String(c[1] || '').trim();
      if (!(key in out.meta)) out.meta[key] = val;
    }

    // --- 3) Sokong definisi sumbu/kolom yang muncul DI DALAM [Data] ---
    //    (sebagian ekspor menaruhnya setelah penanda [Data]).
    for (var d = 0; d < out.dataLines.length; d++) {
      var dl = out.dataLines[d];
      if (!isDefinitionRow(dl)) continue;
      var dc = cells(dl);
      var dk = String(dc[0] || '').trim();
      var body = dc.slice(1).map(trim);
      if (/^axis item$/i.test(dk)) out.axisItem = body;
      else if (/^axis scale$/i.test(dk)) out.axisScale = body;
      else if (/^axis rate$/i.test(dk)) out.axisRate = dc.slice(1).map(num);
      else if (/^column item$/i.test(dk)) out.columnItem = body;
      else if (/^column scale$/i.test(dk)) out.columnScale = body;
      else if (/^column rate$/i.test(dk)) out.columnRate = dc.slice(1).map(num);
    }

    // --- 4) Normalisasi: `items`/`scales`/`rates` = yang tersedia ---
    out.items = (out.axisItem.length ? out.axisItem : out.columnItem);
    out.scales = (out.axisScale.length ? out.axisScale : out.columnScale);
    out.rates = (out.axisRate.length ? out.axisRate : out.columnRate);

    return out;
  }

  function trim(s) { return String(s == null ? '' : s).trim(); }

  /* -----------------------------------------------------------------------
   * 4. Iterator hemat memori
   * --------------------------------------------------------------------- */

  /**
   * Iterasi baris DATA (setelah [Data]) satu per satu tanpa menyimpan array.
   * @param {string}   text
   * @param {function} cb   cb(cellsArray, lineIndex) — kembalikan false untuk stop
   * @param {object}   [opts]
   * @returns {number} jumlah baris data yang dikunjungi
   */
  function iterate(text, cb, opts) {
    var dataTag = String((opts && opts.dataTag) || 'data').toLowerCase();
    var lines = splitLines(text);
    var inData = false;
    var n = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var sec = sectionOf(line);
      if (sec !== null) { inData = (sec === dataTag); continue; }
      if (!inData) continue;
      if (line.trim() === '') continue;
      if (isDefinitionRow(line)) continue;
      n++;
      if (cb(cells(line), i) === false) break;
    }
    return n;
  }

  /* -----------------------------------------------------------------------
   * 5. Offset baris data
   * --------------------------------------------------------------------- */

  /**
   * Tentukan offset kolom data. Baris data VHMS umumnya diawali koma
   * (kolom 0 kosong) sehingga nilai pertama ada di indeks 1. Sebagian berkas
   * (matriks load map / clutch) menaruh LABEL di kolom 0 -> offset 0.
   *
   * @param {array} cellsArr hasil `cells()`
   * @param {object} [opts]
   *   - expect 'number' (default) | 'label' | 'any'
   * @returns {number} 0 atau 1
   */
  function dataOffset(cellsArr, opts) {
    opts = opts || {};
    var expect = opts.expect || 'number';
    var first = String(cellsArr[0] === undefined || cellsArr[0] === null ? '' : cellsArr[0]).trim();
    if (expect === 'label') return (first === '') ? 1 : 0;
    // 'number': kolom 0 kosong -> angka ada di indeks 1.
    if (first === '') return 1;
    // Kolom 0 terisi: bisa jadi angka (offset 0) atau label (offset 0 juga,
    // karena label tetap di kolom 0 dan angka mulai kolom 1).
    return 0;
  }

  /* ----------------------------------------------------------------------- */
  global.KOMATSU_SECTION = {
    cells: cells,
    num: num,
    trim: trim,
    sectionOf: sectionOf,
    isDefinitionRow: isDefinitionRow,
    parseEpochField: parseEpochField,
    splitLines: splitLines,
    read: read,
    iterate: iterate,
    dataOffset: dataOffset
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.KOMATSU_SECTION;
  }
})(typeof window !== 'undefined' ? window : globalThis);

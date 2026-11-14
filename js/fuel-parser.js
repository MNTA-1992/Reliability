/* =========================================================================
 * fuel-parser.js
 * -------------------------------------------------------------------------
 * [FUEL 2026-10-28] Pembaca berkas Komatsu untuk modul **Fuel Trending
 * Analysis** — modul MANDIRI (standalone), lihat
 * `docs/DEV_FUEL_TRENDING_2026-10-28.md`.
 *
 * MURNI: tanpa DOM, tanpa localStorage, tanpa state global. Jalan di Node
 * maupun browser sehingga bisa diuji tanpa browser.
 *
 * Ketergantungan yang DIIZINKAN (satu arah, read-only):
 *   CSV_UTIL  — utilitas murni (splitLine, toNumStrict)
 * Yang DILARANG (dijaga uji FUEL-ISO-4):
 *   VHMS_FLEET, SOS_STORE, PORTFOLIO_STORE, VHMS_ANALYTICS, VHMS_RANKING
 * ========================================================================= */

(function (global) {
  'use strict';

  var CSU = global.CSV_UTIL || null;

  /* -----------------------------------------------------------------------
   * Fallback bila CSV_UTIL tidak dimuat. HANYA untuk kenyamanan pemakaian
   * mandiri (mis. probe CLI); perilaku WAJIB identik dengan CSV_UTIL.
   * --------------------------------------------------------------------- */
  function splitLine(line, delim) {
    if (CSU && CSU.splitLine) return CSU.splitLine(line, delim);
    return String(line).split(delim || ',');
  }
  function toNumStrict(v) {
    if (CSU && CSU.toNumStrict) return CSU.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /* -----------------------------------------------------------------------
   * Baris yang sudah dipecah. `splitRecordLine` MEMPERTAHANKAN kolom pertama
   * yang kosong, berbeda dengan `splitLine` biasa.
   *
   * Berkas Komatsu menulis baris data diawali koma:
   *   ,220,1740522290|28800|0,2262,...
   * Field pertama KOSONG adalah bagian dari format (placeholder kolom
   * "Axis Item" ke-0). Kalau dibuang, SEMUA kolom bergeser satu dan
   * `SMR` dibaca sebagai `Calendar` — bug senyap yang sangat mahal.
   * --------------------------------------------------------------------- */
  function splitRecordLine(line) {
    return splitLine(line, ',');
  }

  /* -----------------------------------------------------------------------
   * detachKalender — "1740522290|28800|0" -> { epoch, tz, flag }
   *
   * Format: <epoch UTC>|<offset detik>|<flag>. Tanpa offset, tanggal lokal
   * bergeser 8 jam (UTC+8 di site ini) dan jendela jatuh di hari yang salah.
   * --------------------------------------------------------------------- */
  function detachKalender(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    var parts = s.split('|');
    var epoch = Number(parts[0]);
    if (!isFinite(epoch) || epoch <= 0) return null;
    var tz = parts.length > 1 ? Number(parts[1]) : 0;
    if (!isFinite(tz)) tz = 0;
    var flag = parts.length > 2 ? parts[2] : '';
    return { epoch: epoch, tz: tz, flag: flag, raw: s };
  }

  /* -----------------------------------------------------------------------
   * parse(text) — baca satu berkas Komatsu apa adanya.
   *
   * @param {string} text isi berkas
   * @returns {{
   *   meta: Object,             // kunci -> nilai dari semua blok header
   *   items: string[],          // nama kolom (Axis Item)
   *   scales: string[],         // satuan (Axis Scale)
   *   rates: number[],          // Axis Rate, pembagi ke nilai asli
   *   types: string[],          // Axis Type
   *   dataType: string,         // 'Data Type & Title', mis. '40' / 'A2'
   *   dataTitle: string,
   *   rows: (number|null)[][],  // nilai SUDAH dibagi Axis Rate
   *   calendars: ({epoch,tz,flag,raw}|null)[],  // per baris, jika ada
   *   rawRows: string[][],      // field mentah, urutan SAMA dengan rows
   *   warning: string[]         // hal yang perlu dilihat operator
   * }}
   *
   * CATATAN PENTING: pemanggil WAJIB memakai `colIndex(items, name)` untuk
   * mencari kolom, JANGAN indeks numerik hardcode. Jumlah & urutan kolom
   * BERGANTUNG MODEL (HD785 trend punya 26 kolom; model lain berbeda).
   * --------------------------------------------------------------------- */
  function parse(text) {
    // TIDAK ada logika pembacaan di sini — semua di `readKvTable`.
    // Dua implementasi untuk satu format akan menyimpang diam-diam.
    var t = readKvTable(text, { scaled: true, keepRates: true });
    return {
      meta: t.meta, items: t.items, scales: t.scales, rates: t.rates, types: t.types,
      dataType: t.dataType, dataTitle: t.dataTitle,
      rows: t.rows, calendars: t.calendars, rawRows: t.rawRows, warning: t.warning
    };
  }

  /* =======================================================================
   * [SHARED 2026-10-28] PEMBACA TABEL GENERIK — dipakai BERSAMA oleh
   * `js/vhms-parser.js` dan modul Fuel, sehingga SATU KALI UPLOAD cukup
   * SATU KALI PARSE (lihat docs/DEV_FUEL_TRENDING_2026-10-28.md §2b).
   *
   * `parse()` di atas sengaja TETAP ada untuk pemakaian standalone
   * (probe CLI, uji) — ia sekarang hanyalah pembungkus tipis di atas
   * fungsi ini, jadi TIDAK ADA dua implementasi pembacaan tabel.
   *
   * `splitRecordLine` menerima parameter `split` agar pemanggil memakai
   * pemecah CSV-nya sendiri (CSV_UTIL.splitLine yang RFC 4180-compliant).
   * Tanpa itu, `"OIL,SAE 10W"` di dalam kutip akan terpecah salah.
   * ======================================================================= */

  /** "Kunci,nilai,..." -> { key, f: field mentah }. */
  function splitKeyLine(line, split) {
    var f = (split || splitLine)(line, ',');
    return { key: String(f[0] || '').trim(), f: f };
  }

  function ratesFromField(raw) {
    return raw.slice(1).map(function (s) {
      var n = Number(String(s).trim());
      return (isFinite(n) && n !== 0) ? n : 1;
    });
  }

  /** Bangun baris data (nilai SUDAH dibagi Axis Rate). */
  function buildDataRows(out, lines, from, opts) {
    var split = (opts && opts.split) || splitLine;
    var calIdx = -1;
    for (var c = 0; c < out.items.length; c++) {
      if (/^Calendar$/i.test(out.items[c])) { calIdx = c; break; }
    }
    for (var j = from; j < lines.length; j++) {
      var L = lines[j];
      if (!L || L.charAt(0) !== ',') continue;   // baris data SELALU diawali koma
      var raw = split(L, ',').slice(1);          // buang field pertama yang kosong
      if (raw.length < out.items.length) {
        out.warning.push('Baris ' + (j + 1) + ' hanya ' + raw.length + ' kolom, dilewati.');
        continue;
      }
      var scaled = [];
      for (var k = 0; k < out.items.length; k++) {
        var n = toNumStrict(raw[k]);
        if (n === null) { scaled.push(null); continue; }
        var r = out.rates[k];
        scaled.push((r && r !== 1) ? n / r : n);
      }
      out.rows.push(scaled);
      out.rawRows.push(raw);
      out.calendars.push(calIdx >= 0 ? detachKalender(raw[calIdx]) : null);
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * readKvTable(text, opts) — SATU-SATUNYA pembaca blok Komatsu "Kunci, nilai".
   *
   * Mengembalikan hasil SENGAJA 'mentah + skala' (belum dipetakan ke nama
   * parameter): modul Fuel mencari kolom lewat `PARSER.colIndex`, sedangkan
   * VHMS memetakannya ke PARAMS. Keduanya memakai isi yang sama.
   *
   * opts:
   *   split      function pemecah CSV (default splitLine)
   *   keepRates  false -> jangan simpan `rates`/`scales`/`types`
   *              (VHMS: hemat memori; payload ratusan ribu baris)
   *   scaled     default false = nilai MENTAH, skala diberikan terpisah.
   *              Fuel memakai true (÷Axis Rate) karena kolomnya sedikit.
   *
   * @returns {{ ok, error, meta, items, scales, rates, types, dataType,
   *             dataTitle, rows, rawRows, calendars, warning, scalesMap }}
   *   `scalesMap` = { "<nama kolom>": <pembagi> } — selalu ada, juga saat
   *   keepRates=false, supaya pemanggil tak perlu menghitung ulang.
   * --------------------------------------------------------------------- */
  function readKvTable(text, opts) {
    opts = opts || {};
    var split = opts.split || splitLine;
    var keepRates = opts.keepRates !== false;
    var wantScaled = opts.scaled === true;

    var out = {
      ok: false, error: null,
      meta: {}, items: [], scales: [], rates: [], types: [],
      dataType: '', dataTitle: '',
      rows: [], rawRows: [], calendars: [], warning: [], scalesMap: {}
    };
    if (text == null) { out.error = 'Teks kosong.'; return out; }

    var lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    var dataAt = -1;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === '[') {
        var close = line.indexOf(']');
        var section = close > 0 ? line.slice(1, close).trim() : '';
        if (/^Data$/i.test(section)) { dataAt = i + 1; break; }
        continue;
      }
      var kv = splitKeyLine(line, split);
      var key = kv.key, f = kv.f;
      if (!key) continue;

      if (/^Axis Item$/i.test(key)) {
        out.items = f.slice(1).map(function (s) { return String(s).trim(); });
        continue;
      }
      if (/^(Axis Scale|Column Scale)$/i.test(key)) {
        out.scales = f.slice(1).map(function (s) { return String(s).trim(); });
        if (!keepRates) { /* tetap simpan satuan: murah, dipakai diagnosa */ }
        continue;
      }
      if (/^Axis Rate$/i.test(key)) {
        out.rates = ratesFromField(f);
        continue;
      }
      if (/^Axis Type$/i.test(key)) {
        if (keepRates) out.types = f.slice(1).map(function (s) { return String(s).trim(); });
        continue;
      }
      if (/^Data Type\s*&\s*Title$/i.test(key)) {
        out.dataType = String(f[1] || '').trim();
        out.dataTitle = String(f[2] || '').trim();
      }
      // Semua baris berkunci masuk meta, dengan bentuk yang SAMA seperti
      // `vhms-parser.parseKeyValueBlocks` (dipakai seluruh modul RBM):
      //   "Kunci,a,b" -> "a, b"   (field kosong dibuang, digabung koma-spasi)
      //   "Kunci,"    -> ""       (bukan '')
      // Field pertama yang kosong TIDAK hilang karena masih ada.
      //
      // ⚠ Bentuk ini dikunci kesepakatan. Bila berubah menjadi array,
      //   `meta['Program Ver.'].split(...)` di vhms-parser MELEMPAR dan
      //   seluruh 13 uji RBM merah (pernah terjadi 2026-10-28).
      var toks = f.slice(1).filter(function (x) { return String(x).trim() !== ''; });
      var clean = toks.map(function (x) { return String(x).trim(); });
      out.meta[key] = clean.join(', ');
    }

    if (dataAt < 0) { out.error = 'Bagian [Data] tidak ditemukan.'; out.warning.push(out.error); return out; }
    if (!out.items.length) {
      out.error = 'Baris "Axis Item" tidak ditemukan — kolom tidak terdefinisi.';
      out.warning.push(out.error);
      return out;
    }
    if (!out.rates.length) {
      out.warning.push('Baris "Axis Rate" tidak ditemukan — nilai dibaca tanpa pembagian.');
      out.rates = out.items.map(function () { return 1; });
    }
    if (out.rates.length !== out.items.length) {
      out.warning.push('Jumlah Axis Rate (' + out.rates.length + ') != jumlah kolom (' +
        out.items.length + ') — sisa kolom memakai rate 1.');
      while (out.rates.length < out.items.length) out.rates.push(1);
    }
    // scalesMap selalu tersedia (dipakai VHMS saat tidak menyimpan `rates`).
    for (var m = 0; m < out.items.length; m++) out.scalesMap[out.items[m]] = out.rates[m];

    buildDataRows(out, lines, dataAt, { split: split });
    if (wantScaled) { /* rows sudah berskala */ }

    if (!out.rows.length) { out.error = out.error || 'Tidak ada baris data valid.'; out.warning.push(out.error); }

    if (!keepRates) {
      // VHMS tidak memakai rates/types per baris; simpan ringkas.
      out.rates = [];
      out.types = [];
    }
    out.ok = !out.error;
    return out;
  }

  /* -----------------------------------------------------------------------
   * colIndex(items, name) — indeks kolom, atau -1.
   * Pencocokan mengabaikan beda huruf besar/kecil & spasi berlebih.
   * --------------------------------------------------------------------- */
  function colIndex(items, name) {
    var want = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
    for (var i = 0; i < (items || []).length; i++) {
      var cur = String(items[i] || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (cur === want) return i;
    }
    return -1;
  }

  /** Ambil kolom sebagai array nilai (null bila kolom tak ada). */
  function column(parsed, name) {
    var idx = colIndex(parsed && parsed.items, name);
    if (idx < 0) return null;
    return (parsed.rows || []).map(function (r) { return r[idx]; });
  }

  /** Petakan tipe berkas ke peran modul fuel. */
  function roleOf(dataType) {
    var t = String(dataType || '').trim().toUpperCase();
    if (t === '40' || t === '') return 'trend';     // trend0.CSV — Fuel Rate + SMR
    // [FIX 2026-10-28] '95' = "Pay Load Meter Cycle Data" PLM generasi LAMA
    // (lihat sample-data/full/pldcyc0.CSV). Hanya 'A2' (PLM23) yang dikenal,
    // sehingga berkas pldcyc lama DIBUANG diam-diam sebagai 'other' dan unit
    // tampak tidak punya siklus sama sekali. Kolomnya IDENTIK dengan A2.
    if (t === 'A2' || t === '95') return 'cycle';   // pldcyc — per siklus
    // [DAILY 2026-10-28] A0 = Pay Load Meter AGREGAT. Sebelumnya dibuang
    // ("akumulasi tanpa distribusi"), tapi untuk korelasi HARIAN justru
    // inilah satu-satunya sumber payload per tanggal — pldcyc (A2) memberi
    // per siklus yang tidak punya kolom tanggal kalender sendiri.
    // SATU baris A0 = SATU interval ~20-24 jam (terverifikasi pada unit pilot:
    // 220 baris = 220 tanggal unik). Jadi "harian" di sini memang dikenal
    // tim: interval jendela harian, bukan hari kalender penuh.
    if (t === 'A0') return 'daily';
    return 'other';
  }

  /* -----------------------------------------------------------------------
   * parseDailyPayload(t) — berkas A0 (payloadn) -> deret HARIAN.
   *
   * Kolom yang dipakai (nama lengkap, jangan disingkat):
   *   From Calendar, To Calendar  -> interval + tanggal LOKAL
   *   Payload                     -> ton akumulasi interval
   *   Loaded Drv.Dist.            -> km bermuatan
   *   Cycle                       -> jumlah siklus
   *
   * Kolom kalender TIDAK bernama persis "Calendar", jadi `readKvTable`
   * mengembalikan `calendars[k] = null`. Kita membaca `rawRows` sendiri
   * dengan `detachKalender` — tetap SATU pembaca format ("epoch|tz|flag").
   *
   * @param {Object} t hasil parse()/readKvTable()
   * @returns {{ ok, days:[{day,t,hours,payload,loadedKm,cycles,rated}], reason }}
   * --------------------------------------------------------------------- */
  var DAILY_COLS = [
    ['payload', 'Payload'],
    ['loadedKm', 'Loaded Drv.Dist.'],
    ['cycles', 'Cycle'],
    ['rated', 'Rated Load']
  ];

  function parseDailyPayload(t) {
    var out = { ok: false, days: [], reason: '' };
    // Terima TEKS atau tabel hasil parse. Menerima keduanya menghindari
    // pemanggil menebak urutan (dan menghindari dua implementasi baca).
    if (typeof t === 'string') {
      t = readKvTable(t, { scaled: true, keepRates: true });
    }
    if (!t || !t.items || !t.items.length) { out.reason = 'tabel kosong'; return out; }
    var role = roleOf(t.dataType);
    if (role !== 'daily') {
      out.reason = 'bukan Pay Load Meter agregat (tipe ' + (t.dataType || '?') + ')';
      return out;
    }
    var iFrom = colIndex(t.items, 'From Calendar');
    var iTo = colIndex(t.items, 'To Calendar');
    if (iFrom < 0) { out.reason = 'kolom "From Calendar" tidak ada'; return out; }
    var cols = {}, missing = [];
    DAILY_COLS.forEach(function (m) {
      var idx = colIndex(t.items, m[1]);
      if (idx < 0) missing.push(m[1]); else cols[m[0]] = idx;
    });
    if (missing.length) { out.reason = 'kolom kurang: ' + missing.join(', '); return out; }

    var byDay = {};
    for (var k = 0; k < (t.rawRows || []).length; k++) {
      var raw = t.rawRows[k] || [];
      var from = detachKalender(raw[iFrom]);
      if (!from) continue;
      var to = iTo >= 0 ? detachKalender(raw[iTo]) : null;
      var r = t.rows[k] || [];
      var day = ymdLocal(from);
      if (!day) continue;
      var rec = {
        day: day,
        t: from.epoch,
        hours: (to && to.epoch > from.epoch) ? (to.epoch - from.epoch) / 3600 : null,
        payload: r[cols.payload],
        loadedKm: r[cols.loadedKm],
        cycles: r[cols.cycles],
        rated: r[cols.rated]
      };
      // Satu tanggal seharusnya satu baris. Bila ada dua (berkas tumpang
      // tindih), GABUNG jumlahnya — membuang salah satunya membuat ton-km
      // hilang senyap.
      var prev = byDay[day];
      if (prev) {
        prev.payload += (rec.payload || 0);
        prev.loadedKm += (rec.loadedKm || 0);
        prev.cycles = (prev.cycles || 0) + (rec.cycles || 0);
        if (rec.hours != null) prev.hours = (prev.hours || 0) + rec.hours;
      } else {
        byDay[day] = rec;
      }
    }
    out.days = Object.keys(byDay).sort().map(function (d) { return byDay[d]; });
    out.ok = out.days.length > 0;
    if (!out.ok) out.reason = 'tidak ada baris harian dengan tanggal valid';
    return out;
  }

  /** Gabungkan payloadn dengan pldcyc; tanggal pldcyc selalu menang. */
  function mergeDailyDays(dailyDays, cycles) {
    var by = {};
    (dailyDays || []).forEach(function (d) {
      if (d && d.day) by[d.day] = Object.assign({}, d);
    });
    var cy = {};
    (cycles || []).forEach(function (c) {
      if (!c || c.t == null || !(Number(c.P) > 0)) return;
      var day = ymdLocal({ epoch: c.t, tz: c.tz || 0 });
      if (!cy[day]) cy[day] = { n: 0, ton: 0 };
      cy[day].n++;
      cy[day].ton += Number(c.P);
    });
    Object.keys(cy).forEach(function (day) {
      var old = by[day] || { day: day, hours: null, loadedKm: null, rated: null };
      // pldcyc tidak memiliki Loaded Drv.Dist.; pertahankan nilai payloadn
      // itu, tetapi payload/cycle wajib berasal dari pldcyc pada tanggal sama.
      by[day] = Object.assign({}, old, {
        day: day, payload: cy[day].ton, cycles: cy[day].n, source: 'pldcyc'
      });
    });
    return Object.keys(by).sort().map(function (d) { return by[d]; });
  }

  /* -----------------------------------------------------------------------
   * cyclesFromTable(t, opts) — tabel payload (tipe A2) -> array siklus.
   *
   * Dipakai DUA pemanggil:
   *   - vhms-app.js  (saat upload; hasil masuk `FUEL_INGEST`, BUKAN fleet)
   *   - fuel-app.js  (saat halaman Fuel dibuka)
   * Keduanya memakai fungsi ini supaya aturannya SATU.
   *
   * @param {Object} t hasil readKvTable/parse
   * @param {{tz?:number}} opts
   * @returns {{ ok, cycles, missing, model, serial, date }}
   * --------------------------------------------------------------------- */
  var CYCLE_COLS = [
    ['P', 'Payload'], ['tE', 'Empty Drv.Time'], ['dE', 'Empty Drv.Dist.'],
    ['sE', 'Empty Stop Time'], ['sL', 'LoadingStopTime'],
    ['tL', 'Loaded Drv.Time'], ['dL', 'Loaded Drv.Dist.'],
    ['sLd', 'Loaded Stop Time'], ['over', 'Over Load']
  ];

  function cyclesFromTable(t, opts) {
    opts = opts || {};
    var out = { ok: false, cycles: [], missing: [], model: '', serial: '', date: null };
    if (!t || !t.items || !t.items.length) { out.missing.push('(tabel kosong)'); return out; }
    out.model = String(t.meta['Machine Model'] || '');
    out.serial = String(t.meta['Machine Serial No.'] || '');

    var cols = {}, missing = [];
    CYCLE_COLS.forEach(function (m) {
      var idx = colIndex(t.items, m[1]);
      if (idx < 0) missing.push(m[1]);
      else cols[m[0]] = idx;
    });
    if (missing.length) { out.missing = missing; return out; }

    for (var k = 0; k < t.rows.length; k++) {
      var cal = t.calendars[k];
      if (!cal) continue;
      var c = { t: cal.epoch };
      CYCLE_COLS.forEach(function (m) { c[m[0]] = t.rows[k][cols[m[0]]]; });
      if (opts.tz != null) c.tz = cal.tz;
      out.cycles.push(c);
      if (out.date == null && cal.tz != null) out.date = ymdLocal(cal);
    }
    out.ok = out.cycles.length > 0;
    return out;
  }

  /** Tanggal LOKAL dari objek Calendar. */
  function ymdLocal(cal) {
    if (!cal) return null;
    var ms = (Number(cal.epoch) + (Number(cal.tz) || 0)) * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* -----------------------------------------------------------------------
   * trendSeriesFromTable(t) — tabel trend0 -> deret ter-normalisasi.
   *
   * [RESET 2026-10-29] Bentuk ini ada SUPAYA dua berkas trend0 (pra-reset &
   * pasca-reset) bisa DIGABUNG tanpa mengandaikan urutan kolom yang sama.
   * Menyambung teks CSV mentah tidak bisa: tiap berkas punya header sendiri
   * (`[Common Header]`, `[Display Information]`, `Axis Item`) dan `Program
   * Ver.` berbeda bisa berarti urutan `Axis Item` berbeda.
   *
   * Baris tanpa Calendar DIBUANG: tanpa epoch, baris itu tidak bisa
   * ditempatkan pada sumbu waktu dan tidak bisa dibedakan dari baris berkas
   * lain setelah reset (SMR-nya berulang dari nol).
   *
   * MURNI. @returns {Array<{smr:number, fuelRate:number|null, epoch:number, tz:number}>}
   * --------------------------------------------------------------------- */
  function trendSeriesFromTable(t) {
    var out = [];
    if (!t || !t.items || !t.items.length) return out;
    var iS = colIndex(t.items, 'SMR');
    var iF = colIndex(t.items, 'Fuel Rate');
    if (iS < 0) return out;
    var rows = t.rows || [], cals = t.calendars || [];
    for (var k = 0; k < rows.length; k++) {
      var cal = cals[k];
      if (!cal || cal.epoch == null) continue;
      var smr = rows[k][iS];
      if (smr == null || !isFinite(smr)) continue;
      out.push({
        smr: smr,
        fuelRate: (iF >= 0 ? rows[k][iF] : null),
        epoch: cal.epoch,
        tz: (cal.tz == null ? 0 : cal.tz)
      });
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * mergeTrendSeries(prev, next) — GABUNG dua deret trend0, dedupe EPOCH.
   *
   * [RESET 2026-10-29] Unit yang VHMS-nya di-reset butuh DUA berkas trend0
   * (pra-reset + pasca-reset) agar jumlah jendela cukup untuk baseline
   * (`LIMITS.minWindows` = 20). Menimpa = berkas pertama hilang tanpa pesan.
   *
   * Kunci dedupe = EPOCH, BUKAN SMR. Setelah reset SMR mulai lagi dari nol,
   * sehingga dua titik waktu BERBEDA bisa punya SMR identik; mengunci per SMR
   * membuang salah satunya. Epoch tidak pernah ter-reset.
   *
   * Hasil diurut menaik menurut epoch (sumbu waktu). Pemanggil berikutnya
   * (`buildWindows`) mengandalkan urutan ini.
   *
   * MURNI. @returns {Array} deret gabungan (array baru; masukan tak diubah)
   * --------------------------------------------------------------------- */
  function mergeTrendSeries(prev, next) {
    var seen = Object.create(null), out = [];
    (prev || []).concat(next || []).forEach(function (p) {
      if (!p || p.epoch == null) return;
      var k = String(p.epoch);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(p);
    });
    out.sort(function (a, b) { return a.epoch - b.epoch; });
    return out;
  }

  var FUEL_PARSER = {
    parse: parse,
    // [SHARED 2026-10-28] pembaca tabel bersama (juga dipakai vhms-parser)
    readKvTable: readKvTable,
    cyclesFromTable: cyclesFromTable,
    // [RESET 2026-10-29] Deret trend0 ter-normalisasi + penggabungnya.
    // Ekspor `mergeTrendSeries` agar uji bisa mengunci perilaku dedupe
    // (kunci = epoch), bukan menyalin logikanya.
    trendSeriesFromTable: trendSeriesFromTable,
    mergeTrendSeries: mergeTrendSeries,
    parseDailyPayload: parseDailyPayload,
    mergeDailyDays: mergeDailyDays,
    ymdLocal: ymdLocal,
    colIndex: colIndex,
    column: column,
    roleOf: roleOf,
    detachKalender: detachKalender,
    // [WILAYAH UJI] diekspor agar uji bisa mengunci perilaku, bukan menyalinnya.
    _splitRecordLine: splitRecordLine
  };

  /* =======================================================================
   * FUEL_INGEST — jembatan SATU ARAH dari gerbang upload RBM ke modul Fuel.
   * -----------------------------------------------------------------------
   * [SHARED 2026-10-28] Satu kali upload -> satu kali parse -> dipakai RBM
   * DAN Fuel. `vhms-app.js` memanggil `FUEL_INGEST.accept(text, name)`;
   * Fuel hanya MENYIMPAN teks mentahnya, TIDAK menganalisis.
   *
   * KENAPA TANPA IMPORT KE MODUL RBM:
   *   arah ketergantungan harus satu arah (vhms-app -> fuel), kalau tidak
   *   modul Fuel secara diam-diam ikut berubah setiap kali RBM berubah.
   *   `FUEL_INGEST` sengaja TIDAK menyebut VHMS_* / SOS_* / PORTFOLIO_*
   *   sama sekali; uji FUEL-ISO-4 mengunci itu.
   *
   * KENAPA TIDAK MENYIMPAN HASIL ANALISIS:
   *   `Me` (berat kosong) bisa diubah pengguna di Pengaturan SESUDAH upload.
   *   Analisis dihitung saat halaman Fuel dibuka, dari teks mentah, sehingga
   *   perubahan `Me`/ambang langsung terpakai. Menyimpan hasil = data basi
   *   yang tak terlihat basi.
   *
   * MEMORI: teks mentah ditahan di RAM saja (tidak dipersist) dan dibatasi
   * `MAX_TEXT` per slot. Berkas payload HD785 ~1,5 MB; dua slot aman, dan
   * upload IDENTIK TIDAK MEMBUANG WAKTU PARSE ULANG.
   * ======================================================================= */
    var MAX_TEXT = 24 * 1024 * 1024;   // 24 MB per berkas — jauh di atas berkas nyata

  /* [MULTI 2026-10-28] Ingest menyimpan BANYAK unit, dikunci Serial No.
   *
   * SEBELUMNYA satu slot tunggal (trend/cycle/daily). Artinya upload folder
   * berisi 5 unit membuat unit ke-2..5 MENIMPA unit pertama secara SENYAP —
   * operator melihat "berhasil" padahal hanya satu unit yang dianalisis.
   * Data hilang tanpa pesan adalah kelas bug termahal di proyek ini.
   *
   * Kunci identitas dibuat berlapis karena berkas Komatsu tidak selalu
   * membawa Serial No. di setiap jenis berkas:
   *   1. Machine Serial No.                    (paling kuat)
   *   2. Machine Model + "folder" nama berkas  (prefix sebelum '_')
   *   3. Nama berkas itu sendiri               (paling lemah)
   * Kunci tanpa SN ditandai `weakKey` agar UI bisa memperingatkan, bukan
   * diam-diam menggabungkan dua unit berbeda.
   */
  var _ingest = {
    units: {},     // key -> { key, serial, model, weakKey, trend, cycle, daily, at, names }
    order: [],     // urutan masuk, agar tampilan stabil
    ignored: []    // { name, dataType, title, serial }
  };

  /** Kunci identitas unit dari meta + nama berkas. */
  function unitKeyOf(meta, sourceName) {
    meta = meta || {};
    var serial = String(meta['Machine Serial No.'] || '').trim();
    var model = String(meta['Machine Model'] || '').trim();
    if (serial) return 'S:' + serial;
    var stem = String(sourceName || '').replace(/\.[^.]+$/, '');
    var folder = stem.split('_')[0] || stem;
    if (model) return 'M:' + model + '|' + folder;
    return 'F:' + stem;
  }

  function unitOf(key, meta, sourceName) {
    var u = _ingest.units[key];
    if (!u) {
      meta = meta || {};
      u = {
        key: key,
        serial: String(meta['Machine Serial No.'] || '').trim(),
        model: String(meta['Machine Model'] || '').trim(),
        weakKey: key.charAt(0) !== 'S:',
        trend: null, cycle: null, daily: null, at: 0,
        names: []
      };
      _ingest.units[key] = u;
      _ingest.order.push(key);
    }
    if (!u.serial && meta && meta['Machine Serial No.']) {
      u.serial = String(meta['Machine Serial No.']).trim();
    }
    if (!u.model && meta && meta['Machine Model']) {
      u.model = String(meta['Machine Model']).trim();
    }
    if (sourceName) u.names.push(sourceName);
    u.at = Date.now();
    return u;
  }

  /**
   * accept(text, sourceName) — dipanggil gerbang upload RBM untuk SETIAP berkas.
   *
   * [MULTI] Setiap berkas masuk ke unit yang sesuai SN-nya, jadi SATU batch
   * boleh berisi banyak unit sekaligus.
   *
   * @returns {'trend'|'cycle'|'daily'|'ignored'} peran yang diambil
   */
  function accept(text, sourceName) {
    var role = null;
    try {
      var head = String(text || '').slice(0, 4000);
      var m = /^\s*Data Type\s*&\s*Title\s*,(.*)$/im.exec(head);
      var type = m ? String(m[1].split(',')[0] || '').trim() : '';
      role = FUEL_PARSER.roleOf(type);
      var serial = (/^\s*Machine Serial No\.\s*,(.*)$/im.exec(head) || [])[1];
      serial = String(serial || '').split(',')[0].trim();
      if (role === 'other') {
        _ingest.ignored.push({ name: sourceName || '', dataType: type, title: '', serial: serial });
        return 'ignored';
      }
      var body = String(text || '');
      if (body.length > MAX_TEXT) {
        _ingest.ignored.push({ name: sourceName || '', dataType: type, title: 'terlalu besar', serial: serial });
        return 'ignored';
      }

      if (role === 'trend') {
        var t = readKvTable(body, { scaled: true, keepRates: true });
        var uT = unitOf(unitKeyOf(t.meta, sourceName), t.meta, sourceName);

        // [RESET 2026-10-29] GABUNG, jangan timpa. Unit yang VHMS-nya di-reset
        // butuh DUA berkas trend0 (pra-reset + pasca-reset) agar jumlah jendela
        // cukup untuk baseline. Menimpa = berkas pertama hilang tanpa pesan.
        // Dedupe berdasarkan EPOCH, bukan SMR: setelah reset SMR berulang dari
        // nol sehingga dua titik waktu berbeda bisa punya SMR sama.
        //
        // Pola ini CERMIN dari blok `role === 'cycle'` di bawah — satu bentuk
        // untuk satu masalah, supaya tidak lahir aturan kedua.
        var ser = trendSeriesFromTable(t);
        var prevT = uT.trend;
        var mergedSer = ser, tNames = [sourceName || ''];
        if (prevT && prevT.series && prevT.series.length) {
          mergedSer = mergeTrendSeries(prevT.series, ser);
          tNames = (prevT.names || [prevT.name]).concat(tNames);
        }

        // `text` TETAP disimpan (berkas TERAKHIR) demi kompatibilitas jalur
        // unit tunggal (`peek()`, `take()`, `FUEL_APP.analyzeTexts()`).
        // Sumber kebenaran yang baru adalah `series`.
        uT.trend = {
          text: body, name: sourceName || '', names: tNames, at: Date.now(),
          model: String(t.meta['Machine Model'] || '') || (prevT && prevT.model) || '',
          serial: String(t.meta['Machine Serial No.'] || '') || (prevT && prevT.serial) || '',
          series: mergedSer,
          // `rows` = jumlah TERPAKAI (setelah dedupe), bukan jumlah baris
          // berkas terakhir. Angka ini yang dibaca pesan status operator.
          rows: mergedSer.length
        };
        return 'trend';
      }

      // A0 (agregat HARIAN) — untuk korelasi harian, bukan jendela 20 jam.
      if (role === 'daily') {
        var dp = readKvTable(body, { scaled: true, keepRates: true });
        if (dp.dataType == null) dp.dataType = type;
        var dd = parseDailyPayload(dp);
        if (!dd.ok) {
          _ingest.ignored.push({ name: sourceName || '', dataType: type, title: dd.reason, serial: serial });
          return 'ignored';
        }
        var uD = unitOf(unitKeyOf(dp.meta, sourceName), dp.meta, sourceName);
        uD.daily = { text: body, name: sourceName || '', at: Date.now(), days: dd.days };
        return 'daily';
      }

      // role === 'cycle'
      var cp = readKvTable(body, { scaled: true, keepRates: true });
      var cy = cyclesFromTable(cp, { tz: true });
      if (!cy.ok) {
        _ingest.ignored.push({
          name: sourceName || '', dataType: type, serial: serial,
          title: 'kolom kurang: ' + cy.missing.join(', ')
        });
        return 'ignored';
      }
      var uC = unitOf(unitKeyOf(cp.meta, sourceName), cp.meta, sourceName);
      // [FIX 2026-10-28] GABUNG, jangan timpa. Satu unit lazim punya DUA
      // berkas pldcyc (PLM lama `pldcyc0` + PLM23 `pldcycn23`) yang memuat
      // rentang tanggal BERBEDA. Menimpa membuat seluruh rentang berkas yang
      // masuk lebih dulu hilang tanpa pesan — persis gejala "data terakhir
      // Juli padahal raw sampai Oktober".
      // Dedupe berdasarkan epoch: berkas yang tumpang tindih tidak boleh
      // menggandakan siklus (tonase & Qty Cycle akan dua kali lipat).
      var prevC = uC.cycle;
      var merged = cy.cycles, names = [sourceName || ''];
      if (prevC && prevC.cycles && prevC.cycles.length) {
        var seen = Object.create(null);
        merged = [];
        prevC.cycles.concat(cy.cycles).forEach(function (c) {
          var k = String(c.t);
          if (seen[k]) return;
          seen[k] = 1;
          merged.push(c);
        });
        merged.sort(function (a, b) { return a.t - b.t; });
        names = (prevC.names || [prevC.name]).concat(names);
      }
      uC.cycle = {
        text: body, name: sourceName || '', names: names, at: Date.now(),
        model: cy.model || (prevC && prevC.model) || '',
        serial: cy.serial || (prevC && prevC.serial) || '',
        cycles: merged, date: cy.date || (prevC && prevC.date) || null
      };
      return 'cycle';
    } catch (e) {
      _ingest.ignored.push({ name: sourceName || '', dataType: '', title: 'gagal: ' + (e && e.message), serial: '' });
      return 'ignored';
    }
  }

  /** Daftar unit ringkas untuk status/UI, urut sesuai masuk. */
  function unitList() {
    return _ingest.order.map(function (k) {
      var u = _ingest.units[k];
      return {
        key: u.key, serial: u.serial, model: u.model, weakKey: u.weakKey,
        hasTrend: !!u.trend, hasCycle: !!u.cycle, hasDaily: !!u.daily,
        // `complete` = syarat analisis JENDELA (trend + pldcyc).
        // `daily` hanya menambah chart korelasi — tidak menggugurkan unit.
        complete: !!(u.trend && u.cycle),
        names: u.names.slice()
      };
    });
  }

  /** true bila ADA unit yang bisa dianalisis (trend + siklus). */
  function has() {
    return _ingest.order.some(function (k) {
      var u = _ingest.units[k];
      return !!(u && u.trend && u.cycle);
    });
  }

  /**
   * count() — jumlah BERKAS yang dipakai (trend + cycle), perilaku LAMA
   * yang sudah dipakai pesan batch di `vhms-app.js`.
   * KEPUTUSAN: bentuk lama DIPERTAHANKAN supaya pemanggil lain tidak berubah
   * diam-diam. Jumlah UNIT tersedia terpisah di `unitCount()`.
   */
  function count() {
    var n = 0;
    _ingest.order.forEach(function (k) {
      var u = _ingest.units[k];
      if (u && u.trend) n++;
      if (u && u.cycle) n++;
    });
    return n;
  }

  /** Jumlah UNIT yang lengkap (trend + siklus) — untuk tabel summary. */
  function unitCount() {
    return _ingest.order.filter(function (k) {
      var u = _ingest.units[k];
      return !!(u && u.trend && u.cycle);
    }).length;
  }

  /**
   * take() — ambil SEMUA unit lalu KOSONGKAN.
   * Analisis memakai salinan sendiri sehingga "Hapus Data Fuel" tidak
   * menghapus data yang diunggah RBM.
   */
  function take() {
    var units = _ingest.order.map(function (k) { return _ingest.units[k]; });
    var last = units.length ? units[units.length - 1] : null;
    var snap = {
      units: units,
      // Kompatibilitas bentuk lama: slot tunggal = unit terakhir.
      trend: last ? last.trend : null,
      cycle: last ? last.cycle : null,
      daily: last ? last.daily : null
    };
    clear();
    return snap;
  }

  /** peek() — baca tanpa mengosongkan (status halaman Fuel). */
  function peek() {
    var list = unitList();
    var lastKey = list.length ? list[list.length - 1].key : null;
    var u = lastKey ? _ingest.units[lastKey] : null;
    return {
      units: list,
      trend: (u && u.trend) ? { name: u.trend.name, rows: u.trend.rows, serial: u.serial } : null,
      cycle: (u && u.cycle) ? { name: u.cycle.name, cycles: u.cycle.cycles.length, serial: u.serial } : null,
      daily: (u && u.daily) ? { name: u.daily.name, days: u.daily.days.length, serial: u.serial } : null,
      ignored: _ingest.ignored.slice()
    };
  }

  function clear() {
    _ingest.units = {}; _ingest.order = []; _ingest.ignored = [];
  }

  var FUEL_INGEST = {
    MAX_TEXT: MAX_TEXT,
    accept: accept,
    has: has,
    count: count,
    unitCount: unitCount,
    take: take,
    peek: peek,
    unitList: unitList,
    clear: clear
  };

global.FUEL_PARSER = FUEL_PARSER;
  global.FUEL_INGEST = FUEL_INGEST;
  if (typeof module !== 'undefined' && module.exports) module.exports = FUEL_PARSER;

})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================================
 * vhms-snapshot.js
 * -------------------------------------------------------------------------
 * [PC2000 2026-10-10 — T10] Parser SNAPSHOT (`snap00.CSV`, `snap01.CSV`).
 *
 * MENGAPA MODUL TERPISAH
 * ----------------------
 * Snapshot adalah WAVEFORM beresolusi tinggi di sekitar satu pemicu alarm —
 * bukan seri waktu SMR. Kolom pertamanya `Time` dalam MILIDETIK RELATIF
 * terhadap titik pemicu (-140000 … +120000 = -140 s … +120 s), BUKAN jam SMR.
 *
 * Sebelum T1, `VHMS_PARSER` memetakannya secara POSISIONAL (fallback 54
 * kolom trend) sehingga 162 "record" palsu dengan 34 parameter trend berisi
 * angka sampah masuk ke armada. Setelah T1, parser utama menolaknya
 * (sumbu pertama bukan SMR) dan `_rawText` diteruskan ke modul ini.
 *
 * NILAI & SATUAN
 * --------------
 *   - Tiap kolom punya PEMBAGI sendiri di baris `Axis Rate` (kolom 0 time
 *     = 1000, `Blowby Press` = 100, tekanan pompa = 10, dst).
 *     ⚠ Nilai mentah WAJIB dibagi `Axis Rate` kolom itu: `Blowby Press` mentah
 *     212 -> 2,12 kPa; `Eng Oil Press` mentah 55 -> 0,55 MPa.
 *   - Kolom `Time` dibagi 1000 ms -> DETIK.
 *
 * UJI "STUCK SENSOR" (D6)
 * -----------------------
 * Nilai sentinel sensor rusak pada ekspor ini = **100** (bukan -32768).
 *   - `LBF`/`RBF`/`RBR Exh Temp` = konstan 100 SE PANJANG berkas (sensor mati)
 *   - `LBR Exh Temp` = 969 °C pada 151/162 baris (93 %)
 * Nilai 100 juga SAH untuk coolant/hidrolik, jadi TIDAK BOLEH dimasukkan ke
 * `NULL_SENTINELS` global. Yang dilakukan modul ini: uji VARIANS per kolom.
 * Bila sebuah kolom nyaris tidak bervariasi di seluruh rekaman (>= ambang
 * `STUCK_RATIO`) DAN kolom itu secara fisik seharusnya mengikuti beban mesin
 * (EGT, boost, blowby, tekanan), tandai `stuck: true` BESERTA nilainya.
 * Pemanggil yang memutuskan membuang/memakai — parser TIDAK menyembunyikan.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG || {};

  /* -----------------------------------------------------------------------
   * 1. Konstanta
   * --------------------------------------------------------------------- */

  /** Tipe VHMS snapshot. */
  var SNAP_TYPES = ['60', '61'];

  /** Pembagi sumbu waktu (ms -> detik). */
  var TIME_DIVISOR = 1000;

  /**
   * Ambang uji "stuck": sebuah nilai dianggap dominan bila muncul pada
   * minimal rasio ini dari seluruh baris. 0,90 dipilih (bukan 0,95) agar
   * `LBR Exh Temp` yang muncul 151/162 = 93,2 % TERTANGKAP. Spesimen spek
   * §5 butir 11 secara eksplisit meminta ambang 90 %.
   */
  var STUCK_RATIO = 0.90;

  /**
   * Kolom yang SECARA FISIK harus bervariasi mengikuti beban mesin.
   * Kolom di luar daftar (mis. `Ambient Temp`, `Hydr Oil Temp`) memang bisa
   * konstan tanpa berarti sensor rusak -> TIDAK ditandai `stuck`.
   * Nama dinormalisasi (huruf kecil, tanpa spasi/titik).
   *
   * ⚠ [B12 2026-10-10] `boost` lama mencocokkan DUA kolom sekaligus:
   *   `Boost Press.` (HARUS bervariasi — mengikuti beban turbo)
   *   `Boost Temp`  (BISA konstan — suhu udara intercooler stabil)
   *   Regex `/boost/` menandai keduanya sehingga `Boost Temp` ikut stuck
   *   walau hanya bernilai 28/29 seperti pada unit contoh. Dipisah agar
   *   `boostpress` masuk kuat & `boosttemp` masuk "lemah".
   */
  var SHOULD_VARY_PATTERNS = [
    /exhtemp/, /blowby/, /boostpress/, /fuelinject/, /engspeed/,
    /pump\d[f|r]press/, /comrailpress/, /engoilpress/
  ];

  /**
   * Kolom yang BISA bervariasi tetapi cukup wajar bila konstan sehingga
   * penandaan `stuck` bersifat "lemah" (dilaporkan terpisah, tidak
   * dihitung sebagai indikasi sensor rusak kuat).
   *
   * ⚠ `Ambient Temp` SENGAJA TIDAK ada di sini (sesuai D6): suhu lingkungan
   * memang bukan indikator beban mesin, jadi konstan pada suhu lingkungan
   * yang stabil adalah NORMAL dan tidak perlu dilaporkan sama sekali.
   * `Boost Temp` (suhu intercooler) MASUK karena pada mesin berbeban tinggi
   * ia seharusnya naik — meski bisa stabil saat operasi mantap.
   */
  var WEAK_VARY_PATTERNS = [
    /boosttemp/, /atmospres/, /ptotemp/
  ];

  /**
   * Kolom INTI kondisi mesin. Statistik dihitung untuk SEMUA kolom, daftar
   * ini hanya menentukan mana yang disorot lebih dulu di UI dan mana yang
   * serinya tetap disimpan saat snapshot dipadatkan (lihat `vhms-fleet-store`).
   */
  var KEY_PEAK_COLUMNS = [
    'Blowby Press', 'Eng Cool Temp', 'Boost Press.', 'Com Rail Press', 'Eng Oil Temp'
  ];

  /* -----------------------------------------------------------------------
   * 2. Deteksi jenis berkas
   * --------------------------------------------------------------------- */

  function isSnapshotType(type) {
    return SNAP_TYPES.indexOf(String(type == null ? '' : type).trim()) >= 0;
  }

  function isSnapshotFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    return /snap/.test(n);
  }

  /* -----------------------------------------------------------------------
   * 3. Utilitas
   * --------------------------------------------------------------------- */

  function splitLine(line) {
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

  // [O-5 2026-10-12] Delegasi ke `CSV_UTIL.toNumStrict` — satu definisi untuk
  // kolom telemetri. KETAT disengaja: "12abc" dan "3,5" harus menjadi `null`,
  // bukan 12 dan 3,5 (lihat catatan pada csv-util.js). Fallback dipertahankan
  // agar modul tetap dapat diuji tanpa CSV_UTIL.
  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // CATATAN: `normKey` di sini BUKAN duplikat `CSV_UTIL.normKey`.
  // CSV_UTIL.normKey meng-UPPERCASE (untuk kunci serial/lambung); yang ini
  // meng-lowercase dan juga membuang tanda kurung — dipakai mencocokkan NAMA
  // KOLOM snapshot. Perilakunya lebih dekat ke `CSV_UTIL.normHeader`, tetapi
  // tidak identik (normHeader juga membuang `%`). Dibiarkan apa adanya:
  // menyatukannya berisiko mengubah pencocokan kolom tanpa manfaat nyata.
  function normKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-()\/]/g, '');
  }

  /** Apakah kolom ini seharusnya bervariasi mengikuti beban mesin? */
  function shouldVary(name) {
    var n = normKey(name);
    for (var i = 0; i < SHOULD_VARY_PATTERNS.length; i++) {
      if (SHOULD_VARY_PATTERNS[i].test(n)) return true;
    }
    return false;
  }

  /** Kolom yang konstan-nya "lemah" (bisa wajar, bukan bukti sensor rusak). */
  function isWeakVary(name) {
    var n = normKey(name);
    for (var i = 0; i < WEAK_VARY_PATTERNS.length; i++) {
      if (WEAK_VARY_PATTERNS[i].test(n)) return true;
    }
    return false;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser
   * --------------------------------------------------------------------- */

  /**
   * Parse teks berkas snapshot.
   *
   * @param {string} text
   * @param {object} [opts]
   *   - dataType   : tipe dari parser utama (opsional, '60'|'61')
   *   - sourceName : nama berkas
   * @returns {object} {
   *     dataType, dataTitle, meta, trigger, samplingTime,
   *     columns[], units[], rates[], divisors[],
   *     series: { <namaKolom>: number[] },   // nilai sudah dibagi Axis Rate
   *     time: number[],                      // detik relatif ke pemicu
   *     rowCount,
   *     stuck: { <namaKolom>: { value, ratio } },
   *     summary: {...}, warnings[]
   *   }
   */
  function parse(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r\n|\n|\r/);

    var result = {
      dataType: '',
      dataTitle: '',
      meta: {},
      trigger: { smr: null, code: '', message: '' },
      samplingTime: '',
      columns: [],
      units: [],
      rates: [],
      divisors: [],
      series: {},
      time: [],
      rowCount: 0,
      stuck: {},
      summary: null,
      warnings: []
    };

    var section = '';
    var inData = false;
    var sawData = false;
    var rawRows = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      var sec = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (sec) {
        section = sec[1].toLowerCase();
        if (/^data$/.test(section)) { inData = true; sawData = true; }
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);

      if (!inData) {
        var key = String(cells[0] || '').trim();
        if (!key) continue;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = String(cells[1] || '').trim();
          result.dataTitle = String(cells[2] || '').trim();
        } else if (/^sampling time$/i.test(key)) {
          result.samplingTime = String(cells[1] || '').trim();
        } else if (/^smr\s*&\s*trigger code\s*&\s*trigger message$/i.test(key)) {
          result.trigger.smr = toNum(cells[1]);
          result.trigger.code = String(cells[2] || '').trim();
          result.trigger.message = String(cells[3] || '').trim();
          // ⚠ JANGAN kalikan `cfg.SMR_SCALE` (0,1) di sini.
          //   Berbeda dari KOLOM data (yang memang 0,1 jam), field header ini
          //   sudah dalam JAM: "SMR & Trigger...,26358.1,..." = 26 358,1 jam
          //   dan COCOK dengan `[Common Header] SMR,26367.5`. Mengalikannya
          //   dengan 0,1 menghasilkan 2 635,81 — salah 10×.
          //   (Bug ini tertangkap saat verifikasi T10.)
        } else if (/^axis item$/i.test(key)) {
          result.columns = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^axis scale$/i.test(key)) {
          result.units = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^axis rate$/i.test(key)) {
          result.rates = cells.slice(1).map(function (s) { return toNum(s); });
        } else if (!/^(axis type|status of item|view item\d*)$/i.test(key)) {
          result.meta[key.toLowerCase()] = String(cells[1] || '').trim();
        }
        continue;
      }

      // --- Baris data: kolom 0 kosong, angka mulai indeks 1 ---
      if (/^\s*(Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) continue;
      if (cells.length < 3) continue;
      var off = (String(cells[0] || '').trim() === '') ? 1 : 0;
      var vals = [];
      for (var c = off; c < cells.length; c++) vals.push(toNum(cells[c]));
      if (!vals.length) continue;
      rawRows.push(vals);
    }

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas snapshot.');
    if (!rawRows.length) throw new Error('Berkas snapshot tidak mengandung baris data.');

    var nCols = result.columns.length;
    // Bila header kolom tidak ada, pakai jumlah kolom baris pertama.
    if (!nCols) nCols = Math.max.apply(null, rawRows.map(function (r) { return r.length; }));

    // Pembagi per kolom: `rates[k]`; default 1.
    result.divisors = [];
    for (var d = 0; d < nCols; d++) {
      var rr = (result.rates && result.rates[d] !== undefined && result.rates[d] !== null && result.rates[d] > 0)
        ? result.rates[d] : 1;
      result.divisors.push(rr);
    }

    // --- Susun seri per kolom (sudah dibagi pembagi) ---
    var series = {};
    for (var k = 0; k < nCols; k++) {
      var name = result.columns[k] || ('col' + k);
      var arr = [];
      for (var r = 0; r < rawRows.length; r++) {
        var v = rawRows[r][k];
        if (v === null || v === undefined) { arr.push(null); continue; }
        var div = result.divisors[k] || 1;
        arr.push(div > 1 ? (v / div) : v);
      }
      series[name] = arr;
    }
    result.series = series;
    result.rowCount = rawRows.length;

    // --- Sumbu waktu (detik relatif terhadap pemicu) ---
    // Kolom 0 adalah `Time`. Nilainya sudah dibagi `Axis Rate` (=1000 ms)
    // oleh loop di atas, sehingga satuannya DETIK (-140 … +120).
    var tcol = Object.keys(series)[0] || 'Time';
    result.time = (series[tcol] || []).slice();

    // --- Uji stuck (D6) ---
    result.stuck = detectStuck(series, result.columns);

    result.summary = summarize(result, opts);
    if (result.summary.warnings.length) result.warnings = result.warnings.concat(result.summary.warnings);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 5. Uji stuck (D6)
   * --------------------------------------------------------------------- */

  /**
   * Deteksi kolom yang nilainya NYARIS TIDAK BERVARIASI di seluruh rekaman.
   * Hanya kolom yang memang seharusnya bervariasi (`shouldVary`) yang
   * ditandai, agar `Ambient Temp` yang wajar konstan tidak salah lapor.
   *
   * [B12 2026-10-10] Kolom "lemah" (`isWeakVary`, mis. `Boost Temp`) tetap
   * dideteksi tetapi ditandai `weak: true` — konstan-nya bisa wajar karena
   * suhu memang stabil. Pemanggil dapat memisahkan mana bukti kuat vs lemah.
   *
   * @returns {object} { <namaKolom>: { value, ratio, count, total, weak } }
   */
  function detectStuck(series, columns) {
    var out = {};
    (columns || Object.keys(series)).forEach(function (name) {
      // Kolom kuat (harus bervariasi) ATAU kolom lemah (sebaiknya bervariasi).
      var strong = shouldVary(name);
      var weak = !strong && isWeakVary(name);
      if (!strong && !weak) return;
      var arr = series[name];
      if (!arr || arr.length < 5) return;
      var freq = {};
      var valid = 0;
      arr.forEach(function (v) {
        if (v === null || v === undefined || isNaN(v)) return;
        valid++;
        var k = String(v);
        freq[k] = (freq[k] || 0) + 1;
      });
      if (!valid) return;
      var topKey = null, topN = 0;
      Object.keys(freq).forEach(function (k) {
        if (freq[k] > topN) { topN = freq[k]; topKey = k; }
      });
      var ratio = topN / valid;
      if (ratio >= STUCK_RATIO) {
        out[name] = { value: Number(topKey), ratio: ratio, count: topN, total: valid, weak: weak };
      }
    });
    return out;
  }

  /* -----------------------------------------------------------------------
   * 6. Ringkasan
   * --------------------------------------------------------------------- */

  function summarize(res, opts) {
    opts = opts || {};
    var out = {
      rowCount: res.rowCount,
      windowSec: null,
      columns: res.columns.length,
      // [B12] `stuckColumns`/`stuckCount` diisi di bawah setelah pemisahan
      // kuat vs lemah. Deklarasi awal sengaja kosong agar tidak ada nilai
      // ganda dari dua tempat.
      stuckColumns: [],
      stuckCount: 0,
      stuckStrong: [],
      stuckStrongCount: 0,
      stuckWeak: [],
      stuckWeakCount: 0,
      peaks: {},
      warnings: []
    };

    // [B12] Pisahkan bukti kuat (sensor hampir pasti rusak) dari bukti lemah
    // (kolom boleh konstan secara fisika, mis. suhu intercooler).
    var strongStuck = [], weakStuck = [];
    Object.keys(res.stuck).forEach(function (k) {
      if (res.stuck[k].weak) weakStuck.push(k); else strongStuck.push(k);
    });
    out.stuckColumns = strongStuck.concat(weakStuck);
    out.stuckCount = out.stuckColumns.length;
    out.stuckStrong = strongStuck;
    out.stuckStrongCount = strongStuck.length;
    out.stuckWeak = weakStuck;
    out.stuckWeakCount = weakStuck.length;

    var t = res.time.filter(function (v) { return v !== null && v !== undefined; });
    if (t.length) out.windowSec = { min: Math.min.apply(null, t), max: Math.max.apply(null, t) };

    // [2026-10-12] Statistik SELURUH kolom numerik, bukan hanya 5 kolom.
    //   Berkas snap berisi ~51 kolom; membatasi ke 5 membuang bukti yang
    //   dibutuhkan untuk menilai alarm (EGT per bank, EPC, tekanan pompa,
    //   posisi throttle, dll). Biaya penyimpanan kecil karena yang disimpan
    //   hanya 6 angka per kolom — BUKAN serinya.
    //   `key:true` menandai kolom inti mesin agar UI dapat menyorotnya.
    var keySet = {};
    KEY_PEAK_COLUMNS.forEach(function (w) { keySet[normKey(w)] = true; });
    (res.columns || []).forEach(function (name, idx) {
      if (idx === 0) return;                 // kolom 0 = sumbu waktu
      var arr = res.series[name] || [];
      var vals = arr.filter(function (v) { return v !== null && v !== undefined && !isNaN(v); });
      if (!vals.length) return;
      var mn = Math.min.apply(null, vals);
      var mx = Math.max.apply(null, vals);
      var sum = 0;
      for (var vi = 0; vi < vals.length; vi++) sum += vals[vi];
      out.peaks[name] = {
        min: mn,
        max: mx,
        last: vals[vals.length - 1],
        avg: sum / vals.length,
        range: mx - mn,
        unit: (res.units && res.units[idx]) || '',
        key: !!keySet[normKey(name)],
        stuck: !!(res.stuck && res.stuck[name]),
        n: vals.length
      };
    });

    if (out.stuckStrongCount) {
      out.warnings.push(out.stuckStrongCount + ' kolom yang SEHARUSNYA bervariasi ' +
        'mengikuti beban mesin ternyata NYARIS KONSTAN di seluruh rekaman — ' +
        'indikasi kuat sensor rusak / stuck: ' + strongStuck.join(', ') + '.');
    }
    if (out.stuckWeakCount) {
      out.warnings.push(out.stuckWeakCount + ' kolom lain juga nyaris konstan ' +
        'tetapi BISA wajar secara fisika (mis. suhu intercooler stabil): ' +
        weakStuck.join(', ') + '. Periksa hanya bila ada gejala lain.');
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * 7. Kunci dedup (R8)
   * --------------------------------------------------------------------- */

  /**
   * Kunci identitas snapshot. DUA snapshot dapat dipicu pada SMR YANG SAMA
   * (unit contoh: `snap00` & `snap01` sama-sama di SMR 26 358,1) tetapi
   * pemicunya BERBEDA. Dedup berbasis SMR saja akan salah membuang salah
   * satunya. Kunci = SMR + KODE PICUTU.
   * @returns {string}
   */
  function snapshotKey(res) {
    var smr = (res && res.trigger && res.trigger.smr !== null) ? res.trigger.smr : '?';
    var code = (res && res.trigger && res.trigger.code) ? res.trigger.code : '?';
    return String(smr) + '|' + String(code);
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_SNAPSHOT = {
    SNAP_TYPES: SNAP_TYPES,
    TIME_DIVISOR: TIME_DIVISOR,
    STUCK_RATIO: STUCK_RATIO,
    SHOULD_VARY_PATTERNS: SHOULD_VARY_PATTERNS,
    WEAK_VARY_PATTERNS: WEAK_VARY_PATTERNS,
    KEY_PEAK_COLUMNS: KEY_PEAK_COLUMNS,
    isSnapshotType: isSnapshotType,
    isSnapshotFileName: isSnapshotFileName,
    shouldVary: shouldVary,
    isWeakVary: isWeakVary,
    parse: parse,
    detectStuck: detectStuck,
    summarize: summarize,
    snapshotKey: snapshotKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_SNAPSHOT;
  }
})(typeof window !== 'undefined' ? window : globalThis);

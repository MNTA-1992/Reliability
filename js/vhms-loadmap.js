/* =========================================================================
 * vhms-loadmap.js
 * -------------------------------------------------------------------------
 * [PC2000 2026-10-10 — T8 + T9] Parser LOAD MAP (`loadm0.CSV`, `loadmop0.CSV`,
 * `loadmwork0.CSV`).
 *
 * MENGAPA MODUL TERPISAH
 * ----------------------
 * Berkas-berkas ini adalah MATRIKS 2-D (histogram), BUKAN seri waktu:
 *   - `loadm0`    (tipe '30') : 8 baris fuel-injection × 17 kolom engine-speed
 *   - `loadmop0`  (tipe '7F') : 8 baris all-pump-torque × 11 kolom rpm
 *   - `loadmwork0`(tipe '7E') : 8 baris work-pump-torque × 11 kolom rpm
 * Baris data DIAWALI LABEL (`"0 - 10"`, `"- 110"`, `"0 - 1000"`), bukan angka
 * SMR. Sebelum T1, `VHMS_PARSER` memetakan kolom secara POSISIONAL memakai
 * daftar 54 kolom trend -> nilai frekuensi load map masuk ke `blowbyMax`,
 * `coolantTemp`, `oilPressHMin`, dst. dan merusak ranking armada secara senyap.
 *
 * SATUAN (PENTING — D4, D8)
 * -------------------------
 *   - `loadm0` : `Column Rate = 1000`. Total seluruh sel = 100 001 -> `/1000`
 *     = 100 %, jadi ini DISTRIBUSI PERSEN sudah ternormalisasi. Bagian fungsi
 *     ini membagi dengan `Column Rate`, BUKAN dengan total.
 *   - `loadmop0`/`loadmwork0` : `Column Rate = 1`, satuan DETIK. Totalnya
 *     (12 545 h pada unit contoh) TIDAK cocok dengan SMR (26 367 h) —
 *     penyebabnya belum dipahami. Karena itu modul ini HANYA mengeluarkan
 *     distribusi RELATIF (%). JANGAN pernah menyatakan "unit bekerja N jam
 *     pada torsi >3000 Nm".
 *
 * T9: SELISIH ALL − WORK
 * ----------------------
 * `loadmop0` (All Pump Torque) mencakup seluruh pompa; `loadmwork0` (Work Pump
 * Torque) hanya pompa attachment. Selisihnya = beban travel + swing +
 * fan/cooling pump. Pada SN 20020 selisih torsi >3000 Nm = 8,49 % — konsisten
 * dengan `op_ava0` (Swing 53,7 %, Travel 6,6 %).
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG || {};

  /* -----------------------------------------------------------------------
   * 1. Konstanta
   * --------------------------------------------------------------------- */

  /** Tipe VHMS yang ditangani modul ini. */
  var LOADMAP_TYPE = '30';        // Load Map (beban mesin)
  var LOADMAP_TMP_TYPE = '31';    // Temporary Load Map (DITOLAK — duplikat)
  var TORQUE_ALL_TYPE = '7F';     // Operating Load Map (All Pump Torque)
  var TORQUE_WORK_TYPE = '7E';    // Work Operating Load Map (Work Pump Torque)

  /** Tipe yang boleh diproses modul ini. */
  var ACCEPTED_TYPES = [LOADMAP_TYPE, TORQUE_ALL_TYPE, TORQUE_WORK_TYPE];

  /** Tipe yang SENGAJA ditolak (D2). */
  var REJECTED_TYPES = [LOADMAP_TMP_TYPE];

  /** Klasifikasi bentuk berkas. */
  var KIND_ENGINE_LOAD = 'engineLoad';    // loadm0 (beban mesin × rpm)
  var KIND_TORQUE_ALL = 'torqueAll';      // loadmop0
  var KIND_TORQUE_WORK = 'torqueWork';    // loadmwork0

  /**
   * Definisi ambang zona untuk `loadm0` (beban mesin).
   * Baris = fuel injection (mm3/st), kolom = engine speed (rpm).
   * Label dari berkas nyata:
   *   baris : 0-10, -110, -160, -210, -260, -360, -460, 460-
   *   kolom : 0-400, -550, -700, -850, -1000, -1150, -1300, -1450,
   *           -1600, -1750, -1900, -2050, -2200, -2350, -2500, -2650, 2650-
   */
  var LUG_FUEL_MIN = 160;   // mm3/st — di atas ini dianggap beban berat
  var LUG_RPM_MAX = 1600;   // rpm — di bawah ini dianggap putaran rendah
  var HIPOWER_FUEL_MIN = 210;
  var HIPOWER_RPM_MIN = 1600;

  /** Ambang torsi (Nm) untuk indikator beban tinggi. */
  var TORQUE_HI = 3000;
  var TORQUE_VERY_HI = 3500;
  var TORQUE_STRESS_RPM = 1500;   // rpm rendah + torsi tinggi = stress hidrolik

  /* -----------------------------------------------------------------------
   * 2. Deteksi jenis berkas
   * --------------------------------------------------------------------- */

  function isLoadMapType(type) {
    var t = String(type == null ? '' : type).trim();
    return ACCEPTED_TYPES.indexOf(t) >= 0;
  }

  function isRejectedLoadMapType(type) {
    return REJECTED_TYPES.indexOf(String(type == null ? '' : type).trim()) >= 0;
  }

  function kindFromType(type) {
    var t = String(type == null ? '' : type).trim();
    if (t === LOADMAP_TYPE) return KIND_ENGINE_LOAD;
    if (t === TORQUE_ALL_TYPE) return KIND_TORQUE_ALL;
    if (t === TORQUE_WORK_TYPE) return KIND_TORQUE_WORK;
    return null;
  }

  /** Tebak dari nama berkas (cadangan bila `dataType` tak tersedia). */
  function kindFromFileName(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    if (/loadmwork/.test(n)) return KIND_TORQUE_WORK;
    if (/loadmop/.test(n)) return KIND_TORQUE_ALL;
    // [D375A 2026-10-14 — J4] BARIS INI DULU `/loadm/` — CATCH-ALL.
    // Selama hanya PC2000 yang didukung, pola itu tidak berbahaya: tak ada
    // berkas lain yang berawalan `loadm`. Setelah ekspor D375A masuk, ada
    // 14 berkas berawalan `loadm` SEKALIGUS:
    //   loadmlu(34) loadmtc(35) loadmp1(36) loadmp2(37)
    //   loadmstlc(25) loadmstrc(24) loadmstlb(27) loadmstrb(26)
    //   loadmtmf1..3(44..46) loadmtmr1..3(47..49)  + loadm0(30) loadm1(31)
    // Sumbu Y keempat belasnya adalah Nm atau 10 kPa — BUKAN FuelInjection.
    // Bila `dataType` gagal terbaca (berkas terpotong, ekspor varian, salin
    // tempel manual), catch-all akan melabeli SEMUANYA `engineLoad` lalu
    // menilainya dengan ambang LUG_FUEL_MIN=160 / HIPOWER_FUEL_MIN=210
    // mm3/st. Ambang bahan bakar diterapkan ke angka torsi = angka sampah
    // yang tampak seperti temuan.
    // Pola kini BERJANGKAR: hanya `loadm0`/`loadm1` (opsional `.csv`),
    // boleh didahului path. `(^|[\\/])` karena `sourceName` dapat berupa
    // path utuh seperti `CHK0001/loadm0.CSV`.
    if (/(^|[\\/])loadm[01](\.csv)?$/.test(n)) return KIND_ENGINE_LOAD;
    return null;
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

  // [O-5 2026-10-12] Delegasi ke `CSV_UTIL.toNumStrict` (lihat csv-util.js).
  // Ketat disengaja: nilai berimbuhan huruf atau berkoma = data rusak -> null.
  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /**
   * Ubah label batas menjadi angka.
   *   `"0 - 10"` -> { lo: 0,  hi: 10, upper: false }
   *   `"- 110"`  -> { lo: 10, hi: 110, upper: true  }  (batas ATAS)
   *   `"460 -"`  -> { lo: 460, hi: null, upper: true } (terbuka)
   * @returns {{lo:number|null, hi:number|null, open:boolean, label:string}}
   */
  function parseBandLabel(label) {
    var s = String(label == null ? '' : label).trim();
    var out = { lo: null, hi: null, open: false, label: s };
    // Pola "A - B"
    var m2 = /^(-?\s*[\d.]+)\s*-\s*(-?\s*[\d.]+)$/.exec(s);
    if (m2) {
      out.lo = toNum(m2[1].replace(/\s+/g, ''));
      out.hi = toNum(m2[2].replace(/\s+/g, ''));
      return out;
    }
    // Pola "- B" (hanya batas atas; batas bawah implisit dari baris sebelumnya)
    var m1 = /^-\s*([\d.]+)$/.exec(s);
    if (m1) { out.hi = toNum(m1[1]); out.open = false; return out; }
    // Pola "A -" (batas bawah, atas terbuka)
    var m3 = /^([\d.]+)\s*-$/.exec(s);
    if (m3) { out.lo = toNum(m3[1]); out.open = true; return out; }
    return out;
  }

  /**
   * Lengkapi batas bawah untuk label yang hanya punya batas ATAS.
   * ---------------------------------------------------------------------
   * Berkas menulis baris/kolom pertama dengan batas lengkap lalu sisanya
   * hanya batas ATAS karena batas bawah = batas atas sebelumnya:
   *   "0 - 10", "- 110", "- 160", ...  ->  0-10, 10-110, 110-160, ...
   *   "0 - 400", "- 550", "- 700", ... ->  0-400, 400-550, 550-700, ...
   * Tanpa langkah ini, batas bawah dibaca sebagai null (atau salah diambil
   * dari `hi`), sehingga klasifikasi zona (LUG / high-power) meleset.
   *
   * @param {array} labels label mentah
   * @returns {array} band { lo, hi, open, label } dengan `lo` terisi
   */
  function resolveBands(labels) {
    var bands = (labels || []).map(parseBandLabel);
    for (var i = 1; i < bands.length; i++) {
      if (bands[i].lo === null && !bands[i].open) {
        // Batas bawah = batas atas elemen sebelumnya.
        bands[i].lo = bands[i - 1].hi;
      }
    }
    return bands;
  }

  /* -----------------------------------------------------------------------
   * 4. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse teks berkas load map.
   *
   * @param {string} text  isi berkas
   * @param {object} [opts]
   *   - dataType  : tipe dari parser utama (opsional)
   *   - sourceName: nama berkas
   * @returns {object} {
   *     kind, dataType, dataTitle, meta,
   *     rowLabels[], colLabels[], matrix[][], columnRate,
   *     yAxis{title,unit}, xAxis{title,unit}, zAxis{title,unit},
   *     total, normalized (bool),
   *     distribution: { rows:[{label, share}], cols:[{label, share}] },
   *     zones: {...}, warnings[]
   *   }
   */
  function parse(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r\n|\n|\r/);

    var result = {
      kind: null,
      dataType: '',
      dataTitle: '',
      meta: {},
      rowLabels: [],
      colLabels: [],
      matrix: [],
      columnRate: 1,
      yAxis: { title: '', unit: '' },
      xAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      total: 0,
      normalized: false,
      distribution: { rows: [], cols: [] },
      zones: null,
      warnings: []
    };

    // --- D2: tolak Temporary Load Map secara EKSPLISIT ---
    var type = String(opts.dataType == null ? '' : opts.dataType).trim();
    if (isRejectedLoadMapType(type)) {
      result.warnings.push('Berkas Temporary Load Map (tipe ' + type +
        ') DITOLAK: pada unit contoh isinya byte-identik dengan Load Map utama ' +
        'dan hanya menambah risiko data ganda. Lihat keputusan D2.');
      result.rejected = true;
      return result;
    }

    var section = '';
    var inData = false;
    var sawData = false;

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

      if (!inData) {
        var cells = splitLine(line);
        var key = String(cells[0] || '').trim();
        if (!key) continue;
        var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();

        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = String(cells[1] || '').trim();
          result.dataTitle = String(cells[2] || '').trim();
        } else if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^column rate$/i.test(key)) {
          // Ambil rate pertama (semua kolom biasanya sama).
          var r0 = toNum(cells[1]);
          result.columnRate = (r0 === null || r0 <= 0) ? 1 : r0;
        } else if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (!/^(status of item|view item\d*|axis type|axis rate)$/i.test(key)) {
          result.meta[key.toLowerCase()] = val;
        }
        continue;
      }

      // --- Baris data: label di kolom 0, angka di kolom 1..N ---
      if (/^\s*(Column (Item|Rate|Type|Scale)|Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) continue;
      var row = splitLine(line);
      var label = String(row[0] || '').trim();
      if (label === '') continue;   // baris tanpa label bukan data distribusi
      // Baris meta (mis. "SMR & Trigger...") tidak punya angka -> lewati bila
      // seluruh sel numerik kosong.
      var nums = row.slice(1).map(toNum);
      if (!nums.some(function (v) { return v !== null; })) continue;

      result.rowLabels.push(label);
      result.matrix.push(nums.map(function (v) { return v === null ? 0 : v; }));
    }

    if (!sawData) {
      throw new Error('Bagian [Data] tidak ditemukan pada berkas Load Map.');
    }
    if (!result.matrix.length) {
      throw new Error('Berkas Load Map tidak mengandung baris data.');
    }

    // --- Penentuan kind ---
    result.kind = kindFromType(result.dataType) || kindFromFileName(opts.sourceName || '');
    if (!result.kind) {
      // Tebak dari sumbu Y: "Torque" -> torsi, "Fuel inject" -> beban mesin.
      var yt = (result.yAxis.title || '').toLowerCase();
      if (/torque/.test(yt)) {
        result.kind = /work/.test(yt) ? KIND_TORQUE_WORK : KIND_TORQUE_ALL;
      } else {
        result.kind = KIND_ENGINE_LOAD;
      }
      result.warnings.push('Jenis Load Map ditebak dari sumbu Y (' + result.yAxis.title + ').');
    }

    // --- Total & distribusi ---
    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.total = total;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — berkas tidak berisi data yang dapat dianalisis.');
      result.distribution = { rows: [], cols: [] };
      return result;
    }

    // ---------------------------------------------------------------------
    // [FIX 2026-10-10 saat verifikasi] SATUAN & NORMALISASI.
    // -------------------------------------------------------------------
    // Semua sel dibagi TOTAL matriks, BUKAN kolom `Column Rate`.
    //
    // Bukti dari berkas nyata:
    //   `loadm0`  total = 100 001. 263 / 100 001 × 100 = 0,263 % (label baris
    //             "0 - 10" = idle 0,26 % → COCOK). 35 595 / 100 001 = 35,59 %
    //             ("- 260" → COCOK dengan hitungan manual).
    //   `loadmop0` total = 45 160 582 s = 12 545 jam (detik).
    //
    // ⚠ `Column Rate` BUKAN pembagi. Ia adalah INTERVAL SAMPLING (1000 ms
    //   untuk `loadm0`, 1 untuk matriks torsi) — metadata, bukan skala nilai.
    //   Kesalahan awal modul ini membagi dengan `Column Rate` sehingga semua
    //   persen menjadi 1000× terlalu besar. Membaginya dengan TOTAL bersifat
    //   universal & benar untuk kedua jenis berkas.
    // ---------------------------------------------------------------------
    var normDiv = total;
    result.normalized = true;

    result.distribution = {
      rows: result.rowLabels.map(function (lbl, ri) {
        var sum = result.matrix[ri].reduce(function (a, b) { return a + b; }, 0);
        return { label: lbl, value: sum, share: 100 * sum / normDiv };
      }),
      cols: (result.colLabels || []).map(function (lbl, ci) {
        var sum = 0;
        result.matrix.forEach(function (r) { sum += (r[ci] || 0); });
        return { label: lbl, value: sum, share: 100 * sum / normDiv };
      }).filter(function (c) { return c.value > 0; })
    };

    // --- Zona (khusus beban mesin / torsi) ---
    result.zones = buildZones(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 5. Zona (indikator turunan)
   * --------------------------------------------------------------------- */

  /**
   * Hitung indikator zona dari matriks.
   * Untuk beban mesin: LUG (fuel tinggi + rpm rendah), high-power sehat, idle.
   * Untuk torsi: beban >3000/>3500 Nm, dan torsi tinggi + rpm rendah.
   */
  function buildZones(res) {
    var matrix = res.matrix;
    // [FIX] Lengkapi batas bawah berurutan ("- 1600" = band 1450-1600).
    var rowBands = resolveBands(res.rowLabels);
    var colBands = resolveBands(res.colLabels);
    // [FIX] Bagi dengan TOTAL (universal), bukan `columnRate` — lihat catatan
    // di `parse()`. Kedua jenis berkas memakai aturan yang sama.
    var normDiv = res.total;
    if (normDiv <= 0) return null;
    var pct = function (v) { return 100 * v / normDiv; };

    var zones = {};

    // Batas BAWAH sebuah band = dasar klasifikasi. `lo` sudah dilengkapi
    // oleh `resolveBands`, jadi tidak perlu fallback ke `hi`.
    function bandLow(b) { return (b.lo !== null) ? b.lo : b.hi; }

    if (res.kind === KIND_ENGINE_LOAD) {
      var lug = 0, hiPower = 0, idle = 0, fuelHi = 0;
      for (var i = 0; i < matrix.length; i++) {
        var fLow = bandLow(rowBands[i]);       // mm3/st batas bawah
        for (var j = 0; j < matrix[i].length; j++) {
          var v = matrix[i][j];
          if (!v) continue;
          var rLow = bandLow(colBands[j]);     // rpm batas bawah band
          // LUG: fuel >= 160 & rpm band di bawah 1600 (batas bawah < 1600).
          if (fLow !== null && fLow >= LUG_FUEL_MIN && rLow !== null && rLow < LUG_RPM_MAX) lug += v;
          // High power sehat: fuel >= 210 & rpm band >= 1600.
          if (fLow !== null && fLow >= HIPOWER_FUEL_MIN && rLow !== null && rLow >= HIPOWER_RPM_MIN) hiPower += v;
          // Idle: rpm band < 1000 (batas bawah < 1000).
          if (rLow !== null && rLow < 1000) idle += v;
          // Beban bahan bakar TINGGI (>= 210 mm3/st).
          // ⚠ Ambang ini SENGAJA 210 (bukan 260). Angka acuan 59,11 %
          //   pada spek dihitung dari fuel >= 210. Memakai 260 hanya
          //   menghasilkan 23,52 % dan tidak sebanding antar unit.
          if (fLow !== null && fLow >= HIPOWER_FUEL_MIN) fuelHi += v;
        }
      }
      zones.kind = KIND_ENGINE_LOAD;
      zones.lugShare = pct(lug);
      zones.highPowerShare = pct(hiPower);
      zones.idleShare = pct(idle);
      zones.highFuelShare = pct(fuelHi);
      zones.thresholds = { lugFuelMin: LUG_FUEL_MIN, lugRpmMax: LUG_RPM_MAX, hiPowerFuelMin: HIPOWER_FUEL_MIN, hiPowerRpmMin: HIPOWER_RPM_MIN };
      return zones;
    }

    // Torsi (all / work): batas bawah band = dasar klasifikasi.
    var hiT = 0, veryHiT = 0, stress = 0, rpmHi = 0;
    for (var i2 = 0; i2 < matrix.length; i2++) {
      var tLow = bandLow(rowBands[i2]);        // Nm batas bawah band
      for (var j2 = 0; j2 < matrix[i2].length; j2++) {
        var v2 = matrix[i2][j2];
        if (!v2) continue;
        var rLow2 = bandLow(colBands[j2]);
        if (tLow !== null && tLow >= TORQUE_HI) hiT += v2;
        if (tLow !== null && tLow >= TORQUE_VERY_HI) veryHiT += v2;
        if (rLow2 !== null && rLow2 >= 1900) rpmHi += v2;
        if (tLow !== null && tLow >= 2500 && rLow2 !== null && rLow2 < TORQUE_STRESS_RPM) stress += v2;
      }
    }
    zones.kind = res.kind === KIND_TORQUE_WORK ? KIND_TORQUE_WORK : KIND_TORQUE_ALL;
    zones.highTorqueShare = pct(hiT);        // >= 3000 Nm
    zones.veryHighTorqueShare = pct(veryHiT); // >= 3500 Nm
    zones.stressTorqueShare = pct(stress);   // torsi tinggi + rpm rendah
    zones.highRpmShare = pct(rpmHi);
    zones.thresholds = { hi: TORQUE_HI, veryHi: TORQUE_VERY_HI, stressRpm: TORQUE_STRESS_RPM };
    return zones;
  }

  /* -----------------------------------------------------------------------
   * 6. T9 — Selisih ALL − WORK (beban non-kerja: travel + swing + fan)
   * --------------------------------------------------------------------- */

  /**
   * Hitung selisih distribusi antara `loadmop0` (all) dan `loadmwork0` (work).
   * Selisih = beban pompa yang BUKAN attachment -> travel, swing, fan/cooling.
   *
   * @param {object} allRes   hasil parse loadmop0
   * @param {object} workRes  hasil parse loadmwork0
   * @returns {object|null} { perRow[], nonWorkHighTorque, allHighTorque,
   *                          workHighTorque, consistent }
   */
  function torqueDelta(allRes, workRes) {
    if (!allRes || !workRes) return null;
    if (allRes.kind !== KIND_TORQUE_ALL || workRes.kind !== KIND_TORQUE_WORK) return null;
    if (!allRes.matrix.length || !workRes.matrix.length) return null;

    var rows = Math.min(allRes.matrix.length, workRes.matrix.length);
    var cols = Math.min(allRes.colLabels.length, workRes.colLabels.length);
    if (!rows || !cols) return null;

    var perRow = [];
    // ⚠ Nilai mentah kedua berkas TIDAK sebanding (total berbeda). Delta
    // dihitung atas SHARE PERSEN (%) per baris, bukan selisih angka mentah —
    // kalau memakai angka mentah, hasilnya bisa negatif dan menyesatkan.
    var aTot = allRes.total || 0;
    var wTot = workRes.total || 0;
    if (!aTot || !wTot) return null;
    for (var i = 0; i < rows; i++) {
      var a = 0, w = 0;
      for (var j = 0; j < cols; j++) {
        a += allRes.matrix[i][j] || 0;
        w += workRes.matrix[i][j] || 0;
      }
      var aPct = 100 * a / aTot;
      var wPct = 100 * w / wTot;
      perRow.push({
        label: allRes.rowLabels[i],
        allRaw: a, workRaw: w,
        /** Share baris pada masing-masing berkas (%). */
        allPct: aPct, workPct: wPct,
        /** Selisih share: >0 = beban ini lebih dominan di ALL (non-kerja). */
        deltaPct: aPct - wPct
      });
    }

    var aZ = allRes.zones || {};
    var wZ = workRes.zones || {};
    var nonWork = (aZ.highTorqueShare || 0) - (wZ.highTorqueShare || 0);

    return {
      perRow: perRow,
      allHighTorque: aZ.highTorqueShare || 0,
      workHighTorque: wZ.highTorqueShare || 0,
      /** Beban torsi tinggi yang BUKAN dari attachment (%). */
      nonWorkHighTorque: nonWork,
      allPct: allRes.distribution,
      workPct: workRes.distribution,
      /** Kedua berkas punya sumbu rpm identik -> perbandingan sah. */
      consistent: true,
      headers: {
        all: allRes.yAxis.title || 'All Pump Torque',
        work: workRes.yAxis.title || 'Work Pump Torque'
      }
    };
  }

  /* -----------------------------------------------------------------------
   * 7. Ringkas untuk UI
   * --------------------------------------------------------------------- */

  function headlineRows(res) {
    if (!res || !res.zones) return [];
    var z = res.zones;
    var rows = [];
    var f = function (v) { return (v === null || v === undefined) ? '—' : v.toFixed(2); };
    if (z.kind === KIND_ENGINE_LOAD) {
      rows.push({ label: 'Zona LUG (fuel ≥160 & rpm ≤1600)', value: f(z.lugShare), unit: '%', note: 'paling merusak piston/turbo' });
      rows.push({ label: 'High-power sehat (fuel ≥210 & rpm >1600)', value: f(z.highPowerShare), unit: '%', note: '' });
      rows.push({ label: 'Idle (rpm ≤1000)', value: f(z.idleShare), unit: '%', note: '' });
      rows.push({ label: 'Beban bahan bakar tinggi (≥210 mm³/st)', value: f(z.highFuelShare), unit: '%', note: '' });
    } else {
      rows.push({ label: 'Torsi ≥3000 Nm', value: f(z.highTorqueShare), unit: '%', note: '' });
      rows.push({ label: 'Torsi ≥3500 Nm', value: f(z.veryHighTorqueShare), unit: '%', note: '' });
      rows.push({ label: 'Torsi tinggi + rpm <1500', value: f(z.stressTorqueShare), unit: '%', note: 'stress hidrolik' });
    }
    return rows;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_LOADMAP = {
    LOADMAP_TYPE: LOADMAP_TYPE,
    LOADMAP_TMP_TYPE: LOADMAP_TMP_TYPE,
    TORQUE_ALL_TYPE: TORQUE_ALL_TYPE,
    TORQUE_WORK_TYPE: TORQUE_WORK_TYPE,
    ACCEPTED_TYPES: ACCEPTED_TYPES,
    REJECTED_TYPES: REJECTED_TYPES,
    KIND_ENGINE_LOAD: KIND_ENGINE_LOAD,
    KIND_TORQUE_ALL: KIND_TORQUE_ALL,
    KIND_TORQUE_WORK: KIND_TORQUE_WORK,
    LUG_FUEL_MIN: LUG_FUEL_MIN,
    LUG_RPM_MAX: LUG_RPM_MAX,
    HIPOWER_FUEL_MIN: HIPOWER_FUEL_MIN,
    HIPOWER_RPM_MIN: HIPOWER_RPM_MIN,
    TORQUE_HI: TORQUE_HI,
    TORQUE_VERY_HI: TORQUE_VERY_HI,
    isLoadMapType: isLoadMapType,
    isRejectedLoadMapType: isRejectedLoadMapType,
    kindFromType: kindFromType,
    kindFromFileName: kindFromFileName,
    parseBandLabel: parseBandLabel,
    resolveBands: resolveBands,
    parse: parse,
    buildZones: buildZones,
    torqueDelta: torqueDelta,
    headlineRows: headlineRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_LOADMAP;
  }
})(typeof window !== 'undefined' ? window : globalThis);

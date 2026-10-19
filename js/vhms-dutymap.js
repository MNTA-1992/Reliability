/* =========================================================================
 * vhms-dutymap.js
 * -------------------------------------------------------------------------
 * [HD785 2026-10-14] Penafsir PETA DUTY OPERASI dari ekspor VHMS HD785.
 * Lima berkas, empat bentuk analisis yang saling melengkapi.
 *
 * BERKAS YANG DITANGANI
 *   '52' CSVDATA_52  Loaded Engine Count Map     X=Engine Speed  Y=Fuel inject.
 *   '54' CSVDATA_54  no-Loaded Engine Count Map  X=Engine Speed  Y=Fuel inject.
 *   '57' CSVDATA_57  Slope Count Map at Retarder X=TravelSpeed   Y=Slope Angle
 *   '58' CSVDATA_58  Engine Count Map at Retarder X=Engine Speed Y=Slope Angle
 *   '56' CSVDATA_56  Warm-up time Histogram      X=Warm-up Time  (1 baris)
 *
 * Semua ber-Z `Time, sec` kecuali '56' yang ber-Z hitungan (`Count, times`).
 *
 * =========================================================================
 * TEMUAN PENTING #1 — PASANGAN 52/54 ADALAH BERMUATAN vs KOSONG
 * =========================================================================
 *   Inilah nilai analitik terbesar dari kelompok ini. Dua berkas memakai
 *   sumbu IDENTIK (rpm x fuel injection) tetapi direkam pada kondisi
 *   berbeda: '52' saat bak BERMUATAN, '54' saat KOSONG. Selisihnya
 *   menjawab pertanyaan yang tidak bisa dijawab `loadm0` sendirian:
 *
 *     "Apakah beban berat unit ini berasal dari MUATAN (wajar) atau dari
 *      cara mengemudi / kondisi jalan saat kosong (tidak wajar)?"
 *
 *   Unit contoh SN 31991 (terukur):
 *     bermuatan 9.329 h · idle 7,7 % · LUG 26,9 % · high-power 38,9 %
 *     kosong   13.260 h · idle 39,6 % · LUG  8,5 % · high-power  3,8 %
 *   Pola ini SEHAT: beban terkonsentrasi saat bermuatan, kosong banyak idle.
 *   Pola TERBALIK (LUG tinggi saat kosong) menandakan rem terseret,
 *   jalan rusak, atau gigi terlalu rendah — dan hanya terlihat dari pasangan.
 *
 *   AMBANG ZONA (LUG 160 mm³/st @ <1600 rpm, high-power 210 @ ≥1600) DIAMBIL
 *   DARI `VHMS_LOADMAP` — BUKAN disalin. Sumbu kedua berkas ini SAMA PERSIS
 *   dengan `loadm0` (Engine Speed x Fuel inject.), jadi ambangnya memang
 *   besaran yang sama dan WAJIB satu sumber. Bila ambang di `VHMS_LOADMAP`
 *   berubah, modul ini ikut berubah — itu yang diinginkan.
 *
 *   ⚠ Bandingkan dengan `vhms-gearload.js` yang justru MENOLAK memakai
 *     ambang torsi `VHMS_LOADMAP`: di sana besaran fisisnya BERBEDA (torsi
 *     poros vs torsi pompa). Di sini besarannya SAMA. Aturannya bukan
 *     "selalu pakai ulang" atau "jangan pernah" — melainkan: pakai ulang
 *     HANYA bila besaran fisis & sumbu identik.
 *
 * =========================================================================
 * TEMUAN PENTING #2 — 57 & 58 DIDOMINASI WAKTU DIAM, WAJIB DISARING
 * =========================================================================
 *   Judulnya "at Retarder", tetapi isinya BUKAN hanya saat retarder aktif.
 *   Terukur pada unit contoh:
 *     '57' total 6.507 h — 94,6 % ADA DI KOLOM PERTAMA "0 - 10 km/h"
 *     '58' total 6.507 h — 58,8 % di SATU SEL (slope 0-1° x rpm ≤700)
 *   Kedua total identik (23.425.978 detik) -> keduanya merekam JENDELA YANG
 *   SAMA, hanya diproyeksikan ke sumbu berbeda.
 *
 *   Artinya sel dominan itu adalah unit DIAM/IDLE, bukan pengereman.
 *   Menghitung persen atas total mentah menghasilkan angka yang terlihat
 *   menenangkan tetapi tidak bermakna ("slope ≥8° hanya 2,46 %").
 *
 *   KARENA ITU modul ini melaporkan DUA basis secara eksplisit:
 *     - share    : terhadap SELURUH jendela (apa adanya)
 *     - movShare : terhadap waktu BERGERAK saja (kolom pertama dibuang)
 *   Pada unit contoh, basis bergerak (351 h) memberi gambaran yang jauh
 *   berbeda: slope ≥8° = 31,7 %, kecepatan ≥30 km/h = 29,8 %.
 *
 *   ⚠ KEJUJURAN: pemisahan "bergerak" memakai BAND PERTAMA sumbu X sebagai
 *     proksi "diam" — itu asumsi struktural (band 0-10 km/h), bukan sinyal
 *     eksplisit dari berkas. Dinyatakan di `movBasisNote` agar pembaca tahu.
 *     Untuk '58' sumbu X adalah rpm, jadi proksinya "rpm idle" — band
 *     pertama yang batas atasnya ≤ IDLE_RPM.
 *
 * =========================================================================
 * TEMUAN PENTING #3 — 56 ADALAH HISTOGRAM SATU BARIS
 * =========================================================================
 *   Bentuknya BUKAN matriks: satu baris berlabel "Count", 4 kolom band
 *   menit ("0 - 2","- 4","- 5","5 -"), Z = `Count, times`. Jumlah = 1.605
 *   kali start mesin. Ini SATU-SATUNYA berkas di kelompok ini yang
 *   satuannya hitungan, bukan detik -> `hours` TIDAK dilaporkan.
 *
 *   Warm-up terlalu singkat = oli belum mencapai suhu kerja saat dibebani
 *   (aus abnormal). Terlalu lama = idle berlebih (glazing liner, BBM).
 *   Unit contoh: 73,0 % start warm-up <2 menit, 9,0 % >5 menit.
 *   TIDAK ada ambang OEM yang bisa dibuktikan -> hanya angka + konteks.
 *
 * PRINSIP PROYEK
 *   - Nilai TIDAK dimutasi; modul murni atas teks masukan.
 *   - Tanpa vonis "normal/abnormal" di luar yang punya dasar ambang jelas.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * 1. Konstanta & peta tipe
   * --------------------------------------------------------------------- */

  var KIND_LOADED = 'engineLoaded';     // '52' bermuatan
  var KIND_UNLOADED = 'engineUnloaded'; // '54' kosong
  var KIND_SLOPE = 'slopeRetarder';     // '57' slope x kecepatan
  var KIND_ENGINE_SLOPE = 'engineSlope';// '58' slope x rpm
  var KIND_WARMUP = 'warmup';           // '56' histogram warm-up

  var TYPE_MAP = {
    '52': KIND_LOADED,
    '54': KIND_UNLOADED,
    '57': KIND_SLOPE,
    '58': KIND_ENGINE_SLOPE,
    '56': KIND_WARMUP
  };

  /** Label manusiawi per jenis (dipakai panel & pesan). */
  var KIND_LABEL = {};
  KIND_LABEL[KIND_LOADED] = 'Peta beban mesin — BERMUATAN';
  KIND_LABEL[KIND_UNLOADED] = 'Peta beban mesin — KOSONG';
  KIND_LABEL[KIND_SLOPE] = 'Peta kemiringan saat retarder';
  KIND_LABEL[KIND_ENGINE_SLOPE] = 'Peta putaran mesin saat retarder';
  KIND_LABEL[KIND_WARMUP] = 'Histogram waktu pemanasan';

  var SEC_PER_HOUR = 3600;

  /**
   * Batas rpm idle untuk memisahkan "mesin bekerja" pada '58'.
   * Sama dengan ambang idle `VHMS_LOADMAP` (rpm < 1000) — dibaca dinamis
   * di `idleRpmLimit()` agar tidak ada dua angka yang bisa berbeda.
   */
  var IDLE_RPM_FALLBACK = 1000;

  /** Ambang kemiringan "curam" (derajat) untuk pengelompokan deskriptif. */
  var STEEP_SLOPE_DEG = 8;

  /** Ambang kecepatan "tinggi" (km/h) saat menuruni jalan. */
  var FAST_SPEED_KMH = 30;

  /* -----------------------------------------------------------------------
   * 2. Deteksi & utilitas
   * --------------------------------------------------------------------- */

  function normType(t) { return String(t == null ? '' : t).trim().toUpperCase(); }

  function isDutyMapType(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_MAP, normType(type));
  }

  function kindFromType(type) { return TYPE_MAP[normType(type)] || null; }

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

  function toNum(v) {
    var cu = global.CSV_UTIL;
    if (cu && typeof cu.toNumStrict === 'function') return cu.toNumStrict(v);
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '---') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** Band dengan batas bawah terisi — dipinjam dari VHMS_LOADMAP (satu sumber). */
  function resolveBands(labels) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') return lm.resolveBands(labels);
    var prev = null;
    return (labels || []).map(function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      var out = { lo: null, hi: null, open: false, label: s };
      var m2 = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
      if (m2) { out.lo = toNum(m2[1]); out.hi = toNum(m2[2]); prev = out.hi; return out; }
      var m1 = /^-\s*([\d.]+)$/.exec(s);
      if (m1) { out.hi = toNum(m1[1]); out.lo = prev; prev = out.hi; return out; }
      var m3 = /^([\d.]+)\s*-$/.exec(s);
      if (m3) { out.lo = toNum(m3[1]); out.open = true; prev = out.lo; return out; }
      return out;
    });
  }

  function bandLow(b) {
    if (!b) return null;
    return (b.lo !== null && b.lo !== undefined) ? b.lo : b.hi;
  }

  /* -----------------------------------------------------------------------
   * 3. Ambang yang DIPINJAM dari VHMS_LOADMAP
   * ---------------------------------------------------------------------
   * Sumbu '52'/'54' identik dengan `loadm0` -> ambangnya besaran yang SAMA.
   * Dibaca saat runtime (bukan disalin sebagai literal) supaya tidak mungkin
   * ada dua nilai berbeda antara panel load map & panel duty.
   * --------------------------------------------------------------------- */

  function lugFuelMin() {
    var lm = global.VHMS_LOADMAP;
    return (lm && typeof lm.LUG_FUEL_MIN === 'number') ? lm.LUG_FUEL_MIN : 160;
  }
  function lugRpmMax() {
    var lm = global.VHMS_LOADMAP;
    return (lm && typeof lm.LUG_RPM_MAX === 'number') ? lm.LUG_RPM_MAX : 1600;
  }
  function hiPowerFuelMin() {
    var lm = global.VHMS_LOADMAP;
    return (lm && typeof lm.HIPOWER_FUEL_MIN === 'number') ? lm.HIPOWER_FUEL_MIN : 210;
  }
  function hiPowerRpmMin() {
    var lm = global.VHMS_LOADMAP;
    return (lm && typeof lm.HIPOWER_RPM_MIN === 'number') ? lm.HIPOWER_RPM_MIN : 1600;
  }
  /** Batas rpm idle — sejalan dengan `buildZones` di VHMS_LOADMAP. */
  function idleRpmLimit() { return IDLE_RPM_FALLBACK; }

  /* -----------------------------------------------------------------------
   * 4. Parser inti
   * --------------------------------------------------------------------- */

  /**
   * Parse satu berkas peta duty.
   *
   * @param {string} text
   * @param {object} [opts] `{ dataType, sourceName }`
   * @returns {object} { kind, dataType, dataTitle, meta, rowLabels[],
   *   colLabels[], matrix[][], xAxis, yAxis, zAxis, totalSec, hours,
   *   secondsValid, zones, warnings[] }
   */
  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

    var result = {
      kind: null,
      dataType: '', dataTitle: '',
      meta: {},
      rowLabels: [], colLabels: [], matrix: [],
      xAxis: { title: '', unit: '' },
      yAxis: { title: '', unit: '' },
      zAxis: { title: '', unit: '' },
      totalSec: 0, hours: null, secondsValid: false,
      zones: null,
      warnings: []
    };

    var inData = false, sawData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === undefined) continue;
      var trimmed = line.trim();

      var sec = /^\[(.+?)\]\s*$/.exec(trimmed);
      if (sec) {
        if (/^data$/i.test(sec[1])) { inData = true; sawData = true; }
        else inData = false;
        continue;
      }
      if (trimmed === '') continue;

      var cells = splitLine(line);
      var key = String(cells[0] || '').trim();

      if (!inData) {
        if (!key) continue;
        if (/^data type\s*&\s*title$/i.test(key)) {
          result.dataType = String(cells[1] || '').trim();
          result.dataTitle = String(cells[2] || '').trim();
        } else if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        } else if (/^x axis title\s*&\s*x axis scale$/i.test(key)) {
          result.xAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^y axis title\s*&\s*y axis scale$/i.test(key)) {
          result.yAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (/^z axis title\s*&\s*z axis scale$/i.test(key)) {
          result.zAxis = { title: String(cells[1] || '').trim(), unit: String(cells[2] || '').trim() };
        } else if (!/^(status of item|view item\d*|column (type|rate|scale))$/i.test(key)) {
          var val = cells.length > 2 ? String(cells[2] || '').trim() : String(cells[1] || '').trim();
          result.meta[key.toLowerCase()] = val;
        }
        continue;
      }

      if (/^\s*(Column (Item|Rate|Type|Scale)|Axis (Item|Scale|Type|Rate)|Status Of Item|View Item)/i.test(trimmed)) {
        if (/^column item$/i.test(key)) {
          result.colLabels = cells.slice(1).map(function (s) { return String(s).trim(); });
        }
        continue;
      }
      if (key === '') continue;
      var nums = cells.slice(1).map(toNum);
      if (!nums.some(function (v) { return v !== null; })) continue;
      result.rowLabels.push(key);
      result.matrix.push(nums.map(function (v) { return v === null ? 0 : v; }));
    }

    if (!sawData) throw new Error('Bagian [Data] tidak ditemukan pada berkas peta duty.');
    if (!result.matrix.length) throw new Error('Berkas peta duty tidak mengandung baris data.');

    result.dataType = normType(opts.dataType || result.dataType);
    result.kind = kindFromType(result.dataType);
    if (!result.kind) {
      result.warnings.push('Tipe "' + result.dataType + '" tidak dikenali sebagai peta duty.');
      return result;
    }
    result.label = KIND_LABEL[result.kind] || result.kind;

    // Satuan sumbu Z. '56' memang bukan detik (hitungan start) — itu BUKAN
    // kelainan, jadi tidak diberi peringatan.
    var zUnit = String(result.zAxis.unit || '').trim().toLowerCase();
    result.secondsValid = (zUnit === 'sec' || zUnit === 's' || zUnit === 'detik');
    if (!result.secondsValid && result.kind !== KIND_WARMUP) {
      result.warnings.push('Satuan sumbu Z terbaca "' + (result.zAxis.unit || '(kosong)') +
        '", bukan detik — nilai jam TIDAK dilaporkan.');
    }

    var total = 0;
    result.matrix.forEach(function (r) { r.forEach(function (v) { total += v; }); });
    result.totalSec = total;
    result.hours = result.secondsValid ? (total / SEC_PER_HOUR) : null;

    if (total <= 0) {
      result.warnings.push('Total sel matriks = 0 — tidak ada data untuk dianalisis.');
      return result;
    }

    result.zones = buildZones(result);
    return result;
  }

  /* -----------------------------------------------------------------------
   * 5. Zona per jenis
   * --------------------------------------------------------------------- */

  function buildZones(res) {
    if (res.kind === KIND_WARMUP) return warmupZones(res);
    if (res.kind === KIND_LOADED || res.kind === KIND_UNLOADED) return engineZones(res);
    if (res.kind === KIND_SLOPE) return slopeZones(res);
    if (res.kind === KIND_ENGINE_SLOPE) return engineSlopeZones(res);
    return null;
  }

  /**
   * '52'/'54' — zona beban mesin. Ambang DIPINJAM dari VHMS_LOADMAP karena
   * sumbunya identik dengan `loadm0` (lihat catatan kepala berkas).
   */
  function engineZones(res) {
    var rowBands = resolveBands(res.rowLabels);   // fuel mm3/st
    var colBands = resolveBands(res.colLabels);   // rpm
    var total = res.totalSec;
    if (total <= 0) return null;

    var LUG_F = lugFuelMin(), LUG_R = lugRpmMax();
    var HP_F = hiPowerFuelMin(), HP_R = hiPowerRpmMin();
    var IDLE_R = idleRpmLimit();

    var lug = 0, hiPower = 0, idle = 0, hiFuel = 0;
    for (var i = 0; i < res.matrix.length; i++) {
      var f = bandLow(rowBands[i]);
      for (var j = 0; j < res.matrix[i].length; j++) {
        var v = res.matrix[i][j];
        if (!v) continue;
        var r = bandLow(colBands[j]);
        if (f !== null && f >= LUG_F && r !== null && r < LUG_R) lug += v;
        if (f !== null && f >= HP_F && r !== null && r >= HP_R) hiPower += v;
        if (r !== null && r < IDLE_R) idle += v;
        if (f !== null && f >= HP_F) hiFuel += v;
      }
    }
    function pct(v) { return 100 * v / total; }
    return {
      kind: res.kind,
      totalSec: total,
      hours: res.hours,
      lugShare: pct(lug),
      highPowerShare: pct(hiPower),
      idleShare: pct(idle),
      highFuelShare: pct(hiFuel),
      /** Ambang yang dipakai — disertakan agar panel dapat menampilkannya. */
      thresholds: { lugFuelMin: LUG_F, lugRpmMax: LUG_R, hiPowerFuelMin: HP_F, hiPowerRpmMin: HP_R, idleRpmMax: IDLE_R },
      thresholdSource: 'VHMS_LOADMAP (sumbu identik dengan loadm0)'
    };
  }

  /**
   * '57' — kemiringan x kecepatan jalan.
   * Dua basis: seluruh jendela, dan HANYA saat bergerak (band kecepatan
   * pertama dibuang). Lihat catatan kepala berkas — tanpa pemisahan ini
   * seluruh angka tenggelam oleh 94,6 % waktu diam.
   */
  function slopeZones(res) {
    var rowBands = resolveBands(res.rowLabels);   // slope deg
    var colBands = resolveBands(res.colLabels);   // km/h
    var total = res.totalSec;
    if (total <= 0) return null;

    var stillSec = 0, movSec = 0;
    var steepAll = 0, steepMov = 0, fastMov = 0, bothMov = 0;
    var perSlope = [];

    for (var i = 0; i < res.matrix.length; i++) {
      var deg = bandLow(rowBands[i]);
      var rowMov = 0, rowAll = 0;
      for (var j = 0; j < res.matrix[i].length; j++) {
        var v = res.matrix[i][j];
        if (!v) continue;
        rowAll += v;
        if (j === 0) { stillSec += v; }     // band kecepatan pertama = diam
        else {
          movSec += v; rowMov += v;
          var kmh = bandLow(colBands[j]);
          if (deg !== null && deg >= STEEP_SLOPE_DEG) steepMov += v;
          if (kmh !== null && kmh >= FAST_SPEED_KMH) fastMov += v;
          if (deg !== null && deg >= STEEP_SLOPE_DEG && kmh !== null && kmh >= FAST_SPEED_KMH) bothMov += v;
        }
        if (deg !== null && deg >= STEEP_SLOPE_DEG) steepAll += v;
      }
      perSlope.push({ label: res.rowLabels[i], sec: rowAll, movSec: rowMov });
    }

    function hrs(s) { return res.secondsValid ? s / SEC_PER_HOUR : null; }
    function pctMov(v) { return movSec > 0 ? 100 * v / movSec : null; }

    return {
      kind: res.kind,
      totalSec: total, hours: res.hours,
      stillSec: stillSec, stillHours: hrs(stillSec), stillShare: 100 * stillSec / total,
      movingSec: movSec, movingHours: hrs(movSec), movingShare: 100 * movSec / total,
      steepShareAll: 100 * steepAll / total,
      /** Basis BERGERAK — ini yang bermakna untuk menilai pola turun bukit. */
      steepShareMoving: pctMov(steepMov),
      fastShareMoving: pctMov(fastMov),
      steepAndFastShareMoving: pctMov(bothMov),
      perSlope: perSlope.map(function (p) {
        return {
          label: p.label, sec: p.sec, hours: hrs(p.sec),
          share: 100 * p.sec / total,
          movShare: pctMov(p.movSec)
        };
      }),
      thresholds: { steepDeg: STEEP_SLOPE_DEG, fastKmh: FAST_SPEED_KMH },
      movBasisNote: 'Basis "bergerak" = seluruh band kecepatan KECUALI band pertama (' +
        (res.colLabels[0] || '?') + '). Ini proksi struktural, bukan sinyal eksplisit dari berkas.'
    };
  }

  /**
   * '58' — kemiringan x putaran mesin. Basis kedua = rpm di atas idle.
   * Overrun (rpm tinggi saat menuruni bukit curam) menandakan engine brake
   * dipakai berlebihan / gigi terlalu rendah.
   */
  function engineSlopeZones(res) {
    var rowBands = resolveBands(res.rowLabels);   // slope deg
    var colBands = resolveBands(res.colLabels);   // rpm
    var total = res.totalSec;
    if (total <= 0) return null;

    var IDLE_R = idleRpmLimit();
    var idleSec = 0, workSec = 0, steepWork = 0, hiRpmWork = 0, overrunWork = 0;
    var biggest = { sec: -1, slope: null, rpm: null };

    for (var i = 0; i < res.matrix.length; i++) {
      var deg = bandLow(rowBands[i]);
      for (var j = 0; j < res.matrix[i].length; j++) {
        var v = res.matrix[i][j];
        if (!v) continue;
        if (v > biggest.sec) biggest = { sec: v, slope: res.rowLabels[i], rpm: res.colLabels[j] };
        var rpm = bandLow(colBands[j]);
        if (rpm !== null && rpm < IDLE_R) { idleSec += v; continue; }
        workSec += v;
        if (deg !== null && deg >= STEEP_SLOPE_DEG) steepWork += v;
        if (rpm !== null && rpm >= 1900) hiRpmWork += v;
        if (deg !== null && deg >= STEEP_SLOPE_DEG && rpm !== null && rpm >= 1900) overrunWork += v;
      }
    }

    function hrs(s) { return res.secondsValid ? s / SEC_PER_HOUR : null; }
    function pctWork(v) { return workSec > 0 ? 100 * v / workSec : null; }

    return {
      kind: res.kind,
      totalSec: total, hours: res.hours,
      idleSec: idleSec, idleHours: hrs(idleSec), idleShare: 100 * idleSec / total,
      workingSec: workSec, workingHours: hrs(workSec), workingShare: 100 * workSec / total,
      steepShareWorking: pctWork(steepWork),
      highRpmShareWorking: pctWork(hiRpmWork),
      /** rpm ≥1900 BERSAMAAN dengan kemiringan ≥8° = indikasi overrun. */
      overrunShareWorking: pctWork(overrunWork),
      biggestCell: biggest.sec > 0
        ? { slope: biggest.slope, rpm: biggest.rpm, sec: biggest.sec, hours: hrs(biggest.sec), share: 100 * biggest.sec / total }
        : null,
      thresholds: { idleRpmMax: IDLE_R, steepDeg: STEEP_SLOPE_DEG, highRpm: 1900 },
      workBasisNote: 'Basis "mesin bekerja" = band rpm dengan batas bawah ≥ ' + IDLE_R +
        ' rpm. Band di bawahnya dianggap idle/diam.'
    };
  }

  /**
   * '56' — histogram warm-up. Satu baris, Z = hitungan start (bukan detik).
   * TIDAK ada ambang OEM yang dapat dibuktikan -> hanya distribusi + konteks.
   */
  function warmupZones(res) {
    var bands = resolveBands(res.colLabels);
    var row = res.matrix[0] || [];
    var total = 0;
    row.forEach(function (v) { total += v; });
    if (total <= 0) return null;

    var shortSec = 0, longSec = 0;
    var buckets = res.colLabels.map(function (lbl, i) {
      var v = row[i] || 0;
      var lo = bandLow(bands[i]);
      return { label: lbl, count: v, share: 100 * v / total, low: lo };
    });
    // "Singkat" = band pertama; "lama" = band terbuka terakhir.
    if (buckets.length) shortSec = buckets[0].count;
    if (buckets.length > 1) longSec = buckets[buckets.length - 1].count;

    return {
      kind: KIND_WARMUP,
      /** Jumlah start mesin yang terekam (SATUAN: kali, bukan detik). */
      startCount: total,
      buckets: buckets,
      shortWarmupShare: 100 * shortSec / total,
      shortWarmupLabel: buckets.length ? buckets[0].label : null,
      longWarmupShare: 100 * longSec / total,
      longWarmupLabel: buckets.length > 1 ? buckets[buckets.length - 1].label : null,
      note: 'Satuan = jumlah start mesin (bukan jam). Tidak ada ambang pabrik ' +
        'yang dapat dirujuk; angka disajikan sebagai distribusi.'
    };
  }

  /* -----------------------------------------------------------------------
   * 6. Pembandingan BERMUATAN vs KOSONG ('52' - '54')
   * --------------------------------------------------------------------- */

  /**
   * Bandingkan peta beban bermuatan & kosong.
   *
   * Semua selisih dihitung atas PERSEN, bukan detik mentah — total kedua
   * berkas berbeda (9.329 h vs 13.260 h) sehingga selisih angka mentah
   * tidak sebanding. Ini aturan yang sama dengan `torqueDelta` di
   * `vhms-loadmap.js` (pelajaran B8).
   *
   * @param {object} loadedRes   hasil parse '52'
   * @param {object} unloadedRes hasil parse '54'
   * @returns {object|null}
   */
  function loadedDelta(loadedRes, unloadedRes) {
    if (!loadedRes || !unloadedRes) return null;
    if (loadedRes.kind !== KIND_LOADED || unloadedRes.kind !== KIND_UNLOADED) return null;
    var lz = loadedRes.zones, uz = unloadedRes.zones;
    if (!lz || !uz) return null;

    var lSec = loadedRes.totalSec, uSec = unloadedRes.totalSec;
    var bothSec = lSec + uSec;
    if (bothSec <= 0) return null;

    var secondsValid = loadedRes.secondsValid && unloadedRes.secondsValid;
    function hrs(s) { return secondsValid ? s / SEC_PER_HOUR : null; }

    // Selisih zona (poin persen). Positif = lebih dominan saat BERMUATAN.
    var lugDelta = lz.lugShare - uz.lugShare;
    var hiPowerDelta = lz.highPowerShare - uz.highPowerShare;
    var idleDelta = lz.idleShare - uz.idleShare;

    /* ------------------------------------------------------------------
     * POLA TERBALIK — satu-satunya "vonis" di modul ini, dan ia SAH karena
     * tidak butuh angka OEM: ia membandingkan unit dengan DIRINYA SENDIRI.
     *
     * Harapan fisika: bak bermuatan ~ +60 ton => butuh lebih banyak bahan
     * bakar pada rpm yang sama. Jadi LUG saat BERMUATAN harus LEBIH TINGGI
     * daripada saat kosong. Bila terbalik (LUG kosong > LUG bermuatan),
     * sumber bebannya BUKAN muatan — kandidat: rem terseret, jalan rusak,
     * pemilihan gigi, atau masalah drivetrain.
     * ------------------------------------------------------------------ */
    var inverted = (lugDelta < 0);

    return {
      secondsValid: secondsValid,
      loadedSec: lSec, unloadedSec: uSec, totalSec: bothSec,
      loadedHours: hrs(lSec), unloadedHours: hrs(uSec), totalHours: hrs(bothSec),
      /** Pangsa waktu mesin hidup dengan bak bermuatan (%). */
      loadedShare: 100 * lSec / bothSec,
      unloadedShare: 100 * uSec / bothSec,
      zonesLoaded: lz, zonesUnloaded: uz,
      lugDelta: lugDelta,
      highPowerDelta: hiPowerDelta,
      idleDelta: idleDelta,
      /** true = LUG justru lebih tinggi saat KOSONG (perlu ditelusuri). */
      lugInverted: inverted,
      invertedNote: inverted
        ? 'Zona LUG lebih tinggi saat KOSONG (' + uz.lugShare.toFixed(1) + ' %) daripada ' +
          'saat BERMUATAN (' + lz.lugShare.toFixed(1) + ' %). Beban berat tidak berasal dari ' +
          'muatan — telusuri rem terseret, kondisi jalan, pemilihan gigi, atau drivetrain.'
        : 'Zona LUG lebih tinggi saat BERMUATAN (' + lz.lugShare.toFixed(1) + ' %) daripada ' +
          'saat KOSONG (' + uz.lugShare.toFixed(1) + ' %) — pola yang diharapkan.'
    };
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_DUTYMAP = {
    KIND_LOADED: KIND_LOADED,
    KIND_UNLOADED: KIND_UNLOADED,
    KIND_SLOPE: KIND_SLOPE,
    KIND_ENGINE_SLOPE: KIND_ENGINE_SLOPE,
    KIND_WARMUP: KIND_WARMUP,
    KIND_LABEL: KIND_LABEL,
    TYPE_MAP: TYPE_MAP,
    ACCEPTED_TYPES: Object.keys(TYPE_MAP),
    STEEP_SLOPE_DEG: STEEP_SLOPE_DEG,
    FAST_SPEED_KMH: FAST_SPEED_KMH,
    isDutyMapType: isDutyMapType,
    kindFromType: kindFromType,
    resolveBands: resolveBands,
    parse: parse,
    buildZones: buildZones,
    loadedDelta: loadedDelta
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_DUTYMAP;
  }
})(typeof window !== 'undefined' ? window : globalThis);

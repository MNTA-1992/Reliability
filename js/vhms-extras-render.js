/* =========================================================================
 * vhms-extras-render.js
 * -------------------------------------------------------------------------
 * [PC2000 2026-10-10 — T13] Panel UI untuk sumber data tambahan PC2000:
 *   - `loadmap-panel`  : profil beban mesin (zona LUG) & torsi pompa (T8/T9)
 *   - `opava-panel`    : utilisasi, duty work/swing/travel, gerbang basi (T11)
 *   - `snapshot-panel` : daftar snapshot + kolom sensor STUCK (T10)
 *
 * Prinsip:
 *   - OPT-IN BY DATA: panel disembunyikan bila unit tidak punya sumbernya.
 *     Model lain (HD785/D375A) tidak akan melihat panel ini sama sekali.
 *   - Angka SELALU diberi satuan & catatan agar tidak disalahartikan
 *     (terutama torsi: sumbu Z BUKAN jam kalender — D4).
 *   - `esc()` dipakai untuk semua teks yang berasal dari berkas.
 * ========================================================================= */

(function (global) {
  'use strict';

  function esc(s) {
    var r = global.VHMS_RENDER;
    if (r && typeof r.esc === 'function') return r.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fx(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(d === undefined ? 2 : d);
  }

  function currentUnitId() {
    var app = global.VHMS_APP;
    return (app && typeof app.getCurrentUnitId === 'function') ? app.getCurrentUnitId() : null;
  }

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-11] VERDICT / HIPOTESIS per baris tabel load map.
   * ---------------------------------------------------------------------
   * Tujuan: memberi pembaca verdict singkat per rentang ("apa arti baris ini
   * dan apa yang perlu diperbaiki") + kolom Selisih terhadap ambang rujukan,
   * supaya tabel distribusi dapat langsung dipahami tanpa menafsir sendiri.
   *
   * Semua angka tetap MURNI bertumpu pada ambang yang sudah dipakai modul
   * analisis (VHMS_LOADMAP.*), bukan ambang baru yang mengada-ada.
   * --------------------------------------------------------------------- */

  /** Ambil batas BAWAH sebuah band dari label — mis. "- 160" → 160, "0 - 10" → 0. */
  function bandLowerBound(label) {
    var lm = global.VHMS_LOADMAP;
    if (lm && typeof lm.resolveBands === 'function') {
      try {
        var b = lm.resolveBands([String(label)])[0];
        if (b && b.lo !== null && b.lo !== undefined) return b.lo;
        if (b && b.hi !== null && b.hi !== undefined) return b.hi;
      } catch (e) { /* jatuh ke parser sederhana di bawah */ }
    }
    var m = String(label).match(/\d+(?:[.,]\d+)?/g);
    if (!m) return null;
    var first = Number(String(m[0]).replace(',', '.'));
    return isFinite(first) ? first : null;
  }

  /**
   * Verdict untuk satu baris DISTRIBUSI BEBAN BAHAN BAKAR (sumbu Y, mm³/st).
   * Selisih = share% − ambang rujukan% (LUG: rujukan 5 %).
   * @returns {{text:string, tone:string, diff:number|null, ref:number|null}}
   */
  function fuelRowVerdict(lo, share) {
    if (lo === null || lo === undefined) return { text: '—', tone: 'muted', diff: null, ref: null };
    if (lo >= 260) return { text: 'Beban sangat tinggi (≥260 mm³/st) — boros bahan bakar & beban termal tinggi.', tone: 'warn', diff: null, ref: null };
    if (lo >= 210) return { text: 'Beban tinggi sehat (≥210) — pembakaran bersih, wajar untuk unit kerja berat.', tone: 'ok', diff: null, ref: null };
    if (lo >= 160) {
      // LUG: rujukan <5 % dari total (share baris ini).
      var diff = (share === null || share === undefined) ? null : (share - 5);
      return {
        text: 'ZONA LUG (≥160 & rpm rendah) — paling merusak piston & turbo. Target <5 %.',
        tone: (share >= 10 ? 'crit' : (share >= 5 ? 'warn' : 'ok')),
        diff: diff, ref: 5
      };
    }
    if (lo >= 110) return { text: 'Beban menengah — normal, tidak merusak.', tone: 'muted', diff: null, ref: null };
    return { text: 'Idle / beban sangat ringan.', tone: 'muted', diff: null, ref: null };
  }

  /**
   * Verdict untuk satu band kolom DISTRIBUSI PUTARAN MESIN (sumbu X, rpm).
   * @returns {{text:string, tone:string}}
   */
  function rpmColVerdict(lo, share) {
    if (lo === null || lo === undefined) return { text: '—', tone: 'muted' };
    if (lo < 1000) return { text: 'Idle (rpm ≤1000) — pemborosan oli/bahan bakar bila berlebihan.', tone: (share >= 15 ? 'warn' : 'muted') };
    if (lo < 1600) return { text: 'Putaran kerja rendah — bila bertemu fuel tinggi = zona LUG (merusak).', tone: 'warn' };
    if (lo < 1900) return { text: 'Putaran kerja produktif — ideal untuk pembakaran bersih.', tone: 'ok' };
    return { text: 'Putaran tinggi — pastikan tidak >jendela operasi normal.', tone: 'muted' };
  }

  /**
   * Verdict untuk satu baris PERBANDINGAN TORSI per rentang.
   * Kolom Selisih (All − Work) sudah ada; verdict menjelaskan apa artinya.
   * @returns {{text:string, tone:string}}
   */
  function torqueRowVerdict(lo, deltaPct, allPct) {
    if (lo === null || lo === undefined) return { text: '—', tone: 'muted' };
    var d = (deltaPct === null || deltaPct === undefined) ? 0 : deltaPct;
    if (lo >= 3500) {
      if (d > 2) return { text: 'Torsi sangat tinggi & dominan NON-kerja (≥3500, Δ>2) — unit berat di swing/travel. Periksa pola operasi & tekanan hidrolik.', tone: 'warn' };
      return { text: 'Torsi sangat tinggi (≥3500 Nm) — stress struktur & hidrolik. Pantau.', tone: 'warn' };
    }
    if (lo >= 3000) {
      if (d > 2) return { text: 'Torsi tinggi dominan non-kerja (≥3000, Δ>2) — porsi swing/travel besar.', tone: 'warn' };
      return { text: 'Torsi tinggi produktif (≥3000 Nm) — wajar; mayoritas dari attachment.', tone: 'ok' };
    }
    if (lo >= 2500) return { text: 'Torsi menengah — normal.', tone: 'muted' };
    return { text: 'Torsi ringan — normal.', tone: 'muted' };
  }

  /**
   * Verdict untuk satu baris DISTRIBUSI TORSI (seluruh pompa).
   * @returns {{text:string, tone:string}}
   */
  function torqueDistVerdict(lo, share) {
    if (lo === null || lo === undefined) return { text: '—', tone: 'muted' };
    if (lo >= 3500) return { text: 'Torsi sangat tinggi (≥3500 Nm) — stress hidrolik; pastikan bukan karena menahan beban berlebih.', tone: 'warn' };
    if (lo >= 3000) return { text: 'Torsi tinggi (≥3000 Nm) — beban produktif, pantau bila >15 % waktu.', tone: (share >= 15 ? 'warn' : 'ok') };
    if (lo >= 2500) return { text: 'Torsi menengah — normal.', tone: 'muted' };
    return { text: 'Torsi ringan/idle — normal.', tone: 'muted' };
  }

  /** Sel untuk kolom "Result / Hipotesis" (diberi warna verdict). */
  function verdictCell(v) {
    var tone = v.tone || 'muted';
    var diffTxt = '';
    if (v.diff !== null && v.diff !== undefined && v.ref !== null && v.ref !== undefined) {
      var sign = v.diff >= 0 ? '+' : '−';
      diffTxt = '<div class="verdict-diff">vs ambang ' + v.ref + ' % → <strong>' +
        sign + fx(Math.abs(v.diff), 2) + ' %</strong></div>';
    }
    return '<td class="verdict-cell verdict-' + tone + '">' + esc(v.text) + diffTxt + '</td>';
  }

  /* -----------------------------------------------------------------------
   * [2026-10-12] VERDICT per PARAMETER snapshot rekaman.
   * ---------------------------------------------------------------------
   * Narasi & ambang diambil dari KAMUS `VHMS_SNAPSHOT_KNOWLEDGE` — pola yang
   * sama dengan KB VHMS (`vhms-knowledge.js`) dan KB SOS (`sos-knowledge.js`).
   * Modul ini TIDAK lagi menyimpan teks parameter secara inline, sehingga
   * kolom snapshot baru cukup ditambahkan ke kamus (satu sumber kebenaran).
   *
   * Urutan pemeriksaan (yang pertama cocok menang):
   *   1. STUCK     → sensor tidak bervariasi padahal harus mengikuti beban.
   *   2. Konstan    → seluruh rekaman satu nilai (rentang = 0).
   *   3. Zona       → LUG (fuel tinggi + rpm rendah) / idle.
   *   4. Bank EGT   → bank yang menjadi pemicu alarm.
   *   5. Sinyal     → kolom ON/OFF.
   *   6. Peran      → narasi dari `ROLE_KB` sesuai peran kolom.
   *   7. Tak dikenal→ `genericNarration` (tetap objektif, bukan teks kosong).
   * --------------------------------------------------------------------- */

  /** Ambil KB (bila modul kamus tersedia). */
  function snapKB() { return global.VHMS_SNAPSHOT_KNOWLEDGE || null; }

  /* -----------------------------------------------------------------------
   * [2026-10-12] Kamus DUTY MODE (`op_ava0`).
   * ---------------------------------------------------------------------
   * Berkas `op_ava0` hanya berisi kolom `Work (0-10)`, `Work (-20)`, dst.
   * tanpa penjelasan apa pun. Angka-angka itu TERLALU mudah disalahartikan:
   *   - dibaca sebagai potongan waktu (boleh dijumlahkan), padahal INTENSITAS;
   *   - "Work 73,9 %" disangka 73,9 % dari 24 jam.
   * Kamus ini menyediakan makna operasional tiap band + rujukan, sehingga
   * header dapat diberi tooltip & remark yang dapat dipertanggungjawabkan.
   * Rujukan & tafsiran: `docs/STATUS_PROYEK.md` §2.4 butir 5 (duty mode TIDAK
   * boleh dijumlahkan) dan §3.1 (kamus `METERS` belum ada — tiket O-1).
   * --------------------------------------------------------------------- */
  var DUTY_MODES_KB = {
    work: {
      label: 'Work', title: 'Attachment bekerja',
      desc: 'Boom / arm / bucket bergerak di bawah beban.',
      sensors: 'Boom Raise/Lower, Arm IN/OUT, Bucket Curl/Dump, Pump 1F/1R/2F/2R Press'
    },
    swing: {
      label: 'Swing', title: 'Rumah atas berputar',
      desc: 'Upper structure berputar (swing) — pola gali–angkat–putar–buang.',
      sensors: 'Swing RH/LH Pres (snapshot)'
    },
    travel: {
      label: 'Travel', title: 'Unit berpindah tempat',
      desc: 'Unit berjalan / berpindah posisi (travel), bukan pekerjaan loading.',
      sensors: 'Tekanan pump tinggi berkepanjangan + waktu (geometri travel tidak direkam)'
    }
  };

  /**
   * Makna tiap BAND per mode. Angka berkas = **% waktu jendela** yang
   * dihabiskan pada tingkat intensitas itu, dirata-rata atas jendela AKTIF
   * (Δmeter engine ≥ 0,5 jam).
   */
  var DUTY_BANDS_KB = {
    work: {
      '0-10': {
        label: 'Ringan',
        meaning: 'Attachment hampir tidak digerakkan bertenaga.',
        condition: 'Menganggur di depan; menunggu dump truck, operator, atau perbaikan kecil. Mesin menyala, hidrolik hampir tanpa beban.',
        read: 'Bila terus tinggi bersama utilisasi rendah → ini WAKTU MENUNGGU, bukan kerja.'
      },
      '10-20': {
        label: 'Menengah',
        meaning: 'Kerja terputus-putus.',
        condition: 'Gali beberapa detik lalu jeda — menunggu, atur posisi, ganti arah. Tipikal loading dengan jeda menunggu haul truck.',
        read: 'Normal untuk siklus loading.'
      },
      '>20': {
        label: 'Berat',
        meaning: 'Kerja kontinu.',
        condition: 'Menggali / meratakan tuntas dalam satu tarikan panjang tanpa jeda berarti; attachment aktif sebagian besar jendela.',
        read: 'Sehat bila total Work tinggi — pantau suhu oli hidrolik.'
      }
    },
    swing: {
      '0-10': { label: 'Ringan', meaning: 'Hampir tidak berputar.', condition: 'Unit menggali di satu titik tanpa memindahkan material.', read: 'Normal untuk stationary digging.' },
      '10-20': { label: 'Menengah', meaning: 'Berputar sesekali.', condition: 'Sebagian siklus memerlukan putaran — sebagian tidak.', read: 'Pola kerja berimbang.' },
      '>20': { label: 'Berat', meaning: 'Berputar teratur tiap siklus.', condition: 'Pola gali–angkat–putar–buang klasik excavator.', read: 'Sehat — bandingkan dengan konsumsi umur swing bearing/brake.' }
    },
    travel: {
      '0-10': { label: 'Ringan', meaning: 'Berpindah sesekali.', condition: 'Reposisi pendek di area kerja.', read: 'Normal untuk unit PC2000 (shot & go).' },
      '10-20': { label: 'Menengah', meaning: 'Berpindah beberapa kali.', condition: 'Front kerja berpindah beberapa kali per jendela.', read: 'Wajar bila front kerja berpindah.' },
      '>20': { label: 'Berat', meaning: 'Travel lintas area.', condition: 'Berjalan jauh / sering; bukan pekerjaan loading. Jalur berat untuk undercarriage.', read: 'Pantau undercarriage, final drive, suhu travel motor.' }
    }
  };

  /**
   * [O-1 2026-10-12] KAMUS METER `op_ava0` — untuk kolom SMR awal/akhir.
   *
   * Kolom `SMR0 / SMR / SMR1 / SMR2` pada berkas memakai nama yang nyaris
   * identik, sehingga mudah tertukar. Tertukar itu BERBAHAYA: `SMR0` (key-on)
   * selalu LEBIH BESAR dari `SMR` (engine), jadi memakai meter yang salah akan
   * melebih-lebihkan jam operasi dan mengacaukan RUL.
   *
   * KEJUJURAN SUMBER (aturan yang sama seperti threshold OEM):
   *   - `smr0` & `engine` → arti TERBUKTI dari berkas: `engine` cocok dengan
   *     SMR di header berkas serta panel Lifetime, dan `smr0 >= engine` pada
   *     hampir seluruh jendela (konsisten dengan key-on ⊇ engine-running).
   *   - `smr1` & `smr2` → arti **BELUM TERVERIFIKASI**. Keduanya TIDAK boleh
   *     dikarang. Fakta terukur: kumulatifnya MELAMPAUI jam engine, yang
   *     mustahil secara fisik bila per-jendela deltanya konsisten ≤ engine →
   *     meter pernah di-reset / ECU diganti. Karena itu nilai absolutnya tidak
   *     dipakai dan tidak ditampilkan (keputusan D5 pada modul `vhms-opava`).
   *
   * Field `verified: false` ADALAH bagian dari data, bukan catatan pinggir —
   * UI memakainya untuk menandai meter yang belum dapat dipertanggungjawabkan.
   */
  var METERS_KB = {
    smr0: {
      label: 'SMR0', title: 'Meter key-on',
      meaning: 'Jam kunci kontak pada posisi ON — termasuk saat mesin TIDAK menyala.',
      usedFor: 'Hanya untuk menghitung fraksi idle (ΔSMR0 − ΔSMR).',
      caution: 'Selalu ≥ SMR engine. JANGAN dipakai sebagai jam operasi.',
      verified: true,
      source: 'Terbukti dari berkas: smr0 >= engine pada hampir seluruh jendela.'
    },
    engine: {
      label: 'SMR', title: 'Meter engine running',
      meaning: 'Jam mesin benar-benar MENYALA. Ini acuan SMR resmi unit.',
      usedFor: 'SMR awal/akhir, Jam operasi, dan seluruh perhitungan umur komponen.',
      caution: 'Bukan jam kalender — unit bisa menganggur berhari-hari tanpa menambah SMR.',
      verified: true,
      source: 'Cocok dengan SMR pada header berkas VHMS dan panel Lifetime.'
    },
    smr1: {
      label: 'SMR1', title: 'Meter sekunder 1 — arti belum terverifikasi',
      meaning: 'BELUM TERVERIFIKASI. Arti kolom ini tidak dapat dibuktikan dari berkas maupun dokumen yang tersedia.',
      usedFor: 'Tidak dipakai. Nilai absolut sengaja tidak ditampilkan.',
      caution: 'Kumulatifnya melampaui jam engine (mustahil) → meter pernah di-reset / ECU diganti.',
      verified: false,
      source: 'Tidak ada sumber yang dapat diaudit. Jangan menafsirkan tanpa manual resmi.'
    },
    smr2: {
      label: 'SMR2', title: 'Meter sekunder 2 — arti belum terverifikasi',
      meaning: 'BELUM TERVERIFIKASI. Sama seperti SMR1.',
      usedFor: 'Tidak dipakai. Nilai absolut sengaja tidak ditampilkan.',
      caution: 'Kumulatifnya melampaui jam engine (mustahil) → meter pernah di-reset / ECU diganti.',
      verified: false,
      source: 'Tidak ada sumber yang dapat diaudit. Jangan menafsirkan tanpa manual resmi.'
    }
  };

  /**
   * Tooltip untuk satu meter. `extra` ditempel di baris pertama bila diberikan
   * (mis. menyebut jendela mana yang dipakai).
   */
  function meterTip(key, extra) {
    var m = METERS_KB[key];
    if (!m) return extra || '';
    var out = m.label + ' — ' + m.title + '\n' + m.meaning;
    if (extra) out += '\n' + extra;
    out += '\nDipakai untuk: ' + m.usedFor +
      '\n⚠ ' + m.caution +
      '\nSumber: ' + m.source;
    return out;
  }

  /** Ambang yang BENAR-benar dipakai modul op_ava (bukan angka baru). */
  var DUTY_THRESHOLDS = { activeMinHours: 0.5, staleGapDays: 7, recentWindowCount: 20 };
  (function () {
    var op = global.VHMS_OPAVA;
    if (!op) return;
    if (op.ACTIVE_MIN_HOURS !== undefined) DUTY_THRESHOLDS.activeMinHours = op.ACTIVE_MIN_HOURS;
    if (op.STALE_GAP_DAYS !== undefined) DUTY_THRESHOLDS.staleGapDays = op.STALE_GAP_DAYS;
    if (op.RECENT_WINDOW_COUNT !== undefined) DUTY_THRESHOLDS.recentWindowCount = op.RECENT_WINDOW_COUNT;
  })();

  /** Teks tooltip untuk satu SEL band (mode + band). */
  function dutyBandTip(mode, band) {
    var mk = DUTY_MODES_KB[mode] || {};
    var bk = (DUTY_BANDS_KB[mode] || {})[band];
    if (!bk) return '';
    return mk.label + ' ' + band.replace('-', '–') + ' % — ' + bk.label + '\n' +
      bk.meaning + '\n' +
      'Kondisi: ' + bk.condition + '\n' +
      'Baca: ' + bk.read;
  }

  /** Teks tooltip untuk satu kolom (semua mode) pada band tertentu. */
  function dutyColumnTip(band) {
    var parts = [];
    ['work', 'swing', 'travel'].forEach(function (m) {
      var bk = (DUTY_BANDS_KB[m] || {})[band];
      if (bk) parts.push((DUTY_MODES_KB[m] || {}).label + ': ' + bk.label + ' — ' + bk.meaning);
    });
    return 'Intensitas ' + band.replace('-', '–') + ' % (persentase WAKTU jendela)\n' +
      parts.join('\n') +
      '\n⚠ Intensitas, bukan potongan waktu — jangan dijumlahkan antar-mode.';
  }

  /** Ganti token {placeholder} pada teks KB. */
  function fillTemplate(tpl, data) {
    return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, function (m, name) {
      var v = data[name];
      return (v === undefined || v === null) ? m : String(v);
    });
  }

  /** Klasifikasi sebuah kolom snapshot → { text, tone, diff, ref, refs }. */
  function snapshotParamVerdict(name, p, stuckMap, ctx) {
    p = p || {};
    ctx = ctx || {};
    var KB = snapKB();
    var info = KB ? KB.dimensionFor(name) : null;
    var role = KB ? KB.roleFor(name) : null;
    var def = info ? info.def : null;
    var dim = info ? info.dim : null;
    var unit = p.unit || (dim && dim.unit) || '';

    var stuck = p.stuck || (stuckMap && stuckMap[name]) || null;
    var rng = (p.range === null || p.range === undefined) ? null : p.range;
    var avg = (p.avg === null || p.avg === undefined) ? null : p.avg;
    var last = (p.last === null || p.last === undefined) ? null : p.last;

    // Data untuk template KB.
    var T = (KB && KB.THRESHOLDS) || {};
    var tplData = {
      val: fx(last) + (unit ? ' ' + unit : ''),
      range: fx(rng), unit: unit,
      bank: (def && def.bank) || '—',
      group: (def && def.cylinderGroup) || '',
      system: (def && def.system) || name,
      pct: (avg === null) ? '0' : fx(avg * 100, 0),
      lugFuel: T.lugFuelMin, lugRpm: T.lugRpmMax, idleRpm: T.idleRpmMax
    };

    // --- 1. STUCK (bukti terkuat sensor rusak) ---
    if (stuck) {
      var isWeak = typeof stuck === 'object' ? !!stuck.weak : false;
      return {
        text: (isWeak
          ? 'Tidak bervariasi (bukti lemah) — boleh wajar secara fisika, periksa hanya bila ada gejala lain.'
          : 'Tidak bervariasi (STUCK) padahal harus mengikuti beban mesin — ' +
            'indikasi sensor rusak; nilai kolom ini tidak layak dipercaya.'),
        tone: (isWeak ? 'warn' : 'crit'), diff: null, ref: null,
        refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
      };
    }

    // --- 2. Konstan sempurna (rentang = 0) ---
    var ambientish = role === 'ambient' || role === 'thermal' || role === 'status' ||
      role === 'time' || role === 'valve';
    if (rng === 0) {
      var konstTxt = (role === 'ambient')
        ? 'Konstan ' + tplData.val + ' sepanjang rekaman — NORMAL: kolom ini bukan indikator beban mesin.'
        : 'Konstan ' + tplData.val + ' sepanjang rekaman — tidak mengikuti beban mesin' +
          (ambientish ? '.' : '; periksa bila ada gejala lain.');
      return {
        text: konstTxt,
        tone: 'muted', diff: null, ref: null,
        refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
      };
    }

    // --- 3. Zona LUG / idle (butuh konteks fuel & rpm) ---
    var fuel = (typeof ctx.fuel === 'number') ? ctx.fuel : null;
    var rpm = (typeof ctx.rpm === 'number') ? ctx.rpm : null;
    if (fuel !== null && rpm !== null) {
      if (role === 'fuel' && avg !== null && avg >= T.lugFuelMin && rpm <= T.lugRpmMax) {
        return {
          text: 'Beban bahan bakar tinggi (' + fx(avg, 1) + ' mm³/st) pada putaran rendah (' +
            fx(rpm, 0) + ' rpm) = ZONA LUG — momen paling merusak piston & turbo.',
          tone: 'crit', diff: null, ref: null,
          refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
        };
      }
      if (role === 'speed' && avg !== null && avg <= T.idleRpmMax) {
        return {
          text: 'Putaran mesin rendah (rata² ' + fx(avg, 0) + ' rpm ≤ idle ' + T.idleRpmMax +
            ') — operasi idle/ringan; pemborosan bahan bakar bila berlebihan.',
          tone: 'muted', diff: null, ref: null,
          refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
        };
      }
    }

    // --- 4. Bank EGT yang menjadi pemicu alarm ---
    if (role === 'egt' && ctx.triggerBanks && ctx.triggerBanks.length) {
      var nk = KB ? KB.normKey(name) : String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (ctx.triggerBanks.indexOf(nk) >= 0) {
        return {
          text: 'Bank kiri pemicu alarm — suhu puncak ' + fx(p.max, 0) + ' degC; ' +
            'selidiki apakah sensor atau overheating sungguhan.',
          tone: 'warn', diff: null, ref: null,
          refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
        };
      }
      return {
        text: 'Bank ini mendekati nilai pemicu — bandingkan kondisi LH dengan RH.',
        tone: 'warn', diff: null, ref: null,
        refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
      };
    }

    // --- 5. Kolom sinyal ON/OFF ---
    if ((KB && KB.isSignalColumn(name)) || role === 'signal') {
      var onPct = (avg === null) ? 0 : avg * 100;
      var txt = (onPct > 0)
        ? fillTemplate((KB && KB.SIGNAL_KB.on) || 'Kontak aktif {pct} % waktu rekaman.', tplData)
        : ((KB && KB.SIGNAL_KB.off) || 'Kontak tidak aktif selama rekaman.');
      return { text: txt, tone: 'muted', diff: null, ref: null, refs: [], note: '' };
    }

    // --- 6. Narasi dari kamus peran ---
    var roleKB = (KB && KB.ROLE_KB && KB.ROLE_KB[role]) || null;
    if (roleKB) {
      // Pilih nada: 'ok' bila bergerak lebar, 'warn' bila sempit.
      var hasMotion = (rng !== null && avg !== null && Math.abs(rng) >= Math.max(1e-9, Math.abs(avg) * 0.05));
      var tone = hasMotion ? 'ok' : 'warn';
      var tpl = roleKB[tone] || roleKB.ok || roleKB.warn;
      var text = tpl ? fillTemplate(tpl, tplData) : null;
      if (!text) {
        // Peran tanpa narasi (mis. status/time): pakai generik bila bergerak.
        var g = (KB && KB.GENERIC_KB && (hasMotion ? KB.GENERIC_KB.ok : KB.GENERIC_KB.none)) ||
          'Bervariasi normal selama rekaman.';
        text = fillTemplate(g, tplData);
      }
      return {
        text: text, tone: tone, diff: null, ref: null,
        refs: info ? (dim.refs || []).slice() : [],
        note: roleKB.note || (dim && dim.note) || ''
      };
    }

    // --- 7. Kolom tak dikenal: tetap objektif ---
    var gen = (KB && KB.genericNarration) ? KB.genericNarration(p)
      : { text: 'Bervariasi normal selama rekaman — tidak ada indikasi gangguan.', tone: 'muted' };
    return {
      text: gen.text, tone: gen.tone, diff: null, ref: null,
      refs: info ? (dim.refs || []).slice() : [], note: (dim && dim.note) || ''
    };
  }

  /** Sel untuk kolom "Selisih" numerik (selisih vs ambang rujukan). */
  function diffCell(v) {
    if (v.diff === null || v.diff === undefined || v.ref === null || v.ref === undefined) {
      return '<td class="num mono verdict-none">—</td>';
    }
    var over = v.diff > 0;
    var sign = v.diff >= 0 ? '+' : '−';
    var cls = v.diff === 0 ? 'verdict-none' : (over ? 'verdict-over' : 'verdict-under');
    return '<td class="num mono ' + cls + '" title="' + esc('Ambang rujukan ' + v.ref + ' %') + '">' +
      sign + fx(Math.abs(v.diff), 2) + ' %</td>';
  }

  /* -----------------------------------------------------------------------
   * 1. Panel LOAD MAP (T8 + T9)
   * --------------------------------------------------------------------- */
  function renderLoadMapPanel() {
    var box = document.getElementById('loadmap-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, lm = global.VHMS_LOADMAP;
    var id = currentUnitId();
    if (!store || !id || !lm || typeof store.getLoadMap !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var data = store.getLoadMap(id);
    if (!data || !data.engineLoad && !data.torqueAll && !data.torqueWork) {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-gauge-high" style="color:#0ea5e9"></i> Profil Pembebanan (Load Map)</h2>';
    html += '<p class="panel-sub">Distribusi waktu operasi menurut beban. ' +
      'Nilai dinyatakan sebagai <strong>persentase waktu</strong>, bukan jam — ' +
      'sumbu waktu berkas load map TIDAK dapat dipetakan ke jam kalender.</p>';

    // [T13-rev3] STRUKTUR BERSARANG sesuai permintaan:
    //   Setiap GRUP = kartu utuh (judul + legenda + kartu statistik) DI ATAS,
    //   lalu TABEL-TABELNYA berdampingan LH|RH DI BAWAHNYA.
    //   Grup 1 (atas)  : Beban Mesin  → tabel Y (kiri) + tabel X (kanan)
    //   Grup 2 (bawah) : Beban Torsi  → tabel torsi + tabel distribusi
    // Cara ini menghemat tinggi sekaligus menjaga konteks: kartu ringkasan
    // selalu penuh satu baris, detail tabel dipasangkan dua-dua.
    html += '<div class="extras-stack">';

    // ================= GRUP 1: BEBAN MESIN (fuel × rpm) =================
    var e = data.engineLoad;
    var z = (e && e.zones) ? e.zones : null;
    html += '<div class="extras-group">';
    html += '<div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-fire-flame-curved"></i> Beban Mesin (fuel × rpm)</h3>';
    html += '<p class="extras-legend">' +
      'Legenda zona: <span class="lg-r">LUG</span> = fuel ≥160 mm³/st pada rpm ≤1600 ' +
      '(paling merusak piston &amp; turbo) — target &lt;5 %. ' +
      '<span class="lg-g">High-power</span> = fuel ≥210 mm³/st, rpm &gt;1600 (pembakaran bersih). ' +
      'Idle = rpm ≤1000. Semua nilai = <strong>% waktu</strong>.</p>';
    if (z) {
      html += '<div class="extras-stat-grid">';
      html += statCard('Zona LUG', fx(z.lugShare), '%',
        'fuel ≥160 mm³/st pada rpm ≤1600 — zona paling merusak piston & turbo. ' +
        'Referensi: &lt;5 % normal, &gt;10 % perlu perhatian.',
        z.lugShare >= 10 ? 'crit' : (z.lugShare >= 5 ? 'warn' : 'ok'));
      html += statCard('High-power sehat', fx(z.highPowerShare), '%',
        'fuel ≥210 mm³/st pada rpm &gt;1600 — kapasitas penuh, pembakaran bersih.', 'ok');
      html += statCard('Idle', fx(z.idleShare), '%', 'rpm ≤1000.', 'ok');
      html += statCard('Beban bahan bakar tinggi', fx(z.highFuelShare), '%',
        'fuel ≥210 mm³/st (semua rpm).', 'ok');
      html += '</div>';
    } else {
      html += '<p class="extras-legend">Beban mesin (fuel × rpm) tidak tersedia pada unit ini.</p>';
    }
    html += '</div>';   // /extras-block — KARTU UTUH di ATAS

    // Dua tabel distribusi DITUMPUK VERTIKAL (bukan berdampingan) karena
    // kini memuat kolom "Result / Hipotesis" yang butuh lebar — bila
    // dijejerkan, teks verdict akan terpotong di layar.
    if (e && e.distribution) {
      html += '<div class="extras-duo extras-duo--stack">';
      html += '<div class="extras-col">' +
        distTable('Distribusi per beban bahan bakar (sumbu Y)', e.distribution.rows, 'mm³/st', fuelRowVerdict) +
        '</div>';
      html += '<div class="extras-col">' +
        distTable('Distribusi per putaran mesin (sumbu X)', e.distribution.cols, 'rpm', rpmColVerdict) +
        '</div>';
      html += '</div>';   // /extras-duo
    }
    html += '</div>';   // /extras-group (Beban Mesin)

    // ================= GRUP 2: BEBAN TORSI POMPA =================
    var a = data.torqueAll, w = data.torqueWork, d = data.torqueDelta;
    html += '<div class="extras-group" style="margin-top:16px">';
    html += '<div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-oil-can"></i> Beban Torsi Pompa</h3>';
    html += '<p class="extras-legend">' +
      '<strong>All Pump</strong> = kerja + swing + travel + fan. ' +
      '<strong>Work Pump</strong> = attachment saja. ' +
      'Kolom <strong>Selisih</strong> = All − Work → beban <span class="lg-y">non-kerja</span> ' +
      '(swing/travel/fan). Selisih besar (≥15 %) menandakan unit berat di swing. ' +
      'Nilai = <strong>% waktu</strong>, bukan jam.</p>';
    if (a || w || d) {
      html += '<div class="extras-stat-grid">';
      if (a && a.zones) {
        html += statCard('Seluruh pompa ≥3000 Nm', fx(a.zones.highTorqueShare), '%',
          'Semua pompa (kerja + swing + travel + fan).', 'ok');
      }
      if (w && w.zones) {
        html += statCard('Pompa kerja ≥3000 Nm', fx(w.zones.highTorqueShare), '%',
          'Hanya pompa attachment.', 'ok');
      }
      if (d) {
        html += statCard('Beban NON-kerja ≥3000 Nm', fx(d.nonWorkHighTorque), '%',
          'Selisih all − work = swing + travel + pompa fan. Tinggi = unit berat di swing/travel.',
          d.nonWorkHighTorque >= 15 ? 'warn' : 'ok');
      }
      html += '</div>';
    } else {
      html += '<p class="extras-legend">Beban torsi pompa tidak tersedia pada unit ini.</p>';
    }
    html += '</div>';   // /extras-block — KARTU UTUH di ATAS

    // Dua tabel DITUMPUK VERTIKAL (perbandingan torsi + distribusi torsi)
    // karena kolom "Result / Hipotesis" butuh lebar penuh.
    var hasTbl = (d && d.perRow && d.perRow.length) || (a && a.distribution);
    if (hasTbl) {
      html += '<div class="extras-duo extras-duo--stack">';
      html += '<div class="extras-col">';
      if (d && d.perRow && d.perRow.length) {
        html += '<h4 class="extras-sub">Perbandingan torsi per rentang (RH − LH)</h4>';
        html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
          '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2">' +
          '<col class="c-diff"><col class="c-verdict"></colgroup>' +
          '<thead><tr>' +
          '<th scope="col">Torsi (Nm)</th>' +
          '<th class="num" scope="col">All Pump</th>' +
          '<th class="num" scope="col">Work Pump</th>' +
          '<th class="num" scope="col">Selisih (non-kerja)</th>' +
          '<th scope="col">Result / Hipotesis</th>' +
          '</tr></thead><tbody>';
        d.perRow.forEach(function (r) {
          var cls = r.deltaPct > 2 ? ' style="color:#f59e0b;font-weight:600"' : '';
          var lo = bandLowerBound(r.label);
          var v = torqueRowVerdict(lo, r.deltaPct, r.allPct);
          html += '<tr><td>' + esc(r.label) + '</td>' +
            '<td class="num">' + fx(r.allPct) + ' %</td>' +
            '<td class="num">' + fx(r.workPct) + ' %</td>' +
            '<td class="num mono"' + cls + '>' + (r.deltaPct >= 0 ? '+' : '−') + fx(Math.abs(r.deltaPct)) + ' %</td>' +
            verdictCell(v) + '</tr>';
        });
        html += '</tbody></table></div>';
      }
      html += '</div>';
      html += '<div class="extras-col">';
      if (a && a.distribution) {
        html += distTable('Distribusi torsi — SELURUH pompa', a.distribution.rows, 'Nm', torqueDistVerdict);
      }
      html += '</div>';
      html += '</div>';   // /extras-duo
    }
    html += '</div>';   // /extras-group (Beban Torsi)
    html += '</div>';   // /extras-stack

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  function statCard(label, value, unit, note, sev) {
    var cls = sev === 'crit' ? 'extras-card crit' : (sev === 'warn' ? 'extras-card warn' : 'extras-card');
    return '<div class="' + cls + '">' +
      '<div class="extras-card-label">' + esc(label) + '</div>' +
      '<div class="extras-card-value">' + value + '<span class="extras-card-unit">' + esc(unit) + '</span></div>' +
      (note ? '<div class="extras-card-note">' + note + '</div>' : '') +
      '</div>';
  }

  /**
   * [FITUR 2026-10-11] Tabel distribusi dengan kolom tambahan di sisi kanan:
   *   Rentang | Nilai | Bagian | Selisih | Result / Hipotesis
   * `verdictFn(lo, share)` mengembalikan verdict per baris; bila tidak
   * diberikan, kolom tambahan tetap muncul namun berisi "—" (jaga bentuk).
   */
  function distTable(title, rows, unit, verdictFn) {
    if (!rows || !rows.length) return '';
    var showDiff = !!verdictFn;
    // <colgroup> lebar tetap agar header sumbu X & Y sejajar antar tabel.
    var colgroup = '<colgroup>' +
      '<col class="c-axis"><col class="c-v1"><col class="c-v2">' +
      (showDiff ? '<col class="c-diff">' : '') +
      '<col class="c-verdict">' +
      '</colgroup>';
    var html = '<h4 class="extras-sub">' + esc(title) + '</h4>' +
      '<div class="clutch-heat-wrap"><table class="data extras-table">' + colgroup + '<thead><tr>' +
      '<th scope="col">Rentang (' + esc(unit) + ')</th>' +
      '<th class="num" scope="col">Nilai</th>' +
      '<th class="num" scope="col">Bagian</th>' +
      (showDiff ? '<th class="num" scope="col">Selisih</th>' : '') +
      '<th scope="col">Result / Hipotesis</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      if (!r.value) return;
      var lo = bandLowerBound(r.label);
      var v = verdictFn ? verdictFn(lo, r.share) : { text: '—', tone: 'muted', diff: null, ref: null };
      html += '<tr><td>' + esc(r.label) + '</td><td class="num">' + Math.round(r.value) + '</td>' +
        '<td class="num">' + fx(r.share) + ' %</td>' +
        (showDiff ? diffCell(v) : '') +
        verdictCell(v) + '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  /* -----------------------------------------------------------------------
   * 2. Panel OPERATING AVAILABILITY (T11)
   * --------------------------------------------------------------------- */

  /* [FITUR 2026-10-11] State filter rentang tanggal untuk panel Oper. Avail.
   * from/to = 'YYYY-MM-DD' (hari kalender, inklusif) atau '' (tanpa batas).
   * Per-unit: direset saat unit berganti agar tidak nyangkut. */
  var opavaState = { unitId: null, from: '', to: '' };

  /** Konversi 'YYYY-MM-DD' (hari lokal) → epoch detik (awal/akhir hari). */
  function dayInputToEpoch(day, edge) {
    if (!day) return null;
    var p = String(day).split('-');
    if (p.length !== 3) return null;
    var y = Number(p[0]), mo = Number(p[1]), d = Number(p[2]);
    if (!isFinite(y) || !isFinite(mo) || !isFinite(d)) return null;
    // edge='start' → 00:00 lokal; edge='end' → 23:59:59 lokal.
    var dt = (edge === 'end')
      ? new Date(y, mo - 1, d, 23, 59, 59)
      : new Date(y, mo - 1, d, 0, 0, 0);
    if (isNaN(dt.getTime())) return null;
    return Math.floor(dt.getTime() / 1000);
  }

  /** Epoch detik → 'YYYY-MM-DD' (hari lokal) untuk nilai <input type="date">. */
  function epochToDayInput(epoch) {
    if (epoch === null || epoch === undefined) return '';
    var dt = new Date(epoch * 1000);
    if (isNaN(dt.getTime())) return '';
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate());
  }

  function renderOpAvaPanel() {
    var box = document.getElementById('opava-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, op = global.VHMS_OPAVA;
    var id = currentUnitId();
    if (!store || !id || !op || typeof store.getOpAva !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var res = store.getOpAva(id);
    if (!res || !res.summary) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    // [FITUR 2026-10-11] Reset filter tanggal saat unit berganti.
    if (opavaState.unitId !== id) { opavaState.unitId = id; opavaState.from = ''; opavaState.to = ''; }

    // Rentang tanggal paling luas dari data (untuk batas input & placeholder).
    var allW = res.windows || [];
    var dataMinEpoch = allW.length ? allW[0].fromEpoch : null;
    var dataMaxEpoch = allW.length ? (allW[allW.length - 1].toEpoch || allW[allW.length - 1].fromEpoch) : null;

    // Terapkan filter tanggal (jendela yang tumpang-tindih dengan rentang).
    var fromEpoch = dayInputToEpoch(opavaState.from, 'start');
    var toEpoch = dayInputToEpoch(opavaState.to, 'end');
    var filtered = allW;
    if (fromEpoch !== null || toEpoch !== null) {
      filtered = allW.filter(function (w) {
        var wFrom = w.fromEpoch;
        var wTo = w.toEpoch || w.fromEpoch;
        if (fromEpoch !== null && wTo < fromEpoch) return false;
        if (toEpoch !== null && wFrom > toEpoch) return false;
        return true;
      });
    }
    var isFiltered = (filtered.length !== allW.length);

    // Hitung ulang ringkasan atas subset (fungsi summarize modul dipakai ulang).
    var s;
    if (isFiltered) {
      var summ = op && typeof op.summarize === 'function' ? op.summarize.bind(op) : global.VHMS_OPAVA.summarize;
      s = summ(filtered, res.meta, { headerSmr: res.meta ? res.meta.smrHeader : null });
    } else {
      s = res.summary;
    }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-clock" style="color:#22c55e"></i> Utilisasi & Duty Mode (Operating Availability)</h2>';
    html += '<p class="panel-sub">Ringkasan ' + s.windowCount + ' jendela kerja (' +
      s.activeWindowCount + ' aktif) dari ' + fx(s.spanDays, 0) + ' hari' +
      (isFiltered ? ' <span class="u-text-mute">(terfilter dari ' + allW.length + ' jendela)</span>' : '') + '.</p>';

    // [FITUR 2026-10-11] Kontrol FILTER RENTANG TANGGAL CUSTOM.
    html += '<div class="opava-filter">' +
      '<span class="opava-filter-label"><i class="fa-solid fa-calendar-days"></i> Rentang tanggal:</span>' +
      '<label class="opava-date"><span>Dari</span>' +
        '<span class="opava-date-wrap">' +
          '<input type="date" class="opava-date-input" data-opava-range="from" ' +
            'min="' + esc(epochToDayInput(dataMinEpoch)) + '" max="' + esc(epochToDayInput(dataMaxEpoch)) + '" ' +
            'value="' + esc(opavaState.from) + '" aria-label="Tanggal awal rentang data">' +
          '<button type="button" class="opava-date-btn" data-opava-open="from" ' +
            'title="Buka kalender" aria-label="Buka kalender tanggal awal">' +
            '<i class="fa-solid fa-calendar-days"></i></button></span></label>' +
      '<label class="opava-date"><span>s/d</span>' +
        '<span class="opava-date-wrap">' +
          '<input type="date" class="opava-date-input" data-opava-range="to" ' +
            'min="' + esc(epochToDayInput(dataMinEpoch)) + '" max="' + esc(epochToDayInput(dataMaxEpoch)) + '" ' +
            'value="' + esc(opavaState.to) + '" aria-label="Tanggal akhir rentang data">' +
          '<button type="button" class="opava-date-btn" data-opava-open="to" ' +
            'title="Buka kalender" aria-label="Buka kalender tanggal akhir">' +
            '<i class="fa-solid fa-calendar-days"></i></button></span></label>' +
      '<button class="btn btn-ghost btn-sm opava-quick" data-opava-quick="30" title="30 hari terakhir">30h</button>' +
      '<button class="btn btn-ghost btn-sm opava-quick" data-opava-quick="90" title="90 hari terakhir">90h</button>' +
      '<button class="btn btn-ghost btn-sm opava-quick" data-opava-quick="all" title="Seluruh data">Semua</button>' +
      (isFiltered ? '<button class="btn btn-ghost btn-sm opava-quick" data-opava-quick="reset"><i class="fa-solid fa-xmark"></i> Reset</button>' : '') +
      '</div>';

    // Bila filter tidak menyisakan jendela, hentikan dengan pesan yang jelas.
    if (!filtered.length) {
      html += '<p class="extras-legend">Tidak ada jendela kerja pada rentang tanggal yang dipilih. ' +
        'Perlebar rentang atau tekan <strong>Semua</strong>.</p>';
      box.innerHTML = html;
      box.classList.remove('hidden');
      return;
    }

    // Gerbang kebasian (D7) — label menonjol, skor tidak diubah.
    if (s.staleGaps && s.staleGaps.length) {
      html += '<p class="clutch-note" style="border-color:#f59e0b;background:rgba(245,158,11,.12)">' +
        '<i class="fa-solid fa-triangle-exclamation"></i> <strong>Data tidak mutakhir.</strong> ' +
        s.staleGaps.length + ' celah data &gt; 7 hari (terbesar ' + fx(s.maxGapDays, 1) + ' hari). ' +
        'Analisis mencerminkan kondisi lampau — utamakan utilisasi terkini di bawah.</p>';
    }

    html += '<div class="extras-stat-grid">';
    html += statCard('Utilisasi keseluruhan', fx(s.utilizationOverall, 1), 'jam/hari',
      'Rata-rata sepanjang ' + fx(s.spanDays, 0) + ' hari.', 'ok');
    html += statCard('Utilisasi terkini', fx(s.utilizationRecent, 1), 'jam/hari',
      'Rata-rata 20 jendela terakhir — kondisi sekarang.', 'ok');
    html += statCard('Fraksi idle', s.idleRatio === null ? '—' : fx(s.idleRatio * 100, 1), '%',
      'Waktu key-on tanpa engine menyala.', 'ok');
    if (s.heavyWorkShare !== null) {
      html += statCard('Kerja berat', fx(s.heavyWorkShare, 1), '% dari waktu kerja',
        'Proporsi Work &gt;20 %.', 'ok');
    }
    html += '</div>';

    html += '<h4 class="extras-sub">Duty mode (rata-rata jendela aktif)</h4>';
    // [2026-10-12] KETERANGAN HEADER — supaya angka persen tidak salah dibaca
    // sebagai bagian dari waktu total. Tiga kolom kiri = INTENSITAS beban
    // (0–10 / 10–20 / >20 %), BUKAN potongan waktu yang boleh dijumlahkan
    // antar-baris. Setiap sel header diberi tooltip berisi KONDISI lapangan
    // (lihat `DUTY_BANDS_KB`); remark di bawah merangkum maknanya.
    html += '<div class="extras-legend">' +
      'Tiap <strong>mode</strong> dipecah menurut <strong>intensitas</strong> kejadiannya — ' +
      'angkanya = <strong>persentase waktu jendela</strong> pada tingkat intensitas itu ' +
      '(rata-rata jendela aktif, Δmeter engine ≥ ' + fx(DUTY_THRESHOLDS.activeMinHours, 1) + ' jam):<br>' +
      '<span class="lg-b">0–10 % Ringan</span> = attachment hampir tidak digerakkan bertenaga / ' +
      'berputar sesekali — <em>waktu menunggu bila bersama utilisasi rendah</em>. ' +
      '<span class="lg-b">10–20 % Menengah</span> = kerja terputus-putus (gali lalu jeda) — ' +
      'tipikal siklus <em>loading</em>. ' +
      '<span class="lg-b">&gt;20 % Berat</span> = kerja kontinu dalam satu tarikan panjang.<br>' +
      '<strong>Total</strong> = jumlah ketiga kolom. ⚠ <strong>Tidak</strong> dijumlahkan ' +
      'antar-mode (Work + Swing + Travel) karena ketiganya bisa berlangsung <em>bersamaan</em>. ' +
      'Arahkan kursor ke judul kolom untuk melihat kondisi tiap mode. ' +
      'Kolom <strong>SMR awal/akhir &amp; Jam operasi</strong> berlaku untuk seluruh ' +
      'rentang tanggal terpilih — sama untuk semua baris.</div>';
    // [2026-10-12] Kolom SMR awal / SMR akhir / Jam operasi pada RENTANG
    // terpilih, diletakkan di SAMPING KANAN kolom Mode. Nilainya berlaku
    // untuk SELURUH tabel (bukan per-baris mode), karena SMR tidak dipecah
    // per mode — itu keterangan konteks rentang, bukan data per mode.
    // `colspan` membuat satu nilai membentang tanpa mengulang angka.
    var hasRange = (s.meterStart !== null && s.meterStart !== undefined) ||
      (s.meterEnd !== null && s.meterEnd !== undefined);
    // Tooltip kolom rentang: SEBUT meter yang dipakai (engine, bukan key-on).
    // [O-1 2026-10-12] Teks tooltip kini DITURUNKAN dari `METERS_KB` lewat
    // `meterTip()`, bukan ditulis ulang di sini. Satu sumber kebenaran: bila
    // arti meter dikoreksi, ketiga tooltip + kartu keterangan ikut berubah.
    var tipStart = meterTip('engine', 'SMR awal = nilai meter ini pada jendela PERTAMA rentang terpilih.');
    var tipEnd = meterTip('engine', 'SMR akhir = nilai meter ini pada jendela TERAKHIR rentang terpilih.');
    var tipHours = 'Jam operasi = SMR akhir − SMR awal (jam mesin MENYALA, bukan durasi kalender).\n' +
      'Selalu konsisten dengan kartu "Utilisasi keseluruhan" di atas.\n' +
      'Meter yang dipakai: ' + METERS_KB.engine.label + ' (' + METERS_KB.engine.title + ').';
    html += '<div class="clutch-heat-wrap"><table class="data extras-table extras-table--duty"><thead>' +
      // Baris 1: keterangan tiap header (remark informatif + tooltip).
      '<tr class="duty-hint-row">' +
      '<th scope="col"><span class="duty-hint">Mode operasi</span></th>' +
      '<th scope="col"><span class="duty-hint">Ringan</span></th>' +
      '<th scope="col"><span class="duty-hint">Menengah</span></th>' +
      '<th scope="col"><span class="duty-hint">Berat</span></th>' +
      '<th scope="col"><span class="duty-hint">Ringan+Menengah+Berat</span></th>' +
      (hasRange ? '<th class="num" scope="col"><span class="duty-hint">' + esc(METERS_KB.engine.label) + ' · engine</span></th>' +
        '<th class="num" scope="col"><span class="duty-hint">' + esc(METERS_KB.engine.label) + ' · engine</span></th>' +
        '<th class="num" scope="col"><span class="duty-hint">SMR akhir − SMR awal</span></th>' : '') +
      '</tr>' +
      // Baris 2: nama kolom + tooltip rinci per band.
      '<tr>' +
      '<th scope="col">Mode</th>' +
      '<th scope="col" title="' + esc(dutyColumnTip('0-10')) + '">0–10 %</th>' +
      '<th scope="col" title="' + esc(dutyColumnTip('10-20')) + '">10–20 %</th>' +
      '<th scope="col" title="' + esc(dutyColumnTip('>20')) + '">&gt;20 %</th>' +
      '<th scope="col" title="' + esc('Jumlah ketiga kolom intensitas = berapa % waktu jendela mode ini terjadi.\n' +
        '⚠ Tidak dijumlahkan antar-mode: Work + Swing + Travel bisa berlangsung bersamaan.') + '">Total</th>' +
      (hasRange ? '<th class="num" scope="col" title="' + esc(tipStart) + '">SMR awal</th>' +
        '<th class="num" scope="col" title="' + esc(tipEnd) + '">SMR akhir</th>' +
        '<th class="num" scope="col" title="' + esc(tipHours) + '">Jam operasi</th>' : '') +
      '</tr></thead><tbody>';
    var modeRows = ['work', 'swing', 'travel'].filter(function (m) { return !!s.duty[m]; });
    modeRows.forEach(function (m, idx) {
      var dd = s.duty[m];
      var mk = DUTY_MODES_KB[m] || {};
      var modeTip = mk.title + ' — ' + mk.desc + '\nIndikator di snapshot: ' + mk.sensors;
      html += '<tr><td title="' + esc(modeTip) + '"><strong>' + esc(dd.label) + '</strong></td>' +
        '<td title="' + esc(dutyBandTip(m, '0-10')) + '">' + fx(dd.bands[0], 1) + '</td>' +
        '<td title="' + esc(dutyBandTip(m, '10-20')) + '">' + fx(dd.bands[1], 1) + '</td>' +
        '<td title="' + esc(dutyBandTip(m, '>20')) + '">' + fx(dd.bands[2], 1) + '</td>' +
        '<td title="' + esc('Total ' + mk.label + ' = ' + fx(dd.total, 1) + ' % waktu jendela.\n' +
          'Ringan + Menengah + Berat. Tidak dijumlahkan dengan mode lain.') + '">' +
        '<strong>' + fx(dd.total, 1) + ' %</strong></td>';
      // Sel rentang hanya ditulis pada baris PERTAMA, lalu di-rowspan.
      if (hasRange && idx === 0) {
        var rs = modeRows.length > 1 ? ' rowspan="' + modeRows.length + '"' : '';
        html += '<td class="num duty-range"' + rs + '>' +
          (s.meterStart === null || s.meterStart === undefined ? '—' : fx(s.meterStart, 1)) + '' +
          '<span class="duty-range-unit">h</span></td>' +
          '<td class="num duty-range">' +
          (s.meterEnd === null || s.meterEnd === undefined ? '—' : fx(s.meterEnd, 1)) +
          '<span class="duty-range-unit">h</span></td>' +
          '<td class="num duty-range duty-range-op">' +
          (s.operatingHours === null || s.operatingHours === undefined ? '—' : fx(s.operatingHours, 1)) +
          '<span class="duty-range-unit">h</span>' +
          (s.calendarDays ? '<div class="duty-range-note">' + fx(s.calendarDays, 0) +
            ' hari kalender · ' + fx(s.utilizationOverall, 1) + ' jam/hari</div>' : '') +
          '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    if (hasRange) {
      html += '<p class="extras-foot" style="font-style:normal;color:#94a3b8">' +
        '<i class="fa-solid fa-circle-info"></i> <strong>Jam operasi</strong> = SMR akhir − SMR awal ' +
        '(jam mesin menyala, <em>bukan</em> jam kalender ' + fx(s.spanDays, 0) + ' hari). ' +
        'Arti tiap meter berkas <code>op_ava0</code> ada di tabel di bawah.</p>';
      // [O-1 2026-10-12] KAMUS METER dirender dari `METERS_KB`, menggantikan
      // paragraf statis yang dulu menyebut keempat meter dalam satu kalimat
      // panjang. Meter yang artinya belum terbukti diberi badge eksplisit —
      // pembaca harus tahu mana yang dapat dipertanggungjawabkan.
      html += '<h4 class="extras-sub">Keterangan meter <code>op_ava0</code></h4>';
      html += '<div class="extras-legend">Empat kolom meter pada berkas bernama nyaris sama. ' +
        'Memakai meter yang salah akan <strong>melebih-lebihkan jam operasi</strong> ' +
        '(SMR0 selalu ≥ SMR) dan mengacaukan estimasi sisa umur.</div>';
      html += '<div class="clutch-heat-wrap"><table class="data extras-table"><thead><tr>' +
        '<th scope="col">Meter</th><th scope="col">Arti</th>' +
        '<th scope="col">Dipakai untuk</th><th scope="col">Status</th>' +
        '</tr></thead><tbody>';
      ['smr0', 'engine', 'smr1', 'smr2'].forEach(function (k) {
        var m = METERS_KB[k];
        var badge = m.verified
          ? '<span class="badge NORMAL">TERVERIFIKASI</span>'
          : '<span class="badge WARNING">BELUM TERVERIFIKASI</span>';
        html += '<tr title="' + esc(meterTip(k)) + '">' +
          '<th scope="row"><code>' + esc(m.label) + '</code><div class="duty-range-note">' +
            esc(m.title) + '</div></th>' +
          '<td class="wrap-text">' + esc(m.meaning) + '</td>' +
          '<td class="wrap-text">' + esc(m.usedFor) + '</td>' +
          '<td>' + badge + '<div class="duty-range-note">' + esc(m.caution) + '</div></td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }

    if (s.warnings && s.warnings.length) {
      html += '<ul class="extras-warn">';
      s.warnings.forEach(function (w) { html += '<li>' + esc(w) + '</li>'; });
      html += '</ul>';
    }

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* -----------------------------------------------------------------------
   * 3. Panel SNAPSHOT (T10)
   * --------------------------------------------------------------------- */
  function renderSnapshotPanel() {
    var box = document.getElementById('snapshot-panel');
    if (!box) return;
    var store = global.VHMS_FLEET;
    var id = currentUnitId();
    if (!store || !id || typeof store.getSnapshots !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var snaps = store.getSnapshots(id);
    if (!snaps || !snaps.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-wave-square" style="color:#a855f7"></i> Snapshot Alarm</h2>';
    html += '<p class="panel-sub">Rekaman beresolusi tinggi di sekitar pemicu alarm. ' +
      'Digunakan untuk <strong>memastikan penyebab</strong>: bila sebuah sensor tidak ' +
      'bervariasi mengikuti beban mesin selama rekaman, kemungkinan besar sensornya rusak.</p>';

    // [T13-rev] Legenda informasi umum untuk seluruh snapshot.
    html += '<p class="extras-legend">' +
      '<strong>Cara membaca:</strong> tiap kartu = satu rekaman pada saat alarm berbunyi. ' +
      'Kolom <span class="lg-r">STUCK kuat</span> — sensor yang seharusnya mengikuti beban ' +
      'mesin tetapi <em>tidak berubah</em> selama rekaman → indikasi sensor rusak (angka tidak ' +
      'layak dipercaya). Kolom <span class="lg-y">stuck lemah</span> — konstan tetapi bisa wajar ' +
      'secara fisika (mis. suhu intercooler stabil). Panel ini <strong>opt-in by data</strong>: ' +
      'hanya tampil untuk unit yang punya berkas <code>snap*.CSV</code>.</p>';

    // [T13-rev4] KELOMPOKKAN snapshot dengan data SAMA menjadi SATU kartu.
    // Satu berkas snap bisa menghasilkan beberapa rekaman yang identik
    // (SMR pemicu sama, jumlah titik sama, kolom sama) tetapi kode pemicunya
    // berbeda (mis. `f@BYNS` High + `f@BYNR` Very High pada SMR 26358.1 yang
    // sama). Menampilkannya sebagai kartu terpisah hanya mengulang angka yang
    // identik. Jadi: gabungkan berdasar "sidik jari" data, lalu judulnya
    // menyebut SEMUA kode pemicu, dan tabel nilainya cukup sekali.
    var groups = groupSnapshots(snaps);

    html += '<div class="extras-stack">';
    groups.forEach(function (grp) {
      html += renderSnapshotGroup(grp);
    });
    html += '</div>';

    html += '<p class="extras-foot">Catatan: rekaman berukuran besar dipangkas saat disimpan ' +
      'agar kuota penyimpanan aman. Unggah kembali berkas snapshot untuk melihat seluruh titik.</p>';

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /**
   * Kelompokkan snapshot berdasar SIDIK JARI DATA (bukan nama berkas).
   * Dua rekaman dianggap "data sama" bila: SMR pemicu sama, jumlah titik sama,
   * jendela waktu sama, dan kolom tersorot (stuck/peaks) sama. Kode pemicu
   * BOLEH berbeda — itulah yang digabung.
   * @returns {Array<{snaps:Array, triggerCodes:Array, smr:number, identical:boolean}>}
   */
  function groupSnapshots(snaps) {
    var out = [];
    var byKey = {};
    (snaps || []).forEach(function (s) {
      var t = s.trigger || {};
      var sm = s.summary || {};
      var key = [
        (t.smr === null || t.smr === undefined) ? '' : t.smr,
        s.rowCount,
        (sm.windowSec ? (sm.windowSec.min + '..' + sm.windowSec.max) : ''),
        (sm.stuckStrong || []).join('|'),
        (sm.peaks ? Object.keys(sm.peaks).sort().join('|') : '')
      ].join('~');
      if (!byKey[key]) {
        byKey[key] = { snaps: [], triggerCodes: [], smr: (t.smr === null || t.smr === undefined) ? null : t.smr };
        out.push(byKey[key]);
      }
      byKey[key].snaps.push(s);
      var code = t.code || '—';
      if (byKey[key].triggerCodes.indexOf(code) === -1) byKey[key].triggerCodes.push(code);
    });
    out.forEach(function (g) { g.identical = g.snaps.length > 1; });
    return out;
  }

  /**
   * Render SATU kartu snapshot (satu grup). Struktur sama dengan panel load
   * map: KARTU UTUH (judul + legend + kartu statistik) DI ATAS, lalu
   * TABEL BERDAMPINGAN LH|RH DI BAWAH.
   */
  function renderSnapshotGroup(grp) {
    var snaps = grp.snaps;
    var first = snaps[0];
    var sm = first.summary || {};
    var peaks = sm.peaks || {};
    var peakKeys = Object.keys(peaks);
    var hasLeft = peakKeys.length > 0;
    var hasRight = (sm.stuckStrongCount || 0) + (sm.stuckWeakCount || 0) > 0;
    var titles = snaps.map(function (s) { return s.dataTitle; }).filter(Boolean);

    // [2026-10-12] Peta stuck LENGKAP (kuat & lemah) dari `res.stuck`.
    // `summary.sensorStuck` TIDAK ada di snapshot lama (sessionStorage), dan
    // peta ini yang membedakan nada `crit` vs `warn` untuk kolom lemah
    // (mis. `Boost Temp`) — tanpa ini semuanya jadi `crit`.
    // ⚠ WAJIB di scope FUNGSI: dipakai oleh tabel parameter DAN tabel stuck.
    // Sebelumnya dideklarasikan di dalam `if (hasLeft)` sehingga saat
    // `hasLeft` false tetapi `hasRight` true -> `ReferenceError: stuckMapFor
    // is not defined` -> SELURUH kartu snapshot hilang dari halaman.
    var stuckMap = {};
    Object.keys(first.stuck || {}).forEach(function (k) { stuckMap[k] = first.stuck[k]; });

    var html = '<div class="extras-group">';

    // ---------- KARTU UTUH (ATAS) ----------
    html += '<div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-bullseye"></i> ' +
      esc(titles.length ? titles.join(' + ') : 'Snap-shot') +
      (grp.smr !== null ? ' <span class="u-text-mute">@ ' + fx(grp.smr, 1) + ' h</span>' : '') + '</h3>';

    // Pemicu: bila digabung, sebut semua kode + alasan penggabungan.
    html += '<p class="extras-legend">' +
      'Pemicu: ' + grp.triggerCodes.map(function (c) {
        return '<code>' + esc(c) + '</code>';
      }).join(' · ');
    if (grp.identical) {
      html += ' — <strong>digabung jadi satu kartu</strong>: rekaman ini identik ' +
        '(SMR pemicu, jumlah titik, dan kolom yang sama) sehingga angkanya tidak ' +
        'boleh ditampilkan berulang.';
    }
    html += '</p>';

    // Pesan pemicu (unik) bila ada.
    var msgs = [];
    snaps.forEach(function (s) {
      var m = s.trigger && s.trigger.message;
      if (m && msgs.indexOf(m) === -1) msgs.push(m);
    });
    if (msgs.length) {
      html += '<p class="panel-sub" style="margin-top:2px">' + esc(msgs.join(' / ')) + '</p>';
    }

    // Kartu statistik sebaris (rata, tanpa wrap).
    html += '<div class="extras-stat-grid">';
    html += statCard('Parameter terekam', String(peakKeys.length), 'kolom',
      'Seluruh parameter berkas snap (bukan hanya 5 kolom inti).', 'ok');
    html += statCard('Titik rekaman', String(first.rowCount), 'titik',
      'Jendela ' + (sm.windowSec ?
        (fx(sm.windowSec.min, 0) + '…' + fx(sm.windowSec.max, 0) + ' s') : '—') +
      ' relatif ke pemicu.', 'ok');
    html += statCard('Sensor STUCK (bukti kuat)', String(sm.stuckStrongCount || 0), 'kolom',
      (sm.stuckStrong && sm.stuckStrong.length ? sm.stuckStrong.join(', ') : 'Tidak ada'),
      sm.stuckStrongCount ? 'crit' : 'ok');
    html += statCard('Sensor tidak bervariasi (bukti lemah)', String(sm.stuckWeakCount || 0), 'kolom',
      (sm.stuckWeak && sm.stuckWeak.length ? sm.stuckWeak.join(', ') : 'Tidak ada'),
      sm.stuckWeakCount ? 'warn' : 'ok');
    if (grp.identical) {
      html += statCard('Rekaman digabung', String(snaps.length), 'kali',
        'Pemicu: ' + grp.triggerCodes.join(', ') + '.', 'ok');
    }
    html += '</div>';

    // Catatan sensor rusak — cukup sekali (data sama untuk seluruh grup).
    if (sm.stuckStrongCount) {
      html += '<p class="clutch-note" style="border-color:#f59e0b;background:rgba(245,158,11,.12)">' +
        '<i class="fa-solid fa-microchip"></i> <strong>Indikasi sensor rusak.</strong> ' +
        'Kolom berikut nyaris tidak berubah sepanjang rekaman padahal seharusnya ' +
        'mengikuti beban mesin: ' + esc(sm.stuckStrong.join(', ')) + '. ' +
        'Nilai dari kolom ini <strong>tidak layak</strong> untuk menilai kondisi mesin ' +
        'sampai sensornya diverifikasi.</p>';
    }
    html += '</div>';   // /extras-block — KARTU UTUH di ATAS

    // ---------- TABEL (BAWAH) ----------
    // [2026-10-12] Mengikuti pola panel Load Map:
    //   TABEL 1 (penuh, kolom Result lebar) : seluruh parameter terekam.
    //   TABEL 2 (berdampingan LH|RH)        : sensor STUCK kuat & lemah.
    // Perbandingan menjadikan temuan sensor rusak berdampingan langsung
    // dengan tabel parameternya, tanpa perlu berpindah tempat.
    if (hasLeft || hasRight) {
      if (hasLeft) {
        // Urutan: kolom inti mesin dulu, lalu kolom stuck, lalu sisanya.
        var ordered = peakKeys.slice().sort(function (a, b) {
          var pa = peaks[a], pb = peaks[b];
          var ra = (pa.key ? 0 : (pa.stuck ? 1 : 2));
          var rb = (pb.key ? 0 : (pb.stuck ? 1 : 2));
          if (ra !== rb) return ra - rb;
          return peakKeys.indexOf(a) - peakKeys.indexOf(b);
        });

        // Konteks untuk verdict per baris (fuel & rpm rata-rata rekaman).
        var ctx = {
          triggerBanks: (sm.stuckStrong || []).map(function (k) {
            return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
          })
        };
        Object.keys(peaks).forEach(function (k) {
          var nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (/fuel/.test(nk) && peaks[k].avg !== undefined) ctx.fuel = peaks[k].avg;
          if (/engspeed/.test(nk) && peaks[k].avg !== undefined) ctx.rpm = peaks[k].avg;
        });

        html += '<h4 class="extras-sub">Nilai tiap parameter selama rekaman ' +
          '<span class="u-text-mute">(' + ordered.length + ' parameter)</span></h4>';
        html += '<p class="extras-legend">' +
          '<strong>Min / Rata² / Maks / Akhir / Rentang</strong> tiap parameter sepanjang jendela ' +
          'rekaman. Kolom <span class="lg-r">Result</span> menilai tiap parameter: apakah nilainya ' +
          'wajar mengikuti beban mesin atau justru menandakan sensor rusak. ' +
          'Baris bertanda <span class="lg-r">STUCK</span> = nyaris tidak bervariasi.</p>';
        html += '<div class="clutch-heat-wrap extras-scroll"><table class="data extras-table extras-table--snap">' +
          '<colgroup><col class="c-param"><col class="c-unit"><col class="c-v1"><col class="c-v1">' +
          '<col class="c-v1"><col class="c-v1"><col class="c-v1"><col class="c-verdict"></colgroup>' +
          '<thead><tr>' +
          '<th scope="col">Parameter</th><th scope="col">Satuan</th>' +
          '<th class="num" scope="col">Min</th><th class="num" scope="col">Rata²</th>' +
          '<th class="num" scope="col">Maks</th><th class="num" scope="col">Akhir</th>' +
          '<th class="num" scope="col">Rentang</th>' +
          '<th scope="col">Result</th>' +
          '</tr></thead><tbody>';
        ordered.forEach(function (k) {
          var p = peaks[k];
          var v = snapshotParamVerdict(k, p, stuckMap, ctx);
          html += '<tr' + (p.stuck ? ' class="row-warn"' : '') + '><td>' + esc(k) +
            (p.stuck ? ' <span class="lg-r">STUCK</span>' : '') + '</td>' +
            '<td>' + esc(p.unit || '—') + '</td>' +
            '<td class="num">' + fx(p.min) + '</td>' +
            '<td class="num">' + (p.avg === undefined ? '—' : fx(p.avg)) + '</td>' +
            '<td class="num"><strong>' + fx(p.max) + '</strong></td>' +
            '<td class="num">' + fx(p.last) + '</td>' +
            '<td class="num">' + (p.range === undefined ? '—' : fx(p.range)) + '</td>' +
            verdictCell(v) + '</tr>';
        });
        html += '</tbody></table></div>';
      } else {
        html += '<h4 class="extras-sub">Nilai tiap parameter selama rekaman</h4>';
        html += '<p class="extras-legend">Nilai penting tidak tersedia (rekaman mungkin ' +
          'dipangkas saat disimpan). Unggah ulang berkas snapshot untuk data lengkap.</p>';
      }

      // ---- TABEL SENSOR: STUCK kuat & lemah, berdampingan di layar lebar ----
      if (hasRight) {
        html += '<h4 class="extras-sub" style="margin-top:14px">Ringkasan Sensor Tidak Bervariasi</h4>';
        html += '<div class="extras-legend">' +
          '<span class="lg-r">STUCK kuat</span> = seharusnya mengikuti beban mesin tetapi ' +
          'tidak berubah → indikasi sensor rusak. ' +
          '<span class="lg-y">stuck lemah</span> = konstan tetapi bisa wajar secara fisika.</div>';
        html += '<div class="extras-duo">';
        html += '<div class="extras-col">' + stuckTable('Bukti kuat (indikasi rusak)',
          sm.stuckStrong, stuckMap, peaks, 'crit') + '</div>';
        html += '<div class="extras-col">' + stuckTable('Bukti lemah (periksa bila ada gejala)',
          sm.stuckWeak, stuckMap, peaks, 'warn') + '</div>';
        html += '</div>';
      }
    }

    html += '</div>';   // /extras-group
    return html;
  }

  /**
   * Tabel daftar kolom yang terdeteksi tidak bervariasi (stuck).
   * Menampilkan bukti terukurnya: nilai konstan, rasio kemunculan, dan
   * porsi rekaman — bukan hanya nama kolom.
   */
  function stuckTable(title, names, stuckMap, peaks, tone) {
    names = names || [];
    var html = '<h4 class="extras-sub">' + esc(title) + ' <span class="u-text-mute">(' +
      names.length + ')</span></h4>';
    if (!names.length) {
      html += '<p class="extras-legend">Tidak ada kolom pada kategori ini.</p>';
      return html;
    }
    html += '<div class="clutch-heat-wrap extras-scroll"><table class="data extras-table">' +
      '<colgroup><col class="c-param"><col class="c-v1"><col class="c-v1"><col class="c-verdict"></colgroup>' +
      '<thead><tr><th scope="col">Kolom</th><th class="num" scope="col">Nilai konstan</th>' +
      '<th class="num" scope="col">Muncul</th><th scope="col">Keterangan &amp; rujukan</th></tr></thead><tbody>';
    var SKB = snapKB();
    names.forEach(function (k) {
      var s = (stuckMap && stuckMap[k]) || {};
      var p = peaks[k] || {};
      var ratio = (s.ratio === undefined) ? null : s.ratio;
      var ket = (tone === 'crit')
        ? 'Harus mengikuti beban mesin — tidak bergerak sepanjang rekaman.'
        : 'Boleh konstan secara fisika — perlu gejala lain untuk mencurigai sensor.';
      // [2026-10-12] Rujukan dari kamus (dimensi + catatan) agar teknisi tahu
      // dari mana ambang/klasifikasi ini berasal.
      var note = (SKB && SKB.referenceNote) ? SKB.referenceNote(k) : '';
      var refs = (SKB && SKB.refsFor) ? SKB.refsFor(k) : [];
      var detail = '';
      if (note) detail += '<div class="verdict-diff">' + esc(note) + '</div>';
      if (refs.length) {
        detail += '<div class="verdict-diff refs">' + refs.map(function (r) {
          return '<span class="ref-chip">' + esc(r) + '</span>';
        }).join('') + '</div>';
      }
      html += '<tr class="row-warn"><td>' + esc(k) + '</td>' +
        '<td class="num">' + fx(s.value === undefined ? p.last : s.value) + '</td>' +
        '<td class="num">' + (ratio === null ? '—' : fx(ratio * 100, 1) + ' %') + '</td>' +
        '<td class="verdict-cell verdict-' + tone + '">' + esc(ket) + detail + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  /* -----------------------------------------------------------------------
   * 4. Orkestrasi
   * --------------------------------------------------------------------- */
  function renderAll() {
    try { renderLoadMapPanel(); } catch (e) { if (global.console) console.warn('loadmap panel:', e.message); }
    try { renderOpAvaPanel(); } catch (e) { if (global.console) console.warn('opava panel:', e.message); }
    try { renderSnapshotPanel(); } catch (e) { if (global.console) console.warn('snapshot panel:', e.message); }
  }

  /* [FITUR 2026-10-11] Setter filter rentang tanggal panel Op. Availability. */
  function setOpAvaRange(partial) {
    if (!partial) return;
    if (partial.from !== undefined) opavaState.from = String(partial.from || '');
    if (partial.to !== undefined) opavaState.to = String(partial.to || '');
    if (partial.unitId !== undefined) opavaState.unitId = partial.unitId;
    renderOpAvaPanel();
  }
  /** Terapkan preset cepat (30h / 90h / semua / reset) relatif ke data terakhir. */
  function applyOpAvaQuick(kind) {
    var store = global.VHMS_FLEET;
    var id = currentUnitId();
    if (!store || !id || typeof store.getOpAva !== 'function') return;
    var res = store.getOpAva(id);
    if (!res || !res.windows || !res.windows.length) return;
    if (kind === 'all' || kind === 'reset') {
      opavaState.from = ''; opavaState.to = '';
      renderOpAvaPanel();
      return;
    }
    var days = parseInt(kind, 10);
    if (!days || days <= 0) return;
    var last = res.windows[res.windows.length - 1];
    var lastEpoch = last.toEpoch || last.fromEpoch;
    opavaState.to = epochToDayInput(lastEpoch);
    opavaState.from = epochToDayInput(lastEpoch - days * 86400);
    renderOpAvaPanel();
  }
  /** Akses state filter (untuk pengujian). */
  function getOpAvaRange() { return { from: opavaState.from, to: opavaState.to, unitId: opavaState.unitId }; }

  global.VHMS_EXTRAS_RENDER = {
    renderAll: renderAll,
    renderLoadMapPanel: renderLoadMapPanel,
    renderOpAvaPanel: renderOpAvaPanel,
    renderSnapshotPanel: renderSnapshotPanel,
    // [T13-rev4] Diekspor agar dapat diuji: pengelompokan snapshot berdata sama.
    groupSnapshots: groupSnapshots,
    renderSnapshotGroup: renderSnapshotGroup,
    // [2026-10-12] Verdict per parameter rekaman untuk kolom "Result".
    snapshotParamVerdict: snapshotParamVerdict,
    stuckTable: stuckTable,
    // [FITUR 2026-10-11] Filter rentang tanggal panel Op. Availability.
    setOpAvaRange: setOpAvaRange,
    applyOpAvaQuick: applyOpAvaQuick,
    getOpAvaRange: getOpAvaRange,
    // [O-1 2026-10-12] Kamus meter `op_ava0` + pembangun tooltipnya.
    // Diekspor agar dapat diuji dan agar modul lain tidak menyalin artinya.
    METERS_KB: METERS_KB,
    meterTip: meterTip
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_EXTRAS_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

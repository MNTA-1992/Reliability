/* =========================================================================
 * vhms-powertrain-render.js
 * -------------------------------------------------------------------------
 * [HD785 2026-10-14] Dua panel UI untuk data tambahan HD785:
 *   - `gearload-panel` : beban transmisi per gigi + rasio lock-up vs T/C
 *   - `dutymap-panel`  : duty mesin BERMUATAN vs KOSONG, retarder, warm-up
 *
 * Prinsip (sama dengan `vhms-extras-render.js`):
 *   - OPT-IN BY DATA. Unit tanpa berkasnya tidak melihat panel sama sekali,
 *     jadi PC2000/D375A tidak terpengaruh.
 *   - `esc()` untuk semua teks dari berkas.
 *   - Setiap angka diberi SATUAN dan BASIS. Panel ini banyak memakai dua
 *     basis berbeda (seluruh jendela vs hanya saat bergerak) — menampilkan
 *     salah satunya tanpa menyebut basisnya akan menyesatkan.
 *
 * KEJUJURAN YANG DITEGAKKAN DI SINI
 *   Panel TIDAK memberi vonis "normal/abnormal" untuk besaran yang tidak
 *   punya ambang terbukti (torsi transmisi, warm-up, kemiringan). Yang
 *   diberi warna hanya:
 *     - zona LUG pada peta BERMUATAN/KOSONG (ambang dari VHMS_LOADMAP,
 *       sumbu identik dengan loadm0 -> sah)
 *     - pola LUG TERBALIK (perbandingan unit dengan dirinya sendiri -> sah)
 *   Selebihnya memakai nada netral.
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
    return Number(v).toFixed(d === undefined ? 1 : d);
  }

  /** Jam dengan pemisah ribuan; '—' bila tidak sahih. */
  function fh(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = Math.round(v);
    var u = global.UI_UTIL;
    if (u && typeof u.fmtInt === 'function') return u.fmtInt(n);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function currentUnitId() {
    var app = global.VHMS_APP;
    return (app && typeof app.getCurrentUnitId === 'function') ? app.getCurrentUnitId() : null;
  }

  /** Kartu statistik — bentuk sama dengan `vhms-extras-render.js`. */
  function statCard(label, value, unit, note, sev) {
    var cls = sev === 'crit' ? 'extras-card crit' : (sev === 'warn' ? 'extras-card warn' : 'extras-card');
    return '<div class="' + cls + '">' +
      '<div class="extras-card-label">' + esc(label) + '</div>' +
      '<div class="extras-card-value">' + value + '<span class="extras-card-unit">' + esc(unit) + '</span></div>' +
      (note ? '<div class="extras-card-note">' + note + '</div>' : '') +
      '</div>';
  }

  function verdictCell(text, tone) {
    return '<td class="verdict-cell verdict-' + (tone || 'muted') + '">' + esc(text) + '</td>';
  }

  /** Bar proporsi inline (dua segmen) — murni visual, tanpa dependensi chart. */
  function splitBar(leftPct, leftLabel, rightLabel) {
    var l = Math.max(0, Math.min(100, Number(leftPct) || 0));
    return '<div class="pt-bar" role="img" aria-label="' +
      esc(leftLabel + ' ' + l.toFixed(1) + ' persen, sisanya ' + rightLabel) + '">' +
      '<span class="pt-bar-a" style="width:' + l.toFixed(2) + '%"></span>' +
      '<span class="pt-bar-b" style="width:' + (100 - l).toFixed(2) + '%"></span>' +
      '</div>';
  }

  /* =======================================================================
   * 1. PANEL BEBAN TRANSMISI PER GIGI
   * ===================================================================== */

  /**
   * Narasi per gigi. SENGAJA deskriptif — tidak ada ambang OEM untuk torsi
   * poros transmisi HD785 (lihat catatan kepala `vhms-gearload.js`).
   */
  function gearVerdict(g, summary) {
    if (!g || !g.totalSec) return { text: '—', tone: 'muted' };
    var parts = [];
    if (g.share >= 20) parts.push('Gigi dominan (' + fx(g.share) + ' % waktu jalan).');
    else if (g.share < 2) parts.push('Jarang dipakai (' + fx(g.share) + ' %).');
    else parts.push(fx(g.share) + ' % waktu jalan.');

    // [D375A 2026-10-14 — J1] Model yang tidak mengekspor matriks L/U per gigi
    // TIDAK boleh diberi narasi lock-up sama sekali. `lockupShare` memang null
    // di sana, tetapi menulis "hanya converter" juga salah: 44..49 mencakup
    // L/U + converter sekaligus. Yang benar: tidak dipisahkan.
    var separated = !summary || summary.modeSeparated !== false;
    if (!separated) {
      parts.push('L/U &amp; torque converter tidak terpisah pada matriks ini.');
      return { text: parts.join(' '), tone: 'muted' };
    }

    if (g.lockupShare !== null && g.lockupShare !== undefined) {
      if (g.lockupShare < 50) {
        parts.push('Mayoritas lewat torque converter (' + fx(100 - g.lockupShare) +
          ' %) — ada slip fluida, oli T/C menanggung panas.');
      } else {
        parts.push('Mayoritas lock-up (' + fx(g.lockupShare) + ' %) — penyaluran langsung.');
      }
    } else if (g.converterSec > 0 && !g.lockupSec) {
      parts.push('Hanya terekam lewat torque converter.');
    } else if (g.lockupSec > 0 && !g.converterSec) {
      parts.push('Hanya terekam dalam kondisi lock-up.');
    }
    return { text: parts.join(' '), tone: 'muted' };
  }

  function renderGearLoadPanel() {
    var box = document.getElementById('gearload-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, gl = global.VHMS_GEARLOAD;
    var id = currentUnitId();
    if (!store || !id || !gl || typeof store.getGearLoad !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var data = store.getGearLoad(id);
    var s = data && data.summary;
    if (!s || !s.totalSec) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-gears" style="color:#8b5cf6"></i> ' +
      'Beban Transmisi per Gigi</h2>';
    html += '<p class="panel-sub">Waktu operasi tiap gigi, dipisah menurut cara tenaga disalurkan. ' +
      'Sumbu Z berkas ini adalah <strong>detik nyata</strong>, sehingga nilai dilaporkan dalam ' +
      '<strong>jam</strong> — berbeda dari Load Map mesin yang hanya distribusi persen.</p>';

    html += '<div class="extras-stack">';

    /* ---------------- Blok 1: ringkasan lock-up vs converter -------------- */
    html += '<div class="extras-group"><div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-link"></i> Lock-up vs Torque Converter</h3>';
    html += '<p class="extras-legend">' +
      '<strong>Lock-up</strong> = kopling L/U mengunci poros masuk &amp; keluar → penyaluran langsung, ' +
      'tanpa slip, oli T/C tidak menanggung panas. ' +
      '<strong>Torque converter</strong> = tenaga lewat fluida → selalu ada slip &amp; panas. ' +
      'Porsi lock-up yang besar berarti beban termal T/C lebih ringan. ' +
      'Rasio ini <strong>tanpa satuan</strong>, jadi sah dibandingkan antar unit model sama ' +
      'dan antar waktu pada unit yang sama — <em>tanpa</em> perlu angka pabrik.</p>';

    html += '<div class="extras-stat-grid">';
    html += statCard('Total waktu jalan', fh(s.totalHours), 'jam',
      'Jumlah seluruh matriks gigi. Sisa jam mesin = idle, loading, dumping, netral.');
    // [D375A 2026-10-14 — J1] Tiga cabang, bukan dua. Untuk model yang tidak
    // memisahkan L/U per gigi, TIDAK BOLEH ada kartu berisi "0,0 %": pembaca
    // akan menyimpulkan kopling L/U tidak pernah bekerja, padahal yang benar
    // adalah datanya tidak terpisah pada model itu.
    if (s.modeSeparated === false) {
      html += statCard('L/U vs torque converter', 'Tidak terpisah', '',
        'Model ini mengekspor <strong>satu</strong> peta L/U agregat, bukan satu berkas per gigi. ' +
        'Jam di samping karena itu mencakup L/U <em>dan</em> converter sekaligus.', 'warn');
    } else {
      html += statCard('Lock-up', fx(s.lockupShare), '%',
        fh(s.lockupHours) + ' jam dengan kopling L/U terkunci.');
      html += statCard('Torque converter', fx(s.converterShare), '%',
        fh(s.converterHours) + ' jam lewat fluida (ada slip &amp; panas).');
    }
    html += statCard('Gigi dominan', esc(s.dominantGear || '—'), '',
      'Gigi dengan jam terbanyak.');
    html += '</div>';

    if (s.modeSeparated !== false) {
      html += splitBar(s.lockupShare, 'Lock-up', 'torque converter');
      html += '<p class="extras-legend pt-bar-legend">' +
        '<span class="pt-key pt-key-a"></span> Lock-up ' + fx(s.lockupShare) + ' % · ' +
        '<span class="pt-key pt-key-b"></span> Torque converter ' + fx(s.converterShare) + ' %</p>';
    } else {
      html += '<p class="extras-legend pt-note">Bar proporsi L/U vs converter tidak ditampilkan: ' +
        'pada model ini keduanya tergabung dalam satu matriks per gigi, sehingga pangsa tidak terukur. ' +
        'Menampilkan 0 % akan menyesatkan.</p>';
    }

    if (s.missingGears && s.missingGears.length) {
      html += '<p class="extras-legend pt-warn">Berkas belum lengkap — gigi ' +
        esc(s.missingGears.join(', ')) + ' belum diunggah. Angka di atas hanya ' +
        'mencakup ' + s.fileCount + ' berkas yang ada, jadi total jam &amp; rasio ' +
        'masih bisa berubah.</p>';
    }
    html += '</div>';   // /extras-block

    /* ---------------- Tabel per gigi ------------------------------------- */
    html += '<div class="extras-duo extras-duo--stack"><div class="extras-col">';
    html += '<h4 class="extras-sub">Rincian per gigi</h4>';
    html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
      '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2">' +
      '<col class="c-diff"><col class="c-verdict"></colgroup>' +
      '<thead><tr>' +
      '<th scope="col">Gigi</th>' +
      '<th class="num" scope="col">' + (s.modeSeparated === false ? 'Jam' : 'Lock-up (jam)') + '</th>' +
      '<th class="num" scope="col">' + (s.modeSeparated === false ? 'Pangsa waktu' : 'Converter (jam)') + '</th>' +
      '<th class="num" scope="col">' + (s.modeSeparated === false ? '—' : 'Pangsa waktu') + '</th>' +
      '<th scope="col">Result / Hipotesis</th>' +
      '</tr></thead><tbody>';
    s.gears.forEach(function (g) {
      var v = gearVerdict(g, s);
      if (s.modeSeparated === false) {
        html += '<tr><td class="mono">' + esc(g.gear) + '</td>' +
          '<td class="num">' + fh(g.hours) + '</td>' +
          '<td class="num">' + fx(g.share) + ' %</td>' +
          '<td class="num">—</td>' +
          verdictCell(v.text, v.tone) + '</tr>';
        return;
      }
      html += '<tr><td class="mono">' + esc(g.gear) + '</td>' +
        '<td class="num">' + fh(g.lockupHours) + '</td>' +
        '<td class="num">' + fh(g.converterHours) + '</td>' +
        '<td class="num">' + fx(g.share) + ' %</td>' +
        verdictCell(v.text, v.tone) + '</tr>';
    });
    html += '</tbody></table></div></div>';

    /* ---------------- Tabel ciri beban per berkas ------------------------ */
    var keys = Object.keys(data.byKey || {});
    if (keys.length) {
      html += '<div class="extras-col">';
      html += '<h4 class="extras-sub">Ciri beban tiap matriks</h4>';
      html += '<p class="extras-legend">Band <strong>median</strong> = tempat 50 % waktu kumulatif ' +
        'tercapai; <strong>p90</strong> = ekor beban (10 % waktu berada di atasnya). ' +
        'Keduanya dihitung dari sebaran berkas itu sendiri, jadi <strong>tidak memerlukan ' +
        'ambang pabrik</strong> dan tetap sebanding antar gigi. ' +
        'Naiknya p90 antar waktu = beban memberat.</p>';
      html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
        '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2">' +
        '<col class="c-diff"><col class="c-verdict"></colgroup>' +
        '<thead><tr>' +
        '<th scope="col">Gigi / mode</th>' +
        '<th class="num" scope="col">Jam</th>' +
        '<th scope="col">Torsi median</th>' +
        '<th scope="col">Torsi p90</th>' +
        '<th scope="col">rpm median</th>' +
        '</tr></thead><tbody>';
      // Urutkan mengikuti urutan gigi baku, lock-up dulu.
      keys.sort(function (a, b) {
        var ra = data.byKey[a], rb = data.byKey[b];
        var ga = gl.GEAR_ORDER.indexOf(ra.gear), gb = gl.GEAR_ORDER.indexOf(rb.gear);
        if (ga !== gb) return ga - gb;
        return (ra.mode === gl.MODE_LOCKUP ? 0 : 1) - (rb.mode === gl.MODE_LOCKUP ? 0 : 1);
      });
      keys.forEach(function (k) {
        var r = data.byKey[k];
        if (!r || !r.stats) return;
        var modeTxt = (r.mode === gl.MODE_ALL) ? 'L/U + converter'
          : ((r.mode === gl.MODE_LOCKUP) ? 'lock-up' : 'converter');
        html += '<tr><td class="mono">' + esc((r.gear || '?') + ' · ' + modeTxt) + '</td>' +
          '<td class="num">' + fh(r.hours) + '</td>' +
          '<td class="mono">' + esc(r.stats.medianTorqueBand || '—') + '</td>' +
          '<td class="mono">' + esc(r.stats.p90TorqueBand || '—') + '</td>' +
          '<td class="mono">' + esc(r.stats.medianRpmBand || '—') + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<p class="extras-legend">Satuan band torsi: ' +
        esc((data.byKey[keys[0]] && data.byKey[keys[0]].yAxis.unit) || 'Nm') +
        '; band rpm: ' + esc((data.byKey[keys[0]] && data.byKey[keys[0]].xAxis.unit) || 'rpm') + '. ' +
        'Nilai torsi lock-up (poros masuk T/M) dan converter (keluaran T/C) adalah ' +
        '<strong>besaran berbeda</strong> — jangan dibandingkan langsung satu sama lain.</p>';
      html += '</div>';
    }
    html += '</div>';   // /extras-duo
    html += '</div>';   // /extras-group
    html += '</div>';   // /extras-stack

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* =======================================================================
   * 2. PANEL PETA DUTY OPERASI
   * ===================================================================== */

  /** Nada untuk zona LUG — ambang dari VHMS_LOADMAP (sumbu identik loadm0). */
  function lugTone(share) {
    if (share === null || share === undefined) return 'muted';
    return share >= 10 ? 'crit' : (share >= 5 ? 'warn' : 'ok');
  }

  function renderDutyMapPanel() {
    var box = document.getElementById('dutymap-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, dm = global.VHMS_DUTYMAP;
    var id = currentUnitId();
    if (!store || !id || !dm || typeof store.getDutyMap !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var data = store.getDutyMap(id);
    if (!data) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var loaded = data[dm.KIND_LOADED];
    var empty = data[dm.KIND_UNLOADED];
    var slope = data[dm.KIND_SLOPE];
    var engSlope = data[dm.KIND_ENGINE_SLOPE];
    var warm = data[dm.KIND_WARMUP];
    var delta = data.loadedDelta;
    if (!loaded && !empty && !slope && !engSlope && !warm) {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-truck-ramp-box" style="color:#f59e0b"></i> ' +
      'Peta Duty Operasi</h2>';
    html += '<p class="panel-sub">Bagaimana unit benar-benar dipakai: beban mesin saat bermuatan ' +
      'dibanding saat kosong, perilaku menuruni jalan, dan kebiasaan pemanasan mesin.</p>';
    html += '<div class="extras-stack">';

    /* ------------- Blok A: BERMUATAN vs KOSONG --------------------------- */
    if (loaded || empty) {
      html += '<div class="extras-group"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-weight-hanging"></i> ' +
        'Beban Mesin: Bermuatan vs Kosong</h3>';
      html += '<p class="extras-legend">' +
        'Dua berkas dengan sumbu <strong>identik</strong> (putaran mesin × injeksi bahan bakar), ' +
        'direkam pada kondisi berbeda. Perbandingannya menjawab pertanyaan yang tidak bisa ' +
        'dijawab satu berkas saja: <strong>apakah beban berat berasal dari muatan (wajar) ' +
        'atau dari sebab lain (tidak wajar)?</strong> ' +
        '<span class="lg-r">LUG</span> = injeksi ≥' +
        esc(String((loaded || empty).zones.thresholds.lugFuelMin)) + ' mm³/st pada rpm ≤' +
        esc(String((loaded || empty).zones.thresholds.lugRpmMax)) + ' — zona paling merusak. ' +
        'Ambang diambil dari modul Load Map (besaran &amp; sumbu sama persis).</p>';

      html += '<div class="extras-stat-grid">';
      if (loaded && loaded.zones) {
        html += statCard('LUG — BERMUATAN', fx(loaded.zones.lugShare), '%',
          fh(loaded.hours) + ' jam bermuatan. Beban berat di sini <em>diharapkan</em>.',
          lugTone(loaded.zones.lugShare));
      }
      if (empty && empty.zones) {
        html += statCard('LUG — KOSONG', fx(empty.zones.lugShare), '%',
          fh(empty.hours) + ' jam kosong. Beban berat di sini <em>tidak diharapkan</em>.',
          lugTone(empty.zones.lugShare));
      }
      if (loaded && loaded.zones) {
        html += statCard('High-power — bermuatan', fx(loaded.zones.highPowerShare), '%',
          'Injeksi ≥' + esc(String(loaded.zones.thresholds.hiPowerFuelMin)) +
          ' mm³/st pada rpm &gt;' + esc(String(loaded.zones.thresholds.hiPowerRpmMin)) +
          ' — tenaga penuh, pembakaran bersih.');
      }
      if (empty && empty.zones) {
        html += statCard('Idle — kosong', fx(empty.zones.idleShare), '%',
          'rpm ≤' + esc(String(empty.zones.thresholds.idleRpmMax)) +
          ' saat bak kosong. Wajar tinggi (antre muat / dumping).');
      }
      html += '</div>';

      if (delta) {
        html += '<div class="pt-delta ' + (delta.lugInverted ? 'pt-delta-bad' : 'pt-delta-ok') + '">' +
          '<i class="fa-solid ' + (delta.lugInverted ? 'fa-triangle-exclamation' : 'fa-circle-check') + '"></i> ' +
          esc(delta.invertedNote) + '</div>';
        html += '<p class="extras-legend">Waktu mesin hidup terbagi ' +
          fx(delta.loadedShare) + ' % bermuatan (' + fh(delta.loadedHours) + ' jam) dan ' +
          fx(delta.unloadedShare) + ' % kosong (' + fh(delta.unloadedHours) + ' jam). ' +
          'Selisih zona LUG <strong>' + (delta.lugDelta >= 0 ? '+' : '−') +
          fx(Math.abs(delta.lugDelta)) + ' poin persen</strong>; selisih high-power <strong>' +
          (delta.highPowerDelta >= 0 ? '+' : '−') + fx(Math.abs(delta.highPowerDelta)) +
          ' pp</strong> (positif = lebih dominan saat bermuatan).</p>';
        html += splitBar(delta.loadedShare, 'Bermuatan', 'kosong');
        html += '<p class="extras-legend pt-bar-legend">' +
          '<span class="pt-key pt-key-a"></span> Bermuatan ' + fx(delta.loadedShare) + ' % · ' +
          '<span class="pt-key pt-key-b"></span> Kosong ' + fx(delta.unloadedShare) + ' %</p>';
      } else {
        html += '<p class="extras-legend pt-warn">Hanya satu sisi yang tersedia. ' +
          'Unggah berkas pasangannya (' +
          esc(loaded ? 'no-Loaded Engine Count Map' : 'Loaded Engine Count Map') +
          ') agar perbandingan bermuatan vs kosong dapat dihitung.</p>';
      }
      html += '</div>';   // /extras-block

      // Tabel perbandingan zona.
      if (delta) {
        html += '<div class="extras-duo extras-duo--stack"><div class="extras-col">';
        html += '<h4 class="extras-sub">Perbandingan zona beban</h4>';
        html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
          '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2">' +
          '<col class="c-diff"><col class="c-verdict"></colgroup>' +
          '<thead><tr><th scope="col">Zona</th>' +
          '<th class="num" scope="col">Bermuatan</th>' +
          '<th class="num" scope="col">Kosong</th>' +
          '<th class="num" scope="col">Selisih</th>' +
          '<th scope="col">Result / Hipotesis</th></tr></thead><tbody>';
        var zl = delta.zonesLoaded, zu = delta.zonesUnloaded;
        var zoneRows = [
          { k: 'Zona LUG', a: zl.lugShare, b: zu.lugShare, d: delta.lugDelta,
            v: delta.lugInverted
              ? { text: 'TERBALIK — beban berat justru saat kosong. Telusuri rem terseret, kondisi jalan, atau pemilihan gigi.', tone: 'crit' }
              : { text: 'Pola wajar: beban berat terkonsentrasi saat membawa muatan.', tone: 'ok' } },
          { k: 'High-power sehat', a: zl.highPowerShare, b: zu.highPowerShare, d: delta.highPowerDelta,
            v: { text: 'Tenaga penuh dipakai saat bermuatan — pembakaran bersih, bukan zona merusak.', tone: 'ok' } },
          { k: 'Idle', a: zl.idleShare, b: zu.idleShare, d: delta.idleDelta,
            v: { text: 'Idle tinggi saat kosong adalah normal (antre muat, dumping). Idle tinggi saat BERMUATAN justru pemborosan.', tone: 'muted' } },
          { k: 'Injeksi tinggi', a: zl.highFuelShare, b: zu.highFuelShare,
            d: zl.highFuelShare - zu.highFuelShare,
            v: { text: 'Pangsa waktu dengan injeksi bahan bakar tinggi (semua rpm).', tone: 'muted' } }
        ];
        zoneRows.forEach(function (r) {
          var cls = Math.abs(r.d) >= 10 ? ' style="font-weight:600"' : '';
          html += '<tr><td>' + esc(r.k) + '</td>' +
            '<td class="num">' + fx(r.a) + ' %</td>' +
            '<td class="num">' + fx(r.b) + ' %</td>' +
            '<td class="num mono"' + cls + '>' + (r.d >= 0 ? '+' : '−') + fx(Math.abs(r.d)) + ' pp</td>' +
            verdictCell(r.v.text, r.v.tone) + '</tr>';
        });
        html += '</tbody></table></div></div></div>';
      }
      html += '</div>';   // /extras-group
    }

    /* ------------- Blok B: retarder / menuruni jalan --------------------- */
    if (slope || engSlope) {
      html += '<div class="extras-group" style="margin-top:16px"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-mountain"></i> ' +
        'Perilaku Menuruni Jalan (Retarder)</h3>';
      html += '<p class="extras-legend pt-basis">' +
        '<strong>Penting soal basis angka.</strong> Kedua berkas ini merekam jendela waktu yang ' +
        'sangat didominasi kondisi DIAM/IDLE — pada unit contoh lebih dari 90 % isinya. ' +
        'Menghitung persen atas seluruh jendela menghasilkan angka yang terlihat menenangkan ' +
        'tapi tidak bermakna. Karena itu angka di bawah memakai basis ' +
        '<strong>hanya saat unit benar-benar bergerak / mesin bekerja</strong>, ' +
        'dan basis itu disebutkan eksplisit di setiap kartu.</p>';

      html += '<div class="extras-stat-grid">';
      if (slope && slope.zones) {
        var zs = slope.zones;
        html += statCard('Waktu bergerak', fh(zs.movingHours), 'jam',
          'Dari ' + fh(zs.hours) + ' jam jendela; sisanya ' + fx(zs.stillShare) +
          ' % berada di band kecepatan terendah (diam/manuver).');
        html += statCard('Jalan curam — saat bergerak', fx(zs.steepShareMoving), '%',
          'Kemiringan ≥' + esc(String(zs.thresholds.steepDeg)) + '° dihitung atas waktu bergerak saja. ' +
          'Atas seluruh jendela angkanya hanya ' + fx(zs.steepShareAll, 2) + ' % — menyesatkan.');
        html += statCard('Kecepatan tinggi — saat bergerak', fx(zs.fastShareMoving), '%',
          '≥' + esc(String(zs.thresholds.fastKmh)) + ' km/h.');
        // ⚠ `label` DI-ESCAPE oleh statCard(), `note` TIDAK (note memang boleh
        //   memuat <em>/<strong>). Menulis entitas HTML di label membuatnya
        //   ter-escape dua kali dan tampil mentah sebagai "&amp;" di layar —
        //   terbukti saat verifikasi browser. Label = teks polos.
        html += statCard('Curam & cepat bersamaan', fx(zs.steepAndFastShareMoving), '%',
          'Kombinasi paling membebani retarder &amp; rem. Pantau tren antar periode.');
      }
      if (engSlope && engSlope.zones) {
        var ze = engSlope.zones;
        html += statCard('Overrun mesin', fx(ze.overrunShareWorking, 2), '%',
          'rpm ≥' + esc(String(ze.thresholds.highRpm)) + ' bersamaan kemiringan ≥' +
          esc(String(ze.thresholds.steepDeg)) + '°, atas ' + fh(ze.workingHours) +
          ' jam mesin bekerja. Tinggi = engine brake dipaksa / gigi terlalu rendah.');
      }
      html += '</div>';

      html += '<p class="extras-legend">' +
        (slope && slope.zones ? esc(slope.zones.movBasisNote) + ' ' : '') +
        (engSlope && engSlope.zones ? esc(engSlope.zones.workBasisNote) : '') + '</p>';
      html += '<p class="extras-legend pt-warn">Tidak ada ambang pabrik yang dapat dirujuk untuk ' +
        'kemiringan maupun overrun pada model ini. Angka disajikan sebagai ukuran ' +
        '<strong>pembanding antar periode &amp; antar unit</strong>, bukan vonis lulus/gagal.</p>';
      html += '</div>';   // /extras-block

      if (slope && slope.zones && slope.zones.perSlope.length) {
        html += '<div class="extras-duo extras-duo--stack"><div class="extras-col">';
        html += '<h4 class="extras-sub">Sebaran kemiringan (' + esc(slope.yAxis.unit || 'deg') + ')</h4>';
        html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
          '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2">' +
          '<col class="c-diff"><col class="c-verdict"></colgroup>' +
          '<thead><tr><th scope="col">Kemiringan</th>' +
          '<th class="num" scope="col">Jam</th>' +
          '<th class="num" scope="col">Dari jendela</th>' +
          '<th class="num" scope="col">Dari waktu bergerak</th>' +
          '<th scope="col">Result / Hipotesis</th></tr></thead><tbody>';
        slope.zones.perSlope.forEach(function (p) {
          var v = { text: 'Sebaran deskriptif.', tone: 'muted' };
          if (p.movShare !== null && p.movShare >= 20) {
            v = { text: 'Porsi besar waktu bergerak ada di rentang ini — profil jalan khas unit.', tone: 'muted' };
          }
          html += '<tr><td class="mono">' + esc(p.label) + '</td>' +
            '<td class="num">' + fh(p.hours) + '</td>' +
            '<td class="num">' + fx(p.share, 2) + ' %</td>' +
            '<td class="num">' + (p.movShare === null ? '—' : fx(p.movShare) + ' %') + '</td>' +
            verdictCell(v.text, v.tone) + '</tr>';
        });
        html += '</tbody></table></div></div></div>';
      }
      html += '</div>';   // /extras-group
    }

    /* ------------- Blok C: warm-up --------------------------------------- */
    if (warm && warm.zones) {
      var zw = warm.zones;
      html += '<div class="extras-group" style="margin-top:16px"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-temperature-arrow-up"></i> ' +
        'Kebiasaan Pemanasan Mesin</h3>';
      html += '<p class="extras-legend">Satuan berkas ini adalah <strong>jumlah start mesin</strong>, ' +
        'bukan jam. Pemanasan terlalu singkat berarti oli belum mencapai suhu kerja saat unit ' +
        'mulai dibebani; terlalu lama berarti idle berlebih. ' +
        '<strong>Tidak ada ambang pabrik yang dapat dirujuk</strong> — angka disajikan ' +
        'sebagai distribusi untuk dibandingkan antar unit &amp; antar periode.</p>';
      html += '<div class="extras-stat-grid">';
      html += statCard('Total start mesin', fh(zw.startCount), 'kali', 'Sepanjang rentang data.');
      html += statCard('Pemanasan ' + esc(zw.shortWarmupLabel || 'tersingkat'),
        fx(zw.shortWarmupShare), '%', 'Band waktu pemanasan terpendek.');
      html += statCard('Pemanasan ' + esc(zw.longWarmupLabel || 'terlama'),
        fx(zw.longWarmupShare), '%', 'Band waktu pemanasan terbuka (terlama).');
      html += '</div>';
      html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
        '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2"><col class="c-verdict"></colgroup>' +
        '<thead><tr><th scope="col">Waktu pemanasan (' + esc(warm.xAxis.unit || 'min') + ')</th>' +
        '<th class="num" scope="col">Jumlah start</th>' +
        '<th class="num" scope="col">Bagian</th>' +
        '<th scope="col">Result / Hipotesis</th></tr></thead><tbody>';
      zw.buckets.forEach(function (b, i) {
        var v = { text: 'Distribusi deskriptif.', tone: 'muted' };
        if (i === 0 && b.share >= 50) {
          v = { text: 'Mayoritas start langsung dibebani setelah pemanasan singkat. ' +
            'Bandingkan dengan unit sejenis sebelum menyimpulkan.', tone: 'muted' };
        }
        html += '<tr><td class="mono">' + esc(b.label) + '</td>' +
          '<td class="num">' + fh(b.count) + '</td>' +
          '<td class="num">' + fx(b.share) + ' %</td>' +
          verdictCell(v.text, v.tone) + '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<p class="extras-legend">' + esc(zw.note) + '</p>';
      html += '</div></div>';   // /extras-block /extras-group
    }

    html += '</div>';   // /extras-stack
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* =======================================================================
   * 2b. PANEL TORQUE CONVERTER & LOCK-UP (D375A, tipe '35','34','88')
   * =====================================================================
   * Nada jujur yang ditegakkan di sini:
   *   - Band speed-ratio > 100 % disebut OVERRUN, BUKAN lock-up (J5b).
   *   - Pangsa L/U memakai DENOMINATOR WAKTU JALAN, bukan total peta T/C.
   *   - TIDAK ada vonis ambang: tidak ada angka Shop Manual D375A.
   * ===================================================================== */

  function renderTcLoadPanel() {
    var box = document.getElementById('tcload-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, tcl = global.VHMS_TCLOAD;
    var id = currentUnitId();
    if (!store || !id || !tcl || typeof store.getTcLoad !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var data = store.getTcLoad(id);
    var s = data && data.summary;
    if (!s || !s.fileCount) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-temperature-high" ' +
      'style="color:#ef4444"></i> Torque Converter &amp; Lock-up</h2>';
    html += '<p class="panel-sub">Distribusi <strong>speed ratio</strong> torque converter, ' +
      'waktu <strong>lock-up</strong>, dan frekuensi <strong>engage</strong> kopling. ' +
      'Sumbu Z berkas T/C &amp; L/U adalah <strong>detik nyata</strong>; berkas siklus ' +
      'L/U memakai satuan <strong>jumlah transisi</strong>.</p>';

    html += '<div class="extras-stack">';

    /* ---------------- Blok 1: speed ratio ---------------- */
    if (s.ratioStats) {
      var rs = s.ratioStats;
      html += '<div class="extras-group"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-gauge-high"></i> ' +
        'Distribusi Speed Ratio Torque Converter</h3>';
      html += '<p class="extras-legend">Speed ratio = putaran keluaran T/C dibagi putaran ' +
        'masuk. Ratio rendah berarti slip besar (konversi torsi tinggi, panas tinggi). ' +
        'Band <strong>&gt; 100 %</strong> dilaporkan sebagai <strong>overrun</strong> ' +
        '(kemungkinan meluncur/coasting) — <em>bukan</em> lock-up.</p>';
      html += '<div class="extras-stat-grid">';
      html += statCard('Total waktu T/C', fh(rs.hours), 'jam',
        'Seluruh jendela peta speed ratio, termasuk idle &amp; netral.');
      html += statCard('Stall (ratio tidak lebih dari ' + tcl.STALL_RATIO_MAX + ' %)',
        fx(rs.stallShare), '%', fh(rs.stallHours) +
        ' jam pada slip maksimum. Naik antar waktu = beban konverter naik.', 'warn');
      html += statCard('Ratio rendah (tidak lebih dari 60 %)', fx(rs.lowRatioShare), '%',
        fh(rs.lowRatioHours) + ' jam dengan slip besar.');
      html += statCard('Overrun (lebih dari 100 %)', fx(rs.overrunShare), '%',
        fh(rs.overrunHours) + ' jam. <strong>Bukan</strong> lock-up — lihat catatan basis.');
      html += statCard('Band puncak', esc(rs.peakBand || '—'), '',
        fx(rs.peakShare) + ' % dari waktu T/C.');
      html += '</div>';
      html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
        '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2"><col class="c-verdict"></colgroup>' +
        '<thead><tr><th scope="col">Speed ratio (%)</th>' +
        '<th class="num" scope="col">Jam</th>' +
        '<th class="num" scope="col">Bagian</th>' +
        '<th scope="col">Catatan</th></tr></thead><tbody>';
      rs.rows.forEach(function (r) {
        var note = { text: 'Distribusi deskriptif.', tone: 'muted' };
        if (/^\s*0\s*-/.test(r.label)) {
          note = { text: 'Stall converter — slip maksimum, panas maksimum.', tone: 'muted' };
        } else if (/^[\d.]+\s*-/.test(r.label)) {
          var lo = parseFloat(r.label);
          if (lo >= 100) note = { text: 'Overrun (output &gt; input). BUKAN lock-up.', tone: 'muted' };
        }
        html += '<tr><td class="mono">' + esc(r.label) + '</td>' +
          '<td class="num">' + fh(r.hours) + '</td>' +
          '<td class="num">' + fx(r.share) + ' %</td>' +
          verdictCell(note.text, note.tone) + '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<p class="extras-legend pt-note">' + esc(rs.basisNote) + '</p>';
      html += '</div></div>';
    }

    /* ---------------- Blok 2: lock-up ---------------- */
    if (s.luHours !== null && s.luHours !== undefined) {
      html += '<div class="extras-group"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-link"></i> Waktu Lock-up</h3>';
      html += '<div class="extras-stat-grid">';
      html += statCard('Jam lock-up', fh(s.luHours), 'jam',
        'Waktu dengan kopling L/U terkunci (tanpa slip).');
      if (s.luShareOfTravel !== null && s.luShareOfTravel !== undefined) {
        html += statCard('Pangsa terhadap waktu jalan', fx(s.luShareOfTravel), '%',
          'Dihitung atas ' + fh(s.travelHoursUsed) + ' jam waktu JALAN (matriks gigi). ' +
          'Ini denominator yang benar.');
      } else {
        html += statCard('Pangsa terhadap waktu jalan', 'Perlu berkas gigi', '',
          'Berkas matriks gigi (tipe 44..49) belum ada — pangsa tidak dapat dihitung. ' +
          'Menampilkan angka akan menyesatkan.', 'warn');
      }
      if (s.cycles !== null && s.cycles !== undefined) {
        html += statCard('Siklus engage', fh(s.cycles), 'kali', 'Satu siklus = ON lalu OFF.');
        html += statCard('Kerapatan engage', fx(s.engagePerLuHour, 0), 'per jam L/U',
          (s.engagePerSmrHour !== null && s.engagePerSmrHour !== undefined)
            ? fx(s.engagePerSmrHour, 1) + ' per jam SMR.' : '');
      }
      html += '</div>';
      if (s.luStats) {
        html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
          '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2"><col class="c-verdict"></colgroup>' +
          '<thead><tr><th scope="col">Beban L/U (' +
          esc((s.luStats && s.luStats.yUnit) || 'Nm') + ')</th>' +
          '<th class="num" scope="col">Jam</th>' +
          '<th class="num" scope="col">Bagian</th>' +
          '<th scope="col">Catatan</th></tr></thead><tbody>';
        s.luStats.torqueRows.forEach(function (r) {
          var isPeak = (r.label === s.luStats.peakTorqueBand);
          html += '<tr><td class="mono">' + esc(r.label) + '</td>' +
            '<td class="num">' + fh(r.hours) + '</td>' +
            '<td class="num">' + fx(r.share) + ' %</td>' +
            verdictCell(isPeak ? 'Band beban dominan saat lock-up.' : 'Distribusi deskriptif.',
              'muted') + '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<p class="extras-legend">Band <strong>median</strong>: ' +
          esc(s.luStats.medianTorqueBand || '—') + ' \u00b7 <strong>p90</strong>: ' +
          esc(s.luStats.p90TorqueBand || '—') + ' \u00b7 rpm median: ' +
          esc(s.luStats.medianRpmBand || '—') + '. Persentil dihitung dari sebaran berkas ' +
          'itu sendiri, jadi tidak memerlukan ambang pabrik.</p>';
        html += '<p class="extras-legend pt-note">' + esc(s.luStats.basisNote) + '</p>';
      }
      html += '</div></div>';
    }

    /* ---------------- Blok 3: kejujuran basis ---------------- */
    html += '<div class="extras-group"><div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-circle-info"></i> ' +
      'Batasan Penafsiran</h3>';
    html += '<p class="extras-legend pt-note"><strong>Band &gt; 100 % bukan lock-up.</strong> ' +
      'Band speed ratio di atas 100 % (overrun) pernah tampak seperti &quot;lock-up&quot;, ' +
      'tetapi peta L/U mencatat jam lock-up yang jauh lebih sedikit. Keduanya besaran berbeda.</p>';
    if (s.luShareOfRatioTotal !== null && s.luShareOfRatioTotal !== undefined) {
      html += '<p class="extras-legend pt-note"><strong>Denominator.</strong> ' +
        'Pangsa L/U terhadap total peta T/C = ' + fx(s.luShareOfRatioTotal) + ' %. Angka ini ' +
        'TIDAK dipakai karena peta T/C memuat idle, netral, dan stall — tidak sebanding ' +
        'dengan waktu jalan.</p>';
    }
    html += '<p class="extras-legend pt-note"><strong>Lintas model.</strong> HD785 memecah ' +
      'L/U per gigi; D375A hanya punya satu peta L/U agregat. Rasio dari dua topologi ' +
      'berkas berbeda TIDAK dapat dibandingkan langsung.</p>';
    html += '<p class="extras-legend pt-note"><strong>Tanpa vonis ambang.</strong> ' +
      'Tidak ada angka Shop Manual D375A yang tersedia, jadi panel ini tidak menyatakan ' +
      '&quot;normal&quot; atau &quot;abnormal&quot;. Angka sah dibandingkan antar waktu pada ' +
      'unit yang sama, atau antar unit model sama.</p>';
    html += '</div></div>';

    html += '</div>';   // /extras-stack
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* =======================================================================
   * 2c. PANEL STEERING CLUTCH & BRAKE (D375A, tipe '24'..'27')
   * =====================================================================
   * ⚠ PAGAR KEJUJURAN — inti panel ini.
   * Panel MELAPORKAN besar asimetri kiri/kanan dan BUKTI bahwa denominatornya
   * setara. Panel TIDAK menafsirkan ARAH: tidak menulis "bias menikung kiri",
   * tidak menyebut sisi yang "lebih berat", tidak merekomendasikan tindakan.
   * Alasannya: konvensi tekanan-vs-engaged belum diverifikasi dari Shop
   * Manual D375A-5. Kalimat penundaan itu WAJIB tampil (diuji `ST-9`).
   * ===================================================================== */

  /**
   * Narasi sebuah komponen (clutch/brake) dari hasil `compareSides()`.
   * SENGAJA deskriptif: hanya menyebut BESAR, tidak pernah ARAH.
   */
  function steeringVerdict(cmp) {
    if (!cmp) return { text: 'Perlu kedua sisi (kiri & kanan).', tone: 'muted' };
    if (cmp.asymActive === null || cmp.asymActive === undefined) {
      return { text: 'Rasio tidak terukur — periksa kelengkapan berkas.', tone: 'muted' };
    }
    var d = Math.abs(cmp.asymActive - 1);
    var parts = [];
    if (d < 0.05) {
      parts.push('Beban kiri dan kanan praktis SEIMBANG (' + cmp.asymActive.toFixed(2) + ').');
      parts.push('Simetri juga temuan — bukan nilai lulus.');
    } else {
      parts.push('Terdapat asimetri ' + cmp.asymActive.toFixed(2) + ' (KIRI/KANAN).');
      if (cmp.basisComparable) {
        parts.push('Waktu bergerak kedua sisi identik (' +
          Math.round(cmp.leftMovingHours) + ' h) sehingga asimetri ini NYATA, ' +
          'bukan artefak cakupan perekaman.');
      } else {
        parts.push('Cakupan waktu kedua sisi TIDAK setara — telusuri kelengkapan data ' +
          'sebelum menyimpulkan.');
      }
    }
    return { text: parts.join(' '), tone: 'muted' };
  }

  function renderSteeringBlock(title, icon, cmp, partLabel) {
    var html = '<div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid ' + icon + '"></i> ' + esc(title) + '</h3>';
    if (!cmp) {
      html += '<p class="extras-legend pt-warn">Kedua sisi belum lengkap — asimetri ' +
        'belum dapat dihitung. Unggah berkas sisi pasangannya.</p>';
      html += '</div>';
      return html;
    }

    var v = steeringVerdict(cmp);
    html += '<p class="extras-legend">' + esc(v.text) + '</p>';
    html += '<div class="extras-stat-grid">';
    html += statCard('Asimetri ' + partLabel, fx(cmp.asymActive, 2), 'KIRI/KANAN',
      '1,00 = seimbang. Rasio tanpa satuan, jadi sah dibandingkan antar waktu.');
    html += statCard('Band tekanan tertinggi', fx(cmp.asymTopBand, 2), 'KIRI/KANAN',
      'Band ' + esc(cmp.leftTopBandLabel || '—') + '. Basis lebih tajam daripada total aktif.');
    html += statCard('Waktu bergerak KIRI', fh(cmp.leftMovingHours), 'jam',
      'Denominator. Sisi KANAN ' + fh(cmp.rightMovingHours) + ' jam.');
    html += statCard('Bukti basis', fx(cmp.movingEvidenceRatio, 3), 'rasio',
      cmp.basisComparable
        ? 'Kedua sisi ~1,00 → perbandingan SAH.'
        : 'Kedua sisi tidak setara → asimetri bisa artefak.', cmp.basisComparable ? null : 'warn');
    html += '</div>';

    // Tabel tekanan per sisi (KIRI vs KANAN) pada basis bergerak.
    var L = cmp.leftStats, R = cmp.rightStats;
    if (L && R && L.pressureRows && R.pressureRows) {
      html += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
        '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2"><col class="c-diff"></colgroup>' +
        '<thead><tr><th scope="col">Tekanan</th>' +
        '<th class="num" scope="col">KIRI (jam)</th>' +
        '<th class="num" scope="col">KANAN (jam)</th>' +
        '<th class="num" scope="col">Bagian bergerak</th></tr></thead><tbody>';
      L.pressureRows.forEach(function (row, i) {
        var rrow = R.pressureRows[i] || {};
        html += '<tr><td class="mono">' + esc(row.label) + '</td>' +
          '<td class="num">' + fh(row.hours) + '</td>' +
          '<td class="num">' + fh(rrow.hours) + '</td>' +
          '<td class="num">' + fx(row.movShare) + ' %</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function renderSteeringPanel() {
    var box = document.getElementById('steering-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, st = global.VHMS_STEERING;
    var id = currentUnitId();
    if (!store || !id || !st || typeof store.getSteering !== 'function') {
      box.innerHTML = ''; box.classList.add('hidden'); return;
    }
    var data = store.getSteering(id);
    var s = data && data.summary;
    if (!s || !s.fileCount) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-arrows-left-right-to-line" ' +
      'style="color:#22c55e"></i> Steering Clutch &amp; Brake</h2>';
    html += '<p class="panel-sub">Asimetri beban kerja sisi <strong>KIRI</strong> vs ' +
      '<strong>KANAN</strong> pada sistem kemudi dozer. Sumbu Z berkas ini adalah ' +
      '<strong>detik nyata</strong>.</p>';

    html += '<div class="extras-stack">';
    html += '<div class="extras-group">';
    html += renderSteeringBlock('Steering clutch', 'fa-compress', s.clutch, 'clutch');
    html += renderSteeringBlock('Steering brake', 'fa-hand', s.brake, 'brake');
    html += '</div>';

    // Blok batasan — tempat pagar J5 ditegakkan.
    html += '<div class="extras-group"><div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-circle-info"></i> ' +
      'Batasan Penafsiran</h3>';
    html += '<p class="extras-legend pt-note"><strong>Arah sengaja TIDAK disimpulkan.</strong> ' +
      esc(s.directionNote) + '</p>';
    html += '<p class="extras-legend pt-note"><strong>Simetri bukan ambang.</strong> ' +
      'Rasio 1,00 berarti kiri dan kanan seimbang — itu temuan, bukan nilai lulus. ' +
      'Tidak ada angka pabrik yang dipakai sebagai batas.</p>';
    html += '<p class="extras-legend pt-note"><strong>Clutch vs brake bukan satu skala.</strong> ' +
      esc(s.crossPartNote) + '</p>';
    if (s.missing && s.missing.length) {
      html += '<p class="extras-legend pt-warn">Berkas belum lengkap — ' +
        esc(s.missing.join(', ')) + ' belum diunggah. Asimetri hanya muncul bila ' +
        'KEDUA sisi satu komponen tersedia.</p>';
    }
    html += '</div></div>';
    html += '</div>';   // /extras-stack

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* =======================================================================
   * 2d. PANEL BEBAN POMPA (D375A, tipe '36','37')
   * =====================================================================
   * ⚠ PAGAR J3 & pagar ART-: panel ini TIDAK memakai ambang torsi PC2000
   * (skala 7000 Nm vs D375A 700 Nm), dan TIDAK menafsirkan fungsi sirkuit
   * Pompa 1 vs Pompa 2 (belum diketahui). Rasio dilaporkan sebagai
   * perbandingan RELATIF saja.
   * ===================================================================== */

  function renderPumpLoadPanel() {
    var box = document.getElementById('pumpload-panel');
    if (!box) return;
    var store = global.VHMS_FLEET, pl = global.VHMS_PUMPLOAD;
    var id = currentUnitId();
    if (!store || !id) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    var data = (typeof store.getPumpLoad === 'function') ? store.getPumpLoad(id) : null;
    var s = data && data.summary;
    var hasPump = !!(pl && s && s.fileCount);
    // [D375A 2026-10-14 — T4] Panel ini juga menampung blok Intensitas Siklus
    // Kerja (tipe '50', opsional). Karena itu panel WAJIB tampil bila SALAH
    // SATU sumber ada — unit yang hanya punya `cyc_int0` tetap harus melihat
    // kartu siklusnya. Menjaga panel hanya atas dasar data pompa membuat blok
    // siklus tidak pernah tampil (tertangkap oleh impor-nyata, bukan uji unit).
    var cycData = (typeof store.getCycInt === 'function') ? store.getCycInt(id) : null;
    var cycSum = cycData && cycData.summary;
    var hasCyc = !!(cycSum && cycSum.totalCount);
    if (!hasPump && !hasCyc) { box.innerHTML = ''; box.classList.add('hidden'); return; }

    var html = '<h2 class="panel-title"><i class="fa-solid fa-gauge" ' +
      'style="color:#f59e0b"></i> ' + (hasPump ? 'Beban Pompa Hidraulik' : 'Intensitas Siklus Kerja') + '</h2>';
    html += '<p class="panel-sub">' +
      (hasPump ? 'Waktu operasi <strong>Pompa 1</strong> &amp; <strong>Pompa 2</strong> menurut ' +
        'torsi masukan. Sumbu Z berkas ini adalah <strong>detik nyata</strong>.' : '') + '</p>';

    html += '<div class="extras-stack">';

    function pumpBlock(title, st, tag) {
      if (!st) {
        return '<div class="extras-block"><h3 class="clutch-block-title">' +
          '<i class="fa-solid fa-circle-question"></i> ' + esc(title) + '</h3>' +
          '<p class="extras-legend pt-warn">Berkas ' + esc(tag) + ' belum diunggah.</p></div>';
      }
      var h = '<div class="extras-block">';
      h += '<h3 class="clutch-block-title"><i class="fa-solid fa-gauge-high"></i> ' +
        esc(title) + '</h3>';
      h += '<div class="extras-stat-grid">';
      h += statCard('Total waktu', fh(st.hours), 'jam', 'Seluruh jendela peta pompa ini.');
      h += statCard('Aktif', fh(st.activeHours), 'jam',
        fh(st.activeShare) + ' % — torsi di atas band terendah (' + esc(st.idleBandLabel || '—') + ').');
      h += statCard('Band torsi tertinggi terisi', esc(st.ceilingBand || '—'), '',
        'Band tertinggi yang masih punya jam: ' + fh(st.ceilingHours) + ' jam.');
      h += statCard('rpm puncak', esc(st.peakRpmBand || '—'), '',
        fx(st.peakRpmShare) + ' % waktu pompa ini.');
      h += '</div>';
      /* [AUDIT 2026-10-15 — A-1] Satuan diambil dari statistik POMPA INI
       * (`st`), bukan dari `s.p1Stats` yang TIDAK PERNAH ADA di objek
       * `summarize()` (ia mengembalikan `p1`/`p2`). Akibat lama: ekspresi
       * selalu undefined → fallback 'Nm' dipakai untuk semua model. */
      h += '<div class="clutch-heat-wrap"><table class="data extras-table">' +
        '<colgroup><col class="c-axis"><col class="c-v1"><col class="c-v2"></colgroup>' +
        '<thead><tr><th scope="col">Torsi (' + esc(st.yUnit || 'Nm') + ')</th>' +
        '<th class="num" scope="col">Jam</th>' +
        '<th class="num" scope="col">Bagian</th></tr></thead><tbody>';
      st.torqueRows.forEach(function (r) {
        h += '<tr><td class="mono">' + esc(r.label) + '</td>' +
          '<td class="num">' + fh(r.hours) + '</td>' +
          '<td class="num">' + fx(r.share) + ' %</td></tr>';
      });
      h += '</tbody></table></div>';
      h += '</div>';
      return h;
    }

    /* [D375A 2026-10-14 — T4] Blok pompa hanya bila data pompa ada. */
    if (hasPump) {
      html += '<div class="extras-group">';
      html += pumpBlock('Pompa 1', s.p1, '36');
      html += pumpBlock('Pompa 2', s.p2, '37');
      html += '</div>';

      /* Perbandingan */
      html += '<div class="extras-group"><div class="extras-block">';
      html += '<h3 class="clutch-block-title"><i class="fa-solid fa-scale-balanced"></i> ' +
        'Perbandingan Pompa 1 vs Pompa 2</h3>';
      if (s.compare && s.compare.asymPump !== null) {
        html += '<div class="extras-stat-grid">';
        html += statCard('Rasio P1/P2', fx(s.compare.asymPump, 2), '',
          'Jam AKTIF Pompa 1 dibagi Pompa 2. Rasio tanpa satuan.');
        html += statCard('Aktif P1', fh(s.compare.p1ActiveHours), 'jam', fx(s.compare.p1ActiveShare) + ' %');
        html += statCard('Aktif P2', fh(s.compare.p2ActiveHours), 'jam', fx(s.compare.p2ActiveShare) + ' %');
        html += statCard('Batas atas P2', esc(s.compare.p2CeilingBand || '—'), '',
          'Band torsi tertinggi yang pernah dicapai Pompa 2.');
      html += '</div>';
    } else {
      html += '<p class="extras-legend pt-warn">Perbandingan belum dapat dihitung — ' +
        'perlu KEDUA berkas (36 &amp; 37).</p>';
    }
    html += '</div></div>';

    /* Batasan */
    html += '<div class="extras-group"><div class="extras-block">';
    html += '<h3 class="clutch-block-title"><i class="fa-solid fa-circle-info"></i> ' +
      'Batasan Penafsiran</h3>';
    html += '<p class="extras-legend pt-note"><strong>Arti P1 vs P2 belum diketahui.</strong> ' +
      esc(s.circuitNote) + '</p>';
    html += '<p class="extras-legend pt-note"><strong>Tanpa ambang pabrik.</strong> ' +
      'Rentang torsi peta pompa D375A berbeda dari peta pompa model lain (mis. PC2000). ' +
      'Panel ini TIDAK memakai ambang torsi model lain dan tidak menyatakan ' +
      '&quot;normal&quot; atau &quot;abnormal&quot;.</p>';
    html += '</div></div>';
    }   // /if (hasPump)

    /* [D375A 2026-10-14 — T4] Intensitas siklus kerja — SATU blok kartu,
       di dalam panel pompa, TANPA panel baru (sesuai spek §7 opsi b).
       Yang dilaporkan HANYA jumlah siklus; arti sumbu amplitudo TIDAK
       ditafsirkan, dan jam TIDAK dihitung dari berkas ini. */
    {
      var cs = cycSum;
      if (cs && cs.totalCount) {
        html += '<div class="extras-group"><div class="extras-block">';
        html += '<h3 class="clutch-block-title"><i class="fa-solid fa-arrows-spin"></i> ' +
          'Intensitas Siklus Kerja</h3>';
        html += '<div class="extras-stat-grid">';
        html += statCard('Total siklus', fh(cs.totalCount), 'kali',
          'Jumlah kejadian sepanjang rentang data.');
        if (cs.cyclesPerSmrHour !== null && cs.cyclesPerSmrHour !== undefined) {
          html += statCard('Kerapatan siklus', fx(cs.cyclesPerSmrHour, 0), 'per jam',
            'Total siklus dibagi ' + fh(cs.smrHoursUsed) + ' jam operasi (SMR unit).');
        } else {
          html += statCard('Kerapatan siklus', 'Perlu SMR', '',
            'SMR unit belum tersedia — kerapatan tidak dapat dihitung.', 'warn');
        }
        html += statCard('Band amplitudo puncak', esc(cs.peakBand || '—'), '',
          fx(cs.peakShare) + ' % dari seluruh siklus.');
        html += statCard('Band interval terbanyak', esc((cs.intervalCols[0] || {}).label || '—'), '',
          fx((cs.intervalCols[0] || {}).share) + ' % siklus.');
        html += '</div>';
        html += '<p class="extras-legend pt-note"><strong>Arti sumbu amplitudo ' +
          'tidak ditafsirkan.</strong> ' + esc(cs.amplitudeNote) + '</p>';
        html += '<p class="extras-legend pt-note"><strong>Satuan berkas.</strong> ' +
          esc(cs.basisNote) + '</p>';
        html += '</div></div>';
      }
    }

    html += '</div>';   // /extras-stack
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* =======================================================================
   * 3. Orkestrasi
   * ===================================================================== */
  function renderAll() {
    try { renderGearLoadPanel(); }
    catch (e) { if (global.console) console.warn('gearload panel:', e.message); }
    try { renderDutyMapPanel(); }
    catch (e) { if (global.console) console.warn('dutymap panel:', e.message); }
    try { renderTcLoadPanel(); }
    catch (e) { if (global.console) console.warn('tcload panel:', e.message); }
    try { renderSteeringPanel(); }
    catch (e) { if (global.console) console.warn('steering panel:', e.message); }
    try { renderPumpLoadPanel(); }
    catch (e) { if (global.console) console.warn('pumpload panel:', e.message); }
  }

  global.VHMS_POWERTRAIN_RENDER = {
    renderAll: renderAll,
    renderGearLoadPanel: renderGearLoadPanel,
    renderDutyMapPanel: renderDutyMapPanel,
    renderTcLoadPanel: renderTcLoadPanel,
    renderSteeringPanel: renderSteeringPanel,
    renderPumpLoadPanel: renderPumpLoadPanel,
    // Diekspor untuk pengujian narasi tanpa DOM.
    gearVerdict: gearVerdict,
    steeringVerdict: steeringVerdict,
    lugTone: lugTone
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_POWERTRAIN_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

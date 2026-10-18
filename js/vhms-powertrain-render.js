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
    html += statCard('Lock-up', fx(s.lockupShare), '%',
      fh(s.lockupHours) + ' jam dengan kopling L/U terkunci.');
    html += statCard('Torque converter', fx(s.converterShare), '%',
      fh(s.converterHours) + ' jam lewat fluida (ada slip &amp; panas).');
    html += statCard('Gigi dominan', esc(s.dominantGear || '—'), '',
      'Gigi dengan jam terbanyak.');
    html += '</div>';

    html += splitBar(s.lockupShare, 'Lock-up', 'torque converter');
    html += '<p class="extras-legend pt-bar-legend">' +
      '<span class="pt-key pt-key-a"></span> Lock-up ' + fx(s.lockupShare) + ' % · ' +
      '<span class="pt-key pt-key-b"></span> Torque converter ' + fx(s.converterShare) + ' %</p>';

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
      '<th class="num" scope="col">Lock-up (jam)</th>' +
      '<th class="num" scope="col">Converter (jam)</th>' +
      '<th class="num" scope="col">Pangsa waktu</th>' +
      '<th scope="col">Result / Hipotesis</th>' +
      '</tr></thead><tbody>';
    s.gears.forEach(function (g) {
      var v = gearVerdict(g, s);
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
        var modeTxt = (r.mode === gl.MODE_LOCKUP) ? 'lock-up' : 'converter';
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
   * 3. Orkestrasi
   * ===================================================================== */
  function renderAll() {
    try { renderGearLoadPanel(); }
    catch (e) { if (global.console) console.warn('gearload panel:', e.message); }
    try { renderDutyMapPanel(); }
    catch (e) { if (global.console) console.warn('dutymap panel:', e.message); }
  }

  global.VHMS_POWERTRAIN_RENDER = {
    renderAll: renderAll,
    renderGearLoadPanel: renderGearLoadPanel,
    renderDutyMapPanel: renderDutyMapPanel,
    // Diekspor untuk pengujian narasi tanpa DOM.
    gearVerdict: gearVerdict,
    lugTone: lugTone
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_POWERTRAIN_RENDER;
  }
})(typeof window !== 'undefined' ? window : globalThis);

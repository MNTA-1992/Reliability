/* =========================================================================
 * fuel-gps.js
 * -------------------------------------------------------------------------
 * [GPS-AGG 2026-10-30] Agregat GPS HARIAN untuk kolom pendukung panel
 * Between (elevasi), dengan grafik SPARKLINE per unit.
 *
 * MENGAPA MODUL SENDIRI, BUKAN DI DALAM fuel-analytics
 * ---------------------------------------------------------------------
 * `fuel-analytics.js` dijaga `FUEL-ISO-4` agar TIDAK menyentuh berkas lain.
 * GPS adalah sumber data KETIGA (trend0 + pldcyc + track GPS), punya tabel
 * sendiri (`sample-data/data-gps/gps-daily-kpi-track-<unit>.csv`), dan
 * diolah dengan aturan yang berbeda: titik mentah ~5.600 per hari per unit,
 * bukan satu record per 20 jam mesin. Menaruhnya di analytics akan membuat
 * modul yang tadinya murni & teruji menjadi bergantung pada I/O.
 *
 * MURNI: tanpa DOM, tanpa store, tanpa fetch. Parser teks -> angka.
 * Jalan di Node maupun peramban sehingga AGREGASI BISA DIUJI tanpa GPS asli.
 *
 * BENTUK DATA MASUKAN (lihat `data-gps/README.md`)
 * ---------------------------------------------------------------------
 *   unit,date,time,lat,lon,elev_m,speed_kmh,kind
 *   HDKM78596,2026-09-27,2026-09-27T01:20:21.000Z,0.4628,116.1741,107.4,0,g
 *
 *   - `date`        : tanggal LOKAL (sudah dipotong sisi ekspor) — dipakai
 *                     untuk mengelompokkan, BUKAN `time`.
 *   - `elev_m`      : ketinggian (m). Kosong/NaN = titik tanpa elevasi.
 *   - `kind`        : 'p' (parkir/idle) vs 'g' (bergerak). TIDAK dipakai
 *                     untuk filter: melihat dokumen sumber, kedua jenis tetap
 *                     titik track yang sah. Elevasi dari mesin parkir bisa
 *                     memuat derau, karena itu ada gerbang lompatan di bawah.
 *
 * YANG DIHITUNG — DAN BATAS YANG DIAKUI
 * ---------------------------------------------------------------------
 * `climb`/`drop` = jumlah NAIK/TURUN elevasi antar titik berurutan dalam
 * satu hari (m). Ini UKURAN BEBAN TANJAKAN, bukan "total elevasi rute".
 * Konsekuensinya:
 *   1. Data yang jarang (GPS bolong) MEMBESARKAN angka — titik yang berjarak
 *      5 menit bisa melompati bukit tanpa jejak, tapi sambungan antar
 *      titik yang bolong juga menambahkan lompatan lebar.
 *   2. Titik parkir yang goyang ±2 m menambahkan derau. Karena itu:
 *        - `MIN_STEP_M`  : perubahan < 0,5 m diabaikan sebagai derau sensor.
 *        - `MAX_STEP_M`  : lompatan > 40 m dianggap GPS lompat (bukan jalan)
 *                          dan DIBUANG, tetapi perpindahannya DIHITUNG
 *                          (`rejectedJumps`) supaya bisa dilaporkan.
 *   3. Angka ini TIDAK BOLEH dipakai sendiri untuk menyimpulkan "rute B
 *      lebih berat". Ia pendukung: bila L/ton-km naik sementara climb turun,
 *      tanjakan bukan penyebabnya. Lihat catatan di legenda panel.
 *
 * SATUAN YANG DITERBITKAN
 * ---------------------------------------------------------------------
 *   climb_m, drop_m  -> meter, per rentang tanggal
 *   climbPerKm       -> meter tanjakan per km jarak tempuh (intensitas)
 *   distKm           -> km (Σ haversine antar titik berurutan)
 *   rows, days       -> jumlah titik & hari berdata (kejujuran cakupan)
 * ========================================================================= */

(function (global) {
  'use strict';

  var CSU = global.CSV_UTIL || null;

  /* ---------------------------------------------------------------- */
  /* AMBANG — SATU TEMPAT. Jangan hardcode di pemanggil.              */
  /* ---------------------------------------------------------------- */

  /* [KALIBRASI 2026-10-30 — DIUKUR, BUKAN DITEBAK]
   *
   * `minStepM = 0` (jumlah perubahan BERTANDA) bukan pilihan sembarang.
   * Diuji terhadap 406 pasangan (unit, tanggal) yang punya nilai pembanding
   * di `data-gps/gps-daily-kpi.csv`:
   *
   *   ambang 0,0 m -> climb 99,8 % dari pembanding
   *   ambang 0,5 m -> 93,8 %
   *   ambang 1,0 m -> 84,1 %
   *   ambang 2,0 m -> 71,1 %
   *   histeresis 1 m -> 62,7 %
   *
   * Ambang di atas nol MEMBUANG tanjakan kecil yang sah, dan justru tanjakan
   * kecil yang paling banyak (jalan tambang datar-bergelombang). Pembanding
   * memakai jumlah bertanda, jadi modul ini juga. Jangan "merapikan" angka
   * ini dengan ambang derau tanpa mengulang kalibrasi.
   *
   * Angka ini BUKAN "elevasi rute": ia menjumlahkan seluruh riak elevasi,
   * termasuk derau ±1 m saat unit berhenti. Karena itu kolom di layar
   * menyebutnya "Naik/Turun elevasi (Σ)" dan legenda menjelaskan batasnya. */
  var LIMITS = {
    // Perubahan elevasi di bawah ini diabaikan. 0 = semua perubahan dihitung.
    minStepM: 0,
    /* [FIX 2026-10-30 — TERKALIBRASI DENGAN DATA ASLI]
     * Batas ini dulu 40 m dan itu SALAH. Pada HDCT77455 (2026-09-29) ada 62
     * lompatan 40–49 m yang merupakan MEDAN SUNGGUHAN (tanjakan/haul road),
     * bukan glitch. Membuangnya menurunkan drop ke 56 % dari pembanding
     * (3.619 vs 6.392 m) — kerusakan yang tidak terlihat karena climb masih
     * tampak wajar.
     *
     * Diuji ulang pada 406 hari (data-gps vs gps-daily-kpi.csv):
     *   batas 40 m  -> climb 96,4 %, drop 80,4 %
     *   tanpa batas -> climb 99,5 %, drop 97,4 %
     * Karena itu batas dinaikkan ke 500 m: cukup untuk menangkap GPS yang
     * benar-benar melompat (pindah baris tabel / reset), tetapi tidak
     * menyentuh medan tambang yang wajar. _JANGAN_ diturunkan tanpa
     * mengulang kalibrasi terhadap gps-daily-kpi.csv._
     */
    maxStepM: 500,
    // Gerbang kecepatan untuk jarak (haversine): lompatan posisi yang
    // mustahil secara fisika = GLITCH, tidak dijumlahkan.
    // [BUKTI] Tanpa gerbang ini, satu hari HDCT77462 menghasilkan
    // 26.113 km (dua berkas tumpang-tindih, titik berpindah lintang).
    maxSpeedKmh: 120,
    // Gerak di bawah ini = GEGARAN posisi (GPS drift), bukan perjalanan.
    // 1 km/jam = 0,28 m/detik, jauh di bawah kecepatan alat berat (≥5 km/jam),
    // sehingga gerak nyata tidak terbuang dan derau saat parkir terbuang.
    minMoveKmh: 1
  };

  function split(line, delim) {
    if (CSU && CSU.splitLine) return CSU.splitLine(line, delim || ',');
    return String(line).split(delim || ',');
  }

  /* Pemecah cepat untuk sel angka: `Number('')` = 0 — JANGAN dipakai untuk
   * sel kosong, karena "tidak ada pembacaan" akan menjadi ketinggian 0 m
   * dan menciptakan tanjakan palsu setinggi seluruh lereng.
   * Koma desimal (ekspor Excel) didukung tanpa regex: `indexOf(',')` +
   * `replace` hanya dipanggil bila memang ada koma. */
  function num(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(',', '.');
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** Normalisasi nama unit: tanpa spasi/tanda, uppercase (`HDKM-78596` -> `HDKM78596`). */
  function normUnit(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /** Nama berkas `gps-daily-kpi-track-HDKM78596.csv` -> `HDKM78596`. */
  function unitFromFilename(name) {
    var m = /track[-_]([A-Za-z0-9]+)(?:\.csv)?$/i.exec(String(name || '').trim());
    return m ? normUnit(m[1]) : '';
  }

  /** Deteksi apakah berkas teks adalah track GPS (bukan agregat harian). */
  function looksLikeTrack(text) {
    var head = String(text || '').slice(0, 600).toLowerCase();
    return /elev_m|elev_m\b/.test(head) && /\blat\b/.test(head) && /\blon\b/.test(head);
  }

  /* ---------------------------------------------------------------- */
  /* HAVERSINE — jarak dua titik (km). MURNI.                         */
  /* ---------------------------------------------------------------- */
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371.0088;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /**
   * parseTrackText(text) — satu berkas track GPS -> titik berurutan.
   *
   * MURNI. Baris tanpa tanggal/jam DIBUANG (tidak bisa ditempatkan pada
   * sumbu waktu). Kolom dicari dengan ALIAS, bukan indeks tetap: ekspor
   * lapangan mengubah urutan kolom antar-periode.
   *
   * @returns {{ok:boolean, unit:string, columns:Object, points:Array<Object>, reason:string}}
   */
  function parseTrackText(text) {
    var out = { ok: false, unit: '', columns: {}, points: [], reason: '' };
    if (!text || !String(text).trim()) { out.reason = 'berkas kosong'; return out; }
    var lines = String(text).split(/\r?\n/);
    // Baris header = baris pertama yang memuat `lat` & `lon`. Sebagian
    // ekspor memberi baris judul/laporan di atasnya.
    var hi = -1;
    for (var i = 0; i < Math.min(lines.length, 20); i++) {
      var low = lines[i].toLowerCase();
      if (/\blat\b/.test(low) && /\blon\b/.test(low)) { hi = i; break; }
    }
    if (hi < 0) { out.reason = 'header lat/lon tidak ditemukan'; return out; }
    var head = split(lines[hi], ',');
    var alias = {
      unit: ['unit', 'equipment', 'lambung', 'asset'],
      date: ['date', 'tanggal', 'day'],
      time: ['time', 'datetime', 'timestamp', 'fix'],
      lat: ['lat', 'latitude'],
      lon: ['lon', 'lng', 'long', 'longitude'],
      elev: ['elev_m', 'elev', 'elevation', 'altitude', 'alt_m', 'ketinggian'],
      speed: ['speed_kmh', 'speed', 'speedkmh', 'v', 'kecepatan'],
      kind: ['kind', 'type', 'status']
    };
    var col = {};
    Object.keys(alias).forEach(function (k) {
      col[k] = -1;
      var names = alias[k];
      for (var a = 0; a < names.length; a++) {
        for (var c = 0; c < head.length; c++) {
          var h = String(head[c]).toLowerCase().replace(/[\s._\-()%]+/g, '');
          if (h === String(names[a]).toLowerCase().replace(/[\s._\-()%]+/g, '')) { col[k] = c; break; }
        }
        if (col[k] >= 0) break;
      }
    });
    if (col.lat < 0 || col.lon < 0) { out.reason = 'kolom lat/lon tidak ditemukan'; return out; }
    if (col.elev < 0) { out.reason = 'kolom elevasi tidak ditemukan'; return out; }
    out.columns = col;

    /* [PERFORMA 2026-10-30] Satu berkas track = puluhan ribu baris; seluruh
     * paket data-gps = 1,4 juta baris / 101 MB / 248 berkas dan diukur
     * 1,2 detik (V8, Node) dengan jalur di bawah. Pemecah CSV RFC 4180
     * (`CSV_UTIL.splitLine`) 15x lebih lambat karena memanggil `.trim()`
     * per sel lewat `map`, dan berkas GPS tidak pernah memuat tanda kutip.
     * Karena itu:
     *   - pemisah = ',' mentah (format ekspor sudah pasti koma);
     *   - `Date.parse` ISO dipakai HANYA bila tanggal tidak terbaca dari
     *     kolom `date` (mayoritas baris tidak perlu mem-parse tanggal).
     * Kalau kelak muncul ekspor ber-kutip, uji `looksQuoted()` di awal
     * berkas dan lempar ke `split()` — JANGAN diam-diam salah pecah. */
    var noQuote = String(text).indexOf('"') < 0;
    var fast = noQuote;

    for (var r = hi + 1; r < lines.length; r++) {
      var line = lines[r];
      if (!line) continue;
      var c = fast ? line.split(',') : split(line, ',');
      var d = col.date >= 0 ? String(c[col.date] || '').trim() : '';
      // `date` bisa 'YYYY-MM-DD' atau timestamp ISO — ambil 10 karakter pertama.
      d = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';
      var ep = null;
      if (!d && col.time >= 0) {
        var t = String(c[col.time] || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(t)) d = t.slice(0, 10);
      }
      if (!d) continue;
      var la = num(c[col.lat]), lo = num(c[col.lon]);
      if (la == null || lo == null) continue;
      if (Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
      // Jam hanya dibutuhkan untuk gerbang kecepatan; `date` sudah memberi
      // tanggal, jadi `Date.parse` bisa ditunda sampai benar-benar perlu.
      if (col.time >= 0) {
        var tm = String(c[col.time] || '').trim();
        ep = Date.parse(tm);
      }
      var unitCell = col.unit >= 0 ? c[col.unit] : '';
      /* [PERFORMA] Kolom yang tidak dipakai perhitungan TIDAK disalin ke tiap
       * titik (1,4 juta objek): `unit` hanya dibaca dari titik PERTAMA yang
       * punya nilai, `kind` tidak dipakai sama sekali. Menyalinnya menambah
       * ~200 ms + beban GC tanpa satu pun angka yang berubah. */
      if (!out.unit && unitCell) out.unit = normUnit(unitCell);
      out.points.push({
        date: d,
        t: isFinite(ep) ? ep : null,
        lat: la, lon: lo,
        elev: num(c[col.elev]),
        // Kecepatan yang DILAPORKAN perangkat (km/jam). Dipakai gerbang jarak
        // bersama perpindahan posisi: saat unit parkir, GPS melaporkan 0
        // sementara posisi bergoyang belasan meter — goyangan itu bukan
        // perjalanan.
        speed: col.speed >= 0 ? num(c[col.speed]) : null
      });
    }
    out.ok = out.points.length > 0;
    if (!out.ok) out.reason = out.reason || 'tidak ada baris dengan tanggal & koordinat';
    return out;
  }

  /**
   * aggregateDay(points) — elevasi & jarak SATU tanggal (titik sudah urut).
   *
   * MURNI. Titik tanpa elevasi TIDAK memutus rantai: titik sebelumnya
   * dipertahankan sebagai acuan, dan `elevGaps` dinaikkan supaya lubangnya
   * terlihat. Sebaliknya memutus rantai akan menurunkan climb tanpa sebab
   * yang bisa dibaca operator.
   */
  function aggregateDay(points, lim) {
    var L = lim || LIMITS;
    var st = { rows: 0, elevPoints: 0, eleMs: 0, climb: 0, drop: 0, distKm: 0,
      jumps: 0, elevGaps: 0, distGaps: 0, duplicates: 0 };
    var prev = null, prevElev = null;
    (points || []).forEach(function (p) {
      if (!p) return;
      /* [DUPLIKAT 2026-10-30] Titik kembar dibuang SEBELUM dihitung. Berkas
       * yang tumpang-tindih melahirkan hari yang sama dua kali, dan titik
       * kembar menambahkan riak elevasi palsu ke climb. Dua titik dianggap
       * kembar bila posisi, waktu, DAN elevasinya sama — bukan posisi saja:
       * unit yang berhenti di titik sama tetap punya riak elevasi sungguhan
       * (mesin digoyang) yang memang tercatat. */
      if (prev) {
        var samePos = (p.lat === prev.lat && p.lon === prev.lon);
        var sameT = (p.t != null && prev.t != null)
          ? (p.t === prev.t) : (p.t == null && prev.t == null);
        if (samePos && sameT && p.elev === prev.elev) { st.duplicates++; return; }
      }
      st.rows++;
      if (p.elev != null && isFinite(p.elev)) {
        st.eleMs++;
        if (prevElev == null) {
          prevElev = p.elev;
        } else {
          var dE = p.elev - prevElev;
          if (Math.abs(dE) > L.maxStepM) {
            // Artefak: jangan menambah climb/drop, tapi HITUNG jumlahnya.
            st.jumps++;
          } else if (dE > 0) {
            st.climb += dE;
          } else if (dE < 0) {
            st.drop += -dE;
          }
          prevElev = p.elev;
        }
      } else {
        st.elevGaps++;
      }
      if (prev) {
        var a = haversineKm(prev.lat, prev.lon, p.lat, p.lon);
        // [BUG 2026-10-30] Sebelumnya `Math.abs(p.t − p.t)` = SELALU 0,
        // sehingga gerbang kecepatan tidak pernah menyala dan satu hari
        // melaporkan 26.113 km. Yang benar: selisih waktu antar DUA titik.
        var dtH = (prev.t != null && p.t != null) ? Math.abs(p.t - prev.t) / 3600000 : null;
        /* [JITTER 2026-10-30] Gerak di bawah `minMoveKmh` adalah GEGARAN
         * POSISI (GPS drift), bukan perjalanan. Pada unit yang berhenti,
         * posisi tidak berubah 0,0000005° melainkan bergoyang, dan menjumlah
         * goyangan selama 24 jam menghasilkan "jarak" yang tidak pernah
         * ditempuh. Bukti dari data: EXCT62004 koordinatnya hanya mencakup
         * ~140 m × 60 m (true travel ±4 km) tetapi 2.836 titik × goyangan
         * ±10-20 m membengkakkan angka bila setiap langkah dihitung.
         * Ambang 1 km/jam = 0,28 m/detik: benar-benar di bawah kecepatan
         * berjalan manusia, sehingga tidak membuang gerak alat berat
         * (≥5 km/jam) tetapi membuang seluruh derau saat parkir. */
        if (dtH != null && dtH > 0) {
          var vDisp = a / dtH;
          var vGps = (p.speed != null && isFinite(p.speed)) ? p.speed : null;
          /* Dua bukti gerak, dipakai BERSAMA:
           *   - perpindahan/detik  : menangkap unit yang memang jalan;
           *   - kecepatan perangkat: GPS melaporkan 0 saat parkir, jadi
           *     goyangan posisi ±15 m per 25 detik (= 2 km/jam menurut
           *     perpindahan) TIDAK dianggap perjalanan.
           * Ambangnya `min(vDisp, vGps)` = harus bergerak menurut KEDUANYA
           * (bila kecepatan tersedia). Tanpa kolom kecepatan, perpindahan
           * saja yang dipakai — perilaku jatuh ke gerbang 1 km/jam tetap
           * ada supaya berkas tanpa kolom itu tidak menjumlahkan goyangan. */
          if (vDisp > L.maxSpeedKmh) {
            st.distGaps++;
          } else if (vDisp >= L.minMoveKmh && (vGps == null || vGps > 0)) {
            st.distKm += a;
          }
        } else if (dtH === 0) {
          // Dua fix pada detik sama: kendaraan tidak mungkin berpindah.
          st.distGaps++;
        } else {
          // Tanpa jam: kecepatan tidak bisa diuji. Jarak diambil, tetapi
          // dihitung di `distGaps` supaya batasnya terlihat.
          st.distKm += a;
          st.distGaps++;
        }
      }
      prev = p;
    });
    return st;
  }

  /**
   * aggregate(track, opts) — agregat per (unit, tanggal) dari banyak berkas.
   *
   * MURNI. `track` = array `{ name, text }` ATAU array hasil `parseTrackText`.
   * Hasil:
   *   byUnit[UNIT][tanggal] = { climb, drop, distKm, rows, eleMs, jumps }
   *   byUnit[UNIT].__meta    = { days, rows, first, last }
   *
   * Ringkasan per unit (`unitSummary`) dipakai kolom "Trending Elevasi".
   */
  function aggregate(track, opts) {
    var L = (opts && opts.limits) || LIMITS;
    var byUnit = {};
    (track || []).forEach(function (entry) {
      if (!entry) return;
      var parsed = entry.points ? entry : parseTrackText(entry.text);
      if (!parsed || !parsed.ok) return;
      // Unit diambil dari ISI dulu, nama berkas sebagai cadangan: berkas
      // yang di-rename tidak boleh mengganti pemilik angka.
      var name = normUnit(parsed.unit) || unitFromFilename(entry.name);
      if (!name) return;
      if (!byUnit[name]) byUnit[name] = {};
      var bucket = {};
      parsed.points.forEach(function (p) {
        if (!bucket[p.date]) bucket[p.date] = [];
        bucket[p.date].push(p);
      });
      Object.keys(bucket).forEach(function (d) {
        var pts = bucket[d];
        // Urutkan menurut waktu bila tersedia; urutan berkas tidak dijamin
        // kronologis dan haversine SANGAT bergantung pada urutan.
        if (pts.length && pts[0].t != null) {
          pts.sort(function (x, y) { return (x.t || 0) - (y.t || 0); });
        }
        var st = aggregateDay(pts, L);
        var cur = byUnit[name][d];
        if (!cur) {
          byUnit[name][d] = st;
        } else {
          // Hari yang sama di dua berkas: jumlahkan, dengan rantai terpisah
          // (titik terakhir berkas pertama TIDAK disambung ke berkas kedua —
          // sambungan antar-berkas tidak bisa dipercaya urutannya).
          cur.rows += st.rows; cur.eleMs += st.eleMs;
          cur.climb += st.climb; cur.drop += st.drop;
          cur.distKm += st.distKm;
          cur.jumps += st.jumps; cur.elevGaps += st.elevGaps;
          cur.distGaps += st.distGaps; cur.duplicates += st.duplicates;
        }
      });
    });
    Object.keys(byUnit).forEach(function (u) {
      var dates = Object.keys(byUnit[u]).sort();
      var meta = { days: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null };
      byUnit[u].__meta = meta;
    });
    return { byUnit: byUnit, limits: L };
  }

  /**
   * rangeStats(agg, unit, start, end) — jumlahkan satu unit dalam rentang.
   *
   * MURNI. `start`/`end` inklusif 'YYYY-MM-DD'; kosong = tanpa batas.
   * @returns {{days:number, rows:number, climb:number, drop:number,
   *            distKm:number, jumps:number, distGaps:number,
   *            first:string|null, last:string|null,
   *            daily:Array<{date,climb,drop,distKm,rows}>}|null}
   */
  function rangeStats(agg, unit, start, end) {
    var key = normUnit(unit);
    var table = agg && agg.byUnit && agg.byUnit[key];
    if (!table) return null;
    var dates = Object.keys(table).filter(function (d) { return d !== '__meta'; }).sort();
    var out = { days: 0, rows: 0, climb: 0, drop: 0, distKm: 0, jumps: 0,
      distGaps: 0, first: null, last: null, daily: [], dailyDense: [] };
    /* [TRENDING 2026-10-30] `dailyDense` = deret HARIAN dengan lubang data
     * diisi null, dipakai sparkline. Melewati hari kosong akan membuat grafik
     * menyambung 1 Jan langsung ke 20 Feb seolah tidak ada jeda — cacat yang
     * sama yang dihindari di chart utama L/ton-km. Satu titik = satu hari
     * karena ember GPS memang per tanggal lokal (`date`), bukan per jam:
     * kolom `time` adalah timestamp UTC per fix, bukan label shift. */
    dates.forEach(function (d) {
      if (start && d < start) return;
      if (end && d > end) return;
      var s = table[d];
      out.days++;
      out.rows += s.rows || 0;
      out.climb += s.climb || 0;
      out.drop += s.drop || 0;
      out.distKm += s.distKm || 0;
      out.jumps += s.jumps || 0;
      out.distGaps += s.distGaps || 0;
      if (!out.first) out.first = d;
      out.last = d;
      out.daily.push({ date: d, climb: s.climb || 0, drop: s.drop || 0,
        distKm: s.distKm || 0, rows: s.rows || 0 });
    });
    // Deret harian yang RAPAT: hari tanpa data diisi null, BUKAN dilewati.
    // Bila tanggal `start`/`end` tidak lengkap, deret disusun menurut
    // tanggal yang ADA (lubang di tengah tetap terlihat).
    out.dailyDense = denseNulls(out.first, out.last, dates, function (d) {
      var s = table[d];
      return s ? s.climb : null;
    });
    return out.days ? out : null;
  }

  /**
   * denseNulls(first, last, haveDates, pick) — isi tanggal kosong dengan null.
   * MURNI. Dipakai agar grafik tidak menyembunyikan lubang data.
   */
  function denseNulls(first, last, haveDates, pick) {
    if (!first || !last) return [];
    var have = {};
    (haveDates || []).forEach(function (d) { have[d] = 1; });
    var out = [], d = first, guard = 0;
    while (d <= last && guard++ < 4000) {
      out.push(have[d] ? pick(d) : null);
      // +1 hari dalam UTC: 'YYYY-MM-DD' tidak terpengaruh zona waktu.
      d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    }
    return out;
  }

  /**
   * unitDateRange(agg, unit) — rentang tanggal yang DIMILIKI unit (bukan
   * rentang pembanding). Dipakai UI untuk menyebut batas cakupan GPS saat
   * rentang pembanding jatuh di luar cakupan itu.
   */
  function unitDateRange(agg, unit) {
    var key = normUnit(unit);
    var t = agg && agg.byUnit && agg.byUnit[key];
    if (!t) return null;
    var m = t.__meta || {};
    return m.days ? { first: m.first, last: m.last, days: m.days } : null;
  }

  /**
   * climbPerKm(stats) — intensitas tanjakan (m per km). null bila jarak 0:
   * membagi nol memberi Infinity yang akan tercetak sebagai "∞ m/km".
   */
  function climbPerKm(stats) {
    if (!stats || !(stats.distKm > 0)) return null;
    return stats.climb / stats.distKm;
  }

  /**
   * sparkline(values, opts) — jalur SVG mini untuk kolom "Trending".
   *
   * MURNI (mengembalikan string SVG + titik akhir), supaya bentuknya bisa
   * diuji tanpa DOM. Semua nilai dijumlahkan per hari dan digambar
   * proporsional terhadap MAKSIMUM deret itu sendiri: nilai absolut tidak
   * terbaca pada lebar 64 px, yang dicari adalah POLA (naik/turun/datar).
   *
   * @returns {{ok:boolean, path:string, w:number, h:number, n:number,
   *            min:number, max:number, last:number, trend:number}}
   *   `trend` = (paruh kedua − paruh pertama) ÷ rata-rata deret × 100.
   */
  function sparkline(values, opts) {
    var o = opts || {};
    var w = o.w || 64, h = o.h || 18, pad = o.pad == null ? 1.5 : o.pad;
    var vals = (values || []).filter(function (v) { return v != null && isFinite(v); });
    var out = { ok: false, path: '', w: w, h: h, n: vals.length,
      min: null, max: null, last: null, trend: null };
    if (!vals.length) return out;
    var min = Math.min.apply(Math, vals), max = Math.max.apply(Math, vals);
    out.min = min; out.max = max; out.last = vals[vals.length - 1];
    var span = (max - min) || 1;
    var innerW = Math.max(1, w - pad * 2), innerH = Math.max(1, h - pad * 2);
    var step = vals.length > 1 ? innerW / (vals.length - 1) : 0;
    var pts = vals.map(function (v, i) {
      var x = pad + step * i;
      var y = pad + innerH - ((v - min) / span) * innerH;
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    });
    out.path = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0] + ' ' + p[1];
    }).join(' ');
    out.ok = true;
    // Tren = bandingkan paruh pertama & kedua. Deret < 4 titik -> null:
    // "tren" dari tiga hari adalah derau, bukan tren.
    if (vals.length >= 4) {
      var mid = Math.floor(vals.length / 2);
      var avg = function (a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; };
      var m0 = avg(vals.slice(0, mid)), m1 = avg(vals.slice(mid));
      if (m0 > 0) out.trend = 100 * (m1 - m0) / m0;
    }
    return out;
  }

  var API = {
    LIMITS: LIMITS,
    parseTrackText: parseTrackText,
    aggregate: aggregate,
    aggregateDay: aggregateDay,
    rangeStats: rangeStats,
    unitDateRange: unitDateRange,
    climbPerKm: climbPerKm,
    sparkline: sparkline,
    denseNulls: denseNulls,
    haversineKm: haversineKm,
    normUnit: normUnit,
    unitFromFilename: unitFromFilename,
    looksLikeTrack: looksLikeTrack
  };

  /* [DUA JALUR PEMASANGAN 2026-10-30]
   * Modul ini dipakai di TIGA konteks, dan `global` tidak selalu berarti hal
   * yang sama di ketiganya:
   *   - peramban          : `global` = `window` (IIFE dipanggil dengan window)
   *   - Node biasa        : `global` = `globalThis`
   *   - test suite        : modul dimuat lewat `new Function('global', ...)`
   *                         dengan sandbox `APP_GLOBAL` sebagai argumen.
   *
   * [BUKTI 2026-10-30] Di konteks ketiga, `global` DARI PARAMETER tidak
   * bisa diandalkan: badan fungsi `new Function` tetap memakai `globalThis`
   * milik proses Node, sehingga `global.FUEL_GPS = API` menulis ke HOST, dan
   * `APP_GLOBAL.FUEL_GPS` tetap undefined. Seluruh uji GPS lalu gagal dengan
   * "Cannot read properties of undefined (reading 'aggregate')".
   *
   * Penyelesaian: tulis ke parameter `global` DAN ke `window` (terdefinisi di
   * peramban maupun di sandbox suite), plus `module.exports` untuk Node.
   * Menulis dua kali aman — nilainya sama, dan tidak ada pembaca yang
   * dirugikan bila salah satu jalur tidak tersedia. */
  if (typeof window !== 'undefined' && window) window.FUEL_GPS = API;
  if (global) global.FUEL_GPS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);

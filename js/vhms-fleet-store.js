/* =========================================================================
 * vhms-fleet-store.js
 * -------------------------------------------------------------------------
 * Lapisan penyimpanan armada (fleet registry).
 *
 * TANGGUNG JAWAB:
 *   - Menyimpan banyak unit hasil VHMS_ANALYTICS.analyze() dalam satu map.
 *   - Memberi ID unik per unit (dari Serial No., fallback nama file).
 *   - Menyediakan AGREGASI RINGAN (fleet summary) tanpa perlu memuat ulang
 *     seluruh record untuk tampilan katalog.
 *   - Menjaga memori: record mentah boleh di-`release` bila sudah tidak
 *     dibuka, sementara ringkasan tetap tersimpan.
 *
 * DIRANCANG UNTUK SKALA 200+ UNIT:
 *   - Ringkasan (summary row) dihitung SEKALI saat unit ditambahkan, lalu
 *     dipakai untuk kartu/tabel katalog. Jadi merender tabel 200 unit
 *     tidak menyentuh 40.000+ record mentah.
 *   - Proses analitik tiap unit dapat dijalankan bertahap (chunked) agar
 *     UI tidak membeku.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;

  /* Penyimpanan internal */
  var units = {};        // id -> unit
  var order = [];        // urutan penambahan id

  /* [B2 2026-10-10] Unit yang dibuang pada restore terakhir karena datanya
   * tercemar bug fallback lama (tipe non-trend + usedFallback). Diisi ulang
   * setiap `restore()`; dibaca UI lewat `getLastPurged()`. */
  var lastPurged = [];

  /* -----------------------------------------------------------------------
   * [AUDIT 2026-10-15] STATUS PENYIMPANAN — kegagalan kuota TIDAK BOLEH SENYAP.
   * ---------------------------------------------------------------------
   * `_persist()` dulu hanya `console.warn` ketika sessionStorage penuh.
   * Akibatnya pengguna melihat unitnya tampil normal, lalu kehilangannya
   * setelah reload tanpa pernah diberi tahu. Satu unit D375A = ~400 KB
   * (sesudah perbaikan serialisasi), jadi kuota 5 MB habis di belasan unit —
   * bukan skenario teoretis.
   *
   * Status ini dibaca UI lewat `getStorageStatus()`, mengikuti pola
   * `getLastPurged()` (§2bq) yang sudah terbukti: store mencatat fakta,
   * lapisan aplikasi yang memutuskan cara menampilkannya.
   * --------------------------------------------------------------------- */
  var storageStatus = {
    ok: true,
    /** true HANYA bila penulisan terakhir gagal karena kuota. */
    quotaExceeded: false,
    /** Jumlah unit yang GAGAL tersimpan pada penulisan terakhir. */
    unitCount: 0,
    /** Ukuran payload yang hendak ditulis (perkiraan karakter). */
    bytes: 0,
    message: ''
  };

  /** Status penyimpanan terakhir (salinan — jangan dimutasi pemanggil). */
  function getStorageStatus() {
    return {
      ok: storageStatus.ok,
      quotaExceeded: storageStatus.quotaExceeded,
      unitCount: storageStatus.unitCount,
      bytes: storageStatus.bytes,
      message: storageStatus.message
    };
  }

  /**
   * Apakah galat ini benar-benar KUOTA PENUH (bukan storage mati/diblokir)?
   * Nama & kode galat berbeda antar peramban, jadi ketiganya diperiksa.
   */
  function _isQuotaError(e) {
    if (!e) return false;
    if (e.code === 22 || e.code === 1014) return true;          // legacy
    var n = String(e.name || '');
    return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED';
  }

  /**
   * [AUDIT 2026-10-15] Apakah status ini LAYAK diumumkan ke pengguna?
   *
   * Dipisah dari `announceStorageStatus()` (lapisan UI) supaya keputusannya
   * dapat diuji tanpa DOM — dan supaya aturan "jangan ulang peringatan yang
   * sama, TETAPI jangan juga membisu selamanya" hidup di satu tempat.
   *
   * ⚠ Mengapa memakai `unitCount` sebagai kunci, bukan `message`:
   *   Armada yang tumbuh melewati kuota akan gagal TERUS-MENERUS tanpa
   *   pernah kembali `ok`. Bila pengumuman hanya dijaga oleh "sudah pernah
   *   diberitahu", peringatan berhenti selamanya padahal kerugiannya masih
   *   berlangsung (bug yang tertangkap saat memverifikasi UI). `unitCount`
   *   berubah tiap armada tumbuh, jadi operator diberi tahu sekali per
   *   perubahan — cukup sering untuk bertindak, tidak cukup sering untuk
   *   diabaikan.
   *
   * @param {object} st hasil `getStorageStatus()`
   * @param {object} prev keadaan pengumuman sebelumnya { warned:boolean, units:number }
   * @returns {{announce:boolean, next:{warned:boolean, units:number}}}
   */
  function shouldAnnounceStorageStatus(st, prev) {
    prev = prev || { warned: false, units: 0 };
    if (!st || st.ok || !st.message) {
      // Normal -> buka kunci supaya kegagalan berikutnya diperingatkan lagi.
      return { announce: false, next: { warned: false, units: 0 } };
    }
    if (prev.warned && st.unitCount === prev.units) {
      return { announce: false, next: { warned: true, units: prev.units } };
    }
    return { announce: true, next: { warned: true, units: st.unitCount } };
  }

  /* [PERSISTENSI] Kunci sessionStorage untuk armada VHMS.
   * Data telemetri bertahan saat reload (dalam tab yang sama) agar pengguna
   * tidak perlu meng-upload ulang. Dihapus total lewat tombol "Kosongkan". */
  var STORAGE_KEY = 'vhms.fleet.v1';

  /* -----------------------------------------------------------------------
   * [CLC 2026-10-04] Filter Umur Komponen (Component Life Cut-off) per PILAR.
   * Modul murni COMPONENT_LIFE adalah SATU-SATUNYA pemilik logika potong.
   *
   * Desain: `unit.rawRecords` = sumber PRISTINE (tanpa potong). Setiap kali
   * analitik dijalankan, kita KLON rawRecords lalu terapkan potong pilar
   * pada klon itu. Dengan begitu:
   *   - saklar nyala/mati selalu bisa dibalik (raw tidak pernah dirusak),
   *   - re-analisa idempoten (R4): potong selalu dihitung dari raw.
   * Saat fitur NONAKTIF, records = raw apa adanya (byte-identik baseline).
   * --------------------------------------------------------------------- */
  function _clc() { return global.COMPONENT_LIFE || null; }

  /** Klon dangkal record (cukup untuk ganti nilai param; calendar dipertahankan). */
  function _cloneRecords(records) {
    return (records || []).map(function (r) {
      if (!r) return r;
      var c = {};
      for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k]; }
      // calendar: klon juga agar mutasi param tidak menyentuh objek asli.
      if (r.calendar) c.calendar = { epoch: r.calendar.epoch, tzOffsetSec: r.calendar.tzOffsetSec, display: r.calendar.display };
      return c;
    });
  }

  /**
   * Siapkan records untuk analitik: klon rawRecords lalu terapkan potong pilar
   * bila fitur CLC aktif. Mengembalikan { records, cut } (cut = ringkasan).
   */
  function _prepareRecords(rawRecords, serial) {
    var clc = _clc();
    if (!clc || typeof clc.applyVhmsPillarCut !== 'function') {
      return { records: rawRecords, cut: null };
    }
    var recs = _cloneRecords(rawRecords);
    var cut = null;
    try { cut = clc.applyVhmsPillarCut({ records: recs }, serial); }
    catch (e) { return { records: rawRecords, cut: null }; }
    return { records: recs, cut: cut };
  }

  /** Analisa satu `parsed` (records+meta) dengan potong CLC diterapkan. */
  function _analyzeParsed(parsed) {
    var analytics = global.VHMS_ANALYTICS;
    var serial = (parsed.meta && parsed.meta.serial) || '';
    var prep = _prepareRecords(parsed.records, serial);
    var analysis = analytics.analyze({
      meta: parsed.meta,
      columns: parsed.columns,
      units: parsed.units,
      records: prep.records
    });
    analysis._clcCut = prep.cut;
    // [B2 2026-10-10] Bawa metadata tipe berkas. WAJIB di sini (bukan hanya di
    // pemanggil) karena `analyze()` menimpa seluruh objek analysis — setiap
    // field yang ditambahkan pemanggil SEBELUM add() akan hilang. Titik ini
    // adalah satu-satunya tempat yang bertahan (dipakai add() & restore()).
    analysis.dataType = parsed.dataType || '';
    analysis.usedFallback = parsed.usedFallback === true;
    return analysis;
  }

  /* -----------------------------------------------------------------------
   * [AUDIT 2026-10-15] FIELD RECORD YANG TIDAK DISERIALISASI.
   * ---------------------------------------------------------------------
   * MASALAH: satu unit D375A memakan **745 KB** di sessionStorage, 99,9 %
   * darinya `parsed.records`. Kuota tipikal 5 MB habis di ~6 unit, dan
   * `_persist()` hanya bisa `console.warn` ketika penuh — artinya unggahan
   * ke-7 hilang saat reload.
   *
   * Dari 745 KB itu, DUA field menyumbang 337 KB (45 %) tanpa ada satu pun
   * pembaca di seluruh kode runtime (diverifikasi grep menyeluruh, termasuk
   * jalur tak langsung & destructuring):
   *
   *   `raw`         222 KB — SELURUH sel CSV disalin ulang sebagai STRING,
   *                 di samping nilai numerik yang sudah terpetakan. Jadi
   *                 muatan CSV tersimpan DUA KALI. Komentar aslinya
   *                 menyebut "untuk tabel semua parameter", tetapi tabel itu
   *                 ternyata membaca `r[col.param]` lewat `tableColumnsFor`,
   *                 BUKAN `raw`.
   *   `_units`      114 KB — peta paramKey->satuan yang IDENTIK di seluruh
   *                 200 record (ia metadata per-BERKAS, bukan per-baris).
   *                 Pembaca satu-satunya `getColumnUnit()` punya fallback
   *                 `cfg.PARAMS[key].unit`, dan seluruh 97 entri PARAMS yang
   *                 dipakai sebagai seri chart punya `unit` non-kosong.
   *   `calendarRaw`   4 KB — string "epoch|tz|flag". Sudah diurai menjadi
   *                 `calendar.{epoch,tzOffsetSec,display}` yang TETAP
   *                 diserialisasi; tak ada yang mengurai ulang saat restore.
   *
   * ⚠ Yang dibuang HANYA dari SERIALISASI. Objek hasil parse di memori TIDAK
   *   disentuh, sehingga perilaku sesi berjalan sama persis. `restore()`
   *   memanggil `_analyzeParsed()` yang hanya memakai `records` + `meta` +
   *   `columns`; ketiga field di atas tidak pernah dibaca di jalur itu.
   *
   * ⚠ JANGAN tambahkan field ke daftar ini tanpa membuktikan NOL pembaca.
   *   Gerbang `restore()` membangun ulang analisis dari `records`, jadi field
   *   yang dibutuhkan analitik akan hilang SENYAP (tanpa error) bila salah
   *   dibuang — kelas kesalahan yang sama dengan bug B2 (§2bq).
   * --------------------------------------------------------------------- */
  var SKIP_PERSIST_FIELDS = { raw: true, _units: true, calendarRaw: true };

  /** Serialisasi ringkas satu unit: cukup untuk re-analyze (records+meta). */
  function serializeUnit(u) {
    var a = u.analysis || {};
    // [CLC] Selalu serialisasi RAW (tanpa potong) agar potong dihitung ulang
    // saat restore — bukan disimpan dalam keadaan terpotong.
    var source = u.rawRecords || a.records || [];
    var records = source.map(function (r) {
      // Buang objek Date (calendar.date) — biarkan display/epoch tetap ada.
      var copy = {};
      for (var k in r) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        if (SKIP_PERSIST_FIELDS[k]) continue;   // [AUDIT 2026-10-15] lihat di atas
        if (k === 'calendar') {
          copy.calendar = r.calendar ? { epoch: r.calendar.epoch, tzOffsetSec: r.calendar.tzOffsetSec, display: r.calendar.display } : null;
        } else {
          copy[k] = r[k];
        }
      }
      return copy;
    });
    return {
      id: u.id,
      sourceFile: a.sourceFile || '',
      mergeCount: u.mergeCount || 1,
      // [B2 2026-10-10] Simpan `dataType` + `usedFallback` agar saat restore
      // dapat MENDETEKSI unit yang datanya tercemar oleh bug fallback lama
      // (tipe non-'40' yang memakai pemetaan kolom posisional). Tanpa keduanya,
      // unit tersimpan tidak dapat dibedakan dari unit sah.
      dataType: a.dataType || u.dataType || '',
      usedFallback: (a.usedFallback === true) || (u.usedFallback === true),
      // [T7.2 2026-10-08] Riwayat fault & ringkasannya IKUT dipersistensi agar
      // pilar EVENT (T4) dan gerbang kualitas data (T2) tetap hidup setelah
      // reload. `faultSummary` kecil; `faultEvents` diagregasi bila >200 event.
      faultSummary: u.faultSummary || null,
      faultEvents: compactFaultEvents(u.faultEvents),
      maskReport: u.maskReport || null,
      // [T8 2026-10-09] Matriks beban clutch (HD785). Kecil & tanpa SMR,
      // jadi aman dipersistensi apa adanya. `null` bila unit tak punya.
      clutchMatrix: u.clutchMatrix || null,
      // [T12 2026-10-10] Sumber data PC2000. Load Map & Op. Availability
      // kecil (matriks 8×17 / 100 jendela). Snapshot lebih besar
      // (162×51) -> disimpan TERPOTONG (lihat `compactSnapshot`) agar
      // kuota sessionStorage tidak jebol bila banyak unit.
      loadMap: u.loadMap || null,
      opAvailability: u.opAvailability || null,
      // [D375A 2026-10-13] Matriks perpindahan gigi (7x7). Kecil & tanpa SMR,
      // jadi aman dipersistensi apa adanya — sama seperti clutchMatrix.
      shiftMap: u.shiftMap || null,
      // [HD785 2026-10-14] Matriks beban per gigi (13 berkas x 8x9) & peta
      // duty (5 berkas). Keduanya kecil & tanpa SMR -> aman apa adanya.
      // 13 x 72 sel = 936 angka; jauh di bawah snapshot (162x51) yang justru
      // harus dipotong. Tidak perlu `compact*`.
      gearLoad: u.gearLoad || null,
      dutyMap: u.dutyMap || null,
      // [D375A 2026-10-14 — T1] Tiga berkas T/C & L/U ('35','34','88').
      // Kecil (8x9 + 2x2) & tanpa SMR -> aman apa adanya, tidak perlu compact.
      tcLoad: u.tcLoad || null,
      // [D375A 2026-10-14 — T2] Empat berkas steering clutch/brake (8x9).
      // Kecil & tanpa SMR -> aman apa adanya.
      steering: u.steering || null,
      // [D375A 2026-10-14 — T3] Dua berkas beban pompa (8x9).
      pumpLoad: u.pumpLoad || null,
      // [D375A 2026-10-14 — T4] Cycle interval (11x2, satuan HITUNGAN).
      cycInt: u.cycInt || null,
      snapshots: compactSnapshots(u.snapshots),
      parsed: { records: records, meta: a.meta || {}, columns: a.columns || [] }
    };
  }

  /** Ambang jumlah event sebelum `faultEvents` diagregasi per (code, bulan). */
  var FAULT_EVENT_COMPACT_LIMIT = 200;

  /**
   * [T7.2] Ringkas `faultEvents` untuk penyimpanan bila terlalu besar.
   * 600 event x N unit bisa melebihi kuota sessionStorage. Di atas ambang,
   * kita simpan agregat per (code, bulan) — cukup untuk tampilan daftar
   * event tanpa membawa seluruh 600 baris.
   * @param {array} events
   * @returns {array} event asli, atau agregat ber-tanda `_aggregated: true`
   */
  function compactFaultEvents(events) {
    if (!events || !events.length) return [];
    if (events.length <= FAULT_EVENT_COMPACT_LIMIT) return events;

    var buckets = {};
    events.forEach(function (e) {
      if (!e || !e.code) return;
      var bulan = '';
      if (e.fromEpoch !== null && e.fromEpoch !== undefined) {
        var d = new Date(e.fromEpoch * 1000);
        if (!isNaN(d.getTime())) bulan = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
      }
      var key = e.code + '|' + bulan;
      if (!buckets[key]) {
        buckets[key] = {
          _aggregated: true, code: e.code, msg: e.msg || '', month: bulan,
          fromEpoch: e.fromEpoch, toEpoch: e.toEpoch,
          count: 0, occurrences: 0, active: false, durationSec: 0
        };
      }
      var b = buckets[key];
      b.count += (e.count === null || e.count === undefined) ? 1 : e.count;
      b.occurrences += 1;
      if (e.active) { b.active = true; b.toEpoch = null; }
      if (e.durationSec !== null && e.durationSec !== undefined) b.durationSec += e.durationSec;
      if (e.fromEpoch !== null && e.fromEpoch !== undefined && (b.fromEpoch === null || e.fromEpoch < b.fromEpoch)) {
        b.fromEpoch = e.fromEpoch;
      }
    });
    var out = [];
    Object.keys(buckets).forEach(function (k) { out.push(buckets[k]); });
    out.sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* -----------------------------------------------------------------------
   * [T12 2026-10-10] Kompresi snapshot untuk persistensi.
   * ---------------------------------------------------------------------
   * Snapshot berisi ~162 titik × ~51 kolom — cukup besar bila banyak unit.
   * Untuk persistensi kita simpan hanya bagian yang dipakai UI & analisis:
   *   - `time` + seri kolom yang PENTING (puncak + pemicu + stuck),
   *   - ringkasan & daftar kolom stuck tetap utuh,
   *   - `series` penuh DIBUANG bila melebihi batas (dapat dimuat ulang
   *     dengan mengunggah berkasnya kembali).
   * Struktur kunci TIDAK diubah agar pemanggil tetap bekerja.
   * --------------------------------------------------------------------- */
  var SNAPSHOT_SERIES_LIMIT = 80;    // titik per kolom yang disimpan
  var SNAPSHOT_MAX_SNAPSHOTS = 4;    // per unit

  function compactSnapshots(snaps) {
    if (!snaps || !snaps.length) return [];
    var list = snaps.slice(-SNAPSHOT_MAX_SNAPSHOTS);
    return list.map(function (s) {
      var out = {
        dataType: s.dataType, dataTitle: s.dataTitle,
        trigger: s.trigger, samplingTime: s.samplingTime,
        columns: s.columns, units: s.units, rates: s.rates, divisors: s.divisors,
        rowCount: s.rowCount, stuck: s.stuck, summary: s.summary,
        warnings: s.warnings || [], _key: s._key,
        sourceFile: s.sourceFile || '', attachedAt: s.attachedAt || null,
        _expanded: false
      };
      // Simpan seri hanya bila total titik di bawah batas total.
      var totalPts = s.rowCount * (s.columns ? s.columns.length : 0);
      if (totalPts <= SNAPSHOT_SERIES_LIMIT * 8 && s.series) {
        out.series = s.series;
        out.time = s.time;
        out._expanded = true;
      } else if (s.series) {
        // Simpan sebagian: kolom yang punya puncak/stuck + sumbu waktu.
        var keep = {};
        var want = {};
        (s.summary && s.summary.stuckColumns ? s.summary.stuckColumns : []).forEach(function (k) { want[k] = true; });
        // [2026-10-12] `peaks` kini memuat SEMUA kolom, jadi hanya kolom
        // bertanda `key` yang serinya disimpan — kalau tidak, kompresi batal
        // dan kuota sessionStorage jebol.
        if (s.summary && s.summary.peaks) {
          Object.keys(s.summary.peaks).forEach(function (k) {
            if (s.summary.peaks[k] && s.summary.peaks[k].key) want[k] = true;
          });
        }
        (s.columns || []).forEach(function (k, i) {
          if (i === 0 || want[k]) keep[k] = (s.series[k] || []).slice(0, SNAPSHOT_SERIES_LIMIT);
        });
        out.series = keep;
        out.time = (s.time || []).slice(0, SNAPSHOT_SERIES_LIMIT);
        out._expanded = false;
      }
      return out;
    });
  }

  /* -----------------------------------------------------------------------
   * [T7.2 2026-10-08] Akses storage lewat helper.
   * ---------------------------------------------------------------------
   * [MIGRASI 2026-10-19] Pindah dari sessionStorage ke localStorage agar
   * data BERTAHAN saat browser ditutup & dibuka kembali di hari berbeda.
   * Data hanya hilang saat user klik "Kosongkan Semua".
   *
   * Migrasi otomatis: jika data lama ada di sessionStorage, pindahkan ke
   * localStorage sekali, lalu hapus dari sessionStorage.
   * --------------------------------------------------------------------- */
  function _store() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* lanjut ke fallback */ }
    try {
      return global.localStorage || null;
    } catch (e2) { return null; }
  }

  // Migrasi sekali: sessionStorage → localStorage
  (function _migrateFromSession() {
    try {
      if (typeof sessionStorage === 'undefined' || !sessionStorage) return;
      if (typeof localStorage === 'undefined' || !localStorage) return;
      var old = sessionStorage.getItem(STORAGE_KEY);
      if (old && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, old);
      }
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* abaikan — migrasi best-effort */ }
  })();

  /**
   * Tulis seluruh armada ke storage.
   *
   * Tetap best-effort — kegagalan menyimpan TIDAK boleh menggagalkan analisis
   * yang sudah tampil di layar. Tetapi sejak [AUDIT 2026-10-15] kegagalan itu
   * DICATAT di `storageStatus` supaya UI dapat memberi tahu pengguna bahwa
   * datanya tidak akan bertahan setelah reload.
   */
  function _persist() {
    var st = _store();
    if (!st) {
      storageStatus = {
        ok: false, quotaExceeded: false, unitCount: order.length, bytes: 0,
        message: 'Penyimpanan peramban tidak tersedia; data hilang saat halaman dimuat ulang.'
      };
      return;
    }
    if (!order.length) {
      try { st.removeItem(STORAGE_KEY); } catch (e0) { /* tak ada yang bisa dilakukan */ }
      storageStatus = { ok: true, quotaExceeded: false, unitCount: 0, bytes: 0, message: '' };
      return;
    }
    var payload = '';
    try {
      var data = { units: order.map(function (id) { return serializeUnit(units[id]); }), ts: Date.now() };
      payload = JSON.stringify(data);
      st.setItem(STORAGE_KEY, payload);
      storageStatus = {
        ok: true, quotaExceeded: false, unitCount: order.length,
        bytes: payload.length, message: ''
      };
    } catch (e) {
      var quota = _isQuotaError(e);
      /* Kunci lama kini BASI: ia memuat armada versi sebelumnya yang lebih
       * kecil. Membiarkannya membuat reload memulihkan keadaan yang TIDAK
       * sesuai layar — lebih menyesatkan daripada tidak ada data sama sekali.
       * Dihapus supaya kondisinya jujur: tersimpan seluruhnya, atau tidak. */
      try { st.removeItem(STORAGE_KEY); } catch (e2) { /* abaikan */ }
      storageStatus = {
        ok: false,
        quotaExceeded: quota,
        unitCount: order.length,
        bytes: payload.length,
        message: quota
          ? ('Kuota penyimpanan peramban penuh (' + Math.round(payload.length / 1024) +
             ' KB untuk ' + order.length + ' unit). Analisis di layar TETAP berjalan, ' +
             'tetapi data TIDAK akan bertahan setelah halaman dimuat ulang. ' +
             'Kosongkan unit yang tidak diperlukan, atau tangani satu unit sekaligus.')
          : ('Gagal menyimpan armada ke penyimpanan peramban: ' + (e && e.message) +
             '. Data di layar tetap berjalan, tetapi tidak bertahan setelah dimuat ulang.')
      };
      if (global.console && console.warn) console.warn(storageStatus.message);
    }
  }

  /**
   * Pulihkan armada dari storage dengan MENGANALISIS ULANG tiap unit.
   * Dipanggil sekali saat inisialisasi aplikasi.
   * @returns {boolean} true bila ada unit yang berhasil dipulihkan
   */
  function restore() {
    var st = _store();
    if (!st) return false;
    var raw;
    try { raw = st.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !data.units || !data.units.length) return false;

    var analytics = global.VHMS_ANALYTICS;
    if (!analytics || typeof analytics.analyze !== 'function') return false;

    units = {}; order = [];
    var restored = 0;
    var purged = [];
    data.units.forEach(function (su) {
      try {
        // [B2 2026-10-10 — MIGRASI] Buang unit yang datanya tercemar bug
        // fallback lama SEBELUM dianalisis.
        //
        // LATAR: sebelum T1, `VHMS_PARSER` memakai pemetaan kolom POSISIONAL
        // untuk tipe yang bukan trend mesin (`30` Load Map, `60` Snapshot,
        // dst). Akibatnya unit menyimpan `blowbyMax`/`coolantTemp`/
        // `oilPressHMin` berisi ANGKA FREKUENSI load map — nilai palsu yang
        // merusak ranking armada secara senyap.
        //
        // GERBANG: unit hanya dibuang bila KEDUA syarat terpenuhi:
        //   1. `usedFallback === true` (parser memang jatuh ke posisional), DAN
        //   2. `dataType` BUKAN '40'/'' (bukan trend mesin yang sah).
        // Trend mesin ('40') yang memakai fallback TETAP SAH (sebagian
        // eksport lama memang tanpa baris nama kolom) -> TIDAK dibuang.
        //
        // Bila `usedFallback` tidak tersimpan (data pra-B2), JANGAN membuang
        // apa pun — lebih baik membiarkan data lama daripada menghapus data
        // sah karena metadata yang tidak ada.
        var dt = String(su.dataType || '').trim();
        var isTrendType = (dt === '' || dt === '40');
        if (su.usedFallback === true && !isTrendType) {
          purged.push({ id: su.id, dataType: dt, sourceFile: su.sourceFile || '' });
          return;   // lewati unit tercemar
        }

        var analysis = _analyzeParsed({
          meta: su.parsed.meta, columns: su.parsed.columns, units: su.parsed.units,
          records: su.parsed.records,
          // [B2] Bawa metadata tersimpan (bila ada; data pra-B2 -> ''/false).
          dataType: su.dataType, usedFallback: su.usedFallback
        });
        analysis.sourceFile = su.sourceFile || '';
        var id = buildUnitId(analysis, su.sourceFile);
        var unit = {
          id: id,
          analysis: analysis,
          rawRecords: su.parsed.records || [],
          summaryRow: buildSummaryRow(id, analysis),
          loadedAt: Date.now(),
          mergeCount: su.mergeCount || 1,
          dataType: analysis.dataType,
          usedFallback: analysis.usedFallback,
          // [T7.2] Pulihkan riwayat fault + ringkasan + laporan mask.
          faultEvents: su.faultEvents || null,
          faultSummary: su.faultSummary || null,
          maskReport: su.maskReport || null,
          // [T8 2026-10-09] Pulihkan matriks beban clutch (HD785).
          clutchMatrix: su.clutchMatrix || null,
          // [T12 2026-10-10] Pulihkan sumber data PC2000.
          loadMap: su.loadMap || null,
          opAvailability: su.opAvailability || null,
          // [D375A 2026-10-13] Pulihkan matriks perpindahan gigi.
          shiftMap: su.shiftMap || null,
          // [HD785 2026-10-14] Pulihkan beban per gigi & peta duty.
          gearLoad: su.gearLoad || null,
          dutyMap: su.dutyMap || null,
          // [D375A 2026-10-14 — T1] Pulihkan T/C & L/U.
          tcLoad: su.tcLoad || null,
          // [D375A 2026-10-14 — T2] Pulihkan steering clutch/brake.
          steering: su.steering || null,
          // [D375A 2026-10-14 — T3] Pulihkan beban pompa.
          pumpLoad: su.pumpLoad || null,
          // [D375A 2026-10-14 — T4] Pulihkan cycle interval.
          cycInt: su.cycInt || null,
          snapshots: su.snapshots || []
        };
        if (!units[id]) order.push(id);
        units[id] = unit;
        // Terapkan kembali gerbang kualitas data atas records yang dipulihkan.
        if (unit.faultEvents && unit.faultEvents.length) _applyMaskForUnit(unit);
        // [T7.2] faultSummary dapat dihitung ulang bila hilang, tetapi bila
        // ada kita PAKAI yang tersimpan (sudah terkalibrasi saat upload).
        if (!unit.faultSummary && unit.faultEvents && global.VHMS_FAULT) {
          unit.faultSummary = global.VHMS_FAULT.summarize(unit.faultEvents, {
            smrRange: analysis.smrRange || null, maskReport: unit.maskReport
          });
        }
        restored++;
      } catch (e) {
        if (global.console && console.warn) console.warn('Gagal memulihkan unit VHMS:', e && e.message);
      }
    });
    // Laporkan bila ada unit dibuang (jangan senyap) — pemanggil dapat
    // menampilkan toast agar operator tahu perlu unggah ulang.
    if (purged.length && global.console && console.warn) {
      console.warn('[B2] ' + purged.length + ' unit dibuang karena data tercemar ' +
        'fallback lama: ' + purged.map(function (p) { return (p.sourceFile || p.id) + '(' + p.dataType + ')'; }).join(', '));
    }
    lastPurged = purged;
    _persist();
    return restored > 0;
  }

  /**
   * [B2 2026-10-10] Daftar unit yang dibuang saat restore terakhir karena
   * datanya tercemar bug fallback lama. Dipakai UI untuk memberi tahu operator
   * bahwa berkas perlu diunggah ulang.
   * @returns {array} [{ id, dataType, sourceFile }]
   */
  function getLastPurged() { return lastPurged.slice(); }

  /* -----------------------------------------------------------------------
   * Identitas unit
   * --------------------------------------------------------------------- */

  /**
   * Bangun ID unit yang stabil & unik dari metadata CSV.
   * Prioritas: Serial No. + Model. Bila kosong, pakai nama file.
   * Bila masih bentrok (unit yang sama di-upload dua kali), tambah suffix.
   */
  function buildUnitId(analysis, sourceName) {
    var m = analysis.meta || {};
    var serial = (m.serial || '').trim();
    var model = (m.model || '').trim();
    var base;

    if (serial) {
      base = (model ? model + '-' : '') + serial;
    } else if (sourceName) {
      base = sourceName.replace(/\.[^.]+$/, '');   // buang ekstensi
    } else {
      base = 'UNIT-' + (order.length + 1);
    }

    // Bersihkan karakter aneh agar aman dipakai sebagai ID
    base = base.replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!base) base = 'UNIT-' + (order.length + 1);

    // Pastikan unik
    var id = base;
    var n = 2;
    while (units[id]) { id = base + '#' + n; n++; }

    return id;
  }

  /* -----------------------------------------------------------------------
   * Ringkasan ringan per unit (dihitung sekali)
   * --------------------------------------------------------------------- */

  /**
   * [T4.5] Ambil ringkasan fault sebuah unit untuk katalog.
   * Dibaca dari `units[id]` (sumber kanonik) — BUKAN dihitung ulang, agar
   * katalog tidak memicu analitik mahal pada 200+ unit.
   * @returns {object|null}
   */
  function _faultSummaryFor(id, analysis) {
    var u = units[id];
    if (u && u.faultSummary) return u.faultSummary;
    // Saat buildSummaryRow dipanggil dari add() untuk unit BARU, `units[id]`
    // belum terisi. Pada kasus itu kita pakai event yang dititipkan.
    if (analysis && analysis._faultEvents && global.VHMS_FAULT) {
      return global.VHMS_FAULT.summarize(analysis._faultEvents, {
        smrRange: analysis.smrRange || null
      });
    }
    return null;
  }

  /**
   * Susun objek ringkasan yang cukup untuk katalog Home.
   * Menyimpan hanya angka yang dibutuhkan, BUKAN seluruh record.
   */
  function buildSummaryRow(id, analysis) {
    var m = analysis.meta || {};
    var s = analysis.summary || {};
    var h = analysis.health || {};

    function pick(key, field) {
      return (s[key] && s[key][field] !== undefined) ? s[key][field] : null;
    }

    // Hitung jumlah anomali per tingkat
    var nCrit = 0, nWarn = 0;
    (analysis.anomalies || []).forEach(function (a) {
      if (a.status === 'CRITICAL') nCrit++;
      else if (a.status === 'CAUTION' || a.status === 'WARNING') nWarn++;
    });

    // Anomali paling berat (untuk highlight di katalog)
    var top = (analysis.anomalies || [])[0] || null;

    // [FIX 2026-10-08] Ringkasan fault dibaca SEKALI di sini lalu dipakai
    // untuk dua hal: skor prioritas katalog (rankScore) dan sel Event/Alarm.
    // Dulu rankScore memanggil scoreUnit() TANPA faultSummary sehingga skor
    // katalog berbeda dengan skor halaman Unit Comparison pada unit ber-fault.
    var faultSum = null;
    try { faultSum = _faultSummaryFor(id, analysis); } catch (e) { faultSum = null; }

    // [POIN 6] Flag pilar Engine critical — dipakai untuk mengurutkan katalog
    // agar unit dengan Engine critical berada paling atas.
    var engineCritical = 0, engineWarning = 0;
    (analysis.anomalies || []).forEach(function (a) {
      var pillar = cfg.RANKING_PILLARS ? cfg.RANKING_PILLARS[a.param] : null;
      if (pillar === 'ENGINE') {
        if (a.status === 'CRITICAL') engineCritical++;
        else if (a.status === 'CAUTION' || a.status === 'WARNING') engineWarning++;
      }
    });

    // [FITUR 2026-10-15] Ringkasan per PILAR/kompartemen untuk tombol pilar
    // dinamis di Equipment List. Dihitung SEKALI di sini (saat unit di-analyze)
    // agar katalog 200+ unit tidak memicu analitik mahal berulang.
    //   status : tingkat terburuk pilar ('CRITICAL' | 'CAUTION' | null bila
    //            pilar hanya punya parameter normal / tidak ada anomali)
    //   count  : jumlah parameter melewati ambang pada pilar ini
    //   crit   : jumlah parameter berstatus CRITICAL
    //   warn   : jumlah parameter berstatus CAUTION/WARNING
    //   params : daftar { param, status, value, unit, title } untuk kolom KPI
    //   recorded: jumlah parameter pilar yang TEREKAM (untuk bedakan "NORMAL"
    //             vs "tidak ada data pilar ini" — kejujuran data).
    var byPillar = {};
    (analysis.anomalies || []).forEach(function (a) {
      var pillar = (cfg.RANKING_PILLARS ? cfg.RANKING_PILLARS[a.param] : null) || 'OTHER';
      if (!byPillar[pillar]) {
        byPillar[pillar] = { status: null, count: 0, crit: 0, warn: 0, recorded: 0, params: [] };
      }
      var b = byPillar[pillar];
      b.count++;
      var isCrit = (a.status === 'CRITICAL');
      var isWarn = (a.status === 'CAUTION' || a.status === 'WARNING');
      if (isCrit) { b.crit++; b.status = 'CRITICAL'; }
      else if (isWarn) { b.warn++; if (b.status !== 'CRITICAL') b.status = 'CAUTION'; }
      b.params.push({
        param: a.param,
        status: a.status,
        value: (a.value === undefined ? null : a.value),
        unit: a.unit || '',
        title: a.title || a.param
      });
    });
    // Tandai `recorded`: pilar yang PUNYA parameter terekam (ada di summary),
    // meski tidak melewati ambang. Ini membedakan "NORMAL (terpantau)" dari
    // "tidak ada data pilar ini di unit tsb" — kejujuran data.
    Object.keys(s || {}).forEach(function (k) {
      var pillar = (cfg.RANKING_PILLARS ? cfg.RANKING_PILLARS[k] : null) || 'OTHER';
      if (!byPillar[pillar]) {
        byPillar[pillar] = { status: null, count: 0, crit: 0, warn: 0, recorded: 0, params: [] };
      }
      byPillar[pillar].recorded++;
    });

    // [POIN 6] Skor prioritas katalog.
    // Idealnya = skor criticality window sesungguhnya (VHMS_RANKING), agar
    // urutan katalog konsisten dengan halaman Unit Comparison. Dioptimasi:
    // dihitung SEKALI saat unit ditambahkan. Bila modul ranking belum siap,
    // pakai proxy dari health + engine critical.
    var rankScore = (function () {
      var R = global.VHMS_RANKING;
      if (R && typeof R.scoreUnit === 'function') {
        try {
          var sc = R.scoreUnit(id, analysis, faultSum || undefined);
          if (sc && typeof sc.score === 'number' && !isNaN(sc.score)) return sc.score;
        } catch (e) { /* fallback di bawah */ }
      }
      var h = analysis.health || {};
      var s = (h.critical * 100 + h.warning * 60 + h.normal * 20) / Math.max(1, h.total || 1);
      return Math.round((100 - s) * 10) / 10 + engineCritical * 8;
    })();

    return {
      id: id,
      serial: m.serial || '',
      model: m.model || '',
      // [POIN 1] Keluarga produk (EXCAVATOR/TRUCK/DOZER/UNKNOWN)
      familyId: analysis.familyId || 'UNKNOWN',
      engineModel: m.engineModel || '',
      productGroup: m.productGroup || '',
      sourceFile: analysis.sourceFile || '',
      // [POIN 4] Nomor Lambung hasil lookup Database Unit (SN -> Lambung)
      lambung: (function () {
        var db = global.VHMS_UNITDB;
        return (db && db.getLambung) ? (db.getLambung(m.serial) || null) : null;
      })(),
      recordCount: (analysis.records || []).length,
      smrLast: analysis.smrRange ? analysis.smrRange.last : null,
      smrMin: analysis.smrRange ? analysis.smrRange.min : null,
      smrMax: analysis.smrRange ? analysis.smrRange.max : null,
      lastTimestamp: analysis.lastTimestamp || null,

      healthScore: h.score,
      healthLabel: h.label,
      nNormal: h.normal,
      nWarning: h.warning,
      nCritical: h.critical,

      anomalyCount: (analysis.anomalies || []).length,
      nCritThresholds: nCrit,
      nWarnThresholds: nWarn,
      // [POIN 6] sinyal prioritas katalog
      engineCritical: engineCritical,
      engineWarning: engineWarning,
      rankScore: rankScore,
      // [FITUR 2026-10-15] Ringkasan per pilar untuk tombol pilar dinamis
      // Equipment List (Engine/Transmission/Hydraulic/Cooling/Brake).
      byPillar: byPillar,
      // [T4.5 2026-10-08] Baris "Event/Alarm" pada katalog: jumlah event,
      // kode paling sering, dan penanda data tidak layak (R4 — bukan skor 0).
      fault: (function () {
        var fs = faultSum;
        if (!fs) return null;
        return {
          eventCount: fs.eventCount,
          recurrence: fs.recurrence,
          activeCount: fs.activeCount,
          distinctCodes: fs.distinctCodes,
          topCode: fs.topCode ? fs.topCode.code : null,
          topMsg: fs.topCode ? fs.topCode.msg : null,
          faultScore: fs.faultScore,
          dataUnfit: !!fs.dataUnfit
        };
      })(),
      topAnomaly: top ? { title: top.title, param: top.param, status: top.status, value: top.value, unit: top.unit } : null,

      // [RUL] Sisa jam operasi terpendek (paling urgent)
      urgentRUL: analysis.urgentRUL || null,

      // KPI kunci untuk kolom ringkas di katalog
      // [REVISI 2026-10-19] Nilai utama = LAST (kondisi terkini), bukan MAX.
      // Peak window disimpan terpisah untuk alert badge di tabel.
      kpi: {
        blowbyMax: pick('blowbyMax', 'last'),
        hydTempMax: pick('hydTempMax', 'last'),
        coolantMax: pick('coolantTemp', 'last'),
        engOilTempMax: pick('engOilTemp', 'last'),
        oilPressMin: pick('oilPressMax', 'last'),
        oilPressHMin: (function () {
          var h = pick('oilPressHMin', 'last');
          return h !== null ? h : pick('oilPressMax', 'last');
        })(),
        fuelAvg: pick('fuelRate', 'avg'),
        powerAvg: pick('engPowerAve', 'avg')
      },

      // Peak window values — untuk alert badge (⚠) di fleet table
      kpiPeak: {
        blowbyMax: pick('blowbyMax', 'max'),
        hydTempMax: pick('hydTempMax', 'max'),
        coolantMax: pick('coolantTemp', 'max'),
        engOilTempMax: pick('engOilTemp', 'max'),
        oilPressMin: pick('oilPressMax', 'min'),
        oilPressHMin: (function () {
          var h = pick('oilPressHMin', 'min');
          return h !== null ? h : pick('oilPressMax', 'min');
        })(),
      },

      // [FIX 2026-10-15] Nilai KPI untuk kolom kompartemen (Engine /
      // Transmission / Hydraulic). Dulu kolom-kolom itu SELALU "—" karena
      // `kpi` di atas hanya memuat 8 field tetap, sedangkan param pilar
      // (tcOilTempMax, tmMainPressMax, pump1F, fanPumpF, ...) tidak pernah
      // ikut disimpan — padahal datanya ADA di `analysis.summary`.
      //
      // [REVISI 2026-10-19] pillarKpi: nilai TERAKHIR (bukan max/min window).
      // Arah min/max hanya untuk menentukan PEAK alert, bukan nilai display.
      pillarKpi: (function () {
        var out = {};
        var TH = cfg.THRESHOLDS || {};
        function put(key) {
          if (Object.prototype.hasOwnProperty.call(out, key)) return;
          var st = s[key];
          if (!st || !st.count) { out[key] = null; return; }
          out[key] = st.last;   // kondisi terkini
        }
        (cfg.PILLAR_CATALOG || []).forEach(function (p) {
          var keys = cfg.pillarParamsOf ? cfg.pillarParamsOf(p.pillarKey) : (p.kpi || []);
          keys.forEach(put);
        });
        return out;
      })()
    };
  }

  /* -----------------------------------------------------------------------
   * Operasi CRUD
   * --------------------------------------------------------------------- */

  /**
   * Tambahkan (atau GABUNGKAN) satu unit dari hasil analyze().
   *
   * [MERGE] Bila Serial No. sudah ada di armada, unit yang baru TIDAK menimpa.
   * Sebaliknya, record-nya DIGABUNG dengan record unit lama berdasarkan SMR:
   *   - SMR sama  -> data terbaru (file terakhir diupload) menang.
   *   - SMR beda  -> record ditambahkan (data lanjutan).
   * Setelah merge, analitik & ringkasan dihitung ulang.
   *
   * @returns {object} { id, merged: boolean, addedRecords: number }
   */
  function add(analysis, sourceName) {
    // Cari unit existing berdasarkan SN + Model (kunci identitas unit).
    var existingId = findUnitIdBySerial(analysis);
    var id, merged = false, addedRecords = 0;
    // [T7.2] Data fault opsional yang dititipkan pemanggil (vhms-app) pada
    // objek analysis sebelum add(). Tidak mengubah analitik trend.
    var incomingFaultEvents = analysis._faultEvents || null;

    if (existingId) {
      id = existingId;
      merged = true;
      var oldAnalysis = units[id].analysis;
      // [CLC] Gabung dari RAW lama (tanpa potong) agar tidak mengunci hasil cut.
      var oldRecords = units[id].rawRecords || ((oldAnalysis && oldAnalysis.records) ? oldAnalysis.records : []);
      var newRecords = analysis.records || [];

      // Gabung record: key = SMR. Yang baru menimpa yang lama pada SMR sama.
      // [FIX 2026-10-01] Record TANPA SMR valid JANGAN dibuang — dedup hanya
      // berlaku untuk SMR valid. Record tanpa SMR dipertahankan (ditambahkan
      // di akhir) agar tidak ada data hilang saat merge/upload masal.
      // [B-5 2026-10-13] Kunci dedup = SMR + JENIS BERKAS SUMBER (`_src`).
      // Sebelumnya kunci hanya SMR, sehingga record Chassis Trend ('86') dan
      // T/M Trend ('81') yang kebetulan ber-SMR SAMA saling MENIMPA — satu
      // dari keduanya hilang diam-diam padahal isinya parameter yang sama
      // sekali berbeda. Dedup tetap bekerja seperti semula di dalam satu
      // jenis berkas (upload ulang berkas yang sama -> yang baru menang).
      var bySmr = {};
      var noSmr = [];
      function keyOf(r) {
        return String(r.smr) + '|' + (r._src === undefined || r._src === null ? '' : r._src);
      }
      function addRecords(list, isNew) {
        list.forEach(function (r) {
          if (!r) return;
          var hasSmr = (r.smr !== null && r.smr !== undefined && !isNaN(r.smr));
          if (hasSmr) {
            bySmr[keyOf(r)] = r;              // SMR+sumber sama -> yang diproses terakhir menang
          } else if (isNew) {
            noSmr.push(r);                     // record baru tanpa SMR -> tetap disimpan
          }
        });
      }
      // Record lama tanpa SMR ikut dipertahankan (bila ada dari sesi sebelumnya).
      oldRecords.forEach(function (r) {
        if (r && (r.smr === null || r.smr === undefined || isNaN(r.smr))) noSmr.push(r);
      });
      addRecords(oldRecords, false);
      var before = Object.keys(bySmr).length;
      addRecords(newRecords, true);
      addedRecords = Object.keys(bySmr).length - before;

      var mergedRecords = Object.keys(bySmr).map(function (k) { return bySmr[k]; });
      // Record tanpa SMR diletakkan di akhir (tidak dapat diurutkan).
      noSmr.forEach(function (r) { mergedRecords.push(r); });
      mergedRecords.sort(function (a, b) {
        var as = (a.smr === null || a.smr === undefined || isNaN(a.smr)) ? null : a.smr;
        var bs = (b.smr === null || b.smr === undefined || isNaN(b.smr)) ? null : b.smr;
        if (as === null && bs === null) return 0;
        if (as === null) return 1;
        if (bs === null) return -1;
        return as - bs;
      });

      // Hitung ulang analitik dari record gabungan (potong CLC diterapkan).
      var newAnalysis;
      if (global.VHMS_ANALYTICS && global.VHMS_ANALYTICS.analyze) {
        newAnalysis = _analyzeParsed({
          meta: analysis.meta,
          columns: analysis.columns,
          units: analysis.units,
          records: mergedRecords,
          // [B2] Pertahankan metadata tipe berkas saat merge.
          dataType: analysis.dataType,
          usedFallback: analysis.usedFallback
        });
        newAnalysis.sourceFile = analysis.sourceFile;
      } else {
        // Fallback: minimal ganti records & range (tanpa analitik ulang)
        newAnalysis = oldAnalysis;
        newAnalysis.records = mergedRecords;
      }

      units[id].analysis = newAnalysis;
      units[id].rawRecords = mergedRecords;   // [CLC] sumber pristine gabungan
      units[id].summaryRow = buildSummaryRow(id, newAnalysis);
      units[id].loadedAt = Date.now();
      units[id].mergeCount = (units[id].mergeCount || 1) + 1;
      // [POIN 4] segarkan nomor lambung untuk unit hasil merge
      var db = global.VHMS_UNITDB;
      if (db && db.getLambung) {
        units[id].summaryRow.lambung = db.getLambung(newAnalysis.meta ? newAnalysis.meta.serial : '') || null;
      }
    } else {
      id = buildUnitId(analysis, sourceName);
      // [CLC] Analisa dengan potong pilar diterapkan; simpan RAW untuk re-analisa.
      var rawRecs = analysis.records || [];
      var newA = (global.VHMS_ANALYTICS && global.VHMS_ANALYTICS.analyze)
        ? _analyzeParsed({ meta: analysis.meta, columns: analysis.columns, units: analysis.units, records: rawRecs,
                           // [B2] Bawa metadata tipe berkas.
                           dataType: analysis.dataType, usedFallback: analysis.usedFallback })
        : analysis;
      newA.sourceFile = analysis.sourceFile;
      var unit = {
        id: id,
        analysis: newA,                     // objek lengkap (bisa di-release)
        rawRecords: rawRecs,                // [CLC] sumber pristine
        summaryRow: buildSummaryRow(id, newA),
        loadedAt: Date.now(),
        mergeCount: 1
      };
      if (!units[id]) order.push(id);
      units[id] = unit;
    }

    // [T7.2] Lampirkan & hitung ulang data fault untuk unit ini, lalu
    // terapkan gerbang kualitas data (T2) pada records unit tsb.
    if (incomingFaultEvents) {
      _attachFault(id, incomingFaultEvents);
    } else if (units[id].faultEvents && units[id].faultEvents.length) {
      // Unit hasil merge/gabung: hitung ulang mask dengan records terbaru.
      _applyMaskForUnit(units[id]);
    }
    // [FIX 2026-10-08] summaryRow di atas disusun SEBELUM mask & faultSummary
    // final tersedia (dataUnfit baru diketahui setelah applyFaultMask). Susun
    // ulang agar skor katalog & sel Event/Alarm memakai angka pasca-gerbang.
    if (units[id].faultEvents && units[id].faultEvents.length) {
      units[id].summaryRow = buildSummaryRow(id, units[id].analysis);
    }

    _persist();
    return { id: id, merged: merged, addedRecords: addedRecords };
  }

  /* -----------------------------------------------------------------------
   * [T7.2 2026-10-08] INTEGRASI RIWAYAT FAULT KE UNIT
   * ---------------------------------------------------------------------
   * Dipisah dari add() agar juga dipakai restore() & reanalyzeAll().
   * Alur:
   *   1) simpan faultEvents pada unit,
   *   2) bangun peta SMR<->epoch BILA memungkinkan (T3),
   *   3) hitung faultSummary via VHMS_FAULT (T4),
   *   4) jalankan applyFaultMask (T2) atas records unit.
   * Semua langkah BERSIFAT OPSIONAL: bila modul pendukung tidak ada, unit
   * tetap berperilaku seperti sebelumnya.
   * --------------------------------------------------------------------- */
  function _attachFault(id, faultEvents) {
    var u = units[id];
    if (!u) return;
    u.faultEvents = (faultEvents || []).slice();

    var faultMod = global.VHMS_FAULT;
    var crossMod = global.VHMS_CROSS;
    var valMod = global.VHMS_VALIDATE;

    // 2) Peta SMR<->epoch (T3) — hanya dari trend utama unit ini.
    var mapInfo = null;
    if (crossMod && typeof crossMod.smrEpochMapFor === 'function' && u.analysis) {
      mapInfo = crossMod.smrEpochMapFor(u.analysis, { faultEvents: u.faultEvents });
      u.smrEpochNotice = mapInfo.message || null;
    }

    // 3) Ringkasan pilar EVENT (T4).
    if (faultMod && typeof faultMod.summarize === 'function') {
      u.faultSummary = faultMod.summarize(u.faultEvents, {
        smrRange: (u.analysis && u.analysis.smrRange) ? u.analysis.smrRange : null,
        maskReport: u.maskReport
      });
    }
    _applyMaskForUnit(u, mapInfo);
  }

  /** [T2] Terapkan gerbang kualitas data pada records sebuah unit. */
  function _applyMaskForUnit(u, mapInfo) {
    var valMod = global.VHMS_VALIDATE;
    if (!u || !u.faultEvents || !u.faultEvents.length) return;
    if (!valMod || typeof valMod.applyFaultMask !== 'function') return;
    var analysis = u.analysis;
    if (!analysis || !analysis.records) return;

    // Peta dipakai bila ada (mask dibatasi window fault); bila tidak ->
    // applyFaultMask() sendiri yang memberlakukan mask unit-wide + melapor.
    var map = (mapInfo && mapInfo.map) ? mapInfo.map : null;
    var res = valMod.applyFaultMask(analysis.records, u.faultEvents, { map: map });
    u.maskReport = res.report;
    // Simpan ringkasan pada analysis agar renderer (T2.5) dapat membacanya.
    analysis.faultMask = res.mask;
    analysis.faultMaskReport = res.report;

    // Ringkasan diperbarui agar laporan validasi menyertakan jumlah param
    // yang di-mask (T2.4) tanpa menimpa laporan validasi asli.
    if (analysis.validationReport) {
      analysis.validationReport.maskCount = res.report.maskCount;
      analysis.validationReport.faultMaskWarnings = res.report.warnings;
    }

    // [T4] faultScore dihitung ulang karena maskReport memengaruhi dataUnfit.
    var faultMod = global.VHMS_FAULT;
    if (faultMod && typeof faultMod.summarize === 'function') {
      u.faultSummary = faultMod.summarize(u.faultEvents, {
        smrRange: analysis.smrRange || null,
        maskReport: u.maskReport
      });
    }
  }

  /**
   * Cari ID unit lama berdasarkan identitas SN + Model.
   * [MERGE] Kunci identitas unit = Serial No. (fallback Model bila SN kosong).
   * @returns {string|null}
   */
  function findUnitIdBySerial(analysis) {
    var m = (analysis && analysis.meta) || {};
    var serial = normalizeSerial(m.serial);
    if (!serial) return null;   // tanpa SN tidak bisa di-merge
    for (var i = 0; i < order.length; i++) {
      var u = units[order[i]];
      if (!u || !u.analysis) continue;
      var um = u.analysis.meta || {};
      if (normalizeSerial(um.serial) === serial) return order[i];
    }
    return null;
  }

  /** Normalisasi serial untuk pencocokan (tahan spasi/tanda, uppercase). */
  function normalizeSerial(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  function get(id) { return units[id] || null; }
  function getAnalysis(id) { return units[id] ? units[id].analysis : null; }

  /* -----------------------------------------------------------------------
   * [T4 / T7.2 2026-10-08] Akses data riwayat fault sebuah unit.
   * --------------------------------------------------------------------- */
  /** Ringkasan pilar EVENT (VHMS_FAULT.summarize) atau null. */
  function getFaultSummary(id) { return units[id] ? (units[id].faultSummary || null) : null; }
  /** Daftar event fault mentah (sudah diurutkan Count desc) atau []. */
  function getFaultEvents(id) {
    var u = units[id];
    if (!u || !u.faultEvents) return [];
    // Salin + urutkan agar pemanggil tidak merusak urutan internal.
    return u.faultEvents.slice().sort(function (a, b) {
      return (b.count || 0) - (a.count || 0);
    });
  }
  /** Laporan gerbang kualitas data (T2) untuk sebuah unit, atau null. */
  function getMaskReport(id) { return units[id] ? (units[id].maskReport || null) : null; }
  /** Catatan kenapa SMR<->epoch tidak tersedia (T3), atau null. */
  function getSmrEpochNotice(id) { return units[id] ? (units[id].smrEpochNotice || null) : null; }

  /* -----------------------------------------------------------------------
   * [T8 2026-10-09] Matriks beban clutch (HD785) sebuah unit.
   * ---------------------------------------------------------------------
   * Hasil VHMS_CLUTCH.parseClutchMatrix(), atau null bila unit tidak punya.
   * Bentuknya `{ slip, thermal }` — dua berkas saling melengkapi.
   * --------------------------------------------------------------------- */
  function getClutchMatrix(id) { return units[id] ? (units[id].clutchMatrix || null) : null; }

  /**
   * Lampirkan satu matriks clutch ke unit. Matriks `slip` ('DA') dan
   * `thermal` ('D9') disimpan berdampingan; memuat ulang berkas yang sama
   * akan MENIMPA yang lama (data terbaru menang), bukan menumpuk.
   *
   * @param {string} id      id unit (SUDAH ada)
   * @param {object} matrix  hasil parseClutchMatrix()
   * @param {string} [sourceName]
   * @returns {object|null}  referensi unit.clutchMatrix, atau null bila gagal
   * --------------------------------------------------------------------- */
  function attachClutchMatrix(id, matrix, sourceName) {
    var u = units[id];
    if (!u || !matrix) return null;

    var slot = (matrix.kind === 'thermal') ? 'thermal'
             : (matrix.kind === 'slip') ? 'slip'
             : 'slip';   // kind tak dikenal -> perlakukan sebagai slip (paling umum)

    if (!u.clutchMatrix) u.clutchMatrix = { slip: null, thermal: null };
    matrix.sourceFile = sourceName || '';
    matrix.attachedAt = Date.now();
    u.clutchMatrix[slot] = matrix;
    u.clutchMatrix.updatedAt = Date.now();

    _persist();
    return u.clutchMatrix;
  }

  /* -----------------------------------------------------------------------
   * [PC2000 2026-10-10 — T12] SUMBER DATA TAMBAHAN (Load Map / Snapshot /
   * Op. Availability). Ketiganya menempel pada unit yang SUDAH ADA, sama
   * seperti matriks clutch. Tidak pernah membuat unit baru.
   * --------------------------------------------------------------------- */

  /**
   * Load Map: `loadm` (beban mesin) / `loadmop` (torsi ALL) / `loadmwork`
   * (torsi WORK). Disimpan per-KIND agar pasangan ALL & WORK berdampingan.
   * Memuat ulang kind yang sama MENIMPA yang lama.
   */
  function attachLoadMap(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.matrix || !res.matrix.length) return null;
    var lm = global.VHMS_LOADMAP;
    if (!u.loadMap) u.loadMap = {};

    var kind = res.kind || (lm && lm.KIND_ENGINE_LOAD) || 'engineLoad';
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.loadMap[kind] = res;
    u.loadMap.updatedAt = Date.now();

    // Hitung selisih ALL − WORK bila kedua sisi kini tersedia (T9).
    var kAll = (lm && lm.KIND_TORQUE_ALL) || 'torqueAll';
    var kWork = (lm && lm.KIND_TORQUE_WORK) || 'torqueWork';
    if (lm && lm.torqueDelta && u.loadMap[kAll] && u.loadMap[kWork]) {
      try {
        u.loadMap.torqueDelta = lm.torqueDelta(u.loadMap[kAll], u.loadMap[kWork]);
      } catch (e) { u.loadMap.torqueDelta = null; }
    }

    _persist();
    return u.loadMap;
  }

  var getLoadMap = function (id) { return units[id] ? (units[id].loadMap || null) : null; };

  /**
   * Snapshot: boleh BANYAK (satu per pemicu). Kunci identitas = SMR + Kode
   * pemicu (R8) karena dua snapshot sah berbagi SMR yang sama.
   * Memuat ulang kunci yang sama MENIMPA yang lama.
   */
  function attachSnapshot(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.rowCount) return null;
    var snap = global.VHMS_SNAPSHOT;
    if (!Array.isArray(u.snapshots)) u.snapshots = [];

    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    var key = snap ? snap.snapshotKey(res) : String(res.trigger && res.trigger.smr);

    var idx = -1;
    for (var i = 0; i < u.snapshots.length; i++) {
      if (u.snapshots[i]._key === key) { idx = i; break; }
    }
    res._key = key;
    if (idx >= 0) u.snapshots[idx] = res; else u.snapshots.push(res);

    _persist();
    return u.snapshots;
  }

  var getSnapshots = function (id) { return units[id] ? (units[id].snapshots || []) : []; };

  /**
   * Operating Availability: satu per unit (bila ada beberapa berkas, yang
   * terbaru menang — sama seperti fault).
   */
  function attachOpAva(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.windows || !res.windows.length) return null;
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.opAvailability = res;
    _persist();
    return u.opAvailability;
  }

  var getOpAva = function (id) { return units[id] ? (units[id].opAvailability || null) : null; };

  /**
   * [D375A 2026-10-13] Matriks perpindahan gigi transmisi (T/M Shift Change
   * Map, tipe '83'). Seperti clutch: satu matriks per unit; memuat ulang
   * MENIMPA yang lama (ekspor terbaru = snapshot terkini).
   * @param {string} id
   * @param {object} res hasil VHMS_SHIFTMAP.parse()
   * @param {string} sourceName
   * @returns {object|null} matriks tersimpan, atau null bila tidak layak
   */
  function attachShiftMap(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.indicators || !res.matrix || !res.matrix.length) return null;
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.shiftMap = res;
    _persist();
    return u.shiftMap;
  }

  var getShiftMap = function (id) { return units[id] ? (units[id].shiftMap || null) : null; };

  /* -----------------------------------------------------------------------
   * [HD785 2026-10-14] MATRIKS BEBAN PER GIGI (13 berkas).
   * ---------------------------------------------------------------------
   * Berbeda dari clutch/shiftMap yang satu berkas per unit: di sini ada
   * SAMPAI 13 berkas yang BERSAMA-SAMA membentuk satu gambaran. Karena itu
   * disimpan sebagai peta ber-kunci `"<mode>:<gigi>"` dan ringkasannya
   * DIHITUNG ULANG setiap kali ada berkas baru menempel — sehingga pangsa
   * L/U vs T/C selalu mencerminkan berkas yang BENAR-BENAR ada, bukan
   * angka basi dari unggahan sebelumnya.
   *
   * Memuat ulang kunci yang sama MENIMPA (ekspor terbaru menang).
   * --------------------------------------------------------------------- */
  function attachGearLoad(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.matrix || !res.matrix.length || !res.totalSec) return null;
    var gl = global.VHMS_GEARLOAD;
    if (!gl) return null;

    if (!u.gearLoad) u.gearLoad = { byKey: {}, summary: null, updatedAt: 0 };
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.gearLoad.byKey[gl.gearKey(res)] = res;

    // Ringkasan WAJIB dihitung ulang dari SELURUH peta, bukan ditambahkan
    // secara inkremental — kalau inkremental, menimpa sebuah berkas akan
    // menghitung ganda jamnya.
    try { u.gearLoad.summary = gl.summarize(u.gearLoad.byKey); }
    catch (e) { u.gearLoad.summary = null; }
    u.gearLoad.updatedAt = Date.now();

    // [D375A 2026-10-14 — T1] Jam jalan baru berubah -> segarkan pangsa L/U
    // terhadap waktu jalan. Tanpa ini, mengunggah berkas gigi SETELAH berkas
    // L/U akan meninggalkan `luShareOfTravel` = null (basi).
    try { refreshTcLoad(id); } catch (e) { /* ringkasan T/C opsional */ }

    _persist();
    return u.gearLoad;
  }

  var getGearLoad = function (id) { return units[id] ? (units[id].gearLoad || null) : null; };

  /* -----------------------------------------------------------------------
   * [HD785 2026-10-14] PETA DUTY OPERASI (5 berkas, 4 jenis analisis).
   * ---------------------------------------------------------------------
   * Disimpan per-KIND agar pasangan BERMUATAN ('52') & KOSONG ('54')
   * berdampingan — sama polanya dengan `loadMap` yang memasangkan
   * torqueAll & torqueWork. Selisihnya dihitung otomatis begitu kedua sisi
   * tersedia (pola `torqueDelta`).
   * --------------------------------------------------------------------- */
  function attachDutyMap(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.kind || !res.matrix || !res.matrix.length) return null;
    var dm = global.VHMS_DUTYMAP;
    if (!dm) return null;

    if (!u.dutyMap) u.dutyMap = {};
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.dutyMap[res.kind] = res;

    // Selisih BERMUATAN - KOSONG bila kedua sisi kini ada.
    var kL = dm.KIND_LOADED, kU = dm.KIND_UNLOADED;
    if (u.dutyMap[kL] && u.dutyMap[kU]) {
      try { u.dutyMap.loadedDelta = dm.loadedDelta(u.dutyMap[kL], u.dutyMap[kU]); }
      catch (e) { u.dutyMap.loadedDelta = null; }
    }
    u.dutyMap.updatedAt = Date.now();

    _persist();
    return u.dutyMap;
  }

  var getDutyMap = function (id) { return units[id] ? (units[id].dutyMap || null) : null; };

  /* -----------------------------------------------------------------------
   * [D375A 2026-10-14 — T1] T/C & LOCK-UP (3 berkas: '35','34','88').
   * ---------------------------------------------------------------------
   * Disimpan per-KIND. Ringkasan dihitung ULANG dari seluruh wadah setiap
   * kali satu berkas menempel (menimpa tidak boleh menghitung ganda).
   *
   * ⚠ Perbedaan penting dari modul lain: `summarize()` modul ini butuh DUA
   * angka yang TIDAK berasal dari berkasnya sendiri — jam JALAN (dari
   * matriks gigi '44'..'49') dan SMR unit. Keduanya dibaca DI SINI, bukan di
   * `parse()`, agar `parse()` tetap murni atas teks masukan (prinsip proyek).
   * Bila berkas gigi belum ada, `luShareOfTravel` = null (BUKAN 0).
   * --------------------------------------------------------------------- */
  function attachTcLoad(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.kind || !res.matrix || !res.matrix.length) return null;
    var tc = global.VHMS_TCLOAD;
    if (!tc) return null;

    if (!u.tcLoad) u.tcLoad = { byKind: {}, summary: null, updatedAt: 0 };
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.tcLoad.byKind[res.kind] = res;

    // Jam jalan dari matriks gigi (bila ada) + SMR unit.
    var travelHours = null;
    var gl = global.VHMS_GEARLOAD;
    if (gl && u.gearLoad && u.gearLoad.summary && u.gearLoad.summary.totalHours !== null) {
      travelHours = u.gearLoad.summary.totalHours;
    }
    var smrHours = null;
    if (u.summaryRow && u.summaryRow.smrLast !== null && u.summaryRow.smrLast !== undefined) {
      smrHours = u.summaryRow.smrLast;
    }

    // Ringkasan WAJIB dihitung ulang dari SELURUH peta, bukan inkremental —
    // menimpa satu berkas akan menghitung ganda jamnya.
    try { u.tcLoad.summary = tc.summarize(u.tcLoad.byKind, travelHours, smrHours); }
    catch (e) { u.tcLoad.summary = null; }
    u.tcLoad.updatedAt = Date.now();

    _persist();
    return u.tcLoad;
  }

  var getTcLoad = function (id) { return units[id] ? (units[id].tcLoad || null) : null; };

  /* -----------------------------------------------------------------------
   * [D375A 2026-10-14 — T2] STEERING CLUTCH & BRAKE (4 berkas: '24'..'27').
   * ---------------------------------------------------------------------
   * Disimpan per-KIND (lClutch/rClutch/lBrake/rBrake). Asimetri kiri/kanan
   * dihitung store begitu KEDUA sisi satu komponen tersedia — persis pola
   * `torqueDelta` di `attachLoadMap`. Satu sisi saja -> `asym* = null`,
   * panel WAJIB menulis "perlu kedua sisi", bukan menampilkan angka.
   * --------------------------------------------------------------------- */
  function attachSteering(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.kind || !res.matrix || !res.matrix.length) return null;
    var st = global.VHMS_STEERING;
    if (!st) return null;

    if (!u.steering) u.steering = { byKind: {}, summary: null, updatedAt: 0 };
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.steering.byKind[res.kind] = res;

    // Ringkasan dihitung ulang dari SELURUH peta — menimpa tidak boleh
    // menghitung ganda, dan asimetri harus muncul begitu sisi kedua datang.
    try { u.steering.summary = st.summarize(u.steering.byKind); }
    catch (e) { u.steering.summary = null; }
    u.steering.updatedAt = Date.now();

    _persist();
    return u.steering;
  }

  var getSteering = function (id) { return units[id] ? (units[id].steering || null) : null; };

  /* -----------------------------------------------------------------------
   * [D375A 2026-10-14 — T3] BEBAN POMPA (2 berkas: '36','37').
   * ---------------------------------------------------------------------
   * Disimpan per-KIND. Perbandingan P1 vs P2 dihitung store begitu KEDUA
   * berkas ada — satu berkas saja -> `compare = null`.
   * --------------------------------------------------------------------- */
  function attachPumpLoad(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.kind || !res.matrix || !res.matrix.length) return null;
    var pl = global.VHMS_PUMPLOAD;
    if (!pl) return null;

    if (!u.pumpLoad) u.pumpLoad = { byKind: {}, summary: null, updatedAt: 0 };
    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.pumpLoad.byKind[res.kind] = res;

    try { u.pumpLoad.summary = pl.summarize(u.pumpLoad.byKind); }
    catch (e) { u.pumpLoad.summary = null; }
    u.pumpLoad.updatedAt = Date.now();

    _persist();
    return u.pumpLoad;
  }

  var getPumpLoad = function (id) { return units[id] ? (units[id].pumpLoad || null) : null; };

  /* -----------------------------------------------------------------------
   * [D375A 2026-10-14 — T4] CYCLE INTERVAL (1 berkas: '50').
   * ---------------------------------------------------------------------
   * Satu berkas saja. Disimpan apa adanya; ringkasannya dihitung dengan SMR
   * unit (untuk intensitas siklus/jam) — SMR berasal dari unit, bukan dari
   * berkas, jadi dihitung DI SINI agar `parse()` tetap murni.
   * --------------------------------------------------------------------- */
  function attachCycInt(id, res, sourceName) {
    var u = units[id];
    if (!u || !res || !res.kind || !res.matrix || !res.matrix.length) return null;
    var ci = global.VHMS_CYCINT;
    if (!ci) return null;

    res.sourceFile = sourceName || '';
    res.attachedAt = Date.now();
    u.cycInt = { res: res, summary: null, updatedAt: Date.now() };

    var smrHours = (u.summaryRow && u.summaryRow.smrLast !== null && u.summaryRow.smrLast !== undefined)
      ? u.summaryRow.smrLast : null;
    try { u.cycInt.summary = ci.summarize(res, smrHours); }
    catch (e) { u.cycInt.summary = null; }

    _persist();
    return u.cycInt;
  }

  var getCycInt = function (id) { return units[id] ? (units[id].cycInt || null) : null; };

  /**
   * Segarkan ringkasan T/C setelah jam jalan berubah (berkas gigi baru
   * menempel). Tanpa ini, `luShareOfTravel` akan tetap null walau berkas
   * gigi baru saja diunggah.
   */
  function refreshTcLoad(id) {
    var u = units[id];
    if (!u || !u.tcLoad || !u.tcLoad.byKind) return;
    var tc = global.VHMS_TCLOAD;
    if (!tc) return;
    var travelHours = null;
    if (u.gearLoad && u.gearLoad.summary && u.gearLoad.summary.totalHours !== null) {
      travelHours = u.gearLoad.summary.totalHours;
    }
    var smrHours = (u.summaryRow && u.summaryRow.smrLast !== null && u.summaryRow.smrLast !== undefined)
      ? u.summaryRow.smrLast : null;
    try { u.tcLoad.summary = tc.summarize(u.tcLoad.byKind, travelHours, smrHours); }
    catch (e) { u.tcLoad.summary = null; }
  }

  function count() { return order.length; }
  function ids() { return order.slice(); }

  /**
   * Daftar ringkasan semua unit (array summaryRow) — untuk katalog Home.
   */
  function rows() {
    return order.map(function (id) { return units[id].summaryRow; });
  }

  function clear() {
    units = {};
    order = [];
    var st = _store();
    if (st) { try { st.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } }
    // Hapus juga dari sessionStorage (legacy sebelum migrasi)
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(STORAGE_KEY); } catch (e2) {}
  }

  /**
   * [POIN 4] Segarkan Nomor Lambung pada semua summaryRow setelah Database
   * Unit diunggah/dihapus. Dipanggil dari controller.
   * @returns {number} jumlah unit yang berhasil dipetakan
   */
  function refreshLambung() {
    var db = global.VHMS_UNITDB;
    var matched = 0;
    order.forEach(function (id) {
      var u = units[id];
      if (!u) return;
      var serial = u.analysis && u.analysis.meta ? u.analysis.meta.serial : '';
      var lb = (db && db.getLambung) ? (db.getLambung(serial) || null) : null;
      u.summaryRow.lambung = lb;
      if (lb) matched++;
    });
    return matched;
  }

  /* -----------------------------------------------------------------------
   * Agregasi armada
   * --------------------------------------------------------------------- */

  /**
   * Statistik agregat seluruh armada untuk header Fleet Overview.
   */
  function fleetStats() {
    var n = order.length;
    var agg = {
      count: n,
      critical: 0,
      warning: 0,
      normal: 0,
      avgHealth: null,
      totalRecords: 0,
      byModel: {},
      byGroup: {},
      worstUnits: []
    };
    if (n === 0) return agg;

    var scoreSum = 0, scoreN = 0;

    order.forEach(function (id) {
      var r = units[id].summaryRow;
      if (r.healthLabel === 'CRITICAL') agg.critical++;
      else if (r.healthLabel === 'CAUTION' || r.healthLabel === 'WARNING') agg.warning++;
      else agg.normal++;

      if (r.healthScore !== null && r.healthScore !== undefined) {
        scoreSum += r.healthScore; scoreN++;
      }
      agg.totalRecords += r.recordCount || 0;

      var model = r.model || 'Tidak diketahui';
      agg.byModel[model] = (agg.byModel[model] || 0) + 1;
      var group = r.productGroup || 'Tidak diketahui';
      agg.byGroup[group] = (agg.byGroup[group] || 0) + 1;
    });

    agg.avgHealth = scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : null;
    agg.caution = agg.warning;   // [STANDARISASI 2026-10-03] nama kanonik

    // Unit dengan skor kesehatan terendah (perhatian utama)
    agg.worstUnits = rows()
      .filter(function (r) { return r.healthScore !== null && r.healthScore !== undefined; })
      .sort(function (a, b) { return a.healthScore - b.healthScore; })
      .slice(0, 5);

    return agg;
  }

  /* -----------------------------------------------------------------------
   * [SETTINGS] Analisa ulang SELURUH unit dengan threshold terkini.
   * Dipakai saat user mengubah threshold di panel Pengaturan (thresholdSet
   * di-snapshot per unit oleh analyze(), jadi harus di-render ulang).
   * --------------------------------------------------------------------- */
  function reanalyzeAll() {
    var analytics = global.VHMS_ANALYTICS;
    if (!analytics || typeof analytics.analyze !== 'function') return 0;
    var n = 0;
    order.forEach(function (id) {
      var u = units[id];
      if (!u || !u.analysis) return;
      // [FIX] Rekonstruksi objek `parsed` dari analisis tersimpan. Sebelumnya
      // fungsi ini bergantung pada `u.parsed` yang TIDAK PERNAH di-set oleh
      // add()/restore(), sehingga reanalyze (setelah user mengubah threshold
      // di Pengaturan) tidak pernah berjalan. analysis selalu menyimpan
      // meta/columns/records, jadi cukup dari situ.
      // [CLC] Pakai RAW (tanpa potong) agar potong dihitung ulang segar.
      var records = u.rawRecords || u.analysis.records;
      if (!records || !records.length) return;   // record sudah dilepas -> lewati
      try {
        var analysis = _analyzeParsed({
          meta: u.analysis.meta || {},
          columns: u.analysis.columns || [],
          units: u.analysis.units || [],
          records: records
        });
        analysis.sourceFile = u.analysis.sourceFile || '';
        u.analysis = analysis;
        // [T7.2] Reanalisa ulang TIDAK boleh menghapus gerbang kualitas data:
        // records baru belum ber-_masked, jadi terapkan lagi setelah analitik.
        if (u.faultEvents && u.faultEvents.length) _applyMaskForUnit(u);
        u.summaryRow = buildSummaryRow(id, analysis);
        n++;
      } catch (e) {
        if (global.console && console.warn) console.warn('Gagal menganalisa ulang unit VHMS:', e && e.message);
      }
    });
    if (n) _persist();
    return n;
  }

  /* ----------------------------------------------------------------------- */
  global.VHMS_FLEET = {
    add: add,
    get: get,
    getAnalysis: getAnalysis,
    // [T4/T7.2] Akses riwayat fault
    getFaultSummary: getFaultSummary,
    getFaultEvents: getFaultEvents,
    getMaskReport: getMaskReport,
    getSmrEpochNotice: getSmrEpochNotice,
    // [T8 2026-10-09] Matriks beban clutch (HD785)
    getClutchMatrix: getClutchMatrix,
    attachClutchMatrix: attachClutchMatrix,
    // [T12 2026-10-10] Sumber data PC2000.
    getLoadMap: getLoadMap,
    attachLoadMap: attachLoadMap,
    getSnapshots: getSnapshots,
    attachSnapshot: attachSnapshot,
    getOpAva: getOpAva,
    attachOpAva: attachOpAva,
    // [D375A 2026-10-13] Matriks perpindahan gigi transmisi (tipe '83').
    getShiftMap: getShiftMap,
    attachShiftMap: attachShiftMap,
    // [HD785 2026-10-14] Beban per gigi (13 tipe) & peta duty operasi (5 tipe).
    getGearLoad: getGearLoad,
    attachGearLoad: attachGearLoad,
    getDutyMap: getDutyMap,
    attachDutyMap: attachDutyMap,
    // [D375A 2026-10-14 — T1] T/C & lock-up ('35','34','88').
    getTcLoad: getTcLoad,
    attachTcLoad: attachTcLoad,
    refreshTcLoad: refreshTcLoad,
    // [D375A 2026-10-14 — T2] Steering clutch & brake ('24'..'27').
    getSteering: getSteering,
    attachSteering: attachSteering,
    // [D375A 2026-10-14 — T3] Beban pompa ('36','37').
    getPumpLoad: getPumpLoad,
    attachPumpLoad: attachPumpLoad,
    // [D375A 2026-10-14 — T4] Cycle interval ('50').
    getCycInt: getCycInt,
    attachCycInt: attachCycInt,
    count: count,
    ids: ids,
    rows: rows,
    clear: clear,
    refreshLambung: refreshLambung,
    fleetStats: fleetStats,
    buildUnitId: buildUnitId,
    restore: restore,
    persist: _persist,
    reanalyzeAll: reanalyzeAll,
    // [B2 2026-10-10] Unit yang dibuang saat restore (data tercemar lama).
    getLastPurged: getLastPurged,
    // [AUDIT 2026-10-15] Hasil penulisan storage terakhir — agar UI dapat
    // memberi tahu bila kuota penuh & data TIDAK akan bertahan setelah reload.
    getStorageStatus: getStorageStatus,
    /** Predikat murni "layak diumumkan?" — lihat catatan panjangnya. */
    shouldAnnounceStorageStatus: shouldAnnounceStorageStatus,
    applyClcChange: function () { return reanalyzeAll(); }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VHMS_FLEET;
  }
})(typeof window !== 'undefined' ? window : globalThis);

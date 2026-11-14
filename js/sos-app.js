/* =========================================================================
 * sos-app.js
 * -------------------------------------------------------------------------
 * Controller SOS tab — menangani upload, navigasi, event wiring.
 * Dijalankan sebagai tab embed di dalam VHMS Dashboard.
 * ========================================================================= */

(function (global) {
  'use strict';

  var parser   = global.SOS_PARSER;
  var analytics= global.SOS_ANALYTICS;
  var store    = global.SOS_STORE;
  var render   = global.SOS_RENDER;

  // [POST-6 2026-10-03] Debounce agar pencarian tidak render penuh tiap ketikan.
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  function toast(msg, type, ms) {
    // Re-use VHMS toast if available
    if (global.VHMS_APP && global.VHMS_APP.toast) {
      global.VHMS_APP.toast(msg, type, ms);
      return;
    }
    // Fallback
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) { if (global.console && console.warn) console.warn('[SOS_APP] toast fallback (no #toast-wrap):', msg); return; }
    var div = document.createElement('div');
    div.className = 'toast ' + (type || 'info');
    // [P1 A11Y 2026-10-05] Error -> role=alert (assertive).
    div.setAttribute('role', type === 'err' ? 'alert' : 'status');
    var icon = type === 'err' ? 'fa-circle-exclamation' : (type === 'ok' ? 'fa-circle-check' : 'fa-circle-info');
    div.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + (render.esc ? render.esc(msg) : msg) + '</span>';
    wrap.appendChild(div);
    setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, ms || 4000);
  }

  /* -----------------------------------------------------------------------
   * File processing
   * --------------------------------------------------------------------- */
  function processFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var files = Array.from(fileList).filter(function (f) {
      return /\.(csv|txt|xls|xlsx)$/i.test(f.name);
    });
    if (!files.length) { toast('Tidak ada file CSV/TXT yang valid.', 'err'); return; }

    var total = files.length, done = 0, totalAdded = 0, totalReplaced = 0, errors = [], warnings = [];
    var totalCorrected = 0, totalInvalidSamples = 0;
    // [AUDIT 2026-10-15] Konflik kolom ganda dikumpulkan TERPISAH dari
    // `warnings` biasa. Alasan: `finishUpload` hanya menampilkan
    // `warnings[0]`, dan HANYA bila tidak ada sampel tak-valid — jadi
    // peringatan ini akan tertelan tepat pada berkas yang paling perlu
    // memperlihatkannya (berkas Web CAT nyata: 0 sampel tak-valid,
    // tetapi 1 370 baris berkonflik pada `hm_oil`).
    var conflictMsgs = [];

    files.forEach(function (file) {
      parser.parseFile(file).then(function (result) {
        if (result.errors.length > 0) {
          errors.push(file.name + ': ' + result.errors.join('; '));
        }
        // [FIX 2026-09-30] Kumpulkan peringatan kualitas data (nilai di luar
        // rentang wajar / desimal hilang pada file ekspor lab).
        if (result.meta && result.meta.warnings && result.meta.warnings.length) {
          warnings = warnings.concat(result.meta.warnings);
        }
        if (result.meta) {
          totalInvalidSamples += result.meta.samplesWithInvalid || 0;
        }
        // [AUDIT 2026-10-15] Kolom ganda berisi nilai berbeda — pilihan
        // parser (kolom terisi pertama) TIDAK boleh senyap.
        var cc = result.meta && result.meta.columnConflicts;
        if (cc) {
          Object.keys(cc).forEach(function (k) {
            conflictMsgs.push(file.name + ' \u2014 kolom ganda "' + cc[k].headers.join('" & "')
              + '" berbeda pada ' + cc[k].rows + ' baris; dipakai "' + cc[k].headers[0]
              + '". Konfirmasikan ke tim lab kolom mana yang otoritatif.');
          });
        }
        (result.samples || []).forEach(function (s) {
          if (s._correctedParams && s._correctedParams.length) totalCorrected++;
        });
        // [DEDUP 2026-10-01] addSamples kini mengembalikan { added, replaced, total }.
        var res = store.addSamples(result.samples, file.name);
        var added = (typeof res === 'number') ? res : (res.added || 0);
        var replaced = (typeof res === 'object' && res) ? (res.replaced || 0) : 0;
        totalAdded += added;
        totalReplaced += replaced;
        done++;
        if (done === total) finishUpload(totalAdded, errors, warnings, totalCorrected, totalInvalidSamples, totalReplaced, conflictMsgs);
      }).catch(function (err) {
        errors.push(file.name + ': ' + err.message);
        done++;
        if (done === total) finishUpload(totalAdded, errors, warnings, totalCorrected, totalInvalidSamples, totalReplaced, conflictMsgs);
      });
    });
  }

  function finishUpload(totalAdded, errors, warnings, correctedCount, invalidSamples, replacedCount, conflictMsgs) {
    if (errors.length > 0) {
      toast('Peringatan: ' + errors.join(' | '), 'err', 6000);
    }
    // [AUDIT 2026-10-15] Konflik kolom ganda: SELALU tampil, terlepas dari
    // ada-tidaknya peringatan lain. Angka yang dipakai aplikasi bisa berbeda
    // dari angka yang dilihat operator di kolom sebelahnya; itu harus
    // diketahui, bukan ditebak.
    (conflictMsgs || []).slice(0, 3).forEach(function (m) {
      toast(m, 'err', 9000);
    });
    // [FIX 2026-09-30] Transparansi kualitas data. Nilai yang dikoreksi TIDAK
    // membatalkan data (mis. viskositas 6274 -> 6.274). Nilai yang benar-benar
    // mustahil sudah dibuang dari analitik oleh parser.
    if (correctedCount > 0) {
      toast(correctedCount + ' nilai terkoreksi otomatis (mis. viskositas tanpa titik desimal pada file ekspor lab).', 'info', 6000);
    }
    if (invalidSamples > 0) {
      toast(invalidSamples + ' sampel memiliki nilai di luar rentang wajar; nilai tsb dibuang dari analitik.', 'err', 7000);
    } else if (!errors.length && warnings.length > 0) {
      toast(warnings[0], 'info', 6000);
    }
    // [DEDUP 2026-10-01] Transparansi hasil dedup: data baru MENGGANTIKAN lama.
    if (replacedCount > 0) {
      toast(replacedCount + ' sampel diperbarui (data baru menggantikan data lama dengan kunci sama).', 'info', 7000);
    }
    if (totalAdded > 0) {
      toast(totalAdded + ' sampel SOS berhasil dimuat.', 'ok');
      render.updateUploadVisibility();
      render.showView('fleet');
    } else if (replacedCount > 0) {
      // Tidak ada sampel BARU, tetapi ada data yang diperbarui -> bukan "kosong".
      render.showView('fleet');
    } else if (errors.length === 0) {
      toast('Tidak ada sampel baru (mungkin duplikat).', 'info');
    }
    var storageStatus = store && store.getStorageStatus ? store.getStorageStatus() : null;
    if (storageStatus && !storageStatus.ok && storageStatus.message) {
      toast(storageStatus.message, 'err', 9000);
    }
    // [FASE 3 2026-10-31] Kegagalan tulis IndexedDB dilaporkan di sini —
    // tepat setelah berkas diproses, bukan pada klik berikutnya.
    reportWriteError();
    try {
      if (typeof global.ARPC_SYNC_EXPORT_BTN === 'function') global.ARPC_SYNC_EXPORT_BTN();
    } catch (e) { /* tombol export opsional */ }
  }

  /* -----------------------------------------------------------------------
   * Navigation & event wiring
   * --------------------------------------------------------------------- */
  function openDetail(assetId, component) {
    render.renderAssetDetail(assetId, component);
    render.showView('detail');
  }

  /**
   * [FITUR 2026-10-03] Buka halaman Portofolio terfilter pada SATU unit +
   * kompartemen (dari baris SOS), lalu langsung tampilkan pratinjau cetak.
   * Dipakai tombol "Print" di tabel SOS Equipment.
   */
  function openPortfolioForPrint(assetId, component) {
    var app = global.PORTFOLIO_APP;
    if (!app) {
      if (typeof toast === 'function') toast('Halaman Portofolio belum siap.', 'err');
      return;
    }
    if (typeof app.openPrintFor === 'function') {
      app.openPrintFor(assetId, component);
    } else if (typeof app.open === 'function') {
      // Fallback: buka portofolio saja bila API khusus tak tersedia.
      app.open();
      if (typeof toast === 'function') toast('Fitur print per unit belum tersedia.', 'info');
    }
  }

  /* =========================================================================
   * [STARTUP 2026-10-31] ANALITIK ARMADA DIJADWALKAN, TIDAK DIBLOKIR DI INIT
   * -------------------------------------------------------------------------
   * GEJALA YANG DIPERBAIKI (dilaporkan operator, data SOS ±26.000 baris):
   *   setelan halaman SOS/VHMS TIDAK BISA DIKLIK selama beberapa detik, lalu
   *   "tiba-tiba" semua daftar muncul. Itu bukan pembekuan acak: `init()`
   *   menjalankan `store.restore()` -> `analyzeFleet()` -> `renderFleetTable()`
   *   SEMUANYA dalam satu event `DOMContentLoaded`. Terukur di Node
   *   (`tools/_probe-sos-startup-cost.js`, 25.964 sampel): restore + analitik
   *   ±1,0–1,1 detik, ditambah JSON.stringify berkas cadangan ±0,6 detik dan
   *   HTML 100 baris. Selama itu satu-satunya thread peramban sibuk — klik
   *   tidak diproses sama sekali.
   *
   * YANG DIUBAH — HANYA URUTANNYA, BUKAN HASILNYA:
   *   1. `init()` tetap memulihkan & menampilkan halaman, tetapi analitik
   *      yang MAHAL dijalankan SETELAH halaman tergambar.
   *   2. Analitik dipecah per POTONGAN (±5 ms per tick, terukur
   *      `tools/_probe-sos-chunk.js`: median 0,14 ms/unit, maks 8,8 ms) di
   *      antara dua tick timer, sehingga klik menu diproses di sela-selanya.
   *   3. Analitik bisa DIBATALKAN bila data berubah sebelum selesai
   *      (mis. operator mengosongkan data) — tidak ada hasil basi.
   * Hasilnya IDENTIK: `tools/_probe-split-equivalence.js` membandingkan
   * keluaran baru dengan implementasi ASLI (git HEAD) — byte-identik.
   * ========================================================================= */
  var _analyzeToken = 0;     // dinaikkan setiap data berubah -> membatalkan tugas lama
  var _analyzeTimer = null;
  /** Anggaran kerja per tick (ms). 5 ms jauh di bawah ambang "tersendat" 50 ms. */
  var SLICE_MS = 5;

  /**
   * Batalkan tugas analitik yang belum/baru berjalan.
   *
   * @param {boolean} [diam] true = TIDAK menutup dialog sinkron (dipakai
   *   penjadwal ketika ia sendiri mengganti tugas).
   */
  function cancelScheduledAnalysis(diam) {
    _analyzeToken++;
    if (_analyzeTimer) { clearTimeout(_analyzeTimer); _analyzeTimer = null; }
    if (!diam) tutupDialogSinkron();
  }

  /* =========================================================================
   * [STARTUP 2026-10-31] DIALOG SINKRON sementara selama analitik bertahap.
   * -------------------------------------------------------------------------
   * Selama analitik armada berjalan, operator bisa menekan "Kosongkan Semua"
   * (dialog `confirm` native) TEPAT di sela-sela potongan — dulu itu terjadi
   * karena halaman beku, jadi terasa "notif hapus muncul sendiri". Sekarang
   * klik itu sah, jadi sisa analitik DIBATALKAN + dialog ditutup sebelum data
   * dihapus. Panel kecil ini:
   *   - menangkap pointer (area gelap) sehingga dialog tak bisa ditekan;
   *   - TIDAK menutup header -> menu Home/Cross/SOS/Fuel/Portofolio/
   *     Pengaturan tetap BISA DIKLIK selama proses (inti keluhan operator);
   *   - hilang sendiri begitu analitik selesai / dibatalkan.
   * Membutuhkan `#sos-sync-overlay` di index.html; bila elemen tidak ada,
   * semuanya tetap berjalan (hanya pelindung klik yang tidak tampil).
   * ========================================================================= */
  var _dialogSinkron = false;

  function bukaDialogSinkron() {
    if (_dialogSinkron) return;
    var ov = document.getElementById('sos-sync-overlay');
    if (!ov) return;
    var txt = document.getElementById('sos-sync-text');
    if (txt) txt.textContent = 'Menghitung analitik ' + store.count() + ' sampel\u2026';
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
    _dialogSinkron = true;
  }

  function tutupDialogSinkron() {
    if (!_dialogSinkron) return;
    var ov = document.getElementById('sos-sync-overlay');
    if (ov) {
      ov.classList.add('hidden');
      ov.setAttribute('aria-hidden', 'true');
    }
    _dialogSinkron = false;
  }

  /** Jadwalkan `fn` pada tick berikutnya. */
  function nextTick(fn) { _analyzeTimer = setTimeout(fn, 0); }

  /**
   * Jadwalkan analitik armada (bertahap) + gambar ulang daftar.
   * @param {string} [reason] 'startup' — hanya untuk log.
   * @returns {Promise<boolean>} true bila analitik selesai & tampilan segar.
   */
  function scheduleFleetRefresh(reason) {
    cancelScheduledAnalysis(true);   // ganti tugas, bukan pembatalan operator
    var token = _analyzeToken;
    var A = global.SOS_ANALYTICS;
    return new Promise(function (resolve) {
      nextTick(function () {
        if (token !== _analyzeToken) { resolve(false); return; }
        if (store.count() === 0) { resolve(false); return; }
        // Analitik lain sedang berjalan: ambil giliran berikutnya.
        if (typeof store.isAnalyzing === 'function' && store.isAnalyzing()) {
          resolve(scheduleFleetRefresh(reason));
          return;
        }
        /* Tanpa API bertahap (modul lama dari cache) -> tetap benar, hanya
         * satu tugas; jangan gagal karena API opsional ini absen. */
        if (!A || typeof A.beginFleet !== 'function' || typeof store.commitAnalysis !== 'function') {
          if (typeof store.analyzeInPlace === 'function') store.analyzeInPlace();
          else store.restore();
          if (token === _analyzeToken) { try { render.showView('fleet'); } catch (e) {} }
          resolve(true);
          return;
        }

        // --- analitik BERTAHAP ---
        var st = A.beginFleet(store.getEffectiveSamples ? store.getEffectiveSamples() : store.getAllSamples());
        var keys = Object.keys(st.groups);
        bukaDialogSinkron();            // pelindung klik selama proses
        var i = 0;
        function step() {
          _analyzeTimer = null;
          if (token !== _analyzeToken) { tutupDialogSinkron(); resolve(false); return; }   // dibatalkan
          var mulai = Date.now();
          while (i < keys.length) {
            A.analyzeGroup(st, keys[i]);
            i++;
            if (Date.now() - mulai >= SLICE_MS) break;   // beri giliran ke UI
          }
          if (i < keys.length) { nextTick(step); return; }
          store.commitAnalysis(A.finishFleet(st));
          tutupDialogSinkron();           // analitik selesai -> dialog hilang
          if (token === _analyzeToken) {
            try { render.showView('fleet'); } catch (e) { /* UI belum siap */ }
          }
          resolve(true);
        }
        nextTick(step);
      });
    });
  }

  /**
   * Tampilkan isi yang TIDAK butuh analitik segera (upload/hasil/KPI dasar).
   * Dipakai saat analitik untuk data yang sudah ada belum selesai.
   */
  function showFastFleetShell() {
    try {
      if (render && render.updateUploadVisibility) render.updateUploadVisibility();
      if (render && render.invalidateFleetCaches) render.invalidateFleetCaches();
      /* [STARTUP 2026-10-31] Daftar unit RINGAN: KPI dasar + tabel dari sampel
       * (tier & skor MPRS tersimpan per sampel), tanpa menunggu analitik
       * armada. Bila renderer belum punya jalur ini, cukup sembunyikan form
       * upload — penjadwal tetap menggambar tabel saat analitik selesai. */
      if (render && render.renderFleetPulse && store.isAnalysisPending && store.isAnalysisPending()) {
        var p = render.renderFleetPulse();
        if (p && p.catch) p.catch(function () { /* penjadwal tetap menggambar */ });
      }
    } catch (e) { /* UI belum siap — penjadwal tetap akan menggambar */ }
    try {
      if (typeof global.ARPC_SYNC_EXPORT_BTN === 'function') global.ARPC_SYNC_EXPORT_BTN();
    } catch (e2) { /* tombol export opsional */ }
  }

  /**
   * hydrateStore() -> Promise<boolean>
   *
   * [FASE 3 2026-10-31] Memuat isi IndexedDB ke MEMORI store. Dipanggil
   * SETELAH `store.restore()` (jalur cepat localStorage) dan SEBELUM daftar
   * unit ditampilkan. Tanpa ini, halaman SOS menampilkan daftar kosong walau
   * datanya ada di disk.
   *
   * Kegagalan TIDAK memblokir halaman: store sudah punya cadangan
   * localStorage, dan penyebabnya dilaporkan lewat toast — bukan ditelan.
   */
  var _hydratePromise = null;
  function hydrateStore() {
    if (_hydratePromise) return _hydratePromise;
    if (!store || typeof store.hydrate !== 'function') {
      _hydratePromise = Promise.resolve(false);
      return _hydratePromise;
    }
    _hydratePromise = store.hydrate().then(function (r) {
      if (r && r.reason) {
        toast('Penyimpanan IndexedDB SOS tidak aktif (' + r.reason + ') — memakai penyimpanan lama dengan batas ±5 MB.', 'err', 9000);
      }
      // Migrasi dari localStorage: sebut apa yang terjadi, jangan senyap.
      if (r && r.migrated && r.migrated.moved > 0) {
        toast(r.migrated.moved + ' sampel SOS dipindahkan ke penyimpanan baru (IndexedDB).', 'ok');
      }
      // Record yatim yang dibuang BUKAN kejadian rutin: sebutkan jumlahnya.
      if (r && r.pruned > 0) {
        toast(r.pruned + ' sisa sampel lama dibersihkan dari penyimpanan.', 'info');
      }
      /* [STARTUP 2026-10-31] `refreshAfterHydrate` TIDAK BOLEH memanggil
       * `renderFleetTable()` di sini: daftar unit baru bisa digambar setelah
       * analitik armada selesai. Penjadwal di bawah (init) yang menanganinya
       * — dan hanya pada saat data memang belum dianalisis. */
      refreshAfterHydrate(r);
      reportWriteError();
      return true;
    }).catch(function (e) {
      _hydratePromise = null;
      toast('Gagal memuat penyimpanan SOS: ' + ((e && e.message) || e), 'err', 9000);
      return false;
    });
    return _hydratePromise;
  }

  /** Tampilkan daftar setelah hydrate, dan sinkronkan tombol Export header. */
  function refreshAfterHydrate() {
    /* Data berubah (IndexedDB lebih otoritatif dari cadangan) -> cache urutan
     * tabel basi. Analitik dijadwalkan oleh init(), bukan di sini. */
    try { if (render && render.invalidateFleetCaches) render.invalidateFleetCaches(); } catch (e0) {}
    try {
      if (render && render.updateUploadVisibility) render.updateUploadVisibility();
    } catch (e) { /* UI belum siap — data sudah benar di store */ }
    try {
      if (typeof global.ARPC_SYNC_EXPORT_BTN === 'function') global.ARPC_SYNC_EXPORT_BTN();
    } catch (e2) { /* tombol export opsional */ }
  }

  /**
   * reportWriteError() — tampilkan kegagalan tulis IndexedDB yang tertunda.
   * Dipanggil setelah operasi yang menulis. "Sampel tampil di layar tetapi
   * gagal tersimpan" adalah kebohongan kecil yang paling mahal: operator
   * mengira datanya aman, lalu kehilangannya saat reload.
   */
  function reportWriteError() {
    if (!store || typeof store.takeWriteError !== 'function') return;
    var w = store.takeWriteError();
    if (w) toast('Gagal menyimpan sampel SOS ke disk (' + (w.key || 'sampel') + '): ' + w.reason, 'err', 9000);
  }

  function init() {
    /* [STARTUP 2026-10-31] FASE 2: sisa pekerjaan dilakukan SETELAH event
     * handler terpasang dan halaman sudah bisa diklik. Membongkar cadangan
     * (±60–80 ms) + menyiapkan IndexedDB + menggambar 100 baris dilakukan
     * di sini, bukan di dalam init(), sehingga tidak ada satu blok sinkron
     * yang menahan klik saat halaman pertama kali tampil. */
    scheduleStartupLoad();

    // File input — dua tombol pemicu: "Pilih File" (form upload) & "Tambah SOS" (toolbar)
    var fileInput = document.getElementById('sos-file-input');
    var pickBtn = document.getElementById('sos-btn-pick');
    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.click(); });
    }
    var addBtn = document.getElementById('sos-btn-add');
    if (addBtn && fileInput) {
      addBtn.addEventListener('click', function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processFiles(e.target.files);
        e.target.value = '';
      });
    }

    // Perbandingan (overlay antar kompartemen)
    var compBtn = document.getElementById('sos-btn-comparison');
    if (compBtn) compBtn.addEventListener('click', function () { render.showView('comparison'); });
    var compClose = document.getElementById('sos-btn-comparison-close');
    if (compClose) compClose.addEventListener('click', function () { render.showView('fleet'); });
    var compDraw = document.getElementById('sos-btn-comp-draw');
    if (compDraw) compDraw.addEventListener('click', render.renderComparison);

    // [FITUR 2026-10-17] Failure Mode SOS — tombol kembali.
    var fmClose = document.getElementById('sos-btn-failmode-close');
    if (fmClose) fmClose.addEventListener('click', function () { render.showView('fleet'); });

    // [ADD 2026-10-19] Copy Image & Export PDF Failure Mode SOS — paritas
    // dengan Failure Mode VHMS.
    var fmCopy = document.getElementById('sos-btn-failmode-copy');
    if (fmCopy) fmCopy.addEventListener('click', function () {
      if (global.SOS_FAILMODE && global.SOS_FAILMODE.copyImage) global.SOS_FAILMODE.copyImage();
    });
    var fmPdf = document.getElementById('sos-btn-failmode-pdf');
    if (fmPdf) fmPdf.addEventListener('click', function () {
      if (global.SOS_FAILMODE && global.SOS_FAILMODE.exportPdf) global.SOS_FAILMODE.exportPdf();
    });

    // Fleet table click delegation
    var fleetBody = document.getElementById('sos-fleet-body');
    if (fleetBody) {
      fleetBody.addEventListener('click', function (e) {
        // [FITUR 2026-10-03] Tombol Print per baris -> buka Portofolio unit +
        // kompartemen baris ini, lalu langsung tampilkan pratinjau cetak.
        var printBtn = e.target.closest('[data-sos-print]');
        if (printBtn) {
          e.stopPropagation();
          var pp = printBtn.getAttribute('data-sos-print').split('|');
          openPortfolioForPrint(pp[0], pp[1]);
          return;
        }
        // [FITUR 2026-10-17] Failure Mode per baris. WAJIB diperiksa SEBELUM
        // `[data-sos-unit]` di bawah, karena tombol ini berada DI DALAM baris
        // yang juga membuka Detail saat diklik.
        var fmBtn = e.target.closest('[data-sos-failmode]');
        if (fmBtn) {
          e.stopPropagation();
          var fp = fmBtn.getAttribute('data-sos-failmode').split('|');
          if (global.SOS_FAILMODE) global.SOS_FAILMODE.open(fp[0], fp[1]);
          return;
        }
        var detailBtn = e.target.closest('[data-sos-detail]');
        if (detailBtn) {
          var parts = detailBtn.getAttribute('data-sos-detail').split('|');
          openDetail(parts[0], parts[1]);
          return;
        }
        var row = e.target.closest('[data-sos-unit]');
        if (row) {
          openDetail(row.getAttribute('data-sos-unit'), row.getAttribute('data-sos-comp'));
        }
      });
    }

    // Component tab switching in detail view
    document.addEventListener('click', function (e) {
      var compBtn = e.target.closest('[data-sos-switch-comp]');
      if (compBtn) {
        var parts = compBtn.getAttribute('data-sos-switch-comp').split('|');
        openDetail(parts[0], parts[1]);
      }
    });

    // Search
    var searchInput = document.getElementById('sos-fleet-search');
    if (searchInput) {
      var runSosSearch = debounce(function () {
        render.setFleetState({ search: searchInput.value, page: 1 });
        refreshFleetDeferred();
      }, 200);
      searchInput.addEventListener('input', runSosSearch);
    }

    // [FITUR 2026-10-06] Filter SECTION (dropdown di baris filter, kiri chip).
    var sectionSel = document.getElementById('sos-fleet-section');
    if (sectionSel) {
      sectionSel.addEventListener('change', function () {
        render.setFleetState({ section: sectionSel.value, page: 1 });
        refreshFleetDeferred();
      });
    }

    // [POST-5 2026-10-03] Kontrol paginasi tabel SOS fleet.
    document.addEventListener('click', function (e) {
      var pg = e.target.closest('[data-sos-page]');
      if (!pg || pg.disabled) return;
      var p = parseInt(pg.getAttribute('data-sos-page'), 10);
      if (!p || p < 1) return;
      render.setFleetState({ page: p });
      refreshFleetDeferred();
    });

    // Indikator arah sortir pada header (▲/▼) untuk tabel SOS Equipment.
    function updateSortIndicators(activeKey, dir) {
      document.querySelectorAll('#sos-fleet-head th[data-sos-sort]').forEach(function (th) {
        var k = th.getAttribute('data-sos-sort');
        var base = th.getAttribute('data-label') || th.textContent.replace(/[\u25B2\u25BC]\s*$/, '').trim();
        th.setAttribute('data-label', base);
        th.innerHTML = base + (k === activeKey ? (dir === 'asc' ? ' <span style="font-size:11px">▲</span>' : ' <span style="font-size:11px">▼</span>') : '');
      });
    }
    // [AUDIT 2026-10-29] `window.__sosUpdateSortIndicators` DIHAPUS: nol
    // rujukan di seluruh repo. `updateSortIndicators` dipanggil dari dalam
    // modul ini saja (handler klik header di bawah).

    // Mode nilai parameter (Terakhir / Rata-rata / Terburuk)
    var valueModeSel = document.getElementById('sos-value-mode');
    if (valueModeSel) {
      valueModeSel.addEventListener('change', function () {
        render.setFleetState({ valueMode: valueModeSel.value, page: 1 });
        refreshFleetDeferred();
      });
    }

    // Quick filter chips
    var filterBar = document.getElementById('sos-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-sos-quick-filter]');
        if (chip) {
          render.setFleetState({ filter: chip.getAttribute('data-sos-quick-filter'), page: 1 });
          refreshFleetDeferred();
        }
      });
    }

    // Sort headers — semua kolom bisa diklik (asc/desc toggle).
    // Khusus "Peringkat": arah asc = 1 paling atas (paling critical).
    document.querySelectorAll('#sos-fleet-head th[data-sos-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sos-sort');
        var st = render.getFleetState();
        var dir = (st.sortKey === k && st.sortDir === 'desc') ? 'asc' : 'desc';
        render.setFleetState({ sortKey: k, sortDir: dir, page: 1 });
        refreshFleetDeferred();
        updateSortIndicators(k, dir);
      });
    });
    updateSortIndicators(render.getFleetState().sortKey, render.getFleetState().sortDir);

    // Drag & drop on SOS dropzone
    var dz = document.getElementById('sos-dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
      });
      dz.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) processFiles(dt.files);
      });
    }

  }

  /**
   * [STARTUP 2026-10-31] Beban pemuatan yang dijalankan SETELAH halaman siap:
   *   1. `store.restore()`  — jalur cepat localStorage (data + tanggal),
   *      TANPA analitik armada (lihat `isAnalysisPending()` di store).
   *   2. `hydrateStore()`   — siapkan IndexedDB (migrasi/penandan) + muat ulang.
   *   3. Setelah hydrate: rapikan cadangan lama, lalu (bila hasil armada belum
   *      dibangun) bangun BERTAHAP / gambar daftar ringan.
   */
  var _startupStarted = false;
  /**
   * [STARTUP 2026-10-31] Beban pemuatan halaman SOS, DIKERJAKAN PER TAHAP:
   * setiap langkah berat menempati tick-nya SENDIRI sehingga tidak ada satu
   * blok sinkron panjang yang menahan klik. Terukur pada 25.964 sampel:
   *   restore  ~75 ms  ·  hydrate ~110 ms  ·  cadangan lama ~70 ms
   * Bila semuanya dijalankan berderet dalam satu callback, operator merasakan
   * beku ~250 ms; dipisah per tick, event handler lain mendapat giliran di
   * antaranya.
   *
   * Tahapan:
   *   1. `store.restore()`  — jalur cepat localStorage (data + tanggal),
   *      TANPA analitik armada (lihat `isAnalysisPending()` di store).
   *   2. `hydrateStore()`   — IndexedDB: migrasi/penanda + muat ulang.
   *   3. cadangan lama dirapikan (`settleLegacy`) — sekali jalan.
   *   4. daftar ringan (`renderFleetPulse`) ATAU daftar normal.
   *   5. analitik armada BERTAHAP (potongan ±5 ms) hingga lengkap.
   */
  function scheduleStartupLoad() {
    if (_startupStarted) return;       // init() bisa terpanggil dua kali
    _startupStarted = true;
    setTimeout(tahapRestore, 0);       // tick berikutnya: handler sudah siap
  }

  function tahapRestore() {
    try { store.restore(); } catch (e) { /* cadangan rusak: hydrate yang menangani */ }
    /* Toast "dipulihkan" SENGAJA tidak di sini: isinya bisa basi bila hydrate
     * mengganti data. Pengumuman di tahap terakhir. */
    var hydrated;
    try { hydrated = hydrateStore(); } catch (e2) { hydrated = Promise.resolve(false); }
    hydrated.then(function () { setTimeout(tahapLegacy, 0); },
      function () { setTimeout(tahapLegacy, 0); });
  }

  function tahapLegacy() {
    var selesai = function () { setTimeout(tahapRenderAwal, 0); };
    try {
      if (store.settleLegacy) {
        var p = store.settleLegacy();
        if (p && typeof p.then === 'function') { p.then(selesai, selesai); return; }
      }
    } catch (e) { /* opsional */ }
    selesai();
  }

  function tahapRenderAwal() {
    setTimeout(tahapAnalitik, 0);
    if (store.count() === 0) { try { render.showView('fleet'); } catch (e) { /* belum siap */ } return; }
    if (store.getAnalysis()) { try { render.showView('fleet'); } catch (e2) { /* belum siap */ } return; }
    showFastFleetShell();             // daftar ringan (sampel saja), satu tick
  }

  function tahapAnalitik() {
    if (store.count() === 0 || store.getAnalysis()) return;
    scheduleFleetRefresh('startup').then(function (done) {
      if (done && store.count() > 0) {
        toast('Data SOS dipulihkan (' + store.count() + ' sampel).', 'info');
      }
    }, function () { /* penjadwal tidak pernah menolak; jaring pengaman */ });
  }

  /**
   * [STARTUP 2026-10-31] Penyegaran daftar yang TIDAK memblokir event handler.
   * DIGABUNG (debounce 0 ms): beberapa perubahan state dalam satu event
   * (mis. ganti section + reset halaman) hanya menghasilkan SATU gambar.
   *   - analitik belum dibangun -> `renderFleetPulse()` (pilih halaman dari
   *     sampel, lalu gambar) — tugas visual terpisah dari handler klik;
   *   - analitik sudah ada     -> `renderFleetTable()` seperti biasa.
   * @returns {boolean} true bila digambar SEGERA (jalur normal)
   */
  var _refreshTimer = null;
  function refreshFleetDeferred() {
    var segera = render.refreshFleetView();
    if (segera !== null && segera !== undefined) return segera;
    if (_refreshTimer) return false;
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      if (store.count() === 0) { render.showView('fleet'); return; }
      if (store.isAnalysisPending && store.isAnalysisPending()) render.renderFleetPulse();
      else render.refreshFleetView();
    }, 0);
    return false;
  }

  global.SOS_APP = {
    refreshFleetDeferred: refreshFleetDeferred,
    init: init,
    processFiles: processFiles,
    openDetail: openDetail,
    toast: toast,
    /* [STARTUP 2026-10-31] Dipakai vhms-app setelah Data Unit berubah: kartu
     * Section/Lifetime di tabel SOS bergantung pada data itu, tetapi analitik
     * armada tidak perlu diulang — cukup gambar ulang daftar. */
    cancelScheduledAnalysis: cancelScheduledAnalysis,
    refreshFleetView: function () {
      if (!render || !render.getView) return false;
      if (render.getView() !== 'fleet' || store.count() === 0) return false;
      if (!store.getAnalysis()) return false;
      try { render.invalidateFleetCaches(); refreshFleetDeferred(); return true; }
      catch (e) { return false; }
    },
    getState: function () {
      return {
        view: global.SOS_RENDER ? global.SOS_RENDER.getView() : 'fleet',
        currentUnit: global.SOS_RENDER ? global.SOS_RENDER.getCurrentUnit() : null
      };
    },
  };

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Defer slightly to ensure SOS modules are loaded after VHMS
    setTimeout(init, 100);
  }

})(typeof window !== 'undefined' ? window : globalThis);

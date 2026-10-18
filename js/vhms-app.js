/* =========================================================================
 * vhms-app.js
 * -------------------------------------------------------------------------
 * Controller utama: menangani pemuatan file (picker, drag & drop, contoh),
 * orkestrasi parse -> analitik -> render, navigasi tab, filter tabel,
 * ekspor CSV/laporan cetak, dan notifikasi.
 * ========================================================================= */

(function (global) {
  'use strict';

  var cfg = global.VHMS_CONFIG;
  var parser = global.VHMS_PARSER;
  var analytics = global.VHMS_ANALYTICS;
  var render = global.VHMS_RENDER;
  var fleet = global.VHMS_FLEET;
  var ranking = global.VHMS_RANKING;

  var state = {
    current: null,        // hasil analyze() unit yang sedang dibuka
    currentUnitId: null,  // id unit yang sedang dibuka di tampilan detail
    fileName: null,
    activeTab: 'overview',
    view: 'fleet',        // 'fleet' | 'unit' | 'comparison'
    ranked: null          // cache hasil ranking
  };

  /* -----------------------------------------------------------------------
   * Utilitas: debounce (batasi frekuensi render saat input cepat)
   * --------------------------------------------------------------------- */
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  /* -----------------------------------------------------------------------
   * Notifikasi toast
   * ---------------------------------------------------------------------
   * Durasi tampil dibuat PROPORSIONAL terhadap panjang pesan, namun
   * dibatasi agar tidak bertahan terlalu lama di layar:
   *   - pesan pendek  -> ~2.5 detik
   *   - pesan panjang -> maksimum ~5 detik
   * Bila `ms` diberikan eksplisit, nilai itu yang dipakai (dibatasi maks 6s).
   */
  function toast(message, type, ms) {
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) { console[type === 'err' ? 'error' : 'log'](message); return; }
    var div = document.createElement('div');
    div.className = 'toast ' + (type || 'info');
    // [P1 A11Y 2026-10-05] Error diumumkan segera oleh screen reader
    // (role=alert = assertive); info/ok cukup polite.
    if (type === 'err') { div.setAttribute('role', 'alert'); }
    else { div.setAttribute('role', 'status'); }
    var icon = type === 'err' ? 'fa-circle-exclamation' : (type === 'ok' ? 'fa-circle-check' : 'fa-circle-info');
    div.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + render.esc(message) + '</span>';
    wrap.appendChild(div);

    // Hitung durasi tampil.
    var text = String(message || '');
    var dur;
    if (ms) {
      dur = Math.min(ms, 6000);                 // batasi maksimum 6 detik
    } else {
      // ~55ms per karakter + basis 2200ms, dibatasi 2500..5000ms
      dur = Math.max(2500, Math.min(5000, 2200 + text.length * 55));
      if (type === 'err') dur = Math.min(6000, dur + 800);  // error sedikit lebih lama
    }

    setTimeout(function () {
      div.style.transition = 'opacity .3s, transform .3s';
      div.style.opacity = '0';
      div.style.transform = 'translateX(30px)';
      setTimeout(function () { div.remove(); }, 320);
    }, dur);
  }

  function showLoading(text) {
    var ov = document.getElementById('loading');
    if (!ov) return;
    ov.querySelector('p').textContent = text || 'Memuat data...';
    ov.classList.remove('hidden');
  }

  function hideLoading() {
    var ov = document.getElementById('loading');
    if (ov) ov.classList.add('hidden');
  }

  /* -----------------------------------------------------------------------
   * Inti: proses teks CSV -> dashboard
   * --------------------------------------------------------------------- */
  /* -----------------------------------------------------------------------
   * [T7.1 2026-10-08] Routing berdasarkan Data Type file VHMS.
   * ---------------------------------------------------------------------
   *   '10' -> Fault History  -> disimpan sebagai riwayat fault unit (bukan
   *           unit baru!). Butuh trend utama unit yang sama untuk dipetakan.
   *   '81' -> T/M Trend      -> digabung sebagai record trend unit yang sama
   *           (kunci identitas tetap SN + Model lewat VHMS_FLEET.add).
   *   '86' -> Chassis Trend  -> SAMA seperti '81': SMR & Calendar-nya sah,
   *           jadi digabung sebagai record trend unit yang sama. Kuncinya
   *           adalah parameter BARU `tmFill*` (fill time) + duty termal
   *           retarder & gas buang per grup silinder.
   *   'DA'/'D9' -> Matriks clutch -> BUKAN seri waktu; tidak boleh masuk
   *           `records`. Dilampirkan ke unit yang SUDAH ADA (seperti fault).
   *   selain itu ('40' / kosong) -> trend utama, jalur LAMA apa adanya.
   * @returns {string} 'fault' | 'tmTrend' | 'chassis' | 'clutch' | 'trend' | 'unknown'
   * --------------------------------------------------------------------- */
  function dataTypeOf(parsed) {
    var t = parsed && parsed.dataType ? String(parsed.dataType).trim() : '';
    if (t === '10') return 'fault';
    if (t === '81') return 'tmTrend';
    if (t === '86') return 'chassis';
    var clutch = global.VHMS_CLUTCH;
    if (clutch && clutch.isClutchType(t)) return 'clutch';
    // [PC2000 2026-10-10 — T12] Sumber data tambahan.
    //   '90'          -> Operating Availability
    //   '30'/'7F'/'7E'-> Load Map (beban mesin / torsi)
    //   '60'/'61'     -> Snapshot
    //   '31'          -> Temporary Load Map (DITOLAK, lihat D2)
    var opava = global.VHMS_OPAVA;
    if (opava && opava.isOpAvaType(t)) return 'opAva';
    var lm = global.VHMS_LOADMAP;
    if (lm && lm.isRejectedLoadMapType(t)) return 'loadMapRejected';
    if (lm && lm.isLoadMapType(t)) return 'loadMap';
    var snap = global.VHMS_SNAPSHOT;
    if (snap && snap.isSnapshotType(t)) return 'snapshot';
    // [D375A 2026-10-13] Matriks perpindahan gigi transmisi (tipe '83').
    // Sama seperti clutch: BUKAN seri waktu, menempel ke unit yang sudah ada.
    var shift = global.VHMS_SHIFTMAP;
    if (shift && shift.isShiftMapType && shift.isShiftMapType(t)) return 'shiftMap';
    // [HD785 2026-10-14] Matriks beban per gigi (13 tipe: F8/E2..E5/F9/FA/FB/
    // CA + 44/45/47/48) dan peta duty operasi (52/54/56/57/58). Keduanya
    // matriks kumulatif tanpa SMR -> menempel ke unit yang sudah ada.
    var gear = global.VHMS_GEARLOAD;
    if (gear && gear.isGearLoadType && gear.isGearLoadType(t)) return 'gearLoad';
    var duty = global.VHMS_DUTYMAP;
    if (duty && duty.isDutyMapType && duty.isDutyMapType(t)) return 'dutyMap';
    if (t === '40' || t === '') return 'trend';
    // [FIX 2026-10-13] Tipe yang SAH tetapi BELUM punya penafsir. Dipisah dari
    // 'unknown' agar pesannya jujur ("belum didukung") — bukan seolah berkas
    // rusak. Daftar ini tumbuh saat jenis baru ditambahkan; sengaja DIKURASI,
    // bukan wildcard, supaya berkas benar-benar tak dikenal tetap menonjol.
    // [HD785 2026-10-14] 18 tipe DIKELUARKAN dari daftar ini karena kini
    // punya penafsir: 13 matriks gigi (vhms-gearload.js) + 5 peta duty
    // (vhms-dutymap.js). Yang TERSISA di bawah sengaja belum ditafsirkan.
    //
    // '70'/'71' (Running Direction/Area Map) & 'D8' (TM ABUse) SENGAJA
    // tetap di sini meskipun strukturnya terbaca sempurna: tidak ada
    // legenda untuk "Area A/B/C/D" maupun "T/M AREA 1..7" di SATU PUN dari
    // 34 berkas ekspor. Menafsirkannya = mengarang. Begitu legenda Shop
    // Manual tersedia, keduanya tinggal dipindahkan ke modul penafsir.
    var UNSUPPORTED_HIST = {
      '50': 'Cycle Interval',
      '70': 'Running Direction Map', '71': 'Running Area Map',
      '88': 'L/U Shift Change Map',
      'D8': 'TM ABUse'
    };
    var UNSUPPORTED_HISTORY = { '2F': 'VHMS History', '93': 'Machine History' };
    if (UNSUPPORTED_HIST[t] || UNSUPPORTED_HISTORY[t]) return 'unsupported';
    return 'unknown';
  }

  /** Epoch terakhir dari sebuah blok `Time Stamp` VHMS (untuk pesan). */
  function stampOf(parsed) {
    var ts = parsed && parsed.meta ? parsed.meta['Time Stamp'] : null;
    return ts ? String(ts).split(',')[0].trim() : '';
  }

  /** Alias tipis: jenis berkas dari hasil parse (dipakai di alur batch). */
  function kindOf(parsed) { return dataTypeOf(parsed); }

  function processText(text, sourceName) {
    try {
      showLoading('Membaca & memvalidasi CSV...');

      // [FIX 2026-10-13] BERKAS NON-VHMS diabaikan senyap, bukan error.
      // `index00.csv` (manifes "Files Information" berisi daftar berkas unit)
      // sering ikut tercentang saat operator memilih seluruh folder. Berkas
      // itu BUKAN data telemetri dan tidak punya blok [Data] — memaksanya
      // masuk parser hanya menghasilkan "Bagian [Data] tidak ditemukan" yang
      // menakutkan tanpa sebab. Cukup lewati.
      var head = String(text).slice(0, 4000);
      if (/^\s*\[Files Information\]/im.test(head) &&
          !/^\s*\[Data\]\s*$/im.test(text)) {
        toast('"' + (sourceName || 'berkas') + '" dilewati: manifes daftar berkas (bukan data VHMS).', 'ok');
        hideLoading();
        return true;
      }

      // 1) Parse
      var parsed = parser.parse(text);
      var kind = dataTypeOf(parsed);
      var rawType = String(parsed.dataType || '').trim();

      // [T7.1] Jalur KHUSUS Fault History ('10').
      if (kind === 'fault') return processFaultText(text, sourceName);
      // [T7.3 2026-10-09] Jalur KHUSUS Matriks clutch ('DA'/'D9').
      if (kind === 'clutch') return processClutchText(text, sourceName, parsed);

      // [FIX 2026-10-13] TIPE TAK DIKENAL -> pesan yang MENJELASKAN, bukan
      // "Tidak ada baris data valid". Jenis berkas VHMS yang belum punya
      // penafsir (mis. '83' T/M Shift Change Map, '88' L/U Shift Change Map,
      // '50' Cycle Interval) sebelum ini jatuh ke jalur trend, menghasilkan
      // 0 record, lalu ditolak dengan pesan menyesatkan — seolah berkasnya
      // rusak. Padahal berkasnya SAH, hanya belum didukung.
      if (kind === 'unknown') {
        throw new Error('Jenis berkas VHMS tipe "' + (rawType || '?') + '" belum didukung ' +
          '(judul: ' + (parsed.dataTitle || '—') + '). Berkasnya tidak rusak — ' +
          'jenis ini memang belum punya penafsir. Muat berkas trend (' +
          'Trend Analysis / Chassis Trend / T/M Trend), Fault History, clutch, ' +
          'Load Map, Snapshot, atau Operating Availability.');
      }
      // [FIX 2026-10-13] Tipe SAH yang belum ditafsirkan (histogram/riwayat).
      // Ditolak dengan pesan JUJUR + tidak menghentikan berkas lain dalam
      // batch yang sama. Sebelumnya ini jatuh ke jalur trend dan muncul
      // sebagai "Tidak ada baris data valid" — seolah berkasnya rusak.
      if (kind === 'unsupported') {
        throw new Error('tidak didukung: ' + (parsed.dataTitle || ('tipe ' + rawType)) +
          ' (tipe ' + (rawType || '?') + '). Berkas ini SAH tetapi belum punya ' +
          'penafsir di aplikasi. Berkas lain pada pilihan yang sama tetap dimuat.');
      }

      if (!parsed.records.length && kind !== 'chassis') throw new Error('File tidak mengandung baris data.');
      if (!parsed.records.length) throw new Error('File tidak mengandung baris data.');

      // 2) Analitik
      showLoading('Menghitung analitik & mendeteksi anomali...');
      var analysis = analytics.analyze(parsed);
      analysis.sourceFile = sourceName || 'data.csv';
      // [T7.2] Teruskan tipe file agar unit tahu ini record tambahan trend
      // (T/M Trend) atau trend utama.
      analysis.dataType = parsed.dataType || '40';
      // [B2 2026-10-10] Tandai bila parser terpaksa memakai pemetaan kolom
      // posisional. Dipakai gerbang migrasi saat restore untuk membuang
      // unit yang datanya tercemar oleh bug fallback lama.
      analysis.usedFallback = parsed.usedFallback === true;

      // 3) Daftarkan ke fleet (bisa merge bila SN sudah ada).
      // [KONSISTENSI NAVIGASI 2026-10-03] JANGAN langsung buka detail unit.
      // Alur harus sama dengan SOS: setelah upload -> halaman DAFTAR UNIT,
      // lalu detail dibuka hanya saat pengguna menekan tombol "Detail".
      var res = fleet.add(analysis, sourceName);
      showFleetView();

      var nCrit = analysis.anomalies.filter(function (a) { return a.status === 'CRITICAL'; }).length;
      var msg;
      if (res.merged) {
        msg = 'Unit SN ' + (analysis.meta.serial || '—') + ' digabung (+' + res.addedRecords +
          ' record baru). Total ' + analysis.records.length + ' record.';
      } else {
        msg = 'Berhasil memuat ' + analysis.records.length + ' record dari "' + (sourceName || 'data.csv') + '".';
      }
      if (kind === 'tmTrend') msg = 'T/M Trend: ' + msg;
      if (kind === 'chassis') msg = 'Chassis Trend: ' + msg;
      if (nCrit > 0) msg += ' ' + nCrit + ' anomali kritis terdeteksi.';
      var vRep = analysis.validationReport;
      if (vRep && (vRep.droppedInvalidSmr || vRep.droppedDuplicate)) {
        msg += ' Validasi: ' + global.VHMS_VALIDATE.summarizeReport(vRep) + '.';
      }
      toast(msg, (nCrit > 0 || (vRep && (vRep.droppedInvalidSmr || vRep.droppedDuplicate))) ? 'err' : 'ok');

      hideLoading();
      return true;
    } catch (err) {
      hideLoading();
      console.error(err);
      toast('Gagal memuat: ' + err.message, 'err');
      return false;
    }
  }

  /* -----------------------------------------------------------------------
   * [T7.1] Fault History ('10') -> simpan sebagai riwayat fault unit.
   * ---------------------------------------------------------------------
   * ATURAN PENTING: file fault TIDAK PERNAH membuat unit baru. Ia hanya
   * melengkapi unit yang SUDAH ADA (dicocokkan lewat SN + Model). Bila unit
   * belum ada, kita menolak dengan pesan jelas — lebih baik daripada
   * membuat unit "hantu" tanpa data trend (sumbu waktu fault tidak akan
   * bisa dipetakan). Lihat docs/STATUS_PROYEK.md §2.4.
   * --------------------------------------------------------------------- */
  function processFaultText(text, sourceName) {
    var fp = global.VHMS_FAULT_PARSER;
    if (!fp) return processTrendFallback(text, sourceName, 'Parser fault tidak tersedia.');

    var fault = fp.parseFault(text);
    if (!fault.events.length) throw new Error('File fault tidak mengandung event.');

    // Cari unit dengan SN + Model yang sama.
    var meta = fault.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast('File fault "' + (sourceName || 'fault.csv') + '" memuat ' + fault.events.length +
        ' event, tetapi unit SN ' + (meta['Machine Serial No.'] || '—') +
        ' belum ada di armada. Muat dulu "trend0.CSV" unit ini (boleh dipilih ' +
        'bersamaan dengan fault0.CSV), lalu ulangi.', 'err');
      return false;
    }

    var unit = fleet.get(id);
    var analysis = fleet.getAnalysis(id);
    // Titipkan event fault pada objek analysis lalu simpan ulang unit.
    // fleet.add() akan mengenali SN yang sama -> merge, dan _attachFault()
    // menghitung faultSummary + menerapkan gerbang kualitas data.
    var res = fleet.add({
      meta: analysis.meta,
      columns: analysis.columns,
      units: analysis.units,
      records: analysis.records || [],
      _faultEvents: fault.events
    }, sourceName);

    showFleetView();
    var maskRep = fleet.getMaskReport(id);
    var msg = 'Riwayat fault unit SN ' + (meta['Machine Serial No.'] || '—') + ': ' +
      fault.events.length + ' event, ' + fault.events.filter(function (e) { return e.active; }).length +
      ' masih aktif.';
    if (maskRep && maskRep.maskCount) {
      msg += ' ' + maskRep.maskCount + ' parameter dikecualikan dari skor.';
    }
    toast(msg, (maskRep && maskRep.maskCount) ? 'err' : 'ok');
    hideLoading();
    return true;
  }

  /* ---------------------------------------------------------------------
   * [R4-HD 2026-10-09] Info OVERHAUL transmisi/clutch dari data Lifetime.
   * ---------------------------------------------------------------------
   * Matriks clutch bersifat kumulatif seumur hidup; setelah transmisi/clutch
   * di-overhaul, matriks harus dibersihkan (konsep CLC: hanya pakai data
   * pasca-pemasangan komponen terakhir). Sumber tanggal = kolom
   * `Last Install` / `LastTecoDate` pada berkas Lifetime untuk komponen
   * powertrain (TRANSMISSION / TORQUE CONVERTER / CLUTCH).
   *
   * Return null bila unit tidak ada di Lifetime atau tidak ada baris T/M.
   * --------------------------------------------------------------------- */
  function overhaulInfoFor(serial, modelOrLambung) {
    var store = global.PORTFOLIO_STORE;
    var clutch = global.VHMS_CLUTCH;
    if (!store || !store.getLifetime) return null;

    var lambung = modelOrLambung || serial;
    try {
      if (store.resolveLambung) lambung = store.resolveLambung(modelOrLambung || serial, serial) || lambung;
    } catch (e) { /* pakai apa adanya */ }

    var rows = [];
    try { rows = store.getLifetime(lambung) || []; } catch (e) { rows = []; }
    if (!rows.length && lambung !== serial) {
      try { rows = store.getLifetime(serial) || []; } catch (e2) { rows = []; }
    }
    if (!rows.length) return null;

    var re = (clutch && clutch.OVERHAUL_COMPONENT_RE) || /(transmission|transmisi|torque|clutch|powertrain)/i;
    var best = null;
    rows.forEach(function (r) {
      if (!r || !r.component) return;
      if (!re.test(String(r.component))) return;
      var date = r.installDate || null;
      var ageHours = (typeof r.ageHours === 'number') ? r.ageHours : null;
      // Pilih yang berumur komponen PALING BESAR (yang terakhir lama terpasang)
      // — bila ada beberapa baris powertrain, ambil yang paling informatif.
      if (!best || (ageHours !== null && best.ageHours !== null && ageHours > best.ageHours) ||
          (date && !best.date)) {
        best = { date: date, ageHours: ageHours, component: r.component };
      }
    });
    if (!best) return null;
    return {
      date: best.date,
      ageHoursAtOverhaul: best.ageHours,
      component: best.component,
      source: 'Lifetime Last Install / LastTecoDate'
    };
  }

  /* ---------------------------------------------------------------------
   * [T7.3 2026-10-09] Matriks clutch (`clutch_slip.CSV` / `clutch_therm.CSV`).
   * ---------------------------------------------------------------------
   * ATURAN SAMA dengan fault0.CSV: berkas matriks TIDAK PERNAH membuat unit
   * baru. Ia melengkapi unit yang SUDAH ADA (dicocokkan SN + Model), karena
   * tanpa unit induk tidak ada konteks SMR/model untuk menafsirkan matriks.
   *
   * Berbeda dari fault, matriks TIDAK memengaruhi gerbang kualitas data
   * (tidak mem-mask apa pun) — ia melengkapi sebagai `unit.clutchMatrix`.
   * --------------------------------------------------------------------- */
  function processClutchText(text, sourceName, parsed) {
    var clutch = global.VHMS_CLUTCH;
    if (!clutch) {
      hideLoading();
      toast('Modul matriks clutch (vhms-clutch.js) tidak tersedia.', 'err');
      return false;
    }
    var matrix = clutch.parseClutchMatrix(text, {
      dataType: parsed && parsed.dataType,
      sourceName: sourceName
    });
    if (!matrix.topPosition) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'clutch.csv') + '" tidak memuat baris ' +
        'posisi clutch yang dapat dibaca.', 'err');
      return false;
    }

    var meta = matrix.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast('Berkas matriks clutch "' + (sourceName || 'clutch.csv') +
        '" memuat ' + matrix.severityRank.length + ' posisi, tetapi unit SN ' +
        (meta['machine serial no.'] || meta['Machine Serial No.'] || '—') +
        ' belum ada di armada. Muat dulu "trend0.CSV" unit ini (boleh dipilih ' +
        'bersamaan), lalu ulangi.', 'err');
      return false;
    }

    // [R4-HD] Bersihkan matriks pra-overhaul (konsep CLC) bila info tersedia.
    var serial = metaValue(meta, 'Machine Serial No.');
    var ovh = overhaulInfoFor(serial, serial);
    var cutRes = { cut: false, reason: 'Info overhaul tidak tersedia — matriks dipakai apa adanya.' };
    try {
      if (ovh && typeof clutch.applyOverhaulCut === 'function') {
        cutRes = clutch.applyOverhaulCut(matrix, {
          overhaulDate: ovh.date,
          ageHoursAtOverhaul: ovh.ageHoursAtOverhaul,
          component: ovh.component,
          source: ovh.source
        });
      }
    } catch (e) {
      cutRes = { cut: false, reason: 'Gagal menilai overhaul: ' + (e && e.message) };
    }

    var res = fleet.attachClutchMatrix(id, matrix, sourceName);
    if (!res) {
      hideLoading();
      toast('Gagal melampirkan matriks clutch ke unit.', 'err');
      return false;
    }

    showFleetView();
    var top = matrix.severityRank[0];
    var msg = (matrix.kind === 'thermal' ? 'Thermal load' : 'Slip time') +
      ' clutch SN ' + (serial || '—') + ' terlampir: ' +
      matrix.severityRank.length + ' posisi. Tertinggi: ' + top.position +
      (top.saturated ? ' (skor = batas bawah, sel bersaturasi)' : '') + '.';
    if (cutRes.cut) {
      msg += ' DIBERSIHKAN: snapshot sebelum overhaul ' + (matrix.overhaulDate && matrix.overhaulDate.iso) +
        ' — matriks tidak dipakai untuk skoring.';
      toast(msg, 'info');
    } else {
      toast(msg, matrix.anySaturated ? 'info' : 'ok');
    }
    hideLoading();
    return true;
  }

  /** Fallback: tampilkan pesan lalu coba jalur trend biasa. */
  function processTrendFallback(text, sourceName, reason) {
    hideLoading();
    toast('Gagal memuat fault: ' + reason, 'err');
    return false;
  }

  /* -----------------------------------------------------------------------
   * [D375A 2026-10-13] T/M Shift Change Map ('83') -> unit.shiftMap.
   * ---------------------------------------------------------------------
   * Matriks perpindahan gigi transmisi (From x To). Mengikuti ATURAN YANG
   * SAMA dengan clutch/fault: TIDAK PERNAH membuat unit baru — hanya
   * melengkapi unit yang sudah ada (dicocokkan lewat SN + Model).
   * --------------------------------------------------------------------- */
  function processShiftMapText(text, sourceName, parsed) {
    var sm = global.VHMS_SHIFTMAP;
    if (!sm) { hideLoading(); toast('Modul Shift Change Map tidak tersedia.', 'err'); return false; }

    var res = sm.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    if (!res.rowLabels.length || !res.indicators) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'tm_sft0.CSV') + '" tidak memuat baris posisi transmisi.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'),
        res.rowLabels.length + ' posisi'), 'err');
      return false;
    }

    var stored = fleet.attachShiftMap(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan Shift Change Map ke unit.', 'err'); return false; }

    showFleetView();
    var I = res.indicators;
    var msg = 'Perpindahan gigi SN ' + (metaValue(meta, 'Machine Serial No.') || '—') +
      ' terlampir: ' + fmtIntSafe(I.totalShift) + ' perpindahan seumur hidup.';
    if (I.biggestCell) {
      msg += ' Terbanyak: ' + I.biggestCell.from + '\u2192' + I.biggestCell.to + '.';
    }
    if (I.selfShift > 0) msg += ' PERINGATAN: diagonal berisi ' + fmtIntSafe(I.selfShift) + '.';
    toast(msg, I.selfShift > 0 ? 'info' : 'ok');
    hideLoading();
    return true;
  }

  /* -----------------------------------------------------------------------
   * [HD785 2026-10-14] MATRIKS BEBAN PER GIGI (13 tipe) -> unit.gearLoad.
   * ---------------------------------------------------------------------
   * Berbeda dari sumber lain: SATU unit menerima SAMPAI 13 berkas yang
   * bersama-sama membentuk satu gambaran. Setiap berkas dilampirkan
   * sendiri-sendiri; ringkasan (pangsa L/U vs T/C, jam per gigi) dihitung
   * ulang oleh store setiap kali ada yang menempel.
   *
   * Toast sengaja menampilkan ringkasan KUMULATIF (bukan per berkas) agar
   * operator langsung melihat gambaran utuh tanpa menjumlah sendiri 13 toast.
   * --------------------------------------------------------------------- */
  function processGearLoadText(text, sourceName, parsed) {
    var gl = global.VHMS_GEARLOAD;
    if (!gl) { hideLoading(); toast('Modul beban per gigi tidak tersedia.', 'err'); return false; }

    var res;
    try {
      res = gl.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    } catch (e) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'matriks gigi') + '" gagal dibaca: ' + e.message, 'err');
      return false;
    }
    if (!res.matrix.length) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'matriks gigi') + '" tidak memuat baris data.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'),
        'matriks beban gigi ' + (res.gear || '?')), 'err');
      return false;
    }

    var stored = fleet.attachGearLoad(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan matriks beban gigi ke unit.', 'err'); return false; }

    showFleetView();
    var s = stored.summary;
    var msg = 'Beban gigi ' + (res.gear || '?') +
      ' (' + (res.mode === gl.MODE_LOCKUP ? 'lock-up' : 'torque converter') + ') SN ' +
      (metaValue(meta, 'Machine Serial No.') || '—') + ' terlampir';
    if (res.hours !== null) msg += ': ' + fmtIntSafe(Math.round(res.hours)) + ' jam';
    msg += '.';
    if (s && s.totalHours !== null) {
      msg += ' Total ' + s.fileCount + ' gigi = ' + fmtIntSafe(Math.round(s.totalHours)) +
        ' jam jalan, lock-up ' + s.lockupShare.toFixed(1) + ' %.';
    }
    toast(msg, 'ok');
    hideLoading();
    return true;
  }

  /* -----------------------------------------------------------------------
   * [HD785 2026-10-14] PETA DUTY OPERASI (52/54/56/57/58) -> unit.dutyMap.
   * ---------------------------------------------------------------------
   * '52' & '54' adalah PASANGAN (bermuatan vs kosong) — selisihnya dihitung
   * store begitu keduanya ada. Toast menonjolkan pola TERBALIK bila terjadi,
   * karena itulah satu-satunya temuan yang langsung dapat ditindaklanjuti.
   * --------------------------------------------------------------------- */
  function processDutyMapText(text, sourceName, parsed) {
    var dm = global.VHMS_DUTYMAP;
    if (!dm) { hideLoading(); toast('Modul peta duty tidak tersedia.', 'err'); return false; }

    var res;
    try {
      res = dm.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    } catch (e) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'peta duty') + '" gagal dibaca: ' + e.message, 'err');
      return false;
    }
    if (!res.kind) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'peta duty') + '" bukan peta duty yang dikenali.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'),
        (res.label || 'peta duty')), 'err');
      return false;
    }

    var stored = fleet.attachDutyMap(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan peta duty ke unit.', 'err'); return false; }

    showFleetView();
    var msg = (res.label || 'Peta duty') + ' SN ' +
      (metaValue(meta, 'Machine Serial No.') || '—') + ' terlampir';
    if (res.hours !== null) msg += ': ' + fmtIntSafe(Math.round(res.hours)) + ' jam';
    else if (res.zones && res.zones.startCount) msg += ': ' + fmtIntSafe(res.zones.startCount) + ' kali start';
    msg += '.';

    var tone = 'ok';
    var d = stored.loadedDelta;
    if (d) {
      if (d.lugInverted) {
        msg += ' ⚠ ' + d.invertedNote;
        tone = 'info';
      } else {
        msg += ' Zona LUG bermuatan ' + d.zonesLoaded.lugShare.toFixed(1) +
          ' % vs kosong ' + d.zonesUnloaded.lugShare.toFixed(1) + ' % (pola wajar).';
      }
    }
    toast(msg, tone, tone === 'info' ? 9000 : 5000);
    hideLoading();
    return true;
  }

  /** Pemformat ribuan aman (hindari error bila util belum siap). */
  function fmtIntSafe(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var u = global.UI_UTIL;
    if (u && typeof u.fmtInt === 'function') return u.fmtInt(n);
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /* -----------------------------------------------------------------------
   * [PC2000 2026-10-10 — T12] SUMBER DATA TAMBAHAN (menempel ke unit ADA).
   * ---------------------------------------------------------------------
   * Ketiganya mengikuti ATURAN YANG SAMA dengan fault0/clutch: TIDAK PERNAH
   * membuat unit baru, hanya melengkapi unit yang sudah ada (cocok SN).
   * Tanpa unit induk tidak ada konteks SMR/model untuk menafsirkannya.
   * --------------------------------------------------------------------- */

  /** Pesan baku saat unit induk belum ada. */
  function needParentUnit(namaBerkas, serial, jumlah) {
    return 'Berkas "' + (namaBerkas || 'data.csv') + '" memuat ' + jumlah +
      ' data, tetapi unit SN ' + (serial || '—') + ' belum ada di armada. ' +
      'Muat dulu berkas trend unit ini (boleh dipilih bersamaan), lalu ulangi.';
  }

  /** Load Map ('30'/'7F'/'7E') -> unit.loadMap / unit.torqueMap. */
  function processLoadMapText(text, sourceName, parsed) {
    var lm = global.VHMS_LOADMAP;
    if (!lm) { hideLoading(); toast('Modul Load Map tidak tersedia.', 'err'); return false; }

    var res = lm.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    if (res.rejected) {
      hideLoading();
      toast('Berkas "' + (sourceName || 'loadm.csv') + '" diabaikan: ' +
        (res.warnings[0] || 'Temporary Load Map ditolak.'), 'err', 7000);
      return false;
    }
    if (!res.matrix.length) {
      hideLoading();
      toast('Berkas Load Map "' + (sourceName || 'loadm.csv') + '" tidak memuat baris data.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'), res.rowLabels.length + ' baris'), 'err');
      return false;
    }

    var stored = fleet.attachLoadMap(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan Load Map ke unit.', 'err'); return false; }

    showFleetView();
    var label = res.kind === lm.KIND_ENGINE_LOAD ? 'Beban mesin' :
      (res.kind === lm.KIND_TORQUE_WORK ? 'Torsi pompa kerja' : 'Torsi seluruh pompa');
    var z = res.zones || {};
    var msg = label + ' SN ' + (metaValue(meta, 'Machine Serial No.') || '—') + ' terlampir.';
    if (z.lugShare !== undefined) msg += ' Zona LUG ' + z.lugShare.toFixed(1) + ' %.';
    else if (z.highTorqueShare !== undefined) msg += ' Torsi >3000 Nm ' + z.highTorqueShare.toFixed(1) + ' %.';
    toast(msg, 'ok');
    hideLoading();
    return true;
  }

  /** Snapshot ('60'/'61') -> daftar snapshot unit (kunci SMR+Trigger). */
  function processSnapshotText(text, sourceName, parsed) {
    var snap = global.VHMS_SNAPSHOT;
    if (!snap) { hideLoading(); toast('Modul Snapshot tidak tersedia.', 'err'); return false; }

    var res = snap.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    if (!res.rowCount) {
      hideLoading();
      toast('Berkas snapshot "' + (sourceName || 'snap.csv') + '" tidak memuat data.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'), res.rowCount + ' titik'), 'err');
      return false;
    }

    var stored = fleet.attachSnapshot(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan snapshot ke unit.', 'err'); return false; }

    showFleetView();
    var msg = 'Snapshot SN ' + (metaValue(meta, 'Machine Serial No.') || '—') +
      ' terlampir: ' + res.rowCount + ' titik, pemicu ' +
      (res.trigger.code || '—') + ' @ ' + (res.trigger.smr !== null ? res.trigger.smr + ' h' : '—') + '.';
    if (res.summary.stuckCount) {
      msg += ' ' + res.summary.stuckCount + ' kolom stuck terdeteksi (' + res.summary.stuckColumns.join(', ') + ').';
    }
    toast(msg, res.summary.stuckCount ? 'info' : 'ok');
    hideLoading();
    return true;
  }

  /** Operating Availability ('90') -> unit.opAvailability. */
  function processOpAvaText(text, sourceName, parsed) {
    var op = global.VHMS_OPAVA;
    if (!op) { hideLoading(); toast('Modul Operating Availability tidak tersedia.', 'err'); return false; }

    var res = op.parse(text, { dataType: parsed && parsed.dataType, sourceName: sourceName });
    if (!res.windows.length) {
      hideLoading();
      toast('Berkas Operating Availability "' + (sourceName || 'op_ava.csv') + '" tidak memuat jendela.', 'err');
      return false;
    }

    var meta = res.meta || {};
    var id = findUnitIdByMeta(meta);
    if (!id) {
      hideLoading();
      toast(needParentUnit(sourceName, metaValue(meta, 'Machine Serial No.'), res.windows.length + ' jendela'), 'err');
      return false;
    }

    var stored = fleet.attachOpAva(id, res, sourceName);
    if (!stored) { hideLoading(); toast('Gagal melampirkan Operating Availability ke unit.', 'err'); return false; }

    showFleetView();
    var s = res.summary;
    var msg = 'Op. Availability SN ' + (metaValue(meta, 'Machine Serial No.') || '—') + ' terlampir: ' +
      s.windowCount + ' jendela (' + s.activeWindowCount + ' aktif), utilisasi ' +
      (s.utilizationOverall !== null ? s.utilizationOverall.toFixed(1) : '—') + ' jam/hari.';
    if (s.staleGaps && s.staleGaps.length) msg += ' ⚠ ' + s.staleGaps.length + ' celah data > 7 hari.';
    toast(msg, (s.staleGaps && s.staleGaps.length) ? 'info' : 'ok');
    hideLoading();
    return true;
  }

  /** Baca nilai meta dengan kunci yang tahan huruf besar/kecil & spasi. */
  function metaValue(meta, wantedKey) {
    if (!meta) return '';
    if (meta[wantedKey] !== undefined) return meta[wantedKey];
    var norm = String(wantedKey).toLowerCase().replace(/\s+/g, '');
    var keys = Object.keys(meta);
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).toLowerCase().replace(/\s+/g, '') === norm) {
        return meta[keys[i]];
      }
    }
    return '';
  }

  /** Cari ID unit armada berdasar SN (+ Model) tanpa memuat records. */
  function findUnitIdByMeta(meta) {
    // [FIX 2026-10-09] Kunci meta TIDAK konsisten antar parser: fault-parser
    // menulis 'Machine Serial No.' (huruf besar) sementara clutch-parser
    // menulis 'machine serial no.' (huruf kecil). Membaca kunci secara literal
    // membuat pencocokan clutch SELALU gagal ("unit belum ada di armada")
    // padahal unitnya ada. Karena itu pencarian dilewatkan metaValue().
    var serial = normSerialKey(metaValue(meta, 'Machine Serial No.'));
    if (!serial) return null;
    var ids = fleet.ids();
    for (var i = 0; i < ids.length; i++) {
      var u = fleet.get(ids[i]);
      var um = (u && u.analysis && u.analysis.meta) || {};
      if (normSerialKey(um.serial) === serial) return ids[i];
    }
    return null;
  }

  function normSerialKey(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /* -----------------------------------------------------------------------
   * Buka satu unit di tampilan detail
   * --------------------------------------------------------------------- */
  function openUnit(id) {
    var analysis = fleet.getAnalysis(id);
    if (!analysis) { toast('Unit tidak ditemukan.', 'err'); return; }

    state.currentUnitId = id;
    state.current = analysis;
    state.fileName = analysis.sourceFile || id;
    state.view = 'unit';

    render.renderAll(analysis);
    showUnitView();
  }

  function showUnitView() {
    toggle('fleet-area', false);
    toggle('comparison-area', false);
    toggle('cross-area', false);
    // [ISOLASI VIEW] Sembunyikan halaman Portofolio saat membuka detail unit.
    toggle('portfolio-area', false);
    setHeaderCompact(false);
    if (state.current && render.renderHeader) {
      render.renderHeader(state.current);
    }
    document.getElementById('dashboard-area').classList.remove('hidden');
    document.getElementById('welcome-area').classList.add('hidden');
    setBannerVisible(true);
    // Aktifkan tab default saat membuka unit
    switchTab('overview');
  }

  /**
   * [GUARD PORTOFOLIO] Apakah halaman PORTOFOLIO sedang terbuka?
   * Bila ya, fungsi-fungsi navigasi VHMS TIDAK boleh menampilkan/menyembunyikan
   * area VHMS, agar tidak menimpa tampilan Portofolio (mis. race condition
   * restoreActiveMode yang tertunda, atau navigasi yang tak diinginkan).
   */
  function isPortfolioOpen() {
    var pf = document.getElementById('portfolio-area');
    return !!(pf && !pf.classList.contains('hidden'));
  }

  function showFleetView() {
    // [GUARD PORTOFOLIO] Jangan timpa tampilan Portofolio bila sedang terbuka.
    // Ini mencegah race condition restoreActiveMode() (yang tertunda) dan
    // navigasi tak sengaja memunculkan dropzone VHMS di atas Portofolio.
    if (isPortfolioOpen()) return;
    state.view = 'fleet';
    render.resetCharts();
    setBannerVisible(false);
    toggle('table-section', false);
    toggle('dashboard-area', false);
    toggle('comparison-area', false);
    toggle('cross-area', false);
    toggle('welcome-area', false);
    // [REVISI #7] Pastikan heatmap tertutup & daftar katalog tampil kembali.
    toggle('fleet-heatmap-panel', false);
    toggle('fleet-list-wrap', true);

    // [HEADER HOME] Katalog unit BUKAN detail unit -> header diringkas:
    // sembunyikan chip SN/keluarga/ONLINE, subjudul Engine, dan statistik
    // (SMR/Health/RUL) agar header fokus ke nama perusahaan di halaman home.
    setHeaderCompact(true);
    if (render.resetHeader) render.resetHeader();

    if (fleet.count() > 0) {
      toggle('fleet-area', true);
      render.renderFleet(fleet.fleetStats());
    } else {
      // Belum ada data -> hanya form upload yang tampil.
      toggle('fleet-area', false);
      toggle('welcome-area', true);
    }
  }

  /** Ringkas/lebarkan statistik & chip pada header.
   *  compact = true  -> halaman home/katalog (header nama perusahaan)
   *  compact = false -> detail unit (tampilkan identitas & statistik unit)
   */
  function setHeaderCompact(compact) {
    var header = document.querySelector('.app-header');
    if (header) header.classList.toggle('header-compact', !!compact);
  }

  /* -----------------------------------------------------------------------
   * Tampilan Perbandingan Unit (ranking criticalitas)
   * --------------------------------------------------------------------- */
  function showComparisonView() {
    if (fleet.count() === 0) {
      toast('Belum ada unit. Muat file CSV terlebih dahulu.', 'err');
      return;
    }
    state.view = 'comparison';

    showLoading('Menghitung peringkat criticalitas...');
    // beri jeda 1 frame agar overlay loading sempat tampil
    setTimeout(function () {
      // Hitung ulang (atau pakai cache bila data tak berubah)
      state.ranked = ranking.rankFleet(fleet, { model: 'ALL' });

      toggle('fleet-area', false);
      toggle('dashboard-area', false);
      toggle('welcome-area', false);
      toggle('comparison-area', true);
      toggle('cross-area', false);
      // [ISOLASI VIEW] Sembunyikan juga halaman Portofolio agar tidak bocor
      // (muncul di bawah) saat masuk ke Comparison.
      toggle('portfolio-area', false);
      setBannerVisible(false);
      // [HEADER HOME] Perbandingan bukan detail unit -> header ringkas + netral.
      setHeaderCompact(true);
      if (render.resetHeader) render.resetHeader();

      // Isi dropdown model dari data yang ada
      var modelSel = document.getElementById('comparison-model');
      if (modelSel) {
        var models = {};
        fleet.rows().forEach(function (r) { if (r.model) models[r.model] = true; });
        var opts = '<option value="ALL">Semua Model</option>';
        Object.keys(models).sort().forEach(function (m) {
          opts += '<option value="' + render.esc(m) + '">' + render.esc(m) + '</option>';
        });
        modelSel.innerHTML = opts;
        modelSel.value = render.getCompState().model || 'ALL';
      }

      render.setCompState({ model: modelSel ? modelSel.value : 'ALL' });
      render.renderComparison(state.ranked);
      switchCompTab('rank');
      hideLoading();
    }, 30);
  }

  /* -----------------------------------------------------------------------
   * [CROSS ANALYSIS] Tampilan korelasi VHMS x SOS
   * --------------------------------------------------------------------- */
  function showCrossView() {
    if (fleet.count() === 0) {
      toast('Belum ada unit VHMS. Muat file telemetri terlebih dahulu.', 'err');
      return;
    }
    if (!global.SOS_STORE || global.SOS_STORE.count() === 0) {
      toast('Belum ada data SOS. Muat file lab SOS untuk analisa silang.', 'err');
      return;
    }
    state.view = 'cross';
    toggle('welcome-area', false);
    toggle('fleet-area', false);
    toggle('comparison-area', false);
    toggle('dashboard-area', false);
    // [ISOLASI VIEW] Cross Analysis adalah area mandiri: sembunyikan area SOS
    // agar tidak bocor/tumpang-tindih saat dibuka dari mode SOS.
    toggle('sos-area', false);
    // [ISOLASI VIEW] Sembunyikan juga halaman Portofolio agar tidak bocor
    // (muncul di bawah) saat masuk ke Cross Analysis.
    toggle('portfolio-area', false);
    toggle('cross-area', true);
    setBannerVisible(false);
    // Header ringkas + netral (bukan detail unit).
    setHeaderCompact(true);
    if (render.resetHeader) render.resetHeader();
    if (global.VHMS_CROSS_RENDER) global.VHMS_CROSS_RENDER.showCross();
  }

  /* -----------------------------------------------------------------------
   * Pemuatan BANYAK file sekaligus (multi-upload)
   * Diproses BERTAHAP agar UI tidak membeku pada 200+ file.
   * --------------------------------------------------------------------- */
  function processFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /\.(csv|txt)$/i.test(f.name);
    });
    if (!files.length) {
      toast('Tidak ada file .csv/.txt yang valid pada pilihan tersebut.', 'err');
      return;
    }

    var okCount = 0, failCount = 0, critCount = 0, mergeCount = 0, fixedCount = 0;
    var faultCount = 0, tmCount = 0, chassisCount = 0, clutchCount = 0;
    // [D375A 2026-10-13] Matriks perpindahan gigi terlampir.
    var shiftMapCount = 0;
    // [HD785 2026-10-14] Matriks beban per gigi & peta duty terlampir.
    var gearLoadCount = 0, dutyMapCount = 0;
    // [PC2000 2026-10-10 — T12] Sumber data tambahan (menempel ke unit ada).
    var loadMapCount = 0, snapshotCount = 0, opAvaCount = 0, rejectedCount = 0;
    // [FIX 2026-10-13] Hitungan berkas SAH yang belum punya penafsir.
    var unsupportedCount = 0;
    // [FIX 2026-10-13] Berkas non-VHMS yang dilewati (manifes daftar berkas).
    var skippedManifest = [];
    var i = 0;
    var CHUNK = 6;   // jumlah file per giliran agar browser tetap responsif

    // [FIX 2026-10-08] Fault History ('10') hanya bisa dilampirkan ke unit
    // yang SUDAH ada di armada (T7.1). Bila pengguna memilih trend0.CSV dan
    // fault0.CSV sekaligus, urutan pilihan file tidak dijamin — fault bisa
    // diproses lebih dulu lalu ditolak "unit belum ada". Karena itu seluruh
    // berkas fault DITUNDA sampai semua trend selesai dimuat.
    var faultQueue = [];

    // [T7.3 2026-10-09] Matriks clutch ('DA'/'D9') punya ketergantungan SAMA:
    // harus dilampirkan ke unit yang sudah ada. Ditunda dengan alasan identik.
    var clutchQueue = [];

    // [D375A 2026-10-13] Matriks perpindahan gigi ('83') menempel ke unit yang
    // sudah ada — ditunda dengan alasan yang sama persis.
    var shiftMapQueue = [];

    // [HD785 2026-10-14] Matriks beban per gigi (13 berkas) & peta duty
    // (5 berkas) juga MENEMPEL ke unit yang sudah ada. Ditunda sama persis.
    // Catatan: antrean gigi bisa berisi 13 entri dari satu ekspor — itu
    // normal, bukan duplikat (tiap berkas = satu gigi/mode berbeda).
    var gearLoadQueue = [];
    var dutyMapQueue = [];

    // [PC2000 2026-10-10 — T12] Load Map / Snapshot / Op. Availability juga
    // MENEMPEL ke unit yang sudah ada (tidak pernah membuat unit baru).
    // Ditunda dengan alasan yang sama persis.
    var loadMapQueue = [];
    var snapshotQueue = [];
    var opAvaQueue = [];
    // [FIX 2026-10-13] Tipe SAH yang belum punya penafsir (histogram/riwayat).
    // Dikumpulkan agar dilaporkan JUJUR di akhir, bukan muncul sebagai
    // "gagal" per berkas dengan pesan teknis yang menakutkan.
    var unsupportedQueue = [];
    // Berkas yang SENGAJA ditolak (mis. Temporary Load Map '31'). Dikumpulkan
    // terpisah agar operator diberi tahu, bukan hilang diam-diam (D2).
    var rejectedQueue = [];

    function step() {
      var end = Math.min(i + CHUNK, files.length);
      var batch = files.slice(i, end);

      var jobs = batch.map(function (f) {
        return parser.parseFile(f).then(function (parsed) {
          // [T7.1] Fault History ('10') tidak membuat unit baru — ia
          // melengkapi unit yang sudah ada lewat SN + Model.
          if (String(parsed.dataType || '').trim() === '10') {
            faultQueue.push({ text: parsed._rawText || '', name: f.name });
            return;
          }
          // [T7.3] Matriks clutch juga tidak membuat unit baru.
          if (kindOf(parsed) === 'clutch') {
            clutchQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed });
            return;
          }
          // [D375A 2026-10-13] Matriks perpindahan gigi juga tidak membuat unit baru.
          if (kindOf(parsed) === 'shiftMap') {
            shiftMapQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed });
            return;
          }
          // [T12] Sumber data PC2000 yang menempel ke unit yang ada.
          var k2 = kindOf(parsed);
          if (k2 === 'loadMapRejected') {
            rejectedQueue.push({ name: f.name, dataType: parsed.dataType, parsed: parsed });
            return;
          }
          if (k2 === 'loadMap') { loadMapQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed }); return; }
          if (k2 === 'snapshot') { snapshotQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed }); return; }
          if (k2 === 'opAva') { opAvaQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed }); return; }
          // [HD785 2026-10-14] Matriks gigi & peta duty.
          if (k2 === 'gearLoad') { gearLoadQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed }); return; }
          if (k2 === 'dutyMap') { dutyMapQueue.push({ text: parsed._rawText || '', name: f.name, parsed: parsed }); return; }
          // [FIX 2026-10-13] Tipe SAH yang belum ditafsirkan (histogram/riwayat:
          // '50','52',...,'83','93','2F') TIDAK boleh masuk jalur analitik:
          // `analytics.analyze()` mengembalikan objek tanpa `health`, lalu
          // `analysis.health.label` melempar TypeError dan berkas dilaporkan
          // "gagal" — padahal berkasnya sah, hanya belum didukung.
          // Dikumpulkan terpisah agar dilaporkan jujur (lihat akhir batch).
          var k3 = kindOf(parsed);
          if (k3 === 'unsupported' || k3 === 'unknown') {
            unsupportedQueue.push({
              name: f.name, dataType: parsed.dataType || '', title: parsed.dataTitle || '',
              known: k3 === 'unsupported'
            });
            return;
          }
          var analysis = analytics.analyze(parsed);
          analysis.sourceFile = f.name;
          analysis.dataType = parsed.dataType || '40';
          analysis.usedFallback = parsed.usedFallback === true;
          var r = fleet.add(analysis, f.name);
          okCount++;
          if (r.merged) mergeCount++;
          if (String(parsed.dataType || '').trim() === '81') tmCount++;
          if (String(parsed.dataType || '').trim() === '86') chassisCount++;
          var vr = analysis.validationReport;
          if (vr && (vr.droppedInvalidSmr || vr.droppedDuplicate || vr.warnings.length)) fixedCount++;
          if (analysis.health && analysis.health.label === 'CRITICAL') critCount++;
        }).catch(function (err) {
          failCount++;
          // [FIX 2026-10-13] BERKAS NON-VHMS (mis. `index00.csv` — manifes
          // "Files Information" yang ikut tercentang saat memilih seluruh
          // folder) BUKAN kegagalan. Ia tidak punya blok [Data] sehingga
          // `parser.parse()` melempar. Operator tidak perlu diberi error
          // teknis untuk berkas yang memang bukan data telemetri.
          var isManifest = /Bagian \[Data\] tidak ditemukan/i.test(err.message || '');
          if (isManifest) {
            skippedManifest.push(f.name);
            failCount--;                      // bukan kegagalan
          } else {
            console.error('Gagal memproses ' + f.name, err);
          }
        });
      });

      Promise.all(jobs).then(function () {
        i = end;
        showLoading('Memproses unit... ' + i + ' / ' + files.length);
        if (i < files.length) {
          setTimeout(step, 0);      // lepas kontrol ke UI, lalu lanjut
        } else {
          // Semua trend selesai -> baru lampirkan berkas fault (lihat catatan
          // pada deklarasi faultQueue).
          faultQueue.forEach(function (q) {
            if (processFaultText(q.text, q.name)) { okCount++; faultCount++; }
            else { failCount++; }
          });
          // [T7.3] Lalu matriks clutch (ketergantungan sama dengan fault).
          clutchQueue.forEach(function (q) {
            if (processClutchText(q.text, q.name, q.parsed)) { okCount++; clutchCount++; }
            else { failCount++; }
          });
          // [D375A 2026-10-13] Lalu matriks perpindahan gigi (sama dengan clutch).
          shiftMapQueue.forEach(function (q) {
            if (processShiftMapText(q.text, q.name, q.parsed)) { okCount++; shiftMapCount++; }
            else { failCount++; }
          });
          // [T12] Lalu sumber data PC2000 (ketergantungan sama dengan fault).
          loadMapQueue.forEach(function (q) {
            if (processLoadMapText(q.text, q.name, q.parsed)) { okCount++; loadMapCount++; }
            else { failCount++; }
          });
          snapshotQueue.forEach(function (q) {
            if (processSnapshotText(q.text, q.name, q.parsed)) { okCount++; snapshotCount++; }
            else { failCount++; }
          });
          opAvaQueue.forEach(function (q) {
            if (processOpAvaText(q.text, q.name, q.parsed)) { okCount++; opAvaCount++; }
            else { failCount++; }
          });
          // [HD785 2026-10-14] Matriks beban per gigi & peta duty operasi.
          gearLoadQueue.forEach(function (q) {
            if (processGearLoadText(q.text, q.name, q.parsed)) { okCount++; gearLoadCount++; }
            else { failCount++; }
          });
          dutyMapQueue.forEach(function (q) {
            if (processDutyMapText(q.text, q.name, q.parsed)) { okCount++; dutyMapCount++; }
            else { failCount++; }
          });
          // Berkas yang ditolak: beri tahu operator (bukan gagal senyap).
          rejectedQueue.forEach(function (q) {
            var lm = global.VHMS_LOADMAP;
            var msg = lm ? 'Berkas "' + q.name + '" diabaikan: ' + (function () {
              var r = lm.parse(q.text || '', { dataType: q.dataType, sourceName: q.name });
              return (r.warnings && r.warnings[0]) || 'Temporary Load Map ditolak.';
            })() : 'Temporary Load Map ditolak.';
            toast(msg, 'err', 7000);
            rejectedCount++;
          });
          // [FIX 2026-10-13] Berkas SAH yang belum didukung: SATU ringkasan
          // yang jujur, bukan satu error teknis per berkas. Operator perlu
          // tahu berkas mana yang belum terbaca — dan bahwa sisanya tetap
          // dimuat, sehingga tidak mengira seluruh ekspor gagal.
          if (unsupportedQueue.length) {
            var titles = {};
            unsupportedQueue.forEach(function (q) {
              var key = (q.title || ('tipe ' + q.dataType));
              titles[key] = (titles[key] || 0) + 1;
            });
            var list = Object.keys(titles).map(function (k) {
              return k + (titles[k] > 1 ? ' ×' + titles[k] : '');
            });
            toast(unsupportedQueue.length + ' berkas SAH dilewati (belum ada penafsir): ' +
              list.join(', ') + '. Sisanya tetap dimuat.', 'err', 9000);
            unsupportedCount += unsupportedQueue.length;
          }
          // [FIX 2026-10-13] Berkas non-VHMS (manifes) dilewati senyap tetapi
          // TETAP diberitahukan — supaya operator tahu berkasnya terbaca dan
          // memang sengaja tidak dipakai, bukan hilang tanpa jejak.
          if (skippedManifest.length) {
            toast(skippedManifest.length + ' berkas dilewati (bukan data VHMS): ' +
              skippedManifest.join(', ') + '.', 'ok', 5000);
          }
          hideLoading();
          var msg = okCount + ' file diproses';
          if (mergeCount) msg += ', ' + mergeCount + ' digabung ke unit lama (SN sama)';
          if (faultCount) msg += ', ' + faultCount + ' file fault dilampirkan';
          if (tmCount) msg += ', ' + tmCount + ' file T/M Trend digabung';
          if (chassisCount) msg += ', ' + chassisCount + ' file Chassis Trend digabung';
          if (clutchCount) msg += ', ' + clutchCount + ' matriks clutch dilampirkan';
          if (shiftMapCount) msg += ', ' + shiftMapCount + ' matriks perpindahan gigi dilampirkan';
          if (gearLoadCount) msg += ', ' + gearLoadCount + ' matriks beban gigi dilampirkan';
          if (dutyMapCount) msg += ', ' + dutyMapCount + ' peta duty dilampirkan';
          if (loadMapCount) msg += ', ' + loadMapCount + ' load map dilampirkan';
          if (snapshotCount) msg += ', ' + snapshotCount + ' snapshot dilampirkan';
          if (opAvaCount) msg += ', ' + opAvaCount + ' op. availability dilampirkan';
          if (rejectedCount) msg += ', ' + rejectedCount + ' file diabaikan (duplikat)';
          msg += ' → ' + fleet.count() + ' unit di Home.';
          if (critCount) msg += ' ' + critCount + ' unit CRITICAL.';
          if (fixedCount) msg += ' ' + fixedCount + ' file melewati validasi (duplikat/SMR tidak wajar).';
          if (failCount) msg += ' ' + failCount + ' file gagal.';
          // [FIX 2026-10-08] `failCount` WAJIB mewarnai toast merah. Dulu
          // hanya critCount/fixedCount yang dicek, sehingga upload yang
          // gagal total tetap tampil hijau "berhasil" — menyesatkan.
          toast(msg, (failCount || critCount || fixedCount) ? 'err' : 'ok');
          // [KONSISTENSI NAVIGASI 2026-10-03] SELALU ke halaman daftar unit
          // setelah upload — berapa pun jumlah unitnya. Detail hanya dibuka
          // lewat tombol "Detail" (perilaku sama dengan mode SOS).
          showFleetView();
        }
      });
    }

    showLoading('Memproses ' + files.length + ' file...');
    step();
  }

  function processFile(file) {
    processFiles([file]);
  }

  /* -----------------------------------------------------------------------
   * Ekspor
   * --------------------------------------------------------------------- */
  /**
   * [PENAMAAN LAPORAN 2026-10-03] Format nama file default saat cetak / simpan VHMS:
   * # Result VHMS Trend_[Engine]_[Caution/Critical]_[No Lambung]_Follow Up [SLA]
   */
  function getVHMSReportFileName(analysis) {
    if (!analysis) {
      if (state && state.current) analysis = state.current;
    }
    if (!analysis) return '# Result VHMS Trend';

    // 1. Compartment: default "Engine" untuk VHMS
    var comp = 'Engine';

    // 2. No Lambung
    var serial = analysis.meta ? (analysis.meta.serial || analysis.meta.machineNo) : '';
    var db = global.VHMS_UNITDB;
    var lambung = '';
    if (db && db.getLambung && serial) {
      lambung = db.getLambung(serial);
    }
    if (!lambung && analysis.meta && analysis.meta.lambung) {
      lambung = analysis.meta.lambung;
    }
    if (!lambung) {
      lambung = serial || (state && state.currentUnitId) || 'Unit';
    }
    lambung = String(lambung).replace(/[\/\\:*?"<>|]/g, '-').trim();

    // 3. Status Caution / Critical / Normal berdasarkan threshold terlampaui
    var hasCrit = false;
    var hasWarn = false;

    if (analysis.anomalies && analysis.anomalies.length) {
      hasCrit = analysis.anomalies.some(function (a) { return a.status === 'CRITICAL'; });
      hasWarn = analysis.anomalies.some(function (a) { return a.status === 'WARNING' || a.status === 'CAUTION'; });
    }
    if (!hasCrit && analysis.health && analysis.health.label === 'CRITICAL') {
      hasCrit = true;
    }
    if (!hasCrit && !hasWarn && analysis.health && (analysis.health.label === 'WARNING' || analysis.health.label === 'CAUTION')) {
      hasWarn = true;
    }

    var status = hasCrit ? 'Critical' : (hasWarn ? 'Caution' : 'Normal');

    // 4. SLA merefer ke threshold
    var vcfg = global.VHMS_CONFIG;
    var fup = (vcfg && vcfg.FOLLOWUP_STATUS) || {};
    var sla = '1x24 Jam';
    if (status === 'Critical') {
      sla = (fup.CRITICAL && fup.CRITICAL.sla) || '1x24 Jam';
    } else if (status === 'Caution') {
      // [STANDARISASI 2026-10-03] CAUTION kini benar 2x24 Jam di config.
      sla = (fup.CAUTION && fup.CAUTION.sla) || '2x24 Jam';
    } else {
      sla = (fup.NORMAL && fup.NORMAL.sla) || '-';
    }

    return '# Result VHMS Trend_' + comp + '_' + status + '_' + lambung + '_Follow Up ' + sla;
  }

  /* -----------------------------------------------------------------------
   * [HAPUS 2026-10-13 · hasil audit] Fungsi `exportReport` DIHAPUS.
   * ---------------------------------------------------------------------
   * Fungsi ini satu-satunya pemanggil `document.body.classList.add('printing')`
   * — dan kelas `.printing` TIDAK PUNYA SATU PUN aturan CSS di proyek ini
   * (dicari di seluruh css/: hanya `.printing-portfolio` & `.printing-followup`
   * yang nyata). Sejak tombol `#btn-report` dialihkan ke "Export Data" (CSV),
   * fungsi ini tak lagi terjangkau dari UI mana pun.
   *
   * CETAK dashboard VHMS tetap TERSEDIA lewat Ctrl+P / menu browser:
   *   - blok `@media print` di index.html TIDAK di-scope ke kelas apa pun,
   *     jadi tetap aktif; dan
   *   - listener `beforeprint` global di index.html sudah menyetel
   *     `document.title` lewat `getVHMSReportFileName()` (fungsi itu
   *     DIPERTAHANKAN karena masih dipakai `vhms-render.js` & index.html).
   * Jadi penghapusan ini tidak menghilangkan kemampuan, hanya kode mati.
   * --------------------------------------------------------------------- */

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-05] Ekspor tabel "Equipment List" (katalog VHMS) ke Excel (CSV).
   * ---------------------------------------------------------------------
   * Menghasilkan CSV (pemisah `;`, BOM UTF-8) berisi SELURUH unit — TANPA
   * menghiraukan filter/pencarian yang aktif (sesuai permintaan). Susunan
   * kolom & nilai SAMA dengan tabel katalog di layar, diurutkan menurut
   * Peringkat (rankScore DESC) = paling critical di atas.
   */
  function buildFleetCsv() {
    var CSV = global.CSV_UTIL || {};
    var csvEscape = CSV.csvEscape || function (v) {
      if (v === null || v === undefined) return '';
      var s = String(v);
      return (s.indexOf(';') !== -1 || s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1)
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var R = global.VHMS_FLEET;
    var rows = (R && R.rows) ? R.rows() : [];
    rows = rows.slice().sort(function (a, b) { return (b.rankScore || 0) - (a.rankScore || 0); });

    var vcfg = global.VHMS_CONFIG;
    function statusOf(lbl) { return (vcfg && vcfg.statusLabelOf) ? vcfg.statusLabelOf(lbl) : (lbl || ''); }
    function num(v, d) {
      if (v === null || v === undefined || isNaN(v)) return '';
      return Number(v).toFixed(d);
    }

    var header = [
      'Peringkat', 'Nomor Lambung', 'Model', 'Serial', 'Status Health',
      'Health Index', 'Hours Meter', 'Tanggal',
      'Blowby Press Max (kPa)', 'Engine Oil Press H-Min (MPa)',
      'Engine Oil Temp Max (\u00B0C)', 'Coolant Temp Max (\u00B0C)', 'Hyd Temp Max (\u00B0C)',
      'Anomali', 'Anomali Kritis', 'Perhatian Utama', 'Sisa Operasi (RUL)'
    ];

    var lines = [header.map(csvEscape).join(';')];
    rows.forEach(function (r, i) {
      var kpi = r.kpi || {};
      var top = r.topAnomaly;
      var rulTxt = '';
      if (r.urgentRUL !== null && r.urgentRUL !== undefined && !isNaN(r.urgentRUL)) {
        rulTxt = Math.round(Number(r.urgentRUL)) + ' jam';
      }
      var row = [
        i + 1,
        r.lambung || '', r.model || '', r.serial || '', statusOf(r.healthLabel),
        (r.healthScore === null || r.healthScore === undefined) ? '' : num(r.healthScore, 1),
        num(r.smrLast, 1), r.lastTimestamp || '',
        num(kpi.blowbyMax, 2), num(kpi.oilPressHMin, 2),
        num(kpi.engOilTempMax, 1), num(kpi.coolantMax, 1), num(kpi.hydTempMax, 1),
        r.anomalyCount || 0, r.nCritThresholds || 0,
        top ? (top.title || '') : '', rulTxt
      ];
      lines.push(row.map(csvEscape).join(';'));
    });

    var csv = '\uFEFF' + lines.join('\r\n');
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    return { csv: csv, filename: 'Equipment List_' + stamp + '.csv', rows: rows.length };
  }

  /** Ekspor tabel Equipment List (katalog VHMS) ke berkas CSV/Excel. */
  function exportFleetCsv() {
    var R = global.VHMS_FLEET;
    if (!R || !R.count || R.count() === 0) {
      toast('Belum ada unit VHMS untuk diekspor.', 'err');
      return false;
    }
    var out = buildFleetCsv();
    var blob = new Blob([out.csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, out.filename);
    toast('Export Data: ' + out.rows + ' unit \u2192 ' + out.filename, 'ok');
    return true;
  }

  /* -----------------------------------------------------------------------
   * [FITUR 2026-10-12] EKSPOR LOG TELEMETRI ke CSV.
   * ---------------------------------------------------------------------
   * Menggantikan fungsi "Cetak Laporan" pada tabel Historical Telemetry Data
   * Log. Pembentukan CSV didelegasikan ke `render.buildTelemetryCsv()` (logika
   * murni, tanpa DOM — agar dapat diuji), sedangkan di sini hanya I/O unduh.
   */
  /** Ekspor log telemetri unit aktif ke berkas CSV. */
  function exportTelemetryCsv() {
    if (!state.current) { toast('Belum ada data untuk diekspor.', 'err'); return false; }
    if (!render.buildTelemetryCsv) { toast('Modul ekspor tidak tersedia.', 'err'); return false; }
    var out = render.buildTelemetryCsv(state.current);
    if (!out) { toast('Gagal menyiapkan data ekspor.', 'err'); return false; }
    if (!out.rows) { toast('Tidak ada baris (cek filter/pencarian).', 'err'); return false; }
    var blob = new Blob([out.csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, out.filename);
    toast('Export Data: ' + out.rows + ' baris \u00d7 ' + out.cols + ' kolom \u2192 ' + out.filename, 'ok');
    return true;
  }

  /* -----------------------------------------------------------------------
   * Ekspor hasil peringkat criticalitas
   * --------------------------------------------------------------------- */
  /** Ganti sub-tab dalam halaman Unit Comparison (Peringkat | Per Parameter | Overlay). */
  function switchCompTab(tab) {
    var validTabs = ['rank', 'param', 'overlay'];
    if (validTabs.indexOf(tab) === -1) tab = 'rank';
    render.setCompState({ tab: tab });

    // Toggle tombol tab
    document.querySelectorAll('#comparison-subtabs .subtab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-comp-tab') === tab);
    });
    // Toggle panel
    toggle('comparison-tab-rank', tab === 'rank');
    toggle('comparison-tab-param', tab === 'param');
    toggle('comparison-tab-overlay', tab === 'overlay');

    // Sub-judul per tab
    var sub = document.getElementById('comparison-subtitle');
    if (tab === 'rank') {
      if (sub) sub.textContent = 'Peringkat criticalitas Home — skor 0–100 (Keparahan 45% + Bukti 30% + Tren 25%)';
      if (state.ranked) render.renderComparison(state.ranked);
    } else if (tab === 'param') {
      if (sub) sub.textContent = 'Perbandingan nilai mentah antar unit (aple-to-aple) per parameter';
      if (state.ranked) render.renderComparisonByParam(state.ranked);
    } else {
      if (sub) sub.textContent = 'Overlay tren parameter yang sama pada 2–3 unit sekaligus';
      if (state.ranked) render.initOverlaySelectors(state.ranked);
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  /* -----------------------------------------------------------------------
   * [POIN 5] Reset filter katalog (status + pencarian) ke default.
   * --------------------------------------------------------------------- */
  function resetFleetFilters() {
    render.setFleetState({ filter: 'ALL', section: 'ALL', search: '', page: 1 });
    var s = document.getElementById('fleet-search');
    if (s) s.value = '';
    var sec = document.getElementById('fleet-section');
    if (sec) sec.value = 'ALL';
    render.renderFleetTable();
  }

  /* -----------------------------------------------------------------------
   * [POIN 4] Database Unit (SN -> Nomor Lambung)
   * --------------------------------------------------------------------- */
  function unitdb() { return global.VHMS_UNITDB; }

  /** Perbarui indikator status DB di UI. */
  function updateUnitDbStatus() {
    var el = document.getElementById('unitdb-status');
    var db = unitdb();
    if (!el || !db) return;
    var n = db.count();
    var meta = db.getMeta();
    var nSec = (db.sectionCount ? db.sectionCount() : (meta.withSection || 0));
    var ltMeta = (global.PORTFOLIO_STORE && global.PORTFOLIO_STORE.lifetimeMeta) ? global.PORTFOLIO_STORE.lifetimeMeta() : { count: 0 };
    if (n > 0 || ltMeta.count > 0) {
      el.className = 'chip';
      el.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#34d399"></i> ' +
        fmtIntSafe(n) + ' unit terpetakan' +
        (nSec ? ' <span style="color:#a78bfa">· ' + fmtIntSafe(nSec) + ' ber-section</span>' : '') +
        (ltMeta.count ? ' <span style="color:#38bdf8">· ' + fmtIntSafe(ltMeta.count) + ' baris lifetime</span>' : '') +
        (meta.source ? ' <span class="u-text-mute">(' + render.esc(meta.source) + ')</span>' : '');
    } else {
      el.className = 'chip';
      el.innerHTML = '<i class="fa-solid fa-circle-question"></i> Belum dimuat';
    }
  }

  function fmtIntSafe(n) {
    return Number(n).toLocaleString('id-ID');
  }

  /** Proses file database unit. */
  function processUnitDbFile(file) {
    var db = unitdb();
    if (!db) { toast('Modul Database Unit tidak tersedia.', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var text = e.target.result;
        var res = db.parse(text);
        db.save(file.name);
        var matched = fleet.refreshLambung();

        // Cek apakah file ini juga berisi data Lifetime Komponen (format Lifetime SAP/EHMS)
        var ltSynced = 0;
        if (global.LIFETIME_PARSER && global.PORTFOLIO_STORE) {
          try {
            var parsedLt = global.LIFETIME_PARSER.parse(text);
            if (parsedLt && parsedLt.count > 0) {
              global.PORTFOLIO_STORE.setLifetime(parsedLt, file.name);
              ltSynced = parsedLt.count;
            }
          } catch (eLt) {
            // Bukan file Lifetime (mis. file mapping SN-Lambung sederhana), abaikan
          }
        }

        updateUnitDbStatus();
        // [SATU UPLOAD 2026-10-01] Sinkronkan SECTION ke Portofolio dari data
        // yang sama (kolom Section opsional). Satu file mengisi Database Unit
        // (SN->Lambung) SEKALIGUS Section Portofolio (SN/Lambung->Section).
        var secSynced = syncSectionToPortfolio(file.name);
        // [FIX 2026-10-06] Segarkan dropdown Section + tabel SOS Kompartemen List
        // agar opsi Section langsung muncul tanpa perlu berpindah mode dulu.
        if (global.SOS_RENDER && global.SOS_RENDER.refreshSectionOptions) {
          try { global.SOS_RENDER.refreshSectionOptions(); } catch (eS) {}
        }
        // Segarkan juga dropdown Section tabel Equipment List (mode VHMS).
        if (global.VHMS_RENDER && global.VHMS_RENDER.refreshSectionOptions) {
          try { global.VHMS_RENDER.refreshSectionOptions(); } catch (eV) {}
        }
        // Perbarui tampilan yang sedang aktif
        if (state.view === 'fleet') render.renderFleet(fleet.fleetStats());
        else if (state.view === 'comparison' && state.ranked) render.renderComparison(state.ranked);
        else if (state.view === 'unit' && state.current) render.renderHeader(state.current);
        // Segarkan Portofolio bila sedang terbuka.
        if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) {
          try { global.PORTFOLIO_APP.refresh(); } catch (e2) {}
        }

        var msg = 'Data Unit dimuat: ' + res.added + ' baris' +
          (matched ? ' — ' + matched + ' unit dicocokkan' : ' — belum ada unit yang cocok');
        if (res.withSection) msg += ', ' + res.withSection + ' baris ber-section';
        if (ltSynced) msg += ', ' + ltSynced + ' baris data lifetime tersinkronkan';
        toast(msg + '.', (matched || ltSynced) ? 'ok' : 'info', 7000);
      } catch (err) {
        console.error(err);
        toast('Gagal membaca data unit: ' + err.message, 'err');
      }
    };
    reader.onerror = function () { toast('Gagal membaca file.', 'err'); };
    reader.readAsText(file, 'utf-8');
  }

  /**
   * [SATU UPLOAD 2026-10-01] Sinkronkan Section dari VHMS_UNITDB ke
   * PORTFOLIO_STORE (agar menu Portofolio membaca Section yang sama).
   * @returns {number} jumlah unit yang ter-sinkron (0 bila tak ada/tak tersedia).
   */
  function syncSectionToPortfolio(sourceName) {
    var db = unitdb();
    var store = global.PORTFOLIO_STORE;
    if (!db || !store || !db.entries || !store.setSection) return 0;
    var ents = db.entries();
    var rows = [], byLambung = {}, bySn = {}, sections = {}, n = 0;
    ents.forEach(function (en) {
      if (!en.section) return;
      n++;
      var row = { sn: en.snRaw || '', lambung: en.lambung || '', section: en.section };
      rows.push(row);
      var kLb = (store.normLambung ? store.normLambung(row.lambung) : String(row.lambung).toUpperCase());
      if (kLb) byLambung[kLb] = row;
      if (row.sn) bySn[String(row.sn).replace(/[\s._\-/]+/g, '').toUpperCase()] = row;
      sections[row.section] = (sections[row.section] || 0) + 1;
    });
    if (!rows.length) return 0;
    store.setSection({ rows: rows, byLambung: byLambung, bySn: bySn, sections: sections, count: rows.length, skipped: 0 }, sourceName || 'Database Unit');
    return n;
  }

  /** Unduh template CSV Data Unit & Lifetime EHMS/SAP */
  function downloadDataUnitLifetimeTemplate() {
    var csv = 'Site,EquipmentStatus,ComponentNo,EquipmentNumber,ModelUnit,SerialNumber,ObjectType,Component,CyclePerComponent,Status,LastMONumber,LastTecoDate,LastTotalCountReading,CounterReading,TotalCountReading,MeterRunComponent,MeterToRun,ComponentLife(%)\n' +
      '2005,INPR,2000030120,HD785-01,HD785-7,10025,A000,ENGINE,16000,NORMAL,,,0,45360,52606,12610,3390,78.81\n' +
      '2005,INPR,2000030121,HD785-01,HD785-7,10025,B000,TRANSMISSION,12500,NORMAL,,,0,45360,52606,9500,3000,76.00\n' +
      '2005,INPR,2000030122,HD785-01,HD785-7,10025,D00L,FINAL DRIVE LH,20000,NORMAL,,,0,45360,52606,14200,5800,71.00\n' +
      '2005,INPR,2000030123,HD785-01,HD785-7,10025,F000,HYDRAULIC SYSTEM,12000,NORMAL,,,0,45360,52606,8200,3800,68.33\n';
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'template-data-unit-lifetime.csv');
    toast('Template Data Unit & Lifetime diunduh.', 'ok');
  }

  /** Unduh template CSV Top-Up Oil SAP */
  function downloadTopupTemplate() {
    var csv = 'Site,Order,Equipment,Model,Material,Material Description,Movement Type,Compartment,Valuation Type,Quantity,Posting Date,Time,Base Unit,Amount,Currency,Created By,Purchase Order\n' +
      '2005,4915461090,HD785-01,HD785-7,A070134301,"OIL,TRANSLIK HD 10W,SAE 10W",TOU,ENGINE,,20.00,9/8/2026,16.00,L,29.18,USD,,1800215115\n' +
      '2005,4915461091,HD785-01,HD785-7,A070134302,"OIL,RORED HDA 80W-90",RPR,FINAL DRIVE,,15.00,9/15/2026,14.30,L,22.50,USD,,1800215116\n';
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'template-topup-oil-sap.csv');
    toast('Template Top-Up Oil SAP diunduh.', 'ok');
  }

  /** Unduh template CSV Threshold */
  function downloadThresholdTemplate() {
    if (global.VHMS_SETTINGS && global.VHMS_SETTINGS.exportThresholdsCsv) {
      global.VHMS_SETTINGS.exportThresholdsCsv();
    } else {
      toast('Fitur ekspor threshold belum siap.', 'err');
    }
  }

  function openTemplateModal() {
    var m = document.getElementById('template-download-modal');
    if (m) m.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeTemplateModal() {
    var m = document.getElementById('template-download-modal');
    if (m) m.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  /* -----------------------------------------------------------------------
   * Navigasi tab (menyaring kartu KPI, chart, dll.)
   * --------------------------------------------------------------------- */
  var TAB_MAP = {
    overview:   { kpi: null,                panels: ['overview-panels'] },
    engine:     { kpi: ['engine', 'exhaust', 'powertrain'], charts: ['group-engine', 'group-exhaust', 'group-powertrain'] },
    hydraulic:  { kpi: ['hydraulic'],      charts: ['group-hydraulic'] },
    cooling:    { kpi: ['cooling', 'fanpto', 'brakes'], charts: ['group-cooling', 'group-fanpto'] },
    productivity: { kpi: ['productivity'], charts: ['group-power', 'group-greasing', 'group-dozing'] },
    'data-table': { table: true }
  };

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    var btn = document.getElementById('tab-' + tab);
    if (btn) btn.classList.add('active');

    var isTable = (tab === 'data-table');
    toggle('kpi-section', !isTable);
    toggle('charts-section', !isTable);
    toggle('overview-panels', tab === 'overview');
    toggle('table-section', isTable);

    if (!isTable) {
      // Filter kartu KPI
      var spec = TAB_MAP[tab] || {};
      // [FIX] Filter berdasarkan data-comp-id (id kompartemen sebenarnya),
      // BUKAN indeks posisi. Hal ini penting untuk keluarga non-excavator
      // (TRUCK/DOZER) yang daftar kompartemennya berbeda/tersaring, sehingga
      // pencocokan indeks ke cfg.COMPARTMENTS akan salah kartu.
      document.querySelectorAll('#kpi-grid .kpi-card').forEach(function (card) {
        var compId = card.getAttribute('data-comp-id');
        var show = !spec.kpi || (compId && spec.kpi.indexOf(compId) !== -1);
        card.classList.toggle('hidden', !show);
      });
      // Filter chart — [REVISI 2026-10-03] Toggle SELURUH baris grup
      // (.chart-group-row) agar panel Predictive Diagnostic pasangannya
      // ikut tersembunyi bersama chart-nya.
      document.querySelectorAll('#charts-section .panel[data-chart]').forEach(function (panel) {
        var id = panel.getAttribute('data-chart');
        var show = !spec.charts || spec.charts.indexOf(id) !== -1;
        panel.classList.toggle('hidden', !show);
        // Untuk baris grup biasa (chart + diagnostik pasangannya), sembunyikan
        // SELURUH baris agar panel diagnostik tak menggantung sendirian.
        var row = panel.closest ? panel.closest('.chart-group-row') : null;
        if (row) row.classList.toggle('hidden', !show);
      });
      // [REVISI 2026-10-03] Baris pasangan (Productivity + Dozing): sembunyikan
      // hanya bila TIDAK ada chart di dalamnya yang lolos filter.
      document.querySelectorAll('#charts-section .chart-pair-row').forEach(function (row) {
        var anyVisible = Array.prototype.some.call(
          row.querySelectorAll('.panel[data-chart]'),
          function (p) { return !p.classList.contains('hidden'); }
        );
        row.classList.toggle('hidden', !anyVisible);
      });
      // Resize chart agar menyesuaikan container baru
      setTimeout(function () {
        Object.keys(render.getCharts()).forEach(function (k) {
          var c = render.getCharts()[k];
          if (c) c.resize();
        });
        if (render.syncInsightHeight) render.syncInsightHeight();
      }, 60);
    }
  }

  function toggle(id, show) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !show);
  }

  /** Banner alert hanya relevan di halaman Dashboard Unit. */
  function setBannerVisible(show) {
    var banner = document.getElementById('alert-banner');
    if (!banner) return;
    if (show) banner.classList.remove('hidden');
    else {
      banner.classList.add('hidden');
      if (render.stopBannerTimer) render.stopBannerTimer();
      // Tutup modal rekomendasi bila banner disembunyikan (pindah halaman)
      if (render.closeAnomalyModal) render.closeAnomalyModal();
    }
  }

  /* -----------------------------------------------------------------------
   * Kosongkan SEMUA data (VHMS + SOS + Unit DB + Lifetime + Top-Up) — konfirmasi lalu reset total.
   * --------------------------------------------------------------------- */
  function clearAllData() {
    var nVhms = fleet.count();
    var sos = global.SOS_STORE;
    var nSos = sos ? sos.count() : 0;
    var db = unitdb();
    var nDb = db ? db.count() : 0;

    if (nVhms === 0 && nSos === 0 && nDb === 0) {
      toast('Tidak ada data untuk dikosongkan.', 'info');
      return;
    }

    var msg = 'Hapus SEMUA data keseluruhan?\n\n' +
      '• VHMS: ' + nVhms + ' unit\n' +
      '• SOS: ' + nSos + ' sampel\n' +
      '• Data Unit & Lifetime: ' + nDb + ' unit\n' +
      '• Riwayat Top-Up Oil\n\n' +
      'Tindakan ini akan mengosongkan seluruh data dan tidak dapat dibatalkan.';
    if (!global.confirm || !global.confirm(msg)) return;

    // Hapus VHMS (termasuk data tersimpan di sesi)
    state.current = null;
    state.currentUnitId = null;
    state.ranked = null;
    fleet.clear();

    // Hapus SOS (termasuk data tersimpan di sesi) + segarkan tampilan SOS
    if (sos) {
      sos.clear();
      var sosRender = global.SOS_RENDER;
      if (sosRender) {
        if (sosRender.updateUploadVisibility) sosRender.updateUploadVisibility();
        if (sosRender.showView) sosRender.showView('fleet');
      }
    }

    // Hapus Database Unit
    if (db) db.clear();

    // Hapus Portfolio (Lifetime, TopUp, Section)
    if (global.PORTFOLIO_STORE) {
      try {
        if (global.PORTFOLIO_STORE.clearLifetime) global.PORTFOLIO_STORE.clearLifetime();
        if (global.PORTFOLIO_STORE.clearTopup) global.PORTFOLIO_STORE.clearTopup();
        if (global.PORTFOLIO_STORE.clearSection) global.PORTFOLIO_STORE.clearSection();
      } catch (e) {
        // [FIX AUDIT 2026-10-04 · F-3] Gagal mengosongkan = data lama masih ada
        // padahal pengguna diberi tahu "berhasil dikosongkan". Harus terlihat.
        if (global.console && console.warn) console.warn('[VHMS_APP] gagal mengosongkan data portofolio:', e && e.message);
      }
    }

    updateUnitDbStatus();
    if (global.PORTFOLIO_APP && global.PORTFOLIO_APP.refresh) {
      try { global.PORTFOLIO_APP.refresh(); } catch (e) {}
    }

    toast('Seluruh data (VHMS, SOS, Data Unit, Lifetime & Top-Up) berhasil dikosongkan.', 'info');
    showFleetView();
  }

  /* -----------------------------------------------------------------------
   * Inisialisasi event
   * --------------------------------------------------------------------- */
  function init() {
    // Tombol tab
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    // Tombol pilih file (dukung MULTI-file)
    var fileInput = document.getElementById('file-input');
    var pickBtn = document.getElementById('btn-pick');
    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processFiles(e.target.files);
        e.target.value = '';
      });
    }

    // Tombol kembali ke katalog Home
    var backBtn = document.getElementById('btn-back-fleet');
    if (backBtn) backBtn.addEventListener('click', showFleetView);

    // Tombol tambah unit dari katalog Home
    var pickFleetBtn = document.getElementById('btn-pick-fleet');
    if (pickFleetBtn && fileInput) {
      pickFleetBtn.addEventListener('click', function () { fileInput.click(); });
    }

    // Tombol buka katalog dari header.
    // Mode-aware: bila mode SOS sedang aktif, klik "Home" cukup
    // mengembalikan ke halaman utama SOS (tidak membuka VHMS di atasnya).
    var fleetBtn = document.getElementById('btn-fleet');
    if (fleetBtn) {
      fleetBtn.addEventListener('click', function () {
        if (global.VHMS_SOS_MODE && global.VHMS_SOS_MODE.goHome) {
          global.VHMS_SOS_MODE.goHome();
          return;
        }
        showFleetView();
      });
    }

    // Tombol bersihkan armada — hapus SEMUA data (VHMS + SOS)
    var clearBtn = document.getElementById('btn-clear-fleet');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () { clearAllData(); });
    }

    /* ---------------- [POIN 4] Database Unit ---------------- */
    var unitDbInput = document.getElementById('unitdb-input');
    var unitDbPick = document.getElementById('btn-unitdb-pick');
    if (unitDbPick && unitDbInput) {
      unitDbPick.addEventListener('click', function () { unitDbInput.click(); });
    }
    if (unitDbInput) {
      unitDbInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length) processUnitDbFile(e.target.files[0]);
        e.target.value = '';
      });
    }
    var unitDbTpl = document.getElementById('btn-unitdb-template');
    if (unitDbTpl) unitDbTpl.addEventListener('click', openTemplateModal);
    var tplModalClose = document.getElementById('template-modal-close');
    if (tplModalClose) tplModalClose.addEventListener('click', closeTemplateModal);
    var tplModal = document.getElementById('template-download-modal');
    if (tplModal) tplModal.addEventListener('click', function (e) { if (e.target === tplModal) closeTemplateModal(); });

    var dlUnitDb = document.getElementById('btn-dl-tpl-unitdb');
    if (dlUnitDb) dlUnitDb.addEventListener('click', function () { downloadDataUnitLifetimeTemplate(); closeTemplateModal(); });
    var dlTopup = document.getElementById('btn-dl-tpl-topup');
    if (dlTopup) dlTopup.addEventListener('click', function () { downloadTopupTemplate(); closeTemplateModal(); });
    var dlThreshold = document.getElementById('btn-dl-tpl-threshold');
    if (dlThreshold) dlThreshold.addEventListener('click', function () { downloadThresholdTemplate(); closeTemplateModal(); });

    // [UX 2026-10-03] Tombol "Hapus" per-panel dihapus; pembersihan terpusat
    // di tombol "Kosongkan" (clearAllData) agar tidak ada aksi parsial.
    updateUnitDbStatus();

    // Filter / pencarian / sortir tabel armada
    var fleetSearch = document.getElementById('fleet-search');
    if (fleetSearch) {
      var runFleetSearch = debounce(function () {
        render.setFleetState({ search: fleetSearch.value, page: 1 });
        render.renderFleetTable();
      }, 200);
      fleetSearch.addEventListener('input', runFleetSearch);
    }
    var fleetFilter = document.getElementById('fleet-filter');
    if (fleetFilter) {
      fleetFilter.addEventListener('change', function () {
        render.setFleetState({ filter: fleetFilter.value, page: 1 });
        render.renderFleetTable();
      });
    }

    // [FITUR 2026-10-06] Filter SECTION (dropdown di baris filter VHMS).
    var fleetSection = document.getElementById('fleet-section');
    if (fleetSection) {
      fleetSection.addEventListener('change', function () {
        render.setFleetState({ section: fleetSection.value, page: 1 });
        render.renderFleetTable();
      });
    }

    // [POST-5 2026-10-03] Kontrol paginasi tabel Fleet VHMS.
    document.addEventListener('click', function (e) {
      var pg = e.target.closest('[data-fleet-page]');
      if (!pg || pg.disabled) return;
      var p = parseInt(pg.getAttribute('data-fleet-page'), 10);
      if (!p || p < 1) return;
      render.setFleetState({ page: p });
      render.renderFleetTable();
    });

    // [FITUR 2026-10-09] Kontrol paginasi tabel RIWAYAT EVENT / ALARM.
    document.addEventListener('click', function (e) {
      var fp = e.target.closest('[data-fault-page]');
      if (!fp || fp.disabled) return;
      if (typeof render.setFaultPage === 'function') {
        render.setFaultPage(fp.getAttribute('data-fault-page'));
      }
    });

    // [FITUR 2026-10-11] Sort tabel RIWAYAT EVENT / ALARM lewat klik header.
    // Abaikan klik pada input filter di dalam header (agar mengetik tidak
    // memicu pengurutan).
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fault-col-filter')) return;
      var th = e.target.closest('[data-fault-sort]');
      if (!th) return;
      if (typeof render.setFaultSort === 'function') {
        render.setFaultSort(th.getAttribute('data-fault-sort'));
      }
    });
    // Aksesibilitas: header dapat diaktifkan via keyboard Enter/Space.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var th = e.target.closest ? e.target.closest('th[data-fault-sort]') : null;
      if (!th) return;
      e.preventDefault();
      if (typeof render.setFaultSort === 'function') {
        render.setFaultSort(th.getAttribute('data-fault-sort'));
      }
    });

    // [FITUR 2026-10-11] Filter kolom Keterangan tabel RIWAYAT EVENT / ALARM.
    // Delegasi pada dokumen; pertahankan fokus & posisi kursor antar render.
    document.addEventListener('input', function (e) {
      var inp = e.target.closest ? e.target.closest('.fault-filter-input') : null;
      if (!inp) return;
      var val = inp.value;
      var selStart = inp.selectionStart, selEnd = inp.selectionEnd;
      if (typeof render.setFaultFilter === 'function') render.setFaultFilter(val);
      var again = document.querySelector('#fault-panel .fault-filter-input');
      if (again) {
        again.focus();
        try { again.setSelectionRange(selStart, selEnd); } catch (_) { /* noop */ }
      }
    });

    // [FITUR 2026-10-11] Filter RENTANG TANGGAL panel Oper. Availability.
    // Input tanggal: perbarui state lalu render ulang HANYA panel opava.
    document.addEventListener('input', function (e) {
      var inp = e.target.closest ? e.target.closest('.opava-date-input') : null;
      if (!inp) return;
      var key = inp.getAttribute('data-opava-range');   // 'from' | 'to'
      if (!key) return;
      var ex = global.VHMS_EXTRAS_RENDER;
      if (!ex || typeof ex.setOpAvaRange !== 'function') return;
      var patch = {}; patch[key] = inp.value;
      ex.setOpAvaRange(patch);
      // Kembalikan fokus ke input yang sama agar tidak meloncat saat mengetik.
      var again = document.querySelector('#opava-panel .opava-date-input[data-opava-range="' + key + '"]');
      if (again) again.focus();
    });
    // Preset cepat (30h / 90h / Semua / Reset).
    document.addEventListener('click', function (e) {
      // Tombol kalender: buka picker native (showPicker bila didukung).
      var calBtn = e.target.closest ? e.target.closest('.opava-date-btn') : null;
      if (calBtn) {
        e.preventDefault();
        var which = calBtn.getAttribute('data-opava-open');   // 'from' | 'to'
        var input = document.querySelector('#opava-panel .opava-date-input[data-opava-range="' + which + '"]');
        if (input) {
          try {
            if (typeof input.showPicker === 'function') input.showPicker();
            else { input.focus(); input.click(); }
          } catch (_) { input.focus(); }
        }
        return;
      }
      var btn = e.target.closest ? e.target.closest('.opava-quick') : null;
      if (!btn) return;
      var ex = global.VHMS_EXTRAS_RENDER;
      if (ex && typeof ex.applyOpAvaQuick === 'function') {
        ex.applyOpAvaQuick(btn.getAttribute('data-opava-quick'));
      }
    });
    // Klik pada kolom tanggal juga membuka picker (memudahkan pengguna).
    document.addEventListener('click', function (e) {
      var inp = e.target.closest ? e.target.closest('.opava-date-input') : null;
      if (!inp || typeof inp.showPicker !== 'function') return;
      // Hanya pemicu eksplisit; jangan ganggu keyboard/pengetikan.
      if (e.detail === 1) {
        try { inp.showPicker(); } catch (_) { /* browser bisa menolak */ }
      }
    });

    /* ---------------- [POIN 5] Filter cepat & penanda filter aktif ---------------- */
    var filterBar = document.getElementById('fleet-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function (e) {
        // Klik chip filter cepat
        var chip = e.target.closest('[data-quick-filter]');
        if (chip) {
          var val = chip.getAttribute('data-quick-filter');
          var newVal = (val === 'ALL') ? 'ALL' : val;
          render.setFleetState({ filter: newVal, page: 1 });
          render.renderFleetTable();
          return;
        }
        // Klik tanda "x" pada tag filter aktif
        if (e.target.id === 'fleet-tag-clear') {
          resetFleetFilters();
        }
      });
    }
    var resetFilterBtn = document.getElementById('btn-reset-filter');
    if (resetFilterBtn) resetFilterBtn.addEventListener('click', resetFleetFilters);
    document.querySelectorAll('#fleet-table-head th[data-fleet-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-fleet-sort');
        var st = render.getFleetState();
        // Kolom "severity" selalu diurutkan worst→best (arah tetap).
        if (k === 'severity') {
          render.setFleetState({ sortKey: 'severity', sortDir: 'desc', page: 1 });
          render.renderFleetTable();
          return;
        }
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setFleetState({ sortKey: k, sortDir: dir, page: 1 });
        render.renderFleetTable();
      });
    });

    // Delegasi klik tombol Detail di tabel armada
    var fleetTbody = document.getElementById('fleet-table-body');
    if (fleetTbody) {
      fleetTbody.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-unit-id]');
        if (btn) openUnit(btn.getAttribute('data-unit-id'));
      });
    }

    /* ---------------- Unit Comparison ---------------- */
    var compBtn = document.getElementById('btn-comparison');
    if (compBtn) compBtn.addEventListener('click', showComparisonView);

    /* ---------------- Cross Analysis (VHMS x SOS) ---------------- */
    var crossBtn = document.getElementById('btn-cross');
    if (crossBtn) crossBtn.addEventListener('click', showCrossView);

    /* ---------------- Fleet Heatmap ---------------- */
    // [REVISI #7] Heatmap VHMS kini berperilaku sebagai SUB-VIEW seperti mode
    // SOS: membukanya menyembunyikan daftar/katalog (toolbar, kartu, tabel) dan
    // hanya menampilkan panel heatmap. Tombol "Kembali" mengembalikan katalog.
    var hmBtn = document.getElementById('btn-heatmap');
    var hmPanel = document.getElementById('fleet-heatmap-panel');
    var hmClose = document.getElementById('btn-heatmap-close');
    function openHeatmap() {
      // Butuh data unit; bila kosong, beri tahu (tidak membuka view kosong).
      if (fleet.count() === 0) { toast('Belum ada unit untuk heatmap.', 'err'); return; }
      toggle('fleet-list-wrap', false);
      toggle('fleet-heatmap-panel', true);
      setHeaderCompact(true);
      if (render.resetHeader) render.resetHeader();
      render.renderHeatmap();
    }
    function closeHeatmap() {
      toggle('fleet-heatmap-panel', false);
      toggle('fleet-list-wrap', true);
      render.renderHeatmap && render.resetCharts && render.resetCharts();
    }
    if (hmBtn && hmPanel) {
      hmBtn.addEventListener('click', openHeatmap);
    }
    if (hmClose && hmPanel) {
      hmClose.addEventListener('click', closeHeatmap);
    }

    var backFleet2 = document.getElementById('btn-back-fleet-2');
    if (backFleet2) backFleet2.addEventListener('click', showFleetView);

    var compSearch = document.getElementById('comparison-search');
    if (compSearch) {
      var runCompSearch = debounce(function () {
        render.setCompState({ search: compSearch.value });
        if (state.ranked) render.renderComparison(state.ranked);
      }, 200);
      compSearch.addEventListener('input', runCompSearch);
    }
    var compModel = document.getElementById('comparison-model');
    if (compModel) {
      compModel.addEventListener('change', function () {
        render.setCompState({ model: compModel.value });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    }
    var compBand = document.getElementById('comparison-band');
    if (compBand) {
      compBand.addEventListener('change', function () {
        render.setCompState({ band: compBand.value });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    }
    document.querySelectorAll('#comparison-head th[data-comp-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-comp-sort');
        var st = render.getCompState();
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setCompState({ sortKey: k, sortDir: dir });
        if (state.ranked) render.renderComparison(state.ranked);
      });
    });
    // Klik baris/tombol di tabel comparison -> buka detail unit
    var compBody = document.getElementById('comparison-body');
    if (compBody) {
      compBody.addEventListener('click', function (e) {
        var el = e.target.closest('[data-unit-id]');
        if (el) openUnit(el.getAttribute('data-unit-id'));
      });
    }
    // Klik kartu Top 10 -> buka detail unit
    var compTop = document.getElementById('comparison-top10');
    if (compTop) {
      compTop.addEventListener('click', function (e) {
        var el = e.target.closest('[data-unit-id]');
        if (el) openUnit(el.getAttribute('data-unit-id'));
      });
    }
    /* ---------------- Sub-tab: Perbandingan per Parameter ---------------- */
    document.querySelectorAll('#comparison-subtabs .subtab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchCompTab(b.getAttribute('data-comp-tab')); });
    });

    var paramPillar = document.getElementById('param-comp-pillar');
    if (paramPillar) {
      paramPillar.addEventListener('change', function () {
        render.setCompParamState({ paramPillar: paramPillar.value });
        if (state.ranked) render.renderComparisonByParam(state.ranked);
      });
    }
    var paramBasis = document.getElementById('param-comp-basis');
    if (paramBasis) {
      paramBasis.addEventListener('change', function () {
        render.setCompParamState({ paramBasis: paramBasis.value });
        if (state.ranked) render.renderComparisonByParam(state.ranked);
      });
    }

    /* ---------------- Overlay Chart ---------------- */
    var overlayDraw = document.getElementById('btn-overlay-draw');
    if (overlayDraw) overlayDraw.addEventListener('click', function () { render.drawOverlayChart(); });

    /* ---------------- Banner Alert -> Modal Rekomendasi ---------------- */
    var alertBanner = document.getElementById('alert-banner');
    if (alertBanner) {
      var openModalFromBanner = function () {
        if (alertBanner.classList.contains('clickable')) render.openAnomalyModal();
      };
      alertBanner.addEventListener('click', openModalFromBanner);
      alertBanner.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModalFromBanner(); }
      });
    }
    var modalClose = document.getElementById('anomaly-modal-close');
    if (modalClose) modalClose.addEventListener('click', function () { render.closeAnomalyModal(); });
    var modalEl = document.getElementById('anomaly-modal');
    if (modalEl) {
      // Klik area gelap (di luar panel) -> tutup
      modalEl.addEventListener('click', function (e) {
        if (e.target === modalEl) render.closeAnomalyModal();
      });
    }
    // Tombol Esc menutup modal
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && render.isAnomalyModalOpen && render.isAnomalyModalOpen()) {
        render.closeAnomalyModal();
      }
    });

    // Tombol cetak laporan.
    // [FITUR 2026-10-05] Header kini hanya punya tombol statis "Export Data"
    // (#btn-report-1, ditangani di index.html). Cetak laporan tetap tersedia
    // lewat dialog cetak browser (Ctrl+P); judul dokumen diatur otomatis oleh
    // listener `beforeprint` di index.html.
    // [FITUR 2026-10-12] #btn-report PADA TABEL LOG TELEMETRI kini "Export Data"
    // -> meng-ekspor log telemetri unit aktif ke CSV (bukan lagi mencetak).
    var bLegacy = document.getElementById('btn-report');
    if (bLegacy) bLegacy.addEventListener('click', exportTelemetryCsv);

    // Drag & drop di seluruh dokumen
    setupDragDrop();

    // Kontrol tabel
    var search = document.getElementById('table-search');
    if (search) {
      var runTableSearch = debounce(function () {
        if (!state.current) return;
        render.setTableState({ search: search.value });
        render.renderTable(state.current);
      }, 200);
      search.addEventListener('input', runTableSearch);
    }
    var filter = document.getElementById('table-filter');
    if (filter) {
      filter.addEventListener('change', function () {
        if (!state.current) return;
        render.setTableState({ filter: filter.value });
        render.renderTable(state.current);
      });
    }
    // [B-1 2026-10-13] Pemilih JENIS BERKAS. Berganti sumber mengubah
    // STRUKTUR KOLOM, jadi cache kolom harus direset dan header di-render
    // ulang — bukan hanya isi tabel.
    var srcSel = document.getElementById('table-source');
    if (srcSel) {
      srcSel.addEventListener('change', function () {
        if (!state.current) return;
        render.setTableState({ source: srcSel.value });
        render.resetTableColumns();
        render.renderTable(state.current);
        render.renderTableHeader(state.current);
      });
    }
    // Klik header untuk sort
    // [FITUR 2026-10-12] EVENT DELEGATION pada `#table-head`.
    // ---------------------------------------------------------------------
    // Sebelumnya binding dilakukan dengan `querySelectorAll('#table-head
    // th[data-sort]')` SEKALI saat init — tetapi header tabel di-GENERATE
    // ULANG setiap render (renderTableHeader). Akibatnya handler hilang
    // setelah render pertama & fitur sortir tak pernah berfungsi. Delegation
    // di kontainer membuat klik tetap tertangkap walau <th> dibuat ulang.
    var tableHead = document.getElementById('table-head');
    if (tableHead) {
      var doSort = function (th) {
        if (!th || !state.current) return;
        var k = th.getAttribute('data-sort');
        var st = render.getTableState();
        // Klik ulang kolom yang sama membalik arah; kolom baru default asc.
        var dir = (st.sortKey === k && st.sortDir === 'asc') ? 'desc' : 'asc';
        render.setTableState({ sortKey: k, sortDir: dir });
        render.renderTable(state.current);
        render.renderTableHeader();
      };
      tableHead.addEventListener('click', function (e) {
        var th = e.target && e.target.closest ? e.target.closest('th[data-sort]') : null;
        doSort(th);
      });
      // Aksesibilitas keyboard: Enter / Space pada header ter-fokus.
      tableHead.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        var th = e.target && e.target.closest ? e.target.closest('th[data-sort]') : null;
        if (!th) return;
        e.preventDefault();
        doSort(th);
      });
    }

    // Dropzone besar di halaman sambutan
    var dz = document.getElementById('dropzone');
    if (dz) {
      dz.addEventListener('click', function () { if (fileInput) fileInput.click(); });
    }

    // [PERSISTENSI] Pulihkan armada VHMS dari sesi browser (bila ada).
    // Bertahan saat reload; dihapus total lewat tombol "Kosongkan".
    if (fleet.count() === 0 && fleet.restore && fleet.restore()) {
      // [FRESH THRESHOLD] Setelah restore, hitung ULANG analitik agar
      // `thresholdSet` snapshot memakai threshold/config TERKINI (mis. Boost
      // yang baru dikonversi ke mmHg). Tanpa ini, unit yang datanya tersimpan
      // sebelum perubahan satuan bisa menampilkan ambang lama (kPa).
      try { if (fleet.reanalyzeAll) fleet.reanalyzeAll(); } catch (e) {
        // [FIX AUDIT 2026-10-04 · F-3] Gagal re-analisa = ambang lama dipakai
        // diam-diam (angka salah di layar). Wajib terlihat.
        if (global.console && console.warn) console.warn('[VHMS_APP] gagal re-analisa setelah restore:', e && e.message);
      }
      toast('Data VHMS sebelumnya dipulihkan dari sesi browser (' + fleet.count() + ' unit).', 'info');
      // [B2 2026-10-10] Beri tahu bila ada unit yang DIBUANG karena datanya
      // tercemar bug fallback lama — operator perlu mengunggah ulang berkasnya.
      try {
        var purged = (fleet.getLastPurged ? fleet.getLastPurged() : []) || [];
        if (purged.length) {
          var names = purged.map(function (p) { return p.sourceFile || p.id; }).join(', ');
          toast('⚠ ' + purged.length + ' unit dibuang saat pemulihan karena datanya ' +
            'tercemar bug lama (nilai parameter tidak sah): ' + names +
            '. Silakan unggah ulang berkas trend unit tersebut.', 'err', 9000);
        }
      } catch (e2) { /* izinkan gagal senyap — bukan jalur kritis */ }
      showFleetView();
    }
  }

  function setupDragDrop() {
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        var dz = document.getElementById('dropzone');
        if (dz && !document.getElementById('welcome-area').classList.contains('hidden')) {
          dz.classList.add('dragover');
        }
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        var dz = document.getElementById('dropzone');
        if (dz) dz.classList.remove('dragover');
        document.body.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        processFiles(dt.files);
      }
    });
  }

  /* ----------------------------------------------------------------------- */
  /**
   * [SETTINGS] Segarkan tampilan saat ini tanpa mengubah navigasi.
   * Dipakai setelah threshold berubah agar KPI/anomali/ranking ter-update.
   */
  function refreshCurrent() {
    if (state.view === 'unit' && state.currentUnitId) {
      var analysis = fleet.getAnalysis(state.currentUnitId);
      if (analysis) { state.current = analysis; render.renderAll(analysis); }
    } else if (state.view === 'comparison') {
      showComparisonView();
    } else if (state.view === 'fleet') {
      if (fleet.count() > 0) render.renderFleet(fleet.fleetStats());
    } else if (state.view === 'cross') {
      if (global.VHMS_CROSS_RENDER && global.VHMS_CROSS_RENDER.showCross) {
        try { global.VHMS_CROSS_RENDER.showCross(); } catch (e) {}
      }
    }
  }

  global.VHMS_APP = {
    init: init,
    processFile: processFile,
    processFiles: processFiles,
    processText: processText,
    openUnit: openUnit,
    showFleetView: showFleetView,
    showUnitView: showUnitView,
    showComparisonView: showComparisonView,
    showCrossView: showCrossView,
    clearAllData: clearAllData,
    getVHMSReportFileName: getVHMSReportFileName,
    switchTab: switchTab,
    switchCompTab: switchCompTab,
    refreshCurrent: refreshCurrent,
    toast: toast,
    /** [FITUR 2026-10-05] Ekspor Equipment List (katalog VHMS) ke Excel (CSV). */
    exportFleetCsv: exportFleetCsv,
    buildFleetCsv: buildFleetCsv,
    /** [FITUR 2026-10-12] Ekspor LOG TELEMETRI unit aktif ke CSV. */
    exportTelemetryCsv: exportTelemetryCsv,
    getState: function () { return state; },
    /** [T4.5] ID unit yang sedang dibuka di tampilan detail (atau null). */
    getCurrentUnitId: function () {
      return (state && state.view === 'unit') ? (state.currentUnitId || null) : null;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

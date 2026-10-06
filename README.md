# Asset Reliability Performance Center (ARPC)

**Predictive Maintenance Dashboard** menggabungkan:
- **VHMS Telemetry** (Komatsu/CAT/Hitachi/Volvo) — 15 parameter monitoring real-time (tekanan, suhu, emisi, brake, retarder)
- **SOS Oil Analysis** (oil wear, cleanliness, viscosity, condition) — 18 kompartemen universal
- **Cross-Correlation** — analisa VHMS × SOS dual-limit untuk diagnosis akurat
- **Portfolio Reporting** — multi-unit lifecycle & top-up planning dengan rujukan sadar-kompartemen & sadar-merek

Aplikasi **semi-otomatis**: muat file CSV → seluruh dashboard (KPI, chart, diagnostik, tabel, portofolio) terisi sendiri.
Mendukung **multi-unit (Fleet View)**: muat puluhan hingga ribuan file sekaligus, lihat katalog armada, analisis silang.

---

## 1. Cara Pakai Cepat

### Cara A — Buka langsung (paling praktis)
1. Klik dua kali `index.html` → terbuka di browser.
2. Klik **Pilih File CSV (bisa banyak)** — pilih satu, beberapa, atau semua
   file CSV sekaligus (tahan `Ctrl`/`Shift`).
   *(Di `file://` semua fitur tetap bekerja karena data dibaca dari input file
   lokal, bukan `fetch`.)*

### Cara B — Server lokal (direkomendasikan)
```bash
# Jalankan server statis lokal
npm start
# atau langsung:
node serve.js
```
Buka **http://127.0.0.1:5500** — muat file CSV dari `sample-data/`.

**Deployment**: Aplikasi ini **100% statis** (HTML + JS + CSS, tanpa backend).
`npm start` hanya untuk development lokal.

JANGAN unggah seluruh repo. Repo berisi folder yang tidak dipakai production
(`docs/`, `tools/`, `test/`, `sample-data/`). Bangun artefak runtime dulu:

```bash
npm run build        # = node tools/build-deploy.js  ->  ./dist
```

Lalu unggah **isi** folder `dist/` ke web server (`nginx`, `Apache`, `IIS`,
cloud storage, CDN). Isi `dist/` hanya: `index.html`, `js/`, `css/`,
`vendor/`, `assets/` (47 berkas, ~2,5 MB).

`dist/` di-gitignore. Build akan **gagal (exit 1)** bila ada aset yang dirujuk
`index.html` tapi tidak tersalin — jadi folder aset baru tidak bisa terlupakan.

> **Kenapa `test/` & `docs/` tetap di repo?** `test/test-suite.js` adalah satu-
> satunya regression gate (`npm test`); pernah hilang dan jadi blocker P0.
> Keduanya memang tidak di-deploy — itu beda soal dengan dihapus.

---

## 2. Fitur Utama

### Mode VHMS — Telemetri Unit Berat
- **Fleet Overview**: KPI real-time (blowby, tekanan oli, suhu), status health 3-tier (Normal/Caution/Critical)
- **Unit Detail**: 6 KPI + 4 chart, tren time-series, anomali terdeteksi, tabel log telemetri
- **Unit Comparison**: Ranking criticality (3 pilar: ENGINE/HYDRAULIC/POWERTRAIN), matrix per-parameter Top 10
- **Heatmap VHMS**: 15 parameter × N unit, header vertikal 90°, sortir interaktif
- **RUL Estimation**: Proyeksi sisa hidup berdasarkan tren slope (tergantung data historis)

### Mode SOS — Analisa Oli & Kondisi
- **Fleet KPI**: Peringkat criticality (MPRS tier: Normal/Monitor/Caution/Critical)
- **Heatmap SOS**: 19 parameter (wear, cleanliness, viscosity, additives) × N unit, 18 kompartemen
- **Unit Details**: Parameter breached per kompartemen, threshold dinamis per model
- **SOS Lab**: Upload masal, dedup, export ranking (CSV)
- **Perbandingan SOS**: 2 unit side-by-side, severity scoring, distribusi tier

### Cross-Correlation — VHMS × SOS
- **Normalisasi dual-limit**: V100 (visc drop + thickening), tekanan mode LOW (drop = worse)
- **Pearson r dengan inversion**: oilPressHMin × visc_v100 selaras (co-worsening)
- **Curated pairs**: 10+ pasangan relevan, scatter plot interaktif, narasi fisik

### Portfolio — Lifecycle & Perbaikan
- **Mode fleet / per unit / per section**: laporan maintenance critical/caution
- **Data integrasi**:
  - Component Lifetime (jam pakai komponen vs cutoff)
  - Top-Up (riwayat top-up oli per kompartemen, besaran objektif)
  - KB Rule-Based (depth inspeksi: ringan/terarah/mendalam, referensi manual per merek & kompartemen)
- **Ekspor**: PDF formal (A4, smart page break), narasi bertingkat, tanda tangan, estimasi tren proyeksi
- **Filter dinamis**: Section (lokasi operasi), Model unit, Kompartemen (partial print)

## 3. Tiga Level Tampilan

```
┌─────────────────────────────────────────────────────────┐
│  FLEET OVERVIEW (katalog armada)                        │
│  • Kartu statistik: total unit, critical/caution/normal │
│  • Distribusi model                                     │
│  • Tabel semua unit: health, SMR, KPI kunci, anomali    │
│  • Cari, filter status, urutkan kolom                  │
└───────┬─────────────────────────────────┬───────────────┘
        │ klik "Detail"                   │ klik "Perbandingan Unit"
        ▼                                 ▼
┌──────────────────────────┐  ┌──────────────────────────────────────┐
│  DETAIL UNIT             │  │  UNIT COMPARISON                     │
│  • 6 KPI, 4 chart        │  │  • 2 SUB-TAB:                        │
│  • Panel AI, tabel log   │  │    1) Peringkat (skor 0-100, Top 10, │
│  • Tombol Kembali        │  │       donut pilar, tabel lengkap)    │
└──────────────────────────┘  │    2) Per Parameter (matrix apel-    │
                              │       to-apel Top 10 per parameter)  │
                              │  • Filter model/band/pilar, ekspor   │
                              └──────────────────────────────────────┘

### 3.1 Sub-Tab: Perbandingan per Parameter
Di dalam **Unit Comparison** ada dua sub-tab:
- **Peringkat Criticalitas** — skor 0-100 per unit (3 sumbu), Top 10, distribusi pilar.
- **Perbandingan per Parameter** — matrix aple-to-apel: baris = parameter
  (yang punya threshold), kolom = **Top 10 unit** peringkat. Nilai diambil
  **mentah** (max/min) pada window `RANKING_WINDOW_HOURS`. Sel diberi warna
  sesuai status (CRITICAL/CAUTION/NORMAL), plus kolom **Terbaik/Terburuk** per
  parameter. Filter pilar + pilihan basis (ekstrem/rata-rata/terakhir), dan
  ekspor matrix ke CSV.
  - **Header kolom unit menampilkan Nomor Lambung** (dari Database Unit) agar
    mudah dikenali; SN & model ditampilkan di baris kecil di bawahnya. Bila
    Lambung belum tersedia, jatuh kembali ke SN.
  - Kolom **Terbaik/Terburuk** juga memakai Nomor Lambung.
```

### Unit Comparison — Ranking Criticalitas

Skor tiap unit dibangun dari **3 sumbu berbobot**:

| Sumbu | Bobot | Mengukur |
|---|---|---|
| **Keparahan** | 45% | Seberapa jauh nilai melewati batas kritis |
| **Bukti** | 30% | Seberapa lama melanggar (durasi jam SMR) |
| **Tren** | 25% | Seberapa cepat memburuk (slope vs SMR) |

Dikalikan **faktor breadth** (unit dengan masalah di banyak parameter sekaligus
lebih berat). Label: `>= 45` CRITICAL · `25–44` CAUTION · `< 25` NORMAL.

Bobot per parameter mengikuti **hierarki reliability** (Safety > Downtime > Biaya):
Blowby 18, Oil Press H-Min 16, Hyd Temp 14, dst. Rincian lengkap + rasionalnya
ada di **[`docs/KRITERIA_RANKING_CRITICAL.md`](docs/KRITERIA_RANKING_CRITICAL.md)**.

> Semua bobot & ambang **dapat disesuaikan** di `js/vhms-config.js`
> (bagian `RANKING_WEIGHTS`, `RANKING_AXES`, `RANKING_BANDS`).

---

## 4. Struktur Proyek

```
Reliability Based Maintenance/
├─ index.html                 # Halaman utama (markup + orkestrasi script)   [RUNTIME]
├─ serve.js                   # Server statis lokal kecil (untuk uji lokal)
├─ package.json               # Script npm (start / build / test)
├─ test/
│  └─ test-suite.js           # ★ Test suite nyata (npm test) — regression gate
├─ css/
│  └─ vhms-dashboard.css      # Styling mandiri (tanpa Tailwind CDN)
├─ js/
│  ├─ vhms-config.js          # ★ Pusat konfigurasi: parameter, threshold, chart, bobot ranking
│  ├─ vhms-profiles.js        # Skema per keluarga produk (EXCAVATOR/TRUCK/DOZER)
│  ├─ vhms-knowledge.js       # Basis pengetahuan offline untuk rekomendasi diagnostik
│  ├─ vhms-parser.js          # Parser file CSV VHMS -> objek terstruktur
│  ├─ vhms-validate.js        # Validasi data (SMR wajar, dedup SMR)
│  ├─ vhms-unit-db.js         # Database Unit: pemetaan SN -> Nomor Lambung (localStorage)
│  ├─ vhms-analytics.js       # Hitung KPI, status, tren, anomali
│  ├─ vhms-fleet-store.js     # Registry armada + agregasi ringan (multi-unit)
│  ├─ vhms-ranking.js         # Skor criticalitas unit (3 sumbu: severity/evidence/trend)
│  ├─ vhms-render.js          # Gambar KPI, chart, panel, tabel, katalog & peringkat
│  └─ vhms-app.js             # Controller: multi-upload, navigasi level, ekspor
├─ js/ (modul SOS & Cross)
│  ├─ sos-config.js / sos-parser.js / sos-analytics.js / sos-store.js / sos-render.js / sos-app.js
│  ├─ vhms-cross.js           # ★ Analitik silang VHMS×SOS (linkage, peta kurasi, Pearson)
│  ├─ vhms-cross-render.js    # Render halaman Cross Analysis (heatmap/timeline/scatter/radar)
│  └─ vhms-settings.js        # ★ Pengaturan: tema tampilan & editor threshold (VHMS & SOS)
├─ vendor/                    # Library offline (Chart.js + Font Awesome)   [RUNTIME]
├─ assets/                    # favicon.svg                                [RUNTIME]
├─ tools/
│  ├─ build-deploy.js         # ★ npm run build -> dist/ (hanya aset runtime)
│  ├─ fetch-fonts.js          # Unduh Inter + JetBrains Mono ke vendor/fonts/
│  └─ render-pdf.js / tmp-pipe.js / generate-pdf.js   # utilitas dev PDF
├─ docs/                      # Audit, spesifikasi, manual pengguna
└─ sample-data/
   ├─ templates/              # Template KECIL (header + beberapa baris) — ikut repo
   ├─ full/                   # Data besar uji beban — DI-GITIGNORE, tidak ikut repo
   └─ threshold-settings-2026-10-05.json   # Setelan threshold contoh
```

> `[RUNTIME]` = ikut ter-deploy. Sisanya (`test/`, `tools/`, `docs/`,
> `sample-data/`, `serve.js`) hanya untuk pengembangan — lihat `npm run build`
> di §1.

> **Offline-ready**: Chart.js & Font Awesome disimpan di `vendor/` (tidak lagi
> dari CDN), sehingga dashboard tetap berfungsi penuh **tanpa internet**.
> Google Fonts bersifat opsional (ada fallback font sistem).

---

## 5. Cara Menjalankan

Cukup buka `index.html` di browser, atau jalankan server lokal:
```powershell
npm start        # = node serve.js  ->  http://127.0.0.1:5500
```

Urutan pemuatan script **penting**:
`config → profiles → knowledge → parser → validate → unit-db → analytics → fleet-store → ranking → render → app → SOS → cross → settings`.

> 📖 **Panduan pemakaian lengkap** untuk end-user ada di
> [`docs/MANUAL_PENGGUNAAN.md`](docs/MANUAL_PENGGUNAAN.md).

---

## 6. Fitur Unggulan

### 6.1 Database Unit — Nomor Lambung (SN → Nomor Lambung)
Upload file CSV berisi kolom `Machine Serial No.` dan `Nomor Lambung` dari panel
**Database Unit** di halaman Fleet Overview. Nomor Lambung akan otomatis
dicocokkan berdasarkan SN setiap unit yang dimuat, dan **tersimpan di browser
(localStorage)** sehingga bertahan antar sesi di perangkat yang sama.

- Tombol **Unggah Database Unit** — pilih file CSV/teks.
- Tombol **Unduh Template** — contoh format CSV.
- Tombol **Hapus** — hapus pemetaan dari browser.
- Mengunggah file baru akan **menggantikan** pemetaan lama (bukan menambah).

Nomor Lambung tampil di kolom katalog armada, **chip header unit** (sebagai
identitas utama), bar unit aktif, dan panel Identitas Unit.

> **Revisi header:** header unit kini menampilkan **Nomor Lambung** sebagai
> identitas utama (chip hijau), bukan SN. Bila Database Unit belum dimuat,
> chip menampilkan *“Lambung belum tersedia”*; SN tetap tersedia di tooltip
> chip & bar unit aktif untuk rujukan teknis. Mengunggah Database Unit saat
> sebuah unit sedang dibuka akan **langsung menyegarkan** header.

### 6.2 Bobot Pilar — Engine Lebih Dominan
Skor criticalitas memberi bobot lebih besar pada kompartemen **Engine**
(`RANKING_PILLAR_WEIGHTS` di `vhms-config.js`), sehingga unit dengan masalah
Engine selalu naik ke atas peringkat.

### 6.3 Aturan Dua Sumber Data (TAMPILAN vs FORMULA)

Mulai revisi ini, sumber data dipisah **tegas** menjadi dua aturan:

| Aturan | Cakupan | Sumber data |
|---|---|---|
| **1. TAMPILAN** | Chart grup dinamis, tabel Log Telemetri, identitas/rentang SMR | **SELURUH data asli** dari file CSV (tanpa pemotongan) |
| **2. FORMULA** | Nilai KPI card, status & anomali (banner/panel AI), health index, ranking criticality (severity/evidence/trend), matriks per parameter | **HANYA `FORMULA_WINDOW_HOURS` jam SMR terakhir** |

Konfigurasi di `js/vhms-config.js`:

```js
var FORMULA_WINDOW_HOURS = 2000;        // semua perhitungan
var RANKING_WINDOW_HOURS = FORMULA_WINDOW_HOURS;  // alias (kompatibilitas)
var CHART_WINDOW_HOURS   = 0;           // 0 = chart tampilkan SEMUA data
```

- **Chart** menampilkan badge *“Seluruh data (N titik)”* sebagai penanda Rule 1.
- **KPI card** menampilkan badge *“2.000j”* sebagai penanda Rule 2 (nilai dihitung
  dari window 2000 jam terakhir).
- `analysis.records` = seluruh data (Rule 1); `analysis.windowRecords` &
  `analysis.summary`/`anomalies`/`health` = window (Rule 2).
- Ubah `FORMULA_WINDOW_HOURS` bila ingin jendela formula lain (mis. 3000).

### 6.4 Urutan Katalog Default — Critical → Normal
Baik katalog **VHMS** (Home) maupun **SOS** diurutkan default
dari **paling critical di atas** sampai **paling normal di bawah**, sehingga
unit paling butuh perhatian selalu muncul lebih dulu.

- **Kolom "Prioritas"** baru ditambahkan di paling kiri kedua tabel:
  - VHMS: `P1` = Critical, `P2` = Caution, `P3` = Normal.
  - SOS: `P1` = Normal, `P2` = Caution, `P3` = Critical.
- Klik header **Prioritas** selalu mengurutkan *worst → best* (arah tetap).

Urutan kunci sortir (VHMS `compareSeverity`):
1. Label status (CRITICAL > CAUTION > NORMAL)
2. `engineCritical` (jumlah anomali pilar Engine berstatus kritis)
3. `rankScore` (skor criticality window 0–100)
4. `nCritThresholds` (parameter melewati batas kritis)
5. `anomalyCount` (total anomali)
6. `healthScore` (makin kecil makin diprioritaskan)

Urutan kunci sortir (SOS `compareSeverity`):
1. Tier (CRITICAL > CAUTION > NORMAL)
2. MPRS, 3. `criticality.score`, 4. `hmUnit` (jam operasi lebih tinggi)

Kolom header lain (Serial, Health, MPRS, dll.) tetap dapat diklik untuk
mengurutkan sesuai kolom tersebut.

#### 6.4a Mode Nilai Parameter SOS (Terakhir / Rata-rata / Terburuk)
Katalog SOS (Status per Kompartemen) menampilkan kolom parameter
(Fe, Cu, Si, PQI, V100). Sumber nilainya dapat dipilih lewat dropdown
**"Nilai parameter:"** di toolbar:

| Mode | Sumber Nilai | Kegunaan |
|---|---|---|
| **Sampel Terbaru** *(default)* | sampel dengan HM tertinggi | kondisi terkini unit |
| **Rata-rata (window 4000 jam)** | rata-rata nilai pada sampel dalam **4000 jam terakhir** (fallback 5 sampel bila HM kosong) | meredam noise antar-sampel |
| **Terburuk (window 4000 jam)** | nilai pada sampel dengan **severity tertinggi** dalam window 4000 jam | tangkap lonjakan/kondisi terburuk |

- **"Terburuk" sadar-arah**: untuk parameter high=buruk (Fe, Cu, Si, PQI)
  yang dipilih adalah nilai **tertinggi**; untuk parameter low=buruk
  (mis. `visc_v100`, `tbn` yang punya `warn_low`/`crit_low`) yang dipilih
  adalah nilai **terendah**. Penentuan lewat `severityScore()`.
- Diimplementasikan di `SOS_ANALYTICS.windowStats(samples, component, keys, N)`
  (`js/sos-analytics.js`) → mengembalikan `{ last, avg, worst, min, max, n }`
  per parameter. `sos-render.js` memilih nilai sesuai `fleetState.valueMode`.
- Saat mode bukan "Sampel Terbaru", nilai kolom diberi penanda kecil
  (**avg** / **worst**) sebagai indikator.
- Ganti default lewat `setFleetState({ valueMode: 'last'|'avg'|'worst' })`.

> Catatan: **MPRS, Tier, Diagnostics** selalu dihitung dari **sampel terbaru**;
> **Criticality** memakai jendela 4000 jam (Severity=last, Evidence & Trend=jendela).

#### 6.4b Halaman Cross Analysis — Korelasi VHMS × SOS
Halaman baru (tombol **Cross Analysis** di header, berlaku di kedua mode) yang
menggabungkan sinyal **telemetri mekanikal VHMS** dengan **analisa kimia oli SOS**
untuk unit yang sama — mendeteksi akar masalah yang tak terlihat dari satu sumber.

**Penghubung (linkage) unit** — berlapis: `VHMS.serial` → `VHMS.lambung` →
`SOS.asset_id`/`asset_serial`, dengan bantuan **Database Unit** (SN → Nomor Lambung).

**Dua level:**
1. **Peta Unit Terhubung (fleet)** — tabel semua unit VHMS dengan status korelasi,
   tier SOS, kekuatan korelasi |r|, dan hipotesis dominan. Diurutkan menurut
   **Prioritas** = kekuatan korelasi × keparahan gabungan.
2. **Detail Korelasi (per unit/kompartemen)** — 4 visualisasi:
   - **Heatmap Korelasi** — baris parameter VHMS × kolom parameter SOS; warna =
     koefisien Pearson (nilai ternormalisasi). **Klik sel → popup scatter** berisi
     chart + statistik (r, n, basis, kekuatan) + **narasi penjelasan** + tabel data
     mentah + tombol Back. (Menggantikan perilaku lama yang hanya render inline.)
   - **Timeline Gabungan** — **1 garis VHMS** + **beberapa titik sampel SOS**
     (multi-select) pada sumbu-X **SMR/HM** yang sama. Tiap parameter SOS punya
     **sumbu-Y sendiri** (Opsi multi-axis) agar satuan berbeda tetap terbaca.
     Default terpilih: parameter pasangan + **Na** + **TBN**.
   - **Scatter Korelasi** — dua parameter (0–1 ternormalisasi) + nilai **r** & n.
   - **Radar Profil Gabungan** — keparahan per pilar VHMS vs cluster SOS.
   - **Tabel Korelasi Dinamis** (bawah Timeline) — menghitung **Pearson r secara
     real-time** antara parameter VHMS (garis) vs **tiap** parameter SOS yang
     dipilih. Parameter dengan |r| tertinggi (≥ 0.5) ditandai **"penyebab dominan"**.
     Nilai r **berubah otomatis** mengikuti seleksi parameter SOS user.
   - Plus **Tabel Korelasi & Hipotesis** berperingkat.

**Metodologi** (`js/vhms-cross.js`):
- Titik korelasi = sampel SOS (pakai **HM Unit**, fallback HM Oil).
- Nilai VHMS **diinterpolasi linear** ke setiap meter titik SOS.
- Kedua deret **dinormalisasi 0–1** relatif threshold masing-masing (VHMS &
  SOS), lalu dihitung **Pearson r**. Ini membuat ppm vs °C vs MPa adil dibandingkan.
- **Kepercayaan** (Rendah/Sedang/Tinggi) berbasis jumlah titik & tumpang-tindih
  rentang SMR.
- `pairCorrelation()` (fungsi baru) menghitung r ad-hoc untuk **pasangan apa pun**
  yang dipilih user (tidak terbatas `CURATED_PAIRS`) — dipakai tabel R dinamis.

**Peta pasangan parameter terkurasi** — `CURATED_PAIRS` di `js/vhms-cross.js`
(17 pasangan, dapat ditambah/diubah). Contoh:
| VHMS | SOS | Hipotesis |
|---|---|---|
| `blowbyMax` | `wear_fe` | Keausan piston ring / cylinder liner |
| `blowbyMax` | `additive_na` | **Kontaminasi Na (coolant) → pelumasan turun → blowby naik** |
| `blowbyMax` | `tbn` | **Aditif terkuras → pelumasan menurun** |
| `oilPressHMin` | `wear_cu`/`wear_pb` | Keausan bearing/bushing mesin |
| `engOilTemp` | `oxidation`/`tbn` | Degradasi oli |
| `coolantTemp` | `water_pct` | Kebocoran sistem pendingin/gasket |
| `hydTempMax` | `wear_cu`/`wear_sn` | Keausan pompa/bushing hidrolik |
| `tcOilTempMax` | `wear_cu` | Keausan torque converter/transmisi |

> **Catatan engineering:** Blowby menandakan kompresi bocor / **pelumasan buruk**.
> Penyebabnya bisa bermacam-macam — bukan hanya silika (Si/dirt), tetapi juga
> kontaminasi **Na** (coolant), **air**, atau **TBN** yang terkuras. Karena itu
> pasangan Blowby↔Na & Blowby↔TBN ditambahkan, dan **tabel R dinamis** memudahkan
> menemukan **penyebab dominan** pada unit tertentu.

> Catatan: jumlah sampel SOS biasanya sedikit → korelasi diberi label
> kepercayaan & diprioritaskan analisa **arah tren + visual**, bukan p-value.
> Parameter yang tidak ada di salah satu sumber ditandai "—" dan dikecualikan.

#### 6.4c Panel Pengaturan — Tema & Threshold
Tombol **⚙️ Pengaturan** di header membuka modal dengan 3 sub-tab
(`js/vhms-settings.js`):

1. **Tema** — 9 pilihan tema tampilan: **Slate** (default), **Obsidian**,
   **Sapphire**, **Plum Noir**, **Midnight**, **Carbon**, **Forest**,
   **Porcelain**, **Nordic Light**. Dipilih lewat kartu visual,
   diterapkan sebagai `body[data-theme="..."]`, dan **disimpan di localStorage**.
   Tema mengubah token CSS (`--bg`, `--card`, `--panel-grad-*`, `--header-bg`,
   `--accent`, dst.) sehingga seluruh UI ikut berubah.

2. **Threshold VHMS** — editor tabel ambang batas telemetri (warn, crit, mode
   high/low, label) untuk setiap parameter. Tombol **Simpan** menerapkan +
   menyimpan ke localStorage; **Reset** mengembalikan default `vhms-config.js`.

3. **Threshold SOS** — editor ambang batas per **kompartemen** (warn/crit/extreme
   serta warn_low/crit_low untuk parameter "makin rendah makin buruk" seperti
   viskositas & TBN).

**Alur penerapan threshold:** karena `analyze()` menyimpan **snapshot**
`thresholdSet` per unit, menyimpan threshold akan:
`update objek config → persist localStorage → reanalyzeAll()` — data VHMS
(`VHMS_FLEET.reanalyzeAll()`) & SOS (`SOS_STORE.reanalyze()`) dihitung ulang,
lalu tampilan disegarkan (`VHMS_APP.refreshCurrent()`).
Saat aplikasi dibuka, threshold tersimpan dimuat & ditempel ke objek config
(`VHMS_SETTINGS.loadThresholds()`), menimpa nilai default file `.js`.

### 6.5 Penanda Filter pada Katalog

Baris **Filter Cepat** menampilkan chip per status (Semua/Critical/Caution/Normal)
beserta jumlah unit. Chip yang aktif diberi warna mencolok, dropdown status
ter-highlight, dan muncul **tag filter aktif** beserta tombol **Reset Filter**
saat ada filter atau pencarian aktif.

### 6.6 Chart Dinamis & Satuan Standar Komatsu
Chart **tidak lagi hardcode** — dibangun otomatis dari grup di
`CHART_GROUPS` (`vhms-config.js`). Prinsipnya:

- **Hanya grup dengan data yang tampil.** Bila file tidak memuat kolom
  hydraulik/fan/greasing, grup tersebut otomatis disembunyikan. Jadi satu
  dashboard melayani HD/PC/Dozer yang kolomnya berbeda.
- **Window 1000 jam terakhir.** Setiap grup hanya menggambar data pada
  `CHART_WINDOW_HOURS` jam SMR terkini (badge keterangan tampil di panel).
- **Sumbu kiri/kanan dipisah otomatis** bila satuan seri berbeda.
- **Satuan disatukan ke notasi baku Komatsu** melalui `UNIT_ALIASES` /
  `normalizeUnit()`: `degC`→`°C`, `Liter/h`→`L/h`, `Times`→`kali`, `sec`→`s`, dst.
  Satuan diambil dari baris `Axis Scale` file VHMS bila ada.

Untuk menambah/mengubah chart, cukup sunting `CHART_GROUPS` di config.

### 6.7 Multi-Model: HD / PC / Dozer (`vhms-profiles.js`)
Satu dashboard melayani **tiga keluarga produk** dengan skema berbeda:

| Keluarga | Deteksi | Catatan |
|---|---|---|
| **EXCAVATOR** | `Product Group` mengandung *excavator* / kode `PC…` | Blowby, hydraulic, swing, auto-greasing |
| **TRUCK (HD)** | *dump truck*/*haul* / kode `HD…` | + Brake Temp, Retarder Temp; tanpa swing/pump |
| **DOZER** | *dozer* / kode `D…` | + Torque Converter/PTO |
| **UNKNOWN** | tak terdeteksi | Skema generik + tanda `NA` di UI |

Setiap keluarga punya **threshold, kompartemen KPI, dan bobot ranking
sendiri** (`vhms-profiles.js`). **Kecocokan field otomatis**: parameter yang
tidak ada di file (kolom absen) otomatis dilewati pada KPI, chart, anomali,
dan ranking — bukan error. Keluarga tampil di header unit & kolom katalog.

> Isi skema mengikuti struktur umum VHMS + praktik reliability umum (bukan
> dokumen resmi Komatsu). Sesuaikan di `vhms-profiles.js` bila perlu.

#### 6.7a Template DOZER Besar — D375A-6 (`sample-data/65258.CSV`)
Template baru untuk dozer besar telah didaftarkan (contoh file: `65258.CSV`).
Selain parameter umum, D375A memakai kolom khas berikut yang sudah dipetakan
ke `PARAMS` (`vhms-config.js`) dan skema `DOZER` (`vhms-profiles.js`):

| Parameter (key) | Kolom CSV | Satuan | Skala | Catatan |
|---|---|---|---|---|
| `fExhTempMax` / `rExhTempMax` | `F Exh.Temp Max` / `R Exh.Temp Max` | °C | 1 | Suhu gas buang bank kiri/kanan; selisih besar = injeksi/kompresi tak seimbang |
| `tmMainPressMax` / `tmMainPressAve` | `TM Main P.Max` / `TM Main P.Ave` | MPa | 0.1 | Tekanan main torque converter/transmisi (`mode:'low'`) |
| `tcOilTempMax` | `T/C Oil TempMax` | °C | 1 | Suhu oli torque converter |
| `largePumpPress` | `Large Pump P.Max` | MPa | 0.1 | Tekanan pompa hidrolik blade/ripper (`mode:'low'`) |
| `operatingTime` / `dozingTime` / `rippingTime` | `Operating Time` dst. | h | 0.1 | Durasi kerja |
| `passTimes` | `Pass Times` | kali | 1 | Siklus pass |
| `pitchAngleMax` / `Ave` / `Min` | `Pitch Angle …` | ° | 0.1 | Kemiringan blade (Max positif, Min negatif) |

**Yang otomatis menyesuaikan:**
- **Alias header** untuk D375A (`PARAM_COLUMN_OVERRIDES.DOZER`):
  `E.Oil P.Hi_Min`, `E.Oil P.Max`, `Blowby Press Max` — sehingga pencocokan
  berbasis nama tetap jalan meski beda penulisan.
- **3 grup chart baru**: *Exhaust Gas Temperature*, *Torque Converter &
  Transmission*, *Dozing Productivity* (muncul hanya bila kolomnya berisi data).
- **6 kartu KPI DOZER**: Engine, Exhaust & Combustion, Blade & Ripper Hydraulic,
  Torque Converter/PTO, Cooling & Thermal, Dozing Productivity.
- **Tabel Log Telemetri** memakai `TABLE_COLUMNS_DOZER` (via
  `cfg.tableColumnsFor(familyId, records)`) — menampilkan kolom khas dozer
  dan menyaring kolom yang benar-benar kosong.
- **Knowledge base** (`vhms-knowledge.js`) bertambah entri untuk
  `fExhTempMax`/`rExhTempMax` dan section **POWERTRAIN** (`tcOilTempMax`,
  `tmMainPressMax`, `largePumpPress`).
- **Bobot pilar** `POWERTRAIN` (1.4) & `BRAKE` (1.3) ditambahkan di
  `RANKING_PILLAR_WEIGHTS`.

**Uji cepat** — untuk keperluan demo/anomali, gunakan berkas contoh di
`sample-data/` lewat **Pilih File CSV** (VHMS atau SOS), atau jalankan
`npm test` untuk verifikasi pipeline parser → analytics → ranking.


#### 6.7b Pemetaan Kolom Dinamis per Keluarga + Alias + Fallback

Nama kolom VHMS **berbeda antar model** (mis. HD785 menulis `EOil Pre.MAX`,
Excavator punya `E.Oil P.H_Min`/`E.Oil P.Hi_Min`). Agar pengambilan data
**dinamis & sesuai per model**, tiga mekanisme tersedia:

1. **Alias kolom** — entri `PARAMS` boleh punya `aliases: [...]`. Parser
   mencocokkan `csvHeader` **dan** semua alias (dinormalisasi). Contoh:
   `oilPressHMin` menerima `E.Oil P.H_Min`, `E.Oil P.Hi_Min`, dst.
2. **Override per keluarga** — `PARAM_COLUMN_OVERRIDES` di `vhms-config.js`
   menimpa nama kolom/skala/satuan sebuah parameter untuk keluarga tertentu
   (`TRUCK`, `DOZER`, …). `paramsForFamily(familyId)` menggabungkannya.
   Parser mendeteksi keluarga lebih awal & memakai peta efektif tsb.
3. **Fallback parameter** — threshold boleh punya `fallbackFor: '<key>'`.
   Param itu **hanya dipakai bila target tidak punya data**. Contoh HD:
   `oilPressMax` (mode `low`) jadi cadangan untuk `oilPressHMin`; bila H-Min
   ada, H-Min dipakai (tidak dobel); bila H-Min tak ada (HD785 hanya
   `EOil Pre.MAX`), **Engine Oil Press tetap muncul** di ranking & matrix.
   Logika: `VHMS_RANKING.effectiveThresholdKeys()`.

### 6.8 Rekomendasi Diagnostik Berbasis Pengetahuan Offline (`vhms-knowledge.js`)

Saat ada anomali, panel **Predictive Diagnostic AI** menampilkan:

- **Kemungkinan Penyebab** — daftar dugaan penyebab sesuai parameter & tingkat.
- **Rekomendasi Tindakan** — langkah perbaikan bertanda **KB Offline**.
- **Eskalasi** — peringatan khusus untuk kasus kritis (mis. brake/oli).
- **Rujukan literasi** — sumber rujukan (Shop Manual/Bulletin) sebagai dasar.
- **Konteks tren** — rekomendasi menyesuaikan arah tren nilai (naik/menurun).

Basis pengetahuan **100% offline & tertanam** di modul (tidak ada panggilan
internet saat runtime, tidak menyimpan file tambahan). Rekomendasi dipilih
**kontekstual** per parameter × tingkat (CAUTION/CRITICAL) × keluarga produk.

#### Banner Alert → Modal Rekomendasi
Banner **Critical Alert / Perhatian** muncul di **halaman Dashboard Unit**
(disembunyikan di Armada & Comparison). **Seluruh area banner bisa diklik**
(cursor pointer) atau ditekan Enter/Space → membuka **modal overlay** berisi
daftar lengkap anomali + rekomendasi tindakan (kartu sama dengan panel AI).
Modal dapat ditutup lewat tombol **×**, tombol **Esc**, atau klik area gelap.
Fungsi: `VHMS_RENDER.openAnomalyModal()` / `closeAnomalyModal()`.

### 6.9 Validasi Data & Merge Otomatis (`vhms-validate.js`)
Sebelum dianalisis, data divalidasi:

- **SMR tidak wajar dibuang** — SMR `null`, `0`, atau negatif dibuang, dan
  dilaporkan (`validationReport`).
- **Duplikat SMR dibuang** — dalam satu file, SMR sama dianggap satu record;
  **data terbaru (baris paling akhir) menang**.
- **Peringatan metadata** — SN/Model kosong dilaporkan.
- **Lompatan SMR mencurigakan** dideteksi (indikasi unit berbeda tercampur).

**Merge otomatis antar-file**: bila Anda mengunggah beberapa file dengan
**Serial No. sama**, record-nya **digabung** (bukan menimpa):

| Kondisi | Perilaku |
|---|---|
| SN sama, SMR beda | record ditambahkan (data lanjutan) |
| SN sama, SMR sama | data file **terbaru menang** |
| SN berbeda | unit terpisah |
| SN kosong | tidak di-merge (identitas dari nama file) |

Setelah merge, analitik & ringkasan unit dihitung ulang otomatis, dan jumlah
unit di armada tetap konsisten. Ringkasan validasi ditampilkan pada notifikasi.

---

## 7. Alur Data

```
File CSV VHMS (satu atau banyak)
     │
     ▼
[ vhms-parser.js ]  ── baca blok [Common Header] & [Data]
     │                 kenali nama kolom dari baris "Axis Item"
     │                 terapkan faktor skala (scale) per kolom
     ▼
  records[]  (SMR, Calendar, 50+ parameter engineering)
     │
     ▼
[ vhms-fleet-store.js ] ── beri ID unit (Serial No. + Model),
     │                     hitung ringkasan ringan SEKALI per unit
     ▼
  fleet { unit_id -> { analysis, summaryRow } }
     │
     ▼
[ vhms-analytics.js ] ── statistik (min/max/avg), status vs threshold,
     │                    slope tren, daftar anomali + rekomendasi,
     │                    health index  (per unit)
     ▼
  analysis  { meta, records, summary, anomalies, health }
     │
     ▼
[ vhms-render.js ] ── DUA MODE:
                      • Fleet: kartu statistik armada + tabel katalog
                      • Unit : KPI cards, 4 chart Chart.js, panel AI,
                               tabel log, footer, banner alert
```

---

## 8. Performa untuk Skala 200+ Unit

Desain ini sudah diuji dengan **220 unit (≈44.000 record)**. Kunci optimasinya:

| Teknik | Penjelasan |
|---|---|
| **Ringkasan dihitung sekali** | Saat unit ditambahkan, `fleet-store` menyimpan `summaryRow` ringan. Tabel katalog 200+ baris tidak menyentuh record mentah. |
| **Pemrosesan bertahap (chunked)** | Multi-upload diproses 6 file per giliran + jeda `setTimeout(0)`, sehingga UI tidak membeku. |
| **Batas render DOM** | Tabel katalog maksimum 300 baris, tabel log maksimum 400 baris per tampilan. |
| **`releaseRecords(id)`** | Melepas array record mentah unit yang tidak dibuka untuk hemat memori; `summaryRow` tetap ada. |

Kapasitas praktis: **200–500 unit** nyaman di browser modern. Untuk ribuan unit,
pertimbangkan backend agregasi (di luar cakupan versi ini).

---

## 9. Menyesuaikan ke Unit Lain

**Untuk penyesuaian cepat, tidak perlu edit file** — buka **⚙️ Pengaturan** di
header → tab **Threshold VHMS / Threshold SOS** → ubah nilai → **Simpan**.
Perubahan tersimpan di browser & langsung berlaku.

**Untuk mengubah default pabrik**, edit file berikut:

### 9.1. Ganti model / threshold
```js
var THRESHOLDS = {
  blowbyMax:  { warn: 4.0,  crit: 10.0, mode: 'high', label: 'Blowby Pressure' },
  coolantTemp:{ warn: 95.0, crit: 102.0, mode: 'high', label: 'Coolant Temp' },
  // mode: 'high' = makin besar makin bahaya
  // mode: 'low'  = makin kecil makin bahaya (mis. tekanan oli)
  ...
};
```

### 9.2. Ganti nilai skala (PENTING)
Beberapa nilai dalam CSV VHMS disimpan dalam satuan terkecil. Field `scale`
mengoreksi ini. Jika unit Anda memakai encoding berbeda, ubah di sini:

| Parameter    | Nilai CSV | Nilai engineering | `scale` |
|--------------|-----------|-------------------|---------|
| Blowby       | 2349      | 23.49 kPa         | 0.01    |
| Semua tekan. | 357       | 35.7 MPa          | 0.1     |
| Fuel Rate    | 1434      | 143.4 L/h         | 0.1     |
| Engine Oil P | 55        | 0.55 MPa          | 0.01    |

### 9.2b. Skala SMR (`SMR_SCALE`)
Beberapa export VHMS menyimpan kolom SMR dalam **satuan 0.1 jam**
(mis. `750035` → 75.003,5 jam). Field `SMR_SCALE` (default `0.1`) di
`vhms-config.js` mengoreksi ini. Bila unit Anda menulis SMR dalam **jam penuh**,
ubah menjadi `1`.

> Catatan: `SMR_SCALE` memengaruhi seluruh perhitungan berbasis jam
> (windowFormula, durasi evidence, tren). Pastikan nilainya sesuai format CSV Anda.

### 9.3. Ganti/tambah chart
```js
var CHARTS = [
  {
    id: 'chart-engine',
    title: '...',
    type: 'line',            // 'line' | 'bar'
    xAxis: 'smr',
    series: [
      { param: 'blowbyMax', label: 'Blowby Max', axis: 'left',  color: '#ef4444', fill: true },
      { param: 'oilPressMax', label: 'Oil Press', axis: 'right', color: '#fbbf24', dashed: true }
    ],
    axisTitles: { left: 'Blowby (kPa)', right: 'Oil Press (MPa)' }
  }
];
```
Kolom `<canvas id="chart-xxx">` dan `<div id="chart-xxx-legend">` harus ada di
`index.html` agar chart muncul.

### 9.4. Ganti kompartemen KPI
Sesuaikan array `COMPARTMENTS` di `vhms-config.js`.

---

## 10. Format CSV yang Didukung

Parser toleran terhadap beberapa varian ekspor VHMS:

1. **Header `Axis Item` di blok atas** (format ekspor Trend Analysis VHMS) ✓
2. **Header di dalam `[Data]`** ✓
3. **Tanpa header sama sekali** → memakai pemetaan posisi default (fallback) ✓
4. Nilai sentinel (`-32768`) otomatis dianggap "tidak ada data" (null) ✓

Deteksi kolom **berbasis nama**, bukan posisi, jadi tahan terhadap
perbedaan urutan kolom antar unit.

---

## 11. Fitur

| Fitur | Keterangan |
|---|---|
| Pemuatan CSV | File picker multi-file, drag & drop banyak file, atau armada contoh |
| **Fleet Overview** | Katalog semua unit: statistik armada, distribusi model, tabel unit |
| **Navigasi level** | Klik "Detail" untuk buka unit, tombol "Kembali ke Armada" untuk naik |
| **Unit Comparison** | Peringkat criticalitas seluruh unit (skor 0–100, 3 sumbu) |
| **Top 10 Critical** | Daftar prioritas pemeliharaan + distribusi pilar penyebab |
| Filter peringkat | Filter per model, per band, pencarian, sortir kolom |
| Ekspor peringkat | Hasil ranking ke CSV |
| Pencarian & filter armada | Cari serial/model/file, filter status, urut kolom |
| KPI 6 kompartemen | Engine, Hydraulic, Cooling, Fan/PTO, Greasing, Productivity |
| 4 chart interaktif | Engine, Hydraulic, Cooling, Productivity (Chart.js) |
| Deteksi anomali | Otomatis dari threshold + rekomendasi tindakan |
| Health Index | Skor 0–100 berdasarkan proporsi record normal |
| Tren (slope) | Least-squares per parameter vs SMR |
| Tabel log | Cari, filter status, urut kolom, 200 record |
| Cetak laporan | Tombol Cetak → dialog print browser |
| Format angka | Lokal Indonesia (`1.234,5`) |
| Offline-friendly CSS | Tidak bergantung Tailwind CDN |

> Chart.js & Font Awesome sudah disimpan lokal di `vendor/` (bukan CDN) sehingga
> dashboard berfungsi **offline penuh**. Google Fonts opsional (ada fallback
> font sistem bila tanpa internet).

---

## 12. Menjalankan Uji (tanpa browser)

Test suite minimal (Node murni) tersedia dan menjadi *regression gate*:

```powershell
cd "c:\xampp\htdocs\Reliability Based Maintenance"
npm test          # atau: node test/test-suite.js
```

Test memuat modul UMD ber-urutan (config → parser → validate → analytics →
store) dan memverifikasi: utilitas CSV, escape kutip, validasi/dedup SMR,
dedup SOS, ambang band ranking, dan pola falsy-zero.

Untuk uji ad-hoc satu modul:

```powershell
node -e "
global.window = global;
require('./js/vhms-config.js');
require('./js/vhms-parser.js');
require('./js/vhms-analytics.js');
require('./js/vhms-fleet-store.js');
const fs = require('fs');
const parsed = global.VHMS_PARSER.parse(fs.readFileSync('sample-data/BDKM37132.csv','utf8'));
const a = global.VHMS_ANALYTICS.analyze(parsed);
console.log('Records:', a.records.length);
console.log('Health:', a.health);
"
```

---

## 13. Catatan

- Semua pemrosesan terjadi **di browser** — tidak ada data yang dikirim ke
  server mana pun.
- Identitas unit diambil otomatis dari **Machine Serial No.** (+ Model). Bila
  kosong, dipakai nama file; bila bentrok, ditambah akhiran `#2`, `#3`, dst.
- Nilai ambang batas bersifat **indikatif**; sesuaikan dengan buku manual unit.
  Dapat diubah cepat lewat **⚙️ Pengaturan → Threshold** (tanpa edit file).
- **Preferensi tersimpan di browser:** tema (`oms.theme`), threshold VHMS
  (`oms.thresholds.vhms.v1`), threshold SOS (`oms.thresholds.sos.v1`), mode
  aktif (`oms.activeMode`), Database Unit, sesi armada VHMS & SOS.
- Untuk menambah parameter baru: tambahkan entri di `PARAMS`, opsional di
  `THRESHOLDS`, lalu pakai `param`-nya di `CHARTS`/`COMPARTMENTS`.
- Script npm yang tersedia: `npm start` (serve.js), `npm run build`
  (tools/build-deploy.js -> dist/) dan `npm test`
  (test/test-suite.js).
- 📖 **Dokumentasi pengguna akhir:** [`docs/MANUAL_PENGGUNAAN.md`](docs/MANUAL_PENGGUNAAN.md).

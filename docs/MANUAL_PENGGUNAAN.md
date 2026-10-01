# Manual Penggunaan — Reliability Based Maintenance || OMS-SOS Lab

> Panduan lengkap pemakaian dashboard prediktif (VHMS × SOS) untuk alat berat
> Komatsu. Cocok untuk operator, mekanik, planner, maupun reliability engineer.

**Versi dokumen:** 1.0 · **Update terakhir:** 27 September 2026

---

## Daftar Isi

1. [Ringkas: Apa itu aplikasi ini?](#1-ringkas-apa-itu-aplikasi-ini)
2. [Memulai Cepat](#2-memulai-cepat)
3. [Tiga Mode Utama](#3-tiga-mode-utama)
4. [Mode VHMS (Telemetri)](#4-mode-vhms-telemetri)
5. [Mode SOS (Analisa Oli)](#5-mode-sos-analisa-oli)
6. [Cross Analysis (VHMS × SOS)](#6-cross-analysis-vhms--sos)
7. [Pengaturan: Tema & Threshold](#7-pengaturan-tema--threshold)
8. [Membaca Interpretasi & Rekomendasi](#8-membaca-interpretasi--rekomendasi)
9. [Tips & Pemecahan Masalah](#9-tips--pemecahan-masalah)
10. [Glosarium](#10-glosarium)

---

## 1. Ringkas: Apa itu aplikasi ini?

Dashboard **prediktif maintenance** yang menggabungkan **dua sumber data**:

| Sumber | Isi | Format |
|---|---|---|
| **VHMS** (Vehicle Health Monitoring System) | Telemetri mekanikal: blowby, suhu oli, tekanan, SMR (jam operasi) | CSV ekspor Trend Analysis Komatsu |
| **SOS** (Scheduled Oil Sampling) | Hasil lab oli: logam keausan (Fe, Cu, Si…), kondisi oli (TBN, viskositas), kontaminan (Na, air) | CSV ekspor lab (Intertek/Trakindo/dealer) |

**Semua diproses di browser** — tidak ada data yang dikirim ke server mana pun.
Bisa dipakai **offline** (Chart.js & ikon sudah lokal).

**Nilai tambah utamanya:** *Cross Analysis* — mengorelasikan gejala mekanikal
(telemetri) dengan bukti kimia oli untuk menemukan **akar masalah** lebih dini.

---

## 2. Memulai Cepat

### Cara A — Buka langsung (paling praktis)
1. Klik dua kali `index.html` → terbuka di browser.
2. Klik **Pilih File CSV (bisa banyak)** → pilih satu/beberapa file sekaligus
   (tahan `Ctrl`/`Shift`).

### Cara B — Pakai server lokal (disarankan untuk pengujian)
```powershell
cd "c:\xampp\htdocs\VHMS-Dashboard"
npm start          # atau: node serve.js
```
Buka **http://127.0.0.1:5500**.

### Memuat data
- **VHMS:** klik **Pilih File CSV** di area sambutan, atau tarik-lepas file ke halaman.
- **SOS:** masuk ke mode **SOS Lab** → klik **Pilih File CSV**.
- Data **tersimpan otomatis** di sesi browser (sessionStorage) — reload tidak
  menghilangkan data. Gunakan tombol **Kosongkan** untuk menghapus.

### Database Unit (Nomor Lambung)
Panel **Database Unit** memetakan **SN → Nomor Lambung** agar unit mudah dikenali.
- Unggah CSV dengan kolom `Machine Serial No.` dan `Nomor Lambung`.
- Contoh file: **`sample-data/Nomor Lambung.csv`** (sudah disertakan).
- Data disimpan di **localStorage** (persisten).

---

## 3. Tiga Mode Utama

Header aplikasi punya tombol navigasi:

| Tombol | Fungsi |
|---|---|
| 🏠 **Home** | Katalog armada / halaman utama (sesuai mode aktif) |
| 🔀 **Cross Analysis** | Analisa korelasi VHMS × SOS per unit |
| 🧪 **SOS Lab** / **VHMS** | Tukar mode antara telemetri (VHMS) & oli (SOS) |
| ⚙️ **Pengaturan** | Tema & threshold |
| 🖨️ **Cetak / Ekspor Laporan** | Cetak / simpan laporan |

Mode aktif **tersimpan** — reload akan kembali ke mode terakhir.

---

## 4. Mode VHMS (Telemetri)

### 4.1 Katalog Home — Machine Overview
Setelah data dimuat, Anda melihat katalog semua unit:
- **Kartu statistik:** total unit, Critical/Warning/Normal, rata-rata health.
- **Tabel unit:** Prioritas (P1–P3), Serial, Nomor Lambung, Model, Status,
  Health, SMR, KPI kunci, Anomali, Perhatian Utama, Sisa Operasi (RUL).
- **Filter & cari:** kotak cari + dropdown status + chip filter cepat.
- **Urut default:** paling critical di atas (klik header kolom untuk ubah).
- **Ekspor Katalog:** unduh seluruh ringkasan ke CSV.

### 4.2 Detail Unit
Klik **Detail** pada baris unit:
- **Header:** identitas unit (Nomor Lambung/SN, model, keluarga) + SMR/Health/RUL.
- **6 KPI card:** nilai kunci dengan status warna.
- **Chart grup** (Engine, Hydraulic, Cooling, dst.): seluruh data asli CSV.
- **Panel Diagnostik:** anomali terdeteksi + rekomendasi tindakan.
- **Tabel Log Telemetri:** riwayat mentah, bisa difilter.
- Tombol **Kembali ke Home** untuk kembali ke katalog.

> **Aturan Dua Sumber Data:**
> - **TAMPILAN** (chart, log) = **SEMUA** data CSV.
> - **FORMULA** (KPI, anomali, health, ranking) = jendela **2000 jam SMR terakhir**.
>   Badge *"2.000j"* menandai nilai yang dihitung dari jendela ini.

### 4.3 Unit Comparison (Perbandingan)
Dua sub-tab:
- **Peringkat Criticalitas** — skor 0–100 (Keparahan 45% + Bukti 30% + Tren 25%),
  Top 10, donut distribusi pilar, tabel lengkap.
- **Perbandingan per Parameter** — matrix parameter (baris) × Top 10 unit (kolom),
  nilai mentah, kolom Terbaik/Terburuk, ekspor CSV.
- **Overlay Unit vs Unit** — bandingkan tren parameter yang sama antar 2–5 unit.

### 4.4 Heatmap Unit
Tombol **Heatmap** di toolbar Home menampilkan matrix Unit × Parameter dengan
warna tingkat keparahan (merah = kritis).

---

## 5. Mode SOS (Analisa Oli)

Klik **SOS Lab** di header.

### 5.1 Katalog SOS — Status per Kompartemen
- **Kartu KPI:** Normal / Monitor / Critical / Extreme (% unit).
- **Tabel unit × kompartemen:** Prioritas (P1–P4), Status, Asset ID, Model,
  Kompartemen, HM Unit/Oil, nilai Fe/Cu/Si/PQI/V100, MPRS, Tanggal.
- **Sumber nilai parameter** (dropdown "Nilai parameter"):
  - **Sampel Terbaru** — nilai sampel terbaru (window 4000 jam).
  - **Rata-rata (window 4000 jam)** — rata-rata nilai pada window 4000 jam terakhir.
  - **Terburuk (window 4000 jam)** — nilai pada sampel dengan severity tertinggi pada window tersebut.

> Semua perhitungan level critical SOS (**Criticality**) memakai **window 4000 jam terakhir**
> (dihitung mundur dari kolom Meter/HM tertinggi). Bila HM kosong, sistem jatuh ke 5 sampel terakhir.

### 5.2 Detail Kompartemen
- Diagnostik & status per parameter oli.
- Chart tren parameter (kadar logam, sifat oli).
- Tabel riwayat sampel lengkap.

### 5.3 Heatmap SOS & Perbandingan Kompartemen
- **Heatmap:** Baris = kompartemen, kolom = parameter, warna = keparahan.
- **Perbandingan:** overlay tren parameter yang sama antar kompartemen (maks. 5).

### 5.4 Klasifikasi Tier SOS
| Tier | Label | Tindakan |
|---|---|---|
| 0 | NORMAL | Lanjutkan interval sampling normal |
| 1 | MONITOR | Pantau, cek tren pada sampel berikutnya |
| 2 | CRITICAL | Segera inspeksi, rencanakan perbaikan |
| 3 | EXTREME | Stop unit, perbaikan segera |

---

## 6. Cross Analysis (VHMS × SOS)

**Inti aplikasi ini** — mencari hubungan sebab-akibat antara gejala mekanikal
(telemetri) dan bukti kimia oli.

### 6.1 Cara Membuka
Klik **Cross Analysis** di header → klik **Analisa** pada baris unit.

### 6.2 Peta Unit Terhubung
Tabel unit yang terhubung VHMS ↔ SOS: Prioritas (P1–P3), unit, model, VHMS Health,
SOS Tier, Korelasi |r|, dan **Hipotesis Dominan**.

### 6.3 Empat Chart Analitik

| Chart | Fungsi |
|---|---|
| **Heatmap Korelasi** | Matrix parameter VHMS (baris) × SOS (kolom), warna = koefisien Pearson r. **Klik sel** → popup scatter + narasi. |
| **Timeline Gabungan** | 1 garis VHMS + beberapa titik sampel SOS pada sumbu HM/SMR. Lihat apakah bergerak bersamaan. |
| **Scatter Korelasi** | Sebaran titik + garis tren, untuk pasangan terpilih. |
| **Radar Profil Gabungan** | Profil keparahan per pilar VHMS vs cluster SOS (0–100). |

### 6.4 Heatmap Korelasi → Popup Scatter
Klik sel mana pun di heatmap → muncul **popup** berisi:
- **Chart scatter** + garis tren.
- **Statistik:** Pearson r, jumlah titik (n), basis normalisasi, kekuatan, tumpang-tindih.
- **Narasi penjelasan** dalam bahasa awam (arah hubungan, kepercayaan, hipotesis).
- **Tabel data mentah** VHMS vs SOS per titik.
- **Tombol Back** (panah kiri) untuk menutup.

### 6.5 Timeline Gabungan & Parameter SOS Multi
- **Sumbu-X** = HM/SMR (jam meter). Acuan ini paling akurat secara mekanikal.
- **Garis VHMS** = 1 parameter (pilih dari dropdown "Pasangan (VHMS)").
- **Titik SOS** = dapat memilih **beberapa parameter sekaligus** lewat
  tombol dropdown **"Parameter SOS (konfirmasi)"**.
  - Default: parameter pasangan + **Na (Sodium)** + **TBN**.
  - Bisa centang hingga 6 parameter. Tiap parameter punya **sumbu-Y sendiri**
    (Opsi multi-axis) agar satuan berbeda (ppm vs mgKOH/g) tetap terbaca.

### 6.6 Tabel Korelasi Dinamis ⭐
Di bawah chart Timeline ada **tabel R dinamis**:
- Menampilkan **Pearson r** antara parameter VHMS (garis) dengan **setiap
  parameter SOS** yang dipilih.
- **Nilai r berubah otomatis** saat Anda mengubah pilihan parameter SOS.
- Parameter dengan **|r| tertinggi** (≥ 0.5) diberi label **"penyebab dominan"**.
- Berguna untuk menjawab: *"Blowby tinggi ini karena Si, Na, atau TBN?"* —
  lihat mana yang paling berkorelasi.

> **Contoh interpretasi:** Blowby naik bisa karena pelumasan buruk. Ganti-ganti
> parameter SOS (Si = dirt, Na = coolant leak, TBN = aditif terkuras) dan lihat
> r mana yang paling kuat → itulah indikasi penyebab dominan pada unit tersebut.

### 6.7 Panduan Membaca Koefisien Korelasi (r)
| \|r\| | Kekuatan | Arti |
|---|---|---|
| ≥ 0.85 | Sangat Kuat | Hubungan sangat erat |
| 0.70–0.84 | Kuat | Indikasi kuat saling terkait |
| 0.50–0.69 | Moderat | Indikasi awal, perlu data tambahan |
| 0.30–0.49 | Lemah | Tafsir hati-hati |
| < 0.30 | Sangat Lemah | Kemungkinan tidak berhubungan |

- **r > 0** = searah (satu naik, satu naik).
- **r < 0** = berlawanan (satu naik, satu turun).
- **n < 4** titik → korelasi ditandai *tidak reliable* (r = n/a).

> ⚠️ **Korelasi ≠ sebab-akibat.** Gunakan sebagai indikasi awal bersama data
> mekanikal & riwayat unit.

---

## 7. Pengaturan: Tema & Threshold

Klik tombol **⚙️ Pengaturan** di header. Ada tiga sub-tab:

### 7.1 Tema
Sembilan tema tersedia, dikelompokkan menjadi **elegant dark**, **klasik**, dan **light**:

| Tema | Karakter |
|---|---|
| **Slate** (default) | Biru gelap klasik |
| **Obsidian** | Hitam matte + aksen champagne-gold (premium) |
| **Sapphire** | Biru royal + aksen sky cerah |
| **Plum Noir** | Ungu gelap + aksen rose |
| **Midnight** | Biru malam pekat + aksen indigo |
| **Carbon** | Hitam netral + aksen amber |
| **Forest** | Hijau tua + aksen lime |
| **Porcelain** | Terang bersih + aksen indigo |
| **Nordic Light** | Terang low-glare |

Klik kartu tema → langsung berubah & **tersimpan otomatis** di browser.

### 7.2 Threshold VHMS
Atur ambang batas per parameter telemetri:
- **Warn / Crit** — nilai batas peringatan & kritis.
- **Mode** — `high` (makin besar makin bahaya) atau `low` (makin kecil makin bahaya).
- **Label** — nama tampilan.

Tombol **Simpan VHMS** → langsung dipakai untuk deteksi anomali (data dimuat
ulang otomatis). Tombol **Reset VHMS** → kembali ke default.

### 7.3 Threshold SOS
Atur ambang batas per **kompartemen** (ENGINE, HYDRAULIC, TRANSMISSION, dst.):
- **Warn / Crit / Extreme** — batas naik (untuk logam keausan dll.).
- **Warn Low / Crit Low** — batas turun (untuk viskositas, TBN — makin rendah makin buruk).

Pilih kompartemen → ubah → **Simpan SOS** → **Reset SOS**.

> **Catatan:** Nilai default threshold berasal dari `js/vhms-config.js` &
> `js/sos-config.js`, tetapi **perubahan lewat UI disimpan di browser**
> (localStorage) dan menimpa default saat aplikasi dibuka. Untuk mengembalikan
> ke setelan pabrik, gunakan tombol Reset.

---

## 8. Membaca Interpretasi & Rekomendasi

### 8.1 Prioritas Unit (P-level)
| Level | Sumber | Tindakan |
|---|---|---|
| **P1** | VHMS CRITICAL / SOS Extreme-Critical | Tindak segera |
| **P2** | VHMS WARNING / SOS Monitor | Pantau & jadwalkan |
| **P3/P4** | Normal | Lanjutkan monitoring rutin |

Urutan prioritas ditentukan **status keparahan**; kekuatan korelasi hanya
menguatkan, tidak menurunkan urgensi.

### 8.2 Health Index (VHMS)
Skor 0–100 dari parameter dalam jendela formula. Label status:
`≥ 45` CRITICAL · `25–44` WARNING · `< 25` NORMAL (per unit).

### 8.3 Sisa Operasi (RUL)
Estimasi jam sebelum parameter mencapai batas kritis, berdasar laju degradasi
(tren). *"Stabil"* = tidak ada parameter yang diprediksi kritis.

---

## 9. Tips & Pemecahan Masalah

### Data belum muncul
- Pastikan file berformat **CSV ekspor VHMS** (blok `[Common Header]` + `[Data]`)
  atau ekspor **lab SOS** (kolom Lab No / Equipment ID / Component / Fe…).
- Cek toast notifikasi (kanan bawah) untuk pesan error/validasi.

### Cross Analysis bilang "unit SOS belum ada"
- Pastikan **SN VHMS** dan **Asset ID SOS** terhubung via **Database Unit**
  (SN → Nomor Lambung).
- Pastikan ada titik sampel SOS dengan **HM** yang **tumpang-tindih** dengan
  rentang SMR VHMS.

### Korelasi r = n/a
- Titik sampel terlalu sedikit (min 4), atau salah satu parameter **konstan**
  (tidak ada variasi) pada window ini. Tambah data / perluas window.

### Tema tidak tersimpan
- Browser mungkin memblokir localStorage (mode privat). Tema akan kembali ke
  default setiap sesi.

### Perubahan threshold tidak terasa
- Pastikan klik **Simpan**. Data akan dimuat ulang otomatis (butuh beberapa detik
  untuk armada besar).

---

## 10. Glosarium

| Istilah | Arti |
|---|---|
| **SMR / HM** | Service Meter Reading / Hour Meter — jam operasi unit |
| **VHMS** | Vehicle Health Monitoring System (telemetri Komatsu) |
| **SOS** | Scheduled Oil Sampling (analisa oli laboratorium) |
| **Blowby** | Kebocoran gas kompresi ke crankcase (indikator keausan mesin) |
| **TBN** | Total Base Number — cadangan aditif oli (turun = oli menua) |
| **MPRS** | Multi-Parameter Risk Score (skor risiko SOS) |
| **Severity** | Tingkat keparahan (seberapa jauh nilai melewati batas) |
| **Evidence** | Bukti (durasi pelanggaran batas) |
| **Trend** | Tren (laju perubahan vs SMR) |
| **Pearson r** | Koefisien korelasi linear (−1 s/d +1) |
| **RUL** | Remaining Useful Life — sisa umur pakai |
| **Threshold** | Ambang batas (warn/crit) |
| **Pilar** | Kelompok kompartemen (ENGINE/HYDRAULIC/COOLING/POWERTRAIN) |

---

*Untuk detail teknis arsitektur & kriteria ranking, lihat
[`KRITERIA_RANKING_CRITICAL.md`](KRITERIA_RANKING_CRITICAL.md) dan
[`../README.md`](../README.md).*

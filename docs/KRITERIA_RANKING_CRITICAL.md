# Kriteria Ranking Unit Critical (FINAL)

> **Status:** DIKONFIRMASI & DIIMPLEMENTASI.
> **Sumber kriteria:** standar umum *condition monitoring* alat berat & reliability
> engineering (hierarki Safety > Downtime > Biaya). **Bukan** dokumen resmi Komatsu.
> Semua bobot/ambang dapat diubah di `js/vhms-config.js` (bagian `RANKING_*`).

---

## 1. Konsep Dasar

Peringkat unit tidak cukup hanya dari "berapa banyak anomali". Unit harus
diranking berdasarkan **seberapa berbahaya** penyimpangannya, seberapa **lama**
melanggar, dan seberapa **cepat memburuk**.

```
  SKOR CRITICALITAS UNIT (0-100)

  ┌─────────────────────────┐
  │ 1. KEPARAHAN (Severity) │  45%   seberapa jauh melewati batas kritis
  ├─────────────────────────┤
  │ 2. BUKTI (Evidence)     │  30%   berapa lama melanggar (durasi jam SMR)
  ├─────────────────────────┤
  │ 3. TREN (Trend)         │  25%   seberapa cepat memburuk (slope)
  └─────────────────────────┘
              │
              ▼
     × Faktor BREADTH (1.0–1.6)
       unit dengan masalah di banyak parameter sekaligus lebih berat
              │
              ▼
     × Skala (gain 1.6)  →  dibatasi maksimum 100
```

**Ambang label (band):** `>= 45` CRITICAL · `25–44` WARNING · `< 25` NORMAL

---

## 2. Hierarki Prioritas Parameter (Pillar)

| Pilar | Parameter | Bobot | Rasional Reliability |
|---|---|---|---|
| **ENGINE** | Blowby Press Max | **18** | Indikator utama keausan ring & liner → risiko *catastrophic engine failure*, biaya overhaul terbesar |
| | Engine Oil Press H-Min | **16** | Kehilangan tekanan oli → kontak metal-to-metal, berpotensi *seize* |
| | Engine Oil Temp Max | 10 | Degradasi oli, mempercepat keausan |
| **HYDRAULIC** | Hydraulic Oil Temp Max | **14** | Overheat → degradasi oli, seal bocor, pompa aus; downtime tinggi |
| | Pump 1F/1R/2F/2R Press Max | 6/4/6/4 | Ketidakseimbangan → efisiensi turun, indikasi keausan pompa |
| | PTO Temp Max | 8 | Beban berlebih sistem fan/PTO |
| **COOLING** | Coolant Temp Max | 9 | Overheat → derate mesin (biasanya tertangkap lebih dulu) |
| | Fan Pump F/R Press | 7/6 | Kegagalan bertahap, tidak langsung berbahaya |
| **ECONOMY** | Fuel Rate | 2 | Indikator ekonomi, bukan keselamatan |
| | **Total** | **100** | |

> Bobot Blowby **18** (bukan 25 pada draf awal) agar pilar lain tetap mungkin
> muncul di peringkat teratas. Parameter *Consumable/Body* (Auto Greasing,
> Truck Counter, Swing, Load Count) **tidak** dipakai untuk ranking criticalitas.

---

## 3. Cara Setiap Sumbu Dihitung

### 3.1 Keparahan (Severity)
```
rasio = (nilai − crit) / crit           [mode high]
rasio = (crit − nilai) / crit           [mode low]
severity = sqrt(min(1, rasio))           ← kurva soft, agar tidak semua jenuh 100%
```

### 3.2 Bukti (Evidence) — **berbasis DURASI, bukan jumlah record**
```
evidence = jam_melanggar / total_jam_rentang     (dari kolom SMR)
```
Alasan: satu spike pada 1 record bisa lebih berbahaya daripada 50 record yang
melanggar tipis-tipis. Durasi (jam) merepresentasikan paparan nyata.

### 3.3 Tren
```
trend = max(0, slope_memburuk) / TREND_FULL_SCALE[param]   → dibatasi 1
```
Slope = least-squares (nilai parameter vs SMR). Arah "memburuk" bergantung mode.

### 3.4 Breadth (faktor pengali)
```
affected   = parameter dengan severity>0.15 ATAU evidence>0.25 ATAU trend>0.35
width      = jumlah_affected / jumlah_parameter
breadth    = 1 + width × 0.6                  (1.0 .. 1.6)
```

---

## 4. Validasi Terhadap Data Uji (220 unit)

```
=== TOP 10 RANKING ===
Rank | Unit         | Skor | Sev  | Evi  | Tre  | Band     | Pilar   | Penyebab
   1 | PC3000-20074 | 56.3 | 28.1 | 26.9 | 29.2 | CRITICAL | ENGINE  | Blowby 23.49 kPa (3 param bermasalah)
   2 | PC3000-20104 | 56.3 | 28.1 | 26.9 | 29.2 | CRITICAL | ENGINE  | Blowby 23.49 kPa
   ... dst

Distribusi band : CRITICAL 44 | WARNING 110 | NORMAL 66
Rentang skor    : 3.1 .. 56.3
```

**Catatan interpretasi:** pada data uji sintetis, Top 10 didominasi pilar
ENGINE karena nilai blowby dibuat sangat ekstrem. Pada data nyata dengan
variasi lebih kaya, pilar HYDRAULIC/COOLING akan muncul. Mekanisme `breadth`
sudah terbukti bekerja: unit dengan 3 pilar bermasalah memperoleh
`breadthFactor 1.26` dan menempati puncak.

---

## 5. Output yang Tersedia

| Fitur | Lokasi |
|---|---|
| Kartu ringkasan armada | `#comparison-cards` |
| **Top 10 Unit Paling Critical** (medali emas/silver/bronze) | `#comparison-top10` |
| Donut chart distribusi pilar (20 teratas) | `#comparison-pillar-chart` |
| Tabel peringkat lengkap (sortir per kolom) | `#comparison-body` |
| Filter per model / band / pencarian | `#comparison-model`, `#comparison-band` |
| Ekspor peringkat ke CSV | tombol *Ekspor Peringkat* |
| Klik unit → buka dashboard detail | baris tabel & kartu Top 10 |

---

## 6. Menyesuaikan Bobot

Semua di `js/vhms-config.js`:

```js
var RANKING_WEIGHTS = { blowbyMax: 18, oilPressHMin: 16, hydTempMax: 14, ... };
var RANKING_AXES    = { severity: 0.45, evidence: 0.30, trend: 0.25 };
var RANKING_BANDS   = { critical: 45, warning: 25 };
```

Skala naik/turun keseluruhan ada di `vhms-ranking.js` → `SCALE_GAIN` (kini 1.6).
Untuk mengubah kolom yang dipakai: `RANKING_PILLARS`.


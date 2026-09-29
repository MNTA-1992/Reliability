# Audit Formula & Logic Analytics — OMS-SOS Lab

> **Tanggal audit:** 2026-09-28
> **Cakupan:** `sos-analytics.js`, `vhms-ranking.js`, `vhms-cross.js`, `sos-config.js`,
> `vhms-config.js`, `sos-parser.js`, `vhms-parser.js`, `sos-store.js`, `vhms-fleet-store.js`
> **Metode:** pembacaan kode + pembandingan dengan `docs/KRITERIA_RANKING_CRITICAL.md`
> dan `README.md` + verifikasi angka nyata di browser (sample-data).
>
> Dokumen ini berisi: (A) daftar temuan bug & perbaikannya, (B) **rangkuman semua
> formula perhitungan** yang dipakai sistem, agar hasil data dapat ditelusuri.

---

## BAGIAN A — Temuan Audit

| # | Modul | Severity | Temuan | Status |
|---|-------|----------|--------|--------|
| A1 | `sos-config.js` | **Bug fungsional** | `getThresholdsFor()`/`getComponentWeight()` memakai pencocokan substring **satu arah** (`comp.indexOf(key)`). Akibatnya nama kompartemen yang lebih pendek dari kunci tidak cocok, contoh `"SWING"` TIDAK cocok dengan `"SWING DRIVE"` → jatuh ke FALLBACK (threshold FINAL DRIVE, Fe warn=100) padahal harus SWING DRIVE (Fe warn=80). | **DIPERBAIKI** |
| A2 | `vhms-render.js` | **Bug fungsional** | `HEALTH_ORDER[x] \|\| 2` (falsy-zero) membuat CRITICAL (nilai 0) dianggap paling ringan. Muncul di heatmap VHMS & sort engineCritical/healthScore. | **DIPERBAIKI** (helper `healthOrderOf`) |
| A3 | `sos-parser.js` | Bug laten | `parseInt()` tanggal tanpa radix. | **DIPERBAIKI** (radix 10) |
| A4 | `sos-config.js` + `sos-analytics.js` | **Inkonsistensi bobot** | `CRITICALITY.pillarWeights` hanya memuat 4 pilar. Kompartemen lain (SWING DRIVE/DIFFERENTIAL/STEERING, dll.) memakai `\|\| 1.0` padahal `COMPONENT_WEIGHTS` punya nilai. | **DIPERBAIKI** |
| A5 | `vhms-ranking.js` | Kalibrasi | `score = base × breadth × pillar × SCALE_GAIN(1.6)` mudah menembus 100 dan jenuh → unit terburuk tak bisa dibedakan. | **DIPERBAIKI** |
| A6 | Semua | Observasi | Pemetaan nama parameter berbeda antara dokumen & config (mis. dokumen "Engine Oil Temp Max" vs kunci `engOilTemp`). Tidak menyebabkan bug, tapi menyulitkan penelusuran. | Catatan saja |

### Detail A1 (bug yang diperbaiki)

**Sebelum:**
```js
function getThresholdsFor(component) {
  var comp = (component || '').toUpperCase();
  for (var key in THRESHOLDS) {
    if (comp.indexOf(key) !== -1) return THRESHOLDS[key];   // satu arah
  }
  return THRESHOLDS[THRESHOLD_FALLBACK];
}
```
**Sesudah:** pencocokan dua arah + pilih kunci terpanjang (paling spesifik),
via `matchComponentKey(component, keys)`.
**Bukti:** `"SWING"` kini → `SWING DRIVE` (Fe.warn=80), sebelumnya → FALLBACK (Fe.warn=100).
Kompartemen lain (`ENGINE`, `FINAL DRIVE`, …) tidak berubah → tanpa regresi.

### Detail A4 (perbaikan)
- `CRITICALITY.pillarWeights` dijadikan **alias ke `COMPONENT_WEIGHTS`** (11 kompartemen).
- `calcCriticality` memakai `cfg.getComponentWeight(component)` (pencocokan robust),
  bukan lagi lookup `pillarWeights[UPPER]`.
- **Bukti tidak ada regresi:** ENGINE/TRANSMISSION/FINAL DRIVE/HYDRAULIC nilainya
  IDENTIK (1.5/1.2/1.0/0.9) → skor unit data uji tidak berubah.
  Kompartemen baru kini benar: SWING DRIVE=0.9, DIFFERENTIAL=0.9, STEERING=0.8
  (sebelumnya 1.0).

### Detail A5 (perbaikan)
Dua perbaikan komplementer:
1. **Saturasi lunak di ujung atas** (`scoreUnit`): skor ≤ 90 TIDAK berubah;
   skor > 90 melunak asimtotik menuju 100 (tak pernah mentok):
   ```
   raw ≤ 90 : score = raw
   raw  > 90 : score = 90 + 10 × (raw−90) / ((raw−90) + 10)
   ```
   Kontinu di raw=90; band (critical 45 / warning 25) tidak terpengaruh.
2. **Tie-break deterministik** (`rankFleet`): bila dua unit berskor sama,
   urutkan dengan severity → evidence → trend → affectedCount → id.
- **Bukti:** unit D375A-65898 yang tadinya **100** kini **97.4** (band tetap
  CRITICAL); unit lain (26.2, 24.8, 11.9, …) tidak berubah.

---

## BAGIAN B — Rangkuman Semua Formula

### B.0 Aturan sumber data (berlaku global)
- **TAMPILAN**: seluruh data asli dari file yang di-upload (chart & log).
- **FORMULA**: hanya **N jam SMR terakhir** (`FORMULA_WINDOW_HOURS`).
  - VHMS: `FORMULA_WINDOW_HOURS = 2000` jam.
  - SOS (Criticality): `CRITICALITY.formulaWindowHours = 4000` jam (fallback 5 sampel).

### B.1 SOS — `sos-analytics.js`

#### 1) Severity per parameter `severityScore(value, th)`
Skala diskret 0/1/2/4 (mengikuti backend `criticality.py`):
```
Mode HIGH (makin besar makin buruk):
  value ≥ extreme → 4   ;  value ≥ crit → 2  ;  value ≥ warn → 1  ;  else 0
Mode LOW  (th.warn_low ada; makin kecil makin buruk):
  value ≤ crit_low → 4  ;  value ≤ warn_low → 2
  value ≥ crit_high → 4 ;  value ≥ warn_high → 2 ;  else 0
```

#### 2) Tier per sampel `evaluateSample`
```
tier = 3 (EXTREME) bila maxSeverity ≥ 4
     = 2 (CRITICAL) bila maxSeverity ≥ 2
     = 1 (MONITOR)  bila maxSeverity ≥ 1
     = 0 (NORMAL)   selainnya
```

#### 3) MPRS (Multi-Parameter Risk Score) `calcMPRS`
```
totalScore = Σ ( componentWeight × severityScore(param) )
breachCount = jumlah parameter dengan severity ≥ 1
compoundFactor = 3+ breach → 2.0 ; 2 breach → 1.5 ; else 1.0
MPRS = totalScore × compoundFactor

tier MPRS:
  MPRS ≥ 20 atau maxSev ≥ 4 → 3
  MPRS ≥ 10 atau maxSev ≥ 2 → 2
  MPRS ≥ 3  atau maxSev ≥ 1 → 1
Eskalasi: bila breachCount ≥ 2 DAN maxSev ≥ 2 → tier = 3
```
> Dihitung dari **sampel terbaru** (README §).

#### 4) ROW₁₀₀ (Rate of Wear per 100 jam) `calcROW100`
```
ROW100 = (metal_t2 − metal_t1) / (HM_t2 − HM_t1) × 100     [dHM > 0]
```
Dipakai untuk `wear_fe` pada sampel terbaru vs sebelumnya.

#### 5) Dirt Entry Index `calcDirtEntry`
```
DirtEntry = Si + Al
```

#### 6) Criticality Index `calcCriticality` (skor 0–100)
Window = **4000 jam terakhir** (fallback 5 sampel). **Severity dari sampel TERAKHIR**;
Evidence & Trend dari seluruh window.
```
Severity (45%):
  ratio = (v − crit) / crit        (per parameter, ambil maksimum)
  severityVal = min(max(ratio,0) × 100, 100)

Evidence (30%):
  abnormalCount = jumlah sampel window dengan tier ≥ 1
  evidenceVal   = abnormalCount / jumlah_sampel_window × 100

Trend (25%):
  trendVal = max atas {Fe, Cu, Al} dari ROW100(window_last, window_first)
  trendVal = min(trendVal × 2, 100)          // 50 ppm/100h dianggap 100%

rawScore = severityVal×0.45 + evidenceVal×0.30 + trendVal×0.25
score    = min(rawScore × pillarWeight, 100)
band     = CRITICAL (≥45) | WARNING (≥25) | NORMAL (<25)
```

#### 7) Window per jam `sliceByHours`
Urut kronologis (tanggal, tie-break HM), lalu akumulasi mundur delta HM
antar-sampel hingga melebihi `hours`. Bila delta HM tak tersedia → fallback
N sampel terakhir. → tahan terhadap lonjakan HM anomaly.

### B.2 VHMS — `vhms-ranking.js`

#### 1) Severity `severityScore` / `severityScoreSoft`
```
ratio = (value − crit) / |crit|   [high]  ; (crit − value)/|crit| [low]
raw   = clamp(ratio / SEVERITY_SATURATION, 0, 1)     // SATURATION = 1.0
soft  = sqrt(raw)                                    // kurva tak-jenuh
```

#### 2) Evidence `evidenceScore` (berbasis DURASI jam SMR)
```
violatingHours = Σ (SMR_i − SMR_{i−1}) untuk tiap record yang melanggar (≥ warn)
totalHours     = Σ (SMR_i − SMR_{i−1})  seluruh rentang
evidence       = clamp(violatingHours / totalHours, 0, 1)
```

#### 3) Trend `trendScore`
```
slope = least-squares(param vs SMR)          // butuh ≥ 4 titik
worsening = (mode low) ? −slope : slope
trend = clamp( worsening / TREND_FULL_SCALE[param], 0, 1 )
```

#### 4) Bobot efektif per parameter
```
effWeight = RANKING_WEIGHTS[key] × RANKING_PILLAR_WEIGHTS[pillar]
contribution = effWeight × (0.45·sev + 0.30·evi + 0.25·tre)
```

#### 5) Skor unit `scoreUnit`
```
Sumbu agregat (rata-rata berbobot):
  sevPct = Σ(weight·sev)/Σweight × 100   (idem evi, tre)
base = 0.45·sevPct + 0.30·eviPct + 0.25·trePct

Breadth:
  affected = param yang memenuhi (sev>0.15 OR evi>0.25 OR tre>0.35)
  width = jumlahAffected / jumlahParam
  breadthFactor = 1 + width × 0.6            // 1.0 .. 1.6

Pillar factor (dari parameter kontribusi tertinggi):
  pillarFactor = pw ≥ 1 ? (1 + (pw−1)×0.35) : pw

Skor akhir:
  score = min(base × breadthFactor × pillarFactor × SCALE_GAIN, 100)   // GAIN=1.6
  band  = CRITICAL (≥45) | WARNING (≥25) | NORMAL (<25)
```

#### 6) Ranking armada `rankFleet` / window
Skor memakai window `FORMULA_WINDOW_HOURS` (2000 jam) terakhir via `sliceWindow`.

### B.3 CROSS (VHMS × SOS) — `vhms-cross.js`

#### 1) Korelasi Pearson `pearson(xs, ys)`
```
r = (n·Σxy − Σx·Σy) / sqrt( (n·Σx²−(Σx)²) · (n·Σy²−(Σy)²) )     [n ≥ 3]
```
Bila denominator < 1e-12 → `r = null`.

#### 2) Normalisasi nilai ke 0..1 terhadap threshold
```
normVhms: high → (v−warn)/(crit−warn) clamp 0..1 ; low → (warn−v)/(warn−crit)
normSos : high → (v−warn)/(crit−warn)              ; low → (warn_low−v)/(warn_low−crit_low)
          nilai sehat → 0 (bukan null) agar sampel tidak terbuang
```

#### 3) Time-base `pickTimeBase` / `autoTimeBase`
Pilih sumbu `hm` (jam meter) dulu; bila titik valid < minimum → `date`
(epoch ms). Interpolasi VHMS→SOS sumbu via `interpVhms` (linear antar titik).

#### 4) Matching unit VHMS↔SOS `buildSosIndex` / `matchSos`
Indeks SOS memakai beberapa kunci: nomor lambung, asset_id, serial (dinormalisasi).
Pencarian: lambung → serial → (via Database Unit: SN→lambung).

### B.4 Parser (input ke formula)
- VHMS (`vhms-parser.js`): blok `[Common Header]` & `[Data]`; identitas dari
  *Machine Serial No.* & *Model*. SMR & Calendar dari baris data.
- SOS (`sos-parser.js`): deteksi baris header (Lab No / Equipment ID / Fe / Cu);
  tanggal DD/MM/YYYY atau ISO; HM Unit & HM Oil.

---

## C. Status Perbaikan

1. **A4 — DIERSI:** bobot pilar criticality kini memakai `COMPONENT_WEIGHTS`
   lengkap via `getComponentWeight()`. Tidak mengubah 4 pilar utama.
2. **A5 — DIERSI:** saturasi lunak (raw>90) + tie-break ranking. Tidak
   mengubah skor ≤ 90.
3. **A6 — Catatan:** konsistensi penamaan parameter antara dokumen & `*_config.js`
   (mis. "Engine Oil Temp Max" vs kunci `engOilTemp`). Tidak berdampak fungsional.

---

## D. Checklist Verifikasi (2026-09-28)

- [x] A1 `SWING` → `SWING DRIVE`; kompartemen lain tidak berubah
- [x] A4 4 pilar utama identik (1.5/1.2/1.0/0.9); pilar baru benar
- [x] A5 D375A-65898: 100 → 97.4 (band tetap CRITICAL); unit lain identik
- [x] A5 tie-break deterministik (unit skor sama tetap terurut)
- [x] SOS tanpa regresi (BDKM37132 score 93.2, tier 3)
- [x] Tampilan ranking/detail/heatmap tanpa error console

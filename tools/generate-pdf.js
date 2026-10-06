const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Dokumentasi Proyek: Reliability Based Maintenance (RBM) Dashboard</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm 18mm 16mm;
      @bottom-right {
        content: counter(page);
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #ffffff;
      line-height: 1.55;
      font-size: 11pt;
      margin: 0;
      padding: 0;
    }
    
    /* Cover Page */
    .cover-page {
      page-break-after: always;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 90vh;
      border-bottom: 3px solid #0284c7;
      padding-bottom: 40px;
    }
    .cover-badge {
      display: inline-block;
      background: #0284c7;
      color: #ffffff;
      font-weight: 700;
      font-size: 9pt;
      padding: 4px 12px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 20px;
      width: fit-content;
    }
    .cover-title {
      font-size: 26pt;
      font-weight: 800;
      color: #0f172a;
      line-height: 1.2;
      margin: 0 0 12px 0;
    }
    .cover-subtitle {
      font-size: 14pt;
      color: #475569;
      margin: 0 0 30px 0;
      font-weight: 400;
    }
    .cover-meta {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      font-size: 10pt;
      color: #64748b;
      display: grid;
      grid-template-columns: 140px 1fr;
      row-gap: 8px;
    }
    .cover-meta-label { font-weight: 600; color: #334155; }
    
    /* Typography & Layout */
    h1, h2, h3, h4 { color: #0f172a; font-weight: 700; }
    h1 {
      font-size: 17pt;
      border-bottom: 2px solid #0284c7;
      padding-bottom: 6px;
      margin-top: 32px;
      margin-bottom: 14px;
      page-break-after: avoid;
    }
    h2 {
      font-size: 13.5pt;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
      margin-top: 24px;
      margin-bottom: 10px;
      page-break-after: avoid;
    }
    h3 {
      font-size: 11.5pt;
      margin-top: 18px;
      margin-bottom: 6px;
      color: #0369a1;
      page-break-after: avoid;
    }
    p { margin: 0 0 10px 0; }
    
    /* Page Break Controls */
    .page-break { page-break-after: always; }
    .avoid-break { page-break-inside: avoid; }
    
    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0 18px 0;
      font-size: 9.5pt;
      page-break-inside: auto;
    }
    tr { page-break-inside: avoid; page-break-after: auto; }
    thead { display: table-header-group; }
    th {
      background: #f1f5f9;
      color: #0f172a;
      font-weight: 700;
      text-align: left;
      padding: 7px 10px;
      border: 1px solid #cbd5e1;
    }
    td {
      padding: 6px 10px;
      border: 1px solid #e2e8f0;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #f8fafc; }
    
    /* Formula & Code Boxes */
    .formula-box {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-left: 4px solid #0284c7;
      border-radius: 4px;
      padding: 10px 14px;
      margin: 10px 0 14px 0;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 9.5pt;
      color: #0f172a;
      page-break-inside: avoid;
    }
    .formula-title {
      font-weight: 700;
      color: #0369a1;
      margin-bottom: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    code {
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 9pt;
      background: #f1f5f9;
      color: #0369a1;
      padding: 1px 4px;
      border-radius: 3px;
    }
    
    /* Chips & Badges */
    .chip {
      display: inline-block;
      font-size: 8pt;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .chip-crit { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
    .chip-warn { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
    .chip-norm { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .chip-info { background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; }
    
    /* Notes & Alerts */
    .note-box {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 4px;
      padding: 10px 14px;
      margin: 12px 0;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    .note-title { font-weight: 700; color: #1d4ed8; margin-bottom: 4px; }

    /* TOC */
    .toc-item {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px dotted #cbd5e1;
      padding: 5px 0;
      font-size: 10pt;
    }
    .toc-item a { text-decoration: none; color: #1e293b; font-weight: 600; }
    .toc-item span { color: #64748b; }
  </style>
</head>
<body>

  <!-- COVER PAGE -->
  <div class="cover-page">
    <div class="cover-badge">Engineering Documentation &amp; Technical Manual</div>
    <div class="cover-title">RELIABILITY BASED MAINTENANCE (RBM)<br>ANALYTICS &amp; DIAGNOSTIC SYSTEM</div>
    <div class="cover-subtitle">Dokumentasi Komprehensif Arsitektur, Formula Statistik, Algoritma Korelasi, dan Logika Diagnostik Terintegrasi (VHMS Telemetri &times; SOS Lab)</div>
    
    <div class="cover-meta">
      <div class="cover-meta-label">Aplikasi:</div>
      <div>Reliability Based Maintenance Dashboard (VHMS &amp; SOS Intelligence)</div>
      <div class="cover-meta-label">Versi Sistem:</div>
      <div>v1.0 (Production Architecture - Release 2026)</div>
      <div class="cover-meta-label">Cakupan Modul:</div>
      <div>VHMS Analytics, SOS Lab Oil Sampling, Cross Analytics, Fleet Ranking, Lifetime &amp; Top-up Store</div>
      <div class="cover-meta-label">Tipe Dokumen:</div>
      <div>Spesifikasi Teknis &amp; Manual Formula Lengkap (PDF Edition)</div>
      <div class="cover-meta-label">Target Pengguna:</div>
      <div>Reliability Engineer, Maintenance Planner, Condition Monitoring Engineer, Mekanik &amp; Developer</div>
    </div>
  </div>

  <!-- DAFTAR ISI -->
  <h1>Daftar Isi</h1>
  <div class="toc-item"><span>1. PENDAHULUAN &amp; ARSITEKTUR SISTEM</span><span>Halaman 2</span></div>
  <div class="toc-item"><span>2. FORMULA &amp; LOGIKA MODUL SOS (OIL SAMPLING)</span><span>Halaman 3</span></div>
  <div class="toc-item"><span>3. FORMULA &amp; LOGIKA MODUL VHMS (TELEMETRI SENSOR)</span><span>Halaman 5</span></div>
  <div class="toc-item"><span>4. FORMULA &amp; LOGIKA MODUL CROSS ANALYTICS (VHMS &times; SOS)</span><span>Halaman 7</span></div>
  <div class="toc-item"><span>5. THRESHOLD &amp; MATRIKS KALIBRASI LENGKAP</span><span>Halaman 9</span></div>
  <div class="toc-item"><span>6. KNOWLEDGE BASE &amp; ADVICE MATRIX PREDIKTIF</span><span>Halaman 11</span></div>
  <div class="toc-item"><span>7. ALUR DATA, PARSER CSV, &amp; PANDUAN PENGGUNAAN</span><span>Halaman 12</span></div>

  <div class="page-break"></div>

  <!-- BAB 1 -->
  <h1>1. Pendahuluan &amp; Arsitektur Sistem</h1>
  <p>
    Sistem <strong>Reliability Based Maintenance (RBM)</strong> adalah platform analitik prediktif multi-tier yang menggabungkan dua sumber data utama keandalan alat berat:
  </p>
  <ul>
    <li><strong>Telemetri Sensor Operasional (VHMS/EHMS):</strong> Rekaman parameter kontinu seperti <em>Blowby Pressure</em>, temperatur oli/coolant, tekanan pompa hidrolik, dan tekanan oli mesin saat unit beroperasi di lapangan.</li>
    <li><strong>Laboratorium Oil Sampling (SOS Lab Web CAT/Komatsu):</strong> Rekaman periodik keausan metal (Fe, Cu, Al, Pb, Cr, dll.), kontaminan (Si, Al, H2O, Soot), dan sifat fisik fluida (Viscosity 100&deg;C, TBN).</li>
    <li><strong>Database Fleet &amp; Kompartemen:</strong> Integrasi pemetaan Nomor Lambung, Serial Number, Jam Operasi (SMR / Hour Meter), Lifetime Komponen, dan Top-Up oli.</li>
  </ul>

  <div class="note-box">
    <div class="note-title">Prinsip Arsitektur Data: Client-Side Native Performance</div>
    Seluruh kalkulasi korelasi Pearson, regresi linier OLS, interpolasi dual-axis, pembobotan pilar, dan normalisasi risiko dieksekusi secara <em>in-memory client-side</em> (vanilla JavaScript tanpa dependensi backend berat). Hal ini menjamin privasi data telemetri internal dan respons instan dashboard tanpa latensi jaringan.
  </div>

  <h2>Struktur Modul &amp; File Workspace</h2>
  <table>
    <thead>
      <tr>
        <th style="width:25%">File / Komponen</th>
        <th style="width:30%">Fungsi Utama</th>
        <th style="width:45%">Output &amp; Peran dalam Sistem</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>sos-config.js</code></td>
        <td>Standar threshold, bobot kompartemen, &amp; parameter wear/oil/clean.</td>
        <td>Menyediakan ambang batas multi-model (CAT &amp; Komatsu), bobot pilar kritis (Engine, Trans, Final Drive, dll.).</td>
      </tr>
      <tr>
        <td><code>sos-analytics.js</code></td>
        <td>Engine formula analitik fluida SOS.</td>
        <td>Menghitung MPRS, Severity Score, Rank Score, ROW100, Dirt Entry, &amp; Criticality Index (4000 jam).</td>
      </tr>
      <tr>
        <td><code>vhms-config.js</code></td>
        <td>Ambang batas parameter VHMS, bobot pilar, &amp; skala tren.</td>
        <td>Menentukan ambang batas High/Low, bobot risiko pilar (Safety &gt; Downtime &gt; Biaya), dan Full-Scale Slope.</td>
      </tr>
      <tr>
        <td><code>vhms-ranking.js</code></td>
        <td>Algoritma ranking armada &amp; criticality unit.</td>
        <td>Menghitung Severity (45%), Evidence durasi (30%), Trend (25%), Breadth Factor, dan Soft Saturation Curve.</td>
      </tr>
      <tr>
        <td><code>vhms-cross.js</code></td>
        <td>Mesin korelasi lintas VHMS &times; SOS.</td>
        <td>Interpolasi time-series, Pearson correlation ($r$), deteksi leading/lagging indicator, hipotesis kegagalan.</td>
      </tr>
      <tr>
        <td><code>vhms-cross-render.js</code></td>
        <td>Rendering visualisasi cross analysis.</td>
        <td>Scatter Plot Korelasi, Radar Profil Gabungan (Spider Web), Heatmap Korelasi, dan Matriks Data Mentah.</td>
      </tr>
      <tr>
        <td><code>sos-knowledge.js</code> &amp; <code>vhms-knowledge.js</code></td>
        <td>Knowledge base &amp; rule-based diagnostic.</td>
        <td>Memberikan diagnosa akar masalah (root cause) otomatis, level urgensi tindakan, dan SOP inspeksi lapangan.</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <!-- BAB 2 -->
  <h1>2. Formula &amp; Logika Modul SOS (Oil Sampling)</h1>
  <p>Modul SOS menganalisis sampel oli periodik untuk mendeteksi laju keausan mekanis, kontaminasi lingkungan, dan degradasi oli.</p>

  <h2>2.1 Severity Score Parameter: $S(v) \in \{0, 1, 2, 4\}$</h2>
  <p>Setiap parameter uji oli dievaluasi terhadap ambang batas diskret (skala berbobot kuadratik untuk mengisolasi kondisi ekstrem):</p>
  
  <div class="formula-box">
    <div class="formula-title">Mode High-is-Worse (Metal Keausan &amp; Kontaminan: Fe, Cu, Al, Si, Soot, Na, dll.):</div>
    S(v) = 4, &nbsp; jika v &ge; Extreme &rarr; Critical<br>
    S(v) = 2, &nbsp; jika Extreme &gt; v &ge; Critical &rarr; Critical<br>
    S(v) = 1, &nbsp; jika Critical &gt; v &ge; Warn &rarr; Caution<br>
    S(v) = 0, &nbsp; jika v &lt; Warn (Normal Sehat)
  </div>

  <div class="formula-box">
    <div class="formula-title">Mode Low-is-Worse / Dual-Band (Viscosity 100&deg;C &amp; TBN):</div>
    S(v) = 2, &nbsp; jika v &le; Crit_Low &nbsp;ATAU&nbsp; v &ge; Crit_High &rarr; Critical<br>
    S(v) = 1, &nbsp; jika v &le; Warn_Low &nbsp;ATAU&nbsp; v &ge; Warn_High &rarr; Caution<br>
    S(v) = 0, &nbsp; selainnya (Nilai dalam rentang aman)
  </div>

  <p><strong>Standarisasi 2026-10-03:</strong> 3 level status sesuai SOP &mdash;
  Normal / Caution (SLA 2&times;24 Jam) / Critical (SLA 1&times;24 Jam).</p>

  <h2>2.2 Multi-Parameter Risk Score (MPRS) &amp; Escalation Rule</h2>
  <p>MPRS mengukur risiko gabungan pada satu sampel dengan memperhitungkan interaksi multi-parameter abnormal (compound effect):</p>

  <div class="formula-box">
    <div class="formula-title">Kalkulasi MPRS:</div>
    TotalScore = &sum; [ W_kompartemen &times; S(parameter_i) ]<br>
    BreachCount = Jumlah parameter dengan S(v) &ge; 1<br>
    CompoundFactor = 2.0 (jika BreachCount &ge; 3); 1.5 (jika BreachCount = 2); 1.0 (jika BreachCount &le; 1)<br>
    <strong>MPRS = TotalScore &times; CompoundFactor</strong>
  </div>

  <div class="formula-box">
    <div class="formula-title">Penetapan Tier MPRS (3 Level) &amp; Aturan Eskalasi:</div>
    &bull; Tier 2 (CRITICAL / Merah): MPRS &ge; 20 ATAU MaxSeverity &ge; 2<br>
    &bull; Tier 1 (CAUTION / Amber): MPRS &ge; 3 ATAU MaxSeverity &ge; 1<br>
    &bull; Tier 0 (NORMAL / Hijau): Selainnya<br>
    <strong>Aturan Eskalasi Khusus:</strong> Jika BreachCount &ge; 2 DAN MaxSeverity &ge; 2, Tier otomatis dinaikkan ke Tier 2 (CRITICAL).
  </div>

  <h2>2.3 Rate of Wear per 100 Jam ($ROW_{100}$)</h2>
  <p>Menghilangkan bias perbedaan interval penggantian oli dengan mengonversi kenaikan metal ke laju per 100 jam operasi:</p>
  <div class="formula-box">
    <div class="formula-title">Formula ROW100:</div>
    ROW_{100} = &lfloor; (Metal_{t2} - Metal_{t1}) / (HM_{t2} - HM_{t1}) &rfloor; &times; 100 &nbsp; (ppm / 100 jam SMR)
  </div>

  <h2>2.4 Dirt Entry Index</h2>
  <div class="formula-box">
    <div class="formula-title">Formula Dirt Entry:</div>
    DirtEntry = Si (ppm) + Al (ppm)<br>
    <em>Interpretasi: Rasio Si:Al sekitar 2:1 hingga 3:1 mengonfirmasi kebocoran udara masuk (air intake leak) atau debu tambang (silica/alumina).</em>
  </div>

  <div class="page-break"></div>

  <h2>2.5 Criticality Index SOS (Jendela 4000 Jam SMR)</h2>
  <p>Criticality Index SOS memberikan evaluasi jangka panjang (0–100) berbasis 3 pilar analytics:</p>

  <div class="formula-box">
    <div class="formula-title">1. Keparahan / Severity (Bobot 45%):</div>
    Dihitung dari sampel TERAKHIR pada jendela 4000 jam:<br>
    Ratio_i = (Nilai_i - Crit_i) / Crit_i &nbsp; (diambil rasio maksimum di antara semua parameter)<br>
    SeverityVal = Clamp(Ratio_{max} &times; 100, 0, 100)
  </div>

  <div class="formula-box">
    <div class="formula-title">2. Bukti / Evidence (Bobot 30%):</div>
    Konsistensi riwayat abnormal pada seluruh sampel dalam jendela 4000 jam:<br>
    AbnormalCount = Jumlah sampel dalam jendela dengan Tier &ge; 1<br>
    EvidenceVal = (AbnormalCount / TotalSampelJendela) &times; 100
  </div>

  <div class="formula-box">
    <div class="formula-title">3. Tren / Trend (Bobot 25%):</div>
    Laju perburukan metal wear utama {Fe, Cu, Al} antara sampel terawal dan terakhir di jendela 4000 jam:<br>
    MaxROW = Max( ROW_{100}(Fe), ROW_{100}(Cu), ROW_{100}(Al) )<br>
    TrendVal = Clamp(MaxROW &times; 2, 0, 100) &nbsp; [Catatan: laju 50 ppm/100h setara 100% tren maksimal]
  </div>

  <div class="formula-box">
    <div class="formula-title">Skor Akhir Criticality SOS:</div>
    RawScore = (SeverityVal &times; 0.45) + (EvidenceVal &times; 0.30) + (TrendVal &times; 0.25)<br>
    CriticalityScore = Min(RawScore &times; W_kompartemen, 100)<br>
    <strong>Status Band:</strong> CRITICAL (&ge; 45) | WARNING (25 &ndash; 44) | NORMAL (&lt; 25)
  </div>

  <div class="page-break"></div>

  <!-- BAB 3 -->
  <h1>3. Formula &amp; Logika Modul VHMS (Telemetri Sensor)</h1>
  <p>Modul VHMS memproses ribuan titik telemetri operasional per unit untuk menentukan status kesehatan mesin secara obyektif.</p>

  <h2>3.1 Tiga Pilar Penilaian Unit VHMS (0–100)</h2>
  <table>
    <thead>
      <tr>
        <th style="width:20%">Pilar Penilaian</th>
        <th style="width:15%">Bobot</th>
        <th style="width:30%">Dasar Perhitungan</th>
        <th style="width:35%">Rasional Engineering</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>1. Severity (Keparahan)</strong></td>
        <td><strong>45%</strong></td>
        <td>$\text{SoftSeverity} = \sqrt{\text{Clamp}\left(\frac{v - \text{crit}}{|\text{crit}|}, 0, 1\right)}$</td>
        <td>Menggunakan kurva akar halus (<em>soft root curve</em>) agar nilai parameter yang tinggi tidak langsung jenuh (saturate) di 100%.</td>
      </tr>
      <tr>
        <td><strong>2. Evidence (Bukti Durasi)</strong></td>
        <td><strong>30%</strong></td>
        <td>$\text{Evidence} = \frac{\sum \Delta \text{SMR}_{\text{violating}}}{\sum \Delta \text{SMR}_{\text{total}}}$</td>
        <td><strong>Berbasis durasi jam SMR</strong>, bukan jumlah baris data. 10 jam operasi pada kondisi overheat jauh lebih merusak dibanding 1 lonjakan sesaat.</td>
      </tr>
      <tr>
        <td><strong>3. Trend (Laju Perburukan)</strong></td>
        <td><strong>25%</strong></td>
        <td>$\text{Trend} = \text{Clamp}\left(\frac{\text{Slope}_{\text{OLS}}}{\text{FullScale}}, 0, 1\right)$</td>
        <td>Menggunakan Ordinary Least Squares (OLS) regresi linier parameter vs SMR untuk mendeteksi percepatan degradasi.</td>
      </tr>
    </tbody>
  </table>

  <h2>3.2 Bobot Parameter &amp; Hierarki Pilar VHMS</h2>
  <table>
    <thead>
      <tr>
        <th>Pilar Utama</th>
        <th>Bobot Pilar</th>
        <th>Parameter Kunci</th>
        <th>Bobot Param</th>
        <th>Rasional Reliability</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td rowspan="3"><strong>ENGINE</strong></td>
        <td rowspan="3"><strong>1.5</strong></td>
        <td>Blowby Press Max</td>
        <td><strong>18</strong></td>
        <td>Keausan ring &amp; cylinder liner &rarr; risiko catastrophic failure terbesar.</td>
      </tr>
      <tr>
        <td>Engine Oil Press H-Min</td>
        <td><strong>16</strong></td>
        <td>Tekanan oli rendah saat RPM tinggi &rarr; kontak metal-to-metal (seize).</td>
      </tr>
      <tr>
        <td>Engine Oil Temp Max</td>
        <td>10</td>
        <td>Degradasi termal pelumas &amp; percepatan oksidasi.</td>
      </tr>
      <tr>
        <td rowspan="3"><strong>HYDRAULIC</strong></td>
        <td rowspan="3"><strong>1.2</strong></td>
        <td>Hyd Oil Temp Max</td>
        <td><strong>14</strong></td>
        <td>Overheating oli hidrolik &rarr; seal mengeras, kebocoran internal, pompa aus.</td>
      </tr>
      <tr>
        <td>Pump 1F/1R/2F/2R Press</td>
        <td>6 / 4 / 6 / 4</td>
        <td>Keseimbangan beban &amp; efisiensi volumetrik pompa hidrolik utama.</td>
      </tr>
      <tr>
        <td>PTO Temp Max</td>
        <td>8</td>
        <td>Beban termal power take-off &amp; fan drive system.</td>
      </tr>
      <tr>
        <td rowspan="2"><strong>COOLING</strong></td>
        <td rowspan="2"><strong>1.0</strong></td>
        <td>Coolant Temp Max</td>
        <td>9</td>
        <td>Overheat sistem pendingin &rarr; engine auto-derate.</td>
      </tr>
      <tr>
        <td>Fan Pump F/R Press</td>
        <td>7 / 6</td>
        <td>Kinerja putaran kipas radiator &amp; pendingin hidrolik.</td>
      </tr>
      <tr>
        <td><strong>ECONOMY</strong></td>
        <td><strong>0.5</strong></td>
        <td>Fuel Rate L/H</td>
        <td>2</td>
        <td>Indikator efisiensi pembakaran (tidak mengancam integritas mekanis).</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <h2>3.3 Formula Skor Akhir Unit &amp; Soft Saturation Curve</h2>
  <div class="formula-box">
    <div class="formula-title">1. Base Aggregated Score:</div>
    Sev_{pct} = \frac{\sum (W_i \times \text{Sev}_i)}{\sum W_i} \times 100, &nbsp; \text{Evi}_{pct} = \frac{\sum (W_i \times \text{Evi}_i)}{\sum W_i} \times 100, &nbsp; \text{Tre}_{pct} = \frac{\sum (W_i \times \text{Tre}_i)}{\sum W_i} \times 100<br>
    <strong>BaseScore = (0.45 &times; Sev_{pct}) + (0.30 &times; Evi_{pct}) + (0.25 &times; Tre_{pct})</strong>
  </div>

  <div class="formula-box">
    <div class="formula-title">2. Faktor Breadth (Penyebaran Anomali Multi-Sistem):</div>
    AffectedParams = Parameter dengan (Sev &gt; 0.15 &nbsp;ATAU&nbsp; Evi &gt; 0.25 &nbsp;ATAU&nbsp; Tre &gt; 0.35)<br>
    Width = JumlahAffected / TotalParameter<br>
    <strong>BreadthFactor = 1.0 + (Width &times; 0.6)</strong> &nbsp; [Rentang: 1.0 s/d 1.6]
  </div>

  <div class="formula-box">
    <div class="formula-title">3. Faktor Pilar Terburuk (Dominant Pillar Factor):</div>
    Diambil dari pilar dengan kontribusi anomali tertinggi ($PW$):<br>
    PillarFactor = 1.0 + (PW - 1.0) &times; 0.35 &nbsp; (jika $PW \ge 1.0$); selainnya $PW$.
  </div>

  <div class="formula-box">
    <div class="formula-title">4. Pengali Skala &amp; Asymptotic Soft Saturation (Anti-Saturasi):</div>
    RawScore = BaseScore &times; BreadthFactor &times; PillarFactor &times; 1.6 (Scale Gain)<br><br>
    <strong>Jika RawScore &le; 90:</strong><br>
    &nbsp;&nbsp;&nbsp;&nbsp;FinalScore = RawScore<br>
    <strong>Jika RawScore &gt; 90:</strong><br>
    &nbsp;&nbsp;&nbsp;&nbsp;FinalScore = 90 + 10 &times; &lfloor; (RawScore - 90) / ((RawScore - 90) + 10) &rfloor;<br>
    <em>Hasil: Skor ekstrem mendekati 100 secara asimtotik (mis. 97.4 vs 95.8) sehingga unit terburuk dalam armada tetap dapat dibedakan peringkatnya dengan tegas tanpa terpotong batas kaku.</em>
  </div>

  <h2>3.4 Rolling Window 2000 Jam SMR &amp; Deterministic Tie-Breaking</h2>
  <ul>
    <li><strong>Rolling Window 2000 Jam:</strong> Perhitungan VHMS hanya memproses data mundur maksimal 2000 jam operasi dari SMR terakhir unit. Hal ini mencegah anomali masa lampau yang sudah diperbaiki mempengaruhi peringkat saat ini.</li>
    <li><strong>Deterministic Tie-Breaker:</strong> Jika dua unit memiliki skor identik, urutan ditentukan berturut-turut oleh: (1) Nilai Severity, (2) Nilai Evidence, (3) Nilai Trend, (4) Jumlah parameter terdampak, (5) Unit ID.</li>
  </ul>

  <div class="page-break"></div>

  <!-- BAB 4 -->
  <h1>4. Formula &amp; Logika Modul Cross Analytics (VHMS &times; SOS)</h1>
  <p>Modul Cross Analytics menyatukan data kontinu telemetri sensor dengan hasil uji laboratorium oli untuk membuktikan korelasi sebab-akibat (root cause verification).</p>

  <h2>4.1 Korelasi Pearson ($r$) pada Data Terinterpolasi</h2>
  <div class="formula-box">
    <div class="formula-title">Koefisien Korelasi Pearson (r):</div>
    r = \frac{n \sum (x_i y_i) - (\sum x_i)(\sum y_i)}{\sqrt{ [n \sum x_i^2 - (\sum x_i)^2] [n \sum y_i^2 - (\sum y_i)^2] }}<br><br>
    Kriteria Kekuatan Hubungan ($|r|$):<br>
    &bull; <strong>|r| &ge; 0.70:</strong> Korelasi KUAT (Konfirmasi kausalitas tinggi antara gejala sensor &amp; keausan partikel oli).<br>
    &bull; <strong>0.40 &le; |r| &lt; 0.70:</strong> Korelasi MODERAT (Indikasi awal kegagalan berkembang).<br>
    &bull; <strong>|r| &lt; 0.40:</strong> Korelasi LEMAH / Tidak Signifikan.
  </div>

  <h2>4.2 Sumbu Waktu Dual-Axis &amp; Interpolasi Linier</h2>
  <p>Karena frekuensi perekaman data VHMS (harian/per shift) jauh lebih padat dibanding sampel SOS (tiap 250/500 jam), sistem melakukan interpolasi linier nilai VHMS pada titik jam operasi (SMR/HM) tepat saat sampel SOS diambil:</p>
  <div class="formula-box">
    <div class="formula-title">Interpolasi Linier VHMS ke Titik Sampel SOS:</div>
    VHMS(HM_{sos}) = V_1 + (V_2 - V_1) &times; \frac{HM_{sos} - HM_1}{HM_2 - HM_1}
  </div>

  <h2>4.3 Normalisasi Skala Radar Profil Gabungan (Spider Web)</h2>
  <p>Kedua sumber data dinormalisasi ke skala seragam $0 \dots 100\%$ untuk dirender pada Radar Profil Gabungan 8 sumbu:</p>
  <div class="formula-box">
    <div class="formula-title">1. Sumbu Pilar VHMS (ENGINE, HYDRAULIC, COOLING, POWERTRAIN, BRAKE):</div>
    NormVHMS = Clamp\left( \frac{Nilai - Warn}{Crit - Warn}, 0, 1 \right) &times; 100\%
  </div>
  <div class="formula-box">
    <div class="formula-title">2. Sumbu Cluster SOS (SOS Wear, SOS Oil, SOS Clean):</div>
    NormSOS = Rata-rata dari \left[ Clamp\left( \frac{Nilai_{param} - Warn_{param}}{Crit_{param} - Warn_{param}}, 0, 1 \right) &times; 100\% \right] per kelompok cluster.
  </div>

  <h2>4.4 Matriks Pasangan Parameter Terkurasi (Leading &amp; Lagging)</h2>
  <table>
    <thead>
      <tr>
        <th>Leading Indicator (VHMS)</th>
        <th>Lagging Indicator (SOS)</th>
        <th>Hipotesis Mekanikal &amp; Gejala Kerusakan</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>Blowby Press Max &uarr;</strong></td>
        <td><strong>Soot &uarr;, Fe &uarr;, Viscosity &uarr;</strong></td>
        <td>Kebocoran gas ruang bakar melintasi piston ring &rarr; kontaminasi jelaga (soot) pada oli karter &rarr; pengentalan oli &amp; keausan liner (Fe).</td>
      </tr>
      <tr>
        <td><strong>Coolant Temp Max &uarr;</strong></td>
        <td><strong>Sodium (Na) &uarr;, Potassium (K) &uarr;</strong></td>
        <td>Overheating mesin memicu keretakan head gasket atau kebocoran oil cooler &rarr; rembesan glycol/coolant ke karter.</td>
      </tr>
      <tr>
        <td><strong>Eng Oil Press H-Min &darr;</strong></td>
        <td><strong>Cu &uarr;, Pb &uarr;, Sn &uarr;</strong></td>
        <td>Tekanan oli rendah pada RPM tinggi menyebabkan hilangnya hydrodynamic oil film pada main/conrod bearing &rarr; keausan lapisan bearing (tembaga/timbal).</td>
      </tr>
      <tr>
        <td><strong>Hyd Oil Temp Max &uarr;</strong></td>
        <td><strong>Cu &uarr;, Fe &uarr;, Viscosity &darr;</strong></td>
        <td>Overheating oli hidrolik menurunkan viskositas &rarr; metal contact pada slipper pad &amp; barrel pompa piston hidrolik.</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <!-- BAB 5 -->
  <h1>5. Threshold &amp; Matriks Kalibrasi Lengkap</h1>
  <p>Tabel acuan ambang batas resmi yang diimplementasikan pada sistem RBM.</p>

  <h2>5.1 Threshold Parameter VHMS</h2>
  <table>
    <thead>
      <tr>
        <th>Parameter Sensor</th>
        <th>Satuan</th>
        <th>Mode</th>
        <th>Warning</th>
        <th>Critical</th>
        <th>Extreme</th>
        <th>Deskripsi Kondisi</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Blowby Press Max</td>
        <td>kPa</td>
        <td>HIGH</td>
        <td>2.0</td>
        <td>3.0</td>
        <td>4.5</td>
        <td>Tekanan ruang engkol (karter).</td>
      </tr>
      <tr>
        <td>Engine Oil Press H-Min</td>
        <td>MPa</td>
        <td>LOW</td>
        <td>0.25</td>
        <td>0.20</td>
        <td>0.15</td>
        <td>Tekanan pelumasan utama pada High RPM.</td>
      </tr>
      <tr>
        <td>Engine Oil Temp Max</td>
        <td>&deg;C</td>
        <td>HIGH</td>
        <td>110</td>
        <td>120</td>
        <td>130</td>
        <td>Temperatur oli pelumas karter.</td>
      </tr>
      <tr>
        <td>Coolant Temp Max</td>
        <td>&deg;C</td>
        <td>HIGH</td>
        <td>95</td>
        <td>102</td>
        <td>108</td>
        <td>Temperatur air pendingin radiator.</td>
      </tr>
      <tr>
        <td>Hyd Oil Temp Max</td>
        <td>&deg;C</td>
        <td>HIGH</td>
        <td>85</td>
        <td>95</td>
        <td>105</td>
        <td>Temperatur tangki oli hidrolik.</td>
      </tr>
      <tr>
        <td>Pump 1F/2F Press Max</td>
        <td>MPa</td>
        <td>HIGH</td>
        <td>32.0</td>
        <td>35.0</td>
        <td>38.0</td>
        <td>Tekanan pelepasan pompa hidrolik depan.</td>
      </tr>
      <tr>
        <td>PTO Temp Max</td>
        <td>&deg;C</td>
        <td>HIGH</td>
        <td>90</td>
        <td>100</td>
        <td>110</td>
        <td>Temperatur pelumas Power Take-Off.</td>
      </tr>
    </tbody>
  </table>

  <h2>5.2 Threshold Parameter SOS per Kompartemen</h2>
  <table>
    <thead>
      <tr>
        <th>Kompartemen</th>
        <th>Fe (Warn/Crit/Ext)</th>
        <th>Cu (Warn/Crit/Ext)</th>
        <th>Al (Warn/Crit/Ext)</th>
        <th>Si (Warn/Crit/Ext)</th>
        <th>Soot %</th>
        <th>H2O %</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>ENGINE</strong></td>
        <td>80 / 150 / 250</td>
        <td>25 / 50 / 80</td>
        <td>20 / 40 / 60</td>
        <td>15 / 25 / 40</td>
        <td>1.5 / 2.5 / 3.5</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
      <tr>
        <td><strong>TRANSMISSION</strong></td>
        <td>50 / 100 / 180</td>
        <td>50 / 100 / 150</td>
        <td>20 / 40 / 60</td>
        <td>20 / 35 / 50</td>
        <td>&mdash;</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
      <tr>
        <td><strong>FINAL DRIVE</strong></td>
        <td>100 / 200 / 350</td>
        <td>20 / 40 / 70</td>
        <td>20 / 40 / 60</td>
        <td>25 / 45 / 70</td>
        <td>&mdash;</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
      <tr>
        <td><strong>HYDRAULIC</strong></td>
        <td>30 / 60 / 100</td>
        <td>20 / 40 / 70</td>
        <td>15 / 30 / 50</td>
        <td>15 / 25 / 40</td>
        <td>&mdash;</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
      <tr>
        <td><strong>SWING DRIVE</strong></td>
        <td>80 / 160 / 280</td>
        <td>25 / 50 / 80</td>
        <td>20 / 40 / 60</td>
        <td>20 / 35 / 55</td>
        <td>&mdash;</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
      <tr>
        <td><strong>DIFFERENTIAL</strong></td>
        <td>90 / 180 / 300</td>
        <td>25 / 50 / 80</td>
        <td>20 / 40 / 60</td>
        <td>20 / 35 / 55</td>
        <td>&mdash;</td>
        <td>0.2 / 0.5 / 1.0</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <!-- BAB 6 -->
  <h1>6. Knowledge Base &amp; Advice Matrix Prediktif</h1>
  <p>Sistem secara otomatis menghasilkan rekomendasi tindakan korektif mekanik berdasarkan pola anomali yang terdeteksi.</p>

  <table>
    <thead>
      <tr>
        <th style="width:18%">Pola Kegagalan</th>
        <th style="width:20%">Kondisi Pemicu</th>
        <th style="width:15%">Tingkat Urgensi</th>
        <th style="width:47%">Instruksi &amp; Prosedur Tindakan Mekanik</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>Piston Ring / Liner Wear</strong></td>
        <td>Blowby Press &ge; 3.0 kPa DAN/ATAU Soot &gt; 2.0%</td>
        <td><span class="chip chip-crit">EMERGENCY (24 Jam)</span></td>
        <td>1. Lakukan tes kompresi silinder &amp; borescope inspection.<br>2. Periksa jalur blowby filter &amp; draft tube dari penyumbatan.<br>3. Jadwalkan top overhaul / ganti ring set sebelum piston macet.</td>
      </tr>
      <tr>
        <td><strong>Bearing Degradation</strong></td>
        <td>Cu &ge; 50 ppm, Pb &ge; 30 ppm, Oil Press &le; 0.20 MPa</td>
        <td><span class="chip chip-crit">STOP UNIT Segera</span></td>
        <td>1. Jangan operasikan mesin pada high load.<br>2. Buka karter oli, potong dan periksa filter oli dari serpihan tembaga.<br>3. Inspeksi ketebalan main &amp; conrod bearing clearance.</td>
      </tr>
      <tr>
        <td><strong>Coolant Contamination</strong></td>
        <td>Na &gt; 50 ppm, K &gt; 40 ppm, Water &gt; 0.2%</td>
        <td><span class="chip chip-warn">URGENT (48 Jam)</span></td>
        <td>1. Lakukan pressure test sistem pendingin radiator.<br>2. Periksa kebocoran internal oil cooler &amp; cylinder head gasket.<br>3. Ganti oli karter total setelah kebocoran tertangani.</td>
      </tr>
      <tr>
        <td><strong>Air Induction Leak (Dust)</strong></td>
        <td>Si &gt; 25 ppm, Al &gt; 20 ppm (Dirt Entry &gt; 45)</td>
        <td><span class="chip chip-warn">URGENT (48 Jam)</span></td>
        <td>1. Periksa kekencangan clamp intake hose &amp; ducting dari turbocharger.<br>2. Uji smoke test / visual check kebersihan filter udara primer &amp; sekunder.<br>3. Periksa intake manifold gasket dari kebocoran udara kotor.</td>
      </tr>
      <tr>
        <td><strong>Hydraulic Pump Cavitation</strong></td>
        <td>Hyd Temp &gt; 95&deg;C, Pump Press Unbalanced &gt; 15%</td>
        <td><span class="chip chip-warn">MEDIUM (1 Minggu)</span></td>
        <td>1. Bersihkan suction strainer tangki hidrolik.<br>2. Periksa kerja fan cooler hidrolik &amp; sensor tekanan pilot.<br>3. Lakukan flow meter test pada pompa piston hidrolik.</td>
      </tr>
    </tbody>
  </table>

  <!-- BAB 7 -->
  <h1>7. Alur Data, Parser CSV, &amp; Panduan Penggunaan</h1>
  <h2>7.1 Spesifikasi Input CSV</h2>
  <ul>
    <li><strong>File Telemetri VHMS/EHMS:</strong> Format CSV standar Komatsu (misal <code>BDKM37132.csv</code>, <code>OMS_65898.CSV</code>). Kolom wajib: <code>Date</code>, <code>SMR</code> (Hour Meter), dan parameter sensor (<code>Blowby Press Max</code>, <code>Coolant Temp Max</code>, dll.).</li>
    <li><strong>File Laboratorium SOS:</strong> Format CSV Web CAT / Wear Check (misal <code>Template SOS_Download Web CAT.csv</code>). Kolom wajib: <code>Unit No / Asset ID</code>, <code>Component</code>, <code>Sample Date</code>, <code>Meter Reading</code>, <code>Fe</code>, <code>Cu</code>, <code>Al</code>, <code>Si</code>, <code>Viscosity</code>, <code>Soot</code>, <code>Water</code>.</li>
    <li><strong>Database Nomor Lambung:</strong> File mapping (<code>Template-DB Nomor Lambung_EHMS.csv</code>) untuk menghubungkan Serial Number pabrikan ke kode nomor lambung tambang.</li>
  </ul>

  <h2>7.2 Langkah Pengoperasian Dashboard</h2>
  <ol>
    <li>Buka dashboard pada peramban web (Chrome / Edge).</li>
    <li>Upload file telemetri VHMS melalui panel <em>Upload Data VHMS</em> (bisa multi-file / multi-unit).</li>
    <li>Upload file hasil uji lab SOS melalui panel <em>Upload Data SOS</em>.</li>
    <li>Sistem secara instan memproses kalkulasi peringkat <strong>Fleet Ranking</strong> dan <strong>Criticality Index</strong>.</li>
    <li>Klik pada baris unit untuk membuka menu <strong>Cross Analysis Detail</strong>:
      <ul>
        <li><strong>Scatter Korelasi:</strong> Menampilkan korelasi kausal parameter pilihan dengan garis regresi Pearson ($r$).</li>
        <li><strong>Radar Profil Gabungan:</strong> Membandingkan profil keparahan pilar VHMS vs klaster SOS dalam satu bidang 360&deg;.</li>
        <li><strong>Tabel Hipotesis Kerusakan:</strong> Rekomendasi tindakan mekanik otomatis dari sistem diagnosa AI.</li>
      </ul>
    </li>
  </ol>

  <div style="margin-top:40px;padding-top:20px;border-top:1px solid #cbd5e1;font-size:9pt;color:#64748b;text-align:center;">
    Reliability Based Maintenance (RBM) Analytics System &bull; Dokumen Resmi Spesifikasi &amp; Formula Teknik &bull; Hak Cipta &copy; 2026
  </div>

</body>
</html>`;

const docsDir = path.join(__dirname, 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

const htmlPath = path.join(docsDir, 'DOKUMENTASI_PROYEK_LENGKAP.html');
const pdfPath = path.join(__dirname, 'DOKUMENTASI_PROYEK_RBM.pdf');

fs.writeFileSync(htmlPath, htmlContent, 'utf8');
console.log('HTML documentation written to:', htmlPath);

// Render PDF using Microsoft Edge headless
const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

let browserExe = null;
for (const p of edgePaths) {
  if (fs.existsSync(p)) {
    browserExe = p;
    break;
  }
}

if (browserExe) {
  console.log('Generating PDF using:', browserExe);
  const cmd = \`"\${browserExe}" --headless --disable-gpu --run-all-compositor-stages-before-draw --print-to-pdf="\${pdfPath}" --no-pdf-header-footer "file:///\${htmlPath.replace(/\\\\/g, '/')}"\`;
  try {
    execSync(cmd);
    console.log('PDF successfully created at:', pdfPath);
  } catch (err) {
    console.error('Error generating PDF with headless browser:', err.message);
  }
} else {
  console.warn('No headless browser found to compile PDF.');
}

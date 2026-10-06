/* =========================================================================
 * sos-config.js
 * -------------------------------------------------------------------------
 * Konfigurasi SOS (Scheduled Oil Sampling) — threshold, parameter, bobot.
 * Mengikuti pola vhms-config.js agar konsisten dalam satu project.
 * ========================================================================= */

(function (global) {
  'use strict';

  // [KONSOLIDASI 2026-10-04 · B-3] Helper pencocokan model bersama.
  var _mm = global.MODEL_MATCH || {};

  /* -----------------------------------------------------------------------
   * 1. Parameter SOS Lab Report
   * ---------------------------------------------------------------------
   * `validRange` = rentang fisiologis yang WAJAR untuk satu param (lo, hi).
   * Dipakai oleh SOS_PARSER untuk membuang/memperbaiki nilai yang MUSTAHIL
   * (mis. viskositas 6274 cSt), sehingga data noise dari file ekspor lab
   * tidak pernah masuk ke scoring/MPRS/ranking.
   * Set `null` bila param tidak dibatasi (mis. parameter jarang dipakai).
   */
  var PARAMS = {
    // Wear Metals (Cluster A)
    wear_fe:  { label: 'Iron (Fe)',      unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_cu:  { label: 'Copper (Cu)',    unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_al:  { label: 'Aluminum (Al)',  unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_cr:  { label: 'Chromium (Cr)',  unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_pb:  { label: 'Lead (Pb)',      unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_si:  { label: 'Silicon (Si)',   unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_sn:  { label: 'Tin (Sn)',       unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },
    wear_ni:  { label: 'Nickel (Ni)',    unit: 'ppm', decimals: 1, cluster: 'wear', validRange: [0, 20000] },

    // Oil Condition (Cluster B)
    // [REVISI 2026-10-03] Cukup 1 digit desimal untuk viskositas.
    visc_v100: { label: 'Viscosity @100°C', unit: 'cSt', decimals: 1, cluster: 'oil', validRange: [2, 40], decimalRecover: true },
    visc_v40:  { label: 'Viscosity @40°C',  unit: 'cSt', decimals: 1, cluster: 'oil', validRange: [5, 2000], decimalRecover: true },
    tbn:       { label: 'TBN',              unit: 'mgKOH/g', decimals: 1, cluster: 'oil', validRange: [0, 100] },
    water_pct: { label: 'Water',            unit: '%', decimals: 2, cluster: 'oil', validRange: [0, 100] },
    fuel_pct:  { label: 'Fuel Dilution',    unit: '%', decimals: 2, cluster: 'oil', validRange: [0, 100] },
    soot:      { label: 'Soot',             unit: '%', decimals: 2, cluster: 'oil', validRange: [0, 100] },
    oxidation: { label: 'Oxidation',        unit: 'Abs/cm', decimals: 2, cluster: 'oil', validRange: [0, 5] },
    nitration: { label: 'Nitration',        unit: 'Abs/cm', decimals: 2, cluster: 'oil', validRange: [0, 5] },
    sulfation: { label: 'Sulfation',        unit: 'Abs/cm', decimals: 2, cluster: 'oil', validRange: [0, 5] },

    // Cleanliness (Cluster C)
    pqi:       { label: 'PQI',              unit: '',   decimals: 0, cluster: 'clean', validRange: [0, 100000] },
    pc_4u:     { label: '>4µm',             unit: 'count', decimals: 0, cluster: 'clean', validRange: [0, 1e9] },
    pc_6u:     { label: '>6µm',             unit: 'count', decimals: 0, cluster: 'clean', validRange: [0, 1e9] },
    pc_14u:    { label: '>14µm',            unit: 'count', decimals: 0, cluster: 'clean', validRange: [0, 1e9] },
    pc_21u:    { label: '>21µm',            unit: 'count', decimals: 0, cluster: 'clean', validRange: [0, 1e9] },

    // Additives
    additive_p:  { label: 'Phosphorus (P)', unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_mo: { label: 'Molybdenum (Mo)', unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_ca: { label: 'Calcium (Ca)',   unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_zn: { label: 'Zinc (Zn)',      unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_mg: { label: 'Magnesium (Mg)', unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_b:  { label: 'Boron (B)',      unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_na: { label: 'Sodium (Na)',    unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
    additive_ba: { label: 'Barium (Ba)',    unit: 'ppm', decimals: 0, cluster: 'additive', validRange: [0, 20000] },
  };

  /* -----------------------------------------------------------------------
   * 1b. Sanitasi nilai numerik (anti noise file ekspor lab)
   * ---------------------------------------------------------------------
   * [FIX 2026-09-30] Sebagian baris file ekspor Oil Analyzer menulis
   * viskositas TANPA titik desimal (mis. `6.274 cSt` ter-ekspor "6274"),
   * terbukti dari data nyata: 1.703/18.786 baris V100 = integer 4-digit
   * (6274, 7871, 9954 …) di mana /1000 selalu jatuh di rentang 1–30 cSt.
   *
   * Aturan (aman & konservatif — TIDAK mengubah nilai yang sudah wajar):
   *   1. Bila nilai di luar `validRange` TETAPI `value/1000` di dalam range
   *      → anggap titik desimal hilang, koreksi jadi value/1000.
   *   2. Bila masih di luar `validRange` (dan bukan kasus #1)
   *      → kembalikan null (drop dari analitik, tandai via _invalidParams).
   *   Nilai di dalam range dibiarkan apa adanya.
   *
   * @param {number|null} value
   * @param {string} paramKey
   * @returns {number|null}
   */
  function sanitizeValue(value, paramKey) {
    if (value === null || value === undefined || isNaN(value)) return null;
    var meta = PARAMS[paramKey];
    if (!meta || !meta.validRange) return value;
    var lo = meta.validRange[0], hi = meta.validRange[1];
    if (value >= lo && value <= hi) return value;   // sudah wajar
    // Kasus #1: desimal hilang — HANYA untuk param yang mengizinkan
    // (`decimalRecover: true`, mis. viskositas). Logam/aditif ppm TIDAK
    // pernah kehilangan desimal, jadi jangan dikoreksi.
    if (meta.decimalRecover && Number.isInteger(value) && value > hi) {
      var scaled = value / 1000;
      if (scaled >= lo && scaled <= hi) return scaled;
    }
    return null;   // Kasus #2: mustahil → drop
  }

  /** Apakah nilai (mentah, SEBELUM sanitasi) perlu dibetulkan/dibuang? */
  function isAnomalous(value, paramKey) {
    if (value === null || value === undefined || isNaN(value)) return false;
    var meta = PARAMS[paramKey];
    if (!meta || !meta.validRange) return false;
    return value < meta.validRange[0] || value > meta.validRange[1];
  }

  /* -----------------------------------------------------------------------
   * 2. CSV Column Mapping — header lab report → key internal
   *    Mendukung banyak alias (Intertek, Trakindo, dealer lab)
   * --------------------------------------------------------------------- */
  var COL_MAP = {
    // Identitas
    'lab no':            'lab_no',     'lab no.':          'lab_no',
    'sample number':     'lab_no',     'laboratory number': 'lab_no',
    'lab date':          'lab_date',   'report date':      'lab_date',
    'sample date':       'sampled_date', 'sampled date':   'sampled_date',
    'date sampled':      'sampled_date', 'date of sampling': 'sampled_date',
    'distribution date': 'distribution_date',

    // Asset
    'model':             'model',      'equipment model':  'model',
    'machine model':     'model',      'unit model':       'model',
    'equipment id':      'asset_id',   'unit number':      'asset_id',
    'unit no':           'asset_id',   'unit no.':         'asset_id',
    'asset id':          'asset_id',   'nomor lambung':    'asset_id',
    'equipment s/n':     'asset_serial', 'serial number':  'asset_serial',
    'asset serial number': 'asset_serial', 'asset serial': 'asset_serial',
    'machine serial':    'asset_serial', 'equipment serial': 'asset_serial',
    'component':         'component',  'compartment':      'component',
    'component description': 'component',
    'component s/n':     'component_serial',

    // Meter
    'unit meter':        'hm_unit',    'smr':              'hm_unit',
    'equipment hrs':     'hm_unit',    'equipment hours':  'hm_unit',
    'unit hour meter':   'hm_unit',    'unit hours':       'hm_unit',
    'hm unit':           'hm_unit',    'hm':               'hm_unit',
    'hour meter':        'hm_unit',    'hourmeter':        'hm_unit',
    // [FORMAT TRAKINDO/INTERTEK] kolom "Meter" = SMR/HM unit.
    'meter':             'hm_unit',    'meter (hr)':       'hm_unit',
    'meter units':       'meter_units',
    'oil hours':         'hm_oil',     'fluid hrs':        'hm_oil',
    'oil hour meter':    'hm_oil',     'hours on oil':     'hm_oil',
    'hm oil':            'hm_oil',     'oil hm':           'hm_oil',
    'oil hour':          'hm_oil',     'hm on oil':        'hm_oil',
    // "Meter on Fluid" / "Calculated Meter on Fluid" = HM pada oli (jam oli).
    'meter on fluid':    'hm_oil',     'calculated meter on fluid': 'hm_oil',
    'meter on oil':      'hm_oil',     'fluid meter':      'hm_oil',
    'component meter':   'component_meter',

    // Fluid
    'fluid changed':     'fluid_changed', 'oil changed':  'fluid_changed',
    'filter changed':    'filter_changed',
    'fluid brand':       'fluid_brand',   'oil brand':    'fluid_brand',
    'fluid type':        'fluid_type',    'oil type':     'fluid_type',
    'fluid grade':       'fluid_weight',  'oil grade':    'fluid_weight',

    // Org
    'dealer':            'dealer',
    'customer':          'customer',
    'job site':          'jobsite',     'jobsite':         'jobsite',
    'site':              'jobsite',
    'work order':        'work_order',  'wo':              'work_order',
    'status':            'eval_status',
    'evaluation':        'eval_status',
    'health':            'health',

    // Interpretation
    'interpretation':    'interp_text',
    'translated interp': 'translated_interp',
    'translated interpretation': 'translated_interp',
    'comments':          'interp_text',
    'recommendation':    'translated_interp',

    // Wear metals
    'cu':  'wear_cu',  'copper':  'wear_cu',
    'fe':  'wear_fe',  'iron':    'wear_fe',
    'cr':  'wear_cr',  'chromium': 'wear_cr',
    'pb':  'wear_pb',  'lead':    'wear_pb',
    'sn':  'wear_sn',  'tin':     'wear_sn',
    'si':  'wear_si',  'silicon': 'wear_si',
    'al':  'wear_al',  'aluminum': 'wear_al', 'aluminium': 'wear_al',
    'ni':  'wear_ni',  'nickel':  'wear_ni',

    // Additives
    'p':   'additive_p',   'phosphorus': 'additive_p',
    'mo':  'additive_mo',  'molybdenum': 'additive_mo',
    'ca':  'additive_ca',  'calcium':    'additive_ca',
    'zn':  'additive_zn',  'zinc':       'additive_zn',
    'mg':  'additive_mg',  'magnesium':  'additive_mg',
    'b':   'additive_b',   'boron':      'additive_b',
    'na':  'additive_na',  'sodium':     'additive_na',
    'ba':  'additive_ba',  'barium':     'additive_ba',

    // Oil condition
    'v100': 'visc_v100',  'visc 100':  'visc_v100', 'viscosity 100': 'visc_v100',
    'v40':  'visc_v40',   'visc 40':   'visc_v40',  'viscosity 40':  'visc_v40',
    'tbn':  'tbn',        'total base number': 'tbn',
    'water': 'water_pct', 'water %':   'water_pct', 'water(%)': 'water_pct',
    'fuel':  'fuel_pct',  'fuel %':    'fuel_pct',  'fuel dilution': 'fuel_pct', 'fuel(%)': 'fuel_pct',
    'soot':  'soot',      'soot %':    'soot',      'soot(%)': 'soot',
    'oxidation': 'oxidation',
    'nitration': 'nitration',
    'sulfation': 'sulfation',

    // Cleanliness
    'iso code':  'iso_code', 'iso':      'iso_code',
    'pqi':       'pqi',      'pq index': 'pqi',     'pqi index': 'pqi',
    'pc rating': 'pc_rating',
    '>4':        'pc_4u',    '>4um':     'pc_4u',   '>4µm':    'pc_4u',
    '>6':        'pc_6u',    '>6um':     'pc_6u',   '>6µm':    'pc_6u',
    '>14':       'pc_14u',   '>14um':    'pc_14u',  '>14µm':   'pc_14u',
    '>21':       'pc_21u',   '>21um':    'pc_21u',  '>21µm':   'pc_21u',
    '>38':       'pc_38u',   '>38um':    'pc_38u',
    '>70':       'pc_70u',   '>70um':    'pc_70u',
    'debris':    'debris',
  };

  /* -----------------------------------------------------------------------
   * 3. Threshold per kompartemen — 4-tier (warn → crit → extreme)
   * --------------------------------------------------------------------- */
  var THRESHOLDS = {
    'ENGINE': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 15,  crit: 30,  extreme: 60  },
      wear_pb:  { warn: 8,   crit: 15,  extreme: 30  },
      wear_al:  { warn: 8,   crit: 15,  extreme: 30  },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 15,  crit: 25,  extreme: 50  },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      additive_na:{ warn: 20, crit: 50, extreme: 100 },
      fuel_pct: { warn: 2.0, crit: 4.0, extreme: 6.0 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
      visc_v100:{ warn_low: 11.5, crit_low: 10.0, warn_high: 16.0, crit_high: 18.0 },
      visc_v40: { warn_low: 65, crit_low: 55, warn_high: 120, crit_high: 140 },
      tbn:      { warn_low: 5.0,  crit_low: 3.0 },
      soot:     { warn: 1.5, crit: 3.0, extreme: 5.0 },
      oxidation:{ warn: 15, crit: 25, extreme: 35 },
      nitration:{ warn: 15, crit: 25, extreme: 35 },
      sulfation:{ warn: 15, crit: 25, extreme: 35 },
    },
    'FINAL DRIVE': {
      wear_fe:  { warn: 100, crit: 200, extreme: 400 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_pb:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_al:  { warn: 10,  crit: 20,  extreme: 40  },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      additive_na:{ warn: 20, crit: 50, extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 60,  crit: 150, extreme: 350 },
    },
    'TRANSMISSION': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 30,  crit: 60,  extreme: 120 },
      wear_pb:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_al:  { warn: 10,  crit: 20,  extreme: 40  },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 20,  crit: 40,  extreme: 80  },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      additive_na:{ warn: 20, crit: 50, extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 30,  crit: 60,  extreme: 120 },
      // [FIX 2026-10-01] V100/V40/TBN ditambahkan — degradasi oli relevan
      // untuk transmisi (gear oil SAE 10W-30 s/d SAE 60 tergantung model).
      visc_v100:{ warn_low: 9.0,  crit_low: 7.5,  warn_high: 16.5, crit_high: 20.0 },
      visc_v40: { warn_low: 55,   crit_low: 40,   warn_high: 130,  crit_high: 160 },
      tbn:      { warn_low: 4.0,  crit_low: 2.5 },
    },
    'HYDRAULIC': {
      wear_fe:  { warn: 15,  crit: 30,  extreme: 60  },
      wear_cu:  { warn: 10,  crit: 25,  extreme: 50  },
      wear_pb:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_al:  { warn: 8,   crit: 15,  extreme: 30  },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 15,  crit: 25,  extreme: 50  },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      additive_na:{ warn: 20, crit: 50, extreme: 100 },
      water_pct:{ warn: 0.05, crit: 0.1, extreme: 0.5 },
      pqi:      { warn: 15,  crit: 30,  extreme: 60  },
      // [FIX 2026-10-01] V100/V40/TBN — hidrolik sensitif terhadap viskositas
      // (umumnya ISO VG 32/46/68); V100 lebih rendah dari engine oil.
      visc_v100:{ warn_low: 5.5, crit_low: 4.5, warn_high: 10.0, crit_high: 12.0 },
      visc_v40: { warn_low: 28,  crit_low: 22,  warn_high: 75,   crit_high: 90 },
      tbn:      { warn_low: 3.0, crit_low: 2.0 },
    },
    'DIFFERENTIAL': {
      wear_fe:  { warn: 100, crit: 200, extreme: 400 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 60,  crit: 150, extreme: 350 },
    },
    'SWING DRIVE': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 40,  crit: 80,  extreme: 180 },
    },
    'STEERING': {
      wear_fe:  { warn: 15,  crit: 30,  extreme: 60  },
      wear_cu:  { warn: 10,  crit: 25,  extreme: 50  },
      wear_pb:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_al:  { warn: 8,   crit: 15,  extreme: 30  },
      wear_cr:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_si:  { warn: 15,  crit: 25,  extreme: 50  },
      wear_sn:  { warn: 5,   crit: 10,  extreme: 20  },
      wear_ni:  { warn: 5,   crit: 10,  extreme: 20  },
      water_pct:{ warn: 0.08, crit: 0.3, extreme: 0.8 },
      pqi:      { warn: 15,  crit: 30,  extreme: 60  },
    },
    /* ---------------------------------------------------------------------
     * [PERLUASAN 2026-09-30] Kompartemen tambahan dari data lapangan nyata.
     * Nilai acuan berbasis gearset/axle (mirip FINAL DRIVE) karena umumnya
     * berbagi karakteristik: volume oli kecil, beban tinggi, wear metal
     * sebagai indikator utama. Silakan sesuaikan via halaman Pengaturan.
     * ------------------------------------------------------------------- */
    'POWER TAKE OFF': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'TORQUE CONVERTER': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 30,  crit: 60,  extreme: 120 },
      wear_si:  { warn: 20,  crit: 40,  extreme: 80  },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'TRANSFER GEARS': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'GEAR REDUCER': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'CIRCLE DRIVE': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'WHEEL BEARINGS': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'WHEEL HUB': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'SPINDLE': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'TANDEM': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'DAMPER': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
    'DRUM': {
      wear_fe:  { warn: 80,  crit: 150, extreme: 300 },
      wear_cu:  { warn: 20,  crit: 50,  extreme: 100 },
      wear_si:  { warn: 25,  crit: 50,  extreme: 100 },
      water_pct:{ warn: 0.1, crit: 0.5, extreme: 1.0 },
      pqi:      { warn: 25,  crit: 50,  extreme: 100 },
    },
  };

  /* -----------------------------------------------------------------------
   * [REVISI 2026-09-30] Pastikan Sodium (Na) SELALU dievaluasi.
   * ---------------------------------------------------------------------
   * Sodium mudah larut & penting sebagai indikator kebocoran coolant/kontaminasi
   * eksternal (bersama Water). Bila threshold Na belum didefinisikan eksplisit
   * untuk suatu kompartemen, pasang NILAI UMUM ini agar Na tetap masuk
   * perhitungan MPRS/severity & muncul di Portfolio.
   * Idempotent: tidak menimpa nilai yang sudah ada (mis. ENGINE yang eksplisit).
   * --------------------------------------------------------------------- */
  var NA_DEFAULT = { warn: 20, crit: 50, extreme: 100 };
  Object.keys(THRESHOLDS).forEach(function (comp) {
    if (!THRESHOLDS[comp].additive_na) THRESHOLDS[comp].additive_na = NA_DEFAULT;
  });

  // [FIX 2026-10-01] Pasang threshold default untuk Sn, Ni, Cr agar SELALU
  // dievaluasi di kompartemen yang belum mendefinisikannya secara eksplisit.
  // Idempotent: tidak menimpa nilai yang sudah ada.
  var SN_DEFAULT = { warn: 5, crit: 10, extreme: 20 };
  var NI_DEFAULT = { warn: 5, crit: 10, extreme: 20 };
  var CR_DEFAULT = { warn: 5, crit: 10, extreme: 20 };
  Object.keys(THRESHOLDS).forEach(function (comp) {
    if (!THRESHOLDS[comp].wear_sn) THRESHOLDS[comp].wear_sn = SN_DEFAULT;
    if (!THRESHOLDS[comp].wear_ni) THRESHOLDS[comp].wear_ni = NI_DEFAULT;
    if (!THRESHOLDS[comp].wear_cr) THRESHOLDS[comp].wear_cr = CR_DEFAULT;
  });

  // [FIX 2026-10-01] V100/V40/TBN dipasang DEFAULT ke SEMUA kompartemen yang
  // belum punya. Alasan: viskositas turun (fuel dilution, degradasi) dan
  // cadangan basa habis (TBN) terjadi di SEMUA kompartemen yang memakai oli,
  // bukan hanya ENGINE. Tanpa threshold ini, V100 drop / TBN drop di FINAL
  // DRIVE / DIFFERENTIAL / dll tidak terdeteksi padahal data ada.
  // Nilai default = rentang gear oil umum (SAE 80W-90 / 85W-140) yang
  // cukup lebar agar tidak terlalu sensitif pada kompartemen tanpa spesifikasi
  // eksplisit. Kompartemen yang sudah punya (ENGINE/TRANSMISSION/HYDRAULIC)
  // TIDAK ditimpa (idempotent).
  var V100_DEFAULT = { warn_low: 8.0,  crit_low: 6.0,  warn_high: 20.0, crit_high: 25.0 };
  var V40_DEFAULT  = { warn_low: 50,   crit_low: 35,   warn_high: 150,  crit_high: 200 };
  var TBN_DEFAULT  = { warn_low: 3.0,  crit_low: 2.0 };
  Object.keys(THRESHOLDS).forEach(function (comp) {
    if (!THRESHOLDS[comp].visc_v100) THRESHOLDS[comp].visc_v100 = V100_DEFAULT;
    if (!THRESHOLDS[comp].visc_v40)  THRESHOLDS[comp].visc_v40  = V40_DEFAULT;
    if (!THRESHOLDS[comp].tbn)       THRESHOLDS[comp].tbn       = TBN_DEFAULT;
  });

  // Fallback: jika kompartemen tidak dikenal, pakai FINAL DRIVE
  var THRESHOLD_FALLBACK = 'FINAL DRIVE';

  /* -----------------------------------------------------------------------
   * 4. Component weights untuk MPRS scoring
   * --------------------------------------------------------------------- */
  var COMPONENT_WEIGHTS = {
    'ENGINE': 1.5,  'TRANSMISSION': 1.2,  'FINAL DRIVE': 1.0,
    'HYDRAULIC': 0.9,  'DIFFERENTIAL': 0.9,  'STEERING': 0.8,
    'SWING DRIVE': 0.9, 'DAMPER': 0.8, 'WHEEL': 0.8,
    'TANDEM': 0.8, 'CIRCLE': 0.8,
    // [PERLUASAN 2026-09-30] kunci tambahan dari data lapangan.
    'POWER TAKE OFF': 1.0, 'TORQUE CONVERTER': 1.0, 'TRANSFER GEARS': 1.0,
    'GEAR REDUCER': 0.9, 'CIRCLE DRIVE': 0.9, 'WHEEL BEARINGS': 0.8,
    'WHEEL HUB': 0.8, 'SPINDLE': 0.8, 'DRUM': 0.8,
  };

  /* -----------------------------------------------------------------------
   * 5. Criticality Index (dari spec): Severity×0.45 + Evidence×0.30 + Trend×0.25
   * --------------------------------------------------------------------- */
  var CRITICALITY = {
    axes: { severity: 0.45, evidence: 0.30, trend: 0.25 },
    // [STANDARISASI 2026-10-03] Band 3 level. `warning` dipertahankan sebagai
    // alias kompatibilitas untuk konfigurasi lama.
    bands: { critical: 45, caution: 25, warning: 25 },
    // [A4] SATU SUMBER BOBOT: memakai COMPONENT_WEIGHTS yang lengkap (11
    // kompartemen) agar kompartemen seperti SWING DRIVE/DIFFERENTIAL/STEERING
    // tidak lagi jatuh ke bobot default 1.0. Nilai untuk 4 pilar utama
    // (ENGINE/TRANSMISSION/FINAL DRIVE/HYDRAULIC) IDENTIK dengan sebelumnya,
    // jadi tidak mengubah hasil unit pada pilar tsb.
    pillarWeights: COMPONENT_WEIGHTS,
    formulaWindowSamples: 5,  // N sampel terakhir untuk formula (fallback bila HM kosong)
    // [REVISI #12] Window penentuan level critical = 4000 JAM terakhir,
    // dihitung mundur dari Meter/HM TERTINGGI. Semua formula criticality
    // (severity/evidence/trend) memakai subset ini agar mencerminkan kondisi
    // operasi aktual.
    formulaWindowHours: 4000,
  };

  /* -----------------------------------------------------------------------
   * 6. Chart cluster definitions (3 cluster sesuai spec)
   * --------------------------------------------------------------------- */
  var CHART_CLUSTERS = {
    wear: {
      id: 'wear', title: 'Cluster A — Wear Metals (ppm)',
      icon: 'fa-atom', color: '#ef4444',
      series: [
        { key: 'wear_fe', color: '#ef4444' },
        { key: 'wear_cu', color: '#f59e0b' },
        { key: 'wear_al', color: '#3b82f6' },
        { key: 'wear_cr', color: '#8b5cf6' },
        { key: 'wear_pb', color: '#ec4899' },
        { key: 'wear_si', color: '#10b981' },
        // [REVISI #6] Tambahkan Sodium (Na) ke Wear Metal Chart. Na berguna
        // mendeteksi kebocoran coolant/gasket (bersama Si) maupun kontaminasi
        // eksternal — indikator keausan & kesehatan oli yang penting.
        { key: 'additive_na', color: '#eab308' },
      ]
    },
    oil: {
      id: 'oil', title: 'Cluster B — Oil Condition',
      icon: 'fa-oil-can', color: '#f59e0b',
      series: [
        { key: 'visc_v100', color: '#3b82f6', yAxis: 'left' },
        { key: 'tbn',       color: '#10b981', yAxis: 'left' },
        { key: 'water_pct', color: '#ef4444', yAxis: 'right' },
        { key: 'fuel_pct',  color: '#f59e0b', yAxis: 'right' },
        { key: 'soot',      color: '#6b7280', yAxis: 'right' },
      ]
    },
    clean: {
      id: 'clean', title: 'Cluster C — Cleanliness & PQI',
      icon: 'fa-filter', color: '#06b6d4',
      series: [
        { key: 'pqi',   color: '#ef4444', type: 'bar' },
        { key: 'pc_4u', color: '#3b82f6', yAxis: 'right' },
        { key: 'pc_6u', color: '#10b981', yAxis: 'right' },
        { key: 'pc_14u',color: '#f59e0b', yAxis: 'right' },
      ]
    },
    // [REVISI #5] Cluster baru — PARTIKEL KONTAMINASI [Water, Fuel].
    // Memisahkan indikator kontaminasi (air & dilusi bahan bakar) dari
    // Cluster B agar lebih fokus: keduanya mencemari oli, menurunkan
    // pelumasan, dan mempercepat keausan.
    contamination: {
      id: 'contamination', title: 'Cluster D — Partikel Kontaminasi (Water & Fuel)',
      icon: 'fa-droplet', color: '#38bdf8',
      series: [
        { key: 'water_pct', color: '#38bdf8', yAxis: 'left' },
        { key: 'fuel_pct',  color: '#f59e0b', yAxis: 'right' },
      ]
    }
  };

  /* -----------------------------------------------------------------------
   * 7. Diagnostic rules (browser-side, mirip backend diagnostics.py)
   * --------------------------------------------------------------------- */
  var DIAGNOSTIC_RULES = [
    {
      id: 'dirt_entry', title: 'Kontaminasi Debu / Dirt Entry',
      system: 'Air Intake & Seals',
      risk: 'Keausan akseleratif akibat partikel abrasif (Si, Al tinggi)',
      check: function (s) { return s.wear_si >= 25 && s.wear_fe >= 100; },
      action: 'Inspeksi filter udara & seal kompartemen untuk sumber masuknya debu. {{PARTICLE_CHECK}} Lakukan flush oli.'
    },
    {
      id: 'fuel_dilution', title: 'Fuel Dilution',
      system: 'Fuel System',
      risk: 'Penurunan viskositas dan pelumasan; risiko seizure',
      check: function (s) { return (s.visc_v100 !== null && s.visc_v100 <= 10) && s.fuel_pct >= 2; },
      action: 'Cek injector, fuel pump timing, dan ring piston. Ganti oli segera.'
    },
    {
      id: 'coolant_leak', title: 'Kebocoran Coolant',
      system: 'Cooling System',
      risk: 'Kontaminasi air pendingin merusak bearing & seal',
      check: function (s) { return s.additive_na >= 20 && s.water_pct >= 0.5; },
      action: 'Inspeksi head gasket, cooler core, dan seal water pump.'
    },
    {
      id: 'bearing_wear', title: 'Keausan Bearing Tinggi',
      system: 'Bearing / Bushing',
      risk: 'Copper tinggi + PQI tinggi = keausan bearing lanjut',
      check: function (s) { return s.wear_cu >= 30 && s.pqi >= 50; },
      action: 'Inspeksi bearing, bushing, thrust washer. Periksa alignment shaft.'
    },
    {
      id: 'water_contamination', title: 'Kontaminasi Air Berlebih',
      system: 'Seal & Breather',
      risk: 'Air >1% menyebabkan korosi, emulsi, dan kerusakan aditif',
      check: function (s) { return s.water_pct >= 1.0; },
      action: 'Ganti oli, periksa seal, breather, dan reservoir. Cek kondisi penyimpanan.'
    },
    {
      id: 'high_pqi', title: 'PQI Sangat Tinggi',
      system: 'Seluruh Kompartemen',
      risk: 'Partikel besar terdeteksi — keausan parah atau kontaminasi eksternal',
      check: function (s) { return s.pqi >= 100; },
      action: 'Drain & flush oli. {{PARTICLE_CHECK}}'
    },
    {
      id: 'severe_fe_wear', title: 'Keausan Besi Parah',
      system: 'Gear / Cylinder / Liner',
      risk: 'Iron >200 ppm menandakan keausan logam primer lanjut',
      check: function (s) { return s.wear_fe >= 200; },
      action: 'Investigasi sumber Fe (gear, liner, ring). Pertimbangkan overhaul kompartemen.'
    },
  ];

  /* -----------------------------------------------------------------------
   * 8. Tier display helpers
   * ---------------------------------------------------------------------
   * [STANDARISASI 2026-10-03] SOP perusahaan memakai HANYA 3 level:
   *   index 0 NORMAL   -> "Normal"   (putih #e2e8f0) — SLA: -
   *   index 1 CAUTION  -> "Caution"  (amber #f59e0b) — SLA: 2x24 Jam
   *   index 2 CRITICAL -> "Critical" (merah #ef4444) — SLA: 1x24 Jam
   * Kunci internal SAMA DENGAN label (tidak ada lagi pergeseran nama).
   * Level lama MONITOR/WARNING digabung ke CAUTION; EXTREME ke CRITICAL
   * (lihat TIER_ALIAS). Threshold `extreme` tetap dipakai sebagai ANGKA
   * pembeda severity, hanya tier hasilnya yang di-clamp ke 3 level.
   */
  var TIER_KEYS   = ['NORMAL', 'CAUTION', 'CRITICAL'];   // kunci internal = label (3 level)
  var TIER_LABELS = ['Normal', 'Caution', 'Critical'];   // label tampilan
  var TIER_COLORS = ['#e2e8f0', '#f59e0b', '#ef4444'];   // putih, amber, merah
  var TIER_ICONS  = ['fa-circle-check', 'fa-triangle-exclamation', 'fa-skull-crossbones'];

  /**
   * [STANDARISASI 2026-10-03] Alias kunci lama -> kunci baru (3 level).
   * Dipakai agar data lama di localStorage / parameter fungsi tetap dikenali.
   *   MONITOR / WARNING -> CAUTION
   *   EXTREME           -> CRITICAL
   */
  var TIER_ALIAS = {
    'MONITOR': 'CAUTION', 'WARNING': 'CAUTION',
    'EXTREME': 'CRITICAL'
  };

  /** Normalisasi kunci status apa pun ke salah satu dari 3 kunci kanonik. */
  function normalizeTierKey(key) {
    var k = String(key || '').toUpperCase();
    if (TIER_ALIAS[k]) k = TIER_ALIAS[k];
    return TIER_KEYS.indexOf(k) >= 0 ? k : 'NORMAL';
  }

  /**
   * Indeks tier (0..2) dari severity score SOS (0/1/2/4).
   *   0        -> 0 Normal
   *   1        -> 1 Caution   (melewati ambang warn)
   *   2 atau 4 -> 2 Critical  (melewati ambang crit / extreme)
   */
  function tierFromSeverity(sev) {
    var s = Number(sev) || 0;
    if (s >= 2) return 2;
    if (s >= 1) return 1;
    return 0;
  }

  /** Label tampilan dari kunci internal tier (mis. 'CAUTION' -> 'Caution'). */
  function tierLabelOf(tierKey) {
    var i = TIER_KEYS.indexOf(normalizeTierKey(tierKey));
    return i >= 0 ? TIER_LABELS[i] : 'Normal';
  }
  /** Warna dari kunci internal tier. */
  function tierColorOf(tierKey) {
    var i = TIER_KEYS.indexOf(normalizeTierKey(tierKey));
    return i >= 0 ? TIER_COLORS[i] : TIER_COLORS[0];
  }

  /* -----------------------------------------------------------------------
   * Helpers
   * --------------------------------------------------------------------- */
  /**
   * Cari kunci kompartemen yang paling cocok untuk nama kompartemen bebas.
   * Pencocokan dua arah + pilih kunci TERPANJANG agar paling spesifik:
   *   - "SWING"       -> "SWING DRIVE" (bukan FALLBACK)
   *   - "SWING DRIVE" -> "SWING DRIVE"
   *   - "ENGINE OIL"  -> "ENGINE"
   * Mengembalikan null bila tidak ada yang cocok (pemanggil pakai fallback).
   */
  function matchComponentKey(component, keys) {
    var comp = (component || '').toUpperCase().trim();
    if (!comp) return null;
    var best = null;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      // cocok bila salah satu mengandung yang lain (mis. "SWING" vs "SWING DRIVE")
      if (comp.indexOf(key) !== -1 || key.indexOf(comp) !== -1) {
        if (best === null || key.length > best.length) best = key;
      }
    }
    return best;
  }

  /* -----------------------------------------------------------------------
   * [BARU 2026-10-01] OVERRIDE THRESHOLD PER MODEL UNIT
   * ---------------------------------------------------------------------
   * Sebagian kompartemen punya karakteristik berbeda antar MODEL unit
   * (mis. ENGINE HD785 vs PC2000 vs D375A) sehingga ambang batasnya TIDAK
   * boleh disamakan. Struktur:
   *
   *   MODEL_THRESHOLDS = {
   *     'HD785': { 'ENGINE': { wear_fe: { warn: 90, crit: 170, extreme: 340 } } },
   *     'PC2000': { ... }
   *   }
   *
   * MENGAPA NESTED & OVERRIDE PARSIAL:
   *   - Nama model bebas (bisa banyak). Di-nest per model agar mudah
   *     diekspor/diimpor & tidak membanjiri THRESHOLDS.
   *   - OVERRIDE PARSIAL: cukup tulis parameter yang berbeda. Parameter yang
   *     tidak ditulis otomatis memakai nilai DEFAULT kompartemen
   *     (THRESHOLDS[kompartemen]). Jadi bila kompartemen belum punya entri
   *     model sama sekali -> perilaku IDENTIK dengan sebelumnya (tanpa regresi).
   *
   * Model dicocokkan dengan `matchModelKey()` (exact dulu, lalu substring dua
   * arah + pilih kunci terpanjang) agar "HD785-7" tetap cocok dengan "HD785".
   * --------------------------------------------------------------------- */
  var MODEL_THRESHOLDS = {
    // =========================================================================
    // [REFERENSI 2026-10-01] Model-specific SOS thresholds berdasarkan:
    //   - Komatsu KOMTRAX/VHMS Condition Monitoring Guidelines
    //   - Caterpillar S·O·S Fluid Analysis Condemning Limits
    //   - Hitachi Oil Analysis Standard Values
    //   - Industry best practice (Noria, STLE, ASTM D6224)
    //
    // Hanya parameter yang BERBEDA dari default kompartemen yang ditulis.
    // Parameter yang tidak ditulis otomatis memakai default kompartemen.
    // =========================================================================

    // --- KOMATSU ---
    'HD785': {
      'ENGINE': {
        // SAA12V140E-3 / SAA6D170E: oli EO15W-40, kapasitas ~80L
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  },
        wear_si: { warn: 20,  crit: 40,  extreme: 80  },
        visc_v100: { warn_low: 12.5, crit_low: 11.0, warn_high: 15.5, crit_high: 17.0 },
        soot: { warn: 2.0, crit: 4.0, extreme: 6.0 }
      },
      'TRANSMISSION': {
        // ECMV transmission, kapasitas ~85L, TO-4 fluid
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      },
      'FINAL DRIVE': {
        // Planetary final drive, kapasitas ~35L per side
        wear_fe: { warn: 120, crit: 250, extreme: 500 },
        pqi:     { warn: 60,  crit: 150, extreme: 350 }
      },
      'HYDRAULIC': {
        // Tekanan tinggi, kapasitas ~270L
        wear_fe: { warn: 20,  crit: 40,  extreme: 80  },
        pqi:     { warn: 20,  crit: 40,  extreme: 80  }
      },
      'DIFFERENTIAL': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 25,  crit: 60,  extreme: 120 }
      }
    },

    'HD785-7': {
      'ENGINE': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  },
        soot:    { warn: 2.0, crit: 4.0, extreme: 6.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      }
    },

    'HD465': {
      'ENGINE': {
        // SAA6D170E-5: kapasitas ~50L
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 18,  crit: 35,  extreme: 70  },
        soot:    { warn: 1.8, crit: 3.5, extreme: 5.5 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 35,  crit: 70,  extreme: 140 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 110, crit: 220, extreme: 450 }
      }
    },

    'HD1500': {
      'ENGINE': {
        // SDA12V160 / QSK50: kapasitas ~190L
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 25,  crit: 50,  extreme: 100 },
        soot:    { warn: 2.0, crit: 4.0, extreme: 6.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 110, crit: 220, extreme: 450 },
        wear_cu: { warn: 45,  crit: 90,  extreme: 180 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 140, crit: 280, extreme: 550 }
      }
    },

    'HM400': {
      'ENGINE': {
        // SAA6D140E-5
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 30,  crit: 60,  extreme: 120 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 }
      }
    },

    'PC2000': {
      'ENGINE': {
        // SAA12V140E / SAA6D170E-5: 15W-40, kapasitas ~110L
        wear_fe: { warn: 80,  crit: 150, extreme: 300 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  },
        soot: { warn: 1.5, crit: 3.0, extreme: 5.0 }
      },
      'HYDRAULIC': {
        // Volume besar ~900L, tekanan sangat tinggi
        wear_fe: { warn: 10,  crit: 25,  extreme: 50  },
        wear_cu: { warn: 8,   crit: 20,  extreme: 40  },
        pqi:     { warn: 15,  crit: 30,  extreme: 60  }
      },
      'SWING DRIVE': {
        wear_fe: { warn: 60,  crit: 120, extreme: 250 },
        wear_cu: { warn: 15,  crit: 40,  extreme: 80  }
      },
      'PTO': {
        wear_fe: { warn: 70,  crit: 140, extreme: 280 }
      }
    },

    'PC1250': {
      'ENGINE': {
        wear_fe: { warn: 80,  crit: 150, extreme: 300 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  },
        pqi:     { warn: 15,  crit: 30,  extreme: 60  }
      },
      'SWING DRIVE': {
        wear_fe: { warn: 70,  crit: 140, extreme: 280 }
      }
    },

    'PC3000': {
      'ENGINE': {
        // QSK50 / QSK60 Cummins, kapasitas ~240L
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        soot: { warn: 1.5, crit: 3.0, extreme: 5.0 }
      },
      'HYDRAULIC': {
        // Volume sangat besar, tekanan sangat tinggi
        wear_fe: { warn: 8,   crit: 20,  extreme: 40  },
        pqi:     { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'PC4000': {
      'ENGINE': {
        // SDA16V160 / QSK60
        wear_fe: { warn: 85,  crit: 170, extreme: 340 },
        soot:    { warn: 1.5, crit: 3.0, extreme: 5.0 }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 8,   crit: 20,  extreme: 40  },
        pqi:     { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'PC800': {
      'ENGINE': {
        // SAA6D140E-5
        wear_fe: { warn: 80,  crit: 150, extreme: 300 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  },
        pqi:     { warn: 15,  crit: 30,  extreme: 60  }
      }
    },

    'PC400': {
      'ENGINE': {
        // SAA6D125E-5
        wear_fe: { warn: 75,  crit: 140, extreme: 280 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  },
        pqi:     { warn: 15,  crit: 30,  extreme: 60  }
      }
    },

    'PC300': {
      'ENGINE': {
        // SAA6D114E-3
        wear_fe: { warn: 70,  crit: 130, extreme: 260 },
        wear_cu: { warn: 12,  crit: 25,  extreme: 50  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 10,  crit: 22,  extreme: 45  }
      }
    },

    'PC200': {
      'ENGINE': {
        // SAA6D107E-1
        wear_fe: { warn: 65,  crit: 120, extreme: 240 },
        wear_cu: { warn: 12,  crit: 25,  extreme: 50  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 10,  crit: 20,  extreme: 40  }
      }
    },

    'D375A': {
      'ENGINE': {
        // SAA6D170E-5: dozer load tinggi, soot cenderung lebih tinggi
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  },
        soot: { warn: 2.0, crit: 4.0, extreme: 7.0 }
      },
      'TRANSMISSION': {
        // Torque converter + power shift, beban tinggi
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      },
      'FINAL DRIVE': {
        // Planetary reduction, beban dozer sangat tinggi
        wear_fe: { warn: 150, crit: 300, extreme: 600 },
        pqi:     { warn: 60,  crit: 150, extreme: 350 }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 15,  crit: 30,  extreme: 60  }
      }
    },

    'D275A': {
      'ENGINE': {
        // SAA6D140E-5
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 18,  crit: 35,  extreme: 70  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 35,  crit: 70,  extreme: 140 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 130, crit: 260, extreme: 520 }
      }
    },

    'D155A': {
      'ENGINE': {
        // SAA6D140E-5
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 30,  crit: 60,  extreme: 120 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 120, crit: 240, extreme: 480 }
      }
    },

    'D475A': {
      'ENGINE': {
        // SAA12V140E-3
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        wear_cu: { warn: 22,  crit: 45,  extreme: 90  },
        soot:    { warn: 2.0, crit: 4.0, extreme: 7.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        wear_cu: { warn: 45,  crit: 90,  extreme: 180 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 160, crit: 320, extreme: 650 }
      }
    },

    'GD825': {
      'ENGINE': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 30,  crit: 60,  extreme: 120 }
      },
      'TANDEM': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 }
      },
      'CIRCLE': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 }
      }
    },

    'WA600': {
      'ENGINE': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 18,  crit: 35,  extreme: 70  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 35,  crit: 70,  extreme: 140 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 110, crit: 220, extreme: 450 }
      }
    },

    // --- CATERPILLAR ---
    'CAT 785': {
      'ENGINE': {
        // 3512B/C, kapasitas ~134L, Cat DEO 15W-40
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 20,  crit: 45,  extreme: 90  },
        wear_pb: { warn: 10,  crit: 20,  extreme: 40  },
        wear_si: { warn: 20,  crit: 40,  extreme: 80  },
        fuel_pct:{ warn: 2.5, crit: 5.0, extreme: 8.0 },
        soot:    { warn: 2.5, crit: 5.0, extreme: 8.0 }
      },
      'TRANSMISSION': {
        // Cat TDTO, kapasitas ~115L
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 150, crit: 300, extreme: 600 }
      },
      'DIFFERENTIAL': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 }
      }
    },

    'CAT 789': {
      'ENGINE': {
        // 3516B, kapasitas ~160L
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 20,  crit: 45,  extreme: 90  },
        wear_si: { warn: 20,  crit: 40,  extreme: 80  },
        soot:    { warn: 2.5, crit: 5.0, extreme: 8.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 45,  crit: 90,  extreme: 180 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 150, crit: 300, extreme: 600 }
      }
    },

    'CAT 777': {
      'ENGINE': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 35,  crit: 70,  extreme: 140 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 130, crit: 260, extreme: 520 }
      }
    },

    'CAT 793': {
      'ENGINE': {
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        wear_cu: { warn: 25,  crit: 50,  extreme: 100 },
        soot:    { warn: 2.5, crit: 5.0, extreme: 8.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        wear_cu: { warn: 50,  crit: 100, extreme: 200 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 160, crit: 320, extreme: 650 }
      }
    },

    'CAT 390': {
      'ENGINE': {
        // C18 ACERT, kapasitas ~55L
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 15,  crit: 35,  extreme: 70  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  },
        pqi:     { warn: 15,  crit: 30,  extreme: 60  }
      }
    },

    'CAT 349': {
      'ENGINE': {
        wear_fe: { warn: 75,  crit: 140, extreme: 280 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 10,  crit: 22,  extreme: 45  }
      }
    },

    'CAT 374': {
      'ENGINE': {
        wear_fe: { warn: 80,  crit: 150, extreme: 300 },
        wear_cu: { warn: 15,  crit: 30,  extreme: 60  }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'CAT D10': {
      'ENGINE': {
        // C27 ACERT, beban dozer tinggi
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        soot:    { warn: 2.0, crit: 4.0, extreme: 7.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 150, crit: 300, extreme: 600 }
      }
    },

    'CAT D11': {
      'ENGINE': {
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        soot:    { warn: 2.0, crit: 4.0, extreme: 7.0 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 110, crit: 220, extreme: 440 },
        wear_cu: { warn: 45,  crit: 90,  extreme: 180 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 160, crit: 320, extreme: 650 }
      }
    },

    'CAT D9': {
      'ENGINE': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 90,  crit: 180, extreme: 360 },
        wear_cu: { warn: 35,  crit: 70,  extreme: 140 }
      },
      'FINAL DRIVE': {
        wear_fe: { warn: 140, crit: 280, extreme: 560 }
      }
    },

    'CAT 16M': {
      'ENGINE': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 30,  crit: 60,  extreme: 120 }
      },
      'TANDEM': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 }
      }
    },

    // --- HITACHI ---
    'EX3600': {
      'ENGINE': {
        // QSK60 Cummins, kapasitas ~240L
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        soot:    { warn: 1.5, crit: 3.0, extreme: 5.0 }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 10,  crit: 20,  extreme: 40  },
        pqi:     { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'EX2600': {
      'ENGINE': {
        // QSK50 Cummins
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        soot:    { warn: 1.5, crit: 3.0, extreme: 5.0 }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 10,  crit: 20,  extreme: 40  },
        pqi:     { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'EX1200': {
      'ENGINE': {
        // QSK23 Cummins
        wear_fe: { warn: 75,  crit: 150, extreme: 300 }
      },
      'HYDRAULIC': {
        wear_fe: { warn: 12,  crit: 25,  extreme: 50  }
      }
    },

    'EH4000': {
      'ENGINE': {
        // QSK78 Cummins, kapasitas ~300L
        wear_fe: { warn: 80,  crit: 160, extreme: 320 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      }
    },

    'EH5000': {
      'ENGINE': {
        wear_fe: { warn: 85,  crit: 170, extreme: 340 },
        wear_cu: { warn: 20,  crit: 40,  extreme: 80  }
      },
      'TRANSMISSION': {
        wear_fe: { warn: 100, crit: 200, extreme: 400 },
        wear_cu: { warn: 40,  crit: 80,  extreme: 160 }
      }
    }
  };

  /**
   * Cari kunci model yang paling cocok untuk nama model bebas.
   * - exact (setelah normalisasi) menang;
   * - lalu substring dua arah, pilih kunci terpanjang (paling spesifik);
   * - null bila tidak ada.
   */
  function normModel(m) {
    if (_mm.normModel) return _mm.normModel(m);
    return String(m == null ? '' : m).toUpperCase().replace(/\s+/g, ' ').trim();
  }
  function matchModelKey(model, keys) {
    if (_mm.matchModelKey) return _mm.matchModelKey(model, keys);
    var m = normModel(model);
    if (!m || !keys || !keys.length) return null;
    // 1) Exact match.
    for (var i = 0; i < keys.length; i++) {
      if (normModel(keys[i]) === m) return keys[i];
    }
    // 2) Substring dua arah -> pilih kunci terpanjang (paling spesifik).
    var best = null;
    for (var j = 0; j < keys.length; j++) {
      var k = normModel(keys[j]);
      if (!k) continue;
      if (m.indexOf(k) !== -1 || k.indexOf(m) !== -1) {
        if (best === null || k.length > normModel(best).length) best = keys[j];
      }
    }
    return best;
  }

  /**
   * Kumpulkan objek override untuk suatu (model, kompartemen).
   * Menggabungkan SEMUA entri model yang cocok (mis. "HD785" & "HD785-7")
   * dari kunci paling umum -> paling spesifik, sehingga override spesifik
   * menang. Mengembalikan {} bila tak ada.
   */
  function modelOverride(model, component) {
    var out = {};
    if (!model) return out;
    var modelKeys = matchModelCandidateKeys(model);
    var compKey = matchComponentKey(component, Object.keys(THRESHOLDS));
    if (!compKey) compKey = component;
    modelKeys.forEach(function (mk) {
      var byComp = MODEL_THRESHOLDS[mk];
      if (!byComp) return;
      var set = byComp[compKey];
      if (!set) {
        // Coba cocokkan nama kompartemen bebas dgn kunci yang ada di entri model.
        var ck2 = matchComponentKey(component, Object.keys(byComp));
        set = ck2 ? byComp[ck2] : null;
      }
      if (!set) return;
      Object.keys(set).forEach(function (pk) {
        out[pk] = Object.assign(out[pk] || {}, set[pk]);
      });
    });
    return out;
  }

  /**
   * Daftar kunci model yang cocok untuk `model`, urut dari paling UMUM
   * (pendek) ke paling SPESIFIK (panjang) agar override spesifik menimpa
   * yang umum. Contoh: ['HD785','HD785-7'].
   */
  function matchModelCandidateKeys(model) {
    if (_mm.matchModelCandidateKeys) return _mm.matchModelCandidateKeys(model, Object.keys(MODEL_THRESHOLDS));
    var m = normModel(model);
    var keys = Object.keys(MODEL_THRESHOLDS);
    if (!m || !keys.length) return [];
    var hits = [];
    for (var i = 0; i < keys.length; i++) {
      var k = normModel(keys[i]);
      if (!k) continue;
      if (m === k || m.indexOf(k) !== -1 || k.indexOf(m) !== -1) hits.push(keys[i]);
    }
    hits.sort(function (a, b) { return normModel(a).length - normModel(b).length; });
    return hits;
  }

  /**
   * Ambil threshold efektif untuk (kompartemen, model).
   * Backward-compatible: `getThresholdsFor(component)` tetap bekerja (model
   * opsional). Bila model tak dikenal / tanpa override -> threshold
   * kompartemen APA ADANYA (objek referensi yang sama, tanpa regresi).
   */
  function getThresholdsFor(component, model) {
    var key = matchComponentKey(component, Object.keys(THRESHOLDS));
    var base = key ? THRESHOLDS[key] : THRESHOLDS[THRESHOLD_FALLBACK];
    if (!model) return base;
    var ov = modelOverride(model, component);
    if (!ov || !Object.keys(ov).length) return base;
    // Gabung: override model menimpa nilai kompartemen per-parameter.
    var merged = {};
    Object.keys(base).forEach(function (pk) {
      merged[pk] = ov[pk] ? Object.assign({}, base[pk], ov[pk]) : base[pk];
    });
    // Tambahkan parameter baru yang hanya ada di override model.
    Object.keys(ov).forEach(function (pk) {
      if (!merged[pk]) merged[pk] = Object.assign({}, ov[pk]);
    });
    return merged;
  }

  /** Apakah ada override threshold untuk model ini (di kompartemen apa pun)? */
  function hasModelOverrides(model) {
    return matchModelCandidateKeys(model).length > 0;
  }

  /** Daftar nama model yang punya override (untuk UI). */
  function listModelKeys() {
    return Object.keys(MODEL_THRESHOLDS);
  }

  function getComponentWeight(component) {
    var key = matchComponentKey(component, Object.keys(COMPONENT_WEIGHTS));
    return key ? COMPONENT_WEIGHTS[key] : 0.8;
  }

  /* -----------------------------------------------------------------------
   * Export
   * --------------------------------------------------------------------- */
  global.SOS_CONFIG = {
    PARAMS: PARAMS,
    COL_MAP: COL_MAP,
    THRESHOLDS: THRESHOLDS,
    THRESHOLD_FALLBACK: THRESHOLD_FALLBACK,
    COMPONENT_WEIGHTS: COMPONENT_WEIGHTS,
    CRITICALITY: CRITICALITY,
    CHART_CLUSTERS: CHART_CLUSTERS,
    DIAGNOSTIC_RULES: DIAGNOSTIC_RULES,
    TIER_LABELS: TIER_LABELS,
    TIER_COLORS: TIER_COLORS,
    TIER_ICONS: TIER_ICONS,
    TIER_KEYS: TIER_KEYS,
    TIER_ALIAS: TIER_ALIAS,
    tierLabelOf: tierLabelOf,
    tierColorOf: tierColorOf,
    normalizeTierKey: normalizeTierKey,
    tierFromSeverity: tierFromSeverity,
    getThresholdsFor: getThresholdsFor,
    getComponentWeight: getComponentWeight,
    sanitizeValue: sanitizeValue,
    isAnomalous: isAnomalous,
    // [BARU 2026-10-01] Override threshold per MODEL unit.
    MODEL_THRESHOLDS: MODEL_THRESHOLDS,
    matchModelKey: matchModelKey,
    matchModelCandidateKeys: matchModelCandidateKeys,
    modelOverride: modelOverride,
    hasModelOverrides: hasModelOverrides,
    listModelKeys: listModelKeys,
    normModel: normModel,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SOS_CONFIG;
  }

})(typeof window !== 'undefined' ? window : globalThis);

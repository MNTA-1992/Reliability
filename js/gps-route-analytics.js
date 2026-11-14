/* =========================================================================
 * gps-route-analytics.js
 * -------------------------------------------------------------------------
 * [GPS ROUTE REPAIR INTELLIGENCE · 2026-11-02]
 * Modul Analitik Murni (Pure Analytics Engine):
 *   - Join route ↔ assignment ↔ Fuel trending data;
 *   - Gerbang cakupan pembuktian fuel (Evidence Gates §5.D);
 *   - Formula prioritas transparan P1 / P2 / P3 (§6);
 *   - Normalisasi bobot tanpa pembuktian fuel (redistribusi bobot, bukan 0);
 *   - Bebas DOM, bebas I/O, bekerja di peramban dan di Node.js.
 * ========================================================================= */

(function (global) {
  'use strict';

  /* -----------------------------------------------------------------------
   * Konfigurasi Terpusat (§6 & §5.D)
   * SATU TEMPAT: jangan hardcode ambang di pemanggil atau renderer.
   * --------------------------------------------------------------------- */
  var GPS_ROUTE_CONFIG = {
    // Bobot formula prioritas (§6): P = 0.45 * S + 0.30 * E + 0.25 * F
    weights: {
      segment: 0.45,
      exposure: 0.30,
      fuel: 0.25
    },

    // Gerbang pembuktian Fuel (§5.D)
    fuelGate: {
      minUnits: 5,               // minimal 5 unit dengan data Fuel
      minDaysPerUnit: 2,         // minimal 2 hari exposure per unit untuk analisis dalam-unit
      maxDeltaPctNorm: 20        // +20% kenaikan L/ton-km dinormalisasi ke skor 100
    },

    // Normalisasi eksposur
    exposureNorm: {
      maxDays: 150,              // 150 eq-days = 60 poin
      maxUnits: 60               // 60 unit = 40 poin
    },

    // Ambang severity segmen
    severity: {
      critical: 75,
      high: 55,
      moderate: 35
    },

    // Ambang Tier Prioritas
    priorityTiers: {
      // P1: Severity tinggi dan exposure tinggi; ATAU severity tinggi + fuel impact terukur
      p1SeverityThreshold: 70,
      p1ExposureThreshold: 50,
      p1FuelSeverityThreshold: 60,
      p1FuelImpactThreshold: 40,
      p1MinScore: 70,

      // P2: Moderat
      p2MinScore: 40
    }
  };

  /* -----------------------------------------------------------------------
   * Utilitas Matematika Murni
   * --------------------------------------------------------------------- */

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function round(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return null;
    var p = Math.pow(10, dec || 0);
    return Math.round(v * p) / p;
  }

  function median(arr) {
    var valid = (arr || []).filter(function (x) { return x !== null && x !== undefined && isFinite(x); });
    if (!valid.length) return null;
    valid.sort(function (a, b) { return a - b; });
    var mid = valid.length >> 1;
    return (valid.length % 2 === 1) ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
  }

  function mean(arr) {
    var valid = (arr || []).filter(function (x) { return x !== null && x !== undefined && isFinite(x); });
    if (!valid.length) return null;
    var sum = valid.reduce(function (acc, val) { return acc + val; }, 0);
    return sum / valid.length;
  }

  function normKey(s) {
    return String(s == null ? '' : s).trim().replace(/[\s._\-/]+/g, '').toUpperCase();
  }

  /* -----------------------------------------------------------------------
   * Pemetaan Unit (§2 & §8)
   * Kontrak: Bila Unit DB belum memetakan serial ke lambung, tampilkan status
   * 'identitas belum terpetakan', jangan mencocokkan dengan tebakan.
   * --------------------------------------------------------------------- */

  function resolveUnitMapping(gpsUnitId, fuelUnits, unitDb) {
    var cleanGps = normKey(gpsUnitId);
    if (!cleanGps) return { matched: false, fuelUnit: null, status: 'empty' };

    fuelUnits = fuelUnits || [];

    // Cari di daftar Fuel Units
    for (var i = 0; i < fuelUnits.length; i++) {
      var fu = fuelUnits[i];
      var serial = String(fu.serial || '').trim();
      var cleanSerial = normKey(serial);
      var key = String(fu.key || '');

      // 1. Apakah serial langsung sama dengan GPS ID?
      if (cleanSerial && cleanSerial === cleanGps) {
        return {
          matched: true,
          fuelUnit: fu,
          serial: serial,
          lambung: gpsUnitId,
          matchType: 'direct-serial'
        };
      }

      // 2. Apakah key (tanpa S:) sama dengan GPS ID?
      var cleanKey = normKey(key.replace(/^S:/i, ''));
      if (cleanKey && cleanKey === cleanGps) {
        return {
          matched: true,
          fuelUnit: fu,
          serial: serial || key,
          lambung: gpsUnitId,
          matchType: 'direct-key'
        };
      }

      // 3. Apakah Unit DB memetakan serial ke lambung ini?
      if (unitDb && typeof unitDb.getLambung === 'function' && serial) {
        var mappedLambung = unitDb.getLambung(serial);
        if (mappedLambung && normKey(mappedLambung) === cleanGps) {
          return {
            matched: true,
            fuelUnit: fu,
            serial: serial,
            lambung: mappedLambung,
            matchType: 'unitdb-mapped'
          };
        }
      }
    }

    // Tidak ada mapping resmi
    return {
      matched: false,
      fuelUnit: null,
      serial: null,
      lambung: gpsUnitId,
      status: 'unmapped'
    };
  }

  /* -----------------------------------------------------------------------
   * Analisis Dampak Fuel per Rute (§5.D & §6)
   * Tiga tingkat bukti:
   *   1. Paparan operasi (unit, km, hari)
   *   2. Fuel level (median L/ton-km)
   *   3. Perbandingan (delta vs baseline unit yang sama)
   * --------------------------------------------------------------------- */

  function analyzeRouteFuelImpact(routeId, assignments, fuelUnits, unitDb, dateRange) {
    var routeAssignments = (assignments || []).filter(function (a) {
      if (a.route_id !== routeId) return false;
      if (dateRange && dateRange.start && a.date < dateRange.start) return false;
      if (dateRange && dateRange.end && a.date > dateRange.end) return false;
      return true;
    });

    // Kelompokkan assignment per unit
    var byUnit = {};
    routeAssignments.forEach(function (a) {
      var u = byUnit[a.unit] || (byUnit[a.unit] = {
        unit: a.unit,
        dates: {},
        distances: [],
        grades: [],
        climbs: []
      });
      u.dates[a.date] = true;
      if (a.distance_km != null) u.distances.push(a.distance_km);
      if (a.grade_pct != null) u.grades.push(a.grade_pct);
      if (a.climb_per_km_m != null) u.climbs.push(a.climb_per_km_m);
    });

    var unitNames = Object.keys(byUnit).sort();
    var unitsTotal = unitNames.length;

    var unitTable = [];
    var allRouteLtks = [];
    var allBaselineLtks = [];
    var qualifiedUnitsCount = 0;
    var unitsWithFuelCount = 0;

    unitNames.forEach(function (uName) {
      var uData = byUnit[uName];
      var dateCount = Object.keys(uData.dates).length;
      var totalKm = uData.distances.reduce(function (s, d) { return s + d; }, 0);
      var medGrade = median(uData.grades);
      var avgClimb = mean(uData.climbs);

      var mapping = resolveUnitMapping(uName, fuelUnits, unitDb);
      var fu = mapping.matched ? mapping.fuelUnit : null;

      var unitFuelDays = 0;
      var unitRouteLtks = [];
      var unitBaselineLtk = null;

      if (fu && fu.summary) {
        // Ambil baseline unit
        var baseObj = fu.summary.baseline;
        if (baseObj && baseObj.lTk != null) {
          unitBaselineLtk = num(baseObj.lTk);
        }

        // Cari jendela fuel pada tanggal exposure rute ini
        var windows = fu.summary.windows || [];
        var allUnitLtks = [];
        windows.forEach(function (w) {
          if (!w || !w.date) return;
          var val = num(w.lTk);
          if (val !== null && val > 0) {
            allUnitLtks.push(val);
            if (uData.dates[w.date]) {
              unitFuelDays++;
              unitRouteLtks.push(val);
            }
          }
        });

        if (unitBaselineLtk === null && allUnitLtks.length >= 3) {
          unitBaselineLtk = median(allUnitLtks);
        }
      }

      var hasFuel = unitRouteLtks.length > 0;
      if (hasFuel) unitsWithFuelCount++;

      // Evaluasi apakah memenuhi batas exposure dalam-unit
      var isQualified = hasFuel && dateCount >= GPS_ROUTE_CONFIG.fuelGate.minDaysPerUnit;
      if (isQualified) qualifiedUnitsCount++;

      var medRouteLtk = median(unitRouteLtks);
      var deltaPct = (medRouteLtk !== null && unitBaselineLtk !== null && unitBaselineLtk > 0)
        ? ((medRouteLtk - unitBaselineLtk) / unitBaselineLtk) * 100
        : null;

      if (medRouteLtk !== null) allRouteLtks.push(medRouteLtk);
      if (unitBaselineLtk !== null) allBaselineLtks.push(unitBaselineLtk);

      unitTable.push({
        unit: uName,
        mappedSerial: mapping.serial || null,
        mappingStatus: mapping.status || (mapping.matched ? 'mapped' : 'unmapped'),
        activeDays: dateCount,
        exposureKm: round(totalKm, 1),
        medianGradePct: round(medGrade, 2),
        climbPerKmM: round(avgClimb, 1),
        hasFuelData: hasFuel,
        fuelDays: unitFuelDays,
        medianLtk: round(medRouteLtk, 3),
        baselineLtk: round(unitBaselineLtk, 3),
        deltaPct: round(deltaPct, 1),
        isQualified: isQualified
      });
    });

    // Urutkan unit table: yang memiliki data fuel dan hari aktif terbanyak di atas
    unitTable.sort(function (a, b) {
      if (a.hasFuelData !== b.hasFuelData) return a.hasFuelData ? -1 : 1;
      return b.activeDays - a.activeDays;
    });

    // Evaluasi Gerbang Evidence (§5.D):
    // Paling sedikit 5 unit dengan data Fuel & exposure layak
    var gate = GPS_ROUTE_CONFIG.fuelGate;
    var gatePassed = qualifiedUnitsCount >= gate.minUnits;

    var routeMedianLtk = null;
    var baselineMedianLtk = null;
    var deltaLtkPct = null;
    var fuelScore = null;
    var narrative = '';
    var coverageRatio = unitsTotal > 0 ? unitsWithFuelCount / unitsTotal : 0;
    var coverageText = unitsWithFuelCount + '/' + unitsTotal + ' unit memiliki data Fuel';

    if (gatePassed) {
      routeMedianLtk = median(allRouteLtks);
      baselineMedianLtk = median(allBaselineLtks);
      if (routeMedianLtk !== null && baselineMedianLtk !== null && baselineMedianLtk > 0) {
        deltaLtkPct = ((routeMedianLtk - baselineMedianLtk) / baselineMedianLtk) * 100;
        // Normalisasi Fuel Score: jika delta <= 0 -> 0; jika delta >= 20% -> 100
        if (deltaLtkPct <= 0) {
          fuelScore = 0;
        } else {
          fuelScore = Math.min(100, (deltaLtkPct / gate.maxDeltaPctNorm) * 100);
        }
      }

      var deltaStr = deltaLtkPct !== null ? (deltaLtkPct >= 0 ? '+' : '') + deltaLtkPct.toFixed(1) + '%' : '—';
      narrative = unitsWithFuelCount + ' unit memiliki data Fuel yang cukup. ' +
        'Median L/ton-km pada hari ter-assign ' + routeId + ' adalah ' + deltaStr +
        ' vs baseline unit yang sama. Ini indikasi untuk inspeksi, bukan pembuktian sebab-akibat.';
    } else {
      fuelScore = null; // KONTRAK §6: jika bukti belum lolos, nilainya null
      if (unitsWithFuelCount === 0) {
        narrative = 'Menunggu data Fuel. Data exposure jalan disajikan tanpa analisis dampak efisiensi.';
      } else {
        narrative = unitsWithFuelCount + '/' + unitsTotal + ' unit memiliki data Fuel ' +
          '(belum memenuhi gerbang minimum ' + gate.minUnits + ' unit dengan ≥' + gate.minDaysPerUnit + ' hari exposure). ' +
          'Data exposure ditampilkan tanpa kesimpulan dampak fuel.';
      }
    }

    return {
      gatePassed: gatePassed,
      unitsTotal: unitsTotal,
      unitsWithFuel: unitsWithFuelCount,
      unitsQualified: qualifiedUnitsCount,
      coverageRatio: round(coverageRatio, 3),
      coverageText: coverageText,
      routeMedianLtk: round(routeMedianLtk, 3),
      baselineMedianLtk: round(baselineMedianLtk, 3),
      deltaLtkPct: round(deltaLtkPct, 1),
      fuelScore: round(fuelScore, 1),
      narrative: narrative,
      unitTable: unitTable
    };
  }

  /* -----------------------------------------------------------------------
   * Formula Prioritas Awal (§6)
   * P = 0.45 * S + 0.30 * E + 0.25 * F
   * Jika F null, bobot TIDAK diisi nol: P = (0.45 * S + 0.30 * E) / (0.45 + 0.30)
   * --------------------------------------------------------------------- */

  function calculatePriority(segmentSeverity, exposureScore, fuelScore, customWeights) {
    var S = num(segmentSeverity) || 0;
    var E = num(exposureScore) || 0;
    var F = (fuelScore !== null && fuelScore !== undefined && isFinite(fuelScore)) ? num(fuelScore) : null;

    var w = Object.assign({}, GPS_ROUTE_CONFIG.weights, customWeights || {});
    var P = 0;
    var fuelIncluded = false;
    var badge = null;

    if (F !== null) {
      // Tiga bukti lengkap
      P = (w.segment * S) + (w.exposure * E) + (w.fuel * F);
      fuelIncluded = true;
      badge = null;
    } else {
      // Kontrak §6: Bobot fuel diredistribusikan ke bukti yang ada
      var activeWeights = w.segment + w.exposure;
      if (activeWeights > 0) {
        P = ((w.segment * S) + (w.exposure * E)) / activeWeights;
      } else {
        P = 0;
      }
      fuelIncluded = false;
      badge = 'impact fuel belum cukup';
    }

    P = Math.max(0, Math.min(100, P));

    // Penentuan Tier (§6)
    var tiers = GPS_ROUTE_CONFIG.priorityTiers;
    var tier = 'P3';

    // P1: Severity tinggi dan exposure tinggi; ATAU severity tinggi + fuel impact terukur; ATAU P >= 70
    var isP1 = (S >= tiers.p1SeverityThreshold && E >= tiers.p1ExposureThreshold) ||
               (S >= tiers.p1FuelSeverityThreshold && F !== null && F >= tiers.p1FuelImpactThreshold) ||
               (P >= tiers.p1MinScore);

    if (isP1) {
      tier = 'P1';
    } else if (P >= tiers.p2MinScore || S >= GPS_ROUTE_CONFIG.severity.high) {
      tier = 'P2';
    } else {
      tier = 'P3';
    }

    return {
      score: round(P, 1),
      tier: tier,
      fuelIncluded: fuelIncluded,
      badge: badge,
      components: {
        segmentSeverity: S,
        exposureScore: E,
        fuelScore: F
      }
    };
  }

  /* -----------------------------------------------------------------------
   * Analisis Lengkap Satu Rute
   * --------------------------------------------------------------------- */

  function analyzeRoute(route, assignments, segments, fuelUnits, unitDb, dateRange) {
    if (!route || !route.route_id) return null;
    var rId = route.route_id;

    // Filter segmen perbaikan untuk rute ini
    var rSegments = (segments || []).filter(function (s) { return s.route_id === rId; });

    // Hitung S_segment: severity tertinggi dari segmen kandidat
    var maxSeverity = 0;
    var highSeverityCount = 0;
    var sampleGrade = route.avgGradePct || null;
    var sampleSpeed = null;

    if (rSegments.length > 0) {
      rSegments.forEach(function (s) {
        if (s.severity > maxSeverity) {
          maxSeverity = s.severity;
          sampleGrade = s.avg_grade_pct;
          sampleSpeed = s.avg_speed_kmh;
        }
        if (s.severity >= GPS_ROUTE_CONFIG.severity.critical) {
          highSeverityCount++;
        }
      });
    } else {
      // Jika tidak ada segmen di repair-segments, gunakan grade dasar
      maxSeverity = route.avgGradePct ? Math.min(100, Math.round(route.avgGradePct * 12)) : 0;
    }

    // Hitung E_exposure: gabungan unit-days dan unit unik
    var eqDays = route.eq_days || 0;
    var unitCount = route.unit_count || (route.units ? route.units.length : 0);
    var norm = GPS_ROUTE_CONFIG.exposureNorm;
    var expScoreDays = Math.min(60, (eqDays / norm.maxDays) * 60);
    var expScoreUnits = Math.min(40, (unitCount / norm.maxUnits) * 40);
    var exposureScore = round(expScoreDays + expScoreUnits, 1);

    // Hitung F_fuel & tabel unit
    var fuelImpact = analyzeRouteFuelImpact(rId, assignments, fuelUnits, unitDb, dateRange);

    // Hitung P & Tier
    var prio = calculatePriority(maxSeverity, exposureScore, fuelImpact.fuelScore);

    // Alasan pembentuk severity
    var severityReason = '';
    if (sampleGrade != null && sampleSpeed != null) {
      severityReason = 'Grade ' + sampleGrade + '%, speed ' + sampleSpeed + ' km/h';
    } else if (sampleGrade != null) {
      severityReason = 'Grade rerata ' + sampleGrade + '%';
    } else {
      severityReason = 'Kandidat inspeksi';
    }

    // Label indikasi: tidak boleh otomatis menyatakan "rusak", sebut "Kandidat inspeksi"
    var indicationLabel = 'Kandidat inspeksi';
    if (maxSeverity >= GPS_ROUTE_CONFIG.severity.critical) {
      indicationLabel = 'Kandidat inspeksi tanjakan / grade curam';
    } else if (maxSeverity >= GPS_ROUTE_CONFIG.severity.high) {
      indicationLabel = 'Kandidat inspeksi permukaan jalan';
    } else {
      indicationLabel = 'Monitor berkala';
    }

    return {
      route_id: rId,
      master: route,
      segments: rSegments,
      segmentCount: rSegments.length,
      maxSeverity: maxSeverity,
      highSeverityCount: highSeverityCount,
      severityReason: severityReason,
      indicationLabel: indicationLabel,
      eqDays: eqDays,
      unitCount: unitCount,
      exposureKm: route.distanceKm || null,
      exposureScore: exposureScore,
      fuelImpact: fuelImpact,
      priority: prio
    };
  }

  /* -----------------------------------------------------------------------
   * Analisis Seluruh Armada & KPI Summary
   * --------------------------------------------------------------------- */

  function analyzeFleetRoutes(routes, assignments, segments, fuelUnits, unitDb, filterOpts) {
    filterOpts = filterOpts || {};
    var dateRange = (filterOpts.startDate || filterOpts.endDate)
      ? { start: filterOpts.startDate || '', end: filterOpts.endDate || '' }
      : null;

    var analyzedRoutes = (routes || []).map(function (r) {
      return analyzeRoute(r, assignments, segments, fuelUnits, unitDb, dateRange);
    }).filter(Boolean);

    // Terapkan filter opsional
    if (filterOpts.routeId) {
      analyzedRoutes = analyzedRoutes.filter(function (ar) { return ar.route_id === filterOpts.routeId; });
    }
    if (filterOpts.minSeverity != null && filterOpts.minSeverity > 0) {
      analyzedRoutes = analyzedRoutes.filter(function (ar) { return ar.maxSeverity >= filterOpts.minSeverity; });
    }
    if (filterOpts.tier) {
      analyzedRoutes = analyzedRoutes.filter(function (ar) { return ar.priority.tier === filterOpts.tier; });
    }

    // Urutan default (§4.C):
    // P1 lalu P2 lalu P3; di dalam tier: severity tertinggi, unit terdampak terbanyak, exposure km
    var tierOrder = { P1: 1, P2: 2, P3: 3 };
    analyzedRoutes.sort(function (a, b) {
      var tA = tierOrder[a.priority.tier] || 99;
      var tB = tierOrder[b.priority.tier] || 99;
      if (tA !== tB) return tA - tB;
      if (b.maxSeverity !== a.maxSeverity) return b.maxSeverity - a.maxSeverity;
      if (b.unitCount !== a.unitCount) return b.unitCount - a.unitCount;
      return (b.exposureKm || 0) - (a.exposureKm || 0);
    });

    // KPI Ringkas (§4.B):
    // 1. Area prioritas inspeksi: jumlah route yang punya segmen severity tinggi / P1
    var priorityRoutes = analyzedRoutes.filter(function (ar) {
      return ar.priority.tier === 'P1' || ar.maxSeverity >= GPS_ROUTE_CONFIG.severity.high;
    });
    var priorityAreaCount = priorityRoutes.length;

    // 2. Unit terdampak: jumlah unit unik pada route prioritas
    var impactedUnitsMap = {};
    priorityRoutes.forEach(function (ar) {
      (ar.master.units || []).forEach(function (u) { impactedUnitsMap[u] = true; });
    });
    var impactedUnitsCount = Object.keys(impactedUnitsMap).length;

    // 3. Paparan operasi: total unit-hari & total km pada route prioritas
    var totalEqDays = 0;
    var totalExposureKm = 0;
    priorityRoutes.forEach(function (ar) {
      totalEqDays += (ar.eqDays || 0);
      totalExposureKm += (ar.exposureKm || 0);
    });

    // 4. Impact fuel terukur: median perubahan L/ton-km untuk unit yang terpapar
    var routesWithFuelGate = analyzedRoutes.filter(function (ar) {
      return ar.fuelImpact && ar.fuelImpact.gatePassed && ar.fuelImpact.deltaLtkPct !== null;
    });

    var fleetDeltaLtks = routesWithFuelGate.map(function (ar) { return ar.fuelImpact.deltaLtkPct; });
    var medianDeltaLtk = median(fleetDeltaLtks);

    var totalUnitsWithFuelInFleet = 0;
    var totalAssignedUnitsInFleet = 0;
    var fleetUnitsEncountered = {};
    var fleetUnitsWithFuel = {};

    analyzedRoutes.forEach(function (ar) {
      (ar.fuelImpact.unitTable || []).forEach(function (u) {
        fleetUnitsEncountered[u.unit] = true;
        if (u.hasFuelData) fleetUnitsWithFuel[u.unit] = true;
      });
    });
    totalAssignedUnitsInFleet = Object.keys(fleetUnitsEncountered).length;
    totalUnitsWithFuelInFleet = Object.keys(fleetUnitsWithFuel).length;

    var fleetFuelCoverageText = totalUnitsWithFuelInFleet + '/' + Math.max(1, totalAssignedUnitsInFleet) + ' unit memiliki data Fuel';

    return {
      routes: analyzedRoutes,
      kpi: {
        priorityAreaCount: priorityAreaCount,
        totalRoutesCount: analyzedRoutes.length,
        impactedUnitsCount: impactedUnitsCount,
        operatingExposureDays: totalEqDays,
        operatingExposureKm: round(totalExposureKm, 1),
        medianDeltaLtkPct: round(medianDeltaLtk, 1),
        routesWithFuelCount: routesWithFuelGate.length,
        fuelCoverageText: fleetFuelCoverageText,
        hasFuelImpactData: routesWithFuelGate.length > 0
      }
    };
  }

  /* -----------------------------------------------------------------------
   * Export API
   * --------------------------------------------------------------------- */

  var API = {
    CONFIG: GPS_ROUTE_CONFIG,
    num: num,
    round: round,
    median: median,
    mean: mean,
    resolveUnitMapping: resolveUnitMapping,
    analyzeRouteFuelImpact: analyzeRouteFuelImpact,
    calculatePriority: calculatePriority,
    analyzeRoute: analyzeRoute,
    analyzeFleetRoutes: analyzeFleetRoutes
  };

  global.GPS_ROUTE_ANALYTICS = API;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof window !== 'undefined' ? window : global);

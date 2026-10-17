// EDA view: upper-ocean heat content, El Nino vs. non-ENSO marine heatwaves
// (2026-10-17, user; EDA list item 2), on the line-view engine (eda_lineview.js:
// the time series with RONI/SCTI, Hobday-style categories, A/B/C markers, three
// comparison sections). Here:
//
//  - the season's value: the 0-200 m heat-content anomaly averaged over the
//    line's stations; marine heatwaves = the engine's Hobday et al. (2016)
//    categories on it (user, 2026-10-17);
//  - the sections: temperature anomaly, 0-200 m (as the map's anomaly
//    sections), on one symmetric scale.
//
// Heat-content anomaly at a station = rho * cp * integral over 0-200 m of the
// temperature anomaly (each standard depth minus its harmonic seasonal cycle,
// as the Anomalies view: section.js sectionAnomalies), trapezoidal over the
// standard depths; rho cp = 1025 * 3990 J m^-3 K^-1; in GJ m^-2. A station
// counts when its anomaly profile starts within 10 m of the surface and reaches
// 200 m; a season needs HEAT_MIN_STATIONS of them. The time series shows it
// against its calendar season's baseline mean (near zero, as it is already an
// anomaly). Defaults (user): line 90, CTD, winter 1998, autumn 2015, winter 2026.
"use strict";

const HEAT_DEPTH = 200;
const HEAT_RHO_CP = 1025 * 3990;            // J m^-3 K^-1
const HEAT_MIN_STATIONS = 3;
const HEAT_VAR = { label: "Temperature anomaly", units: "°C", col: "t", style: "temperature", anomaly: true, diverging: true, maxDepth: HEAT_DEPTH };

// The season's heat-content anomaly, GJ m^-2 (null with too few stations).
function heatContent(d, geo, src, lineKey, step) {
  const depths = src.depths;
  let profiles = sectionProfiles(d, step.periods, geo, src);
  profiles = sectionAnomalies(d, profiles, HEAT_VAR, step.periods, src, lineKey);
  const vals = [];
  for (const p of profiles) {
    const pts = (p.t || []).map((v, k) => [depths[k], v]).filter(([z, v]) => v !== null && z <= HEAT_DEPTH);
    if (pts.length < 4 || pts[0][0] > 10 || pts[pts.length - 1][0] < HEAT_DEPTH) continue;
    let integral = pts[0][1] * pts[0][0];                 // the top value up to the surface
    for (let k = 1; k < pts.length; k++) integral += ((pts[k][1] + pts[k - 1][1]) / 2) * (pts[k][0] - pts[k - 1][0]);
    vals.push((HEAT_RHO_CP * integral) / 1e9);
  }
  return vals.length >= HEAT_MIN_STATIONS ? { value: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
}

const heatView = makeLineView({
  id: "heat",
  defaults: { line: 90, source: "ctd", panels: ["1998-winter", "2015-autumn", "2026-winter"] },
  hash: { line: "hline", source: "hsrc", panels: "hp" },
  col: "t",
  sectionVar: HEAT_VAR,
  seasonValue: heatContent,
  anomalySign: 1,
  minAxis: 0.2,
  niceTop: (a) => Math.ceil(a * 4) / 4,
  axisLabel: "heat content anomaly (GJ m⁻²)",
  upLabel: "Warmer",
  downLabel: "Cooler",
  barColor: (r) => (r.anom >= 0 ? "#e3a9a0" : "#8fb3d9"),
  eventName: "heatwave",
  eventLabel: "Heatwaves",
  caption: (r) => `heat content ${signedValue(+r.value.toFixed(2))} GJ m⁻²`,
  tooFew: "too few full-depth stations for heat content",
  sectionTooFew: (v, step) => `Too few of line ${v.line}'s stations with a climatology were sampled in ${seasonText(step)}.`,
  emptyNote: "No seasons with enough full-depth stations.",
  panelScale: (secs) => {
    const top = Math.ceil(Math.max(0.5, ...secs.map((s) => Math.max(...s.values.map(Math.abs)))) * 2) / 2;
    return { lo: -top, hi: top, maps: 0 };
  },
  note: (v, src, fixed) => `Heat-content anomaly, 0–${HEAT_DEPTH} m, mean over line ${v.line}'s stations (${src.label}); temperature anomalies from each ` +
    `station's harmonic seasonal cycle at each depth (${ANOMALY_MIN_YEARS}+ years). Sections: temperature anomaly, 0–${HEAT_DEPTH} m, on one scale (±${fixed.hi} °C).`,
});

// Names atlas.js calls.
const renderEdaHeat = () => heatView.render();
const writeEdaHeatHash = (params) => heatView.writeHash(params);
const readEdaHeatHash = (params) => heatView.readHash(params);

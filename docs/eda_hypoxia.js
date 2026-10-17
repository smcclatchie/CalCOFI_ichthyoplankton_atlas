// EDA view: depth of the hypoxic layer (2026-10-17, user; EDA list item 6), on
// the line-view engine (eda_lineview.js), in the heat-content view's layout:
//
//  - the season's value: the depth of the hypoxic boundary -- the shallowest
//    depth where dissolved oxygen falls below HYPOXIA_ML_L (1.4 mL/L, about
//    2 mg/L or 60 umol/kg, the usual California Current hypoxia threshold) --
//    averaged over the line's stations; the time series shows it as an anomaly
//    from its calendar season, positive = SHOALING (the hypoxic layer nearer
//    the surface); "shoaling events" are the engine's Hobday-style categories
//    on that shoaling;
//  - the sections: dissolved oxygen (as the map's oxygen sections), on one
//    scale from 0, with the 1.4 mL/L contour drawn bold.
//
// The boundary at a station is interpolated linearly between the standard depths
// either side of the first value below the threshold. A station counts when its
// oxygen profile starts within 10 m of the surface; a station whose profile
// never falls below the threshold has a boundary deeper than its deepest sample
// and is left out of the mean (counted as "deeper"); a season needs
// HYPOXIA_MIN_STATIONS stations with a boundary.
"use strict";

const HYPOXIA_ML_L = 1.4;
const HYPOXIA_MIN_STATIONS = 3;
const HYPOXIA_VAR = { label: "Dissolved oxygen", units: "mL/L", col: "o", style: "oxygen", highlight: HYPOXIA_ML_L };

// The season's mean hypoxic-boundary depth, m (null with too few stations).
function hypoxicDepth(d, geo, src, lineKey, step) {
  const depths = src.depths, vals = [];
  let deeper = 0;
  for (const p of sectionProfiles(d, step.periods, geo, src)) {
    const pts = (p.o || []).map((v, k) => [depths[k], v]).filter(([, v]) => v !== null);
    if (pts.length < 3 || pts[0][0] > 10) continue;
    const k = pts.findIndex(([, v]) => v < HYPOXIA_ML_L);
    if (k < 0) { deeper++; continue; }
    if (k === 0) { vals.push(pts[0][0]); continue; }
    const [z0, o0] = pts[k - 1], [z1, o1] = pts[k];
    vals.push(z0 + ((o0 - HYPOXIA_ML_L) / (o0 - o1)) * (z1 - z0));
  }
  return vals.length >= HYPOXIA_MIN_STATIONS ? { value: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length, deeper } : null;
}

const hypoxiaView = makeLineView({
  id: "hyp",
  defaults: { line: 90, source: "ctd", panels: ["1998-winter", "2015-autumn", "2026-winter"] },
  hash: { line: "xline", source: "xsrc", panels: "xp" },
  col: "o",
  sectionVar: HYPOXIA_VAR,
  seasonValue: hypoxicDepth,
  anomalySign: -1,                 // shoaling (a shallower boundary) counts as positive
  minAxis: 10,
  niceTop: (a) => Math.ceil(a / 50) * 50,      // ticks at whole tens of metres
  axisLabel: "shoaling of the 1.4 mL/L depth (m)",
  barColor: (r) => (r.anom >= 0 ? "#e3a9a0" : "#8fb3d9"),
  eventName: "shoaling event",
  eventLabel: "Shoaling events",
  caption: (r) => `1.4 mL/L at ${Math.round(r.value)} m (${r.anom >= 0 ? "shoaler" : "deeper"} by ${Math.abs(Math.round(r.anom))} m; ` +
    `${r.n} stations${r.deeper ? `, ${r.deeper} without hypoxia` : ""})`,
  tooFew: "too few stations reaching hypoxic water",
  sectionTooFew: (v, step) => `Line ${v.line} was not sampled at enough stations in ${seasonText(step)}.`,
  emptyNote: "No seasons with enough stations reaching hypoxic water.",
  panelScale: (secs) => ({ lo: 0, hi: Math.ceil(Math.max(1.5, ...secs.map((s) => Math.max(...s.values))) * 2) / 2, maps: 0 }),
  note: (v, src, fixed) => `Depth of the hypoxic boundary (the shallowest depth with oxygen below ${HYPOXIA_ML_L} mL/L, interpolated between standard depths), ` +
    `mean over line ${v.line}'s stations (${src.label}); stations never below it within their deepest sample are left out. Bars: anomaly from the ` +
    `calendar season's baseline mean, up = shoaling. Sections: dissolved oxygen, 0–${fixed.hi} mL/L, ${HYPOXIA_ML_L} mL/L contour bold.`,
});

// Names atlas.js calls.
const renderEdaHypoxia = () => hypoxiaView.render();
const writeEdaHypoxiaHash = (params) => hypoxiaView.writeHash(params);
const readEdaHypoxiaHash = (params) => hypoxiaView.readHash(params);

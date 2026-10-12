// Hydrography view of the CalCOFI atlas: temperature, salinity and density
// (sigma-theta) at the CalCOFI standard depths, from the bottle (1949-2021)
// or CTD (1993-2026) data -- never mixed -- mapped as smooth contours.
//
// Data (docs/data/hydro/, built by python/build_hydro_data.py):
//   meta.json                per source: survey months + cruises, stations,
//                            fixed colour ranges (1st-99th percentiles)
//   <source>/<depth>.json    station x survey month values: p, st, n (casts),
//                            t, s, d, o, no3, sio3 (temperature, salinity,
//                            sigma-theta, oxygen, nitrate, silicate)
//
// Mapping. Station values (the mean of the casts in the survey month, or of
// the survey months in the season) are spread onto a grid as a Gaussian-
// weighted mean, weight exp(-(r/L)^2) with e-folding scale L (default 75 km,
// about the station spacing), so the contours are smooth and carry no
// structure finer than the stations can support. The field is shown only
// inside the stations' convex hull and within MAX_GAP_KM of a station, so
// nothing is extrapolated; land is drawn over it. Contours come from d3-contour.
//
// Style follows the Fishing Maps products (recreational_fishing_high_resolution,
// prepare_*_reference_geotiff_and_plot.py): temperature as SST (colorcet
// rainbow_bgyrm_35_85_c69, smooth fill, thin white contours, black land),
// salinity as SSH (cmocean balance, filled bands, black contours, seagreen
// land), sigma-theta as MLD (cmocean dense, smooth fill, white contours,
// seagreen land); oxygen, nitrate and silicate (no Fishing Maps layers) use
// cmocean deep/matter/tempo in the same style. Fills are drawn at 85% opacity over black there, so the
// palettes here are darkened to match. Contour labels are matplotlib-style
// inline labels: in the line colour, along the line, with the line broken
// around them.
"use strict";

const HYDRO = "data/hydro/";
const MAX_GAP_KM = 70;
const GRID_MARGIN_DEG = 1.0;       // > MAX_GAP_KM, so the grid's edges are always masked
const GRID_MAX_CELLS = 230;        // along the longer side
const SMOOTHING_KM = [50, 75, 100, 125];
const MASK_COLOR = "#f3f6f9";      // the map's ocean colour
// Palette stops sampled from the Fishing Maps colormaps (13 per map).
const HYDRO_STYLES = {
  temperature: {   // SST: colorcet m_rainbow_bgyrm_35_85_c69
    stops: ["#0030f5", "#1769ad", "#39886d", "#47a325", "#82b513", "#bcc31c", "#f1ca24", "#f9b020", "#f68e19", "#f16715", "#f55945", "#ff749d", "#fd92fa"],
    smooth: true, line: "#ffffff", lineWidth: 0.7, land: "#000000",
  },
  salinity: {      // SSH: cmocean balance
    stops: ["#181c43", "#293888", "#0c5ebe", "#3888ba", "#75aabe", "#b6c9cf", "#f1eceb", "#dfbbb0", "#d08b73", "#bf573a", "#a52125", "#730e27", "#3c0912"],
    smooth: false, line: "#000000", lineWidth: 1.1, land: "#2e8b57",
  },
  sigma_theta: {   // MLD: cmocean dense
    stops: ["#e6f1f1", "#c2dfe6", "#a2cee2", "#86b9e3", "#76a4e5", "#748be2", "#7871d5", "#7959c0", "#7642a5", "#6e2d84", "#621d62", "#4f1440", "#360e24"],
    smooth: true, line: "#ffffff", lineWidth: 1.1, land: "#2e8b57",
  },
  // No Fishing Maps counterparts (its chlorophyll map reuses the SST rainbow):
  // cmocean palettes, their near-white ends trimmed so white contours read.
  oxygen: {        // cmocean deep, reversed (low oxygen dark), 0-0.88
    stops: ["#281a2c", "#342846", "#3d3564", "#414583", "#3e5992", "#3f6c96", "#437f9a", "#49929f", "#51a5a2", "#5bb8a4", "#71caa3", "#96daa4", "#bfe7ae"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  nitrate: {       // cmocean matter, 0.12-1
    stops: ["#f9c38a", "#f6a975", "#f18f63", "#ea7657", "#e05e53", "#d24755", "#bf365b", "#a92861", "#921f63", "#791a61", "#5f185a", "#46144d", "#2f0f3e"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#2e8b57",
  },
  silicate: {      // cmocean tempo, 0.15-1
    stops: ["#c9d4bf", "#aec7aa", "#91ba98", "#71ae8b", "#4ea183", "#29937f", "#13837b", "#137275", "#19616c", "#1c5062", "#1c4058", "#192f4d", "#151d44"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  // Derived variables. Depths run light (shallow) to dark (deep); the mixed
  // layer depth uses the Fishing Maps MLD palette (cmocean dense).
  spiciness: {     // cmocean thermal, 0-0.92
    stops: ["#042333", "#0a2f5b", "#25348f", "#4d379f", "#6a4595", "#85518e", "#a05a87", "#be637b", "#db6e68", "#f07f50", "#fb993f", "#fbb73d", "#f5d849"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  n2: {            // cmocean amp, 0.12-1
    stops: ["#e3c9c2", "#dcb4a6", "#d69e8b", "#cf8870", "#c97457", "#c15d3f", "#b9452c", "#ad2c24", "#9c1827", "#850e29", "#6c0f26", "#530d1d", "#3c0912"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#2e8b57",
  },
  z_sigma25: {     // cmocean deep, 0.1-1
    stops: ["#caebb2", "#a1dda6", "#78cea3", "#5fbca4", "#52a8a3", "#4a959f", "#44829b", "#3f6e97", "#3e5a92", "#414684", "#3e3666", "#342847", "#281a2c"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  nitricline_depth: {   // cmocean matter, 0.12-1
    stops: ["#f9c38a", "#f6a975", "#f18f63", "#ea7657", "#e05e53", "#d24755", "#bf365b", "#a92861", "#921f63", "#791a61", "#5f185a", "#46144d", "#2f0f3e"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#2e8b57",
  },
  chl_max_depth: { // cmocean algae, 0.12-1
    stops: ["#b1dea5", "#99cf8c", "#7ec175", "#61b361", "#3da654", "#189750", "#07864d", "#0e7548", "#156540", "#195437", "#1a442c", "#173420", "#122414"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  // 0/500 dbar dynamic height: the in-situ counterpart of sea surface height,
  // so the Fishing Maps SSH style (cmocean balance bands, black contours, seagreen land).
  dyn_height: {
    stops: ["#181c43", "#293888", "#0c5ebe", "#3888ba", "#75aabe", "#b6c9cf", "#f1eceb", "#dfbbb0", "#d08b73", "#bf573a", "#a52125", "#730e27", "#3c0912"],
    smooth: false, line: "#000000", lineWidth: 1.1, land: "#2e8b57",
  },
  // Water-mass fractions: Pacific Subarctic blue (cmocean ice, reversed),
  // Pacific Equatorial red (amp), North Pacific Central green (speed).
  wm_psa: {
    stops: ["#c6e8eb", "#a2d6dc", "#83c5d3", "#6bb1cb", "#599ec4", "#4a8abd", "#4176b6", "#3e61ab", "#3f4e99", "#3a3c7b", "#2f2d5c", "#201f40", "#0f1024"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#2e8b57",
  },
  wm_pew: {
    stops: ["#e5cfc9", "#deb9ae", "#d7a291", "#d18d76", "#ca775b", "#c36143", "#ba492f", "#ae2f24", "#9d1926", "#870e29", "#6d0e26", "#540d1d", "#3c0912"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#2e8b57",
  },
  wm_npcw: {
    stops: ["#eedf98", "#dfcc6e", "#c9ba45", "#adad23", "#8ea20b", "#6c9607", "#498a16", "#277b23", "#0f6b2b", "#0d592d", "#164729", "#193520", "#172313"],
    smooth: true, line: "#ffffff", lineWidth: 0.9, land: "#000000",
  },
  mld: {           // Fishing Maps MLD: cmocean dense
    stops: ["#e6f1f1", "#c2dfe6", "#a2cee2", "#86b9e3", "#76a4e5", "#748be2", "#7871d5", "#7959c0", "#7642a5", "#6e2d84", "#621d62", "#4f1440", "#360e24"],
    smooth: true, line: "#ffffff", lineWidth: 1.1, land: "#2e8b57",
  },
};
// Anomalies: balanced (diverging) palettes, neutral at zero, each built from
// its variable's own palette above (user, 2026-10-12): temperature from the
// SST palette's blue and red-pink ends, salinity cmocean balance itself,
// density from cmocean dense's purple end against a teal, oxygen from deep,
// nitrate matter against tempo, silicate the reverse. Black contours, the zero
// contour drawn heavier; land as the variable's own map.
const ANOMALY_STYLES = {
  temperature: ["#0030f5", "#1250d0", "#1769ad", "#4a86bf", "#86acd3", "#c2d3e6", "#f2f0ec", "#f6cfb0", "#f4a874", "#f16715", "#f55945", "#f2668f", "#fd92fa"],
  salinity: ["#181c43", "#293888", "#0c5ebe", "#3888ba", "#75aabe", "#b6c9cf", "#f1eceb", "#dfbbb0", "#d08b73", "#bf573a", "#a52125", "#730e27", "#3c0912"],
  sigma_theta: ["#1f5f70", "#2f7f8f", "#4f9fae", "#79bccb", "#a6d4de", "#d2e8ec", "#f2f1ef", "#ddd0ea", "#bfa3d6", "#9a72bf", "#7642a5", "#5c2a7f", "#4f1440"],
  oxygen: ["#281a2c", "#342846", "#3d3564", "#414583", "#5d70a5", "#a3b0cf", "#f1f1ee", "#b8e3c8", "#8fd3aa", "#71caa3", "#51a5a2", "#3f8f8a", "#2f6f6a"],
  nitrate: ["#13837b", "#29937f", "#4ea183", "#7fb898", "#aecdb4", "#d8e4d6", "#f3f1ec", "#f6c9a0", "#f18f63", "#e05e53", "#bf365b", "#921f63", "#5f185a"],
  silicate: ["#5f185a", "#921f63", "#bf365b", "#e05e53", "#f18f63", "#f6c9a0", "#f3f1ec", "#c9d4bf", "#91ba98", "#4ea183", "#13837b", "#19616c", "#151d44"],
  // Derived: the positive side from the variable's own palette (deeper, more
  // stratified, spicier), the negative side a contrasting ramp.
  spiciness: ["#042333", "#0a2f5b", "#25348f", "#4d70b0", "#8ea7cf", "#c8d3e6", "#f2f1ee", "#f7d9a8", "#fbc06a", "#fb993f", "#f07f50", "#db6e68", "#be637b"],
  n2: ["#155a6b", "#2b7a87", "#4f9ba5", "#7ebcc3", "#aed6da", "#d8ebec", "#f3f1ee", "#e3c9c2", "#d69e8b", "#c97457", "#b9452c", "#9c1827", "#6c0f26"],
  z_sigma25: ["#9a5b16", "#b8771f", "#d29539", "#e5b66a", "#f0d49f", "#f6e8cf", "#f2f2ef", "#c4e2c8", "#78cea3", "#4a959f", "#3f6e97", "#414684", "#281a2c"],
  nitricline_depth: ["#13837b", "#29937f", "#4ea183", "#7fb898", "#aecdb4", "#d8e4d6", "#f3f1ec", "#f6c9a0", "#f18f63", "#e05e53", "#bf365b", "#921f63", "#5f185a"],
  chl_max_depth: ["#7a3d8f", "#9558a8", "#b07cc0", "#c9a2d5", "#dfc6e6", "#efe3f2", "#f2f2ef", "#cfe8c8", "#99cf8c", "#3da654", "#07864d", "#195437", "#122414"],
  mld: ["#1f5f70", "#2f7f8f", "#4f9fae", "#79bccb", "#a6d4de", "#d2e8ec", "#f2f1ef", "#ddd0ea", "#bfa3d6", "#9a72bf", "#7642a5", "#5c2a7f", "#4f1440"],
  dyn_height: ["#181c43", "#293888", "#0c5ebe", "#3888ba", "#75aabe", "#b6c9cf", "#f1eceb", "#dfbbb0", "#d08b73", "#bf573a", "#a52125", "#730e27", "#3c0912"],
  wm_psa: ["#9a5b16", "#b8771f", "#d29539", "#e5b66a", "#f0d49f", "#f6e8cf", "#f2f2ef", "#c6e1ea", "#83c5d3", "#4a8abd", "#3e61ab", "#3a3c7b", "#0f1024"],
  wm_pew: ["#1f5f70", "#2f7f8f", "#4f9fae", "#79bccb", "#a6d4de", "#d2e8ec", "#f3f1ee", "#e5cfc9", "#d7a291", "#ca775b", "#ba492f", "#9d1926", "#540d1d"],
  wm_npcw: ["#7a3d8f", "#9558a8", "#b07cc0", "#c9a2d5", "#dfc6e6", "#efe3f2", "#f2f2ef", "#e4e3b0", "#c9ba45", "#8ea20b", "#498a16", "#0f6b2b", "#172313"],
};
const ANOMALY_LINE = "#1f1e1c";
const ANOMALY_MIN_YEARS = 20;           // a station's climatology needs at least this many years (user, 2026-10-12)
const FILL_OPACITY_OVER_BLACK = 0.85;   // as the Fishing Maps fills
const ICHTHYO_LAND = "#e8e6df";
const LABEL_SPACING_PX = 320;           // contour labels: one per this much line
const LABEL_MIN_SEPARATION_PX = 90;
const LABEL_MIN_LINE_PX = 110;
const NICE_STEPS = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5];
const MAX_INTERVALS = 20;

const hstate = {
  source: "bottle",
  variable: "temperature",
  depth: 50,
  scale: "floating",     // "floating" | "all" (fixed, all seasons) | "season" (fixed, this season)
  compare: null,         // [first, last] years whose maps the fixed scale spans
  smoothing: 75,         // km
  overlay: false,        // ichthyoplankton on top
  periodPos: 0,          // position within hAvailable
  seasonPos: 0,          // position within hSteps
  stationKey: null,      // selected station "line station" (shared with the ichthyoplankton view)
  chart: "larvae",       // station chart in these views: "larvae" (the ichthyoplankton series) or "hydro"
  anomaly: false,        // the Anomalies view: departures from each station's climatology
  derived: false,        // the Derived variables view
  watermass: false,      // the Water masses view (properties on isopycnals, CTD)
  isopycnal: 25.8,       // the sigma-theta surface shown there
  viewVars: { hydro: "temperature", derived: "z_sigma25", watermass: "iso_temperature", anomaly: "temperature" },   // each view's last variable
};
let hmeta = null;
const hcache = new Map();      // "source/depth" -> data
let hAvailable = [];           // period indices with values for the variable at this depth
let hSteps = [];               // [{season, year}] with values, chronological
let hField = null;             // last mapped grid, for the value under the cursor
let hLevels = null;            // {levels, colors, colorAt, below, above} of the map shown
let hLines = [];               // [{level, rings}] contour lines (lon/lat) of the map shown
let hLabelMarkers = [];        // contour-label markers
let hLineAxesCache = new Map(); // source -> CalCOFI line axes from its stations
let hLoadToken = 0;

// Isopycnal (Water masses) variables come from CTD casts only: they use the
// CTD source without changing the source chosen for the other views.
const hSrcKey = () => (hmeta.variables[hstate.variable]?.group === "isopycnal" ? "ctd" : hstate.source);
const hSrc = () => hmeta.sources[hSrcKey()];
// The view within the hydrography machinery: "hydro" (at a depth), "derived"
// (derived variables), "watermass" (properties on isopycnals) or "anomaly"
// (departures from climatology, of any of them).
const hView = () => (hstate.anomaly ? "anomaly" : hstate.derived ? "derived" : hstate.watermass ? "watermass" : "hydro");
const VIEW_GROUPS = { hydro: [undefined], derived: ["derived"], watermass: ["isopycnal", "fraction", "dynamic"] };
const viewAllows = (key, view = hView()) => view === "anomaly" || VIEW_GROUPS[view].includes(hmeta.variables[key].group);
const isIso = () => hVar().group === "isopycnal";
const TERNARY_URL = "https://firebasestorage.googleapis.com/v0/b/fishing-maps-dd8ce.firebasestorage.app/o/calcofi_public%2FTernary.html?alt=media&token=eebac6e4-c4dd-4c21-978b-c7c75b3d98c0";
// The depth used: per-cast derived variables have no depth ("cast" file); N2
// is per interval, so the deepest standard depth falls back to the last interval.
function hEffDepth() {
  const v = hVar(), depths = hSrc().depths;
  if (v.interval && hstate.depth === depths[depths.length - 1]) return depths[depths.length - 2];
  return hstate.depth;
}
const hKey = () => `${hSrcKey()}/${isIso() ? `iso${hstate.isopycnal}` : hVar().perCast ? "cast" : hEffDepth()}`;
function hDepthText(prefix) {
  const v = hVar();
  if (isIso()) return hstate.variable === "iso_depth" ? "" : `${prefix}σθ ${hstate.isopycnal}`;
  if (v.perCast) return "";
  const d = hEffDepth(), depths = hSrc().depths;
  return v.interval ? `${prefix}${d}–${depths[depths.indexOf(d) + 1]} m` : `${prefix}${d} m`;
}
// Isopycnal variables borrow their at-a-depth counterparts' styles.
const styleKey = () => hVar().style || hstate.variable;
const hStyle = () => (hstate.anomaly
  ? { ...HYDRO_STYLES[styleKey()], stops: ANOMALY_STYLES[styleKey()], smooth: true, line: ANOMALY_LINE, lineWidth: 0.8 }
  : HYDRO_STYLES[styleKey()]);
// "… anomaly" goes before any qualifier after a comma ("Dynamic height anomaly, 0/500 dbar").
const hLabel = () => {
  const base = hstate.variable === "iso_depth" ? `Depth of σθ ${hstate.isopycnal}` : hVar().label;
  return hstate.anomaly ? base.replace(/(,|$)/, " anomaly$1") : base;
};
const invMercatorY = (y) => (Math.atan(Math.exp((y * Math.PI) / 180)) * 360) / Math.PI - 90;
const hVar = () => hmeta.variables[hstate.variable];
const hData = () => hcache.get(hKey());
const hPeriodText = (p) => { const x = hSrc().periods[p]; return `${MONTHS[x.month - 1]} ${x.year}`; };
const hSourceWord = () => (hSrcKey() === "ctd" ? "CTD" : "bottle");
const hUnits = () => (hVar().units ? ` ${hVar().units}` : "");
const hFmt = (v) => v.toFixed({ temperature: 2, oxygen: 2, nitrate: 1, silicate: 1, spiciness: 2, n2: 2, wm_psa: 0, wm_pew: 0, wm_npcw: 0, dyn_height: 3,
  z_sigma25: 0, nitricline_depth: 0, chl_max_depth: 0, mld: 0 }[hstate.variable === "iso_depth" ? "z_sigma25" : styleKey()] ?? 3);

async function loadHydroMeta() {
  if (!hmeta) hmeta = await getJSON("hydro/meta.json");
  return hmeta;
}

async function loadHydroDepth() {
  const key = hKey();
  if (!hcache.has(key)) {
    const d = await getJSON(`hydro/${key}.json`);
    // Variables a file lacks (e.g. CalCOFI's CTD-only depths in the bottle
    // file) read as no data.
    for (const v of Object.values(hmeta.variables)) if (!(v.column in d)) d[v.column] = new Array(d.p.length).fill(null);
    d.byPeriod = new Map();
    for (let i = 0; i < d.p.length; i++) {
      if (!d.byPeriod.has(d.p[i])) d.byPeriod.set(d.p[i], []);
      d.byPeriod.get(d.p[i]).push(i);
    }
    hcache.set(key, d);
  }
  return hcache.get(key);
}

// ------------------------------------------------------------- time steps --

let hLastTime = null;          // the last time shown, kept through a map with no data
function hTime() {
  // Decimal year of what the hydrography map shows, to keep the time when
  // the source, depth, variable or view changes. A map with no data (e.g. a
  // CTD-only variable with the bottle source) keeps the last time shown.
  let t = null;
  if (state.mode === "month") {
    const p = hSrc().periods[hAvailable[hstate.periodPos]];
    t = p ? p.year + (p.month - 0.5) / 12 : null;
  } else {
    const s = hSteps[hstate.seasonPos];
    t = s ? seasonStart(s.season, s.year) + 1.5 / 12 : null;
  }
  if (t !== null) hLastTime = t;
  return t ?? hLastTime;
}
// "Mixed layer depth (m)" for per-cast depths; "Temperature °C, 50 m" otherwise.
const hTitle = () => (hVar().perCast || hstate.variable === "iso_depth" ? `${hLabel()} (${hVar().units})` : `${hLabel()}${hUnits()}${hDepthText(", ")}`);
// Lower-case the first letter in running text, but not an abbreviation (N², CTD).
const lowerFirst = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

function updateHydroSteps(target = hTime()) {
  const d = hData();
  const col = hVar().column;
  const periods = hSrc().periods;
  const set = new Set();
  for (let i = 0; i < d.p.length; i++) if (d[col][i] !== null) set.add(d.p[i]);
  hAvailable = [...set].sort((a, b) => a - b);
  const keys = new Map();
  for (const p of hAvailable) {
    const x = periods[p];
    const season = SEASON_OF_MONTH[x.month];
    if (!seasonMatches(season)) continue;
    const step = { season, year: x.year + (x.month === 12 ? 1 : 0) };
    keys.set(`${step.year}-${SEASONS.indexOf(season)}`, step);
  }
  hSteps = [...keys.values()].sort((a, b) => seasonStart(a.season, a.year) - seasonStart(b.season, b.year));
  const t = target ?? Infinity;
  const nearest = (list, time) => list.reduce((best, x, i) => (Math.abs(time(x) - t) < Math.abs(time(list[best]) - t) ? i : best), 0);
  if (hAvailable.length) hstate.periodPos = nearest(hAvailable, (p) => periods[p].year + (periods[p].month - 0.5) / 12);
  if (hSteps.length) hstate.seasonPos = nearest(hSteps, (s) => seasonStart(s.season, s.year) + 1.5 / 12);
}

const SEASON_OF_MONTH = { 12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
  6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn" };

function hStepPeriods(step) {
  const periods = hSrc().periods;
  return hAvailable.filter((p) => SEASON_OF_MONTH[periods[p].month] === step.season
    && periods[p].year + (periods[p].month === 12 ? 1 : 0) === step.year);
}

function hShownPeriods() {
  if (state.mode === "month") return hAvailable.length ? [hAvailable[hstate.periodPos]] : [];
  return hSteps.length ? hStepPeriods(hSteps[hstate.seasonPos]) : [];
}

// The season of what is shown (for "Fixed: this season").
function hShownSeason() {
  if (state.mode === "season") return hSteps[hstate.seasonPos]?.season;
  const p = hSrc().periods[hAvailable[hstate.periodPos]];
  return p ? SEASON_OF_MONTH[p.month] : null;
}

// Ichthyoplankton survey months matching the hydrography map, for the overlay.
function ichthyoPeriodsForHydro() {
  const keys = new Set(hShownPeriods().map((p) => hSrc().periods[p].key));
  if (state.mode === "month") return available.filter((p) => keys.has(meta.periods[p].key));
  const step = hSteps[hstate.seasonPos];
  return step ? available.filter((p) => meta.periods[p].season === step.season && seasonYear(meta.periods[p]) === step.year) : [];
}

// ---------------------------------------------------------------- values --

function hStationValues(periods) {
  // station -> {v (mean of its survey-month values), months, casts}
  const d = hData();
  const col = hVar().column;
  const acc = new Map();
  for (const p of periods) {
    for (const i of d.byPeriod.get(p) || []) {
      const v = d[col][i];
      if (v === null) continue;
      const r = acc.get(d.st[i]) || { sum: 0, months: 0, casts: 0 };
      r.sum += v;
      r.months += 1;
      r.casts += d.n[i];
      acc.set(d.st[i], r);
    }
  }
  for (const r of acc.values()) r.v = r.sum / r.months;
  if (hstate.anomaly && periods.length) {
    // Departure from each station's climatology for this calendar month or
    // season; stations without one (< ANOMALY_MIN_YEARS years) are left out.
    const clim = climatology(), slot = climSlot(hSrc().periods[periods[0]]);
    hAnomalyDropped = 0;
    for (const [st, r] of acc) {
      const c = clim.get(`${st}|${slot}`);
      if (c === undefined) { acc.delete(st); hAnomalyDropped++; } else r.v -= c.mean;
    }
  }
  return acc;
}

// ------------------------------------------------------------ anomalies --
//
// Climatology: for each station, the mean over all years of its value for a
// calendar month ("By month") or season ("By season": each year's value is the
// mean of the season's survey months, as on the map), over the whole record of
// the source shown -- the longest baseline the data allow. Only stations with
// at least ANOMALY_MIN_YEARS years count.
let hAnomalyDropped = 0;       // stations on the map shown without a climatology
const hClimCache = new Map();
const climSlot = (x) => (state.mode === "month" ? x.month : SEASON_OF_MONTH[x.month]);
const climYear = (x) => (state.mode === "month" ? x.year : x.year + (x.month === 12 ? 1 : 0));

function climatology() {
  const key = `${hKey()}/${hstate.variable}/${state.mode}`;
  if (hClimCache.has(key)) return hClimCache.get(key);
  const d = hData(), col = hVar().column, periods = hSrc().periods;
  const years = new Map();     // "st|slot" -> year -> {sum, n}
  for (let i = 0; i < d.p.length; i++) {
    const v = d[col][i];
    if (v === null) continue;
    const x = periods[d.p[i]], k = `${d.st[i]}|${climSlot(x)}`, y = climYear(x);
    if (!years.has(k)) years.set(k, new Map());
    const r = years.get(k).get(y) || { sum: 0, n: 0 };
    r.sum += v;
    r.n += 1;
    years.get(k).set(y, r);
  }
  const clim = new Map();
  for (const [k, byYear] of years) {
    if (byYear.size < ANOMALY_MIN_YEARS) continue;
    let sum = 0;
    for (const r of byYear.values()) sum += r.sum / r.n;
    clim.set(k, { mean: sum / byYear.size, years: byYear.size });
  }
  hClimCache.set(key, clim);
  return clim;
}

// ----------------------------------------------------------------- field --

function convexHull(pts) {
  // Andrew's monotone chain; pts [[x, y]], returns the hull counter-clockwise.
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function computeField(points) {
  // points: [{lon, lat, v}] -> grid {lon0, y0 (Mercator), step, nx, ny, z, inside}
  const lons = points.map((q) => q.lon), lats = points.map((q) => q.lat);
  const lonMin = Math.min(...lons) - GRID_MARGIN_DEG, lonMax = Math.max(...lons) + GRID_MARGIN_DEG;
  const latMin = Math.min(...lats) - GRID_MARGIN_DEG, latMax = Math.max(...lats) + GRID_MARGIN_DEG;
  // Columns even in longitude, rows even in Web Mercator y (same units), so
  // grid cells are square on screen and the fill image needs no warping.
  const y0 = mercatorY(latMin), y1 = mercatorY(latMax);
  const step = Math.max(0.03, Math.max(lonMax - lonMin, y1 - y0) / GRID_MAX_CELLS);
  const nx = Math.ceil((lonMax - lonMin) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const rowLat = Float64Array.from({ length: ny }, (_, j) => invMercatorY(y0 + j * step));
  const lat0 = (latMin + latMax) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const L = hstate.smoothing, cutoff = 3 * L;
  const wsum = new Float64Array(nx * ny), vsum = new Float64Array(nx * ny), dmin = new Float64Array(nx * ny).fill(Infinity);
  const ri = Math.ceil(cutoff / (step * kx)), rj = Math.ceil(cutoff / (step * ky * Math.cos((latMax * Math.PI) / 180)));
  for (const q of points) {
    const ci = Math.round((q.lon - lonMin) / step), cj = Math.round((mercatorY(q.lat) - y0) / step);
    for (let j = Math.max(0, cj - rj); j <= Math.min(ny - 1, cj + rj); j++) {
      const dy = (rowLat[j] - q.lat) * ky;
      for (let i = Math.max(0, ci - ri); i <= Math.min(nx - 1, ci + ri); i++) {
        const dx = (lonMin + i * step - q.lon) * kx;
        const d2 = dx * dx + dy * dy;
        if (d2 > cutoff * cutoff) continue;
        const w = Math.exp(-d2 / (L * L));
        const k = j * nx + i;
        wsum[k] += w;
        vsum[k] += w * q.v;
        if (d2 < dmin[k]) dmin[k] = d2;
      }
    }
  }
  const hull = points.length >= 3 ? convexHull(points.map((q) => [q.lon * kx, q.lat * ky])) : null;
  // Signed distance (km) inside the hull: the nearest edge line, positive inside.
  const hullDistance = (x, y) => {
    if (!hull || hull.length < 3) return Infinity;
    let d = Infinity;
    for (let a = 0; a < hull.length; a++) {
      const o = hull[a], b = hull[(a + 1) % hull.length];
      const len = Math.hypot(b[0] - o[0], b[1] - o[1]) || 1;
      d = Math.min(d, ((b[0] - o[0]) * (y - o[1]) - (b[1] - o[1]) * (x - o[0])) / len);
    }
    return d;
  };
  // "cover" (km) is positive inside the sampled area: inside the hull and
  // within MAX_GAP_KM of a station. Contouring it at 0 gives a smooth outline.
  const z = new Float64Array(nx * ny), inside = new Float64Array(nx * ny), cover = new Float64Array(nx * ny);
  let zMin = Infinity, zMax = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      z[k] = wsum[k] > 0 ? vsum[k] / wsum[k] : NaN;
      cover[k] = Math.max(-1000, Math.min(MAX_GAP_KM - Math.sqrt(dmin[k]), hullDistance((lonMin + i * step) * kx, rowLat[j] * ky)));
      const ok = cover[k] >= 0;
      inside[k] = ok ? 1 : 0;
      if (ok && Number.isFinite(z[k])) { zMin = Math.min(zMin, z[k]); zMax = Math.max(zMax, z[k]); }
    }
  }
  // Cells beyond every station's reach get the lowest value: they are masked,
  // and d3-contour needs finite numbers.
  for (let k = 0; k < z.length; k++) if (!Number.isFinite(z[k])) z[k] = zMin;
  return { lon0: lonMin, y0, step, nx, ny, z, inside, cover, zMin, zMax };
}

function fieldAt(f, lon, lat) {
  const x = (lon - f.lon0) / f.step, y = (mercatorY(lat) - f.y0) / f.step;
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= f.nx - 1 || j >= f.ny - 1) return null;
  if (!f.inside[Math.round(y) * f.nx + Math.round(x)]) return null;
  const fx = x - i, fy = y - j, z = (a, b) => f.z[b * f.nx + a];
  return z(i, j) * (1 - fx) * (1 - fy) + z(i + 1, j) * fx * (1 - fy) + z(i, j + 1) * (1 - fx) * fy + z(i + 1, j + 1) * fx * fy;
}

// ------------------------------------------------------------ colour scale --

function niceLevels(lo, hi) {
  const step = NICE_STEPS.find((s) => (hi - lo) / s <= MAX_INTERVALS) || NICE_STEPS[NICE_STEPS.length - 1];
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const levels = [];
  for (let v = a; v <= b + step / 2; v += step) levels.push(Math.round(v / step) * step);
  if (levels.length < 2) levels.push(levels[0] + step);
  return { levels, step };
}

function paletteAt(stops, t) {
  // Colour at t in [0, 1] along the stops, darkened as a fill at 85% over black.
  const rgb = stops.map((h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)));
  const x = Math.min(1, Math.max(0, t)) * (rgb.length - 1), a = Math.floor(x), b = Math.min(rgb.length - 1, a + 1), f = x - a;
  return rgb[a].map((c, k) => Math.round((c + (rgb[b][k] - c) * f) * FILL_OPACITY_OVER_BLACK));
}
const rgbText = (c) => `rgb(${c.join(",")})`;

// ------------------------------------------------------- compare years --
//
// "Fixed" scales span the maps of the years being compared: every survey
// month ("By month") or every season mean ("By season") in those years --
// all seasons ("Fixed: all") or only the season shown ("Fixed: season").
// The mapped field is a weighted mean of station values, so it never leaves
// their range: every compared map uses the whole colour range, unclipped.

// The year a survey month counts toward: calendar year, or season year By season.
const hStepYear = (x) => (state.mode === "season" ? x.year + (x.month === 12 ? 1 : 0) : x.year);

function hCompareYears() {
  const periods = hSrc().periods;
  return [...new Set(hAvailable.map((p) => hStepYear(periods[p])))].sort((a, b) => a - b);
}

function hShownYear() {
  if (state.mode === "season") return hSteps[hstate.seasonPos]?.year;
  const p = hSrc().periods[hAvailable[hstate.periodPos]];
  return p?.year;
}

function ensureCompareYears() {
  // Default: the year shown and one either side; kept within the years with data.
  const years = hCompareYears();
  if (!years.length) return;
  let [a, b] = hstate.compare || [hShownYear() - 1, hShownYear() + 1];
  a = Math.max(years[0], Math.min(a, years[years.length - 1]));
  b = Math.max(a, Math.min(b, years[years.length - 1]));
  hstate.compare = [a, b];
}

function compareRange() {
  const [y0, y1] = hstate.compare;
  const d = hData(), col = hVar().column, periods = hSrc().periods;
  const season = hstate.scale === "season" ? hShownSeason() : null;
  const acc = new Map();       // station x map -> {sum, n}
  for (let i = 0; i < d.p.length; i++) {
    const v = d[col][i];
    if (v === null) continue;
    const x = periods[d.p[i]], yr = hStepYear(x), s = SEASON_OF_MONTH[x.month];
    if (yr < y0 || yr > y1 || (season && s !== season)) continue;
    const key = state.mode === "season" ? `${d.st[i]}|${yr}|${s}` : `${d.st[i]}|${d.p[i]}`;
    const r = acc.get(key) || { sum: 0, n: 0, st: d.st[i], slot: climSlot(x) };
    r.sum += v;
    r.n += 1;
    acc.set(key, r);
  }
  let lo = Infinity, hi = -Infinity, maps = new Set();
  const clim = hstate.anomaly ? climatology() : null;
  for (const [key, r] of acc) {
    let v = r.sum / r.n;
    if (clim) {
      const c = clim.get(`${r.st}|${r.slot}`);
      if (c === undefined) continue;
      v -= c.mean;
    }
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    maps.add(key.slice(key.indexOf("|") + 1));
  }
  return Number.isFinite(lo) ? { lo, hi, maps: maps.size } : null;
}

function hydroScale(field) {
  // Floating: fitted to this map. Fixed: spanning the maps of the years
  // compared (see above); a map outside those years may pass the ends.
  let lo = field.zMin, hi = field.zMax, fixed = null;
  if (hstate.scale !== "floating") {
    ensureCompareYears();
    fixed = hstate.compare ? compareRange() : null;
    if (fixed) ({ lo, hi } = fixed);
  }
  if (hstate.anomaly) {
    // Anomalies: symmetric about zero, so zero is the neutral colour.
    const m = Math.max(Math.abs(lo), Math.abs(hi), 0.01);
    lo = -m;
    hi = m;
  }
  if (!(hi > lo)) hi = lo + 0.01;
  const { levels, step } = niceLevels(lo, hi);
  const style = hStyle(), n = levels.length - 1, a = levels[0], b = levels[n];
  // Bands take the palette at their centres; the smooth fill is continuous.
  const colors = Array.from({ length: n }, (_, i) => rgbText(paletteAt(style.stops, (i + 0.5) / n)));
  const colorAt = style.smooth
    ? (v) => paletteAt(style.stops, (v - a) / (b - a))
    : (v) => paletteAt(style.stops, (Math.min(n - 1, Math.max(0, Math.floor(((v - a) / (b - a)) * n))) + 0.5) / n);
  return { levels, step, colors, colorAt, smooth: style.smooth, fixed: Boolean(fixed), maps: fixed?.maps ?? 0,
    below: field.zMin < a, above: field.zMax > b };
}

// -------------------------------------------------------------- contours --

const ringArea = (r) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const orient = (r, ccw) => ((ringArea(r) > 0) === ccw ? r : r.slice().reverse());

function toLonLat(f, multipolygon) {
  return multipolygon.map((poly) => poly.map((ring) => ring.map(([x, y]) => [f.lon0 + (x - 0.5) * f.step, invMercatorY(f.y0 + (y - 0.5) * f.step)])));
}

function hydroGeometry(f, scale) {
  const thresholds = [f.zMin - 1, ...scale.levels];
  const contours = d3.contours().size([f.nx, f.ny]).thresholds(thresholds)(Array.from(f.z));
  const fills = [], lines = [];
  contours.forEach((c, i) => {
    if (!c.coordinates.length) return;
    const color = scale.colors[Math.min(scale.colors.length - 1, Math.max(0, i - 1))];
    const coords = toLonLat(f, c.coordinates);
    if (!scale.smooth) fills.push({ type: "Feature", properties: { k: i, color }, geometry: { type: "MultiPolygon", coordinates: coords } });
    if (i > 0) lines.push({ level: scale.levels[i - 1], rings: coords.flat() });
  });
  // Mask: everything outside the sampled area, in the ocean colour.
  const inside = d3.contours().size([f.nx, f.ny]).thresholds([0])(Array.from(f.cover))[0];
  const polys = toLonLat(f, inside.coordinates);
  const world = orient([[-179, -80], [179, -80], [179, 85], [-179, 85], [-179, -80]], true);
  const mask = [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, ...polys.map((p) => orient(p[0], false))] } }];
  for (const p of polys) for (const hole of p.slice(1)) {
    mask.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [orient(hole, true)] } });
  }
  return { fills, lines, mask };
}

// The smooth fill as an image, one pixel per grid cell (north up); MapLibre
// interpolates it linearly, and the vector mask above clips it to the sampled area.
function fieldImage(f, scale) {
  const canvas = document.createElement("canvas");
  canvas.width = f.nx;
  canvas.height = f.ny;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(f.nx, f.ny);
  for (let j = 0; j < f.ny; j++) {
    const row = (f.ny - 1 - j) * f.nx;
    for (let i = 0; i < f.nx; i++) {
      const k = j * f.nx + i, o = (row + i) * 4;
      if (f.cover[k] < -2 * MAX_GAP_KM) continue;    // far outside; the vector mask clips the rest
      const c = scale.colorAt(f.z[k]);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const west = f.lon0 - f.step / 2, east = f.lon0 + (f.nx - 0.5) * f.step;
  const south = invMercatorY(f.y0 - f.step / 2), north = invMercatorY(f.y0 + (f.ny - 0.5) * f.step);
  return { url: canvas.toDataURL(), coordinates: [[west, north], [east, north], [east, south], [west, south]] };
}
const BLANK_IMAGE = { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  coordinates: [[-130, 35], [-129, 35], [-129, 34], [-130, 34]] };

// ------------------------------------------------------- contour labels --
//
// Matplotlib-style inline labels, as on the Fishing Maps: the level in the
// line's colour, rotated along the line, with the line cut away under it.
// Laid out in screen space, so they are redone after every zoom or pan.
function labelText(v) { return signedTick(v); }

function layoutContourLabels() {
  for (const m of hLabelMarkers) m.remove();
  hLabelMarkers = [];
  if (!hLines.length || !hField) { map.getSource("hydro-line").setData({ type: "FeatureCollection", features: [] }); return; }
  const style = hStyle();
  const canvas = map.getCanvas();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const placed = [];
  const features = [];
  for (const { level, rings } of hLines) {
    const pieces = [];
    for (const ring of rings) {
      const pts = ring.map((c) => map.project(c));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      const total = cum[cum.length - 1];
      const cuts = [];
      if (total >= LABEL_MIN_LINE_PX) {
        for (let pos = Math.min(LABEL_SPACING_PX, total) / 2; pos < total; pos += LABEL_SPACING_PX) {
          let i = 1;
          while (i < cum.length - 1 && cum[i] < pos) i++;
          const f = (pos - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
          const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
          if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
          const ll = map.unproject([x, y]);
          if (fieldAt(hField, ll.lng, ll.lat) === null) continue;      // only inside the sampled area
          if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < LABEL_MIN_SEPARATION_PX)) continue;
          // Direction from points a little either side, kept upright.
          const at = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; return pts[k]; };
          const pa = at(Math.max(0, pos - 12)), pb = at(Math.min(total, pos + 12));
          let angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
          if (angle > 90) angle -= 180;
          if (angle < -90) angle += 180;
          const el = document.createElement("div");
          el.className = "contour-label";
          el.style.color = style.line;
          el.textContent = labelText(level);
          const marker = new maplibregl.Marker({ element: el, anchor: "center", rotation: angle, rotationAlignment: "viewport" })
            .setLngLat(ll).addTo(map);
          hLabelMarkers.push(marker);
          placed.push({ x, y });
          const half = el.offsetWidth / 2 + 3;
          cuts.push([pos - half, pos + half]);
        }
      }
      // The ring with the label gaps removed.
      let piece = [ring[0]];
      const inCut = (d) => cuts.some(([a, b]) => d > a && d < b);
      for (let i = 1; i < ring.length; i++) {
        for (const [a, b] of cuts) {
          for (const d of [a, b]) {
            if (d > cum[i - 1] && d < cum[i]) {
              const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
              const p = [ring[i - 1][0] + (ring[i][0] - ring[i - 1][0]) * f, ring[i - 1][1] + (ring[i][1] - ring[i - 1][1]) * f];
              if (d === a) { piece.push(p); if (piece.length > 1) pieces.push(piece); piece = []; } else piece = [p];
            }
          }
        }
        if (!inCut(cum[i])) piece.push(ring[i]);
      }
      if (piece.length > 1) pieces.push(piece);
    }
    if (pieces.length) features.push({ type: "Feature", properties: { level }, geometry: { type: "MultiLineString", coordinates: pieces } });
  }
  map.getSource("hydro-line").setData({ type: "FeatureCollection", features });
}

// ------------------------------------------------------------------ map --

const H_LAYERS = ["hydro-image", "hydro-fill", "hydro-line", "hydro-mask", "hydro-stations", "hydro-selected"];

function addHydroLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  for (const s of ["hydro-fill", "hydro-line", "hydro-mask", "hydro-stations", "hydro-selected"]) map.addSource(s, { type: "geojson", data: empty });
  map.addSource("hydro-image", { type: "image", ...BLANK_IMAGE });
  map.addLayer({ id: "hydro-image", type: "raster", source: "hydro-image", layout: { visibility: "none" },
    paint: { "raster-resampling": "linear", "raster-fade-duration": 0 } }, "graticule");
  map.addLayer({ id: "hydro-fill", type: "fill", source: "hydro-fill", layout: { "fill-sort-key": ["get", "k"], visibility: "none" },
    paint: { "fill-color": ["get", "color"], "fill-antialias": false } }, "graticule");
  map.addLayer({ id: "hydro-line", type: "line", source: "hydro-line", layout: { visibility: "none" },
    paint: { "line-color": "rgba(31, 30, 28, 0.45)", "line-width": 0.7 } }, "graticule");
  map.addLayer({ id: "hydro-mask", type: "fill", source: "hydro-mask", layout: { visibility: "none" },
    paint: { "fill-color": MASK_COLOR, "fill-antialias": false } }, "graticule");
  map.addLayer({ id: "hydro-stations", type: "circle", source: "hydro-stations", layout: { visibility: "none" },
    paint: { "circle-radius": 2.2, "circle-color": "#1f1e1c", "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.6 } }, "zero");
  map.addLayer({ id: "hydro-selected", type: "circle", source: "hydro-selected", layout: { visibility: "none" },
    paint: { "circle-radius": 9, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1f1e1c", "circle-stroke-width": 1.5 } }, "zero");

  map.on("mousemove", (e) => {
    if (state.layer !== "hydro") return;
    const hits = map.queryRenderedFeatures(e.point, { layers: ["hydro-stations", "zero", "catch"].filter((l) => map.getLayoutProperty(l, "visibility") !== "none") });
    if (hits.length) return;   // a station's own popup
    const v = hField ? fieldAt(hField, e.lngLat.lng, e.lngLat.lat) : null;
    if (v === null) { popup.remove(); return; }
    popup.setLngLat(e.lngLat).setHTML(`${hSigned(v)}${hUnits()}<br><span style="color:#85837c">mapped ${lowerFirst(hLabel())}${hDepthText(", ")}</span>`).addTo(map);
  });
  map.on("mousemove", "hydro-stations", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const f = e.features[0].properties;
    const s = hSrc().stations[f.st];
    popup.setLngLat(e.lngLat).setHTML(`<strong>Line ${s.line.toFixed(1)}, station ${s.station.toFixed(1)}</strong><br>` +
      `${hSigned(f.v)}${hUnits()}${hDepthText(" at ")}<br>` +
      `<span style="color:#85837c">${f.months > 1 ? `mean of ${f.months} survey months, ` : ""}${f.casts} cast${f.casts > 1 ? "s" : ""}</span>`).addTo(map);
  });
  map.on("mouseleave", "hydro-stations", () => { map.getCanvas().style.cursor = ""; popup.remove(); });
  map.on("click", "hydro-stations", (e) => {
    hstate.stationKey = hSrc().stations[e.features[0].properties.st].key;
    renderHydroChart();
    writeHash();
  });
  map.on("mouseout", () => popup.remove());
  map.on("moveend", () => { if (state.layer === "hydro") layoutContourLabels(); });
  addSectionLayers();
}

function setHydroVisible(on) {
  for (const id of H_LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (!on) {
    for (const m of hLabelMarkers) m.remove();
    hLabelMarkers = [];
    map.setPaintProperty("land", "fill-color", ICHTHYO_LAND);
  }
}

// --------------------------------------------------------------- render --

async function renderHydro() {
  if (!mapReady) return;
  const token = ++hLoadToken;
  if (!hmeta || !hcache.has(hKey())) {
    $("status").textContent = "Loading hydrography…";
    await loadHydroMeta();
    const before = hcache.has(hKey());
    await loadHydroDepth();
    $("status").textContent = "";
    if (token !== hLoadToken) return;
    if (!before) updateHydroSteps(hydroPendingTime ?? hTime());
    hydroPendingTime = null;
  }
  setHydroVisible(true);
  const periods = hShownPeriods();
  const values = hStationValues(periods);
  const stations = hSrc().stations;
  const points = [...values].map(([st, r]) => ({ st, lon: stations[st].lon, lat: stations[st].lat, v: r.v, casts: r.casts, months: r.months }));
  map.getSource("hydro-stations").setData({ type: "FeatureCollection", features: points.map((q) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [q.lon, q.lat] }, properties: { st: q.st, v: q.v, casts: q.casts, months: q.months } })) });

  const empty = { type: "FeatureCollection", features: [] };
  const style = hStyle();
  map.setPaintProperty("land", "fill-color", style.land);
  map.setPaintProperty("hydro-line", "line-color", style.line);
  map.setPaintProperty("hydro-line", "line-width", hstate.anomaly
    ? ["case", ["==", ["get", "level"], 0], style.lineWidth * 2.4, style.lineWidth]
    : style.lineWidth);
  if (points.length >= 3) {
    hField = computeField(points);
    hLevels = hydroScale(hField);
    const g = hydroGeometry(hField, hLevels);
    map.getSource("hydro-image").updateImage(hLevels.smooth ? fieldImage(hField, hLevels) : BLANK_IMAGE);
    map.getSource("hydro-fill").setData({ type: "FeatureCollection", features: g.fills });
    map.getSource("hydro-mask").setData({ type: "FeatureCollection", features: g.mask });
    hLines = g.lines;
  } else {
    hField = null;
    hLevels = null;
    hLines = [];
    map.getSource("hydro-image").updateImage(BLANK_IMAGE);
    for (const s of ["hydro-fill", "hydro-mask"]) map.getSource(s).setData(empty);
  }
  layoutContourLabels();
  // CalCOFI line and station numbers, from this map's stations.
  if (!hLineAxesCache.has(hSrcKey())) {
    hLineAxesCache.set(hSrcKey(), [computeLineAxes(hSrc().stations), computeLineAxes(hSrc().stations, "station")]);
  }
  placeLineLabels(points.map((q) => stations[q.st]), ...hLineAxesCache.get(hSrcKey()));

  // Ichthyoplankton overlay: the matching survey month(s) for the chosen
  // species, stage, net and sampling.
  const showFish = hstate.overlay && state.taxon && taxonCache.has(state.taxon.id);
  const fishPeriods = showFish ? ichthyoPeriodsForHydro() : [];
  const fc = showFish ? features(fishPeriods, state.mode) : empty;
  map.getSource("stations").setData(fc);
  for (const id of ["zero", "catch-ring", "catch"]) map.setLayoutProperty(id, "visibility", showFish ? "visible" : "none");
  symbolStyle(true);
  map.getSource("selected").setData(empty);

  // Stepper, labels, legend.
  const list = state.mode === "month" ? hAvailable : hSteps;
  $("period-range").max = String(Math.max(0, list.length - 1));
  $("period-range").value = state.mode === "month" ? hstate.periodPos : hstate.seasonPos;
  const when = !periods.length ? "" : state.mode === "month" ? hPeriodText(periods[0]) : seasonText(hSteps[hstate.seasonPos]);
  const casts = points.reduce((a, q) => a + q.casts, 0);
  $("period-label").textContent = periods.length
    ? `${when}\n${state.mode === "season" ? `${periods.length > 1 ? "Survey months" : "Survey month"} ${periods.map(hPeriodText).join(", ")} · ` : ""}${points.length} stations, ${casts} casts`
    : hVar().sources && !hVar().sources.includes(hSrcKey())
      ? `${hVar().label} comes from CTD casts only (CalCOFI's values): choose the CTD source.`
      : `No ${hSourceWord()} data for this ${state.mode === "season" && state.season !== "sequence" ? "season" : "selection"}.`;
  renderHydroMapLabel(when, periods, showFish, fishPeriods, fc);
  renderHydroLegend();
  if (showFish) renderLegend();
  renderHighCounts();
  // The section and the station chart share the bottom of the map when both are open.
  const area = document.querySelector(".map-area");
  area.classList.toggle("section-open", sectionShown());
  area.classList.toggle("panels-split", sectionShown() && hstate.stationKey !== null);
  if (hstate.stationKey !== null) renderHydroChart();
  else {
    $("station-panel").hidden = true;
    map.getSource("hydro-selected").setData(empty);
  }
  renderSection();       // a section in place of the station chart (Hydrography view, Section display)
  writeHash();
}
let hydroPendingTime = null;

// Stations on the map shown that have no climatology (fewer than
// ANOMALY_MIN_YEARS years) are left out of an anomaly map; say how many.
function anomalyNote() {
  if (!hstate.anomaly) return "";
  const base = `Departures from each station's ${state.mode === "month" ? "calendar-month" : "seasonal"} mean, ` +
    `${hSrc().years[0]}–${hSrc().years[1]} (stations with ${ANOMALY_MIN_YEARS}+ years)`;
  const left = hAnomalyDropped ? `; ${hAnomalyDropped} station${hAnomalyDropped > 1 ? "s" : ""} without one left out` : "";
  return `<span class="map-note">${base}${left}.</span>`;
}
const hSigned = (v) => `${hstate.anomaly && v > 0 ? "+" : ""}${hFmt(v)}`.replace("-", "−");
// Axis and colour-bar ticks: anomalies get a sign (+ / true minus).
const signedValue = (v) => (v > 0 ? `+${+v.toFixed(3)}` : String(+v.toFixed(3)).replace("-", "−"));
const signedTick = (v) => {
  const t = String(+v.toFixed(3));
  return hstate.anomaly ? (v > 0 ? `+${t}` : t.replace("-", "−")) : t;
};

function hydroWhat() {
  return `${hSrc().label} · ${hLabel()}${hDepthText(" at ")}`;
}

function renderHydroMapLabel(when, periods, showFish, fishPeriods, fc) {
  if (!periods.length) { $("map-label").innerHTML = `<span class="when">${hydroWhat()}</span>No data`; return; }
  const cruises = [...new Map(periods.flatMap((p) => hSrc().periods[p].cruises).map((c) => [c.key, c])).values()]
    .map((c) => `${c.key}${c.ship ? ` (${titleCase(c.ship)})` : ""}`);
  const cruiseText = cruises.length > 4 ? `${cruises.slice(0, 4).join(", ")} and ${cruises.length - 4} more` : cruises.join(", ");
  let fish = "";
  if (showFish) {
    const t = state.taxon;
    const name = speciesHTML(t);
    fish = fishPeriods.length
      ? `<span class="bar-title">${name}, ${stageWord()} · ${meta.nets[state.net].code} net</span>${colourBar(300)}${multiNote()}`
      : `<span class="bar-title">${name}: no ${meta.nets[state.net].code}-net tows in this ${state.mode === "season" ? "season" : "month"}</span>`;
  }
  $("map-label").innerHTML = `<span class="when">${when}</span>${hydroWhat()}<br>Cruise${cruises.length > 1 ? "s" : ""} ${cruiseText}` +
    `<span class="bar-title">${hTitle()}</span>${hydroColourBar(300)}${anomalyNote()}${fish}`;
}

// lv: a scale from hydroScale() (the map's, by default; sections pass theirs);
// signed: label positive ticks with + (anomalies, velocities).
function hydroColourBar(width, lv = hLevels, signed = hstate.anomaly) {
  if (!lv) return "";
  const { levels, colors, fixed, below, above } = lv;
  const n = colors.length, tri = fixed ? 8 : 0, m = { l: 14 + tri, r: 16 + tri }, h = 12;
  const w = width - m.l - m.r, bw = w / n;
  const parts = [];
  if (lv.smooth) {
    const steps = 60;
    for (let i = 0; i < steps; i++) {
      const v = levels[0] + ((i + 0.5) / steps) * (levels[levels.length - 1] - levels[0]);
      parts.push(`<rect x="${m.l + (i * w) / steps}" y="2" width="${w / steps + 0.4}" height="${h}" fill="${rgbText(lv.colorAt(v))}"/>`);
    }
  } else {
    colors.forEach((c, i) => parts.push(`<rect x="${m.l + i * bw}" y="2" width="${bw + 0.3}" height="${h}" fill="${c}"/>`));
  }
  const lo = rgbText(lv.colorAt(levels[0])), hi = rgbText(lv.colorAt(levels[levels.length - 1]));
  if (fixed) {
    parts.push(`<path d="M${m.l} 2 L${m.l - tri} ${2 + h / 2} L${m.l} ${2 + h} Z" fill="${lo}" opacity="${below ? 1 : 0.35}"/>`);
    parts.push(`<path d="M${m.l + w} 2 L${m.l + w + tri} ${2 + h / 2} L${m.l + w} ${2 + h} Z" fill="${hi}" opacity="${above ? 1 : 0.35}"/>`);
  }
  // Label every k-th level, with k dividing the interval count when possible
  // so the last level is labelled without crowding its neighbour.
  const nInt = levels.length - 1, kMin = Math.max(1, Math.ceil(levels.length / 8));
  let every = kMin;
  while (every <= nInt && nInt % every) every++;
  if (every > Math.max(kMin * 2, 2)) every = kMin;
  levels.forEach((v, i) => {
    if (i % every) return;
    const x = m.l + i * bw;
    parts.push(`<line x1="${x}" x2="${x}" y1="${2 + h}" y2="${5 + h}" stroke="#85837c"/>`);
    parts.push(`<text x="${x}" y="${h + 16}" text-anchor="middle" font-size="10" fill="#5b5a55">${signed ? signedValue(v) : String(+v.toFixed(3))}</text>`);
  });
  return `<svg class="colour-bar" viewBox="0 0 ${width} ${h + 20}" width="${width}" height="${h + 20}" role="img" aria-label="Colour scale">${parts.join("")}</svg>`;
}

function renderHydroLegend() {
  // The heading is set in capitals: keep σθ lower case (ΣΘ would read wrongly).
  $("hydro-legend-title").innerHTML = hTitle().replace(/σθ/g, '<span class="nocase">σθ</span>');
  $("hydro-legend-bar").innerHTML = hydroColourBar(280);
  setToggle("hydro-scale-toggle", hstate.scale);
  renderCompareControls();
  if (!hLevels) { $("hydro-scale-note").textContent = "Too few stations to contour."; return; }
  const top = +hLevels.levels[hLevels.levels.length - 1].toFixed(3);
  const range = hstate.anomaly ? `−${top} to +${top}` : `${+hLevels.levels[0].toFixed(3)}–${top}`;
  const contours = `contours every ${+hLevels.step.toFixed(3)}`;
  const season = hShownSeason();
  const clim = hstate.anomaly
    ? ` Anomaly from each station's ${state.mode === "month" ? "calendar-month" : "seasonal"} mean over the whole ${hSourceWord()} record ` +
      `(${hSrc().years[0]}–${hSrc().years[1]}), stations with at least ${ANOMALY_MIN_YEARS} years.`
    : "";
  if (hstate.scale === "floating") {
    $("hydro-scale-note").textContent = `Floating${hstate.anomaly ? ", symmetric about zero" : ""}: ${range}, fitted to this map (${contours}). Colours compare within this map only.${clim}`;
    return;
  }
  const [a, b] = hstate.compare || [];
  const years = a === b ? `${a}` : `${a}–${b}`;
  const which = state.mode === "season"
    ? (hstate.scale === "season" ? `${season} maps` : "seasonal maps")
    : (hstate.scale === "season" ? `${season} survey months` : "survey months");
  const shown = hShownYear();
  const outside = shown < a || shown > b ? ` This map (${shown}) is outside the years compared, so it may pass the ends.` : "";
  $("hydro-scale-note").textContent = hLevels.fixed
    ? `Fixed for comparison${hstate.anomaly ? ", symmetric about zero" : ""}: ${range} (${contours}), spanning every station value in the ${hLevels.maps} ${which} of ${years}, so those maps share colours and contour levels.${outside}${clim}`
    : `No ${hSourceWord()} data for ${years}${hstate.scale === "season" ? ` in ${season}` : ""}; showing a floating scale.`;
}

function renderCompareControls() {
  const box = $("hydro-compare");
  box.hidden = hstate.scale === "floating";
  if (box.hidden || !hstate.compare) return;
  const years = hCompareYears();
  const opts = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  for (const [id, v] of [["hydro-compare-from", hstate.compare[0]], ["hydro-compare-to", hstate.compare[1]]]) {
    const sel = $(id);
    if (sel.dataset.years !== years.join()) { sel.innerHTML = opts; sel.dataset.years = years.join(); }
    sel.value = String(v);
  }
}

// ---------------------------------------------------------- station chart --

function hydroSeries(st) {
  const d = hData(), col = hVar().column, periods = hSrc().periods;
  const rows = [];
  for (let i = 0; i < d.p.length; i++) if (d.st[i] === st && d[col][i] !== null) rows.push(i);
  // Anomalies: each point minus the station's climatology for its month or season.
  const clim = hstate.anomaly ? climatology() : null;
  const anom = (list) => (clim ? list.flatMap((r) => {
    const c = clim.get(`${st}|${r.slot}`);
    return c === undefined ? [] : [{ ...r, v: r.v - c.mean }];
  }) : list);
  if (state.mode === "month") {
    return anom(rows.map((i) => ({ p: d.p[i], x: periods[d.p[i]].year + (periods[d.p[i]].month - 0.5) / 12, v: d[col][i], casts: d.n[i], slot: periods[d.p[i]].month })));
  }
  const by = new Map();
  for (const i of rows) {
    const x = periods[d.p[i]];
    const season = SEASON_OF_MONTH[x.month];
    if (!seasonMatches(season)) continue;
    const step = { season, year: x.year + (x.month === 12 ? 1 : 0) };
    const k = `${step.year}-${season}`;
    const r = by.get(k) || { step, slot: season, x: seasonStart(season, step.year) + 1.5 / 12, sum: 0, months: 0, casts: 0 };
    r.sum += d[col][i]; r.months += 1; r.casts += d.n[i];
    by.set(k, r);
  }
  return anom([...by.values()].map((r) => ({ ...r, v: r.sum / r.months }))).sort((a, b) => a.x - b.x);
}

function renderHydroChart() {
  const key = hstate.stationKey;
  const st = hSrc().stations.findIndex((x) => x.key === key);
  // A station with no data in this source keeps its ring (at the
  // ichthyoplankton station's position) and says so.
  const s = st >= 0 ? hSrc().stations[st] : meta.stations.find((x) => x.key === key);
  if (!s) { hstate.stationKey = null; $("station-panel").hidden = true; return; }
  map.getSource("hydro-selected").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: {} }] });
  $("station-panel").hidden = false;
  document.querySelector(".map-area").classList.add("station-open");
  $("chart-toggle").hidden = false;
  setToggle("chart-toggle", hstate.chart);
  if (hstate.chart === "larvae") {
    // The larval time series at this station, as in the ichthyoplankton view,
    // marked at the time the hydrography map shows.
    const fishSt = meta.stations.findIndex((x) => x.key === key);
    if (fishSt < 0 || !state.taxon || !taxonCache.has(state.taxon.id)) {
      $("station-title").textContent = `Line ${s.line.toFixed(1)}, station ${s.station.toFixed(1)} — no ichthyoplankton tows at this station`;
      $("station-chart").innerHTML = "";
      return;
    }
    const t = hTime();
    if (t !== null) setIchthyoTime(t);
    renderStationChart(fishSt);
    return;
  }
  if (st < 0) {
    $("station-title").textContent = `Line ${s.line.toFixed(1)}, station ${s.station.toFixed(1)} — no ${hSourceWord()} data at this station`;
    $("station-chart").innerHTML = "";
    return;
  }
  const series = hydroSeries(st);
  $("station-title").textContent = `Line ${s.line.toFixed(1)}, station ${s.station.toFixed(1)} — ${hSrc().label} ${lowerFirst(hVar().perCast ? `${hLabel()}, ${hVar().units}` : hTitle())} (` +
    (state.mode === "month" ? `${series.length} survey months)` : `${state.season === "sequence" ? "all seasons" : state.season}, ${series.length} seasons)`);
  const box = $("station-chart");
  const W = box.clientWidth || 600, H = box.clientHeight || 180;
  const m = { l: 52, r: 12, t: 10, b: 24 };
  const parts = [];
  if (!series.length) { box.innerHTML = ""; return; }
  const vs = series.map((d) => d.v);
  // Anomalies: a symmetric axis, labelled through zero.
  const span = Math.max(...vs.map(Math.abs), 0.01);
  const { levels, step } = hstate.anomaly ? niceLevels(-span, span) : niceLevels(Math.min(...vs), Math.max(...vs));
  const y0 = levels[0], y1 = levels[levels.length - 1];
  const x0 = hSrc().years[0] - 1, x1 = hSrc().years[1] + 1;
  const sx = (x) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  // Gridlines on multiples of a tick step, so zero is always one of them.
  const tick = step * Math.ceil(levels.length / 6);
  levels.forEach((v) => {
    if (Math.abs(v / tick - Math.round(v / tick)) > 1e-6) return;
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}" stroke="#ecebe6"/>`);
    parts.push(`<text x="${m.l - 6}" y="${sy(v) + 4}" text-anchor="end" font-size="11" fill="#85837c">${signedTick(v)}</text>`);
  });
  for (let yr = Math.ceil(x0 / 10) * 10; yr <= x1; yr += 10) {
    parts.push(`<text x="${sx(yr)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#85837c">${yr}</text>`);
  }
  if (hstate.anomaly && y0 < 0 && y1 > 0) {
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${sy(0)}" y2="${sy(0)}" stroke="#85837c" stroke-width="1.2"/>`);
  }
  if (state.mode === "month" && hAvailable.length) {
    const p = hSrc().periods[hAvailable[hstate.periodPos]];
    const xx = sx(p.year + (p.month - 0.5) / 12);
    parts.push(`<line x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H - m.b}" stroke="#2a78d6" stroke-dasharray="3 3"/>`);
  } else if (state.mode === "season" && hSteps.length) {
    const { season, year } = hSteps[hstate.seasonPos];
    const xa = sx(seasonStart(season, year));
    parts.push(`<rect x="${xa}" y="${m.t}" width="${Math.max(3, sx(seasonStart(season, year) + 0.25) - xa)}" height="${H - m.t - m.b}" fill="#2a78d6" opacity="0.18"/>`);
  }
  const color = (v) => (hLevels ? rgbText(hLevels.colorAt(v)) : "#5b5a55");
  parts.push(`<polyline points="${series.map((d) => `${sx(d.x)},${sy(d.v)}`).join(" ")}" fill="none" stroke="#c9c7bf" stroke-width="0.8"/>`);
  for (const d of series) parts.push(`<circle cx="${sx(d.x)}" cy="${sy(d.v)}" r="3" fill="${color(d.v)}" stroke="${OUTLINE}" stroke-width="0.6"/>`);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Values through time at this station">${parts.join("")}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  const svg = box.querySelector("svg");
  const nearest = (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = null;
    for (const d of series) if (!best || Math.abs(sx(d.x) - px) < Math.abs(sx(best.x) - px)) best = d;
    return best && Math.abs(sx(best.x) - px) <= 12 ? best : null;
  };
  svg.addEventListener("mousemove", (event) => {
    const d = nearest(event);
    if (!d) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = d.step
      ? `${seasonText(d.step)}: ${hSigned(d.v)}${hUnits()} (${d.months > 1 ? `mean of ${d.months} survey months` : "1 survey month"}, ${d.casts} cast${d.casts > 1 ? "s" : ""})`
      : `${hPeriodText(d.p)}: ${hSigned(d.v)}${hUnits()} (${d.casts} cast${d.casts > 1 ? "s" : ""})`;
    const rect = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, (sx(d.x) / W) * rect.width - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(sy(d.v) / H) * rect.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  svg.style.cursor = "pointer";
  svg.addEventListener("click", (event) => {
    const d = nearest(event);
    if (!d) return;
    stopPlay();
    if (d.step) hstate.seasonPos = hSteps.findIndex((x) => x.season === d.step.season && x.year === d.step.year);
    else hstate.periodPos = hAvailable.indexOf(d.p);
    render();
  });
}

// ------------------------------------------------------------- controls --

function setupHydroControls() {
  document.querySelectorAll("#hydro-source button").forEach((b) => b.addEventListener("click", async () => {
    if (hstate.source === b.dataset.value) return;
    hydroPendingTime = hTime();
    hstate.source = b.dataset.value;
    setToggle("hydro-source", hstate.source);
    fillHydroDepths();
    render();
  }));
  $("hydro-variable").addEventListener("change", (e) => {
    hydroPendingTime = hTime();
    const [key, surface] = e.target.value.split("@");
    hstate.variable = key;
    if (surface) hstate.isopycnal = Number(surface);
    hstate.viewVars[hView()] = hstate.variable;
    fillHydroDepths();
    if (hData()) { updateHydroSteps(hydroPendingTime); hydroPendingTime = null; }
    render();
  });
  $("hydro-depth").addEventListener("change", (e) => {
    hydroPendingTime = hTime();
    hstate.depth = Number(e.target.value);
    render();
  });
  $("hydro-iso").addEventListener("change", (e) => {
    hydroPendingTime = hTime();
    hstate.isopycnal = Number(e.target.value);
    render();
  });
  $("ternary-open").addEventListener("click", () => {
    const panel = $("ternary-panel");
    if (!$("ternary-frame").src) $("ternary-frame").src = TERNARY_URL;     // loaded on first open (5 MB)
    panel.hidden = !panel.hidden;
    $("ternary-open").setAttribute("aria-pressed", String(!panel.hidden));
  });
  $("ternary-close").addEventListener("click", () => { $("ternary-panel").hidden = true; $("ternary-open").setAttribute("aria-pressed", "false"); });
  $("hydro-smoothing").addEventListener("change", (e) => { hstate.smoothing = Number(e.target.value); render(); });
  document.querySelectorAll("#chart-toggle button").forEach((b) => b.addEventListener("click", () => {
    hstate.chart = b.dataset.value;
    renderHydroChart();
    writeHash();
  }));
  $("hydro-overlay").addEventListener("change", async (e) => {
    hstate.overlay = e.target.checked;
    updateLayerControls();
    render();
  });
  document.querySelectorAll("#hydro-scale-toggle button").forEach((b) => b.addEventListener("click", () => {
    hstate.scale = b.dataset.value;
    render();
  }));
  const compare = () => {
    const a = Number($("hydro-compare-from").value), b = Number($("hydro-compare-to").value);
    hstate.compare = [Math.min(a, b), Math.max(a, b)];
    render();
  };
  $("hydro-compare-from").addEventListener("change", compare);
  $("hydro-compare-to").addEventListener("change", compare);
  fillHydroVariables();
  setupSectionControls();
  fillSelect($("hydro-smoothing"), SMOOTHING_KM.map((k) => `${k} km${k === 75 ? " (default)" : ""}`), 0);
  [...$("hydro-smoothing").options].forEach((o, i) => { o.value = SMOOTHING_KM[i]; });
  $("hydro-smoothing").value = hstate.smoothing;
  $("hydro-overlay").checked = hstate.overlay;
  setToggle("hydro-source", hstate.source);
  fillHydroDepths();
}

// The variable menu for the view: hydrography at a depth, derived variables,
// or (Anomalies) both, grouped. Each view keeps its own last choice.
function fillHydroVariables() {
  const keys = Object.keys(hmeta.variables);
  const option = (k) => `<option value="${k}">${hmeta.variables[k].label}${hmeta.variables[k].sources ? " (CTD)" : ""}</option>`;
  const group = (g) => keys.filter((k) => hmeta.variables[k].group === g);
  const plain = (k) => `<option value="${k}">${hmeta.variables[k].label}</option>`;
  // Isopycnal properties are listed once per surface ("Temperature, σθ 26.4"),
  // as "variable@surface".
  const iso = hmeta.isopycnals.map((sfc) => `<optgroup label="On σθ ${sfc} (CTD)">` +
    group("isopycnal").map((k) => `<option value="${k}@${sfc}">${k === "iso_depth" ? `Depth of σθ ${sfc}` : `${hmeta.variables[k].label}, σθ ${sfc}`}</option>`).join("") +
    "</optgroup>").join("");
  $("hydro-variable").innerHTML = hView() === "anomaly"
    ? `<optgroup label="At a depth">${group(undefined).map(option).join("")}</optgroup>` +
      `<optgroup label="Derived">${group("derived").map(option).join("")}</optgroup>` + iso +
      `<optgroup label="Water-mass fractions (OMP)">${group("fraction").map(plain).join("")}</optgroup>` +
      `<optgroup label="Circulation">${group("dynamic").map(plain).join("")}</optgroup>`
    : hView() === "watermass"
      ? iso + `<optgroup label="Water-mass fractions (OMP)">${group("fraction").map(plain).join("")}</optgroup>` +
        `<optgroup label="Circulation">${group("dynamic").map(plain).join("")}</optgroup>`
      : group(VIEW_GROUPS[hView()][0]).map(option).join("");
  $("hydro-variable").value = hMenuValue();
}
const hMenuValue = () => (isIso() ? `${hstate.variable}@${hstate.isopycnal}` : hstate.variable);

// Switch the view, keeping the variable if the new view offers it, else the
// view's last choice; nothing else changes.
function setHydroView(view) {
  hstate.viewVars[hView()] = hstate.variable;
  const t = hmeta && hData() ? hTime() : null;
  hstate.anomaly = view === "anomaly";
  hstate.derived = view === "derived";
  hstate.watermass = view === "watermass";
  if (!viewAllows(hstate.variable, view)) hstate.variable = hstate.viewVars[view];
  if (hmeta) { fillHydroVariables(); fillHydroDepths(); }
  if (t !== null) hydroPendingTime = t;
  if (hmeta && hData()) { updateHydroSteps(t); hydroPendingTime = null; }
}

function fillHydroDepths() {
  const all = hSrc().depths, v = hVar();
  // N2 is per interval: the deepest standard depth starts none. Water-mass
  // fractions go to 400 m only (the OMP's "upper ocean").
  const depths = v.interval ? all.slice(0, -1) : v.maxDepth ? all.filter((d) => d <= v.maxDepth) : all;
  if (!all.includes(hstate.depth)) hstate.depth = all.reduce((a, b) => (Math.abs(b - hstate.depth) < Math.abs(a - hstate.depth) ? b : a));
  $("hydro-depth-box").hidden = Boolean(v.perCast) || isIso();
  $("hydro-iso-box").hidden = true;     // the surface is chosen in the variable menu
  $("hydro-source-box").hidden = state.layer !== "hydro" || isIso();
  $("hydro-iso").value = String(hstate.isopycnal);
  $("hydro-depth").innerHTML = depths.map((d, i) => `<option value="${d}">${v.interval ? `${d}–${all[i + 1]} m` : `${d} m`}</option>`).join("");
  $("hydro-depth").value = String(hEffDepth());
  const [a, b] = hSrc().years;
  $("hydro-iso-note").textContent = v.group === "dynamic"
    ? "CalCOFI's own dynamic height of the surface relative to 500 dbar (bottle: reported R_DYNHT; CTD: dynamic_height), " +
      "from casts reaching 500 m. Like sea surface height, geostrophic flow runs along its contours, with higher values to the right in the northern hemisphere. " +
      "CTD values run about 0.02 dyn m above the bottle values at the same casts."
    : v.group === "fraction"
    ? "Share of each water mass, from an extended OMP analysis (Bograd, Schroeder & Jacox 2019) of temperature, salinity, " +
      "oxygen, phosphate, nitrate and silicate at each station and standard depth, 0–400 m; the three sum to 100%."
    : `Properties where each CTD downcast (${a}–${b}) crosses the surface, read from the profile itself; ` +
      "σθ 25.8 lies at about 100 m, 26.4 at about 200 m.";
  $("hydro-source-note").textContent = hstate.source === "bottle"
    ? `Bottle samples at the CalCOFI standard depths, ${a}–${b} (interpolated to the standard depths by CalCOFI).`
    : `CTD downcasts, ${a}–${b}, read at the standard depths. 2025–26 salinity is preliminary (not yet bottle-corrected).`;
}

// Hash: the hydrography part.
function writeHydroHash(params) {
  if (hstate.anomaly) params.set("layer", "anomaly");
  else if (hstate.derived) params.set("layer", "derived");
  else if (hstate.watermass) params.set("layer", "watermass");
  params.set("src", hstate.source);
  params.set("var", hstate.variable);
  params.set("depth", hstate.depth);
  if (isIso()) params.set("iso", hstate.isopycnal);
  if (hstate.scale !== "floating") params.set("hscale", hstate.scale);
  if (hstate.scale !== "floating" && hstate.compare) params.set("cmp", hstate.compare.join("-"));
  if (hstate.smoothing !== 75) params.set("L", hstate.smoothing);
  if (hstate.overlay) params.set("overlay", "1");
  if (hstate.stationKey !== null) params.set("hst", hstate.stationKey);
  if (hstate.chart === "hydro") params.set("chart", "hydro");
  if (sectionView()) writeSectionHash(params);
  if (!hmeta) return;
  if (state.mode === "month" && hAvailable.length) params.set("survey", hSrc().periods[hAvailable[hstate.periodPos]].key);
  if (state.mode === "season" && hSteps.length) {
    const { season, year } = hSteps[hstate.seasonPos];
    params.set("season", state.season);
    if (state.season === "sequence") params.set("shown", season);
    params.set("year", year);
  }
}

function readHydroHash(params) {
  if (params.get("src") in { bottle: 1, ctd: 1 }) hstate.source = params.get("src");
  if (hmeta && params.get("var") in hmeta.variables) hstate.variable = params.get("var");
  if (params.get("chart") === "hydro") hstate.chart = "hydro";
  readSectionHash(params);
  if (params.has("depth")) hstate.depth = Number(params.get("depth")) || 50;
  if ([25.8, 26.4].includes(Number(params.get("iso")))) hstate.isopycnal = Number(params.get("iso"));
  // (The view flags are set just before this, by readHash.)
  if (hmeta && !viewAllows(hstate.variable)) hstate.variable = hstate.viewVars[hView()];
  if (hmeta) hstate.viewVars[hView()] = hstate.variable;
  if (params.get("hscale") in { all: 1, season: 1 }) hstate.scale = params.get("hscale");
  const cmp = (params.get("cmp") || "").split("-").map(Number);
  if (cmp.length === 2 && cmp.every(Number.isFinite)) hstate.compare = [Math.min(...cmp), Math.max(...cmp)];
  if (SMOOTHING_KM.includes(Number(params.get("L")))) hstate.smoothing = Number(params.get("L"));
  hstate.overlay = params.get("overlay") === "1";
  if (["hydro", "derived", "anomaly", "watermass"].includes(params.get("layer")) && params.has("hst")) hstate.stationKey = params.get("hst");
  // The time to open on.
  const survey = params.get("survey");
  if (survey) hydroPendingTime = Number(survey.slice(0, 4)) + (Number(survey.slice(5, 7)) - 0.5) / 12;
  const year = Number(params.get("year"));
  if (params.get("view") === "season" && Number.isFinite(year) && params.has("year")) {
    const shown = state.season === "sequence" ? params.get("shown") : state.season;
    hydroPendingTime = seasonStart(SEASON_LABEL[shown] ? shown : "winter", year) + 1.5 / 12;
  }
}

// CalCOFI ichthyoplankton atlas.
//
// Data (docs/data/, built by python/build_atlas_data.py) are column-oriented
// arrays whose integer codes index into meta.json lists:
//   occupations.json  p (survey month), s (sampling), n (net), st (station), t (tows)
//   taxa/<id>.json    p, s, n, g (life stage), st, a (abundance; mean over tows,
//                     absences as zero)
// A station occupation with no catch row for the taxon is a sampled zero.
"use strict";

const DATA = "data/";
const INITIAL_BOUNDS = [[-135, 19], [-108, 43]];
const LANDING_BOUNDS = [[-125.2, 29.6], [-116.6, 36.4]];   // the core CalCOFI pattern (lines 76.7-93.3), Southern California
const PLAY_INTERVAL_MS = 2000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// Magma on log10 abundance: purple (low) through red and orange to pale yellow
// (high), perceptually uniform and colour-vision-deficiency safe; its
// near-black end is left out so the lowest class shows against the symbols'
// dark rim. Symbol size grows with the class too (radius 3 to 7 px), the
// smaller drawn on top. Each sits on a dark disc with a thin white ring, so the
// high, bright classes glow on any background and the low, dark ones stay
// visible on dark palettes: the light sea or the hydrography's (see
// symbolStyle). Zero catches are small and grey with a thin dark rim, the same
// size on the hydrography and off it.
// Ten classes; boundaries come from the colour-scale template (see SCALE_TEMPLATES).
const CLASSES = ["#440f76", "#671b80", "#892881", "#ad347c", "#d2426f", "#ee5b5e", "#fb835f", "#feac76", "#fed597", "#fcfdbf"]
  .map((color, i) => ({ color, radius: 3 + (4 * i) / 9 }));
const ZERO = { color: "#a9a7a0", radius: 2.4 };
const OUTLINE = "rgba(31, 30, 28, 0.55)";
const DISC = "#1f1e1c";        // the dark disc under each catch symbol
const RING_PX = 1;             // the white ring around it
const DEFAULT_NET = "CB";      // CalCOFI bongo, the standard net since 1978
const DEFAULT_STATION = "090.0 060.0";   // Line 90, station 60: time series open on page load

const state = {
  layer: "ichthyo",     // "ichthyo" | "hydro" (hydrography; see hydro.js)
  taxon: null,          // entry from taxa.json
  stage: 1,             // index into meta.stages (larva)
  sampling: 0,          // index into meta.samplings (standard)
  net: 0,               // index into meta.nets
  mode: "month",        // "month" (one survey month) | "season" (one season of one year)
  periodPos: 0,         // position within the available survey months
  season: "sequence",   // "sequence" (the default): every season in turn; or one season stepped by year
  seasonPos: 0,         // position within seasonSteps
  station: null,        // selected station index
  scaleMode: "fit",     // "fit" (this map's range) | "fixed" (same for all maps)
};

let meta, occ, taxa, map, popup;
let mapReady = false;          // set once on "load"; isStyleLoaded() is false while a source updates
let lineMarkers = [];          // CalCOFI line- and station-number labels currently on the map
// Lines need this many stations in view to be labelled: the modern pattern's
// one- or two-station inshore "lines" (e.g. 81.8, 86.8, 93.4) would otherwise
// stack labels against the coast.
const MIN_LINE_STATIONS = 3;
let occByPeriod;               // period index -> occupation row indices
let taxonCache = new Map();    // taxon id -> Map(key -> abundance), for the dataset shown (see loadDataset)
// Datasets: the fish eggs and larvae (docs/data/), or a zooplankton dataset
// (docs/data/zoo/<key>/, build_zooplankton_data.py) in the same layout, with
// its own stages ("stageInfo": krill life stages, ZooScan measurements, ...),
// shown with the same machinery in the Zooplankton view and the overlay.
const DATASETS = { ichthyo: "Ichthyoplankton", krill: "Krill", zooscan: "ZooScan", volume: "Plankton volume", cufes: "CUFES",
  venrick: "Phytoplankton", pico: "Picoplankton" };
// Track datasets (CUFES): samples along the ship's track, each its own point, with no line or station.
const isTrack = () => Boolean(meta.track);
// What a dataset's sampled places are called: stations, underway samples, regional pools.
const placeWord = (stations) => (isTrack() ? "underway samples" : dataset === "venrick" ? "regional pools" : stations);
let dataset = "ichthyo";
let lastZoo = "krill";                     // the Zooplankton button opens the last one used
let lastFish = "ichthyo";                  // and the Ichthyoplankton button (net tows or CUFES)
let lastPhyto = "pico";                    // and the Phytoplankton button
// Each view's datasets: fish eggs and larvae (net tows, CUFES underway eggs),
// zooplankton, phytoplankton (Venrick counts, picoplankton and bacteria).
const FISH_SETS = ["ichthyo", "cufes"], ZOO_SETS = ["krill", "zooscan", "volume"], PHYTO_SETS = ["venrick", "pico"];
const isFish = (ds = dataset) => FISH_SETS.includes(ds);
// The view a dataset belongs to, as the Map button's value.
const viewOf = (ds = dataset) => (FISH_SETS.includes(ds) ? "ichthyo" : PHYTO_SETS.includes(ds) ? "phyto" : "zoo");
const datasetCache = new Map();            // key -> {meta, occ, taxa, cache}
const datasetChoice = new Map();           // key -> {taxon, net, stage, sampling} chosen there, restored on return
const dataDir = (ds = dataset) => (ds === "ichthyo" ? "" : `zoo/${ds}/`);
let available = [];            // period indices sampled with the chosen sampling + net
let playTimer = null;
// A season or survey month with hydrography casts but no ichthyoplankton tows
// (with this net and sampling), carried into the ichthyoplankton view from the
// hydrography's time: shown as an empty map, the casts marked "no tow", until
// the time is changed. {t (decimal year), season, year, key, when, stations: [{line, station, lon, lat}], word}
let ghost = null;
let noTowShown = 0;            // stations marked "no tow" on the map shown (legend entry when > 0)

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- data --

// Unique key for (survey month, sampling, net, stage, station), sized by the dataset's lists.
const catchKey = (p, s, n, g, st) => ((((p * meta.samplings.length + s) * meta.nets.length + n) * meta.stages.length + g)
  * Math.max(8192, meta.stations.length)) + st;

async function getJSON(path) {
  const response = await fetch(DATA + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadTaxon(id) {
  if (taxonCache.has(id)) return taxonCache.get(id);
  const t = await getJSON(`${dataDir()}taxa/${id}.json`);
  const values = new Map();
  for (let i = 0; i < t.a.length; i++) values.set(catchKey(t.p[i], t.s[i], t.n[i], t.g[i], t.st[i]), t.a[i]);
  values.raw = t;              // column arrays, for the high-count distribution
  taxonCache.set(id, values);
  return values;
}

// Make dataset ds the one shown: its files (loaded once), its own taxon cache,
// and the controls that depend on it.
async function loadDataset(ds) {
  if (!datasetCache.has(ds)) {
    const dir = dataDir(ds);
    const [m, o, t] = await Promise.all([getJSON(`${dir}meta.json`), getJSON(`${dir}occupations.json`), getJSON(`${dir}taxa.json`)]);
    datasetCache.set(ds, { meta: m, occ: o, taxa: t, cache: new Map() });
  }
  ({ meta, occ, taxa, cache: taxonCache } = datasetCache.get(ds));
  dataset = ds;
  ({ ichthyo: () => { lastFish = ds; }, zoo: () => { lastZoo = ds; }, phyto: () => { lastPhyto = ds; } })[viewOf(ds)]();
  if (hstate.overlay) $("hydro-overlay").value = ds;
  indexOccupations();
  lineAxes = null;
  stationAxes = null;
  fillDatasetControls();
}

// Switch the dataset shown (keeping the time), restoring what was chosen there before.
async function switchDataset(ds) {
  if (ds === dataset) return;
  stopPlay();
  const t = ichthyoTime();
  if (state.taxon) datasetChoice.set(dataset, { taxon: state.taxon.key, net: state.net, stage: state.stage, sampling: state.sampling });
  state.station = null;
  await loadDataset(ds);
  const saved = datasetChoice.get(ds);
  // A dataset's first visit: the bongo net where it has one (as for the fish), else its first.
  state.net = saved?.net ?? Math.max(0, meta.nets.findIndex((n) => n.code === DEFAULT_NET));
  state.stage = saved?.stage ?? (ds === "ichthyo" ? 1 : 0);
  state.sampling = saved?.sampling ?? 0;
  const taxon = taxa.find((x) => x.key === saved?.taxon) || defaultTaxon();
  state.taxon = null;
  updateAvailable();
  updateSeasonSteps();
  setIchthyoTime(t);
  updateLayerControls();
  await selectTaxon(taxon, !saved);
}
const defaultTaxon = () => (dataset === "ichthyo" ? taxa.find((t) => t.scientific === "Engraulis mordax") : null) || taxa[0];

// The dataset's stage, sampling, net and species controls, and their labels.
function fillDatasetControls() {
  const info = meta.stageInfo;
  fillSelect($("stage-select"), info ? info.map((x) => x.label) : meta.stages.map(titleCase), Math.min(state.stage, meta.stages.length - 1));
  fillSelect($("sampling-select"), meta.samplings.map(titleCase), Math.min(state.sampling, meta.samplings.length - 1));
  fillSelect($("net-select"), meta.nets.map((n) => n.label), Math.min(state.net, meta.nets.length - 1));
  $("dataset-select").value = dataset;
  $("species-label").textContent = { ichthyo: "Species", krill: "Species", zooscan: "Zooplankton class", volume: "Measure", cufes: "Species",
    venrick: "Taxon", pico: "Group" }[dataset];
  $("stage-label").textContent = dataset === "ichthyo" || dataset === "krill" || dataset === "cufes" ? "Life stage"
    : dataset === "pico" ? "Depth" : dataset === "venrick" ? "Sample" : "Measurement";
  trackSymbols();
  $("net-hint").textContent = dataset === "ichthyo" || dataset === "volume"
    ? "Values from different nets are not comparable, so one net is shown at a time." : meta.nets[0].label;
  setupSpeciesSelect();
}

// Track samples sit a few km apart along the ship's track: smaller symbols (60%).
function trackSymbols() {
  if (!mapReady) return;
  const f = isTrack() ? 0.6 : 1;
  map.setPaintProperty("catch", "circle-radius", ["match", ["get", "cls"], ...CLASSES.flatMap((c, i) => [i, c.radius * f]), ZERO.radius * f]);
  map.setPaintProperty("zero", "circle-radius", ZERO.radius * f);
  symbolStyle(state.layer === "hydro");
}

// Partial surveys (build_atlas_data.py): occupations with occ.c[i] >= 0
// report only the taxa in meta.partial[c]; for any other taxon they count as
// unsampled, not as zero catches.
let partialTaxa = [], partialPeriods = new Map();   // period -> meta.partial index
function indexOccupations() {
  occByPeriod = new Map();
  partialTaxa = (meta.partial || []).map((x) => new Set(x.taxa));
  partialPeriods = new Map();
  for (let i = 0; i < occ.p.length; i++) {
    if (!occByPeriod.has(occ.p[i])) occByPeriod.set(occ.p[i], []);
    occByPeriod.get(occ.p[i]).push(i);
    if (occ.c && occ.c[i] >= 0) partialPeriods.set(occ.p[i], occ.c[i]);
  }
}

// An occupation counts for the chosen net, sampling and taxon.
const occUsed = (i) => occ.s[i] === state.sampling && occ.n[i] === state.net &&
  (!occ.c || occ.c[i] < 0 || !state.taxon || partialTaxa[occ.c[i]].has(state.taxon.id));

function occupationRows(p) {
  return (occByPeriod.get(p) || []).filter(occUsed);
}

// The note for survey months shown that report only some taxa ("" if none).
function partialNote(periods) {
  const labels = [...new Set(periods.filter((p) => partialPeriods.has(p)).map((p) => meta.partial[partialPeriods.get(p)].label))];
  return labels.length ? `<span class="map-note">${labels.join("; ")}.</span>` : "";
}

function updateAvailable() {
  ghost = null;
  const set = new Set();
  for (let i = 0; i < occ.p.length; i++) {
    if (occUsed(i)) set.add(occ.p[i]);
  }
  available = [...set].sort((a, b) => a - b);
}

// Colour scale: always ten classes, bounded by integers (the first class runs
// from just above 0 to 1, so standardised values below 1 have a colour; 0 itself
// is grey). Templates step roughly x3 (10, 30, 100, 300, ...), each with steps
// that roughly double or triple so intervals widen into the tail. The template
// is the smallest whose top covers a high PERCENTILE, not the maximum, so a few
// extreme tows don't squeeze everything else into the lowest colours:
// "fit" uses the 95th percentile of the current map's non-zero values; "fixed"
// the 99th percentile of the whole record for the selected species, net, stage
// and sampling (colours then compare across surveys). Anything above the top
// shares the darkest colour, and the last tick reads "<top>+". Map, legend,
// colour bar and station chart all use it. Class i = [b_i, b_i+1).
const SCALE_TEMPLATES = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30],
  [0, 1, 2, 3, 5, 10, 15, 20, 30, 50, 100],
  [0, 1, 2, 5, 10, 20, 30, 50, 100, 200, 300],
  [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
  [0, 1, 2, 5, 10, 30, 100, 300, 1000, 2000, 3000],
  [0, 1, 3, 10, 30, 100, 300, 1000, 2000, 5000, 10000],
  [0, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000],
  [0, 1, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000],
];
const FIT_PERCENTILE = 0.95;      // "Fit to this map"
const FIXED_PERCENTILE = 0.99;    // "Same for all"
let scaleBreaks = SCALE_TEMPLATES[4];
let scaleOverflow = false;        // some values exceed the template's top

function classOf(a) {
  if (!(a > 0)) return -1;
  let i = 0;
  for (let k = 1; k < scaleBreaks.length - 1; k++) if (a >= scaleBreaks[k]) i = k;
  return i;
}

// Beyond the largest template (ZooScan abundances reach millions per m²), the
// 1-2-5 template (0, 1, 2, 5 ... 1000) is scaled up by a power of 10, so the
// classes keep 1-2-5 steps over the top three decades, where such values lie.
function templateFor(max) {
  // CUFES concentrations (eggs per m³) are mostly below 1 (half to 98% by
  // species): the 1-2-5 template scaled by a power of 10, up or down, so the
  // classes span three decades below the reference, sub-1 values included.
  if (meta?.track || meta?.logScale) return SCALE_TEMPLATES[4].map((v) => +(v * 10 ** Math.ceil(Math.log10(max / 1000) - 1e-9)).toPrecision(3));
  const t = SCALE_TEMPLATES.find((x) => max <= x[x.length - 1]);
  if (t) return t;
  const k = Math.ceil(Math.log10(max / 1000) - 1e-9);
  return SCALE_TEMPLATES[4].map((v) => v * 10 ** k);
}

function recordValues() {
  // Every non-zero value in the record for the current species/net/stage/sampling.
  const t = taxonCache.get(state.taxon.id).raw;
  const out = [];
  for (let i = 0; i < t.a.length; i++) {
    if (t.s[i] === state.sampling && t.n[i] === state.net && t.g[i] === state.stage) out.push(t.a[i]);
  }
  return out;
}

function computeScale(values) {
  const fixed = state.scaleMode === "fixed";
  const pos = (fixed ? recordValues() : values).filter((a) => a > 0).sort((a, b) => a - b);
  if (!pos.length) { scaleOverflow = false; return SCALE_TEMPLATES[0]; }
  const ref = quantile(pos, fixed ? FIXED_PERCENTILE : FIT_PERCENTILE);
  const t = templateFor(ref);
  // The overflow "+" describes THIS map's values, in either mode.
  scaleOverflow = Math.max(0, ...values) > t[t.length - 1];
  return t;
}

// -------------------------------------------------------------- labels --

const stageWord = (plural = true) => {
  if (meta.stageInfo) return plural ? stageInfo().noun : meta.stages[state.stage];
  const stage = meta.stages[state.stage];
  return plural ? (stage === "egg" ? "eggs" : "larvae") : stage;
};
// Zooplankton datasets describe each stage (or measurement): label, noun, title, units.
const stageInfo = () => meta.stageInfo?.[state.stage];
// Value units: "larvae per 10 m²", "adults per m²", "mg C m⁻²", "mL per 1,000 m³".
const unitsLabel = () => {
  const x = stageInfo();
  if (!x) return `${stageWord()} ${meta.nets[state.net].units}`;
  return x.units.startsWith("per") && dataset !== "volume" ? `${x.noun} ${x.units}` : x.units;
};
// Legend title: "Larvae per 10 m²", "Adults per m²", "Carbon biomass, mg C m⁻²".
const valueTitle = () => {
  const x = stageInfo();
  if (!x) return `${titleCase(stageWord())} ${meta.nets[state.net].units}`;
  return (x.units.startsWith("per") ? `${x.title} ${x.units}` : `${x.title}, ${x.units}`) + (x.where ? `, ${x.where}` : "");
};
// The stage (or measurement) as a label: "Larvae", "Adults", "Carbon biomass".
const stageLabel = () => stageInfo()?.label ?? titleCase(stageWord());
const fmt = (a) => (a >= 100 ? Math.round(a).toLocaleString() : a >= 1 ? a.toFixed(1) : a.toPrecision(2));
// Groups (combined taxa, e.g. "Warm-water associated larvae") go by their name;
// their members are listed in the species details and the map label.
const speciesName = (t) => (t.group ? t.common : t.common ? `${t.common} (${t.scientific})` : t.scientific);
const speciesHTML = (t) => (t.group
  ? `${t.common} <span class="members">(<span class="sci">${t.members}</span>)</span>`
  : t.common ? `${t.common} <span class="sci">(${t.scientific})</span>` : `<span class="sci">${t.scientific}</span>`);
// Featured taxa (the top of the species list, in their set order), then the rest.
const featuredFirst = (list) => [...list].sort((a, b) => (a.featured ?? Infinity) - (b.featured ?? Infinity));
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function stationName(st) {
  const s = meta.stations[st];
  if (s.line === null) return `${isTrack() ? "Underway sample" : "Regional pool"}, ${s.lat.toFixed(3)}°N ${(-s.lon).toFixed(3)}°W`;
  return `Line ${s.line.toFixed(1)}, station ${s.station.toFixed(1)}`;
}

function periodText(p) {
  const period = meta.periods[p];
  return `${MONTHS[period.month - 1]} ${period.year}`;
}

// Seasons: winter = Dec-Feb, spring = Mar-May, summer = Jun-Aug, autumn =
// Sep-Nov. December belongs to the FOLLOWING year's winter, so "Winter 1998"
// is Dec 1997 - Feb 1998. "By season" shows one season of one year (the mean
// of that season's survey months); there is no averaging across years, since
// the interannual and seasonal changes are what the atlas is for. It steps
// either one season year by year, or ("sequence") through every season in
// turn: winter, spring, summer, autumn, then the next year's winter.
const SEASONS = ["winter", "spring", "summer", "autumn"];
const SEASON_LABEL = { winter: "Winter", spring: "Spring", summer: "Summer", autumn: "Autumn" };
const SEASON_FIRST_MONTH = { winter: 12, spring: 3, summer: 6, autumn: 9 };
const seasonYear = (period) => period.year + (period.month === 12 ? 1 : 0);
// Decimal year at which a season starts (winter 1998 -> Dec 1997).
const seasonStart = (season, year) => (season === "winter" ? year - 1 + 11 / 12 : year + (SEASON_FIRST_MONTH[season] - 1) / 12);
const seasonMatches = (season) => state.season === "sequence" || state.season === season;
let seasonSteps = [];          // [{season, year}] with surveys, chronological (see surveySteps)

// The seasons both views step through: every season with a survey of either
// kind -- ichthyoplankton tows with this net and sampling, or hydrographic
// casts from either source -- so the two views walk the same seasons and each
// map shows what was sampled (an untowed season's casts as "no tow" rings in
// the ichthyoplankton view; an uncast season's tows in the hydrography view).
function surveySteps() {
  const keys = new Map();
  const add = (season, year) => {
    if (seasonMatches(season)) keys.set(`${year}-${SEASONS.indexOf(season)}`, { season, year });
  };
  for (const p of available) add(meta.periods[p].season, seasonYear(meta.periods[p]));
  if (hmeta) for (const src of Object.values(hmeta.sources)) for (const x of src.periods) add(SEASON_OF_MONTH[x.month], x.year + (x.month === 12 ? 1 : 0));
  return [...keys.values()].sort((a, b) => seasonStart(a.season, a.year) - seasonStart(b.season, b.year));
}

function updateSeasonSteps() {
  ghost = null;
  const previous = seasonSteps[state.seasonPos];
  seasonSteps = surveySteps();
  if (!seasonSteps.length) { state.seasonPos = 0; return; }
  // Keep the time shown (or the nearest) when the season choice, net or sampling changes.
  const last = seasonSteps[seasonSteps.length - 1];
  const target = previous ? seasonStart(previous.season, previous.year) : seasonStart(last.season, last.year);
  const dist = (step) => Math.abs(seasonStart(step.season, step.year) - target);
  state.seasonPos = seasonSteps.reduce((best, step, i) => (dist(step) < dist(seasonSteps[best]) ? i : best), 0);
}

function seasonPeriods(step = seasonSteps[state.seasonPos]) {
  if (!step) return [];
  return available.filter((p) => meta.periods[p].season === step.season && seasonYear(meta.periods[p]) === step.year);
}

function seasonText(step = seasonSteps[state.seasonPos]) {
  const { season, year } = step;
  const first = SEASON_FIRST_MONTH[season];
  const span = season === "winter"
    ? `Dec ${year - 1}–Feb ${year}`
    : `${MONTHS[first - 1].slice(0, 3)}–${MONTHS[first + 1].slice(0, 3)} ${year}`;
  return `${SEASON_LABEL[season]} ${year} (${span})`;
}

// The stepper and slider walk survey months ("By month") or years for the
// selected season, or every season in turn ("By season").
// In the hydrography view they walk its own survey months and seasons (hydro.js).
const stepList = () => (state.layer === "hydro"
  ? (state.mode === "month" ? hAvailable : hSteps)
  : (state.mode === "month" ? available : seasonSteps));
const stepPos = () => (state.layer === "hydro"
  ? (state.mode === "month" ? hstate.periodPos : hstate.seasonPos)
  : (state.mode === "month" ? state.periodPos : state.seasonPos));
function setStepPos(pos) {
  if (state.layer !== "hydro") ghost = null;
  const st = state.layer === "hydro" ? hstate : state;
  if (state.mode === "month") st.periodPos = pos; else st.seasonPos = pos;
}

// Decimal year of the ichthyoplankton map shown, to carry the time across views.
function ichthyoTime() {
  if (ghost) return ghost.t;
  if (state.mode === "month") {
    const p = meta.periods[available[state.periodPos]];
    return p ? p.year + (p.month - 0.5) / 12 : null;
  }
  const st = seasonSteps[state.seasonPos];
  return st ? seasonStart(st.season, st.year) + 1.5 / 12 : null;
}

function setIchthyoTime(t) {
  if (t === null) return;
  const near = (list, time) => list.reduce((best, x, i) => (Math.abs(time(x) - t) < Math.abs(time(list[best]) - t) ? i : best), 0);
  if (available.length) state.periodPos = near(available, (p) => meta.periods[p].year + (meta.periods[p].month - 0.5) / 12);
  if (seasonSteps.length) state.seasonPos = near(seasonSteps, (x) => seasonStart(x.season, x.year) + 1.5 / 12);
}
// Survey months on the map now: one ("By month") or the season's ("By season").
const shownPeriods = () => (state.mode === "month" ? (available.length ? [available[state.periodPos]] : []) : seasonPeriods());

// ----------------------------------------------------------- rendering --

// Station features for survey months `periods`: one month ("month"), or a
// season's months ("season": a station's value is its standardised abundance,
// or the mean of its survey months where it was sampled in more than one).
// The hydrography overlay passes its own.
let multiStations = 0;         // stations in the season shown with more than one survey month
function features(periods = shownPeriods(), mode = state.mode) {
  const values = taxonCache.get(state.taxon.id);
  const rows = new Map();   // station -> {a, tows, n, hits}
  if (mode === "month") {
    const p = periods[0];
    for (const i of p === undefined ? [] : occupationRows(p)) {
      const a = values.get(catchKey(p, state.sampling, state.net, state.stage, occ.st[i])) || 0;
      rows.set(occ.st[i], { a, tows: occ.t[i] });
    }
  } else {
    for (const p of periods) {
      for (const i of occupationRows(p)) {
        const a = values.get(catchKey(p, state.sampling, state.net, state.stage, occ.st[i])) || 0;
        const r = rows.get(occ.st[i]) || { sum: 0, n: 0, hits: 0, tows: 0 };
        r.sum += a;
        r.n += 1;
        r.hits += a > 0 ? 1 : 0;
        r.tows += occ.t[i];
        rows.set(occ.st[i], r);
      }
    }
    for (const r of rows.values()) r.a = r.sum / r.n;
  }
  // Stations sampled in more than one survey month of the season: only theirs
  // is a mean (one cruise per season since the 1990s, often monthly before).
  multiStations = [...rows.values()].filter((r) => (r.n ?? 1) > 1).length;
  scaleBreaks = computeScale([...rows.values()].map((r) => r.a));
  const out = [];
  for (const [st, r] of rows) {
    const s = meta.stations[st];
    const cls = classOf(r.a);
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { st, a: r.a, cls, tows: r.tows ?? 0, n: r.n ?? 0, hits: r.hits ?? 0 },
    });
  }
  return { type: "FeatureCollection", features: out };
}

function render() {
  if (state.layer === "hydro") { renderHydro(); return; }
  if (!state.taxon || !taxonCache.has(state.taxon.id) || !mapReady) return;
  setHydroVisible(false);
  symbolStyle(false);
  for (const id of ["zero", "catch-ring", "catch", "selected"]) map.setLayoutProperty(id, "visibility", "visible");
  // A season without tows: its casts, as an empty map (see seasonGhost).
  if (state.mode === "season") ghost = seasonPeriods().length ? null : seasonGhost();
  const fc = features(ghost ? [] : shownPeriods());
  map.getSource("stations").setData(fc);
  setNoTow(ghost ? ghost.stations.map((q) => [q.lon, q.lat]) : []);
  if (map.getSource("section-line")) map.getSource("section-line").setData({ type: "FeatureCollection", features: [] });   // sections: hydrography views only
  renderLineLabels(fc);
  const sampled = fc.features.length;
  const withCatch = fc.features.filter((f) => f.properties.a > 0).length;

  $("period-range").max = String(Math.max(0, stepList().length - 1));
  $("period-range").value = stepPos();
  if (ghost) {
    $("period-label").textContent = `${ghost.when}\n${noTowText()}; ${ghost.stations.length} ${ghost.word} stations with casts (open circles).`;
  } else if (state.mode === "month") {
    const p = available[state.periodPos];
    const ships = available.length ? meta.periods[p].ships.map(titleCase).join(", ") : "";
    $("period-label").textContent = available.length
      ? `${periodText(p)} · ${ships}\n${sampled} ${placeWord("stations sampled")}, ${withCatch} with ${stageWord()}`
      : "No surveys with this net and sampling type.";
  } else {
    const months = seasonPeriods();
    $("period-label").textContent = months.length
      ? `${seasonText()}\n${months.length > 1 ? "Survey months" : "Survey month"} ${months.map(periodText).join(", ")} · ${sampled} ${placeWord("stations")}, ${withCatch} with ${stageWord()}`
      : `No ${state.season === "sequence" ? "" : `${state.season} `}surveys with this net and sampling type.`;
  }
  renderMapLabel();
  renderLegend();
  showMapMessage(ghost ? `${noTowText()}` : "", ghost ? `${ghost.when} · open circles: stations with hydrographic casts` : "");
  updateDownloadPanel();
  renderHighCounts();
  if (state.station !== null) renderStationChart();
  writeHash();
}

// CalCOFI line numbers, standard sampling only. Each label lies on its line's
// own extension just beyond the offshore (western) end of the stations shown,
// rotated to the line's angle so it reads as part of that line; the end moves
// with each map's actual coverage (one survey month or one season). HTML markers need no
// map font files.
const LABEL_GAP_PX = 8;
let lineAxes = null;           // line -> {ux, uy, angle}: screen-space direction, west -> east
let stationAxes = null;        // station number -> the same, along its row across the lines
let lastLabelled = null;       // [stationList, line axes, station axes] of the map shown, relaid on zoom

// Web Mercator y for a latitude, in degree-equivalent units (x is longitude),
// so directions computed here match the map's screen angles at every zoom.
const mercatorY = (lat) => (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;

function computeLineAxes(stationList, key = "line") {
  // Best-fit (principal-axis) direction of every station on each line (or, with
  // key "station", each station-number row across the lines), over the whole
  // record, so a survey that sampled part of a line still gets its angle.
  const byLine = new Map();
  for (const s of stationList) {
    if (!byLine.has(s[key])) byLine.set(s[key], []);
    byLine.get(s[key]).push([s.lon, mercatorY(s.lat)]);
  }
  const axes = new Map();
  for (const [line, pts] of byLine) {
    if (pts.length < 2) continue;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);       // principal axis, map coordinates (y north)
    let ux = Math.cos(theta), uy = -Math.sin(theta);           // screen coordinates (y down)
    if (ux < 0) { ux = -ux; uy = -uy; }                        // point west -> east
    axes.set(line, { ux, uy, angle: (Math.atan2(uy, ux) * 180) / Math.PI });
  }
  return axes;
}

function renderLineLabels(fc) {
  for (const m of lineMarkers) m.remove();
  lineMarkers = [];
  lastLabelled = null;
  if (meta.samplings[state.sampling] !== "standard" || isTrack()) return;       // track samples: no lines
  if (!lineAxes) lineAxes = computeLineAxes(meta.stations);
  if (!stationAxes) stationAxes = computeLineAxes(meta.stations, "station");
  placeLineLabels(ghost ? ghost.stations : fc.features.map((f) => meta.stations[f.properties.st]), lineAxes, stationAxes);
}

// Labels for stations [{line, station, lon, lat}] with line axes `axes` and
// station-row axes `stAxes` (the hydrography view passes its own stations).
// Line numbers go beyond each line's offshore (western) end. Station numbers
// go likewise beyond the end of each station-number row (the stations with
// that number across the lines), at the northern edge of the pattern where the
// row reaches the northernmost line shown, else at the southern edge; rows
// ending inside the pattern (inshore, along the curving coast) and labels that
// would overlap one already placed are left out.
function placeLineLabels(stationList, axes, stAxes) {
  stationList = stationList.filter((s) => s.line !== null && s.line !== undefined);      // regional pools have none
  for (const m of lineMarkers) m.remove();
  lineMarkers = [];
  lastLabelled = [stationList, axes, stAxes];
  const placed = [];
  const along = (s, axis) => (axis ? s.lon * axis.ux - mercatorY(s.lat) * axis.uy : s.lon);   // larger = further east
  const groups = (key) => {
    const g = new Map();
    for (const s of stationList) {
      if (!g.has(s[key])) g.set(s[key], []);
      g.get(s[key]).push(s);
    }
    return [...g].filter(([, list]) => list.length >= MIN_LINE_STATIONS);
  };
  const ends = (list, axis) => list.reduce((e, s) => {
    const a = along(s, axis);
    if (!e.w || a < e.wa) { e.w = s; e.wa = a; }
    if (!e.e || a > e.ea) { e.e = s; e.ea = a; }
    return e;
  }, {});
  const lines = groups("line");
  for (const [line, list] of lines) {
    const axis = axes.get(line) || { ux: 1, uy: 0, angle: 0 };
    placed.push(axisLabel(line, "line", ends(list, axis).w, axis, -1));
  }
  if (!stAxes || !lines.length) return;
  const north = Math.min(...lines.map(([l]) => l)), south = Math.max(...lines.map(([l]) => l));
  for (const [st, list] of groups("station")) {
    const axis = stAxes.get(st);
    if (!axis) continue;
    const e = ends(list, axis);
    for (const [s, dir] of [[e.w, -1], [e.e, 1]]) {
      if (s.line !== (dir < 0 ? north : south)) continue;
      const r = axisLabel(st, "station", s, axis, dir);
      if (placed.some((q) => r.left < q.right + 3 && r.right > q.left - 3 && r.top < q.bottom + 3 && r.bottom > q.top - 3)) {
        lineMarkers.pop().remove();
        continue;
      }
      placed.push(r);
      break;
    }
  }
}

// One label for line or station number `n`, beyond station `s` along `axis`
// (dir -1: beyond the western end, +1: the eastern); returns its screen box.
function axisLabel(n, key, s, axis, dir) {
  const el = document.createElement("div");
  el.className = "line-label";
  el.textContent = Number.isInteger(n) ? String(n) : n.toFixed(1);
  el.title = `CalCOFI ${key} ${n.toFixed(1)}`;
  // Anchored and rotated at its centre, with that centre placed on the
  // axis's extension half a label-width beyond the gap, so the extended line
  // bisects the text. (MapLibre rotates a marker about the element's centre,
  // not its anchor, so an end-anchored label would sit off the line.)
  const marker = new maplibregl.Marker({
    element: el,
    anchor: "center",
    rotation: axis.angle,
    rotationAlignment: "viewport",
  }).setLngLat([s.lon, s.lat]).addTo(map);
  const back = LABEL_GAP_PX + el.offsetWidth / 2;
  marker.setOffset([dir * back * axis.ux, dir * back * axis.uy]);
  lineMarkers.push(marker);
  return el.getBoundingClientRect();
}

// The label on the land side of the map: when, which cruises, which species,
// stage and net -- so a screenshot or a playing animation explains itself.
function renderMapLabel() {
  const t = state.taxon;
  const net = meta.nets[state.net];
  const what = `<span class="species">${speciesHTML(t)}</span>` +
    `${stageLabel()} · ${net.label} · ${titleCase(meta.samplings[state.sampling])} sampling`;
  if (ghost) {
    // An empty season: no colour key (nothing is coloured); the message on the map says why.
    $("map-label").innerHTML = `<span class="when">${ghost.when}</span>${noTowText()}: ${ghost.stations.length} ${ghost.word} stations ` +
      `with casts are shown as open circles.<br>${what}`;
    return;
  }
  if (state.mode === "month") {
    if (!available.length) { $("map-label").innerHTML = ""; return; }
    const period = meta.periods[available[state.periodPos]];
    const cruises = period.cruises.map((c) => `${c.key}${c.ship ? ` (${titleCase(c.ship)})` : ""}`).join(", ");
    $("map-label").innerHTML = `<span class="when">${periodText(available[state.periodPos])}</span>` +
      `Cruise${period.cruises.length > 1 ? "s" : ""} ${cruises}<br>${what}` +
      `<span class="bar-title">${valueTitle()}</span>${colourBar(300)}` + partialNote([available[state.periodPos]]);
  } else {
    const months = seasonPeriods();
    if (!months.length) { $("map-label").innerHTML = ""; return; }
    const cruises = [...new Set(months.flatMap((p) => meta.periods[p].cruises.map((c) => c.key)))].join(", ");
    $("map-label").innerHTML = `<span class="when">${seasonText()}</span>` +
      `${months.length > 1 ? "Survey months" : "Survey month"} ${months.map(periodText).join(", ")} · cruise${cruises.includes(",") ? "s" : ""} ${cruises}<br>${what}` +
      `<span class="bar-title">${valueTitle()}</span>${colourBar(300)}` + multiNote() + partialNote(months);
  }
}

// Said only where it is true: some stations in the season shown were sampled
// in more than one survey month, so their values are means.
function multiNote() {
  if (state.mode !== "season" || !multiStations) return "";
  return `<span class="map-note">Mean of the survey months where a station was sampled more than once ` +
    `(${multiStations} station${multiStations > 1 ? "s" : ""}).</span>`;
}

// The season shown, when it has casts but no tows: as the ghost map, with the
// season's cast stations (the hydrography's source first, else the other).
function seasonGhost() {
  const step = seasonSteps[state.seasonPos];
  if (!step || !hmeta) return null;
  const c = seasonCasts(step);
  return { t: seasonStart(step.season, step.year) + 1.5 / 12, season: step.season, year: step.year,
    when: seasonText(step), stations: c.stations, word: c.word };
}

// A prominent message in the middle of the map (an empty season), or none.
function showMapMessage(text, detail = "") {
  const el = $("map-message");
  el.hidden = !text;
  el.innerHTML = text ? `<strong>${text}</strong>${detail ? `<span>${detail}</span>` : ""}` : "";
  // Beside the distribution panels when they are open (they sit top left too).
  const lp = $("left-panels").getBoundingClientRect(), area = document.querySelector(".map-area").getBoundingClientRect();
  el.style.left = `${lp.width > 0 ? lp.right - area.left + 12 : 16}px`;
}

// "No CB-net tows (standard sampling) in this season".
function noTowText() {
  const what = dataset === "ichthyo" || dataset === "volume" ? `${meta.nets[state.net].code}-net` : dataset === "krill" ? "krill" : dataset === "venrick" ? "phytoplankton" : dataset === "pico" ? "flow-cytometry" : DATASETS[dataset];
  return `No ${what} tows (${meta.samplings[state.sampling]} sampling) in this ${state.mode === "season" ? "season" : "month"}`;
}

// Stations [[lon, lat]] to mark "no tow": an open ring, dark on a white halo,
// so it shows on the light sea and on any hydrography palette.
const NO_TOW_RADIUS = 4.5;
function setNoTow(stations) {
  noTowShown = stations.length;
  map.getSource("notow").setData({ type: "FeatureCollection",
    features: stations.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} })) });
}

function renderLegend() {
  $("legend-title").textContent = valueTitle();
  if (ghost && state.layer !== "hydro") {
    $("legend-items").innerHTML = "";
    $("scale-note").textContent = `${noTowText()}, so there is nothing to colour.`;
    return;
  }
  $("legend-items").innerHTML = colourBar(280);
  setToggle("scale-toggle", state.scaleMode);
  const top = scaleBreaks[scaleBreaks.length - 1].toLocaleString();
  const over = scaleOverflow ? ` Values above ${top} share the darkest colour.` : "";
  $("scale-note").textContent = state.scaleMode === "fixed"
    ? `Fixed for comparison: 0–${top}, covering 99% of the record for this species, net, stage and sampling, so colours compare across maps.${over}`
    : `Floating: 0–${top}, covering 95% of this map's catches; colours compare within this map only.${over}`;
}

// Legend: the grey "0" symbol, then the ten classes as the map draws them
// (colour and size, on the dark disc), with the template's integer bounds as
// ticks between them (1k = 1,000). Used in the side panel and the map label.
function colourBar(width, noTow = noTowShown > 0) {
  const b = scaleBreaks, zeroW = noTow ? 58 : 22, gap = 8, x0 = zeroW + gap;
  const rMax = CLASSES[CLASSES.length - 1].radius + 1.3, top = 2, bh = 2 * rMax + 2, H = top + bh + 16;
  const bw = (width - x0 - 18) / CLASSES.length;   // right margin fits "300+"
  const cy = top + bh / 2;
  const label = (v) => (v >= 1e6 ? `${v / 1e6}M` : v >= 1000 ? `${v / 1000}k` : String(+v.toPrecision(3)));
  const last = b.length - 1;
  const parts = [
    `<circle cx="12" cy="${cy}" r="${ZERO.radius}" fill="${ZERO.color}" stroke="${DISC}" stroke-width="0.6"/>`,
    `<text x="12" y="${top + bh + 12}" text-anchor="middle" font-size="10" fill="#5b5a55">0</text>`,
    noTow ? `<circle cx="42" cy="${cy}" r="${NO_TOW_RADIUS}" fill="none" stroke="#ffffff" stroke-width="2.6"/>` +
      `<circle cx="42" cy="${cy}" r="${NO_TOW_RADIUS}" fill="none" stroke="${DISC}" stroke-width="1.2"/>` +
      `<text x="42" y="${top + bh + 12}" text-anchor="middle" font-size="10" fill="#5b5a55">no tow</text>` : "",
    `<line x1="${x0}" x2="${x0 + bw * CLASSES.length}" y1="${top + bh}" y2="${top + bh}" stroke="#c9c7bf"/>`,
  ];
  CLASSES.forEach((c, i) => parts.push(
    `<circle cx="${x0 + (i + 0.5) * bw}" cy="${cy}" r="${c.radius + 0.65}" fill="${c.color}" stroke="${DISC}" stroke-width="1.3"/>`));
  // Ticks at every bound after 0 (the grey swatch already says 0).
  for (let k = 1; k < b.length; k++) {
    const x = x0 + k * bw;
    parts.push(`<line x1="${x}" x2="${x}" y1="${top + bh - 3}" y2="${top + bh + 3}" stroke="#85837c"/>`);
    const text = label(b[k]) + (k === last && scaleOverflow ? "+" : "");
    parts.push(`<text x="${x}" y="${top + bh + 12}" text-anchor="middle" font-size="10" fill="#5b5a55">${text}</text>`);
  }
  return `<svg class="colour-bar" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="Colour scale">${parts.join("")}</svg>`;
}

// ------------------------------------------------------- station chart --

// "By month": every survey month at the station. "By season": one point per
// season year (the mean of its survey months, as on the map), for the selected
// season, or for every season when stepping in sequence.
function stationSeries(st) {
  const values = taxonCache.get(state.taxon.id);
  const series = [];
  if (state.mode === "season") {
    const bySeason = new Map();
    for (const p of available) {
      const period = meta.periods[p];
      if (!seasonMatches(period.season)) continue;
      const row = occupationRows(p).find((i) => occ.st[i] === st);
      if (row === undefined) continue;
      const year = seasonYear(period);
      const key = `${year}-${period.season}`;
      const d = bySeason.get(key) || { step: { season: period.season, year }, x: seasonStart(period.season, year) + 1.5 / 12, sum: 0, n: 0, tows: 0 };
      d.sum += values.get(catchKey(p, state.sampling, state.net, state.stage, st)) || 0;
      d.n += 1;
      d.tows += occ.t[row];
      bySeason.set(key, d);
    }
    for (const d of bySeason.values()) series.push({ ...d, a: d.sum / d.n });
    return series.sort((a, b) => a.x - b.x);
  }
  for (const p of available) {
    const row = occupationRows(p).find((i) => occ.st[i] === st);
    if (row === undefined) continue;
    const period = meta.periods[p];
    series.push({
      p,
      x: period.year + (period.month - 0.5) / 12,
      a: values.get(catchKey(p, state.sampling, state.net, state.stage, st)) || 0,
      tows: occ.t[row],
    });
  }
  return series;
}

// st: the station (ichthyoplankton index); the hydrography views pass theirs.
// Station ensemble (2026-10-15, user's test, as for model-ensemble time
// series): every station's series as a thin grey line, the median of all
// stations as a dark line, the selected one red, each smoothed by a
// Gaussian-weighted running mean (sigma ensembleSigma, years: the Smoothing
// menu's 1 / 2 / 4 years is the width, sigma half of it) and broken across gaps longer than
// ENSEMBLE_GAP_YR; the bubbles stay raw.
let ensembleSigma = 0.5;                // default 1 year
const ENSEMBLE_SIGMA_CHOICES = [0.5, 1, 2];
const ENSEMBLE_GAP_YR = 3;
// points [[x (decimal year), y]] sorted by x -> smoothed segments
function smoothSegments(points) {
  const segs = [];
  let seg = [];
  points.forEach((q, i) => {
    if (i && q[0] - points[i - 1][0] > ENSEMBLE_GAP_YR) { if (seg.length > 1) segs.push(seg); seg = []; }
    seg.push(q);
  });
  if (seg.length > 1) segs.push(seg);
  const s2 = 2 * ensembleSigma ** 2, reach = 3 * ensembleSigma;
  return segs.map((g) => g.map(([x]) => {
    let w = 0, v = 0;
    for (const [x2, y2] of g) {
      const d = x2 - x;
      if (Math.abs(d) > reach) continue;
      const k = Math.exp(-(d * d) / s2);
      w += k; v += k * y2;
    }
    return [x, v / w];
  }));
}
const ensemblePath = (segments, sx, sy) =>
  segments.map((g) => "M" + g.map(([x, v]) => `${sx(x).toFixed(1)},${sy(v).toFixed(1)}`).join("L")).join("");
// The median across all stations at each survey time (stations sharing a
// survey share its x), as one series; surveys of only a few stations
// (meta.partial, e.g. the line 90 supplement) are left out.
function ensembleMedian(all) {
  const byX = new Map();
  for (const pts of all.values()) for (const [x, v, partial] of pts) {
    if (partial) continue;                    // a survey of a few stations only (meta.partial)
    const k = Math.round(x * 1200);
    if (!byX.has(k)) byX.set(k, { x, vals: [] });
    byX.get(k).vals.push(v);
  }
  return [...byX.values()].sort((a, b) => a.x - b.x).map(({ x, vals }) => {
    vals.sort((a, b) => a - b);
    const n = vals.length, h = n >> 1;
    return [x, n % 2 ? vals[h] : (vals[h - 1] + vals[h]) / 2];
  });
}
// Grey ensemble lines (every station but the selected), the dark median of all
// stations, the selected red line, as SVG, clipped to the plot (key: #ens-key).
function ensembleSVG(all, st, sx, sy, clip) {
  const grey = [];
  for (const [k, pts] of all) if (k !== st && pts.length > 1) grey.push(ensemblePath(smoothSegments(pts), sx, sy));
  const own = all.get(st), med = ensembleMedian(all);
  return `<defs><clipPath id="ens-clip"><rect x="${clip.x}" y="${clip.y}" width="${clip.w}" height="${clip.h}"/></clipPath></defs>` +
    `<g clip-path="url(#ens-clip)" fill="none"><path d="${grey.join("")}" stroke="#8a8880" stroke-opacity="0.28" stroke-width="0.6"/>` +
    (med.length > 1 ? `<path d="${ensemblePath(smoothSegments(med), sx, sy)}" stroke="#2b2a27" stroke-width="1.6"/>` : "") +
    (own && own.length > 1 ? `<path d="${ensemblePath(smoothSegments(own), sx, sy)}" stroke="#d62728" stroke-width="1.3"/>` : "") + "</g>";
}
const quantileOf = (vals, q) => { const s2 = vals.slice().sort((a, b) => a - b); return s2.length ? s2[Math.min(s2.length - 1, Math.floor(q * s2.length))] : NaN; };

// Every station's series at once (as stationSeries, one pass): station -> [[x, log10(1 + a)]].
let ensembleCache = { key: null, all: null };
function allStationSeries() {
  const key = [state.taxon.id, dataset, state.net, state.stage, state.sampling, state.mode, state.season].join("|");
  if (ensembleCache.key === key) return ensembleCache.all;
  const values = taxonCache.get(state.taxon.id), acc = new Map();
  for (const p of available) {
    const period = meta.periods[p];
    if (state.mode === "season" && !seasonMatches(period.season)) continue;
    const year = seasonYear(period);
    const x = state.mode === "season" ? seasonStart(period.season, year) + 1.5 / 12 : period.year + (period.month - 0.5) / 12;
    for (const i of occupationRows(p)) {
      const st = occ.st[i], a = values.get(catchKey(p, state.sampling, state.net, state.stage, st)) || 0;
      if (!acc.has(st)) acc.set(st, new Map());
      const r = acc.get(st).get(x) || { sum: 0, n: 0, partial: false };
      r.sum += a; r.n += 1; r.partial ||= partialPeriods.has(p); acc.get(st).set(x, r);
    }
  }
  const all = new Map();
  for (const [st, byX] of acc) all.set(st, [...byX].map(([x, r]) => [x, Math.log10(1 + r.sum / r.n), r.partial]).sort((a, b) => a[0] - b[0]));
  ensembleCache = { key, all };
  return all;
}

function renderStationChart(st = state.station) {
  if (state.layer !== "hydro") $("chart-toggle").hidden = true;
  const series = stationSeries(st);
  $("station-panel").hidden = false;
  document.querySelector(".map-area").classList.add("station-open");
  $("station-title").textContent =
    `${stationName(st)} — ${speciesName(state.taxon)}, ${unitsLabel()}, ` +
    `${meta.nets[state.net].code} net, ${meta.samplings[state.sampling]} sampling (` +
    (state.mode === "month" ? `${series.length} survey months)`
      : `${state.season === "sequence" ? "all seasons" : SEASON_LABEL[state.season].toLowerCase()}, ${series.length} seasons)`);

  const box = $("station-chart");
  const W = box.clientWidth || 600;
  const H = box.clientHeight || 180;
  const m = { l: 52, r: 12, t: 10, b: 24 };
  const y = (a) => Math.log10(1 + a);
  const all = allStationSeries();
  const ensTop = quantileOf([...all.values()].flatMap((pts) => pts.map((q) => q[1])), 0.995);
  const yMax = Math.max(1, Math.ceil(Math.max(0, ensTop || 0, ...series.map((d) => y(d.a)))));
  const x0 = 1950, x1 = meta.periods[meta.periods.length - 1].year + 1;
  const sx = (x) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);

  const parts = [];
  // Gridlines at 0, 10, 100, ...: on a log(1 + x) axis 0 and 1 sit too close to label both.
  for (let k = 0; k <= yMax; k++) {
    if (k === 1) continue;
    const v = k === 0 ? 0 : 10 ** (k - 1);
    const yy = sy(y(v));
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="#ecebe6"/>`);
    parts.push(`<text x="${m.l - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#85837c">${v.toLocaleString()}</text>`);
  }
  for (let yr = 1950; yr <= x1; yr += 10) {
    parts.push(`<text x="${sx(yr)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#85837c">${yr}</text>`);
  }
  if (state.mode === "month" && available.length) {
    const period = meta.periods[available[state.periodPos]];
    const xx = sx(period.year + (period.month - 0.5) / 12);
    parts.push(`<line x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H - m.b}" stroke="#2a78d6" stroke-dasharray="3 3"/>`);
  } else if (state.mode === "season" && seasonSteps.length) {
    // The season's three months as a band (at least 3 px wide, so it shows at any width).
    const { season, year } = seasonSteps[state.seasonPos];
    const start = seasonStart(season, year);
    const xa = sx(start), w = Math.max(3, sx(start + 0.25) - xa);
    parts.push(`<rect x="${xa}" y="${m.t}" width="${w}" height="${H - m.t - m.b}" fill="#2a78d6" opacity="0.18"/>`);
  }
  parts.push(ensembleSVG(all, st, sx, sy, { x: m.l, y: m.t, w: W - m.l - m.r, h: H - m.t - m.b }));
  // Colour and size as on the map (three-quarters scale), the smaller on top.
  for (const d of series.slice().sort((p, q) => q.a - p.a)) {
    const cls = classOf(d.a);
    const color = cls < 0 ? ZERO.color : CLASSES[cls].color;
    const r = cls < 0 ? 2 : 0.75 * CLASSES[cls].radius;
    parts.push(`<circle cx="${sx(d.x)}" cy="${sy(y(d.a))}" r="${r}" fill="${color}" stroke="${cls < 0 ? "#fff" : OUTLINE}" stroke-width="0.6"/>`);
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Abundance through time at this station">${parts.join("")}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  const svg = box.querySelector("svg");
  // Only the bubbles answer the pointer: the one under it (its radius + 3 px), the smallest on top.
  const radiusOf = (d) => { const cls = classOf(d.a); return cls < 0 ? 2 : 0.75 * CLASSES[cls].radius; };
  const bubbleAt = (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W, py = ((event.clientY - rect.top) / rect.height) * H;
    let best = null, bestR = Infinity;
    for (const d of series) {
      const r = radiusOf(d), dist = Math.hypot(sx(d.x) - px, sy(y(d.a)) - py);
      if (dist <= r + 3 && r < bestR) { best = d; bestR = r; }
    }
    return best;
  };
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const best = bubbleAt(event);
    svg.style.cursor = best ? "pointer" : "";
    if (!best) { tip.hidden = true; return; }
    tip.hidden = false;
    const value = best.a > 0 ? `${fmt(best.a)} ${unitsLabel()}` : `no ${stageWord()} caught`;
    const tows = `${best.tows} tow${best.tows > 1 ? "s" : ""}`;
    tip.textContent = best.step
      ? `${seasonText(best.step)}: ${value} (${best.n > 1 ? `mean of ${best.n} survey months` : "1 survey month"}, ${tows})`
      : `${periodText(best.p)}: ${value} (${tows})`;
    const left = (sx(best.x) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(sy(y(best.a)) / H) * rect.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  // Clicking a bubble shows that survey month (or season) on the map.
  svg.addEventListener("click", (event) => {
    const best = bubbleAt(event);
    if (!best) return;
    stopPlay();
    ghost = null;
    if (best.step) {
      state.seasonPos = seasonSteps.findIndex((s) => s.season === best.step.season && s.year === best.step.year);
    } else {
      if (state.mode !== "month") setMode("month");
      state.periodPos = available.indexOf(best.p);
    }
    // In the hydrography views the map moves to that time too.
    if (state.layer === "hydro") updateHydroSteps(ichthyoTime());
    render();
  });

  if (state.layer === "hydro") return;      // the hydrography views draw their own ring
  map.getSource("selected").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [meta.stations[st].lon, meta.stations[st].lat] }, properties: {} }],
  });
}

function closeStation() {
  placeLogo();
  if (state.layer === "hydro") {
    hstate.stationKey = null;
    map.getSource("hydro-selected").setData({ type: "FeatureCollection", features: [] });
  } else state.station = null;
  $("station-panel").hidden = true;
  document.querySelector(".map-area").classList.remove("station-open");
  map.getSource("selected").setData({ type: "FeatureCollection", features: [] });
  updateDownloadPanel();
  writeHash();
}

// ------------------------------------------------------------ controls --

function fillSelect(select, options, value) {
  select.innerHTML = options.map((o, i) => `<option value="${i}">${o}</option>`).join("");
  select.value = String(value);
}

function speciesMatches(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return featuredFirst(taxa.filter((t) => {
    const text = `${t.common || ""} ${t.scientific} ${t.family || ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  })).slice(0, 40);
}

function setupSpeciesPicker() {
  const input = $("species-input");
  const list = $("species-list");
  let matches = [];
  let active = -1;
  let previewed = false;       // whether the highlighted entry is the one on the map

  const show = () => {
    // The box still holding the current species' name counts as empty: show
    // the featured list first.
    const query = state.taxon && input.value === speciesName(state.taxon) ? "" : input.value;
    matches = speciesMatches(query);
    // Start from the species shown, if it is listed, so the arrows step on from
    // it; otherwise highlight the first match (Enter chooses it).
    const current = matches.indexOf(state.taxon);
    active = current >= 0 ? current : matches.length ? 0 : -1;
    previewed = current >= 0;
    list.innerHTML = matches.map((t, i) =>
      `<li role="option" data-id="${t.id}" aria-selected="${i === active}">` +
      (t.group ? `<strong>${t.common}</strong>` : `${t.common ? `${t.common} · ` : ""}<span class="sci">${t.scientific}</span>`) +
      `<span class="count">${t.rows.toLocaleString()}</span></li>`).join("");
    list.hidden = matches.length === 0;
  };
  const highlight = () => {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const choose = (t) => {
    list.hidden = true;
    input.value = speciesName(t);
    selectTaxon(t, true);
  };

  input.addEventListener("focus", () => { input.select(); show(); });
  input.addEventListener("input", show);
  input.addEventListener("keydown", (event) => {
    // Arrow keys step through the list and show each species as they go (as the
    // depth selector does); the typed text stays, so the list stays put.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) show();
      // The first press after typing shows the highlighted (first) match itself.
      const next = !previewed ? active : event.key === "ArrowDown" ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
      if (next < 0) return;
      previewed = true;
      active = next;
      highlight();
      selectTaxon(matches[active], true, { keepInput: true });
    }
    if (event.key === "Enter" && active >= 0) { choose(matches[active]); input.blur(); }
    if (event.key === "Escape") { list.hidden = true; input.value = speciesName(state.taxon); input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    list.hidden = true;
    if (state.taxon) input.value = speciesName(state.taxon);
  }, 150));
  list.addEventListener("mousedown", (event) => {
    const li = event.target.closest("li");
    if (li) choose(taxa[Number(li.dataset.id)]);
  });
}

function setupSpeciesSelect() {
  const label = (t) => (t.group ? t.common : t.common ? `${t.common} — ${t.scientific}` : t.scientific);
  const option = (t) => `<option value="${t.id}">${label(t)} (${t.rows.toLocaleString()})</option>`;
  const featured = featuredFirst(taxa.filter((t) => t.featured !== undefined));
  const all = taxa.filter((t) => !t.group).sort((a, b) => label(a).localeCompare(label(b)));
  $("species-select").innerHTML = (featured.length ? `<optgroup label="Featured">${featured.map(option).join("")}</optgroup>` : "") +
    (dataset === "ichthyo" ? `<optgroup label="All taxa (A–Z)">${all.map(option).join("")}</optgroup>`
      : taxa.map(option).join(""));        // zooplankton: the dataset's own order
}

async function selectTaxon(t, resetNet, { keepInput = false } = {}) {
  stopPlay();
  state.taxon = t;
  if (resetNet) {
    // Keep the net and life stage chosen unless the new species has no records
    // with them; then the bongo net, or its most-used net if never caught in a bongo.
    if (!(t.netRows[state.net] > 0)) {
      const bongo = meta.nets.findIndex((n) => n.code === DEFAULT_NET);
      state.net = bongo >= 0 && t.netRows[bongo] > 0 ? bongo : t.topNet;
    }
    const rows = t.stageRows || [t.eggs, t.larvae];
    if (!(rows[state.stage] > 0)) state.stage = dataset === "ichthyo" ? (t.eggs > 0 && !t.larvae ? 0 : 1) : Math.max(0, rows.findIndex((r) => r > 0));
  }
  if (!keepInput) $("species-input").value = speciesName(t);
  $("species-select").value = String(t.id);
  $("species-detail").textContent = dataset !== "ichthyo"
    ? `${meta.title} · ${t.rows.toLocaleString()} station-month records`
    : t.group
    ? `Group: the summed abundance of ${t.members} · ${t.larvae.toLocaleString()} larva records`
    : `${t.family ? `${t.family} · ` : ""}${t.larvae.toLocaleString()} larva and ${t.eggs.toLocaleString()} egg records`;
  $("stage-select").value = String(state.stage);
  $("net-select").value = String(state.net);
  $("status").textContent = "Loading…";
  try {
    await loadTaxon(t.id);
    $("status").textContent = "";
  } catch (err) {
    $("status").textContent = `Could not load data: ${err.message}`;
    return;
  }
  onFilterChange(false);
}

function onFilterChange(keepPeriod = true) {
  const previous = available[state.periodPos];
  updateAvailable();
  const pos = keepPeriod ? available.indexOf(previous) : -1;
  if (pos >= 0) {
    state.periodPos = pos;
  } else if (previous !== undefined && available.length) {
    // Nearest available survey month to the one previously shown.
    state.periodPos = available.reduce((best, p, i) =>
      Math.abs(p - previous) < Math.abs(available[best] - previous) ? i : best, 0);
  } else {
    state.periodPos = Math.min(state.periodPos, Math.max(0, available.length - 1));
  }
  updateSeasonSteps();
  if (hmeta && hData()) updateHydroSteps();    // the shared seasons depend on the net and sampling
  render();
}

function setMode(mode) {
  stopPlay();
  // Keep the time shown when switching between By month and By season.
  const t = state.layer === "hydro" && hmeta && hData() ? hTime() : null;
  const ti = state.taxon ? ichthyoTime() : null;
  ghost = null;
  state.mode = mode;
  if (t !== null) updateHydroSteps(t);
  if (ti !== null) setIchthyoTime(ti);
  document.querySelectorAll("#view-toggle button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("season-controls").hidden = mode !== "season";
  updateStepTitle();
  render();
}

// Ichthyoplankton or hydrography. The time shown carries across; the
// species controls stay for the hydrography's optional ichthyoplankton overlay.
// choice: "ichthyo", "hydro" or "anomaly" (the hydrography view showing
// departures from climatology).
// The Dataset menu: the view's own datasets (Ichthyoplankton: net tows or
// CUFES; Zooplankton: krill, ZooScan, plankton volume). The hydrographic views
// pick their overlay with their own Overlay menu.
async function chooseDataset(ds) {
  if (state.layer === "hydro") { await switchDataset(ds); return; }
  await setLayer(viewOf(ds), ds);
}

async function setLayer(choice, viewDataset) {
  // "ichthyo" / "zoo" / "phyto": the same machinery, each with its own datasets.
  const want = choice === "zoo" ? (viewDataset || lastZoo) : choice === "phyto" ? (viewDataset || lastPhyto)
    : choice === "ichthyo" ? (viewDataset || lastFish) : null;
  if (want && want !== dataset) {
    await switchDataset(want);
    if (state.layer !== "hydro") { updateLayerControls(); render(); return; }
  }
  if (choice === "zoo" || choice === "phyto") choice = "ichthyo";        // the map layer is the same
  const layer = choice === "ichthyo" ? "ichthyo" : "hydro";
  if (layer === state.layer) {
    if (layer === "hydro" && choice !== hView()) {
      stopPlay();
      setHydroView(choice);
      updateLayerControls();
      render();
    }
    return;
  }
  stopPlay();
  if (layer === "hydro") setHydroView(choice);
  // The selected station carries across by its "line station" key.
  if (layer === "hydro") {
    hydroPendingTime = ichthyoTime();
    ghost = null;
    if (hmeta && hData()) updateHydroSteps(hydroPendingTime);
    hstate.stationKey = state.station !== null ? meta.stations[state.station].key : null;
    state.station = null;
    map.getSource("selected").setData({ type: "FeatureCollection", features: [] });
    for (const m of lineMarkers) m.remove();
    lineMarkers = [];
    lastLabelled = null;
  } else {
    setIchthyoTime(hmeta && hData() ? hTime() : null);
    ghost = hmeta && hData() ? hydroGhost() : null;
    const i = hstate.stationKey !== null ? meta.stations.findIndex((s) => s.key === hstate.stationKey) : -1;
    state.station = i >= 0 ? i : null;
    hstate.stationKey = null;
    if (state.station === null) {
      $("station-panel").hidden = true;
      document.querySelector(".map-area").classList.remove("station-open");
    }
  }
  state.layer = layer;
  updateLayerControls();
  render();
}

// EDA (exploratory data analysis) view, 2026-10-16: analyses that aren't maps
// (the ternary plots: the warm/cool one moved here from the Water masses view,
// the krill one added 2026-10-16, replacing an anchovy one). It sits over whichever map view was
// showing, which comes back when it closes. Each plot lives at a fixed
// Firebase address (Fishing Maps repo, upload_calcofi_ternary.py).
let edaOpen = false, edaPlot = "ternary";
const TERNARY_PLOTS = {
  // Drawn in the atlas itself (eda_sections.js), not a published page.
  sections: {
    native: true,
    title: "Water-mass sections",
    hint: "Pacific Subarctic, Pacific Equatorial and North Pacific Central water fractions (OMP analysis of bottle or CTD casts) along any of the six core lines (76.7–93.3), 0–400 m, one season at a time: the three sections step together. The top 30 m is greyed, where the OMP analysis is not valid.",
  },
  ternary: {
    src: "https://firebasestorage.googleapis.com/v0/b/fishing-maps-dd8ce.firebasestorage.app/o/calcofi_public%2FTernary.html?alt=media&token=eebac6e4-c4dd-4c21-978b-c7c75b3d98c0",
    title: "Water-mass composition vs. warm/cool-water ichthyoplankton, winter and spring, core stations",
    hint: "Each core station in each winter (left) and spring (right), stepping together, placed by the strength of Pacific Subarctic, Pacific Equatorial and North Pacific Central water at each one's own core depth (peak OMP fractions, 30–400 m, bottle data), against the warm- and cool-water indicator larvae caught there in the bongo net, year by year.",
  },
  krill: {
    src: "https://firebasestorage.googleapis.com/v0/b/fishing-maps-dd8ce.firebasestorage.app/o/calcofi_public%2FTernary_krill.html?alt=media&token=f28619bb-0464-41a1-b010-d10f28a4685f",
    title: "Water-mass composition vs. cool, warm-central and warm-equatorial krill, winter and spring, core stations",
    hint: "Each core station in each winter (left) and spring (right), stepping together, placed by the strength of Pacific Subarctic, Pacific Equatorial and North Pacific Central water at each one's own core depth (peak OMP fractions, 30–400 m, bottle data), against the adult krill of three groups caught there: cool-water, warm-central (central-gyre) and warm-equatorial species.",
  },
};
function setEda(open, plot = edaPlot) {
  stopPlay();
  edaOpen = open;
  edaPlot = plot;
  updateLayerControls();
  writeHash();
}

function updateLayerControls() {
  const hydro = state.layer === "hydro";
  setToggle("layer-toggle", edaOpen ? "eda" : !hydro ? viewOf() : hView());
  document.querySelector(".layout").classList.toggle("eda-mode", edaOpen);
  document.querySelectorAll(".eda-only").forEach((e) => { e.hidden = !edaOpen; });
  const plot = TERNARY_PLOTS[edaPlot];
  $("ternary-panel").hidden = !edaOpen || Boolean(plot.native);
  $("eda-sections").hidden = !(edaOpen && plot.native);
  if (edaOpen && plot.native) renderEdaSections(); else edaStop();
  setToggle("eda-toggle", edaPlot);
  $("ternary-title").textContent = plot.title;
  $("eda-hint").textContent = plot.hint;
  // Loaded when first shown (~5 MB each); switching plots swaps the page.
  if (edaOpen && plot.src && $("ternary-frame").getAttribute("src") !== plot.src) $("ternary-frame").src = plot.src;
  document.querySelectorAll(".hydro-only").forEach((e) => { e.hidden = !hydro; });
  // Isopycnal variables are CTD only: no source choice.
  if (hydro && hmeta) $("hydro-source-box").hidden = isIso();
  // Sections: Hydrography view, the water-mass fractions in Water masses, and anomalies.
  document.querySelectorAll(".hydro-view-only").forEach((e) => { e.hidden = !(hydro && sectionView()); });
  if (!(hydro && sectionView())) {
    $("section-panel").hidden = true;
    document.querySelector(".map-area").classList.remove("section-open", "panels-split");
  }
  document.querySelectorAll(".ichthyo-only").forEach((e) => { e.hidden = hydro; });
  // Species, stage, net and the abundance legend: the ichthyoplankton view, or the overlay.
  document.querySelectorAll(".fish-controls").forEach((e) => { e.hidden = hydro && !hstate.overlay; });
  // Ichthyoplankton and Zooplankton are separate views, each with its own datasets
  // in the Dataset menu; the hydrography's overlay has its own menu.
  $("dataset-box").hidden = hydro;
  for (const o of $("dataset-select").options) o.hidden = viewOf() !== viewOf(o.value);
  renderHighCounts();   // the distribution panels stay open in both views
  document.querySelector(".subtitle").textContent = edaOpen
    ? "Exploratory data analysis: relationships across the CalCOFI datasets"
    : hydro && hView() === "watermass"
    ? "Water masses: Pacific Subarctic, Pacific Equatorial and North Pacific Central water fractions (OMP), and properties on the σθ 25.8 and 26.4 surfaces"
    : hydro && hstate.derived && !hstate.anomaly
    ? "Derived variables from CalCOFI bottle (1949–2021) and CTD (1993–2026) casts: isopycnal, nitricline, chlorophyll-maximum and mixed layer depths, spiciness, N², integrated chlorophyll and primary production"
    : hydro && hstate.anomaly
    ? "Hydrographic anomalies from each station's climatology, CalCOFI bottle (1949–2021) and CTD (1993–2026) casts"
    : hydro
    ? "Temperature, salinity, density, oxygen, nutrients, carbonate system, chlorophyll and phaeopigment from CalCOFI bottle (1949–2021) and CTD (1993–2026) casts"
    : dataset !== "ichthyo"
    ? `${meta.title}, CalCOFI cruises, ${meta.periods[0].year}–${meta.periods[meta.periods.length - 1].year}`
    : `Fish eggs and larvae from CalCOFI plankton tows, ${meta.periods[0].year}–${meta.periods[meta.periods.length - 1].year}`;
}

function updateStepTitle() {
  const unit = state.mode === "month" ? "survey month" : state.season === "sequence" ? "season" : "year";
  $("step-title").textContent = unit[0].toUpperCase() + unit.slice(1);
  $("prev-btn").setAttribute("aria-label", `Previous ${unit}`);
  $("next-btn").setAttribute("aria-label", `Next ${unit}`);
}

function step(delta) {
  const n = stepList().length;
  if (!n) return;
  if (state.layer !== "hydro" && ghost) {
    // From an untowed survey to the next (or previous) one with tows.
    const times = state.mode === "month"
      ? available.map((p) => meta.periods[p].year + (meta.periods[p].month - 0.5) / 12)
      : seasonSteps.map((x) => seasonStart(x.season, x.year) + 1.5 / 12);
    let pos = delta > 0 ? times.findIndex((t) => t > ghost.t) : times.findLastIndex((t) => t < ghost.t);
    if (pos < 0) pos = delta > 0 ? 0 : n - 1;
    setStepPos(pos);
    render();
    return;
  }
  setStepPos((stepPos() + delta + n) % n);
  render();
}

function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  $("play-btn").textContent = "▶ Play";
  $("play-btn").setAttribute("aria-label", "Play");
}

function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  if (stepPos() >= stepList().length - 1) setStepPos(0);
  playTimer = setInterval(() => {
    if (stepPos() >= stepList().length - 1) { stopPlay(); return; }
    step(1);
  }, PLAY_INTERVAL_MS);
  $("play-btn").textContent = "❚❚ Pause";
  $("play-btn").setAttribute("aria-label", "Pause");
}

function setupControls() {
  $("ens-smooth").value = String(ensembleSigma);
  $("ens-smooth").addEventListener("change", (e) => {
    ensembleSigma = Number(e.target.value);
    if (state.layer === "hydro") renderHydroChart(); else if (state.station !== null) renderStationChart();
    writeHash();
  });
  $("bathy-toggle").checked = bathyOn;
  $("bathy-toggle").addEventListener("change", (e) => { bathyOn = e.target.checked; setBathyVisible(); writeHash(); });
  fillDatasetControls();      // with the link's stage, sampling and net

  $("stage-select").addEventListener("change", (e) => { state.stage = Number(e.target.value); render(); });
  $("sampling-select").addEventListener("change", (e) => { state.sampling = Number(e.target.value); onFilterChange(); });
  $("net-select").addEventListener("change", (e) => { state.net = Number(e.target.value); onFilterChange(); });
  document.querySelectorAll("#view-toggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  document.querySelectorAll("#layer-toggle button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.value === "eda") { setEda(true); return; }
    // Any map view closes the EDA view, back to that map (setLayer is a no-op if it was already showing).
    if (edaOpen) setEda(false);
    setLayer(b.dataset.value);
  }));
  $("ternary-close").addEventListener("click", () => setEda(false));
  $("eda-sec-close").addEventListener("click", () => setEda(false));
  document.querySelectorAll("#eda-toggle button").forEach((b) => b.addEventListener("click", () => setEda(true, b.dataset.value)));
  $("species-select").addEventListener("change", (e) => selectTaxon(taxa[Number(e.target.value)], true));
  $("dataset-select").addEventListener("change", (e) => chooseDataset(e.target.value));
  setupHydroControls();
  setupDownload();
  setupHighCounts();
  document.querySelectorAll("#scale-toggle button").forEach((b) => b.addEventListener("click", () => {
    state.scaleMode = b.dataset.value;
    render();
  }));
  $("prev-btn").addEventListener("click", () => { stopPlay(); step(-1); });
  $("next-btn").addEventListener("click", () => { stopPlay(); step(1); });
  $("play-btn").addEventListener("click", togglePlay);
  $("period-range").addEventListener("input", (e) => { stopPlay(); setStepPos(Number(e.target.value)); render(); });
  $("season-select").addEventListener("change", (e) => {
    stopPlay();
    const t = state.layer === "hydro" && hmeta && hData() ? hTime() : null;
    state.season = e.target.value;
    updateSeasonSteps();
    if (t !== null) updateHydroSteps(t);
    updateStepTitle();
    render();
  });
  $("station-close").addEventListener("click", closeStation);
  // Left/right arrows always step the time, wherever the focus is (a menu
  // just changed, a button, the map), so there is no need to click the map
  // first; only text boxes and the time slider keep them. Up/down are left to
  // the menus. Captured before the menus see the keys.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.target.matches("input[type=search], input[type=text], input[type=number], input[type=range], textarea")) return;
    e.preventDefault();
    if (edaOpen && edaPlot === "sections") { edaStop(); edaStep(e.key === "ArrowLeft" ? -1 : 1); return; }     // the EDA sections' seasons
    stopPlay();
    step(e.key === "ArrowLeft" ? -1 : 1);
  }, true);
  setupSpeciesPicker();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (edaOpen && edaPlot === "sections") renderEdaSections();
      if (state.layer === "hydro" && sectionShown()) renderSection();
      if (state.layer === "hydro") { if (hstate.stationKey !== null) renderHydroChart(); renderHighCounts(); return; }
      if (state.station !== null) renderStationChart();
      renderHighCounts();
    }, 150);
  });
}

// --------------------------------------------------------- high counts --
//
// Distribution of every non-zero count for the selected species, net, life
// stage and sampling type over the whole record (histogram of log10 counts),
// with the 95th percentile marked. Counts at or above it are drawn as dots in
// a zoomed strip below; clicking one shows that survey and station on the map.
// Zeros are left out: for most species most samples catch nothing, so the
// 95th percentile of all samples would often be 0.

const HIGH_PERCENTILE = 0.95;
const HIGH_SELECTED_COLOR = "#d62728";   // the selected sample
let highOpen = false;
let highSelected = null;       // {key, st} of the dot last clicked

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// The values the distribution is built from, matching what the map shows.
// "By month": every sample (station x survey month), keyed by survey month.
// "By season": one value per station and season year -- the mean of its survey
// months, zeros included, as on the map -- for the selected season (every
// season when stepping in sequence), keyed "year-season".
const stepKey = (step) => `${step.year}-${step.season}`;

function highCountData() {
  if (state.mode === "season") {
    const values = taxonCache.get(state.taxon.id);
    const acc = new Map();
    for (const p of available) {
      const period = meta.periods[p];
      if (!seasonMatches(period.season)) continue;
      const step = { season: period.season, year: seasonYear(period) };
      for (const i of occupationRows(p)) {
        const st = occ.st[i];
        const k = `${stepKey(step)}|${st}`;
        const r = acc.get(k) || { st, step, key: stepKey(step), sum: 0, n: 0 };
        r.sum += values.get(catchKey(p, state.sampling, state.net, state.stage, st)) || 0;
        r.n += 1;
        acc.set(k, r);
      }
    }
    const all = [...acc.values()].map((r) => ({ a: r.sum / r.n, n: r.n, st: r.st, step: r.step, key: r.key }));
    return { counts: all.filter((r) => r.a > 0), samples: all.length };
  }
  const t = taxonCache.get(state.taxon.id).raw;
  const counts = [];
  for (let i = 0; i < t.a.length; i++) {
    if (t.s[i] === state.sampling && t.n[i] === state.net && t.g[i] === state.stage) {
      counts.push({ a: t.a[i], p: t.p[i], key: t.p[i], st: t.st[i] });
    }
  }
  let samples = 0;
  for (let i = 0; i < occ.p.length; i++) if (occUsed(i)) samples++;
  return { counts, samples };
}

// The ichthyoplankton survey months of the map shown (in the hydrography
// view, those matching its month or season), for the strip's colours.
const highShownPeriods = () => {
  if (state.layer !== "hydro") return shownPeriods();
  if (state.mode === "month") return ichthyoPeriodsForHydro();
  const step = hSteps[hstate.seasonPos];
  return step ? available.filter((p) => meta.periods[p].season === step.season && seasonYear(meta.periods[p]) === step.year) : [];
};

// What the map shows now, as distribution keys.
// In the hydrography view: the ichthyoplankton survey months (or season) of the
// hydrography map shown.
const shownKeys = () => {
  if (state.layer === "hydro") {
    if (state.mode === "month") return new Set(ichthyoPeriodsForHydro());
    return new Set(hSteps.length ? [stepKey(hSteps[hstate.seasonPos])] : []);
  }
  if (ghost) return new Set();
  return new Set(state.mode === "month"
    ? shownPeriods()
    : (seasonSteps.length ? [stepKey(seasonSteps[state.seasonPos])] : []));
};
const shownTimeText = () => {
  if (state.layer === "hydro") {
    if (state.mode === "month") { const p = hShownPeriods()[0]; return p === undefined ? "" : hPeriodText(p); }
    return hSteps.length ? seasonText(hSteps[hstate.seasonPos]) : "";
  }
  if (ghost) return ghost.when;
  return state.mode === "month" ? (available.length ? periodText(available[state.periodPos]) : "") : (seasonSteps.length ? seasonText() : "");
};
// Words for the distribution's units.
const highUnit = (n = 2) => (state.mode === "month" ? (n === 1 ? "sample" : "samples") : (n === 1 ? "station-season" : "station-seasons"));

function renderHighCounts() {
  placeLogo();   // the panels may have opened or closed
  $("left-panels").hidden = !highOpen;
  $("high-toggle").setAttribute("aria-pressed", String(highOpen));
  if (!highOpen) return;
  if (!state.taxon || !taxonCache.has(state.taxon.id)) return;     // not loaded yet (a link opening with the panel)
  const { counts, samples } = highCountData();
  const net = meta.nets[state.net];
  $("high-title").textContent =
    `${speciesName(state.taxon)}, ${stageWord()}, ${net.code} net, ${meta.samplings[state.sampling]} sampling` +
    (state.mode === "season" ? `, ${state.season === "sequence" ? "all seasons" : state.season} (by season)` : "");
  const box = $("high-chart");
  if (counts.length < 2) {
    box.innerHTML = "";
    $("high-note").textContent = `Too few non-zero counts (${counts.length}) to form a distribution.`;
    renderHighCruises([]);
    return;
  }
  const sorted = counts.map((c) => c.a).sort((a, b) => a - b);
  const p95 = quantile(sorted, HIGH_PERCENTILE);
  const high = counts.filter((c) => c.a >= p95).sort((a, b) => a.a - b.a);

  // Top: histogram of all non-zero counts, 95-100% range shaded.
  // Bottom: the top-5% samples as dots on their own zoomed axis (95th
  // percentile to maximum), spread across the full width so they can be picked.
  const W = box.clientWidth || 440, Htot = box.clientHeight || 270;
  const H = Htot - 95;                            // histogram height; the zoomed strip uses the rest
  const m = { l: 40, r: 24, t: 8, b: 26 };
  const lx = (a) => Math.log10(a);
  const x0 = Math.floor(lx(sorted[0])), x1 = Math.max(x0 + 1, Math.ceil(lx(sorted[sorted.length - 1])));
  const sx = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const bins = 36, bw = (x1 - x0) / bins;
  const hist = new Array(bins).fill(0);
  for (const a of sorted) hist[Math.min(bins - 1, Math.floor((lx(a) - x0) / bw))]++;
  const hMax = Math.max(...hist);
  const sy = (n) => H - m.b - (n / hMax) * (H - m.t - m.b);

  const parts = [];
  // shaded 95-100 percentile range
  parts.push(`<rect x="${sx(lx(p95))}" y="${m.t}" width="${sx(x1) - sx(lx(p95))}" height="${H - m.t - m.b}" fill="#f6efe0"/>`);
  for (let k = 0; k < bins; k++) {
    if (!hist[k]) continue;
    const xa = sx(x0 + k * bw), xb = sx(x0 + (k + 1) * bw);
    parts.push(`<rect x="${xa + 0.5}" y="${sy(hist[k])}" width="${Math.max(0.5, xb - xa - 1)}" height="${H - m.b - sy(hist[k])}" fill="#c9c7bf"/>`);
  }
  for (let e = x0; e <= x1; e++) {
    const v = 10 ** e;
    parts.push(`<line x1="${sx(e)}" x2="${sx(e)}" y1="${H - m.b}" y2="${H - m.b + 4}" stroke="#85837c"/>`);
    parts.push(`<text x="${sx(e)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#85837c">${v >= 1 ? v.toLocaleString() : v}</text>`);
  }
  parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#85837c"/>`);
  parts.push(`<text x="${m.l - 6}" y="${m.t + 10}" text-anchor="end" font-size="11" fill="#85837c">${hMax}</text>`);
  parts.push(`<text x="${m.l - 6}" y="${H - m.b}" text-anchor="end" font-size="11" fill="#85837c">0</text>`);
  parts.push(`<text transform="translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="#85837c">${highUnit()}</text>`);
  const xp = sx(lx(p95));
  parts.push(`<line x1="${xp}" x2="${xp}" y1="${m.t}" y2="${H - m.b}" stroke="#1f1e1c" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${xp - 4}" y="${m.t + 11}" text-anchor="end" font-size="11" fill="#1f1e1c">95th percentile</text>`);

  // Zoomed strip: log axis from the record's 95th percentile to its maximum
  // (fixed, so positions compare from one time step to the next). Only the
  // map shown has dots: its values at or above the 95th percentile, coloured
  // with the map's own scale, as a beeswarm (dots pile up where values
  // coincide, so the height shows how many share a value).
  const shown = shownKeys();
  const shownText = shownTimeText();
  const dots = high.filter((d) => shown.has(d.key)).map((c) => ({ ...c }));
  const zt = H + 16, zb = Htot - 22;              // strip top / bottom
  const z0 = lx(p95), z1 = Math.max(lx(sorted[sorted.length - 1]), z0 + 0.01);
  const zx = (v) => m.l + ((v - z0) / (z1 - z0)) * (W - m.l - m.r);
  parts.push(`<rect x="${m.l}" y="${zt}" width="${W - m.l - m.r}" height="${zb - zt}" fill="#f6efe0"/>`);
  parts.push(`<line x1="${xp}" x2="${m.l}" y1="${H - m.b}" y2="${zt}" stroke="#c9c7bf"/>`);
  parts.push(`<line x1="${sx(x1)}" x2="${W - m.r}" y1="${H - m.b}" y2="${zt}" stroke="#c9c7bf"/>`);
  parts.push(`<text x="${m.l}" y="${zt - 4}" font-size="11" fill="#5b5a55">${shownText || "This map"}: values ≥ 95th percentile (click one)</text>`);
  for (const v of [p95, 10 ** ((z0 + z1) / 2), sorted[sorted.length - 1]]) {
    parts.push(`<text x="${zx(lx(v))}" y="${Htot - 6}" text-anchor="middle" font-size="11" fill="#85837c">${fmt(v)}</text>`);
  }
  // Coloured and sized with the map's scale (set from this map's values; 0.8 of
  // the map's size). Beeswarm: left to right, each dot at the first height up
  // from the strip's floor where it overlaps no dot already placed.
  features(highShownPeriods(), state.mode);
  dots.sort((p, q) => p.a - q.a);
  const placed = [];
  for (const d of dots) {
    const cls = classOf(d.a);
    d.r = cls < 0 ? 2 : 0.8 * CLASSES[cls].radius;
    d.zx = zx(lx(d.a));
    let y = zb - d.r - 2;
    while (placed.some((q) => Math.hypot(q.zx - d.zx, q.zy - y) < q.r + d.r + 1) && y - 1 >= zt + d.r + 2) y -= 1;
    d.zy = y;
    placed.push(d);
  }
  const isSel = (d) => highSelected && highSelected.key === d.key && highSelected.st === d.st;
  for (const d of dots) {
    const cls = classOf(d.a);
    const fill = cls < 0 ? ZERO.color : CLASSES[cls].color;
    parts.push(isSel(d)
      ? `<circle cx="${d.zx}" cy="${d.zy}" r="${d.r + 0.6}" fill="${fill}" stroke="${HIGH_SELECTED_COLOR}" stroke-width="2.2"/>`
      : `<circle cx="${d.zx}" cy="${d.zy}" r="${d.r}" fill="${fill}" stroke="${OUTLINE}" stroke-width="0.7"/>`);
  }
  if (!dots.length) {
    parts.push(`<text x="${(m.l + W - m.r) / 2}" y="${(zt + zb) / 2 + 4}" text-anchor="middle" font-size="11" fill="#85837c">None in ${shownText || "this map"}</text>`);
  }
  const nInSurvey = dots.length;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${Htot}" role="img" aria-label="Distribution of non-zero counts, with this map's values at or above the 95th percentile as clickable points">${parts.join("")}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  const svg = box.querySelector("svg");
  svg.style.cursor = "pointer";
  const nearest = (event) => {
    const r = svg.getBoundingClientRect();
    const px = ((event.clientX - r.left) / r.width) * W, py = ((event.clientY - r.top) / r.height) * Htot;
    let best = null, bestD = Infinity;
    for (const d of dots) {
      const dd = (d.zx - px) ** 2 + (d.zy - py) ** 2;
      if (dd < bestD) { best = d; bestD = dd; }
    }
    return bestD <= 64 ? best : null;
  };
  svg.addEventListener("mousemove", (event) => {
    const d = nearest(event);
    if (!d) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${fmt(d.a)} ${unitsLabel()} · ${stationName(d.st)} · ${d.step ? seasonText(d.step) : periodText(d.p)}` +
      (d.step && d.n > 1 ? ` (mean of ${d.n} survey months)` : "");
    const r = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, (d.zx / W) * r.width - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(d.zy / Htot) * r.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  svg.addEventListener("click", (event) => {
    const d = nearest(event);
    if (d) goToSample(d);
  });

  const what = state.mode === "month" ? "non-zero counts"
    : "non-zero station-season values (one per station and season; the mean where a station was sampled in more than one month)";
  $("high-note").textContent =
    `${counts.length.toLocaleString()} ${what}; 95th percentile = ${fmt(p95)} ${unitsLabel()}. ` +
    `Zeros (${(samples - counts.length).toLocaleString()} ${highUnit(samples - counts.length)} with none caught) are not part of the distribution. ` +
    (!shownText ? "" : nInSurvey
      ? `${nInSurvey} station${nInSurvey > 1 ? "s" : ""} in ${shownText} reached the record's 95th percentile: the dots in the strip, ` +
        `coloured and sized as on the map (click one to select it). ${shownText} is outlined in the calendar.`
      : `No station in ${shownText} reached the record's 95th percentile. ${shownText} is outlined in the calendar.`);
  renderHighCruises(high);
}

// Calendar of the top-5% values: years across; survey months down ("By month")
// or seasons down ("By season": only the selected season, or all four in
// sequence), so the years and seasons of the high counts show at a glance.
// Blank = not sampled with this net and sampling type; grey = sampled, no
// top-5% value; orange (darker = more) = cells holding top-5% values.
const CRUISE_BINS = [
  { min: 1, max: 1, color: "#fdd0a2", label: "1" },
  { min: 2, max: 4, color: "#fd8d3c", label: "2–4" },
  { min: 5, max: 9, color: "#e6550d", label: "5–9" },
  { min: 10, max: Infinity, color: "#a63603", label: "10+" },
];
const SAMPLED_NO_TOP = "#e4e2db";
const CRUISE_SELECTED_COLOR = "#0057e7";   // outline of the survey shown on the map
const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const SEASON_LETTERS = { winter: "W", spring: "Sp", summer: "Su", autumn: "A" };
const CAL_ROW_PX = { month: 12.5, season: 24 };   // cell height

function calendarCells() {
  // [{key, year, row, season, text(), cruises, go()}] plus the row labels.
  const byMonth = state.mode === "month";
  const rows = byMonth ? MONTH_LETTERS : SEASONS.filter(seasonMatches).map((x) => SEASON_LETTERS[x]);
  const cells = [];
  if (byMonth) {
    for (const p of available) {
      const period = meta.periods[p];
      cells.push({
        key: p, year: period.year, row: period.month - 1, season: period.season, text: periodText(p), cruises: period.cruises,
        go: () => { state.periodPos = available.indexOf(p); },
      });
    }
  } else {
    const seasonRows = SEASONS.filter(seasonMatches);
    seasonSteps.forEach((step, i) => {
      if (!seasonPeriods(step).length) return;     // casts only: no tows to show
      cells.push({
        key: stepKey(step), year: step.year, row: seasonRows.indexOf(step.season), season: step.season, text: seasonText(step),
        cruises: seasonPeriods(step).flatMap((p) => meta.periods[p].cruises),
        go: () => { state.seasonPos = i; },
      });
    });
  }
  return { rows, cells };
}

function renderHighCruises(high) {
  const box = $("cruise-chart");
  const byMonth = state.mode === "month";
  $("cruise-title").textContent = byMonth ? "Top 5% samples by survey month" : "Top 5% station-seasons by season";
  const { rows, cells } = calendarCells();
  const m = { l: 22, r: 6, t: 4, b: 18 };
  const H = Math.round(m.t + m.b + rows.length * CAL_ROW_PX[state.mode]);
  box.style.height = `${H}px`;
  if (!high.length || !cells.length) {
    box.innerHTML = "";
    $("cruise-note").textContent = "";
    return;
  }
  const top = new Map();       // cell key -> number of top-5% values
  for (const c of high) top.set(c.key, (top.get(c.key) || 0) + 1);
  const sampled = new Map();   // cell key -> stations sampled
  if (byMonth) {
    for (let i = 0; i < occ.p.length; i++) {
      if (occUsed(i)) sampled.set(occ.p[i], (sampled.get(occ.p[i]) || 0) + 1);
    }
  } else {
    for (const c of cells) sampled.set(c.key, new Set(seasonPeriods(seasonSteps.find((st) => stepKey(st) === c.key)).flatMap((p) => occupationRows(p).map((i) => occ.st[i]))).size);
  }
  const years = cells.map((c) => c.year);
  const y0 = Math.min(...years), y1 = Math.max(...years);
  const W = box.clientWidth || 440;
  const cw = (W - m.l - m.r) / (y1 - y0 + 1), ch = (H - m.t - m.b) / rows.length;
  const cellAt = new Map();    // "year-row" -> cell
  const parts = [];
  const current = shownKeys();
  let selectedRect = "";
  for (const c of cells) {
    cellAt.set(`${c.year}-${c.row}`, c);
    const x = m.l + (c.year - y0) * cw, y = m.t + c.row * ch;
    const n = top.get(c.key) || 0;
    const fill = n ? CRUISE_BINS.find((b) => n >= b.min && n <= b.max).color : SAMPLED_NO_TOP;
    parts.push(`<rect x="${x + 0.3}" y="${y + 0.3}" width="${Math.max(0.8, cw - 0.6)}" height="${ch - 0.6}" fill="${fill}"/>`);
    if (current.has(c.key)) {
      // Bold blue (the strongest contrast with the orange cells) over a white
      // halo, so the shown survey stands out on any cell colour.
      const r = `x="${x - 1}" y="${y - 1}" width="${cw + 2}" height="${ch + 2}" fill="none"`;
      selectedRect += `<rect ${r} stroke="#ffffff" stroke-width="4.5"/><rect ${r} stroke="${CRUISE_SELECTED_COLOR}" stroke-width="2.5"/>`;
    }
  }
  parts.push(selectedRect);
  rows.forEach((l, i) => parts.push(
    `<text x="${m.l - 5}" y="${m.t + (i + 0.5) * ch + 3.5}" text-anchor="end" font-size="9" fill="#85837c">${l}</text>`));
  for (let yr = Math.ceil(y0 / 10) * 10; yr <= y1; yr += 10) {
    parts.push(`<text x="${m.l + (yr - y0 + 0.5) * cw}" y="${H - 5}" text-anchor="middle" font-size="10" fill="#85837c">${yr}</text>`);
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${byMonth ? "Survey months" : "Seasons"} holding top 5% values, by year">${parts.join("")}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  const svg = box.querySelector("svg");
  const cellOf = (event) => {
    const r = svg.getBoundingClientRect();
    const px = ((event.clientX - r.left) / r.width) * W, py = ((event.clientY - r.top) / r.height) * H;
    return cellAt.get(`${y0 + Math.floor((px - m.l) / cw)}-${Math.floor((py - m.t) / ch)}`);
  };
  svg.addEventListener("mousemove", (event) => {
    const c = cellOf(event);
    if (!c) { tip.hidden = true; svg.style.cursor = ""; return; }
    svg.style.cursor = "pointer";
    const cruises = c.cruises.map((x) => `${x.key}${x.ship ? ` (${titleCase(x.ship)})` : ""}`).join(", ");
    tip.hidden = false;
    tip.textContent = `${c.text}: ${top.get(c.key) || 0} of ${sampled.get(c.key) || 0} ${byMonth ? "samples" : "stations"} in the top 5% · ${cruises}`;
    const r = svg.getBoundingClientRect();
    const cx = ((m.l + (c.year - y0 + 0.5) * cw) / W) * r.width;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, cx - tip.offsetWidth / 2))}px`;
    tip.style.top = `${((m.t + c.row * ch) / H) * r.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  svg.addEventListener("click", (event) => {
    const c = cellOf(event);
    if (!c) return;
    stopPlay();
    ghost = null;
    c.go();
    if (state.layer === "hydro") updateHydroSteps(ichthyoTime());
    render();
  });

  // Summary: top-5% values by season and by decade.
  const bySeason = { winter: 0, spring: 0, summer: 0, autumn: 0 };
  const byDecade = new Map();
  for (const h of high) {
    const season = h.step ? h.step.season : meta.periods[h.p].season;
    const year = h.step ? h.step.year : meta.periods[h.p].year;
    bySeason[season]++;
    const dec = Math.floor(year / 10) * 10;
    byDecade.set(dec, (byDecade.get(dec) || 0) + 1);
  }
  const decades = [...byDecade].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d}s (${n})`).join(", ");
  const legend = [`<span class="swatch-sq" style="background:${SAMPLED_NO_TOP}"></span>sampled, none`]
    .concat(CRUISE_BINS.map((b) => `<span style="white-space:nowrap"><span class="swatch-sq" style="background:${b.color}"></span>${b.label}</span>`)).join(" ");
  const seasonsShown = byMonth ? SEASONS : SEASONS.filter(seasonMatches);
  const bySeasonText = seasonsShown.length > 1
    ? ` By season: ${seasonsShown.map((x) => `${x} ${bySeason[x]}`).join(", ")}.` : "";
  const unit = byMonth ? "survey months" : "seasons";
  $("cruise-note").innerHTML =
    `${top.size} ${unit} hold top-5% values.${bySeasonText} Most in the ${decades}. Click a ${byMonth ? "month" : "season"} to show it on the map.` +
    `<br><span class="cruise-legend">Top-5% ${highUnit()} per ${byMonth ? "survey month" : "season"}: ${legend}</span>`;
}

function goToSample(d) {
  stopPlay();
  ghost = null;
  highSelected = { key: d.key, st: d.st };
  if (d.step) state.seasonPos = seasonSteps.findIndex((x) => stepKey(x) === d.key);
  else state.periodPos = available.indexOf(d.p);
  dl.line = null;
  if (state.layer === "hydro") {
    // The hydrography map moves to that time and station.
    hstate.stationKey = meta.stations[d.st].key;
    updateHydroSteps(ichthyoTime());
    render();
  } else {
    state.station = d.st;
    render();
    renderStationChart();
  }
  const s = meta.stations[d.st];
  if (!map.getBounds().contains([s.lon, s.lat])) map.easeTo({ center: [s.lon, s.lat] });
}

function setupHighCounts() {
  $("high-toggle").addEventListener("click", () => { highOpen = !highOpen; renderHighCounts(); });
  $("high-close").addEventListener("click", () => { highOpen = false; renderHighCounts(); });
}

// ------------------------------------------------------------ download --
//
// CSV downloads of a complete time series for the current net, life stage and
// sampling type, at one station or along one CalCOFI line:
//   selected species  one row per sampled survey x station, zeros explicit
//   all species       one file: a row per survey x station x species with
//                     abundance > 0, plus one row with blank species fields
//                     and abundance 0 for each sample with no catch at all, so
//                     every sample appears and zeros can be rebuilt
// Headers are snake_case with no spaces.

const dl = { extent: "station", species: "one", line: null };
const lineCache = new Map();   // line file -> column arrays (all taxa on that line)

const SAMPLE_COLUMNS = ["survey_month", "survey_start", "survey_end", "cruises", "ships", "line", "station",
  "station_key", "latitude", "longitude", "net", "net_description", "sampling", "life_stage", "n_tows"];
const SPECIES_COLUMNS = ["taxon_key", "scientific_name", "common_name", "abundance", "units"];
// Written bare; every other column (and the header row) is quoted, as with
// R's write.csv or pandas QUOTE_NONNUMERIC.
const NUMERIC_COLUMNS = new Set(["line", "station", "latitude", "longitude", "n_tows", "abundance"]);

const quoted = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function csvText(columns, rows) {
  const line = (r) => columns.map((c) => (NUMERIC_COLUMNS.has(c) ? String(r[c] ?? "") : quoted(r[c]))).join(",");
  return [columns.map(quoted).join(","), ...rows.map(line)].join("\r\n") + "\r\n";
}

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (text) => text.replace(/[^A-Za-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");
const lineText = (line) => line.toFixed(1);

function downloadLines() {
  // Lines sampled with the current net and sampling type, numerically.
  const lines = new Set();
  for (let i = 0; i < occ.p.length; i++) {
    if (occ.s[i] === state.sampling && occ.n[i] === state.net && meta.stations[occ.st[i]].line !== null) lines.add(meta.stations[occ.st[i]].line);
  }
  return [...lines].sort((a, b) => a - b);
}

function updateDownloadPanel() {
  const station = state.station === null ? null : meta.stations[state.station];
  $("dl-station").textContent = station
    ? `${stationName(state.station)} (click another station to change it).`
    : "Click a station on the map to choose it.";
  $("dl-station").hidden = dl.extent !== "station";
  $("dl-line-row").hidden = dl.extent !== "line";

  const lines = downloadLines();
  const preferred = dl.line ?? station?.line ?? 90;
  dl.line = lines.includes(preferred) ? preferred : (lines[0] ?? null);
  $("dl-line").innerHTML = lines.map((l) => `<option value="${l}">${lineText(l)}</option>`).join("");
  if (dl.line !== null) $("dl-line").value = String(dl.line);

  const ready = dl.extent === "station" ? station !== null : dl.line !== null;
  $("dl-button").disabled = !ready;
  const net = meta.nets[state.net];
  $("dl-note").textContent =
    `All survey months sampled with the ${net.code} net, ${stageWord()}, ${meta.samplings[state.sampling]} sampling.` +
    (dl.species === "all" ? " All species: one row per species caught; a sample with nothing caught has one row with no species. A species absent from a sample was not caught there." : "");
}

function setToggle(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === value)));
}

function setupDownload() {
  document.querySelectorAll("#dl-extent button").forEach((b) => b.addEventListener("click", () => {
    dl.extent = b.dataset.value; setToggle("dl-extent", dl.extent); updateDownloadPanel();
  }));
  document.querySelectorAll("#dl-species button").forEach((b) => b.addEventListener("click", () => {
    dl.species = b.dataset.value; setToggle("dl-species", dl.species); updateDownloadPanel();
  }));
  $("dl-line").addEventListener("change", (e) => { dl.line = Number(e.target.value); updateDownloadPanel(); });
  $("dl-button").addEventListener("click", () => {
    runDownload().catch((err) => { $("status").textContent = `Download failed: ${err.message}`; });
  });
}

function sampleRow(i) {
  const period = meta.periods[occ.p[i]];
  const station = meta.stations[occ.st[i]];
  const net = meta.nets[state.net];
  return {
    survey_month: period.key,
    survey_start: period.start,
    survey_end: period.end,
    cruises: period.cruises.map((c) => c.key).join(":"),
    ships: period.ships.map(titleCase).join(":"),
    line: lineText(station.line),
    station: station.station.toFixed(1),
    station_key: station.key,
    latitude: station.lat,
    longitude: station.lon,
    net: net.code,
    net_description: net.label.replace(/^\w+: /, ""),
    sampling: meta.samplings[state.sampling],
    life_stage: meta.stages[state.stage],
    n_tows: occ.t[i],
  };
}

// e.g. "per 10 m²" -> "count_per_10_m2" (no spaces in values either)
const unitsColumn = () => (stageInfo() ? `${meta.stages[state.stage]}_${stageInfo().units}` : `count_${meta.nets[state.net].units}`)
  .replace("m²", "m2").replace("m³", "m3").replace("m⁻²", "m-2").replace("µ", "u").replace(/[\s,]+/g, "_");

async function runDownload() {
  const stations = dl.extent === "station"
    ? new Set([state.station])
    : new Set(meta.stations.map((s, i) => (s.line === dl.line ? i : -1)).filter((i) => i >= 0));
  const rows = [];
  for (let i = 0; i < occ.p.length; i++) {
    // One species: its samples (partial surveys only where they report it); all species: every sample.
    if ((dl.species === "one" ? occUsed(i) : occ.s[i] === state.sampling && occ.n[i] === state.net) && stations.has(occ.st[i])) rows.push(i);
  }
  const station = meta.stations[state.station];
  rows.sort((a, b) => occ.p[a] - occ.p[b] || meta.stations[occ.st[a]].station - meta.stations[occ.st[b]].station);
  const where = dl.extent === "station"
    ? `line${lineText(station.line)}_station${station.station.toFixed(1)}`
    : `line${lineText(dl.line)}`;
  const base = `calcofi_ichthyo_${where}_${meta.nets[state.net].code}_${meta.stages[state.stage]}_${slug(meta.samplings[state.sampling])}`;
  const units = unitsColumn();

  if (dl.species === "one") {
    const t = state.taxon;
    const values = taxonCache.get(t.id);
    const out = rows.map((i) => ({
      ...sampleRow(i),
      taxon_key: t.key,
      scientific_name: t.scientific,
      common_name: t.common,
      abundance: values.get(catchKey(occ.p[i], state.sampling, state.net, state.stage, occ.st[i])) || 0,
      units,
    }));
    saveFile(`${base}_${slug(t.scientific)}.csv`, csvText(SAMPLE_COLUMNS.concat(SPECIES_COLUMNS), out));
    return;
  }

  // All species: catches from the line file (a station download uses its line's file).
  const line = dl.extent === "station" ? station.line : dl.line;
  const file = meta.lines.find((l) => l.line === line)?.file;
  $("status").textContent = "Preparing download…";
  if (file && !lineCache.has(file)) lineCache.set(file, await getJSON(`lines/${file}`));
  const L = file ? lineCache.get(file) : { p: [] };
  const occByKey = new Map(rows.map((i) => [`${occ.p[i]}|${occ.st[i]}`, i]));
  const catches = [];
  for (let k = 0; k < L.p.length; k++) {
    if (L.s[k] !== state.sampling || L.n[k] !== state.net || L.g[k] !== state.stage) continue;
    const i = occByKey.get(`${L.p[k]}|${L.st[k]}`);
    if (i === undefined) continue;
    const t = taxa[L.t[k]];
    catches.push({ ...sampleRow(i), taxon_key: t.key, scientific_name: t.scientific, common_name: t.common, abundance: L.a[k], units });
  }
  // Samples with nothing caught still get a row, so every sample is in the file.
  const caught = new Set(catches.map((r) => `${r.survey_month}|${r.station_key}`));
  for (const i of rows) {
    const r = sampleRow(i);
    if (!caught.has(`${r.survey_month}|${r.station_key}`)) {
      catches.push({ ...r, taxon_key: "", scientific_name: "", common_name: "", abundance: 0, units });
    }
  }
  catches.sort((a, b) => a.survey_month.localeCompare(b.survey_month) || Number(a.station) - Number(b.station)
    || a.scientific_name.localeCompare(b.scientific_name));
  $("status").textContent = "";
  saveFile(`${base}_all_species.csv`, csvText(SAMPLE_COLUMNS.concat(SPECIES_COLUMNS), catches));
}

// ----------------------------------------------------------------- URL --

function writeHash() {
  if (!state.taxon) return;
  const params = new URLSearchParams({
    taxon: state.taxon.key,
    stage: meta.stages[state.stage],
    sampling: meta.samplings[state.sampling],
    net: meta.nets[state.net].code,
    view: state.mode,
  });
  if (state.layer === "hydro") {
    params.set("layer", "hydro");
    writeHydroHash(params);
  } else if (state.mode === "month" && available.length) params.set("survey", ghost ? ghost.key : meta.periods[available[state.periodPos]].key);
  if (state.layer !== "hydro" && state.mode === "season" && seasonSteps.length) {
    const { season, year } = ghost || seasonSteps[state.seasonPos];
    params.set("season", state.season);
    if (state.season === "sequence") params.set("shown", season);
    params.set("year", year);
  }
  if (state.layer !== "hydro" && state.station !== null) params.set("station", meta.stations[state.station].key);
  if (state.scaleMode === "fixed") params.set("scale", "fixed");
  if (!bathyOn) params.set("bathy", "0");
  if (edaOpen) params.set("eda", edaPlot);
  if (edaOpen && edaPlot === "sections") writeEdaSectionsHash(params);
  if (ensembleSigma !== 0.5) params.set("smooth", String(ensembleSigma));
  if (highOpen) params.set("dist", "1");
  if (dataset !== "ichthyo") params.set("ds", dataset);
  // The view goes in the query string, not the fragment: LinkedIn (and other
  // link wrappers) drop a link's #fragment, but keep its ?query.
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

// The view in a link: the query string (?taxon=...), or the fragment of
// links made before 2026-10-13 (#taxon=...); the plain address opens the
// landing view (a trial one, 2026-10-13: spring 2016 PEW anomaly at 50 m,
// warm-water larvae overlaid, the line 90 section; to be redesigned).
const LANDING_VIEW = "taxon=group%3Awarm-water&stage=larva&sampling=standard&net=CB&view=season&layer=anomaly&src=ctd" +
  "&var=wm_pew&depth=50&overlay=1&hst=090.0+060.0&disp=section&line=90&season=sequence&shown=spring&year=2016&bathy=0";
const linkView = () => (location.search.length > 1 ? location.search.slice(1) : location.hash.slice(1));
const viewString = () => linkView() || LANDING_VIEW;
// Whether the visitor arrived on the plain address (the landing view), fixed at
// load: the address takes the view as soon as the atlas starts.
const ARRIVED_PLAIN = !linkView();

function readHash() {
  const params = new URLSearchParams(viewString());
  const taxon = taxa.find((t) => t.key === params.get("taxon"));
  const idx = (list, value) => Math.max(0, list.indexOf(value));
  if (params.has("stage")) state.stage = idx(meta.stages, params.get("stage"));
  if (params.has("sampling")) state.sampling = idx(meta.samplings, params.get("sampling"));
  if (params.has("net")) state.net = idx(meta.nets.map((n) => n.code), params.get("net"));
  if (params.get("view") === "season") state.mode = "season";
  if (params.get("scale") === "fixed") state.scaleMode = "fixed";
  if (params.get("bathy") === "0") bathyOn = false;
  if (ENSEMBLE_SIGMA_CHOICES.includes(Number(params.get("smooth"))) && params.has("smooth")) ensembleSigma = Number(params.get("smooth"));
  if (params.get("dist") === "1") highOpen = true;
  if (SEASON_LABEL[params.get("season")] || params.get("season") === "sequence") state.season = params.get("season");
  const year = Number(params.get("year"));
  if (params.has("year") && Number.isFinite(year)) {
    // updateSeasonSteps() then keeps the nearest season with surveys.
    const shown = state.season === "sequence" ? params.get("shown") : state.season;
    seasonSteps = [{ season: SEASON_LABEL[shown] ? shown : "winter", year }];
  }
  if (["hydro", "anomaly", "derived", "watermass"].includes(params.get("layer"))) state.layer = "hydro";
  hstate.anomaly = params.get("layer") === "anomaly";
  hstate.derived = params.get("layer") === "derived";
  hstate.watermass = params.get("layer") === "watermass";
  edaOpen = params.get("eda") in TERNARY_PLOTS;
  if (edaOpen) edaPlot = params.get("eda");
  if (edaPlot === "sections") readEdaSectionsHash(params);
  readHydroHash(params);
  const survey = meta.periods.findIndex((p) => p.key === params.get("survey"));
  const station = meta.stations.findIndex((s) => s.key === params.get("station"));
  return { taxon, survey, station };
}

// Catch symbols on a dark disc (narrower on the light sea, wider over the
// hydrography's colours) inside a thin white ring, so the abundance colours
// stand out on any palette, dark or light.
function symbolStyle(overHydro) {
  const f = meta?.track ? 0.6 : 1;                 // track samples: smaller (trackSymbols)
  const disc = (overHydro ? 1.8 : 1.3) * (f < 1 ? 0.7 : 1);
  map.setPaintProperty("catch", "circle-stroke-color", DISC);
  map.setPaintProperty("catch", "circle-stroke-width", disc);
  map.setPaintProperty("catch-ring", "circle-radius", ["match", ["get", "cls"], ...CLASSES.flatMap((c, i) => [i, c.radius * f + disc]), ZERO.radius]);
}

// ---------------------------------------------------------------- logo --
//
// The CalCOFI logo is a brand label kept on land, as on the Fishing Maps:
// the first place (beside the map label first) whose whole logo box is land and clear
// of the map's panels, re-checked after every move or layout change. With no
// land big enough in view it stays beside the map label.
const LOGO_PX = 108, LOGO_MARGIN = 14;
const DATA_LAYERS = ["zero", "catch", "notow", "hydro-stations"];
const LABEL_DATA_MARGIN = 36;  // px around the label counted as covering data (the mapped field extends past its stations)

// The map label goes in the map corner where it covers the least data (the
// stations drawn, with a margin for the hydrography's field around them),
// clear of the panels over the map; ties keep the preferred order: top right
// (the land side), top left, bottom right, bottom left.
function placeLabel() {
  const el = $("map-label");
  const r0 = el.getBoundingClientRect();
  if (!r0.width) return;
  const area = document.querySelector(".map-area").getBoundingClientRect();
  const W = area.width, H = area.height, w = r0.width, h = r0.height;
  const panels = ["left-panels", "station-panel", "section-panel"]
    .map((id) => $(id).getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ l: r.left - area.left, t: r.top - area.top, r: r.right - area.left, b: r.bottom - area.top }));
  const bottom = Math.min(H - 34, ...panels.filter((p) => p.t > H / 3).map((p) => p.t)) - 12;
  const layers = DATA_LAYERS.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
  const candidates = [[W - 56 - w, 12], [12, 12], [W - 56 - w, bottom - h], [12, bottom - h]];
  let best = null;
  candidates.forEach(([x, y], k) => {
    if (x < 0 || y < 0) return;
    if (panels.some((p) => x < p.r && x + w > p.l && y < p.b && y + h > p.t)) return;
    const m = LABEL_DATA_MARGIN;
    const n = layers.length ? map.queryRenderedFeatures([[Math.max(0, x - m), Math.max(0, y - m)], [Math.min(W, x + w + m), Math.min(H, y + h + m)]], { layers }).length : 0;
    if (!best || n < best.n) best = { x, y, n, k };
  });
  const [x, y] = best ? [best.x, best.y] : candidates[0];
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.right = "auto";
}
let logoFrame = 0;

function placeLogo() {
  cancelAnimationFrame(logoFrame);
  logoFrame = requestAnimationFrame(() => {
    const logo = $("brand-logo");
    if (!mapReady) return;
    placeLabel();
    const area = document.querySelector(".map-area").getBoundingClientRect();
    const W = area.width, H = area.height;
    // Panels shown over the map (hidden or empty ones have no size).
    const blockers = ["map-label", "left-panels", "station-panel", "status"]
      .map((id) => $(id).getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ l: r.left - area.left, t: r.top - area.top, r: r.right - area.left, b: r.bottom - area.top }));
    const station = $("station-panel");
    const bottom = (!station.hidden ? station.getBoundingClientRect().top - area.top : H - 34) - LOGO_MARGIN;   // clear of the scale bar
    const clear = (x, y) => {
      const box = { l: x - 4, t: y - 4, r: x + LOGO_PX + 4, b: y + LOGO_PX + 4 };
      return x >= 0 && y >= 0 && box.r <= W && y + LOGO_PX <= bottom
        && !blockers.some((r) => box.l < r.r && box.r > r.l && box.t < r.b && box.b > r.t);
    };
    const onLand = (x, y) => map.queryRenderedFeatures([x, y], { layers: ["land"] }).length > 0;
    const allLand = (x, y) => {
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) if (!onLand(x + (i / 4) * LOGO_PX, y + (j / 4) * LOGO_PX)) return false;
      return true;
    };
    // Candidates: beside the map label (to its left, top-aligned), then down
    // the right edge, the left edge, and a scan of the whole map (right to left).
    const STEP = 24, candidates = [];
    const label = $("map-label").getBoundingClientRect();
    if (label.width > 0) candidates.push([label.left - area.left - 10 - LOGO_PX, label.top - area.top]);
    for (let y = LOGO_MARGIN; y <= bottom - LOGO_PX; y += STEP) candidates.push([W - 56 - LOGO_PX, y], [W - LOGO_MARGIN - LOGO_PX, y]);
    for (let y = LOGO_MARGIN; y <= bottom - LOGO_PX; y += STEP) candidates.push([LOGO_MARGIN, y]);
    for (let x = W - LOGO_MARGIN - LOGO_PX - 40; x > LOGO_MARGIN; x -= 40) {
      for (let y = LOGO_MARGIN; y <= bottom - LOGO_PX; y += 40) candidates.push([x, y]);
    }
    for (const [x, y] of candidates) {
      if (!clear(x, y) || !onLand(x + LOGO_PX / 2, y + LOGO_PX / 2) || !allLand(x, y)) continue;
      logo.style.left = `${x}px`;
      logo.style.top = `${y}px`;
      logo.hidden = false;
      return;
    }
    // No land big enough in view: keep the brand label beside the map label anyway.
    if (label.width > 0 && clear(...candidates[0])) {
      logo.style.left = `${candidates[0][0]}px`;
      logo.style.top = `${candidates[0][1]}px`;
      logo.hidden = false;
      return;
    }
    logo.hidden = true;
  });
}

// ------------------------------------------------------ depth contours --
//
// Depth contours (docs/data/bathymetry.geojson, build_bathymetry.py), the same
// under every survey, with depth labels along the longer lines: HTML markers,
// like the hydrography's contour labels (the map has no font files), relaid
// after every move. The "Depth contours" checkbox shows or hides both.
let bathyFC = null, bathyMarkers = [], bathyOn = true;
const BATHY_LABEL_SPACING_PX = 520, BATHY_LABEL_MIN_LINE_PX = 180, BATHY_LABEL_SEPARATION_PX = 80, BATHY_LABEL_EDGE_PX = 30;

async function loadBathymetry() {
  bathyFC = await getJSON("bathymetry.geojson");
  map.getSource("bathymetry").setData(bathyFC);
  map.on("moveend", layoutBathyLabels);
  setBathyVisible();
}

function setBathyVisible() {
  for (const id of ["bathy-halo", "bathy"]) map.setLayoutProperty(id, "visibility", bathyOn ? "visible" : "none");
  layoutBathyLabels();
}

function layoutBathyLabels() {
  for (const m of bathyMarkers) m.remove();
  bathyMarkers = [];
  if (!bathyOn || !bathyFC) return;
  const canvas = map.getCanvas(), W = canvas.clientWidth, H = canvas.clientHeight, e = BATHY_LABEL_EDGE_PX;
  const placed = [];
  for (const f of bathyFC.features) {
    const pts = f.geometry.coordinates.map((c) => map.project(c));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1];
    if (total < BATHY_LABEL_MIN_LINE_PX) continue;
    const at = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; return k; };
    for (let pos = Math.min(BATHY_LABEL_SPACING_PX, total) / 2; pos < total; pos += BATHY_LABEL_SPACING_PX) {
      const i = at(pos), t = (pos - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      if (x < e || y < e || x > W - e || y > H - e) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < BATHY_LABEL_SEPARATION_PX)) continue;
      const pa = pts[at(Math.max(0, pos - 12)) - 1], pb = pts[at(Math.min(total, pos + 12))];
      let angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const el = document.createElement("div");
      el.className = "bathy-label";
      el.textContent = `${f.properties.depth} m`;
      bathyMarkers.push(new maplibregl.Marker({ element: el, anchor: "center", rotation: angle, rotationAlignment: "viewport" })
        .setLngLat(map.unproject([x, y])).addTo(map));
      placed.push({ x, y });
    }
  }
}

// ----------------------------------------------------------------- map --

function graticule() {
  const features = [];
  for (let lon = -140; lon <= -105; lon += 5) {
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[lon, 10], [lon, 50]] } });
  }
  for (let lat = 15; lat <= 45; lat += 5) {
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[-145, lat], [-100, lat]] } });
  }
  return { type: "FeatureCollection", features };
}

function createMap() {
  const empty = { type: "FeatureCollection", features: [] };
  map = new maplibregl.Map({
    container: "map",
    bounds: ARRIVED_PLAIN ? LANDING_BOUNDS : INITIAL_BOUNDS,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true, customAttribution: "Coastline: Natural Earth · Depth contours: GMT Earth relief" },
    style: {
      version: 8,
      sources: {
        land: { type: "geojson", data: `${DATA}land.geojson` },
        bathymetry: { type: "geojson", data: empty },          // loadBathymetry()
        graticule: { type: "geojson", data: graticule() },
        stations: { type: "geojson", data: empty },
        notow: { type: "geojson", data: empty },
        selected: { type: "geojson", data: empty },
      },
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": "#f3f6f9" } },
        { id: "graticule", type: "line", source: "graticule", paint: { "line-color": "#dfe5ea", "line-width": 0.6 } },
        { id: "land", type: "fill", source: "land", paint: { "fill-color": "#e8e6df" } },
        { id: "coast", type: "line", source: "land", paint: { "line-color": "#9a9890", "line-width": 0.6 } },
        // Depth contours (200-4000 m), the same for every survey (build_bathymetry.py): grey on a
        // faint white edge, so they show on dark palettes too; over the hydrography's field in its
        // views (hydro.js moves them), under the stations in all.
        { id: "bathy-halo", type: "line", source: "bathymetry",
          paint: { "line-color": "#ffffff", "line-opacity": 0.4, "line-width": ["match", ["get", "depth"], [200, 1000], 2.6, 2.2] } },
        { id: "bathy", type: "line", source: "bathymetry",
          paint: { "line-color": "#56616b", "line-opacity": 0.6, "line-width": ["match", ["get", "depth"], [200, 1000], 0.9, 0.6] } },
        {
          id: "zero", type: "circle", source: "stations", filter: ["==", ["get", "cls"], -1],
          paint: { "circle-color": ZERO.color, "circle-radius": ZERO.radius, "circle-stroke-color": DISC, "circle-stroke-width": 0.6 },
        },
        {
          id: "notow-halo", type: "circle", source: "notow",
          paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": NO_TOW_RADIUS, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.6, "circle-stroke-opacity": 0.85 },
        },
        {
          id: "notow", type: "circle", source: "notow",
          paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": NO_TOW_RADIUS, "circle-stroke-color": DISC, "circle-stroke-width": 1.2 },
        },
        {
          id: "catch-ring", type: "circle", source: "stations", filter: [">=", ["get", "cls"], 0],
          layout: { "circle-sort-key": ["-", 0, ["get", "a"]] },
          paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": CLASSES[0].radius + 1.3, "circle-stroke-color": "#ffffff", "circle-stroke-width": RING_PX },
        },
        {
          id: "catch", type: "circle", source: "stations", filter: [">=", ["get", "cls"], 0],
          layout: { "circle-sort-key": ["-", 0, ["get", "a"]] },     // the smaller on top
          paint: {
            "circle-color": ["match", ["get", "cls"], ...CLASSES.flatMap((c, i) => [i, c.color]), ZERO.color],
            "circle-radius": ["match", ["get", "cls"], ...CLASSES.flatMap((c, i) => [i, c.radius]), ZERO.radius],
            "circle-stroke-color": OUTLINE,
            "circle-stroke-width": 0.6,
          },
        },
        {
          id: "selected", type: "circle", source: "selected",
          paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1f1e1c", "circle-stroke-width": 1.5 },
        },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // North stays up: the line labels are drawn at fixed screen angles.
  map.dragRotate.disable();
  // Arrow keys step the time (setupControls), so the map must not pan with them.
  map.keyboard.disable();
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

  for (const layer of ["zero", "catch"]) {
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0].properties;
      const value = f.a > 0 ? `${fmt(f.a)} ${unitsLabel()}` : `no ${stageWord()} caught`;
      const multi = state.mode === "season" && f.n > 1;
      const detail = multi
        ? `mean of ${f.n} survey months, ${f.hits} with ${stageWord()}`
        : `${f.tows} tow${f.tows > 1 ? "s" : ""}`;
      popup.setLngLat(e.lngLat).setHTML(`<strong>${stationName(f.st)}</strong><br>${value}<br><span style="color:#85837c">${detail}</span>`).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    map.on("click", layer, (e) => {
      if (state.layer === "hydro") return;   // the overlay: station charts are the hydrography's
      if (isTrack()) return;                 // a track sample has no time series
      state.station = e.features[0].properties.st;
      dl.line = null;          // the line list follows the newly chosen station
      renderStationChart();
      updateDownloadPanel();
      writeHash();
    });
  }
  map.on("moveend", placeLogo);
  // Station-number labels are kept clear of each other at the zoom shown.
  map.on("zoomend", () => { if (lastLabelled) placeLineLabels(...lastLabelled); });
  map.on("resize", placeLogo);
  map.on("idle", placeLogo);
  return new Promise((resolve) => map.on("load", () => { addHydroLayers(); mapReady = true; loadBathymetry(); resolve(); }));
}

// --------------------------------------------------------------- welcome --
// A short note for a first visit to the plain address (the landing view); once
// closed it stays closed in this browser.
function setupWelcome() {
  let seen = false;
  try { seen = localStorage.getItem("atlas-welcome-closed") === "1"; } catch (e) { /* storage blocked */ }
  if (!ARRIVED_PLAIN || seen) return;
  $("welcome-years").textContent = String(new Date().getFullYear() - 1949);    // CalCOFI began in 1949
  $("welcome").hidden = false;
  $("welcome-close").addEventListener("click", () => {
    $("welcome").hidden = true;
    try { localStorage.setItem("atlas-welcome-closed", "1"); } catch (e) { /* storage blocked */ }
  });
}

// ---------------------------------------------------------------- init --

async function init() {
  $("status").textContent = "Loading…";
  const ds = new URLSearchParams(viewString()).get("ds");
  await Promise.all([loadDataset(DATASETS[ds] && ds !== "ichthyo" ? ds : "ichthyo"), loadHydroMeta()]);
  $("data-generated").textContent = `Data built ${meta.generated}.`;
  const fromHash = readHash();
  setupControls();
  setMode(state.mode);
  updateLayerControls();
  $("season-select").value = state.season;
  await createMap();
  trackSymbols();

  const start = fromHash.taxon || defaultTaxon();
  if (!fromHash.taxon) {
    // Open on the default net's most recent survey.
    const bongo = meta.nets.findIndex((n) => n.code === DEFAULT_NET);
    state.net = bongo >= 0 && start.netRows[bongo] > 0 ? bongo : start.topNet;
  }
  updateAvailable();
  if (fromHash.survey >= 0 && available.includes(fromHash.survey)) state.periodPos = available.indexOf(fromHash.survey);
  else state.periodPos = Math.max(0, available.length - 1);
  // A shared link's station wins; otherwise open the time series at the default station.
  if (fromHash.station >= 0) state.station = fromHash.station;
  else if (!linkView() && state.layer === "ichthyo") {
    const station = meta.stations.findIndex((s) => s.key === DEFAULT_STATION);
    if (station >= 0) state.station = station;
  }
  await selectTaxon(start, !fromHash.taxon);
  setupWelcome();
}

init().catch((err) => {
  $("status").textContent = `The atlas could not start: ${err.message}`;
  console.error(err);
});

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
const PLAY_INTERVAL_MS = 2000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// Reverse viridis on log10 abundance: pale yellow (low) to dark purple (high),
// perceptually uniform and colour-vision-deficiency safe. Colour and size both
// rise with abundance; a thin dark outline keeps the pale low classes visible
// against the light sea. Zero catches are small and neutral grey.
// Ten classes; boundaries come from the colour-scale template (see SCALE_TEMPLATES).
const CLASSES = ["#fde725", "#b5de2b", "#6ece58", "#35b779", "#1f9e89", "#26828e", "#31688e", "#3e4a89", "#482878", "#440154"]
  .map((color, i) => ({ color, radius: 3 + i * 0.5 }));
const ZERO = { color: "#a9a7a0", radius: 2.2 };
const OUTLINE = "rgba(31, 30, 28, 0.55)";
const DEFAULT_NET = "CB";      // CalCOFI bongo, the standard net since 1978
const DEFAULT_STATION = "090.0 060.0";   // Line 90, station 60: time series open on page load

const state = {
  taxon: null,          // entry from taxa.json
  stage: 1,             // index into meta.stages (larva)
  sampling: 0,          // index into meta.samplings (standard)
  net: 0,               // index into meta.nets
  mode: "month",        // "month" (one survey month) | "season" (one season of one year)
  periodPos: 0,         // position within the available survey months
  season: "winter",     // one season stepped by year, or "sequence": every season in turn
  seasonPos: 0,         // position within seasonSteps
  station: null,        // selected station index
  scaleMode: "fit",     // "fit" (this map's range) | "fixed" (same for all maps)
};

let meta, occ, taxa, map, popup;
let mapReady = false;          // set once on "load"; isStyleLoaded() is false while a source updates
let lineMarkers = [];          // CalCOFI line-number labels currently on the map
// Lines need this many stations in view to be labelled: the modern pattern's
// one- or two-station inshore "lines" (e.g. 81.8, 86.8, 93.4) would otherwise
// stack labels against the coast.
const MIN_LINE_STATIONS = 3;
let occByPeriod;               // period index -> occupation row indices
const taxonCache = new Map();  // taxon id -> Map(key -> abundance)
let available = [];            // period indices sampled with the chosen sampling + net
let playTimer = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- data --

const catchKey = (p, s, n, g, st) => ((((p * 2 + s) * 8 + n) * 2 + g) * 8192) + st;

async function getJSON(path) {
  const response = await fetch(DATA + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadTaxon(id) {
  if (taxonCache.has(id)) return taxonCache.get(id);
  const t = await getJSON(`taxa/${id}.json`);
  const values = new Map();
  for (let i = 0; i < t.a.length; i++) values.set(catchKey(t.p[i], t.s[i], t.n[i], t.g[i], t.st[i]), t.a[i]);
  values.raw = t;              // column arrays, for the high-count distribution
  taxonCache.set(id, values);
  return values;
}

function indexOccupations() {
  occByPeriod = new Map();
  for (let i = 0; i < occ.p.length; i++) {
    if (!occByPeriod.has(occ.p[i])) occByPeriod.set(occ.p[i], []);
    occByPeriod.get(occ.p[i]).push(i);
  }
}

function occupationRows(p) {
  return (occByPeriod.get(p) || []).filter((i) => occ.s[i] === state.sampling && occ.n[i] === state.net);
}

function updateAvailable() {
  const set = new Set();
  for (let i = 0; i < occ.p.length; i++) {
    if (occ.s[i] === state.sampling && occ.n[i] === state.net) set.add(occ.p[i]);
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

const templateFor = (max) => SCALE_TEMPLATES.find((t) => max <= t[t.length - 1]) || SCALE_TEMPLATES[SCALE_TEMPLATES.length - 1];

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
  const stage = meta.stages[state.stage];
  return plural ? (stage === "egg" ? "eggs" : "larvae") : stage;
};
const unitsLabel = () => `${stageWord()} ${meta.nets[state.net].units}`;
const fmt = (a) => (a >= 100 ? Math.round(a).toLocaleString() : a >= 1 ? a.toFixed(1) : a.toPrecision(2));
const speciesName = (t) => (t.common ? `${t.common} (${t.scientific})` : t.scientific);
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function stationName(st) {
  const s = meta.stations[st];
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
let seasonSteps = [];          // [{season, year}] with surveys, chronological, for the current net and sampling

function updateSeasonSteps() {
  const previous = seasonSteps[state.seasonPos];
  const keys = new Map();
  for (const p of available) {
    const period = meta.periods[p];
    if (!seasonMatches(period.season)) continue;
    const step = { season: period.season, year: seasonYear(period) };
    keys.set(`${step.year}-${SEASONS.indexOf(step.season)}`, step);
  }
  seasonSteps = [...keys.values()].sort((a, b) => seasonStart(a.season, a.year) - seasonStart(b.season, b.year));
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
const stepList = () => (state.mode === "month" ? available : seasonSteps);
const stepPos = () => (state.mode === "month" ? state.periodPos : state.seasonPos);
function setStepPos(pos) {
  if (state.mode === "month") state.periodPos = pos; else state.seasonPos = pos;
}
// Survey months on the map now: one ("By month") or the season's ("By season").
const shownPeriods = () => (state.mode === "month" ? (available.length ? [available[state.periodPos]] : []) : seasonPeriods());

// ----------------------------------------------------------- rendering --

function features() {
  const values = taxonCache.get(state.taxon.id);
  const rows = new Map();   // station -> {a, tows, n, hits}
  if (state.mode === "month") {
    const p = available[state.periodPos];
    for (const i of occupationRows(p)) {
      const a = values.get(catchKey(p, state.sampling, state.net, state.stage, occ.st[i])) || 0;
      rows.set(occ.st[i], { a, tows: occ.t[i] });
    }
  } else {
    for (const p of seasonPeriods()) {
      for (const i of occupationRows(p)) {
        const a = values.get(catchKey(p, state.sampling, state.net, state.stage, occ.st[i])) || 0;
        const r = rows.get(occ.st[i]) || { sum: 0, n: 0, hits: 0 };
        r.sum += a;
        r.n += 1;
        r.hits += a > 0 ? 1 : 0;
        rows.set(occ.st[i], r);
      }
    }
    for (const r of rows.values()) r.a = r.sum / r.n;
  }
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
  if (!state.taxon || !taxonCache.has(state.taxon.id) || !mapReady) return;
  const fc = features();
  map.getSource("stations").setData(fc);
  renderLineLabels(fc);
  const sampled = fc.features.length;
  const withCatch = fc.features.filter((f) => f.properties.a > 0).length;

  $("period-range").max = String(Math.max(0, stepList().length - 1));
  $("period-range").value = stepPos();
  if (state.mode === "month") {
    const p = available[state.periodPos];
    const ships = available.length ? meta.periods[p].ships.map(titleCase).join(", ") : "";
    $("period-label").textContent = available.length
      ? `${periodText(p)} · ${ships}\n${sampled} stations sampled, ${withCatch} with ${stageWord()}`
      : "No surveys with this net and sampling type.";
  } else {
    const months = seasonPeriods();
    $("period-label").textContent = months.length
      ? `${seasonText()}\nMean of ${months.map(periodText).join(", ")} · ${sampled} stations, ${withCatch} with ${stageWord()}`
      : `No ${state.season === "sequence" ? "" : `${state.season} `}surveys with this net and sampling type.`;
  }
  renderMapLabel();
  renderLegend();
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

// Web Mercator y for a latitude, in degree-equivalent units (x is longitude),
// so directions computed here match the map's screen angles at every zoom.
const mercatorY = (lat) => (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;

function computeLineAxes() {
  // Best-fit (principal-axis) direction of every station on each line, over the
  // whole record, so a survey that sampled part of a line still gets its angle.
  const byLine = new Map();
  for (const s of meta.stations) {
    if (!byLine.has(s.line)) byLine.set(s.line, []);
    byLine.get(s.line).push([s.lon, mercatorY(s.lat)]);
  }
  lineAxes = new Map();
  for (const [line, pts] of byLine) {
    if (pts.length < 2) continue;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);       // principal axis, map coordinates (y north)
    let ux = Math.cos(theta), uy = -Math.sin(theta);           // screen coordinates (y down)
    if (ux < 0) { ux = -ux; uy = -uy; }                        // point west -> east
    lineAxes.set(line, { ux, uy, angle: (Math.atan2(uy, ux) * 180) / Math.PI });
  }
}

function renderLineLabels(fc) {
  for (const m of lineMarkers) m.remove();
  lineMarkers = [];
  if (meta.samplings[state.sampling] !== "standard") return;
  if (!lineAxes) computeLineAxes();
  const end = new Map();    // line -> offshore-most station along the line's axis
  const count = new Map();  // line -> stations in view
  for (const f of fc.features) {
    const s = meta.stations[f.properties.st];
    count.set(s.line, (count.get(s.line) || 0) + 1);
    const axis = lineAxes.get(s.line);
    const along = axis ? s.lon * axis.ux - mercatorY(s.lat) * axis.uy : s.lon;   // larger = further east
    const best = end.get(s.line);
    if (!best || along < best.along) end.set(s.line, { s, along });
  }
  for (const [line, { s }] of end) {
    if (count.get(line) < MIN_LINE_STATIONS) continue;
    const axis = lineAxes.get(line) || { ux: 1, uy: 0, angle: 0 };
    const el = document.createElement("div");
    el.className = "line-label";
    el.textContent = Number.isInteger(line) ? String(line) : line.toFixed(1);
    el.title = `CalCOFI line ${line.toFixed(1)}`;
    // Anchored and rotated at its centre, with that centre placed on the
    // line's extension half a label-width beyond the gap, so the extended line
    // bisects the text. (MapLibre rotates a marker about the element's centre,
    // not its anchor, so an end-anchored label would sit off the line.)
    const marker = new maplibregl.Marker({
      element: el,
      anchor: "center",
      rotation: axis.angle,
      rotationAlignment: "viewport",
    }).setLngLat([s.lon, s.lat]).addTo(map);
    const back = LABEL_GAP_PX + el.offsetWidth / 2;
    marker.setOffset([-back * axis.ux, -back * axis.uy]);
    lineMarkers.push(marker);
  }
}

// The label on the land side of the map: when, which cruises, which species,
// stage and net -- so a screenshot or a playing animation explains itself.
function renderMapLabel() {
  const t = state.taxon;
  const net = meta.nets[state.net];
  const what = `<span class="species">${t.common ? `${t.common} <span class="sci">(${t.scientific})</span>` : `<span class="sci">${t.scientific}</span>`}</span>` +
    `${titleCase(stageWord())} · ${net.label} · ${titleCase(meta.samplings[state.sampling])} sampling`;
  if (state.mode === "month") {
    if (!available.length) { $("map-label").innerHTML = ""; return; }
    const period = meta.periods[available[state.periodPos]];
    const cruises = period.cruises.map((c) => `${c.key}${c.ship ? ` (${titleCase(c.ship)})` : ""}`).join(", ");
    $("map-label").innerHTML = `<span class="when">${periodText(available[state.periodPos])}</span>` +
      `Cruise${period.cruises.length > 1 ? "s" : ""} ${cruises}<br>${what}` +
      `<span class="bar-title">${titleCase(stageWord())} ${net.units}</span>${colourBar(300)}`;
  } else {
    const months = seasonPeriods();
    if (!months.length) { $("map-label").innerHTML = ""; return; }
    const cruises = [...new Set(months.flatMap((p) => meta.periods[p].cruises.map((c) => c.key)))].join(", ");
    $("map-label").innerHTML = `<span class="when">${seasonText()}</span>` +
      `Mean of ${months.map(periodText).join(", ")} · cruise${cruises.includes(",") ? "s" : ""} ${cruises}<br>${what}` +
      `<span class="bar-title">Mean ${unitsLabel()}</span>${colourBar(300)}`;
  }
}

function renderLegend() {
  $("legend-title").textContent = state.mode === "season"
    ? `Mean ${unitsLabel()}`
    : `${titleCase(stageWord())} ${meta.nets[state.net].units}`;
  $("legend-items").innerHTML = colourBar(280);
  setToggle("scale-toggle", state.scaleMode);
  const top = scaleBreaks[scaleBreaks.length - 1].toLocaleString();
  const over = scaleOverflow ? ` Values above ${top} share the darkest colour.` : "";
  $("scale-note").textContent = state.scaleMode === "fixed"
    ? `Scale 0–${top}, covering 99% of the record for this species, net, stage and sampling: colours compare across surveys.${over}`
    : `Scale 0–${top}, covering 95% of this map's catches: compare colours within this map only.${over}`;
}

// Horizontal colour bar: grey "0" swatch, then the ten classes with the
// template's integer bounds as ticks (1k = 1,000). Used in the side panel and
// the map label.
function colourBar(width) {
  const b = scaleBreaks, H = 32, zeroW = 22, gap = 8, x0 = zeroW + gap;
  const bw = (width - x0 - 18) / CLASSES.length, top = 2, bh = 12;   // right margin fits "300+"
  const label = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));
  const last = b.length - 1;
  const parts = [
    `<rect x="2" y="${top}" width="${zeroW - 4}" height="${bh}" rx="2" fill="${ZERO.color}"/>`,
    `<text x="${zeroW / 2 + 1}" y="${top + bh + 12}" text-anchor="middle" font-size="10" fill="#5b5a55">0</text>`,
  ];
  CLASSES.forEach((c, i) => parts.push(
    `<rect x="${x0 + i * bw}" y="${top}" width="${bw + 0.5}" height="${bh}" fill="${c.color}"/>`));
  parts.push(`<rect x="${x0}" y="${top}" width="${bw * CLASSES.length}" height="${bh}" fill="none" stroke="${OUTLINE}" stroke-width="0.6"/>`);
  // Ticks at every bound after 0 (the grey swatch already says 0).
  for (let k = 1; k < b.length; k++) {
    const x = x0 + k * bw;
    parts.push(`<line x1="${x}" x2="${x}" y1="${top + bh}" y2="${top + bh + 3}" stroke="#85837c"/>`);
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

function renderStationChart() {
  const st = state.station;
  const series = stationSeries(st);
  $("station-panel").hidden = false;
  document.querySelector(".map-area").classList.add("station-open");
  $("station-title").textContent =
    `${stationName(st)} — ${speciesName(state.taxon)}, ${stageWord()} ${meta.nets[state.net].units}, ` +
    `${meta.nets[state.net].code} net, ${meta.samplings[state.sampling]} sampling (` +
    (state.mode === "month" ? `${series.length} survey months)`
      : `${state.season === "sequence" ? "all seasons" : SEASON_LABEL[state.season].toLowerCase()}, ${series.length} seasons)`);

  const box = $("station-chart");
  const W = box.clientWidth || 600;
  const H = box.clientHeight || 180;
  const m = { l: 52, r: 12, t: 10, b: 24 };
  const y = (a) => Math.log10(1 + a);
  const yMax = Math.max(1, Math.ceil(Math.max(0, ...series.map((d) => y(d.a)))));
  const x0 = 1950, x1 = 2024;
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
  for (let yr = 1950; yr <= 2020; yr += 10) {
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
  for (const d of series) {
    const cls = classOf(d.a);
    const color = cls < 0 ? ZERO.color : CLASSES[cls].color;
    const r = cls < 0 ? 2 : 3.5;
    parts.push(`<circle cx="${sx(d.x)}" cy="${sy(y(d.a))}" r="${r}" fill="${color}" stroke="${cls < 0 ? "#fff" : OUTLINE}" stroke-width="0.6"/>`);
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Abundance through time at this station">${parts.join("")}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  const svg = box.querySelector("svg");
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = null;
    for (const d of series) {
      if (!best || Math.abs(sx(d.x) - px) < Math.abs(sx(best.x) - px)) best = d;
    }
    if (!best || Math.abs(sx(best.x) - px) > 12) { tip.hidden = true; return; }
    tip.hidden = false;
    const value = best.a > 0 ? `${best.step ? "mean " : ""}${fmt(best.a)} ${unitsLabel()}` : `no ${stageWord()} caught`;
    const tows = `${best.tows} tow${best.tows > 1 ? "s" : ""}`;
    tip.textContent = best.step
      ? `${seasonText(best.step)}: ${value} (${best.n} survey month${best.n > 1 ? "s" : ""}, ${tows})`
      : `${periodText(best.p)}: ${value} (${tows})`;
    const left = (sx(best.x) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(sy(y(best.a)) / H) * rect.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  // Clicking a point shows that survey month (or season) on the map.
  svg.style.cursor = "pointer";
  svg.addEventListener("click", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = null;
    for (const d of series) {
      if (!best || Math.abs(sx(d.x) - px) < Math.abs(sx(best.x) - px)) best = d;
    }
    if (!best || Math.abs(sx(best.x) - px) > 12) return;
    stopPlay();
    if (best.step) {
      state.seasonPos = seasonSteps.findIndex((s) => s.season === best.step.season && s.year === best.step.year);
      render();
      return;
    }
    state.periodPos = available.indexOf(best.p);
    if (state.mode !== "month") setMode("month"); else render();
  });

  map.getSource("selected").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [meta.stations[st].lon, meta.stations[st].lat] }, properties: {} }],
  });
}

function closeStation() {
  state.station = null;
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
  return taxa.filter((t) => {
    const text = `${t.common || ""} ${t.scientific} ${t.family || ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }).slice(0, 40);
}

function setupSpeciesPicker() {
  const input = $("species-input");
  const list = $("species-list");
  let matches = [];
  let active = -1;

  const show = () => {
    matches = speciesMatches(input.value);
    active = matches.length ? 0 : -1;
    list.innerHTML = matches.map((t, i) =>
      `<li role="option" data-id="${t.id}" aria-selected="${i === active}">` +
      `${t.common ? `${t.common} · ` : ""}<span class="sci">${t.scientific}</span>` +
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
    if (event.key === "ArrowDown") { active = Math.min(active + 1, matches.length - 1); highlight(); event.preventDefault(); }
    if (event.key === "ArrowUp") { active = Math.max(active - 1, 0); highlight(); event.preventDefault(); }
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
  const label = (t) => (t.common ? `${t.common} — ${t.scientific}` : t.scientific);
  const sorted = [...taxa].sort((a, b) => label(a).localeCompare(label(b)));
  $("species-select").innerHTML = sorted
    .map((t) => `<option value="${t.id}">${label(t)} (${t.rows.toLocaleString()})</option>`).join("");
  $("species-select").addEventListener("change", (e) => selectTaxon(taxa[Number(e.target.value)], true));
}

async function selectTaxon(t, resetNet) {
  stopPlay();
  state.taxon = t;
  if (resetNet) {
    // The bongo net by default; its most-used net for a species never caught in a bongo.
    const bongo = meta.nets.findIndex((n) => n.code === DEFAULT_NET);
    state.net = bongo >= 0 && t.netRows[bongo] > 0 ? bongo : t.topNet;
    if ((meta.stages[state.stage] === "egg" ? t.eggs : t.larvae) === 0) state.stage = t.eggs > 0 ? 0 : 1;
  }
  $("species-input").value = speciesName(t);
  $("species-select").value = String(t.id);
  $("species-detail").textContent =
    `${t.family ? `${t.family} · ` : ""}${t.larvae.toLocaleString()} larva and ${t.eggs.toLocaleString()} egg records`;
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
  render();
}

function setMode(mode) {
  stopPlay();
  state.mode = mode;
  document.querySelectorAll("#view-toggle button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("season-controls").hidden = mode !== "season";
  updateStepTitle();
  render();
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
  fillSelect($("stage-select"), meta.stages.map(titleCase), state.stage);
  fillSelect($("sampling-select"), meta.samplings.map(titleCase), state.sampling);
  fillSelect($("net-select"), meta.nets.map((n) => n.label), state.net);

  $("stage-select").addEventListener("change", (e) => { state.stage = Number(e.target.value); render(); });
  $("sampling-select").addEventListener("change", (e) => { state.sampling = Number(e.target.value); onFilterChange(); });
  $("net-select").addEventListener("change", (e) => { state.net = Number(e.target.value); onFilterChange(); });
  document.querySelectorAll("#view-toggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
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
    state.season = e.target.value;
    updateSeasonSteps();
    updateStepTitle();
    render();
  });
  $("station-close").addEventListener("click", closeStation);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select")) return;
    if (e.key === "ArrowLeft") { stopPlay(); step(-1); }
    if (e.key === "ArrowRight") { stopPlay(); step(1); }
  });
  setupSpeciesPicker();
  setupSpeciesSelect();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.station !== null) renderStationChart(); renderHighCounts(); }, 150);
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
const HIGH_DOT_COLOR = "#8f8e88";        // ring colour for top-5% samples not highlighted
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
    const all = [...acc.values()].map((r) => ({ a: r.sum / r.n, st: r.st, step: r.step, key: r.key }));
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
  for (let i = 0; i < occ.p.length; i++) if (occ.s[i] === state.sampling && occ.n[i] === state.net) samples++;
  return { counts, samples };
}

// What the map shows now, as distribution keys.
const shownKeys = () => new Set(state.mode === "month"
  ? shownPeriods()
  : (seasonSteps.length ? [stepKey(seasonSteps[state.seasonPos])] : []));
// Words for the distribution's units.
const highUnit = (n = 2) => (state.mode === "month" ? (n === 1 ? "sample" : "samples") : (n === 1 ? "station-season" : "station-seasons"));

function renderHighCounts() {
  $("left-panels").hidden = !highOpen;
  $("high-toggle").setAttribute("aria-pressed", String(highOpen));
  if (!highOpen) return;
  const { counts, samples } = highCountData();
  const net = meta.nets[state.net];
  $("high-title").textContent =
    `${speciesName(state.taxon)}, ${stageWord()}, ${net.code} net, ${meta.samplings[state.sampling]} sampling` +
    (state.mode === "season" ? `, ${state.season === "sequence" ? "all seasons" : state.season} (seasonal means)` : "");
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

  const dots = high.map((c) => ({ ...c }));
  // Zoomed strip: log axis from the 95th percentile to the maximum.
  const zt = H + 16, zb = Htot - 22;              // strip top / bottom
  const z0 = lx(p95), z1 = Math.max(lx(sorted[sorted.length - 1]), z0 + 0.01);
  const zx = (v) => m.l + ((v - z0) / (z1 - z0)) * (W - m.l - m.r);
  parts.push(`<rect x="${m.l}" y="${zt}" width="${W - m.l - m.r}" height="${zb - zt}" fill="#f6efe0"/>`);
  parts.push(`<line x1="${xp}" x2="${m.l}" y1="${H - m.b}" y2="${zt}" stroke="#c9c7bf"/>`);
  parts.push(`<line x1="${sx(x1)}" x2="${W - m.r}" y1="${H - m.b}" y2="${zt}" stroke="#c9c7bf"/>`);
  parts.push(`<text x="${m.l}" y="${zt - 4}" font-size="11" fill="#5b5a55">Top 5% ${highUnit()}: click a dot</text>`);
  for (const v of [p95, 10 ** ((z0 + z1) / 2), sorted[sorted.length - 1]]) {
    parts.push(`<text x="${zx(lx(v))}" y="${Htot - 6}" text-anchor="middle" font-size="11" fill="#85837c">${fmt(v)}</text>`);
  }
  dots.forEach((d, i) => {
    const jitter = ((Math.sin(i * 39.3467 + d.st * 11.135) * 24634.6345) % 1 + 1) % 1;
    d.zx = zx(lx(d.a));
    d.zy = zt + 5 + jitter * (zb - zt - 10);
  });

  // Every sample as an empty grey ring; those from the survey shown on the map
  // filled in the calendar's outline blue; the clicked sample filled red. Same
  // size, drawn in that order so highlighted dots are never hidden, and the
  // hollow rings let the filled ones stand out.
  const shown = shownKeys();
  const shownText = !shown.size ? "" : state.mode === "month" ? periodText([...shown][0]) : seasonText();
  const isSel = (d) => highSelected && highSelected.key === d.key && highSelected.st === d.st;
  const inSurvey = (d) => shown.has(d.key) && !isSel(d);
  const nInSurvey = dots.filter((d) => shown.has(d.key)).length;
  for (const d of [...dots.filter((x) => !isSel(x) && !inSurvey(x)), ...dots.filter(inSurvey), ...dots.filter(isSel)]) {
    if (isSel(d) || inSurvey(d)) {
      const fill = isSel(d) ? HIGH_SELECTED_COLOR : CRUISE_SELECTED_COLOR;
      parts.push(`<circle cx="${d.zx}" cy="${d.zy}" r="3.5" fill="${fill}" stroke="#ffffff" stroke-width="0.8"/>`);
    } else {
      parts.push(`<circle cx="${d.zx}" cy="${d.zy}" r="3.1" fill="none" stroke="${HIGH_DOT_COLOR}" stroke-width="0.9"/>`);
    }
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${Htot}" role="img" aria-label="Distribution of non-zero counts with the top 5% as clickable points">${parts.join("")}</svg>`;

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
    tip.textContent = `${d.step ? "mean " : ""}${fmt(d.a)} ${unitsLabel()} · ${stationName(d.st)} · ${d.step ? seasonText(d.step) : periodText(d.p)}`;
    const r = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, (d.zx / W) * r.width - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(d.zy / Htot) * r.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  svg.addEventListener("click", (event) => {
    const d = nearest(event);
    if (d) goToSample(d);
  });

  const what = state.mode === "month" ? "non-zero counts" : "non-zero seasonal means (one per station and season)";
  $("high-note").textContent =
    `${counts.length.toLocaleString()} ${what}; 95th percentile = ${fmt(p95)} ${unitsLabel()}. ` +
    `${high.length.toLocaleString()} ${highUnit(high.length)} at or above it are shown as dots in the strip: click one to show its station and ${state.mode === "month" ? "survey" : "season"}. ` +
    `Zeros (${(samples - counts.length).toLocaleString()} ${highUnit(samples - counts.length)} with none caught) are not part of the distribution.` +
    (!shown.size ? "" : nInSurvey
      ? ` ${shownText} (outlined in the calendar): ${nInSurvey} top-5% ${highUnit(nInSurvey)}, shown in blue.`
      : ` ${shownText} (outlined in the calendar) has no top-5% ${highUnit()}.`);
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
      if (occ.s[i] === state.sampling && occ.n[i] === state.net) sampled.set(occ.p[i], (sampled.get(occ.p[i]) || 0) + 1);
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
    c.go();
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
  highSelected = { key: d.key, st: d.st };
  if (d.step) state.seasonPos = seasonSteps.findIndex((x) => stepKey(x) === d.key);
  else state.periodPos = available.indexOf(d.p);
  state.station = d.st;
  dl.line = null;
  render();
  renderStationChart();
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
    if (occ.s[i] === state.sampling && occ.n[i] === state.net) lines.add(meta.stations[occ.st[i]].line);
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
const unitsColumn = () => `count_${meta.nets[state.net].units.replace("m²", "m2").replace("m³", "m3")}`.replace(/\s+/g, "_");

async function runDownload() {
  const stations = dl.extent === "station"
    ? new Set([state.station])
    : new Set(meta.stations.map((s, i) => (s.line === dl.line ? i : -1)).filter((i) => i >= 0));
  const rows = [];
  for (let i = 0; i < occ.p.length; i++) {
    if (occ.s[i] === state.sampling && occ.n[i] === state.net && stations.has(occ.st[i])) rows.push(i);
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
  if (state.mode === "month" && available.length) params.set("survey", meta.periods[available[state.periodPos]].key);
  if (state.mode === "season" && seasonSteps.length) {
    const { season, year } = seasonSteps[state.seasonPos];
    params.set("season", state.season);
    if (state.season === "sequence") params.set("shown", season);
    params.set("year", year);
  }
  if (state.station !== null) params.set("station", meta.stations[state.station].key);
  if (state.scaleMode === "fixed") params.set("scale", "fixed");
  history.replaceState(null, "", `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const taxon = taxa.find((t) => t.key === params.get("taxon"));
  const idx = (list, value) => Math.max(0, list.indexOf(value));
  if (params.has("stage")) state.stage = idx(meta.stages, params.get("stage"));
  if (params.has("sampling")) state.sampling = idx(meta.samplings, params.get("sampling"));
  if (params.has("net")) state.net = idx(meta.nets.map((n) => n.code), params.get("net"));
  if (params.get("view") === "season") state.mode = "season";
  if (params.get("scale") === "fixed") state.scaleMode = "fixed";
  if (SEASON_LABEL[params.get("season")] || params.get("season") === "sequence") state.season = params.get("season");
  const year = Number(params.get("year"));
  if (params.has("year") && Number.isFinite(year)) {
    // updateSeasonSteps() then keeps the nearest season with surveys.
    const shown = state.season === "sequence" ? params.get("shown") : state.season;
    seasonSteps = [{ season: SEASON_LABEL[shown] ? shown : "winter", year }];
  }
  const survey = meta.periods.findIndex((p) => p.key === params.get("survey"));
  const station = meta.stations.findIndex((s) => s.key === params.get("station"));
  return { taxon, survey, station };
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
    bounds: INITIAL_BOUNDS,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true, customAttribution: "Coastline: Natural Earth" },
    style: {
      version: 8,
      sources: {
        land: { type: "geojson", data: `${DATA}land.geojson` },
        graticule: { type: "geojson", data: graticule() },
        stations: { type: "geojson", data: empty },
        selected: { type: "geojson", data: empty },
      },
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": "#f3f6f9" } },
        { id: "graticule", type: "line", source: "graticule", paint: { "line-color": "#dfe5ea", "line-width": 0.6 } },
        { id: "land", type: "fill", source: "land", paint: { "fill-color": "#e8e6df" } },
        { id: "coast", type: "line", source: "land", paint: { "line-color": "#9a9890", "line-width": 0.6 } },
        {
          id: "zero", type: "circle", source: "stations", filter: ["==", ["get", "cls"], -1],
          paint: { "circle-color": ZERO.color, "circle-radius": ZERO.radius, "circle-opacity": 0.8 },
        },
        {
          id: "catch", type: "circle", source: "stations", filter: [">=", ["get", "cls"], 0],
          layout: { "circle-sort-key": ["get", "a"] },
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
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

  for (const layer of ["zero", "catch"]) {
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0].properties;
      const value = f.a > 0 ? `${fmt(f.a)} ${unitsLabel()}` : `no ${stageWord()} caught`;
      const detail = state.mode === "month"
        ? `${f.tows} tow${f.tows > 1 ? "s" : ""}`
        : `mean of ${f.n} survey${f.n > 1 ? "s" : ""}, ${f.hits} with ${stageWord()}`;
      popup.setLngLat(e.lngLat).setHTML(`<strong>${stationName(f.st)}</strong><br>${state.mode === "season" && f.a > 0 ? "mean " : ""}${value}<br><span style="color:#85837c">${detail}</span>`).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    map.on("click", layer, (e) => {
      state.station = e.features[0].properties.st;
      dl.line = null;          // the line list follows the newly chosen station
      renderStationChart();
      updateDownloadPanel();
      writeHash();
    });
  }
  return new Promise((resolve) => map.on("load", () => { mapReady = true; resolve(); }));
}

// ---------------------------------------------------------------- init --

async function init() {
  $("status").textContent = "Loading…";
  [meta, occ, taxa] = await Promise.all([getJSON("meta.json"), getJSON("occupations.json"), getJSON("taxa.json")]);
  $("data-generated").textContent = `Data built ${meta.generated}.`;
  indexOccupations();
  const fromHash = readHash();
  setupControls();
  setMode(state.mode);
  $("season-select").value = state.season;
  await createMap();

  const start = fromHash.taxon || taxa.find((t) => t.scientific === "Engraulis mordax") || taxa[0];
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
  else if (!location.hash) {
    const station = meta.stations.findIndex((s) => s.key === DEFAULT_STATION);
    if (station >= 0) state.station = station;
  }
  await selectTaxon(start, !fromHash.taxon);
}

init().catch((err) => {
  $("status").textContent = `The atlas could not start: ${err.message}`;
  console.error(err);
});

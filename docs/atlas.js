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
const CLASSES = [
  { min: 0, max: 1, color: "#fde725", radius: 3.5, label: "less than 1" },
  { min: 1, max: 10, color: "#5ec962", radius: 4.5, label: "1 – 10" },
  { min: 10, max: 100, color: "#21918c", radius: 5.5, label: "10 – 100" },
  { min: 100, max: 1000, color: "#3b528b", radius: 6.5, label: "100 – 1,000" },
  { min: 1000, max: Infinity, color: "#440154", radius: 7.5, label: "1,000 or more" },
];
const ZERO = { color: "#a9a7a0", radius: 2.2 };
const OUTLINE = "rgba(31, 30, 28, 0.55)";
const DEFAULT_NET = "CB";      // CalCOFI bongo, the standard net since 1978
const DEFAULT_STATION = "090.0 060.0";   // Line 90, station 60: time series open on page load

const state = {
  taxon: null,          // entry from taxa.json
  stage: 1,             // index into meta.stages (larva)
  sampling: 0,          // index into meta.samplings (standard)
  net: 0,               // index into meta.nets
  mode: "cruise",       // "cruise" | "composite"
  periodPos: 0,         // position within the available survey months
  season: "all",
  yearFrom: null,
  yearTo: null,
  station: null,        // selected station index
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

function classOf(a) {
  if (!(a > 0)) return -1;
  return CLASSES.findIndex((c) => a >= c.min && a < c.max);
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

// ----------------------------------------------------------- rendering --

function features() {
  const values = taxonCache.get(state.taxon.id);
  const rows = new Map();   // station -> {a, tows, n, hits}
  if (state.mode === "cruise") {
    const p = available[state.periodPos];
    for (const i of occupationRows(p)) {
      const a = values.get(catchKey(p, state.sampling, state.net, state.stage, occ.st[i])) || 0;
      rows.set(occ.st[i], { a, tows: occ.t[i] });
    }
  } else {
    for (const p of compositePeriods()) {
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

function compositePeriods() {
  return available.filter((p) => {
    const period = meta.periods[p];
    return (state.season === "all" || period.season === state.season)
      && period.year >= state.yearFrom && period.year <= state.yearTo;
  });
}

function render() {
  if (!state.taxon || !taxonCache.has(state.taxon.id) || !mapReady) return;
  const fc = features();
  map.getSource("stations").setData(fc);
  renderLineLabels(fc);
  const sampled = fc.features.length;
  const withCatch = fc.features.filter((f) => f.properties.a > 0).length;

  if (state.mode === "cruise") {
    const p = available[state.periodPos];
    const period = meta.periods[p];
    const ships = period.ships.map(titleCase).join(", ");
    $("period-label").textContent = available.length
      ? `${periodText(p)} · ${ships}\n${sampled} stations sampled, ${withCatch} with ${stageWord()}`
      : "No surveys with this net and sampling type.";
    $("period-range").value = state.periodPos;
  } else {
    const n = compositePeriods().length;
    $("composite-label").textContent = n
      ? `Mean of ${n} survey months · ${sampled} stations, ${withCatch} with ${stageWord()}`
      : "No surveys match this season and year range.";
  }
  renderMapLabel();
  renderLegend();
  if (state.station !== null) renderStationChart();
  writeHash();
}

// CalCOFI line numbers, standard sampling only. Each label lies on its line's
// own extension just beyond the offshore (western) end of the stations shown,
// rotated to the line's angle so it reads as part of that line; the end moves
// with each survey's (or composite's) actual coverage. HTML markers need no
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
  if (state.mode === "cruise") {
    if (!available.length) { $("map-label").innerHTML = ""; return; }
    const period = meta.periods[available[state.periodPos]];
    const cruises = period.cruises.map((c) => `${c.key}${c.ship ? ` (${titleCase(c.ship)})` : ""}`).join(", ");
    $("map-label").innerHTML = `<span class="when">${periodText(available[state.periodPos])}</span>` +
      `Cruise${period.cruises.length > 1 ? "s" : ""} ${cruises}<br>${what}`;
  } else {
    const season = $("season-select").selectedOptions[0].textContent;
    $("map-label").innerHTML = `<span class="when">${season}, ${state.yearFrom}–${state.yearTo}</span>` +
      `Mean of ${compositePeriods().length} survey months<br>${what}`;
  }
}

function renderLegend() {
  $("legend-title").textContent = state.mode === "composite"
    ? `Mean ${unitsLabel()}`
    : `${titleCase(stageWord())} ${meta.nets[state.net].units}`;
  const items = [`<li><span class="swatch" style="width:${ZERO.radius * 2 + 2}px;height:${ZERO.radius * 2 + 2}px;background:${ZERO.color}"></span>Sampled, none caught</li>`]
    .concat(CLASSES.map((c) => {
      const d = c.radius * 2 + 2;
      return `<li><span class="swatch" style="width:${d}px;height:${d}px;background:${c.color};border-color:${OUTLINE}"></span>${c.label}</li>`;
    }));
  $("legend-items").innerHTML = items.join("");
}

// ------------------------------------------------------- station chart --

function stationSeries(st) {
  const values = taxonCache.get(state.taxon.id);
  const series = [];
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
  $("station-title").textContent =
    `${stationName(st)} — ${speciesName(state.taxon)}, ${stageWord()} ${meta.nets[state.net].units}, ` +
    `${meta.nets[state.net].code} net, ${meta.samplings[state.sampling]} sampling (${series.length} surveys)`;

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
  if (state.mode === "cruise" && available.length) {
    const period = meta.periods[available[state.periodPos]];
    const xx = sx(period.year + (period.month - 0.5) / 12);
    parts.push(`<line x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H - m.b}" stroke="#2a78d6" stroke-dasharray="3 3"/>`);
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
    tip.textContent = `${periodText(best.p)}: ${best.a > 0 ? fmt(best.a) : "none"} ${unitsLabel()} (${best.tows} tow${best.tows > 1 ? "s" : ""})`;
    const left = (sx(best.x) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${(sy(y(best.a)) / H) * rect.height - 30}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  // Clicking a point shows that survey on the map.
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
    state.periodPos = available.indexOf(best.p);
    if (state.mode !== "cruise") setMode("cruise"); else render();
  });

  map.getSource("selected").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [meta.stations[st].lon, meta.stations[st].lat] }, properties: {} }],
  });
}

function closeStation() {
  state.station = null;
  $("station-panel").hidden = true;
  map.getSource("selected").setData({ type: "FeatureCollection", features: [] });
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
  $("period-range").max = String(Math.max(0, available.length - 1));
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
  if (state.yearFrom === null) {
    // The whole record, so the range suits every net (C1 ends 1978, CB starts 1978).
    state.yearFrom = meta.periods[0].year;
    state.yearTo = meta.periods[meta.periods.length - 1].year;
  }
  $("year-from").value = state.yearFrom;
  $("year-to").value = state.yearTo;
  render();
}

function setMode(mode) {
  stopPlay();
  state.mode = mode;
  document.querySelectorAll(".segmented button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("cruise-controls").hidden = mode !== "cruise";
  $("composite-controls").hidden = mode !== "composite";
  render();
}

function step(delta) {
  if (!available.length) return;
  state.periodPos = (state.periodPos + delta + available.length) % available.length;
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
  if (state.periodPos >= available.length - 1) state.periodPos = 0;
  playTimer = setInterval(() => {
    if (state.periodPos >= available.length - 1) { stopPlay(); return; }
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
  document.querySelectorAll(".segmented button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("prev-btn").addEventListener("click", () => { stopPlay(); step(-1); });
  $("next-btn").addEventListener("click", () => { stopPlay(); step(1); });
  $("play-btn").addEventListener("click", togglePlay);
  $("period-range").addEventListener("input", (e) => { stopPlay(); state.periodPos = Number(e.target.value); render(); });
  $("season-select").addEventListener("change", (e) => { state.season = e.target.value; render(); });
  const years = () => {
    const a = Number($("year-from").value), b = Number($("year-to").value);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      state.yearFrom = Math.min(a, b);
      state.yearTo = Math.max(a, b);
      render();
    }
  };
  $("year-from").addEventListener("change", years);
  $("year-to").addEventListener("change", years);
  $("station-close").addEventListener("click", closeStation);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select")) return;
    if (e.key === "ArrowLeft" && state.mode === "cruise") { stopPlay(); step(-1); }
    if (e.key === "ArrowRight" && state.mode === "cruise") { stopPlay(); step(1); }
  });
  setupSpeciesPicker();
  setupSpeciesSelect();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.station !== null) renderStationChart(); }, 150);
  });
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
  if (state.mode === "cruise" && available.length) params.set("survey", meta.periods[available[state.periodPos]].key);
  if (state.mode === "composite") {
    params.set("season", state.season);
    params.set("years", `${state.yearFrom}-${state.yearTo}`);
  }
  if (state.station !== null) params.set("station", meta.stations[state.station].key);
  history.replaceState(null, "", `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const taxon = taxa.find((t) => t.key === params.get("taxon"));
  const idx = (list, value) => Math.max(0, list.indexOf(value));
  if (params.has("stage")) state.stage = idx(meta.stages, params.get("stage"));
  if (params.has("sampling")) state.sampling = idx(meta.samplings, params.get("sampling"));
  if (params.has("net")) state.net = idx(meta.nets.map((n) => n.code), params.get("net"));
  if (params.get("view") === "composite") state.mode = "composite";
  if (params.has("season")) state.season = params.get("season");
  const years = (params.get("years") || "").split("-").map(Number);
  if (years.length === 2 && years.every(Number.isFinite)) [state.yearFrom, state.yearTo] = years;
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
      const detail = state.mode === "cruise"
        ? `${f.tows} tow${f.tows > 1 ? "s" : ""}`
        : `mean of ${f.n} survey${f.n > 1 ? "s" : ""}, ${f.hits} with ${stageWord()}`;
      popup.setLngLat(e.lngLat).setHTML(`<strong>${stationName(f.st)}</strong><br>${state.mode === "composite" && f.a > 0 ? "mean " : ""}${value}<br><span style="color:#85837c">${detail}</span>`).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    map.on("click", layer, (e) => {
      state.station = e.features[0].properties.st;
      renderStationChart();
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

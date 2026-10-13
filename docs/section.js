// Hydrographic sections along CalCOFI lines 90 and 80: depth (0-500 m)
// against position along the line, for the month or season shown and the
// source chosen. In the Hydrography view the section shows the map's variable
// (or stability N2, or geostrophic velocity); in the Water masses view, the
// map's water-mass fraction; in the Anomalies view, the map's variable as a
// departure from each station's climatology at each standard depth.
//
// The section's horizontal axis has the map's scale along the line (the line
// runs roughly straight in the map's projection, so position along it maps
// linearly to screen x): the distance between any two stations is the same
// width on both, whatever the map's position, so the section widens and
// narrows as the map zooms. Offshore is to the left, the coast at the right
// edge of the plot.
//
// Data (docs/data/hydro/<source>/line<L>.json, build_hydro_data.py): station x
// survey month x standard-depth means: p, st, z (depth index), n, t, s, d
// (sigma-theta), o (oxygen), no3, sio3, n2 (at an interval's upper depth), dh
// (CalCOFI's dynamic height, accumulated from the surface), psa, pew, npcw.
//
// A season's value at a station is the mean of its survey months. Values are
// joined linearly between neighbouring stations and standard depths, never
// beyond the outermost stations or below a station's deepest value.
//
// Anomalies: each station and standard depth minus its climatology for the
// calendar month or season, as on the map (the mean over all years, each
// year's value the mean of its survey months; at least ANOMALY_MIN_YEARS
// years, else left blank), over the whole record of the source shown.
//
// Geostrophic velocity across the line, relative to 500 dbar, between
// neighbouring stations that both reach 500 m:
//   v(z) = (10 / f) * (dD_on(z) - dD_off(z)) / L,   dD(z) = D(500) - D(z)
// D in dynamic metres (x10 = m2 s-2), f = 2 Omega sin(latitude), L the station
// spacing; positive = poleward (to the left looking onshore).
"use strict";

const SECTION_COLUMNS = { temperature: "t", salinity: "s", sigma_theta: "d", oxygen: "o", nitrate: "no3", silicate: "sio3",
  wm_psa: "psa", wm_pew: "pew", wm_npcw: "npcw", chlorophyll: "chl", phaeopigment: "phae",
  nitrite: "no2", ammonium: "nh4", oxygen_saturation: "o2s", dic: "dic", alkalinity: "alk", ph: "ph" };
const SECTION_EXTRA = {
  n2: { label: "Stability (N²)", units: "10⁻⁴ s⁻²", col: "n2", style: "n2", interval: true },
  geovel: { label: "Geostrophic velocity, relative to 500 dbar (poleward +)", units: "cm s⁻¹", style: "salinity", diverging: true, geostrophic: true },
};
const SECTION_MAX_GAP_KM = 150;
const SECTION_DEPTH = 500;
const sectionDepth = (v) => v.maxDepth || SECTION_DEPTH;      // the depth axis: 0-200 m for chlorophyll
const sstate = { display: "map", line: 90, variable: "map" };   // variable: "map" (the map's), "n2", "geovel"
const scache = new Map();
let sLoadToken = 0;
let sCur = null;                     // the computed section, redrawn on every map move
let sFrame = 0;

const sectionView = () => ["hydro", "watermass", "anomaly"].includes(hView());
const sectionShown = () => sstate.display === "section" && state.layer === "hydro" && sectionView();
const sKey = () => `${hSrcKey()}/line${sstate.line}`;

// The section's variable: the map's (when it has one), N2 or geostrophic velocity.
function sVar() {
  const choice = hView() === "hydro" ? sstate.variable : "map";
  if (choice !== "map") return SECTION_EXTRA[choice];
  if (hstate.anomaly && hstate.variable === "n2") return { ...SECTION_EXTRA.n2, label: hLabel(), anomaly: true, diverging: true };
  const col = SECTION_COLUMNS[hstate.variable];
  if (!col) return null;
  // Log-scale variables (chlorophyll): values log10, shown as ug/L or as a ratio to normal (no unit).
  const log = Boolean(hVar().log);
  return { label: hLabel(), units: log && hstate.anomaly ? "" : hVar().units, col, style: styleKey(), anomaly: hstate.anomaly,
    diverging: hstate.anomaly, log, maxDepth: hVar().maxDepth };
}

// Climatology along the line: "station|depth index|slot" -> mean, for one column.
const sClimCache = new Map();
function sectionClimatology(d, col) {
  const key = `${sKey()}/${col}/${state.mode}`;
  if (sClimCache.has(key)) return sClimCache.get(key);
  const periods = hSrc().periods, years = new Map();
  for (let i = 0; i < d.p.length; i++) {
    const v = d[col]?.[i];
    if (v === null || v === undefined) continue;
    const x = periods[d.p[i]], k = `${d.st[i]}|${d.z[i]}|${climSlot(x)}`, y = climYear(x);
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
    clim.set(k, sum / byYear.size);
  }
  sClimCache.set(key, clim);
  return clim;
}

// Profiles as departures from the climatology of their calendar month or season.
function sectionAnomalies(d, profiles, v, period) {
  const clim = sectionClimatology(d, v.col), slot = climSlot(hSrc().periods[period]);
  for (const p of profiles) {
    if (!p[v.col]) continue;
    p[v.col] = p[v.col].map((val, k) => {
      const c = clim.get(`${p.st}|${k}|${slot}`);
      return val === null || c === undefined ? null : val - c;
    });
  }
  return profiles;
}

async function loadSection() {
  const key = sKey();
  if (!scache.has(key)) {
    const d = await getJSON(`hydro/${key}.json`);
    d.byPeriod = new Map();
    for (let i = 0; i < d.p.length; i++) {
      if (!d.byPeriod.has(d.p[i])) d.byPeriod.set(d.p[i], []);
      d.byPeriod.get(d.p[i]).push(i);
    }
    scache.set(key, d);
  }
  return scache.get(key);
}

// Nominal position of a CalCOFI line and station: the grid is straight in
// Mercator, rotated 30 degrees, with line 80 station 60 at 34.15 N, 121.15 W;
// a line unit is 12 nm along bearing 150, a station unit 4 nm along bearing
// 240 (rhumb lines; Weber & Moore 2013, NOAA-TM-NMFS-SWFSC-509).
const NM_KM = 1.852;
function nominalPosition(line, station) {
  const rad = Math.PI / 180, psi = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)) / rad;
  const lat1 = 34.15 - 0.2 * Math.cos(30 * rad) * (line - 80);
  const lat = lat1 - (1 / 15) * Math.sin(30 * rad) * (station - 60);
  const lon = -121.15 - Math.tan(30 * rad) * (psi(lat1) - psi(34.15)) + Math.tan(60 * rad) * (psi(lat) - psi(lat1));
  return { lat, lon };
}

// The line's stations at their nominal positions (not the casts' own, which
// wander like a ship's track), with their distance (km) from the inshore-most
// one along the line (4 nm per station unit); the section spans the regularly
// occupied ones (at least 10% as many survey months as the most-occupied
// station).
function lineGeometry(d) {
  const all = hSrc().stations.map((s, i) => ({ ...s, ...nominalPosition(s.line, s.station), i })).filter((s) => s.line === sstate.line);
  if (!all.length) return null;
  const visits = new Map();
  for (let i = 0; i < d.p.length; i++) if (d.z[i] === 0) visits.set(d.st[i], (visits.get(d.st[i]) || 0) + 1);
  const top = Math.max(0, ...visits.values());
  const origin = all.reduce((a, b) => (b.station < a.station ? b : a));
  const x = new Map(all.map((s) => [s.i, (s.station - origin.station) * 4 * NM_KM]));
  const core = all.filter((s) => (visits.get(s.i) || 0) >= 0.1 * top);
  const xmax = Math.max(...(core.length ? core : all).map((s) => x.get(s.i))) * 1.03;
  return { stations: all.filter((s) => x.get(s.i) <= xmax), x, xmax };
}

function sectionProfiles(d, periods, geo) {
  const depths = hSrc().depths;
  const acc = new Map();
  for (const p of periods) {
    for (const i of d.byPeriod.get(p) || []) {
      if (!geo.x.has(d.st[i]) || geo.x.get(d.st[i]) > geo.xmax) continue;
      if (!acc.has(d.st[i])) acc.set(d.st[i], {});
      const a = acc.get(d.st[i]);
      for (const col of ["t", "s", "d", "o", "no3", "sio3", "n2", "dh", "psa", "pew", "npcw", "chl", "phae", "no2", "nh4", "o2s", "dic", "alk", "ph"]) {
        const v = d[col]?.[i];
        if (v === null || v === undefined) continue;
        a[col] = a[col] || depths.map(() => ({ sum: 0, n: 0 }));
        a[col][d.z[i]].sum += v;
        a[col][d.z[i]].n += 1;
      }
    }
  }
  const meta = new Map(geo.stations.map((s) => [s.i, s]));
  const out = [];
  for (const [st, a] of acc) {
    if (!meta.has(st)) continue;
    const prof = { st, x: geo.x.get(st), lat: meta.get(st).lat, station: meta.get(st).station };
    for (const col of Object.keys(a)) prof[col] = a[col].map((c) => (c.n ? c.sum / c.n : null));
    out.push(prof);
  }
  return out.sort((p, q) => p.x - q.x);
}

function sectionColumns(profiles, v) {
  const depths = hSrc().depths;
  if (v.geostrophic) {                // geostrophic velocity between neighbouring stations
    const k500 = depths.indexOf(SECTION_DEPTH), cols = [];
    for (let i = 1; i < profiles.length; i++) {
      const a = profiles[i - 1], b = profiles[i];        // a inshore, b offshore
      if (!a.dh || !b.dh || a.dh[k500] === null || b.dh[k500] === null || b.x - a.x > SECTION_MAX_GAP_KM || b.x - a.x <= 0) continue;
      const lat = (a.lat + b.lat) / 2, f = 2 * 7.2921e-5 * Math.sin((lat * Math.PI) / 180), L = (b.x - a.x) * 1000;
      const pts = [];
      depths.forEach((z, k) => {
        if (a.dh[k] === null || b.dh[k] === null) return;
        pts.push([z, ((10 / f) * ((a.dh[k500] - a.dh[k]) - (b.dh[k500] - b.dh[k])) / L) * 100]);
      });
      if (pts.length) cols.push({ x: (a.x + b.x) / 2, pts });
    }
    return cols;
  }
  return profiles.map((p) => {
    const pts = [];
    (p[v.col] || []).forEach((val, k) => {
      if (val === null) return;
      const z = v.interval ? (depths[k] + depths[k + 1]) / 2 : depths[k];    // N2: the middle of its interval
      if (Number.isFinite(z) && !(v.maxDepth && z > v.maxDepth)) pts.push([z, val]);     // chlorophyll: 0-200 m
    });
    return { x: p.x, pts };
  }).filter((c) => c.pts.length);
}

const sectionValues = (cols) => cols.flatMap((c) => c.pts.map((p) => p[1]));

function sectionRange(d, geo, v) {
  ensureCompareYears();
  if (!hstate.compare) return null;
  const [y0, y1] = hstate.compare, periods = hSrc().periods, season = hstate.scale === "season" ? hShownSeason() : null;
  const groups = new Map();
  for (const p of d.byPeriod.keys()) {
    const x = periods[p], yr = hStepYear(x), s = SEASON_OF_MONTH[x.month];
    if (yr < y0 || yr > y1 || (season && s !== season)) continue;
    const k = state.mode === "season" ? `${yr}|${s}` : String(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const ps of groups.values()) {
    let profiles = sectionProfiles(d, ps, geo);
    if (v.anomaly) profiles = sectionAnomalies(d, profiles, v, ps[0]);
    const vals = sectionValues(sectionColumns(profiles, v));
    if (vals.length) n++;
    for (const val of vals) { lo = Math.min(lo, val); hi = Math.max(hi, val); }
  }
  return Number.isFinite(lo) ? { lo, hi, maps: n } : null;
}

function sectionScale(values, fixed, v) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (fixed) ({ lo, hi } = fixed);
  if (v.diverging) { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.1); lo = -m; hi = m; }
  if (!(hi > lo)) hi = lo + 0.01;
  const { levels, step } = v.log ? logLevels(lo, hi, v.anomaly) : niceLevels(lo, hi);
  const style = HYDRO_STYLES[v.style], n = levels.length - 1, a = levels[0], b = levels[n];
  const stops = v.anomaly ? ANOMALY_STYLES[v.style] : v.diverging ? ANOMALY_STYLES.salinity : style.stops;
  const smooth = v.diverging ? true : style.smooth;
  const colors = Array.from({ length: n }, (_, i) => rgbText(paletteAt(stops, (i + 0.5) / n)));
  const colorAt = smooth
    ? (x) => paletteAt(stops, (x - a) / (b - a))
    : (x) => paletteAt(stops, (Math.min(n - 1, Math.max(0, Math.floor(((x - a) / (b - a)) * n))) + 0.5) / n);
  return { levels, step, colors, colorAt, smooth, fixed: Boolean(fixed), maps: fixed?.maps ?? 0,
    below: Math.min(...values) < a, above: Math.max(...values) > b, line: v.diverging ? "#1f1e1c" : style.line };
}

// Grid in (distance along the line, depth).
function sectionGrid(cols, xmax, depth = SECTION_DEPTH, nx = 300, nz = 126) {
  const zAt = (j) => (j / (nz - 1)) * depth, xAt = (i) => (i / (nx - 1)) * xmax;
  const colVals = cols.map((c) => {
    const v = new Float64Array(nz).fill(NaN), pts = c.pts;
    for (let j = 0; j < nz; j++) {
      const z = zAt(j);
      if (z < pts[0][0]) { if (pts[0][0] <= 12) v[j] = pts[0][1]; continue; }
      if (pts.length === 1) { if (Math.abs(z - pts[0][0]) < 2) v[j] = pts[0][1]; continue; }
      for (let k = 1; k < pts.length; k++) {
        if (z <= pts[k][0]) {
          const [z0, v0] = pts[k - 1], [z1, v1] = pts[k];
          v[j] = v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
          break;
        }
      }
    }
    return v;
  });
  const g = new Float64Array(nx * nz).fill(NaN);
  for (let i = 0; i < nx; i++) {
    const x = xAt(i);
    const k = cols.findIndex((c) => c.x >= x);
    if (k < 0) continue;
    if (k === 0) {
      if (Math.abs(cols[0].x - x) <= xmax / (nx - 1)) for (let j = 0; j < nz; j++) g[j * nx + i] = colVals[0][j];
      continue;
    }
    const a = cols[k - 1], b = cols[k];
    if (b.x - a.x > SECTION_MAX_GAP_KM) continue;
    const f = (x - a.x) / (b.x - a.x);
    for (let j = 0; j < nz; j++) {
      const va = colVals[k - 1][j], vb = colVals[k][j];
      if (Number.isFinite(va) && Number.isFinite(vb)) g[j * nx + i] = va + f * (vb - va);
    }
  }
  return { g, nx, nz, xAt, zAt };
}

// ------------------------------------------------------------- compute --
// Everything that depends on the data, time and variable (not the map's
// position): the grid as an image, the contour lines and labels in
// (distance, depth) coordinates.
async function renderSection() {
  const panel = $("section-panel"), area = document.querySelector(".map-area");
  updateSectionControls();
  if (!sectionShown()) {
    panel.hidden = true;
    area.classList.remove("section-open", "panels-split");
    sCur = null;
    if (map.getSource("section-line")) map.getSource("section-line").setData({ type: "FeatureCollection", features: [] });
    return;
  }
  panel.hidden = false;
  area.classList.add("section-open");
  area.classList.toggle("panels-split", !$("station-panel").hidden);
  const token = ++sLoadToken;
  if (!scache.has(sKey())) {
    showSectionMessage("Loading section…");
    await loadSection();
    if (token !== sLoadToken) return;
  }
  const d = scache.get(sKey()), geo = lineGeometry(d), v = sVar();
  const periods = hShownPeriods();
  const when = state.mode === "season" ? (hSteps.length ? seasonText(hSteps[hstate.seasonPos]) : "") : !periods.length ? "" : hPeriodText(periods[0]);
  $("section-title").textContent = `Line ${sstate.line} — ${v ? v.label : hLabel()} · ${when} · ${hSrc().label}`;
  if (geo) {
    const coords = geo.stations.slice().sort((a, b) => geo.x.get(a.i) - geo.x.get(b.i)).map((s) => [s.lon, s.lat]);
    map.getSource("section-line").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }] });
  }
  if (!v) { sCur = null; showSectionMessage(hView() === "watermass" ? "Sections show the water-mass fractions: choose PSA, PEW or NPCW." : `No section for ${hLabel().toLowerCase()}${hView() === "anomaly" ? ": sections show the variables at a depth (temperature, salinity, density, oxygen, nitrate, silicate, stability, water-mass fractions)" : ""}.`); return; }
  if (!geo) { sCur = null; showSectionMessage(`No ${hSourceWord()} stations on line ${sstate.line}.`); return; }
  let profiles = sectionProfiles(d, periods, geo);
  if (v.anomaly) profiles = sectionAnomalies(d, profiles, v, periods[0]);
  const cols = sectionColumns(profiles, v);
  if (cols.length < 2) {
    sCur = null;
    showSectionMessage(v.anomaly && profiles.length >= 2
      ? `Too few of line ${sstate.line}'s stations sampled in ${when || "this period"} have a climatology (${ANOMALY_MIN_YEARS}+ years of ${hSourceWord()} data) for an anomaly section.`
      : `Line ${sstate.line} was not sampled${cols.length ? " at enough stations" : ""} in ${when || "this period"} (${hSourceWord()}).`);
    return;
  }
  const values = sectionValues(cols);
  const fixed = hstate.scale !== "floating" ? sectionRange(d, geo, v) : null;
  const scale = sectionScale(values, fixed, v);
  const grid = sectionGrid(cols, geo.xmax, sectionDepth(v));
  // image, x = distance (left to right), y = depth
  const canvas = document.createElement("canvas");
  canvas.width = grid.nx; canvas.height = grid.nz;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(grid.nx, grid.nz);
  for (let k = 0; k < grid.g.length; k++) {
    if (!Number.isFinite(grid.g[k])) continue;
    const c = scale.colorAt(grid.g[k]), o = k * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // contour lines on a gap-filled copy (so the data's edges make no false lines), clipped to the data
  const filled = Float64Array.from(grid.g);
  const fillAlong = (n, m, idx) => {
    for (let a = 0; a < m; a++) {
      for (const dir of [1, -1]) {
        let last = NaN;
        for (let b = dir > 0 ? 0 : n - 1; dir > 0 ? b < n : b >= 0; b += dir) {
          const k = idx(a, b);
          if (Number.isFinite(filled[k])) last = filled[k]; else if (Number.isFinite(last)) filled[k] = last;
        }
      }
    }
  };
  fillAlong(grid.nx, grid.nz, (j, i) => j * grid.nx + i);
  fillAlong(grid.nz, grid.nx, (i, j) => j * grid.nx + i);
  const fmin = Math.min(...values) - Math.abs(Math.max(...values) - Math.min(...values)) - 1;
  for (let k = 0; k < filled.length; k++) if (!Number.isFinite(filled[k])) filled[k] = fmin;
  // grid coordinates -> (km, depth m)
  const toKm = (x) => ((x - 0.5) / (grid.nx - 1)) * geo.xmax, toZ = (y) => ((y - 0.5) / (grid.nz - 1)) * sectionDepth(v);
  const ringsKm = (rings) => rings.map((ring) => ring.map(([x, y]) => [toKm(x), toZ(y)]));
  const mask = d3.contours().size([grid.nx, grid.nz]).thresholds([0.5])(Array.from(grid.g, (q) => (Number.isFinite(q) ? 1 : 0)))[0];
  const eps = scale.step * 1e-6;       // flat at a level (e.g. 100% of a water mass): no rounding-error rings (as hydroGeometry)
  const lines = d3.contours().size([grid.nx, grid.nz]).thresholds(scale.levels)(Array.from(filled, (z) => Math.round(z / eps) * eps)).filter((c) => c.coordinates.length);
  const labels = [];
  for (const c of lines) {
    const ring = c.coordinates.flat().reduce((a, b) => (b.length > a.length ? b : a));
    const inside = ring.filter(([x, y]) => {
      const gi = Math.round(x - 0.5), gj = Math.round(y - 0.5);
      return gi > 3 && gi < grid.nx - 4 && gj > 5 && gj < grid.nz - 6 && Number.isFinite(grid.g[gj * grid.nx + gi]);
    });
    if (inside.length > 8) {
      const [x, y] = inside[Math.floor(inside.length / 2)];
      labels.push({ km: toKm(x), z: toZ(y), t: sFmt(c.value, v) });
    }
  }
  sCur = {
    v, geo, scale, grid, values, when,
    image: canvas.toDataURL(),
    mask: ringsKm(mask.coordinates.flat()),
    lines: lines.map((c) => ({ value: c.value, rings: ringsKm(c.coordinates.flat()) })),
    labels, sampled: new Set(profiles.map((p) => p.st)),
  };
  drawSection();
}

// The depth (m) or depth interval [top, bottom] the map shows, for the
// section's highlight: none for per-cast variables or isopycnal surfaces.
function mapDepth() {
  const v = hVar();
  if (v.perCast || isIso()) return null;
  const d = hEffDepth(), depths = hSrc().depths;
  return v.interval ? [d, depths[depths.indexOf(d) + 1]] : [d, d];
}

function showSectionMessage(text) {
  $("section-chart").innerHTML = `<p class="hint" style="padding:12px">${text}</p>`;
}

// ---------------------------------------------------------------- draw --
// Place the computed section under the map: screen x of a position along the
// line, fitted from the map positions of the line's stations.
function drawSection() {
  if (!sCur || !sectionShown()) return;
  const { v, geo, scale, grid, labels } = sCur;
  const D = sectionDepth(v);
  const box = $("section-chart");
  const W = box.clientWidth || 600, H = Math.max(140, (box.clientHeight || 260) - 30);   // less the note lines
  const m = { l: 60, r: 78, t: 30, b: 34 }, ph = H - m.t - m.b;
  // the map's horizontal scale along the line (screen x against distance along
  // it, fitted over the stations), not its position: the section is as wide as
  // the line is across the map, coast at the plot's right edge, offshore end
  // clipped if the map is zoomed in past the panel's width
  const pts = geo.stations.map((s) => [geo.x.get(s.i), map.project([s.lon, s.lat]).x]);
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const R = W - m.r, maxW = R - m.l;
  const b = -Math.abs(sxx > 0 ? sxy / sxx : maxW / geo.xmax), a0 = R;
  m.l = R - Math.min(maxW, -b * geo.xmax);
  const px = (km) => a0 + b * km, py = (z) => m.t + (z / D) * ph;
  const path = (rings) => rings.map((r) => "M" + r.map(([x, z]) => `${x.toFixed(2)},${py(z).toFixed(1)}`).join("L")).join("");
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';
  const parts = [];
  parts.push(`<defs><clipPath id="sec-window"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${ph}"/></clipPath>` +
    `<clipPath id="sec-data" clipPathUnits="userSpaceOnUse"><path d="${path(sCur.mask)}Z"/></clipPath></defs>`);
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${ph}" fill="#d9d7cf"/>`);
  // data, drawn in (km, screen y) and mapped to screen x by the fit
  parts.push(`<g clip-path="url(#sec-window)"><g transform="matrix(${b} 0 0 1 ${a0} 0)">`);
  parts.push(`<image href="${sCur.image}" x="0" y="${m.t}" width="${geo.xmax}" height="${ph}" preserveAspectRatio="none"/>`);
  for (const c of sCur.lines) {
    const zero = v.diverging && Math.abs(c.value) < 1e-9;
    parts.push(`<path d="${path(c.rings)}" fill="none" stroke="${scale.line}" stroke-opacity="0.85" stroke-width="${zero ? 1.8 : 0.8}" vector-effect="non-scaling-stroke" clip-path="url(#sec-data)"/>`);
  }
  parts.push("</g>");
  // contour labels, kept apart
  const placed = [];
  for (const l of labels) {
    const X = px(l.km), Y = py(l.z);
    if (X < m.l + 12 || X > W - m.r - 12 || placed.some((q) => Math.hypot(q[0] - X, q[1] - Y) < 30)) continue;
    placed.push([X, Y]);
    parts.push(`<text x="${X}" y="${Y + 3.5}" text-anchor="middle" font-size="10" font-weight="600" fill="${scale.line}" ${font} ` +
      `stroke="${scale.line === "#ffffff" ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.85)"}" stroke-width="2.4" paint-order="stroke">${l.t}</text>`);
  }
  parts.push("</g>");
  // axes: depth (left), with the map's depth (or depth interval) highlighted
  const tick = 'font-size="11" fill="#5b5a55"';
  const md = mapDepth(), mark = md && { y0: py(md[0]) - (md[0] === md[1] ? 8 : 0), y1: py(md[1]) + (md[0] === md[1] ? 8 : 0) };
  for (let z = 0; z <= D; z += D <= 200 ? 50 : 100) {
    parts.push(`<line x1="${m.l - 4}" x2="${m.l}" y1="${py(z)}" y2="${py(z)}" stroke="#85837c"/>`);
    if (mark && py(z) > mark.y0 - 6 && py(z) < mark.y1 + 6) continue;      // under the highlight
    parts.push(`<text x="${m.l - 6}" y="${py(z) + 4}" text-anchor="end" ${tick} ${font}>${z}</text>`);
  }
  if (mark) {
    const yc = (mark.y0 + mark.y1) / 2;
    for (const y of md[0] === md[1] ? [py(md[0])] : [py(md[0]), py(md[1])]) {      // a dashed line on a white halo
      parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="#ffffff" stroke-width="2.6" opacity="0.6"/>`);
      parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="#1f1e1c" stroke-width="1" stroke-dasharray="5 3"/>`);
    }
    // the depth in a blue box on the axis; an interval's two depths stacked
    const lines = md[0] === md[1] ? [String(md[0])] : [String(md[0]), String(md[1])];
    const bw = 6 * Math.max(...lines.map((t) => t.length)) + 8, bh = Math.max(16, 13 * lines.length + 3, mark.y1 - mark.y0);
    parts.push(`<rect x="${m.l - 4 - bw}" y="${yc - bh / 2}" width="${bw}" height="${bh}" rx="3" fill="#2a78d6"/>`);
    lines.forEach((t, k) => parts.push(`<text x="${m.l - 8}" y="${yc - bh / 2 + 12 + k * (bh - 16)}" text-anchor="end" font-size="10" font-weight="600" fill="#ffffff" ${font}>${t}</text>`));
  }
  parts.push(`<text transform="translate(${m.l - 48} ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" ${tick} ${font}>depth (m)</text>`);
  // distance (bottom)
  const step = Math.abs(b) * 100 < 40 ? 200 : 100;
  for (let km = 0; km <= geo.xmax; km += step) {
    const X = px(km);
    if (X < m.l || X > W - m.r) continue;
    parts.push(`<line x1="${X}" x2="${X}" y1="${m.t + ph}" y2="${m.t + ph + 4}" stroke="#85837c"/>`);
    parts.push(`<text x="${X}" y="${m.t + ph + 16}" text-anchor="middle" ${tick} ${font}>${km}</text>`);
  }
  parts.push(`<text x="${m.l + (W - m.l - m.r) / 2}" y="${H - 3}" text-anchor="middle" ${tick} ${font}>distance from the inshore end of line ${sstate.line} (km)</text>`);
  // stations (top)
  parts.push(`<text x="${m.l}" y="${m.t - 19}" text-anchor="start" ${tick} ${font}>station</text>`);
  let lastX = Infinity;
  for (const s of geo.stations.slice().sort((p, q) => px(geo.x.get(q.i)) - px(geo.x.get(p.i)))) {
    const X = px(geo.x.get(s.i));
    if (X < m.l || X > W - m.r) continue;
    const on = sCur.sampled.has(s.i);
    parts.push(`<path d="M${X} ${m.t - 1} l-3.5 -6 h7 Z" fill="${on ? "#1f1e1c" : "#c9c7bf"}"/>`);
    if (on && lastX - X > 24 && X > m.l + 52) { parts.push(`<text x="${X}" y="${m.t - 10}" text-anchor="middle" font-size="10" fill="#5b5a55" ${font}>${+s.station.toFixed(1)}</text>`); lastX = X; }
  }
  // vertical colour bar (right)
  parts.push(verticalColourBar(scale, W - m.r + 16, m.t, ph, v, font));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Section">${parts.join("")}</svg>` +
    `<p class="section-note">${sectionNote(scale, v)}</p>`;
  // value under the cursor
  const svg = box.querySelector("svg");
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top;
    const km = (X - a0) / b, z = ((Y - m.t) / ph) * D;
    const i = Math.round((km / geo.xmax) * (grid.nx - 1)), j = Math.round((z / D) * (grid.nz - 1));
    const val = X >= m.l && X <= W - m.r && i >= 0 && j >= 0 && i < grid.nx && j < grid.nz ? grid.g[j * grid.nx + i] : NaN;
    if (!Number.isFinite(val)) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${sFmt(val, v, v.diverging ? (v.anomaly ? 2 : 1) : 3)}${v.units ? ` ${v.units}` : ""} · ${Math.round(z)} m · ${Math.round(km)} km`;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, X - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Y - 34}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
}

function verticalColourBar(scale, x, y, h, v, font) {
  const { levels } = scale, w = 12, n = levels.length - 1, parts = [];
  const vy = (val) => y + h - ((val - levels[0]) / (levels[n] - levels[0])) * h;
  const steps = scale.smooth ? 60 : n;
  for (let i = 0; i < steps; i++) {
    const val = levels[0] + ((i + 0.5) / steps) * (levels[n] - levels[0]);
    const y0 = y + h - ((i + 1) / steps) * h;
    parts.push(`<rect x="${x}" y="${y0}" width="${w}" height="${h / steps + 0.4}" fill="${rgbText(scale.colorAt(val))}"/>`);
  }
  if (scale.fixed) {
    const lo = rgbText(scale.colorAt(levels[0])), hi = rgbText(scale.colorAt(levels[n]));
    parts.push(`<path d="M${x} ${y} L${x + w / 2} ${y - 7} L${x + w} ${y} Z" fill="${hi}" opacity="${scale.above ? 1 : 0.35}"/>`);
    parts.push(`<path d="M${x} ${y + h} L${x + w / 2} ${y + h + 7} L${x + w} ${y + h} Z" fill="${lo}" opacity="${scale.below ? 1 : 0.35}"/>`);
  }
  const every = Math.max(1, Math.ceil(levels.length / Math.max(4, Math.floor(h / 22))));
  levels.forEach((val, i) => {
    if (i % every && i !== n) return;
    if (i === n && n % every && (n % every) < every / 2) return;    // the top tick would crowd its neighbour
    parts.push(`<line x1="${x + w}" x2="${x + w + 3}" y1="${vy(val)}" y2="${vy(val)}" stroke="#85837c"/>`);
    parts.push(`<text x="${x + w + 5}" y="${vy(val) + 3.5}" font-size="10" fill="#5b5a55" ${font}>${sFmt(val, v)}</text>`);
  });
  if (v.units) parts.push(`<text x="${x}" y="${y - 12}" font-size="10" fill="#5b5a55" ${font}>${v.units}</text>`);
  return parts.join("");
}

// A section value as text: ug/L or x/÷ ratio (log scale), signed (anomalies, velocity) or plain.
const sFmt = (val, v, dp = 3) => (v.log ? fmtLog(val) : v.diverging ? signedValue(+val.toFixed(dp)) : String(+val.toFixed(dp)));

function sectionNote(scale, v) {
  const top = +scale.levels.at(-1).toFixed(3);
  const range = v.log ? `${fmtLog(scale.levels[0])} to ${fmtLog(scale.levels.at(-1))}`
    : v.diverging ? `−${top} to +${top}` : `${+scale.levels[0].toFixed(3)}–${top}`;
  const units = v.units ? ` ${v.units}` : "";
  const contours = v.log ? `contours at ${v.anomaly ? "ratios to normal" : "1–2–5 values"}, log scale`
    : `contours every ${+scale.step.toFixed(3)}${units}`;
  if (hstate.scale !== "floating" && scale.fixed) {
    const season = hstate.scale === "season" ? `, ${hShownSeason()}` : "";
    return `Fixed scale, ${range}${units}: it covers every value in the ${scale.maps} sections of ${hstate.compare.join("–")}${season}, ` +
      `so those sections share colours; ${contours}. Grey: no data (below the deepest sample).` +
      (v.anomaly ? ` Anomalies from each station's mean for this ${state.mode === "month" ? "calendar month" : "season"} at each depth (${ANOMALY_MIN_YEARS}+ years).` : "");
  }
  const clim = v.anomaly ? ` Anomalies from each station's mean for this ${state.mode === "month" ? "calendar month" : "season"} at each depth, ` +
    `${hSrc().years[0]}–${hSrc().years[1]} (${ANOMALY_MIN_YEARS}+ years); grey also where there is no climatology.` : "";
  return `Scale fitted to this section, ${range}${units}${v.diverging ? (v.log ? ", symmetric about normal (×1)" : ", symmetric about zero") : ""}; ${contours}. Grey: no data (below the deepest sample)${v.maxDepth ? `; the section stops at ${v.maxDepth} m` : ""}.${clim}`;
}

function addSectionLayers() {
  map.addSource("section-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "section-line", type: "line", source: "section-line",
    paint: { "line-color": "#1f1e1c", "line-width": 3, "line-opacity": 0.75, "line-dasharray": [2, 1] } }, "zero");
  // The section takes the map's scale: redraw it as the map zooms.
  map.on("zoom", () => {
    if (!sCur) return;
    cancelAnimationFrame(sFrame);
    sFrame = requestAnimationFrame(drawSection);
  });
}

function setupSectionControls() {
  document.querySelectorAll("#hydro-display button").forEach((b) => b.addEventListener("click", () => {
    sstate.display = b.dataset.value;
    render();
  }));
  $("section-line-select").addEventListener("change", (e) => { sstate.line = Number(e.target.value); render(); });
  $("section-variable").addEventListener("change", (e) => { sstate.variable = e.target.value; render(); });
  $("section-line-select").innerHTML = hmeta.sectionLines.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
  $("section-panel-close").addEventListener("click", () => { sstate.display = "map"; render(); });
  updateSectionControls();
}

function updateSectionControls() {
  setToggle("hydro-display", sstate.display);
  $("section-controls").hidden = sstate.display !== "section";
  $("section-variable-box").hidden = !hmeta || hView() !== "hydro";
  if (hmeta) {
    const mapLabel = SECTION_COLUMNS[hstate.variable] ? `Same as map (${hVar().label})` : "Same as map (no section)";
    $("section-variable").innerHTML = `<option value="map">${mapLabel}</option>` +
      Object.entries(SECTION_EXTRA).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  }
  $("section-line-select").value = String(sstate.line);
  $("section-variable").value = sstate.variable;
}

function writeSectionHash(params) {
  if (sstate.display !== "section") return;
  params.set("disp", "section");
  params.set("line", sstate.line);
  if (sstate.variable !== "map") params.set("svar", sstate.variable);
}

function readSectionHash(params) {
  if (params.get("disp") === "section") sstate.display = "section";
  if ([90, 80].includes(Number(params.get("line")))) sstate.line = Number(params.get("line"));
  if (params.get("svar") in SECTION_EXTRA) sstate.variable = params.get("svar");
}

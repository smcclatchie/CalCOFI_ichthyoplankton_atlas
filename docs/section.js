// Hydrographic sections along CalCOFI lines 90, 80 and 60, in the
// Hydrography view: depth (0-500 m) against distance along the line, coast on
// the right, for the month or season shown and the source chosen.
//
// Data (docs/data/hydro/<source>/line<L>.json, built by build_hydro_data.py):
// station x survey month x standard-depth means: p, st, z (depth index), n,
// t, s, d (sigma-theta), o (oxygen), n2 (stability, at an interval's upper
// depth), dh (CalCOFI's dynamic height, accumulated from the surface).
//
// A station's value for a season is the mean of its survey months. The
// section is interpolated linearly between neighbouring stations and between
// standard depths, never beyond the outermost stations or below a station's
// deepest value (no smoothing: a section shows each station as sampled).
//
// Geostrophic velocity across the line, relative to 500 dbar, between each
// pair of neighbouring stations that both reach 500 m:
//   v(z) = (10 / f) * (dD_on(z) - dD_off(z)) / L,   dD(z) = D(500) - D(z)
// with D in dynamic metres (x10 = m2 s-2), f = 2 Omega sin(latitude), L the
// station spacing; positive = poleward (to the left looking onshore).
"use strict";

const SECTION_VARIABLES = {
  temperature: { label: "Temperature", units: "°C", col: "t", style: "temperature" },
  salinity: { label: "Salinity", units: "", col: "s", style: "salinity" },
  sigma_theta: { label: "Density (σθ)", units: "kg m⁻³", col: "d", style: "sigma_theta" },
  oxygen: { label: "Dissolved oxygen", units: "ml L⁻¹", col: "o", style: "oxygen" },
  n2: { label: "Stability (N²)", units: "10⁻⁴ s⁻²", col: "n2", style: "n2", interval: true },
  geovel: { label: "Geostrophic velocity, rel. 500 dbar (poleward +)", units: "cm s⁻¹", style: "salinity", diverging: true },
};
const SECTION_MAX_GAP_KM = 150;      // stations farther apart are not joined
const SECTION_DEPTH = 500;
const sstate = { display: "map", line: 90, variable: "temperature" };
const scache = new Map();            // "source/line" -> data
let sLoadToken = 0;

const sVar = () => SECTION_VARIABLES[sstate.variable];
const sKey = () => `${hSrcKey()}/line${sstate.line}`;
const sectionShown = () => state.layer === "hydro" && hView() === "hydro" && sstate.display === "section";

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

// The line's stations, with their distance (km) from the inshore-most one.
// The axis spans the line's regularly occupied stations (at least 10% as
// many survey months as the most-occupied station), so it is the same at
// every time step without the 1950s extended grid's far-offshore stations
// leaving most of it empty; rarer stations beyond it are drawn only when
// sampled.
function lineGeometry(d) {
  const all = hSrc().stations.map((s, i) => ({ ...s, i })).filter((s) => s.line === sstate.line);
  if (!all.length) return null;
  const visits = new Map();
  for (let i = 0; i < d.p.length; i++) if (d.z[i] === 0) visits.set(d.st[i], (visits.get(d.st[i]) || 0) + 1);
  const top = Math.max(0, ...visits.values());
  const core = all.filter((s) => (visits.get(s.i) || 0) >= 0.1 * top);
  const origin = all.reduce((a, b) => (b.station < a.station ? b : a));
  const km = (a, b) => {
    const r = Math.PI / 180, dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  const x = new Map(all.map((s) => [s.i, km(origin, s)]));
  const coreMax = Math.max(...(core.length ? core : all).map((s) => x.get(s.i)));
  return { stations: all, x, xmax: coreMax * 1.03 };
}

// Station profiles for the survey months `periods`: station -> {x, lat, station, col -> [depth index] value}.
function sectionProfiles(d, periods, geo) {
  const depths = hSrc().depths;
  const acc = new Map();
  for (const p of periods) {
    for (const i of d.byPeriod.get(p) || []) {
      if (!geo.x.has(d.st[i]) || geo.x.get(d.st[i]) > geo.xmax) continue;
      if (!acc.has(d.st[i])) acc.set(d.st[i], {});
      const a = acc.get(d.st[i]);
      for (const col of ["t", "s", "d", "o", "n2", "dh"]) {
        const v = d[col][i];
        if (v === null) continue;
        a[col] = a[col] || depths.map(() => ({ sum: 0, n: 0 }));
        a[col][d.z[i]].sum += v;
        a[col][d.z[i]].n += 1;
      }
    }
  }
  const out = [];
  const meta = new Map(geo.stations.map((s) => [s.i, s]));
  for (const [st, a] of acc) {
    const prof = { st, x: geo.x.get(st), lat: meta.get(st).lat, station: meta.get(st).station };
    for (const col of Object.keys(a)) prof[col] = a[col].map((c) => (c.n ? c.sum / c.n : null));
    out.push(prof);
  }
  return out.sort((p, q) => p.x - q.x);
}

// Columns of (depth, value) points for the section variable.
function sectionColumns(profiles) {
  const depths = hSrc().depths, v = sVar();
  if (sstate.variable === "geovel") {
    const k500 = depths.indexOf(SECTION_DEPTH), cols = [];
    for (let i = 1; i < profiles.length; i++) {
      const a = profiles[i - 1], b = profiles[i];          // a inshore, b offshore
      if (!a.dh || !b.dh || a.dh[k500] === null || b.dh[k500] === null || b.x - a.x > SECTION_MAX_GAP_KM || b.x - a.x <= 0) continue;
      const lat = (a.lat + b.lat) / 2, f = 2 * 7.2921e-5 * Math.sin((lat * Math.PI) / 180), L = (b.x - a.x) * 1000;
      const pts = [];
      depths.forEach((z, k) => {
        if (a.dh[k] === null || b.dh[k] === null) return;
        const dA = a.dh[k500] - a.dh[k], dB = b.dh[k500] - b.dh[k];
        pts.push([z, ((10 / f) * (dA - dB) / L) * 100]);
      });
      cols.push({ x: (a.x + b.x) / 2, pts, label: null });
    }
    return cols;
  }
  return profiles.map((p) => {
    const vals = p[v.col] || [];
    const pts = [];
    vals.forEach((val, k) => {
      if (val === null) return;
      // N2 belongs to the interval below its depth: plot it at the interval's middle.
      const z = v.interval ? (depths[k] + depths[k + 1]) / 2 : depths[k];
      if (Number.isFinite(z)) pts.push([z, val]);
    });
    return { x: p.x, pts, label: p.station };
  }).filter((c) => c.pts.length);
}

// Values for a set of survey months (for the floating and compare-years scales).
const sectionValues = (cols) => cols.flatMap((c) => c.pts.map((p) => p[1]));

function sectionRange(d, geo) {
  // Fixed scales: every value in the sections of the years compared (all
  // seasons, or the season shown), as on the maps.
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
  let lo = Infinity, hi = -Infinity;
  for (const ps of groups.values()) {
    for (const v of sectionValues(sectionColumns(sectionProfiles(d, ps, geo)))) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  return Number.isFinite(lo) ? { lo, hi, maps: groups.size } : null;
}

function sectionScale(values, fixed) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (fixed) ({ lo, hi } = fixed);
  if (sVar().diverging) { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.1); lo = -m; hi = m; }
  if (!(hi > lo)) hi = lo + 0.01;
  const { levels, step } = niceLevels(lo, hi);
  const style = HYDRO_STYLES[sVar().style], n = levels.length - 1, a = levels[0], b = levels[n];
  const stops = sVar().diverging ? ANOMALY_STYLES.salinity : style.stops;
  const smooth = sVar().diverging ? true : style.smooth;
  const colors = Array.from({ length: n }, (_, i) => rgbText(paletteAt(stops, (i + 0.5) / n)));
  const colorAt = smooth
    ? (v) => paletteAt(stops, (v - a) / (b - a))
    : (v) => paletteAt(stops, (Math.min(n - 1, Math.max(0, Math.floor(((v - a) / (b - a)) * n))) + 0.5) / n);
  const vmin = Math.min(...values), vmax = Math.max(...values);
  return { levels, step, colors, colorAt, smooth, fixed: Boolean(fixed), maps: fixed?.maps ?? 0, below: vmin < a, above: vmax > b,
    line: sVar().diverging ? "#1f1e1c" : style.line };
}

// Interpolate the columns onto a grid (x from the coast offshore, z down).
function sectionGrid(cols, xmax, nx = 280, nz = 126) {
  const zAt = (j) => (j / (nz - 1)) * SECTION_DEPTH, xAt = (i) => (i / (nx - 1)) * xmax;
  // each column interpolated vertically onto the grid depths
  const colVals = cols.map((c) => {
    const v = new Float64Array(nz).fill(NaN), pts = c.pts;
    for (let j = 0; j < nz; j++) {
      const z = zAt(j);
      if (z < pts[0][0]) { if (pts[0][0] <= 12) v[j] = pts[0][1]; continue; }   // reach up to the surface from a near-surface value
      for (let k = 1; k < pts.length; k++) {
        if (z <= pts[k][0]) {
          const [z0, v0] = pts[k - 1], [z1, v1] = pts[k];
          v[j] = v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
          break;
        }
      }
      if (pts.length === 1 && Math.abs(z - pts[0][0]) < 1e-9) v[j] = pts[0][1];
    }
    return v;
  });
  const g = new Float64Array(nx * nz).fill(NaN);
  for (let i = 0; i < nx; i++) {
    const x = xAt(i);
    let k = cols.findIndex((c) => c.x >= x);
    if (k < 0) continue;
    if (cols[k].x === x || (k === 0 && Math.abs(cols[0].x - x) < xmax / nx)) { for (let j = 0; j < nz; j++) g[j * nx + i] = colVals[k][j]; continue; }
    if (k === 0) continue;
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

async function renderSection() {
  const panel = $("section-panel");
  if (!sectionShown()) {
    panel.hidden = true;
    if (map.getSource("section-line")) map.getSource("section-line").setData({ type: "FeatureCollection", features: [] });
    return;
  }
  const token = ++sLoadToken;
  panel.hidden = false;
  $("station-panel").hidden = true;
  document.querySelector(".map-area").classList.add("section-open");
  if (!scache.has(sKey())) {
    $("section-chart").innerHTML = '<p class="hint" style="padding:12px">Loading section…</p>';
    await loadSection();
    if (token !== sLoadToken) return;
  }
  const d = scache.get(sKey()), geo = lineGeometry(d);
  const periods = hShownPeriods();
  const when = !periods.length ? "" : state.mode === "month" ? hPeriodText(periods[0]) : seasonText(hSteps[hstate.seasonPos]);
  const v = sVar();
  $("section-title").textContent = `Line ${sstate.line} — ${v.label}${v.units ? ` (${v.units})` : ""} · ${when} · ${hSrc().label}`;
  // the line on the map
  if (geo) {
    const coords = geo.stations.slice().sort((a, b) => geo.x.get(a.i) - geo.x.get(b.i)).map((s) => [s.lon, s.lat]);
    map.getSource("section-line").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }] });
  }
  const box = $("section-chart");
  if (!geo) { box.innerHTML = `<p class="hint" style="padding:12px">No ${hSourceWord()} stations on line ${sstate.line}.</p>`; return; }
  const profiles = sectionProfiles(d, periods, geo);
  const cols = sectionColumns(profiles);
  if (cols.length < 2) {
    box.innerHTML = `<p class="hint" style="padding:12px">Line ${sstate.line} was not sampled${cols.length ? " at enough stations" : ""} in ${when || "this period"} (${hSourceWord()}).</p>`;
    return;
  }
  const values = sectionValues(cols);
  const fixed = hstate.scale !== "floating" ? sectionRange(d, geo) : null;
  const scale = sectionScale(values, fixed);
  const grid = sectionGrid(cols, geo.xmax);

  const W = box.clientWidth || 900, Hbox = Math.max(160, (box.clientHeight || 330) - 34);   // less the colour-bar row
  const m = { l: 46, r: 14, t: 26, b: 52 }, pw = W - m.l - m.r, ph = Hbox - m.t - m.b;
  const px = (x) => m.l + (1 - x / geo.xmax) * pw;            // coast (x = 0) on the right
  const py = (z) => m.t + (z / SECTION_DEPTH) * ph;
  // fill image, columns ordered left (offshore) to right (coast)
  const canvas = document.createElement("canvas");
  canvas.width = grid.nx; canvas.height = grid.nz;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(grid.nx, grid.nz);
  for (let j = 0; j < grid.nz; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const val = grid.g[j * grid.nx + i];
      if (!Number.isFinite(val)) continue;
      const c = scale.colorAt(val), o = (j * grid.nx + (grid.nx - 1 - i)) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // contour lines on a gap-filled copy (so masks make no false lines), clipped to the data
  const filled = Float64Array.from(grid.g);
  for (let j = 0; j < grid.nz; j++) {
    let last = NaN;
    for (let i = 0; i < grid.nx; i++) { const k = j * grid.nx + i; if (Number.isFinite(filled[k])) last = filled[k]; else if (Number.isFinite(last)) filled[k] = last; }
    last = NaN;
    for (let i = grid.nx - 1; i >= 0; i--) { const k = j * grid.nx + i; if (Number.isFinite(filled[k])) last = filled[k]; else if (Number.isFinite(last)) filled[k] = last; }
  }
  for (let i = 0; i < grid.nx; i++) {
    let last = NaN;
    for (let j = 0; j < grid.nz; j++) { const k = j * grid.nx + i; if (Number.isFinite(filled[k])) last = filled[k]; else if (Number.isFinite(last)) filled[k] = last; }
  }
  const fmin = Math.min(...values) - 1;
  for (let k = 0; k < filled.length; k++) if (!Number.isFinite(filled[k])) filled[k] = fmin;
  const gx = (x) => px((x / (grid.nx - 1)) * geo.xmax), gz = (z) => py((z / (grid.nz - 1)) * SECTION_DEPTH);
  const toPath = (rings) => rings.map((ring) => "M" + ring.map(([x, y]) => `${gx(x - 0.5).toFixed(1)},${gz(y - 0.5).toFixed(1)}`).join("L")).join("");
  const mask = d3.contours().size([grid.nx, grid.nz]).thresholds([0.5])(Array.from(grid.g, (v) => (Number.isFinite(v) ? 1 : 0)))[0];
  const clip = mask.coordinates.map((poly) => toPath(poly) + "Z").join("");
  const lines = d3.contours().size([grid.nx, grid.nz]).thresholds(scale.levels)(Array.from(filled));
  const parts = [];
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="#d9d7cf"/>`);   // below the data: grey
  parts.push(`<defs><clipPath id="section-clip"><path d="${clip}"/></clipPath></defs>`);
  parts.push(`<image href="${canvas.toDataURL()}" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" preserveAspectRatio="none" style="image-rendering:auto"/>`);
  const labels = [];
  lines.forEach((c) => {
    if (!c.coordinates.length) return;
    const rings = c.coordinates.flat();
    const zero = sVar().diverging && Math.abs(c.value) < 1e-9;
    parts.push(`<path d="${toPath(rings)}" fill="none" stroke="${scale.line}" stroke-width="${zero ? 1.8 : 0.8}" stroke-opacity="0.85" clip-path="url(#section-clip)"/>`);
    // one label per level: the middle of its longest ring's points that lie
    // inside the data and away from the section's edges
    const ring = rings.reduce((a, b) => (b.length > a.length ? b : a));
    const inside = ring.filter(([x, y]) => {
      const gi = Math.round(x - 0.5), gj = Math.round(y - 0.5);
      return gi > 3 && gi < grid.nx - 4 && gj > 5 && gj < grid.nz - 6 && Number.isFinite(grid.g[gj * grid.nx + gi]);
    });
    if (inside.length > 8) {
      const [x, y] = inside[Math.floor(inside.length / 2)];
      const lx = gx(x - 0.5), ly = gz(y - 0.5);
      if (!labels.some((l) => Math.hypot(l.x - lx, l.y - ly) < 28)) labels.push({ x: lx, y: ly, t: sVar().diverging ? signedValue(c.value) : String(+c.value.toFixed(3)) });
    }
  });
  for (const l of labels) {
    parts.push(`<text x="${l.x}" y="${l.y + 3}" text-anchor="middle" font-size="10" font-weight="600" fill="${scale.line}" ` +
      `stroke="${scale.line === "#ffffff" ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.8)"}" stroke-width="2.4" paint-order="stroke">${l.t}</text>`);
  }
  // axes: depth (left), distance (bottom), stations (top)
  for (let z = 0; z <= SECTION_DEPTH; z += 100) {
    parts.push(`<line x1="${m.l - 4}" x2="${m.l}" y1="${py(z)}" y2="${py(z)}" stroke="#85837c"/>`);
    parts.push(`<text x="${m.l - 6}" y="${py(z) + 4}" text-anchor="end" font-size="11" fill="#85837c">${z}</text>`);
  }
  parts.push(`<text transform="translate(12 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="#85837c">depth (m)</text>`);
  const step = geo.xmax > 600 ? 200 : 100;
  for (let x = 0; x <= geo.xmax; x += step) {
    parts.push(`<line x1="${px(x)}" x2="${px(x)}" y1="${m.t + ph}" y2="${m.t + ph + 4}" stroke="#85837c"/>`);
    parts.push(`<text x="${px(x)}" y="${m.t + ph + 16}" text-anchor="middle" font-size="11" fill="#85837c">${x}</text>`);
  }
  parts.push(`<text x="${m.l + pw / 2}" y="${m.t + ph + 32}" text-anchor="middle" font-size="11" fill="#85837c">distance from the inshore end of line ${sstate.line} (km) · coast →</text>`);
  const sampled = new Set(profiles.map((p) => p.st));
  let lastX = -Infinity;
  for (const s of geo.stations.filter((q) => geo.x.get(q.i) <= geo.xmax).sort((a, b) => geo.x.get(b.i) - geo.x.get(a.i))) {
    const X = px(geo.x.get(s.i));
    const on = sampled.has(s.i);
    parts.push(`<path d="M${X} ${m.t - 2} l-3.5 -6 h7 Z" fill="${on ? "#1f1e1c" : "#c9c7bf"}"/>`);
    if (on && X - lastX > 22) { parts.push(`<text x="${X}" y="${m.t - 11}" text-anchor="middle" font-size="9" fill="#5b5a55">${+s.station.toFixed(1)}</text>`); lastX = X; }
  }
  box.innerHTML = `<div class="section-bar">${hydroColourBar(Math.min(420, W - 40), scale, Boolean(sVar().diverging))}<span class="section-note">${sectionNote(scale)}</span></div>` +
    `<svg viewBox="0 0 ${W} ${Hbox}" width="100%" height="100%" role="img" aria-label="Section">${parts.join("")}</svg>`;
  // value under the cursor
  const svg = box.querySelector("svg");
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  box.appendChild(tip);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const X = ((e.clientX - r.left) / r.width) * W, Y = ((e.clientY - r.top) / r.height) * Hbox;
    const x = (1 - (X - m.l) / pw) * geo.xmax, z = ((Y - m.t) / ph) * SECTION_DEPTH;
    const i = Math.round((x / geo.xmax) * (grid.nx - 1)), j = Math.round((z / SECTION_DEPTH) * (grid.nz - 1));
    const val = i >= 0 && j >= 0 && i < grid.nx && j < grid.nz ? grid.g[j * grid.nx + i] : NaN;
    if (!Number.isFinite(val)) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${sVar().diverging ? signedValue(+val.toFixed(1)) : +val.toFixed(3)}${v.units ? ` ${v.units}` : ""} · ${Math.round(z)} m · ${Math.round(x)} km`;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, e.clientX - r.left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${e.clientY - r.top - 34}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
}

function sectionNote(scale) {
  const range = sVar().diverging ? `−${+scale.levels.at(-1).toFixed(3)} to +${+scale.levels.at(-1).toFixed(3)}`
    : `${+scale.levels[0].toFixed(3)}–${+scale.levels.at(-1).toFixed(3)}`;
  const which = hstate.scale === "floating" ? "floating, fitted to this section"
    : scale.fixed ? `fixed across the ${scale.maps} sections of ${hstate.compare.join("–")}${hstate.scale === "season" ? ` (${hShownSeason()})` : ""}` : "floating (no data in the years compared)";
  return `${range}, contours every ${+scale.step.toFixed(3)} (${which}). Grey: below the deepest sample.`;
}

function addSectionLayers() {
  map.addSource("section-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "section-line", type: "line", source: "section-line",
    paint: { "line-color": "#1f1e1c", "line-width": 3, "line-opacity": 0.75, "line-dasharray": [2, 1] } }, "zero");
}

function setupSectionControls() {
  document.querySelectorAll("#hydro-display button").forEach((b) => b.addEventListener("click", () => {
    sstate.display = b.dataset.value;
    updateSectionControls();
    if (sstate.display === "map") {
      $("section-panel").hidden = true;
      document.querySelector(".map-area").classList.remove("section-open");
    }
    render();
  }));
  $("section-line-select").addEventListener("change", (e) => { sstate.line = Number(e.target.value); render(); });
  $("section-variable").addEventListener("change", (e) => { sstate.variable = e.target.value; render(); });
  $("section-variable").innerHTML = Object.entries(SECTION_VARIABLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("section-line-select").innerHTML = hmeta.sectionLines.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
  $("section-panel-close").addEventListener("click", () => { sstate.display = "map"; updateSectionControls(); $("section-panel").hidden = true; document.querySelector(".map-area").classList.remove("section-open"); render(); });
  updateSectionControls();
}

function updateSectionControls() {
  setToggle("hydro-display", sstate.display);
  $("section-controls").hidden = sstate.display !== "section";
  $("section-line-select").value = String(sstate.line);
  $("section-variable").value = sstate.variable;
}

function writeSectionHash(params) {
  if (sstate.display !== "section") return;
  params.set("disp", "section");
  params.set("line", sstate.line);
  params.set("svar", sstate.variable);
}

function readSectionHash(params) {
  if (params.get("disp") === "section") sstate.display = "section";
  if ([90, 80, 60].includes(Number(params.get("line")))) sstate.line = Number(params.get("line"));
  if (params.get("svar") in SECTION_VARIABLES) sstate.variable = params.get("svar");
}

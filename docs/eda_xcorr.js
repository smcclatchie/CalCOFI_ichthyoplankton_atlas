// EDA view: cross-correlation, as a triangular matrix of scatterplots (2026-10-17,
// user; EDA list item 3). Each point is one station in one season. The variables
// ticked in either column form one set; every pair is plotted once, below the
// diagonal (x = the earlier variable, y = the later), the diagonal naming them;
// each cell shows Pearson's r, the number of pairs and a LOWESS smooth.
//
//  - Spatial: the core CalCOFI lines (76.7-93.3), all or one; station values.
//  - Time: one season (stepped), all seasons in all years, or one calendar
//    season over a range of years.
//  - Lag: each cell's y variable one season after its x variable (x in season s,
//    y in season s + 1 at the same station).
//  - Variables (one value per station and season, the mean of its survey
//    months, as everywhere in the atlas):
//      temperature, salinity, chlorophyll, nitrate, dissolved oxygen, pH --
//        mean over 0-200 m, integrated (trapezoidal) over the standard depths,
//        from the bottle or CTD casts (pH: CTD only; chlorophyll as ug/L);
//        a station counts when its profile starts within 10 m of the surface
//        and reaches 200 m;
//      SCTI -- the Southern California Temperature Index (Spray gliders, 50 m on
//        line 90), one value per season, the same for every station;
//      larval fish and adult krill species in the top 10% by abundance (user; was 25%)
//        (docs/data/eda_species.json, python/build_eda_species.py), as
//        log10(1 + abundance): larvae in the CalCOFI bongo net (per 10 m2),
//        krill adults (per m2), standard sampling; zero catches are left out of
//        the pairs (user, 2026-10-17), so a cell shows where the species was caught.
"use strict";

const XC_LINES = [76.7, 80, 83.3, 86.7, 90, 93.3];
const XC_DEPTH = 200;
const XC_MAX_VARS = 7;            // in all: the triangle (21 cells) has to fit one screen
const XC_HYDRO = [
  { id: "t", label: "Temperature", units: "°C", col: "t" },
  { id: "s", label: "Salinity", units: "", col: "s" },
  { id: "no3", label: "Nitrate", units: "µM", col: "no3" },
  { id: "o", label: "Dissolved oxygen", units: "mL/L", col: "o" },
  { id: "ph", label: "pH", units: "", col: "ph" },
  { id: "sp", label: "Spiciness", units: "kg m⁻³", col: "sp" },          // added 2026-10-17 (user)
];
const XC_SEASONS = ["winter", "spring", "summer", "autumn"];
// Zooplankton (user, 2026-10-17): the atlas's datasets, as log10(1 + value), zeros left out
// (ZooScan copepods were here briefly; removed by the user)
// Warm/cool groups (user, 2026-10-17): summed abundance of their members, log axes, zeros left out.
// Larvae: the atlas's groups (the warm/cool ternary plot's species). Krill adults: the krill ternary
// plot's classification (user-confirmed, pending checking), warm = warm-central + warm-equatorial.
const XC_GROUPS = [
  { id: "gwf", label: "Warm-water larvae", units: "larvae per 10 m², log scale", log: true, sub: "", net: "CB", stage: "larva", keys: ["group:warm-water"] },
  { id: "gcf", label: "Cool-water larvae", units: "larvae per 10 m², log scale", log: true, sub: "", net: "CB", stage: "larva", keys: ["group:cool-water"] },
  { id: "gwk", label: "Warm-water krill (central + equatorial)", units: "adults per m², log scale", log: true, sub: "zoo/krill/", net: "KR", stage: "adult",
    keys: ["worms:221047", "worms:110684", "worms:110686", "worms:110688", "worms:237864", "worms:237853", "worms:110700", "worms:1649791"] },
  { id: "gck", label: "Cool-water krill", units: "adults per m², log scale", log: true, sub: "zoo/krill/", net: "KR", stage: "adult",
    keys: ["worms:237851", "worms:237874", "worms:1649784", "worms:110707", "worms:237870", "worms:237873"] },
];
const XC_ZOO = [
  { id: "vol", label: "Displacement volume (total)", units: "mL per 1,000 m³, log scale", log: true, sub: "zoo/volume/", net: "CB", stage: "volume", taxon: 0 },
];
const xc = {
  // default (user, 2026-10-17, from their chosen view): oxygen, nitrate, salinity, temperature and
  // displacement volume against Euphausia pacifica adults (krill taxon 4), line 90, bottle, winters 1983-2023
  x: ["o", "no3", "s", "t", "vol"], y: ["k:4"], lines: "90", source: "bottle", mode: "range", when: null, cal: "winter", y0: 1983, y1: 2023,
  lag: false, ready: false, token: 0, species: null, cache: new Map(),
};

const xcSeasonKey = (year, month) => `${year + (month === 12 ? 1 : 0)}-${SEASON_OF_MONTH[month]}`;
const xcNext = (key) => {
  const [y, s] = key.split("-"), i = XC_SEASONS.indexOf(s);
  return i === 3 ? `${+y + 1}-winter` : `${y}-${XC_SEASONS[i + 1]}`;
};
const xcLineOf = (stationKey) => +stationKey.slice(0, 5);

// All variables: { id, label, group }.
function xcVariables() {
  const sp = xc.species;
  return [
    ...XC_HYDRO.map((v) => ({ ...v, group: `Hydrography, 0–${XC_DEPTH} m mean` })),
    // integrated chlorophyll replaces the 0-200 m mean chlorophyll (user, 2026-10-17): CalCOFI's own, CTD casts
    { id: "chli", label: "Integrated chlorophyll a, 0–200 m", units: "mg m⁻², log scale; CTD", logAxis: true, group: `Hydrography, 0–${XC_DEPTH} m mean` },
    // depths of the Water masses view's isopycnals (user, 2026-10-17): per cast, from the profiles
    { id: "zs25", label: "Depth of σθ 25.8", units: "m", group: "Isopycnal depths" },
    { id: "zs264", label: "Depth of σθ 26.4", units: "m", group: "Isopycnal depths" },
    { id: "scti", label: "SCTI (SoCal Temperature Index)", group: "Index", units: "°C" },
    ...XC_ZOO.map((z) => ({ ...z, group: "Zooplankton" })),
    ...XC_GROUPS.map((z) => ({ ...z, group: "Warm/cool-water groups" })),
    ...sp.ichthyo.species.map((t) => ({ id: `f:${t.id}`, label: t.scientific, common: t.common, units: "larvae per 10 m², log scale", log: true, group: "Larval fish, top 10% by abundance" })),
    ...sp.krill.species.map((t) => ({ id: `k:${t.id}`, label: t.scientific, units: "adults per m², log scale", log: true, group: "Krill adults, top 10% by abundance" })),
  ];
}

// ---- data: Map(seasonKey -> Map(stationKey -> value)) per variable ----

async function xcHydro(v) {
  const key = `${xc.source}/${v.id}`;
  if (xc.cache.has(key)) return xc.cache.get(key);
  const src = hmeta.sources[xc.source], out = new Map();
  for (const line of XC_LINES) {
    const lineKey = `${xc.source}/line${line}`, d = await loadSection(lineKey), geo = lineGeometry(d, src, line);
    if (!geo) continue;
    for (const step of lvSeasons(d, src, v.col)) {
      for (const p of sectionProfiles(d, step.periods, geo, src)) {
        const pts = (p[v.col] || []).map((val, k) => [src.depths[k], val]).filter(([z, val]) => val !== null && z <= XC_DEPTH)
          .map(([z, val]) => [z, v.log10 ? 10 ** val : val]);
        if (pts.length < 4 || pts[0][0] > 10 || pts[pts.length - 1][0] < XC_DEPTH) continue;
        let integral = pts[0][1] * pts[0][0];
        for (let k = 1; k < pts.length; k++) integral += ((pts[k][1] + pts[k - 1][1]) / 2) * (pts[k][0] - pts[k - 1][0]);
        if (!out.has(step.key)) out.set(step.key, new Map());
        const mean = integral / XC_DEPTH;
        out.get(step.key).set(src.stations[p.st].key, v.logAxis ? Math.log10(Math.max(mean, 0.01)) : mean);
      }
    }
  }
  xc.cache.set(key, out);
  return out;
}

const xcDataset = new Map();
async function xcSpecies(kind, id) {
  const info = xc.species[kind === "f" ? "ichthyo" : "krill"];
  return xcDatasetVar(`${kind}:${id}`, { sub: kind === "f" ? "" : "zoo/krill/", net: info.net, stage: info.stage, taxon: id });
}

// One taxon of an atlas dataset (larvae, krill, plankton volume, ZooScan): per station and
// season, the mean over the season's survey months (standard sampling, absences as zero),
// as log10(1 + value).
async function xcDatasetVar(key, spec) {
  if (xc.cache.has(key)) return xc.cache.get(key);
  const sub = spec.sub, info = spec, id = spec.taxon;
  if (!xcDataset.has(sub)) {
    const [m, o] = await Promise.all([getJSON(`${sub}meta.json`), getJSON(`${sub}occupations.json`)]);
    xcDataset.set(sub, { m, o });
  }
  // spec.keys: several taxa (by key, looked up in the dataset's taxa.json), summed per sample
  let ids = [id];
  if (spec.keys) {
    if (!xcDataset.get(sub).taxa) xcDataset.get(sub).taxa = await getJSON(`${sub}taxa.json`);
    const byKey = new Map(xcDataset.get(sub).taxa.map((t) => [t.key, t.id]));
    ids = spec.keys.map((k) => byKey.get(k)).filter((x) => x !== undefined);
  }
  const { m, o } = xcDataset.get(sub), files = await Promise.all(ids.map((i) => getJSON(`${sub}taxa/${i}.json`)));
  const sStd = m.samplings.indexOf("standard"), net = m.nets.findIndex((n) => n.code === info.net);
  const g = (m.stages || m.stageInfo.map((x) => x.key)).indexOf(info.stage);
  const core = (st) => XC_LINES.includes(m.stations[st].line);
  const catchAt = new Map();
  for (const r of files) {
    r.p.forEach((p, i) => {
      if (r.s[i] !== sStd || r.n[i] !== net || r.g[i] !== g) return;
      const k = `${p}|${r.st[i]}`;
      catchAt.set(k, (catchAt.get(k) || 0) + r.a[i]);
    });
  }
  const acc = new Map();          // season -> station -> [sum, n] over the season's survey months
  o.p.forEach((p, i) => {
    if (o.s[i] !== sStd || o.n[i] !== net || !core(o.st[i])) return;
    const per = m.periods[p], sk = xcSeasonKey(per.year, per.month), stk = m.stations[o.st[i]].key;
    if (!acc.has(sk)) acc.set(sk, new Map());
    const a = acc.get(sk).get(stk) || [0, 0];
    a[0] += catchAt.get(`${p}|${o.st[i]}`) || 0; a[1] += 1;
    acc.get(sk).set(stk, a);
  });
  const out = new Map([...acc].map(([sk, st]) => [sk, new Map([...st].map(([k, [sum, n]]) => [k, Math.log10(1 + sum / n)]))]));
  xc.cache.set(key, out);
  return out;
}

async function xcData(id) {
  if (id === "scti") return null;                     // seasonal: handled when pairing
  if (id.startsWith("f:") || id.startsWith("k:")) return xcSpecies(id[0], +id.slice(2));
  if (id === "chli" || id === "zs25" || id === "zs264") return xcCastVar(id);
  const zoo = XC_ZOO.find((z) => z.id === id) || XC_GROUPS.find((z) => z.id === id);
  if (zoo) return xcDatasetVar(zoo.id, zoo);
  return xcHydro(XC_HYDRO.find((v) => v.id === id));
}

// Per-cast values (hydro/<source>/cast.json): integrated chlorophyll ("chli", CalCOFI's, CTD
// casts, log10 mg m-2, on a log axis) and the depths of sigma-theta 25.8 and 26.4 ("zs25",
// "zs264", m); per station and season, the mean over its survey months.
async function xcCastVar(col) {
  const key = `${xc.source}/cast/${col}`;
  if (xc.cache.has(key)) return xc.cache.get(key);
  const src = hmeta.sources[xc.source], c = await getJSON(`hydro/${xc.source}/cast.json`), acc = new Map();
  if (c[col]) c.p.forEach((p, i) => {
    const v = c[col][i], st = src.stations[c.st[i]];
    if (v === null || v === undefined || !XC_LINES.includes(st.line)) return;
    const per = src.periods[p], sk = xcSeasonKey(per.year, per.month);
    if (!acc.has(sk)) acc.set(sk, new Map());
    const a = acc.get(sk).get(st.key) || [0, 0];
    a[0] += v; a[1] += 1;
    acc.get(sk).set(st.key, a);
  });
  const out = new Map([...acc].map(([sk, m]) => [sk, new Map([...m].map(([k, [sum, n]]) => [k, sum / n]))]));
  xc.cache.set(key, out);
  return out;
}

// The seasons the time-scale setting keeps.
function xcSeasonsWanted(all) {
  if (xc.mode === "one") return all.includes(xc.when) ? [xc.when] : [];
  if (xc.mode === "range") return all.filter((k) => { const [y, s] = k.split("-"); return s === xc.cal && +y >= xc.y0 && +y <= xc.y1; });
  return all;
}

// Pairs (x, y) for one cell.
function xcPairs(dx, dy, idx, idy, seasons) {
  const scti = lvIndices.scti.seasons, inLine = (stk) => xc.lines === "all" || xcLineOf(stk) === +xc.lines;
  const pts = [];
  for (const sx of seasons) {
    const sy = xc.lag ? xcNext(sx) : sx;
    if (idx === "scti" && idy === "scti") { if (scti[sx] != null && scti[sy] != null) pts.push([scti[sx], scti[sy]]); continue; }
    if (idx === "scti") { const v = scti[sx], my = dy.get(sy); if (v == null || !my) continue; for (const [k, y] of my) if (inLine(k)) pts.push([v, y]); continue; }
    if (idy === "scti") { const v = scti[sy], mx = dx.get(sx); if (v == null || !mx) continue; for (const [k, x] of mx) if (inLine(k)) pts.push([x, v]); continue; }
    const mx = dx.get(sx), my = dy.get(sy);
    if (!mx || !my) continue;
    for (const [k, x] of mx) if (inLine(k) && my.has(k)) pts.push([x, my.get(k)]);
  }
  // Zero catches left out (user, 2026-10-17): a station-season where a species variable is
  // zero (log10(1 + 0)) is not a pair, so r and the line describe where the species was caught.
  const isSpecies = (id) => id.startsWith("f:") || id.startsWith("k:") || XC_ZOO.some((z) => z.id === id) || XC_GROUPS.some((z) => z.id === id);
  return pts.filter(([x, y]) => !(isSpecies(idx) && x === 0) && !(isSpecies(idy) && y === 0));
}

// LOWESS (Cleveland 1979): at XC_LOWESS_N points across the x range, a local linear fit
// to the nearest fraction f of the points, tricube-weighted, with two robustness passes
// (bisquare weights on the residuals). Returns [[x, y], ...]. Tuned 2026-10-17 (user: the
// curves were jagged in single seasons, ~10-30 points): f = 2/3 (the usual default),
// wider for small samples (0.75 below 100 points, 0.9 below 30), no robustness passes
// below 30 points (too few to tell an outlier), and a light 3-point running mean on the
// result to remove the kinks of the moving window.
const XC_LOWESS_N = 40;
const xcSpan = (n) => (n < 30 ? 0.9 : n < 100 ? 0.75 : 2 / 3);
function lowess(pts) {
  const n = pts.length;
  if (n < 10) return null;
  const sorted = pts.slice().sort((a, b) => a[0] - b[0]), xs = sorted.map((p) => p[0]), ys = sorted.map((p) => p[1]);
  const k = Math.max(5, Math.floor(xcSpan(n) * n));
  let robust = new Float64Array(n).fill(1);
  const fitAt = (x0) => {
    // the k nearest points: a window around x0 in the sorted xs
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x0) lo = mid + 1; else hi = mid; }
    let a = Math.max(0, lo - 1), b = a;
    while (b - a + 1 < k) { if (a > 0 && (b >= n - 1 || x0 - xs[a - 1] <= xs[b + 1] - x0)) a--; else b++; }
    const h = Math.max(x0 - xs[a], xs[b] - x0) * 1.0001 || 1e-9;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = a; i <= b; i++) {
      const u = Math.abs(xs[i] - x0) / h, w = (1 - u ** 3) ** 3 * robust[i];
      sw += w; sx += w * xs[i]; sy += w * ys[i]; sxx += w * xs[i] ** 2; sxy += w * xs[i] * ys[i];
    }
    if (sw <= 0) return null;
    const mx = sx / sw, my = sy / sw, vx = sxx / sw - mx * mx;
    return vx > 1e-12 ? my + ((sxy / sw - mx * my) / vx) * (x0 - mx) : my;
  };
  // the fit at XC_LOWESS_N points across the range; robustness residuals from that fit,
  // interpolated (fitting at every point cost O(n^2) per cell: far too slow at 10k points)
  const grid = () => {
    const out = [];
    for (let g = 0; g < XC_LOWESS_N; g++) {
      const x0 = xs[0] + ((xs[n - 1] - xs[0]) * g) / (XC_LOWESS_N - 1), y0 = fitAt(x0);
      if (y0 !== null) out.push([x0, y0]);
    }
    return out;
  };
  const interp = (curve, x) => {
    let k2 = 1;
    while (k2 < curve.length - 1 && curve[k2][0] < x) k2++;
    const [xa, ya] = curve[k2 - 1], [xb, yb] = curve[k2] || curve[k2 - 1];
    return xb > xa ? ya + ((yb - ya) * (x - xa)) / (xb - xa) : ya;
  };
  let curve = grid();
  for (let pass = 0; pass < (n < 30 ? 0 : 2) && curve.length > 1; pass++) {      // robustness: down-weight large residuals
    const res = ys.map((y, i) => Math.abs(y - interp(curve, xs[i])));
    const med = res.slice().sort((p, q) => p - q)[Math.floor(n / 2)] || 1e-9;
    robust = Float64Array.from(res, (r) => { const u = r / (6 * med); return u < 1 ? (1 - u * u) ** 2 : 0; });
    curve = grid();
  }
  // a light 3-point running mean (the ends kept)
  return curve.map(([x, y], i) => (i === 0 || i === curve.length - 1 ? [x, y] : [x, (curve[i - 1][1] + y + curve[i + 1][1]) / 3]));
}

// Axis ticks: nice values; for log-scale species, counts 1, 10, 100, ... at log10(1 + count).
function xcTicks(v, lo, hi) {
  if (v.logAxis) {                                   // log10 values, labelled in the variable's units
    const out = [];
    for (const c of [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]) { const t = Math.log10(c); if (t >= lo && t <= hi) out.push([t, String(c)]); }
    return out;
  }
  if (v.log) {
    const out = [[0, "0"]];
    for (const c of [1, 10, 100, 1000, 10000, 100000]) { const t = Math.log10(1 + c); if (t >= lo && t <= hi) out.push([t, c >= 1000 ? `${c / 1000}k` : String(c)]); }
    return out.filter(([t]) => t >= lo && t <= hi);
  }
  const span = hi - lo, raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push([t, String(+t.toFixed(4))]);
  return out;
}

function pearson(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? { r: sxy / Math.sqrt(sxx * syy), slope: sxy / sxx, mx, my } : null;
}

// ---- interface ----

function setupXcorr() {
  if (xc.ready) return;
  xc.ready = true;
  const vars = xcVariables();
  for (const col of ["x", "y"]) {
    const groups = [...new Set(vars.map((v) => v.group))];
    $(`xc-vars-${col}`).innerHTML = groups.map((g) => `<div class="xc-group">${g}</div>` +
      vars.filter((v) => v.group === g).map((v) => `<label title="${v.common || ""}"><input type="checkbox" value="${v.id}"> ${v.label}</label>`).join("")).join("");
    $(`xc-vars-${col}`).addEventListener("change", (e) => {
      const list = xc[col], id = e.target.value;
      if (e.target.checked) {
        if (new Set([...xc.x, ...xc.y]).size >= XC_MAX_VARS) { e.target.checked = false; $("xc-note").textContent = `At most ${XC_MAX_VARS} variables in all, so the matrix fits the screen.`; return; }
        list.push(id);
      } else xc[col] = list.filter((x) => x !== id);
      // redraw once the ticking pauses (each redraw recomputes the new cells)
      clearTimeout(xc.tickTimer);
      xc.tickTimer = setTimeout(() => { renderXcorr(); writeHash(); }, 250);
    });
  }
  $("xc-line").innerHTML = `<option value="all">All core lines</option>` + XC_LINES.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
  $("xc-line").addEventListener("change", (e) => { xc.lines = e.target.value; renderXcorr(); writeHash(); });
  $("xc-source").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { xc.source = b.dataset.value; renderXcorr(); writeHash(); }));
  $("xc-mode").addEventListener("change", (e) => { xc.mode = e.target.value; renderXcorr(); writeHash(); });
  $("xc-cal").addEventListener("change", (e) => { xc.cal = e.target.value; renderXcorr(); writeHash(); });
  $("xc-y0").addEventListener("change", (e) => { xc.y0 = +e.target.value; renderXcorr(); writeHash(); });
  $("xc-y1").addEventListener("change", (e) => { xc.y1 = +e.target.value; renderXcorr(); writeHash(); });
  $("xc-lag").addEventListener("change", (e) => { xc.lag = e.target.checked; renderXcorr(); writeHash(); });
  $("xc-prev").addEventListener("click", () => xcStep(-1));
  $("xc-next").addEventListener("click", () => xcStep(1));
  $("xc-range").addEventListener("input", (e) => { xc.when = xc.allSeasons[+e.target.value]; renderXcorr(); writeHash(); });
  $("xc-close").addEventListener("click", () => setEda(false));
  // the variable lists: hidden by default (the defaults are chosen), shown to change them
  $("xc-vars-toggle").addEventListener("click", () => {
    const body = document.querySelector("#eda-xcorr .xc-body"), open = body.classList.toggle("collapsed") === false;
    $("xc-vars-toggle").setAttribute("aria-expanded", String(open));
    $("xc-vars-toggle").textContent = open ? "Variables ◂" : "Variables ▸";
    renderXcorr();
  });
}

function xcStep(delta) {
  const all = xc.allSeasons || [], i = all.indexOf(xc.when) + delta;
  if (i < 0 || i >= all.length) return;
  xc.when = all[i];
  renderXcorr(); writeHash();
}

async function renderXcorr() {
  await loadHydroMeta();
  if (!lvIndices.roni) [lvIndices.roni, lvIndices.scti] = await Promise.all([getJSON("roni.json"), getJSON("scti.json")]);
  if (!xc.species) xc.species = await getJSON("eda_species.json");
  setupXcorr();
  const token = ++xc.token;
  for (const col of ["x", "y"]) $(`xc-vars-${col}`).querySelectorAll("input").forEach((i) => { i.checked = xc[col].includes(i.value); });
  $("xc-line").value = String(xc.lines);
  setToggle("xc-source", xc.source);
  $("xc-mode").value = xc.mode; $("xc-cal").value = xc.cal; $("xc-y0").value = xc.y0; $("xc-y1").value = xc.y1; $("xc-lag").checked = xc.lag;
  $("xc-one").hidden = xc.mode !== "one";
  $("xc-range-box").hidden = xc.mode !== "range";
  const vars = xcVariables(), byId = new Map(vars.map((v) => [v.id, v]));
  const X = xc.x.filter((id) => byId.has(id)), Y = xc.y.filter((id) => byId.has(id));
  const V = [...new Set([...X, ...Y])];
  if (V.length < 2) { $("xc-matrix").innerHTML = `<p class="hint" style="padding:12px">Choose at least two variables (in either column).</p>`; return; }
  $("xc-matrix").innerHTML = `<p class="hint" style="padding:12px">Loading…</p>`;
  const data = new Map();
  for (const id of V) data.set(id, await xcData(id));
  if (token !== xc.token) return;
  // the seasons any chosen variable has (SCTI's own seasons if it is all there is)
  const keys = new Set();
  for (const [id, d] of data) (d ? [...d.keys()] : Object.keys(lvIndices.scti.seasons)).forEach((k) => keys.add(k));
  const ord = (k) => +k.slice(0, 4) * 4 + XC_SEASONS.indexOf(k.slice(5));
  xc.allSeasons = [...keys].sort((a, b) => ord(a) - ord(b));
  if (!xc.allSeasons.includes(xc.when)) xc.when = xc.allSeasons.includes("1998-winter") ? "1998-winter" : xc.allSeasons[xc.allSeasons.length - 1];
  $("xc-range").max = String(xc.allSeasons.length - 1);
  $("xc-range").value = String(xc.allSeasons.indexOf(xc.when));
  const [wy, ws] = xc.when.split("-");
  $("xc-when").textContent = seasonText({ year: +wy, season: ws });
  const seasons = xcSeasonsWanted(xc.allSeasons);
  drawXcMatrix(V.map((id) => byId.get(id)), data, seasons);
  const src = hmeta.sources[xc.source];
  const span = xc.mode === "one" ? seasonText({ year: +wy, season: ws }) : xc.mode === "range" ? `${xc.cal}s ${xc.y0}–${xc.y1}` : "all seasons, all years";
  $("xc-note").textContent = `Each point: one station in one season (${xc.lines === "all" ? "core lines 76.7–93.3" : `line ${xc.lines}`}; ${span}${xc.lag ? "; each y one season after its x" : ""}). ` +
    `Hydrography: 0–${XC_DEPTH} m mean of ${src.label} casts reaching ${XC_DEPTH} m (pH: CTD only); integrated chlorophyll: CalCOFI's, CTD casts, log scale; isopycnal depths and spiciness from the cast profiles. Zooplankton: plankton displacement volume (bongo); log scale, zeros left out. Species and warm/cool groups (summed members; krill as in the krill ternary plot): log₁₀(1 + abundance), standard sampling, ` +
    `larvae in the bongo net, krill adults; zero catches left out. SCTI: one value per season for every station. r: Pearson correlation; red line: LOWESS smooth (span 2/3; wider, and not robust, for small samples). Abundance axes: log scale, labelled in counts.`;
}

// One cell's pairs, a drawn subset (at most XC_DRAW_MAX points: r, n and the smooth use
// them all), its LOWESS smooth and Pearson fit, cached by every setting it depends on,
// so ticking a variable computes only the new cells.
const XC_DRAW_MAX = 3000;
const xcCellCache = new Map();
function xcCell(idx, idy, data, seasons) {
  const key = [idx, idy, xc.source, xc.lines, xc.mode, xc.when, xc.cal, xc.y0, xc.y1, xc.lag].join("|");
  if (xcCellCache.has(key)) return xcCellCache.get(key);
  const pts = xcPairs(data.get(idx), data.get(idy), idx, idy, seasons);
  let drawn = pts;
  if (pts.length > XC_DRAW_MAX) {                    // a reproducible random subset
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    drawn = pts.filter(() => rnd() < XC_DRAW_MAX / pts.length);
  }
  const cell = { pts, drawn, smooth: pts.length >= 3 ? lowess(pts) : null, fit: pearson(pts) };
  xcCellCache.set(key, cell);
  return cell;
}

function drawXcMatrix(V, data, seasons) {
  const box = $("xc-matrix");
  const W = box.clientWidth || 800, H = box.clientHeight || 700;
  // an n x n grid: pairs below the diagonal, the variables' names on it; each cell keeps
  // room on its left for its y tick labels and below for its x tick labels
  const n = V.length, m = { l: 2, b: 2, t: 2, r: 2 }, gapL = 30, gapB = 15;
  const cw = (W - m.l - m.r) / n, ch = (H - m.t - m.b) / n;
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"', tick = `font-size="9" fill="#5b5a55" ${font}`;
  const parts = [];
  const range = (vals) => { let lo = Math.min(...vals), hi = Math.max(...vals); if (!(hi > lo)) { lo -= 0.5; hi += 0.5; } const p = (hi - lo) * 0.05; return [lo - p, hi + p]; };
  const name = (v) => `${v.label}${v.units ? ` (${v.units})` : ""}`;
  V.forEach((vy, j) => {
    // the diagonal: the variable's name (wrapped), naming its row (y) and column (x)
    {
      const x0 = m.l + j * cw + gapL, y0 = m.t + j * ch, w = cw - gapL - 3, h = ch - gapB - 3;
      const words = name(vy).split(" "), lines = [];
      for (const wd of words) { const last = lines[lines.length - 1]; if (last && (last + " " + wd).length <= Math.max(12, w / 6.5)) lines[lines.length - 1] = last + " " + wd; else lines.push(wd); }
      parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#eef3f9" stroke="#c9d6e6"/>`);
      lines.forEach((ln, k) => parts.push(`<text x="${x0 + w / 2}" y="${y0 + h / 2 + (k - (lines.length - 1) / 2) * 14 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#1f1e1c" ${font}>${ln}</text>`));
    }
    V.forEach((vx, i) => {
      if (i >= j) return;               // below the diagonal only
      const x0 = m.l + i * cw + gapL, y0 = m.t + j * ch, w = cw - gapL - 3, h = ch - gapB - 3;
      const cell = xcCell(vx.id, vy.id, data, seasons), pts = cell.pts;
      parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fbfaf8" stroke="#dcdad3"/>`);
      if (pts.length < 3) {
        parts.push(`<text x="${x0 + w / 2}" y="${y0 + h / 2}" text-anchor="middle" font-size="11" fill="#85837c" ${font}>${pts.length ? `${pts.length} pairs` : "no pairs"}</text>`);
        return;
      }
      const [ax, bx] = range(pts.map((p) => p[0])), [ay, by] = range(pts.map((p) => p[1]));
      const px = (v) => x0 + ((v - ax) / (bx - ax)) * w, py = (v) => y0 + h - ((v - ay) / (by - ay)) * h;
      // ticks and their labels on both axes
      for (const [t, label] of xcTicks(vx, ax, bx)) {
        parts.push(`<line x1="${px(t)}" x2="${px(t)}" y1="${y0 + h}" y2="${y0 + h + 3}" stroke="#85837c"/>`);
        parts.push(`<text x="${px(t)}" y="${y0 + h + 12}" text-anchor="middle" ${tick}>${label}</text>`);
      }
      for (const [t, label] of xcTicks(vy, ay, by)) {
        parts.push(`<line x1="${x0 - 3}" x2="${x0}" y1="${py(t)}" y2="${py(t)}" stroke="#85837c"/>`);
        parts.push(`<text x="${x0 - 5}" y="${py(t) + 3}" text-anchor="end" ${tick}>${label}</text>`);
      }
      // the smooth first, so the dots sit on top of it
      const smooth = cell.smooth;
      if (smooth) {
        parts.push(`<clipPath id="xc-c${i}-${j}"><rect x="${x0}" y="${y0}" width="${w}" height="${h}"/></clipPath>`);
        parts.push(`<path d="M${smooth.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join("L")}" fill="none" stroke="#ffffff" stroke-width="4" stroke-opacity="0.8" clip-path="url(#xc-c${i}-${j})"/>`);
        parts.push(`<path d="M${smooth.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join("L")}" fill="none" stroke="#c0392b" stroke-width="1.8" stroke-opacity="0.85" clip-path="url(#xc-c${i}-${j})"/>`);
      }
      const rad = pts.length > 2000 ? 1.2 : pts.length > 300 ? 1.8 : 2.6, op = pts.length > 2000 ? 0.25 : pts.length > 300 ? 0.4 : 0.65;
      parts.push(`<g fill="#2a78d6" fill-opacity="${op}">` + cell.drawn.map(([x, y]) => `<circle cx="${px(x).toFixed(1)}" cy="${py(y).toFixed(1)}" r="${rad}"/>`).join("") + "</g>");
      const f = cell.fit;
      parts.push(`<text x="${x0 + 5}" y="${y0 + 13}" font-size="11" font-weight="700" fill="${f && Math.abs(f.r) >= 0.5 ? "#c0392b" : "#1f1e1c"}" ${font} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">r = ${f ? f.r.toFixed(2) : "–"}</text>`);
      parts.push(`<text x="${x0 + 5}" y="${y0 + 25}" font-size="10" fill="#5b5a55" ${font} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">n = ${pts.length}</text>`);
    });
  });
  // scaled to the box (its height can settle after it was measured), so nothing falls off the bottom
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Scatterplot matrix">${parts.join("")}</svg>`;
}

function writeEdaXcorrHash(params) {
  params.set("cx", xc.x.join(","));
  params.set("cy", xc.y.join(","));
  params.set("cl", xc.lines);
  params.set("cs", xc.source);
  params.set("cm", xc.mode);
  if (xc.mode === "one" && xc.when) params.set("cw", xc.when);
  if (xc.mode === "range") params.set("cr", `${xc.cal},${xc.y0},${xc.y1}`);
  if (xc.lag) params.set("lag", "1");
}

function readEdaXcorrHash(params) {
  const ids = (k) => (params.get(k) || "").split(",").filter((x) => /^(t|s|sp|chli|zs25|zs264|no3|o|ph|scti|vol|g[wc][fk]|[fk]:\d+)$/.test(x)).slice(0, XC_MAX_VARS);
  if (params.has("cx")) xc.x = ids("cx");
  if (params.has("cy")) xc.y = ids("cy");
  if (params.get("cl") === "all" || XC_LINES.includes(+params.get("cl"))) xc.lines = params.get("cl");
  if (["bottle", "ctd"].includes(params.get("cs"))) xc.source = params.get("cs");
  if (["one", "all", "range"].includes(params.get("cm"))) xc.mode = params.get("cm");
  if (/^\d{4}-(winter|spring|summer|autumn)$/.test(params.get("cw") || "")) xc.when = params.get("cw");
  const r = (params.get("cr") || "").split(",");
  if (r.length === 3 && XC_SEASONS.includes(r[0])) { xc.cal = r[0]; xc.y0 = +r[1]; xc.y1 = +r[2]; }
  xc.lag = params.get("lag") === "1";
}

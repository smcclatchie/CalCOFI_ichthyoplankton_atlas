// EDA view: cross-correlation, as a matrix of scatterplots (2026-10-17, user;
// EDA list item 3). Each point is one station in one season; the matrix crosses
// the variables chosen in column 1 (its columns, x) with those in column 2 (its
// rows, y), each cell showing Pearson's r and the number of pairs.
//
//  - Spatial: the core CalCOFI lines (76.7-93.3), all or one; station values.
//  - Time: one season (stepped), all seasons in all years, or one calendar
//    season over a range of years.
//  - Lag: column 2 one season after column 1 (x in season s, y in season s + 1
//    at the same station).
//  - Variables (one value per station and season, the mean of its survey
//    months, as everywhere in the atlas):
//      temperature, salinity, chlorophyll, nitrate, dissolved oxygen, pH --
//        mean over 0-200 m, integrated (trapezoidal) over the standard depths,
//        from the bottle or CTD casts (pH: CTD only; chlorophyll as ug/L);
//        a station counts when its profile starts within 10 m of the surface
//        and reaches 200 m;
//      SCTI -- the Southern California Temperature Index (Spray gliders, 50 m on
//        line 90), one value per season, the same for every station;
//      larval fish and adult krill species in the top quarter by abundance
//        (docs/data/eda_species.json, python/build_eda_species.py), as
//        log10(1 + abundance): larvae in the CalCOFI bongo net (per 10 m2),
//        krill adults (per m2), standard sampling, absences as zero.
"use strict";

const XC_LINES = [76.7, 80, 83.3, 86.7, 90, 93.3];
const XC_DEPTH = 200;
const XC_MAX_VARS = 5;            // per column: the matrix has to fit one screen
const XC_HYDRO = [
  { id: "t", label: "Temperature", units: "°C", col: "t" },
  { id: "s", label: "Salinity", units: "", col: "s" },
  { id: "chl", label: "Chlorophyll", units: "µg/L", col: "chl", log10: true },
  { id: "no3", label: "Nitrate", units: "µM", col: "no3" },
  { id: "o", label: "Dissolved oxygen", units: "mL/L", col: "o" },
  { id: "ph", label: "pH", units: "", col: "ph" },
];
const XC_SEASONS = ["winter", "spring", "summer", "autumn"];
const xc = {
  x: ["t", "o", "scti"], y: [], lines: "all", source: "bottle", mode: "all", when: null, cal: "winter", y0: 1983, y1: 2023,
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
    { id: "scti", label: "SCTI (SoCal Temperature Index)", group: "Index", units: "°C" },
    ...sp.ichthyo.species.map((t) => ({ id: `f:${t.id}`, label: t.scientific, common: t.common, group: "Larval fish, top 25% (log₁₀(1 + per 10 m²))" })),
    ...sp.krill.species.map((t) => ({ id: `k:${t.id}`, label: t.scientific, group: "Krill adults, top 25% (log₁₀(1 + per m²))" })),
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
        out.get(step.key).set(src.stations[p.st].key, integral / XC_DEPTH);
      }
    }
  }
  xc.cache.set(key, out);
  return out;
}

const xcDataset = new Map();
async function xcSpecies(kind, id) {
  const key = `${kind}:${id}`;
  if (xc.cache.has(key)) return xc.cache.get(key);
  const sub = kind === "f" ? "" : "zoo/krill/", info = xc.species[kind === "f" ? "ichthyo" : "krill"];
  if (!xcDataset.has(sub)) {
    const [m, o] = await Promise.all([getJSON(`${sub}meta.json`), getJSON(`${sub}occupations.json`)]);
    xcDataset.set(sub, { m, o });
  }
  const { m, o } = xcDataset.get(sub), r = await getJSON(`${sub}taxa/${id}.json`);
  const sStd = m.samplings.indexOf("standard"), net = m.nets.findIndex((n) => n.code === info.net);
  const g = (m.stages || m.stageInfo.map((x) => x.key)).indexOf(info.stage);
  const core = (st) => XC_LINES.includes(m.stations[st].line);
  const catchAt = new Map();
  r.p.forEach((p, i) => { if (r.s[i] === sStd && r.n[i] === net && r.g[i] === g) catchAt.set(`${p}|${r.st[i]}`, r.a[i]); });
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
  return xcHydro(XC_HYDRO.find((v) => v.id === id));
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
  return pts;
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
  if (!xc.y.length) {
    const anchovy = vars.find((v) => v.label === "Engraulis mordax"), pacifica = vars.find((v) => v.label === "Euphausia pacifica");
    xc.y = [anchovy?.id, pacifica?.id].filter(Boolean);
  }
  for (const col of ["x", "y"]) {
    const groups = [...new Set(vars.map((v) => v.group))];
    $(`xc-vars-${col}`).innerHTML = groups.map((g) => `<div class="xc-group">${g}</div>` +
      vars.filter((v) => v.group === g).map((v) => `<label title="${v.common || ""}"><input type="checkbox" value="${v.id}"> ${v.label}</label>`).join("")).join("");
    $(`xc-vars-${col}`).addEventListener("change", (e) => {
      const list = xc[col], id = e.target.value;
      if (e.target.checked) {
        if (list.length >= XC_MAX_VARS) { e.target.checked = false; $("xc-note").textContent = `At most ${XC_MAX_VARS} variables per column, so the matrix fits the screen.`; return; }
        list.push(id);
      } else xc[col] = list.filter((x) => x !== id);
      renderXcorr(); writeHash();
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
  if (!X.length || !Y.length) { $("xc-matrix").innerHTML = `<p class="hint" style="padding:12px">Choose at least one variable in each column.</p>`; return; }
  $("xc-matrix").innerHTML = `<p class="hint" style="padding:12px">Loading…</p>`;
  const data = new Map();
  for (const id of new Set([...X, ...Y])) data.set(id, await xcData(id));
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
  drawXcMatrix(X.map((id) => byId.get(id)), Y.map((id) => byId.get(id)), data, seasons);
  const src = hmeta.sources[xc.source];
  const span = xc.mode === "one" ? seasonText({ year: +wy, season: ws }) : xc.mode === "range" ? `${xc.cal}s ${xc.y0}–${xc.y1}` : "all seasons, all years";
  $("xc-note").textContent = `Each point: one station in one season (${xc.lines === "all" ? "core lines 76.7–93.3" : `line ${xc.lines}`}; ${span}${xc.lag ? "; rows one season after columns" : ""}). ` +
    `Hydrography: 0–${XC_DEPTH} m mean of ${src.label} casts reaching ${XC_DEPTH} m (pH: CTD only). Species: log₁₀(1 + abundance), standard sampling, ` +
    `larvae in the bongo net, krill adults. SCTI: one value per season for every station. r: Pearson correlation; line: least squares.`;
}

function drawXcMatrix(X, Y, data, seasons) {
  const box = $("xc-matrix");
  const W = box.clientWidth || 800, H = box.clientHeight || 700;
  const m = { l: 56, b: 40, t: 8, r: 8 };
  // each cell keeps room on its left for its y range and below for its x range
  const cw = (W - m.l - m.r) / X.length, ch = (H - m.t - m.b) / Y.length, gapL = 34, gapB = 16;
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';
  const parts = [];
  const range = (vals) => { let lo = Math.min(...vals), hi = Math.max(...vals); if (!(hi > lo)) { lo -= 0.5; hi += 0.5; } const p = (hi - lo) * 0.05; return [lo - p, hi + p]; };
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  Y.forEach((vy, j) => {
    X.forEach((vx, i) => {
      const x0 = m.l + i * cw + gapL, y0 = m.t + j * ch, w = cw - gapL - 6, h = ch - gapB - 4;
      const pts = xcPairs(data.get(vx.id), data.get(vy.id), vx.id, vy.id, seasons);
      parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fbfaf8" stroke="#dcdad3"/>`);
      if (pts.length < 3) {
        parts.push(`<text x="${x0 + w / 2}" y="${y0 + h / 2}" text-anchor="middle" font-size="11" fill="#85837c" ${font}>${pts.length ? `${pts.length} pairs` : "no pairs"}</text>`);
        return;
      }
      const [ax, bx] = range(pts.map((p) => p[0])), [ay, by] = range(pts.map((p) => p[1]));
      const px = (v) => x0 + ((v - ax) / (bx - ax)) * w, py = (v) => y0 + h - ((v - ay) / (by - ay)) * h;
      const rad = pts.length > 2000 ? 1.2 : pts.length > 300 ? 1.8 : 2.6, op = pts.length > 2000 ? 0.25 : pts.length > 300 ? 0.4 : 0.65;
      parts.push(`<g fill="#2a78d6" fill-opacity="${op}">` + pts.map(([x, y]) => `<circle cx="${px(x).toFixed(1)}" cy="${py(y).toFixed(1)}" r="${rad}"/>`).join("") + "</g>");
      const f = pearson(pts);
      if (f) {
        const ya = f.my + f.slope * (ax - f.mx), yb = f.my + f.slope * (bx - f.mx);
        parts.push(`<clipPath id="xc-c${i}-${j}"><rect x="${x0}" y="${y0}" width="${w}" height="${h}"/></clipPath>`);
        parts.push(`<line x1="${px(ax)}" y1="${py(ya)}" x2="${px(bx)}" y2="${py(yb)}" stroke="#c0392b" stroke-width="1.4" clip-path="url(#xc-c${i}-${j})"/>`);
      }
      parts.push(`<text x="${x0 + 5}" y="${y0 + 13}" font-size="11" font-weight="700" fill="${f && Math.abs(f.r) >= 0.5 ? "#c0392b" : "#1f1e1c"}" ${font} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">r = ${f ? f.r.toFixed(2) : "–"}</text>`);
      parts.push(`<text x="${x0 + 5}" y="${y0 + 25}" font-size="10" fill="#5b5a55" ${font} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">n = ${pts.length}</text>`);
      // axis extremes
      parts.push(`<text x="${x0}" y="${y0 + h + 11}" font-size="9" fill="#85837c" ${font}>${fmt(ax)}</text><text x="${x0 + w}" y="${y0 + h + 11}" text-anchor="end" font-size="9" fill="#85837c" ${font}>${fmt(bx)}</text>`);
      parts.push(`<text x="${x0 - 3}" y="${y0 + h}" text-anchor="end" font-size="9" fill="#85837c" ${font}>${fmt(ay)}</text><text x="${x0 - 3}" y="${y0 + 8}" text-anchor="end" font-size="9" fill="#85837c" ${font}>${fmt(by)}</text>`);
    });
  });
  const name = (v) => `${v.label}${v.units ? ` (${v.units})` : ""}`;
  X.forEach((vx, i) => parts.push(`<text x="${m.l + i * cw + gapL + (cw - gapL - 6) / 2}" y="${H - m.b + 24}" text-anchor="middle" font-size="11" font-weight="600" fill="#1f1e1c" ${font}>${name(vx)}</text>`));
  Y.forEach((vy, j) => parts.push(`<text transform="translate(${m.l - 14} ${m.t + j * ch + (ch - gapB - 4) / 2}) rotate(-90)" text-anchor="middle" font-size="11" font-weight="600" fill="#1f1e1c" ${font}>${name(vy)}${xc.lag ? " (+1 season)" : ""}</text>`));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Scatterplot matrix">${parts.join("")}</svg>`;
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
  const ids = (k) => (params.get(k) || "").split(",").filter((x) => /^(t|s|chl|no3|o|ph|scti|[fk]:\d+)$/.test(x)).slice(0, XC_MAX_VARS);
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

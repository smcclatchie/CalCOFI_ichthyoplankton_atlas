// EDA view: upper-ocean heat content, El Nino vs. non-ENSO marine heatwaves
// (2026-10-17, user; EDA list item 2). For one CalCOFI core line and source:
//
//  - a time series, season by season, of the 0-200 m heat-content anomaly
//    averaged over the line's stations, with the Relative Oceanic Nino Index
//    (RONI, NOAA CPC; docs/data/roni.json, build_roni.py) on a second axis,
//    El Nino seasons (RONI >= +0.5) shaded, and non-ENSO warm seasons marked:
//    heat-content anomaly above +1 standard deviation of the series while RONI
//    is below +0.5 (a working definition of a marine heatwave, to revisit);
//  - three temperature-anomaly sections side by side, drawn exactly as the
//    map's anomaly sections (section.js computeSection / drawSectionSVG), for
//    three seasons chosen to compare (by default the 1997-98 El Nino, the
//    "Blob" in autumn 2014 and the 2015-16 El Nino), sharing one symmetric colour
//    scale, with the 200 m heat-content depth marked.
//
// Heat-content anomaly at a station = rho * cp * integral over 0-200 m of the
// temperature anomaly (each standard depth minus its harmonic seasonal cycle,
// as the Anomalies view and anomaly sections: section.js sectionAnomalies),
// trapezoidal over the standard depths; rho cp = 1025 * 3990 J m^-3 K^-1;
// in GJ m^-2. A station counts when its anomaly profile starts within 10 m of
// the surface and reaches 200 m; a season needs HEAT_MIN_STATIONS of them.
// A season's value at a station is the mean of its survey months.
"use strict";

const HEAT_DEPTH = 200;
const HEAT_RHO_CP = 1025 * 3990;            // J m^-3 K^-1
const HEAT_MIN_STATIONS = 3;
// The 1997-98 El Nino, the "Blob" at its non-ENSO peak (autumn 2014: by winter 2015 RONI had reached
// +0.54, El Nino by the definition here), the 2015-16 El Nino.
const HEAT_DEFAULTS = ["1998-winter", "2014-autumn", "2016-winter"];
const HEAT_VAR = { label: "Temperature anomaly", units: "°C", col: "t", style: "temperature", anomaly: true, diverging: true };
const heat = { line: 90, source: "bottle", panels: HEAT_DEFAULTS.slice(), focus: 0, ready: false, token: 0, roni: null };
const heatSeriesCache = new Map();

// Seasons with temperature on this line: [{ key, season, year, periods }], in order.
function heatSeasons(d, src) {
  const groups = new Map();
  for (const [p, rows] of d.byPeriod) {
    if (!rows.some((i) => d.t?.[i] !== null && d.t?.[i] !== undefined)) continue;
    const x = src.periods[p], season = SEASON_OF_MONTH[x.month], year = x.year + (x.month === 12 ? 1 : 0);
    const key = `${year}-${season}`;
    if (!groups.has(key)) groups.set(key, { key, season, year, periods: [] });
    groups.get(key).periods.push(p);
  }
  const order = ["winter", "spring", "summer", "autumn"];
  return [...groups.values()].sort((a, b) => a.year - b.year || order.indexOf(a.season) - order.indexOf(b.season));
}

// A season's middle (decimal year): mid-January for winter (Dec-Feb), mid-April for spring, ...
const heatTime = (s) => (s.season === "winter" ? s.year + 0.5 / 12 : s.year + (SEASON_FIRST_MONTH[s.season] + 0.5) / 12);

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
  return vals.length >= HEAT_MIN_STATIONS ? { hc: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
}

function heatSeries(d, geo, src, lineKey) {
  if (heatSeriesCache.has(lineKey)) return heatSeriesCache.get(lineKey);
  const steps = heatSeasons(d, src);
  const series = [];
  for (const s of steps) {
    const r = heatContent(d, geo, src, lineKey, s);
    if (r) series.push({ ...s, t: heatTime(s), hc: r.hc, n: r.n, roni: heat.roni.seasons[s.key] ?? null });
  }
  const mean = series.reduce((a, b) => a + b.hc, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b.hc - mean) ** 2, 0) / series.length);
  for (const r of series) r.mhw = r.hc > sd && r.roni !== null && r.roni < 0.5;      // anomalies: mean ~0, so > +1 SD
  const out = { steps, series, sd };
  heatSeriesCache.set(lineKey, out);
  return out;
}

function setupEdaHeat() {
  if (heat.ready) return;
  heat.ready = true;
  $("heat-line").innerHTML = hmeta.sectionLines.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
  $("heat-line").addEventListener("change", (e) => { heat.line = Number(e.target.value); renderEdaHeat(); writeHash(); });
  document.querySelectorAll("#heat-source button").forEach((b) => b.addEventListener("click", () => {
    heat.source = b.dataset.value; renderEdaHeat(); writeHash();
  }));
  document.querySelectorAll("#heat-panels .heat-panel").forEach((box, n) => {
    box.querySelector("select").addEventListener("change", (e) => { heat.panels[n] = e.target.value; heat.focus = n; renderEdaHeat(); writeHash(); });
    box.querySelector("h3").addEventListener("click", () => { heat.focus = n; markHeatFocus(); });
  });
}

function markHeatFocus() {
  document.querySelectorAll("#heat-panels .heat-panel").forEach((b, n) => b.classList.toggle("focus", n === heat.focus));
}

async function renderEdaHeat() {
  await loadHydroMeta();
  setupEdaHeat();
  if (!heat.roni) heat.roni = await getJSON("roni.json");
  const token = ++heat.token;
  setToggle("heat-source", heat.source);
  $("heat-line").value = String(heat.line);
  const src = hmeta.sources[heat.source], lineKey = `${heat.source}/line${heat.line}`;
  const d = await loadSection(lineKey);
  if (token !== heat.token) return;
  const geo = lineGeometry(d, src, heat.line);
  if (!geo) { $("heat-chart").innerHTML = `<p class="hint">No stations on line ${heat.line}.</p>`; return; }
  const { steps, series, sd } = heatSeries(d, geo, src, lineKey);
  drawHeatChart(series, sd, src);
  // the three comparison sections, on one symmetric scale
  const keys = new Set(steps.map((s) => s.key));
  heat.panels = heat.panels.map((k, n) => (keys.has(k) ? k : nearestHeatKey(steps, k) || HEAT_DEFAULTS[n]));
  const secs = heat.panels.map((k) => {
    const step = steps.find((s) => s.key === k);
    return step ? computeSection(d, geo, HEAT_VAR, step.periods, null, src, lineKey) : null;
  });
  const m = Math.max(0.5, ...secs.filter((s) => s && s.ok).map((s) => Math.max(...s.values.map(Math.abs))));
  const top = Math.ceil(m * 2) / 2, fixed = { lo: -top, hi: top, maps: 0 };
  document.querySelectorAll("#heat-panels .heat-panel").forEach((box, n) => {
    const step = steps.find((s) => s.key === heat.panels[n]);
    const sel = box.querySelector("select");
    if (sel.dataset.for !== lineKey) {
      sel.innerHTML = steps.map((s) => `<option value="${s.key}">${seasonText(s)}</option>`).join("");
      sel.dataset.for = lineKey;
    }
    sel.value = heat.panels[n];
    const r = series.find((x) => x.key === heat.panels[n]);
    box.querySelector(".heat-stats").textContent = r
      ? `heat content ${signedValue(+r.hc.toFixed(2))} GJ m⁻² · RONI ${r.roni === null ? "–" : signedValue(r.roni)}${r.roni >= 0.5 ? " (El Niño)" : r.mhw ? " (non-ENSO warm)" : ""}`
      : "too few full-depth stations for heat content";
    const chart = box.querySelector(".heat-plot");
    const sec = step && computeSection(d, geo, HEAT_VAR, step.periods, fixed, src, lineKey);
    if (!sec || !sec.ok) { chart.innerHTML = `<p class="hint" style="padding:8px">Too few of line ${heat.line}'s stations with a climatology were sampled in ${step ? seasonText(step) : "this season"}.</p>`; return; }
    drawSectionSVG(chart, sec, { fit: "width", id: `heat-sec-${n}`, line: heat.line, depthMark: [HEAT_DEPTH, HEAT_DEPTH], note: false });
  });
  markHeatFocus();
  $("heat-note").textContent = `Heat-content anomaly, 0–${HEAT_DEPTH} m, mean over line ${heat.line}'s stations (${src.label}); temperature anomalies from each ` +
    `station's harmonic seasonal cycle at each depth (${ANOMALY_MIN_YEARS}+ years). Orange: non-ENSO warm seasons (above +1 SD, ` +
    `${sd.toFixed(2)} GJ m⁻², with RONI below +0.5). Sections: temperature anomaly on one scale (±${top} °C); blue mark: ${HEAT_DEPTH} m. ` +
    `Click the time series to show a season in the outlined panel (click a panel's title to choose it).`;
}

function nearestHeatKey(steps, key) {
  if (!steps.length) return null;
  const [y, se] = (key || "").split("-");
  const want = heatTime({ year: +y, season: se || "winter" });
  return steps.reduce((b, s) => (Math.abs(heatTime(s) - want) < Math.abs(heatTime(b) - want) ? s : b)).key;
}

function drawHeatChart(series, sd, src) {
  const box = $("heat-chart");
  const W = box.clientWidth || 900, H = box.clientHeight || 220;
  const m = { l: 60, r: 56, t: 14, b: 26 };
  if (!series.length) { box.innerHTML = `<p class="hint">No seasons with enough full-depth stations.</p>`; return; }
  const x0 = Math.floor(series[0].t) - 0.5, x1 = Math.ceil(series[series.length - 1].t) + 0.5;
  const hmax = Math.max(0.2, ...series.map((r) => Math.abs(r.hc))), hTop = Math.ceil(hmax * 4) / 4;
  const roniVals = Object.values(heat.roni.seasons), rTop = Math.ceil(Math.max(...roniVals.map(Math.abs)) * 2) / 2;
  const sx = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (v) => m.t + ((hTop - v) / (2 * hTop)) * (H - m.t - m.b);
  const sr = (v) => m.t + ((rTop - v) / (2 * rTop)) * (H - m.t - m.b);
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"', tick = `font-size="10" fill="#5b5a55" ${font}`;
  const parts = [`<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="#fbfaf8"/>`];
  // El Nino seasons (RONI >= +0.5): shaded
  for (const [key, r] of Object.entries(heat.roni.seasons)) {
    if (r < 0.5) continue;
    const [y, se] = key.split("-"), t = heatTime({ year: +y, season: se });
    if (t < x0 || t > x1) continue;
    parts.push(`<rect x="${sx(t - 0.125)}" y="${m.t}" width="${Math.max(1, sx(t + 0.125) - sx(t - 0.125))}" height="${H - m.t - m.b}" fill="${r >= 1.5 ? "#e8b4a8" : "#f3d7cf"}"/>`);
  }
  // axes
  for (let v = -hTop; v <= hTop + 1e-9; v += hTop / 2) {
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}" stroke="${Math.abs(v) < 1e-9 ? "#85837c" : "#ecebe6"}"/>`);
    parts.push(`<text x="${m.l - 6}" y="${sy(v) + 3.5}" text-anchor="end" ${tick}>${signedValue(+v.toFixed(2))}</text>`);
  }
  for (let v = -rTop; v <= rTop + 1e-9; v += rTop / 2) parts.push(`<text x="${W - m.r + 6}" y="${sr(v) + 3.5}" ${tick}>${signedValue(+v.toFixed(1))}</text>`);
  parts.push(`<text transform="translate(${m.l - 44} ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" ${tick}>heat content anomaly (GJ m⁻²)</text>`);
  parts.push(`<text transform="translate(${W - 10} ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" ${tick}>RONI</text>`);
  for (let yr = Math.ceil(x0 / 10) * 10; yr <= x1; yr += 10) parts.push(`<text x="${sx(yr)}" y="${H - 8}" text-anchor="middle" ${tick}>${yr}</text>`);
  // RONI: a thin dark line over the seasons shown
  const rpts = Object.entries(heat.roni.seasons).map(([k, r]) => { const [y, se] = k.split("-"); return [heatTime({ year: +y, season: se }), r]; })
    .filter(([t]) => t >= x0 && t <= x1).sort((a, b) => a[0] - b[0]);
  parts.push(`<path d="M${rpts.map(([t, r]) => `${sx(t).toFixed(1)},${sr(r).toFixed(1)}`).join("L")}" fill="none" stroke="#2b2a27" stroke-width="1" opacity="0.7"/>`);
  // heat content: bars, warm red / cool blue, non-ENSO warm seasons orange
  const bw = Math.max(1.5, (sx(0.25) - sx(0)) * 0.8);
  for (const r of series) {
    const y0 = sy(0), y = sy(r.hc), color = r.mhw ? "#f08c00" : r.hc >= 0 ? "#c0392b" : "#2f6fb0";
    parts.push(`<rect x="${sx(r.t) - bw / 2}" y="${Math.min(y, y0)}" width="${bw}" height="${Math.max(0.5, Math.abs(y - y0))}" fill="${color}" opacity="0.9"/>`);
  }
  // the panels' seasons: A, B, C
  heat.panels.forEach((k, n) => {
    const r = series.find((x) => x.key === k);
    if (!r) return;
    parts.push(`<line x1="${sx(r.t)}" x2="${sx(r.t)}" y1="${m.t}" y2="${H - m.b}" stroke="#2a78d6" stroke-dasharray="3 2"/>`);
    parts.push(`<text x="${sx(r.t)}" y="${m.t + 10}" text-anchor="middle" font-size="11" font-weight="700" fill="#2a78d6" ${font}>${"ABC"[n]}</text>`);
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Heat content anomaly and RONI">${parts.join("")}</svg>`;
  const svg = box.querySelector("svg"), tip = document.createElement("div");
  tip.className = "chart-tip"; tip.hidden = true; box.appendChild(tip);
  const nearest = (e) => {
    const r = svg.getBoundingClientRect(), t = x0 + ((e.clientX - r.left - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const best = series.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
    return Math.abs(best.t - t) < 0.4 ? best : null;
  };
  svg.addEventListener("mousemove", (e) => {
    const s = nearest(e);
    if (!s) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${seasonText(s)}: ${signedValue(+s.hc.toFixed(2))} GJ m⁻² (${s.n} stations) · RONI ${s.roni === null ? "–" : signedValue(s.roni)}${s.mhw ? " · non-ENSO warm" : ""}`;
    const r = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, sx(s.t) - tip.offsetWidth / 2))}px`;
    tip.style.top = `${m.t}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
  svg.style.cursor = "pointer";
  svg.addEventListener("click", (e) => {
    const s = nearest(e);
    if (!s) return;
    heat.panels[heat.focus] = s.key;
    renderEdaHeat();
    writeHash();
  });
}

function writeEdaHeatHash(params) {
  params.set("hline", heat.line);
  params.set("hsrc", heat.source);
  params.set("hp", heat.panels.join(","));
}

function readEdaHeatHash(params) {
  if (SECTION_LINE_CHOICES.includes(Number(params.get("hline")))) heat.line = Number(params.get("hline"));
  if (["bottle", "ctd"].includes(params.get("hsrc"))) heat.source = params.get("hsrc");
  const p = (params.get("hp") || "").split(",").filter((k) => /^\d{4}-(winter|spring|summer|autumn)$/.test(k));
  if (p.length === 3) heat.panels = p;
}

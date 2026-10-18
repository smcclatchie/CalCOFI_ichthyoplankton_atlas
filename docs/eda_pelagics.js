// EDA view: small pelagic fish -- larval abundance and larval range of Pacific
// sardine, northern anchovy and Pacific mackerel (2026-10-18, user; EDA list
// item 5), for two questions:
//
//  1. Relative abundance of the three species: successional peaks? -- the
//     annual time series (log abundance, or standardised to compare shapes),
//     and the between-species cross-correlations.
//  2. MacCall's basin hypothesis: does the range expand as abundance rises? --
//     per species, abundance against range (kernel density of presence) and
//     their cross-correlation at lags of -5..+5 years.
//
// Data and method: python/build_eda_pelagics.py -> data/eda_pelagics.json (each
// species' spawning-season cruises with broad core-grid coverage, annual means;
// range = area of the 90% kernel-density region of tows with larvae; r with
// Pyper & Peterman effective N). The cruises used are marked under the time
// series' axis, one row per species, start to end.
"use strict";

const pel = { data: null, scale: "log", ready: false };
const PEL_X0 = 1951, PEL_X1 = 2025;
const pelFont = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';
const pelTick = `font-size="10" fill="#5b5a55" ${pelFont}`;
const pelEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pelFrac = (iso) => { const d = new Date(iso + "T00:00:00Z"); const y = d.getUTCFullYear(); return y + (d - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); };
const pelLog = (a) => Math.log10(a + 1);
const pelCount = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));

async function loadPelagics() {
  if (!pel.data) [pel.data, pel.roni] = await Promise.all(["data/eda_pelagics.json", "data/roni.json"].map(async (u) => (await fetch(u)).json()));
  return pel.data;
}

function setupPelagics() {
  if (pel.ready) return;
  pel.ready = true;
  $("pel-close").addEventListener("click", () => setEda(false));
  document.querySelectorAll("#pel-scale button").forEach((b) => b.addEventListener("click", () => {
    pel.scale = b.dataset.value;
    renderPelagics();
    writeHash();
  }));
}

async function renderPelagics() {
  setupPelagics();
  const d = await loadPelagics();
  setToggle("pel-scale", pel.scale);
  // the species are named in their own panels; the key explains the El Nino lines
  $("pel-key").innerHTML = `<span class="pel-key-item"><i class="pel-nino-weak"></i>El Niño winter (Dec–Feb RONI ≥ +0.5)</span>` +
    `<span class="pel-key-item"><i class="pel-nino-strong"></i>strong (≥ +1.5)</span>`;
  // the note first: its height sets the charts' heights
  const a = d.area;
  $("pel-note").textContent = `Larvae per 10 m² (standard oblique net: ring net to 1977, bongo from 1978), core grid of lines ` +
    `${a.lines[0]}–${a.lines[a.lines.length - 1]} (${a.gridStations} stations, ${Math.round(a.areaKm2 / 1000)}k km²). Each species uses the cruises ` +
    `(survey months) of its spawning season covering ≥ ${Math.round(a.minCoverage * 100)}% of the grid, marked under the axis; annual values ` +
    `average those cruises. Range: area holding ${Math.round(a.kdeLevel * 100)}% of a kernel density (${a.kdeBandwidthKm} km) of tows with larvae. ` +
    `Black lines: least-squares regression of range (y, 1000 km²) on log abundance (x, larvae per 10 m²). Vertical lines: El Niño winters (Dec–Feb RONI ≥ +0.5; solid ≥ +1.5), at the year they end. r: Pearson, log abundance vs range (or species vs species, log abundances), range lagging by the years shown; dashed: 5% significance allowing for ` +
    `autocorrelation (Pyper & Peterman 1998). MacCall's basin hypothesis: range grows with abundance (cf. Saraux et al. 2014).`;
  drawPelSeries($("pel-chart"), d);
  drawPelPanels($("pel-panels"), d);
}

// ---- the time series: one panel per species (user, 2026-10-18: overlaid lines were confusing) --
// El Nino winters as vertical reference lines (user): Dec-Feb RONI >= +0.5 (data/roni.json),
// drawn through the year the winter ends in -- the spawning season that follows it; strong ones
// (>= +1.5) darker and labelled.
function drawPelSeries(box, d) {
  const W = box.clientWidth || 900, H = Math.max(300, box.clientHeight || 420);
  const z = pel.scale === "z", n = d.species.length;
  const m = { l: 64, r: 14, t: 14, b: 34 };
  const gap = 18, rowH = 7;                                // a cruise row under each panel, then a gap
  const ph = (H - m.t - m.b - n * (rowH + 4) - (n - 1) * gap) / n, pw = W - m.l - m.r;
  const sx = (t) => m.l + ((t - PEL_X0) / (PEL_X1 - PEL_X0)) * pw;
  const parts = [];
  const top = (i) => m.t + i * (ph + rowH + 4 + gap);
  const bottom = top(n - 1) + ph;
  // El Nino lines, behind everything, through all three panels
  const nino = Object.entries(pel.roni.seasons).filter(([k, r]) => k.endsWith("-winter") && r >= 0.5)
    .map(([k, r]) => [+k.slice(0, 4), r]).filter(([y]) => y >= PEL_X0 && y <= PEL_X1);
  for (const [y, r] of nino) {
    const strong = r >= 1.5, x = sx(y + 0.5);
    for (let i = 0; i < n; i++) {
      parts.push(`<line x1="${x}" x2="${x}" y1="${top(i)}" y2="${top(i) + ph}" stroke="${strong ? "#6f6d66" : "#b9b7b0"}" stroke-width="${strong ? 1.6 : 1}" stroke-dasharray="${strong ? "none" : "3 2"}"><title>El Niño winter ${y - 1}–${String(y).slice(2)}: RONI ${r > 0 ? "+" : ""}${r}</title></line>`);
    }
    if (strong) parts.push(`<text x="${x}" y="${m.t - 3}" text-anchor="middle" font-size="9" font-weight="600" fill="#6f6d66" ${pelFont}>${y - 1}–${String(y).slice(2)}</text>`);
  }
  d.species.forEach((sp, i) => {
    const t0 = top(i);
    let v = sp.years.map((r) => [r.year, pelLog(r.abundance)]);
    if (z) {                                               // z-score of log abundance, 3-year running mean
      const vals = v.map((p) => p[1]), mu = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length) || 1;
      const byYear = new Map(v.map(([y, x]) => [y, (x - mu) / sd]));
      v = v.map(([y]) => { const w = [y - 1, y, y + 1].filter((k) => byYear.has(k)).map((k) => byYear.get(k)); return [y, w.reduce((a, b) => a + b, 0) / w.length]; });
    }
    const zMax = Math.max(2.5, Math.ceil(Math.max(...v.map((p) => Math.abs(p[1]))) * 2) / 2);   // symmetric, fitted to the panel's data
    const lo = z ? -zMax : 0, hi = z ? zMax : Math.max(0.5, Math.ceil(Math.max(...v.map((p) => p[1])) * 2) / 2);
    const sy = (x) => t0 + ph - ((x - lo) / (hi - lo)) * ph;
    parts.unshift(`<rect x="${m.l}" y="${t0}" width="${pw}" height="${ph}" fill="#fbfaf8" stroke="#dcdad3"/>`);
    if (z) {
      for (let g = -Math.floor(zMax); g <= Math.floor(zMax); g++) {
        parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${sy(g)}" y2="${sy(g)}" stroke="${g === 0 ? "#85837c" : "#ecebe6"}" stroke-opacity="${g === 0 ? 1 : 0.8}"/>`);
        if (g % 2 === 0) parts.push(`<text x="${m.l - 6}" y="${sy(g) + 3.5}" text-anchor="end" ${pelTick}>${g > 0 ? "+" : ""}${g}</text>`);
      }
    } else {
      const ticks = [0, 1, 10, 100, 1000, 10000, 100000].filter((t) => pelLog(t) <= hi + 1e-9);
      for (const t of ticks) {
        parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${sy(pelLog(t))}" y2="${sy(pelLog(t))}" stroke="${t === 0 ? "#85837c" : "#ecebe6"}"/>`);
        parts.push(`<text x="${m.l - 6}" y="${sy(pelLog(t)) + 3.5}" text-anchor="end" ${pelTick}>${pelCount(t)}</text>`);
      }
    }
    // the species' name, inside the panel's top left
    parts.push(`<text x="${m.l + 6}" y="${t0 + 13}" font-size="11" font-weight="700" fill="${sp.color}" ${pelFont} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">${pelEsc(sp.name)} <tspan font-weight="400" fill="#5b5a55">(${sp.season[0]}–${sp.season[sp.season.length - 1]} cruises)</tspan></text>`);
    let path = "";
    v.forEach(([y, x], k) => { path += `${k && v[k - 1][0] === y - 1 ? "L" : "M"}${sx(y + 0.5).toFixed(1)},${sy(x).toFixed(1)}`; });
    parts.push(`<path d="${path}" fill="none" stroke="${sp.color}" stroke-width="1.8" stroke-linejoin="round"/>`);
    v.forEach(([y, x], k) => {
      const r = sp.years[k];
      parts.push(`<circle cx="${sx(y + 0.5)}" cy="${sy(x)}" r="2.3" fill="${sp.color}"><title>${pelEsc(sp.name)} ${y}: ${r.abundance} larvae/10 m², ` +
        `range ${Math.round(r.range / 1000)}k km², ${Math.round(r.positive * 100)}% of tows positive, ${r.cruises} cruise${r.cruises > 1 ? "s" : ""}</title></circle>`);
    });
    // the cruises used, start to end, just under the panel
    const ry = t0 + ph + 3;
    for (const c of sp.cruises) {
      const a = sx(pelFrac(c.start)), b = sx(pelFrac(c.end) + 1 / 365);
      parts.push(`<rect x="${a.toFixed(1)}" y="${ry}" width="${Math.max(1.2, b - a).toFixed(1)}" height="${rowH - 1}" fill="${sp.color}"><title>${pelEsc(sp.name)}: ` +
        `${c.key} cruise, ${c.start} to ${c.end}, ${c.net}, ${Math.round(c.coverage * 100)}% of the grid, ${c.tows} tows</title></rect>`);
    }
    parts.push(`<text x="${m.l - 6}" y="${ry + rowH - 1}" text-anchor="end" font-size="8.5" fill="${sp.color}" ${pelFont}>cruises</text>`);
  });
  const axisLabel = z ? "standardised log abundance (3-yr mean)" : "larvae per 10 m² (log scale)";
  parts.push(`<text transform="translate(${m.l - 46} ${(m.t + bottom) / 2}) rotate(-90)" text-anchor="middle" ${pelTick}>${axisLabel}</text>`);
  const base = bottom + rowH + 4, ly = base + 10;
  for (let yr = PEL_X0; yr <= PEL_X1; yr++) {
    const five = yr % 5 === 0;
    parts.push(`<line x1="${sx(yr)}" x2="${sx(yr)}" y1="${base}" y2="${base + (yr % 10 === 0 ? 4 : 2)}" stroke="#85837c"/>`);
    if (five) parts.push(`<text x="${sx(yr) + 3}" y="${ly}" text-anchor="end" transform="rotate(-45 ${sx(yr) + 3} ${ly})" ${pelTick}>${yr}</text>`);
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Annual larval abundance of sardine, anchovy and Pacific mackerel, one panel each, with El Niño winters">${parts.join("")}</svg>`;
}

// ---- per-species panels and the succession column ---------------------------------
function drawPelPanels(box, d) {
  box.innerHTML = d.species.map((sp) => `<div class="pel-panel"><h3 style="color:${sp.color}">${pelEsc(sp.name)}: abundance vs. range</h3>` +
    `<div class="pel-scatter"></div><div class="pel-ccf"></div></div>`).join("") +
    `<div class="pel-panel"><h3>Succession: species against species</h3><div class="pel-between"></div></div>`;
  const panels = box.querySelectorAll(".pel-panel");
  d.species.forEach((sp, i) => {
    drawPelScatter(panels[i].querySelector(".pel-scatter"), sp);
    drawPelCcf(panels[i].querySelector(".pel-ccf"), sp.ccf, sp.color, "range lag (years)");
  });
  const name = (k) => d.species.find((s) => s.key === k);
  const between = panels[panels.length - 1].querySelector(".pel-between");
  between.innerHTML = d.between.map(() => `<div class="pel-ccf-small"></div>`).join("");
  // one x-axis title, under the bottom chart (user, 2026-10-18: three were cut off)
  const smalls = between.querySelectorAll(".pel-ccf-small");
  smalls.forEach((el, i) => {
    const b = d.between[i], last = i === smalls.length - 1;
    drawPelCcf(el, b.ccf, "#5b5a55", last ? "lag of the second species (years)" : "", `${name(b.a).name} vs ${name(b.b).name}`);
  });
}

function drawPelScatter(box, sp) {
  const W = box.clientWidth || 300, H = Math.max(120, box.clientHeight || 180);
  const m = { l: 44, r: 8, t: 8, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const pts = sp.years.map((r) => [pelLog(r.abundance), r.range / 1000, r]);
  const xHi = Math.ceil(Math.max(...pts.map((p) => p[0])) * 2) / 2 || 1, yHi = Math.ceil(Math.max(...pts.map((p) => p[1])) / 20) * 20 || 20;
  const sx = (v) => m.l + (v / xHi) * pw, sy = (v) => m.t + ph - (v / yHi) * ph;
  const parts = [`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="#fbfaf8" stroke="#dcdad3"/>`];
  for (const v of [0, 1, 10, 100, 1000, 10000]) {
    const x = pelLog(v);
    if (x > xHi + 1e-9) break;
    parts.push(`<line x1="${sx(x)}" x2="${sx(x)}" y1="${m.t + ph}" y2="${m.t + ph + 3}" stroke="#85837c"/><text x="${sx(x)}" y="${m.t + ph + 13}" text-anchor="middle" ${pelTick}>${pelCount(v)}</text>`);
  }
  for (let v = 0; v <= yHi; v += yHi / 4) {
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${sy(v)}" y2="${sy(v)}" stroke="#ecebe6"/><text x="${m.l - 5}" y="${sy(v) + 3.5}" text-anchor="end" ${pelTick}>${Math.round(v)}</text>`);
  }
  parts.push(`<text x="${m.l + pw / 2}" y="${H - 3}" text-anchor="middle" ${pelTick}>larvae per 10 m² (log)</text>`);
  parts.push(`<text transform="translate(${11} ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" ${pelTick}>range (1000 km²)</text>`);
  for (const [x, y, r] of pts) {
    parts.push(`<circle cx="${sx(x)}" cy="${sy(y)}" r="2.6" fill="${sp.color}" fill-opacity="0.6"><title>${r.year}: ${r.abundance} larvae/10 m², range ${Math.round(r.range / 1000)}k km²</title></circle>`);
  }
  // least-squares regression of range on log abundance, as plotted (user, 2026-10-18)
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const slope = sxx > 0 ? sxy / sxx : 0, icpt = my - slope * mx;
  const syy = pts.reduce((a, p) => a + (p[1] - my) ** 2, 0), r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const xa = Math.min(...pts.map((p) => p[0])), xb = Math.max(...pts.map((p) => p[0]));
  parts.push(`<line x1="${sx(xa)}" y1="${sy(icpt + slope * xa)}" x2="${sx(xb)}" y2="${sy(icpt + slope * xb)}" stroke="#ffffff" stroke-width="4" stroke-opacity="0.9"/>`);
  parts.push(`<line x1="${sx(xa)}" y1="${sy(icpt + slope * xa)}" x2="${sx(xb)}" y2="${sy(icpt + slope * xb)}" stroke="#1f1e1c" stroke-width="1.8"/>`);
  parts.push(`<text x="${m.l + 6}" y="${m.t + 37}" font-size="9.5" fill="#1f1e1c" ${pelFont} stroke="#fbfaf8" stroke-width="3" paint-order="stroke">` +
    `y = ${icpt.toFixed(0)} ${slope >= 0 ? "+" : "−"} ${Math.abs(slope).toFixed(0)}·log₁₀(x + 1), R² = ${r2.toFixed(2)}</text>`);
  const c0 = sp.ccf.find((c) => c.lag === 0);
  if (c0 && c0.r !== null) {
    const sig = Math.abs(c0.r) > c0.crit;
    parts.push(`<text x="${m.l + 6}" y="${m.t + 13}" font-size="11" font-weight="700" fill="${sig ? "#c0392b" : "#5b5a55"}" ${pelFont}>r = ${c0.r.toFixed(2)}${sig ? " *" : ""}</text>`);
    parts.push(`<text x="${m.l + 6}" y="${m.t + 25}" font-size="9.5" fill="#5b5a55" ${pelFont}>n = ${c0.n} years (effective ${Math.round(c0.nEff)})</text>`);
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${pelEsc(sp.name)} abundance against range">${parts.join("")}</svg>`;
}

function drawPelCcf(box, ccf, color, xLabel, title) {
  const W = box.clientWidth || 300, H = Math.max(90, box.clientHeight || 120);
  const m = { l: 44, r: 8, t: title ? 20 : 8, b: xLabel ? 27 : 15 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const lags = ccf.map((c) => c.lag), L = Math.max(...lags);
  const sx = (lag) => m.l + ((lag + L + 0.5) / (2 * L + 1)) * pw, sy = (r) => m.t + ph / 2 - (r * ph) / 2;
  const parts = [`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="#fbfaf8" stroke="#dcdad3"/>`];
  if (title) parts.push(`<text x="${m.l}" y="${13}" font-size="10.5" font-weight="600" fill="#1f1e1c" ${pelFont}>${pelEsc(title)}</text>`);
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${sy(v)}" y2="${sy(v)}" stroke="${v === 0 ? "#85837c" : "#ecebe6"}"/><text x="${m.l - 5}" y="${sy(v) + 3.5}" text-anchor="end" ${pelTick}>${v > 0 ? "+" : ""}${v}</text>`);
  }
  const bw = (pw / (2 * L + 1)) * 0.62;
  for (const c of ccf) {
    const x = sx(c.lag);
    if (c.lag % 1 === 0) parts.push(`<text x="${x}" y="${m.t + ph + 12}" text-anchor="middle" ${pelTick}>${c.lag > 0 ? "+" : ""}${c.lag}</text>`);
    if (c.r === null) continue;
    const sig = Math.abs(c.r) > c.crit;
    parts.push(`<rect x="${x - bw / 2}" y="${Math.min(sy(c.r), sy(0))}" width="${bw}" height="${Math.max(0.5, Math.abs(sy(c.r) - sy(0)))}" fill="${color}" fill-opacity="${sig ? 0.95 : 0.35}">` +
      `<title>lag ${c.lag}: r = ${c.r}, n = ${c.n} (effective ${c.nEff}), 5% critical r = ${c.crit}</title></rect>`);
    for (const s of [1, -1]) parts.push(`<line x1="${x - bw / 2 - 2}" x2="${x + bw / 2 + 2}" y1="${sy(s * c.crit)}" y2="${sy(s * c.crit)}" stroke="#1f1e1c" stroke-width="1" stroke-dasharray="2 1.5"/>`);
  }
  if (xLabel) parts.push(`<text x="${m.l + pw / 2}" y="${H - 3}" text-anchor="middle" ${pelTick}>${pelEsc(xLabel)}</text>`);
  parts.push(`<text transform="translate(${11} ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" ${pelTick}>r</text>`);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cross-correlation">${parts.join("")}</svg>`;
}

// Names atlas.js calls.
function writeEdaPelagicsHash(params) { if (pel.scale === "z") params.set("pz", "1"); }
function readEdaPelagicsHash(params) { pel.scale = params.get("pz") === "1" ? "z" : "log"; }

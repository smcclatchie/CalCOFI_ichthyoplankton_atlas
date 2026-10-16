// EDA view: water-mass sections (2026-10-17, user; EDA list item 1, the core
// depths of the water masses). Three sections of one CalCOFI line in a column
// -- North Pacific Central (NPCW), Pacific Subarctic (PSA) and Pacific
// Equatorial (PEW) water fractions, 0-400 m (the depth axis ends at the season's deepest data) -- drawn with the map's section
// code (section.js computeSection / drawSectionSVG), one season at a time,
// with one stepper for all three. Each fills the panel's width (not the map's
// scale) and all three share a fixed 0-100% colour range, so seasons compare.
// The season's value at a station is the mean of its survey months (as the
// map's sections, By season); the top 30 m is greyed (WM_SURFACE_M).
"use strict";

const EDA_SECTION_VARS = ["wm_npcw", "wm_psa", "wm_pew"];
const edaSec = { line: 90, source: "bottle", key: null, timer: 0, ready: false, token: 0 };

// The line's seasons with water-mass data, in order: [{ key, season, year, periods }].
const edaSecSteps = new Map();
function edaSeasons(d, src) {
  const k = `${edaSec.source}/line${edaSec.line}`;
  if (edaSecSteps.has(k)) return edaSecSteps.get(k);
  const groups = new Map();
  for (const [p, rows] of d.byPeriod) {
    if (!rows.some((i) => d.psa?.[i] !== null && d.psa?.[i] !== undefined)) continue;
    const x = src.periods[p], season = SEASON_OF_MONTH[x.month], year = x.year + (x.month === 12 ? 1 : 0);
    const key = `${year}-${season}`;
    if (!groups.has(key)) groups.set(key, { key, season, year, periods: [] });
    groups.get(key).periods.push(p);
  }
  const order = ["winter", "spring", "summer", "autumn"];
  const steps = [...groups.values()].sort((a, b) => a.year - b.year || order.indexOf(a.season) - order.indexOf(b.season));
  edaSecSteps.set(k, steps);
  return steps;
}

function setupEdaSections() {
  if (edaSec.ready) return;
  edaSec.ready = true;
  $("eda-sec-line").innerHTML = hmeta.sectionLines.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
  $("eda-sec-line").addEventListener("change", (e) => { edaStop(); edaSec.line = Number(e.target.value); renderEdaSections(); writeHash(); });
  document.querySelectorAll("#eda-sec-source button").forEach((b) => b.addEventListener("click", () => {
    edaStop(); edaSec.source = b.dataset.value; renderEdaSections(); writeHash();
  }));
  $("eda-sec-prev").addEventListener("click", () => { edaStop(); edaStep(-1); });
  $("eda-sec-next").addEventListener("click", () => { edaStop(); edaStep(1); });
  $("eda-sec-play").addEventListener("click", () => {
    if (edaSec.timer) { edaStop(); return; }
    $("eda-sec-play").textContent = "❚❚ Pause";
    edaSec.timer = setInterval(() => edaStep(1, true), 900);
  });
  $("eda-sec-range").addEventListener("input", (e) => {
    edaStop();
    const steps = edaSecSteps.get(`${edaSec.source}/line${edaSec.line}`) || [];
    if (steps[+e.target.value]) { edaSec.key = steps[+e.target.value].key; renderEdaSections(); writeHash(); }
  });
}

function edaStop() {
  clearInterval(edaSec.timer);
  edaSec.timer = 0;
  if ($("eda-sec-play")) $("eda-sec-play").textContent = "▶ Play";
}

// One season on (delta 1) or back (-1); playing stops at the end.
function edaStep(delta, playing = false) {
  const steps = edaSecSteps.get(`${edaSec.source}/line${edaSec.line}`) || [];
  const i = steps.findIndex((s) => s.key === edaSec.key) + delta;
  if (i < 0 || i >= steps.length) { if (playing) edaStop(); return; }
  edaSec.key = steps[i].key;
  renderEdaSections();
  if (!playing) writeHash();
}

async function renderEdaSections() {
  await loadHydroMeta();
  setupEdaSections();
  const token = ++edaSec.token;
  setToggle("eda-sec-source", edaSec.source);
  $("eda-sec-line").value = String(edaSec.line);
  const src = hmeta.sources[edaSec.source];
  const d = await loadSection(`${edaSec.source}/line${edaSec.line}`);
  if (token !== edaSec.token) return;
  const steps = edaSeasons(d, src);
  if (!steps.length) { $("eda-sec-charts").innerHTML = `<p class="hint">No water-mass data on line ${edaSec.line} (${src.label}).</p>`; return; }
  let i = steps.findIndex((s) => s.key === edaSec.key);
  if (i < 0) {             // the nearest season (a new line or source), else the latest
    const t = (s) => s.year * 4 + ["winter", "spring", "summer", "autumn"].indexOf(s.season);
    const [y, se] = (edaSec.key || "").split("-");
    const want = edaSec.key ? t({ year: +y, season: se }) : Infinity;
    i = steps.reduce((b, s, n) => (Math.abs(t(s) - want) < Math.abs(t(steps[b]) - want) ? n : b), steps.length - 1);
  }
  const step = steps[i];
  edaSec.key = step.key;
  $("eda-sec-range").max = String(steps.length - 1);
  $("eda-sec-range").value = String(i);
  $("eda-sec-when").textContent = seasonText(step);
  const geo = lineGeometry(d, src, edaSec.line);
  const boxes = document.querySelectorAll("#eda-sec-charts .eda-sec-chart");
  let sampled = 0;
  EDA_SECTION_VARS.forEach((key, n) => {
    const hv = hmeta.variables[key];
    const v = { label: hv.label, units: hv.units, col: hv.column, style: key, maxDepth: hv.maxDepth, surface: WM_SURFACE_M, step: 10, fitDepth: true };
    const box = boxes[n];
    box.querySelector("h3").textContent = hv.label;
    const chart = box.querySelector(".eda-sec-plot");
    const sec = geo && computeSection(d, geo, v, step.periods, { lo: 0, hi: 100, maps: 0 }, src);
    if (!sec || !sec.ok) { chart.innerHTML = `<p class="hint" style="padding:8px">Line ${edaSec.line} was not sampled at enough stations in ${seasonText(step)}.</p>`; return; }
    sampled = sec.sampled.size;
    drawSectionSVG(chart, sec, { fit: "width", id: `eda-sec-${n}`, line: edaSec.line, mapDepth: false, note: false });
  });
  $("eda-sec-note").textContent = `Line ${edaSec.line}, ${src.label}: ${sampled} stations sampled in ${seasonText(step)}. ` +
    `Fixed 0–100% colour scale in all panels and seasons; contours every 10%. Grey: no data, or the top ${WM_SURFACE_M} m, ` +
    `where the OMP analysis is not valid. Bograd et al. (2019) extended OMP of T, S, O₂, PO₄, NO₃ and SiO₄.`;
}

function writeEdaSectionsHash(params) {
  params.set("eline", edaSec.line);
  params.set("esrc", edaSec.source);
  if (edaSec.key) params.set("ewhen", edaSec.key);
}

function readEdaSectionsHash(params) {
  if (SECTION_LINE_CHOICES.includes(Number(params.get("eline")))) edaSec.line = Number(params.get("eline"));
  if (["bottle", "ctd"].includes(params.get("esrc"))) edaSec.source = params.get("esrc");
  if (/^\d{4}-(winter|spring|summer|autumn)$/.test(params.get("ewhen") || "")) edaSec.key = params.get("ewhen");
}

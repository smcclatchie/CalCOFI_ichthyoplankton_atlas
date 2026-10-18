// EDA "line view" engine (2026-10-17): the layout shared by the heat-content and
// hypoxia views. For one CalCOFI core line and source (bottle or CTD):
//
//  - a time series, season by season, of one value per season averaged over the
//    line's stations (cfg.seasonValue), as an anomaly from its calendar season
//    (bars, cfg.barColor), with the Relative Oceanic Nino Index (RONI, NOAA CPC)
//    and the Southern California Temperature Index (SCTI, Spray gliders, 50 m on
//    line 90, 2007-) on a second axis (both °C anomalies; docs/data/roni.json,
//    scti.json, python/build_indices.py), El Nino seasons (RONI >= +0.5) shaded
//    grey, and extreme seasons flagged after Hobday et al. (2016, Prog. Oceanogr.
//    141:227-238), adapted to seasons: above the 90th percentile of that calendar
//    season over a 30-year baseline (bottle 1983-2012, CTD 1993-2022; the 5-day
//    minimum is met by a season), in Hobday's categories -- moderate, strong,
//    severe, extreme for 1, 2, 3, 4+ times (threshold - baseline mean) above the
//    mean; one with RONI below +0.5 is "non-ENSO" (◆);
//  - three sections side by side (section.js computeSection / drawSectionSVG,
//    as the map's sections) for three seasons to compare, on one colour scale.
//    Each panel keeps its chosen season whatever the line or source; a season
//    the data lack says so. Draggable A/B/C markers on the time series pick the
//    seasons (no hover pop-up: it hid the data); a click elsewhere moves the
//    outlined panel's marker.
//
// A season's value at a station is the mean of its survey months.
"use strict";

const LV_BASELINE = { bottle: [1983, 2012], ctd: [1993, 2022] };
const LV_CATEGORIES = [null, { name: "moderate", color: "#ffc866" }, { name: "strong", color: "#ff6900" },
  { name: "severe", color: "#9e0000" }, { name: "extreme", color: "#2d0000" }];      // Hobday et al.'s colours
const lvIndices = { roni: null, scti: null };

// A season's middle (decimal year): mid-January for winter (Dec-Feb), mid-April for spring, ...
const lvTime = (s) => (s.season === "winter" ? s.year + 0.5 / 12 : s.year + (SEASON_FIRST_MONTH[s.season] + 0.5) / 12);

// Seasons with data in column col on this line: [{ key, season, year, periods }], in order.
function lvSeasons(d, src, col) {
  const groups = new Map();
  for (const [p, rows] of d.byPeriod) {
    if (!rows.some((i) => d[col]?.[i] !== null && d[col]?.[i] !== undefined)) continue;
    const x = src.periods[p], season = SEASON_OF_MONTH[x.month], year = x.year + (x.month === 12 ? 1 : 0);
    const key = `${year}-${season}`;
    if (!groups.has(key)) groups.set(key, { key, season, year, periods: [] });
    groups.get(key).periods.push(p);
  }
  const order = ["winter", "spring", "summer", "autumn"];
  return [...groups.values()].sort((a, b) => a.year - b.year || order.indexOf(a.season) - order.indexOf(b.season));
}

// cfg: id (element id prefix: <id>-line, -source, -chart, -panels, -note, -close),
// defaults { line, source, panels }, hash { line, source, panels } (link keys),
// col (the column that marks a season as sampled), sectionVar, seasonValue(d, geo,
// src, lineKey, step) -> { value, n, ...extra } | null, anomalySign (+1: value -
// mean; -1: mean - value), axisLabel, caption(r), note(view, ctx), panelScale(secs),
// emptyNote (no seasons), upLabel / downLabel (the time series' top and bottom corners).
function makeLineView(cfg) {
  const view = { line: cfg.defaults.line, source: cfg.defaults.source, panels: cfg.defaults.panels.slice(), focus: 0, ready: false, token: 0 };
  const cache = new Map();
  const el = (s) => $(`${cfg.id}-${s}`);
  const panelBoxes = () => el("panels").querySelectorAll(".lv-panel");

  function series(d, geo, src, lineKey) {
    if (cache.has(lineKey)) return cache.get(lineKey);
    const steps = lvSeasons(d, src, cfg.col), rows = [];
    for (const s of steps) {
      const r = cfg.seasonValue(d, geo, src, lineKey, s);
      if (r) rows.push({ ...s, ...r, t: lvTime(s), roni: lvIndices.roni.seasons[s.key] ?? null, scti: lvIndices.scti.seasons[s.key] ?? null });
    }
    // calendar-season baselines: mean and 90th percentile of the (signed) value
    const [b0, b1] = LV_BASELINE[view.source], clim = {};
    for (const season of ["winter", "spring", "summer", "autumn"]) {
      const v = rows.filter((r) => r.season === season && r.year >= b0 && r.year <= b1).map((r) => cfg.anomalySign * r.value).sort((a, b) => a - b);
      if (v.length < 10) continue;
      const q = (v.length - 1) * 0.9, p90 = v[Math.floor(q)] + (v[Math.ceil(q)] - v[Math.floor(q)]) * (q - Math.floor(q));
      clim[season] = { mean: v.reduce((a, b) => a + b, 0) / v.length, p90, n: v.length };
    }
    for (const r of rows) {
      const c = clim[r.season], x = cfg.anomalySign * r.value;
      r.anom = c ? x - c.mean : null;
      r.cat = c && x > c.p90 ? Math.min(4, Math.max(1, Math.floor((x - c.mean) / (c.p90 - c.mean)))) : 0;
      r.nonEnso = r.cat > 0 && r.roni !== null && r.roni < 0.5;
    }
    const out = { steps, series: rows.filter((r) => r.anom !== null), all: rows, clim, baseline: [b0, b1] };
    cache.set(lineKey, out);
    return out;
  }

  function setup() {
    if (view.ready) return;
    view.ready = true;
    el("line").innerHTML = hmeta.sectionLines.map((l) => `<option value="${l}">Line ${l}</option>`).join("");
    el("line").addEventListener("change", (e) => { view.line = Number(e.target.value); render(); writeHash(); });
    el("source").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { view.source = b.dataset.value; render(); writeHash(); }));
    panelBoxes().forEach((box, n) => {
      box.querySelector("select").addEventListener("change", (e) => { view.panels[n] = e.target.value; view.focus = n; render(); writeHash(); });
      box.querySelector("h3").addEventListener("click", () => { view.focus = n; markFocus(); });
    });
    el("close").addEventListener("click", () => setEda(false));
  }

  const markFocus = () => panelBoxes().forEach((b, n) => b.classList.toggle("focus", n === view.focus));

  async function render() {
    await loadHydroMeta();
    setup();
    if (!lvIndices.roni) [lvIndices.roni, lvIndices.scti] = await Promise.all([getJSON("roni.json"), getJSON("scti.json")]);
    const token = ++view.token;
    setToggle(`${cfg.id}-source`, view.source);
    el("line").value = String(view.line);
    const src = hmeta.sources[view.source], lineKey = `${view.source}/line${view.line}`;
    const d = await loadSection(lineKey);
    if (token !== view.token) return;
    const geo = lineGeometry(d, src, view.line);
    if (!geo) { el("chart").innerHTML = `<p class="hint">No stations on line ${view.line}.</p>`; return; }
    const ctx = series(d, geo, src, lineKey);
    drawChart(ctx.series);
    const steps = ctx.steps;
    const secs = view.panels.map((k) => {
      const step = steps.find((s) => s.key === k);
      return step ? computeSection(d, geo, cfg.sectionVar, step.periods, null, src, lineKey) : null;
    });
    const fixed = cfg.panelScale(secs.filter((s) => s && s.ok));
    panelBoxes().forEach((box, n) => {
      const step = steps.find((s) => s.key === view.panels[n]);
      const sel = box.querySelector("select");
      const [py, pse] = view.panels[n].split("-"), wanted = { key: view.panels[n], year: +py, season: pse };
      const opts = step ? steps : [...steps, wanted].sort((a, b) => lvTime(a) - lvTime(b));
      sel.innerHTML = opts.map((s) => `<option value="${s.key}"${s === wanted ? " disabled" : ""}>${seasonText(s)}${s === wanted ? " (no data)" : ""}</option>`).join("");
      sel.value = view.panels[n];
      const r = ctx.all.find((x) => x.key === view.panels[n]);
      box.querySelector(".lv-stats").textContent = r
        ? cfg.caption(r) + ` · RONI ${r.roni === null ? "–" : signedValue(r.roni)}${r.roni >= 0.5 ? " (El Niño)" : ""}` +
          (r.scti !== null ? ` · SCTI ${signedValue(r.scti)}` : "") + (r.cat ? ` · ${LV_CATEGORIES[r.cat].name} ${cfg.eventName}${r.nonEnso ? ", non-ENSO" : ""}` : "")
        : step ? cfg.tooFew : "";
      const chart = box.querySelector(".lv-plot");
      if (!step) { chart.innerHTML = `<p class="hint" style="padding:8px">No ${src.label.split(" ")[0].toLowerCase()} data on line ${view.line} in ${seasonText(wanted)}.</p>`; return; }
      const sec = computeSection(d, geo, cfg.sectionVar, step.periods, fixed, src, lineKey);
      if (!sec.ok) { chart.innerHTML = `<p class="hint" style="padding:8px">${cfg.sectionTooFew(view, step)}</p>`; return; }
      drawSectionSVG(chart, sec, { fit: "width", id: `${cfg.id}-sec-${n}`, line: view.line, note: false });
    });
    markFocus();
    const nSeasons = Object.keys(ctx.clim).length;
    el("note").textContent = cfg.note(view, src, fixed) + ` ${cfg.eventLabel} (Hobday et al. 2016, adapted to seasons): above the 90th percentile of the calendar season, ` +
      `${ctx.baseline[0]}–${ctx.baseline[1]} baseline${nSeasons < 4 ? ` (${4 - nSeasons} season(s) with too few baseline years: no anomalies)` : ""}; ` +
      `bars coloured by category; ◆ = non-ENSO (RONI below +0.5). Dotted lines A, B, C: the seasons in the panels below; drag one to another ` +
      `season, or click the time series to move the outlined panel's (click a panel's title to outline it).`;
  }

  function drawChart(rows) {
    const box = el("chart");
    const W = box.clientWidth || 900, H = box.clientHeight || 220;
    const m = { l: 60, r: 56, t: 24, b: 40 };      // top: the panels' A/B/C tags; bottom: angled year labels
    if (!rows.length) { box.innerHTML = `<p class="hint">${cfg.emptyNote}</p>`; return; }
    const x0 = Math.floor(rows[0].t) - 0.5, x1 = Math.ceil(rows[rows.length - 1].t) + 0.5;
    const amax = Math.max(cfg.minAxis, ...rows.map((r) => Math.abs(r.anom))), aTop = cfg.niceTop(amax);
    const idx = [...Object.values(lvIndices.roni.seasons), ...Object.values(lvIndices.scti.seasons)], rTop = Math.ceil(Math.max(...idx.map(Math.abs)) * 2) / 2;
    const sx = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (v) => m.t + ((aTop - v) / (2 * aTop)) * (H - m.t - m.b);
    const sr = (v) => m.t + ((rTop - v) / (2 * rTop)) * (H - m.t - m.b);
    const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"', tick = `font-size="10" fill="#5b5a55" ${font}`;
    const parts = [`<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="#fbfaf8"/>`];
    // El Nino seasons (RONI >= +0.5): neutral greys, clear of the category colours
    for (const [key, r] of Object.entries(lvIndices.roni.seasons)) {
      if (r < 0.5) continue;
      const [y, se] = key.split("-"), t = lvTime({ year: +y, season: se });
      if (t < x0 || t > x1) continue;
      parts.push(`<rect x="${sx(t - 0.125)}" y="${m.t}" width="${Math.max(1, sx(t + 0.125) - sx(t - 0.125))}" height="${H - m.t - m.b}" fill="${r >= 1.5 ? "#cdcdcd" : "#e5e5e5"}"/>`);
    }
    for (let v = -aTop; v <= aTop + 1e-9; v += aTop / 2) {
      parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}" stroke="${Math.abs(v) < 1e-9 ? "#85837c" : "#ecebe6"}"/>`);
      parts.push(`<text x="${m.l - 6}" y="${sy(v) + 3.5}" text-anchor="end" ${tick}>${signedValue(+v.toFixed(2))}</text>`);
    }
    for (let v = -rTop; v <= rTop + 1e-9; v += rTop / 2) parts.push(`<text x="${W - m.r + 6}" y="${sr(v) + 3.5}" ${tick}>${signedValue(+v.toFixed(1))}</text>`);
    parts.push(`<text transform="translate(${m.l - 44} ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" ${tick}>${cfg.axisLabel}</text>`);
    parts.push(`<text transform="translate(${W - 10} ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" ${tick}><tspan fill="#1f1e1c" font-weight="600">RONI</tspan>, <tspan fill="#7b2cbf" font-weight="600">SCTI</tspan> (°C)</text>`);
    // what up and down mean (cfg.upLabel / downLabel), inside the plot's left corners
    const corner = `font-size="11" font-weight="600" fill="#5b5a55" ${font} stroke="#fbfaf8" stroke-width="3" paint-order="stroke"`;
    parts.push(`<text x="${m.l + 6}" y="${m.t + 13}" ${corner}>${cfg.upLabel}</text>`);
    parts.push(`<text x="${m.l + 6}" y="${H - m.b - 6}" ${corner}>${cfg.downLabel}</text>`);
    for (let yr = Math.ceil(x0); yr <= x1; yr++) {          // a tick each year, labelled every 5 (angled)
      const five = yr % 5 === 0, ly = H - m.b + 9;
      parts.push(`<line x1="${sx(yr)}" x2="${sx(yr)}" y1="${H - m.b}" y2="${H - m.b + (yr % 10 === 0 ? 7 : five ? 5 : 3)}" stroke="#85837c"/>`);
      if (five) parts.push(`<text x="${sx(yr) + 3}" y="${ly}" text-anchor="end" transform="rotate(-45 ${sx(yr) + 3} ${ly})" ${tick}>${yr}</text>`);
    }
    const occupied = [];                                    // screen points of the lines and bar tops, for the legend's place
    const indexPath = (seasons, color, width) => {          // RONI near-black, SCTI purple
      const pts = Object.entries(seasons).map(([k, r]) => { const [y, se] = k.split("-"); return [lvTime({ year: +y, season: se }), r]; })
        .filter(([t]) => t >= x0 && t <= x1).sort((a, b) => a[0] - b[0]);
      for (const [t, r] of pts) occupied.push([sx(t), sr(r)]);
      if (pts.length) parts.push(`<path d="M${pts.map(([t, r]) => `${sx(t).toFixed(1)},${sr(r).toFixed(1)}`).join("L")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`);
    };
    indexPath(lvIndices.roni.seasons, "#1f1e1c", 2);
    indexPath(lvIndices.scti.seasons, "#7b2cbf", 2.4);
    const bw = Math.max(1.5, (sx(0.25) - sx(0)) * 0.8);
    for (const r of rows) {
      occupied.push([sx(r.t), Math.min(sy(r.anom) - (r.nonEnso ? 10 : 0), sy(0))]);
      const y0 = sy(0), y = sy(r.anom), color = r.cat ? LV_CATEGORIES[r.cat].color : cfg.barColor(r);
      parts.push(`<rect x="${sx(r.t) - bw / 2}" y="${Math.min(y, y0)}" width="${bw}" height="${Math.max(0.5, Math.abs(y - y0))}" fill="${color}"${r.cat ? ' stroke="#3a2a1a" stroke-width="0.4"' : ""}/>`);
      if (r.nonEnso) parts.push(`<path d="M${sx(r.t)} ${y - 9} l3.5 3.5 l-3.5 3.5 l-3.5 -3.5 Z" fill="#1f1e1c"/>`);
    }
    // which line is which (user, 2026-10-18): a legend along the top of the plot, over the bars and
    // lines but under the draggable A/B/C markers, placed where the data reach least high (the
    // stretch whose highest point is lowest), clear of the "Warmer"/"Shallower" corner label
    const legend = [["#1f1e1c", 2, "RONI", "Relative Oceanic Niño Index"], ["#7b2cbf", 2.4, "SCTI", "Southern California Temperature Index"]];
    const lgW = 262, lgH = 38, lgY = m.t + 6;
    let lgX = W - m.r - lgW - 6, best = -Infinity;
    for (let x = m.l + 86; x <= W - m.r - lgW - 6; x += 8) {
      const top = Math.min(H, ...occupied.filter(([px]) => px >= x - 6 && px <= x + lgW + 6).map(([, py]) => py));
      if (top > best + 0.5) { best = top; lgX = x; }
    }
    parts.push(`<rect x="${lgX}" y="${lgY}" width="${lgW}" height="${lgH}" rx="4" fill="#ffffff" fill-opacity="0.88" stroke="#dcdad3"/>`);
    legend.forEach(([color, width, short, long], n) => {
      const ly = lgY + 13 + n * 15;
      parts.push(`<line x1="${lgX + 8}" x2="${lgX + 30}" y1="${ly - 3.5}" y2="${ly - 3.5}" stroke="${color}" stroke-width="${width}"/>`);
      parts.push(`<text x="${lgX + 36}" y="${ly}" font-size="10.5" ${font} fill="#1f1e1c"><tspan font-weight="700" fill="${color}">${short}</tspan> ${long}</text>`);
    });
    // the panels' seasons: a dotted line each, tagged A/B/C above the plot (tags moved apart if close)
    const marks = view.panels.map((k, n) => ({ n, r: rows.find((x) => x.key === k) })).filter((q) => q.r)
      .map((q) => ({ ...q, x: sx(q.r.t) })).sort((a, b) => a.x - b.x);
    let lastTag = -Infinity;
    for (const q of marks) {
      const tx = Math.max(q.x, lastTag + 17);
      lastTag = tx;
      parts.push(`<g class="lv-mark" data-n="${q.n}" data-x="${q.x}" style="cursor:ew-resize">`);
      parts.push(`<line x1="${q.x}" x2="${q.x}" y1="${m.t - 19}" y2="${H - m.b}" stroke="transparent" stroke-width="12"/>`);
      parts.push(`<line x1="${q.x}" x2="${q.x}" y1="${m.t}" y2="${H - m.b}" stroke="#2a78d6" stroke-width="1.2" stroke-dasharray="3 2"/>`);
      if (tx !== q.x) parts.push(`<line x1="${q.x}" x2="${tx}" y1="${m.t}" y2="${m.t - 5}" stroke="#2a78d6"/>`);
      parts.push(`<rect x="${tx - 7}" y="${m.t - 19}" width="14" height="14" rx="3" fill="#2a78d6"/>`);
      parts.push(`<text x="${tx}" y="${m.t - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff" ${font}>${"ABC"[q.n]}</text>`);
      parts.push(`<text class="lv-mark-when" x="${tx + 11}" y="${m.t - 8}" font-size="10" fill="#2a78d6" ${font}></text>`);
      parts.push("</g>");
    }
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${cfg.axisLabel}, RONI and SCTI">${parts.join("")}</svg>`;
    const svg = box.querySelector("svg");
    const seasonAt = (e, any) => {
      const r = svg.getBoundingClientRect(), X = ((e.clientX - r.left) / r.width) * W;
      const t = x0 + ((X - m.l) / (W - m.l - m.r)) * (x1 - x0);
      const best = rows.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
      return any || Math.abs(best.t - t) < 0.4 ? best : null;
    };
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      const g = e.target.closest(".lv-mark");
      if (!g) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      drag = { g, n: +g.dataset.n, x: +g.dataset.x, season: null };
      view.focus = drag.n;
      markFocus();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const s = seasonAt(e, true);
      drag.season = s;
      drag.g.setAttribute("transform", `translate(${sx(s.t) - drag.x} 0)`);
      drag.g.querySelector(".lv-mark-when").textContent = seasonText(s).replace(/ \(.*\)$/, "");
    });
    svg.addEventListener("pointerup", (e) => {
      if (drag) {
        const dd = drag;
        drag = null;
        if (dd.season && dd.season.key !== view.panels[dd.n]) { view.panels[dd.n] = dd.season.key; render(); writeHash(); }
        else dd.g.removeAttribute("transform");
        return;
      }
      const s = seasonAt(e, false);
      if (!s) return;
      view.panels[view.focus] = s.key;
      render();
      writeHash();
    });
  }

  view.render = render;
  view.cache = cache;
  view.writeHash = (params) => {
    params.set(cfg.hash.line, view.line);
    params.set(cfg.hash.source, view.source);
    params.set(cfg.hash.panels, view.panels.join(","));
  };
  view.readHash = (params) => {
    if (SECTION_LINE_CHOICES.includes(Number(params.get(cfg.hash.line)))) view.line = Number(params.get(cfg.hash.line));
    if (["bottle", "ctd"].includes(params.get(cfg.hash.source))) view.source = params.get(cfg.hash.source);
    const p = (params.get(cfg.hash.panels) || "").split(",").filter((k) => /^\d{4}-(winter|spring|summer|autumn)$/.test(k));
    if (p.length === 3) view.panels = p;
  };
  return view;
}

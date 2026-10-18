# build_eda_pelagics.py

"""
The EDA view's small-pelagics analysis (2026-10-18, user): larval abundance
and larval range of Pacific sardine, northern anchovy and Pacific mackerel,
for two questions --

  1. relative abundance of the three species: successional peaks?
  2. MacCall's basin ("dynamic geography") hypothesis: does a species' range
     expand as its abundance rises? (Saraux et al. 2014, PLoS ONE 9:e111211,
     test it as covariation of presence area with biomass.) Species by species,
     as the cross-correlation of annual abundance and range.

-> docs/data/eda_pelagics.json

Design (user's specification, 2026-10-18):
  - Annual time scale, because the species spawn at different times of year.
  - Effort differs between cruises, so each species uses only the cruises of
    its own spawning season that cover the area broadly, and the time series
    marks those cruises' dates.
  - The test is species-specific, because the species spawn in different places.

Data: the atlas's own ichthyoplankton files (docs/data: meta.json,
occupations.json, taxa/<id>.json) -- larvae, standard sampling, the standard
oblique net of the time (CalCOFI 1 m ring net, C1, to 1977; bongo, CB, from
1978; a survey month uses CB if it has any CB tows), per 10 m2. The line-90
pre-release supplement is left out. A "cruise" is one atlas survey period (a
calendar month, all ships), with its start and end dates.

Area: the core grid -- the 65 stations on lines 76.7-93.3 occupied in at least
half the survey months 1985-2019 -- taken geographically (the 1950s-60s grid
used other station numbers): a tow counts when it lies inside the grid's convex
hull or within 30 km of a grid station, and a survey month covers a grid
station when it towed within 30 km of it.

Spawning seasons (from the core-grid monthly climatology, peaks: sardine
April, anchovy February-April, Pacific mackerel May): sardine March-May,
anchovy January-April, Pacific mackerel April-July.

Cruise selection: a species' cruises are the survey months in its spawning
season that cover at least MIN_COVERAGE (70%) of the core grid. Years with none
are gaps.

Annual abundance: per cruise, mean larvae per 10 m2 over its core-grid tows
(zeros included), averaged over the year's selected cruises (the season's
summed abundance divided by its number of cruises, so years with more cruises
-- monthly in the 1950s, quarterly since 1985 -- aren't inflated).

Range: per cruise, a Gaussian kernel density (bandwidth KDE_BW_KM, 40 km) of
the positions of tows with larvae (presence, each tow weighted equally) on a
10 km grid over the core area; the range is the area of the smallest region
holding KDE_LEVEL (90%) of that density, km2 (0 with no larvae). Averaged over
the year's selected cruises, like abundance. Also kept: the fraction of
core-grid tows with larvae (the classical "proportion positive").

Cross-correlation: Pearson r between log10(abundance + 1) and the range (km2,
untransformed: it is a bounded area, and years without larvae have range 0,
which a log would pin far below the rest; 2026-10-18, so r matches the view's
scatterplots and regression lines) at lags -5..+5 years (range in year t + lag against abundance in year t), over
the years both exist. Significance allows for autocorrelation (Pyper &
Peterman 1998, effective sample size from the two series' autocorrelations to
lag N/5); crit = the two-sided 5% critical r for that effective N. The same is
done between species (abundance against abundance) for question 1.

Detection-bias check (2026-10-18, user): a denser year turns more tows
positive even if the larvae occupy the same area, which alone would make range
grow with abundance. Null model: each cruise with larvae is rarefied to the
same expected catch, THIN_N0 (50) larvae, spread over its tows in proportion to
their observed densities (lambda_i = N0 * a_i / sum(a)); a tow is positive with
probability 1 - exp(-lambda_i) (Poisson); the range is recomputed and averaged
over THIN_DRAWS (100) random draws (fixed seed). Every cruise then has the same
detection effort, so a correlation that survives reflects the larvae's spatial
spread, not their total. (Prototype 2026-10-18: N0 = 20, 50, 100 gave nearly
the same r.) Limitation: tows that caught nothing stay at zero, so detection
in the original catches isn't fully undone -- the check is conservative.
Years whose selected cruises caught no larvae have no thinned range and are
left out of both r's compared (observed and thinned, same years).

Usage:  python build_eda_pelagics.py   (after build_atlas_data.py)
"""

import collections
import json
import math
import os

import numpy as np
from matplotlib.path import Path

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO_DIR, "docs", "data")
OUT = os.path.join(DATA, "eda_pelagics.json")

CORE_LINES = {76.7, 80.0, 83.3, 86.7, 90.0, 93.3}
GRID_YEARS = (1985, 2019)          # the quarterly 66-station era, to define the grid
GRID_MIN_SHARE = 0.5               # a grid station: occupied in >= half those survey months
NEAR_KM = 30.0
MIN_COVERAGE = 0.70
KDE_BW_KM = 40.0
KDE_LEVEL = 0.90
CELL_KM = 10.0
MAX_LAG = 5
THIN_N0 = 50
THIN_DRAWS = 100

SPECIES = [
    {"key": "sardine", "name": "Pacific sardine", "scientific": "Sardinops sagax", "id": 7,
     "months": [3, 4, 5], "color": "#2a78d6"},
    {"key": "anchovy", "name": "Northern anchovy", "scientific": "Engraulis mordax", "id": 1,
     "months": [1, 2, 3, 4], "color": "#c0392b"},
    {"key": "mackerel", "name": "Pacific mackerel", "scientific": "Scomber japonicus", "id": 31,
     "months": [4, 5, 6, 7], "color": "#2e8b57"},
]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def convex_hull(pts):
    pts = sorted(map(tuple, pts))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def pearson(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 4 or a.std() == 0 or b.std() == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def autocorr(x, j):
    x = np.asarray(x, float) - np.mean(x)
    return float(np.sum(x[:-j] * x[j:]) / np.sum(x * x)) if j < len(x) else 0.0


def crit_r(n_eff):
    """Two-sided 5% critical Pearson r for an effective sample size."""
    df = max(n_eff - 2, 1)
    # t(0.975, df) by a Cornish-Fisher style approximation (good to ~1e-3 for df >= 3)
    z = 1.959964
    t = z + (z**3 + z) / (4 * df) + (5 * z**5 + 16 * z**3 + 3 * z) / (96 * df**2)
    return t / math.sqrt(t * t + df)


def ccf(years_a, a, years_b, b):
    """r between a(t) and b(t + lag), lags -MAX_LAG..MAX_LAG, with Pyper-Peterman effective N."""
    da, db = dict(zip(years_a, a)), dict(zip(years_b, b))
    out = []
    for lag in range(-MAX_LAG, MAX_LAG + 1):
        pairs = [(da[y], db[y + lag]) for y in sorted(da) if y + lag in db]
        if len(pairs) < 8:
            out.append({"lag": lag, "r": None, "n": len(pairs)})
            continue
        x, y = np.array(pairs).T
        n = len(pairs)
        s = sum((n - j) / n * autocorr(x, j) * autocorr(y, j) for j in range(1, max(2, n // 5) + 1))
        n_eff = min(n, max(3.0, 1.0 / (1.0 / n + 2.0 / n * s)))
        out.append({"lag": lag, "r": round(pearson(x, y), 3), "n": n, "nEff": round(n_eff, 1),
                    "crit": round(crit_r(n_eff), 3)})
    return out


def main():
    meta, occ = load("meta.json"), load("occupations.json")
    periods, stations = meta["periods"], meta["stations"]
    s_std = meta["samplings"].index("standard")
    nets = [n["code"] for n in meta["nets"]]
    C1, CB = nets.index("C1"), nets.index("CB")
    larva = meta["stages"].index("larva")

    # tows by period and net (standard sampling, oblique nets, no pre-release supplement)
    tows = collections.defaultdict(lambda: collections.defaultdict(set))
    for p, s, n, st, c in zip(occ["p"], occ["s"], occ["n"], occ["st"], occ["c"]):
        if s == s_std and n in (C1, CB) and c == -1:
            tows[p][n].add(st)
    net_of = {p: (CB if CB in d else C1) for p, d in tows.items()}

    kx = 111.32 * math.cos(math.radians(33.0))
    pos = {i: (s["lon"] * kx, s["lat"] * 110.57) for i, s in enumerate(stations)}

    # the core grid
    era = [p for p in tows if GRID_YEARS[0] <= periods[p]["year"] <= GRID_YEARS[1]]
    count = collections.Counter(st for p in era for st in tows[p][net_of[p]] if stations[st]["line"] in CORE_LINES)
    grid = sorted(st for st, k in count.items() if k >= GRID_MIN_SHARE * len(era))
    G = np.array([pos[st] for st in grid])
    hull = convex_hull(G)
    hull_path = Path(hull)

    def near_grid(xy):
        return float(np.sqrt(((G - np.asarray(xy)) ** 2).sum(1)).min()) <= NEAR_KM

    in_area = {}
    for p in tows:
        for st in tows[p][net_of[p]]:
            if st not in in_area:
                in_area[st] = bool(hull_path.contains_point(pos[st])) or near_grid(pos[st])

    # KDE grid over the core area
    x0, y0 = hull.min(0) - NEAR_KM
    x1, y1 = hull.max(0) + NEAR_KM
    gx, gy = np.meshgrid(np.arange(x0, x1, CELL_KM), np.arange(y0, y1, CELL_KM))
    cells = np.c_[gx.ravel(), gy.ravel()]
    keep = hull_path.contains_points(cells) | (np.sqrt(((cells[:, None, :] - G[None]) ** 2).sum(-1)).min(1) <= NEAR_KM)
    cells = cells[keep]
    area_km2 = len(cells) * CELL_KM**2

    def kde_range(points):
        if len(points) == 0:
            return 0.0
        X = np.array(points)
        f = np.exp(-((cells[:, None, :] - X[None]) ** 2).sum(-1) / (2 * KDE_BW_KM**2)).sum(1)
        f = np.sort(f)[::-1]
        c = np.cumsum(f) / f.sum()
        return float((np.searchsorted(c, KDE_LEVEL) + 1) * CELL_KM**2)

    # coverage of the grid per survey month
    coverage = {}
    for p in tows:
        X = np.array([pos[st] for st in tows[p][net_of[p]]])
        d = np.sqrt(((G[:, None, :] - X[None]) ** 2).sum(-1)).min(1)
        coverage[p] = float((d <= NEAR_KM).mean())

    rng = np.random.default_rng(20261018)

    def thinned_range(points, densities):
        """Mean KDE range of the cruise rarefied to THIN_N0 expected larvae (None with no larvae)."""
        a = np.asarray(densities, float)
        if a.sum() <= 0:
            return None
        X = np.asarray(points)
        p_pos = 1.0 - np.exp(-THIN_N0 * a / a.sum())
        return float(np.mean([kde_range(X[rng.random(len(a)) < p_pos]) for _ in range(THIN_DRAWS)]))

    result = {"generated": meta.get("generated"), "species": [], "area": {
        "gridStations": len(grid), "areaKm2": round(area_km2), "lines": sorted(CORE_LINES),
        "minCoverage": MIN_COVERAGE, "kdeBandwidthKm": KDE_BW_KM, "kdeLevel": KDE_LEVEL, "nearKm": NEAR_KM,
        "thinN0": THIN_N0, "thinDraws": THIN_DRAWS,
        "hull": [[round(x / kx, 3), round(y / 110.57, 3)] for x, y in hull]}}
    series = {}
    for sp in SPECIES:
        rec = load(f"taxa/{sp['id']}.json")
        ab = collections.defaultdict(float)
        for p, s, n, g, st, a in zip(rec["p"], rec["s"], rec["n"], rec["g"], rec["st"], rec["a"]):
            if s == s_std and g == larva and n == net_of.get(p) and in_area.get(st):
                ab[(p, st)] += a
        cruises, by_year = [], collections.defaultdict(list)
        for p in sorted(tows):
            per = periods[p]
            if per["month"] not in sp["months"] or coverage[p] < MIN_COVERAGE:
                continue
            sts = [st for st in tows[p][net_of[p]] if in_area[st]]
            vals = [ab.get((p, st), 0.0) for st in sts]
            present = [pos[st] for st, v in zip(sts, vals) if v > 0]
            thin = thinned_range([pos[st] for st in sts], vals)
            c = {"key": per["key"], "start": per["start"], "end": per["end"], "net": nets[net_of[p]],
                 "coverage": round(coverage[p], 2), "tows": len(sts),
                 "abundance": round(float(np.mean(vals)), 2), "range": round(kde_range(present)),
                 "positive": round(len(present) / len(sts), 3),
                 "rangeThinned": None if thin is None else round(thin)}
            cruises.append(c)
            by_year[per["year"]].append(c)
        years = sorted(by_year)
        rows = [{"year": y, "cruises": len(by_year[y]),
                 "abundance": round(float(np.mean([c["abundance"] for c in by_year[y]])), 2),
                 "range": round(float(np.mean([c["range"] for c in by_year[y]]))),
                 "positive": round(float(np.mean([c["positive"] for c in by_year[y]])), 3),
                 "rangeThinned": (lambda t: round(float(np.mean(t))) if t else None)(
                     [c["rangeThinned"] for c in by_year[y] if c["rangeThinned"] is not None])} for y in years]
        la = [math.log10(r["abundance"] + 1) for r in rows]
        lr = [r["range"] / 1000.0 for r in rows]
        series[sp["key"]] = (years, la)
        # detection-bias check: observed vs thinned range against log abundance, same years (with larvae)
        ty = [(math.log10(r["abundance"] + 1), r["range"] / 1000.0, r["rangeThinned"] / 1000.0, r["year"]) for r in rows if r["rangeThinned"] is not None]
        tx, tobs, tnull, tyr = (list(v) for v in zip(*ty))
        c_obs, c_null = ccf(tyr, tx, tyr, tobs), ccf(tyr, tx, tyr, tnull)
        lag0 = lambda cc: next(c for c in cc if c["lag"] == 0)
        thin_summary = {"years": len(ty), "observed": lag0(c_obs), "thinned": lag0(c_null)}
        result["species"].append({**{k: sp[k] for k in ("key", "name", "scientific", "id", "color")},
                                  "season": [MONTHS[m - 1] for m in sp["months"]], "cruises": cruises, "years": rows,
                                  "ccf": ccf(years, la, years, lr), "thinCheck": thin_summary})
        r0 = next(c for c in result["species"][-1]["ccf"] if c["lag"] == 0)
        print(f"{sp['name']}: {len(cruises)} cruises, {len(years)} years ({years[0]}-{years[-1]}); "
              f"abundance-range r(lag 0) = {r0['r']} (crit {r0.get('crit')}, n {r0['n']}, nEff {r0.get('nEff')}); "
              f"thinned to {THIN_N0}: r = {thin_summary['thinned']['r']} (crit {thin_summary['thinned']['crit']}) vs observed "
              f"{thin_summary['observed']['r']} on the same {thin_summary['years']} years")
    # between species (question 1): abundance of A(t) against B(t + lag)
    keys = [sp["key"] for sp in SPECIES]
    result["between"] = []
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            ya, a = series[keys[i]]
            yb, b = series[keys[j]]
            c = ccf(ya, a, yb, b)
            result["between"].append({"a": keys[i], "b": keys[j], "ccf": c})
            best = max((x for x in c if x["r"] is not None), key=lambda x: abs(x["r"]))
            print(f"  {keys[i]} vs {keys[j]}: r(lag 0) = {next(x for x in c if x['lag'] == 0)['r']}, "
                  f"strongest r = {best['r']} at lag {best['lag']} (crit {best['crit']})")
    print(f"core area {len(grid)} grid stations, {area_km2:,.0f} km2")
    with open(OUT, "w") as f:
        json.dump(result, f, separators=(",", ":"))


if __name__ == "__main__":
    main()

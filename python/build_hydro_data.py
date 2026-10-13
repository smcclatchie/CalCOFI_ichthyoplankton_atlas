# build_hydro_data.py

"""
Compact JSON data for the atlas's hydrography view (docs/), built from the
standard-depth tables produced by the companion repository
https://github.com/smcclatchie/CalCOFI_digital_atlas
(python/build_bottle_standard_depths.py, python/build_ctd_standard_depths.py),
which hold every selection and quality rule; this script only reshapes them:

  docs/data/hydro/meta.json               per source (bottle, ctd): survey
                                          months with their cruises, stations,
                                          depths
  docs/data/hydro/<source>/<depth>.json   one file per source and standard
                                          depth, loaded on demand: station x
                                          survey month values of temperature,
                                          salinity, sigma-theta, oxygen,
                                          nitrate, silicate, chlorophyll (log10), spiciness and N2
  docs/data/hydro/ctd/iso<s>.json         temperature, salinity, oxygen and depth
                                          on the sigma-theta 25.8 and 26.4 surfaces
                                          (Water masses view; CTD only)
  docs/data/hydro/<source>/cast.json      per-cast derived depths (sigma-theta
                                          25.0 surface, nitricline; CTD also
                                          CalCOFI's chlorophyll max and MLD)

As in the ichthyoplankton view, the atlas steps by survey month (year-month
of the cast). Where a station was sampled more than once in a month, its
value is the mean of those casts (n = number of casts). Bottle and CTD data
are separate sources and are never mixed. (The atlas computes its fixed,
"compare years" colour ranges itself from these values.)

Usage:  python build_hydro_data.py [--src-dir DIR] [--out-dir docs/data/hydro]
--src-dir defaults to that repository's data folder when it is cloned
beside this one (../CalCOFI_digital_atlas/data).
"""

import argparse
import json
import os
import shutil

import duckdb
import numpy as np
import pandas as pd

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(os.path.dirname(REPO_DIR), "CalCOFI_digital_atlas", "data")
DEFAULT_OUT = os.path.join(REPO_DIR, "docs", "data", "hydro")
SOURCES = {
    "bottle": ("CalCOFI_bottle_data/calcofi_bottle_standard_depths.parquet", "Bottle"),
    "ctd": ("CalCOFI_CTD/calcofi_ctd_standard_depths.parquet", "CTD"),
}
VARIABLES = {
    "temperature": {"label": "Temperature", "units": "°C", "column": "t", "decimals": 3},
    "salinity": {"label": "Salinity", "units": "", "column": "s", "decimals": 3},
    "sigma_theta": {"label": "Density (σθ)", "units": "kg m⁻³", "column": "d", "decimals": 3},
    "oxygen": {"label": "Dissolved oxygen", "units": "ml L⁻¹", "column": "o", "decimals": 3},
    "nitrate": {"label": "Nitrate", "units": "µM", "column": "no3", "decimals": 2},   # not "n": that key is the cast count
    "silicate": {"label": "Silicate", "units": "µM", "column": "sio3", "decimals": 2},
    # Chlorophyll a: stored as log10(ug/L) (each cast floored at CHL_FLOOR first), so
    # station means are geometric means, the map and contours are on a log scale
    # and an anomaly is a log ratio to normal; the atlas shows ug/L (or the ratio).
    # 0-200 m: bottle chlorophyll stops at 200 m, the CTD fluorometer reads ~0 below.
    "chlorophyll": {"label": "Chlorophyll a", "units": "µg L⁻¹", "column": "chl", "decimals": 3, "log": True, "maxDepth": 200},
}
CHL_FLOOR = 0.01                       # ug/L, below the detection limit; keeps log10 finite
# Derived variables (the companion repo's build_derived_variables.py), shown in
# the atlas's Derived variables view. At each standard depth (N2: the interval
# from that depth to the next):
DERIVED_DEPTH_VARIABLES = {
    "spiciness": {"label": "Spiciness", "units": "kg m⁻³", "column": "sp", "decimals": 3},
    "n2": {"label": "N² (Brunt–Väisälä)", "units": "10⁻⁴ s⁻²", "column": "n2", "decimals": 3, "interval": True},
}
# One value per cast (a depth), written to <source>/cast.json; CalCOFI's
# chlorophyll-maximum and mixed layer depths exist for CTD casts only.
DERIVED_CAST_VARIABLES = {
    "z_sigma25": {"label": "Depth of σθ 25.0", "units": "m", "column": "zs25", "decimals": 1},
    "nitricline_depth": {"label": "Nitricline depth", "units": "m", "column": "nitz", "decimals": 1},
    "chl_max_depth": {"label": "Chlorophyll-maximum depth", "units": "m", "column": "chlz", "decimals": 1, "sources": ["ctd"]},
    "mld": {"label": "Mixed layer depth", "units": "m", "column": "mld", "decimals": 1, "sources": ["ctd"]},
    # CalCOFI's chlorophyll a integrated over 0-200 m: log10 mg m-2, as chlorophyll (see VARIABLES)
    "chl_integrated": {"label": "Integrated chlorophyll a, 0–200 m", "units": "mg m⁻²", "column": "chli", "decimals": 3,
                       "sources": ["ctd"], "log": True},
    # CalCOFI's 0/500 dbar dynamic height (Water masses view, "Circulation")
    "dyn_height": {"label": "Dynamic height, 0/500 dbar", "units": "dyn m", "column": "dh", "decimals": 3, "group": "dynamic"},
}
# Water-mass fractions (OMP, the companion repo's build_water_mass_fractions.py),
# percent, at the standard depths 0-400 m; shown in the Water masses view.
FRACTION_VARIABLES = {
    "wm_psa": {"label": "Pacific Subarctic water (PSA)", "units": "%", "column": "psa", "decimals": 1, "from": "PSA"},
    "wm_pew": {"label": "Pacific Equatorial water (PEW)", "units": "%", "column": "pew", "decimals": 1, "from": "PEW"},
    "wm_npcw": {"label": "North Pacific Central water (NPCW)", "units": "%", "column": "npcw", "decimals": 1, "from": "NPCW"},
}
DEPTH_VARIABLES = {**VARIABLES, **DERIVED_DEPTH_VARIABLES, **FRACTION_VARIABLES}
# Hydrographic sections (Hydrography view): per source and CalCOFI line, the
# station x survey month x standard-depth values, in <source>/line<L>.json.
# dynamic_height (CalCOFI's, accumulated from the surface) lets the atlas
# compute geostrophic velocity between neighbouring stations.
SECTION_LINES = [90.0, 80.0]
SECTION_COLUMNS = {"temperature": "t", "salinity": "s", "sigma_theta": "d", "oxygen": "o", "nitrate": "no3", "silicate": "sio3",
                   "n2": "n2", "dynamic_height": "dh", "wm_psa": "psa", "wm_pew": "pew", "wm_npcw": "npcw",
                   "chlorophyll": "chl"}      # log10 ug/L, as the maps
# Water masses view: properties on two isopycnals, from CTD casts only
# (the companion repo's build_isopycnal_properties.py), written to
# ctd/iso<surface>.json.
ISOPYCNALS = [25.8, 26.4]
ISOPYCNAL_FILE = "CalCOFI_isopycnal/calcofi_ctd_isopycnals.parquet"
ISOPYCNAL_VARIABLES = {
    "iso_temperature": {"label": "Temperature", "units": "°C", "column": "t", "decimals": 3, "style": "temperature", "from": "temperature"},
    "iso_salinity": {"label": "Salinity", "units": "", "column": "s", "decimals": 3, "style": "salinity", "from": "salinity"},
    "iso_oxygen": {"label": "Dissolved oxygen", "units": "ml L⁻¹", "column": "o", "decimals": 3, "style": "oxygen", "from": "oxygen"},
    "iso_depth": {"label": "Depth of the surface", "units": "m", "column": "zi", "decimals": 1, "style": "z_sigma25", "from": "depth_m"},
}


def dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def build_source(key, path, label, out_dir, src_dir):
    con = duckdb.connect()
    df = con.sql(f"SELECT * FROM '{path}' WHERE site_key IS NOT NULL").df()
    df["chlorophyll"] = np.log10(df["chlorophyll"].clip(lower=CHL_FLOOR))      # see VARIABLES
    derived = os.path.join(src_dir, "CalCOFI_derived", f"calcofi_{key}_derived_{{}}.parquet")
    dd = con.sql(f"SELECT \"cast\", depth_m, spiciness, n2 FROM '{derived.format('depths')}'").df()
    df = df.merge(dd, on=["cast", "depth_m"], how="left")
    fr = con.sql(f"""SELECT "cast", depth_m, PSA * 100 AS wm_psa, PEW * 100 AS wm_pew, NPCW * 100 AS wm_npcw
                     FROM '{os.path.join(src_dir, "CalCOFI_water_masses", f"calcofi_{key}_water_mass_fractions.parquet")}'""").df()
    df = df.merge(fr, on=["cast", "depth_m"], how="left")
    casts = con.sql(f"SELECT * FROM '{derived.format('casts')}' WHERE site_key IS NOT NULL").df()
    df["period"] = df.date.str[:7]
    # cruises: bottle has cruise_id + ship_name; CTD has cruise_key only
    cruise_col = "cruise_id" if "cruise_id" in df else "cruise_key"
    df["ship"] = df["ship_name"].fillna("").str.strip() if "ship_name" in df else ""

    periods = sorted(df.period.unique())
    pidx = {p: i for i, p in enumerate(periods)}
    period_meta = []
    for p in periods:
        g = df[df.period == p].drop_duplicates(cruise_col)
        year, month = int(p[:4]), int(p[5:7])
        period_meta.append({
            "key": p, "year": year, "month": month,
            "cruises": [{"key": c, "ship": s} for c, s in sorted(zip(g[cruise_col], g.ship))],
        })

    stations = (df.groupby("site_key").agg(line=("line", "first"), station=("station", "first"),
                                           lon=("lon", "mean"), lat=("lat", "mean")).reset_index())
    sidx = {k: i for i, k in enumerate(stations.site_key)}

    # station x survey month x depth means
    sm = (df.groupby(["period", "site_key", "depth_m"])
            .agg(**{v: (v, "mean") for v in DEPTH_VARIABLES}, n=("cast", "nunique"))
            .reset_index())
    os.makedirs(os.path.join(out_dir, key), exist_ok=True)
    depths = sorted(int(d) for d in sm.depth_m.unique())
    sizes = 0
    for depth in depths:
        g = sm[sm.depth_m == depth].sort_values(["period", "site_key"])
        rec = {"p": [pidx[p] for p in g.period], "st": [sidx[s] for s in g.site_key], "n": g.n.astype(int).tolist()}
        assert not {spec["column"] for spec in DEPTH_VARIABLES.values()} & set(rec), "variable column clashes with p/st/n"
        for v, spec in DEPTH_VARIABLES.items():
            if g[v].isna().all():
                continue                     # absent column = no data (the atlas fills it with nulls)
            vals = g[v].round(spec["decimals"])
            rec[spec["column"]] = [None if pd.isna(x) else float(x) for x in vals]
        out = os.path.join(out_dir, key, f"{depth}.json")
        dump(rec, out)
        sizes += os.path.getsize(out)

    # one value per cast: station x survey month means
    casts["period"] = casts.date.str[:7]
    for v, spec in DERIVED_CAST_VARIABLES.items():
        if spec.get("log") and v in casts:
            casts[v] = np.log10(casts[v].clip(lower=CHL_FLOOR))
    present = [v for v in DERIVED_CAST_VARIABLES if v in casts]
    cm = (casts.groupby(["period", "site_key"]).agg(**{v: (v, "mean") for v in present}, n=("cast", "nunique"))
               .reset_index().sort_values(["period", "site_key"]))
    rec = {"p": [pidx[p] for p in cm.period], "st": [sidx[s] for s in cm.site_key], "n": cm.n.astype(int).tolist()}
    for v in present:
        spec = DERIVED_CAST_VARIABLES[v]
        rec[spec["column"]] = [None if pd.isna(x) else float(x) for x in cm[v].round(spec["decimals"])]
    dump(rec, os.path.join(out_dir, key, "cast.json"))
    sizes += os.path.getsize(os.path.join(out_dir, key, "cast.json"))

    # sections: station x survey month x depth means on each section line
    depths_all = sorted(int(d) for d in df.depth_m.unique())
    didx = {d: i for i, d in enumerate(depths_all)}
    for line in SECTION_LINES:
        g = (df[df.line == line].groupby(["period", "site_key", "depth_m"])
             .agg(**{v: (v, "mean") for v in SECTION_COLUMNS}, n=("cast", "nunique"))
             .reset_index().sort_values(["period", "site_key", "depth_m"]))
        rec = {"p": [pidx[p] for p in g.period], "st": [sidx[s] for s in g.site_key],
               "z": [didx[int(d)] for d in g.depth_m], "n": g.n.astype(int).tolist()}
        for v, col in SECTION_COLUMNS.items():
            rec[col] = [None if pd.isna(x) else round(float(x), 4) for x in g[v]]
        path = os.path.join(out_dir, key, f"line{line:g}.json")
        dump(rec, path)
        sizes += os.path.getsize(path)

    # isopycnal properties (CTD only): station x survey month means per surface
    iso_path = os.path.join(src_dir, ISOPYCNAL_FILE)
    if key == "ctd" and os.path.exists(iso_path):
        iso = con.sql(f"SELECT * FROM '{iso_path}' WHERE site_key IS NOT NULL").df()
        iso["period"] = iso.date.str[:7]
        for level in ISOPYCNALS:
            g = (iso[iso.sigma_theta == level].groupby(["period", "site_key"])
                 .agg(**{v: (spec["from"], "mean") for v, spec in ISOPYCNAL_VARIABLES.items()}, n=("cast", "nunique"))
                 .reset_index().sort_values(["period", "site_key"]))
            rec = {"p": [pidx[p] for p in g.period], "st": [sidx[s] for s in g.site_key], "n": g.n.astype(int).tolist()}
            for v, spec in ISOPYCNAL_VARIABLES.items():
                rec[spec["column"]] = [None if pd.isna(x) else float(x) for x in g[v].round(spec["decimals"])]
            path = os.path.join(out_dir, key, f"iso{level}.json")
            dump(rec, path)
            sizes += os.path.getsize(path)

    print(f"{label}: {len(periods)} survey months ({periods[0]} to {periods[-1]}), {len(stations)} stations, "
          f"{len(depths)} depths, {sizes / 1e6:.1f} MB")
    return {
        "label": label,
        "years": [int(periods[0][:4]), int(periods[-1][:4])],
        "periods": period_meta,
        "stations": [{"key": r.site_key, "line": float(r.line), "station": float(r.station),
                      "lon": round(float(r.lon), 4), "lat": round(float(r.lat), 4)} for r in stations.itertuples()],
        "depths": depths,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src-dir", default=DEFAULT_SRC)
    ap.add_argument("--out-dir", default=DEFAULT_OUT)
    args = ap.parse_args()
    if os.path.isdir(args.out_dir):
        shutil.rmtree(args.out_dir)
    os.makedirs(args.out_dir)
    meta = {
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"),
        "variables": {
            **{k: {"label": v["label"], "units": v["units"], "column": v["column"],
                   **{f: v[f] for f in ("log", "maxDepth") if f in v}} for k, v in VARIABLES.items()},
            **{k: {"label": v["label"], "units": v["units"], "column": v["column"], "group": "derived",
                   **({"interval": True} if v.get("interval") else {})} for k, v in DERIVED_DEPTH_VARIABLES.items()},
            **{k: {"label": v["label"], "units": v["units"], "column": v["column"], "group": v.get("group", "derived"), "perCast": True,
                   **({"sources": v["sources"]} if "sources" in v else {}), **({"log": True} if v.get("log") else {})}
               for k, v in DERIVED_CAST_VARIABLES.items()},
            **{k: {"label": v["label"], "units": v["units"], "column": v["column"], "group": "isopycnal",
                   "style": v["style"], "sources": ["ctd"]} for k, v in ISOPYCNAL_VARIABLES.items()},
            **{k: {"label": v["label"], "units": v["units"], "column": v["column"], "group": "fraction", "maxDepth": 400}
               for k, v in FRACTION_VARIABLES.items()},
        },
        "isopycnals": ISOPYCNALS,
        "sectionLines": SECTION_LINES,
        "sources": {},
    }
    for key, (rel, label) in SOURCES.items():
        meta["sources"][key] = build_source(key, os.path.join(args.src_dir, rel), label, args.out_dir, args.src_dir)
    dump(meta, os.path.join(args.out_dir, "meta.json"))
    print(f"wrote {args.out_dir}/meta.json ({os.path.getsize(os.path.join(args.out_dir, 'meta.json')) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()

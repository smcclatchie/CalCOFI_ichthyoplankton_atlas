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
                                          salinity and sigma-theta

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
}


def dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def build_source(key, path, label, out_dir):
    con = duckdb.connect()
    df = con.sql(f"SELECT * FROM '{path}' WHERE site_key IS NOT NULL").df()
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
            .agg(temperature=("temperature", "mean"), salinity=("salinity", "mean"),
                 sigma_theta=("sigma_theta", "mean"), n=("cast", "nunique"))
            .reset_index())
    os.makedirs(os.path.join(out_dir, key), exist_ok=True)
    depths = sorted(int(d) for d in sm.depth_m.unique())
    sizes = 0
    for depth in depths:
        g = sm[sm.depth_m == depth].sort_values(["period", "site_key"])
        rec = {"p": [pidx[p] for p in g.period], "st": [sidx[s] for s in g.site_key], "n": g.n.astype(int).tolist()}
        for v, spec in VARIABLES.items():
            vals = g[v].round(spec["decimals"])
            rec[spec["column"]] = [None if pd.isna(x) else float(x) for x in vals]
        out = os.path.join(out_dir, key, f"{depth}.json")
        dump(rec, out)
        sizes += os.path.getsize(out)

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
        "variables": {k: {"label": v["label"], "units": v["units"], "column": v["column"]} for k, v in VARIABLES.items()},
        "sources": {},
    }
    for key, (rel, label) in SOURCES.items():
        meta["sources"][key] = build_source(key, os.path.join(args.src_dir, rel), label, args.out_dir)
    dump(meta, os.path.join(args.out_dir, "meta.json"))
    print(f"wrote {args.out_dir}/meta.json ({os.path.getsize(os.path.join(args.out_dir, 'meta.json')) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()

# build_atlas_data.py

"""
Compact JSON data for the CalCOFI ichthyoplankton web atlas (docs/), built
from the station GeoParquet tables produced by the companion repository
https://github.com/smcclatchie/CalCOFI_digital_atlas
(python/build_station_geoparquet.py). That repository holds every CalCOFI
selection and standardisation rule; this script only reshapes its output:

  docs/data/meta.json         survey months, cruises, stations, net types,
                              sampling types, life stages, provenance
  docs/data/occupations.json  every station occupation (survey month x
                              sampling x net x station) with its tow count,
                              so the atlas can show zero catches
  docs/data/taxa.json         the taxon list for the species picker
  docs/data/taxa/<i>.json     one file per taxon, loaded on demand: the
                              non-zero catches (survey month, sampling, net,
                              life stage, station, abundance)
  docs/data/lines/<line>.json one file per CalCOFI line with every taxon's
                              non-zero catches on that line (t = taxon id),
                              for the atlas's all-species CSV downloads
  docs/data/land.geojson      Natural Earth 1:50m land, clipped to the region

The atlas steps by *survey month* (year-month): cruises by different ships
in the same month are one survey. Where a station was occupied more than
once in a month with the same net and sampling type, abundance is the mean
over those tows, absences counting as zero (tow-weighted, consistent with
the per-cruise means in the source tables).

All arrays are column-oriented and indices refer into meta.json lists, to
keep the files small; abundance keeps 4 significant figures.

Usage:  python build_atlas_data.py [--src-dir DIR] [--out-dir docs/data]
--src-dir defaults to that repository's data folder when it is cloned
beside this one (../CalCOFI_digital_atlas).
"""

import argparse
import json
import os
import shutil

import cartopy.io.shapereader as shpreader
import duckdb
import numpy as np
import pandas as pd

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(os.path.dirname(REPO_DIR), "CalCOFI_digital_atlas", "data",
                           "CalCOFI_ichthyoplankton", "ichthyoplankton_from_calCOFI.io")
DEFAULT_OUT = os.path.join(REPO_DIR, "docs", "data")
CATCH_NAME = "calcofi_ichthyo_stations_catch.parquet"
TOWS_NAME = "calcofi_ichthyo_stations_tows.parquet"
NET_ORDER = ["C1", "CB", "CV", "PV", "MT"]               # oblique, vertical, then surface
SAMPLINGS = ["standard", "special survey"]
STAGES = ["egg", "larva"]
REGION = (-160.0, 5.0, -85.0, 60.0)            # lon_min, lat_min, lon_max, lat_max for the coastline
SEASONS = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
           6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn"}


def sig4(x):
    """Round to 4 significant figures (abundance spans >6 orders of magnitude)."""
    x = np.asarray(x, dtype=float)
    mag = np.floor(np.log10(np.abs(x)))
    return np.round(x / 10 ** mag, 3) * 10 ** mag


def dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src-dir", default=DEFAULT_SRC, help="directory holding the station GeoParquet tables")
    ap.add_argument("--out-dir", default=DEFAULT_OUT)
    args = ap.parse_args()

    con = duckdb.connect()
    con.sql("LOAD spatial;")
    catch = con.sql(f"SELECT * EXCLUDE geometry FROM '{os.path.join(args.src_dir, CATCH_NAME)}'").df()
    tows = con.sql(f"SELECT * EXCLUDE geometry FROM '{os.path.join(args.src_dir, TOWS_NAME)}'").df()

    # ---- lookup lists ----
    for df in (catch, tows):
        df["period"] = df.cruise_key.str[:7]                     # survey month, e.g. "1951-01"
    periods = sorted(tows.period.unique())
    station_list = (tows.drop_duplicates("site_key").sort_values(["line", "station"])
                        .reset_index(drop=True))
    nets = [n for n in NET_ORDER if (tows.net_type == n).any()]
    net_labels = tows.drop_duplicates("net_type").set_index("net_type").net_description
    net_units = catch.drop_duplicates("net_type").set_index("net_type").units
    index = {
        "period": {p: i for i, p in enumerate(periods)},
        "station": {s: i for i, s in enumerate(station_list.site_key)},
        "net": {n: i for i, n in enumerate(nets)},
        "sampling": {s: i for i, s in enumerate(SAMPLINGS)},
        "stage": {s: i for i, s in enumerate(STAGES)},
    }

    period_info = (tows.groupby("period")
                       .agg(start=("date_iso", "min"), end=("date_iso", "max"),
                            ships=("ship_name", lambda s: sorted(set(s.dropna()))),
                            cruises=("cruise_key", lambda s: sorted(set(s))))
                       .reindex(periods))
    cruise_ship = tows.drop_duplicates("cruise_key").set_index("cruise_key").ship_name
    meta = {
        "title": "CalCOFI ichthyoplankton atlas",
        "source": "SWFSC ichthyoplankton (CalCOFI.io swfsc_ichthyo.nc), filtered to CalCOFI cruises "
                  "and stations and standardised as described in "
                  "https://github.com/smcclatchie/CalCOFI_digital_atlas",
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"),
        "periods": [{"key": p, "year": int(p[:4]), "month": int(p[5:7]), "season": SEASONS[int(p[5:7])],
                     "start": r.start, "end": r.end, "ships": r.ships,
                     "cruises": [{"key": c, "ship": None if pd.isna(cruise_ship[c]) else cruise_ship[c]}
                                 for c in r.cruises]}
                    for p, r in period_info.iterrows()],
        "stations": [{"key": r.site_key, "line": r.line, "station": r.station,
                      "lat": round(r.lat, 4), "lon": round(r.lon, 4)} for r in station_list.itertuples()],
        # "count per 10 m2" -> "per 10 m²" for display
        "nets": [{"code": n, "label": net_labels[n],
                  "units": net_units[n].replace("count ", "").replace("m2", "m²").replace("m3", "m³")}
                 for n in nets],
        "samplings": SAMPLINGS,
        "stages": STAGES,
    }

    # ---- occupations per survey month (tows summed across ships in the month) ----
    occ_keys = ["period", "sampling", "net_type", "site_key"]
    occ = tows.groupby(occ_keys).n_tows.sum().reset_index()
    occupations = {
        "p": occ.period.map(index["period"]).tolist(),
        "s": occ.sampling.map(index["sampling"]).tolist(),
        "n": occ.net_type.map(index["net"]).tolist(),
        "st": occ.site_key.map(index["station"]).tolist(),
        "t": occ.n_tows.tolist(),
    }

    # ---- catches per survey month: tow-weighted mean, absences as zero ----
    catch["weighted"] = catch.abundance * catch.n_tows       # = summed density over the cruise's tows
    c = (catch.groupby(occ_keys + ["life_stage", "taxon_key"])
              .weighted.sum().reset_index()
              .merge(occ, on=occ_keys))
    c["abundance"] = sig4(c.weighted / c.n_tows)

    names = (catch.drop_duplicates("taxon_key")
                  .set_index("taxon_key")[["scientific_name", "common_name", "family", "order_taxon"]])
    stats = (c.groupby("taxon_key")
              .agg(rows=("abundance", "size"),
                   eggs=("life_stage", lambda s: int((s == "egg").sum())),
                   larvae=("life_stage", lambda s: int((s == "larva").sum())),
                   top_net=("net_type", lambda s: s.value_counts().index[0]),
                   net_rows=("net_type", lambda s: [int((s == n).sum()) for n in nets]))
              .join(names)
              .sort_values("rows", ascending=False))

    os.makedirs(args.out_dir, exist_ok=True)
    taxa_dir = os.path.join(args.out_dir, "taxa")
    shutil.rmtree(taxa_dir, ignore_errors=True)
    os.makedirs(taxa_dir)
    taxa = []
    for i, (key, r) in enumerate(stats.iterrows()):
        t = c[c.taxon_key == key]
        dump({"p": t.period.map(index["period"]).tolist(),
              "s": t.sampling.map(index["sampling"]).tolist(),
              "n": t.net_type.map(index["net"]).tolist(),
              "g": t.life_stage.map(index["stage"]).tolist(),
              "st": t.site_key.map(index["station"]).tolist(),
              "a": t.abundance.tolist()},
             os.path.join(taxa_dir, f"{i}.json"))
        taxa.append({"id": i, "key": key, "scientific": r.scientific_name,
                     "common": None if pd.isna(r.common_name) else r.common_name,
                     "family": None if pd.isna(r.family) else r.family,
                     "rows": int(r.rows), "eggs": r.eggs, "larvae": r.larvae,
                     "topNet": index["net"][r.top_net],
                     "netRows": r.net_rows})          # records per net, in meta.nets order

    # ---- per-line files: all taxa on one CalCOFI line, for CSV downloads ----
    taxon_id = {t["key"]: t["id"] for t in taxa}
    lines_dir = os.path.join(args.out_dir, "lines")
    shutil.rmtree(lines_dir, ignore_errors=True)
    os.makedirs(lines_dir)
    c["line"] = c.site_key.str[:5].astype(float)
    meta["lines"] = []
    for line, t in c.groupby("line"):
        name = f"{line:05.1f}.json"
        dump({"p": t.period.map(index["period"]).tolist(),
              "s": t.sampling.map(index["sampling"]).tolist(),
              "n": t.net_type.map(index["net"]).tolist(),
              "g": t.life_stage.map(index["stage"]).tolist(),
              "st": t.site_key.map(index["station"]).tolist(),
              "t": t.taxon_key.map(taxon_id).tolist(),
              "a": t.abundance.tolist()},
             os.path.join(lines_dir, name))
        meta["lines"].append({"line": line, "file": name})

    # ---- coastline: Natural Earth 1:50m land clipped to the region ----
    land_shp = shpreader.natural_earth(resolution="50m", category="physical", name="land")
    lon0, lat0, lon1, lat1 = REGION
    land = con.sql(f"""SELECT ST_AsGeoJSON(ST_Intersection(geom, ST_MakeEnvelope({lon0}, {lat0}, {lon1}, {lat1}))) g
                       FROM ST_Read('{land_shp}')
                       WHERE ST_Intersects(geom, ST_MakeEnvelope({lon0}, {lat0}, {lon1}, {lat1}))""").fetchall()
    land_fc = {"type": "FeatureCollection",
               "features": [{"type": "Feature", "properties": {}, "geometry": json.loads(g)}
                            for (g,) in land if g and json.loads(g)["type"] != "GeometryCollection"]}

    dump(meta, os.path.join(args.out_dir, "meta.json"))
    dump(occupations, os.path.join(args.out_dir, "occupations.json"))
    dump(taxa, os.path.join(args.out_dir, "taxa.json"))
    dump(land_fc, os.path.join(args.out_dir, "land.geojson"))

    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(args.out_dir) for f in fs)
    print(f"{len(periods)} survey months, {len(station_list)} stations, {len(occ)} occupations, "
          f"{len(c)} catch rows, {len(taxa)} taxa, {len(land_fc['features'])} land features")
    print(f"wrote {args.out_dir} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

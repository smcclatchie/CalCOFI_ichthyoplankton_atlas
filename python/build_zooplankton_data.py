# build_zooplankton_data.py

"""
Compact JSON for the atlas's Zooplankton view, one folder per dataset, in the
same layout as the ichthyoplankton data (build_atlas_data.py), so the atlas
shows them with the same machinery:

  docs/data/zoo/<dataset>/meta.json         survey months, cruises, stations,
                                            nets, samplings, stages, wording
  docs/data/zoo/<dataset>/occupations.json  every station occupation with its
                                            tow count
  docs/data/zoo/<dataset>/taxa.json         the taxon (or class) list
  docs/data/zoo/<dataset>/taxa/<i>.json     values per survey month, sampling,
                                            net, stage, station

Datasets (from the companion repo's build_zooplankton_tables.py, which holds
the CalCOFI selection and standardisation):
  volume   plankton displacement volume, total and small (mL per 1,000 m3),
           by net (C1 ring net, CB bongo); "stage" = the one measurement
  krill    euphausiids, abundance per m2; stages adult, juvenile, furcilia,
           calyptopis and all stages; plus "All krill" (every species summed)
           and the warm- and cool-water krill groups (KRILL_GROUPS)
  zooscan  ZooScan image classes; the "stages" are the four measurements:
           abundance (per m2), carbon biomass (mg C m-2), mean size (Feret
           diameter, mm) and mean individual carbon (ug C); plus "All
           copepods" and "Gelatinous zooplankton" (ZOOSCAN_GROUPS, abundance
           and carbon biomass)

A station's value in a survey month is the mean over its tows there. For
counts and biomasses a tow that did not record the taxon counts as zero (as
for the fish); for the per-individual means (size, individual carbon) only
tows with the class count. Values keep 4 significant figures.

Usage:  python build_zooplankton_data.py [--src-dir DIR] [--out-dir docs/data/zoo]
"""

import argparse
import json
import os
import shutil

import duckdb
import numpy as np
import pandas as pd

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(os.path.dirname(REPO_DIR), "CalCOFI_digital_atlas", "data", "CalCOFI_zooplankton")
DEFAULT_OUT = os.path.join(REPO_DIR, "docs", "data", "zoo")
SAMPLINGS = ["standard", "special survey"]
SEASONS = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
           6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn"}
NET_LABELS = {"C1": "C1: CalCOFI 1 m ring net (oblique), to 1978", "CB": "CB: CalCOFI bongo (oblique), 1978 onward",
              "KR": "CalCOFI oblique net tows (krill sorted by Brinton & Townsend)",
              "PR": "PRPOOS net (vertical, 0–210 m), ZooScan imaging"}

# Per dataset: the stage list (key, menu label, noun for "with ..." / "no ...",
# legend title, units), whether absences count as zero, and the source.
DATASETS = {
    "volume": {
        "label": "Plankton volume",
        "title": "Plankton displacement volume (total and small plankton)",
        "taxonWord": "measure",
        "stages": [{"key": "volume", "label": "Displacement volume", "noun": "plankton",
                    "title": "Plankton volume", "units": "mL per 1,000 m³"}],
        "zeros": False,
        "source": "SWFSC ichthyoplankton nets (CalCOFI.io swfsc_ichthyo): displacement volume / volume filtered x 1000",
    },
    "krill": {
        "label": "Krill",
        "title": "Krill (euphausiids), Brinton & Townsend",
        "taxonWord": "species",
        "stages": [{"key": "adult", "label": "Adults", "noun": "adults", "title": "Adults", "units": "per m²"},
                   {"key": "juvenile", "label": "Juveniles", "noun": "juveniles", "title": "Juveniles", "units": "per m²"},
                   {"key": "furcilia", "label": "Furcilia", "noun": "furcilia", "title": "Furcilia", "units": "per m²"},
                   {"key": "calyptopis", "label": "Calyptopis", "noun": "calyptopes", "title": "Calyptopes", "units": "per m²"},
                   {"key": "all", "label": "All stages", "noun": "krill", "title": "Krill (all stages)", "units": "per m²"}],
        "zeros": True,
        "source": "CCE-LTER euphausiid abundance (CalCOFI.io cce-lter_euphausiids)",
    },
    "zooscan": {
        "label": "ZooScan",
        "title": "ZooScan zooplankton (PRPOOS net, image classes)",
        "taxonWord": "class",
        "stages": [{"key": "zooscan_abundance", "label": "Abundance", "noun": "individuals", "title": "Abundance", "units": "per m²"},
                   {"key": "zooscan_biomass_carbon", "label": "Carbon biomass", "noun": "biomass", "title": "Carbon biomass", "units": "mg C m⁻²"},
                   {"key": "zooscan_feret_diameter", "label": "Mean size (Feret diameter)", "noun": "measured individuals",
                    "title": "Mean size (Feret diameter)", "units": "mm", "mean": True},
                   {"key": "zooscan_carbon_individual", "label": "Mean individual carbon", "noun": "measured individuals",
                    "title": "Mean individual carbon", "units": "µg C", "mean": True}],
        "zeros": True,
        "source": "CCE-LTER ZooScan PRPOOS zooplankton (CalCOFI.io cce-lter_zooscan)",
    },
}


# Display names (scientific, common) and list order. ZooScan's own class
# names are codes and mixed-case labels; Hansarsia is WoRMS's current name for
# Nematoscelis, which the krill literature uses.
ZOOSCAN_LABELS = {
    "worms:106422": ("Oithonidae", "Oithona-like copepods"),
    "worms:1381349": ("Ergasilida", "Poecilostomatoid copepods"),
    "worms:1102": ("Harpacticoida", "Harpacticoid copepods"),
    "worms:104085": ("Eucalanidae", "Eucalanid copepods"),
    "worms:1100": ("Calanoida", "Other calanoid copepods"),
    "worms:1080": ("Copepoda", "Other copepods"),
    "worms:1128": ("Euphausiacea", "Krill"),
    "worms:1078": ("Ostracoda", "Ostracods"),
    "worms:1066": ("Crustacea", "Other crustaceans"),
    "cce-lter_zooscan:16": ("Nauplii", None),
    "worms:2081": ("Chaetognatha", "Arrow worms"),
    "worms:146421": ("Appendicularia", "Appendicularians (larvaceans)"),
    "worms:137214": ("Salpida", "Salps"),
    "worms:137212": ("Doliolida", "Doliolids"),
    "worms:137213": ("Pyrosomatida", "Pyrosomes"),
    "worms:1267": ("Cnidaria", "Jellyfish and other cnidarians"),
    "worms:582420": ("Rhizaria", "Rhizarians"),
    "worms:101": ("Gastropoda", "Snails (incl. pteropods)"),
    "worms:883": ("Polychaeta", "Polychaete worms"),
    "worms:146142": ("Bryozoa", "Bryozoans"),
    "cce-lter_zooscan:13": ("Eggs", None),
    "cce-lter_zooscan:15": ("Multiples", "several organisms imaged together"),
    "cce-lter_zooscan:18": ("Others", "unclassified images"),
}
KRILL_COMMON = {"worms:1649784": "formerly Nematoscelis difficilis", "worms:1649791": "formerly Nematoscelis tenella",
                "worms:1649783": "formerly Nematoscelis atlantica", "worms:1649787": "formerly Nematoscelis gracilis",
                "worms:1649790": "formerly Nematoscelis microps"}


# Groups (summed per tow, like the fish groups), listed first.
KRILL_GROUPS = [
    {"key": "group:krill-warm", "label": "Warm-water krill",
     "members": {"worms:237864": "Nyctiphanes simplex", "worms:237853": "Euphausia eximia", "worms:221047": "Euphausia recurva",
                 "worms:110684": "Euphausia gibboides", "worms:110686": "Euphausia hemigibba", "worms:110700": "Stylocheiron affine"}},
    {"key": "group:krill-cool", "label": "Cool-water krill",
     "members": {"worms:237851": "Euphausia pacifica", "worms:237874": "Thysanoessa spinifera",
                 "worms:237873": "Thysanoessa longipes", "worms:237870": "Tessarabrachion oculatum"}},
]
ZOOSCAN_GROUPS = [   # abundance and carbon biomass only: the per-individual means do not sum
    {"key": "group:copepods", "label": "All copepods",
     "members": {"worms:106422": "Oithonidae", "worms:1381349": "Poecilostomatoida", "worms:1102": "Harpacticoida",
                 "worms:104085": "Eucalanidae", "worms:1100": "other Calanoida", "worms:1080": "other Copepoda"}},
    {"key": "group:gelatinous", "label": "Gelatinous zooplankton",
     "members": {"worms:137214": "salps", "worms:137212": "doliolids", "worms:137213": "pyrosomes",
                 "worms:146421": "appendicularians"}},
]


def group_values(vals, groups, stages=None):
    """Each group's members summed per tow and stage (stages: those to sum)."""
    out = []
    for g in groups:
        v = vals[vals.taxon_key.isin(list(g["members"])) & (vals.stage.isin(stages) if stages else True)]
        s = v.groupby(["sample_key", "stage"]).value.sum().reset_index()
        out.append(s.assign(taxon_key=g["key"], scientific_name=", ".join(g["members"].values()), common_name=g["label"],
                            group=True))
    return pd.concat(out, ignore_index=True)


def sig4(x):
    x = np.asarray(x, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        mag = np.where(x > 0, np.floor(np.log10(np.abs(np.where(x > 0, x, 1)))), 0)
    return np.where(x > 0, np.round(x / 10 ** (mag - 3)) * 10 ** (mag - 3), 0.0)


def dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def build(key, spec, tows, vals, out_dir, labels=None, order=None):
    """tows: one row per tow (sample_key, cruise_key, ship_name, site_key, line,
    station, lat, lon, date, sampling, net_type); vals: sample_key, taxon_key,
    scientific_name, common_name, stage, value."""
    out = os.path.join(out_dir, key)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "taxa"))
    undated = tows.date.isna()
    if undated.any():
        print(f"  {key}: {int(undated.sum())} tows without a date left out")
    tows = tows[~undated].copy()
    tows["period"] = tows.date.str[:7]
    periods = sorted(tows.period.unique())
    stations = (tows.groupby("site_key").agg(line=("line", "first"), station=("station", "first"),
                                             lat=("lat", "median"), lon=("lon", "median"))
                    .reset_index().sort_values(["line", "station"]).reset_index(drop=True))
    nets = sorted(tows.net_type.unique())
    stage_keys = [s["key"] for s in spec["stages"]]
    idx = {"p": {p: i for i, p in enumerate(periods)}, "st": {s: i for i, s in enumerate(stations.site_key)},
           "n": {n: i for i, n in enumerate(nets)}, "s": {s: i for i, s in enumerate(SAMPLINGS)},
           "g": {s: i for i, s in enumerate(stage_keys)}}
    info = tows.groupby("period").agg(start=("date", "min"), end=("date", "max"),
                                      ships=("ship_name", lambda s: sorted(set(s.dropna()))),
                                      cruises=("cruise_key", lambda s: sorted(set(s.dropna()))))
    ship = tows.dropna(subset=["cruise_key"]).drop_duplicates("cruise_key").set_index("cruise_key").ship_name
    meta = {
        "dataset": key, "label": spec["label"], "title": spec["title"], "taxonWord": spec["taxonWord"],
        "source": spec["source"] + "; CalCOFI cruises and stations selected as in "
                  "https://github.com/smcclatchie/CalCOFI_digital_atlas (build_zooplankton_tables.py)",
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"),
        "periods": [{"key": p, "year": int(p[:4]), "month": int(p[5:7]), "season": SEASONS[int(p[5:7])],
                     "start": r.start, "end": r.end, "ships": r.ships,
                     "cruises": [{"key": c, "ship": None if pd.isna(ship.get(c)) else ship.get(c)} for c in r.cruises]}
                    for p, r in info.reindex(periods).iterrows()],
        "stations": [{"key": r.site_key, "line": r.line, "station": r.station, "lat": round(r.lat, 4), "lon": round(r.lon, 4)}
                     for r in stations.itertuples()],
        "nets": [{"code": n, "label": NET_LABELS.get(n, n), "units": ""} for n in nets],
        "samplings": SAMPLINGS,
        "stages": stage_keys,
        "stageInfo": spec["stages"],
        "lines": [],
    }
    occ_keys = ["period", "sampling", "net_type", "site_key"]
    occ = tows.groupby(occ_keys).sample_key.nunique().rename("n_tows").reset_index()
    dump({"p": occ.period.map(idx["p"]).tolist(), "s": occ.sampling.map(idx["s"]).tolist(),
          "n": occ.net_type.map(idx["n"]).tolist(), "st": occ.site_key.map(idx["st"]).tolist(),
          "t": occ.n_tows.astype(int).tolist()}, os.path.join(out, "occupations.json"))

    v = vals.merge(tows[["sample_key"] + occ_keys], on="sample_key")
    rows = []
    for (stage, mean_only), g in v.groupby([v.stage, v.stage.map({s["key"]: bool(s.get("mean")) for s in spec["stages"]})]):
        if spec["zeros"] and not mean_only:           # mean over all tows, absences zero
            agg = g.groupby(occ_keys + ["taxon_key"]).value.sum().reset_index().merge(occ, on=occ_keys)
            agg["value"] = agg.value / agg.n_tows
        else:                                         # mean over the tows that recorded it
            agg = g.groupby(occ_keys + ["taxon_key"]).value.mean().reset_index()
        agg["stage"] = stage
        rows.append(agg)
    c = pd.concat(rows, ignore_index=True)
    c["value"] = sig4(c.value)
    c = c[c.value > 0]

    names = vals.drop_duplicates("taxon_key").set_index("taxon_key")[["scientific_name", "common_name"]]
    by_rows = list(c.groupby("taxon_key").size().sort_values(ascending=False).index)
    order = [k for k in (order or []) if k in by_rows] + [k for k in by_rows if k not in (order or [])]
    taxa = []
    for i, tk in enumerate(order):
        t = c[c.taxon_key == tk]
        dump({"p": t.period.map(idx["p"]).tolist(), "s": t.sampling.map(idx["s"]).tolist(),
              "n": t.net_type.map(idx["n"]).tolist(), "g": t.stage.map(idx["g"]).tolist(),
              "st": t.site_key.map(idx["st"]).tolist(), "a": t.value.tolist()},
             os.path.join(out, "taxa", f"{i}.json"))
        sci, com = (labels or {}).get(tk) or (names.loc[tk, "scientific_name"], names.loc[tk, "common_name"])
        is_group = tk.startswith("group:")
        taxa.append({"id": i, "key": tk, "scientific": sci if isinstance(sci, str) else tk,
                     "common": com if isinstance(com, str) else None, "family": None,
                     **({"group": True, "members": sci} if is_group else {}),
                     "rows": int(len(t)), "stageRows": [int((t.stage == s).sum()) for s in stage_keys],
                     "topNet": idx["n"][t.net_type.value_counts().index[0]],
                     "netRows": [int((t.net_type == n).sum()) for n in nets]})
    dump(meta, os.path.join(out, "meta.json"))
    dump(taxa, os.path.join(out, "taxa.json"))
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
    print(f"{key}: {len(periods)} survey months ({periods[0]} to {periods[-1]}), {len(stations)} stations, "
          f"{len(taxa)} taxa, {len(occ)} occupations, {size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src-dir", default=DEFAULT_SRC)
    ap.add_argument("--out-dir", default=DEFAULT_OUT)
    args = ap.parse_args()
    q = lambda name: duckdb.sql(f"SELECT * FROM '{os.path.join(args.src_dir, name)}'").df()
    os.makedirs(args.out_dir, exist_ok=True)

    # plankton volume: the two volumes as two "taxa", one measurement
    vt = q("plankton_volume_tows.parquet")
    long = pd.concat([vt[["sample_key"]].assign(taxon_key=k, scientific_name=n, common_name=None,
                                                stage="volume", value=vt[col])
                      for k, n, col in [("volume:total", "Total plankton volume", "total_ml_per_1000m3"),
                                        ("volume:small", "Small plankton volume", "small_ml_per_1000m3")]])
    build("volume", DATASETS["volume"], vt, long.dropna(subset=["value"]), args.out_dir, order=["volume:total", "volume:small"])

    # krill: species x stage, plus every species summed ("All krill")
    kt = q("krill_tows.parquet").assign(net_type="KR")
    kv = q("krill_values.parquet")
    kv["common_name"] = kv.taxon_key.map(KRILL_COMMON).fillna(kv.common_name)
    allk = kv.groupby(["sample_key", "stage"]).value.sum().reset_index().assign(
        taxon_key="krill:all", scientific_name="Euphausiacea", common_name="All krill (every species summed)")
    build("krill", DATASETS["krill"], kt, pd.concat([kv, allk, group_values(kv, KRILL_GROUPS)], ignore_index=True), args.out_dir,
          order=["krill:all"] + [g["key"] for g in KRILL_GROUPS])

    # ZooScan: class x measurement
    zt = q("zooscan_tows.parquet").assign(net_type="PR")
    zv = q("zooscan_values.parquet").assign(stage=lambda d: d.measurement)
    zg = group_values(zv, ZOOSCAN_GROUPS, stages=["zooscan_abundance", "zooscan_biomass_carbon"])
    build("zooscan", DATASETS["zooscan"], zt, pd.concat([zv, zg], ignore_index=True), args.out_dir, labels=ZOOSCAN_LABELS,
          order=[g["key"] for g in ZOOSCAN_GROUPS] + list(ZOOSCAN_LABELS))


if __name__ == "__main__":
    main()

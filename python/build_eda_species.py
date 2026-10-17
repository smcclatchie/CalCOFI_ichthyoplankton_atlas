# build_eda_species.py

"""
The species offered by the EDA view's cross-correlation matrix (2026-10-17,
user): larval fish and adult krill species "in the upper 25th percentile of
abundance" -> docs/data/eda_species.json
(top 10% since 2026-10-17, user; was 25%).

From the atlas's own data (docs/data/taxa, docs/data/zoo/krill/taxa): species
only (a two-word scientific name; no higher taxa, no combined entries), ranked
by mean abundance over every standard-sampling occupation on the core CalCOFI
lines (76.7-93.3), absences as zero -- larvae in the CalCOFI bongo net (CB,
per 10 m2), krill adults (per m2) -- keeping the top TOP_FRACTION (10%) of the
species with any catch there.

Usage:  python build_eda_species.py   (after build_atlas_data.py / build_zooplankton_data.py)
"""

import json
import os

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO_DIR, "docs", "data")
CORE_LINES = {76.7, 80.0, 83.3, 86.7, 90.0, 93.3}
TOP_FRACTION = 0.10
DATASETS = {"ichthyo": ("", "CB", "larva"), "krill": ("zoo/krill", "KR", "adult")}


def ranked(sub, net_code, stage_key):
    d = os.path.join(DATA, sub)
    meta = json.load(open(os.path.join(d, "meta.json")))
    occ = json.load(open(os.path.join(d, "occupations.json")))
    taxa = json.load(open(os.path.join(d, "taxa.json")))
    s_std = meta["samplings"].index("standard")
    n_net = [n["code"] for n in meta["nets"]].index(net_code)
    stages = meta.get("stages") or [x["key"] for x in meta["stageInfo"]]
    g = stages.index(stage_key)
    core = {i for i, s in enumerate(meta["stations"]) if s["line"] in CORE_LINES}
    n_occ = sum(1 for s, n, st in zip(occ["s"], occ["n"], occ["st"]) if s == s_std and n == n_net and st in core)
    out = []
    for t in taxa:
        name = t["scientific"] or ""
        if t.get("group") or len(name.split()) != 2 or "spp" in name or ":" in t["key"] and not t["key"].startswith("worms:"):
            continue
        r = json.load(open(os.path.join(d, "taxa", f"{t['id']}.json")))
        total = sum(a for s, n, gg, st, a in zip(r["s"], r["n"], r["g"], r["st"], r["a"])
                    if s == s_std and n == n_net and gg == g and st in core)
        if total > 0:
            out.append({"id": t["id"], "key": t["key"], "scientific": name, "common": t.get("common"), "mean": round(total / n_occ, 3)})
    out.sort(key=lambda x: -x["mean"])
    return out[: max(1, round(len(out) * TOP_FRACTION))], len(out), n_occ


def main():
    res = {}
    for ds, (sub, net, stage) in DATASETS.items():
        top, n_species, n_occ = ranked(sub, net, stage)
        res[ds] = {"net": net, "stage": stage, "species": top}
        print(f"{ds}: {len(top)} of {n_species} species with a catch on the core lines ({n_occ} occupations); "
              f"top: {', '.join(x['scientific'] for x in top[:6])}")
    with open(os.path.join(DATA, "eda_species.json"), "w") as f:
        json.dump(res, f, separators=(",", ":"))


if __name__ == "__main__":
    main()

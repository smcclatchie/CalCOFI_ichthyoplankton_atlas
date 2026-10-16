# build_roni.py

"""
The Relative Oceanic Nino Index (RONI) by atlas season, for the EDA view's
heat-content time series: docs/data/roni.json.

Source: NOAA CPC, https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt
(3-month running means, SEAS YR ANOM). The atlas's seasons are the CPC
seasons DJF (winter; CPC labels it with January's year, as the atlas labels
winter with the year of January and February), MAM (spring), JJA (summer)
and SON (autumn).

Usage:  python build_roni.py [--src FILE]   (default: download from CPC)
"""

import argparse
import io
import json
import os
import urllib.request

import pandas as pd

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt"
OUT = os.path.join(REPO_DIR, "docs", "data", "roni.json")
SEASONS = {"DJF": "winter", "MAM": "spring", "JJA": "summer", "SON": "autumn"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", help="a local copy of RONI.ascii.txt")
    args = ap.parse_args()
    text = open(args.src).read() if args.src else urllib.request.urlopen(URL, timeout=60).read().decode()
    df = pd.read_csv(io.StringIO(text), sep=r"\s+")
    df = df[df.SEAS.isin(SEASONS)]
    out = {"source": URL, "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"),
           "seasons": {f"{int(r.YR)}-{SEASONS[r.SEAS]}": round(float(r.ANOM), 2) for r in df.itertuples()}}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    keys = list(out["seasons"])
    print(f"{len(keys)} seasons, {keys[0]} to {keys[-1]} -> {OUT}")


if __name__ == "__main__":
    main()

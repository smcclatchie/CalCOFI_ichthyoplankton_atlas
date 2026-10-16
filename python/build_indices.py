# build_indices.py

"""
Climate indices by atlas season, for the EDA view's heat-content time series:

  docs/data/roni.json  Relative Oceanic Nino Index (NOAA CPC,
                       https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt):
                       3-month running means; the atlas's seasons are the CPC
                       seasons DJF (winter; CPC labels it with January's year,
                       as the atlas does), MAM, JJA and SON.
  docs/data/scti.json  Southern California Temperature Index (Rudnick et al.
                       2017, doi:10.1016/j.pocean.2017.03.002; data doi:
                       10.21238/S8SPRAY7292; https://spraydata.ucsd.edu/products/
                       socal-index/): the Spray glider (CUGN) temperature anomaly
                       at 50 m over the nearshore 200 km of line 90, a 3-month
                       running mean, monthly since 2007; a season takes its middle
                       month's value (Jan = winter Dec-Feb, Apr, Jul, Oct).

Usage:  python build_indices.py [--roni FILE]   (default: download both)
(Was build_roni.py, 2026-10-17, before the SCTI was added.)
"""

import argparse
import io
import json
import os
import urllib.request

import pandas as pd

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO_DIR, "docs", "data")
RONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt"
SCTI_URL = "https://spraydata.ucsd.edu/erddap/tabledap/socal_index_monthly_v1.csv"
CPC_SEASONS = {"DJF": "winter", "MAM": "spring", "JJA": "summer", "SON": "autumn"}
MIDDLE_MONTH = {1: "winter", 4: "spring", 7: "summer", 10: "autumn"}


def fetch(url):
    return urllib.request.urlopen(url, timeout=60).read().decode()


def write(name, source, seasons):
    path = os.path.join(DATA, name)
    with open(path, "w") as f:
        json.dump({"source": source, "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"), "seasons": seasons},
                  f, separators=(",", ":"))
    keys = list(seasons)
    print(f"{name}: {len(keys)} seasons, {keys[0]} to {keys[-1]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--roni", help="a local copy of RONI.ascii.txt")
    args = ap.parse_args()
    roni = pd.read_csv(io.StringIO(open(args.roni).read() if args.roni else fetch(RONI_URL)), sep=r"\s+")
    roni = roni[roni.SEAS.isin(CPC_SEASONS)]
    write("roni.json", RONI_URL, {f"{int(r.YR)}-{CPC_SEASONS[r.SEAS]}": round(float(r.ANOM), 2) for r in roni.itertuples()})
    scti = pd.read_csv(io.StringIO(fetch(SCTI_URL)), skiprows=[1])        # row 2: units
    scti["time"] = pd.to_datetime(scti.time)
    scti = scti[scti.time.dt.month.isin(MIDDLE_MONTH) & scti.scti.notna()]
    write("scti.json", SCTI_URL, {f"{t.year}-{MIDDLE_MONTH[t.month]}": round(float(v), 2) for t, v in zip(scti.time, scti.scti)})


if __name__ == "__main__":
    main()

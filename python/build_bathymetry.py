# build_bathymetry.py

"""
Depth contours for the atlas maps: one static set drawn under every survey.

Source: the bathymetry grid of Fishing Maps' daily CalCOFI 113-station maps
(recreational_fishing_high_resolution/data/bathymetry/CalCOFI_113_Station_CA_
pygmt_earth_relief_bathymetry.nc: GMT's Earth relief via PyGMT, 3 arc-second,
29.5-38.5 N, 126.5-116.25 W), untrimmed.

The grid is block-averaged to about 1 km (COARSEN x COARSEN cells), smoothed
with a small box filter so the lines are not jagged, contoured at LEVELS (m),
and each line simplified (SIMPLIFY_DEG) with fragments shorter than
MIN_LENGTH_DEG dropped (MIN_LENGTH_DEEP_DEG at 3000 and 4000 m, where the
abyssal plain breaks the contours into countless small rings).

Output: docs/data/bathymetry.geojson (LineStrings, property "depth" in m)

Usage:  python build_bathymetry.py [--grid FILE] [--out FILE]
"""

import argparse
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from shapely.geometry import LineString

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRID = ("/data_7TB/mnt/data/dynamic_data/projects/projects2022/recreational_fishing_high_resolution/"
        "data/bathymetry/CalCOFI_113_Station_CA_pygmt_earth_relief_bathymetry.nc")
OUT = os.path.join(REPO_DIR, "docs", "data", "bathymetry.geojson")
LEVELS = [200, 500, 1000, 2000, 3000, 4000]     # depths, m
COARSEN = 12                                    # 3 arc-seconds x 12 = 36 arc-seconds, ~1 km
SMOOTH = 3                                      # box filter width, cells
SIMPLIFY_DEG = 0.004
MIN_LENGTH_DEG = 0.08
# The abyssal plain lies near 3000-4000 m, where the contours break into
# countless small rings and squiggles: only long lines are kept there.
MIN_LENGTH_DEEP_DEG = {3000: 0.3, 4000: 0.5}


def box_smooth(z, n):
    """n x n moving mean (n odd), edges by reflection; NaN-free input."""
    pad = n // 2
    zp = np.pad(z, pad, mode="reflect")
    c = zp.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n * n)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--grid", default=GRID)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    ds = xr.open_dataset(args.grid)
    z = ds["elevation"].coarsen(lon=COARSEN, lat=COARSEN, boundary="trim").mean().load()
    lon, lat = z.lon.values, z.lat.values
    depth = box_smooth(-z.values.astype(float), SMOOTH)            # positive down
    print(f"grid {ds.sizes['lon']} x {ds.sizes['lat']} -> {len(lon)} x {len(lat)} "
          f"({abs(lon[1] - lon[0]) * 3600:.0f} arc-seconds)")

    cs = plt.contour(lon, lat, depth, levels=LEVELS)
    features = []
    for level, segs in zip(cs.levels, cs.allsegs):
        n = 0
        for seg in segs:
            if len(seg) < 2:
                continue
            line = LineString(seg).simplify(SIMPLIFY_DEG, preserve_topology=False)
            if line.length < MIN_LENGTH_DEEP_DEG.get(int(level), MIN_LENGTH_DEG):
                continue
            coords = [[round(x, 3), round(y, 3)] for x, y in line.coords]
            features.append({"type": "Feature", "properties": {"depth": int(level)},
                             "geometry": {"type": "LineString", "coordinates": coords}})
            n += 1
        print(f"  {int(level)} m: {n} lines")

    fc = {"type": "FeatureCollection", "features": features}
    with open(args.out, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(f"wrote {args.out}: {len(features)} lines, {os.path.getsize(args.out) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

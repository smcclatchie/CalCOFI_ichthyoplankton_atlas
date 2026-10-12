# CalCOFI Digital Atlas

By [Sam McClatchie](https://www.fishingmaps.info). (Repository: CalCOFI_ichthyoplankton_atlas.)

An interactive web atlas of fish eggs and larvae from CalCOFI plankton tows,
1951–2023: choose a species by common or scientific name, a life stage, net
type and sampling type, then step or play through the maps by month or by season (one season of
one year at a time), and click a station for its history.

A second view, **Hydrography**, maps temperature, salinity and density
(sigma-theta) at the CalCOFI standard depths (0–500 m) from the bottle
(1949–2021) or CTD (1993–2026) data, never mixed, as smooth contours: station
values are spread onto a grid as a Gaussian-weighted mean (e-folding scale
75 km by default, about the station spacing) and shown only within the
sampled area. Colour scales float with each map or are fixed for comparison
across chosen years (all seasons, or only the season shown), and the
ichthyoplankton for the same month or season can be overlaid. Variables:
temperature, salinity, density, dissolved oxygen, nitrate and silicate.

**Derived variables** maps the depth of the σθ = 25.0 surface, the
nitricline (steepest nitrate gradient), spiciness and N² (between standard
depths), and, for CTD casts, CalCOFI's own chlorophyll-maximum and mixed
layer depths. **Anomalies** maps any of these as departures from each
station's climatology (calendar month or season, at least 20 years).
**Water masses** maps temperature, salinity, dissolved oxygen and depth on the
σθ = 25.8 and 26.4 surfaces (about 100 m and 200 m), read from each CTD
downcast's own profile, and opens the ternary plot of winter water-mass
composition (OMP analysis) against warm- and cool-water indicator larvae.

The site is static (`docs/`) and is served by GitHub Pages. It uses
[MapLibre GL JS](https://maplibre.org/) and a Natural Earth coastline; no map
tile service or server is needed.

## Data

The station data come from the companion repository
[CalCOFI_digital_atlas](https://github.com/smcclatchie/CalCOFI_digital_atlas),
which converts the CalCOFI.io `swfsc_ichthyo.nc` download into station-level
GeoParquet: CalCOFI cruises and stations only, eggs and larvae and net types
kept separate, abundance standardised per 10 m² (oblique and vertical nets) or
per 100 m³ (Manta), and standard CalCOFI sampling separated from
high-resolution / special surveys. The hydrography comes from the same
repository's standard-depth tables (`build_bottle_standard_depths.py`,
`build_ctd_standard_depths.py`: record types, quality flags, range checks,
EOS-80 density). All of those rules live there; this repository only
reshapes that output for the browser.

## Rebuilding the data

```bash
# 1. In the companion repository, produce the station GeoParquet
#    (see its README / manuscript for setup).
# 2. Here:
conda env create -f environment.yml
conda activate calcofi_atlas
python python/build_atlas_data.py            # reads ../CalCOFI_digital_atlas by default
# or: python python/build_atlas_data.py --src-dir /path/to/geoparquet/folder
python python/build_hydro_data.py            # hydrography, also from ../CalCOFI_digital_atlas
```

This writes `docs/data/` (survey months, stations, station occupations, a
taxon list, one file per taxon, and the coastline) and `docs/data/hydro/`
(per source: survey months, stations, fixed colour ranges, and one file per
standard depth).

## Viewing locally

```bash
cd docs && python -m http.server 8000      # then open http://localhost:8000
```

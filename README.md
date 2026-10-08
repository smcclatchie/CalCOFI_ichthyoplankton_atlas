# CalCOFI Ichthyoplankton Atlas

An interactive web atlas of fish eggs and larvae from CalCOFI plankton tows,
1951–2023: choose a species by common or scientific name, a life stage, net
type and sampling type, then step or play through survey months, view
seasonal and multi-year composites, and click a station for its history.

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
high-resolution / special surveys. All of those rules live there; this
repository only reshapes that output for the browser.

## Rebuilding the data

```bash
# 1. In the companion repository, produce the station GeoParquet
#    (see its README / manuscript for setup).
# 2. Here:
conda env create -f environment.yml
conda activate calcofi_atlas
python python/build_atlas_data.py            # reads ../CalCOFI_digital_atlas by default
# or: python python/build_atlas_data.py --src-dir /path/to/geoparquet/folder
```

This writes `docs/data/` (survey months, stations, station occupations, a
taxon list, one file per taxon, and the coastline).

## Viewing locally

```bash
cd docs && python -m http.server 8000      # then open http://localhost:8000
```

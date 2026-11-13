# When Does the May Gray Burn Off?

DSC 106 (UC San Diego, Fall 2026) final project by Yash Goel: an explorable explanation of when and where
San Diego's May Gray and June Gloom clear, built with D3.

Live page: https://arnavgoel03.github.io/may-gray/

This is the initial prototype. Section 1 (the map with the hour slider, Play, year buttons, clickable places and
the linked chart) works; sections 2 to 4 are laid out as placeholders for the final version.

## Data

NOAA GOES-18 ABI Level 2 Clear Sky Mask (ABI-L2-ACMC, Pacific US sector), from the
[NOAA GOES-R registry on AWS](https://registry.opendata.aws/noaa-goes/). For every day of May and June in 2023,
2024 and 2025 (183 days), the first scan of each hour is put on a 0.02 degree grid over San Diego County.

- `scripts/fetch_acm.py` downloads one year (6 AM to 4 PM) and writes a cube:
  `uv run --with numpy --with h5py python scripts/fetch_acm.py --year 2023 --out data/raw/acm_2023.npz`.
- `scripts/export_data.py` turns the cubes into `data/cloud.json`, the share of days each cell was cloudy at each
  hour from 8 AM to 4 PM Pacific Daylight Time, pooled and per year. It also marks 21 cells that read far cloudier
  than their neighbours for several hours of the day; they are drawn in amber and left out of every number.
- `data/coast.json` is the Natural Earth 10 m coastline clipped to the map.

The mask counts any cloud, not only the marine layer.

## Run it

It is a static page: serve the folder (`python3 -m http.server`) and open it.

```
pnpm install      # Playwright, for the browser test only
pnpm data         # rebuild data/cloud.json from data/raw (needs uv)
pnpm test         # browser test against the local files
MAY_GRAY_URL=https://arnavgoel03.github.io/may-gray/ pnpm test   # same test against the published page
```

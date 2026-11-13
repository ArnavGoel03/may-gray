"""Turn the raw GOES-18 clear sky mask cubes into the one JSON file the page reads.

Input:  data/raw/acm_<year>.npz (from fetch_acm.py): bcm[day, hour, lat, lon], 0 clear, 1 cloudy, 255 missing.
Output: data/cloud.json with, for every year group ("all" plus each year), the share of days each grid cell was
        cloudy at each local hour, in tenths of a percent (-1 = no value).

Run: uv run --with numpy python scripts/export_data.py
"""
import glob
import json
import os
import warnings

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "cloud.json")

UTC_OFFSET = -7  # Pacific Daylight Time in May and June
# The mask misses much of the low cloud around sunrise (6 and 7 AM read lower than 8 AM, the opposite of how the
# marine layer behaves), so the page starts at the first hour the mask reads reliably.
FIRST_RELIABLE_HOUR = 8
# A cell is blanked when it differs from the median of its 5 x 5 neighbours (centre excluded) by more than
# OUTLIER_PTS at OUTLIER_MIN_HOURS or more hours: weather does not do that hour after hour, so it is the surface
# (mixed land and water pixels, bright or cold terrain). Same rule and values as the proposal graphs.
OUTLIER_PTS, OUTLIER_MIN_HOURS, NB = 0.20, 3, 2
NO_VALUE = -1
SCALE = 1000  # shares are stored as integer tenths of a percent

files = sorted(glob.glob(os.path.join(RAW, "acm_*.npz")))
assert files, "no cubes in data/raw"
cubes, years, day_year = [], [], []
for f in files:
    z = np.load(f, allow_pickle=False)
    y = int(os.path.basename(f)[4:8])
    cubes.append(z["bcm"]); years.append(y); day_year += [y] * z["bcm"].shape[0]
    lats, lons, hours_utc = z["lats"], z["lons"], z["hours_utc"]
bcm = np.concatenate(cubes)  # [day, hour, lat, lon]
day_year = np.array(day_year)
hours_local = (hours_utc + UTC_OFFSET) % 24
keep = hours_local >= FIRST_RELIABLE_HOUR
bcm, hours_local = bcm[:, keep], hours_local[keep]
valid = bcm < 2
cloudy = np.where(valid, bcm == 1, False)


def freq(days):
    with np.errstate(invalid="ignore", divide="ignore"):
        return cloudy[days].sum(0) / valid[days].sum(0)  # [hour, lat, lon]


every_day = np.ones(len(day_year), bool)
pooled = freq(every_day)
pad = np.pad(pooled, [(0, 0), (NB, NB), (NB, NB)], constant_values=np.nan)
nb = np.stack([pad[:, NB + di:pad.shape[1] - NB + di, NB + dj:pad.shape[2] - NB + dj]
               for di in range(-NB, NB + 1) for dj in range(-NB, NB + 1) if (di, dj) != (0, 0)])
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN windows at the box edge are expected
    off = np.abs(pooled - np.nanmedian(nb, axis=0)) > OUTLIER_PTS
mask = off.sum(0) >= OUTLIER_MIN_HOURS  # one static mask, used at every hour and for every year


def pack(grid):
    g = np.where(mask, np.nan, grid)
    out = np.where(np.isnan(g), NO_VALUE, np.round(g * SCALE)).astype(int)
    return [h.ravel().tolist() for h in out]  # one flat row-major [lat, lon] list per hour


step = round(float(lats[1] - lats[0]), 4)
doc = {
    "source": "NOAA GOES-18 ABI clear sky mask (ABI-L2-ACMC), first scan of each hour",
    "years": years,
    "days": {"all": int(len(day_year)), **{str(y): int((day_year == y).sum()) for y in years}},
    "hours": [int(h) for h in hours_local],
    "lat0": round(float(lats[0]), 4), "lon0": round(float(lons[0]), 4), "step": step,
    "nlat": int(len(lats)), "nlon": int(len(lons)),
    "scale": SCALE, "noValue": NO_VALUE,
    "masked": np.flatnonzero(mask.ravel()).tolist(),
    "grids": {"all": pack(pooled), **{str(y): pack(freq(day_year == y)) for y in years}},
}
with open(OUT, "w") as fh:
    json.dump(doc, fh, separators=(",", ":"))
print(f"wrote {OUT}: {os.path.getsize(OUT)} bytes, {len(doc['masked'])} masked cells, days {doc['days']}")

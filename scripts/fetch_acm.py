"""Fetch GOES-18 ABI clear sky mask (ABI-L2-ACMC) hourly for May and June of one year,
regrid to a regular lat/lon grid over San Diego County, and save a compact cube.

Output (--out): data/raw/acm_<year>.npz with
  bcm[day, hour, lat, lon]  uint8: 0 clear, 1 cloudy, 255 missing (no file or fill value)
  lats, lons                grid cell centres (degrees)
  dates                     ISO dates (May 1 to June 30)
  hours_utc                 UTC hours sampled
  files                     S3 key used for each (day, hour), '' when missing

Run: uv run --with numpy --with h5py python scripts/fetch_acm.py --year 2023 --out data/raw/acm_2023.npz
It reads about 670 files a year from S3, so it is quickest from a machine close to AWS us-east-1.
One file per hour: the first 5-minute CONUS scan that starts in that hour.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import io
import re
import sys
import time
import urllib.request

import h5py
import numpy as np

BUCKET = "https://noaa-goes18.s3.amazonaws.com"
PRODUCT = "ABI-L2-ACMC"
# San Diego County coast to the inland mountains, with ocean to the west.
LAT_MIN, LAT_MAX = 32.50, 33.60
LON_MIN, LON_MAX = -118.00, -116.00
STEP = 0.02  # degrees, about 2.2 km: finer than the cloud mask pixel here (about 4 to 5 km), so neighbouring cells often repeat one pixel
# 6 AM to 4 PM Pacific Daylight Time (UTC-7): covers formation-at-dawn through burn-off.
HOURS_UTC = list(range(13, 24))
RETRIES = 4


def get(url, timeout=60):
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network errors: retry with backoff
            if attempt == RETRIES - 1:
                raise
            time.sleep(2 ** attempt)


def first_key(day, hour):
    doy = day.timetuple().tm_yday
    prefix = f"{PRODUCT}/{day.year}/{doy:03d}/{hour:02d}/"
    xml = get(f"{BUCKET}/?list-type=2&prefix={prefix}").decode()
    keys = sorted(re.findall(r"<Key>([^<]+\.nc)</Key>", xml))
    return keys[0] if keys else ""


def grid_indices(f):
    """Map each target lat/lon cell to the nearest ABI fixed-grid pixel (GOES-R PUG formulas)."""
    p = f["goes_imager_projection"].attrs
    a = float(p["semi_major_axis"][0])
    b = float(p["semi_minor_axis"][0])
    h = float(p["perspective_point_height"][0]) + a
    lon0 = np.radians(float(p["longitude_of_projection_origin"][0]))
    e2 = (a * a - b * b) / (a * a)

    def coord(name):
        d = f[name]
        return d[:].astype(np.float64) * d.attrs["scale_factor"][0] + d.attrs["add_offset"][0]

    xs, ys = coord("x"), coord("y")
    lats = np.round(np.arange(LAT_MIN, LAT_MAX + 1e-9, STEP), 4)
    lons = np.round(np.arange(LON_MIN, LON_MAX + 1e-9, STEP), 4)
    lon2, lat2 = np.meshgrid(np.radians(lons), np.radians(lats))
    phic = np.arctan((b * b) / (a * a) * np.tan(lat2))
    rc = b / np.sqrt(1 - e2 * np.cos(phic) ** 2)
    sx = h - rc * np.cos(phic) * np.cos(lon2 - lon0)
    sy = -rc * np.cos(phic) * np.sin(lon2 - lon0)
    sz = rc * np.sin(phic)
    x = np.arcsin(-sy / np.sqrt(sx * sx + sy * sy + sz * sz))
    y = np.arctan(sz / sx)
    # x increases with index, y decreases with index in ABI files
    ix = np.rint((x - xs[0]) / (xs[1] - xs[0])).astype(int)
    iy = np.rint((y - ys[0]) / (ys[1] - ys[0])).astype(int)
    if ix.min() < 0 or iy.min() < 0 or ix.max() >= xs.size or iy.max() >= ys.size:
        sys.exit("target box falls outside the CONUS sector")
    return lats, lons, iy, ix


def read_bcm(raw, idx):
    with h5py.File(io.BytesIO(raw), "r") as f:
        if idx[0] is None:
            idx[0] = grid_indices(f)
        lats, lons, iy, ix = idx[0]
        y0, y1, x0, x1 = iy.min(), iy.max() + 1, ix.min(), ix.max() + 1
        sub = f["BCM"][y0:y1, x0:x1]
        return sub[iy - y0, ix - x0].astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--days", type=int, default=0, help="limit to the first N days (smoke test)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    start = dt.date(a.year, 5, 1)
    dates = [start + dt.timedelta(d) for d in range((dt.date(a.year, 7, 1) - start).days)]
    if a.days:
        dates = dates[: a.days]
    jobs = [(di, hi, d, h) for di, d in enumerate(dates) for hi, h in enumerate(HOURS_UTC)]

    with cf.ThreadPoolExecutor(16) as ex:
        keys = list(ex.map(lambda j: first_key(j[2], j[3]), jobs))

    # Build the grid mapping from the first available file, then fetch the rest in parallel.
    idx = [None]
    first = next(i for i, k in enumerate(keys) if k)
    read_bcm(get(f"{BUCKET}/{keys[first]}"), idx)
    lats, lons, _, _ = idx[0]
    cube = np.full((len(dates), len(HOURS_UTC), lats.size, lons.size), 255, np.uint8)
    files = np.full((len(dates), len(HOURS_UTC)), "", dtype=object)

    def work(i):
        di, hi, _, _ = jobs[i]
        if not keys[i]:
            return i, None
        return i, read_bcm(get(f"{BUCKET}/{keys[i]}"), idx)

    done = 0
    with cf.ThreadPoolExecutor(16) as ex:
        for i, grid in ex.map(work, range(len(jobs))):
            di, hi, _, _ = jobs[i]
            files[di, hi] = keys[i]
            if grid is not None:
                grid = grid.copy()
                grid[grid > 1] = 255  # fill values
                cube[di, hi] = grid
            done += 1
            if done % 100 == 0:
                print(f"{done}/{len(jobs)}", flush=True)

    missing = int((files == "").sum())
    print(f"year {a.year}: {len(jobs)} slots, {missing} without a file, "
          f"cloudy share {np.mean(cube[cube < 2]):.3f}")
    np.savez_compressed(
        a.out, bcm=cube, lats=lats, lons=lons,
        dates=np.array([d.isoformat() for d in dates]),
        hours_utc=np.array(HOURS_UTC), files=files.astype(str),
    )


if __name__ == "__main__":
    main()

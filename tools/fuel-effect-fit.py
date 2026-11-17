"""Fit the fuel-weight effect (s per kg per lap) across LMU recordings with different fuel loads (spike vroom-d4g).

    uv run --with duckdb --with numpy python -I tools/fuel-effect-fit.py <telemetry dir> <scratch dir> "<track prefix>" "<car prefix>" [kinds]

Within one stint fuel load and lap number move together, so a stint alone cannot split the fuel effect from tyre wear. Across
sessions the start load differs (qualifying on 10 L, races on 40 L, practice on 80 L) while tyre age restarts at each out lap,
so one least-squares fit over all sessions, lap time = a + k * fuel_kg + d * tyre_age_laps, can estimate both k and d.
Confounders it cannot remove: the driver improving over days, track temperature, effort (qualifying against race pace).

Each recording is COPIED into <scratch dir> and opened read-only (recordings are never modified); the copy is deleted after.
kinds: session types to use, any of P Q R (default PQR). Fuel density 0.74 kg/L. Out laps, in laps, invalid laps, laps more
than 2 % off their session's median and laps more than 3 % off the overall median are left out. Prints no driver name.
"""
import bisect
import glob
import os
import shutil
import statistics as st
import sys

import duckdb
import numpy as np

RHO = 0.74


def session_laps(path, scratch, n):
    dst = os.path.join(scratch, f"fuel-fit-{n}.duckdb")
    shutil.copyfile(path, dst)
    c = duckdb.connect(dst, read_only=True)
    try:
        q = lambda s: c.execute(s).fetchall()
        tabs = {r[0] for r in q("show tables")}
        if "channelsList" not in tabs:
            return None, []
        car = dict(q("select key, value from metadata where key = 'CarName'")).get("CarName", "") if "metadata" in tabs else ""
        freq = dict(q("select channelName, frequency from channelsList"))
        t0 = q('select min(value) from "GPS Time"')[0][0]
        if t0 is None:
            return None, []  # an empty recording
        end = t0 + (q('select count(*) from "GPS Time"')[0][0] - 1) / freq["GPS Time"]
        fuel = [r[0] for r in q('select value from "Fuel Level"')]
        ft = [t0 + i / freq["Fuel Level"] for i in range(len(fuel))]
        at = lambda t: fuel[min(max(bisect.bisect_right(ft, t) - 1, 0), len(fuel) - 1)]
        laps = q('select ts, value from "Lap" order by ts')
        times = q('select ts, value from "Lap Time" order by ts')
        pits = q('select ts, value from "In Pits" order by ts')
        out, age = [], 0
        for k, (a, _) in enumerate(laps):
            b = laps[k + 1][0] if k + 1 < len(laps) else end
            t = [x[1] for x in times if abs(x[0] - b) < 0.05] if k + 1 < len(laps) else []
            starts_in_pits = [p[1] for p in pits if p[0] <= a + 0.01][-1:] == [1]
            if k == 0 or starts_in_pits:
                age = 0
                continue
            age += 1
            f0, f1 = at(a), at(b - 0.11)
            if any(a < p[0] <= b and p[1] for p in pits) or not t or not t[0] or f1 > f0:
                continue  # in lap, invalid or untimed lap, or a refuel during the lap
            out.append((t[0], (f0 + f1) / 2 * RHO, age))
        return car, out
    finally:
        c.close()
        os.remove(dst)


def main(src, scratch, track, car_prefix, kinds="PQR"):
    pts, sessions = [], 0
    for n, f in enumerate(sorted(glob.glob(os.path.join(src, "*.duckdb")))):
        name = os.path.basename(f)
        if not name.startswith(track) or name.split("_")[1] not in kinds:
            continue
        car, laps = session_laps(f, scratch, n)
        if not car or not car.startswith(car_prefix) or not laps:
            continue
        m = st.median(l[0] for l in laps)
        laps = [l for l in laps if l[0] <= m * 1.02]
        pts += laps
        sessions += 1
    g = st.median(p[0] for p in pts)
    pts = [p for p in pts if p[0] <= g * 1.03]
    t = np.array([p[0] for p in pts])
    X = np.column_stack([np.ones_like(t), [p[1] for p in pts], [p[2] for p in pts]])
    b, *_ = np.linalg.lstsq(X, t, rcond=None)
    r = t - X @ b
    s2 = r @ r / (len(t) - X.shape[1])
    se = np.sqrt(np.diag(s2 * np.linalg.inv(X.T @ X)))
    print(f"{len(t)} laps from {sessions} sessions, fuel {X[:, 1].min():.0f}-{X[:, 1].max():.0f} kg")
    print(f"fuel effect {b[1]:.4f} +- {se[1]:.4f} s/kg per lap; tyre age {b[2]:.4f} +- {se[2]:.4f} s/lap; residual sd {np.sqrt(s2):.3f} s")


if __name__ == "__main__":
    main(*sys.argv[1:])

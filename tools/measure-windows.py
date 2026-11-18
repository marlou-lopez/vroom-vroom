"""Measured tyre and brake working windows per car class, from the driver's own LMU recordings (vroom-0dg).

    uv run --with duckdb --with numpy python -I tools/measure-windows.py <Telemetry folder> <scratch dir> [--min-laps 30] [--min-tracks 2]

Every *.duckdb in the folder is COPIED into the scratch dir first and the copy is opened read-only (recordings must never be
modified; the copy is deleted afterwards). Per recording it keeps valid flying laps (not the first lap, not a lap that starts or
ends in the pits, lap time > 0), groups them by car and track, keeps the fastest 20 % of each group (at least 1 lap, groups
under 5 flying laps are skipped), and pools those laps per car class (the recording's CarClass). Per class it prints the 10th
and 90th percentile of: tyre surface temperature (mean of the three tread zones) and carcass temperature per axle, hot
pressure per axle, tread edge-to-edge spread per axle, brake disc temperature per axle, and the front/rear brake temperature
ratio, with the number of laps, cars and tracks behind each value.
Wheel order is FL, FR, RL, RR. No driver name is read (the repo is public).

The `window` rows are what windows.md and reportWindows.ts take: surface, carcass, pressure and brake pool both axles (the
report judges both axles against one window), spread uses 0 and the p90 of the pooled axles, the ratio is p10..p90. A value with
fewer than --min-laps laps or --min-tracks tracks is printed as "too little data" and stays an assumption.
"""
import argparse
import bisect
import datetime
import math
import os
import shutil
import sys
from collections import defaultdict

import duckdb
import numpy as np

W = "value1, value2, value3, value4"
KEYS = ("tyre_surface_c", "tyre_carcass_c", "tyre_pressure_kpa", "tyre_spread_c", "brake_c", "brake_front_rear_ratio")


def lap_rows(src: str):
    """(meta, [per-lap dict]) for the valid flying laps of one recording copy."""
    c = duckdb.connect(src, read_only=True)
    q = lambda s: c.execute(s).fetchall()
    meta = dict(q("select key, value from metadata where key in ('CarClass','CarName','TrackName','TrackLayout','SessionType')"))
    freq = dict(q("select channelName, frequency from channelsList"))
    t0 = q('select min(value) from "GPS Time"')[0][0]
    end = t0 + (q('select count(*) from "GPS Time"')[0][0] - 1) / freq["GPS Time"]

    def series(name):
        a = np.array(q(f'select {W} from "{name}"'), dtype=float)
        return t0 + np.arange(len(a)) / freq[name], a

    def mean(s, a, b):
        i, j = np.searchsorted(s[0], a), np.searchsorted(s[0], b)
        return s[1][i:j].mean(axis=0) if j > i else None

    zones = [series(n) for n in ("TyresTempLeft", "TyresTempCentre", "TyresTempRight")]
    carcass, pres, brakes = series("TyresCarcassTemp"), series("TyresPressure"), series("Brakes Temp")
    laps = q('select ts, value from "Lap" order by ts')
    times = q('select ts, value from "Lap Time" order by ts')
    pits = q('select ts, value from "In Pits" order by ts')
    pit_ts = [p[0] for p in pits]

    def in_pits(t):
        i = bisect.bisect_right(pit_ts, t) - 1
        return i >= 0 and bool(pits[i][1])

    out = []
    for k, (a, lap_no) in enumerate(laps):
        if k == 0 or k + 1 >= len(laps):
            continue
        b = laps[k + 1][0]
        if in_pits(a + 0.01) or any(a < p[0] <= b and p[1] for p in pits):
            continue
        t = [x[1] for x in times if abs(x[0] - b) < 0.05]
        if not t or not t[0] or t[0] <= 0:
            continue
        z = [mean(s, a, b) for s in zones]
        cc, pp, bb = mean(carcass, a, b), mean(pres, a, b), mean(brakes, a, b)
        if any(v is None for v in (*z, cc, pp, bb)):
            continue
        surf = sum(z) / 3
        edge = np.abs(z[0] - z[2])  # per wheel; left and right tread edges
        out.append({
            "time": t[0],
            "tyre_surface_c": surf, "tyre_carcass_c": cc, "tyre_pressure_kpa": pp, "brake_c": bb,
            "tyre_spread_c": edge,
        })
    c.close()
    return meta, out


def axle(v):
    return {"front": (v[0] + v[1]) / 2, "rear": (v[2] + v[3]) / 2}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("scratch")
    ap.add_argument("--min-laps", type=int, default=30)
    ap.add_argument("--min-tracks", type=int, default=2)
    args = ap.parse_args()
    os.makedirs(args.scratch, exist_ok=True)
    groups = defaultdict(list)  # (class, car, track) -> laps
    n_files = 0
    for name in sorted(os.listdir(args.folder)):
        if not name.endswith(".duckdb"):
            continue
        copy = os.path.join(args.scratch, "copy.duckdb")
        shutil.copyfile(os.path.join(args.folder, name), copy)
        wal = os.path.join(args.folder, name + ".wal")
        if os.path.exists(wal):
            shutil.copyfile(wal, copy + ".wal")
        try:
            meta, laps = lap_rows(copy)
        except Exception as e:  # unreadable or incomplete recording
            print(f"skip {name}: {type(e).__name__}: {str(e)[:80]}", file=sys.stderr)
            continue
        finally:
            for p in (copy, copy + ".wal"):
                if os.path.exists(p):
                    os.remove(p)
        n_files += 1
        key = (meta.get("CarClass", "?"), meta.get("CarName", "?"), meta.get("TrackName", "?"))
        groups[key].extend(laps)
        print(f"{name}: {key[0]} / {key[1]} / {key[2]}: {len(laps)} flying laps", file=sys.stderr)

    pooled = defaultdict(list)  # class -> [(car, track, lap)]
    skipped = 0
    for (cls, car, track), laps in groups.items():
        if len(laps) < 5:
            skipped += len(laps)
            continue
        laps = sorted(laps, key=lambda l: l["time"])[: max(1, math.ceil(0.2 * len(laps)))]
        pooled[cls].extend((car, track, l) for l in laps)

    print(f"{n_files} recordings, {sum(len(v) for v in groups.values())} valid flying laps ({skipped} in car-and-track groups under 5 laps, skipped)")
    today = datetime.date.today().isoformat()
    print(f"date {today}; minimum for a measured value: {args.min_laps} laps from {args.min_tracks} tracks\n")
    for cls in sorted(pooled):
        items = pooled[cls]
        cars = sorted({i[0] for i in items})
        tracks = sorted({i[1] for i in items})
        print(f"== {cls}: {len(items)} laps (fastest 20 % per car and track), {len(cars)} car entries (CarName is the entry, not the model), {len(tracks)} tracks")
        print(f"   cars: {', '.join(cars)}\n   tracks: {', '.join(tracks)}")
        vals = defaultdict(list)  # (key, axle) -> [values]
        for _, _, l in items:
            for k in ("tyre_surface_c", "tyre_carcass_c", "tyre_pressure_kpa", "brake_c"):
                for ax, v in axle(l[k]).items():
                    vals[(k, ax)].append(v)
            for ax, v in axle(l["tyre_spread_c"]).items():
                vals[("tyre_spread_c", ax)].append(v)
            b = axle(l["brake_c"])
            if b["rear"] > 0:
                vals[("brake_front_rear_ratio", "both")].append(b["front"] / b["rear"])
        ok = len(items) >= args.min_laps and len(tracks) >= args.min_tracks
        print(f"   {'key':26} {'axle':6} {'p10':>8} {'p90':>8}")
        for (k, ax), v in sorted(vals.items(), key=lambda x: (KEYS.index(x[0][0]), x[0][1])):
            print(f"   {k:26} {ax:6} {np.percentile(v, 10):8.2f} {np.percentile(v, 90):8.2f}")
        print(f"   window rows (laps {len(items)}, cars {len(cars)}, tracks {len(tracks)}):")
        if not ok:
            print("   too little data: stays an assumption")
        else:
            for k in KEYS:
                v = vals[(k, "front")] + vals[(k, "rear")] if (k, "both") not in vals else vals[(k, "both")]
                lo = 0.0 if k == "tyre_spread_c" else float(np.percentile(v, 10))
                print(f"   {k:26} min {lo:8.2f} max {np.percentile(v, 90):8.2f}   measured: {len(items)} laps, {len(cars)} car entries, {len(tracks)} tracks, {today}")
        print()


if __name__ == "__main__":
    main()

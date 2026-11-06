"""Checks the cockpit camera's attitude estimate against the exact orientation in a capture.

    python3.14 attitude_check.py CAPTURE.lmucap GRID.json [--lmu-dir DIR] [--fit-lap N]
                                 [--survey SURVEY.json ...] [--fixture OUT.json]

GRID.json is what tools/extract-laps.mjs writes from the SAME session's .duckdb recording (copy the recording first and
never modify it). CAPTURE.lmucap is the logger's capture of that session. Both use the game's clock, so each grid metre
gets a time (lap start_ts + t) and the capture's orientation matrix at that time is the ground truth.

Truth per grid metre, from `mOri` (rows of the vehicle-to-world matrix, vehicle +x left, +y up, +z back, world y up;
see docs/lmu-duckdb-schema.md "Shared memory"):
    forward = -column 2, left = column 0
    yaw   = atan2(forward_z, forward_x)   (world x = east, z = north; 0 = east, counter-clockwise)
    pitch = asin(forward_y)               (nose up positive)
    roll  = asin(left_y)                  (left side up = leaning right, positive)

The estimate mirrors frontend/src/lib/carAttitude.ts (keep the constants in sync; frontend/src/lib/carAttitude.spa.test.ts
runs the real TypeScript against a fixture written by --fixture):
    heading = chord of the GPS line, +-HEADING_HALF_M
    pitch   = road slope + PITCH_REST + K_PITCH * g_long       (g_long > 0 is braking)
    roll    = K_ROLL * g_lat + bank                            (g_lat > 0 is a left turn; roll > 0 leans right)

--survey (repeatable) is a decode.py survey file with road-bank samples: the bank profile is mapped onto the flying lap's grid
like frontend/src/lib/trackSurvey.ts mapSurvey does (nearest metre of the lap within 15 m, median per metre, gaps up to
8 m interpolated) and added to the roll; the errors of every lap are printed for each survey file. Use a survey built
from other captures than the one checked (the 2026-11-06 ones) for an independent test.

Prints: the gains fitted on the flying lap, the errors per lap, and the slip angle (true yaw - path heading).
Streams the capture; only one compact sample per telemetry tick is kept (no frames are collected).
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Shipped constants (degrees), as in carAttitude.ts.
HEADING_HALF_M = 5
SLOPE_HALF_M = 3
G_SMOOTH_HALF_M = 4
LINE_SMOOTH_HALF = 4        # scene.lap = lineFromGps(raw, 4) in the 3D view
HEIGHT_SMOOTH_HALF = 2      # roadHeights() smoothing
PITCH_REST_DEG = -0.22
K_PITCH_DEG = -0.294
K_ROLL_DEG = 0.476
BANK_SMOOTH_HALF_M = 4       # carAttitude.ts BANK_SMOOTH_HALF_M
SURVEY_MATCH_M = 15         # trackSurvey.ts SURVEY_MATCH_M
SURVEY_GAP_M = 8            # trackSurvey.ts SURVEY_GAP_M

R_M_PER_DEG = 6371008.8 * math.pi / 180
COS60 = math.cos(math.radians(60))
NFIELD = 13  # elapsed, pos xyz, ori 3x3


def load_samples(path, lmu_dir):
    import os
    if lmu_dir:
        os.environ["LMU_DIR"] = lmu_dir
    import decode
    import layout as lay
    sc = decode.Schema(lay.load())
    names = ["mElapsedTime", "mPos_x", "mPos_y", "mPos_z"] + [f"mOri_{r}_{a}" for r in range(3) for a in "xyz"]
    cols = [sc.index[n] for n in names]
    out = array("d")
    for _perf, tel, _scor, _f in decode.iter_player(path, sc):
        for c in cols:
            out.append(tel[c])
    return out


def truth(samples, lap):
    """Per grid metre: x, y(up), z, yaw, pitch, roll of the player's car (radians, metres)."""
    n_s = len(samples) // NFIELD
    et = [samples[NFIELD * i] for i in range(n_s)]
    rows = []
    for d in range(len(lap["t"])):
        t = lap["start_ts"] + lap["t"][d]
        i = min(max(bisect.bisect_right(et, t) - 1, 0), n_s - 2)
        f = min(max((t - et[i]) / (et[i + 1] - et[i]), 0.0), 1.0)
        v = [samples[NFIELD * i + k] * (1 - f) + samples[NFIELD * (i + 1) + k] * f for k in range(1, NFIELD)]
        x, y, z = v[0:3]
        o = v[3:]
        fw = (-o[2], -o[5], -o[8])
        lf = (o[0], o[3], o[6])
        rows.append((x, y, z,
                     math.atan2(fw[2], fw[0]),
                     math.asin(max(-1, min(1, fw[1] / math.hypot(*fw)))),
                     math.asin(max(-1, min(1, lf[1] / math.hypot(*lf))))))
    return rows


def smooth_open(v, half):
    n = len(v)
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n - 1, i + half)
        out.append(sum(v[lo:hi + 1]) / (hi - lo + 1))
    return out


def smooth_closed(v, half):
    n = len(v)
    return [sum(v[(i + k) % n] for k in range(-half, half + 1)) / (2 * half + 1) for i in range(n)]


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))]


def abs_stats(errs_rad):
    a = [abs(math.degrees(e)) for e in errs_rad]
    return pct(a, 0.5), pct(a, 0.9), max(a)


def lsq(rows, y):
    k = len(rows[0])
    a = [[sum(r[i] * r[j] for r in rows) for j in range(k)] for i in range(k)]
    b = [sum(r[i] * yy for r, yy in zip(rows, y)) for i in range(k)]
    for i in range(k):
        p = a[i][i]
        for j in range(i, k):
            a[i][j] /= p
        b[i] /= p
        for r in range(k):
            if r != i:
                f = a[r][i]
                for j in range(i, k):
                    a[r][j] -= f * a[i][j]
                b[r] -= f * b[i]
    return b


def survey_bank(survey, fit_lap):
    """Bank (radians, right side lower positive) per grid metre of `fit_lap`, None where unmeasured. Mirrors mapSurvey."""
    n = fit_lap.n
    east = [lon * R_M_PER_DEG * COS60 for lon in fit_lap.lon]
    north = [(lat - 60) * R_M_PER_DEG for lat in fit_lap.lat]
    cells = {}
    for i in range(n):
        cells.setdefault((int(east[i] // 15), int(north[i] // 15)), []).append(i)
    groups = [[] for _ in range(n)]
    for x, z, deg in survey.get("bank", []):
        cx, cz = int(x // 15), int(z // 15)
        best, bi = SURVEY_MATCH_M, None
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for i in cells.get((cx + dx, cz + dz), ()):
                    d = math.hypot(x - east[i], z - north[i])
                    if d <= best:
                        best, bi = d, i
        if bi is not None:
            groups[bi].append(deg)
    v = [sorted(g)[len(g) // 2] if len(g) % 2 else (sorted(g)[len(g) // 2 - 1] + sorted(g)[len(g) // 2]) / 2 if g else None for g in groups]
    prev = -1
    for i in range(n):
        if v[i] is None:
            continue
        if prev >= 0 and 1 < i - prev <= SURVEY_GAP_M:
            for k in range(prev + 1, i):
                v[k] = v[prev] + (v[i] - v[prev]) * (k - prev) / (i - prev)
        prev = i
    return [None if x is None else math.radians(x) for x in v]


def smooth_none(v, half):
    """Moving average with unknown (None) counted as 0, shrinking at the ends, like carAttitude.ts."""
    return smooth_open([0.0 if x is None else x for x in v], half)


class Lap:
    def __init__(self, lap, tr):
        self.no = lap["lap_no"]
        self.lat = lap["lat"][:len(tr)]
        self.lon = lap["lon"][:len(tr)]
        self.time = lap.get("lap_time_s")
        n = len(tr)
        self.n = n
        east = [lap["lon"][d] * R_M_PER_DEG * COS60 for d in range(n)]
        north = [(lap["lat"][d] - 60) * R_M_PER_DEG for d in range(n)]
        self.x = smooth_closed(east, LINE_SMOOTH_HALF)
        self.y = smooth_closed(north, LINE_SMOOTH_HALF)
        h = smooth_open([q[1] for q in tr], HEIGHT_SMOOTH_HALF)
        self.height = h
        self.raw_height = [q[1] for q in tr]
        self.yaw = [q[3] for q in tr]
        self.pitch = [q[4] for q in tr]
        self.roll = [q[5] for q in tr]
        self.g_lat = smooth_open(lap["g_lat"][:n], G_SMOOTH_HALF_M)
        self.g_long = smooth_open(lap["g_long"][:n], G_SMOOTH_HALF_M)
        self.heading = []
        self.slope = []
        for i in range(n):
            a, b = max(i - HEADING_HALF_M, 0), min(i + HEADING_HALF_M, n - 1)
            self.heading.append(math.atan2(self.y[b] - self.y[a], self.x[b] - self.x[a]))
            sa, sb = max(i - SLOPE_HALF_M, 0), min(i + SLOPE_HALF_M, n - 1)
            run = math.hypot(self.x[sb] - self.x[sa], self.y[sb] - self.y[sa])
            self.slope.append(math.atan2(h[sb] - h[sa], run) if run > 0.1 else 0.0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("capture")
    ap.add_argument("grid")
    ap.add_argument("--lmu-dir")
    ap.add_argument("--fit-lap", type=int, default=1, help="lap_no of the flying lap the pitch gains are fitted on")
    ap.add_argument("--survey", action="append", default=[], help="survey JSON with bank samples (repeatable)")
    ap.add_argument("--fixture", help="write the flying lap's inputs and truth, quantised, for the TypeScript test")
    args = ap.parse_args(argv)

    grid = json.load(open(args.grid))
    samples = load_samples(args.capture, args.lmu_dir)
    print(f"{len(samples) // NFIELD} telemetry samples")
    laps = [Lap(l, truth(samples, l)) for l in grid["laps"]]
    fit = next(l for l in laps if l.no == args.fit_lap)
    deg = math.degrees

    # Pitch relative to the road slope = rest + K * g_long, fitted on the flying lap.
    res = [fit.pitch[i] - fit.slope[i] for i in range(fit.n)]
    rest, kp = lsq([[1, g] for g in fit.g_long], res)
    print(f"\nPITCH fitted on lap {fit.no}: rest {deg(rest):+.3f} deg, K_PITCH {deg(kp):+.3f} deg per g of braking")
    # Roll: a fit on one lap mixes in the road's banking (it repeats every lap at the same metre and correlates with the
    # corners). The same metre across laps separates them.
    k1 = lsq([[g] for g in fit.g_lat], fit.roll)[0]
    n = min(l.n for l in laps)
    num = den = 0.0
    for i in range(n):
        gs = [l.g_lat[i] for l in laps]
        rs = [l.roll[i] for l in laps]
        mg, mr = sum(gs) / len(gs), sum(rs) / len(rs)
        num += sum((g - mg) * (r - mr) for g, r in zip(gs, rs))
        den += sum((g - mg) ** 2 for g in gs)
    kw = num / den
    print(f"ROLL K on lap {fit.no} alone (road banking mixed in): {deg(k1):+.3f} deg per g of left-turn g")
    print(f"ROLL K within the same metre across {len(laps)} laps (banking removed): {deg(kw):+.3f} deg per g")
    print(f"shipped: rest {PITCH_REST_DEG:+.3f}, K_PITCH {K_PITCH_DEG:+.3f}, K_ROLL {K_ROLL_DEG:+.3f} (deg)")

    rest_r, kp_r, kr_r = (math.radians(v) for v in (PITCH_REST_DEG, K_PITCH_DEG, K_ROLL_DEG))
    print("\nERRORS in degrees: median / p90 / max")
    print("lap  kind      pitch (slope+dive)   pitch slope only     roll (K*g)           roll zero            roll within-metre K  slip |yaw - path|")
    banks = None
    for l in laps:
        kind = "flying" if l.no == fit.no else ("out" if l.no < fit.no else "in")
        pe = [l.pitch[i] - (l.slope[i] + rest_r + kp_r * l.g_long[i]) for i in range(l.n)]
        ps = [l.pitch[i] - l.slope[i] for i in range(l.n)]
        re = [l.roll[i] - kr_r * l.g_lat[i] for i in range(l.n)]
        rz = list(l.roll)
        r1 = [l.roll[i] - kw * l.g_lat[i] for i in range(l.n)]
        se = [wrap(l.yaw[i] - l.heading[i]) for i in range(l.n)]
        f = lambda s: "%5.2f %5.2f %5.2f" % s
        print(f"{l.no:<4} {kind:<8}  {f(abs_stats(pe))}    {f(abs_stats(ps))}    {f(abs_stats(re))}    {f(abs_stats(rz))}    {f(abs_stats(r1))}    {f(abs_stats(se))}")
    print("\nSigned slip (yaw - path heading), flying lap: mean %+.2f deg, p5 %+.2f, p95 %+.2f" % (
        deg(sum(wrap(fit.yaw[i] - fit.heading[i]) for i in range(fit.n)) / fit.n),
        deg(sorted(wrap(fit.yaw[i] - fit.heading[i]) for i in range(fit.n))[int(0.05 * fit.n)]),
        deg(sorted(wrap(fit.yaw[i] - fit.heading[i]) for i in range(fit.n))[int(0.95 * fit.n)])))
    big = sum(1 for i in range(fit.n) if abs(wrap(fit.yaw[i] - fit.heading[i])) > math.radians(2))
    print(f"metres with slip above 2 deg: {big} of {fit.n} ({100 * big / fit.n:.1f} %)")

    # Road banking from survey captures: the bank profile mapped on the flying lap's grid, applied to every lap by index.
    for path in args.survey:
        sv = json.load(open(path))
        bank = smooth_none(survey_bank(sv, fit), BANK_SMOOTH_HALF_M)
        known = sum(1 for x in survey_bank(sv, fit) if x is not None)
        print(f"\nRoll error with the road bank from {Path(path).name} ({len(sv.get('bank', []))} cells, {known} of {fit.n} metres measured, "
              f"captures {', '.join(sv.get('captures', []))}):")
        for l in laps:
            m = min(l.n, fit.n)
            e = [l.roll[i] - kr_r * l.g_lat[i] - bank[i] for i in range(m)]
            z = [l.roll[i] - kr_r * l.g_lat[i] for i in range(m)]
            print("  lap %d: bank %5.2f %5.2f %5.2f   (no bank %5.2f %5.2f %5.2f)" % ((l.no,) + abs_stats(e) + abs_stats(z)))

    if args.fixture:
        q = lambda v, s: [int(round(x * s)) for x in v]
        lap = next(l for l in grid["laps"] if l["lap_no"] == fit.no)
        east = [lap["lon"][d] * R_M_PER_DEG * COS60 for d in range(fit.n)]
        north = [(lap["lat"][d] - 60) * R_M_PER_DEG for d in range(fit.n)]
        fx = {
            "note": "Spa 2026-11-05 flying lap: GPS (east, north in cm), road height (cm), grid g_lat/g_long (mg), and the capture's true yaw/pitch/roll (0.01 deg). Written by tools/lmu-logger/attitude_check.py --fixture.",
            "east_cm": q(east, 100), "north_cm": q(north, 100),
            "height_cm": q(fit.raw_height, 100),
            "g_lat_mg": q(lap["g_lat"][:fit.n], 1000), "g_long_mg": q(lap["g_long"][:fit.n], 1000),
            "yaw_cdeg": q([deg(v) for v in fit.yaw], 100), "pitch_cdeg": q([deg(v) for v in fit.pitch], 100),
            "roll_cdeg": q([deg(v) for v in fit.roll], 100),
        }
        Path(args.fixture).write_text(json.dumps(fx, separators=(",", ":")))
        print(f"fixture written: {args.fixture} ({Path(args.fixture).stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

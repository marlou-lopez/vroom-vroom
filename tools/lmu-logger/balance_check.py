"""Checks an under/oversteer estimate from the recording's 1 m grid against the truth in a shared-memory capture.

    python3.14 -I balance_check.py --lmu-dir DIR --pair CAPTURE.lmucap GRID.json [--pair ...] [--calib GRID.json ...]
                                   [--fixture-lap N] [--fixture OUT.json.gz] [--plot OUT_DIR]
                                   [--lead delay:0.1]

Each GRID.json is what tools/extract-laps.mjs writes from the SAME session's .duckdb recording as CAPTURE (copy the
recording first and never modify it). Recording and capture share the game's clock, so grid metre d of a lap has the time
lap start_ts + t[d]; metres outside the capture's time span get no truth. --calib adds grids without a capture (calibration
only). The first --pair's lap --fixture-lap (default 1) is "the flying lap" for the fixture, the plots and the corner check.

Truth per grid metre (capture interpolated at that time; vehicle +x left, +z back; wheel order FL FR RL RR):
    r_true  = mLocalRot_y (rad/s, + = right turn)
    alpha_w = atan2(mLateralGroundVel, |mLongitudinalGroundVel|)       per wheel
    alpha_f, alpha_r = mean of the fronts, the rears, times the sign that makes them positive in the turn direction
    T       = alpha_f - alpha_r (deg): > 0 understeer, < 0 oversteer   (|alpha_f| - |alpha_r| is printed too)
    beta    = atan2(mLocalVel_x, -mLocalVel_z) (body slip, left +)

Estimate (recording only):
    v = speed_kmh / 3.6, metres with v < 15 m/s ignored; g_lat and steering smoothed +-SMOOTH_HALF_M (centred average)
    kappa_L = 9.81 g_lat / v^2 (left +), r_act = v kappa_L, theta_L = -steering * steering_range_deg / 2 (deg, left +)
    calibration on every lap of every grid (metres with v >= 15 and no wheel off): theta_L = a kappa_L + b kappa_L v^2 + c
    r_exp = v (theta_L - c) / (a + b v^2);  B = s (r_exp - r_act) in deg/s, s = sign(r_act) if |r_act| > 2 deg/s
    else sign(r_exp). B > 0 understeer, < 0 oversteer.
Variants: kappa from the GPS line (turn between the +-5 m chords), r_act replaced by the true yaw rate, smoothing 2/4/8 m,
and no b term. STEERING LEAD (vroom-bi4.7): the steering delayed by tau (or advanced, tau < 0) or passed through a first-order
lag tau before the fit and the estimate, scored by corner phase, oversteer precision/recall and marks on the fast laps;
--lead MODE:SECONDS makes the later sections use one of them.

Stdlib only; --plot imports matplotlib lazily (uv run --with matplotlib --with numpy python -I balance_check.py ... --plot DIR).
"""
from __future__ import annotations

import argparse
import bisect
import gzip
import json
import math
import os
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

G = 9.81
V_MIN = 15.0
SMOOTH_HALF_M = 4
HEADING_HALF_M = 5
LINE_SMOOTH_HALF = 4
SIGN_RATE_DEG = 2.0
CORNER_G = 0.5
STRAIGHT_G = 0.2
R_M_PER_DEG = 6371008.8 * math.pi / 180
COS60 = math.cos(math.radians(60))

FIELDS = ["mElapsedTime", "mLocalRot_y", "mLocalVel_x", "mLocalVel_z"] + [
    f"w{w}_m{k}GroundVel" for w in range(4) for k in ("Lateral", "Longitudinal")] + ["mUnfilteredSteering", "mPhysicalSteeringWheelRange"]
NF = len(FIELDS)

# Spa apexes, from frontend/src/api/mock/spaTrack.ts (SPA_APEXES).
SPA_APEXES = [("La Source", 279), ("Eau Rouge", 907), ("Raidillon", 1008), ("Les Combes 1", 2309), ("Les Combes 2", 2400),
              ("Bruxelles", 2942), ("T9", 3180), ("Pouhon 1", 3726), ("Pouhon 2", 4010), ("Fagnes 1", 4400), ("Fagnes 2", 4539),
              ("Stavelot", 4821), ("Paul Frere", 5022), ("Blanchimont", 6025), ("Bus Stop", 6669)]
SEGMENTS = [("Kemmel straight", 1500, 2150), ("Pouhon", 3600, 4100), ("Bus Stop entry", 6550, 6680), ("Bus Stop exit", 6680, 6800)]


def corner_at(d):
    name, apex = min(SPA_APEXES, key=lambda a: abs(a[1] - d))
    return name if abs(apex - d) <= 200 else "-"


def load_samples(path):
    import decode
    import layout as lay
    sc = decode.Schema(lay.load())
    cols = [sc.index[n] for n in FIELDS]
    out = array("d")
    for _perf, tel, _scor, _f in decode.iter_player(path, sc):
        for c in cols:
            out.append(tel[c])
    return out


def interp_capture(samples, et, t):
    n = len(et)
    if n < 2 or t < et[0] or t > et[-1]:
        return None
    i = min(max(bisect.bisect_right(et, t) - 1, 0), n - 2)
    f = min(max((t - et[i]) / (et[i + 1] - et[i]), 0.0), 1.0)
    return [samples[NF * i + k] * (1 - f) + samples[NF * (i + 1) + k] * f for k in range(NF)]


def smooth_open(v, half):
    if half <= 0:
        return list(v)
    n = len(v)
    pre = [0.0]
    for x in v:
        pre.append(pre[-1] + x)
    return [(pre[min(n, i + half + 1)] - pre[max(0, i - half)]) / (min(n, i + half + 1) - max(0, i - half)) for i in range(n)]


def smooth_closed(v, half):
    n = len(v)
    return [sum(v[(i + k) % n] for k in range(-half, half + 1)) / (2 * half + 1) for i in range(n)]


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def sgn(x):
    return 1.0 if x > 0 else -1.0 if x < 0 else 0.0


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else float("nan")


def lsq(rows, y):
    k = len(rows[0])
    a = [[sum(r[i] * r[j] for r in rows) for j in range(k)] for i in range(k)]
    b = [sum(r[i] * yy for r, yy in zip(rows, y)) for i in range(k)]
    for i in range(k):
        p = max(range(i, k), key=lambda r: abs(a[r][i]))
        a[i], a[p], b[i], b[p] = a[p], a[i], b[p], b[i]
        piv = a[i][i]
        a[i] = [x / piv for x in a[i]]
        b[i] /= piv
        for r in range(k):
            if r != i:
                f = a[r][i]
                a[r] = [x - f * xi for x, xi in zip(a[r], a[i])]
                b[r] -= f * b[i]
    return b


def pearson(x, y):
    n = len(x)
    if n < 3:
        return float("nan")
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else float("nan")


def ranks(x):
    order = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(x, y):
    return pearson(ranks(x), ranks(y))


class Lap:
    """One grid lap: recording inputs, and truth where the capture covers it."""

    def __init__(self, src, lap, rng, samples):
        self.src, self.no, self.time = src, lap["lap_no"], lap.get("lap_time_s")
        n = len(lap["t"])
        self.n = n
        self.v = [s / 3.6 for s in lap["speed_kmh"]]
        self.steer_raw = lap["steering"]
        self.glat_raw = lap["g_lat"]
        self.off = lap.get("wheels_off") or [0] * n
        self.range = rng
        east = [lap["lon"][d] * R_M_PER_DEG * COS60 for d in range(n)]
        north = [(lap["lat"][d] - 60) * R_M_PER_DEG for d in range(n)]
        x, y = smooth_closed(east, LINE_SMOOTH_HALF), smooth_closed(north, LINE_SMOOTH_HALF)
        # GPS path curvature: turn between the chords d-H..d and d..d+H, over their mean length (counter-clockwise +).
        self.kgps = []
        for d in range(n):
            a, b = max(d - HEADING_HALF_M, 0), min(d + HEADING_HALF_M, n - 1)
            l1, l2 = math.hypot(x[d] - x[a], y[d] - y[a]), math.hypot(x[b] - x[d], y[b] - y[d])
            if l1 < 0.5 or l2 < 0.5:
                self.kgps.append(0.0)
                continue
            h1, h2 = math.atan2(y[d] - y[a], x[d] - x[a]), math.atan2(y[b] - y[d], x[b] - x[d])
            self.kgps.append(wrap(h2 - h1) / ((l1 + l2) / 2))
        self.truth = [None] * n
        self.cap_v = [None] * n
        if samples is not None:
            et = samples[0::NF]
            for d in range(n):
                s = interp_capture(samples, et, lap["start_ts"] + lap["t"][d])
                if s is None:
                    continue
                r = s[1]
                al = [math.atan2(s[4 + 2 * w], abs(s[5 + 2 * w])) for w in range(4)]
                af, ar = (al[0] + al[1]) / 2, (al[2] + al[3]) / 2
                beta = math.atan2(s[2], -s[3])
                self.cap_v[d] = math.hypot(s[2], s[3])
                self.truth[d] = dict(r=r, af=af, ar=ar, beta=beta, steer=s[12], rng=s[13])

    def has_truth(self, d):
        return self.truth[d] is not None


def lag_steering(st, v, lag, mode):
    """Steering as the car's rotation follows it: steering leads yaw (vroom-bi4.7).

    "delay": the steering lag seconds earlier, i.e. at the metre d - v*lag (linear interpolation on the grid); a negative
             lag takes it from later instead (the opposite hypothesis, as a control).
    "first": a first-order lag with time constant lag seconds, run along the lap (dt = 1 m / v).
    """
    if lag == 0 or mode == "none" or (mode == "first" and lag < 0):
        return st
    n = len(st)
    out = [0.0] * n
    if mode == "delay":
        for d in range(n):
            x = min(d - max(v[d], 0.0) * lag, n - 1)  # a negative lag advances the steering instead
            if x <= 0:
                out[d] = st[0]
                continue
            i = int(x)
            f = x - i
            out[d] = st[i] * (1 - f) + st[min(i + 1, n - 1)] * f
        return out
    y = st[0]
    for d in range(n):
        dt = 1.0 / max(v[d], 1.0)
        y += dt / (lag + dt) * (st[d] - y)
        out[d] = y
    return out


def estimate(lap, cal, half, kappa_src="glat", rate_src="path", use_b=True, lag=0.0, lag_mode="none"):
    """B per metre (deg/s) or None; also returns (r_exp, r_act) in rad/s, left +."""
    a, b, c = cal
    gl = smooth_open(lap.glat_raw, half)
    st = lag_steering(smooth_open(lap.steer_raw, half), lap.v, lag, lag_mode)
    kg = smooth_open(lap.kgps, half) if kappa_src == "gps" else None
    out = []
    for d in range(lap.n):
        v = lap.v[d]
        if v < V_MIN:
            out.append(None)
            continue
        k = gl[d] * G / v ** 2 if kappa_src == "glat" else kg[d]
        theta = -st[d] * lap.range / 2
        r_act = v * k
        if rate_src == "true":
            if not lap.has_truth(d):
                out.append(None)
                continue
            r_act = -lap.truth[d]["r"]
        gain = a + (b * v * v if use_b else 0.0)
        if gain <= 0:  # as carBalance.ts: no estimate where the fitted steering gain is not positive
            out.append(None)
            continue
        r_exp = v * (theta - c) / gain
        s = sgn(r_act) if abs(math.degrees(r_act)) > SIGN_RATE_DEG else sgn(r_exp)
        out.append(math.degrees(s * (r_exp - r_act)))
    return out


def calibrate(laps, half, kappa_src="glat", use_b=True, lag=0.0, lag_mode="none"):
    rows, ys = [], []
    for l in laps:
        gl = smooth_open(l.glat_raw, half)
        st = lag_steering(smooth_open(l.steer_raw, half), l.v, lag, lag_mode)
        kg = smooth_open(l.kgps, half)
        for d in range(l.n):
            v = l.v[d]
            if v < V_MIN or l.off[d]:
                continue
            k = gl[d] * G / v ** 2 if kappa_src == "glat" else kg[d]
            rows.append([k, k * v * v, 1.0] if use_b else [k, 1.0])
            ys.append(-st[d] * l.range / 2)
    p = lsq(rows, ys)
    fit = [sum(pi * ri for pi, ri in zip(p, r)) for r in rows]
    my = sum(ys) / len(ys)
    r2 = 1 - sum((y - f) ** 2 for y, f in zip(ys, fit)) / sum((y - my) ** 2 for y in ys)
    cal = tuple(p) if use_b else (p[0], 0.0, p[1])
    return cal, r2, len(ys)


def truth_T(lap, d, mode="signed"):
    t = lap.truth[d]
    s = sgn(-t["r"]) if abs(math.degrees(t["r"])) > SIGN_RATE_DEG else 0.0
    if mode == "abs":
        return math.degrees(abs(t["af"]) - abs(t["ar"]))
    # alpha > 0 when the wheel's ground velocity points to its left (+x); in a left turn (s = +1) the tyre slips outward,
    # i.e. to the right, so the slip "into the turn" is -s * alpha. Verified below (slip sign check).
    return math.degrees(-s * SLIP_SIGN * (t["af"] - t["ar"]))


SLIP_SIGN = 1.0  # set in main from the data: +1 if alpha is negative in a left turn


def main(argv=None):
    global SLIP_SIGN
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pair", nargs=2, action="append", required=True, metavar=("CAPTURE", "GRID"))
    ap.add_argument("--calib", action="append", default=[], help="extra grid for the calibration only (repeatable)")
    ap.add_argument("--lmu-dir")
    ap.add_argument("--fixture-lap", type=int, default=1)
    ap.add_argument("--fixture", help="gzipped JSON of the flying lap's inputs and truth, for a TypeScript test")
    ap.add_argument("--plot", help="directory for the PNG plots (needs matplotlib)")
    ap.add_argument("--lead", help="MODE:SECONDS (e.g. delay:0.1) - the steering-lead variant the top stretches, segments and plots use")
    args = ap.parse_args(argv)
    if args.lmu_dir:
        os.environ["LMU_DIR"] = args.lmu_dir
    deg = math.degrees

    laps, calib_only = [], []
    for cap, gpath in args.pair:
        g = json.load(open(gpath))
        sm = load_samples(cap)
        et = sm[0::NF]
        src = Path(gpath).stem
        print(f"pair {Path(cap).name} <-> {src}: {len(et)} samples, t {et[0]:.1f}..{et[-1]:.1f} s, car range "
              f"{sm[NF - 1]:.0f} deg, grid steering_range_deg {g['steering_range_deg']}")
        for l in g["laps"]:
            lp = Lap(src, l, g["steering_range_deg"], sm)
            m = [d for d in range(lp.n) if lp.has_truth(d) and lp.v[d] > V_MIN]
            if lp.n < 6900:
                calib_only.append(lp)  # partial laps (pit entry) calibrate but are not scored
                continue
            dv = [lp.v[d] - lp.cap_v[d] for d in m]
            ds = [lp.steer_raw[d] - lp.truth[d]["steer"] for d in m]
            print(f"  lap {lp.no} time {lp.time}: {len(m)} metres with truth; speed grid-capture rms "
                  f"{math.sqrt(sum(x * x for x in dv) / max(1, len(dv))):.3f} m/s, steering rms {math.sqrt(sum(x * x for x in ds) / max(1, len(ds))):.4f}")
            laps.append(lp)
    for gpath in args.calib:
        g = json.load(open(gpath))
        for l in g["laps"]:
            calib_only.append(Lap(Path(gpath).stem, l, g["steering_range_deg"], None))
    all_laps = laps + calib_only
    fly = next(l for l in laps if l.src == Path(args.pair[0][1]).stem and l.no == args.fixture_lap)

    # Sign checks on metres with truth, v >= 15.
    pts = [(l, d) for l in laps for d in range(l.n) if l.has_truth(d) and l.v[d] > V_MIN]
    rl = [-l.truth[d]["r"] for l, d in pts]
    print("\nSIGNS (metres with truth, v >= 15 m/s: %d)" % len(pts))
    print("  corr(-mLocalRot_y, g_lat) %+.3f  (both + left)" % pearson(rl, [l.glat_raw[d] for l, d in pts]))
    kgs = [l.kgps[d] for l, d in pts]
    cg = pearson(rl, kgs)
    print("  corr(-mLocalRot_y, GPS kappa ccw) %+.3f" % cg)
    gps_sign = 1.0 if cg > 0 else -1.0
    for l in all_laps:
        l.kgps = [gps_sign * k for k in l.kgps]
    caf = pearson(rl, [l.truth[d]["af"] for l, d in pts])
    car = pearson(rl, [l.truth[d]["ar"] for l, d in pts])
    cb = pearson(rl, [l.truth[d]["beta"] for l, d in pts])
    print(f"  corr(left yaw rate, alpha_f) {caf:+.3f}, alpha_r {car:+.3f}, beta {cb:+.3f}")
    SLIP_SIGN = 1.0 if caf < 0 else -1.0
    print(f"  => tyre slip alpha is {'negative' if caf < 0 else 'positive'} in a left turn (wheel ground velocity points out of the turn)")
    left = [(l, d) for l, d in pts if -l.truth[d]["r"] > math.radians(10)]
    right = [(l, d) for l, d in pts if -l.truth[d]["r"] < -math.radians(10)]
    for name, sel in (("left turns", left), ("right turns", right)):
        print(f"  {name} (|r|>10 deg/s, {len(sel)} m): median alpha_f {deg(pct([l.truth[d]['af'] for l, d in sel], .5)):+.2f}, "
              f"alpha_r {deg(pct([l.truth[d]['ar'] for l, d in sel], .5)):+.2f}, beta {deg(pct([l.truth[d]['beta'] for l, d in sel], .5)):+.2f} deg")

    T = {(id(l), d): truth_T(l, d) for l, d in pts}
    Tabs = {(id(l), d): truth_T(l, d, "abs") for l, d in pts}
    print("  T (signed, deg): p5 %+.2f p50 %+.2f p95 %+.2f; corr with |af|-|ar| %+.3f" % (
        pct(list(T.values()), .05), pct(list(T.values()), .5), pct(list(T.values()), .95),
        pearson(list(T.values()), list(Tabs.values()))))

    def evaluate(label, half=SMOOTH_HALF_M, kappa_src="glat", rate_src="path", use_b=True, lag=0.0, lag_mode="none"):
        cal, r2, n = calibrate(all_laps, half, kappa_src, use_b, lag, lag_mode)
        Bs = {id(l): estimate(l, cal, half, kappa_src, rate_src, use_b, lag, lag_mode) for l in all_laps}
        BTs = {id(l): estimate(l, cal, half, kappa_src, "true", use_b, lag, lag_mode) for l in laps}
        glsm = {id(l): smooth_open(l.glat_raw, half) for l in all_laps}
        res = {"cal": cal, "r2": r2, "B": Bs, "BT": BTs}
        rowsets = {}
        for scope in ("corner", "all"):
            xs, ts, bt = [], [], []
            for l, d in pts:
                b = Bs[id(l)][d]
                if b is None or (scope == "corner" and abs(glsm[id(l)][d]) <= CORNER_G):
                    continue
                xs.append(b)
                ts.append(T[(id(l), d)])
                bt.append(BTs[id(l)][d])
            rowsets[scope] = (xs, ts, bt)
        c, a = rowsets["corner"], rowsets["all"]
        print(f"{label:<26} a {cal[0]:7.1f} b {cal[1]:+.4f} c {cal[2]:+.2f} R2 {r2:.3f} | "
              f"B~T corner P {pearson(c[0], c[1]):+.3f} S {spearman(c[0], c[1]):+.3f} all P {pearson(a[0], a[1]):+.3f} S {spearman(a[0], a[1]):+.3f} | "
              f"B~Btrue corner P {pearson(c[0], c[2]):+.3f} S {spearman(c[0], c[2]):+.3f} all P {pearson(a[0], a[2]):+.3f} | "
              f"Btrue~T corner P {pearson(c[2], c[1]):+.3f} all {pearson(a[2], a[1]):+.3f}")
        res["rows"] = rowsets
        res["glsm"] = glsm
        return res

    print("\nCALIBRATION theta_L[deg] = a kappa + b kappa v^2 + c on %d laps; correlations over metres with truth "
          "(corner: |g_lat| > %.1f)" % (len(all_laps), CORNER_G))
    base = evaluate("base (g_lat, 4 m, a+b)")
    evaluate("(1) GPS kappa", kappa_src="gps")
    evaluate("(2) r_true as r_act", rate_src="true")
    for h in (2, 8):
        evaluate(f"(3) smoothing {h} m", half=h)
    evaluate("(4) no b term", use_b=False)
    evaluate("(1)+(4) GPS, no b", kappa_src="gps", use_b=False)
    cal = base["cal"]
    print(f"  base: a/steering-ratio-free understeer gradient b/a = {cal[1] / cal[0] * 1e3:+.3f} per km/s^2; "
          f"a = {cal[0]:.1f} deg m (= ratio x wheelbase in rad: {math.radians(cal[0]):.2f} m)")

    B, glsm = base["B"], base["glsm"]
    # Noise floor on straights.
    st = [abs(B[id(l)][d]) for l in laps for d in range(l.n) if B[id(l)][d] is not None and abs(glsm[id(l)][d]) < STRAIGHT_G]
    stT = [abs(T[(id(l), d)]) for l in laps for d in range(l.n) if (id(l), d) in T and abs(glsm[id(l)][d]) < STRAIGHT_G]
    print(f"\nNOISE on straights (|g_lat| < {STRAIGHT_G}): |B| p50 {pct(st, .5):.2f} p90 {pct(st, .9):.2f} deg/s ({len(st)} m); "
          f"|T| p50 {pct(stT, .5):.2f} p90 {pct(stT, .9):.2f} deg")
    best = min(l.time for l in all_laps if l.time)
    fast = [l for l in all_laps if l.time and l.time < best * 1.03 and l.n >= 6900]
    print(f"Across-lap spread at the same metre, {len(fast)} laps within 3 % of {best:.2f} s "
          f"({', '.join(f'{l.src[:16]} L{l.no} {l.time}' for l in fast)}):")
    n = min(l.n for l in fast)
    for scope in ("all", "corner", "straight"):
        sd, sdT = [], []
        for d in range(n):
            g = sum(glsm[id(l)][d] for l in fast) / len(fast)
            if (scope == "corner" and abs(g) <= CORNER_G) or (scope == "straight" and abs(g) >= STRAIGHT_G):
                continue
            vals = [B[id(l)][d] for l in fast if B[id(l)][d] is not None]
            if len(vals) == len(fast):
                m = sum(vals) / len(vals)
                sd.append(math.sqrt(sum((x - m) ** 2 for x in vals) / (len(vals) - 1)))
            tv = [T[(id(l), d)] for l in fast if (id(l), d) in T]
            if len(tv) >= 3:
                m = sum(tv) / len(tv)
                sdT.append(math.sqrt(sum((x - m) ** 2 for x in tv) / (len(tv) - 1)))
        print(f"  {scope:<8} B sd p50 {pct(sd, .5):.2f} p90 {pct(sd, .9):.2f} deg/s;  T sd p50 {pct(sdT, .5):.2f} p90 {pct(sdT, .9):.2f} deg "
              f"(T over laps with truth)")

    # T has a baseline that grows with lateral g (the car's own understeer gradient), while the calibration's b term takes
    # that baseline out of B. T_dev = T minus its least-squares line in |g_lat| is the truth relative to the car's norm.
    tp_ = lsq([[abs(glsm[id(l)][d]), 1.0] for l, d in pts], [T[(id(l), d)] for l, d in pts])
    Tdev = {(id(l), d): T[(id(l), d)] - tp_[0] * abs(glsm[id(l)][d]) - tp_[1] for l, d in pts}
    xc, tc, dc = [], [], []
    for l, d in pts:
        if B[id(l)][d] is not None and abs(glsm[id(l)][d]) > CORNER_G:
            xc.append(B[id(l)][d])
            tc.append(T[(id(l), d)])
            dc.append(Tdev[(id(l), d)])
    print(f"\nT_dev = T - ({tp_[0]:+.3f} deg/g * |g_lat| {tp_[1]:+.3f}); B~T_dev corner P {pearson(xc, dc):+.3f} S {spearman(xc, dc):+.3f}")
    for name, tv in (("T", tc), ("T_dev", dc)):
        tu, to = pct(tv, .9), pct(tv, .1)
        print(f"DETECTION over {len(xc)} corner metres; truth understeer {name} > {tu:+.2f} deg (p90), oversteer {name} < {to:+.2f} deg (p10)")
        for X in (2.0, 5.0, 10.0):
            for kind, flag, true in (("under", lambda b: b > X, lambda t: t > tu), ("over", lambda b: b < -X, lambda t: t < to)):
                tp = sum(1 for b, t in zip(xc, tv) if flag(b) and true(t))
                fp = sum(1 for b, t in zip(xc, tv) if flag(b) and not true(t))
                fn = sum(1 for b, t in zip(xc, tv) if not flag(b) and true(t))
                print(f"  X {X:4.1f} deg/s {kind:<5}: flagged {tp + fp:5d}, precision {tp / max(1, tp + fp):.2f}, recall {tp / max(1, tp + fn):.2f}")

    # Steering lead (vroom-bi4.7): the steady-state fit reads corner entry and exit as oversteer, because the steering
    # turns in before the car rotates and unwinds before it straightens. Steering delayed by `lag` seconds, or passed
    # through a first-order lag, should line up with the car's rotation. Scored against the same T_dev thresholds as above.
    tu_dev, to_dev = pct(dc, .9), pct(dc, .1)
    fast_truth = [l for l in fast if l in laps]

    def lead_score(label, Bv, glv, thresholds=(5.0, 7.5, 10.0)):
        xs, ts = [], []
        for l, d in pts:
            b = Bv[id(l)][d]
            if b is not None and abs(glv[id(l)][d]) > CORNER_G:
                xs.append(b)
                ts.append(Tdev[(id(l), d)])
        # The dip: B on clean corner metres (fast laps, truth not oversteer).
        clean = [Bv[id(l)][d] for l in fast_truth for d in range(l.n) if (id(l), d) in Tdev and Bv[id(l)][d] is not None
                 and abs(glv[id(l)][d]) > CORNER_G and Tdev[(id(l), d)] >= to_dev]
        out = [f"{label:<24} P {pearson(xs, ts):+.3f} | clean-corner B p1 {pct(clean, .01):+6.1f} p5 {pct(clean, .05):+6.1f} "
               f"< -5: {sum(1 for b in clean if b < -5) / max(1, len(clean)):.3f} < -10: {sum(1 for b in clean if b < -10) / max(1, len(clean)):.3f}"]
        # By corner phase on the clean laps: entry (|g_lat| rising over +-5 m), exit (falling), mid. If T_dev dips with B at
        # entry and exit, the dip is in the truth too, not a steering-lead artefact.
        ph = {"entry": [], "mid": [], "exit": []}
        for l in fast_truth:
            ga = [abs(x) for x in glv[id(l)]]
            for d in range(5, l.n - 5):
                b = Bv[id(l)][d]
                if b is None or ga[d] <= CORNER_G or (id(l), d) not in Tdev:
                    continue
                sl = ga[d + 5] - ga[d - 5]
                ph["entry" if sl > 0.05 else "exit" if sl < -0.05 else "mid"].append((b, Tdev[(id(l), d)]))
        out.append("    phase " + ", ".join(
            f"{k} {len(v)} m: B mean {sum(b for b, _ in v) / max(1, len(v)):+.2f} p5 {pct([b for b, _ in v], .05):+.1f}, "
            f"T_dev mean {sum(t for _, t in v) / max(1, len(v)):+.2f} p5 {pct([t for _, t in v], .05):+.2f}, "
            f"OS truth share {sum(1 for _, t in v if t < to_dev) / max(1, len(v)):.2f}, P {pearson([b for b, _ in v], [t for _, t in v]):+.2f}"
            for k, v in ph.items()))
        for X in thresholds:
            cells = []
            for kind, flag, true in (("US", lambda b: b > X, lambda t: t > tu_dev), ("OS", lambda b: b < -X, lambda t: t < to_dev)):
                tp = sum(1 for b, t in zip(xs, ts) if flag(b) and true(t))
                fp = sum(1 for b, t in zip(xs, ts) if flag(b) and not true(t))
                fn = sum(1 for b, t in zip(xs, ts) if not flag(b) and true(t))
                cells.append(f"{kind} {tp / max(1, tp + fp):.2f}/{tp / max(1, tp + fn):.2f}")
            # Oversteer marks as the app draws them (>= 0.5 g, merge 3 m, >= 5 m) on the clean laps: real (any metre with
            # T_dev oversteer) or false.
            real = false = 0
            for l in fast_truth:
                on = [Bv[id(l)][d] is not None and Bv[id(l)][d] < -X and abs(glv[id(l)][d]) >= CORNER_G for d in range(l.n)]
                d = 0
                while d < l.n:
                    if not on[d]:
                        d += 1
                        continue
                    e, gap = d, 0
                    while e + 1 < l.n and gap <= 3:
                        e += 1
                        gap = 0 if on[e] else gap + 1
                    e -= gap
                    if e - d + 1 >= 5:
                        if any((id(l), k) in Tdev and Tdev[(id(l), k)] < to_dev for k in range(d, e + 1)):
                            real += 1
                        else:
                            false += 1
                    d = e + 1
            cells.append(f"OS marks/{len(fast_truth)} laps {real} real {false} false")
            out.append(f"    X {X:4.1f}: " + ", ".join(cells))
        print("\n".join(out))

    print(f"\nSTEERING LEAD (precision/recall vs T_dev; clean = {len(fast_truth)} fast laps with truth, corner metres with "
          f"T_dev >= {to_dev:+.2f})")
    lead_score("none (as shipped)", B, glsm, (5.0, 6.0, 7.0, 7.5, 8.0, 9.0, 10.0))
    lead = {}
    for mode, lags in (("delay", (-0.1, -0.05, 0.05, 0.1, 0.15, 0.2, 0.3)), ("first", (0.05, 0.1, 0.15, 0.2, 0.3))):
        for lag in lags:
            r = evaluate(f"{mode} {lag:.2f} s", lag=lag, lag_mode=mode)
            lead[(mode, lag)] = r
            lead_score(f"  {mode} {lag:.2f} s", r["B"], r["glsm"])
    if args.lead:
        mode, lag = args.lead.split(":")
        r = lead[(mode, float(lag))]
        B, base = r["B"], r
        print(f"\nThe sections below use the steering lead {mode} {lag} s (--lead).")

    # Top stretches (over laps with truth).
    X = 5.0
    runs = []
    for l in laps:
        b = [B[id(l)][d] if l.has_truth(d) else None for d in range(l.n)]
        for sign in (1, -1):
            d = 0
            while d < l.n:
                if b[d] is not None and sign * b[d] > X:
                    e = d
                    gap = 0
                    while e + 1 < l.n and gap <= 5:
                        e += 1
                        gap = 0 if (b[e] is not None and sign * b[e] > X) else gap + 1
                    e -= gap
                    seg = [k for k in range(d, e + 1) if b[k] is not None]
                    pk = max(seg, key=lambda k: sign * b[k])
                    tseg = [T[(id(l), k)] for k in seg if (id(l), k) in T]
                    runs.append((sign, sign * b[pk], l, d, e, b[pk], max(tseg, key=lambda t: sign * t) if tseg else None,
                                 sum(tseg) / len(tseg) if tseg else None))
                    d = e + 1
                else:
                    d += 1
    for sign, label in ((1, "UNDERSTEER"), (-1, "OVERSTEER")):
        sel = sorted((r for r in runs if r[0] == sign), key=lambda r: -r[1])[:5]
        print(f"\nTop 5 {label} stretches (B beyond {sign * X:+.1f} deg/s, laps with truth):")
        for _s, _k, l, d, e, bp, tp, tm in sel:
            print(f"  {l.src[:16]} L{l.no:<2} {d:5d}-{e:<5d} m  {corner_at((d + e) / 2):<13} B peak {bp:+6.1f} deg/s  "
                  f"T peak {tp if tp is None else f'{tp:+.2f}'} mean {tm if tm is None else f'{tm:+.2f}'} deg")

    print(f"\nSEGMENTS on the flying lap ({fly.src} L{fly.no}, {fly.time} s) and mean over laps with truth (mean / max of B, T):")
    for name, a, b in SEGMENTS:
        def stats(lp):
            bb = [B[id(lp)][d] for d in range(a, min(b, lp.n)) if B[id(lp)][d] is not None]
            tt = [T[(id(lp), d)] for d in range(a, min(b, lp.n)) if (id(lp), d) in T]
            return bb, tt
        bb, tt = stats(fly)
        ab = [x for l in laps for x in stats(l)[0]]
        at = [x for l in laps for x in stats(l)[1]]
        f = lambda v: f"{sum(v) / len(v):+5.1f} / {max(v, key=abs):+5.1f}" if v else "   -"
        print(f"  {name:<16} {a}-{b}: flying B {f(bb)} deg/s, T {f(tt)} deg | all laps B {f(ab)}, T {f(at)}")

    if args.fixture:
        q = lambda v, s: [int(round(x * s)) for x in v]
        fx = {
            "note": ("Spa 2026-11-05 flying lap (McLaren GT3, %.2f s), 1 m grid from the recording: speed_kmh (x10), steering "
                     "(-1..1, + right, x1000), g_lat (mg, + left), steering_range_deg; truth from the same session's shared-memory "
                     "capture: T = front minus rear slip angle into the turn (0.01 deg, + understeer; null where |yaw rate| <= 2 deg/s "
                     "has no turn sign -> 0) and r_true = mLocalRot_y (0.01 deg/s, + right turn). Written by "
                     "tools/lmu-logger/balance_check.py --fixture.") % fly.time,
            "steering_range_deg": fly.range,
            "speed_kmh_x10": q([v * 3.6 for v in fly.v], 10),
            "steering_x1000": q(fly.steer_raw, 1000),
            "g_lat_mg": q(fly.glat_raw, 1000),
            "T_cdeg": [int(round(100 * truth_T(fly, d))) if fly.has_truth(d) else 0 for d in range(fly.n)],
            "r_true_cdeg_s": [int(round(100 * deg(fly.truth[d]["r"]))) if fly.has_truth(d) else 0 for d in range(fly.n)],
        }
        with gzip.open(args.fixture, "wt") as fh:
            fh.write(json.dumps(fx, separators=(",", ":")))
        print(f"\nfixture written: {args.fixture} ({Path(args.fixture).stat().st_size} bytes)")

    if args.plot:
        plot(args.plot, fly, B, T, base, X)
    return 0


def plot(out_dir, fly, B, T, base, X):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    b = B[id(fly)]
    d_b = [d for d in range(fly.n) if b[d] is not None]
    d_t = [d for d in range(fly.n) if (id(fly), d) in T]
    xs, ts, _ = base["rows"]["corner"]
    k = pct([abs(x) for x in xs], .9) / max(1e-6, pct([abs(t) for t in ts], .9))
    fig, ax = plt.subplots(figsize=(14, 4.5), dpi=110)
    ax.axhspan(-X, X, color="#888", alpha=0.12, lw=0)
    ax.plot(d_t, [T[(id(fly), d)] * k for d in d_t], color="#d62728", lw=0.9, label=f"truth T (front - rear slip) x {k:.1f}")
    ax.plot(d_b, [b[d] for d in d_b], color="#1f77b4", lw=0.9, label="estimate B (r_exp - r_act), deg/s")
    ax.axhline(0, color="#444", lw=0.6)
    lo, hi = ax.get_ylim()
    for name, apex in SPA_APEXES:
        ax.axvline(apex, color="#999", lw=0.5, ls=":")
        ax.text(apex, hi, name, rotation=90, va="top", ha="right", fontsize=7, color="#555")
    ax.set_xlim(0, fly.n)
    ax.set_xlabel("lap distance (m)")
    ax.set_ylabel("+ understeer / - oversteer")
    ax.set_title(f"Spa 2026-11-05 flying lap {fly.time:.2f} s: recording-only balance B vs capture truth T (grey band: +-X = {X:.1f} deg/s)")
    ax.legend(loc="lower left", fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "balance-spa-flying-lap.png")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 6), dpi=110)
    xa, ta, _ = base["rows"]["all"]
    ax.scatter(ta, xa, s=1, alpha=0.15, color="#999", label="all metres")
    ax.scatter(ts, xs, s=1, alpha=0.3, color="#1f77b4", label=f"corner metres (|g_lat| > {CORNER_G})")
    ax.axhline(0, color="#444", lw=0.6)
    ax.axvline(0, color="#444", lw=0.6)
    ax.set_xlabel("truth T = front - rear slip angle (deg), + understeer")
    ax.set_ylabel("estimate B (deg/s), + understeer")
    ax.set_title(f"B vs T, all laps with truth: corner Pearson {pearson(xs, ts):+.2f}, Spearman {spearman(xs, ts):+.2f}", fontsize=9)
    ax.set_xlim(pct(ta, .002), pct(ta, .998))
    ax.set_ylim(pct(xa, .002), pct(xa, .998))
    ax.legend(loc="upper left", fontsize=8, markerscale=8)
    fig.tight_layout()
    fig.savefig(out / "balance-scatter.png")
    plt.close(fig)
    print(f"plots written to {out}")


if __name__ == "__main__":
    raise SystemExit(main())

"""Checks the backend analysis thresholds against your own recordings (vroom-9ki.15).

Three heuristics were set from one Spa session; this reruns them on other tracks, cars and
conditions and prints Markdown tables (the results live in docs/analysis-tuning.md).

    cd backend && uv run python -I ../tools/tune-thresholds.py <recording.duckdb>...

Recordings are copied to a temp folder before they are opened (`racecoach.lmu.db`), so the
originals are never touched. Nothing is written.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

from racecoach.analysis import corners as corners_mod
from racecoach.analysis import landmarks as lm_mod
from racecoach.analysis import metrics as metrics_mod
from racecoach.analysis.corners import detect_corners
from racecoach.lmu.laps import build_laps
from racecoach.lmu.reader import read_lmu_duckdb
from racecoach.model import LapKind, LapTrace
from racecoach.tracks import Corner, TrackMap, draft_map

BRAKE_ON = 0.1


def load(path: str) -> tuple[str, list[LapTrace], dict[str, float]]:
    raw = read_lmu_duckdb(path)
    laps = build_laps(raw)
    flying = [
        (m, t)
        for m, t in laps
        if m.kind == LapKind.FLYING and m.effective_valid and m.lap_time_s
    ]
    flying.sort(key=lambda mt: mt[0].lap_time_s or 1e9)
    # Drop slow laps (traffic, mistakes): within 107 % of the best.
    if flying:
        best = flying[0][0].lap_time_s or 0
        flying = [mt for mt in flying if (mt[0].lap_time_s or 0) <= best * 1.07]
    cond = flying[0][0].conditions if flying else {}
    label = f"{raw.meta.track_id[:22]} / {raw.meta.car_class} / {raw.meta.car_id[:18]}"
    return label, [t for _, t in flying], cond


def corners_of(tmap: TrackMap) -> list[Corner]:
    return tmap.corners


# -- steering corrections -----------------------------------------------------------------


def steering_table(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    saved = (metrics_mod.STEER_SMOOTH_M, metrics_mod.STEER_PROMINENCE, metrics_mod.STEER_MIN_PROMINENCE)
    grid = [(s, p, f) for s in (3, 5, 8, 12) for p in (0.05, 0.10, 0.15, 0.20) for f in (0.0, 0.04)]
    out = [
        "| smooth ± m | prominence | floor | mean per corner | corners with ≥ 1 | laps ≠ ref |",
        "|---|---|---|---|---|---|",
    ]
    for smooth, prom, floor in grid:
        metrics_mod.STEER_SMOOTH_M, metrics_mod.STEER_PROMINENCE = smooth, prom
        metrics_mod.STEER_MIN_PROMINENCE = floor
        counts: list[int] = []
        differs: list[bool] = []
        for laps, tmap in sessions.values():
            ref = laps[0]
            for c in tmap.corners:
                r = metrics_mod.steering_extrema(ref.ch["steering"], c)
                for lap in laps[1:]:
                    n = metrics_mod.steering_extrema(lap.ch["steering"], c)
                    counts.append(n)
                    differs.append(n != r)
                counts.append(r)
        a = np.array(counts)
        out.append(
            f"| {smooth} | {prom:.2f} | {floor} | {a.mean():.2f} | {100 * (a >= 1).mean():.0f} % "
            f"| {100 * np.mean(differs):.0f} % |"
        )
    metrics_mod.STEER_SMOOTH_M, metrics_mod.STEER_PROMINENCE, metrics_mod.STEER_MIN_PROMINENCE = saved
    return out


def steering_by_lock(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    """Corrections per 100 m by the corner's largest smoothed steering, without and with the floor."""
    from racecoach.analysis.delta import corner_walk

    rows = []
    for laps, tmap in sessions.values():
        for lap in laps:
            st = np.asarray(lap.ch["steering"], dtype=float)
            for c in tmap.corners:
                w = corner_walk(c, len(st))
                v = metrics_mod._smooth_walk(st, w, c.start_m > c.end_m)
                counts = []
                for floor in (0.0, 0.04):
                    metrics_mod.STEER_MIN_PROMINENCE = floor
                    counts.append(metrics_mod.steering_extrema(st, c))
                rows.append((float(np.abs(v).max()), len(v), *counts))
    metrics_mod.STEER_MIN_PROMINENCE = 0.04
    r = np.array(rows)
    out = ["| largest steering | corner-laps | per 100 m, no floor | per 100 m, floor 0.04 |", "|---|---|---|---|"]
    for lo, hi in ((0, 0.1), (0.1, 0.2), (0.2, 0.35), (0.35, 0.5), (0.5, 1.01)):
        m = (r[:, 0] >= lo) & (r[:, 0] < hi)
        if m.any():
            a, b = (100 * (r[m, k] / r[m, 1]).mean() for k in (2, 3))
            out.append(f"| {lo} to {hi} | {m.sum()} | {a:.2f} | {b:.2f} |")
    return out


def steering_per_session(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    out = ["| recording | corners | laps | mean (±5 m, 10 %, floor 0.04) | ≥ 1 | ≥ 3 | worst corner |", "|---|---|---|---|---|---|---|"]
    for label, (laps, tmap) in sessions.items():
        per_corner: dict[str, list[int]] = defaultdict(list)
        for lap in laps:
            for c in tmap.corners:
                per_corner[c.id].append(metrics_mod.steering_extrema(lap.ch["steering"], c))
        allc = np.array([n for v in per_corner.values() for n in v])
        worst = max(per_corner, key=lambda k: np.mean(per_corner[k]))
        out.append(
            f"| {label} | {len(tmap.corners)} | {len(laps)} | {allc.mean():.2f} "
            f"| {100 * (allc >= 1).mean():.0f} % | {100 * (allc >= 3).mean():.0f} % "
            f"| {worst} ({np.mean(per_corner[worst]):.1f}) |"
        )
    return out


# -- corner start -------------------------------------------------------------------------


def _onset_before_apex(lap: LapTrace, start: int, apex: int, lookback: int = 400) -> int | None:
    """First metre of the brake run (lift-only corners are left out) that ends at the apex, searched back from the apex."""
    brake = lap.ch["brake"]
    lo = max(0, start - lookback)
    seg = brake[lo : apex + 1] >= BRAKE_ON
    if not seg.any():
        return None
    i = len(seg) - 1
    while i >= 0 and not seg[i]:
        i -= 1  # last braking metre before the apex
    while i - 1 >= 0 and seg[i - 1]:
        i -= 1
    return lo + i


def corner_start_table(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    out = [
        "| lead-in m | braking corners | brake already on at start | median onset − start (m) | p90 |",
        "|---|---|---|---|---|",
    ]
    for lead in (0, 25, 50, 75, 100):
        corners_mod.LEAD_IN_M = lead
        on_at_start, total, gaps = 0, 0, []
        for laps, _ in sessions.values():
            ref = laps[0]
            det = detect_corners(ref)
            for d in det:
                a = int(round(d.apex_m))
                for lap in laps:
                    s = int(round(d.start_m))
                    if s > a:  # wraps the line; skip, rare
                        continue
                    on = _onset_before_apex(lap, s, a)
                    if on is None:
                        continue
                    total += 1
                    # onset at or before start: the brake run began before the window
                    if on <= s:
                        on_at_start += 1
                    gaps.append(on - s)
        g = np.array(gaps) if gaps else np.array([0])
        out.append(
            f"| {lead} | {total} | {100 * on_at_start / max(total, 1):.1f} % "
            f"| {np.median(g):.0f} | {np.percentile(g, 90):.0f} |"
        )
    corners_mod.LEAD_IN_M = 50
    return out


# -- kerbs --------------------------------------------------------------------------------


def kerb_stats(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    out = [
        "| recording | laps | flagged m / lap | of which near the edge | off-edge repeating on ≥ 50 % of laps (m) |",
        "|---|---|---|---|---|",
    ]
    for label, (laps, _) in sessions.items():
        flagged, near_n, rep = [], [], []
        stack_off = np.zeros(len(laps[0].distance))
        usable = 0
        for lap in laps:
            hit = np.asarray(lap.ch["kerb"]) > 0.5
            near = lm_mod._near_edge(lap)
            flagged.append(hit.sum())
            if near is None:
                continue
            usable += 1
            near_n.append((hit & near).sum())
            off = hit & ~near
            m = min(len(off), len(stack_off))
            stack_off[:m] += off[:m]
        rep_m = int((stack_off >= 0.5 * max(usable, 1)).sum()) if usable else 0
        out.append(
            f"| {label} | {len(laps)} | {np.mean(flagged):.0f} "
            f"| {np.mean(near_n) if near_n else float('nan'):.0f} | {rep_m} |"
        )
    return out


def kerb_sweep(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    out = [
        "| edge margin m | suspension peaks | min lap share | kerbs found (all recordings) | per recording |",
        "|---|---|---|---|---|",
    ]
    cfgs = []
    for margin in (0.5, 1.0, 1.5, 2.5, 4.0):
        cfgs.append((margin, True, 0.5))
    cfgs += [(1.5, False, 0.5), (1.5, True, 0.3), (1.5, True, 0.7)]
    for margin, susp, share in cfgs:
        lm_mod.EDGE_MARGIN_M = margin
        lm_mod.SUSP_PEAK_MS = 0.6 if susp else 1e9
        lm_mod.MIN_LAP_SHARE = share
        counts = [len(lm_mod.detect_kerbs(laps, tmap)) for laps, tmap in sessions.values()]
        out.append(
            f"| {margin} | {'on' if susp else 'off'} | {share} | {sum(counts)} | {', '.join(map(str, counts))} |"
        )
    lm_mod.EDGE_MARGIN_M, lm_mod.SUSP_PEAK_MS, lm_mod.MIN_LAP_SHARE = 1.5, 0.6, 0.5
    return out


def susp_check(sessions: dict[str, tuple[list[LapTrace], TrackMap]]) -> list[str]:
    """Peak suspension velocity on the straights vs on flagged kerb metres (unit sanity check)."""
    out = ["| recording | p50 speed on kerb (units/s) | p50 off kerb | p99 off kerb |", "|---|---|---|---|"]
    for label, (laps, _) in sessions.items():
        on, off = [], []
        for lap in laps:
            t = np.asarray(lap.ch["t"], dtype=float)
            dt = np.gradient(t)
            dt = np.where(dt > 1e-6, dt, np.inf)
            v = np.zeros(len(t))
            for name in lm_mod._SUSP:
                v = np.maximum(v, np.abs(np.gradient(np.asarray(lap.ch[name], dtype=float)) / dt))
            hit = np.asarray(lap.ch["kerb"]) > 0.5
            on.append(v[hit])
            off.append(v[~hit])
        a, b = np.concatenate(on), np.concatenate(off)
        if len(a) and len(b):
            out.append(
                f"| {label} | {np.median(a):.2f} | {np.median(b):.2f} | {np.percentile(b, 99):.2f} |"
            )
    return out


def main(paths: list[str]) -> None:
    sessions: dict[str, tuple[list[LapTrace], TrackMap]] = {}
    for p in paths:
        label, laps, cond = load(p)
        if len(laps) < 3:
            print(f"skip {Path(p).name}: {len(laps)} usable laps", file=sys.stderr)
            continue
        key = label
        if key in sessions:
            key += f" ({Path(p).stem[-20:]})"
        tmap = draft_map(label, laps[0])
        wet = {k: round(v, 2) for k, v in cond.items() if "wet" in k or "rain" in k or "track" in k}
        print(f"loaded {key}: {len(laps)} laps, {len(tmap.corners)} corners {wet}", file=sys.stderr)
        sessions[key] = (laps, tmap)
    print("## Steering corrections: parameter grid (all recordings)\n")
    print("\n".join(steering_table(sessions)))
    print("\n## Steering corrections by the corner's largest steering\n")
    print("\n".join(steering_by_lock(sessions)))
    print("\n## Steering corrections per recording (current setting)\n")
    print("\n".join(steering_per_session(sessions)))
    print("\n## Corner start lead-in\n")
    print("\n".join(corner_start_table(sessions)))
    print("\n## Kerb flag against the edge filter\n")
    print("\n".join(kerb_stats(sessions)))
    print("\n## Kerb detection sweep\n")
    print("\n".join(kerb_sweep(sessions)))
    print("\n## Suspension velocity (kerb strike threshold 0.6)\n")
    print("\n".join(susp_check(sessions)))


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if not a.startswith("--")])

"""Track edges and kerbs from open aerial imagery: see README.md.

    uv run --no-project --with numpy,scipy,pyproj,pillow python -I run.py spa
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy.spatial import cKDTree

import confidence as cf
import extract as ex
import frame as fr
import sources

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WHEEL_M = 1.24  # the survey car's axles from its centre


class Strip:
    def __init__(self, src, to_src, cache):
        self.src, self.to_src, self.cache, self.tiles = src, to_src, cache, 0

    def get(self, t, centre, ds=1.0):
        """Image along the lap: (rows every ds m, 2 sides, lateral outwards, RGB). centre: world, one point per metre."""
        n = len(centre)
        q = np.arange(0, n, ds)
        w = np.stack([np.interp(q, np.arange(n), centre[:, k], period=n) for k in (0, 1)], 1)
        nn = fr.normals_left(centre, 4)
        nn = np.stack([np.interp(q, np.arange(n), nn[:, k], period=n) for k in (0, 1)], 1)
        nn /= np.hypot(*nn.T)[:, None]
        lat = np.arange(0, ex.REACH, ex.DL)
        out = []
        for sign in (1, -1):
            p = w[:, None] + sign * nn[:, None] * lat[None, :, None]
            loc = fr.apply(t, p.reshape(-1, 2))
            x, y = self.to_src.transform(loc[:, 0], loc[:, 1])
            im, k = self.src.sample(x.reshape(p.shape[:2]), y.reshape(p.shape[:2]), self.cache)
            self.tiles = max(self.tiles, k)
            out.append(im)
        return out


def refine(t, centre, raw, prior, strip: Strip, rounds=4):
    """Similarity fit (no warp) that moves LMU's recorded edges onto the painted lines. `raw` holds the recorded half-widths
    (NaN where no lap was on that side), `prior` the filled ones. A constant width difference (LMU's width ends
    somewhere else than the line's outer side) is a fifth unknown, so it cannot pull the fit. The survey is not used here."""
    nn = fr.normals_left(centre, 4)
    c0 = centre.mean(0)
    d = centre - c0
    ok = np.zeros(len(centre), bool)
    for k in range(rounds + 1):
        found = [ex.find_edge(im, p) for im, p in zip(strip.get(t, centre), prior)]
        rows, res = [], []
        for (e, seen), r, sg in zip(found, raw, (1, -1)):
            m = seen & np.isfinite(r)
            rows.append(np.stack([nn[:, 0], nn[:, 1], -d[:, 1] * nn[:, 0] + d[:, 0] * nn[:, 1], (d * nn).sum(1), np.full(len(d), sg)], 1)[m])
            res.append(sg * (e - r)[m])
        A, e = np.concatenate(rows), np.concatenate(res)
        left_over = e
        keep = np.abs(e) < 1.5
        for _ in range(8):
            sol, *_ = np.linalg.lstsq(A[keep], e[keep], rcond=None)
            left_over = e - A @ sol
            keep = np.abs(left_over) < max(0.25, 2.0 * np.median(np.abs(left_over)))
        if k == rounds:
            break
        q = (d @ [1, 1j]) * (1 + sol[3]) * np.exp(1j * sol[2])
        t = fr.similarity(centre, fr.apply(t, c0 + sol[:2] + np.stack([q.real, q.imag], 1)))
    return t, found, {"samples": int(len(e)), "residual_median_abs_m": float(np.median(np.abs(left_over))),
                      "residual_p90_abs_m": float(np.percentile(np.abs(left_over), 90)), "width_bias_m": float(sol[4])}


def world_points(centre, half, sign):
    return centre + sign * fr.normals_left(centre, 4) * np.asarray(half)[:, None]


def runs_of(idx, merge=10):
    out = []
    for i in sorted(idx):
        if out and i - out[-1][1] - 1 <= merge:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def grade(survey, centre, half, seen, kerbs, painted, stripes=None) -> dict:
    """Against the shared-memory survey: edge contacts (wheel crossings) and kerb hits."""
    n = len(centre)
    nn = fr.normals_left(centre, 4)
    tree = cKDTree(centre)

    def project(p):
        d, i = tree.query(p)
        off = ((p - centre[i]) * nn[i]).sum(1)
        return i, off, d < 18

    pts = np.array([c[:2] for c in survey["contacts"] if c[2] == "edge"], float).reshape(-1, 2)
    i, off, ok = project(pts)
    res: dict = {"edges": {}, "kerbs": {}}
    truth = {}
    for s, (name, sign) in enumerate((("left", 1), ("right", -1))):
        m = ok & (sign * off > 1.5)
        gi, gv = i[m], sign * off[m]
        med = np.full(n, np.nan)
        for k in np.unique(gi):
            gap = np.abs(gi - k)
            near = gv[np.minimum(gap, n - gap) <= 10]
            v = gv[gi == k]
            if len(near) >= 3:  # the app's outlier rule (rejectOutliers in trackSurvey.ts)
                v = v[np.abs(v - np.median(near)) <= 0.75]
            if len(v):
                med[k] = np.median(v)
        truth[name] = med
        both = np.isfinite(med) & seen[s]
        err = half[s][both] - med[both]
        res["edges"][name] = {
            "coverage": round(float(seen[s].mean()), 3), "survey_metres": int(np.isfinite(med).sum()), "compared": int(both.sum()),
            **({} if not len(err) else {"median_abs_m": round(float(np.median(np.abs(err))), 3), "p90_abs_m": round(float(np.percentile(np.abs(err), 90)), 3),
            "bias_m": round(float(np.median(err)), 3), "share_under_0.3": round(float((np.abs(err) < 0.3).mean()), 3)})}
    k = np.array([c[:2] for c in survey["kerbs"]], float).reshape(-1, 2)
    side = np.array([c[2] for c in survey["kerbs"]])
    kind = np.array([c[3] for c in survey["kerbs"]])
    d, gi = tree.query(k)
    tot = {"survey_runs": 0, "matched": 0, "missed": [], "false_runs": [], "start_err": [], "end_err": []}
    for s, name in enumerate(("left", "right")):
        mine = [(r["start"], r["end"]) for r in kerbs if r["side"] == name]
        sv = [(a, b) for a, b in runs_of(set(gi[(side == s) & (d < 15) & (kind != "other")].tolist())) if b - a + 1 >= 5]
        tot["survey_runs"] += len(sv)
        for a, b in sv:
            hit = [m for m in mine if m[0] <= b and m[1] >= a]
            if hit:
                tot["matched"] += 1
                tot["start_err"].append(round(min(h[0] for h in hit) - a, 1))
                tot["end_err"].append(round(max(h[1] for h in hit) - b, 1))
            else:
                # the last number is the share of the run where the image shows a stripe swing
                striped = float((stripes[s][a * 4:(b + 1) * 4] > ex.MIN_AMP).mean()) if stripes else 0.0
                tot["missed"].append([name, int(a), int(b), round(striped, 2)])
        tot["false_runs"] += [[name, m[0], m[1]] for m in mine if not any(m[0] <= b and m[1] >= a for a, b in sv)]
    for key in ("start_err", "end_err"):
        v = np.array(tot[key])
        tot[key + "_summary"] = {"median": float(np.median(v)), "median_abs": float(np.median(np.abs(v))), "p90_abs": float(np.percentile(np.abs(v), 90)), "within_1m": round(float((np.abs(v) <= 1).mean()), 2)} if len(v) else None
    # A survey hit sits at the car's centre, but a front or rear wheel 1.24 m away made it, so survey runs are that much too long at both ends.
    for key, sg in (("start_err", -1), ("end_err", 1)):
        if not tot[key]:
            continue
        v = np.array(tot[key]) + sg * WHEEL_M
        tot[key + "_wheel_corrected"] = {"median": round(float(np.median(v)), 2), "median_abs": round(float(np.median(np.abs(v))), 2), "within_1m": round(float((np.abs(v) <= 1).mean()), 2), "within_3m": round(float((np.abs(v) <= 3).mean()), 2)}
    tot["painted_runoff"] = len(painted)
    tot["imagery_runs"] = len(kerbs)
    res["kerbs"] = tot
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("track", help="a file name in tracks/ without .json")
    ap.add_argument("--cache", type=Path, default=HERE / "cache", help="downloaded imagery and OSM (git-ignored)")
    ap.add_argument("--out", type=Path, help="default: <cache>/<track>-aerial.json")
    ap.add_argument("--crops", type=Path, help="also write check images (imagery with the result drawn on) to this folder")
    a = ap.parse_args()
    cfg = json.loads((HERE / "tracks" / f"{a.track}.json").read_text())
    src = sources.load(cfg["source"])
    s, w, n, e = cfg["bbox"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +datum=WGS84 +units=m +type=crs"  # a datum, not only an ellipsoid: PROJ skips the national datum shift without one
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    strip = Strip(src, Transformer.from_crs(local, src.crs, always_xy=True), a.cache)
    centre, left, right = fr.load_laps([REPO / r for r in cfg["recordings"]])
    raw = [left, right]
    left, right = prior = [fr.fill(v, 4) for v in raw]
    osm = np.concatenate([fr.densify(np.stack(to_local.transform(v[:, 1], v[:, 0]), 1)) for v in fr.osm_raceway(cfg["bbox"], a.cache)])
    t0, d0 = fr.coarse_fit(centre, osm)
    report: dict = {"coarse": {"scale": t0[0], "rotation_deg": math.degrees(t0[1]), "osm_median_m": float(np.median(d0)), "osm_p90_m": float(np.percentile(d0, 90))}}
    t, ((el, sl), (er, sr)), fit = refine(t0, centre, raw, prior, strip)
    d1, _ = cKDTree(osm).query(fr.apply(t, centre))
    report["refined"] = {"scale": t[0], "rotation_deg": math.degrees(t[1]), **fit, "osm_median_m": float(np.median(d1)),
                         "shift_from_coarse_m": float(np.hypot(*(fr.apply(t, centre.mean(0)[None]) - fr.apply(t0, centre.mean(0)[None]))[0]))}
    half = [el, er]
    seen = [cf.trusted(e, sn, rw, pr) for e, sn, rw, pr in zip(half, (sl, sr), raw, prior)]
    report["rejected_by_confidence"] = [int((a & ~b).sum()) for a, b in zip((sl, sr), seen)]
    sl, sr = seen
    fine = strip.get(t, centre, ex.DS)
    q = np.arange(0, len(centre), ex.DS)
    kerbs, painted, stripes = [], [], []
    for k, (name, edge) in enumerate((("left", el), ("right", er))):
        fine_edge = np.interp(q, np.arange(len(centre)), edge, period=len(centre))
        kr, pr = ex.kerb_runs(fine[k], fine_edge, name)
        # no kerb is drawn beside an edge we do not trust (a bridge, a wrong line): more than half of it unseen
        s_fine = np.interp(q, np.arange(len(centre)), seen[k].astype(float), period=len(centre)) > 0.5
        kr = [r for r in kr if s_fine[int(r["start"] / ex.DS):int(r["end"] / ex.DS) + 1].mean() >= 0.5]
        stripes.append(ex.stripe_signal(ex.beside(fine[k], fine_edge))[0])
        kerbs += kr
        painted += pr
    report["tiles"] = strip.tiles
    if cfg["survey"]:
        sv = json.loads((REPO / cfg["survey"]).read_text())
        report["grade"] = grade(sv, centre, half, seen, kerbs, painted, stripes)
        report["lmu_width"] = grade(sv, centre, [left, right], seen, kerbs, painted)["edges"]
    else:
        report["coverage"] = [float(sl.mean()), float(sr.mean())]
        report["kerb_runs"] = len(kerbs)
        report["vs_lmu_width"] = [float(np.median(np.abs(half[0] - left)[sl])), float(np.median(np.abs(half[1] - right)[sr]))]
    print(json.dumps(report, indent=1, default=float))

    pts = [world_points(centre, half[k], sg) for k, sg in ((0, 1), (1, -1))]
    out = {"source": "aerial imagery", "track": cfg["track"], "attribution": src.attribution, "licence": src.licence, "licence_url": src.licence_url, "source_url": src.source_url,
           "osm_attribution": "Alignment: © OpenStreetMap contributors, ODbL", "transform": {"scale": t[0], "rotation_deg": math.degrees(t[1])},
           "edges": [[round(float(pts[k][i, 0]), 2), round(float(pts[k][i, 1]), 2), k] for k in (0, 1) for i in np.flatnonzero(seen[k])],
           "kerbs": []}
    for r in kerbs:
        k = 0 if r["side"] == "left" else 1
        i0, i1 = round(r["start"]), min(round(r["end"]), len(centre) - 1)
        out["kerbs"].append({"side": r["side"], "start": [round(float(v), 2) for v in pts[k][i0]], "end": [round(float(v), 2) for v in pts[k][i1]], "width_m": r["width"]})
    f = a.out or a.cache / f"{a.track}-aerial.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {f} ({f.stat().st_size // 1024} KB)")
    if a.crops:
        a.crops.mkdir(parents=True, exist_ok=True)
        im = np.concatenate([fine[0][:, ::-1], fine[1]], 1).clip(0, 255).astype(np.uint8)
        mid = fine[0].shape[1]
        for k, edge in ((0, el), (1, er)):
            es = np.interp(q, np.arange(len(centre)), edge, period=len(centre))
            col = (mid - 1 - es / ex.DL if k == 0 else mid + es / ex.DL).round().astype(int)
            good = np.interp(q, np.arange(len(centre)), seen[k]) > 0.5
            im[np.flatnonzero(good), col[good]] = (0, 255, 255)
            im[np.flatnonzero(~good)[::4], col[~good][::4]] = (255, 0, 255)
            for r in kerbs:
                if r["side"] == ("left", "right")[k]:
                    rr = np.arange(int(r["start"] / ex.DS), int(r["end"] / ex.DS))
                    rr = rr[rr < len(im)]
                    for o in range(int(r["width"] / ex.DL), int(r["width"] / ex.DL) + 2):
                        im[rr, np.clip(col[rr] + (-o if k == 0 else o), 0, im.shape[1] - 1)] = (0, 0, 255)
        for m in range(0, len(centre), 350):
            Image.fromarray(np.rot90(im[m * 4:(m + 350) * 4])).resize((1400, 540)).save(a.crops / f"{a.track}_{m:05d}.png")


if __name__ == "__main__":
    main()

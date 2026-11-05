"""Decode `.lmucap` captures using the struct layout from the user's own LMU install.

    python decode.py layout [FILE] [--lmu-dir DIR]
    python decode.py player FILE --out player.csv [--lmu-dir DIR]
    python decode.py track  FILE --out track.json [--lmu-dir DIR]

The layout is computed at runtime from LMU's headers (see layout.py); nothing about it is
hard-coded here except the names of a few top-level fields used to find the player's car.
Needs Python 3.14 (capture files are zstd). Column names come from the headers' own member names.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import struct
import sys
import time
from pathlib import Path

import capture
import layout as lay

OUT = "SharedMemoryObjectOut"
TELEM = "TelemInfoV01"
SCOR = "VehicleScoringInfoV01"
SKIP_NAME = re.compile(r"Expansion|Unused")
WHEEL = re.compile(r"^mWheel_(\d)_")


def clean_name(name: str) -> str:
    return WHEEL.sub(r"w\1_", name)


def scalar_list(rec: lay.Record, prefix: str = ""):
    return [lay.Scalar(prefix + clean_name(s.name), s.offset, s.prim)
            for s in lay.flatten(rec) if not SKIP_NAME.search(s.name)]


def struct_for(scalars):
    """One struct.Struct reading all scalars (in offset order) from the start of the record."""
    parts = ["<"]
    cur = 0
    for s in scalars:
        if s.offset < cur:
            raise lay.LayoutError(f"overlapping scalars at {s.name}")
        if s.offset > cur:
            parts.append(f"{s.offset - cur}x")
        parts.append(s.prim.code)
        cur = s.offset + s.prim.size
    return struct.Struct("".join(parts))


def string_fields(rec: lay.Record, wanted: tuple[str, ...]):
    """(name, offset, length) of char arrays whose names end with one of `wanted`."""
    out = []
    for m in rec.members:
        if (m.name and isinstance(m.type, lay.Prim) and m.type.kind == "char" and m.dims
                and m.name.endswith(wanted)):
            out.append((m.name, m.offset, m.count))
    return out


class Schema:
    """Where things are in a frame and how to unpack them, derived from the headers."""

    def __init__(self, layout: lay.Layout):
        self.layout = layout
        self.out_size = layout.sizeof(OUT)
        o = layout.offsetof
        self.o_active = o(OUT, "telemetry.activeVehicles")
        self.o_pidx = o(OUT, "telemetry.playerVehicleIdx")
        self.o_phas = o(OUT, "telemetry.playerHasVehicle")
        self.o_tel = o(OUT, "telemetry.telemInfo")
        self.o_scoring_info = o(OUT, "scoring.scoringInfo")
        self.o_veh = o(OUT, "scoring.vehScoringInfo")
        self.o_nveh = self.o_scoring_info + layout.offsetof("ScoringInfoV01", "mNumVehicles")
        trec, srec = layout.record(TELEM), layout.record(SCOR)
        self.tsize, self.ssize = trec.size, srec.size
        self.max_veh = layout.record(OUT).find("telemetry")[1].type.find("telemInfo")[1].count
        self.tel_scalars = scalar_list(trec)
        self.scor_scalars = scalar_list(srec, "scor_")
        self.tel_struct = struct_for(self.tel_scalars)
        self.scor_struct = struct_for(self.scor_scalars)
        self.names = [s.name for s in self.tel_scalars] + [s.name for s in self.scor_scalars]
        self.index = {n: i for i, n in enumerate(self.names)}
        self.o_isplayer = srec.offsetof("mIsPlayer")
        self.o_time = trec.offsetof("mElapsedTime")
        self.strings = string_fields(trec, ("VehicleName", "TrackName"))
        self.nt = len(self.tel_scalars)

    def player_sample(self, f: bytes):
        """(telemetry tuple, scoring tuple | None) for the player's car in a frame, or None."""
        if not f[self.o_phas]:
            return None
        idx = f[self.o_pidx]
        if idx >= self.max_veh:
            return None
        t0 = self.o_tel + idx * self.tsize
        tel = self.tel_struct.unpack_from(f, t0)
        scor = None
        nveh = min(struct.unpack_from("<i", f, self.o_nveh)[0], self.max_veh)
        for k in range(max(nveh, 0)):
            v = self.o_veh + k * self.ssize
            if f[v + self.o_isplayer]:
                scor = self.scor_struct.unpack_from(f, v)
                break
        return tel, scor

    def strings_of(self, f: bytes):
        idx = f[self.o_pidx]
        t0 = self.o_tel + idx * self.tsize
        return {n: bytes(f[t0 + off:t0 + off + ln]).split(b"\0")[0].decode(errors="replace")
                for n, off, ln in self.strings}


def iter_player(path, schema: Schema):
    """Yield (perf_ns, tel_tuple, scor_tuple_or_None), one per unique telemetry elapsed time."""
    last = None
    ti = schema.index["mElapsedTime"]
    for perf, _wall, f in capture.iter_frames(path):
        s = schema.player_sample(f)
        if s is None:
            continue
        et = s[0][ti]
        if et == last:
            continue
        last = et
        yield perf, s[0], s[1], f


# ---------------------------------------------------------------- track

def resample(points, step: float = 1.0):
    """Resample a polyline [(x, z, y), ...] every `step` metres of horizontal (x, z) path length.

    Zero-length (stationary) segments are dropped. Returns a list of (x, z, y)."""
    pts = []
    for p in points:
        if pts and abs(p[0] - pts[-1][0]) < 1e-9 and abs(p[1] - pts[-1][1]) < 1e-9:
            continue
        pts.append(p)
    if len(pts) < 2:
        return list(pts)
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)
    out = []
    j = 0
    s = 0.0
    total = cum[-1]
    while s <= total + 1e-9:
        while j < len(pts) - 2 and cum[j + 1] < s:
            j += 1
        seg = cum[j + 1] - cum[j]
        u = (s - cum[j]) / seg if seg > 0 else 0.0
        u = min(max(u, 0.0), 1.0)
        a, b = pts[j], pts[j + 1]
        out.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u))
        s += step
    return out


def build_track(samples, source: str, track_name: str | None, tolerance_s: float = 0.05):
    """samples: iterable of (lap, x, z, y, last_lap_time, elapsed_time). Returns the JSON-ready dict.

    Lap N's time is the last positive `last lap time` seen while lap N+1 was running (the scoring
    value lags the lap counter, so it can still hold an older lap's time right after the line). It
    is only accepted when it agrees, within `tolerance_s`, with the elapsed time between the first
    samples of lap N and lap N+1; otherwise `lap_time_s` is null. Laps with fewer than 2 points
    (a counter that ticked over right at the end) are dropped. `end_index` is exclusive."""
    by_lap: dict[int, list] = {}
    last_time: dict[int, float] = {}
    first_et: dict[int, float] = {}
    for lap, x, z, y, llt, et in samples:
        by_lap.setdefault(lap, []).append((x, z, y))
        first_et.setdefault(lap, et)
        if llt is not None and llt > 0:
            last_time[lap] = llt
    points: list[list[float]] = []
    laps = []
    for lap in sorted(by_lap):
        r = resample(by_lap[lap])
        if len(r) < 2:
            continue
        start = len(points)
        points.extend([[round(x, 2), round(z, 2), round(y, 2)] for x, z, y in r])
        t = last_time.get(lap + 1)
        if t is not None and (lap + 1 not in first_et or abs((first_et[lap + 1] - first_et[lap]) - t) > tolerance_s):
            t = None
        laps.append({"lap": lap, "start_index": start, "end_index": len(points),
                     "lap_time_s": round(t, 4) if t is not None else None})
    return {"source": source, "track": track_name, "points": points, "laps": laps}


# ---------------------------------------------------------------- commands

def load_layout(args) -> lay.Layout:
    return lay.load(args.lmu_dir)


def cmd_layout(args) -> int:
    L = load_layout(args)
    print(f"headers        : {L.headers_dir}")
    for name in (TELEM, SCOR, "ScoringInfoV01", OUT):
        print(f"sizeof {name:24s}: {L.sizeof(name)}")
    sc = Schema(L)
    print(f"player scalars : {len(sc.tel_scalars)} telemetry + {len(sc.scor_scalars)} scoring")
    if args.file:
        with open(args.file, "rb") as fp:
            region = capture.read_header(fp)["region_size"]
        ok = L.sizeof(OUT) <= region
        print(f"capture region : {region} bytes ({'fits' if ok else 'TOO SMALL for'} the layout; "
              f"the region is rounded up to whole pages)")
        return 0 if ok else 1
    return 0


def cmd_player(args) -> int:
    L = load_layout(args)
    sc = Schema(L)
    t0 = time.time()
    n = 0
    meta = None
    with open(args.out, "w", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["perf_ns"] + sc.names)
        pad = [""] * len(sc.scor_scalars)
        for perf, tel, scor, f in iter_player(args.file, sc):
            if meta is None:
                meta = sc.strings_of(f)
            w.writerow([perf, *tel, *(scor if scor is not None else pad)])
            n += 1
    print(f"{n} rows, {len(sc.names)} columns -> {args.out}  ({time.time() - t0:.1f} s)")
    print("metadata:", json.dumps(meta))
    return 0


def cmd_track(args) -> int:
    L = load_layout(args)
    sc = Schema(L)
    ix = sc.index
    iet, ilap, ix_, iy, iz = ix["mElapsedTime"], ix["mLapNumber"], ix["mPos_x"], ix["mPos_y"], ix["mPos_z"]
    illt = ix.get("scor_mLastLapTime")
    t0 = time.time()
    meta = {}
    samples = []
    for _perf, tel, scor, f in iter_player(args.file, sc):
        if not meta:
            meta = sc.strings_of(f)
        llt = scor[illt - sc.nt] if (scor is not None and illt is not None) else None
        samples.append((tel[ilap], tel[ix_], tel[iz], tel[iy], llt, tel[iet]))
    track = next((v for k, v in meta.items() if k.endswith("TrackName")), None)
    source = "LMU shared-memory capture " + Path(args.file).stem
    data = build_track(samples, source, track)
    with open(args.out, "w") as fp:
        json.dump(data, fp, separators=(",", ":"))
    size = os.path.getsize(args.out)
    print(f"{len(samples)} samples, {len(data['points'])} points, {len(data['laps'])} laps "
          f"-> {args.out} ({size / 1e3:.0f} KB, {time.time() - t0:.1f} s)")
    for lp in data["laps"]:
        print(f"  lap {lp['lap']}: points {lp['start_index']}..{lp['end_index']} "
              f"({lp['end_index'] - lp['start_index']}), lap time {lp['lap_time_s']}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--lmu-dir", default=argparse.SUPPRESS,
                        help="Le Mans Ultimate install folder (else $LMU_DIR, else the default Steam path)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("layout", parents=[common], help="print sizes computed from the headers")
    p.add_argument("file", nargs="?")
    p = sub.add_parser("player", parents=[common], help="one CSV row per unique telemetry time for the player's car")
    p.add_argument("file")
    p.add_argument("--out", required=True)
    p = sub.add_parser("track", parents=[common], help="the car's path resampled every 1 m, per lap, as JSON")
    p.add_argument("file")
    p.add_argument("--out", required=True)
    ap.set_defaults(lmu_dir=None)
    args = ap.parse_args(argv)
    try:
        return {"layout": cmd_layout, "player": cmd_player, "track": cmd_track}[args.cmd](args)
    except (lay.LayoutError, capture.CaptureError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

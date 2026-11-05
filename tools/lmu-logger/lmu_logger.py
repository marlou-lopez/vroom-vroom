"""Record Le Mans Ultimate's whole shared-memory block to a compressed capture file.

Frames are stored as opaque bytes. By default the other cars' telemetry slots are blanked (the
slot positions come from the user's own LMU headers at startup); --all-cars keeps everything.
See README.md.
Usage: python lmu_logger.py [--out DIR] [--note TEXT] [--all-cars] [--lmu-dir DIR]
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import capture
import playerfilter

LOGGER_VERSION = "0.1"
STATUS_EVERY_S = 2.0
GONE_AFTER_S = 15.0  # no update for this long -> check whether the game is still there


def default_out_dir() -> Path:
    return Path(os.environ.get("USERPROFILE") or Path.home()) / "vroom-captures"


def open_file(out_dir: Path, now: datetime | None = None):
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"lmu-{stamp}.lmucap"
    return path, open(path, "wb")


def run_session(src, out_dir: Path, note: str, should_stop, log=print,
                clock=time.monotonic, player_filter=None) -> Path | None:
    """Record until the game goes away or should_stop() is true. Returns the file path.

    With a `player_filter` (playerfilter.PlayerOnly) other cars' telemetry is zeroed before each
    frame is stored; the file header records the mode either way."""
    path, fp = open_file(out_dir)
    w = capture.CaptureWriter(fp, src.region_size, start_wall_ns=time.time_ns(),
                              start_perf_ns=time.perf_counter_ns(), note=note,
                              logger_version=LOGGER_VERSION,
                              extra=player_filter.header() if player_filter else playerfilter.ALL_CARS_HEADER)
    log(f"LMU found (region {src.region_size} bytes). Recording "
        f"{'the player only' if player_filter else 'all cars'} to {path}")
    buf = bytearray(src.region_size)
    t0 = last_status = last_update = last_check = clock()
    frames_at_status = 0
    interrupted = False
    try:
        while not should_stop():
            if src.wait_update(200):
                perf, wall = time.perf_counter_ns(), time.time_ns()
                src.read_into(buf)  # copy first, everything else after
                if player_filter:
                    player_filter.apply(buf)
                w.write_frame(perf, wall, buf)
                last_update = clock()
            else:
                now = clock()
                if now - last_update >= GONE_AFTER_S and now - last_check >= GONE_AFTER_S:
                    last_check = now
                    if not src.still_there():
                        log("LMU has closed; finishing this file.")
                        break
            now = clock()
            if now - last_status >= STATUS_EVERY_S:
                fps = (w.frames - frames_at_status) / (now - last_status)
                idle = now - last_update
                state = "LMU idle" if idle >= STATUS_EVERY_S else f"last update {idle:.1f}s ago"
                ratio = w.bytes_in / w.bytes_out if w.bytes_out else 0
                log(f"{fps:6.1f} frames/s | {w.bytes_out / 1e6:7.1f} MB written | "
                    f"ratio {ratio:5.1f}x | {state}")
                last_status, frames_at_status = now, w.frames
    except KeyboardInterrupt:
        interrupted = True
    finally:
        fp.close()
    if w.frames == 0:
        os.remove(path)  # our own empty file
        path = None
    else:
        log(f"Saved {w.frames} frames, {w.bytes_out / 1e6:.1f} MB, in {clock() - t0:.0f}s: {path}")
    if interrupted:
        raise KeyboardInterrupt
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=default_out_dir(), help="output directory")
    ap.add_argument("--all-cars", action="store_true",
                    help="record every car's telemetry (about 10x bigger files) instead of the player only")
    ap.add_argument("--lmu-dir", help="Le Mans Ultimate folder, to find its headers (else $LMU_DIR, else auto-detect)")
    ap.add_argument("--note", default="", help="free text stored in the file header")
    args = ap.parse_args(argv)

    import winmem
    try:
        winmem._api()
    except winmem.UnsupportedPlatform as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    stop = False
    try:
        while not stop:
            src = winmem.LmuSource.try_open()
            if src is None:
                print("Waiting for Le Mans Ultimate (shared memory not found)...")
                end = time.monotonic() + 2.0
                while time.monotonic() < end:
                    time.sleep(0.1)
                continue
            pf = None
            if not args.all_cars:
                pf, why = playerfilter.build(src.region_size, args.lmu_dir)
                if pf is None:
                    print(f"WARNING: cannot record the player only ({why}). Recording ALL cars "
                          "instead (files will be much bigger). Pass --lmu-dir or set LMU_DIR to fix.")
            try:
                run_session(src, args.out, args.note, lambda: False, player_filter=pf)
            finally:
                src.close()
            time.sleep(2.0)  # let the game finish tearing down before looking again
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

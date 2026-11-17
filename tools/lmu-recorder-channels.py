#!/usr/bin/env python3
"""List the channel and event names LMU's built-in recorder knows, and diff them with config.json.

LMU's recorder (TelemetryManager, Source/Telemetry/Telemetry.cpp) looks every name in
UserData/Telemetry/config.json up in a table compiled into "Le Mans Ultimate.exe". The names sit
together in the exe's string data, next to the recorder's own strings ("UserData\\Telemetry\\",
"config.json", "CREATE TABLE channelsList ..."). A name that is not in the exe cannot be recorded,
so this script answers "can I add channel X?" without launching the game (vroom-pnw.16,
docs/lmu-channels.md). Re-run it after an LMU update.

Usage:
  python3 -I tools/lmu-recorder-channels.py [--lmu-dir DIR] [--check "Yaw Rate" ...]

Standard library only. Reads the exe and config.json; writes nothing.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_LMU = "/mnt/d/Steam/steamapps/common/Le Mans Ultimate"
# Strings that bracket the recorder's name table in the exe (checked on the 2026-09-23 build).
START = "UserData\\Telemetry\\"
END = "SessionType"  # the metadata keys (SessionType, TrackName, CarName, ...) follow the names
TAIL = ("Wheel Speed", "WheelsDetached", "TyresTempLeft", "TyresTempRight")  # pooled after the block
# SQL column types, format strings and unit labels that are interleaved with the names.
NOT_NAMES = re.compile(r"^(value|\{|J/\(kg|On/Off$|km/h$|kg/m3$|deg$|kPa$|m/s$|[a-z%/]{1,4}$)")


def ascii_runs(data: bytes, min_len: int = 3) -> list[str]:
    return [m.group().decode() for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, data)]


def recorder_names(runs: list[str]) -> list[str]:
    try:
        i = runs.index(START)
        j = runs.index(END, i)
    except ValueError:
        sys.exit("recorder strings not found: the exe layout changed, update START/END")
    block = [s for s in runs[i + 1 : j] if not NOT_NAMES.match(s)]
    block += [s for s in TAIL if s in runs]
    return block


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--lmu-dir", default=DEFAULT_LMU)
    ap.add_argument("--check", nargs="*", default=[], help="names to look for in the exe (whole ASCII strings of 3+ characters; names already in config.json count as known)")
    args = ap.parse_args()
    lmu = Path(args.lmu_dir)
    runs = ascii_runs((lmu / "Le Mans Ultimate.exe").read_bytes())
    everywhere = set(runs)
    table = recorder_names(runs)
    cfg = json.loads((lmu / "UserData" / "Telemetry" / "config.json").read_text())
    used = set(cfg.get("Channels", {})) | set(cfg.get("Events", {}))

    print(f"recorder name block: {len(table)} names; config.json: "
          f"{len(cfg.get('Channels', {}))} channels, {len(cfg.get('Events', {}))} events")
    # Short or pooled names (e.g. "TC", "TCCut") live elsewhere in the exe; count them as known.
    missing = sorted(n for n in used - set(table) if n not in everywhere)
    pooled = sorted(n for n in used - set(table) if n in everywhere)
    print("config names found elsewhere in the exe (pooled/short strings):", ", ".join(pooled) or "-")
    print("config names not in the exe at all:", ", ".join(missing) or "-", "(expected: TC, a 2-char string)")
    print("known to the recorder but not in config.json:")
    for n in sorted(set(table) - used):
        print("  ", n)
    for n in args.check:
        where = ("in the recorder block" if n in table else "in config.json (recorded today)" if n in used
                 else "in the exe" if n in everywhere else "absent")
        print(f"check {n!r}: {where}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

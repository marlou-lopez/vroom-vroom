"""Per-lap stint stats from an LMU .duckdb recording, for the experimental Stint view (vroom-pnw.26).

    uv run --with duckdb python -I extract-stint.py <copy.duckdb> <out.json> "<source label>"

Run it on a COPY of the recording (it opens its input read-only, but recordings must never be modified).
Per lap: official time, kind (out / flying / in / incomplete), fuel and virtual energy at the start and end of the lap,
tyre surface temperature (mean of the three tread zones), carcass temperature, pressure, wear left at the end of the lap,
mean brake temperature, and track and air temperature at the lap start. Wheel order is FL, FR, RL, RR (verified on the
Monza race of 2026-11-09: the left tyres and the front brakes run hotter on that right-handed track).
No driver name is written (the repo is public).
"""
import bisect
import json
import sys

import duckdb

WHEELS = ("fl", "fr", "rl", "rr")
W = "value1, value2, value3, value4"


def main(src: str, out: str, label: str) -> None:
    c = duckdb.connect(src, read_only=True)
    q = lambda s: c.execute(s).fetchall()
    freq = dict(q("select channelName, frequency from channelsList"))
    t0 = q('select min(value) from "GPS Time"')[0][0]
    end = t0 + (q('select count(*) from "GPS Time"')[0][0] - 1) / freq["GPS Time"]
    meta = dict(q("select key, value from metadata where key <> 'CarSetup' and key <> 'DriverName' and key <> 'SteamID'"))

    def series(name, cols="value"):
        rows = q(f'select {cols} from "{name}"')  # continuous channels: sample i is at t0 + i / frequency
        return [t0 + i / freq[name] for i in range(len(rows))], rows

    def events(name, cols="value"):
        return q(f'select ts, {cols} from "{name}" order by ts')

    def at(s, t):
        i = min(max(bisect.bisect_right(s[0], t) - 1, 0), len(s[0]) - 1)
        return s[1][i]

    def mean(s, a, b):
        i, j = bisect.bisect_left(s[0], a), bisect.bisect_left(s[0], b)
        rows = s[1][i:j]
        return [sum(r[k] for r in rows) / len(rows) for k in range(len(rows[0]))] if rows else None

    def wheels(vals, nd=1):
        return None if vals is None else {w: round(v, nd) for w, v in zip(WHEELS, vals)}

    fuel, ve = series("Fuel Level"), series("Virtual Energy")
    wear, pres = series("Tyres Wear", W), series("TyresPressure", W)
    zones = [series(n, W) for n in ("TyresTempLeft", "TyresTempCentre", "TyresTempRight")]
    carcass, brakes = series("TyresCarcassTemp", W), series("Brakes Temp", W)
    track, air = series("Track Temperature"), series("Ambient Temperature")
    laps, lap_times, pits = events("Lap"), events("Lap Time"), events("In Pits")
    has_energy = max(r[0] for r in ve[1]) > 0

    def in_pits(t):
        v = [p[1] for p in pits if p[0] <= t]
        return bool(v and v[-1])

    out_laps = []
    for k, (a, lap_no) in enumerate(laps):
        b = laps[k + 1][0] if k + 1 < len(laps) else end
        closed = k + 1 < len(laps)
        t = [x[1] for x in lap_times if abs(x[0] - b) < 0.05] if closed else []
        lap_time = t[0] if t else None
        pit_in = any(a < p[0] <= b and p[1] for p in pits)
        if k == 0 or in_pits(a + 0.01):
            kind = "out"  # lap 0 (out-lap, or the start lap of a race) or a lap that starts in the pits
        elif pit_in:
            kind = "in"
        elif not closed:
            kind = "incomplete"
        else:
            kind = "flying"
        e = b - 0.11  # last sample before the line (10 Hz channels)
        surf = [mean(z, a, b) for z in zones]
        f0, f1 = at(fuel, a)[0], at(fuel, e)[0]
        v0, v1 = at(ve, a)[0], at(ve, e)[0]
        out_laps.append({
            "lap_no": lap_no,
            "kind": kind,
            "lap_time_s": None if lap_time is None else round(lap_time, 3),
            "valid": bool(lap_time),
            "duration_s": round(b - a, 3),
            "fuel_start_l": round(f0, 2), "fuel_end_l": round(f1, 2),
            "energy_start_pct": round(v0, 2) if has_energy else None, "energy_end_pct": round(v1, 2) if has_energy else None,
            "tyre_surface_c": wheels([sum(z[w] for z in surf) / 3 for w in range(4)]),
            "tyre_zones_c": {
                side: wheels(z) for side, z in zip(("left", "centre", "right"), surf)
            },
            "tyre_carcass_c": wheels(mean(carcass, a, b)),
            "tyre_pressure_kpa": wheels(mean(pres, a, b)),
            "tyre_wear_end_pct": wheels(at(wear, e), 2),
            "brake_c": wheels(mean(brakes, a, b), 0),
            "track_temp_c": round(at(track, a)[0], 1),
            "air_temp_c": round(at(air, a)[0], 1),
        })
    doc = {
        "source": label,
        "note": "Per-lap stint stats (tools/extract-stint.py). Wheels FL FR RL RR. tyre_zones_c left/right are the car's left/right edge of the tread.",
        "session_type": meta.get("SessionType"),
        "car_class": meta.get("CarClass"),
        "weather": meta.get("WeatherConditions"),
        "compound": [list(r[1:]) for r in events("TyresCompound", W)][:1],
        "laps": out_laps,
    }
    with open(out, "w") as fh:
        json.dump(doc, fh, indent=1)
    print(f"{len(out_laps)} laps -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit('usage: extract-stint.py <copy.duckdb> <out.json> "<source label>"')
    main(*sys.argv[1:])

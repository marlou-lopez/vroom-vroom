# Tools

## extract-laps.mjs

Turns an LMU `.duckdb` recording into the 1 m grid JSON used by the frontend mock API.

```bash
node extract-laps.mjs <recording.duckdb> <out.json>
```

- It needs `@duckdb/node-api`, installed in the directory you run it from
  (`npm i @duckdb/node-api`). No `package.json` pins it.
- It imports `surface-resample.mjs` from the same folder (the stepwise resampler and the wheels-off count, unit-tested from `frontend/`), so run it from there or keep both files together.
- Run it on a copy of the recording. The script opens its input read-only but does not copy
  it, and recordings must never be modified.
- LMU quirks handled in the script: the G channels are swapped (`G Force Lat` is longitudinal,
  `G Force Long` is lateral), and throttle comes from `Throttle Pos Unfiltered` because
  `Throttle Pos` includes the cut at every upshift.

## extract-stint.py

Per-lap stint stats from an LMU `.duckdb` recording, for the experimental Stint view (vroom-pnw.26): lap time and kind, fuel and
virtual energy at the start and end of each lap, tyre temperatures (three zones, carcass), pressures, wear and brake temperatures.

```bash
uv run --with duckdb python -I extract-stint.py <copy.duckdb> <out.json> "<source label>"
```

Run it on a copy of the recording. No driver name is written. Channel facts: `docs/lmu-duckdb-schema.md`, "Stint channels".

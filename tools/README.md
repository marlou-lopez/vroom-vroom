# Tools

## extract-laps.mjs

Turns an LMU `.duckdb` recording into the 1 m grid JSON used by the frontend mock API.

```bash
node extract-laps.mjs <recording.duckdb> <out.json>
```

- It needs `@duckdb/node-api`, installed in the directory you run it from
  (`npm i @duckdb/node-api`). No `package.json` pins it.
- Run it on a copy of the recording. The script opens its input read-only but does not copy
  it, and recordings must never be modified.
- LMU quirks handled in the script: the G channels are swapped (`G Force Lat` is longitudinal,
  `G Force Long` is lateral), and throttle comes from `Throttle Pos Unfiltered` because
  `Throttle Pos` includes the cut at every upshift.

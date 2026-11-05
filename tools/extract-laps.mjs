// One-off extractor: LMU .duckdb -> 1 m grid JSON for the mock API. Run from a dir with @duckdb/node-api installed:
//   node extract-laps.mjs <recording.duckdb> <out.json>
// NOTE LMU swaps its G channels: 'G Force Lat' is longitudinal, 'G Force Long' is lateral (mapped below).
// Throttle comes from 'Throttle Pos Unfiltered' (the pedal); 'Throttle Pos' includes the ignition cut at every upshift (#49).
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
const [,, file, out] = process.argv;
const db = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
const c = await db.connect();
const q = async (s) => (await c.runAndReadAll(s)).getRowObjectsJson();
const freq = Object.fromEntries((await q('select channelName, frequency from channelsList')).map(r => [r.channelName, Number(r.frequency)]));
const t0 = Number((await q('select min(value) v from "GPS Time"'))[0].v);
const series = async (name, col = 'value') => {
  const vals = (await q(`select ${col} as v from "${name}"`)).map(r => Number(r.v));
  const f = freq[name];
  return { t: vals.map((_, i) => t0 + i / f), v: vals };
};
const ev = async (name) => (await q(`select ts, value from "${name}" order by ts`)).map(r => ({ t: Number(r.ts), v: Number(r.value) }));
const interp = (xs, ys, x) => { // xs ascending
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]) return ys[0]; if (x >= xs[hi]) return ys[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo]); return ys[lo] + f * (ys[hi] - ys[lo]);
};
const step = (xs, ys, x) => { let lo = 0, hi = xs.length - 1; if (x < xs[0]) return ys[0]; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; } return xs[hi] <= x ? ys[hi] : ys[lo]; };

const laps = await ev('Lap'), lapTimes = await ev('Lap Time');
const ch = {
  dist: await series('Lap Dist'), speed: await series('Ground Speed'), thr: await series('Throttle Pos Unfiltered'), brk: await series('Brake Pos'),
  steer: await series('Steering Pos'), rpm: await series('Engine RPM'), glat: await series('G Force Lat'), glong: await series('G Force Long'),
  lat: await series('GPS Latitude'), lon: await series('GPS Longitude'), pl: await series('Path Lateral'), te: await series('Track Edge'),
};
const surf = await q('select value1,value2,value3,value4 from SurfaceTypes');
const kerb = { t: surf.map((_, i) => t0 + i / freq['SurfaceTypes']), v: surf.map(r => [r.value1, r.value2, r.value3, r.value4].some(x => Number(x) === 5 || Number(x) === 6) ? 1 : 0) };
const gearsRaw = await ev('Gear');
const gears = gearsRaw.filter((g, i) => !(g.v === 0 && gearsRaw[i + 1] && gearsRaw[i + 1].t - g.t < 0.2));

const out_laps = [];
for (let k = 0; k < laps.length; k++) {
  const a = laps[k].t, b = k + 1 < laps.length ? laps[k + 1].t : t0 + (ch.speed.v.length - 1) / 100;
  const lt = lapTimes.find(x => Math.abs(x.t - b) < 0.05);
  // distance samples inside the lap; fix the wrap at the start
  const ts = [], ds = [];
  for (let i = 0; i < ch.dist.t.length; i++) {
    const t = ch.dist.t[i]; if (t < a || t > b) continue;
    let d = ch.dist.v[i]; if (t - a < 3 && d > 3000) d = 0; if (b - t < 3 && d < 3000 && ds.length && ds.at(-1) > 3000) continue;
    if (ds.length && d <= ds.at(-1)) continue; ts.push(t); ds.push(d);
  }
  const L = Math.floor(ds.at(-1));
  const g = {};
  const keys = ['t', 'speed_kmh', 'throttle', 'brake', 'steering', 'gear', 'rpm', 'g_lat', 'g_long', 'lat', 'lon', 'path_lateral', 'track_edge', 'kerb'];
  for (const k2 of keys) g[k2] = new Array(L + 1);
  for (let d = 0; d <= L; d++) {
    const t = interp(ds, ts, d);
    g.t[d] = +(t - a).toFixed(3);
    g.speed_kmh[d] = +interp(ch.speed.t, ch.speed.v, t).toFixed(1);
    g.throttle[d] = +(interp(ch.thr.t, ch.thr.v, t) / 100).toFixed(3);
    g.brake[d] = +(interp(ch.brk.t, ch.brk.v, t) / 100).toFixed(3);
    g.steering[d] = +(interp(ch.steer.t, ch.steer.v, t) / 100).toFixed(4);
    g.gear[d] = step(gears.map(x => x.t), gears.map(x => x.v), t);
    g.rpm[d] = Math.round(interp(ch.rpm.t, ch.rpm.v, t));
    g.g_long[d] = +interp(ch.glat.t, ch.glat.v, t).toFixed(3);
    g.g_lat[d] = +interp(ch.glong.t, ch.glong.v, t).toFixed(3);
    g.lat[d] = +interp(ch.lat.t, ch.lat.v, t).toFixed(7);
    g.lon[d] = +interp(ch.lon.t, ch.lon.v, t).toFixed(7);
    g.path_lateral[d] = +interp(ch.pl.t, ch.pl.v, t).toFixed(2);
    g.track_edge[d] = +interp(ch.te.t, ch.te.v, t).toFixed(2);
    g.kerb[d] = step(kerb.t, kerb.v, t);
  }
  out_laps.push({ lap_no: k, start_ts: a, end_ts: b, lap_time_s: lt ? (lt.v > 0 ? +lt.v.toFixed(3) : 0) : null, length_m: L, ...g });
  console.log('lap', k, 'start', a.toFixed(2), 'dur', (b - a).toFixed(2), 'time', lt ? lt.v.toFixed(3) : '-', 'firstDist', ds[0].toFixed(1), 'L', L, 'gridT', g.t[L]);
}
fs.writeFileSync(out, JSON.stringify({ source: 'LMU recording 2026-11-03 Spa practice, 720S (Garage 59 #58)', steering_range_deg: 524, laps: out_laps }));
console.log('bytes', fs.statSync(out).size);

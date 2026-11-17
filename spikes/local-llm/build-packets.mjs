// Builds the spike's facts packets (design §8) from a real mock recording, using the mock API's own corner facts.
// Run from the repo root after `npm ci` in frontend/:
//   node spikes/local-llm/build-packets.mjs [--track spa|monza] [--laps auto|2:4,3:4]
// --laps auto (default): the slowest and second-slowest valid laps, each against the best valid lap; the Corner packet is
// the first pair's biggest loss. Spa writes packets/ (set v1) and packets-v2/; another track writes packets-<track>/ and
// packets-v2-<track>/. Every number is pre-formatted as a string, so the guard can match it exactly.
// A new recording: add it to TRACKS below (its JSON in frontend/public/mock/, made by tools/extract-laps.mjs).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const front = join(here, "../../frontend");
const require = createRequire(join(front, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const server = await createServer({ root: front, configFile: false, logLevel: "error", server: { middlewareMode: true } });
const load = (p) => server.ssrLoadModule(p);
const { createMockApi } = await load("/src/api/mock/mockApi.ts");
const facts = await load("/src/api/mock/coachFacts.ts");
const { causeOf } = await load("/src/lib/cornerCause.ts");

const TRACKS = {
  spa: { file: "spa-2026-11-03.json", loader: "loadSpa", name: "Spa-Francorchamps", session: "practice, 3 Nov 2026",
    straights: "exits onto long straights (Kemmel, the run to the Bus Stop)", suffix: "" },
  monza: { file: "monza-2026-11-05.json", loader: "loadMonza", name: "Monza", session: "practice, 5 Nov 2026",
    straights: "exits onto long straights (after the chicanes, Ascari and Parabolica)", suffix: "-monza" },
};
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const TRACK = TRACKS[arg("track", "spa")];
if (!TRACK) throw new Error(`--track must be one of ${Object.keys(TRACKS).join(", ")}`);
const REC = JSON.parse(readFileSync(join(front, "public/mock", TRACK.file), "utf8"));
const api = createMockApi({ coachDelayMs: 0, [TRACK.loader]: async () => REC });
const session = (await api.sessions())[0];
const laps = await api.sessionLaps(session.session_id);
const map = await api.trackMap(session.track_id);
const byNo = (n) => laps.find((l) => l.lap_no === n);
/** Each lap's time channel on the 1 m grid, from the mock API (the app's lap numbers, not the raw file's). */
const lapT = new Map();
for (const l of laps) if (l.lap_time_s) lapT.set(l.lap_id, (await api.lapTrace(l.lap_id, ["t"])).ch.t);

const f0 = (x) => (Math.round(x) || 0).toFixed(0);
const f1 = (x) => x.toFixed(1);
const f3 = (x) => x.toFixed(3);
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const lapTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
const signed = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(3)}`;

const PROFILE = {
  driver: "casual sim racer, Simagic P1000 load-cell pedals, metric units",
  focus_areas: ["minimum corner speeds", TRACK.straights, "consistency"],
};

function sideFacts(side, c, anchors) {
  const apexKerbs = anchors.filter((a) => a.kind === "kerb_apex");
  const pos = (p, list) => (p === null ? null : facts.describeAgainst(p, list) ?? `${facts.offsetPhrase(p - c.apex_m)} the apex`);
  return {
    min_speed_kmh: f0(side.minSpeed),
    min_speed_where: Math.abs(side.minIdx - c.apex_m) <= 100 ? `${facts.offsetPhrase(side.minIdx - c.apex_m)} the apex` : null,
    exit_speed_kmh: f0(side.exitSpeed),
    brake_onset: pos(side.brakeOnset, anchors),
    peak_brake: pct(side.peakBrake),
    throttle_pickup: pos(side.throttlePickup, apexKerbs),
    coast_s: f1(side.coastS),
    pedal_overlap_s: f1(side.overlapS),
    steering_extrema: String(side.steerExtrema),
  };
}

async function comparisonFacts(lapNo, refNo) {
  const [lap, ref] = [byNo(lapNo), byNo(refNo)];
  const cmp = await api.compare(lap.lap_id, ref.lap_id);
  const list = map.corners.map((c) => facts.cornerComparison(c, cmp.lap, cmp.ref, cmp.delta, map.landmarks));
  return { lap, ref, cmp, list };
}

function cornerFacts(cc, kind) {
  const c = cc.corner;
  return {
    corner_id: c.id, corner: c.name, kind,
    time_s: f3(cc.delta),
    likely_cause: causeOf(cc.metrics),
    lap: sideFacts(cc.lap, c, cc.anchors),
    reference: sideFacts(cc.ref, c, cc.anchors),
    landmarks: [...new Set(cc.anchors.map((a) => a.label))],
  };
}

const header = (command, lap, ref) => ({
  command,
  track: TRACK.name, car: session.car_name, session: TRACK.session,
  lap: `lap ${lap.lap_no}, ${lapTime(lap.lap_time_s)}`,
  reference: ref ? `lap ${ref.lap_no}, ${lapTime(ref.lap_time_s)}` : null,
  profile: PROFILE,
});

// Same selection as the mock coach (and design §8): top losses one per complex, 3 issues >= 0.05 s, 1 minor, 1 strength.
function analyzePacket({ lap, ref, cmp, list }) {
  const seen = new Set();
  const ordered = [...list].sort((a, b) => b.delta - a.delta).filter((f) => {
    const k = f.corner.complex ?? f.corner.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const losing = ordered.slice(0, 5);
  const issues = losing.filter((f) => f.delta >= 0.05).slice(0, 3);
  const minor = losing.find((f) => !issues.includes(f) && f.delta >= 0.01);
  const gain = ordered[ordered.length - 1];
  const strength = gain && gain.delta <= -0.01 ? gain : null;
  const corners = [...issues.map((f) => cornerFacts(f, "issue")), ...(minor ? [cornerFacts(minor, "minor")] : []), ...(strength ? [cornerFacts(strength, "strength")] : [])];
  return {
    ...header("analyze", lap, ref),
    lap_delta_s: signed(cmp.delta[cmp.delta.length - 1]),
    rules: "Write one finding per corner below, keeping its kind and time_s. focus is the first issue's corner.",
    corners,
  };
}

function averagePacket() {
  const valid = laps.filter((l) => l.kind === "flying" && (l.valid_override ?? l.valid) && l.lap_time_s);
  const times = valid.map((l) => l.lap_time_s);
  const st = facts.spread(times);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const cornerTime = (l, c) => {
    const t = lapT.get(l.lap_id);
    return t[Math.min(c.end_m, t.length - 1)] - t[c.start_m];
  };
  const spreads = map.corners
    .map((c) => ({ c, st: facts.spread(valid.map((l) => cornerTime(l, c))) }))
    .sort((a, b) => b.st.sd - a.st.sd).slice(0, 3);
  return {
    ...header("average", valid[0], null),
    lap: `${valid.length} valid laps: ${valid.map((l) => `lap ${l.lap_no} ${lapTime(l.lap_time_s)}`).join(", ")}`,
    stats: { laps: String(valid.length), mean: lapTime(mean), lap_sd_s: f3(st.sd), best: lapTime(st.min), worst: lapTime(st.max) },
    rules: "Write one inconsistent finding per corner below, with time_s = sd_s. No focus.",
    corners: spreads.map(({ c, st: s }) => ({
      corner_id: c.id, corner: c.name, kind: "inconsistent", time_s: f3(s.sd),
      sd_s: f3(s.sd), fastest_s: f3(s.min), slowest_s: f3(s.max), laps: String(s.n),
      landmarks: map.landmarks.filter((l) => l.corner_id === c.id && l.confidence !== "low").map((l) => l.label).filter((x, i, a) => a.indexOf(x) === i),
    })),
  };
}

function cornerPacket({ lap, ref, cmp, list }, cornerId) {
  const cc = list.find((x) => x.corner.id === cornerId);
  const c = cc.corner;
  const kind = cc.delta >= 0.05 ? "issue" : cc.delta <= -0.01 ? "strength" : "minor";
  const trace = (ch) => {
    const rows = [];
    for (let i = c.start_m; i <= c.end_m; i += 10) {
      rows.push([String(i - c.apex_m), f0(ch.speed_kmh[i]), pct(ch.throttle[i]), pct(ch.brake[i]), f0(ch.steering[i] * 100), String(ch.gear[i])]);
    }
    return rows;
  };
  return {
    ...header("corner", lap, ref),
    rules: "One finding for this corner, keeping kind and time_s. The trace is for your reading only: never quote its position column, and the fix uses no distances.",
    corner: cornerFacts(cc, kind),
    trace: {
      columns: ["m_from_apex", "speed_kmh", "throttle", "brake", "steering", "gear"],
      note: "every 10 m from the corner start to its end; steering in % of full lock, -100..100, + = right",
      lap: trace(cmp.lap),
      reference: trace(cmp.ref),
    },
  };
}

// ---- packet set v2: driver aids, engine, kerbs, cause confidence, landmark roles, per-lap Average facts ----

const { aidRuns } = await load("/src/lib/driverAids.ts");
const { deriveRpmLimits } = await load("/src/lib/shiftLights.ts");
const REV_LIMITER = Number(String(REC.car_setup?.VM_REV_LIMITER ?? "").replace(/[^\d]/g, "")) || null;
/** "On the limiter": within 1.5 % of the rev limiter from the car setup (else of the shift point derived from the lap). */
const LIMITER_FRACTION = 0.985;

const inCorner = (c, i) => (c.start_m <= c.end_m ? i >= c.start_m && i <= c.end_m : i >= c.start_m || i <= c.end_m);
const cornerIdx = (c, n) => {
  const out = [];
  for (let i = 0; i < n; i++) if (inCorner(c, i)) out.push(i);
  return out;
};
const secondsWhere = (ch, idx, flag) => {
  let s = 0;
  for (const i of idx) if (i + 1 < ch.t.length && flag(i)) s += ch.t[i + 1] - ch.t[i];
  return s;
};
const where = (pos, c, anchors) => facts.describeAgainst(pos, anchors) ?? `${facts.offsetPhrase(pos - c.apex_m)} the apex`;

/** Aids, engine and kerb facts for one lap in one corner, all as display strings. */
function extrasOf(ch, c, anchors) {
  const n = ch.t.length;
  const idx = cornerIdx(c, n);
  const runs = aidRuns(ch);
  const first = (rs) => rs.find((r) => idx.includes(r.start) || idx.includes(r.end));
  const lock = first(runs.lockup);
  const spin = first(runs.wheelspin);
  const limits = deriveRpmLimits(ch.rpm, ch.gear);
  const limit = REV_LIMITER ?? limits?.limit ?? null;
  const minI = idx.reduce((m, i) => (ch.speed_kmh[i] < ch.speed_kmh[m] ? i : m), idx[0]);
  return {
    abs_active_s: f1(secondsWhere(ch, idx, (i) => ch.abs[i] > 0)),
    tc_active_s: f1(secondsWhere(ch, idx, (i) => ch.tc[i] > 0)),
    lockup: lock ? where(lock.start, c, anchors) : "none",
    wheelspin: spin ? where(spin.start, c, anchors) : "none",
    on_rev_limiter_s: limit ? f1(secondsWhere(ch, idx, (i) => ch.rpm[i] >= LIMITER_FRACTION * limit)) : null,
    peak_rpm: f0(Math.max(...idx.map((i) => ch.rpm[i]))),
    gear_at_min_speed: String(ch.gear[minI]),
    on_kerb_s: f1(secondsWhere(ch, idx, (i) => ch.kerb[i] > 0)),
  };
}

/** causeOf's scores (src/lib/cornerCause.ts), kept here to get the margin: >= 1 counts, the top's lead sets the confidence. */
function causeWithConfidence(m) {
  const { lap, ref } = m;
  const scores = [
    ["brake", lap.brake_onset_m !== null && ref.brake_onset_m !== null ? Math.abs(lap.brake_onset_m - ref.brake_onset_m) / 15 : 0],
    ["throttle", lap.throttle_pickup_m !== null && ref.throttle_pickup_m !== null ? (lap.throttle_pickup_m - ref.throttle_pickup_m) / 15 : 0],
    ["steering", (lap.steer_corrections - ref.steer_corrections) / 2],
    ["speed", (ref.min_speed_kmh - lap.min_speed_kmh) / 3],
  ].sort((a, b) => b[1] - a[1]);
  const cause = causeOf(m);
  const [top, second] = scores;
  const confidence = top[1] < 1 ? "low" : top[1] >= 2 && second[1] < 1 ? "high" : "medium";
  const basis = {
    brake: "the braking point differs from the reference",
    throttle: "the throttle pickup comes later than on the reference",
    steering: "more steering corrections than the reference",
    speed: "a lower minimum speed than the reference",
  }[cause];
  return { cause, cause_confidence: confidence, cause_basis: top[1] < 1 ? "no single input stands out" : basis };
}

function landmarkRoles(c, anchors) {
  const seen = new Set();
  return anchors
    .map((a) => {
      const side = a.distance_m < c.apex_m - 8 ? "before the apex" : a.distance_m > c.apex_m + 8 ? "after the apex" : "at the apex";
      const role = a.kind === "brake_board" ? "braking reference" : a.kind === "kerb_entry" ? "turn-in" : a.kind === "kerb_apex" ? "apex" : a.kind === "kerb_exit" ? "exit" : "reference";
      return `${a.label} (${role}, ${side})`;
    })
    .filter((x) => !seen.has(x) && seen.add(x));
}

function cornerFactsV2(cc, kind, cmp) {
  const base = cornerFacts(cc, kind);
  delete base.likely_cause;
  return {
    ...base,
    ...causeWithConfidence(cc.metrics),
    lap: { ...base.lap, ...extrasOf(cmp.lap, cc.corner, cc.anchors) },
    reference: { ...base.reference, ...extrasOf(cmp.ref, cc.corner, cc.anchors) },
    landmarks: landmarkRoles(cc.corner, cc.anchors),
  };
}

const NOTES_V2 = {
  aids: "abs_active_s / tc_active_s: seconds the ABS / traction control was working in the corner. lockup / wheelspin: where a wheel locked under braking or a rear wheel spun under power, or none",
  engine: `on_rev_limiter_s: seconds within 1.5% of the ${REV_LIMITER ?? "derived"} rpm rev limiter. gear_at_min_speed: the gear at the slowest point`,
  cause: "cause and cause_confidence are computed in code; state a high or medium cause as fact",
};

function analyzePacketV2(cf) {
  const p = analyzePacket(cf);
  const byId = new Map(cf.list.map((x) => [x.corner.id, x]));
  return { ...p, notes: NOTES_V2, corners: p.corners.map((c) => cornerFactsV2(byId.get(c.corner_id), c.kind, cf.cmp)) };
}

function cornerPacketV2(cf, cornerId) {
  const p = cornerPacket(cf, cornerId);
  const cc = cf.list.find((x) => x.corner.id === cornerId);
  const c = cc.corner;
  const trace = (ch) => {
    const rows = [];
    for (let i = c.start_m; i <= c.end_m; i += 10) {
      rows.push([String(i - c.apex_m), f0(ch.speed_kmh[i]), pct(ch.throttle[i]), pct(ch.brake[i]), f0(ch.steering[i] * 100),
        String(ch.gear[i]), f0(ch.rpm[i]), ch.abs[i] > 0 ? "on" : "off", ch.tc[i] > 0 ? "on" : "off", ch.kerb[i] > 0 ? "yes" : "no"]);
    }
    return rows;
  };
  return {
    ...p, notes: NOTES_V2,
    corner: cornerFactsV2(cc, p.corner.kind, cf.cmp),
    trace: {
      columns: ["m_from_apex", "speed_kmh", "throttle", "brake", "steering", "gear", "rpm", "abs", "tc", "kerb"],
      note: "every 10 m from the corner start to its end; steering in % of full lock, -100..100, + = right",
      lap: trace(cf.cmp.lap), reference: trace(cf.cmp.ref),
    },
  };
}

/** Average with a reason to work from: each variable corner's facts on its fastest and its slowest lap. */
async function averagePacketV2() {
  const p = averagePacket();
  const valid = laps.filter((l) => l.kind === "flying" && (l.valid_override ?? l.valid) && l.lap_time_s);
  const cornerTime = (l, c) => {
    const t = lapT.get(l.lap_id);
    return t[Math.min(c.end_m, t.length - 1)] - t[c.start_m];
  };
  const corners = [];
  for (const pc of p.corners) {
    const c = map.corners.find((x) => x.id === pc.corner_id);
    const sorted = [...valid].sort((a, b) => cornerTime(a, c) - cornerTime(b, c));
    const [fast, slow] = [sorted[0], sorted[sorted.length - 1]];
    const cmp = await api.compare(slow.lap_id, fast.lap_id);
    const cc = facts.cornerComparison(c, cmp.lap, cmp.ref, cmp.delta, map.landmarks);
    const side = (s, ch) => ({ ...sideFacts(s, c, cc.anchors), ...extrasOf(ch, c, cc.anchors) });
    corners.push({
      ...pc,
      landmarks: landmarkRoles(c, cc.anchors),
      ...causeWithConfidence(cc.metrics),
      fastest_lap: { lap: `lap ${fast.lap_no}`, corner_time_s: f3(cornerTime(fast, c)), ...side(cc.ref, cmp.ref) },
      slowest_lap: { lap: `lap ${slow.lap_no}`, corner_time_s: f3(cornerTime(slow, c)), ...side(cc.lap, cmp.lap) },
    });
  }
  return { ...p, notes: { ...NOTES_V2, cause: "cause compares the slowest lap with the fastest; state a high or medium cause as fact" }, corners };
}

function lapPairs() {
  const spec = arg("laps", "auto");
  if (spec !== "auto") return spec.split(",").map((p) => p.split(":").map(Number));
  const valid = laps.filter((l) => l.kind === "flying" && (l.valid_override ?? l.valid) && l.lap_time_s)
    .sort((a, b) => b.lap_time_s - a.lap_time_s);
  if (valid.length < 3) throw new Error("--laps auto needs at least 3 valid laps");
  const best = valid[valid.length - 1].lap_no;
  return [[valid[0].lap_no, best], [valid[1].lap_no, best]];
}

const pairs = lapPairs();
const cfs = [];
for (const [lap, ref] of pairs) cfs.push(await comparisonFacts(lap, ref));
const firstAnalyze = analyzePacket(cfs[0]);
const cornerId = firstAnalyze.corners[0].corner_id;
const cornerName = `corner-lap${pairs[0][0]}-${cornerId}`;
const v1 = {}, v2 = {};
pairs.forEach(([lap, ref], k) => {
  v1[`analyze-lap${lap}-vs-lap${ref}`] = analyzePacket(cfs[k]);
  v2[`analyze-lap${lap}-vs-lap${ref}`] = analyzePacketV2(cfs[k]);
});
v1["average-session"] = averagePacket();
v2["average-session"] = await averagePacketV2();
v1[cornerName] = cornerPacket(cfs[0], cornerId);
v2[cornerName] = cornerPacketV2(cfs[0], cornerId);
const sets = { [`packets${TRACK.suffix}`]: v1, [`packets-v2${TRACK.suffix}`]: v2 };
for (const [dir, packets] of Object.entries(sets)) {
  mkdirSync(join(here, dir), { recursive: true });
  for (const [name, p] of Object.entries(packets)) writeFileSync(join(here, dir, `${name}.json`), JSON.stringify(p, null, 2) + "\n");
  console.log(`${dir}: ${Object.keys(packets).join(", ")}`);
}
await server.close();

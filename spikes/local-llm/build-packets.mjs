// Builds the spike's facts packets (design §8) from the real Spa mock, using the mock API's own corner facts.
// Run from the repo root after `npm ci` in frontend/:  node spikes/local-llm/build-packets.mjs
// Writes spikes/local-llm/packets/*.json. Every number is pre-formatted as a string, so the guard can match it exactly.
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

const SPA = JSON.parse(readFileSync(join(front, "public/mock/spa-2026-11-03.json"), "utf8"));
const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => SPA });
const session = (await api.sessions())[0];
const laps = await api.sessionLaps(session.session_id);
const map = await api.trackMap(session.track_id);
const byNo = (n) => laps.find((l) => l.lap_no === n);

const f0 = (x) => (Math.round(x) || 0).toFixed(0);
const f1 = (x) => x.toFixed(1);
const f3 = (x) => x.toFixed(3);
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const lapTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
const signed = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(3)}`;

const PROFILE = {
  driver: "casual sim racer, Simagic P1000 load-cell pedals, metric units",
  focus_areas: ["minimum corner speeds", "exits onto long straights (Kemmel, the run to the Bus Stop)", "consistency"],
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
  track: "Spa-Francorchamps", car: session.car_name, session: "practice, 3 Nov 2026",
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
    const t = SPA.laps.find((x) => x.lap_no === l.lap_no).t;
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

const out = join(here, "packets");
mkdirSync(out, { recursive: true });
const c2 = await comparisonFacts(2, 4);
const c3 = await comparisonFacts(3, 4);
const a2 = analyzePacket(c2);
const packets = {
  "analyze-lap2-vs-lap4": a2,
  "analyze-lap3-vs-lap4": analyzePacket(c3),
  "average-session": averagePacket(),
  [`corner-lap2-${a2.corners[0].corner_id}`]: cornerPacket(c2, a2.corners[0].corner_id),
};
for (const [name, p] of Object.entries(packets)) writeFileSync(join(out, `${name}.json`), JSON.stringify(p, null, 2) + "\n");
console.log(Object.keys(packets).join("\n"));
await server.close();

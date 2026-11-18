// The "Simple view" mode of the Telemetry page (vroom-pnw.50 prototype, vroom-pnw.56), for a user with no telemetry
// background; the Simple/Full switch in the header chooses it. It answers "where am I slow, and what should I do?" in plain words at larger sizes,
// and links to the full view for everything else. Data comes only through the props the Telemetry page already loads.
import { useMemo, useState } from "react";
import type { CompareCandidate, CompareResponse, Corner, LapWithRef, TrackMap } from "../../api/types";
import { effectiveValid } from "../../api/types";
import { formatLapTime } from "../../lib/format";
import { lapGap } from "../../lib/compareName";
import { MAP_H, MAP_W, type PlaybackModel } from "../../lib/model";
import { biggestGains, biggestLosses, fastestValidLap, plainCorners, plainGap, plainRefName, plainSeconds } from "../../lib/plainCorner";
import { cornerSegmentPath, pointAtDistance } from "../../lib/trackmap";
import type { CoachState } from "../../state/useCoach";
import styles from "./Simple.module.css";

export interface SimpleViewProps {
  laps: LapWithRef[];
  lapId: string;
  cmp: CompareResponse;
  model: PlaybackModel;
  trackMap: TrackMap | null;
  candidates: CompareCandidate[];
  coach: CoachState;
  onSelectLap(id: string): void;
  onSelectRef(id: string | null): void;
  /** Switch to the full view with the playhead at the start of this corner. */
  onReplayCorner(corner: Corner): void;
}

export function SimpleView({ laps, lapId, cmp, model, trackMap, candidates, coach, onSelectLap, onSelectRef, onReplayCorner }: SimpleViewProps) {
  const lap = laps.find((l) => l.lap_id === lapId) ?? null;
  const refCand = candidates.find((c) => c.lap_id === cmp.ref_lap_id) ?? null;
  const best = fastestValidLap(laps);
  const ideal = candidates.find((c) => c.is_ideal) ?? null;
  const refName = plainRefName(refCand, laps);
  const refShort = refCand?.is_ideal ? "ideal lap" : refName.startsWith("your best") ? "best lap" : refName;
  const lapTime = lap?.lap_time_s ?? null;
  const gap = lapGap(lapTime, refCand?.lap_time_s ?? null, cmp.delta[cmp.delta.length - 1] ?? null);
  const self = cmp.lap_id === cmp.ref_lap_id;

  const cornerById = useMemo(() => new Map((trackMap?.corners ?? []).map((c) => [c.id, c])), [trackMap]);
  const losses = useMemo(() => biggestLosses(cmp.corners).filter((m) => cornerById.has(m.corner_id)), [cmp, cornerById]);
  const gains = useMemo(() => biggestGains(cmp.corners).filter((m) => cornerById.has(m.corner_id)), [cmp, cornerById]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && cornerById.has(picked) ? picked : losses[0]?.corner_id ?? null;
  const selected = selectedId ? cornerById.get(selectedId) ?? null : null;
  const selectedMetrics = cmp.corners.find((m) => m.corner_id === selectedId) ?? null;

  // The coach's fix per corner, once Analyze has run (Analyze is optional: the plain tips work without it).
  const coachFix = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of [coach.results.analyze, coach.results.average]) for (const f of r?.findings ?? []) if (!out.has(f.corner_id) && f.kind !== "strength") out.set(f.corner_id, f.fix);
    return out;
  }, [coach.results]);
  const analyzed = !!coach.results.analyze;

  // Timed laps, plus the lap on screen even when it is not one (an invalid or out lap opened from the full view).
  const flying = laps.filter((l) => (l.kind === "flying" && l.lap_time_s) || l.lap_id === lapId);
  const plainRef = refShort === "ideal lap" ? "the ideal lap" : refName.replace(/ \(lap \d+\)$/, "");
  const plains = plainCorners(losses.map((m) => ({ metrics: m, name: cornerById.get(m.corner_id)!.name })), plainRef);

  return (
    <div className={styles.root}>
      <section className={styles.summary} aria-label="Your lap">
        <div>
          <h1 className={styles.title}>
            Lap {lap?.lap_no ?? "?"} · {formatLapTime(lapTime)}
          </h1>
          <p className={styles.lede}>
            {self ? "You are looking at the lap you compare against, so there is no difference to show." : gap === null ? null : <>This lap was <strong className={gap !== null && gap > 0 ? styles.slower : styles.faster}>{plainGap(gap, refName)}</strong>.</>}
          </p>
        </div>
        <div className={styles.pickers}>
          <label className={styles.field}>
            <span>Lap to look at</span>
            <select value={lapId} onChange={(e) => onSelectLap(e.target.value)} className={styles.select}>
              {flying.map((l) => (
                <option key={l.lap_id} value={l.lap_id}>
                  Lap {l.lap_no} · {formatLapTime(l.lap_time_s)}{effectiveValid(l) ? "" : " (invalid)"}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.field} role="group" aria-label="Compare with">
            <span>Compare with</span>
            <div className={styles.segmented}>
              <button type="button" aria-pressed={!!best && cmp.ref_lap_id === best.lap_id} onClick={() => best && onSelectRef(best.lap_id)} disabled={!best || best.lap_id === lapId} title="Your fastest valid lap of this session">
                Your best lap
              </button>
              <button type="button" aria-pressed={!!refCand?.is_ideal} onClick={() => ideal && onSelectRef(ideal.lap_id)} disabled={!ideal} title="Your best part of every corner from this session, stitched into one lap">
                Ideal lap
              </button>
            </div>
          </div>
        </div>
      </section>

      {self ? (
        <p className={styles.empty}>Pick another lap above to see where it lost time.</p>
      ) : (
        <div className={styles.grid}>
          <section className={styles.card} aria-label="Where you lose the most time">
            <h2 className={styles.h2}>Where you lose the most time</h2>
            {losses.length === 0 && <p className={styles.muted}>No corner was slower than {refName}.</p>}
            <ol className={styles.losses}>
              {losses.map((m, i) => {
                const c = cornerById.get(m.corner_id)!;
                const p = plains[i];
                const fix = coachFix.get(m.corner_id);
                return (
                  <li key={m.corner_id}>
                    <button type="button" className={styles.lossRow} aria-pressed={selectedId === m.corner_id} onClick={() => setPicked(m.corner_id)}>
                      <span className={styles.rank} aria-hidden="true">{i + 1}</span>
                      <span className={styles.lossBody}>
                        <span className={styles.lossHead}>
                          <span className={styles.cornerName}>{c.name}</span>
                          <span className={styles.slower}>{plainSeconds(m.delta_s)} slower</span>
                        </span>
                        <span className={styles.what}>{p.what}</span>
                        {fix ? (
                          <span className={styles.tip}><b>Coach:</b> {fix}</span>
                        ) : p.tip ? (
                          <span className={styles.tip}><b>{analyzed ? "Try (worked out from your laps, not the coach):" : "Try:"}</b> {p.tip}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {gains.length > 0 && (
              <p className={styles.gains}>
                <span className={styles.faster}>Already quick:</span>{" "}
                {gains.map((m, i) => (
                  <span key={m.corner_id}>
                    {i > 0 && ", "}
                    {cornerById.get(m.corner_id)!.name} ({plainSeconds(m.delta_s)} faster)
                  </span>
                ))}
              </p>
            )}
            <div className={styles.coachRow}>
              {analyzed ? (
                <span className={styles.muted}>The coach's tips are in the list above.</span>
              ) : (
                <button type="button" className={styles.primary} disabled={coach.running !== null} onClick={() => coach.run("analyze")}>
                  {coach.running ? "The coach is looking at your lap…" : "Ask the coach for tips"}
                </button>
              )}
              {!analyzed && (
                <span className={styles.muted}>The tips above are worked out from your laps. The coach (a paid AI call) writes its own.</span>
              )}
              {coach.error && <span className={styles.error}>The coach could not answer: {coach.error.message}</span>}
            </div>
          </section>

          <section className={styles.card} aria-label="Track map">
            <h2 className={styles.h2}>On the track</h2>
            <MiniMap model={model} cmp={cmp} losses={losses.map((m) => cornerById.get(m.corner_id)!)} selectedId={selectedId} onPick={setPicked} />
          </section>

          {selected && selectedMetrics && (
            <section className={`${styles.card} ${styles.wide}`} aria-label={`${selected.name} in detail`}>
              <div className={styles.detailHead}>
                <h2 className={styles.h2}>{selected.name}: you against {refShort === "ideal lap" ? "the ideal lap" : refName}</h2>
                <button type="button" className={styles.linkBtn} onClick={() => onReplayCorner(selected)}>Replay this corner in the full view</button>
              </div>
              <CornerChart cmp={cmp} corner={selected} refLabel={refShort === "ideal lap" ? "Ideal lap" : refName.replace(/^your /, "Your ")} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function MiniMap({ model, cmp, losses, selectedId, onPick }: { model: PlaybackModel; cmp: CompareResponse; losses: Corner[]; selectedId: string | null; onPick(id: string): void }) {
  return (
    <svg viewBox={`-6 -6 ${MAP_W + 12} ${MAP_H + 12}`} className={styles.map} role="img" aria-label="Track map with the corners where you lose the most time numbered">
      <path d={model.mapPath} className={styles.mapLine} />
      {losses.map((c) => (
        <path key={c.id} d={cornerSegmentPath(model.proj, cmp.distance, c.start_m, c.end_m)} className={c.id === selectedId ? styles.mapHotSel : styles.mapHot} />
      ))}
      {losses.map((c, i) => {
        const p = pointAtDistance(model.proj, cmp.distance, c.apex_m);
        return (
          <g key={c.id} className={styles.mapPin} onClick={() => onPick(c.id)}>
            <circle cx={p.x} cy={p.y} r={8} className={c.id === selectedId ? styles.pinSel : styles.pin} />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" className={styles.pinText}>{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}

const W = 1200;
const H = 220;
const PAD_L = 44;
const PAD_B = 22;

/** Speed through the corner (you against the comparison) and the pedals under it, on a labelled distance axis. */
function CornerChart({ cmp, corner, refLabel }: { cmp: CompareResponse; corner: Corner; refLabel: string }) {
  const d0 = Math.max(0, corner.start_m - 150);
  const d1 = Math.min(cmp.distance[cmp.distance.length - 1] ?? corner.end_m, corner.end_m + 100);
  const i0 = cmp.distance.findIndex((d) => d >= d0);
  let i1 = cmp.distance.findIndex((d) => d > d1);
  if (i1 < 0) i1 = cmp.distance.length;
  const idx = Array.from({ length: Math.max(0, i1 - i0) }, (_, k) => i0 + k);
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of idx) for (const v of [cmp.lap.speed_kmh[i], cmp.ref.speed_kmh[i]]) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 300];
  lo = Math.floor(lo / 20) * 20;
  hi = Math.ceil(hi / 20) * 20 || lo + 20;
  const x = (d: number) => PAD_L + ((d - d0) / Math.max(1, d1 - d0)) * (W - PAD_L - 8);
  const ys = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - PAD_B - 8);
  const line = (arr: number[], y: (v: number) => number) => idx.map((i) => `${x(cmp.distance[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`).join(" ");
  const PH = 90;
  const yp = (v: number) => 6 + (1 - v) * (PH - 12);
  return (
    <div className={styles.chartWrap}>
      <ul className={styles.legend}>
        <li><span className={styles.swYou} /> You</li>
        <li><span className={styles.swRef} /> {refLabel}</li>
      </ul>
      <p className={styles.chartLabel}>Speed (km/h). Higher is faster; the gap at the lowest point is the speed you lose.</p>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={`Speed through ${corner.name}`}>
        <rect x={x(corner.start_m)} y={4} width={Math.max(0, x(corner.end_m) - x(corner.start_m))} height={H - PAD_B - 4} className={styles.cornerBand} />
        {[lo, (lo + hi) / 2, hi].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - 8} y1={ys(v)} y2={ys(v)} className={styles.grid1} />
            <text x={PAD_L - 6} y={ys(v) + 4} textAnchor="end" className={styles.axis}>{Math.round(v)}</text>
          </g>
        ))}
        <polyline points={line(cmp.ref.speed_kmh, ys)} className={styles.refLine} />
        <polyline points={line(cmp.lap.speed_kmh, ys)} className={styles.youLine} />
        <text x={x(corner.start_m) + 4} y={H - 6} className={styles.axis}>corner starts</text>
        <text x={x(corner.end_m) - 4} y={H - 6} textAnchor="end" className={styles.axis}>corner ends</text>
      </svg>
      <p className={styles.chartLabel}>Pedals: <span className={styles.brakeTxt}>brake</span> and <span className={styles.throttleTxt}>throttle</span>, solid = you, dashed = {refLabel.toLowerCase()}.</p>
      <svg viewBox={`0 0 ${W} ${PH}`} className={styles.chart} role="img" aria-label={`Brake and throttle through ${corner.name}`}>
        <rect x={x(corner.start_m)} y={2} width={Math.max(0, x(corner.end_m) - x(corner.start_m))} height={PH - 4} className={styles.cornerBand} />
        <polyline points={line(cmp.ref.brake, yp)} className={`${styles.brake} ${styles.dashed}`} />
        <polyline points={line(cmp.ref.throttle, yp)} className={`${styles.throttle} ${styles.dashed}`} />
        <polyline points={line(cmp.lap.brake, yp)} className={styles.brake} />
        <polyline points={line(cmp.lap.throttle, yp)} className={styles.throttle} />
      </svg>
    </div>
  );
}

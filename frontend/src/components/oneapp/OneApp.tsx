// EXPERIMENTAL prototype of the "one simpler app" overhaul (spike vroom-pnw.58, docs/ui-review/overhaul.md), behind
// `?ui=one`. Two scopes, each answering one question: the Session view ("how did the session go, which lap do I look
// at?") and the Lap view ("where did this lap lose time, and what do I try?"). It reuses the existing components and
// data hooks; nothing here is wired into the default UI.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSessionReport, useSessions } from "../../api/queries";
import { effectiveValid, type CompareCandidate, type CompareResponse, type Corner, type LapWithRef, type SessionMeta, type TrackMap } from "../../api/types";
import { lapGap } from "../../lib/compareName";
import { bestLapTime, lapGapText, lapKeyDir, stepLapId, timedLaps } from "../../lib/lapStep";
import { cornerRailRows } from "../../lib/cornerRail";
import { formatLapTime, formatShortDate } from "../../lib/format";
import { plainCorners, plainGap, plainRefName, plainSeconds, PLAIN_MIN_S } from "../../lib/plainCorner";
import { sessionSummary } from "../../lib/sessionSummary";
import { withParams } from "../../lib/urlParams";
import type { CoachState } from "../../state/useCoach";
import { SessionTab, type OpenLap } from "../session/SessionTab";
import { StintPanel } from "../StintPanel";
import styles from "./OneApp.module.css";

/** The dashed label every prototype screen carries. */
function ExperimentalTag() {
  return (
    <span className={styles.exp} title="Experimental prototype of the UI overhaul (vroom-pnw.58). Remove ui=one from the address to get the current app.">
      Experimental UI
    </span>
  );
}

/** The scope line: track and car, then session, then lap. Each level is a place you can go to. */
export function ScopeBar({ session, children }: { session: SessionMeta | null; children?: ReactNode }) {
  return (
    <nav className={styles.scope} aria-label="Where you are">
      <Link to="/sessions?ui=one" className={styles.crumb} title="Every session on this track and car">
        {session ? `${session.track_name} · ${session.car_name}` : "All sessions"}
      </Link>
      {children}
      <span className={styles.spacer} />
      <ExperimentalTag />
    </nav>
  );
}

function SessionPicker({ session, onPick }: { session: SessionMeta; onPick(id: string): void }) {
  const sessions = useSessions().data ?? [session];
  return (
    <select className={styles.select} aria-label="Session" value={session.session_id} onChange={(e) => onPick(e.target.value)}>
      {sessions.slice().sort((a, b) => b.started_at.localeCompare(a.started_at)).map((s) => (
        <option key={s.session_id} value={s.session_id}>{formatShortDate(s.started_at)} · {s.session_type}{s.track_id === session.track_id ? "" : ` · ${s.track_name}`}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Session scope

export function OneSessionView() {
  const [params, setParams] = useSearchParams();
  const sessions = useSessions().data;
  const latest = sessions?.slice().sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  const session = sessions?.find((s) => s.session_id === params.get("session")) ?? latest;
  const report = useSessionReport(session?.session_id ?? null).data;
  const summary = useMemo(() => (report ? sessionSummary(report) : null), [report]);
  if (!session) return <div className={styles.message}>Loading…</div>;
  const open = (t: OpenLap) =>
    setParams((p) => withParams(p, { scope: null, session: null, lap: t.lapId, ref: t.refLapId, at: t.distanceM === null ? null : String(Math.round(t.distanceM)) }));
  return (
    <div className={styles.root}>
      <ScopeBar session={session}>
        <span className={styles.sep}>›</span>
        <SessionPicker session={session} onPick={(id) => setParams((p) => withParams(p, { session: id }))} />
        {params.get("lap") && (
          <button type="button" className={styles.back} onClick={() => setParams((p) => withParams(p, { scope: null, session: null }))} title="Back to the lap you were looking at">
            ‹ Back to the lap
          </button>
        )}
      </ScopeBar>
      <div className={styles.page}>
        <header className={styles.headline}>
          <h1 className={styles.h1}>{session.session_type} · {formatShortDate(session.started_at)}</h1>
          {summary && <p className={styles.lede}>{summary.join(" ")}</p>}
          <p className={styles.hint}>Click a lap in the chart, or an event below, to open that lap.</p>
        </header>
        <SessionTab key={session.session_id} sessionId={session.session_id} onOpen={open} />
        <StintPanel key={`stint-${session.session_id}`} session={session} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lap scope

export interface OneLapProps {
  session: SessionMeta;
  laps: LapWithRef[];
  lap: LapWithRef;
  cmp: CompareResponse;
  trackMap: TrackMap | null;
  candidates: CompareCandidate[];
  coach: CoachState;
  onSelectLap(id: string): void;
  onSelectRef(id: string | null): void;
  /** Put the playhead at the corner and play it (the old Simple view's "Replay this corner"). */
  onReplay(corner: Corner): void;
  /** Seek to a corner without playing (a row click). */
  onSeek(corner: Corner): void;
  /** The map and strips, the transport: the page renders them so they keep their playback wiring. */
  stage: ReactNode;
  transport: ReactNode;
}

/** The lap scope's top: where you are, which lap against which, and the answer in one sentence. */
export function OneLapView(p: OneLapProps) {
  const { session, laps, lap, cmp, candidates } = p;
  const [, setParams] = useSearchParams();
  const refCand = candidates.find((c) => c.lap_id === cmp.ref_lap_id) ?? null;
  const reference = candidates.find((c) => c.is_reference) ?? null;
  const ideal = candidates.find((c) => c.is_ideal) ?? null;
  const others = candidates.filter((c) => !c.is_ideal && !c.is_reference && !laps.some((l) => l.lap_id === c.lap_id));
  const refName = plainRefName(refCand, laps);
  const gap = lapGap(lap.lap_time_s, refCand?.lap_time_s ?? null, cmp.delta[cmp.delta.length - 1] ?? null);
  const self = cmp.lap_id === cmp.ref_lap_id;
  const timed = useMemo(() => timedLaps(laps, lap.lap_id), [laps, lap.lap_id]);
  const best = useMemo(() => bestLapTime(laps), [laps]);
  const prevId = stepLapId(timed, lap.lap_id, -1);
  const nextId = stepLapId(timed, lap.lap_id, 1);
  const { onSelectLap } = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const dir = lapKeyDir(e, e.target instanceof Element ? e.target : null);
      if (!dir) return;
      const id = dir === 1 ? nextId : prevId;
      if (!id) return;
      e.preventDefault();
      onSelectLap(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onSelectLap]);

  return (
    <div className={styles.root}>
      <ScopeBar session={session}>
        <span className={styles.sep}>›</span>
        <button type="button" className={styles.crumb} onClick={() => setParams((q) => withParams(q, { scope: "session", session: session.session_id }))} title="The session report: every lap, tyres, brakes and events">
          {formatShortDate(session.started_at)} · {session.session_type}
        </button>
        <span className={styles.sep}>›</span>
        <button type="button" className={styles.step} aria-label="Previous lap" title="Previous lap (↑)" disabled={!prevId} onClick={() => prevId && onSelectLap(prevId)}>‹</button>
        <select className={styles.select} aria-label="Lap" value={lap.lap_id} onChange={(e) => onSelectLap(e.target.value)}>
          {timed.map((l) => {
            const g = lapGapText(l, best);
            return (
              <option key={l.lap_id} value={l.lap_id}>Lap {l.lap_no} · {formatLapTime(l.lap_time_s)}{effectiveValid(l) ? "" : " (invalid)"}{g ? ` · ${g}` : ""}</option>
            );
          })}
        </select>
        <button type="button" className={styles.step} aria-label="Next lap" title="Next lap (↓)" disabled={!nextId} onClick={() => nextId && onSelectLap(nextId)}>›</button>
        <span className={styles.vs}>compared with</span>
        <div className={styles.segmented} role="group" aria-label="Compare with">
          <button type="button" aria-pressed={!!reference && cmp.ref_lap_id === reference.lap_id} onClick={() => p.onSelectRef(null)} title="Your fastest lap on this track and car">Your best lap</button>
          {ideal && <button type="button" aria-pressed={cmp.ref_lap_id === ideal.lap_id} onClick={() => p.onSelectRef(ideal.lap_id)} title="Your best corners joined into one lap">Best possible lap</button>}
        </div>
        {others.length > 0 && (
          <select className={styles.select} aria-label="Compare with another lap" value="" onChange={(e) => e.target.value && p.onSelectRef(e.target.value)}>
            <option value="">Other lap…</option>
            {others.map((c) => <option key={c.lap_id} value={c.lap_id}>{c.label}{c.other_car ? " (different car)" : ""}</option>)}
          </select>
        )}
      </ScopeBar>
      <div className={styles.lapGrid}>
        <Story {...p} refName={refName} gap={gap} self={self} />
        <div className={styles.stage}>{p.stage}</div>
      </div>
      {p.transport}
    </div>
  );
}

/** The left column: the lap's answer, then every corner, losses first, with a plain tip and Replay on the big ones. */
function Story({ lap, cmp, trackMap, coach, refName, gap, self, onReplay, onSeek }: OneLapProps & { refName: string; gap: number | null; self: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => (trackMap ? cornerRailRows(cmp, trackMap.corners) : []), [cmp, trackMap]);
  const losses = rows.filter((r) => r.deltaS >= PLAIN_MIN_S).sort((a, b) => b.deltaS - a.deltaS);
  const top = losses.slice(0, 3);
  const rest = rows.filter((r) => !top.includes(r));
  const plainRef = refName.replace(/ \(lap \d+\)$/, "");
  const plains = plainCorners(top.map((r) => ({ metrics: cmp.corners.find((m) => m.corner_id === r.corner.id)!, name: r.corner.name })), plainRef);
  const coachFix = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of [coach.results.analyze, coach.results.average]) for (const f of r?.findings ?? []) if (!out.has(f.corner_id) && f.kind !== "strength") out.set(f.corner_id, f.fix);
    return out;
  }, [coach.results]);
  const analyzed = !!coach.results.analyze;
  const max = Math.max(0.001, ...rows.map((r) => Math.abs(r.deltaS)));
  const sumLoss = losses.reduce((s, r) => s + r.deltaS, 0);

  return (
    <aside className={styles.story} aria-label="Where the time goes">
      <header className={styles.headline}>
        <h1 className={styles.h1}>Lap {lap.lap_no} · {formatLapTime(lap.lap_time_s)}</h1>
        <p className={styles.lede}>
          {self ? "This is the lap you compare with, so there is no gap to show. Compare with the best possible lap instead." : gap === null ? null : (
            <>This lap was <strong className={gap > 0 ? styles.slower : styles.faster}>{plainGap(gap, refName)}</strong>.
              {top.length > 0 && <> {top.length === 1 ? "The biggest loss is" : `The ${top.length} biggest losses are`} {top.map((r) => r.corner.name).join(", ").replace(/, ([^,]*)$/, " and $1")}.</>}
            </>
          )}
        </p>
      </header>
      {!self && (
        <>
          <ol className={styles.losses}>
            {top.map((r, i) => {
              const fix = coachFix.get(r.corner.id);
              const pc = plains[i];
              return (
                <li key={r.corner.id} className={styles.loss}>
                  <div className={styles.lossHead}>
                    <span className={styles.rank} aria-hidden="true">{i + 1}</span>
                    <button type="button" className={styles.cornerBtn} onClick={() => onSeek(r.corner)} title="Show this corner on the map and strips">{r.corner.name}</button>
                    <span className={styles.slower}>{plainSeconds(r.deltaS)} slower</span>
                  </div>
                  <p className={styles.what}>{pc.what}</p>
                  {fix ? <p className={styles.tip}><b>Coach:</b> {fix}</p> : pc.tip && <p className={styles.tip}><b>Try:</b> {pc.tip}</p>}
                  <button type="button" className={styles.replay} onClick={() => onReplay(r.corner)}>▶ Replay this corner</button>
                </li>
              );
            })}
          </ol>
          <div className={styles.coachRow}>
            {analyzed ? (
              <span className={styles.muted}>Tips marked “Coach” come from the AI coach; the others are worked out from your laps.</span>
            ) : (
              <>
                <button type="button" className={styles.primary} disabled={coach.running !== null} onClick={() => void coach.run("analyze")}>
                  {coach.running ? "The coach is looking at your lap…" : "Ask the coach"}
                </button>
                <span className={styles.muted}>The tips above are worked out from your laps. The coach (a paid AI call) writes its own.</span>
              </>
            )}
          </div>
          <button type="button" className={styles.disclosure} aria-expanded={showAll} onClick={() => setShowAll((x) => !x)}>
            {showAll ? "▾" : "▸"} The other {rest.length} corners · {plainSeconds(sumLoss)} lost across all losing corners
          </button>
          {showAll && (
            <ul className={styles.all}>
              {rest.map((r) => (
                <li key={r.corner.id}>
                  <button type="button" className={styles.allRow} onClick={() => onSeek(r.corner)}>
                    <span className={styles.allName}>{r.corner.name}</span>
                    <span className={styles.bar}><span className={r.deltaS > 0 ? styles.barLoss : styles.barGain} style={{ width: `${(Math.abs(r.deltaS) / max) * 100}%` }} /></span>
                    <span className={r.deltaS >= PLAIN_MIN_S ? styles.slower : r.deltaS <= -PLAIN_MIN_S ? styles.faster : styles.muted}>
                      {Math.abs(r.deltaS) < PLAIN_MIN_S ? "same" : `${r.deltaS > 0 ? "+" : "−"}${Math.abs(r.deltaS).toFixed(2)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

// The one app (spike vroom-pnw.58, docs/ui-review/overhaul.md, made the default by vroom-pnw.64). Two scopes, each
// answering one question: the Session view ("how did the session go, which lap do I look at?") and the Lap view
// ("where did this lap lose time, and what do I try?").
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useSessionReport, useSessions } from "../../api/queries";
import { effectiveValid, type CompareCandidate, type CompareResponse, type Corner, type LapWithRef, type SessionMeta, type TrackMap } from "../../api/types";
import { lapGap } from "../../lib/compareName";
import { bestLapTime, cycleRefId, lapGapText, lapKeyDir, refChoices, refKeyDir, stepLapId, timedLaps } from "../../lib/lapStep";
import { lapStory } from "../../lib/lapStory";
import { invalidNotice } from "../../lib/invalidLap";
import { plainCoachError } from "../../lib/coachError";
import * as Popover from "@radix-ui/react-popover";
import { LegendRows } from "./Legend";
import { formatLapTime, formatShortDate } from "../../lib/format";
import { plainGap, plainRefName, plainSeconds, PLAIN_MIN_S } from "../../lib/plainCorner";
import { noPlayback } from "../../lib/sessionTab";
import { sessionSummary } from "../../lib/sessionSummary";
import { withParams } from "../../lib/urlParams";
import type { CoachState } from "../../state/useCoach";
import { SessionTab, type OpenLap } from "../session/SessionTab";
import { SetupChip } from "../SetupChip";
import { LapGaugeTable } from "../LapGaugeTable";
import { StintPanel } from "../StintPanel";
import { cx } from "../../lib/cx";
import styles from "./OneApp.module.css";

/** The scope line: track and car, then session, then lap. Each level is a place you can go to. */
export function ScopeBar({ session, children }: { session: SessionMeta | null; children?: ReactNode }) {
  return (
    <nav className={styles.scope} aria-label="Where you are">
      <Link to={session ? `/sessions?session=${encodeURIComponent(session.session_id)}` : "/sessions"} className={styles.crumb} title="Progress and the labelled map for this track and car">
        {session ? `${session.track_name} · ${session.car_name}` : "All sessions"}
      </Link>
      {children}
      <span className={styles.spacer} />
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
  const { search } = useLocation();
  const sessions = useSessions().data;
  const latest = sessions?.slice().sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  const session = sessions?.find((s) => s.session_id === params.get("session")) ?? latest;
  const report = useSessionReport(session?.session_id ?? null).data;
  const summary = useMemo(() => (report ? sessionSummary(report) : null), [report]);
  if (!session) return <div className={styles.message}>Loading…</div>;
  // The lap table's "Open": the Lap view of that lap, not this view again.
  const openLink = (lapId: string, atM?: number) => ({ pathname: "/", search: `?${withParams(new URLSearchParams(search), { scope: null, session: null, lap: lapId, ref: null, at: atM === undefined ? null : String(Math.round(atM)) }).toString()}` });
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
          <p className={styles.hint}>{summary && report && !noPlayback(report) ? "Click a lap in the chart, an event, or a row in the lap table to open that lap." : null}</p>
        </header>
        <SessionTab key={session.session_id} sessionId={session.session_id} onOpen={open}>
          <section className={styles.block} aria-label="Laps">
            <h2 className={styles.h2}>Every lap</h2>
            <LapGaugeTable key={`laps-${session.session_id}`} sessionId={session.session_id} linkFor={openLink} />
          </section>
          <StintPanel key={`stint-${session.session_id}`} session={session} />
        </SessionTab>
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
  /** Seek to a spot on the lap (metres), paused: the invalid-lap sentence. */
  onSeekDistance?(m: number): void;
  /** The map and strips, the transport: the page renders them so they keep their playback wiring. */
  /** The next comparison is loading: the page keeps showing the previous one, dimmed, instead of unmounting. */
  loading?: boolean;
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
  const refLaps = useMemo(() => refChoices(laps, lap.lap_id), [laps, lap.lap_id]);
  const refName = plainRefName(refCand, laps);
  const gap = lapGap(lap.lap_time_s, refCand?.lap_time_s ?? null, cmp.delta[cmp.delta.length - 1] ?? null);
  const self = cmp.lap_id === cmp.ref_lap_id;
  const timed = useMemo(() => timedLaps(laps, lap.lap_id), [laps, lap.lap_id]);
  const best = useMemo(() => bestLapTime(laps), [laps]);
  const prevId = stepLapId(timed, lap.lap_id, -1);
  const nextId = stepLapId(timed, lap.lap_id, 1);
  const { onSelectLap, onSelectRef } = p;
  const refId = cmp.ref_lap_id;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const dir = refKeyDir(e, e.target instanceof Element ? e.target : null);
      if (!dir) return;
      const id = cycleRefId(refLaps, refId, dir);
      if (!id) return;
      e.preventDefault();
      onSelectRef(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refLaps, refId, onSelectRef]);
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
    <div className={styles.root} aria-busy={p.loading || undefined}>
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
        <select className={styles.select} aria-label="Reference lap" title="Compare with another lap of this session (R, Shift+R)" value={[...refLaps, ...others].some((l) => l.lap_id === cmp.ref_lap_id) ? cmp.ref_lap_id : ""} onChange={(e) => e.target.value && p.onSelectRef(e.target.value)}>
          <option value="">Other lap…</option>
          {refLaps.map((l) => (
            <option key={l.lap_id} value={l.lap_id}>Lap {l.lap_no} · {formatLapTime(l.lap_time_s)}{effectiveValid(l) ? "" : " (invalid)"}</option>
          ))}
          {others.map((c) => <option key={c.lap_id} value={c.lap_id}>{c.label}{c.other_car ? " (different car)" : ""}</option>)}
        </select>
        {cmp.warning
          ? <span className={styles.badge} title={cmp.warning}>DIFFERENT CAR</span>
          : <SetupChip lapSessionId={session.session_id} laps={laps} refLapId={cmp.ref_lap_id} refName={refName} />}
      </ScopeBar>
      <div className={cx(styles.lapGrid, p.loading && styles.loading)}>
        <Story {...p} refName={refName} gap={gap} self={self} />
        <div className={styles.stage}>{p.stage}</div>
      </div>
      {p.transport}
    </div>
  );
}

/** The "⋯" menu: the Key, notes on or off, Ask again, Average and what the coach has cost. */
function StoryMenu({ coach, loading }: { coach: CoachState; loading?: boolean }) {
  const [showKey, setShowKey] = useState(false);
  const { results, running, showNotes, setShowNotes, run } = coach;
  const costs = [results.analyze, results.average].filter((r) => r?.cost_usd != null);
  const cost = costs.reduce((sum, r) => sum + (r?.cost_usd ?? 0), 0);
  const busy = running !== null || !!loading;
  return (
    <Popover.Root onOpenChange={(o) => !o && setShowKey(false)}>
      <Popover.Trigger className={styles.more} aria-label="More: key, notes, coach" title="Key, notes and the coach">⋯</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} className={styles.menu} aria-label="More">
          <button type="button" className={styles.menuItem} aria-expanded={showKey} onClick={() => setShowKey((x) => !x)}>Key {showKey ? "▾" : "▸"}</button>
          {showKey && <div className={styles.menuKey}><LegendRows /></div>}
          <button type="button" className={styles.menuItem} aria-pressed={showNotes} onClick={() => setShowNotes(!showNotes)}>{showNotes ? "Hide notes" : "Show notes"}</button>
          {results.analyze && <button type="button" className={styles.menuItem} disabled={busy} onClick={() => void run("analyze")}>Ask again</button>}
          <button type="button" className={styles.menuItem} disabled={busy} onClick={() => void run("average")}>Average: check consistency across laps</button>
          {costs.length > 0 && <div className={styles.menuNote} title="What the language model charged for the analyses of this lap. Telemetry itself is free.">Coach cost ${cost.toFixed(3)}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Seconds since mount, for the coach's busy line. */
function Elapsed() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{secs}s</>;
}

/**
 * The left column: the lap and gap sentence stay pinned at the top, and only the cards below scroll. Then the three
 * biggest losses (what happened, the coach's fix or a computed tip, Replay), Ask the coach, and every corner.
 */
function Story({ lap, cmp, trackMap, coach, loading, refName, gap, self, onReplay, onSeek, onSeekDistance }: OneLapProps & { refName: string; gap: number | null; self: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const plainRef = refName.replace(/ \(lap \d+\)$/, "");
  const story = useMemo(() => (trackMap ? lapStory(cmp, trackMap.corners, coach.results, plainRef) : null), [cmp, trackMap, coach.results, plainRef]);
  const cards = story?.cards ?? [];
  const invalid = useMemo(() => invalidNotice(effectiveValid(lap), cmp.lap, cmp.distance, trackMap), [lap, cmp, trackMap]);
  const rows = story?.rows ?? [];
  const analyzed = !!coach.results.analyze;
  const max = Math.max(0.001, ...rows.map((r) => Math.abs(r.deltaS)));
  const { error, failedCommand, running } = coach;

  return (
    <aside className={styles.story} aria-label="Where the time goes">
      <header className={styles.storyHead}>
        <div className={styles.storyTitle}>
          <h1 className={styles.h1}>Lap {lap.lap_no} · {formatLapTime(lap.lap_time_s)}</h1>
          <StoryMenu coach={coach} loading={loading} />
        </div>
        <p className={styles.lede}>
          {self ? "This is the lap you compare with, so there is no gap to show. Compare with the best possible lap instead." : gap === null ? null : (
            <>This lap was <strong className={gap > 0 ? styles.slower : styles.faster}>{plainGap(gap, refName)}</strong>.
              {cards.length > 0 && <> {cards.length === 1 ? "The biggest loss is" : `The ${cards.length} biggest losses are`} {cards.map((c) => c.row.corner.name).join(", ").replace(/, ([^,]*)$/, " and $1")}.</>}
            </>
          )}
        </p>
        {invalid && (
          <p className={styles.invalidNote} data-testid="invalid-notice">
            {invalid.atM === null ? invalid.text : (
              <button type="button" className={styles.invalidBtn} onClick={() => onSeekDistance?.(invalid.atM!)} title="Go to this spot in the replay">{invalid.text}</button>
            )}
          </p>
        )}
      </header>
      {!self && (
        <div className={styles.storyBody}>
          <ol className={styles.losses}>
            {cards.map((c) => (
              <li key={c.row.corner.id} className={styles.loss}>
                <div className={styles.lossHead}>
                  <span className={styles.rank} aria-hidden="true">{c.rank}</span>
                  <button type="button" className={styles.cornerBtn} onClick={() => onSeek(c.row.corner)} title="Show this corner on the map and strips">{c.row.corner.name}</button>
                  <span className={styles.slower}>{plainSeconds(c.row.deltaS)} slower</span>
                </div>
                <p className={styles.what}>{c.what}</p>
                {c.advice && <p className={styles.tip}><b>{c.advice.by === "coach" ? "Coach:" : "Try:"}</b> {c.advice.text}</p>}
                <button type="button" className={styles.replay} onClick={() => onReplay(c.row.corner)}>▶ Replay this corner</button>
              </li>
            ))}
          </ol>
          <div className={styles.coachRow}>
            {running ? (
              <span className={styles.busy} role="status">
                <span className={styles.spinner} aria-hidden="true" />
                {running === "average" ? "Averaging" : "The coach is looking at your lap"}… <Elapsed />
                <button type="button" className={styles.replay} onClick={coach.cancel}>Cancel</button>
              </span>
            ) : analyzed ? (
              <span className={styles.muted}>Tips marked “Coach” come from the AI coach; the others are worked out from your laps.</span>
            ) : (
              <>
                <button type="button" className={styles.primary} disabled={loading} onClick={() => void coach.run("analyze")}>Ask the coach</button>
                <span className={styles.muted}>The tips above are worked out from your laps. The coach (a paid AI call) writes its own.</span>
              </>
            )}
            {error && (
              <span role="alert" className={styles.error} title={`${error.code}: ${error.message}`}>
                {plainCoachError(error.code)}
                {failedCommand && failedCommand !== "corner" && <button type="button" className={styles.replay} onClick={() => void coach.run(failedCommand)}>Retry</button>}
              </span>
            )}
          </div>
          <button type="button" className={styles.disclosure} aria-expanded={showAll} onClick={() => setShowAll((x) => !x)}>
            {showAll ? "▾" : "▸"} Every corner · {rows.length}
          </button>
          {showAll && (
            <ul className={styles.all} aria-label="Every corner">
              {rows.map((r) => (
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
        </div>
      )}
    </aside>
  );
}

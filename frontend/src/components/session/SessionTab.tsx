// The Session tab of the Telemetry page (vroom-bi4.12): the session report (GET /sessions/{id}/report) as charts and an event list.
// Clicking a lap or an event opens that lap in playback against the session's best lap; the page does the navigation (`onOpen`).
import { useMemo, useState, type ReactNode } from "react";
import { useSessionReport } from "../../api/queries";
import { REPORT_CATEGORIES, type ReportCategory, type ReportEvent, type ReportLap, type ReportSeverity, type SessionReport } from "../../api/types";
import { cx } from "../../lib/cx";
import { categoryCounts, CHARTS, eventLap, groupEvents, noPlayback, sessionBestLap, type EventGroup } from "../../lib/sessionTab";
import { errorInfo } from "../../api/types";
import ui from "../ui.module.css";
import { suggestEnabled } from "../../lib/setupSuggestions";
import { LapTimeChart, MetricChart } from "./SessionCharts";
import { SuggestionsPanel } from "./SuggestionsPanel";
import styles from "./Session.module.css";

const SEVERITY_TEXT: Record<ReportSeverity, string> = { info: "for your information", watch: "keep an eye on it", problem: "needs fixing" };

/** What the page needs to open a lap: the reference is the session's best lap (null when the lap is that lap), `distanceM` moves the playhead. */
export interface OpenLap { lapId: string; refLapId: string | null; distanceM: number | null }

/** The Session view shows the first few events and folds the rest. */
export const EVENTS_SHOWN = 5;

export interface SessionTabProps {
  sessionId: string;
  onOpen(target: OpenLap): void;
  /** Rendered after the report: lap chart, events (folded past 5), tyre and brake charts, then `children`. */
  children?: ReactNode;
}

export function SessionTab({ sessionId, onOpen, children }: SessionTabProps) {
  const q = useSessionReport(sessionId);
  if (q.isPending) return <div className={styles.state} role="status">Loading the session report…</div>;
  if (q.error) {
    return (
      <div className={cx(styles.state, styles.stateError)} role="alert">
        <span>Could not load the session report: {errorInfo(q.error).message}</span>
        <button type="button" className={ui.btn} onClick={() => void q.refetch()}>Try again</button>
      </div>
    );
  }
  return <ReportBody key={sessionId} report={q.data} onOpen={onOpen}>{children}</ReportBody>;
}

function ReportBody({ report, onOpen, children }: { report: SessionReport; onOpen(target: OpenLap): void; children?: ReactNode }) {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [categories, setCategories] = useState<ReadonlySet<ReportCategory>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const best = useMemo(() => sessionBestLap(report.laps), [report.laps]);
  const counts = useMemo(() => categoryCounts(report.events), [report.events]);
  const allGroups = useMemo(() => groupEvents(report.events, categories), [report.events, categories]);
  const eventTotal = allGroups.reduce((n, g) => n + g.events.length, 0);
  const folded = !showAllEvents && eventTotal > EVENTS_SHOWN;
  const groups = useMemo(() => (folded ? foldGroups(allGroups, EVENTS_SHOWN) : allGroups), [allGroups, folded]);
  const playbackOff = noPlayback(report);
  const suggestOn = useMemo(() => suggestEnabled(globalThis.location?.search ?? ""), []);

  const open = (lap: ReportLap | null, distanceM: number | null) => {
    if (!lap) return;
    if (!lap.has_trace) {
      setNotice(`Lap ${lap.lap_no} has no trace, so playback is not available for it.`);
      return;
    }
    setNotice(null);
    onOpen({ lapId: lap.lap_id, refLapId: best && best.lap_id !== lap.lap_id ? best.lap_id : null, distanceM });
  };
  const openEvent = (e: ReportEvent) => open(eventLap(e, report.laps), e.distance_m);
  const toggle = (c: ReportCategory) => { const n = new Set(categories); if (!n.delete(c)) n.add(c); setCategories(n); }

  if (report.laps.length === 0) return <div className={styles.state}>This session has no laps to report on.</div>;

  const chartsBlock = (
    <div className={styles.miniCharts}>
      {CHARTS.map((c) => <MetricChart key={c.metric} metric={c.metric} laps={report.laps} windows={report.windows} events={report.events} onOpenLap={(l) => open(l, null)} />)}
    </div>
  );
  const eventsBlock = (
    <section className={styles.events} aria-label="Events">
      <div className={styles.filters} role="group" aria-label="Filter events by category">
        {REPORT_CATEGORIES.map((c) => (
          <button key={c} type="button" className={ui.btn} aria-pressed={categories.has(c)} onClick={() => toggle(c)}>
            {c}<span className={styles.count}>{counts[c]}</span>
          </button>
        ))}
      </div>
      {report.events.length === 0 ? (
        <div className={styles.state}>No events found in this session.</div>
      ) : groups.length === 0 ? (
        <div className={styles.state}>No events in the chosen categories.</div>
      ) : groups.map((g) => (
        <div key={g.key} className={styles.group} role="group" aria-label={g.label}>
          <div className={styles.groupLabel}>{g.label.toUpperCase()}</div>
          <ul className={styles.list}>
            {g.events.map((e) => (
              <li key={e.id}>
                <button type="button" className={styles.event} data-severity={e.severity} onClick={() => openEvent(e)}>
                  <span className={styles.badges}><span className={styles.badge}>{e.category}</span><span className={styles.badge}>{SEVERITY_TEXT[e.severity]}</span></span>
                  <span className={styles.sentence}>{e.sentence}</span>
                  {(e.corner || e.distance_m !== null) && (
                    <span className={styles.where}>{e.corner ? e.corner.name : ""}{e.corner && e.distance_m !== null ? " · " : ""}{e.distance_m !== null ? `${Math.round(e.distance_m)} m` : ""}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {eventTotal > EVENTS_SHOWN && (
        <button type="button" className={cx(ui.btn, styles.more)} aria-expanded={showAllEvents} onClick={() => setShowAllEvents((x) => !x)}>
          {showAllEvents ? `Show the first ${EVENTS_SHOWN} only` : `Show all ${eventTotal} events`}
        </button>
      )}
    </section>
  );

  return (
    <div className={styles.root}>
      {playbackOff && <p className={styles.note} role="status">Playback is not available for this session: it was recorded without lap traces, so laps and events can be read here but not replayed.</p>}
      {report.unavailable.length > 0 && (
        <p className={styles.note} role="status">Not judged for this session: {report.unavailable.map((u) => `${u.category} (${u.reason.replace(/\.$/, "")})`).join("; ")}.</p>
      )}
      {notice && <p className={cx(styles.note, styles.noteWarn)} role="status">{notice}</p>}
      <LapTimeChart laps={report.laps} events={report.events} onOpenLap={(l) => open(l, null)} />
      {eventsBlock}
      {suggestOn && <SuggestionsPanel report={report} />}
      {chartsBlock}
      {children}
    </div>
  );
}

/** The first `n` events across the groups, keeping the groups' order. */
function foldGroups(groups: EventGroup[], n: number): EventGroup[] {
  const out: EventGroup[] = [];
  let left = n;
  for (const g of groups) {
    if (left <= 0) break;
    out.push({ ...g, events: g.events.slice(0, left) });
    left -= g.events.length;
  }
  return out;
}

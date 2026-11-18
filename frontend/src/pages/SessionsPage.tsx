import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { lapLink } from "../lib/urlParams";
import { sessionLapsOptions, sessionSummaryOptions, useSessions } from "../api/queries";
import type { SessionMeta, SessionSummary } from "../api/types";
import { formatDelta, formatLapTime, formatShortDate } from "../lib/format";
import { bestValidLap } from "../lib/laps";
import { comboKey, focusOutcome, groupCombos, trendPaths, type FocusTone } from "../lib/sessions";
import { cx } from "../lib/cx";
import { LapGaugeTable } from "../components/LapGaugeTable";
import { StintPanel } from "../components/StintPanel";
import ui from "../components/ui.module.css";
import styles from "./SessionsPage.module.css";

interface Row {
  session: SessionMeta;
  summary: SessionSummary;
  /** Best valid flying lap of the session (else any lap with a trace), for the "Open" link. */
  bestLapId: string | null;
  /** False for a session recorded as stats only (no lap has a trace): its lap table has nothing to show, its stint does. */
  hasTraces: boolean;
}

const TONE: Record<FocusTone, string> = { good: styles["tone-good"], bad: styles["tone-bad"], unclear: styles["tone-unclear"] };

// Module-level so useQueries only re-runs it when the query results change.
function combine<T>(rs: { data: T | undefined; error: Error | null }[]) {
  return {
    data: rs.every((r) => r.data !== undefined) ? rs.map((r) => r.data as T) : null,
    error: rs.find((r) => r.error)?.error ?? null,
  };
}

export function SessionsPage() {
  const { search } = useLocation();
  const sessionsQ = useSessions();
  const sessions = sessionsQ.data ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [pickedSession, setPickedSession] = useState<string | null>(null);

  const combos = useMemo(() => groupCombos(sessions ?? []), [sessions]);
  const comboKeyNow = selected && combos.some((c) => c.key === selected) ? selected : (combos[0]?.key ?? null);

  // Summaries and best laps for the selected combo's sessions (oldest first).
  const mine = useMemo(
    () => (sessions ?? []).filter((s) => comboKey(s) === comboKeyNow).sort((a, b) => a.started_at.localeCompare(b.started_at)),
    [sessions, comboKeyNow],
  );
  const summaries = useQueries({ queries: mine.map((s) => sessionSummaryOptions(s.session_id)), combine });
  const lapsOf = useQueries({ queries: mine.map((s) => sessionLapsOptions(s.session_id)), combine });
  const rows: Row[] | null =
    sessions && comboKeyNow && summaries.data && lapsOf.data
      ? mine.map((session, i) => ({ session, summary: summaries.data![i], bestLapId: (bestValidLap(lapsOf.data![i]) ?? lapsOf.data![i].find((l) => l.has_trace))?.lap_id ?? null,
          hasTraces: lapsOf.data![i].some((l) => l.has_trace),
        }))
      : null;
  const error = (sessionsQ.error ?? summaries.error ?? lapsOf.error)?.message ?? null;

  if (error) return <div className={styles.statusError}>{error}</div>;
  if (!sessions) return <div className={styles.status}>Loading…</div>;
  if (combos.length === 0) return <div className={styles.status}>No sessions yet. Import a recording first.</div>;

  // The selected session: the picked one if it is in this combo, else the newest that has traces, else the newest.
  const shownRow = (rows ?? []).find((r) => r.session.session_id === pickedSession) ?? [...(rows ?? [])].reverse().find((r) => r.hasTraces) ?? rows?.[rows.length - 1];
  const shownId = shownRow?.session.session_id ?? null;
  const combo = combos.find((c) => c.key === comboKeyNow)!;
  const bests = (rows ?? []).map((r) => r.summary.best_lap_s).filter((v): v is number => v !== null);
  const pb = bests.length ? Math.min(...bests) : null;
  const trend = trendPaths((rows ?? []).map((r) => ({ best: r.summary.best_lap_s, theo: r.summary.theoretical_best_s })), 1000, 200);
  const last = rows?.[rows.length - 1];
  const gained = bests.length >= 2 ? bests[bests.length - 1] - bests[0] : null;
  const gapTheo = last?.summary.best_lap_s != null && last.summary.theoretical_best_s != null ? last.summary.best_lap_s - last.summary.theoretical_best_s : null;
  const totalValid = (rows ?? []).reduce((n, r) => n + r.summary.n_valid, 0);

  const withBest = (rows ?? []).filter((r) => r.summary.best_lap_s !== null);
  const first = withBest[0];
  const lastBest = withBest[withBest.length - 1];
  const dateOf = (r?: Row) => (r ? formatShortDate(r.session.started_at) : "");
  const cards: { k: string; v: string; from: string; tone?: string }[] = [
    { k: "SESSIONS", v: String(combo.count), from: "this track and car" },
    { k: "VALID LAPS", v: String(totalValid), from: `all ${combo.count} sessions` },
    { k: "CHANGE SINCE FIRST", v: gained === null ? "—" : `${formatDelta(gained)} s`, from: gained === null ? "needs 2 sessions" : `best of ${dateOf(first)} → ${dateOf(lastBest)}`, tone: gained === null ? undefined : gained < 0 ? styles.gain : styles.loss },
    { k: "GAP TO THEORETICAL", v: gapTheo === null ? "—" : `${gapTheo.toFixed(2)} s`, from: last ? `latest session, ${dateOf(last)}` : "" },
  ];

  return (
    <div className={styles.page}>
      <div role="group" aria-label="Track and car" className={styles.chips}>
        {combos.map((c) => (
          <button key={c.key} type="button" aria-pressed={c.key === comboKeyNow} onClick={() => setSelected(c.key)} className={ui.chip}>
            {c.label} <span className={styles.count}>{c.count}</span>
          </button>
        ))}
      </div>

      <div className={styles.row}>
        <section aria-label="Best lap trend" className={cx(ui.panel, styles.trend)}>
          <div className={styles.trendHead}>
            <div className={ui.heading}>BEST LAP PER SESSION · {combo.label}</div>
            <div className={styles.pb}>PB <span className={styles.pbValue}>{formatLapTime(pb)}</span></div>
          </div>
          <div className={styles.plot}>
            <svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="Best and theoretical lap per session, oldest to newest">
              <path d="M0 50 L1000 50 M0 100 L1000 100 M0 150 L1000 150" className={styles.grid} />
              <path d={trend.theo} className={styles.theo} />
              <path d={trend.best} className={styles.best} />
            </svg>
            {trend.best && (
              <>
                <div className={cx(styles.axis, styles.axisTop)}>{formatLapTime(trend.lo)}</div>
                <div className={cx(styles.axis, styles.axisBottom)}>{formatLapTime(trend.hi)}</div>
              </>
            )}
          </div>
          <div className={styles.legend}>
            <span><span className={styles.legendBest}>━</span> best lap</span>
            <span>┄ theoretical best</span>
          </div>
        </section>
        <section aria-label="Summary" className={styles.cards}>
          {cards.map((c) => (
            <div key={c.k} className={ui.panel}>
              <div className={styles.cardKey}>{c.k}</div>
              <div className={cx(styles.cardValue, c.tone)}>{c.v}</div>
              <div className={styles.cardFrom}>{c.from}</div>
            </div>
          ))}
        </section>
      </div>

      <section aria-label="Session list" className={cx(ui.panel, styles.list)}>
        {!rows ? (
          <div className={ui.muted}>Loading…</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Type</th>
                <th scope="col" className={styles.num}>Laps (valid)</th>
                <th scope="col" className={styles.num}>Best</th>
                <th scope="col" className={styles.num}>Δ to PB</th>
                <th scope="col" className={styles.num}>Theoretical</th>
                <th scope="col" className={styles.num}>Track</th>
                <th scope="col">Focus</th>
                <th scope="col"><span className={styles.srOnly}>Open</span></th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map(({ session, summary, bestLapId, hasTraces }) => {
                const isSel = session.session_id === shownId;
                const best = summary.best_lap_s;
                const out = summary.focus ? focusOutcome(summary.focus.improved) : null;
                return (
                  <tr key={session.session_id} className={isSel ? styles.selected : undefined} onClick={() => setPickedSession(session.session_id)}>
                    <td className={styles.date}>
                      <button type="button" aria-pressed={isSel} className={styles.rowButton} onClick={(e) => { e.stopPropagation(); setPickedSession(session.session_id); }}>
                        {formatShortDate(session.started_at)}
                      </button>
                    </td>
                    <td>{session.session_type}{!hasTraces && <span className={styles.statsOnly} title="Recorded without lap traces: only the stint stats are available"> stats only</span>}</td>
                    <td className={styles.num}>{summary.n_laps} ({summary.n_valid})</td>
                    <td className={cx(styles.num, best !== null && best === pb && styles.pbCell)}>{formatLapTime(best)}</td>
                    <td className={cx(styles.num, styles.dim)}>{best === null || pb === null ? "—" : best === pb ? "PB" : `+${(best - pb).toFixed(3)}`}</td>
                    <td className={cx(styles.num, styles.dim)}>{summary.theoretical_best_s === null ? "—" : formatLapTime(summary.theoretical_best_s)}</td>
                    <td className={cx(styles.num, styles.dim)}>{summary.track_temp_c === null ? "—" : `${Math.round(summary.track_temp_c)}°C`}</td>
                    <td className={out ? TONE[out.tone] : styles.dim} title={out && summary.focus ? `${out.label}: ${summary.focus.instruction}` : undefined}>
                      {out && summary.focus ? `${out.glyph} ${summary.focus.instruction}` : "—"}
                    </td>
                    <td className={styles.open}>
                      {bestLapId ? (
                        <Link to={lapLink(search, bestLapId)} className={styles.openLink} onClick={(e) => e.stopPropagation()}>Open →</Link>
                      ) : (
                        <span className={styles.dim} title="No lap with a trace to open">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {shownRow && (
        <>
          <div className={ui.heading}>
            SELECTED SESSION · {formatShortDate(shownRow.session.started_at)} · {shownRow.session.session_type}
          </div>
          {/* Every lap is listed; laps without a trace are tagged "stats only" and do not link. */}
          <LapGaugeTable key={shownRow.session.session_id} sessionId={shownRow.session.session_id} />
          {/* Per-lap stint stats of the selected session (the panel renders nothing without). */}
          <StintPanel key={shownRow.session.session_id} session={shownRow.session} />
        </>
      )}
    </div>
  );
}

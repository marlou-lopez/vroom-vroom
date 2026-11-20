import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { lapLink, sessionLink } from "../lib/urlParams";
import { sessionLapsOptions, sessionSummaryOptions, useSessions } from "../api/queries";
import type { SessionMeta, SessionSummary } from "../api/types";
import { formatDelta, formatLapTime, formatShortDate } from "../lib/format";
import { bestValidLap } from "../lib/laps";
import { comboKey, focusOutcome, groupCombos, headline, trendPaths, type FocusTone } from "../lib/sessions";
import { cx } from "../lib/cx";
import { TrackMapSection } from "../components/TrackMapSection";
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
  // The first crumb of a session links here with `?session=<id>`: open that session's track and car.
  const [params] = useSearchParams();
  const fromSession = (sessions ?? []).find((s) => s.session_id === params.get("session"));

  const combos = useMemo(() => groupCombos(sessions ?? []), [sessions]);
  const wanted = selected ?? (fromSession ? comboKey(fromSession) : null);
  const comboKeyNow = wanted && combos.some((c) => c.key === wanted) ? wanted : (combos[0]?.key ?? null);

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

  const combo = combos.find((c) => c.key === comboKeyNow)!;
  const bests = (rows ?? []).map((r) => r.summary.best_lap_s).filter((v): v is number => v !== null);
  const pb = bests.length ? Math.min(...bests) : null;
  const trend = trendPaths((rows ?? []).map((r) => ({ best: r.summary.best_lap_s, theo: r.summary.theoretical_best_s })), 1000, 200);

  const dateOf = (r?: { startedAt: string } | null) => (r ? formatShortDate(r.startedAt) : "");
  const h = headline((rows ?? []).map((r) => ({ type: r.session.session_type, startedAt: r.session.started_at, best: r.summary.best_lap_s, theo: r.summary.theoretical_best_s })));
  // Ticks under the chart: one per session, thinned to at most 8 so the dates don't collide.
  const nRows = rows?.length ?? 0;
  const tickStep = Math.max(1, Math.ceil(nRows / 8));
  const ticks = (rows ?? []).map((r, i) => ({ i, label: formatShortDate(r.session.started_at), x: nRows === 1 ? 50 : (i / (nRows - 1)) * 100 })).filter((t) => t.i % tickStep === 0 && (t.i === nRows - 1 || nRows - 1 - t.i >= tickStep)).concat(nRows > 1 && (nRows - 1) % tickStep !== 0 ? [{ i: nRows - 1, label: formatShortDate(rows![nRows - 1].session.started_at), x: 100 }] : []);
  const totalValid = (rows ?? []).reduce((n, r) => n + r.summary.n_valid, 0);
  // Cards compare like with like: the change is between sessions of one type, and each value names the session it comes from.
  const cards: { k: string; v: string; from: string; tone?: string }[] = [
    { k: "Sessions", v: String(combo.count), from: "this track and car" },
    { k: "Valid laps", v: String(totalValid), from: `all ${combo.count} sessions` },
    {
      k: h.changeType ? `Change since first ${h.changeType.toLowerCase()}` : "Change since first",
      v: h.change === null ? "—" : `${formatDelta(h.change)} s`,
      from: h.change === null ? (h.changeType ? `needs 2 ${h.changeType} sessions` : "needs 2 sessions") : `${h.changeType} best, ${dateOf(h.changeFrom)} → ${dateOf(h.changeTo)}`,
      tone: h.change === null ? undefined : h.change < 0 ? styles.gain : styles.loss,
    },
    {
      k: "Time left on the table",
      v: h.gap === null ? "—" : `${h.gap.toFixed(2)} s`,
      from: h.gapFrom ? `${h.gapFrom.type}, ${dateOf(h.gapFrom)}` : "no session with a best possible lap",
    },
  ];

  const trackId = mine[0]?.track_id ?? null;

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
            <div className={ui.heading}>Best lap per session · {combo.label}</div>
            <div className={styles.pb}>PB <span className={styles.pbValue}>{formatLapTime(pb)}</span></div>
          </div>
          <div className={styles.plot}>
            <svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="Best and best possible lap per session, oldest to newest">
              <path d="M0 50 L1000 50 M0 100 L1000 100 M0 150 L1000 150" className={styles.grid} />
              <path d={trend.theo} className={styles.theo} />
              <path d={trend.best} className={styles.best} />
            </svg>
            {trend.best && (
              <>
                <div className={cx(styles.axis, styles.axisTop)}>{formatLapTime(trend.lo)} · faster ↑</div>
                <div className={cx(styles.axis, styles.axisBottom)}>{formatLapTime(trend.hi)}</div>
              </>
            )}
          </div>
          <div className={styles.xTicks} aria-label="Session dates">
            {ticks.map((t) => (
              <span key={t.i} className={styles.xTick} style={{ left: `${t.x}%` }}>{t.label}</span>
            ))}
          </div>
          <div className={styles.legend}>
            <span><span className={styles.legendBest}>━</span> best lap</span>
            <span>┄ best possible lap</span>
            <span>higher is faster</span>
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
                <th scope="col" className={styles.num}>Slower than your best by</th>
                <th scope="col" className={styles.num}>Best possible lap</th>
                <th scope="col" className={styles.num}>Track</th>
                <th scope="col">Focus</th>
                <th scope="col"><span className={styles.srOnly}>Open</span></th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map(({ session, summary, bestLapId, hasTraces }) => {
                const best = summary.best_lap_s;
                const out = summary.focus ? focusOutcome(summary.focus.improved) : null;
                return (
                  <tr key={session.session_id}>
                    <td className={styles.date}>
                      <Link to={sessionLink(search, session.session_id)} className={styles.rowButton} title="Open the session">
                        {formatShortDate(session.started_at)}
                      </Link>
                    </td>
                    <td>{session.session_type}{!hasTraces && <span className={styles.statsOnly} title="Recorded without lap traces: only the session numbers are available"> numbers only, no replay</span>}</td>
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
                        <Link to={lapLink(search, bestLapId)} className={styles.openLink}>Open →</Link>
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

      {trackId && <TrackMapSection key={trackId} trackId={trackId} />}
    </div>
  );
}

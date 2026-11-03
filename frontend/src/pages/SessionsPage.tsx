import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { sessionLapsOptions, sessionSummaryOptions, useSessions } from "../api/queries";
import type { SessionMeta, SessionSummary } from "../api/types";
import { formatDelta, formatLapTime, formatShortDate } from "../lib/format";
import { bestValidLap } from "../lib/laps";
import { comboKey, focusOutcome, groupCombos, trendPaths, type FocusTone } from "../lib/sessions";
import { cx } from "../lib/cx";
import ui from "../components/ui.module.css";
import styles from "./SessionsPage.module.css";

interface Row {
  session: SessionMeta;
  summary: SessionSummary;
  /** Best valid flying lap of the session, for the "Open" link. */
  bestLapId: string | null;
}

const TONE: Record<FocusTone, string> = { good: styles["tone-good"], bad: styles["tone-bad"], unclear: styles["tone-unclear"] };

export function SessionsPage() {
  const sessionsQ = useSessions();
  const sessions = sessionsQ.data ?? null;
  const [selected, setSelected] = useState<string | null>(null);

  const combos = useMemo(() => groupCombos(sessions ?? []), [sessions]);
  const comboKeyNow = selected && combos.some((c) => c.key === selected) ? selected : (combos[0]?.key ?? null);

  // Summaries and best laps for the selected combo's sessions (oldest first).
  const mine = useMemo(
    () => (sessions ?? []).filter((s) => comboKey(s) === comboKeyNow).sort((a, b) => a.started_at.localeCompare(b.started_at)),
    [sessions, comboKeyNow],
  );
  const combine = <T,>(rs: { data: T | undefined; error: Error | null }[]) => ({
    data: rs.every((r) => r.data !== undefined) ? rs.map((r) => r.data as T) : null,
    error: rs.find((r) => r.error)?.error ?? null,
  });
  const summaries = useQueries({ queries: mine.map((s) => sessionSummaryOptions(s.session_id)), combine });
  const lapsOf = useQueries({ queries: mine.map((s) => sessionLapsOptions(s.session_id)), combine });
  const rows: Row[] | null =
    sessions && comboKeyNow && summaries.data && lapsOf.data
      ? mine.map((session, i) => ({ session, summary: summaries.data![i], bestLapId: bestValidLap(lapsOf.data![i])?.lap_id ?? null }))
      : null;
  const error = (sessionsQ.error ?? summaries.error ?? lapsOf.error)?.message ?? null;

  if (error) return <div className={styles.statusError}>{error}</div>;
  if (!sessions) return <div className={styles.status}>Loading…</div>;
  if (combos.length === 0) return <div className={styles.status}>No sessions yet. Import a recording first.</div>;

  const combo = combos.find((c) => c.key === comboKeyNow)!;
  const bests = (rows ?? []).map((r) => r.summary.best_lap_s).filter((v): v is number => v !== null);
  const pb = bests.length ? Math.min(...bests) : null;
  const trend = trendPaths((rows ?? []).map((r) => ({ best: r.summary.best_lap_s, theo: r.summary.theoretical_best_s })), 1000, 200);
  const last = rows?.[rows.length - 1];
  const gained = bests.length >= 2 ? bests[bests.length - 1] - bests[0] : null;
  const gapTheo = last?.summary.best_lap_s != null && last.summary.theoretical_best_s != null ? last.summary.best_lap_s - last.summary.theoretical_best_s : null;
  const totalValid = (rows ?? []).reduce((n, r) => n + r.summary.n_valid, 0);

  const cards: { k: string; v: string; tone?: string }[] = [
    { k: "SESSIONS", v: String(combo.count) },
    { k: "VALID LAPS", v: String(totalValid) },
    { k: "CHANGE SINCE FIRST", v: gained === null ? "—" : `${formatDelta(gained)} s`, tone: gained === null ? undefined : gained < 0 ? styles.gain : styles.loss },
    { k: "GAP TO THEORETICAL", v: gapTheo === null ? "—" : `${gapTheo.toFixed(2)} s` },
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
              {[...rows].reverse().map(({ session, summary, bestLapId }) => {
                const best = summary.best_lap_s;
                const out = summary.focus ? focusOutcome(summary.focus.improved) : null;
                return (
                  <tr key={session.session_id}>
                    <td className={styles.date}>{formatShortDate(session.started_at)}</td>
                    <td>{session.session_type}</td>
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
                        <Link to={`/?lap=${encodeURIComponent(bestLapId)}`} className={styles.openLink}>Open →</Link>
                      ) : (
                        <span className={styles.dim} title="No valid flying lap">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

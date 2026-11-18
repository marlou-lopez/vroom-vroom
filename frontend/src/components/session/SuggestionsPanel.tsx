// EXPERIMENTAL (spike vroom-k5s.2, docs/session-report/suggestions.md): read-only setup and driver-aid suggestions under the session report.
// Shown only with ?suggest. Reads the garage setup and stint stats through the Api; the rules are in lib/setupSuggestions.ts.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessionStintsOptions, useSessionSetup } from "../../api/queries";
import type { SessionReport } from "../../api/types";
import { buildSuggestions, type SuggestionConfidence } from "../../lib/setupSuggestions";
import styles from "./Session.module.css";

const CONFIDENCE: Record<SuggestionConfidence, string> = { high: "high confidence", medium: "medium confidence", low: "low confidence" };

export function SuggestionsPanel({ report }: { report: SessionReport }) {
  const setup = useSessionSetup(report.session_id);
  const stints = useQuery(sessionStintsOptions(report.session_id));
  const set = useMemo(
    () => (setup.data && stints.data ? buildSuggestions(report, setup.data, stints.data) : null),
    [report, setup.data, stints.data],
  );
  return (
    <section className={styles.suggest} aria-label="Setup suggestions">
      <div className={styles.groupLabel}>
        SETUP SUGGESTIONS <span className={styles.experimental} title="Still being worked on; it may change or be removed">Experimental</span>
      </div>
      {setup.error || stints.error ? (
        <div className={styles.state} role="alert">Could not load the setup or the stint stats for suggestions.</div>
      ) : !set ? (
        <div className={styles.state} role="status">Loading…</div>
      ) : (
        <>
          <p className={styles.note}>Read only, one or two changes at a time. The garage values are the setup this session started with.</p>
          {set.suggestions.length === 0 ? (
            <div className={styles.state}>No change suggested for this session.</div>
          ) : (
            <ul className={styles.list}>
              {set.suggestions.map((s) => (
                <li key={s.id} className={styles.suggestion} data-confidence={s.confidence}>
                  <span className={styles.badges}>
                    <span className={styles.badge}>{s.kind === "experiment" ? "try for one run" : "change"}</span>
                    <span className={styles.badge}>{CONFIDENCE[s.confidence]}</span>
                  </span>
                  <span>
                    <strong>{s.title}</strong>
                    {s.current !== null && <span className={styles.where}> · now {s.current}</span>}
                  </span>
                  <span className={styles.sentence}>{s.reason}</span>
                  <span className={styles.where}>Why only {CONFIDENCE[s.confidence]}: {s.caveat}</span>
                  <span className={styles.where}>Check next time: {s.verify}</span>
                </li>
              ))}
            </ul>
          )}
          {set.observations.length > 0 && (
            <div className={styles.considered}>
              <div className={styles.where}>Observations, not changes yet: the target ranges come from your own laps or a rule of thumb.</div>
              <ul className={styles.list}>
                {set.observations.map((s) => (
                  <li key={s.id}>
                    <span className={styles.sentence}>{s.reason}</span>
                    <span className={styles.where}> If you want to act on it: {s.title.charAt(0).toLowerCase() + s.title.slice(1)}.</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {set.more.length > 0 && <p className={styles.note}>{set.more.length} more held back so that only two things change at once.</p>}
          <details className={styles.considered}>
            <summary>Looked at, no change ({set.considered.length})</summary>
            <ul className={styles.list}>
              {set.considered.map((c) => <li key={c.label}><strong>{c.label}</strong>: {c.reason}</li>)}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

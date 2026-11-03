import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Annotation } from "../lib/annotations";
import { formatDelta } from "../lib/format";
import type { CoachState } from "../state/useCoach";
import { cx } from "../lib/cx";
import { annotationColors } from "../theme";
import styles from "./AnalysisBar.module.css";
import ui from "./ui.module.css";

export interface AnalysisBarProps {
  coach: CoachState;
  annotations: Annotation[];
  /** Final lap delta against the comparison, when a comparison is loaded. */
  totalDelta: number | null;
  disabled: boolean;
}

const KINDS = [
  { kind: "issue", one: "issue", many: "issues", color: annotationColors.issue },
  { kind: "minor", one: "minor", many: "minor", color: annotationColors.minor },
  { kind: "strength", one: "strength", many: "strengths", color: annotationColors.strength },
  { kind: "inconsistent", one: "inconsistent", many: "inconsistent", color: annotationColors.inconsistent },
] as const;

function AverageMenu({ onAverage, disabled, attached }: { onAverage(): void; disabled: boolean; attached?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More analyses"
          disabled={disabled}
          className={attached ? cx(ui.btn, ui.btnMuted, styles.caretGhost) : styles.caretPrimary}
        >
          ▾
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={ui.menuContent}>
          <DropdownMenu.Item className={ui.menuItem} onSelect={onAverage}>Average (session consistency)</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AnalysisBar({ coach, annotations, totalDelta, disabled }: AnalysisBarProps) {
  const { results, running, error, showNotes, setShowNotes, run } = coach;
  const analyzed = Boolean(results.analyze || results.average);
  const busy = running !== null;
  const cost = [results.analyze, results.average].reduce((sum, r) => sum + (r?.cost_usd ?? 0), 0);
  const hasCost = [results.analyze, results.average].some((r) => r?.cost_usd != null);
  const focus = results.analyze?.focus ?? null;
  const counts = KINDS.map((k) => ({ ...k, n: annotations.filter((a) => a.kind === k.kind).length })).filter((k) => k.n > 0);

  return (
    <div className={styles.row}>
      {busy ? (
        <>
          <span className={styles.busy}>Analyzing…</span>
          <span className={styles.muted}>{running === "average" ? "comparing your laps in this session" : "computing corner facts, then asking the Engineer"}</span>
        </>
      ) : !analyzed ? (
        <>
          <span className={styles.group}>
            <button type="button" disabled={disabled} onClick={() => void run("analyze")} className={cx(ui.btnPrimary, styles.analyze)}>
              Analyze lap
            </button>
            <AverageMenu onAverage={() => void run("average")} disabled={disabled} />
          </span>
          <span className={styles.muted}>Plain telemetry. Analyze to mark up where you gain and lose time.</span>
        </>
      ) : (
        <>
          {totalDelta !== null && (
            <span className={cx(styles.delta, totalDelta > 0.005 && styles.deltaLoss, totalDelta < -0.005 && styles.deltaGain)}>
              {formatDelta(totalDelta)} s
            </span>
          )}
          <span className={styles.muted}>·</span>
          {counts.map((k) => (
            <span key={k.kind}><span style={{ color: k.color }}>●</span> {k.n} {k.n === 1 ? k.one : k.many}</span>
          ))}
          {focus && (
            <>
              <span className={styles.muted}>·</span>
              <span title={focus.metric} className={styles.focus}>Focus: {focus.instruction}</span>
            </>
          )}
          <div className={styles.spacer} />
          {hasCost && <span className={cx(styles.mono, styles.muted)}>${cost.toFixed(3)}</span>}
          <button type="button" aria-pressed={showNotes} onClick={() => setShowNotes(!showNotes)} className={ui.btn}>
            {showNotes ? "Hide notes" : "Show notes"}
          </button>
          <span className={styles.groupGap}>
            <button type="button" disabled={disabled} onClick={() => void run("analyze")} className={cx(ui.btn, ui.btnMuted)}>Re-analyze</button>
            <AverageMenu attached onAverage={() => void run("average")} disabled={disabled} />
          </span>
        </>
      )}
      {error && <span role="alert" className={styles.error}>{error.code}: {error.message}</span>}
    </div>
  );
}

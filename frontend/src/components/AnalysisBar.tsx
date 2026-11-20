import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import { plainCoachError } from "../lib/coachError";
import { standingLabel } from "../lib/compareName";
import type { Annotation } from "../lib/annotations";
import { formatDelta } from "../lib/format";
import type { CoachState } from "../state/useCoach";
import { cx } from "../lib/cx";
import { annotationColors, colors } from "../theme";
import styles from "./AnalysisBar.module.css";
import ui from "./ui.module.css";

export interface AnalysisBarProps {
  coach: CoachState;
  annotations: Annotation[];
  /** Lap-time gap to the comparison (positive = slower), when a comparison is loaded. */
  totalDelta: number | null;
  /** Short name of the comparison ("ideal", "L7"); null while unknown. */
  refName?: string | null;
  disabled: boolean;
}

const KINDS = [
  { kind: "issue", one: "big loss", many: "big losses", color: annotationColors.issue },
  { kind: "minor", one: "small loss", many: "small losses", color: annotationColors.minor },
  { kind: "strength", one: "good corner", many: "good corners", color: annotationColors.strength },
  { kind: "inconsistent", one: "corner you drive differently each lap", many: "corners you drive differently each lap", color: annotationColors.inconsistent },
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
          <DropdownMenu.Item className={ui.menuItem} onSelect={onAverage}>Check consistency across laps</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const LEGEND: { glyph: string; color: string; text: string }[] = [
  { glyph: "1 2 3", color: annotationColors.issue, text: "Big losses that cost time, numbered biggest first" },
  { glyph: "!", color: annotationColors.minor, text: "Small loss worth a look" },
  { glyph: "✓", color: annotationColors.strength, text: "Good corner, or a finding you marked reviewed" },
  { glyph: "~", color: annotationColors.inconsistent, text: "Drive differently each lap: this corner varies between your laps (Check consistency)" },
];
const TAGS: [string, string][] = [
  ["Use a trackside marker", "the fix points at a trackside marker"],
  ["Tip", "the fix is a feel cue (no marker nearby)"],
  ["Copy your better lap", "the fix points at your own better lap"],
];

/** Section titles over the key's rows; the swatch colours match the map, the strips and the coach marks. */
const MAP_KEY: { color: string; text: string }[] = [
  { color: colors.understeer, text: "Car pushing wide (understeer): map line and steering strip" },
  { color: colors.closeCall, text: "Nearly off track: two wheels off on a valid lap (red when the lap is invalid)" },
  { color: colors.lockup, text: "Lockup: a wheel locked under braking" },
  { color: colors.wheelspin, text: "Wheelspin: a driven wheel spun on exit" },
  { color: colors.oversteer, text: "Oversteer (experimental, only with ?balance)" },
];
const STRIP_KEY: { color: string; text: string }[] = [
  { color: annotationColors.issue, text: "Shaded corner on the strips: the coach has a finding there (colour = kind)" },
  { color: colors.brake, text: "Light shading under the brake trace: ABS working" },
  { color: colors.throttle, text: "Light shading under the throttle trace: traction control working" },
  { color: colors.closeCall, text: "Full-height band: two or more wheels off the track (tan on a valid lap, red on an invalid one)" },
  { color: colors.lockup, text: "Red / amber marks on the pedal strip: lockups and wheelspin" },
];

/** The rows of the key: map marks, strip shading and coach marks. Shared by the Analysis bar's popover and the Lap view's "⋯" menu. */
export function LegendRows() {
  return (
    <>
      <div className={styles.legendTitle}>Map</div>
      {MAP_KEY.map((l) => (
        <div key={l.text} className={styles.legendRow}><span className={styles.swatch} style={{ background: l.color }} />{l.text}</div>
      ))}
      <div className={styles.legendTitle}>Strips</div>
      <div className={styles.legendRow}>Rising time vs best = you are losing time. Falling = gaining.</div>
      {STRIP_KEY.map((l) => (
        <div key={l.text} className={styles.legendRow}><span className={styles.swatch} style={{ background: l.color }} />{l.text}</div>
      ))}
      <div className={styles.legendTitle}>Coach marks</div>
      {LEGEND.map((l) => (
        <div key={l.glyph} className={styles.legendRow}><span className={styles.glyph} style={{ background: l.color }}>{l.glyph}</span>{l.text}</div>
      ))}
      {TAGS.map(([tag, text]) => (
        <div key={tag} className={styles.legendRow}><span className={styles.tagKey}>{tag}</span>{text}</div>
      ))}
      <div className={styles.legendRow}>Click a mark to open its card. Hover previews it after a moment.</div>
    </>
  );
}

/** The one key: map marks, strip shading and coach marks, available before and after Analyze. */
function Legend() {
  return (
    <Popover.Root>
      <Popover.Trigger className={ui.btn} aria-label="What the marks mean" title="What the marks mean">Key</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} className={styles.legend} aria-label="Key">
          <LegendRows />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Busy({ running, onCancel }: { running: "analyze" | "average" | string; onCancel(): void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.busy} role="status">{running === "average" ? "Averaging…" : "Analyzing…"} {secs}s</span>
      <span className={styles.muted}>{running === "average" ? "comparing your laps in this session" : "computing corner facts, then asking the Engineer"}</span>
      <div className={styles.spacer} />
      <button type="button" className={ui.btn} onClick={onCancel}>Cancel</button>
    </>
  );
}

export function AnalysisBar({ coach, annotations, totalDelta, refName = null, disabled }: AnalysisBarProps) {
  const { results, running, error, failedCommand, cancel, showNotes, setShowNotes, run } = coach;
  const analyzed = Boolean(results.analyze || results.average);
  const busy = running !== null;
  const cost = [results.analyze, results.average].reduce((sum, r) => sum + (r?.cost_usd ?? 0), 0);
  const hasCost = [results.analyze, results.average].some((r) => r?.cost_usd != null);
  const focus = results.analyze?.focus ?? null;
  const counts = KINDS.map((k) => ({ ...k, n: annotations.filter((a) => a.kind === k.kind).length })).filter((k) => k.n > 0);

  return (
    <div className={styles.row}>
      {busy ? (
        <><Busy running={running} onCancel={cancel} /><Legend /></>
      ) : !analyzed ? (
        <>
          <span className={styles.group}>
            <button type="button" disabled={disabled} onClick={() => void run("analyze")} className={cx(ui.btnPrimary, styles.analyze)}>
              Analyze lap
            </button>
            <AverageMenu onAverage={() => void run("average")} disabled={disabled} />
          </span>
          <span className={styles.muted}>Plain telemetry. Analyze to mark up where you gain and lose time.</span>
          <div className={styles.spacer} />
          <Legend />
        </>
      ) : (
        <>
          {totalDelta !== null && (
            <span
              className={styles.totalWrap}
              title="Lap time minus the comparison's lap time. + means this lap is slower."
            >
              <span className={styles.muted}>Lap time gap</span>{" "}
              <span className={cx(styles.delta, totalDelta > 0.005 && styles.deltaLoss, totalDelta < -0.005 && styles.deltaGain)}>
                {formatDelta(totalDelta)} s
              </span>
              {(() => { const st = standingLabel(totalDelta, refName ?? "the comparison"); return st ? <span className={styles.muted}> {st}</span> : null; })()}
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
          {hasCost && (
            <span className={cx(styles.mono, styles.muted)} title="What the language model charged for the analyses of this lap (Analyze and Average). Telemetry itself is free.">
              Coach cost ${cost.toFixed(3)}
            </span>
          )}
          <Legend />
          <button type="button" aria-pressed={showNotes} onClick={() => setShowNotes(!showNotes)} className={ui.btn}>
            {showNotes ? "Hide notes" : "Show notes"}
          </button>
          <span className={styles.groupGap}>
            <button type="button" disabled={disabled} onClick={() => void run("analyze")} className={cx(ui.btn, ui.btnMuted)}>Ask again</button>
            <AverageMenu attached onAverage={() => void run("average")} disabled={disabled} />
          </span>
        </>
      )}
      {error && (
        <span role="alert" className={styles.error} title={`${error.code}: ${error.message}`}>
          {plainCoachError(error.code)}
          {failedCommand && failedCommand !== "corner" && (
            <button type="button" className={ui.btn} onClick={() => void run(failedCommand)}>Retry</button>
          )}
        </span>
      )}
    </div>
  );
}

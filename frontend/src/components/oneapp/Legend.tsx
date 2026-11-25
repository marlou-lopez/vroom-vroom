import { annotationColors, colors } from "../../theme";
import styles from "./Legend.module.css";

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

/** The rows of the key: map marks, strip shading and coach marks, for the Lap view's "⋯" menu. */
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
      <div className={styles.legendTitle}>Keys</div>
      <div className={styles.legendRow}><span className={styles.tagKey}>R</span>compare with the next lap of the session (Shift+R: the previous one)</div>
      <div className={styles.legendRow}><span className={styles.tagKey}>↑ ↓</span>previous or next lap</div>
      <div className={styles.legendRow}>Click a mark to open its card. Hover previews it after a moment.</div>
    </>
  );
}

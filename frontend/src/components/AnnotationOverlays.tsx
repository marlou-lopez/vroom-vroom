import { useMemo, type CSSProperties, type Ref } from "react";
import { MAP_W, type PlaybackModel } from "../lib/model";
import type { Annotation } from "../lib/annotations";
import { mapSpan } from "../lib/driverAids";
import { likelyInvalidRun, offTrackRuns } from "../lib/offTrack";
import { timeAtDistance } from "../lib/playback";
import { chipFraction } from "../lib/strips";
import { cornerSegmentPath, pointAtDistance, splitWrapping } from "../lib/trackmap";
import { smallFontPx } from "../lib/cornerLabels";
import styles from "./AnnotationOverlays.module.css";
import { AnnotationHoverCard } from "./AnnotationPopup";

/** Click wiring shared by every badge and chip. Hover cards come from `AnnotationHoverCard`. */
export interface BadgeHandlers {
  onSeek(a: Annotation): void;
  /** Seek to a spot on the lap (metres), pausing there: the invalid-lap marker (vroom-ake). */
  onSeekDistance?(m: number): void;
}

const CHIP_CHAR_EM = 0.6;
const SCRUB_BADGE_PX = 24;

/** Sideways shift (px) of a stacked chip: the estimated widths of the chips before it on the same corner. */
function chipShift(a: Annotation, all: Annotation[]): number {
  let px = 0;
  const charPx = CHIP_CHAR_EM * smallFontPx();
  for (const o of all) if (o.cornerId === a.cornerId && o.stack < a.stack) px += (o.label.length + 1 + o.finding.corner.length) * charPx + 16;
  return px;
}

const aria = (a: Annotation) => `${a.finding.corner} ${a.label} ${a.finding.kind}`;

/** Tinted corner segments on the map (SVG, map coordinates). The paths are built once per annotation set. */
export function MapSegments({ annotations, model }: { annotations: Annotation[]; model: PlaybackModel }) {
  const segs = useMemo(
    () => annotations.map((a) => ({ a, d: cornerSegmentPath(model.proj, model.cmp.distance, a.startM, a.endM) })),
    [annotations, model],
  );
  return (
    <>
      {segs.map(({ a, d }) =>
        d ? <path key={a.findingId} d={d} className={styles.segment} style={{ stroke: a.color }} /> : null,
      )}
    </>
  );
}

/** Numbered badges beside the apex, on the side of the map away from the centre. */
export function MapBadges({ annotations, model, h }: { annotations: Annotation[]; model: PlaybackModel; h: BadgeHandlers }) {
  const badges = useMemo(
    () =>
      annotations.map((a) => {
        const p = pointAtDistance(model.proj, model.cmp.distance, a.apexM);
        const step = 12 + a.stack * 14; // later findings on the same corner step further outward
        return { a, x: p.x > MAP_W / 2 ? p.x + step : p.x - step, y: p.y };
      }),
    [annotations, model],
  );
  return (
    <>
      {badges.map(({ a, x, y }) => (
        <AnnotationHoverCard key={a.findingId} annotation={a}>
          {/*
            The card's anchor is the SVG <g> itself (Radix's asChild merges its props and ref onto it; Enter/Space/ArrowDown open the card, see `AnnotationHoverCard`), so no
            foreignObject is needed; the popper anchors on the group's bounding box. `data-annotation-badge` is how
            TrackPanel's scrub handlers recognise a badge and leave it alone.
          */}
          <g
            data-annotation-badge=""
            role="button"
            tabIndex={0}
            aria-label={aria(a)}
            className={styles.mapBadge}
            onClick={() => h.onSeek(a)}
          >
            <circle cx={x} cy={y} r={6.5} className={styles.mapBadgeDot} style={{ fill: a.color }} />
            <text x={x} y={y + 2.5} className={styles.mapBadgeText}>{a.label}</text>
          </g>
        </AnnotationHoverCard>
      ))}
    </>
  );
}

/**
 * Chips for the speed strip: one wide layer holding every chip of the lap, positioned as a fraction of its width.
 * The strips component sets this layer's `width` and `transform` imperatively on every scale change (the class
 * deliberately leaves both out so a React re-render never resets them). Shaded bands are drawn in uPlot.
 */
export function ChipLayer({
  annotations, distance, h, layerRef,
}: { annotations: Annotation[]; distance: ArrayLike<number>; h: BadgeHandlers; layerRef: Ref<HTMLDivElement> }) {
  const d0 = distance[0] ?? 0;
  const d1 = distance[distance.length - 1] ?? 0;
  return (
    <div ref={layerRef} className={styles.chipLayer}>
      {annotations.map((a) => (
        <AnnotationHoverCard key={a.findingId} annotation={a}>
          <button
            type="button"
            aria-label={aria(a)}
            onClick={() => h.onSeek(a)}
            className={styles.chip}
            style={{ left: `${chipFraction(a.apexM, d0, d1) * 100}%`, background: a.color, "--shift": `${chipShift(a, annotations)}px` } as CSSProperties}
          >
            {a.label} {a.finding.corner}
          </button>
        </AnnotationHoverCard>
      ))}
    </div>
  );
}

/** Shaded sections inside the scrubber (x as a percent of lap time). */
export function ScrubberSections({ annotations, duration }: { annotations: Annotation[]; duration: number }) {
  if (duration <= 0) return null;
  return (
    <>
      {annotations.flatMap((a) =>
        splitWrapping(a.tStart, a.tEnd, duration).map(([t0, t1], i) => (
          <div
            key={`${a.findingId}-${i}`}
            className={styles.section}
            style={{ left: `${(t0 / duration) * 100}%`, width: `${((t1 - t0) / duration) * 100}%`, background: `${a.color}33` }}
          />
        )),
      )}
    </>
  );
}

/** Badges above the scrubber, at each corner's apex time. */
export function ScrubberBadges({ annotations, duration, h }: { annotations: Annotation[]; duration: number; h: BadgeHandlers }) {
  if (duration <= 0) return null;
  return (
    <>
      {annotations.map((a) => (
        <AnnotationHoverCard key={a.findingId} annotation={a}>
          <button
            type="button"
            aria-label={aria(a)}
            onClick={() => h.onSeek(a)}
            className={styles.scrubBadge}
            style={{ left: `${(a.tApex / duration) * 100}%`, background: a.color, "--shift": `${a.stack * SCRUB_BADGE_PX}px` } as CSSProperties}
          >
            {a.label}
          </button>
        </AnnotationHoverCard>
      ))}
    </>
  );
}

/** Ticks in the scrubber where two or more wheels were off the track (vroom-pnw.24): red on an invalid lap, grey on a valid one. */
export function ScrubberOffTrack({ model, valid }: { model: PlaybackModel; valid: boolean }) {
  const { cmp, duration } = model;
  const runs = useMemo(() => offTrackRuns(cmp.lap), [cmp.lap]);
  if (duration <= 0) return null;
  const last = cmp.distance.length - 1;
  return (
    <>
      {runs.length > 0 && (
        <span className={styles.offLegend} data-testid="scrubber-off-track-legend">
          {valid ? "grey" : "red"}: wheels off track
        </span>
      )}
      {runs.map((r) => {
        const [a, b] = mapSpan(r, last);
        const t0 = timeAtDistance(cmp.lap.t, cmp.distance, cmp.distance[a]);
        const t1 = timeAtDistance(cmp.lap.t, cmp.distance, cmp.distance[b]);
        return (
          <div
            key={r.start}
            data-testid="scrubber-off-track"
            data-valid={valid}
            title={valid ? "Two or more wheels off the track (the lap still counts)" : "Two or more wheels off the track (invalid lap)"}
            className={styles.offTrack}
            style={{ left: `${(t0 / duration) * 100}%`, width: `${((t1 - t0) / duration) * 100}%` }}
          />
        );
      })}
    </>
  );
}

/** Where the lap was most likely invalidated (vroom-ake): a clickable mark on the scrubber at the first wheels-off stretch of an invalid lap. */
export function ScrubberInvalidMark({ model, valid, onSeekDistance }: { model: PlaybackModel; valid: boolean; onSeekDistance?: (m: number) => void }) {
  const { cmp, duration } = model;
  const run = useMemo(() => (valid ? null : likelyInvalidRun(offTrackRuns(cmp.lap))), [valid, cmp.lap]);
  if (!run || duration <= 0) return null;
  const m = cmp.distance[run.start] ?? run.start;
  const t = timeAtDistance(cmp.lap.t, cmp.distance, m);
  return (
    <button
      type="button"
      data-testid="scrubber-invalid-mark"
      aria-label="Where the lap was most likely invalidated"
      title="Most likely where the lap was invalidated: click to go there"
      className={styles.invalidMark}
      style={{ left: `${(t / duration) * 100}%` }}
      onClick={() => onSeekDistance?.(m)}
    >
      ✕
    </button>
  );
}

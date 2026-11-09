import { useMemo, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { MAP_W, type PlaybackModel } from "../lib/model";
import type { Annotation } from "../lib/annotations";
import { chipFraction } from "../lib/strips";
import { cornerSegmentPath, pointAtDistance, splitWrapping } from "../lib/trackmap";
import styles from "./AnnotationOverlays.module.css";
import { AnnotationHoverCard } from "./AnnotationPopup";

/** Click wiring shared by every badge and chip. Hover cards come from `AnnotationHoverCard`. */
export interface BadgeHandlers {
  onSeek(a: Annotation): void;
}

const CHIP_CHAR_PX = 6;
const SCRUB_BADGE_PX = 18;

/** Sideways shift (px) of a stacked chip: the estimated widths of the chips before it on the same corner. */
function chipShift(a: Annotation, all: Annotation[]): number {
  let px = 0;
  for (const o of all) if (o.cornerId === a.cornerId && o.stack < a.stack) px += (o.label.length + 1 + o.finding.corner.length) * CHIP_CHAR_PX + 16;
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
            The hover-card trigger is the SVG <g> itself (Radix's asChild merges its props and ref onto it), so no
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
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                h.onSeek(a);
              }
            }}
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

import { useMemo, useRef, useState, type PointerEvent } from "react";
import { MAP_H, MAP_PAD, MAP_W } from "../../lib/model";
import { distanceAtTime, timeAtDistance } from "../../lib/playback";
import { cornerAt, MAP_HIT_PX, pointAtDistance, SCRUB_WINDOW_M, scrubTarget, cornerSegmentPath } from "../../lib/trackmap";
import { usePlayback, usePlaybackStore } from "../../state/playback";
import { MapBadges, MapSegments } from "../AnnotationOverlays";
import type { TrackViewProps } from "./types";
import styles from "./ClassicMapView.module.css";

const VIEWBOX = `${-MAP_PAD} ${-MAP_PAD} ${MAP_W + 2 * MAP_PAD} ${MAP_H + 2 * MAP_PAD}`;
const BADGE_SELECTOR = "[data-annotation-badge]";

interface Ghost {
  index: number;
  x: number;
  y: number;
  distance: number;
  corner: string | null;
}

interface Drag {
  pointerId: number;
  /** Grid index of the last scrub position; the next windowed search is centred on it. */
  index: number;
  resume: boolean;
}

export function ClassicMapView({ model, trackMap, annotations, handlers }: TrackViewProps) {
  const store = usePlaybackStore();
  const tau = usePlayback((s) => s.tau);
  const { cmp, proj } = model;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  // Hover and drag state stays here: pointer moves re-render this view only, never the page.
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [dragging, setDragging] = useState(false);

  const dYou = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const dRef = distanceAtTime(cmp.ref.t, cmp.distance, tau);
  const you = pointAtDistance(proj, cmp.distance, dYou);
  const ref = pointAtDistance(proj, cmp.distance, dRef);
  const corner = trackMap ? cornerAt(trackMap, dYou) : null;

  // The tinted segment only changes when the corner does.
  const cornerId = corner?.id ?? null;
  const cornerPath = useMemo(() => {
    const c = trackMap?.corners.find((k) => k.id === cornerId);
    if (!c) return "";
    return cornerSegmentPath(proj, cmp.distance, c.start_m, c.end_m);
  }, [trackMap, cornerId, proj, cmp.distance]);

  const toMap = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    const pxPerUnit = Math.hypot(ctm.a, ctm.b) || 1;
    return { x: p.x, y: p.y, maxDist: MAP_HIT_PX / pxPerUnit };
  };

  const seekToIndex = (index: number) => store.seek(timeAtDistance(cmp.lap.t, cmp.distance, cmp.distance[index] ?? index));

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || drag.current || (e.target as Element).closest(BADGE_SELECTOR)) return;
    // Hover cards render in a portal, but React still bubbles their events here; don't scrub from them.
    if (!e.currentTarget.contains(e.target as Node)) return;
    const m = toMap(e);
    if (!m) return;
    // Grabbing your own dot continues from where it is (windowed); otherwise the whole lap is searched.
    const onDot = Math.hypot(you.x - m.x, you.y - m.y) <= m.maxDist;
    const centre = Math.round(dYou);
    const hit = scrubTarget(proj, m.x, m.y, m.maxDist, onDot ? { index: centre, halfWindow: SCRUB_WINDOW_M } : undefined);
    if (!hit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const resume = store.get().playing;
    store.pause();
    drag.current = { pointerId: e.pointerId, index: hit.index, resume };
    setDragging(true);
    setGhost(null);
    seekToIndex(hit.index);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const m = toMap(e);
    if (!m) return;
    const d = drag.current;
    if (d) {
      if (e.pointerId !== d.pointerId) return;
      const hit = scrubTarget(proj, m.x, m.y, m.maxDist, { index: d.index, halfWindow: SCRUB_WINDOW_M });
      if (!hit) return;
      d.index = hit.index;
      seekToIndex(hit.index);
      return;
    }
    if (e.pointerType === "touch" || (e.target as Element).closest(BADGE_SELECTOR) || !e.currentTarget.contains(e.target as Node)) {
      setGhost(null);
      return;
    }
    const hit = scrubTarget(proj, m.x, m.y, m.maxDist);
    if (!hit) {
      setGhost(null);
      return;
    }
    setGhost((prev) => {
      if (prev?.index === hit.index) return prev;
      const distance = cmp.distance[hit.index] ?? hit.index;
      return { index: hit.index, x: proj.x[hit.index], y: proj.y[hit.index], distance, corner: trackMap ? (cornerAt(trackMap, distance)?.name ?? null) : null };
    });
  };

  const endDrag = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.resume) store.play();
  };

  const labelRight = ghost ? ghost.x <= MAP_W / 2 : true;

  return (
    <svg
      ref={svgRef}
      viewBox={VIEWBOX}
      aria-hidden="true"
      className={styles.map}
      data-near={ghost !== null}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerLeave={() => setGhost(null)}
    >
      <path d={model.mapPath} className={styles.base} />
      {cornerPath && <path d={cornerPath} className={styles.cornerNow} />}
      <MapSegments annotations={annotations} model={model} />
      {ghost && !dragging && (
        <>
          <circle cx={ghost.x} cy={ghost.y} r={3.2} className={styles.ghostDot} />
          <text
            x={ghost.x + (labelRight ? 7 : -7)} y={ghost.y - 5}
            textAnchor={labelRight ? "start" : "end"} className={styles.ghostLabel}
          >
            {Math.round(ghost.distance).toLocaleString("en-US")} m{ghost.corner ? ` · ${ghost.corner}` : ""}
          </text>
        </>
      )}
      <circle cx={ref.x} cy={ref.y} r={3.6} className={styles.refDot} />
      <circle cx={you.x} cy={you.y} r={3.6} className={styles.youDot} />
      <MapBadges annotations={annotations} model={model} h={handlers} />
    </svg>
  );
}

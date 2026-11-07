import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent, type RefObject } from "react";
import { MIN_WIDTH_M, fitBounds, screenToWorld, type Camera, type Viewport } from "../../../lib/camera";
import type { CompareResponse } from "../../../api/types";
import { distanceAtTime, timeAtDistance } from "../../../lib/playback";
import { seekIndexNear } from "../../../lib/seek";
import { MAP_HIT_PX } from "../../../lib/trackmap";
import type { PlaybackStore } from "../../../state/playback";
import type { CameraMode } from "./bench";
import type { Scene } from "./scene";

const DRAG_PX = 3;
const CLICK_PX = 4;

interface Drag { id: number; lastX: number; lastY: number; total: number; sumX: number; sumY: number }

/** What the gestures read and write; all of it lives in the view because the draw loop shares it. */
export interface GestureTargets {
  rootRef: RefObject<HTMLDivElement | null>;
  vp: MutableRefObject<Viewport>;
  sceneRef: MutableRefObject<Scene>;
  cmpRef: MutableRefObject<CompareResponse>;
  modeRef: MutableRefObject<CameraMode>;
  shownCam: MutableRefObject<Camera | null>;
  /** Gestures are ignored while the benchmark drives the camera. */
  benchRunning: MutableRefObject<boolean>;
  store: PlaybackStore;
  applyMode: (mode: CameraMode) => void;
  /** Zoom by `factor` within `limits`: the follow width, or the free camera around `anchor` (screen px). */
  zoomBy: (factor: number, anchor: { x: number; y: number }, limits: { minM: number; maxM: number }) => void;
  /** Pan the free camera by screen pixels. */
  panFree: (dx: number, dy: number) => void;
}

/** Wheel zoom, drag to pan (leaving follow mode) and click to seek, for the detailed map view. */
export function useMapGestures(t: GestureTargets) {
  const { rootRef, vp, sceneRef, cmpRef, modeRef, shownCam, benchRunning, store, applyMode, zoomBy, panFree } = t;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);

  // Wheel needs preventDefault, so it is attached non-passive by hand.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[data-controls]")) return;
      e.preventDefault();
      if (benchRunning.current) return;
      const v = vp.current;
      const sc = sceneRef.current;
      const factor = Math.pow(1.0015, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
      const limits = { minM: MIN_WIDTH_M, maxM: fitBounds(sc.bounds, v).widthM * 1.2 };
      const rect = root.getBoundingClientRect();
      zoomBy(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top }, limits);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [rootRef, benchRunning, vp, sceneRef, zoomBy]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current || benchRunning.current) return;
    // Hover cards render in a portal, but React still bubbles their events here; capturing them would eat their clicks.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as Element).closest("[data-annotation-badge],[data-controls]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, total: 0, sumX: 0, sumY: 0 };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.total += Math.abs(dx) + Math.abs(dy);
    d.sumX += dx;
    d.sumY += dy;
    let pan: [number, number] | null = [dx, dy];
    if (modeRef.current === "follow") {
      if (d.total <= DRAG_PX) return;
      // Start free from the picture on screen, then catch up with the movement so far.
      applyMode("free");
      pan = [d.sumX, d.sumY];
    }
    if (!dragging) setDragging(true);
    panFree(pan[0], pan[1]);
  };

  /** A press and release with < CLICK_PX movement seeks to the lap-line point within MAP_HIT_PX nearest your car along the lap. */
  const seekAt = (e: PointerEvent<HTMLDivElement>) => {
    const cam = shownCam.current;
    const v = vp.current;
    const root = rootRef.current;
    if (!cam || !root || v.w <= 0) return;
    const rect = root.getBoundingClientRect();
    const w = screenToWorld(cam, v, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const c = cmpRef.current;
    const here = Math.round(distanceAtTime(c.lap.t, c.distance, store.get().tau));
    const best = seekIndexNear(sceneRef.current.lap, w, MAP_HIT_PX / (v.w / cam.widthM), here);
    if (best < 0) return;
    store.seek(timeAtDistance(c.lap.t, c.distance, best));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && e.pointerId === d.id && d.total < CLICK_PX) seekAt(e);
    endDrag(e);
  };

  return {
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: endDrag, onLostPointerCapture: endDrag },
  };
}

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  FOLLOW_WIDTH_M, MIN_WIDTH_M, fitBounds, followCamera, panBy, screenToWorld, smoothHeading, worldToScreen, zoomAt,
  type Camera, type Viewport,
} from "../../../lib/camera";
import { cx } from "../../../lib/cx";
import { pointAt } from "../../../lib/geo";
import { summarize } from "../../../lib/perf";
import { distanceAtTime, timeAtDistance } from "../../../lib/playback";
import { MAP_HIT_PX } from "../../../lib/trackmap";
import { usePlaybackStore } from "../../../state/playback";
import { AnnotationHoverCard } from "../../AnnotationPopup";
import ui from "../../ui.module.css";
import type { TrackViewProps } from "../types";
import { benchMarkdown, runBench, type BenchControl, type BenchRow, type CameraMode } from "./bench";
import { createRenderer, type Renderer, type RendererKind } from "./renderer";
import { buildScene, carPositions, type CarSync, type LineSource } from "./scene";
import styles from "./DetailedMapView.module.css";

const KINDS: { id: RendererKind; label: string }[] = [
  { id: "svg", label: "SVG" },
  { id: "canvas", label: "Canvas" },
  { id: "webgl", label: "WebGL" },
];
const KIND_KEY = "vroom.detailedRenderer";
const RING = 120;
const HUD_MS = 250;
const DRAG_PX = 3;
const CLICK_PX = 4;
const HEADING_ALPHA = 0.2;
const HEADING_JUMP_M = 50;
/** Draws closer together than this are not frame intervals (a second draw within the same frame). */
const MIN_INTERVAL_MS = 4;
const BADGE_OFFSET_PX = 12;
const BADGE_STACK_PX = 14;

function loadKind(): RendererKind {
  try {
    const v = globalThis.localStorage?.getItem(KIND_KEY);
    return KINDS.find((k) => k.id === v)?.id ?? "webgl";
  } catch {
    return "webgl";
  }
}

function saveKind(kind: RendererKind): void {
  try {
    globalThis.localStorage?.setItem(KIND_KEY, kind);
  } catch {
    // Not remembered.
  }
}

/** Fixed-size ring of numbers (the last RING samples). */
class Ring {
  private buf = new Float64Array(RING);
  private n = 0;
  push(v: number) {
    this.buf[this.n % RING] = v;
    this.n++;
  }
  values(): Float64Array {
    return this.buf.subarray(0, Math.min(this.n, RING));
  }
}

interface Drag { id: number; lastX: number; lastY: number; total: number; sumX: number; sumY: number }

const f1 = (v: number) => v.toFixed(1);

export function DetailedMapView({ model, annotations, handlers }: TrackViewProps) {
  const store = usePlaybackStore();
  const { cmp } = model;
  const [source, setSource] = useState<LineSource>("lateral");
  const [sync, setSyncState] = useState<CarSync>("time");
  const [gpsHalf, setGpsHalf] = useState(4);
  const scene = useMemo(() => buildScene(cmp, { source, gpsHalf }), [cmp, source, gpsHalf]);

  const [kind, setKind] = useState<RendererKind>(loadKind);
  const [mode, setModeState] = useState<CameraMode>("follow");
  const [headingUp, setHeadingUpState] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [hudText, setHudText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [panel, setPanel] = useState<Viewport | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sceneRef = useRef(scene);
  const cmpRef = useRef(cmp);
  const annRef = useRef(annotations);
  const modeRef = useRef<CameraMode>("follow");
  const syncRef = useRef<CarSync>("time");
  const headingUpRef = useRef(false);
  const smoothedHeading = useRef(0);
  const resetHeading = useRef(true);
  const lastDist = useRef(0);
  const freeCam = useRef<Camera | null>(null);
  const shownCam = useRef<Camera | null>(null);
  const followW = useRef(FOLLOW_WIDTH_M);
  const vp = useRef<Viewport>({ w: 0, h: 0 });
  const raf = useRef(0);
  const lastDrawT = useRef(0);
  const frames = useRef(new Ring());
  const draws = useRef(new Ring());
  const drawRec = useRef<number[] | null>(null);
  const benchRunning = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const badgeEls = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);

  const drawFrame = useCallback((now: number) => {
    raf.current = 0;
    const r = rendererRef.current;
    const v = vp.current;
    if (!r || v.w <= 0 || v.h <= 0) return;
    const sc = sceneRef.current;
    const tau = store.get().tau;
    const cars = carPositions(sc, cmpRef.current, tau, syncRef.current);
    const dist = distanceAtTime(cmpRef.current.lap.t, cmpRef.current.distance, tau);
    const jumped = Math.abs(dist - lastDist.current) > HEADING_JUMP_M;
    lastDist.current = dist;
    let cam: Camera;
    if (modeRef.current === "follow") {
      const up = headingUpRef.current;
      if (up) {
        // Smooth the rotation; start from the true heading when entering follow or after a seek so it does not swing.
        smoothedHeading.current = resetHeading.current || jumped
          ? cars.heading
          : smoothHeading(smoothedHeading.current, cars.heading, HEADING_ALPHA);
        resetHeading.current = false;
      }
      cam = followCamera(cars.lap, up ? smoothedHeading.current : cars.heading, followW.current, up);
    }
    else cam = freeCam.current ?? (freeCam.current = fitBounds(sc.bounds, v));
    shownCam.current = cam;

    const t0 = performance.now();
    r.draw({ camera: cam, viewport: v, lapCar: cars.lap, refCar: cars.ref, lapHeading: cars.heading, refHeading: cars.refHeading });
    const dt = performance.now() - t0;
    draws.current.push(dt);
    drawRec.current?.push(dt);

    // Intervals only count while frames are drawn back to back.
    if ((store.get().playing || benchRunning.current) && lastDrawT.current > 0 && now - lastDrawT.current < 100 && now - lastDrawT.current >= MIN_INTERVAL_MS) {
      frames.current.push(now - lastDrawT.current);
    }
    lastDrawT.current = now;

    for (const a of annRef.current) {
      const el = badgeEls.current.get(a.findingId);
      if (!el) continue;
      const s = worldToScreen(cam, v, pointAt(sc.ref, a.apexM));
      const y = s.y - (BADGE_OFFSET_PX + a.stack * BADGE_STACK_PX);
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = s.x < -10 || s.x > v.w + 10 || y < -10 || y > v.h + 10 ? "hidden" : "visible";
    }
  }, [store]);

  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);

  const applyMode = useCallback((next: CameraMode) => {
    if (next === modeRef.current) return;
    // Leaving follow keeps the picture where it is.
    if (next === "free") freeCam.current = shownCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
    if (next === "follow") resetHeading.current = true;
    modeRef.current = next;
    setModeState(next);
    requestDraw();
  }, [requestDraw]);

  // Keep the refs the draw loop reads in step with the props.
  useEffect(() => {
    cmpRef.current = cmp;
    annRef.current = annotations;
    requestDraw();
  }, [cmp, annotations, requestDraw]);

  useEffect(() => {
    sceneRef.current = scene;
    rendererRef.current?.setScene(scene);
    requestDraw();
  }, [scene, requestDraw]);

  // While playing, tau changes once per frame inside the playback loop's own rAF: draw right then (no one-frame lag).
  useEffect(() => store.subscribe(() => {
    if (store.get().playing) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      drawFrame(performance.now());
    } else {
      requestDraw();
    }
  }), [store, requestDraw, drawFrame]);

  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    abort.current?.abort();
  }, []);

  // Renderer lifecycle. The promise can resolve after a kind change or unmount; a late renderer is destroyed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ac = new AbortController();
    const ready = createRenderer(kind, host).then((r) => {
      if (ac.signal.aborted) {
        r.destroy();
        return null;
      }
      rendererRef.current = r;
      r.setScene(sceneRef.current);
      r.resize(vp.current, window.devicePixelRatio || 1);
      requestDraw();
      return r;
    }, (err) => {
      console.error("renderer failed", err);
      return null;
    });
    return () => {
      ac.abort();
      void ready.then((r) => {
        if (!r) return;
        r.destroy();
        if (rendererRef.current === r) rendererRef.current = null;
      });
    };
  }, [kind, requestDraw]);

  // Resize: the host's size feeds the renderer; the free camera keeps its centre and width.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      vp.current = { w: host.clientWidth, h: host.clientHeight };
      rendererRef.current?.resize(vp.current, window.devicePixelRatio || 1);
      requestDraw();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [requestDraw]);

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
      if (modeRef.current === "follow") {
        followW.current = Math.min(Math.max(followW.current * factor, limits.minM), limits.maxM);
      } else {
        const rect = root.getBoundingClientRect();
        const cam = freeCam.current ?? fitBounds(sc.bounds, v);
        freeCam.current = zoomAt(cam, v, { x: e.clientX - rect.left, y: e.clientY - rect.top }, factor, limits);
      }
      requestDraw();
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [requestDraw]);

  // HUD numbers: at most 4 updates a second, and only while shown.
  useEffect(() => {
    if (!showHud) return;
    const id = setInterval(() => {
      const s = summarize(frames.current.values());
      const d = summarize(draws.current.values());
      if (s.fps === 0) return;
      setHudText(`${s.fps.toFixed(0)} fps  ${f1(s.meanMs)} ms  p95 ${f1(s.p95Ms)}  max ${f1(s.maxMs)}  >20ms ${s.over20}\ndraw p95 ${f1(d.p95Ms)} ms`);
    }, HUD_MS);
    return () => clearInterval(id);
  }, [showHud]);

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
    const cam = freeCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
    freeCam.current = panBy(cam, vp.current, pan[0], pan[1]);
    requestDraw();
  };

  /** A press and release with < CLICK_PX movement seeks to the nearest lap-line point within MAP_HIT_PX. */
  const seekAt = (e: PointerEvent<HTMLDivElement>) => {
    const cam = shownCam.current;
    const v = vp.current;
    const root = rootRef.current;
    if (!cam || !root || v.w <= 0) return;
    const rect = root.getBoundingClientRect();
    const w = screenToWorld(cam, v, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const maxD = MAP_HIT_PX / (v.w / cam.widthM);
    const lap = sceneRef.current.lap;
    let best = -1, bestD2 = maxD * maxD;
    for (let i = 0; i < lap.x.length; i++) {
      const dx = lap.x[i] - w.x, dy = lap.y[i] - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { bestD2 = d2; best = i; }
    }
    if (best < 0) return;
    const c = cmpRef.current;
    store.seek(timeAtDistance(c.lap.t, c.distance, best));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && e.pointerId === d.id && d.total < CLICK_PX) seekAt(e);
    endDrag(e);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const fit = () => {
    modeRef.current = "free";
    setModeState("free");
    freeCam.current = fitBounds(sceneRef.current.bounds, vp.current);
    requestDraw();
  };

  const toggleHeadingUp = () => {
    const next = !headingUpRef.current;
    headingUpRef.current = next;
    resetHeading.current = true;
    setHeadingUpState(next);
    requestDraw();
  };

  const selectKind = (v: string) => {
    const next = KINDS.find((k) => k.id === v);
    if (!next || next.id === kind) return;
    setKind(next.id);
    saveKind(next.id);
  };

  const selectSync = (v: string) => {
    if (v !== "time" && v !== "distance") return;
    syncRef.current = v;
    setSyncState(v);
    requestDraw();
  };

  const makeControl = (): BenchControl => ({
    viewport: () => vp.current,
    fitCamera: () => fitBounds(sceneRef.current.bounds, vp.current),
    lapLength: () => sceneRef.current.ref.x.length,
    refPoint: (d) => pointAt(sceneRef.current.ref, d),
    lapTimeAtDistance: (d) => timeAtDistance(cmpRef.current.lap.t, cmpRef.current.distance, d),
    seek: (tau) => store.seek(tau),
    play: () => store.play(),
    pause: () => store.pause(),
    setMode: (m) => applyMode(m),
    setCamera: (c) => {
      freeCam.current = c;
      requestDraw();
    },
    snapshot: () => ({ playing: store.get().playing, tau: store.get().tau, mode: modeRef.current, camera: shownCam.current }),
    restore: (s) => {
      if (s.camera) freeCam.current = s.camera;
      applyMode(s.mode);
      store.seek(s.tau);
      if (s.playing) store.play();
      else store.pause();
      requestDraw();
    },
    recordDraws: (on) => {
      drawRec.current = on ? [] : null;
    },
    drawTimes: () => drawRec.current ?? [],
  });

  const startBench = async () => {
    if (benchRunning.current) return;
    benchRunning.current = true;
    setRunning(true);
    setPanel({ ...vp.current });
    const ac = new AbortController();
    abort.current = ac;
    const ctl = makeControl();
    const hadHeadingUp = headingUpRef.current;
    headingUpRef.current = false;
    try {
      const out = await runBench(kind, ctl, ac.signal);
      setRows((prev) => [...prev, ...out]);
    } finally {
      headingUpRef.current = hadHeadingUp;
      resetHeading.current = true;
      benchRunning.current = false;
      setRunning(false);
    }
  };

  const markdown = benchMarkdown(rows, { panel });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      const ta = reportRef.current;
      if (!ta) return;
      ta.select();
      document.execCommand("copy");
    }
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div ref={hostRef} className={styles.host} aria-hidden="true" />
      <div className={styles.badges}>
        {annotations.map((a) => (
          <AnnotationHoverCard key={a.findingId} annotation={a}>
            <button
              type="button"
              data-annotation-badge=""
              aria-label={`${a.finding.corner} ${a.label} ${a.finding.kind}`}
              className={styles.badge}
              style={{ background: a.color }}
              ref={(el) => {
                if (el) badgeEls.current.set(a.findingId, el);
                else badgeEls.current.delete(a.findingId);
              }}
              onClick={() => handlers.onSeek(a)}
            >
              {a.label}
            </button>
          </AnnotationHoverCard>
        ))}
      </div>
      <div className={styles.side} data-controls="">
        <div className={styles.bar}>
          <span className={styles.tag}>experimental</span>
          <ToggleGroup.Root
            type="single" aria-label="Renderer" className={styles.group} value={kind} disabled={running}
            onValueChange={selectKind}
          >
            {KINDS.map((k) => (
              <ToggleGroup.Item key={k.id} value={k.id} className={ui.toggleItem}>{k.label}</ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
          <ToggleGroup.Root
            type="single" aria-label="Camera mode" className={styles.group} value={mode} disabled={running}
            onValueChange={(v) => v && applyMode(v as CameraMode)}
          >
            <ToggleGroup.Item value="follow" className={ui.toggleItem}>Follow</ToggleGroup.Item>
            <ToggleGroup.Item value="free" className={ui.toggleItem}>Free</ToggleGroup.Item>
          </ToggleGroup.Root>
          <button
            type="button" className={cx(ui.btn, styles.small)} aria-pressed={headingUp}
            disabled={running || mode !== "follow"} onClick={toggleHeadingUp}
          >
            Heading-up
          </button>
          <button type="button" className={cx(ui.btn, styles.small)} disabled={running} onClick={fit}>Fit</button>
          <button
            type="button" className={cx(ui.btn, styles.small)} aria-pressed={showHud}
            onClick={() => setShowHud((v) => !v)}
          >
            HUD
          </button>
          <button type="button" className={cx(ui.btn, styles.small)} disabled={running} onClick={startBench}>
            {running ? "Running (30 s)" : "Run benchmark"}
          </button>
        </div>
        <div className={styles.bar}>
          <span className={styles.tag}>Line</span>
          <ToggleGroup.Root
            type="single" aria-label="Line source" className={styles.group} value={source} disabled={running}
            onValueChange={(v) => v && setSource(v as LineSource)}
          >
            <ToggleGroup.Item value="shared" className={ui.toggleItem}>Shared</ToggleGroup.Item>
            <ToggleGroup.Item value="gps" className={ui.toggleItem}>GPS</ToggleGroup.Item>
            <ToggleGroup.Item value="lateral" className={ui.toggleItem}>Lateral</ToggleGroup.Item>
          </ToggleGroup.Root>
          {source === "gps" && (
            <select
              aria-label="GPS smoothing" className={styles.select} value={gpsHalf} disabled={running}
              onChange={(e) => setGpsHalf(Number(e.target.value))}
            >
              {[0, 2, 4, 8].map((h) => <option key={h} value={h}>{`\u00b1${h} m`}</option>)}
            </select>
          )}
          <span className={styles.tag}>Cars</span>
          <ToggleGroup.Root
            type="single" aria-label="Car sync" className={styles.group} value={sync} disabled={running}
            onValueChange={selectSync}
          >
            <ToggleGroup.Item value="time" className={ui.toggleItem}>Time</ToggleGroup.Item>
            <ToggleGroup.Item value="distance" className={ui.toggleItem}>Distance</ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        {showHud && hudText && <div className={styles.hud}>{hudText}</div>}
        {rows.length > 0 && (
          <div className={styles.results}>
            <textarea ref={reportRef} readOnly rows={Math.min(rows.length + 6, 14)} value={markdown} aria-label="Benchmark results" />
            <div className={styles.bar}>
              <button type="button" className={cx(ui.btn, styles.small)} onClick={copy}>Copy as Markdown</button>
              <button type="button" className={cx(ui.btn, ui.btnMuted, styles.small)} disabled={running} onClick={() => setRows([])}>Clear</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

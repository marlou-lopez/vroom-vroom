import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FOLLOW_WIDTH_M, fitBounds, followCamera, northUp, panBy, smoothHeading, worldToScreen, zoomAt,
  type Camera, type Viewport,
} from "../../../lib/camera";
import { cx } from "../../../lib/cx";
import { debugEnabled } from "../../../lib/debugFlag";
import { pointAt } from "../../../lib/geo";
import { distanceAtTime, timeAtDistance } from "../../../lib/playback";
import { usePlaybackStore } from "../../../state/playback";
import ui from "../../ui.module.css";
import type { TrackViewProps } from "../types";
import type { BenchControl, CameraMode } from "./bench";
import { GAIN_STYLES, loadRenderer, type GainStyle, type Renderer } from "./renderer";
import { buildScene, carPositions, type CarSync, type EdgeSource, type LineSource } from "./scene";
import { AnnotationBadges } from "../shared/AnnotationBadges";
import { loadFlag, loadSetting, saveFlag, saveSetting } from "../shared/storage";
import styles from "./DetailedMapView.module.css";
import { useBenchHud } from "./useBenchHud";
import { useMapGestures } from "./useMapGestures";

const HEADING_ALPHA = 0.2;
const HEADING_JUMP_M = 50;
/** Draws closer together than this are not frame intervals (a second draw within the same frame). */
const MIN_INTERVAL_MS = 4;
const BADGE_OFFSET_PX = 12;
const BADGE_STACK_PX = 14;
/** A lost context not restored within this long offers a Retry button. */
const RESTORE_WAIT_MS = 3000;

type GpuState = "ok" | "lost" | "stuck" | "failed";

/** Whether the line ahead of each car is shown (#48). */
const LINE_AHEAD_KEY = "vroom.lineAhead";
/** How gain/loss is shown (#59): off, beside the track, or on the track surface. */
const GAIN_LOSS_KEY = "vroom.gainLoss";

/** The remembered gain/loss style; default "side". An older "0" (toggle off) reads as "off". */
const loadGainStyle = (): GainStyle => loadSetting(GAIN_LOSS_KEY, GAIN_STYLES, "side", { legacy: { "0": "off" } });

/** Where the track edges come from (#36, experimental); default "stand-in". */
const EDGES_KEY = "vroom.edges";

const EDGE_SOURCES: readonly EdgeSource[] = ["stand-in", "telemetry"];
const loadEdgeSource = (): EdgeSource => loadSetting(EDGES_KEY, EDGE_SOURCES, "stand-in");

export function DetailedMapView({ model, geometry, annotations, handlers }: TrackViewProps) {
  const store = usePlaybackStore();
  const debug = debugEnabled(import.meta.env.DEV, location.search);
  const { cmp } = model;
  const [source, setSource] = useState<LineSource>("lateral");
  const [sync, setSyncState] = useState<CarSync>("time");
  const [gpsHalf, setGpsHalf] = useState(4);
  const [edgeSource, setEdgeSourceState] = useState<EdgeSource>(loadEdgeSource);
  const scene = useMemo(() => buildScene(cmp, { source, gpsHalf, edges: edgeSource, survey: geometry?.survey }), [cmp, geometry, source, gpsHalf, edgeSource]);

  const [epoch, setEpoch] = useState(0);
  const [gpu, setGpu] = useState<GpuState>("ok");
  const [mode, setModeState] = useState<CameraMode>("follow");
  const [headingUp, setHeadingUpState] = useState(false);
  /** Whether the free camera is turned (kept from heading-up); enables North-up (#60). */
  const [freeRotated, setFreeRotated] = useState(false);
  const [lineAhead, setLineAheadState] = useState(() => loadFlag(LINE_AHEAD_KEY));
  const [gainStyle, setGainStyleState] = useState(loadGainStyle);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const lostRef = useRef(false);
  const lostTimer = useRef(0);
  const sceneRef = useRef(scene);
  const cmpRef = useRef(cmp);
  const annRef = useRef(annotations);
  const modeRef = useRef<CameraMode>("follow");
  const syncRef = useRef<CarSync>("time");
  const headingUpRef = useRef(false);
  const lineAheadRef = useRef(lineAhead);
  const gainStyleRef = useRef(gainStyle);
  const smoothedHeading = useRef(0);
  const resetHeading = useRef(true);
  const lastDist = useRef(0);
  const freeCam = useRef<Camera | null>(null);
  const shownCam = useRef<Camera | null>(null);
  const followW = useRef(FOLLOW_WIDTH_M);
  const vp = useRef<Viewport>({ w: 0, h: 0 });
  const raf = useRef(0);
  const lastDrawT = useRef(0);
  const badgeEls = useRef(new Map<string, HTMLButtonElement>());

  const {
    showHud, setShowHud, hudText, running, rows, clearRows, markdown, copy, startBench, reportRef,
    frames, draws, drawRec, benchRunning,
  } = useBenchHud({ debug, viewport: () => vp.current, makeControl, onRunStart: suspendHeadingUp });

  const drawFrame = useCallback((now: number) => {
    raf.current = 0;
    const r = rendererRef.current;
    const v = vp.current;
    if (!r || lostRef.current || v.w <= 0 || v.h <= 0) return;
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
    r.draw({ camera: cam, viewport: v, lapCar: cars.lap, refCar: cars.ref, lapHeading: cars.heading, refHeading: cars.refHeading, lapDist: cars.dLap, refDist: cars.dRef });
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
  }, [store, frames, draws, drawRec, benchRunning]);

  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);

  /** Sets the free camera where its rotation may change; pan and zoom keep the rotation and write the ref directly. */
  const setFreeCam = useCallback((c: Camera) => {
    freeCam.current = c;
    setFreeRotated(c.rotation !== 0);
  }, []);

  const applyMode = useCallback((next: CameraMode) => {
    if (next === modeRef.current) return;
    // Leaving follow keeps the picture where it is, rotation included; North-up undoes the rotation.
    if (next === "free") setFreeCam(shownCam.current ?? fitBounds(sceneRef.current.bounds, vp.current));
    if (next === "follow") resetHeading.current = true;
    modeRef.current = next;
    setModeState(next);
    requestDraw();
  }, [requestDraw, setFreeCam]);

  const zoomBy = useCallback((factor: number, anchor: { x: number; y: number }, limits: { minM: number; maxM: number }) => {
    if (modeRef.current === "follow") {
      followW.current = Math.min(Math.max(followW.current * factor, limits.minM), limits.maxM);
    } else {
      const cam = freeCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
      freeCam.current = zoomAt(cam, vp.current, anchor, factor, limits);
    }
    requestDraw();
  }, [requestDraw]);

  const panFree = useCallback((dx: number, dy: number) => {
    const cam = freeCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
    freeCam.current = panBy(cam, vp.current, dx, dy);
    requestDraw();
  }, [requestDraw]);

  const gestures = useMapGestures({
    rootRef, vp, sceneRef, cmpRef, modeRef, shownCam, benchRunning, store, applyMode, zoomBy, panFree,
  });

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
    window.clearTimeout(lostTimer.current);
  }, []);

  // Renderer lifecycle. The promise can resolve after an unmount or a new epoch; a late renderer is destroyed.
  // A lost context stops drawing; a restore (or Retry) bumps the epoch, which builds a fresh renderer.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ac = new AbortController();
    const events = {
      onContextLost: () => {
        if (ac.signal.aborted) return;
        lostRef.current = true;
        setGpu("lost");
        window.clearTimeout(lostTimer.current);
        lostTimer.current = window.setTimeout(() => setGpu("stuck"), RESTORE_WAIT_MS);
      },
      onContextRestored: () => {
        if (ac.signal.aborted) return;
        window.clearTimeout(lostTimer.current);
        setEpoch((e) => e + 1);
      },
    };
    const ready = loadRenderer(host, events).then((r) => {
      if (ac.signal.aborted) {
        r.destroy();
        return null;
      }
      rendererRef.current = r;
      lostRef.current = false;
      setGpu("ok");
      r.setScene(sceneRef.current);
      r.setAheadVisible(lineAheadRef.current);
      r.setGainStyle(gainStyleRef.current);
      r.setEdgeDebug(debug);
      r.resize(vp.current, window.devicePixelRatio || 1);
      requestDraw();
      return r;
    }, (err) => {
      console.error("renderer failed", err);
      if (!ac.signal.aborted) setGpu("failed");
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
  }, [epoch, requestDraw, debug]);

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

  // The flag is fixed per page load; the renderer also gets it when it is created.
  useEffect(() => {
    rendererRef.current?.setEdgeDebug(debug);
    requestDraw();
  }, [debug, requestDraw]);

  const fit = () => {
    modeRef.current = "free";
    setModeState("free");
    setFreeCam(fitBounds(sceneRef.current.bounds, vp.current));
    requestDraw();
  };

  /** Free mode: turn the map north-up, keeping the place and zoom on screen. */
  const resetNorthUp = () => {
    const cam = freeCam.current;
    if (!cam) return;
    setFreeCam(northUp(cam));
    requestDraw();
  };

  const toggleLineAhead = () => {
    const next = !lineAheadRef.current;
    lineAheadRef.current = next;
    setLineAheadState(next);
    saveFlag(LINE_AHEAD_KEY, next);
    rendererRef.current?.setAheadVisible(next);
    requestDraw();
  };

  const selectGainStyle = (v: string) => {
    if (!GAIN_STYLES.includes(v as GainStyle)) return;
    const next = v as GainStyle;
    gainStyleRef.current = next;
    setGainStyleState(next);
    saveSetting(GAIN_LOSS_KEY, next);
    rendererRef.current?.setGainStyle(next);
    requestDraw();
  };

  const toggleHeadingUp = () => {
    const next = !headingUpRef.current;
    headingUpRef.current = next;
    resetHeading.current = true;
    setHeadingUpState(next);
    requestDraw();
  };

  const loseContext = () => {
    if (!rendererRef.current?.simulateContextLoss()) console.warn("WEBGL_lose_context is not available");
  };

  const selectSync = (v: string) => {
    if (v !== "time" && v !== "distance") return;
    syncRef.current = v;
    setSyncState(v);
    requestDraw();
  };

  /** Hoisted: the bench hook is created before the camera functions this reads. */
  function makeControl(): Omit<BenchControl, "recordDraws" | "drawTimes"> {
    return {
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
        setFreeCam(c);
        requestDraw();
      },
      snapshot: () => ({ playing: store.get().playing, tau: store.get().tau, mode: modeRef.current, camera: shownCam.current }),
      restore: (s) => {
        if (s.camera) setFreeCam(s.camera);
        applyMode(s.mode);
        store.seek(s.tau);
        if (s.playing) store.play();
        else store.pause();
        requestDraw();
      },
    };
  }

  /** Heading-up is off during a benchmark run; the returned function puts it back. */
  function suspendHeadingUp() {
    const had = headingUpRef.current;
    headingUpRef.current = false;
    return () => {
      headingUpRef.current = had;
      resetHeading.current = true;
    };
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-dragging={gestures.dragging}
      {...gestures.handlers}
    >
      <div ref={hostRef} className={styles.host} aria-hidden="true" />
      <AnnotationBadges annotations={annotations} handlers={handlers} badgeEls={badgeEls} />
      {gpu !== "ok" && (
        <div className={styles.gpu} data-controls="" role="status">
          <span>
            {gpu === "failed"
              ? "The detailed view could not start (WebGL unavailable, or its code failed to load). Retry, or switch to the classic 2D view."
              : "Graphics reset — restoring…"}
          </span>
          {(gpu === "stuck" || gpu === "failed") && (
            <button type="button" className={cx(ui.btn, styles.small)} onClick={() => { setGpu("lost"); setEpoch((e) => e + 1); }}>Retry</button>
          )}
        </div>
      )}
      <div className={styles.side} data-controls="">
        <div className={styles.bar}>
          <ToggleGroup.Root
            type="single" aria-label="Camera mode" className={styles.group} value={mode} disabled={running}
            onValueChange={(v) => v && applyMode(v as CameraMode)}
          >
            <ToggleGroup.Item value="follow" className={ui.toggleItem}>Follow</ToggleGroup.Item>
            <ToggleGroup.Item value="free" className={ui.toggleItem}>Free</ToggleGroup.Item>
          </ToggleGroup.Root>
          {mode === "follow" ? (
            <button
              type="button" className={cx(ui.btn, styles.small)} aria-pressed={headingUp}
              disabled={running} onClick={toggleHeadingUp}
            >
              Heading-up
            </button>
          ) : (
            <button
              type="button" className={cx(ui.btn, styles.small)} title="Turn the map north-up, keeping the place and zoom"
              disabled={running || !freeRotated} onClick={resetNorthUp}
            >
              North-up
            </button>
          )}
          <button
            type="button" className={cx(ui.btn, styles.small)} aria-pressed={lineAhead}
            title="Show the part of each line the car has not reached yet" disabled={running} onClick={toggleLineAhead}
          >
            Line ahead
          </button>
          <span className={styles.tag} title="Green where you gain time on the comparison lap, red where you lose it">Gain/loss</span>
          <ToggleGroup.Root
            type="single" aria-label="Gain/loss" className={styles.group} value={gainStyle} disabled={running}
            onValueChange={selectGainStyle}
          >
            <ToggleGroup.Item value="off" className={ui.toggleItem}>Off</ToggleGroup.Item>
            <ToggleGroup.Item value="side" className={ui.toggleItem} title="A line left of the track">Beside</ToggleGroup.Item>
            <ToggleGroup.Item value="track" className={ui.toggleItem} title="Experimental: the whole track width">Track</ToggleGroup.Item>
          </ToggleGroup.Root>
          <span className={styles.tag} title="Experimental: track edges and kerbs from a survey of the track or, without one, rebuilt from the laps' telemetry">Edges</span>
          <ToggleGroup.Root
            type="single" aria-label="Track edges" className={styles.group} value={edgeSource} disabled={running}
            onValueChange={(v) => {
              if (v !== "stand-in" && v !== "telemetry") return;
              setEdgeSourceState(v);
              saveSetting(EDGES_KEY, v);
            }}
          >
            <ToggleGroup.Item value="stand-in" className={ui.toggleItem} title="The centreline plus and minus 7 m">Stand-in</ToggleGroup.Item>
            <ToggleGroup.Item value="telemetry" className={ui.toggleItem} title={geometry?.survey ? "Edges and kerbs from a survey of the track (shared-memory capture)" : "Edges and kerbs from the laps' telemetry"}>{geometry?.survey ? "Survey" : "Telemetry"}</ToggleGroup.Item>
          </ToggleGroup.Root>
          <span className={styles.tag}>experimental</span>
          <button type="button" className={cx(ui.btn, styles.small)} disabled={running} onClick={fit}>Fit</button>
          {debug && (
            <>
              <button
                type="button" className={cx(ui.btn, styles.small)} aria-pressed={showHud}
                onClick={() => setShowHud((v) => !v)}
              >
                HUD
              </button>
              <button type="button" className={cx(ui.btn, styles.small)} disabled={running} onClick={startBench}>
                {running ? "Running (30 s)" : "Run benchmark"}
              </button>
              <button type="button" className={cx(ui.btn, styles.small)} disabled={running || gpu !== "ok"} onClick={loseContext}>
                Lose GPU context
              </button>
            </>
          )}
        </div>
        <div className={styles.bar}>
          {debug && (
            <>
              <span className={styles.tag}>Line</span>
              <ToggleGroup.Root
                type="single" aria-label="Line source" className={styles.group} value={source} disabled={running}
                onValueChange={(v) => v && setSource(v as LineSource)}
              >
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
            </>
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
        {debug && showHud && hudText && <div className={styles.hud}>{hudText}</div>}
        {debug && rows.length > 0 && (
          <div className={styles.results}>
            <textarea ref={reportRef} readOnly rows={Math.min(rows.length + 6, 14)} value={markdown} aria-label="Benchmark results" />
            <div className={styles.bar}>
              <button type="button" className={cx(ui.btn, styles.small)} onClick={copy}>Copy as Markdown</button>
              <button type="button" className={cx(ui.btn, ui.btnMuted, styles.small)} disabled={running} onClick={clearRows}>Clear</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

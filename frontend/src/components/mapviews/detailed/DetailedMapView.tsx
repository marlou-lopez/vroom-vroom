import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FOLLOW_WIDTH_M, fitBounds, followCamera, northUp, panBy, smoothHeading, worldToScreen, zoomAt,
  type Camera,
} from "../../../lib/camera";
import { cx } from "../../../lib/cx";
import { debugEnabled } from "../../../lib/debugFlag";
import { pointAt } from "../../../lib/geo";
import { scaleBar, scaleLabel } from "../../../lib/scaleBar";
import { nextCorner, readoutCorner } from "../../../lib/trackmap";
import { CORNER_LEAD_M } from "../../../lib/annotations";
import { distanceAtTime, timeAtDistance } from "../../../lib/playback";
import { usePlaybackStore } from "../../../state/playback";
import ui from "../../ui.module.css";
import type { TrackViewProps } from "../types";
import { runBench, type BenchControl, type CameraMode } from "./bench";
import { GAIN_STYLES, loadRenderer, type GainStyle } from "./renderer";
import { buildScene, carPositions, type CarSync, type EdgeSource, type LineSource } from "./scene";
import { AnnotationBadges } from "../shared/AnnotationBadges";
import { ExperimentalTag, OptionRow, ViewOptions } from "../shared/ViewOptions";
import { loadFlag, loadSetting, saveFlag, saveSetting } from "../shared/storage";
import { AerialCredit } from "../shared/AerialCredit";
import { loadEdgeSource, saveEdgeSource } from "../shared/edgeSetting";
import styles from "./DetailedMapView.module.css";
import { useBenchHud } from "../shared/useBenchHud";
import { useGpuRenderer } from "../shared/useGpuRenderer";
import { useMapGestures } from "./useMapGestures";

const HEADING_ALPHA = 0.2;
const HEADING_JUMP_M = 50;
/** Draws closer together than this are not frame intervals (a second draw within the same frame). */
const MIN_INTERVAL_MS = 4;
const BADGE_OFFSET_PX = 12;
const BADGE_STACK_PX = 14;

/** Whether the line ahead of each car is shown (#48). */
const LINE_AHEAD_KEY = "vroom.lineAhead";
/** How gain/loss is shown (#59): off, beside the track, or on the track surface. */
const GAIN_LOSS_KEY = "vroom.gainLoss";

/** The remembered gain/loss style; default "side". An older "0" (toggle off) reads as "off". */
const loadGainStyle = (): GainStyle => loadSetting(GAIN_LOSS_KEY, GAIN_STYLES, "side", { legacy: { "0": "off" } });

export function DetailedMapView({ model, trackMap, geometry, annotations, handlers, lapValid, invalidAtM }: TrackViewProps) {
  const store = usePlaybackStore();
  const debug = debugEnabled(import.meta.env.DEV, location.search);
  const { cmp } = model;
  const [source, setSource] = useState<LineSource>("lateral");
  const [sync, setSyncState] = useState<CarSync>("time");
  const [gpsHalf, setGpsHalf] = useState(4);
  const [edgeSource, setEdgeSourceState] = useState<EdgeSource>(loadEdgeSource);
  const scene = useMemo(() => buildScene(cmp, { source, gpsHalf, edges: edgeSource, survey: geometry?.survey, aerial: geometry?.aerial, lapValid }), [cmp, geometry, source, gpsHalf, edgeSource, lapValid]);

  /** A remembered "aerial" on a track without it draws, and shows as, the measured edges. */
  const shownEdges: EdgeSource = edgeSource === "aerial" && !geometry?.aerial ? "telemetry" : edgeSource;

  const [mode, setModeState] = useState<CameraMode>("follow");
  const [headingUp, setHeadingUpState] = useState(false);
  /** Whether the free camera is turned (kept from heading-up); enables North-up (#60). */
  const [freeRotated, setFreeRotated] = useState(false);
  const [lineAhead, setLineAheadState] = useState(() => loadFlag(LINE_AHEAD_KEY));
  const [gainStyle, setGainStyleState] = useState(loadGainStyle);

  const rootRef = useRef<HTMLDivElement>(null);
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
  const raf = useRef(0);
  const lastDrawT = useRef(0);
  const badgeEls = useRef(new Map<string, HTMLButtonElement>());
  const invalidEl = useRef<HTMLButtonElement | null>(null);
  const invalidRef = useRef(invalidAtM ?? null);
  const scaleBarEl = useRef<HTMLSpanElement>(null), scaleTextEl = useRef<HTMLSpanElement>(null), cornerEl = useRef<HTMLDivElement>(null);
  const trackMapRef = useRef(trackMap);
  const shownCorner = useRef("");

  const { hostRef, rendererRef, lostRef, vp, requestDrawRef, gpu, retry } = useGpuRenderer({
    load: loadRenderer,
    onReady: (r) => {
      r.setScene(sceneRef.current);
      r.setAheadVisible(lineAheadRef.current);
      r.setGainStyle(gainStyleRef.current);
      r.setEdgeDebug(debug);
    },
    failLabel: "renderer failed",
  });

  const {
    showHud, setShowHud, hudText, running, rows, clearRows, markdown, copy, startBench, reportRef,
    frames, draws, drawRec, benchRunning,
  } = useBenchHud({ debug, viewport: () => vp.current, makeControl, run: runBench, onRunStart: suspendHeadingUp });

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

    // Scale bar and the corner the lap car is in or approaching (DOM written directly: no React render per frame).
    const sb = scaleBar(v.w / cam.widthM);
    if (scaleBarEl.current) scaleBarEl.current.style.width = `${sb.px.toFixed(1)}px`;
    if (scaleTextEl.current) scaleTextEl.current.textContent = scaleLabel(sb.metres);
    const tm = trackMapRef.current;
    const lead = tm ? readoutCorner(tm, cars.dLap, store.get().leadInCornerId, CORNER_LEAD_M) : null;
    const nc = lead?.approaching
      ? { corner: lead.corner, inside: false, aheadM: (((lead.corner.start_m - cars.dLap) % tm!.length_m) + tm!.length_m) % tm!.length_m }
      : tm ? nextCorner(tm, cars.dLap) : null;
    const label = nc ? (nc.inside ? nc.corner.name : `${nc.corner.name} in ${Math.max(10, Math.round(nc.aheadM / 10) * 10)} m`) : "";
    if (cornerEl.current && label !== shownCorner.current) {
      shownCorner.current = label;
      cornerEl.current.textContent = label;
      cornerEl.current.hidden = !label;
    }
    for (const a of annRef.current) {
      const el = badgeEls.current.get(a.findingId);
      if (!el) continue;
      const s = worldToScreen(cam, v, pointAt(sc.ref, a.apexM));
      const y = s.y - (BADGE_OFFSET_PX + a.stack * BADGE_STACK_PX);
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = s.x < -10 || s.x > v.w + 10 || y < -10 || y > v.h + 10 ? "hidden" : "visible";
    }
    const ie = invalidEl.current;
    if (ie && invalidRef.current != null) {
      const s = worldToScreen(cam, v, pointAt(sc.lap, invalidRef.current));
      ie.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      ie.style.visibility = s.x < -10 || s.x > v.w + 10 || s.y < -10 || s.y > v.h + 10 ? "hidden" : "visible";
    }
  }, [store, vp, lostRef, rendererRef, frames, draws, drawRec, benchRunning]);

  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);
  useLayoutEffect(() => {
    requestDrawRef.current = requestDraw;
  }, [requestDrawRef, requestDraw]);
  useLayoutEffect(() => { trackMapRef.current = trackMap; requestDraw(); }, [trackMap, requestDraw]);
  useLayoutEffect(() => { invalidRef.current = invalidAtM ?? null; requestDraw(); }, [invalidAtM, requestDraw]);

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
  }, [requestDraw, setFreeCam, vp]);

  const zoomBy = useCallback((factor: number, anchor: { x: number; y: number }, limits: { minM: number; maxM: number }) => {
    if (modeRef.current === "follow") {
      followW.current = Math.min(Math.max(followW.current * factor, limits.minM), limits.maxM);
    } else {
      const cam = freeCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
      freeCam.current = zoomAt(cam, vp.current, anchor, factor, limits);
    }
    requestDraw();
  }, [requestDraw, vp]);

  const panFree = useCallback((dx: number, dy: number) => {
    const cam = freeCam.current ?? fitBounds(sceneRef.current.bounds, vp.current);
    freeCam.current = panBy(cam, vp.current, dx, dy);
    requestDraw();
  }, [requestDraw, vp]);

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
  }, [scene, rendererRef, requestDraw]);

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
  }, []);

  // The flag is fixed per page load; the renderer also gets it when it is created.
  useEffect(() => {
    rendererRef.current?.setEdgeDebug(debug);
    requestDraw();
  }, [debug, rendererRef, requestDraw]);

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
      <div className={styles.scale} aria-hidden="true">
        <div className={styles.corner} ref={cornerEl} data-testid="next-corner" hidden />
        <div className={styles.scaleRow}><span className={styles.scaleBar} ref={scaleBarEl} /><span ref={scaleTextEl} /></div>
      </div>
      <AnnotationBadges annotations={annotations} handlers={handlers} badgeEls={badgeEls} invalidAtM={invalidAtM} invalidEl={invalidEl} />
      {gpu !== "ok" && (
        <div className={styles.gpu} data-controls="" role="status">
          <span>
            {gpu === "failed"
              ? "The detailed view could not start (WebGL unavailable, or its code failed to load). Retry, or switch to the classic 2D view."
              : "Graphics reset — restoring…"}
          </span>
          {(gpu === "stuck" || gpu === "failed") && (
            <button type="button" className={cx(ui.btn, styles.small)} onClick={retry}>Retry</button>
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
          <button type="button" className={cx(ui.btn, styles.small)} disabled={running} onClick={fit}>Fit</button>
          <ExperimentalTag />
          <ViewOptions disabled={running}>
            <OptionRow label="Line ahead" hint="Show the part of each line the car has not reached yet.">
              <button
                type="button" className={cx(ui.btn, styles.small)} aria-pressed={lineAhead}
                disabled={running} onClick={toggleLineAhead}
              >
                {lineAhead ? "On" : "Off"}
              </button>
            </OptionRow>
            <OptionRow label="Gain/loss" hint="Green where you gain time on the comparison lap, red where you lose it.">
              <ToggleGroup.Root
                type="single" aria-label="Gain/loss" className={styles.group} value={gainStyle} disabled={running}
                onValueChange={selectGainStyle}
              >
                <ToggleGroup.Item value="off" className={ui.toggleItem}>Off</ToggleGroup.Item>
                <ToggleGroup.Item value="side" className={ui.toggleItem} title="A line left of the track">Side line</ToggleGroup.Item>
                <ToggleGroup.Item value="track" className={ui.toggleItem} title="Colours the whole track width">On track</ToggleGroup.Item>
              </ToggleGroup.Root>
            </OptionRow>
            <OptionRow
              label="Track edges"
              hint={geometry?.survey
                ? "Estimated: the track centreline plus and minus 7 m. Measured: edges and kerbs from a survey of the track."
                : "Estimated: the track centreline plus and minus 7 m. From laps: edges and kerbs rebuilt from the laps' telemetry."}
            >
              <ToggleGroup.Root
                type="single" aria-label="Track edges" className={styles.group} value={shownEdges} disabled={running}
                onValueChange={(v) => {
                  if (v !== "stand-in" && v !== "telemetry" && v !== "aerial") return;
                  setEdgeSourceState(v);
                  saveEdgeSource(v);
                }}
              >
                <ToggleGroup.Item value="stand-in" className={ui.toggleItem} title="The racing line plus and minus 7 m">Estimated</ToggleGroup.Item>
                <ToggleGroup.Item value="telemetry" className={ui.toggleItem} title={geometry?.survey ? "Edges and kerbs from a survey of the track" : "Edges and kerbs rebuilt from the laps' telemetry"}>{geometry?.survey ? "Measured" : "From laps"}</ToggleGroup.Item>
                {geometry?.aerial && <ToggleGroup.Item value="aerial" className={ui.toggleItem} title="Experimental: edges and kerbs read from open aerial photos">Aerial (experimental)</ToggleGroup.Item>}
              </ToggleGroup.Root>
            </OptionRow>
            <OptionRow label="Cars" hint="Time: both cars at the same moment. Distance: both cars at the same point of the track.">
              <ToggleGroup.Root
                type="single" aria-label="Car sync" className={styles.group} value={sync} disabled={running}
                onValueChange={selectSync}
              >
                <ToggleGroup.Item value="time" className={ui.toggleItem}>Time</ToggleGroup.Item>
                <ToggleGroup.Item value="distance" className={ui.toggleItem}>Distance</ToggleGroup.Item>
              </ToggleGroup.Root>
            </OptionRow>
          </ViewOptions>
        </div>
        {debug && (
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
        )}
        {scene.edgeSource === "aerial" && geometry?.aerial && <AerialCredit aerial={geometry.aerial} className={styles.credit} />}
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

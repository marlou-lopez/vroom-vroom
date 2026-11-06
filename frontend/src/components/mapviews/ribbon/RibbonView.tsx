import * as Slider from "@radix-ui/react-slider";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Viewport } from "../../../lib/camera";
import { cx } from "../../../lib/cx";
import { debugEnabled } from "../../../lib/debugFlag";
import { attitudeAt, estimateAttitude } from "../../../lib/carAttitude";
import { pointAt } from "../../../lib/geo";
import { summarize } from "../../../lib/perf";
import { timeAtDistance } from "../../../lib/playback";
import { usePlaybackStore } from "../../../state/playback";
import ui from "../../ui.module.css";
import { benchMarkdown, type BenchRow } from "../detailed/bench";
import { buildScene, carPositions, type CarSync } from "../detailed/scene";
import { AnnotationBadges } from "../shared/AnnotationBadges";
import { Ring } from "../shared/ring";
import { loadString, saveString } from "../shared/storage";
import type { TrackViewProps } from "../types";
import { runRibbonBench, type RibbonBenchControl } from "./bench";
import { VIEW_MODES, type ViewMode } from "./viewModes";
import { heightAt, roadHeights } from "./heights";
import { aheadPoint, carPose } from "./pose";
import { loadRibbonRenderer, type RibbonRenderer, type ScreenPoint } from "./types";
import styles from "./RibbonView.module.css";

/** The Car popover (Radix popover, the model store, the converter's client) loads with the 3D view, not with the app's main bundle. */
const CarModelControl = lazy(() => import("./CarModelControl").then((m) => ({ default: m.CarModelControl })));

const HUD_MS = 250;
const MIN_INTERVAL_MS = 4;
const JUMP_M = 50;
/** Metres ahead of the lap car the chase camera looks at. */
const LOOK_AHEAD_M = 30;
const BADGE_OFFSET_PX = 12;
const BADGE_STACK_PX = 14;
/** Badges float this far above the road so they clear the surface and the cars. */
const BADGE_LIFT_M = 3;
const RESTORE_WAIT_MS = 3000;

/**
 * Vertical exaggeration range. Default 1x: the true shape, where a car's pitch and the chase view read as the real road
 * (Raidillon is about 17 % at its steepest). Higher values help the orbit and top views, where 100 m of range over 7 km looks flat.
 */
export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 5;
export const EXAGGERATION_DEFAULT = 1;
const EXAGGERATION_KEY = "vroom.ribbonExaggeration";
const MODE_KEY = "vroom.ribbonCamera";

const MODE_LABEL: Record<ViewMode, string> = { chase: "Chase", cockpit: "Cockpit", orbit: "Orbit", top: "Top" };

function loadExaggeration(): number {
  const v = Number(loadString(EXAGGERATION_KEY));
  return Number.isFinite(v) && v >= EXAGGERATION_MIN && v <= EXAGGERATION_MAX ? v : EXAGGERATION_DEFAULT;
}

function loadMode(): ViewMode {
  const v = loadString(MODE_KEY);
  return VIEW_MODES.includes(v as ViewMode) ? (v as ViewMode) : "chase";
}

type GpuState = "ok" | "lost" | "stuck" | "failed";
const f1 = (v: number) => v.toFixed(1);

/** Experimental 3D view (#39): the track as a ribbon with elevation, both cars, and chase / cockpit (#100) / orbit / top-down cameras. */
export function RibbonView({ model, annotations, handlers }: TrackViewProps) {
  const store = usePlaybackStore();
  const debug = debugEnabled(import.meta.env.DEV, location.search);
  const { cmp } = model;
  const scene = useMemo(() => buildScene(cmp, { source: "lateral", gpsHalf: 4, edges: "telemetry" }), [cmp]);
  const { heights, hasElevation } = useMemo(() => {
    const h = roadHeights(cmp.elevation, scene.centre.x.length);
    return { heights: h ?? new Float64Array(scene.centre.x.length), hasElevation: h !== null };
  }, [cmp, scene]);

  // Heading, dive and roll of the lap car per grid metre, for the cockpit camera (estimated from GPS, heights and G forces).
  // The road's banking comes from the track survey when there is one (degrees there, radians in the estimate).
  const attitude = useMemo(
    () => estimateAttitude({
      line: scene.lap, heights, gLat: cmp.lap.g_lat, gLong: cmp.lap.g_long,
      bank: cmp.track_survey?.bank_deg.map((d) => (d === null ? null : (d * Math.PI) / 180)),
    }),
    [scene, heights, cmp],
  );

  const carEntries = useMemo(
    () => [{ carId: cmp.lap_car_id, name: cmp.lap_car_name }, { carId: cmp.ref_car_id, name: cmp.ref_car_name }],
    [cmp],
  );

  const [epoch, setEpoch] = useState(0);
  const [gpu, setGpu] = useState<GpuState>("ok");
  const [mode, setModeState] = useState<ViewMode>(loadMode);
  const [exag, setExagState] = useState(loadExaggeration);
  const [sync, setSyncState] = useState<CarSync>("time");
  const [showHud, setShowHud] = useState(true);
  const [hudText, setHudText] = useState("");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [panel, setPanel] = useState<Viewport | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<RibbonRenderer | null>(null);
  const lostRef = useRef(false);
  const lostTimer = useRef(0);
  const sceneRef = useRef(scene);
  const heightsRef = useRef(heights);
  const attitudeRef = useRef(attitude);
  const cmpRef = useRef(cmp);
  const annRef = useRef(annotations);
  const modeRef = useRef(mode);
  const exagRef = useRef(exag);
  const syncRef = useRef<CarSync>("time");
  const vp = useRef<Viewport>({ w: 0, h: 0 });
  const raf = useRef(0);
  const lastDist = useRef(0);
  const lastDrawT = useRef(0);
  const frames = useRef(new Ring());
  const draws = useRef(new Ring());
  const drawRec = useRef<number[] | null>(null);
  const benchRunning = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const badgeEls = useRef(new Map<string, HTMLButtonElement>());
  const screenPt = useRef<ScreenPoint>({ x: 0, y: 0, visible: false });

  const drawFrame = useCallback((now: number) => {
    raf.current = 0;
    const r = rendererRef.current;
    const v = vp.current;
    if (!r || lostRef.current || v.w <= 0 || v.h <= 0) return;
    const sc = sceneRef.current, h = heightsRef.current, k = exagRef.current;
    const tau = store.get().tau;
    const cars = carPositions(sc, cmpRef.current, tau, syncRef.current);
    const jumped = Math.abs(cars.dLap - lastDist.current) > JUMP_M;
    lastDist.current = cars.dLap;

    const t0 = performance.now();
    r.draw({
      lap: carPose(sc.lap, h, cars.dLap, cars.heading, k),
      ref: carPose(sc.ref, h, cars.dRef, cars.refHeading, k),
      lapDist: cars.dLap, refDist: cars.dRef,
      lapAtt: attitudeAt(attitudeRef.current, cars.dLap),
      ahead: aheadPoint(sc.lap, h, cars.dLap, LOOK_AHEAD_M),
      jumped, exaggeration: k,
    });
    const dt = performance.now() - t0;
    draws.current.push(dt);
    drawRec.current?.push(dt);

    if ((store.get().playing || benchRunning.current) && lastDrawT.current > 0 && now - lastDrawT.current < 100 && now - lastDrawT.current >= MIN_INTERVAL_MS) {
      frames.current.push(now - lastDrawT.current);
    }
    lastDrawT.current = now;

    const s = screenPt.current;
    for (const a of annRef.current) {
      const el = badgeEls.current.get(a.findingId);
      if (!el) continue;
      const p = pointAt(sc.ref, a.apexM);
      r.project(p.x, p.y, heightAt(h, a.apexM) + BADGE_LIFT_M / k, s);
      const y = s.y - (BADGE_OFFSET_PX + a.stack * BADGE_STACK_PX);
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = !s.visible || s.x < -10 || s.x > v.w + 10 || y < -10 || y > v.h + 10 ? "hidden" : "visible";
    }
  }, [store]);

  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);

  const applyMode = useCallback((next: ViewMode) => {
    modeRef.current = next;
    setModeState(next);
    rendererRef.current?.setMode(next);
    requestDraw();
  }, [requestDraw]);

  useEffect(() => {
    cmpRef.current = cmp;
    annRef.current = annotations;
    requestDraw();
  }, [cmp, annotations, requestDraw]);

  useEffect(() => {
    sceneRef.current = scene;
    heightsRef.current = heights;
    attitudeRef.current = attitude;
    rendererRef.current?.setScene({ scene, heights });
    requestDraw();
  }, [scene, heights, attitude, requestDraw]);

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
    window.clearTimeout(lostTimer.current);
  }, []);

  // Renderer lifecycle, as in the detailed view: a late renderer is destroyed; a lost context stops drawing and a
  // restore (or Retry) bumps the epoch, which builds a fresh renderer. A chunk that fails to load shows a message with Retry.
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
      onNeedsDraw: () => requestDraw(),
    };
    const ready = loadRibbonRenderer(host, events).then((r) => {
      if (ac.signal.aborted) {
        r.destroy();
        return null;
      }
      rendererRef.current = r;
      lostRef.current = false;
      setGpu("ok");
      r.setScene({ scene: sceneRef.current, heights: heightsRef.current });
      r.setMode(modeRef.current);
      r.resize(vp.current, window.devicePixelRatio || 1);
      requestDraw();
      return r;
    }, (err) => {
      console.error("3D renderer failed", err);
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
  }, [epoch, requestDraw]);

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

  // The chase and top cameras zoom with the wheel; in orbit mode the orbit controls take it. Wheel needs preventDefault, so it is attached by hand.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[data-controls]")) return;
      if (modeRef.current === "orbit") return;
      e.preventDefault();
      if (benchRunning.current) return;
      rendererRef.current?.zoom(Math.pow(1.0015, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      requestDraw();
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [requestDraw]);

  useEffect(() => {
    if (!debug || !showHud) return;
    const id = setInterval(() => {
      const s = summarize(frames.current.values());
      const d = summarize(draws.current.values());
      if (s.fps === 0) return;
      const st = rendererRef.current?.stats();
      setHudText(`${s.fps.toFixed(0)} fps  ${f1(s.meanMs)} ms  p95 ${f1(s.p95Ms)}  max ${f1(s.maxMs)}  >20ms ${s.over20}\ndraw p95 ${f1(d.p95Ms)} ms${st ? `  ${st.calls} calls  ${(st.triangles / 1000).toFixed(0)}k tris` : ""}`);
    }, HUD_MS);
    return () => clearInterval(id);
  }, [debug, showHud]);

  const selectMode = (v: string) => {
    if (!VIEW_MODES.includes(v as ViewMode)) return;
    saveString(MODE_KEY, v);
    applyMode(v as ViewMode);
  };

  const changeExaggeration = (v: number) => {
    exagRef.current = v;
    setExagState(v);
    requestDraw();
  };

  const selectSync = (v: string) => {
    if (v !== "time" && v !== "distance") return;
    syncRef.current = v;
    setSyncState(v);
    requestDraw();
  };

  const loseContext = () => {
    if (!rendererRef.current?.simulateContextLoss()) console.warn("WEBGL_lose_context is not available");
  };

  const makeControl = (): RibbonBenchControl => ({
    lapLength: () => sceneRef.current.ref.x.length,
    lapTimeAtDistance: (d) => timeAtDistance(cmpRef.current.lap.t, cmpRef.current.distance, d),
    seek: (tau) => store.seek(tau),
    play: () => store.play(),
    pause: () => store.pause(),
    setMode: (m) => applyMode(m),
    nudgeOrbit: (rad) => rendererRef.current?.nudgeOrbit(rad),
    snapshot: () => ({ playing: store.get().playing, tau: store.get().tau, mode: modeRef.current }),
    restore: (s) => {
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
    try {
      const out = await runRibbonBench(makeControl(), ac.signal);
      setRows((prev) => [...prev, ...out]);
    } finally {
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
    <div ref={rootRef} className={styles.root}>
      <div ref={hostRef} className={styles.host} aria-hidden="true" />
      <AnnotationBadges annotations={annotations} handlers={handlers} badgeEls={badgeEls} />
      {gpu !== "ok" && (
        <div className={styles.gpu} data-controls="" role="status">
          <span>{gpu === "failed" ? "The 3D view could not load." : "Graphics reset — restoring…"}</span>
          {(gpu === "stuck" || gpu === "failed") && (
            <button type="button" className={cx(ui.btn, styles.small)} onClick={() => { setGpu("lost"); setEpoch((e) => e + 1); }}>Retry</button>
          )}
        </div>
      )}
      <div className={styles.side} data-controls="">
        <div className={styles.bar}>
          <ToggleGroup.Root
            type="single" aria-label="Camera" className={styles.group} value={mode} disabled={running}
            onValueChange={selectMode}
          >
            {VIEW_MODES.map((m) => <ToggleGroup.Item key={m} value={m} className={ui.toggleItem}>{MODE_LABEL[m]}</ToggleGroup.Item>)}
          </ToggleGroup.Root>
          <span className={styles.tag}>Cars</span>
          <ToggleGroup.Root
            type="single" aria-label="Car sync" className={styles.group} value={sync} disabled={running}
            onValueChange={selectSync}
          >
            <ToggleGroup.Item value="time" className={ui.toggleItem}>Time</ToggleGroup.Item>
            <ToggleGroup.Item value="distance" className={ui.toggleItem}>Distance</ToggleGroup.Item>
          </ToggleGroup.Root>
          <span className={styles.tag}>experimental</span>
        </div>
        <div className={styles.bar}>
          {hasElevation ? (
            <label className={styles.exag} title="Stretches the heights; 1x is the true shape">
              <span className={styles.tag}>Elevation</span>
              <Slider.Root
                className={styles.sliderRoot} min={EXAGGERATION_MIN} max={EXAGGERATION_MAX} step={0.5} value={[exag]}
                disabled={running}
                onValueChange={([v]) => changeExaggeration(v)}
                onValueCommit={([v]) => saveString(EXAGGERATION_KEY, String(v))}
              >
                <Slider.Track className={styles.sliderTrack}><Slider.Range className={styles.sliderRange} /></Slider.Track>
                <Slider.Thumb className={styles.sliderThumb} aria-label="Elevation exaggeration" aria-valuetext={`${exag}x`} />
              </Slider.Root>
              <span className={styles.exagValue}>{`${exag.toFixed(1)}×`}</span>
            </label>
          ) : (
            <span className={styles.note} role="note">No elevation for this track</span>
          )}
          <Suspense fallback={<button type="button" className={cx(ui.btn, styles.small)} disabled>Car</button>}>
            <CarModelControl cars={carEntries} disabled={running} />
          </Suspense>
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
        {debug && showHud && hudText && <div className={styles.hud}>{hudText}</div>}
        {debug && rows.length > 0 && (
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

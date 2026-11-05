import type { Camera, Viewport } from "../../../lib/camera";
import type { Pt } from "../../../lib/geo";
import { summarize } from "../../../lib/perf";

export type CameraMode = "follow" | "free";
export type BenchPhase = "follow" | "scrub" | "zoom-pan" | "orbit";

export interface BenchRow {
  renderer: "webgl";
  phase: BenchPhase;
  fps: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  over20: number;
  drawP95Ms: number;
}

/** Snapshot of what the bench disturbs, handed back to `restore` when it ends. */
export interface BenchState { playing: boolean; tau: number; mode: CameraMode; camera: Camera | null }

/** What the bench may drive in the view. Every method is cheap and safe to call once per frame. */
export interface BenchControl {
  viewport(): Viewport;
  /** Camera that fits the whole scene. */
  fitCamera(): Camera;
  /** Number of 1 m grid points on the reference line (its length in metres). */
  lapLength(): number;
  refPoint(distance: number): Pt;
  /** Lap time at which the lap car is at `distance` metres. */
  lapTimeAtDistance(distance: number): number;
  seek(tau: number): void;
  play(): void;
  pause(): void;
  setMode(mode: CameraMode): void;
  /** Sets the free camera (the mode must be "free" for it to show). */
  setCamera(camera: Camera): void;
  snapshot(): BenchState;
  restore(state: BenchState): void;
  /** Starts (true) or stops (false) recording `renderer.draw` durations; starting clears them. */
  recordDraws(on: boolean): void;
  /** Draw durations recorded since `recordDraws(true)`. */
  drawTimes(): number[];
}

export const PHASE_MS = 10_000;
const SCRUB_STEP_M = 40;
const ZOOM_PERIOD_MS = 2000;
const ZOOM_MIN_M = 20;

/** Runs `onFrame(elapsedMs)` each animation frame for `ms`; resolves with the intervals between frames. */
export function runPhase(ms: number, onFrame: (elapsedMs: number) => void, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let start = -1, last = -1;
    const step = (now: number) => {
      if (signal?.aborted) return resolve(intervals);
      if (start < 0) start = now;
      else intervals.push(now - last);
      last = now;
      const elapsed = now - start;
      if (elapsed >= ms) return resolve(intervals);
      onFrame(elapsed);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Three 10 s phases on the current renderer: follow-play at 1x, scrub the whole lap, zoom and pan. */
export async function runBench(ctl: BenchControl, signal?: AbortSignal): Promise<BenchRow[]> {
  const before = ctl.snapshot();
  const rows: BenchRow[] = [];
  const record = async (phase: BenchPhase, setup: () => void, onFrame: (elapsedMs: number) => void) => {
    if (signal?.aborted) return;
    setup();
    ctl.recordDraws(true);
    const intervals = await runPhase(PHASE_MS, onFrame, signal);
    const draws = ctl.drawTimes();
    ctl.recordDraws(false);
    if (signal?.aborted) return;
    rows.push({ renderer: "webgl", phase, ...summarize(intervals), drawP95Ms: summarize(draws).p95Ms });
  };
  try {
    await record("follow", () => {
      ctl.setMode("follow");
      ctl.seek(0);
      ctl.play();
    }, () => {});

    let d = 0;
    await record("scrub", () => {
      ctl.pause();
      ctl.setMode("free");
      ctl.setCamera(ctl.fitCamera());
      d = 0;
    }, () => {
      d = (d + SCRUB_STEP_M) % Math.max(ctl.lapLength() - 1, 1);
      ctl.seek(ctl.lapTimeAtDistance(d));
    });

    await record("zoom-pan", () => {
      ctl.pause();
      ctl.setMode("free");
    }, (elapsed) => {
      const fit = ctl.fitCamera().widthM;
      const phase = (2 * Math.PI * elapsed) / ZOOM_PERIOD_MS;
      const widthM = ZOOM_MIN_M * Math.pow(Math.max(fit, ZOOM_MIN_M) / ZOOM_MIN_M, 0.5 + 0.5 * Math.sin(phase));
      const c = ctl.refPoint((elapsed / PHASE_MS) * 0.3 * ctl.lapLength());
      ctl.setCamera({ cx: c.x, cy: c.y, widthM, rotation: 0 });
    });
  } finally {
    ctl.recordDraws(false);
    ctl.restore(before);
  }
  return rows;
}

const f1 = (v: number) => v.toFixed(1);

/** A Markdown report: environment lines, then one table row per renderer and phase. */
export function benchMarkdown(rows: BenchRow[], env?: { panel?: Viewport }): string {
  const ua = typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
  const win = typeof window === "undefined" ? "unknown" : `${window.innerWidth}x${window.innerHeight}`;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const lines = [
    `- User agent: ${ua}`,
    `- Window: ${win} px, devicePixelRatio ${dpr}`,
  ];
  if (env?.panel) lines.push(`- Map panel: ${Math.round(env.panel.w)}x${Math.round(env.panel.h)} px`);
  lines.push(
    "",
    "| renderer | phase | fps | mean ms | p95 ms | max ms | >20 ms | draw p95 ms |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.renderer} | ${r.phase} | ${f1(r.fps)} | ${f1(r.meanMs)} | ${f1(r.p95Ms)} | ${f1(r.maxMs)} | ${r.over20} | ${f1(r.drawP95Ms)} |`),
  );
  return lines.join("\n");
}

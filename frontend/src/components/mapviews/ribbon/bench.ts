import { summarize } from "../../../lib/perf";
import { PHASE_MS, runPhase, type BenchRow } from "../detailed/bench";
import type { ViewMode } from "./viewModes";

export interface RibbonBenchState { playing: boolean; tau: number; mode: ViewMode }

/** What the ribbon benchmark may drive in the view. Every method is cheap and safe to call once per frame. */
export interface RibbonBenchControl {
  lapLength(): number;
  lapTimeAtDistance(distance: number): number;
  seek(tau: number): void;
  play(): void;
  pause(): void;
  setMode(mode: ViewMode): void;
  /** Turns the orbit camera around the car by `rad`. */
  nudgeOrbit(rad: number): void;
  snapshot(): RibbonBenchState;
  restore(state: RibbonBenchState): void;
  recordDraws(on: boolean): void;
  drawTimes(): number[];
}

const SCRUB_STEP_M = 40;
/** One full turn around the car every 8 s. */
const ORBIT_RAD_PER_MS = (2 * Math.PI) / 8000;

/** Four 10 s phases: follow-play in the chase camera, scrub the whole lap, orbit around the car while it drives, and play in the cockpit (the own cockpit and the mirror's second pass; compare with `?mirror=0`). */
export async function runRibbonBench(ctl: RibbonBenchControl, signal?: AbortSignal): Promise<BenchRow[]> {
  const before = ctl.snapshot();
  const rows: BenchRow[] = [];
  const record = async (phase: BenchRow["phase"], setup: () => void, onFrame: (elapsedMs: number) => void) => {
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
      ctl.setMode("chase");
      ctl.seek(0);
      ctl.play();
    }, () => {});

    let d = 0;
    await record("scrub", () => {
      ctl.pause();
      ctl.setMode("chase");
      d = 0;
    }, () => {
      d = (d + SCRUB_STEP_M) % Math.max(ctl.lapLength() - 1, 1);
      ctl.seek(ctl.lapTimeAtDistance(d));
    });

    let last = 0;
    await record("orbit", () => {
      ctl.setMode("orbit");
      ctl.seek(0);
      ctl.play();
      last = 0;
    }, (elapsed) => {
      ctl.nudgeOrbit((elapsed - last) * ORBIT_RAD_PER_MS);
      last = elapsed;
    });

    await record("cockpit", () => {
      ctl.setMode("cockpit");
      ctl.seek(0);
      ctl.play();
    }, () => {});
  } finally {
    ctl.recordDraws(false);
    ctl.restore(before);
  }
  return rows;
}

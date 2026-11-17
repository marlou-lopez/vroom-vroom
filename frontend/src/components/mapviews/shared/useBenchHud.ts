import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Viewport } from "../../../lib/camera";
import { summarize } from "../../../lib/perf";
import { benchMarkdown, type BenchRow } from "../detailed/bench";
import { Ring } from "./ring";

const HUD_MS = 250;

const f1 = (v: number) => v.toFixed(1);

/** What a view's benchmark control must have for the hook to record draw times into it. */
interface Recording {
  recordDraws(on: boolean): void;
  drawTimes(): number[];
}

interface Options<C extends Recording> {
  /** The dev-only tools exist only when this is on. */
  debug: boolean;
  viewport: () => Viewport;
  /** The camera, playback and scene hooks; draw recording is added here. */
  makeControl: () => Omit<C, "recordDraws" | "drawTimes">;
  /** Runs the view's benchmark phases. */
  run: (ctl: C, signal: AbortSignal) => Promise<BenchRow[]>;
  /** Called when a run starts; the returned function undoes it when the run ends. */
  onRunStart?: () => () => void;
  /** A second HUD line's tail (for instance renderer stats), appended to the draw line. */
  extraHud?: () => string;
}

/**
 * The dev-only frame-rate HUD and benchmark of the WebGL track views (the detailed 2D map and the 3D ribbon). The draw loop pushes into
 * `frames` and `draws`, and reads `benchRunning` and `drawRec`.
 */
export function useBenchHud<C extends Recording>({ debug, viewport, makeControl, run, onRunStart, extraHud }: Options<C>) {
  const [showHud, setShowHud] = useState(true);
  const [hudText, setHudText] = useState("");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [panel, setPanel] = useState<Viewport | undefined>(undefined);

  const reportRef = useRef<HTMLTextAreaElement>(null);
  const frames = useRef(new Ring());
  const draws = useRef(new Ring());
  const drawRec = useRef<number[] | null>(null);
  const benchRunning = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const extraRef = useRef(extraHud);
  useLayoutEffect(() => {
    extraRef.current = extraHud;
  });

  useEffect(() => () => abort.current?.abort(), []);

  // HUD numbers: at most 4 updates a second, and only while shown.
  useEffect(() => {
    if (!debug || !showHud) return;
    const id = setInterval(() => {
      const s = summarize(frames.current.values());
      const d = summarize(draws.current.values());
      if (s.fps === 0) return;
      setHudText(`${s.fps.toFixed(0)} fps  ${f1(s.meanMs)} ms  p95 ${f1(s.p95Ms)}  max ${f1(s.maxMs)}  >20ms ${s.over20}\ndraw p95 ${f1(d.p95Ms)} ms${extraRef.current?.() ?? ""}`);
    }, HUD_MS);
    return () => clearInterval(id);
  }, [debug, showHud]);

  const startBench = useCallback(async () => {
    if (benchRunning.current) return;
    benchRunning.current = true;
    setRunning(true);
    setPanel({ ...viewport() });
    const ac = new AbortController();
    abort.current = ac;
    const ctl = {
      ...makeControl(),
      recordDraws: (on: boolean) => {
        drawRec.current = on ? [] : null;
      },
      drawTimes: () => drawRec.current ?? [],
    } as C;
    const undo = onRunStart?.();
    try {
      const out = await run(ctl, ac.signal);
      setRows((prev) => [...prev, ...out]);
    } finally {
      undo?.();
      benchRunning.current = false;
      setRunning(false);
    }
  }, [viewport, makeControl, run, onRunStart]);

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

  return {
    showHud, setShowHud, hudText, running, rows, clearRows: () => setRows([]), markdown, copy, startBench, reportRef,
    frames, draws, drawRec, benchRunning,
  };
}

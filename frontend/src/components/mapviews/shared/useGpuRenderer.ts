import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Viewport } from "../../../lib/camera";

/** A lost context not restored within this long offers a Retry button. */
export const RESTORE_WAIT_MS = 3000;

export type GpuState = "ok" | "lost" | "stuck" | "failed";

/** What the lifecycle needs from a WebGL view's renderer. */
export interface GpuRenderer {
  resize(v: Viewport, dpr: number): void;
  destroy(): void;
}

/** The callbacks the hook hands to a renderer's loader. A renderer that never needs a redraw on its own may ignore `onNeedsDraw`. */
export interface GpuEvents { onContextLost(): void; onContextRestored(): void; onNeedsDraw(): void }

interface Options<R extends GpuRenderer> {
  /** Creates the renderer inside `host` (lazy-loads its chunk). */
  load: (host: HTMLElement, events: GpuEvents) => Promise<R>;
  /** Called with each new renderer (after a first load, a restore or a Retry) to push the view's current state into it. */
  onReady: (r: R) => void;
  /** Logged with the error when the renderer fails to start. */
  failLabel: string;
}

/**
 * The renderer lifecycle shared by the WebGL track views: build the renderer in the host, destroy a late one, stop drawing on a lost
 * context and rebuild on restore (or Retry), and feed the host's size to the renderer. The promise can resolve after an unmount
 * or a new epoch; a late renderer is destroyed.
 */
export function useGpuRenderer<R extends GpuRenderer>({ load, onReady, failLabel }: Options<R>): {
  hostRef: RefObject<HTMLDivElement>;
  rendererRef: MutableRefObject<R | null>;
  lostRef: MutableRefObject<boolean>;
  vp: MutableRefObject<Viewport>;
  /**
   * The view's own draw request, which the view assigns once it exists (its draw loop reads this hook's refs, so it is built after it):
   * `requestDrawRef.current = requestDraw`.
   */
  requestDrawRef: MutableRefObject<() => void>;
  gpu: GpuState;
  retry: () => void;
} {
  const [epoch, setEpoch] = useState(0);
  const [gpu, setGpu] = useState<GpuState>("ok");
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<R | null>(null);
  const lostRef = useRef(false);
  const lostTimer = useRef(0);
  const vp = useRef<Viewport>({ w: 0, h: 0 });
  const requestDrawRef = useRef<() => void>(() => {});
  const requestDraw = useCallback(() => requestDrawRef.current(), []);
  // The latest callbacks, so the lifecycle effect depends on the epoch only.
  const loadRef = useRef(load);
  const readyRef = useRef(onReady);
  useLayoutEffect(() => {
    loadRef.current = load;
    readyRef.current = onReady;
  });

  useEffect(() => () => window.clearTimeout(lostTimer.current), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ac = new AbortController();
    const events: GpuEvents = {
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
    const ready = loadRef.current(host, events).then((r) => {
      if (ac.signal.aborted) {
        r.destroy();
        return null;
      }
      rendererRef.current = r;
      lostRef.current = false;
      setGpu("ok");
      readyRef.current(r);
      r.resize(vp.current, window.devicePixelRatio || 1);
      requestDraw();
      return r;
    }, (err) => {
      console.error(failLabel, err);
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
  }, [epoch, requestDraw, failLabel]);

  // Resize: the host's size feeds the renderer.
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

  const retry = useCallback(() => {
    setGpu("lost");
    setEpoch((e) => e + 1);
  }, []);

  return { hostRef, rendererRef, lostRef, vp, requestDrawRef, gpu, retry };
}

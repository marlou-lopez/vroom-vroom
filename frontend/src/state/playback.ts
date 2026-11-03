// Playback store: a zustand vanilla store exposed through React context. `tau` changes every animation frame,
// so components subscribe through selectors (`usePlayback`) instead of re-rendering with the whole context.
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { advanceTau } from "../lib/playback";

export const RATES = [0.25, 0.5, 1, 2] as const;
export type Rate = (typeof RATES)[number];
export type PlaybackView = "detailed" | "simplified";

export interface PlaybackState {
  lapId: string | null;
  refLapId: string | null;
  /** Playhead: seconds into the "you" lap. */
  tau: number;
  playing: boolean;
  rate: Rate;
  view: PlaybackView;
  /** Length of the "you" lap in seconds (the wrap point). */
  duration: number;
}

export interface PlaybackActions {
  setLaps(lapId: string | null, refLapId: string | null): void;
  setDuration(duration: number): void;
  seek(tau: number): void;
  seekBy(dt: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setRate(rate: Rate): void;
  setView(view: PlaybackView): void;
  /** Advance by `dt` real seconds (called by the rAF loop). */
  tick(dt: number): void;
}

/** A zustand store of `PlaybackState` (usable with `useStore`), plus `get` and the actions. */
export interface PlaybackStore extends Pick<StoreApi<PlaybackState>, "getState" | "getInitialState" | "subscribe">, PlaybackActions {
  get(): PlaybackState;
}

export function createPlaybackStore(initial?: Partial<PlaybackState>): PlaybackStore {
  const store = createStore<PlaybackState>(() => ({
    lapId: null, refLapId: null, tau: 0, playing: false, rate: 1, view: "detailed", duration: 0, ...initial,
  }));
  const { getState, setState } = store;
  const clamp = (tau: number) => Math.min(Math.max(0, tau), getState().duration);
  return {
    get: getState,
    getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
    setLaps(lapId, refLapId) {
      const s = getState();
      if (lapId !== s.lapId || refLapId !== s.refLapId) setState({ lapId, refLapId, tau: 0 });
    },
    setDuration: (duration) => setState({ duration }),
    seek: (tau) => setState({ tau: clamp(tau) }),
    seekBy: (dt) => setState({ tau: clamp(getState().tau + dt) }),
    play: () => setState({ playing: true }),
    pause: () => setState({ playing: false }),
    toggle: () => setState({ playing: !getState().playing }),
    setRate: (rate) => setState({ rate }),
    setView: (view) => setState({ view }),
    tick(dt) {
      const s = getState();
      if (s.duration > 0) setState({ tau: advanceTau(s.tau, dt, s.rate, s.duration) });
    },
  };
}

const Ctx = createContext<PlaybackStore | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createPlaybackStore());
  const playing = useStore(store, (s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      // Cap dt so a backgrounded tab does not jump the playhead on return.
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      store.tick(dt);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, store]);
  return createElement(Ctx.Provider, { value: store }, children);
}

export function usePlaybackStore(): PlaybackStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("usePlaybackStore must be used inside <PlaybackProvider>");
  return store;
}

/** Subscribe to a slice of the state. The selector should return a primitive (or a stable reference). */
export function usePlayback<T>(selector: (s: PlaybackState) => T): T {
  const store = usePlaybackStore();
  return useStore(store, selector);
}

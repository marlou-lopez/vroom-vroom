import { describe, expect, it, vi } from "vitest";
import { createPlaybackStore } from "./playback";

describe("playback store", () => {
  it("clamps seeks to [0, duration]", () => {
    const s = createPlaybackStore({ duration: 10 });
    s.seek(-5);
    expect(s.get().tau).toBe(0);
    s.seek(99);
    expect(s.get().tau).toBe(10);
    s.seekBy(-3);
    expect(s.get().tau).toBe(7);
  });

  it("resets tau only when the laps change", () => {
    const s = createPlaybackStore({ duration: 10 });
    s.setLaps("a", "b");
    s.seek(4);
    s.setLaps("a", "b");
    expect(s.get().tau).toBe(4);
    s.setLaps("a", "c");
    expect(s.get().tau).toBe(0);
  });

  it("ticks only with a duration, scaled by rate and wrapping at the end", () => {
    const s = createPlaybackStore();
    s.tick(1);
    expect(s.get().tau).toBe(0);
    s.setDuration(10);
    s.setRate(2);
    s.tick(1);
    expect(s.get().tau).toBe(2);
    s.seek(9.5);
    s.tick(1);
    expect(s.get().tau).toBe(0);
  });

  it("toggles play state and notifies subscribers imperatively", () => {
    const s = createPlaybackStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.toggle();
    expect(s.get().playing).toBe(true);
    s.pause();
    expect(s.get().playing).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    s.play();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

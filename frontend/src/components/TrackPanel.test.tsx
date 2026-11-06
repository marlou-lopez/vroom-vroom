import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackModel } from "../lib/model";
import { PlaybackProvider, usePlaybackStore, type PlaybackStore } from "../state/playback";
import { TrackPanel } from "./TrackPanel";

const renders = vi.hoisted(() => ({ view: 0 }));

// Deliberately not memoised: it renders exactly when TrackPanel does.
vi.mock("./mapviews/registry", () => {
  function CountingView() {
    renders.view++;
    return null;
  }
  return { TRACK_VIEWS: [{ id: "2d", label: "2D", experimental: false, Component: CountingView }] };
});

const model = {
  cmp: {
    lap: { t: [0, 1, 2], gear: [2, 3, 4], speed_kmh: [100, 150, 200] },
    ref: { t: [0, 1, 2] },
    distance: [0, 50, 100],
    delta: [0, 0.1, 0.2],
  },
} as unknown as PlaybackModel;

const grabbed: { store?: PlaybackStore } = {};
function Grab() {
  const s = usePlaybackStore();
  useEffect(() => {
    grabbed.store = s;
  }, [s]);
  return null;
}

describe("TrackPanel", () => {
  it("updates the read-out on every playhead change without re-rendering the view", () => {
    const handlers = { onSeek: () => {} };
    const annotations: never[] = [];
    render(
      <PlaybackProvider>
        <Grab />
        <TrackPanel model={model} trackMap={null} annotations={annotations} handlers={handlers} expanded={false} onToggleExpanded={() => {}} />
      </PlaybackProvider>,
    );
    const store = grabbed.store!;
    act(() => store.setDuration(2));
    const before = renders.view;
    expect(screen.getByText(/gear 2/)).toBeTruthy();
    act(() => store.seek(1));
    expect(screen.getByText(/gear 3/)).toBeTruthy();
    act(() => store.seek(2));
    expect(screen.getByText(/gear 4/)).toBeTruthy();
    expect(renders.view).toBe(before);
  });
});


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
    ref: { t: [0, 1, 2], speed_kmh: [101, 151, 201] },
    lap_understeer_runs: [{ start_m: 40, end_m: 60 }],
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
        <TrackPanel model={model} trackMap={null} geometry={null} annotations={annotations} handlers={handlers} expanded={false} onToggleExpanded={() => {}} />
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

  const mountAt = (trackMap: unknown) => {
    render(
      <PlaybackProvider>
        <Grab />
        <TrackPanel model={model} trackMap={trackMap as never} geometry={null} annotations={[]} handlers={{ onSeek: () => {} }} expanded={false} onToggleExpanded={() => {}} />
      </PlaybackProvider>,
    );
    act(() => grabbed.store!.setDuration(2));
  };
  const corner = (start_m: number, end_m: number) => ({ corners: [{ name: "T1", start_m, end_m, apex_m: (start_m + end_m) / 2 }] });

  it("shows your speed and the comparison's, 'you / ref'", () => {
    mountAt(null);
    act(() => grabbed.store!.seek(1));
    expect(screen.getByText(/150 \/ 151 km\/h/)).toBeTruthy();
  });

  it("shows the understeer verdict only inside a corner", () => {
    mountAt(corner(30, 70));
    act(() => grabbed.store!.seek(1));
    expect(screen.getByText("understeer")).toBeTruthy();
  });

  it("does not show the verdict on a straight, even inside a run", () => {
    mountAt(corner(80, 99));
    act(() => grabbed.store!.seek(1));
    expect(screen.queryByText("understeer")).toBeNull();
  });

  it("does not show the verdict in a corner outside the runs", () => {
    mountAt(corner(0, 45));
    act(() => grabbed.store!.seek(0));
    expect(screen.queryByText("understeer")).toBeNull();
  });

  it("names the clicked corner in its lead-in, even while still inside the previous corner", () => {
    // Playhead at 50 m: inside A (0-60), 80 m before B starts (its lead-in is 150 m).
    mountAt({ length_m: 1000, corners: [
      { id: "a", name: "Roggia 2", start_m: 0, end_m: 60, apex_m: 30 },
      { id: "b", name: "Lesmo 1", start_m: 130, end_m: 200, apex_m: 160 },
    ] });
    act(() => grabbed.store!.seek(1, "b"));
    expect(screen.getByText("Approaching Lesmo 1")).toBeTruthy();
    expect(screen.queryByText("Roggia 2")).toBeNull();
    // Any other seek (scrub, key) goes back to the corner the car is in.
    act(() => grabbed.store!.seek(1));
    expect(screen.getByText("Roggia 2")).toBeTruthy();
  });

  it("keeps the understeer verdict of the corner the car is in during a lead-in", () => {
    mountAt({ length_m: 1000, corners: [
      { id: "a", name: "Roggia 2", start_m: 30, end_m: 70, apex_m: 50 },
      { id: "b", name: "Lesmo 1", start_m: 130, end_m: 200, apex_m: 160 },
    ] });
    act(() => grabbed.store!.seek(1, "b"));
    expect(screen.getByText("understeer")).toBeTruthy();
  });
});

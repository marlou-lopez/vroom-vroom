import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "../../../state/playback";
import type { PlaybackModel } from "../../../lib/model";
import { DetailedMapView } from "../detailed/DetailedMapView";
import { loadRenderer, type Renderer } from "../detailed/renderer";
import type { GpuEvents } from "../shared/useGpuRenderer";
import { RibbonView } from "./RibbonView";
import { loadRibbonRenderer, type RibbonRenderer } from "./types";

vi.mock("../detailed/renderer", async (orig) => ({ ...(await orig<typeof import("../detailed/renderer")>()), loadRenderer: vi.fn() }));
vi.mock("./types", async (orig) => ({ ...(await orig<typeof import("./types")>()), loadRibbonRenderer: vi.fn() }));
vi.mock("../detailed/scene", async (orig) => ({
  ...(await orig<typeof import("../detailed/scene")>()),
  buildScene: () => ({ bounds: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, lengthM: 100, centre: { x: [] } }),
  carPositions: () => null,
}));
vi.mock("../../../lib/carAttitude", () => ({ estimateAttitude: () => null, attitudeAt: () => null }));
vi.mock("../../../lib/shiftLights", () => ({ deriveRpmLimits: () => null }));
vi.mock("./CarModelControl", () => ({ CarModelControl: () => <button type="button">Car</button> }));

const model = { cmp: { lap: { t: [0, 1] }, ref: {}, distance: [0, 1], delta: [] } } as unknown as PlaybackModel;
const handlers = { onHover: () => {}, onLeave: () => {}, onSelect: () => {} } as never;
const ribbon = () => render(<PlaybackProvider><RibbonView model={model} trackMap={null} geometry={null} annotations={[]} handlers={handlers} /></PlaybackProvider>);
const detailed = () => render(<PlaybackProvider><DetailedMapView model={model} trackMap={null} geometry={null} annotations={[]} handlers={handlers} /></PlaybackProvider>);

const fakeRibbon = () => ({ setScene() {}, setMode() {}, resize() {}, draw() {}, destroy() {}, stats: () => null }) as unknown as RibbonRenderer;
const fakeDetailed = () => ({ setScene() {}, setAheadVisible() {}, setGainStyle() {}, setEdgeDebug() {}, resize() {}, draw() {}, destroy() {} }) as unknown as Renderer;

afterEach(() => window.history.replaceState(null, "", "/"));

describe("RibbonView renderer lifecycle", () => {
  beforeEach(() => { vi.mocked(loadRibbonRenderer).mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.useRealTimers());

  it("shows a message with Retry when its chunk fails to load, and Retry tries again", async () => {
    vi.mocked(loadRibbonRenderer).mockRejectedValue(new Error("chunk"));
    ribbon();
    expect(await screen.findByText("The 3D view could not load.")).toBeTruthy();
    vi.mocked(loadRibbonRenderer).mockResolvedValue(fakeRibbon());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(loadRibbonRenderer).toHaveBeenCalledTimes(2);
  });

  it("says the graphics reset on context loss, offers Retry after 3 s, and rebuilds on restore", async () => {
    let events!: GpuEvents;
    vi.mocked(loadRibbonRenderer).mockImplementation(async (_h, e) => { events = e; return fakeRibbon(); });
    ribbon();
    await waitFor(() => expect(loadRibbonRenderer).toHaveBeenCalledTimes(1));
    await act(async () => {});
    vi.useFakeTimers();
    act(() => events.onContextLost());
    expect(screen.getByText(/Graphics reset/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    act(() => events.onContextRestored());
    expect(loadRibbonRenderer).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

describe("HUD and benchmark in the WebGL views", () => {
  beforeEach(() => {
    vi.mocked(loadRibbonRenderer).mockReset().mockResolvedValue(fakeRibbon());
    vi.mocked(loadRenderer).mockReset().mockResolvedValue(fakeDetailed());
  });

  it.each([["3D", ribbon], ["detailed", detailed]])("%s view: shown in dev, hidden with ?debug=0, shown with ?debug", async (_n, view) => {
    const shown = () => Boolean(screen.queryByRole("button", { name: "HUD" })) && Boolean(screen.queryByRole("button", { name: /Run benchmark/ }));
    const a = view();
    expect(shown()).toBe(true);
    a.unmount();
    window.history.replaceState(null, "", "/?debug=0");
    const b = view();
    expect(screen.queryByRole("button", { name: "HUD" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Run benchmark/ })).toBeNull();
    b.unmount();
    window.history.replaceState(null, "", "/?debug");
    view();
    expect(shown()).toBe(true);
  });
});

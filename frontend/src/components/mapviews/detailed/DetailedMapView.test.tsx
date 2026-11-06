import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "../../../state/playback";
import type { PlaybackModel } from "../../../lib/model";
import { DetailedMapView } from "./DetailedMapView";
import { loadRenderer, type Renderer } from "./renderer";

vi.mock("./renderer", async (orig) => ({ ...(await orig<typeof import("./renderer")>()), loadRenderer: vi.fn() }));
vi.mock("./scene", async (orig) => ({
  ...(await orig<typeof import("./scene")>()),
  buildScene: () => ({ bounds: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, lengthM: 100 }),
  carPositions: () => null,
}));

const model = { cmp: { lap: { t: [0, 1] }, distance: [0, 1] } } as unknown as PlaybackModel;
const handlers = { onHover: () => {}, onLeave: () => {}, onSelect: () => {} } as never;
const view = () => render(<PlaybackProvider><DetailedMapView model={model} trackMap={null} annotations={[]} handlers={handlers} /></PlaybackProvider>);

describe("DetailedMapView when the renderer cannot start", () => {
  beforeEach(() => { vi.mocked(loadRenderer).mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("shows a message with Retry instead of a blank panel, and Retry tries again", async () => {
    vi.mocked(loadRenderer).mockRejectedValue(new Error("WebGL unavailable"));
    view();
    expect(await screen.findByText(/could not start/i)).toBeTruthy();
    expect(screen.getByText(/classic 2D view/i)).toBeTruthy();

    const ok = { setScene() {}, setAheadVisible() {}, setGainStyle() {}, setEdgeDebug() {}, resize() {}, draw() {}, destroy() {} } as unknown as Renderer;
    vi.mocked(loadRenderer).mockResolvedValue(ok);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(loadRenderer).toHaveBeenCalledTimes(2);
  });
});

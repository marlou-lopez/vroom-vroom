import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackModel } from "../lib/model";
import { PlaybackProvider } from "../state/playback";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { TrackPanel } from "./TrackPanel";

vi.mock("./mapviews/registry", () => {
  function ThrowingView(): never {
    throw new Error("renderer exploded");
  }
  return { TRACK_VIEWS: [{ id: "2d", label: "2D", experimental: false, Component: ThrowingView }] };
});

function Boom(): never {
  throw new Error("page exploded");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("shows the error inline and recovers when a reset key changes", () => {
    let fail = true;
    const Child = () => (fail ? <Boom /> : <p>fine</p>);
    const { rerender } = render(<ErrorBoundary label="page" resetKeys={["a"]}><Child /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toMatch(/page exploded/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fail = false;
    rerender(<ErrorBoundary label="page" resetKeys={["a"]}><Child /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(<ErrorBoundary label="page" resetKeys={["b"]}><Child /></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });
});

describe("AppShell", () => {
  it("keeps the navigation working when a route throws, and clears the error on navigation", () => {
    render(
      <MemoryRouter initialEntries={["/bad"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="bad" element={<Boom />} />
            <Route path="tracks" element={<p>tracks page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/page exploded/);
    fireEvent.click(screen.getByRole("link", { name: "Tracks" }));
    expect(screen.getByText("tracks page")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("TrackPanel", () => {
  it("contains a track view throw so the rest of the panel still renders", () => {
    const model = {
      cmp: { lap: { t: [0], gear: [2], speed_kmh: [100] }, ref: { t: [0] }, distance: [0], delta: [0] },
    } as unknown as PlaybackModel;
    render(
      <PlaybackProvider>
        <TrackPanel
          model={model} trackMap={null} geometry={null} annotations={[]} handlers={{ onSeek: () => {} }}
          footer={<span>engineer line</span>} expanded={false} onToggleExpanded={() => {}}
        />
      </PlaybackProvider>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/renderer exploded/);
    expect(screen.getByText("engineer line")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand track view" })).toBeTruthy();
  });
});

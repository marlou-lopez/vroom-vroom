// Page-wide playback keys, the shortcuts popover and the corner ticks' roving tabindex (vroom-pnw.36).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createTestClient, setupMockServer } from "../test/mockServer";
import { TelemetryPage } from "./TelemetryPage";

vi.mock("uplot", () => ({
  default: class {
    static pxRatio = 1;
    static paths = { stepped: () => () => null };
    root = document.createElement("div");
    over = document.createElement("div");
    bbox = { left: 0, top: 0, width: 0, height: 0 };
    redraw() {}
    setScale() {}
    setSize() {}
    setData() {}
    setCursor() {}
    destroy() {}
  },
}));
vi.mock("../components/mapviews/registry", () => ({
  TRACK_VIEWS: [{ id: "2d", label: "2D", experimental: false, Component: () => <div data-testid="stub-view" /> }],
}));

setupMockServer();

async function open() {
  render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <TelemetryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Ask the coach" });
  await screen.findByRole("slider", { name: "Lap position" });
  // The URL gets its ?lap after the first load and the page reloads the comparison: let it settle.
  await new Promise((r) => setTimeout(r, 300));
  await screen.findByRole("slider", { name: "Lap position" });
}

const at = () => Number(screen.getByRole("slider", { name: "Lap position" }).getAttribute("aria-valuenow"));

describe("page-wide playback keys", () => {
  it("toggles play with Space and K from the page body, not from a field", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: " " });
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    const box = document.createElement("input");
    document.body.append(box);
    fireEvent.keyDown(box, { key: "k" });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    box.remove();
  });

  it("seeks with the arrows and J / L, and steps corners and issues", async () => {
    await open();
    expect(at()).toBe(0);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(at()).toBeCloseTo(5, 5);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(at()).toBeCloseTo(5.5, 5);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(at()).toBeCloseTo(0.5, 5);
    fireEvent.keyDown(document.body, { key: "]" });
    const c1 = at();
    expect(c1).toBeGreaterThan(0.5);
    fireEvent.keyDown(document.body, { key: "]" });
    expect(at()).toBeGreaterThan(c1);
    fireEvent.keyDown(document.body, { key: "[" });
    expect(at()).toBeCloseTo(c1, 5);
    fireEvent.keyDown(document.body, { key: "n" });
    const first = at();
    expect(first).toBeGreaterThan(0);
    fireEvent.keyDown(document.body, { key: "n" });
    const second = at();
    expect(second).toBeGreaterThan(first);
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });
    expect(at()).toBeCloseTo(first, 5);
  });
});

describe("shortcuts popover", () => {
  it("opens from the button and from ?, listing the lap keys", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const panel = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(panel).getByText("Step to the previous or next timed lap")).toBeTruthy();
    expect(within(panel).getAllByText("Play or pause").length).toBeGreaterThan(0);
    fireEvent.keyDown(within(panel).getAllByText("Play or pause")[0], { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});

describe("corner ticks", () => {
  it("are one tab stop and arrows reach every tick", async () => {
    await open();
    const group = await screen.findByRole("group", { name: /^Corners/ });
    const ticks = within(group).getAllByRole("button");
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    ticks[0].focus();
    const t0 = at();
    for (let i = 1; i < ticks.length; i++) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(ticks[i]);
    }
    expect(ticks[ticks.length - 1].tabIndex).toBe(0);
    expect(ticks.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(ticks[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(ticks[ticks.length - 1]);
    // Arrows on a tick move focus; they do not also scrub the lap.
    expect(at()).toBe(t0);
  });
});

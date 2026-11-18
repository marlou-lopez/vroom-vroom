/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import type { Recording } from "../api/mock/recording";
import { buildModel } from "../lib/model";
import { PlaybackProvider, usePlaybackStore, type PlaybackStore } from "../state/playback";
import { DetailedStrips } from "./DetailedStrips";
import { newestBest } from "../test/mockServer";

vi.mock("uplot", () => ({
  default: class {
    static pxRatio = 1;
    static paths = { stepped: () => () => null };
    root = document.createElement("div");
    over = document.createElement("div");
    bbox = { left: 0, top: 0, width: 0, height: 0 };
    redraw() {}
    setScale(_k: string, v: { min: number; max: number }) { (globalThis as { __scales?: unknown[] }).__scales?.push(v); }
    setSize() {}
    setData() {}
    setCursor() {}
    destroy() {}
  },
}));

const REC = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../public/mock/spa-2026-11-03.json"), "utf8")) as Recording;

describe("DetailedStrips elevation strip", () => {
  it("shows only when the track geometry has elevation", async () => {
    const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
    const { best } = await newestBest(api);
    const cmp = await api.compare(best.lap_id);
    const model = buildModel(cmp);
    const handlers = { onHover: () => {}, onLeave: () => {}, onSelect: () => {} } as never;
    const geometry = { elevation_m: Array.from({ length: cmp.distance.length }, (_, i) => i / 10) } as never;
    const view = (g: never | null) => (
      <PlaybackProvider><DetailedStrips model={model} geometry={g} annotations={[]} handlers={handlers} /></PlaybackProvider>
    );
    const { rerender } = render(view(null));
    expect(screen.queryByText("ELEVATION")).toBeNull();
    expect(screen.getByText("GEAR")).toBeTruthy();
    rerender(view(geometry));
    expect(screen.getByText("ELEVATION")).toBeTruthy();
  });
});

describe("DetailedStrips picker", () => {
  async function setup() {
    const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
    const { best } = await newestBest(api);
    const model = buildModel(await api.compare(best.lap_id));
    const handlers = { onHover: () => {}, onLeave: () => {}, onSelect: () => {} } as never;
    return render(
      <PlaybackProvider><DetailedStrips model={model} geometry={null} annotations={[]} handlers={handlers} /></PlaybackProvider>,
    );
  }
  const labels = () => Array.from(document.querySelectorAll("[class*=label]")).map((e) => e.textContent);

  it("adds, reorders and removes strips and remembers the choice", async () => {
    localStorage.clear();
    await setup();
    expect(labels()).toEqual(["SPEED", "THROTTLE · BRAKE", "GEAR", "STEERING", "TIME VS BEST (RISING = LOSING TIME)"]);
    fireEvent.click(screen.getByRole("button", { name: "Choose strips" }));
    fireEvent.click(screen.getByRole("button", { name: "Add RPM" }));
    expect(labels()).toContain("RPM");
    fireEvent.click(screen.getByRole("button", { name: "Move RPM up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Speed" }));
    expect(labels()).toEqual(["THROTTLE · BRAKE", "GEAR", "STEERING", "RPM", "TIME VS BEST (RISING = LOSING TIME)"]);
    expect(JSON.parse(localStorage.getItem("vroom.strips")!)).toEqual(["pedals", "gear", "steering", "rpm", "delta", "elevation"]);
  });

  it("starts from the default set when the stored choice names an unknown channel", async () => {
    localStorage.setItem("vroom.strips", '["speed","bogus"]');
    await setup();
    expect(labels()).toEqual(["SPEED", "THROTTLE · BRAKE", "GEAR", "STEERING", "TIME VS BEST (RISING = LOSING TIME)"]);
  });
});

describe("DetailedStrips legend, zoom, pan and axis (vroom-pnw.35, vroom-pnw.48)", () => {
  let store: PlaybackStore;
  let lastModel: ReturnType<typeof buildModel>;
  let lastHandlers: never;
  const Probe = () => { store = usePlaybackStore(); return null; };
  async function setup(extra: Record<string, unknown> = {}) {
    const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
    const { best } = await newestBest(api);
    const model = buildModel(await api.compare(best.lap_id));
    const handlers = { onHover: () => {}, onLeave: () => {}, onSelect: () => {} } as never;
    lastModel = model;
    lastHandlers = handlers;
    return render(
      <PlaybackProvider>
        <Probe />
        <DetailedStrips model={model} geometry={null} annotations={[]} handlers={handlers} youName="You · L8" refName="Comparison · L2" {...extra} />
      </PlaybackProvider>,
    );
  }

  it("names the lap and the comparison in a legend", async () => {
    await setup();
    expect(screen.getByText("You · L8")).toBeTruthy();
    expect(screen.getByText("Comparison · L2")).toBeTruthy();
  });

  it("keys the ABS and TC shading in the pedals header only when the lap has those runs", async () => {
    const { unmount } = await setup();
    const has = (n: string) => screen.queryAllByText(n).length > 0;
    const abs = lastModel.cmp.lap.abs.some(Boolean), tc = lastModel.cmp.lap.tc.some(Boolean);
    expect(has("ABS")).toBe(abs);
    expect(has("TC")).toBe(tc);
    unmount();
    // A lap with no aid runs shows neither.
    const clean = { ...lastModel, cmp: { ...lastModel.cmp, lap: { ...lastModel.cmp.lap, abs: lastModel.cmp.lap.abs.map(() => 0), tc: lastModel.cmp.lap.tc.map(() => 0) } } };
    render(
      <PlaybackProvider>
        <DetailedStrips model={clean as never} geometry={null} annotations={[]} handlers={lastHandlers} />
      </PlaybackProvider>,
    );
    expect(has("ABS")).toBe(false);
    expect(has("TC")).toBe(false);
  });

  it("explains the wheels-off and corner bands in the legend", async () => {
    await setup({ lapValid: false, annotations: [{ startM: 100, apexM: 150, endM: 200, color: "#fff", label: "1", kind: "issue", finding: { corner: "T1" } }] });
    // Wheels-off item appears only when the lap has such runs; its tooltip names both colours.
    expect(screen.queryAllByText(/Off track/).length).toBeGreaterThan(0);
    for (const el of screen.queryAllByText(/Off track/)) expect(el.getAttribute("title")).toMatch(/nearly off track.*invalid/i);
    expect(screen.getByText("Corner the coach commented on").getAttribute("title")).toMatch(/corner/i);
  });

  const scales = () => (globalThis as unknown as { __scales: Array<{ min: number; max: number }> }).__scales;
  const lastWin = () => scales()[scales().length - 1];

  it("pans the window, then follows the playhead again after it moves; a corner click fits once", async () => {
    localStorage.clear();
    (globalThis as { __scales?: unknown[] }).__scales = [];
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    // Give the plot a layout width: 1 px per metre at the default 700 m window.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 700 });
    try {
      const { rerender } = await setup();
      store.setDuration(100);
      store.seek(40);
      const centre = () => (lastWin().min + lastWin().max) / 2;
      const c0 = centre();
      fireEvent.pointerDown(group(), { pointerId: 1, button: 0, shiftKey: true, clientX: 300 });
      fireEvent.pointerMove(group(), { pointerId: 1, clientX: 200 });
      expect(centre()).toBeCloseTo(c0 + 100, 3);
      expect(store.get().tau).toBe(40);
      fireEvent.pointerUp(group(), { pointerId: 1, clientX: 200 });
      store.seek(60);
      const d60 = centre();
      expect(d60).not.toBeCloseTo(c0 + 100, 0);
      store.seek(61);
      expect(centre()).toBeGreaterThan(d60);
      // Corner click: the width fits the corner once, is not stored, and the window keeps following the playhead.
      const before = widthButton().textContent;
      rerender(
        <PlaybackProvider>
          <Probe />
          <DetailedStrips model={lastModel} geometry={null} annotations={[]} handlers={lastHandlers} focusCorner={{ startM: 500, endM: 560, n: 1 }} />
        </PlaybackProvider>,
      );
      expect(widthButton().textContent).not.toBe(before);
      expect(localStorage.getItem("vroom.stripWidth")).toBeNull();
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });

  const group = () => screen.getByRole("group", { name: /Telemetry strips/ });
  const widthButton = () => screen.getByRole("button", { name: /\d+ m|Whole lap/ });

  it("has no window modes, hints at Shift-drag and starts at 700 m", async () => {
    localStorage.clear();
    await setup();
    expect(screen.queryByRole("button", { name: "Corner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lap" })).toBeNull();
    expect(screen.getByText(/Drag to move along the lap/)).toBeTruthy();
    expect(widthButton().textContent).toBe("Zoom: 700 m");
  });

  it("zooms with the wheel, the + and - keys and the whole lap, remembers the width and resets on double-click", async () => {
    localStorage.clear();
    await setup();
    const width = () => Number(widthButton().textContent!.replace(/\D/g, "")) || Infinity;
    fireEvent.wheel(group(), { deltaY: -300 });
    expect(width()).toBeLessThan(700);
    expect(Number(localStorage.getItem("vroom.stripWidth"))).toBe(width());
    for (let i = 0; i < 40; i++) fireEvent.wheel(group(), { deltaY: -300 });
    expect(width()).toBe(100);
    fireEvent.keyDown(group(), { key: "-" });
    expect(width()).toBe(125);
    fireEvent.keyDown(group(), { key: "+" });
    expect(width()).toBe(100);
    for (let i = 0; i < 60; i++) fireEvent.wheel(group(), { deltaY: 300 });
    expect(widthButton().textContent).toBe("Whole lap");
    fireEvent.click(group(), { detail: 2 });
    expect(widthButton().textContent).toBe("Zoom: 700 m");
    expect(localStorage.getItem("vroom.stripWidth")).toBe("700");
  });

  it("restores the stored width", async () => {
    localStorage.setItem("vroom.stripWidth", "420");
    await setup();
    expect(widthButton().textContent).toBe("Zoom: 420 m");
  });

  it("pans with Shift-drag and middle-drag without moving the playhead; a plain drag moves it", async () => {
    localStorage.clear();
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    await setup();
    store.setDuration(100);
    store.seek(30);
    const drag = (init: object) => {
      fireEvent.pointerDown(group(), { pointerId: 1, clientX: 100, ...init });
      fireEvent.pointerMove(group(), { pointerId: 1, clientX: 160, ...init });
      fireEvent.pointerUp(group(), { pointerId: 1, clientX: 160, ...init });
    };
    drag({ button: 0, shiftKey: true });
    expect(store.get().tau).toBe(30);
    drag({ button: 1 });
    expect(store.get().tau).toBe(30);
    // Plain drag pauses and scrubs; with no layout width in jsdom the playhead does not jump, but the gesture is the scrub one.
    store.play();
    drag({ button: 0 });
    expect(store.get().playing).toBe(true);
    // A pan pauses playback and leaves it paused: resuming would pull the window back to the playhead.
    store.pause();
    store.play();
    fireEvent.pointerDown(group(), { pointerId: 2, button: 0, shiftKey: true, clientX: 0 });
    fireEvent.pointerMove(group(), { pointerId: 2, clientX: 50 });
    fireEvent.pointerUp(group(), { pointerId: 2, clientX: 50 });
    expect(store.get().playing).toBe(false);
  });

  it("draws distance ticks under the strips and colours paired read-outs", async () => {
    localStorage.clear();
    const { container } = await setup({ corners: [] });
    for (let i = 0; i < 60; i++) fireEvent.wheel(group(), { deltaY: 300 });
    const ticks = Array.from(container.querySelectorAll("[class*=tick]")).map((e) => e.textContent);
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks[0]).toBe("0");
    const speed = container.querySelectorAll("[class*=value]")[0];
    expect(speed.hasAttribute("data-pair")).toBe(true);
    expect(speed.children[2].textContent).not.toBe("");
  });
});

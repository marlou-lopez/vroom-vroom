/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import type { Recording } from "../api/mock/recording";
import { buildModel } from "../lib/model";
import { PlaybackProvider } from "../state/playback";
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
    setScale() {}
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
    expect(labels()).toEqual(["SPEED", "THROTTLE · BRAKE", "GEAR", "STEERING", "DELTA"]);
    fireEvent.click(screen.getByRole("button", { name: "Choose strips" }));
    fireEvent.click(screen.getByRole("button", { name: "Add RPM" }));
    expect(labels()).toContain("RPM");
    fireEvent.click(screen.getByRole("button", { name: "Move RPM up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Speed" }));
    expect(labels()).toEqual(["THROTTLE · BRAKE", "GEAR", "STEERING", "RPM", "DELTA"]);
    expect(JSON.parse(localStorage.getItem("vroom.strips")!)).toEqual(["pedals", "gear", "steering", "rpm", "delta", "elevation"]);
  });

  it("starts from the default set when the stored choice names an unknown channel", async () => {
    localStorage.setItem("vroom.strips", '["speed","bogus"]');
    await setup();
    expect(labels()).toEqual(["SPEED", "THROTTLE · BRAKE", "GEAR", "STEERING", "DELTA"]);
  });
});

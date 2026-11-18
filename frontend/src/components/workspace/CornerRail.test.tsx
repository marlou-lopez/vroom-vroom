// The corner rail "Where the time goes" (vroom-pnw.34).
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareResponse, Corner, CornerMetrics, Finding, TrackMap } from "../../api/types";
import type { Annotation } from "../../lib/annotations";
import { CORNER_RAIL_KEY, CornerRail } from "./CornerRail";

const side = { brake_onset_m: 100, peak_brake: 1, min_speed_kmh: 100, min_speed_m: 120, throttle_pickup_m: 140, exit_speed_kmh: 150, coast_s: 0, overlap_s: 0, steer_corrections: 0, understeer_peak_deg_s: null, understeer_mean_deg_s: null };
const m = (id: string, d: number, lap: Partial<typeof side> = {}): CornerMetrics => ({ corner_id: id, delta_s: d, lap: { ...side, ...lap }, ref: side });
const corner = (id: string, name: string, start: number): Corner => ({ id, name, start_m: start, apex_m: start + 20, end_m: start + 40, complex: null, approx: false });
const map = { corners: [corner("1", "Late", 300), corner("2", "Early", 100)] } as unknown as TrackMap;
const cmp = (ref = "b") =>
  ({ lap_id: "a", ref_lap_id: ref, delta: [0, 0.1], corners: [m("1", 0.2, { min_speed_kmh: 90 }), m("2", -0.1, { min_speed_kmh: 110 })] }) as unknown as CompareResponse;
const note = { cornerId: "1", findingId: "f1", label: "1", color: "#f00", finding: { fix: "Brake later." } } as unknown as Annotation;
const dive = { what: "You slow too much.", fix: "Carry speed." } as unknown as Finding;

const ui = (over: Partial<Parameters<typeof CornerRail>[0]> = {}) => (
  <CornerRail cmp={cmp()} trackMap={map} annotations={[]} deepDives={{}} onSeek={() => {}} {...over} />
);

beforeEach(() => {
  localStorage.setItem(CORNER_RAIL_KEY, "open");
});

describe("CornerRail", () => {
  it("lists corners in track order, styling gains apart and giving the cause a direction", () => {
    const { container } = render(ui());
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["gain", "loss"]);
    expect(rows[0]!.textContent).toContain("Early");
    expect(screen.getByText("lower min speed")).toBeTruthy();
    expect(screen.getByText("higher min speed")).toBeTruthy();
  });
  it("seeks to the corner on click", () => {
    const onSeek = vi.fn();
    render(ui({ onSeek }));
    fireEvent.click(screen.getByRole("button", { name: /^Late/ }));
    expect(onSeek).toHaveBeenCalledWith(300);
  });
  it("keeps findings and corner answers under their corner", () => {
    const { container } = render(ui({ annotations: [note], deepDives: { "1": dive } }));
    const row = container.querySelectorAll("li")[1]!;
    expect(row.textContent).toContain("Brake later.");
    expect(row.textContent).toContain("You slow too much.");
  });
  it("filters to losses only", () => {
    render(ui());
    fireEvent.click(screen.getByRole("checkbox", { name: "Losses only" }));
    expect(screen.queryByRole("button", { name: /^Early/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Late/ })).toBeTruthy();
  });
  it("has no coach button, and asks for a comparison when the lap is its own reference", () => {
    const { rerender } = render(ui());
    expect(screen.queryByRole("button", { name: /coach/i })).toBeNull();
    rerender(ui({ cmp: cmp("a") }));
    expect(screen.getByText(/Pick a comparison lap/)).toBeTruthy();
  });
  it("collapses, remembers it, and expands again", () => {
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Hide the corner list" }));
    expect(localStorage.getItem(CORNER_RAIL_KEY)).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Show the corner list" }));
    expect(screen.getByRole("button", { name: /^Late/ })).toBeTruthy();
  });
  it("is collapsed by default below 1400 px and open from 1400 px", () => {
    localStorage.removeItem(CORNER_RAIL_KEY);
    const w = window.innerWidth;
    window.innerWidth = 1200;
    const a = render(ui());
    expect(screen.getByRole("button", { name: "Show the corner list" })).toBeTruthy();
    a.unmount();
    window.innerWidth = 1500;
    render(ui());
    expect(screen.getByRole("button", { name: "Hide the corner list" })).toBeTruthy();
    window.innerWidth = w;
  });
});

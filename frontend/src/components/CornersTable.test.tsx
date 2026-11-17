import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CornerMetrics, CornerSideMetrics, TrackMap } from "../api/types";
import { CornersTable } from "./CornersTable";

const side = (o: Partial<CornerSideMetrics> = {}): CornerSideMetrics => ({
  brake_onset_m: 90, peak_brake: 0.8, min_speed_kmh: 100, min_speed_m: 205, throttle_pickup_m: 230, exit_speed_kmh: 150,
  coast_s: 0.1, overlap_s: 0, steer_corrections: 2, ...o,
});
const corner = (id: string, name: string, start: number) => ({ id, name, start_m: start, apex_m: start + 100, end_m: start + 200, complex: null, approx: false });
const map: TrackMap = {
  track_id: "t", length_m: 1000, corners: [corner("1", "La Source", 0), corner("2", "Eau Rouge", 400)],
  landmarks: [{ id: "b", label: "100 board", kind: "brake_board", distance_m: 95, corner_id: "1", confidence: "detected" }],
};
const metrics: CornerMetrics[] = [
  { corner_id: "2", delta_s: -0.05, lap: side(), ref: side() },
  { corner_id: "1", delta_s: 0.12, lap: side({ brake_onset_m: 80, min_speed_kmh: 98 }), ref: side({ brake_onset_m: 90 }) },
];

describe("CornersTable", () => {
  it("lists a row per corner in track order with lap, reference and difference", () => {
    render(<CornersTable corners={metrics} trackMap={map} onSeek={() => {}} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("La Source")).toBeTruthy();
    expect(within(rows[0]).getByText("+0.120 s")).toBeTruthy();
    expect(within(rows[0]).getByText("10 m earlier")).toBeTruthy();
    expect(within(rows[0]).getByText("−2.0")).toBeTruthy();
  });
  it("shows the landmark phrase on hover where one is close", () => {
    render(<CornersTable corners={metrics} trackMap={map} onSeek={() => {}} />);
    const cell = screen.getAllByRole("row")[1].querySelector("td[title]");
    expect(cell?.getAttribute("title")).toContain("the 100 board");
  });
  it("seeks from a click and from the keyboard-reachable button", () => {
    const onSeek = vi.fn();
    render(<CornersTable corners={metrics} trackMap={map} onSeek={onSeek} />);
    const b = screen.getByRole("button", { name: /Eau Rouge/ });
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(onSeek).toHaveBeenCalledWith(expect.objectContaining({ id: "2", start_m: 400 }));
  });
  it("sorts by time lost, then back to track order", () => {
    const m = [{ ...metrics[0], delta_s: 0.3 }, { ...metrics[1], delta_s: 0.1 }];
    render(<CornersTable corners={m} trackMap={map} onSeek={() => {}} />);
    expect(within(screen.getAllByRole("row")[1]).getByText("La Source")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Time lost" }));
    expect(within(screen.getAllByRole("row")[1]).getByText("Eau Rouge")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Corner" }));
    expect(within(screen.getAllByRole("row")[1]).getByText("La Source")).toBeTruthy();
  });
  it("says so when there are no corners", () => {
    render(<CornersTable corners={[]} trackMap={map} onSeek={() => {}} />);
    expect(screen.getByText(/No corner data/)).toBeTruthy();
  });
});

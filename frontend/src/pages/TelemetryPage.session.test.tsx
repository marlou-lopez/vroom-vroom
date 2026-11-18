// The Session tab on the Telemetry page (vroom-bi4.12): events and laps open a lap in playback; a session without traces gets its own view.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
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

const { engine } = setupMockServer({ allSessions: true });

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}
const search = () => new URLSearchParams(screen.getByTestId("search").textContent ?? "");

function open(path: string) {
  render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={[path]}><TelemetryPage /><Search /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Telemetry page, Session tab", () => {
  it("opens a lap clicked in the lap-time chart against the session's best lap", async () => {
    const race = (await engine().sessions()).find((s) => s.started_at.startsWith("2026-11-10"))!;
    const laps = await engine().sessionLaps(race.session_id);
    const report = await engine().sessionReport(race.session_id);
    const best = report.laps.filter((l) => l.kind === "flying" && l.valid && l.has_trace && l.lap_time_s).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0];
    const target = laps.find((l) => l.lap_no === 4 && l.lap_id !== best.lap_id)!;
    open(`/?lap=${target.lap_id === laps[0].lap_id ? laps[1].lap_id : laps[0].lap_id}`);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Session" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Lap 4 / }));
    await waitFor(() => expect(search().get("lap")).toBe(target.lap_id));
    expect(search().get("ref")).toBe(best.lap_id);
    expect(search().get("at")).toBeNull();
  });

  it("moves the playhead to an event's distance (?at=)", async () => {
    const race = (await engine().sessions()).find((s) => s.started_at.startsWith("2026-11-10"))!;
    const report = await engine().sessionReport(race.session_id);
    const ev = report.events.find((e) => e.distance_m !== null && report.laps.find((l) => l.lap_no === e.lap_from)?.has_trace)!;
    const lap = report.laps.find((l) => l.lap_no === ev.lap_from)!;
    open(`/?lap=${lap.lap_id}`);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Session" }));
    const groups = await screen.findAllByRole("button", { name: new RegExp(ev.sentence.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    fireEvent.click(groups[0]);
    await waitFor(() => expect(search().get("at")).toBe(String(Math.round(ev.distance_m!))));
    expect(search().get("lap")).toBe(lap.lap_id);
    const best = report.laps.filter((l) => l.kind === "flying" && l.valid && l.has_trace && l.lap_time_s).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0];
    expect(search().get("ref")).toBe(best.lap_id === lap.lap_id ? null : best.lap_id);
    // the playhead moved off the start of the lap
    await waitFor(() => expect(Number(screen.getByRole("slider", { name: "Lap position" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0));
  });

  it("shows the Monza race (no traces) as a session report on ?session=", async () => {
    const monza = (await engine().sessions()).find((s) => s.started_at.startsWith("2026-11-09"))!;
    open(`/?session=${monza.session_id}`);
    await screen.findByText(/Playback is not available for this session/);
    expect(screen.queryByRole("tab", { name: "Session" })).toBeNull();
  });
});

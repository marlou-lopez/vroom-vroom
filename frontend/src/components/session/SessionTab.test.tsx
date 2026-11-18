import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { SessionMeta, SessionReport } from "../../api/types";
import { createTestClient, setupMockServer } from "../../test/mockServer";
import { TracelessSession } from "./TracelessSession";
import { SessionTab } from "./SessionTab";

const { server, engine } = setupMockServer({ allSessions: true });

const sessionOn = async (prefix: string): Promise<SessionMeta> => (await engine().sessions()).find((s) => s.started_at.startsWith(prefix))!;
const renderTab = (sessionId: string, onOpen = vi.fn()) => {
  render(<QueryClientProvider client={createTestClient()}><SessionTab sessionId={sessionId} onOpen={onOpen} /></QueryClientProvider>);
  return onOpen;
};

describe("Session tab", () => {
  it("shows the lap-time chart, the session charts with window bands and the event list for the Spa race", async () => {
    const race = await sessionOn("2026-11-10");
    const report = await engine().sessionReport(race.session_id);
    renderTab(race.session_id);
    await screen.findByLabelText("Lap times across the session");
    expect(screen.getByLabelText("Tyre surface temperature per lap")).toBeTruthy();
    expect(screen.getByLabelText("Tyre pressure per lap")).toBeTruthy();
    expect(screen.getByLabelText("Brake disc temperature per lap")).toBeTruthy();
    expect(screen.getByTestId("window-tyre_surface_c-both")).toBeTruthy();
    expect(screen.getByTestId("window-brake_c-front")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Lap 1 / })).toBeTruthy();
    const list = screen.getByRole("region", { name: "Events" });
    expect(within(list).getAllByRole("listitem").length).toBe(report.events.length);
    // the setting change marker carries the event's sentence
    expect(report.events.some((e) => e.kind === "setting_changed")).toBe(true);
    expect(document.querySelectorAll("line title").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Playback is not available/)).toBeNull();
  });

  it("filters the event list by category", async () => {
    const race = await sessionOn("2026-11-10");
    const report = await engine().sessionReport(race.session_id);
    renderTab(race.session_id);
    const list = await screen.findByRole("region", { name: "Events" });
    const cat = report.events[0].category;
    const n = report.events.filter((e) => e.category === cat).length;
    const filters = within(screen.getByRole("group", { name: "Filter events by category" }));
    fireEvent.click(filters.getByRole("button", { name: new RegExp(`^${cat}`) }));
    expect(within(list).getAllByRole("listitem").length).toBe(n);
    fireEvent.click(filters.getByRole("button", { name: new RegExp(`^${cat}`) }));
    expect(within(list).getAllByRole("listitem").length).toBe(report.events.length);
  });

  it("opens the event's lap against the session's best lap, at the event's distance", async () => {
    const race = await sessionOn("2026-11-10");
    const report = await engine().sessionReport(race.session_id);
    const ev = report.events.find((e) => e.distance_m !== null && report.laps.find((l) => l.lap_no === e.lap_from)?.has_trace)!;
    const lap = report.laps.find((l) => l.lap_no === ev.lap_from)!;
    const best = report.laps.filter((l) => l.kind === "flying" && l.valid && l.has_trace && l.lap_time_s).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0];
    const onOpen = renderTab(race.session_id);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(ev.sentence.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
    expect(onOpen).toHaveBeenCalledWith({ lapId: lap.lap_id, refLapId: best.lap_id === lap.lap_id ? null : best.lap_id, distanceM: ev.distance_m });
  });

  it("opens a lock-up trend or repeated-corner event at its corner, on the first lap it names", async () => {
    const race = await sessionOn("2026-11-10");
    const base = await engine().sessionReport(race.session_id);
    const mk = (kind: string, sentence: string, lap_from: number, distance_m: number): SessionReport["events"][number] => ({
      id: `driving-${kind}-x`, category: "driving", kind, severity: "watch", lap_from, lap_to: lap_from + 1, corner: { id: "c9", name: "Bus Stop" },
      distance_m, numbers: { first_runs: 0, last_runs: 4 }, coincides: null, sentence,
    });
    const events = [
      mk("lockup_trend", "Lock-ups at Bus Stop rose from 0 in the first 2 flying laps (laps 1 to 2) to 4 in the last 2 (laps 4 to 5).", 4, 6700),
      mk("lockups", "The car locked a wheel under braking at Bus Stop on 2 of 5 traced laps (4 times, laps 2 to 3).", 2, 6710),
    ];
    server.use(http.get("*/sessions/:id/report", () => HttpResponse.json({ ...base, events })));
    const onOpen = renderTab(race.session_id);
    const best = base.laps.filter((l) => l.kind === "flying" && l.valid && l.has_trace && l.lap_time_s).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0];
    const lapOf = (n: number) => base.laps.find((l) => l.lap_no === n)!;
    fireEvent.click(await screen.findByRole("button", { name: /Lock-ups at Bus Stop rose/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ lapId: lapOf(4).lap_id, refLapId: best.lap_id === lapOf(4).lap_id ? null : best.lap_id, distanceM: 6700 });
    fireEvent.click(screen.getByRole("button", { name: /The car locked a wheel under braking at Bus Stop/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ lapId: lapOf(2).lap_id, refLapId: best.lap_id === lapOf(2).lap_id ? null : best.lap_id, distanceM: 6710 });
  });

  it("opens a lap clicked in the lap-time chart, without a distance", async () => {
    const race = await sessionOn("2026-11-10");
    const report = await engine().sessionReport(race.session_id);
    const lap = report.laps.find((l) => l.lap_no === 3)!;
    const onOpen = renderTab(race.session_id);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^Lap 3 `) }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ lapId: lap.lap_id, distanceM: null }));
  });

  it("on a session without traces says playback is not available and does not open anything", async () => {
    const monza = await sessionOn("2026-11-09");
    const onOpen = renderTab(monza.session_id);
    await screen.findByText(/Playback is not available for this session/);
    const first = await screen.findAllByRole("button", { name: /^Lap \d/ });
    fireEvent.click(first[0]);
    expect(await screen.findByText(/has no trace, so playback is not available for it/)).toBeTruthy();
    const list = screen.getByRole("region", { name: "Events" });
    fireEvent.click(within(list).getAllByRole("button").find((b) => b.getAttribute("data-severity"))!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("lists the categories a session without stint stats could not judge", async () => {
    const practice = await sessionOn("2026-11-03");
    renderTab(practice.session_id);
    const note = await screen.findByText(/Not judged for this session/);
    for (const c of ["tyres", "brakes", "conditions", "settings"]) expect(within(note.closest("div")!).getByText(c)).toBeTruthy();
    // no stint stats: no tyre charts
    expect(screen.queryByLabelText("Tyre pressure per lap")).toBeNull();
  });

  it("shows a loading state, then an error with a retry", async () => {
    const race = await sessionOn("2026-11-10");
    server.use(http.get("*/sessions/:id/report", () => HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 })));
    renderTab(race.session_id);
    expect(screen.getByRole("status").textContent).toMatch(/Loading the session report/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load the session report/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows an empty state for a session with no events and one with no laps", async () => {
    const race = await sessionOn("2026-11-10");
    const base = await engine().sessionReport(race.session_id);
    const answer = (r: SessionReport) => server.use(http.get("*/sessions/:id/report", () => HttpResponse.json(r)));
    answer({ ...base, events: [] });
    const first = render(<QueryClientProvider client={createTestClient()}><SessionTab sessionId={race.session_id} onOpen={() => {}} /></QueryClientProvider>);
    await screen.findByText("No events found in this session.");
    first.unmount();
    answer({ ...base, laps: [], events: [] });
    renderTab(race.session_id);
    await screen.findByText("This session has no laps to report on.");
  });
});

describe("Session without traces on the Telemetry page", () => {
  it("shows the Session tab alone for ?session=", async () => {
    const monza = await sessionOn("2026-11-09");
    render(
      <QueryClientProvider client={createTestClient()}>
        <MemoryRouter initialEntries={[`/?session=${monza.session_id}`]}><TracelessSession sessionId={monza.session_id} /></MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(/recorded without lap traces/);
    await screen.findByLabelText("Lap times across the session");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Session" })).toBeTruthy());
  });
});

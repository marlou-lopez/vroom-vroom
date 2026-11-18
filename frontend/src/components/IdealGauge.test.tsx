import { http, HttpResponse } from "msw";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createTestClient, newestBest, setupMockServer } from "../test/mockServer";
import { IdealBreakdown } from "./IdealBreakdown";
import { LapGaugeTable } from "./LapGaugeTable";
import { SegmentStrip } from "./SegmentStrip";
import type { IdealLap } from "../api/types";

const mock = setupMockServer();

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={createTestClient()}>
    <MemoryRouter>{ui}<Where /></MemoryRouter>
  </QueryClientProvider>
);

describe("SegmentStrip", () => {
  const cells = [
    { label: "A", start_m: 0, end_m: 100, time_s: 5, loss_s: 0, tone: "purple" as const },
    { label: "B", start_m: 100, end_m: 200, time_s: 6.4, loss_s: 0.4, tone: "red" as const },
  ];
  it("is a single labelled picture without a lap", () => {
    render(wrap(<SegmentStrip cells={cells} label="L3 segments" />));
    expect(screen.getByRole("img", { name: "L3 segments: holds 1 of 2 ideal segments" })).toBeTruthy();
  });
  it("makes each cell a keyboard-reachable link to the lap at that segment", async () => {
    const user = userEvent.setup();
    render(wrap(<SegmentStrip cells={cells} lapId="l1" label="L3 segments" />));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /^B: 6.400 s, \+0.400 s/ }));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/?lap=l1&at=100");
  });
});

describe("IdealBreakdown", () => {
  it("opens the source lap at the segment from the keyboard", async () => {
    const ideal: IdealLap = {
      time_s: 20, scope: "session",
      segments: [
        { label: "La Source", corner_id: "c1", start_m: 0, end_m: 120, best_s: 9.5, lap_id: "a", lap_no: 2, session_id: "s" },
        { label: "La Source → Eau Rouge", corner_id: null, start_m: 120, end_m: 400, best_s: 10.5, lap_id: "b", lap_no: 5, session_id: "s" },
      ],
    };
    const user = userEvent.setup();
    render(wrap(<IdealBreakdown ideal={ideal} />));
    const rows = within(screen.getByRole("region", { name: "Ideal lap breakdown" })).getAllByRole("link");
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.textContent).toContain("→")); // link rows show an arrow
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/?lap=b&at=120");
  });
});

describe("laps against the ideal (mock)", () => {
  it("the Sessions table shows every valid lap with its gaps and a segment strip, and the breakdown", async () => {
    const { session, laps } = await newestBest(mock.engine());
    const ideal = await mock.engine().idealLap(session.session_id);
    const valid = laps.filter((l) => l.kind === "flying" && l.valid && l.lap_time_s !== null && l.lap_time_s > 0);
    render(wrap(<LapGaugeTable sessionId={session.session_id} />));
    const table = await screen.findByRole("table");
    await userEvent.click(screen.getByRole("checkbox", { name: /valid only/ }));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(valid.length);
    for (const r of rows) {
      const cells = within(r).getAllByRole("cell");
      expect(cells[3].textContent).toMatch(/^\+\d+\.\d{3}$/);
      expect(cells[4].textContent).toMatch(/^(best|\+\d+\.\d{3})$/);
      expect(within(r).getAllByRole("link").length).toBe(ideal.segments.length + 1);
    }
    expect(within(table).getAllByText("best")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Ideal lap breakdown" })).getAllByRole("link")).toHaveLength(ideal.segments.length);
  });

  it("lists every lap tagged by kind, each traced lap opens at that lap, valid only hides out, in and invalid laps", async () => {
    const { session, laps } = await newestBest(mock.engine());
    render(wrap(<LapGaugeTable sessionId={session.session_id} />));
    const table = await screen.findByRole("table");
    const rows = () => within(table).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(laps.length);
    for (const l of laps) {
      const row = rows().find((r) => within(r).getAllByRole("cell")[0].textContent === `L${l.lap_no}`)!;
      const tag = l.kind === "flying" && !(l.valid_override ?? l.valid) ? "invalid" : l.kind;
      expect(within(row).getAllByRole("cell")[1].textContent).toContain(tag);
      expect(within(row).getByRole("link", { name: `Open lap ${l.lap_no}` })).toBeTruthy();
    }
    expect(laps.some((l) => l.kind === "out")).toBe(true);
    const inLap = laps.find((l) => l.kind === "in")!;
    await userEvent.click(screen.getByRole("link", { name: `Open lap ${inLap.lap_no}` }));
    expect(screen.getByTestId("where").textContent).toBe(`/?lap=${inLap.lap_id}`);
    await userEvent.click(screen.getByRole("checkbox", { name: /valid only/ }));
    expect(rows().every((r) => within(r).getAllByRole("cell")[1].textContent === "flying")).toBe(true);
  });

  it("a lap without a trace is tagged stats only and does not link", async () => {
    const { session, laps } = await newestBest(mock.engine());
    mock.server.use(http.get("*/api/sessions/:id/laps", () => HttpResponse.json(laps.map((l) => ({ ...l, has_trace: false })))));
    render(wrap(<LapGaugeTable sessionId={session.session_id} />));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("stats only")).toHaveLength(laps.length);
    expect(within(table).queryAllByRole("link", { name: /Open lap/ })).toHaveLength(0);
  });
});

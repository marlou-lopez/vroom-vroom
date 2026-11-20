// The Session view of the one-app prototype (vroom-pnw.62), on every mock session (the Spa and Monza recordings).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestClient, setupMockServer } from "../../test/mockServer";
import { AppShell } from "../AppShell";
import { TelemetryPage } from "../../pages/TelemetryPage";

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

vi.mock("../mapviews/registry", () => ({
  TRACK_VIEWS: [{ id: "2d", label: "2D", experimental: false, Component: () => <div data-testid="stub-view" /> }],
}));

const { engine } = setupMockServer({ allSessions: true });

const loc = { search: "" };
function Location() {
  const { search } = useLocation();
  useEffect(() => {
    loc.search = search;
  }, [search]);
  return null;
}

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route element={<AppShell />}><Route index element={<TelemetryPage />} /></Route></Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());

describe("one-app Session view (?scope=session)", () => {
  it("lays the session view out in the decided order, with events folded past five and a lap table that opens the lap", async () => {
    renderAt("/?scope=session");
    const chart = await screen.findByRole("figure", { name: "Lap times across the session" }, { timeout: 5000 });
    const events = await screen.findByRole("region", { name: "Events" });
    const tyres = await screen.findByRole("figure", { name: "Tyre surface temperature per lap" });
    const laps = await screen.findByRole("region", { name: "Laps against the best possible lap" }, { timeout: 5000 });
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(chart, events)).toBe(true);
    expect(follows(events, tyres)).toBe(true);
    expect(follows(tyres, laps)).toBe(true);
    expect(screen.queryByText(/Not judged for this session:\s*$/)).toBeNull();
    const shown = () => within(events).queryAllByRole("button").filter((b) => b.getAttribute("data-severity")).length;
    const more = within(events).queryByRole("button", { name: /^Show all \d+ events$/ });
    expect(more).toBeTruthy();
    expect(shown()).toBe(5);
    await userEvent.click(more!);
    expect(shown()).toBeGreaterThan(5);
    expect(within(events).getByRole("button", { name: /^Show the first 5 only$/ })).toBeTruthy();
    await userEvent.click(within(laps).getAllByRole("link", { name: /^Open lap/ })[0]);
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    expect(loc.search).not.toMatch(/scope=/);
  });

  it("opens a session without traces in the session view, with no way to replay it", async () => {
    renderAt("/?scope=session");
    const pick = await screen.findByRole("combobox", { name: "Session" }, { timeout: 5000 });
    const monza = Array.from((pick as HTMLSelectElement).options).find((o) => /Monza/.test(o.textContent ?? "") && /Race/.test(o.textContent ?? ""));
    expect(monza, Array.from((pick as HTMLSelectElement).options).map((o) => o.textContent).join("|")).toBeTruthy();
    await userEvent.selectOptions(pick, monza!.value);
    await screen.findByText(/Playback is not available/, undefined, { timeout: 5000 });
    expect(screen.queryByRole("complementary", { name: "Where the time goes" })).toBeNull();
  });

  it("opens ?session=<id> without a lap in the session view, for a session without traces", async () => {
    const monza = (await engine().sessions()).find((x) => x.started_at.startsWith("2026-11-09"))!;
    renderAt(`/?session=${monza.session_id}`);
    await screen.findByText(/Playback is not available/, undefined, { timeout: 5000 });
    expect(screen.queryByRole("complementary", { name: "Where the time goes" })).toBeNull();
    expect(screen.queryByText(/Click a lap in the chart/)).toBeNull();
    expect(screen.getByText(/^Not judged for this session: .*[^.]\.$/)).toBeTruthy();
  });
});

// Smoke tests: each page renders against the MSW mock API without an error message.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AppShell } from "../components/AppShell";
import { createTestClient, newestBest, setupMockServer, spaPairs } from "../test/mockServer";
import { formatLapTime } from "../lib/format";
import { SessionsPage } from "./SessionsPage";
import { TelemetryPage } from "./TelemetryPage";
import { TracksPage } from "./TracksPage";

// uPlot draws on a canvas 2D context, which jsdom doesn't have. Stub just the chart class.
vi.mock("uplot", () => ({
  default: class {
    static pxRatio = 1;
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

const mock = setupMockServer();

/** The same tree as `App`, but with a MemoryRouter and a test QueryClient. */
function renderApp(path: string) {
  return render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<TelemetryPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="tracks" element={<TracksPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("pages", () => {
  it("Telemetry loads the default lap, with no error", async () => {
    const { best } = await newestBest(mock.engine());
    renderApp("/");
    expect(await screen.findByRole("button", { name: /Analyze lap/ })).toBeTruthy();
    // The lap picker (in the header slot) names the lap and its time.
    const header = screen.getByRole("banner");
    expect(await within(header).findByText(new RegExp(`L${best.lap_no} ${formatLapTime(best.lap_time_s).replace(".", "\\.")}`))).toBeTruthy();
    expect(screen.queryByText(/unknown_lap|no_laps|Loading…/)).toBeNull();
  });

  it("Telemetry keeps the Analysis bar counts when notes are hidden", async () => {
    // The default lap is its own reference (no findings), so open a lap that has a different reference.
    const [pair] = await spaPairs(mock.engine(), 1);
    renderApp(`/?lap=${pair.lap}&ref=${pair.ref}`);
    const analyze = await screen.findByRole("button", { name: /Analyze lap/ });
    await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(analyze);
    const hide = await screen.findByRole("button", { name: "Hide notes" }, { timeout: 5000 });
    const countRe = /\d+ (issues?|minor|strengths?|inconsistent)/;
    const before = (await screen.findAllByText(countRe, {}, { timeout: 5000 })).map((e) => e.textContent);
    expect(before.length).toBeGreaterThan(0);
    fireEvent.click(hide);
    expect(await screen.findByRole("button", { name: "Show notes" })).toBeTruthy();
    expect(screen.getAllByText(countRe).map((e) => e.textContent)).toEqual(before);
  }, 20000);

  it("Telemetry renders a track without geometry (unknown_track) as a flat track, with no error", async () => {
    mock.server.use(http.get("*/api/tracks/:id/geometry", () => HttpResponse.json({ code: "unknown_track", message: "No geometry" }, { status: 404 })));
    renderApp("/");
    expect(await screen.findByRole("button", { name: /Analyze lap/ })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Track playback" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(/unknown_track|No geometry|Loading…/)).toBeNull();
  });

  it("Telemetry shows an error for an unknown lap", async () => {
    renderApp("/?lap=nope");
    expect(await screen.findByText(/unknown_lap: No lap nope/)).toBeTruthy();
  });

  it("Sessions lists a row per session of the selected track and car", async () => {
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const table = await within(list).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1); // header + at least one session
    expect(within(table).getAllByRole("link", { name: /Open/ }).length).toBeGreaterThan(0);
  });

  it("Tracks shows the corners table", async () => {
    renderApp("/tracks");
    const panel = await screen.findByRole("region", { name: "Corners" });
    const table = await within(panel).findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(await within(table).findAllByRole("row")).not.toHaveLength(1);
  });
  it("Tracks resets the Add landmark form on a second Alt-click without cancelling", async () => {
    // jsdom has no SVG screen matrix: make client coordinates equal map coordinates.
    const proto = SVGSVGElement.prototype as unknown as Record<string, unknown>;
    const orig = { ctm: proto.getScreenCTM, pt: proto.createSVGPoint };
    onTestFinished(() => {
      proto.getScreenCTM = orig.ctm;
      proto.createSVGPoint = orig.pt;
    });
    proto.getScreenCTM = () => ({ inverse: () => ({}) });
    proto.createSVGPoint = () => {
      const pt = { x: 0, y: 0, matrixTransform: () => ({ x: pt.x, y: pt.y }) };
      return pt;
    };
    renderApp("/tracks");
    const svg = await screen.findByRole("img", { name: "Track map" });
    const names = Array.from(svg.querySelectorAll("text"));
    expect(names.length).toBeGreaterThan(2);
    const altClick = (el: Element) => {
      const x = Number(el.getAttribute("x")), y = Number(el.getAttribute("y"));
      const anchor = el.getAttribute("text-anchor");
      fireEvent.click(svg, { altKey: true, clientX: x + (anchor === "start" ? -8 : 8), clientY: y - 2 });
    };
    const first = names[0], second = names[Math.floor(names.length / 2)];
    altClick(first);
    await screen.findByRole("form", { name: "Add landmark" });
    const form = () => screen.getByRole("form", { name: "Add landmark" });
    const corner = () => within(form()).getByRole("combobox", { name: "Corner" }) as HTMLSelectElement;
    const selectedName = () => corner().selectedOptions[0].textContent;
    expect(selectedName()).toBe(first.textContent);
    fireEvent.change(within(form()).getByRole("textbox", { name: "Label" }), { target: { value: "stale label" } });

    altClick(second);
    expect(selectedName()).toBe(second.textContent);
    expect((within(form()).getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("");

    // Submit: the landmark is saved under the second corner, not the first.
    fireEvent.change(within(form()).getByRole("textbox", { name: "Label" }), { target: { value: "second board" } });
    fireEvent.click(within(form()).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add landmark" })).toBeNull());
    fireEvent.click(svg.querySelector(`path[aria-label="${second.textContent}"]`)!);
    // The map's <title> also carries the label; the editor list is what the corner filter changes.
    const inList = () => screen.queryAllByText("second board").filter((e) => e.tagName.toLowerCase() !== "title");
    await waitFor(() => expect(inList()).toHaveLength(1));
    fireEvent.click(svg.querySelector(`path[aria-label="${first.textContent}"]`)!);
    await waitFor(() => expect(inList()).toHaveLength(0));
  });
});

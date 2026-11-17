// Smoke tests: each page renders against the MSW mock API without an error message.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AppRoutes } from "../AppRoutes";
import { createTestClient, newestBest, setupMockServer, spaPairs } from "../test/mockServer";
import { formatLapTime } from "../lib/format";

// uPlot draws on a canvas 2D context, which jsdom doesn't have. Stub just the chart class.
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

const mock = setupMockServer();

/** The real route table, with a MemoryRouter and a test QueryClient. */
function renderApp(path: string) {
  return render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("pages", () => {
  it("an unknown path renders Page not found inside the shell", () => {
    renderApp("/no-such-page");
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByText("/no-such-page")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Telemetry" }).getAttribute("href")).toBe("/");
  });

  it("Telemetry loads the default lap, with no error", async () => {
    const { best } = await newestBest(mock.engine());
    renderApp("/");
    expect(await screen.findByRole("button", { name: /Analyze lap/ })).toBeTruthy();
    // The lap rail marks the studied lap, with its time.
    const rail = await screen.findByRole("complementary", { name: "Laps" });
    const studied = await waitFor(() => {
      const b = rail.querySelector("button[aria-current]");
      expect(b).not.toBeNull();
      return b!;
    });
    expect(studied.textContent).toContain(`L${best.lap_no}`);
    expect(studied.textContent).toContain(formatLapTime(best.lap_time_s));
    await waitFor(() => expect(screen.queryByText(/unknown_lap|no_laps|Loading…/)).toBeNull());
  });

  it("Telemetry opens a lap at ?at=<metres> (from the ideal lap's breakdown)", async () => {
    const { best } = await newestBest(mock.engine());
    renderApp(`/?lap=${best.lap_id}&at=3000`);
    const thumb = await screen.findByRole("slider", { name: "Lap position" });
    await waitFor(() => expect(thumb.getAttribute("aria-valuetext")).not.toBe("0:00.0"));
    const m = /^(\d+):(\d+\.\d)$/.exec(thumb.getAttribute("aria-valuetext")!)!;
    const t = Number(m[1]) * 60 + Number(m[2]);
    expect(t).toBeGreaterThan(30); // 3 km into a Spa lap, minus the lead-in
    expect(t).toBeLessThan(best.lap_time_s!);
  });

  it("Sessions lists each valid lap against the ideal lap", async () => {
    renderApp("/sessions");
    expect(await screen.findByRole("region", { name: "Laps against the ideal" }, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Ideal lap breakdown" })).toBeTruthy();
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

  it("Telemetry shows 'That lap no longer exists' with ways forward for an unknown lap, and keeps the header", async () => {
    renderApp("/?lap=nope");
    expect(await screen.findByText("That lap no longer exists")).toBeTruthy();
    expect(screen.queryByText(/unknown_lap/)).toBeNull();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open latest lap" }).getAttribute("href")).toBe("/");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/sessions");
  });

  it("Telemetry opens on a lap that is not the reference, with no self-comparison note", async () => {
    const { best, laps } = await newestBest(mock.engine());
    expect(best.is_reference).toBe(false);
    const ref = laps.find((l) => l.is_reference);
    renderApp("/");
    await screen.findByRole("button", { name: /Analyze lap/ });
    const rail = await screen.findByRole("complementary", { name: "Laps" });
    await waitFor(() => expect(rail.querySelector("button[aria-current]")?.textContent).toContain(`L${best.lap_no}`));
    expect(screen.queryByRole("note")).toBeNull();
    if (ref) expect(await screen.findByText(/vs reference/)).toBeTruthy();
  });

  it("Telemetry notes a self-comparison and offers the ideal lap", async () => {
    const { laps } = await newestBest(mock.engine());
    const ref = laps.find((l) => l.is_reference)!;
    renderApp(`/?lap=${ref.lap_id}&ref=${ref.lap_id}`);
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/comparison lap/);
    fireEvent.click(within(note).getByRole("button", { name: "Compare with the ideal lap" }));
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });

  it("Sessions lists a row per session of the selected track and car", async () => {
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const table = await within(list).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1); // header + at least one session
    expect(within(table).getAllByRole("link", { name: /Open/ }).length).toBeGreaterThan(0);
  });

  it("Sessions: one selector (the table rows), lap table opens on a session with traces, cards name their session", async () => {
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    await within(list).findByRole("table");
    expect(screen.queryByRole("group", { name: "Session for the lap table" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Laps against the ideal" }, { timeout: 5000 })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Summary" })).getAllByText(/session/i).length).toBeGreaterThan(1);
  });

  it("Sessions: a stats-only session (no lap has a trace) is tagged and shows its stint, not a lap table", async () => {
    const sessions = (await mock.engine().sessions());
    const ids = new Set(sessions.map((x) => x.session_id));
    mock.server.use(http.get("*/api/sessions/:id/laps", async ({ params }) => {
      const laps = await mock.engine().sessionLaps(String(params.id));
      return HttpResponse.json(ids.has(String(params.id)) ? laps.map((l) => ({ ...l, has_trace: false })) : laps);
    }));
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const tags = await within(list).findAllByText("stats only");
    expect(tags.length).toBeGreaterThan(0);
    expect(await screen.findByText(/stats only \(no lap traces\)/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Laps against the ideal" })).toBeNull();
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
  it("Tracks adds a landmark by keyboard path: button, prefilled apex distance, editable distance", async () => {
    renderApp("/tracks");
    const svg = await screen.findByRole("img", { name: "Track map" });
    const names = Array.from(svg.querySelectorAll("text"));
    const target = names[1];
    // Select a corner via its table button (keyboard reachable).
    const table = within(await screen.findByRole("region", { name: "Corners" }));
    const nameBtn = table.getAllByRole("button").find((b) => b.textContent?.replace(" ~", "") === target.textContent)!;
    const apex = Number(nameBtn.closest("tr")!.querySelectorAll("td")[3].textContent?.replace(" m", ""));
    fireEvent.click(nameBtn);

    const panel = within(screen.getByRole("region", { name: "Landmarks" }));
    fireEvent.click(panel.getByRole("button", { name: "Add landmark" }));
    const form = within(await screen.findByRole("form", { name: "Add landmark" }));
    const dist = form.getByRole("spinbutton", { name: "Distance (m)" }) as HTMLInputElement;
    expect(Number(dist.value)).toBe(apex);
    expect((form.getByRole("combobox", { name: "Corner" }) as HTMLSelectElement).selectedOptions[0].textContent).toBe(target.textContent);

    fireEvent.change(dist, { target: { value: "" } });
    expect((form.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dist, { target: { value: String(apex + 5) } });
    fireEvent.change(form.getByRole("textbox", { name: "Label" }), { target: { value: "kbd board" } });
    fireEvent.click(form.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add landmark" })).toBeNull());
    await waitFor(() => expect(panel.getByText("kbd board")).toBeTruthy());
    expect(panel.getByText(new RegExp(`${apex + 5} m`))).toBeTruthy();
  });
});

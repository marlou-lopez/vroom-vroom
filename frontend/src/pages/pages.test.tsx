// Smoke tests: each page renders against the MSW mock API without an error message.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AppRoutes } from "../AppRoutes";
import { createTestClient, newestBest, setupMockServer } from "../test/mockServer";
import { TRACKS_ADVANCED_KEY } from "../lib/tracksAdvanced";

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

// The landmark editor sits behind the Tracks page's Advanced control, closed by default and remembered in localStorage.
function openAdvanced() {
  localStorage.setItem(TRACKS_ADVANCED_KEY, "open");
  onTestFinished(() => localStorage.removeItem(TRACKS_ADVANCED_KEY));
}

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
    expect(await screen.findByRole("button", { name: "Ask the coach" })).toBeTruthy();
    // The scope line's lap select shows the studied lap.
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Lap" }) as HTMLSelectElement).value).toBe(best.lap_id));
    await waitFor(() => expect(screen.queryByText(/unknown_lap|no_laps|Loading…/)).toBeNull());
  });

  it("Telemetry opens a lap at ?at=<metres> (from the best possible lap's breakdown)", async () => {
    const { best } = await newestBest(mock.engine());
    renderApp(`/?lap=${best.lap_id}&at=3000`);
    const thumb = await screen.findByRole("slider", { name: "Lap position" });
    await waitFor(() => expect(thumb.getAttribute("aria-valuetext")).not.toBe("0:00.0"));
    const m = /^(\d+):(\d+\.\d)$/.exec(thumb.getAttribute("aria-valuetext")!)!;
    const t = Number(m[1]) * 60 + Number(m[2]);
    expect(t).toBeGreaterThan(30); // 3 km into a Spa lap, minus the lead-in
    expect(t).toBeLessThan(best.lap_time_s!);
  });

  it("Telemetry renders a track without geometry (unknown_track) as a flat track, with no error", async () => {
    mock.server.use(http.get("*/api/tracks/:id/geometry", () => HttpResponse.json({ code: "unknown_track", message: "No geometry" }, { status: 404 })));
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Ask the coach" })).toBeTruthy();
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

  it("Telemetry opens on a lap that is not the reference, with no self-comparison message", async () => {
    const { best } = await newestBest(mock.engine());
    expect(best.is_reference).toBe(false);
    renderApp("/");
    await screen.findByRole("button", { name: "Ask the coach" });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Lap" }) as HTMLSelectElement).value).toBe(best.lap_id));
    expect(screen.queryByText(/This is the lap you compare with/)).toBeNull();
  });

  it("Telemetry says so on a self-comparison", async () => {
    const { laps } = await newestBest(mock.engine());
    const ref = laps.find((l) => l.is_reference)!;
    renderApp(`/?lap=${ref.lap_id}&ref=${ref.lap_id}`);
    expect(await screen.findByText(/This is the lap you compare with/)).toBeTruthy();
  });

  it("Sessions lists a row per session of the selected track and car", async () => {
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const table = await within(list).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1); // header + at least one session
    expect(within(table).getAllByRole("link", { name: /Open/ }).length).toBeGreaterThan(0);
  });

  it("Sessions: the page is the track-and-car view only, with no lap table, and the date opens the Session view", async () => {
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const table = await within(list).findByRole("table");
    expect(screen.queryByRole("region", { name: "Laps against the best possible lap" })).toBeNull();
    expect(screen.queryByText(/SELECTED SESSION/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "Summary" })).getAllByText(/session/i).length).toBeGreaterThan(1);
    const dates = within(table).getAllByRole("link").filter((a) => a.getAttribute("title") === "Open the session");
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0].getAttribute("href")).toMatch(/scope=session/);
  });

  it("Sessions: a stats-only session (no lap has a trace) is tagged and has no lap to open", async () => {
    const sessions = (await mock.engine().sessions());
    const ids = new Set(sessions.map((x) => x.session_id));
    mock.server.use(http.get("*/api/sessions/:id/laps", async ({ params }) => {
      const laps = await mock.engine().sessionLaps(String(params.id));
      return HttpResponse.json(ids.has(String(params.id)) ? laps.map((l) => ({ ...l, has_trace: false })) : laps);
    }));
    renderApp("/sessions");
    const list = await screen.findByRole("region", { name: "Session list" });
    const tags = await within(list).findAllByText("numbers only, no replay");
    expect(tags.length).toBeGreaterThan(0);
    expect(within(list).queryAllByRole("link", { name: /Open →/ })).toHaveLength(0);
  });

  it("Tracks shows the corners table", async () => {
    renderApp("/tracks");
    const panel = await screen.findByRole("region", { name: "Corners" });
    const table = await within(panel).findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(await within(table).findAllByRole("row")).not.toHaveLength(1);
  });
  it("Tracks opens with the labelled map and a purpose line, and the landmark editor behind a closed Advanced control", async () => {
    localStorage.removeItem(TRACKS_ADVANCED_KEY);
    renderApp("/tracks");
    const svg = await screen.findByRole("img", { name: "Track map" });
    expect(svg.querySelectorAll("text").length).toBeGreaterThan(2); // corner names
    expect(screen.getByText(/The corners of each track you have driven/)).toBeTruthy();
    const adv = screen.getByRole("button", { name: /^Advanced/ });
    expect(adv.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Landmarks" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Re-calibrate/ })).toBeNull();
  });
  it("Tracks opens Advanced on click, remembers it across a reload, and closes it again", async () => {
    localStorage.removeItem(TRACKS_ADVANCED_KEY);
    onTestFinished(() => localStorage.removeItem(TRACKS_ADVANCED_KEY));
    const first = renderApp("/tracks");
    fireEvent.click(await screen.findByRole("button", { name: /^Advanced/ }));
    expect(await screen.findByRole("region", { name: "Landmarks" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-calibrate/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Advanced/ }).getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    renderApp("/tracks"); // a reload
    expect(await screen.findByRole("region", { name: "Landmarks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    expect(screen.queryByRole("region", { name: "Landmarks" })).toBeNull();
    expect(localStorage.getItem(TRACKS_ADVANCED_KEY)).toBe("closed");
  });
  it("Tracks still opens, closed, when storage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    onTestFinished(() => spy.mockRestore());
    renderApp("/tracks");
    expect((await screen.findByRole("button", { name: /^Advanced/ })).getAttribute("aria-expanded")).toBe("false");
  });
  it("Tracks resets the Add landmark form on a second Alt-click without cancelling", async () => {
    openAdvanced();
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
      fireEvent.click(svg, { altKey: true, clientX: Number(el.getAttribute("data-ax")), clientY: Number(el.getAttribute("data-ay")) });
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
    openAdvanced();
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
  it("Tracks deletes a landmark with an undo toast that restores it, and groups landmarks under corner names", async () => {
    openAdvanced();
    renderApp("/tracks");
    const panel = within(await screen.findByRole("region", { name: "Landmarks" }));
    const del = (await panel.findAllByRole("button", { name: /^Delete / }))[0];
    const label = del.getAttribute("aria-label")!.replace("Delete ", "");
    const before = panel.getAllByRole("button", { name: /^Delete / }).length;
    expect(panel.getAllByRole("group").length).toBeGreaterThan(0);
    expect(panel.queryByText(/brake_board|kerb_entry/)).toBeNull();
    fireEvent.click(del);
    const toast = await screen.findByText(`Deleted ${label}`);
    await waitFor(() => expect(panel.getAllByRole("button", { name: /^Delete / }).length).toBe(before - 1));
    fireEvent.click(within(toast.parentElement!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(panel.getAllByRole("button", { name: /^Delete / }).length).toBe(before));
    expect(screen.queryByText(`Deleted ${label}`)).toBeNull();
  });
});

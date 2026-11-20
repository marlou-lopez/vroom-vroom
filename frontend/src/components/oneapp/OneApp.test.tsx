// The one app (vroom-pnw.58, default since vroom-pnw.64): the Lap view at `/`.
import { render, screen, waitFor, within } from "@testing-library/react";
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

setupMockServer();

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

describe("one app Lap view", () => {
  it("shows the lap scope, without a lap rail", async () => {
    renderAt("/");
    const story = await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    expect(screen.queryByRole("complementary", { name: "Laps" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Replay this corner/ }).length).toBeGreaterThan(0);
    expect(story.textContent).toMatch(/slower than/);
    // The first crumb opens the Track and car view on this session's own track and car (vroom-pnw.65).
    const crumb = within(screen.getByRole("navigation", { name: "Where you are" })).getAllByRole("link")[0];
    expect(crumb.getAttribute("href")).toMatch(/^\/sessions\?session=/);
  });

  it("has no inputs tabs, and keeps view, zoom and Choose strips in one strip menu (vroom-pnw.63)", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose strips" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Playback speed" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Strip menu" }));
    const menu = await screen.findByRole("dialog", { name: "Strip menu" });
    expect(within(menu).getByRole("radio", { name: "Wheel & pedals" })).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Whole lap" })).toBeTruthy();
    expect(within(menu).getByRole("list", { name: "Shown strips" })).toBeTruthy();
    // The wheels view keeps the menu, so the user can switch back.
    await userEvent.click(within(menu).getByRole("radio", { name: "Wheel & pedals" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "Strip menu" }));
    expect(within(await screen.findByRole("dialog", { name: "Strip menu" })).getByRole("radio", { name: "Graphs" })).toBeTruthy();
  });

  it("puts the playback speeds in a menu next to Play", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    await userEvent.click(await screen.findByRole("button", { name: /Playback speed: 1×/ }));
    const menu = await screen.findByRole("dialog", { name: "Playback speed" });
    await userEvent.click(within(menu).getByRole("radio", { name: "2×" }));
    expect(await screen.findByRole("button", { name: /Playback speed: 2×/ })).toBeTruthy();
  });

  it("opens the session scope with a short summary", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    const where = screen.getByRole("navigation", { name: "Where you are" });
    await userEvent.click(within(where).getByRole("button", { name: /·/ }));
    await screen.findByText(/timed and valid/, undefined, { timeout: 5000 });
    await waitFor(() => expect(loc.search).toMatch(/scope=session/));
  });

  it("steps through laps with the buttons and the arrow keys, and shows each lap's gap", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    const select = screen.getByRole("combobox", { name: "Lap" }) as HTMLSelectElement;
    expect(Array.from(select.options).some((o) => /· (best|\+\d+\.\d{3})$/.test(o.textContent ?? ""))).toBe(true);
    const ids = Array.from(select.options).map((o) => o.value);
    expect(ids.length).toBeGreaterThan(2);
    const at = () => new URLSearchParams(loc.search).get("lap");
    await waitFor(() => expect(at()).toBe(select.value));
    const start = ids.indexOf(select.value);
    const next = screen.getByRole("button", { name: "Next lap" }) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: "Previous lap" }) as HTMLButtonElement;
    if (start < ids.length - 1) {
      await userEvent.click(next);
      await waitFor(() => expect(at()).toBe(ids[start + 1]));
      await userEvent.keyboard("{ArrowUp}");
      await waitFor(() => expect(at()).toBe(ids[start]));
    } else {
      expect(next.disabled).toBe(true);
      await userEvent.click(prev);
      await waitFor(() => expect(at()).toBe(ids[start - 1]));
    }
  });

  it("goes back to the current lap from the session scope", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    await waitFor(() => expect(new URLSearchParams(loc.search).get("lap")).toBeTruthy());
    const lapId = new URLSearchParams(loc.search).get("lap");
    const where = screen.getByRole("navigation", { name: "Where you are" });
    await userEvent.click(within(where).getByRole("button", { name: /·/ }));
    await screen.findByText(/timed and valid/, undefined, { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: /Back to the lap/ }));
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    expect(loc.search).not.toMatch(/scope=/);
    expect(new URLSearchParams(loc.search).get("lap")).toBe(lapId);
  });

  it("pins the lap sentence above the cards and counts every corner", async () => {
    renderAt("/");
    const story = await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    const head = story.querySelector("header")!;
    expect(head.textContent).toMatch(/Lap \d+/);
    expect(head.contains(story.querySelector("ol"))).toBe(false);
    const toggle = within(story).getByRole("button", { name: /Every corner · \d+/ });
    const n = Number(/· (\d+)/.exec(toggle.textContent ?? "")![1]);
    expect(within(story).queryByRole("list", { name: "Every corner" })).toBeNull();
    await userEvent.click(toggle);
    expect(within(within(story).getByRole("list", { name: "Every corner" })).getAllByRole("listitem")).toHaveLength(n);
    // No advice text appears on two cards.
    const tips = Array.from(story.querySelectorAll("ol > li")).map((li) => li.querySelector("p:nth-of-type(2)")?.textContent).filter(Boolean);
    expect(new Set(tips).size).toBe(tips.length);
  });

  it("puts Key, notes, Average and the coach in the ⋯ menu", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: /More: key/ }));
    const menu = await screen.findByRole("dialog", { name: "More" });
    expect(within(menu).getByRole("button", { name: /^Hide notes/ })).toBeTruthy();
    expect(within(menu).getByRole("button", { name: /Average/ })).toBeTruthy();
    expect(within(menu).queryByRole("button", { name: "Ask again" })).toBeNull();
    await userEvent.click(within(menu).getByRole("button", { name: /^Key/ }));
    expect(within(menu).getByText("Coach marks")).toBeTruthy();
  });

  it("keeps the scope line and story mounted while the next lap loads", { timeout: 20000 }, async () => {
    renderAt("/");
    const story = await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    const scope = screen.getByRole("navigation", { name: "Where you are" });
    const select = screen.getByRole("combobox", { name: "Lap" }) as HTMLSelectElement;
    const ids = Array.from(select.options).map((o) => o.value);
    const target = ids.find((i) => i !== select.value)!;
    await userEvent.selectOptions(select, target);
    // Straight after the click and once the new lap has loaded: the same elements, never a "Loading…" page.
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(story.isConnected && scope.isConnected).toBe(true);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Lap" }) as HTMLSelectElement).value).toBe(target));
    await waitFor(() => expect(story.querySelector("h1")?.textContent).toMatch(new RegExp(`Lap ${(select.selectedOptions[0].textContent ?? "").match(/Lap (\d+)/)![1]} `)), { timeout: 5000 });
    expect(story.isConnected && scope.isConnected).toBe(true);
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

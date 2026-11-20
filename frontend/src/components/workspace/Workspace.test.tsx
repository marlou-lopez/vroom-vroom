// The lap rail and the Telemetry layout (vroom-pnw.33).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveValid } from "../../api/types";
import { createTestClient, newestBest, setupMockServer } from "../../test/mockServer";
import { LapRail } from "./LapRail";
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

const mock = setupMockServer();

const loc = { search: "" };
function Location() {
  const { search } = useLocation();
  useEffect(() => {
    loc.search = search;
  }, [search]);
  return null;
}

beforeEach(() => {
  try {
    localStorage.removeItem("vroom.lapRail");
  } catch {
    // no storage
  }
});

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={createTestClient()}>
      <MemoryRouter initialEntries={[url]}>
        <TelemetryPage />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("lap rail", () => {
  it("is the lap picker: no header pickers, no experimental flag, and no self-comparison status", async () => {
    renderAt("/");
    const laps = await screen.findByRole("complementary", { name: "Laps" });
    await within(laps).findAllByRole("button", { name: /^L\d/ });
    expect(screen.queryByText("Experimental")).toBeNull();
    expect(within(laps).queryByRole("status")).toBeNull();
    expect(within(laps).getByRole("combobox", { name: "Session" })).toBeTruthy();
    expect(within(laps).getByRole("group", { name: "Compare with" })).toBeTruthy();
    // A lap row shows its time and gap to the best lap.
    const gaps = within(laps).getAllByRole("button", { name: /^L\d/ }).map((b) => b.textContent ?? "");
    expect(gaps.some((t) => /best/.test(t))).toBe(true);
    expect(gaps.some((t) => /\+\d+\.\d{3}/.test(t))).toBe(true);
  });

  it("studies a lap on Enter, keeping other params, and sets it as the comparison on R", async () => {
    const user = userEvent.setup();
    const slow = { timeout: 10000 }; // the first load of the 5 MB recording can take seconds on a busy runner
    renderAt("/?debug=0");
    // Let the page settle first, or the keys below go to an element that is about to be replaced (vroom-4la):
    // 1) the default lap is written to the URL, 2) the comparison candidates have loaded (R does nothing
    // before that, and the rows render before it; a row's Compare button only exists once its lap is a candidate).
    await waitFor(() => expect(loc.search).toContain("lap="), slow);
    const laps = await screen.findByRole("complementary", { name: "Laps" }, slow);
    await within(laps).findAllByRole("button", { name: /^Compare with L/ }, slow);
    const rows = await within(laps).findAllByRole("button", { name: /^L\d/ }, slow);
    const studied = rows.find((b) => b.hasAttribute("aria-current"))!;
    const others = rows.filter((b) => b !== studied && !b.hasAttribute("aria-current"));
    const target = others[0];
    target.focus();
    await user.keyboard("r");
    await waitFor(() => expect(loc.search).toContain("ref="), slow);
    const refId = new URLSearchParams(loc.search).get("ref");
    expect(refId).toBe(target.getAttribute("data-lap-id"));
    expect(loc.search).toContain("debug=0");

    const next = others[1];
    next.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(new URLSearchParams(loc.search).get("lap")).toBe(next.getAttribute("data-lap-id")), slow);
    expect(loc.search).toContain("debug=0");
  }, 20000);

  it("moves between rows with the arrow keys", async () => {
    const user = userEvent.setup();
    renderAt("/");
    const laps = await screen.findByRole("complementary", { name: "Laps" });
    const rows = await within(laps).findAllByRole("button", { name: /^L\d/ });
    rows[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("picks the ideal lap as the comparison from the quick picks, and names it", async () => {
    const user = userEvent.setup();
    renderAt("/");
    const laps = await screen.findByRole("complementary", { name: "Laps" });
    await user.click(await within(laps).findByRole("button", { name: /^Best possible lap/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("ref")).toMatch(/^ideal:/));
    expect(await within(laps).findByText(/compared with best possible lap/)).toBeTruthy();
    // The map read-out says where you stand against it.
    expect(await screen.findAllByText(/(behind|ahead of) best possible lap/)).not.toHaveLength(0);
  });

  it("changes session from the selector and opens that session's lap", async () => {
    const user = userEvent.setup();
    renderAt("/");
    const laps = await screen.findByRole("complementary", { name: "Laps" });
    const select = await within(laps).findByRole("combobox", { name: "Session" });
    const sessions = await mock.engine().sessions();
    const other = sessions.find((s) => s.session_id !== (select as HTMLSelectElement).value)!;
    const before = new URLSearchParams(loc.search).get("lap");
    await user.selectOptions(select, other.session_id);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("lap")).not.toBe(before));
    const lapId = new URLSearchParams(loc.search).get("lap")!;
    expect((await mock.engine().lap(lapId)).session_id).toBe(other.session_id);
  });

  it("collapses to a strip, remembers it, and expands again", async () => {
    const user = userEvent.setup();
    const first = renderAt("/");
    await screen.findByRole("combobox", { name: "Session" });
    await user.click(screen.getByRole("button", { name: "Hide the lap list" }));
    expect(screen.queryByRole("combobox", { name: "Session" })).toBeNull();
    first.unmount();

    renderAt("/");
    await screen.findByRole("button", { name: "Show the lap list" });
    expect(screen.queryByRole("combobox", { name: "Session" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the lap list" }));
    expect(await screen.findByRole("combobox", { name: "Session" })).toBeTruthy();
  });
});

describe("lap rail props", () => {
  const session = { session_id: "s1", track_name: "T", car_name: "C", started_at: "2026-11-03T10:00:00Z" } as never;
  const mk = (id: string, no: number, over: object = {}) =>
    ({ lap_id: id, lap_no: no, lap_time_s: 100 + no, kind: "flying", valid: true, valid_override: null, is_reference: false, pinned_reference: false, ...over }) as never;
  const cand = (lap_id: string) => ({ lap_id, label: lap_id, lap_time_s: 100, car_name: "C", is_reference: false, is_previous: false, other_car: false, is_ideal: false });
  const wrapper = () => ({ wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={createTestClient()}>{children}</QueryClientProvider> });

  it("lists an invalid lap that is studied or compared even with 'valid only', and hides other invalid ones", () => {
    const laps = [mk("a", 1), mk("b", 2, { valid: false }), mk("c", 3, { valid: false }), mk("d", 4, { valid: false })];
    render(
      <LapRail session={session} laps={laps} lap={laps[1]} refLapId="c" candidates={[cand("a"), cand("c")]} warning={null}
        onSelectLap={() => {}} onSelectRef={() => {}} />,
      wrapper(),
    );
    const list = screen.getByRole("list", { name: "Session laps" });
    const names = within(list).getAllByRole("button", { name: /^L\d/ }).map((b) => b.textContent?.slice(0, 3));
    expect(names.some((t) => t?.includes("L1"))).toBe(true);
    expect(names.some((t) => t?.includes("L2"))).toBe(true);
    expect(names.some((t) => t?.includes("L3"))).toBe(true);
    expect(names.some((t) => t?.includes("L4"))).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide laps with track-limit cuts/ }));
    expect(within(list).getAllByRole("button", { name: /^L\d/ })).toHaveLength(4);
  });

  it("says where an invalid lap likely went wrong, as a guess, and nothing on a valid lap", () => {
    const bad = mk("a", 5, { valid: false });
    const { unmount } = render(
      <LapRail session={session} laps={[bad]} lap={bad} refLapId={null} candidates={[]} warning={null} invalidHint="invalid: Raidillon exit?" onSelectLap={() => {}} onSelectRef={() => {}} />,
      wrapper(),
    );
    expect(screen.getByText(/invalid: Raidillon exit\?/)).toBeTruthy();
    unmount();
    const good = mk("a", 5);
    render(<LapRail session={session} laps={[good]} lap={good} refLapId={null} candidates={[]} warning={null} invalidHint="invalid: Raidillon exit?" onSelectLap={() => {}} onSelectRef={() => {}} />, wrapper());
    expect(screen.queryByText(/invalid/)).toBeNull();
  });

  it("offers laps of other sessions as the comparison", () => {
    const laps = [mk("a", 1)];
    const picked: (string | null)[] = [];
    render(
      <LapRail session={session} laps={laps} lap={laps[0]} refLapId={null} candidates={[cand("a"), cand("z")]} warning={null} onSelectLap={() => {}} onSelectRef={(id) => picked.push(id)} />,
      wrapper(),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Compare with another day" }), { target: { value: "z" } });
    expect(picked).toEqual(["z"]);
  });

  it("flags a different car, and names the comparison lap of this session", () => {
    const laps = [mk("a", 1), mk("b", 7)];
    render(
      <LapRail session={session} laps={laps} lap={laps[0]} refLapId="b" candidates={[cand("b")]} warning="Different car" onSelectLap={() => {}} onSelectRef={() => {}} />,
      wrapper(),
    );
    expect(screen.getByText("DIFFERENT CAR")).toBeTruthy();
    expect(screen.getByText(/compared with L7/)).toBeTruthy();
  });
});

describe("lap rail manual validity", () => {
  it("offers 'Reset to automatic' for a manual mark, and it clears the override", async () => {
    const { best, session } = await newestBest(mock.engine());
    const auto = effectiveValid(best);
    await mock.engine().patchLap(best.lap_id, { valid_override: !auto });
    const user = userEvent.setup();
    renderAt(`/?lap=${best.lap_id}`);
    await screen.findByRole("complementary", { name: "Laps" });
    await user.click(await screen.findByRole("button", { name: `Actions for L${best.lap_no}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset to automatic" }));
    await waitFor(async () => {
      const lap = (await mock.engine().sessionLaps(session.session_id)).find((l) => l.lap_id === best.lap_id)!;
      expect(lap.valid_override).toBeNull();
    });
  });

  it("does not offer the reset while validity is automatic", async () => {
    const { best } = await newestBest(mock.engine());
    const user = userEvent.setup();
    renderAt(`/?lap=${best.lap_id}`);
    await user.click(await screen.findByRole("button", { name: `Actions for L${best.lap_no}` }));
    await screen.findByRole("menuitem", { name: /^Mark / });
    expect(screen.queryByRole("menuitem", { name: "Reset to automatic" })).toBeNull();
  });
});

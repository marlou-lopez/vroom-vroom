// The Simple view mode of the Telemetry page (vroom-pnw.56): chosen by the header switch and remembered per browser.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestClient, setupMockServer } from "../../test/mockServer";
import { AppShell } from "../AppShell";
import { TelemetryPage } from "../../pages/TelemetryPage";
import { UI_MODE_KEY } from "../../lib/uiMode";

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

describe("Simple view mode", () => {
  it("opens the full view on a first visit and offers the switch in the header", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Laps" }, { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Where you lose the most time" })).toBeNull();
    const sw = screen.getByRole("radiogroup", { name: "Page mode" });
    expect(within(sw).getByRole("radio", { name: "Full" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the biggest losses in plain words, with different tips, no banner and no ui flag", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByRole("complementary", { name: "Laps" }, { timeout: 5000 });
    await user.click(screen.getByRole("radio", { name: "Simple" }));
    const losses = await screen.findByRole("region", { name: "Where you lose the most time" }, { timeout: 5000 });
    expect(localStorage.getItem(UI_MODE_KEY)).toBe("simple");
    expect(screen.queryByText("Experimental")).toBeNull();
    const rows = within(losses).getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0].textContent).toMatch(/\d\.\d{2} s slower/);
    const tips = Array.from(losses.querySelectorAll("li")).map((li) => li.textContent?.match(/Try:(.*)$/)?.[1]).filter(Boolean);
    expect(new Set(tips).size).toBe(tips.length);
    expect(screen.queryByRole("complementary", { name: "Laps" })).toBeNull();

    const select = screen.getByRole("combobox");
    const other = Array.from((select as HTMLSelectElement).options).find((o) => !o.selected)!;
    await user.selectOptions(select, other.value);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("lap")).toBe(other.value));
    expect(loc.search).not.toContain("ui=");
  });

  it("is remembered: a saved choice opens the Simple view, and Full switches back", async () => {
    const user = userEvent.setup();
    localStorage.setItem(UI_MODE_KEY, "simple");
    renderAt("/");
    await screen.findByRole("region", { name: "Where you lose the most time" }, { timeout: 5000 });
    await user.click(screen.getByRole("radio", { name: "Full" }));
    await screen.findByRole("complementary", { name: "Laps" }, { timeout: 5000 });
    expect(localStorage.getItem(UI_MODE_KEY)).toBe("full");
  });

  it("'Replay this corner' opens the full view at that corner", async () => {
    const user = userEvent.setup();
    localStorage.setItem(UI_MODE_KEY, "simple");
    renderAt("/");
    await screen.findByRole("region", { name: "Where you lose the most time" }, { timeout: 5000 });
    await user.click(await screen.findByRole("button", { name: "Replay this corner in the full view" }));
    await screen.findByRole("complementary", { name: "Laps" }, { timeout: 5000 });
    expect(new URLSearchParams(loc.search).get("at")).not.toBeNull();
    // One replay does not change the remembered choice.
    expect(localStorage.getItem(UI_MODE_KEY)).toBe("simple");
  });
});

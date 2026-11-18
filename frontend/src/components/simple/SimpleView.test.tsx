// The experimental Simple view (spike vroom-pnw.50): only behind ?ui=simple; the default page is unchanged.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createTestClient, setupMockServer } from "../../test/mockServer";
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
        <TelemetryPage />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Simple view (experimental, ?ui=simple)", () => {
  it("shows the labelled prototype with the biggest losses in plain words, and keeps the flag on lap changes", async () => {
    const user = userEvent.setup();
    renderAt("/?ui=simple");
    const losses = await screen.findByRole("region", { name: "Where you lose the most time" });
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the full view" }).getAttribute("href")).not.toContain("ui=simple");
    const rows = within(losses).getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0].textContent).toMatch(/\d\.\d{2} s slower/);
    // The default page's rails and transport are not rendered.
    expect(screen.queryByRole("complementary", { name: "Laps" })).toBeNull();

    const select = screen.getByRole("combobox");
    const other = Array.from((select as HTMLSelectElement).options).find((o) => !o.selected)!;
    await user.selectOptions(select, other.value);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("lap")).toBe(other.value));
    expect(loc.search).toContain("ui=simple");
  });

  it("is off by default: the full page renders without it", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Laps" });
    expect(screen.queryByRole("region", { name: "Where you lose the most time" })).toBeNull();
    expect(screen.queryByText("Experimental")).toBeNull();
  });
});

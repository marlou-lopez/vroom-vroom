// EXPERIMENTAL workspace layout (vroom-pnw.30): only behind ?ui=workspace, and the flag survives lap changes.
import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("workspace layout prototype", () => {
  it("is not rendered without the flag", async () => {
    renderAt("/");
    await screen.findByTestId("stub-view");
    expect(screen.queryByText("Experimental")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Laps" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Corners" })).toBeNull();
  });

  it("renders both rails behind ?ui=workspace and keeps the flag when a lap is picked", async () => {
    renderAt("/?ui=workspace");
    const laps = await screen.findByRole("complementary", { name: "Laps" });
    expect(screen.getByText("Experimental")).toBeTruthy();
    // The default landing is a non-reference lap (vroom-pnw.31), so the rail has no self-comparison status.
    await within(laps).findAllByRole("button", { name: /L\d/ });
    expect(within(laps).queryByRole("status")).toBeNull();
    expect(loc.search).toContain("ui=workspace");

    const other = within(laps).getAllByRole("button").find((b) => /^L\d/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("aria-current"));
    expect(other).toBeDefined();
    fireEvent.click(other!);
    const corners = await screen.findByRole("complementary", { name: "Corners" });
    await within(corners).findByRole("button", { name: /Ask the coach/ });
    expect(loc.search).toContain("ui=workspace");
    expect(loc.search).toContain("lap=");
    // Every corner of the comparison is listed, each seeking to the corner.
    expect((await within(corners).findAllByRole("button", { name: /Seek to the corner/ })).length).toBeGreaterThan(3);
  });
});

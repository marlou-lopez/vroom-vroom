// EXPERIMENTAL overhaul prototype (vroom-pnw.58): `?ui=one` shows the lap and session scopes; without it nothing changes.
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

describe("one-app prototype (?ui=one)", () => {
  it("shows the lap scope, labelled experimental, without the lap rail", async () => {
    renderAt("/?ui=one");
    const story = await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    expect(screen.getByText("Experimental UI")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Laps" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Replay this corner/ }).length).toBeGreaterThan(0);
    expect(story.textContent).toMatch(/slower than/);
  });

  it("opens the session scope with a short summary", async () => {
    renderAt("/?ui=one");
    await screen.findByRole("complementary", { name: "Where the time goes" }, { timeout: 5000 });
    const where = screen.getByRole("navigation", { name: "Where you are" });
    await userEvent.click(within(where).getByRole("button", { name: /·/ }));
    await screen.findByText(/timed and valid/, undefined, { timeout: 5000 });
    await waitFor(() => expect(loc.search).toMatch(/scope=session/));
    expect(loc.search).toMatch(/ui=one/);
  });

  it("leaves the current UI alone without the flag", async () => {
    renderAt("/");
    await screen.findByRole("complementary", { name: "Laps" }, { timeout: 5000 });
    expect(screen.queryByText("Experimental UI")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Where you are" })).toBeNull();
  });
});

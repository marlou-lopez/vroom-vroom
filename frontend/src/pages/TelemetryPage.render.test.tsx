// The memoised track views must not render for page state they don't draw (vroom-pnw.29).
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createTestClient, setupMockServer } from "../test/mockServer";
import { TelemetryPage } from "./TelemetryPage";

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

const renders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../components/mapviews/registry", async () => {
  const { memo } = await import("react");
  const Stub = memo(function StubView() {
    renders.count++;
    return <div data-testid="stub-view" />;
  });
  return { TRACK_VIEWS: [{ id: "2d", label: "2D", experimental: false, Component: Stub }] };
});

setupMockServer();

describe("Telemetry page render stability", () => {
  it("does not re-render the memoised track view when only the input view changes", async () => {
    render(
      <QueryClientProvider client={createTestClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <TelemetryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId("stub-view");
    // Let the data, coach queries and URL sync settle, so the count is steady before the toggle.
    await screen.findByRole("button", { name: /Analyze lap/ });
    await new Promise((r) => setTimeout(r, 200));
    const before = renders.count;
    expect(before).toBeGreaterThan(0);

    const simplified = screen.getByRole("radio", { name: "Simplified" });
    fireEvent.click(simplified);
    await screen.findByRole("radio", { name: "Simplified", checked: true });
    expect(renders.count).toBe(before);

    fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
    await screen.findByRole("radio", { name: "Detailed", checked: true });
    expect(renders.count).toBe(before);
  });
});

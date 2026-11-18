import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Annotation } from "../lib/annotations";
import type { CoachState } from "../state/useCoach";
import { AnalysisBar } from "./AnalysisBar";

function coach(over: Partial<CoachState> = {}): CoachState {
  return {
    results: { analyze: { cost_usd: 0.013, findings: [], focus: null } },
    running: null, error: null, failedCommand: null, cancel: vi.fn(), showNotes: true, setShowNotes: vi.fn(),
    deepDives: {}, run: vi.fn(), askCorner: vi.fn(), setReviewed: vi.fn(), ...over,
  } as unknown as CoachState;
}
const bar = (c: CoachState, extra: Partial<Parameters<typeof AnalysisBar>[0]> = {}) =>
  render(<AnalysisBar coach={c} annotations={[] as Annotation[]} totalDelta={0.051} refName="ideal" disabled={false} {...extra} />);

describe("AnalysisBar", () => {
  it("labels the total and names the comparison", () => {
    bar(coach());
    expect(screen.getByText("Lap Δ")).toBeTruthy();
    expect(screen.getByText("+0.051 s")).toBeTruthy();
    expect(screen.getByText(/behind ideal/)).toBeTruthy();
  });

  it("uses the same threshold for the words and the number", () => {
    bar(coach(), { totalDelta: 0.003 });
    expect(screen.queryByText(/behind|ahead/)).toBeNull();
  });

  it("labels the cost and explains it", () => {
    bar(coach());
    const cost = screen.getByText("Coach cost $0.013");
    expect(cost.getAttribute("title")).toMatch(/language model/);
  });

  it("explains the marks in a key", async () => {
    bar(coach());
    await userEvent.setup().click(screen.getByRole("button", { name: "What the marks mean" }));
    expect(screen.getByText(/Inconsistent/)).toBeTruthy();
    expect(screen.getByText("FEEL")).toBeTruthy();
  });

  it("shows progress and a Cancel while running", async () => {
    const c = coach({ running: "analyze" });
    bar(c);
    expect(screen.getByRole("status").textContent).toMatch(/Analyzing/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(c.cancel).toHaveBeenCalled();
  });

  it("shows a plain sentence with Retry, not code: message", async () => {
    const c = coach({ results: {}, error: { code: "llm_error", message: "502 upstream" }, failedCommand: "analyze" });
    bar(c);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toMatch(/llm_error|502/);
    expect(alert.textContent).toMatch(/didn't answer/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(c.run).toHaveBeenCalledWith("analyze");
  });
});

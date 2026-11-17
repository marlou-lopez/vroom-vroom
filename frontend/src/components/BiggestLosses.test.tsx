import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BiggestLosses } from "./BiggestLosses";

const l = (cornerId: string, name: string, deltaS: number) => ({ cornerId, name, deltaS, cause: "brake" as const, startM: 10 });

describe("BiggestLosses", () => {
  it("renders items as buttons that seek", () => {
    const onSeek = vi.fn();
    render(<BiggestLosses result={{ losses: [l("1", "La Source", 0.12)], gain: l("2", "Eau Rouge", -0.05) }} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole("button", { name: /La Source/ }));
    expect(onSeek).toHaveBeenCalledWith(expect.objectContaining({ cornerId: "1" }));
    expect(screen.getByText("−0.050 s")).toBeTruthy();
    expect(screen.getAllByText("braking")).toHaveLength(2);
  });
  it("renders nothing without a result", () => {
    const { container } = render(<BiggestLosses result={null} onSeek={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

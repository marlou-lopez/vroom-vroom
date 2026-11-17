import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useSessionLaps } from "../api/queries";
import { effectiveValid } from "../api/types";
import { createQueryWrapper, newestBest, setupMockServer } from "../test/mockServer";
import { LapPicker } from "./LapPicker";

const mock = setupMockServer();

/** LapPicker fed from the real laps query, so a patch refetches and re-renders it like on the Telemetry page. */
function Harness({ sessionId, lapId }: { sessionId: string; lapId: string }) {
  const laps = useSessionLaps(sessionId).data;
  const lap = laps?.find((l) => l.lap_id === lapId);
  if (!laps || !lap) return null;
  const session = { track_name: "T", car_name: "C", started_at: "2026-11-03T10:00:00Z" } as never;
  return <LapPicker session={session} laps={laps} lap={lap} refLapId={null} warning={null} candidates={[]} onSelectLap={() => {}} onSelectRef={() => {}} />;
}

describe("LapPicker manual validity", () => {
  it("offers 'Reset to automatic' for a manual mark, and it clears the override", async () => {
    const { best, session } = await newestBest(mock.engine());
    const auto = effectiveValid(best);
    await mock.engine().patchLap(best.lap_id, { valid_override: !auto });
    const { wrapper } = createQueryWrapper();
    const user = userEvent.setup();
    render(<Harness sessionId={session.session_id} lapId={best.lap_id} />, { wrapper });

    await user.click(await screen.findByText(/^● L/));
    expect((await screen.findAllByText("MANUAL")).length).toBeGreaterThan(0);
    await user.click(await screen.findByRole("menuitem", { name: "Reset to automatic" }));

    await waitFor(async () => {
      const lap = (await mock.engine().sessionLaps(session.session_id)).find((l) => l.lap_id === best.lap_id)!;
      expect(lap.valid_override).toBeNull();
      expect(effectiveValid(lap)).toBe(auto);
    });
    // The item goes away with the override.
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Reset to automatic" })).toBeNull());
    expect(screen.queryByText("MANUAL")).toBeNull();
  });

  it("does not offer the reset while validity is automatic", async () => {
    const { best, session } = await newestBest(mock.engine());
    const { wrapper } = createQueryWrapper();
    const user = userEvent.setup();
    render(<Harness sessionId={session.session_id} lapId={best.lap_id} />, { wrapper });
    await user.click(await screen.findByText(/^● L/));
    await screen.findByRole("menuitem", { name: /^Mark / });
    expect(screen.queryByRole("menuitem", { name: "Reset to automatic" })).toBeNull();
  });
});

describe("LapPicker invalid hint (vroom-pnw.24)", () => {
  const session = { track_name: "T", car_name: "C", started_at: "2026-11-03T10:00:00Z" } as never;
  const lap = (valid: boolean) => ({ lap_id: "l1", lap_no: 5, lap_time_s: 0, kind: "flying", valid, valid_override: null, is_reference: false, pinned_reference: false }) as never;
  const picker = (valid: boolean, hint?: string | null) => (
    <LapPicker session={session} laps={[lap(valid)]} lap={lap(valid)} refLapId={null} warning={null} candidates={[]} invalidHint={hint} onSelectLap={() => {}} onSelectRef={() => {}} />
  );

  it("shows where an invalid lap likely went wrong, as a guess", () => {
    const { wrapper } = createQueryWrapper();
    render(picker(false, "invalid: Raidillon exit?"), { wrapper });
    expect(screen.getByText("invalid: Raidillon exit?")).toBeTruthy();
  });
  it("falls back to plain 'invalid' without a hint, and shows nothing on a valid lap", () => {
    const { wrapper } = createQueryWrapper();
    const { unmount } = render(picker(false, null), { wrapper });
    expect(screen.getByText("invalid")).toBeTruthy();
    unmount();
    render(picker(true, "invalid: Raidillon exit?"), { wrapper });
    expect(screen.queryByText(/invalid/)).toBeNull();
  });
});

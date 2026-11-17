import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createQueryWrapper, setupMockServer } from "../test/mockServer";
import { SetupChip } from "./SetupChip";

const mock = setupMockServer();

async function sessionsAndLaps() {
  const sessions = await mock.engine().sessions();
  const real = sessions.find((s) => s.started_at.startsWith("2026-11-03"))!;
  const synth = sessions.find((s) => s.started_at.startsWith("2026-11-01"))!;
  const race = sessions.find((s) => s.session_type === "Race")!;
  const laps = async (id: string) => (await mock.engine().sessionLaps(id)).filter((l) => l.kind === "flying");
  return { real, synth, race, laps };
}

describe("SetupChip", () => {
  it("says 'Same setup' for two laps of one session", async () => {
    const { real, laps } = await sessionsAndLaps();
    const all = await laps(real.session_id);
    const { wrapper } = createQueryWrapper();
    render(<SetupChip lapSessionId={real.session_id} laps={all} refLapId={all[1].lap_id} />, { wrapper });
    expect(await screen.findByText("Same setup")).toBeTruthy();
  });

  it("says 'Same setup' for two sessions with identical setups", async () => {
    const { real, laps } = await sessionsAndLaps();
    const sessions = await mock.engine().sessions();
    const same = sessions.find((s) => s.started_at.startsWith("2026-10-29T14"))!;
    const realLaps = await laps(real.session_id);
    const { wrapper } = createQueryWrapper();
    render(<SetupChip lapSessionId={real.session_id} laps={realLaps} refLapId={(await laps(same.session_id))[0].lap_id} />, { wrapper });
    expect(await screen.findByText("Same setup")).toBeTruthy();
  });

  it("shows a keyboard-reachable 'Setup: 3 changes' chip whose card lists each change", async () => {
    const { real, synth, laps } = await sessionsAndLaps();
    const synthLaps = await laps(synth.session_id);
    const refLap = (await laps(real.session_id))[0];
    const { wrapper } = createQueryWrapper();
    const user = userEvent.setup();
    render(<SetupChip lapSessionId={synth.session_id} laps={synthLaps} refLapId={refLap.lap_id} />, { wrapper });

    const chip = await screen.findByRole("button", { name: "Setup: 3 changes" });
    await user.tab(); // keyboard focus opens the card
    expect(document.activeElement).toBe(chip);
    const list = await screen.findByRole("list", { name: "Setup changes" });
    const rows = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    expect(rows).toHaveLength(3);
    expect(rows.join("|")).toMatch(/Rear wing.*→.*8\.0 deg/);
    expect(rows.join("|")).toContain("Front ARB");
    expect(rows.join("|")).toContain("Brake balance");
  });

  it("shows nothing when a session has no recorded setup", async () => {
    const { real, race, laps } = await sessionsAndLaps();
    const realLaps = await laps(real.session_id);
    const { wrapper } = createQueryWrapper();
    const { container } = render(<SetupChip lapSessionId={real.session_id} laps={realLaps} refLapId={(await laps(race.session_id))[0].lap_id} />, { wrapper });
    await new Promise((r) => setTimeout(r, 100));
    expect(container.textContent).toBe("");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../api/mock/handlers";
import { createMockApi } from "../api/mock/mockApi";
import type { Recording } from "../api/mock/recording";
import type { StintFile } from "../api/mock/stint";
import { MONZA_TRACK_ID } from "../api/mock/monzaTrack";
import type { SessionMeta } from "../api/types";
import { createQueryWrapper } from "../test/mockServer";
import { StintPanel } from "./StintPanel";

const read = <T,>(f: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../public/mock", f), "utf8")) as T;
const MONZA = read<Recording>("monza-2026-11-05.json");
const SPA = read<Recording>("spa-2026-11-03.json");
const STINT = read<StintFile>("monza-stint-2026-11-09.json");

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const serve = (stint: StintFile | null) =>
  server.resetHandlers(...createHandlers(createMockApi({ coachDelayMs: 0, loadSpa: async () => SPA, loadMonza: async () => MONZA, loadStint: async () => stint })));
const sessionOf = async (pick: (s: SessionMeta) => boolean) => (await createMockApi({ coachDelayMs: 0, loadSpa: async () => SPA, loadMonza: async () => MONZA, loadStint: async () => STINT }).sessions()).find(pick)!;

describe("StintPanel", () => {
  it("loads the Monza race by session id, with a row per lap of the first stint", async () => {
    serve(STINT);
    const race = await sessionOf((s) => s.session_type === "Race");
    const { wrapper } = createQueryWrapper();
    render(<StintPanel session={race} />, { wrapper });
    const panel = await screen.findByRole("region", { name: "Stint" });
    expect(within(panel).getAllByRole("row")).toHaveLength(1 + 25); // the one-lap stint after the stop has no flying lap and is left out
    expect(within(panel).getByText("virtual energy")).toBeTruthy(); // the limit card
    expect(within(panel).getAllByText(/s\/lap$/).length).toBeGreaterThan(0);
  });

  it("leads with the one-sentence summary, plain row titles, a tyre key and labelled wear, and keeps the maths behind a disclosure", async () => {
    serve(STINT);
    const race = await sessionOf((s) => s.session_type === "Race");
    const { wrapper } = createQueryWrapper();
    render(<StintPanel session={race} />, { wrapper });
    const panel = await screen.findByRole("region", { name: "Stint" });
    expect(within(panel).getByText("You slowed about 0.05 s a lap over the stint; virtual energy runs out first, after about 26 laps.")).toBeTruthy();
    for (const t of ["SLOWING PER LAP", "RUNS OUT FIRST", "TYRE WEAR PER LAP"]) expect(within(panel).getByText(t)).toBeTruthy();
    expect(within(panel).queryByText("FALL-OFF")).toBeNull();
    const key = within(panel).getByLabelText("Tyre key");
    for (const w of ["FL", "FR", "RL", "RR"]) expect(within(key).getByText(w)).toBeTruthy();
    const wear = within(panel).getByText("TYRE WEAR PER LAP").parentElement!;
    for (const w of ["FL", "FR", "RL", "RR"]) expect(within(wear).getByText(w)).toBeTruthy();
    const how = within(panel).getByText("How is this worked out").closest("details")!;
    expect(how.open).toBe(false);
    expect(how.contains(within(panel).getByLabelText("Fuel-corrected fall-off"))).toBe(true);
  });

  it("says fuel runs out first for a stint without virtual energy", async () => {
    serve({ ...STINT, laps: STINT.laps.map((l) => ({ ...l, energy_start_pct: null, energy_end_pct: null })) });
    const race = await sessionOf((s) => s.session_type === "Race");
    const { wrapper } = createQueryWrapper();
    render(<StintPanel session={race} />, { wrapper });
    const panel = await screen.findByRole("region", { name: "Stint" });
    expect(within(panel).getByText(/; fuel runs out first, after about 28 laps\.$/)).toBeTruthy();
  });

  it("shows the fuel-corrected fall-off next to the raw one, with its assumed constant and source", async () => {
    serve(STINT);
    const race = await sessionOf((s) => s.session_type === "Race");
    const { wrapper } = createQueryWrapper();
    render(<StintPanel session={race} />, { wrapper });
    const box = await screen.findByLabelText("Fuel-corrected fall-off");
    expect(within(box).queryByText(/experimental/i)).toBeNull();
    expect(within(box).getByText("+0.102 s/lap")).toBeTruthy();
    expect(box.textContent).toMatch(/raw \+0\.050/);
    expect(box.textContent).toMatch(/0\.0228 s\/kg/);
    expect(box.textContent).toMatch(/0\.74 kg\/L/);
  });

  it("hides the corrected fall-off for a car class without a constant, and keeps the raw one", async () => {
    serve({ ...STINT, car_class: "LMP2" });
    const race = await sessionOf((s) => s.session_type === "Race");
    const { wrapper } = createQueryWrapper();
    render(<StintPanel session={race} />, { wrapper });
    const panel = await screen.findByRole("region", { name: "Stint" });
    expect(screen.queryByLabelText("Fuel-corrected fall-off")).toBeNull();
    expect(within(panel).getByText("+0.050 s/lap")).toBeTruthy();
  });

  it("renders nothing for a session without stint stats", async () => {
    serve(STINT);
    const spa = await sessionOf((s) => s.track_id !== MONZA_TRACK_ID);
    const { wrapper, client } = createQueryWrapper();
    const { container } = render(<StintPanel session={spa} />, { wrapper });
    await waitFor(() => expect(client.getQueryState(["stints", spa.session_id])?.status).toBe("success"));
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden when the stints request fails", async () => {
    serve(STINT);
    const race = await sessionOf((s) => s.session_type === "Race");
    server.resetHandlers(http.get("*/api/sessions/:id/stints", () => HttpResponse.json({ code: "http_404", message: "Not Found" }, { status: 404 })));
    const { wrapper, client } = createQueryWrapper();
    const { container } = render(<StintPanel session={race} />, { wrapper });
    await waitFor(() => expect(client.getQueryState(["stints", race.session_id])?.status).toBe("error"));
    expect(container.innerHTML).toBe("");
  });
});

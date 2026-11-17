import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../api/mock/handlers";
import { createMockApi } from "../api/mock/mockApi";
import type { Recording } from "../api/mock/recording";
import type { StintFile } from "../api/mock/stint";
import { createQueryWrapper } from "../test/mockServer";
import { StintPanel } from "./StintPanel";

const read = <T,>(f: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../public/mock", f), "utf8")) as T;
const MONZA = read<Recording>("monza-2026-11-05.json");
const STINT = read<StintFile>("monza-stint-2026-11-09.json");

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const serve = (stint: StintFile | null) =>
  server.resetHandlers(...createHandlers(createMockApi({ coachDelayMs: 0, loadMonza: async () => MONZA, loadStint: async () => stint })));

describe("StintPanel (experimental)", () => {
  it("shows the Monza race stint for the Monza 720S, labelled experimental, with a row per lap", async () => {
    serve(STINT);
    const { wrapper } = createQueryWrapper();
    render(<StintPanel trackId="monza-grand-prix" carId="mclaren_720s_gt3_evo" />, { wrapper });
    const panel = await screen.findByRole("region", { name: "Stint" });
    expect(within(panel).getByText("EXPERIMENTAL")).toBeTruthy();
    expect(within(panel).getAllByRole("row")).toHaveLength(1 + 26);
    expect(within(panel).getByText("virtual energy")).toBeTruthy(); // the limit card
    expect(within(panel).getByText(/s\/lap$/)).toBeTruthy();
  });

  it("renders nothing for a combo without a stint", async () => {
    serve(STINT);
    const { wrapper, client } = createQueryWrapper();
    const { container } = render(<StintPanel trackId="spa" carId="mclaren_720s_gt3_evo" />, { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getQueryData(["experimental", "stints"])).toHaveLength(1);
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden when the experimental endpoint fails (the real backend has no such route yet)", async () => {
    server.resetHandlers(http.get("*/api/experimental/stints", () => HttpResponse.json({ code: "http_404", message: "Not Found" }, { status: 404 })));
    const { wrapper, client } = createQueryWrapper();
    const { container } = render(<StintPanel trackId="monza-grand-prix" carId="mclaren_720s_gt3_evo" />, { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getQueryState(["experimental", "stints"])?.status).toBe("error");
    expect(container.innerHTML).toBe("");
  });
});

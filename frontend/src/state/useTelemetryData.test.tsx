import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createQueryWrapper, newestBest, setupMockServer } from "../test/mockServer";
import { useTelemetryData } from "./useTelemetryData";

const mock = setupMockServer();

describe("useTelemetryData", () => {
  it("is loading (no context, no error) before data arrives", () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
    expect(result.current.ctx).toBeNull();
    expect(result.current.cmp).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("opens the newest session's best valid flying lap when there is no lap param", async () => {
    const { session, best } = await newestBest(mock.engine());
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
    await waitFor(() => expect(result.current.cmp).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.ctx?.session.session_id).toBe(session.session_id);
    expect(result.current.ctx?.lap.lap_id).toBe(best.lap_id);
    expect(result.current.cmp?.lap_id).toBe(best.lap_id);
    expect(result.current.candidates.length).toBeGreaterThan(0);
  });

  it("finds an explicit lap, even in an older session", async () => {
    const engine = mock.engine();
    const sessions = [...(await engine.sessions())].sort((a, b) => a.started_at.localeCompare(b.started_at));
    const oldest = sessions[0];
    const laps = await engine.sessionLaps(oldest.session_id);
    const lap = laps.find((l) => l.kind === "flying" && l.lap_time_s !== null)!;
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData(lap.lap_id, null), { wrapper });
    await waitFor(() => expect(result.current.ctx).not.toBeNull());
    expect(result.current.ctx?.session.session_id).toBe(oldest.session_id);
    expect(result.current.ctx?.lap.lap_id).toBe(lap.lap_id);
  });

  it("reports unknown_lap for a lap that is in no session", async () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData("no-such-lap", null), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.code).toBe("unknown_lap");
    expect(result.current.ctx).toBeNull();
  });

  it("reports no_laps when there are no sessions", async () => {
    mock.server.use(http.get("*/api/sessions", () => HttpResponse.json([])));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.code).toBe("no_laps");
  });

  it("surfaces an API error from the sessions request", async () => {
    mock.server.use(http.get("*/api/sessions", () => HttpResponse.json({ code: "boom", message: "nope" }, { status: 422 })));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatchObject({ code: "boom", message: "nope" });
  });
});

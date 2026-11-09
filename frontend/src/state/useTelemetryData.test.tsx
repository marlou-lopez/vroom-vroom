import { renderHook, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { sessionLapsOptions } from "../api/queries";
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

  describe("when one session's laps request fails", () => {
    const failing = { code: "boom", message: "nope" };

    it("shows Loading (no error) while the newest session is pending and an older one failed", async () => {
      const sessions = [...(await mock.engine().sessions())].sort((a, b) => b.started_at.localeCompare(a.started_at));
      expect(sessions.length).toBeGreaterThan(1);
      const [newest, older] = sessions;
      mock.server.use(
        http.get("*/api/sessions/:id/laps", async ({ params }) => {
          if (params.id === newest.session_id) await delay("infinite");
          if (params.id === older.session_id) return HttpResponse.json(failing, { status: 500 });
          return undefined;
        }),
      );
      const { wrapper, client } = createQueryWrapper();
      const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
      // Wait until the older session's request has failed; the pending newest session must still read as loading.
      await waitFor(() => expect(client.getQueryState(sessionLapsOptions(older.session_id).queryKey)?.status).toBe("error"));
      expect(result.current.error).toBeNull();
      expect(result.current.ctx).toBeNull();
    });

    it("still resolves a ?lap= link into a healthy session", async () => {
      const engine = mock.engine();
      const sessions = [...(await engine.sessions())].sort((a, b) => b.started_at.localeCompare(a.started_at));
      const [newest, ...rest] = sessions;
      const healthy = rest[rest.length - 1];
      const lap = (await engine.sessionLaps(healthy.session_id)).find((l) => l.kind === "flying" && l.lap_time_s !== null)!;
      mock.server.use(
        http.get("*/api/sessions/:id/laps", ({ params }) =>
          params.id === newest.session_id ? HttpResponse.json(failing, { status: 500 }) : undefined,
        ),
      );
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTelemetryData(lap.lap_id, null), { wrapper });
      await waitFor(() => expect(result.current.ctx).not.toBeNull());
      expect(result.current.ctx?.session.session_id).toBe(healthy.session_id);
      expect(result.current.error).toBeNull();
    });

    it("reports the failure when no healthy session has the lap", async () => {
      mock.server.use(http.get("*/api/sessions/:id/laps", () => HttpResponse.json(failing, { status: 500 })));
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTelemetryData(null, null), { wrapper });
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.error).toMatchObject({ code: "boom" });
    });
  });
});

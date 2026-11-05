import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createQueryWrapper, newestBest, spaPairs, setupMockServer } from "../test/mockServer";
import { qk, useCoachMutation, useCoachResults, usePatchLap, useSetFindingReviewed } from "./queries";
import type { CoachResults } from "./types";

const mock = setupMockServer();

describe("usePatchLap", () => {
  it("invalidates laps, compare and candidates and leaves sessions alone", async () => {
    const { best, session } = await newestBest(mock.engine());
    const { wrapper, client } = createQueryWrapper();
    // Seed the cache with one entry per family; `sessions` must stay fresh.
    client.setQueryData(qk.sessionLaps(session.session_id), []);
    client.setQueryData(qk.compare(best.lap_id, null), {});
    client.setQueryData(qk.candidates(best.lap_id), []);
    client.setQueryData(qk.sessions(), []);

    const { result } = renderHook(() => usePatchLap(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ lapId: best.lap_id, patch: { pinned_reference: true } });
    });

    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    expect(stale(qk.sessionLaps(session.session_id))).toBe(true);
    expect(stale(qk.compare(best.lap_id, null))).toBe(true);
    expect(stale(qk.candidates(best.lap_id))).toBe(true);
    expect(stale(qk.sessions())).toBe(false);
  });

  it("sends the patch to the API", async () => {
    const { best, session } = await newestBest(mock.engine());
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePatchLap(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ lapId: best.lap_id, patch: { valid_override: false } });
    });
    const laps = await mock.engine().sessionLaps(session.session_id);
    expect(laps.find((l) => l.lap_id === best.lap_id)?.valid_override).toBe(false);
  });
});

describe("useSetFindingReviewed", () => {
  async function seeded() {
    const [{ lap, ref }] = await spaPairs(mock.engine(), 1);
    const { wrapper, client } = createQueryWrapper();
    // Run analyze through the real hooks so the result (and its findings) is in the cache and in the engine.
    const coach = renderHook(() => useCoachMutation(), { wrapper });
    await act(async () => {
      await coach.result.current.mutateAsync({ command: "analyze", lap_id: lap, ref_lap_id: ref, corner_id: null });
    });
    const results = client.getQueryData<CoachResults>(qk.coachResults(lap, ref))!;
    const finding = results.analyze!.findings[0];
    expect(finding.reviewed).toBe(false);
    return { lap, ref, wrapper, client, finding };
  }
  const reviewedOf = (client: ReturnType<typeof createQueryWrapper>["client"], lap: string, ref: string, id: string) =>
    client.getQueryData<CoachResults>(qk.coachResults(lap, ref))?.analyze?.findings.find((f) => f.id === id)?.reviewed;

  it("flips the cached finding at once, before the server answers", async () => {
    const { lap, ref, wrapper, client, finding } = await seeded();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mock.server.use(
      http.patch("*/api/coach/findings/:id", async () => {
        await gate;
        return HttpResponse.json({ ...finding, reviewed: true });
      }),
    );
    const { result } = renderHook(() => useSetFindingReviewed(lap, ref), { wrapper });
    act(() => result.current.mutate({ findingId: finding.id, reviewed: true }));
    await waitFor(() => expect(reviewedOf(client, lap, ref, finding.id)).toBe(true));
    expect(result.current.isPending).toBe(true);
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reviewedOf(client, lap, ref, finding.id)).toBe(true);
  });

  it("rolls the cache back when the call fails", async () => {
    const { lap, ref, wrapper, client, finding } = await seeded();
    mock.server.use(http.patch("*/api/coach/findings/:id", () => HttpResponse.json({ code: "unknown_finding", message: "gone" }, { status: 404 })));
    const { result } = renderHook(() => useSetFindingReviewed(lap, ref), { wrapper });
    act(() => result.current.mutate({ findingId: finding.id, reviewed: true }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(reviewedOf(client, lap, ref, finding.id)).toBe(false);
  });

  it("leaves an empty cache empty", async () => {
    const { best } = await newestBest(mock.engine());
    const { wrapper, client } = createQueryWrapper();
    const { result } = renderHook(() => useSetFindingReviewed(best.lap_id, "r"), { wrapper });
    act(() => result.current.mutate({ findingId: "nope", reviewed: true }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(qk.coachResults(best.lap_id, "r"))).toBeUndefined();
  });
});

describe("useCoachResults", () => {
  it("is disabled until there is a reference lap", () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCoachResults("lap", null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

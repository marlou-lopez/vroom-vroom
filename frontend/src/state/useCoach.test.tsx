import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { CoachRequest } from "../api/types";
import { createQueryWrapper, spaPairs, setupMockServer } from "../test/mockServer";
import { useCoach } from "./useCoach";

const mock = setupMockServer();

async function twoPairs() {
  const pairs = await spaPairs(mock.engine(), 2);
  return pairs as [(typeof pairs)[number], (typeof pairs)[number]];
}

function setup(initial: { lap: string | null; ref: string | null }) {
  const { wrapper, client } = createQueryWrapper();
  const hook = renderHook(({ lap, ref }) => useCoach(lap, ref), { wrapper, initialProps: initial });
  return { ...hook, client };
}

describe("useCoach", () => {
  it("starts empty and idle", async () => {
    const [a] = await twoPairs();
    const { result } = setup({ lap: a.lap, ref: a.ref });
    expect(result.current.results).toEqual({});
    expect(result.current.running).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.showNotes).toBe(true);
    expect(result.current.deepDives).toEqual({});
  });

  it("keeps analyze results per (lap, ref) pair and restores them when coming back", async () => {
    const [a, b] = await twoPairs();
    const { result, rerender } = setup({ lap: a.lap, ref: a.ref });
    act(() => result.current.run("analyze"));
    await waitFor(() => expect(result.current.results.analyze).toBeDefined());
    expect(result.current.results.analyze?.lap_id).toBe(a.lap);
    const first = result.current.results.analyze;

    rerender(b);
    await waitFor(() => expect(result.current.results).toEqual({}));

    rerender(a);
    await waitFor(() => expect(result.current.results.analyze).toBeDefined());
    expect(result.current.results.analyze?.id).toBe(first?.id);
  });

  it("reports running while a command is in flight, then clears it", async () => {
    const [a] = await twoPairs();
    const engine = mock.engine();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mock.server.use(http.post("*/api/coach", async ({ request }) => {
      const body = (await request.json()) as CoachRequest;
      await gate;
      return HttpResponse.json(await engine.coach(body));
    }));
    const { result } = setup({ lap: a.lap, ref: a.ref });
    act(() => result.current.run("analyze"));
    await waitFor(() => expect(result.current.running).toBe("analyze"));
    release();
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(result.current.results.analyze).toBeDefined();
  });

  it("keeps running and sends one request when the comparison is switched away and back mid-run", async () => {
    const [a, b] = await twoPairs();
    const engine = mock.engine();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    mock.server.use(http.post("*/api/coach", async ({ request }) => {
      calls++;
      const body = (await request.json()) as CoachRequest;
      await gate;
      return HttpResponse.json(await engine.coach(body));
    }));
    const { result, rerender } = setup({ lap: a.lap, ref: a.ref });
    act(() => result.current.setShowNotes(false));
    act(() => result.current.run("analyze"));
    await waitFor(() => expect(result.current.running).toBe("analyze"));

    rerender(b);
    expect(result.current.running).toBeNull();
    rerender(a);
    expect(result.current.running).toBe("analyze");
    act(() => result.current.run("analyze"));

    release();
    await waitFor(() => expect(result.current.running).toBeNull());
    await waitFor(() => expect(result.current.results.analyze).toBeDefined());
    expect(calls).toBe(1);
    expect(result.current.showNotes).toBe(true);
  });

  it("scopes deep dives to the pair they were asked for", async () => {
    const [a, b] = await twoPairs();
    const map = await mock.engine().trackMap(a.trackId);
    const cornerId = map.corners[0].id;
    const { result, rerender } = setup({ lap: a.lap, ref: a.ref });

    let finding: unknown;
    await act(async () => {
      finding = await result.current.askCorner(cornerId);
    });
    expect(finding).toMatchObject({ corner_id: cornerId });
    expect(Object.keys(result.current.deepDives)).toEqual([cornerId]);

    rerender(b);
    expect(result.current.deepDives).toEqual({});

    rerender(a);
    expect(Object.keys(result.current.deepDives)).toEqual([cornerId]);
  });

  it("askCorner rejects without a lap", async () => {
    const { result } = setup({ lap: null, ref: null });
    await expect(result.current.askCorner("c1")).rejects.toThrow("no lap");
  });

  it("clears the error when the pair changes", async () => {
    const [a, b] = await twoPairs();
    mock.server.use(http.post("*/api/coach", () => HttpResponse.json({ code: "llm_error", message: "model down" }, { status: 502 })));
    const { result, rerender } = setup({ lap: a.lap, ref: a.ref });
    act(() => result.current.run("analyze"));
    await waitFor(() => expect(result.current.error).toEqual({ code: "llm_error", message: "model down" }));
    expect(result.current.running).toBeNull();

    rerender(b);
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("does nothing on run without a lap", () => {
    const { result } = setup({ lap: null, ref: null });
    act(() => result.current.run("analyze"));
    expect(result.current.running).toBeNull();
  });
});

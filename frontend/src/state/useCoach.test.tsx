import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { CoachResult } from "../api/types";
import { useCoach, type CoachState } from "./useCoach";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function result(ref: string): CoachResult {
  return {
    id: ref, command: "analyze", lap_id: "lap", ref_lap_id: ref,
    summary: "done", findings: [], focus: null, encouragement: null,
    stats: {}, warnings: [], cost_usd: null, created_at: "2026-01-01",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("coach analysis scope", () => {
  it("keeps an in-flight analysis busy after switching away and back", async () => {
    const request = deferred<CoachResult>();
    const coach = vi.spyOn(api, "coach").mockReturnValue(request.promise);
    vi.spyOn(api, "coachResults").mockResolvedValue({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let state!: CoachState;
    let renderer!: ReactTestRenderer;
    function Probe({ refId }: { refId: string }) {
      state = useCoach("lap", refId);
      return null;
    }
    const tree = (refId: string) => <QueryClientProvider client={client}><Probe refId={refId} /></QueryClientProvider>;

    await act(async () => { renderer = create(tree("a")); });
    await act(async () => { state.setShowNotes(false); state.run("analyze"); state.run("average"); });
    expect(coach).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(state.running).toBe("analyze"));
    await act(async () => { renderer.update(tree("b")); });
    await vi.waitFor(() => expect(state.running).toBeNull());
    await act(async () => { renderer.update(tree("a")); });
    await vi.waitFor(() => expect(state.running).toBe("analyze"));
    await act(async () => { state.run("analyze"); });
    expect(coach).toHaveBeenCalledTimes(1);

    await act(async () => { request.resolve(result("a")); await request.promise; });
    await vi.waitFor(() => expect(state.running).toBeNull());
    expect(state.showNotes).toBe(true);
    expect(state.results.analyze?.id).toBe("a");
    renderer.unmount();
    client.clear();
  });

  it("keeps overlapping scopes independent when requests finish out of order", async () => {
    const a = deferred<CoachResult>();
    const b = deferred<CoachResult>();
    const coach = vi.spyOn(api, "coach").mockImplementation((req) => req.ref_lap_id === "a" ? a.promise : b.promise);
    vi.spyOn(api, "coachResults").mockResolvedValue({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let state!: CoachState;
    let renderer!: ReactTestRenderer;
    function Probe({ refId }: { refId: string }) {
      state = useCoach("lap", refId);
      return null;
    }
    const tree = (refId: string) => <QueryClientProvider client={client}><Probe refId={refId} /></QueryClientProvider>;

    await act(async () => { renderer = create(tree("a")); });
    await act(async () => { state.run("analyze"); });
    await vi.waitFor(() => expect(state.running).toBe("analyze"));
    await act(async () => { renderer.update(tree("b")); });
    await vi.waitFor(() => expect(state.running).toBeNull());
    await act(async () => { state.run("average"); });
    await vi.waitFor(() => expect(state.running).toBe("average"));
    expect(coach).toHaveBeenCalledTimes(2);

    await act(async () => { a.resolve(result("a")); await a.promise; });
    expect(state.running).toBe("average");
    await act(async () => { b.reject(new Error("offline")); await b.promise.catch(() => undefined); });
    await vi.waitFor(() => expect(state.error?.message).toBe("offline"));
    await vi.waitFor(() => expect(state.running).toBeNull());
    await act(async () => { renderer.update(tree("a")); });
    await vi.waitFor(() => expect(state.results.analyze?.id).toBe("a"));
    expect(state.error).toBeNull();
    renderer.unmount();
    client.clear();
  });

  it("allows a failed analysis to be retried with no comparison", async () => {
    const failed = deferred<CoachResult>();
    const succeeded = deferred<CoachResult>();
    const coach = vi.spyOn(api, "coach").mockReturnValueOnce(failed.promise).mockReturnValueOnce(succeeded.promise);
    vi.spyOn(api, "coachResults").mockResolvedValue({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let state!: CoachState;
    let renderer!: ReactTestRenderer;
    function Probe({ lap }: { lap: string | null }) {
      state = useCoach(lap, null);
      return null;
    }
    const tree = (lap: string | null) => <QueryClientProvider client={client}><Probe lap={lap} /></QueryClientProvider>;

    await act(async () => { renderer = create(tree(null)); });
    await act(async () => { state.run("analyze"); });
    expect(coach).not.toHaveBeenCalled();
    await act(async () => { renderer.update(tree("lap")); });
    await act(async () => { state.run("analyze"); });
    await vi.waitFor(() => expect(state.running).toBe("analyze"));
    await act(async () => { failed.reject(new Error("offline")); await failed.promise.catch(() => undefined); });
    await vi.waitFor(() => expect(state.error?.message).toBe("offline"));
    await vi.waitFor(() => expect(state.running).toBeNull());
    await act(async () => { state.run("analyze"); });
    await vi.waitFor(() => expect(state.running).toBe("analyze"));
    await act(async () => { succeeded.resolve({ ...result("a"), ref_lap_id: null }); await succeeded.promise; });
    await vi.waitFor(() => expect(state.results.analyze?.ref_lap_id).toBeNull());
    expect(state.error).toBeNull();
    expect(coach).toHaveBeenCalledTimes(2);
    renderer.unmount();
    client.clear();
  });
});

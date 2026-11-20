/** Copy of `prev` with the given keys set (or removed when the value is null). Every other param survives. */
export function withParams(prev: URLSearchParams, changes: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  return next;
}

/** A link to the Telemetry page for a lap: keeps every param of `search` except the lap-specific ones (`ref`, `at`), which belong to the old lap. */
export function lapLink(search: string, lapId: string, atM?: number): { pathname: string; search: string } {
  const next = withParams(new URLSearchParams(search), { lap: lapId, ref: null, at: atM === undefined ? null : String(Math.round(atM)) });
  return { pathname: "/", search: `?${next.toString()}` };
}

/** A link to a session's Session view: the lap-specific params belong to the lap you were on. */
export function sessionLink(search: string, sessionId: string): { pathname: string; search: string } {
  const next = withParams(new URLSearchParams(search), { session: sessionId, scope: "session", lap: null, ref: null, at: null });
  return { pathname: "/", search: `?${next.toString()}` };
}

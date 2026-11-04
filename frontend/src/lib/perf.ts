export interface PerfSummary { fps: number; meanMs: number; p95Ms: number; maxMs: number; over20: number }

/** Frame times in ms to fps, mean, p95 (index ceil(0.95 n) - 1 of the sorted values), max and the count over 20 ms. */
export function summarize(frameMs: ArrayLike<number>): PerfSummary {
  const n = frameMs.length;
  if (n === 0) return { fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, over20: 0 };
  const sorted = Array.from(frameMs).sort((a, b) => a - b);
  let sum = 0, over20 = 0;
  for (const v of sorted) {
    sum += v;
    if (v > 20) over20++;
  }
  const meanMs = sum / n;
  return {
    fps: meanMs > 0 ? 1000 / meanMs : 0,
    meanMs,
    p95Ms: sorted[Math.ceil(0.95 * n) - 1],
    maxMs: sorted[n - 1],
    over20,
  };
}

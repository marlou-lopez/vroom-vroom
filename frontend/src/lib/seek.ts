import type { Pt, XY } from "./geo";

/**
 * Click-to-seek target. The grid indices within `maxDistM` of `p` form one or more stretches of track (runs of
 * consecutive indices; the lap wraps at n). Where the track passes near itself there are several: the stretch
 * closest to `currentIdx` by circular lap distance wins (ties: the one with the point nearest `p`). Within it, the
 * point nearest `p` is returned, so the seek lands under the pointer rather than drifting toward the car.
 * -1 when nothing is in range.
 */
export function seekIndexNear(line: XY, p: Pt, maxDistM: number, currentIdx: number): number {
  const n = line.x.length;
  if (n === 0) return -1;
  const max2 = maxDistM * maxDistM;
  const d2 = new Float64Array(n);
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dx = line.x[i] - p.x, dy = line.y[i] - p.y;
    d2[i] = dx * dx + dy * dy;
    inside[i] = d2[i] <= max2 ? 1 : 0;
  }
  // Start the walk just after an out-of-range index so a stretch crossing n-1 -> 0 stays whole.
  let start = 0;
  while (start < n && inside[start]) start++;
  if (start === n) start = 0; // the whole lap is in range: one stretch

  let best = -1, bestLap = Infinity, bestD2 = Infinity;
  let runNearest = -1, runLap = Infinity;
  const closeRun = () => {
    if (runNearest < 0) return;
    if (runLap < bestLap || (runLap === bestLap && d2[runNearest] < bestD2)) {
      best = runNearest;
      bestLap = runLap;
      bestD2 = d2[runNearest];
    }
    runNearest = -1;
    runLap = Infinity;
  };
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (!inside[i]) {
      closeRun();
      continue;
    }
    const gap = Math.abs(i - currentIdx);
    runLap = Math.min(runLap, gap, n - gap);
    if (runNearest < 0 || d2[i] < d2[runNearest]) runNearest = i;
  }
  closeRun();
  return best;
}

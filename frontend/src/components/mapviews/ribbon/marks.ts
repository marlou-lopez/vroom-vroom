import type { ChannelArrays } from "../../../api/types";
import { aidRuns, mapSpan } from "../../../lib/driverAids";
import { offTrackRuns } from "../../../lib/offTrack";
import type { XY } from "../../../lib/geo";
import { writeThree } from "./coords";

/** A stretch of the lap line as inclusive grid indices (metres), already widened like the 2D views' marks (`mapSpan`). */
export type MarkSpan = [number, number];

/** Where the 3D ribbon marks the lap line (vroom-q4f): the same stretches the 2D maps draw, whole lap, from `lib/driverAids` and `lib/offTrack`. */
export interface RibbonMarks {
  lockup: MarkSpan[];
  wheelspin: MarkSpan[];
  offTrack: MarkSpan[];
  /** True when the lap is invalid: wheels-off marks are then `offTrack` red, else grey close calls. */
  invalid: boolean;
}

export type MarkChannels = Parameters<typeof aidRuns>[0] & Pick<ChannelArrays, "wheels_off">;

export function ribbonMarks(ch: MarkChannels, gridLength: number, lapValid: boolean | undefined): RibbonMarks {
  const last = Math.max(gridLength - 1, 0);
  const spans = (rs: { start: number; end: number }[]): MarkSpan[] => rs.map((r) => mapSpan(r, last));
  const aids = aidRuns(ch);
  return { lockup: spans(aids.lockup), wheelspin: spans(aids.wheelspin), offTrack: spans(offTrackRuns(ch)), invalid: lapValid === false };
}

/** Line positions (three.js axes) of one span of the lap line, each point at the road height of its own grid index plus `lift`. */
export function buildMarkPositions(lap: XY, heights: Float64Array, span: MarkSpan, lift: number): Float32Array {
  const [a, b] = span;
  const out = new Float32Array((b - a + 1) * 3);
  for (let i = a; i <= b; i++) writeThree(out, i - a, lap.x[i], lap.y[i], (heights[Math.min(i, heights.length - 1)] ?? 0) + lift);
  return out;
}

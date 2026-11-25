// The Lap view's invalid-lap notice (vroom-ake): where the lap was most likely invalidated, in plain words. The place comes
// from the first stretch with two or more wheels off the track (`lib/offTrack`); LMU records no invalidation event, so
// it is a best guess and the sentence says "most likely". The prose never carries a metre distance.
import type { ChannelArrays, TrackMap } from "../api/types";
import { likelyInvalidRun, offTrackRuns, placeAt } from "./offTrack";

export interface InvalidNotice {
  /** One plain sentence. */
  text: string;
  /** Where on the lap (metres along the grid) the marker and the click go; null when the recording gives no place. */
  atM: number | null;
}

/** null for a valid lap. An invalid lap with no wheels-off stretch says it is invalid and names no place. */
export function invalidNotice(
  valid: boolean,
  lap: Pick<ChannelArrays, "wheels_off">,
  distance: ArrayLike<number>,
  map: TrackMap | null,
): InvalidNotice | null {
  if (valid) return null;
  const run = likelyInvalidRun(offTrackRuns(lap));
  if (!run) return { text: "This lap is invalid. The recording doesn't show where it was invalidated.", atM: null };
  const atM = distance[run.start] ?? run.start;
  // Without a corner list placeAt falls back to a distance in metres: the prose then names no place.
  if (!map || map.corners.length === 0) {
    return { text: "This lap is invalid. It was most likely invalidated where two or more wheels left the track.", atM };
  }
  const place = placeAt(map, atM);
  const where = place.startsWith("near ") ? place : `at ${place}`;
  return { text: `This lap is invalid. It was most likely invalidated ${where}, where two or more wheels left the track.`, atM };
}

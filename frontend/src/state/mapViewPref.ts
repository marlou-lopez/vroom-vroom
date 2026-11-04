import { TRACK_VIEW_IDS, type TrackViewId } from "../components/mapviews/types";

const KEY = "vroom.trackView";
const DEFAULT: TrackViewId = "2d";

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered track view; any missing, stale or unreadable value gives "2d". */
export function loadTrackView(storage: Pick<Storage, "getItem"> | null = defaultStorage()): TrackViewId {
  try {
    const v = storage?.getItem(KEY);
    return TRACK_VIEW_IDS.find((id) => id === v) ?? DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function saveTrackView(id: TrackViewId, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // Private window or blocked storage: the choice just isn't remembered.
  }
}

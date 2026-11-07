import { loadSetting, saveSetting } from "../components/mapviews/shared/storage";
import { TRACK_VIEW_IDS, type TrackViewId } from "../components/mapviews/types";

const KEY = "vroom.trackView";

/** The remembered track view; any missing, stale or unreadable value gives "2d". */
export function loadTrackView(storage?: Pick<Storage, "getItem"> | null): TrackViewId {
  return loadSetting(KEY, TRACK_VIEW_IDS, "2d", { storage });
}

export function saveTrackView(id: TrackViewId, storage?: Pick<Storage, "setItem"> | null): void {
  saveSetting(KEY, id, storage);
}

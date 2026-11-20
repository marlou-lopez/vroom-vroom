// Whether the Track and car view's Advanced section (landmark editor, calibration) is open. Closed by default, remembered per browser;
// every storage access is in try/catch (private windows and blocked site data throw).
export const TRACKS_ADVANCED_KEY = "vroom.tracksAdvanced";

function defaultStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadTracksAdvanced(storage: Pick<Storage, "getItem"> | null = defaultStorage()): boolean {
  try { return storage?.getItem(TRACKS_ADVANCED_KEY) === "open"; } catch { return false; }
}

export function saveTracksAdvanced(open: boolean, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try { storage?.setItem(TRACKS_ADVANCED_KEY, open ? "open" : "closed"); } catch { /* not remembered */ }
}

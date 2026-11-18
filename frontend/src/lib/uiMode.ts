// The Telemetry page's mode: the full dense view (first-visit default) or the plain-language Simple view.
// Remembered per browser; every storage access is in try/catch (private windows and blocked site data throw).
export type UiMode = "full" | "simple";
export const UI_MODE_KEY = "vroom.uiMode";

export function parseUiMode(raw: string | null | undefined): UiMode {
  return raw === "simple" ? "simple" : "full";
}

function defaultStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadUiMode(storage: Pick<Storage, "getItem"> | null = defaultStorage()): UiMode {
  try { return parseUiMode(storage?.getItem(UI_MODE_KEY)); } catch { return "full"; }
}

export function saveUiMode(mode: UiMode, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try { storage?.setItem(UI_MODE_KEY, mode); } catch { /* not remembered */ }
}

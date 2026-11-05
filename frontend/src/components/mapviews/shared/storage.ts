// Per-viewer view settings in localStorage. Every access is wrapped: storage can be blocked or throw (private windows,
// cleared site data), and then the setting is simply not remembered.

export function loadString(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private window or blocked storage: not remembered.
  }
}

/** An on/off view setting remembered per browser, default on. */
export function loadFlag(key: string): boolean {
  return loadString(key) !== "0";
}

export function saveFlag(key: string, on: boolean): void {
  saveString(key, on ? "1" : "0");
}

// Per-viewer view settings in localStorage. Every access is wrapped: storage can be blocked or throw (private windows,
// cleared site data), and then the setting is simply not remembered.
//
// The optional `storage` argument is for tests; `null` means no storage at all.

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadString(key: string, storage: Pick<Storage, "getItem"> | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private window or blocked storage: not remembered.
  }
}

/**
 * A remembered choice from a fixed set. A missing, stale or unreadable value gives `fallback`;
 * `legacy` maps older stored values onto current ones.
 */
export function loadSetting<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  opts: { legacy?: Readonly<Record<string, T>>; storage?: Pick<Storage, "getItem"> | null } = {},
): T {
  const v = loadString(key, opts.storage);
  if (v === null) return fallback;
  if (opts.legacy && Object.hasOwn(opts.legacy, v)) return opts.legacy[v]!;
  return allowed.find((a) => a === v) ?? fallback;
}

export function saveSetting(key: string, value: string, storage?: Pick<Storage, "setItem"> | null): void {
  saveString(key, value, storage);
}

/** An on/off view setting remembered per browser, default on. */
export function loadFlag(key: string, storage?: Pick<Storage, "getItem"> | null): boolean {
  return loadString(key, storage) !== "0";
}

export function saveFlag(key: string, on: boolean, storage?: Pick<Storage, "setItem"> | null): void {
  saveString(key, on ? "1" : "0", storage);
}

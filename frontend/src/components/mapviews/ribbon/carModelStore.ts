/**
 * The user's own 3D car models (#102), kept in this browser only (IndexedDB, one record per car_id). Nothing is uploaded.
 * Every call degrades silently: with IndexedDB missing or blocked (private window), reads give null and writes give false.
 */

export interface StoredCarModel {
  carId: string;
  /** The GLB bytes exactly as picked. */
  bytes: ArrayBuffer;
  fileName: string;
  size: number;
  addedAt: number;
  /** For models whose nose points the other way (the fit assumes the nose is at +z). */
  rotate180: boolean;
}

export interface CarModelStore {
  get(carId: string): Promise<StoredCarModel | null>;
  /** False when the browser would not store it (storage blocked or full). */
  put(rec: StoredCarModel): Promise<boolean>;
  /** Changes the flag of a stored model; false when there is none or storage failed. */
  setRotate(carId: string, rotate180: boolean): Promise<boolean>;
  remove(carId: string): Promise<boolean>;
  /** Called with the car_id after every successful put / setRotate / remove (the 3D view reloads that car). */
  subscribe(fn: (carId: string) => void): () => void;
}

class Listeners {
  private fns = new Set<(carId: string) => void>();
  subscribe = (fn: (carId: string) => void): (() => void) => {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  };
  emit(carId: string): void { for (const f of [...this.fns]) f(carId); }
}

/** An in-memory store: the fallback when IndexedDB is unavailable, and the test double. */
export function createMemoryCarModelStore(): CarModelStore {
  const map = new Map<string, StoredCarModel>();
  const l = new Listeners();
  return {
    get: async (id) => map.get(id) ?? null,
    put: async (rec) => { map.set(rec.carId, rec); l.emit(rec.carId); return true; },
    setRotate: async (id, rotate180) => {
      const r = map.get(id);
      if (!r) return false;
      map.set(id, { ...r, rotate180 });
      l.emit(id);
      return true;
    },
    remove: async (id) => { map.delete(id); l.emit(id); return true; },
    subscribe: l.subscribe,
  };
}

const DB_NAME = "vroom-car-models";
const STORE = "models";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** `factory` is injectable for tests (fake-indexeddb); it defaults to the browser's. */
export function createIdbCarModelStore(factory: IDBFactory | undefined = globalThis.indexedDB): CarModelStore {
  const l = new Listeners();
  let dbp: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => {
    if (!dbp) {
      dbp = new Promise<IDBDatabase | null>((resolve) => {
        try {
          if (!factory) return resolve(null);
          const r = factory.open(DB_NAME, 1);
          r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "carId" }); };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return dbp;
  };
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>, fallback: T): Promise<T> => {
    try {
      const db = await open();
      if (!db) return fallback;
      const tx = db.transaction(STORE, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const out = await fn(tx.objectStore(STORE));
      await done;
      return out;
    } catch {
      return fallback;
    }
  };
  const valid = (r: unknown): r is StoredCarModel => {
    const x = r as StoredCarModel | undefined;
    return !!x && typeof x.carId === "string" && x.bytes instanceof ArrayBuffer;
  };
  const get = (id: string) => run("readonly", async (s) => {
    const r = await req(s.get(id));
    return valid(r) ? r : null;
  }, null as StoredCarModel | null);
  return {
    get,
    put: async (rec) => {
      const ok = await run("readwrite", async (s) => { await req(s.put(rec)); return true; }, false);
      if (ok) l.emit(rec.carId);
      return ok;
    },
    setRotate: async (id, rotate180) => {
      const ok = await run("readwrite", async (s) => {
        const r = await req(s.get(id));
        if (!valid(r)) return false;
        await req(s.put({ ...r, rotate180 }));
        return true;
      }, false);
      if (ok) l.emit(id);
      return ok;
    },
    remove: async (id) => {
      const ok = await run("readwrite", async (s) => { await req(s.delete(id)); return true; }, false);
      if (ok) l.emit(id);
      return ok;
    },
    subscribe: l.subscribe,
  };
}

let shared: CarModelStore | null = null;
/** The app-wide store (one instance, so every subscriber sees every change). */
export function carModelStore(): CarModelStore {
  return (shared ??= createIdbCarModelStore());
}
/** Replaces the app-wide store (tests). */
export function setCarModelStore(s: CarModelStore | null): void { shared = s; }

/** Where the developer folder serves a model for `carId` (`frontend/public/local-models/`, git-ignored). */
export const modelUrl = (carId: string): string => `${import.meta.env.BASE_URL}local-models/${encodeURIComponent(carId)}.glb`;

const GLB_MAGIC = 0x46546c67; // "glTF", little-endian

/** True when `bytes` begins with the binary glTF header. */
export function isGlb(bytes: ArrayBuffer): boolean {
  return bytes.byteLength >= 12 && new DataView(bytes).getUint32(0, true) === GLB_MAGIC;
}

/**
 * Whether the developer folder holds a model for `carId` (`/local-models/<car_id>.glb`). The dev server answers a missing file
 * with its HTML page, so the first bytes are checked for the glTF header rather than the status.
 */
export async function probeLocalModel(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const ac = new AbortController();
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const chunk = await reader.read();
    await reader.cancel().catch(() => undefined);
    const v = chunk.value;
    if (!v || v.byteLength < 4) return false;
    return new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0, true) === GLB_MAGIC;
  } catch {
    return false;
  } finally {
    ac.abort();
  }
}

/** Above this a model is slow to parse and draw twice (lap and ghost): the popover warns, but allows it. */
export const LARGE_MODEL_BYTES = 30 * 1024 * 1024;
export const READ_ERROR = "Couldn't read this file as a glTF binary (.glb).";

export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

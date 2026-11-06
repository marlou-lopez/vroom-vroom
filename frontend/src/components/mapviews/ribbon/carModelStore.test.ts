import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createIdbCarModelStore, createMemoryCarModelStore, isGlb, probeLocalModel, type StoredCarModel } from "./carModelStore";

const rec = (carId = "a"): StoredCarModel => ({ carId, bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0, 8, 0, 0, 0]).buffer, fileName: "m.glb", size: 12, addedAt: 5, rotate180: false });

describe.each([["indexeddb", () => createIdbCarModelStore(new IDBFactory())], ["memory", createMemoryCarModelStore]])("%s store", (_n, make) => {
  it("round-trips a record, toggles rotate, removes, and notifies", async () => {
    const s = make();
    const seen: string[] = [];
    s.subscribe((id) => seen.push(id));
    expect(await s.get("a")).toBeNull();
    expect(await s.put(rec())).toBe(true);
    const got = await s.get("a");
    expect(got?.fileName).toBe("m.glb");
    expect(new Uint8Array(got!.bytes)).toEqual(new Uint8Array(rec().bytes));
    expect(await s.setRotate("a", true)).toBe(true);
    expect((await s.get("a"))?.rotate180).toBe(true);
    expect(await s.setRotate("zzz", true)).toBe(false);
    expect(await s.remove("a")).toBe(true);
    expect(await s.get("a")).toBeNull();
    expect(seen).toEqual(["a", "a", "a"]);
  });
});

describe("idb store without IndexedDB", () => {
  it("degrades to no model", async () => {
    const s = createIdbCarModelStore(undefined);
    expect(await s.get("a")).toBeNull();
    expect(await s.put(rec())).toBe(false);
    expect(await s.remove("a")).toBe(false);
  });
});

describe("isGlb / probeLocalModel", () => {
  it("checks the glTF header", () => {
    expect(isGlb(rec().bytes)).toBe(true);
    expect(isGlb(new TextEncoder().encode("<!doctype html><html>").buffer as ArrayBuffer)).toBe(false);
  });
  it("accepts a glb response and rejects the dev server's HTML page", async () => {
    const ok = vi.fn(async () => new Response(rec().bytes));
    const html = vi.fn(async () => new Response("<!doctype html><html>"));
    const nf = vi.fn(async () => new Response("no", { status: 404 }));
    expect(await probeLocalModel("/x.glb", ok as unknown as typeof fetch)).toBe(true);
    expect(await probeLocalModel("/x.glb", html as unknown as typeof fetch)).toBe(false);
    expect(await probeLocalModel("/x.glb", nf as unknown as typeof fetch)).toBe(false);
  });
});

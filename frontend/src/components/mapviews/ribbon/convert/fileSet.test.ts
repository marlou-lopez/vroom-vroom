import { describe, expect, it } from "vitest";
import { ConvertError, canSkipConversion, classify, collectResources, inspectGlb, normalizePath, resolveUri } from "./fileSet.ts";
import { DEFAULT_OPTIONS, STAGES, dropPatterns, isDropped, namedPart, withDefaults } from "./settings.ts";

const f = (path: string, data = new Uint8Array(1)) => ({ path, data });

describe("settings", () => {
  it("has the CLI's optimize defaults the old script used", () => {
    expect(DEFAULT_OPTIONS).toMatchObject({ ratio: 0.3, error: 0.001, lockBorder: true, texSize: 1024, meshoptLevel: "high", keepCockpit: false, keepGraph: false });
    expect(withDefaults({ ratio: 0.5 }).ratio).toBe(0.5);
    expect(STAGES).toEqual(["reading", "cleaning", "simplifying", "textures", "compressing", "saving"]);
  });
  it("drops the listed parts, ignoring Sketchfab's _<n> suffix and case", () => {
    for (const n of ["DAMAGE_GLASS_FL_3", "RIM_BLUR_1", "CINTURE_ON", "DISPLAY_DATA", "LUMIRANK", "WIPER_L", "DISC_FR", "SUSP_RL", "DOOR_INT_L", "INT_Window_1", "racelogic_5", "damage_glass"]) {
      expect(isDropped(n, { keepCockpit: true })).toBe(true);
    }
    for (const n of ["EXT_Body", "STEER_LR", "RPM_LED_3", "Slip_Left_1", "COCKPIT_LR"]) expect(isDropped(n, { keepCockpit: false })).toBe(false);
  });
  it("drops the high-res cockpit only unless keepCockpit", () => {
    expect(isDropped("COCKPIT_HR_2", { keepCockpit: false })).toBe(true);
    expect(isDropped("STEER_HR", { keepCockpit: false })).toBe(true);
    expect(isDropped("COCKPIT_HR_2", { keepCockpit: true })).toBe(false);
    expect(dropPatterns({ keepCockpit: false }).length).toBeGreaterThan(dropPatterns({ keepCockpit: true }).length);
  });
  it("names the kept parts", () => {
    expect(namedPart("RPM_LED_9_1")).toBe("RPM_LED_9");
    expect(namedPart("STEER_LR")).toBe("STEER_LR");
    expect(namedPart("Slip_Right_2_1")).toBe("Slip_Right_2");
    expect(namedPart("EXT_Body")).toBe("");
  });
});

describe("file set", () => {
  it("normalises paths", () => {
    expect(normalizePath("./a//b/../c\\d.png")).toBe("a/c/d.png");
  });
  it("resolves relative and encoded URIs against the gltf's directory", () => {
    expect(resolveUri("car/scene.gltf", "textures/body%20color.png")).toBe("car/textures/body color.png");
    expect(resolveUri("scene.gltf", "../x.bin")).toBe("x.bin");
    expect(resolveUri("scene.gltf", "data:image/png;base64,AAAA")).toBeNull();
  });
  it("collects the buffers and images a gltf refers to, case-insensitively", () => {
    const files = [f("car/scene.gltf"), f("car/scene.bin"), f("car/Textures/Body.PNG")];
    const r = collectResources("car/scene.gltf", { buffers: [{ uri: "scene.bin" }], images: [{ uri: "textures/body.png" }, { uri: "data:image/png;base64,AA" }, {}] }, files);
    expect(Object.keys(r)).toEqual(["scene.bin", "textures/body.png"]);
  });
  it("names the first missing file", () => {
    expect(() => collectResources("scene.gltf", { buffers: [{ uri: "scene.bin" }] }, [f("scene.gltf")])).toThrowError(/scene\.bin/);
  });
  it("classifies a pick", () => {
    expect(classify([f("a.glb")])).toEqual({ kind: "glb", main: "a.glb" });
    expect(classify([f("x.zip")]).kind).toBe("zip");
    expect(classify([f("dir/other.gltf"), f("dir/scene.gltf"), f("dir/scene.bin")])).toEqual({ kind: "gltf", main: "dir/scene.gltf" });
    expect(() => classify([f("car.obj")])).toThrowError(ConvertError);
    expect(() => classify([])).toThrowError(/No files/);
  });
  it("skips conversion only for a small, already-compressed glb", () => {
    const glb = (ext: string[], pad = 0) => {
      const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ext }).padEnd(64, " "));
      const out = new Uint8Array(20 + json.length + pad), dv = new DataView(out.buffer);
      dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
      dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
      return out.buffer;
    };
    expect(inspectGlb(glb(["EXT_meshopt_compression"])).extensionsUsed).toEqual(["EXT_meshopt_compression"]);
    expect(canSkipConversion(glb(["EXT_meshopt_compression"]))).toBe(true);
    expect(canSkipConversion(glb(["KHR_draco_mesh_compression"]))).toBe(true);
    expect(canSkipConversion(glb([]))).toBe(false);
    expect(canSkipConversion(glb(["EXT_meshopt_compression"], 16 * 1024 * 1024))).toBe(false);
    expect(canSkipConversion(new ArrayBuffer(8))).toBe(false);
  });
});

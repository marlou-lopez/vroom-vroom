import { Document, WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { zipSync } from "fflate";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { MeshoptDecoder as WasmDecoder, MeshoptEncoder } from "meshoptimizer";
import { convertFiles, unzipFiles } from "./convert.ts";
import { ConvertError } from "./fileSet.ts";
import { makeGltfFiles } from "./fixture.ts";
import { countTriangles, dropParts, type TextureEncoder } from "./pipeline.ts";
import type { Stage } from "./settings.ts";

/** OffscreenCanvas / createImageBitmap do not exist in node, so the WebP encoder is injected: this stub claims every image became a tiny "webp". */
const stubEncoder: TextureEncoder = vi.fn(async () => ({ data: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), mimeType: "image/webp" as const }));

async function reread(glb: Uint8Array) {
  await Promise.all([WasmDecoder.ready, MeshoptEncoder.ready]);
  return new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": WasmDecoder }).readBinary(glb);
}

describe("convertFiles on a generated .gltf folder", () => {
  it("drops the listed parts, simplifies, compresses and reports the stages", async () => {
    const { files, triangles } = await makeGltfFiles();
    const stages: Stage[] = [];
    const out = await convertFiles(files, {}, { encodeTexture: stubEncoder, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["reading", "cleaning", "simplifying", "textures", "compressing", "saving"]);
    expect(out.dropped).toBe(1); // DAMAGE_GLASS_1
    expect(out.stats.trianglesBefore).toBe(triangles);
    // The glass (800 triangles) is gone and the rest simplified towards 30%.
    expect(out.stats.trianglesAfter).toBeLessThan(1600 * 0.6);
    expect(out.stats.trianglesAfter).toBeGreaterThan(0);

    const doc = await reread(out.glb);
    expect(countTriangles(doc)).toBe(out.stats.trianglesAfter);
    expect(doc.getRoot().listMeshes().length).toBeLessThanOrEqual(2);
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toEqual(expect.arrayContaining(["EXT_meshopt_compression", "EXT_texture_webp"]));
    expect(stubEncoder).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", 1024, 0.8);
  });

  it("parses with three's GLTFLoader and MeshoptDecoder", async () => {
    const { files } = await makeGltfFiles();
    const out = await convertFiles(files, {}, { encodeTexture: vi.fn(async () => null) });
    // Textures stay PNG here; node has no image decoding, so the loader's image step is stubbed.
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
    vi.stubGlobal("self", globalThis); // three's meshopt decoder module expects a worker-like global
    try {
      const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const ab = out.glb.buffer.slice(out.glb.byteOffset, out.glb.byteOffset + out.glb.byteLength) as ArrayBuffer;
      const gltf = await loader.parseAsync(ab, "");
      let tris = 0;
      gltf.scene.traverse((o) => { const m = o as import("three").Mesh; if (m.isMesh) tris += (m.geometry.index?.count ?? 0) / 3; });
      expect(tris).toBe(out.stats.trianglesAfter);
      expect(tris).toBeLessThan(800 * 3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keepGraph keeps the meshes as separate nodes (no join)", async () => {
    const { files } = await makeGltfFiles();
    const joined = await reread((await convertFiles(files, {}, {})).glb);
    const kept = await reread((await convertFiles(files, { keepGraph: true }, {})).glb);
    expect(kept.getRoot().listMeshes().length).toBeGreaterThanOrEqual(joined.getRoot().listMeshes().length);
    expect(kept.getRoot().listNodes().length).toBeGreaterThan(joined.getRoot().listNodes().length);
  });

  it("optimise: false only packs the files into one .glb", async () => {
    const { files, triangles } = await makeGltfFiles();
    const out = await convertFiles(files, { optimise: false }, {});
    expect(out.stats.trianglesAfter).toBe(triangles);
    expect(out.dropped).toBe(0);
  });

  it("reads the same model from a .zip", async () => {
    const { files, triangles } = await makeGltfFiles();
    const zip = zipSync(Object.fromEntries(files.map((f) => [`car/${f.path}`, f.data])));
    expect(unzipFiles(zip).map((f) => f.path).sort()).toEqual(files.map((f) => `car/${f.path}`).sort());
    const out = await convertFiles([{ path: "car.zip", data: zip }], { optimise: false }, {});
    expect(out.stats.trianglesBefore).toBe(triangles);
  });

  it("names a missing referenced file", async () => {
    const { files } = await makeGltfFiles();
    const err = await convertFiles(files.filter((f) => !f.path.endsWith(".bin")), {}, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvertError);
    expect((err as ConvertError).code).toBe("missing-file");
    expect((err as ConvertError).message).toContain("buffer.bin");
  });

  it("rejects an unsupported file", async () => {
    const err = await convertFiles([{ path: "car.obj", data: new Uint8Array(4) }], {}, {}).catch((e: unknown) => e);
    expect((err as ConvertError).code).toBe("unsupported");
  });
});

describe("dropParts", () => {
  it("names the meshes below a kept part after it, whatever the part's own index (a renamed RPM_LED_5 must not lose its children's name)", () => {
    const doc = new Document();
    doc.createBuffer();
    const mk = (name: string) => doc.createNode(name).setMesh(doc.createMesh(name));
    // The LED's mesh node has a name of its own that does not match, so its name must come from its parent, whose index (5) must still read as an index.
    const led = (i: number) => doc.createNode(`RPM_LED_${i}_${100 + i}`).addChild(mk(`Quad_${i}`));
    const data = doc.createNode("DISPLAY_DATA_1").addChild(led(5)).addChild(led(0));
    const root = doc.createNode("car").addChild(mk("body")).addChild(doc.createNode("STEER_LR_2").addChild(mk("STEER_LR_SUB0_3"))).addChild(data);
    doc.createScene("s").addChild(root);
    dropParts(doc, { keepCockpit: false });
    const meshNames = doc.getRoot().listNodes().filter((n) => n.getMesh()).map((n) => n.getMesh()!.getName()).sort();
    expect(meshNames).toEqual(["", "RPM_LED_0", "RPM_LED_5", "STEER_LR"]);
  });
});

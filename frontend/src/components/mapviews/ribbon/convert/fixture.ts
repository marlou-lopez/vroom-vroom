import { Document, WebIO } from "@gltf-transform/core";
import { deflateSync } from "node:zlib";
import type { InputFile } from "./fileSet.ts";

/** A valid RGB PNG of a gradient (not a solid colour, so pruning keeps it). Test fixture. */
export function makePng(size = 8): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 2;
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const i = y * (1 + size * 3) + 1 + x * 3; raw[i] = x * 30; raw[i + 1] = y * 30; raw[i + 2] = 128; }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

function gridPrimitive(doc: Document, n: number, bump: number) {
  const pos = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2);
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    const i = y * (n + 1) + x;
    pos.set([x / n, Math.sin(x * 0.15) * Math.cos(y * 0.1) * bump, y / n], i * 3);
    uv.set([x / n, y / n], i * 2);
  }
  const idx = new Uint32Array(n * n * 6);
  let k = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  return doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(uv).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(idx).setBuffer(buffer));
}

/**
 * A small car-like glTF as a file set (scene.gltf, scene.bin, textures/body.png): a body mesh with the PNG texture, a plain
 * wheel mesh, and a DAMAGE_GLASS_1 node that the pipeline drops. 20 x 20 quads per mesh = 800 triangles each.
 */
export async function makeGltfFiles(): Promise<{ files: InputFile[]; triangles: number }> {
  const doc = new Document();
  doc.createBuffer();
  const png = makePng();
  const tex = doc.createTexture("body").setImage(png).setMimeType("image/png").setURI("textures/body.png");
  const bodyMat = doc.createMaterial("body").setBaseColorTexture(tex);
  const wheelMat = doc.createMaterial("wheel").setBaseColorFactor([0.1, 0.1, 0.1, 1]);
  const mk = (name: string, mat: ReturnType<Document["createMaterial"]>, bump: number) =>
    doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(gridPrimitive(doc, 20, bump).setMaterial(mat)));
  const root = doc.createNode("car").addChild(mk("body", bodyMat, 0.05)).addChild(mk("wheel", wheelMat, 0.03)).addChild(mk("DAMAGE_GLASS_1", wheelMat, 0.2));
  doc.createScene("s").addChild(root);
  const { json, resources } = await new WebIO().writeJSON(doc);
  const files: InputFile[] = [{ path: "scene.gltf", data: new TextEncoder().encode(JSON.stringify(json)) }];
  for (const [uri, data] of Object.entries(resources)) files.push({ path: uri, data });
  return { files, triangles: 3 * 800 };
}

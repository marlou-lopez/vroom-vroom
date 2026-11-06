import { type Document, type Node, type Transform } from "@gltf-transform/core";
import { EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, flatten, instance, join, prune, simplify, sparse, weld, meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { isDropped, namedPart, withDefaults, type ConvertOptions, type Stage } from "./settings.ts";

/**
 * The optimisation pipeline (#102), shared by the in-browser converter (a Web Worker) and `tools/optimize-car-model.mjs`.
 * It is the gltf-transform CLI's `optimize` written out as function calls, in the CLI's order and with its defaults, except:
 * no `palette` (the old script turned it off), no `resample` (a car has no animations), and textures go through
 * `encodeTexture` (the browser uses OffscreenCanvas, Node uses sharp) instead of the CLI's sharp-only step.
 */

export interface EncodedTexture { data: Uint8Array; mimeType: "image/webp" }

/** Re-encodes one image as WebP, scaled down to fit `maxSize` (aspect kept). Return null to leave the texture as it is. */
export type TextureEncoder = (image: Uint8Array, mimeType: string, maxSize: number, quality: number) => Promise<EncodedTexture | null>;

export interface PipelineDeps {
  encodeTexture?: TextureEncoder;
  onStage?: (s: Stage) => void;
}

/** Counts the triangles of the scene's meshes (one count per use of a mesh by a node, instancing ignored). */
export function countTriangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const mode = p.getMode();
      const count = p.getIndices()?.getCount() ?? p.getAttribute("POSITION")?.getCount() ?? 0;
      if (mode === 4) n += count / 3;
      else if (mode === 5 || mode === 6) n += Math.max(0, count - 2);
    }
  }
  return Math.round(n);
}

/**
 * Removes the parts an exterior or chase view never shows (see `DROP_PATTERNS`), after lifting the kept named parts (steering
 * wheel, LEDs) out from under any dropped part, then names the mesh nodes after their kept ancestor and anonymises the rest so
 * `join` can merge it. Returns the number of dropped subtrees.
 */
export function dropParts(doc: Document, o: Pick<ConvertOptions, "keepCockpit">): number {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return 0;
  const all: Node[] = [];
  const walk = (n: Node, f: (x: Node) => void) => { f(n); n.listChildren().forEach((k) => walk(k, f)); };
  scene.listChildren().forEach((n) => walk(n, (x) => all.push(x)));
  const doomedName = (n: Node) => isDropped(n.getName(), o);
  for (const n of all) {
    if (!namedPart(n.getName()) || namedPart(n.getParentNode()?.getName() ?? "")) continue;
    let doomed: Node | null = null;
    for (let p = n.getParentNode(); p; p = p.getParentNode()) if (doomedName(p)) doomed = p;
    if (doomed?.getParentNode()) doomed.getParentNode()!.addChild(n);
  }
  let dropped = 0;
  for (const n of all) {
    if (n.isDisposed() || !doomedName(n) || n.getParentNode() === null) continue;
    const sub: Node[] = [];
    walk(n, (x) => sub.push(x));
    sub.reverse().forEach((x) => x.dispose());
    dropped++;
  }
  for (const n of all) {
    if (n.isDisposed()) continue;
    let name = "";
    for (let p: Node | null = n; p && !name; p = p.getParentNode()) name = namedPart(p.getName());
    n.setName(name);
    n.getMesh()?.setName(name);
  }
  return dropped;
}

/** Re-encodes every texture the encoder takes; declares EXT_texture_webp (required) when any changed. Returns how many. */
export async function compressTextures(doc: Document, encode: TextureEncoder, o: Pick<ConvertOptions, "texSize" | "webpQuality">): Promise<number> {
  let changed = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const image = tex.getImage();
    const mime = tex.getMimeType();
    if (!image || !["image/png", "image/jpeg", "image/webp"].includes(mime)) continue;
    const out = await encode(image, mime, o.texSize, o.webpQuality);
    if (!out) continue;
    tex.setImage(out.data).setMimeType(out.mimeType).setURI("");
    changed++;
  }
  if (changed) doc.createExtension(EXTTextureWebP).setRequired(true);
  return changed;
}

/** Runs the whole pipeline on `doc` (in place). */
export async function optimizeDocument(doc: Document, options: Partial<ConvertOptions>, deps: PipelineDeps = {}): Promise<{ dropped: number }> {
  const o = withDefaults(options);
  const stage = deps.onStage ?? (() => undefined);
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const run = (...t: Transform[]) => doc.transform(...t);

  stage("cleaning");
  const dropped = dropParts(doc, o);
  await run(dedup(), instance({ min: o.instanceMin }));
  if (!o.keepGraph) await run(flatten(), join({ keepNamed: false, keepMeshes: false }));
  await run(weld());

  stage("simplifying");
  await run(simplify({ simplifier: MeshoptSimplifier, error: o.error, ratio: o.ratio, lockBorder: o.lockBorder }));

  await run(prune({ keepAttributes: false, keepIndices: false, keepLeaves: false, keepSolidTextures: false }), sparse());

  if (deps.encodeTexture) {
    stage("textures");
    await compressTextures(doc, deps.encodeTexture, o);
  }

  stage("compressing");
  await run(meshopt({ encoder: MeshoptEncoder, level: o.meshoptLevel }));
  return { dropped };
}

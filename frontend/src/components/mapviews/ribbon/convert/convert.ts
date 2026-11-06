import { Logger, WebIO, type Document, type JSONDocument } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { unzipSync } from "fflate";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { countTriangles, optimizeDocument, type TextureEncoder } from "./pipeline.ts";
import { ConvertError, classify, collectResources, normalizePath, type InputFile } from "./fileSet.ts";
import { type ConvertOptions, type Stage } from "./settings.ts";

export interface ConvertStats { bytesBefore: number; bytesAfter: number; trianglesBefore: number; trianglesAfter: number }
export interface ConvertResult { glb: Uint8Array; stats: ConvertStats; dropped: number }

export interface ConvertDeps {
  encodeTexture?: TextureEncoder;
  onStage?: (s: Stage) => void;
}

/** Unpacks a zip into a file set (folders, `__MACOSX` and dot-files skipped). */
export function unzipFiles(zip: Uint8Array): InputFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new ConvertError("invalid", "Couldn't read this .zip file.");
  }
  return Object.entries(entries)
    .filter(([p, d]) => !p.endsWith("/") && d.length > 0 && !p.startsWith("__MACOSX/") && !normalizePath(p).split("/").some((s) => s.startsWith(".")))
    .map(([path, data]) => ({ path: normalizePath(path), data }));
}

async function readDocument(files: InputFile[]): Promise<Document> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  let set = files;
  let picked = classify(set);
  if (picked.kind === "zip") {
    set = unzipFiles(set.find((f) => f.path === picked.main)!.data);
    picked = classify(set);
    if (picked.kind === "zip") throw new ConvertError("unsupported", "The .zip holds no .glb or .gltf file.");
  }
  const main = set.find((f) => f.path === picked.main)!;
  try {
    const quiet = (d: Document) => d.setLogger(new Logger(Logger.Verbosity.WARN));
    if (picked.kind === "glb") return quiet(await io.readBinary(main.data));
    let json: JSONDocument["json"];
    try {
      json = JSON.parse(new TextDecoder().decode(main.data));
    } catch {
      throw new ConvertError("invalid", `${picked.main} isn't valid glTF JSON.`);
    }
    const resources = collectResources(picked.main, json, set);
    return quiet(await io.readJSON({ json, resources: resources as Record<string, Uint8Array<ArrayBuffer>> }));
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/draco/i.test(msg)) throw new ConvertError("unsupported", "Draco-compressed models can't be re-optimised here. Load the .glb as it is, or re-export it uncompressed.");
    throw new ConvertError("invalid", `Couldn't read the model: ${msg}`);
  }
}

/**
 * Reads a .glb, a .gltf with its files, or a .zip holding one, optionally optimises it (the shared pipeline), and returns one .glb.
 * `optimise: false` only packs the files into a single .glb, unchanged.
 */
export async function convertFiles(files: InputFile[], options: Partial<ConvertOptions> & { optimise?: boolean }, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const stage = deps.onStage ?? (() => undefined);
  stage("reading");
  const doc = await readDocument(files);
  const bytesBefore = files.reduce((n, f) => n + f.data.byteLength, 0);
  const trianglesBefore = countTriangles(doc);
  let dropped = 0;
  if (options.optimise !== false) ({ dropped } = await optimizeDocument(doc, options, deps));
  stage("saving");
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const glb = await io.writeBinary(doc);
  return { glb, dropped, stats: { bytesBefore, bytesAfter: glb.byteLength, trianglesBefore, trianglesAfter: countTriangles(doc) } };
}


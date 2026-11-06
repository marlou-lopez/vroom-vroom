/**
 * Turning what the user picked (a .glb, a .gltf with its files, a folder, a zip) into one file set, and resolving a glTF's
 * relative URIs against it. Pure: no DOM, no three.js.
 */

export interface InputFile { path: string; data: Uint8Array }

export class ConvertError extends Error {
  code: "missing-file" | "unsupported" | "invalid" | "oom" | "worker";
  constructor(code: "missing-file" | "unsupported" | "invalid" | "oom" | "worker", message: string) {
    super(message);
    this.code = code;
    this.name = "ConvertError";
  }
}

export const extOf = (path: string): string => {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
};

/** Forward slashes, no leading "./" or "/", "." and ".." segments resolved. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export interface PickedKind {
  kind: "glb" | "gltf" | "zip";
  /** The main file's path. */
  main: string;
}

/**
 * What was picked: a single .glb, a .zip (alone), or a .gltf (with its files). A folder pick can hold several; scene.gltf /
 * scene.glb win, then the first. Throws `unsupported` for anything else.
 */
export function classify(files: { path: string }[]): PickedKind {
  if (files.length === 0) throw new ConvertError("unsupported", "No files were chosen.");
  const byExt = (e: string) => files.filter((f) => extOf(f.path) === e).map((f) => f.path);
  const prefer = (list: string[]) => list.find((p) => /(^|\/)scene\.(gltf|glb)$/i.test(p)) ?? list.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  const gltf = byExt("gltf"), glb = byExt("glb"), zip = byExt("zip");
  if (gltf.length) return { kind: "gltf", main: prefer(gltf) };
  if (glb.length) return { kind: "glb", main: prefer(glb) };
  if (zip.length) return { kind: "zip", main: prefer(zip) };
  const ext = extOf(files[0].path);
  throw new ConvertError("unsupported", `Unsupported file type${ext ? ` (.${ext})` : ""}. Choose a .glb, a .zip, or a folder with a .gltf and its files.`);
}

/** A glTF's relative URI as a path in the file set; null for `data:` URIs (embedded). */
export function resolveUri(gltfPath: string, uri: string): string | null {
  if (/^data:/i.test(uri)) return null;
  let decoded = uri;
  try { decoded = decodeURIComponent(uri); } catch { /* keep as written */ }
  return normalizePath(`${dirOf(normalizePath(gltfPath))}/${decoded}`);
}

/**
 * The resources a .gltf references, keyed by the exact URI string in the JSON (what gltf-transform's `readJSON` wants).
 * Tries the exact path, then the same path ignoring case, then, if the files came from a folder pick whose root name
 * differs, the path relative to the gltf's directory. Throws `missing-file` naming the first one not found.
 */
export function collectResources(gltfPath: string, json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }, files: InputFile[]): Record<string, Uint8Array> {
  const exact = new Map(files.map((f) => [normalizePath(f.path), f.data]));
  const lower = new Map(files.map((f) => [normalizePath(f.path).toLowerCase(), f.data]));
  const out: Record<string, Uint8Array> = {};
  for (const ref of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    const uri = ref.uri;
    if (!uri) continue;
    const path = resolveUri(gltfPath, uri);
    if (path === null) continue;
    const data = exact.get(path) ?? lower.get(path.toLowerCase());
    if (!data) throw new ConvertError("missing-file", `The model refers to "${uri}", which wasn't in the files you chose. Choose the whole folder or a .zip.`);
    out[uri] = data;
  }
  return out;
}

const MAGIC = 0x46546c67;

/** Whether `bytes` is a binary glTF, and the extensions its JSON chunk says it uses (cheap: reads only the JSON chunk). */
export function inspectGlb(bytes: ArrayBuffer): { glb: boolean; extensionsUsed: string[] } {
  if (bytes.byteLength < 20) return { glb: false, extensionsUsed: [] };
  const dv = new DataView(bytes);
  if (dv.getUint32(0, true) !== MAGIC) return { glb: false, extensionsUsed: [] };
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > bytes.byteLength) return { glb: true, extensionsUsed: [] };
  try {
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, len))) as { extensionsUsed?: string[] };
    return { glb: true, extensionsUsed: json.extensionsUsed ?? [] };
  } catch {
    return { glb: true, extensionsUsed: [] };
  }
}

/** Above this size an already-compressed .glb is still worth optimising; at or below it, a compressed .glb is used as it is. */
export const SKIP_CONVERSION_BYTES = 15 * 1024 * 1024;

export const isCompressed = (ext: string[]): boolean => ext.includes("EXT_meshopt_compression") || ext.includes("KHR_draco_mesh_compression");

/** True when a single .glb is small and already mesh-compressed: conversion would gain little. */
export function canSkipConversion(bytes: ArrayBuffer): boolean {
  const i = inspectGlb(bytes);
  return i.glb && bytes.byteLength <= SKIP_CONVERSION_BYTES && isCompressed(i.extensionsUsed);
}

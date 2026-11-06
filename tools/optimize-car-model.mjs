// Turns a downloaded car glTF (a folder, a .zip, a .gltf or a .glb) into one small GLB for the 3D view's "bring your own model" slot (#102).
//   node tools/optimize-car-model.mjs <source folder, .zip, .gltf or .glb> <out.glb> [--ratio 0.3] [--tex 1024] [--keep-cockpit] [--keep-graph]
// Example: node tools/optimize-car-model.mjs ~/Downloads/car frontend/public/local-models/mclaren_720s_gt3_evo.glb
//
// You usually do not need this: the 3D view's Car popover converts the same inputs in the browser, with the same pipeline.
// This script runs that pipeline (frontend/src/components/mapviews/ribbon/convert/: settings.ts holds the parts to drop and the
// settings, pipeline.ts the steps) on the command line, so the two cannot drift. It needs Node 22.18+ (it imports the TypeScript
// files directly), `npm ci` in frontend/ (gltf-transform, meshoptimizer, fflate), and network once for `sharp`, which it installs
// into a temp dir to encode WebP (the browser uses OffscreenCanvas instead). The output is git-ignored
// (frontend/public/local-models/): do not commit models.
//
// Steps: (1) drop parts an exterior/chase view never shows (damage glass, rim blur, high-res cockpit, seat belts, wipers, brake
// discs...), keeping the steering wheel and the RPM LEDs by name for #101; (2) the gltf-transform CLI's `optimize` steps as
// function calls: dedup, instance, flatten, join, weld, simplify, prune, sparse, textures to WebP at most --tex px, meshopt.
// --keep-graph skips flatten and join, so the RPM and slip LEDs and the steering wheel stay as separate named nodes (#101);
// the default joins meshes by material for fewer draw calls, which merges the LEDs away.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const here = new URL(".", import.meta.url);
const pipeline = (f) => import(new URL(`../frontend/src/components/mapviews/ribbon/convert/${f}`, here).href);

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args.splice(i, 2)[1]; };
const bool = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const keepCockpit = bool("--keep-cockpit"), keepGraph = bool("--keep-graph");
const ratio = Number(flag("--ratio", "0.3")), texSize = Number(flag("--tex", "1024"));
const lockBorder = flag("--lock-border", "true") !== "false";
const [src, out] = args;
if (!src || !out) { console.error("usage: node tools/optimize-car-model.mjs <source folder, .zip, .gltf or .glb> <out.glb> [--ratio 0.3] [--tex 1024] [--keep-cockpit] [--keep-graph]"); process.exit(1); }

/** Every file under `dir` as { path relative to dir, data }. */
function readTree(dir) {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push({ path: relative(dir, p).split("\\").join("/"), data: new Uint8Array(readFileSync(p)) }); } };
  walk(dir);
  return files;
}
const input = resolve(src);
let files;
if (statSync(input).isDirectory()) files = readTree(input);
else if (/\.gltf$/i.test(input)) files = readTree(resolve(input, ".."));
else files = [{ path: input.split(/[\\/]/).pop(), data: new Uint8Array(readFileSync(input)) }];

const work = mkdtempSync(join(tmpdir(), "car-model-"));
console.log("installing sharp (WebP encoder) in", work);
execFileSync("npm", ["i", "--silent", "--prefix", work, "sharp@0.35.5"], { stdio: "inherit" });
const sharp = createRequire(join(work, "x.js"))("sharp");

/** Same contract as the browser's encoder (webpEncoder.ts): scale down to fit maxSize, re-encode as WebP, null to keep. */
async function encodeTexture(image, mimeType, maxSize, quality) {
  const img = sharp(image, { limitInputPixels: false });
  const { width, height } = await img.metadata();
  const scale = Math.min(1, maxSize / Math.max(width, height));
  if (mimeType === "image/webp" && scale === 1) return null;
  const buf = await (scale < 1 ? img.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))) : img).webp({ quality: Math.round(quality * 100) }).toBuffer();
  return { data: new Uint8Array(buf), mimeType: "image/webp" };
}

const { convertFiles } = await pipeline("convert.ts");
const result = await convertFiles(files, { ratio, texSize, keepCockpit, keepGraph, lockBorder }, { encodeTexture, onStage: (s) => console.log(s) });
writeFileSync(resolve(out), result.glb);
const mb = (n) => (n / 1e6).toFixed(2);
console.log(`dropped ${result.dropped} subtrees; triangles ${result.stats.trianglesBefore} -> ${result.stats.trianglesAfter}`);
console.log("wrote", resolve(out), `${mb(result.stats.bytesBefore)} MB -> ${mb(result.stats.bytesAfter)} MB`);

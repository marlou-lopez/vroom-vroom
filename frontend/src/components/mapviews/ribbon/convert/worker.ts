/// <reference lib="webworker" />
import type { ConvertStats } from "./convert.ts";
import type { InputFile } from "./fileSet.ts";
import type { ConvertOptions, Stage } from "./settings.ts";

export interface WorkerRequest { type: "convert"; files: InputFile[]; options: Partial<ConvertOptions> & { optimise?: boolean } }
export type WorkerMessage =
  | { type: "stage"; stage: Stage }
  | { type: "done"; glb: ArrayBuffer; stats: ConvertStats; dropped: number }
  | { type: "error"; code: string; message: string };

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type !== "convert") return;
  try {
    // Loaded only now, when a conversion starts: gltf-transform, meshoptimizer (WASM) and fflate stay out of every other chunk.
    const [{ convertFiles }, { encodeWebpInBrowser }] = await Promise.all([import("./convert.ts"), import("./webpEncoder.ts")]);
    const out = await convertFiles(e.data.files, e.data.options, { encodeTexture: encodeWebpInBrowser, onStage: (stage) => post({ type: "stage", stage }) });
    // Hand the output buffer over without copying (a GLB from gltf-transform owns its buffer).
    const glb = out.glb.byteOffset === 0 && out.glb.byteLength === out.glb.buffer.byteLength ? (out.glb.buffer as ArrayBuffer) : out.glb.slice().buffer;
    post({ type: "done", glb, stats: out.stats, dropped: out.dropped }, [glb]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === "missing-file" || code === "unsupported" || code === "invalid") post({ type: "error", code, message: msg });
    else if (err instanceof RangeError || /memory|allocation/i.test(msg)) {
      post({ type: "error", code: "oom", message: "The browser ran out of memory converting this model. Try a smaller model, or run tools/optimize-car-model.mjs." });
    } else post({ type: "error", code: "invalid", message: `Conversion failed: ${msg}` });
  }
};

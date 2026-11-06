import type { ConvertStats } from "./convert.ts";
import { ConvertError, type InputFile } from "./fileSet.ts";
import type { ConvertOptions, Stage } from "./settings.ts";
import type { WorkerMessage, WorkerRequest } from "./worker.ts";

export interface Conversion {
  promise: Promise<{ glb: ArrayBuffer; stats: ConvertStats; dropped: number }>;
  /** Terminates the worker; the promise rejects with `code: "cancelled"`. */
  cancel(): void;
}

export type StartConversion = (files: InputFile[], options: Partial<ConvertOptions> & { optimise?: boolean }, onStage: (s: Stage) => void) => Conversion;

export class Cancelled extends Error { constructor() { super("Cancelled"); this.name = "Cancelled"; } }

/** Starts a conversion in a module Web Worker. The file buffers are transferred, not copied (the caller must not reuse them). */
export const startConversion: StartConversion = (files, options, onStage) => {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let cancel = () => undefined as void;
  const promise = new Promise<Awaited<Conversion["promise"]>>((resolve, reject) => {
    cancel = () => { worker.terminate(); reject(new Cancelled()); };
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "stage") onStage(m.stage);
      else { worker.terminate(); if (m.type === "done") resolve(m); else reject(new ConvertError(m.code as ConvertError["code"], m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new ConvertError("worker", `The converter failed to start${e.message ? `: ${e.message}` : ""}.`)); };
    const req: WorkerRequest = { type: "convert", files, options };
    worker.postMessage(req, files.map((f) => f.data.buffer as ArrayBuffer));
  });
  return { promise, cancel: () => cancel() };
};

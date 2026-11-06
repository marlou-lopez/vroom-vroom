import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../../../lib/cx";
import ui from "../../ui.module.css";
import { LARGE_MODEL_BYTES, READ_ERROR, carModelStore, formatBytes, isGlb, modelUrl, probeLocalModel, type CarModelStore, type StoredCarModel } from "./carModelStore";
import { Cancelled, startConversion, type StartConversion } from "./convert/client.ts";
import { filesFromDrop, filesFromInput, type PickedFile } from "./convert/dropFiles.ts";
import { ConvertError, canSkipConversion, classify, type InputFile } from "./convert/fileSet.ts";
import { STAGES, type Stage } from "./convert/settings.ts";
import styles from "./CarModelControl.module.css";

export interface CarEntry { carId: string; name: string }

/** Validates GLB bytes with the 3D view's own loader (loaded on demand: it pulls in three.js). Throws when unusable. */
async function defaultValidate(bytes: ArrayBuffer): Promise<void> {
  const { parseGlb, disposeModel } = await import("./carModel");
  const m = await parseGlb(bytes);
  disposeModel(m.root);
}

interface Props {
  /** The lap car, and the reference car when its car_id differs. */
  cars: CarEntry[];
  disabled?: boolean;
  /** Injectable for tests. */
  store?: CarModelStore;
  validate?: (bytes: ArrayBuffer) => Promise<void>;
  probe?: (url: string) => Promise<boolean>;
  /** Starts a conversion in a Web Worker; injectable for tests. */
  convert?: StartConversion;
}

const STAGE_LABEL: Record<Stage, string> = {
  reading: "Reading", cleaning: "Cleaning", simplifying: "Simplifying", textures: "Compressing textures", compressing: "Compressing", saving: "Saving",
};
const mb = (n: number) => formatBytes(n);
const stem = (p: string) => p.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

/** The "Car" button of the 3D view and its popover: load, rotate or remove the user's own model per car (#102). Stays in this browser. */
export function CarModelControl({ cars, disabled, store, validate = defaultValidate, probe = probeLocalModel, convert = startConversion }: Props) {
  const s = store ?? carModelStore();
  const [busy, setBusy] = useState(0);
  const unique = cars.filter((c, i) => cars.findIndex((o) => o.carId === c.carId) === i);
  return (
    <Popover.Root>
      <Popover.Trigger className={cx(ui.btn, styles.trigger)} disabled={disabled}>Car</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.content} align="end" sideOffset={6} collisionPadding={8} aria-label="Car models"
          onInteractOutside={(e) => { if (busy) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}>
          {unique.map((c) => <CarSection key={c.carId} car={c} store={s} validate={validate} probe={probe} convert={convert} onBusy={(b) => setBusy((n) => n + (b ? 1 : -1))} />)}
          <p className={styles.help}>
            Choose a .glb, a .zip, or a folder with a .gltf and its files (a raw Sketchfab download). Anything but a small compressed .glb
            is converted here in your browser first: unneeded parts dropped, meshes simplified and textures shrunk, which can take a minute.
            The same steps run on the command line with <code>node tools/optimize-car-model.mjs</code>.
          </p>
          <p className={styles.help}>Stays in this browser; it isn&apos;t uploaded. Only use a model you have the right to use.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type Meta = Pick<StoredCarModel, "fileName" | "size" | "rotate180">;

function CarSection({ car, store, validate, probe, convert, onBusy }: {
  car: CarEntry; store: CarModelStore; validate: Props["validate"] & {}; probe: Props["probe"] & {}; convert: StartConversion; onBusy: (b: boolean) => void;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [local, setLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [optimise, setOptimise] = useState(true);
  const [over, setOver] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const read = useCallback(async (): Promise<{ meta: Meta | null; local: boolean }> => {
    const rec = await store.get(car.carId);
    if (rec) return { meta: { fileName: rec.fileName, size: rec.size, rotate180: rec.rotate180 }, local: false };
    return { meta: null, local: await probe(modelUrl(car.carId)) };
  }, [store, probe, car.carId]);

  const refresh = async () => {
    const r = await read();
    setMeta(r.meta);
    setLocal(r.local);
  };

  useEffect(() => {
    let live = true;
    void read().then((r) => {
      if (!live) return;
      setMeta(r.meta);
      setLocal(r.local);
    });
    return () => { live = false; };
  }, [read]);

  const setBusy = (b: boolean) => { setBusyState(b); onBusy(b); };
  // Closing the popover (or leaving the page) stops a running conversion.
  useEffect(() => () => cancelRef.current?.(), []);

  /** Validates `bytes` with the real loader, stores them and shows the result. Throws READ_ERROR-worthy errors. */
  const saveGlb = async (bytes: ArrayBuffer, fileName: string, extra?: string) => {
    if (!isGlb(bytes)) throw new Error("not a glb");
    await validate(bytes);
    const prev = await store.get(car.carId);
    const ok = await store.put({ carId: car.carId, bytes, fileName, size: bytes.byteLength, addedAt: Date.now(), rotate180: prev?.rotate180 ?? false });
    if (!ok) {
      setError("This browser wouldn't store the file (storage is blocked or full). Nothing was saved.");
      return;
    }
    const notes = [extra, bytes.byteLength > LARGE_MODEL_BYTES ? `${mb(bytes.byteLength)} is large and may draw slowly. node tools/optimize-car-model.mjs makes a smaller .glb.` : null];
    setNote(notes.filter(Boolean).join(" ") || null);
  };

  const onPicked = async (picked: PickedFile[]) => {
    if (!picked.length) return;
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const kind = classify(picked);
      if (kind.kind === "glb" && picked.length === 1) {
        const bytes = await picked[0].file.arrayBuffer();
        if (!isGlb(bytes)) throw new Error("not a glb");
        if (!optimise || canSkipConversion(bytes)) {
          await saveGlb(bytes, picked[0].file.name);
          await refresh();
          return;
        }
      }
      const inputs: InputFile[] = await Promise.all(picked.map(async (p) => ({ path: p.path, data: new Uint8Array(await p.file.arrayBuffer()) })));
      setStage("reading");
      const conv = convert(inputs, { optimise }, setStage);
      cancelRef.current = conv.cancel;
      const res = await conv.promise;
      cancelRef.current = null;
      const s = res.stats;
      const top = picked.find((p) => p.path === kind.main)?.path ?? kind.main;
      const name = `${top.includes("/") && stem(top) === "scene" ? top.split("/")[0] : stem(top)}.glb`;
      const summary = `${optimise ? "Optimised" : "Converted"}: ${mb(s.bytesBefore)} to ${mb(s.bytesAfter)}, ${s.trianglesBefore.toLocaleString("en-US")} to ${s.trianglesAfter.toLocaleString("en-US")} triangles.`;
      await saveGlb(res.glb, name, summary);
      await refresh();
    } catch (e) {
      if (e instanceof Cancelled) setNote("Cancelled. Nothing was changed.");
      else if (e instanceof ConvertError) setError(e.message);
      else setError(READ_ERROR);
    } finally {
      cancelRef.current = null;
      setStage(null);
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
      if (dirRef.current) dirRef.current.value = "";
    }
  };

  const rotate = async () => {
    if (!meta) return;
    if (await store.setRotate(car.carId, !meta.rotate180)) await refresh();
  };

  const remove = async () => {
    setError(null);
    setNote(null);
    await store.remove(car.carId);
    await refresh();
  };

  const source = meta ? `Your model: ${meta.fileName} (${formatBytes(meta.size)})` : local ? "Local file" : "Box";

  return (
    <section className={styles.section} aria-label={car.name}>
      <div
        className={cx(styles.drop, over && styles.over)}
        onDragOver={(e) => { if (!busy) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) void filesFromDrop(e.dataTransfer).then(onPicked); }}
      >
      <div className={styles.name}>{car.name}</div>
      <div className={styles.source}>
        <span className={styles.tag}>Source</span> <span data-testid="car-source">{source}</span>
      </div>
      <div className={styles.row}>
        <input
          ref={fileRef} type="file" accept=".glb,.gltf,.zip,model/gltf-binary,application/zip" multiple className={styles.file} tabIndex={-1}
          aria-label={`Load .glb for ${car.name}`} onChange={(e) => void onPicked(filesFromInput(e.target.files))}
        />
        <input
          ref={dirRef} type="file" multiple className={styles.file} tabIndex={-1} aria-label={`Load folder for ${car.name}`}
          {...{ webkitdirectory: "" }} onChange={(e) => void onPicked(filesFromInput(e.target.files))}
        />
        <button type="button" className={cx(ui.btn, styles.small)} disabled={busy} onClick={() => fileRef.current?.click()}>Load file…</button>
        <button type="button" className={cx(ui.btn, styles.small)} disabled={busy} onClick={() => dirRef.current?.click()}>Load folder…</button>
        <button type="button" className={cx(ui.btn, styles.small)} disabled={!meta || busy} aria-pressed={meta?.rotate180 ?? false} onClick={() => void rotate()}>
          Rotate 180°
        </button>
        <button type="button" className={cx(ui.btn, ui.btnMuted, styles.small)} disabled={!meta || busy} onClick={() => void remove()}>Remove</button>
      </div>
      <label className={styles.check} title="Drops unneeded parts, simplifies meshes and shrinks textures. Off: only packs the files into one .glb.">
        <input type="checkbox" checked={optimise} disabled={busy} onChange={(e) => setOptimise(e.target.checked)} /> Optimise
      </label>
      <div className={styles.hint}>.glb, .zip or a folder; or drop one here.</div>
      {stage && (
        <div className={styles.progress} role="status">
          <span>{`Step ${STAGES.indexOf(stage) + 1} of ${STAGES.length}: ${STAGE_LABEL[stage]}…`}</span>
          <button type="button" className={cx(ui.btn, styles.small)} onClick={() => cancelRef.current?.()}>Cancel</button>
        </div>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {note && <div className={styles.note} role="status">{note}</div>}
      </div>
    </section>
  );
}

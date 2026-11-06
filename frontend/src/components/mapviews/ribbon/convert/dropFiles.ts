/** Files from a drag-and-drop, folders included (walks `webkitGetAsEntry`). Paths are relative to the dropped item's parent. */
export interface PickedFile { path: string; file: File }

interface FsEntry {
  isFile: boolean; isDirectory: boolean; name: string; fullPath: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: FsEntry[]) => void, err: (e: unknown) => void): void };
}

async function walk(entry: FsEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ path: entry.fullPath.replace(/^\//, ""), file });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call: read until it returns none.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  // The entries must be taken synchronously: the DataTransfer is emptied after the event handler returns.
  const entries = Array.from(dt.items).map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  const out: PickedFile[] = [];
  if (entries.some(Boolean)) {
    for (const e of entries) if (e) await walk(e, out);
  } else {
    for (const f of Array.from(dt.files)) out.push({ path: f.name, file: f });
  }
  return out;
}

/** Files from an `<input type=file>`; a folder pick gives `webkitRelativePath`. */
export const filesFromInput = (list: FileList | null): PickedFile[] => Array.from(list ?? []).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));

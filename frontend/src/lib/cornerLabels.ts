export interface LabelInput {
  id: string;
  name: string;
  /** Position along the scrubber, 0..1. */
  frac: number;
  /** A corner with a finding or a top-three loss: its label is never dropped. */
  priority: boolean;
}

export interface PlacedLabel {
  id: string;
  /** Full name, short code, or "·" (a dot left as the click target). */
  text: string;
  mode: "full" | "short" | "dot";
}

const CHAR_PX = 5.6; // 10 px Inter, average glyph width
const PAD_PX = 8;

/** `Rettifilo 2` → `R2`, `Eau Rouge` → `ER`, `T9` → `T9`, `Bruxelles` → `Bru`. */
export function shortCorner(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].length <= 3 ? words[0] : words[0].slice(0, 3);
  const last = words[words.length - 1];
  const rest = /^\d+$/.test(last) ? words.slice(0, -1) : words;
  return rest.map((w) => w[0].toUpperCase()).join("") + (rest === words ? "" : last);
}

const width = (text: string) => text.length * CHAR_PX + PAD_PX;

/**
 * Chooses a label for each corner on a scrubber `widthPx` wide. Priority corners are placed first and always get a
 * text label (full name when it fits, else the short code, even if it then overlaps). The others take the full name
 * when it clears what is placed, else the short code, else a dot. Returned in the input order.
 */
export function layoutCornerLabels(items: LabelInput[], widthPx: number): PlacedLabel[] {
  const placed: [number, number][] = [];
  const clear = (x: number, w: number) => placed.every(([l, r]) => x + w / 2 <= l || x - w / 2 >= r);
  const take = (x: number, w: number) => placed.push([x - w / 2, x + w / 2]);
  const result = new Map<string, PlacedLabel>();
  const order = [
    ...items.filter((i) => i.priority).sort((a, b) => a.frac - b.frac),
    ...items.filter((i) => !i.priority).sort((a, b) => a.frac - b.frac),
  ];
  for (const it of order) {
    const x = it.frac * widthPx;
    const short = shortCorner(it.name);
    const fw = width(it.name);
    const sw = width(short);
    let label: PlacedLabel;
    if (clear(x, fw)) { take(x, fw); label = { id: it.id, text: it.name, mode: "full" }; }
    else if (clear(x, sw) || it.priority) { take(x, sw); label = { id: it.id, text: short, mode: "short" }; }
    else label = { id: it.id, text: "·", mode: "dot" };
    result.set(it.id, label);
  }
  return items.map((i) => result.get(i.id)!);
}

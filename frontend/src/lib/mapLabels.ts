export interface LabelAnchor {
  id: string;
  text: string;
  /** The point the label names (map units). */
  x: number;
  y: number;
}

export interface MapLabel {
  id: string;
  text: string;
  /** Centre of the text box. */
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: { x: number; y: number };
  /** Where a leader line meets the text box (its edge nearest the anchor). */
  edge: { x: number; y: number };
  /** The label sits away from its anchor: draw a line between them. */
  leader: boolean;
}

export interface LabelOptions {
  /** Font size in map units. */
  fontSize: number;
  /** Points of the track line; labels avoid sitting on them. */
  obstacles?: { x: number; y: number }[];
}

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1],
];
const RINGS = [0.5, 1.6, 3, 4.6, 6.4]; // gap from the anchor, in font sizes
const CHAR_W = 0.58; // average glyph width in font sizes
const CLEAR = 0.5; // a candidate cheaper than this overlaps nothing

const overlap = (a: MapLabel, b: MapLabel) => {
  const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

/**
 * Places a text box next to each anchor so no two boxes overlap: the nearest of 8 directions at growing distances
 * that clears everything placed so far and the track line. A label that had to move away gets a leader line. When
 * nothing clears, the candidate with the least overlap wins. Anchors are placed in the order given and returned in it.
 */
export function placeMapLabels(anchors: LabelAnchor[], { fontSize, obstacles = [] }: LabelOptions): MapLabel[] {
  const h = fontSize * 1.25;
  const placed: MapLabel[] = [];
  for (const a of anchors) {
    const w = a.text.length * fontSize * CHAR_W + fontSize * 0.4;
    let best: MapLabel | null = null;
    let bestCost = Infinity;
    for (let r = 0; r < RINGS.length && bestCost >= CLEAR; r++) {
      const gap = RINGS[r] * fontSize;
      for (const [dx, dy] of DIRS) {
        const k = dx !== 0 && dy !== 0 ? 0.8 : 1;
        const cand: MapLabel = {
          id: a.id,
          text: a.text,
          x: a.x + dx * (w / 2 + gap) * k,
          y: a.y + dy * (h / 2 + gap) * k,
          w,
          h,
          anchor: { x: a.x, y: a.y },
          edge: {
            x: Math.min(Math.max(a.x, a.x + dx * (w / 2 + gap) * k - w / 2), a.x + dx * (w / 2 + gap) * k + w / 2),
            y: Math.min(Math.max(a.y, a.y + dy * (h / 2 + gap) * k - h / 2), a.y + dy * (h / 2 + gap) * k + h / 2),
          },
          leader: r > 1,
        };
        let cost = r * 0.01;
        for (const p of placed) cost += overlap(cand, p) * 100;
        for (const o of obstacles) {
          if (Math.abs(o.x - cand.x) < w / 2 && Math.abs(o.y - cand.y) < h / 2) cost += CLEAR;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = cand;
        }
      }
    }
    placed.push(best!);
  }
  return placed;
}

/** Bounding box of the points and the placed labels. */
export function boundsOf(points: { x: number[]; y: number[] }, labels: MapLabel[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.x.length; i++) {
    minX = Math.min(minX, points.x[i]); maxX = Math.max(maxX, points.x[i]);
    minY = Math.min(minY, points.y[i]); maxY = Math.max(maxY, points.y[i]);
  }
  for (const l of labels) {
    minX = Math.min(minX, l.x - l.w / 2); maxX = Math.max(maxX, l.x + l.w / 2);
    minY = Math.min(minY, l.y - l.h / 2); maxY = Math.max(maxY, l.y + l.h / 2);
  }
  return { minX, minY, maxX, maxY };
}

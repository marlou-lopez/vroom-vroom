// Page-wide playback keys (vroom-pnw.36): what each key does, and the pure parts (which keys to leave alone, which step).

export type PlaybackKeyAction =
  | { kind: "toggle" }
  | { kind: "seekBy"; seconds: number }
  | { kind: "corner"; dir: 1 | -1 }
  | { kind: "issue"; dir: 1 | -1 };

/** Seconds per arrow press, with Shift, and per J / L. */
export const ARROW_SEEK_S = 0.5;
export const ARROW_BIG_SEEK_S = 5;
export const JKL_SEEK_S = 5;

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Fields you type into, and an open dialog or popover: they own every key. */
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=menu]";
/** Widgets that use the arrow keys themselves. */
const OWN_ARROWS = `${TYPING}, [role=slider], [role=tab], [role=radio], [role=menu], [role=menuitem], [role=listbox], [role=option], [role=toolbar], [role=region]`;
/** Elements Space activates. */
const OWN_SPACE = `${TYPING}, button, a[href], summary, [role=button], [role=switch], [role=checkbox], [role=tab], [role=menuitem], [role=option]`;

/** True when the key belongs to a text field or an open dialog. */
export function isTypingTarget(target: Element | null): boolean {
  return !!target?.closest(TYPING);
}

/** The key's action for the given focused element, or null when the page should leave the key alone. */
export function playbackKeyAction(e: KeyLike, target: Element | null): PlaybackKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(target)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (k) {
    case " ":
      return target?.closest(OWN_SPACE) ? null : { kind: "toggle" };
    case "k":
      return { kind: "toggle" };
    case "j":
      return { kind: "seekBy", seconds: -JKL_SEEK_S };
    case "l":
      return { kind: "seekBy", seconds: JKL_SEEK_S };
    case "ArrowLeft":
    case "ArrowRight": {
      if (target?.closest(OWN_ARROWS)) return null;
      const s = e.shiftKey ? ARROW_BIG_SEEK_S : ARROW_SEEK_S;
      return { kind: "seekBy", seconds: k === "ArrowRight" ? s : -s };
    }
    case "[":
      return { kind: "corner", dir: -1 };
    case "]":
      return { kind: "corner", dir: 1 };
    case "n":
      return { kind: "issue", dir: e.shiftKey ? -1 : 1 };
    default:
      return null;
  }
}

/** The next (dir 1) or previous seek target strictly after or before `tau`, or null at either end. `times` need not be sorted. */
export function stepTime(times: readonly number[], tau: number, dir: 1 | -1, eps = 0.05): number | null {
  let best: number | null = null;
  for (const t of times) {
    if (dir === 1 ? t > tau + eps && (best === null || t < best) : t < tau - eps && (best === null || t > best)) best = t;
  }
  return best;
}

export interface ShortcutGroup {
  title: string;
  rows: { keys: string[]; what: string }[];
}

/** What the "?" popover lists. Keep in step with `playbackKeyAction`, the strips, the lap rail and the scrubber. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Playback (anywhere on the page)",
    rows: [
      { keys: ["Space", "K"], what: "Play or pause" },
      { keys: ["←", "→"], what: "Step 0.5 s (Shift: 5 s)" },
      { keys: ["J", "L"], what: "Back or forward 5 s" },
      { keys: ["[", "]"], what: "Previous or next corner" },
      { keys: ["N", "Shift+N"], what: "Next or previous issue (a finding or a loss)" },
      { keys: ["?"], what: "Show or hide this list" },
    ],
  },
  {
    title: "Scrubber",
    rows: [
      { keys: ["←", "→"], what: "Step 0.05 s" },
      { keys: ["PageUp", "PageDown"], what: "Forward or back 5 s" },
      { keys: ["Home", "End"], what: "Start or end of the lap" },
    ],
  },
  {
    title: "Corner ticks (under the scrubber)",
    rows: [
      { keys: ["←", "→"], what: "Move between corners, hidden labels included" },
      { keys: ["Home", "End"], what: "First or last corner" },
      { keys: ["Enter"], what: "Jump to the corner" },
    ],
  },
  {
    title: "Strips (when focused)",
    rows: [
      { keys: ["←", "→"], what: "Move along the lap 10 m (Shift: 100 m)" },
      { keys: ["Space"], what: "Play or pause" },
      { keys: ["+", "−"], what: "Zoom the window in or out (100 m to the whole lap)" },
      { keys: ["Shift", "drag"], what: "Slide the view; the current position stays (middle-drag too)" },
      { keys: ["Wheel", "pinch"], what: "Zoom the window; double-click resets to 700 m" },
    ],
  },
  {
    title: "Lap list (when focused)",
    rows: [
      { keys: ["↑", "↓"], what: "Move between laps" },
      { keys: ["R"], what: "Use the lap as the comparison" },
    ],
  },
];

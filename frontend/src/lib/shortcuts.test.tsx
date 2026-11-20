import { describe, expect, it } from "vitest";
import { playbackKeyAction, stepTime, SHORTCUT_GROUPS } from "./shortcuts";

const key = (k: string, extra: Partial<Parameters<typeof playbackKeyAction>[0]> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
const el = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild!;
};

describe("playbackKeyAction", () => {
  it("maps the playback keys", () => {
    expect(playbackKeyAction(key(" "), document.body)).toEqual({ kind: "toggle" });
    expect(playbackKeyAction(key("k"), null)).toEqual({ kind: "toggle" });
    expect(playbackKeyAction(key("J"), null)).toEqual({ kind: "seekBy", seconds: -5 });
    expect(playbackKeyAction(key("l"), null)).toEqual({ kind: "seekBy", seconds: 5 });
    expect(playbackKeyAction(key("ArrowRight"), null)).toEqual({ kind: "seekBy", seconds: 0.5 });
    expect(playbackKeyAction(key("ArrowLeft", { shiftKey: true }), null)).toEqual({ kind: "seekBy", seconds: -5 });
    expect(playbackKeyAction(key("["), null)).toEqual({ kind: "corner", dir: -1 });
    expect(playbackKeyAction(key("]"), null)).toEqual({ kind: "corner", dir: 1 });
    expect(playbackKeyAction(key("n"), null)).toEqual({ kind: "issue", dir: 1 });
    expect(playbackKeyAction(key("N", { shiftKey: true }), null)).toEqual({ kind: "issue", dir: -1 });
    expect(playbackKeyAction(key("x"), null)).toBeNull();
  });

  it("leaves modified keys, text fields and dialogs alone", () => {
    expect(playbackKeyAction(key("k", { ctrlKey: true }), null)).toBeNull();
    expect(playbackKeyAction(key("l", { metaKey: true }), null)).toBeNull();
    for (const html of ["<input>", "<textarea></textarea>", "<select></select>", "<div contenteditable='true'></div>", "<div role='dialog'><button>x</button></div>"]) {
      const t = el(html);
      const target = t.querySelector("button") ?? t;
      expect(playbackKeyAction(key(" "), target), html).toBeNull();
      expect(playbackKeyAction(key("k"), target), html).toBeNull();
      expect(playbackKeyAction(key("ArrowLeft"), target), html).toBeNull();
    }
  });

  it("keeps Space for buttons and arrows for widgets that use them", () => {
    expect(playbackKeyAction(key(" "), el("<button>x</button>"))).toBeNull();
    expect(playbackKeyAction(key("ArrowLeft"), el("<span role='slider'></span>"))).toBeNull();
    expect(playbackKeyAction(key("ArrowLeft"), el("<button role='tab'></button>"))).toBeNull();
    expect(playbackKeyAction(key("ArrowLeft"), el("<div role='region' tabindex='0'></div>"))).toBeNull();
    expect(playbackKeyAction(key("k"), el("<div role='menu'></div>"))).toBeNull();
    // The scrubber thumb has no use for Space, and a button has none for J.
    expect(playbackKeyAction(key(" "), el("<span role='slider'></span>"))).toEqual({ kind: "toggle" });
    expect(playbackKeyAction(key("j"), el("<button>x</button>"))).toEqual({ kind: "seekBy", seconds: -5 });
    // Arrows on a plain button still step the lap.
    expect(playbackKeyAction(key("ArrowRight"), el("<button>x</button>"))).toEqual({ kind: "seekBy", seconds: 0.5 });
  });
});

describe("stepTime", () => {
  const times = [30, 5, 12, 20];
  it("finds the next and previous target regardless of order", () => {
    expect(stepTime(times, 5, 1)).toBe(12);
    expect(stepTime(times, 13, 1)).toBe(20);
    expect(stepTime(times, 13, -1)).toBe(12);
    expect(stepTime(times, 0, 1)).toBe(5);
  });
  it("returns null at the ends, and ignores a target you are already on", () => {
    expect(stepTime(times, 30, 1)).toBeNull();
    expect(stepTime(times, 5, -1)).toBeNull();
    expect(stepTime(times, 12.02, -1)).toBe(5);
    expect(stepTime([], 1, 1)).toBeNull();
  });
});

describe("SHORTCUT_GROUPS", () => {
  it("lists the playback and lap keys", () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => g.rows.flatMap((r) => r.keys));
    expect(all).toEqual(expect.arrayContaining(["Space", "J", "K", "L", "↑", "?"]));
  });
});

import { describe, expect, it } from "vitest";
import { deltaLabel, paneReadout, paneRects, paneTitle } from "./split";

describe("paneRects", () => {
  it("is one full pane without the split view", () => {
    expect(paneRects({ w: 1920, h: 1080 }, false)).toEqual([{ x: 0, y: 0, w: 1920, h: 1080 }]);
  });

  it("is two halves that cover the width exactly, lap on the left", () => {
    const [a, b] = paneRects({ w: 1001, h: 500 }, true);
    expect(a).toEqual({ x: 0, y: 0, w: 500, h: 500 });
    expect(b).toEqual({ x: 500, y: 0, w: 501, h: 500 });
    expect(a.w + b.w).toBe(1001);
  });
});

describe("pane labels", () => {
  it("shows the lap time and the live speed and gear", () => {
    expect(paneTitle("Lap", 143.751)).toBe("Lap 2:23.751");
    expect(paneTitle("Reference", null)).toBe("Reference –:––.–––");
    expect(paneReadout(213.6, 5)).toBe("214 km/h · 5");
    expect(paneReadout(0, 0)).toBe("0 km/h · N");
  });

  it("signs the delta, + meaning the lap is behind, and never shows a negative zero", () => {
    expect(deltaLabel(0.841)).toBe("+0.841 s");
    expect(deltaLabel(-0.12)).toBe("−0.120 s");
    expect(deltaLabel(-0.0002)).toBe("+0.000 s");
  });
});

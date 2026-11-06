import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE, deltaKey, deltaLabel, dashKey, gearLabel, ledStates, mixHex, paintDash, paintDashTop, paintDelta, paintMirrorFallback, paintMirrorHousing,
  paintWeaveTile, paintWheel, rgba, type Ctx2D,
} from "./cockpitPaint";
import { DASH_PX, DISPLAY_PX, MIRROR_HOUSING_PX, MIRROR_PX, SECOND_PX, WHEEL_PX } from "./cockpitLayout";
import type { DashValues } from "./dashValues";

const v = (o: Partial<DashValues> = {}): DashValues => ({ steering: 0, steeringRangeDeg: 524, gear: 3, rpm: 6000, speedKmh: 150, throttle: 0.5, brake: 0, deltaS: 0.2, clockS: 0, ...o });
const limits = { limit: 7600, start: 6080 };
const pal = DEFAULT_PALETTE;

/** A canvas context that records its calls: every method returns a gradient-like stub and notes its name; texts are collected. */
function recorder() {
  const calls: Record<string, number> = {}, texts: string[] = [], stops: string[] = [];
  const gradient = { addColorStop: (_: number, c: string) => stops.push(c) };
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "" };
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        calls[k] = (calls[k] ?? 0) + 1;
        if (k === "fillText") texts.push(String(a[0]));
        return k.startsWith("create") ? gradient : undefined;
      };
    },
    set(t, k: string, val) { t[k] = val; return true; },
  }) as unknown as Ctx2D;
  return { ctx, calls, texts, stops };
}

describe("colour helpers", () => {
  it("mixes hex colours and makes rgba", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#102030", "#102030", 0.7)).toBe("#102030");
    expect(mixHex("#fff", "#000", 1)).toBe("#000000");
    expect(rgba("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)");
  });
});

describe("static parts paint without error and draw something", () => {
  it("weave tile: four tows", () => {
    const r = recorder();
    paintWeaveTile(r.ctx);
    expect(r.calls.fillRect).toBe(4);
    expect(r.calls.createLinearGradient).toBe(4);
  });
  it("dash top, wheel, mirror housing and the still mirror", () => {
    for (const [paint, calls] of [
      [(c: Ctx2D) => paintDashTop(c, DASH_PX[0], DASH_PX[1], pal, null), "roundRect"],
      [(c: Ctx2D) => paintWheel(c, WHEEL_PX[0], WHEEL_PX[1], pal), "fillRect"],
      [(c: Ctx2D) => paintMirrorHousing(c, MIRROR_HOUSING_PX[0], MIRROR_HOUSING_PX[1], { x: 0.03, y: 0.1, w: 0.94, h: 0.8 }, pal, null), "roundRect"],
      [(c: Ctx2D) => paintMirrorFallback(c, MIRROR_PX[0], MIRROR_PX[1], pal), "fillRect"],
    ] as const) {
      const r = recorder();
      paint(r.ctx);
      expect(r.calls[calls]).toBeGreaterThan(0);
    }
  });
  it("wheel: draws the rim ring (outer and inner outline), two spokes, the hub and the marker in the accent colour", () => {
    const r = recorder();
    const fills: unknown[] = [];
    const ctx = r.ctx as unknown as { fillStyle: unknown; fillRect(...a: number[]): void };
    const orig = ctx.fillRect.bind(ctx);
    ctx.fillRect = (...a: number[]) => { fills.push(ctx.fillStyle); orig(...a); };
    paintWheel(r.ctx, WHEEL_PX[0], WHEEL_PX[1], pal);
    expect(r.calls.fillRect).toBe(4); // cross spoke, lower spoke, hub, marker
    expect(r.calls.lineTo).toBeGreaterThan(3 * 70); // outer, inner and stroke outlines of 72 points
    expect(fills[3]).toBe(pal.orange);
  });
});

describe("central display", () => {
  it("labels reverse, neutral and gears", () => {
    expect([-1, 0, 4].map(gearLabel)).toEqual(["R", "N", "4"]);
  });
  it("changes its key only when something that shows changes", () => {
    const k = dashKey(v(), limits);
    expect(dashKey(v({ steering: 0.3, rpm: 6020, speedKmh: 150.2, deltaS: 1 }), limits)).toBe(k); // the wheel turning or the delta does not redraw it
    expect(dashKey(v({ gear: 4 }), limits)).not.toBe(k);
    expect(dashKey(v({ speedKmh: 152 }), limits)).not.toBe(k);
    expect(dashKey(v({ rpm: 7000 }), limits)).not.toBe(k);
    expect(dashKey(v({ brake: 0.8 }), limits)).not.toBe(k);
    expect(dashKey(v({ rpm: 7590, clockS: 0 }), limits)).not.toBe(dashKey(v({ rpm: 7590, clockS: 1 / 12 }), limits)); // blink phase at the limit
  });
  it("lights the first lights of the row in their colours, the rest off", () => {
    const s = ledStates(v({ rpm: 7000 }), limits, pal);
    expect(s).toHaveLength(10);
    const lit = Math.ceil(((7000 - 6080) / (7600 - 6080)) * 10);
    expect(s.filter((c) => c !== pal.off)).toHaveLength(lit);
    expect(s[0]).toBe(pal.green);
    expect(s[lit - 1]).toBe(pal.yellow); // 7th of 10 is in the yellow part
    expect(ledStates(v({ rpm: 1000 }), limits, pal).every((c) => c === pal.off)).toBe(true);
    expect(ledStates(v({ rpm: 7590, clockS: 1 / 12 }), limits, pal).every((c) => c === pal.off)).toBe(true); // blinked off
  });
  it("paints the gear, speed and rpm", () => {
    const r = recorder();
    paintDash(r.ctx, DISPLAY_PX[0], DISPLAY_PX[1], v({ gear: 5, speedKmh: 211.4, rpm: 7004 }), limits, pal);
    expect(r.texts).toEqual(expect.arrayContaining(["5", "211", "7000", "RPM", "KPH"]));
  });
});

describe("second display (delta to the reference)", () => {
  it("formats the delta with a sign, two decimals, or -- when unknown", () => {
    expect(deltaLabel(0.1423)).toBe("+0.14");
    expect(deltaLabel(-0.031)).toBe("-0.03");
    expect(deltaLabel(0)).toBe("0.00");
    expect(deltaLabel(0.001)).toBe("0.00");
    expect(deltaLabel(null)).toBe("--");
    expect(deltaLabel(NaN)).toBe("--");
  });
  it("redraws only when the delta changes at two decimals", () => {
    expect(deltaKey(v({ deltaS: 0.2 }))).toBe(deltaKey(v({ deltaS: 0.2004, gear: 6, rpm: 1 })));
    expect(deltaKey(v({ deltaS: 0.21 }))).not.toBe(deltaKey(v({ deltaS: 0.2 })));
    expect(deltaKey(v({ deltaS: null }))).toBe("-");
  });
  it("paints the value and says behind, ahead or level", () => {
    const say = (d: number | null) => { const r = recorder(); paintDelta(r.ctx, SECOND_PX[0], SECOND_PX[1], v({ deltaS: d }), pal); return r.texts; };
    expect(say(0.5)).toEqual(expect.arrayContaining(["+0.50", "BEHIND"]));
    expect(say(-0.5)).toEqual(expect.arrayContaining(["-0.50", "AHEAD"]));
    expect(say(0)).toContain("LEVEL");
    expect(say(null)).toEqual(expect.arrayContaining(["--", "NO REFERENCE"]));
  });
});

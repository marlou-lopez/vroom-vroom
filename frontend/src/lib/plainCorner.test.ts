import { describe, expect, it } from "vitest";
import type { CompareCandidate, CornerMetrics, CornerSideMetrics, LapWithRef } from "../api/types";
import { biggestGains, biggestLosses, fastestValidLap, plainCorner, plainGap, plainRefName } from "./plainCorner";

const side = (o: Partial<CornerSideMetrics> = {}): CornerSideMetrics => ({
  brake_onset_m: 100, peak_brake: 0.8, min_speed_kmh: 120, min_speed_m: 150, throttle_pickup_m: 180, exit_speed_kmh: 170,
  coast_s: 0, overlap_s: 0, steer_corrections: 1, understeer_peak_deg_s: null, ...o,
} as CornerSideMetrics);
const corner = (id: string, delta: number, lap: Partial<CornerSideMetrics> = {}, ref: Partial<CornerSideMetrics> = {}): CornerMetrics =>
  ({ corner_id: id, delta_s: delta, lap: side(lap), ref: side(ref) }) as CornerMetrics;

describe("plainCorner", () => {
  it("says a speed loss in km/h with both numbers, and a tip without metres", () => {
    const p = plainCorner(corner("c", 0.2, { min_speed_kmh: 118.4 }, { min_speed_kmh: 124.2 }), "your best lap");
    expect(p.what).toBe("You were 6 km/h slower at the slowest point (118 against 124 km/h).");
    expect(p.tip).toBeTruthy();
    expect(p.tip).not.toMatch(/\d+ ?m\b/);
  });

  it("names early braking, late throttle and extra steering corrections", () => {
    expect(plainCorner(corner("c", 0.1, { brake_onset_m: 50 }, { brake_onset_m: 90 }), "lap 2").what).toBe("You started braking earlier than on lap 2.");
    expect(plainCorner(corner("c", 0.1, { throttle_pickup_m: 230 }, { throttle_pickup_m: 180 }), "lap 2").what).toBe("You got back on the throttle later than on lap 2.");
    expect(plainCorner(corner("c", 0.1, { steer_corrections: 5 }, { steer_corrections: 1 }), "lap 2").what).toBe("You corrected the steering 4 more times than on lap 2.");
  });

  it("gives no tip for a gain or an even corner", () => {
    const g = plainCorner(corner("c", -0.1, { min_speed_kmh: 130 }, { min_speed_kmh: 120 }), "lap 2");
    expect(g.what).toBe("You carried 10 km/h more through the slowest point.");
    expect(g.tip).toBeNull();
    expect(plainCorner(corner("c", 0.0004), "lap 2")).toMatchObject({ what: "Same time as lap 2.", tip: null });
  });
});

describe("ranking and wording", () => {
  const cs = [corner("a", 0.05), corner("b", 0.2), corner("c", -0.1), corner("d", 0.0001), corner("e", 0.1), corner("f", -0.02)];
  it("ranks losses worst first and gains best first", () => {
    expect(biggestLosses(cs).map((c) => c.corner_id)).toEqual(["b", "e", "a"]);
    expect(biggestGains(cs).map((c) => c.corner_id)).toEqual(["c", "f"]);
  });
  it("leaves out corners that would read 0.00 s", () => {
    expect(biggestLosses([corner("a", 0.004), corner("b", 0.006)]).map((c) => c.corner_id)).toEqual(["b"]);
    expect(biggestGains([corner("a", -0.004)])).toEqual([]);
  });
  it("words the lap gap in hundredths", () => {
    expect(plainGap(0.0404, "your best lap")).toBe("0.04 s slower than your best lap");
    expect(plainGap(-0.12, "the ideal lap")).toBe("0.12 s faster than the ideal lap");
    expect(plainGap(0.001, "lap 2")).toBe("the same time as lap 2");
    expect(plainGap(null, "lap 2")).toBeNull();
  });
  it("names the comparison for a sentence", () => {
    const laps = [
      { lap_id: "x1", lap_no: 1, lap_time_s: 100, valid: true, valid_override: null },
      { lap_id: "x2", lap_no: 2, lap_time_s: 99, valid: true, valid_override: null },
    ] as LapWithRef[];
    const cand = (o: Partial<CompareCandidate>) => ({ lap_id: "x2", label: "L2", lap_time_s: 99, car_name: "", is_reference: true, is_previous: false, other_car: false, is_ideal: false, ...o }) as CompareCandidate;
    expect(plainRefName(cand({}), laps)).toBe("your best lap (lap 2)");
    expect(plainRefName(cand({ lap_id: "x1" }), laps)).toBe("lap 1");
    expect(plainRefName(cand({ lap_id: "ideal:s", is_ideal: true }), laps)).toBe("your ideal lap");
    expect(plainRefName(cand({ lap_id: "other", label: "26 Oct · L4" }), laps)).toBe("26 Oct · L4");
    expect(plainRefName(null, laps)).toBe("the comparison lap");
    expect(fastestValidLap(laps)?.lap_id).toBe("x2");
    expect(fastestValidLap([{ ...laps[1], valid: false }, laps[0]] as LapWithRef[])?.lap_id).toBe("x1");
  });
});

import { describe, expect, it } from "vitest";
import { formatClock, formatDelta, formatLapTime, formatShortDate, gearLabel } from "./format";

describe("formatLapTime", () => {
  it("formats minutes, zero-padded seconds and milliseconds", () => {
    expect(formatLapTime(143.751)).toBe("2:23.751");
    expect(formatLapTime(65.5)).toBe("1:05.500");
    expect(formatLapTime(60)).toBe("1:00.000");
    expect(formatLapTime(0)).toBe("0:00.000");
    expect(formatLapTime(9.5)).toBe("0:09.500");
  });

  it("shows a placeholder for null and non-finite times", () => {
    for (const v of [null, NaN, Infinity, -Infinity]) expect(formatLapTime(v)).toBe("–:––.–––");
  });

  it("carries into the minute when seconds round up to 60 (#1)", () => {
    expect(formatLapTime(59.9996)).toBe("1:00.000");
    expect(formatLapTime(119.9996)).toBe("2:00.000");
    expect(formatLapTime(9.9996)).toBe("0:10.000");
  });
});

describe("formatClock", () => {
  it("formats the playback clock with one decimal", () => {
    expect(formatClock(92.4)).toBe("1:32.4");
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(5.04)).toBe("0:05.0");
    expect(formatClock(600)).toBe("10:00.0");
  });

  it("carries into the minute when seconds round up to 60 (#1)", () => {
    expect(formatClock(59.96)).toBe("1:00.0");
    expect(formatClock(59.97)).toBe("1:00.0");
    expect(formatClock(3599.96)).toBe("60:00.0");
  });

  it("keeps values that round down under the minute and carries past 10 s", () => {
    expect(formatClock(59.94)).toBe("0:59.9");
    expect(formatClock(9.96)).toBe("0:10.0");
  });
});

describe("formatDelta", () => {
  it("signs with + and a true minus sign", () => {
    expect(formatDelta(0.841)).toBe("+0.841");
    expect(formatDelta(-0.12)).toBe("−0.120");
    expect(formatDelta(-0.12).startsWith("−")).toBe(true);
  });

  it("treats zero as positive and rounds to three decimals", () => {
    expect(formatDelta(0)).toBe("+0.000");
    expect(formatDelta(1.23456)).toBe("+1.235");
  });

  it("keeps a minus sign for a negative value that rounds to zero", () => {
    expect(formatDelta(-0.0001)).toBe("−0.000");
  });
});

describe("formatShortDate", () => {
  it("formats an ISO local datetime as day and short month", () => {
    expect(formatShortDate("2026-11-03T14:05:00")).toBe("3 Nov");
    expect(formatShortDate("2026-01-15T00:00:00")).toBe("15 Jan");
  });
});

describe("gearLabel", () => {
  it("labels neutral, reverse and forward gears", () => {
    expect(gearLabel(0)).toBe("N");
    expect(gearLabel(-1)).toBe("R");
    expect(gearLabel(1)).toBe("1");
    expect(gearLabel(7)).toBe("7");
  });

  it("shows a dash when the gear is unknown", () => {
    expect(gearLabel(undefined)).toBe("–");
  });
});

import { describe, expect, it } from "vitest";
import { withParams } from "./urlParams";

describe("withParams", () => {
  it("changes lap and ref and keeps every other param", () => {
    const prev = new URLSearchParams("lap=a&ref=b&debug&balance=1&mirror=0");
    expect(withParams(prev, { lap: "c" }).toString()).toBe("lap=c&ref=b&debug=&balance=1&mirror=0");
  });
  it("removes a param set to null and leaves the rest", () => {
    const prev = new URLSearchParams("lap=a&ref=b&debug=1");
    const next = withParams(prev, { lap: "a", ref: null });
    expect(next.has("ref")).toBe(false);
    expect(next.get("debug")).toBe("1");
  });
  it("does not mutate its input", () => {
    const prev = new URLSearchParams("lap=a");
    withParams(prev, { lap: "b" });
    expect(prev.get("lap")).toBe("a");
  });
});

import { lapLink } from "./urlParams";

describe("lapLink", () => {
  it("sets the lap, drops ref and at, keeps flags", () => {
    expect(lapLink("?lap=a&ref=b&at=100&debug=1", "l 1")).toEqual({ pathname: "/", search: "?lap=l+1&debug=1" });
  });
  it("sets at when given", () => {
    expect(lapLink("?balance=1", "x", 412.6).search).toBe("?balance=1&lap=x&at=413");
  });
});

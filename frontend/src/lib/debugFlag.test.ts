import { describe, expect, it } from "vitest";
import { debugEnabled } from "./debugFlag";

describe("debugEnabled", () => {
  it("is on in dev", () => {
    expect(debugEnabled(true, "")).toBe(true);
    expect(debugEnabled(true, "?debug=0")).toBe(false); // preview the production view in dev
  });
  it("is off in production without the param", () => {
    expect(debugEnabled(false, "")).toBe(false);
    expect(debugEnabled(false, "?other=1")).toBe(false);
  });
  it("turns on with ?debug or ?debug=1", () => {
    expect(debugEnabled(false, "?debug")).toBe(true);
    expect(debugEnabled(false, "?debug=1")).toBe(true);
    expect(debugEnabled(false, "?a=b&debug")).toBe(true);
  });
  it("?debug=0 is off", () => {
    expect(debugEnabled(false, "?debug=0")).toBe(false);
  });
});

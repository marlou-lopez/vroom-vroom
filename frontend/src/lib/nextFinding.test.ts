import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations";
import { nextFinding } from "./nextFinding";

const ann = (id: string, startM: number, kind: Annotation["kind"] = "issue") => ({ findingId: id, kind, startM }) as Annotation;

describe("nextFinding", () => {
  const list = [ann("c", 900), ann("a", 200), ann("s", 500, "strength"), ann("b", 400, "minor")];
  it("is the nearest issue or minor finding that starts ahead", () => {
    expect(nextFinding(list, 100)?.findingId).toBe("a");
    expect(nextFinding(list, 250)?.findingId).toBe("b");
  });
  it("skips strengths and does not wrap around", () => {
    expect(nextFinding(list, 450)?.findingId).toBe("c");
    expect(nextFinding(list, 950)).toBeNull();
  });
});

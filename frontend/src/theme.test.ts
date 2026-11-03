import { describe, expect, it } from "vitest";
import { annotationColors, applyThemeVariables, colors, fonts, sizes, themeVariables } from "./theme";

function fakeRoot() {
  const set = new Map<string, string>();
  return { set, root: { style: { setProperty: (k: string, v: string) => void set.set(k, v) } } as unknown as HTMLElement };
}

describe("applyThemeVariables", () => {
  it("writes colours, fonts and sizes to the root", () => {
    const { set, root } = fakeRoot();
    applyThemeVariables(root);
    expect(set.get("--color-bg")).toBe(colors.bg);
    expect(set.get("--color-border-strong")).toBe(colors.borderStrong);
    expect(set.get("--color-on-accent")).toBe(colors.onAccent);
    expect(set.get("--color-annotation-issue")).toBe(annotationColors.issue);
    expect(set.get("--font-sans")).toBe(fonts.sans);
    expect(set.get("--font-mono")).toBe(fonts.mono);
    expect(set.get("--radius")).toBe(`${sizes.radius}px`);
    expect(set.get("--header-height")).toBe("36px");
    expect(set.get("--font-size-base")).toBe("12px");
  });
  it("covers every colour token", () => {
    const vars = themeVariables();
    expect(Object.keys(colors).length).toBeGreaterThan(0);
    for (const k of Object.keys(colors)) expect(Object.values(vars)).toContain(colors[k as keyof typeof colors]);
    expect(Object.keys(vars).filter((k) => k.startsWith("--color-")).length).toBe(Object.keys(colors).length + Object.keys(annotationColors).length);
  });
});

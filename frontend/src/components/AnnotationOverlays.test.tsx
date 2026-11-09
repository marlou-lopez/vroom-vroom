import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Annotation } from "../lib/annotations";
import { ScrubberSections } from "./AnnotationOverlays";

const ann = (tStart: number, tEnd: number): Annotation =>
  ({ findingId: "f1", cornerId: "c1", color: "#ff0000", tStart, tEnd, startM: 0, endM: 0 }) as unknown as Annotation;

const sections = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("div")).map((d) => [d.style.left, d.style.width]);

describe("ScrubberSections", () => {
  it("draws one section for a normal corner", () => {
    const { container } = render(<ScrubberSections annotations={[ann(10, 20)]} duration={100} />);
    expect(sections(container)).toEqual([["10%", "10%"]]);
  });

  it("splits a corner over the start line into the lap end and the lap start", () => {
    const { container } = render(<ScrubberSections annotations={[ann(95, 4)]} duration={100} />);
    expect(sections(container)).toEqual([["95%", "5%"], ["0%", "4%"]]);
  });
});

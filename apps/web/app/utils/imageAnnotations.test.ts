import { describe, expect, test } from "bun:test";
import { annotationPath, imagePoint, type ImageAnnotation } from "./imageAnnotations";

describe("image annotation coordinates", () => {
  test("maps a scaled preview back to the original pixels", () => {
    expect(imagePoint(160, 95, { left: 10, top: 20, width: 300, height: 150 }, { width: 2400, height: 1200 }))
      .toEqual({ x: 1200, y: 600 });
  });
  test("clamps a captured pointer that leaves the image", () => {
    expect(imagePoint(-30, 800, { left: 10, top: 20, width: 300, height: 150 }, { width: 2400, height: 1200 }))
      .toEqual({ x: 0, y: 1200 });
  });
});

describe("annotation paths shared by preview and PNG export", () => {
  const mark: ImageAnnotation = { tool: "pen", color: "#ef4444", width: 4, points: [{ x: 100, y: 100 }] };
  test("a click produces a visible dot", () => {
    expect(annotationPath(mark)).toBe("M100,100 l0.01,0");
  });
  test("rectangles can be drawn backwards", () => {
    expect(annotationPath({ ...mark, tool: "rectangle", points: [{ x: 100, y: 100 }, { x: 20, y: 30 }] }))
      .toBe("M100,100 H20 V30 H100 Z");
  });
  test("a zero-length arrow has finite coordinates", () => {
    expect(annotationPath({ ...mark, tool: "arrow" })).not.toMatch(/NaN|Infinity/);
  });
  test("an empty stroke has no path", () => {
    expect(annotationPath({ ...mark, points: [] })).toBe("");
  });
});

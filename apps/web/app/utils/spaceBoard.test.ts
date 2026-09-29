import { describe, expect, test } from "bun:test";
import { COLUMNS, INSTRUCTION_KINDS, SECTIONS } from "./spaceBoard";

describe("the board's layout", () => {
  test("every column sits in exactly one section", () => {
    const ids = COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(SECTIONS.reduce((n, s) => n + s.columns.length, 0));
  });

  test("columns run in the sections' order, a section's columns together", () => {
    expect(COLUMNS.map((c) => c.section)).toEqual(SECTIONS.flatMap((s) => s.columns.map(() => s.id)));
  });

  test("every section has a column to land on", () => {
    for (const s of SECTIONS) expect(s.columns.length).toBeGreaterThan(0);
  });

  test("Instructions is AGENTS.md beside CLAUDE.md", () => {
    const section = SECTIONS.find((s) => s.id === "instructions");
    expect(section?.columns).toEqual(["agents", "claude"]);
    expect(INSTRUCTION_KINDS).toEqual(["agents", "claude"]);
  });
});

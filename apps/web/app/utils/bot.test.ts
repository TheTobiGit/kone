import { describe, expect, test } from "bun:test";
import {
  BOT_COLORS,
  BOT_EXPRESSIONS,
  BOT_FORMS,
  botGround,
  botMark,
  botSummary,
  DEFAULT_BOT,
  readBot,
  type AgentBot,
} from "./bot";

describe("bot marks", () => {
  test("a mark carries no document references", () => {
    // The reason the eyes are painted rather than masked: a reference resolves
    // against the first copy in the document, which may sit in a subtree that
    // never paints — and then every bot on screen goes blank.
    for (const form of BOT_FORMS) {
      for (const expression of BOT_EXPRESSIONS) {
        const svg = botMark({ ...DEFAULT_BOT, form: form.id, expression: expression.id });
        expect(svg).not.toContain("url(#");
        expect(svg).not.toContain("<mask");
        expect(svg).not.toContain(" id=");
      }
    }
  });

  test("every combination draws a body", () => {
    for (const color of BOT_COLORS) {
      const svg = botMark({ ...DEFAULT_BOT, color: color.id });
      expect(svg).toContain(`fill="${color.hex}"`);
      expect(svg.startsWith("<svg")).toBe(true);
    }
  });

  test("a shape's mark differs from the one beside it", () => {
    const marks = new Set(BOT_FORMS.map((s) => botMark({ ...DEFAULT_BOT, form: s.id })));
    expect(marks.size).toBe(BOT_FORMS.length);
  });

  test("an expression's mark differs from the one beside it", () => {
    const marks = new Set(
      BOT_EXPRESSIONS.map((e) => botMark({ ...DEFAULT_BOT, expression: e.id })),
    );
    expect(marks.size).toBe(BOT_EXPRESSIONS.length);
  });
});

describe("a ground to read against", () => {
  test("the two neutral bodies get opposite grounds", () => {
    const ink = botGround({ ...DEFAULT_BOT, color: "ink" });
    const cream = botGround({ ...DEFAULT_BOT, color: "cream" });
    expect(ink).not.toBe(cream);
  });

  test("a ground never matches the body standing on it", () => {
    for (const color of BOT_COLORS) {
      expect(botGround({ ...DEFAULT_BOT, color: color.id })).not.toBe(color.hex);
    }
  });

  test("the ground follows the colour, not the shape or the mood", () => {
    const a: AgentBot = { form: "circle", color: "teal", expression: "neutral" };
    const b: AgentBot = { form: "droplet", color: "teal", expression: "sleepy" };
    expect(botGround(a)).toBe(botGround(b));
  });
});

describe("reading one back", () => {
  test("nothing at all is no bot, not the default one", () => {
    expect(readBot(null)).toBeNull();
    expect(readBot(undefined)).toBeNull();
    expect(readBot("pebble")).toBeNull();
  });

  test("a bot naming what this build no longer ships falls back per field", () => {
    expect(readBot({ form: "sprocket", color: "teal", expression: "wary" })).toEqual({
      form: DEFAULT_BOT.form,
      color: "teal",
      expression: "wary",
    });
  });

  // Bots saved before the form rename key their first field `shape`; reading
  // one maps it instead of answering with the default.
  test("a bot stored under the legacy `shape` key still reads back", () => {
    const legacy: Record<string, unknown> = { color: "teal", expression: "curious" };
    legacy["shape"] = "pebble";
    expect(readBot(legacy)).toEqual({
      form: "pebble",
      color: "teal",
      expression: "curious",
    });
  });

  test("a summary names all three choices", () => {
    const line = botSummary({ form: "pebble", color: "teal", expression: "curious" });
    expect(line).toContain("Teal");
    expect(line).toContain("pebble");
    expect(line).toContain("curious");
  });
});

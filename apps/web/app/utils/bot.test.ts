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
  sampleBot,
  type AgentBot,
  type StoredBot,
} from "./bot";
import { liveliness } from "./idleLife";

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
    const legacy: StoredBot = { color: "teal", expression: "curious", "shape": "pebble" };
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

describe("a live bot", () => {
  test("the same clock always draws the same frame", () => {
    const a = sampleBot(2.4, DEFAULT_BOT);
    const b = sampleBot(2.4, DEFAULT_BOT);
    expect(a).toEqual(b);
    expect(liveliness(2.4)).toEqual(liveliness(2.4));
  });

  test("a later clock turns the head", () => {
    const a = sampleBot(0.9, DEFAULT_BOT);
    const b = sampleBot(3.1, DEFAULT_BOT);
    expect(a.eyes[0]?.matrix).not.toBe(b.eyes[0]?.matrix);
  });

  test("a blink shuts the lids", () => {
    // First blink in the calendar starts at 1.4s and lasts 0.18s; 45% of the
    // way through it the eye is fully shut.
    const open = liveliness(0.9).lid;
    const shut = liveliness(1.4 + 0.45 * 0.18).lid;
    expect(open).toBe(1);
    expect(shut).toBeLessThan(1e-10);
    const awake = sampleBot(0.9, DEFAULT_BOT);
    const blinked = sampleBot(1.4 + 0.45 * 0.18, DEFAULT_BOT);
    expect(blinked.eyes[0]?.matrix).not.toBe(awake.eyes[0]?.matrix);
  });

  test("a look replaces where the head points, not the eyes it is wearing", () => {
    const rest = sampleBot(0.9, { ...DEFAULT_BOT, expression: "angry" });
    const looking = sampleBot(0.9, { ...DEFAULT_BOT, expression: "angry" }, {
      nx: 1,
      ny: 0,
      mix: 1,
    });
    expect(looking.eyes[0]?.d).toBe(rest.eyes[0]?.d);
    expect(looking.eyes[0]?.matrix).not.toBe(rest.eyes[0]?.matrix);
  });
});

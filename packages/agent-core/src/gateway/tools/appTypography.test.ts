import { describe, expect, it } from "bun:test";
import type { RuntimeEvent } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayToolContext } from "../registry.js";
import {
  createAppTypographyTools,
  type AppTypographyToolOptions,
  type TypographyReading,
} from "./appTypography.js";
import { DEFAULT_TYPOGRAPHY_PREFS } from "@kone/protocol/typography";

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-test-1",
    turnId: "turn-test-1",
    provider: "claudeAgent",
    model: "claude-3-7-sonnet",
    cwd: process.cwd(),
    requestId: "req-1",
    ...overrides,
  };
}

const SAMPLE_TYPOGRAPHY: TypographyReading = {
  sans: "Inter",
  serif: "",
  mono: "JetBrains Mono",
  composer: "",
  sizeInterface: 16,
  sizeComposer: 14,
  sizeCode: 13,
  lineHeightBody: 1.6,
  measure: 70,
  smoothing: true,
};

function typographyTools(options: Partial<AppTypographyToolOptions> = {}) {
  return createAppTypographyTools({
    readTypography: () => SAMPLE_TYPOGRAPHY,
    ...options,
  });
}

describe("appTypography tools", () => {
  describe("app_get_typography", () => {
    it("reports unknown when typography settings have not been reported yet", async () => {
      const registry = createRegistry(createAppTypographyTools({}));

      const res = await registry.call(makeCtx(), "app_get_typography", {});
      expect(res.isError).toBeUndefined();
      // SAFETY: shape asserted by app_get_typography's own return statement.
      const structured = res.structuredContent as { known: boolean };
      expect(structured.known).toBe(false);
      expect(res.content[0]?.text).toContain("has not reported its typography settings yet");
    });

    it("reports current font families, sizes, reading metrics, and ranges", async () => {
      const registry = createRegistry(typographyTools());

      const res = await registry.call(makeCtx(), "app_get_typography", {});
      expect(res.isError).toBeUndefined();
      // SAFETY: shape asserted by app_get_typography's own return statement.
      const structured = res.structuredContent as {
        known: boolean;
        sans: string;
        mono: string;
        sizeInterface: number;
        sizeComposer: number;
        sizeCode: number;
        lineHeightBody: number;
        measure: number;
        smoothing: boolean;
        ranges: {
          sizeInterface: { min: number; max: number };
          sizeComposer: { min: number; max: number };
          sizeCode: { min: number; max: number };
        };
      };

      expect(structured.known).toBe(true);
      expect(structured.sans).toBe("Inter");
      expect(structured.mono).toBe("JetBrains Mono");
      expect(structured.sizeInterface).toBe(16);
      expect(structured.sizeComposer).toBe(14);
      expect(structured.sizeCode).toBe(13);
      expect(structured.lineHeightBody).toBe(1.6);
      expect(structured.measure).toBe(70);
      expect(structured.smoothing).toBe(true);
      expect(structured.ranges.sizeInterface.min).toBe(12);
      expect(structured.ranges.sizeInterface.max).toBe(20);

      const text = res.content[0]?.text ?? "";
      expect(text).toContain('"Inter"');
      expect(text).toContain('"JetBrains Mono"');
      expect(text).toContain("16px");
      expect(text).toContain("70ch");
      expect(text).toContain("enabled");
    });
  });

  describe("app_set_typography", () => {
    it("throws provider_unavailable when typography settings have not been reported yet", async () => {
      const registry = createRegistry(createAppTypographyTools({ emit: () => {} }));

      const res = await registry.call(makeCtx(), "app_set_typography", { mono: "Fira Code" });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("has not reported its typography settings yet");
    });

    it("throws provider_unavailable when no emit listener is wired", async () => {
      const registry = createRegistry(createAppTypographyTools({ readTypography: () => SAMPLE_TYPOGRAPHY }));

      const res = await registry.call(makeCtx(), "app_set_typography", { mono: "Fira Code" });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("no window is listening for them");
    });

    it("rejects when no setting is named and reset is not true", async () => {
      const registry = createRegistry(typographyTools({ emit: () => {} }));

      const res = await registry.call(makeCtx(), "app_set_typography", {});
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("Name at least one typography setting to change or pass reset: true.");
    });

    it("rejects out of bounds sizes", async () => {
      const registry = createRegistry(typographyTools({ emit: () => {} }));

      const resTooSmall = await registry.call(makeCtx(), "app_set_typography", { sizeInterface: 10 });
      expect(resTooSmall.isError).toBe(true);

      const resTooLarge = await registry.call(makeCtx(), "app_set_typography", { sizeCode: 22 });
      expect(resTooLarge.isError).toBe(true);
    });

    it("applies font family changes and emits app.typography_mutation", async () => {
      const emitted: RuntimeEvent[] = [];
      const registry = createRegistry(typographyTools({ emit: (e) => emitted.push(e) }));

      const res = await registry.call(
        makeCtx({ threadId: "thread-typo-1" }),
        "app_set_typography",
        { sans: "Geist", mono: "Fira Code" },
      );

      expect(res.isError).toBeUndefined();
      // SAFETY: shape asserted by app_set_typography's own return statement.
      const structured = res.structuredContent as {
        ok: boolean;
        summary: string;
        applied: { sans?: string; mono?: string };
      };
      expect(structured.ok).toBe(true);
      expect(structured.applied.sans).toBe("Geist");
      expect(structured.applied.mono).toBe("Fira Code");

      expect(emitted.length).toBe(1);
      expect(emitted[0]?.type).toBe("app.typography_mutation");
      if (emitted[0]?.type === "app.typography_mutation") {
        expect(emitted[0].threadId).toBe("thread-typo-1");
        expect(emitted[0].sans).toBe("Geist");
        expect(emitted[0].mono).toBe("Fira Code");
        expect(emitted[0].serif).toBeUndefined();
      }
    });

    it("normalizes 'default' or empty string to the shipped default font stack", async () => {
      const emitted: RuntimeEvent[] = [];
      const registry = createRegistry(typographyTools({ emit: (e) => emitted.push(e) }));

      const res = await registry.call(makeCtx(), "app_set_typography", { sans: "default", mono: "" });
      expect(res.isError).toBeUndefined();

      expect(emitted.length).toBe(1);
      if (emitted[0]?.type === "app.typography_mutation") {
        expect(emitted[0].sans).toBe("");
        expect(emitted[0].mono).toBe("");
      }
    });

    it("applies sizes, line height, measure, and smoothing", async () => {
      const emitted: RuntimeEvent[] = [];
      const registry = createRegistry(typographyTools({ emit: (e) => emitted.push(e) }));

      const res = await registry.call(makeCtx(), "app_set_typography", {
        sizeInterface: 18,
        sizeComposer: 15,
        sizeCode: 14,
        lineHeightBody: 1.7,
        measure: 75,
        smoothing: false,
      });

      expect(res.isError).toBeUndefined();
      expect(emitted.length).toBe(1);
      if (emitted[0]?.type === "app.typography_mutation") {
        expect(emitted[0].sizeInterface).toBe(18);
        expect(emitted[0].sizeComposer).toBe(15);
        expect(emitted[0].sizeCode).toBe(14);
        expect(emitted[0].lineHeightBody).toBe(1.7);
        expect(emitted[0].measure).toBe(75);
        expect(emitted[0].smoothing).toBe(false);
      }
    });

    it("resets all preferences to defaults when reset is true", async () => {
      const emitted: RuntimeEvent[] = [];
      const registry = createRegistry(typographyTools({ emit: (e) => emitted.push(e) }));

      const res = await registry.call(makeCtx(), "app_set_typography", { reset: true });
      expect(res.isError).toBeUndefined();

      expect(emitted.length).toBe(1);
      if (emitted[0]?.type === "app.typography_mutation") {
        expect(emitted[0].sans).toBe(DEFAULT_TYPOGRAPHY_PREFS.sans);
        expect(emitted[0].serif).toBe(DEFAULT_TYPOGRAPHY_PREFS.serif);
        expect(emitted[0].mono).toBe(DEFAULT_TYPOGRAPHY_PREFS.mono);
        expect(emitted[0].composer).toBe(DEFAULT_TYPOGRAPHY_PREFS.composer);
        expect(emitted[0].sizeInterface).toBe(DEFAULT_TYPOGRAPHY_PREFS.sizeInterface);
        expect(emitted[0].sizeComposer).toBe(DEFAULT_TYPOGRAPHY_PREFS.sizeComposer);
        expect(emitted[0].sizeCode).toBe(DEFAULT_TYPOGRAPHY_PREFS.sizeCode);
        expect(emitted[0].lineHeightBody).toBe(DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody);
        expect(emitted[0].measure).toBe(DEFAULT_TYPOGRAPHY_PREFS.measure);
        expect(emitted[0].smoothing).toBe(DEFAULT_TYPOGRAPHY_PREFS.smoothing);
      }
    });

    it("resets all preferences and applies specific overrides when reset is true with fields", async () => {
      const emitted: RuntimeEvent[] = [];
      const registry = createRegistry(typographyTools({ emit: (e) => emitted.push(e) }));

      const res = await registry.call(makeCtx(), "app_set_typography", {
        reset: true,
        mono: "JetBrains Mono",
        sizeCode: 14,
      });
      expect(res.isError).toBeUndefined();

      expect(emitted.length).toBe(1);
      if (emitted[0]?.type === "app.typography_mutation") {
        expect(emitted[0].sans).toBe(DEFAULT_TYPOGRAPHY_PREFS.sans);
        expect(emitted[0].mono).toBe("JetBrains Mono");
        expect(emitted[0].sizeCode).toBe(14);
        expect(emitted[0].sizeInterface).toBe(DEFAULT_TYPOGRAPHY_PREFS.sizeInterface);
      }
    });
  });
});

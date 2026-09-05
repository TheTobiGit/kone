import { describe, expect, it } from "bun:test";
import {
  curatedOptions,
  fontLabel,
  isFontFamilyAvailable,
  isMonospaceFamily,
  queryInstalledFontFamilies,
  stackFor,
} from "./fonts";

describe("font picker", () => {
  it("always offers default and system first", () => {
    for (const kind of ["sans", "serif", "mono", "composer"] as const) {
      const options = curatedOptions(kind);
      expect(options[0]?.id).toBe("");
      expect(options[0]?.label).toBe("Default");
      expect(options[1]?.label).toBe("System");
    }
  });

  it("labels empty as Default and names the rest", () => {
    expect(fontLabel("")).toBe("Default");
    expect(fontLabel("   ")).toBe("Default");
    expect(fontLabel("Inter")).toBe("Inter");
  });

  it("stacks each kind over its own shipped stack", () => {
    expect(stackFor("sans", "Inter")).toContain("Geist");
    expect(stackFor("serif", "Georgia")).toContain("Fraunces");
    expect(stackFor("serif", "Georgia")).toContain("Georgia");
    expect(stackFor("mono", "JetBrains Mono")).toContain("ui-monospace");
    expect(stackFor("composer", "Inter")).toContain("system-ui");
  });

  it("probes honestly without a DOM", () => {
    // No canvas outside the browser: availability answers false so nothing is
    // offered that can't be shown, monospace answers true so no face is blocked.
    expect(isFontFamilyAvailable("Inter")).toBe(false);
    expect(isMonospaceFamily("Inter")).toBe(true);
  });

  it("reports unsupported where there is no font API", async () => {
    const state = await queryInstalledFontFamilies();
    expect(state.status).toBe("unsupported");
    expect(state.families).toEqual([]);
  });
});

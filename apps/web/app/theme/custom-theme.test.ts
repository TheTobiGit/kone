import { beforeEach, describe, expect, it } from "bun:test";
import {
  buildScheme,
  buildTheme,
  createDefaultThemeSpec,
  extractThemeSpec,
  type ThemeSpec,
} from "./build";
import {
  exportThemeJson,
  findTheme,
  isCustom,
  removeCustomTheme,
  saveCustomTheme,
  themeGroups,
  themes,
  updateCustomTheme,
} from "./library";
import { colorsFor, THEME_ROLES } from "./roles";
import { KONE_THEME } from "./themes/kone";
import { GROVE_THEME } from "./themes/grove";

describe("Custom Theme Engine", () => {
  beforeEach(() => {
    // Clear localStorage and custom theme registry state
    for (const t of themes.value) {
      if (isCustom(t.id)) {
        removeCustomTheme(t.id);
      }
    }
  });

  describe("createDefaultThemeSpec", () => {
    it("creates a well-formed adaptive starter spec", () => {
      const spec = createDefaultThemeSpec("adaptive");
      expect(spec.kind).toBe("adaptive");
      if (spec.kind === "adaptive") {
        expect(spec.light.ground).toBeDefined();
        expect(spec.light.accent).toBeDefined();
        expect(spec.dark.ground).toBeDefined();
        expect(spec.dark.accent).toBeDefined();
      }
    });

    it("creates a well-formed fixed starter spec", () => {
      const spec = createDefaultThemeSpec("fixed", "dark");
      expect(spec.kind).toBe("fixed");
      if (spec.kind === "fixed") {
        expect(spec.appearance).toBe("dark");
        expect(spec.palette.ground).toBeDefined();
        expect(spec.palette.accent).toBeDefined();
      }
    });
  });

  describe("buildTheme with custom spec", () => {
    it("builds a full 47-role palette from only ground and accent", () => {
      const spec: ThemeSpec = {
        id: "custom-test",
        label: "Nordic Minimal",
        blurb: "Test blurb",
        kind: "adaptive",
        light: { ground: "#f5f5f5", accent: "#3b82f6" },
        dark: { ground: "#111111", accent: "#60a5fa" },
      };

      const theme = buildTheme(spec);
      expect(theme.id).toBe("custom-test");
      expect(theme.label).toBe("Nordic Minimal");
      expect(theme.kind).toBe("adaptive");

      const lightColors = colorsFor(theme, "light");
      const darkColors = colorsFor(theme, "dark");

      for (const role of THEME_ROLES) {
        expect(lightColors[role]).toBeDefined();
        expect(typeof lightColors[role]).toBe("string");
        expect(darkColors[role]).toBeDefined();
        expect(typeof darkColors[role]).toBe("string");
      }
    });

    it("respects explicit overrides over derived defaults", () => {
      const spec: ThemeSpec = {
        id: "custom-override",
        label: "Custom Overrides",
        blurb: "Test",
        kind: "fixed",
        appearance: "dark",
        palette: {
          ground: "#000000",
          accent: "#ff0055",
          strip: "#050505",
          folder: "#ffaa00",
          file: "#00aaff",
        },
      };

      const theme = buildTheme(spec);
      const colors = colorsFor(theme, "dark");
      expect(colors.ground).toBe("#000000");
      expect(colors.accent).toBe("#ff0055");
      expect(colors.strip).toBe("#050505");
      expect(colors.folder).toBe("#ffaa00");
      expect(colors.file).toBe("#00aaff");
    });
  });

  describe("extractThemeSpec", () => {
    it("extracts editable spec from built-in kone theme", () => {
      const spec = extractThemeSpec(KONE_THEME, "kone-custom", "Custom kone");
      expect(spec.id).toBe("kone-custom");
      expect(spec.label).toBe("Custom kone");
      expect(spec.kind).toBe("adaptive");
      if (spec.kind === "adaptive") {
        expect(spec.light.ground).toBe(KONE_THEME.colors.light!.ground);
        expect(spec.light.accent).toBe(KONE_THEME.colors.light!.accent);
        expect(spec.dark.ground).toBe(KONE_THEME.colors.dark!.ground);
        expect(spec.dark.accent).toBe(KONE_THEME.colors.dark!.accent);
      }
    });

    it("extracts editable spec from Grove theme", () => {
      const spec = extractThemeSpec(GROVE_THEME);
      expect(spec.id).toBe(GROVE_THEME.id);
      expect(spec.label).toBe(GROVE_THEME.label);
      expect(spec.kind).toBe("adaptive");
      if (spec.kind === "adaptive") {
        expect(spec.light.accent).toBe(GROVE_THEME.colors.light!.accent);
        expect(spec.dark.accent).toBe(GROVE_THEME.colors.dark!.accent);
      }
    });
  });

  describe("Custom theme lifecycle in Library", () => {
    it("saves, updates, and deletes custom themes", () => {
      const spec: ThemeSpec = {
        id: "custom-my-palette",
        label: "My Palette",
        blurb: "Crafted by me",
        kind: "adaptive",
        light: { ground: "#f8f9fa", accent: "#2563eb" },
        dark: { ground: "#0f172a", accent: "#38bdf8" },
      };

      // 1. Save
      const saved = saveCustomTheme(spec);
      expect(saved.id).toBe("custom-my-palette");
      expect(saved.custom).toBe(true);
      expect(isCustom("custom-my-palette")).toBe(true);
      expect(findTheme("custom-my-palette")).toBeDefined();

      // 2. Custom group in themeGroups
      let groups = themeGroups();
      const customGroup = groups.find((g) => g.key === "custom");
      expect(customGroup).toBeDefined();
      expect(customGroup!.themes.some((t) => t.id === "custom-my-palette")).toBe(true);

      // 3. Update
      const updatedSpec: ThemeSpec = {
        ...spec,
        label: "My Updated Palette",
      };
      const updated = updateCustomTheme("custom-my-palette", updatedSpec);
      expect(updated.label).toBe("My Updated Palette");
      expect(findTheme("custom-my-palette")?.label).toBe("My Updated Palette");

      // 4. Export JSON
      const json = exportThemeJson(updated);
      const parsed = JSON.parse(json);
      expect(parsed.koneTheme).toBe(true);
      expect(parsed.id).toBe("custom-my-palette");
      expect(parsed.spec).toBeDefined();

      // 5. Remove
      removeCustomTheme("custom-my-palette");
      expect(isCustom("custom-my-palette")).toBe(false);
      expect(findTheme("custom-my-palette")).toBeNull();

      // Custom group is removed when empty
      groups = themeGroups();
      expect(groups.find((g) => g.key === "custom")).toBeUndefined();
    });
  });
});

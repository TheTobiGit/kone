import { describe, expect, test } from "bun:test";
import { contrast, mixHex, toHex } from "./color";
import {
  buildImportedThemes,
  humanizeThemeName,
  isVsCodeThemeFile,
  parseVsCodeColor,
  parseVsCodeThemeEntry,
  type VsCodeImportEntry,
} from "./import-vscode";
import type { ThemeScheme } from "./roles";

// Minimal VS Code colour-theme fixtures. Real themes carry hundreds of keys;
// the importer is judged on the handful it reads, so the fixtures name those
// and nothing else.

const DARK_THEME = {
  name: "pierre-dark-soft",
  type: "dark",
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#d4d4d4",
    "focusBorder": "#69b1ff",
    "sideBar.background": "#101010",
    "terminal.background": "#101010",
    "terminal.foreground": "#d4d4d4",
    "terminalCursor.foreground": "#69b1ff",
    "editorError.foreground": "#ff6b6b",
    "editorWarning.foreground": "#ffcc66",
    "terminal.ansiGreen": "#00ff00",
  },
};

function entryOf(theme: unknown, stem = "theme"): VsCodeImportEntry {
  return parseVsCodeThemeEntry(theme, stem);
}

function buildOne(theme: unknown, stem = "theme", taken: ReadonlySet<string> = new Set()) {
  return buildImportedThemes([entryOf(theme, stem)], taken)[0]!;
}

function asHex(color: string): string {
  // Roles the file named are literals; this normalises the ones that aren't.
  if (color.startsWith("#")) return color;
  const parsed = parseVsCodeColor(color);
  if (parsed) return toHex([parsed.r / 255, parsed.g / 255, parsed.b / 255] as const);
  return color;
}

describe("VS Code theme import", () => {
  test("recognises workbench themes and rejects plain objects", () => {
    expect(isVsCodeThemeFile(DARK_THEME)).toBe(true);
    expect(isVsCodeThemeFile({ type: "dark", tokenColors: [] })).toBe(true);
    expect(isVsCodeThemeFile({ name: "x", colors: { ground: "#000" } })).toBe(false);
    expect(isVsCodeThemeFile("nope")).toBe(false);
    expect(isVsCodeThemeFile(null)).toBe(false);
  });

  test("carries the editor surfaces and accent across", () => {
    const theme = buildOne(DARK_THEME);
    expect(theme.label).toBe("Pierre Dark Soft");
    expect(theme.kind).toBe("fixed");
    expect(theme.appearance).toBe("dark");
    const c = theme.colors.dark!;
    expect(c.ground).toBe("#171717");
    expect(c.ink).toBe("#d4d4d4");
    expect(c.accent).toBe("#69b1ff");
    expect(c.strip).toBe("#101010");
    expect(c.termBg).toBe("#101010");
    expect(c.termCursor).toBe("#69b1ff");
    expect(c.danger).toBe("#ff6b6b");
    expect(c.warn).toBe("#ffcc66");
  });

  test("takes the terminal's ANSI palette when the file named it", () => {
    const theme = buildOne(DARK_THEME);
    expect(theme.extras.dark!.ansi.green).toBe("#00ff00");
    // Unnamed slots keep kone's conventional values.
    expect(theme.extras.dark!.ansi.red).toBeDefined();
  });

  test("reads appearance from the type, and from the canvas when absent", () => {
    expect(entryOf(DARK_THEME).appearance).toBe("dark");
    expect(entryOf({ ...DARK_THEME, type: "hc-black" }).appearance).toBe("dark");
    expect(entryOf({ ...DARK_THEME, type: "light" }).appearance).toBe("light");
    expect(entryOf({ ...DARK_THEME, type: "hc-light" }).appearance).toBe("light");
    const untyped = entryOf({ ...DARK_THEME, type: undefined });
    expect(untyped.appearance).toBe("dark");
    const lightCanvas = entryOf({
      ...DARK_THEME,
      type: undefined,
      colors: { ...DARK_THEME.colors, "editor.background": "#fdfdfd" },
    });
    expect(lightCanvas.appearance).toBe("light");
  });

  test("keeps an unreadable foreground out of the palette", () => {
    const theme = buildOne({
      ...DARK_THEME,
      colors: { ...DARK_THEME.colors, "editor.foreground": "#111111" },
    });
    const c = theme.colors.dark!;
    expect(c.ink).not.toBe("#111111");
    expect(contrast(c.ink, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  test("fills every role the file omits with a derived value", () => {
    const theme = buildOne(DARK_THEME);
    const c = theme.colors.dark!;
    expect(c.sunken).toBeDefined();
    expect(c.raised).toBeDefined();
    expect(c.accentSecondary).toBeDefined();
    expect(contrast(c.ink, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  test("flattens alpha overlays onto the surface they sit on", () => {
    const overlay = "#1f3e5e59"; // sideBar.background with alpha 0x59/255
    const theme = buildOne({
      ...DARK_THEME,
      colors: { ...DARK_THEME.colors, "sideBar.background": overlay },
    });
    const c = theme.colors.dark!;
    expect(c.strip).not.toContain("#1f3e5e59");
    const expected = mixHex("#171717", "#1f3e5e", 0x59 / 255);
    expect(asHex(c.strip)).toBe(expected);
  });

  test("reads wide-gamut color() notation", () => {
    const parsed = parseVsCodeColor("color(display-p3 0.1 0.2 0.9)");
    expect(parsed).not.toBeNull();
    expect(parsed!.b).toBeGreaterThan(200);
    expect(parsed!.b).toBeGreaterThan(parsed!.r);
    expect(parsed!.g).toBeGreaterThan(parsed!.r);
    const theme = buildOne({
      ...DARK_THEME,
      colors: { ...DARK_THEME.colors, "editor.background": "color(display-p3 0.03 0.04 0.05)" },
    });
    expect(theme.colors.dark!.ground).toMatch(/^#0[0-9a-f]/);
  });

  test("rejects a file with no editor background", () => {
    expect(() => entryOf({ name: "x", type: "dark", colors: { "sideBar.background": "#000" } })).toThrow(
      /editor\.background/,
    );
    expect(() => entryOf("nope")).toThrow(/JSON object/);
  });

  test("falls back to the name when the displayName humanizes to nothing", () => {
    const entry = entryOf({ ...DARK_THEME, displayName: "---" });
    expect(entry.label).toBe("Pierre Dark Soft");
  });

  test("humanizes package slugs into words", () => {
    expect(humanizeThemeName("night-owl")).toBe("Night Owl");
    expect(humanizeThemeName("dracula")).toBe("dracula");
    expect(humanizeThemeName("One Dark Pro")).toBe("One Dark Pro");
  });
});

describe("pairing and ids", () => {
  const light = (name: string, stem: string) =>
    parseVsCodeThemeEntry(
      { name, type: "light", colors: { "editor.background": "#fdfdfd", "editor.foreground": "#111111" } },
      stem,
    );
  const dark = (name: string, stem: string) =>
    parseVsCodeThemeEntry(
      { name, type: "dark", colors: { "editor.background": "#101014", "editor.foreground": "#d4d4d4" } },
      stem,
    );

  test("pairs light and dark files from one family into an adaptive theme", () => {
    const themes = buildImportedThemes(
      [
        dark("GitHub Dark", "github-dark"),
        light("GitHub Light", "github-light"),
        light("GitHub Light Colorblind", "github-light-colorblind"),
      ],
      new Set(),
    );
    expect(themes.map((t) => t.label)).toEqual(["GitHub", "GitHub Light Colorblind"]);
    const github = themes[0]!;
    expect(github.kind).toBe("adaptive");
    expect(github.colors.light!.ground).toBe("#fdfdfd");
    expect(github.colors.dark!.ground).toBe("#101014");
    expect(themes[1]!.kind).toBe("fixed");
  });

  test("does not guess when a family is ambiguous", () => {
    const themes = buildImportedThemes(
      [dark("Nord Dark", "nord-dark"), dark("Nord Dark", "nord-dark-2"), light("Nord Light", "nord-light")],
      new Set(),
    );
    // Two darks for one light: nobody pairs.
    expect(themes.map((t) => t.label).sort()).toEqual(["Nord Dark", "Nord Dark 2", "Nord Light"]);
  });

  test("keeps a pair whose name is taken as two single themes", () => {
    const themes = buildImportedThemes(
      [light("Grove Light", "grove-light"), dark("Grove Dark", "grove-dark")],
      new Set(["grove"]),
    );
    expect(themes.map((t) => t.label).sort()).toEqual(["Grove Dark", "Grove Light"]);
  });

  test("tells same-named variants apart by their file names", () => {
    const themes = buildImportedThemes(
      [dark("Dracula", "dracula"), dark("Dracula", "dracula-soft")],
      new Set(),
    );
    expect(themes.map((t) => t.label)).toEqual(["Dracula", "Dracula Soft"]);
    expect(themes.map((t) => t.id)).toEqual(["dracula", "dracula-soft"]);
  });

  test("numbers variants when even the file names collide", () => {
    const themes = buildImportedThemes([dark("Dracula", "dracula"), dark("Dracula", "dracula")], new Set());
    expect(themes.map((t) => t.label)).toEqual(["Dracula", "Dracula 2"]);
  });

  test("re-imports get fresh ids instead of merging into built-ins", () => {
    const themes = buildImportedThemes(
      [dark("Dracula", "dracula")],
      new Set(["dracula"]),
    );
    expect(themes[0]!.id).toBe("dracula-2");
  });

  test("every built theme stays a complete definition", () => {
    const themes = buildImportedThemes(
      [dark("Any Dark", "any-dark"), light("Any Light", "any-light")],
      new Set(),
    );
    for (const theme of themes) {
      expect(theme.blurb).toBe("Imported from a VS Code theme.");
      expect(theme.hues).toBeDefined();
      const schemes: ThemeScheme[] = theme.kind === "adaptive" ? ["light", "dark"] : [theme.appearance];
      for (const s of schemes) {
        const c = theme.colors[s]!;
        expect(contrast(c.ink, c.ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("parseVsCodeColor", () => {
  test("parses every hex form VS Code accepts", () => {
    expect(parseVsCodeColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseVsCodeColor("#abcd")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0xdd / 255 });
    expect(parseVsCodeColor("#aabbcc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseVsCodeColor("#aabbccdd")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0xdd / 255 });
    expect(parseVsCodeColor("aabbcc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  test("rejects junk", () => {
    expect(parseVsCodeColor("red")).toBeNull();
    expect(parseVsCodeColor("#12345")).toBeNull();
    expect(parseVsCodeColor(42)).toBeNull();
    expect(parseVsCodeColor(undefined)).toBeNull();
  });

  test("handles srgb color() with percentages", () => {
    expect(parseVsCodeColor("color(srgb 100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseVsCodeColor("color(srgb 1 0 0 / 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });
});

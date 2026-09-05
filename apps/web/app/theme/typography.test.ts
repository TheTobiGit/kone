import { describe, expect, it } from "bun:test";
import {
  applyTypographyVariables,
  clampCodeFontSize,
  clampComposerFontSize,
  clampInterfaceFontSize,
  clampLineHeightBody,
  clampMeasure,
  cssFontFamilies,
  DEFAULT_TYPOGRAPHY_PREFS,
  resolveTypographyPrefs,
  type TypographyRoot,
} from "./typography";

function stubRoot(): TypographyRoot & { props: Map<string, string> } {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      fontSize: "",
      setProperty: (name: string, value: string) => {
        props.set(name, value);
      },
      removeProperty: (name: string) => {
        props.delete(name);
      },
    },
  };
}

describe("typography foundation", () => {
  it("clamps sizes to their ladders", () => {
    expect(clampInterfaceFontSize(99)).toBe(20);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampComposerFontSize(Number.NaN)).toBe(DEFAULT_TYPOGRAPHY_PREFS.sizeComposer);
    expect(clampCodeFontSize(11.6)).toBe(12);
    expect(clampLineHeightBody(3)).toBe(1.8);
    expect(clampLineHeightBody(1.5678)).toBe(1.57);
    expect(clampMeasure(200)).toBe(80);
  });

  it("normalizes families safely", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies("Inter")).toBe("Inter");
    expect(cssFontFamilies("My Font, serif")).toBe('"My Font", serif');
    expect(cssFontFamilies('"Already Quoted"')).toBe('"Already Quoted"');
  });

  it("resolves partial input with defaults", () => {
    const resolved = resolveTypographyPrefs({ sizeCode: 99 });
    expect(resolved.sizeCode).toBe(18);
    expect(resolved.sans).toBe("");
    expect(resolved.smoothing).toBe(true);
    expect(resolveTypographyPrefs(undefined)).toEqual(DEFAULT_TYPOGRAPHY_PREFS);
    expect(resolveTypographyPrefs({ smoothing: false }).smoothing).toBe(false);
    expect(resolveTypographyPrefs({ serif: "Georgia" }).serif).toBe("Georgia");
  });

  it("paints families over the shipped stacks and sizes absolutely", () => {
    const root = stubRoot();
    applyTypographyVariables(root, {
      ...DEFAULT_TYPOGRAPHY_PREFS,
      sans: "Inter",
      mono: "",
      sizeInterface: 15,
      sizeCode: 13,
    });
    expect(root.style.fontSize).toBe("15px");
    expect(root.props.get("--font-sans")).toContain("Inter");
    expect(root.props.has("--font-mono")).toBe(false);
    expect(root.props.get("--font-size-code")).toBe("13px");
    expect(root.props.get("--diffs-font-size")).toBe("13px");
    expect(root.props.get("--line-height-body")).toBe("1.55");
    expect(root.props.get("--measure")).toBe("68ch");
  });

  it("paints the wordmark serif over its own stack, unset faces to the stylesheet", () => {
    const root = stubRoot();
    applyTypographyVariables(root, { ...DEFAULT_TYPOGRAPHY_PREFS, serif: "Georgia" });
    expect(root.props.get("--font-serif")).toContain("Georgia");
    expect(root.props.get("--font-serif")).toContain("Fraunces");

    const bare = stubRoot();
    applyTypographyVariables(bare, { ...DEFAULT_TYPOGRAPHY_PREFS });
    expect(bare.props.has("--font-serif")).toBe(false);
    expect(bare.props.has("--font-mono")).toBe(false);
  });
});

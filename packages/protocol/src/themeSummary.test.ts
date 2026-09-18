import { describe, expect, it } from "bun:test";
import {
  formatCustomThemeCreated,
  formatModeApplied,
  formatThemeApplied,
  formatThemeChange,
  parseThemeChange,
} from "./themeSummary";

describe("theme change records", () => {
  it("round-trips both ends of a change it wrote", () => {
    const summary = formatThemeApplied({
      applied: { id: "nocturne", label: "Nocturne" },
      mode: "dark",
      scheme: "dark",
      replaced: { id: "moss", label: "Moss" },
    });
    const text = formatThemeChange({ to: "nocturne", from: "moss", summary });

    expect(parseThemeChange(text)).toEqual({ to: "nocturne", from: "moss", summary });
  });

  it("round-trips a change that displaced nothing", () => {
    const summary = formatThemeApplied({ applied: { id: "midnight", label: "Midnight" } });
    const text = formatThemeChange({ to: "midnight", from: null, summary });

    expect(parseThemeChange(text)).toEqual({ to: "midnight", from: null, summary });
  });

  it("round-trips a created theme", () => {
    const summary = formatCustomThemeCreated({ id: "brand-01", label: "Brand" }, "#f97316", {
      id: "kone",
      label: "Kone",
    });
    const text = formatThemeChange({ to: "brand-01", from: "kone", summary });

    expect(parseThemeChange(text)).toEqual({ to: "brand-01", from: "kone", summary });
  });

  it("round-trips a preview with custom colours", () => {
    const text = formatThemeChange({
      to: "grove",
      from: "moss",
      summary: "Live preview applied.",
      preview: true,
      colors: { accent: "#38bdf8" },
    });

    expect(parseThemeChange(text)).toEqual({
      to: "grove",
      from: "moss",
      summary: "Live preview applied.",
      preview: true,
      colors: { accent: "#38bdf8" },
    });
  });

  it("reads nothing out of malformed records", () => {
    expect(parseThemeChange(undefined)).toBeNull();
    expect(parseThemeChange("")).toBeNull();
    expect(parseThemeChange("[1,2]")).toBeNull();
    expect(parseThemeChange(`"nocturne"`)).toBeNull();
    expect(parseThemeChange(`{"to":"","from":null,"summary":"s"}`)).toBeNull();
    expect(parseThemeChange(`{"to":"nocturne","from":null}`)).toBeNull();
    expect(parseThemeChange(`{"to":"nocturne","from":null,"summary":"s","preview":"yes"}`)).toBeNull();
    expect(parseThemeChange(`{"to":"nocturne","from":null,"summary":"s","colors":null}`)).toBeNull();
  });
});

describe("texts that record no change", () => {
  it("reads nothing out of a bare mode change", () => {
    expect(parseThemeChange(formatModeApplied("dark", "dark"))).toBeNull();
  });

  it("reads nothing out of a legacy sentence", () => {
    expect(
      parseThemeChange('Applied theme "Nocturne" (nocturne), replacing "Moss" (moss).'),
    ).toBeNull();
    expect(parseThemeChange("Cancelled live theme preview; restored saved theme.")).toBeNull();
  });

  it("reads nothing out of an in-progress input dump", () => {
    expect(parseThemeChange(`{"themeId":"nocturne","mode":"dark"}`)).toBeNull();
  });

  it("reads nothing out of malformed records", () => {
    expect(parseThemeChange(undefined)).toBeNull();
    expect(parseThemeChange("")).toBeNull();
    expect(parseThemeChange("[1,2]")).toBeNull();
    expect(parseThemeChange(`"nocturne"`)).toBeNull();
    expect(parseThemeChange(`{"to":"","from":null,"summary":"s"}`)).toBeNull();
    expect(parseThemeChange(`{"to":"nocturne","from":null}`)).toBeNull();
    expect(parseThemeChange(`{"to":"nocturne","from":null,"summary":"s","preview":"yes"}`)).toBeNull();
  });
});

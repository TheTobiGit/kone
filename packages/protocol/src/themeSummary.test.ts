import { describe, expect, it } from "bun:test";
import {
  formatCustomThemeCreated,
  formatModeApplied,
  formatThemeApplied,
  parseThemeSummary,
} from "./themeSummary";

describe("theme summaries round-trip", () => {
  it("reads back both ends of a change it wrote", () => {
    const text = formatThemeApplied({
      applied: { id: "nocturne", label: "Nocturne" },
      mode: "dark",
      scheme: "dark",
      replaced: { id: "moss", label: "Moss" },
    });

    expect(text).toBe(
      'Applied theme "Nocturne" (nocturne) in dark mode (dark scheme), replacing "Moss" (moss).',
    );
    expect(parseThemeSummary(text)).toEqual({ to: "nocturne", from: "moss" });
  });

  it("reads back a change that displaced nothing", () => {
    const text = formatThemeApplied({ applied: { id: "midnight", label: "Midnight" } });
    expect(parseThemeSummary(text)).toEqual({ to: "midnight", from: null });
  });

  it("reads back a created theme", () => {
    const text = formatCustomThemeCreated({ id: "brand-01", label: "Brand" }, "#f97316", {
      id: "kone",
      label: "Kone",
    });
    expect(parseThemeSummary(text)).toEqual({ to: "brand-01", from: "kone" });
  });
});

// Labels are free text — up to 100 characters of whatever the user or the agent
// called the theme. Every one of these corrupted an earlier reading that
// anchored on the first quote it found.
describe("adversarial labels", () => {
  it("survives quotes inside a label", () => {
    const text = formatThemeApplied({
      applied: { id: "cool", label: 'My "Cool" Theme' },
      replaced: { id: "kone", label: 'The "Old" One' },
    });
    expect(parseThemeSummary(text)).toEqual({ to: "cool", from: "kone" });
  });

  it("survives parentheses inside a label", () => {
    const text = formatThemeApplied({
      applied: { id: "dusk", label: "Dusk (v2)" },
      replaced: { id: "dawn", label: "Dawn (original)" },
    });
    expect(parseThemeSummary(text)).toEqual({ to: "dusk", from: "dawn" });
  });

  it("survives a label that impersonates the replaced clause", () => {
    const text = formatThemeApplied({
      applied: { id: "trick", label: 'x", replacing "Fake" (fake)' },
      replaced: { id: "real", label: "Real" },
    });
    expect(parseThemeSummary(text)).toEqual({ to: "trick", from: "real" });
  });

  it("survives backticks and slug-shaped words in a label", () => {
    const text = formatCustomThemeCreated(
      { id: "brand-02", label: "`kone` but warmer" },
      "#f97316",
    );
    expect(parseThemeSummary(text)).toEqual({ to: "brand-02", from: null });
  });
});

describe("lines that name no theme", () => {
  it("reads nothing out of a bare mode change", () => {
    expect(parseThemeSummary(formatModeApplied("dark", "dark"))).toBeNull();
  });

  it("reads nothing out of an unrelated sentence", () => {
    expect(parseThemeSummary("Cancelled live theme preview; restored saved theme.")).toBeNull();
    expect(parseThemeSummary(undefined)).toBeNull();
    expect(parseThemeSummary("")).toBeNull();
  });
});

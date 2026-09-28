import { describe, expect, test } from "bun:test";
import {
  PROVIDER_COLORS,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  asProviderKind,
  knownProviderRows,
  providerIdentity,
} from "./usageProviders";

describe("PROVIDER_COLORS", () => {
  test("covers every provider in both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const provider of PROVIDER_ORDER) {
        expect(PROVIDER_COLORS[scheme][provider]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("scheme-stable brands hold still, monochromes adapt", () => {
    // Chromatic brand tokens are identical in both appearances.
    expect(PROVIDER_COLORS.light.claudeAgent).toBe(PROVIDER_COLORS.dark.claudeAgent);
    expect(PROVIDER_COLORS.light.cursor).toBe(PROVIDER_COLORS.dark.cursor);
    expect(PROVIDER_COLORS.light.antigravity).toBe(PROVIDER_COLORS.dark.antigravity);
    // Monochrome brands need different values per appearance to stay legible.
    expect(PROVIDER_COLORS.light.codex).not.toBe(PROVIDER_COLORS.dark.codex);
    expect(PROVIDER_COLORS.light.opencode).not.toBe(PROVIDER_COLORS.dark.opencode);
    expect(PROVIDER_COLORS.light.droid).not.toBe(PROVIDER_COLORS.dark.droid);
  });
});

describe("asProviderKind", () => {
  test("narrows every known provider to itself", () => {
    for (const provider of PROVIDER_ORDER) expect(asProviderKind(provider)).toBe(provider);
  });

  test("turns an unknown or missing key into null", () => {
    expect(asProviderKind("gemini")).toBeNull();
    expect(asProviderKind("")).toBeNull();
    expect(asProviderKind(undefined)).toBeNull();
  });
});

describe("providerIdentity", () => {
  test("takes its colour from the row it is handed", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = PROVIDER_COLORS[scheme];
      for (const provider of PROVIDER_ORDER) {
        const identity = providerIdentity(provider, colors);
        expect(identity.provider).toBe(provider);
        expect(identity.label).toBe(PROVIDER_LABEL[provider]);
        expect(identity.color).toBe(colors[provider]);
      }
    }
  });
});

describe("knownProviderRows", () => {
  const colors = PROVIDER_COLORS.dark;

  test("pairs each owned row with its provider's identity, in row order", () => {
    const rows = [
      { provider: "cursor", n: 1 },
      { provider: "codex", n: 2 },
    ];
    const known = knownProviderRows(rows, colors);
    expect(known.map(({ row }) => row.n)).toEqual([1, 2]);
    expect(known.map(({ identity }) => identity)).toEqual([
      providerIdentity("cursor", colors),
      providerIdentity("codex", colors),
    ]);
  });

  test("leaves out a row no kone provider owns, or one with no provider", () => {
    const rows = [{ provider: "gemini" }, { provider: undefined }, {}, { provider: "droid" }];
    expect(knownProviderRows(rows, colors).map(({ identity }) => identity.provider)).toEqual(["droid"]);
  });

  test("keeps the row's own label apart from the provider's", () => {
    // A model row's label is its model id; merging the identity into it would
    // have replaced that with "Claude".
    const [only] = knownProviderRows([{ provider: "claudeAgent", label: "claude-sonnet-4" }], colors);
    expect(only?.row.label).toBe("claude-sonnet-4");
    expect(only?.identity.label).toBe("Claude");
  });
});

import { describe, expect, it } from "bun:test";

import {
  handoffTokenCapFor,
  isProviderEnabled,
  readProviderSettings,
  setProviderEnabled,
  setProviderHandoffTokenCap,
  writeProviderSettings,
} from "./providerSettings.js";
import { DEFAULT_HANDOFF_TOKEN_CAP, MAX_HANDOFF_TOKEN_CAP, MIN_HANDOFF_TOKEN_CAP } from "./contextBudget.js";

describe("providerSettings", () => {
  it("defaults to enabled when provider has no entry or enabled is unset", () => {
    expect(isProviderEnabled("codex", {})).toBe(true);
    expect(isProviderEnabled("claudeAgent", { claudeAgent: { binaryPath: "/bin/claude" } })).toBe(true);
    expect(isProviderEnabled("opencode", { opencode: { enabled: true } })).toBe(true);
  });

  it("reports false when enabled is set to false", () => {
    expect(isProviderEnabled("codex", { codex: { enabled: false } })).toBe(false);
  });

  it("persists enabled toggle via writeProviderSettings", () => {
    const original = readProviderSettings();
    try {
      const updated = writeProviderSettings("cursor", { enabled: false });
      expect(updated.cursor?.enabled).toBe(false);
      expect(isProviderEnabled("cursor", updated)).toBe(false);

      const restored = setProviderEnabled("cursor", true);
      expect(restored.cursor?.enabled).toBe(true);
      expect(isProviderEnabled("cursor", restored)).toBe(true);
    } finally {
      if (original.cursor) {
        writeProviderSettings("cursor", original.cursor);
      } else {
        writeProviderSettings("cursor", {});
      }
    }
  });

  it("reads the default handoff cap when unset, and clamps a stored one", () => {
    expect(handoffTokenCapFor("codex", {})).toBe(DEFAULT_HANDOFF_TOKEN_CAP);
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 20_000 } })).toBe(20_000);
    // A hand-edited out-of-range value is clamped on read.
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 1 } })).toBe(MIN_HANDOFF_TOKEN_CAP);
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 10_000_000 } })).toBe(MAX_HANDOFF_TOKEN_CAP);
  });

  it("persists the cap and preserves a provider's other settings", () => {
    const original = readProviderSettings();
    try {
      writeProviderSettings("droid", { binaryPath: "/bin/droid", enabled: true });
      const updated = setProviderHandoffTokenCap("droid", 32_000);
      expect(updated.droid?.handoffTokenCap).toBe(32_000);
      // The merge kept the binary path and enabled flag.
      expect(updated.droid?.binaryPath).toBe("/bin/droid");
      expect(updated.droid?.enabled).toBe(true);
      // Clamped on write too.
      expect(setProviderHandoffTokenCap("droid", 1).droid?.handoffTokenCap).toBe(MIN_HANDOFF_TOKEN_CAP);
    } finally {
      if (original.droid) writeProviderSettings("droid", original.droid);
      else writeProviderSettings("droid", {});
    }
  });
});

import { describe, expect, it } from "bun:test";

import {
  isProviderEnabled,
  readProviderSettings,
  setProviderEnabled,
  writeProviderSettings,
} from "./providerSettings.js";

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
});

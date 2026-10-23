import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as atomicWrite from "@kone/agent-core/lib-atomicWrite.js";

import { DEFAULT_HANDOFF_TOKEN_CAP, MAX_HANDOFF_TOKEN_CAP, MIN_HANDOFF_TOKEN_CAP } from "./contextBudget.js";
import type { JsonValue } from "./lib-jsonValue.js";
import {
  PROVIDER_SETTINGS_MIGRATIONS,
  importLegacyRendererSettings,
  isProviderEnabled,
  onProviderSettingsChanged,
  readProviderSettings,
  readProviderSettingsSnapshot,
  resetProviderSettingsForTests,
  setProviderEnabled,
  setProviderHandoffTokenCap,
  writeProviderSettings,
  handoffTokenCapFor,
  patchProviderSettings,
  resumeAtResetFor,
  snoozeWhenLimitedFor,
} from "./providerSettings.js";
import { setUserDataDir } from "./userDataDir.js";
import type { LegacyRendererProviderSettings, ProviderSettingsSnapshot } from "./types.js";

// Every test gets its own user-data dir, so a test never reads a settings file
// another one left behind (the module caches the path once, hence the reset).
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kone-provider-settings-"));
  setUserDataDir(dir);
  resetProviderSettingsForTests();
});

afterEach(() => {
  resetProviderSettingsForTests();
  rmSync(dir, { recursive: true, force: true });
});

const settingsFile = (): string => path.join(dir, "provider-settings.json");

/** What the file holds, as far as a test reads it — the values are JSON, so the
 *  assertion is on the decoded shape rather than on a typed envelope. */
type EnvelopeOnDisk = {
  version?: JsonValue;
  revision?: JsonValue;
  settings?: JsonValue;
  legacyRendererImported?: JsonValue;
};

function onDisk(): EnvelopeOnDisk {
  const parsed: EnvelopeOnDisk = JSON.parse(readFileSync(settingsFile(), "utf8"));
  return parsed;
}

function quarantineFiles(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("provider-settings.json.invalid-"));
}

describe("providerSettings", () => {
  it("defaults to enabled when provider has no entry or enabled is unset", () => {
    expect(isProviderEnabled("codex", {})).toBe(true);
    expect(isProviderEnabled("claudeAgent", { claudeAgent: { binaryPath: "/bin/claude" } })).toBe(true);
    expect(isProviderEnabled("opencode", { opencode: { enabled: true } })).toBe(true);
  });

  it("reports false when enabled is set to false", () => {
    expect(isProviderEnabled("codex", { codex: { enabled: false } })).toBe(false);
  });

  it("persists the enabled toggle via writeProviderSettings", () => {
    const updated = writeProviderSettings("cursor", { enabled: false });
    expect(updated.cursor?.enabled).toBe(false);
    expect(isProviderEnabled("cursor", updated)).toBe(false);

    const restored = setProviderEnabled("cursor", true);
    expect(restored.cursor?.enabled).toBe(true);
    expect(isProviderEnabled("cursor", restored)).toBe(true);
  });

  it("reads the default handoff cap when unset, and clamps a stored one", () => {
    expect(handoffTokenCapFor("codex", {})).toBe(DEFAULT_HANDOFF_TOKEN_CAP);
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 20_000 } })).toBe(20_000);
    // A hand-edited out-of-range value is clamped on read.
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 1 } })).toBe(MIN_HANDOFF_TOKEN_CAP);
    expect(handoffTokenCapFor("codex", { codex: { handoffTokenCap: 10_000_000 } })).toBe(MAX_HANDOFF_TOKEN_CAP);
  });

  it("persists the cap and preserves a provider's other settings", () => {
    writeProviderSettings("droid", { binaryPath: "/bin/droid", enabled: true });
    const updated = setProviderHandoffTokenCap("droid", 32_000);
    expect(updated.droid?.handoffTokenCap).toBe(32_000);
    // The merge kept the binary path and enabled flag.
    expect(updated.droid?.binaryPath).toBe("/bin/droid");
    expect(updated.droid?.enabled).toBe(true);
    // Clamped on write too.
    expect(setProviderHandoffTokenCap("droid", 1).droid?.handoffTokenCap).toBe(MIN_HANDOFF_TOKEN_CAP);
  });
});

describe("providerSettings envelope", () => {
  it("migrates a legacy bare settings file to the envelope on read", () => {
    const bare = { codex: { binaryPath: "/opt/codex", enabled: false } };
    writeFileSync(settingsFile(), JSON.stringify(bare));

    const settings = readProviderSettings();
    expect(settings.codex?.binaryPath).toBe("/opt/codex");
    expect(settings.codex?.enabled).toBe(false);

    // The file was upgraded in place, preserving the settings.
    const written = onDisk();
    expect(written.version).toBe(1);
    expect(written.revision).toBe(0);
    expect(written.settings).toEqual({ codex: { enabled: false, binaryPath: "/opt/codex" } });
    expect(written.legacyRendererImported).toBe(false);
  });

  it("orders the named migrations by version and wraps a bare map", () => {
    expect(PROVIDER_SETTINGS_MIGRATIONS.length).toBeGreaterThan(0);
    const names = PROVIDER_SETTINGS_MIGRATIONS.map((migration) => migration.name);
    expect(names[0]).toBe("wrap-bare-settings");
    expect(new Set(names).size).toBe(names.length);
    for (let i = 1; i < PROVIDER_SETTINGS_MIGRATIONS.length; i++) {
      expect(PROVIDER_SETTINGS_MIGRATIONS[i]!.version).toBeGreaterThan(
        PROVIDER_SETTINGS_MIGRATIONS[i - 1]!.version,
      );
    }
    expect(PROVIDER_SETTINGS_MIGRATIONS[0]!.version).toBe(1);
    expect(PROVIDER_SETTINGS_MIGRATIONS[0]!.migrate({ codex: { enabled: false } })).toEqual({
      version: 1,
      revision: 0,
      settings: { codex: { enabled: false } },
      legacyRendererImported: false,
    });
  });

  it("quarantines a file that is not JSON, naming both paths in one warning", () => {
    const original = "{ not json";
    writeFileSync(settingsFile(), original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readProviderSettings()).toEqual({});
      const quarantined = quarantineFiles();
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(path.join(dir, quarantined[0]!), "utf8")).toBe(original);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain(settingsFile());
      expect(message).toContain(quarantined[0]!);
      expect(message.includes("\n")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("quarantines a file that fails the top-level schema", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const invalid of ['[1,2]', '{"version":1,"revision":-3,"settings":5}', '{"codex":5}']) {
        resetProviderSettingsForTests();
        for (const name of quarantineFiles()) rmSync(path.join(dir, name));
        writeFileSync(settingsFile(), invalid);
        expect(readProviderSettings()).toEqual({});
        expect(quarantineFiles()).toHaveLength(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("starts from defaults for a missing file without quarantining or warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readProviderSettings()).toEqual({});
      expect(quarantineFiles()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a file from a newer version leniently", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 99,
        revision: 7,
        settings: { codex: { enabled: false } },
        legacyRendererImported: true,
      }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = readProviderSettingsSnapshot();
      expect(snapshot.revision).toBe(7);
      expect(snapshot.settings.codex?.enabled).toBe(false);
      expect(snapshot.legacyImportPending).toBe(false);
      expect(quarantineFiles()).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("advances the revision by exactly one per write, persisted across a reload", () => {
    expect(readProviderSettingsSnapshot().revision).toBe(0);
    writeProviderSettings("codex", { enabled: false });
    expect(readProviderSettingsSnapshot().revision).toBe(1);
    setProviderEnabled("opencode", false);
    expect(readProviderSettingsSnapshot().revision).toBe(2);
    setProviderHandoffTokenCap("droid", 20_000);
    expect(readProviderSettingsSnapshot().revision).toBe(3);
    expect(onDisk().revision).toBe(3);

    resetProviderSettingsForTests();
    const reloaded = readProviderSettingsSnapshot();
    expect(reloaded.revision).toBe(3);
    expect(reloaded.settings.droid?.handoffTokenCap).toBe(20_000);
  });

  it("notifies listeners with a fresh snapshot per write, and survives a throwing one", () => {
    const seen: ProviderSettingsSnapshot[] = [];
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const unsubscribe = onProviderSettingsChanged((snapshot) => {
        seen.push(snapshot);
      });
      const stopThrowing = onProviderSettingsChanged(() => {
        throw new Error("listener blew up");
      });

      writeProviderSettings("codex", { enabled: false });
      setProviderEnabled("cursor", false);

      expect(seen.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
      expect(seen[1]?.settings.cursor?.enabled).toBe(false);

      unsubscribe();
      stopThrowing();
      setProviderEnabled("cursor", true);
      expect(seen).toHaveLength(2);
    } finally {
      err.mockRestore();
    }
  });

  it("sanitizes hidden models by trimming, deduping and dropping an empty list", () => {
    const updated = writeProviderSettings("codex", {
      hiddenModels: [" gpt-5 ", "", "gpt-5", "   ", "o3"],
    });
    expect(updated.codex?.hiddenModels).toEqual(["gpt-5", "o3"]);
    expect(readProviderSettings().codex?.hiddenModels).toEqual(["gpt-5", "o3"]);

    const cleared = writeProviderSettings("codex", { hiddenModels: ["  "] });
    expect(cleared.codex?.hiddenModels).toBeUndefined();
    resetProviderSettingsForTests();
    expect(readProviderSettings().codex?.hiddenModels).toBeUndefined();
  });

  it("clears a field written as undefined and keeps the rest of the entry", () => {
    writeProviderSettings("codex", { enabled: false, binaryPath: "/bin/codex" });
    const next = writeProviderSettings("codex", { enabled: false, binaryPath: undefined });
    expect(next.codex).toEqual({ enabled: false });
  });

  it("drops one provider's malformed entry without losing the others", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 1,
        revision: 4,
        settings: { codex: { enabled: false, binaryPath: "/bin/codex" }, cursor: { enabled: "yes" } },
        legacyRendererImported: true,
      }),
    );
    const settings = readProviderSettings();
    expect(settings.codex).toEqual({ enabled: false, binaryPath: "/bin/codex" });
    expect(settings.cursor).toBeUndefined();
  });
});

describe("providerSettings write failures", () => {
  /** Make every settings write fail, the way an unwritable app-data directory
   *  does. chmod is the real thing; as root it is a no-op, so fall back to
   *  making the atomic writer throw the error chmod would have raised. Returns
   *  the undo. */
  function failWrites(): () => void {
    chmodSync(dir, 0o500);
    try {
      writeFileSync(path.join(dir, "probe"), "x");
    } catch {
      return () => chmodSync(dir, 0o700);
    }
    rmSync(path.join(dir, "probe"), { force: true });
    chmodSync(dir, 0o700);
    const spy = spyOn(atomicWrite, "writeFileAtomicSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    return () => spy.mockRestore();
  }

  it("throws, and leaves memory and disk on the last good write", () => {
    writeProviderSettings("codex", { enabled: false });
    const before = readProviderSettingsSnapshot();
    const seen: ProviderSettingsSnapshot[] = [];
    const unsubscribe = onProviderSettingsChanged((snapshot) => {
      seen.push(snapshot);
    });
    const restore = failWrites();
    try {
      expect(() => writeProviderSettings("codex", { enabled: true })).toThrow(
        /provider settings could not be saved: EACCES/i,
      );
    } finally {
      restore();
      unsubscribe();
    }
    // Nothing moved in memory, no listener heard about a write that never
    // reached the disk, and the file still holds the last good write.
    expect(readProviderSettingsSnapshot()).toEqual(before);
    expect(seen).toHaveLength(0);
    expect(onDisk().settings).toEqual({ codex: { enabled: false } });
  });

  it("keeps the legacy import pending when the write fails, and retries it later", () => {
    writeProviderSettings("codex", { enabled: false });
    const before = onDisk();
    const restore = failWrites();
    try {
      expect(() => importLegacyRendererSettings({ enabled: { opencode: false } })).toThrow(
        /provider settings could not be saved/i,
      );
    } finally {
      restore();
    }
    // Still owed, and the file still says so.
    expect(readProviderSettingsSnapshot().legacyImportPending).toBe(true);
    expect(onDisk()).toEqual(before);

    // The next call, once writes work again, imports for real.
    const retried = importLegacyRendererSettings({ enabled: { opencode: false } });
    expect(retried.legacyImportPending).toBe(false);
    resetProviderSettingsForTests();
    expect(readProviderSettings()).toMatchObject({
      codex: { enabled: false },
      opencode: { enabled: false },
    });
    expect(readProviderSettingsSnapshot().legacyImportPending).toBe(false);
  });
});

describe("providerSettings patch", () => {
  it("merges onto main's current entry, so two windows do not undo each other", () => {
    writeProviderSettings("codex", { enabled: true });
    // Window B's copy of the store, taken before window A writes anything.
    const stale = readProviderSettingsSnapshot();
    expect(stale.settings.codex?.enabled).toBe(true);

    // Window A flips the toggle; window B edits a different field, sending only
    // what it changed.
    patchProviderSettings("codex", { enabled: false });
    const merged = patchProviderSettings("codex", { hiddenModels: ["gpt-5"] });
    expect(merged.codex).toEqual({ enabled: false, hiddenModels: ["gpt-5"] });

    resetProviderSettingsForTests();
    expect(readProviderSettings().codex).toEqual({ enabled: false, hiddenModels: ["gpt-5"] });
  });

  it("clears a field patched as undefined and keeps the rest", () => {
    writeProviderSettings("codex", { enabled: false, binaryPath: "/bin/codex" });
    const next = patchProviderSettings("codex", { binaryPath: undefined });
    expect(next.codex).toEqual({ enabled: false });
  });

  it("creates an entry for a provider that has none, defaulting to enabled", () => {
    const next = patchProviderSettings("cursor", { hiddenModels: ["x"] });
    expect(next.cursor).toEqual({ enabled: true, hiddenModels: ["x"] });
  });
});

describe("providerSettings usage-limit toggles", () => {
  it("defaults to today's behaviour: resume at reset on, snooze off", () => {
    expect(resumeAtResetFor("claudeAgent", {})).toBe(true);
    expect(snoozeWhenLimitedFor("claudeAgent", {})).toBe(false);
    expect(resumeAtResetFor("codex", { codex: { enabled: true } })).toBe(true);
    expect(snoozeWhenLimitedFor("codex", { codex: { enabled: true } })).toBe(false);
  });

  it("round-trips both toggles through the file, next to the provider's other fields", () => {
    writeProviderSettings("codex", { binaryPath: "/bin/codex" });
    patchProviderSettings("codex", { resumeAtReset: false });
    patchProviderSettings("codex", { snoozeWhenLimited: true });

    resetProviderSettingsForTests();
    const settings = readProviderSettings();
    expect(settings.codex).toEqual({
      enabled: true,
      binaryPath: "/bin/codex",
      resumeAtReset: false,
      snoozeWhenLimited: true,
    });
    expect(resumeAtResetFor("codex")).toBe(false);
    expect(snoozeWhenLimitedFor("codex")).toBe(true);
  });

  it("reads a hand-edited non-boolean toggle as its default", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 1,
        revision: 3,
        settings: { codex: { resumeAtReset: "no", snoozeWhenLimited: 1 } },
      }),
    );
    expect(resumeAtResetFor("codex")).toBe(true);
    expect(snoozeWhenLimitedFor("codex")).toBe(false);
  });
});

describe("providerSettings legacy renderer import", () => {
  it("keeps the file's enabled state and fills only the gaps", () => {
    writeProviderSettings("codex", { enabled: false });
    const before = readProviderSettingsSnapshot().revision;

    const legacy: LegacyRendererProviderSettings = {
      enabled: { codex: true, opencode: false },
      hiddenModels: { codex: ["gpt-5", " gpt-5 "], opencode: ["x"], droid: [] },
    };
    // A hand-edited localStorage value: the type says boolean, the bytes are
    // whatever the user's storage actually held.
    Reflect.set(legacy.enabled ?? {}, "cursor", "yes");
    const snapshot = importLegacyRendererSettings(legacy);

    // The file already had a codex entry, so its `enabled: false` stands.
    expect(snapshot.settings.codex?.enabled).toBe(false);
    expect(snapshot.settings.codex?.hiddenModels).toEqual(["gpt-5"]);
    // No opencode entry on disk: the legacy toggle fills it.
    expect(snapshot.settings.opencode?.enabled).toBe(false);
    expect(snapshot.settings.opencode?.hiddenModels).toEqual(["x"]);
    // A malformed legacy toggle is ignored, so the provider stays default-enabled
    // without a fabricated entry.
    expect(snapshot.settings.cursor).toBeUndefined();
    expect(isProviderEnabled("cursor", snapshot.settings)).toBe(true);
    // An empty legacy hidden list says nothing.
    expect(snapshot.settings.droid?.hiddenModels).toBeUndefined();

    expect(snapshot.revision).toBe(before + 1);
    expect(snapshot.legacyImportPending).toBe(false);
    expect(onDisk().legacyRendererImported).toBe(true);
    expect(readProviderSettingsSnapshot().legacyImportPending).toBe(false);
  });

  it("keeps the usable half of a malformed legacy payload", () => {
    const legacy: LegacyRendererProviderSettings = { hiddenModels: { codex: ["gpt-5"] } };
    // The field itself is junk, not just one of its entries.
    Reflect.set(legacy, "enabled", "nope");
    const snapshot = importLegacyRendererSettings(legacy);
    expect(snapshot.settings.codex?.hiddenModels).toEqual(["gpt-5"]);
    expect(snapshot.settings.codex?.enabled).toBe(true);
  });

  it("runs exactly once, even across a reload from disk", () => {
    const seen: ProviderSettingsSnapshot[] = [];
    const unsubscribe = onProviderSettingsChanged((snapshot) => {
      seen.push(snapshot);
    });
    try {
      const first = importLegacyRendererSettings({ enabled: { codex: false } });
      const revision = first.revision;
      expect(seen).toHaveLength(1);

      const second = importLegacyRendererSettings({ enabled: { codex: true, opencode: false } });
      expect(second.revision).toBe(revision);
      expect(second.settings.codex?.enabled).toBe(false);
      expect(second.settings.opencode).toBeUndefined();
      expect(seen).toHaveLength(1);

      resetProviderSettingsForTests();
      const reloaded = importLegacyRendererSettings({ enabled: { opencode: false } });
      expect(reloaded.revision).toBe(revision);
      expect(reloaded.settings.opencode).toBeUndefined();
      expect(reloaded.legacyImportPending).toBe(false);
      expect(onDisk().revision).toBe(revision);
    } finally {
      unsubscribe();
    }
  });
});

describe("providerSettings file permissions", () => {
  it("persists provider-settings.json with owner-only 0600 permissions on POSIX, even when replacing a 0644 file", () => {
    if (process.platform === "win32") return;
    const file = path.join(dir, "provider-settings.json");
    writeFileSync(file, JSON.stringify({ version: 1, revision: 1, settings: {} }), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);

    patchProviderSettings("codex", {
      env: [{ name: "OPENAI_API_KEY", value: "sk-secret", secret: true }],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
